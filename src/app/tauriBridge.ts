import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentAuthProfile,
  AgentEvent,
  ApprovalGrant,
  ApprovalGrantDraft,
  ApprovalMode,
  ApprovalRequest,
  AppState,
  Artifact,
  AutonomyMode,
  CapabilityAuditEvent,
  CapabilityDescriptor,
  CapabilityRegistrySnapshot,
  RavenWorkflow,
  BuilderDraftEvent,
  ChatMessage,
  ContextPack,
  LlmProfile,
  OllamaModel,
  PlannerOperation,
  PlannerRationale,
  PluginManifest,
  PreflightManifest,
  ProviderAccount,
  ProviderHealth,
  RawToolInventoryItem,
  SchedulerStatus,
  SystemHealthDiagnostics,
  UsageCostAnomaly,
  UsagePricingCatalog,
  WorkflowDraft,
  WorkflowDraftRevisionContext,
  WorkflowRun,
  WorkflowRunResult,
  WorkflowScheduleOverride,
  WorkflowStepRun,
  WorkflowStepDefinition,
  WorkflowVersion,
} from "../domain/types";

type UnknownRecord = Record<string, unknown>;
const BUILDER_DRAFT_EVENT_NAME = "raven://builder-draft-event";

async function invokeBackend<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const backendUrl = import.meta.env.VITE_RAVEN_BACKEND_URL?.trim();
  if (!backendUrl) {
    return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
  }

  const response = await fetch(`${backendUrl.replace(/\/+$/, "")}/commands/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `HTTP backend command ${command} failed with ${response.status}${
        responseText ? `: ${responseText}` : ""
      }`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function loadPersistedAppState(): Promise<AppState | null> {
  try {
    return normalizeAppState(await invokeBackend("get_app_state"));
  } catch {
    return null;
  }
}

export async function createPersistedWorkflowDraft(
  prompt: string,
  builderProfileId?: string,
  onBuilderEvent?: (event: BuilderDraftEvent) => void,
  previousDraft?: WorkflowDraftRevisionContext,
): Promise<WorkflowDraft | null> {
  const requestId = crypto.randomUUID();
  let unlisten: (() => void) | undefined;
  try {
    const backendUrl = import.meta.env.VITE_RAVEN_BACKEND_URL?.trim();
    if (onBuilderEvent && !backendUrl) {
      unlisten = await listen(BUILDER_DRAFT_EVENT_NAME, (event) => {
        const builderEvent = normalizeBuilderDraftEvent(event.payload);
        if (builderEvent.requestId === requestId) {
          onBuilderEvent(builderEvent);
        }
      });
    }
    const payload: Record<string, unknown> = { prompt, builderProfileId, requestId };
    if (previousDraft) {
      payload.previousDraft = denormalizeWorkflowDraftRevisionContext(previousDraft);
    }
    return normalizeWorkflowDraft(
      await invokeBackend("create_workflow_draft", payload),
    );
  } catch {
    return null;
  } finally {
    unlisten?.();
  }
}

export async function approvePersistedWorkflowDraft(
  draft: WorkflowDraft,
): Promise<WorkflowVersion | null> {
  try {
    const approved = await invokeBackend("approve_workflow_draft", {
      draft: denormalizeWorkflowDraft(draft),
    });
    return normalizeWorkflowVersion(approved);
  } catch {
    return null;
  }
}

export async function installPersistedWorkflowTemplate(
  definition: RavenWorkflow,
  status: WorkflowVersion["status"],
  approvalMode?: string,
  plannerRationale?: PlannerRationale | null,
): Promise<WorkflowVersion | null> {
  try {
    const payload: Record<string, unknown> = {
      definition: denormalizeWorkflow(definition),
      status,
      approvalMode,
    };
    const denormalizedPlannerRationale = denormalizePlannerRationale(plannerRationale);
    if (denormalizedPlannerRationale) {
      payload.plannerRationale = denormalizedPlannerRationale;
    }
    return normalizeWorkflowVersion(
      await invokeBackend("install_workflow_template", payload),
    );
  } catch {
    return null;
  }
}

export async function createPersistedWorkflowVersion(
  definition: RavenWorkflow,
  status: WorkflowVersion["status"],
  approvalMode?: string,
  plannerRationale?: PlannerRationale | null,
): Promise<WorkflowVersion | null> {
  try {
    const payload: Record<string, unknown> = {
      definition: denormalizeWorkflow(definition),
      status,
      approvalMode,
    };
    const denormalizedPlannerRationale = denormalizePlannerRationale(plannerRationale);
    if (denormalizedPlannerRationale) {
      payload.plannerRationale = denormalizedPlannerRationale;
    }
    return normalizeWorkflowVersion(
      await invokeBackend("create_workflow_version", payload),
    );
  } catch {
    return null;
  }
}

export async function archivePersistedWorkflow(
  workflowId: string,
): Promise<WorkflowVersion | null> {
  try {
    return normalizeWorkflowVersion(await invokeBackend("archive_workflow", { workflowId }));
  } catch {
    return null;
  }
}

export async function updatePersistedWorkflowSafeFields(options: {
  workflowId: string;
  status: WorkflowVersion["status"];
  cadence: NonNullable<RavenWorkflow["schedule"]>["cadence"];
  localTime?: string;
  approvalMode?: string;
  llmProfileRef?: string;
}): Promise<WorkflowVersion | null> {
  try {
    return normalizeWorkflowVersion(
      await invokeBackend("update_workflow_safe_fields", {
        workflowId: options.workflowId,
        status: options.status,
        cadence: options.cadence,
        localTime: options.localTime,
        approvalMode: options.approvalMode,
        llmProfileRef: options.llmProfileRef,
      }),
    );
  } catch {
    return null;
  }
}

export async function runPersistedWorkflow(workflowId: string): Promise<WorkflowRunResult | null> {
  try {
    return normalizeRunResult(await invokeBackend("run_workflow", { workflowId }));
  } catch (error) {
    if (isTauriUnavailableError(error)) {
      return null;
    }
    throw error;
  }
}

export async function loadPersistedWorkflowStepRuns(runId: string): Promise<WorkflowStepRun[]> {
  try {
    return arrayOf(await invokeBackend("get_workflow_step_runs", { runId })).map(
      normalizeWorkflowStepRun,
    );
  } catch {
    return [];
  }
}

export async function detectTools(): Promise<RawToolInventoryItem[]> {
  try {
    return arrayOf(await invokeBackend("detect_tools")).map(normalizeRawToolInventoryItem);
  } catch {
    return [];
  }
}

export async function availableCapabilityCatalog(
  autonomyMode: AutonomyMode,
  categoryOverrides: Record<string, AutonomyMode> = {},
): Promise<CapabilityRegistrySnapshot> {
  return normalizeCapabilityRegistrySnapshot(
    await invokeBackend("available_capability_catalog", { autonomyMode, categoryOverrides }),
  );
}

export async function evaluateWorkflowPreflight(
  workflowId: string,
  version: number,
  autonomyMode: AutonomyMode = "safe_auto",
  categoryOverrides: Record<string, AutonomyMode> = {},
): Promise<PreflightManifest> {
  return normalizePreflightManifest(
    await invokeBackend("evaluate_workflow_preflight", { workflowId, version, autonomyMode, categoryOverrides }),
  );
}

export async function evaluateWorkflowDefinitionPreflight(
  definition: RavenWorkflow,
  version: number,
  autonomyMode: AutonomyMode = "safe_auto",
  categoryOverrides: Record<string, AutonomyMode> = {},
): Promise<PreflightManifest> {
  return normalizePreflightManifest(
    await invokeBackend("evaluate_workflow_definition_preflight", {
      definition: denormalizeWorkflow(definition),
      version,
      autonomyMode,
      categoryOverrides,
    }),
  );
}

export async function createApprovalGrant(
  grant: ApprovalGrantDraft,
): Promise<ApprovalGrant> {
  return normalizeApprovalGrant(
    await invokeBackend("create_approval_grant", { grant: denormalizeApprovalGrant(grant) }),
  );
}

export async function approveWorkflowSignatureBaseline(
  workflowId: string,
  workflowVersion: number,
): Promise<void> {
  await invokeBackend("approve_workflow_signature_baseline", { workflowId, workflowVersion });
}

export async function revokeApprovalGrant(id: string): Promise<void> {
  await invokeBackend("revoke_approval_grant", { id });
}

export async function listApprovalGrants(workflowId?: string): Promise<ApprovalGrant[]> {
  return arrayOf(await invokeBackend("list_approval_grants", { workflowId })).map(
    normalizeApprovalGrant,
  );
}

export async function listCapabilityAuditEvents(runId: string): Promise<CapabilityAuditEvent[]> {
  return arrayOf(await invokeBackend("list_capability_audit_events", { runId })).map(
    normalizeCapabilityAuditEvent,
  );
}

function isTauriUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Tauri unavailable") ||
    message.includes("__TAURI_INTERNALS__") ||
    message.includes("window.__TAURI__") ||
    message.includes("Cannot read properties of undefined (reading 'invoke')")
  );
}

export async function setPersistedBuilderProfile(profileId: string): Promise<boolean> {
  try {
    await invokeBackend("set_builder_profile", { profileId });
    return true;
  } catch {
    return false;
  }
}

export async function setPersistedAutonomyMode(mode: AutonomyMode): Promise<boolean> {
  try {
    await invokeBackend("set_autonomy_mode", { autonomyMode: mode });
    return true;
  } catch {
    return false;
  }
}

export async function setPersistedAutonomyCategoryOverrides(
  categoryOverrides: Record<string, AutonomyMode>,
): Promise<boolean> {
  try {
    await invokeBackend("set_autonomy_category_overrides", { categoryOverrides });
    return true;
  } catch {
    return false;
  }
}

export async function exportPersistedArtifact(
  artifactId: string,
  options: { destinationId?: string; destinationPath?: string },
): Promise<string | null> {
  try {
    const exportedPath = await invokeBackend("export_artifact", { artifactId, ...options });
    return typeof exportedPath === "string" ? exportedPath : null;
  } catch {
    return null;
  }
}

export async function regeneratePersistedArtifact(
  artifactId: string,
): Promise<WorkflowRunResult | null> {
  try {
    return normalizeRunResult(await invokeBackend("regenerate_artifact", { artifactId }));
  } catch {
    return null;
  }
}

export async function retryPersistedWorkflowRun(runId: string): Promise<WorkflowRunResult | null> {
  try {
    return normalizeRunResult(await invokeBackend("retry_workflow_run", { runId }));
  } catch {
    return null;
  }
}

export async function runPersistedDueSchedules(
  scheduleWindow: string,
  workflowIds?: string[],
): Promise<WorkflowRunResult[] | null> {
  try {
    const args: { scheduleWindow: string; workflowIds?: string[] } = { scheduleWindow };
    if (workflowIds) args.workflowIds = workflowIds;
    return arrayOf(await invokeBackend("run_scheduled_due_workflows", args)).map(normalizeRunResult);
  } catch {
    return null;
  }
}

export async function analyzePersistedUsageHistory(
  period: string,
  multiplier: number,
): Promise<UsageCostAnomaly | null> {
  try {
    return normalizeUsageCostAnomaly(
      await invokeBackend("analyze_usage_history", { period, multiplier }),
    );
  } catch {
    return null;
  }
}

export async function assignPersistedScheduleOverride(
  workflowId: string,
  originalRunAt: string,
  scheduledRunAt: string,
): Promise<WorkflowScheduleOverride | null> {
  try {
    return normalizeScheduleOverride(
      await invokeBackend("assign_schedule_override", {
        workflowId,
        originalRunAt,
        scheduledRunAt,
      }),
    );
  } catch {
    return null;
  }
}

export async function loadUsagePricingCatalog(): Promise<UsagePricingCatalog | null> {
  try {
    return normalizeUsagePricingCatalog(await invokeBackend("usage_pricing_catalog"));
  } catch {
    return null;
  }
}

export async function startPersistedScheduler(): Promise<boolean> {
  try {
    await invokeBackend("start_scheduler");
    return true;
  } catch {
    return false;
  }
}

export async function stopPersistedScheduler(): Promise<boolean> {
  try {
    await invokeBackend("stop_scheduler");
    return true;
  } catch {
    return false;
  }
}

export async function loadPersistedSchedulerStatus(): Promise<SchedulerStatus | null> {
  try {
    return normalizeSchedulerStatus(await invokeBackend("scheduler_status"));
  } catch {
    return null;
  }
}

export async function loadPersistedSystemHealthDiagnostics(): Promise<SystemHealthDiagnostics | null> {
  try {
    return normalizeSystemHealthDiagnostics(await invokeBackend("system_health_diagnostics"));
  } catch {
    return null;
  }
}

export async function generatePersistedArtifactPreview(workflowId: string): Promise<string | null> {
  try {
    const preview = await invokeBackend("generate_artifact_preview", { workflowId });
    return typeof preview === "string" ? preview : null;
  } catch {
    return null;
  }
}

export async function checkPersistedProviderReadiness(): Promise<ProviderHealth[]> {
  try {
    return arrayOf(await invokeBackend("check_provider_readiness")).map(normalizeProvider);
  } catch {
    return [];
  }
}

export async function configurePersistedProviderAccount(
  account: ProviderAccount,
  rawSecret: string,
): Promise<ProviderAccount | null> {
  try {
    return normalizeProviderAccount(
      await invokeBackend("configure_provider_account", {
        account: denormalizeProviderAccount(account),
        rawSecret,
      }),
    );
  } catch {
    return null;
  }
}

export async function configurePersistedArtifactDestination(
  destinationId: string,
  folderPath: string,
): Promise<boolean> {
  try {
    await invokeBackend("configure_artifact_destination", { destinationId, folderPath });
    return true;
  } catch {
    return false;
  }
}

export async function configurePersistedAiChatImportFolder(folderPath: string): Promise<boolean> {
  try {
    await invokeBackend("configure_ai_chat_import_folder", { folderPath });
    return true;
  } catch {
    return false;
  }
}

export async function scanPersistedAiChatImportFolder(): Promise<ContextPack | null> {
  try {
    return normalizeContextPack(await invokeBackend("scan_ai_chat_import_folder"));
  } catch {
    return null;
  }
}

export async function configurePersistedDocumentImportFolder(folderPath: string): Promise<boolean> {
  try {
    await invokeBackend("configure_document_import_folder", { folderPath });
    return true;
  } catch {
    return false;
  }
}

export async function scanPersistedDocumentImportFolder(): Promise<ContextPack | null> {
  try {
    return normalizeContextPack(await invokeBackend("scan_document_import_folder"));
  } catch {
    return null;
  }
}

export async function configurePersistedGithubContext(repoSlug: string): Promise<boolean> {
  try {
    await invokeBackend("configure_github_context", { repoSlug });
    return true;
  } catch {
    return false;
  }
}

export async function scanPersistedGithubContext(): Promise<ContextPack | null> {
  try {
    return normalizeContextPack(await invokeBackend("scan_github_context"));
  } catch {
    return null;
  }
}

export async function getSavedSettings(): Promise<Record<string, unknown> | null> {
  try {
    return await invokeBackend<Record<string, unknown>>("get_saved_settings");
  } catch {
    return null;
  }
}

export interface NestWeaverDetection {
  binary_path: string;
  db_path: string | null;
  projects: string[];
}

export async function detectNestWeaver(): Promise<NestWeaverDetection | null> {
  try {
    return await invokeBackend<NestWeaverDetection | null>("detect_nestweaver");
  } catch {
    return null;
  }
}

export async function configurePersistedNestWeaver(options: {
  binaryPath: string;
  dbPath?: string;
  project?: string;
  tokenBudget: number;
}): Promise<boolean> {
  try {
    await invokeBackend("configure_nestweaver", {
      binaryPath: options.binaryPath,
      dbPath: options.dbPath,
      project: options.project,
      tokenBudget: options.tokenBudget,
    });
    return true;
  } catch {
    return false;
  }
}

export async function indexPersistedNestWeaverProject(): Promise<ContextPack | null> {
  try {
    return normalizeContextPack(await invokeBackend("index_nestweaver_project"));
  } catch {
    return null;
  }
}

export async function getAppVersion(): Promise<string> {
  try {
    const version = await invokeBackend("app_version");
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function checkOllamaStatus(): Promise<string | null> {
  try {
    const version = await invokeBackend("ollama_status");
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export async function listOllamaModels(): Promise<OllamaModel[]> {
  try {
    const raw = arrayOf(await invokeBackend("ollama_models"));
    return raw.map((item) => {
      const r = asRecord(item);
      return {
        name: stringOf(r.name),
        size: numberOf(r.size),
        parameterSize: optionalString(r.parameter_size ?? r.parameterSize),
        quantizationLevel: optionalString(r.quantization_level ?? r.quantizationLevel),
      };
    });
  } catch {
    return [];
  }
}

export async function listPlugins(): Promise<PluginManifest[]> {
  try {
    const raw = arrayOf(await invokeBackend("list_plugins"));
    return raw.map((item) => {
      const r = asRecord(item);
      return {
        id: stringOf(r.id),
        name: stringOf(r.name),
        version: stringOf(r.version),
        description: stringOf(r.description),
        steps: arrayOf(r.steps).map((step) => {
          const s = asRecord(step);
          return {
            kind: stringOf(s.kind),
            provider: stringOf(s.provider),
            action: stringOf(s.action),
            displayName: stringOf(s.display_name ?? s.displayName),
            permissions: arrayOf(s.permissions).map(String),
            inputSchema: asOptionalRecord(s.input_schema ?? s.inputSchema),
            outputSchema: asOptionalRecord(s.output_schema ?? s.outputSchema),
            execution: normalizePluginExecution(s.execution),
          };
        }),
      };
    });
  } catch {
    return [];
  }
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizePluginExecution(value: unknown): PluginManifest["steps"][number]["execution"] {
  const record = asOptionalRecord(value);
  if (!record) return undefined;
  const envRecord = asOptionalRecord(record.env);
  const env = envRecord
    ? Object.fromEntries(
        Object.entries(envRecord)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : undefined;
  return {
    command: stringOf(record.command),
    args: arrayOf(record.args).map(String),
    env,
    timeoutMs:
      typeof (record.timeout_ms ?? record.timeoutMs) === "number"
        ? numberOf(record.timeout_ms ?? record.timeoutMs)
        : undefined,
  };
}

function normalizeAppState(value: unknown): AppState {
  const record = asRecord(value);
  const autonomyMode = stringOf(record.autonomy_mode ?? record.autonomyMode ?? "safe_auto") as AutonomyMode;
  return {
    theme: "aurora-dark",
    autonomyMode,
    autonomyCategoryOverrides: normalizeAutonomyCategoryOverrides(
      record.autonomy_category_overrides ?? record.autonomyCategoryOverrides,
    ),
    capabilityRegistry:
      record.capability_registry || record.capabilityRegistry
        ? normalizeCapabilityRegistrySnapshot(record.capability_registry ?? record.capabilityRegistry)
        : { hash: "", generatedAt: new Date().toISOString(), capabilities: [] },
    rawToolInventory: arrayOf(record.raw_tool_inventory ?? record.rawToolInventory).map(
      normalizeRawToolInventoryItem,
    ),
    approvalGrants: arrayOf(record.approval_grants ?? record.approvalGrants).map(normalizeApprovalGrant),
    workflows: arrayOf(record.workflows).map(normalizeWorkflowVersion),
    runs: arrayOf(record.runs).map(normalizeRun),
    artifacts: arrayOf(record.artifacts).map(normalizeArtifact),
    scheduleOverrides: arrayOf(record.schedule_overrides ?? record.scheduleOverrides).map(normalizeScheduleOverride),
    providers: arrayOf(record.providers).map(normalizeProvider),
    llmProfiles: arrayOf(record.llm_profiles ?? record.llmProfiles).map(normalizeLlmProfile),
    agentAuthProfiles: arrayOf(record.agent_auth_profiles ?? record.agentAuthProfiles).map(
      normalizeAgentAuthProfile,
    ),
    chatMessages: arrayOf(record.chat_messages ?? record.chatMessages).map(normalizeChatMessage),
  };
}

function normalizeAutonomyCategoryOverrides(value: unknown): Record<string, AutonomyMode> {
  const record = asOptionalRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, AutonomyMode] =>
      typeof entry[0] === "string" &&
      (entry[1] === "ask_first" ||
        entry[1] === "safe_auto" ||
        entry[1] === "workspace_auto" ||
        entry[1] === "power_auto"),
    ),
  );
}

function normalizeWorkflowVersion(value: unknown): WorkflowVersion {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    workflowId: stringOf(record.workflow_id ?? record.workflowId),
    version: numberOf(record.version),
    status: statusOf(record.status, "draft") as WorkflowVersion["status"],
    approvalMode: (record.approval_mode ?? record.approvalMode ?? "always_review") as ApprovalMode,
    plannerRationale: normalizePlannerRationale(
      record.planner_rationale ?? record.plannerRationale,
    ),
    definition: normalizeWorkflow(record.definition),
    createdAt: stringOf(record.created_at ?? record.createdAt),
  };
}

function normalizeRawToolAnnotations(value: unknown): RawToolInventoryItem["annotations"] {
  const record = asRecord(value);
  return {
    readOnlyHint: optionalBoolean(record.read_only_hint ?? record.readOnlyHint),
    destructiveHint: optionalBoolean(record.destructive_hint ?? record.destructiveHint),
    idempotentHint: optionalBoolean(record.idempotent_hint ?? record.idempotentHint),
    openWorldHint: optionalBoolean(record.open_world_hint ?? record.openWorldHint),
  };
}

function normalizeRawToolInventoryItem(value: unknown): RawToolInventoryItem {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    source: stringOf(record.source) as RawToolInventoryItem["source"],
    displayName: stringOf(record.display_name ?? record.displayName ?? record.label),
    binaryPath: optionalString(record.binary_path ?? record.binaryPath),
    version: optionalString(record.version),
    status: stringOf(record.status),
    authStatus: optionalString(record.auth_status ?? record.authStatus),
    operations: arrayOf(record.operations).map((operation) => {
      const operationRecord = asRecord(operation);
      return {
        name: stringOf(operationRecord.name),
        inputSchema: operationRecord.input_schema ?? operationRecord.inputSchema,
        outputSchema: operationRecord.output_schema ?? operationRecord.outputSchema,
        description: optionalString(operationRecord.description),
        annotations: normalizeRawToolAnnotations(operationRecord.annotations),
      };
    }),
    annotations: normalizeRawToolAnnotations(record.annotations),
    detectionErrors: arrayOf(record.detection_errors ?? record.detectionErrors).map(String),
    lastCheckedAt: stringOf(record.last_checked_at ?? record.lastCheckedAt ?? record.detected_at),
  };
}

function normalizeCapabilityDescriptor(
  value: unknown,
  policyDecision?: CapabilityDescriptor["policy"],
): CapabilityDescriptor {
  const record = asRecord(value);
  const policy = normalizeCapabilityPolicy(
    record.policy ?? record.policy_decision ?? record.policyDecision,
    stringOf(record.id),
  ) ?? policyDecision;
  return {
    id: stringOf(record.id),
    provider: stringOf(record.provider),
    action: stringOf(record.action),
    displayName: stringOf(record.display_name ?? record.displayName),
    description: stringOf(record.description),
    category: stringOf(record.category),
    source: stringOf(record.source) as CapabilityDescriptor["source"],
    detectedFrom: optionalString(record.detected_from ?? record.detectedFrom),
    rawToolId: optionalString(record.raw_tool_id ?? record.rawToolId),
    version: optionalString(record.version),
    status: stringOf(record.status) as CapabilityDescriptor["status"],
    executionMode: stringOf(record.execution_mode ?? record.executionMode) as CapabilityDescriptor["executionMode"],
    deterministic: Boolean(record.deterministic),
    readOnly: Boolean(record.read_only ?? record.readOnly),
    idempotent: Boolean(record.idempotent),
    destructive: Boolean(record.destructive),
    openWorld: Boolean(record.open_world ?? record.openWorld),
    requiresNetwork: Boolean(record.requires_network ?? record.requiresNetwork),
    writesFiles: Boolean(record.writes_files ?? record.writesFiles),
    requiresCredentials: Boolean(record.requires_credentials ?? record.requiresCredentials),
    permissions: arrayOf(record.permissions).map(String),
    operationTags: arrayOf(record.operation_tags ?? record.operationTags).map(String),
    intentTags: arrayOf(record.intent_tags ?? record.intentTags).map(String),
    bestFor: arrayOf(record.best_for ?? record.bestFor).map(String),
    notFor: arrayOf(record.not_for ?? record.notFor).map(String),
    builderGuidance: stringOf(record.builder_guidance ?? record.builderGuidance),
    fallbackStrategy: stringOf(record.fallback_strategy ?? record.fallbackStrategy),
    inputSchema: record.input_schema ?? record.inputSchema,
    outputSchema: record.output_schema ?? record.outputSchema,
    trustTier: stringOf(record.trust_tier ?? record.trustTier) as CapabilityDescriptor["trustTier"],
    defaultApproval: stringOf(record.default_approval ?? record.defaultApproval) as CapabilityDescriptor["defaultApproval"],
    adapter: normalizeCapabilityAdapter(record.adapter),
    signatureHash: stringOf(record.signature_hash ?? record.signatureHash),
    lastCheckedAt: optionalString(record.last_checked_at ?? record.lastCheckedAt),
    policy,
  };
}

function normalizeCapabilityPolicy(
  value: unknown,
  capabilityId?: string,
): CapabilityDescriptor["policy"] {
  const record = asRecord(value);
  const decision = stringOf(record.decision ?? record.policy_decision ?? record.policyDecision);
  const reason = stringOf(record.reason);
  if (!decision || !reason) return undefined;
  return {
    capabilityId: optionalString(record.capability_id ?? record.capabilityId) ?? capabilityId,
    decision: decision as NonNullable<CapabilityDescriptor["policy"]>["decision"],
    reason,
  };
}

function normalizeSnapshotPolicyDecision(value: unknown): CapabilityDescriptor["policy"] {
  return normalizeCapabilityPolicy(value);
}

function normalizeCapabilityAdapter(value: unknown): CapabilityDescriptor["adapter"] {
  const record = asRecord(value);
  const kind = stringOf(record.kind);
  if (kind === "cli") {
    return {
      kind,
      command: stringOf(record.command),
      argsTemplate: arrayOf(record.args_template ?? record.argsTemplate).map(String),
      timeoutMs: numberOf(record.timeout_ms ?? record.timeoutMs),
    };
  }
  if (kind === "mcp") {
    return {
      kind,
      serverId: stringOf(record.server_id ?? record.serverId),
      toolName: stringOf(record.tool_name ?? record.toolName),
      timeoutMs: numberOf(record.timeout_ms ?? record.timeoutMs),
    };
  }
  if (kind === "plugin") {
    return {
      kind,
      pluginId: stringOf(record.plugin_id ?? record.pluginId),
      stepAction: stringOf(record.step_action ?? record.stepAction),
      timeoutMs: numberOf(record.timeout_ms ?? record.timeoutMs),
    };
  }
  return {
    kind: "native",
    handler: stringOf(record.handler),
  };
}

function normalizeCapabilityRegistrySnapshot(value: unknown): CapabilityRegistrySnapshot {
  const record = asRecord(value);
  const policyDecisions = arrayOf(record.policy_decisions ?? record.policyDecisions)
    .map(normalizeSnapshotPolicyDecision)
    .filter((policy): policy is NonNullable<CapabilityDescriptor["policy"]> =>
      Boolean(policy?.capabilityId),
    );
  const policyByCapabilityId = new Map(
    policyDecisions.map((policy) => [policy.capabilityId, policy]),
  );
  return {
    hash: stringOf(record.hash),
    generatedAt: stringOf(record.generated_at ?? record.generatedAt),
    capabilities: arrayOf(record.capabilities).map((capability) => {
      const capabilityRecord = asRecord(capability);
      const capabilityId = stringOf(capabilityRecord.id);
      return normalizeCapabilityDescriptor(
        capability,
        capabilityId ? policyByCapabilityId.get(capabilityId) : undefined,
      );
    }),
    policyDecisions,
  };
}

function normalizePreflightManifest(value: unknown): PreflightManifest {
  const record = asRecord(value);
  const normalizeScopedUse = (item: unknown): PreflightManifest["scopedNetworkDomains"][number] => {
    const itemRecord = asRecord(item);
    return {
      stepId: stringOf(itemRecord.step_id ?? itemRecord.stepId),
      capabilityId: stringOf(itemRecord.capability_id ?? itemRecord.capabilityId),
      value: stringOf(itemRecord.value),
    };
  };
  return {
    id: stringOf(record.id),
    workflowId: stringOf(record.workflow_id ?? record.workflowId),
    workflowVersion: numberOf(record.workflow_version ?? record.workflowVersion),
    registrySnapshotHash: stringOf(record.registry_snapshot_hash ?? record.registrySnapshotHash),
    createdAt: stringOf(record.created_at ?? record.createdAt),
    capabilities: arrayOf(record.capabilities).map((capability) => {
      const capabilityRecord = asRecord(capability);
      return {
        capabilityId: stringOf(capabilityRecord.capability_id ?? capabilityRecord.capabilityId),
        stepId: stringOf(capabilityRecord.step_id ?? capabilityRecord.stepId),
        policyDecision: stringOf(capabilityRecord.policy_decision ?? capabilityRecord.policyDecision) as PreflightManifest["capabilities"][number]["policyDecision"],
        reason: stringOf(capabilityRecord.reason),
        signatureHash: stringOf(capabilityRecord.signature_hash ?? capabilityRecord.signatureHash),
      };
    }),
    credentials: arrayOf(record.credentials).map((credential) => {
      const credentialRecord = asRecord(credential);
      return {
        stepId: stringOf(credentialRecord.step_id ?? credentialRecord.stepId),
        capabilityId: stringOf(credentialRecord.capability_id ?? credentialRecord.capabilityId),
        credentialRef: stringOf(credentialRecord.credential_ref ?? credentialRecord.credentialRef),
      };
    }),
    networkDomains: arrayOf(record.network_domains ?? record.networkDomains).map(String),
    fileReads: arrayOf(record.file_reads ?? record.fileReads).map(String),
    fileWrites: arrayOf(record.file_writes ?? record.fileWrites).map(String),
    overwrites: arrayOf(record.overwrites).map(String),
    deletes: arrayOf(record.deletes).map((deleteUse) => {
      const deleteRecord = asRecord(deleteUse);
      return {
        stepId: stringOf(deleteRecord.step_id ?? deleteRecord.stepId),
        capabilityId: stringOf(deleteRecord.capability_id ?? deleteRecord.capabilityId),
        pathPattern: stringOf(deleteRecord.path_pattern ?? deleteRecord.pathPattern),
        maxDeletes: optionalNumber(deleteRecord.max_deletes ?? deleteRecord.maxDeletes),
      };
    }),
    externalPublishes: arrayOf(record.external_publishes ?? record.externalPublishes).map(String),
    scopedNetworkDomains: arrayOf(record.scoped_network_domains ?? record.scopedNetworkDomains).map(normalizeScopedUse),
    scopedNetworkResources: arrayOf(record.scoped_network_resources ?? record.scopedNetworkResources).map(normalizeScopedUse),
    scopedFileWrites: arrayOf(record.scoped_file_writes ?? record.scopedFileWrites).map(normalizeScopedUse),
    scopedOverwrites: arrayOf(record.scoped_overwrites ?? record.scopedOverwrites).map(normalizeScopedUse),
    scopedExternalPublishes: arrayOf(record.scoped_external_publishes ?? record.scopedExternalPublishes).map(normalizeScopedUse),
    policyRecommendation: stringOf(record.policy_recommendation ?? record.policyRecommendation) as PreflightManifest["policyRecommendation"],
    blockingItems: arrayOf(record.blocking_items ?? record.blockingItems).map((item) => {
      const itemRecord = asRecord(item);
      return {
        stepId: stringOf(itemRecord.step_id ?? itemRecord.stepId),
        capabilityId: stringOf(itemRecord.capability_id ?? itemRecord.capabilityId),
        reason: stringOf(itemRecord.reason),
      };
    }),
  };
}

function normalizeApprovalGrant(value: unknown): ApprovalGrant {
  const record = asRecord(value);
  const scope = asRecord(record.scope);
  return {
    id: stringOf(record.id),
    workflowId: stringOf(record.workflow_id ?? record.workflowId),
    workflowVersion: numberOf(record.workflow_version ?? record.workflowVersion),
    capabilityId: stringOf(record.capability_id ?? record.capabilityId),
    grantType: stringOf(record.grant_type ?? record.grantType) as ApprovalGrant["grantType"],
    scope: {
      credentialRef: optionalString(scope.credential_ref ?? scope.credentialRef),
      paths: arrayOf(scope.paths).map(String),
      domains: arrayOf(scope.domains).map(String),
      resourceIds: arrayOf(scope.resource_ids ?? scope.resourceIds).map(String),
      maxDeletes: optionalNumber(scope.max_deletes ?? scope.maxDeletes),
      maxOverwriteBytes: optionalNumber(scope.max_overwrite_bytes ?? scope.maxOverwriteBytes),
      externalTargets: arrayOf(scope.external_targets ?? scope.externalTargets).map(String),
    },
    approvedByUserAt: stringOf(record.approved_by_user_at ?? record.approvedByUserAt),
    expiresAt: optionalString(record.expires_at ?? record.expiresAt),
    signatureHash: stringOf(record.signature_hash ?? record.signatureHash),
    status: stringOf(record.status) as ApprovalGrant["status"],
  };
}

function normalizeCapabilityAuditEvent(value: unknown): CapabilityAuditEvent {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    runId: stringOf(record.run_id ?? record.runId),
    workflowId: stringOf(record.workflow_id ?? record.workflowId),
    workflowVersion: numberOf(record.workflow_version ?? record.workflowVersion),
    stepId: stringOf(record.step_id ?? record.stepId),
    capabilityId: stringOf(record.capability_id ?? record.capabilityId),
    decision: stringOf(record.decision) as CapabilityAuditEvent["decision"],
    reason: stringOf(record.reason),
    grantId: optionalString(record.grant_id ?? record.grantId),
    createdAt: stringOf(record.created_at ?? record.createdAt),
  };
}

function normalizeWorkflow(value: unknown): RavenWorkflow {
  const record = asRecord(value);
  const defaults = asRecord(record.defaults);
  const schedule = record.schedule ? asRecord(record.schedule) : undefined;
  return {
    schemaVersion: stringOf(record.schema_version ?? record.schemaVersion) as "0.1.0",
    id: stringOf(record.id),
    name: stringOf(record.name),
    description: stringOf(record.description),
    permissions: arrayOf(record.permissions).map(String),
    defaults: {
      llmProfileRef: stringOf(defaults.llm_profile_ref ?? defaults.llmProfileRef),
      destinationRef: stringOf(defaults.destination_ref ?? defaults.destinationRef),
    },
    schedule: schedule
      ? {
          cadence: stringOf(schedule.cadence) as RavenWorkflow["schedule"] extends infer T
            ? T extends { cadence: infer C }
              ? C
              : never
            : never,
          localTime: optionalString(schedule.local_time ?? schedule.localTime),
        }
      : undefined,
    steps: arrayOf(record.steps).map(normalizeStep),
  };
}

function normalizeStep(value: unknown): WorkflowStepDefinition {
  const record = asRecord(value);
  return {
    kind: stepKindOf(record.kind),
    id: stringOf(record.id),
    name: stringOf(record.name),
    provider: stringOf(record.provider),
    action: stringOf(record.action),
    dependsOn: arrayOf(record.depends_on ?? record.dependsOn).map(String),
    permissions: arrayOf(record.permissions).map(String),
    inputs: asRecord(record.inputs),
    llmProfileRef: optionalString(record.llm_profile_ref ?? record.llmProfileRef),
    destinationRef: optionalString(record.destination_ref ?? record.destinationRef),
    inlineCode: optionalString(record.inline_code ?? record.inlineCode),
    parallel: record.parallel === true ? true : undefined,
  };
}

function normalizeRun(value: unknown): WorkflowRun {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    workflowId: stringOf(record.workflow_id ?? record.workflowId),
    workflowName: stringOf(record.workflow_name ?? record.workflowName),
    status: statusOf(record.status, "failed") as WorkflowRun["status"],
    startedAt: stringOf(record.started_at ?? record.startedAt),
    completedAt: optionalString(record.completed_at ?? record.completedAt),
    failureReason: optionalString(record.failure_reason ?? record.failureReason),
    idempotencyKey: stringOf(record.idempotency_key ?? record.idempotencyKey),
    triggerKind: optionalString(record.trigger_kind ?? record.triggerKind),
    retryCount: numberOf(record.retry_count ?? record.retryCount),
    parentRunId: optionalString(record.parent_run_id ?? record.parentRunId),
    errorClassification: optionalString(record.error_classification ?? record.errorClassification),
    providerProfileId: optionalString(record.provider_profile_id ?? record.providerProfileId),
    blockedReason: optionalString(record.blocked_reason ?? record.blockedReason),
    requiredProviderId: optionalString(record.required_provider_id ?? record.requiredProviderId),
    requiredProfileId: optionalString(record.required_profile_id ?? record.requiredProfileId),
    setupAction: optionalString(record.setup_action ?? record.setupAction),
    totalTokens: record.total_tokens != null ? numberOf(record.total_tokens) : undefined,
    inputTokens: record.input_tokens != null ? numberOf(record.input_tokens) : undefined,
    outputTokens: record.output_tokens != null ? numberOf(record.output_tokens) : undefined,
    totalCostUsd: record.total_cost_usd != null ? numberOf(record.total_cost_usd) : undefined,
  };
}

function normalizeUsageCostAnomaly(value: unknown): UsageCostAnomaly {
  const record = asRecord(value);
  return {
    detected: record.detected === true,
    period: stringOf(record.period),
    multiplier: numberOf(record.multiplier),
    currentWindowLabel: stringOf(record.current_window_label ?? record.currentWindowLabel),
    baselineWindowLabel: stringOf(record.baseline_window_label ?? record.baselineWindowLabel),
    currentAverageDailyUsd: numberOf(record.current_average_daily_usd ?? record.currentAverageDailyUsd),
    baselineAverageDailyUsd: numberOf(record.baseline_average_daily_usd ?? record.baselineAverageDailyUsd),
    currentRunCount: numberOf(record.current_run_count ?? record.currentRunCount),
    baselineRunCount: numberOf(record.baseline_run_count ?? record.baselineRunCount),
    baselineDays: numberOf(record.baseline_days ?? record.baselineDays),
    source: stringOf(record.source),
  };
}

function normalizeScheduleOverride(value: unknown): WorkflowScheduleOverride {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    workflowId: stringOf(record.workflow_id ?? record.workflowId),
    originalRunAt: stringOf(record.original_run_at ?? record.originalRunAt),
    scheduledRunAt: stringOf(record.scheduled_run_at ?? record.scheduledRunAt),
    createdAt: stringOf(record.created_at ?? record.createdAt),
  };
}

function normalizeUsagePricingCatalog(value: unknown): UsagePricingCatalog {
  const record = asRecord(value);
  return {
    source: stringOf(record.source),
    version: stringOf(record.version),
    fetchedAt: stringOf(record.fetched_at ?? record.fetchedAt),
    loadedAt: stringOf(record.loaded_at ?? record.loadedAt),
    entries: arrayOf(record.entries).map((entry) => {
      const entryRecord = asRecord(entry);
      return {
        providerId: stringOf(entryRecord.provider_id ?? entryRecord.providerId),
        model: stringOf(entryRecord.model),
        aliases: arrayOf(entryRecord.aliases).map(String),
        inputUsdPerMillionTokens: numberOf(
          entryRecord.input_usd_per_million_tokens ?? entryRecord.inputUsdPerMillionTokens,
        ),
        outputUsdPerMillionTokens: numberOf(
          entryRecord.output_usd_per_million_tokens ?? entryRecord.outputUsdPerMillionTokens,
        ),
        contextWindowTokens: numberOf(
          entryRecord.context_window_tokens ?? entryRecord.contextWindowTokens,
        ),
      };
    }),
  };
}

function normalizeWorkflowStepRun(value: unknown): WorkflowStepRun {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    workflowRunId: stringOf(record.workflow_run_id ?? record.workflowRunId),
    stepId: stringOf(record.step_id ?? record.stepId),
    status: statusOf(record.status, "failed") as WorkflowStepRun["status"],
    outputJson: record.output_json ?? record.outputJson,
    error: optionalString(record.error),
    startedAt: stringOf(record.started_at ?? record.startedAt),
    completedAt: optionalString(record.completed_at ?? record.completedAt),
  };
}

function normalizeSchedulerStatus(value: unknown): SchedulerStatus {
  const record = asRecord(value);
  return {
    running: Boolean(record.running),
    pollIntervalSeconds: numberOf(record.poll_interval_seconds ?? record.pollIntervalSeconds),
  };
}

function normalizeSystemHealthDiagnostics(value: unknown): SystemHealthDiagnostics {
  const record = asRecord(value);
  const providers = asRecord(record.providers);
  const destinations = asRecord(record.destinations);
  const workflows = asRecord(record.workflows);
  const runs = asRecord(record.runs);
  const plugins = asRecord(record.plugins);
  return {
    generatedAt: stringOf(record.generated_at ?? record.generatedAt),
    status: stringOf(record.status) || "warning",
    issueCount: numberOf(record.issue_count ?? record.issueCount),
    scheduler: normalizeSchedulerStatus(record.scheduler),
    providers: {
      total: numberOf(providers.total),
      available: numberOf(providers.available),
      degraded: numberOf(providers.degraded),
      needsConfig: numberOf(providers.needs_config ?? providers.needsConfig),
      unavailable: numberOf(providers.unavailable),
    },
    destinations: {
      total: numberOf(destinations.total),
      ready: numberOf(destinations.ready),
      needsConfig: numberOf(destinations.needs_config ?? destinations.needsConfig),
      unavailable: numberOf(destinations.unavailable),
    },
    workflows: {
      total: numberOf(workflows.total),
      enabled: numberOf(workflows.enabled),
      draft: numberOf(workflows.draft),
      disabled: numberOf(workflows.disabled),
      invalid: numberOf(workflows.invalid),
      blockingIssues: numberOf(workflows.blocking_issues ?? workflows.blockingIssues),
    },
    runs: {
      total: numberOf(runs.total),
      failed: numberOf(runs.failed),
      retryable: numberOf(runs.retryable),
      blocked: numberOf(runs.blocked),
      running: numberOf(runs.running),
    },
    plugins: {
      installed: numberOf(plugins.installed),
      availableSteps: numberOf(plugins.available_steps ?? plugins.availableSteps),
    },
  };
}

function normalizeArtifact(value: unknown): Artifact {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    title: stringOf(record.title),
    type: stringOf(record.artifact_type ?? record.type) as Artifact["type"],
    workflowRunId: stringOf(record.workflow_run_id ?? record.workflowRunId),
    contentMarkdown: stringOf(record.content_markdown ?? record.contentMarkdown),
    metadata: asRecord(record.metadata),
    sourceRefs: arrayOf(record.source_refs ?? record.sourceRefs).map(String),
    createdAt: stringOf(record.created_at ?? record.createdAt),
  };
}

function normalizeProvider(value: unknown): ProviderHealth {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    name: stringOf(record.name),
    kind: stringOf(record.kind) as ProviderHealth["kind"],
    status: statusOf(record.status, "needs_config") as ProviderHealth["status"],
    summary: stringOf(record.summary),
    fallbackProviderId: optionalString(record.fallback_provider_id ?? record.fallbackProviderId),
  };
}

function normalizeProviderAccount(value: unknown): ProviderAccount {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    providerKind: stringOf(record.provider_kind ?? record.providerKind) as ProviderAccount["providerKind"],
    displayName: stringOf(record.display_name ?? record.displayName),
    credentialRef: stringOf(record.credential_ref ?? record.credentialRef),
    settingsJson: asRecord(record.settings_json ?? record.settingsJson),
  };
}

function normalizeContextPack(value: unknown): ContextPack {
  const record = asRecord(value);
  return {
    summary: stringOf(record.summary),
    sourceRefs: arrayOf(record.source_refs ?? record.sourceRefs).map(String),
  };
}

function normalizeLlmProfile(value: unknown): LlmProfile {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    providerId: stringOf(record.provider_id ?? record.providerId),
    model: stringOf(record.model),
    effort: stringOf(record.effort) as LlmProfile["effort"],
    supportsStructuredOutputs: Boolean(
      record.supports_structured_outputs ?? record.supportsStructuredOutputs,
    ),
  };
}

function normalizeAgentAuthProfile(value: unknown): AgentAuthProfile {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    displayName: stringOf(record.display_name ?? record.displayName),
    runnerKind: stringOf(record.runner_kind ?? record.runnerKind) as AgentAuthProfile["runnerKind"],
    authMode: stringOf(record.auth_mode ?? record.authMode) as AgentAuthProfile["authMode"],
    credentialRef: stringOf(record.credential_ref ?? record.credentialRef),
    model: stringOf(record.model),
    effort: stringOf(record.effort) as AgentAuthProfile["effort"],
    status: statusOf(record.status, "needs_config") as AgentAuthProfile["status"],
    summary: stringOf(record.summary),
  };
}

function normalizeChatMessage(value: unknown): ChatMessage {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    role: stringOf(record.role) as ChatMessage["role"],
    content: stringOf(record.content),
    createdAt: stringOf(record.created_at ?? record.createdAt),
  };
}

function normalizeWorkflowDraft(value: unknown): WorkflowDraft {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    prompt: stringOf(record.prompt),
    summary: stringOf(record.summary),
    permissionChanges: arrayOf(record.permission_changes ?? record.permissionChanges).map(String),
    destinationWrites: arrayOf(record.destination_writes ?? record.destinationWrites).map(String),
    diffJson: record.diff_json ?? record.diffJson ?? [],
    validationStatus: statusOf(record.validation_status ?? record.validationStatus, "invalid") as
      | "valid"
      | "invalid",
    approvalStatus: statusOf(record.approval_status ?? record.approvalStatus, "needs_review") as
      | "draft"
      | "needs_review"
      | "approved"
      | "rejected"
      | "superseded",
    builderProfileId: optionalString(record.builder_profile_id ?? record.builderProfileId),
    approvalMode: optionalString(record.approval_mode ?? record.approvalMode) as
      | WorkflowDraft["approvalMode"]
      | undefined,
    validationErrors: arrayOf(record.validation_errors ?? record.validationErrors).map(String),
    plannerRationale: normalizePlannerRationale(
      record.planner_rationale ?? record.plannerRationale,
    ),
    definition: normalizeWorkflow(record.definition),
    createdAt: stringOf(record.created_at ?? record.createdAt),
  };
}

function normalizePlannerRationale(value: unknown): PlannerRationale | undefined {
  if (!value) {
    return undefined;
  }
  const record = asRecord(value);
  return {
    prompt: stringOf(record.prompt),
    operations: arrayOf(record.operations).map(normalizePlannerOperation),
    warnings: arrayOf(record.warnings).map(String),
  };
}

function normalizePlannerOperation(value: unknown): PlannerOperation {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    kind: stringOf(record.kind),
    status: statusOf(record.status, "requested") as PlannerOperation["status"],
    evidence: stringOf(record.evidence),
    capabilityId: optionalString(record.capability_id ?? record.capabilityId) ?? null,
    capability_id: optionalString(record.capability_id ?? record.capabilityId) ?? null,
    stepId: optionalString(record.step_id ?? record.stepId) ?? null,
    step_id: optionalString(record.step_id ?? record.stepId) ?? null,
    inputs: record.inputs ?? {},
  };
}

function normalizeBuilderDraftEvent(value: unknown): BuilderDraftEvent {
  const record = asRecord(value);
  return {
    requestId: stringOf(record.request_id ?? record.requestId),
    phase: statusOf(record.phase, "thinking") as BuilderDraftEvent["phase"],
    stepId: stringOf(record.step_id ?? record.stepId),
    status: statusOf(record.status, "pending") as BuilderDraftEvent["status"],
    title: stringOf(record.title),
    detail: stringOf(record.detail),
    emittedAt: stringOf(record.emitted_at ?? record.emittedAt),
    eventKind: optionalString(record.event_kind ?? record.eventKind),
    delta: optionalString(record.delta),
    rawEventType: optionalString(record.raw_event_type ?? record.rawEventType),
  };
}

function normalizeRunResult(value: unknown): WorkflowRunResult {
  const record = asRecord(value);
  return {
    run: normalizeRun(record.run),
    artifact: record.artifact ? normalizeArtifact(record.artifact) : undefined,
    duplicate: Boolean(record.duplicate),
  };
}

function denormalizeWorkflowDraft(draft: WorkflowDraft) {
  return {
    id: draft.id,
    prompt: draft.prompt,
    summary: draft.summary,
    permission_changes: draft.permissionChanges,
    destination_writes: draft.destinationWrites,
    diff_json: draft.diffJson,
    validation_status: draft.validationStatus,
    approval_status: draft.approvalStatus,
    builder_profile_id: draft.builderProfileId,
    approval_mode: draft.approvalMode,
    validation_errors: draft.validationErrors,
    planner_rationale: denormalizePlannerRationale(
      draft.plannerRationale ?? draft.planner_rationale,
    ),
    definition: denormalizeWorkflow(draft.definition),
    created_at: draft.createdAt,
  };
}

function denormalizeWorkflowDraftRevisionContext(draft: WorkflowDraftRevisionContext) {
  return {
    source_label: draft.sourceLabel,
    validation_errors: draft.validationErrors,
    planner_rationale: denormalizePlannerRationale(draft.plannerRationale),
    definition: denormalizeWorkflow(draft.definition),
  };
}

function denormalizePlannerRationale(rationale: PlannerRationale | null | undefined) {
  if (!rationale) {
    return undefined;
  }
  return {
    prompt: rationale.prompt,
    operations: rationale.operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      evidence: operation.evidence,
      capability_id: operation.capabilityId ?? operation.capability_id ?? null,
      step_id: operation.stepId ?? operation.step_id ?? null,
      inputs: operation.inputs,
    })),
    warnings: rationale.warnings,
  };
}

function denormalizeProviderAccount(account: ProviderAccount) {
  return {
    id: account.id,
    provider_kind: account.providerKind,
    display_name: account.displayName,
    credential_ref: account.credentialRef,
    settings_json: account.settingsJson,
  };
}

function denormalizeApprovalGrant(grant: ApprovalGrantDraft) {
  return {
    id: grant.id,
    workflow_id: grant.workflowId,
    workflow_version: grant.workflowVersion,
    capability_id: grant.capabilityId,
    grant_type: grant.grantType,
    scope: {
      credential_ref: grant.scope.credentialRef,
      paths: grant.scope.paths,
      domains: grant.scope.domains,
      resource_ids: grant.scope.resourceIds,
      max_deletes: grant.scope.maxDeletes,
      max_overwrite_bytes: grant.scope.maxOverwriteBytes,
      external_targets: grant.scope.externalTargets,
    },
    approved_by_user_at: grant.approvedByUserAt,
    expires_at: grant.expiresAt,
    signature_hash: grant.signatureHash,
    status: grant.status,
  };
}

function denormalizeWorkflow(workflow: RavenWorkflow) {
  return {
    schema_version: workflow.schemaVersion,
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    permissions: workflow.permissions,
    defaults: {
      llm_profile_ref: workflow.defaults.llmProfileRef,
      destination_ref: workflow.defaults.destinationRef,
    },
    schedule: workflow.schedule
      ? {
          cadence: workflow.schedule.cadence,
          local_time: workflow.schedule.localTime,
        }
      : undefined,
    steps: workflow.steps.map((step) => ({
      kind: step.kind,
      id: step.id,
      name: step.name,
      provider: step.provider,
      action: step.action,
      depends_on: step.dependsOn,
      permissions: step.permissions,
      inputs: step.inputs,
      llm_profile_ref: step.llmProfileRef,
      destination_ref: step.destinationRef,
      inline_code: step.inlineCode,
      parallel: step.parallel,
    })),
  };
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return value == null ? undefined : numberOf(value);
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

function statusOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stepKindOf(value: unknown): WorkflowStepDefinition["kind"] {
  return value === "agent_task" || value === "provider_action" ? value : "provider_action";
}

export function normalizeAgentEvent(value: unknown): AgentEvent {
  const record = asRecord(value);
  return {
    kind: stringOf(record.kind) as AgentEvent["kind"],
    runId: stringOf(record.run_id ?? record.runId),
    stepId: optionalString(record.step_id ?? record.stepId),
    threadId: optionalString(record.thread_id ?? record.threadId),
    toolCallId: optionalString(record.tool_call_id ?? record.toolCallId),
    approvalId: optionalString(record.approval_id ?? record.approvalId),
    workflowName: optionalString(record.workflow_name ?? record.workflowName),
    stepName: optionalString(record.step_name ?? record.stepName),
    toolName: optionalString(record.tool_name ?? record.toolName),
    delta: optionalString(record.delta),
    content: optionalString(record.content),
    args:
      record.args && typeof record.args === "object"
        ? (record.args as Record<string, unknown>)
        : undefined,
    result: optionalString(record.result),
    error: optionalString(record.error),
    classification: optionalString(record.classification),
    description: optionalString(record.description),
    riskLevel: optionalString(record.risk_level ?? record.riskLevel),
    artifactId: optionalString(record.artifact_id ?? record.artifactId),
    durationMs:
      record.duration_ms != null
        ? numberOf(record.duration_ms)
        : record.durationMs != null
          ? numberOf(record.durationMs)
          : undefined,
    tokenCount:
      record.token_count != null
        ? numberOf(record.token_count)
        : record.tokenCount != null
          ? numberOf(record.tokenCount)
          : undefined,
    estimatedCostUsd:
      record.estimated_cost_usd != null
        ? numberOf(record.estimated_cost_usd)
        : record.estimatedCostUsd != null
          ? numberOf(record.estimatedCostUsd)
          : undefined,
    timestamp: stringOf(record.timestamp),
  };
}

function normalizeApprovalRequest(value: unknown): ApprovalRequest {
  const record = asRecord(value);
  return {
    id: stringOf(record.id),
    runId: stringOf(record.run_id ?? record.runId),
    stepId: stringOf(record.step_id ?? record.stepId),
    workflowName: stringOf(record.workflow_name ?? record.workflowName),
    description: stringOf(record.description),
    riskLevel: stringOf(record.risk_level ?? record.riskLevel) as ApprovalRequest["riskLevel"],
    payloadJson: optionalString(record.payload_json ?? record.payloadJson),
    status: stringOf(record.status) as ApprovalRequest["status"],
    createdAt: stringOf(record.created_at ?? record.createdAt),
    resolvedAt: optionalString(record.resolved_at ?? record.resolvedAt),
    decisionReason: optionalString(record.decision_reason ?? record.decisionReason),
    payloadAtDecision: optionalString(record.payload_at_decision ?? record.payloadAtDecision),
  };
}

export async function runWorkflowStreamed(
  workflowId: string,
  onEvent: (event: AgentEvent) => void,
): Promise<WorkflowRunResult | null> {
  try {
    const backendUrl = import.meta.env.VITE_RAVEN_BACKEND_URL?.trim();
    if (backendUrl) {
      const streamed = asRecord(
        await invokeBackend("run_workflow_streamed", { workflowId }),
      );
      for (const event of arrayOf(streamed.events)) {
        onEvent(normalizeAgentEvent(event));
      }
      return normalizeRunResult(streamed.result ?? streamed);
    }

    const onEventChannel = new Channel<unknown>();
    onEventChannel.onmessage = (event) => {
      onEvent(normalizeAgentEvent(event));
    };
    return normalizeRunResult(
      await invokeBackend("run_workflow_streamed", { workflowId, onEvent: onEventChannel }),
    );
  } catch (error) {
    onEvent({
      kind: "RUN_ERROR",
      runId: "",
      error: error instanceof Error ? error.message : String(error),
      classification: "terminal",
      timestamp: new Date().toISOString(),
    });
    return null;
  }
}

export async function listPendingApprovals(): Promise<ApprovalRequest[]> {
  try {
    return arrayOf(await invokeBackend("list_pending_approvals")).map(normalizeApprovalRequest);
  } catch {
    return [];
  }
}

export async function listApprovalHistory(): Promise<ApprovalRequest[]> {
  try {
    return arrayOf(await invokeBackend("list_approval_history")).map(normalizeApprovalRequest);
  } catch {
    return [];
  }
}

export async function resolveApproval(
  id: string,
  decision: "approved" | "rejected",
  reason?: string,
): Promise<ApprovalRequest | null> {
  try {
    const result = await invokeBackend("resolve_approval", { id, decision, reason });
    return result ? normalizeApprovalRequest(result) : null;
  } catch {
    return null;
  }
}

// ── Menu Bar / Tray ──

export async function getDockVisibility(): Promise<boolean> {
  return invokeBackend<boolean>("get_dock_visibility");
}

export async function setDockVisibility(visible: boolean): Promise<void> {
  return invokeBackend("set_dock_visibility", { visible });
}

export async function completeOnboarding(): Promise<void> {
  return invokeBackend("complete_onboarding");
}

export async function getOnboardingCompleted(): Promise<boolean> {
  return invokeBackend<boolean>("get_onboarding_completed");
}

export async function getGlobalShortcut(): Promise<string> {
  return invokeBackend<string>("get_global_shortcut");
}

export async function setGlobalShortcut(shortcut: string): Promise<void> {
  return invokeBackend("set_global_shortcut", { shortcut });
}
