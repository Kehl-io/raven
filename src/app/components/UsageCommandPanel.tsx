import { BarChart3, Download, TrendingDown, TrendingUp, WalletCards } from "lucide-react";
import { forwardRef, useEffect, useMemo, useState } from "react";
import type { AppState, UsageCostAnomaly, UsagePricingCatalog, UsagePricingCatalogEntry, WorkflowRun } from "../../domain/types";
import { analyzePersistedUsageHistory, loadUsagePricingCatalog } from "../tauriBridge";
import {
  buildUsageCommandPanelModel,
  isUsagePeriod,
  usagePeriodLabel,
  type UsagePeriod,
} from "../selectors/commandCenter";

const USAGE_PERIODS: UsagePeriod[] = ["today", "7d", "30d", "mtd", "all"];
export const USAGE_BUDGET_THRESHOLD_EVENT = "raven:usage-budget-threshold-changed";

type RunWithTokenSplit = WorkflowRun & {
  inputTokens?: number;
  outputTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

type HistoricalCostAnomaly = UsageCostAnomaly & {
  detected: boolean;
  currentWindowLabel: string;
  baselineWindowLabel: string;
  currentAverageDailyUsd: number;
  baselineAverageDailyUsd: number;
  currentRunCount: number;
  baselineRunCount: number;
  baselineDays: number;
  source: string;
};

interface ModelSubstitutionRecommendation {
  currentModel: string;
  suggestedModel: string;
  providerName: string;
  estimatedCurrentCostUsd: number;
  estimatedSuggestedCostUsd: number;
  savingsPercent: number;
  sourceLabel: string;
}

interface UsageCommandPanelProps {
  state: Pick<AppState, "workflows" | "runs" | "artifacts" | "providers" | "llmProfiles" | "agentAuthProfiles">;
  now?: Date;
  isTargeted?: boolean;
  onOpenWorkflow: (workflowId: string, source: "usage") => void;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTokenMetric(value: number): string {
  return value.toLocaleString();
}

function formatAverageCost(value: number | null): string {
  return value == null ? "Unavailable" : formatCurrency(value);
}

function formatReportedCost(
  totalCostUsd: number,
  unknownCostRunCount: number,
  reportedCostRunCount: number,
): string {
  if (reportedCostRunCount === 0 && unknownCostRunCount > 0) return "No reported cost";
  return formatCurrency(totalCostUsd);
}

function storedUsagePeriod(): UsagePeriod {
  const persisted = localStorage.getItem("raven_usage_period");
  if (isUsagePeriod(persisted)) return persisted;
  localStorage.setItem("raven_usage_period", "today");
  return "today";
}

function storedBudgetThreshold(): number | null {
  const raw = localStorage.getItem("raven_usage_budget_threshold_usd");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function periodDayCount(period: UsagePeriod, now: Date): number | null {
  if (period === "today") return 1;
  if (period === "7d") return 7;
  if (period === "30d") return 30;
  if (period === "mtd") return now.getDate();
  return null;
}

function periodRemainingDays(period: UsagePeriod, now: Date): number {
  if (period === "today" || period === "all") return 0;
  if (period === "7d") return 6;
  if (period === "30d") return 29;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(0, lastDay - now.getDate());
}

function formatWindowDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatCatalogDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fetched date unavailable";
  return `Fetched ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)}`;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function usageWindowStart(period: UsagePeriod, now: Date, runs: WorkflowRun[]): Date {
  if (period === "all" && runs.length > 0) {
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
  if (period === "mtd") {
    start.setDate(1);
    return start;
  }
  return start;
}

function costRunsInWindow(runs: WorkflowRun[], startInclusive: Date, endExclusive: Date): WorkflowRun[] {
  const startMs = startInclusive.getTime();
  const endMs = endExclusive.getTime();
  return runs.filter((run) => {
    const startedAt = new Date(run.startedAt).getTime();
    return startedAt >= startMs && startedAt < endMs && typeof run.totalCostUsd === "number";
  });
}

function sumRunCost(runs: WorkflowRun[]): number {
  return runs.reduce((sum, run) => sum + (run.totalCostUsd ?? 0), 0);
}

function buildHistoricalCostAnomaly(
  allRuns: WorkflowRun[],
  period: UsagePeriod,
  now: Date,
  multiplier: number,
): HistoricalCostAnomaly {
  const currentStart = usageWindowStart(period, now, allRuns);
  const currentEnd = new Date(now);
  const currentDays = Math.max(1, Math.ceil((currentEnd.getTime() - currentStart.getTime()) / 86_400_000));
  const baselineDays = period === "today" ? 7 : Math.max(currentDays, 1);
  const baselineEnd = new Date(currentStart);
  const baselineStart = new Date(baselineEnd);
  baselineStart.setDate(baselineStart.getDate() - baselineDays);

  const currentRuns = costRunsInWindow(allRuns, currentStart, currentEnd);
  const baselineRuns = costRunsInWindow(allRuns, baselineStart, baselineEnd);
  const currentAverageDailyUsd = sumRunCost(currentRuns) / currentDays;
  const baselineAverageDailyUsd = sumRunCost(baselineRuns) / baselineDays;

  return {
    detected: baselineAverageDailyUsd > 0 && currentAverageDailyUsd > baselineAverageDailyUsd * multiplier,
    period,
    multiplier,
    currentWindowLabel: `${formatWindowDate(currentStart)}-${formatWindowDate(currentEnd)}`,
    baselineWindowLabel: `${formatWindowDate(baselineStart)}-${formatWindowDate(baselineEnd)}`,
    currentAverageDailyUsd,
    baselineAverageDailyUsd,
    currentRunCount: currentRuns.length,
    baselineRunCount: baselineRuns.length,
    baselineDays,
    source: "app-state-runs",
  };
}

function normalizeCatalogKey(value: string): string {
  return value.trim().toLowerCase();
}

function catalogStatusLabel(catalog: UsagePricingCatalog | null): string {
  if (!catalog) return "Pricing catalog unavailable";
  return `${catalog.source} · ${catalog.version}`;
}

function pricingEntryFor(
  catalog: UsagePricingCatalog,
  providerId: string,
  model: string,
): UsagePricingCatalogEntry | null {
  const normalizedProvider = normalizeCatalogKey(providerId);
  const normalizedModel = normalizeCatalogKey(model);
  return catalog.entries.find((entry) => (
    normalizeCatalogKey(entry.providerId) === normalizedProvider &&
    (
      normalizeCatalogKey(entry.model) === normalizedModel ||
      entry.aliases?.some((alias) => normalizeCatalogKey(alias) === normalizedModel)
    )
  )) ?? null;
}

function estimateCatalogCost(entry: UsagePricingCatalogEntry, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * entry.inputUsdPerMillionTokens +
    (outputTokens / 1_000_000) * entry.outputUsdPerMillionTokens
  );
}

function tokenSplitForRun(run: WorkflowRun): { inputTokens: number; outputTokens: number } | null {
  const candidate = run as RunWithTokenSplit;
  const inputTokens = candidate.inputTokens ?? candidate.input_tokens;
  const outputTokens = candidate.outputTokens ?? candidate.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  return { inputTokens, outputTokens };
}

function profileIdForRun(run: WorkflowRun, state: UsageCommandPanelProps["state"]): string {
  const workflow = state.workflows.find((item) => item.workflowId === run.workflowId);
  return run.providerProfileId ?? workflow?.definition.defaults.llmProfileRef ?? "unknown";
}

function estimatedTokenMixForProfile(
  runs: WorkflowRun[],
  profileId: string,
  state: UsageCommandPanelProps["state"],
): { inputTokens: number; outputTokens: number } {
  return runs
    .filter((run) => profileIdForRun(run, state) === profileId)
    .reduce((mix, run) => {
      const split = tokenSplitForRun(run);
      if (split) {
        mix.inputTokens += split.inputTokens;
        mix.outputTokens += split.outputTokens;
        return mix;
      }
      const totalTokens = run.totalTokens ?? 0;
      mix.inputTokens += Math.round(totalTokens * 0.7);
      mix.outputTokens += Math.max(0, totalTokens - Math.round(totalTokens * 0.7));
      return mix;
    }, { inputTokens: 0, outputTokens: 0 });
}

function buildModelSubstitutionRecommendations(
  state: UsageCommandPanelProps["state"],
  runs: WorkflowRun[],
  summary: ReturnType<typeof buildUsageCommandPanelModel>["summary"],
  catalog: UsagePricingCatalog | null,
): ModelSubstitutionRecommendation[] {
  if (!catalog) return [];
  return summary.byProviderModel.flatMap((provider) => {
    const currentPrice = pricingEntryFor(catalog, provider.providerId, provider.model);
    if (!currentPrice) return [];

    const mix = estimatedTokenMixForProfile(runs, provider.profileId, state);
    if (mix.inputTokens + mix.outputTokens === 0) return [];

    const currentCost = estimateCatalogCost(currentPrice, mix.inputTokens, mix.outputTokens);
    const suggestions = catalog.entries
      .filter((entry) =>
        normalizeCatalogKey(entry.providerId) === normalizeCatalogKey(provider.providerId) &&
        normalizeCatalogKey(entry.model) !== normalizeCatalogKey(currentPrice.model) &&
        entry.contextWindowTokens >= Math.min(currentPrice.contextWindowTokens, 200_000),
      )
      .map((entry) => ({
        entry,
        cost: estimateCatalogCost(entry, mix.inputTokens, mix.outputTokens),
      }))
      .filter(({ cost }) => cost < currentCost)
      .sort((a, b) => a.cost - b.cost);

    const best = suggestions[0];
    if (!best) return [];

    return [{
      currentModel: currentPrice.model,
      suggestedModel: best.entry.model,
      providerName: provider.providerName,
      estimatedCurrentCostUsd: currentCost,
      estimatedSuggestedCostUsd: best.cost,
      savingsPercent: Math.round(((currentCost - best.cost) / currentCost) * 100),
      sourceLabel: catalogStatusLabel(catalog),
    }];
  }).sort((a, b) => b.savingsPercent - a.savingsPercent);
}

function buildUsageCsv(model: ReturnType<typeof buildUsageCommandPanelModel>): string {
  const rows = [
    ["workflow", "runs", "reported_cost_usd", "unknown_cost_runs", "tokens"],
    ...model.summary.byWorkflow.map((workflow) => [
      workflow.workflowName,
      String(workflow.runCount),
      workflow.totalCostUsd.toFixed(4),
      String(workflow.unknownCostRunCount),
      String(workflow.totalTokens),
    ]),
  ];
  return rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
}

function downloadUsageCsv(model: ReturnType<typeof buildUsageCommandPanelModel>) {
  const blob = new Blob([buildUsageCsv(model)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `raven-usage-${model.period}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function visualizationTone(state: ReturnType<typeof buildUsageCommandPanelModel>["chartState"]["dailyCost"]["state"]): string {
  if (state === "partial") return "partial";
  if (state === "unavailable") return "unavailable";
  return "empty";
}

export const UsageCommandPanel = forwardRef<HTMLElement, UsageCommandPanelProps>(
  function UsageCommandPanel(
    {
      state,
      now,
      isTargeted = false,
      onOpenWorkflow,
    },
    ref,
  ) {
    const [period, setPeriod] = useState<UsagePeriod>(storedUsagePeriod);
    const [budgetThresholdUsd, setBudgetThresholdUsd] = useState<number | null>(storedBudgetThreshold);
    const [budgetDraft, setBudgetDraft] = useState(() => budgetThresholdUsd?.toString() ?? "");
    const [anomalyMultiplier, setAnomalyMultiplier] = useState(() => {
      const raw = localStorage.getItem("raven_usage_anomaly_multiplier");
      const value = raw ? Number(raw) : 2;
      return Number.isFinite(value) && value >= 1.1 ? value : 2;
    });
    const [persistedAnomaly, setPersistedAnomaly] = useState<UsageCostAnomaly | null>(null);
    const [pricingCatalog, setPricingCatalog] = useState<UsagePricingCatalog | null>(null);
    const model = useMemo(
      () => buildUsageCommandPanelModel(state, period, now ?? new Date(), { budgetThresholdUsd }),
      [state, period, now, budgetThresholdUsd],
    );
    const { summary, chartState } = model;
    const maxDailyCost = Math.max(...model.dailyCost.map((bucket) => bucket.totalCostUsd), 0);
    const maxWorkflowCost = Math.max(...summary.byWorkflow.map((workflow) => workflow.totalCostUsd), 0);
    const referenceNow = now ?? new Date();
    const dayCount = periodDayCount(period, referenceNow);
    const observedDailyAverage = dayCount && dayCount > 0 ? summary.totalCostUsd / dayCount : null;
    const forecastCostUsd = observedDailyAverage == null
      ? null
      : summary.totalCostUsd + observedDailyAverage * periodRemainingDays(period, referenceNow);
    const fallbackAnomaly = buildHistoricalCostAnomaly(state.runs, period, referenceNow, anomalyMultiplier);
    const anomaly = persistedAnomaly && persistedAnomaly.period === period
      ? persistedAnomaly
      : fallbackAnomaly;
    const modelRecommendations = buildModelSubstitutionRecommendations(state, model.runs, summary, pricingCatalog);
    const artifactCountByWorkflow = new Map<string, number>();
    for (const artifact of state.artifacts) {
      const run = state.runs.find((candidate) => candidate.id === artifact.workflowRunId);
      const workflowId = run?.workflowId ?? (
        typeof artifact.metadata.workflowId === "string" ? artifact.metadata.workflowId : ""
      );
      if (workflowId) artifactCountByWorkflow.set(workflowId, (artifactCountByWorkflow.get(workflowId) ?? 0) + 1);
    }
    const successfulCostUsd = model.runs
      .filter((run) => run.status === "succeeded")
      .reduce((sum, run) => sum + (run.totalCostUsd ?? 0), 0);
    const wasteCostUsd = model.runs
      .filter((run) => run.status === "failed" || run.status === "retryable")
      .reduce((sum, run) => sum + (run.totalCostUsd ?? 0), 0);
    const renderVisualizationState = (
      chart: typeof chartState.dailyCost,
      options: {
        emptyTitle?: string;
        nonReadyTitle: string;
        preservedSummary?: string | null;
      },
    ) => (
      <div className={`usage-visualization-state usage-visualization-state-${visualizationTone(chart.state)}`}>
        {chart.confidenceLabel && <span className="usage-neutral-pill">{chart.confidenceLabel}</span>}
        <strong>{chart.state === "empty" ? (options.emptyTitle ?? "No reported usage yet") : options.nonReadyTitle}</strong>
        <p>
          {chart.state === "empty"
            ? "Run a workflow with token/cost reporting enabled to populate this chart."
            : chart.reason}
        </p>
        {options.preservedSummary && <small>{options.preservedSummary}</small>}
        {chart.nextAction && (
          <button
            type="button"
            onClick={() => {
              if (chart.nextAction?.kind === "open-workflow-usage" && chart.nextAction.workflowId) {
                onOpenWorkflow(chart.nextAction.workflowId, "usage");
                return;
              }
              if (chart.nextAction?.kind === "change-period" && chart.nextAction.period) {
                setPeriod(chart.nextAction.period);
                localStorage.setItem("raven_usage_period", chart.nextAction.period);
              }
            }}
          >
            {chart.nextAction.label}
          </button>
        )}
      </div>
    );

    useEffect(() => {
      let cancelled = false;
      analyzePersistedUsageHistory(period, anomalyMultiplier).then((result) => {
        if (cancelled) return;
        setPersistedAnomaly(result);
      });
      return () => {
        cancelled = true;
      };
    }, [period, anomalyMultiplier]);

    useEffect(() => {
      let cancelled = false;
      loadUsagePricingCatalog().then((catalog) => {
        if (cancelled) return;
        setPricingCatalog(catalog);
      });
      return () => {
        cancelled = true;
      };
    }, []);

    return (
      <section
        ref={ref}
        className={`usage-command-panel command-panel ${isTargeted ? "command-panel-targeted" : ""}`}
        aria-label="Usage and cost command panel"
        role="region"
        tabIndex={-1}
      >
        <div className="command-panel-heading">
          <div>
            <span className="panel-kicker">Command Center / Usage</span>
            <h2>Usage and Cost</h2>
          </div>
          <label className="command-panel-select">
            <span>Usage period</span>
            <select
              aria-label="Usage period"
              value={period}
              onChange={(event) => {
                const next = event.target.value as UsagePeriod;
                setPeriod(next);
                localStorage.setItem("raven_usage_period", next);
              }}
            >
              {USAGE_PERIODS.map((item) => (
                <option key={item} value={item}>{usagePeriodLabel(item)}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => downloadUsageCsv(model)}>
            <Download size={15} />
            Export CSV
          </button>
        </div>

        <div className="usage-command-metrics">
              <div className="usage-command-metric" aria-label="Total estimated cost">
                <span>Total estimated cost</span>
                <strong>{formatCurrency(summary.totalCostUsd)}</strong>
              </div>
              <div className="usage-command-metric" aria-label="Total tokens">
                <span>Total tokens</span>
                <strong>{formatTokenMetric(summary.totalTokens)}</strong>
              </div>
              <div className="usage-command-metric" aria-label="Input tokens">
                <span>Input tokens</span>
                <strong>
                  {summary.tokenSplit.status === "available"
                    ? formatTokenMetric(summary.tokenSplit.inputTokens)
                    : "Unavailable"}
                </strong>
              </div>
              <div className="usage-command-metric" aria-label="Output tokens">
                <span>Output tokens</span>
                <strong>
                  {summary.tokenSplit.status === "available"
                    ? formatTokenMetric(summary.tokenSplit.outputTokens)
                    : "Unavailable"}
                </strong>
              </div>
              <div className="usage-command-metric" aria-label="Runs with reported usage">
                <span>Runs with reported usage</span>
                <strong>{summary.runsWithReportedUsageCount}</strong>
              </div>
              <div className="usage-command-metric" aria-label="Average cost per run">
                <span>Average cost per run</span>
                <strong>{formatAverageCost(summary.averageCostPerReportedRunUsd)}</strong>
              </div>
        </div>

            <div className="usage-command-grid">
              <div className="usage-chart-panel">
                <div className="usage-chart-title">
                  <BarChart3 size={16} />
                  <strong>Daily cost</strong>
                </div>
                {chartState.dailyCost.state === "ready" ? (
                  <ol className="daily-cost-bars" aria-label="Daily cost by day">
                    {model.dailyCost.map((bucket) => (
                      <li key={bucket.isoDate}>
                        <span
                          className="daily-cost-bar"
                          style={{
                            height: `${Math.max(10, maxDailyCost > 0 ? (bucket.totalCostUsd / maxDailyCost) * 100 : 10)}%`,
                          }}
                          title={`${bucket.label}: ${formatReportedCost(
                            bucket.totalCostUsd,
                            bucket.unknownCostRunCount,
                            bucket.runCount - bucket.unknownCostRunCount,
                          )}`}
                        />
                        <small>{bucket.label}</small>
                        <strong>
                          {formatReportedCost(
                            bucket.totalCostUsd,
                            bucket.unknownCostRunCount,
                            bucket.runCount - bucket.unknownCostRunCount,
                          )}
                        </strong>
                      </li>
                    ))}
                  </ol>
                ) : renderVisualizationState(chartState.dailyCost, {
                  nonReadyTitle: "Usage visualization unavailable",
                })}
              </div>

              <div className="usage-chart-panel">
                <div className="usage-chart-title">
                  <WalletCards size={16} />
                  <strong>Token split</strong>
                </div>
                {chartState.tokenSplit.state === "ready" && summary.tokenSplit.status === "available" ? (
                  <div className="token-split-bars" aria-label="Input and output token split">
                    <span
                      style={{
                        flexGrow: Math.max(summary.tokenSplit.inputTokens, 1),
                      }}
                    >
                      Input {formatTokenMetric(summary.tokenSplit.inputTokens)}
                    </span>
                    <span
                      style={{
                        flexGrow: Math.max(summary.tokenSplit.outputTokens, 1),
                      }}
                    >
                      Output {formatTokenMetric(summary.tokenSplit.outputTokens)}
                    </span>
                  </div>
                ) : (
                  renderVisualizationState(chartState.tokenSplit, {
                    nonReadyTitle: "Token split unavailable",
                    preservedSummary: summary.totalTokens > 0 ? `${formatTokenMetric(summary.totalTokens)} total tokens preserved` : null,
                  })
                )}
              </div>
            </div>

            <div className="usage-command-grid">
              <div className="usage-chart-panel">
                <div className="usage-chart-title">
                  <strong>Top workflows by cost</strong>
                  {summary.unknownCostRunCount > 0 && chartState.dailyCost.state === "ready" && (
                    <span className="usage-neutral-pill">Unknown cost present</span>
                  )}
                </div>
                {chartState.dailyCost.state === "ready" ? (
                  <ol className="workflow-cost-bars" aria-label="Top workflows by cost">
                    {summary.byWorkflow.slice(0, 5).map((workflow) => (
                      <li key={workflow.workflowId}>
                        <button
                          type="button"
                          aria-label={`Open ${workflow.workflowName} usage detail`}
                          onClick={() => {
                            onOpenWorkflow(workflow.workflowId, "usage");
                          }}
                        >
                          <span>{workflow.workflowName}</span>
                          <span className="workflow-cost-track">
                            <span
                              style={{
                                width: `${maxWorkflowCost > 0 ? (workflow.totalCostUsd / maxWorkflowCost) * 100 : 0}%`,
                              }}
                            />
                          </span>
                          <strong>
                            {formatReportedCost(
                              workflow.totalCostUsd,
                              workflow.unknownCostRunCount,
                              workflow.reportedCostRunCount,
                            )}
                          </strong>
                          {workflow.unknownCostRunCount > 0 && (
                            <small>Cost not reported · {workflow.unknownCostRunCount} run unknown</small>
                          )}
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : renderVisualizationState(chartState.dailyCost, {
                  nonReadyTitle: "Usage visualization unavailable",
                })}
                {summary.unknownCostRunCount > 0 && chartState.dailyCost.state === "ready" && (
                  <p className="usage-unknown-note">
                    <strong>No reported cost</strong>
                    <span>
                      {summary.unknownCostRunCount} run
                      {summary.unknownCostRunCount === 1 ? "" : "s"} unknown
                    </span>
                  </p>
                )}
              </div>

              <div className="usage-chart-panel">
                <div className="usage-chart-title">
                  <strong>Provider/model breakdown</strong>
                </div>
                {chartState.providerBreakdown.state === "ready" ? (
                  <table className="provider-model-table" aria-label="Provider/model breakdown">
                    <thead>
                      <tr>
                        <th>Provider/model</th>
                        <th>Cost</th>
                        <th>Tokens</th>
                        <th>Runs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byProviderModel.map((provider) => (
                        <tr key={`${provider.profileId}:${provider.model}`}>
                          <td>
                            {provider.providerName}
                            <small>{provider.model}</small>
                          </td>
                          <td>
                            {formatReportedCost(
                              provider.totalCostUsd,
                              provider.unknownCostRunCount,
                              provider.runCount - provider.unknownCostRunCount,
                            )}
                          </td>
                          <td>{formatTokenMetric(provider.totalTokens)}</td>
                          <td>
                            {provider.runCount}
                            {provider.unknownCostRunCount > 0 && (
                              <small>Cost missing: {provider.unknownCostRunCount}</small>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : renderVisualizationState(chartState.providerBreakdown, {
                  nonReadyTitle: "Usage visualization unavailable",
                })}
              </div>
            </div>

            <div className="budget-threshold-bar" data-budget-status={model.budget.status}>
              <div>
                <strong>{model.budget.label}</strong>
                <span>
                  {model.budget.percentUsed == null
                    ? "Configure a budget to show threshold progress and cost alerts."
                    : `${model.budget.percentUsed}% used`}
                </span>
              </div>
              <span className="budget-track" aria-hidden="true">
                <span style={{ width: `${Math.min(model.budget.percentUsed ?? 0, 100)}%` }} />
              </span>
            </div>

            <div className="usage-insight-grid">
              <section className="usage-insight-panel" aria-label="Usage forecast">
                <div className="usage-chart-title">
                  <TrendingUp size={16} />
                  <strong>Forecast</strong>
                </div>
                {chartState.forecast.state === "ready" ? (
                  <p>{`${formatCurrency(forecastCostUsd ?? 0)} projected for ${usagePeriodLabel(period)} at the current run rate.`}</p>
                ) : renderVisualizationState(chartState.forecast, {
                  nonReadyTitle: "Forecast unavailable",
                })}
                <label>
                  Budget threshold
                  <span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={budgetDraft}
                      onChange={(event) => setBudgetDraft(event.currentTarget.value)}
                      aria-label="Usage budget threshold"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const value = Number(budgetDraft);
                        const next = Number.isFinite(value) && value > 0 ? value : null;
                        setBudgetThresholdUsd(next);
                        if (next == null) localStorage.removeItem("raven_usage_budget_threshold_usd");
                        else localStorage.setItem("raven_usage_budget_threshold_usd", String(next));
                        window.dispatchEvent(new CustomEvent(USAGE_BUDGET_THRESHOLD_EVENT, { detail: next }));
                      }}
                    >
                      Save budget
                    </button>
                  </span>
                </label>
              </section>

              <section className="usage-insight-panel" aria-label="Anomaly detection">
                <strong>{anomaly.detected ? "Cost anomaly detected" : "No anomaly detected"}</strong>
                <p>
                  {anomaly.baselineRunCount > 0
                    ? `${anomaly.currentWindowLabel} averages ${formatCurrency(anomaly.currentAverageDailyUsd)} per day against ${formatCurrency(anomaly.baselineAverageDailyUsd)} per day from ${anomaly.baselineWindowLabel}.`
                    : `Baseline ${anomaly.baselineWindowLabel} has no reported cost yet.`}
                </p>
                <dl className="usage-anomaly-baseline">
                  <div>
                    <dt>Baseline</dt>
                    <dd>{anomaly.baselineDays} days · {anomaly.baselineRunCount} runs</dd>
                  </div>
                  <div>
                    <dt>Window</dt>
                    <dd>{anomaly.currentRunCount} runs</dd>
                  </div>
                  <div>
                    <dt>History source</dt>
                    <dd>{anomaly.source === "sqlite-workflow-runs" ? "Persisted backend runs" : "Loaded app state"}</dd>
                  </div>
                </dl>
                <label>
                  Multiplier
                  <input
                    type="number"
                    min="1.1"
                    step="0.1"
                    value={anomalyMultiplier}
                    onChange={(event) => {
                      const value = Number(event.currentTarget.value);
                      if (!Number.isFinite(value)) return;
                      setAnomalyMultiplier(value);
                      localStorage.setItem("raven_usage_anomaly_multiplier", String(value));
                    }}
                    aria-label="Anomaly multiplier"
                  />
                </label>
              </section>
            </div>

            <div className="usage-insight-grid">
              <section className="usage-insight-panel" aria-label="Cost per artifact">
                <strong>Cost per artifact</strong>
                <ol className="usage-mini-list">
                  {summary.byWorkflow.slice(0, 4).map((workflow) => {
                    const artifacts = artifactCountByWorkflow.get(workflow.workflowId) ?? 0;
                    return (
                      <li key={workflow.workflowId}>
                        <span>{workflow.workflowName}</span>
                        <strong>{artifacts > 0 ? formatCurrency(workflow.totalCostUsd / artifacts) : "No artifacts"}</strong>
                      </li>
                    );
                  })}
                </ol>
              </section>
              <section className="usage-insight-panel" aria-label="Cost waste analysis">
                <strong>Successful vs failed/retry cost</strong>
                <p>{formatCurrency(successfulCostUsd)} successful cost · {formatCurrency(wasteCostUsd)} failed/retry waste.</p>
                <small>Prompt, cache, and retry sub-costs are unavailable until providers report those fields.</small>
              </section>
              <section className="usage-insight-panel" aria-label="Model substitution suggestions">
                <div className="usage-chart-title">
                  <TrendingDown size={16} />
                  <strong>Model suggestions</strong>
                </div>
                <div className="usage-catalog-status">
                  <strong>{catalogStatusLabel(pricingCatalog)}</strong>
                  <span>
                    {pricingCatalog
                      ? `${formatCatalogDate(pricingCatalog.fetchedAt)} · Loaded ${formatCatalogDate(pricingCatalog.loadedAt).replace("Fetched ", "")}`
                      : "Backend pricing catalog could not be loaded."}
                  </span>
                </div>
                {modelRecommendations.length > 0 ? (
                  <ol className="usage-mini-list">
                    {modelRecommendations.slice(0, 3).map((recommendation) => (
                      <li key={`${recommendation.providerName}:${recommendation.currentModel}:${recommendation.suggestedModel}`}>
                        <span>
                          {recommendation.providerName}: {recommendation.currentModel} to {recommendation.suggestedModel}
                          <small>{recommendation.sourceLabel}</small>
                        </span>
                        <strong>
                          Save {recommendation.savingsPercent}% · {formatCurrency(recommendation.estimatedSuggestedCostUsd)}
                        </strong>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No lower-cost catalog match for this period's reported token mix.</p>
                )}
                <small>
                  Catalog estimates use reported input/output tokens when available and a 70/30 input/output fallback otherwise.
                </small>
              </section>
            </div>
      </section>
    );
  },
);
