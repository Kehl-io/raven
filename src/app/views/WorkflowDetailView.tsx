import { Check, Loader, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../contexts/AppStateContext";
import { useUI } from "../contexts/UIContext";
import { useRunStream } from "../contexts";
import { StatusIndicator } from "../components/StatusIndicator";
import { TraceTimeline } from "../components/TraceTimeline";
import { buildWorkflowBuilderNodes, WorkflowDag } from "../components/WorkflowDag";
import { RunReadinessPanel } from "../components/RunReadinessPanel";
import {
  evaluateWorkflowPreflight,
  listApprovalHistory,
  listCapabilityAuditEvents,
  loadPersistedWorkflowStepRuns,
} from "../tauriBridge";
import { formatRelativeTime, formatSchedule } from "../../domain/format";
import { validateWorkflowDefinition } from "../../domain/workflow";
import type {
  ApprovalMode,
  ApprovalRequest,
  CapabilityAuditEvent,
  AutonomyMode,
  PlannerOperation,
  PreflightManifest,
  RavenWorkflow,
  WorkflowRun,
  WorkflowState,
  WorkflowStepRun,
} from "../../domain/types";

type WorkflowCadence = "manual" | "daily" | "weekdays";
type WorkflowEditorField = "status" | "provider" | "schedule" | "time" | "approval";

export function preflightManifestMatchesContext(
  manifest: PreflightManifest | null,
  workflowId: string,
  workflowVersion: number,
  autonomyMode: AutonomyMode,
): manifest is PreflightManifest {
  return Boolean(
    manifest &&
      manifest.workflowId === workflowId &&
      manifest.workflowVersion === workflowVersion &&
      manifest.policyRecommendation === autonomyMode,
  );
}

function arrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function plannerOperationCapability(operation: PlannerOperation): string {
  return operation.capabilityId ?? operation.capability_id ?? "Agent";
}

export function plannerOperationStep(operation: PlannerOperation): string {
  return operation.stepId ?? operation.step_id ?? "";
}

function formatDuration(startedAt: string, completedAt?: string): string {
  if (!completedAt) return "In progress";
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Not reported";
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function workflowStructureSnapshot(definition: RavenWorkflow): string {
  return JSON.stringify({
    permissions: definition.permissions,
    steps: definition.steps,
  });
}

function deriveWorkflowTrust(runs: WorkflowRun[], approvalMode: ApprovalMode, approvals: ApprovalRequest[] = []) {
  const resolvedApprovals = approvals.filter((approval) => approval.status !== "pending");
  const rejectedApprovals = resolvedApprovals.filter((approval) => approval.status === "rejected").length;
  const approvedApprovals = resolvedApprovals.filter((approval) => approval.status === "approved").length;
  if (runs.length === 0) {
    return {
      score: Math.max(0, Math.min(100, (approvalMode === "auto_approve" ? 72 : 78) + approvedApprovals * 2 - rejectedApprovals * 10)),
      note: resolvedApprovals.length > 0 ? `${resolvedApprovals.length} approval decision${resolvedApprovals.length === 1 ? "" : "s"} recorded` : "No run history yet",
      detail: "Trust will become more precise after successful, failed, and approval decision history is recorded.",
    };
  }
  const failedRuns = runs.filter((run) => ["failed", "retryable"].includes(run.status)).length;
  const blockedApprovals = runs.filter(
    (run) =>
      run.status === "blocked" &&
      (run.requiredProviderId === "approval" ||
        run.requiredProfileId?.startsWith("approval") ||
        run.blockedReason?.toLowerCase().includes("approval")),
  ).length;
  const succeededRuns = runs.filter((run) => run.status === "succeeded").length;
  const score = Math.max(
    0,
    Math.min(100, 62 + succeededRuns * 8 + approvedApprovals * 2 - failedRuns * 18 - blockedApprovals * 8 - rejectedApprovals * 10 - (approvalMode === "auto_approve" ? 4 : 0)),
  );
  const note =
    failedRuns > 0
      ? `${failedRuns} failed or retryable run${failedRuns === 1 ? "" : "s"}`
      : rejectedApprovals > 0
        ? `${rejectedApprovals} rejected approval${rejectedApprovals === 1 ? "" : "s"}`
      : blockedApprovals > 0
        ? `${blockedApprovals} approval decision${blockedApprovals === 1 ? "" : "s"} required`
        : "Run history is healthy";
  const detail = `${succeededRuns} succeeded, ${failedRuns} failed/retryable, ${blockedApprovals} approval-blocked, ${resolvedApprovals.length} resolved approvals.`;
  return { score, note, detail };
}

export function WorkflowDetailView() {
  const { state, runNotice, actions } = useAppState();
  const {
    selectedWorkflowId,
    selectedRunId,
    workflowDetailFocus,
    returnFromWorkflowDetail,
    setWorkflowDetailExitGuard,
    openArtifact,
    openSettingsTarget,
    setAssistantOpen,
  } = useUI();
  const { startStreamedRun, runStream } = useRunStream();
  const usageFocusRef = useRef<HTMLElement | null>(null);
  const runReadinessRef = useRef<HTMLDivElement | null>(null);

  const workflow = useMemo(
    () =>
      state.workflows.find((w) => w.workflowId === selectedWorkflowId) ?? state.workflows[0],
    [selectedWorkflowId, state.workflows],
  );

  const workflowRuns = useMemo(
    () =>
      state.runs
        .filter((run) => run.workflowId === workflow?.workflowId)
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [state.runs, workflow],
  );

  const workflowArtifacts = useMemo(() => {
    if (!workflow) return [];
    const runIds = new Set(workflowRuns.map((run) => run.id));
    return state.artifacts
      .filter(
        (artifact) =>
          runIds.has(artifact.workflowRunId) ||
          artifact.metadata.workflowId === workflow.workflowId,
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [state.artifacts, workflowRuns, workflow]);

  const workflowUsage = useMemo(() => {
    return workflowRuns.reduce(
      (total, run) => ({
        tokens: total.tokens + (run.totalTokens ?? 0),
        cost: total.cost + (run.totalCostUsd ?? 0),
        tokenReports: total.tokenReports + (run.totalTokens != null ? 1 : 0),
        costReports: total.costReports + (run.totalCostUsd != null ? 1 : 0),
        unknownTokenRuns: total.unknownTokenRuns + (run.totalTokens == null ? 1 : 0),
        unknownCostRuns: total.unknownCostRuns + (run.totalCostUsd == null ? 1 : 0),
      }),
      { tokens: 0, cost: 0, tokenReports: 0, costReports: 0, unknownTokenRuns: 0, unknownCostRuns: 0 },
    );
  }, [workflowRuns]);
  const workflowTokensLabel = workflowUsage.tokenReports > 0
    ? workflowUsage.tokens.toLocaleString()
    : "Tokens unavailable";
  const workflowCostLabel = workflowUsage.costReports > 0
    ? formatCost(workflowUsage.cost)
    : "Cost unavailable";
  const tokenUsageNote = workflowUsage.tokenReports > 0
    ? workflowUsage.unknownTokenRuns > 0
      ? "Some runs unavailable"
      : "Reported by runs"
    : workflowRuns.length > 0
      ? "Unavailable from runs"
      : "Not reported yet";
  const costUsageNote = workflowUsage.costReports > 0
    ? workflowUsage.unknownCostRuns > 0
      ? "Some runs unavailable"
      : "Reported by runs"
    : workflowRuns.length > 0
      ? "Unavailable from runs"
      : "Not reported yet";

  const providerOptions = useMemo(() => {
    const options = new Map<string, string>();
    state.agentAuthProfiles.forEach((profile) => {
      options.set(
        profile.id,
        `${profile.displayName}${profile.status === "available" ? "" : " (needs config)"}`,
      );
    });
    state.llmProfiles.forEach((profile) => {
      if (!options.has(profile.id)) {
        options.set(profile.id, `${profile.providerId} / ${profile.model}`);
      }
    });
    return Array.from(options, ([id, label]) => ({ id, label }));
  }, [state.agentAuthProfiles, state.llmProfiles]);

  const schedule = workflow?.definition.schedule ?? { cadence: "manual" as const, localTime: "" };

  const [draftStatus, setDraftStatus] = useState<WorkflowState>(workflow?.status ?? "draft");
  const [draftCadence, setDraftCadence] = useState<WorkflowCadence>(schedule.cadence);
  const [draftLocalTime, setDraftLocalTime] = useState(schedule.localTime ?? "");
  const [draftApprovalMode, setDraftApprovalMode] = useState<ApprovalMode>(
    workflow?.approvalMode ?? "always_review",
  );
  const [draftProvider, setDraftProvider] = useState(
    workflow?.definition.defaults.llmProfileRef ?? "",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");
  const [builderDefinition, setBuilderDefinition] = useState<RavenWorkflow | null>(
    workflow?.definition ?? null,
  );
  const [stepRunsByRunId, setStepRunsByRunId] = useState<Record<string, WorkflowStepRun[]>>({});
  const [capabilityAuditByRunId, setCapabilityAuditByRunId] = useState<Record<string, CapabilityAuditEvent[]>>({});
  const [approvalHistory, setApprovalHistory] = useState<ApprovalRequest[]>([]);
  const [preflightManifest, setPreflightManifest] = useState<PreflightManifest | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const previousWorkflowIdRef = useRef(workflow?.workflowId);

  const effectiveDraftLocalTime =
    draftCadence === "manual"
      ? undefined
      : draftLocalTime || workflow?.definition.schedule?.localTime || "09:00";

  const draftDefinition = useMemo(() => {
    if (!workflow) return null;
    const baseDefinition = builderDefinition ?? workflow.definition;
    return {
      ...baseDefinition,
      defaults: {
        ...baseDefinition.defaults,
        llmProfileRef: draftProvider || baseDefinition.defaults.llmProfileRef,
      },
      schedule:
        draftCadence === "manual"
          ? { cadence: "manual" as const }
          : {
              cadence: draftCadence,
              localTime: effectiveDraftLocalTime ?? "09:00",
            },
    };
  }, [builderDefinition, draftCadence, draftProvider, effectiveDraftLocalTime, workflow]);

  const hasBuilderChanges =
    workflow != null &&
    builderDefinition != null &&
    workflowStructureSnapshot(builderDefinition) !== workflowStructureSnapshot(workflow.definition);

  const hasSafeDraftChanges =
    workflow != null &&
    (draftStatus !== workflow.status ||
      draftCadence !== schedule.cadence ||
      draftLocalTime !== (schedule.localTime ?? "") ||
      draftApprovalMode !== (workflow.approvalMode ?? "always_review") ||
      draftProvider !== (workflow.definition.defaults.llmProfileRef ?? ""));

  const hasDraftChanges =
    workflow != null &&
    (hasSafeDraftChanges || hasBuilderChanges);
  const latestRun = workflowRuns[0];
  const latestArtifact = workflowArtifacts[0];
  const latestRunCreatedArtifact = latestRun
    ? workflowArtifacts.some((artifact) => artifact.workflowRunId === latestRun.id)
    : false;
  const workflowApprovalHistory = useMemo(() => {
    if (!workflow) return [];
    const runIds = new Set(workflowRuns.map((run) => run.id));
    return approvalHistory.filter(
      (approval) => approval.workflowName === workflow.definition.name || runIds.has(approval.runId),
    );
  }, [approvalHistory, workflow, workflowRuns]);
  const workflowCapabilityAudit = useMemo(
    () => Object.values(capabilityAuditByRunId).flat(),
    [capabilityAuditByRunId],
  );
  const currentPreflightManifest = useMemo(() => {
    if (!workflow) return null;
    return preflightManifestMatchesContext(
      preflightManifest,
      workflow.workflowId,
      workflow.version,
      state.autonomyMode,
    )
      ? preflightManifest
      : null;
  }, [preflightManifest, state.autonomyMode, state.autonomyCategoryOverrides, workflow]);
  const workflowTrust = deriveWorkflowTrust(workflowRuns, draftApprovalMode, workflowApprovalHistory);
  const builderWorkflowVersion = useMemo(
    () =>
      workflow
        ? {
            ...workflow,
            status: draftStatus,
            approvalMode: draftApprovalMode,
            definition: draftDefinition ?? workflow.definition,
          }
        : null,
    [draftApprovalMode, draftDefinition, draftStatus, workflow],
  );
  const builderNodes = useMemo(
    () =>
      builderWorkflowVersion
        ? buildWorkflowBuilderNodes({
            workflow: builderWorkflowVersion,
            providers: state.providers,
            llmProfiles: state.llmProfiles,
            agentAuthProfiles: state.agentAuthProfiles,
            runs: workflowRuns,
            artifacts: workflowArtifacts,
            pendingApproval: runStream.pendingApproval,
            activeSteps: runStream.activeSteps,
          })
        : [],
    [
      builderWorkflowVersion,
      runStream.activeSteps,
      runStream.pendingApproval,
      state.agentAuthProfiles,
      state.llmProfiles,
      state.providers,
      workflowArtifacts,
      workflowRuns,
    ],
  );
  const builderRequirementCount = builderNodes.reduce((count, node) => count + node.requirements.length, 0);
  const blockedRequirementCount = latestRun?.status === "blocked"
    ? Math.max(
        1,
        currentPreflightManifest?.blockingItems.length ??
          state.runs.filter((run) => run.workflowId === workflow?.workflowId && run.status === "blocked").length,
      )
    : 0;
  const requirementsSummaryLabel = blockedRequirementCount > 0
    ? `Blocked (${blockedRequirementCount})`
    : String(builderRequirementCount);
  const draftValidation = useMemo(
    () =>
      workflow
        ? validateWorkflowDefinition(draftDefinition ?? workflow.definition, [], state.capabilityRegistry.capabilities)
        : { valid: false, errors: ["No workflow selected."] },
    [draftDefinition, state.capabilityRegistry.capabilities, workflow],
  );
  const validationSummaryParts: string[] = [];
  if (!draftValidation.valid) {
    validationSummaryParts.push(`${draftValidation.errors.length} schema issue${draftValidation.errors.length === 1 ? "" : "s"}`);
  }
  if (builderRequirementCount > 0) {
    validationSummaryParts.push(`${builderRequirementCount} setup requirement${builderRequirementCount === 1 ? "" : "s"}`);
  }
  const validationStateLabel = validationSummaryParts.length > 0
    ? validationSummaryParts.join(" · ")
    : "Ready to save";
  const draftStateLabel = hasBuilderChanges
    ? "Draft version pending"
    : hasSafeDraftChanges
      ? "Draft field changes pending"
      : workflow ? `Saved version v${workflow.version}` : "No workflow selected";
  const lastSavedLabel = workflow ? formatRelativeTime(workflow.createdAt) : "No workflow selected";
  const plannerRationale = workflow?.plannerRationale ?? workflow?.planner_rationale ?? null;

  useEffect(() => {
    if (!workflow) return;
    const workflowChanged = previousWorkflowIdRef.current !== workflow.workflowId;
    previousWorkflowIdRef.current = workflow.workflowId;
    setDraftStatus(workflow.status);
    setDraftCadence(schedule.cadence);
    setDraftLocalTime(schedule.localTime ?? "");
    setDraftApprovalMode(workflow.approvalMode);
    setDraftProvider(workflow.definition.defaults.llmProfileRef ?? "");
    setBuilderDefinition(workflow.definition);
    if (workflowChanged) setSaveNotice("");
  }, [workflow?.id, workflow?.status, schedule.cadence, schedule.localTime, workflow?.approvalMode, workflow?.definition.defaults.llmProfileRef]);

  useEffect(() => {
    let cancelled = false;
    const visibleRunIds = workflowRuns.slice(0, 6).map((run) => run.id);
    if (selectedRunId && !visibleRunIds.includes(selectedRunId)) {
      visibleRunIds.unshift(selectedRunId);
    }
    if (visibleRunIds.length === 0) {
      setStepRunsByRunId({});
      setCapabilityAuditByRunId({});
      return;
    }
    Promise.all([
      Promise.all(
        visibleRunIds.map(async (runId) => [runId, await loadPersistedWorkflowStepRuns(runId)] as const),
      ),
      Promise.all(
        visibleRunIds.map(async (runId) => [
          runId,
          await listCapabilityAuditEvents(runId).catch(() => []),
        ] as const),
      ),
    ]).then(([stepRunEntries, capabilityAuditEntries]) => {
      if (cancelled) return;
      setStepRunsByRunId(Object.fromEntries(stepRunEntries));
      setCapabilityAuditByRunId(Object.fromEntries(capabilityAuditEntries));
    });
    return () => {
      cancelled = true;
    };
  }, [workflowRuns, selectedRunId]);

  useEffect(() => {
    let cancelled = false;
    void listApprovalHistory().then((history) => {
      if (!cancelled) setApprovalHistory(history);
    });
    return () => {
      cancelled = true;
    };
  }, [workflow?.workflowId]);

  useEffect(() => {
    let cancelled = false;
    if (!workflow) {
      setPreflightManifest(null);
      return;
    }
    const workflowId = workflow.workflowId;
    const workflowVersion = workflow.version;
    const autonomyMode = state.autonomyMode;
    const categoryOverrides = state.autonomyCategoryOverrides;
    setPreflightManifest(null);
    setPreflightLoading(true);
    void evaluateWorkflowPreflight(workflowId, workflowVersion, autonomyMode, categoryOverrides)
      .then((manifest) => {
        if (!cancelled) {
          setPreflightManifest(
            preflightManifestMatchesContext(manifest, workflowId, workflowVersion, autonomyMode)
              ? manifest
              : null,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setPreflightManifest(null);
      })
      .finally(() => {
        if (!cancelled) setPreflightLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.autonomyMode, state.autonomyCategoryOverrides, workflow?.version, workflow?.workflowId]);

  useEffect(() => {
    if (workflowDetailFocus !== "usage" && workflowDetailFocus !== "run-history") return;
    usageFocusRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    usageFocusRef.current?.focus({ preventScroll: true });
  }, [workflowDetailFocus, workflow?.workflowId]);

  useEffect(() => {
    if (!hasDraftChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasDraftChanges]);

  useEffect(() => {
    setWorkflowDetailExitGuard(() => {
      if (!hasDraftChanges) return true;
      return window.confirm("Discard unsaved workflow changes?");
    });
    return () => setWorkflowDetailExitGuard(null);
  }, [hasDraftChanges, setWorkflowDetailExitGuard]);

  if (!workflow) {
    return (
      <section className="view-grid">
        <p>No workflow selected.</p>
      </section>
    );
  }

  const saveWorkflowChanges = async () => {
    if (!draftDefinition) return;
    const validation = validateWorkflowDefinition(draftDefinition, [], state.capabilityRegistry.capabilities);
    if (!validation.valid) {
      setSaveNotice(`Workflow save blocked: ${validation.errors[0]}`);
      return;
    }
    setIsSaving(true);
    if (hasBuilderChanges) {
      const savedWorkflow = await actions.installWorkflowTemplate(
        draftDefinition,
        draftStatus,
        draftApprovalMode,
      );
      setSaveNotice(savedWorkflow ? "Workflow changes saved" : "Workflow save failed");
      if (savedWorkflow) setBuilderDefinition(savedWorkflow.definition);
    } else {
      const notice = await actions.updateWorkflowSafeFields(workflow.workflowId, {
        status: draftStatus,
        cadence: draftCadence,
        localTime: effectiveDraftLocalTime,
        approvalMode: draftApprovalMode,
        llmProfileRef: draftProvider,
      });
      setSaveNotice(notice);
    }
    setIsSaving(false);
  };

  const undoBuilderChanges = () => {
    setSaveNotice("");
    setBuilderDefinition(workflow.definition);
  };

  const focusEditorField = (field: WorkflowEditorField) => {
    const idByField: Record<WorkflowEditorField, string> = {
      status: "workflow-editor-status",
      provider: "workflow-editor-provider",
      schedule: "workflow-editor-schedule",
      time: "workflow-editor-time",
      approval: "workflow-editor-approval",
    };
    document.getElementById(idByField[field])?.focus();
  };

  const leaveWorkflowDetail = () => {
    returnFromWorkflowDetail();
  };

  return (
    <section className="view-grid workflow-detail-view">
      <header className="page-header">
        <div>
          <p className="breadcrumb">Workflows / {workflow.definition.name}</p>
          <h1>{workflow.definition.name}</h1>
          <p>{workflow.definition.description}</p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={leaveWorkflowDetail}>
            Back
          </button>
          <button
            type="button"
            className="danger-action"
            disabled={isArchiving}
            onClick={() => {
              if (!window.confirm("Archive this workflow? Existing runs and artifacts will remain.")) {
                return;
              }
              setIsArchiving(true);
              void actions.archiveWorkflow(workflow.workflowId).then((archived) => {
                setIsArchiving(false);
                if (!archived) {
                  setSaveNotice("Workflow archive failed");
                  return;
                }
                returnFromWorkflowDetail();
              });
            }}
          >
            {isArchiving ? "Archiving..." : "Archive workflow"}
          </button>
          {workflow.status === "enabled" && (
            <button
              className="primary-action"
              type="button"
              aria-label={`Run now for ${workflow.definition.name}`}
              onClick={() => void startStreamedRun(workflow.workflowId).then((result) => {
                if (result) actions.applyRunResults([result]);
              })}
              disabled={runStream.activeRunId != null}
            >
              {runStream.activeRunId != null ? (
                <>
                  <Loader size={18} className="running-spinner" />
                  Running...
                </>
              ) : (
                <>
                  <Play size={18} />
                  Run now
                </>
              )}
            </button>
          )}
        </div>
        {runNotice && <span className="success-note">{runNotice}</span>}
      </header>

      <section className="workflow-detail-grid">
        {/* Left column: summary + edit controls + step timeline */}
        <div>
          <div className="workflow-summary-grid" aria-label="Workflow summary">
            <div className="metric">
              <span>Status</span>
              <StatusIndicator status={workflow.status} />
            </div>
            <div className="metric">
              <span>Schedule</span>
              <strong>{formatSchedule(workflow.definition.schedule)}</strong>
            </div>
            <div className="metric">
              <span>Version</span>
              <strong>v{workflow.version}</strong>
            </div>
            <div className="metric">
              <span>Last run</span>
              <strong>{latestRun ? formatRelativeTime(latestRun.startedAt) : "None"}</strong>
            </div>
            <div className="metric">
              <span>Artifacts</span>
              <strong>{workflowArtifacts.length}</strong>
            </div>
            <div className="metric">
              <span>Usage</span>
              <strong>{workflowCostLabel}</strong>
            </div>
            <div className="metric">
              <span>Requirements</span>
              <strong>{requirementsSummaryLabel}</strong>
            </div>
            <div className="metric">
              <span>Validation</span>
              <strong>{validationStateLabel}</strong>
            </div>
            <div className="metric">
              <span>Draft state</span>
              <strong>{draftStateLabel}</strong>
            </div>
            <div className="metric">
              <span>Last saved</span>
              <strong>{lastSavedLabel}</strong>
            </div>
          </div>

          <article className="workflow-trust-panel" aria-label="Workflow trust score">
            <div>
              <span>Trust score</span>
              <strong>{workflowTrust.score}/100</strong>
            </div>
            <p>{workflowTrust.note}</p>
            <small>{workflowTrust.detail}</small>
          </article>

          {latestRun?.status === "blocked" && (
            <section className="workflow-blocked-recovery" role="region" aria-label="Blocked run recovery">
              <div>
                <strong>Latest run is blocked</strong>
                <p>
                  {latestRun.blockedReason ?? latestRun.setupAction ?? "Review run readiness, grants, or provider setup before retrying."}
                </p>
                {!latestRunCreatedArtifact && (
                  <small>No artifact was created for this blocked run.</small>
                )}
              </div>
              <div className="workflow-recovery-actions">
                <button
                  type="button"
                  onClick={() => {
                    runReadinessRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                    runReadinessRef.current?.focus({ preventScroll: true });
                  }}
                >
                  Review run readiness
                </button>
                <button type="button" className="primary-action" onClick={() => void actions.retryRun(latestRun.id)}>
                  Retry blocked run
                </button>
              </div>
            </section>
          )}

          <article className="workflow-editor-panel">
            <h2>Edit workflow</h2>
            <div className="workflow-edit-form">
              <label>
                Status
                <select
                  id="workflow-editor-status"
                  value={draftStatus}
                  onChange={(e) => {
                    setSaveNotice("");
                    setDraftStatus(e.currentTarget.value as WorkflowState);
                  }}
                >
                  <option value="enabled">Enabled</option>
                  <option value="draft">Draft</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <label>
                Provider
                <select
                  id="workflow-editor-provider"
                  value={draftProvider}
                  onChange={(e) => {
                    setSaveNotice("");
                    setDraftProvider(e.currentTarget.value);
                  }}
                >
                  {draftProvider && !providerOptions.some((option) => option.id === draftProvider) && (
                    <option value={draftProvider}>{draftProvider} (current)</option>
                  )}
                  {providerOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Repeats
                <select
                  id="workflow-editor-schedule"
                  value={draftCadence}
                  onChange={(e) => {
                    setSaveNotice("");
                    setDraftCadence(e.currentTarget.value as WorkflowCadence);
                  }}
                >
                  <option value="manual">Manual</option>
                  <option value="daily">Daily</option>
                  <option value="weekdays">Weekdays</option>
                </select>
              </label>
              <label>
                Time
                <input
                  id="workflow-editor-time"
                  value={draftLocalTime}
                  onChange={(e) => {
                    setSaveNotice("");
                    setDraftLocalTime(e.currentTarget.value);
                  }}
                  placeholder="17:00"
                />
              </label>
              <label>
                Approval mode
                <select
                  id="workflow-editor-approval"
                  value={draftApprovalMode}
                  onChange={(e) => {
                    setSaveNotice("");
                    setDraftApprovalMode(e.currentTarget.value as ApprovalMode);
                  }}
                >
                  <option value="always_review">Always review</option>
                  <option value="review_changes">Review changes only</option>
                  <option value="auto_approve">Auto-approve</option>
                </select>
              </label>
              <div className="workflow-save-row">
                <button
                  className="primary-action"
                  type="button"
                  onClick={saveWorkflowChanges}
                  disabled={isSaving || !hasDraftChanges}
                >
                  <Check size={18} />
                  {isSaving ? "Saving" : "Save changes"}
                </button>
                {saveNotice && <span className="success-note">{saveNotice}</span>}
              </div>
            </div>
          </article>

          <div ref={runReadinessRef} tabIndex={-1}>
            <RunReadinessPanel
              manifest={currentPreflightManifest}
              capabilities={state.capabilityRegistry.capabilities}
              approvalGrants={state.approvalGrants}
              onCreateGrant={actions.createApprovalGrant}
              onCategoryOverrideChange={actions.setAutonomyCategoryOverride}
              onCategoryOverridesChange={actions.setAutonomyCategoryOverrides}
              isLoading={preflightLoading}
            />
          </div>

          <article className="workflow-builder-panel">
            <div className="section-heading">
              <h2>Visual workflow builder</h2>
              <span>Trigger to destination</span>
            </div>
            <WorkflowDag
              workflow={builderWorkflowVersion ?? workflow}
              providers={state.providers}
              llmProfiles={state.llmProfiles}
              agentAuthProfiles={state.agentAuthProfiles}
              runs={workflowRuns}
              artifacts={workflowArtifacts}
              pendingApproval={runStream.pendingApproval}
              activeSteps={runStream.activeSteps}
              onEditField={focusEditorField}
              onOpenSettingsTarget={openSettingsTarget}
              originalDefinition={workflow.definition}
              onChangeDefinition={(definition) => {
                setSaveNotice("");
                setBuilderDefinition(definition);
              }}
              onUndoDefinition={undoBuilderChanges}
              onSaveDefinition={saveWorkflowChanges}
              isSavingDefinition={isSaving}
              saveNotice={saveNotice}
              preflightManifest={currentPreflightManifest}
              capabilities={state.capabilityRegistry.capabilities}
            />
          </article>

          <details>
            <summary>Technical details</summary>
            <dl>
              <dt>Model</dt>
              <dd>{workflow.definition.defaults.llmProfileRef}</dd>
              <dt>Destination</dt>
              <dd>{workflow.definition.defaults.destinationRef}</dd>
              <dt>Permissions</dt>
              <dd>{workflow.definition.permissions.join(", ")}</dd>
            </dl>
            {plannerRationale && (
              <section className="create-hub-planner-coverage" aria-label="Planner coverage">
                <div className="create-hub-planner-header">
                  <h4>Planner coverage</h4>
                  <span>{plannerRationale.operations.length} operations</span>
                </div>
                <div className="create-hub-planner-list">
                  {plannerRationale.operations.map((operation) => {
                    const capability = plannerOperationCapability(operation);
                    const stepId = plannerOperationStep(operation);
                    return (
                      <article className="create-hub-planner-row" key={operation.id}>
                        <div className="create-hub-planner-row-header">
                          <strong>{operation.kind}</strong>
                          <span>{operation.status}</span>
                        </div>
                        <dl>
                          <div>
                            <dt>Capability</dt>
                            <dd>{capability}</dd>
                          </div>
                          <div>
                            <dt>Step</dt>
                            <dd>{stepId || "None"}</dd>
                          </div>
                          <div>
                            <dt>Evidence</dt>
                            <dd>{operation.evidence}</dd>
                          </div>
                        </dl>
                      </article>
                    );
                  })}
                </div>
                {plannerRationale.warnings.length > 0 && (
                  <div className="create-hub-planner-warnings" role="alert">
                    <strong>Warnings</strong>
                    <ul>
                      {plannerRationale.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}
            <div className="step-list">
              {workflow.definition.steps.map((step) => {
                const isAgentTask = step.kind === "agent_task";
                const objective =
                  typeof step.inputs.objective === "string" ? step.inputs.objective : "";
                const allowedTools = arrayFromUnknown(step.inputs.allowed_tools);
                return (
                  <article className="step-card" key={step.id}>
                    <div>
                      <strong>{step.name}</strong>
                      <span>
                        {isAgentTask ? "Ask AI" : `${step.provider}.${step.action}`}
                      </span>
                      {isAgentTask && objective && <span>{objective}</span>}
                      {isAgentTask && allowedTools.length > 0 && (
                        <div className="workflow-meta" aria-label="Allowed tools">
                          {allowedTools.map((tool) => (
                            <div className="status status-available" key={tool}>
                              <span aria-hidden="true" />
                              {tool}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <small>
                      {step.dependsOn.length > 0
                        ? `After ${step.dependsOn.join(", ")}`
                        : "Starts workflow"}
                    </small>
                  </article>
                );
              })}
            </div>
          </details>
        </div>

        {/* Right column: run history + related artifacts */}
        <div className="workflow-definition-panel">
          <section className="workflow-side-section">
            <div className="section-heading">
              <h2>Run trace</h2>
              <span>Active and recent</span>
            </div>
            <TraceTimeline
              runStream={runStream.activeRunId != null ? runStream : undefined}
              runs={workflowRuns}
              approvalAudit={workflowApprovalHistory}
              capabilityAudit={workflowCapabilityAudit}
              workflowSteps={workflow.definition.steps}
              stepRunsByRunId={stepRunsByRunId}
              onRetry={(runId) => actions.retryRun(runId)}
              onRepair={() => setAssistantOpen(true)}
              focusedRunId={selectedRunId}
            />
          </section>

          <section className="workflow-side-section">
            <div className="section-heading">
              <h2>Recent artifacts</h2>
              <span>{workflowArtifacts.length} total</span>
            </div>
            {workflowArtifacts.length === 0 && <p className="empty-state">No artifacts generated yet.</p>}
            <div className="artifact-list">
              {workflowArtifacts.slice(0, 6).map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => openArtifact(artifact.id)}
                >
                  <strong>{artifact.title}</strong>
                  <small>{new Date(artifact.createdAt).toLocaleString()}</small>
                </button>
              ))}
            </div>
          </section>

          <section
            ref={usageFocusRef}
            className={`workflow-side-section ${workflowDetailFocus ? "workflow-detail-focus" : ""}`}
            aria-label="Workflow usage and run history focus"
            tabIndex={-1}
          >
            <div className="section-heading">
              <h2>{workflowDetailFocus ? "Usage and run history" : "Usage"}</h2>
              <span>{workflowDetailFocus ? "Focused from usage" : "This workflow"}</span>
            </div>
            <div className="workflow-usage-grid" aria-label="Workflow usage">
              <div>
                <span>Runs</span>
                <strong>{workflowRuns.length}</strong>
                <small>{latestRun ? `Last ${formatRelativeTime(latestRun.startedAt)}` : "No runs yet"}</small>
              </div>
              <div>
                <span>Tokens</span>
                <strong>{workflowTokensLabel}</strong>
                <small>{tokenUsageNote}</small>
              </div>
              <div>
                <span>Cost</span>
                <strong>{workflowCostLabel}</strong>
                <small>{costUsageNote}</small>
              </div>
              <div>
                <span>Latest duration</span>
                <strong>{latestRun ? formatDuration(latestRun.startedAt, latestRun.completedAt) : "None"}</strong>
                <small>{latestArtifact ? `Latest artifact ${formatRelativeTime(latestArtifact.createdAt)}` : "No artifact"}</small>
              </div>
            </div>
          </section>
        </div>
      </section>
    </section>
  );
}
