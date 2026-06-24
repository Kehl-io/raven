mod agent_auth;
pub mod agent_task;
mod approval;
pub mod approval_grants;
pub mod autonomy;
mod builder_agent;
pub mod capabilities;
pub mod capability_registry;
mod content_tools;
mod csv_prompt;
mod db;
pub mod execution;
pub mod http_probe;
mod llm;
mod llm_provider;
pub mod local_tools;
mod models;
pub mod news;
pub mod planner;
mod plugins;
pub mod preflight;
mod providers;
mod runtime;
mod scheduler;
mod seo_tools;
pub mod services;
mod stream;
pub mod test_server;
pub mod tool_discovery;
mod tray;
pub mod weather;
pub mod web_tools;
mod workflow;

pub use agent_auth::{AgentAuthProfile, AgentCommandPlan};
pub use builder_agent::{BuilderDraftEvent, BuilderDraftEventSink};
pub use db::Repository;
pub use llm_provider::OllamaModel;
pub use models::{
    AppState, ApprovalDecision, CapabilityAdapter, CapabilityAvailability,
    CapabilityDefaultApproval, CapabilityDescriptor, CapabilitySource, CapabilityTrustTier,
    PendingApproval, ProviderAccount, ProviderHealth, RavenWorkflow, RawToolAnnotations,
    RawToolAuthStatus, RawToolInventoryItem, RawToolOperation, RawToolStatus,
    SystemHealthDiagnostics, UsagePricingCatalog, WorkflowDraft, WorkflowDraftRevisionContext,
    WorkflowRunResult, WorkflowStatus, WorkflowVersion,
};
pub use plugins::PluginManifest;
pub use providers::ContextPack;
pub use scheduler::{SchedulerService, SchedulerStatus};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[tauri::command]
fn get_app_state(repository: tauri::State<Mutex<Repository>>) -> Result<AppState, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::get_app_state(&repository)
}

#[tauri::command]
fn get_workflow_step_runs(
    repository: tauri::State<Mutex<Repository>>,
    run_id: String,
) -> Result<Vec<models::WorkflowStepRun>, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::get_workflow_step_runs(&repository, &run_id)
}

#[tauri::command]
fn analyze_usage_history(
    repository: tauri::State<Mutex<Repository>>,
    period: String,
    multiplier: f64,
) -> Result<models::UsageCostAnomaly, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::analyze_usage_history(&repository, &period, multiplier)
}

#[tauri::command]
fn usage_pricing_catalog() -> Result<models::UsagePricingCatalog, String> {
    services::usage_pricing_catalog()
}

#[tauri::command]
fn detect_tools() -> Vec<models::RawToolInventoryItem> {
    services::detect_tools()
}

#[tauri::command]
fn available_capability_catalog(
    autonomy_mode: autonomy::AutonomyMode,
    category_overrides: Option<autonomy::CategoryAutonomyOverrides>,
) -> capability_registry::CapabilityRegistrySnapshot {
    services::available_capability_catalog_with_category_overrides(
        autonomy_mode,
        &category_overrides.unwrap_or_default(),
    )
}

#[tauri::command]
fn evaluate_workflow_preflight(
    repository: tauri::State<Mutex<Repository>>,
    workflow_id: String,
    version: i64,
    autonomy_mode: Option<autonomy::AutonomyMode>,
    category_overrides: Option<autonomy::CategoryAutonomyOverrides>,
) -> Result<models::PreflightManifest, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::evaluate_workflow_preflight_with_category_overrides(
        &repository,
        &workflow_id,
        version,
        autonomy_mode.unwrap_or(autonomy::AutonomyMode::SafeAuto),
        &category_overrides.unwrap_or_default(),
    )
}

#[tauri::command]
fn evaluate_workflow_definition_preflight(
    repository: tauri::State<Mutex<Repository>>,
    definition: models::RavenWorkflow,
    version: i64,
    autonomy_mode: Option<autonomy::AutonomyMode>,
    category_overrides: Option<autonomy::CategoryAutonomyOverrides>,
) -> Result<models::PreflightManifest, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::evaluate_workflow_definition_preflight_with_category_overrides(
        &repository,
        &definition,
        version,
        autonomy_mode.unwrap_or(autonomy::AutonomyMode::SafeAuto),
        &category_overrides.unwrap_or_default(),
    )
}

#[tauri::command]
fn create_approval_grant(
    repository: tauri::State<Mutex<Repository>>,
    grant: models::ApprovalGrant,
) -> Result<models::ApprovalGrant, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::create_approval_grant(&repository, grant)
}

#[tauri::command]
fn approve_workflow_signature_baseline(
    repository: tauri::State<Mutex<Repository>>,
    workflow_id: String,
    workflow_version: i64,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::approve_workflow_signature_baseline(&repository, &workflow_id, workflow_version)
}

#[tauri::command]
fn revoke_approval_grant(
    repository: tauri::State<Mutex<Repository>>,
    id: String,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::revoke_approval_grant(&repository, &id)
}

#[tauri::command]
fn list_approval_grants(
    repository: tauri::State<Mutex<Repository>>,
    workflow_id: Option<String>,
) -> Result<Vec<models::ApprovalGrant>, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::list_approval_grants(&repository, workflow_id.as_deref())
}

#[tauri::command]
fn list_capability_audit_events(
    repository: tauri::State<Mutex<Repository>>,
    run_id: String,
) -> Result<Vec<models::CapabilityAuditEvent>, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::list_capability_audit_events(&repository, &run_id)
}

#[tauri::command]
fn assign_schedule_override(
    repository: tauri::State<Mutex<Repository>>,
    workflow_id: String,
    original_run_at: String,
    scheduled_run_at: String,
) -> Result<models::WorkflowScheduleOverride, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::assign_schedule_override(
        &repository,
        &workflow_id,
        &original_run_at,
        &scheduled_run_at,
    )
}

#[tauri::command]
fn provider_health() -> Vec<ProviderHealth> {
    services::provider_health()
}

#[tauri::command]
fn system_health_diagnostics(
    repository: tauri::State<Mutex<Repository>>,
    scheduler: tauri::State<Mutex<scheduler::SchedulerService>>,
) -> Result<SystemHealthDiagnostics, String> {
    let scheduler_status = {
        let scheduler = scheduler.lock().map_err(|error| error.to_string())?;
        services::scheduler_status(&scheduler)
    };
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::system_health_diagnostics(&repository, scheduler_status)
}

#[tauri::command]
fn agent_auth_profiles() -> Vec<agent_auth::AgentAuthProfile> {
    services::agent_auth_profiles()
}

#[tauri::command]
fn agent_command_plan(
    profile_id: String,
    prompt: String,
) -> Result<agent_auth::AgentCommandPlan, String> {
    services::agent_command_plan(&profile_id, &prompt)
}

#[tauri::command]
fn configure_provider_account(
    repository: tauri::State<Mutex<Repository>>,
    account: ProviderAccount,
    raw_secret: Option<String>,
) -> Result<ProviderAccount, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::configure_provider_account(&mut repository, account, raw_secret.as_deref())
}

#[tauri::command]
fn configure_artifact_destination(
    repository: tauri::State<Mutex<Repository>>,
    destination_id: String,
    folder_path: String,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::configure_artifact_destination(&repository, &destination_id, folder_path)
}

#[tauri::command]
fn configure_ai_chat_import_folder(
    repository: tauri::State<Mutex<Repository>>,
    folder_path: String,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::configure_ai_chat_import_folder(&repository, folder_path)
}

#[tauri::command]
fn scan_ai_chat_import_folder(
    repository: tauri::State<Mutex<Repository>>,
) -> Result<providers::ContextPack, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::scan_ai_chat_import_folder(&repository)
}

#[tauri::command]
fn configure_document_import_folder(
    repository: tauri::State<Mutex<Repository>>,
    folder_path: String,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::configure_document_import_folder(&repository, folder_path)
}

#[tauri::command]
fn scan_document_import_folder(
    repository: tauri::State<Mutex<Repository>>,
) -> Result<providers::ContextPack, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::scan_document_import_folder(&repository)
}

#[tauri::command]
fn configure_github_context(
    repository: tauri::State<Mutex<Repository>>,
    repo_slug: String,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::configure_github_context(&repository, &repo_slug)
}

#[tauri::command]
fn scan_github_context(
    repository: tauri::State<Mutex<Repository>>,
) -> Result<providers::ContextPack, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::scan_github_context(&repository)
}

#[tauri::command]
fn get_saved_settings(
    repository: tauri::State<Mutex<Repository>>,
) -> Result<serde_json::Value, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::get_saved_settings(&repository)
}

#[tauri::command]
fn detect_nestweaver() -> Result<Option<services::NestWeaverDetection>, String> {
    services::detect_nestweaver()
}

#[tauri::command]
fn configure_nestweaver(
    repository: tauri::State<Mutex<Repository>>,
    binary_path: String,
    db_path: Option<String>,
    project: Option<String>,
    token_budget: usize,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::configure_nestweaver(
        &repository,
        &binary_path,
        db_path.as_deref(),
        project.as_deref(),
        token_budget,
    )
}

#[tauri::command]
fn index_nestweaver_project(
    repository: tauri::State<Mutex<Repository>>,
) -> Result<providers::ContextPack, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    let current_dir = std::env::current_dir().unwrap_or_else(|_| ".".into());
    services::index_nestweaver_project(&repository, &current_dir)
}

#[tauri::command]
fn check_provider_readiness(
    repository: tauri::State<Mutex<Repository>>,
) -> Result<Vec<ProviderHealth>, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::check_provider_readiness(&repository)
}

#[tauri::command]
fn set_builder_profile(
    repository: tauri::State<Mutex<Repository>>,
    profile_id: String,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::set_builder_profile(&repository, profile_id)
}

#[tauri::command]
fn set_autonomy_mode(
    repository: tauri::State<Mutex<Repository>>,
    autonomy_mode: autonomy::AutonomyMode,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::set_autonomy_mode(&repository, autonomy_mode)
}

#[tauri::command]
fn set_autonomy_category_overrides(
    repository: tauri::State<Mutex<Repository>>,
    category_overrides: autonomy::CategoryAutonomyOverrides,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::set_autonomy_category_overrides(&repository, category_overrides)
}

#[tauri::command(async)]
fn create_workflow_draft(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, Mutex<Repository>>,
    prompt: String,
    builder_profile_id: Option<String>,
    request_id: Option<String>,
    previous_draft: Option<WorkflowDraftRevisionContext>,
) -> Result<WorkflowDraft, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    let event_sink = TauriBuilderDraftEventSink { app_handle };
    services::create_workflow_draft(
        &repository,
        &prompt,
        builder_profile_id.as_deref(),
        request_id,
        previous_draft.as_ref(),
        &event_sink,
    )
}

#[tauri::command]
fn approve_workflow_draft(
    repository: tauri::State<Mutex<Repository>>,
    draft: WorkflowDraft,
) -> Result<WorkflowVersion, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::approve_workflow_draft(&mut repository, &draft)
}

#[tauri::command]
fn install_workflow_template(
    repository: tauri::State<Mutex<Repository>>,
    definition: RavenWorkflow,
    status: WorkflowStatus,
    approval_mode: Option<String>,
    planner_rationale: Option<crate::planner::operations::OperationPlan>,
) -> Result<WorkflowVersion, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::install_workflow_template(
        &mut repository,
        definition,
        status,
        approval_mode.as_deref(),
        planner_rationale,
    )
}

#[tauri::command]
fn create_workflow_version(
    repository: tauri::State<Mutex<Repository>>,
    definition: RavenWorkflow,
    status: WorkflowStatus,
    approval_mode: Option<String>,
    planner_rationale: Option<crate::planner::operations::OperationPlan>,
) -> Result<WorkflowVersion, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::create_workflow_version(
        &mut repository,
        definition,
        status,
        approval_mode.as_deref(),
        planner_rationale,
    )
}

#[tauri::command]
fn archive_workflow(
    repository: tauri::State<Mutex<Repository>>,
    workflow_id: String,
) -> Result<WorkflowVersion, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::archive_workflow(&mut repository, &workflow_id)
}

#[tauri::command]
fn update_workflow_safe_fields(
    repository: tauri::State<Mutex<Repository>>,
    workflow_id: String,
    status: WorkflowStatus,
    cadence: String,
    local_time: Option<String>,
    approval_mode: Option<String>,
    llm_profile_ref: Option<String>,
) -> Result<WorkflowVersion, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::update_workflow_safe_fields(
        &mut repository,
        &workflow_id,
        status,
        &cadence,
        local_time.as_deref(),
        approval_mode.as_deref(),
        llm_profile_ref.as_deref(),
    )
}

#[tauri::command(async)]
fn run_workflow(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, Mutex<Repository>>,
    workflow_id: String,
) -> Result<WorkflowRunResult, String> {
    drop(repository.lock().map_err(|error| error.to_string())?);
    let _ = app_handle.emit(
        "workflow:started",
        serde_json::json!({
            "workflow_id": &workflow_id,
        }),
    );
    let mut repository =
        Repository::open(default_db_path(&app_handle)).map_err(|error| error.to_string())?;
    let result = services::run_workflow(&mut repository, &workflow_id)?;
    let event_name = match result.run.status {
        models::RunStatus::Succeeded => "workflow:completed",
        models::RunStatus::Failed => "workflow:errored",
        _ => "workflow:completed",
    };
    let _ = app_handle.emit(
        event_name,
        serde_json::json!({
            "workflow_id": result.run.workflow_id,
            "workflow_name": &result.run.workflow_name,
            "status": format!("{:?}", result.run.status),
        }),
    );
    Ok(result)
}

#[tauri::command]
fn run_scheduled_due_workflows(
    repository: tauri::State<Mutex<Repository>>,
    schedule_window: String,
    workflow_ids: Option<Vec<String>>,
) -> Result<Vec<WorkflowRunResult>, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::run_scheduled_due_workflows_for_ids(
        &mut repository,
        &schedule_window,
        workflow_ids.as_deref(),
    )
}

#[tauri::command]
fn start_scheduler(
    repository: tauri::State<Mutex<Repository>>,
    scheduler: tauri::State<Mutex<scheduler::SchedulerService>>,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::set_scheduler_enabled(&repository, true)?;
    drop(repository);
    let mut scheduler = scheduler.lock().map_err(|error| error.to_string())?;
    services::start_scheduler(&mut scheduler)
}

#[tauri::command]
fn stop_scheduler(
    repository: tauri::State<Mutex<Repository>>,
    scheduler: tauri::State<Mutex<scheduler::SchedulerService>>,
) -> Result<(), String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::set_scheduler_enabled(&repository, false)?;
    drop(repository);
    let mut scheduler = scheduler.lock().map_err(|error| error.to_string())?;
    services::stop_scheduler(&mut scheduler)
}

#[tauri::command]
fn scheduler_status(
    scheduler: tauri::State<Mutex<scheduler::SchedulerService>>,
) -> Result<scheduler::SchedulerStatus, String> {
    let scheduler = scheduler.lock().map_err(|error| error.to_string())?;
    Ok(services::scheduler_status(&scheduler))
}

#[tauri::command]
fn run_scheduler_tick(
    repository: tauri::State<Mutex<Repository>>,
) -> Result<Vec<WorkflowRunResult>, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::run_scheduler_tick(&mut repository)
}

#[tauri::command]
fn generate_artifact_preview(
    repository: tauri::State<Mutex<Repository>>,
    workflow_id: String,
) -> Result<String, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::generate_artifact_preview(&repository, &workflow_id)
}

#[tauri::command]
fn retry_workflow_run(
    repository: tauri::State<Mutex<Repository>>,
    run_id: String,
) -> Result<WorkflowRunResult, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::retry_workflow_run(&mut repository, &run_id)
}

#[tauri::command]
fn export_artifact(
    repository: tauri::State<Mutex<Repository>>,
    artifact_id: String,
    destination_path: Option<String>,
    destination_id: Option<String>,
) -> Result<String, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::export_artifact(&repository, &artifact_id, destination_path, destination_id)
}

#[tauri::command]
fn regenerate_artifact(
    repository: tauri::State<Mutex<Repository>>,
    artifact_id: String,
) -> Result<WorkflowRunResult, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::regenerate_artifact(&mut repository, &artifact_id)
}

#[tauri::command]
fn app_version() -> String {
    services::app_version()
}

#[tauri::command(async)]
fn ollama_status() -> Result<String, String> {
    services::ollama_status()
}

#[tauri::command(async)]
fn ollama_models() -> Result<Vec<llm_provider::OllamaModel>, String> {
    services::ollama_models()
}

#[tauri::command]
fn list_plugins() -> Vec<plugins::PluginManifest> {
    services::list_plugins()
}

#[tauri::command]
fn get_dock_visibility(
    repository: tauri::State<'_, Mutex<db::Repository>>,
) -> Result<bool, String> {
    repository
        .lock()
        .map_err(|e| e.to_string())?
        .dock_visible()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_dock_visibility(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, Mutex<db::Repository>>,
    visible: bool,
) -> Result<(), String> {
    repository
        .lock()
        .map_err(|e| e.to_string())?
        .set_dock_visible(visible)
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        if visible {
            let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Regular);
        } else {
            let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = &app_handle;

    Ok(())
}

#[tauri::command]
fn complete_onboarding(repository: tauri::State<'_, Mutex<db::Repository>>) -> Result<(), String> {
    repository
        .lock()
        .map_err(|e| e.to_string())?
        .set_onboarding_completed()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_onboarding_completed(
    repository: tauri::State<'_, Mutex<db::Repository>>,
) -> Result<bool, String> {
    repository
        .lock()
        .map_err(|e| e.to_string())?
        .onboarding_completed()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_global_shortcut(
    repository: tauri::State<'_, Mutex<db::Repository>>,
) -> Result<String, String> {
    repository
        .lock()
        .map_err(|e| e.to_string())?
        .global_shortcut()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_global_shortcut(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, Mutex<db::Repository>>,
    shortcut: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let global_shortcut = app_handle.global_shortcut();

    // Register the new shortcut first — if it fails (invalid string), the old one survives
    let handle = app_handle.clone();
    global_shortcut
        .on_shortcut(shortcut.as_str(), move |_app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                tray::show_or_create_main_window(&handle);
            }
        })
        .map_err(|e| e.to_string())?;

    repository
        .lock()
        .map_err(|e| e.to_string())?
        .set_global_shortcut(&shortcut)
        .map_err(|e| e.to_string())?;

    Ok(())
}

struct TauriBuilderDraftEventSink {
    app_handle: tauri::AppHandle,
}

impl builder_agent::BuilderDraftEventSink for TauriBuilderDraftEventSink {
    fn emit(&self, event: builder_agent::BuilderDraftEvent) {
        let _ = self.app_handle.emit("raven://builder-draft-event", event);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let app_data_dir = default_app_data_dir(app.handle());
            plugins::set_app_data_plugins_dir(app_data_dir.clone());
            let db_path = resolve_db_path(
                std::env::var("RAVEN_DB_PATH").ok().map(PathBuf::from),
                &app_data_dir,
            );
            let repository = Repository::open(&db_path).expect("failed to open Raven database");
            let scheduler_enabled = repository
                .setting_json("scheduler_enabled")
                .ok()
                .flatten()
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let mut scheduler_service = scheduler::SchedulerService::new(db_path);
            scheduler_service.set_app_handle(app.handle().clone());
            if scheduler_enabled {
                if let Err(err) = scheduler_service.start() {
                    eprintln!("[raven] failed to start scheduler: {err}");
                }
            }

            app.manage(Mutex::new(repository));
            app.manage(Mutex::new(scheduler_service));

            tray::setup(app)?;

            #[cfg(target_os = "macos")]
            {
                let repo = app.state::<Mutex<db::Repository>>();
                let dock_visible = repo
                    .lock()
                    .map_err(|e| e.to_string())?
                    .dock_visible()
                    .unwrap_or(false);
                if !dock_visible {
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }

            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let shortcut_str = {
                    let repo = app.state::<Mutex<db::Repository>>();
                    let guard = repo.lock().map_err(|e| e.to_string())?;
                    guard
                        .global_shortcut()
                        .unwrap_or_else(|_| "CmdOrCtrl+Shift+R".to_string())
                };
                let app_handle = app.handle().clone();
                let _ = app.global_shortcut().on_shortcut(
                    shortcut_str.as_str(),
                    move |_app, _shortcut, event| {
                        if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                            tray::show_or_create_main_window(&app_handle);
                        }
                    },
                );
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let is_background_mode = {
                    let repo = app.state::<Mutex<db::Repository>>();
                    let Ok(repo) = repo.lock() else { return };
                    !repo.dock_visible().unwrap_or(false)
                };
                if is_background_mode {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            get_workflow_step_runs,
            analyze_usage_history,
            usage_pricing_catalog,
            detect_tools,
            available_capability_catalog,
            evaluate_workflow_preflight,
            evaluate_workflow_definition_preflight,
            create_approval_grant,
            approve_workflow_signature_baseline,
            revoke_approval_grant,
            list_approval_grants,
            list_capability_audit_events,
            assign_schedule_override,
            provider_health,
            system_health_diagnostics,
            agent_auth_profiles,
            agent_command_plan,
            configure_provider_account,
            configure_artifact_destination,
            configure_ai_chat_import_folder,
            scan_ai_chat_import_folder,
            configure_document_import_folder,
            scan_document_import_folder,
            configure_github_context,
            scan_github_context,
            get_saved_settings,
            detect_nestweaver,
            configure_nestweaver,
            index_nestweaver_project,
            check_provider_readiness,
            set_builder_profile,
            set_autonomy_mode,
            set_autonomy_category_overrides,
            create_workflow_draft,
            approve_workflow_draft,
            install_workflow_template,
            create_workflow_version,
            archive_workflow,
            update_workflow_safe_fields,
            run_workflow,
            run_scheduled_due_workflows,
            start_scheduler,
            stop_scheduler,
            scheduler_status,
            run_scheduler_tick,
            generate_artifact_preview,
            retry_workflow_run,
            export_artifact,
            regenerate_artifact,
            stream::run_workflow_streamed,
            approval::list_pending_approvals,
            approval::list_approval_history,
            approval::resolve_approval,
            ollama_status,
            ollama_models,
            app_version,
            list_plugins,
            get_dock_visibility,
            set_dock_visibility,
            complete_onboarding,
            get_onboarding_completed,
            get_global_shortcut,
            set_global_shortcut,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Raven application");
}

pub(crate) fn default_db_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let app_data_dir = default_app_data_dir(app_handle);
    resolve_db_path(
        std::env::var("RAVEN_DB_PATH").ok().map(PathBuf::from),
        &app_data_dir,
    )
}

fn default_app_data_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle.path().app_data_dir().unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".raven")
    })
}

fn resolve_db_path(env_override: Option<PathBuf>, app_data_dir: &Path) -> PathBuf {
    env_override.unwrap_or_else(|| app_data_dir.join("raven.sqlite3"))
}

#[cfg(test)]
mod hardening_tests {
    use super::*;

    #[test]
    fn default_db_path_uses_app_data_when_no_env_override_is_set() {
        let app_data_dir = PathBuf::from("/tmp/raven-app-data");

        assert_eq!(
            resolve_db_path(None, &app_data_dir),
            app_data_dir.join("raven.sqlite3")
        );
    }

    #[test]
    fn default_db_path_keeps_test_env_override() {
        let override_path = PathBuf::from("/tmp/raven-test.sqlite3");

        assert_eq!(
            resolve_db_path(
                Some(override_path.clone()),
                &PathBuf::from("/tmp/raven-app-data")
            ),
            override_path
        );
    }
}
