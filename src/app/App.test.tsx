import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { SetupWizard } from "./SetupWizard";
import { AppStateProvider, useAppState } from "./contexts/AppStateContext";
import { UIProvider, useUI } from "./contexts/UIContext";
import { RunStreamProvider, useRunStream } from "./contexts/RunStreamContext";
import { HomeView } from "./views/HomeView";
import { MessageThread } from "./components/assistant/MessageThread";
import { buildAssistantSuggestions, buildCommandCenterPriority } from "./selectors/commandCenter";

const invokeMock = vi.fn();
const listenMock = vi.fn();
const dialogOpenMock = vi.fn();
const isPermissionGrantedMock = vi.fn();
const requestPermissionMock = vi.fn();
const sendNotificationMock = vi.fn();
const createObjectURLMock = vi.fn();
const revokeObjectURLMock = vi.fn();
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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpenMock(...args),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => isPermissionGrantedMock(),
  requestPermission: () => requestPermissionMock(),
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

const backendState = {
  workflows: [
    {
      id: "daily-work-journal-v1",
      workflow_id: "daily-work-journal",
      version: 1,
      status: "enabled",
      definition: {
        schema_version: "0.1.0",
        id: "daily-work-journal",
        name: "Daily Work Journal",
        description: "Loaded from SQLite.",
        permissions: ["git:read", "artifact:write", "llm:generate"],
        defaults: { llm_profile_ref: "default-openai", destination_ref: "local-app" },
        schedule: { cadence: "weekdays", local_time: "17:00" },
        steps: [],
      },
      created_at: "2026-06-08T10:00:00Z",
    },
    {
      id: "agent-weather-v1",
      workflow_id: "agent-weather",
      version: 1,
      status: "enabled",
      definition: {
        schema_version: "0.1.0",
        id: "agent-weather",
        name: "Agent Weather",
        description: "Answers a weather question through the selected AI agent.",
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
  runs: [
    {
      id: "run-seed-1",
      workflow_id: "daily-work-journal",
      workflow_name: "Daily Work Journal",
      status: "succeeded",
      started_at: "2026-06-08T10:00:00Z",
      completed_at: "2026-06-08T10:00:05Z",
      idempotency_key: "seed:daily-work-journal",
    },
  ],
  artifacts: [],
  providers: [],
  llm_profiles: [
    {
      id: "default-openai",
      provider_id: "openai",
      model: "gpt-4.1",
      effort: "medium",
      supports_structured_outputs: true,
    },
  ],
  agent_auth_profiles: [
    {
      id: "codex-oauth-local",
      display_name: "Codex (local)",
      runner_kind: "codex_cli",
      auth_mode: "codex_oauth_local_cli",
      credential_ref: "codex:oauth:local-cli",
      model: "gpt-5.4",
      effort: "medium",
      status: "available",
      summary: "Codex OAuth local CLI.",
    },
  ],
};

const workflowDraft = {
  id: "draft-approved-weather",
  prompt: "Create an agent weather workflow",
  summary: "Asks an agent for weather and saves the result.",
  permission_changes: ["llm:generate", "network:read", "artifact:write"],
  destination_writes: ["local-app"],
  diff_json: [],
  validation_status: "valid",
  approval_status: "needs_review",
  validation_errors: [],
  definition: {
    schema_version: "0.1.0",
    id: "approved-agent-weather",
    name: "Approved Agent Weather",
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
      {
        kind: "provider_action",
        id: "write-artifact",
        name: "Save result locally",
        provider: "local_app",
        action: "write_artifact",
        depends_on: ["ask-ai"],
        permissions: ["artifact:write"],
        destination_ref: "local-app",
        inputs: { artifact: "$steps.ask-ai.artifact" },
      },
    ],
  },
  created_at: "2026-06-08T10:00:00Z",
};

const persistedApprovedWorkflow = {
  id: "approved-agent-weather-v4",
  workflow_id: "approved-agent-weather",
  version: 4,
  status: "enabled",
  approval_mode: "review_changes",
  definition: {
    ...workflowDraft.definition,
    name: "Persisted Agent Weather",
    description: "Persisted version returned by approval.",
  },
  created_at: "2026-06-08T10:05:00Z",
};

const onboardingLiveReadyPreflight = {
  id: "preflight-onboarding-live",
  workflow_id: "daily-work-journal",
  workflow_version: 1,
  registry_snapshot_hash: "snapshot-live",
  created_at: "2026-06-08T10:05:30Z",
  capabilities: [],
  credentials: [],
  network_domains: [],
  file_reads: [],
  file_writes: [],
  overwrites: [],
  deletes: [],
  external_publishes: [],
  scoped_network_domains: [],
  scoped_network_resources: [],
  scoped_file_writes: [],
  scoped_overwrites: [],
  scoped_external_publishes: [],
  policy_recommendation: "safe_auto",
  blocking_items: [],
};

const onboardingApprovalRequiredPreflight = {
  ...onboardingLiveReadyPreflight,
  id: "preflight-onboarding-approval",
  registry_snapshot_hash: "snapshot-approval",
  capabilities: [
    {
      capability_id: "local_app.write_artifact",
      step_id: "write-artifact",
      policy_decision: "needs_grant",
      reason: "Artifact writes need approval before a live sample can run.",
      signature_hash: "local_app.write_artifact:sig",
    },
  ],
  file_writes: ["artifacts/daily.md"],
  scoped_file_writes: [
    {
      capability_id: "local_app.write_artifact",
      step_id: "write-artifact",
      value: "artifacts/daily.md",
    },
  ],
};

const workflowRosterState = {
  ...backendState,
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      kind: "llm",
      status: "available",
      summary: "Ready.",
    },
    {
      id: "local_app",
      name: "Local App Store",
      kind: "artifact_destination",
      status: "available",
      summary: "Ready.",
    },
  ],
  workflows: [
    {
      id: "healthy-openai-v1",
      workflow_id: "healthy-openai",
      version: 1,
      status: "enabled",
      approval_mode: "auto_approve",
      definition: {
        schema_version: "0.1.0",
        id: "healthy-openai",
        name: "Healthy OpenAI",
        description: "Creates a journal with OpenAI.",
        permissions: ["llm:generate", "artifact:write"],
        defaults: { llm_profile_ref: "default-openai", destination_ref: "local-app" },
        schedule: { cadence: "daily", local_time: "11:00" },
        steps: [
          {
            kind: "provider_action",
            id: "compose",
            name: "Compose artifact",
            provider: "openai",
            action: "generate_artifact",
            depends_on: [],
            permissions: ["llm:generate"],
            llm_profile_ref: "default-openai",
            inputs: { template: "daily_work_journal" },
          },
          {
            kind: "provider_action",
            id: "write",
            name: "Write artifact",
            provider: "local_app",
            action: "write_artifact",
            depends_on: ["compose"],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "$steps.compose.artifact" },
          },
        ],
      },
      created_at: "2026-06-08T10:00:00Z",
    },
    {
      id: "agent-weather-v1",
      workflow_id: "agent-weather",
      version: 1,
      status: "enabled",
      approval_mode: "review_changes",
      definition: backendState.workflows[1].definition,
      created_at: "2026-06-08T10:10:00Z",
    },
    {
      id: "retry-sync-v1",
      workflow_id: "retry-sync",
      version: 1,
      status: "enabled",
      approval_mode: "always_review",
      definition: {
        ...backendState.workflows[1].definition,
        id: "retry-sync",
        name: "Retry Sync",
        description: "Needs attention after a retryable provider failure.",
      },
      created_at: "2026-06-08T10:20:00Z",
    },
    {
      id: "draft-brief-v1",
      workflow_id: "draft-brief",
      version: 1,
      status: "draft",
      approval_mode: "review_changes",
      definition: {
        ...backendState.workflows[1].definition,
        id: "draft-brief",
        name: "Draft Brief",
        description: "Draft workflow for planning briefs.",
        schedule: { cadence: "manual" },
      },
      created_at: "2026-06-08T10:30:00Z",
    },
    {
      id: "paused-export-v1",
      workflow_id: "paused-export",
      version: 1,
      status: "disabled",
      approval_mode: "always_review",
      definition: {
        ...backendState.workflows[1].definition,
        id: "paused-export",
        name: "Paused Export",
        description: "Paused markdown export workflow.",
        defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "markdown_folder" },
      },
      created_at: "2026-06-08T10:40:00Z",
    },
    {
      id: "markdown-export-v1",
      workflow_id: "markdown-export",
      version: 1,
      status: "enabled",
      approval_mode: "review_changes",
      definition: {
        ...backendState.workflows[1].definition,
        id: "markdown-export",
        name: "Markdown Export",
        description: "Requires markdown destination setup before it can run.",
        defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "markdown_folder" },
      },
      created_at: "2026-06-08T10:50:00Z",
    },
  ],
  runs: [
    {
      id: "healthy-run-1",
      workflow_id: "healthy-openai",
      workflow_name: "Healthy OpenAI",
      status: "succeeded",
      started_at: "2026-06-08T10:00:00Z",
      completed_at: "2026-06-08T10:00:05Z",
      idempotency_key: "seed:healthy-openai",
      provider_profile_id: "default-openai",
      total_cost_usd: 1.42,
      total_tokens: 1200,
    },
    {
      id: "retry-run-1",
      workflow_id: "retry-sync",
      workflow_name: "Retry Sync",
      status: "retryable",
      started_at: "2026-06-08T10:02:00Z",
      completed_at: "2026-06-08T10:02:05Z",
      idempotency_key: "seed:retry-sync",
      provider_profile_id: "codex-oauth-local",
      total_cost_usd: 0.08,
      total_tokens: 400,
    },
    {
      id: "approval-run-1",
      workflow_id: "agent-weather",
      workflow_name: "Agent Weather",
      status: "blocked",
      started_at: "2026-06-08T10:03:00Z",
      completed_at: "2026-06-08T10:03:05Z",
      idempotency_key: "seed:agent-weather:approval",
      required_provider_id: "approval",
      blocked_reason: "Approval required before continuing.",
    },
  ],
  artifacts: [
    {
      id: "healthy-artifact-1",
      title: "Healthy OpenAI Artifact",
      artifact_type: "daily_work_journal",
      workflow_run_id: "healthy-run-1",
      content_markdown: "# Healthy",
      metadata: { schema_version: "0.1.0", workflow_id: "healthy-openai" },
      source_refs: ["local git"],
      created_at: "2026-06-08T10:00:05Z",
    },
  ],
};

function mockPersistedState(state: unknown = workflowRosterState, diagnostics?: unknown) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_app_state") return state;
    if (command === "scheduler_status") {
      return { running: false, pollIntervalSeconds: 60 };
    }
    if (command === "system_health_diagnostics" && diagnostics) return diagnostics;
    throw new Error(`Unexpected command ${command}`);
  });
}

async function renderWorkflows(state = workflowRosterState, installMock = true, expectedText = "Healthy OpenAI") {
  if (installMock) mockPersistedState(state);
  const view = render(<App />);
  const mainNavigation = await screen.findByRole("navigation", { name: "Main navigation" });
  await userEvent.click(within(mainNavigation).getByRole("button", { name: "Workflows" }));
  await screen.findByRole("heading", { name: "Workflows" });
  await screen.findAllByText(expectedText);
  await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  return view;
}

function RunStreamProbe() {
  const { runStream, startStreamedRun } = useRunStream();
  return (
    <div>
      <button type="button" onClick={() => void startStreamedRun("daily-work-journal")}>
        Start stream
      </button>
      <span>active:{runStream.activeRunId ?? "none"}</span>
      <span>tokens:{runStream.totalTokens}</span>
      <span>cost:{runStream.totalCostUsd.toFixed(3)}</span>
    </div>
  );
}

function CommandCenterTargetProbe() {
  const { view, commandCenterTarget, setView, openCommandCenterTarget } = useUI();
  return (
    <div>
      <span>view:{view}</span>
      <span>target:{commandCenterTarget}</span>
      <button type="button" onClick={() => setView("settings")}>
        Open settings
      </button>
      <button type="button" onClick={() => openCommandCenterTarget("schedule")}>
        Open schedule target
      </button>
    </div>
  );
}

function CommandCenterTargetHomeProbe() {
  const { openCommandCenterTarget } = useUI();
  return (
    <>
      <button type="button" onClick={() => openCommandCenterTarget("usage")}>
        Focus usage
      </button>
      <button type="button" onClick={() => openCommandCenterTarget("schedule")}>
        Focus schedule
      </button>
      <HomeView />
    </>
  );
}

function RunDueSchedulesProbe() {
  const { actions } = useAppState();
  return (
    <button type="button" onClick={() => void actions.runDueSchedules()}>
      Run due schedules probe
    </button>
  );
}

function SetupWizardStateProbe() {
  const { state, runNotice } = useAppState();
  return (
    <div>
      <pre data-testid="setup-wizard-latest-artifact">{JSON.stringify(state.artifacts[0] ?? null)}</pre>
      <pre data-testid="setup-wizard-latest-run">{JSON.stringify(state.runs[0] ?? null)}</pre>
      <span data-testid="setup-wizard-run-notice">{runNotice}</span>
    </div>
  );
}

function PostOnboardingLandingProbe() {
  const { state, hasSkippedSetup, postOnboardingLandingPending, actions } = useAppState();
  const [showHome, setShowHome] = useState(false);
  const priority = buildCommandCenterPriority(state, new Date("2026-06-23T18:00:00.000Z"), [], {
    hasSkippedSetup,
    postOnboardingLandingPending,
  });

  return (
    <>
      <button
        type="button"
        onClick={() => void actions.completeSetup({ postOnboardingLandingPending: true })}
      >
        Complete setup probe
      </button>
      <button type="button" onClick={() => setShowHome(true)}>
        Show home probe
      </button>
      <button type="button" onClick={() => setShowHome(false)}>
        Hide home probe
      </button>
      <span data-testid="post-onboarding-landing-pending">{String(postOnboardingLandingPending)}</span>
      <span data-testid="post-onboarding-priority">{priority.title}</span>
      {showHome ? <HomeView /> : null}
    </>
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockResolvedValue(vi.fn());
  dialogOpenMock.mockReset();
  isPermissionGrantedMock.mockReset();
  requestPermissionMock.mockReset();
  sendNotificationMock.mockReset();
  invokeMock.mockRejectedValue(new Error("Tauri unavailable"));
  dialogOpenMock.mockResolvedValue(null);
  isPermissionGrantedMock.mockResolvedValue(true);
  requestPermissionMock.mockResolvedValue("granted");
  window.history.replaceState(null, "", "/");
  localStorage.removeItem("raven:workflow-roster");
  localStorage.removeItem("raven:workflow-roster-saved-views");
  localStorage.removeItem("raven:create-hub-recent-drafts");
  localStorage.removeItem("raven:marketplace-template-installs");
  localStorage.removeItem("raven:marketplace-trust-reviews");
  localStorage.removeItem("raven:top-status-visibility");
  localStorage.removeItem("raven:hidden-assistant-chip-categories");
  localStorage.removeItem("raven:settings-change-history");
  localStorage.removeItem("raven:onboarding-finish-progress");
  localStorage.removeItem("raven:theme-preferences");
  localStorage.removeItem("raven:setup-skipped");
  localStorage.removeItem("raven:setup-migrated");
  localStorage.removeItem("raven:setup-complete");
  localStorage.removeItem("hugin:setup-complete");
  [
    "--action-primary",
    "--accent",
    "--action-primary-hover",
    "--accent-strong",
    "--action-primary-pressed",
    "--accent-depth",
    "--focus-ring",
    "--assistant-presence",
    "--primary-gradient",
  ].forEach((property) => document.documentElement.style.removeProperty(property));
  localStorage.setItem("raven:setup-complete", "true");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
  createObjectURLMock.mockReset();
  createObjectURLMock.mockReturnValue("blob:raven-workflows-export");
  revokeObjectURLMock.mockReset();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURLMock,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURLMock,
  });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

describe("Raven app shell", () => {
  it("openCommandCenterTarget returns to home and records the target", async () => {
    render(
      <UIProvider>
        <CommandCenterTargetProbe />
      </UIProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByText("view:settings")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open schedule target" }));

    expect(screen.getByText("view:home")).toBeInTheDocument();
    expect(screen.getByText("target:schedule")).toBeInTheDocument();
  });

  it("command center usage and schedule targets visibly land on their panels", async () => {
    render(
      <UIProvider>
        <AppStateProvider>
          <RunStreamProvider>
            <CommandCenterTargetHomeProbe />
          </RunStreamProvider>
        </AppStateProvider>
      </UIProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Focus usage" }));
    const usagePanel = await screen.findByRole("region", { name: "Usage and cost command panel" });
    expect(usagePanel).toHaveClass("command-panel-targeted");
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Focus schedule" }));
    const schedulePanel = await screen.findByRole("region", { name: "Schedule command panel" });
    expect(schedulePanel).toHaveClass("command-panel-targeted");
  });

  it("opens provider status details before navigating to provider settings", async () => {
    mockPersistedState({
      ...workflowRosterState,
      agent_auth_profiles: [
        ...workflowRosterState.agent_auth_profiles,
        {
          id: "claude-needs-key",
          display_name: "Claude API",
          runner_kind: "anthropic_api",
          auth_mode: "api_key_env",
          credential_ref: "env:ANTHROPIC_API_KEY",
          model: "claude-sonnet-4",
          effort: "medium",
          status: "needs_config",
          summary: "Missing ANTHROPIC_API_KEY.",
        },
      ],
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /provider status/i }));
    const popover = await screen.findByRole("dialog", { name: "Provider status details" });
    expect(popover).toHaveTextContent("needs attention");

    await userEvent.click(within(popover).getByRole("button", { name: "Open provider settings" }));

    expect(await screen.findByRole("navigation", { name: "Settings breadcrumbs" })).toHaveTextContent(
      "General",
    );
    expect(screen.getByRole("button", { name: /General/i, current: "page" })).toBeInTheDocument();
  });

  it("keeps urgent status visible and groups low-priority statuses", async () => {
    mockPersistedState({
      ...workflowRosterState,
      agent_auth_profiles: [
        ...workflowRosterState.agent_auth_profiles,
        {
          id: "claude-needs-key",
          display_name: "Claude API",
          runner_kind: "anthropic_api",
          auth_mode: "api_key_env",
          credential_ref: "env:ANTHROPIC_API_KEY",
          model: "claude-sonnet-4",
          effort: "medium",
          status: "needs_config",
          summary: "Missing ANTHROPIC_API_KEY.",
        },
      ],
      runs: workflowRosterState.runs
        .filter((run) => run.status !== "blocked")
        .map(({ total_cost_usd: _totalCostUsd, total_tokens: _totalTokens, ...run }) => run),
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Command Center" });

    expect(screen.getByRole("button", { name: /Provider status/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Scheduler status/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /More system statuses/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Active run status/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approval status/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Usage status/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /More system statuses/i }));
    const groupedStatuses = await screen.findByRole("dialog", { name: "More system statuses details" });
    expect(groupedStatuses).toHaveTextContent("No active run");
    expect(groupedStatuses).toHaveTextContent("No approvals");
    expect(groupedStatuses).toHaveTextContent("Usage unavailable");
    expect(groupedStatuses).toHaveTextContent("System health");
    expect(groupedStatuses).toHaveTextContent("Command log");
    expect(groupedStatuses).toHaveTextContent("Status visibility");
  });

  it("top status popovers close with keyboard, outside interaction, and restore trigger focus", async () => {
    mockPersistedState();

    render(<App />);

    const providerTrigger = await screen.findByRole("button", { name: /provider status/i });
    providerTrigger.focus();
    await userEvent.keyboard("{Enter}");
    const providerPopover = await screen.findByRole("dialog", { name: "Provider status details" });
    expect(within(providerPopover).getByRole("button", { name: "Close provider status" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Provider status details" })).not.toBeInTheDocument();
    expect(providerTrigger).toHaveFocus();

    await userEvent.click(providerTrigger);
    expect(await screen.findByRole("dialog", { name: "Provider status details" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("heading", { name: "Command Center" }));
    expect(screen.queryByRole("dialog", { name: "Provider status details" })).not.toBeInTheDocument();
    expect(providerTrigger).toHaveFocus();
  });

  it("hands focus from one top status popover to another without restoring the old trigger", async () => {
    mockPersistedState();

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /provider status/i }));
    expect(await screen.findByRole("dialog", { name: "Provider status details" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /scheduler status/i }));

    expect(screen.queryByRole("dialog", { name: "Provider status details" })).not.toBeInTheDocument();
    const schedulerPopover = await screen.findByRole("dialog", { name: "Scheduler status details" });
    expect(schedulerPopover).toBeInTheDocument();
    expect(within(schedulerPopover).getByRole("button", { name: "Close scheduler status" })).toHaveFocus();
  });

  it("does not restore top status focus over a focused search control", async () => {
    mockPersistedState();

    render(<App />);

    const providerTrigger = await screen.findByRole("button", { name: /provider status/i });
    await userEvent.click(providerTrigger);
    expect(await screen.findByRole("dialog", { name: "Provider status details" })).toBeInTheDocument();

    const searchButton = screen.getByRole("button", { name: "Search (Cmd+K)" });
    await userEvent.click(searchButton);

    expect(screen.queryByRole("dialog", { name: "Provider status details" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(providerTrigger).not.toHaveFocus();
  });

  it("shows persisted approval-blocked runs in the top approval status", async () => {
    mockPersistedState();

    render(<App />);

    const approvalTrigger = await screen.findByRole("button", { name: /approval status: 1 pending/i });
    await userEvent.click(approvalTrigger);

    const popover = await screen.findByRole("dialog", { name: "Approvals details" });
    expect(popover).toHaveTextContent("Agent Weather");
    expect(popover).toHaveTextContent("Approval required before continuing.");
    expect(within(popover).getByRole("button", { name: "Open Agent Weather approval run" })).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Approve Agent Weather unavailable" })).toBeDisabled();
    expect(within(popover).getByRole("button", { name: "Reject Agent Weather unavailable" })).toBeDisabled();
  });

  it("resolves live approval controls from the top approval status", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return workflowRosterState;
      if (command === "scheduler_status") return { running: true, pollIntervalSeconds: 60 };
      if (command === "list_pending_approvals") {
        return [
          {
            id: "approval-live-1",
            run_id: "approval-run-1",
            step_id: "ask-ai",
            workflow_name: "Agent Weather",
            description: "Review live tool access before continuing.",
            risk_level: "elevated",
            status: "pending",
            created_at: "2026-06-08T10:03:00Z",
          },
        ];
      }
      if (command === "resolve_approval") {
        expect(args).toMatchObject({ id: "approval-live-1", decision: "approved" });
        return {
          id: "approval-live-1",
          run_id: "approval-run-1",
          step_id: "ask-ai",
          workflow_name: "Agent Weather",
          description: "Review live tool access before continuing.",
          risk_level: "elevated",
          status: "approved",
          created_at: "2026-06-08T10:03:00Z",
          resolved_at: "2026-06-08T10:04:00Z",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /approval status: 1 pending/i }));
    const popover = await screen.findByRole("dialog", { name: "Approvals details" });
    expect(within(popover).getByRole("button", { name: "Open Agent Weather approval run" })).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Reject Agent Weather" })).toBeEnabled();

    await userEvent.click(within(popover).getByRole("button", { name: "Approve Agent Weather" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "resolve_approval",
        expect.objectContaining({ id: "approval-live-1", decision: "approved" }),
      );
    });
  });

  it("splits due now, overdue, and retryable scheduler attention in top status", async () => {
    const now = new Date();
    const pad = (value: number) => value.toString().padStart(2, "0");
    const dueNow = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const overdueDate = new Date(now.getTime() - 60 * 60 * 1000);
    const overdue = `${pad(overdueDate.getHours())}:${pad(overdueDate.getMinutes())}`;
    const scheduledState = {
      ...workflowRosterState,
      workflows: [
        {
          ...workflowRosterState.workflows[0],
          id: "due-now-v1",
          workflow_id: "due-now",
          definition: {
            ...workflowRosterState.workflows[0].definition,
            id: "due-now",
            name: "Due Now",
            schedule: { cadence: "daily", local_time: dueNow },
          },
        },
        {
          ...workflowRosterState.workflows[0],
          id: "overdue-v1",
          workflow_id: "overdue",
          definition: {
            ...workflowRosterState.workflows[0].definition,
            id: "overdue",
            name: "Overdue Work",
            schedule: { cadence: "daily", local_time: overdue },
          },
        },
        {
          ...workflowRosterState.workflows[2],
          definition: {
            ...workflowRosterState.workflows[2].definition,
            schedule: { cadence: "daily", local_time: dueNow },
          },
        },
      ],
      runs: [
        {
          id: "retry-run-1",
          workflow_id: "retry-sync",
          workflow_name: "Retry Sync",
          status: "retryable",
          started_at: now.toISOString(),
          completed_at: now.toISOString(),
          idempotency_key: "seed:retry-sync",
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return scheduledState;
      if (command === "scheduler_status") return { running: false, pollIntervalSeconds: 60 };
      if (command === "run_scheduled_due_workflows") {
        expect(args).toMatchObject({ workflowIds: ["due-now"] });
        return [
          {
            duplicate: false,
            run: {
              id: "due-now-run",
              workflow_id: "due-now",
              workflow_name: "Due Now",
              status: "succeeded",
              started_at: now.toISOString(),
              completed_at: now.toISOString(),
              idempotency_key: "scheduled:due-now",
            },
            artifact: null,
          },
        ];
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /scheduler status/i }));
    const popover = await screen.findByRole("dialog", { name: "Scheduler status details" });

    expect(within(popover).getByText("Due now")).toBeInTheDocument();
    expect(within(popover).getByText("Overdue/Missed")).toBeInTheDocument();
    expect(within(popover).getByText("Failed/Retryable")).toBeInTheDocument();
    expect(popover).toHaveTextContent("Due Now");
    expect(popover).toHaveTextContent("Overdue Work");
    expect(popover).toHaveTextContent("Retry Sync");

    await userEvent.click(within(popover).getByRole("button", { name: "Run due now" }));

    expect(await within(popover).findByText("Run due now result: Scheduled runs: 1 started, 0 skipped/unavailable, 0 errors")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith(
      "run_scheduled_due_workflows",
      expect.objectContaining({
        workflowIds: ["due-now"],
      }),
    );
  });

  it("deep links top scheduler and usage status actions to command center targets", async () => {
    mockPersistedState({
      ...workflowRosterState,
      runs: [
        ...workflowRosterState.runs,
        {
          id: "usage-run-today",
          workflow_id: "healthy-openai",
          workflow_name: "Healthy OpenAI",
          status: "succeeded",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          idempotency_key: "seed:usage-run-today",
          provider_profile_id: "default-openai",
          total_cost_usd: 1.25,
          total_tokens: 2400,
        },
      ],
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /scheduler status/i }));
    let popover = await screen.findByRole("dialog", { name: "Scheduler status details" });
    await userEvent.click(within(popover).getByRole("button", { name: "Open schedule" }));
    expect(await screen.findByRole("region", { name: "Schedule command panel" })).toHaveClass(
      "command-panel-targeted",
    );

    await userEvent.click(screen.getByRole("button", { name: /usage status/i }));
    popover = await screen.findByRole("dialog", { name: "Usage status details" });
    await userEvent.click(within(popover).getByRole("button", { name: "Review usage" }));
    expect(await screen.findByRole("region", { name: "Usage and cost command panel" })).toHaveClass(
      "command-panel-targeted",
    );
  });

  it("shows top status issue badges, refresh timestamp, visibility controls, and system diagnostics", async () => {
    mockPersistedState({
      ...workflowRosterState,
      agent_auth_profiles: [
        ...workflowRosterState.agent_auth_profiles.map((p) => ({ ...p, status: "needs_config" })),
        {
          id: "anthropic-needs-key",
          display_name: "Anthropic",
          runner_kind: "anthropic_api",
          auth_mode: "api_key_env",
          credential_ref: "env:ANTHROPIC_API_KEY",
          model: "claude-sonnet-4",
          effort: "medium",
          status: "needs_config",
          summary: "Missing ANTHROPIC_API_KEY.",
        },
      ],
    }, {
      generated_at: "2026-06-08T10:15:00Z",
      status: "warning",
      issue_count: 4,
      scheduler: { running: false, poll_interval_seconds: 60 },
      providers: { total: 5, available: 3, degraded: 0, needs_config: 2, unavailable: 0 },
      destinations: { total: 3, ready: 1, needs_config: 2, unavailable: 0 },
      workflows: { total: 3, enabled: 2, draft: 1, disabled: 0, invalid: 1, blocking_issues: 2 },
      runs: { total: 4, failed: 1, retryable: 1, blocked: 1, running: 0 },
      plugins: { installed: 2, available_steps: 3 },
    });

    render(<App />);

    const providerTrigger = await screen.findByRole("button", { name: /provider status/i });
    expect(within(providerTrigger).getByLabelText("Provider needed")).toBeInTheDocument();
    expect(screen.getByText(/Last refresh:/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "More system statuses" }));
    const visibilityPanel = await screen.findByRole("dialog", { name: "More system statuses details" });
    await userEvent.click(within(visibilityPanel).getByLabelText("Show usage status"));
    expect(screen.queryByRole("button", { name: /usage status/i })).not.toBeInTheDocument();

    const healthPanel = visibilityPanel;
    expect(healthPanel).toHaveTextContent("System warning");
    expect(healthPanel).toHaveTextContent("Generated 6/8/2026, 10:15:00 AM");
    expect(healthPanel).toHaveTextContent("Scheduler stopped");
    expect(healthPanel).toHaveTextContent("3/5 ready");
    expect(healthPanel).toHaveTextContent("1/3 destinations ready");
    expect(healthPanel).toHaveTextContent("1 invalid workflow");
    expect(healthPanel).toHaveTextContent("1 failed");
    expect(healthPanel).toHaveTextContent("2 plugins");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "More system statuses details" })).not.toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: "More system statuses" }));
    expect(await screen.findByRole("dialog", { name: "More system statuses details" })).toHaveTextContent(
      "Global command log unavailable",
    );
  });

  it("settings breadcrumbs navigate between settings tabs", async () => {
    mockPersistedState();

    render(<App />);

    const mainNavigation = await screen.findByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Advanced/i }));

    const breadcrumbs = await screen.findByRole("navigation", { name: "Settings breadcrumbs" });
    expect(breadcrumbs).toHaveTextContent("Settings");
    expect(breadcrumbs).toHaveTextContent("Scheduler");

    await userEvent.click(within(breadcrumbs).getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("button", { name: /General/i, current: "page" })).toBeInTheDocument();
    expect(breadcrumbs).toHaveTextContent("General");
  });

  it("failed artifact destination save does not replace the visible configured path", async () => {
    const oldPath = "/Users/example/Raven";
    const rejectedPath = "/private/invalid-destination";
    const state = {
      ...workflowRosterState,
      providers: [
        ...workflowRosterState.providers.filter((provider) => provider.id !== "markdown_folder"),
        {
          id: "markdown_folder",
          name: "Markdown Folder",
          kind: "artifact_destination",
          status: "available",
          summary: `Markdown Folder writes to ${oldPath}.`,
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return state;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_saved_settings") {
        return {
          artifact_destination_markdown_folder: { folder_path: oldPath },
        };
      }
      if (command === "configure_artifact_destination") {
        throw new Error("invalid destination path");
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    const mainNavigation = await screen.findByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "General" }));
    expect(await screen.findByDisplayValue(oldPath)).toBeInTheDocument();

    const markdownCard = screen.getAllByText("Markdown Folder")
      .map((node) => node.closest("article"))
      .find((article): article is HTMLElement => article !== null);
    expect(markdownCard).not.toBeNull();
    expect(within(markdownCard as HTMLElement).getByText(oldPath)).toBeInTheDocument();

    const destinationInput = screen.getByDisplayValue(oldPath);
    await userEvent.clear(destinationInput);
    await userEvent.type(destinationInput, rejectedPath);
    await userEvent.click(screen.getByRole("button", { name: "Save artifact destination" }));

    expect(await screen.findByText("Artifact destination unavailable")).toBeInTheDocument();
    expect(within(markdownCard as HTMLElement).getByText(oldPath)).toBeInTheDocument();
    expect(within(markdownCard as HTMLElement).queryByText(rejectedPath)).not.toBeInTheDocument();
  });

  it("deep links settings to concrete provider, context, and scheduler targets", async () => {
    mockPersistedState({
      ...workflowRosterState,
      agent_auth_profiles: [
        ...workflowRosterState.agent_auth_profiles,
        {
          id: "anthropic-api-key",
          display_name: "Anthropic",
          runner_kind: "anthropic_api",
          auth_mode: "api_key_env",
          credential_ref: "env:ANTHROPIC_API_KEY",
          model: "claude-sonnet-4",
          effort: "medium",
          status: "needs_config",
          summary: "Missing ANTHROPIC_API_KEY.",
        },
      ],
      providers: [
        ...workflowRosterState.providers,
        {
          id: "github",
          name: "GitHub",
          kind: "context",
          status: "needs_config",
          summary: "GitHub token not configured.",
        },
      ],
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /provider status/i }));
    await userEvent.click(screen.getByRole("button", { name: "Open Anthropic settings" }));
    let breadcrumbs = await screen.findByRole("navigation", { name: "Settings breadcrumbs" });
    expect(breadcrumbs).toHaveTextContent("SettingsGeneralAnthropic");
    expect(await screen.findByRole("region", { name: "Anthropic provider settings" })).toHaveClass("settings-targeted");

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Open GitHub context settings" }));
    breadcrumbs = await screen.findByRole("navigation", { name: "Settings breadcrumbs" });
    expect(breadcrumbs).toHaveTextContent("SettingsContext SourcesGitHub");
    expect(await screen.findByRole("region", { name: "GitHub context settings" })).toHaveClass("settings-targeted");

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Open scheduler settings" }));
    breadcrumbs = await screen.findByRole("navigation", { name: "Settings breadcrumbs" });
    expect(breadcrumbs).toHaveTextContent("SettingsAdvancedScheduler");
    expect(await screen.findByRole("region", { name: "Scheduler settings" })).toHaveClass("settings-targeted");

    await userEvent.click(within(breadcrumbs).getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("button", { name: /Advanced/i, current: "page" })).toBeInTheDocument();
  });

  it("opens settings subsections from Cmd+K search commands and hash anchors", async () => {
    mockPersistedState();
    window.location.hash = "#settings/context/github";

    render(<App />);

    let breadcrumbs = await screen.findByRole("navigation", { name: "Settings breadcrumbs" });
    expect(breadcrumbs).toHaveTextContent("SettingsContext SourcesGitHub");
    expect(await screen.findByRole("region", { name: "GitHub context settings" })).toHaveClass("settings-targeted");

    await userEvent.keyboard("{Meta>}k{/Meta}");
    await userEvent.type(screen.getByRole("combobox", { name: "Search workflows, artifacts, and actions" }), "settings advanced");
    await userEvent.keyboard("{Enter}");

    breadcrumbs = await screen.findByRole("navigation", { name: "Settings breadcrumbs" });
    expect(breadcrumbs).toHaveTextContent("SettingsAdvancedScheduler");
    expect(window.location.hash).toBe("#settings/advanced/scheduler");
  });

  it("records recently changed settings history and shows restore defaults unavailable", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return workflowRosterState;
      if (command === "scheduler_status") return { running: false, pollIntervalSeconds: 60 };
      if (command === "get_saved_settings") return {};
      if (command === "configure_github_context") return null;
      if (command === "check_provider_readiness") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    const mainNavigation = await screen.findByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Settings" }));
    await userEvent.click(
      within(await screen.findByRole("navigation", { name: "Settings sections" }))
        .getByRole("button", { name: /Context/i }),
    );
    const githubSettings = await screen.findByRole("region", { name: "GitHub context settings" });
    await userEvent.click(within(githubSettings).getByRole("button", { name: /GitHub/i }));
    await userEvent.type(within(githubSettings).getByLabelText("GitHub repository"), "owner/repo");
    await userEvent.click(screen.getByRole("button", { name: "Save GitHub context" }));

    expect(githubSettings).toHaveTextContent("Recently changed");
    expect(screen.getByRole("button", { name: "Restore Context defaults unavailable" })).toBeDisabled();
    expect(localStorage.getItem("raven:settings-change-history")).toContain("GitHub context saved");

    await userEvent.click(
      within(await screen.findByRole("navigation", { name: "Settings sections" }))
        .getByRole("button", { name: /Advanced/i }),
    );
    expect(screen.getByRole("region", { name: "Settings change history" })).toHaveTextContent(
      "GitHub context saved",
    );
  });

  it("opens workflow detail in usage focus from a workflow cost bar", async () => {
    const usageRunAt = new Date().toISOString();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") {
        return {
          ...backendState,
          providers: [
            {
              id: "openai",
              name: "OpenAI",
              kind: "llm",
              status: "available",
              summary: "Ready",
            },
          ],
          runs: [
            {
              id: "usage-run",
              workflow_id: "daily-work-journal",
              workflow_name: "Daily Work Journal",
              status: "succeeded",
              started_at: usageRunAt,
              completed_at: usageRunAt,
              idempotency_key: "usage-run",
              total_tokens: 200,
              total_cost_usd: 3,
            },
          ],
        };
      }
      if (command === "scheduler_status") return { running: true, pollIntervalSeconds: 60 };
      if (command === "list_workflow_step_runs") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_app_state"));
    await userEvent.click(await screen.findByRole("button", { name: /usage status/i }));
    const usagePopover = await screen.findByRole("dialog", { name: "Usage status details" });
    await userEvent.click(within(usagePopover).getByRole("button", { name: "Review usage" }));
    const topWorkflows = await screen.findByRole("list", { name: "Top workflows by cost" });
    await within(topWorkflows).findByText("$3.00");
    await userEvent.click(within(topWorkflows).getByRole("button", { name: "Open Daily Work Journal usage detail" }));

    expect(await screen.findByRole("heading", { name: "Daily Work Journal" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Workflow usage and run history focus" })).toHaveTextContent(
      "Usage and run history",
    );
  });

  it("updates top usage status when a budget threshold is saved", async () => {
    const usageRunAt = new Date().toISOString();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") {
        return {
          ...backendState,
          providers: [
            {
              id: "openai",
              name: "OpenAI",
              kind: "llm",
              status: "available",
              summary: "Ready",
            },
          ],
          runs: [
            {
              id: "usage-budget-run",
              workflow_id: "daily-work-journal",
              workflow_name: "Daily Work Journal",
              status: "succeeded",
              started_at: usageRunAt,
              completed_at: usageRunAt,
              idempotency_key: "usage-budget-run",
              total_tokens: 200,
              total_cost_usd: 5,
            },
          ],
        };
      }
      if (command === "scheduler_status") return { running: true, pollIntervalSeconds: 60 };
      if (command === "list_workflow_step_runs") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Usage status: 1 runs reported usage" }));
    const usagePopover = await screen.findByRole("dialog", { name: "Usage status details" });
    expect(screen.queryByLabelText("Usage issues: 1")).not.toBeInTheDocument();
    await userEvent.click(within(usagePopover).getByRole("button", { name: "Review usage" }));

    const budgetInput = screen.getByLabelText("Usage budget threshold");
    await userEvent.clear(budgetInput);
    await userEvent.type(budgetInput, "4");
    await userEvent.click(screen.getByRole("button", { name: "Save budget" }));

    expect(await screen.findByLabelText("Usage issues: 1")).toBeInTheDocument();
  });

  it("renders unavailable workflow usage when runs omit usage totals", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") {
        return {
          ...backendState,
          runs: [
            {
              id: "usage-missing-run",
              workflow_id: "daily-work-journal",
              workflow_name: "Daily Work Journal",
              status: "succeeded",
              started_at: "2026-06-19T10:00:00Z",
              completed_at: "2026-06-19T10:00:05Z",
              idempotency_key: "usage-missing-run",
            },
          ],
        };
      }
      if (command === "scheduler_status") return { running: true, pollIntervalSeconds: 60 };
      if (command === "list_workflow_step_runs") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(screen.getByRole("button", { name: "Open Daily Work Journal details" }));

    const usage = screen.getByRole("region", { name: "Workflow usage and run history focus" });
    expect(usage).toHaveTextContent("Tokens unavailable");
    expect(usage).toHaveTextContent("Cost unavailable");
    expect(usage).not.toHaveTextContent("$0.00");
  });

  it("renders the Raven mark and home view by default", () => {
    render(<App />);

    expect(screen.getByRole("img", { name: "Raven" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("shows seed workflows on the home view", () => {
    render(<App />);

    expect(screen.getAllByText("Daily Work Journal").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Current Weather").length).toBeGreaterThan(0);
  });

  it("toggles theme between dark and light", async () => {
    render(<App />);

    const themeToggle = screen.getByRole("button", { name: "Switch to Light mode" });
    expect(themeToggle).toBeInTheDocument();

    await userEvent.click(themeToggle);
    expect(screen.getByRole("button", { name: "Switch to Dark mode" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("aurora-light");
  });

  it("imports, exports, and applies custom appearance settings locally", async () => {
    render(<App />);

    await userEvent.click(screen.getAllByText("Settings")[0]);
    await userEvent.click(screen.getByRole("button", { name: "General" }));

    await userEvent.selectOptions(screen.getByLabelText("Appearance theme"), "aurora-light");
    expect(document.documentElement.dataset.theme).toBe("aurora-light");

    const accentHex = screen.getByLabelText("Custom accent hex");
    await userEvent.clear(accentHex);
    await userEvent.type(accentHex, "#2f6fed");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#2f6fed");
    expect(localStorage.getItem("raven:theme-preferences")).toContain("#2f6fed");

    await userEvent.click(screen.getByRole("button", { name: "Export theme" }));
    expect(createObjectURLMock).toHaveBeenCalled();
    expect((screen.getByLabelText("Last exported theme JSON") as HTMLTextAreaElement).value).toContain("#2f6fed");

    fireEvent.change(
      screen.getByLabelText("Theme import JSON"),
      { target: { value: JSON.stringify({
        schemaVersion: "raven.theme.v1",
        theme: "aurora-dark",
        accent: "#118855",
        exportedAt: "2026-06-19T12:00:00.000Z",
      }) } },
    );
    await userEvent.click(screen.getByRole("button", { name: "Import theme" }));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("aurora-dark"));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#118855");
    expect(localStorage.getItem("raven:theme-preferences")).toContain("#118855");
  });

  it("navigates to workflows view via sidebar", async () => {
    render(<App />);

    const navButtons = screen.getAllByText("Workflows");
    await userEvent.click(navButtons[0]);

    expect(screen.getByRole("heading", { name: "Workflows" })).toBeInTheDocument();
  });

  it("navigates to settings view via sidebar", async () => {
    render(<App />);

    const navButtons = screen.getAllByText("Settings");
    await userEvent.click(navButtons[0]);

    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
  });

  it("loads persisted backend state and displays workflow names", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    expect((await screen.findAllByText("Daily Work Journal")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Agent Weather").length).toBeGreaterThan(0);
  });

  it("shows artifact lineage, filters, and source workflow actions", async () => {
    const stateWithArtifact = {
      ...backendState,
      artifacts: [
        {
          id: "artifact-seed-1",
          title: "Daily Work Journal Artifact",
          artifact_type: "daily_work_journal",
          workflow_run_id: "run-seed-1",
          content_markdown: "# Daily Work Journal Artifact\n\nBackend artifact.",
          metadata: { schema_version: "0.1.0", destination_ref: "local-app" },
          source_refs: ["local git status", "notes/daily.md"],
          created_at: "2026-06-08T10:01:05Z",
        },
      ],
      runs: [
        {
          id: "run-seed-1",
          workflow_id: "daily-work-journal",
          workflow_name: "Daily Work Journal",
          status: "succeeded",
          started_at: "2026-06-08T10:00:00Z",
          completed_at: "2026-06-08T10:00:05Z",
          idempotency_key: "seed:daily-work-journal",
          provider_profile_id: "default-openai",
          total_tokens: 1280,
          total_cost_usd: 0.125,
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return stateWithArtifact;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findByText("Daily Work Journal Artifact");
    const mainNavigation = screen.getByRole("navigation", { name: "Main navigation" });
    await userEvent.click(
      within(mainNavigation).getByRole("button", {
        name: "Artifacts",
      }),
    );

    const lineage = screen.getByRole("region", { name: "Artifact lineage" });
    expect(within(lineage).getByText("Workflow")).toBeInTheDocument();
    expect(within(lineage).getByText("Daily Work Journal")).toBeInTheDocument();
    expect(within(lineage).getByText("run-seed-1")).toBeInTheDocument();
    expect(within(lineage).getByText("2 sources")).toBeInTheDocument();
    expect(within(lineage).getByText("openai / gpt-4.1")).toBeInTheDocument();
    expect(within(lineage).getByText("$0.1250")).toBeInTheDocument();
    expect(within(lineage).getByText("local-app")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy artifact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export artifact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate artifact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tune source workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View source run" })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Search"), "missing result");
    expect(screen.getByText("No artifacts match the current filters.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Search"));
    expect(screen.getAllByText("Daily Work Journal Artifact").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Open source workflow" }));
    expect(screen.getByRole("heading", { name: "Daily Work Journal" })).toBeInTheDocument();
    expect(screen.getByText("Workflows / Daily Work Journal")).toBeInTheDocument();
  });

  it("renders unresolved artifact destination when lineage metadata has no destination", async () => {
    const stateWithUnresolvedArtifact = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [
        {
          id: "artifact-unresolved-destination",
          title: "Loose Artifact",
          artifact_type: "plugin_artifact",
          workflow_run_id: "missing-run",
          content_markdown: "# Loose Artifact",
          metadata: { schema_version: "0.1.0" },
          source_refs: [],
          created_at: "2026-06-08T10:01:05Z",
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return stateWithUnresolvedArtifact;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findByText("Loose Artifact");
    const mainNavigation = screen.getByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Artifacts" }));

    const lineage = screen.getByRole("region", { name: "Artifact lineage" });
    expect(within(lineage).getByText("Destination unresolved")).toBeInTheDocument();
    expect(within(lineage).queryByText("Local app")).not.toBeInTheDocument();
  });

  it("runs a workflow from the home view", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "run_workflow_streamed") {
        return {
          duplicate: false,
          run: {
            id: "run-1",
            workflow_id: "daily-work-journal",
            workflow_name: "Daily Work Journal",
            status: "succeeded",
            started_at: "2026-06-08T10:01:00Z",
            completed_at: "2026-06-08T10:01:05Z",
            idempotency_key: "manual:daily-work-journal:test",
          },
          artifact: {
            id: "artifact-1",
            title: "Daily Work Journal",
            artifact_type: "daily_work_journal",
            workflow_run_id: "run-1",
            content_markdown: "# Daily Work Journal\n\nBackend artifact.",
            metadata: { schema_version: "0.1.0" },
            source_refs: ["local git status"],
            created_at: "2026-06-08T10:01:05Z",
          },
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    const runButtons = screen.getAllByRole("button", { name: /Run now for Daily Work Journal/ });
    await userEvent.click(runButtons[0]);

    expect(invokeMock).toHaveBeenCalledWith(
      "run_workflow_streamed",
      expect.objectContaining({
        workflowId: "daily-work-journal",
        onEvent: expect.any(MockChannel),
      }),
    );
  });

  it("counts streamed run usage once when step and run events both include totals", async () => {
    invokeMock.mockImplementation(async (
      command: string,
      args?: { onEvent?: { onmessage: (message: unknown) => void } },
    ) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "run_workflow_streamed") {
        args?.onEvent?.onmessage({
          kind: "RUN_STARTED",
          run_id: "run-usage",
          workflow_name: "Daily Work Journal",
          timestamp: "2026-06-08T10:01:00Z",
        });
        args?.onEvent?.onmessage({
          kind: "STEP_STARTED",
          run_id: "run-usage",
          step_id: "compose-artifact",
          step_name: "Compose artifact",
          timestamp: "2026-06-08T10:01:00Z",
        });
        args?.onEvent?.onmessage({
          kind: "STEP_FINISHED",
          run_id: "run-usage",
          step_id: "compose-artifact",
          duration_ms: 0,
          token_count: 16,
          estimated_cost_usd: 0.002,
        });
        args?.onEvent?.onmessage({
          kind: "RUN_FINISHED",
          run_id: "run-usage",
          duration_ms: 0,
          token_count: 16,
          estimated_cost_usd: 0.002,
        });
        return {
          duplicate: false,
          run: {
            id: "run-usage",
            workflow_id: "daily-work-journal",
            workflow_name: "Daily Work Journal",
            status: "succeeded",
            started_at: "2026-06-08T10:01:00Z",
            completed_at: "2026-06-08T10:01:05Z",
            idempotency_key: "manual:daily-work-journal:usage",
          },
          artifact: null,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(
      <RunStreamProvider>
        <RunStreamProbe />
      </RunStreamProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Start stream" }));

    expect(await screen.findByText("tokens:16")).toBeInTheDocument();
    expect(screen.getByText("cost:0.002")).toBeInTheDocument();
  });

  it("clears active stream state when streamed run result is blocked without a terminal event", async () => {
    invokeMock.mockImplementation(async (
      command: string,
      args?: { onEvent?: { onmessage: (message: unknown) => void } },
    ) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "run_workflow_streamed") {
        args?.onEvent?.onmessage({
          kind: "RUN_STARTED",
          run_id: "run-blocked",
          workflow_name: "Daily Work Journal",
          timestamp: "2026-06-08T10:01:00Z",
        });
        return {
          duplicate: false,
          run: {
            id: "run-blocked",
            workflow_id: "daily-work-journal",
            workflow_name: "Daily Work Journal",
            status: "blocked",
            started_at: "2026-06-08T10:01:00Z",
            completed_at: "2026-06-08T10:01:05Z",
            idempotency_key: "manual:daily-work-journal:blocked",
            blocked_reason: "Capability requires an active approval grant.",
          },
          artifact: null,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(
      <RunStreamProvider>
        <RunStreamProbe />
      </RunStreamProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Start stream" }));

    expect(await screen.findByText("active:none")).toBeInTheDocument();
  });

  it("summarizes blocked latest runs as blocked requirements in workflow details", async () => {
    mockPersistedState({
      ...workflowRosterState,
      runs: [
        ...workflowRosterState.runs,
        {
          id: "agent-weather-old-success",
          workflow_id: "agent-weather",
          workflow_name: "Agent Weather",
          status: "succeeded",
          started_at: "2026-06-08T09:00:00Z",
          completed_at: "2026-06-08T09:00:05Z",
          idempotency_key: "seed:agent-weather:old-success",
          provider_profile_id: "codex-oauth-local",
        },
      ],
      artifacts: [
        ...workflowRosterState.artifacts,
        {
          id: "agent-weather-old-artifact",
          title: "Old Agent Weather Artifact",
          artifact_type: "weather_report",
          workflow_run_id: "agent-weather-old-success",
          content_markdown: "# Old weather",
          metadata: { schema_version: "0.1.0", workflowId: "agent-weather" },
          source_refs: ["agent"],
          created_at: "2026-06-08T09:00:05Z",
        },
      ],
    });

    render(<App />);

    const mainNavigation = await screen.findByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Workflows" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open Agent Weather details" }));

    const summary = await screen.findByLabelText("Workflow summary");
    expect(within(summary).getByText("Requirements")).toBeInTheDocument();
    expect(within(summary).getByText("Blocked (1)")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Blocked run recovery" })).toHaveTextContent(
      "Approval required before continuing.",
    );
    expect(screen.getByRole("region", { name: "Blocked run recovery" })).toHaveTextContent(
      "No artifact was created for this blocked run.",
    );
    expect(screen.getByRole("button", { name: "Review run readiness" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry blocked run" })).toBeInTheDocument();
  });

  it("does not offer run controls for disabled workflows", async () => {
    const disabledState = {
      ...backendState,
      workflows: backendState.workflows.map((workflow) =>
        workflow.workflow_id === "daily-work-journal"
          ? { ...workflow, status: "disabled" }
          : workflow,
      ),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return disabledState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    expect(screen.queryByRole("button", { name: /Run now for Daily Work Journal/ })).not.toBeInTheDocument();
  });

  it("searches workflows by provider and model text", async () => {
    await renderWorkflows();

    await userEvent.type(screen.getByRole("searchbox", { name: "Search workflows" }), "gpt-4.1");

    expect(screen.getByText("Healthy OpenAI")).toBeInTheDocument();
    expect(screen.queryByText("Agent Weather")).not.toBeInTheDocument();
    expect(screen.queryByText("Retry Sync")).not.toBeInTheDocument();
  });

  it("persists active workflow roster filters after remount", async () => {
    const { unmount } = await renderWorkflows();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Status" }),
      "failed-retryable",
    );

    expect(screen.getAllByText("Failed/retryable").length).toBeGreaterThan(0);
    expect(screen.getByText("Retry Sync")).toBeInTheDocument();
    expect(screen.queryByText("Healthy OpenAI")).not.toBeInTheDocument();

    unmount();
    await renderWorkflows(workflowRosterState, true, "Retry Sync");

    expect(screen.getAllByText("Failed/retryable").length).toBeGreaterThan(0);
    expect(screen.getByText("Retry Sync")).toBeInTheDocument();
    expect(screen.queryByText("Healthy OpenAI")).not.toBeInTheDocument();
  });

  it("filters workflows by schedule, cost, and pending approval state", async () => {
    await renderWorkflows();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Schedule" }), "scheduled");
    expect(screen.getByText("Healthy OpenAI")).toBeInTheDocument();
    expect(screen.queryByText("Draft Brief")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove filter Scheduled" }));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Cost" }), "has-cost");
    expect(screen.getByText("Healthy OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Retry Sync")).toBeInTheDocument();
    expect(screen.queryByText("Draft Brief")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove filter Has cost" }));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Approval" }), "pending-approval");
    expect(screen.getByText("Agent Weather")).toBeInTheDocument();
    expect(screen.queryByText("Healthy OpenAI")).not.toBeInTheDocument();
  });

  it("includes live pending approvals in the pending approval workflow filter", async () => {
    const liveApprovalState = {
      ...workflowRosterState,
      runs: workflowRosterState.runs.filter((run) => run.workflow_id !== "agent-weather"),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return liveApprovalState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_pending_approvals") {
        return [
          {
            id: "approval-live-1",
            run_id: "agent-weather-live-run",
            step_id: "ask-ai",
            workflow_name: "Agent Weather",
            description: "Review the agent action before continuing.",
            risk_level: "high",
            status: "pending",
            created_at: "2026-06-08T10:04:00Z",
          },
        ];
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);
    await screen.findAllByText("Healthy OpenAI");
    const mainNavigation = screen.getByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Workflows" }));
    await screen.findByRole("heading", { name: "Workflows" });
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Approval" }), "pending-approval");

    expect(screen.getByRole("article", { name: /Agent Weather/ })).toBeInTheDocument();
    expect(screen.queryByText("Healthy OpenAI")).not.toBeInTheDocument();
  });

  it("exposes representative workflow roster actions", async () => {
    await renderWorkflows();

    const healthyRow = screen.getByRole("article", { name: /Healthy OpenAI/ });
    expect(within(healthyRow).getByRole("button", { name: "Open Healthy OpenAI details" })).toBeInTheDocument();
    expect(within(healthyRow).getByRole("button", { name: "Run now for Healthy OpenAI" })).toBeInTheDocument();
    expect(within(healthyRow).getByRole("button", { name: "Edit Healthy OpenAI schedule" })).toBeInTheDocument();
    expect(within(healthyRow).getByText("More actions")).toBeInTheDocument();

    const pausedRow = screen.getByRole("article", { name: /Paused Export/ });
    expect(within(pausedRow).queryByRole("button", { name: "Run now for Paused Export" })).not.toBeInTheDocument();
    expect(within(pausedRow).getByText("More actions")).toBeInTheDocument();

    const setupRow = screen.getByRole("article", { name: /Markdown Export/ });
    expect(within(setupRow).getByRole("button", { name: "Edit Markdown Export setup" })).toBeInTheDocument();
    await userEvent.click(within(setupRow).getByRole("button", { name: "Edit Markdown Export setup" }));
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
  });

  it("uses clear workflow action labels", async () => {
    await renderWorkflows();

    const markdownExportRow = screen.getByRole("article", { name: "Markdown Export workflow" });
    expect(within(markdownExportRow).getByRole("button", { name: "Open Markdown Export details" })).toBeInTheDocument();
    expect(within(markdownExportRow).getByRole("button", { name: "Edit Markdown Export setup" })).toBeInTheDocument();
    expect(within(markdownExportRow).getByRole("button", { name: "Edit Markdown Export schedule" })).toBeInTheDocument();
  });

  it("opens workflow detail from pending approval recovery action", async () => {
    await renderWorkflows();

    const approvalRow = screen.getByRole("article", { name: /Agent Weather/ });
    await userEvent.click(within(approvalRow).getByRole("button", { name: "Open pending approval for Agent Weather" }));

    expect(screen.getByRole("heading", { name: "Agent Weather" })).toBeInTheDocument();
  });

  it("uses a safe approval fallback when live approval workflow id is unavailable", async () => {
    const duplicateNameState = {
      ...workflowRosterState,
      workflows: [
        {
          ...workflowRosterState.workflows[0],
          id: "weather-primary-v1",
          workflow_id: "weather-primary",
          definition: {
            ...workflowRosterState.workflows[0].definition,
            id: "weather-primary",
            name: "Shared Approval Name",
          },
        },
        {
          ...workflowRosterState.workflows[1],
          id: "weather-secondary-v1",
          workflow_id: "weather-secondary",
          definition: {
            ...workflowRosterState.workflows[1].definition,
            id: "weather-secondary",
            name: "Shared Approval Name",
          },
        },
      ],
      runs: workflowRosterState.runs.filter((run) => run.id !== "approval-run-1"),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return duplicateNameState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_pending_approvals") {
        return [
          {
            id: "approval-live-safe-fallback",
            run_id: "missing-live-run",
            step_id: "ask-ai",
            workflow_name: "Shared Approval Name",
            description: "Review before continuing.",
            risk_level: "high",
            status: "pending",
            created_at: "2026-06-08T10:04:00Z",
          },
        ];
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findByRole("heading", { name: "Command Center" });
    await userEvent.click(screen.getByRole("button", { name: "Review approval" }));

    expect(await screen.findByRole("dialog", { name: "Your AI assistant" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Shared Approval Name" })).not.toBeInTheDocument();
  });

  it("updates workflow status through safe roster enable and disable actions", async () => {
    const updatedDisabledWorkflow = {
      ...workflowRosterState.workflows[0],
      id: "healthy-openai-v2",
      version: 2,
      status: "disabled",
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return workflowRosterState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "update_workflow_safe_fields") {
        expect(args).toMatchObject({
          workflowId: "healthy-openai",
          status: "disabled",
          cadence: "daily",
          localTime: "11:00",
          approvalMode: "auto_approve",
          llmProfileRef: "default-openai",
        });
        return updatedDisabledWorkflow;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);
    await screen.findAllByText("Healthy OpenAI");
    const mainNavigation = screen.getByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Workflows" }));
    await screen.findByRole("heading", { name: "Workflows" });

    await userEvent.click(screen.getByLabelText("More actions for Healthy OpenAI"));
    await userEvent.click(screen.getByRole("button", { name: "Disable Healthy OpenAI" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "update_workflow_safe_fields",
        expect.objectContaining({ workflowId: "healthy-openai", status: "disabled" }),
      );
    });
  });

  it("reports scheduled due run result counts", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return workflowRosterState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "run_scheduled_due_workflows") {
        return [
          {
            duplicate: false,
            run: {
              id: "scheduled-success",
              workflow_id: "healthy-openai",
              workflow_name: "Healthy OpenAI",
              status: "succeeded",
              started_at: "2026-06-08T11:00:00Z",
              completed_at: "2026-06-08T11:00:05Z",
              idempotency_key: "scheduled:healthy-openai",
            },
            artifact: null,
          },
          {
            duplicate: false,
            run: {
              id: "scheduled-failed",
              workflow_id: "retry-sync",
              workflow_name: "Retry Sync",
              status: "failed",
              started_at: "2026-06-08T11:00:00Z",
              completed_at: "2026-06-08T11:00:05Z",
              idempotency_key: "scheduled:retry-sync",
            },
            artifact: null,
          },
          {
            duplicate: false,
            run: {
              id: "scheduled-blocked",
              workflow_id: "agent-weather",
              workflow_name: "Agent Weather",
              status: "blocked",
              started_at: "2026-06-08T11:00:00Z",
              completed_at: "2026-06-08T11:00:05Z",
              idempotency_key: "scheduled:agent-weather",
              blocked_reason: "Approval required.",
            },
            artifact: null,
          },
        ];
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);
    await screen.findAllByText("Healthy OpenAI");
    const mainNavigation = screen.getByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Workflows" }));

    await userEvent.click(screen.getByRole("button", { name: "Run due schedules" }));

    expect(await screen.findByText("Scheduled runs: 1 started, 0 skipped/unavailable, 2 errors (1 failed, 1 blocked)")).toBeInTheDocument();
  });

  it("sends due schedule windows as local wall-clock minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 8, 17, 0));
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "run_scheduled_due_workflows") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(
      <AppStateProvider>
        <RunDueSchedulesProbe />
      </AppStateProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run due schedules probe" }));

    expect(invokeMock).toHaveBeenCalledWith("run_scheduled_due_workflows", {
      scheduleWindow: "2026-06-08T17:00",
    });
  });

  it("shows empty workflow roster results with active filters and clear filters", async () => {
    await renderWorkflows();

    await userEvent.type(screen.getByRole("searchbox", { name: "Search workflows" }), "missing provider");

    expect(screen.getByText("No workflows match.")).toBeInTheDocument();
    expect(screen.getAllByText("Search: missing provider").length).toBeGreaterThan(0);

    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);

    expect(screen.getByText("Healthy OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Agent Weather")).toBeInTheDocument();
  });

  it("sorts failed and retryable workflows above healthy workflows by status severity", async () => {
    await renderWorkflows();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort" }),
      "status-severity",
    );

    const rosterRows = screen.getAllByRole("article");
    expect(rosterRows[0]).toHaveTextContent("Retry Sync");
    expect(rosterRows[0]).not.toHaveTextContent("Healthy OpenAI");
  });

  it("persists the workflow roster density toggle", async () => {
    const { unmount } = await renderWorkflows();

    expect(screen.getByRole("region", { name: "Compact workflow roster" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cards" }));

    expect(screen.getByRole("region", { name: "Workflow roster cards" })).toBeInTheDocument();
    expect(localStorage.getItem("raven:workflow-roster")).toContain('"density":"comfortable"');

    unmount();
    await renderWorkflows();

    expect(screen.getByRole("region", { name: "Workflow roster cards" })).toBeInTheDocument();
  });

  it("assistant approval displays the persisted returned workflow version", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "create_workflow_draft") return workflowDraft;
      if (command === "approve_workflow_draft") return persistedApprovedWorkflow;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.type(
      screen.getByRole("textbox"),
      "Create an agent weather workflow",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findAllByText("Approved Agent Weather");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect((await screen.findAllByText("Persisted Agent Weather")).length).toBeGreaterThan(0);
  });

  it("assistant edits an existing workflow through safe backend fields", async () => {
    const updatedWorkflow = {
      ...backendState.workflows[1],
      id: "agent-weather-v2",
      version: 2,
      approval_mode: "auto_approve",
      definition: {
        ...backendState.workflows[1].definition,
        schedule: { cadence: "daily", local_time: "08:00" },
      },
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "update_workflow_safe_fields") {
        expect(args).toMatchObject({
          workflowId: "agent-weather",
          status: "enabled",
          cadence: "daily",
          localTime: "08:00",
          approvalMode: "auto_approve",
          llmProfileRef: "codex-oauth-local",
        });
        return updatedWorkflow;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.type(
      screen.getByRole("textbox"),
      "Change Agent Weather workflow to daily at 8am and auto approve",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Updated/)).toBeInTheDocument();
  });

  it("assistant refuses to create workflows for unavailable requested providers", async () => {
    const state = {
      ...backendState,
      agent_auth_profiles: [
        ...backendState.agent_auth_profiles,
        {
          id: "anthropic-api-key",
          display_name: "Anthropic API key",
          runner_kind: "anthropic_api",
          auth_mode: "api_key_env",
          credential_ref: "env:ANTHROPIC_API_KEY",
          model: "claude-sonnet-4",
          effort: "medium",
          status: "needs_config",
          summary: "Missing ANTHROPIC_API_KEY.",
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return state;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.type(
      screen.getByRole("textbox"),
      "Create QA unavailable provider workflow using Anthropic API key for a local artifact",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Anthropic API key needs setup/)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "create_workflow_draft",
      expect.anything(),
    );
  });

  it("assistant refuses unsupported destructive or external side-effect workflows", async () => {
    mockPersistedState(backendState);

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.type(
      screen.getByRole("textbox"),
      "Create QA unsupported side effect workflow with Codex OAuth local that deletes local files and publishes it to Slack",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/not an available approved workflow capability/)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "create_workflow_draft",
      expect.anything(),
    );
  });

  it("assistant name-based edits honor the latest provider and approval instructions", async () => {
    const state = {
      ...backendState,
      agent_auth_profiles: [
        ...backendState.agent_auth_profiles,
        {
          id: "ollama-local",
          display_name: "Ollama",
          runner_kind: "ollama_local",
          auth_mode: "local_server",
          credential_ref: "ollama:local",
          model: "llama3.2",
          effort: "medium",
          status: "available",
          summary: "Ollama is running.",
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return state;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "update_workflow_safe_fields") {
        expect(args).toMatchObject({
          workflowId: "agent-weather",
          cadence: "daily",
          localTime: "08:00",
          approvalMode: "review_changes",
          llmProfileRef: "ollama-local",
        });
        return {
          ...state.workflows[1],
          version: 2,
          approval_mode: "review_changes",
          definition: {
            ...state.workflows[1].definition,
            defaults: {
              ...state.workflows[1].definition.defaults,
              llm_profile_ref: "ollama-local",
            },
            schedule: { cadence: "daily", local_time: "08:00" },
          },
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.type(
      screen.getByRole("textbox"),
      "Change Agent Weather workflow with Codex OAuth local and auto approve to use Ollama, daily at 8am, and review changes",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Updated/)).toBeInTheDocument();
  });

  it("saves a default local time when workflow detail changes manual schedule to recurring", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return workflowRosterState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "update_workflow_safe_fields") {
        updateCalls.push(args ?? {});
        const source = workflowRosterState.workflows.find((workflow) => workflow.workflow_id === args?.workflowId);
        return {
          ...source,
          status: args?.status ?? source?.status,
          approval_mode: args?.approvalMode ?? source?.approval_mode,
          definition: {
            ...source?.definition,
            schedule: { cadence: args?.cadence, local_time: args?.localTime },
          },
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Workflows" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open Draft Brief details" }));
    await userEvent.selectOptions(screen.getByLabelText("Repeats"), "daily");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateCalls).toContainEqual(
        expect.objectContaining({
          workflowId: "draft-brief",
          cadence: "daily",
          localTime: "09:00",
        }),
      );
    });
  });

  it("opens a workflow detail page from the home view", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(
      screen.getByRole("button", { name: "Open Daily Work Journal details" }),
    );

    expect(screen.getByRole("heading", { name: "Daily Work Journal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now for Daily Work Journal" })).toBeInTheDocument();
    const builder = screen.getByLabelText("Visual workflow builder");
    expect(within(builder).getAllByText("Trigger").length).toBeGreaterThan(0);
    expect(within(builder).getAllByText("Context").length).toBeGreaterThan(0);
    expect(within(builder).getAllByText("Agent/model").length).toBeGreaterThan(0);
    expect(within(builder).getAllByText("Tools/permissions").length).toBeGreaterThan(0);
    expect(within(builder).getAllByText("Approval").length).toBeGreaterThan(0);
    expect(within(builder).getAllByText("Artifact").length).toBeGreaterThan(0);
    expect(within(builder).getAllByText("Destination").length).toBeGreaterThan(0);
    expect(within(builder).getAllByText("Schedule").length).toBeGreaterThan(0);

    await userEvent.click(within(builder).getByRole("button", { name: /Agent\/model/i }));
    const agentInspector = within(builder).getByRole("complementary", { name: "Agent/model inspector" });
    expect(agentInspector).toHaveTextContent("Edit provider");
    expect(agentInspector).toHaveTextContent("Workflow name and description");
    expect(agentInspector).toHaveTextContent("Not supported by safe edits");
    expect(agentInspector).toHaveTextContent("Configure in Settings");
  });

  it("adds, removes, undoes, and saves workflow builder step edits", async () => {
    const stateWithEditableWorkflow = {
      ...backendState,
      workflows: [persistedApprovedWorkflow],
    };
    invokeMock.mockImplementation(async (command: string, args?: any) => {
      if (command === "get_app_state") return stateWithEditableWorkflow;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_workflow_step_runs") return [];
      if (command === "install_workflow_template") {
        return {
          ...persistedApprovedWorkflow,
          id: "approved-agent-weather-v5",
          version: 5,
          definition: args.definition,
          status: args.status,
          approval_mode: args.approvalMode,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Persisted Agent Weather");
    await userEvent.click(screen.getByRole("button", { name: "Open Persisted Agent Weather details" }));

    const builder = screen.getByLabelText("Visual workflow builder");
    const clickBuilderStage = async (label: string) => {
      const stageButton = within(builder).getAllByRole("button").find((button) =>
        button.querySelector(".workflow-node-type")?.textContent === label,
      );
      expect(stageButton).toBeDefined();
      await userEvent.click(stageButton!);
    };

    await clickBuilderStage("Destination");
    const destinationInspector = within(builder).getByRole("complementary", { name: "Destination inspector" });
    await userEvent.click(within(destinationInspector).getByRole("button", { name: "Remove step" }));
    const removalDiff = within(builder).getByLabelText("Builder diff before saving");
    expect(removalDiff).toHaveTextContent(
      "Remove Save result locally",
    );
    await userEvent.click(within(removalDiff).getByRole("button", { name: /Undo draft/i }));
    expect(within(builder).queryByLabelText("Builder diff before saving")).not.toBeInTheDocument();

    await clickBuilderStage("Destination");
    const destinationInspectorAfterUndo = within(builder).getByRole("complementary", { name: "Destination inspector" });
    await userEvent.click(within(destinationInspectorAfterUndo).getByRole("button", { name: "Remove step" }));

    await clickBuilderStage("Agent/model");
    const agentInspectorAfterUndo = within(builder).getByRole("complementary", { name: "Agent/model inspector" });
    await userEvent.click(within(agentInspectorAfterUndo).getByRole("button", { name: /Completion notification/i }));
    expect(within(builder).getByLabelText("Builder diff before saving")).toHaveTextContent("Add Completion notification");
    await userEvent.click(within(builder).getByRole("button", { name: "Save builder changes" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "install_workflow_template",
        expect.objectContaining({
          definition: expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ name: "Completion notification" }),
            ]),
          }),
          status: "enabled",
          approvalMode: "review_changes",
        }),
      );
    });
  });

  it("supports drag and drop workflow step reordering in the builder", async () => {
    const stateWithEditableWorkflow = {
      ...backendState,
      workflows: [persistedApprovedWorkflow],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return stateWithEditableWorkflow;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_workflow_step_runs") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Persisted Agent Weather");
    await userEvent.click(screen.getByRole("button", { name: "Open Persisted Agent Weather details" }));

    const builder = screen.getByLabelText("Visual workflow builder");
    await userEvent.click(within(builder).getByRole("button", { name: /Tools\/permissions/i }));
    const toolsInspector = within(builder).getByRole("complementary", { name: "Tools/permissions inspector" });
    const askStep = within(toolsInspector).getByText("Ask AI").closest("article");
    const saveStep = within(toolsInspector).getByText("Save result locally").closest("article");

    expect(askStep).not.toBeNull();
    expect(saveStep).not.toBeNull();
    fireEvent.dragStart(saveStep!);
    fireEvent.dragOver(askStep!);
    fireEvent.drop(askStep!);

    expect(within(builder).getByLabelText("Builder diff before saving")).toHaveTextContent(
      "Reorder workflow steps",
    );
  });

  it("links unavailable agent auth profiles and missing AI refs to provider settings", async () => {
    const stateWithAgentRequirements = {
      ...backendState,
      workflows: [
        {
          ...backendState.workflows[1],
          definition: {
            ...backendState.workflows[1].definition,
            steps: [
              ...backendState.workflows[1].definition.steps,
              {
                kind: "agent_task",
                id: "missing-ai",
                name: "Missing AI",
                provider: "agent",
                action: "run_task",
                depends_on: ["ask-ai"],
                permissions: ["llm:generate"],
                llm_profile_ref: "missing-profile",
                inputs: { objective: "Use a missing profile." },
              },
            ],
          },
        },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "needs_config",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return stateWithAgentRequirements;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_workflow_step_runs") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Agent Weather");
    await userEvent.click(screen.getByRole("button", { name: "Open Agent Weather details" }));
    const builder = screen.getByLabelText("Visual workflow builder");
    await userEvent.click(within(builder).getByRole("button", { name: /Agent\/model/i }));

    const agentInspector = within(builder).getByRole("complementary", { name: "Agent/model inspector" });
    expect(agentInspector).toHaveTextContent("Codex (local): needs config");
    expect(agentInspector).toHaveTextContent("Missing AI profile missing-profile");
    const settingsLinks = within(agentInspector).getAllByRole("button", { name: "Configure in Settings" });
    expect(settingsLinks).toHaveLength(2);

    await userEvent.click(settingsLinks[0]);
    expect(await screen.findByRole("navigation", { name: "Settings breadcrumbs" })).toHaveTextContent(
      "SettingsGeneralCodex (local)",
    );
  });

  it("shows a clearer empty workflow builder start state before steps exist", async () => {
    const emptyWorkflowState = {
      ...backendState,
      workflows: [
        {
          ...backendState.workflows[1],
          workflow_id: "empty-agent-weather",
          definition: {
            ...backendState.workflows[1].definition,
            id: "empty-agent-weather",
            name: "Empty Agent Weather",
            steps: [],
          },
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return emptyWorkflowState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_workflow_step_runs") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Empty Agent Weather");
    await userEvent.click(screen.getByRole("button", { name: "Open Empty Agent Weather details" }));
    const builder = screen.getByLabelText("Visual workflow builder");

    expect(within(builder).getByRole("region", { name: "Empty workflow builder start panel" })).toBeInTheDocument();
    expect(within(builder).getByText("Start this workflow with a source step")).toBeInTheDocument();
    expect(within(builder).getByRole("button", { name: "Check provider" })).toBeInTheDocument();
    expect(within(builder).getByText(/No executable steps yet/)).toBeInTheDocument();
  });

  it("confirms before leaving workflow detail with unsaved safe edits", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_workflow_step_runs") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(
      screen.getByRole("button", { name: "Open Daily Work Journal details" }),
    );
    await userEvent.selectOptions(screen.getByLabelText("Status"), "draft");
    const backButtons = screen.getAllByRole("button", { name: "Back" });
    await userEvent.click(backButtons[backButtons.length - 1]);

    expect(confirmSpy).toHaveBeenCalledWith("Discard unsaved workflow changes?");
    expect(screen.getByRole("heading", { name: "Daily Work Journal" })).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it("keeps Last saved tied to persisted workflow metadata when archive fails", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_workflow_step_runs") return [];
      if (command === "archive_workflow") return null;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(
      screen.getByRole("button", { name: "Open Daily Work Journal details" }),
    );

    const summary = screen.getByLabelText("Workflow summary");
    const lastSavedMetric = within(summary)
      .getByText("Last saved")
      .closest(".metric");
    expect(lastSavedMetric).not.toBeNull();
    const initialLastSavedText = lastSavedMetric?.textContent ?? "";
    expect(lastSavedMetric).not.toHaveTextContent("Workflow archive failed");

    await userEvent.click(screen.getByRole("button", { name: "Archive workflow" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("archive_workflow", { workflowId: "daily-work-journal" });
    });
    expect(lastSavedMetric?.textContent).toBe(initialLastSavedText);
    expect(lastSavedMetric).not.toHaveTextContent("Workflow archive failed");

    confirmSpy.mockRestore();
  });

  it("confirms before top-bar Back leaves workflow detail with unsaved safe edits", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_workflow_step_runs") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(
      screen.getByRole("button", { name: "Open Daily Work Journal details" }),
    );
    await userEvent.selectOptions(screen.getByLabelText("Status"), "draft");
    await userEvent.click(screen.getAllByRole("button", { name: "Back" })[0]);

    expect(confirmSpy).toHaveBeenCalledWith("Discard unsaved workflow changes?");
    expect(screen.getByRole("heading", { name: "Daily Work Journal" })).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it("toggles the assistant drawer via the floating icon", async () => {
    render(<App />);

    const fab = screen.getByRole("button", { name: "Open Raven assistant" });
    expect(fab).toBeInTheDocument();

    await userEvent.click(fab);
    // After click, the FAB disappears because the drawer is now open
    expect(screen.queryByRole("button", { name: "Open Raven assistant" })).not.toBeInTheDocument();
    const startActions = screen.getByRole("region", { name: "Assistant start actions" });
    expect(startActions).toBeInTheDocument();
    expect(within(startActions).getByRole("button", { name: "Start a workflow" })).toBeInTheDocument();
    expect(within(startActions).getByRole("button", { name: "Review usage" })).toBeInTheDocument();
  });

  it("assistant composer separates empty, invalid, and ready states", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));

    const textarea = screen.getByPlaceholderText("Ask me anything...");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();
    expect(textarea).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.submit(sendButton.closest("form")!);
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a message before sending.");

    await userEvent.type(textarea, "What needs attention?");
    expect(textarea).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sendButton).toBeEnabled();
  });

  it("ranks assistant attention suggestions before generic navigation", () => {
    const suggestions = buildAssistantSuggestions({
      workflows: [
        {
          id: "attention-v1",
          workflowId: "attention",
          version: 1,
          status: "enabled",
          approvalMode: "always_review",
          definition: {
            schemaVersion: "0.1.0",
            id: "attention",
            name: "Attention Sync",
            description: "Needs review.",
            permissions: ["llm:generate"],
            defaults: { llmProfileRef: "missing-profile", destinationRef: "local-app" },
            schedule: { cadence: "manual" },
            steps: [],
          },
          createdAt: "2026-06-08T10:00:00Z",
        },
      ],
      runs: [
        {
          id: "attention-run",
          workflowId: "attention",
          workflowName: "Attention Sync",
          status: "retryable",
          startedAt: "2026-06-08T10:00:00Z",
          completedAt: "2026-06-08T10:01:00Z",
          idempotencyKey: "attention-run",
        },
      ],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local-app", name: "Local App", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      llmProfiles: [
        {
          id: "default-openai",
          providerId: "openai",
          model: "gpt-4.1",
          effort: "medium",
          supportsStructuredOutputs: true,
        },
      ],
      agentAuthProfiles: [],
    });

    expect(suggestions.map((suggestion) => suggestion.label).slice(0, 3)).toEqual([
      "Review Attention Sync",
      "Create workflow",
      "Open usage",
    ]);
  });

  it("assistant chips open create, usage, schedule, settings, and attention workflow targets", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return workflowRosterState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "list_workflow_step_runs") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);
    await screen.findAllByText("Healthy OpenAI");

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    const chips = screen.getByRole("region", { name: "Assistant suggestions" });
    const chipChildren = Array.from(chips.children);
    expect(chipChildren[0]).toHaveClass("assistant-suggestion-context");
    expect(within(chipChildren[0] as HTMLElement).getByText("Context")).toBeInTheDocument();
    expect(within(chipChildren[0] as HTMLElement).getByRole("heading", { name: "Your AI assistant" })).toBeInTheDocument();
    expect(chipChildren[1]).toHaveClass("assistant-chip-primary");
    expect(chipChildren[2]).toHaveClass("assistant-chip-strip");
    expect(within(chips).getByRole("button", { name: "Review Retry Sync" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Create workflow" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Open usage" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Open schedule" })).toBeInTheDocument();
    expect(within(chips).getByRole("button", { name: "Open provider settings" })).toBeInTheDocument();

    await userEvent.click(within(chips).getByRole("button", { name: "Open usage" }));
    expect(await screen.findByRole("region", { name: "Usage and cost command panel" })).toHaveClass("command-panel-targeted");

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Open schedule" }));
    expect(await screen.findByRole("region", { name: "Schedule command panel" })).toHaveClass("command-panel-targeted");

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    expect(screen.getByRole("dialog", { name: "Create workflow" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close create hub" }));

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Open provider settings" }));
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Review Retry Sync" }));
    expect(await screen.findByRole("heading", { name: "Retry Sync" })).toBeInTheDocument();
  });

  it("assistant chips apply safe workflow roster filters and sort commands", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return workflowRosterState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);
    await screen.findAllByText("Healthy OpenAI");

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Filter failed workflows" }));
    expect(await screen.findByRole("heading", { name: "Workflows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter Failed/retryable" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Sort by next run" }));
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("next-run");
  });

  it("assistant chips can hide categories and show unsupported personalization and task plans", async () => {
    mockPersistedState();

    render(<App />);
    await screen.findAllByText("Healthy OpenAI");

    await userEvent.click(screen.getByRole("button", { name: "Open Raven assistant" }));
    expect(screen.getByRole("button", { name: "Review Retry Sync" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Hide repair suggestions" }));
    expect(screen.queryByRole("button", { name: "Review Retry Sync" })).not.toBeInTheDocument();
    expect(screen.getByText("Personalized suggestions unavailable")).toBeInTheDocument();
    expect(screen.getByText("Task plan panel unavailable")).toBeInTheDocument();
    expect(localStorage.getItem("raven:hidden-assistant-chip-categories")).toContain("repair");
  });

  it("assistant thread preserves older reading position and offers jump to latest", async () => {
    const { rerender } = render(
      <MessageThread>
        <div>Older assistant response</div>
      </MessageThread>,
    );
    const messageRegion = screen.getByRole("log", { name: "Assistant messages" });
    Object.defineProperties(messageRegion, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 600 },
    });
    Object.defineProperty(messageRegion, "scrollTop", { configurable: true, writable: true, value: 40 });
    fireEvent.scroll(messageRegion);
    vi.mocked(window.HTMLElement.prototype.scrollIntoView).mockClear();

    rerender(
      <MessageThread>
        <div>Older assistant response</div>
        <div>New streamed paragraph</div>
      </MessageThread>,
    );

    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("with setup not complete, wizard shows named progress steps", () => {
    localStorage.removeItem("raven:setup-complete");

    render(<App />);

    const progress = screen.getByRole("navigation", { name: "Setup progress" });
    expect(within(progress).getByText("Welcome and value orientation")).toBeInTheDocument();
    expect(within(progress).getByText("Connect AI provider")).toBeInTheDocument();
    expect(within(progress).getByText("Choose context sources")).toBeInTheDocument();
    expect(within(progress).getByText("Choose output destination")).toBeInTheDocument();
    expect(within(progress).getByText("Set safety defaults")).toBeInTheDocument();
    expect(within(progress).getByText("Choose/create first workflow")).toBeInTheDocument();
    expect(within(progress).getByText("Review and optionally run sample")).toBeInTheDocument();
  });

  it("fast path marks onboarding skipped and resumes the checklist from Command Center", async () => {
    localStorage.removeItem("raven:setup-complete");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return {
        ...backendState,
        agent_auth_profiles: backendState.agent_auth_profiles.map((p) => ({ ...p, status: "needs_config" })),
      };
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      if (command === "get_onboarding_completed") return true;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "I know what I'm doing" }));

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    });
    const checklist = screen.getByRole("region", { name: "Onboarding checklist" });
    expect(checklist).toHaveTextContent("Finish the setup checklist");
    expect(localStorage.getItem("raven:setup-skipped")).toBe("true");

    await userEvent.click(within(checklist).getByRole("button", { name: "Resume setup" }));

    expect(await screen.findByRole("heading", { name: "Welcome to Raven" })).toBeInTheDocument();
  });

  it("skip setup also persists onboarding completion to the backend", async () => {
    localStorage.removeItem("raven:setup-complete");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      if (command === "get_onboarding_completed") return true;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Skip setup" }));

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    });
    expect(localStorage.getItem("raven:setup-skipped")).toBe("true");
  });

  it("shows explicit legacy migration before completing setup", async () => {
    localStorage.removeItem("raven:setup-complete");
    localStorage.setItem("hugin:setup-complete", "true");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return false;
      if (command === "complete_onboarding") return null;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to Raven" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use existing data" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Command Center" })).not.toBeInTheDocument();
    expect(localStorage.getItem("raven:setup-complete")).toBeNull();
    expect(localStorage.getItem("raven:setup-migrated")).toBeNull();
    expect(localStorage.getItem("hugin:setup-complete")).toBe("true");
    expect(invokeMock).not.toHaveBeenCalledWith("complete_onboarding");

    await userEvent.click(screen.getByRole("button", { name: "Use existing data" }));

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    });
    expect(localStorage.getItem("raven:setup-complete")).toBe("true");
    expect(localStorage.getItem("raven:setup-migrated")).toBe("true");
    expect(localStorage.getItem("hugin:setup-complete")).toBeNull();
  });

  it("keeps legacy markers unchanged when explicit migration completion fails", async () => {
    localStorage.removeItem("raven:setup-complete");
    localStorage.setItem("hugin:setup-complete", "true");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") throw new Error("backend unavailable");
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findByRole("heading", { name: "Welcome to Raven" });
    await userEvent.click(screen.getByRole("button", { name: "Use existing data" }));

    expect(await screen.findByText("Raven could not finalize onboarding yet. Please try again.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Command Center" })).not.toBeInTheDocument();
    expect(localStorage.getItem("raven:setup-complete")).toBeNull();
    expect(localStorage.getItem("raven:setup-migrated")).toBeNull();
    expect(localStorage.getItem("hugin:setup-complete")).toBe("true");
  });

  it('sends "Use existing data" to Command Center without onboarding calm copy when setup warnings exist', async () => {
    localStorage.removeItem("raven:setup-complete");
    localStorage.setItem("hugin:setup-complete", "true");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") {
        return {
          ...backendState,
          runs: [
            {
              id: "run-onboarding-stale",
              workflow_id: "daily-work-journal",
              workflow_name: "Daily Work Journal",
              status: "succeeded",
              started_at: "2026-06-08T10:00:00Z",
              completed_at: "2026-06-08T10:00:05Z",
              idempotency_key: "seed:onboarding:stale",
            },
          ],
          artifacts: [
            {
              id: "artifact-onboarding-stale",
              title: "Daily Work Journal Sample",
              artifact_type: "daily_work_journal",
              workflow_run_id: "run-onboarding-stale",
              content_markdown: "# Sample",
              metadata: {
                schema_version: "0.1.0",
                workflow_id: "daily-work-journal",
                source: "onboarding",
                simulated: true,
              },
              source_refs: ["onboarding selections"],
              created_at: "2026-06-08T10:00:05Z",
            },
          ],
          providers: [
            {
              id: "openai",
              name: "OpenAI",
              kind: "llm",
              status: "unavailable",
              summary: "Missing API key.",
            },
            {
              id: "local_git",
              name: "Local Git",
              kind: "context",
              status: "available",
              summary: "Ready.",
            },
            {
              id: "local_app",
              name: "Local App Store",
              kind: "artifact_destination",
              status: "available",
              summary: "Ready.",
            },
          ],
        };
      }
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return false;
      if (command === "complete_onboarding") return null;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to Raven" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Use existing data" }));

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    const summary = await screen.findByRole("region", { name: "Now and next summary" });
    expect(within(summary).getByRole("heading", { name: "Provider setup needed" })).toBeInTheDocument();
    expect(within(summary).queryByRole("heading", { name: "Sample artifact created" })).not.toBeInTheDocument();
  });

  it("does not show onboarding overlay when local setup is complete but backend onboarding is fresh", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return false;
      if (command === "complete_onboarding") return null;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    });
    expect(screen.queryByText(/Raven lives in your/i)).not.toBeInTheDocument();
  });

  it("preserves skipped onboarding state when backend repair completes", async () => {
    localStorage.setItem("raven:setup-skipped", "true");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return {
        ...backendState,
        agent_auth_profiles: backendState.agent_auth_profiles.map((p) => ({ ...p, status: "needs_config" })),
      };
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return false;
      if (command === "complete_onboarding") return null;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    });
    expect(localStorage.getItem("raven:setup-skipped")).toBe("true");
    expect(screen.getByRole("region", { name: "Onboarding checklist" })).toHaveTextContent(
      "Finish the setup checklist",
    );
  });

  it("clears skipped onboarding state after resuming setup and finishing the wizard", async () => {
    localStorage.removeItem("raven:setup-complete");
    localStorage.removeItem("raven:setup-skipped");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return {
        ...readyState,
        agent_auth_profiles: readyState.agent_auth_profiles.map((p) => ({ ...p, status: "needs_config" })),
      };
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "complete_onboarding") return null;
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "I know what I'm doing" }));
    const checklist = await screen.findByRole("region", { name: "Onboarding checklist" });
    expect(localStorage.getItem("raven:setup-skipped")).toBe("true");

    await userEvent.click(within(checklist).getByRole("button", { name: "Resume setup" }));
    await screen.findByRole("heading", { name: "Welcome to Raven" });
    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    expect(localStorage.getItem("raven:setup-skipped")).toBeNull();
    expect(screen.queryByRole("region", { name: "Onboarding checklist" })).not.toBeInTheDocument();
  });

  it("lets the user retry backend onboarding repair without reloading", async () => {
    let completionAttempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return false;
      if (command === "complete_onboarding") {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error("backend unavailable");
        return null;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Raven could not finalize onboarding yet. Please try again.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/Raven lives in your/i)).not.toBeInTheDocument();
    expect(completionAttempts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(completionAttempts).toBe(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Raven lives in your/i)).not.toBeInTheDocument();
  });

  it("refreshes provider readiness on provider-step entry and shows ready local CLI auth profiles", async () => {
    localStorage.removeItem("raven:setup-complete");
    const staleState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          ...backendState.agent_auth_profiles[0],
          status: "needs_config",
          summary: "Codex CLI not detected yet.",
        },
        {
          id: "claude-code-local",
          display_name: "Claude Code (local)",
          runner_kind: "claude_code_cli",
          auth_mode: "claude_code_oauth_local_cli",
          credential_ref: "claude-code:oauth:local-cli",
          model: "claude-sonnet-4-6",
          effort: "medium",
          status: "needs_config",
          summary: "Claude Code CLI not detected yet.",
        },
      ],
    };
    const refreshedState = {
      ...staleState,
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "anthropic", name: "Anthropic", kind: "llm", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: [
        {
          ...staleState.agent_auth_profiles[0],
          status: "available",
          summary: "Codex OAuth local CLI.",
        },
        {
          ...staleState.agent_auth_profiles[1],
          status: "available",
          summary: "Claude Code OAuth local CLI.",
        },
      ],
    };
    let getAppStateCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") {
        getAppStateCalls += 1;
        return getAppStateCalls === 1 ? staleState : refreshedState;
      }
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });

    await waitFor(() => {
      expect(getAppStateCalls).toBeGreaterThanOrEqual(2);
    });
    const openAiCard = screen.getByRole("heading", { name: "OpenAI" }).closest(".provider-group-card");
    const anthropicCard = screen.getByRole("heading", { name: "Anthropic" }).closest(".provider-group-card");
    expect(openAiCard).not.toBeNull();
    expect(anthropicCard).not.toBeNull();
    expect(within(openAiCard as HTMLElement).getByText("Codex (local)")).toBeInTheDocument();
    expect(within(openAiCard as HTMLElement).getAllByText("Ready").length).toBeGreaterThan(0);
    expect(within(anthropicCard as HTMLElement).getByText("Claude Code (local)")).toBeInTheDocument();
    expect(within(anthropicCard as HTMLElement).getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it("treats live Ollama detection as authoritative when persisted Local AI readiness is stale-negative", async () => {
    localStorage.removeItem("raven:setup-complete");
    const staleNegativeState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          id: "ollama-local",
          display_name: "Ollama (local)",
          runner_kind: "ollama_local",
          auth_mode: "none",
          credential_ref: null,
          model: "llama3.1:8b",
          effort: "medium",
          status: "needs_config",
          summary: "Ollama has not been detected yet.",
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return staleNegativeState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "complete_onboarding") return null;
      if (command === "ollama_status") return "0.5.1";
      if (command === "ollama_models") {
        return [
          { name: "llama3.1:8b", parameter_size: "8B" },
          { name: "mistral:7b", parameter_size: "7B" },
        ];
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });

    const localAiCard = screen.getByRole("heading", { name: "Local AI" }).closest(".provider-group-card");
    expect(localAiCard).not.toBeNull();
    expect(await within(localAiCard as HTMLElement).findByText("Ollama 0.5.1 detected")).toBeInTheDocument();
    expect(within(localAiCard as HTMLElement).getByRole("option", { name: "llama3.1:8b (8B)" })).toBeInTheDocument();
    expect(
      (localAiCard as HTMLElement).querySelector(".provider-group-header .readiness-pill")?.textContent,
    ).toBe("Ready");
    expect(within(localAiCard as HTMLElement).getAllByText("Ready").length).toBeGreaterThan(0);
    expect(invokeMock).toHaveBeenCalledWith("ollama_status");
    expect(invokeMock).toHaveBeenCalledWith("ollama_models");

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Choose context sources" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Morning Brief" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Review and optionally run sample" });

    expect(screen.getByText("Ollama (local) ready")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "install_workflow_template",
        expect.objectContaining({
          status: "enabled",
          definition: expect.objectContaining({
            defaults: expect.objectContaining({
              llm_profile_ref: "ollama-local",
            }),
          }),
        }),
      );
    });
  });

  it("keeps Local AI not ready and shows start guidance when Ollama is unavailable", async () => {
    localStorage.removeItem("raven:setup-complete");
    const unavailableState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          id: "ollama-local",
          display_name: "Ollama (local)",
          runner_kind: "ollama_local",
          auth_mode: "none",
          credential_ref: null,
          model: "llama3.1:8b",
          effort: "medium",
          status: "available",
          summary: "Ollama is installed locally.",
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return unavailableState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "ollama_status") return null;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });

    const localAiCard = screen.getByRole("heading", { name: "Local AI" }).closest(".provider-group-card");
    expect(localAiCard).not.toBeNull();
    expect(
      (localAiCard as HTMLElement).querySelector(".provider-group-header .readiness-pill")?.textContent,
    ).toBe("Setup required");
    expect(within(localAiCard as HTMLElement).getByText("Unavailable")).toBeInTheDocument();
    expect(within(localAiCard as HTMLElement).getByText(/Ollama not running/i)).toBeInTheDocument();
    expect(within(localAiCard as HTMLElement).getByRole("link", { name: "Install Ollama" })).toHaveAttribute(
      "href",
      "https://ollama.com/download",
    );
  });

  it("lets manual Detect Ollama promote stale-negative Local AI readiness after an initial failed probe", async () => {
    localStorage.removeItem("raven:setup-complete");
    const staleNegativeState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          id: "ollama-local",
          display_name: "Ollama (local)",
          runner_kind: "ollama_local",
          auth_mode: "none",
          credential_ref: null,
          model: "llama3.1:8b",
          effort: "medium",
          status: "unavailable",
          summary: "Ollama has not been detected yet.",
        },
      ],
    };
    let ollamaStatusCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return staleNegativeState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "ollama_status") {
        ollamaStatusCalls += 1;
        return ollamaStatusCalls === 1 ? null : "0.5.1";
      }
      if (command === "ollama_models") {
        return [{ name: "llama3.1:8b", parameter_size: "8B" }];
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });

    const localAiCard = screen.getByRole("heading", { name: "Local AI" }).closest(".provider-group-card");
    expect(localAiCard).not.toBeNull();
    expect(await within(localAiCard as HTMLElement).findByText(/Ollama not running/i)).toBeInTheDocument();
    expect(
      (localAiCard as HTMLElement).querySelector(".provider-group-header .readiness-pill")?.textContent,
    ).toBe("Setup required");

    await userEvent.click(within(localAiCard as HTMLElement).getAllByRole("button", { name: "Detect Ollama" })[0]);

    expect(await within(localAiCard as HTMLElement).findByText("Ollama 0.5.1 detected")).toBeInTheDocument();
    expect(
      (localAiCard as HTMLElement).querySelector(".provider-group-header .readiness-pill")?.textContent,
    ).toBe("Ready");
    expect(within(localAiCard as HTMLElement).getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it("waits for provider refresh before rendering provider cards on first provider-step entry", async () => {
    localStorage.removeItem("raven:setup-complete");
    const staleState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          ...backendState.agent_auth_profiles[0],
          status: "needs_config",
          summary: "Codex CLI not detected yet.",
        },
      ],
    };
    const refreshedState = {
      ...staleState,
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: [
        {
          ...staleState.agent_auth_profiles[0],
          status: "available",
          summary: "Codex OAuth local CLI.",
        },
      ],
    };

    let resolveRefreshState: ((value: typeof refreshedState) => void) | null = null;
    let getAppStateCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_app_state") {
        getAppStateCalls += 1;
        if (getAppStateCalls === 1) return Promise.resolve(staleState);
        return new Promise((resolve) => {
          resolveRefreshState = resolve as (value: typeof refreshedState) => void;
        });
      }
      if (command === "scheduler_status") {
        return Promise.resolve({ running: false, pollIntervalSeconds: 60 });
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });

    expect(screen.getByText("Refreshing provider readiness…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "OpenAI" })).not.toBeInTheDocument();
    expect(screen.queryByText("Codex CLI not detected yet.")).not.toBeInTheDocument();

    const resolvePendingRefresh = resolveRefreshState as ((value: typeof refreshedState) => void) | null;
    if (!resolvePendingRefresh) {
      throw new Error("Expected provider-step refresh request to be pending");
    }
    resolvePendingRefresh(refreshedState);

    const openAiCard = await screen.findByRole("heading", { name: "OpenAI" });
    const openAiGroup = openAiCard.closest(".provider-group-card") as HTMLElement;
    expect(within(openAiGroup).getByText("Codex OAuth local CLI.")).toBeInTheDocument();
    expect(within(openAiGroup).getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it("keeps provider-step navigation disabled until refresh resolves", async () => {
    localStorage.removeItem("raven:setup-complete");
    const staleState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          ...backendState.agent_auth_profiles[0],
          status: "needs_config",
          summary: "Codex CLI not detected yet.",
        },
      ],
    };
    const refreshedState = {
      ...staleState,
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: [
        {
          ...staleState.agent_auth_profiles[0],
          status: "available",
          summary: "Codex OAuth local CLI.",
        },
      ],
    };

    let resolveRefreshState: ((value: typeof refreshedState) => void) | null = null;
    let getAppStateCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_app_state") {
        getAppStateCalls += 1;
        if (getAppStateCalls === 1) return Promise.resolve(staleState);
        return new Promise((resolve) => {
          resolveRefreshState = resolve as (value: typeof refreshedState) => void;
        });
      }
      if (command === "scheduler_status") {
        return Promise.resolve({ running: false, pollIntervalSeconds: 60 });
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });

    const continueButton = screen.getByRole("button", { name: "Continue" });
    const skipButton = screen.getByRole("button", { name: "Skip" });
    expect(continueButton).toBeDisabled();
    expect(skipButton).toBeDisabled();

    await userEvent.click(continueButton);
    expect(screen.getByRole("heading", { name: "Connect AI provider" })).toBeInTheDocument();

    const resolvePendingRefresh = resolveRefreshState as ((value: typeof refreshedState) => void) | null;
    if (!resolvePendingRefresh) {
      throw new Error("Expected provider-step refresh request to be pending");
    }
    resolvePendingRefresh(refreshedState);

    await screen.findByRole("heading", { name: "OpenAI" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "Skip" })).not.toBeDisabled();
    });

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Choose context sources" })).toBeInTheDocument();
  });

  it("saves the first workflow as a draft when live Ollama detection fails", async () => {
    localStorage.removeItem("raven:setup-complete");
    const unavailableState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          id: "ollama-local",
          display_name: "Ollama (local)",
          runner_kind: "ollama_local",
          auth_mode: "none",
          credential_ref: null,
          model: "llama3.1:8b",
          effort: "medium",
          status: "available",
          summary: "Ollama is installed locally.",
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return unavailableState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "complete_onboarding") return null;
      if (command === "ollama_status") return null;
      if (command === "install_workflow_template") {
        return {
          id: "morning-brief-v1",
          workflow_id: "morning-brief",
          version: 1,
          status: "draft",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "morning-brief",
            name: "Morning Brief",
            description: "Builds a morning planning brief from local project context and recent artifacts.",
            permissions: ["git:read", "artifact:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "default-openai", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "08:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await screen.findByText(/Ollama not running/i);

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Choose context sources" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Morning Brief" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Review and optionally run sample" });

    expect(screen.getByText("No provider ready")).toBeInTheDocument();
    expect(
      screen.getByText("No provider is ready, so Raven will not create an enabled workflow accidentally."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "install_workflow_template",
        expect.objectContaining({
          status: "draft",
          definition: expect.objectContaining({
            defaults: expect.objectContaining({
              llm_profile_ref: "default-openai",
            }),
          }),
        }),
      );
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "install_workflow_template",
      expect.objectContaining({ status: "enabled" }),
    );
    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
  });

  it("keeps newer provider-step refresh state when startup hydration resolves later", async () => {
    localStorage.removeItem("raven:setup-complete");
    const staleState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          ...backendState.agent_auth_profiles[0],
          status: "needs_config",
          summary: "Codex CLI not detected yet.",
        },
      ],
    };
    const refreshedState = {
      ...staleState,
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: [
        {
          ...staleState.agent_auth_profiles[0],
          status: "available",
          summary: "Codex OAuth local CLI.",
        },
      ],
    };

    let resolveInitialState: ((value: typeof staleState) => void) | null = null;
    let getAppStateCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_app_state") {
        getAppStateCalls += 1;
        if (getAppStateCalls === 1) {
          return new Promise((resolve) => {
            resolveInitialState = resolve as (value: typeof staleState) => void;
          });
        }
        return Promise.resolve(refreshedState);
      }
      if (command === "scheduler_status") {
        return Promise.resolve({ running: false, pollIntervalSeconds: 60 });
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });

    const openAiCard = await screen.findByRole("heading", { name: "OpenAI" });
    const openAiGroup = openAiCard.closest(".provider-group-card") as HTMLElement;
    expect(within(openAiGroup).getByText("Codex (local)")).toBeInTheDocument();
    expect(resolveInitialState).not.toBeNull();
    if (!resolveInitialState) {
      throw new Error("Expected initial get_app_state request to remain pending");
    }
    const resolvePendingState = resolveInitialState as (value: typeof staleState) => void;
    resolvePendingState(staleState);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(within(openAiGroup).queryByText("Codex CLI not detected yet.")).not.toBeInTheDocument();
    expect(within(openAiGroup).getByText("Codex OAuth local CLI.")).toBeInTheDocument();
    expect(within(openAiGroup).getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it("refreshes provider readiness again when re-entering the provider step", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          id: "ollama-local",
          display_name: "Ollama (local)",
          runner_kind: "ollama_local",
          auth_mode: "none",
          credential_ref: null,
          model: "llama3.1:8b",
          effort: "medium",
          status: "available",
          summary: "Ollama is installed locally.",
        },
      ],
    };

    let getAppStateCalls = 0;
    let resolveReentryRefresh: ((value: typeof readyState) => void) | null = null;
    let ollamaStatusCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_app_state") {
        getAppStateCalls += 1;
        if (getAppStateCalls <= 2) return Promise.resolve(readyState);
        return new Promise((resolve) => {
          resolveReentryRefresh = resolve as (value: typeof readyState) => void;
        });
      }
      if (command === "scheduler_status") {
        return Promise.resolve({ running: false, pollIntervalSeconds: 60 });
      }
      if (command === "ollama_status") {
        ollamaStatusCalls += 1;
        if (ollamaStatusCalls === 1) return Promise.resolve("0.5.1");
        return Promise.resolve(null);
      }
      if (command === "ollama_models") {
        return Promise.resolve([{ name: "llama3.1:8b", parameter_size: "8B" }]);
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    const initialLocalAiCard = await screen.findByRole("heading", { name: "Local AI" });
    expect(await within(initialLocalAiCard.closest(".provider-group-card") as HTMLElement).findByText(
      "Ollama 0.5.1 detected",
    )).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Choose context sources" });

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });

    await waitFor(() => {
      expect(getAppStateCalls).toBeGreaterThanOrEqual(3);
    });

    expect(screen.getByText("Refreshing provider readiness…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Local AI" })).not.toBeInTheDocument();

    const resolvePendingReentryRefresh = resolveReentryRefresh as ((value: typeof readyState) => void) | null;
    if (!resolvePendingReentryRefresh) {
      throw new Error("Expected re-entry provider-step refresh request to be pending");
    }
    resolvePendingReentryRefresh(readyState);

    const localAiCard = await screen.findByRole("heading", { name: "Local AI" });
    const localAiGroup = localAiCard.closest(".provider-group-card") as HTMLElement;
    await waitFor(() => {
      expect(
        localAiGroup.querySelector(".provider-group-header .readiness-pill")?.textContent,
      ).toBe("Setup required");
    });
    expect(within(localAiGroup).getByText("Unavailable")).toBeInTheDocument();
    expect(within(localAiGroup).getByText(/Ollama not running/i)).toBeInTheDocument();
  });

  it("ignores stale Ollama readiness from an earlier provider-step render", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: [
        {
          id: "ollama-local",
          display_name: "Ollama (local)",
          runner_kind: "ollama_local",
          auth_mode: "none",
          credential_ref: null,
          model: "llama3.1:8b",
          effort: "medium",
          status: "available",
          summary: "Ollama is installed locally.",
        },
      ],
    };

    let resolveFirstStatus: ((value: string | null) => void) | null = null;
    let ollamaStatusCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_app_state") return Promise.resolve(readyState);
      if (command === "scheduler_status") {
        return Promise.resolve({ running: false, pollIntervalSeconds: 60 });
      }
      if (command === "ollama_status") {
        ollamaStatusCalls += 1;
        if (ollamaStatusCalls === 1) {
          return new Promise((resolve) => {
            resolveFirstStatus = resolve as (value: string | null) => void;
          });
        }
        return Promise.resolve(null);
      }
      if (command === "ollama_models") {
        return Promise.resolve([{ name: "llama3.1:8b", parameter_size: "8B" }]);
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await screen.findByRole("heading", { name: "Local AI" });

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Choose context sources" });

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });

    const localAiCard = await screen.findByRole("heading", { name: "Local AI" });
    const localAiGroup = localAiCard.closest(".provider-group-card") as HTMLElement;
    expect(await within(localAiGroup).findByText(/Ollama not running/i)).toBeInTheDocument();

    const resolvePendingFirstStatus = resolveFirstStatus as ((value: string | null) => void) | null;
    if (!resolvePendingFirstStatus) {
      throw new Error("Expected initial Ollama probe to remain pending");
    }
    resolvePendingFirstStatus("0.5.1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(within(localAiGroup).queryByText("Ollama 0.5.1 detected")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Morning Brief" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Review and optionally run sample" })).toBeInTheDocument();
    expect(screen.getByText("No provider ready")).toBeInTheDocument();
  });

  it("shows NestWeaver as detected but needing project configuration during context setup", async () => {
    localStorage.removeItem("raven:setup-complete");
    const state = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        {
          id: "nestweaver",
          name: "NestWeaver",
          kind: "context",
          status: "unavailable",
          summary: "NestWeaver is not connected. Raven will use Local Git context until it is configured.",
          fallback_provider_id: "local_git",
        },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return state;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "complete_onboarding") return null;
      if (command === "detect_nestweaver") {
        return {
          binary_path: "/detected/nestweaver",
          db_path: null,
          projects: [],
        };
      }
      if (command === "detect_tools") {
        return [{ id: "cli.nestweaver", displayName: "NestWeaver", status: "available" }];
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Choose context sources" });

    expect(await screen.findByText("Detected, needs project configuration.")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("detect_nestweaver");
    expect(screen.getByText("Local Git stays selected until NestWeaver is ready.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Local git" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "NestWeaver" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "NestWeaver" })).not.toBeChecked();
  });

  it("keeps Local Git selected when NestWeaver is unavailable during context setup", async () => {
    localStorage.removeItem("raven:setup-complete");
    const state = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        {
          id: "nestweaver",
          name: "NestWeaver",
          kind: "context",
          status: "unavailable",
          summary: "NestWeaver is not connected. Raven will use Local Git context until it is configured.",
          fallback_provider_id: "local_git",
        },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return state;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "complete_onboarding") return null;
      if (command === "detect_nestweaver") return null;
      if (command === "detect_tools") return [];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Choose context sources" });

    expect(screen.getByRole("checkbox", { name: "Local git" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "NestWeaver" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Choose output destination" })).toBeInTheDocument();
  });

  it("shows ready NestWeaver context and includes it in the review summary", async () => {
    localStorage.removeItem("raven:setup-complete");
    const state = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        {
          id: "nestweaver",
          name: "NestWeaver",
          kind: "context",
          status: "available",
          summary: "NestWeaver daemon 0.1.0 is ready with a configured project database.",
          fallback_provider_id: "local_git",
        },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return state;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "complete_onboarding") return null;
      if (command === "detect_nestweaver") {
        return {
          binary_path: "/detected/nestweaver",
          db_path: "/redacted/project-db",
          projects: ["raven"],
        };
      }
      if (command === "detect_tools") {
        return [{ id: "cli.nestweaver", displayName: "NestWeaver", status: "available" }];
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Choose context sources" });

    expect(await screen.findByText("Indexed project context ready.")).toBeInTheDocument();
    const nestWeaver = screen.getByRole("checkbox", { name: "NestWeaver" });
    expect(nestWeaver).toBeEnabled();
    await userEvent.click(nestWeaver);
    expect(nestWeaver).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Review and optionally run sample" });

    expect(screen.getByText("Local git, NestWeaver")).toBeInTheDocument();
  });

  it("new user skips provider setup, selects a workflow, and completes review as draft", async () => {
    localStorage.removeItem("raven:setup-complete");
    const noProviderState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "needs_config",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return noProviderState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "complete_onboarding") return null;
      if (command === "install_workflow_template") {
        return {
          id: "morning-brief-v1",
          workflow_id: "morning-brief",
          version: 1,
          status: "draft",
          approval_mode: "always_review",
          definition: {
            schema_version: "0.1.0",
            id: "morning-brief",
            name: "Morning Brief",
            description: "Builds a morning planning brief from local project context and recent artifacts.",
            permissions: ["git:read", "artifact:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "default-openai", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "08:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Morning Brief" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "install_workflow_template",
        expect.objectContaining({ status: "draft" }),
      );
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "install_workflow_template",
      expect.objectContaining({ status: "enabled" }),
    );
    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    });
    expect(screen.getAllByText("Morning Brief").length).toBeGreaterThan(0);
  });

  it("creates an explicit simulated onboarding preview artifact when setup saves a draft", async () => {
    localStorage.removeItem("raven:setup-complete");
    const noProviderState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "needs_config",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return noProviderState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      if (command === "install_workflow_template") {
        return {
          id: "morning-brief-v1",
          workflow_id: "morning-brief",
          version: 1,
          status: "draft",
          approval_mode: "always_review",
          definition: {
            schema_version: "0.1.0",
            id: "morning-brief",
            name: "Morning Brief",
            description: "Builds a morning planning brief from local project context and recent artifacts.",
            permissions: ["git:read", "artifact:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "default-openai", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "08:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      if (command === "run_workflow") {
        throw new Error("Draft sample should be simulated locally");
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(
      <UIProvider>
        <AppStateProvider>
          <RunStreamProvider>
            <SetupWizard />
            <SetupWizardStateProbe />
          </RunStreamProvider>
        </AppStateProvider>
      </UIProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Morning Brief" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText((_, node) => node?.textContent === "Simulated preview only.Raven will save a draft and create a local preview artifact."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Create a simulated preview artifact after saving draft/i));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(invokeMock).not.toHaveBeenCalledWith("run_workflow", expect.anything());
    expect(screen.getByTestId("setup-wizard-latest-artifact")).toHaveTextContent("\"simulated\":true");
    expect(screen.getByTestId("setup-wizard-latest-artifact")).toHaveTextContent("\"source\":\"onboarding\"");
    expect(screen.getByTestId("setup-wizard-latest-artifact")).toHaveTextContent("Morning Brief Sample");
  });

  async function renderPostOnboardingLandingWithStaleArtifact() {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") {
        return {
          ...backendState,
          runs: [
            {
              id: "run-onboarding-stale",
              workflow_id: "daily-work-journal",
              workflow_name: "Daily Work Journal",
              status: "succeeded",
              started_at: "2026-06-08T10:00:00Z",
              completed_at: "2026-06-08T10:00:05Z",
              idempotency_key: "seed:onboarding:stale",
            },
          ],
          artifacts: [
            {
              id: "artifact-onboarding-stale",
              title: "Daily Work Journal Sample",
              artifact_type: "daily_work_journal",
              workflow_run_id: "run-onboarding-stale",
              content_markdown: "# Sample",
              metadata: {
                schema_version: "0.1.0",
                workflow_id: "daily-work-journal",
                source: "onboarding",
                simulated: true,
              },
              source_refs: ["onboarding selections"],
              created_at: "2026-06-08T10:00:05Z",
            },
          ],
          providers: [
            {
              id: "openai",
              name: "OpenAI",
              kind: "llm",
              status: "unavailable",
              summary: "Missing API key.",
            },
            {
              id: "local_git",
              name: "Local Git",
              kind: "context",
              status: "available",
              summary: "Ready.",
            },
            {
              id: "local_app",
              name: "Local App Store",
              kind: "artifact_destination",
              status: "available",
              summary: "Ready.",
            },
          ],
        };
      }
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      throw new Error(`Unexpected command ${command}`);
    });

    render(
      <UIProvider>
        <AppStateProvider>
          <RunStreamProvider>
            <PostOnboardingLandingProbe />
          </RunStreamProvider>
        </AppStateProvider>
      </UIProvider>,
    );
  }

  it("keeps post-onboarding calm copy visible after the consume effect settles", async () => {
    await renderPostOnboardingLandingWithStaleArtifact();

    await waitFor(() => {
      expect(screen.getByTestId("post-onboarding-priority")).toHaveTextContent("Provider setup needed");
    });

    await userEvent.click(screen.getByRole("button", { name: "Complete setup probe" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    });
    expect(screen.getByTestId("post-onboarding-landing-pending")).toHaveTextContent("true");
    expect(screen.getByTestId("post-onboarding-priority")).toHaveTextContent("Sample artifact created");

    await userEvent.click(screen.getByRole("button", { name: "Show home probe" }));

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    const summary = await screen.findByRole("region", { name: "Now and next summary" });
    await waitFor(() => {
      expect(screen.getByTestId("post-onboarding-landing-pending")).toHaveTextContent("false");
    });
    expect(screen.getByTestId("post-onboarding-priority")).toHaveTextContent("Provider setup needed");
    expect(within(summary).getByRole("heading", { name: "Sample artifact created" })).toBeInTheDocument();
    expect(within(summary).getByText("Daily Work Journal Sample is ready from Daily Work Journal.")).toBeInTheDocument();
  });

  it("drops stale onboarding calm copy after leaving and re-entering Home", async () => {
    await renderPostOnboardingLandingWithStaleArtifact();

    await userEvent.click(screen.getByRole("button", { name: "Complete setup probe" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    });

    await userEvent.click(screen.getByRole("button", { name: "Show home probe" }));

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    let summary = await screen.findByRole("region", { name: "Now and next summary" });
    await waitFor(() => {
      expect(screen.getByTestId("post-onboarding-landing-pending")).toHaveTextContent("false");
    });
    expect(within(summary).getByRole("heading", { name: "Sample artifact created" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Hide home probe" }));
    expect(screen.queryByRole("region", { name: "Now and next summary" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show home probe" }));

    summary = await screen.findByRole("region", { name: "Now and next summary" });
    expect(within(summary).getByRole("heading", { name: "Provider setup needed" })).toBeInTheDocument();
    expect(within(summary).queryByRole("heading", { name: "Sample artifact created" })).not.toBeInTheDocument();
  });

  it("imports an existing workflow during onboarding and saves it through review", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      if (command === "install_workflow_template") {
        expect(args?.definition).toMatchObject({
          id: "imported-weekly-summary",
          name: "Imported Weekly Summary",
        });
        return {
          id: "imported-weekly-summary-v1",
          workflow_id: "imported-weekly-summary",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: args?.definition,
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Import workflow" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: JSON.stringify({
          schema_version: "0.1.0",
          id: "imported-weekly-summary",
          name: "Imported Weekly Summary",
          description: "Imported from an existing local workflow definition.",
          permissions: ["llm:generate", "artifact:write"],
          defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
          schedule: { cadence: "manual" },
          steps: [],
        }),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText(/Imported Weekly Summary · imported JSON/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "install_workflow_template",
        expect.objectContaining({ status: "enabled" }),
      );
    });
    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    expect(screen.getAllByText("Imported Weekly Summary").length).toBeGreaterThan(0);
  });

  it("completing provider, context, output, safety, and template setup enables the workflow", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "complete_onboarding") return null;
      if (command === "detect_tools") return [{ id: "cli.gh", status: "available", source: "system", display_name: "GitHub CLI", operations: [], annotations: {} }];
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByLabelText("GitHub"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByLabelText("Local app"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByLabelText("Review changes"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "install_workflow_template",
        expect.objectContaining({
          status: "enabled",
          approvalMode: "review_changes",
        }),
      );
    });
    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    });
    expect(screen.getAllByText("Daily Work Journal").length).toBeGreaterThan(0);
  });

  it("requires explicit approval before running a live onboarding sample", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      if (command === "evaluate_workflow_definition_preflight") {
        return onboardingApprovalRequiredPreflight;
      }
      if (command === "run_workflow") {
        throw new Error("Live sample should wait for explicit approval");
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(
      <UIProvider>
        <AppStateProvider>
          <RunStreamProvider>
            <SetupWizard />
            <SetupWizardStateProbe />
          </RunStreamProvider>
        </AppStateProvider>
      </UIProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Approval required before Raven can run a live sample.")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Run a sample after saving/i));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "install_workflow_template",
        expect.objectContaining({ status: "enabled" }),
      );
    });
    expect(invokeMock).not.toHaveBeenCalledWith("create_approval_grant", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("run_workflow", expect.anything());
  });

  it("creates approval grants before running an approved onboarding sample", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      if (command === "evaluate_workflow_definition_preflight") {
        return onboardingApprovalRequiredPreflight;
      }
      if (command === "create_approval_grant") {
        const grant = (args?.grant ?? {}) as Record<string, unknown>;
        return {
          ...grant,
          scope: {
            paths: ["artifacts/daily.md"],
            domains: [],
            resource_ids: [],
            external_targets: [],
          },
        };
      }
      if (command === "list_approval_grants") {
        return [];
      }
      if (command === "approve_workflow_signature_baseline") {
        return null;
      }
      if (command === "run_workflow") {
        return {
          duplicate: false,
          run: {
            id: "run-onboarding-approved",
            workflow_id: "daily-work-journal",
            workflow_name: "Daily Work Journal",
            status: "succeeded",
            started_at: "2026-06-08T10:06:00Z",
            completed_at: "2026-06-08T10:06:05Z",
            idempotency_key: "manual:daily-work-journal:onboarding-approved",
          },
          artifact: {
            id: "artifact-onboarding-approved",
            title: "Daily Work Journal Sample",
            artifact_type: "daily_work_journal",
            workflow_run_id: "run-onboarding-approved",
            content_markdown: "# Daily Work Journal Sample\n\nApproved live sample output.",
            metadata: {
              schema_version: "0.1.0",
              workflow_id: "daily-work-journal",
              workflow_version: 1,
            },
            source_refs: ["local git"],
            created_at: "2026-06-08T10:06:05Z",
          },
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(
      <UIProvider>
        <AppStateProvider>
          <RunStreamProvider>
            <SetupWizard />
            <SetupWizardStateProbe />
          </RunStreamProvider>
        </AppStateProvider>
      </UIProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await userEvent.click(screen.getByRole("button", { name: "Approve required access for a live sample" }));
    await userEvent.click(screen.getByLabelText(/Run a sample after saving/i));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "create_approval_grant",
        expect.objectContaining({
          grant: expect.objectContaining({
            workflow_id: "daily-work-journal",
            workflow_version: 1,
            capability_id: "local_app.write_artifact",
            grant_type: "file_write",
          }),
        }),
      );
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("run_workflow", { workflowId: "daily-work-journal" });
    });
    expect(invokeMock).toHaveBeenCalledWith("approve_workflow_signature_baseline", {
      workflowId: "daily-work-journal",
      workflowVersion: 1,
    });

    expect(screen.getByTestId("setup-wizard-latest-artifact")).toHaveTextContent("artifact-onboarding-approved");
    expect(screen.getByTestId("setup-wizard-latest-artifact")).toHaveTextContent("Daily Work Journal Sample");
  });

  it("does not run an onboarding live sample when approval grant creation resolves as failed", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      if (command === "evaluate_workflow_definition_preflight") {
        return onboardingApprovalRequiredPreflight;
      }
      if (command === "create_approval_grant") {
        throw new Error("grant unavailable");
      }
      if (command === "run_workflow") {
        throw new Error("Live sample should not run after failed approval grants");
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve required access for a live sample" }));
    await userEvent.click(screen.getByLabelText(/Run a sample after saving/i));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(await screen.findByText("Raven could not create every required approval grant for the live sample.")).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === "create_approval_grant")).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([command]) => command === "run_workflow")).toBe(false);
    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
  });

  it("onboarding sample run uses the newly installed workflow", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      if (command === "evaluate_workflow_definition_preflight") {
        return onboardingLiveReadyPreflight;
      }
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      if (command === "run_workflow") {
        return {
          duplicate: false,
          run: {
            id: "run-onboarding-sample",
            workflow_id: "daily-work-journal",
            workflow_name: "Daily Work Journal",
            status: "succeeded",
            started_at: "2026-06-08T10:06:00Z",
            completed_at: "2026-06-08T10:06:05Z",
            idempotency_key: "manual:daily-work-journal:onboarding",
          },
          artifact: null,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByLabelText(/Run a sample after saving/));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("run_workflow", { workflowId: "daily-work-journal" });
    });
    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
  });

  it("unconfigured markdown destination saves the first onboarding workflow as draft", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyProviderState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
        { id: "markdown_folder", name: "Markdown Folder", kind: "artifact_destination", status: "needs_config", summary: "Needs a folder." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyProviderState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "draft",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "markdown_folder" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByLabelText("Markdown folder"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "install_workflow_template",
        expect.objectContaining({ status: "draft" }),
      );
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "install_workflow_template",
      expect.objectContaining({ status: "enabled" }),
    );
  });

  it("shows one recovery notice for an unexpected onboarding sample failure without reopening onboarding", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "complete_onboarding") return null;
      if (command === "evaluate_workflow_definition_preflight") {
        return onboardingLiveReadyPreflight;
      }
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      if (command === "run_workflow") {
        throw new Error("sample unavailable");
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByLabelText(/Run a sample after saving/));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    expect(screen.getAllByText("Run failed: sample unavailable")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Welcome to Raven" })).not.toBeInTheDocument();
    expect(screen.queryByText("Saving...")).not.toBeInTheDocument();
  });

  it("retries onboarding completion after failure without reinstalling or rerunning the sample", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    let completionAttempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "evaluate_workflow_definition_preflight") {
        return onboardingLiveReadyPreflight;
      }
      if (command === "complete_onboarding") {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error("backend unavailable");
        return null;
      }
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      if (command === "run_workflow") {
        return {
          duplicate: false,
          run: {
            id: "run-onboarding-sample",
            workflow_id: "daily-work-journal",
            workflow_name: "Daily Work Journal",
            status: "succeeded",
            started_at: "2026-06-08T10:06:00Z",
            completed_at: "2026-06-08T10:06:05Z",
            idempotency_key: "manual:daily-work-journal:onboarding",
          },
          artifact: null,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Connect AI provider" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByLabelText(/Run a sample after saving/));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(await screen.findByText("Raven could not finalize onboarding yet. Please try again.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Command Center" })).not.toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === "install_workflow_template")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_workflow")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(completionAttempts).toBe(2);
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === "install_workflow_template")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_workflow")).toHaveLength(1);
    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
  });

  it("does not replay install or sample side effects after remounting the wizard", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    let completionAttempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "evaluate_workflow_definition_preflight") {
        return onboardingLiveReadyPreflight;
      }
      if (command === "complete_onboarding") {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error("backend unavailable");
        return null;
      }
      if (command === "install_workflow_template") {
        return {
          id: "daily-work-journal-v1",
          workflow_id: "daily-work-journal",
          version: 1,
          status: "enabled",
          approval_mode: "review_changes",
          definition: {
            schema_version: "0.1.0",
            id: "daily-work-journal",
            name: "Daily Work Journal",
            description: "Summarizes local project activity into a concise daily work journal artifact.",
            permissions: ["git:read", "artifact:write", "llm:generate"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "weekdays", local_time: "17:00" },
            steps: [],
          },
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      if (command === "run_workflow") {
        return {
          duplicate: false,
          run: {
            id: "run-onboarding-sample",
            workflow_id: "daily-work-journal",
            workflow_name: "Daily Work Journal",
            status: "succeeded",
            started_at: "2026-06-08T10:06:00Z",
            completed_at: "2026-06-08T10:06:05Z",
            idempotency_key: "manual:daily-work-journal:onboarding",
          },
          artifact: null,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    const completeWizardToFailure = async () => {
      await userEvent.click(screen.getByRole("button", { name: "Get started" }));
      await screen.findByRole("heading", { name: "Connect AI provider" });
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.click(screen.getByLabelText(/Run a sample after saving/));
      await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    };

    const firstRender = render(<App />);

    await completeWizardToFailure();
    expect(await screen.findByText("Raven could not finalize onboarding yet. Please try again.")).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === "install_workflow_template")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_workflow")).toHaveLength(1);

    firstRender.unmount();
    render(<App />);

    await completeWizardToFailure();

    await waitFor(() => {
      expect(completionAttempts).toBe(2);
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === "install_workflow_template")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_workflow")).toHaveLength(1);
    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
  });

  it("reinstalls onboarding workflow after remount when selections change the workflow definition", async () => {
    localStorage.removeItem("raven:setup-complete");
    const readyState = {
      ...backendState,
      workflows: [],
      runs: [],
      artifacts: [],
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
        { id: "markdown_folder", name: "Markdown Folder", kind: "artifact_destination", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    let completionAttempts = 0;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, any>) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "get_onboarding_completed") return true;
      if (command === "evaluate_workflow_definition_preflight") {
        return onboardingLiveReadyPreflight;
      }
      if (command === "complete_onboarding") {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error("backend unavailable");
        return null;
      }
      if (command === "install_workflow_template") {
        return {
          id: `daily-work-journal-v${completionAttempts + 1}`,
          workflow_id: "daily-work-journal",
          version: completionAttempts + 1,
          status: args?.status ?? "enabled",
          approval_mode: args?.approvalMode ?? "review_changes",
          definition: args?.definition,
          created_at: "2026-06-08T10:05:00Z",
        };
      }
      if (command === "run_workflow") {
        return {
          duplicate: false,
          run: {
            id: `run-onboarding-sample-${completionAttempts + 1}`,
            workflow_id: "daily-work-journal",
            workflow_name: "Daily Work Journal",
            status: "succeeded",
            started_at: "2026-06-08T10:06:00Z",
            completed_at: "2026-06-08T10:06:05Z",
            idempotency_key: `manual:daily-work-journal:onboarding:${completionAttempts + 1}`,
          },
          artifact: null,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    const completeWizardToFailure = async (outputLabel?: "Markdown folder") => {
      await userEvent.click(screen.getByRole("button", { name: "Get started" }));
      await screen.findByRole("heading", { name: "Connect AI provider" });
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      if (outputLabel) {
        await userEvent.click(screen.getByLabelText(outputLabel));
      }
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.click(screen.getByRole("button", { name: "Use template Daily Work Journal" }));
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await userEvent.click(screen.getByLabelText(/Run a sample after saving/));
      await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    };

    const firstRender = render(<App />);

    await completeWizardToFailure();
    expect(await screen.findByText("Raven could not finalize onboarding yet. Please try again.")).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === "install_workflow_template")).toHaveLength(1);

    firstRender.unmount();
    render(<App />);

    await completeWizardToFailure("Markdown folder");

    await waitFor(() => {
      expect(completionAttempts).toBe(2);
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === "install_workflow_template")).toHaveLength(2);
    expect(invokeMock).toHaveBeenNthCalledWith(
      invokeMock.mock.calls.findIndex(([command]) => command === "install_workflow_template") + 1,
      "install_workflow_template",
      expect.objectContaining({
        definition: expect.objectContaining({
          defaults: expect.objectContaining({ destination_ref: "local-app" }),
        }),
      }),
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      invokeMock.mock.calls
        .map(([command]) => command)
        .reduce((matches, command, index) => (
          command === "install_workflow_template" ? [...matches, index + 1] : matches
        ), [] as number[])[1],
      "install_workflow_template",
      expect.objectContaining({
        definition: expect.objectContaining({
          defaults: expect.objectContaining({ destination_ref: "markdown_folder" }),
        }),
      }),
    );
    expect(await screen.findByRole("heading", { name: "Command Center" })).toBeInTheDocument();
  });

  it("going back from safety step to context preserves context selections", async () => {
    localStorage.removeItem("raven:setup-complete");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") return { running: false, pollIntervalSeconds: 60 };
      if (command === "detect_tools") return [{ id: "cli.gh", status: "available", source: "system", display_name: "GitHub CLI", operations: [], annotations: {} }];
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByLabelText("GitHub"));
    await userEvent.click(screen.getByLabelText("Documents"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Choose output destination" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Set safety defaults" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByRole("heading", { name: "Choose context sources" })).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub")).toBeChecked();
    expect(screen.getByLabelText("Documents")).toBeChecked();
  });

  it("opens the Create Hub from Command Center instead of the assistant", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));

    expect(screen.getByRole("dialog", { name: "Create workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Describe with Raven" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Raven assistant" })).not.toBeInTheDocument();
  });

  it("opens the Create Hub from Workflows", async () => {
    render(<App />);

    const mainNavigation = screen.getByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Workflows" }));
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));

    expect(screen.getByRole("dialog", { name: "Create workflow" })).toBeInTheDocument();
  });

  it("opens the Create Hub from Cmd+K Create workflow", async () => {
    render(<App />);

    await userEvent.keyboard("{Meta>}k{/Meta}");
    await userEvent.type(screen.getByRole("combobox"), "Create workflow");
    await userEvent.keyboard("{Enter}");

    expect(screen.getByRole("dialog", { name: "Create workflow" })).toBeInTheDocument();
  });

  it("applies saved workflow roster views predictably", async () => {
    await renderWorkflows();

    await userEvent.click(screen.getByRole("button", { name: "Saved view Drafts" }));
    expect(screen.getByRole("article", { name: "Draft Brief workflow" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Healthy OpenAI workflow" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter Draft" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Saved view High cost" }));
    expect(screen.getByRole("article", { name: "Healthy OpenAI workflow" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Retry Sync workflow" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter High cost" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Saved view Needs attention" }));
    expect(screen.getByRole("article", { name: "Agent Weather workflow" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Retry Sync workflow" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Markdown Export workflow" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Draft Brief workflow" })).not.toBeInTheDocument();
  });

  it("saves applies persists and deletes custom workflow roster views", async () => {
    const { unmount } = await renderWorkflows();

    await userEvent.type(screen.getByRole("searchbox", { name: "Search workflows" }), "Healthy");
    await userEvent.type(screen.getByLabelText("Save current view"), "Healthy saved");
    await userEvent.click(screen.getByRole("button", { name: "Save view" }));

    expect(screen.getByText("Saved roster view Healthy saved.")).toBeInTheDocument();
    expect(localStorage.getItem("raven:workflow-roster-saved-views")).toContain("Healthy saved");

    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(screen.getByRole("article", { name: "Agent Weather workflow" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Saved view Healthy saved" }));

    expect(screen.getByRole("article", { name: "Healthy OpenAI workflow" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Agent Weather workflow" })).not.toBeInTheDocument();

    unmount();
    await renderWorkflows();
    await userEvent.click(screen.getByRole("button", { name: "Saved view Healthy saved" }));
    expect(screen.queryByRole("article", { name: "Agent Weather workflow" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete saved view Healthy saved" }));

    expect(screen.queryByRole("button", { name: "Saved view Healthy saved" })).not.toBeInTheDocument();
  });

  it("runs bulk workflow actions and exports selected definitions", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return workflowRosterState;
      if (command === "scheduler_status") return { running: false, pollIntervalSeconds: 60 };
      if (command === "update_workflow_safe_fields") {
        updateCalls.push(args ?? {});
        const source = workflowRosterState.workflows.find((workflow) => workflow.workflow_id === args?.workflowId);
        return {
          ...source,
          status: args?.status ?? source?.status,
          approval_mode: args?.approvalMode ?? source?.approval_mode,
          definition: {
            ...source?.definition,
            schedule: {
              cadence: args?.cadence ?? source?.definition.schedule.cadence,
              local_time: args?.localTime ?? source?.definition.schedule.local_time,
            },
          },
        };
      }
      if (command === "run_workflow_streamed") {
        return {
          duplicate: false,
          run: {
            id: `bulk-run-${args?.workflowId}`,
            workflow_id: args?.workflowId,
            workflow_name: String(args?.workflowId),
            status: "succeeded",
            started_at: "2026-06-08T10:15:00Z",
            completed_at: "2026-06-08T10:15:05Z",
            idempotency_key: `manual:${args?.workflowId}`,
          },
          artifact: null,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await renderWorkflows(workflowRosterState, false);

    expect(screen.getByRole("button", { name: "Pause selected workflows" })).toBeDisabled();
    expect(screen.getByText("No workflows selected.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Healthy OpenAI" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Agent Weather" }));
    await userEvent.click(screen.getByRole("button", { name: "Run selected workflows now" }));
    await waitFor(() => expect(screen.getByText("Started 2 workflows.")).toBeInTheDocument());
    if ((screen.getByRole("checkbox", { name: "Select Healthy OpenAI" }) as HTMLInputElement).checked) {
      await userEvent.click(screen.getByRole("button", { name: "Clear workflow selection" }));
    }

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Healthy OpenAI" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Agent Weather" }));
    await userEvent.click(screen.getByRole("button", { name: "Export selected workflows" }));
    expect(screen.getByText("Exported 2 workflow definitions.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Pause selected workflows" }));
    await waitFor(() => expect(screen.getByText("Pause updated 2 workflows.")).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Select Healthy OpenAI" })).not.toBeChecked();

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Healthy OpenAI" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Agent Weather" }));
    await userEvent.selectOptions(screen.getByLabelText("Set selected approval mode"), "always_review");
    await waitFor(() => expect(screen.getByText("Approval mode updated 2 workflows.")).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Select Healthy OpenAI" })).not.toBeChecked();

    await waitFor(() => {
      expect(updateCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workflowId: "healthy-openai", status: "disabled" }),
          expect.objectContaining({ workflowId: "agent-weather", status: "disabled" }),
          expect.objectContaining({ workflowId: "healthy-openai", approvalMode: "always_review" }),
          expect.objectContaining({ workflowId: "agent-weather", approvalMode: "always_review" }),
        ]),
      );
    });
    expect(invokeMock).toHaveBeenCalledWith("run_workflow_streamed", expect.objectContaining({ workflowId: "healthy-openai" }));
    expect(invokeMock).toHaveBeenCalledWith("run_workflow_streamed", expect.objectContaining({ workflowId: "agent-weather" }));
    expect(createObjectURLMock).toHaveBeenCalledWith(expect.any(Blob));
  });

  it("quick edits workflow status schedule and approval mode with safe fields", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return workflowRosterState;
      if (command === "scheduler_status") return { running: false, pollIntervalSeconds: 60 };
      if (command === "update_workflow_safe_fields") {
        updateCalls.push(args ?? {});
        return {
          ...workflowRosterState.workflows[0],
          status: args?.status,
          approval_mode: args?.approvalMode,
          definition: {
            ...workflowRosterState.workflows[0].definition,
            schedule: { cadence: args?.cadence, local_time: args?.localTime },
          },
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await renderWorkflows(workflowRosterState, false);
    await userEvent.click(screen.getByRole("button", { name: "Cards" }));
    const healthy = screen.getByRole("article", { name: "Healthy OpenAI workflow" });

    await userEvent.selectOptions(within(healthy).getByLabelText("Quick status for Healthy OpenAI"), "disabled");
    await userEvent.selectOptions(within(healthy).getByLabelText("Quick schedule for Healthy OpenAI"), "manual");
    await userEvent.selectOptions(within(healthy).getByLabelText("Quick approval mode for Healthy OpenAI"), "always_review");
    await userEvent.selectOptions(within(screen.getByRole("article", { name: "Draft Brief workflow" })).getByLabelText("Quick schedule for Draft Brief"), "daily");

    await waitFor(() => {
      expect(updateCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workflowId: "healthy-openai", status: "disabled" }),
          expect.objectContaining({ workflowId: "healthy-openai", cadence: "manual", localTime: undefined }),
          expect.objectContaining({ workflowId: "healthy-openai", approvalMode: "always_review" }),
          expect.objectContaining({ workflowId: "draft-brief", cadence: "daily", localTime: "09:00" }),
        ]),
      );
    });
  });

  it("shows workflow health scores comparison and deterministic optimization suggestions", async () => {
    await renderWorkflows();

    expect(screen.getByText(/Health:/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cards" }));

    const healthy = screen.getByRole("article", { name: "Healthy OpenAI workflow" });
    const retry = screen.getByRole("article", { name: "Retry Sync workflow" });
    expect(within(healthy).getByText("Healthy OpenAI health score")).toBeInTheDocument();
    expect(within(healthy).getByText("90/100")).toBeInTheDocument();
    expect(within(retry).getByText("Retry Sync health score")).toBeInTheDocument();
    expect(within(retry).getByText("60/100")).toBeInTheDocument();
    expect(screen.getByText("Review Retry Sync failure handling")).toBeInTheDocument();
    expect(screen.getByText("Finish Draft Brief setup")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Healthy OpenAI" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Retry Sync" }));

    const compare = screen.getByRole("region", { name: "Selected workflow comparison" });
    expect(compare).toHaveTextContent("Healthy OpenAI");
    expect(compare).toHaveTextContent("Retry Sync");
    expect(compare).toHaveTextContent("$1.42");
    expect(compare).toHaveTextContent("$0.08");
  });

  it("template selected with no provider ready shows missing provider actions before enable", async () => {
    const noProviderReadyState = {
      ...backendState,
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "needs_config",
      })),
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return noProviderReadyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Start from template" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Weekly Summary" }));

    expect(screen.getByRole("heading", { name: "Review draft" })).toBeInTheDocument();
    expect(screen.getByText(/No provider is ready/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Configure provider" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create enabled workflow" })).toBeDisabled();
  });

  it("invalid imported workflow shows validation errors and disables enable and run actions", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Import workflow" }));
    await userEvent.click(screen.getByLabelText("Workflow JSON"));
    await userEvent.paste(
      JSON.stringify({
        schemaVersion: "0.1.0",
        id: "bad-import",
        name: "Bad Import",
        description: "Invalid import for validation.",
        permissions: ["llm:generate"],
        defaults: { llmProfileRef: "missing-profile", destinationRef: "local-app" },
        schedule: { cadence: "manual" },
        steps: [],
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Review imported workflow" }));

    expect(screen.getByRole("heading", { name: "Review draft" })).toBeInTheDocument();
    expect(screen.getByText(/missing LLM profile missing-profile/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create enabled workflow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create and run once" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeEnabled();
  });

  it("accepts imported deterministic http probe workflows without provider setup errors", async () => {
    const readyState = {
      ...backendState,
      providers: [
        {
          id: "local_app",
          name: "Local App Store",
          kind: "artifact_destination",
          status: "available",
          summary: "Ready.",
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Import workflow" }));
    await userEvent.click(screen.getByLabelText("Workflow JSON"));
    await userEvent.paste(
      JSON.stringify({
        schemaVersion: "0.1.0",
        id: "website-up",
        name: "Website Uptime",
        description: "Checks website status deterministically.",
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
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Review imported workflow" }));

    expect(screen.getByRole("heading", { name: "Review draft" })).toBeInTheDocument();
    expect(screen.queryByText("Provider http_probe is missing.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create enabled workflow" })).toBeEnabled();
  });

  it("keeps invalid imported draft in session without persisting", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "install_workflow_template") {
        throw new Error("Invalid drafts must not persist");
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Import workflow" }));
    await userEvent.click(screen.getByLabelText("Workflow JSON"));
    await userEvent.paste(
      JSON.stringify({
        schemaVersion: "0.1.0",
        id: "bad-session-draft",
        name: "Bad Session Draft",
        description: "Invalid imported workflow.",
        permissions: ["llm:generate"],
        defaults: { llmProfileRef: "missing-profile", destinationRef: "local-app" },
        schedule: { cadence: "manual" },
        steps: [],
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Review imported workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));

    expect(invokeMock).not.toHaveBeenCalledWith("install_workflow_template", expect.anything());
    expect(screen.getByText("Draft kept in this session until validation passes.")).toBeInTheDocument();
  });

  it("unsupported imported schedule cadence shows validation error and disables enable and run", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Import workflow" }));
    await userEvent.click(screen.getByLabelText("Workflow JSON"));
    await userEvent.paste(
      JSON.stringify({
        schemaVersion: "0.1.0",
        id: "unsupported-cadence",
        name: "Unsupported Cadence",
        description: "Uses a cadence Raven does not support.",
        permissions: ["llm:generate", "network:read", "artifact:write"],
        defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
        schedule: { cadence: "hourly" },
        steps: [
          {
            kind: "agent_task",
            id: "ask-ai",
            name: "Ask AI",
            provider: "agent",
            action: "run_task",
            dependsOn: [],
            permissions: ["llm:generate", "network:read"],
            llmProfileRef: "codex-oauth-local",
            inputs: { objective: "Check something", output_schema: "artifact_envelope" },
          },
        ],
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Review imported workflow" }));

    expect(screen.getByText("Workflow schedule cadence hourly is unsupported.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create enabled workflow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create and run once" })).toBeDisabled();
  });

  it("create and run once is enabled when ready and saves before running", async () => {
    const readyState = {
      ...backendState,
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          kind: "llm",
          status: "available",
          summary: "Ready.",
        },
        {
          id: "local_app",
          name: "Local App Store",
          kind: "artifact_destination",
          status: "available",
          summary: "Ready.",
        },
        {
          id: "local_git",
          name: "Local Git",
          kind: "context",
          status: "available",
          summary: "Ready.",
        },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    const savedWorkflow = {
      id: "weekly-summary-v1",
      workflow_id: "weekly-summary",
      version: 1,
      status: "enabled",
      approval_mode: "review_changes",
      definition: {
        schema_version: "0.1.0",
        id: "weekly-summary",
        name: "Weekly Summary",
        description: "Compiles weekly project highlights from git activity into a concise summary artifact.",
        permissions: ["git:read", "artifact:write", "llm:generate"],
        defaults: { llm_profile_ref: "default-openai", destination_ref: "local-app" },
        schedule: { cadence: "weekdays", local_time: "17:00" },
        steps: [
          {
            kind: "provider_action",
            id: "collect-git-logs",
            name: "Collect git logs",
            provider: "local_git",
            action: "recent_activity",
            depends_on: [],
            permissions: ["git:read"],
            inputs: { window: "week" },
          },
          {
            kind: "provider_action",
            id: "compose-summary",
            name: "Compose weekly summary",
            provider: "openai",
            action: "generate_artifact",
            depends_on: ["collect-git-logs"],
            permissions: ["llm:generate"],
            llm_profile_ref: "default-openai",
            inputs: { template: "weekly_summary", prompt: "$steps.collect-git-logs.summary" },
          },
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact locally",
            provider: "local_app",
            action: "write_artifact",
            depends_on: ["compose-summary"],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "$steps.compose-summary.artifact" },
          },
        ],
      },
      created_at: "2026-06-08T10:05:00Z",
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "install_workflow_template") return savedWorkflow;
      if (command === "evaluate_workflow_preflight") {
        return {
          id: "preflight-weekly-summary",
          workflow_id: "weekly-summary",
          workflow_version: 1,
          registry_snapshot_hash: "snapshot",
          created_at: "2026-06-08T10:05:30Z",
          capabilities: [],
          credentials: [],
          network_domains: [],
          file_reads: [],
          file_writes: [],
          overwrites: [],
          deletes: [],
          external_publishes: [],
          scoped_network_domains: [],
          scoped_network_resources: [],
          scoped_file_writes: [],
          scoped_overwrites: [],
          scoped_external_publishes: [],
          policy_recommendation: "safe_auto",
          blocking_items: [],
        };
      }
      if (command === "run_workflow") {
        return {
          duplicate: false,
          run: {
            id: "run-weekly-once",
            workflow_id: "weekly-summary",
            workflow_name: "Weekly Summary",
            status: "succeeded",
            started_at: "2026-06-08T10:06:00Z",
            completed_at: "2026-06-08T10:06:05Z",
            idempotency_key: "manual:weekly-summary:once",
          },
          artifact: null,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Start from template" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Weekly Summary" }));
    const runOnce = screen.getByRole("button", { name: "Create and run once" });

    expect(runOnce).toBeEnabled();
    await userEvent.click(runOnce);

    expect(invokeMock).toHaveBeenCalledWith(
      "install_workflow_template",
      expect.objectContaining({ status: "enabled", approvalMode: "auto_approve" }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "evaluate_workflow_preflight",
      expect.objectContaining({ workflowId: "weekly-summary", version: 1 }),
    );
    expect(invokeMock).toHaveBeenCalledWith("run_workflow", { workflowId: "weekly-summary" });
    expect(await screen.findByText("Weekly Summary created and run once.")).toBeInTheDocument();
  });

  it("create and run once asks for tool approval before running", async () => {
    const readyState = {
      ...backendState,
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    const savedWorkflow = {
      id: "weekly-summary-v1",
      workflow_id: "weekly-summary",
      version: 1,
      status: "enabled",
      approval_mode: "review_changes",
      definition: {
        schema_version: "0.1.0",
        id: "weekly-summary",
        name: "Weekly Summary",
        description: "Compiles weekly project highlights from git activity into a concise summary artifact.",
        permissions: ["git:read", "artifact:write", "llm:generate"],
        defaults: { llm_profile_ref: "default-openai", destination_ref: "local-app" },
        schedule: { cadence: "weekdays", local_time: "17:00" },
        steps: [
          {
            kind: "provider_action",
            id: "collect-git-logs",
            name: "Collect git logs",
            provider: "local_git",
            action: "recent_activity",
            depends_on: [],
            permissions: ["git:read"],
            inputs: { window: "week" },
          },
          {
            kind: "provider_action",
            id: "compose-summary",
            name: "Compose weekly summary",
            provider: "openai",
            action: "generate_artifact",
            depends_on: ["collect-git-logs"],
            permissions: ["llm:generate"],
            llm_profile_ref: "default-openai",
            inputs: { template: "weekly_summary", prompt: "$steps.collect-git-logs.summary" },
          },
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact locally",
            provider: "local_app",
            action: "write_artifact",
            depends_on: ["compose-summary"],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "$steps.compose-summary.artifact" },
          },
        ],
      },
      created_at: "2026-06-08T10:05:00Z",
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, any>) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "install_workflow_template") return savedWorkflow;
      if (command === "evaluate_workflow_preflight") {
        return {
          id: "preflight-weekly-summary",
          workflow_id: "weekly-summary",
          workflow_version: 1,
          registry_snapshot_hash: "snapshot",
          created_at: "2026-06-08T10:05:30Z",
          capabilities: [
            {
              capability_id: "agent.run_task",
              step_id: "compose-summary",
              policy_decision: "needs_grant",
              reason: "Agent execution needs pre-approval.",
              signature_hash: "agent-sig",
            },
          ],
          credentials: [],
          network_domains: [],
          file_reads: [],
          file_writes: [],
          overwrites: [],
          deletes: [],
          external_publishes: [],
          scoped_network_domains: [],
          scoped_network_resources: [],
          scoped_file_writes: [],
          scoped_overwrites: [],
          scoped_external_publishes: [],
          policy_recommendation: "safe_auto",
          blocking_items: [],
        };
      }
      if (command === "create_approval_grant") {
        return {
          ...args?.grant,
          approved_by_user_at: "2026-06-08T10:06:00Z",
          status: "active",
        };
      }
      if (command === "run_workflow") {
        return {
          duplicate: false,
          run: {
            id: "run-weekly-once",
            workflow_id: "weekly-summary",
            workflow_name: "Weekly Summary",
            status: "succeeded",
            started_at: "2026-06-08T10:06:00Z",
            completed_at: "2026-06-08T10:06:05Z",
            idempotency_key: "manual:weekly-summary:once",
          },
          artifact: null,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Start from template" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Weekly Summary" }));
    await userEvent.click(screen.getByRole("button", { name: "Create and run once" }));

    expect(await screen.findByText("Weekly Summary needs tool approval before running.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Approve tools before running" })).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command]) => command === "run_workflow")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Approve tools and run once" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "create_approval_grant",
        expect.objectContaining({
          grant: expect.objectContaining({
            capability_id: "agent.run_task",
            grant_type: "tool_execution",
          }),
        }),
      );
    });
    expect(invokeMock).toHaveBeenCalledWith("run_workflow", { workflowId: "weekly-summary" });
    expect(await screen.findByText("Weekly Summary created and run once.")).toBeInTheDocument();
  });

  it("does not run a newly created workflow when tool approval creation resolves as failed", async () => {
    const readyState = {
      ...backendState,
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    const savedWorkflow = {
      id: "weekly-summary-v1",
      workflow_id: "weekly-summary",
      version: 1,
      status: "enabled",
      approval_mode: "review_changes",
      definition: {
        schema_version: "0.1.0",
        id: "weekly-summary",
        name: "Weekly Summary",
        description: "Compiles weekly project highlights from git activity into a concise summary artifact.",
        permissions: ["git:read", "artifact:write", "llm:generate"],
        defaults: { llm_profile_ref: "default-openai", destination_ref: "local-app" },
        schedule: { cadence: "weekdays", local_time: "17:00" },
        steps: [
          {
            kind: "provider_action",
            id: "collect-git-logs",
            name: "Collect git logs",
            provider: "local_git",
            action: "recent_activity",
            depends_on: [],
            permissions: ["git:read"],
            inputs: { window: "week" },
          },
          {
            kind: "provider_action",
            id: "compose-summary",
            name: "Compose weekly summary",
            provider: "openai",
            action: "generate_artifact",
            depends_on: ["collect-git-logs"],
            permissions: ["llm:generate"],
            llm_profile_ref: "default-openai",
            inputs: { template: "weekly_summary", prompt: "$steps.collect-git-logs.summary" },
          },
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact locally",
            provider: "local_app",
            action: "write_artifact",
            depends_on: ["compose-summary"],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "$steps.compose-summary.artifact" },
          },
        ],
      },
      created_at: "2026-06-08T10:05:00Z",
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "install_workflow_template") return savedWorkflow;
      if (command === "evaluate_workflow_preflight") {
        return {
          id: "preflight-weekly-summary",
          workflow_id: "weekly-summary",
          workflow_version: 1,
          registry_snapshot_hash: "snapshot",
          created_at: "2026-06-08T10:05:30Z",
          capabilities: [
            {
              capability_id: "agent.run_task",
              step_id: "compose-summary",
              policy_decision: "needs_grant",
              reason: "Agent execution needs pre-approval.",
              signature_hash: "agent-sig",
            },
          ],
          credentials: [],
          network_domains: [],
          file_reads: [],
          file_writes: [],
          overwrites: [],
          deletes: [],
          external_publishes: [],
          scoped_network_domains: [],
          scoped_network_resources: [],
          scoped_file_writes: [],
          scoped_overwrites: [],
          scoped_external_publishes: [],
          policy_recommendation: "safe_auto",
          blocking_items: [],
        };
      }
      if (command === "create_approval_grant") {
        throw new Error("grant unavailable");
      }
      if (command === "run_workflow") {
        throw new Error("Run should not start after failed grant creation");
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Start from template" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Weekly Summary" }));
    await userEvent.click(screen.getByRole("button", { name: "Create and run once" }));
    await screen.findByText("Weekly Summary needs tool approval before running.");

    await userEvent.click(screen.getByRole("button", { name: "Approve tools and run once" }));

    expect(await screen.findByText("Workflow created, but approval or run failed: Approval grant failed")).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === "create_approval_grant")).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([command]) => command === "run_workflow")).toBe(false);
  });

  it("prevents duplicate save requests while persistence is in flight", async () => {
    let resolveInstall: (value: typeof persistedApprovedWorkflow) => void = () => {};
    const installPromise = new Promise<typeof persistedApprovedWorkflow>((resolve) => {
      resolveInstall = resolve;
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "install_workflow_template") return installPromise;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Start from template" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Current Weather" }));
    const saveDraft = screen.getByRole("button", { name: "Save as draft" });

    fireEvent.click(saveDraft);
    fireEvent.click(saveDraft);

    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([command]) => command === "install_workflow_template")).toHaveLength(1);
    });
    expect(saveDraft).toBeDisabled();
    resolveInstall(persistedApprovedWorkflow);
    expect(await screen.findByText(/saved as draft/i)).toBeInTheDocument();
  });

  it("prevents duplicate create-and-run requests while running is in flight", async () => {
    let resolveInstall: (value: unknown) => void = () => {};
    let resolveRun: (value: unknown) => void = () => {};
    const installPromise = new Promise((resolve) => {
      resolveInstall = resolve;
    });
    const runPromise = new Promise((resolve) => {
      resolveRun = resolve;
    });
    const readyState = {
      ...backendState,
      providers: [
        { id: "openai", name: "OpenAI", kind: "llm", status: "available", summary: "Ready." },
        { id: "local_app", name: "Local App Store", kind: "artifact_destination", status: "available", summary: "Ready." },
        { id: "local_git", name: "Local Git", kind: "context", status: "available", summary: "Ready." },
      ],
      agent_auth_profiles: backendState.agent_auth_profiles.map((profile) => ({
        ...profile,
        status: "available",
      })),
    };
    const savedWorkflow = {
      id: "weekly-summary-v1",
      workflow_id: "weekly-summary",
      version: 1,
      status: "enabled",
      approval_mode: "review_changes",
      definition: {
        schema_version: "0.1.0",
        id: "weekly-summary",
        name: "Weekly Summary",
        description: "Compiles weekly project highlights from git activity into a concise summary artifact.",
        permissions: ["git:read", "artifact:write", "llm:generate"],
        defaults: { llm_profile_ref: "default-openai", destination_ref: "local-app" },
        schedule: { cadence: "weekdays", local_time: "17:00" },
        steps: [
          {
            kind: "provider_action",
            id: "collect-git-logs",
            name: "Collect git logs",
            provider: "local_git",
            action: "recent_activity",
            depends_on: [],
            permissions: ["git:read"],
            inputs: { window: "week" },
          },
          {
            kind: "provider_action",
            id: "compose-summary",
            name: "Compose weekly summary",
            provider: "openai",
            action: "generate_artifact",
            depends_on: ["collect-git-logs"],
            permissions: ["llm:generate"],
            llm_profile_ref: "default-openai",
            inputs: { template: "weekly_summary", prompt: "$steps.collect-git-logs.summary" },
          },
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact locally",
            provider: "local_app",
            action: "write_artifact",
            depends_on: ["compose-summary"],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "$steps.compose-summary.artifact" },
          },
        ],
      },
      created_at: "2026-06-08T10:05:00Z",
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "install_workflow_template") return installPromise;
      if (command === "evaluate_workflow_preflight") {
        return {
          id: "preflight-weekly-summary",
          workflow_id: "weekly-summary",
          workflow_version: 1,
          registry_snapshot_hash: "snapshot",
          created_at: "2026-06-08T10:05:30Z",
          capabilities: [],
          credentials: [],
          network_domains: [],
          file_reads: [],
          file_writes: [],
          overwrites: [],
          deletes: [],
          external_publishes: [],
          scoped_network_domains: [],
          scoped_network_resources: [],
          scoped_file_writes: [],
          scoped_overwrites: [],
          scoped_external_publishes: [],
          policy_recommendation: "safe_auto",
          blocking_items: [],
        };
      }
      if (command === "run_workflow") return runPromise;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Start from template" }));
    await userEvent.click(screen.getByRole("button", { name: "Use template Weekly Summary" }));
    const runOnce = screen.getByRole("button", { name: "Create and run once" });

    fireEvent.click(runOnce);
    fireEvent.click(runOnce);

    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([command]) => command === "install_workflow_template")).toHaveLength(1);
    });
    expect(runOnce).toBeDisabled();
    resolveInstall(savedWorkflow);
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([command]) => command === "run_workflow")).toHaveLength(1);
    });
    fireEvent.click(runOnce);
    expect(invokeMock.mock.calls.filter(([command]) => command === "run_workflow")).toHaveLength(1);
    resolveRun({
      duplicate: false,
      run: {
        id: "run-weekly-once",
        workflow_id: "weekly-summary",
        workflow_name: "Weekly Summary",
        status: "succeeded",
        started_at: "2026-06-08T10:06:00Z",
        completed_at: "2026-06-08T10:06:05Z",
        idempotency_key: "manual:weekly-summary:once",
      },
      artifact: null,
    });
    expect(await screen.findByText("Weekly Summary created and run once.")).toBeInTheDocument();
  });

  it("Template Marketplace Review draft opens Create Hub draft review", async () => {
    render(<App />);

    const mainNavigation = screen.getByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Workflows" }));
    await userEvent.click(screen.getByRole("button", { name: "Browse templates" }));
    await userEvent.click(screen.getByRole("button", { name: "Review Weekly Summary draft" }));

    expect(screen.getByRole("dialog", { name: "Create workflow" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review draft" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Weekly Summary")).toBeInTheDocument();
    expect(screen.getByText("Template: Weekly Summary")).toBeInTheDocument();
  });

  it("Template Marketplace shows installed template update diff and opens the selected marketplace version", async () => {
    render(<App />);

    const mainNavigation = screen.getByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Workflows" }));
    await userEvent.click(screen.getByRole("button", { name: "Browse templates" }));

    const dailyCard = screen.getByText("Daily Work Journal").closest("article");
    expect(dailyCard).not.toBeNull();
    expect(within(dailyCard as HTMLElement).getByText("Update available")).toBeInTheDocument();
    expect(within(dailyCard as HTMLElement).getByText("Installed 1.0.0")).toBeInTheDocument();
    expect(within(dailyCard as HTMLElement).getByText("Marketplace 1.2.0")).toBeInTheDocument();
    expect(within(dailyCard as HTMLElement).getByText("Schedule changed")).toBeInTheDocument();
    expect(within(dailyCard as HTMLElement).getByText("Permissions changed")).toBeInTheDocument();

    await userEvent.click(within(dailyCard as HTMLElement).getByRole("button", { name: "Review Daily Work Journal update to version 1.2.0" }));

    expect(screen.getByRole("dialog", { name: "Create workflow" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review draft" })).toBeInTheDocument();
    expect(screen.getByText("Template: Daily Work Journal v1.2.0")).toBeInTheDocument();
  });

  it("Template Marketplace installs selected history versions and verifies community source metadata", async () => {
    render(<App />);

    const mainNavigation = screen.getByRole("navigation", { name: "Main navigation" });
    await userEvent.click(within(mainNavigation).getByRole("button", { name: "Workflows" }));
    await userEvent.click(screen.getByRole("button", { name: "Browse templates" }));

    const weeklyCard = screen.getByText("Weekly Summary").closest("article");
    expect(weeklyCard).not.toBeNull();
    await userEvent.selectOptions(
      within(weeklyCard as HTMLElement).getByLabelText("Weekly Summary version"),
      "1.0.0",
    );
    expect(within(weeklyCard as HTMLElement).getByText("Initial weekly git digest release.")).toBeInTheDocument();
    await userEvent.click(within(weeklyCard as HTMLElement).getByRole("button", { name: "Review Weekly Summary version 1.0.0 draft" }));
    expect(screen.getByText("Template: Weekly Summary v1.0.0")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close create hub" }));
    const topicCard = screen.getByText("Topic Research Report").closest("article");
    expect(topicCard).not.toBeNull();
    expect(within(topicCard as HTMLElement).getByText("Community")).toBeInTheDocument();
    expect(within(topicCard as HTMLElement).getByText("Multi-agent review required")).toBeInTheDocument();
    expect(within(topicCard as HTMLElement).getByText("Source review pending")).toBeInTheDocument();

    await userEvent.click(within(topicCard as HTMLElement).getByRole("button", { name: "Verify Topic Research Report source" }));

    expect(within(topicCard as HTMLElement).getByText("Source verified locally")).toBeInTheDocument();
    expect(localStorage.getItem("raven:marketplace-trust-reviews")).toContain("tpl-topic-research-report");
  });

  it("invalid generated draft review disables enable and run actions", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Import workflow" }));
    await userEvent.click(screen.getByLabelText("Workflow JSON"));
    await userEvent.paste(
      JSON.stringify({
        schemaVersion: "0.1.0",
        id: "generated-invalid",
        name: "Generated Invalid Draft",
        description: "Represents a generated draft that needs review.",
        permissions: ["llm:generate"],
        defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
        schedule: { cadence: "manual" },
        steps: [
          {
            kind: "provider_action",
            id: "compose",
            name: "Compose",
            provider: "missing_provider",
            action: "generate_artifact",
            dependsOn: [],
            permissions: ["llm:generate"],
            inputs: {},
          },
        ],
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Review imported workflow" }));

    expect(screen.getByRole("heading", { name: "Review draft" })).toBeInTheDocument();
    expect(screen.getByText("Step compose references unavailable provider missing_provider.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create enabled workflow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create and run once" })).toBeDisabled();
  });

  it("recent Create Hub drafts persist edited draft details and resume them", async () => {
    const prompt =
      "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42";
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "create_workflow_draft") {
        return {
          id: "draft-project-updates",
          prompt,
          summary: "Draft generated from prompt",
          permission_changes: ["data:read", "artifact:write", "llm:generate"],
          destination_writes: ["local-app"],
          diff_json: [],
          validation_status: "valid",
          approval_status: "needs_review",
          validation_errors: [],
          planner_rationale: {
            prompt,
            operations: [
              {
                id: "op-parse-csv",
                kind: "parse.csv",
                status: "covered",
                evidence: "Prompt mentions CSV parsing.",
                capability_id: "data.parse_csv",
                step_id: "parse-csv",
                inputs: {},
              },
              {
                id: "op-transform-project",
                kind: "transform.project",
                status: "covered",
                evidence: "Prompt requests projection.",
                capability_id: "data.transform_json",
                step_id: "transform-data",
                inputs: {},
              },
              {
                id: "op-summarize",
                kind: "synthesize.markdown_artifact",
                status: "agent_required",
                evidence: "Prompt requests final written output.",
                step_id: "summarize",
                inputs: {},
              },
            ],
            warnings: ["Agent synthesis is required for the final summary."],
          },
          definition: {
            schema_version: "0.1.0",
            id: "csv-report",
            name: "CSV Report",
            description: "Draft generated from prompt: parse CSV deterministically and summarize.",
            permissions: ["data:read", "llm:generate", "artifact:write"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "manual" },
            steps: [
              {
                kind: "provider_action",
                id: "parse-csv",
                name: "Parse CSV",
                provider: "data",
                action: "parse_csv",
                depends_on: [],
                permissions: ["data:read"],
                inputs: {
                  content: "name,status,revenue\nAcme,active,42",
                },
              },
              {
                kind: "provider_action",
                id: "transform-data",
                name: "Transform data",
                provider: "data",
                action: "transform_json",
                depends_on: ["parse-csv"],
                permissions: ["data:read"],
                inputs: {
                  data: "$steps.parse-csv.rows",
                  filter_equals: { status: "active" },
                  sort_by: "revenue",
                  select_fields: ["name", "revenue"],
                  limit: 5,
                },
              },
              {
                kind: "agent_task",
                id: "summarize",
                name: "Summarize",
                provider: "agent",
                action: "run_task",
                depends_on: ["transform-data"],
                permissions: ["llm:generate"],
                llm_profile_ref: "codex-oauth-local",
                inputs: {
                  objective: "Summarize the transformed CSV rows.",
                  output_schema: "artifact_envelope",
                  allowed_tools: [],
                },
              },
              {
                kind: "provider_action",
                id: "write-artifact",
                name: "Save artifact",
                provider: "local_app",
                action: "write_artifact",
                depends_on: ["summarize"],
                permissions: ["artifact:write"],
                destination_ref: "local-app",
                inputs: { artifact: "$steps.summarize.artifact" },
              },
            ],
          },
          created_at: "2026-06-21T10:00:00.000Z",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });
    const view = render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.click(screen.getByLabelText("Describe the workflow"));
    await userEvent.paste(prompt);
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));
    expect(screen.getByRole("heading", { name: "Review draft" })).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Workflow name"));
    await userEvent.type(screen.getByLabelText("Workflow name"), "Project Pulse Draft");
    expect(localStorage.getItem("raven:create-hub-recent-drafts")).toContain("Project Pulse Draft");

    await userEvent.click(screen.getByRole("button", { name: "Close create hub" }));
    view.unmount();

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));

    const recentDraft = screen.getByText("Project Pulse Draft").closest("article");
    expect(recentDraft).not.toBeNull();
    await userEvent.click(within(recentDraft as HTMLElement).getByRole("button", { name: "Resume" }));

    expect(screen.getByRole("button", { name: "Describe with Raven" })).toHaveAttribute("aria-pressed", "true");
    const promptField = screen.getByLabelText("Describe the workflow") as HTMLTextAreaElement;
    expect(promptField.value).toContain("Create a CSV report: parse this CSV");
    expect(promptField.value).toContain("Acme,active,42");
    expect(screen.getByRole("heading", { name: "Review draft" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Project Pulse Draft")).toBeInTheDocument();
    expect(screen.getByText("Draft generated from prompt")).toBeInTheDocument();
    expect(screen.getByText("Planner coverage")).toBeInTheDocument();
    expect(screen.getByText("data.parse_csv")).toBeInTheDocument();
    expect(screen.getByText("data.transform_json")).toBeInTheDocument();
    expect(screen.getByText("Agent synthesis is required for the final summary.")).toBeInTheDocument();

    await userEvent.click(within(recentDraft as HTMLElement).getByRole("button", { name: "Remove recent draft Project Pulse Draft" }));
    expect(localStorage.getItem("raven:create-hub-recent-drafts")).not.toContain("Project Pulse Draft");
  });

  it("closing Create Hub starts the next described workflow without previous draft context", async () => {
    const firstPrompt = "Create a CSV report from project status rows.";
    const secondPrompt = "Create a website uptime/status check for https://example.com.";
    const draftRequests: Record<string, unknown>[] = [];
    const draftFor = (prompt: string, id: string, name: string) => ({
      id: `draft-${id}`,
      prompt,
      summary: "Draft generated from prompt",
      permission_changes: ["artifact:write"],
      destination_writes: ["local-app"],
      diff_json: [],
      validation_status: "valid",
      approval_status: "needs_review",
      validation_errors: [],
      definition: {
        schema_version: "0.1.0",
        id,
        name,
        description: `${name} description.`,
        permissions: ["artifact:write"],
        defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
        schedule: { cadence: "manual" },
        steps: [
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact",
            provider: "local_app",
            action: "write_artifact",
            depends_on: [],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: name },
          },
        ],
      },
      created_at: "2026-06-21T10:00:00.000Z",
    });

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "create_workflow_draft") {
        draftRequests.push(args ?? {});
        return draftFor(
          String(args?.prompt ?? ""),
          draftRequests.length === 1 ? "csv-report" : "website-status",
          draftRequests.length === 1 ? "CSV Report" : "Website Status",
        );
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.type(screen.getByLabelText("Describe the workflow"), firstPrompt);
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));
    expect(await screen.findByDisplayValue("CSV Report")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close create hub" }));
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.type(screen.getByLabelText("Describe the workflow"), secondPrompt);
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));

    expect(await screen.findByDisplayValue("Website Status")).toBeInTheDocument();
    expect(draftRequests).toHaveLength(2);
    expect(draftRequests[0]).not.toHaveProperty("previousDraft");
    expect(draftRequests[1]).toEqual(expect.objectContaining({ prompt: secondPrompt }));
    expect(draftRequests[1]).not.toHaveProperty("previousDraft");
  });

  it("Describe with Raven generates website status drafts through the backend builder", async () => {
    const readyState = {
      ...backendState,
      providers: [
        {
          id: "local_app",
          name: "Local App Store",
          kind: "artifact_destination",
          status: "available",
          summary: "Ready.",
        },
      ],
    };
    const websiteDraft = {
      id: "draft-website-up",
      prompt: "Create a website uptime/status check for https://example.com",
      summary: "Checks website status with the deterministic HTTP probe.",
      permission_changes: ["network:read", "artifact:write"],
      destination_writes: ["local-app"],
      diff_json: [],
      validation_status: "valid",
      approval_status: "needs_review",
      validation_errors: [],
      definition: {
        schema_version: "0.1.0",
        id: "website-up",
        name: "Website Uptime",
        description: "Checks website status deterministically.",
        permissions: ["network:read", "artifact:write"],
        defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
        schedule: { cadence: "manual" },
        steps: [
          {
            kind: "provider_action",
            id: "check-sites",
            name: "Check sites",
            provider: "http_probe",
            action: "check_urls",
            depends_on: [],
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
            depends_on: ["check-sites"],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "$steps.check-sites.artifact" },
          },
        ],
      },
      created_at: "2026-06-21T10:00:00.000Z",
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "create_workflow_draft") return websiteDraft;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.type(
      screen.getByLabelText("Describe the workflow"),
      "Create a website uptime/status check for https://example.com",
    );
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));

    expect(invokeMock).toHaveBeenCalledWith(
      "create_workflow_draft",
      expect.objectContaining({
        prompt: "Create a website uptime/status check for https://example.com",
        builderProfileId: "codex-oauth-local",
      }),
    );
    expect(await screen.findByDisplayValue("Website Uptime")).toBeInTheDocument();
    expect(screen.queryByText(/Use deterministic provider http_probe\.check_urls/)).not.toBeInTheDocument();
  });

  it("sends the current draft as context when regenerating from feedback", async () => {
    const readyState = {
      ...backendState,
      providers: [
        {
          id: "local_app",
          name: "Local App Store",
          kind: "artifact_destination",
          status: "available",
          summary: "Ready.",
        },
      ],
    };
    const firstDraft = {
      id: "draft-project-pulse",
      prompt: "Create a project pulse workflow",
      summary: "Creates a project pulse report.",
      permission_changes: ["artifact:write"],
      destination_writes: ["local-app"],
      diff_json: [],
      validation_status: "valid",
      approval_status: "needs_review",
      validation_errors: [],
      definition: {
        schema_version: "0.1.0",
        id: "project-pulse",
        name: "Project Pulse",
        description: "Writes a local project pulse report.",
        permissions: ["artifact:write"],
        defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
        schedule: { cadence: "manual" },
        steps: [
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact",
            provider: "local_app",
            action: "write_artifact",
            depends_on: [],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "Project pulse" },
          },
        ],
      },
      created_at: "2026-06-21T10:00:00.000Z",
    };
    const revisedDraft = {
      ...firstDraft,
      id: "draft-project-pulse-revised",
      prompt: "Make the schedule weekdays at 4pm and keep the artifact sink.",
      summary: "Revises the existing project pulse report.",
      definition: {
        ...firstDraft.definition,
        description: "Writes a local project pulse report every weekday afternoon.",
        schedule: { cadence: "weekdays", local_time: "16:00" },
      },
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, any>) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "create_workflow_draft") {
        return args?.previousDraft ? revisedDraft : firstDraft;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.type(screen.getByLabelText("Describe the workflow"), firstDraft.prompt);
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));
    expect(await screen.findByDisplayValue("Project Pulse")).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("Describe the workflow"));
    await userEvent.type(
      screen.getByLabelText("Describe the workflow"),
      "Make the schedule weekdays at 4pm and keep the artifact sink.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));

    const draftCalls = invokeMock.mock.calls.filter(([command]) => command === "create_workflow_draft");
    expect(draftCalls).toHaveLength(2);
    expect(draftCalls[1][1]).toEqual(
      expect.objectContaining({
        prompt: "Make the schedule weekdays at 4pm and keep the artifact sink.",
        previousDraft: expect.objectContaining({
          source_label: "Creates a project pulse report.",
          definition: expect.objectContaining({
            id: "project-pulse",
            description: "Writes a local project pulse report.",
          }),
        }),
      }),
    );
    expect(await screen.findByDisplayValue("Project Pulse")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Writes a local project pulse report every weekday afternoon.")).toBeInTheDocument();
  });

  it("asks Raven for contextual improvements instead of mutating the draft locally", async () => {
    const readyState = {
      ...backendState,
      providers: [
        {
          id: "local_app",
          name: "Local App Store",
          kind: "artifact_destination",
          status: "available",
          summary: "Ready.",
        },
      ],
    };
    const firstDraft = {
      id: "draft-artifact-review",
      prompt: "Create an artifact review workflow",
      summary: "Creates an artifact review report.",
      permission_changes: ["artifact:write"],
      destination_writes: ["local-app"],
      diff_json: [],
      validation_status: "valid",
      approval_status: "needs_review",
      validation_errors: [],
      definition: {
        schema_version: "0.1.0",
        id: "artifact-review",
        name: "Artifact Review",
        description: "Writes a local artifact review.",
        permissions: ["artifact:write"],
        defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
        schedule: { cadence: "manual" },
        steps: [
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact",
            provider: "local_app",
            action: "write_artifact",
            depends_on: [],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "Artifact review" },
          },
        ],
      },
      created_at: "2026-06-21T10:00:00.000Z",
    };
    const improvedDraft = {
      ...firstDraft,
      id: "draft-artifact-review-improved",
      prompt: "Add traceability and review readiness.",
      summary: "Improves the artifact review workflow.",
      definition: {
        ...firstDraft.definition,
        description: "Writes a traceable artifact review with readiness checks.",
      },
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, any>) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "create_workflow_draft") {
        return args?.previousDraft ? improvedDraft : firstDraft;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.type(screen.getByLabelText("Describe the workflow"), firstDraft.prompt);
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));
    expect(await screen.findByDisplayValue("Artifact Review")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Ask Raven to improve this draft" }));

    const draftCalls = invokeMock.mock.calls.filter(([command]) => command === "create_workflow_draft");
    expect(draftCalls).toHaveLength(2);
    expect(draftCalls[1][1]).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("Improve this draft"),
        previousDraft: expect.objectContaining({
          source_label: "Creates an artifact review report.",
          definition: expect.objectContaining({
            id: "artifact-review",
            description: "Writes a local artifact review.",
          }),
        }),
      }),
    );
    expect(await screen.findByDisplayValue("Writes a traceable artifact review with readiness checks.")).toBeInTheDocument();
  });

  it("disables draft review actions while a revised draft is generating", async () => {
    const readyState = {
      ...backendState,
      providers: [
        {
          id: "local_app",
          name: "Local App Store",
          kind: "artifact_destination",
          status: "available",
          summary: "Ready.",
        },
      ],
    };
    const firstDraft = {
      id: "draft-slow-revision",
      prompt: "Create a slow revision workflow",
      summary: "Creates a slow revision report.",
      permission_changes: ["artifact:write"],
      destination_writes: ["local-app"],
      diff_json: [],
      validation_status: "valid",
      approval_status: "needs_review",
      validation_errors: [],
      definition: {
        schema_version: "0.1.0",
        id: "slow-revision",
        name: "Slow Revision",
        description: "Writes a local report.",
        permissions: ["artifact:write"],
        defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
        schedule: { cadence: "manual" },
        steps: [
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact",
            provider: "local_app",
            action: "write_artifact",
            depends_on: [],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "Slow revision" },
          },
        ],
      },
      created_at: "2026-06-21T10:00:00.000Z",
    };
    let resolveRevision: (value: typeof firstDraft) => void = () => {};
    const revisionPromise = new Promise<typeof firstDraft>((resolve) => {
      resolveRevision = resolve;
    });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, any>) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "create_workflow_draft") {
        return args?.previousDraft ? revisionPromise : firstDraft;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.type(screen.getByLabelText("Describe the workflow"), firstDraft.prompt);
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));
    expect(await screen.findByDisplayValue("Slow Revision")).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("Describe the workflow"));
    await userEvent.type(screen.getByLabelText("Describe the workflow"), "Make it safer.");
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));

    expect(screen.getByRole("button", { name: "Ask Raven to improve this draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create enabled workflow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create and run once" })).toBeDisabled();

    resolveRevision(firstDraft);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save as draft" })).toBeEnabled();
    });
  });

  it("warns and keeps run actions disabled when deterministic feedback makes no supported change", async () => {
    const readyState = {
      ...backendState,
      providers: [
        {
          id: "local_app",
          name: "Local App Store",
          kind: "artifact_destination",
          status: "available",
          summary: "Ready.",
        },
      ],
    };
    const firstDraft = {
      id: "draft-unchanged-revision",
      prompt: "Create a CSV report",
      summary: "Creates a CSV report.",
      permission_changes: ["artifact:write"],
      destination_writes: ["local-app"],
      diff_json: [],
      validation_status: "valid",
      approval_status: "needs_review",
      validation_errors: [],
      definition: {
        schema_version: "0.1.0",
        id: "unchanged-revision",
        name: "Unchanged Revision",
        description: "Writes a local report.",
        permissions: ["artifact:write"],
        defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
        schedule: { cadence: "manual" },
        steps: [
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact",
            provider: "local_app",
            action: "write_artifact",
            depends_on: [],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "Unchanged revision" },
          },
        ],
      },
      created_at: "2026-06-21T10:00:00.000Z",
    };
    const unchangedDraft = {
      ...firstDraft,
      id: "draft-unchanged-revision-feedback",
      prompt: "Make the chart blue and animated.",
      summary: "Deterministic revision kept the previous workflow draft because no supported deterministic edit was detected.",
      diff_json: [{ op: "deterministic_revision", workflow_id: "unchanged-revision", changed: false }],
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, any>) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "create_workflow_draft") {
        return args?.previousDraft ? unchangedDraft : firstDraft;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.type(screen.getByLabelText("Describe the workflow"), firstDraft.prompt);
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));
    expect(await screen.findByDisplayValue("Unchanged Revision")).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("Tell Raven what to improve"));
    await userEvent.type(screen.getByLabelText("Tell Raven what to improve"), "Make the chart blue and animated.");
    await userEvent.click(screen.getByRole("button", { name: "Ask Raven to improve this draft" }));

    expect(await screen.findByText("Raven kept the draft unchanged because that edit is not supported yet.")).toBeInTheDocument();
    expect(screen.getByLabelText("Tell Raven what to improve")).toHaveValue("Make the chart blue and animated.");
    expect(screen.getByRole("button", { name: "Create and run once" })).toBeDisabled();
  });

  it("Describe with Raven reviews catalog-planned deterministic provider actions", async () => {
    const readyState = {
      ...backendState,
      providers: [
        {
          id: "local_app",
          name: "Local App Store",
          kind: "artifact_destination",
          status: "available",
          summary: "Ready.",
        },
      ],
    };
    const catalogDraft = {
      id: "draft-weather-news",
      prompt: "Create a morning brief report that collects the next 24 hour Denver weather forecast and trending news, then summarizes the planning implications.",
      summary: "Collects deterministic weather and news before agent synthesis.",
      permission_changes: ["weather:read", "network:read", "llm:generate", "artifact:write"],
      destination_writes: ["local-app"],
      diff_json: [],
      validation_status: "valid",
      approval_status: "needs_review",
      validation_errors: [],
      definition: {
        schema_version: "0.1.0",
        id: "weather-news-brief",
        name: "Weather News Brief",
        description: "Collects deterministic weather and news data before writing a planning brief.",
        permissions: ["weather:read", "network:read", "llm:generate", "artifact:write"],
        defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
        schedule: { cadence: "manual" },
        steps: [
          {
            kind: "provider_action",
            id: "weather",
            name: "Fetch weather",
            provider: "weather",
            action: "forecast_24h",
            depends_on: [],
            permissions: ["weather:read"],
            inputs: { location: "Denver, CO", hours: 24 },
          },
          {
            kind: "provider_action",
            id: "news",
            name: "Fetch news",
            provider: "news",
            action: "trending",
            depends_on: [],
            permissions: ["network:read"],
            inputs: { max_items: 5 },
          },
          {
            kind: "agent_task",
            id: "summarize",
            name: "Summarize findings",
            provider: "agent",
            action: "run_task",
            depends_on: ["weather", "news"],
            permissions: ["llm:generate"],
            llm_profile_ref: "codex-oauth-local",
            inputs: {
              objective: "Summarize deterministic weather and news outputs.",
              output_schema: "artifact_envelope",
              allowed_tools: [],
            },
          },
          {
            kind: "provider_action",
            id: "write-artifact",
            name: "Save artifact",
            provider: "local_app",
            action: "write_artifact",
            depends_on: ["summarize"],
            permissions: ["artifact:write"],
            destination_ref: "local-app",
            inputs: { artifact: "$steps.summarize.artifact" },
          },
        ],
      },
      created_at: "2026-06-21T10:00:00.000Z",
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "create_workflow_draft") return catalogDraft;
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.click(screen.getByLabelText("Describe the workflow"));
    await userEvent.paste(catalogDraft.prompt);
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));

    const review = await screen.findByRole("complementary", { name: "Draft review" });
    expect(review).toHaveTextContent("Provider actions");
    expect(review).toHaveTextContent("weather.forecast_24h");
    expect(review).toHaveTextContent("news.trending");
    expect(review).toHaveTextContent("agent.run_task");
    expect(screen.getByRole("button", { name: "Create enabled workflow" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create and run once" })).toBeEnabled();
  });

  it("shows planner coverage in draft review when planner rationale is present", async () => {
    const readyState = {
      ...backendState,
      providers: [
        {
          id: "local_app",
          name: "Local App Store",
          kind: "artifact_destination",
          status: "available",
          summary: "Ready.",
        },
      ],
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return readyState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      if (command === "create_workflow_draft") {
        return {
          id: "draft-csv-summary",
          prompt: "parse csv and summarize",
          summary: "Draft generated from prompt",
          permission_changes: ["artifact:write"],
          destination_writes: ["local-app"],
          diff_json: [],
          validation_status: "valid",
          approval_status: "needs_review",
          validation_errors: [],
          planner_rationale: {
            prompt: "parse csv and summarize",
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
              {
                id: "op-summarize",
                kind: "synthesize.markdown_artifact",
                status: "agent_required",
                evidence: "Prompt requested a final summary.",
                step_id: "summarize",
                inputs: {},
              },
            ],
            warnings: ["Agent synthesis is required for the final summary."],
          },
          definition: {
            schema_version: "0.1.0",
            id: "csv-summary",
            name: "CSV Summary",
            description: "Parses CSV rows and summarizes them.",
            permissions: ["artifact:write"],
            defaults: { llm_profile_ref: "codex-oauth-local", destination_ref: "local-app" },
            schedule: { cadence: "manual" },
            steps: [
              {
                kind: "provider_action",
                id: "parse-csv",
                name: "Parse CSV",
                provider: "data",
                action: "parse_csv",
                depends_on: [],
                permissions: [],
                inputs: {},
              },
              {
                kind: "agent_task",
                id: "summarize",
                name: "Summarize",
                provider: "agent",
                action: "run_task",
                depends_on: ["parse-csv"],
                permissions: [],
                llm_profile_ref: "codex-oauth-local",
                inputs: {
                  objective: "Summarize parsed CSV rows.",
                  output_schema: "artifact_envelope",
                  allowed_tools: [],
                },
              },
            ],
          },
          created_at: "2026-06-21T10:00:00.000Z",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Describe with Raven" }));
    await userEvent.type(screen.getByLabelText("Describe the workflow"), "parse csv and summarize");
    await userEvent.click(screen.getByRole("button", { name: "Generate draft" }));

    const review = await screen.findByRole("complementary", { name: "Draft review" });
    expect(review).toHaveTextContent("Planner coverage");
    expect(review).toHaveTextContent("parse.csv");
    expect(review).toHaveTextContent("covered");
    expect(review).toHaveTextContent("data.parse_csv");
    expect(review).toHaveTextContent("parse-csv");
    expect(review).toHaveTextContent("Prompt requested CSV parsing.");
    expect(review).toHaveTextContent("Agent");
    expect(review).toHaveTextContent("Agent synthesis is required for the final summary.");
  });

  it("shows deterministic provider actions for the Site Health Check template", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_app_state") return backendState;
      if (command === "scheduler_status") {
        return { running: false, pollIntervalSeconds: 60 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    render(<App />);

    await screen.findAllByText("Daily Work Journal");
    await userEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await userEvent.click(screen.getByRole("button", { name: "Start from template" }));

    const siteHealthCard = screen.getByText("Site Health Check").closest("article");
    expect(siteHealthCard).not.toBeNull();
    expect(siteHealthCard).toHaveTextContent("http_probe.check_urls");
    expect(siteHealthCard).not.toHaveTextContent("using Agent (Codex or Claude)");

    await userEvent.click(screen.getByRole("button", { name: "Use template Site Health Check" }));
    const review = await screen.findByRole("complementary", { name: "Draft review" });
    expect(review).toHaveTextContent("Provider actions");
    expect(review).toHaveTextContent("http_probe.check_urls");
    expect(review).toHaveTextContent("agent.run_task");
    expect(review).not.toHaveTextContent("Planner coverage");
  });
});
