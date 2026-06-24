import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentEvent, ApprovalRequest, RunStreamState, StepState } from "../../domain/types";
import { listPendingApprovals, runWorkflowStreamed } from "../tauriBridge";

interface RunStreamActions {
  startStreamedRun: (workflowId: string) => Promise<import("../../domain/types").WorkflowRunResult | null>;
  clearStream: () => void;
}

type RunStreamContextValue = { runStream: RunStreamState } & RunStreamActions;

const RunStreamContext = createContext<RunStreamContextValue | null>(null);

const INITIAL_STATE: RunStreamState = {
  activeRunId: null,
  activeSteps: new Map(),
  tokenBuffer: "",
  toolCalls: [],
  thinkingBlocks: [],
  pendingApproval: null,
  runError: null,
  totalTokens: 0,
  totalCostUsd: 0,
};

const terminalRunStatuses = new Set(["succeeded", "failed", "retryable", "blocked"]);

export function RunStreamProvider({ children }: { children: ReactNode }) {
  const [runStream, setRunStream] = useState<RunStreamState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    void listPendingApprovals().then((approvals) => {
      if (cancelled || approvals.length === 0) return;
      const approval = approvals[0];
      setRunStream((prev) => ({
        ...prev,
        activeRunId: approval.runId,
        pendingApproval: approval,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const processEvent = useCallback((event: AgentEvent) => {
    setRunStream((prev) => {
      switch (event.kind) {
        case "RUN_STARTED":
          return { ...INITIAL_STATE, activeRunId: event.runId };
        case "STEP_STARTED": {
          if (!event.stepId) return prev;
          const steps = new Map(prev.activeSteps);
          steps.set(event.stepId, {
            stepId: event.stepId,
            stepName: event.stepName ?? "",
            status: "active",
            startedAt: event.timestamp,
          } satisfies StepState);
          return { ...prev, activeSteps: steps };
        }
        case "TEXT_MESSAGE_CONTENT":
          return { ...prev, tokenBuffer: (prev.tokenBuffer + (event.content ?? "")).slice(-2400) };
        case "TOOL_CALL_START":
        case "TOOL_CALL_END":
          return { ...prev, toolCalls: [...prev.toolCalls, event] };
        case "THINKING_CONTENT":
          return { ...prev, thinkingBlocks: [...prev.thinkingBlocks, event.content ?? ""] };
        case "STEP_FINISHED": {
          if (!event.stepId) return prev;
          const steps = new Map(prev.activeSteps);
          const existing = steps.get(event.stepId);
          if (existing) {
            steps.set(event.stepId, {
              ...existing,
              status: "complete",
              durationMs: event.durationMs,
              tokenCount: event.tokenCount,
            });
          }
          return {
            ...prev,
            activeSteps: steps,
          };
        }
        case "RUN_FINISHED":
          return {
            ...prev,
            activeRunId: null,
            totalTokens: event.tokenCount ?? prev.totalTokens,
            totalCostUsd: event.estimatedCostUsd ?? prev.totalCostUsd,
          };
        case "RUN_ERROR":
          return { ...prev, activeRunId: null, runError: event.error ?? "Run failed" };
        case "INTERRUPT":
          return {
            ...prev,
            pendingApproval: {
              id: event.approvalId ?? "",
              runId: event.runId,
              stepId: event.stepId ?? "",
              workflowName: event.workflowName ?? "",
              description: event.description ?? "",
              riskLevel: (event.riskLevel ?? "normal") as ApprovalRequest["riskLevel"],
              status: "pending",
              createdAt: event.timestamp,
            },
          };
        default:
          return prev;
      }
    });
  }, []);

  const startStreamedRun = useCallback(async (workflowId: string) => {
    setRunStream(INITIAL_STATE);
    const result = await runWorkflowStreamed(workflowId, processEvent);
    if (result?.run && terminalRunStatuses.has(result.run.status)) {
      setRunStream((prev) =>
        prev.activeRunId === result.run.id
          ? {
              ...prev,
              activeRunId: null,
              runError:
                result.run.status === "failed" || result.run.status === "blocked"
                  ? result.run.failureReason ?? result.run.blockedReason ?? prev.runError
                  : prev.runError,
            }
          : prev,
      );
    }
    return result;
  }, [processEvent]);

  const clearStream = useCallback(() => {
    setRunStream(INITIAL_STATE);
  }, []);

  const value = useMemo<RunStreamContextValue>(
    () => ({ runStream, startStreamedRun, clearStream }),
    [runStream, startStreamedRun, clearStream],
  );

  return <RunStreamContext.Provider value={value}>{children}</RunStreamContext.Provider>;
}

export function useRunStream(): RunStreamContextValue {
  const ctx = useContext(RunStreamContext);
  if (!ctx) throw new Error("useRunStream must be used within RunStreamProvider");
  return ctx;
}
