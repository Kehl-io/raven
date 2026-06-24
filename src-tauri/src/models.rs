use crate::agent_auth::AgentAuthProfile;
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStatus {
    Enabled,
    Draft,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Retryable,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatus {
    Available,
    Degraded,
    Unavailable,
    NeedsConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Llm,
    Context,
    ArtifactDestination,
    Notification,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySource {
    Builtin,
    Cli,
    Mcp,
    Plugin,
    Connector,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawToolStatus {
    Available,
    NeedsAuth,
    Degraded,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawToolAuthStatus {
    Authenticated,
    Anonymous,
    NeedsAuth,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct RawToolAnnotations {
    pub read_only_hint: Option<bool>,
    pub destructive_hint: Option<bool>,
    pub idempotent_hint: Option<bool>,
    pub open_world_hint: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RawToolOperation {
    pub name: String,
    pub input_schema: Option<serde_json::Value>,
    pub output_schema: Option<serde_json::Value>,
    pub description: Option<String>,
    pub annotations: RawToolAnnotations,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RawToolInventoryItem {
    pub id: String,
    pub source: CapabilitySource,
    pub display_name: String,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub status: RawToolStatus,
    pub auth_status: Option<RawToolAuthStatus>,
    pub operations: Vec<RawToolOperation>,
    pub annotations: RawToolAnnotations,
    pub detection_errors: Vec<String>,
    pub last_checked_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityAvailability {
    Available,
    NeedsAuth,
    Degraded,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityTrustTier {
    RavenBuiltin,
    VerifiedLocal,
    UserInstalled,
    ThirdParty,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityDefaultApproval {
    Auto,
    ReviewChanges,
    AlwaysReview,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CapabilityAdapter {
    Native {
        handler: String,
    },
    Cli {
        command: String,
        args_template: Vec<String>,
        timeout_ms: u64,
    },
    Mcp {
        server_id: String,
        tool_name: String,
        timeout_ms: u64,
    },
    Plugin {
        plugin_id: String,
        step_action: String,
        timeout_ms: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CapabilityDescriptor {
    pub id: String,
    pub provider: String,
    pub action: String,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub source: CapabilitySource,
    pub detected_from: Option<String>,
    pub raw_tool_id: Option<String>,
    pub version: Option<String>,
    pub status: CapabilityAvailability,
    pub execution_mode: crate::capabilities::ExecutionMode,
    pub deterministic: bool,
    pub read_only: bool,
    pub idempotent: bool,
    pub destructive: bool,
    pub open_world: bool,
    pub requires_network: bool,
    pub writes_files: bool,
    pub requires_credentials: bool,
    pub permissions: Vec<String>,
    pub intent_tags: Vec<String>,
    #[serde(default)]
    pub operation_tags: Vec<String>,
    pub best_for: Vec<String>,
    pub not_for: Vec<String>,
    pub builder_guidance: String,
    pub fallback_strategy: String,
    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,
    pub trust_tier: CapabilityTrustTier,
    pub default_approval: CapabilityDefaultApproval,
    pub adapter: CapabilityAdapter,
    pub signature_hash: String,
    pub last_checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepKind {
    ProviderAction,
    AgentTask,
}

impl Default for WorkflowStepKind {
    fn default() -> Self {
        Self::ProviderAction
    }
}

impl<'de> Deserialize<'de> for WorkflowStepKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "agent_task" => Self::AgentTask,
            "provider_action" => Self::ProviderAction,
            _ => Self::ProviderAction,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowStepDefinition {
    #[serde(default)]
    pub kind: WorkflowStepKind,
    pub id: String,
    pub name: String,
    pub provider: String,
    pub action: String,
    pub depends_on: Vec<String>,
    pub permissions: Vec<String>,
    pub inputs: serde_json::Value,
    pub llm_profile_ref: Option<String>,
    pub destination_ref: Option<String>,
    pub inline_code: Option<String>,
    #[serde(default)]
    pub parallel: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowDefaults {
    pub llm_profile_ref: String,
    pub destination_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowScheduleDefinition {
    pub cadence: String,
    pub local_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RavenWorkflow {
    pub schema_version: String,
    pub id: String,
    pub name: String,
    pub description: String,
    pub permissions: Vec<String>,
    pub defaults: WorkflowDefaults,
    pub schedule: Option<WorkflowScheduleDefinition>,
    pub steps: Vec<WorkflowStepDefinition>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreflightManifest {
    pub id: String,
    pub workflow_id: String,
    pub workflow_version: i64,
    pub registry_snapshot_hash: String,
    pub created_at: String,
    pub capabilities: Vec<PreflightCapabilityUse>,
    pub credentials: Vec<PreflightCredentialUse>,
    pub network_domains: Vec<String>,
    pub file_reads: Vec<String>,
    pub file_writes: Vec<String>,
    pub overwrites: Vec<String>,
    pub deletes: Vec<PreflightDeleteUse>,
    pub external_publishes: Vec<String>,
    #[serde(default)]
    pub scoped_network_domains: Vec<PreflightScopedValueUse>,
    #[serde(default)]
    pub scoped_network_resources: Vec<PreflightScopedValueUse>,
    #[serde(default)]
    pub scoped_file_writes: Vec<PreflightScopedValueUse>,
    #[serde(default)]
    pub scoped_overwrites: Vec<PreflightScopedValueUse>,
    #[serde(default)]
    pub scoped_external_publishes: Vec<PreflightScopedValueUse>,
    pub policy_recommendation: crate::autonomy::AutonomyMode,
    pub blocking_items: Vec<PreflightBlockingItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreflightCapabilityUse {
    pub capability_id: String,
    pub step_id: String,
    pub policy_decision: crate::autonomy::PolicyDecisionKind,
    pub reason: String,
    pub signature_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreflightCredentialUse {
    pub step_id: String,
    pub capability_id: String,
    pub credential_ref: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreflightDeleteUse {
    pub step_id: String,
    pub capability_id: String,
    pub path_pattern: String,
    pub max_deletes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreflightScopedValueUse {
    pub step_id: String,
    pub capability_id: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreflightBlockingItem {
    pub step_id: String,
    pub capability_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowVersion {
    pub id: String,
    pub workflow_id: String,
    pub version: i64,
    pub status: WorkflowStatus,
    pub definition: RavenWorkflow,
    pub created_at: String,
    pub approval_mode: Option<String>,
    #[serde(default)]
    pub planner_rationale: Option<crate::planner::operations::OperationPlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub status: RunStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub failure_reason: Option<String>,
    pub idempotency_key: String,
    pub trigger_kind: String,
    pub retry_count: i64,
    pub parent_run_id: Option<String>,
    pub error_classification: Option<String>,
    pub provider_profile_id: Option<String>,
    pub blocked_reason: Option<String>,
    pub required_provider_id: Option<String>,
    pub required_profile_id: Option<String>,
    pub setup_action: Option<String>,
    pub total_tokens: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageCostAnomaly {
    pub detected: bool,
    pub period: String,
    pub multiplier: f64,
    pub current_window_label: String,
    pub baseline_window_label: String,
    pub current_average_daily_usd: f64,
    pub baseline_average_daily_usd: f64,
    pub current_run_count: usize,
    pub baseline_run_count: usize,
    pub baseline_days: i64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsagePricingCatalogEntry {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub input_usd_per_million_tokens: f64,
    pub output_usd_per_million_tokens: f64,
    pub context_window_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsagePricingCatalog {
    pub source: String,
    pub version: String,
    pub fetched_at: String,
    pub loaded_at: String,
    pub entries: Vec<UsagePricingCatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowScheduleOverride {
    pub id: String,
    pub workflow_id: String,
    pub original_run_at: String,
    pub scheduled_run_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowStepRun {
    pub id: String,
    pub workflow_run_id: String,
    pub step_id: String,
    pub status: RunStatus,
    pub output_json: Option<serde_json::Value>,
    pub error: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentToolEventStatus {
    Requested,
    Succeeded,
    Failed,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentToolEvent {
    pub id: String,
    pub workflow_run_id: String,
    pub step_id: String,
    pub tool_id: String,
    pub status: AgentToolEventStatus,
    pub input_json: serde_json::Value,
    pub output_json: Option<serde_json::Value>,
    pub error: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityAuditEvent {
    pub id: String,
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_version: i64,
    pub step_id: String,
    pub capability_id: String,
    pub decision: String,
    pub reason: String,
    pub grant_id: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub status: Option<String>,
    pub input_summary: Option<serde_json::Value>,
    pub output_summary: Option<serde_json::Value>,
    pub error_details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalGrant {
    pub id: String,
    pub workflow_id: String,
    pub workflow_version: i64,
    pub capability_id: String,
    pub grant_type: ApprovalGrantType,
    pub scope: ApprovalGrantScope,
    pub approved_by_user_at: String,
    pub expires_at: Option<String>,
    pub signature_hash: String,
    pub status: ApprovalGrantStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalGrantType {
    CredentialUse,
    FileWrite,
    FileOverwrite,
    FileDelete,
    NetworkAccess,
    ExternalPublish,
    ToolExecution,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalGrantStatus {
    Active,
    Revoked,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalGrantScope {
    pub credential_ref: Option<String>,
    pub paths: Vec<String>,
    pub domains: Vec<String>,
    pub resource_ids: Vec<String>,
    pub max_deletes: Option<u64>,
    pub max_overwrite_bytes: Option<u64>,
    pub external_targets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Artifact {
    pub id: String,
    pub title: String,
    pub artifact_type: String,
    pub workflow_run_id: String,
    pub content_path: String,
    pub metadata_path: String,
    pub content_markdown: String,
    pub metadata: serde_json::Value,
    pub source_refs: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolTraceEntry {
    pub tool_id: String,
    pub status: String,
    pub input_summary: serde_json::Value,
    pub output_summary: Option<serde_json::Value>,
    pub source_refs: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTaskEnvelope {
    pub title: String,
    pub content_markdown: String,
    pub metadata: serde_json::Value,
    pub source_refs: Vec<String>,
    pub tool_trace: Vec<ToolTraceEntry>,
    pub raw_result_json: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderHealth {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub status: ProviderStatus,
    pub summary: String,
    pub fallback_provider_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderAccount {
    pub id: String,
    pub provider_kind: ProviderKind,
    pub display_name: String,
    pub credential_ref: String,
    pub settings_json: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LlmProfile {
    pub id: String,
    pub provider_id: String,
    pub model: String,
    pub effort: String,
    pub supports_structured_outputs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatThread {
    pub id: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowDraft {
    pub id: String,
    pub prompt: String,
    pub summary: String,
    pub permission_changes: Vec<String>,
    pub destination_writes: Vec<String>,
    pub diff_json: serde_json::Value,
    pub validation_status: String,
    pub approval_status: String,
    pub builder_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<String>,
    pub validation_errors: Vec<String>,
    #[serde(default)]
    pub planner_rationale: Option<crate::planner::operations::OperationPlan>,
    pub definition: RavenWorkflow,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowDraftRevisionContext {
    pub source_label: String,
    #[serde(default)]
    pub validation_errors: Vec<String>,
    #[serde(default)]
    pub planner_rationale: Option<crate::planner::operations::OperationPlan>,
    pub definition: RavenWorkflow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppState {
    pub workflows: Vec<WorkflowVersion>,
    pub runs: Vec<WorkflowRun>,
    pub artifacts: Vec<Artifact>,
    pub schedule_overrides: Vec<WorkflowScheduleOverride>,
    pub providers: Vec<ProviderHealth>,
    pub llm_profiles: Vec<LlmProfile>,
    pub agent_auth_profiles: Vec<AgentAuthProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderDiagnostics {
    pub total: usize,
    pub available: usize,
    pub degraded: usize,
    pub needs_config: usize,
    pub unavailable: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DestinationDiagnostics {
    pub total: usize,
    pub ready: usize,
    pub needs_config: usize,
    pub unavailable: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowDiagnostics {
    pub total: usize,
    pub enabled: usize,
    pub draft: usize,
    pub disabled: usize,
    pub invalid: usize,
    pub blocking_issues: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunDiagnostics {
    pub total: usize,
    pub failed: usize,
    pub retryable: usize,
    pub blocked: usize,
    pub running: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginDiagnostics {
    pub installed: usize,
    pub available_steps: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SystemHealthDiagnostics {
    pub generated_at: String,
    pub status: String,
    pub issue_count: usize,
    pub scheduler: crate::scheduler::SchedulerStatus,
    pub providers: ProviderDiagnostics,
    pub destinations: DestinationDiagnostics,
    pub workflows: WorkflowDiagnostics,
    pub runs: RunDiagnostics,
    pub plugins: PluginDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowRunResult {
    pub run: WorkflowRun,
    pub artifact: Option<Artifact>,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentEvent {
    RunStarted {
        run_id: String,
        thread_id: String,
        workflow_name: String,
        timestamp: String,
    },
    StepStarted {
        run_id: String,
        step_id: String,
        step_name: String,
        timestamp: String,
    },
    TextMessageContent {
        run_id: String,
        step_id: String,
        content: String,
    },
    ToolCallStart {
        run_id: String,
        step_id: String,
        tool_call_id: String,
        tool_name: String,
        args: serde_json::Value,
    },
    ToolCallEnd {
        run_id: String,
        step_id: String,
        tool_name: String,
        result: String,
        duration_ms: u64,
    },
    ThinkingContent {
        run_id: String,
        step_id: String,
        content: String,
    },
    StepFinished {
        run_id: String,
        step_id: String,
        duration_ms: u64,
        token_count: Option<u64>,
        estimated_cost_usd: Option<f64>,
    },
    RunFinished {
        run_id: String,
        artifact_id: Option<String>,
        duration_ms: u64,
        token_count: Option<u64>,
        estimated_cost_usd: Option<f64>,
    },
    RunError {
        run_id: String,
        error: String,
        classification: String,
    },
    Interrupt {
        run_id: String,
        step_id: String,
        approval_id: String,
        workflow_name: String,
        description: String,
        risk_level: String,
        timestamp: String,
    },
}

impl AgentEvent {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => "RUN_STARTED",
            Self::StepStarted { .. } => "STEP_STARTED",
            Self::TextMessageContent { .. } => "TEXT_MESSAGE_CONTENT",
            Self::ToolCallStart { .. } => "TOOL_CALL_START",
            Self::ToolCallEnd { .. } => "TOOL_CALL_END",
            Self::ThinkingContent { .. } => "THINKING_CONTENT",
            Self::StepFinished { .. } => "STEP_FINISHED",
            Self::RunFinished { .. } => "RUN_FINISHED",
            Self::RunError { .. } => "RUN_ERROR",
            Self::Interrupt { .. } => "INTERRUPT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingApproval {
    pub id: String,
    pub run_id: String,
    pub step_id: String,
    pub workflow_name: String,
    pub description: String,
    pub risk_level: String,
    pub payload_json: Option<String>,
    pub status: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
    pub decision_reason: Option<String>,
    pub payload_at_decision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approved,
    Rejected,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_descriptor_serializes_with_policy_metadata() {
        let descriptor = CapabilityDescriptor {
            id: "github.list_prs".into(),
            provider: "github".into(),
            action: "list_prs".into(),
            display_name: "List pull requests".into(),
            description: "Lists pull requests for a repository.".into(),
            category: "github".into(),
            source: CapabilitySource::Cli,
            detected_from: Some("gh".into()),
            raw_tool_id: Some("cli.gh".into()),
            version: Some("2.0.0".into()),
            status: CapabilityAvailability::Available,
            execution_mode: crate::capabilities::ExecutionMode::Deterministic,
            deterministic: true,
            read_only: true,
            idempotent: true,
            destructive: false,
            open_world: true,
            requires_network: true,
            writes_files: false,
            requires_credentials: true,
            permissions: vec!["github:read".into()],
            intent_tags: vec!["github".into(), "pull_requests".into()],
            operation_tags: vec![],
            best_for: vec!["PR digests".into()],
            not_for: vec!["Merging PRs".into()],
            builder_guidance: "Use for PR summaries before agent synthesis.".into(),
            fallback_strategy: "Ask user to authenticate GitHub CLI.".into(),
            input_schema: serde_json::json!({"type": "object"}),
            output_schema: serde_json::json!({"type": "object"}),
            trust_tier: CapabilityTrustTier::VerifiedLocal,
            default_approval: CapabilityDefaultApproval::Auto,
            adapter: CapabilityAdapter::Cli {
                command: "gh".into(),
                args_template: vec![
                    "pr".into(),
                    "list".into(),
                    "--json".into(),
                    "title,url".into(),
                ],
                timeout_ms: 10_000,
            },
            signature_hash: "test-hash".into(),
            last_checked_at: Some("2026-06-21T00:00:00Z".into()),
        };

        let value = serde_json::to_value(descriptor).unwrap();
        assert_eq!(value["id"], "github.list_prs");
        assert_eq!(value["source"], "cli");
        assert_eq!(value["default_approval"], "auto");
        assert_eq!(value["execution_mode"], "deterministic");
        assert_eq!(value["read_only"], true);
        assert_eq!(value["requires_credentials"], true);
        assert_eq!(value["trust_tier"], "verified_local");
        assert_eq!(value["adapter"]["kind"], "cli");
        assert_eq!(value["adapter"]["timeout_ms"], 10_000);
        assert_eq!(
            value["adapter"]["args_template"],
            serde_json::json!(["pr", "list", "--json", "title,url"])
        );
    }
}
