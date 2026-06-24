export type ThemeName = "aurora-dark" | "aurora-light";
export type ApprovalMode = "always_review" | "review_changes" | "auto_approve";
export type ViewName = "home" | "artifacts" | "workflows" | "workflow-detail" | "settings" | "marketplace";
export type CommandCenterTarget = "overview" | "usage" | "schedule";
export type ToastLevel = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  level: ToastLevel;
  message: string;
  action?: { label: string; href?: string; onClick?: () => void };
}

export type WorkflowState = "enabled" | "draft" | "disabled";
export type RunState = "queued" | "running" | "succeeded" | "failed" | "retryable" | "blocked";
export type ProviderState = "available" | "degraded" | "unavailable" | "needs_config";
export type AutonomyMode = "ask_first" | "safe_auto" | "workspace_auto" | "power_auto";
export type CapabilitySource = "builtin" | "cli" | "mcp" | "plugin" | "connector";
export type CapabilityAvailability = "available" | "needs_auth" | "degraded" | "unavailable";
export type CapabilityTrustTier =
  | "raven_builtin"
  | "verified_local"
  | "user_installed"
  | "third_party"
  | "unknown";
export type CapabilityDefaultApproval = "auto" | "review_changes" | "always_review" | "blocked";
export type RawToolStatus = "available" | "needs_auth" | "degraded" | "unavailable";
export type RawToolAuthStatus = "authenticated" | "anonymous" | "needs_auth" | "unknown";
export type PreflightPolicyDecision = "auto" | "needs_grant" | "blocked" | "hidden";
export type ApprovalGrantType =
  | "credential_use"
  | "file_write"
  | "file_overwrite"
  | "file_delete"
  | "network_access"
  | "external_publish"
  | "tool_execution";
export type ApprovalGrantStatus = "active" | "revoked" | "expired";
export type CapabilityAdapter =
  | { kind: "native"; handler: string }
  | { kind: "cli"; command: string; argsTemplate: string[]; timeoutMs: number }
  | { kind: "mcp"; serverId: string; toolName: string; timeoutMs: number }
  | { kind: "plugin"; pluginId: string; stepAction: string; timeoutMs: number };
export interface CapabilityPolicyDecision {
  capabilityId?: string;
  decision: PreflightPolicyDecision;
  reason: string;
}
export type ArtifactType =
  | "daily_work_journal"
  | "morning_brief"
  | "weather_report"
  | "plugin_artifact";
export type WorkflowStepKind = "provider_action" | "agent_task";
export type ArtifactDestinationRef =
  | "local-app"
  | "local_app"
  | "markdown_folder"
  | "obsidian_vault"
  | (string & {});

export interface WorkflowStepDefinition {
  kind: WorkflowStepKind;
  id: string;
  name: string;
  provider: string;
  action: string;
  dependsOn: string[];
  permissions: string[];
  inputs: Record<string, unknown>;
  llmProfileRef?: string;
  destinationRef?: ArtifactDestinationRef;
  inlineCode?: string;
  parallel?: boolean;
}

export interface CapabilityDescriptor {
  id: string;
  provider: string;
  action: string;
  displayName: string;
  description: string;
  category: string;
  source: CapabilitySource;
  detectedFrom?: string;
  rawToolId?: string;
  version?: string;
  status: CapabilityAvailability;
  executionMode: "deterministic" | "bounded_agentic" | "open_agentic";
  deterministic: boolean;
  readOnly: boolean;
  idempotent: boolean;
  destructive: boolean;
  openWorld: boolean;
  requiresNetwork: boolean;
  writesFiles: boolean;
  requiresCredentials: boolean;
  permissions: string[];
  operationTags?: string[];
  intentTags: string[];
  bestFor: string[];
  notFor: string[];
  builderGuidance: string;
  fallbackStrategy: string;
  inputSchema: unknown;
  outputSchema: unknown;
  trustTier: CapabilityTrustTier;
  defaultApproval: CapabilityDefaultApproval;
  adapter: CapabilityAdapter;
  signatureHash: string;
  lastCheckedAt?: string;
  policy?: CapabilityPolicyDecision;
}

export interface RawToolOperation {
  name: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  description?: string;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface RawToolInventoryItem {
  id: string;
  source: CapabilitySource;
  displayName: string;
  binaryPath?: string;
  version?: string;
  status: RawToolStatus | string;
  authStatus?: RawToolAuthStatus | string;
  operations: RawToolOperation[];
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  detectionErrors: string[];
  lastCheckedAt: string;
}

export interface CapabilityRegistrySnapshot {
  hash: string;
  generatedAt: string;
  capabilities: CapabilityDescriptor[];
  policyDecisions?: CapabilityPolicyDecision[];
}

export interface PreflightCapabilityUse {
  capabilityId: string;
  stepId: string;
  policyDecision: PreflightPolicyDecision;
  reason: string;
  signatureHash: string;
}

export interface PreflightCredentialUse {
  stepId: string;
  capabilityId: string;
  credentialRef: string;
}

export interface PreflightDeleteUse {
  stepId: string;
  capabilityId: string;
  pathPattern: string;
  maxDeletes?: number;
}

export interface PreflightScopedValueUse {
  stepId: string;
  capabilityId: string;
  value: string;
}

export interface PreflightBlockingItem {
  stepId: string;
  capabilityId: string;
  reason: string;
}

export interface CapabilityAuditEvent {
  id: string;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  stepId: string;
  capabilityId: string;
  decision: PreflightPolicyDecision | string;
  reason: string;
  grantId?: string;
  createdAt: string;
}

export interface PreflightManifest {
  id: string;
  workflowId: string;
  workflowVersion: number;
  registrySnapshotHash: string;
  createdAt: string;
  capabilities: PreflightCapabilityUse[];
  credentials: PreflightCredentialUse[];
  networkDomains: string[];
  fileReads: string[];
  fileWrites: string[];
  overwrites: string[];
  deletes: PreflightDeleteUse[];
  externalPublishes: string[];
  scopedNetworkDomains: PreflightScopedValueUse[];
  scopedNetworkResources: PreflightScopedValueUse[];
  scopedFileWrites: PreflightScopedValueUse[];
  scopedOverwrites: PreflightScopedValueUse[];
  scopedExternalPublishes: PreflightScopedValueUse[];
  policyRecommendation: AutonomyMode;
  blockingItems: PreflightBlockingItem[];
}

export interface ApprovalGrantScope {
  credentialRef?: string;
  paths: string[];
  domains: string[];
  resourceIds: string[];
  maxDeletes?: number;
  maxOverwriteBytes?: number;
  externalTargets: string[];
}

export interface ApprovalGrant {
  id: string;
  workflowId: string;
  workflowVersion: number;
  capabilityId: string;
  grantType: ApprovalGrantType;
  scope: ApprovalGrantScope;
  approvedByUserAt: string;
  expiresAt?: string;
  signatureHash: string;
  status: ApprovalGrantStatus;
}

export type ApprovalGrantDraft = ApprovalGrant;

export interface RavenWorkflow {
  schemaVersion: "0.1.0";
  id: string;
  name: string;
  description: string;
  permissions: string[];
  defaults: {
    llmProfileRef: string;
    destinationRef: ArtifactDestinationRef;
  };
  schedule?: {
    cadence: "manual" | "daily" | "weekdays";
    localTime?: string;
  };
  steps: WorkflowStepDefinition[];
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  status: WorkflowState;
  approvalMode: ApprovalMode;
  plannerRationale?: PlannerRationale | null;
  planner_rationale?: PlannerRationale | null;
  definition: RavenWorkflow;
  createdAt: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunState;
  startedAt: string;
  completedAt?: string;
  failureReason?: string;
  idempotencyKey: string;
  triggerKind?: string;
  retryCount?: number;
  parentRunId?: string;
  errorClassification?: "retryable" | "terminal" | string;
  providerProfileId?: string;
  blockedReason?: string;
  requiredProviderId?: string;
  requiredProfileId?: string;
  setupAction?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

export interface UsageCostAnomaly {
  detected: boolean;
  period: string;
  multiplier: number;
  currentWindowLabel: string;
  baselineWindowLabel: string;
  currentAverageDailyUsd: number;
  baselineAverageDailyUsd: number;
  currentRunCount: number;
  baselineRunCount: number;
  baselineDays: number;
  source: string;
}

export interface UsagePricingCatalogEntry {
  providerId: string;
  model: string;
  aliases: string[];
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  contextWindowTokens: number;
}

export interface UsagePricingCatalog {
  source: string;
  version: string;
  fetchedAt: string;
  loadedAt: string;
  entries: UsagePricingCatalogEntry[];
}

export interface WorkflowScheduleOverride {
  id: string;
  workflowId: string;
  originalRunAt: string;
  scheduledRunAt: string;
  createdAt: string;
}

export interface WorkflowStepRun {
  id: string;
  workflowRunId: string;
  stepId: string;
  status: RunState;
  outputJson?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface Artifact {
  id: string;
  title: string;
  type: ArtifactType;
  workflowRunId: string;
  contentMarkdown: string;
  metadata: Record<string, unknown>;
  sourceRefs: string[];
  createdAt: string;
}

export interface ProviderHealth {
  id: string;
  name: string;
  kind: "llm" | "context" | "artifact_destination" | "notification";
  status: ProviderState;
  summary: string;
  fallbackProviderId?: string;
}

export interface ProviderAccount {
  id: string;
  providerKind: ProviderHealth["kind"];
  displayName: string;
  credentialRef: string;
  settingsJson: Record<string, unknown>;
}

export interface ContextPack {
  summary: string;
  sourceRefs: string[];
}

export interface LlmProfile {
  id: string;
  providerId: string;
  model: string;
  effort: "low" | "medium" | "high";
  supportsStructuredOutputs: boolean;
}

export interface AgentAuthProfile {
  id: string;
  displayName: string;
  runnerKind: "codex_cli" | "claude_code_cli" | "openai_api" | "anthropic_api" | "ollama_local";
  authMode:
    | "codex_oauth_local_cli"
    | "claude_code_oauth_local_cli"
    | "api_key_env"
    | "api_key_keychain"
    | "none";
  credentialRef: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  status: ProviderState;
  summary: string;
}

export interface OllamaModel {
  name: string;
  size: number;
  parameterSize?: string;
  quantizationLevel?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface PlannerOperation {
  id: string;
  kind: string;
  status: "requested" | "covered" | "agent_required" | "unsupported" | "blocked";
  evidence: string;
  capabilityId?: string | null;
  capability_id?: string | null;
  stepId?: string | null;
  step_id?: string | null;
  inputs: unknown;
}

export interface PlannerRationale {
  prompt: string;
  operations: PlannerOperation[];
  warnings: string[];
}

export interface WorkflowDraft {
  id: string;
  prompt: string;
  summary: string;
  permissionChanges: string[];
  destinationWrites: string[];
  diffJson: unknown;
  validationStatus: "valid" | "invalid";
  approvalStatus: "draft" | "needs_review" | "approved" | "rejected" | "superseded";
  builderProfileId?: string;
  approvalMode?: ApprovalMode;
  validationErrors: string[];
  plannerRationale?: PlannerRationale | null;
  planner_rationale?: PlannerRationale | null;
  definition: RavenWorkflow;
  createdAt: string;
}

export interface WorkflowDraftRevisionContext {
  sourceLabel: string;
  validationErrors: string[];
  plannerRationale?: PlannerRationale | null;
  definition: RavenWorkflow;
}

export interface BuilderDraftEvent {
  requestId: string;
  phase: "thinking" | "typing" | "complete" | "failed";
  stepId: string;
  status: "pending" | "active" | "complete" | "failed";
  title: string;
  detail: string;
  emittedAt: string;
  eventKind?: string;
  delta?: string;
  rawEventType?: string;
}

export interface WorkflowRunResult {
  run: WorkflowRun;
  artifact?: Artifact;
  duplicate: boolean;
}

export interface SchedulerStatus {
  running: boolean;
  pollIntervalSeconds: number;
}

export interface SystemHealthDiagnostics {
  generatedAt: string;
  status: "ok" | "warning" | "critical" | string;
  issueCount: number;
  scheduler: SchedulerStatus;
  providers: {
    total: number;
    available: number;
    degraded: number;
    needsConfig: number;
    unavailable: number;
  };
  destinations: {
    total: number;
    ready: number;
    needsConfig: number;
    unavailable: number;
  };
  workflows: {
    total: number;
    enabled: number;
    draft: number;
    disabled: number;
    invalid: number;
    blockingIssues: number;
  };
  runs: {
    total: number;
    failed: number;
    retryable: number;
    blocked: number;
    running: number;
  };
  plugins: {
    installed: number;
    availableSteps: number;
  };
}

export interface AppState {
  theme: ThemeName;
  autonomyMode: AutonomyMode;
  autonomyCategoryOverrides: Record<string, AutonomyMode>;
  capabilityRegistry: CapabilityRegistrySnapshot;
  rawToolInventory: RawToolInventoryItem[];
  approvalGrants: ApprovalGrant[];
  workflows: WorkflowVersion[];
  runs: WorkflowRun[];
  artifacts: Artifact[];
  scheduleOverrides: WorkflowScheduleOverride[];
  providers: ProviderHealth[];
  llmProfiles: LlmProfile[];
  agentAuthProfiles: AgentAuthProfile[];
  chatMessages: ChatMessage[];
}

export interface ViewContext {
  currentView: ViewName;
  selectedWorkflowId: string;
  selectedArtifactId: string;
  activeSettingsTab: string;
}

export type AgentEventKind =
  | "RUN_STARTED" | "STEP_STARTED" | "TEXT_MESSAGE_CONTENT"
  | "TOOL_CALL_START" | "TOOL_CALL_END" | "THINKING_CONTENT"
  | "STEP_FINISHED" | "RUN_FINISHED" | "RUN_ERROR" | "INTERRUPT";

export interface AgentEvent {
  kind: AgentEventKind;
  runId: string;
  stepId?: string;
  threadId?: string;
  toolCallId?: string;
  workflowName?: string;
  stepName?: string;
  toolName?: string;
  approvalId?: string;
  delta?: string;
  content?: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
  classification?: string;
  description?: string;
  riskLevel?: string;
  artifactId?: string;
  durationMs?: number;
  tokenCount?: number;
  estimatedCostUsd?: number;
  timestamp: string;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  stepId: string;
  workflowName: string;
  description: string;
  riskLevel: "normal" | "elevated" | "high";
  payloadJson?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  decisionReason?: string;
  payloadAtDecision?: string;
}

export interface StepState {
  stepId: string;
  stepName: string;
  status: "pending" | "active" | "complete" | "failed";
  startedAt: string;
  durationMs?: number;
  tokenCount?: number;
}

export interface RunStreamState {
  activeRunId: string | null;
  activeSteps: Map<string, StepState>;
  tokenBuffer: string;
  toolCalls: AgentEvent[];
  thinkingBlocks: string[];
  pendingApproval: ApprovalRequest | null;
  runError: string | null;
  totalTokens: number;
  totalCostUsd: number;
}

export type AssistantResponseType = "text" | "draft" | "navigate" | "action";

export interface AssistantResponse {
  type: AssistantResponseType;
  content?: string;
  draft?: WorkflowDraft;
  navigateTo?: ViewName;
  action?: { kind: string; payload: Record<string, unknown> };
}

export interface PluginStepDefinition {
  kind: string;
  provider: string;
  action: string;
  displayName: string;
  permissions: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
  };
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  steps: PluginStepDefinition[];
}
