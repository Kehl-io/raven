import { describe, expect, it } from "vitest";
import type { AgentAuthProfile, AgentEvent, StepState, WorkflowRun } from "./types";
import {
  buildRunWorkflowMap,
  estimateCost,
  formatRelativeTime,
  formatSchedule,
  getNextRunTime,
  groupProviderProfiles,
  groupTraceEvents,
} from "./format";

describe("formatSchedule", () => {
  it("returns 'Run manually' for undefined schedule", () => {
    expect(formatSchedule(undefined)).toBe("Run manually");
  });

  it("returns 'Run manually' for cadence 'manual'", () => {
    expect(formatSchedule({ cadence: "manual" })).toBe("Run manually");
  });

  it("returns 'Every day at {time}' for daily with localTime in 12h format", () => {
    expect(formatSchedule({ cadence: "daily", localTime: "09:00" })).toBe("Every day at 9:00 AM");
  });

  it("returns 'Every day' for daily without localTime", () => {
    expect(formatSchedule({ cadence: "daily" })).toBe("Every day");
  });

  it("returns 'Weekdays at {time}' for weekdays with localTime in 12h format", () => {
    expect(formatSchedule({ cadence: "weekdays", localTime: "17:00" })).toBe("Weekdays at 5:00 PM");
  });

  it("returns 'Weekdays' for weekdays without localTime", () => {
    expect(formatSchedule({ cadence: "weekdays" })).toBe("Weekdays");
  });

  it("converts midnight correctly", () => {
    expect(formatSchedule({ cadence: "daily", localTime: "00:00" })).toBe("Every day at 12:00 AM");
  });

  it("converts noon correctly", () => {
    expect(formatSchedule({ cadence: "daily", localTime: "12:00" })).toBe("Every day at 12:00 PM");
  });

  it("returns '{cadence} at {time}' for unknown cadence with localTime", () => {
    expect(formatSchedule({ cadence: "hourly" as "manual", localTime: "08:30" })).toBe("hourly at 8:30 AM");
  });

  it("returns cadence string for unknown cadence without localTime", () => {
    expect(formatSchedule({ cadence: "monthly" as "manual" })).toBe("monthly");
  });
});

describe("formatRelativeTime", () => {
  it("returns empty string for empty input", () => {
    expect(formatRelativeTime("")).toBe("");
  });

  it("returns 'just now' for times less than 60 seconds ago", () => {
    const now = new Date();
    const thirtySecondsAgo = new Date(now.getTime() - 30_000).toISOString();
    expect(formatRelativeTime(thirtySecondsAgo)).toBe("just now");
  });

  it("returns '{N}m ago' for times less than 60 minutes ago", () => {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinutesAgo)).toBe("5m ago");
  });

  it("returns '{N}h ago' for times less than 24 hours ago", () => {
    const now = new Date();
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe("3h ago");
  });

  it("returns '{N}d ago' for times 24 or more hours ago", () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(twoDaysAgo)).toBe("2d ago");
  });

  it("returns 'just now' for exactly 59 seconds ago", () => {
    const now = new Date();
    const fiftyNineSecondsAgo = new Date(now.getTime() - 59_000).toISOString();
    expect(formatRelativeTime(fiftyNineSecondsAgo)).toBe("just now");
  });

  it("returns '1m ago' for exactly 60 seconds ago", () => {
    const now = new Date();
    const sixtySecondsAgo = new Date(now.getTime() - 60_000).toISOString();
    expect(formatRelativeTime(sixtySecondsAgo)).toBe("1m ago");
  });
});

describe("getNextRunTime", () => {
  it("returns null for undefined schedule", () => {
    expect(getNextRunTime(undefined)).toBeNull();
  });

  it("returns null for manual cadence", () => {
    expect(getNextRunTime({ cadence: "manual" })).toBeNull();
  });

  it("returns null for daily without localTime", () => {
    expect(getNextRunTime({ cadence: "daily" })).toBeNull();
  });

  it("returns an ISO string for daily with localTime", () => {
    const result = getNextRunTime({ cadence: "daily", localTime: "09:00" });
    expect(result).not.toBeNull();
    expect(() => new Date(result!)).not.toThrow();
    expect(new Date(result!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("returns a time within the next 24 hours for daily", () => {
    const result = getNextRunTime({ cadence: "daily", localTime: "09:00" });
    expect(result).not.toBeNull();
    const next = new Date(result!).getTime();
    const now = Date.now();
    expect(next).toBeGreaterThan(now - 1000);
    expect(next).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000 + 1000);
  });

  it("returns a time within the next 7 days for weekdays", () => {
    const result = getNextRunTime({ cadence: "weekdays", localTime: "08:00" });
    expect(result).not.toBeNull();
    const next = new Date(result!).getTime();
    const now = Date.now();
    expect(next).toBeGreaterThan(now - 1000);
    expect(next).toBeLessThanOrEqual(now + 7 * 24 * 60 * 60 * 1000 + 1000);
  });

  it("returns a weekday for weekdays schedule", () => {
    const result = getNextRunTime({ cadence: "weekdays", localTime: "08:00" });
    expect(result).not.toBeNull();
    const dayOfWeek = new Date(result!).getDay();
    expect(dayOfWeek).toBeGreaterThanOrEqual(1);
    expect(dayOfWeek).toBeLessThanOrEqual(5);
  });
});

const makeProfile = (
  overrides: Partial<AgentAuthProfile> & Pick<AgentAuthProfile, "id" | "runnerKind">,
): AgentAuthProfile => ({
  displayName: overrides.id,
  authMode: "api_key_env",
  credentialRef: "test-ref",
  model: "gpt-4",
  effort: "medium",
  status: "needs_config",
  summary: "",
  ...overrides,
});

describe("groupProviderProfiles", () => {
  it("returns empty array for empty input", () => {
    expect(groupProviderProfiles([])).toEqual([]);
  });

  it("groups claude_code_cli and anthropic_api under Anthropic", () => {
    const profiles = [
      makeProfile({ id: "a", runnerKind: "claude_code_cli" }),
      makeProfile({ id: "b", runnerKind: "anthropic_api" }),
    ];
    const groups = groupProviderProfiles(profiles);
    const anthropic = groups.find((g) => g.groupName === "Anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.profiles).toHaveLength(2);
  });

  it("groups codex_cli and openai_api under OpenAI", () => {
    const profiles = [
      makeProfile({ id: "c", runnerKind: "codex_cli" }),
      makeProfile({ id: "d", runnerKind: "openai_api" }),
    ];
    const groups = groupProviderProfiles(profiles);
    const openai = groups.find((g) => g.groupName === "OpenAI");
    expect(openai).toBeDefined();
    expect(openai!.profiles).toHaveLength(2);
  });

  it("sets isReady to true when any profile has status 'available'", () => {
    const profiles = [
      makeProfile({ id: "e", runnerKind: "anthropic_api", status: "available" }),
      makeProfile({ id: "f", runnerKind: "anthropic_api", status: "needs_config" }),
    ];
    const groups = groupProviderProfiles(profiles);
    const anthropic = groups.find((g) => g.groupName === "Anthropic");
    expect(anthropic!.isReady).toBe(true);
  });

  it("sets isReady to false when no profiles are available", () => {
    const profiles = [makeProfile({ id: "g", runnerKind: "openai_api", status: "degraded" })];
    const groups = groupProviderProfiles(profiles);
    const openai = groups.find((g) => g.groupName === "OpenAI");
    expect(openai!.isReady).toBe(false);
  });

  it("sets primaryProfile to the first available profile", () => {
    const profiles = [
      makeProfile({ id: "h", runnerKind: "anthropic_api", status: "needs_config" }),
      makeProfile({ id: "i", runnerKind: "anthropic_api", status: "available" }),
      makeProfile({ id: "j", runnerKind: "anthropic_api", status: "available" }),
    ];
    const groups = groupProviderProfiles(profiles);
    const anthropic = groups.find((g) => g.groupName === "Anthropic");
    expect(anthropic!.primaryProfile?.id).toBe("i");
  });

  it("sets primaryProfile to undefined when no profiles are available", () => {
    const profiles = [makeProfile({ id: "k", runnerKind: "codex_cli", status: "unavailable" })];
    const groups = groupProviderProfiles(profiles);
    const openai = groups.find((g) => g.groupName === "OpenAI");
    expect(openai!.primaryProfile).toBeUndefined();
  });

  it("creates separate groups for Anthropic and OpenAI", () => {
    const profiles = [
      makeProfile({ id: "l", runnerKind: "claude_code_cli" }),
      makeProfile({ id: "m", runnerKind: "openai_api" }),
    ];
    const groups = groupProviderProfiles(profiles);
    expect(groups).toHaveLength(2);
    const names = groups.map((g) => g.groupName);
    expect(names).toContain("Anthropic");
    expect(names).toContain("OpenAI");
  });
});

describe("groupTraceEvents", () => {
  it("groups tool calls by stepId", () => {
    const steps = new Map<string, StepState>([
      ["s1", { stepId: "s1", stepName: "Collect context", status: "complete", startedAt: "2026-01-01T00:00:00Z", durationMs: 1200, tokenCount: 423 }],
      ["s2", { stepId: "s2", stepName: "Generate artifact", status: "active", startedAt: "2026-01-01T00:00:01Z" }],
    ]);
    const toolCalls: AgentEvent[] = [
      { kind: "TOOL_CALL_START", runId: "r1", stepId: "s2", toolName: "openai.generate", toolCallId: "tc1", timestamp: "" },
      { kind: "TOOL_CALL_END", runId: "r1", stepId: "s2", toolName: "openai.generate", toolCallId: "tc1", result: "done", durationMs: 800, timestamp: "" },
    ];
    const groups = groupTraceEvents(steps, toolCalls, ["Reasoning..."]);
    expect(groups).toHaveLength(2);
    expect(groups[0].stepName).toBe("Collect context");
    expect(groups[0].toolCalls).toHaveLength(0);
    expect(groups[0].tokenCount).toBe(423);
    expect(groups[1].stepName).toBe("Generate artifact");
    expect(groups[1].toolCalls).toHaveLength(2);
    expect(groups[1].thinkingBlocks).toHaveLength(1);
  });

  it("returns empty array for empty inputs", () => {
    expect(groupTraceEvents(new Map(), [], [])).toEqual([]);
  });

  it("handles steps with no tool calls", () => {
    const steps = new Map<string, StepState>([
      ["s1", { stepId: "s1", stepName: "Simple step", status: "complete", startedAt: "" }],
    ]);
    const groups = groupTraceEvents(steps, [], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].toolCalls).toHaveLength(0);
    expect(groups[0].thinkingBlocks).toHaveLength(0);
  });
});

describe("estimateCost", () => {
  it("estimates cost for known model", () => {
    const cost = estimateCost("gpt-4.1", 1000, 500);
    expect(cost).toBeCloseTo((1000 / 1_000_000) * 2 + (500 / 1_000_000) * 8, 6);
  });
  it("returns 0 for unknown models", () => {
    expect(estimateCost("unknown-model", 1000, 500)).toBe(0);
  });
  it("returns 0 for ollama models", () => {
    expect(estimateCost("llama3.1:8b", 1000, 500)).toBe(0);
  });
});

describe("buildRunWorkflowMap", () => {
  it("returns an empty map for empty input", () => {
    expect(buildRunWorkflowMap([])).toEqual(new Map());
  });

  it("maps runId to workflowId", () => {
    const runs: Pick<WorkflowRun, "id" | "workflowId">[] = [
      { id: "run-1", workflowId: "wf-a" },
      { id: "run-2", workflowId: "wf-b" },
    ];
    const map = buildRunWorkflowMap(runs);
    expect(map.get("run-1")).toBe("wf-a");
    expect(map.get("run-2")).toBe("wf-b");
  });

  it("handles multiple runs for the same workflow", () => {
    const runs: Pick<WorkflowRun, "id" | "workflowId">[] = [
      { id: "run-1", workflowId: "wf-a" },
      { id: "run-2", workflowId: "wf-a" },
      { id: "run-3", workflowId: "wf-a" },
    ];
    const map = buildRunWorkflowMap(runs);
    expect(map.size).toBe(3);
    expect(map.get("run-1")).toBe("wf-a");
    expect(map.get("run-3")).toBe("wf-a");
  });

  it("returns a Map instance", () => {
    const runs: Pick<WorkflowRun, "id" | "workflowId">[] = [{ id: "run-1", workflowId: "wf-a" }];
    expect(buildRunWorkflowMap(runs)).toBeInstanceOf(Map);
  });
});
