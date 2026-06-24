use crate::{
    agent_auth::{AgentAuthMode, AgentAuthProfile, AgentRunnerKind},
    llm_provider::OllamaModel,
    models::{AppState, ProviderHealth, ProviderKind, ProviderStatus},
    services, ApprovalDecision, BuilderDraftEvent, BuilderDraftEventSink, RavenWorkflow,
    Repository, SchedulerService, SchedulerStatus, WorkflowDraft, WorkflowStatus,
};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct TestServerOptions {
    pub db_path: PathBuf,
    pub port: u16,
    pub deterministic: bool,
}

pub struct TestServerContext {
    repository: Mutex<Repository>,
    db_path: Option<PathBuf>,
    scheduler: Mutex<Option<SchedulerService>>,
    fixtures: Mutex<TestServerFixtures>,
    deterministic: bool,
}

impl TestServerContext {
    pub fn new(repository: Repository, deterministic: bool) -> Self {
        Self {
            repository: Mutex::new(repository),
            db_path: None,
            scheduler: Mutex::new(None),
            fixtures: Mutex::new(TestServerFixtures::default()),
            deterministic,
        }
    }

    pub fn new_with_db_path(repository: Repository, db_path: PathBuf, deterministic: bool) -> Self {
        Self {
            repository: Mutex::new(repository),
            scheduler: Mutex::new(Some(SchedulerService::new(db_path.clone()))),
            db_path: Some(db_path),
            fixtures: Mutex::new(TestServerFixtures::default()),
            deterministic,
        }
    }

    fn open_repository(&self) -> Result<Repository, String> {
        let db_path = self
            .db_path
            .clone()
            .or_else(|| std::env::var("RAVEN_DB_PATH").ok().map(PathBuf::from))
            .ok_or_else(|| "RAVEN_DB_PATH is required for live streamed test runs".to_string())?;
        Repository::open(db_path).map_err(|error| error.to_string())
    }

    fn set_onboarding_fixture(&self, fixture: Option<OnboardingFixtureKind>) -> Result<(), String> {
        let mut fixtures = self.fixtures.lock().map_err(|error| error.to_string())?;
        fixtures.onboarding = fixture;
        Ok(())
    }

    fn onboarding_fixture(&self) -> Result<Option<OnboardingFixtureKind>, String> {
        let fixtures = self.fixtures.lock().map_err(|error| error.to_string())?;
        Ok(fixtures.onboarding)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OnboardingFixtureKind {
    ProviderAutoDetection,
    OllamaUnavailable,
    NestWeaverDetectedNeedsConfig,
    NestWeaverReady,
}

impl OnboardingFixtureKind {
    fn from_name(value: &str) -> Result<Option<Self>, String> {
        match value {
            "provider_auto_detection" => Ok(Some(Self::ProviderAutoDetection)),
            "ollama_unavailable" => Ok(Some(Self::OllamaUnavailable)),
            "nestweaver_detected_needs_config" => Ok(Some(Self::NestWeaverDetectedNeedsConfig)),
            "nestweaver_ready" => Ok(Some(Self::NestWeaverReady)),
            "clear" => Ok(None),
            other => Err(format!("unsupported onboarding fixture {other}")),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct TestServerFixtures {
    onboarding: Option<OnboardingFixtureKind>,
}

struct NoopBuilderDraftEventSink;

impl BuilderDraftEventSink for NoopBuilderDraftEventSink {
    fn emit(&self, _event: BuilderDraftEvent) {}
}

#[cfg(test)]
const ROUTED_COMMANDS: &[&str] = &[
    "agent_auth_profiles",
    "analyze_usage_history",
    "app_version",
    "assign_schedule_override",
    "approve_workflow_draft",
    "archive_workflow",
    "approve_workflow_signature_baseline",
    "check_provider_readiness",
    "configure_ai_chat_import_folder",
    "configure_artifact_destination",
    "configure_document_import_folder",
    "configure_github_context",
    "configure_nestweaver",
    "configure_provider_account",
    "complete_onboarding",
    "create_workflow_draft",
    "create_workflow_version",
    "available_capability_catalog",
    "create_approval_grant",
    "detect_nestweaver",
    "detect_tools",
    "evaluate_workflow_preflight",
    "evaluate_workflow_definition_preflight",
    "get_dock_visibility",
    "get_global_shortcut",
    "export_artifact",
    "generate_artifact_preview",
    "get_app_state",
    "get_onboarding_completed",
    "usage_pricing_catalog",
    "get_workflow_step_runs",
    "get_saved_settings",
    "index_nestweaver_project",
    "install_workflow_template",
    "list_approval_history",
    "list_approval_grants",
    "list_capability_audit_events",
    "list_pending_approvals",
    "list_plugins",
    "ollama_models",
    "ollama_status",
    "provider_health",
    "regenerate_artifact",
    "resolve_approval",
    "revoke_approval_grant",
    "retry_workflow_run",
    "run_scheduled_due_workflows",
    "run_scheduler_tick",
    "run_workflow",
    "run_workflow_streamed",
    "scan_ai_chat_import_folder",
    "scan_document_import_folder",
    "scan_github_context",
    "scheduler_status",
    "set_autonomy_category_overrides",
    "set_autonomy_mode",
    "set_builder_profile",
    "set_dock_visibility",
    "set_global_shortcut",
    "set_test_fixture",
    "start_scheduler",
    "stop_scheduler",
    "system_health_diagnostics",
    "update_workflow_safe_fields",
];

pub fn serve(options: TestServerOptions) -> Result<(), String> {
    let repository = Repository::open(&options.db_path).map_err(|error| error.to_string())?;
    let context = TestServerContext::new_with_db_path(
        repository,
        options.db_path.clone(),
        options.deterministic,
    );
    let listener =
        TcpListener::bind(("127.0.0.1", options.port)).map_err(|error| error.to_string())?;

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => respond(stream, &context),
            Err(error) => eprintln!("[raven-test-server] failed to accept request: {error}"),
        }
    }

    Ok(())
}

pub fn handle_command(
    context: &TestServerContext,
    command_name: &str,
    args: Value,
) -> Result<Value, String> {
    match command_name {
        "get_app_state" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            let state =
                apply_test_fixtures_to_app_state(context, services::get_app_state(&repository)?)?;
            serde_json::to_value(state).map_err(|error| error.to_string())
        }
        "get_onboarding_completed" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(
                repository
                    .onboarding_completed()
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "complete_onboarding" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            repository
                .set_onboarding_completed()
                .map_err(|error| error.to_string())?;
            Ok(json!(null))
        }
        "get_dock_visibility" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(
                repository
                    .dock_visible()
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "set_dock_visibility" => {
            let visible = args
                .get("visible")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            repository
                .set_dock_visible(visible)
                .map_err(|error| error.to_string())?;
            Ok(json!(null))
        }
        "get_global_shortcut" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(
                repository
                    .global_shortcut()
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "set_global_shortcut" => {
            let shortcut = string_arg(&args, "shortcut")
                .ok_or_else(|| "set_global_shortcut requires shortcut".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            repository
                .set_global_shortcut(&shortcut)
                .map_err(|error| error.to_string())?;
            Ok(json!(null))
        }
        "set_test_fixture" => {
            let fixture_name = match args
                .get("onboardingFixture")
                .or_else(|| args.get("onboarding_fixture"))
            {
                Some(Value::Null) | None => None,
                Some(Value::String(value)) => Some(value.as_str()),
                Some(_) => {
                    return Err(
                        "set_test_fixture requires onboardingFixture to be a string or null"
                            .to_string(),
                    )
                }
            };
            let fixture = fixture_name
                .map(OnboardingFixtureKind::from_name)
                .transpose()?
                .flatten();
            context.set_onboarding_fixture(fixture)?;
            Ok(json!(null))
        }
        "get_workflow_step_runs" => {
            let run_id = string_arg(&args, "runId")
                .or_else(|| string_arg(&args, "run_id"))
                .ok_or_else(|| "get_workflow_step_runs requires runId".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::get_workflow_step_runs(&repository, &run_id)?)
                .map_err(|error| error.to_string())
        }
        "analyze_usage_history" => {
            let period = string_arg(&args, "period").unwrap_or_else(|| "today".to_string());
            let multiplier = args
                .get("multiplier")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(2.0);
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::analyze_usage_history(
                &repository,
                &period,
                multiplier,
            )?)
            .map_err(|error| error.to_string())
        }
        "usage_pricing_catalog" => serde_json::to_value(services::usage_pricing_catalog()?)
            .map_err(|error| error.to_string()),
        "detect_tools" => {
            serde_json::to_value(services::detect_tools()).map_err(|error| error.to_string())
        }
        "available_capability_catalog" => {
            let mode = autonomy_mode_arg(&args)?.unwrap_or(crate::autonomy::AutonomyMode::SafeAuto);
            let category_overrides = category_overrides_arg(&args)?;
            serde_json::to_value(
                services::available_capability_catalog_with_category_overrides(
                    mode,
                    &category_overrides,
                ),
            )
            .map_err(|error| error.to_string())
        }
        "evaluate_workflow_preflight" => {
            let workflow_id = string_arg(&args, "workflowId")
                .or_else(|| string_arg(&args, "workflow_id"))
                .ok_or_else(|| "evaluate_workflow_preflight requires workflowId".to_string())?;
            let version = args
                .get("version")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| "evaluate_workflow_preflight requires version".to_string())?;
            let mode = autonomy_mode_arg(&args)?.unwrap_or(crate::autonomy::AutonomyMode::SafeAuto);
            let category_overrides = category_overrides_arg(&args)?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(
                services::evaluate_workflow_preflight_with_category_overrides(
                    &repository,
                    &workflow_id,
                    version,
                    mode,
                    &category_overrides,
                )?,
            )
            .map_err(|error| error.to_string())
        }
        "evaluate_workflow_definition_preflight" => {
            let definition = args
                .get("definition")
                .ok_or_else(|| {
                    "evaluate_workflow_definition_preflight requires definition".to_string()
                })
                .and_then(|value| {
                    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
                })?;
            let version = args
                .get("version")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| {
                    "evaluate_workflow_definition_preflight requires version".to_string()
                })?;
            let mode = autonomy_mode_arg(&args)?.unwrap_or(crate::autonomy::AutonomyMode::SafeAuto);
            let category_overrides = category_overrides_arg(&args)?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(
                services::evaluate_workflow_definition_preflight_with_category_overrides(
                    &repository,
                    &definition,
                    version,
                    mode,
                    &category_overrides,
                )?,
            )
            .map_err(|error| error.to_string())
        }
        "create_approval_grant" => {
            let value = args
                .get("grant")
                .ok_or_else(|| "create_approval_grant requires grant".to_string())?;
            let grant = serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::create_approval_grant(&repository, grant)?)
                .map_err(|error| error.to_string())
        }
        "approve_workflow_signature_baseline" => {
            let workflow_id = string_arg(&args, "workflowId")
                .or_else(|| string_arg(&args, "workflow_id"))
                .ok_or_else(|| {
                    "approve_workflow_signature_baseline requires workflowId".to_string()
                })?;
            let workflow_version = args
                .get("workflowVersion")
                .or_else(|| args.get("workflow_version"))
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| {
                    "approve_workflow_signature_baseline requires workflowVersion".to_string()
                })?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::approve_workflow_signature_baseline(
                &repository,
                &workflow_id,
                workflow_version,
            )?;
            Ok(json!(null))
        }
        "revoke_approval_grant" => {
            let id = string_arg(&args, "id")
                .ok_or_else(|| "revoke_approval_grant requires id".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::revoke_approval_grant(&repository, &id)?;
            Ok(json!(null))
        }
        "list_approval_grants" => {
            let workflow_id =
                string_arg(&args, "workflowId").or_else(|| string_arg(&args, "workflow_id"));
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::list_approval_grants(
                &repository,
                workflow_id.as_deref(),
            )?)
            .map_err(|error| error.to_string())
        }
        "list_capability_audit_events" => {
            let run_id = string_arg(&args, "runId")
                .or_else(|| string_arg(&args, "run_id"))
                .ok_or_else(|| "list_capability_audit_events requires runId".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::list_capability_audit_events(
                &repository,
                &run_id,
            )?)
            .map_err(|error| error.to_string())
        }
        "assign_schedule_override" => {
            let workflow_id = string_arg(&args, "workflowId")
                .or_else(|| string_arg(&args, "workflow_id"))
                .ok_or_else(|| "assign_schedule_override requires workflowId".to_string())?;
            let original_run_at = string_arg(&args, "originalRunAt")
                .or_else(|| string_arg(&args, "original_run_at"))
                .ok_or_else(|| "assign_schedule_override requires originalRunAt".to_string())?;
            let scheduled_run_at = string_arg(&args, "scheduledRunAt")
                .or_else(|| string_arg(&args, "scheduled_run_at"))
                .ok_or_else(|| "assign_schedule_override requires scheduledRunAt".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::assign_schedule_override(
                &repository,
                &workflow_id,
                &original_run_at,
                &scheduled_run_at,
            )?)
            .map_err(|error| error.to_string())
        }
        "run_workflow" => {
            let workflow_id = string_arg(&args, "workflowId")
                .or_else(|| string_arg(&args, "workflow_id"))
                .ok_or_else(|| "run_workflow requires workflowId".to_string())?;
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            let result = if context.deterministic {
                services::run_workflow_deterministic(&mut repository, &workflow_id)?
            } else {
                services::run_workflow(&mut repository, &workflow_id)?
            };
            serde_json::to_value(result).map_err(|error| error.to_string())
        }
        "run_workflow_streamed" => {
            let workflow_id = string_arg(&args, "workflowId")
                .or_else(|| string_arg(&args, "workflow_id"))
                .ok_or_else(|| "run_workflow_streamed requires workflowId".to_string())?;
            let result = if context.deterministic {
                let mut repository = context
                    .repository
                    .lock()
                    .map_err(|error| error.to_string())?;
                services::run_workflow_deterministic_streamed(&mut repository, &workflow_id)?
            } else {
                let mut repository = context.open_repository()?;
                crate::stream::run_workflow_to_event_log(&mut repository, &workflow_id)?
            };
            serde_json::to_value(result).map_err(|error| error.to_string())
        }
        "install_workflow_template" => {
            let definition = workflow_definition_arg(&args)?;
            let status = workflow_status_arg(&args)?;
            let approval_mode =
                string_arg(&args, "approvalMode").or_else(|| string_arg(&args, "approval_mode"));
            let planner_rationale = planner_rationale_arg(&args)?;
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            let version = services::install_workflow_template(
                &mut repository,
                definition,
                status,
                approval_mode.as_deref(),
                planner_rationale,
            )?;
            serde_json::to_value(version).map_err(|error| error.to_string())
        }
        "create_workflow_version" => {
            let definition = workflow_definition_arg(&args)?;
            let status = workflow_status_arg(&args)?;
            let approval_mode =
                string_arg(&args, "approvalMode").or_else(|| string_arg(&args, "approval_mode"));
            let planner_rationale = planner_rationale_arg(&args)?;
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            let version = services::create_workflow_version(
                &mut repository,
                definition,
                status,
                approval_mode.as_deref(),
                planner_rationale,
            )?;
            serde_json::to_value(version).map_err(|error| error.to_string())
        }
        "archive_workflow" => {
            let workflow_id = string_arg(&args, "workflowId")
                .or_else(|| string_arg(&args, "workflow_id"))
                .ok_or_else(|| "archive_workflow requires workflowId".to_string())?;
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::archive_workflow(&mut repository, &workflow_id)?)
                .map_err(|error| error.to_string())
        }
        "update_workflow_safe_fields" => {
            let workflow_id = string_arg(&args, "workflowId")
                .or_else(|| string_arg(&args, "workflow_id"))
                .ok_or_else(|| "update_workflow_safe_fields requires workflowId".to_string())?;
            let status = workflow_status_arg(&args)?;
            let cadence = string_arg(&args, "cadence")
                .ok_or_else(|| "update_workflow_safe_fields requires cadence".to_string())?;
            let local_time =
                string_arg(&args, "localTime").or_else(|| string_arg(&args, "local_time"));
            let approval_mode =
                string_arg(&args, "approvalMode").or_else(|| string_arg(&args, "approval_mode"));
            let llm_profile_ref =
                string_arg(&args, "llmProfileRef").or_else(|| string_arg(&args, "llm_profile_ref"));
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::update_workflow_safe_fields(
                &mut repository,
                &workflow_id,
                status,
                &cadence,
                local_time.as_deref(),
                approval_mode.as_deref(),
                llm_profile_ref.as_deref(),
            )?)
            .map_err(|error| error.to_string())
        }
        "list_pending_approvals" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::list_pending_approvals(&repository)?)
                .map_err(|error| error.to_string())
        }
        "list_approval_history" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::list_approval_history(&repository)?)
                .map_err(|error| error.to_string())
        }
        "resolve_approval" => {
            let id = string_arg(&args, "id")
                .ok_or_else(|| "resolve_approval requires id".to_string())?;
            let decision = approval_decision_arg(&args)?;
            let reason = string_arg(&args, "reason");
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            let approval = if context.deterministic {
                services::resolve_approval_deterministic(
                    &mut repository,
                    &id,
                    decision,
                    reason.as_deref(),
                )?
            } else {
                services::resolve_approval(&mut repository, &id, decision, reason.as_deref())?
            };
            serde_json::to_value(approval).map_err(|error| error.to_string())
        }
        "provider_health" => {
            let providers = apply_test_fixtures_to_providers(context, services::provider_health())?;
            serde_json::to_value(providers).map_err(|error| error.to_string())
        }
        "system_health_diagnostics" => {
            let scheduler_status = {
                let scheduler = context
                    .scheduler
                    .lock()
                    .map_err(|error| error.to_string())?;
                scheduler
                    .as_ref()
                    .map(services::scheduler_status)
                    .unwrap_or(SchedulerStatus {
                        running: false,
                        poll_interval_seconds: 60,
                    })
            };
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::system_health_diagnostics(
                &repository,
                scheduler_status,
            )?)
            .map_err(|error| error.to_string())
        }
        "agent_auth_profiles" => {
            let profiles = test_fixture_agent_auth_profiles(context)?
                .unwrap_or_else(services::agent_auth_profiles);
            serde_json::to_value(profiles).map_err(|error| error.to_string())
        }
        "get_saved_settings" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::get_saved_settings(&repository)
        }
        "check_provider_readiness" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            let providers = apply_test_fixtures_to_providers(
                context,
                services::check_provider_readiness(&repository)?,
            )?;
            serde_json::to_value(providers).map_err(|error| error.to_string())
        }
        "set_builder_profile" => {
            let profile_id = string_arg(&args, "profileId")
                .or_else(|| string_arg(&args, "profile_id"))
                .ok_or_else(|| "set_builder_profile requires profileId".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::set_builder_profile(&repository, profile_id)?;
            Ok(json!(null))
        }
        "set_autonomy_mode" => {
            let autonomy_mode = autonomy_mode_arg(&args)?
                .ok_or_else(|| "set_autonomy_mode requires autonomyMode".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::set_autonomy_mode(&repository, autonomy_mode)?;
            Ok(json!(null))
        }
        "set_autonomy_category_overrides" => {
            let category_overrides = category_overrides_arg(&args)?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::set_autonomy_category_overrides(&repository, category_overrides)?;
            Ok(json!(null))
        }
        "create_workflow_draft" => {
            let prompt = string_arg(&args, "prompt")
                .ok_or_else(|| "create_workflow_draft requires prompt".to_string())?;
            let builder_profile_id = string_arg(&args, "builderProfileId")
                .or_else(|| string_arg(&args, "builder_profile_id"));
            let request_id =
                string_arg(&args, "requestId").or_else(|| string_arg(&args, "request_id"));
            let previous_draft = args
                .get("previousDraft")
                .or_else(|| args.get("previous_draft"))
                .cloned()
                .map(serde_json::from_value::<crate::models::WorkflowDraftRevisionContext>)
                .transpose()
                .map_err(|error| error.to_string())?;
            if context.deterministic {
                let mut draft = if let Some(previous_draft) = previous_draft.as_ref() {
                    crate::workflow::draft_revision_from_prompt(&prompt, previous_draft)
                        .map_err(|error| error.to_string())?
                } else {
                    crate::workflow::draft_from_prompt(&prompt)
                        .map_err(|error| error.to_string())?
                };
                draft.builder_profile_id = builder_profile_id;
                return serde_json::to_value(draft).map_err(|error| error.to_string());
            }
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::create_workflow_draft(
                &repository,
                &prompt,
                builder_profile_id.as_deref(),
                request_id,
                previous_draft.as_ref(),
                &NoopBuilderDraftEventSink,
            )?)
            .map_err(|error| error.to_string())
        }
        "approve_workflow_draft" => {
            let draft_value = args
                .get("draft")
                .ok_or_else(|| "approve_workflow_draft requires draft".to_string())?;
            let draft: WorkflowDraft =
                serde_json::from_value(draft_value.clone()).map_err(|error| error.to_string())?;
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::approve_workflow_draft(&mut repository, &draft)?)
                .map_err(|error| error.to_string())
        }
        "configure_provider_account" => {
            let account_value = args
                .get("account")
                .ok_or_else(|| "configure_provider_account requires account".to_string())?;
            let account =
                serde_json::from_value(account_value.clone()).map_err(|error| error.to_string())?;
            let raw_secret =
                string_arg(&args, "rawSecret").or_else(|| string_arg(&args, "raw_secret"));
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::configure_provider_account(
                &mut repository,
                account,
                raw_secret.as_deref(),
            )?)
            .map_err(|error| error.to_string())
        }
        "configure_artifact_destination" => {
            let destination_id = string_arg(&args, "destinationId")
                .or_else(|| string_arg(&args, "destination_id"))
                .ok_or_else(|| {
                    "configure_artifact_destination requires destinationId".to_string()
                })?;
            let folder_path = string_arg(&args, "folderPath")
                .or_else(|| string_arg(&args, "folder_path"))
                .ok_or_else(|| "configure_artifact_destination requires folderPath".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::configure_artifact_destination(&repository, &destination_id, folder_path)?;
            Ok(json!(null))
        }
        "configure_ai_chat_import_folder" => {
            let folder_path = string_arg(&args, "folderPath")
                .or_else(|| string_arg(&args, "folder_path"))
                .ok_or_else(|| "configure_ai_chat_import_folder requires folderPath".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::configure_ai_chat_import_folder(&repository, folder_path)?;
            Ok(json!(null))
        }
        "scan_ai_chat_import_folder" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::scan_ai_chat_import_folder(&repository)?)
                .map_err(|error| error.to_string())
        }
        "configure_document_import_folder" => {
            let folder_path = string_arg(&args, "folderPath")
                .or_else(|| string_arg(&args, "folder_path"))
                .ok_or_else(|| {
                    "configure_document_import_folder requires folderPath".to_string()
                })?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::configure_document_import_folder(&repository, folder_path)?;
            Ok(json!(null))
        }
        "scan_document_import_folder" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::scan_document_import_folder(&repository)?)
                .map_err(|error| error.to_string())
        }
        "configure_github_context" => {
            let repo_slug = string_arg(&args, "repoSlug")
                .or_else(|| string_arg(&args, "repo_slug"))
                .ok_or_else(|| "configure_github_context requires repoSlug".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::configure_github_context(&repository, &repo_slug)?;
            Ok(json!(null))
        }
        "scan_github_context" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::scan_github_context(&repository)?)
                .map_err(|error| error.to_string())
        }
        "configure_nestweaver" => {
            let binary_path = string_arg(&args, "binaryPath")
                .or_else(|| string_arg(&args, "binary_path"))
                .unwrap_or_else(|| "nestweaver".into());
            let db_path = string_arg(&args, "dbPath").or_else(|| string_arg(&args, "db_path"));
            let project = string_arg(&args, "project");
            let token_budget = args
                .get("tokenBudget")
                .or_else(|| args.get("token_budget"))
                .and_then(|value| value.as_u64())
                .unwrap_or(4000) as usize;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            services::configure_nestweaver(
                &repository,
                &binary_path,
                db_path.as_deref(),
                project.as_deref(),
                token_budget,
            )?;
            Ok(json!(null))
        }
        "index_nestweaver_project" => {
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            let current_dir = std::env::current_dir().map_err(|error| error.to_string())?;
            serde_json::to_value(services::index_nestweaver_project(
                &repository,
                &current_dir,
            )?)
            .map_err(|error| error.to_string())
        }
        "detect_nestweaver" => {
            if let Some(detection) = test_fixture_nestweaver_detection(context)? {
                return serde_json::to_value(detection).map_err(|error| error.to_string());
            }
            serde_json::to_value(services::detect_nestweaver()?).map_err(|error| error.to_string())
        }
        "export_artifact" => {
            let artifact_id = string_arg(&args, "artifactId")
                .or_else(|| string_arg(&args, "artifact_id"))
                .ok_or_else(|| "export_artifact requires artifactId".to_string())?;
            let destination_path = string_arg(&args, "destinationPath")
                .or_else(|| string_arg(&args, "destination_path"));
            let destination_id =
                string_arg(&args, "destinationId").or_else(|| string_arg(&args, "destination_id"));
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::export_artifact(
                &repository,
                &artifact_id,
                destination_path,
                destination_id,
            )?)
            .map_err(|error| error.to_string())
        }
        "run_scheduled_due_workflows" => {
            let schedule_window = string_arg(&args, "scheduleWindow")
                .or_else(|| string_arg(&args, "schedule_window"))
                .ok_or_else(|| "run_scheduled_due_workflows requires scheduleWindow".to_string())?;
            let workflow_ids = string_array_arg(&args, "workflowIds")
                .or_else(|| string_array_arg(&args, "workflow_ids"));
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::run_scheduled_due_workflows_for_ids(
                &mut repository,
                &schedule_window,
                workflow_ids.as_deref(),
            )?)
            .map_err(|error| error.to_string())
        }
        "start_scheduler" => {
            {
                let repository = context
                    .repository
                    .lock()
                    .map_err(|error| error.to_string())?;
                services::set_scheduler_enabled(&repository, true)?;
            }
            let mut scheduler = context
                .scheduler
                .lock()
                .map_err(|error| error.to_string())?;
            if let Some(scheduler) = scheduler.as_mut() {
                services::start_scheduler(scheduler)?;
            }
            Ok(json!(null))
        }
        "stop_scheduler" => {
            {
                let repository = context
                    .repository
                    .lock()
                    .map_err(|error| error.to_string())?;
                services::set_scheduler_enabled(&repository, false)?;
            }
            let mut scheduler = context
                .scheduler
                .lock()
                .map_err(|error| error.to_string())?;
            if let Some(scheduler) = scheduler.as_mut() {
                services::stop_scheduler(scheduler)?;
            }
            Ok(json!(null))
        }
        "scheduler_status" => {
            let scheduler = context
                .scheduler
                .lock()
                .map_err(|error| error.to_string())?;
            let status = scheduler
                .as_ref()
                .map(services::scheduler_status)
                .unwrap_or(SchedulerStatus {
                    running: false,
                    poll_interval_seconds: 60,
                });
            serde_json::to_value(status).map_err(|error| error.to_string())
        }
        "run_scheduler_tick" => {
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::run_scheduler_tick(&mut repository)?)
                .map_err(|error| error.to_string())
        }
        "generate_artifact_preview" => {
            let workflow_id = string_arg(&args, "workflowId")
                .or_else(|| string_arg(&args, "workflow_id"))
                .ok_or_else(|| "generate_artifact_preview requires workflowId".to_string())?;
            let repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::generate_artifact_preview(
                &repository,
                &workflow_id,
            )?)
            .map_err(|error| error.to_string())
        }
        "retry_workflow_run" => {
            let run_id = string_arg(&args, "runId")
                .or_else(|| string_arg(&args, "run_id"))
                .ok_or_else(|| "retry_workflow_run requires runId".to_string())?;
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::retry_workflow_run(&mut repository, &run_id)?)
                .map_err(|error| error.to_string())
        }
        "regenerate_artifact" => {
            let artifact_id = string_arg(&args, "artifactId")
                .or_else(|| string_arg(&args, "artifact_id"))
                .ok_or_else(|| "regenerate_artifact requires artifactId".to_string())?;
            let mut repository = context
                .repository
                .lock()
                .map_err(|error| error.to_string())?;
            serde_json::to_value(services::regenerate_artifact(
                &mut repository,
                &artifact_id,
            )?)
            .map_err(|error| error.to_string())
        }
        "app_version" => Ok(json!(services::app_version())),
        "ollama_status" => {
            if let Some(result) = test_fixture_ollama_status(context)? {
                return serde_json::to_value(result?).map_err(|error| error.to_string());
            }
            serde_json::to_value(services::ollama_status()?).map_err(|error| error.to_string())
        }
        "ollama_models" => {
            if let Some(result) = test_fixture_ollama_models(context)? {
                return serde_json::to_value(result?).map_err(|error| error.to_string());
            }
            serde_json::to_value(services::ollama_models()?).map_err(|error| error.to_string())
        }
        "list_plugins" => {
            serde_json::to_value(services::list_plugins()).map_err(|error| error.to_string())
        }
        _ => Err(format!("Unknown command {command_name}")),
    }
}

fn respond(mut stream: TcpStream, context: &TestServerContext) {
    let response = match read_request(&mut stream) {
        Ok(request) => match (request.method.as_str(), request.path.as_str()) {
            ("OPTIONS", path) if path.starts_with("/commands/") => empty_response(204),
            ("GET", "/health") => json_response(200, json!({ "ok": true })),
            ("POST", path) if path.starts_with("/commands/") => {
                let command_name = path.trim_start_matches("/commands/");
                let result = parse_body(&request.body)
                    .and_then(|args| handle_command(context, command_name, args));

                match result {
                    Ok(value) => json_response(200, value),
                    Err(error) => json_response(400, json!({ "error": error })),
                }
            }
            ("POST", _) => json_response(404, json!({ "error": "Unknown command endpoint" })),
            _ => json_response(404, json!({ "error": "Not found" })),
        },
        Err(error) => json_response(400, json!({ "error": error })),
    };

    if let Err(error) = stream.write_all(&response) {
        eprintln!("[raven-test-server] failed to send response: {error}");
    }
}

struct HttpRequest {
    method: String,
    path: String,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP method".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP path".to_string())?
        .to_string();

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if line == "\r\n" || line == "\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|error| format!("Invalid Content-Length: {error}"))?;
            }
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|error| error.to_string())?;
    }

    String::from_utf8(body)
        .map(|body| HttpRequest { method, path, body })
        .map_err(|error| format!("Invalid UTF-8 request body: {error}"))
}

fn parse_body(body: &str) -> Result<Value, String> {
    if body.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(body).map_err(|error| format!("Invalid JSON body: {error}"))
}

fn json_response(status: u16, value: Value) -> Vec<u8> {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"error\":\"json\"}".to_vec());
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        cors_headers(),
        body.len()
    );
    [headers.into_bytes(), body].concat()
}

fn empty_response(status: u16) -> Vec<u8> {
    let reason = match status {
        204 => "No Content",
        _ => "OK",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\n{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        cors_headers()
    )
    .into_bytes()
}

fn cors_headers() -> &'static str {
    "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: content-type"
}

fn string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

fn string_array_arg(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key).and_then(|value| {
        value.as_array().map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter(|item| !item.trim().is_empty())
                .map(ToString::to_string)
                .collect()
        })
    })
}

fn workflow_definition_arg(args: &Value) -> Result<RavenWorkflow, String> {
    let value = args
        .get("definition")
        .or_else(|| args.get("workflow"))
        .ok_or_else(|| "workflow definition is required".to_string())?;
    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
}

fn workflow_status_arg(args: &Value) -> Result<WorkflowStatus, String> {
    match string_arg(args, "status").as_deref() {
        Some("enabled") => Ok(WorkflowStatus::Enabled),
        Some("draft") => Ok(WorkflowStatus::Draft),
        Some("disabled") => Ok(WorkflowStatus::Disabled),
        Some(status) => Err(format!("unsupported workflow status {status}")),
        None => Err("workflow status is required".to_string()),
    }
}

fn planner_rationale_arg(
    args: &Value,
) -> Result<Option<crate::planner::operations::OperationPlan>, String> {
    let value = args
        .get("plannerRationale")
        .or_else(|| args.get("planner_rationale"));
    match value {
        Some(Value::Null) | None => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| error.to_string()),
    }
}

fn approval_decision_arg(args: &Value) -> Result<ApprovalDecision, String> {
    match string_arg(args, "decision").as_deref() {
        Some("approved") => Ok(ApprovalDecision::Approved),
        Some("rejected") => Ok(ApprovalDecision::Rejected),
        Some(decision) => Err(format!("unsupported approval decision {decision}")),
        None => Err("approval decision is required".to_string()),
    }
}

fn autonomy_mode_arg(args: &Value) -> Result<Option<crate::autonomy::AutonomyMode>, String> {
    let Some(value) = args
        .get("autonomyMode")
        .or_else(|| args.get("autonomy_mode"))
    else {
        return Ok(None);
    };
    serde_json::from_value(value.clone())
        .map(Some)
        .map_err(|error| error.to_string())
}

fn category_overrides_arg(
    args: &Value,
) -> Result<crate::autonomy::CategoryAutonomyOverrides, String> {
    let Some(value) = args
        .get("categoryOverrides")
        .or_else(|| args.get("category_overrides"))
    else {
        return Ok(crate::autonomy::CategoryAutonomyOverrides::new());
    };
    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
}

fn apply_test_fixtures_to_app_state(
    context: &TestServerContext,
    mut state: AppState,
) -> Result<AppState, String> {
    if let Some(profiles) = test_fixture_agent_auth_profiles(context)? {
        state.agent_auth_profiles = profiles;
    }
    state.providers = apply_test_fixtures_to_providers(context, state.providers)?;
    Ok(state)
}

fn apply_test_fixtures_to_providers(
    context: &TestServerContext,
    mut providers: Vec<ProviderHealth>,
) -> Result<Vec<ProviderHealth>, String> {
    if let Some(provider) = test_fixture_nestweaver_provider(context)? {
        replace_provider(&mut providers, provider);
    }
    Ok(providers)
}

fn replace_provider(providers: &mut Vec<ProviderHealth>, provider: ProviderHealth) {
    if let Some(existing) = providers
        .iter_mut()
        .find(|existing| existing.id == provider.id)
    {
        *existing = provider;
        return;
    }
    providers.push(provider);
}

fn test_fixture_agent_auth_profiles(
    context: &TestServerContext,
) -> Result<Option<Vec<AgentAuthProfile>>, String> {
    let Some(fixture) = context.onboarding_fixture()? else {
        return Ok(None);
    };
    Ok(Some(onboarding_fixture_agent_auth_profiles(fixture)))
}

fn onboarding_fixture_agent_auth_profiles(fixture: OnboardingFixtureKind) -> Vec<AgentAuthProfile> {
    vec![
        AgentAuthProfile {
            id: "codex-oauth-local".into(),
            display_name: "Codex OAuth (local CLI)".into(),
            runner_kind: AgentRunnerKind::CodexCli,
            auth_mode: AgentAuthMode::CodexOauthLocalCli,
            credential_ref: "codex:oauth:local-cli".into(),
            model: "gpt-5.4".into(),
            effort: "medium".into(),
            status: "available".into(),
            summary: "Deterministic full-stack fixture: Codex OAuth local CLI is ready.".into(),
        },
        AgentAuthProfile {
            id: "claude-code-oauth-local".into(),
            display_name: "Claude Code OAuth (local CLI)".into(),
            runner_kind: AgentRunnerKind::ClaudeCodeCli,
            auth_mode: AgentAuthMode::ClaudeCodeOauthLocalCli,
            credential_ref: "claude-code:oauth:local-cli".into(),
            model: "sonnet".into(),
            effort: "medium".into(),
            status: "available".into(),
            summary: "Deterministic full-stack fixture: Claude Code OAuth local CLI is ready."
                .into(),
        },
        AgentAuthProfile {
            id: "openai-api-key".into(),
            display_name: "OpenAI API key".into(),
            runner_kind: AgentRunnerKind::OpenAiApi,
            auth_mode: AgentAuthMode::ApiKeyEnv,
            credential_ref: "env:OPENAI_API_KEY".into(),
            model: "gpt-4.1".into(),
            effort: "medium".into(),
            status: "needs_config".into(),
            summary: "Uses an OpenAI API key reference for direct API-backed agent work.".into(),
        },
        AgentAuthProfile {
            id: "anthropic-api-key".into(),
            display_name: "Anthropic API key".into(),
            runner_kind: AgentRunnerKind::AnthropicApi,
            auth_mode: AgentAuthMode::ApiKeyEnv,
            credential_ref: "env:ANTHROPIC_API_KEY".into(),
            model: "claude-sonnet-4-5".into(),
            effort: "medium".into(),
            status: "needs_config".into(),
            summary: "Uses an Anthropic API key reference for direct Claude API calls.".into(),
        },
        AgentAuthProfile {
            id: "ollama-local".into(),
            display_name: "Ollama (local)".into(),
            runner_kind: AgentRunnerKind::OllamaLocal,
            auth_mode: AgentAuthMode::None,
            credential_ref: "".into(),
            model: "llama3.1:8b".into(),
            effort: "medium".into(),
            status: match fixture {
                OnboardingFixtureKind::OllamaUnavailable => "needs_config".into(),
                _ => "available".into(),
            },
            summary: match fixture {
                OnboardingFixtureKind::OllamaUnavailable => {
                    "Deterministic full-stack fixture: Ollama is installed but not running.".into()
                }
                _ => "Deterministic full-stack fixture: Ollama is running locally.".into(),
            },
        },
    ]
}

fn test_fixture_nestweaver_detection(
    context: &TestServerContext,
) -> Result<Option<Option<services::NestWeaverDetection>>, String> {
    let Some(fixture) = context.onboarding_fixture()? else {
        return Ok(None);
    };
    Ok(match fixture {
        OnboardingFixtureKind::ProviderAutoDetection | OnboardingFixtureKind::OllamaUnavailable => {
            Some(None)
        }
        OnboardingFixtureKind::NestWeaverDetectedNeedsConfig => {
            Some(Some(services::NestWeaverDetection {
                binary_path: "nestweaver".into(),
                db_path: None,
                projects: vec![],
            }))
        }
        OnboardingFixtureKind::NestWeaverReady => Some(Some(services::NestWeaverDetection {
            binary_path: "nestweaver".into(),
            db_path: Some("workspace-nestweaver.sqlite3".into()),
            projects: vec!["Raven".into()],
        })),
    })
}

fn test_fixture_nestweaver_provider(
    context: &TestServerContext,
) -> Result<Option<ProviderHealth>, String> {
    let Some(fixture) = context.onboarding_fixture()? else {
        return Ok(None);
    };
    Ok(match fixture {
        OnboardingFixtureKind::ProviderAutoDetection | OnboardingFixtureKind::OllamaUnavailable => {
            Some(ProviderHealth {
                id: "nestweaver".into(),
                name: "NestWeaver".into(),
                kind: ProviderKind::Context,
                status: ProviderStatus::Unavailable,
                summary: "NestWeaver is not connected; Raven will use Local Git context until it is configured.".into(),
                fallback_provider_id: Some("local_git".into()),
            })
        }
        OnboardingFixtureKind::NestWeaverDetectedNeedsConfig => Some(ProviderHealth {
            id: "nestweaver".into(),
            name: "NestWeaver".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::NeedsConfig,
            summary: "NestWeaver is detected but still needs project configuration.".into(),
            fallback_provider_id: Some("local_git".into()),
        }),
        OnboardingFixtureKind::NestWeaverReady => Some(ProviderHealth {
            id: "nestweaver".into(),
            name: "NestWeaver".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::Available,
            summary: "NestWeaver daemon 0.1.0 is ready with a configured project database."
                .into(),
            fallback_provider_id: Some("local_git".into()),
        }),
    })
}

fn test_fixture_ollama_status(
    context: &TestServerContext,
) -> Result<Option<Result<String, String>>, String> {
    let Some(fixture) = context.onboarding_fixture()? else {
        return Ok(None);
    };
    Ok(match fixture {
        OnboardingFixtureKind::ProviderAutoDetection
        | OnboardingFixtureKind::NestWeaverDetectedNeedsConfig
        | OnboardingFixtureKind::NestWeaverReady => Some(Ok("0.5.1".into())),
        OnboardingFixtureKind::OllamaUnavailable => Some(Err("Ollama fixture unavailable".into())),
    })
}

fn test_fixture_ollama_models(
    context: &TestServerContext,
) -> Result<Option<Result<Vec<OllamaModel>, String>>, String> {
    let Some(fixture) = context.onboarding_fixture()? else {
        return Ok(None);
    };
    Ok(match fixture {
        OnboardingFixtureKind::ProviderAutoDetection
        | OnboardingFixtureKind::NestWeaverDetectedNeedsConfig
        | OnboardingFixtureKind::NestWeaverReady => Some(Ok(vec![
            OllamaModel {
                name: "llama3.1:8b".into(),
                size: 4_700_000_000,
                parameter_size: Some("8B".into()),
                quantization_level: Some("Q4_K_M".into()),
            },
            OllamaModel {
                name: "qwen2.5-coder:7b".into(),
                size: 4_200_000_000,
                parameter_size: Some("7B".into()),
                quantization_level: Some("Q4_K_M".into()),
            },
        ])),
        OnboardingFixtureKind::OllamaUnavailable => Some(Ok(vec![])),
    })
}

#[cfg(test)]
mod tests {
    use super::{handle_command, TestServerContext, ROUTED_COMMANDS};
    use crate::models::{ProviderStatus, RunStatus, WorkflowStatus, WorkflowVersion};
    use crate::Repository;
    use serde_json::json;
    use std::sync::mpsc;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn test_server_get_app_state_reads_configured_database() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let response = handle_command(&context, "get_app_state", json!({})).unwrap();

        assert!(response["workflows"].as_array().unwrap().len() >= 3);
    }

    #[test]
    fn test_server_supports_onboarding_commands() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        assert!(ROUTED_COMMANDS.contains(&"get_onboarding_completed"));
        assert!(ROUTED_COMMANDS.contains(&"complete_onboarding"));

        let initial = handle_command(&context, "get_onboarding_completed", json!({})).unwrap();
        assert_eq!(initial, json!(false));

        let completed = handle_command(&context, "complete_onboarding", json!({})).unwrap();
        assert_eq!(completed, json!(null));

        let after = handle_command(&context, "get_onboarding_completed", json!({})).unwrap();
        assert_eq!(after, json!(true));
    }

    #[test]
    fn test_server_onboarding_fixture_overrides_provider_readiness() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        assert!(ROUTED_COMMANDS.contains(&"set_test_fixture"));
        handle_command(
            &context,
            "set_test_fixture",
            json!({ "onboardingFixture": "provider_auto_detection" }),
        )
        .unwrap();

        let state = handle_command(&context, "get_app_state", json!({})).unwrap();
        let profiles = state["agent_auth_profiles"].as_array().unwrap();
        assert!(profiles.iter().any(|profile| {
            profile["id"] == "codex-oauth-local" && profile["status"] == "available"
        }));
        assert!(profiles.iter().any(|profile| {
            profile["id"] == "claude-code-oauth-local" && profile["status"] == "available"
        }));

        let ollama_status = handle_command(&context, "ollama_status", json!({})).unwrap();
        assert_eq!(ollama_status, json!("0.5.1"));

        let ollama_models = handle_command(&context, "ollama_models", json!({})).unwrap();
        assert!(ollama_models
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["name"] == "llama3.1:8b"));

        let detection = handle_command(&context, "detect_nestweaver", json!({})).unwrap();
        assert!(detection.is_null());

        let providers = handle_command(&context, "check_provider_readiness", json!({})).unwrap();
        let nestweaver = providers
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["id"] == "nestweaver")
            .unwrap();
        assert_eq!(nestweaver["status"], json!(ProviderStatus::Unavailable));
        assert_eq!(nestweaver["fallback_provider_id"], "local_git");
    }

    #[test]
    fn test_server_non_nestweaver_onboarding_fixtures_stub_detect_nestweaver() {
        let fixtures = ["provider_auto_detection", "ollama_unavailable"];

        for fixture in fixtures {
            let dir = tempdir().unwrap();
            let db_path = dir.path().join(format!("{fixture}.sqlite3"));
            let repository = Repository::open(&db_path).unwrap();
            let context = TestServerContext::new(repository, true);

            handle_command(
                &context,
                "set_test_fixture",
                json!({ "onboardingFixture": fixture }),
            )
            .unwrap();

            let detection = handle_command(&context, "detect_nestweaver", json!({})).unwrap();
            assert!(
                detection.is_null(),
                "fixture {fixture} should stub detect_nestweaver"
            );

            let providers =
                handle_command(&context, "check_provider_readiness", json!({})).unwrap();
            let nestweaver = providers
                .as_array()
                .unwrap()
                .iter()
                .find(|provider| provider["id"] == "nestweaver")
                .unwrap();
            assert_eq!(
                nestweaver["status"],
                json!(ProviderStatus::Unavailable),
                "fixture {fixture} should keep NestWeaver unavailable",
            );
            assert_eq!(nestweaver["fallback_provider_id"], "local_git");
        }
    }

    #[test]
    fn test_server_onboarding_fixture_overrides_nestweaver_states() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        handle_command(
            &context,
            "set_test_fixture",
            json!({ "onboardingFixture": "nestweaver_detected_needs_config" }),
        )
        .unwrap();
        let detection = handle_command(&context, "detect_nestweaver", json!({})).unwrap();
        assert_eq!(detection["binary_path"], "nestweaver");
        assert!(detection["db_path"].is_null());
        let providers = handle_command(&context, "check_provider_readiness", json!({})).unwrap();
        let nestweaver = providers
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["id"] == "nestweaver")
            .unwrap();
        assert_eq!(nestweaver["status"], json!(ProviderStatus::NeedsConfig));

        handle_command(
            &context,
            "set_test_fixture",
            json!({ "onboardingFixture": "nestweaver_ready" }),
        )
        .unwrap();
        let ready_detection = handle_command(&context, "detect_nestweaver", json!({})).unwrap();
        assert_eq!(ready_detection["db_path"], "workspace-nestweaver.sqlite3");
        let ready_providers =
            handle_command(&context, "check_provider_readiness", json!({})).unwrap();
        let ready_nestweaver = ready_providers
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["id"] == "nestweaver")
            .unwrap();
        assert_eq!(ready_nestweaver["status"], json!(ProviderStatus::Available));
    }

    #[test]
    fn test_server_deterministic_create_workflow_draft_uses_local_template() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let response = handle_command(
            &context,
            "create_workflow_draft",
            json!({
                "prompt": "Create a manual workflow that asks an agent for Denver weather, saves a local app artifact, and uses auto approve.",
                "builderProfileId": "codex-oauth-local",
                "requestId": "test-draft-request",
            }),
        )
        .unwrap();

        assert_eq!(response["builder_profile_id"], "codex-oauth-local");
        assert_eq!(response["validation_status"], "valid");
        assert_eq!(response["approval_mode"], "auto_approve");
        assert_eq!(
            response["definition"]["defaults"]["llm_profile_ref"],
            "codex-oauth-local"
        );
        assert_eq!(
            response["definition"]["defaults"]["destination_ref"],
            "local-app"
        );
    }

    #[test]
    fn test_server_deterministic_create_workflow_draft_routes_seo_audit_to_seo_tools() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let response = handle_command(
            &context,
            "create_workflow_draft",
            json!({
                "prompt": "Create a manual SEO audit workflow for https://kehl.io that deterministically fetches the page, robots.txt, and sitemap, extracts metadata and links, then uses an agent only at the final step to write a concise Markdown SEO recommendations artifact.",
                "builderProfileId": "codex-oauth-local",
                "requestId": "test-seo-draft-request",
            }),
        )
        .unwrap();

        assert_eq!(response["builder_profile_id"], "codex-oauth-local");
        assert_eq!(response["validation_status"], "valid");
        assert_eq!(response["definition"]["id"], "seo-audit");
        let steps = response["definition"]["steps"].as_array().unwrap();
        assert!(steps
            .iter()
            .any(|step| step["provider"] == "web" && step["action"] == "fetch_page"));
        assert!(steps
            .iter()
            .any(|step| { step["provider"] == "seo" && step["action"] == "fetch_robots_txt" }));
        assert!(steps
            .iter()
            .any(|step| step["provider"] == "seo" && step["action"] == "fetch_sitemap"));
        assert!(steps
            .iter()
            .any(|step| step["provider"] == "seo" && step["action"] == "audit_metadata"));
        assert!(steps
            .iter()
            .any(|step| step["provider"] == "seo" && step["action"] == "audit_links"));
        let metadata_step = steps
            .iter()
            .find(|step| step["id"] == "audit-metadata")
            .unwrap();
        assert_eq!(
            metadata_step["inputs"]["body_text"],
            json!("$steps.fetch-page.body_text")
        );
        assert!(metadata_step["inputs"]["html"].is_null());
        let agent_steps = steps
            .iter()
            .filter(|step| step["provider"] == "agent" && step["action"] == "run_task")
            .collect::<Vec<_>>();
        assert_eq!(agent_steps.len(), 1);
        assert_eq!(agent_steps[0]["inputs"]["allowed_tools"], json!([]));
    }

    #[test]
    fn test_server_create_workflow_draft_prefers_catalog_tools_over_generic_template_words() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let response = handle_command(
            &context,
            "create_workflow_draft",
            json!({
                "prompt": "Create a morning brief report that collects the next 24 hour Denver weather forecast and trending news, then summarizes the planning implications.",
                "builderProfileId": "codex-oauth-local",
                "requestId": "test-catalog-draft-request",
            }),
        )
        .unwrap();

        assert_eq!(response["builder_profile_id"], "codex-oauth-local");
        assert_eq!(response["validation_status"], "valid");
        assert_ne!(response["definition"]["id"], "morning-brief");
        let steps = response["definition"]["steps"].as_array().unwrap();
        assert!(steps
            .iter()
            .any(|step| step["provider"] == "weather" && step["action"] == "forecast_24h"));
        assert!(steps
            .iter()
            .any(|step| step["provider"] == "news" && step["action"] == "trending"));
        let agent_steps = steps
            .iter()
            .filter(|step| step["provider"] == "agent" && step["action"] == "run_task")
            .collect::<Vec<_>>();
        assert_eq!(agent_steps.len(), 1);
        assert_eq!(agent_steps[0]["inputs"]["allowed_tools"], json!([]));
    }

    #[test]
    fn test_server_create_workflow_draft_includes_planner_rationale_for_transform_prompt() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let response = handle_command(
            &context,
            "create_workflow_draft",
            json!({
                "prompt": "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42",
                "builderProfileId": "codex-oauth-local",
                "requestId": "test-planned-draft-request",
            }),
        )
        .unwrap();

        assert_eq!(response["builder_profile_id"], "codex-oauth-local");
        assert_eq!(response["validation_status"], "valid");
        let planner_operations = response["planner_rationale"]["operations"]
            .as_array()
            .expect("planner rationale operations should exist");
        assert!(planner_operations
            .iter()
            .any(|operation| { operation["capability_id"] == json!("data.transform_json") }));
        let steps = response["definition"]["steps"].as_array().unwrap();
        assert!(steps
            .iter()
            .any(|step| step["provider"] == "data" && step["action"] == "transform_json"));
        let agent_steps = steps
            .iter()
            .filter(|step| step["provider"] == "agent" && step["action"] == "run_task")
            .collect::<Vec<_>>();
        assert_eq!(agent_steps.len(), 1);
        assert_eq!(agent_steps[0]["inputs"]["allowed_tools"], json!([]));
    }

    #[test]
    fn test_server_deterministic_revision_preserves_csv_content_and_updates_filter() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let initial = handle_command(
            &context,
            "create_workflow_draft",
            json!({
                "prompt": "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
                "builderProfileId": "codex-oauth-local",
                "requestId": "test-initial-csv-draft",
            }),
        )
        .unwrap();

        let revised = handle_command(
            &context,
            "create_workflow_draft",
            json!({
                "prompt": "Change the existing workflow to filter status=inactive instead. Keep the same CSV rows, selected fields, sorting, artifact destination, and deterministic provider steps.",
                "builderProfileId": "codex-oauth-local",
                "requestId": "test-revised-csv-draft",
                "previousDraft": {
                    "source_label": initial["summary"].clone(),
                    "validation_errors": initial["validation_errors"].clone(),
                    "planner_rationale": initial["planner_rationale"].clone(),
                    "definition": initial["definition"].clone(),
                },
            }),
        )
        .unwrap();

        let steps = revised["definition"]["steps"].as_array().unwrap();
        let parse_csv = steps
            .iter()
            .find(|step| step["provider"] == "data" && step["action"] == "parse_csv")
            .expect("parse_csv step should remain present");
        let transform = steps
            .iter()
            .find(|step| step["provider"] == "data" && step["action"] == "transform_json")
            .expect("transform_json step should remain present");

        assert_eq!(
            parse_csv["inputs"]["content"],
            json!("name,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500")
        );
        assert_eq!(
            transform["inputs"]["filter_equals"],
            json!({ "status": "inactive" })
        );
        assert_eq!(
            transform["inputs"]["select_fields"],
            json!(["name", "revenue"])
        );
        assert_eq!(transform["inputs"]["sort_by"], json!("revenue"));
        assert_eq!(transform["inputs"]["limit"], json!(5));
    }

    fn grant_current_weather_preflight(context: &TestServerContext) {
        let state = handle_command(context, "get_app_state", json!({})).unwrap();
        let workflow_version = state["workflows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|workflow| workflow["workflow_id"] == "current-weather")
            .and_then(|workflow| workflow["version"].as_i64())
            .unwrap();
        let preflight = handle_command(
            context,
            "evaluate_workflow_preflight",
            json!({
                "workflowId": "current-weather",
                "version": workflow_version,
                "autonomyMode": "safe_auto",
            }),
        )
        .unwrap();
        let capabilities = preflight["capabilities"].as_array().unwrap();
        let signature_for = |capability_id: &str| {
            capabilities
                .iter()
                .find(|capability| capability["capability_id"] == capability_id)
                .and_then(|capability| capability["signature_hash"].as_str())
                .unwrap()
                .to_string()
        };

        let credential_ref = preflight["credentials"][0]["credential_ref"]
            .as_str()
            .unwrap();
        handle_command(
            context,
            "create_approval_grant",
            json!({
                "grant": {
                    "id": format!("grant-{}", uuid::Uuid::new_v4()),
                    "workflow_id": "current-weather",
                    "workflow_version": workflow_version,
                    "capability_id": "agent.run_task",
                    "grant_type": "credential_use",
                    "scope": {
                        "credential_ref": credential_ref,
                        "paths": [],
                        "domains": [],
                        "resource_ids": [],
                        "max_deletes": null,
                        "max_overwrite_bytes": null,
                        "external_targets": []
                    },
                    "approved_by_user_at": "2026-06-21T00:00:00Z",
                    "expires_at": null,
                    "signature_hash": signature_for("agent.run_task"),
                    "status": "active"
                }
            }),
        )
        .unwrap();

        let network_resources = preflight["scoped_network_resources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["capability_id"] == "agent.run_task")
            .map(|item| item["value"].clone())
            .collect::<Vec<_>>();
        if !network_resources.is_empty() {
            handle_command(
                context,
                "create_approval_grant",
                json!({
                    "grant": {
                        "id": format!("grant-{}", uuid::Uuid::new_v4()),
                        "workflow_id": "current-weather",
                        "workflow_version": workflow_version,
                        "capability_id": "agent.run_task",
                        "grant_type": "network_access",
                        "scope": {
                            "credential_ref": null,
                            "paths": [],
                            "domains": [],
                            "resource_ids": network_resources,
                            "max_deletes": null,
                            "max_overwrite_bytes": null,
                            "external_targets": []
                        },
                        "approved_by_user_at": "2026-06-21T00:00:00Z",
                        "expires_at": null,
                        "signature_hash": signature_for("agent.run_task"),
                        "status": "active"
                    }
                }),
            )
            .unwrap();
        }

        let write_paths = preflight["scoped_file_writes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["capability_id"] == "local_app.write_artifact")
            .map(|item| item["value"].clone())
            .collect::<Vec<_>>();
        handle_command(
            context,
            "create_approval_grant",
            json!({
                "grant": {
                    "id": format!("grant-{}", uuid::Uuid::new_v4()),
                    "workflow_id": "current-weather",
                    "workflow_version": workflow_version,
                    "capability_id": "local_app.write_artifact",
                    "grant_type": "file_write",
                    "scope": {
                        "credential_ref": null,
                        "paths": write_paths,
                        "domains": [],
                        "resource_ids": [],
                        "max_deletes": null,
                        "max_overwrite_bytes": null,
                        "external_targets": []
                    },
                    "approved_by_user_at": "2026-06-21T00:00:00Z",
                    "expires_at": null,
                    "signature_hash": signature_for("local_app.write_artifact"),
                    "status": "active"
                }
            }),
        )
        .unwrap();
    }

    #[test]
    fn test_server_deterministic_agent_run_blocks_without_grants() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let response = handle_command(
            &context,
            "run_workflow",
            json!({ "workflowId": "current-weather" }),
        )
        .unwrap();

        assert_eq!(response["run"]["workflow_id"], "current-weather");
        assert_eq!(response["run"]["status"], json!(RunStatus::Blocked));
        assert!(response["artifact"].is_null());
        assert!(response["run"]["blocked_reason"]
            .as_str()
            .unwrap()
            .contains("agent.run_task"));
    }

    #[test]
    fn test_server_deterministic_approval_resume_uses_deterministic_agent_executor() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);
        let state = handle_command(&context, "get_app_state", json!({})).unwrap();
        let definition = state["workflows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|workflow| workflow["workflow_id"] == "current-weather")
            .unwrap()["definition"]
            .clone();
        handle_command(
            &context,
            "create_workflow_version",
            json!({
                "definition": definition,
                "status": "enabled",
                "approvalMode": "always_review",
            }),
        )
        .unwrap();
        grant_current_weather_preflight(&context);

        let blocked = handle_command(
            &context,
            "run_workflow",
            json!({ "workflowId": "current-weather" }),
        )
        .unwrap();
        assert_eq!(blocked["run"]["status"], json!(RunStatus::Blocked));

        let approvals = handle_command(&context, "list_pending_approvals", json!({})).unwrap();
        let approval_id = approvals[0]["id"].as_str().unwrap();
        handle_command(
            &context,
            "resolve_approval",
            json!({
                "id": approval_id,
                "decision": "approved",
                "reason": "deterministic e2e resume",
            }),
        )
        .unwrap();
        let state = handle_command(&context, "get_app_state", json!({})).unwrap();
        let run_id = blocked["run"]["id"].as_str().unwrap();
        let resumed_run = state["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|run| run["id"] == run_id)
            .unwrap();
        assert_eq!(
            resumed_run["status"],
            json!(RunStatus::Succeeded),
            "{resumed_run}"
        );
        assert!(state["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|artifact| {
                artifact["workflow_run_id"] == run_id
                    && artifact["title"]
                        .as_str()
                        .unwrap()
                        .contains("Current Weather")
            }));
        assert!(
            handle_command(&context, "list_pending_approvals", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn test_server_deterministic_run_workflow_persists_run_and_artifact() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);
        grant_current_weather_preflight(&context);

        let response = handle_command(
            &context,
            "run_workflow",
            json!({ "workflowId": "current-weather" }),
        )
        .unwrap();

        assert_eq!(response["run"]["workflow_id"], "current-weather");
        assert_eq!(response["run"]["status"], json!(RunStatus::Succeeded));
        assert!(response["artifact"].is_object());

        let state = handle_command(&context, "get_app_state", json!({})).unwrap();
        assert_eq!(state["runs"].as_array().unwrap().len(), 1);
        assert_eq!(state["artifacts"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_server_deterministic_streamed_run_returns_event_sequence() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);
        grant_current_weather_preflight(&context);

        let response = handle_command(
            &context,
            "run_workflow_streamed",
            json!({ "workflowId": "current-weather" }),
        )
        .unwrap();
        let event_kinds = response["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|event| event["kind"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            response["result"]["run"]["status"],
            json!(RunStatus::Succeeded)
        );
        assert_eq!(
            event_kinds,
            vec![
                "RUN_STARTED",
                "STEP_STARTED",
                "THINKING_CONTENT",
                "TOOL_CALL_START",
                "TOOL_CALL_END",
                "STEP_FINISHED",
                "STEP_STARTED",
                "TEXT_MESSAGE_CONTENT",
                "STEP_FINISHED",
                "RUN_FINISHED"
            ]
        );
    }

    #[test]
    fn run_totals_persist_for_deterministic_streamed_run_app_state() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);
        grant_current_weather_preflight(&context);

        let response = handle_command(
            &context,
            "run_workflow_streamed",
            json!({ "workflowId": "current-weather" }),
        )
        .unwrap();
        let state = handle_command(&context, "get_app_state", json!({})).unwrap();

        assert_eq!(response["result"]["run"]["total_tokens"], 16);
        assert_eq!(response["result"]["run"]["total_cost_usd"], 0.0);
        assert_eq!(state["runs"][0]["total_tokens"], 16);
        assert_eq!(state["runs"][0]["total_cost_usd"], 0.0);
    }

    #[test]
    fn command_preflight_response_includes_cors_headers() {
        let response = String::from_utf8(super::empty_response(204)).unwrap();

        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        assert!(response.contains("Access-Control-Allow-Origin: *"));
        assert!(response.contains("Access-Control-Allow-Methods: POST, GET, OPTIONS"));
        assert!(response.contains("Access-Control-Allow-Headers: content-type"));
        assert!(response.contains("Content-Length: 0"));
    }

    #[test]
    fn command_json_response_includes_cors_headers() {
        let response = String::from_utf8(super::json_response(200, json!({ "ok": true }))).unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Access-Control-Allow-Origin: *"));
        assert!(response.contains("Access-Control-Allow-Headers: content-type"));
    }

    #[test]
    fn test_server_nondeterministic_streamed_run_does_not_require_shared_repository_lock() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let mut definition = crate::workflow::current_weather();
        definition.id = "http-lock-agent".into();
        definition.name = "HTTP Lock Agent".into();
        definition.defaults.llm_profile_ref = "missing-agent-profile".into();
        definition.steps[0].llm_profile_ref = Some("missing-agent-profile".into());
        repository
            .insert_workflow_version(&WorkflowVersion {
                id: "http-lock-agent-v1".into(),
                workflow_id: "http-lock-agent".into(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition,
                created_at: chrono::Utc::now().to_rfc3339(),
                approval_mode: None,
                planner_rationale: None,
            })
            .unwrap();
        let context = TestServerContext::new_with_db_path(repository, db_path, false);
        let guard = context.repository.lock().unwrap();
        let (tx, rx) = mpsc::channel();

        std::thread::scope(|scope| {
            let context_ref = &context;
            scope.spawn(move || {
                let response = handle_command(
                    context_ref,
                    "run_workflow_streamed",
                    json!({ "workflowId": "http-lock-agent" }),
                );
                tx.send(response).unwrap();
            });

            let initial_response = rx.recv_timeout(Duration::from_secs(2));
            let returned_while_locked = initial_response.is_ok();
            drop(guard);
            let response = initial_response
                .unwrap_or_else(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap())
                .unwrap();

            assert!(
                returned_while_locked,
                "non-deterministic streamed runs should not wait on the shared repository mutex"
            );
            assert_eq!(
                response["result"]["run"]["status"],
                json!(RunStatus::Blocked)
            );
        });
    }

    #[test]
    fn test_server_routes_workflow_persistence_commands() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);
        let mut definition = crate::workflow::deterministic_weather_workflow();
        definition.id = "server-installed-weather".into();
        definition.name = "Server Installed Weather".into();

        let installed = handle_command(
            &context,
            "install_workflow_template",
            json!({
                "definition": definition,
                "status": "enabled",
                "approvalMode": "review_changes"
            }),
        )
        .unwrap();
        assert_eq!(installed["workflow_id"], "server-installed-weather");
        assert_eq!(installed["version"], 1);

        let archived = handle_command(
            &context,
            "archive_workflow",
            json!({ "workflowId": "server-installed-weather" }),
        )
        .unwrap();
        assert_eq!(archived["status"], "disabled");
        assert_eq!(archived["version"], 2);
    }

    #[test]
    fn test_server_routes_capability_registry_commands() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let tools = handle_command(&context, "detect_tools", json!({})).unwrap();
        assert!(tools.as_array().is_some());

        let catalog = handle_command(
            &context,
            "available_capability_catalog",
            json!({ "autonomyMode": "safe_auto" }),
        )
        .unwrap();
        assert!(!catalog["hash"].as_str().unwrap().is_empty());
        assert!(catalog["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|capability| capability["id"] == "open_meteo.current_weather"));

        let mut definition = crate::workflow::deterministic_weather_workflow();
        definition.id = "preflight-weather".into();
        definition.name = "Preflight Weather".into();
        handle_command(
            &context,
            "install_workflow_template",
            json!({
                "definition": definition,
                "status": "enabled",
                "approvalMode": "review_changes"
            }),
        )
        .unwrap();

        let preflight = handle_command(
            &context,
            "evaluate_workflow_preflight",
            json!({
                "workflowId": "preflight-weather",
                "version": 1,
                "autonomyMode": "safe_auto"
            }),
        )
        .unwrap();
        assert_eq!(preflight["workflow_id"], "preflight-weather");
        assert_eq!(preflight["workflow_version"], 1);
        assert!(preflight["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|capability| capability["capability_id"] == "open_meteo.current_weather"));
        let definition_preflight = handle_command(
            &context,
            "evaluate_workflow_definition_preflight",
            json!({
                "definition": crate::workflow::deterministic_weather_workflow(),
                "version": 1,
                "autonomyMode": "safe_auto"
            }),
        )
        .unwrap();
        assert_eq!(
            definition_preflight["workflow_id"],
            crate::workflow::deterministic_weather_workflow().id
        );
        assert!(definition_preflight["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|capability| capability["capability_id"] == "open_meteo.current_weather"));
        let write_capability = preflight["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|capability| capability["capability_id"] == "local_app.write_artifact")
            .unwrap();
        let write_paths = preflight["scoped_file_writes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["capability_id"] == "local_app.write_artifact")
            .map(|item| item["value"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();

        let created = handle_command(
            &context,
            "create_approval_grant",
            json!({
                "grant": {
                    "id": "grant-current-weather",
                    "workflow_id": "preflight-weather",
                    "workflow_version": 1,
                    "capability_id": "local_app.write_artifact",
                    "grant_type": "file_write",
                    "scope": {
                        "credential_ref": null,
                        "paths": write_paths,
                        "domains": [],
                        "resource_ids": [],
                        "max_deletes": null,
                        "max_overwrite_bytes": null,
                        "external_targets": []
                    },
                    "approved_by_user_at": "2026-06-21T00:00:00Z",
                    "expires_at": null,
                    "signature_hash": write_capability["signature_hash"].as_str().unwrap(),
                    "status": "active"
                }
            }),
        )
        .unwrap();
        assert_eq!(created["id"], "grant-current-weather");

        let listed = handle_command(
            &context,
            "list_approval_grants",
            json!({ "workflowId": "preflight-weather" }),
        )
        .unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["status"], "active");

        handle_command(
            &context,
            "revoke_approval_grant",
            json!({ "id": "grant-current-weather" }),
        )
        .unwrap();

        let revoked = handle_command(
            &context,
            "list_approval_grants",
            json!({ "workflowId": "preflight-weather" }),
        )
        .unwrap();
        assert_eq!(revoked[0]["status"], "revoked");

        handle_command(
            &context,
            "approve_workflow_signature_baseline",
            json!({
                "workflowId": "preflight-weather",
                "workflowVersion": 1
            }),
        )
        .unwrap();
        let repository = context.repository.lock().unwrap();
        assert_eq!(
            repository
                .last_approved_workflow_signature("preflight-weather")
                .unwrap(),
            Some(crate::runtime::approval_signature(
                &repository
                    .workflow_version_by_id("preflight-weather-v1")
                    .unwrap()
                    .unwrap(),
            ))
        );
    }

    #[test]
    fn test_server_routes_capability_audit_events() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let mut repository = Repository::open(&db_path).unwrap();
        repository
            .create_run_with_steps(
                &crate::models::WorkflowRun {
                    id: "run-1".into(),
                    workflow_id: "daily-work-journal".into(),
                    workflow_name: "Daily Work Journal".into(),
                    status: crate::models::RunStatus::Succeeded,
                    started_at: "2026-06-19T10:00:00.000Z".into(),
                    completed_at: Some("2026-06-19T10:02:00.000Z".into()),
                    failure_reason: None,
                    idempotency_key: "run-1".into(),
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
                },
                &[],
            )
            .unwrap();
        repository
            .insert_capability_audit_event(&crate::models::CapabilityAuditEvent {
                id: "audit-1".into(),
                run_id: "run-1".into(),
                workflow_id: "daily-work-journal".into(),
                workflow_version: 3,
                step_id: "publish".into(),
                capability_id: "github.issue.comment".into(),
                decision: "needs_grant".into(),
                reason: "Matched pre-approved GitHub publishing grant.".into(),
                grant_id: Some("grant-1".into()),
                created_at: "2026-06-19T10:01:30.000Z".into(),
                started_at: Some("2026-06-19T10:01:29.000Z".into()),
                completed_at: Some("2026-06-19T10:01:30.000Z".into()),
                status: Some("succeeded".into()),
                input_summary: Some(serde_json::json!({ "target": "github" })),
                output_summary: Some(serde_json::json!({ "decision": "needs_grant" })),
                error_details: None,
            })
            .unwrap();
        let context = TestServerContext::new(repository, true);

        let events = handle_command(
            &context,
            "list_capability_audit_events",
            json!({ "runId": "run-1" }),
        )
        .unwrap();

        assert_eq!(events.as_array().unwrap().len(), 1);
        assert_eq!(events[0]["run_id"], "run-1");
        assert_eq!(events[0]["capability_id"], "github.issue.comment");
        assert_eq!(events[0]["grant_id"], "grant-1");
        assert_eq!(events[0]["status"], "succeeded");
        assert_eq!(events[0]["started_at"], "2026-06-19T10:01:29.000Z");
        assert_eq!(events[0]["completed_at"], "2026-06-19T10:01:30.000Z");
        assert_eq!(events[0]["input_summary"]["target"], "github");
        assert_eq!(events[0]["output_summary"]["decision"], "needs_grant");
    }

    #[test]
    fn test_server_routes_bridge_commands_without_unknown_command_fallback() {
        let bridge = std::fs::read_to_string("../src/app/tauriBridge.ts").unwrap();
        let bridge_commands = bridge
            .split("invokeBackend(\"")
            .skip(1)
            .filter_map(|part| part.split('"').next())
            .collect::<std::collections::BTreeSet<_>>();
        let routed_commands = ROUTED_COMMANDS
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        let missing = bridge_commands
            .difference(&routed_commands)
            .copied()
            .collect::<Vec<_>>();

        assert!(
            missing.is_empty(),
            "test backend is missing bridge routes: {missing:?}"
        );
    }

    #[test]
    fn test_server_routes_usage_pricing_catalog() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let catalog = handle_command(&context, "usage_pricing_catalog", json!({})).unwrap();

        assert_eq!(catalog["source"], "bundled");
        assert!(catalog["version"]
            .as_str()
            .unwrap()
            .starts_with("usage-pricing-"));
        assert!(catalog["loaded_at"].as_str().unwrap().contains('T'));
        assert!(catalog["fetched_at"].as_str().unwrap().contains('T'));
        assert!(catalog["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["model"] == "gpt-4.1"
                && entry["context_window_tokens"].as_i64().unwrap() > 200_000));
    }

    #[test]
    fn test_server_routes_provider_configuration_and_scans() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let chat_dir = dir.path().join("chat");
        std::fs::create_dir_all(&chat_dir).unwrap();
        std::fs::write(
            chat_dir.join("session.md"),
            "# Session\n\nDiscussed provider setup.",
        )
        .unwrap();
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        handle_command(
            &context,
            "configure_ai_chat_import_folder",
            json!({ "folderPath": chat_dir.to_string_lossy() }),
        )
        .unwrap();
        let scan = handle_command(&context, "scan_ai_chat_import_folder", json!({})).unwrap();

        assert!(scan["summary"].as_str().unwrap().contains("Session"));
        assert!(scan["source_refs"].as_array().unwrap().len() == 1);

        handle_command(
            &context,
            "configure_github_context",
            json!({ "repoSlug": "example-user/example-repo" }),
        )
        .unwrap();
        let github_scan = handle_command(&context, "scan_github_context", json!({})).unwrap();
        assert!(github_scan["summary"]
            .as_str()
            .unwrap()
            .contains("needs a configured token"));
    }

    #[test]
    fn test_server_deterministic_run_exports_configured_destination() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let export_dir = dir.path().join("exports");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);
        let mut definition = crate::workflow::deterministic_weather_workflow();
        definition.id = "export-weather".into();
        definition.name = "Export Weather".into();
        definition.defaults.destination_ref = "markdown_folder".into();

        handle_command(
            &context,
            "configure_artifact_destination",
            json!({
                "destinationId": "markdown_folder",
                "folderPath": export_dir.to_string_lossy()
            }),
        )
        .unwrap();
        handle_command(
            &context,
            "install_workflow_template",
            json!({
                "definition": definition,
                "status": "enabled",
                "approvalMode": "auto_approve"
            }),
        )
        .unwrap();
        handle_command(
            &context,
            "run_workflow",
            json!({ "workflowId": "export-weather" }),
        )
        .unwrap();

        let exported = dir
            .path()
            .join("exports")
            .join("export-weather-test-artifact.md");
        assert!(exported.exists());
        assert!(std::fs::read_to_string(exported)
            .unwrap()
            .contains("# Export Weather"));
    }

    #[test]
    fn test_server_unknown_command_returns_error() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("raven.sqlite3");
        let repository = Repository::open(&db_path).unwrap();
        let context = TestServerContext::new(repository, true);

        let error = handle_command(&context, "missing_command", json!({})).unwrap_err();

        assert!(error.contains("Unknown command"));
    }
}
