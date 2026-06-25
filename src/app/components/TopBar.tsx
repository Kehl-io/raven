import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Search,
  WalletCards,
  SlidersHorizontal,
} from "lucide-react";
import { useUI } from "../contexts";
import { useAppState } from "../contexts";
import { groupProviderProfiles } from "../../domain/format";
import { useRunStream } from "../contexts/RunStreamContext";
import type { ApprovalRequest, SchedulerStatus, SystemHealthDiagnostics, WorkflowRun } from "../../domain/types";
import { buildScheduleEntries, buildUsageSummary } from "../selectors/commandCenter";
import type { CommandCenterScheduleEntry } from "../selectors/commandCenter";
import { TopStatusPopover } from "./TopStatusPopover";
import { loadPersistedSystemHealthDiagnostics, resolveApproval } from "../tauriBridge";
import { USAGE_BUDGET_THRESHOLD_EVENT } from "./UsageCommandPanel";

const viewLabels: Record<string, string> = {
  home: "Command Center",
  artifacts: "Artifacts",
  workflows: "Workflows",
  "workflow-detail": "Workflow",
  marketplace: "Workflows / Templates",
  settings: "Settings",
};

type TopStatusKey = "providers" | "scheduler" | "run" | "approvals" | "usage" | "more";
type StatusVisibility = Record<"providers" | "scheduler" | "run" | "approvals" | "usage", boolean>;

const defaultStatusVisibility: StatusVisibility = {
  providers: true,
  scheduler: true,
  run: true,
  approvals: true,
  usage: true,
};

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function storedUsageBudgetThreshold(): number | null {
  const raw = localStorage.getItem("raven_usage_budget_threshold_usd");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readStatusVisibility(): StatusVisibility {
  try {
    const raw = localStorage.getItem("raven:top-status-visibility");
    if (!raw) return defaultStatusVisibility;
    const parsed = JSON.parse(raw) as Partial<StatusVisibility>;
    return { ...defaultStatusVisibility, ...parsed };
  } catch {
    return defaultStatusVisibility;
  }
}

function formatElapsed(iso: string | undefined): string {
  if (!iso) return "Unknown";
  const elapsedMs = Math.max(0, Date.now() - new Date(iso).getTime());
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDiagnosticTimestamp(iso: string | undefined): string {
  if (!iso) return "Unknown";
  return new Date(iso).toLocaleString("en-US", { timeZone: "UTC" });
}

function healthStatusLabel(status: string): string {
  if (status === "ok") return "System ok";
  if (status === "critical") return "System critical";
  return "System warning";
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function countLabel(count: number, label: string): string {
  return `${count} ${label}`;
}

function settingsTargetId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isApprovalBlockedRun(run: WorkflowRun): boolean {
  return (
    run.status === "blocked" &&
    (run.requiredProviderId === "approval" ||
      run.requiredProfileId?.startsWith("approval") === true ||
      run.blockedReason?.toLowerCase().includes("approval") === true)
  );
}

function sameLocalMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}

function localScheduleWindow(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isDueNowEntry(entry: CommandCenterScheduleEntry, now = new Date()): boolean {
  if (entry.bucket !== "missed" || !entry.displayRunAt) return false;
  return sameLocalMinute(new Date(entry.displayRunAt), now);
}

interface ApprovalStatusItem {
  key: string;
  workflowName: string;
  description: string;
  status: ApprovalRequest["status"] | WorkflowRun["status"];
  riskLevel?: ApprovalRequest["riskLevel"];
  run?: WorkflowRun;
  approvalId?: string;
  source: "live" | "persisted";
}

export function TopBar() {
  const {
    view,
    setView,
    returnFromWorkflowDetail,
    setCommandPaletteOpen,
    setActiveSettingsTab,
    openSettingsTarget,
    setAssistantOpen,
    openWorkflowRun,
    openCommandCenterTarget,
  } = useUI();
  const { state, runNotice, actions } = useAppState();
  const { runStream, clearStream } = useRunStream();
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [openStatus, setOpenStatus] = useState<TopStatusKey | null>(null);
  const [schedulerRunNote, setSchedulerRunNote] = useState("");
  const [healthDiagnostics, setHealthDiagnostics] = useState<SystemHealthDiagnostics | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [usageBudgetThresholdUsd, setUsageBudgetThresholdUsd] = useState(storedUsageBudgetThreshold);
  const [lastRefreshAt, setLastRefreshAt] = useState(() => new Date());
  const [statusVisibility, setStatusVisibility] = useState<StatusVisibility>(readStatusVisibility);

  const unhealthyProviderGroups = groupProviderProfiles(state.agentAuthProfiles).filter((g) => !g.isReady);
  const providerGroups = groupProviderProfiles(state.agentAuthProfiles);
  const readyProviderGroups = providerGroups.filter((g) => g.isReady).length;
  const scheduleEntries = useMemo(() => buildScheduleEntries(state), [state]);
  const usageSummary = useMemo(() => buildUsageSummary(state), [state]);
  const activeRun = runStream.activeRunId
    ? state.runs.find((run) => run.id === runStream.activeRunId)
    : undefined;
  const approvalRun = runStream.pendingApproval
    ? state.runs.find((run) => run.id === runStream.pendingApproval?.runId)
    : undefined;
  const activeRunName = runStream.pendingApproval?.workflowName ?? activeRun?.workflowName ?? "No active run";
  const persistedApprovalRuns = state.runs.filter(isApprovalBlockedRun);
  const approvalItems = useMemo<ApprovalStatusItem[]>(() => {
    const items: ApprovalStatusItem[] = [];
    if (runStream.pendingApproval) {
      items.push({
        key: `live:${runStream.pendingApproval.id || runStream.pendingApproval.runId}`,
        workflowName: runStream.pendingApproval.workflowName,
        description: runStream.pendingApproval.description,
        status: runStream.pendingApproval.status,
        riskLevel: runStream.pendingApproval.riskLevel,
        run: approvalRun,
        approvalId: runStream.pendingApproval.id || undefined,
        source: "live",
      });
    }
    for (const run of persistedApprovalRuns) {
      if (runStream.pendingApproval?.runId === run.id) continue;
      items.push({
        key: `persisted:${run.id}`,
        workflowName: run.workflowName,
        description: run.blockedReason ?? run.setupAction ?? "Approval required before continuing.",
        status: run.status,
        run,
        source: "persisted",
      });
    }
    return items;
  }, [approvalRun, persistedApprovalRuns, runStream.pendingApproval]);
  const pendingApprovalCount = approvalItems.length;
  const dueNowScheduleEntries = schedulerStatus
    ? scheduleEntries.filter((entry) => isDueNowEntry(entry))
    : [];
  const overdueScheduleEntries = schedulerStatus
    ? scheduleEntries.filter((entry) => entry.bucket === "missed" && !isDueNowEntry(entry))
    : [];
  const attentionScheduleEntries = schedulerStatus
    ? scheduleEntries.filter((entry) => entry.bucket === "failed" || entry.bucket === "retryable")
    : [];
  const unavailableScheduleEntries = schedulerStatus
    ? scheduleEntries.filter((entry) => entry.bucket === "unknown")
    : [];
  const nextScheduleEntry = schedulerStatus
    ? scheduleEntries.find((entry) => entry.bucket === "upcoming" || entry.bucket === "running")
    : undefined;
  const topUsageWorkflow = usageSummary.byWorkflow[0];
  const usageOverBudget =
    usageBudgetThresholdUsd != null && usageSummary.totalCostUsd >= usageBudgetThresholdUsd;
  const schedulerIssueCount = (schedulerStatus && !schedulerStatus.running ? 1 : 0) + overdueScheduleEntries.length + attentionScheduleEntries.length;
  const approvalIssueCount = pendingApprovalCount;
  const usageIssueCount = usageOverBudget ? 1 : 0;
  const healthIssueCount = healthDiagnostics?.issueCount ?? 0;
  const showActiveRunStatus = statusVisibility.run && Boolean(runStream.activeRunId);
  const showApprovalStatus = statusVisibility.approvals && pendingApprovalCount > 0;
  const showUsageStatus =
    statusVisibility.usage && (usageSummary.runsWithReportedUsageCount > 0 || usageIssueCount > 0);
  const hiddenDiagnosticIssueCount = healthIssueCount;

  useEffect(() => {
    localStorage.setItem("raven:top-status-visibility", JSON.stringify(statusVisibility));
  }, [statusVisibility]);

  useEffect(() => {
    const refreshUsageBudgetThreshold = () => setUsageBudgetThresholdUsd(storedUsageBudgetThreshold());
    const handleUsageBudgetChange = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      setUsageBudgetThresholdUsd(
        typeof detail === "number" && Number.isFinite(detail) && detail > 0
          ? detail
          : storedUsageBudgetThreshold(),
      );
    };
    window.addEventListener(USAGE_BUDGET_THRESHOLD_EVENT, handleUsageBudgetChange);
    window.addEventListener("storage", refreshUsageBudgetThreshold);
    return () => {
      window.removeEventListener(USAGE_BUDGET_THRESHOLD_EVENT, handleUsageBudgetChange);
      window.removeEventListener("storage", refreshUsageBudgetThreshold);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void actions.loadSchedulerStatus().then((status) => {
      if (mounted && status) {
        setSchedulerStatus(status);
        setLastRefreshAt(new Date());
      }
    });
    return () => {
      mounted = false;
    };
  }, [actions]);

  const refreshHealthDiagnostics = useCallback(async () => {
    setHealthLoading(true);
    const diagnostics = await loadPersistedSystemHealthDiagnostics();
    setHealthDiagnostics(diagnostics);
    setLastRefreshAt(new Date());
    setHealthLoading(false);
  }, []);

  useEffect(() => {
    void refreshHealthDiagnostics();
  }, [refreshHealthDiagnostics]);

  const schedulerLabel = useMemo(() => {
    if (!schedulerStatus) return "Scheduler unavailable";
    return schedulerStatus.running ? `Scheduler running · ${schedulerStatus.pollIntervalSeconds}s` : "Scheduler stopped";
  }, [schedulerStatus]);

  const toggleStatus = (status: TopStatusKey) => {
    setOpenStatus((current) => (current === status ? null : status));
  };

  const openSettingsTab = (tab: string) => {
    setActiveSettingsTab(tab as Parameters<typeof setActiveSettingsTab>[0]);
    setView("settings");
    setOpenStatus(null);
  };

  const openProviderSettings = (groupName: string) => {
    openSettingsTarget("general", {
      type: "provider",
      id: settingsTargetId(groupName),
      label: groupName,
    });
    setOpenStatus(null);
  };

  const openAutomationSettings = () => {
    openSettingsTarget("advanced", { type: "automation", id: "scheduler", label: "Scheduler" });
    setOpenStatus(null);
  };

  const openTarget = (target: "usage" | "schedule") => {
    openCommandCenterTarget(target);
    setOpenStatus(null);
  };

  const openRun = () => {
    if (activeRun) {
      openWorkflowRun(activeRun.workflowId, activeRun.id, view);
      setOpenStatus(null);
      return;
    }
    if (approvalRun) {
      openWorkflowRun(approvalRun.workflowId, approvalRun.id, view);
      setOpenStatus(null);
      return;
    }
    setAssistantOpen(true);
    setOpenStatus(null);
  };

  const openApprovalItem = (item: ApprovalStatusItem) => {
    if (item.run) {
      openWorkflowRun(item.run.workflowId, item.run.id, view);
      setOpenStatus(null);
      return;
    }
    setAssistantOpen(true);
    setOpenStatus(null);
  };

  const resolveLiveApproval = async (item: ApprovalStatusItem, decision: "approved" | "rejected") => {
    if (!item.approvalId) return;
    await resolveApproval(item.approvalId, decision);
    await actions.refreshState();
    clearStream();
    setOpenStatus(null);
  };

  const streamSteps = [...runStream.activeSteps.values()];
  const activeStep = [...streamSteps].reverse().find((step) => step.status === "active")
    ?? streamSteps[streamSteps.length - 1];

  const runDueNow = async () => {
    if (dueNowScheduleEntries.length === 0) {
      setSchedulerRunNote("Run due now unavailable: no schedules are due in the current minute.");
      return;
    }
    setSchedulerRunNote("Checking schedules due now...");
    const scheduleWindow = localScheduleWindow(new Date(dueNowScheduleEntries[0].displayRunAt as string));
    const workflowIds = [...new Set(dueNowScheduleEntries.map((entry) => entry.workflowId))];
    const notice = await actions.runDueSchedules({ scheduleWindow, workflowIds });
    const status = await actions.loadSchedulerStatus();
    if (status) setSchedulerStatus(status);
    setSchedulerRunNote(`Run due now result: ${notice}`);
  };

  const updateStatusVisibility = (key: keyof StatusVisibility, visible: boolean) => {
    setStatusVisibility((current) => ({ ...current, [key]: visible }));
  };

  return (
    <header className="top-bar" role="banner">
      <div className="top-bar-left">
        {view === "workflow-detail" && (
          <button className="icon-button" type="button" aria-label="Back" onClick={returnFromWorkflowDetail}>
            <ArrowLeft size={18} />
          </button>
        )}
        <span className="top-bar-label">{viewLabels[view] ?? "Command Center"}</span>
      </div>
      <div className="top-bar-right">
        <div className="top-bar-status" aria-label="Operational status">
          <span className="top-status-refresh">Last refresh: {lastRefreshAt.toLocaleTimeString()}</span>
          {statusVisibility.providers && <TopStatusPopover
            id="providers"
            title="Provider status"
            buttonLabel={`Provider status: ${readyProviderGroups > 0 ? "Provider ready" : "Provider needed"}`}
            buttonTitle={readyProviderGroups > 0 ? "Provider ready" : "Provider needed"}
            className={readyProviderGroups === 0 ? " needs-attention" : ""}
            icon={readyProviderGroups > 0 ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            summary={readyProviderGroups > 0 ? "Provider ready" : "Provider needed"}
            badgeCount={readyProviderGroups === 0 ? 1 : 0}
            badgeLabel={readyProviderGroups === 0 ? "Provider needed" : ""}
            isOpen={openStatus === "providers"}
            onToggle={() => toggleStatus("providers")}
            onClose={() => setOpenStatus(null)}
          >
            <p>
              {unhealthyProviderGroups.length > 0
                ? `${unhealthyProviderGroups.length} provider group${unhealthyProviderGroups.length === 1 ? "" : "s"} needs attention.`
                : "All configured provider groups are ready."}
            </p>
            <dl className="top-status-detail-list">
              <div>
                <dt>Ready</dt>
                <dd>{readyProviderGroups}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{providerGroups.length}</dd>
              </div>
            </dl>
            {unhealthyProviderGroups.length > 0 && (
              <ul className="top-status-mini-list">
                {unhealthyProviderGroups.slice(0, 3).map((group) => (
                  <li key={group.groupName}>
                    <span>{group.groupName}</span>
                    <button type="button" onClick={() => openProviderSettings(group.groupName)}>
                      Open {group.groupName} settings
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="top-status-actions">
              <button
                type="button"
                onClick={() => openSettingsTab("providers")}
              >
                Open provider settings
              </button>
            </div>
          </TopStatusPopover>}
          {statusVisibility.scheduler && schedulerStatus?.running !== true && <TopStatusPopover
            id="scheduler"
            title="Scheduler status"
            buttonLabel={`Scheduler status: ${schedulerLabel}`}
            buttonTitle={schedulerLabel}
            className={schedulerStatus?.running ? "" : " needs-attention"}
            icon={<CalendarClock size={14} />}
            summary={schedulerStatus?.running ? "Scheduler on" : "Scheduler off"}
            badgeCount={schedulerIssueCount}
            badgeLabel={`Scheduler issues: ${schedulerIssueCount}`}
            isOpen={openStatus === "scheduler"}
            onToggle={() => toggleStatus("scheduler")}
            onClose={() => setOpenStatus(null)}
          >
            <p>{schedulerLabel}</p>
            {schedulerStatus ? (
              <dl className="top-status-detail-list">
                <div>
                  <dt>Due now</dt>
                  <dd>{dueNowScheduleEntries.length}</dd>
                </div>
                <div>
                  <dt>Overdue/Missed</dt>
                  <dd>{overdueScheduleEntries.length}</dd>
                </div>
                <div>
                  <dt>Failed/Retryable</dt>
                  <dd>{attentionScheduleEntries.length}</dd>
                </div>
                <div>
                  <dt>Unavailable</dt>
                  <dd>{unavailableScheduleEntries.length}</dd>
                </div>
                <div>
                  <dt>Next</dt>
                  <dd>{nextScheduleEntry?.workflowName ?? "No upcoming schedule"}</dd>
                </div>
              </dl>
            ) : (
              <p className="top-status-muted">Schedule details unavailable.</p>
            )}
            {schedulerStatus && (
              <ul className="top-status-mini-list" aria-label="Scheduler attention summary">
                {dueNowScheduleEntries.slice(0, 2).map((entry) => (
                  <li key={`due:${entry.workflowId}`}>
                    <span>Due now: {entry.workflowName}</span>
                  </li>
                ))}
                {overdueScheduleEntries.slice(0, 2).map((entry) => (
                  <li key={`overdue:${entry.workflowId}`}>
                    <span>Overdue/Missed: {entry.workflowName}</span>
                  </li>
                ))}
                {attentionScheduleEntries.slice(0, 2).map((entry) => (
                  <li key={`attention:${entry.workflowId}`}>
                    <span>Failed/Retryable: {entry.workflowName}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="top-status-actions">
              <button type="button" onClick={openAutomationSettings}>
                Open scheduler settings
              </button>
              <button type="button" onClick={() => openTarget("schedule")}>
                Open schedule
              </button>
              <button
                type="button"
                disabled={!schedulerStatus || dueNowScheduleEntries.length === 0}
                title={
                  !schedulerStatus
                    ? "Scheduler status is unavailable."
                    : dueNowScheduleEntries.length === 0
                      ? "No schedules are due in the current minute."
                      : "Run schedules due in the current minute."
                }
                onClick={() => void runDueNow()}
              >
                {dueNowScheduleEntries.length > 0 ? "Run due now" : "Run due now unavailable"}
              </button>
            </div>
            {schedulerRunNote && <p className="top-status-muted">{schedulerRunNote}</p>}
            {runNotice && <p className="top-status-muted">{runNotice}</p>}
          </TopStatusPopover>}
          {showActiveRunStatus && <TopStatusPopover
            id="run"
            title="Active run"
            buttonLabel={`Active run status: ${activeRunName}`}
            buttonTitle={activeRunName}
            className={runStream.activeRunId ? " is-active" : ""}
            icon={<Activity size={14} />}
            summary={activeRunName}
            isOpen={openStatus === "run"}
            onToggle={() => toggleStatus("run")}
            onClose={() => setOpenStatus(null)}
          >
            <p>
              {runStream.pendingApproval
                ? `${runStream.pendingApproval.workflowName} is waiting for approval.`
                : activeRun
                  ? `${activeRun.workflowName} is ${activeRun.status}.`
                  : runStream.activeRunId
                    ? "A run is streaming, but persisted run metadata is unavailable. Open the assistant trace to follow live events, then refresh state if the run does not appear."
                    : "No active run is streaming."}
            </p>
            <dl className="top-status-detail-list">
              <div>
                <dt>Elapsed</dt>
                <dd>{formatElapsed(activeRun?.startedAt ?? activeStep?.startedAt)}</dd>
              </div>
              <div>
                <dt>Current step</dt>
                <dd>{activeStep?.stepName || activeStep?.stepId || "No live step"}</dd>
              </div>
              <div>
                <dt>Steps active</dt>
                <dd>{runStream.activeSteps.size}</dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd>{runStream.totalTokens.toLocaleString()}</dd>
              </div>
            </dl>
            <div className="top-status-actions">
              <button type="button" onClick={openRun}>
                Open run details
              </button>
              <button type="button" disabled title="Stop support is not available for persisted runs yet.">
                Stop unavailable
              </button>
            </div>
          </TopStatusPopover>}
          {showApprovalStatus && <TopStatusPopover
            id="approvals"
            title="Approvals"
            buttonLabel={`Approval status: ${pendingApprovalCount > 0 ? `${pendingApprovalCount} pending` : "none pending"}`}
            buttonTitle={pendingApprovalCount > 0 ? `${pendingApprovalCount} approval pending` : "No approvals pending"}
            className={pendingApprovalCount > 0 ? " needs-attention" : ""}
            icon={<Clock3 size={14} />}
            summary={pendingApprovalCount > 0 ? `${pendingApprovalCount} approval` : "No approvals"}
            badgeCount={approvalIssueCount}
            badgeLabel={`Approval issues: ${approvalIssueCount}`}
            isOpen={openStatus === "approvals"}
            onToggle={() => toggleStatus("approvals")}
            onClose={() => setOpenStatus(null)}
          >
            <p>
              {pendingApprovalCount > 0
                ? `${pendingApprovalCount} approval${pendingApprovalCount === 1 ? "" : "s"} waiting for review.`
                : "No approval is currently pending."}
            </p>
            {approvalItems.map((item) => (
              <article className="top-status-approval-card" key={item.key}>
                <header>
                  <strong>{item.workflowName}</strong>
                  <span>{item.source === "live" ? "Live" : "Persisted"}</span>
                </header>
                <p>{item.description}</p>
                <dl className="top-status-approval-meta">
                  <div>
                    <dt>Status</dt>
                    <dd>{item.status}</dd>
                  </div>
                  <div>
                    <dt>Risk</dt>
                    <dd>{item.riskLevel ?? "Unavailable"}</dd>
                  </div>
                </dl>
                <div className="top-status-actions">
                  <button type="button" onClick={() => openApprovalItem(item)}>
                    Open {item.workflowName} approval run
                  </button>
                  <button
                    type="button"
                    disabled={!item.approvalId}
                    title={item.approvalId ? "Approve this live approval." : "Approve from the run or assistant approval card."}
                    aria-label={item.approvalId ? `Approve ${item.workflowName}` : `Approve ${item.workflowName} unavailable`}
                    onClick={() => void resolveLiveApproval(item, "approved")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={!item.approvalId}
                    title={item.approvalId ? "Reject this live approval." : "Reject from the run or assistant approval card."}
                    aria-label={item.approvalId ? `Reject ${item.workflowName}` : `Reject ${item.workflowName} unavailable`}
                    onClick={() => void resolveLiveApproval(item, "rejected")}
                  >
                    Reject
                  </button>
                </div>
                {!item.approvalId && (
                  <p className="top-status-muted">
                    Approval actions are available in the run or assistant approval card.
                  </p>
                )}
              </article>
            ))}
          </TopStatusPopover>}
          {showUsageStatus && <TopStatusPopover
            id="usage"
            title="Usage status"
            buttonLabel={`Usage status: ${usageSummary.runsWithReportedUsageCount} runs reported usage`}
            buttonTitle={`${usageSummary.runsWithReportedUsageCount} runs reported usage`}
            className={usageOverBudget ? " needs-attention" : ""}
            icon={<WalletCards size={14} />}
            summary={usageSummary.runsWithReportedUsageCount > 0 ? formatCurrency(usageSummary.totalCostUsd) : "Usage unavailable"}
            badgeCount={usageIssueCount}
            badgeLabel={`Usage issues: ${usageIssueCount}`}
            isOpen={openStatus === "usage"}
            onToggle={() => toggleStatus("usage")}
            onClose={() => setOpenStatus(null)}
          >
            <p>
              {usageSummary.runsWithReportedUsageCount > 0
                ? `${formatCurrency(usageSummary.totalCostUsd)} reported across ${usageSummary.runsWithReportedUsageCount} run${usageSummary.runsWithReportedUsageCount === 1 ? "" : "s"}.`
                : "Usage appears after runs report cost or token metadata."}
              {" "}
              {usageBudgetThresholdUsd == null
                ? "No local cost threshold is set."
                : usageOverBudget
                  ? `This is at or above the ${formatCurrency(usageBudgetThresholdUsd)} local threshold.`
                  : `Below the ${formatCurrency(usageBudgetThresholdUsd)} local threshold.`}
            </p>
            <dl className="top-status-detail-list">
              <div>
                <dt>Tokens</dt>
                <dd>{usageSummary.totalTokens.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Top driver</dt>
                <dd>{topUsageWorkflow?.workflowName ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Budget</dt>
                <dd>
                  {usageBudgetThresholdUsd == null
                    ? "Not set"
                    : `${formatCurrency(usageBudgetThresholdUsd)} local threshold`}
                </dd>
              </div>
            </dl>
            <div className="top-status-actions">
              <button type="button" onClick={() => openTarget("usage")}>
                Review usage
              </button>
            </div>
          </TopStatusPopover>}
          <TopStatusPopover
            id="more"
            title="More system statuses"
            buttonLabel="More system statuses"
            buttonTitle="More system statuses"
            className={healthIssueCount > 0 ? " needs-attention" : ""}
            icon={<SlidersHorizontal size={14} />}
            summary="More system statuses"
            badgeCount={hiddenDiagnosticIssueCount}
            badgeLabel={`Grouped system status issues: ${hiddenDiagnosticIssueCount}`}
            isOpen={openStatus === "more"}
            onToggle={() => {
              if (openStatus !== "more") void refreshHealthDiagnostics();
              toggleStatus("more");
            }}
            onClose={() => setOpenStatus(null)}
          >
            <section className="top-status-group" aria-label="Grouped system statuses">
              {statusVisibility.run && !showActiveRunStatus && (
                <article>
                  <h3>No active run</h3>
                  <p>No active run is streaming.</p>
                  <dl className="top-status-detail-list">
                    <div>
                      <dt>Elapsed</dt>
                      <dd>{formatElapsed(activeRun?.startedAt ?? activeStep?.startedAt)}</dd>
                    </div>
                    <div>
                      <dt>Current step</dt>
                      <dd>{activeStep?.stepName || activeStep?.stepId || "No live step"}</dd>
                    </div>
                    <div>
                      <dt>Steps active</dt>
                      <dd>{runStream.activeSteps.size}</dd>
                    </div>
                    <div>
                      <dt>Tokens</dt>
                      <dd>{runStream.totalTokens.toLocaleString()}</dd>
                    </div>
                  </dl>
                </article>
              )}
              {statusVisibility.approvals && !showApprovalStatus && (
                <article>
                  <h3>No approvals</h3>
                  <p>No approval is currently pending.</p>
                </article>
              )}
              {statusVisibility.usage && !showUsageStatus && (
                <article>
                  <h3>Usage unavailable</h3>
                  <p>Usage appears after runs report cost or token metadata.</p>
                  <div className="top-status-actions">
                    <button type="button" onClick={() => openTarget("usage")}>
                      Review usage
                    </button>
                  </div>
                </article>
              )}
              <article>
                <h3>Status visibility</h3>
                <p>Choose which status chips can appear directly in the top bar.</p>
                <div className="top-status-toggle-list">
                  {([
                    ["providers", "Show provider status"],
                    ["scheduler", "Show scheduler status"],
                    ["run", "Show active run status"],
                    ["approvals", "Show approvals status"],
                    ["usage", "Show usage status"],
                  ] as const).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={statusVisibility[key]}
                        onChange={(event) => updateStatusVisibility(key, event.currentTarget.checked)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </article>
              <article>
                <h3>System health</h3>
                {healthDiagnostics ? (
                  <>
                    <p>
                      {healthStatusLabel(healthDiagnostics.status)} with {pluralize(healthDiagnostics.issueCount, "issue")}.{" "}
                      Generated {formatDiagnosticTimestamp(healthDiagnostics.generatedAt)} UTC.
                    </p>
                    <dl className="top-status-detail-list">
                      <div>
                        <dt>Scheduler</dt>
                        <dd>
                          {healthDiagnostics.scheduler.running
                            ? `Scheduler running · ${healthDiagnostics.scheduler.pollIntervalSeconds}s`
                            : "Scheduler stopped"}
                        </dd>
                      </div>
                      <div>
                        <dt>Providers</dt>
                        <dd>{healthDiagnostics.providers.available}/{healthDiagnostics.providers.total} ready</dd>
                      </div>
                      <div>
                        <dt>Destinations</dt>
                        <dd>
                          {healthDiagnostics.destinations.ready}/{healthDiagnostics.destinations.total} destinations ready
                        </dd>
                      </div>
                      <div>
                        <dt>Workflows</dt>
                        <dd>
                          {pluralize(healthDiagnostics.workflows.invalid, "invalid workflow")} ·{" "}
                          {pluralize(healthDiagnostics.workflows.blockingIssues, "blocking issue")}
                        </dd>
                      </div>
                      <div>
                        <dt>Runs</dt>
                        <dd>
                          {countLabel(healthDiagnostics.runs.failed, "failed")} ·{" "}
                          {countLabel(healthDiagnostics.runs.retryable, "retryable")} ·{" "}
                          {countLabel(healthDiagnostics.runs.blocked, "blocked")}
                        </dd>
                      </div>
                      <div>
                        <dt>Plugins</dt>
                        <dd>
                          {pluralize(healthDiagnostics.plugins.installed, "plugin")} ·{" "}
                          {pluralize(healthDiagnostics.plugins.availableSteps, "step")}
                        </dd>
                      </div>
                    </dl>
                    <div className="top-status-actions">
                      <button type="button" onClick={() => void refreshHealthDiagnostics()}>
                        Refresh diagnostics
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="top-status-muted">
                    {healthLoading ? "Loading system diagnostics..." : "System diagnostics could not be loaded."}
                  </p>
                )}
              </article>
              <article>
                <h3>Command log</h3>
                <p>Global command log unavailable until commands are recorded in a durable audit trail.</p>
              </article>
            </section>
          </TopStatusPopover>
        </div>
        <button
          className="top-bar-search"
          type="button"
          aria-label="Search (Cmd+K)"
          title="Search (Cmd+K)"
          onClick={() => setCommandPaletteOpen(true)}
        >
          <Search size={16} />
          <span>Search</span>
        </button>
      </div>
    </header>
  );
}
