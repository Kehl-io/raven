import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { BarChart3, Bot, CalendarDays, Check, ChevronDown, Sparkles } from "lucide-react";
import { useAssistant, type AssistantActivity } from "../contexts/AssistantContext";
import { useUI } from "../contexts/UIContext";
import { useAppState } from "../contexts/AppStateContext";
import { useRunStream } from "../contexts/RunStreamContext";
import type { WorkflowDraft } from "../../domain/types";
import { formatSchedule } from "../../domain/format";
import { ApprovalCard } from "../components/ApprovalCard";
import { TraceTimeline } from "../components/TraceTimeline";
import { resolveApproval } from "../tauriBridge";
import { restoreFocusIfSafe, trapFocus } from "../lib/focusTrap";
import {
  AssistantChips,
  AssistantComposer,
  AssistantHeader,
  MessageBubble,
  MessageThread,
} from "../components/assistant";
import {
  buildAssistantSuggestions,
  isCommandCenterTarget,
  type AssistantSuggestion,
  type AssistantSuggestionSurface,
} from "../selectors/commandCenter";

/** Human-readable descriptions for permission strings. */
const permissionLabels: Record<string, string> = {
  "git:read": "Reads your git activity",
  "artifact:write": "Saves artifacts to your configured destination",
  "artifact:read": "Reads previously saved artifacts",
  "llm:generate": "Generates text with your AI provider",
  "network:read": "Accesses the internet for live data",
  "github:read": "Reads GitHub pull requests and issues",
  "nestweaver:read": "Queries NestWeaver code graph",
  "document:read": "Reads imported PDF documents",
  "chat:read": "Reads imported AI chat exports",
};

function readHiddenChipCategories(): string[] {
  try {
    const raw = localStorage.getItem("raven:hidden-assistant-chip-categories");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function describePermission(p: string): string {
  return permissionLabels[p] ?? p;
}

export function AssistantDrawer({
  closing = false,
  onClose,
  onAnimationEnd,
}: {
  closing?: boolean;
  onClose?: () => void;
  onAnimationEnd?: () => void;
} = {}) {
  const {
    messages,
    draft,
    chatInput,
    isGeneratingDraft,
    chatActivity,
    builderStreamPreview,
    approvalNotice,
    generateDraft,
    approveDraft,
    rejectDraft,
    setChatInput,
  } = useAssistant();
  const {
    view,
    selectedWorkflowId,
    selectedArtifactId,
    selectedRunId,
    activeSettingsTab,
    commandPaletteOpen,
    setAssistantOpen,
    openCreateWorkflowHub,
    openCommandCenterTarget,
    openWorkflow,
    openSettingsTarget,
    setWorkflowRosterCommand,
  } = useUI();
  const { state, actions } = useAppState();
  const { runStream, clearStream } = useRunStream();
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [hiddenChipCategories, setHiddenChipCategories] = useState<string[]>(readHiddenChipCategories);

  useLayoutEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    return () => {
      restoreFocusIfSafe(previousFocusRef.current, '[aria-label="Open Raven assistant"]');
    };
  }, []);

  // Derive context-aware subtitle and placeholder
  const assistantSurface = useMemo<AssistantSuggestionSurface>(() => (
    view === "home" ? "command-center" : view
  ), [view]);

  const suggestions = useMemo(
    () => buildAssistantSuggestions(state, assistantSurface, [], {
      selectedWorkflowId,
      selectedArtifactId,
      selectedRunId,
      activeSettingsTab,
    }).filter((suggestion) => !hiddenChipCategories.includes(suggestion.type)),
    [activeSettingsTab, assistantSurface, hiddenChipCategories, selectedArtifactId, selectedRunId, selectedWorkflowId, state],
  );

  const hideChipCategory = useCallback((category: AssistantSuggestion["type"]) => {
    setHiddenChipCategories((current) => {
      const next = current.includes(category) ? current : [...current, category];
      localStorage.setItem("raven:hidden-assistant-chip-categories", JSON.stringify(next));
      return next;
    });
  }, []);

  const { subtitle, placeholder } = useMemo(() => {
    switch (view) {
      case "workflow-detail": {
        const workflow = state.workflows.find((w) => w.workflowId === selectedWorkflowId);
        const workflowName = workflow?.definition.name ?? "Workflow";
        return {
          subtitle: `Viewing ${workflowName}`,
          placeholder: "Ask about this workflow...",
        };
      }
      case "artifacts":
        return {
          subtitle: "Viewing artifacts",
          placeholder: "Ask about this artifact...",
        };
      case "settings": {
        let settingsPlaceholder = "Need help with settings?";
        if (activeSettingsTab === "general") {
          settingsPlaceholder = "Need help connecting a provider?";
        } else if (activeSettingsTab === "context") {
          settingsPlaceholder = "Need help setting up a context source?";
        }
        return {
          subtitle: `Settings · ${activeSettingsTab}`,
          placeholder: settingsPlaceholder,
        };
      }
      case "workflows":
        return {
          subtitle: "Workflows",
          placeholder: "Want to create a new workflow?",
        };
      default:
        return {
          subtitle: "Your AI assistant",
          placeholder: "Ask me anything...",
        };
    }
  }, [view, selectedWorkflowId, activeSettingsTab, state.workflows]);

  // Close with Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (commandPaletteOpen) return;
      if (e.key === "Escape") {
        (onClose ?? (() => setAssistantOpen(false)))();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteOpen, setAssistantOpen, onClose]);

  const handleDialogKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    trapFocus(e, dialogRef.current);
  }, []);

  const handleApprove = useCallback(
    async (id: string, reason?: string) => {
      await resolveApproval(id, "approved", reason);
      await actions.refreshState();
      clearStream();
    },
    [actions, clearStream],
  );

  const handleReject = useCallback(
    async (id: string, reason?: string) => {
      await resolveApproval(id, "rejected", reason);
      await actions.refreshState();
      clearStream();
    },
    [actions, clearStream],
  );

  const handleSuggestion = useCallback((suggestion: AssistantSuggestion) => {
    const { kind, payload } = suggestion.action;

    if (kind === "open-create-workflow") {
      openCreateWorkflowHub({ selectedPath: "describe" });
      return;
    }

    if (kind === "open-command-center" && isCommandCenterTarget(payload.target)) {
      openCommandCenterTarget(payload.target);
      setAssistantOpen(false);
      return;
    }

    if (kind === "open-settings") {
      const tab = isSettingsTab(payload.tab) ? payload.tab : "general";
      openSettingsTarget(tab, parseSettingsTarget(payload.target));
      setAssistantOpen(false);
      return;
    }

    if (kind === "set-workflow-roster") {
      setWorkflowRosterCommand({
        statuses: arrayPayload(payload.statuses),
        schedules: arrayPayload(payload.schedules),
        sortKey: typeof payload.sortKey === "string" ? payload.sortKey : undefined,
      });
      setAssistantOpen(false);
      return;
    }

    if (kind === "run-due-schedules") {
      void actions.runDueSchedules();
      setAssistantOpen(false);
      return;
    }

    if (kind === "open-workflow" && typeof payload.workflowId === "string") {
      openWorkflow(payload.workflowId, view);
      setAssistantOpen(false);
      return;
    }

    if (kind === "ask-assistant" && typeof payload.prompt === "string") {
      setChatInput(payload.prompt);
    }
  }, [
    openCommandCenterTarget,
    openCreateWorkflowHub,
    openWorkflow,
    openSettingsTarget,
    setAssistantOpen,
    setChatInput,
    setWorkflowRosterCommand,
    actions,
    view,
  ]);

  const visibleMessages = messages.filter((m) => m.role !== "system");
  const showWelcomeSurface =
    visibleMessages.length === 0 &&
    !isGeneratingDraft &&
    !chatActivity &&
    runStream.activeRunId == null &&
    runStream.pendingApproval == null &&
    !draft &&
    !approvalNotice;

  return (
    <aside
      className={`assistant-drawer${closing ? " assistant-drawer-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-panel-title"
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      onAnimationEnd={onAnimationEnd}
    >
      <AssistantHeader subtitle={subtitle} onClose={() => (onClose ?? (() => setAssistantOpen(false)))()} />

      <MessageThread>
        {showWelcomeSurface && (
          <section className="assistant-empty-state" aria-label="Assistant start actions">
            <div>
              <span className="eyebrow">Ready</span>
              <h3>Start with the next useful move</h3>
              <p>Use a guided action or ask a question about the workflow surface you are viewing.</p>
            </div>
            <div className="assistant-empty-actions">
              <button type="button" className="primary-action" onClick={() => openCreateWorkflowHub({ selectedPath: "describe" })}>
                <Sparkles size={15} />
                Start a workflow
              </button>
              <button
                type="button"
                onClick={() => {
                  openCommandCenterTarget("usage");
                  setAssistantOpen(false);
                }}
              >
                <BarChart3 size={15} />
                Review usage
              </button>
              <button
                type="button"
                onClick={() => {
                  openCommandCenterTarget("schedule");
                  setAssistantOpen(false);
                }}
              >
                <CalendarDays size={15} />
                Review schedule
              </button>
            </div>
          </section>
        )}

        {visibleMessages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

        {isGeneratingDraft && !draft && (
          <article className="message assistant typing" aria-live="polite">
            <span>assistant</span>
            <p>
              <span className="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Thinking...
            </p>
          </article>
        )}

        {/* Inline activity indicator */}
        {chatActivity && (
          <ActivityIndicator activity={chatActivity} streamPreview={builderStreamPreview} />
        )}

        {/* Live run trace */}
        {runStream.activeRunId != null && (
          <TraceTimeline runStream={runStream} />
        )}

        {/* Pending approval card */}
        {runStream.pendingApproval != null && (
          <ApprovalCard
            approval={runStream.pendingApproval}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        )}

        {/* Draft approval card */}
        {draft && <DraftCard draft={draft} onApprove={approveDraft} onReject={rejectDraft} />}

        {approvalNotice && (
          <div className="assistant-drawer-notice">
            <Check size={14} />
            {approvalNotice}
          </div>
        )}
      </MessageThread>

      <AssistantComposer
        suggestions={
          <AssistantChips
            contextTitle={subtitle}
            suggestions={suggestions}
            onSelect={handleSuggestion}
            onHideCategory={hideChipCategory}
          />
        }
        value={chatInput}
        onChange={setChatInput}
        onSubmit={generateDraft}
        disabled={isGeneratingDraft}
        placeholder={placeholder}
      />
    </aside>
  );
}

function isSettingsTab(value: unknown): value is Parameters<ReturnType<typeof useUI>["setActiveSettingsTab"]>[0] {
  return (
    value === "general" ||
    value === "context" ||
    value === "tools" ||
    value === "advanced"
  );
}

function parseSettingsTarget(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.id !== "string") return null;
  if (
    record.type !== "provider" &&
    record.type !== "context-source" &&
    record.type !== "automation" &&
    record.type !== "output"
  ) {
    return null;
  }
  return {
    type: record.type,
    id: record.id,
    label: typeof record.label === "string" ? record.label : undefined,
  } as Parameters<ReturnType<typeof useUI>["openSettingsTarget"]>[1];
}

function arrayPayload(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/* ------------------------------------------------------------------ */
/*  Activity indicator — one title line, collapsible step details      */
/* ------------------------------------------------------------------ */

function ActivityIndicator({
  activity,
  streamPreview,
}: {
  activity: AssistantActivity;
  streamPreview: string;
}) {
  return (
    <details className="assistant-drawer-activity" open>
      <summary>
        <Bot size={16} />
        <strong>{activity.title}</strong>
        <span className={`activity-phase activity-phase-${activity.phase}`}>
          {activity.phase === "typing" ? "typing" : activity.phase}
        </span>
        <ChevronDown size={14} className="chevron" />
      </summary>
      <p className="activity-detail">{activity.detail}</p>
      <ol className="activity-steps">
        {activity.steps.map((step) => (
          <li className={`activity-step activity-${step.status}`} key={step.id}>
            <span aria-hidden="true" />
            <div>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </div>
          </li>
        ))}
      </ol>
      {streamPreview.trim() && (
        <div className="stream-preview">
          <span>Live output</span>
          <p>{streamPreview}</p>
        </div>
      )}
    </details>
  );
}

/* ------------------------------------------------------------------ */
/*  Draft approval card — inline in message stream                     */
/* ------------------------------------------------------------------ */

function DraftCard({
  draft,
  onApprove,
  onReject,
}: {
  draft: WorkflowDraft;
  onApprove: () => void;
  onReject: () => void;
}) {
  const def = draft.definition;
  const usedBuilderFallback = draft.summary.toLowerCase().includes("builder fallback");

  return (
    <article className="draft-card">
      <header>
        <Check size={16} />
        <strong>{def.name}</strong>
      </header>
      <p className="draft-card-desc">{def.description}</p>
      {usedBuilderFallback && (
        <p className="draft-card-desc">
          Template fallback used after the builder could not return a structured draft.
        </p>
      )}

      <dl className="draft-card-meta">
        <dt>Schedule</dt>
        <dd>{formatSchedule(def.schedule)}</dd>
        <dt>Accesses</dt>
        <dd>
          <ul className="draft-card-permissions">
            {def.permissions.map((p) => (
              <li key={p}>{describePermission(p)}</li>
            ))}
          </ul>
        </dd>
      </dl>

      {draft.validationStatus !== "valid" && draft.validationErrors.length > 0 && (
        <div className="draft-card-errors">
          {draft.validationErrors.map((err) => (
            <p key={err}>{err}</p>
          ))}
        </div>
      )}

      <div className="draft-card-actions">
        <button
          className="primary-action"
          type="button"
          onClick={onApprove}
          disabled={draft.validationStatus !== "valid"}
        >
          <Check size={16} />
          Approve
        </button>
        <button type="button" onClick={onReject}>
          Reject
        </button>
      </div>

      <details className="draft-card-technical">
        <summary>Technical details</summary>
        <pre>{JSON.stringify(draft.definition, null, 2)}</pre>
      </details>
    </article>
  );
}
