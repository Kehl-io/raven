import type { AgentAuthProfile, AgentEvent, RavenWorkflow, StepState, WorkflowRun } from "./types";

export interface TraceGroup {
  stepId: string;
  stepName: string;
  status: StepState["status"];
  durationMs?: number;
  tokenCount?: number;
  toolCalls: AgentEvent[];
  thinkingBlocks: string[];
}

export function groupTraceEvents(
  steps: Map<string, StepState>,
  toolCalls: AgentEvent[],
  thinkingBlocks: string[],
): TraceGroup[] {
  const groups: TraceGroup[] = [];
  for (const [stepId, step] of steps) {
    groups.push({
      stepId,
      stepName: step.stepName,
      status: step.status,
      durationMs: step.durationMs,
      tokenCount: step.tokenCount,
      toolCalls: toolCalls.filter((tc) => tc.stepId === stepId),
      thinkingBlocks: [],
    });
  }
  if (groups.length > 0 && thinkingBlocks.length > 0) {
    groups[groups.length - 1].thinkingBlocks = thinkingBlocks;
  }
  return groups;
}

export interface ProviderGroup {
  groupName: string;
  profiles: AgentAuthProfile[];
  isReady: boolean;
  primaryProfile: AgentAuthProfile | undefined;
}

type Schedule = RavenWorkflow["schedule"];

function formatTime12h(time24: string): string {
  const [hStr, mStr] = time24.split(":");
  const h = parseInt(hStr, 10);
  if (isNaN(h)) return time24;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${mStr ?? "00"} ${period}`;
}

export function formatSchedule(schedule: Schedule): string {
  if (!schedule || schedule.cadence === "manual") return "Run manually";

  const { cadence, localTime } = schedule;
  const displayTime = localTime ? formatTime12h(localTime) : undefined;

  if (cadence === "daily") {
    return displayTime ? `Every day at ${displayTime}` : "Every day";
  }

  if (cadence === "weekdays") {
    return displayTime ? `Weekdays at ${displayTime}` : "Weekdays";
  }

  return displayTime ? `${cadence} at ${displayTime}` : cadence;
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return "";

  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) return "just now";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function getNextRunTime(schedule: Schedule): string | null {
  if (!schedule || schedule.cadence === "manual") return null;
  if (!schedule.localTime) return null;

  const [hoursStr, minutesStr] = schedule.localTime.split(":");
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);

  const now = new Date();

  if (schedule.cadence === "daily") {
    const candidate = new Date(now);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.toISOString();
  }

  if (schedule.cadence === "weekdays") {
    const candidate = new Date(now);
    candidate.setHours(hours, minutes, 0, 0);

    // Advance until we land on a weekday that is in the future
    for (let i = 0; i < 7; i++) {
      const day = candidate.getDay();
      const isWeekday = day >= 1 && day <= 5;
      if (isWeekday && candidate.getTime() > now.getTime()) {
        return candidate.toISOString();
      }
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(hours, minutes, 0, 0);
    }

    return candidate.toISOString();
  }

  return null;
}

const RUNNER_KIND_TO_GROUP: Record<AgentAuthProfile["runnerKind"], string> = {
  claude_code_cli: "Anthropic",
  anthropic_api: "Anthropic",
  codex_cli: "OpenAI",
  openai_api: "OpenAI",
  ollama_local: "Local AI",
};

export function groupProviderProfiles(profiles: AgentAuthProfile[]): ProviderGroup[] {
  const groupMap = new Map<string, AgentAuthProfile[]>();

  for (const profile of profiles) {
    const groupName = RUNNER_KIND_TO_GROUP[profile.runnerKind];
    if (!groupName) continue;

    const existing = groupMap.get(groupName);
    if (existing) {
      existing.push(profile);
    } else {
      groupMap.set(groupName, [profile]);
    }
  }

  const groups: ProviderGroup[] = [];
  for (const [groupName, groupProfiles] of groupMap) {
    const primaryProfile = groupProfiles.find((p) => p.status === "available");
    groups.push({
      groupName,
      profiles: groupProfiles,
      isReady: primaryProfile !== undefined,
      primaryProfile,
    });
  }

  return groups;
}

export function buildRunWorkflowMap(
  runs: Pick<WorkflowRun, "id" | "workflowId">[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const run of runs) {
    map.set(run.id, run.workflowId);
  }
  return map;
}

// Keep in sync with current model pricing. Prices are per 1M tokens.
// Ollama and unknown models default to $0.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-5.4": { input: 3, output: 12 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-6": { input: 15, output: 75 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
