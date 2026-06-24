import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  currentWeatherWorkflow,
  dailyWorkJournalWorkflow,
  morningBriefWorkflow,
  validateWorkflowDefinition,
} from "../../domain/workflow";
import type {
  AgentAuthProfile,
  AppState,
  ApprovalMode,
  BuilderDraftEvent,
  ChatMessage,
  RavenWorkflow,
  ViewContext,
  ViewName,
  WorkflowDraft,
  WorkflowState,
  WorkflowVersion,
} from "../../domain/types";
import { formatSchedule, groupProviderProfiles } from "../../domain/format";
import {
  approvePersistedWorkflowDraft,
  createPersistedWorkflowDraft,
} from "../tauriBridge";
import { useAppState } from "./AppStateContext";
import { useUI } from "./UIContext";

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

type AssistantIntent = "create_workflow" | "edit_workflow" | "question" | "run_action" | "navigate";

function detectIntent(text: string): AssistantIntent {
  const lower = text.toLowerCase();
  if (lower.match(/\b(edit|change|update|modify|set|switch)\b.*\b(workflow|schedule|provider|approval|status|cadence|time)\b/))
    return "edit_workflow";
  if (lower.match(/\b(create|build|make|set up|new)\b.*\b(workflow|automation|schedule)\b/))
    return "create_workflow";
  if (lower.match(/\b(run|execute|trigger|start)\b.*\b(workflow|this|it|now)\b/))
    return "run_action";
  if (lower.match(/\b(go to|show|open|navigate)\b.*\b(settings|library|artifacts|home|command center|workflows|templates)\b/))
    return "navigate";
  return "question";
}

// ---------------------------------------------------------------------------
// Contextual question answering (no Codex agent involved)
// ---------------------------------------------------------------------------

function answerQuestion(prompt: string, state: AppState, viewContext: ViewContext): string {
  const lower = prompt.toLowerCase();

  // Run failure questions
  if (lower.match(/\b(why|what happened|fail|error|block)\b.*\b(run|fail|block|error)\b/)) {
    const failedRuns = state.runs.filter((r) =>
      ["failed", "blocked", "retryable"].includes(r.status),
    );
    if (failedRuns.length === 0) return "All your recent runs have succeeded. No failures to report.";
    const latest = failedRuns[0];
    return `The most recent issue: **${latest.workflowName}** is ${latest.status}. ${latest.failureReason || latest.blockedReason || latest.setupAction || "No additional details available."}\n\nYou can retry it from the workflow detail page or fix the configuration in Settings.`;
  }

  // Workflow explanation
  if (
    lower.match(/\b(what|explain|describe|how)\b.*\b(workflow|this)\b/) &&
    viewContext.selectedWorkflowId
  ) {
    const workflow = state.workflows.find((w) => w.workflowId === viewContext.selectedWorkflowId);
    if (workflow) {
      const def = workflow.definition;
      const steps = def.steps
        .map(
          (s, i) =>
            `${i + 1}. **${s.name}** — ${s.kind === "agent_task" ? "AI agent task" : `${s.provider}.${s.action}`}`,
        )
        .join("\n");
      return `**${def.name}**: ${def.description}\n\n**Schedule:** ${formatSchedule(def.schedule)}\n**Steps:**\n${steps}\n\n**Permissions:** ${def.permissions.join(", ")}`;
    }
  }

  // Provider / settings help
  if (lower.match(/\b(configure|setup|connect|provider|api key|settings)\b/)) {
    const groups = groupProviderProfiles(state.agentAuthProfiles);
    const ready = groups.filter((g) => g.isReady);
    const needsSetup = groups.filter((g) => !g.isReady);
    if (needsSetup.length === 0)
      return `All provider groups are configured and ready (${ready.map((g) => g.groupName).join(", ")}). You're good to go!`;
    return `**Provider status:**\n${groups.map((g) => `- **${g.groupName}**: ${g.isReady ? "Ready" : "Needs setup"}`).join("\n")}\n\nGo to **Settings → Providers** to configure API keys for groups that need setup. OAuth-based providers (like Codex and Claude Code) are auto-detected.`;
  }

  // General help
  if (lower.match(/\b(help|what can you|how do i|capabilities)\b/)) {
    return "I can help you with:\n\n- **Create workflows** — \"Create a workflow that checks the weather daily\"\n- **Run workflows** — \"Run the Daily Work Journal\"\n- **Explain things** — \"What does this workflow do?\" or \"Why did my run fail?\"\n- **Navigate** — \"Go to Settings\" or \"Show me Artifacts\"\n- **Configure** — \"How do I configure a provider?\"\n\nTry asking me anything about your workflows, runs, or settings!";
  }

  // Artifact questions
  if (lower.match(/\b(artifact|output|result|generated)\b/)) {
    if (state.artifacts.length === 0)
      return "No artifacts have been generated yet. Run a workflow to create your first artifact!";
    const selectedArtifact = state.artifacts.find(
      (artifact) => artifact.id === viewContext.selectedArtifactId,
    );
    if (selectedArtifact) {
      const run = state.runs.find((item) => item.id === selectedArtifact.workflowRunId);
      const workflowId =
        run?.workflowId ??
        (typeof selectedArtifact.metadata.workflowId === "string"
          ? selectedArtifact.metadata.workflowId
          : "");
      const workflow = state.workflows.find((item) => item.workflowId === workflowId);
      return `You're viewing **${selectedArtifact.title}**. It came from **${workflow?.definition.name ?? run?.workflowName ?? "an unresolved workflow"}** run **${selectedArtifact.workflowRunId}** and used ${selectedArtifact.sourceRefs.length} source${selectedArtifact.sourceRefs.length === 1 ? "" : "s"}.`;
    }
    const latest = [...state.artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return `You have **${state.artifacts.length}** artifact${state.artifacts.length > 1 ? "s" : ""}. The most recent is **${latest.title}** (created ${new Date(latest.createdAt).toLocaleDateString()}). Check **Artifacts** to browse all artifacts.`;
  }

  // Fallback
  return `I'm not sure how to help with that specifically. I can:\n\n- Create and manage workflows\n- Explain your workflow configurations\n- Help troubleshoot run failures\n- Guide you through settings\n\nTry rephrasing, or ask "help" to see what I can do!`;
}

// ---------------------------------------------------------------------------
// Navigate intent helper
// ---------------------------------------------------------------------------

function parseNavigationTarget(prompt: string): ViewName | null {
  const lower = prompt.toLowerCase();
  if (lower.includes("setting")) return "settings";
  if (lower.includes("library") || lower.includes("artifact")) return "artifacts";
  if (lower.includes("home") || lower.includes("command center")) return "home";
  if (lower.includes("template")) return "marketplace";
  if (lower.includes("workflow")) return "workflows";
  return null;
}

function workflowToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findWorkflowForEdit(
  prompt: string,
  workflows: WorkflowVersion[],
  selectedWorkflowId: string,
): WorkflowVersion | null {
  const selected = workflows.find((workflow) => workflow.workflowId === selectedWorkflowId);
  const promptToken = workflowToken(prompt);
  const named = workflows.find((workflow) => {
    const nameToken = workflowToken(workflow.definition.name);
    const idToken = workflowToken(workflow.workflowId);
    return promptToken.includes(nameToken) || promptToken.includes(idToken);
  });
  return named ?? selected ?? null;
}

function findWorkflowIdForArtifact(selectedArtifactId: string, state: AppState): string {
  const artifact = state.artifacts.find((item) => item.id === selectedArtifactId);
  if (!artifact) return "";
  const run = state.runs.find((item) => item.id === artifact.workflowRunId);
  const metadataWorkflowId =
    typeof artifact.metadata.workflowId === "string"
      ? artifact.metadata.workflowId
      : typeof artifact.metadata.workflow_id === "string"
        ? artifact.metadata.workflow_id
        : "";
  return run?.workflowId ?? metadataWorkflowId;
}

function parseWorkflowStatus(prompt: string, current: WorkflowState): WorkflowState {
  const lower = prompt.toLowerCase();
  if (lower.match(/\b(enable|enabled|turn on|activate)\b/)) return "enabled";
  if (lower.match(/\b(disable|disabled|turn off|pause)\b/)) return "disabled";
  if (lower.match(/\b(draft)\b/)) return "draft";
  return current;
}

function parseWorkflowCadence(
  prompt: string,
  current: NonNullable<RavenWorkflow["schedule"]>["cadence"],
): NonNullable<RavenWorkflow["schedule"]>["cadence"] {
  const lower = prompt.toLowerCase();
  if (lower.match(/\b(manual|on demand|ad hoc)\b/)) return "manual";
  if (lower.match(/\b(weekday|weekdays|workday|workdays)\b/)) return "weekdays";
  if (lower.match(/\b(daily|every day|each day)\b/)) return "daily";
  return current;
}

function parseWorkflowLocalTime(prompt: string, current?: string): string | undefined {
  const lower = prompt.toLowerCase();
  const explicitTime = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (explicitTime) {
    return `${explicitTime[1].padStart(2, "0")}:${explicitTime[2]}`;
  }
  const amPm = lower.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  if (amPm) {
    let hour = Number(amPm[1]);
    const minute = amPm[2] ?? "00";
    if (amPm[3] === "pm" && hour !== 12) hour += 12;
    if (amPm[3] === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${minute}`;
  }
  return current;
}

function parseApprovalMode(prompt: string, current: ApprovalMode): ApprovalMode {
  const lower = prompt.toLowerCase();
  const matches: Array<{ index: number; mode: ApprovalMode }> = [];
  collectRegexMatches(lower, /\b(auto[- ]?approve|auto approve|without approval)\b/g).forEach((index) =>
    matches.push({ index, mode: "auto_approve" }),
  );
  collectRegexMatches(lower, /\b(always review|manual approval|require approval|review every)\b/g).forEach((index) =>
    matches.push({ index, mode: "always_review" }),
  );
  collectRegexMatches(lower, /\b(review changes|changed only|only changes)\b/g).forEach((index) =>
    matches.push({ index, mode: "review_changes" }),
  );
  return matches.sort((a, b) => b.index - a.index)[0]?.mode ?? current;
}

function parseWorkflowProvider(
  prompt: string,
  profiles: AgentAuthProfile[],
  current?: string,
): string | undefined {
  return parseRequestedWorkflowProvider(prompt, profiles) ?? current;
}

function parseRequestedWorkflowProvider(
  prompt: string,
  profiles: AgentAuthProfile[],
): string | undefined {
  const lower = prompt.toLowerCase();
  const aliases: Array<[RegExp, string]> = [
    [/\bcodex\b/g, "codex-oauth-local"],
    [/\bclaude\b/g, "claude-code-oauth-local"],
    [/\bollama\b/g, "ollama-local"],
    [/\bopenai\b/g, "openai-api-key"],
    [/\banthropic\b/g, "anthropic-api-key"],
  ];
  const ids = new Set(profiles.map((profile) => profile.id));
  const matches: Array<{ index: number; profileId: string }> = [];
  for (const [pattern, profileId] of aliases) {
    if (!ids.has(profileId)) continue;
    collectRegexMatches(lower, pattern).forEach((index) => matches.push({ index, profileId }));
  }
  for (const profile of profiles) {
    const directIndex = lower.lastIndexOf(profile.id.toLowerCase());
    if (directIndex >= 0) matches.push({ index: directIndex, profileId: profile.id });
  }
  return matches.sort((a, b) => b.index - a.index)[0]?.profileId;
}

function collectRegexMatches(text: string, pattern: RegExp): number[] {
  const indexes: number[] = [];
  for (const match of text.matchAll(pattern)) {
    indexes.push(match.index ?? 0);
  }
  return indexes;
}

function unsupportedSideEffectRequest(prompt: string): string | null {
  const lower = prompt.toLowerCase();
  if (lower.match(/\b(delete|remove|destroy)\b.*\b(file|files|artifact|artifacts|folder|folders)\b/)) {
    return "delete local files";
  }
  if (lower.match(/\b(email|mail)\b/)) return "send email";
  if (lower.match(/\bslack\b/)) return "publish to Slack";
  if (lower.match(/\b(publish|post|send)\b.*\b(external|public|webhook)\b/)) {
    return "publish externally";
  }
  return null;
}

function applyWorkflowProfile(definition: RavenWorkflow, profileId: string): RavenWorkflow {
  return {
    ...definition,
    defaults: {
      ...definition.defaults,
      llmProfileRef: profileId,
    },
    steps: definition.steps.map((step) =>
      step.kind === "agent_task" || step.llmProfileRef
        ? { ...step, llmProfileRef: profileId }
        : step,
    ),
  };
}

type ChatActivityPhase = "thinking" | "typing" | "complete" | "failed";
type ChatActivityStepStatus = "pending" | "active" | "complete" | "failed";
type ChatActivityStep = {
  id: string;
  label: string;
  status: ChatActivityStepStatus;
  detail: string;
};

export type AssistantActivity = {
  phase: ChatActivityPhase;
  title: string;
  detail: string;
  steps: ChatActivityStep[];
};

interface AssistantState {
  messages: ChatMessage[];
  draft: WorkflowDraft | null;
  chatInput: string;
  isGeneratingDraft: boolean;
  chatActivity: AssistantActivity | null;
  builderStreamPreview: string;
  approvalNotice: string;
}

interface AssistantActions {
  generateDraft: () => Promise<void>;
  approveDraft: () => Promise<void>;
  rejectDraft: () => void;
  clearHistory: () => void;
  setChatInput: (value: string) => void;
}

type AssistantContextValue = AssistantState & AssistantActions;

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { state, actions } = useAppState();
  const { view, selectedWorkflowId, selectedArtifactId, activeSettingsTab, setView } = useUI();

  const [messages, setMessages] = useState<ChatMessage[]>(state.chatMessages);
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
  const [chatActivity, setChatActivity] = useState<AssistantActivity | null>(null);
  const [builderStreamPreview, setBuilderStreamPreview] = useState("");
  const [approvalNotice, setApprovalNotice] = useState("");

  useEffect(() => {
    if (state.chatMessages.length > 0) {
      setMessages(state.chatMessages);
    }
  }, [state.chatMessages]);

  const builderProfile = useMemo(
    () => state.agentAuthProfiles.find((p) => p.status === "available") ?? null,
    [state.agentAuthProfiles],
  );

  const appendMessages = useCallback((newMessages: ChatMessage[]) => {
    setMessages((current) => [...current, ...newMessages]);
  }, []);

  const updateChatActivityStep = useCallback(
    (stepId: string, status: ChatActivityStepStatus, detail?: string) => {
      setChatActivity((current) => {
        if (!current) return current;
        return {
          ...current,
          steps: current.steps.map((step) =>
            step.id === stepId ? { ...step, status, detail: detail ?? step.detail } : step,
          ),
        };
      });
    },
    [],
  );

  const applyBuilderDraftEvent = useCallback((event: BuilderDraftEvent) => {
    if (event.delta) {
      setBuilderStreamPreview((current) => `${current}${event.delta}`.slice(-2400));
    }
    setChatActivity((current) => {
      if (!current) return current;
      return {
        ...current,
        phase: event.phase,
        title: event.title || current.title,
        detail: event.detail || current.detail,
        steps: current.steps.map((step) =>
          step.id === event.stepId
            ? { ...step, status: event.status, detail: event.detail || step.detail }
            : step,
        ),
      };
    });
  }, []);

  const completeDraftGeneration = useCallback(
    (builtDraft: WorkflowDraft, builderLabel: string) => {
      const usedBuilderFallback = builtDraft.summary.toLowerCase().includes("builder fallback");
      appendMessages([
        {
          id: `chat-${crypto.randomUUID()}`,
          role: "assistant",
          content:
            builtDraft.validationStatus === "valid"
              ? `Draft ready for review: ${builtDraft.definition.name}`
              : `Draft failed validation for ${builtDraft.definition.name}`,
          createdAt: now(),
        },
      ]);
      setDraft(builtDraft);
      setChatActivity({
        phase: builtDraft.validationStatus === "valid" ? "complete" : "failed",
        title: builtDraft.validationStatus === "valid" ? "Builder finished" : "Draft needs fixes",
        detail:
          builtDraft.validationStatus === "valid"
            ? usedBuilderFallback
              ? `${builderLabel} used the template fallback and produced a validated workflow draft.`
              : `${builderLabel} produced a validated workflow draft.`
            : `${builderLabel} returned a draft with validation issues.`,
        steps: [
          {
            id: "profile",
            label: "Builder profile",
            status: "complete",
            detail: builtDraft.builderProfileId ?? builderProfile?.id ?? "",
          },
          {
            id: "context",
            label: "Raven context",
            status: "complete",
            detail: "Schema, permissions, destinations, and approval rules attached.",
          },
          {
            id: "draft",
            label: "Draft output",
            status: "complete",
            detail: builtDraft.definition.name,
          },
          {
            id: "validation",
            label: "Validation",
            status: builtDraft.validationStatus === "valid" ? "complete" : "failed",
            detail:
              builtDraft.validationErrors.length > 0
                ? builtDraft.validationErrors.join("; ")
                : "Schema accepted.",
          },
        ],
      });
    },
    [appendMessages, builderProfile],
  );

  const generateDraft = useCallback(async () => {
    const prompt = chatInput.trim();
    if (!prompt || isGeneratingDraft) return;

    const intent = detectIntent(prompt);

    const builderLabel = builderProfile?.displayName ?? builderProfile?.id ?? "Builder";
    const builderProfileId = builderProfile?.id ?? "";

    setIsGeneratingDraft(true);
    setDraft(null);
    setBuilderStreamPreview("");
    setApprovalNotice("");
    setChatInput("");

    appendMessages([
      {
        id: `chat-${crypto.randomUUID()}`,
        role: "user",
        content: prompt,
        createdAt: now(),
      },
    ]);

    // --- question intent: answer from app state, no builder agent ---
    if (intent === "question") {
      const viewContext: ViewContext = {
        currentView: view,
        selectedWorkflowId,
        selectedArtifactId,
        activeSettingsTab,
      };
      const answer = answerQuestion(prompt, state, viewContext);
      appendMessages([
        {
          id: `chat-${crypto.randomUUID()}`,
          role: "assistant",
          content: answer,
          createdAt: now(),
        },
      ]);
      setIsGeneratingDraft(false);
      return;
    }

    // --- edit_workflow intent: apply safe workflow edits through the backend ---
    if (intent === "edit_workflow") {
      const artifactWorkflowId =
        view === "artifacts" ? findWorkflowIdForArtifact(selectedArtifactId, state) : "";
      const target = findWorkflowForEdit(
        prompt,
        state.workflows,
        artifactWorkflowId || selectedWorkflowId,
      );
      if (!target) {
        appendMessages([
          {
            id: `chat-${crypto.randomUUID()}`,
            role: "assistant",
            content:
              "I couldn't determine which workflow to edit. Open a workflow or include its name.",
            createdAt: now(),
          },
        ]);
        setIsGeneratingDraft(false);
        return;
      }

      const currentSchedule = target.definition.schedule ?? { cadence: "manual" as const };
      const nextStatus = parseWorkflowStatus(prompt, target.status);
      const nextCadence = parseWorkflowCadence(prompt, currentSchedule.cadence);
      const nextLocalTime = parseWorkflowLocalTime(prompt, currentSchedule.localTime);
      const nextApprovalMode = parseApprovalMode(prompt, target.approvalMode);
      const nextProvider = parseWorkflowProvider(
        prompt,
        state.agentAuthProfiles,
        target.definition.defaults.llmProfileRef,
      );
      const changedFields = [
        nextStatus !== target.status ? `status to ${nextStatus}` : "",
        nextCadence !== currentSchedule.cadence ? `schedule to ${nextCadence}` : "",
        (nextLocalTime ?? "") !== (currentSchedule.localTime ?? "")
          ? `time to ${nextLocalTime ?? "unset"}`
          : "",
        nextApprovalMode !== target.approvalMode ? `approval mode to ${nextApprovalMode}` : "",
        nextProvider !== target.definition.defaults.llmProfileRef ? `provider to ${nextProvider}` : "",
      ].filter(Boolean);

      if (changedFields.length === 0) {
        appendMessages([
          {
            id: `chat-${crypto.randomUUID()}`,
            role: "assistant",
            content:
              "I can edit workflow status, provider, schedule, time, and approval mode. Try a request like \"Change Current Weather to use Ollama\" or \"Set this workflow to daily at 08:00.\"",
            createdAt: now(),
          },
        ]);
        setIsGeneratingDraft(false);
        return;
      }

      const notice = await actions.updateWorkflowSafeFields(target.workflowId, {
        status: nextStatus,
        cadence: nextCadence,
        localTime: nextLocalTime,
        approvalMode: nextApprovalMode,
        llmProfileRef: nextProvider,
      });
      appendMessages([
        {
          id: `chat-${crypto.randomUUID()}`,
          role: "assistant",
          content: `${notice}. Updated **${target.definition.name}**: ${changedFields.join(", ")}.`,
          createdAt: now(),
        },
      ]);
      setIsGeneratingDraft(false);
      return;
    }

    // --- run_action intent: trigger the workflow ---
    if (intent === "run_action") {
      const artifactWorkflowId =
        view === "artifacts" ? findWorkflowIdForArtifact(selectedArtifactId, state) : "";
      const workflowId = artifactWorkflowId || selectedWorkflowId;
      const target =
        workflowId
          ? state.workflows.find((w) => w.workflowId === workflowId)
          : null;
      if (target) {
        await actions.runWorkflow(target.workflowId);
        appendMessages([
          {
            id: `chat-${crypto.randomUUID()}`,
            role: "assistant",
            content: `Running **${target.definition.name}**…`,
            createdAt: now(),
          },
        ]);
      } else {
        appendMessages([
          {
            id: `chat-${crypto.randomUUID()}`,
            role: "assistant",
            content:
              "I couldn't determine which workflow to run. Open a workflow first, then ask me to run it.",
            createdAt: now(),
          },
        ]);
      }
      setIsGeneratingDraft(false);
      return;
    }

    // --- navigate intent: change the active view ---
    if (intent === "navigate") {
      const destination = parseNavigationTarget(prompt);
      if (destination) {
        setView(destination);
        const labels: Record<string, string> = {
          settings: "Settings",
          artifacts: "Artifacts",
          home: "Command Center",
          workflows: "Workflows",
          marketplace: "Workflows / Templates",
          "workflow-detail": "Workflow Detail",
        };
        appendMessages([
          {
            id: `chat-${crypto.randomUUID()}`,
            role: "assistant",
            content: `Navigated to **${labels[destination] ?? destination}**.`,
            createdAt: now(),
          },
        ]);
      } else {
        appendMessages([
          {
            id: `chat-${crypto.randomUUID()}`,
            role: "assistant",
            content:
              "I couldn't determine where to navigate. Try \"Go to Settings\" or \"Show me Artifacts\".",
            createdAt: now(),
          },
        ]);
      }
      setIsGeneratingDraft(false);
      return;
    }

    // --- create_workflow intent: fall through to builder agent ---
    const unsupportedSideEffect = unsupportedSideEffectRequest(prompt);
    if (unsupportedSideEffect) {
      appendMessages([
        {
          id: `chat-${crypto.randomUUID()}`,
          role: "assistant",
          content: `I can't create that workflow yet because ${unsupportedSideEffect} is not an available approved workflow capability. Choose a supported local artifact workflow or configure an explicit provider capability first.`,
          createdAt: now(),
        },
      ]);
      setIsGeneratingDraft(false);
      return;
    }

    const requestedProfileId = parseRequestedWorkflowProvider(prompt, state.agentAuthProfiles);
    const requestedProfile = requestedProfileId
      ? state.agentAuthProfiles.find((profile) => profile.id === requestedProfileId)
      : undefined;
    if (requestedProfile && requestedProfile.status !== "available") {
      appendMessages([
        {
          id: `chat-${crypto.randomUUID()}`,
          role: "assistant",
          content: `${requestedProfile.displayName} needs setup before Raven can create a runnable workflow with it. Open Settings -> Providers and finish setup, or ask for an available provider.`,
          createdAt: now(),
        },
      ]);
      setIsGeneratingDraft(false);
      return;
    }

    setChatActivity({
      phase: "thinking",
      title: "Builder is thinking",
      detail: `${builderLabel} is preparing a workflow draft request.`,
      steps: [
        {
          id: "profile",
          label: "Builder profile",
          status: "active",
          detail:
            builderProfile?.status === "available" ? "Available" : "Checking fallback path.",
        },
        {
          id: "context",
          label: "Raven context",
          status: "pending",
          detail: "Schema, provider capabilities, permissions, templates, and approval rules.",
        },
        {
          id: "draft",
          label: "Draft output",
          status: "pending",
          detail: "Waiting for structured workflow draft.",
        },
        {
          id: "validation",
          label: "Validation",
          status: "pending",
          detail: "No mutation until approval.",
        },
      ],
    });

    try {
      updateChatActivityStep("profile", "complete", `${builderLabel} selected.`);
      updateChatActivityStep("context", "active", "Sending Raven schema and workflow rules.");

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const persistedDraft = await createPersistedWorkflowDraft(
        prompt,
        requestedProfileId ?? builderProfileId,
        applyBuilderDraftEvent,
      );

      updateChatActivityStep("context", "complete", "Builder context delivered.");
      updateChatActivityStep("draft", "active", "Reading structured draft output.");

      if (persistedDraft) {
        const normalizedDraft = requestedProfileId
          ? {
              ...persistedDraft,
              builderProfileId: requestedProfileId,
              definition: applyWorkflowProfile(persistedDraft.definition, requestedProfileId),
            }
          : persistedDraft;
        updateChatActivityStep("draft", "complete", persistedDraft.definition.name);
        updateChatActivityStep(
          "validation",
          normalizedDraft.validationStatus === "valid" ? "complete" : "failed",
          normalizedDraft.validationErrors.length > 0
            ? normalizedDraft.validationErrors.join("; ")
            : "Schema accepted.",
        );
        completeDraftGeneration(normalizedDraft, builderLabel);
        return;
      }

      updateChatActivityStep("draft", "active", "Using browser-only template fallback.");
      const normalizedInput = prompt.toLowerCase();
      const definitionTemplate = normalizedInput.includes("weather")
        ? currentWeatherWorkflow
        : normalizedInput.includes("morning")
          ? morningBriefWorkflow
          : dailyWorkJournalWorkflow;
      const definition = requestedProfileId
        ? applyWorkflowProfile(definitionTemplate, requestedProfileId)
        : definitionTemplate;
      const validation = validateWorkflowDefinition(definition);

      const fallbackDraft: WorkflowDraft = {
        id: `draft-${crypto.randomUUID()}`,
        prompt,
        summary: `${definition.name} will collect trusted context, generate a Markdown artifact, and save metadata locally.`,
        permissionChanges: definition.permissions,
        destinationWrites: [definition.defaults.destinationRef],
        diffJson: [
          {
            op: "template",
            workflowId: definition.id,
            name: definition.name,
          },
        ],
        validationStatus: validation.valid ? "valid" : "invalid",
        approvalStatus: "needs_review",
        builderProfileId: requestedProfileId ?? builderProfileId,
        approvalMode: parseApprovalMode(prompt, "always_review"),
        validationErrors: validation.errors,
        definition,
        createdAt: now(),
      };

      completeDraftGeneration(fallbackDraft, builderLabel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateChatActivityStep("draft", "failed", message || "Builder request failed.");
      setChatActivity((current) =>
        current
          ? {
              ...current,
              phase: "failed",
              title: "Draft generation failed",
              detail: message || "Review provider configuration and try again.",
            }
          : current,
      );
      appendMessages([
        {
          id: `chat-${crypto.randomUUID()}`,
          role: "assistant",
          content: `Draft generation failed: ${message || "Review provider configuration and try again."}`,
          createdAt: now(),
        },
      ]);
    } finally {
      setIsGeneratingDraft(false);
    }
  }, [
    chatInput,
    isGeneratingDraft,
    builderProfile,
    appendMessages,
    updateChatActivityStep,
    applyBuilderDraftEvent,
    completeDraftGeneration,
    view,
    selectedWorkflowId,
    selectedArtifactId,
    activeSettingsTab,
    state,
    actions,
    setView,
  ]);

  const approveDraft = useCallback(async () => {
    if (!draft) return;
    const approved = await approvePersistedWorkflowDraft(draft);
    if (!approved) {
      setApprovalNotice("Failed to persist approval — please try again.");
      return;
    }
    actions.addWorkflow(approved);
    setDraft(null);
    setApprovalNotice("Workflow version approved");
  }, [draft, actions]);

  const rejectDraft = useCallback(() => {
    setDraft(null);
    setApprovalNotice("");
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setDraft(null);
    setChatActivity(null);
    setBuilderStreamPreview("");
    setApprovalNotice("");
  }, []);

  const value = useMemo<AssistantContextValue>(
    () => ({
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
      clearHistory,
      setChatInput,
    }),
    [
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
      clearHistory,
    ],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used within AssistantProvider");
  return ctx;
}
