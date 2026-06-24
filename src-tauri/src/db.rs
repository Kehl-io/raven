use crate::agent_auth;
use crate::models::{
    AgentToolEvent, AgentToolEventStatus, AppState, ApprovalGrant, ApprovalGrantStatus,
    ApprovalGrantType, Artifact, CapabilityAuditEvent, ChatMessage, ChatThread, LlmProfile,
    PendingApproval, ProviderAccount, ProviderHealth, ProviderKind, ProviderStatus, RavenWorkflow,
    RunStatus, WorkflowDraft, WorkflowRun, WorkflowStatus, WorkflowStepRun, WorkflowVersion,
};
use crate::providers::{self, ContextProvider};
use crate::workflow;
use chrono::{NaiveTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("raw credential values cannot be persisted")]
    RawCredential,
    #[error("invalid provider account id: {0}")]
    InvalidProviderAccountId(String),
    #[error("artifact destination {0} is not configured")]
    MissingArtifactDestination(String),
    #[error("context provider {0} is not configured")]
    MissingContextProviderConfig(String),
    #[error("invalid workflow edit: {0}")]
    InvalidWorkflowEdit(String),
    #[error("missing agent tool event {0}")]
    MissingAgentToolEvent(String),
    #[error("missing approval grant {0}")]
    MissingApprovalGrant(String),
    #[error("agent tool event {0} is already completed")]
    AgentToolEventAlreadyCompleted(String),
    #[error("missing workflow step run for run {workflow_run_id} step {step_id}")]
    MissingWorkflowStepRun {
        workflow_run_id: String,
        step_id: String,
    },
    #[error("invalid agent tool event status: {0}")]
    InvalidAgentToolEventStatus(String),
    #[error("invalid initial agent tool event state: {0}")]
    InvalidInitialAgentToolEventState(String),
    #[error("invalid path: {0}")]
    InvalidPath(String),
}

pub struct Repository {
    connection: Connection,
    artifacts_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLlmCredential {
    pub profile_id: String,
    pub provider_id: String,
    pub model: String,
    pub effort: String,
    pub credential: String,
}

impl Repository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let artifacts_dir = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("artifacts");
        fs::create_dir_all(&artifacts_dir)?;

        let connection = Connection::open(path)?;
        let repository = Self {
            connection,
            artifacts_dir,
        };
        repository.migrate()?;
        repository.seed_defaults()?;
        Ok(repository)
    }

    pub fn migrate(&self) -> Result<(), DbError> {
        self.connection.execute_batch(
            "
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS workflows (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workflow_versions (
              id TEXT PRIMARY KEY,
              workflow_id TEXT NOT NULL,
              version INTEGER NOT NULL,
              status TEXT NOT NULL,
              definition_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              planner_rationale_json TEXT,
              UNIQUE(workflow_id, version),
              FOREIGN KEY(workflow_id) REFERENCES workflows(id)
            );

            CREATE TABLE IF NOT EXISTS schedules (
              id TEXT PRIMARY KEY,
              workflow_id TEXT NOT NULL,
              cadence TEXT NOT NULL,
              local_time TEXT,
              enabled INTEGER NOT NULL,
              FOREIGN KEY(workflow_id) REFERENCES workflows(id)
            );

            CREATE TABLE IF NOT EXISTS schedule_overrides (
              id TEXT PRIMARY KEY,
              workflow_id TEXT NOT NULL,
              original_run_at TEXT NOT NULL,
              scheduled_run_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(workflow_id, original_run_at),
              FOREIGN KEY(workflow_id) REFERENCES workflows(id)
            );

            CREATE TABLE IF NOT EXISTS workflow_runs (
              id TEXT PRIMARY KEY,
              workflow_id TEXT NOT NULL,
              workflow_name TEXT NOT NULL,
              status TEXT NOT NULL,
              started_at TEXT NOT NULL,
              completed_at TEXT,
              failure_reason TEXT,
              idempotency_key TEXT NOT NULL UNIQUE,
              trigger_kind TEXT NOT NULL DEFAULT 'manual',
              retry_count INTEGER NOT NULL DEFAULT 0,
              parent_run_id TEXT,
              error_classification TEXT,
              provider_profile_id TEXT,
              total_tokens INTEGER,
              input_tokens INTEGER,
              output_tokens INTEGER,
              total_cost_usd REAL,
              FOREIGN KEY(workflow_id) REFERENCES workflows(id)
            );

            CREATE TABLE IF NOT EXISTS workflow_step_runs (
              id TEXT PRIMARY KEY,
              workflow_run_id TEXT NOT NULL,
              step_id TEXT NOT NULL,
              status TEXT NOT NULL,
              output_json TEXT,
              error TEXT,
              started_at TEXT NOT NULL,
              completed_at TEXT,
              FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
            );

            CREATE TABLE IF NOT EXISTS artifacts (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              artifact_type TEXT NOT NULL,
              workflow_run_id TEXT NOT NULL,
              content_path TEXT NOT NULL,
              metadata_path TEXT NOT NULL,
              content_markdown TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              source_refs_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
            );

            CREATE TABLE IF NOT EXISTS context_artifacts (
              id TEXT PRIMARY KEY,
              provider_id TEXT NOT NULL,
              content_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS provider_accounts (
              id TEXT PRIMARY KEY,
              provider_kind TEXT NOT NULL,
              display_name TEXT NOT NULL,
              credential_ref TEXT NOT NULL,
              settings_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_auth_profiles (
              id TEXT PRIMARY KEY,
              runner_kind TEXT NOT NULL,
              auth_mode TEXT NOT NULL,
              display_name TEXT NOT NULL,
              credential_ref TEXT NOT NULL,
              model TEXT NOT NULL,
              effort TEXT NOT NULL,
              status TEXT NOT NULL,
              summary TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS llm_profiles (
              id TEXT PRIMARY KEY,
              provider_id TEXT NOT NULL,
              model TEXT NOT NULL,
              effort TEXT NOT NULL,
              supports_structured_outputs INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_threads (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
              id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(thread_id) REFERENCES chat_threads(id)
            );

            CREATE TABLE IF NOT EXISTS workflow_drafts (
              id TEXT PRIMARY KEY,
              prompt TEXT NOT NULL,
              summary TEXT NOT NULL,
              permission_changes_json TEXT NOT NULL,
              destination_writes_json TEXT NOT NULL DEFAULT '[]',
              diff_json TEXT NOT NULL DEFAULT '[]',
              validation_status TEXT NOT NULL,
              approval_status TEXT NOT NULL DEFAULT 'needs_review',
              builder_profile_id TEXT,
              validation_errors_json TEXT NOT NULL DEFAULT '[]',
              planner_rationale_json TEXT,
              definition_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit_events (
              id TEXT PRIMARY KEY,
              event_type TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pending_approvals (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              step_id TEXT NOT NULL,
              workflow_name TEXT NOT NULL,
              description TEXT NOT NULL,
              risk_level TEXT NOT NULL DEFAULT 'normal',
              payload_json TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              created_at TEXT NOT NULL,
              resolved_at TEXT,
              resolved_by TEXT
            );

            CREATE TABLE IF NOT EXISTS approval_grants (
              id TEXT PRIMARY KEY,
              workflow_id TEXT NOT NULL,
              workflow_version INTEGER NOT NULL,
              capability_id TEXT NOT NULL,
              grant_type TEXT NOT NULL,
              scope_json TEXT NOT NULL,
              approved_by_user_at TEXT NOT NULL,
              expires_at TEXT,
              signature_hash TEXT NOT NULL,
              status TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS capability_audit_events (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              workflow_id TEXT NOT NULL,
              workflow_version INTEGER NOT NULL,
              step_id TEXT NOT NULL,
              capability_id TEXT NOT NULL,
              decision TEXT NOT NULL,
              reason TEXT NOT NULL,
              grant_id TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(run_id) REFERENCES workflow_runs(id)
            );
            ",
        )?;
        self.deduplicate_workflow_step_runs()?;
        self.connection.execute_batch(
            "
            CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_step_runs_run_step
            ON workflow_step_runs(workflow_run_id, step_id);
            ",
        )?;
        self.ensure_agent_tool_events_table()?;
        self.connection.execute_batch(
            "
            CREATE INDEX IF NOT EXISTS idx_agent_tool_events_run_created
            ON agent_tool_events(workflow_run_id, created_at, id);
            CREATE INDEX IF NOT EXISTS idx_capability_audit_events_run_created
            ON capability_audit_events(run_id, created_at, id);
            CREATE INDEX IF NOT EXISTS idx_approval_grants_runtime_lookup
            ON approval_grants(workflow_id, workflow_version, capability_id, status);
            ",
        )?;
        self.add_column_if_missing(
            "workflow_drafts",
            "destination_writes_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        self.add_column_if_missing("workflow_drafts", "diff_json", "TEXT NOT NULL DEFAULT '[]'")?;
        self.add_column_if_missing(
            "workflow_drafts",
            "approval_status",
            "TEXT NOT NULL DEFAULT 'needs_review'",
        )?;
        self.add_column_if_missing("workflow_drafts", "builder_profile_id", "TEXT")?;
        self.add_column_if_missing(
            "workflow_drafts",
            "validation_errors_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        self.add_column_if_missing("workflow_drafts", "planner_rationale_json", "TEXT")?;
        self.add_column_if_missing(
            "workflow_runs",
            "trigger_kind",
            "TEXT NOT NULL DEFAULT 'manual'",
        )?;
        self.add_column_if_missing("workflow_runs", "retry_count", "INTEGER NOT NULL DEFAULT 0")?;
        self.add_column_if_missing("workflow_runs", "parent_run_id", "TEXT")?;
        self.add_column_if_missing("workflow_runs", "error_classification", "TEXT")?;
        self.add_column_if_missing("workflow_runs", "provider_profile_id", "TEXT")?;
        self.add_column_if_missing("workflow_runs", "blocked_reason", "TEXT")?;
        self.add_column_if_missing("workflow_runs", "required_provider_id", "TEXT")?;
        self.add_column_if_missing("workflow_runs", "required_profile_id", "TEXT")?;
        self.add_column_if_missing("workflow_runs", "setup_action", "TEXT")?;
        self.add_column_if_missing("pending_approvals", "decision_reason", "TEXT")?;
        self.add_column_if_missing("pending_approvals", "payload_at_decision", "TEXT")?;
        self.add_column_if_missing(
            "workflow_runs",
            "total_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        self.add_column_if_missing("workflow_runs", "input_tokens", "INTEGER")?;
        self.add_column_if_missing("workflow_runs", "output_tokens", "INTEGER")?;
        self.add_column_if_missing(
            "workflow_runs",
            "total_cost_usd",
            "REAL NOT NULL DEFAULT 0.0",
        )?;
        self.add_column_if_missing("capability_audit_events", "started_at", "TEXT")?;
        self.add_column_if_missing("capability_audit_events", "completed_at", "TEXT")?;
        self.add_column_if_missing("capability_audit_events", "status", "TEXT")?;
        self.add_column_if_missing("capability_audit_events", "input_summary_json", "TEXT")?;
        self.add_column_if_missing("capability_audit_events", "output_summary_json", "TEXT")?;
        self.add_column_if_missing("capability_audit_events", "error_details", "TEXT")?;
        self.add_column_if_missing(
            "workflow_versions",
            "approval_mode",
            "TEXT NOT NULL DEFAULT 'always_review'",
        )?;
        self.add_column_if_missing("workflow_versions", "planner_rationale_json", "TEXT")?;
        Ok(())
    }

    fn deduplicate_workflow_step_runs(&self) -> Result<(), DbError> {
        self.connection.execute(
            "DELETE FROM workflow_step_runs
             WHERE id IN (
               SELECT id
               FROM (
                 SELECT id,
                        ROW_NUMBER() OVER (
                          PARTITION BY workflow_run_id, step_id
                          ORDER BY
                            CASE
                              WHEN status = 'succeeded' AND completed_at IS NOT NULL THEN 0
                              WHEN completed_at IS NOT NULL THEN 1
                              ELSE 2
                            END,
                            started_at,
                            id
                        ) AS duplicate_rank
                 FROM workflow_step_runs
               )
               WHERE duplicate_rank > 1
             )",
            [],
        )?;
        Ok(())
    }

    fn ensure_agent_tool_events_table(&self) -> Result<(), DbError> {
        if !self.table_exists("agent_tool_events")? {
            self.create_agent_tool_events_table("agent_tool_events")?;
            return Ok(());
        }

        if self.agent_tool_events_has_step_run_fk()? {
            return Ok(());
        }

        self.rebuild_agent_tool_events_table()?;
        Ok(())
    }

    fn table_exists(&self, table: &str) -> Result<bool, DbError> {
        let exists = self.connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_master
               WHERE type = 'table' AND name = ?1
             )",
            [table],
            |row| row.get(0),
        )?;
        Ok(exists)
    }

    fn agent_tool_events_has_step_run_fk(&self) -> Result<bool, DbError> {
        let mut statement = self
            .connection
            .prepare("PRAGMA foreign_key_list(agent_tool_events)")?;
        let foreign_keys = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(foreign_keys.iter().any(|(id, seq, table, from, to)| {
            table == "workflow_step_runs"
                && *seq == 0
                && from == "workflow_run_id"
                && to == "workflow_run_id"
                && foreign_keys.iter().any(
                    |(other_id, other_seq, other_table, other_from, other_to)| {
                        other_id == id
                            && *other_seq == 1
                            && other_table == "workflow_step_runs"
                            && other_from == "step_id"
                            && other_to == "step_id"
                    },
                )
        }))
    }

    fn create_agent_tool_events_table(&self, table: &str) -> Result<(), DbError> {
        self.connection.execute_batch(&format!(
            "
            CREATE TABLE {table} (
              id TEXT PRIMARY KEY,
              workflow_run_id TEXT NOT NULL,
              step_id TEXT NOT NULL,
              tool_id TEXT NOT NULL,
              status TEXT NOT NULL,
              input_json TEXT NOT NULL,
              output_json TEXT,
              error TEXT,
              created_at TEXT NOT NULL,
              completed_at TEXT,
              FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
              FOREIGN KEY(workflow_run_id, step_id)
                REFERENCES workflow_step_runs(workflow_run_id, step_id)
            );
            "
        ))?;
        Ok(())
    }

    fn rebuild_agent_tool_events_table(&self) -> Result<(), DbError> {
        let _foreign_keys_disabled = ForeignKeysDisabled::new(&self.connection)?;
        self.connection.execute_batch(
            "
            DROP TABLE IF EXISTS agent_tool_events_hardened;
            ",
        )?;
        self.create_agent_tool_events_table("agent_tool_events_hardened")?;
        self.connection.execute_batch(
            "
            INSERT INTO agent_tool_events_hardened
              (id, workflow_run_id, step_id, tool_id, status, input_json, output_json, error,
               created_at, completed_at)
            SELECT events.id,
                   events.workflow_run_id,
                   events.step_id,
                   events.tool_id,
                   events.status,
                   events.input_json,
                   events.output_json,
                   events.error,
                   events.created_at,
                   events.completed_at
            FROM agent_tool_events events
            INNER JOIN workflow_step_runs steps
              ON steps.workflow_run_id = events.workflow_run_id
             AND steps.step_id = events.step_id;

            DROP TABLE agent_tool_events;
            ALTER TABLE agent_tool_events_hardened RENAME TO agent_tool_events;
            ",
        )?;
        Ok(())
    }

    fn add_column_if_missing(
        &self,
        table: &str,
        column: &str,
        definition: &str,
    ) -> Result<(), DbError> {
        let mut statement = self
            .connection
            .prepare(&format!("PRAGMA table_info({table})"))?;
        let exists = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == column);

        if !exists {
            self.connection.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )?;
        }

        Ok(())
    }

    pub fn seed_defaults(&self) -> Result<(), DbError> {
        let count: i64 =
            self.connection
                .query_row("SELECT COUNT(*) FROM workflows", [], |row| row.get(0))?;
        let now = Utc::now().to_rfc3339();
        if self
            .latest_workflow_version("daily-work-journal")?
            .is_none()
        {
            self.insert_workflow_version(&WorkflowVersion {
                id: "daily-work-journal-v1".into(),
                workflow_id: "daily-work-journal".into(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow::daily_work_journal(),
                created_at: now.clone(),
                approval_mode: None,
                planner_rationale: None,
            })?;
        }
        if self.latest_workflow_version("morning-brief")?.is_none() {
            self.insert_workflow_version(&WorkflowVersion {
                id: "morning-brief-v1".into(),
                workflow_id: "morning-brief".into(),
                version: 1,
                status: WorkflowStatus::Draft,
                definition: workflow::morning_brief(),
                created_at: now.clone(),
                approval_mode: None,
                planner_rationale: None,
            })?;
        }
        if self.latest_workflow_version("current-weather")?.is_none() {
            self.insert_workflow_version(&WorkflowVersion {
                id: "current-weather-v1".into(),
                workflow_id: "current-weather".into(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow::current_weather(),
                created_at: now.clone(),
                approval_mode: None,
                planner_rationale: None,
            })?;
        }
        self.upgrade_legacy_current_weather_seed(&now)?;
        self.connection.execute(
            "INSERT OR REPLACE INTO llm_profiles
             (id, provider_id, model, effort, supports_structured_outputs)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["default-openai", "openai", "gpt-4.1", "medium", 1],
        )?;
        if count == 0 {
            self.connection.execute(
                "INSERT OR REPLACE INTO settings (key, value_json) VALUES (?1, ?2)",
                params!["theme", serde_json::json!("aurora-dark").to_string()],
            )?;
        }
        Ok(())
    }

    fn upgrade_legacy_current_weather_seed(&self, now: &str) -> Result<(), DbError> {
        let Some(latest) = self.latest_workflow_version("current-weather")? else {
            return Ok(());
        };
        if !is_legacy_open_meteo_current_weather(&latest.definition) {
            return Ok(());
        }

        let next_version: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM workflow_versions WHERE workflow_id = ?1",
            params!["current-weather"],
            |row| row.get(0),
        )?;
        self.insert_workflow_version(&WorkflowVersion {
            id: format!("current-weather-v{next_version}"),
            workflow_id: "current-weather".into(),
            version: next_version,
            status: latest.status,
            definition: workflow::current_weather(),
            created_at: now.to_string(),
            approval_mode: None,
            planner_rationale: None,
        })?;
        Ok(())
    }

    pub fn app_state(&self) -> Result<AppState, DbError> {
        Ok(AppState {
            workflows: self.workflow_versions()?,
            runs: self.workflow_runs()?,
            artifacts: self.artifacts()?,
            schedule_overrides: self.schedule_overrides()?,
            providers: self.dynamic_registry_health()?,
            llm_profiles: self.llm_profiles()?,
            agent_auth_profiles: self.agent_auth_profiles()?,
        })
    }

    pub fn agent_auth_profiles(&self) -> Result<Vec<agent_auth::AgentAuthProfile>, DbError> {
        let mut profiles = agent_auth::default_agent_auth_profiles();
        for profile in &mut profiles {
            match profile.runner_kind {
                agent_auth::AgentRunnerKind::OpenAiApi => {
                    if let Some(credential_ref) =
                        self.agent_provider_credential_ref("openai-api-key")?
                    {
                        profile.status = "available".into();
                        profile.auth_mode = agent_auth::AgentAuthMode::ApiKeyKeychain;
                        profile.credential_ref = credential_ref;
                    }
                }
                agent_auth::AgentRunnerKind::AnthropicApi => {
                    if let Some(credential_ref) =
                        self.agent_provider_credential_ref("anthropic-api-key")?
                    {
                        profile.status = "available".into();
                        profile.auth_mode = agent_auth::AgentAuthMode::ApiKeyKeychain;
                        profile.credential_ref = credential_ref;
                    }
                }
                agent_auth::AgentRunnerKind::CodexCli
                | agent_auth::AgentRunnerKind::ClaudeCodeCli
                | agent_auth::AgentRunnerKind::OllamaLocal => {}
            }
        }
        Ok(profiles)
    }

    fn agent_provider_credential_ref(&self, account_id: &str) -> Result<Option<String>, DbError> {
        let Some(account) = self.provider_account(account_id)? else {
            return Ok(None);
        };
        let available = self
            .resolve_credential_reference(&account.credential_ref)?
            .is_some_and(|secret| !secret.trim().is_empty());
        Ok(if available {
            Some(account.credential_ref)
        } else {
            None
        })
    }

    pub fn dynamic_registry_health(&self) -> Result<Vec<ProviderHealth>, DbError> {
        let mut health = providers::registry_health();
        for entry in &mut health {
            match entry.id.as_str() {
                "ai_chat_import" => {
                    if let Ok(Some(setting)) = self.setting_json("context_provider:ai_chat_import")
                    {
                        if setting
                            .get("folder_path")
                            .and_then(|v| v.as_str())
                            .is_some_and(|v| !v.is_empty() && Path::new(v).is_dir())
                        {
                            entry.status = ProviderStatus::Available;
                            entry.summary = format!(
                                "Imports AI chat exports from {}.",
                                setting["folder_path"].as_str().unwrap_or("")
                            );
                        }
                    }
                }
                "document_import" => {
                    if let Ok(Some(setting)) = self.setting_json("context_provider:document_import")
                    {
                        if let Some(folder_path) = setting
                            .get("folder_path")
                            .and_then(|v| v.as_str())
                            .filter(|v| !v.is_empty() && Path::new(v).is_dir())
                        {
                            *entry = providers::DocumentImportProvider::new(folder_path).status();
                        }
                    }
                }
                "github" => {
                    if let Ok(Some(setting)) = self.setting_json("context_provider:github") {
                        let has_slug = setting
                            .get("repo_slug")
                            .and_then(|v| v.as_str())
                            .is_some_and(|v| !v.trim().is_empty());
                        let has_token = self.github_token().ok().flatten().is_some();
                        if has_slug && has_token {
                            entry.status = ProviderStatus::Available;
                            entry.summary = format!(
                                "Reads pull request and issue context for {}.",
                                setting["repo_slug"].as_str().unwrap_or("")
                            );
                        } else if has_slug {
                            entry.status = ProviderStatus::NeedsConfig;
                            entry.summary = format!(
                                "GitHub repo {} configured but token is missing.",
                                setting["repo_slug"].as_str().unwrap_or("")
                            );
                        }
                    }
                }
                "markdown_folder" => {
                    if let Ok(Some(setting)) =
                        self.setting_json("artifact_destination:markdown_folder")
                    {
                        if setting
                            .get("folder_path")
                            .and_then(|v| v.as_str())
                            .is_some_and(|v| !v.is_empty() && Path::new(v).is_dir())
                        {
                            entry.status = ProviderStatus::Available;
                            entry.summary = format!(
                                "Exports Markdown artifacts to {}.",
                                setting["folder_path"].as_str().unwrap_or("")
                            );
                        }
                    }
                }
                "obsidian_vault" => {
                    if let Ok(Some(setting)) =
                        self.setting_json("artifact_destination:obsidian_vault")
                    {
                        if setting
                            .get("folder_path")
                            .and_then(|v| v.as_str())
                            .is_some_and(|v| !v.is_empty() && Path::new(v).is_dir())
                        {
                            entry.status = ProviderStatus::Available;
                            entry.summary = format!(
                                "Writes artifacts into Obsidian vault at {}.",
                                setting["folder_path"].as_str().unwrap_or("")
                            );
                        }
                    }
                }
                "nestweaver" => {
                    if self.setting_json("context_provider:nestweaver")?.is_some() {
                        *entry = self.nestweaver_health_check()?;
                    }
                }
                _ => {}
            }
        }
        Ok(health)
    }

    pub fn workflow_versions(&self) -> Result<Vec<WorkflowVersion>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, workflow_id, version, status, definition_json, created_at, approval_mode, planner_rationale_json
             FROM workflow_versions current
             WHERE version = (
               SELECT MAX(version)
               FROM workflow_versions latest
               WHERE latest.workflow_id = current.workflow_id
             )
             ORDER BY created_at DESC",
        )?;
        let versions = statement
            .query_map([], |row| {
                let status: String = row.get(3)?;
                let definition_json: String = row.get(4)?;
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    status,
                    definition_json,
                    row.get(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })?
            .map(|row| {
                let (
                    id,
                    workflow_id,
                    version,
                    status,
                    definition_json,
                    created_at,
                    approval_mode,
                    planner_rationale_json,
                ): (
                    String,
                    String,
                    i64,
                    String,
                    String,
                    String,
                    Option<String>,
                    Option<String>,
                ) = row?;
                Ok(WorkflowVersion {
                    id,
                    workflow_id,
                    version,
                    status: parse_workflow_status(&status),
                    definition: serde_json::from_str(&definition_json)?,
                    created_at,
                    approval_mode,
                    planner_rationale: planner_rationale_json
                        .map(|json| serde_json::from_str(&json))
                        .transpose()?,
                })
            })
            .collect::<Result<Vec<_>, DbError>>()?;
        Ok(versions)
    }

    pub fn latest_workflow_version(
        &self,
        workflow_id: &str,
    ) -> Result<Option<WorkflowVersion>, DbError> {
        let row = self
            .connection
            .query_row(
                "SELECT id, workflow_id, version, status, definition_json, created_at, approval_mode, planner_rationale_json
                 FROM workflow_versions
                 WHERE workflow_id = ?1
                 ORDER BY version DESC
                 LIMIT 1",
                params![workflow_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .optional()?;

        row.map(
            |(
                id,
                workflow_id,
                version,
                status,
                definition_json,
                created_at,
                approval_mode,
                planner_rationale_json,
            )| {
                Ok(WorkflowVersion {
                    id,
                    workflow_id,
                    version,
                    status: parse_workflow_status(&status),
                    definition: serde_json::from_str(&definition_json)?,
                    created_at,
                    approval_mode,
                    planner_rationale: planner_rationale_json
                        .map(|json| serde_json::from_str(&json))
                        .transpose()?,
                })
            },
        )
        .transpose()
    }

    pub fn workflow_version_by_id(
        &self,
        version_id: &str,
    ) -> Result<Option<WorkflowVersion>, DbError> {
        let row = self
            .connection
            .query_row(
                "SELECT id, workflow_id, version, status, definition_json, created_at, approval_mode, planner_rationale_json
                 FROM workflow_versions
                 WHERE id = ?1
                 LIMIT 1",
                params![version_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .optional()?;

        row.map(
            |(
                id,
                workflow_id,
                version,
                status,
                definition_json,
                created_at,
                approval_mode,
                planner_rationale_json,
            )| {
                Ok(WorkflowVersion {
                    id,
                    workflow_id,
                    version,
                    status: parse_workflow_status(&status),
                    definition: serde_json::from_str(&definition_json)?,
                    created_at,
                    approval_mode,
                    planner_rationale: planner_rationale_json
                        .map(|json| serde_json::from_str(&json))
                        .transpose()?,
                })
            },
        )
        .transpose()
    }

    pub fn update_workflow_safe_fields(
        &mut self,
        workflow_id: &str,
        status: WorkflowStatus,
        cadence: &str,
        local_time: Option<&str>,
        approval_mode: Option<&str>,
        llm_profile_ref: Option<&str>,
    ) -> Result<WorkflowVersion, DbError> {
        if !matches!(cadence, "manual" | "daily" | "weekdays") {
            return Err(DbError::InvalidWorkflowEdit(format!(
                "unsupported cadence {cadence}"
            )));
        }

        let normalized_time = local_time
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| {
                    DbError::InvalidWorkflowEdit(format!(
                        "local time must use HH:MM format, got {value}"
                    ))
                })?;
                Ok::<String, DbError>(value.to_string())
            })
            .transpose()?;

        let latest = self.latest_workflow_version(workflow_id)?.ok_or_else(|| {
            DbError::InvalidWorkflowEdit(format!("unknown workflow {workflow_id}"))
        })?;
        let next_version: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM workflow_versions WHERE workflow_id = ?1",
            params![workflow_id],
            |row| row.get(0),
        )?;
        let now = Utc::now().to_rfc3339();
        let mut definition = latest.definition;
        definition.schedule = Some(crate::models::WorkflowScheduleDefinition {
            cadence: cadence.to_string(),
            local_time: normalized_time.clone(),
        });
        if let Some(profile_ref) = llm_profile_ref {
            definition.defaults.llm_profile_ref = profile_ref.to_string();
            for step in &mut definition.steps {
                if step.kind == crate::models::WorkflowStepKind::AgentTask
                    || step.llm_profile_ref.is_some()
                {
                    step.llm_profile_ref = Some(profile_ref.to_string());
                }
            }
        }
        workflow::validate_workflow(&definition)
            .map_err(|error| DbError::InvalidWorkflowEdit(format!("validation failed: {error}")))?;

        let resolved_approval_mode = approval_mode
            .map(|s| s.to_string())
            .or_else(|| latest.approval_mode.clone());
        let planner_rationale = latest.planner_rationale.clone();

        let edited = WorkflowVersion {
            id: format!("{workflow_id}-v{next_version}"),
            workflow_id: workflow_id.to_string(),
            version: next_version,
            status,
            definition,
            created_at: now.clone(),
            approval_mode: resolved_approval_mode,
            planner_rationale,
        };

        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT OR REPLACE INTO workflows (id, name, status, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                edited.workflow_id,
                edited.definition.name,
                format!("{:?}", edited.status).to_lowercase(),
                now
            ],
        )?;
        transaction.execute(
            "INSERT INTO workflow_versions
             (id, workflow_id, version, status, definition_json, created_at, approval_mode, planner_rationale_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                edited.id,
                edited.workflow_id,
                edited.version,
                format!("{:?}", edited.status).to_lowercase(),
                serde_json::to_string(&edited.definition)?,
                edited.created_at,
                edited.approval_mode,
                edited
                    .planner_rationale
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?
            ],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO schedules (id, workflow_id, cadence, local_time, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                format!("schedule-{workflow_id}"),
                workflow_id,
                cadence,
                normalized_time,
                i64::from(edited.status == WorkflowStatus::Enabled && cadence != "manual")
            ],
        )?;
        transaction.execute(
            "INSERT INTO audit_events (id, event_type, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                format!("audit-{}", uuid::Uuid::new_v4()),
                "workflow_safe_fields_updated",
                serde_json::json!({
                    "workflow_id": workflow_id,
                    "version": edited.version,
                    "status": format!("{:?}", edited.status).to_lowercase(),
                    "cadence": cadence,
                    "local_time": edited.definition.schedule.as_ref().and_then(|schedule| schedule.local_time.clone())
                })
                .to_string(),
                Utc::now().to_rfc3339()
            ],
        )?;
        transaction.commit()?;

        Ok(edited)
    }

    pub fn install_workflow_template(
        &mut self,
        definition: RavenWorkflow,
        status: WorkflowStatus,
        approval_mode: Option<&str>,
        planner_rationale: Option<crate::planner::operations::OperationPlan>,
    ) -> Result<WorkflowVersion, DbError> {
        self.create_workflow_version(definition, status, approval_mode, planner_rationale)
    }

    pub fn create_workflow_version(
        &mut self,
        definition: RavenWorkflow,
        status: WorkflowStatus,
        approval_mode: Option<&str>,
        planner_rationale: Option<crate::planner::operations::OperationPlan>,
    ) -> Result<WorkflowVersion, DbError> {
        if definition.id.trim().is_empty() {
            return Err(DbError::InvalidWorkflowEdit(
                "workflow id cannot be empty".into(),
            ));
        }

        workflow::validate_workflow(&definition)
            .map_err(|error| DbError::InvalidWorkflowEdit(format!("validation failed: {error}")))?;

        let latest = self.latest_workflow_version(&definition.id)?;
        let next_version: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM workflow_versions WHERE workflow_id = ?1",
            params![definition.id],
            |row| row.get(0),
        )?;
        let now = Utc::now().to_rfc3339();
        let resolved_approval_mode = approval_mode
            .map(str::to_string)
            .or_else(|| latest.and_then(|version| version.approval_mode));
        let version = WorkflowVersion {
            id: format!("{}-v{}", definition.id, next_version),
            workflow_id: definition.id.clone(),
            version: next_version,
            status,
            definition,
            created_at: now.clone(),
            approval_mode: resolved_approval_mode,
            planner_rationale,
        };
        let schedule = version.definition.schedule.clone();

        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT OR REPLACE INTO workflows (id, name, status, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                &version.workflow_id,
                &version.definition.name,
                format!("{:?}", version.status).to_lowercase(),
                &now
            ],
        )?;
        transaction.execute(
            "INSERT INTO workflow_versions
             (id, workflow_id, version, status, definition_json, created_at, approval_mode, planner_rationale_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &version.id,
                &version.workflow_id,
                version.version,
                format!("{:?}", version.status).to_lowercase(),
                serde_json::to_string(&version.definition)?,
                &version.created_at,
                &version.approval_mode,
                version
                    .planner_rationale
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?
            ],
        )?;
        if let Some(schedule) = schedule {
            let schedule_enabled =
                version.status == WorkflowStatus::Enabled && schedule.cadence != "manual";
            transaction.execute(
                "INSERT OR REPLACE INTO schedules (id, workflow_id, cadence, local_time, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    format!("schedule-{}", version.workflow_id),
                    &version.workflow_id,
                    &schedule.cadence,
                    &schedule.local_time,
                    i64::from(schedule_enabled)
                ],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM schedules WHERE workflow_id = ?1",
                params![&version.workflow_id],
            )?;
        }
        transaction.execute(
            "INSERT INTO audit_events (id, event_type, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                format!("audit-{}", uuid::Uuid::new_v4()),
                "workflow_version_created",
                serde_json::json!({
                    "workflow_id": version.workflow_id,
                    "version": version.version,
                    "status": format!("{:?}", version.status).to_lowercase()
                })
                .to_string(),
                Utc::now().to_rfc3339()
            ],
        )?;
        transaction.commit()?;

        Ok(version)
    }

    pub fn archive_workflow(&mut self, workflow_id: &str) -> Result<WorkflowVersion, DbError> {
        let latest = self.latest_workflow_version(workflow_id)?.ok_or_else(|| {
            DbError::InvalidWorkflowEdit(format!("unknown workflow {workflow_id}"))
        })?;

        self.create_workflow_version(
            latest.definition,
            WorkflowStatus::Disabled,
            latest.approval_mode.as_deref(),
            latest.planner_rationale,
        )
    }

    pub fn insert_workflow_version(&self, version: &WorkflowVersion) -> Result<(), DbError> {
        self.connection.execute(
            "INSERT OR IGNORE INTO workflows (id, name, status, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                version.workflow_id,
                version.definition.name,
                format!("{:?}", version.status).to_lowercase(),
                version.created_at
            ],
        )?;
        self.connection.execute(
            "INSERT OR REPLACE INTO workflow_versions
             (id, workflow_id, version, status, definition_json, created_at, approval_mode, planner_rationale_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                version.id,
                version.workflow_id,
                version.version,
                format!("{:?}", version.status).to_lowercase(),
                serde_json::to_string(&version.definition)?,
                version.created_at,
                version.approval_mode.as_deref().unwrap_or("auto_approve"),
                version
                    .planner_rationale
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?
            ],
        )?;
        Ok(())
    }

    pub fn approve_workflow_draft(
        &mut self,
        draft: &WorkflowDraft,
    ) -> Result<WorkflowVersion, DbError> {
        workflow::validate_workflow(&draft.definition).map_err(|error| {
            DbError::Json(serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                error.to_string(),
            )))
        })?;
        let next_version: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM workflow_versions WHERE workflow_id = ?1",
            params![draft.definition.id],
            |row| row.get(0),
        )?;
        let version = WorkflowVersion {
            id: format!("{}-v{}", draft.definition.id, next_version),
            workflow_id: draft.definition.id.clone(),
            version: next_version,
            status: WorkflowStatus::Enabled,
            definition: draft.definition.clone(),
            created_at: draft.created_at.clone(),
            approval_mode: Some(
                draft
                    .approval_mode
                    .clone()
                    .unwrap_or_else(|| "always_review".into()),
            ),
            planner_rationale: draft.planner_rationale.clone(),
        };
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT OR REPLACE INTO workflow_drafts
             (id, prompt, summary, permission_changes_json, destination_writes_json, diff_json,
              validation_status, approval_status, builder_profile_id, validation_errors_json,
              planner_rationale_json, definition_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                draft.id,
                draft.prompt,
                draft.summary,
                serde_json::to_string(&draft.permission_changes)?,
                serde_json::to_string(&draft.destination_writes)?,
                draft.diff_json.to_string(),
                draft.validation_status,
                draft.approval_status,
                draft.builder_profile_id,
                serde_json::to_string(&draft.validation_errors)?,
                draft
                    .planner_rationale
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                serde_json::to_string(&draft.definition)?,
                draft.created_at
            ],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO workflows (id, name, status, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                draft.definition.id,
                draft.definition.name,
                "enabled",
                draft.created_at
            ],
        )?;
        transaction.execute(
            "INSERT INTO workflow_versions
             (id, workflow_id, version, status, definition_json, created_at, approval_mode, planner_rationale_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &version.id,
                &version.workflow_id,
                version.version,
                "enabled",
                serde_json::to_string(&version.definition)?,
                &version.created_at,
                &version.approval_mode,
                version
                    .planner_rationale
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?
            ],
        )?;
        transaction.execute(
            "INSERT INTO audit_events (id, event_type, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                format!("audit-{}", uuid::Uuid::new_v4()),
                "workflow_draft_approved",
                serde_json::json!({ "draft_id": draft.id }).to_string(),
                Utc::now().to_rfc3339()
            ],
        )?;
        transaction.commit()?;
        Ok(version)
    }

    pub fn configure_provider_account(
        &mut self,
        mut account: ProviderAccount,
        raw_secret: Option<&str>,
    ) -> Result<ProviderAccount, DbError> {
        validate_provider_account_id(&account.id)?;
        if let Some(secret) = raw_secret {
            account.credential_ref = self.store_secret_reference(&account.id, secret)?;
        }
        self.insert_provider_account(&account)?;
        Ok(account)
    }

    fn store_secret_reference(&self, account_id: &str, secret: &str) -> Result<String, DbError> {
        validate_provider_account_id(account_id)?;
        #[cfg(test)]
        let force_file_store = true;
        #[cfg(not(test))]
        let force_file_store = false;

        if !force_file_store
            && std::env::var("RAVEN_CREDENTIAL_STORE").ok().as_deref() != Some("file")
        {
            if let Some(reference) = store_macos_keychain_secret(account_id, secret) {
                return Ok(reference);
            }
        }

        let credential_dir = self
            .artifacts_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("credentials");
        fs::create_dir_all(&credential_dir)?;
        let credential_path = credential_dir.join(format!("{account_id}.credential"));
        fs::write(&credential_path, secret)?;
        restrict_file_permissions(&credential_path)?;
        Ok(format!("credential-file:{account_id}"))
    }

    pub fn insert_provider_account(&self, account: &ProviderAccount) -> Result<(), DbError> {
        validate_provider_account_id(&account.id)?;
        if looks_like_raw_secret(&account.credential_ref) {
            return Err(DbError::RawCredential);
        }
        self.connection.execute(
            "INSERT OR REPLACE INTO provider_accounts
             (id, provider_kind, display_name, credential_ref, settings_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                account.id,
                format!("{:?}", account.provider_kind).to_lowercase(),
                account.display_name,
                account.credential_ref,
                account.settings_json.to_string()
            ],
        )?;
        Ok(())
    }

    pub fn set_setting(&self, key: &str, value: serde_json::Value) -> Result<(), DbError> {
        self.connection.execute(
            "INSERT OR REPLACE INTO settings (key, value_json) VALUES (?1, ?2)",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    pub fn dock_visible(&self) -> Result<bool, DbError> {
        self.setting_json("dock_visible")
            .map(|opt| opt.and_then(|v| v.as_bool()).unwrap_or(false))
    }

    pub fn set_dock_visible(&self, visible: bool) -> Result<(), DbError> {
        self.set_setting("dock_visible", serde_json::json!(visible))
    }

    pub fn onboarding_completed(&self) -> Result<bool, DbError> {
        self.setting_json("onboarding_completed")
            .map(|opt| opt.and_then(|v| v.as_bool()).unwrap_or(false))
    }

    pub fn set_onboarding_completed(&self) -> Result<(), DbError> {
        self.set_setting("onboarding_completed", serde_json::json!(true))
    }

    pub fn global_shortcut(&self) -> Result<String, DbError> {
        self.setting_json("global_shortcut").map(|opt| {
            opt.and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "CmdOrCtrl+Shift+R".to_string())
        })
    }

    pub fn set_global_shortcut(&self, shortcut: &str) -> Result<(), DbError> {
        self.set_setting("global_shortcut", serde_json::json!(shortcut))
    }

    pub fn recent_workflows(&self, limit: usize) -> Result<Vec<(String, String)>, DbError> {
        let mut stmt = self.connection.prepare(
            "SELECT w.id, w.name
             FROM workflows w
             JOIN workflow_runs r ON r.workflow_id = w.id
             GROUP BY w.id
             ORDER BY MAX(r.started_at) DESC
             LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn configure_artifact_destination(
        &self,
        destination_id: &str,
        folder_path: impl AsRef<Path>,
    ) -> Result<(), DbError> {
        let folder_path = folder_path.as_ref();
        fs::create_dir_all(folder_path)?;
        self.set_setting(
            &format!("artifact_destination:{destination_id}"),
            serde_json::json!({
                "folder_path": folder_path.to_string_lossy()
            }),
        )
    }

    pub fn configure_ai_chat_import_folder(
        &self,
        folder_path: impl AsRef<Path>,
    ) -> Result<(), DbError> {
        let folder_path = folder_path.as_ref();
        fs::create_dir_all(folder_path)?;
        self.set_setting(
            "context_provider:ai_chat_import",
            serde_json::json!({
                "folder_path": folder_path.to_string_lossy()
            }),
        )
    }

    pub fn scan_ai_chat_import_folder(&self) -> Result<providers::ContextPack, DbError> {
        let setting = self
            .setting_json("context_provider:ai_chat_import")?
            .ok_or_else(|| DbError::MissingContextProviderConfig("ai_chat_import".into()))?;
        let folder_path = setting
            .get("folder_path")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DbError::MissingContextProviderConfig("ai_chat_import".into()))?;
        let pack = providers::AiChatImportProvider::new(folder_path)
            .context_pack(Path::new("."))
            .map_err(|error| {
                DbError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    error.to_string(),
                ))
            })?;

        self.connection.execute(
            "INSERT INTO context_artifacts (id, provider_id, content_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                format!("context-artifact-{}", uuid::Uuid::new_v4()),
                "ai_chat_import",
                serde_json::to_string(&pack)?,
                Utc::now().to_rfc3339()
            ],
        )?;

        Ok(pack)
    }

    pub fn configure_document_import_folder(
        &self,
        folder_path: impl AsRef<Path>,
    ) -> Result<(), DbError> {
        let folder_path = folder_path.as_ref();
        fs::create_dir_all(folder_path)?;
        self.set_setting(
            "context_provider:document_import",
            serde_json::json!({
                "folder_path": folder_path.to_string_lossy(),
                "document_type": "pdf",
                "ocr": "pdftoppm+tesseract"
            }),
        )
    }

    pub fn scan_document_import_folder(&self) -> Result<providers::ContextPack, DbError> {
        let setting = self
            .setting_json("context_provider:document_import")?
            .ok_or_else(|| DbError::MissingContextProviderConfig("document_import".into()))?;
        let folder_path = setting
            .get("folder_path")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DbError::MissingContextProviderConfig("document_import".into()))?;
        let pack = providers::DocumentImportProvider::new(folder_path)
            .context_pack(Path::new("."))
            .map_err(|error| {
                DbError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    error.to_string(),
                ))
            })?;

        self.connection.execute(
            "INSERT INTO context_artifacts (id, provider_id, content_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                format!("context-artifact-{}", uuid::Uuid::new_v4()),
                "document_import",
                serde_json::to_string(&pack)?,
                Utc::now().to_rfc3339()
            ],
        )?;

        Ok(pack)
    }

    pub fn configure_github_context(&self, repo_slug: &str) -> Result<(), DbError> {
        self.set_setting(
            "context_provider:github",
            serde_json::json!({
                "repo_slug": repo_slug.trim()
            }),
        )
    }

    pub fn scan_github_context(&self) -> Result<providers::ContextPack, DbError> {
        let setting = self
            .setting_json("context_provider:github")?
            .ok_or_else(|| DbError::MissingContextProviderConfig("github".into()))?;
        let repo_slug = setting
            .get("repo_slug")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| DbError::MissingContextProviderConfig("github".into()))?;

        let token = self.github_token()?;
        let pack = if token.is_some() {
            providers::GitHubContextProvider::new(repo_slug, token)
                .context_pack(Path::new("."))
                .map_err(|error| {
                    DbError::Io(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        error.to_string(),
                    ))
                })?
        } else {
            providers::ContextPack {
                summary: format!(
                    "GitHub context for {repo_slug} needs a configured token. Falling back to Local Git."
                ),
                source_refs: vec![format!("github:{repo_slug}:needs_config")],
            }
        };

        self.connection.execute(
            "INSERT INTO context_artifacts (id, provider_id, content_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                format!("context-artifact-{}", uuid::Uuid::new_v4()),
                "github",
                serde_json::to_string(&pack)?,
                Utc::now().to_rfc3339()
            ],
        )?;

        Ok(pack)
    }

    pub fn configure_nestweaver(
        &self,
        binary_path: &str,
        db_path: Option<&str>,
        project: Option<&str>,
        token_budget: usize,
    ) -> Result<(), DbError> {
        self.set_setting(
            "context_provider:nestweaver",
            serde_json::json!({
                "binary_path": if binary_path.trim().is_empty() { "nestweaver" } else { binary_path.trim() },
                "db_path": db_path.filter(|value| !value.trim().is_empty()),
                "project": project.filter(|value| !value.trim().is_empty()),
                "token_budget": token_budget.max(500)
            }),
        )
    }

    pub fn nestweaver_health_check(&self) -> Result<ProviderHealth, DbError> {
        Ok(self
            .nestweaver_cli_provider()?
            .map(|provider| provider.status())
            .unwrap_or_else(|| providers::NestWeaverProvider.status()))
    }

    pub fn nestweaver_context_pack(
        &self,
        project_root: &Path,
    ) -> Result<providers::ContextPack, DbError> {
        let provider_result = if let Some(provider) = self.nestweaver_cli_provider()? {
            provider
                .context_pack(project_root)
                .or_else(|_| providers::LocalGitProvider.context_pack(project_root))
        } else {
            providers::LocalGitProvider.context_pack(project_root)
        };
        let pack = provider_result.map_err(|error| {
            DbError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                error.to_string(),
            ))
        })?;
        self.connection.execute(
            "INSERT INTO context_artifacts (id, provider_id, content_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                format!("context-artifact-{}", uuid::Uuid::new_v4()),
                "nestweaver",
                serde_json::to_string(&pack)?,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(pack)
    }

    pub fn gather_all_context(
        &self,
        project_root: &Path,
    ) -> Result<providers::ContextPack, DbError> {
        let base = self.nestweaver_context_pack(project_root)?;
        let mut summary_parts = vec![base.summary];
        let mut source_refs = base.source_refs;

        if let Ok(Some(_)) = self.setting_json("context_provider:ai_chat_import") {
            if let Ok(pack) = self.scan_ai_chat_import_folder() {
                if !pack.summary.starts_with("No supported") {
                    summary_parts.push(pack.summary);
                    source_refs.extend(pack.source_refs);
                }
            }
        }

        if let Ok(Some(_)) = self.setting_json("context_provider:document_import") {
            if let Ok(pack) = self.scan_document_import_folder() {
                if !pack.summary.starts_with("No readable") {
                    summary_parts.push(pack.summary);
                    source_refs.extend(pack.source_refs);
                }
            }
        }

        if let Ok(Some(_)) = self.setting_json("context_provider:github") {
            if let Ok(pack) = self.scan_github_context() {
                summary_parts.push(pack.summary);
                source_refs.extend(pack.source_refs);
            }
        }

        Ok(providers::ContextPack {
            summary: summary_parts.join("\n\n---\n\n"),
            source_refs,
        })
    }

    fn nestweaver_cli_provider(&self) -> Result<Option<providers::NestWeaverCliProvider>, DbError> {
        let Some(setting) = self.setting_json("context_provider:nestweaver")? else {
            return Ok(None);
        };
        let binary_path = setting
            .get("binary_path")
            .and_then(|value| value.as_str())
            .unwrap_or("nestweaver");
        let db_path = setting
            .get("db_path")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let project = setting
            .get("project")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let token_budget = setting
            .get("token_budget")
            .and_then(|value| value.as_u64())
            .unwrap_or(4000) as usize;

        Ok(Some(providers::NestWeaverCliProvider::new(
            binary_path,
            db_path,
            project,
            token_budget,
        )))
    }

    fn github_token(&self) -> Result<Option<String>, DbError> {
        if let Ok(token) = std::env::var("GITHUB_TOKEN") {
            if !token.trim().is_empty() {
                return Ok(Some(token));
            }
        }

        let account = self.provider_account("github-api-key")?;
        account
            .map(|account| self.resolve_credential_reference(&account.credential_ref))
            .transpose()
            .map(Option::flatten)
    }

    pub fn provider_account(&self, id: &str) -> Result<Option<ProviderAccount>, DbError> {
        self.connection
            .query_row(
                "SELECT id, provider_kind, display_name, credential_ref, settings_json
                 FROM provider_accounts WHERE id = ?1",
                params![id],
                |row| {
                    let provider_kind: String = row.get(1)?;
                    let settings_json: String = row.get(4)?;
                    Ok(ProviderAccount {
                        id: row.get(0)?,
                        provider_kind: parse_provider_kind(&provider_kind),
                        display_name: row.get(2)?,
                        credential_ref: row.get(3)?,
                        settings_json: serde_json::from_str(&settings_json)
                            .unwrap_or_else(|_| serde_json::json!({})),
                    })
                },
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn resolve_credential_reference(
        &self,
        credential_ref: &str,
    ) -> Result<Option<String>, DbError> {
        if let Some(env_name) = credential_ref.strip_prefix("env:") {
            return Ok(std::env::var(env_name)
                .ok()
                .filter(|value| !value.trim().is_empty()));
        }

        if let Some(account_id) = credential_ref.strip_prefix("credential-file:") {
            validate_provider_account_id(account_id)?;
            let credential_path = self
                .artifacts_dir
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("credentials")
                .join(format!("{account_id}.credential"));
            return fs::read_to_string(credential_path)
                .map(|value| Some(value.trim().to_string()))
                .map_err(DbError::from);
        }
        if let Some(account_id) = credential_ref.strip_prefix("keychain:macos:") {
            validate_provider_account_id(account_id)?;
        }

        Ok(read_macos_keychain_secret(credential_ref))
    }

    pub fn resolve_llm_credential(
        &self,
        profile_id: &str,
    ) -> Result<Option<ResolvedLlmCredential>, DbError> {
        let Some(profile) = self.llm_profile(profile_id)? else {
            return Ok(None);
        };
        let account_id = provider_account_id_for(&profile.provider_id);
        let credential = if let Some(account) = self.provider_account(account_id)? {
            self.resolve_credential_reference(&account.credential_ref)?
        } else {
            fallback_env_for_provider(&profile.provider_id)
                .and_then(|name| std::env::var(name).ok())
                .filter(|value| !value.trim().is_empty())
        };

        Ok(credential.map(|credential| ResolvedLlmCredential {
            profile_id: profile.id,
            provider_id: profile.provider_id,
            model: profile.model,
            effort: profile.effort,
            credential,
        }))
    }

    pub fn create_run_with_steps(
        &mut self,
        run: &WorkflowRun,
        steps: &[WorkflowStepRun],
    ) -> Result<(), DbError> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO workflow_runs
             (id, workflow_id, workflow_name, status, started_at, completed_at, failure_reason, idempotency_key,
              trigger_kind, retry_count, parent_run_id, error_classification, provider_profile_id,
              blocked_reason, required_provider_id, required_profile_id, setup_action, total_tokens, input_tokens, output_tokens, total_cost_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            params![
                run.id,
                run.workflow_id,
                run.workflow_name,
                format!("{:?}", run.status).to_lowercase(),
                run.started_at,
                run.completed_at,
                run.failure_reason,
                run.idempotency_key,
                run.trigger_kind,
                run.retry_count,
                run.parent_run_id,
                run.error_classification,
                run.provider_profile_id,
                run.blocked_reason,
                run.required_provider_id,
                run.required_profile_id,
                run.setup_action,
                run.total_tokens,
                run.input_tokens,
                run.output_tokens,
                run.total_cost_usd
            ],
        )?;
        for step in steps {
            transaction.execute(
                "INSERT INTO workflow_step_runs
                 (id, workflow_run_id, step_id, status, output_json, error, started_at, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    step.id,
                    step.workflow_run_id,
                    step.step_id,
                    format!("{:?}", step.status).to_lowercase(),
                    step.output_json.as_ref().map(ToString::to_string),
                    step.error,
                    step.started_at,
                    step.completed_at
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn finish_step(&self, step_run_id: &str, output: serde_json::Value) -> Result<(), DbError> {
        self.connection.execute(
            "UPDATE workflow_step_runs
             SET status = ?1, output_json = ?2, completed_at = ?3
             WHERE id = ?4",
            params![
                "succeeded",
                output.to_string(),
                Utc::now().to_rfc3339(),
                step_run_id
            ],
        )?;
        Ok(())
    }

    pub fn fail_step(
        &self,
        step_run_id: &str,
        status: RunStatus,
        error: &str,
    ) -> Result<(), DbError> {
        self.connection.execute(
            "UPDATE workflow_step_runs
             SET status = ?1, error = ?2, completed_at = ?3
             WHERE id = ?4",
            params![
                format!("{:?}", status).to_lowercase(),
                error,
                Utc::now().to_rfc3339(),
                step_run_id
            ],
        )?;
        Ok(())
    }

    pub fn insert_agent_tool_event(&self, event: &AgentToolEvent) -> Result<(), DbError> {
        validate_initial_agent_tool_event(event)?;
        if !self.workflow_step_run_exists(&event.workflow_run_id, &event.step_id)? {
            return Err(DbError::MissingWorkflowStepRun {
                workflow_run_id: event.workflow_run_id.clone(),
                step_id: event.step_id.clone(),
            });
        }
        reject_raw_secret_value(&event.input_json)?;
        if let Some(output_json) = &event.output_json {
            reject_raw_secret_value(output_json)?;
        }
        if let Some(error) = &event.error {
            reject_raw_secret_text(error)?;
        }

        self.connection.execute(
            "INSERT INTO agent_tool_events
             (id, workflow_run_id, step_id, tool_id, status, input_json, output_json, error, created_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                event.id,
                event.workflow_run_id,
                event.step_id,
                event.tool_id,
                agent_tool_event_status_to_str(&event.status),
                event.input_json.to_string(),
                event.output_json.as_ref().map(ToString::to_string),
                event.error,
                event.created_at,
                event.completed_at
            ],
        )?;
        Ok(())
    }

    fn workflow_step_run_exists(
        &self,
        workflow_run_id: &str,
        step_id: &str,
    ) -> Result<bool, DbError> {
        self.connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM workflow_step_runs
                   WHERE workflow_run_id = ?1 AND step_id = ?2
                 )",
                params![workflow_run_id, step_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(DbError::from)
    }

    pub fn complete_agent_tool_event(
        &self,
        event_id: &str,
        status: AgentToolEventStatus,
        output_json: Option<serde_json::Value>,
        error: Option<&str>,
    ) -> Result<(), DbError> {
        if matches!(status, AgentToolEventStatus::Requested) {
            return Err(DbError::InvalidAgentToolEventStatus(
                agent_tool_event_status_to_str(&status).into(),
            ));
        }
        if let Some(output_json) = &output_json {
            reject_raw_secret_value(output_json)?;
        }
        if let Some(error) = error {
            reject_raw_secret_text(error)?;
        }

        let updated = self.connection.execute(
            "UPDATE agent_tool_events
             SET status = ?1, output_json = ?2, error = ?3, completed_at = ?4
             WHERE id = ?5 AND status = 'requested' AND completed_at IS NULL",
            params![
                agent_tool_event_status_to_str(&status),
                output_json.as_ref().map(ToString::to_string),
                error,
                Utc::now().to_rfc3339(),
                event_id
            ],
        )?;
        if updated == 0 {
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_tool_events WHERE id = ?1)",
                params![event_id],
                |row| row.get(0),
            )?;
            if exists {
                return Err(DbError::AgentToolEventAlreadyCompleted(event_id.into()));
            }
            return Err(DbError::MissingAgentToolEvent(event_id.into()));
        }
        Ok(())
    }

    pub fn agent_tool_events_for_run(&self, run_id: &str) -> Result<Vec<AgentToolEvent>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, workflow_run_id, step_id, tool_id, status, input_json, output_json, error, created_at, completed_at
             FROM agent_tool_events
             WHERE workflow_run_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement
            .query_map(params![run_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })?
            .map(|row| {
                let (
                    id,
                    workflow_run_id,
                    step_id,
                    tool_id,
                    status,
                    input_json,
                    output_json,
                    error,
                    created_at,
                    completed_at,
                ) = row?;
                Ok(AgentToolEvent {
                    id,
                    workflow_run_id,
                    step_id,
                    tool_id,
                    status: parse_agent_tool_event_status(&status)?,
                    input_json: serde_json::from_str(&input_json)?,
                    output_json: output_json
                        .map(|value| serde_json::from_str(&value))
                        .transpose()?,
                    error,
                    created_at,
                    completed_at,
                })
            })
            .collect::<Result<Vec<_>, DbError>>()?;
        Ok(rows)
    }

    pub fn workflow_step_runs_for_run(
        &self,
        run_id: &str,
    ) -> Result<Vec<WorkflowStepRun>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, workflow_run_id, step_id, status, output_json, error, started_at, completed_at
             FROM workflow_step_runs
             WHERE workflow_run_id = ?1
             ORDER BY started_at ASC, id ASC",
        )?;
        let rows = statement
            .query_map(params![run_id], |row| {
                let status: String = row.get(3)?;
                let output_json: Option<String> = row.get(4)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    status,
                    output_json,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })?
            .map(|row| {
                let (
                    id,
                    workflow_run_id,
                    step_id,
                    status,
                    output_json,
                    error,
                    started_at,
                    completed_at,
                ) = row?;
                Ok(WorkflowStepRun {
                    id,
                    workflow_run_id,
                    step_id,
                    status: parse_run_status(&status),
                    output_json: output_json
                        .map(|value| serde_json::from_str(&value))
                        .transpose()?,
                    error,
                    started_at,
                    completed_at,
                })
            })
            .collect::<Result<Vec<_>, DbError>>()?;
        Ok(rows)
    }

    pub fn finish_run(
        &self,
        run_id: &str,
        status: RunStatus,
        failure_reason: Option<&str>,
    ) -> Result<(), DbError> {
        self.finish_run_with_totals(run_id, status, failure_reason, None, None)
    }

    pub fn finish_run_with_totals(
        &self,
        run_id: &str,
        status: RunStatus,
        failure_reason: Option<&str>,
        total_tokens: Option<u64>,
        total_cost_usd: Option<f64>,
    ) -> Result<(), DbError> {
        self.finish_run_with_token_usage(
            run_id,
            status,
            failure_reason,
            total_tokens,
            None,
            None,
            total_cost_usd,
        )
    }

    pub fn finish_run_with_token_usage(
        &self,
        run_id: &str,
        status: RunStatus,
        failure_reason: Option<&str>,
        total_tokens: Option<u64>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        total_cost_usd: Option<f64>,
    ) -> Result<(), DbError> {
        let total_tokens = total_tokens.and_then(|value| i64::try_from(value).ok());
        let input_tokens = input_tokens.and_then(|value| i64::try_from(value).ok());
        let output_tokens = output_tokens.and_then(|value| i64::try_from(value).ok());
        self.connection.execute(
            "UPDATE workflow_runs
             SET status = ?1, completed_at = ?2, failure_reason = ?3,
                 blocked_reason = CASE WHEN ?1 = 'blocked' THEN blocked_reason ELSE NULL END,
                 required_provider_id = CASE WHEN ?1 = 'blocked' THEN required_provider_id ELSE NULL END,
                 required_profile_id = CASE WHEN ?1 = 'blocked' THEN required_profile_id ELSE NULL END,
                 setup_action = CASE WHEN ?1 = 'blocked' THEN setup_action ELSE NULL END,
                 total_tokens = COALESCE(?4, total_tokens),
                 input_tokens = COALESCE(?5, input_tokens),
                 output_tokens = COALESCE(?6, output_tokens),
                 total_cost_usd = COALESCE(?7, total_cost_usd)
             WHERE id = ?8",
            params![
                format!("{:?}", status).to_lowercase(),
                Utc::now().to_rfc3339(),
                failure_reason,
                total_tokens,
                input_tokens,
                output_tokens,
                total_cost_usd,
                run_id
            ],
        )?;
        Ok(())
    }

    pub fn finish_run_with_classification(
        &self,
        run_id: &str,
        status: RunStatus,
        failure_reason: Option<&str>,
        error_classification: Option<&str>,
    ) -> Result<(), DbError> {
        self.finish_run_with_classification_and_totals(
            run_id,
            status,
            failure_reason,
            error_classification,
            None,
            None,
        )
    }

    pub fn finish_run_with_classification_and_totals(
        &self,
        run_id: &str,
        status: RunStatus,
        failure_reason: Option<&str>,
        error_classification: Option<&str>,
        total_tokens: Option<u64>,
        total_cost_usd: Option<f64>,
    ) -> Result<(), DbError> {
        let total_tokens = total_tokens.and_then(|value| i64::try_from(value).ok());
        self.connection.execute(
            "UPDATE workflow_runs
             SET status = ?1, completed_at = ?2, failure_reason = ?3, error_classification = ?4,
                 blocked_reason = CASE WHEN ?1 = 'blocked' THEN blocked_reason ELSE NULL END,
                 required_provider_id = CASE WHEN ?1 = 'blocked' THEN required_provider_id ELSE NULL END,
                 required_profile_id = CASE WHEN ?1 = 'blocked' THEN required_profile_id ELSE NULL END,
                 setup_action = CASE WHEN ?1 = 'blocked' THEN setup_action ELSE NULL END,
                 total_tokens = COALESCE(?5, total_tokens),
                 total_cost_usd = COALESCE(?6, total_cost_usd)
             WHERE id = ?7",
            params![
                format!("{:?}", status).to_lowercase(),
                Utc::now().to_rfc3339(),
                failure_reason,
                error_classification,
                total_tokens,
                total_cost_usd,
                run_id
            ],
        )?;
        Ok(())
    }

    pub fn block_run(
        &self,
        run_id: &str,
        blocked_reason: &str,
        required_provider_id: &str,
        required_profile_id: &str,
        setup_action: &str,
    ) -> Result<(), DbError> {
        self.connection.execute(
            "UPDATE workflow_runs
             SET status = ?1, completed_at = ?2, failure_reason = ?3, error_classification = ?4,
                 blocked_reason = ?5, required_provider_id = ?6, required_profile_id = ?7, setup_action = ?8
             WHERE id = ?9",
            params![
                "blocked",
                Utc::now().to_rfc3339(),
                blocked_reason,
                "terminal",
                blocked_reason,
                required_provider_id,
                required_profile_id,
                setup_action,
                run_id
            ],
        )?;
        Ok(())
    }

    pub fn write_artifact(&self, artifact: &Artifact) -> Result<(), DbError> {
        fs::write(&artifact.content_path, &artifact.content_markdown)?;
        fs::write(&artifact.metadata_path, artifact.metadata.to_string())?;
        self.connection.execute(
            "INSERT INTO artifacts
             (id, title, artifact_type, workflow_run_id, content_path, metadata_path, content_markdown, metadata_json, source_refs_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                artifact.id,
                artifact.title,
                artifact.artifact_type,
                artifact.workflow_run_id,
                artifact.content_path,
                artifact.metadata_path,
                artifact.content_markdown,
                artifact.metadata.to_string(),
                serde_json::to_string(&artifact.source_refs)?,
                artifact.created_at
            ],
        )?;
        Ok(())
    }

    pub fn artifact_paths(&self, artifact_id: &str) -> (String, String) {
        (
            self.artifacts_dir
                .join(format!("{artifact_id}.md"))
                .to_string_lossy()
                .to_string(),
            self.artifacts_dir
                .join(format!("{artifact_id}.metadata.json"))
                .to_string_lossy()
                .to_string(),
        )
    }

    pub fn find_run_by_idempotency_key(&self, key: &str) -> Result<Option<WorkflowRun>, DbError> {
        self.connection
            .query_row(
                "SELECT id, workflow_id, workflow_name, status, started_at, completed_at, failure_reason, idempotency_key,
                        trigger_kind, retry_count, parent_run_id, error_classification, provider_profile_id,
                        blocked_reason, required_provider_id, required_profile_id, setup_action,
                        total_tokens, input_tokens, output_tokens, total_cost_usd
                 FROM workflow_runs WHERE idempotency_key = ?1",
                params![key],
                map_run,
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn artifact_for_run(&self, run_id: &str) -> Result<Option<Artifact>, DbError> {
        self.connection
            .query_row(
                "SELECT id, title, artifact_type, workflow_run_id, content_path, metadata_path,
                        content_markdown, metadata_json, source_refs_json, created_at
                 FROM artifacts WHERE workflow_run_id = ?1 LIMIT 1",
                params![run_id],
                map_artifact,
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn workflow_run(&self, run_id: &str) -> Result<Option<WorkflowRun>, DbError> {
        self.connection
            .query_row(
                "SELECT id, workflow_id, workflow_name, status, started_at, completed_at, failure_reason, idempotency_key,
                        trigger_kind, retry_count, parent_run_id, error_classification, provider_profile_id,
                        blocked_reason, required_provider_id, required_profile_id, setup_action,
                        total_tokens, input_tokens, output_tokens, total_cost_usd
                 FROM workflow_runs WHERE id = ?1",
                params![run_id],
                map_run,
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn artifact_by_id(&self, artifact_id: &str) -> Result<Option<Artifact>, DbError> {
        self.connection
            .query_row(
                "SELECT id, title, artifact_type, workflow_run_id, content_path, metadata_path,
                        content_markdown, metadata_json, source_refs_json, created_at
                 FROM artifacts WHERE id = ?1",
                params![artifact_id],
                map_artifact,
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn enabled_scheduled_workflows(&self) -> Result<Vec<WorkflowVersion>, DbError> {
        Ok(self
            .workflow_versions()?
            .into_iter()
            .filter(|version| {
                version.status == WorkflowStatus::Enabled
                    && version.definition.schedule.is_some()
                    && version
                        .definition
                        .schedule
                        .as_ref()
                        .is_some_and(|schedule| schedule.cadence != "manual")
            })
            .collect())
    }

    pub fn schedule_overrides(
        &self,
    ) -> Result<Vec<crate::models::WorkflowScheduleOverride>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, workflow_id, original_run_at, scheduled_run_at, created_at
             FROM schedule_overrides
             ORDER BY scheduled_run_at ASC",
        )?;
        let overrides = statement
            .query_map([], |row| {
                Ok(crate::models::WorkflowScheduleOverride {
                    id: row.get(0)?,
                    workflow_id: row.get(1)?,
                    original_run_at: row.get(2)?,
                    scheduled_run_at: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::from)?;
        Ok(overrides)
    }

    pub fn save_schedule_override(
        &self,
        workflow_id: &str,
        original_run_at: &str,
        scheduled_run_at: &str,
    ) -> Result<crate::models::WorkflowScheduleOverride, DbError> {
        let id = format!("schedule-override-{workflow_id}-{}", uuid::Uuid::new_v4());
        let created_at = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO schedule_overrides (id, workflow_id, original_run_at, scheduled_run_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(workflow_id, original_run_at)
             DO UPDATE SET scheduled_run_at = excluded.scheduled_run_at",
            params![id, workflow_id, original_run_at, scheduled_run_at, created_at],
        )?;
        let override_entry = self
            .schedule_overrides()?
            .into_iter()
            .find(|item| item.workflow_id == workflow_id && item.original_run_at == original_run_at)
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        Ok(override_entry)
    }

    pub fn export_artifact(
        &self,
        artifact_id: &str,
        destination_path: String,
    ) -> Result<String, DbError> {
        let artifact = self
            .artifact_by_id(artifact_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let requested_destination = PathBuf::from(destination_path);
        let destination = if requested_destination.is_absolute() {
            requested_destination
        } else {
            let root = self
                .artifacts_dir
                .parent()
                .unwrap_or_else(|| Path::new("."));
            safe_relative_export_path(root, &requested_destination)?
        };
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&destination, artifact.content_markdown)?;
        Ok(destination.to_string_lossy().to_string())
    }

    pub fn export_artifact_to_destination(
        &self,
        artifact_id: &str,
        destination_id: &str,
    ) -> Result<String, DbError> {
        let artifact = self
            .artifact_by_id(artifact_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let setting = self
            .setting_json(&format!("artifact_destination:{destination_id}"))?
            .ok_or_else(|| DbError::MissingArtifactDestination(destination_id.into()))?;
        let folder_path = setting
            .get("folder_path")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DbError::MissingArtifactDestination(destination_id.into()))?;
        let folder = PathBuf::from(folder_path);
        fs::create_dir_all(&folder)?;
        let folder = folder.canonicalize()?;
        let destination = safe_child_path(&folder, &format!("{}.md", slugify(&artifact.title)))?;
        let content = match destination_id {
            "obsidian_vault" => obsidian_artifact_markdown(&artifact),
            _ => artifact.content_markdown,
        };
        fs::write(&destination, content)?;
        Ok(destination.to_string_lossy().to_string())
    }

    pub fn setting_json(&self, key: &str) -> Result<Option<serde_json::Value>, DbError> {
        self.connection
            .query_row(
                "SELECT value_json FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| serde_json::from_str(&value).map_err(DbError::from))
            .transpose()
    }

    pub fn saved_context_settings(&self) -> Result<serde_json::Value, DbError> {
        let nw = self
            .setting_json("context_provider:nestweaver")?
            .unwrap_or(serde_json::json!(null));
        let gh = self
            .setting_json("context_provider:github")?
            .unwrap_or(serde_json::json!(null));
        let ai = self
            .setting_json("context_provider:ai_chat_import")?
            .unwrap_or(serde_json::json!(null));
        let doc = self
            .setting_json("context_provider:document_import")?
            .unwrap_or(serde_json::json!(null));
        let md = self
            .setting_json("artifact_destination:markdown_folder")?
            .unwrap_or(serde_json::json!(null));
        let obs = self
            .setting_json("artifact_destination:obsidian_vault")?
            .unwrap_or(serde_json::json!(null));
        let builder_profile_id = self
            .setting_json("builder_profile_id")?
            .unwrap_or(serde_json::json!(null));
        let autonomy_mode = self
            .setting_json("autonomy_mode")?
            .unwrap_or(serde_json::json!(null));
        let autonomy_category_overrides = self
            .setting_json("autonomy_category_overrides")?
            .unwrap_or(serde_json::json!({}));
        Ok(serde_json::json!({
            "nestweaver": nw,
            "github": gh,
            "ai_chat_import": ai,
            "document_import": doc,
            "artifact_destination_markdown_folder": md,
            "artifact_destination_obsidian_vault": obs,
            "builder_profile_id": builder_profile_id,
            "autonomy_mode": autonomy_mode,
            "autonomy_category_overrides": autonomy_category_overrides,
        }))
    }

    #[cfg(test)]
    pub fn raw_database_text(&self) -> Result<String, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT group_concat(credential_ref || settings_json, ' ') FROM provider_accounts",
        )?;
        let value: Option<String> = statement
            .query_row([], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(value.unwrap_or_default())
    }

    #[cfg(test)]
    pub fn raw_settings_text(&self) -> Result<String, DbError> {
        let mut statement = self
            .connection
            .prepare("SELECT group_concat(key || value_json, ' ') FROM settings")?;
        let value: Option<String> = statement
            .query_row([], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(value.unwrap_or_default())
    }

    #[cfg(test)]
    pub fn context_artifact_count(&self, provider_id: &str) -> Result<i64, DbError> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM context_artifacts WHERE provider_id = ?1",
                params![provider_id],
                |row| row.get(0),
            )
            .map_err(DbError::from)
    }

    #[cfg(test)]
    pub fn database_contains(&self, needle: &str) -> Result<bool, DbError> {
        let tables = [
            "workflows",
            "workflow_versions",
            "schedules",
            "workflow_runs",
            "workflow_step_runs",
            "agent_tool_events",
            "artifacts",
            "context_artifacts",
            "provider_accounts",
            "agent_auth_profiles",
            "llm_profiles",
            "chat_threads",
            "chat_messages",
            "workflow_drafts",
            "settings",
            "audit_events",
        ];

        for table in tables {
            let mut columns = self
                .connection
                .prepare(&format!("PRAGMA table_info({table})"))?;
            let text_columns = columns
                .query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter_map(|(name, column_type)| {
                    column_type.eq_ignore_ascii_case("TEXT").then_some(name)
                })
                .collect::<Vec<_>>();

            for column in text_columns {
                let sql = format!("SELECT {column} FROM {table} WHERE {column} LIKE ?1 LIMIT 1");
                let found = self
                    .connection
                    .query_row(&sql, params![format!("%{needle}%")], |_| Ok(()))
                    .optional()?
                    .is_some();
                if found {
                    return Ok(true);
                }
            }
        }

        Ok(false)
    }

    fn workflow_runs(&self) -> Result<Vec<WorkflowRun>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, workflow_id, workflow_name, status, started_at, completed_at, failure_reason, idempotency_key,
                    trigger_kind, retry_count, parent_run_id, error_classification, provider_profile_id,
                    blocked_reason, required_provider_id, required_profile_id, setup_action,
                    total_tokens, input_tokens, output_tokens, total_cost_usd
             FROM workflow_runs
             ORDER BY started_at DESC",
        )?;
        let runs = statement
            .query_map([], map_run)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::from)?;
        Ok(runs)
    }

    fn artifacts(&self) -> Result<Vec<Artifact>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, artifact_type, workflow_run_id, content_path, metadata_path,
                    content_markdown, metadata_json, source_refs_json, created_at
             FROM artifacts
             ORDER BY created_at DESC",
        )?;
        let artifacts = statement
            .query_map([], map_artifact)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::from)?;
        Ok(artifacts)
    }

    fn llm_profiles(&self) -> Result<Vec<LlmProfile>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, provider_id, model, effort, supports_structured_outputs FROM llm_profiles",
        )?;
        let profiles = statement
            .query_map([], |row| {
                Ok(LlmProfile {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    model: row.get(2)?,
                    effort: row.get(3)?,
                    supports_structured_outputs: row.get::<_, i64>(4)? == 1,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::from)?;
        Ok(profiles)
    }

    pub fn llm_profile(&self, profile_id: &str) -> Result<Option<LlmProfile>, DbError> {
        self.connection
            .query_row(
                "SELECT id, provider_id, model, effort, supports_structured_outputs
                 FROM llm_profiles WHERE id = ?1",
                params![profile_id],
                |row| {
                    Ok(LlmProfile {
                        id: row.get(0)?,
                        provider_id: row.get(1)?,
                        model: row.get(2)?,
                        effort: row.get(3)?,
                        supports_structured_outputs: row.get::<_, i64>(4)? == 1,
                    })
                },
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn list_pending_approvals(&self) -> Result<Vec<PendingApproval>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, run_id, step_id, workflow_name, description, risk_level,
                    payload_json, status, created_at, resolved_at, decision_reason,
                    payload_at_decision
             FROM pending_approvals
             WHERE status = 'pending'
             ORDER BY created_at ASC",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(PendingApproval {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    step_id: row.get(2)?,
                    workflow_name: row.get(3)?,
                    description: row.get(4)?,
                    risk_level: row.get(5)?,
                    payload_json: row.get(6)?,
                    status: row.get(7)?,
                    created_at: row.get(8)?,
                    resolved_at: row.get(9)?,
                    decision_reason: row.get(10)?,
                    payload_at_decision: row.get(11)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::from)?;
        Ok(rows)
    }

    pub fn list_approval_history(&self) -> Result<Vec<PendingApproval>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, run_id, step_id, workflow_name, description, risk_level,
                    payload_json, status, created_at, resolved_at, decision_reason,
                    payload_at_decision
             FROM pending_approvals
             ORDER BY COALESCE(resolved_at, created_at) DESC",
        )?;
        let rows = statement
            .query_map([], map_pending_approval)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::from)?;
        Ok(rows)
    }

    pub fn pending_approval(&self, id: &str) -> Result<Option<PendingApproval>, DbError> {
        self.connection
            .query_row(
                "SELECT id, run_id, step_id, workflow_name, description, risk_level,
                        payload_json, status, created_at, resolved_at, decision_reason,
                        payload_at_decision
                 FROM pending_approvals WHERE id = ?1",
                params![id],
                map_pending_approval,
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn pending_approval_for_run(
        &self,
        run_id: &str,
    ) -> Result<Option<PendingApproval>, DbError> {
        self.connection
            .query_row(
                "SELECT id, run_id, step_id, workflow_name, description, risk_level,
                        payload_json, status, created_at, resolved_at, decision_reason,
                        payload_at_decision
                 FROM pending_approvals
                 WHERE run_id = ?1 AND status = 'pending'
                 ORDER BY created_at ASC
                 LIMIT 1",
                params![run_id],
                map_pending_approval,
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn approved_approval_for_run(
        &self,
        run_id: &str,
    ) -> Result<Option<PendingApproval>, DbError> {
        self.connection
            .query_row(
                "SELECT id, run_id, step_id, workflow_name, description, risk_level,
                        payload_json, status, created_at, resolved_at, decision_reason,
                        payload_at_decision
                 FROM pending_approvals
                 WHERE run_id = ?1 AND status = 'approved'
                 ORDER BY resolved_at DESC, created_at DESC
                 LIMIT 1",
                params![run_id],
                map_pending_approval,
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn insert_pending_approval(&self, approval: &PendingApproval) -> Result<(), DbError> {
        self.connection.execute(
            "INSERT INTO pending_approvals
             (id, run_id, step_id, workflow_name, description, risk_level, payload_json,
              status, created_at, resolved_at, decision_reason, payload_at_decision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                approval.id,
                approval.run_id,
                approval.step_id,
                approval.workflow_name,
                approval.description,
                approval.risk_level,
                approval.payload_json,
                approval.status,
                approval.created_at,
                approval.resolved_at,
                approval.decision_reason,
                approval.payload_at_decision
            ],
        )?;
        Ok(())
    }

    pub fn create_approval_grant(&self, grant: &ApprovalGrant) -> Result<(), DbError> {
        self.connection.execute(
            "INSERT INTO approval_grants
             (id, workflow_id, workflow_version, capability_id, grant_type, scope_json,
              approved_by_user_at, expires_at, signature_hash, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                grant.id,
                grant.workflow_id,
                grant.workflow_version,
                grant.capability_id,
                approval_grant_type_to_string(&grant.grant_type)?,
                serde_json::to_string(&grant.scope)?,
                grant.approved_by_user_at,
                grant.expires_at,
                grant.signature_hash,
                approval_grant_status_to_string(&grant.status)?,
            ],
        )?;
        Ok(())
    }

    pub fn list_approval_grants(
        &self,
        workflow_id: Option<&str>,
    ) -> Result<Vec<ApprovalGrant>, DbError> {
        let sql = match workflow_id {
            Some(_) => {
                "SELECT id, workflow_id, workflow_version, capability_id, grant_type, scope_json,
                        approved_by_user_at, expires_at, signature_hash, status
                 FROM approval_grants
                 WHERE workflow_id = ?1
                 ORDER BY approved_by_user_at DESC, id ASC"
            }
            None => {
                "SELECT id, workflow_id, workflow_version, capability_id, grant_type, scope_json,
                        approved_by_user_at, expires_at, signature_hash, status
                 FROM approval_grants
                 ORDER BY approved_by_user_at DESC, id ASC"
            }
        };
        let mut statement = self.connection.prepare(sql)?;
        let rows = match workflow_id {
            Some(workflow_id) => statement
                .query_map(params![workflow_id], map_stored_approval_grant)?
                .collect::<Result<Vec<_>, _>>()?,
            None => statement
                .query_map([], map_stored_approval_grant)?
                .collect::<Result<Vec<_>, _>>()?,
        };
        rows.into_iter().map(ApprovalGrant::try_from).collect()
    }

    pub fn active_approval_grants_for_runtime(
        &self,
        workflow_id: &str,
        workflow_version: i64,
        capability_id: &str,
    ) -> Result<Vec<ApprovalGrant>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, workflow_id, workflow_version, capability_id, grant_type, scope_json,
                    approved_by_user_at, expires_at, signature_hash, status
             FROM approval_grants
             WHERE workflow_id = ?1
               AND workflow_version = ?2
               AND capability_id = ?3
               AND status = 'active'
             ORDER BY approved_by_user_at DESC, id ASC",
        )?;
        let rows = statement
            .query_map(
                params![workflow_id, workflow_version, capability_id],
                map_stored_approval_grant,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(ApprovalGrant::try_from).collect()
    }

    pub fn revoke_approval_grant(&self, id: &str) -> Result<(), DbError> {
        let updated = self.connection.execute(
            "UPDATE approval_grants SET status = 'revoked' WHERE id = ?1",
            params![id],
        )?;
        if updated == 0 {
            return Err(DbError::MissingApprovalGrant(id.to_string()));
        }
        Ok(())
    }

    pub fn insert_capability_audit_event(
        &self,
        event: &CapabilityAuditEvent,
    ) -> Result<(), DbError> {
        self.connection.execute(
            "INSERT INTO capability_audit_events
             (id, run_id, workflow_id, workflow_version, step_id, capability_id, decision, reason,
              grant_id, created_at, started_at, completed_at, status, input_summary_json,
              output_summary_json, error_details)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                event.id,
                event.run_id,
                event.workflow_id,
                event.workflow_version,
                event.step_id,
                event.capability_id,
                event.decision,
                event.reason,
                event.grant_id,
                event.created_at,
                event.started_at,
                event.completed_at,
                event.status,
                event
                    .input_summary
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                event
                    .output_summary
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                event.error_details
            ],
        )?;
        Ok(())
    }

    pub fn capability_audit_events_for_run(
        &self,
        run_id: &str,
    ) -> Result<Vec<CapabilityAuditEvent>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT id, run_id, workflow_id, workflow_version, step_id, capability_id, decision,
                    reason, grant_id, created_at, started_at, completed_at, status,
                    input_summary_json, output_summary_json, error_details
             FROM capability_audit_events
             WHERE run_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement
            .query_map(params![run_id], |row| {
                Ok(CapabilityAuditEvent {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    workflow_id: row.get(2)?,
                    workflow_version: row.get(3)?,
                    step_id: row.get(4)?,
                    capability_id: row.get(5)?,
                    decision: row.get(6)?,
                    reason: row.get(7)?,
                    grant_id: row.get(8)?,
                    created_at: row.get(9)?,
                    started_at: row.get(10)?,
                    completed_at: row.get(11)?,
                    status: row.get(12)?,
                    input_summary: row
                        .get::<_, Option<String>>(13)?
                        .and_then(|value| serde_json::from_str(&value).ok()),
                    output_summary: row
                        .get::<_, Option<String>>(14)?
                        .and_then(|value| serde_json::from_str(&value).ok()),
                    error_details: row.get(15)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::from)?;
        Ok(rows)
    }

    pub fn resolve_approval(
        &self,
        id: &str,
        decision: &str,
        reason: Option<&str>,
    ) -> Result<(Option<PendingApproval>, bool), DbError> {
        let resolved_at = Utc::now().to_rfc3339();
        self.connection.execute(
            "UPDATE pending_approvals
             SET status = ?1,
                 resolved_at = ?2,
                 decision_reason = ?4,
                 payload_at_decision = payload_json
             WHERE id = ?3 AND status = 'pending'",
            params![decision, resolved_at, id, reason],
        )?;
        let changed = self.connection.changes() > 0;
        self.pending_approval(id)
            .map(|approval| (approval, changed))
    }

    pub fn last_approved_workflow_signature(
        &self,
        workflow_id: &str,
    ) -> Result<Option<String>, DbError> {
        let mut statement = self.connection.prepare(
            "SELECT COALESCE(payload_at_decision, payload_json)
             FROM pending_approvals
             WHERE status = 'approved'
             ORDER BY resolved_at DESC, created_at DESC",
        )?;
        let rows = statement
            .query_map([], |row| row.get::<_, Option<String>>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for payload in rows.into_iter().flatten() {
            let value: serde_json::Value = match serde_json::from_str(&payload) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if value
                .get("workflow_id")
                .and_then(|value| value.as_str())
                .is_some_and(|candidate| candidate == workflow_id)
            {
                return Ok(value
                    .get("policy")
                    .and_then(|policy| policy.get("definition_signature"))
                    .and_then(|value| value.as_str())
                    .map(str::to_string));
            }
        }
        Ok(None)
    }
}

struct ForeignKeysDisabled<'connection> {
    connection: &'connection Connection,
}

impl<'connection> ForeignKeysDisabled<'connection> {
    fn new(connection: &'connection Connection) -> Result<Self, DbError> {
        connection.execute_batch("PRAGMA foreign_keys = OFF;")?;
        Ok(Self { connection })
    }
}

impl Drop for ForeignKeysDisabled<'_> {
    fn drop(&mut self) {
        let _ = self.connection.execute_batch("PRAGMA foreign_keys = ON;");
    }
}

struct StoredApprovalGrant {
    id: String,
    workflow_id: String,
    workflow_version: i64,
    capability_id: String,
    grant_type: String,
    scope_json: String,
    approved_by_user_at: String,
    expires_at: Option<String>,
    signature_hash: String,
    status: String,
}

impl TryFrom<StoredApprovalGrant> for ApprovalGrant {
    type Error = DbError;

    fn try_from(stored: StoredApprovalGrant) -> Result<Self, Self::Error> {
        Ok(Self {
            id: stored.id,
            workflow_id: stored.workflow_id,
            workflow_version: stored.workflow_version,
            capability_id: stored.capability_id,
            grant_type: serde_json::from_value(serde_json::Value::String(stored.grant_type))?,
            scope: serde_json::from_str(&stored.scope_json)?,
            approved_by_user_at: stored.approved_by_user_at,
            expires_at: stored.expires_at,
            signature_hash: stored.signature_hash,
            status: serde_json::from_value(serde_json::Value::String(stored.status))?,
        })
    }
}

fn map_stored_approval_grant(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredApprovalGrant> {
    Ok(StoredApprovalGrant {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        workflow_version: row.get(2)?,
        capability_id: row.get(3)?,
        grant_type: row.get(4)?,
        scope_json: row.get(5)?,
        approved_by_user_at: row.get(6)?,
        expires_at: row.get(7)?,
        signature_hash: row.get(8)?,
        status: row.get(9)?,
    })
}

fn approval_grant_type_to_string(grant_type: &ApprovalGrantType) -> Result<String, DbError> {
    Ok(serde_json::to_value(grant_type).and_then(serde_json_string)?)
}

fn approval_grant_status_to_string(status: &ApprovalGrantStatus) -> Result<String, DbError> {
    Ok(serde_json::to_value(status).and_then(serde_json_string)?)
}

fn serde_json_string(value: serde_json::Value) -> Result<String, serde_json::Error> {
    match value {
        serde_json::Value::String(value) => Ok(value),
        value => Err(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("expected string value, got {value}"),
        ))),
    }
}

fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRun> {
    let status: String = row.get(3)?;
    Ok(WorkflowRun {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        workflow_name: row.get(2)?,
        status: parse_run_status(&status),
        started_at: row.get(4)?,
        completed_at: row.get(5)?,
        failure_reason: row.get(6)?,
        idempotency_key: row.get(7)?,
        trigger_kind: row.get(8)?,
        retry_count: row.get(9)?,
        parent_run_id: row.get(10)?,
        error_classification: row.get(11)?,
        provider_profile_id: row.get(12)?,
        blocked_reason: row.get(13)?,
        required_provider_id: row.get(14)?,
        required_profile_id: row.get(15)?,
        setup_action: row.get(16)?,
        total_tokens: row.get(17)?,
        input_tokens: row.get(18)?,
        output_tokens: row.get(19)?,
        total_cost_usd: row.get(20)?,
    })
}

fn map_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<Artifact> {
    let metadata_json: String = row.get(7)?;
    let source_refs_json: String = row.get(8)?;
    Ok(Artifact {
        id: row.get(0)?,
        title: row.get(1)?,
        artifact_type: row.get(2)?,
        workflow_run_id: row.get(3)?,
        content_path: row.get(4)?,
        metadata_path: row.get(5)?,
        content_markdown: row.get(6)?,
        metadata: serde_json::from_str(&metadata_json).unwrap_or_else(|_| serde_json::json!({})),
        source_refs: serde_json::from_str(&source_refs_json).unwrap_or_default(),
        created_at: row.get(9)?,
    })
}

fn map_pending_approval(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingApproval> {
    Ok(PendingApproval {
        id: row.get(0)?,
        run_id: row.get(1)?,
        step_id: row.get(2)?,
        workflow_name: row.get(3)?,
        description: row.get(4)?,
        risk_level: row.get(5)?,
        payload_json: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        resolved_at: row.get(9)?,
        decision_reason: row.get(10)?,
        payload_at_decision: row.get(11)?,
    })
}

fn parse_workflow_status(value: &str) -> WorkflowStatus {
    match value {
        "enabled" => WorkflowStatus::Enabled,
        "disabled" => WorkflowStatus::Disabled,
        _ => WorkflowStatus::Draft,
    }
}

fn parse_run_status(value: &str) -> RunStatus {
    match value {
        "queued" => RunStatus::Queued,
        "running" => RunStatus::Running,
        "failed" => RunStatus::Failed,
        "retryable" => RunStatus::Retryable,
        "blocked" => RunStatus::Blocked,
        _ => RunStatus::Succeeded,
    }
}

fn agent_tool_event_status_to_str(status: &AgentToolEventStatus) -> &'static str {
    match status {
        AgentToolEventStatus::Requested => "requested",
        AgentToolEventStatus::Succeeded => "succeeded",
        AgentToolEventStatus::Failed => "failed",
        AgentToolEventStatus::Blocked => "blocked",
    }
}

fn parse_agent_tool_event_status(value: &str) -> Result<AgentToolEventStatus, DbError> {
    match value {
        "requested" => Ok(AgentToolEventStatus::Requested),
        "succeeded" => Ok(AgentToolEventStatus::Succeeded),
        "failed" => Ok(AgentToolEventStatus::Failed),
        "blocked" => Ok(AgentToolEventStatus::Blocked),
        _ => Err(DbError::InvalidAgentToolEventStatus(value.into())),
    }
}

fn validate_initial_agent_tool_event(event: &AgentToolEvent) -> Result<(), DbError> {
    if !matches!(event.status, AgentToolEventStatus::Requested) {
        return Err(DbError::InvalidInitialAgentToolEventState(format!(
            "status must be requested, got {}",
            agent_tool_event_status_to_str(&event.status)
        )));
    }
    if event.completed_at.is_some() {
        return Err(DbError::InvalidInitialAgentToolEventState(
            "completed_at must be null".into(),
        ));
    }
    if event.output_json.is_some() {
        return Err(DbError::InvalidInitialAgentToolEventState(
            "output_json must be null".into(),
        ));
    }
    if event.error.is_some() {
        return Err(DbError::InvalidInitialAgentToolEventState(
            "error must be null".into(),
        ));
    }
    Ok(())
}

fn provider_account_id_for(provider_id: &str) -> &str {
    match provider_id {
        "openai" => "openai-api-key",
        "anthropic" => "anthropic-api-key",
        other => other,
    }
}

fn validate_provider_account_id(account_id: &str) -> Result<(), DbError> {
    let is_safe = !account_id.is_empty()
        && account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if is_safe {
        Ok(())
    } else {
        Err(DbError::InvalidProviderAccountId(account_id.to_string()))
    }
}

fn fallback_env_for_provider(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "openai" => Some("OPENAI_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        _ => None,
    }
}

fn parse_provider_kind(value: &str) -> ProviderKind {
    match value {
        "context" => ProviderKind::Context,
        "artifactdestination" | "artifact_destination" => ProviderKind::ArtifactDestination,
        "notification" => ProviderKind::Notification,
        _ => ProviderKind::Llm,
    }
}

fn looks_like_raw_secret(value: &str) -> bool {
    contains_token_with_prefix(value, "sk-", 8)
        || contains_token_with_prefix(value, "github_pat_", 12)
        || contains_token_with_prefix(value, "ghp_", 12)
        || contains_token_with_prefix(value, "xoxb-", 20)
        || contains_token_with_prefix(value, "AIza", 20)
        || contains_token_with_prefix(value, "AKIA", 16)
        || contains_token_with_prefix_case_insensitive(value, "Bearer ", 20)
}

fn reject_raw_secret_text(value: &str) -> Result<(), DbError> {
    if looks_like_raw_secret(value) || contains_sensitive_assignment(value) {
        Err(DbError::RawCredential)
    } else {
        Ok(())
    }
}

fn reject_raw_secret_value(value: &serde_json::Value) -> Result<(), DbError> {
    reject_raw_secret_value_with_context(value, false)
}

fn reject_raw_secret_value_with_context(
    value: &serde_json::Value,
    sensitive_context: bool,
) -> Result<(), DbError> {
    match value {
        serde_json::Value::String(value) => {
            if sensitive_context && value != "[redacted]" {
                return Err(DbError::RawCredential);
            }
            reject_raw_secret_text(value)
        }
        serde_json::Value::Array(values) => {
            for value in values {
                reject_raw_secret_value_with_context(value, sensitive_context)?;
            }
            Ok(())
        }
        serde_json::Value::Object(values) => {
            for (key, value) in values {
                reject_raw_secret_text(key)?;
                reject_raw_secret_value_with_context(
                    value,
                    sensitive_context || is_sensitive_json_key(key),
                )?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn is_sensitive_json_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| *character != '_' && *character != '-' && !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "token",
        "apikey",
        "secret",
        "password",
        "credential",
        "auth",
        "authorization",
        "bearer",
        "accesstoken",
        "refreshtoken",
        "privatekey",
        "clientsecret",
        "credentialref",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn contains_sensitive_assignment(value: &str) -> bool {
    let mut index = 0;
    while index < value.len() {
        if let Some((value_start, value_end)) = sensitive_assignment_at(value, index) {
            if &value[value_start..value_end] != "[redacted]" {
                return true;
            }
            index = value_end;
            continue;
        }
        let Some(character) = value[index..].chars().next() else {
            break;
        };
        index += character.len_utf8();
    }
    false
}

fn sensitive_assignment_at(value: &str, index: usize) -> Option<(usize, usize)> {
    let previous = value[..index].chars().next_back();
    if previous.is_some_and(|character| {
        character.is_ascii_alphanumeric() || character == '_' || character == '-'
    }) {
        return None;
    }
    let key_end = value[index..]
        .char_indices()
        .take_while(|(_, character)| {
            character.is_ascii_alphanumeric() || *character == '_' || *character == '-'
        })
        .map(|(offset, character)| index + offset + character.len_utf8())
        .last()?;
    if key_end == index || !is_sensitive_json_key(&value[index..key_end]) {
        return None;
    }

    let mut separator_index = key_end;
    while separator_index < value.len() {
        let character = value[separator_index..].chars().next()?;
        if !character.is_whitespace() || character == '\n' || character == '\r' {
            break;
        }
        separator_index += character.len_utf8();
    }
    let separator = value[separator_index..].chars().next()?;
    if !matches!(separator, ':' | '=') {
        return None;
    }
    let mut value_start = separator_index + separator.len_utf8();
    while value_start < value.len() {
        let character = value[value_start..].chars().next()?;
        if !character.is_whitespace() || character == '\n' || character == '\r' {
            break;
        }
        value_start += character.len_utf8();
    }
    if value_start >= value.len() {
        return None;
    }
    let value_end = sensitive_assignment_value_end(value, value_start)?;
    (value_end > value_start).then_some((value_start, value_end))
}

fn sensitive_assignment_value_end(value: &str, value_start: usize) -> Option<usize> {
    let first = value[value_start..].chars().next()?;
    if matches!(first, '"' | '\'') {
        let mut value_end = value_start + first.len_utf8();
        while value_end < value.len() {
            let character = value[value_end..].chars().next()?;
            value_end += character.len_utf8();
            if character == first {
                break;
            }
        }
        return Some(value_end);
    }

    let mut value_end = value_start;
    while value_end < value.len() {
        let character = value[value_end..].chars().next()?;
        if matches!(character, '\n' | '\r' | ',' | ';') {
            break;
        }
        value_end += character.len_utf8();
    }
    Some(value_end)
}

fn contains_token_with_prefix(value: &str, prefix: &str, min_suffix_len: usize) -> bool {
    value.match_indices(prefix).any(|(index, _)| {
        is_token_boundary(value[..index].chars().next_back())
            && token_suffix_len(&value[index + prefix.len()..]) >= min_suffix_len
    })
}

fn contains_token_with_prefix_case_insensitive(
    value: &str,
    prefix: &str,
    min_suffix_len: usize,
) -> bool {
    value.char_indices().any(|(index, _)| {
        value[index..]
            .get(..prefix.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
            && is_token_boundary(value[..index].chars().next_back())
            && token_suffix_len(&value[index + prefix.len()..]) >= min_suffix_len
    })
}

fn is_token_boundary(character: Option<char>) -> bool {
    character.is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
}

fn token_suffix_len(value: &str) -> usize {
    value
        .chars()
        .take_while(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | '/' | '+' | '=')
        })
        .count()
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash && !slug.is_empty() {
            slug.push('-');
            previous_dash = true;
        }
    }

    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "artifact".into()
    } else {
        slug
    }
}

fn safe_child_path(parent: &Path, filename: &str) -> Result<PathBuf, DbError> {
    let filename_path = Path::new(filename);
    if filename_path.components().count() != 1 {
        return Err(DbError::InvalidPath(format!(
            "destination filename {filename} must not contain path separators"
        )));
    }
    let destination = parent.join(filename_path);
    if !destination.starts_with(parent) {
        return Err(DbError::InvalidPath(
            "destination is outside configured folder".into(),
        ));
    }
    Ok(destination)
}

fn safe_relative_export_path(root: &Path, relative_path: &Path) -> Result<PathBuf, DbError> {
    if relative_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(DbError::InvalidPath(format!(
            "relative export path {} must stay under the app data root",
            relative_path.display()
        )));
    }

    let root = root.canonicalize()?;
    let destination = root.join(relative_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
        let parent = parent.canonicalize()?;
        if !parent.starts_with(&root) {
            return Err(DbError::InvalidPath(
                "relative export path resolves outside the app data root".into(),
            ));
        }
    }
    Ok(destination)
}

fn obsidian_artifact_markdown(artifact: &Artifact) -> String {
    let mut content = String::new();
    content.push_str("---\n");
    content.push_str(&format!("title: \"{}\"\n", yaml_quote(&artifact.title)));
    content.push_str(&format!(
        "artifact_type: \"{}\"\n",
        yaml_quote(&artifact.artifact_type)
    ));
    content.push_str(&format!(
        "workflow_run_id: \"{}\"\n",
        yaml_quote(&artifact.workflow_run_id)
    ));
    content.push_str(&format!(
        "created_at: \"{}\"\n",
        yaml_quote(&artifact.created_at)
    ));
    if artifact.source_refs.is_empty() {
        content.push_str("source_refs: []\n");
    } else {
        content.push_str("source_refs:\n");
        for source_ref in &artifact.source_refs {
            content.push_str(&format!("  - \"{}\"\n", yaml_quote(source_ref)));
        }
    }
    content.push_str("---\n\n");
    content.push_str(&artifact.content_markdown);
    content
}

fn yaml_quote(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

#[cfg(target_os = "macos")]
fn store_macos_keychain_secret(account_id: &str, secret: &str) -> Option<String> {
    let service = format!("raven:{account_id}");
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            "raven",
            "-s",
            service.as_str(),
            "-w",
            secret,
            "-U",
        ])
        .status()
        .ok()?;

    status
        .success()
        .then(|| format!("keychain:macos:{account_id}"))
}

#[cfg(not(target_os = "macos"))]
fn store_macos_keychain_secret(_: &str, _: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn read_macos_keychain_secret(credential_ref: &str) -> Option<String> {
    let account_id = credential_ref.strip_prefix("keychain:macos:")?;
    let service = format!("raven:{account_id}");
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            "raven",
            "-s",
            service.as_str(),
            "-w",
        ])
        .output()
        .ok()?;

    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn read_macos_keychain_secret(_: &str) -> Option<String> {
    None
}

#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> Result<(), DbError> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_file_permissions(_: &Path) -> Result<(), DbError> {
    Ok(())
}

fn is_legacy_open_meteo_current_weather(definition: &crate::models::RavenWorkflow) -> bool {
    serde_json::to_value(definition)
        .map(|definition| definition == legacy_open_meteo_current_weather_seed_json())
        .unwrap_or(false)
}

fn legacy_open_meteo_current_weather_seed_json() -> serde_json::Value {
    serde_json::json!({
        "schema_version": "0.1.0",
        "id": "current-weather",
        "name": "Current Weather",
        "description": "Fetches live current conditions from Open-Meteo and stores a weather artifact.",
        "permissions": ["weather:read", "artifact:write"],
        "defaults": {
            "llm_profile_ref": "open-meteo",
            "destination_ref": "local-app"
        },
        "schedule": { "cadence": "manual", "local_time": null },
        "steps": [
            {
                "kind": "provider_action",
                "id": "fetch-weather",
                "name": "Fetch current weather",
                "provider": "open_meteo",
                "action": "current_weather",
                "depends_on": [],
                "permissions": ["weather:read"],
                "inputs": {
                    "location": "Denver, CO",
                    "latitude": 39.7392,
                    "longitude": -104.9903
                },
                "parallel": null,
                "llm_profile_ref": null,
                "destination_ref": null,
                "inline_code": null
            },
            {
                "kind": "provider_action",
                "id": "write-artifact",
                "name": "Save weather artifact locally",
                "provider": "local_app",
                "action": "write_artifact",
                "depends_on": ["fetch-weather"],
                "permissions": ["artifact:write"],
                "inputs": { "artifact": "$steps.fetch-weather.artifact" },
                "parallel": null,
                "llm_profile_ref": null,
                "destination_ref": "local-app",
                "inline_code": null
            }
        ]
    })
}

#[allow(dead_code)]
fn _keep_public_interface_types(
    _: ChatThread,
    _: ChatMessage,
    _: ProviderAccount,
    _: ProviderKind,
) {
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{ArtifactEnvelope, ArtifactGenerationRequest, LlmArtifactGenerator, LlmError};
    use crate::models::{
        AgentToolEvent, AgentToolEventStatus, ApprovalGrant, ApprovalGrantScope,
        ApprovalGrantStatus, ApprovalGrantType, PendingApproval, ProviderAccount, ProviderKind,
        WorkflowStepKind,
    };
    use crate::runtime::{run_workflow_with_generator, RunTrigger};

    fn repo() -> Repository {
        let dir = std::env::temp_dir().join(format!("raven-db-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Repository::open(dir.join("raven.sqlite3")).unwrap()
    }

    fn db_path() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("raven-db-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("raven.sqlite3")
    }

    fn create_legacy_current_weather_db(path: &std::path::Path, definition: serde_json::Value) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE workflows (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  status TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE workflow_versions (
                  id TEXT PRIMARY KEY,
                  workflow_id TEXT NOT NULL,
                  version INTEGER NOT NULL,
                  status TEXT NOT NULL,
                  definition_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  UNIQUE(workflow_id, version),
                  FOREIGN KEY(workflow_id) REFERENCES workflows(id)
                );
                ",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workflows (id, name, status, created_at)
                 VALUES ('current-weather', 'Current Weather', 'enabled', '2026-06-08T12:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workflow_versions
                 (id, workflow_id, version, status, definition_json, created_at)
                 VALUES ('current-weather-v1', 'current-weather', 1, 'enabled', ?1, '2026-06-08T12:00:00Z')",
                params![definition.to_string()],
            )
            .unwrap();
    }

    fn legacy_open_meteo_current_weather_definition() -> serde_json::Value {
        serde_json::json!({
            "schema_version": "0.1.0",
            "id": "current-weather",
            "name": "Current Weather",
            "description": "Fetches live current conditions from Open-Meteo and stores a weather artifact.",
            "permissions": ["weather:read", "artifact:write"],
            "defaults": {
                "llm_profile_ref": "open-meteo",
                "destination_ref": "local-app"
            },
            "schedule": { "cadence": "manual", "local_time": null },
            "steps": [
                {
                    "kind": "provider_action",
                    "id": "fetch-weather",
                    "name": "Fetch current weather",
                    "provider": "open_meteo",
                    "action": "current_weather",
                    "depends_on": [],
                    "permissions": ["weather:read"],
                    "inputs": {
                        "location": "Denver, CO",
                        "latitude": 39.7392,
                        "longitude": -104.9903
                    },
                    "llm_profile_ref": null,
                    "destination_ref": null,
                    "inline_code": null
                },
                {
                    "kind": "provider_action",
                    "id": "write-artifact",
                    "name": "Save weather artifact locally",
                    "provider": "local_app",
                    "action": "write_artifact",
                    "depends_on": ["fetch-weather"],
                    "permissions": ["artifact:write"],
                    "inputs": { "artifact": "$steps.fetch-weather.artifact" },
                    "llm_profile_ref": null,
                    "destination_ref": "local-app",
                    "inline_code": null
                }
            ]
        })
    }

    fn workflow_run(id: &str) -> WorkflowRun {
        WorkflowRun {
            id: id.into(),
            workflow_id: "daily-work-journal".into(),
            workflow_name: "Daily Work Journal".into(),
            status: RunStatus::Running,
            started_at: "2026-06-08T12:00:00Z".into(),
            completed_at: None,
            failure_reason: None,
            idempotency_key: format!("idempotency-{id}"),
            trigger_kind: "manual".into(),
            retry_count: 0,
            parent_run_id: None,
            error_classification: None,
            provider_profile_id: None,
            blocked_reason: None,
            required_provider_id: None,
            required_profile_id: None,
            setup_action: None,
            total_tokens: None,
            input_tokens: None,
            output_tokens: None,
            total_cost_usd: None,
        }
    }

    fn workflow_step_run(id: &str, run_id: &str, step_id: &str) -> WorkflowStepRun {
        WorkflowStepRun {
            id: id.into(),
            workflow_run_id: run_id.into(),
            step_id: step_id.into(),
            status: RunStatus::Running,
            output_json: None,
            error: None,
            started_at: "2026-06-08T12:00:00Z".into(),
            completed_at: None,
        }
    }

    #[test]
    fn workflow_run_persists_input_output_token_split() {
        let mut repository = repo();
        repository
            .create_run_with_steps(&workflow_run("run-token-split"), &[])
            .unwrap();

        repository
            .finish_run_with_token_usage(
                "run-token-split",
                RunStatus::Succeeded,
                None,
                Some(1000),
                Some(125),
                Some(875),
                Some(0.00725),
            )
            .unwrap();

        let run = repository.workflow_run("run-token-split").unwrap().unwrap();
        assert_eq!(run.total_tokens, Some(1000));
        assert_eq!(run.input_tokens, Some(125));
        assert_eq!(run.output_tokens, Some(875));
        assert_eq!(run.total_cost_usd, Some(0.00725));
    }

    #[test]
    fn approval_history_returns_resolved_decision_reason() {
        let repository = repo();
        repository
            .insert_pending_approval(&PendingApproval {
                id: "approval-history-1".into(),
                run_id: "run-approval-history".into(),
                step_id: "approval".into(),
                workflow_name: "Daily Work Journal".into(),
                description: "Review before writing artifact.".into(),
                risk_level: "normal".into(),
                payload_json: Some(
                    serde_json::json!({ "workflow_id": "daily-work-journal" }).to_string(),
                ),
                status: "pending".into(),
                created_at: Utc::now().to_rfc3339(),
                resolved_at: None,
                decision_reason: None,
                payload_at_decision: None,
            })
            .unwrap();

        repository
            .resolve_approval("approval-history-1", "approved", Some("Looks good"))
            .unwrap();

        let history = repository.list_approval_history().unwrap();
        let approval = history
            .iter()
            .find(|approval| approval.id == "approval-history-1")
            .unwrap();
        assert_eq!(approval.status, "approved");
        assert_eq!(approval.decision_reason.as_deref(), Some("Looks good"));
        assert!(approval.payload_at_decision.is_some());
    }

    fn agent_tool_event(id: &str, run_id: &str) -> AgentToolEvent {
        AgentToolEvent {
            id: id.into(),
            workflow_run_id: run_id.into(),
            step_id: "ask-ai".into(),
            tool_id: "web.search".into(),
            status: AgentToolEventStatus::Requested,
            input_json: serde_json::json!({ "query": "weather today", "api_key": "[redacted]" }),
            output_json: None,
            error: None,
            created_at: "2026-06-08T12:00:00Z".into(),
            completed_at: None,
        }
    }

    struct FakeArtifactGenerator;

    impl LlmArtifactGenerator for FakeArtifactGenerator {
        fn generate_artifact(
            &self,
            _request: &ArtifactGenerationRequest,
        ) -> Result<ArtifactEnvelope, LlmError> {
            Ok(ArtifactEnvelope {
                title: "Daily Work Journal".into(),
                content_markdown: "# Daily Work Journal\n\nGenerated for export.".into(),
                metadata: serde_json::json!({ "schema_version": "0.1.0" }),
                source_refs: vec!["test fixture".into()],
            })
        }
    }

    fn grant_runtime_capability(
        repository: &Repository,
        workflow_id: &str,
        capability_id: &str,
        paths: Vec<String>,
    ) {
        let version = repository
            .latest_workflow_version(workflow_id)
            .unwrap()
            .unwrap();
        let grants = daily_work_journal_test_grant_metadata(&version, capability_id, paths);
        for (grant_type, scope, signature_hash) in grants {
            repository
                .create_approval_grant(&ApprovalGrant {
                    id: format!(
                        "grant-{}-{}",
                        capability_id.replace('.', "-"),
                        uuid::Uuid::new_v4()
                    ),
                    workflow_id: workflow_id.into(),
                    workflow_version: version.version,
                    capability_id: capability_id.into(),
                    grant_type,
                    scope,
                    approved_by_user_at: Utc::now().to_rfc3339(),
                    expires_at: None,
                    signature_hash,
                    status: ApprovalGrantStatus::Active,
                })
                .unwrap();
        }
    }

    fn daily_work_journal_test_grant_metadata(
        version: &WorkflowVersion,
        capability_id: &str,
        paths: Vec<String>,
    ) -> Vec<(ApprovalGrantType, ApprovalGrantScope, String)> {
        let registry = crate::capability_registry::builtin_registry_snapshot();
        let step = version
            .definition
            .steps
            .iter()
            .find(|step| format!("{}.{}", step.provider, step.action) == capability_id)
            .unwrap();
        let capability =
            crate::runtime::runtime_capability_descriptor_for_step(step, &registry).unwrap();
        let mut grants = Vec::new();
        if capability.writes_files {
            grants.push((
                ApprovalGrantType::FileWrite,
                ApprovalGrantScope {
                    credential_ref: None,
                    paths,
                    domains: vec![],
                    resource_ids: vec![],
                    max_deletes: None,
                    max_overwrite_bytes: None,
                    external_targets: vec![],
                },
                capability.signature_hash.clone(),
            ));
        }
        if capability.requires_credentials {
            grants.push((
                ApprovalGrantType::CredentialUse,
                ApprovalGrantScope {
                    credential_ref: step.llm_profile_ref.clone(),
                    paths: vec![],
                    domains: vec![],
                    resource_ids: vec![],
                    max_deletes: None,
                    max_overwrite_bytes: None,
                    external_targets: vec![],
                },
                capability.signature_hash.clone(),
            ));
        }
        if capability.requires_network {
            grants.push((
                ApprovalGrantType::NetworkAccess,
                ApprovalGrantScope {
                    credential_ref: None,
                    paths: vec![],
                    domains: vec![],
                    resource_ids: vec![capability.id.clone()],
                    max_deletes: None,
                    max_overwrite_bytes: None,
                    external_targets: vec![],
                },
                capability.signature_hash.clone(),
            ));
        }
        if grants.is_empty() {
            grants.push((
                ApprovalGrantType::ToolExecution,
                ApprovalGrantScope {
                    credential_ref: None,
                    paths: vec![],
                    domains: vec![],
                    resource_ids: vec![],
                    max_deletes: None,
                    max_overwrite_bytes: None,
                    external_targets: vec![],
                },
                capability.signature_hash,
            ));
        }
        grants
    }

    fn grant_daily_work_journal_runtime_capabilities(repository: &Repository) {
        grant_runtime_capability(
            repository,
            "daily-work-journal",
            "local_git.recent_activity",
            vec![],
        );
        grant_runtime_capability(
            repository,
            "daily-work-journal",
            "openai.generate_artifact",
            vec![],
        );
        let (content_path, metadata_path) = repository.artifact_paths("artifact-*");
        grant_runtime_capability(
            repository,
            "daily-work-journal",
            "local_app.write_artifact",
            vec![content_path, metadata_path],
        );
    }

    fn run_daily_work_journal_fixture(repository: &mut Repository) -> Artifact {
        grant_daily_work_journal_runtime_capabilities(repository);
        run_workflow_with_generator(
            repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &FakeArtifactGenerator,
        )
        .unwrap()
        .artifact
        .unwrap()
    }

    #[test]
    fn migrations_create_required_tables_and_seed_state() {
        let repository = repo();
        let state = repository.app_state().unwrap();
        assert!(state
            .workflows
            .iter()
            .any(|workflow| workflow.workflow_id == "daily-work-journal"));
        assert!(state
            .llm_profiles
            .iter()
            .any(|profile| profile.id == "default-openai"));
        assert!(state
            .providers
            .iter()
            .any(|provider| provider.id == "nestweaver"));
    }

    #[test]
    fn approval_grants_create_list_filter_and_revoke() {
        let repository = repo();
        let grant = ApprovalGrant {
            id: "grant-1".into(),
            workflow_id: "workflow".into(),
            workflow_version: 1,
            capability_id: "local_app.write_artifact".into(),
            grant_type: ApprovalGrantType::FileOverwrite,
            scope: ApprovalGrantScope {
                credential_ref: Some("credential_ref_placeholder".into()),
                paths: vec!["/tmp/raven/*.md".into()],
                domains: vec![],
                resource_ids: vec!["artifact-1".into()],
                max_deletes: None,
                max_overwrite_bytes: Some(1024),
                external_targets: vec![],
            },
            approved_by_user_at: "2026-06-21T00:00:00Z".into(),
            expires_at: None,
            signature_hash: "hash".into(),
            status: ApprovalGrantStatus::Active,
        };
        let other_grant = ApprovalGrant {
            id: "grant-2".into(),
            workflow_id: "other-workflow".into(),
            workflow_version: 2,
            capability_id: "web.search".into(),
            grant_type: ApprovalGrantType::NetworkAccess,
            scope: ApprovalGrantScope {
                credential_ref: None,
                paths: vec![],
                domains: vec!["example.com".into()],
                resource_ids: vec![],
                max_deletes: None,
                max_overwrite_bytes: None,
                external_targets: vec![],
            },
            approved_by_user_at: "2026-06-21T01:00:00Z".into(),
            expires_at: Some("2026-06-22T00:00:00Z".into()),
            signature_hash: "other-hash".into(),
            status: ApprovalGrantStatus::Active,
        };

        repository.create_approval_grant(&grant).unwrap();
        repository.create_approval_grant(&other_grant).unwrap();

        let workflow_grants = repository.list_approval_grants(Some("workflow")).unwrap();
        assert_eq!(workflow_grants, vec![grant.clone()]);
        assert_eq!(repository.list_approval_grants(None).unwrap().len(), 2);

        repository.revoke_approval_grant("grant-1").unwrap();
        let revoked_grant = repository
            .list_approval_grants(Some("workflow"))
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(revoked_grant.status, ApprovalGrantStatus::Revoked);
    }

    #[test]
    fn approval_grants_revoke_missing_id_returns_error() {
        let repository = repo();

        let error = repository
            .revoke_approval_grant("missing-grant")
            .unwrap_err();

        assert_eq!(error.to_string(), "missing approval grant missing-grant");
    }

    #[test]
    fn repository_open_upgrades_legacy_current_weather_seed_to_agent_task_version() {
        let path = db_path();
        create_legacy_current_weather_db(&path, legacy_open_meteo_current_weather_definition());

        let repository = Repository::open(&path).unwrap();
        let latest = repository
            .latest_workflow_version("current-weather")
            .unwrap()
            .unwrap();

        assert_eq!(latest.version, 2);
        assert_eq!(
            latest.definition.steps[0].inputs,
            serde_json::json!({
                "objective": "What's the weather today in Denver?",
                "output_schema": "artifact_envelope",
                "allowed_tools": ["web"]
            })
        );
        assert!(latest
            .definition
            .steps
            .iter()
            .any(|step| step.kind == WorkflowStepKind::AgentTask));
        assert!(!latest.definition.steps.iter().any(|step| {
            step.kind == WorkflowStepKind::ProviderAction
                && step.provider == "open_meteo"
                && step.action == "current_weather"
        }));
        assert_eq!(
            latest.definition.defaults.llm_profile_ref,
            "codex-oauth-local"
        );
    }

    #[test]
    fn repository_open_preserves_user_edited_current_weather_seed() {
        let path = db_path();
        let mut definition = legacy_open_meteo_current_weather_definition();
        definition["steps"][0]["provider"] = serde_json::json!("local_git");
        definition["steps"][0]["action"] = serde_json::json!("context_pack");
        definition["steps"][0]["permissions"] = serde_json::json!(["git:read"]);
        definition["permissions"] = serde_json::json!(["git:read", "artifact:write"]);
        definition["defaults"]["llm_profile_ref"] = serde_json::json!("default-openai");
        create_legacy_current_weather_db(&path, definition);

        let repository = Repository::open(&path).unwrap();
        let latest = repository
            .latest_workflow_version("current-weather")
            .unwrap()
            .unwrap();

        assert_eq!(latest.version, 1);
        assert_eq!(latest.definition.steps[0].provider, "local_git");
        assert!(!latest
            .definition
            .steps
            .iter()
            .any(|step| step.kind == WorkflowStepKind::AgentTask));
    }

    #[test]
    fn repository_open_preserves_user_edited_open_meteo_current_weather_seed() {
        let path = db_path();
        let mut definition = legacy_open_meteo_current_weather_definition();
        definition["name"] = serde_json::json!("Current Weather for Boulder");
        definition["schedule"] = serde_json::json!({ "cadence": "daily", "local_time": "07:30" });
        definition["steps"][0]["inputs"] = serde_json::json!({ "location": "Boulder, CO" });
        create_legacy_current_weather_db(&path, definition);

        let repository = Repository::open(&path).unwrap();
        let latest = repository
            .latest_workflow_version("current-weather")
            .unwrap()
            .unwrap();

        assert_eq!(latest.version, 1);
        assert_eq!(latest.definition.name, "Current Weather for Boulder");
        assert_eq!(
            latest.definition.steps[0].inputs,
            serde_json::json!({ "location": "Boulder, CO" })
        );
        assert!(!latest
            .definition
            .steps
            .iter()
            .any(|step| step.kind == WorkflowStepKind::AgentTask));
    }

    #[test]
    fn provider_accounts_store_references_not_raw_keys() {
        let repository = repo();
        let account = ProviderAccount {
            id: "openai-dev".into(),
            provider_kind: ProviderKind::Llm,
            display_name: "OpenAI development".into(),
            credential_ref: "env:OPENAI_API_KEY".into(),
            settings_json: serde_json::json!({ "model": "gpt-4.1" }),
        };
        repository.insert_provider_account(&account).unwrap();
        assert!(!repository.raw_database_text().unwrap().contains("sk-"));

        let raw = ProviderAccount {
            credential_ref: format!("{}{}", "sk-", "raw-secret"),
            ..account
        };
        assert!(repository.insert_provider_account(&raw).is_err());
    }

    #[test]
    fn agent_tool_events_persist_redacted_arguments_and_results() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-1"),
                &[workflow_step_run("step-run-1", "run-1", "ask-ai")],
            )
            .unwrap();
        let event = agent_tool_event("tool-event-1", "run-1");

        repository.insert_agent_tool_event(&event).unwrap();
        repository
            .complete_agent_tool_event(
                "tool-event-1",
                AgentToolEventStatus::Succeeded,
                Some(serde_json::json!({ "summary": "Weather result", "source_refs": ["web"] })),
                None,
            )
            .unwrap();

        let events = repository.agent_tool_events_for_run("run-1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_id, "web.search");
        assert_eq!(events[0].status, AgentToolEventStatus::Succeeded);
        assert!(events[0].output_json.is_some());
        assert!(events[0].completed_at.is_some());
        assert!(!repository.database_contains("secret").unwrap());
    }

    #[test]
    fn agent_tool_events_migration_cleans_duplicate_legacy_step_runs() {
        let dir = std::env::temp_dir().join(format!(
            "raven-db-legacy-step-run-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("raven.sqlite3");
        {
            let connection = Connection::open(&db_path).unwrap();
            connection
                .execute_batch(
                    "
                    PRAGMA foreign_keys = ON;
                    CREATE TABLE workflows (
                      id TEXT PRIMARY KEY,
                      name TEXT NOT NULL,
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL
                    );
                    CREATE TABLE workflow_runs (
                      id TEXT PRIMARY KEY,
                      workflow_id TEXT NOT NULL,
                      workflow_name TEXT NOT NULL,
                      status TEXT NOT NULL,
                      started_at TEXT NOT NULL,
                      completed_at TEXT,
                      failure_reason TEXT,
                      idempotency_key TEXT NOT NULL UNIQUE,
                      FOREIGN KEY(workflow_id) REFERENCES workflows(id)
                    );
                    CREATE TABLE workflow_step_runs (
                      id TEXT PRIMARY KEY,
                      workflow_run_id TEXT NOT NULL,
                      step_id TEXT NOT NULL,
                      status TEXT NOT NULL,
                      output_json TEXT,
                      error TEXT,
                      started_at TEXT NOT NULL,
                      completed_at TEXT,
                      FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
                    );
                    INSERT INTO workflows (id, name, status, created_at)
                    VALUES ('daily-work-journal', 'Daily Work Journal', 'enabled', '2026-06-08T12:00:00Z');
                    INSERT INTO workflow_runs
                      (id, workflow_id, workflow_name, status, started_at, idempotency_key)
                    VALUES
                      ('legacy-run', 'daily-work-journal', 'Daily Work Journal', 'running',
                       '2026-06-08T12:00:00Z', 'legacy-idempotency');
                    INSERT INTO workflow_step_runs
                      (id, workflow_run_id, step_id, status, started_at)
                    VALUES
                      ('step-run-1', 'legacy-run', 'ask-ai', 'failed',
                       '2026-06-08T12:00:00Z'),
                      ('step-run-2', 'legacy-run', 'ask-ai', 'running',
                       '2026-06-08T11:59:00Z'),
                      ('step-run-3', 'legacy-run', 'ask-ai', 'succeeded',
                       '2026-06-08T12:02:00Z');
                    UPDATE workflow_step_runs
                    SET completed_at = '2026-06-08T12:05:00Z'
                    WHERE id = 'step-run-1';
                    UPDATE workflow_step_runs
                    SET completed_at = '2026-06-08T12:04:00Z'
                    WHERE id = 'step-run-3';
                    ",
                )
                .unwrap();
        }

        let repository = Repository::open(&db_path).unwrap();

        let duplicate_count: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM workflow_step_runs
                 WHERE workflow_run_id = 'legacy-run' AND step_id = 'ask-ai'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(duplicate_count, 1);

        let remaining_id: String = repository
            .connection
            .query_row(
                "SELECT id FROM workflow_step_runs
                 WHERE workflow_run_id = 'legacy-run' AND step_id = 'ask-ai'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_id, "step-run-3");

        let index_exists: bool = repository
            .connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM pragma_index_list('workflow_step_runs')
                   WHERE name = 'idx_workflow_step_runs_run_step' AND [unique] = 1
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(index_exists);

        let duplicate_insert = repository.connection.execute(
            "INSERT INTO workflow_step_runs
             (id, workflow_run_id, step_id, status, started_at)
             VALUES ('step-run-3', 'legacy-run', 'ask-ai', 'running', '2026-06-08T12:02:00Z')",
            [],
        );
        assert!(duplicate_insert.is_err());
    }

    #[test]
    fn agent_tool_events_migration_rebuilds_weak_legacy_table() {
        let dir = std::env::temp_dir().join(format!(
            "raven-db-legacy-agent-tool-event-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("raven.sqlite3");
        {
            let connection = Connection::open(&db_path).unwrap();
            connection
                .execute_batch(
                    "
                    PRAGMA foreign_keys = ON;
                    CREATE TABLE workflows (
                      id TEXT PRIMARY KEY,
                      name TEXT NOT NULL,
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL
                    );
                    CREATE TABLE workflow_runs (
                      id TEXT PRIMARY KEY,
                      workflow_id TEXT NOT NULL,
                      workflow_name TEXT NOT NULL,
                      status TEXT NOT NULL,
                      started_at TEXT NOT NULL,
                      completed_at TEXT,
                      failure_reason TEXT,
                      idempotency_key TEXT NOT NULL UNIQUE,
                      FOREIGN KEY(workflow_id) REFERENCES workflows(id)
                    );
                    CREATE TABLE workflow_step_runs (
                      id TEXT PRIMARY KEY,
                      workflow_run_id TEXT NOT NULL,
                      step_id TEXT NOT NULL,
                      status TEXT NOT NULL,
                      output_json TEXT,
                      error TEXT,
                      started_at TEXT NOT NULL,
                      completed_at TEXT,
                      FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
                    );
                    CREATE TABLE agent_tool_events (
                      id TEXT PRIMARY KEY,
                      workflow_run_id TEXT NOT NULL,
                      step_id TEXT NOT NULL,
                      tool_id TEXT NOT NULL,
                      status TEXT NOT NULL,
                      input_json TEXT NOT NULL,
                      output_json TEXT,
                      error TEXT,
                      created_at TEXT NOT NULL,
                      completed_at TEXT,
                      FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
                    );
                    INSERT INTO workflows (id, name, status, created_at)
                    VALUES ('daily-work-journal', 'Daily Work Journal', 'enabled', '2026-06-08T12:00:00Z');
                    INSERT INTO workflow_runs
                      (id, workflow_id, workflow_name, status, started_at, idempotency_key)
                    VALUES
                      ('legacy-run', 'daily-work-journal', 'Daily Work Journal', 'running',
                       '2026-06-08T12:00:00Z', 'legacy-idempotency');
                    INSERT INTO workflow_step_runs
                      (id, workflow_run_id, step_id, status, started_at)
                    VALUES
                      ('step-run-1', 'legacy-run', 'ask-ai', 'running', '2026-06-08T12:00:00Z');
                    INSERT INTO agent_tool_events
                      (id, workflow_run_id, step_id, tool_id, status, input_json, created_at)
                    VALUES
                      ('valid-tool-event', 'legacy-run', 'ask-ai', 'web.search', 'requested',
                       '{\"query\":\"weather today\"}', '2026-06-08T12:01:00Z'),
                      ('invalid-tool-event', 'legacy-run', 'missing-step', 'web.search', 'requested',
                       '{\"query\":\"weather tomorrow\"}', '2026-06-08T12:02:00Z');
                    ",
                )
                .unwrap();
        }

        let repository = Repository::open(&db_path).unwrap();

        let preserved_events: Vec<String> = repository
            .connection
            .prepare("SELECT id FROM agent_tool_events ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(preserved_events, vec!["valid-tool-event"]);

        let invalid_insert = repository.connection.execute(
            "INSERT INTO agent_tool_events
             (id, workflow_run_id, step_id, tool_id, status, input_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                "tool-event-direct-missing-step-after-migration",
                "legacy-run",
                "missing-step",
                "web.search",
                "requested",
                serde_json::json!({ "query": "weather today" }).to_string(),
                "2026-06-08T12:03:00Z"
            ],
        );
        assert!(invalid_insert.is_err());
    }

    #[test]
    fn agent_tool_events_reject_raw_secret_arguments_and_results() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-raw"),
                &[workflow_step_run("step-run-raw", "run-raw", "ask-ai")],
            )
            .unwrap();
        let raw_secret = ["sk", "test-agent-tool-secret"].join("-");
        let raw_input_event = AgentToolEvent {
            id: "tool-event-raw-input".into(),
            workflow_run_id: "run-raw".into(),
            step_id: "ask-ai".into(),
            tool_id: "web.search".into(),
            status: AgentToolEventStatus::Requested,
            input_json: serde_json::json!({ "query": "weather today", "api_key": raw_secret }),
            output_json: None,
            error: None,
            created_at: "2026-06-08T12:00:00Z".into(),
            completed_at: None,
        };

        assert!(repository
            .insert_agent_tool_event(&raw_input_event)
            .is_err());
        assert!(!repository.database_contains(&raw_secret).unwrap());

        let redacted_event = AgentToolEvent {
            id: "tool-event-redacted-input".into(),
            input_json: serde_json::json!({ "query": "weather today", "api_key": "[redacted]" }),
            ..raw_input_event
        };
        repository.insert_agent_tool_event(&redacted_event).unwrap();

        assert!(repository
            .complete_agent_tool_event(
                "tool-event-redacted-input",
                AgentToolEventStatus::Succeeded,
                Some(serde_json::json!({
                    "summary": "Weather result",
                    "debug": format!("provider returned {raw_secret}")
                })),
                None,
            )
            .is_err());
        assert!(!repository.database_contains(&raw_secret).unwrap());
    }

    #[test]
    fn agent_tool_events_reject_sensitive_key_plain_values() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-sensitive-key-plain"),
                &[workflow_step_run(
                    "step-run-sensitive-key-plain",
                    "run-sensitive-key-plain",
                    "ask-ai",
                )],
            )
            .unwrap();
        let raw_input_event = AgentToolEvent {
            id: "tool-event-sensitive-key-input".into(),
            workflow_run_id: "run-sensitive-key-plain".into(),
            step_id: "ask-ai".into(),
            tool_id: "web.search".into(),
            status: AgentToolEventStatus::Requested,
            input_json: serde_json::json!({
                "github_token": "plain-secret",
                "credentialRef": "abcd1234"
            }),
            output_json: None,
            error: None,
            created_at: "2026-06-08T12:00:00Z".into(),
            completed_at: None,
        };

        assert!(repository
            .insert_agent_tool_event(&raw_input_event)
            .is_err());
        assert!(!repository.database_contains("plain-secret").unwrap());
        assert!(!repository.database_contains("abcd1234").unwrap());

        let redacted_event = AgentToolEvent {
            id: "tool-event-sensitive-key-redacted".into(),
            input_json: serde_json::json!({
                "github_token": "[redacted]",
                "credentialRef": "[redacted]"
            }),
            ..raw_input_event
        };
        repository.insert_agent_tool_event(&redacted_event).unwrap();

        assert!(repository
            .complete_agent_tool_event(
                "tool-event-sensitive-key-redacted",
                AgentToolEventStatus::Succeeded,
                Some(serde_json::json!({
                    "client_secret_value": "plain-secret",
                    "private_key_pem": "abcd1234"
                })),
                None,
            )
            .is_err());
        assert!(!repository.database_contains("plain-secret").unwrap());
        assert!(!repository.database_contains("abcd1234").unwrap());
    }

    #[test]
    fn agent_tool_events_reject_full_sensitive_assignment_values() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-sensitive-assignment-values"),
                &[workflow_step_run(
                    "step-run-sensitive-assignment-values",
                    "run-sensitive-assignment-values",
                    "ask-ai",
                )],
            )
            .unwrap();

        for (id, value, leaked) in [
            (
                "tool-event-sensitive-assignment-authorization",
                "Authorization: Bearer abc123",
                "abc123",
            ),
            (
                "tool-event-sensitive-assignment-basic",
                "token = Basic abc123",
                "abc123",
            ),
            (
                "tool-event-sensitive-assignment-quoted",
                "openai_api_key=\"plain secret value\"",
                "plain secret value",
            ),
            (
                "tool-event-sensitive-assignment-spaces",
                "client_secret_value=plain secret value",
                "plain secret value",
            ),
        ] {
            let event = AgentToolEvent {
                id: id.into(),
                workflow_run_id: "run-sensitive-assignment-values".into(),
                step_id: "ask-ai".into(),
                tool_id: "web.search".into(),
                status: AgentToolEventStatus::Requested,
                input_json: serde_json::json!({ "summary": value }),
                output_json: None,
                error: None,
                created_at: "2026-06-08T12:00:00Z".into(),
                completed_at: None,
            };

            assert!(
                repository.insert_agent_tool_event(&event).is_err(),
                "{value}"
            );
            assert!(!repository.database_contains(leaked).unwrap());
        }
    }

    #[test]
    fn agent_tool_events_allow_normal_words_that_contain_sk_dash() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-normal-text"),
                &[workflow_step_run(
                    "step-run-normal-text",
                    "run-normal-text",
                    "ask-ai",
                )],
            )
            .unwrap();
        let event = AgentToolEvent {
            input_json: serde_json::json!({
                "checks": [
                    "disk-space check",
                    "risk-based decision",
                    "flask-app logs"
                ]
            }),
            ..agent_tool_event("tool-event-normal-text", "run-normal-text")
        };

        repository.insert_agent_tool_event(&event).unwrap();
        let events = repository
            .agent_tool_events_for_run("run-normal-text")
            .unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_json["checks"][0], "disk-space check");
    }

    #[test]
    fn agent_tool_events_reject_known_token_families_in_nested_json() {
        let token_samples = vec![
            ["sk", "test-agent-tool-secret"].join("-"),
            format!("{}{}", "github_pat_", "11AA22BB33CC44DD55EE66FF"),
            format!("{}{}", "ghp_", "11AA22BB33CC44DD55EE66FF"),
            format!(
                "{}{}",
                "xoxb-", "123456789012-123456789012-abcdEFGHijklMNOP"
            ),
            format!("{}{}", "AIza", "SyA1234567890abcdefghijklmnoPQRSTUV"),
            format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE"),
            format!("{}{}", "Bearer ", "abcdefghijklmnopqrstuvwxyz1234567890"),
            format!("{}{}", "bearer ", "abcdefghijklmnopqrstuvwxyz1234567890"),
        ];

        for (index, token) in token_samples.iter().enumerate() {
            let mut repository = repo();
            let run_id = format!("run-token-{index}");
            repository
                .create_run_with_steps(
                    &workflow_run(&run_id),
                    &[workflow_step_run(
                        &format!("step-run-token-{index}"),
                        &run_id,
                        "ask-ai",
                    )],
                )
                .unwrap();
            let event = AgentToolEvent {
                id: format!("tool-event-token-{index}"),
                workflow_run_id: run_id,
                input_json: serde_json::json!({
                    "nested": {
                        "trace": format!("tool returned {token}")
                    }
                }),
                ..agent_tool_event("unused", "unused")
            };

            assert!(
                repository.insert_agent_tool_event(&event).is_err(),
                "expected token sample to be rejected: {token}"
            );
            assert!(!repository.database_contains(token).unwrap());
        }
    }

    #[test]
    fn agent_tool_events_reject_token_shaped_secrets_in_json_keys() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-secret-key"),
                &[workflow_step_run(
                    "step-run-secret-key",
                    "run-secret-key",
                    "ask-ai",
                )],
            )
            .unwrap();
        let raw_secret = ["sk", "test-agent-tool-secret"].join("-");
        let event = AgentToolEvent {
            input_json: serde_json::json!({
                "nested": {
                    raw_secret.clone(): "accidentally used token as a field name"
                }
            }),
            ..agent_tool_event("tool-event-secret-key", "run-secret-key")
        };

        assert!(repository.insert_agent_tool_event(&event).is_err());
        assert!(!repository.database_contains(&raw_secret).unwrap());
    }

    #[test]
    fn agent_tool_events_reject_missing_step_reference() {
        let mut repository = repo();
        repository
            .create_run_with_steps(&workflow_run("run-missing-step"), &[])
            .unwrap();
        let event = agent_tool_event("tool-event-missing-step", "run-missing-step");

        assert!(repository.insert_agent_tool_event(&event).is_err());
    }

    #[test]
    fn agent_tool_events_reject_invalid_initial_lifecycle_state() {
        let invalid_events = [
            AgentToolEvent {
                id: "tool-event-initial-succeeded".into(),
                status: AgentToolEventStatus::Succeeded,
                ..agent_tool_event("unused", "unused")
            },
            AgentToolEvent {
                id: "tool-event-initial-failed".into(),
                status: AgentToolEventStatus::Failed,
                ..agent_tool_event("unused", "unused")
            },
            AgentToolEvent {
                id: "tool-event-initial-blocked".into(),
                status: AgentToolEventStatus::Blocked,
                ..agent_tool_event("unused", "unused")
            },
            AgentToolEvent {
                id: "tool-event-initial-completed-at".into(),
                completed_at: Some("2026-06-08T12:01:00Z".into()),
                ..agent_tool_event("unused", "unused")
            },
            AgentToolEvent {
                id: "tool-event-initial-output".into(),
                output_json: Some(serde_json::json!({ "summary": "already complete" })),
                ..agent_tool_event("unused", "unused")
            },
            AgentToolEvent {
                id: "tool-event-initial-error".into(),
                error: Some("already failed".into()),
                ..agent_tool_event("unused", "unused")
            },
        ];

        for event in invalid_events {
            let mut repository = repo();
            repository
                .create_run_with_steps(
                    &workflow_run(&event.workflow_run_id),
                    &[workflow_step_run(
                        &format!("step-run-{}", event.id),
                        &event.workflow_run_id,
                        &event.step_id,
                    )],
                )
                .unwrap();

            assert!(
                repository.insert_agent_tool_event(&event).is_err(),
                "expected invalid initial state to be rejected for {}",
                event.id
            );
            let events = repository
                .agent_tool_events_for_run(&event.workflow_run_id)
                .unwrap();
            assert!(events.is_empty());
        }
    }

    #[test]
    fn agent_tool_events_direct_sql_rejects_missing_step_reference() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-direct-missing-step"),
                &[workflow_step_run(
                    "step-run-direct-existing",
                    "run-direct-missing-step",
                    "existing-step",
                )],
            )
            .unwrap();

        let result = repository.connection.execute(
            "INSERT INTO agent_tool_events
             (id, workflow_run_id, step_id, tool_id, status, input_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                "tool-event-direct-missing-step",
                "run-direct-missing-step",
                "missing-step",
                "web.search",
                "requested",
                serde_json::json!({ "query": "weather today" }).to_string(),
                "2026-06-08T12:00:00Z"
            ],
        );

        assert!(result.is_err());
    }

    #[test]
    fn agent_tool_events_duplicate_ids_fail_instead_of_replacing() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-duplicate-event"),
                &[workflow_step_run(
                    "step-run-duplicate-event",
                    "run-duplicate-event",
                    "ask-ai",
                )],
            )
            .unwrap();
        let event = agent_tool_event("tool-event-duplicate", "run-duplicate-event");

        repository.insert_agent_tool_event(&event).unwrap();
        assert!(repository.insert_agent_tool_event(&event).is_err());
    }

    #[test]
    fn agent_tool_events_complete_missing_event_fails() {
        let repository = repo();

        assert!(repository
            .complete_agent_tool_event(
                "missing-tool-event",
                AgentToolEventStatus::Succeeded,
                Some(serde_json::json!({ "summary": "not written" })),
                None,
            )
            .is_err());
    }

    #[test]
    fn agent_tool_events_complete_rejects_requested_status() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-complete-requested"),
                &[workflow_step_run(
                    "step-run-complete-requested",
                    "run-complete-requested",
                    "ask-ai",
                )],
            )
            .unwrap();
        let event = agent_tool_event("tool-event-complete-requested", "run-complete-requested");

        repository.insert_agent_tool_event(&event).unwrap();

        assert!(repository
            .complete_agent_tool_event(
                "tool-event-complete-requested",
                AgentToolEventStatus::Requested,
                None,
                None,
            )
            .is_err());
    }

    #[test]
    fn agent_tool_events_double_completion_fails_without_overwriting() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-double-complete"),
                &[workflow_step_run(
                    "step-run-double-complete",
                    "run-double-complete",
                    "ask-ai",
                )],
            )
            .unwrap();
        let event = agent_tool_event("tool-event-double-complete", "run-double-complete");

        repository.insert_agent_tool_event(&event).unwrap();
        repository
            .complete_agent_tool_event(
                "tool-event-double-complete",
                AgentToolEventStatus::Succeeded,
                Some(serde_json::json!({ "summary": "first result" })),
                None,
            )
            .unwrap();

        assert!(repository
            .complete_agent_tool_event(
                "tool-event-double-complete",
                AgentToolEventStatus::Failed,
                Some(serde_json::json!({ "summary": "second result" })),
                Some("second error"),
            )
            .is_err());

        let events = repository
            .agent_tool_events_for_run("run-double-complete")
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].status, AgentToolEventStatus::Succeeded);
        assert_eq!(
            events[0].output_json,
            Some(serde_json::json!({ "summary": "first result" }))
        );
        assert!(events[0].error.is_none());
    }

    #[test]
    fn agent_tool_events_unknown_status_fails_to_load() {
        let mut repository = repo();
        repository
            .create_run_with_steps(
                &workflow_run("run-unknown-status"),
                &[workflow_step_run(
                    "step-run-unknown-status",
                    "run-unknown-status",
                    "ask-ai",
                )],
            )
            .unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO agent_tool_events
                 (id, workflow_run_id, step_id, tool_id, status, input_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    "tool-event-unknown-status",
                    "run-unknown-status",
                    "ask-ai",
                    "web.search",
                    "mysterious",
                    serde_json::json!({ "query": "weather today" }).to_string(),
                    "2026-06-08T12:00:00Z"
                ],
            )
            .unwrap();

        assert!(repository
            .agent_tool_events_for_run("run-unknown-status")
            .is_err());
    }

    #[test]
    fn configure_provider_account_stores_secret_outside_sqlite() {
        std::env::set_var("RAVEN_CREDENTIAL_STORE", "file");
        let mut repository = repo();
        let account = ProviderAccount {
            id: "openai-api-key".into(),
            provider_kind: ProviderKind::Llm,
            display_name: "OpenAI API key".into(),
            credential_ref: "keychain:pending".into(),
            settings_json: serde_json::json!({ "provider_id": "openai" }),
        };

        let configured = repository
            .configure_provider_account(account, Some("test secret placeholder"))
            .unwrap();

        assert_eq!(configured.credential_ref, "credential-file:openai-api-key");
        assert!(!repository
            .raw_database_text()
            .unwrap()
            .contains("test secret placeholder"));
        std::env::remove_var("RAVEN_CREDENTIAL_STORE");
    }

    #[test]
    fn configure_provider_account_rejects_path_like_ids() {
        std::env::set_var("RAVEN_CREDENTIAL_STORE", "file");
        let mut repository = repo();
        let credential_root = repository
            .artifacts_dir
            .parent()
            .unwrap()
            .join("credentials");
        let account = ProviderAccount {
            id: "../outside".into(),
            provider_kind: ProviderKind::Llm,
            display_name: "Unsafe account".into(),
            credential_ref: "keychain:pending".into(),
            settings_json: serde_json::json!({ "provider_id": "openai" }),
        };

        let result =
            repository.configure_provider_account(account, Some("test secret placeholder"));

        assert!(matches!(result, Err(DbError::InvalidProviderAccountId(_))));
        assert!(!credential_root.join("../outside.credential").exists());
        std::env::remove_var("RAVEN_CREDENTIAL_STORE");
    }

    #[test]
    fn credential_resolver_rejects_path_like_file_references() {
        let repository = repo();

        let result = repository.resolve_credential_reference("credential-file:../outside");

        assert!(matches!(result, Err(DbError::InvalidProviderAccountId(_))));
    }

    #[test]
    fn llm_credential_resolver_reads_provider_account_secret_reference() {
        std::env::set_var("RAVEN_CREDENTIAL_STORE", "file");
        let mut repository = repo();
        let account = ProviderAccount {
            id: "openai-api-key".into(),
            provider_kind: ProviderKind::Llm,
            display_name: "OpenAI API key".into(),
            credential_ref: "keychain:pending".into(),
            settings_json: serde_json::json!({ "provider_id": "openai" }),
        };
        repository
            .configure_provider_account(account, Some("runtime secret placeholder"))
            .unwrap();

        let resolved = repository
            .resolve_llm_credential("default-openai")
            .unwrap()
            .unwrap();

        assert_eq!(resolved.provider_id, "openai");
        assert_eq!(resolved.model, "gpt-4.1");
        assert_eq!(resolved.credential, "runtime secret placeholder");
        assert!(!repository
            .raw_database_text()
            .unwrap()
            .contains("runtime secret placeholder"));
        std::env::remove_var("RAVEN_CREDENTIAL_STORE");
    }

    #[test]
    fn artifact_destinations_store_folder_settings() {
        let repository = repo();
        let folder = std::env::temp_dir().join(format!("raven-obsidian-{}", uuid::Uuid::new_v4()));

        repository
            .configure_artifact_destination("obsidian_vault", &folder)
            .unwrap();

        let settings_text = repository.raw_settings_text().unwrap();
        assert!(settings_text.contains("artifact_destination:obsidian_vault"));
        assert!(settings_text.contains(folder.to_string_lossy().as_ref()));
    }

    #[test]
    fn ai_chat_import_folder_scan_persists_context_artifact() {
        let repository = repo();
        let folder =
            std::env::temp_dir().join(format!("raven-chat-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("standup.md"),
            "# Standup Export\n\nDiscussed workflow validation.",
        )
        .unwrap();

        repository.configure_ai_chat_import_folder(&folder).unwrap();
        let pack = repository.scan_ai_chat_import_folder().unwrap();

        assert!(pack.summary.contains("Standup Export"));
        assert_eq!(
            repository.context_artifact_count("ai_chat_import").unwrap(),
            1
        );
        assert!(repository
            .raw_settings_text()
            .unwrap()
            .contains("context_provider:ai_chat_import"));
    }

    #[test]
    fn configured_document_import_health_reports_ocr_tool_availability() {
        let repository = repo();
        let folder =
            std::env::temp_dir().join(format!("raven-document-import-{}", uuid::Uuid::new_v4()));

        repository
            .configure_document_import_folder(&folder)
            .unwrap();

        let health = repository
            .dynamic_registry_health()
            .unwrap()
            .into_iter()
            .find(|provider| provider.id == "document_import")
            .unwrap();

        assert_eq!(health.status, ProviderStatus::Available);
        assert!(health.summary.contains(folder.to_string_lossy().as_ref()));
        assert!(health.summary.contains("pdftoppm"));
        assert!(health.summary.contains("tesseract"));
        assert!(
            health.summary.contains("scanned PDFs can be OCRed")
                || health.summary.contains("install pdftoppm and tesseract"),
            "expected OCR availability or installation guidance, got {:?}",
            health.summary
        );
    }

    #[test]
    fn nestweaver_configuration_stores_cli_settings() {
        let repository = repo();

        repository
            .configure_nestweaver(
                "/usr/local/bin/nestweaver",
                Some("/tmp/nestweaver.lbug"),
                Some("raven"),
                5000,
            )
            .unwrap();

        let settings = repository.raw_settings_text().unwrap();
        assert!(settings.contains("context_provider:nestweaver"));
        assert!(settings.contains("/usr/local/bin/nestweaver"));
        assert!(settings.contains("/tmp/nestweaver.lbug"));
        assert!(settings.contains("\"project\":\"raven\""));
        assert!(settings.contains("\"token_budget\":5000"));
    }

    #[test]
    fn export_artifact_relative_path_uses_repository_root() {
        let mut repository = repo();
        let artifact = run_daily_work_journal_fixture(&mut repository);

        let exported_path = repository
            .export_artifact(&artifact.id, "exports/daily-work-journal.md".into())
            .unwrap();

        let expected = repository
            .artifacts_dir
            .parent()
            .unwrap()
            .canonicalize()
            .unwrap()
            .join("exports")
            .join("daily-work-journal.md");
        assert_eq!(exported_path, expected.to_string_lossy());
        assert!(expected.exists());
        assert!(std::fs::read_to_string(expected)
            .unwrap()
            .contains("# Daily Work Journal"));
    }

    #[test]
    fn export_artifact_rejects_relative_parent_traversal() {
        let mut repository = repo();
        let artifact = run_daily_work_journal_fixture(&mut repository);
        let app_data_root = repository.artifacts_dir.parent().unwrap().to_path_buf();
        let escaped_path = app_data_root
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("escaped-artifact.md");
        let _ = std::fs::remove_file(&escaped_path);

        let error = repository
            .export_artifact(&artifact.id, "../escaped-artifact.md".into())
            .unwrap_err();

        assert!(matches!(error, DbError::InvalidPath(_)));
        assert!(!escaped_path.exists());
    }

    #[test]
    fn export_artifact_to_configured_destination_writes_slugged_markdown() {
        let mut repository = repo();
        let artifact = run_daily_work_journal_fixture(&mut repository);
        let folder = std::env::temp_dir().join(format!("raven-markdown-{}", uuid::Uuid::new_v4()));
        repository
            .configure_artifact_destination("markdown_folder", &folder)
            .unwrap();

        let exported_path = repository
            .export_artifact_to_destination(&artifact.id, "markdown_folder")
            .unwrap();

        assert_eq!(
            exported_path,
            folder
                .canonicalize()
                .unwrap()
                .join("daily-work-journal.md")
                .to_string_lossy()
        );
        assert!(std::path::Path::new(&exported_path).exists());
        assert!(std::fs::read_to_string(exported_path)
            .unwrap()
            .contains("# Daily Work Journal"));
    }

    #[test]
    fn export_artifact_to_obsidian_writes_valid_frontmatter() {
        let mut repository = repo();
        let artifact = run_daily_work_journal_fixture(&mut repository);
        let folder = std::env::temp_dir().join(format!("raven-obsidian-{}", uuid::Uuid::new_v4()));
        repository
            .configure_artifact_destination("obsidian_vault", &folder)
            .unwrap();

        let exported_path = repository
            .export_artifact_to_destination(&artifact.id, "obsidian_vault")
            .unwrap();
        let markdown = std::fs::read_to_string(exported_path).unwrap();

        assert!(markdown.starts_with("---\n"));
        assert!(markdown.contains("title: \"Daily Work Journal\""));
        assert!(markdown.contains("artifact_type: \"daily_work_journal\""));
        assert!(markdown.contains("source_refs:"));
        assert!(markdown.contains("# Daily Work Journal"));
    }

    #[test]
    fn export_artifact_to_destination_uses_safe_fallback_filename() {
        let mut repository = repo();
        let artifact = Artifact {
            id: "artifact-symbol-title".into(),
            title: "../***".into(),
            artifact_type: "note".into(),
            workflow_run_id: "run-symbol-title".into(),
            content_path: repository.artifact_paths("artifact-symbol-title").0,
            metadata_path: repository.artifact_paths("artifact-symbol-title").1,
            content_markdown: "# Safe filename".into(),
            metadata: serde_json::json!({}),
            source_refs: Vec::new(),
            created_at: Utc::now().to_rfc3339(),
        };
        let run = WorkflowRun {
            id: artifact.workflow_run_id.clone(),
            workflow_id: "daily-work-journal".into(),
            workflow_name: "Daily Work Journal".into(),
            status: RunStatus::Running,
            started_at: Utc::now().to_rfc3339(),
            completed_at: None,
            failure_reason: None,
            idempotency_key: format!("manual:safe:{}", uuid::Uuid::new_v4()),
            trigger_kind: "manual".into(),
            retry_count: 0,
            parent_run_id: None,
            error_classification: None,
            provider_profile_id: None,
            blocked_reason: None,
            required_provider_id: None,
            required_profile_id: None,
            setup_action: None,
            total_tokens: None,
            input_tokens: None,
            output_tokens: None,
            total_cost_usd: None,
        };
        repository.create_run_with_steps(&run, &[]).unwrap();
        repository.write_artifact(&artifact).unwrap();
        let folder = std::env::temp_dir().join(format!("raven-markdown-{}", uuid::Uuid::new_v4()));
        repository
            .configure_artifact_destination("markdown_folder", &folder)
            .unwrap();

        let exported_path = repository
            .export_artifact_to_destination(&artifact.id, "markdown_folder")
            .unwrap();

        let canonical_folder = folder.canonicalize().unwrap();
        assert_eq!(
            exported_path,
            canonical_folder.join("artifact.md").to_string_lossy()
        );
        assert!(std::path::Path::new(&exported_path).starts_with(&canonical_folder));
    }

    #[test]
    fn approve_draft_uses_transactional_version_write() {
        let mut repository = repo();
        let draft = workflow::draft_from_prompt("Create a daily work journal").unwrap();
        repository.approve_workflow_draft(&draft).unwrap();
        let latest = repository
            .latest_workflow_version("daily-work-journal")
            .unwrap()
            .unwrap();
        assert_eq!(latest.status, WorkflowStatus::Enabled);
        assert_eq!(latest.approval_mode.as_deref(), Some("always_review"));
    }

    #[test]
    fn approve_draft_preserves_requested_approval_mode() {
        let mut repository = repo();
        let draft = workflow::draft_from_prompt(
            "Create a weather workflow and keep approval mode auto approve",
        )
        .unwrap();

        let approved = repository.approve_workflow_draft(&draft).unwrap();

        assert_eq!(approved.approval_mode.as_deref(), Some("auto_approve"));
    }

    #[test]
    fn approve_planned_draft_persists_planner_rationale_on_legacy_workflow_drafts() {
        let path = db_path();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE workflow_drafts (
                  id TEXT PRIMARY KEY,
                  prompt TEXT NOT NULL,
                  summary TEXT NOT NULL,
                  permission_changes_json TEXT NOT NULL,
                  destination_writes_json TEXT NOT NULL DEFAULT '[]',
                  diff_json TEXT NOT NULL DEFAULT '[]',
                  validation_status TEXT NOT NULL,
                  approval_status TEXT NOT NULL DEFAULT 'needs_review',
                  builder_profile_id TEXT,
                  validation_errors_json TEXT NOT NULL DEFAULT '[]',
                  definition_json TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                ",
            )
            .unwrap();
        drop(connection);

        let mut repository = Repository::open(&path).unwrap();
        let draft = workflow::draft_from_prompt(
            "Create a CSV operations report: parse this CSV, filter status=active, sort by revenue, limit 5, then summarize the result.\nname,status,revenue\nAcme,active,42\nBeta,inactive,9",
        )
        .unwrap();

        repository.approve_workflow_draft(&draft).unwrap();

        let stored_rationale: String = repository
            .connection
            .query_row(
                "SELECT planner_rationale_json FROM workflow_drafts WHERE id = ?1",
                params![draft.id],
                |row| row.get(0),
            )
            .unwrap();
        let stored_rationale: crate::planner::operations::OperationPlan =
            serde_json::from_str(&stored_rationale).unwrap();

        assert_eq!(stored_rationale.prompt, draft.prompt);
        assert!(stored_rationale
            .operations
            .iter()
            .any(|operation| { operation.capability_id.as_deref() == Some("data.parse_csv") }));
        assert!(stored_rationale.operations.iter().any(|operation| {
            operation.capability_id.as_deref() == Some("data.transform_json")
        }));
    }

    #[test]
    fn install_workflow_template_persists_planner_rationale_on_workflow_version() {
        let mut repository = repo();
        let draft = workflow::draft_from_prompt(
            "Create a CSV operations report: parse this CSV, filter status=active, sort by revenue, limit 5, then summarize the result.\nname,status,revenue\nAcme,active,42\nBeta,inactive,9",
        )
        .unwrap();
        let planner_rationale = draft.planner_rationale.clone().unwrap();

        let installed = repository
            .install_workflow_template(
                draft.definition,
                WorkflowStatus::Enabled,
                Some("review_changes"),
                Some(planner_rationale.clone()),
            )
            .unwrap();
        let latest = repository
            .latest_workflow_version(&installed.workflow_id)
            .unwrap()
            .unwrap();

        assert_eq!(installed.planner_rationale, Some(planner_rationale.clone()));
        assert_eq!(latest.planner_rationale, Some(planner_rationale));
    }

    #[test]
    fn safe_workflow_edit_creates_new_latest_version_without_duplicate_app_rows() {
        let mut repository = repo();

        let edited = repository
            .update_workflow_safe_fields(
                "daily-work-journal",
                WorkflowStatus::Disabled,
                "manual",
                Some("09:30"),
                None,
                None,
            )
            .unwrap();

        assert_eq!(edited.version, 2);
        assert_eq!(edited.status, WorkflowStatus::Disabled);
        assert_eq!(
            edited.definition.schedule.unwrap().local_time.as_deref(),
            Some("09:30")
        );

        let state = repository.app_state().unwrap();
        let daily_versions = state
            .workflows
            .iter()
            .filter(|workflow| workflow.workflow_id == "daily-work-journal")
            .collect::<Vec<_>>();
        assert_eq!(daily_versions.len(), 1);
        assert_eq!(daily_versions[0].version, 2);

        let stored_versions: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM workflow_versions WHERE workflow_id = ?1",
                params!["daily-work-journal"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_versions, 2);
    }

    #[test]
    fn safe_workflow_edit_updates_ai_step_profile_refs() {
        let mut repository = repo();

        let edited = repository
            .update_workflow_safe_fields(
                "current-weather",
                WorkflowStatus::Enabled,
                "manual",
                None,
                Some("auto_approve"),
                Some("claude-code-oauth-local"),
            )
            .unwrap();

        assert_eq!(
            edited.definition.defaults.llm_profile_ref,
            "claude-code-oauth-local"
        );
        assert_eq!(
            edited.definition.steps[0].llm_profile_ref.as_deref(),
            Some("claude-code-oauth-local")
        );
        assert_eq!(edited.approval_mode.as_deref(), Some("auto_approve"));
    }

    #[test]
    fn manual_workflow_edits_are_not_returned_as_due_schedules() {
        let mut repository = repo();

        repository
            .update_workflow_safe_fields(
                "daily-work-journal",
                WorkflowStatus::Enabled,
                "manual",
                Some("09:30"),
                None,
                None,
            )
            .unwrap();

        assert!(repository
            .enabled_scheduled_workflows()
            .unwrap()
            .iter()
            .all(|workflow| workflow.workflow_id != "daily-work-journal"));
    }

    #[test]
    fn workflow_persistence_install_template_validates_and_versions() {
        let mut repository = repo();
        let mut definition = workflow::deterministic_weather_workflow();
        definition.id = "installed-weather".into();
        definition.name = "Installed Weather".into();

        let installed = repository
            .install_workflow_template(
                definition.clone(),
                WorkflowStatus::Enabled,
                Some("review_changes"),
                None,
            )
            .unwrap();

        assert_eq!(installed.workflow_id, "installed-weather");
        assert_eq!(installed.version, 1);
        assert_eq!(installed.status, WorkflowStatus::Enabled);
        assert_eq!(installed.approval_mode.as_deref(), Some("review_changes"));

        let reinstalled = repository
            .install_workflow_template(definition, WorkflowStatus::Draft, None, None)
            .unwrap();

        assert_eq!(reinstalled.version, 2);
        assert_eq!(reinstalled.status, WorkflowStatus::Draft);
        assert_eq!(reinstalled.approval_mode.as_deref(), Some("review_changes"));
    }

    #[test]
    fn workflow_persistence_create_version_rejects_invalid_definition() {
        let mut repository = repo();
        let mut definition = workflow::deterministic_weather_workflow();
        definition.id = "invalid-installed-weather".into();
        definition.defaults.destination_ref = "missing-destination".into();

        let error = repository
            .create_workflow_version(definition, WorkflowStatus::Enabled, None, None)
            .unwrap_err()
            .to_string();

        assert!(error.contains("validation failed"));
        assert!(repository
            .latest_workflow_version("invalid-installed-weather")
            .unwrap()
            .is_none());
    }

    #[test]
    fn workflow_persistence_archive_preserves_run_and_artifact_history() {
        let mut repository = repo();
        let artifact = run_daily_work_journal_fixture(&mut repository);

        let archived = repository.archive_workflow("daily-work-journal").unwrap();

        assert_eq!(archived.workflow_id, "daily-work-journal");
        assert_eq!(archived.version, 2);
        assert_eq!(archived.status, WorkflowStatus::Disabled);
        let error = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &FakeArtifactGenerator,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("is disabled"));

        let state = repository.app_state().unwrap();
        let workflow = state
            .workflows
            .iter()
            .find(|workflow| workflow.workflow_id == "daily-work-journal")
            .unwrap();
        assert_eq!(workflow.status, WorkflowStatus::Disabled);
        assert!(state
            .runs
            .iter()
            .any(|run| run.workflow_id == "daily-work-journal"));
        assert!(state
            .artifacts
            .iter()
            .any(|stored| stored.id == artifact.id));
    }
}
