import { useState } from "react";
import { CheckCircle2, XCircle, Loader, Wrench, Brain, RotateCcw } from "lucide-react";
import type {
  RunStreamState,
  AgentEvent,
  ApprovalRequest,
  CapabilityAuditEvent,
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowStepRun,
} from "../../domain/types";
import { formatRelativeTime, groupTraceEvents } from "../../domain/format";
import type { TraceGroup } from "../../domain/format";

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRunDuration(run: WorkflowRun): string | null {
  if (!run.completedAt) return null;
  const startedAt = new Date(run.startedAt).getTime();
  const completedAt = new Date(run.completedAt).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null;
  return formatElapsed(Math.max(0, completedAt - startedAt));
}

function formatStepDuration(step: WorkflowStepRun): string | null {
  if (!step.completedAt) return null;
  const startedAt = new Date(step.startedAt).getTime();
  const completedAt = new Date(step.completedAt).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null;
  return formatElapsed(Math.max(0, completedAt - startedAt));
}

function statusClass(status: WorkflowRun["status"]) {
  if (status === "succeeded") return "complete";
  if (status === "running") return "active";
  if (status === "failed" || status === "retryable" || status === "blocked") return "failed";
  return "queued";
}

function inferFailedStep(run: WorkflowRun, steps: WorkflowStepDefinition[]): string {
  if (run.requiredProviderId) {
    const step = steps.find(
      (candidate) =>
        candidate.provider === run.requiredProviderId ||
        candidate.destinationRef === run.requiredProviderId,
    );
    if (step) return step.name;
  }

  if (run.requiredProfileId) {
    const step = steps.find((candidate) => candidate.llmProfileRef === run.requiredProfileId);
    if (step) return step.name;
  }

  return "Workflow run";
}

function recoveryAction(run: WorkflowRun): string {
  return (
    run.setupAction ??
    run.blockedReason ??
    run.failureReason ??
    (run.status === "retryable" ? "Retry when the dependency is available." : "Review the run details.")
  );
}

function policyDecisionLabel(decision: CapabilityAuditEvent["decision"]): string {
  switch (decision) {
    case "auto":
      return "Allowed automatically";
    case "needs_grant":
      return "Needs pre-approval";
    case "blocked":
    case "hidden":
      return "Blocked";
    default:
      return String(decision).replace(/_/g, " ");
  }
}

interface RunTraceRowProps {
  run: WorkflowRun;
  steps: WorkflowStepDefinition[];
  stepRuns?: WorkflowStepRun[];
  onRetry?: (runId: string) => void;
  onRepair?: (runId: string) => void;
  focused?: boolean;
}

function RunTraceRow({ run, steps, stepRuns = [], onRetry, onRepair, focused = false }: RunTraceRowProps) {
  const duration = formatRunDuration(run);
  const isRecoverable = ["failed", "retryable", "blocked"].includes(run.status);
  const Icon = run.status === "succeeded" ? CheckCircle2 : isRecoverable ? XCircle : Loader;
  const stepNames = new Map(steps.map((step) => [step.id, step.name]));
  const completedStepRuns = stepRuns.filter((step) => step.completedAt);

  return (
    <article
      className={`trace-run trace-run-${statusClass(run.status)}${focused ? " trace-run-focused" : ""}`}
      aria-label={`${focused ? "Selected " : ""}Run ${run.id}`}
    >
      <div className="trace-run-header">
        <Icon size={16} aria-hidden="true" />
        <div>
          <strong>{run.workflowName}</strong>
          <span>
            {statusClass(run.status) === "active" ? "Running" : run.status.replace(/_/g, " ")} -{" "}
            {formatRelativeTime(run.startedAt)}
          </span>
        </div>
        {duration && <span className="trace-step-elapsed">{duration}</span>}
      </div>
      {run.status === "succeeded" && (
        <div className="trace-run-detail">
          {duration ? (
            <span>Run duration {duration}</span>
          ) : (
            <span>Run duration was not reported.</span>
          )}
          {run.totalTokens != null && <span>{run.totalTokens.toLocaleString()} tokens</span>}
          {run.totalCostUsd != null && <span>${run.totalCostUsd.toFixed(4)}</span>}
          {completedStepRuns.length > 0 ? (
            completedStepRuns.map((step) => (
              <span key={step.id}>
                {stepNames.get(step.stepId) ?? step.stepId}: {formatStepDuration(step) ?? "not reported"}
              </span>
            ))
          ) : (
            <span>Step timing has not been reported for this run.</span>
          )}
        </div>
      )}
      {isRecoverable && (
        <div className="trace-run-detail trace-run-recovery">
          <span>Failed step: {inferFailedStep(run, steps)}</span>
          <span>Recovery: {recoveryAction(run)}</span>
          {onRetry && (
            <button type="button" onClick={() => onRetry(run.id)}>
              <RotateCcw size={14} />
              Retry
            </button>
          )}
          {onRepair && (
            <button type="button" className="assistant-repair-chip" onClick={() => onRepair(run.id)}>
              <Wrench size={14} />
              Ask assistant to repair
            </button>
          )}
        </div>
      )}
    </article>
  );
}

interface ExecutionGraphProps {
  run?: WorkflowRun;
  steps: WorkflowStepDefinition[];
  stepRuns: WorkflowStepRun[];
}

function ExecutionGraph({ run, steps, stepRuns }: ExecutionGraphProps) {
  if (!run || steps.length === 0) return null;
  const stepRunByStepId = new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
  const stepNameById = new Map(steps.map((step) => [step.id, step.name]));

  return (
    <section className="trace-execution-graph" aria-label="Workflow execution graph">
      <div className="trace-section-label">Execution graph</div>
      <ol>
        {steps.map((step) => {
          const stepRun = stepRunByStepId.get(step.id);
          const status = stepRun?.status ?? "not run";
          const dependencies = step.dependsOn
            .map((dependencyId) => stepNameById.get(dependencyId) ?? dependencyId)
            .join(", ");
          return (
            <li key={step.id}>
              <strong>{step.name}</strong>
              <span>{dependencies ? `After ${dependencies}` : "Starts workflow"}</span>
              <small>{status.replace(/_/g, " ")}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}



/* ------------------------------------------------------------------ */
/*  ToolCallCard                                                        */
/* ------------------------------------------------------------------ */

interface ToolCallCardProps {
  event: AgentEvent;
}

function ToolCallCard({ event }: ToolCallCardProps) {
  const payload =
    event.kind === "TOOL_CALL_START"
      ? event.args
      : event.kind === "TOOL_CALL_END"
        ? event.result
        : null;

  return (
    <details className="tool-call-card">
      <summary>
        <Wrench size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: "0.3rem" }} />
        {event.toolName ?? "tool"}
      </summary>
      {payload != null && (
        <pre>{typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)}</pre>
      )}
    </details>
  );
}

/* ------------------------------------------------------------------ */
/*  ThinkingBlock                                                       */
/* ------------------------------------------------------------------ */

interface ThinkingBlockProps {
  text: string;
  index: number;
}

function ThinkingBlock({ text, index }: ThinkingBlockProps) {
  return (
    <p key={index} className="thinking-block">
      <Brain size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: "0.3rem" }} />
      {text}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/*  TraceGroupRow                                                       */
/* ------------------------------------------------------------------ */

interface TraceGroupRowProps {
  group: TraceGroup;
  mode: "compact" | "detailed";
}

function TraceGroupRow({ group, mode }: TraceGroupRowProps) {
  const statusClass = `trace-group-${group.status}`;

  const Icon =
    group.status === "complete"
      ? CheckCircle2
      : group.status === "failed"
        ? XCircle
        : Loader;

  const hasDetail =
    group.toolCalls.length > 0 ||
    group.thinkingBlocks.length > 0 ||
    group.tokenCount != null;

  return (
    <details className={`trace-group ${statusClass}`} open={mode === "detailed"}>
      <summary className="trace-group-header">
        <Icon size={16} />
        <strong>{group.stepName}</strong>
        {group.durationMs != null && (
          <span className="trace-step-elapsed">{formatElapsed(group.durationMs)}</span>
        )}
        {group.tokenCount != null && (
          <span className="trace-step-elapsed" style={{ color: "var(--muted)" }}>
            {group.tokenCount.toLocaleString()} tok
          </span>
        )}
      </summary>
      {hasDetail && (
        <div className="trace-group-detail">
          {group.thinkingBlocks.map((text, i) => (
            <ThinkingBlock key={i} text={text} index={i} />
          ))}
          {group.toolCalls.map((event, i) => (
            <ToolCallCard key={i} event={event} />
          ))}
        </div>
      )}
    </details>
  );
}

/* ------------------------------------------------------------------ */
/*  TraceTimeline                                                       */
/* ------------------------------------------------------------------ */

export interface TraceTimelineProps {
  runStream?: RunStreamState;
  runs?: WorkflowRun[];
  approvalAudit?: ApprovalRequest[];
  capabilityAudit?: CapabilityAuditEvent[];
  workflowSteps?: WorkflowStepDefinition[];
  stepRunsByRunId?: Record<string, WorkflowStepRun[]>;
  onRetry?: (runId: string) => void;
  onRepair?: (runId?: string) => void;
  focusedRunId?: string;
  limit?: number;
}

export function TraceTimeline({
  runStream,
  runs = [],
  approvalAudit = [],
  capabilityAudit = [],
  workflowSteps = [],
  stepRunsByRunId = {},
  onRetry,
  onRepair,
  focusedRunId,
  limit = 6,
}: TraceTimelineProps) {
  const [mode, setMode] = useState<"compact" | "detailed">("compact");
  const groups = runStream
    ? groupTraceEvents(
        runStream.activeSteps,
        runStream.toolCalls,
        runStream.thinkingBlocks,
      )
    : [];
  const sortedRuns = [...runs]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
  const focusedRun = focusedRunId ? sortedRuns.find((run) => run.id === focusedRunId) : undefined;
  const recentRuns = [
    ...(focusedRun ? [focusedRun] : []),
    ...sortedRuns.filter((run) => run.id !== focusedRunId),
  ].slice(0, limit);
  const visibleRunIds = new Set(recentRuns.map((run) => run.id));
  const visibleApprovalAudit = approvalAudit
    .filter((approval) => approval.status !== "pending")
    .filter((approval) => visibleRunIds.size === 0 || visibleRunIds.has(approval.runId))
    .sort((a, b) => new Date(b.resolvedAt ?? b.createdAt).getTime() - new Date(a.resolvedAt ?? a.createdAt).getTime())
    .slice(0, limit);
  const visibleCapabilityAudit = capabilityAudit
    .filter((event) => visibleRunIds.size === 0 || visibleRunIds.has(event.runId))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
  const graphRun = focusedRun ?? recentRuns[0];
  const graphStepRuns = graphRun ? stepRunsByRunId[graphRun.id] ?? [] : [];

  return (
    <div className="trace-timeline">
      {runStream?.activeRunId && (
        <div className="trace-section-label">Active run</div>
      )}
      {groups.length > 0 && (
        <div className="trace-mode-toggle">
          <button
            type="button"
            className={mode === "compact" ? "active" : ""}
            onClick={() => setMode("compact")}
          >
            Compact
          </button>
          <button
            type="button"
            className={mode === "detailed" ? "active" : ""}
            onClick={() => setMode("detailed")}
          >
            Detailed
          </button>
        </div>
      )}

      {groups.map((group) => (
        <TraceGroupRow key={group.stepId} group={group} mode={mode} />
      ))}

      {runStream?.runError && (
        <div className="trace-group trace-group-failed">
          <div className="trace-group-header">
            <XCircle size={16} />
            <strong>{runStream.runError}</strong>
            {onRepair && (
              <button type="button" className="assistant-repair-chip" onClick={() => onRepair(runStream.activeRunId ?? undefined)}>
                <Wrench size={14} />
                Ask assistant to repair
              </button>
            )}
          </div>
        </div>
      )}

      {runStream && (runStream.totalTokens > 0 || runStream.totalCostUsd > 0) && (
        <div className="trace-footer">
          {runStream.totalTokens > 0 && (
            <span>{runStream.totalTokens.toLocaleString()} tokens</span>
          )}
          {runStream.totalCostUsd > 0 && (
            <span>${runStream.totalCostUsd.toFixed(4)}</span>
          )}
        </div>
      )}

      {recentRuns.length > 0 && (
        <>
          <div className="trace-section-label">Recent runs</div>
          {recentRuns.map((run) => (
            <RunTraceRow
              key={run.id}
              run={run}
              steps={workflowSteps}
              stepRuns={stepRunsByRunId[run.id] ?? []}
              onRetry={onRetry}
              onRepair={onRepair ? (runId) => onRepair(runId) : undefined}
              focused={run.id === focusedRunId}
            />
          ))}
        </>
      )}

      <ExecutionGraph run={graphRun} steps={workflowSteps} stepRuns={graphStepRuns} />

      {visibleApprovalAudit.length > 0 && (
        <section className="trace-approval-audit" aria-label="Approval decision audit trail">
          <div className="trace-section-label">Approval decisions</div>
          <ol>
            {visibleApprovalAudit.map((approval) => (
              <li key={approval.id}>
                <strong>{approval.workflowName} {approval.status}</strong>
                <span>{formatRelativeTime(approval.resolvedAt ?? approval.createdAt)}</span>
                <small>{approval.description}</small>
                {approval.decisionReason && <small>Reason: {approval.decisionReason}</small>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {visibleCapabilityAudit.length > 0 && (
        <section className="trace-capability-audit" aria-label="Capability policy audit trail">
          <div className="trace-section-label">Capability policy</div>
          <ol>
            {visibleCapabilityAudit.map((event) => (
              <li key={event.id}>
                <strong>{event.capabilityId}</strong>
                <span>{policyDecisionLabel(event.decision)}</span>
                {event.grantId && <small>Grant {event.grantId}</small>}
                <small>{event.reason}</small>
                <small>{formatRelativeTime(event.createdAt)}</small>
              </li>
            ))}
          </ol>
        </section>
      )}

      {groups.length === 0 && recentRuns.length === 0 && (
        <p className="empty-state">No runs yet. Run this workflow to start the trace.</p>
      )}
    </div>
  );
}
