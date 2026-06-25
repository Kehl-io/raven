import { describe, expect, it } from "vitest";
import {
  currentWeatherWorkflow,
  dailyWorkJournalWorkflow,
  morningBriefWorkflow,
} from "../../domain/workflow";
import type {
  AgentAuthProfile,
  AppState,
  CommandCenterTarget,
  LlmProfile,
  PluginManifest,
  ProviderHealth,
  RavenWorkflow,
  WorkflowRun,
  WorkflowVersion,
} from "../../domain/types";
import {
  COMMAND_CENTER_TARGETS,
  buildAssistantSuggestions,
  buildCommandCenterBreadcrumbs,
  buildCommandCenterPriority,
  buildLiveApprovalPriority,
  buildScheduleEntries,
  buildScheduleTimelineModel,
  buildUsageCommandPanelModel,
  buildUsageSummary,
  isUsagePeriod,
  deriveProviderReadiness,
  deriveWorkflowHealth,
  deriveWorkflowOperationalStatus,
  isCommandCenterTarget,
} from "./commandCenter";

const provider = (
  id: string,
  status: ProviderHealth["status"] = "available",
  kind: ProviderHealth["kind"] = "llm",
): ProviderHealth => ({
  id,
  name: id,
  kind,
  status,
  summary: `${id} ${status}`,
});

const openAiProfile: LlmProfile = {
  id: "default-openai",
  providerId: "openai",
  model: "gpt-4.1",
  effort: "medium",
  supportsStructuredOutputs: true,
};

const codexProfile: AgentAuthProfile = {
  id: "codex-oauth-local",
  displayName: "Codex",
  runnerKind: "codex_cli",
  authMode: "codex_oauth_local_cli",
  credentialRef: "codex:oauth:local-cli",
  model: "gpt-5.4",
  effort: "medium",
  status: "available",
  summary: "Ready",
};

const deterministicArtifactPlugin: PluginManifest = {
  id: "deterministic_artifact",
  name: "Deterministic Artifact",
  version: "0.1.0",
  description: "Builds deterministic test artifacts.",
  steps: [
    {
      kind: "provider_action",
      provider: "deterministic_artifact",
      action: "build_artifact",
      displayName: "Build artifact",
      permissions: ["plugin:execute"],
      inputSchema: { type: "object", required: ["subject"] },
      outputSchema: { type: "object" },
    },
  ],
};

function workflowVersion(
  definition: RavenWorkflow,
  status: WorkflowVersion["status"] = "enabled",
): WorkflowVersion {
  return {
    id: `${definition.id}-v1`,
    workflowId: definition.id,
    version: 1,
    status,
    approvalMode: "always_review",
    definition,
    createdAt: "2026-06-19T08:00:00.000Z",
  };
}

function run(
  overrides: Partial<WorkflowRun> & Pick<WorkflowRun, "workflowId" | "status">,
): WorkflowRun {
  const { workflowId, status, ...rest } = overrides;
  return {
    id: `${workflowId}-${status}`,
    workflowId,
    workflowName: workflowId,
    status,
    startedAt: "2026-06-19T09:00:00.000Z",
    idempotencyKey: `${workflowId}:${status}`,
    ...rest,
  };
}

function appState(overrides: Partial<AppState> = {}): AppState {
  const defaults: AppState = {
    theme: "aurora-dark",
    autonomyMode: "safe_auto",
    autonomyCategoryOverrides: {},
    capabilityRegistry: { hash: "", generatedAt: "2026-06-19T09:00:00.000Z", capabilities: [] },
    rawToolInventory: [],
    approvalGrants: [],
    workflows: [workflowVersion(dailyWorkJournalWorkflow)],
    runs: [],
    artifacts: [],
    scheduleOverrides: [],
    providers: [
      provider("openai"),
      provider("local_git", "available", "context"),
      provider("local_app", "available", "artifact_destination"),
    ],
    llmProfiles: [openAiProfile],
    agentAuthProfiles: [codexProfile],
    chatMessages: [],
  };
  return {
    ...defaults,
    ...overrides,
    autonomyMode: overrides.autonomyMode ?? defaults.autonomyMode,
    autonomyCategoryOverrides: overrides.autonomyCategoryOverrides ?? defaults.autonomyCategoryOverrides,
    capabilityRegistry: overrides.capabilityRegistry ?? defaults.capabilityRegistry,
    rawToolInventory: overrides.rawToolInventory ?? defaults.rawToolInventory,
    approvalGrants: overrides.approvalGrants ?? defaults.approvalGrants,
  };
}

function localDate(hour: number, minute = 0): Date {
  return new Date(2026, 5, 19, hour, minute, 0, 0);
}

function scheduledWorkflow(id: string, name: string, localTime: string): RavenWorkflow {
  return {
    ...dailyWorkJournalWorkflow,
    id,
    name,
    schedule: { cadence: "daily", localTime },
  };
}

function pluginWorkflow(): RavenWorkflow {
  return {
    schemaVersion: "0.1.0",
    id: "plugin-artifact",
    name: "Plugin Artifact",
    description: "Builds an artifact with a deterministic plugin.",
    permissions: ["plugin:execute", "artifact:write"],
    defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
    schedule: { cadence: "manual" },
    steps: [
      {
        kind: "provider_action",
        id: "build-artifact",
        name: "Build artifact",
        provider: "deterministic_artifact",
        action: "build_artifact",
        dependsOn: [],
        permissions: ["plugin:execute"],
        inputs: { subject: "Task 11" },
      },
      {
        kind: "provider_action",
        id: "write-artifact",
        name: "Save plugin artifact",
        provider: "local_app",
        action: "write_artifact",
        dependsOn: ["build-artifact"],
        permissions: ["artifact:write"],
        destinationRef: "local-app",
        inputs: { artifact: "$steps.build-artifact.artifact" },
      },
    ],
  };
}

function httpProbeWorkflow(): RavenWorkflow {
  return {
    schemaVersion: "0.1.0",
    id: "website-up",
    name: "Website Uptime",
    description: "Checks URLs with the deterministic HTTP probe.",
    permissions: ["network:read", "artifact:write"],
    defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
    schedule: { cadence: "manual" },
    steps: [
      {
        kind: "provider_action",
        id: "check-sites",
        name: "Check sites",
        provider: "http_probe",
        action: "check_urls",
        dependsOn: [],
        permissions: ["network:read"],
        inputs: {
          urls: ["https://example.com"],
          timeout_ms: 5000,
          accepted_status_codes: [200, 204],
        },
      },
      {
        kind: "provider_action",
        id: "write-artifact",
        name: "Save status report",
        provider: "local_app",
        action: "write_artifact",
        dependsOn: ["check-sites"],
        permissions: ["artifact:write"],
        destinationRef: "local-app",
        inputs: { artifact: "$steps.check-sites.artifact" },
      },
    ],
  };
}

function localCliJournalWorkflow(): RavenWorkflow {
  return {
    ...dailyWorkJournalWorkflow,
    defaults: {
      ...dailyWorkJournalWorkflow.defaults,
      llmProfileRef: "codex-oauth-local",
    },
    steps: dailyWorkJournalWorkflow.steps.map((step) => (
      step.id === "compose-artifact"
        ? { ...step, llmProfileRef: "codex-oauth-local" }
        : step
    )),
  };
}

describe("Command Center selectors", () => {
  it("healthy workflow derives enabled", () => {
    const state = appState();

    expect(deriveWorkflowOperationalStatus(state.workflows[0], state)).toBe("enabled");
  });

  it("disabled workflow derives paused", () => {
    const state = appState({ workflows: [workflowVersion(dailyWorkJournalWorkflow, "disabled")] });

    expect(deriveWorkflowOperationalStatus(state.workflows[0], state)).toBe("paused");
  });

  it("draft workflow derives draft", () => {
    const state = appState({ workflows: [workflowVersion(morningBriefWorkflow, "draft")] });

    expect(deriveWorkflowOperationalStatus(state.workflows[0], state)).toBe("draft");
  });

  it("unavailable default provider derives needs-setup", () => {
    const state = appState({
      providers: [
        provider("openai", "unavailable"),
        provider("local_git", "available", "context"),
        provider("local_app", "available", "artifact_destination"),
      ],
    });

    expect(deriveWorkflowOperationalStatus(state.workflows[0], state)).toBe("needs-setup");
  });

  it("missing provider profile derives needs-setup", () => {
    const state = appState({ llmProfiles: [] });

    expect(deriveWorkflowOperationalStatus(state.workflows[0], state)).toBe("needs-setup");
  });

  it("built-in deterministic http_probe steps do not require configured provider accounts", () => {
    const state = appState({
      workflows: [workflowVersion(httpProbeWorkflow())],
      providers: [provider("local_app", "available", "artifact_destination")],
    });

    expect(deriveProviderReadiness(state.workflows[0], state).issues).not.toContain(
      "Provider http_probe is missing.",
    );
    expect(deriveWorkflowOperationalStatus(state.workflows[0], state)).toBe("enabled");
  });

  it("invalid workflow derives blocked", () => {
    const invalidWorkflow: RavenWorkflow = {
      ...dailyWorkJournalWorkflow,
      steps: [
        {
          ...dailyWorkJournalWorkflow.steps[0],
          provider: "missing-provider",
        },
      ],
    };
    const state = appState({ workflows: [workflowVersion(invalidWorkflow)] });

    expect(deriveWorkflowOperationalStatus(state.workflows[0], state)).toBe("blocked");
  });

  it("latest failed and latest retryable run derive failed-retryable", () => {
    const workflow = workflowVersion(currentWeatherWorkflow);
    const failedState = appState({
      workflows: [workflow],
      runs: [run({ workflowId: workflow.workflowId, status: "failed", startedAt: "2026-06-19T10:00:00.000Z" })],
      providers: [provider("local_app", "available", "artifact_destination")],
      llmProfiles: [],
    });
    const retryableState = appState({
      workflows: [workflow],
      runs: [run({ workflowId: workflow.workflowId, status: "retryable", startedAt: "2026-06-19T10:00:00.000Z" })],
      providers: [provider("local_app", "available", "artifact_destination")],
      llmProfiles: [],
    });

    expect(deriveWorkflowOperationalStatus(workflow, failedState)).toBe("failed-retryable");
    expect(deriveWorkflowOperationalStatus(workflow, retryableState)).toBe("failed-retryable");
  });

  it("latest blocked run derives blocked", () => {
    const state = appState({
      runs: [
        run({
          workflowId: "daily-work-journal",
          status: "blocked",
          startedAt: "2026-06-19T10:00:00.000Z",
        }),
      ],
    });

    expect(deriveWorkflowOperationalStatus(state.workflows[0], state)).toBe("blocked");
  });

  it("derives workflow health from operational status and readiness issues", () => {
    const healthyState = appState();
    const setupState = appState({ llmProfiles: [] });
    const pausedState = appState({
      workflows: [workflowVersion(dailyWorkJournalWorkflow, "disabled")],
    });
    const blockedState = appState({
      runs: [run({ workflowId: "daily-work-journal", status: "blocked" })],
    });

    expect(deriveWorkflowHealth(healthyState.workflows[0], healthyState)).toMatchObject({
      status: "healthy",
      operationalStatus: "enabled",
      issues: [],
    });
    expect(deriveWorkflowHealth(setupState.workflows[0], setupState)).toMatchObject({
      status: "warning",
      operationalStatus: "needs-setup",
    });
    expect(deriveWorkflowHealth(pausedState.workflows[0], pausedState)).toMatchObject({
      status: "inactive",
      operationalStatus: "paused",
    });
    expect(deriveWorkflowHealth(blockedState.workflows[0], blockedState)).toMatchObject({
      status: "critical",
      operationalStatus: "blocked",
    });
  });

  it("derives provider readiness for ready, degraded, missing, and setup-needed providers", () => {
    const readyState = appState();
    const degradedState = appState({
      providers: [
        provider("openai", "degraded"),
        provider("local_git", "available", "context"),
        provider("local_app", "available", "artifact_destination"),
      ],
    });
    const missingState = appState({ llmProfiles: [] });
    const setupState = appState({
      providers: [
        provider("openai", "needs_config"),
        provider("local_git", "available", "context"),
        provider("local_app", "available", "artifact_destination"),
      ],
    });

    expect(deriveProviderReadiness(readyState.workflows[0], readyState)).toMatchObject({
      status: "ready",
      profileId: "default-openai",
      providerId: "openai",
      model: "gpt-4.1",
      issues: [],
    });
    expect(deriveProviderReadiness(degradedState.workflows[0], degradedState).status).toBe("degraded");
    expect(deriveProviderReadiness(missingState.workflows[0], missingState)).toMatchObject({
      status: "missing",
      profileId: "default-openai",
    });
    expect(deriveProviderReadiness(setupState.workflows[0], setupState).status).toBe("needs-setup");
  });

  it("derives plugin-backed workflow status with provided plugin manifests", () => {
    const workflow = workflowVersion(pluginWorkflow());
    const state = appState({ workflows: [workflow] });

    expect(deriveWorkflowOperationalStatus(workflow, state, [deterministicArtifactPlugin])).toBe("enabled");
  });

  it("derives plugin-backed workflow health with provided plugin manifests", () => {
    const workflow = workflowVersion(pluginWorkflow());
    const state = appState({ workflows: [workflow] });

    expect(deriveWorkflowHealth(workflow, state, [deterministicArtifactPlugin])).toMatchObject({
      status: "healthy",
      operationalStatus: "enabled",
      issues: [],
    });
  });

  it("does not mark plugin-backed step providers as missing when plugin manifests support them", () => {
    const workflow = workflowVersion(pluginWorkflow());
    const state = appState({ workflows: [workflow] });

    expect(deriveProviderReadiness(workflow, state, [deterministicArtifactPlugin])).toMatchObject({
      status: "ready",
      issues: [],
    });
  });

  it("treats local CLI LLM profiles as ready even when legacy openai steps are used", () => {
    const workflow = workflowVersion(localCliJournalWorkflow());
    const state = appState({
      workflows: [workflow],
      llmProfiles: [],
      providers: [
        provider("local_git", "available", "context"),
        provider("local_app", "available", "artifact_destination"),
      ],
    });

    expect(deriveProviderReadiness(workflow, state)).toMatchObject({
      status: "ready",
      profileId: "codex-oauth-local",
      providerId: "codex-oauth-local",
      model: "gpt-5.4",
      issues: [],
    });
    expect(deriveWorkflowOperationalStatus(workflow, state)).toBe("enabled");
  });

  it("missing run cost is counted as unknown and excluded from total cost", () => {
    const state = appState({
      runs: [
        run({ workflowId: "daily-work-journal", status: "succeeded", totalCostUsd: 0.25 }),
        run({ workflowId: "daily-work-journal", status: "succeeded" }),
      ],
    });

    const summary = buildUsageSummary(state);

    expect(summary.totalCostUsd).toBe(0.25);
    expect(summary.reportedCostRunCount).toBe(1);
    expect(summary.unknownCostRunCount).toBe(1);
  });

  it("missing input/output token split produces unavailable split", () => {
    const state = appState({
      runs: [run({ workflowId: "daily-work-journal", status: "succeeded", totalTokens: 400 })],
    });

    expect(buildUsageSummary(state).tokenSplit.status).toBe("unavailable");
  });

  it("marks usage charts empty when no cost or token data exists", () => {
    const model = buildUsageCommandPanelModel(appState({ runs: [] }), "today", new Date("2026-06-19T12:00:00.000Z"));

    expect(model.chartState).toMatchObject({
      dailyCost: { state: "empty" },
      tokenSplit: { state: "empty" },
      providerBreakdown: { state: "empty" },
      forecast: { state: "empty" },
    });
  });

  it("marks usage charts ready when reported usage exists", () => {
    const model = buildUsageCommandPanelModel(appState({
      runs: [run({
        id: "run-usage",
        workflowId: "daily-work-journal",
        workflowName: "Daily Work Journal",
        status: "succeeded",
        totalCostUsd: 3,
        totalTokens: 1200,
        inputTokens: 700,
        outputTokens: 500,
      })],
    }), "today", new Date("2026-06-19T12:00:00.000Z"));

    expect(model.chartState.dailyCost.state).toBe("ready");
    expect(model.chartState.tokenSplit.state).toBe("ready");
    expect(model.chartState.providerBreakdown.state).toBe("ready");
    expect(model.chartState.forecast.state).toBe("ready");
  });

  it("marks token split partial when only some runs report input and output tokens", () => {
    const model = buildUsageCommandPanelModel(appState({
      runs: [
        run({
          id: "with-split",
          workflowId: "daily-work-journal",
          workflowName: "Daily Work Journal",
          status: "succeeded",
          totalCostUsd: 2,
          totalTokens: 900,
          inputTokens: 600,
          outputTokens: 300,
        }),
        run({
          id: "missing-split",
          workflowId: "daily-work-journal",
          workflowName: "Daily Work Journal",
          status: "succeeded",
          totalCostUsd: 1,
          totalTokens: 300,
        }),
      ],
    }), "today", new Date("2026-06-19T12:00:00.000Z"));

    expect(model.chartState.tokenSplit).toMatchObject({
      state: "partial",
      reason: "Token split excludes runs without input/output detail.",
    });
    expect(model.chartState.tokenSplit.nextAction?.label).toBe("Open workflow usage detail");
  });

  it("marks token split unavailable when cost is reported without token telemetry", () => {
    const model = buildUsageCommandPanelModel(appState({
      runs: [run({
        id: "cost-only",
        workflowId: "daily-work-journal",
        workflowName: "Daily Work Journal",
        status: "succeeded",
        totalCostUsd: 2.5,
      })],
    }), "today", new Date("2026-06-19T12:00:00.000Z"));

    expect(model.chartState.tokenSplit).toMatchObject({
      state: "unavailable",
      reason: "Usage runs reported cost, but providers did not report token telemetry for this period.",
    });
  });

  it("filters usage command panel model by supported periods and builds daily buckets", () => {
    const state = appState({
      runs: [
        run({
          workflowId: "daily-work-journal",
          status: "succeeded",
          totalCostUsd: 1,
          totalTokens: 100,
          startedAt: "2026-06-19T10:00:00.000Z",
        }),
        run({
          workflowId: "daily-work-journal",
          status: "succeeded",
          totalCostUsd: 2,
          totalTokens: 200,
          startedAt: "2026-06-16T10:00:00.000Z",
        }),
        run({
          workflowId: "daily-work-journal",
          status: "succeeded",
          totalCostUsd: 4,
          totalTokens: 400,
          startedAt: "2026-05-31T10:00:00.000Z",
        }),
      ],
    });

    const today = buildUsageCommandPanelModel(state, "today", new Date("2026-06-19T12:00:00.000Z"));
    const sevenDays = buildUsageCommandPanelModel(state, "7d", new Date("2026-06-19T12:00:00.000Z"));
    const monthToDate = buildUsageCommandPanelModel(state, "mtd", new Date("2026-06-19T12:00:00.000Z"));

    expect(today.summary.totalCostUsd).toBe(1);
    expect(sevenDays.summary.totalCostUsd).toBe(3);
    expect(monthToDate.summary.totalCostUsd).toBe(3);
    expect(sevenDays.dailyCost).toHaveLength(7);
    expect(sevenDays.dailyCost.map((bucket) => bucket.isoDate)).toContain("2026-06-16");
  });

  it("keeps recent daily buckets in all-time usage when history spans more than 370 days", () => {
    const state = appState({
      runs: [
        run({
          id: "old-run",
          workflowId: "daily-work-journal",
          status: "succeeded",
          totalCostUsd: 1,
          startedAt: "2025-01-01T10:00:00.000Z",
        }),
        run({
          id: "recent-run",
          workflowId: "daily-work-journal",
          status: "succeeded",
          totalCostUsd: 2,
          startedAt: "2026-06-19T10:00:00.000Z",
        }),
      ],
    });

    const model = buildUsageCommandPanelModel(state, "all", new Date("2026-06-19T12:00:00.000Z"));

    expect(model.dailyCost).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isoDate: "2026-06-19",
          totalCostUsd: 2,
          runCount: 1,
        }),
      ]),
    );
  });

  it("guards usage period values", () => {
    expect(isUsagePeriod("today")).toBe(true);
    expect(isUsagePeriod("7d")).toBe(true);
    expect(isUsagePeriod("quarter")).toBe(false);
    expect(isUsagePeriod(null)).toBe(false);
  });

  it("computes budget danger when a cost threshold is configured", () => {
    const state = appState({
      runs: [
        run({
          workflowId: "daily-work-journal",
          status: "succeeded",
          totalCostUsd: 12,
          startedAt: "2026-06-19T10:00:00.000Z",
        }),
      ],
    });

    const model = buildUsageCommandPanelModel(state, "today", new Date("2026-06-19T12:00:00.000Z"), {
      budgetThresholdUsd: 10,
    });

    expect(model.budget).toMatchObject({
      status: "danger",
      label: "$10.00 cost alert",
      thresholdUsd: 10,
      totalCostUsd: 12,
      percentUsed: 120,
    });
  });

  it("command center usage and schedule targets are representable in UI state", () => {
    const usageTarget: CommandCenterTarget = "usage";
    const scheduleTarget: CommandCenterTarget = "schedule";

    expect(COMMAND_CENTER_TARGETS).toEqual(["overview", "usage", "schedule"]);
    expect(isCommandCenterTarget(usageTarget)).toBe(true);
    expect(isCommandCenterTarget(scheduleTarget)).toBe(true);
  });

  it("builds command center breadcrumb segments", () => {
    expect(buildCommandCenterBreadcrumbs("overview")).toEqual([
      { label: "Command Center", target: "overview", current: true },
    ]);
    expect(buildCommandCenterBreadcrumbs("usage")).toEqual([
      { label: "Command Center", target: "overview", current: false },
      { label: "Usage", target: "usage", current: true },
    ]);
    expect(buildCommandCenterBreadcrumbs("schedule")).toEqual([
      { label: "Command Center", target: "overview", current: false },
      { label: "Schedule", target: "schedule", current: true },
    ]);
  });

  it("builds assistant suggestions with command center actions and attention repair", () => {
    const state = appState({
      runs: [run({ workflowId: "daily-work-journal", status: "blocked" })],
    });

    expect(buildAssistantSuggestions(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Review Daily Work Journal",
          type: "repair",
          priority: "high",
          action: { kind: "open-workflow", payload: { workflowId: "daily-work-journal" } },
        }),
        expect.objectContaining({
          label: "Open usage",
          type: "navigate",
          action: { kind: "open-command-center", payload: { target: "usage" } },
        }),
        expect.objectContaining({
          label: "Open schedule",
          type: "navigate",
          action: { kind: "open-command-center", payload: { target: "schedule" } },
        }),
      ]),
    );
  });

  it("builds surface-specific assistant suggestions with selected entity context", () => {
    const state = appState({
      runs: [
        run({ workflowId: "daily-work-journal", status: "failed" }),
        run({ workflowId: "daily-work-journal", status: "succeeded", id: "selected-run" }),
      ],
    });

    expect(
      buildAssistantSuggestions(state, "workflows", [], {
        selectedWorkflowId: "daily-work-journal",
        selectedRunId: "selected-run",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Filter failed workflows",
          action: { kind: "set-workflow-roster", payload: { statuses: ["failed-retryable"] } },
        }),
        expect.objectContaining({
          label: "Sort by next run",
          action: { kind: "set-workflow-roster", payload: { sortKey: "next-run" } },
        }),
        expect.objectContaining({
          label: "Explain this run",
          action: {
            kind: "ask-assistant",
            payload: {
              prompt: "Explain run selected-run for Daily Work Journal, including status, trace, and any recovery options.",
            },
          },
        }),
      ]),
    );

    expect(buildAssistantSuggestions(state, "settings", [], { activeSettingsTab: "context" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Open GitHub context settings",
          action: { kind: "open-settings", payload: { tab: "context", target: { type: "context-source", id: "github", label: "GitHub" } } },
        }),
        expect.objectContaining({
          label: "Open scheduler settings",
          action: { kind: "open-settings", payload: { tab: "advanced", target: { type: "automation", id: "scheduler", label: "Scheduler" } } },
        }),
      ]),
    );
  });

  describe("buildCommandCenterPriority", () => {
    it("prioritizes failed runs above provider setup", () => {
      const workflow = workflowVersion(dailyWorkJournalWorkflow);
      const state = appState({
        workflows: [workflow],
        runs: [
          run({
            workflowId: workflow.workflowId,
            status: "retryable",
            startedAt: "2026-06-19T10:00:00.000Z",
          }),
        ],
        providers: [
          provider("openai", "unavailable"),
          provider("local_git", "available", "context"),
          provider("local_app", "available", "artifact_destination"),
        ],
      });

      expect(buildCommandCenterPriority(state, localDate(12))).toMatchObject({
        severity: "critical",
        title: "Run needs recovery",
        primaryAction: { label: "Open workflow", target: "workflow", workflowId: workflow.workflowId },
      });
    });

    it("prioritizes provider setup above normal workflow status", () => {
      const state = appState({
        workflows: [workflowVersion(dailyWorkJournalWorkflow)],
        providers: [
          provider("openai", "unavailable"),
          provider("local_git", "available", "context"),
          provider("local_app", "available", "artifact_destination"),
        ],
      });

      expect(buildCommandCenterPriority(state, localDate(12))).toMatchObject({
        severity: "attention",
        title: "Provider setup needed",
        primaryAction: { label: "Open provider settings", target: "providers" },
      });
    });

    it("surfaces approval pending ahead of overdue schedules", () => {
      const workflow = workflowVersion(scheduledWorkflow("approvals", "Approvals", "08:00"));
      const state = appState({
        workflows: [workflow],
        runs: [
          run({
            workflowId: workflow.workflowId,
            workflowName: workflow.definition.name,
            status: "blocked",
            startedAt: localDate(8, 5).toISOString(),
            requiredProviderId: "approval",
            blockedReason: "Waiting for approval before continuing.",
          }),
        ],
      });

      expect(buildCommandCenterPriority(state, localDate(12))).toMatchObject({
        severity: "attention",
        title: "Approval pending",
        primaryAction: { label: "Review workflow", target: "workflow", workflowId: workflow.workflowId },
      });
    });

    it("uses next scheduled run when no blocker exists", () => {
      const state = appState({
        workflows: [workflowVersion(scheduledWorkflow("upcoming", "Upcoming", "17:00"))],
      });

      expect(buildCommandCenterPriority(state, localDate(12))).toMatchObject({
        severity: "normal",
        title: expect.stringContaining("Next run"),
      });
    });

    it("falls back to all clear when no schedules are configured", () => {
      const state = appState({
        workflows: [workflowVersion(currentWeatherWorkflow)],
        providers: [provider("local_app", "available", "artifact_destination")],
        llmProfiles: [],
      });

      expect(buildCommandCenterPriority(state, localDate(12))).toMatchObject({
        severity: "normal",
        title: "All clear",
        primaryAction: { label: "Review workflows", target: "overview" },
      });
    });

    it("shows explicit onboarding artifact copy after setup instead of scheduler noise", () => {
      const workflow = workflowVersion({
        ...localCliJournalWorkflow(),
        id: "post-setup-artifact",
        name: "Post Setup Artifact",
        schedule: { cadence: "daily", localTime: "08:00" },
      });
      const onboardingRun = run({
        id: "run-post-setup-artifact",
        workflowId: workflow.workflowId,
        workflowName: workflow.definition.name,
        status: "succeeded",
        startedAt: localDate(9, 10).toISOString(),
        completedAt: localDate(9, 11).toISOString(),
      });
      const state = appState({
        workflows: [workflow],
        runs: [onboardingRun],
        artifacts: [
          {
            id: "artifact-post-setup-artifact",
            title: workflow.definition.name,
            type: "daily_work_journal",
            workflowRunId: onboardingRun.id,
            contentMarkdown: "# Artifact ready",
            metadata: {
              schemaVersion: "0.1.0",
              workflowId: workflow.workflowId,
              source: "onboarding",
              simulated: false,
            },
            sourceRefs: ["onboarding selections"],
            createdAt: localDate(9, 11).toISOString(),
          },
        ],
        llmProfiles: [],
        providers: [
          provider("local_git", "available", "context"),
          provider("local_app", "available", "artifact_destination"),
        ],
        agentAuthProfiles: [codexProfile],
      });

      expect(buildCommandCenterPriority(
        state,
        localDate(12),
        [],
        { postOnboardingLandingPending: true },
      )).toMatchObject({
        severity: "normal",
        title: "Artifact ready",
        body: `${workflow.definition.name} is ready from ${workflow.definition.name}.`,
        primaryAction: { label: "Open workflow", target: "workflow", workflowId: workflow.workflowId },
      });
    });

    it("prefers provider setup warnings over persisted setup completion when no explicit onboarding signal exists", () => {
      const readyWorkflow = workflowVersion({
        ...localCliJournalWorkflow(),
        id: "provider-ready",
        name: "Provider Ready",
        schedule: { cadence: "daily", localTime: "08:00" },
      });
      const blockedBySetupWorkflow = workflowVersion({
        ...dailyWorkJournalWorkflow,
        id: "provider-missing",
        name: "Provider Missing",
        schedule: { cadence: "daily", localTime: "08:00" },
      });
      const state = appState({
        workflows: [readyWorkflow, blockedBySetupWorkflow],
        runs: [
          run({
            id: "run-provider-ready-onboarding",
            workflowId: readyWorkflow.workflowId,
            workflowName: readyWorkflow.definition.name,
            status: "succeeded",
            startedAt: localDate(9, 20).toISOString(),
            completedAt: localDate(9, 21).toISOString(),
          }),
        ],
        artifacts: [
          {
            id: "artifact-provider-ready-onboarding",
            title: `${readyWorkflow.definition.name} Sample`,
            type: "daily_work_journal",
            workflowRunId: "run-provider-ready-onboarding",
            contentMarkdown: "# Sample",
            metadata: {
              schemaVersion: "0.1.0",
              workflowId: readyWorkflow.workflowId,
              source: "onboarding",
              simulated: true,
            },
            sourceRefs: ["onboarding selections"],
            createdAt: localDate(9, 21).toISOString(),
          },
        ],
        providers: [
          provider("openai", "unavailable"),
          provider("local_git", "available", "context"),
          provider("local_app", "available", "artifact_destination"),
        ],
        llmProfiles: [openAiProfile],
        agentAuthProfiles: [codexProfile],
      });

      expect(buildCommandCenterPriority(
        state,
        localDate(12),
        [],
        { hasCompletedSetup: true, postOnboardingLandingPending: false },
      )).toMatchObject({
        severity: "attention",
        title: "Provider setup needed",
        primaryAction: { label: "Open provider settings", target: "providers" },
        secondaryAction: {
          label: "Open workflow",
          target: "workflow",
          workflowId: blockedBySetupWorkflow.workflowId,
        },
      });
    });

    it("prefers overdue schedule warnings over persisted setup completion when no explicit onboarding signal exists", () => {
      const workflow = workflowVersion(scheduledWorkflow("later-visit-empty", "Later Visit Empty", "08:00"));
      const state = appState({
        workflows: [workflow],
        runs: [
          run({
            id: "run-later-visit-empty-onboarding",
            workflowId: workflow.workflowId,
            workflowName: workflow.definition.name,
            status: "succeeded",
            startedAt: "2026-06-18T09:22:00.000Z",
            completedAt: "2026-06-18T09:23:00.000Z",
          }),
        ],
        artifacts: [
          {
            id: "artifact-later-visit-empty-onboarding",
            title: `${workflow.definition.name} Sample`,
            type: "daily_work_journal",
            workflowRunId: "run-later-visit-empty-onboarding",
            contentMarkdown: "# Sample",
            metadata: {
              schemaVersion: "0.1.0",
              workflowId: workflow.workflowId,
              source: "onboarding",
              simulated: true,
            },
            sourceRefs: ["onboarding selections"],
            createdAt: "2026-06-18T09:23:00.000Z",
          },
        ],
      });

      expect(buildCommandCenterPriority(
        state,
        localDate(12),
        [],
        { hasCompletedSetup: true, postOnboardingLandingPending: false },
      )).toMatchObject({
        severity: "attention",
        title: "Schedule overdue",
        primaryAction: { label: "Open schedule", target: "schedule" },
        secondaryAction: {
          label: "Open workflow",
          target: "workflow",
          workflowId: workflow.workflowId,
        },
      });
    });

    it("shows sample artifact copy after onboarding instead of overdue schedule warnings", () => {
      const workflow = workflowVersion({
        ...localCliJournalWorkflow(),
        id: "sampled",
        name: "Sampled Workflow",
        schedule: { cadence: "daily", localTime: "08:00" },
      });
      const sampleRun = run({
        id: "run-sample-success",
        workflowId: workflow.workflowId,
        workflowName: workflow.definition.name,
        status: "succeeded",
        startedAt: localDate(9, 15).toISOString(),
        completedAt: localDate(9, 16).toISOString(),
      });
      const state = appState({
        workflows: [workflow],
        runs: [sampleRun],
        artifacts: [
          {
            id: "artifact-sample-success",
            title: `${workflow.definition.name} Sample`,
            type: "daily_work_journal",
            workflowRunId: sampleRun.id,
            contentMarkdown: "# Sample",
            metadata: {
              schemaVersion: "0.1.0",
              workflowId: workflow.workflowId,
              source: "onboarding",
              simulated: true,
            },
            sourceRefs: ["onboarding selections"],
            createdAt: localDate(9, 16).toISOString(),
          },
        ],
        llmProfiles: [],
        providers: [
          provider("local_git", "available", "context"),
          provider("local_app", "available", "artifact_destination"),
        ],
        agentAuthProfiles: [codexProfile],
      });

      expect(buildCommandCenterPriority(
        state,
        localDate(12),
        [],
        { postOnboardingLandingPending: true },
      )).toMatchObject({
        severity: "normal",
        title: "Sample artifact created",
        body: `${workflow.definition.name} Sample is ready from ${workflow.definition.name}.`,
        primaryAction: { label: "Open workflow", target: "workflow", workflowId: workflow.workflowId },
      });
    });

    it("keeps recovery work ahead of transient onboarding landing copy", () => {
      const workflow = workflowVersion({
        ...localCliJournalWorkflow(),
        id: "sample-with-retry",
        name: "Sample With Retry",
        schedule: { cadence: "daily", localTime: "08:00" },
      });
      const sampleRun = run({
        id: "run-sample-with-retry-success",
        workflowId: workflow.workflowId,
        workflowName: workflow.definition.name,
        status: "succeeded",
        startedAt: localDate(9, 24).toISOString(),
        completedAt: localDate(9, 25).toISOString(),
      });
      const retryRun = run({
        id: "run-sample-with-retry-retryable",
        workflowId: workflow.workflowId,
        workflowName: workflow.definition.name,
        status: "retryable",
        startedAt: localDate(10, 5).toISOString(),
        completedAt: localDate(10, 6).toISOString(),
      });
      const state = appState({
        workflows: [workflow],
        runs: [retryRun, sampleRun],
        artifacts: [
          {
            id: "artifact-sample-with-retry",
            title: `${workflow.definition.name} Sample`,
            type: "daily_work_journal",
            workflowRunId: sampleRun.id,
            contentMarkdown: "# Sample",
            metadata: {
              schemaVersion: "0.1.0",
              workflowId: workflow.workflowId,
              source: "onboarding",
              simulated: true,
            },
            sourceRefs: ["onboarding selections"],
            createdAt: localDate(9, 25).toISOString(),
          },
        ],
        llmProfiles: [],
        providers: [
          provider("local_git", "available", "context"),
          provider("local_app", "available", "artifact_destination"),
        ],
        agentAuthProfiles: [codexProfile],
      });

      expect(buildCommandCenterPriority(
        state,
        localDate(12),
        [],
        { postOnboardingLandingPending: true },
      )).toMatchObject({
        severity: "critical",
        title: "Run needs recovery",
        primaryAction: { label: "Open workflow", target: "workflow", workflowId: workflow.workflowId },
      });
    });

    it("does not use sample onboarding copy when only the title matches and simulated metadata is absent", () => {
      const workflow = workflowVersion({
        ...localCliJournalWorkflow(),
        id: "metadata-only-sample",
        name: "Metadata Only Sample",
        schedule: { cadence: "daily", localTime: "08:00" },
      });
      const onboardingRun = run({
        id: "run-metadata-only-sample",
        workflowId: workflow.workflowId,
        workflowName: workflow.definition.name,
        status: "succeeded",
        startedAt: localDate(9, 20).toISOString(),
        completedAt: localDate(9, 21).toISOString(),
      });
      const state = appState({
        workflows: [workflow],
        runs: [onboardingRun],
        artifacts: [
          {
            id: "artifact-metadata-only-sample",
            title: `${workflow.definition.name} Sample`,
            type: "daily_work_journal",
            workflowRunId: onboardingRun.id,
            contentMarkdown: "# Artifact ready",
            metadata: {
              schemaVersion: "0.1.0",
              workflowId: workflow.workflowId,
              source: "onboarding",
              simulated: false,
            },
            sourceRefs: ["onboarding selections"],
            createdAt: localDate(9, 21).toISOString(),
          },
        ],
        llmProfiles: [],
        providers: [
          provider("local_git", "available", "context"),
          provider("local_app", "available", "artifact_destination"),
        ],
        agentAuthProfiles: [codexProfile],
      });

      expect(buildCommandCenterPriority(
        state,
        localDate(12),
        [],
        { postOnboardingLandingPending: true },
      )).toMatchObject({
        severity: "normal",
        title: "Artifact ready",
        body: `${workflow.definition.name} Sample is ready from ${workflow.definition.name}.`,
        primaryAction: { label: "Open workflow", target: "workflow", workflowId: workflow.workflowId },
      });
    });

    it("returns to provider setup warnings after onboarding when the latest artifact is not onboarding output", () => {
      const workflow = workflowVersion(dailyWorkJournalWorkflow);
      const state = appState({
        workflows: [workflow],
        artifacts: [
          {
            id: "artifact-user-sample",
            title: `${workflow.definition.name} Sample`,
            type: "daily_work_journal",
            workflowRunId: "run-user-sample",
            contentMarkdown: "# User Sample",
            metadata: {
              schemaVersion: "0.1.0",
              workflowId: workflow.workflowId,
              source: "manual",
            },
            sourceRefs: ["user run"],
            createdAt: localDate(9, 30).toISOString(),
          },
        ],
        providers: [
          provider("openai", "unavailable"),
          provider("local_git", "available", "context"),
          provider("local_app", "available", "artifact_destination"),
        ],
      });

      expect(buildCommandCenterPriority(
        state,
        localDate(12),
        [],
        { hasCompletedSetup: true },
      )).toMatchObject({
        severity: "attention",
        title: "Provider setup needed",
        primaryAction: { label: "Open provider settings", target: "providers" },
      });
    });

    it("returns to overdue schedule warnings after the onboarding artifact context ends", () => {
      const workflow = workflowVersion(scheduledWorkflow("later-visit", "Later Visit", "08:00"));
      const state = appState({
        workflows: [workflow],
        artifacts: [
          {
            id: "artifact-later-visit",
            title: "Daily recap",
            type: "daily_work_journal",
            workflowRunId: "run-later-visit",
            contentMarkdown: "# Daily recap",
            metadata: {
              schemaVersion: "0.1.0",
              workflowId: workflow.workflowId,
              source: "manual",
            },
            sourceRefs: ["user run"],
            createdAt: localDate(9, 45).toISOString(),
          },
        ],
      });

      expect(buildCommandCenterPriority(
        state,
        localDate(12),
        [],
        { hasCompletedSetup: true },
      )).toMatchObject({
        severity: "attention",
        title: "Schedule overdue",
        primaryAction: { label: "Open schedule", target: "schedule" },
        secondaryAction: {
          label: "Open workflow",
          target: "workflow",
          workflowId: workflow.workflowId,
        },
      });
    });
  });

  describe("buildLiveApprovalPriority", () => {
    it("routes live approvals through the matching run workflow id", () => {
      const weatherWorkflow = workflowVersion(currentWeatherWorkflow);
      const sameNameWorkflow = workflowVersion({
        ...currentWeatherWorkflow,
        id: "current-weather-copy",
      });
      const state = appState({
        workflows: [sameNameWorkflow, weatherWorkflow],
        runs: [
          run({
            id: "live-approval-run",
            workflowId: weatherWorkflow.workflowId,
            workflowName: weatherWorkflow.definition.name,
            status: "running",
          }),
        ],
      });

      expect(buildLiveApprovalPriority(state, {
        basePriority: buildCommandCenterPriority(state, localDate(12)),
        pendingApproval: {
          id: "approval-1",
          runId: "live-approval-run",
          stepId: "ask-ai",
          workflowName: weatherWorkflow.definition.name,
          description: "Review before continuing.",
          riskLevel: "high",
          status: "pending",
          createdAt: localDate(12).toISOString(),
        },
      })).toMatchObject({
        title: "Approval pending",
        primaryAction: {
          label: "Review workflow",
          target: "workflow",
          workflowId: weatherWorkflow.workflowId,
        },
      });
    });

    it("uses a safe fallback when a live approval has no persisted workflow id", () => {
      const state = appState({
        workflows: [
          workflowVersion(currentWeatherWorkflow),
          workflowVersion({ ...currentWeatherWorkflow, id: "current-weather-copy" }),
        ],
      });

      expect(buildLiveApprovalPriority(state, {
        basePriority: buildCommandCenterPriority(state, localDate(12)),
        pendingApproval: {
          id: "approval-2",
          runId: "missing-run",
          stepId: "ask-ai",
          workflowName: currentWeatherWorkflow.name,
          description: "Review before continuing.",
          riskLevel: "high",
          status: "pending",
          createdAt: localDate(12).toISOString(),
        },
      })).toMatchObject({
        title: "Approval pending",
        primaryAction: {
          label: "Review approval",
          target: "workflow",
        },
      });
    });
  });

  it("manual workflow appears in manual schedule bucket", () => {
    const workflow = workflowVersion(currentWeatherWorkflow);
    const state = appState({
      workflows: [workflow],
      providers: [provider("local_app", "available", "artifact_destination")],
      llmProfiles: [],
    });

    expect(buildScheduleEntries(state, new Date("2026-06-19T12:00:00.000Z"))[0]).toMatchObject({
      workflowId: workflow.workflowId,
      bucket: "manual",
    });
  });

  it("enabled scheduled workflow appears in upcoming schedule bucket", () => {
    const state = appState({
      workflows: [workflowVersion(dailyWorkJournalWorkflow)],
    });

    expect(buildScheduleEntries(state, new Date("2026-06-19T12:00:00.000Z"))[0]).toMatchObject({
      workflowId: "daily-work-journal",
      bucket: "upcoming",
    });
  });

  it("orders same-bucket upcoming schedules by next run then workflow name and id", () => {
    const zetaNine = workflowVersion(scheduledWorkflow("zeta-nine", "Zeta", "09:00"));
    const betaEight = workflowVersion(scheduledWorkflow("beta-eight", "Beta", "08:30"));
    const alphaNine = workflowVersion(scheduledWorkflow("alpha-nine", "Alpha", "09:00"));
    const alphaNineLaterId = workflowVersion(scheduledWorkflow("alpha-nine-b", "Alpha", "09:00"));
    const state = appState({
      workflows: [zetaNine, alphaNineLaterId, betaEight, alphaNine],
    });

    expect(buildScheduleEntries(state, localDate(7)).map((entry) => entry.workflowId)).toEqual([
      "beta-eight",
      "alpha-nine",
      "alpha-nine-b",
      "zeta-nine",
    ]);
  });

  it("running scheduled workflow appears in running schedule bucket", () => {
    const state = appState({
      runs: [run({ workflowId: "daily-work-journal", status: "running" })],
    });

    expect(buildScheduleEntries(state, new Date("2026-06-19T12:00:00.000Z"))[0]).toMatchObject({
      workflowId: "daily-work-journal",
      bucket: "running",
    });
  });

  it("completed scheduled workflow appears in completed schedule bucket for current occurrence", () => {
    const workflow = workflowVersion({
      ...dailyWorkJournalWorkflow,
      schedule: { cadence: "daily", localTime: "08:00" },
    });
    const state = appState({
      workflows: [workflow],
      runs: [
        run({
          workflowId: workflow.workflowId,
          status: "succeeded",
          startedAt: localDate(8, 2).toISOString(),
          completedAt: localDate(8, 5).toISOString(),
        }),
      ],
    });

    expect(buildScheduleEntries(state, localDate(12))[0]).toMatchObject({
      workflowId: "daily-work-journal",
      bucket: "completed",
    });
  });

  it("missed scheduled workflow appears in missed schedule bucket", () => {
    const workflow = workflowVersion({
      ...dailyWorkJournalWorkflow,
      schedule: { cadence: "daily", localTime: "08:00" },
    });
    const state = appState({ workflows: [workflow] });

    expect(buildScheduleEntries(state, localDate(12))[0]).toMatchObject({
      workflowId: "daily-work-journal",
      bucket: "missed",
      displayRunAt: localDate(8).toISOString(),
      occurrenceKey: `daily-work-journal:${localDate(8).toISOString()}`,
    });
  });

  it("failed scheduled workflow appears in failed schedule bucket", () => {
    const state = appState({
      runs: [run({ workflowId: "daily-work-journal", status: "failed" })],
    });

    expect(buildScheduleEntries(state, new Date("2026-06-19T12:00:00.000Z"))[0]).toMatchObject({
      workflowId: "daily-work-journal",
      bucket: "failed",
    });
  });

  it("retryable scheduled workflow appears in retryable schedule bucket", () => {
    const state = appState({
      runs: [run({ workflowId: "daily-work-journal", status: "retryable" })],
    });

    expect(buildScheduleEntries(state, new Date("2026-06-19T12:00:00.000Z"))[0]).toMatchObject({
      workflowId: "daily-work-journal",
      bucket: "retryable",
    });
  });

  it("paused scheduled workflow appears in paused schedule bucket", () => {
    const state = appState({
      workflows: [workflowVersion(dailyWorkJournalWorkflow, "disabled")],
    });

    expect(buildScheduleEntries(state, new Date("2026-06-19T12:00:00.000Z"))[0]).toMatchObject({
      workflowId: "daily-work-journal",
      bucket: "paused",
    });
  });

  it("workflow with unavailable schedule state appears in unknown schedule bucket", () => {
    const workflow = workflowVersion({
      ...dailyWorkJournalWorkflow,
      schedule: undefined,
    });
    const state = appState({ workflows: [workflow] });

    expect(buildScheduleEntries(state, new Date("2026-06-19T12:00:00.000Z"))[0]).toMatchObject({
      workflowId: "daily-work-journal",
      bucket: "unknown",
      reason: "Schedule state is unavailable.",
    });
  });

  it("builds schedule timeline model with today, next seven days, and manual sections", () => {
    const upcoming = workflowVersion(scheduledWorkflow("upcoming", "Upcoming", "17:00"));
    const manual = workflowVersion(currentWeatherWorkflow);
    const state = appState({
      workflows: [upcoming, manual],
      providers: [provider("local_app", "available", "artifact_destination")],
      llmProfiles: [],
    });

    const model = buildScheduleTimelineModel(state, new Date("2026-06-19T12:00:00.000Z"));

    expect(model.timezone).toBeTruthy();
    expect(model.todayEntries.map((entry) => entry.workflowId)).toContain("upcoming");
    expect(model.nextSevenDays).toHaveLength(7);
    expect(model.nextSevenDays[0].entries.map((entry) => entry.workflowId)).toContain("upcoming");
    expect(model.manualEntries.map((entry) => entry.workflowId)).toEqual(["current-weather"]);
  });

  describe("buildScheduleTimelineModel action", () => {
    it("does not show a runnable due CTA when all schedules are upcoming", () => {
      const model = buildScheduleTimelineModel(appState({
        workflows: [workflowVersion(scheduledWorkflow("upcoming", "Upcoming", "17:00"))],
      }), localDate(12));

      expect(model.primaryAction).toMatchObject({
        label: "No schedules due",
        disabled: true,
        dueCount: 0,
        reason: expect.stringContaining("next scheduled run"),
      });
    });

    it("shows run due schedules only when at least one entry is due or overdue", () => {
      const model = buildScheduleTimelineModel(appState({
        workflows: [workflowVersion(scheduledWorkflow("due", "Due", "08:00"))],
      }), localDate(9));

      expect(model.primaryAction).toMatchObject({
        label: "Run due schedules",
        disabled: false,
        dueCount: 1,
        reason: expect.stringContaining("overdue"),
      });
    });

    it("falls back to a disabled no-due action when no automatic schedules exist", () => {
      const model = buildScheduleTimelineModel(appState({
        workflows: [workflowVersion(currentWeatherWorkflow)],
        providers: [provider("local_app", "available", "artifact_destination")],
        llmProfiles: [],
      }), localDate(12));

      expect(model.primaryAction).toMatchObject({
        label: "No schedules due",
        disabled: true,
        dueCount: 0,
        reason: "No automatic schedules are due right now.",
      });
    });
  });

  it("keeps missed display occurrence separate from next future run", () => {
    const missed = workflowVersion(scheduledWorkflow("missed", "Missed", "08:00"));
    const state = appState({ workflows: [missed] });

    const [entry] = buildScheduleEntries(state, localDate(12));

    expect(entry.bucket).toBe("missed");
    expect(entry.displayRunAt).toBe(localDate(8).toISOString());
    expect(entry.nextRunAt).toBe(new Date(2026, 5, 20, 8).toISOString());

    const model = buildScheduleTimelineModel(state, localDate(12));
    const todayOccurrence = model.nextSevenDays[0].entries[0];
    const tomorrowOccurrence = model.nextSevenDays[1].entries[0];

    expect(todayOccurrence.bucket).toBe("missed");
    expect(todayOccurrence.displayRunAt).toBe(localDate(8).toISOString());
    expect(tomorrowOccurrence.bucket).toBe("upcoming");
    expect(tomorrowOccurrence.displayRunAt).not.toBe(todayOccurrence.displayRunAt);
    expect(tomorrowOccurrence.occurrenceKey).not.toBe(todayOccurrence.occurrenceKey);
  });
});
