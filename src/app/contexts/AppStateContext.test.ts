import { act, render, waitFor } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAuthProfile,
  AppState,
  ApprovalGrant,
  AutonomyMode,
  CapabilityRegistrySnapshot,
  PlannerRationale,
  RawToolInventoryItem,
  RavenWorkflow,
} from "../../domain/types";
import { AppStateProvider, initialState, providerAccountForAgentProfile, useAppState } from "./AppStateContext";

const bridgeMocks = vi.hoisted(() => ({
  archivePersistedWorkflow: vi.fn(async () => null),
  assignPersistedScheduleOverride: vi.fn(async () => null),
  availableCapabilityCatalog: vi.fn(async (mode: AutonomyMode): Promise<CapabilityRegistrySnapshot> => ({
    hash: `${mode}-registry`,
    generatedAt: "2026-06-21T00:00:00.000Z",
    capabilities: [],
    policyDecisions: [],
  })),
  checkPersistedProviderReadiness: vi.fn(async () => []),
  configurePersistedArtifactDestination: vi.fn(async () => null),
  configurePersistedAiChatImportFolder: vi.fn(async () => null),
  configurePersistedDocumentImportFolder: vi.fn(async () => null),
  configurePersistedGithubContext: vi.fn(async () => null),
  configurePersistedNestWeaver: vi.fn(async () => null),
  configurePersistedProviderAccount: vi.fn(async () => null),
  createApprovalGrant: vi.fn(async (draft: ApprovalGrant): Promise<ApprovalGrant> => draft),
  detectTools: vi.fn(async (): Promise<RawToolInventoryItem[]> => []),
  exportPersistedArtifact: vi.fn(async () => null),
  generatePersistedArtifactPreview: vi.fn(async () => null),
  getSavedSettings: vi.fn(async (): Promise<Record<string, unknown> | null> => ({})),
  indexPersistedNestWeaverProject: vi.fn(async () => null),
  installPersistedWorkflowTemplate: vi.fn(async () => null),
  listApprovalGrants: vi.fn(async (): Promise<ApprovalGrant[]> => []),
  loadPersistedAppState: vi.fn(async (): Promise<AppState | null> => null),
  loadPersistedSchedulerStatus: vi.fn(async () => null),
  regeneratePersistedArtifact: vi.fn(async () => null),
  retryPersistedWorkflowRun: vi.fn(async () => null),
  revokeApprovalGrant: vi.fn(async () => undefined),
  runPersistedDueSchedules: vi.fn(async () => null),
  runPersistedWorkflow: vi.fn(async () => null),
  scanPersistedAiChatImportFolder: vi.fn(async () => null),
  scanPersistedDocumentImportFolder: vi.fn(async () => null),
  scanPersistedGithubContext: vi.fn(async () => null),
  setPersistedAutonomyCategoryOverrides: vi.fn(async () => true),
  setPersistedAutonomyMode: vi.fn(async () => true),
  setPersistedBuilderProfile: vi.fn(async () => true),
  startPersistedScheduler: vi.fn(async () => false),
  stopPersistedScheduler: vi.fn(async () => false),
  updatePersistedWorkflowSafeFields: vi.fn(async () => null),
}));

vi.mock("../tauriBridge", () => bridgeMocks);

vi.mock("../nativeIntegrations", () => ({
  chooseAiChatImportFolder: vi.fn(async () => null),
  chooseArtifactDestinationFolder: vi.fn(async () => null),
  choosePdfDocumentImportFolder: vi.fn(async () => null),
  notifyWorkflowRunCompleted: vi.fn(async () => undefined),
  notifyWorkflowRunFailed: vi.fn(async () => undefined),
}));

const baseProfile: AgentAuthProfile = {
  id: "openai-api-key",
  displayName: "OpenAI",
  runnerKind: "openai_api",
  authMode: "api_key_keychain",
  credentialRef: "env:OPENAI_API_KEY",
  model: "gpt-4.1",
  effort: "medium",
  status: "needs_config",
  summary: "OpenAI API profile.",
};

function registry(hash: string): CapabilityRegistrySnapshot {
  return {
    hash,
    generatedAt: "2026-06-21T00:00:00.000Z",
    capabilities: [],
    policyDecisions: [],
  };
}

function grant(overrides: Partial<ApprovalGrant> = {}): ApprovalGrant {
  return {
    id: "grant-1",
    workflowId: "daily-work-journal",
    workflowVersion: 1,
    capabilityId: "github.issues",
    grantType: "network_access",
    scope: {
      paths: [],
      domains: ["api.github.com"],
      resourceIds: [],
      externalTargets: [],
    },
    approvedByUserAt: "2026-06-21T00:00:00.000Z",
    signatureHash: "sig",
    status: "active",
    ...overrides,
  };
}

function rawTool(overrides: Partial<RawToolInventoryItem> = {}): RawToolInventoryItem {
  return {
    id: "cli.rg",
    source: "cli",
    displayName: "ripgrep",
    binaryPath: "/usr/bin/rg",
    version: "14.0.0",
    status: "available",
    authStatus: "unknown",
    operations: [],
    annotations: {},
    detectionErrors: [],
    lastCheckedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness({ onValue }: { onValue: (value: ReturnType<typeof useAppState>) => void }) {
  const value = useAppState();
  useEffect(() => {
    onValue(value);
  }, [onValue, value]);
  return null;
}

async function renderAppState() {
  let latest: ReturnType<typeof useAppState> | null = null;
  render(
    createElement(
      AppStateProvider,
      null,
      createElement(Harness, { onValue: (value) => { latest = value; } }),
    ),
  );
  await waitFor(() => expect(latest).not.toBeNull());
  return {
    get value() {
      if (!latest) throw new Error("App state context not captured");
      return latest;
    },
  };
}

function persistedState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    workflows: [],
    runs: [],
    artifacts: [],
    providers: [],
    llmProfiles: [],
    agentAuthProfiles: [],
    chatMessages: [],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  Object.values(bridgeMocks).forEach((mock) => mock.mockClear());
  bridgeMocks.availableCapabilityCatalog.mockImplementation(async (mode: AutonomyMode) =>
    registry(`${mode}-registry`),
  );
  bridgeMocks.detectTools.mockResolvedValue([]);
  bridgeMocks.getSavedSettings.mockResolvedValue({});
  bridgeMocks.listApprovalGrants.mockResolvedValue([]);
  bridgeMocks.loadPersistedAppState.mockResolvedValue(null);
  bridgeMocks.createApprovalGrant.mockImplementation(async (draft: ApprovalGrant): Promise<ApprovalGrant> => draft);
  bridgeMocks.revokeApprovalGrant.mockResolvedValue(undefined);
  bridgeMocks.setPersistedAutonomyCategoryOverrides.mockResolvedValue(true);
  bridgeMocks.setPersistedAutonomyMode.mockResolvedValue(true);
});

describe("provider credential profile contract", () => {
  it("maps API profile ids to provider account semantics without raw secrets", () => {
    const openai = providerAccountForAgentProfile(baseProfile);
    const anthropic = providerAccountForAgentProfile({
      ...baseProfile,
      id: "anthropic-api-key",
      displayName: "Anthropic",
      runnerKind: "anthropic_api",
      credentialRef: "env:ANTHROPIC_API_KEY",
      model: "claude-sonnet-4-5",
    });

    expect(openai).toMatchObject({
      id: "openai-api-key",
      providerKind: "llm",
      displayName: "OpenAI",
      credentialRef: "keychain:pending",
      settingsJson: { provider_id: "openai", profile_id: "openai-api-key" },
    });
    expect(anthropic).toMatchObject({
      id: "anthropic-api-key",
      providerKind: "llm",
      displayName: "Anthropic",
      credentialRef: "keychain:pending",
      settingsJson: { provider_id: "anthropic", profile_id: "anthropic-api-key" },
    });
    expect(JSON.stringify([openai, anthropic])).not.toContain("sk-");
  });

  it("rejects credential configuration for non API profiles", () => {
    expect(() =>
      providerAccountForAgentProfile({
        ...baseProfile,
        id: "codex-oauth-local",
        runnerKind: "codex_cli",
        authMode: "codex_oauth_local_cli",
      }),
    ).toThrow(/does not accept API keys/);
  });
});

describe("app state tool autonomy actions", () => {
  it("loads persisted autonomy mode from saved settings", async () => {
    bridgeMocks.getSavedSettings.mockResolvedValue({ autonomy_mode: "workspace_auto" });

    const app = await renderAppState();

    await waitFor(() => expect(app.value.state.autonomyMode).toBe("workspace_auto"));
    expect(bridgeMocks.availableCapabilityCatalog).toHaveBeenCalledWith("workspace_auto", {});
  });

  it("passes planner rationale through workflow template installs", async () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "agent-weather",
      name: "Agent Weather",
      description: "Checks weather with an agent.",
      permissions: ["llm:generate", "network:read"],
      defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [],
    };
    const plannerRationale: PlannerRationale = {
      prompt: "Check Denver weather.",
      operations: [
        {
          id: "op-weather",
          kind: "weather.lookup",
          status: "covered",
          evidence: "Prompt requested weather.",
          capabilityId: "weather.current",
          stepId: "ask-ai",
          inputs: {},
        },
      ],
      warnings: [],
    };
    bridgeMocks.installPersistedWorkflowTemplate.mockImplementationOnce(async () => ({
      id: "agent-weather-v1",
      workflowId: "agent-weather",
      version: 1,
      status: "enabled",
      approvalMode: "review_changes",
      plannerRationale,
      definition: workflow,
      createdAt: "2026-06-22T20:00:00.000Z",
    }) as never);
    const app = await renderAppState();

    await act(async () => {
      await app.value.actions.installWorkflowTemplate(
        workflow,
        "enabled",
        "review_changes",
        plannerRationale,
      );
    });

    expect(bridgeMocks.installPersistedWorkflowTemplate).toHaveBeenCalledWith(
      workflow,
      "enabled",
      "review_changes",
      plannerRationale,
    );
    expect(app.value.state.workflows[0]).toMatchObject({
      workflowId: "agent-weather",
      plannerRationale: {
        operations: [expect.objectContaining({ capabilityId: "weather.current" })],
      },
    });
  });

  it("persists category overrides and refreshes policy catalog", async () => {
    const app = await renderAppState();

    let result = "";
    await act(async () => {
      result = await app.value.actions.setAutonomyCategoryOverride("local_context", "ask_first");
    });

    expect(result).toBe("Category override saved");
    expect(bridgeMocks.setPersistedAutonomyCategoryOverrides).toHaveBeenCalledWith({
      local_context: "ask_first",
    });
    expect(bridgeMocks.availableCapabilityCatalog).toHaveBeenCalledWith("safe_auto", {
      local_context: "ask_first",
    });
    expect(app.value.state.autonomyCategoryOverrides).toEqual({ local_context: "ask_first" });
  });

  it("persists multiple category overrides in one update", async () => {
    const app = await renderAppState();

    let result = "";
    await act(async () => {
      result = await app.value.actions.setAutonomyCategoryOverrides({
        local_context: "ask_first",
        web_content: "ask_first",
      });
    });

    expect(result).toBe("Category overrides saved");
    expect(bridgeMocks.setPersistedAutonomyCategoryOverrides).toHaveBeenCalledWith({
      local_context: "ask_first",
      web_content: "ask_first",
    });
    expect(bridgeMocks.availableCapabilityCatalog).toHaveBeenCalledWith("safe_auto", {
      local_context: "ask_first",
      web_content: "ask_first",
    });
    expect(app.value.state.autonomyCategoryOverrides).toEqual({
      local_context: "ask_first",
      web_content: "ask_first",
    });
  });

  it("does not let slow startup settings overwrite a user-selected autonomy mode", async () => {
    const startupState = deferred<AppState | null>();
    const startupSettings = deferred<Record<string, unknown> | null>();
    bridgeMocks.loadPersistedAppState.mockReturnValue(startupState.promise);
    bridgeMocks.getSavedSettings.mockReturnValue(startupSettings.promise);
    const app = await renderAppState();

    await act(async () => {
      await app.value.actions.setAutonomyMode("power_auto");
    });
    expect(app.value.state.autonomyMode).toBe("power_auto");
    expect(app.value.state.capabilityRegistry.hash).toBe("power_auto-registry");

    await act(async () => {
      startupState.resolve(persistedState({ autonomyMode: "safe_auto" }));
      startupSettings.resolve({ autonomy_mode: "workspace_auto" });
      await Promise.all([startupState.promise, startupSettings.promise]);
    });

    expect(app.value.state.autonomyMode).toBe("power_auto");
    expect(app.value.state.capabilityRegistry.hash).toBe("power_auto-registry");
  });

  it("does not hide active grants when revoke fails", async () => {
    bridgeMocks.listApprovalGrants.mockResolvedValue([grant()]);
    bridgeMocks.revokeApprovalGrant.mockRejectedValue(new Error("backend unavailable"));
    const app = await renderAppState();
    await waitFor(() => expect(app.value.state.approvalGrants).toHaveLength(1));

    let result = "";
    await act(async () => {
      result = await app.value.actions.revokeApprovalGrant("grant-1");
    });

    expect(result).toBe("Approval grant revoke failed");
    expect(app.value.state.approvalGrants).toMatchObject([{ id: "grant-1", status: "active" }]);
  });

  it("creates approval grants and refreshes grant state", async () => {
    const persistedGrant = grant({ id: "grant-created", capabilityId: "github.issue.comment" });
    bridgeMocks.createApprovalGrant.mockResolvedValue(persistedGrant);
    bridgeMocks.listApprovalGrants.mockResolvedValue([persistedGrant]);
    const app = await renderAppState();

    let result = "";
    await act(async () => {
      result = await app.value.actions.createApprovalGrant(persistedGrant);
    });

    expect(result).toBe("Approval grant created");
    expect(bridgeMocks.createApprovalGrant).toHaveBeenCalledWith(persistedGrant);
    expect(app.value.state.approvalGrants).toMatchObject([
      { id: "grant-created", capabilityId: "github.issue.comment", status: "active" },
    ]);
  });

  it("keeps current autonomy tools state when refreshState loads persisted app state", async () => {
    bridgeMocks.getSavedSettings.mockResolvedValue({ autonomy_mode: "workspace_auto" });
    bridgeMocks.listApprovalGrants.mockResolvedValue([grant()]);
    bridgeMocks.detectTools.mockResolvedValue([rawTool()]);
    bridgeMocks.loadPersistedAppState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(persistedState({ autonomyMode: "safe_auto" }));
    const app = await renderAppState();
    await waitFor(() => expect(app.value.state.autonomyMode).toBe("workspace_auto"));

    await act(async () => {
      await app.value.actions.refreshState();
    });

    expect(app.value.state.autonomyMode).toBe("workspace_auto");
    expect(app.value.state.capabilityRegistry.hash).toBe("workspace_auto-registry");
    expect(app.value.state.rawToolInventory).toMatchObject([{ id: "cli.rg", displayName: "ripgrep" }]);
    expect(app.value.state.approvalGrants).toMatchObject([{ id: "grant-1", status: "active" }]);
  });

  it("ignores stale capability catalog responses after rapid autonomy mode changes", async () => {
    const workspace = deferred<CapabilityRegistrySnapshot>();
    const power = deferred<CapabilityRegistrySnapshot>();
    bridgeMocks.availableCapabilityCatalog.mockImplementation((mode: AutonomyMode) => {
      if (mode === "workspace_auto") return workspace.promise;
      if (mode === "power_auto") return power.promise;
      return Promise.resolve(registry(`${mode}-registry`));
    });
    const app = await renderAppState();

    let first: Promise<string>;
    let second: Promise<string>;
    await act(async () => {
      first = app.value.actions.setAutonomyMode("workspace_auto");
      second = app.value.actions.setAutonomyMode("power_auto");
    });
    await act(async () => {
      power.resolve(registry("power-registry"));
      await second!;
    });
    await act(async () => {
      workspace.resolve(registry("workspace-registry"));
      await first!;
    });

    expect(app.value.state.autonomyMode).toBe("power_auto");
    expect(app.value.state.capabilityRegistry.hash).toBe("power-registry");
  });
});
