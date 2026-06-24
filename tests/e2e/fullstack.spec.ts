import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type BackendArtifact = {
  title?: string;
  workflow_run_id?: string;
  workflowRunId?: string;
  content_markdown?: string;
  contentMarkdown?: string;
};

type BackendState = {
  workflows?: Array<{
    workflow_id?: string;
    workflowId?: string;
    version?: number;
    status?: string;
    definition?: { id?: string; name?: string; steps?: Array<Record<string, unknown>> };
  }>;
  runs?: Array<{ id?: string; workflow_id?: string; workflowId?: string; status?: string }>;
  artifacts?: BackendArtifact[];
};

type BackendPreflightManifest = {
  workflow_version?: number;
  workflowVersion?: number;
  blocking_items?: Array<{
    step_id?: string;
    stepId?: string;
    capability_id?: string;
    capabilityId?: string;
    reason?: string;
  }>;
  blockingItems?: Array<{
    step_id?: string;
    stepId?: string;
    capability_id?: string;
    capabilityId?: string;
    reason?: string;
  }>;
  capabilities?: Array<{
    step_id?: string;
    stepId?: string;
    capability_id?: string;
    capabilityId?: string;
    policy_decision?: string;
    policyDecision?: string;
    signature_hash?: string;
    signatureHash?: string;
  }>;
  credentials?: Array<{
    step_id?: string;
    stepId?: string;
    capability_id?: string;
    capabilityId?: string;
    credential_ref?: string;
    credentialRef?: string;
  }>;
  deletes?: Array<{
    step_id?: string;
    stepId?: string;
    capability_id?: string;
    capabilityId?: string;
    path_pattern?: string;
    pathPattern?: string;
    max_deletes?: number;
    maxDeletes?: number;
  }>;
  scoped_file_writes?: Array<BackendScopedPreflightValue>;
  scopedFileWrites?: Array<BackendScopedPreflightValue>;
  scoped_overwrites?: Array<BackendScopedPreflightValue>;
  scopedOverwrites?: Array<BackendScopedPreflightValue>;
  scoped_network_domains?: Array<BackendScopedPreflightValue>;
  scopedNetworkDomains?: Array<BackendScopedPreflightValue>;
  scoped_network_resources?: Array<BackendScopedPreflightValue>;
  scopedNetworkResources?: Array<BackendScopedPreflightValue>;
  scoped_external_publishes?: Array<BackendScopedPreflightValue>;
  scopedExternalPublishes?: Array<BackendScopedPreflightValue>;
};

type BackendScopedPreflightValue = {
  step_id?: string;
  stepId?: string;
  capability_id?: string;
  capabilityId?: string;
  value?: string;
};

type BackendStepRun = {
  id?: string;
  step_id?: string;
  stepId?: string;
  completed_at?: string;
  completedAt?: string;
};

type BackendApproval = {
  id: string;
  run_id?: string;
  runId?: string;
  status?: string;
  risk_level?: string;
  riskLevel?: string;
  payload_at_decision?: string;
  payloadAtDecision?: string;
};

type BackendPluginManifest = {
  id?: string;
  version?: string;
  description?: string;
  steps?: Array<{
    display_name?: string;
    displayName?: string;
    input_schema?: unknown;
    inputSchema?: unknown;
    output_schema?: unknown;
    outputSchema?: unknown;
    provider?: string;
    action?: string;
    permissions?: string[];
    execution?: { command?: string; timeout_ms?: number; timeoutMs?: number };
  }>;
};

const backendUrl = () => {
  const value = process.env.RAVEN_E2E_BACKEND_URL?.replace(/\/+$/, "");
  expect(value, "RAVEN_E2E_BACKEND_URL must be set by the Playwright full-stack harness").toBeTruthy();
  return value;
};

const frontendUrl = () => {
  const value = process.env.RAVEN_E2E_FRONTEND_URL?.replace(/\/+$/, "");
  expect(value, "RAVEN_E2E_FRONTEND_URL must be set by the Playwright full-stack harness").toBeTruthy();
  return value;
};

async function backendCommand<T>(
  request: APIRequestContext,
  command: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  const response = await request.post(`${backendUrl()}/commands/${command}`, { data });
  const responseText = response.ok() ? "" : await response.text();
  expect(
    response.ok(),
    `${command} should return HTTP 2xx${responseText ? `: ${responseText}` : ""}`,
  ).toBe(true);
  return (await response.json()) as T;
}

async function getBackendState(request: APIRequestContext) {
  return backendCommand<BackendState>(request, "get_app_state");
}

function workflowById(state: BackendState, workflowId: string) {
  return state.workflows?.find(
    (workflow) => (workflow.workflow_id ?? workflow.workflowId) === workflowId,
  );
}

function scopedValuesFor(
  items: BackendScopedPreflightValue[] | undefined,
  stepId: string,
  capabilityId: string,
) {
  return [
    ...new Set(
      (items ?? [])
        .filter((item) =>
          (item.step_id ?? item.stepId) === stepId &&
          (item.capability_id ?? item.capabilityId) === capabilityId
        )
        .map((item) => String(item.value ?? ""))
        .filter(Boolean),
    ),
  ];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1a64(value: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function pluginCapabilitySignatureHash(plugin: BackendPluginManifest, step: NonNullable<BackendPluginManifest["steps"]>[number]) {
  const provider = String(step.provider ?? "");
  const action = String(step.action ?? "");
  const permissions = step.permissions ?? [];
  return fnv1a64(stableJson({
    id: `${provider}.${action}`,
    provider,
    action,
    source: "plugin",
    execution_mode: "open_agentic",
    read_only: false,
    idempotent: false,
    destructive: permissions.some((permission) =>
      permission.includes(":write") ||
      permission.includes(":delete") ||
      permission.includes(":publish"),
    ),
    open_world: true,
    requires_network: permissions.some((permission) => permission.includes("network:")),
    writes_files: permissions.some((permission) => permission.includes(":write")),
    requires_credentials: permissions.some((permission) =>
      permission.includes("credential") || permission.includes("auth"),
    ),
    permissions,
    input_schema: step.input_schema ?? step.inputSchema,
    output_schema: step.output_schema ?? step.outputSchema,
    adapter: {
      kind: "plugin",
      plugin_id: String(plugin.id ?? ""),
      step_action: action,
      timeout_ms: step.execution?.timeout_ms ?? step.execution?.timeoutMs ?? 10_000,
    },
  }));
}

async function seedPreflightGrants(request: APIRequestContext, workflowId: string) {
  const state = await getBackendState(request);
  const workflow = workflowById(state, workflowId);
  expect(workflow?.version, `${workflowId} version should exist before seeding grants`).toBeTruthy();
  const preflight = await backendCommand<BackendPreflightManifest>(
    request,
    "evaluate_workflow_preflight",
    {
      workflowId,
      version: workflow!.version,
      autonomyMode: "safe_auto",
    },
  );
  const scopedFileWrites = preflight.scoped_file_writes ?? preflight.scopedFileWrites ?? [];
  const scopedOverwrites = preflight.scoped_overwrites ?? preflight.scopedOverwrites ?? [];
  const scopedNetworkDomains = preflight.scoped_network_domains ?? preflight.scopedNetworkDomains ?? [];
  const scopedNetworkResources =
    preflight.scoped_network_resources ?? preflight.scopedNetworkResources ?? [];
  const scopedExternalPublishes =
    preflight.scoped_external_publishes ?? preflight.scopedExternalPublishes ?? [];
  const workflowVersion = preflight.workflow_version ?? preflight.workflowVersion ?? workflow!.version;
  const blankScope = () => ({
    credential_ref: null,
    paths: [] as string[],
    domains: [] as string[],
    resource_ids: [] as string[],
    max_deletes: null as number | null,
    max_overwrite_bytes: null as number | null,
    external_targets: [] as string[],
  });

  for (const capability of preflight.capabilities ?? []) {
    const policyDecision = capability.policy_decision ?? capability.policyDecision;
    if (policyDecision !== "needs_grant") continue;
    const stepId = String(capability.step_id ?? capability.stepId ?? "");
    const capabilityId = String(capability.capability_id ?? capability.capabilityId ?? "");
    const signatureHash = String(capability.signature_hash ?? capability.signatureHash ?? "");
    const grantBase = {
      workflow_id: workflowId,
      workflow_version: workflowVersion,
      capability_id: capabilityId,
      approved_by_user_at: new Date().toISOString(),
      expires_at: null,
      signature_hash: signatureHash,
      status: "active",
    };
    const createGrant = async (
      suffix: string,
      grantType: string,
      scope: ReturnType<typeof blankScope>,
    ) => {
      await backendCommand(request, "create_approval_grant", {
        grant: {
          id: `e2e-${workflowId}-${capabilityId}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
          ...grantBase,
          grant_type: grantType,
          scope,
        },
      });
    };

    const overwritePaths = scopedValuesFor(scopedOverwrites, stepId, capabilityId);
    if (overwritePaths.length > 0) {
      await createGrant("overwrite", "file_overwrite", {
        ...blankScope(),
        paths: overwritePaths,
        max_overwrite_bytes: 0,
      });
    }

    const writePaths = scopedValuesFor(scopedFileWrites, stepId, capabilityId);
    if (writePaths.length > 0) {
      await createGrant("write", "file_write", { ...blankScope(), paths: writePaths });
    }

    const domains = scopedValuesFor(scopedNetworkDomains, stepId, capabilityId);
    if (domains.length > 0) {
      await createGrant("network", "network_access", { ...blankScope(), domains });
    }
    const networkResources = scopedValuesFor(scopedNetworkResources, stepId, capabilityId);
    if (networkResources.length > 0) {
      await createGrant("network-resource", "network_access", {
        ...blankScope(),
        resource_ids: networkResources,
      });
    }

    const credential = (preflight.credentials ?? []).find(
      (item) =>
        (item.step_id ?? item.stepId) === stepId &&
        (item.capability_id ?? item.capabilityId) === capabilityId,
    );
    if (credential) {
      await createGrant("credential", "credential_use", {
        ...blankScope(),
        credential_ref: String(credential.credential_ref ?? credential.credentialRef ?? ""),
      });
    }

    const deletes = (preflight.deletes ?? []).filter(
      (item) =>
        (item.step_id ?? item.stepId) === stepId &&
        (item.capability_id ?? item.capabilityId) === capabilityId,
    );
    if (deletes.length > 0) {
      await createGrant("delete", "file_delete", {
        ...blankScope(),
        paths: deletes.map((item) => String(item.path_pattern ?? item.pathPattern ?? "")).filter(Boolean),
        max_deletes: deletes[0].max_deletes ?? deletes[0].maxDeletes ?? null,
      });
    }

    const externalTargets = scopedValuesFor(scopedExternalPublishes, stepId, capabilityId);
    if (externalTargets.length > 0) {
      await createGrant("publish", "external_publish", {
        ...blankScope(),
        external_targets: externalTargets,
      });
    }

    if (
      overwritePaths.length === 0 &&
      writePaths.length === 0 &&
      domains.length === 0 &&
      networkResources.length === 0 &&
      !credential &&
      deletes.length === 0 &&
      externalTargets.length === 0
    ) {
      await createGrant("tool", "tool_execution", blankScope());
    }
  }

  const blockingItems = preflight.blocking_items ?? preflight.blockingItems ?? [];
  if (blockingItems.length === 0) return;
  const plugins = await backendCommand<BackendPluginManifest[]>(request, "list_plugins");
  for (const item of blockingItems) {
    const capabilityId = String(item.capability_id ?? item.capabilityId ?? "");
    const plugin = plugins.find((candidate) =>
      candidate.steps?.some((step) => `${step.provider}.${step.action}` === capabilityId),
    );
    const pluginStep = plugin?.steps?.find((step) => `${step.provider}.${step.action}` === capabilityId);
    if (!plugin || !pluginStep) continue;
    await backendCommand(request, "create_approval_grant", {
      grant: {
        id: `e2e-${workflowId}-${capabilityId}-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
        workflow_id: workflowId,
        workflow_version: workflowVersion,
        capability_id: capabilityId,
        grant_type: "tool_execution",
        scope: blankScope(),
        approved_by_user_at: new Date().toISOString(),
        expires_at: null,
        signature_hash: pluginCapabilitySignatureHash(plugin, pluginStep),
        status: "active",
      },
    });
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function setWorkflowApprovalMode(
  request: APIRequestContext,
  workflowId: string,
  approvalMode: "always_review" | "review_changes" | "auto_approve",
  mutate?: (definition: Record<string, unknown>) => void,
) {
  const state = await getBackendState(request);
  const workflow = workflowById(state, workflowId);
  expect(workflow?.definition, `${workflowId} definition should exist`).toBeTruthy();
  const definition = structuredClone(workflow!.definition) as Record<string, unknown>;
  mutate?.(definition);
  return backendCommand(request, "create_workflow_version", {
    definition,
    status: "enabled",
    approvalMode,
  });
}

async function pendingApprovals(request: APIRequestContext) {
  return backendCommand<BackendApproval[]>(request, "list_pending_approvals");
}

async function resolveBackendApproval(
  request: APIRequestContext,
  id: string,
  decision: "approved" | "rejected",
  reason: string,
) {
  return backendCommand<BackendApproval | null>(request, "resolve_approval", {
    id,
    decision,
    reason,
  });
}

async function completeSetupBeforeLoad(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("raven:setup-complete", "true");
  });
}

async function openAppWithCompletedSetup(page: Page) {
  await completeSetupBeforeLoad(page);
  await page.goto(frontendUrl());
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
}

async function openPrimaryNav(page: Page, label: "Artifacts" | "Workflows") {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: label, exact: true })
    .click();
}

type OnboardingFixture =
  | "provider_auto_detection"
  | "ollama_unavailable"
  | "nestweaver_detected_needs_config"
  | "nestweaver_ready";

async function setOnboardingFixture(
  request: APIRequestContext,
  fixture: OnboardingFixture | null,
) {
  await backendCommand(request, "set_test_fixture", {
    onboardingFixture: fixture,
  });
}

async function startSetupWizard(page: Page) {
  await page.goto(frontendUrl());
  await expect(page.getByRole("heading", { name: "Welcome to Raven" })).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Connect AI provider" })).toBeVisible();
}

async function goToContextStep(page: Page) {
  await startSetupWizard(page);
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose context sources" })).toBeVisible();
}

async function goToReviewStep(
  page: Page,
  options: {
    approvalMode?: "Review changes" | "Always review" | "Auto approve";
    selectNestWeaver?: boolean;
    workflowName?: "Daily Work Journal" | "Morning Brief" | "Current Weather";
  } = {},
) {
  await startSetupWizard(page);
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose context sources" })).toBeVisible();
  if (options.selectNestWeaver) {
    await page.getByRole("checkbox", { name: "NestWeaver" }).check();
  }
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose output destination" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Set safety defaults" })).toBeVisible();
  if (options.approvalMode) {
    await page.getByRole("radio", { name: options.approvalMode }).check();
  }
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose/create first workflow" })).toBeVisible();
  await page.getByRole("button", {
    name: `Use template ${options.workflowName ?? "Daily Work Journal"}`,
  }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Review and optionally run sample" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
  await setOnboardingFixture(request, null);
});

test("app loads persisted state from the HTTP backend", async ({ page, request }) => {
  await seedPreflightGrants(request, "current-weather");
  const runResult = await backendCommand<{ artifact?: { title?: string } }>(
    request,
    "run_workflow",
    { workflowId: "current-weather" },
  );
  expect(runResult.artifact?.title).toContain("Current Weather");

  await openAppWithCompletedSetup(page);
  await openPrimaryNav(page, "Artifacts");

  await expect(
    page.locator(".artifact-list").getByRole("button", { name: /Current Weather/ }).first(),
  ).toBeVisible();

  const state = await getBackendState(request);
  expect(state.artifacts?.some((artifact) => artifact.title?.includes("Current Weather"))).toBe(true);
});

test("setup wizard-created workflow survives reload", async ({ page, request }) => {
  await page.goto(frontendUrl());

  await expect(page.getByRole("heading", { name: "Welcome to Raven" })).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Use template Daily Work Journal" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();

  await expect
    .poll(async () => workflowById(await getBackendState(request), "daily-work-journal")?.version ?? 0)
    .toBeGreaterThan(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  const state = await getBackendState(request);
  const workflow = workflowById(state, "daily-work-journal");
  expect(workflow?.status).toMatch(/^(draft|enabled)$/);
  expect(workflow?.version ?? 0).toBeGreaterThan(1);
});

test("fresh setup completion persists backend onboarding and avoids a duplicate welcome overlay", async ({
  page,
  request,
}) => {
  await page.goto(frontendUrl());

  await expect(page.getByRole("heading", { name: "Welcome to Raven" })).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Use template Daily Work Journal" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Welcome to Raven" })).toHaveCount(0);
  expect(await backendCommand<boolean>(request, "get_onboarding_completed")).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Welcome to Raven" })).toHaveCount(0);
});

test("provider step auto-detects Codex, Claude, and Ollama models without manual refresh", async ({
  page,
  request,
}) => {
  await setOnboardingFixture(request, "provider_auto_detection");
  await startSetupWizard(page);

  const openAiCard = page.locator(".provider-group-card").filter({
    has: page.getByRole("heading", { name: "OpenAI" }),
  });
  const anthropicCard = page.locator(".provider-group-card").filter({
    has: page.getByRole("heading", { name: "Anthropic" }),
  });
  const localAiCard = page.locator(".provider-group-card").filter({
    has: page.getByRole("heading", { name: "Local AI" }),
  });

  await expect(openAiCard).toContainText("Codex OAuth (local CLI)");
  await expect(openAiCard).toContainText("Ready");
  await expect(anthropicCard).toContainText("Claude Code OAuth (local CLI)");
  await expect(anthropicCard).toContainText("Ready");
  await expect(localAiCard).toContainText("Ollama 0.5.1 detected", { timeout: 15_000 });
  await expect(localAiCard.locator("#ollama-model-select")).toContainText("llama3.1:8b");
  await expect(localAiCard.locator("#ollama-model-select")).toContainText("qwen2.5-coder:7b");
});

test("provider step keeps Local AI not ready when Ollama is unavailable", async ({ page, request }) => {
  await setOnboardingFixture(request, "ollama_unavailable");
  await startSetupWizard(page);

  const localAiCard = page.locator(".provider-group-card").filter({
    has: page.getByRole("heading", { name: "Local AI" }),
  });

  await expect(localAiCard).toContainText("Ollama not running.");
  await expect(localAiCard.getByRole("link", { name: "Install Ollama" })).toBeVisible();
  await expect(localAiCard).toContainText("Setup required");
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
});

test("context step shows NestWeaver as detected but needing configuration", async ({
  page,
  request,
}) => {
  await setOnboardingFixture(request, "nestweaver_detected_needs_config");
  await goToContextStep(page);

  const nestWeaver = page.getByRole("checkbox", { name: "NestWeaver" });
  await expect(page.getByText("Detected, needs project configuration.")).toBeVisible();
  await expect(page.getByText("Local Git stays selected until NestWeaver is ready.")).toBeVisible();
  await expect(nestWeaver).toBeDisabled();
  await expect(nestWeaver).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Local git" })).toBeChecked();
});

test("context step lets a ready NestWeaver source be selected and summarized", async ({
  page,
  request,
}) => {
  await setOnboardingFixture(request, "nestweaver_ready");
  await startSetupWizard(page);
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose context sources" })).toBeVisible();

  const nestWeaver = page.getByRole("checkbox", { name: "NestWeaver" });
  await expect(nestWeaver).toBeEnabled();
  await nestWeaver.check();

  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Use template Daily Work Journal" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Review and optionally run sample" })).toBeVisible();
  await expect(page.getByText(/Local git, NestWeaver/)).toBeVisible();
});

test("onboarding sample waits for approval instead of creating a blocked run", async ({
  page,
  request,
}) => {
  await setOnboardingFixture(request, "provider_auto_detection");
  const initialState = await getBackendState(request);
  const initialRunCount =
    initialState.runs?.filter((run) => (run.workflow_id ?? run.workflowId) === "current-weather").length ?? 0;
  const initialBlockedCount =
    initialState.runs?.filter(
      (run) =>
        (run.workflow_id ?? run.workflowId) === "current-weather" &&
        run.status === "blocked",
    ).length ?? 0;

  await goToReviewStep(page, {
    approvalMode: "Auto approve",
    workflowName: "Current Weather",
  });
  await expect(page.getByText("Approval required before Raven can run a live sample.")).toBeVisible();
  await page.getByRole("checkbox", { name: "Run a sample after saving" }).check();
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Welcome to Raven" })).toHaveCount(0);
  await expect
    .poll(async () => {
      const state = await getBackendState(request);
      return {
        runCount:
          state.runs?.filter((run) => (run.workflow_id ?? run.workflowId) === "current-weather").length ?? 0,
        blockedCount:
          state.runs?.filter(
            (run) =>
              (run.workflow_id ?? run.workflowId) === "current-weather" &&
              run.status === "blocked",
          ).length ?? 0,
      };
    })
    .toEqual({
      runCount: initialRunCount,
      blockedCount: initialBlockedCount,
    });
});

test("approved onboarding sample succeeds and persists an artifact", async ({ page, request }) => {
  await setOnboardingFixture(request, "provider_auto_detection");
  const initialState = await getBackendState(request);
  const initialRunIds = new Set(
    (initialState.runs ?? [])
      .filter((run) => (run.workflow_id ?? run.workflowId) === "current-weather")
      .map((run) => run.id)
      .filter(Boolean),
  );

  await goToReviewStep(page, {
    approvalMode: "Auto approve",
    workflowName: "Current Weather",
  });
  await expect(page.getByText("Approval required before Raven can run a live sample.")).toBeVisible();
  await page.getByRole("button", { name: "Approve required access for a live sample" }).click();
  await page.getByRole("checkbox", { name: "Run a sample after saving" }).check();
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();

  await expect
    .poll(async () => {
      const state = await getBackendState(request);
      return (state.runs ?? []).some(
        (candidate) =>
          (candidate.workflow_id ?? candidate.workflowId) === "current-weather" &&
          candidate.status === "succeeded" &&
          !initialRunIds.has(candidate.id),
      );
    })
    .toBe(true);

  const state = await getBackendState(request);
  const succeededRun = (state.runs ?? []).find(
    (run) =>
      (run.workflow_id ?? run.workflowId) === "current-weather" &&
      run.status === "succeeded" &&
      !initialRunIds.has(run.id),
  );
  expect(succeededRun?.id).toBeTruthy();
  expect(succeededRun?.status).toBe("succeeded");
  expect(
    state.artifacts?.some(
      (artifact) =>
        (artifact.workflow_run_id ?? artifact.workflowRunId) === succeededRun?.id,
    ),
  ).toBe(true);
});

test("review_changes onboarding approval seeds the first live sample baseline", async ({ page, request }) => {
  await setOnboardingFixture(request, "provider_auto_detection");
  const initialState = await getBackendState(request);
  const initialRunIds = new Set(
    (initialState.runs ?? [])
      .filter((run) => (run.workflow_id ?? run.workflowId) === "current-weather")
      .map((run) => run.id)
      .filter(Boolean),
  );

  await goToReviewStep(page, {
    workflowName: "Current Weather",
  });
  await expect(page.getByText("Approval required before Raven can run a live sample.")).toBeVisible();
  await page.getByRole("button", { name: "Approve required access for a live sample" }).click();
  await page.getByRole("checkbox", { name: "Run a sample after saving" }).check();
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();

  await expect
    .poll(async () => {
      const state = await getBackendState(request);
      return {
        blocked: (state.runs ?? []).some(
          (candidate) =>
            (candidate.workflow_id ?? candidate.workflowId) === "current-weather" &&
            candidate.status === "blocked" &&
            !initialRunIds.has(candidate.id),
        ),
        succeeded: (state.runs ?? []).some(
          (candidate) =>
            (candidate.workflow_id ?? candidate.workflowId) === "current-weather" &&
            candidate.status === "succeeded" &&
            !initialRunIds.has(candidate.id),
        ),
      };
    })
    .toEqual({
      blocked: false,
      succeeded: true,
    });

  const state = await getBackendState(request);
  const succeededRun = (state.runs ?? []).find(
    (run) =>
      (run.workflow_id ?? run.workflowId) === "current-weather" &&
      run.status === "succeeded" &&
      !initialRunIds.has(run.id),
  );
  expect(succeededRun?.id).toBeTruthy();
  expect(
    state.artifacts?.some(
      (artifact) =>
        (artifact.workflow_run_id ?? artifact.workflowRunId) === succeededRun?.id,
    ),
  ).toBe(true);
});

test('skip path shows the onboarding checklist without reopening the welcome overlay', async ({
  page,
}) => {
  await page.goto(frontendUrl());
  await expect(page.getByRole("heading", { name: "Welcome to Raven" })).toBeVisible();
  await page.getByRole("button", { name: "I know what I'm doing" }).click();

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Finish the setup checklist" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Welcome to Raven" })).toHaveCount(0);
});

test("installed marketplace workflow survives reload", async ({ page, request }) => {
  await openAppWithCompletedSetup(page);
  await openPrimaryNav(page, "Workflows");
  await page.getByRole("button", { name: "Browse templates" }).click();
  await expect(page.getByRole("heading", { name: "Workflows / Templates" })).toBeVisible();

  await page.getByRole("button", { name: "Review Weekly Summary draft" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create workflow" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByRole("complementary", { name: "Draft review" })).toContainText(
    "Weekly Summary",
  );
  await createDialog.getByRole("button", { name: "Save as draft" }).click();
  await expect(createDialog).toContainText("Weekly Summary saved as draft.");

  await expect
    .poll(async () => Boolean(workflowById(await getBackendState(request), "weekly-summary")))
    .toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByText("Weekly Summary").first()).toBeVisible();
  expect(workflowById(await getBackendState(request), "weekly-summary")?.status).toMatch(
    /^(draft|enabled)$/,
  );
});

test("Create Workflow Hub describes catalog-planned deterministic tools", async ({ page }) => {
  await openAppWithCompletedSetup(page);

  await page.getByRole("button", { name: "Create workflow" }).click();
  await page.getByRole("button", { name: "Describe with Raven" }).click();
  await page.getByLabel("Describe the workflow").fill(
    "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42\nBeta,inactive,9",
  );
  await page.getByRole("button", { name: "Generate draft" }).click();

  const review = page.getByRole("complementary", { name: "Draft review" });
  const plannerCoverage = review.getByLabel("Planner coverage");
  await expect(review).toContainText("Provider actions");
  await expect(review).toContainText("data.parse_csv");
  await expect(review).toContainText("data.transform_json");
  await expect(review).toContainText("agent.run_task");
  await expect(plannerCoverage).toBeVisible();
  await expect(plannerCoverage).toContainText("Planner coverage");
  await expect(plannerCoverage).toContainText("data.parse_csv");
  await expect(plannerCoverage).toContainText("data.transform_json");
  await expect(plannerCoverage).toContainText("Agent");
  await expect(plannerCoverage).toContainText("Prompt mentions CSV parsing.");
  await expect(plannerCoverage).toContainText("Prompt requests final written output.");
  await expect(page.getByRole("button", { name: "Create enabled workflow" })).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Create and run once" })).toBeEnabled({ timeout: 15_000 });
});

test("Create Workflow Hub revises deterministic CSV drafts with previous draft context", async ({
  page,
  request,
}) => {
  await openAppWithCompletedSetup(page);

  const createDraftBodies: Record<string, unknown>[] = [];
  page.on("request", (browserRequest) => {
    if (
      browserRequest.method() === "POST" &&
      browserRequest.url().includes("/commands/create_workflow_draft")
    ) {
      const body = browserRequest.postData();
      if (body) createDraftBodies.push(JSON.parse(body) as Record<string, unknown>);
    }
  });

  await page.getByRole("button", { name: "Create workflow" }).click();
  await page.getByRole("button", { name: "Describe with Raven" }).click();
  await page.getByLabel("Describe the workflow").fill(
    "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
  );
  await page.getByRole("button", { name: "Generate draft" }).click();

  const createDialog = page.getByRole("dialog", { name: "Create workflow" });
  const review = createDialog.getByRole("complementary", { name: "Draft review" });
  await expect(review).toContainText("data.parse_csv");
  await expect(review).toContainText("data.transform_json");

  const revisionResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/commands/create_workflow_draft") &&
    response.request().method() === "POST" &&
    Boolean((response.request().postDataJSON() as Record<string, unknown> | null)?.previousDraft),
  );
  await createDialog.getByLabel("Tell Raven what to improve").fill(
    "Change the existing workflow to filter status=inactive instead. Keep the same CSV rows, selected fields, sorting, artifact destination, and deterministic provider steps.",
  );
  await createDialog.getByRole("button", { name: "Ask Raven to improve this draft" }).click();

  const revisionResponse = await revisionResponsePromise;
  const revisedDraft = await revisionResponse.json() as {
    definition: { id: string; steps: Array<Record<string, any>> };
  };
  const revisionRequest = createDraftBodies.find((body) => Boolean(body.previousDraft));
  expect(revisionRequest?.previousDraft).toBeTruthy();

  const parseCsv = revisedDraft.definition.steps.find(
    (step) => step.provider === "data" && step.action === "parse_csv",
  );
  const transform = revisedDraft.definition.steps.find(
    (step) => step.provider === "data" && step.action === "transform_json",
  );
  expect(parseCsv?.inputs?.content).toBe(
    "name,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
  );
  expect(transform?.inputs?.filter_equals).toEqual({ status: "inactive" });

  await createDialog.getByRole("button", { name: "Create and run once" }).click();
  await expect(createDialog).toContainText("needs tool approval before running.");
  await expect(
    createDialog.getByRole("region", { name: "Approve tools before running" }),
  ).toBeVisible();

  await expect
    .poll(async () => workflowById(await getBackendState(request), revisedDraft.definition.id)?.status)
    .toBe("enabled");

  let stateBeforeApproval = await getBackendState(request);
  expect(
    stateBeforeApproval.runs?.some(
      (run) => (run.workflow_id ?? run.workflowId) === revisedDraft.definition.id,
    ),
  ).toBe(false);

  await createDialog.getByRole("button", { name: "Approve tools and run once" }).click();
  await expect(createDialog).toContainText("created and run once.");
  await expect(page.getByRole("dialog", { name: /assistant/i })).toHaveCount(0);

  await expect
    .poll(
      async () => {
        const state = await getBackendState(request);
        return state.runs?.some(
          (run) =>
            (run.workflow_id ?? run.workflowId) === revisedDraft.definition.id &&
            run.status === "succeeded",
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const state = await getBackendState(request);
  const succeededRun = state.runs?.find(
    (run) =>
      (run.workflow_id ?? run.workflowId) === revisedDraft.definition.id &&
      run.status === "succeeded",
  );
  const artifact = state.artifacts?.find(
    (candidate) => (candidate.workflow_run_id ?? candidate.workflowRunId) === succeededRun?.id,
  ) as BackendArtifact | undefined;
  const content = artifact?.content_markdown ?? artifact?.contentMarkdown ?? "";
  expect(content).toContain("Beta");
  expect(content).not.toContain("Acme");
  expect(content).not.toContain("Zen");
});

test("Create Workflow Hub applies natural selected-field revision phrasing", async ({ page }) => {
  await openAppWithCompletedSetup(page);

  await page.getByRole("button", { name: "Create workflow" }).click();
  await page.getByRole("button", { name: "Describe with Raven" }).click();
  await page.getByLabel("Describe the workflow").fill(
    "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
  );
  await page.getByRole("button", { name: "Generate draft" }).click();

  const createDialog = page.getByRole("dialog", { name: "Create workflow" });
  await expect(createDialog.getByRole("complementary", { name: "Draft review" })).toContainText(
    "data.transform_json",
  );

  const revisionResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/commands/create_workflow_draft") &&
    response.request().method() === "POST" &&
    Boolean((response.request().postDataJSON() as Record<string, unknown> | null)?.previousDraft),
  );
  await createDialog.getByLabel("Tell Raven what to improve").fill(
    "Remove the filter. Change projected fields to name and status order by name descending limit 2. Rename workflow to Account Snapshot. Change description to Sorted account snapshot. Schedule it weekdays at 09:30. Focus on account status.",
  );
  await createDialog.getByRole("button", { name: "Ask Raven to improve this draft" }).click();

  const revisedDraft = await (await revisionResponsePromise).json() as {
    definition: {
      name: string;
      description: string;
      schedule?: { cadence?: string; local_time?: string; localTime?: string };
      steps: Array<Record<string, any>>;
    };
  };
  const parseCsv = revisedDraft.definition.steps.find(
    (step) => step.provider === "data" && step.action === "parse_csv",
  );
  const transform = revisedDraft.definition.steps.find(
    (step) => step.provider === "data" && step.action === "transform_json",
  );

  expect(parseCsv?.inputs?.content).toBe(
    "name,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
  );
  expect(transform?.inputs?.filter_equals).toBeUndefined();
  expect(transform?.inputs?.select_fields).toEqual(["name", "status"]);
  expect(transform?.inputs?.sort_by).toBe("name");
  expect(transform?.inputs?.sort_direction).toBe("desc");
  expect(transform?.inputs?.limit).toBe(2);
  expect(revisedDraft.definition.name).toBe("Account Snapshot");
  expect(revisedDraft.definition.description).toBe("Sorted account snapshot.");
  expect(revisedDraft.definition.schedule?.cadence).toBe("weekdays");
  expect(
    revisedDraft.definition.schedule?.local_time ?? revisedDraft.definition.schedule?.localTime,
  ).toBe("09:30");
});

test("workflow run creates a persisted artifact", async ({ page, request }) => {
  await seedPreflightGrants(request, "current-weather");
  await openAppWithCompletedSetup(page);

  await page.getByRole("button", { name: "Run now for Current Weather", exact: true }).click();

  await expect
    .poll(
      async () => {
        const state = await getBackendState(request);
        return state.artifacts?.some((artifact) => artifact.title?.includes("Current Weather")) ?? false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const state = await getBackendState(request);
  const currentWeatherWorkflow = workflowById(state, "current-weather");
  const currentWeatherSteps = currentWeatherWorkflow?.definition?.steps ?? [];
  const currentWeatherStepIds = new Set(currentWeatherSteps.map((step) => String(step.id)));
  const weatherRun = state.runs?.find(
    (run) => (run.workflow_id ?? run.workflowId) === "current-weather" && run.status === "succeeded",
  );
  expect(weatherRun?.id, "current weather run should be persisted").toBeTruthy();
  const stepRuns = await backendCommand<BackendStepRun[]>(request, "get_workflow_step_runs", {
    runId: weatherRun!.id,
  });
  const timedStep = stepRuns.find(
    (step) =>
      currentWeatherStepIds.has(String(step.step_id ?? step.stepId)) &&
      Boolean(step.completed_at ?? step.completedAt),
  );
  expect(timedStep, "completed workflow step timing should be persisted").toBeTruthy();
  const timedStepDefinition = currentWeatherSteps.find(
    (step) => String(step.id) === String(timedStep!.step_id ?? timedStep!.stepId),
  );
  const timedStepName = String(timedStepDefinition?.name ?? timedStep!.step_id ?? timedStep!.stepId);

  await openPrimaryNav(page, "Workflows");
  await page.getByRole("button", { name: "Open Current Weather details", exact: true }).click();
  await expect(
    page.getByText(new RegExp(`${escapeRegExp(timedStepName)}: \\d+(ms|\\.\\d+s)`)).first(),
  ).toBeVisible();

  await openPrimaryNav(page, "Artifacts");
  await expect(
    page.locator(".artifact-list").getByRole("button", { name: /Current Weather/ }).first(),
  ).toBeVisible();
});

test("configured artifact destinations write markdown and obsidian files", async ({ request }) => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "raven-fullstack-destinations-"));
  const markdownDir = path.join(baseDir, "markdown");
  const obsidianDir = path.join(baseDir, "obsidian");
  const state = await getBackendState(request);
  const weather = workflowById(state, "current-weather");
  expect(weather?.definition).toBeTruthy();

  await backendCommand(request, "configure_artifact_destination", {
    destinationId: "markdown_folder",
    folderPath: markdownDir,
  });
  await backendCommand(request, "configure_artifact_destination", {
    destinationId: "obsidian_vault",
    folderPath: obsidianDir,
  });

  const markdownDefinition = structuredClone(weather!.definition) as Record<string, unknown>;
  markdownDefinition.id = "markdown-destination-test";
  markdownDefinition.name = "Markdown Destination Test";
  markdownDefinition.defaults = {
    ...(markdownDefinition.defaults as Record<string, unknown>),
    destination_ref: "markdown_folder",
    destinationRef: undefined,
  };
  await backendCommand(request, "create_workflow_version", {
    definition: markdownDefinition,
    status: "enabled",
    approvalMode: "auto_approve",
  });
  await seedPreflightGrants(request, "markdown-destination-test");
  await backendCommand(request, "run_workflow", { workflowId: "markdown-destination-test" });

  const markdown = await readFile(
    path.join(markdownDir, "markdown-destination-test-test-artifact.md"),
    "utf8",
  );
  expect(markdown).toContain("# Markdown Destination Test");

  const obsidianDefinition = structuredClone(weather!.definition) as Record<string, unknown>;
  obsidianDefinition.id = "obsidian-destination-test";
  obsidianDefinition.name = "Obsidian Destination Test";
  obsidianDefinition.defaults = {
    ...(obsidianDefinition.defaults as Record<string, unknown>),
    destination_ref: "obsidian_vault",
    destinationRef: undefined,
  };
  await backendCommand(request, "create_workflow_version", {
    definition: obsidianDefinition,
    status: "enabled",
    approvalMode: "auto_approve",
  });
  await seedPreflightGrants(request, "obsidian-destination-test");
  await backendCommand(request, "run_workflow", { workflowId: "obsidian-destination-test" });

  const obsidian = await readFile(
    path.join(obsidianDir, "obsidian-destination-test-test-artifact.md"),
    "utf8",
  );
  expect(obsidian).toContain("---\ntitle: \"Obsidian Destination Test Test Artifact\"");
  expect(obsidian).toContain("source_refs:");
  expect(obsidian).toContain("# Obsidian Destination Test");
});

test("streamed deterministic workflow exposes trace event sequence", async ({ request }) => {
  await seedPreflightGrants(request, "current-weather");
  const streamed = await backendCommand<{
    result?: { run?: { status?: string } };
    events?: Array<{ kind?: string; token_count?: number; tokenCount?: number }>;
  }>(request, "run_workflow_streamed", { workflowId: "current-weather" });

  expect(streamed.result?.run?.status).toBe("succeeded");
  expect(streamed.events?.map((event) => event.kind)).toEqual([
    "RUN_STARTED",
    "STEP_STARTED",
    "THINKING_CONTENT",
    "TOOL_CALL_START",
    "TOOL_CALL_END",
    "STEP_FINISHED",
    "STEP_STARTED",
    "TEXT_MESSAGE_CONTENT",
    "STEP_FINISHED",
    "RUN_FINISHED",
  ]);
  expect(streamed.events?.at(-1)?.token_count ?? streamed.events?.at(-1)?.tokenCount).toBe(16);
});

test("plugin workflow validates and streams real plugin execution", async ({ request }) => {
  const plugins = await backendCommand<BackendPluginManifest[]>(request, "list_plugins");
  expect(plugins.some((plugin) => plugin.id === "deterministic_artifact")).toBe(true);

  await backendCommand(request, "create_workflow_version", {
    status: "enabled",
    approvalMode: "auto_approve",
    definition: {
      schema_version: "0.1.0",
      id: "plugin-fullstack-artifact",
      name: "Plugin Fullstack Artifact",
      description: "Builds an artifact through the deterministic plugin.",
      permissions: ["plugin:execute", "artifact:write"],
      defaults: {
        llm_profile_ref: "default-openai",
        destination_ref: "local-app",
      },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "build-artifact",
          name: "Build plugin artifact",
          provider: "deterministic_artifact",
          action: "build_artifact",
          depends_on: [],
          permissions: ["plugin:execute"],
          inputs: { subject: "Task 11" },
          llm_profile_ref: null,
          destination_ref: null,
          inline_code: null,
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save plugin artifact",
          provider: "local_app",
          action: "write_artifact",
          depends_on: ["build-artifact"],
          permissions: ["artifact:write"],
          destination_ref: "local-app",
          inputs: { artifact: "$steps.build-artifact.artifact" },
          llm_profile_ref: null,
          inline_code: null,
        },
      ],
    },
  });
  await seedPreflightGrants(request, "plugin-fullstack-artifact");

  const streamed = await backendCommand<{
    result?: { run?: { status?: string }; artifact?: BackendArtifact };
    events?: Array<{ kind?: string; tool_name?: string; toolName?: string }>;
  }>(request, "run_workflow_streamed", { workflowId: "plugin-fullstack-artifact" });

  expect(streamed.result?.run?.status).toBe("succeeded");
  expect(streamed.result?.artifact?.title).toBe("Plugin Artifact for Task 11");
  expect(
    streamed.result?.artifact?.content_markdown ?? streamed.result?.artifact?.contentMarkdown,
  ).toContain("deterministic plugin output");
  expect(streamed.events?.some((event) => event.kind === "TOOL_CALL_START")).toBe(true);
  expect(
    streamed.events?.some(
      (event) =>
        (event.tool_name ?? event.toolName) === "plugin.deterministic_artifact.build_artifact",
    ),
  ).toBe(true);
});

test("reload preserves backend state", async ({ page, request }) => {
  const stateBeforeReload = await getBackendState(request);
  expect(stateBeforeReload.artifacts?.some((artifact) => artifact.title?.includes("Current Weather"))).toBe(true);

  await openAppWithCompletedSetup(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await openPrimaryNav(page, "Artifacts");

  await expect(
    page.locator(".artifact-list").getByRole("button", { name: /Current Weather/ }).first(),
  ).toBeVisible();
});

test("always_review approval can be approved from the UI", async ({ page, request }) => {
  await setWorkflowApprovalMode(request, "current-weather", "always_review");
  await seedPreflightGrants(request, "current-weather");
  await openAppWithCompletedSetup(page);

  await page.getByRole("button", { name: "Run now for Current Weather", exact: true }).click();
  await expect(page.getByText(/paused .* waiting for approval/i)).toBeVisible();

  await page.getByRole("button", { name: "Open Raven assistant" }).click();
  await expect(page.getByText("Approval Required")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();

  await expect
    .poll(async () => {
      const state = await getBackendState(request);
      return state.artifacts?.filter((artifact) => artifact.title?.includes("Current Weather")).length ?? 0;
    })
    .toBeGreaterThan(0);
  await expect.poll(async () => (await pendingApprovals(request)).length).toBe(0);

  await setWorkflowApprovalMode(request, "current-weather", "auto_approve");
});

test("rejecting an approval stops the waiting run and duplicate resolve is stable", async ({
  request,
}) => {
  await setWorkflowApprovalMode(request, "current-weather", "always_review");
  await seedPreflightGrants(request, "current-weather");

  const runResult = await backendCommand<{ run?: { id?: string; status?: string }; artifact?: unknown }>(
    request,
    "run_workflow",
    { workflowId: "current-weather" },
  );
  expect(runResult.run?.status).toBe("blocked");
  expect(runResult.artifact).toBeFalsy();

  const approval = (await pendingApprovals(request))[0];
  expect(approval.id).toBeTruthy();
  const rejected = await resolveBackendApproval(request, approval.id, "rejected", "not approved");
  const rejectedAgain = await resolveBackendApproval(request, approval.id, "approved", "too late");

  expect(rejected?.status).toBe("rejected");
  expect(rejectedAgain?.status).toBe("rejected");
  const state = await getBackendState(request);
  const run = state.runs?.find((candidate) => candidate.id === runResult.run?.id);
  expect(run?.status).toBe("blocked");
  expect(
    state.artifacts?.some(
      (artifact) => (artifact.workflow_run_id ?? artifact.workflowRunId) === runResult.run?.id,
    ),
  ).toBe(false);

  await setWorkflowApprovalMode(request, "current-weather", "auto_approve");
});

test("review_changes requires approval once and again after definition changes", async ({
  request,
}) => {
  await setWorkflowApprovalMode(request, "current-weather", "review_changes", (definition) => {
    definition.description = `${String(definition.description)} Review baseline ${Date.now()}.`;
  });
  await seedPreflightGrants(request, "current-weather");

  const first = await backendCommand<{ run?: { status?: string } }>(request, "run_workflow", {
    workflowId: "current-weather",
  });
  expect(first.run?.status).toBe("blocked");
  let approval = (await pendingApprovals(request))[0];
  const approved = await resolveBackendApproval(request, approval.id, "approved", "baseline approved");
  expect(approved?.payload_at_decision ?? approved?.payloadAtDecision).toBeTruthy();

  const second = await backendCommand<{ run?: { status?: string } }>(request, "run_workflow", {
    workflowId: "current-weather",
  });
  expect(second.run?.status).toBe("succeeded");
  expect(await pendingApprovals(request)).toHaveLength(0);

  await setWorkflowApprovalMode(request, "current-weather", "review_changes", (definition) => {
    definition.description = `${String(definition.description)} Changed for approval policy test.`;
  });
  await seedPreflightGrants(request, "current-weather");
  const changed = await backendCommand<{ run?: { status?: string } }>(request, "run_workflow", {
    workflowId: "current-weather",
  });
  expect(changed.run?.status).toBe("blocked");
  approval = (await pendingApprovals(request))[0];
  expect(approval.id).toBeTruthy();
  await resolveBackendApproval(request, approval.id, "rejected", "cleanup");

  await setWorkflowApprovalMode(request, "current-weather", "auto_approve");
});

test("auto_approve runs normally but pauses explicit high risk actions", async ({ request }) => {
  await setWorkflowApprovalMode(request, "current-weather", "auto_approve");
  await seedPreflightGrants(request, "current-weather");

  const normal = await backendCommand<{ run?: { status?: string } }>(request, "run_workflow", {
    workflowId: "current-weather",
  });
  expect(normal.run?.status).toBe("succeeded");
  expect(await pendingApprovals(request)).toHaveLength(0);

  await setWorkflowApprovalMode(request, "current-weather", "auto_approve", (definition) => {
    const steps = definition.steps as Array<Record<string, unknown>>;
    steps[0].inputs = { ...(steps[0].inputs as Record<string, unknown>), risk_level: "high" };
  });
  await seedPreflightGrants(request, "current-weather");
  const highRisk = await backendCommand<{ run?: { status?: string } }>(request, "run_workflow", {
    workflowId: "current-weather",
  });
  expect(highRisk.run?.status).toBe("blocked");
  const approval = (await pendingApprovals(request))[0];
  expect(approval.risk_level ?? approval.riskLevel).toBe("high");
  await resolveBackendApproval(request, approval.id, "rejected", "cleanup");

  await setWorkflowApprovalMode(request, "current-weather", "auto_approve");
});

test("archived workflow state survives reload without losing run or artifact history", async ({
  page,
  request,
}) => {
  await seedPreflightGrants(request, "current-weather");
  await openAppWithCompletedSetup(page);

  await page.getByRole("button", { name: "Run now for Current Weather", exact: true }).click();
  await expect
    .poll(async () => {
      const state = await getBackendState(request);
      return state.artifacts?.some((artifact) => artifact.title?.includes("Current Weather")) ?? false;
    })
    .toBe(true);

  await page.getByRole("button", { name: "Open Current Weather details", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Archive workflow" }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();

  await expect
    .poll(async () => workflowById(await getBackendState(request), "current-weather")?.status)
    .toBe("disabled");
  const disabledRunResponse = await request.post(`${backendUrl()}/commands/run_workflow`, {
    data: { workflowId: "current-weather" },
  });
  expect(disabledRunResponse.ok()).toBe(false);

  const stateAfterArchive = await getBackendState(request);
  const runIds = new Set(
    stateAfterArchive.runs
      ?.filter((run) => (run.workflow_id ?? run.workflowId) === "current-weather")
      .map((run) => run.id)
      .filter(Boolean),
  );
  expect(runIds.size).toBeGreaterThan(0);
  expect(
    stateAfterArchive.artifacts?.some((artifact) =>
      runIds.has(artifact.workflow_run_id ?? artifact.workflowRunId),
    ),
  ).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now for Current Weather", exact: true })).toHaveCount(0);
  const stateAfterReload = await getBackendState(request);
  expect(workflowById(stateAfterReload, "current-weather")?.status).toBe("disabled");
  expect(
    stateAfterReload.artifacts?.some((artifact) =>
      runIds.has(artifact.workflow_run_id ?? artifact.workflowRunId),
    ),
  ).toBe(true);
});
