import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDraft, WorkflowStepDefinition } from "../domain/types";
import {
  archivePersistedWorkflow,
  approvePersistedWorkflowDraft,
  approveWorkflowSignatureBaseline,
  availableCapabilityCatalog,
  createPersistedWorkflowDraft,
  createApprovalGrant,
  detectTools,
  evaluateWorkflowDefinitionPreflight,
  evaluateWorkflowPreflight,
  installPersistedWorkflowTemplate,
  listCapabilityAuditEvents,
  listApprovalGrants,
  loadPersistedAppState,
  revokeApprovalGrant,
  runPersistedWorkflow,
  runWorkflowStreamed,
  setPersistedAutonomyCategoryOverrides,
  setPersistedAutonomyMode,
} from "./tauriBridge";

const invokeMock = vi.fn();
const listenMock = vi.fn();
const { MockChannel } = vi.hoisted(() => {
  class MockChannel<T = unknown> {
    onmessage: (message: T) => void;

    constructor(onmessage?: (message: T) => void) {
      this.onmessage = onmessage ?? (() => {});
    }
  }

  return { MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: MockChannel,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const agentStep: WorkflowStepDefinition = {
  kind: "agent_task",
  id: "ask-ai",
  name: "Ask AI",
  provider: "agent",
  action: "run_task",
  dependsOn: [],
  permissions: ["llm:generate", "network:read"],
  llmProfileRef: "codex-oauth-local",
  inputs: {
    objective: "What's the weather today in Denver?",
    output_schema: "artifact_envelope",
    allowed_tools: ["web"],
  },
};

const workflowDraft: WorkflowDraft = {
  id: "draft-agent-weather",
  prompt: "What's the weather today in Denver?",
  summary: "Asks an agent for weather and saves the result.",
  permissionChanges: ["llm:generate", "network:read", "artifact:write"],
  destinationWrites: ["local-app"],
  diffJson: [],
  validationStatus: "valid",
  approvalStatus: "needs_review",
  approvalMode: "auto_approve",
  validationErrors: [],
  definition: {
    schemaVersion: "0.1.0",
    id: "agent-weather",
    name: "Agent Weather",
    description: "Asks an agent for weather and saves the result.",
    permissions: ["llm:generate", "network:read", "artifact:write"],
    defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
    schedule: { cadence: "manual" },
    steps: [agentStep],
  },
  createdAt: "2026-06-08T10:00:00Z",
};

describe("tauri workflow bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("preserves workflow step kind when loading persisted state", async () => {
    invokeMock.mockResolvedValueOnce({
      workflows: [
        {
          id: "agent-weather-v1",
          workflow_id: "agent-weather",
          version: 1,
          status: "draft",
          definition: {
            schema_version: "0.1.0",
            id: "agent-weather",
            name: "Agent Weather",
            description: "Asks an agent for weather and saves the result.",
            permissions: ["llm:generate", "network:read", "artifact:write"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "manual" },
            steps: [
              {
                kind: "agent_task",
                id: "ask-ai",
                name: "Ask AI",
                provider: "agent",
                action: "run_task",
                depends_on: [],
                permissions: ["llm:generate", "network:read"],
                llm_profile_ref: "codex-oauth-local",
                inputs: {
                  objective: "What's the weather today in Denver?",
                  output_schema: "artifact_envelope",
                  allowed_tools: ["web"],
                },
              },
            ],
          },
          created_at: "2026-06-08T10:00:00Z",
        },
      ],
      runs: [],
      artifacts: [],
      providers: [],
      llm_profiles: [],
      agent_auth_profiles: [],
    });

    const appState = await loadPersistedAppState();

    expect(appState?.workflows[0].definition.steps[0].kind).toBe("agent_task");
  });

  it("routes capability registry bridge commands and normalizes snake case responses", async () => {
    invokeMock
      .mockResolvedValueOnce([
        {
          id: "cli.rg",
          label: "ripgrep",
          source: "cli",
          status: "available",
          auth_status: null,
          operations: [{ name: "search", read_only: true, writes_files: false }],
          annotations: { version: "14.1.0" },
          detected_at: "2026-06-21T00:00:00Z",
        },
      ])
      .mockResolvedValueOnce({
        hash: "capreg-test",
        generated_at: "2026-06-21T00:00:00Z",
        policy_decisions: [
          {
            capability_id: "code.repo_search",
            decision: "auto",
            reason: "Backend catalog: trusted repo search.",
          },
        ],
        capabilities: [
          {
            id: "code.repo_search",
            provider: "code",
            action: "repo_search",
            display_name: "Search repository",
            description: "Searches repository text.",
            category: "code",
            source: "cli",
            status: "available",
            execution_mode: "deterministic",
            deterministic: true,
            read_only: true,
            idempotent: true,
            destructive: false,
            open_world: false,
            requires_network: false,
            writes_files: false,
            requires_credentials: false,
            permissions: ["filesystem:read"],
            operation_tags: ["search.code"],
            intent_tags: ["code"],
            best_for: [],
            not_for: [],
            builder_guidance: "Use for repository search.",
            fallback_strategy: "Ask the user.",
            input_schema: { type: "object" },
            output_schema: { type: "string" },
            trust_tier: "verified_local",
            default_approval: "auto",
            adapter: {
              kind: "cli",
              command: "rg",
              args_template: ["--json", "--", "{query}", "{path}"],
              timeout_ms: 10000,
            },
            signature_hash: "sig",
            last_checked_at: "2026-06-21T00:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        id: "preflight-test",
        workflow_id: "current-weather",
        workflow_version: 1,
        registry_snapshot_hash: "capreg-test",
        created_at: "2026-06-21T00:00:00Z",
        capabilities: [
          {
            capability_id: "open_meteo.current_weather",
            step_id: "fetch-weather",
            policy_decision: "auto",
            reason: "Trusted read-only deterministic capability.",
            signature_hash: "sig",
          },
        ],
        credentials: [],
        network_domains: ["api.open-meteo.com"],
        scoped_network_resources: [
          {
            step_id: "fetch-weather",
            capability_id: "open_meteo.current_weather",
            value: "open_meteo.current_weather",
          },
        ],
        file_reads: [],
        file_writes: [],
        overwrites: [],
        deletes: [
          {
            step_id: "cleanup",
            capability_id: "local_app.delete_file",
            path_pattern: "/tmp/raven/*",
            max_deletes: 0,
          },
        ],
        external_publishes: [],
        policy_recommendation: "safe_auto",
        blocking_items: [],
      })
      .mockResolvedValueOnce({
        id: "preflight-draft-test",
        workflow_id: "current-weather",
        workflow_version: 1,
        registry_snapshot_hash: "capreg-test",
        created_at: "2026-06-21T00:00:00Z",
        capabilities: [
          {
            capability_id: "open_meteo.current_weather",
            step_id: "fetch-weather",
            policy_decision: "auto",
            reason: "Trusted read-only deterministic capability.",
            signature_hash: "sig",
          },
        ],
        credentials: [],
        network_domains: ["api.open-meteo.com"],
        scoped_network_resources: [
          {
            step_id: "fetch-weather",
            capability_id: "open_meteo.current_weather",
            value: "open_meteo.current_weather",
          },
        ],
        file_reads: [],
        file_writes: [],
        overwrites: [],
        deletes: [
          {
            step_id: "cleanup",
            capability_id: "local_app.delete_file",
            path_pattern: "/tmp/raven/*",
            max_deletes: 0,
          },
        ],
        external_publishes: [],
        policy_recommendation: "safe_auto",
        blocking_items: [],
      })
      .mockResolvedValueOnce({
        id: "grant-1",
        workflow_id: "current-weather",
        workflow_version: 1,
        capability_id: "open_meteo.current_weather",
        grant_type: "network_access",
        scope: {
          credential_ref: null,
          paths: [],
          domains: ["api.open-meteo.com"],
          resource_ids: [],
          max_deletes: 0,
          max_overwrite_bytes: 0,
          external_targets: [],
        },
        approved_by_user_at: "2026-06-21T00:00:00Z",
        expires_at: null,
        signature_hash: "sig",
        status: "active",
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          id: "grant-1",
          workflow_id: "current-weather",
          workflow_version: 1,
          capability_id: "open_meteo.current_weather",
          grant_type: "network_access",
          scope: {
            credential_ref: null,
            paths: [],
            domains: ["api.open-meteo.com"],
            resource_ids: [],
            max_deletes: 0,
            max_overwrite_bytes: 0,
            external_targets: [],
          },
          approved_by_user_at: "2026-06-21T00:00:00Z",
          expires_at: null,
          signature_hash: "sig",
          status: "active",
        },
      ]);

    await expect(detectTools()).resolves.toMatchObject([{ id: "cli.rg", authStatus: undefined }]);
    await expect(availableCapabilityCatalog("safe_auto")).resolves.toMatchObject({
      generatedAt: "2026-06-21T00:00:00Z",
      capabilities: [
        {
          displayName: "Search repository",
          operationTags: ["search.code"],
          policy: {
            decision: "auto",
            reason: "Backend catalog: trusted repo search.",
          },
          adapter: {
            kind: "cli",
            argsTemplate: ["--json", "--", "{query}", "{path}"],
            timeoutMs: 10000,
          },
        },
      ],
    });
    await expect(evaluateWorkflowPreflight("current-weather", 1)).resolves.toMatchObject({
      workflowId: "current-weather",
      registrySnapshotHash: "capreg-test",
      capabilities: [{ capabilityId: "open_meteo.current_weather", policyDecision: "auto" }],
      scopedNetworkResources: [
        {
          stepId: "fetch-weather",
          capabilityId: "open_meteo.current_weather",
          value: "open_meteo.current_weather",
        },
      ],
      deletes: [{ maxDeletes: 0 }],
    });
    await expect(evaluateWorkflowDefinitionPreflight({
      schemaVersion: "0.1.0",
      id: "current-weather",
      name: "Current Weather",
      description: "Get the current weather forecast.",
      permissions: ["weather:read", "artifact:write"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "fetch-weather",
          name: "Fetch weather",
          provider: "open_meteo",
          action: "current_weather",
          dependsOn: [],
          permissions: ["weather:read"],
          inputs: { location: "Denver, CO" },
        },
      ],
    }, 1)).resolves.toMatchObject({
      workflowId: "current-weather",
      registrySnapshotHash: "capreg-test",
    });
    await expect(
      createApprovalGrant({
        id: "grant-1",
        workflowId: "current-weather",
        workflowVersion: 1,
        capabilityId: "open_meteo.current_weather",
        grantType: "network_access",
        scope: {
          paths: [],
          domains: ["api.open-meteo.com"],
          resourceIds: [],
          maxDeletes: 0,
          maxOverwriteBytes: 0,
          externalTargets: [],
        },
        approvedByUserAt: "2026-06-21T00:00:00Z",
        signatureHash: "sig",
        status: "active",
      }),
    ).resolves.toMatchObject({
      workflowId: "current-weather",
      grantType: "network_access",
      scope: { maxDeletes: 0, maxOverwriteBytes: 0 },
    });
    await expect(revokeApprovalGrant("grant-1")).resolves.toBeUndefined();
    await expect(listApprovalGrants("current-weather")).resolves.toMatchObject([
      {
        id: "grant-1",
        scope: { domains: ["api.open-meteo.com"], maxDeletes: 0, maxOverwriteBytes: 0 },
      },
    ]);
    await expect(approveWorkflowSignatureBaseline("current-weather", 1)).resolves.toBeUndefined();
    invokeMock.mockResolvedValueOnce(undefined);

    expect(invokeMock).toHaveBeenCalledWith("detect_tools");
    expect(invokeMock).toHaveBeenCalledWith("available_capability_catalog", {
      autonomyMode: "safe_auto",
      categoryOverrides: {},
    });
    expect(invokeMock).toHaveBeenCalledWith("evaluate_workflow_preflight", {
      workflowId: "current-weather",
      version: 1,
      autonomyMode: "safe_auto",
      categoryOverrides: {},
    });
    expect(invokeMock).toHaveBeenCalledWith("evaluate_workflow_definition_preflight", {
      definition: expect.objectContaining({
        id: "current-weather",
        schema_version: "0.1.0",
      }),
      version: 1,
      autonomyMode: "safe_auto",
      categoryOverrides: {},
    });
    expect(invokeMock).toHaveBeenCalledWith("create_approval_grant", {
      grant: expect.objectContaining({
        workflow_id: "current-weather",
        grant_type: "network_access",
      }),
    });
    expect(invokeMock).toHaveBeenCalledWith("approve_workflow_signature_baseline", {
      workflowId: "current-weather",
      workflowVersion: 1,
    });
    expect(invokeMock).toHaveBeenCalledWith("revoke_approval_grant", { id: "grant-1" });
    expect(invokeMock).toHaveBeenCalledWith("list_approval_grants", {
      workflowId: "current-weather",
    });
    await expect(setPersistedAutonomyMode("workspace_auto")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("set_autonomy_mode", {
      autonomyMode: "workspace_auto",
    });
    invokeMock.mockResolvedValueOnce(undefined);
    await expect(setPersistedAutonomyCategoryOverrides({ local_context: "ask_first" })).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("set_autonomy_category_overrides", {
      categoryOverrides: { local_context: "ask_first" },
    });

    const invokedCommands = invokeMock.mock.calls.map(([command]) => command);
    expect(invokedCommands).toEqual(expect.arrayContaining([
      "detect_tools",
      "available_capability_catalog",
      "evaluate_workflow_preflight",
      "evaluate_workflow_definition_preflight",
      "create_approval_grant",
      "approve_workflow_signature_baseline",
      "revoke_approval_grant",
      "list_approval_grants",
      "set_autonomy_mode",
      "set_autonomy_category_overrides",
    ]));
    expect(invokedCommands.indexOf("set_autonomy_mode")).toBeLessThan(
      invokedCommands.indexOf("set_autonomy_category_overrides"),
    );
  });

  it("normalizes persisted capability audit events", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        id: "audit-1",
        run_id: "run-1",
        workflow_id: "daily-work-journal",
        workflow_version: 3,
        step_id: "publish",
        capability_id: "github.issue.comment",
        decision: "needs_grant",
        reason: "Matched pre-approved GitHub publishing grant.",
        grant_id: "grant-1",
        created_at: "2026-06-19T10:01:30.000Z",
      },
    ]);

    await expect(listCapabilityAuditEvents("run-1")).resolves.toMatchObject([
      {
        id: "audit-1",
        runId: "run-1",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        stepId: "publish",
        capabilityId: "github.issue.comment",
        decision: "needs_grant",
        reason: "Matched pre-approved GitHub publishing grant.",
        grantId: "grant-1",
        createdAt: "2026-06-19T10:01:30.000Z",
      },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("list_capability_audit_events", { runId: "run-1" });
  });

  it("preserves run input/output token split when loading persisted state", async () => {
    invokeMock.mockResolvedValueOnce({
      workflows: [],
      runs: [
        {
          id: "usage-split-run",
          workflow_id: "daily-work-journal",
          workflow_name: "Daily Work Journal",
          status: "succeeded",
          started_at: "2026-06-19T10:00:00Z",
          completed_at: "2026-06-19T10:00:05Z",
          idempotency_key: "usage-split-run",
          total_tokens: 1000,
          input_tokens: 125,
          output_tokens: 875,
          total_cost_usd: 0.00725,
        },
      ],
      artifacts: [],
      schedule_overrides: [],
      providers: [],
      llm_profiles: [],
      agent_auth_profiles: [],
      chat_messages: [],
    });

    const appState = await loadPersistedAppState();

    expect(appState?.runs[0]).toMatchObject({
      totalTokens: 1000,
      inputTokens: 125,
      outputTokens: 875,
    });
  });

  it("defaults missing or unknown workflow step kind to provider_action when loading persisted state", async () => {
    invokeMock.mockResolvedValueOnce({
      workflows: [
        {
          id: "legacy-weather-v1",
          workflow_id: "legacy-weather",
          version: 1,
          status: "draft",
          definition: {
            schema_version: "0.1.0",
            id: "legacy-weather",
            name: "Legacy Weather",
            description: "Legacy workflow without step kind.",
            permissions: ["weather:read"],
            defaults: { llm_profile_ref: "open-meteo", destination_ref: "local-app" },
            steps: [
              {
                id: "fetch-weather",
                name: "Fetch current weather",
                provider: "open_meteo",
                action: "current_weather",
                depends_on: [],
                permissions: ["weather:read"],
                inputs: { location: "Denver, CO" },
              },
            ],
          },
          created_at: "2026-06-08T10:00:00Z",
        },
        {
          id: "unknown-kind-weather-v1",
          workflow_id: "unknown-kind-weather",
          version: 1,
          status: "draft",
          definition: {
            schema_version: "0.1.0",
            id: "unknown-kind-weather",
            name: "Unknown Kind Weather",
            description: "Workflow with an unknown step kind.",
            permissions: ["weather:read"],
            defaults: { llm_profile_ref: "open-meteo", destination_ref: "local-app" },
            steps: [
              {
                kind: "surprise_kind",
                id: "fetch-weather",
                name: "Fetch current weather",
                provider: "open_meteo",
                action: "current_weather",
                depends_on: [],
                permissions: ["weather:read"],
                inputs: { location: "Denver, CO" },
              },
            ],
          },
          created_at: "2026-06-08T10:00:00Z",
        },
      ],
      runs: [],
      artifacts: [],
      providers: [],
      llm_profiles: [],
      agent_auth_profiles: [],
    });

    const appState = await loadPersistedAppState();

    expect(appState?.workflows[0].definition.steps[0].kind).toBe("provider_action");
    expect(appState?.workflows[1].definition.steps[0].kind).toBe("provider_action");
  });

  it("preserves workflow step kind when approving drafts", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "agent-weather-v1",
      workflow_id: "agent-weather",
      version: 1,
      status: "enabled",
      approval_mode: "always_review",
      definition: {
        schema_version: "0.1.0",
        id: workflowDraft.definition.id,
        name: workflowDraft.definition.name,
        description: workflowDraft.definition.description,
        permissions: workflowDraft.definition.permissions,
        defaults: {
          llm_profile_ref: workflowDraft.definition.defaults.llmProfileRef,
          destination_ref: workflowDraft.definition.defaults.destinationRef,
        },
        schedule: workflowDraft.definition.schedule,
        steps: [
          {
            kind: "agent_task",
            id: "ask-ai",
            name: "Ask AI",
            provider: "agent",
            action: "run_task",
            depends_on: [],
            permissions: ["llm:generate", "network:read"],
            llm_profile_ref: "codex-oauth-local",
            inputs: {
              objective: "What's the weather today in Denver?",
              output_schema: "artifact_envelope",
              allowed_tools: ["web"],
            },
          },
        ],
      },
      created_at: "2026-06-08T10:00:00Z",
    });

    const approved = await approvePersistedWorkflowDraft(workflowDraft);

    expect(approved?.workflowId).toBe("agent-weather");
    expect(invokeMock).toHaveBeenCalledWith("approve_workflow_draft", {
      draft: expect.objectContaining({
        approval_mode: "auto_approve",
        definition: expect.objectContaining({
          steps: [expect.objectContaining({ kind: "agent_task" })],
        }),
      }),
    });
  });

  it("uses Tauri invoke when backend URL env var is absent", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "agent-weather-v1",
      workflow_id: "agent-weather",
      version: 1,
      status: "enabled",
      definition: {
        schema_version: "0.1.0",
        id: workflowDraft.definition.id,
        name: workflowDraft.definition.name,
        description: workflowDraft.definition.description,
        permissions: workflowDraft.definition.permissions,
        defaults: {
          llm_profile_ref: workflowDraft.definition.defaults.llmProfileRef,
          destination_ref: workflowDraft.definition.defaults.destinationRef,
        },
        steps: [],
      },
      created_at: "2026-06-08T10:00:00Z",
    });

    await approvePersistedWorkflowDraft(workflowDraft);

    expect(invokeMock).toHaveBeenCalledWith("approve_workflow_draft", {
      draft: expect.objectContaining({ id: workflowDraft.id }),
    });
  });

  it("installs workflow templates through the persisted command", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "agent-weather-v2",
      workflow_id: "agent-weather",
      version: 2,
      status: "draft",
      approval_mode: "review_changes",
      definition: {
        schema_version: "0.1.0",
        id: workflowDraft.definition.id,
        name: workflowDraft.definition.name,
        description: workflowDraft.definition.description,
        permissions: workflowDraft.definition.permissions,
        defaults: {
          llm_profile_ref: workflowDraft.definition.defaults.llmProfileRef,
          destination_ref: workflowDraft.definition.defaults.destinationRef,
        },
        schedule: workflowDraft.definition.schedule,
        steps: [],
      },
      created_at: "2026-06-08T10:00:00Z",
    });

    const installed = await installPersistedWorkflowTemplate(
      workflowDraft.definition,
      "draft",
      "review_changes",
    );

    expect(installed?.version).toBe(2);
    expect(installed?.approvalMode).toBe("review_changes");
    expect(invokeMock).toHaveBeenCalledWith("install_workflow_template", {
      definition: expect.objectContaining({
        schema_version: "0.1.0",
        defaults: expect.objectContaining({ llm_profile_ref: "codex-oauth-local" }),
      }),
      status: "draft",
      approvalMode: "review_changes",
    });
  });

  it("passes planner rationale when installing workflow templates", async () => {
    const plannerRationale = {
      prompt: workflowDraft.prompt,
      operations: [
        {
          id: "op-weather",
          kind: "weather.lookup",
          status: "covered" as const,
          evidence: "Prompt requested weather for Denver.",
          capabilityId: "weather.current",
          stepId: "ask-ai",
          inputs: { location: "Denver" },
        },
      ],
      warnings: ["Review network access before enabling."],
    };
    invokeMock.mockResolvedValueOnce({
      id: "agent-weather-v2",
      workflow_id: "agent-weather",
      version: 2,
      status: "enabled",
      approval_mode: "review_changes",
      planner_rationale: {
        prompt: workflowDraft.prompt,
        operations: [
          {
            id: "op-weather",
            kind: "weather.lookup",
            status: "covered",
            evidence: "Prompt requested weather for Denver.",
            capability_id: "weather.current",
            step_id: "ask-ai",
            inputs: { location: "Denver" },
          },
        ],
        warnings: ["Review network access before enabling."],
      },
      definition: {
        schema_version: "0.1.0",
        id: workflowDraft.definition.id,
        name: workflowDraft.definition.name,
        description: workflowDraft.definition.description,
        permissions: workflowDraft.definition.permissions,
        defaults: {
          llm_profile_ref: workflowDraft.definition.defaults.llmProfileRef,
          destination_ref: workflowDraft.definition.defaults.destinationRef,
        },
        schedule: workflowDraft.definition.schedule,
        steps: [],
      },
      created_at: "2026-06-08T10:00:00Z",
    });

    const installed = await installPersistedWorkflowTemplate(
      workflowDraft.definition,
      "enabled",
      "review_changes",
      plannerRationale,
    );

    expect(installed?.plannerRationale?.operations[0]).toMatchObject({
      capabilityId: "weather.current",
      stepId: "ask-ai",
    });
    expect(invokeMock).toHaveBeenCalledWith("install_workflow_template", {
      definition: expect.any(Object),
      status: "enabled",
      approvalMode: "review_changes",
      plannerRationale: {
        prompt: workflowDraft.prompt,
        operations: [
          expect.objectContaining({
            capability_id: "weather.current",
            step_id: "ask-ai",
          }),
        ],
        warnings: ["Review network access before enabling."],
      },
    });
  });

  it("archives workflows through the persisted command", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "agent-weather-v3",
      workflow_id: "agent-weather",
      version: 3,
      status: "disabled",
      approval_mode: "always_review",
      definition: {
        schema_version: "0.1.0",
        id: workflowDraft.definition.id,
        name: workflowDraft.definition.name,
        description: workflowDraft.definition.description,
        permissions: workflowDraft.definition.permissions,
        defaults: {
          llm_profile_ref: workflowDraft.definition.defaults.llmProfileRef,
          destination_ref: workflowDraft.definition.defaults.destinationRef,
        },
        steps: [],
      },
      created_at: "2026-06-08T10:00:00Z",
    });

    const archived = await archivePersistedWorkflow("agent-weather");

    expect(archived?.status).toBe("disabled");
    expect(invokeMock).toHaveBeenCalledWith("archive_workflow", {
      workflowId: "agent-weather",
    });
  });

  it("posts command args to the HTTP backend when backend URL env var is present", async () => {
    vi.stubEnv("VITE_RAVEN_BACKEND_URL", "http://127.0.0.1:18791");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: {
            id: "run-1",
            workflow_id: "current-weather",
            workflow_name: "Current Weather",
            status: "succeeded",
            started_at: "2026-06-09T12:00:00Z",
            idempotency_key: "manual-run-1",
            retry_count: 0,
          },
          duplicate: false,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runPersistedWorkflow("current-weather");

    expect(result?.run.id).toBe("run-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18791/commands/run_workflow",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId: "current-weather" }),
      }),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("surfaces HTTP backend non-2xx errors", async () => {
    vi.stubEnv("VITE_RAVEN_BACKEND_URL", "http://127.0.0.1:18791");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("backend exploded", { status: 500 })),
    );

    await expect(runPersistedWorkflow("current-weather")).rejects.toThrow(
      "HTTP backend command run_workflow failed with 500: backend exploded",
    );
  });

  it("subscribes to builder draft events before invoking draft creation", async () => {
    const unlisten = vi.fn();
    let eventHandler: ((event: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation(async (eventName: string, handler: typeof eventHandler) => {
      expect(eventName).toBe("raven://builder-draft-event");
      eventHandler = handler;
      return unlisten;
    });
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      expect(command).toBe("create_workflow_draft");
      expect(typeof args.requestId).toBe("string");
      eventHandler?.({
        payload: {
          request_id: args.requestId,
          phase: "typing",
          step_id: "draft",
          status: "active",
          title: "Builder is drafting",
          detail: "Waiting for structured workflow draft output.",
          event_kind: "text_delta",
          delta: "hello",
          raw_event_type: "response.output_text.delta",
          emitted_at: "2026-06-09T12:00:00Z",
        },
      });
      return {
        id: workflowDraft.id,
        prompt: workflowDraft.prompt,
        summary: workflowDraft.summary,
        permission_changes: workflowDraft.permissionChanges,
        destination_writes: workflowDraft.destinationWrites,
        diff_json: workflowDraft.diffJson,
        validation_status: workflowDraft.validationStatus,
        approval_status: workflowDraft.approvalStatus,
        builder_profile_id: workflowDraft.builderProfileId,
        approval_mode: workflowDraft.approvalMode,
        validation_errors: workflowDraft.validationErrors,
        planner_rationale: {
          prompt: workflowDraft.prompt,
          operations: [
            {
              id: "op-parse-csv",
              kind: "parse.csv",
              status: "covered",
              evidence: "Prompt requested CSV parsing.",
              capability_id: "data.parse_csv",
              step_id: "parse-csv",
              inputs: {},
            },
          ],
          warnings: [],
        },
        definition: {
          schema_version: "0.1.0",
          id: workflowDraft.definition.id,
          name: workflowDraft.definition.name,
          description: workflowDraft.definition.description,
          permissions: workflowDraft.definition.permissions,
          defaults: {
            llm_profile_ref: workflowDraft.definition.defaults.llmProfileRef,
            destination_ref: workflowDraft.definition.defaults.destinationRef,
          },
          schedule: workflowDraft.definition.schedule,
          steps: [],
        },
        created_at: workflowDraft.createdAt,
      };
    });
    const seenEvents: string[] = [];

    const draft = await createPersistedWorkflowDraft(
      workflowDraft.prompt,
      "codex-oauth-local",
      (event) => {
        seenEvents.push(
          `${event.phase}:${event.stepId}:${event.status}:${event.title}:${event.eventKind}:${event.delta}`,
        );
      },
    );

    expect(draft?.id).toBe(workflowDraft.id);
    expect(draft?.plannerRationale?.operations[0]).toMatchObject({
      kind: "parse.csv",
      capabilityId: "data.parse_csv",
      stepId: "parse-csv",
      evidence: "Prompt requested CSV parsing.",
    });
    expect(seenEvents).toEqual(["typing:draft:active:Builder is drafting:text_delta:hello"]);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("denormalizes planner rationale when approving workflow drafts", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await approvePersistedWorkflowDraft({
      ...workflowDraft,
      plannerRationale: {
        prompt: workflowDraft.prompt,
        operations: [
          {
            id: "op-parse-csv",
            kind: "parse.csv",
            status: "covered",
            evidence: "Prompt requested CSV parsing.",
            capabilityId: "data.parse_csv",
            stepId: "parse-csv",
            inputs: {},
          },
        ],
        warnings: [],
      },
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "approve_workflow_draft",
      expect.objectContaining({
        draft: expect.objectContaining({
          planner_rationale: {
            prompt: workflowDraft.prompt,
            operations: [
              expect.objectContaining({
                kind: "parse.csv",
                capability_id: "data.parse_csv",
                step_id: "parse-csv",
              }),
            ],
            warnings: [],
          },
        }),
      }),
    );
  });

  it("does not convert native run invoke errors into null fallback results", async () => {
    invokeMock.mockRejectedValueOnce(new Error("agent profile requires sign in"));

    await expect(runPersistedWorkflow("current-weather")).rejects.toThrow(
      "agent profile requires sign in",
    );
    expect(invokeMock).toHaveBeenCalledWith("run_workflow", { workflowId: "current-weather" });
  });

  it("returns null for browser-only run fallback when Tauri internals are unavailable", async () => {
    invokeMock.mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'invoke')"),
    );

    await expect(runPersistedWorkflow("daily-work-journal")).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("run_workflow", { workflowId: "daily-work-journal" });
  });

  it("leaves approval-interrupted streamed runs unfinished while approval is pending", async () => {
    invokeMock
      .mockImplementationOnce((_command: string, args: Record<string, unknown>) => {
        (args.onEvent as { onmessage: (message: unknown) => void }).onmessage({
          kind: "RUN_STARTED",
          run_id: "run-approved-waiting",
          workflow_name: "Current Weather",
          timestamp: "2026-06-09T12:00:00Z",
        });
        (args.onEvent as { onmessage: (message: unknown) => void }).onmessage({
          kind: "INTERRUPT",
          run_id: "run-approved-waiting",
          step_id: "fetch-weather",
          approval_id: "approval-1",
          workflow_name: "Current Weather",
          description: "Workflow approval mode requires review before runtime actions.",
          risk_level: "normal",
          timestamp: "2026-06-09T12:00:00Z",
        });
        return Promise.resolve({
          run: {
            id: "run-approved-waiting",
            workflow_id: "current-weather",
            workflow_name: "Current Weather",
            status: "blocked",
            started_at: "2026-06-09T12:00:00Z",
            completed_at: "2026-06-09T12:00:01Z",
            idempotency_key: "manual:current-weather:run-approved-waiting",
            retry_count: 0,
            blocked_reason: "Workflow approval mode requires review before runtime actions.",
            required_provider_id: "approval",
            required_profile_id: "approval-1",
          },
          artifact: null,
          duplicate: false,
        });
      });
    const events: string[] = [];

    const result = await runWorkflowStreamed("current-weather", (event) => {
      events.push(event.kind);
    });

    expect(result?.run.status).toBe("blocked");
    expect(events).toEqual(["RUN_STARTED", "INTERRUPT"]);
    expect(invokeMock).toHaveBeenCalledWith(
      "run_workflow_streamed",
      expect.objectContaining({ workflowId: "current-weather", onEvent: expect.any(MockChannel) }),
    );
  });

  it("emits HTTP backend event logs for streamed runs", async () => {
    vi.stubEnv("VITE_RAVEN_BACKEND_URL", "http://127.0.0.1:18791");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            run: {
              id: "run-streamed",
              workflow_id: "current-weather",
              workflow_name: "Current Weather",
              status: "succeeded",
              started_at: "2026-06-09T12:00:00Z",
              idempotency_key: "manual-run-streamed",
              retry_count: 0,
            },
            artifact: null,
            duplicate: false,
          },
          events: [
            {
              kind: "RUN_STARTED",
              run_id: "run-streamed",
              workflow_name: "Current Weather",
              timestamp: "2026-06-09T12:00:00Z",
            },
            {
              kind: "STEP_STARTED",
              run_id: "run-streamed",
              step_id: "fetch-weather",
              step_name: "Fetch weather",
              timestamp: "2026-06-09T12:00:00Z",
            },
            {
              kind: "RUN_FINISHED",
              run_id: "run-streamed",
              duration_ms: 0,
              token_count: 12,
              estimated_cost_usd: 0.001,
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const events: string[] = [];

    const result = await runWorkflowStreamed("current-weather", (event) => {
      events.push(`${event.kind}:${event.runId}:${event.stepId ?? ""}:${event.tokenCount ?? ""}`);
    });

    expect(result?.run.id).toBe("run-streamed");
    expect(events).toEqual([
      "RUN_STARTED:run-streamed::",
      "STEP_STARTED:run-streamed:fetch-weather:",
      "RUN_FINISHED:run-streamed::12",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18791/commands/run_workflow_streamed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workflowId: "current-weather" }),
      }),
    );
  });
});
