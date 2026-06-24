import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  LayoutGrid,
  Play,
  Search,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../contexts/AppStateContext";
import { useUI } from "../contexts/UIContext";
import { useRunStream } from "../contexts/RunStreamContext";
import { StatusIndicator } from "../components/StatusIndicator";
import { TraceTimeline } from "../components/TraceTimeline";
import { ScheduleTimelinePanel } from "../components/ScheduleTimelinePanel";
import { UsageCommandPanel } from "../components/UsageCommandPanel";
import { buildCommandCenterPriority, buildLiveApprovalPriority } from "../selectors/commandCenter";
import {
  formatSchedule,
  formatRelativeTime,
  getNextRunTime,
  buildRunWorkflowMap,
  groupProviderProfiles,
} from "../../domain/format";
import type {
  AgentAuthProfile,
  ApprovalMode,
  LlmProfile,
  SchedulerStatus,
  WorkflowRun,
  WorkflowVersion,
} from "../../domain/types";

type CostPeriod = "week" | "month" | "all";

function costPeriodLabel(period: CostPeriod): string {
  if (period === "week") return "This week";
  if (period === "month") return "This month";
  return "All time";
}

function periodCutoff(period: CostPeriod): Date | null {
  const now = new Date();
  if (period === "week") {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 7);
    return cutoff;
  }
  if (period === "month") {
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - 1);
    return cutoff;
  }
  return null;
}

const APPROVAL_MODE_CYCLE: ApprovalMode[] = ["always_review", "review_changes", "auto_approve"];

function nextApprovalMode(current: ApprovalMode): ApprovalMode {
  const idx = APPROVAL_MODE_CYCLE.indexOf(current);
  return APPROVAL_MODE_CYCLE[(idx + 1) % APPROVAL_MODE_CYCLE.length];
}

function approvalModeBadgeClass(mode: ApprovalMode): string {
  if (mode === "auto_approve") return "autonomy-badge autonomy-badge-auto";
  if (mode === "review_changes") return "autonomy-badge autonomy-badge-review";
  return "autonomy-badge autonomy-badge-always";
}

function approvalModeLabel(mode: ApprovalMode): string {
  if (mode === "auto_approve") return "Auto";
  if (mode === "review_changes") return "Review";
  return "Always Review";
}

function formatNextRunCountdown(time: Date): string {
  const diffMs = time.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 60) return `in ${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `in ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `in ${diffDays}d`;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function destinationLabel(destination: string): string {
  return destination.replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function priorityStatusLabel(title: string, severity: "critical" | "attention" | "normal"): string {
  if (title === "All clear") return "All clear";
  if (severity === "critical") return "Needs attention";
  return "Action available";
}

function priorityToneClass(title: string, severity: "critical" | "attention" | "normal"): string {
  if (title === "All clear") return "is-clear";
  if (severity === "critical") return "is-critical";
  if (title === "Schedule overdue" || title === "Workflow blocked") return "is-warning";
  return "is-actionable";
}

function runStatusTone(status: WorkflowRun["status"]): string {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "running") return "active";
  if (status === "blocked" || status === "retryable") return "warning";
  return "muted";
}

function workflowProviderSummary(
  workflow: WorkflowVersion,
  llmProfiles: LlmProfile[],
  agentProfiles: AgentAuthProfile[],
): string {
  const profileRef = workflow.definition.defaults.llmProfileRef;
  const agentProfile = agentProfiles.find((profile) => profile.id === profileRef);
  if (agentProfile) return `${agentProfile.displayName} · ${agentProfile.model}`;

  const llmProfile = llmProfiles.find((profile) => profile.id === profileRef);
  if (llmProfile) return `${llmProfile.providerId} · ${llmProfile.model}`;

  const agentStep = workflow.definition.steps.find((step) => step.kind === "agent_task");
  if (agentStep?.llmProfileRef) {
    const stepAgentProfile = agentProfiles.find((profile) => profile.id === agentStep.llmProfileRef);
    if (stepAgentProfile) return `${stepAgentProfile.displayName} · ${stepAgentProfile.model}`;
  }

  return profileRef || "Provider not set";
}

export function HomeView() {
  const {
    state,
    runNotice,
    hasCompletedSetup,
    hasSkippedSetup,
    postOnboardingLandingPending,
    actions,
  } = useAppState();
  const {
    setAssistantOpen,
    openCreateWorkflowHub,
    openWorkflow,
    openArtifact,
    setView,
    setCommandPaletteOpen,
    setActiveSettingsTab,
    commandCenterTarget,
    openCommandCenterTarget,
  } = useUI();
  const { runStream, startStreamedRun } = useRunStream();

  const { workflows, artifacts, runs, llmProfiles, agentAuthProfiles } = state;
  const usagePanelRef = useRef<HTMLElement | null>(null);
  const schedulePanelRef = useRef<HTMLElement | null>(null);

  const [dismissedRunIds, setDismissedRunIds] = useState<Set<string>>(new Set());
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [postOnboardingLandingSnapshot, setPostOnboardingLandingSnapshot] = useState(
    () => postOnboardingLandingPending,
  );

  const [costPeriod] = useState<CostPeriod>(
    () => (localStorage.getItem("raven_cost_period") as CostPeriod) || "week",
  );

  useEffect(() => {
    const targetRef =
      commandCenterTarget === "usage"
        ? usagePanelRef
        : commandCenterTarget === "schedule"
          ? schedulePanelRef
          : null;
    const target = targetRef?.current;
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.focus({ preventScroll: true });
  }, [commandCenterTarget]);

  useEffect(() => {
    let cancelled = false;
    void actions.loadSchedulerStatus().then((status) => {
      if (!cancelled) setSchedulerStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [actions]);

  useEffect(() => {
    if (!postOnboardingLandingPending) return;
    setPostOnboardingLandingSnapshot(true);
    actions.consumePostOnboardingLanding();
  }, [actions, postOnboardingLandingPending]);

  const failedRuns = useMemo(
    () => runs.filter((run) => ["failed", "retryable", "blocked"].includes(run.status) && !dismissedRunIds.has(run.id)),
    [runs, dismissedRunIds],
  );

  const runsThisWeek = useMemo(() => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return runs.filter((run) => new Date(run.startedAt) >= sevenDaysAgo);
  }, [runs]);

  const todayArtifacts = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return artifacts.filter((a) => new Date(a.createdAt) >= todayStart);
  }, [artifacts]);

  const runWorkflowMap = useMemo(() => buildRunWorkflowMap(runs), [runs]);

  const artifactCountByWorkflow = useMemo(() => {
    const counts = new Map<string, number>();
    for (const artifact of artifacts) {
      const wfId = runWorkflowMap.get(artifact.workflowRunId);
      if (wfId) {
        counts.set(wfId, (counts.get(wfId) ?? 0) + 1);
      }
    }
    return counts;
  }, [artifacts, runWorkflowMap]);

  const latestRunByWorkflow = useMemo(() => {
    const map = new Map<string, (typeof runs)[0]>();
    const sorted = [...runs].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    for (const run of sorted) {
      if (!map.has(run.workflowId)) {
        map.set(run.workflowId, run);
      }
    }
    return map;
  }, [runs]);

  const nextRun = useMemo(() => {
    let earliest: { time: Date; workflowName: string } | null = null;
    for (const wf of workflows) {
      if (wf.status !== "enabled") continue;
      const isoTime = getNextRunTime(wf.definition.schedule);
      if (!isoTime) continue;
      const t = new Date(isoTime);
      if (!earliest || t < earliest.time) {
        earliest = { time: t, workflowName: wf.definition.name };
      }
    }
    return earliest;
  }, [workflows]);

  const weekCostMetric = useMemo(() => {
    const cutoff = periodCutoff("week");
    const filtered = cutoff
      ? runs.filter((r) => new Date(r.startedAt) >= cutoff)
      : runs;
    const totalCost = filtered.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0);
    const totalTokens = filtered.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
    return { totalCost, totalTokens };
  }, [runs]);

  const usageRuns = useMemo(() => {
    const cutoff = periodCutoff(costPeriod);
    return cutoff ? runs.filter((r) => new Date(r.startedAt) >= cutoff) : runs;
  }, [runs, costPeriod]);

  const workflowCostById = useMemo(() => {
    const totals = new Map<string, number>();
    for (const run of usageRuns) {
      totals.set(run.workflowId, (totals.get(run.workflowId) ?? 0) + (run.totalCostUsd ?? 0));
    }
    return totals;
  }, [usageRuns]);

  const providerGroups = useMemo(() => groupProviderProfiles(agentAuthProfiles), [agentAuthProfiles]);
  const readyProviderGroups = providerGroups.filter((group) => group.isReady).length;
  const hasAnyProvider = readyProviderGroups > 0;
  const providerStatusLabel = providerGroups.length > 0
    ? `${readyProviderGroups}/${providerGroups.length} provider groups ready`
    : "Provider readiness unavailable";
  const providerNeedsAttention = providerGroups.some((group) => !group.isReady);
  const activeRun = runStream.activeRunId
    ? runs.find((run) => run.id === runStream.activeRunId)
    : undefined;
  const activeRunName = runStream.pendingApproval?.workflowName
    ?? activeRun?.workflowName
    ?? "No active run";
  const pendingApprovalCount = runStream.pendingApproval ? 1 : 0;

  const latestRuns = useMemo(
    () =>
      [...runs]
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
        .slice(0, 10),
    [runs],
  );

  const latestArtifacts = useMemo(
    () =>
      [...artifacts]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 4),
    [artifacts],
  );

  const { enabledCount, draftCount } = useMemo(() => ({
    enabledCount: workflows.filter((w) => w.status === "enabled").length,
    draftCount: workflows.filter((w) => w.status === "draft").length,
  }), [workflows]);
  const succeededThisWeek = runsThisWeek.filter((r) => r.status === "succeeded").length;
  const failedThisWeek = runsThisWeek.filter((r) => r.status === "failed").length;

  const lastRun = latestRuns[0];
  const subtitleParts: string[] = [];
  if (enabledCount > 0) subtitleParts.push(`${enabledCount} workflow${enabledCount !== 1 ? "s" : ""} active`);
  if (lastRun) subtitleParts.push(`last run ${formatRelativeTime(lastRun.startedAt)}`);

  const attentionRuns = useMemo(() => {
    const seen = new Set<string>();
    return failedRuns.filter((r) => {
      if (seen.has(r.workflowId)) return false;
      seen.add(r.workflowId);
      return true;
    });
  }, [failedRuns]);
  const attentionExtra = Math.max(0, attentionRuns.length - 3);
  const baseCommandPriority = useMemo(
    () => buildCommandCenterPriority(state, new Date(), [], {
      hasCompletedSetup,
      hasSkippedSetup,
      postOnboardingLandingPending: postOnboardingLandingSnapshot,
    }),
    [hasCompletedSetup, hasSkippedSetup, postOnboardingLandingSnapshot, state],
  );
  const commandPriority = useMemo(
    () => buildLiveApprovalPriority(state, {
      basePriority: baseCommandPriority,
      pendingApproval: runStream.pendingApproval,
    }),
    [baseCommandPriority, runStream.pendingApproval, state],
  );
  const secondaryPriorityAction = commandPriority.secondaryAction;
  const hasCriticalMobileStatus =
    providerNeedsAttention
    || !schedulerStatus?.running
    || runStream.activeRunId != null
    || pendingApprovalCount > 0;

  const handlePriorityAction = useCallback(
    (target: "overview" | "usage" | "schedule" | "providers" | "settings" | "workflow", workflowId?: string) => {
      if (target === "workflow") {
        if (workflowId) {
          openWorkflow(workflowId, "home");
        } else {
          setAssistantOpen(true);
        }
        return;
      }
      if (target === "providers") {
        setActiveSettingsTab("providers");
        setView("settings");
        return;
      }
      if (target === "settings") {
        setView("settings");
        return;
      }
      if (target === "usage" || target === "schedule" || target === "overview") {
        openCommandCenterTarget(target === "overview" ? "overview" : target);
      }
    },
    [openCommandCenterTarget, openWorkflow, setActiveSettingsTab, setAssistantOpen, setView],
  );

  return (
    <section className="view-grid home-view">
      <header className="page-header">
        <div>
          <h1>Command Center</h1>
          {subtitleParts.length > 0 && (
            <p className="dashboard-subtitle">{subtitleParts.join(" · ")}</p>
          )}
        </div>
        <button className="primary-action" type="button" onClick={() => openCreateWorkflowHub()}>
          <Sparkles size={18} />
          Create workflow
        </button>
        {runNotice && <span className="success-note">{runNotice}</span>}
      </header>

      <section
        className={`command-center-priority ${priorityToneClass(commandPriority.title, commandPriority.severity)}`}
        aria-label="Now and next summary"
      >
        <div className="command-center-priority-copy">
          <span className="command-center-priority-label">
            {priorityStatusLabel(commandPriority.title, commandPriority.severity)}
          </span>
          <h2>{commandPriority.title}</h2>
          <p>{commandPriority.body}</p>
        </div>
        <div className="command-center-priority-actions">
          <button
            className="primary-action"
            type="button"
            onClick={() => handlePriorityAction(
              commandPriority.primaryAction.target,
              commandPriority.primaryAction.workflowId,
            )}
          >
            {commandPriority.primaryAction.label}
          </button>
          {secondaryPriorityAction && (
            <button
              type="button"
              onClick={() => handlePriorityAction(
                secondaryPriorityAction.target,
                secondaryPriorityAction.workflowId,
              )}
            >
              {secondaryPriorityAction.label}
            </button>
          )}
        </div>
      </section>

      <div
        className={`operational-status-strip ${hasCriticalMobileStatus ? "has-mobile-critical" : "is-mobile-empty"}`}
        aria-label="Operational status"
      >
        <button
          type="button"
          className={`status-strip-item ${providerNeedsAttention ? "needs-attention is-mobile-critical" : ""}`}
          onClick={() => {
            setActiveSettingsTab("providers");
            setView("settings");
          }}
        >
          {providerNeedsAttention ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>Providers</span>
          <strong>{providerStatusLabel}</strong>
        </button>
        <button
          type="button"
          className={`status-strip-item ${schedulerStatus?.running ? "" : "needs-attention is-mobile-critical"}`}
          onClick={() => {
            setActiveSettingsTab("automation");
            setView("settings");
          }}
        >
          <CalendarClock size={15} />
          <span>Scheduler</span>
          <strong>
            {schedulerStatus
              ? schedulerStatus.running
                ? `Running · ${schedulerStatus.pollIntervalSeconds}s`
                : "Stopped"
              : "Unavailable"}
          </strong>
        </button>
        <button
          type="button"
          className={`status-strip-item ${runStream.activeRunId ? "is-active is-mobile-critical" : ""}`}
          onClick={() => {
            if (activeRun) {
              openWorkflow(activeRun.workflowId, "home");
            } else if (runStream.activeRunId) {
              setAssistantOpen(true);
            }
          }}
        >
          <Activity size={15} />
          <span>Active run</span>
          <strong>{activeRunName}</strong>
        </button>
        <button
          type="button"
          className={`status-strip-item ${pendingApprovalCount > 0 ? "needs-attention is-mobile-critical" : ""}`}
          onClick={() => setAssistantOpen(true)}
        >
          <Clock3 size={15} />
          <span>Approvals</span>
          <strong>{pendingApprovalCount > 0 ? `${pendingApprovalCount} pending` : "None pending"}</strong>
        </button>
        <button
          type="button"
          className="status-strip-item command-search"
          onClick={() => setCommandPaletteOpen(true)}
        >
          <Search size={15} />
          <span>Command</span>
          <strong>Search · Cmd+K</strong>
        </button>
      </div>

      {(failedRuns.length > 0 || runStream.pendingApproval != null) && (
        <div className="attention-banner" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            {runStream.pendingApproval != null && (
              <>
                {runStream.pendingApproval.workflowName} paused — waiting for approval
                {" "}
                <button
                  type="button"
                  className="attention-banner-link"
                  onClick={() => setAssistantOpen(true)}
                >
                  Review
                </button>
                {failedRuns.length > 0 && " · "}
              </>
            )}
            {failedRuns.length > 0 && (
              <>
                {failedRuns.length} run{failedRuns.length !== 1 ? "s" : ""} need attention:{" "}
                {attentionRuns.slice(0, 3).map((run, i) => (
                  <span key={run.id}>
                    {i > 0 && ", "}
                    <button
                      type="button"
                      className="attention-banner-link"
                      onClick={() => openWorkflow(run.workflowId, "home")}
                    >
                      {run.workflowName}
                    </button>
                  </span>
                ))}
                {attentionExtra > 0 && (
                  <>
                    {", "}
                    <button
                      type="button"
                      className="attention-banner-link"
                      onClick={() => setView("workflows")}
                    >
                      +{attentionExtra} more
                    </button>
                  </>
                )}
                {" "}
                <button
                  type="button"
                  className="attention-banner-link"
                  onClick={() => {
                    setDismissedRunIds((prev) => {
                      const next = new Set(prev);
                      for (const run of attentionRuns) next.add(run.id);
                      return next;
                    });
                  }}
                >
                  Dismiss
                </button>
              </>
            )}
          </span>
        </div>
      )}

      {hasSkippedSetup && (
        <section className="onboarding-resume-card" aria-label="Onboarding checklist">
          <div>
            <p className="eyebrow">Onboarding skipped</p>
            <h2>Finish the setup checklist</h2>
            <p>Resume anytime to connect providers, choose context, set output defaults, and save a first workflow.</p>
          </div>
          <ul>
            <li className={hasAnyProvider ? "complete" : undefined}>
              <CheckCircle2 size={14} aria-hidden="true" />
              Provider {hasAnyProvider ? "ready" : "needs setup"}
            </li>
            <li>
              <CheckCircle2 size={14} aria-hidden="true" />
              Local git context ready
            </li>
            <li className={workflows.length > 0 ? "complete" : undefined}>
              <CheckCircle2 size={14} aria-hidden="true" />
              First workflow {workflows.length > 0 ? "available" : "not selected"}
            </li>
          </ul>
          <button className="primary-action" type="button" onClick={actions.resumeSetup}>
            Resume setup
          </button>
        </section>
      )}

      <div className="metric-strip command-center-usage-summary">
        <div className="metric">
          <span>Active Workflows</span>
          <strong>{enabledCount}</strong>
          <span>{enabledCount} enabled · {draftCount} draft</span>
        </div>
        <div className={`metric ${failedThisWeek > 0 ? "metric-danger" : ""}`}>
          <span>Runs This Week</span>
          <strong>{runsThisWeek.length}</strong>
          <span>
            {succeededThisWeek} succeeded ·{" "}
            <span style={{ color: failedThisWeek > 0 ? "var(--danger)" : undefined }}>
              {failedThisWeek} failed
            </span>
          </span>
        </div>
        <div className="metric">
          <span>Artifacts</span>
          <strong>{artifacts.length}</strong>
          <span>{todayArtifacts.length} new today</span>
        </div>
        <div className="metric">
          <span>Next Run</span>
          <strong>{nextRun ? formatNextRunCountdown(nextRun.time) : "—"}</strong>
          <span>{nextRun ? nextRun.workflowName : "No scheduled runs"}</span>
        </div>
        <div className="metric">
          <span>Cost This Week</span>
          <strong>{formatCurrency(weekCostMetric.totalCost)}</strong>
          <span>{weekCostMetric.totalTokens.toLocaleString()} tokens</span>
        </div>
      </div>

      <div className="workflow-roster">
        {workflows.length === 0 && (
          <div className="workflow-roster-empty">
            <p>No workflows yet. Create your first one!</p>
            <button className="primary-action" type="button" onClick={() => openCreateWorkflowHub()}>
              <Sparkles size={18} /> Create workflow
            </button>
            <button type="button" onClick={() => setView("marketplace")}>
              <LayoutGrid size={18} /> Browse templates
            </button>
          </div>
        )}
        {workflows.map((workflow) => {
          const lastWfRun = latestRunByWorkflow.get(workflow.workflowId);
          const artifactCount = artifactCountByWorkflow.get(workflow.workflowId) ?? 0;
          const nextIso = getNextRunTime(workflow.definition.schedule);
          const isRunning = lastWfRun?.status === "running";
          const workflowRuns = runs
            .filter((run) => run.workflowId === workflow.workflowId)
            .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
            .slice(0, 5);
          const periodCost = workflowCostById.get(workflow.workflowId) ?? 0;
          const providerSummary = workflowProviderSummary(workflow, llmProfiles, agentAuthProfiles);

          return (
            <article
              key={workflow.id}
              className="workflow-roster-card"
            >
              <div className="workflow-roster-card-header">
                <span
                  className={`status-dot status-dot-${workflow.status}${isRunning ? " status-dot-pulse" : ""}`}
                  aria-hidden="true"
                />
                <strong>{workflow.definition.name}</strong>
                <StatusIndicator status={workflow.status} />
              </div>

              <div className="workflow-health-grid">
                <div>
                  <span>Last run</span>
                  <strong>
                    {lastWfRun ? `${lastWfRun.status} · ${formatRelativeTime(lastWfRun.startedAt)}` : "No runs yet"}
                  </strong>
                </div>
                <div>
                  <span>Next run</span>
                  <strong>{nextIso ? formatNextRunCountdown(new Date(nextIso)) : "Manual"}</strong>
                </div>
                <div>
                  <span>Artifacts</span>
                  <strong>{artifactCount}</strong>
                </div>
                <div>
                  <span>{costPeriodLabel(costPeriod)} cost</span>
                  <strong>{formatCurrency(periodCost)}</strong>
                </div>
              </div>

              <div
                className="workflow-health-dots"
                aria-label={`${workflow.definition.name} recent run health`}
              >
                {(workflowRuns.length > 0 ? workflowRuns : [null, null, null, null, null]).map((run, index) => (
                  <span
                    key={run?.id ?? `empty-${index}`}
                    className={`health-dot ${run ? `health-${runStatusTone(run.status)}` : "health-empty"}`}
                    title={run ? `${run.status} ${formatRelativeTime(run.startedAt)}` : "No run recorded"}
                  />
                ))}
              </div>

              <dl className="workflow-operational-meta">
                <div>
                  <dt>Schedule</dt>
                  <dd>{formatSchedule(workflow.definition.schedule)}</dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>{providerSummary}</dd>
                </div>
                <div>
                  <dt>Approval</dt>
                  <dd>{approvalModeLabel(workflow.approvalMode)}</dd>
                </div>
                <div>
                  <dt>Destination</dt>
                  <dd>{destinationLabel(workflow.definition.defaults.destinationRef)}</dd>
                </div>
              </dl>

              <div className="workflow-roster-actions">
                <button
                  type="button"
                  onClick={() => openWorkflow(workflow.workflowId, "home")}
                  aria-label={`Open ${workflow.definition.name} details`}
                >
                  Open details
                </button>
                <button
                  type="button"
                  className={approvalModeBadgeClass(workflow.approvalMode)}
                  aria-label={`Approval mode: ${approvalModeLabel(workflow.approvalMode)}. Click to cycle.`}
                  onClick={() => {
                    const next = nextApprovalMode(workflow.approvalMode);
                    void actions.updateWorkflowSafeFields(workflow.workflowId, {
                      status: workflow.status,
                      cadence: workflow.definition.schedule?.cadence ?? "manual",
                      localTime: workflow.definition.schedule?.localTime,
                      approvalMode: next,
                    });
                  }}
                >
                  {approvalModeLabel(workflow.approvalMode)}
                </button>
                {workflow.status === "enabled" && (
                  <button
                    type="button"
                    className="primary-action"
                    aria-label={
                      runStream.activeRunId != null
                        ? `Running ${workflow.definition.name}`
                        : `Run now for ${workflow.definition.name}`
                    }
                    disabled={runStream.activeRunId != null}
                    onClick={() => {
                      void startStreamedRun(workflow.workflowId).then((result) => {
                        if (result) actions.applyRunResults([result]);
                      });
                    }}
                  >
                    {runStream.activeRunId != null ? "Running..." : (
                      <><Play size={14} /> Run now</>
                    )}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <div className="command-center-ops-row">
        <div className="command-center-ops-section command-center-schedule-section">
          <ScheduleTimelinePanel
            ref={schedulePanelRef}
            state={state}
            schedulerStatus={schedulerStatus}
            runNotice={runNotice}
            isTargeted={commandCenterTarget === "schedule"}
            onOpenWorkflow={(workflowId) => openWorkflow(workflowId, "home")}
            onRunWorkflow={(workflowId) => void actions.runWorkflow(workflowId)}
            onRetryRun={(runId) => void actions.retryRun(runId)}
            onRunDueSchedules={() => void actions.runDueSchedules()}
            onUpdateWorkflowSafeFields={(workflowId, fields) => {
              void actions.updateWorkflowSafeFields(workflowId, fields);
            }}
            onAssignScheduleOverride={(workflowId, originalRunAt, scheduledRunAt) => {
              void actions.assignScheduleOverride(workflowId, originalRunAt, scheduledRunAt);
            }}
          />
        </div>
        <div className="command-center-ops-section command-center-usage-section">
          <UsageCommandPanel
            ref={usagePanelRef}
            state={state}
            isTargeted={commandCenterTarget === "usage"}
            onOpenWorkflow={(workflowId) => openWorkflow(workflowId, "home", "usage")}
          />
        </div>
      </div>

      <div className="feed-artifacts-split">
        <section className="activity-feed" aria-label="Activity feed">
          <h2>Recent Activity</h2>
          <div className="activity-list">
            {runStream.activeRunId && (
              <div className="activity-entry" role="status" aria-label="Running workflow">
                <span className="status-dot dot-running" aria-hidden="true" />
                <div>
                  <strong>Running...</strong>
                  <small>Workflow in progress</small>
                </div>
                <time />
              </div>
            )}
            {(() => {
            const activeStreamWorkflowId = runStream.activeRunId
              ? latestRuns.find((r) => r.id === runStream.activeRunId)?.workflowId
              : undefined;
            return latestRuns.map((run) => {
              const isActiveStream = run.workflowId === activeStreamWorkflowId;
              return (
                <div key={run.id}>
                  <div
                    className="activity-entry"
                    role="button"
                    tabIndex={0}
                    aria-label={run.workflowName}
                    onClick={() => openWorkflow(run.workflowId, "home")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openWorkflow(run.workflowId, "home");
                      }
                    }}
                  >
                    <span
                      className={`status-dot status-dot-${run.status}${isActiveStream ? " dot-running" : ""}`}
                      aria-hidden="true"
                    />
                    <strong>{run.workflowName}</strong>
                    <span className="activity-entry-time">{formatRelativeTime(run.startedAt)}</span>
                    <span className="activity-entry-summary">
                      {run.failureReason ?? run.blockedReason ?? run.setupAction ?? run.status}
                    </span>
                  </div>
                  {isActiveStream && (
                    <TraceTimeline runStream={runStream} />
                  )}
                </div>
              );
            });
          })()}
            {latestRuns.length === 0 && !runStream.activeRunId && (
              <p className="empty-state">No runs yet. Run a workflow to see activity here.</p>
            )}
          </div>
        </section>

        <section aria-label="Recent artifacts">
          <h2>Recent Artifacts</h2>
          <div className="artifact-cards">
            {latestArtifacts.map((artifact) => {
              const preview = artifact.contentMarkdown
                .split("\n")
                .filter((line) => line.trim() && !line.startsWith("#"))
                .slice(0, 3)
                .join(" ")
                .slice(0, 120);
              const sourceWfId = runWorkflowMap.get(artifact.workflowRunId);
              const sourceWf = workflows.find((w) => w.workflowId === sourceWfId);

              return (
                <div
                  key={artifact.id}
                  className="artifact-card"
                  role="button"
                  tabIndex={0}
                  aria-label={artifact.title}
                  onClick={() => openArtifact(artifact.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openArtifact(artifact.id);
                    }
                  }}
                >
                  <div className="artifact-card-header">
                    <span className="artifact-type">{artifact.type.replace(/_/g, " ")}</span>
                    <strong>{artifact.title}</strong>
                  </div>
                  <p className="artifact-preview">{preview}</p>
                  <p className="artifact-card-meta">
                    {sourceWf ? sourceWf.definition.name : "Unknown workflow"} ·{" "}
                    {formatRelativeTime(artifact.createdAt)}
                  </p>
                </div>
              );
            })}
            {latestArtifacts.length === 0 && (
              <p className="empty-state">No artifacts yet. Run a workflow to generate output.</p>
            )}
          </div>
          {artifacts.length > 4 && (
            <button
              type="button"
              className="view-all-link"
              onClick={() => setView("artifacts")}
            >
              View all in Artifacts
            </button>
          )}
        </section>
      </div>
    </section>
  );
}
