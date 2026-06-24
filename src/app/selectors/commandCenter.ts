import { formatSchedule } from "../../domain/format";
import { isDeterministicProviderAction, validateWorkflowDefinition } from "../../domain/workflow";
import type {
  AgentAuthProfile,
  ApprovalRequest,
  AppState,
  Artifact,
  CommandCenterTarget,
  LlmProfile,
  PluginManifest,
  ProviderHealth,
  RavenWorkflow,
  RunState,
  ViewName,
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowVersion,
} from "../../domain/types";

export const COMMAND_CENTER_TARGETS = ["overview", "usage", "schedule"] as const satisfies readonly CommandCenterTarget[];

export type WorkflowOperationalStatus =
  | "enabled"
  | "draft"
  | "paused"
  | "blocked"
  | "failed-retryable"
  | "needs-setup";

export type WorkflowHealthStatus = "healthy" | "warning" | "critical" | "inactive";

export type ProviderReadinessStatus = "ready" | "degraded" | "needs-setup" | "missing";

export interface ProviderReadiness {
  status: ProviderReadinessStatus;
  profileId: string;
  providerId?: string;
  providerName?: string;
  model?: string;
  issues: string[];
}

export type ScheduleBucket =
  | "manual"
  | "upcoming"
  | "running"
  | "completed"
  | "missed"
  | "failed"
  | "retryable"
  | "paused"
  | "unknown";

export interface CommandCenterScheduleEntry {
  workflowId: string;
  workflowName: string;
  bucket: ScheduleBucket;
  status: WorkflowOperationalStatus;
  scheduleLabel: string;
  cadence: NonNullable<RavenWorkflow["schedule"]>["cadence"] | "unknown";
  nextRunAt: string | null;
  displayRunAt: string | null;
  occurrenceKey: string | null;
  lastRunId: string | null;
  lastRunStatus: RunState | null;
  reason: string | null;
}

export interface UsageTokenSplitAvailable {
  status: "available";
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTokenSplitUnavailable {
  status: "unavailable";
  totalTokens: number;
  runsMissingSplitCount: number;
  runsWithSplitCount: number;
}

export type UsageTokenSplit = UsageTokenSplitAvailable | UsageTokenSplitUnavailable;

export interface WorkflowUsageSummary {
  workflowId: string;
  workflowName: string;
  totalCostUsd: number;
  unknownCostRunCount: number;
  reportedCostRunCount: number;
  totalTokens: number;
  runCount: number;
}

export interface ProviderModelUsageSummary {
  providerId: string;
  providerName: string;
  profileId: string;
  model: string;
  totalCostUsd: number;
  unknownCostRunCount: number;
  totalTokens: number;
  runCount: number;
}

export interface UsageSummary {
  totalCostUsd: number;
  totalTokens: number;
  reportedCostRunCount: number;
  unknownCostRunCount: number;
  runsWithReportedUsageCount: number;
  averageCostPerReportedRunUsd: number | null;
  tokenSplit: UsageTokenSplit;
  byWorkflow: WorkflowUsageSummary[];
  byProviderModel: ProviderModelUsageSummary[];
}

export type UsagePeriod = "today" | "7d" | "30d" | "mtd" | "all";

export interface DailyUsageCostBucket {
  isoDate: string;
  label: string;
  totalCostUsd: number;
  unknownCostRunCount: number;
  runCount: number;
}

export interface UsageBudgetSummary {
  status: "not-set" | "ok" | "danger";
  label: string;
  thresholdUsd: number | null;
  totalCostUsd: number;
  percentUsed: number | null;
}

export interface UsageCommandPanelModel {
  period: UsagePeriod;
  label: string;
  runs: WorkflowRun[];
  summary: UsageSummary;
  dailyCost: DailyUsageCostBucket[];
  budget: UsageBudgetSummary;
  chartState: UsageVisualizationStates;
}

export interface UsageCommandPanelOptions {
  budgetThresholdUsd?: number | null;
}

export type UsageVisualizationState = "ready" | "empty" | "partial" | "unavailable";

export interface UsageVisualizationNextAction {
  kind: "open-workflow-usage" | "change-period";
  label: string;
  workflowId?: string;
  period?: UsagePeriod;
}

export interface UsageVisualizationStatus {
  state: UsageVisualizationState;
  reason: string | null;
  nextAction: UsageVisualizationNextAction | null;
  confidenceLabel: string | null;
}

export interface UsageVisualizationStates {
  dailyCost: UsageVisualizationStatus;
  tokenSplit: UsageVisualizationStatus;
  providerBreakdown: UsageVisualizationStatus;
  forecast: UsageVisualizationStatus;
}

export interface ScheduleTimelineDay {
  isoDate: string;
  label: string;
  entries: CommandCenterScheduleEntry[];
}

export interface ScheduleTimelineModel {
  timezone: string;
  todayEntries: CommandCenterScheduleEntry[];
  nextSevenDays: ScheduleTimelineDay[];
  manualEntries: CommandCenterScheduleEntry[];
  primaryAction: SchedulePrimaryAction;
}

export interface SchedulePrimaryAction {
  label: "Run due schedules" | "No schedules due" | "Scheduler unavailable";
  disabled: boolean;
  reason: string;
  dueCount: number;
}

export interface CommandCenterBreadcrumbSegment {
  label: string;
  target: CommandCenterTarget;
  current: boolean;
}

export interface CommandCenterPriority {
  severity: "critical" | "attention" | "normal";
  title: string;
  body: string;
  primaryAction: {
    label: string;
    target: CommandCenterTarget | "providers" | "workflow";
    workflowId?: string;
  };
  secondaryAction?: {
    label: string;
    target: CommandCenterTarget | "settings" | "workflow";
    workflowId?: string;
  };
}

export interface CommandCenterPriorityOptions {
  hasCompletedSetup?: boolean;
  hasSkippedSetup?: boolean;
  postOnboardingLandingPending?: boolean;
}

export interface LiveApprovalPriorityOptions {
  basePriority: CommandCenterPriority;
  pendingApproval: ApprovalRequest | null;
}

export type AssistantSuggestionType = "navigate" | "repair" | "configure" | "run" | "explain";
export type AssistantSuggestionPriority = "high" | "medium" | "low";
export type AssistantSuggestionSurface = ViewName | "command-center";

export interface AssistantSuggestion {
  label: string;
  type: AssistantSuggestionType;
  priority: AssistantSuggestionPriority;
  surface: AssistantSuggestionSurface;
  action: {
    kind: string;
    payload: Record<string, unknown>;
  };
}

export interface AssistantSelectedContext {
  selectedWorkflowId?: string;
  selectedArtifactId?: string;
  selectedRunId?: string;
  activeSettingsTab?: string;
}

type RunWithTokenSplit = WorkflowRun & {
  inputTokens?: number;
  outputTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

export function isCommandCenterTarget(value: unknown): value is CommandCenterTarget {
  return COMMAND_CENTER_TARGETS.includes(value as CommandCenterTarget);
}

export function buildCommandCenterBreadcrumbs(
  target: CommandCenterTarget,
): CommandCenterBreadcrumbSegment[] {
  if (target === "overview") {
    return [{ label: "Command Center", target: "overview", current: true }];
  }

  return [
    { label: "Command Center", target: "overview", current: false },
    { label: target === "usage" ? "Usage" : "Schedule", target, current: true },
  ];
}

export function buildCommandCenterPriority(
  state: Pick<AppState, "workflows" | "runs" | "providers" | "llmProfiles" | "agentAuthProfiles">
    & Partial<Pick<AppState, "artifacts">>,
  now = new Date(),
  pluginManifests: PluginManifest[] = [],
  options: CommandCenterPriorityOptions = {},
): CommandCenterPriority {
  const workflowStates = state.workflows.map((workflow) => {
    const latestRun = latestRunForWorkflow(workflow.workflowId, state.runs);
    const status = deriveWorkflowOperationalStatus(workflow, state, pluginManifests);
    const readiness = deriveProviderReadiness(workflow, state, pluginManifests);
    return { workflow, latestRun, status, readiness };
  });

  const failedRun = workflowStates
    .filter(({ latestRun }) => latestRun && (latestRun.status === "failed" || latestRun.status === "retryable"))
    .sort((a, b) => compareWorkflowRunPriority(a.latestRun, b.latestRun, a.workflow, b.workflow))[0];
  if (failedRun?.latestRun) {
    const canRetry = failedRun.latestRun.status === "retryable";
    return {
      severity: "critical",
      title: "Run needs recovery",
      body: canRetry
        ? `${failedRun.workflow.definition.name} is retryable and ready for another pass.`
        : `${failedRun.workflow.definition.name} failed on its latest run and needs review.`,
      primaryAction: {
        label: "Open workflow",
        target: "workflow",
        workflowId: failedRun.workflow.workflowId,
      },
      secondaryAction: { label: "Open schedule", target: "schedule" },
    };
  }

  const blockedWorkflow = workflowStates
    .filter(({ status, latestRun }) => status === "blocked" && !isApprovalBlockedRun(latestRun))
    .sort((a, b) => compareWorkflowName(a.workflow, b.workflow))[0];
  if (blockedWorkflow) {
    return {
      severity: "attention",
      title: "Workflow blocked",
      body: `${blockedWorkflow.workflow.definition.name} has a blocking configuration or runtime issue to resolve.`,
      primaryAction: {
        label: "Open workflow",
        target: "workflow",
        workflowId: blockedWorkflow.workflow.workflowId,
      },
      secondaryAction: { label: "Review workflows", target: "overview" },
    };
  }

  const pendingApproval = workflowStates
    .filter(({ latestRun }) => isApprovalBlockedRun(latestRun))
    .sort((a, b) => compareWorkflowRunPriority(a.latestRun, b.latestRun, a.workflow, b.workflow))[0];
  if (pendingApproval) {
    return {
      severity: "attention",
      title: "Approval pending",
      body: `${pendingApproval.workflow.definition.name} is paused until its pending approval is reviewed.`,
      primaryAction: {
        label: "Review workflow",
        target: "workflow",
        workflowId: pendingApproval.workflow.workflowId,
      },
      secondaryAction: { label: "Review workflows", target: "overview" },
    };
  }

  const onboardingCompletion = buildPostOnboardingPriority(state, workflowStates, options);
  if (onboardingCompletion) {
    return onboardingCompletion;
  }

  const needsSetup = workflowStates
    .filter(({ status }) => status === "needs-setup")
    .sort((a, b) => compareWorkflowName(a.workflow, b.workflow))[0];
  if (needsSetup) {
    const providerLabel = needsSetup.readiness.providerName ?? needsSetup.readiness.providerId ?? "a provider";
    return {
      severity: "attention",
      title: "Provider setup needed",
      body: `${needsSetup.workflow.definition.name} is waiting on ${providerLabel} before it can run normally.`,
      primaryAction: { label: "Open provider settings", target: "providers" },
      secondaryAction: {
        label: "Open workflow",
        target: "workflow",
        workflowId: needsSetup.workflow.workflowId,
      },
    };
  }

  const overdue = buildScheduleEntries(state, now, pluginManifests)
    .filter((entry) => entry.bucket === "missed")
    .sort(compareScheduleEntries)[0];
  if (overdue) {
    return {
      severity: "attention",
      title: "Schedule overdue",
      body: `${overdue.workflowName} missed its scheduled run and is ready for action.`,
      primaryAction: { label: "Open schedule", target: "schedule" },
      secondaryAction: {
        label: "Open workflow",
        target: "workflow",
        workflowId: overdue.workflowId,
      },
    };
  }

  const nextScheduled = buildScheduleEntries(state, now, pluginManifests)
    .filter((entry) => entry.bucket === "upcoming" && entry.displayRunAt)
    .sort(compareScheduleEntries)[0];
  if (nextScheduled?.displayRunAt) {
    return {
      severity: "normal",
      title: `Next run: ${nextScheduled.workflowName}`,
      body: `${nextScheduled.workflowName} is scheduled for ${formatPriorityTimestamp(nextScheduled.displayRunAt)}.`,
      primaryAction: { label: "Open schedule", target: "schedule" },
      secondaryAction: {
        label: "Open workflow",
        target: "workflow",
        workflowId: nextScheduled.workflowId,
      },
    };
  }

  return {
    severity: "normal",
    title: "All clear",
    body: "No failed runs, blocked workflows, provider setup issues, or overdue schedules need attention.",
    primaryAction: { label: "Review workflows", target: "overview" },
    secondaryAction: { label: "Open schedule", target: "schedule" },
  };
}

export function buildLiveApprovalPriority(
  state: Pick<AppState, "workflows" | "runs" | "providers" | "llmProfiles" | "agentAuthProfiles">,
  options: LiveApprovalPriorityOptions,
): CommandCenterPriority {
  const { basePriority, pendingApproval } = options;
  if (
    pendingApproval == null
    || basePriority.severity === "critical"
    || basePriority.title === "Workflow blocked"
    || basePriority.title === "Provider setup needed"
  ) {
    return basePriority;
  }

  const matchedRun = state.runs.find((run) => run.id === pendingApproval.runId);
  const matchedWorkflow = matchedRun
    ? state.workflows.find((workflow) => workflow.workflowId === matchedRun.workflowId)
    : undefined;

  return {
    severity: "attention",
    title: "Approval pending",
    body: `${pendingApproval.workflowName} is paused until its pending approval is reviewed.`,
    primaryAction: matchedWorkflow
      ? {
          label: "Review workflow",
          target: "workflow",
          workflowId: matchedWorkflow.workflowId,
        }
      : {
          label: "Review approval",
          target: "workflow",
        },
    secondaryAction: { label: "Review workflows", target: "overview" },
  };
}

export function deriveWorkflowOperationalStatus(
  workflow: WorkflowVersion,
  state: Pick<AppState, "runs" | "providers" | "llmProfiles" | "agentAuthProfiles">,
  pluginManifests: PluginManifest[] = [],
): WorkflowOperationalStatus {
  if (workflow.status === "disabled") return "paused";
  if (workflow.status === "draft") return "draft";

  const latestRun = latestRunForWorkflow(workflow.workflowId, state.runs);
  if (latestRun && (latestRun.status === "failed" || latestRun.status === "retryable")) {
    return "failed-retryable";
  }

  if (latestRun?.status === "blocked") return "blocked";
  if (!validateWorkflowDefinition(workflow.definition, pluginManifests).valid) return "blocked";

  const readiness = deriveProviderReadiness(workflow, state, pluginManifests);
  if (readiness.status === "missing" || readiness.status === "needs-setup") return "needs-setup";

  return "enabled";
}

export function deriveWorkflowHealth(
  workflow: WorkflowVersion,
  state: Pick<AppState, "runs" | "providers" | "llmProfiles" | "agentAuthProfiles">,
  pluginManifests: PluginManifest[] = [],
): { status: WorkflowHealthStatus; operationalStatus: WorkflowOperationalStatus; issues: string[] } {
  const operationalStatus = deriveWorkflowOperationalStatus(workflow, state, pluginManifests);
  const readiness = deriveProviderReadiness(workflow, state, pluginManifests);
  const issues = [...readiness.issues];
  const validation = validateWorkflowDefinition(workflow.definition, pluginManifests);
  if (!validation.valid) issues.push(...validation.errors);

  if (operationalStatus === "enabled") {
    return { status: "healthy", operationalStatus, issues };
  }
  if (operationalStatus === "paused" || operationalStatus === "draft") {
    return { status: "inactive", operationalStatus, issues };
  }
  if (operationalStatus === "needs-setup") {
    return { status: "warning", operationalStatus, issues };
  }
  return { status: "critical", operationalStatus, issues };
}

export function deriveProviderReadiness(
  workflow: WorkflowVersion,
  state: Pick<AppState, "providers" | "llmProfiles" | "agentAuthProfiles">,
  pluginManifests: PluginManifest[] = [],
): ProviderReadiness {
  const issues: string[] = [];
  const profiles = profileRefsForWorkflow(workflow.definition);
  const providerRefs = providerRefsForWorkflow(workflow.definition, pluginManifests);
  let profileId = workflow.definition.defaults.llmProfileRef;
  let providerId: string | undefined;
  let providerName: string | undefined;
  let model: string | undefined;
  let degraded = false;

  for (const ref of profiles) {
    profileId = ref;
    const resolved = resolveProfile(ref, state.llmProfiles, state.agentAuthProfiles, state.providers);
    if (!resolved) {
      issues.push(`Profile ${ref} is missing.`);
      continue;
    }

    providerId = resolved.providerId;
    providerName = providerName ?? resolved.providerName;
    model = resolved.model;
    const status = resolved.providerStatus;
    if (status === "degraded") degraded = true;
    if (status === "missing") {
      issues.push(`Provider ${providerId} is missing.`);
    } else if (status === "needs-setup") {
      issues.push(`Provider profile ${ref} needs setup.`);
    }
  }

  for (const ref of providerRefs) {
    const provider = findProvider(state.providers, ref);
    if (!provider) {
      issues.push(`Provider ${ref} is missing.`);
      continue;
    }
    providerId = providerId ?? provider.id;
    providerName = providerName ?? provider.name;
    if (provider.status === "degraded") degraded = true;
    if (provider.status === "needs_config" || provider.status === "unavailable") {
      issues.push(`Provider ${provider.name} needs setup.`);
    }
  }

  const namedProvider = providerId ? findProvider(state.providers, providerId) : undefined;
  providerName = providerName ?? namedProvider?.name;

  if (issues.some((issue) => issue.includes(" is missing."))) {
    return { status: "missing", profileId, providerId, providerName, model, issues };
  }
  if (issues.length > 0) {
    return { status: "needs-setup", profileId, providerId, providerName, model, issues };
  }
  return { status: degraded ? "degraded" : "ready", profileId, providerId, providerName, model, issues };
}

export function buildUsageSummary(
  state: Pick<AppState, "workflows" | "runs" | "providers" | "llmProfiles" | "agentAuthProfiles">,
  runs: WorkflowRun[] = state.runs,
): UsageSummary {
  let totalCostUsd = 0;
  let totalTokens = 0;
  let reportedCostRunCount = 0;
  let unknownCostRunCount = 0;
  let runsWithReportedUsageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let runsMissingSplitCount = 0;
  let runsWithSplitCount = 0;
  let anyTokenSplit = false;
  const byWorkflow = new Map<string, WorkflowUsageSummary>();
  const byProviderModel = new Map<string, ProviderModelUsageSummary>();

  for (const run of runs) {
    const runCost = run.totalCostUsd;
    const runTokens = run.totalTokens;
    const hasCost = typeof runCost === "number";
    const hasTokens = typeof runTokens === "number";

    if (hasCost) {
      totalCostUsd += runCost;
      reportedCostRunCount += 1;
    } else {
      unknownCostRunCount += 1;
    }
    if (hasTokens) {
      totalTokens += runTokens;
    }
    if (hasCost || hasTokens) {
      runsWithReportedUsageCount += 1;
    }

    const split = tokenSplitForRun(run);
    if (hasTokens && !split) {
      runsMissingSplitCount += 1;
    }
    if (split) {
      anyTokenSplit = true;
      runsWithSplitCount += 1;
      inputTokens += split.inputTokens;
      outputTokens += split.outputTokens;
    }

    const workflowSummary = getWorkflowUsageSummary(byWorkflow, run);
    workflowSummary.runCount += 1;
    if (hasCost) {
      workflowSummary.totalCostUsd += runCost;
      workflowSummary.reportedCostRunCount += 1;
    } else {
      workflowSummary.unknownCostRunCount += 1;
    }
    if (hasTokens) workflowSummary.totalTokens += runTokens;

    const providerSummary = getProviderModelUsageSummary(byProviderModel, run, state);
    providerSummary.runCount += 1;
    if (hasCost) providerSummary.totalCostUsd += runCost;
    else providerSummary.unknownCostRunCount += 1;
    if (hasTokens) providerSummary.totalTokens += runTokens;
  }

  return {
    totalCostUsd,
    totalTokens,
    reportedCostRunCount,
    unknownCostRunCount,
    runsWithReportedUsageCount,
    averageCostPerReportedRunUsd: reportedCostRunCount > 0 ? totalCostUsd / reportedCostRunCount : null,
    tokenSplit:
      anyTokenSplit && runsMissingSplitCount === 0
        ? { status: "available", inputTokens, outputTokens }
        : {
            status: "unavailable",
            totalTokens,
            runsMissingSplitCount,
            runsWithSplitCount,
          },
    byWorkflow: [...byWorkflow.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd),
    byProviderModel: [...byProviderModel.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd),
  };
}

export function buildUsageCommandPanelModel(
  state: Pick<AppState, "workflows" | "runs" | "providers" | "llmProfiles" | "agentAuthProfiles">,
  period: UsagePeriod,
  now: Date = new Date(),
  options: UsageCommandPanelOptions = {},
): UsageCommandPanelModel {
  const runs = filterRunsForUsagePeriod(state.runs, period, now);
  const summary = buildUsageSummary(state, runs);
  return {
    period,
    label: usagePeriodLabel(period),
    runs,
    summary,
    dailyCost: buildDailyUsageBuckets(runs, period, now),
    budget: buildUsageBudgetSummary(summary.totalCostUsd, options.budgetThresholdUsd),
    chartState: buildUsageVisualizationStates(state, runs, summary, period),
  };
}

function buildUsageVisualizationStates(
  state: Pick<AppState, "workflows">,
  runs: WorkflowRun[],
  summary: UsageSummary,
  period: UsagePeriod,
): UsageVisualizationStates {
  const fallbackWorkflowId = runs[0]?.workflowId ?? state.workflows[0]?.workflowId;
  const workflowAction = fallbackWorkflowId
    ? { kind: "open-workflow-usage", label: "Open workflow usage detail", workflowId: fallbackWorkflowId } as const
    : null;
  const periodAction = period === "all"
    ? { kind: "change-period", label: "View last 30 days", period: "30d" } as const
    : workflowAction;

  if (runs.length === 0 || summary.runsWithReportedUsageCount === 0) {
    return {
      dailyCost: visualizationState("empty", "No reported usage yet for this period.", workflowAction),
      tokenSplit: visualizationState("empty", "No reported usage yet for this period.", workflowAction),
      providerBreakdown: visualizationState("empty", "No reported usage yet for this period.", workflowAction),
      forecast: visualizationState(
        "empty",
        "Run a workflow with token/cost reporting enabled to populate this chart.",
        workflowAction,
      ),
    };
  }

  return {
    dailyCost:
      summary.reportedCostRunCount === 0
        ? visualizationState(
            "unavailable",
            "Usage runs reported activity, but none reported cost telemetry for daily spend.",
            workflowAction,
          )
        : summary.unknownCostRunCount > 0
          ? visualizationState(
              "partial",
              `${summary.unknownCostRunCount} run${summary.unknownCostRunCount === 1 ? "" : "s"} missing cost telemetry.`,
              workflowAction,
              "Partial data",
            )
          : readyVisualizationState(),
    tokenSplit:
      summary.totalTokens === 0 && summary.reportedCostRunCount === 0
        ? visualizationState("empty", "No token data reported yet for this period.", workflowAction)
        : summary.tokenSplit.status === "available"
          ? readyVisualizationState()
          : summary.tokenSplit.runsWithSplitCount > 0
            ? visualizationState(
                "partial",
                "Token split excludes runs without input/output detail.",
                workflowAction,
                "Partial data",
              )
            : visualizationState(
                "unavailable",
                summary.totalTokens > 0
                  ? "Providers reported token totals but not input/output token fields."
                  : "Usage runs reported cost, but providers did not report token telemetry for this period.",
                workflowAction,
              ),
    providerBreakdown:
      summary.reportedCostRunCount === 0 && summary.totalTokens === 0
        ? visualizationState("empty", "No provider usage data reported yet for this period.", workflowAction)
        : summary.reportedCostRunCount === 0
          ? visualizationState(
              "unavailable",
              "Provider rows would imply spend breakdown without reported cost telemetry.",
              workflowAction,
            )
          : summary.unknownCostRunCount > 0
            ? visualizationState(
                "partial",
                "Provider cost breakdown excludes runs with missing cost data.",
                workflowAction,
                "Partial data",
              )
            : readyVisualizationState(),
    forecast:
      period === "all"
        ? visualizationState(
            "unavailable",
            "Forecast requires a bounded period instead of all-time history.",
            periodAction,
          )
        : summary.reportedCostRunCount === 0
          ? visualizationState(
              "unavailable",
              "Forecast requires reported cost telemetry.",
              workflowAction,
            )
          : summary.unknownCostRunCount > 0
            ? visualizationState(
                "partial",
                "Forecast is based only on runs with reported cost telemetry.",
                workflowAction,
                "Partial data",
              )
            : readyVisualizationState(),
  };
}

function readyVisualizationState(): UsageVisualizationStatus {
  return { state: "ready", reason: null, nextAction: null, confidenceLabel: null };
}

function visualizationState(
  state: UsageVisualizationState,
  reason: string,
  nextAction: UsageVisualizationNextAction | null,
  confidenceLabel: string | null = null,
): UsageVisualizationStatus {
  return { state, reason, nextAction, confidenceLabel };
}

export function buildScheduleEntries(
  state: Pick<AppState, "workflows" | "runs" | "providers" | "llmProfiles" | "agentAuthProfiles">,
  now: Date = new Date(),
  pluginManifests: PluginManifest[] = [],
): CommandCenterScheduleEntry[] {
  return state.workflows
    .map((workflow) => buildScheduleEntry(workflow, state, now, pluginManifests))
    .sort(compareScheduleEntries);
}

export function buildScheduleTimelineModel(
  state: Pick<AppState, "workflows" | "runs" | "providers" | "llmProfiles" | "agentAuthProfiles">,
  now: Date = new Date(),
  pluginManifests: PluginManifest[] = [],
): ScheduleTimelineModel {
  const entries = buildScheduleEntries(state, now, pluginManifests);
  const manualEntries = entries.filter((entry) => entry.bucket === "manual");
  const todayEntries = entries.filter((entry) => entry.bucket !== "manual" && entry.bucket !== "unknown");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
  const nextSevenDays: ScheduleTimelineDay[] = [];

  for (let offset = 0; offset < 7; offset += 1) {
    const day = startOfDay(now);
    day.setDate(day.getDate() + offset);
    const isoDate = isoDateKey(day);
    const dayEntries = entries
      .filter((entry) => entry.bucket !== "manual" && entry.cadence !== "unknown")
      .flatMap((entry) => {
        const workflow = state.workflows.find((candidate) => candidate.workflowId === entry.workflowId);
        const occurrence = workflow?.definition.schedule
          ? occurrenceForDate(workflow.definition.schedule, day)
          : null;
        if (!occurrence) return [];
        return [{
          ...entry,
          bucket: isoDate === isoDateKey(now) ? entry.bucket : entry.bucket === "paused" ? "paused" : "upcoming",
          nextRunAt: occurrence.toISOString(),
          displayRunAt: occurrence.toISOString(),
          occurrenceKey: occurrenceKey(entry.workflowId, occurrence.toISOString()),
          reason: isoDate === isoDateKey(now) ? entry.reason : null,
        } satisfies CommandCenterScheduleEntry];
      })
      .sort(compareScheduleEntries);

    nextSevenDays.push({
      isoDate,
      label: formatDayLabel(day, now),
      entries: dayEntries,
    });
  }

  return {
    timezone,
    todayEntries,
    nextSevenDays,
    manualEntries,
    primaryAction: buildSchedulePrimaryAction(entries),
  };
}

export function buildAssistantSuggestions(
  state: Pick<AppState, "workflows" | "runs" | "providers" | "llmProfiles" | "agentAuthProfiles"> & Partial<Pick<AppState, "artifacts">>,
  surface: AssistantSuggestionSurface = "command-center",
  pluginManifests: PluginManifest[] = [],
  selectedContext: AssistantSelectedContext = {},
): AssistantSuggestion[] {
  const suggestions: AssistantSuggestion[] = [];

  const attentionWorkflows = state.workflows
    .map((workflow) => ({
      workflow,
      status: deriveWorkflowOperationalStatus(workflow, state, pluginManifests),
    }))
    .filter(({ status }) => (
      status === "failed-retryable" || status === "blocked" || status === "needs-setup"
    ))
    .sort((a, b) => assistantStatusRank(a.status) - assistantStatusRank(b.status));

  for (const { workflow, status } of attentionWorkflows.slice(0, 2)) {
    const readiness = deriveProviderReadiness(workflow, state, pluginManifests);
    const providerLabel = readiness.providerName ?? readiness.providerId;
    suggestions.push({
      label:
        status === "needs-setup"
          ? `Configure ${workflow.definition.name}`
          : `Review ${workflow.definition.name}`,
      type: status === "needs-setup" ? "configure" : "repair",
      priority: "high",
      surface,
      action: {
        kind: status === "needs-setup" ? "open-settings" : "open-workflow",
        payload:
          status === "needs-setup"
            ? {
                tab: "providers",
                workflowId: workflow.workflowId,
                target: providerLabel
                  ? { type: "provider", id: slugForTarget(providerLabel), label: providerLabel }
                  : undefined,
              }
            : { workflowId: workflow.workflowId },
      },
    });
  }

  suggestions.push(
    {
      label: "Create workflow",
      type: "navigate",
      priority: "medium",
      surface,
      action: { kind: "open-create-workflow", payload: { selectedPath: "describe" } },
    },
    {
      label: "Open usage",
      type: "navigate",
      priority: "medium",
      surface,
      action: { kind: "open-command-center", payload: { target: "usage" } },
    },
    {
      label: "Open schedule",
      type: "navigate",
      priority: "medium",
      surface,
      action: { kind: "open-command-center", payload: { target: "schedule" } },
    },
    {
      label: "Open provider settings",
      type: "configure",
      priority: "medium",
      surface,
      action: { kind: "open-settings", payload: { tab: "providers" } },
    },
    {
      label: "Open scheduler settings",
      type: "configure",
      priority: "medium",
      surface,
      action: {
        kind: "open-settings",
        payload: { tab: "automation", target: { type: "automation", id: "scheduler", label: "Scheduler" } },
      },
    },
    {
      label: "Run due now",
      type: "run",
      priority: "medium",
      surface,
      action: { kind: "run-due-schedules", payload: {} },
    },
  );

  if (surface === "workflows" || surface === "command-center" || surface === "home") {
    suggestions.push(
      {
        label: "Show overdue",
        type: "navigate",
        priority: "medium",
        surface,
        action: { kind: "set-workflow-roster", payload: { schedules: ["overdue"] } },
      },
      {
        label: "Filter failed workflows",
        type: "repair",
        priority: "medium",
        surface,
        action: { kind: "set-workflow-roster", payload: { statuses: ["failed-retryable"] } },
      },
      {
        label: "Sort by next run",
        type: "navigate",
        priority: "low",
        surface,
        action: { kind: "set-workflow-roster", payload: { sortKey: "next-run" } },
      },
    );
  }

  if (surface === "settings" || selectedContext.activeSettingsTab === "context") {
    suggestions.push(
      contextSettingsSuggestion("Open GitHub context settings", "github", "GitHub", surface),
      contextSettingsSuggestion("Open documents context settings", "document_import", "Documents", surface),
      contextSettingsSuggestion("Open AI chat context settings", "ai_chat_import", "AI chat imports", surface),
      contextSettingsSuggestion("Open NestWeaver context settings", "nestweaver", "NestWeaver", surface),
    );
  }

  const selectedWorkflow = selectedContext.selectedWorkflowId
    ? state.workflows.find((workflow) => workflow.workflowId === selectedContext.selectedWorkflowId)
    : undefined;
  const selectedRun = selectedContext.selectedRunId
    ? state.runs.find((run) => run.id === selectedContext.selectedRunId)
    : undefined;
  const selectedRunWorkflow = selectedRun
    ? state.workflows.find((workflow) => workflow.workflowId === selectedRun.workflowId)
    : undefined;
  const selectedArtifact = selectedContext.selectedArtifactId
    ? state.artifacts?.find((artifact) => artifact.id === selectedContext.selectedArtifactId)
    : undefined;

  if (selectedRun) {
    suggestions.push({
      label: "Explain this run",
      type: "explain",
      priority: "low",
      surface,
      action: {
        kind: "ask-assistant",
        payload: {
          prompt: `Explain run ${selectedRun.id} for ${selectedRunWorkflow?.definition.name ?? selectedRun.workflowName}, including status, trace, and any recovery options.`,
        },
      },
    });
  } else if (selectedArtifact) {
    suggestions.push({
      label: "Explain this artifact",
      type: "explain",
      priority: "low",
      surface,
      action: {
        kind: "ask-assistant",
        payload: { prompt: `Explain artifact ${selectedArtifact.title} and its workflow/run lineage.` },
      },
    });
  } else if (surface === "workflow-detail" || selectedWorkflow) {
    suggestions.push({
      label: "Explain this workflow",
      type: "explain",
      priority: "low",
      surface,
      action: {
        kind: "ask-assistant",
        payload: {
          prompt: selectedWorkflow
            ? `Explain workflow ${selectedWorkflow.definition.name} and any recent run issues.`
            : "Explain this workflow and any recent run issues.",
        },
      },
    });
  } else if (surface === "command-center" || surface === "home") {
    suggestions.push({
      label: "Explain today's schedule",
      type: "explain",
      priority: "low",
      surface,
      action: {
        kind: "ask-assistant",
        payload: { prompt: "Explain today's schedule and what needs attention." },
      },
    });
  }

  return suggestions;
}

function slugForTarget(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function compareWorkflowRunPriority(
  a: WorkflowRun | undefined,
  b: WorkflowRun | undefined,
  workflowA: WorkflowVersion,
  workflowB: WorkflowVersion,
): number {
  if (a && b) {
    const timeDelta = runSortTime(b) - runSortTime(a);
    if (timeDelta !== 0) return timeDelta;
  } else if (a) {
    return -1;
  } else if (b) {
    return 1;
  }

  return compareWorkflowName(workflowA, workflowB);
}

function compareWorkflowName(a: WorkflowVersion, b: WorkflowVersion): number {
  const nameDelta = a.definition.name.localeCompare(b.definition.name);
  if (nameDelta !== 0) return nameDelta;
  return a.workflowId.localeCompare(b.workflowId);
}

function formatPriorityTimestamp(isoString: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoString));
}

function isApprovalBlockedRun(run: WorkflowRun | undefined): boolean {
  return run?.status === "blocked" && (
    run.requiredProviderId === "approval"
    || run.requiredProfileId?.startsWith("approval") === true
    || run.blockedReason?.toLowerCase().includes("approval") === true
  );
}

function contextSettingsSuggestion(
  label: string,
  id: string,
  targetLabel: string,
  surface: AssistantSuggestionSurface,
): AssistantSuggestion {
  return {
    label,
    type: "configure",
    priority: "medium",
    surface,
    action: {
      kind: "open-settings",
      payload: { tab: "context", target: { type: "context-source", id, label: targetLabel } },
    },
  };
}

function assistantStatusRank(status: WorkflowOperationalStatus): number {
  if (status === "failed-retryable") return 0;
  if (status === "blocked") return 1;
  if (status === "needs-setup") return 2;
  return 3;
}

export function usagePeriodLabel(period: UsagePeriod): string {
  if (period === "today") return "Today";
  if (period === "7d") return "7 days";
  if (period === "30d") return "30 days";
  if (period === "mtd") return "Month to date";
  return "All time";
}

export function isUsagePeriod(value: unknown): value is UsagePeriod {
  return value === "today" || value === "7d" || value === "30d" || value === "mtd" || value === "all";
}

function buildScheduleEntry(
  workflow: WorkflowVersion,
  state: Pick<AppState, "runs" | "providers" | "llmProfiles" | "agentAuthProfiles">,
  now: Date,
  pluginManifests: PluginManifest[],
): CommandCenterScheduleEntry {
  const status = deriveWorkflowOperationalStatus(workflow, state, pluginManifests);
  const latestRun = latestRunForWorkflow(workflow.workflowId, state.runs);
  const schedule = workflow.definition.schedule;
  const nextRunAt = nextRunForSchedule(schedule, now);
  const missedRunAt = missedRunForSchedule(schedule, latestRun, now);
  const completedCurrentOccurrence = completedRunForCurrentOccurrence(schedule, latestRun, nextRunAt, now);
  const displayRunAt = missedRunAt?.toISOString() ?? nextRunAt;
  let bucket: ScheduleBucket = "unknown";
  let reason: string | null = null;

  if (status === "paused") {
    bucket = "paused";
  } else if (latestRun?.status === "running" || latestRun?.status === "queued") {
    bucket = "running";
  } else if (latestRun?.status === "failed") {
    bucket = "failed";
  } else if (latestRun?.status === "retryable") {
    bucket = "retryable";
  } else if (completedCurrentOccurrence) {
    bucket = "completed";
  } else if (!schedule) {
    bucket = "unknown";
    reason = "Schedule state is unavailable.";
  } else if (schedule.cadence === "manual") {
    bucket = "manual";
  } else if (!schedule.localTime) {
    bucket = "unknown";
    reason = "Schedule has no local time.";
  } else if (missedRunAt) {
    bucket = "missed";
    reason = `Scheduled time ${missedRunAt.toISOString()} has passed.`;
  } else {
    bucket = "upcoming";
  }

  return {
    workflowId: workflow.workflowId,
    workflowName: workflow.definition.name,
    bucket,
    status,
    scheduleLabel: formatSchedule(schedule),
    cadence: schedule?.cadence ?? "unknown",
    nextRunAt,
    displayRunAt,
    occurrenceKey: displayRunAt ? occurrenceKey(workflow.workflowId, displayRunAt) : null,
    lastRunId: latestRun?.id ?? null,
    lastRunStatus: latestRun?.status ?? null,
    reason,
  };
}

function occurrenceKey(workflowId: string, displayRunAt: string): string {
  return `${workflowId}:${displayRunAt}`;
}

function latestRunForWorkflow(workflowId: string, runs: WorkflowRun[]): WorkflowRun | undefined {
  return runs
    .filter((run) => run.workflowId === workflowId)
    .sort((a, b) => runSortTime(b) - runSortTime(a))[0];
}

function runSortTime(run: WorkflowRun): number {
  return new Date(run.completedAt ?? run.startedAt).getTime();
}

function profileRefsForWorkflow(workflow: RavenWorkflow): string[] {
  const refs = new Set<string>([workflow.defaults.llmProfileRef]);
  for (const step of workflow.steps) {
    if (step.llmProfileRef) refs.add(step.llmProfileRef);
  }
  return [...refs];
}

function providerRefsForWorkflow(workflow: RavenWorkflow, pluginManifests: PluginManifest[]): string[] {
  const refs = new Set<string>();
  for (const step of workflow.steps) {
    if (
      step.provider !== "agent" &&
      !isProfileRoutedProviderStep(step) &&
      !isDeterministicProviderAction(step.provider, step.action) &&
      !pluginSupportsStep(pluginManifests, step.provider, step.action)
    ) {
      refs.add(normalizeProviderRef(step.provider));
    }
    if (step.destinationRef) refs.add(normalizeProviderRef(step.destinationRef));
  }
  refs.add(normalizeProviderRef(workflow.defaults.destinationRef));
  return [...refs];
}

function pluginSupportsStep(
  pluginManifests: PluginManifest[],
  provider: string,
  action: string,
): boolean {
  return pluginManifests.some((plugin) =>
    plugin.steps.some((step) => step.provider === provider && step.action === action),
  );
}

function normalizeProviderRef(ref: string): string {
  return ref === "local-app" ? "local_app" : ref;
}

function findProvider(providers: ProviderHealth[], id: string): ProviderHealth | undefined {
  const normalized = normalizeProviderRef(id);
  return providers.find((provider) => provider.id === normalized || provider.id === id);
}

function resolveProfile(
  profileId: string,
  llmProfiles: LlmProfile[],
  agentAuthProfiles: AgentAuthProfile[],
  providers: ProviderHealth[],
):
  | {
      providerId: string;
      providerName?: string;
      model: string;
      providerStatus: "ready" | "degraded" | "needs-setup" | "missing";
    }
  | null {
  const llmProfile = llmProfiles.find((profile) => profile.id === profileId);
  if (llmProfile) {
    const provider = findProvider(providers, llmProfile.providerId);
    return {
      providerId: llmProfile.providerId,
      providerName: provider?.name ?? llmProfile.providerId,
      model: llmProfile.model,
      providerStatus: provider ? providerStateToReadiness(provider.status) : "missing",
    };
  }

  const agentProfile = agentAuthProfiles.find((profile) => profile.id === profileId);
  if (agentProfile) {
    return {
      providerId: agentProfile.id,
      providerName: agentProfile.displayName,
      model: agentProfile.model,
      providerStatus: providerStateToReadiness(agentProfile.status),
    };
  }

  return null;
}

function providerStateToReadiness(status: ProviderHealth["status"]): "ready" | "degraded" | "needs-setup" {
  if (status === "available") return "ready";
  if (status === "degraded") return "degraded";
  return "needs-setup";
}

function buildPostOnboardingPriority(
  state: Pick<AppState, "workflows" | "runs"> & Partial<Pick<AppState, "artifacts">>,
  _workflowStates: Array<{
    workflow: WorkflowVersion;
    latestRun: WorkflowRun | undefined;
    status: WorkflowOperationalStatus;
    readiness: ProviderReadiness;
  }>,
  options: CommandCenterPriorityOptions,
): CommandCenterPriority | null {
  if (!options.postOnboardingLandingPending || options.hasSkippedSetup) return null;

  const latestArtifact = latestArtifactForPriority(state.artifacts ?? []);
  if (latestArtifact && isOnboardingArtifact(latestArtifact)) {
    const workflow = workflowForArtifact(latestArtifact, state.workflows, state.runs);
    const title = isOnboardingSampleArtifact(latestArtifact) ? "Sample artifact created" : "Artifact ready";
    const body = workflow
      ? `${latestArtifact.title} is ready from ${workflow.definition.name}.`
      : `${latestArtifact.title} is ready for review.`;
    return {
      severity: "normal",
      title,
      body,
      primaryAction: workflow
        ? { label: "Open workflow", target: "workflow", workflowId: workflow.workflowId }
        : { label: "Review workflows", target: "overview" },
      secondaryAction: { label: "Open schedule", target: "schedule" },
    };
  }

  return null;
}

function latestArtifactForPriority(artifacts: Artifact[]): Artifact | undefined {
  return [...artifacts].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

function workflowForArtifact(
  artifact: Artifact,
  workflows: WorkflowVersion[],
  runs: WorkflowRun[],
): WorkflowVersion | undefined {
  const run = runs.find((candidate) => candidate.id === artifact.workflowRunId);
  const workflowId = typeof artifact.metadata.workflowId === "string"
    ? artifact.metadata.workflowId
    : run?.workflowId;
  if (!workflowId) return undefined;
  return workflows.find((workflow) => workflow.workflowId === workflowId);
}

function isOnboardingArtifact(artifact: Artifact): boolean {
  return artifact.metadata.source === "onboarding";
}

function isOnboardingSampleArtifact(artifact: Artifact): boolean {
  return isOnboardingArtifact(artifact)
    && artifact.metadata.simulated === true;
}

function isProfileRoutedProviderStep(step: WorkflowStepDefinition): boolean {
  return step.provider === "openai"
    && (step.action === "chat_stream" || step.action === "generate_artifact" || step.action === "structured_output");
}

function tokenSplitForRun(run: WorkflowRun): { inputTokens: number; outputTokens: number } | null {
  const candidate = run as RunWithTokenSplit;
  const inputTokens = candidate.inputTokens ?? candidate.input_tokens;
  const outputTokens = candidate.outputTokens ?? candidate.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  return { inputTokens, outputTokens };
}

function buildUsageBudgetSummary(totalCostUsd: number, thresholdUsd: number | null | undefined): UsageBudgetSummary {
  if (typeof thresholdUsd !== "number" || !Number.isFinite(thresholdUsd) || thresholdUsd <= 0) {
    return {
      status: "not-set",
      label: "Budget not set",
      thresholdUsd: null,
      totalCostUsd,
      percentUsed: null,
    };
  }

  const percentUsed = Math.round((totalCostUsd / thresholdUsd) * 100);
  return {
    status: totalCostUsd >= thresholdUsd ? "danger" : "ok",
    label: `$${thresholdUsd.toFixed(2)} cost alert`,
    thresholdUsd,
    totalCostUsd,
    percentUsed,
  };
}

function getWorkflowUsageSummary(
  map: Map<string, WorkflowUsageSummary>,
  run: WorkflowRun,
): WorkflowUsageSummary {
  const existing = map.get(run.workflowId);
  if (existing) return existing;

  const created: WorkflowUsageSummary = {
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    totalCostUsd: 0,
    unknownCostRunCount: 0,
    reportedCostRunCount: 0,
    totalTokens: 0,
    runCount: 0,
  };
  map.set(run.workflowId, created);
  return created;
}

function getProviderModelUsageSummary(
  map: Map<string, ProviderModelUsageSummary>,
  run: WorkflowRun,
  state: Pick<AppState, "workflows" | "providers" | "llmProfiles" | "agentAuthProfiles">,
): ProviderModelUsageSummary {
  const providerModel = providerModelForRun(run, state);
  const key = `${providerModel.profileId}:${providerModel.model}`;
  const existing = map.get(key);
  if (existing) return existing;

  const created: ProviderModelUsageSummary = {
    ...providerModel,
    totalCostUsd: 0,
    unknownCostRunCount: 0,
    totalTokens: 0,
    runCount: 0,
  };
  map.set(key, created);
  return created;
}

function providerModelForRun(
  run: WorkflowRun,
  state: Pick<AppState, "workflows" | "providers" | "llmProfiles" | "agentAuthProfiles">,
): Pick<ProviderModelUsageSummary, "providerId" | "providerName" | "profileId" | "model"> {
  const workflow = state.workflows.find((item) => item.workflowId === run.workflowId);
  const profileId = run.providerProfileId ?? workflow?.definition.defaults.llmProfileRef ?? "unknown";
  const agentProfile = state.agentAuthProfiles.find((profile) => profile.id === profileId);
  if (agentProfile) {
    return {
      providerId: agentProfile.id,
      providerName: agentProfile.displayName,
      profileId,
      model: agentProfile.model,
    };
  }

  const llmProfile = state.llmProfiles.find((profile) => profile.id === profileId);
  const provider = llmProfile ? findProvider(state.providers, llmProfile.providerId) : undefined;
  return {
    providerId: llmProfile?.providerId ?? "unknown",
    providerName: provider?.name ?? llmProfile?.providerId ?? "Unknown",
    profileId,
    model: llmProfile?.model ?? "Unknown",
  };
}

function filterRunsForUsagePeriod(runs: WorkflowRun[], period: UsagePeriod, now: Date): WorkflowRun[] {
  const start = usagePeriodStart(period, now, runs);
  if (!start) return runs;
  const startMs = start.getTime();
  const endMs = now.getTime();
  return runs.filter((run) => {
    const startedAt = new Date(run.startedAt).getTime();
    return startedAt >= startMs && startedAt <= endMs;
  });
}

function usagePeriodStart(period: UsagePeriod, now: Date, runs: WorkflowRun[]): Date | null {
  if (period === "all") {
    if (runs.length === 0) return null;
    return startOfDay(new Date(Math.min(...runs.map((run) => new Date(run.startedAt).getTime()))));
  }

  const start = startOfDay(now);
  if (period === "today") return start;
  if (period === "7d") {
    start.setDate(start.getDate() - 6);
    return start;
  }
  if (period === "30d") {
    start.setDate(start.getDate() - 29);
    return start;
  }
  start.setDate(1);
  return start;
}

function buildDailyUsageBuckets(
  runs: WorkflowRun[],
  period: UsagePeriod,
  now: Date,
): DailyUsageCostBucket[] {
  const start = usagePeriodStart(period, now, runs) ?? startOfDay(now);
  const end = startOfDay(now);
  const buckets = new Map<string, DailyUsageCostBucket>();
  const cursor = new Date(start);

  while (cursor.getTime() <= end.getTime()) {
    const isoDate = isoDateKey(cursor);
    buckets.set(isoDate, {
      isoDate,
      label: formatShortDay(cursor),
      totalCostUsd: 0,
      unknownCostRunCount: 0,
      runCount: 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const run of runs) {
    const key = isoDateKey(new Date(run.startedAt));
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.runCount += 1;
    if (typeof run.totalCostUsd === "number") bucket.totalCostUsd += run.totalCostUsd;
    else bucket.unknownCostRunCount += 1;
  }

  return [...buckets.values()];
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function isoDateKey(date: Date): string {
  const local = new Date(date);
  const year = local.getFullYear();
  const month = `${local.getMonth() + 1}`.padStart(2, "0");
  const day = `${local.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatShortDay(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatDayLabel(date: Date, now: Date): string {
  if (isoDateKey(date) === isoDateKey(now)) return "Today";
  const tomorrow = startOfDay(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isoDateKey(date) === isoDateKey(tomorrow)) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function nextRunForSchedule(schedule: RavenWorkflow["schedule"], now: Date): string | null {
  if (!schedule || schedule.cadence === "manual" || !schedule.localTime) return null;
  const candidate = occurrenceForDate(schedule, now);
  if (candidate && candidate.getTime() > now.getTime()) return candidate.toISOString();

  const next = new Date(now);
  for (let i = 0; i < 8; i += 1) {
    next.setDate(next.getDate() + 1);
    const occurrence = occurrenceForDate(schedule, next);
    if (occurrence && occurrence.getTime() > now.getTime()) return occurrence.toISOString();
  }
  return null;
}

function missedRunForSchedule(
  schedule: RavenWorkflow["schedule"],
  latestRun: WorkflowRun | undefined,
  now: Date,
): Date | null {
  if (!schedule || schedule.cadence === "manual" || !schedule.localTime) return null;
  const occurrence = occurrenceForDate(schedule, now);
  if (!occurrence || occurrence.getTime() > now.getTime()) return null;
  if (latestRun && new Date(latestRun.startedAt).getTime() >= occurrence.getTime()) return null;
  return occurrence;
}

function completedRunForCurrentOccurrence(
  schedule: RavenWorkflow["schedule"],
  latestRun: WorkflowRun | undefined,
  nextRunAt: string | null,
  now: Date,
): boolean {
  if (!latestRun || latestRun.status !== "succeeded") return false;
  const occurrence = schedule ? occurrenceForDate(schedule, now) : null;
  if (!occurrence || occurrence.getTime() > now.getTime()) return false;

  const runStartedAt = new Date(latestRun.startedAt).getTime();
  const occurrenceStartedAt = occurrence.getTime();
  const nextOccurrenceStartedAt = nextRunAt ? new Date(nextRunAt).getTime() : Number.POSITIVE_INFINITY;

  return runStartedAt >= occurrenceStartedAt && runStartedAt < nextOccurrenceStartedAt;
}

function occurrenceForDate(schedule: NonNullable<RavenWorkflow["schedule"]>, date: Date): Date | null {
  if (schedule.cadence === "manual" || !schedule.localTime) return null;
  if (schedule.cadence === "weekdays") {
    const day = date.getDay();
    if (day < 1 || day > 5) return null;
  }

  const [hours, minutes] = schedule.localTime.split(":").map((part) => Number(part));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const occurrence = new Date(date);
  occurrence.setHours(hours, minutes, 0, 0);
  return occurrence;
}

function scheduleBucketRank(bucket: ScheduleBucket): number {
  const ranks: Record<ScheduleBucket, number> = {
    failed: 0,
    retryable: 1,
    missed: 2,
    running: 3,
    upcoming: 4,
    manual: 5,
    paused: 6,
    unknown: 7,
    completed: 8,
  };
  return ranks[bucket];
}

function compareScheduleEntries(
  a: CommandCenterScheduleEntry,
  b: CommandCenterScheduleEntry,
): number {
  const rankDelta = scheduleBucketRank(a.bucket) - scheduleBucketRank(b.bucket);
  if (rankDelta !== 0) return rankDelta;

  if (a.bucket === "upcoming" && b.bucket === "upcoming") {
    const nextRunDelta = compareNullableIso(a.nextRunAt, b.nextRunAt);
    if (nextRunDelta !== 0) return nextRunDelta;
  }

  const nameDelta = a.workflowName.localeCompare(b.workflowName);
  if (nameDelta !== 0) return nameDelta;
  return a.workflowId.localeCompare(b.workflowId);
}

function compareNullableIso(a: string | null, b: string | null): number {
  if (a && b) return new Date(a).getTime() - new Date(b).getTime();
  if (a) return -1;
  if (b) return 1;
  return 0;
}

function buildSchedulePrimaryAction(entries: CommandCenterScheduleEntry[]): SchedulePrimaryAction {
  const dueEntries = entries.filter((entry) => entry.bucket === "missed");
  if (dueEntries.length > 0) {
    const overdueCount = dueEntries.filter((entry) => entry.reason?.includes("has passed") ?? false).length;
    return {
      label: "Run due schedules",
      disabled: false,
      dueCount: dueEntries.length,
      reason: overdueCount === 1
        ? "1 schedule is overdue and ready to run."
        : `${overdueCount} schedules are overdue and ready to run.`,
    };
  }

  const nextUpcomingEntry = entries
    .filter((entry) => entry.bucket === "upcoming" && entry.displayRunAt)
    .sort((a, b) => compareNullableIso(a.displayRunAt, b.displayRunAt))[0];
  if (nextUpcomingEntry?.displayRunAt) {
    return {
      label: "No schedules due",
      disabled: true,
      dueCount: 0,
      reason: `The next scheduled run is ${nextUpcomingEntry.workflowName} at ${nextUpcomingEntry.displayRunAt}.`,
    };
  }

  return {
    label: "No schedules due",
    disabled: true,
    dueCount: 0,
    reason: "No automatic schedules are due right now.",
  };
}
