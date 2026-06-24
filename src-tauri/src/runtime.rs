use crate::agent_auth;
use crate::agent_task::{self, AgentTaskError, AgentTaskExecutor, AgentTaskRequest};
use crate::autonomy::{AutonomyMode, PolicyDecisionKind};
use crate::db::{DbError, Repository};
use crate::llm::{
    AnthropicMessagesArtifactGenerator, ArtifactGenerationRequest, LlmArtifactGenerator, LlmError,
    LocalPreviewArtifactGenerator, OpenAiResponsesArtifactGenerator,
};
use crate::models::{
    AgentEvent, AgentTaskEnvelope, AgentToolEvent, AgentToolEventStatus, ApprovalGrant,
    ApprovalGrantStatus, ApprovalGrantType, Artifact, CapabilityAdapter, CapabilityAuditEvent,
    CapabilityAvailability, CapabilityDefaultApproval, CapabilityDescriptor, CapabilitySource,
    CapabilityTrustTier, PendingApproval, RavenWorkflow, RunStatus, ToolTraceEntry, WorkflowRun,
    WorkflowRunResult, WorkflowStatus, WorkflowStepDefinition, WorkflowStepRun, WorkflowVersion,
};
use crate::providers::{OpenMeteoWeatherProvider, WeatherProvider, WeatherSnapshot};
use crate::stream::{NoopRuntimeEventSink, RuntimeEventSink};
use chrono::{Datelike, NaiveDateTime, SecondsFormat, Utc};
use serde_json::Value;
use std::collections::{hash_map::DefaultHasher, BTreeMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(unix)]
extern "C" {
    fn setsid() -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunTrigger {
    Manual,
    #[allow(dead_code)]
    ScheduleWindow(String),
    ApprovedResume(String),
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("database error: {0}")]
    Db(#[from] DbError),
    #[error("workflow {0} was not found")]
    MissingWorkflow(String),
    #[error("workflow {0} does not contain an agent_task step")]
    MissingAgentTask(String),
    #[error("run {0} was not found")]
    MissingRun(String),
    #[error("artifact {0} was not found")]
    MissingArtifact(String),
    #[error("workflow {workflow_id} is {status} and cannot be run")]
    NonEnabledWorkflow { workflow_id: String, status: String },
    #[error("approval payload is invalid: {0}")]
    InvalidApprovalPayload(String),
}

fn ensure_workflow_enabled(version: &WorkflowVersion) -> Result<(), RuntimeError> {
    if version.status == WorkflowStatus::Enabled {
        return Ok(());
    }

    Err(RuntimeError::NonEnabledWorkflow {
        workflow_id: version.workflow_id.clone(),
        status: format!("{:?}", version.status).to_lowercase(),
    })
}

pub fn run_workflow(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
) -> Result<WorkflowRunResult, RuntimeError> {
    run_workflow_with_event_sink(repository, workflow_id, trigger, &NoopRuntimeEventSink)
}

pub fn run_workflow_with_event_sink(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let version = repository
        .latest_workflow_version(workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(workflow_id.into()))?;
    ensure_workflow_enabled(&version)?;
    if version
        .definition
        .steps
        .iter()
        .any(|step| step.kind == crate::models::WorkflowStepKind::AgentTask)
    {
        let credential_resolver = RuntimeAgentTaskCredentialResolver::from_repository(repository)?;
        let client = agent_task::UreqNativeAgentTaskClient;
        let executor = agent_task::NativeAgentTaskExecutor::new(&credential_resolver, &client);
        return run_workflow_with_agent_executor_and_event_sink(
            repository,
            workflow_id,
            trigger,
            &executor,
            sink,
        );
    }
    let registry = runtime_registry_snapshot();
    let plugins = crate::plugins::discover_plugins();
    if let Some(step) =
        unregistered_provider_action_step(&version.definition, &registry, &plugins).cloned()
    {
        return run_unregistered_capability_blocked_workflow(
            repository,
            workflow_id,
            trigger,
            &version,
            &step,
            sink,
        );
    }
    if workflow_has_plugin_step(&version.definition, &plugins, &registry) {
        return run_workflow_with_plugins_and_event_sink(
            repository,
            workflow_id,
            trigger,
            &plugins,
            sink,
        );
    }
    if workflow_has_deterministic_provider_runtime(&version.definition.steps, &registry) {
        return run_deterministic_provider_workflow_with_event_sink(
            repository,
            workflow_id,
            trigger,
            sink,
        );
    }
    match live_artifact_backend(repository, &version.definition.defaults.llm_profile_ref)? {
        Ok(backend) => run_workflow_with_generator_and_profile_and_event_sink(
            repository,
            workflow_id,
            trigger,
            &backend.generator,
            &backend.provider_id,
            &backend.model,
            &backend.effort,
            sink,
        ),
        Err(blocked) => run_blocked_workflow(repository, workflow_id, trigger, blocked),
    }
}

#[cfg(test)]
pub fn run_current_weather_workflow_with_provider(
    repository: &mut Repository,
    trigger: RunTrigger,
    provider: &dyn WeatherProvider,
) -> Result<WorkflowRunResult, RuntimeError> {
    let workflow_id = "current-weather";
    let version = repository
        .latest_workflow_version(workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(workflow_id.into()))?;
    ensure_workflow_enabled(&version)?;

    let trigger_kind = match &trigger {
        RunTrigger::Manual => "manual".to_string(),
        RunTrigger::ScheduleWindow(_) => "schedule".to_string(),
        RunTrigger::ApprovedResume(_) => "resume".to_string(),
    };
    let idempotency_key = match trigger {
        RunTrigger::Manual => format!("manual:{workflow_id}:{}", Uuid::new_v4()),
        RunTrigger::ScheduleWindow(window) => format!("schedule:{workflow_id}:{window}"),
        RunTrigger::ApprovedResume(run_id) => format!("resume:{run_id}"),
    };

    if let Some(existing_run) = repository.find_run_by_idempotency_key(&idempotency_key)? {
        return Ok(WorkflowRunResult {
            artifact: repository.artifact_for_run(&existing_run.id)?,
            run: existing_run,
            duplicate: true,
        });
    }

    let started_at = timestamp();
    let run = WorkflowRun {
        id: format!("run-{}", Uuid::new_v4()),
        workflow_id: workflow_id.into(),
        workflow_name: version.definition.name.clone(),
        status: RunStatus::Running,
        started_at: started_at.clone(),
        completed_at: None,
        failure_reason: None,
        idempotency_key,
        trigger_kind,
        retry_count: 0,
        parent_run_id: None,
        error_classification: None,
        provider_profile_id: Some("open-meteo".into()),
        blocked_reason: None,
        required_provider_id: None,
        required_profile_id: None,
        setup_action: None,
        total_tokens: None,
        input_tokens: None,
        output_tokens: None,
        total_cost_usd: None,
    };
    let step_runs = version
        .definition
        .steps
        .iter()
        .map(|step| WorkflowStepRun {
            id: format!("step-run-{}", Uuid::new_v4()),
            workflow_run_id: run.id.clone(),
            step_id: step.id.clone(),
            status: RunStatus::Running,
            output_json: None,
            error: None,
            started_at: started_at.clone(),
            completed_at: None,
        })
        .collect::<Vec<_>>();
    repository.create_run_with_steps(&run, &step_runs)?;

    if let Some(result) =
        maybe_pause_for_approval(repository, &version, &run, &step_runs, "weather")?
    {
        return Ok(result);
    }

    continue_current_weather_run(repository, &version, run, step_runs, provider)
}

fn continue_current_weather_run(
    repository: &mut Repository,
    version: &WorkflowVersion,
    run: WorkflowRun,
    step_runs: Vec<WorkflowStepRun>,
    provider: &dyn WeatherProvider,
) -> Result<WorkflowRunResult, RuntimeError> {
    if let Some(artifact) = repository.artifact_for_run(&run.id)? {
        return Ok(WorkflowRunResult {
            run,
            artifact: Some(artifact),
            duplicate: true,
        });
    }

    let weather_step = weather_provider_policy_step(&version.definition.steps);
    let weather_inputs =
        resolve_step_input_references(&weather_step.inputs, &step_outputs(repository, &run.id)?);
    match enforce_provider_step_policy(
        repository,
        version,
        &run,
        &weather_step,
        &weather_inputs,
        &runtime_registry_snapshot(),
    )? {
        RuntimeCapabilityPolicyCheck::Allowed => {}
        RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
            return block_deterministic_provider_runtime(
                repository,
                run,
                &step_runs,
                blocked,
                &NoopRuntimeEventSink,
            );
        }
    }

    let snapshot = match provider.current_weather() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            if let Some(step) = step_runs
                .iter()
                .find(|step| step.step_id == "fetch-weather")
            {
                repository.fail_step(&step.id, RunStatus::Retryable, &error.to_string())?;
            }
            repository.finish_run_with_classification(
                &run.id,
                RunStatus::Retryable,
                Some(&error.to_string()),
                Some("retryable"),
            )?;
            return Ok(WorkflowRunResult {
                run: WorkflowRun {
                    status: RunStatus::Retryable,
                    completed_at: Some(timestamp()),
                    failure_reason: Some(error.to_string()),
                    error_classification: Some("retryable".into()),
                    ..run
                },
                artifact: None,
                duplicate: false,
            });
        }
    };

    if let Some(step) = step_runs
        .iter()
        .find(|step| step.step_id == "fetch-weather")
    {
        repository.finish_step(
            &step.id,
            serde_json::to_value(&snapshot).unwrap_or_default(),
        )?;
    }

    let artifact_id = format!("artifact-{}", Uuid::new_v4());
    let (content_path, metadata_path) = repository.artifact_paths(&artifact_id);
    let artifact = Artifact {
        id: artifact_id,
        title: "Current Weather".into(),
        artifact_type: "weather_report".into(),
        workflow_run_id: run.id.clone(),
        content_path,
        metadata_path,
        content_markdown: weather_markdown(&snapshot),
        metadata: merge_artifact_metadata(
            serde_json::json!({
                "provider": "open-meteo",
                "location": snapshot.location.clone(),
                "observed_at": snapshot.observed_at.clone(),
                "weather_code": snapshot.weather_code,
                "condition": snapshot.condition.clone(),
            }),
            &version.workflow_id,
            version.version,
            &version.definition.defaults.destination_ref,
        ),
        source_refs: snapshot.source_refs,
        created_at: timestamp(),
    };
    let artifact_write_step =
        artifact_persistence_policy_step(&version.definition.steps, "fetch-weather");
    let artifact_write_inputs = add_artifact_write_paths_to_inputs(
        resolve_step_input_references(
            &artifact_write_step.inputs,
            &step_outputs(repository, &run.id)?,
        ),
        &artifact.content_path,
        &artifact.metadata_path,
    );
    match enforce_provider_step_policy(
        repository,
        version,
        &run,
        &artifact_write_step,
        &artifact_write_inputs,
        &runtime_registry_snapshot(),
    )? {
        RuntimeCapabilityPolicyCheck::Allowed => {}
        RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
            return block_deterministic_provider_runtime(
                repository,
                run,
                &step_runs,
                blocked,
                &NoopRuntimeEventSink,
            );
        }
    }
    repository.write_artifact(&artifact)?;
    auto_export_to_destination(
        repository,
        &artifact.id,
        &version.definition.defaults.destination_ref,
    );

    if let Some(step) = step_runs
        .iter()
        .find(|step| step.step_id == "write-artifact")
    {
        repository.finish_step(
            &step.id,
            serde_json::json!({
                "content_path": artifact.content_path,
                "metadata_path": artifact.metadata_path
            }),
        )?;
    }
    repository.finish_run(&run.id, RunStatus::Succeeded, None)?;
    let completed_run = finalized_run(repository, &run, RunStatus::Succeeded, None, None)?;

    Ok(WorkflowRunResult {
        run: completed_run,
        artifact: Some(artifact),
        duplicate: false,
    })
}

#[cfg(test)]
pub fn resume_current_weather_run_with_provider(
    repository: &mut Repository,
    run_id: &str,
    provider: &dyn WeatherProvider,
) -> Result<WorkflowRunResult, RuntimeError> {
    let run = repository
        .workflow_run(run_id)?
        .ok_or_else(|| RuntimeError::MissingRun(run_id.into()))?;
    let mut version = repository
        .latest_workflow_version(&run.workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(run.workflow_id.clone()))?;
    if let Some(approved_version) = approved_workflow_version_for_run(repository, run_id)? {
        version = approved_version;
    }
    ensure_workflow_enabled(&version)?;
    let step_runs = repository.workflow_step_runs_for_run(run_id)?;
    continue_current_weather_run(repository, &version, run, step_runs, provider)
}

fn weather_markdown(snapshot: &WeatherSnapshot) -> String {
    format!(
        "# Current Weather\n\n## Conditions\n- Location: {}\n- Observed: {}\n- Condition: {}\n- Temperature: {:.1}{}\n- Feels like: {:.1}{}\n- Humidity: {}%\n- Wind: {:.1} {}\n- Precipitation: {:.2} {}\n\n## Source\n- Open-Meteo forecast API",
        snapshot.location,
        snapshot.observed_at,
        snapshot.condition,
        snapshot.temperature,
        snapshot.temperature_unit,
        snapshot.apparent_temperature,
        snapshot.apparent_temperature_unit,
        snapshot.humidity_percent,
        snapshot.wind_speed,
        snapshot.wind_speed_unit,
        snapshot.precipitation,
        snapshot.precipitation_unit,
    )
}

fn weather_provider_policy_step(steps: &[WorkflowStepDefinition]) -> WorkflowStepDefinition {
    steps
        .iter()
        .find(|step| step.provider == "open_meteo" && step.action == "current_weather")
        .cloned()
        .unwrap_or_else(|| WorkflowStepDefinition {
            kind: crate::models::WorkflowStepKind::ProviderAction,
            id: "fetch-weather".into(),
            name: "Fetch current weather".into(),
            provider: "open_meteo".into(),
            action: "current_weather".into(),
            depends_on: vec![],
            permissions: vec!["weather:read".into()],
            inputs: serde_json::json!({ "location": "Denver, CO" }),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        })
}

fn run_deterministic_provider_workflow_with_event_sink(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let version = repository
        .latest_workflow_version(workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(workflow_id.into()))?;
    ensure_workflow_enabled(&version)?;

    let (trigger_kind, idempotency_key) = match &trigger {
        RunTrigger::Manual => (
            "manual".to_string(),
            format!("manual:{workflow_id}:{}", Uuid::new_v4()),
        ),
        RunTrigger::ScheduleWindow(window) => (
            "schedule".to_string(),
            format!("schedule:{workflow_id}:{window}"),
        ),
        RunTrigger::ApprovedResume(run_id) => ("resume".to_string(), format!("resume:{run_id}")),
    };

    if let Some(existing_run) = repository.find_run_by_idempotency_key(&idempotency_key)? {
        return Ok(WorkflowRunResult {
            artifact: repository.artifact_for_run(&existing_run.id)?,
            run: existing_run,
            duplicate: true,
        });
    }

    let started_at = timestamp();
    let run = WorkflowRun {
        id: format!("run-{}", Uuid::new_v4()),
        workflow_id: workflow_id.into(),
        workflow_name: version.definition.name.clone(),
        status: RunStatus::Running,
        started_at: started_at.clone(),
        completed_at: None,
        failure_reason: None,
        idempotency_key,
        trigger_kind,
        retry_count: 0,
        parent_run_id: None,
        error_classification: None,
        provider_profile_id: Some("deterministic-provider".into()),
        blocked_reason: None,
        required_provider_id: None,
        required_profile_id: None,
        setup_action: None,
        total_tokens: None,
        input_tokens: None,
        output_tokens: None,
        total_cost_usd: None,
    };
    let step_runs = version
        .definition
        .steps
        .iter()
        .map(|step| WorkflowStepRun {
            id: format!("step-run-{}", Uuid::new_v4()),
            workflow_run_id: run.id.clone(),
            step_id: step.id.clone(),
            status: RunStatus::Running,
            output_json: None,
            error: None,
            started_at: started_at.clone(),
            completed_at: None,
        })
        .collect::<Vec<_>>();
    repository.create_run_with_steps(&run, &step_runs)?;
    emit_run_started(sink, &run);

    if let Some(result) = maybe_pause_for_approval_with_event_sink(
        repository,
        &version,
        &run,
        &step_runs,
        "deterministic_provider",
        sink,
    )? {
        return Ok(result);
    }

    continue_deterministic_provider_workflow(repository, &version, run, step_runs, sink)
}

fn continue_deterministic_provider_workflow(
    repository: &mut Repository,
    version: &WorkflowVersion,
    run: WorkflowRun,
    step_runs: Vec<WorkflowStepRun>,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    if let Some(artifact) = repository.artifact_for_run(&run.id)? {
        return Ok(WorkflowRunResult {
            run,
            artifact: Some(artifact),
            duplicate: true,
        });
    }

    let mut outputs = step_outputs(repository, &run.id)?;
    let mut artifact = None;
    let registry = runtime_registry_snapshot();
    for step in &version.definition.steps {
        let Some(step_run) = step_run_for_step(&step_runs, &step.id) else {
            return fail_deterministic_provider_runtime(
                repository,
                run,
                &step_runs,
                &format!("Missing step run for deterministic step {}.", step.id),
                sink,
            );
        };
        if step_run.status == RunStatus::Succeeded && step_run.output_json.is_some() {
            continue;
        }

        emit_step_started(sink, &run.id, step);
        let mut resolved_inputs = resolve_step_input_references(&step.inputs, &outputs);
        let preallocated_artifact_paths = if is_local_app_write_artifact_step(step) {
            let artifact_id = format!("artifact-{}", Uuid::new_v4());
            let (content_path, metadata_path) = repository.artifact_paths(&artifact_id);
            resolved_inputs =
                add_artifact_write_paths_to_inputs(resolved_inputs, &content_path, &metadata_path);
            Some((artifact_id, content_path, metadata_path))
        } else {
            None
        };
        match enforce_provider_step_policy(
            repository,
            version,
            &run,
            step,
            &resolved_inputs,
            &registry,
        )? {
            RuntimeCapabilityPolicyCheck::Allowed => {}
            RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
                return block_deterministic_provider_runtime(
                    repository, run, &step_runs, blocked, sink,
                );
            }
        }
        let output = if is_local_app_write_artifact_step(step) {
            let (artifact_id, content_path, metadata_path) = preallocated_artifact_paths
                .expect("local_app.write_artifact preallocates artifact paths");
            let written = match write_deterministic_artifact(
                repository,
                version,
                &run,
                step,
                &resolved_inputs,
                artifact_id,
                content_path,
                metadata_path,
            ) {
                Ok(artifact) => artifact,
                Err(error) => {
                    return fail_deterministic_provider_runtime(
                        repository,
                        run,
                        &step_runs,
                        &error.to_string(),
                        sink,
                    );
                }
            };
            let output = serde_json::json!({
                "content_path": written.content_path,
                "metadata_path": written.metadata_path
            });
            artifact = Some(written);
            output
        } else {
            match execute_deterministic_provider_step(step, &resolved_inputs) {
                Ok(output) => output,
                Err(error) => {
                    return fail_deterministic_provider_runtime(
                        repository, run, &step_runs, &error, sink,
                    );
                }
            }
        };
        if let Err(error) = repository.finish_step(&step_run.id, output.clone()) {
            return fail_deterministic_provider_runtime(
                repository,
                run,
                &step_runs,
                &error.to_string(),
                sink,
            );
        }
        insert_step_output(&mut outputs, &step.id, output);
        emit_step_finished(sink, &run.id, &step.id, None, None);
    }

    repository.finish_run(&run.id, RunStatus::Succeeded, None)?;
    Ok(WorkflowRunResult {
        run: finalized_run(repository, &run, RunStatus::Succeeded, None, None)?,
        artifact,
        duplicate: false,
    })
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn run_workflow_with_generator(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    generator: &dyn LlmArtifactGenerator,
) -> Result<WorkflowRunResult, RuntimeError> {
    run_workflow_with_generator_and_event_sink(
        repository,
        workflow_id,
        trigger,
        generator,
        &NoopRuntimeEventSink,
    )
}

pub fn run_workflow_with_generator_and_event_sink(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    generator: &dyn LlmArtifactGenerator,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    run_workflow_with_generator_and_profile_and_event_sink(
        repository,
        workflow_id,
        trigger,
        generator,
        "openai",
        "gpt-4.1",
        "medium",
        sink,
    )
}

pub fn run_workflow_with_agent_executor(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    executor: &dyn AgentTaskExecutor,
) -> Result<WorkflowRunResult, RuntimeError> {
    run_workflow_with_agent_executor_and_event_sink(
        repository,
        workflow_id,
        trigger,
        executor,
        &NoopRuntimeEventSink,
    )
}

pub fn run_workflow_with_agent_executor_and_event_sink(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    executor: &dyn AgentTaskExecutor,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let mut version = repository
        .latest_workflow_version(workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(workflow_id.into()))?;
    ensure_workflow_enabled(&version)?;
    let Some(initial_agent_step) = version
        .definition
        .steps
        .iter()
        .find(|step| step.kind == crate::models::WorkflowStepKind::AgentTask)
    else {
        return Err(RuntimeError::MissingAgentTask(workflow_id.into()));
    };

    let initial_profile_id = initial_agent_step
        .llm_profile_ref
        .as_deref()
        .unwrap_or(&version.definition.defaults.llm_profile_ref);
    let (run, step_runs, resumed) = match &trigger {
        RunTrigger::ApprovedResume(run_id) => {
            let run = repository
                .workflow_run(run_id)?
                .ok_or_else(|| RuntimeError::MissingRun(run_id.clone()))?;
            let step_runs = repository.workflow_step_runs_for_run(run_id)?;
            (run, step_runs, true)
        }
        RunTrigger::Manual | RunTrigger::ScheduleWindow(_) => {
            let trigger_kind = match &trigger {
                RunTrigger::Manual => "manual".to_string(),
                RunTrigger::ScheduleWindow(_) => "schedule".to_string(),
                RunTrigger::ApprovedResume(_) => unreachable!(),
            };
            let idempotency_key = match &trigger {
                RunTrigger::Manual => format!("manual:{workflow_id}:{}", Uuid::new_v4()),
                RunTrigger::ScheduleWindow(window) => format!("schedule:{workflow_id}:{window}"),
                RunTrigger::ApprovedResume(_) => unreachable!(),
            };

            if let Some(existing_run) = repository.find_run_by_idempotency_key(&idempotency_key)? {
                return Ok(WorkflowRunResult {
                    artifact: repository.artifact_for_run(&existing_run.id)?,
                    run: existing_run,
                    duplicate: true,
                });
            }

            let started_at = timestamp();
            let run = WorkflowRun {
                id: format!("run-{}", Uuid::new_v4()),
                workflow_id: workflow_id.into(),
                workflow_name: version.definition.name.clone(),
                status: RunStatus::Running,
                started_at: started_at.clone(),
                completed_at: None,
                failure_reason: None,
                idempotency_key,
                trigger_kind,
                retry_count: 0,
                parent_run_id: None,
                error_classification: None,
                provider_profile_id: Some(initial_profile_id.into()),
                blocked_reason: None,
                required_provider_id: None,
                required_profile_id: None,
                setup_action: None,
                total_tokens: None,
                input_tokens: None,
                output_tokens: None,
                total_cost_usd: None,
            };
            let step_runs = version
                .definition
                .steps
                .iter()
                .map(|step| WorkflowStepRun {
                    id: format!("step-run-{}", Uuid::new_v4()),
                    workflow_run_id: run.id.clone(),
                    step_id: step.id.clone(),
                    status: RunStatus::Running,
                    output_json: None,
                    error: None,
                    started_at: started_at.clone(),
                    completed_at: None,
                })
                .collect::<Vec<_>>();
            repository.create_run_with_steps(&run, &step_runs)?;
            (run, step_runs, false)
        }
    };
    emit_run_started(sink, &run);
    if resumed {
        if let Some(approved_version) = approved_workflow_version_for_run(repository, &run.id)? {
            version = approved_version;
            ensure_workflow_enabled(&version)?;
        }
    }
    let Some(agent_step) = version
        .definition
        .steps
        .iter()
        .find(|step| step.kind == crate::models::WorkflowStepKind::AgentTask)
    else {
        return Err(RuntimeError::MissingAgentTask(version.workflow_id.clone()));
    };
    let profile_id = agent_step
        .llm_profile_ref
        .as_deref()
        .unwrap_or(&version.definition.defaults.llm_profile_ref);
    let profile = runtime_agent_auth_profiles()
        .into_iter()
        .find(|profile| profile.id == profile_id);

    if !resumed {
        if let Some(result) = maybe_pause_for_approval_with_event_sink(
            repository,
            &version,
            &run,
            &step_runs,
            "agent_task",
            sink,
        )? {
            return Ok(result);
        }
    }

    if let Some(error) = unsupported_agent_runtime_shape(&version.definition.steps) {
        fail_all_steps(repository, &step_runs, RunStatus::Failed, &error)?;
        repository.finish_run_with_classification(
            &run.id,
            RunStatus::Failed,
            Some(&error),
            Some("terminal"),
        )?;
        emit_run_error(sink, &run.id, &error, "terminal");
        return Ok(WorkflowRunResult {
            run: WorkflowRun {
                status: RunStatus::Failed,
                completed_at: Some(timestamp()),
                failure_reason: Some(error),
                error_classification: Some("terminal".into()),
                ..run
            },
            artifact: None,
            duplicate: false,
        });
    }

    if executor.requires_profile_check() {
        let Some(ref profile) = profile else {
            let blocked = agent_blocked_details(profile_id);
            fail_all_steps(repository, &step_runs, RunStatus::Blocked, &blocked.reason)?;
            repository.block_run(
                &run.id,
                &blocked.reason,
                &blocked.required_provider_id,
                &blocked.required_profile_id,
                &blocked.setup_action,
            )?;
            emit_run_error(sink, &run.id, &blocked.reason, "terminal");
            return Ok(WorkflowRunResult {
                run: WorkflowRun {
                    status: RunStatus::Blocked,
                    completed_at: Some(timestamp()),
                    failure_reason: Some(blocked.reason.clone()),
                    error_classification: Some("terminal".into()),
                    blocked_reason: Some(blocked.reason),
                    required_provider_id: Some(blocked.required_provider_id),
                    required_profile_id: Some(blocked.required_profile_id),
                    setup_action: Some(blocked.setup_action),
                    ..run
                },
                artifact: None,
                duplicate: false,
            });
        };
        if profile.status != "available"
            && !matches!(
                profile.runner_kind,
                agent_auth::AgentRunnerKind::OpenAiApi | agent_auth::AgentRunnerKind::AnthropicApi
            )
        {
            let blocked = agent_profile_unavailable_details(profile);
            fail_all_steps(repository, &step_runs, RunStatus::Blocked, &blocked.reason)?;
            repository.block_run(
                &run.id,
                &blocked.reason,
                &blocked.required_provider_id,
                &blocked.required_profile_id,
                &blocked.setup_action,
            )?;
            emit_run_error(sink, &run.id, &blocked.reason, "terminal");
            return Ok(WorkflowRunResult {
                run: WorkflowRun {
                    status: RunStatus::Blocked,
                    completed_at: Some(timestamp()),
                    failure_reason: Some(blocked.reason.clone()),
                    error_classification: Some("terminal".into()),
                    blocked_reason: Some(blocked.reason),
                    required_provider_id: Some(blocked.required_provider_id),
                    required_profile_id: Some(blocked.required_profile_id),
                    setup_action: Some(blocked.setup_action),
                    ..run
                },
                artifact: None,
                duplicate: false,
            });
        }
    }
    let profile = profile.unwrap_or_else(|| agent_auth::AgentAuthProfile {
        id: profile_id.into(),
        display_name: profile_id.into(),
        status: "deterministic".into(),
        model: "deterministic".into(),
        effort: "medium".into(),
        runner_kind: agent_auth::AgentRunnerKind::OpenAiApi,
        auth_mode: agent_auth::AgentAuthMode::None,
        credential_ref: String::new(),
        summary: String::new(),
    });
    let allowed_tools = allowed_tools(agent_step);
    let tool_manifest = match agent_task::expand_allowed_tools(&allowed_tools) {
        Ok(tool_manifest) => tool_manifest,
        Err(error) => {
            fail_all_steps(
                repository,
                &step_runs,
                RunStatus::Failed,
                &error.to_string(),
            )?;
            repository.finish_run_with_classification(
                &run.id,
                RunStatus::Failed,
                Some(&error.to_string()),
                Some("terminal"),
            )?;
            emit_run_error(sink, &run.id, &error.to_string(), "terminal");
            return Ok(WorkflowRunResult {
                run: WorkflowRun {
                    status: RunStatus::Failed,
                    completed_at: Some(timestamp()),
                    failure_reason: Some(error.to_string()),
                    error_classification: Some("terminal".into()),
                    ..run
                },
                artifact: None,
                duplicate: false,
            });
        }
    };
    let tool_manifest_hash = tool_manifest_hash(&tool_manifest);
    if let Some(result) = execute_agent_pre_steps(
        repository,
        &version,
        &version.definition.steps,
        &run,
        &step_runs,
        agent_step,
        sink,
    )? {
        return Ok(result);
    }
    let agent_policy_inputs =
        agent_task_policy_inputs(agent_step, profile_id, &step_outputs(repository, &run.id)?);
    match enforce_agent_task_policy(repository, &version, &run, agent_step, &agent_policy_inputs)? {
        RuntimeCapabilityPolicyCheck::Allowed => {}
        RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
            return block_agent_runtime_before_executor(repository, run, &step_runs, blocked, sink);
        }
    }
    let tool_event = AgentToolEvent {
        id: format!("agent-tool-event-{}", Uuid::new_v4()),
        workflow_run_id: run.id.clone(),
        step_id: agent_step.id.clone(),
        tool_id: "agent.run_task".into(),
        status: AgentToolEventStatus::Requested,
        input_json: serde_json::json!({
            "objective": objective(agent_step),
            "allowed_tools": allowed_tools,
            "tool_manifest_hash": tool_manifest_hash,
            "profile_id": profile.id,
            "model": profile.model,
            "effort": profile.effort,
        }),
        output_json: None,
        error: None,
        created_at: timestamp(),
        completed_at: None,
    };
    if let Err(error) = repository.insert_agent_tool_event(&tool_event) {
        let error = sanitize_agent_text(&error.to_string());
        fail_all_steps(repository, &step_runs, RunStatus::Failed, &error)?;
        repository.finish_run_with_classification(
            &run.id,
            RunStatus::Failed,
            Some(&error),
            Some("terminal"),
        )?;
        emit_run_error(sink, &run.id, &error, "terminal");
        return Ok(WorkflowRunResult {
            run: WorkflowRun {
                status: RunStatus::Failed,
                completed_at: Some(timestamp()),
                failure_reason: Some(error),
                error_classification: Some("terminal".into()),
                ..run
            },
            artifact: None,
            duplicate: false,
        });
    }

    let request = AgentTaskRequest {
        workflow: version.definition.clone(),
        step_id: agent_step.id.clone(),
        objective: objective(agent_step),
        output_schema: agent_step
            .inputs
            .get("output_schema")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        tool_manifest: tool_manifest.clone(),
        prior_step_outputs: step_outputs(repository, &run.id)?,
        permissions: agent_step.permissions.clone(),
        profile: profile.clone(),
    };
    emit_step_started(sink, &run.id, agent_step);
    sink.emit(AgentEvent::ThinkingContent {
        run_id: run.id.clone(),
        step_id: agent_step.id.clone(),
        content: format!("Executing agent task with {}", profile.display_name),
    });
    sink.emit(AgentEvent::ToolCallStart {
        run_id: run.id.clone(),
        step_id: agent_step.id.clone(),
        tool_call_id: tool_event.id.clone(),
        tool_name: "agent.run_task".into(),
        args: tool_event.input_json.clone(),
    });
    let envelope = match executor.execute(&request) {
        Ok(envelope) => envelope,
        Err(error) => {
            let error_message = error.to_string();
            if is_local_oauth_auth_error(&profile, &error_message) {
                let blocked = agent_auth_error_blocked_details(&profile, &error_message);
                return finish_agent_runtime_blocked_after_executor(
                    repository,
                    run,
                    &step_runs,
                    &tool_event.id,
                    blocked,
                    sink,
                );
            }
            if is_native_api_auth_error(&profile, &error_message) {
                let blocked = native_agent_auth_error_blocked_details(&profile, &error_message);
                return finish_agent_runtime_blocked_after_executor(
                    repository,
                    run,
                    &step_runs,
                    &tool_event.id,
                    blocked,
                    sink,
                );
            }
            let (status, classification) = classify_agent_task_error(&error);
            sink.emit(AgentEvent::ToolCallEnd {
                run_id: run.id.clone(),
                step_id: agent_step.id.clone(),
                tool_name: "agent.run_task".into(),
                result: error_message.clone(),
                duration_ms: 0,
            });
            sink.emit(AgentEvent::RunError {
                run_id: run.id.clone(),
                error: error_message.clone(),
                classification: classification.into(),
            });
            return finish_agent_runtime_executor_error(
                repository,
                run,
                &step_runs,
                &tool_event.id,
                status,
                classification,
                &error_message,
            );
        }
    };

    let envelope = sanitize_agent_task_envelope(envelope);
    let token_usage = usage_totals(&envelope.metadata);
    sink.emit(AgentEvent::ToolCallEnd {
        run_id: run.id.clone(),
        step_id: agent_step.id.clone(),
        tool_name: "agent.run_task".into(),
        result: envelope.title.clone(),
        duration_ms: 0,
    });
    emit_tool_trace_events(sink, &run.id, &agent_step.id, &envelope.tool_trace);
    sink.emit(AgentEvent::TextMessageContent {
        run_id: run.id.clone(),
        step_id: agent_step.id.clone(),
        content: envelope.content_markdown.clone(),
    });
    let metadata =
        match agent_artifact_metadata(&envelope, &profile, &allowed_tools, &tool_manifest_hash) {
            Ok(metadata) => metadata,
            Err(error) => {
                return fail_agent_runtime_after_executor(
                    repository,
                    run,
                    &step_runs,
                    &tool_event.id,
                    &error,
                    sink,
                );
            }
        };

    let artifact_id = format!("artifact-{}", Uuid::new_v4());
    let (content_path, metadata_path) = repository.artifact_paths(&artifact_id);
    let artifact = Artifact {
        id: artifact_id,
        title: envelope.title.clone(),
        artifact_type: "agent_task".into(),
        workflow_run_id: run.id.clone(),
        content_path,
        metadata_path,
        content_markdown: envelope.content_markdown.clone(),
        metadata: merge_artifact_metadata(
            metadata,
            workflow_id,
            version.version,
            &version.definition.defaults.destination_ref,
        ),
        source_refs: envelope.source_refs.clone(),
        created_at: timestamp(),
    };
    if let Err(error) = repository.complete_agent_tool_event(
        &tool_event.id,
        AgentToolEventStatus::Succeeded,
        Some(serde_json::json!({
            "title": envelope.title,
            "source_refs": envelope.source_refs,
            "tool_trace": envelope.tool_trace,
        })),
        None,
    ) {
        return fail_agent_runtime_after_executor(
            repository,
            run,
            &step_runs,
            &tool_event.id,
            &error.to_string(),
            sink,
        );
    }

    if let Some(step_run) = step_run_for_step(&step_runs, &agent_step.id) {
        if let Err(error) = repository.finish_step(
            &step_run.id,
            serde_json::json!({ "artifact": envelope.content_markdown, "format": "markdown" }),
        ) {
            return fail_agent_runtime_after_executor(
                repository,
                run,
                &step_runs,
                &tool_event.id,
                &error.to_string(),
                sink,
            );
        }
        emit_step_finished(
            sink,
            &run.id,
            &agent_step.id,
            token_usage.total_tokens,
            token_usage.estimated_cost_usd,
        );
    }

    let artifact_write_step =
        artifact_persistence_policy_step(&version.definition.steps, &agent_step.id);
    let artifact_write_inputs = add_artifact_write_paths_to_inputs(
        resolve_step_input_references(
            &artifact_write_step.inputs,
            &step_outputs(repository, &run.id)?,
        ),
        &artifact.content_path,
        &artifact.metadata_path,
    );
    match enforce_provider_step_policy(
        repository,
        &version,
        &run,
        &artifact_write_step,
        &artifact_write_inputs,
        &runtime_registry_snapshot(),
    )? {
        RuntimeCapabilityPolicyCheck::Allowed => {}
        RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
            return block_agent_runtime_before_executor(repository, run, &step_runs, blocked, sink);
        }
    }

    if let Some(step_run) = local_app_write_artifact_step_run(&version.definition.steps, &step_runs)
    {
        emit_step_started_for_id(sink, &run.id, &version.definition.steps, &step_run.step_id);
        if let Err(error) = repository.finish_step(
            &step_run.id,
            serde_json::json!({
                "content_path": artifact.content_path,
                "metadata_path": artifact.metadata_path
            }),
        ) {
            return fail_agent_runtime_after_executor(
                repository,
                run,
                &step_runs,
                &tool_event.id,
                &error.to_string(),
                sink,
            );
        }
        emit_step_finished(sink, &run.id, &step_run.step_id, None, None);
    }
    if let Err(error) = repository.write_artifact(&artifact) {
        return fail_agent_runtime_after_executor(
            repository,
            run,
            &step_runs,
            &tool_event.id,
            &error.to_string(),
            sink,
        );
    }
    auto_export_to_destination(
        repository,
        &artifact.id,
        &version.definition.defaults.destination_ref,
    );
    if let Err(error) = repository.finish_run_with_token_usage(
        &run.id,
        RunStatus::Succeeded,
        None,
        token_usage.total_tokens,
        token_usage.input_tokens,
        token_usage.output_tokens,
        token_usage.estimated_cost_usd,
    ) {
        return fail_agent_runtime_after_executor(
            repository,
            run,
            &step_runs,
            &tool_event.id,
            &error.to_string(),
            sink,
        );
    }
    sink.emit(AgentEvent::RunFinished {
        run_id: run.id.clone(),
        artifact_id: Some(artifact.id.clone()),
        duration_ms: 0,
        token_count: token_usage.total_tokens,
        estimated_cost_usd: token_usage.estimated_cost_usd,
    });

    Ok(WorkflowRunResult {
        run: finalized_run(
            repository,
            &run,
            RunStatus::Succeeded,
            token_usage
                .total_tokens
                .and_then(|value| i64::try_from(value).ok()),
            token_usage.estimated_cost_usd,
        )?,
        artifact: Some(artifact),
        duplicate: false,
    })
}

#[cfg(test)]
fn run_workflow_with_generator_and_profile(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    generator: &dyn LlmArtifactGenerator,
    provider_id: &str,
    model: &str,
    effort: &str,
) -> Result<WorkflowRunResult, RuntimeError> {
    run_workflow_with_generator_and_profile_and_event_sink(
        repository,
        workflow_id,
        trigger,
        generator,
        provider_id,
        model,
        effort,
        &NoopRuntimeEventSink,
    )
}

fn run_workflow_with_generator_and_profile_and_event_sink(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    generator: &dyn LlmArtifactGenerator,
    provider_id: &str,
    model: &str,
    effort: &str,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let version = repository
        .latest_workflow_version(workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(workflow_id.into()))?;
    ensure_workflow_enabled(&version)?;

    let trigger_kind = match &trigger {
        RunTrigger::Manual => "manual".to_string(),
        RunTrigger::ScheduleWindow(_) => "schedule".to_string(),
        RunTrigger::ApprovedResume(_) => "resume".to_string(),
    };
    let idempotency_key = match trigger {
        RunTrigger::Manual => format!("manual:{workflow_id}:{}", Uuid::new_v4()),
        RunTrigger::ScheduleWindow(window) => format!("schedule:{workflow_id}:{window}"),
        RunTrigger::ApprovedResume(run_id) => format!("resume:{run_id}"),
    };

    if let Some(existing_run) = repository.find_run_by_idempotency_key(&idempotency_key)? {
        return Ok(WorkflowRunResult {
            artifact: repository.artifact_for_run(&existing_run.id)?,
            run: existing_run,
            duplicate: true,
        });
    }

    let started_at = timestamp();
    let run = WorkflowRun {
        id: format!("run-{}", Uuid::new_v4()),
        workflow_id: workflow_id.into(),
        workflow_name: version.definition.name.clone(),
        status: RunStatus::Running,
        started_at: started_at.clone(),
        completed_at: None,
        failure_reason: None,
        idempotency_key,
        trigger_kind,
        retry_count: 0,
        parent_run_id: None,
        error_classification: None,
        provider_profile_id: Some(version.definition.defaults.llm_profile_ref.clone()),
        blocked_reason: None,
        required_provider_id: None,
        required_profile_id: None,
        setup_action: None,
        total_tokens: None,
        input_tokens: None,
        output_tokens: None,
        total_cost_usd: None,
    };
    let step_runs = version
        .definition
        .steps
        .iter()
        .map(|step| WorkflowStepRun {
            id: format!("step-run-{}", Uuid::new_v4()),
            workflow_run_id: run.id.clone(),
            step_id: step.id.clone(),
            status: RunStatus::Running,
            output_json: None,
            error: None,
            started_at: started_at.clone(),
            completed_at: None,
        })
        .collect::<Vec<_>>();

    repository.create_run_with_steps(&run, &step_runs)?;
    emit_run_started(sink, &run);

    if let Some(result) = maybe_pause_for_approval_with_event_sink(
        repository, &version, &run, &step_runs, "llm", sink,
    )? {
        return Ok(result);
    }

    continue_workflow_with_generator_and_profile(
        repository,
        workflow_id,
        &version,
        run,
        step_runs,
        generator,
        provider_id,
        model,
        effort,
        sink,
    )
}

fn continue_workflow_with_generator_and_profile(
    repository: &mut Repository,
    workflow_id: &str,
    version: &WorkflowVersion,
    run: WorkflowRun,
    step_runs: Vec<WorkflowStepRun>,
    generator: &dyn LlmArtifactGenerator,
    provider_id: &str,
    model: &str,
    effort: &str,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    if let Some(artifact) = repository.artifact_for_run(&run.id)? {
        return Ok(WorkflowRunResult {
            run,
            artifact: Some(artifact),
            duplicate: true,
        });
    }

    let registry = runtime_registry_snapshot();
    if let Some(collect_context_step) = version
        .definition
        .steps
        .iter()
        .find(|step| step.id == "collect-context")
    {
        let collect_context_inputs = resolve_step_input_references(
            &collect_context_step.inputs,
            &step_outputs(repository, &run.id)?,
        );
        match enforce_provider_step_policy(
            repository,
            version,
            &run,
            collect_context_step,
            &collect_context_inputs,
            &registry,
        )? {
            RuntimeCapabilityPolicyCheck::Allowed => {}
            RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
                return block_deterministic_provider_runtime(
                    repository, run, &step_runs, blocked, sink,
                );
            }
        }
    }

    let project_root = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let context = repository
        .gather_all_context(&project_root)
        .unwrap_or_else(|_| crate::providers::ContextPack {
            summary: "Local context unavailable; generated fallback artifact.".into(),
            source_refs: vec!["runtime fallback".into()],
        });

    if let Some(step) = step_runs
        .iter()
        .find(|step| step.step_id == "collect-context")
    {
        emit_step_started_for_id(sink, &run.id, &version.definition.steps, &step.step_id);
        repository.finish_step(
            &step.id,
            serde_json::json!({ "summary": context.summary, "source_refs": context.source_refs }),
        )?;
        emit_step_finished(sink, &run.id, &step.step_id, None, None);
    }

    let artifact_request = ArtifactGenerationRequest {
        workflow: version.definition.clone(),
        context_summary: context.summary.clone(),
        source_refs: context.source_refs.clone(),
        provider_id: provider_id.into(),
        model: model.into(),
        effort: effort.into(),
    };
    if let Some(compose_artifact_step) = version
        .definition
        .steps
        .iter()
        .find(|step| step.id == "compose-artifact")
    {
        let compose_artifact_inputs = resolve_step_input_references(
            &compose_artifact_step.inputs,
            &step_outputs(repository, &run.id)?,
        );
        match enforce_provider_step_policy(
            repository,
            version,
            &run,
            compose_artifact_step,
            &compose_artifact_inputs,
            &registry,
        )? {
            RuntimeCapabilityPolicyCheck::Allowed => {}
            RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
                return block_deterministic_provider_runtime(
                    repository, run, &step_runs, blocked, sink,
                );
            }
        }
    }
    if let Some(step) = step_runs
        .iter()
        .find(|step| step.step_id == "compose-artifact")
    {
        emit_step_started_for_id(sink, &run.id, &version.definition.steps, &step.step_id);
    }
    let envelope = match generator.generate_artifact(&artifact_request) {
        Ok(envelope) => envelope,
        Err(error) => {
            let (status, classification) = classify_llm_error(&error);
            if let Some(step) = step_runs
                .iter()
                .find(|step| step.step_id == "compose-artifact")
            {
                repository.fail_step(&step.id, status.clone(), &error.to_string())?;
            }
            repository.finish_run_with_classification(
                &run.id,
                status.clone(),
                Some(&error.to_string()),
                Some(classification),
            )?;
            sink.emit(AgentEvent::RunError {
                run_id: run.id.clone(),
                error: error.to_string(),
                classification: classification.into(),
            });
            return Ok(WorkflowRunResult {
                run: WorkflowRun {
                    status,
                    completed_at: Some(timestamp()),
                    failure_reason: Some(error.to_string()),
                    error_classification: Some(classification.into()),
                    ..run
                },
                artifact: None,
                duplicate: false,
            });
        }
    };
    let token_usage = usage_totals(&envelope.metadata);
    sink.emit(AgentEvent::TextMessageContent {
        run_id: run.id.clone(),
        step_id: "compose-artifact".into(),
        content: envelope.content_markdown.clone(),
    });
    if let Some(step) = step_runs
        .iter()
        .find(|step| step.step_id == "compose-artifact")
    {
        repository.finish_step(
            &step.id,
            serde_json::json!({ "artifact": envelope.content_markdown, "format": "markdown" }),
        )?;
        emit_step_finished(
            sink,
            &run.id,
            &step.step_id,
            token_usage.total_tokens,
            token_usage.estimated_cost_usd,
        );
    }

    let artifact_id = format!("artifact-{}", Uuid::new_v4());
    let (content_path, metadata_path) = repository.artifact_paths(&artifact_id);
    let artifact = Artifact {
        id: artifact_id,
        title: envelope.title,
        artifact_type: if workflow_id == "morning-brief" {
            "morning_brief".into()
        } else {
            "daily_work_journal".into()
        },
        workflow_run_id: run.id.clone(),
        content_path,
        metadata_path,
        content_markdown: envelope.content_markdown,
        metadata: merge_artifact_metadata(
            envelope.metadata,
            workflow_id,
            version.version,
            &version.definition.defaults.destination_ref,
        ),
        source_refs: envelope.source_refs,
        created_at: timestamp(),
    };
    let artifact_write_step =
        artifact_persistence_policy_step(&version.definition.steps, "compose-artifact");
    let artifact_write_inputs = add_artifact_write_paths_to_inputs(
        resolve_step_input_references(
            &artifact_write_step.inputs,
            &step_outputs(repository, &run.id)?,
        ),
        &artifact.content_path,
        &artifact.metadata_path,
    );
    match enforce_provider_step_policy(
        repository,
        version,
        &run,
        &artifact_write_step,
        &artifact_write_inputs,
        &runtime_registry_snapshot(),
    )? {
        RuntimeCapabilityPolicyCheck::Allowed => {}
        RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
            return block_deterministic_provider_runtime(
                repository, run, &step_runs, blocked, sink,
            );
        }
    }
    repository.write_artifact(&artifact)?;
    auto_export_to_destination(
        repository,
        &artifact.id,
        &version.definition.defaults.destination_ref,
    );

    if let Some(step) = step_runs
        .iter()
        .find(|step| step.step_id == "write-artifact")
    {
        emit_step_started_for_id(sink, &run.id, &version.definition.steps, &step.step_id);
        repository.finish_step(
            &step.id,
            serde_json::json!({
                "content_path": artifact.content_path,
                "metadata_path": artifact.metadata_path
            }),
        )?;
        emit_step_finished(sink, &run.id, &step.step_id, None, None);
    }
    repository.finish_run_with_token_usage(
        &run.id,
        RunStatus::Succeeded,
        None,
        token_usage.total_tokens,
        token_usage.input_tokens,
        token_usage.output_tokens,
        token_usage.estimated_cost_usd,
    )?;
    sink.emit(AgentEvent::RunFinished {
        run_id: run.id.clone(),
        artifact_id: Some(artifact.id.clone()),
        duration_ms: 0,
        token_count: token_usage.total_tokens,
        estimated_cost_usd: token_usage.estimated_cost_usd,
    });

    Ok(WorkflowRunResult {
        run: finalized_run(
            repository,
            &run,
            RunStatus::Succeeded,
            token_usage
                .total_tokens
                .and_then(|value| i64::try_from(value).ok()),
            token_usage.estimated_cost_usd,
        )?,
        artifact: Some(artifact),
        duplicate: false,
    })
}

#[cfg(test)]
pub fn resume_workflow_with_generator_and_profile(
    repository: &mut Repository,
    run_id: &str,
    generator: &dyn LlmArtifactGenerator,
    provider_id: &str,
    model: &str,
    effort: &str,
) -> Result<WorkflowRunResult, RuntimeError> {
    let run = repository
        .workflow_run(run_id)?
        .ok_or_else(|| RuntimeError::MissingRun(run_id.into()))?;
    let mut version = repository
        .latest_workflow_version(&run.workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(run.workflow_id.clone()))?;
    if let Some(approved_version) = approved_workflow_version_for_run(repository, run_id)? {
        version = approved_version;
    }
    ensure_workflow_enabled(&version)?;
    let step_runs = repository.workflow_step_runs_for_run(run_id)?;
    let workflow_id = run.workflow_id.clone();
    continue_workflow_with_generator_and_profile(
        repository,
        &workflow_id,
        &version,
        run,
        step_runs,
        generator,
        provider_id,
        model,
        effort,
        &NoopRuntimeEventSink,
    )
}

pub fn run_workflow_with_plugins_and_event_sink(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    plugins: &[crate::plugins::PluginManifest],
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let mut version = repository
        .latest_workflow_version(workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(workflow_id.into()))?;
    ensure_workflow_enabled(&version)?;

    let (run, step_runs, resumed) = match &trigger {
        RunTrigger::ApprovedResume(run_id) => {
            let run = repository
                .workflow_run(run_id)?
                .ok_or_else(|| RuntimeError::MissingRun(run_id.clone()))?;
            let step_runs = repository.workflow_step_runs_for_run(run_id)?;
            (run, step_runs, true)
        }
        RunTrigger::Manual | RunTrigger::ScheduleWindow(_) => {
            let trigger_kind = match &trigger {
                RunTrigger::Manual => "manual".to_string(),
                RunTrigger::ScheduleWindow(_) => "schedule".to_string(),
                RunTrigger::ApprovedResume(_) => unreachable!(),
            };
            let idempotency_key = match &trigger {
                RunTrigger::Manual => format!("manual:{workflow_id}:{}", Uuid::new_v4()),
                RunTrigger::ScheduleWindow(window) => format!("schedule:{workflow_id}:{window}"),
                RunTrigger::ApprovedResume(_) => unreachable!(),
            };
            if let Some(existing_run) = repository.find_run_by_idempotency_key(&idempotency_key)? {
                return Ok(WorkflowRunResult {
                    artifact: repository.artifact_for_run(&existing_run.id)?,
                    run: existing_run,
                    duplicate: true,
                });
            }
            let started_at = timestamp();
            let run = WorkflowRun {
                id: format!("run-{}", Uuid::new_v4()),
                workflow_id: workflow_id.into(),
                workflow_name: version.definition.name.clone(),
                status: RunStatus::Running,
                started_at: started_at.clone(),
                completed_at: None,
                failure_reason: None,
                idempotency_key,
                trigger_kind,
                retry_count: 0,
                parent_run_id: None,
                error_classification: None,
                provider_profile_id: Some("plugin".into()),
                blocked_reason: None,
                required_provider_id: None,
                required_profile_id: None,
                setup_action: None,
                total_tokens: None,
                input_tokens: None,
                output_tokens: None,
                total_cost_usd: None,
            };
            let step_runs = version
                .definition
                .steps
                .iter()
                .map(|step| WorkflowStepRun {
                    id: format!("step-run-{}", Uuid::new_v4()),
                    workflow_run_id: run.id.clone(),
                    step_id: step.id.clone(),
                    status: RunStatus::Running,
                    output_json: None,
                    error: None,
                    started_at: started_at.clone(),
                    completed_at: None,
                })
                .collect::<Vec<_>>();
            repository.create_run_with_steps(&run, &step_runs)?;
            (run, step_runs, false)
        }
    };

    emit_run_started(sink, &run);
    if resumed {
        if let Some(approved_version) = approved_workflow_version_for_run(repository, &run.id)? {
            version = approved_version;
            ensure_workflow_enabled(&version)?;
        }
    }
    if !resumed {
        if let Some(result) = maybe_pause_for_approval_with_plugin_capabilities(
            repository,
            &version,
            &run,
            &step_runs,
            "plugin",
            Some(plugins),
            sink,
        )? {
            return Ok(result);
        }
    }

    continue_plugin_workflow(repository, &version, run, step_runs, plugins, sink)
}

fn continue_plugin_workflow(
    repository: &mut Repository,
    version: &WorkflowVersion,
    run: WorkflowRun,
    step_runs: Vec<WorkflowStepRun>,
    plugins: &[crate::plugins::PluginManifest],
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    if let Some(artifact) = repository.artifact_for_run(&run.id)? {
        return Ok(WorkflowRunResult {
            run,
            artifact: Some(artifact),
            duplicate: true,
        });
    }

    if let Err(error) =
        validate_approved_plugin_capability_signature(repository, &run.id, version, plugins)
    {
        fail_all_steps(repository, &step_runs, RunStatus::Failed, &error)?;
        repository.finish_run_with_classification(
            &run.id,
            RunStatus::Failed,
            Some(&error),
            Some("terminal"),
        )?;
        emit_run_error(sink, &run.id, &error, "terminal");
        return Ok(failed_run_result(run, error));
    }

    if let Err(error) =
        crate::workflow::validate_workflow_with_plugins(&version.definition, plugins)
    {
        let error = error.to_string();
        fail_all_steps(repository, &step_runs, RunStatus::Failed, &error)?;
        repository.finish_run_with_classification(
            &run.id,
            RunStatus::Failed,
            Some(&error),
            Some("terminal"),
        )?;
        emit_run_error(sink, &run.id, &error, "terminal");
        return Ok(failed_run_result(run, error));
    }

    let registry = runtime_registry_snapshot();
    if let Some(error) =
        unsupported_plugin_runtime_shape(&version.definition.steps, plugins, &registry)
    {
        fail_all_steps(repository, &step_runs, RunStatus::Failed, &error)?;
        repository.finish_run_with_classification(
            &run.id,
            RunStatus::Failed,
            Some(&error),
            Some("terminal"),
        )?;
        emit_run_error(sink, &run.id, &error, "terminal");
        return Ok(failed_run_result(run, error));
    }

    let Some(plugin_step) = version
        .definition
        .steps
        .iter()
        .find(|step| plugin_owns_provider_step(step, plugins, &registry))
    else {
        let error = "Plugin runtime requires one plugin-backed provider action step.".to_string();
        fail_all_steps(repository, &step_runs, RunStatus::Failed, &error)?;
        repository.finish_run_with_classification(
            &run.id,
            RunStatus::Failed,
            Some(&error),
            Some("terminal"),
        )?;
        emit_run_error(sink, &run.id, &error, "terminal");
        return Ok(failed_run_result(run, error));
    };
    let (plugin_manifest, capability) =
        crate::plugins::plugin_for_step(plugins, &plugin_step.provider, &plugin_step.action)
            .expect("plugin step was already found");
    let Some(step_run) = step_run_for_step(&step_runs, &plugin_step.id) else {
        let error = format!("Missing step run for plugin step {}.", plugin_step.id);
        repository.finish_run_with_classification(
            &run.id,
            RunStatus::Failed,
            Some(&error),
            Some("terminal"),
        )?;
        emit_run_error(sink, &run.id, &error, "terminal");
        return Ok(failed_run_result(run, error));
    };
    let plugin_descriptor = plugin_capability_descriptor(plugin_manifest, capability);
    let resolved_plugin_inputs =
        resolve_step_input_references(&plugin_step.inputs, &step_outputs(repository, &run.id)?);
    match enforce_provider_step_policy_for_descriptor(
        repository,
        version,
        &run,
        plugin_step,
        &resolved_plugin_inputs,
        plugin_descriptor,
    )? {
        RuntimeCapabilityPolicyCheck::Allowed => {}
        RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
            return block_deterministic_provider_runtime(
                repository, run, &step_runs, blocked, sink,
            );
        }
    }

    let tool_name = format!("plugin.{}.{}", plugin_step.provider, plugin_step.action);
    let input_json = serde_json::json!({
        "plugin_id": plugin_manifest.id,
        "provider": plugin_step.provider,
        "action": plugin_step.action,
        "inputs": plugin_step.inputs,
        "permissions": plugin_step.permissions,
        "command": capability.execution.command,
        "args": capability.execution.args,
    });
    let tool_event = AgentToolEvent {
        id: format!("agent-tool-event-{}", Uuid::new_v4()),
        workflow_run_id: run.id.clone(),
        step_id: plugin_step.id.clone(),
        tool_id: tool_name.clone(),
        status: AgentToolEventStatus::Requested,
        input_json: input_json.clone(),
        output_json: None,
        error: None,
        created_at: timestamp(),
        completed_at: None,
    };
    if let Err(error) = repository.insert_agent_tool_event(&tool_event) {
        let error = sanitize_agent_text(&error.to_string());
        fail_all_steps(repository, &step_runs, RunStatus::Failed, &error)?;
        repository.finish_run_with_classification(
            &run.id,
            RunStatus::Failed,
            Some(&error),
            Some("terminal"),
        )?;
        emit_run_error(sink, &run.id, &error, "terminal");
        return Ok(failed_run_result(run, error));
    }

    emit_step_started(sink, &run.id, plugin_step);
    sink.emit(AgentEvent::ToolCallStart {
        run_id: run.id.clone(),
        step_id: plugin_step.id.clone(),
        tool_call_id: tool_event.id.clone(),
        tool_name: tool_name.clone(),
        args: input_json.clone(),
    });
    let payload = serde_json::json!({
        "workflow_id": version.workflow_id,
        "workflow_version": version.version,
        "run_id": run.id,
        "step_id": plugin_step.id,
        "provider": plugin_step.provider,
        "action": plugin_step.action,
        "inputs": plugin_step.inputs,
        "permissions": plugin_step.permissions,
        "prior_step_outputs": step_outputs(repository, &run.id)?,
    });
    let output = match execute_plugin_step(plugin_manifest, capability, payload) {
        Ok(output) => output,
        Err(error) => {
            let error = sanitize_agent_text(&error);
            sink.emit(AgentEvent::ToolCallEnd {
                run_id: run.id.clone(),
                step_id: plugin_step.id.clone(),
                tool_name,
                result: error.clone(),
                duration_ms: 0,
            });
            let _ = repository.complete_agent_tool_event(
                &tool_event.id,
                AgentToolEventStatus::Failed,
                None,
                Some(&error),
            );
            repository.fail_step(&step_run.id, RunStatus::Failed, &error)?;
            fail_dependent_steps(
                repository,
                &step_runs,
                &plugin_step.id,
                RunStatus::Failed,
                &error,
            )?;
            repository.finish_run_with_classification(
                &run.id,
                RunStatus::Failed,
                Some(&error),
                Some("terminal"),
            )?;
            emit_run_error(sink, &run.id, &error, "terminal");
            return Ok(failed_run_result(run, error));
        }
    };

    let output = sanitize_plugin_output(output);
    let plugin_step_output = serde_json::json!({
        "artifact": output.content_markdown,
        "title": output.title,
        "content_markdown": output.content_markdown,
        "metadata": output.metadata,
        "source_refs": output.source_refs,
        "tool_trace": output.tool_trace,
        "raw_result_json": output.raw_result_json,
    });
    repository.finish_step(&step_run.id, plugin_step_output.clone())?;
    emit_step_finished(sink, &run.id, &plugin_step.id, None, None);
    repository.complete_agent_tool_event(
        &tool_event.id,
        AgentToolEventStatus::Succeeded,
        Some(serde_json::json!({
            "title": output.title,
            "content_markdown": output.content_markdown,
            "tool_trace": output.tool_trace,
        })),
        None,
    )?;
    sink.emit(AgentEvent::ToolCallEnd {
        run_id: run.id.clone(),
        step_id: plugin_step.id.clone(),
        tool_name,
        result: output.title.clone(),
        duration_ms: 0,
    });
    emit_tool_trace_events(sink, &run.id, &plugin_step.id, &output.tool_trace);
    sink.emit(AgentEvent::TextMessageContent {
        run_id: run.id.clone(),
        step_id: plugin_step.id.clone(),
        content: output.content_markdown.clone(),
    });

    let artifact_id = format!("artifact-{}", Uuid::new_v4());
    let (content_path, metadata_path) = repository.artifact_paths(&artifact_id);
    let artifact = Artifact {
        id: artifact_id,
        title: output.title.clone(),
        artifact_type: "plugin_artifact".into(),
        workflow_run_id: run.id.clone(),
        content_path,
        metadata_path,
        content_markdown: output.content_markdown.clone(),
        metadata: merge_artifact_metadata(
            merge_plugin_metadata(output.metadata.clone(), plugin_manifest, plugin_step),
            &version.workflow_id,
            version.version,
            &version.definition.defaults.destination_ref,
        ),
        source_refs: output.source_refs.clone(),
        created_at: timestamp(),
    };
    let artifact_write_step =
        artifact_persistence_policy_step(&version.definition.steps, &plugin_step.id);
    let artifact_write_inputs = add_artifact_write_paths_to_inputs(
        resolve_step_input_references(
            &artifact_write_step.inputs,
            &step_outputs(repository, &run.id)?,
        ),
        &artifact.content_path,
        &artifact.metadata_path,
    );
    match enforce_provider_step_policy(
        repository,
        version,
        &run,
        &artifact_write_step,
        &artifact_write_inputs,
        &runtime_registry_snapshot(),
    )? {
        RuntimeCapabilityPolicyCheck::Allowed => {}
        RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
            return block_deterministic_provider_runtime(
                repository, run, &step_runs, blocked, sink,
            );
        }
    }

    repository.write_artifact(&artifact)?;
    auto_export_to_destination(
        repository,
        &artifact.id,
        &version.definition.defaults.destination_ref,
    );

    if let Some(sink_step_run) =
        local_app_write_artifact_step_run(&version.definition.steps, &step_runs)
    {
        let sink_step_id = sink_step_run.step_id.clone();
        emit_step_started_for_id(sink, &run.id, &version.definition.steps, &sink_step_id);
        repository.finish_step(
            &sink_step_run.id,
            serde_json::json!({
                "content_path": artifact.content_path,
                "metadata_path": artifact.metadata_path
            }),
        )?;
        emit_step_finished(sink, &run.id, &sink_step_id, None, None);
    }
    repository.finish_run(&run.id, RunStatus::Succeeded, None)?;
    sink.emit(AgentEvent::RunFinished {
        run_id: run.id.clone(),
        artifact_id: Some(artifact.id.clone()),
        duration_ms: 0,
        token_count: None,
        estimated_cost_usd: None,
    });

    Ok(WorkflowRunResult {
        run: finalized_run(repository, &run, RunStatus::Succeeded, None, None)?,
        artifact: Some(artifact),
        duplicate: false,
    })
}

fn finalized_run(
    repository: &Repository,
    run: &WorkflowRun,
    status: RunStatus,
    total_tokens: Option<i64>,
    total_cost_usd: Option<f64>,
) -> Result<WorkflowRun, RuntimeError> {
    Ok(repository
        .workflow_run(&run.id)?
        .unwrap_or_else(|| WorkflowRun {
            status,
            completed_at: Some(timestamp()),
            failure_reason: None,
            blocked_reason: None,
            required_provider_id: None,
            required_profile_id: None,
            setup_action: None,
            total_tokens,
            input_tokens: None,
            output_tokens: None,
            total_cost_usd,
            ..run.clone()
        }))
}

fn validate_approved_plugin_capability_signature(
    repository: &Repository,
    run_id: &str,
    version: &WorkflowVersion,
    plugins: &[crate::plugins::PluginManifest],
) -> Result<(), String> {
    let Some(approval) = repository
        .approved_approval_for_run(run_id)
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    let payload = approval_payload_value(&approval).map_err(|error| error.to_string())?;
    let runtime_kind = payload
        .get("runtime_kind")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if runtime_kind != "plugin" {
        return Ok(());
    }
    let approved_signature = payload
        .get("policy")
        .and_then(|policy| policy.get("definition_signature"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| "approved plugin capability signature mismatch".to_string())?;
    if !payload
        .get("plugin_capabilities")
        .and_then(|value| value.as_array())
        .is_some_and(|capabilities| !capabilities.is_empty())
    {
        return Err("approved plugin capability signature mismatch".into());
    }
    let plugin_capabilities = plugin_capability_snapshots(&version.definition, plugins);
    let current_signature =
        approval_signature_with_plugin_capabilities(version, &plugin_capabilities);
    if current_signature != approved_signature {
        return Err("approved plugin capability signature mismatch".into());
    }
    Ok(())
}

fn workflow_has_plugin_step(
    workflow: &RavenWorkflow,
    plugins: &[crate::plugins::PluginManifest],
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
) -> bool {
    workflow
        .steps
        .iter()
        .any(|step| plugin_owns_provider_step(step, plugins, registry))
}

fn unsupported_plugin_runtime_shape(
    steps: &[WorkflowStepDefinition],
    plugins: &[crate::plugins::PluginManifest],
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
) -> Option<String> {
    let plugin_steps = steps
        .iter()
        .filter(|step| plugin_owns_provider_step(step, plugins, registry))
        .collect::<Vec<_>>();
    if plugin_steps.len() != 1 {
        return Some(
            "Plugin runtime supports exactly one plugin-backed provider action step.".into(),
        );
    }
    let plugin_step = plugin_steps[0];
    let sinks = steps
        .iter()
        .filter(|step| {
            step.kind == crate::models::WorkflowStepKind::ProviderAction
                && step.provider == "local_app"
                && step.action == "write_artifact"
        })
        .collect::<Vec<_>>();
    if steps.len() != 1 + sinks.len() || sinks.len() > 1 {
        return Some(
            "Plugin runtime supports one plugin step plus optional local_app.write_artifact sink."
                .into(),
        );
    }
    if let Some(sink) = sinks.first() {
        let expected_artifact = format!("$steps.{}.artifact", plugin_step.id);
        if sink.depends_on != vec![plugin_step.id.clone()]
            || sink
                .inputs
                .get("artifact")
                .and_then(serde_json::Value::as_str)
                != Some(expected_artifact.as_str())
        {
            return Some(format!(
                "Plugin runtime sink {} must depend on {} and reference {}.",
                sink.id, plugin_step.id, expected_artifact
            ));
        }
    }
    None
}

fn runtime_registry_snapshot() -> crate::capability_registry::CapabilityRegistrySnapshot {
    crate::capability_registry::builtin_registry_snapshot()
}

fn plugin_owns_provider_step(
    step: &WorkflowStepDefinition,
    plugins: &[crate::plugins::PluginManifest],
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
) -> bool {
    step.kind == crate::models::WorkflowStepKind::ProviderAction
        && !registry_or_static_provider_action_owns(step, registry)
        && crate::plugins::plugin_for_step(plugins, &step.provider, &step.action).is_some()
}

fn registry_or_static_provider_action_owns(
    step: &WorkflowStepDefinition,
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
) -> bool {
    registry_capability_for_step(step, registry).is_some()
        || crate::capabilities::capability_for(&step.provider, &step.action).is_some()
}

fn registry_capability_for_step<'a>(
    step: &WorkflowStepDefinition,
    registry: &'a crate::capability_registry::CapabilityRegistrySnapshot,
) -> Option<&'a CapabilityDescriptor> {
    if step.kind != crate::models::WorkflowStepKind::ProviderAction {
        return None;
    }
    registry
        .capabilities
        .iter()
        .find(|capability| capability.provider == step.provider && capability.action == step.action)
}

pub(crate) fn runtime_capability_descriptor_for_step(
    step: &WorkflowStepDefinition,
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
) -> Option<CapabilityDescriptor> {
    registry_capability_for_step(step, registry)
        .cloned()
        .or_else(|| {
            crate::capabilities::capability_for(&step.provider, &step.action)
                .map(crate::capability_registry::descriptor_from_static_capability)
        })
        .or_else(|| legacy_llm_generator_capability_descriptor(step))
}

pub(crate) fn plugin_capability_descriptor(
    manifest: &crate::plugins::PluginManifest,
    capability: &crate::plugins::PluginStepDefinition,
) -> CapabilityDescriptor {
    let mut descriptor = CapabilityDescriptor {
        id: format!("{}.{}", capability.provider, capability.action),
        provider: capability.provider.clone(),
        action: capability.action.clone(),
        display_name: capability.display_name.clone(),
        description: manifest.description.clone(),
        category: "plugin".into(),
        source: CapabilitySource::Plugin,
        detected_from: Some(manifest.id.clone()),
        raw_tool_id: None,
        version: Some(manifest.version.clone()),
        status: CapabilityAvailability::Available,
        execution_mode: crate::capabilities::ExecutionMode::OpenAgentic,
        deterministic: false,
        read_only: false,
        idempotent: false,
        destructive: capability.permissions.iter().any(|permission| {
            permission.contains(":write")
                || permission.contains(":delete")
                || permission.contains(":publish")
        }),
        open_world: true,
        requires_network: capability
            .permissions
            .iter()
            .any(|permission| permission.contains("network:")),
        writes_files: capability
            .permissions
            .iter()
            .any(|permission| permission.contains(":write")),
        requires_credentials: capability
            .permissions
            .iter()
            .any(|permission| permission.contains("credential") || permission.contains("auth")),
        permissions: capability.permissions.clone(),
        intent_tags: vec!["plugin".into(), manifest.id.clone()],
        operation_tags: vec![],
        best_for: vec![capability.display_name.clone()],
        not_for: vec![],
        builder_guidance:
            "Use this plugin capability only when the workflow explicitly selects it.".into(),
        fallback_strategy: "Request an approval grant or choose a registered built-in capability."
            .into(),
        input_schema: capability.input_schema.clone(),
        output_schema: capability.output_schema.clone(),
        trust_tier: CapabilityTrustTier::Unknown,
        default_approval: CapabilityDefaultApproval::AlwaysReview,
        adapter: CapabilityAdapter::Plugin {
            plugin_id: manifest.id.clone(),
            step_action: capability.action.clone(),
            timeout_ms: capability.execution.timeout_ms.unwrap_or(10_000),
        },
        signature_hash: String::new(),
        last_checked_at: None,
    };
    descriptor.signature_hash = crate::capability_registry::capability_signature_hash(&descriptor);
    descriptor
}

fn legacy_llm_generator_capability_descriptor(
    step: &WorkflowStepDefinition,
) -> Option<CapabilityDescriptor> {
    if !is_legacy_llm_generator_provider_step(step) {
        return None;
    }
    Some(crate::capability_registry::legacy_openai_generate_artifact_descriptor())
}

fn capability_id_for_step(step: &WorkflowStepDefinition) -> String {
    format!("{}.{}", step.provider, step.action)
}

fn is_legacy_llm_generator_provider_step(step: &WorkflowStepDefinition) -> bool {
    step.kind == crate::models::WorkflowStepKind::ProviderAction
        && step.provider == "openai"
        && step.action == "generate_artifact"
}

fn unregistered_provider_action_step<'a>(
    workflow: &'a RavenWorkflow,
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
    plugins: &[crate::plugins::PluginManifest],
) -> Option<&'a WorkflowStepDefinition> {
    workflow.steps.iter().find(|step| {
        step.kind == crate::models::WorkflowStepKind::ProviderAction
            && !is_legacy_llm_generator_provider_step(step)
            && !registry_or_static_provider_action_owns(step, registry)
            && !plugin_owns_provider_step(step, plugins, registry)
    })
}

struct PluginStepOutput {
    title: String,
    content_markdown: String,
    metadata: serde_json::Value,
    source_refs: Vec<String>,
    tool_trace: Vec<ToolTraceEntry>,
    raw_result_json: serde_json::Value,
}

fn execute_plugin_step(
    manifest: &crate::plugins::PluginManifest,
    capability: &crate::plugins::PluginStepDefinition,
    payload: serde_json::Value,
) -> Result<PluginStepOutput, String> {
    let plugin_dir = manifest
        .plugin_dir
        .as_ref()
        .ok_or_else(|| format!("Plugin {} is missing its install directory.", manifest.id))?;
    let command = plugin_dir.join(&capability.execution.command);
    let mut command = Command::new(&command);
    command
        .args(&capability.execution.args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin")
        .envs(&capability.execution.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_plugin_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Plugin command failed to start: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|error| format!("Plugin command input failed: {error}"))?;
    }
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || read_limited(&mut stdout, 1_048_576));
    let stderr_reader = std::thread::spawn(move || read_limited(&mut stderr, 65_536));
    let timeout = Duration::from_millis(capability.execution.timeout_ms.unwrap_or(10_000));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > timeout => {
                terminate_plugin_process(&mut child);
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("Plugin command timed out.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(error) => return Err(format!("Plugin command wait failed: {error}")),
        }
    };
    let stdout = stdout_reader
        .join()
        .unwrap_or_else(|_| Err("Plugin stdout reader failed.".into()))?;
    let stderr = stderr_reader
        .join()
        .unwrap_or_else(|_| Err("Plugin stderr reader failed.".into()))?;
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        return Err(format!(
            "Plugin command exited with status {}{}",
            status,
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", stderr.trim())
            }
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(&stdout)
        .map_err(|error| format!("Plugin command returned invalid JSON: {error}"))?;
    plugin_output_from_value(value)
}

#[cfg(unix)]
fn configure_plugin_command(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            if setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_plugin_command(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_plugin_process(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        let _ = kill(-pid, SIGTERM);
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(200) {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    unsafe {
        let _ = kill(-pid, SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(not(unix))]
fn terminate_plugin_process(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn read_limited(pipe: &mut Option<impl Read>, max_bytes: usize) -> Result<Vec<u8>, String> {
    let Some(pipe) = pipe.as_mut() else {
        return Ok(vec![]);
    };
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = pipe
            .read(&mut buffer)
            .map_err(|error| format!("Plugin output read failed: {error}"))?;
        if read == 0 {
            break;
        }
        if output.len() + read > max_bytes {
            return Err("Plugin output exceeded the configured limit.".into());
        }
        output.extend_from_slice(&buffer[..read]);
    }
    Ok(output)
}

fn plugin_output_from_value(value: serde_json::Value) -> Result<PluginStepOutput, String> {
    let title = value
        .get("title")
        .and_then(serde_json::Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .ok_or_else(|| "Plugin output must include non-empty title.".to_string())?
        .to_string();
    let content_markdown = value
        .get("content_markdown")
        .and_then(serde_json::Value::as_str)
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| "Plugin output must include non-empty content_markdown.".to_string())?
        .to_string();
    let metadata = value
        .get("metadata")
        .cloned()
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    let source_refs = value
        .get("source_refs")
        .and_then(serde_json::Value::as_array)
        .map(|refs| {
            refs.iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default();
    let tool_trace = value
        .get("tool_trace")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("Plugin output tool_trace is invalid: {error}"))?
        .unwrap_or_default();
    let raw_result_json = value
        .get("raw_result_json")
        .cloned()
        .unwrap_or_else(|| value.clone());
    Ok(PluginStepOutput {
        title,
        content_markdown,
        metadata,
        source_refs,
        tool_trace,
        raw_result_json,
    })
}

fn sanitize_plugin_output(output: PluginStepOutput) -> PluginStepOutput {
    PluginStepOutput {
        title: sanitize_agent_text(&output.title),
        content_markdown: sanitize_agent_text(&output.content_markdown),
        metadata: sanitize_agent_json(output.metadata),
        source_refs: output
            .source_refs
            .iter()
            .map(|source_ref| sanitize_agent_text(source_ref))
            .collect(),
        tool_trace: output
            .tool_trace
            .iter()
            .map(sanitize_tool_trace_entry)
            .collect(),
        raw_result_json: sanitize_agent_json(output.raw_result_json),
    }
}

fn merge_plugin_metadata(
    mut metadata: serde_json::Value,
    manifest: &crate::plugins::PluginManifest,
    step: &WorkflowStepDefinition,
) -> serde_json::Value {
    let object = metadata
        .as_object_mut()
        .expect("plugin metadata must be a JSON object");
    object.insert(
        "plugin".into(),
        serde_json::json!({
            "id": manifest.id,
            "name": manifest.name,
            "version": manifest.version,
            "provider": step.provider,
            "action": step.action,
        }),
    );
    metadata
}

fn step_outputs(repository: &Repository, run_id: &str) -> Result<serde_json::Value, RuntimeError> {
    let mut outputs = serde_json::Map::new();
    for step in repository.workflow_step_runs_for_run(run_id)? {
        if let Some(output) = step.output_json {
            outputs.insert(step.step_id, output);
        }
    }
    Ok(serde_json::Value::Object(outputs))
}

fn fail_dependent_steps(
    repository: &Repository,
    step_runs: &[WorkflowStepRun],
    failed_step_id: &str,
    status: RunStatus,
    error: &str,
) -> Result<(), RuntimeError> {
    for step_run in step_runs
        .iter()
        .filter(|step_run| step_run.step_id != failed_step_id)
    {
        repository.fail_step(&step_run.id, status.clone(), error)?;
    }
    Ok(())
}

fn failed_run_result(run: WorkflowRun, error: String) -> WorkflowRunResult {
    WorkflowRunResult {
        run: WorkflowRun {
            status: RunStatus::Failed,
            completed_at: Some(timestamp()),
            failure_reason: Some(error),
            error_classification: Some("terminal".into()),
            ..run
        },
        artifact: None,
        duplicate: false,
    }
}

fn objective(step: &WorkflowStepDefinition) -> String {
    step.inputs
        .get("objective")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string()
}

fn allowed_tools(step: &WorkflowStepDefinition) -> Vec<String> {
    step.inputs
        .get("allowed_tools")
        .and_then(|value| value.as_array())
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn maybe_pause_for_approval(
    repository: &mut Repository,
    version: &WorkflowVersion,
    run: &WorkflowRun,
    step_runs: &[WorkflowStepRun],
    runtime_kind: &str,
) -> Result<Option<WorkflowRunResult>, RuntimeError> {
    maybe_pause_for_approval_with_event_sink(
        repository,
        version,
        run,
        step_runs,
        runtime_kind,
        &NoopRuntimeEventSink,
    )
}

pub(crate) fn maybe_pause_for_approval_with_event_sink(
    repository: &mut Repository,
    version: &WorkflowVersion,
    run: &WorkflowRun,
    step_runs: &[WorkflowStepRun],
    runtime_kind: &str,
    sink: &dyn RuntimeEventSink,
) -> Result<Option<WorkflowRunResult>, RuntimeError> {
    maybe_pause_for_approval_with_plugin_capabilities(
        repository,
        version,
        run,
        step_runs,
        runtime_kind,
        None,
        sink,
    )
}

fn maybe_pause_for_approval_with_plugin_capabilities(
    repository: &mut Repository,
    version: &WorkflowVersion,
    run: &WorkflowRun,
    step_runs: &[WorkflowStepRun],
    runtime_kind: &str,
    plugins: Option<&[crate::plugins::PluginManifest]>,
    sink: &dyn RuntimeEventSink,
) -> Result<Option<WorkflowRunResult>, RuntimeError> {
    let action_steps = approval_relevant_steps(&version.definition.steps);
    if action_steps.is_empty() {
        return Ok(None);
    }

    let approval_mode = version.approval_mode.as_deref().unwrap_or("auto_approve");
    let definition_signature = approval_signature(version);
    let plugin_capabilities = plugins
        .map(|plugins| plugin_capability_snapshots(&version.definition, plugins))
        .unwrap_or_default();
    let signature = approval_signature_with_plugin_capabilities(version, &plugin_capabilities);
    let is_high_risk = action_steps.iter().any(|step| is_explicit_high_risk(step));
    let policy_reason = match approval_mode {
        "auto_approve" if is_high_risk => {
            Some("Workflow includes an explicitly high-risk action.".to_string())
        }
        "auto_approve" => None,
        "review_changes" => {
            let last_signature =
                repository.last_approved_workflow_signature(&version.workflow_id)?;
            if last_signature.as_deref() == Some(signature.as_str()) {
                None
            } else {
                Some("Workflow definition, provider, or tool permissions changed since the last approved run.".to_string())
            }
        }
        _ => Some("Workflow approval mode requires review before runtime actions.".to_string()),
    };

    let Some(policy_reason) = policy_reason else {
        return Ok(None);
    };

    if let Some(existing) = repository.pending_approval_for_run(&run.id)? {
        fail_all_steps(
            repository,
            step_runs,
            RunStatus::Blocked,
            &existing.description,
        )?;
        emit_interrupt(sink, &existing);
        return Ok(Some(blocked_result_for_approval(run, &existing)));
    }

    let now = timestamp();
    let first_step = action_steps
        .first()
        .map(|step| step.id.clone())
        .or_else(|| step_runs.first().map(|step| step.step_id.clone()))
        .unwrap_or_else(|| "runtime".into());
    let risk_level = if is_high_risk { "high" } else { "normal" };
    let payload = approval_payload(
        version,
        run,
        runtime_kind,
        approval_mode,
        &signature,
        &definition_signature,
        &policy_reason,
        &action_steps,
        &plugin_capabilities,
    );
    let approval = PendingApproval {
        id: format!("approval-{}", Uuid::new_v4()),
        run_id: run.id.clone(),
        step_id: first_step,
        workflow_name: run.workflow_name.clone(),
        description: policy_reason.clone(),
        risk_level: risk_level.into(),
        payload_json: Some(payload.to_string()),
        status: "pending".into(),
        created_at: now,
        resolved_at: None,
        decision_reason: None,
        payload_at_decision: None,
    };
    repository.insert_pending_approval(&approval)?;
    emit_interrupt(sink, &approval);
    repository.block_run(
        &run.id,
        &policy_reason,
        "approval",
        &approval.id,
        "Approve or reject the pending runtime action.",
    )?;
    fail_all_steps(repository, step_runs, RunStatus::Blocked, &policy_reason)?;
    Ok(Some(blocked_result_for_approval(run, &approval)))
}

fn blocked_result_for_approval(run: &WorkflowRun, approval: &PendingApproval) -> WorkflowRunResult {
    WorkflowRunResult {
        run: WorkflowRun {
            status: RunStatus::Blocked,
            completed_at: Some(timestamp()),
            failure_reason: Some(approval.description.clone()),
            error_classification: Some("terminal".into()),
            blocked_reason: Some(approval.description.clone()),
            required_provider_id: Some("approval".into()),
            required_profile_id: Some(approval.id.clone()),
            setup_action: Some("Approve or reject the pending runtime action.".into()),
            ..run.clone()
        },
        artifact: None,
        duplicate: false,
    }
}

fn approval_relevant_steps(steps: &[WorkflowStepDefinition]) -> Vec<WorkflowStepDefinition> {
    steps
        .iter()
        .filter(|step| is_side_effectful_or_external(step) || is_explicit_high_risk(step))
        .cloned()
        .collect()
}

fn is_side_effectful_or_external(step: &WorkflowStepDefinition) -> bool {
    if step.provider != "local_app" {
        return true;
    }
    let action = step.action.to_lowercase();
    if ["write", "export", "send", "delete", "update", "create"]
        .iter()
        .any(|needle| action.contains(needle))
    {
        return true;
    }
    step.permissions.iter().any(|permission| {
        let permission = permission.to_lowercase();
        permission.contains(":write")
            || permission.contains(":delete")
            || permission.contains(":send")
            || permission.contains("network:")
            || permission.contains("llm:")
    })
}

fn is_explicit_high_risk(step: &WorkflowStepDefinition) -> bool {
    step.permissions
        .iter()
        .any(|permission| permission.eq_ignore_ascii_case("risk:high"))
        || step
            .inputs
            .get("risk_level")
            .and_then(|value| value.as_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("high"))
        || step
            .inputs
            .get("high_risk")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
}

pub(crate) fn approval_signature(version: &WorkflowVersion) -> String {
    approval_signature_with_plugin_capabilities(version, &[])
}

pub(crate) fn approval_signature_snapshot(
    version: &WorkflowVersion,
    plugins: &[crate::plugins::PluginManifest],
) -> (String, String, Vec<serde_json::Value>) {
    let definition_signature = approval_signature(version);
    let plugin_capabilities = plugin_capability_snapshots(&version.definition, plugins);
    let runtime_signature =
        approval_signature_with_plugin_capabilities(version, &plugin_capabilities);
    (definition_signature, runtime_signature, plugin_capabilities)
}

fn approval_signature_with_plugin_capabilities(
    version: &WorkflowVersion,
    plugin_capabilities: &[serde_json::Value],
) -> String {
    let mut signature_steps = version
        .definition
        .steps
        .iter()
        .map(|step| {
            serde_json::json!({
                "id": step.id,
                "kind": step.kind,
                "provider": step.provider,
                "action": step.action,
                "permissions": step.permissions,
                "llm_profile_ref": step.llm_profile_ref,
                "destination_ref": step.destination_ref,
                "allowed_tools": allowed_tools(step),
            })
        })
        .collect::<Vec<_>>();
    signature_steps.sort_by_key(|step| {
        step.get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string()
    });
    let value = serde_json::json!({
        "workflow_id": version.workflow_id,
        "definition": version.definition,
        "steps": signature_steps,
        "plugin_capabilities": plugin_capabilities,
    });
    let mut hasher = DefaultHasher::new();
    value.to_string().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn plugin_capability_snapshots(
    workflow: &RavenWorkflow,
    plugins: &[crate::plugins::PluginManifest],
) -> Vec<serde_json::Value> {
    let registry = runtime_registry_snapshot();
    let mut snapshots = workflow
        .steps
        .iter()
        .filter_map(|workflow_step| {
            if !plugin_owns_provider_step(workflow_step, plugins, &registry) {
                return None;
            }
            crate::plugins::plugin_for_step(plugins, &workflow_step.provider, &workflow_step.action)
                .map(|(manifest, capability)| {
                    let env = capability
                        .execution
                        .env
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect::<BTreeMap<_, _>>();
                    serde_json::json!({
                        "step_id": &workflow_step.id,
                        "plugin_id": &manifest.id,
                        "plugin_version": &manifest.version,
                        "kind": &capability.kind,
                        "provider": &capability.provider,
                        "action": &capability.action,
                        "display_name": &capability.display_name,
                        "permissions": &capability.permissions,
                        "input_schema": &capability.input_schema,
                        "output_schema": &capability.output_schema,
                        "execution": {
                            "command": &capability.execution.command,
                            "args": &capability.execution.args,
                            "env": env,
                            "timeout_ms": capability.execution.timeout_ms,
                        },
                    })
                })
        })
        .collect::<Vec<_>>();
    snapshots.sort_by_key(|snapshot| {
        format!(
            "{}:{}:{}:{}",
            snapshot
                .get("step_id")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            snapshot
                .get("plugin_id")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            snapshot
                .get("provider")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
            snapshot
                .get("action")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
        )
    });
    snapshots
}

fn approval_payload(
    version: &WorkflowVersion,
    run: &WorkflowRun,
    runtime_kind: &str,
    approval_mode: &str,
    signature: &str,
    definition_signature: &str,
    reason: &str,
    action_steps: &[WorkflowStepDefinition],
    plugin_capabilities: &[serde_json::Value],
) -> serde_json::Value {
    serde_json::json!({
        "schema_version": "approval-runtime.v1",
        "runtime_kind": runtime_kind,
        "workflow_id": version.workflow_id,
        "workflow_version_id": version.id,
        "workflow_version": version.version,
        "workflow_name": version.definition.name,
        "definition": version.definition,
        "run_id": run.id,
        "trigger_kind": run.trigger_kind,
        "idempotency_key": run.idempotency_key,
        "policy": {
            "approval_mode": approval_mode,
            "reason": reason,
            "definition_signature": signature,
            "workflow_definition_signature": definition_signature,
            "runtime_signature": signature,
        },
        "defaults": {
            "llm_profile_ref": version.definition.defaults.llm_profile_ref,
            "destination_ref": version.definition.defaults.destination_ref,
        },
        "actions": action_steps.iter().map(|step| serde_json::json!({
            "step_id": step.id,
            "provider": step.provider,
            "action": step.action,
            "permissions": step.permissions,
            "allowed_tools": allowed_tools(step),
            "risk_level": if is_explicit_high_risk(step) { "high" } else { "normal" },
        })).collect::<Vec<_>>(),
        "plugin_capabilities": plugin_capabilities,
    })
}

fn approval_payload_value(approval: &PendingApproval) -> Result<serde_json::Value, RuntimeError> {
    let payload_text = approval
        .payload_at_decision
        .as_deref()
        .or(approval.payload_json.as_deref())
        .ok_or_else(|| RuntimeError::InvalidApprovalPayload("missing payload".into()))?;
    serde_json::from_str(payload_text)
        .map_err(|error| RuntimeError::InvalidApprovalPayload(error.to_string()))
}

fn required_payload_string(payload: &serde_json::Value, key: &str) -> Result<String, RuntimeError> {
    payload
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| RuntimeError::InvalidApprovalPayload(format!("missing {key}")))
}

fn required_payload_i64(payload: &serde_json::Value, key: &str) -> Result<i64, RuntimeError> {
    payload
        .get(key)
        .and_then(|value| value.as_i64())
        .ok_or_else(|| RuntimeError::InvalidApprovalPayload(format!("missing {key}")))
}

pub(crate) fn approved_workflow_version_for_approval(
    repository: &Repository,
    approval: &PendingApproval,
) -> Result<WorkflowVersion, RuntimeError> {
    let payload = approval_payload_value(approval)?;
    approved_workflow_version_from_payload(repository, approval, &payload)
}

fn approved_workflow_version_for_run(
    repository: &Repository,
    run_id: &str,
) -> Result<Option<WorkflowVersion>, RuntimeError> {
    let Some(approval) = repository.approved_approval_for_run(run_id)? else {
        return Ok(None);
    };
    approved_workflow_version_for_approval(repository, &approval).map(Some)
}

fn approved_workflow_version_from_payload(
    repository: &Repository,
    approval: &PendingApproval,
    payload: &serde_json::Value,
) -> Result<WorkflowVersion, RuntimeError> {
    let payload_run_id = required_payload_string(payload, "run_id")?;
    if payload_run_id != approval.run_id {
        return Err(RuntimeError::InvalidApprovalPayload(format!(
            "run_id {} does not match approval run {}",
            payload_run_id, approval.run_id
        )));
    }
    let workflow_id = required_payload_string(payload, "workflow_id")?;
    let version_id = required_payload_string(payload, "workflow_version_id")?;
    let workflow_version = required_payload_i64(payload, "workflow_version")?;
    let approval_mode = payload
        .get("policy")
        .and_then(|policy| policy.get("approval_mode"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let mut version = if let Some(definition_value) = payload.get("definition") {
        let definition: RavenWorkflow = serde_json::from_value(definition_value.clone())
            .map_err(|error| RuntimeError::InvalidApprovalPayload(error.to_string()))?;
        WorkflowVersion {
            id: version_id.clone(),
            workflow_id: workflow_id.clone(),
            version: workflow_version,
            status: WorkflowStatus::Enabled,
            definition,
            created_at: approval.created_at.clone(),
            approval_mode,
            planner_rationale: None,
        }
    } else {
        repository
            .workflow_version_by_id(&version_id)?
            .ok_or_else(|| {
                RuntimeError::InvalidApprovalPayload(format!(
                    "approved workflow version {version_id} was not found"
                ))
            })?
    };

    if version.workflow_id != workflow_id
        || version.id != version_id
        || version.version != workflow_version
    {
        return Err(RuntimeError::InvalidApprovalPayload(
            "approved workflow version identity mismatch".into(),
        ));
    }
    if version.definition.id != workflow_id {
        return Err(RuntimeError::InvalidApprovalPayload(
            "approved definition workflow id mismatch".into(),
        ));
    }
    if let Some(signature) = payload
        .get("policy")
        .and_then(|policy| {
            policy
                .get("workflow_definition_signature")
                .or_else(|| policy.get("definition_signature"))
        })
        .and_then(|value| value.as_str())
    {
        let actual = approval_signature(&version);
        if actual != signature {
            return Err(RuntimeError::InvalidApprovalPayload(
                "approved workflow definition signature mismatch".into(),
            ));
        }
    }
    version.approval_mode = version.approval_mode.or_else(|| {
        payload
            .get("policy")
            .and_then(|policy| policy.get("approval_mode"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
    });
    Ok(version)
}

pub fn reject_approved_run(
    repository: &Repository,
    approval: &PendingApproval,
    reason: Option<&str>,
) -> Result<(), RuntimeError> {
    let message = reason
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Runtime approval was rejected.");
    let step_runs = repository.workflow_step_runs_for_run(&approval.run_id)?;
    fail_all_steps(repository, &step_runs, RunStatus::Blocked, message)?;
    repository.block_run(
        &approval.run_id,
        message,
        "approval",
        &approval.id,
        "Runtime approval was rejected.",
    )?;
    Ok(())
}

pub fn resume_approved_run(
    repository: &mut Repository,
    approval: &PendingApproval,
) -> Result<WorkflowRunResult, RuntimeError> {
    let payload = approval_payload_value(approval)?;
    let runtime_kind = payload
        .get("runtime_kind")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let version = approved_workflow_version_from_payload(repository, approval, &payload)?;
    ensure_workflow_enabled(&version)?;
    match runtime_kind {
        "weather" => {
            let run = repository
                .workflow_run(&approval.run_id)?
                .ok_or_else(|| RuntimeError::MissingRun(approval.run_id.clone()))?;
            let step_runs = repository.workflow_step_runs_for_run(&approval.run_id)?;
            continue_current_weather_run(
                repository,
                &version,
                run,
                step_runs,
                &OpenMeteoWeatherProvider::denver_default(),
            )
        }
        "llm" => {
            let run = repository
                .workflow_run(&approval.run_id)?
                .ok_or_else(|| RuntimeError::MissingRun(approval.run_id.clone()))?;
            let backend =
                live_artifact_backend(repository, &version.definition.defaults.llm_profile_ref)?
                    .map_err(|blocked| {
                        RuntimeError::InvalidApprovalPayload(format!(
                            "approved run cannot resume: {}",
                            blocked.reason
                        ))
                    })?;
            let step_runs = repository.workflow_step_runs_for_run(&approval.run_id)?;
            let workflow_id = run.workflow_id.clone();
            continue_workflow_with_generator_and_profile(
                repository,
                &workflow_id,
                &version,
                run,
                step_runs,
                &backend.generator,
                &backend.provider_id,
                &backend.model,
                &backend.effort,
                &NoopRuntimeEventSink,
            )
        }
        "agent_task" => {
            let credential_resolver =
                RuntimeAgentTaskCredentialResolver::from_repository(repository)?;
            let client = agent_task::UreqNativeAgentTaskClient;
            let executor = agent_task::NativeAgentTaskExecutor::new(&credential_resolver, &client);
            run_workflow_with_agent_executor(
                repository,
                &version.workflow_id,
                RunTrigger::ApprovedResume(approval.run_id.clone()),
                &executor,
            )
        }
        "plugin" => {
            let plugins = crate::plugins::discover_plugins();
            run_workflow_with_plugins_and_event_sink(
                repository,
                &version.workflow_id,
                RunTrigger::ApprovedResume(approval.run_id.clone()),
                &plugins,
                &NoopRuntimeEventSink,
            )
        }
        "deterministic_provider" => {
            let run = repository
                .workflow_run(&approval.run_id)?
                .ok_or_else(|| RuntimeError::MissingRun(approval.run_id.clone()))?;
            let step_runs = repository.workflow_step_runs_for_run(&approval.run_id)?;
            continue_deterministic_provider_workflow(
                repository,
                &version,
                run,
                step_runs,
                &NoopRuntimeEventSink,
            )
        }
        other => Err(RuntimeError::InvalidApprovalPayload(format!(
            "unsupported runtime kind {other}"
        ))),
    }
}

fn auto_export_to_destination(repository: &Repository, artifact_id: &str, destination_ref: &str) {
    if destination_ref != "local_app"
        && destination_ref != "local-app"
        && !destination_ref.is_empty()
    {
        if let Err(err) = repository.export_artifact_to_destination(artifact_id, destination_ref) {
            eprintln!("[raven] artifact export to {destination_ref} failed: {err}");
        }
    }
}

fn step_run_for_step<'a>(
    step_runs: &'a [WorkflowStepRun],
    step_id: &str,
) -> Option<&'a WorkflowStepRun> {
    step_runs
        .iter()
        .find(|step_run| step_run.step_id == step_id)
}

fn local_app_write_artifact_step_run<'a>(
    steps: &[WorkflowStepDefinition],
    step_runs: &'a [WorkflowStepRun],
) -> Option<&'a WorkflowStepRun> {
    let sink_step_id = steps
        .iter()
        .find(|step| {
            step.kind == crate::models::WorkflowStepKind::ProviderAction
                && step.provider == "local_app"
                && step.action == "write_artifact"
        })?
        .id
        .as_str();
    step_run_for_step(step_runs, sink_step_id)
}

fn artifact_persistence_policy_step(
    steps: &[WorkflowStepDefinition],
    depends_on_step_id: &str,
) -> WorkflowStepDefinition {
    steps
        .iter()
        .find(|step| is_local_app_write_artifact_step(step))
        .cloned()
        .unwrap_or_else(|| WorkflowStepDefinition {
            kind: crate::models::WorkflowStepKind::ProviderAction,
            id: "persist-artifact".into(),
            name: "Persist artifact".into(),
            provider: "local_app".into(),
            action: "write_artifact".into(),
            depends_on: vec![depends_on_step_id.into()],
            permissions: vec!["artifact:write".into()],
            inputs: serde_json::json!({}),
            llm_profile_ref: None,
            destination_ref: Some("local-app".into()),
            inline_code: None,
            parallel: None,
        })
}

fn workflow_has_deterministic_provider_runtime(
    steps: &[WorkflowStepDefinition],
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
) -> bool {
    let mut has_executable_step = false;
    for step in steps {
        if is_local_app_write_artifact_step(step) {
            continue;
        }
        if !is_deterministic_provider_action_step_with_registry(step, registry) {
            return false;
        }
        has_executable_step = true;
    }
    has_executable_step
}

enum RuntimeCapabilityPolicyCheck {
    Allowed,
    Blocked(BlockedRunDetails),
}

fn enforce_provider_step_policy(
    repository: &Repository,
    version: &WorkflowVersion,
    run: &WorkflowRun,
    step: &WorkflowStepDefinition,
    resolved_inputs: &Value,
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
) -> Result<RuntimeCapabilityPolicyCheck, RuntimeError> {
    if step.kind != crate::models::WorkflowStepKind::ProviderAction {
        return Ok(RuntimeCapabilityPolicyCheck::Allowed);
    }

    let capability_id = capability_id_for_step(step);
    let Some(capability) = runtime_capability_descriptor_for_step(step, registry) else {
        let reason = format!("Capability {capability_id} is unregistered and cannot run.");
        audit_capability_decision(
            repository,
            version,
            run,
            step,
            &capability_id,
            "blocked",
            &reason,
            None,
        )?;
        return Ok(RuntimeCapabilityPolicyCheck::Blocked(
            approval_blocked_details(&capability_id, reason),
        ));
    };

    enforce_provider_step_policy_for_descriptor(
        repository,
        version,
        run,
        step,
        resolved_inputs,
        capability,
    )
}

fn enforce_agent_task_policy(
    repository: &Repository,
    version: &WorkflowVersion,
    run: &WorkflowRun,
    step: &WorkflowStepDefinition,
    resolved_inputs: &Value,
) -> Result<RuntimeCapabilityPolicyCheck, RuntimeError> {
    if step.kind != crate::models::WorkflowStepKind::AgentTask {
        return Ok(RuntimeCapabilityPolicyCheck::Allowed);
    }
    let Some(capability) = agent_task_capability_descriptor() else {
        let reason = "Capability agent.run_task is unregistered and cannot run.".to_string();
        audit_capability_decision(
            repository,
            version,
            run,
            step,
            "agent.run_task",
            "blocked",
            &reason,
            None,
        )?;
        return Ok(RuntimeCapabilityPolicyCheck::Blocked(
            approval_blocked_details("agent.run_task", reason),
        ));
    };
    enforce_provider_step_policy_for_descriptor(
        repository,
        version,
        run,
        step,
        resolved_inputs,
        capability,
    )
}

fn agent_task_capability_descriptor() -> Option<CapabilityDescriptor> {
    crate::capabilities::capability_catalog()
        .into_iter()
        .find(|capability| capability.provider == "agent" && capability.action == "run_task")
        .map(crate::capability_registry::descriptor_from_static_capability)
}

fn agent_task_policy_inputs(
    step: &WorkflowStepDefinition,
    profile_id: &str,
    outputs: &Value,
) -> Value {
    let mut inputs = resolve_step_input_references(&step.inputs, outputs)
        .as_object()
        .cloned()
        .unwrap_or_default();
    inputs
        .entry("profile_ref")
        .or_insert_with(|| Value::String(profile_id.into()));
    inputs
        .entry("llm_profile_ref")
        .or_insert_with(|| Value::String(profile_id.into()));
    Value::Object(inputs)
}

fn enforce_provider_step_policy_for_descriptor(
    repository: &Repository,
    version: &WorkflowVersion,
    run: &WorkflowRun,
    step: &WorkflowStepDefinition,
    resolved_inputs: &Value,
    capability: CapabilityDescriptor,
) -> Result<RuntimeCapabilityPolicyCheck, RuntimeError> {
    let decision =
        crate::autonomy::evaluate_capability_policy(&capability, runtime_autonomy_mode(repository));
    match decision.decision {
        PolicyDecisionKind::Auto => {
            audit_capability_decision(
                repository,
                version,
                run,
                step,
                &capability.id,
                "auto",
                &decision.reason,
                None,
            )?;
            Ok(RuntimeCapabilityPolicyCheck::Allowed)
        }
        PolicyDecisionKind::NeedsGrant => {
            let matching_grants =
                active_grants_for_capability(repository, version, &capability.id)?;
            let grant_ids = grant_ids_authorizing_capability_step(
                &matching_grants,
                &capability,
                step,
                resolved_inputs,
            );
            let grant_id = grant_ids.as_deref();
            audit_capability_decision(
                repository,
                version,
                run,
                step,
                &capability.id,
                if grant_id.is_some() {
                    "allowed_with_grant"
                } else {
                    "needs_grant"
                },
                &decision.reason,
                grant_id,
            )?;
            if grant_id.is_some() {
                return Ok(RuntimeCapabilityPolicyCheck::Allowed);
            }

            let reason = if matching_grants.is_empty() {
                format!(
                    "Capability {} requires an active approval grant before runtime execution.",
                    capability.id
                )
            } else {
                format!(
                    "Capability {} requires an approval grant whose scope matches this step.",
                    capability.id
                )
            };
            Ok(RuntimeCapabilityPolicyCheck::Blocked(
                approval_blocked_details(&capability.id, reason),
            ))
        }
        PolicyDecisionKind::Blocked | PolicyDecisionKind::Hidden => {
            let decision_name = policy_decision_name(&decision.decision);
            audit_capability_decision(
                repository,
                version,
                run,
                step,
                &capability.id,
                decision_name,
                &decision.reason,
                None,
            )?;
            let reason = format!(
                "Capability {} is {decision_name}: {}",
                capability.id, decision.reason
            );
            Ok(RuntimeCapabilityPolicyCheck::Blocked(
                approval_blocked_details(&capability.id, reason),
            ))
        }
    }
}

fn runtime_autonomy_mode(repository: &Repository) -> AutonomyMode {
    repository
        .setting_json("autonomy_mode")
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or(AutonomyMode::SafeAuto)
}

fn active_grants_for_capability(
    repository: &Repository,
    version: &WorkflowVersion,
    capability_id: &str,
) -> Result<Vec<ApprovalGrant>, RuntimeError> {
    let now = Utc::now();
    Ok(repository
        .active_approval_grants_for_runtime(&version.workflow_id, version.version, capability_id)?
        .into_iter()
        .filter(|grant| {
            grant.capability_id == capability_id
                && grant.status == ApprovalGrantStatus::Active
                && grant_expires_after(grant, now)
        })
        .collect())
}

fn grant_expires_after(grant: &ApprovalGrant, now: chrono::DateTime<Utc>) -> bool {
    let Some(expires_at) = grant.expires_at.as_deref() else {
        return true;
    };
    chrono::DateTime::parse_from_rfc3339(expires_at)
        .map(|expires_at| expires_at.with_timezone(&Utc) > now)
        .unwrap_or(false)
}

#[cfg(test)]
fn grant_scope_allows_step(
    grant: &ApprovalGrant,
    capability: &CapabilityDescriptor,
    resolved_inputs: &Value,
) -> bool {
    grant_scope_allows_step_with_context(grant, capability, resolved_inputs)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GrantRequirement {
    FileWrite,
    Delete,
    Publish,
    Credential,
    Network,
    ToolExecution,
}

fn grant_ids_authorizing_capability_step(
    grants: &[ApprovalGrant],
    capability: &CapabilityDescriptor,
    step: &WorkflowStepDefinition,
    resolved_inputs: &Value,
) -> Option<String> {
    let inputs = add_step_scope_context(resolved_inputs, step);
    let requirements = grant_requirements_for_capability(capability);
    let mut grant_ids = Vec::new();
    for requirement in requirements {
        let Some(grant) = grants.iter().find(|grant| {
            grant.signature_hash == capability.signature_hash
                && grant_satisfies_requirement(grant, capability, &inputs, requirement)
        }) else {
            return None;
        };
        grant_ids.push(grant.id.clone());
    }
    grant_ids.sort();
    grant_ids.dedup();
    Some(grant_ids.join(","))
}

fn grant_requirements_for_capability(capability: &CapabilityDescriptor) -> Vec<GrantRequirement> {
    let mut requirements = Vec::new();
    if capability.writes_files {
        requirements.push(GrantRequirement::FileWrite);
    }
    if (!capability.writes_files && capability.destructive)
        || capability
            .permissions
            .iter()
            .any(|permission| permission.contains(":delete") || permission.contains(":destroy"))
    {
        requirements.push(GrantRequirement::Delete);
    }
    if capability
        .permissions
        .iter()
        .any(|permission| permission.contains(":publish") || permission.contains("publish"))
    {
        requirements.push(GrantRequirement::Publish);
    }
    if capability.requires_credentials {
        requirements.push(GrantRequirement::Credential);
    }
    if capability.requires_network
        || capability
            .permissions
            .iter()
            .any(|permission| permission.starts_with("network:"))
    {
        requirements.push(GrantRequirement::Network);
    }
    if requirements.is_empty() {
        requirements.push(GrantRequirement::ToolExecution);
    }
    requirements
}

fn grant_satisfies_requirement(
    grant: &ApprovalGrant,
    capability: &CapabilityDescriptor,
    resolved_inputs: &Value,
    requirement: GrantRequirement,
) -> bool {
    match requirement {
        GrantRequirement::FileWrite => {
            let grant_type_matches = if overwrite_requested(resolved_inputs) {
                grant.grant_type == ApprovalGrantType::FileOverwrite
            } else {
                matches!(
                    grant.grant_type,
                    ApprovalGrantType::FileWrite | ApprovalGrantType::FileOverwrite
                )
            };
            grant_type_matches
                && file_write_scope_matches(grant, resolved_inputs)
                && (!overwrite_requested(resolved_inputs)
                    || file_overwrite_size_scope_matches(grant, resolved_inputs))
        }
        GrantRequirement::Delete => {
            grant.grant_type == ApprovalGrantType::FileDelete
                && destructive_scope_matches(grant, resolved_inputs)
        }
        GrantRequirement::Publish => {
            grant.grant_type == ApprovalGrantType::ExternalPublish
                && external_publish_scope_matches(grant, resolved_inputs)
        }
        GrantRequirement::Credential => {
            grant.grant_type == ApprovalGrantType::CredentialUse
                && credential_scope_matches(grant, resolved_inputs)
        }
        GrantRequirement::Network => {
            grant.grant_type == ApprovalGrantType::NetworkAccess
                && network_scope_matches(grant, capability, resolved_inputs)
        }
        GrantRequirement::ToolExecution => {
            grant.grant_type == ApprovalGrantType::ToolExecution
                && tool_execution_scope_matches(grant, resolved_inputs)
        }
    }
}

#[cfg(test)]
fn grant_scope_allows_step_with_context(
    grant: &ApprovalGrant,
    capability: &CapabilityDescriptor,
    resolved_inputs: &Value,
) -> bool {
    let requirements = grant_requirements_for_capability(capability);
    requirements.len() == 1
        && grant.signature_hash == capability.signature_hash
        && grant_satisfies_requirement(grant, capability, resolved_inputs, requirements[0])
}

fn file_write_scope_matches(grant: &ApprovalGrant, resolved_inputs: &Value) -> bool {
    let paths = file_write_paths_from_step_inputs(resolved_inputs);
    !paths.is_empty()
        && paths
            .iter()
            .all(|path| crate::approval_grants::grant_allows_path(grant, path))
}

fn file_overwrite_size_scope_matches(grant: &ApprovalGrant, resolved_inputs: &Value) -> bool {
    let Some(max_overwrite_bytes) = grant.scope.max_overwrite_bytes.filter(|limit| *limit > 0)
    else {
        return false;
    };
    let Some(requested_bytes) = overwrite_bytes_from_step_inputs(resolved_inputs) else {
        return false;
    };
    requested_bytes > 0 && requested_bytes <= max_overwrite_bytes
}

fn destructive_scope_matches(grant: &ApprovalGrant, resolved_inputs: &Value) -> bool {
    if let Some(max_deletes) = grant.scope.max_deletes {
        let requested_deletes = requested_delete_count(resolved_inputs);
        if requested_deletes == 0 || requested_deletes > max_deletes {
            return false;
        }
    }
    let paths = delete_paths_from_step_inputs(resolved_inputs);
    if !paths.is_empty() {
        return paths
            .iter()
            .all(|path| crate::approval_grants::grant_allows_path(grant, path));
    }
    let resources = resource_ids_from_step_inputs(resolved_inputs);
    !resources.is_empty()
        && resources.iter().all(|resource| {
            grant
                .scope
                .resource_ids
                .iter()
                .any(|allowed| allowed == resource)
        })
}

fn external_publish_scope_matches(grant: &ApprovalGrant, resolved_inputs: &Value) -> bool {
    let targets = external_targets_from_step_inputs(resolved_inputs);
    !targets.is_empty()
        && targets.iter().all(|target| {
            grant
                .scope
                .external_targets
                .iter()
                .any(|allowed| allowed == target)
        })
}

fn tool_execution_scope_matches(grant: &ApprovalGrant, resolved_inputs: &Value) -> bool {
    let resources = resource_ids_from_step_inputs(resolved_inputs);
    if !resources.is_empty() {
        return resources.iter().all(|resource| {
            grant
                .scope
                .resource_ids
                .iter()
                .any(|allowed| allowed == resource)
        });
    }

    no_narrower_scope_dimension_is_derivable(resolved_inputs)
}

fn credential_scope_matches(grant: &ApprovalGrant, resolved_inputs: &Value) -> bool {
    let credential_refs = credential_refs_from_step_inputs(resolved_inputs);
    if credential_refs.is_empty() {
        return false;
    }
    if !grant.scope.resource_ids.is_empty() {
        return credential_refs.iter().all(|credential_ref| {
            grant
                .scope
                .resource_ids
                .iter()
                .any(|allowed| allowed == credential_ref)
        });
    }
    let Some(allowed_ref) = grant.scope.credential_ref.as_deref() else {
        return false;
    };
    credential_refs.len() == 1 && credential_refs[0] == allowed_ref
}

fn network_scope_matches(
    grant: &ApprovalGrant,
    capability: &CapabilityDescriptor,
    resolved_inputs: &Value,
) -> bool {
    let domains = domains_from_step_inputs(resolved_inputs);
    if !domains.is_empty() {
        return domains
            .iter()
            .all(|domain| grant_allows_domain(grant, domain));
    }
    grant
        .scope
        .resource_ids
        .iter()
        .any(|resource_id| resource_id == &capability.id)
}

fn no_narrower_scope_dimension_is_derivable(resolved_inputs: &Value) -> bool {
    file_write_paths_from_step_inputs(resolved_inputs).is_empty()
        && credential_refs_from_step_inputs(resolved_inputs).is_empty()
        && domains_from_step_inputs(resolved_inputs).is_empty()
        && resource_ids_from_step_inputs(resolved_inputs).is_empty()
        && external_targets_from_step_inputs(resolved_inputs).is_empty()
}

fn add_step_scope_context(resolved_inputs: &Value, step: &WorkflowStepDefinition) -> Value {
    let mut inputs = resolved_inputs.as_object().cloned().unwrap_or_default();
    if let Some(profile_ref) = step.llm_profile_ref.as_deref() {
        inputs
            .entry("profile_ref")
            .or_insert_with(|| Value::String(profile_ref.into()));
    }
    if let Some(destination_ref) = step.destination_ref.as_deref() {
        inputs
            .entry("destination_ref")
            .or_insert_with(|| Value::String(destination_ref.into()));
    }
    Value::Object(inputs)
}

fn file_write_paths_from_step_inputs(inputs: &Value) -> Vec<String> {
    string_values_for_keys(
        inputs,
        &[
            "path",
            "paths",
            "output_path",
            "destination_path",
            "content_path",
            "metadata_path",
        ],
    )
}

fn delete_paths_from_step_inputs(inputs: &Value) -> Vec<String> {
    let mut paths = string_values_for_keys(
        inputs,
        &["delete_path", "delete_paths", "target_path", "target_paths"],
    );
    if paths.is_empty() {
        paths = file_write_paths_from_step_inputs(inputs);
    }
    paths
}

fn credential_refs_from_step_inputs(inputs: &Value) -> Vec<String> {
    string_values_for_keys(
        inputs,
        &[
            "credential_ref",
            "credential",
            "profile_ref",
            "llm_profile_ref",
        ],
    )
}

fn resource_ids_from_step_inputs(inputs: &Value) -> Vec<String> {
    string_values_for_keys(inputs, &["resource_id", "resource_ids", "id", "ids"])
}

fn external_targets_from_step_inputs(inputs: &Value) -> Vec<String> {
    string_values_for_keys(
        inputs,
        &[
            "target",
            "targets",
            "destination",
            "destination_ref",
            "external_target",
            "external_targets",
            "target_url",
        ],
    )
}

fn domains_from_step_inputs(inputs: &Value) -> Vec<String> {
    let mut domains = Vec::new();
    collect_domains_from_keys(
        inputs,
        &[
            "url",
            "urls",
            "uri",
            "uris",
            "domain",
            "domains",
            "host",
            "hosts",
            "endpoint",
            "base_url",
            "target_url",
        ],
        &mut domains,
    );
    domains.sort();
    domains.dedup();
    domains
}

fn string_values_for_keys(value: &Value, keys: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    collect_string_values_for_keys(value, keys, &mut values);
    values.sort();
    values.dedup();
    values
}

fn collect_string_values_for_keys(value: &Value, keys: &[&str], values: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if keys.iter().any(|candidate| candidate == key) {
                    collect_strings(value, values);
                }
                collect_string_values_for_keys(value, keys, values);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_string_values_for_keys(item, keys, values);
            }
        }
        _ => {}
    }
}

fn collect_strings(value: &Value, values: &mut Vec<String>) {
    match value {
        Value::String(value) => values.push(value.clone()),
        Value::Array(items) => {
            for item in items {
                collect_strings(item, values);
            }
        }
        Value::Object(object) => {
            for value in object.values() {
                collect_strings(value, values);
            }
        }
        _ => {}
    }
}

fn overwrite_requested(inputs: &Value) -> bool {
    bool_value_for_keys(inputs, &["overwrite", "overwrites", "allow_overwrite"])
        || !string_values_for_keys(inputs, &["overwrite_path", "overwrite_paths"]).is_empty()
}

fn overwrite_bytes_from_step_inputs(inputs: &Value) -> Option<u64> {
    number_value_for_keys(
        inputs,
        &[
            "max_overwrite_bytes",
            "maxOverwriteBytes",
            "overwrite_bytes",
            "overwriteBytes",
            "content_bytes",
            "contentBytes",
            "size_bytes",
            "sizeBytes",
        ],
    )
    .or_else(|| byte_len_value_for_keys(inputs, &["content_markdown", "content", "artifact"]))
    .or_else(|| json_byte_len_value_for_keys(inputs, &["metadata"]))
}

fn requested_delete_count(inputs: &Value) -> u64 {
    max_deletes_from_step_inputs(inputs)
        .or_else(|| {
            let paths = delete_paths_from_step_inputs(inputs);
            if paths.is_empty() {
                None
            } else {
                Some(paths.len() as u64)
            }
        })
        .unwrap_or(1)
}

fn max_deletes_from_step_inputs(inputs: &Value) -> Option<u64> {
    number_value_for_keys(inputs, &["max_deletes", "maxDeletes", "delete_limit"])
}

fn bool_value_for_keys(value: &Value, keys: &[&str]) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            (keys.iter().any(|candidate| candidate == key) && value.as_bool().unwrap_or(false))
                || bool_value_for_keys(value, keys)
        }),
        Value::Array(items) => items.iter().any(|item| bool_value_for_keys(item, keys)),
        _ => false,
    }
}

fn number_value_for_keys(value: &Value, keys: &[&str]) -> Option<u64> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if keys.iter().any(|candidate| candidate == key) {
                    if let Some(number) = value.as_u64() {
                        return Some(number);
                    }
                }
                if let Some(number) = number_value_for_keys(value, keys) {
                    return Some(number);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| number_value_for_keys(item, keys)),
        _ => None,
    }
}

fn byte_len_value_for_keys(value: &Value, keys: &[&str]) -> Option<u64> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if keys.iter().any(|candidate| candidate == key) {
                    if let Some(text) = value.as_str() {
                        return Some(text.len() as u64);
                    }
                }
                if let Some(bytes) = byte_len_value_for_keys(value, keys) {
                    return Some(bytes);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| byte_len_value_for_keys(item, keys)),
        _ => None,
    }
}

fn json_byte_len_value_for_keys(value: &Value, keys: &[&str]) -> Option<u64> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if keys.iter().any(|candidate| candidate == key) {
                    return serde_json::to_vec(value)
                        .ok()
                        .map(|bytes| bytes.len() as u64);
                }
                if let Some(bytes) = json_byte_len_value_for_keys(value, keys) {
                    return Some(bytes);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| json_byte_len_value_for_keys(item, keys)),
        _ => None,
    }
}

fn collect_domains_from_keys(value: &Value, keys: &[&str], domains: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if keys.iter().any(|candidate| candidate == key) {
                    collect_domains_from_value(value, domains);
                }
                collect_domains_from_keys(value, keys, domains);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_domains_from_keys(item, keys, domains);
            }
        }
        _ => {}
    }
}

fn collect_domains_from_value(value: &Value, domains: &mut Vec<String>) {
    match value {
        Value::String(value) => {
            if let Some(domain) = domain_from_string(value) {
                domains.push(domain);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_domains_from_value(item, domains);
            }
        }
        Value::Object(object) => {
            for value in object.values() {
                collect_domains_from_value(value, domains);
            }
        }
        _ => {}
    }
}

fn domain_from_string(value: &str) -> Option<String> {
    if let Ok(url) = url::Url::parse(value) {
        return url.host_str().map(|domain| domain.to_ascii_lowercase());
    }
    if value.contains('.') && !value.contains('/') && !value.contains(' ') {
        return Some(value.to_ascii_lowercase());
    }
    None
}

fn grant_allows_domain(grant: &ApprovalGrant, domain: &str) -> bool {
    grant.scope.domains.iter().any(|allowed| {
        allowed == "*"
            || allowed.eq_ignore_ascii_case(domain)
            || allowed
                .strip_prefix("*.")
                .map(|suffix| {
                    domain.eq_ignore_ascii_case(suffix)
                        || domain
                            .to_ascii_lowercase()
                            .ends_with(&format!(".{}", suffix.to_ascii_lowercase()))
                })
                .unwrap_or(false)
    })
}

fn audit_capability_decision(
    repository: &Repository,
    version: &WorkflowVersion,
    run: &WorkflowRun,
    step: &WorkflowStepDefinition,
    capability_id: &str,
    decision: &str,
    reason: &str,
    grant_id: Option<&str>,
) -> Result<(), RuntimeError> {
    let occurred_at = timestamp();
    let allowed = matches!(decision, "allowed" | "auto" | "allowed_with_grant");
    let status = if allowed { "succeeded" } else { "blocked" };
    repository.insert_capability_audit_event(&CapabilityAuditEvent {
        id: format!("capability-audit-{}", Uuid::new_v4()),
        run_id: run.id.clone(),
        workflow_id: version.workflow_id.clone(),
        workflow_version: version.version,
        step_id: step.id.clone(),
        capability_id: capability_id.to_string(),
        decision: decision.to_string(),
        reason: reason.to_string(),
        grant_id: grant_id.map(str::to_string),
        created_at: occurred_at.clone(),
        started_at: Some(occurred_at.clone()),
        completed_at: Some(occurred_at),
        status: Some(status.into()),
        input_summary: Some(sanitize_agent_json_value(step.inputs.clone(), false)),
        output_summary: Some(serde_json::json!({
            "decision": decision,
            "grant_id": grant_id,
        })),
        error_details: (!allowed).then(|| sanitize_agent_text(reason)),
    })?;
    Ok(())
}

fn policy_decision_name(decision: &PolicyDecisionKind) -> &'static str {
    match decision {
        PolicyDecisionKind::Auto => "auto",
        PolicyDecisionKind::NeedsGrant => "needs_grant",
        PolicyDecisionKind::Blocked => "blocked",
        PolicyDecisionKind::Hidden => "hidden",
    }
}

fn approval_blocked_details(capability_id: &str, reason: String) -> BlockedRunDetails {
    BlockedRunDetails {
        reason,
        required_provider_id: "approval".into(),
        required_profile_id: capability_id.into(),
        setup_action: "Approve a scoped capability grant and retry.".into(),
    }
}

fn execute_deterministic_provider_step(
    step: &WorkflowStepDefinition,
    inputs: &Value,
) -> Result<Value, String> {
    match (step.provider.as_str(), step.action.as_str()) {
        ("http_probe", "check_urls") => crate::http_probe::config_from_inputs(inputs)
            .map(|config| crate::http_probe::check_urls(&config))
            .and_then(|output| serde_json::to_value(output).map_err(|error| error.to_string())),
        ("open_meteo", "current_weather") => {
            let provider =
                OpenMeteoWeatherProvider::from_inputs(inputs).map_err(|error| error.to_string())?;
            let snapshot = provider
                .current_weather()
                .map_err(|error| error.to_string())?;
            let artifact = weather_markdown(&snapshot);
            let mut output = serde_json::to_value(snapshot).map_err(|error| error.to_string())?;
            if let Some(object) = output.as_object_mut() {
                object.insert("artifact".into(), Value::String(artifact));
            }
            Ok(output)
        }
        ("weather", "forecast_24h") => {
            crate::weather::forecast_24h_json(inputs.clone()).map_err(|error| error.to_string())
        }
        ("weather", "hourly_forecast") => {
            crate::weather::hourly_forecast_json(inputs.clone()).map_err(|error| error.to_string())
        }
        ("weather", "alerts") => {
            crate::weather::alerts_json(inputs.clone()).map_err(|error| error.to_string())
        }
        ("news", "trending") => Ok(crate::news::trending(inputs)),
        ("news", "search") => Ok(crate::news::search(inputs)),
        ("rss", "fetch_feed") => Ok(crate::news::fetch_feed(inputs)),
        ("web", "fetch_page") => Ok(crate::web_tools::fetch_page(inputs)),
        ("web", "extract_article") => Ok(crate::web_tools::extract_article(inputs)),
        ("web", "extract_metadata") => Ok(crate::web_tools::extract_metadata(inputs)),
        ("seo", "fetch_robots_txt") => Ok(crate::seo_tools::fetch_robots_txt(inputs)),
        ("seo", "parse_robots_txt") => Ok(crate::seo_tools::parse_robots_txt(inputs)),
        ("seo", "fetch_sitemap") => Ok(crate::seo_tools::fetch_sitemap(inputs)),
        ("seo", "parse_sitemap") => Ok(crate::seo_tools::parse_sitemap(inputs)),
        ("seo", "audit_indexability") => Ok(crate::seo_tools::audit_indexability(inputs)),
        ("seo", "audit_metadata") => Ok(crate::seo_tools::audit_metadata(inputs)),
        ("seo", "extract_structured_data") => Ok(crate::seo_tools::extract_structured_data(inputs)),
        ("seo", "validate_json_ld") => Ok(crate::seo_tools::validate_json_ld(inputs)),
        ("seo", "audit_links") => Ok(crate::seo_tools::audit_links(inputs)),
        ("seo", "audit_canonical_hreflang") => {
            Ok(crate::seo_tools::audit_canonical_hreflang(inputs))
        }
        ("content", "map_search_intent") => Ok(crate::content_tools::map_search_intent(inputs)),
        ("content", "generate_brief") => Ok(crate::content_tools::generate_content_brief(inputs)),
        ("content", "identify_gaps") => Ok(crate::content_tools::identify_content_gaps(inputs)),
        ("content", "score_quality") => Ok(crate::content_tools::score_content_quality(inputs)),
        ("data", "parse_csv") => Ok(crate::local_tools::parse_csv(inputs)),
        ("data", "transform_json") => Ok(crate::local_tools::transform_json(inputs)),
        ("scheduler", "preview_next_runs") => Ok(crate::local_tools::preview_next_runs(inputs)),
        ("notification", "local") => Ok(crate::local_tools::local_notification(inputs)),
        ("mcp", "discover_tools") => Ok(crate::local_tools::discover_mcp_tools(inputs)),
        _ => Err(format!(
            "Unsupported deterministic provider step {} ({}/{}).",
            step.id, step.provider, step.action
        )),
    }
}

fn write_deterministic_artifact(
    repository: &Repository,
    version: &WorkflowVersion,
    run: &WorkflowRun,
    step: &WorkflowStepDefinition,
    inputs: &Value,
    artifact_id: String,
    content_path: String,
    metadata_path: String,
) -> Result<Artifact, RuntimeError> {
    let artifact_value = inputs.get("artifact").unwrap_or(inputs);
    let title = inputs
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| artifact_value.get("title").and_then(Value::as_str))
        .unwrap_or(&version.definition.name)
        .to_string();
    let artifact_type = inputs
        .get("artifact_type")
        .and_then(Value::as_str)
        .or_else(|| artifact_value.get("artifact_type").and_then(Value::as_str))
        .unwrap_or("workflow_artifact")
        .to_string();
    let content_markdown = artifact_value
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            artifact_value
                .get("content_markdown")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            artifact_value
                .get("artifact")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            serde_json::to_string_pretty(artifact_value)
                .unwrap_or_else(|_| artifact_value.to_string())
        });
    let metadata = artifact_value
        .get("metadata")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({ "kind": "deterministic_provider" }));
    let source_refs = artifact_value
        .get("source_refs")
        .and_then(Value::as_array)
        .map(|refs| {
            refs.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let artifact = Artifact {
        id: artifact_id,
        title,
        artifact_type,
        workflow_run_id: run.id.clone(),
        content_path,
        metadata_path,
        content_markdown,
        metadata: merge_artifact_metadata(
            metadata,
            &version.workflow_id,
            version.version,
            step.destination_ref
                .as_deref()
                .unwrap_or(&version.definition.defaults.destination_ref),
        ),
        source_refs,
        created_at: timestamp(),
    };
    repository.write_artifact(&artifact)?;
    auto_export_to_destination(
        repository,
        &artifact.id,
        step.destination_ref
            .as_deref()
            .unwrap_or(&version.definition.defaults.destination_ref),
    );
    Ok(artifact)
}

fn add_artifact_write_paths_to_inputs(
    inputs: Value,
    content_path: &str,
    metadata_path: &str,
) -> Value {
    let mut object = inputs.as_object().cloned().unwrap_or_default();
    object.insert("content_path".into(), Value::String(content_path.into()));
    object.insert("metadata_path".into(), Value::String(metadata_path.into()));
    Value::Object(object)
}

fn fail_deterministic_provider_runtime(
    repository: &Repository,
    run: WorkflowRun,
    step_runs: &[WorkflowStepRun],
    error: &str,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let error = sanitize_agent_text(error);
    fail_all_steps(repository, step_runs, RunStatus::Failed, &error)?;
    repository.finish_run_with_classification(
        &run.id,
        RunStatus::Failed,
        Some(&error),
        Some("terminal"),
    )?;
    emit_run_error(sink, &run.id, &error, "terminal");
    Ok(WorkflowRunResult {
        run: WorkflowRun {
            status: RunStatus::Failed,
            completed_at: Some(timestamp()),
            failure_reason: Some(error),
            error_classification: Some("terminal".into()),
            ..run
        },
        artifact: None,
        duplicate: false,
    })
}

fn block_deterministic_provider_runtime(
    repository: &Repository,
    run: WorkflowRun,
    step_runs: &[WorkflowStepRun],
    blocked: BlockedRunDetails,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let reason = sanitize_agent_text(&blocked.reason);
    fail_all_steps(repository, step_runs, RunStatus::Blocked, &reason)?;
    repository.block_run(
        &run.id,
        &reason,
        &blocked.required_provider_id,
        &blocked.required_profile_id,
        &blocked.setup_action,
    )?;
    emit_run_error(sink, &run.id, &reason, "terminal");
    Ok(WorkflowRunResult {
        run: WorkflowRun {
            status: RunStatus::Blocked,
            completed_at: Some(timestamp()),
            failure_reason: Some(reason.clone()),
            error_classification: Some("terminal".into()),
            blocked_reason: Some(reason),
            required_provider_id: Some(blocked.required_provider_id),
            required_profile_id: Some(blocked.required_profile_id),
            setup_action: Some(blocked.setup_action),
            ..run
        },
        artifact: None,
        duplicate: false,
    })
}

fn resolve_step_input_references(inputs: &Value, outputs: &Value) -> Value {
    match inputs {
        Value::String(value) => {
            resolve_step_reference(value, outputs).unwrap_or_else(|| Value::String(value.clone()))
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| resolve_step_input_references(value, outputs))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), resolve_step_input_references(value, outputs)))
                .collect(),
        ),
        value => value.clone(),
    }
}

fn resolve_step_reference(reference: &str, outputs: &Value) -> Option<Value> {
    let remainder = reference.strip_prefix("$steps.")?;
    let mut parts = remainder.split('.');
    let step_id = parts.next()?;
    let mut value = outputs.get(step_id)?.clone();
    for part in parts {
        value = value.get(part)?.clone();
    }
    Some(value)
}

fn insert_step_output(outputs: &mut Value, step_id: &str, output: Value) {
    if !outputs.is_object() {
        *outputs = Value::Object(serde_json::Map::new());
    }
    if let Some(object) = outputs.as_object_mut() {
        object.insert(step_id.to_string(), output);
    }
}

fn execute_agent_pre_steps(
    repository: &mut Repository,
    version: &WorkflowVersion,
    steps: &[WorkflowStepDefinition],
    run: &WorkflowRun,
    step_runs: &[WorkflowStepRun],
    agent_step: &WorkflowStepDefinition,
    sink: &dyn RuntimeEventSink,
) -> Result<Option<WorkflowRunResult>, RuntimeError> {
    let mut outputs = step_outputs(repository, &run.id)?;
    let registry = runtime_registry_snapshot();
    for step in steps.iter().take_while(|step| step.id != agent_step.id) {
        if !is_deterministic_provider_action_step_with_registry(step, &registry) {
            continue;
        }
        let Some(step_run) = step_run_for_step(step_runs, &step.id) else {
            let error = format!("Missing step run for deterministic step {}.", step.id);
            return fail_agent_runtime_before_executor(
                repository,
                run.clone(),
                step_runs,
                &error,
                sink,
            )
            .map(Some);
        };
        if step_run.status == RunStatus::Succeeded && step_run.output_json.is_some() {
            continue;
        }

        emit_step_started(sink, &run.id, step);
        let resolved_inputs = resolve_step_input_references(&step.inputs, &outputs);
        match enforce_provider_step_policy(
            repository,
            version,
            run,
            step,
            &resolved_inputs,
            &registry,
        )? {
            RuntimeCapabilityPolicyCheck::Allowed => {}
            RuntimeCapabilityPolicyCheck::Blocked(blocked) => {
                return block_agent_runtime_before_executor(
                    repository,
                    run.clone(),
                    step_runs,
                    blocked,
                    sink,
                )
                .map(Some);
            }
        }
        let output_json = match execute_deterministic_provider_step(step, &resolved_inputs) {
            Ok(output_json) => output_json,
            Err(error) => {
                return fail_agent_runtime_before_executor(
                    repository,
                    run.clone(),
                    step_runs,
                    &error,
                    sink,
                )
                .map(Some);
            }
        };
        if let Err(error) = repository.finish_step(&step_run.id, output_json.clone()) {
            return fail_agent_runtime_before_executor(
                repository,
                run.clone(),
                step_runs,
                &error.to_string(),
                sink,
            )
            .map(Some);
        }
        insert_step_output(&mut outputs, &step.id, output_json.clone());
        emit_step_finished(sink, &run.id, &step.id, None, None);
    }
    Ok(None)
}

fn tool_manifest_hash(manifest: &[agent_task::ToolDescriptor]) -> String {
    let manifest_json = serde_json::to_string(manifest).unwrap_or_else(|_| "[]".to_string());
    let mut hasher = DefaultHasher::new();
    manifest_json.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn classify_agent_task_error(error: &AgentTaskError) -> (RunStatus, &'static str) {
    match error {
        AgentTaskError::ExecutionFailed(message)
            if message.contains("429")
                || message.to_lowercase().contains("rate limit")
                || message.to_lowercase().contains("timeout")
                || message.contains("500")
                || message.contains("502")
                || message.contains("503")
                || message.contains("504")
                || message.to_lowercase().contains("unavailable") =>
        {
            (RunStatus::Retryable, "retryable")
        }
        AgentTaskError::ExecutionFailed(_) => (RunStatus::Retryable, "retryable"),
        AgentTaskError::UnknownToolClass(_) | AgentTaskError::MalformedOutput(_) => {
            (RunStatus::Failed, "terminal")
        }
    }
}

fn is_local_oauth_auth_error(profile: &agent_auth::AgentAuthProfile, error: &str) -> bool {
    if !matches!(
        profile.auth_mode,
        agent_auth::AgentAuthMode::CodexOauthLocalCli
            | agent_auth::AgentAuthMode::ClaudeCodeOauthLocalCli
    ) {
        return false;
    }

    let normalized = error.to_lowercase();
    [
        "not logged in",
        "not signed in",
        "authentication required",
        "login required",
        "no auth token",
        "no authentication token",
        "missing auth token",
        "oauth token",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn agent_auth_error_blocked_details(
    profile: &agent_auth::AgentAuthProfile,
    error: &str,
) -> BlockedRunDetails {
    let reason = sanitize_agent_text(error);
    BlockedRunDetails {
        reason,
        required_provider_id: "agent".into(),
        required_profile_id: profile.id.clone(),
        setup_action: format!("Sign in to {} and retry.", profile.display_name),
    }
}

fn agent_blocked_details(profile_id: &str) -> BlockedRunDetails {
    BlockedRunDetails {
        reason: format!("Agent profile {profile_id} is unavailable or missing."),
        required_provider_id: "agent".into(),
        required_profile_id: profile_id.into(),
        setup_action: "Configure an available agent profile in Settings.".into(),
    }
}

fn agent_profile_unavailable_details(profile: &agent_auth::AgentAuthProfile) -> BlockedRunDetails {
    BlockedRunDetails {
        reason: format!("Agent profile {} is {}.", profile.id, profile.status),
        required_provider_id: "agent".into(),
        required_profile_id: profile.id.clone(),
        setup_action: format!("Configure {} in Settings.", profile.display_name),
    }
}

fn is_native_api_auth_error(profile: &agent_auth::AgentAuthProfile, error: &str) -> bool {
    if !matches!(
        profile.runner_kind,
        agent_auth::AgentRunnerKind::OpenAiApi | agent_auth::AgentRunnerKind::AnthropicApi
    ) {
        return false;
    }
    let normalized = error.to_lowercase();
    normalized.contains("credential is required") || normalized.contains("missing credential")
}

fn native_agent_auth_error_blocked_details(
    profile: &agent_auth::AgentAuthProfile,
    error: &str,
) -> BlockedRunDetails {
    let provider_id = match profile.runner_kind {
        agent_auth::AgentRunnerKind::AnthropicApi => "anthropic",
        agent_auth::AgentRunnerKind::OpenAiApi => "openai",
        _ => "agent",
    };
    let provider_name = match provider_id {
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        _ => "Agent",
    };
    BlockedRunDetails {
        reason: sanitize_agent_text(error),
        required_provider_id: provider_id.into(),
        required_profile_id: profile.id.clone(),
        setup_action: format!("Configure the {provider_name} API key in Settings."),
    }
}

fn unsupported_agent_runtime_shape(steps: &[WorkflowStepDefinition]) -> Option<String> {
    let agent_task_count = steps
        .iter()
        .filter(|step| step.kind == crate::models::WorkflowStepKind::AgentTask)
        .count();
    if agent_task_count != 1 {
        return Some("Agent runtime supports exactly one agent_task step.".into());
    }

    let write_artifact_count = steps
        .iter()
        .filter(|step| {
            step.kind == crate::models::WorkflowStepKind::ProviderAction
                && step.provider == "local_app"
                && step.action == "write_artifact"
        })
        .count();
    if write_artifact_count > 1 {
        return Some("Agent runtime supports at most one local_app write_artifact step.".into());
    }

    let agent_index = steps
        .iter()
        .position(|step| step.kind == crate::models::WorkflowStepKind::AgentTask)
        .expect("agent task count was already validated");
    let unsupported = steps.iter().enumerate().find(|(index, step)| {
        if step.kind == crate::models::WorkflowStepKind::AgentTask {
            return false;
        }
        if is_deterministic_provider_action_step(step) && *index < agent_index {
            return false;
        }
        if is_local_app_write_artifact_step(step) && *index > agent_index {
            return false;
        }
        true
    });
    unsupported.map(|step| {
        let step = step.1;
        format!(
            "Agent runtime does not support step {} ({}/{}).",
            step.id, step.provider, step.action
        )
    })
}

fn is_deterministic_provider_action_step(step: &WorkflowStepDefinition) -> bool {
    let registry = runtime_registry_snapshot();
    is_deterministic_provider_action_step_with_registry(step, &registry)
}

fn is_deterministic_provider_action_step_with_registry(
    step: &WorkflowStepDefinition,
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
) -> bool {
    if step.kind != crate::models::WorkflowStepKind::ProviderAction {
        return false;
    }
    if is_local_app_write_artifact_step(step) {
        return false;
    }
    if let Some(capability) = registry_capability_for_step(step, registry) {
        return capability.deterministic && deterministic_provider_runtime_supports_step(step);
    }
    if crate::capabilities::capability_for(&step.provider, &step.action).is_some() {
        return deterministic_provider_runtime_supports_step(step);
    }
    false
}

fn deterministic_provider_runtime_supports_step(step: &WorkflowStepDefinition) -> bool {
    matches!(
        (step.provider.as_str(), step.action.as_str()),
        ("http_probe", "check_urls")
            | ("open_meteo", "current_weather")
            | ("weather", "forecast_24h")
            | ("weather", "hourly_forecast")
            | ("weather", "alerts")
            | ("news", "trending")
            | ("news", "search")
            | ("rss", "fetch_feed")
            | ("web", "fetch_page")
            | ("web", "extract_article")
            | ("web", "extract_metadata")
            | ("seo", "fetch_robots_txt")
            | ("seo", "parse_robots_txt")
            | ("seo", "fetch_sitemap")
            | ("seo", "parse_sitemap")
            | ("seo", "audit_indexability")
            | ("seo", "audit_metadata")
            | ("seo", "extract_structured_data")
            | ("seo", "validate_json_ld")
            | ("seo", "audit_links")
            | ("seo", "audit_canonical_hreflang")
            | ("content", "map_search_intent")
            | ("content", "generate_brief")
            | ("content", "identify_gaps")
            | ("content", "score_quality")
            | ("data", "parse_csv")
            | ("data", "transform_json")
            | ("scheduler", "preview_next_runs")
            | ("notification", "local")
            | ("mcp", "discover_tools")
    )
}

fn is_local_app_write_artifact_step(step: &WorkflowStepDefinition) -> bool {
    step.kind == crate::models::WorkflowStepKind::ProviderAction
        && step.provider == "local_app"
        && step.action == "write_artifact"
}

fn agent_artifact_metadata(
    envelope: &AgentTaskEnvelope,
    profile: &agent_auth::AgentAuthProfile,
    allowed_tools: &[String],
    tool_manifest_hash: &str,
) -> Result<serde_json::Value, String> {
    let mut metadata = envelope
        .metadata
        .clone()
        .as_object()
        .cloned()
        .ok_or_else(|| "Agent task metadata must be a JSON object.".to_string())?;
    metadata.insert(
        "agent_task".into(),
        serde_json::json!({
            "profile_id": profile.id,
            "model": profile.model,
            "effort": profile.effort,
            "allowed_tools": allowed_tools,
            "tool_manifest_hash": tool_manifest_hash,
            "tool_trace": envelope.tool_trace,
            "raw_result_json": envelope.raw_result_json,
        }),
    );
    Ok(serde_json::Value::Object(metadata))
}

fn sanitize_agent_task_envelope(envelope: AgentTaskEnvelope) -> AgentTaskEnvelope {
    AgentTaskEnvelope {
        title: sanitize_agent_text(&envelope.title),
        content_markdown: sanitize_agent_text(&envelope.content_markdown),
        metadata: sanitize_agent_json(envelope.metadata),
        source_refs: envelope
            .source_refs
            .iter()
            .map(|source_ref| sanitize_agent_text(source_ref))
            .collect(),
        tool_trace: envelope
            .tool_trace
            .iter()
            .map(sanitize_tool_trace_entry)
            .collect(),
        raw_result_json: sanitize_agent_json(envelope.raw_result_json),
    }
}

fn sanitize_tool_trace_entry(entry: &ToolTraceEntry) -> ToolTraceEntry {
    ToolTraceEntry {
        tool_id: sanitize_agent_text(&entry.tool_id),
        status: sanitize_agent_text(&entry.status),
        input_summary: sanitize_agent_json(entry.input_summary.clone()),
        output_summary: entry.output_summary.clone().map(sanitize_agent_json),
        source_refs: entry
            .source_refs
            .iter()
            .map(|source_ref| sanitize_agent_text(source_ref))
            .collect(),
        error: entry.error.as_ref().map(|error| sanitize_agent_text(error)),
    }
}

fn sanitize_agent_json(value: serde_json::Value) -> serde_json::Value {
    sanitize_agent_json_value(value, false)
}

fn sanitize_agent_json_value(value: serde_json::Value, redact_scalar: bool) -> serde_json::Value {
    match value {
        serde_json::Value::String(value) => {
            if redact_scalar {
                serde_json::Value::String("[redacted]".into())
            } else {
                serde_json::Value::String(sanitize_agent_text(&value))
            }
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(|value| sanitize_agent_json_value(value, redact_scalar))
                .collect(),
        ),
        serde_json::Value::Object(values) => {
            let values = values
                .into_iter()
                .map(|(key, value)| {
                    let is_sensitive = is_sensitive_agent_json_key(&key);
                    (
                        sanitize_agent_text(&key),
                        sanitize_agent_json_value(value, redact_scalar || is_sensitive),
                    )
                })
                .collect();
            serde_json::Value::Object(values)
        }
        other => other,
    }
}

fn is_sensitive_agent_json_key(key: &str) -> bool {
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

fn sanitize_agent_text(value: &str) -> String {
    let mut redacted = redact_sensitive_assignments(value);
    for (prefix, min_suffix_len, case_insensitive) in [
        ("sk-", 8, false),
        ("github_pat_", 12, false),
        ("ghp_", 12, false),
        ("xoxb-", 20, false),
        ("AIza", 20, false),
        ("AKIA", 16, false),
        ("Bearer ", 20, true),
    ] {
        redacted =
            redact_agent_token_with_prefix(&redacted, prefix, min_suffix_len, case_insensitive);
    }
    redacted
}

fn redact_sensitive_assignments(value: &str) -> String {
    let mut redacted = String::new();
    let mut index = 0;
    while index < value.len() {
        let Some((key_start, key_end, value_start, value_end)) =
            sensitive_assignment_at(value, index)
        else {
            let character = value[index..]
                .chars()
                .next()
                .expect("index is within string bounds");
            redacted.push(character);
            index += character.len_utf8();
            continue;
        };

        redacted.push_str(&value[index..value_start]);
        redacted.push_str("[redacted]");
        index = value_end.max(key_end).max(key_start);
    }
    redacted
}

fn sensitive_assignment_at(value: &str, index: usize) -> Option<(usize, usize, usize, usize)> {
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
    if key_end == index || !is_sensitive_agent_json_key(&value[index..key_end]) {
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
    (value_end > value_start).then_some((index, key_end, value_start, value_end))
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

fn redact_agent_token_with_prefix(
    value: &str,
    prefix: &str,
    min_suffix_len: usize,
    case_insensitive: bool,
) -> String {
    let mut redacted = String::new();
    let mut index = 0;
    while index < value.len() {
        let has_prefix = value[index..].get(..prefix.len()).is_some_and(|candidate| {
            if case_insensitive {
                candidate.eq_ignore_ascii_case(prefix)
            } else {
                candidate == prefix
            }
        });
        if has_prefix && is_agent_token_boundary(value[..index].chars().next_back()) {
            let suffix = &value[index + prefix.len()..];
            if agent_token_suffix_len(suffix) >= min_suffix_len {
                redacted.push_str("[redacted]");
                index += prefix.len() + agent_token_suffix_byte_len(suffix);
                continue;
            }
        }

        let character = value[index..]
            .chars()
            .next()
            .expect("index is within string bounds");
        redacted.push(character);
        index += character.len_utf8();
    }
    redacted
}

fn is_agent_token_boundary(character: Option<char>) -> bool {
    character.is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
}

fn agent_token_suffix_len(value: &str) -> usize {
    value.chars().take_while(is_agent_token_character).count()
}

fn agent_token_suffix_byte_len(value: &str) -> usize {
    value
        .chars()
        .take_while(is_agent_token_character)
        .map(char::len_utf8)
        .sum()
}

fn is_agent_token_character(character: &char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | '+' | '=')
}

fn fail_agent_runtime_after_executor(
    repository: &Repository,
    run: WorkflowRun,
    step_runs: &[WorkflowStepRun],
    tool_event_id: &str,
    error: &str,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let error = sanitize_agent_text(error);
    let tool_event_completion =
        complete_agent_tool_event_failed_safely(repository, tool_event_id, &error);
    fail_all_steps(repository, step_runs, RunStatus::Failed, &error)?;
    repository.finish_run_with_classification(
        &run.id,
        RunStatus::Failed,
        Some(&error),
        Some("terminal"),
    )?;
    emit_run_error(sink, &run.id, &error, "terminal");
    if let Err(error) = tool_event_completion {
        if !matches!(error, DbError::AgentToolEventAlreadyCompleted(_)) {
            return Err(RuntimeError::Db(error));
        }
    }
    Ok(WorkflowRunResult {
        run: WorkflowRun {
            status: RunStatus::Failed,
            completed_at: Some(timestamp()),
            failure_reason: Some(error),
            error_classification: Some("terminal".into()),
            ..run
        },
        artifact: None,
        duplicate: false,
    })
}

fn fail_agent_runtime_before_executor(
    repository: &Repository,
    run: WorkflowRun,
    step_runs: &[WorkflowStepRun],
    error: &str,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let error = sanitize_agent_text(error);
    let persisted_step_runs = repository.workflow_step_runs_for_run(&run.id)?;
    for step_run in step_runs {
        let already_completed = persisted_step_runs
            .iter()
            .any(|persisted| persisted.id == step_run.id && persisted.completed_at.is_some());
        if !already_completed {
            repository.fail_step(&step_run.id, RunStatus::Failed, &error)?;
        }
    }
    repository.finish_run_with_classification(
        &run.id,
        RunStatus::Failed,
        Some(&error),
        Some("terminal"),
    )?;
    emit_run_error(sink, &run.id, &error, "terminal");
    Ok(WorkflowRunResult {
        run: WorkflowRun {
            status: RunStatus::Failed,
            completed_at: Some(timestamp()),
            failure_reason: Some(error),
            error_classification: Some("terminal".into()),
            ..run
        },
        artifact: None,
        duplicate: false,
    })
}

fn block_agent_runtime_before_executor(
    repository: &Repository,
    run: WorkflowRun,
    step_runs: &[WorkflowStepRun],
    blocked: BlockedRunDetails,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let reason = sanitize_agent_text(&blocked.reason);
    let persisted_step_runs = repository.workflow_step_runs_for_run(&run.id)?;
    for step_run in step_runs {
        let already_completed = persisted_step_runs
            .iter()
            .any(|persisted| persisted.id == step_run.id && persisted.completed_at.is_some());
        if !already_completed {
            repository.fail_step(&step_run.id, RunStatus::Blocked, &reason)?;
        }
    }
    repository.block_run(
        &run.id,
        &reason,
        &blocked.required_provider_id,
        &blocked.required_profile_id,
        &blocked.setup_action,
    )?;
    emit_run_error(sink, &run.id, &reason, "terminal");
    Ok(WorkflowRunResult {
        run: WorkflowRun {
            status: RunStatus::Blocked,
            completed_at: Some(timestamp()),
            failure_reason: Some(reason.clone()),
            error_classification: Some("terminal".into()),
            blocked_reason: Some(reason),
            required_provider_id: Some(blocked.required_provider_id),
            required_profile_id: Some(blocked.required_profile_id),
            setup_action: Some(blocked.setup_action),
            ..run
        },
        artifact: None,
        duplicate: false,
    })
}

fn finish_agent_runtime_executor_error(
    repository: &Repository,
    run: WorkflowRun,
    step_runs: &[WorkflowStepRun],
    tool_event_id: &str,
    status: RunStatus,
    classification: &str,
    error: &str,
) -> Result<WorkflowRunResult, RuntimeError> {
    let sanitized_error = sanitize_agent_text(error);
    let tool_event_completion =
        complete_agent_tool_event_failed_safely(repository, tool_event_id, &sanitized_error);
    fail_all_steps(repository, step_runs, status.clone(), &sanitized_error)?;
    repository.finish_run_with_classification(
        &run.id,
        status.clone(),
        Some(&sanitized_error),
        Some(classification),
    )?;
    if let Err(error) = tool_event_completion {
        return Err(RuntimeError::Db(error));
    }
    Ok(WorkflowRunResult {
        run: WorkflowRun {
            status,
            completed_at: Some(timestamp()),
            failure_reason: Some(sanitized_error),
            error_classification: Some(classification.into()),
            ..run
        },
        artifact: None,
        duplicate: false,
    })
}

fn finish_agent_runtime_blocked_after_executor(
    repository: &Repository,
    run: WorkflowRun,
    step_runs: &[WorkflowStepRun],
    tool_event_id: &str,
    blocked: BlockedRunDetails,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let reason = sanitize_agent_text(&blocked.reason);
    let tool_event_completion =
        complete_agent_tool_event_blocked_safely(repository, tool_event_id, &reason);
    fail_all_steps(repository, step_runs, RunStatus::Blocked, &reason)?;
    repository.block_run(
        &run.id,
        &reason,
        &blocked.required_provider_id,
        &blocked.required_profile_id,
        &blocked.setup_action,
    )?;
    emit_run_error(sink, &run.id, &reason, "terminal");
    if let Err(error) = tool_event_completion {
        return Err(RuntimeError::Db(error));
    }
    Ok(WorkflowRunResult {
        run: WorkflowRun {
            status: RunStatus::Blocked,
            completed_at: Some(timestamp()),
            failure_reason: Some(reason.clone()),
            error_classification: Some("terminal".into()),
            blocked_reason: Some(reason),
            required_provider_id: Some(blocked.required_provider_id),
            required_profile_id: Some(blocked.required_profile_id),
            setup_action: Some(blocked.setup_action),
            ..run
        },
        artifact: None,
        duplicate: false,
    })
}

fn complete_agent_tool_event_failed_safely(
    repository: &Repository,
    tool_event_id: &str,
    error: &str,
) -> Result<(), DbError> {
    let sanitized = sanitize_agent_text(error);
    match repository.complete_agent_tool_event(
        tool_event_id,
        AgentToolEventStatus::Failed,
        None,
        Some(&sanitized),
    ) {
        Ok(()) => Ok(()),
        Err(DbError::RawCredential) => repository.complete_agent_tool_event(
            tool_event_id,
            AgentToolEventStatus::Failed,
            None,
            Some("agent task execution failed"),
        ),
        Err(error) => Err(error),
    }
}

fn complete_agent_tool_event_blocked_safely(
    repository: &Repository,
    tool_event_id: &str,
    error: &str,
) -> Result<(), DbError> {
    let sanitized = sanitize_agent_text(error);
    match repository.complete_agent_tool_event(
        tool_event_id,
        AgentToolEventStatus::Blocked,
        None,
        Some(&sanitized),
    ) {
        Ok(()) => Ok(()),
        Err(DbError::RawCredential) => repository.complete_agent_tool_event(
            tool_event_id,
            AgentToolEventStatus::Blocked,
            None,
            Some("agent task authentication required"),
        ),
        Err(error) => Err(error),
    }
}

fn fail_all_steps(
    repository: &Repository,
    step_runs: &[WorkflowStepRun],
    status: RunStatus,
    error: &str,
) -> Result<(), RuntimeError> {
    let error = sanitize_agent_text(error);
    let completed_successful_step_ids = step_runs
        .first()
        .map(|step_run| repository.workflow_step_runs_for_run(&step_run.workflow_run_id))
        .transpose()?
        .unwrap_or_default()
        .into_iter()
        .filter(|step_run| {
            step_run.status == RunStatus::Succeeded && step_run.completed_at.is_some()
        })
        .map(|step_run| step_run.id)
        .collect::<HashSet<_>>();

    for step_run in step_runs {
        if completed_successful_step_ids.contains(&step_run.id) {
            continue;
        }
        repository.fail_step(&step_run.id, status.clone(), &error)?;
    }
    Ok(())
}

#[cfg(not(test))]
fn runtime_agent_auth_profiles() -> Vec<agent_auth::AgentAuthProfile> {
    agent_auth::default_agent_auth_profiles()
}

#[cfg(test)]
fn runtime_agent_auth_profiles() -> Vec<agent_auth::AgentAuthProfile> {
    agent_auth::default_agent_auth_profiles()
        .into_iter()
        .map(|mut profile| {
            if profile.id == "codex-oauth-local" || profile.id == "claude-code-oauth-local" {
                profile.status = "available".into();
            }
            profile
        })
        .collect()
}

fn run_blocked_workflow(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    blocked: BlockedRunDetails,
) -> Result<WorkflowRunResult, RuntimeError> {
    let version = repository
        .latest_workflow_version(workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(workflow_id.into()))?;
    ensure_workflow_enabled(&version)?;

    let trigger_kind = match &trigger {
        RunTrigger::Manual => "manual".to_string(),
        RunTrigger::ScheduleWindow(_) => "schedule".to_string(),
        RunTrigger::ApprovedResume(_) => "resume".to_string(),
    };
    let idempotency_key = match trigger {
        RunTrigger::Manual => format!("manual:{workflow_id}:{}", Uuid::new_v4()),
        RunTrigger::ScheduleWindow(window) => format!("schedule:{workflow_id}:{window}"),
        RunTrigger::ApprovedResume(run_id) => format!("resume:{run_id}"),
    };

    if let Some(existing_run) = repository.find_run_by_idempotency_key(&idempotency_key)? {
        return Ok(WorkflowRunResult {
            artifact: repository.artifact_for_run(&existing_run.id)?,
            run: existing_run,
            duplicate: true,
        });
    }

    let started_at = timestamp();
    let run = WorkflowRun {
        id: format!("run-{}", Uuid::new_v4()),
        workflow_id: workflow_id.into(),
        workflow_name: version.definition.name.clone(),
        status: RunStatus::Running,
        started_at,
        completed_at: None,
        failure_reason: None,
        idempotency_key,
        trigger_kind,
        retry_count: 0,
        parent_run_id: None,
        error_classification: None,
        provider_profile_id: Some(blocked.required_profile_id.clone()),
        blocked_reason: None,
        required_provider_id: None,
        required_profile_id: None,
        setup_action: None,
        total_tokens: None,
        input_tokens: None,
        output_tokens: None,
        total_cost_usd: None,
    };
    repository.create_run_with_steps(&run, &[])?;
    repository.block_run(
        &run.id,
        &blocked.reason,
        &blocked.required_provider_id,
        &blocked.required_profile_id,
        &blocked.setup_action,
    )?;

    Ok(WorkflowRunResult {
        run: WorkflowRun {
            status: RunStatus::Blocked,
            completed_at: Some(timestamp()),
            failure_reason: Some(blocked.reason.clone()),
            error_classification: Some("terminal".into()),
            blocked_reason: Some(blocked.reason),
            required_provider_id: Some(blocked.required_provider_id),
            required_profile_id: Some(blocked.required_profile_id),
            setup_action: Some(blocked.setup_action),
            ..run
        },
        artifact: None,
        duplicate: false,
    })
}

fn run_unregistered_capability_blocked_workflow(
    repository: &mut Repository,
    workflow_id: &str,
    trigger: RunTrigger,
    version: &WorkflowVersion,
    step: &WorkflowStepDefinition,
    sink: &dyn RuntimeEventSink,
) -> Result<WorkflowRunResult, RuntimeError> {
    let (trigger_kind, idempotency_key) = match trigger {
        RunTrigger::Manual => (
            "manual".to_string(),
            format!("manual:{workflow_id}:{}", Uuid::new_v4()),
        ),
        RunTrigger::ScheduleWindow(window) => (
            "schedule".to_string(),
            format!("schedule:{workflow_id}:{window}"),
        ),
        RunTrigger::ApprovedResume(run_id) => ("resume".to_string(), format!("resume:{run_id}")),
    };
    if let Some(existing_run) = repository.find_run_by_idempotency_key(&idempotency_key)? {
        return Ok(WorkflowRunResult {
            artifact: repository.artifact_for_run(&existing_run.id)?,
            run: existing_run,
            duplicate: true,
        });
    }

    let started_at = timestamp();
    let run = WorkflowRun {
        id: format!("run-{}", Uuid::new_v4()),
        workflow_id: workflow_id.into(),
        workflow_name: version.definition.name.clone(),
        status: RunStatus::Running,
        started_at: started_at.clone(),
        completed_at: None,
        failure_reason: None,
        idempotency_key,
        trigger_kind,
        retry_count: 0,
        parent_run_id: None,
        error_classification: None,
        provider_profile_id: Some("approval".into()),
        blocked_reason: None,
        required_provider_id: None,
        required_profile_id: None,
        setup_action: None,
        total_tokens: None,
        input_tokens: None,
        output_tokens: None,
        total_cost_usd: None,
    };
    let step_runs = version
        .definition
        .steps
        .iter()
        .map(|step| WorkflowStepRun {
            id: format!("step-run-{}", Uuid::new_v4()),
            workflow_run_id: run.id.clone(),
            step_id: step.id.clone(),
            status: RunStatus::Running,
            output_json: None,
            error: None,
            started_at: started_at.clone(),
            completed_at: None,
        })
        .collect::<Vec<_>>();
    repository.create_run_with_steps(&run, &step_runs)?;
    emit_run_started(sink, &run);

    let capability_id = capability_id_for_step(step);
    let reason = format!("Capability {capability_id} is unregistered and cannot run.");
    audit_capability_decision(
        repository,
        version,
        &run,
        step,
        &capability_id,
        "blocked",
        &reason,
        None,
    )?;
    let blocked = approval_blocked_details(&capability_id, reason);
    block_deterministic_provider_runtime(repository, run, &step_runs, blocked, sink)
}

pub fn run_scheduled_due_workflows(
    repository: &mut Repository,
    schedule_window: &str,
) -> Result<Vec<WorkflowRunResult>, RuntimeError> {
    run_scheduled_due_workflows_for_ids(repository, schedule_window, None)
}

pub fn run_scheduled_due_workflows_for_ids(
    repository: &mut Repository,
    schedule_window: &str,
    workflow_ids: Option<&[String]>,
) -> Result<Vec<WorkflowRunResult>, RuntimeError> {
    let allowed_workflow_ids =
        workflow_ids.map(|ids| ids.iter().map(String::as_str).collect::<HashSet<_>>());
    let schedule_overrides = repository.schedule_overrides()?;
    let workflows = repository.enabled_scheduled_workflows()?;
    workflows
        .iter()
        .filter(|workflow| {
            workflow_matches_schedule_window(workflow, schedule_window, &schedule_overrides)
        })
        .filter(|workflow| {
            allowed_workflow_ids
                .as_ref()
                .map_or(true, |ids| ids.contains(workflow.workflow_id.as_str()))
        })
        .map(|workflow| {
            run_workflow(
                repository,
                &workflow.workflow_id,
                RunTrigger::ScheduleWindow(schedule_window.into()),
            )
        })
        .collect()
}

fn workflow_matches_schedule_window(
    workflow: &WorkflowVersion,
    schedule_window: &str,
    overrides: &[crate::models::WorkflowScheduleOverride],
) -> bool {
    if overrides.iter().any(|override_entry| {
        override_entry.workflow_id == workflow.workflow_id
            && override_entry.scheduled_run_at == schedule_window
    }) {
        return true;
    }
    if overrides.iter().any(|override_entry| {
        override_entry.workflow_id == workflow.workflow_id
            && override_entry.original_run_at == schedule_window
    }) {
        return false;
    }
    let Ok(window) = NaiveDateTime::parse_from_str(schedule_window, "%Y-%m-%dT%H:%M") else {
        return false;
    };
    let Some(schedule) = workflow.definition.schedule.as_ref() else {
        return false;
    };
    if schedule.cadence == "manual" {
        return false;
    }
    if !cadence_allows_window_date(&schedule.cadence, window.weekday()) {
        return false;
    }
    schedule
        .local_time
        .as_deref()
        .is_some_and(|local_time| local_time == window.format("%H:%M").to_string())
}

fn cadence_allows_window_date(cadence: &str, weekday: chrono::Weekday) -> bool {
    match cadence {
        "daily" => true,
        "weekdays" => !matches!(weekday, chrono::Weekday::Sat | chrono::Weekday::Sun),
        _ => false,
    }
}

pub fn retry_workflow_run(
    repository: &mut Repository,
    run_id: &str,
) -> Result<WorkflowRunResult, RuntimeError> {
    let run = repository
        .workflow_run(run_id)?
        .ok_or_else(|| RuntimeError::MissingRun(run_id.into()))?;
    run_workflow(repository, &run.workflow_id, RunTrigger::Manual)
}

pub fn regenerate_artifact(
    repository: &mut Repository,
    artifact_id: &str,
) -> Result<WorkflowRunResult, RuntimeError> {
    let artifact = repository
        .artifact_by_id(artifact_id)?
        .ok_or_else(|| RuntimeError::MissingArtifact(artifact_id.into()))?;
    let run = repository
        .workflow_run(&artifact.workflow_run_id)?
        .ok_or_else(|| RuntimeError::MissingRun(artifact.workflow_run_id.clone()))?;
    run_workflow(repository, &run.workflow_id, RunTrigger::Manual)
}

pub fn generate_artifact_preview(
    repository: &Repository,
    workflow_id: &str,
) -> Result<String, RuntimeError> {
    let version = repository
        .latest_workflow_version(workflow_id)?
        .ok_or_else(|| RuntimeError::MissingWorkflow(workflow_id.into()))?;
    let project_root = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let context = repository
        .gather_all_context(&project_root)
        .unwrap_or_else(|_| crate::providers::ContextPack {
            summary: "Local context unavailable; generated fallback artifact preview.".into(),
            source_refs: vec!["runtime preview fallback".into()],
        });
    let profile = repository
        .llm_profile(&version.definition.defaults.llm_profile_ref)?
        .map(|profile| (profile.provider_id, profile.model, profile.effort))
        .unwrap_or_else(|| ("local_preview".into(), "preview".into(), "medium".into()));
    let request = ArtifactGenerationRequest {
        workflow: version.definition,
        context_summary: context.summary,
        source_refs: context.source_refs,
        provider_id: profile.0,
        model: profile.1,
        effort: profile.2,
    };
    LocalPreviewArtifactGenerator
        .generate_artifact(&request)
        .map(|artifact| artifact.content_markdown)
        .map_err(|error| {
            RuntimeError::Db(DbError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                error.to_string(),
            )))
        })
}

fn classify_llm_error(error: &LlmError) -> (RunStatus, &'static str) {
    match error {
        LlmError::RequestFailed(message)
            if message.contains("429")
                || message.to_lowercase().contains("rate limit")
                || message.to_lowercase().contains("timeout")
                || message.contains("500")
                || message.contains("502")
                || message.contains("503")
                || message.contains("504") =>
        {
            (RunStatus::Retryable, "retryable")
        }
        LlmError::RequestFailed(_) => (RunStatus::Retryable, "retryable"),
        LlmError::MissingCredential | LlmError::MalformedOutput(_) | LlmError::Refusal(_) => {
            (RunStatus::Failed, "terminal")
        }
    }
}

enum RuntimeArtifactGenerator {
    OpenAi(OpenAiResponsesArtifactGenerator),
    Anthropic(AnthropicMessagesArtifactGenerator),
}

impl LlmArtifactGenerator for RuntimeArtifactGenerator {
    fn generate_artifact(
        &self,
        request: &ArtifactGenerationRequest,
    ) -> Result<crate::llm::ArtifactEnvelope, LlmError> {
        match self {
            RuntimeArtifactGenerator::OpenAi(generator) => generator.generate_artifact(request),
            RuntimeArtifactGenerator::Anthropic(generator) => generator.generate_artifact(request),
        }
    }
}

struct RuntimeArtifactBackend {
    generator: RuntimeArtifactGenerator,
    provider_id: String,
    model: String,
    effort: String,
}

struct RuntimeAgentTaskCredentialResolver {
    openai_credential: Option<String>,
    anthropic_credential: Option<String>,
}

impl RuntimeAgentTaskCredentialResolver {
    fn from_repository(repository: &Repository) -> Result<Self, DbError> {
        Ok(Self {
            openai_credential: resolve_agent_provider_credential(repository, "openai")?,
            anthropic_credential: resolve_agent_provider_credential(repository, "anthropic")?,
        })
    }
}

impl agent_task::AgentTaskCredentialResolver for RuntimeAgentTaskCredentialResolver {
    fn resolve(&self, profile: &agent_auth::AgentAuthProfile) -> Option<String> {
        match profile.runner_kind {
            agent_auth::AgentRunnerKind::OpenAiApi => self.openai_credential.clone(),
            agent_auth::AgentRunnerKind::AnthropicApi => self.anthropic_credential.clone(),
            agent_auth::AgentRunnerKind::CodexCli
            | agent_auth::AgentRunnerKind::ClaudeCodeCli
            | agent_auth::AgentRunnerKind::OllamaLocal => None,
        }
    }
}

fn resolve_agent_provider_credential(
    repository: &Repository,
    provider_id: &str,
) -> Result<Option<String>, DbError> {
    let account_id = match provider_id {
        "anthropic" => "anthropic-api-key",
        "openai" => "openai-api-key",
        other => other,
    };
    if let Some(account) = repository.provider_account(account_id)? {
        return repository.resolve_credential_reference(&account.credential_ref);
    }
    let profile_id = match provider_id {
        "anthropic" => "default-anthropic",
        _ => "default-openai",
    };
    Ok(repository
        .resolve_llm_credential(profile_id)?
        .map(|credential| credential.credential))
}

struct BlockedRunDetails {
    reason: String,
    required_provider_id: String,
    required_profile_id: String,
    setup_action: String,
}

fn live_artifact_backend(
    repository: &Repository,
    profile_id: &str,
) -> Result<Result<RuntimeArtifactBackend, BlockedRunDetails>, RuntimeError> {
    let profile = repository.llm_profile(profile_id)?;
    let provider_id = profile
        .as_ref()
        .map(|profile| profile.provider_id.clone())
        .unwrap_or_else(|| "openai".into());
    let Some(resolved) = repository.resolve_llm_credential(profile_id)? else {
        return Ok(Err(blocked_details(&provider_id, profile_id)));
    };
    let generator = match resolved.provider_id.as_str() {
        "anthropic" => RuntimeArtifactGenerator::Anthropic(
            AnthropicMessagesArtifactGenerator::new(resolved.credential),
        ),
        _ => RuntimeArtifactGenerator::OpenAi(OpenAiResponsesArtifactGenerator::new(
            resolved.credential,
        )),
    };

    Ok(Ok(RuntimeArtifactBackend {
        generator,
        provider_id: resolved.provider_id,
        model: resolved.model,
        effort: resolved.effort,
    }))
}

fn blocked_details(provider_id: &str, profile_id: &str) -> BlockedRunDetails {
    let provider_name = match provider_id {
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        other => other,
    };
    BlockedRunDetails {
        reason: format!("{provider_name} credential is required before live artifact generation."),
        required_provider_id: provider_id.into(),
        required_profile_id: profile_id.into(),
        setup_action: format!("Configure the {provider_name} API key in Settings."),
    }
}

fn merge_artifact_metadata(
    mut metadata: serde_json::Value,
    workflow_id: &str,
    workflow_version: i64,
    destination_ref: &str,
) -> serde_json::Value {
    let object = metadata
        .as_object_mut()
        .expect("artifact metadata must be a JSON object");
    object
        .entry("schema_version")
        .or_insert_with(|| serde_json::json!("0.1.0"));
    object
        .entry("workflow_id")
        .or_insert_with(|| serde_json::json!(workflow_id));
    object
        .entry("workflow_version")
        .or_insert_with(|| serde_json::json!(workflow_version));
    object
        .entry("destination")
        .or_insert_with(|| serde_json::json!(destination_ref));
    metadata
}

fn emit_run_started(sink: &dyn RuntimeEventSink, run: &WorkflowRun) {
    sink.emit(AgentEvent::RunStarted {
        run_id: run.id.clone(),
        thread_id: run.id.clone(),
        workflow_name: run.workflow_name.clone(),
        timestamp: run.started_at.clone(),
    });
}

fn emit_step_started(sink: &dyn RuntimeEventSink, run_id: &str, step: &WorkflowStepDefinition) {
    sink.emit(AgentEvent::StepStarted {
        run_id: run_id.into(),
        step_id: step.id.clone(),
        step_name: step.name.clone(),
        timestamp: timestamp(),
    });
}

fn emit_step_started_for_id(
    sink: &dyn RuntimeEventSink,
    run_id: &str,
    steps: &[WorkflowStepDefinition],
    step_id: &str,
) {
    if let Some(step) = steps.iter().find(|step| step.id == step_id) {
        emit_step_started(sink, run_id, step);
    }
}

fn emit_step_finished(
    sink: &dyn RuntimeEventSink,
    run_id: &str,
    step_id: &str,
    token_count: Option<u64>,
    estimated_cost_usd: Option<f64>,
) {
    sink.emit(AgentEvent::StepFinished {
        run_id: run_id.into(),
        step_id: step_id.into(),
        duration_ms: 0,
        token_count,
        estimated_cost_usd,
    });
}

fn emit_run_error(sink: &dyn RuntimeEventSink, run_id: &str, error: &str, classification: &str) {
    sink.emit(AgentEvent::RunError {
        run_id: run_id.into(),
        error: error.into(),
        classification: classification.into(),
    });
}

fn emit_interrupt(sink: &dyn RuntimeEventSink, approval: &PendingApproval) {
    sink.emit(AgentEvent::Interrupt {
        run_id: approval.run_id.clone(),
        step_id: approval.step_id.clone(),
        approval_id: approval.id.clone(),
        workflow_name: approval.workflow_name.clone(),
        description: approval.description.clone(),
        risk_level: approval.risk_level.clone(),
        timestamp: approval.created_at.clone(),
    });
}

fn emit_tool_trace_events(
    sink: &dyn RuntimeEventSink,
    run_id: &str,
    step_id: &str,
    tool_trace: &[ToolTraceEntry],
) {
    for (index, trace) in tool_trace.iter().enumerate() {
        sink.emit(AgentEvent::ToolCallStart {
            run_id: run_id.into(),
            step_id: step_id.into(),
            tool_call_id: format!("{step_id}-tool-{index}"),
            tool_name: trace.tool_id.clone(),
            args: trace.input_summary.clone(),
        });
        let result = trace
            .output_summary
            .as_ref()
            .map(|value| value.to_string())
            .or_else(|| trace.error.clone())
            .unwrap_or_else(|| trace.status.clone());
        sink.emit(AgentEvent::ToolCallEnd {
            run_id: run_id.into(),
            step_id: step_id.into(),
            tool_name: trace.tool_id.clone(),
            result,
            duration_ms: 0,
        });
    }
}

#[derive(Debug, Clone, Copy)]
struct TokenUsage {
    total_tokens: Option<u64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    estimated_cost_usd: Option<f64>,
}

fn nested_usage_u64(metadata: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| metadata.get(*key).and_then(|value| value.as_u64()))
        .or_else(|| {
            metadata.get("usage").and_then(|usage| {
                keys.iter()
                    .find_map(|key| usage.get(*key).and_then(|value| value.as_u64()))
            })
        })
}

fn usage_totals(metadata: &serde_json::Value) -> TokenUsage {
    let input_tokens = nested_usage_u64(metadata, &["input_tokens", "prompt_tokens"]);
    let output_tokens = nested_usage_u64(metadata, &["output_tokens", "completion_tokens"]);
    let token_count = metadata
        .get("token_count")
        .and_then(|value| value.as_u64())
        .or_else(|| {
            metadata
                .get("total_tokens")
                .and_then(|value| value.as_u64())
        })
        .or_else(|| {
            metadata
                .get("usage")
                .and_then(|usage| usage.get("total_tokens"))
                .and_then(|value| value.as_u64())
        });
    let total_tokens = token_count.or_else(|| {
        input_tokens
            .zip(output_tokens)
            .map(|(input, output)| input + output)
    });
    let estimated_cost_usd = metadata
        .get("estimated_cost_usd")
        .and_then(|value| value.as_f64())
        .or_else(|| metadata.get("cost_usd").and_then(|value| value.as_f64()));
    TokenUsage {
        total_tokens,
        input_tokens,
        output_tokens,
        estimated_cost_usd,
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_task::{AgentTaskError, AgentTaskExecutor, AgentTaskRequest};
    use crate::db::Repository;
    use crate::llm::{ArtifactEnvelope, ArtifactGenerationRequest, LlmArtifactGenerator, LlmError};
    use crate::models::{
        AgentTaskEnvelope, AgentToolEventStatus, ApprovalGrant, ApprovalGrantScope,
        ApprovalGrantStatus, ApprovalGrantType, RavenWorkflow, ToolTraceEntry, WorkflowDefaults,
        WorkflowScheduleDefinition, WorkflowStatus, WorkflowStepDefinition, WorkflowStepKind,
        WorkflowVersion,
    };
    use crate::providers::{WeatherProvider, WeatherSnapshot};
    use crate::workflow::daily_work_journal;

    fn repo() -> Repository {
        let dir = std::env::temp_dir().join(format!("raven-runtime-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Repository::open(dir.join("raven.sqlite3")).unwrap()
    }

    fn repo_at(dir: &std::path::Path) -> Repository {
        std::fs::create_dir_all(dir).unwrap();
        Repository::open(dir.join("raven.sqlite3")).unwrap()
    }

    fn grant_capability_for_latest_workflow(
        repository: &Repository,
        workflow_id: &str,
        capability_id: &str,
    ) {
        grant_capability_for_latest_workflow_with_paths(
            repository,
            workflow_id,
            capability_id,
            vec![],
        );
    }

    fn grant_capability_for_latest_workflow_with_paths(
        repository: &Repository,
        workflow_id: &str,
        capability_id: &str,
        mut paths: Vec<String>,
    ) {
        let version = repository
            .latest_workflow_version(workflow_id)
            .unwrap()
            .unwrap();
        if capability_id == "local_app.write_artifact" && paths.is_empty() {
            let (content_path, metadata_path) = repository.artifact_paths("artifact-*");
            paths = vec![content_path, metadata_path];
        }
        let (capability, step) =
            test_capability_descriptor_for_latest_workflow(repository, workflow_id, capability_id);
        let inputs = add_step_scope_context(&step.inputs, &step);
        for requirement in grant_requirements_for_capability(&capability) {
            let grant_type = test_grant_type_for_requirement(requirement);
            let scope = test_grant_scope_for_requirement(&capability, &inputs, requirement, &paths);
            repository
                .create_approval_grant(&ApprovalGrant {
                    id: format!(
                        "grant-{}-{:?}-{}",
                        capability_id.replace('.', "-"),
                        requirement,
                        uuid::Uuid::new_v4()
                    ),
                    workflow_id: workflow_id.into(),
                    workflow_version: version.version,
                    capability_id: capability_id.into(),
                    grant_type,
                    scope,
                    approved_by_user_at: timestamp(),
                    expires_at: None,
                    signature_hash: capability.signature_hash.clone(),
                    status: ApprovalGrantStatus::Active,
                })
                .unwrap();
        }
    }

    fn test_capability_descriptor_for_latest_workflow(
        repository: &Repository,
        workflow_id: &str,
        capability_id: &str,
    ) -> (CapabilityDescriptor, WorkflowStepDefinition) {
        let version = repository
            .latest_workflow_version(workflow_id)
            .unwrap()
            .unwrap();
        let registry = runtime_registry_snapshot();
        if let Some(step) = version.definition.steps.iter().find(|step| {
            step.kind == WorkflowStepKind::ProviderAction
                && format!("{}.{}", step.provider, step.action) == capability_id
        }) {
            if let Some(capability) = runtime_capability_descriptor_for_step(step, &registry) {
                return (capability, step.clone());
            }
        }
        if capability_id == "open_meteo.current_weather" {
            let step = weather_provider_policy_step(&version.definition.steps);
            let capability = runtime_capability_descriptor_for_step(&step, &registry).unwrap();
            return (capability, step);
        }
        if capability_id == "local_app.write_artifact" {
            let step = artifact_persistence_policy_step(&version.definition.steps, "test");
            let capability = runtime_capability_descriptor_for_step(&step, &registry).unwrap();
            return (capability, step);
        }
        if capability_id == "agent.run_task" {
            let step = version
                .definition
                .steps
                .iter()
                .find(|step| step.kind == WorkflowStepKind::AgentTask)
                .unwrap()
                .clone();
            let capability = agent_task_capability_descriptor().unwrap();
            return (capability, step);
        }
        if capability_id == "deterministic_artifact.build_artifact" {
            let fixture_dir = std::env::current_dir()
                .unwrap()
                .join("tests")
                .join("fixtures")
                .join("plugins")
                .join("deterministic-artifact-plugin");
            let manifest = crate::plugins::load_plugin_manifest(&fixture_dir).unwrap();
            let capability = manifest
                .steps
                .iter()
                .find(|step| format!("{}.{}", step.provider, step.action) == capability_id)
                .unwrap();
            let descriptor = plugin_capability_descriptor(&manifest, capability);
            let step = version
                .definition
                .steps
                .iter()
                .find(|step| format!("{}.{}", step.provider, step.action) == capability_id)
                .unwrap()
                .clone();
            return (descriptor, step);
        }
        panic!("missing test capability descriptor for {capability_id}");
    }

    fn test_grant_type_for_requirement(requirement: GrantRequirement) -> ApprovalGrantType {
        match requirement {
            GrantRequirement::FileWrite => ApprovalGrantType::FileWrite,
            GrantRequirement::Delete => ApprovalGrantType::FileDelete,
            GrantRequirement::Publish => ApprovalGrantType::ExternalPublish,
            GrantRequirement::Credential => ApprovalGrantType::CredentialUse,
            GrantRequirement::Network => ApprovalGrantType::NetworkAccess,
            GrantRequirement::ToolExecution => ApprovalGrantType::ToolExecution,
        }
    }

    fn test_grant_scope_for_requirement(
        capability: &CapabilityDescriptor,
        inputs: &Value,
        requirement: GrantRequirement,
        paths: &[String],
    ) -> ApprovalGrantScope {
        ApprovalGrantScope {
            credential_ref: if requirement == GrantRequirement::Credential {
                credential_refs_from_step_inputs(&inputs).into_iter().next()
            } else {
                None
            },
            paths: if requirement == GrantRequirement::FileWrite {
                paths.to_vec()
            } else {
                vec![]
            },
            domains: if requirement == GrantRequirement::Network {
                domains_from_step_inputs(&inputs)
            } else {
                vec![]
            },
            resource_ids: if requirement == GrantRequirement::Network
                && domains_from_step_inputs(&inputs).is_empty()
            {
                vec![capability.id.clone()]
            } else if requirement == GrantRequirement::ToolExecution {
                resource_ids_from_step_inputs(&inputs)
            } else {
                vec![]
            },
            max_deletes: None,
            max_overwrite_bytes: None,
            external_targets: if requirement == GrantRequirement::Publish {
                external_targets_from_step_inputs(&inputs)
            } else {
                vec![]
            },
        }
    }

    fn grant_daily_work_journal_provider_capabilities(repository: &Repository) {
        grant_capability_for_latest_workflow(
            repository,
            "daily-work-journal",
            "local_git.recent_activity",
        );
        grant_capability_for_latest_workflow(
            repository,
            "daily-work-journal",
            "openai.generate_artifact",
        );
    }

    fn grant_daily_work_journal_all_runtime_capabilities(repository: &Repository) {
        grant_daily_work_journal_provider_capabilities(repository);
        grant_capability_for_latest_workflow(
            repository,
            "daily-work-journal",
            "local_app.write_artifact",
        );
    }

    fn grant_current_weather_provider_capability(repository: &Repository) {
        grant_capability_for_latest_workflow(
            repository,
            "current-weather",
            "open_meteo.current_weather",
        );
    }

    fn grant_current_weather_all_runtime_capabilities(repository: &Repository) {
        grant_current_weather_provider_capability(repository);
        grant_capability_for_latest_workflow(
            repository,
            "current-weather",
            "local_app.write_artifact",
        );
    }

    struct FakeGenerator {
        result: Result<ArtifactEnvelope, LlmError>,
    }

    impl LlmArtifactGenerator for FakeGenerator {
        fn generate_artifact(
            &self,
            _request: &ArtifactGenerationRequest,
        ) -> Result<ArtifactEnvelope, LlmError> {
            self.result.clone()
        }
    }

    struct PanickingGenerator;

    impl LlmArtifactGenerator for PanickingGenerator {
        fn generate_artifact(
            &self,
            _request: &ArtifactGenerationRequest,
        ) -> Result<ArtifactEnvelope, LlmError> {
            panic!("generator should not run without all required grants");
        }
    }

    struct FakeWeatherProvider;

    impl WeatherProvider for FakeWeatherProvider {
        fn current_weather(&self) -> Result<WeatherSnapshot, crate::providers::ProviderError> {
            Ok(WeatherSnapshot {
                location: "Denver, CO".into(),
                observed_at: "2026-06-08T17:30".into(),
                temperature: 74.2,
                temperature_unit: "°F".into(),
                apparent_temperature: 72.8,
                apparent_temperature_unit: "°F".into(),
                humidity_percent: 31,
                precipitation: 0.0,
                precipitation_unit: "inch".into(),
                wind_speed: 9.4,
                wind_speed_unit: "mph".into(),
                weather_code: 1,
                condition: "Mainly clear".into(),
                source_refs: vec!["open-meteo:39.75,-104.99".into()],
            })
        }
    }

    struct PanickingWeatherProvider;

    impl WeatherProvider for PanickingWeatherProvider {
        fn current_weather(&self) -> Result<WeatherSnapshot, crate::providers::ProviderError> {
            panic!("weather provider should not be called before runtime grant enforcement");
        }
    }

    struct FakeAgentExecutor {
        error: Option<String>,
        envelope: Option<AgentTaskEnvelope>,
    }

    impl AgentTaskExecutor for FakeAgentExecutor {
        fn execute(
            &self,
            _request: &AgentTaskRequest,
        ) -> Result<AgentTaskEnvelope, AgentTaskError> {
            if let Some(error) = &self.error {
                return Err(AgentTaskError::ExecutionFailed(error.clone()));
            }
            Ok(self.envelope.clone().unwrap_or_else(weather_agent_envelope))
        }
    }

    struct RecordingAgentExecutor {
        request: std::sync::Arc<std::sync::Mutex<Option<AgentTaskRequest>>>,
        envelope: AgentTaskEnvelope,
    }

    impl AgentTaskExecutor for RecordingAgentExecutor {
        fn execute(&self, request: &AgentTaskRequest) -> Result<AgentTaskEnvelope, AgentTaskError> {
            *self.request.lock().unwrap() = Some(request.clone());
            Ok(self.envelope.clone())
        }
    }

    struct PrematureToolEventCompletingExecutor {
        db_path: std::path::PathBuf,
    }

    impl AgentTaskExecutor for PrematureToolEventCompletingExecutor {
        fn execute(
            &self,
            _request: &AgentTaskRequest,
        ) -> Result<AgentTaskEnvelope, AgentTaskError> {
            let repository = Repository::open(&self.db_path).unwrap();
            let run = repository
                .app_state()
                .unwrap()
                .runs
                .into_iter()
                .find(|run| {
                    run.workflow_id == "agent-weather-runtime" && run.status == RunStatus::Running
                })
                .unwrap();
            let event = repository
                .agent_tool_events_for_run(&run.id)
                .unwrap()
                .into_iter()
                .find(|event| event.status == AgentToolEventStatus::Requested)
                .unwrap();
            repository
                .complete_agent_tool_event(
                    &event.id,
                    AgentToolEventStatus::Succeeded,
                    Some(serde_json::json!({ "premature": true })),
                    None,
                )
                .unwrap();

            Ok(weather_agent_envelope())
        }
    }

    fn set_current_weather_approval_mode(repository: &mut Repository, mode: &str) {
        let workflow = crate::workflow::current_weather();
        repository
            .create_workflow_version(workflow, WorkflowStatus::Enabled, Some(mode), None)
            .unwrap();
    }

    fn set_current_weather_high_risk_auto_approve(repository: &mut Repository) {
        let mut workflow = crate::workflow::current_weather();
        workflow.steps[0].inputs["risk_level"] = serde_json::json!("high");
        repository
            .create_workflow_version(
                workflow,
                WorkflowStatus::Enabled,
                Some("auto_approve"),
                None,
            )
            .unwrap();
    }

    #[test]
    fn approval_always_review_blocks_before_weather_provider_side_effect() {
        let mut repository = repo();
        set_current_weather_approval_mode(&mut repository, "always_review");

        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        let approvals = repository.list_pending_approvals().unwrap();
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].run_id, result.run.id);
        assert!(approvals[0]
            .payload_json
            .as_ref()
            .unwrap()
            .contains("\"runtime_kind\":\"weather\""));
        assert!(repository
            .artifact_for_run(&result.run.id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn approval_approve_resumes_waiting_weather_run_once() {
        let mut repository = repo();
        set_current_weather_approval_mode(&mut repository, "always_review");
        grant_current_weather_all_runtime_capabilities(&repository);
        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();
        let approval = repository.list_pending_approvals().unwrap().remove(0);

        let (approved, changed) = repository
            .resolve_approval(&approval.id, "approved", Some("reviewed"))
            .unwrap();
        assert!(changed);
        let approved = approved.unwrap();
        let resumed = resume_current_weather_run_with_provider(
            &mut repository,
            &approved.run_id,
            &FakeWeatherProvider,
        )
        .unwrap();
        let (again, changed_again) = repository
            .resolve_approval(&approval.id, "approved", Some("again"))
            .unwrap();

        assert_eq!(resumed.run.id, result.run.id);
        assert_eq!(resumed.run.status, RunStatus::Succeeded);
        assert!(resumed.run.failure_reason.is_none());
        assert!(resumed.run.blocked_reason.is_none());
        assert!(resumed.run.required_provider_id.is_none());
        assert!(resumed.run.required_profile_id.is_none());
        assert!(resumed.run.setup_action.is_none());
        assert!(resumed.artifact.is_some());
        assert!(!changed_again);
        assert_eq!(again.unwrap().status, "approved");
        assert_eq!(repository.app_state().unwrap().artifacts.len(), 1);
        let persisted = repository.workflow_run(&result.run.id).unwrap().unwrap();
        assert_eq!(persisted.status, RunStatus::Succeeded);
        assert!(persisted.failure_reason.is_none());
        assert!(persisted.blocked_reason.is_none());
        assert!(persisted.required_provider_id.is_none());
        assert!(persisted.required_profile_id.is_none());
        assert!(persisted.setup_action.is_none());
        let decided = repository.pending_approval(&approval.id).unwrap().unwrap();
        assert_eq!(decided.decision_reason.as_deref(), Some("reviewed"));
        assert!(decided.payload_at_decision.is_some());
    }

    #[test]
    fn approval_weather_resume_uses_approved_version_when_latest_changed() {
        let mut repository = repo();
        set_current_weather_approval_mode(&mut repository, "always_review");
        grant_current_weather_all_runtime_capabilities(&repository);
        let approved_version = repository
            .latest_workflow_version("current-weather")
            .unwrap()
            .unwrap()
            .version;
        let blocked = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();
        let approval = repository.list_pending_approvals().unwrap().remove(0);
        let (approved, changed) = repository
            .resolve_approval(&approval.id, "approved", Some("reviewed"))
            .unwrap();
        assert!(changed);

        let mut changed_workflow = crate::workflow::current_weather();
        changed_workflow.name = "Changed Current Weather".into();
        repository
            .create_workflow_version(
                changed_workflow,
                WorkflowStatus::Enabled,
                Some("always_review"),
                None,
            )
            .unwrap();

        let resumed = resume_current_weather_run_with_provider(
            &mut repository,
            &approved.unwrap().run_id,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(resumed.run.id, blocked.run.id);
        assert_eq!(resumed.run.status, RunStatus::Succeeded);
        assert_eq!(
            resumed.artifact.unwrap().metadata["workflow_version"],
            serde_json::json!(approved_version)
        );
    }

    #[test]
    fn approval_llm_resume_uses_approved_version_when_latest_changed() {
        let mut repository = repo();
        repository
            .create_workflow_version(
                crate::workflow::daily_work_journal(),
                WorkflowStatus::Enabled,
                Some("always_review"),
                None,
            )
            .unwrap();
        grant_daily_work_journal_all_runtime_capabilities(&repository);
        let approved_version = repository
            .latest_workflow_version("daily-work-journal")
            .unwrap()
            .unwrap()
            .version;
        let generator = FakeGenerator {
            result: Ok(ArtifactEnvelope {
                title: "Approved Journal".into(),
                content_markdown: "# Approved Journal\n\nGenerated.".into(),
                metadata: serde_json::json!({ "provider": "test" }),
                source_refs: vec!["test:source".into()],
            }),
        };
        let blocked = run_workflow_with_generator_and_profile(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &generator,
            "test",
            "test-model",
            "low",
        )
        .unwrap();
        let approval = repository.list_pending_approvals().unwrap().remove(0);
        let (approved, changed) = repository
            .resolve_approval(&approval.id, "approved", Some("reviewed"))
            .unwrap();
        assert!(changed);

        let mut changed_workflow = crate::workflow::daily_work_journal();
        changed_workflow.name = "Changed Journal".into();
        repository
            .create_workflow_version(
                changed_workflow,
                WorkflowStatus::Enabled,
                Some("always_review"),
                None,
            )
            .unwrap();

        let resumed = resume_workflow_with_generator_and_profile(
            &mut repository,
            &approved.unwrap().run_id,
            &generator,
            "test",
            "test-model",
            "low",
        )
        .unwrap();

        assert_eq!(resumed.run.id, blocked.run.id);
        assert_eq!(resumed.run.status, RunStatus::Succeeded);
        assert_eq!(
            resumed.artifact.unwrap().metadata["workflow_version"],
            serde_json::json!(approved_version)
        );
    }

    #[test]
    fn approval_reject_blocks_waiting_run_without_artifact() {
        let mut repository = repo();
        set_current_weather_approval_mode(&mut repository, "always_review");
        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();
        let approval = repository.list_pending_approvals().unwrap().remove(0);

        let (rejected, changed) = repository
            .resolve_approval(&approval.id, "rejected", Some("not today"))
            .unwrap();
        assert!(changed);
        reject_approved_run(&repository, &rejected.unwrap(), Some("not today")).unwrap();

        let persisted = repository.workflow_run(&result.run.id).unwrap().unwrap();
        assert_eq!(persisted.status, RunStatus::Blocked);
        assert_eq!(persisted.failure_reason.as_deref(), Some("not today"));
        assert!(repository
            .artifact_for_run(&result.run.id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn approval_review_changes_skips_after_same_definition_was_approved() {
        let mut repository = repo();
        set_current_weather_approval_mode(&mut repository, "review_changes");
        grant_current_weather_all_runtime_capabilities(&repository);
        let first = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();
        let approval = repository.list_pending_approvals().unwrap().remove(0);
        let (approved, changed) = repository
            .resolve_approval(&approval.id, "approved", Some("baseline"))
            .unwrap();
        assert!(changed);
        resume_current_weather_run_with_provider(
            &mut repository,
            &approved.unwrap().run_id,
            &FakeWeatherProvider,
        )
        .unwrap();

        let second = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(first.run.status, RunStatus::Blocked);
        assert_eq!(second.run.status, RunStatus::Succeeded);
        assert!(repository.list_pending_approvals().unwrap().is_empty());
    }

    #[test]
    fn approval_review_changes_blocks_planned_csv_workflow_without_running_step_leak() {
        let mut repository = repo();
        let draft = crate::workflow::draft_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42\nBeta,inactive,9\nZen,active,7",
        )
        .unwrap();
        let workflow_id = draft.definition.id.clone();
        repository
            .create_workflow_version(
                draft.definition,
                WorkflowStatus::Enabled,
                Some("review_changes"),
                draft.planner_rationale,
            )
            .unwrap();

        let result = run_workflow(&mut repository, &workflow_id, RunTrigger::Manual).unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert_eq!(result.run.required_provider_id.as_deref(), Some("approval"));
        assert!(result.artifact.is_none());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn approval_auto_approve_skips_unless_action_is_explicit_high_risk() {
        let mut repository = repo();
        set_current_weather_approval_mode(&mut repository, "auto_approve");
        grant_current_weather_all_runtime_capabilities(&repository);

        let normal = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(normal.run.status, RunStatus::Succeeded);
        assert!(repository.list_pending_approvals().unwrap().is_empty());

        set_current_weather_high_risk_auto_approve(&mut repository);
        let high_risk = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(high_risk.run.status, RunStatus::Blocked);
        let approval = repository.list_pending_approvals().unwrap().remove(0);
        assert_eq!(approval.risk_level, "high");
    }

    #[test]
    fn approval_agent_task_resume_uses_approved_version_when_latest_changed() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let mut approved_workflow = repository
            .latest_workflow_version("agent-weather-runtime")
            .unwrap()
            .unwrap()
            .definition;
        approved_workflow.steps[0].inputs["allowed_tools"] = serde_json::json!(["web"]);
        repository
            .create_workflow_version(
                approved_workflow,
                WorkflowStatus::Enabled,
                Some("always_review"),
                None,
            )
            .unwrap();
        grant_capability_for_latest_workflow(
            &repository,
            "agent-weather-runtime",
            "local_app.write_artifact",
        );
        grant_capability_for_latest_workflow(
            &repository,
            "agent-weather-runtime",
            "agent.run_task",
        );
        let approved_version = repository
            .latest_workflow_version("agent-weather-runtime")
            .unwrap()
            .unwrap()
            .version;
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };
        let blocked = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();
        let approval = repository.list_pending_approvals().unwrap().remove(0);
        let (approved, changed) = repository
            .resolve_approval(&approval.id, "approved", Some("reviewed"))
            .unwrap();
        assert!(changed);

        let mut changed_workflow = repository
            .latest_workflow_version("agent-weather-runtime")
            .unwrap()
            .unwrap()
            .definition;
        changed_workflow.steps[0].inputs["allowed_tools"] = serde_json::json!(["web", "http"]);
        repository
            .create_workflow_version(
                changed_workflow,
                WorkflowStatus::Enabled,
                Some("always_review"),
                None,
            )
            .unwrap();

        let resumed = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::ApprovedResume(approved.unwrap().run_id),
            &executor,
        )
        .unwrap();

        assert_eq!(resumed.run.id, blocked.run.id);
        assert_eq!(resumed.run.status, RunStatus::Succeeded);
        let artifact = resumed.artifact.unwrap();
        assert_eq!(
            artifact.metadata["workflow_version"],
            serde_json::json!(approved_version)
        );
        assert_eq!(
            artifact.metadata["agent_task"]["allowed_tools"],
            serde_json::json!(["web"])
        );
    }

    fn insert_agent_weather_workflow(repository: &Repository, llm_profile_ref: &str) {
        insert_agent_weather_workflow_with_sink_and_extra_step(
            repository,
            llm_profile_ref,
            "write-artifact",
            None,
        );
    }

    fn insert_agent_weather_workflow_without_sink_grant(
        repository: &Repository,
        llm_profile_ref: &str,
    ) {
        insert_agent_weather_workflow_for_id_with_objective(
            repository,
            "agent-weather-runtime-no-sink-grant",
            llm_profile_ref,
            "write-artifact",
            "What's the weather today in Denver?",
            None,
        );
    }

    fn insert_agent_weather_workflow_without_sink(
        repository: &Repository,
        workflow_id: &str,
        llm_profile_ref: &str,
    ) {
        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: workflow_id.into(),
            name: "Agent Weather Runtime Without Sink".into(),
            description: "Asks an agent for the current weather and persists the result directly."
                .into(),
            permissions: vec!["llm:generate".into(), "network:read".into()],
            defaults: WorkflowDefaults {
                llm_profile_ref: llm_profile_ref.into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![WorkflowStepDefinition {
                kind: WorkflowStepKind::AgentTask,
                id: "ask-ai".into(),
                name: "Ask AI".into(),
                provider: "agent".into(),
                action: "run_task".into(),
                depends_on: vec![],
                permissions: vec!["llm:generate".into(), "network:read".into()],
                inputs: serde_json::json!({
                    "objective": "What's the weather today in Denver?",
                    "output_schema": { "type": "artifact_envelope" },
                    "allowed_tools": ["web"]
                }),
                llm_profile_ref: Some(llm_profile_ref.into()),
                destination_ref: None,
                inline_code: None,
                parallel: None,
            }],
        };

        repository
            .insert_workflow_version(&WorkflowVersion {
                id: format!("{}-v1", workflow.id),
                workflow_id: workflow.id.clone(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow,
                created_at: timestamp(),
                approval_mode: None,
                planner_rationale: None,
            })
            .unwrap();
        grant_capability_for_latest_workflow(repository, workflow_id, "agent.run_task");
    }

    fn insert_agent_weather_workflow_with_extra_step(
        repository: &Repository,
        llm_profile_ref: &str,
        extra_step: Option<WorkflowStepDefinition>,
    ) {
        insert_agent_weather_workflow_with_sink_and_extra_step(
            repository,
            llm_profile_ref,
            "write-artifact",
            extra_step,
        );
    }

    fn insert_agent_weather_workflow_with_sink_and_extra_step(
        repository: &Repository,
        llm_profile_ref: &str,
        sink_step_id: &str,
        extra_step: Option<WorkflowStepDefinition>,
    ) {
        insert_agent_weather_workflow_for_id(
            repository,
            "agent-weather-runtime",
            llm_profile_ref,
            sink_step_id,
            extra_step,
        );
    }

    fn insert_agent_weather_workflow_for_id(
        repository: &Repository,
        workflow_id: &str,
        llm_profile_ref: &str,
        sink_step_id: &str,
        extra_step: Option<WorkflowStepDefinition>,
    ) {
        insert_agent_weather_workflow_for_id_with_objective(
            repository,
            workflow_id,
            llm_profile_ref,
            sink_step_id,
            "What's the weather today in Denver?",
            extra_step,
        );
    }

    fn insert_agent_weather_workflow_for_id_with_objective(
        repository: &Repository,
        workflow_id: &str,
        llm_profile_ref: &str,
        sink_step_id: &str,
        objective: &str,
        extra_step: Option<WorkflowStepDefinition>,
    ) {
        let mut steps = vec![
            WorkflowStepDefinition {
                kind: WorkflowStepKind::AgentTask,
                id: "ask-ai".into(),
                name: "Ask AI".into(),
                provider: "agent".into(),
                action: "run_task".into(),
                depends_on: vec![],
                permissions: vec!["llm:generate".into(), "network:read".into()],
                inputs: serde_json::json!({
                    "objective": objective,
                    "output_schema": { "type": "artifact_envelope" },
                    "allowed_tools": ["web"]
                }),
                llm_profile_ref: Some(llm_profile_ref.into()),
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: sink_step_id.into(),
                name: "Save result locally".into(),
                provider: "local_app".into(),
                action: "write_artifact".into(),
                depends_on: vec!["ask-ai".into()],
                permissions: vec!["artifact:write".into()],
                inputs: serde_json::json!({ "artifact": "$steps.ask-ai.artifact" }),
                llm_profile_ref: None,
                destination_ref: Some("local-app".into()),
                inline_code: None,
                parallel: None,
            },
        ];
        if let Some(extra_step) = extra_step {
            steps.push(extra_step);
        }

        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: workflow_id.into(),
            name: "Agent Weather Runtime".into(),
            description: "Asks an agent for the current weather and stores the result.".into(),
            permissions: vec![
                "llm:generate".into(),
                "network:read".into(),
                "artifact:write".into(),
            ],
            defaults: WorkflowDefaults {
                llm_profile_ref: llm_profile_ref.into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps,
        };
        let workflow_id = workflow.id.clone();

        repository
            .insert_workflow_version(&WorkflowVersion {
                id: format!("{}-v1", workflow.id),
                workflow_id: workflow.id.clone(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow,
                created_at: timestamp(),
                approval_mode: None,
                planner_rationale: None,
            })
            .unwrap();
        if workflow_id != "agent-weather-runtime-no-agent-grant" {
            grant_capability_for_latest_workflow(repository, &workflow_id, "agent.run_task");
        }
        if workflow_id != "agent-weather-runtime-no-sink-grant" {
            grant_capability_for_latest_workflow(
                repository,
                &workflow_id,
                "local_app.write_artifact",
            );
        }
    }

    fn insert_plugin_artifact_workflow(repository: &Repository, approval_mode: &str) {
        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "plugin-artifact-runtime".into(),
            name: "Plugin Artifact Runtime".into(),
            description: "Builds and saves an artifact through a deterministic plugin.".into(),
            permissions: vec!["plugin:execute".into(), "artifact:write".into()],
            defaults: WorkflowDefaults {
                llm_profile_ref: "default-openai".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "build-artifact".into(),
                    name: "Build plugin artifact".into(),
                    provider: "deterministic_artifact".into(),
                    action: "build_artifact".into(),
                    depends_on: vec![],
                    permissions: vec!["plugin:execute".into()],
                    inputs: serde_json::json!({ "subject": "Task 11" }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "write-artifact".into(),
                    name: "Save plugin artifact".into(),
                    provider: "local_app".into(),
                    action: "write_artifact".into(),
                    depends_on: vec!["build-artifact".into()],
                    permissions: vec!["artifact:write".into()],
                    inputs: serde_json::json!({ "artifact": "$steps.build-artifact.artifact" }),
                    llm_profile_ref: None,
                    destination_ref: Some("local-app".into()),
                    inline_code: None,
                    parallel: None,
                },
            ],
        };

        repository
            .insert_workflow_version(&WorkflowVersion {
                id: "plugin-artifact-runtime-v1".into(),
                workflow_id: workflow.id.clone(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow,
                created_at: timestamp(),
                approval_mode: Some(approval_mode.into()),
                planner_rationale: None,
            })
            .unwrap();
    }

    fn insert_plugin_artifact_workflow_without_sink(
        repository: &Repository,
        workflow_id: &str,
        approval_mode: &str,
    ) {
        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: workflow_id.into(),
            name: "Plugin Artifact Runtime Without Sink".into(),
            description:
                "Builds an artifact through a deterministic plugin and persists it directly.".into(),
            permissions: vec!["plugin:execute".into(), "artifact:write".into()],
            defaults: WorkflowDefaults {
                llm_profile_ref: "default-openai".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "build-artifact".into(),
                name: "Build plugin artifact".into(),
                provider: "deterministic_artifact".into(),
                action: "build_artifact".into(),
                depends_on: vec![],
                permissions: vec!["plugin:execute".into()],
                inputs: serde_json::json!({ "subject": "Task 11" }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            }],
        };

        repository
            .insert_workflow_version(&WorkflowVersion {
                id: format!("{}-v1", workflow.id),
                workflow_id: workflow.id.clone(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow,
                created_at: timestamp(),
                approval_mode: Some(approval_mode.into()),
                planner_rationale: None,
            })
            .unwrap();
    }

    fn insert_mixed_http_probe_agent_workflow(repository: &Repository) {
        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "mixed-http-probe-agent-runtime".into(),
            name: "Mixed HTTP Probe Agent Runtime".into(),
            description: "Checks URLs, asks an agent to summarize, and saves the report.".into(),
            permissions: vec![
                "network:read".into(),
                "llm:generate".into(),
                "artifact:write".into(),
            ],
            defaults: WorkflowDefaults {
                llm_profile_ref: "codex-oauth-local".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "check-sites".into(),
                    name: "Check sites".into(),
                    provider: "http_probe".into(),
                    action: "check_urls".into(),
                    depends_on: vec![],
                    permissions: vec!["network:read".into()],
                    inputs: serde_json::json!({
                        "urls": [probe_server_url()],
                        "timeout_ms": 1_000,
                        "accepted_status_codes": [200]
                    }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::AgentTask,
                    id: "compile-report".into(),
                    name: "Compile report".into(),
                    provider: "agent".into(),
                    action: "run_task".into(),
                    depends_on: vec!["check-sites".into()],
                    permissions: vec!["llm:generate".into()],
                    inputs: serde_json::json!({
                        "objective": "Summarize the deterministic URL probe results.",
                        "output_schema": { "type": "artifact_envelope" },
                        "allowed_tools": []
                    }),
                    llm_profile_ref: Some("codex-oauth-local".into()),
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "write-artifact".into(),
                    name: "Save report".into(),
                    provider: "local_app".into(),
                    action: "write_artifact".into(),
                    depends_on: vec!["compile-report".into()],
                    permissions: vec!["artifact:write".into()],
                    inputs: serde_json::json!({ "artifact": "$steps.compile-report.artifact" }),
                    llm_profile_ref: None,
                    destination_ref: Some("local-app".into()),
                    inline_code: None,
                    parallel: None,
                },
            ],
        };

        repository
            .insert_workflow_version(&WorkflowVersion {
                id: "mixed-http-probe-agent-runtime-v1".into(),
                workflow_id: workflow.id.clone(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow,
                created_at: timestamp(),
                approval_mode: None,
                planner_rationale: None,
            })
            .unwrap();
        grant_capability_for_latest_workflow(
            repository,
            "mixed-http-probe-agent-runtime",
            "local_app.write_artifact",
        );
        grant_capability_for_latest_workflow(
            repository,
            "mixed-http-probe-agent-runtime",
            "agent.run_task",
        );
    }

    fn insert_data_provider_artifact_workflow(repository: &Repository) {
        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "data-provider-artifact-runtime".into(),
            name: "Data Provider Artifact Runtime".into(),
            description: "Parses and shapes CSV data with deterministic providers.".into(),
            permissions: vec!["data:read".into(), "artifact:write".into()],
            defaults: WorkflowDefaults {
                llm_profile_ref: "default-openai".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "parse".into(),
                    name: "Parse CSV".into(),
                    provider: "data".into(),
                    action: "parse_csv".into(),
                    depends_on: vec![],
                    permissions: vec!["data:read".into()],
                    inputs: serde_json::json!({
                        "content": "name,team,score\nAda,runtime,3\nGrace,data,1\nLinus,runtime,2",
                        "has_headers": true
                    }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "shape".into(),
                    name: "Shape rows".into(),
                    provider: "data".into(),
                    action: "transform_json".into(),
                    depends_on: vec!["parse".into()],
                    permissions: vec!["data:read".into()],
                    inputs: serde_json::json!({
                        "data": "$steps.parse.rows",
                        "filter_equals": { "team": "runtime" },
                        "select_fields": ["name", "score"],
                        "sort_by": "score"
                    }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "write-artifact".into(),
                    name: "Save shaped data".into(),
                    provider: "local_app".into(),
                    action: "write_artifact".into(),
                    depends_on: vec!["shape".into()],
                    permissions: vec!["artifact:write".into()],
                    inputs: serde_json::json!({
                        "title": "Runtime Scores",
                        "artifact_type": "data_report",
                        "artifact": "$steps.shape.records"
                    }),
                    llm_profile_ref: None,
                    destination_ref: Some("local-app".into()),
                    inline_code: None,
                    parallel: None,
                },
            ],
        };

        repository
            .insert_workflow_version(&WorkflowVersion {
                id: "data-provider-artifact-runtime-v1".into(),
                workflow_id: workflow.id.clone(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow,
                created_at: timestamp(),
                approval_mode: None,
                planner_rationale: None,
            })
            .unwrap();
    }

    fn insert_unregistered_provider_workflow(repository: &Repository) {
        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "unregistered-provider-runtime".into(),
            name: "Unregistered Provider Runtime".into(),
            description: "Exercises runtime registry enforcement.".into(),
            permissions: vec!["unknown:execute".into()],
            defaults: WorkflowDefaults {
                llm_profile_ref: "default-openai".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "unknown-step".into(),
                name: "Unknown provider action".into(),
                provider: "unknown_provider".into(),
                action: "do_thing".into(),
                depends_on: vec![],
                permissions: vec!["unknown:execute".into()],
                inputs: serde_json::json!({ "value": true }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            }],
        };

        repository
            .insert_workflow_version(&WorkflowVersion {
                id: "unregistered-provider-runtime-v1".into(),
                workflow_id: workflow.id.clone(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow,
                created_at: timestamp(),
                approval_mode: None,
                planner_rationale: None,
            })
            .unwrap();
    }

    fn insert_mixed_weather_rss_agent_workflow(repository: &Repository) {
        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "mixed-weather-rss-agent-runtime".into(),
            name: "Mixed Weather RSS Agent Runtime".into(),
            description: "Collects deterministic planning context before agent synthesis.".into(),
            permissions: vec![
                "weather:read".into(),
                "network:read".into(),
                "llm:generate".into(),
                "artifact:write".into(),
            ],
            defaults: WorkflowDefaults {
                llm_profile_ref: "codex-oauth-local".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "weather-alerts".into(),
                    name: "Fetch weather alerts".into(),
                    provider: "weather".into(),
                    action: "alerts".into(),
                    depends_on: vec![],
                    permissions: vec!["weather:read".into()],
                    inputs: serde_json::json!({ "location": "Denver, CO" }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "headlines".into(),
                    name: "Fetch headlines".into(),
                    provider: "rss".into(),
                    action: "fetch_feed".into(),
                    depends_on: vec![],
                    permissions: vec!["network:read".into()],
                    inputs: serde_json::json!({
                        "url": "https://example.com/feed.xml",
                        "body_text": "<rss><channel><title>Fixture</title><item><title>Deterministic workflow tools ship</title><link>https://example.com/news</link><description>Roadmap tools can now run before agents.</description></item></channel></rss>"
                    }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::AgentTask,
                    id: "summarize".into(),
                    name: "Summarize planning context".into(),
                    provider: "agent".into(),
                    action: "run_task".into(),
                    depends_on: vec!["weather-alerts".into(), "headlines".into()],
                    permissions: vec!["llm:generate".into()],
                    inputs: serde_json::json!({
                        "objective": "Summarize deterministic weather and headline context.",
                        "output_schema": { "type": "artifact_envelope" },
                        "allowed_tools": []
                    }),
                    llm_profile_ref: Some("codex-oauth-local".into()),
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "write-artifact".into(),
                    name: "Save summary".into(),
                    provider: "local_app".into(),
                    action: "write_artifact".into(),
                    depends_on: vec!["summarize".into()],
                    permissions: vec!["artifact:write".into()],
                    inputs: serde_json::json!({ "artifact": "$steps.summarize.artifact" }),
                    llm_profile_ref: None,
                    destination_ref: Some("local-app".into()),
                    inline_code: None,
                    parallel: None,
                },
            ],
        };

        repository
            .insert_workflow_version(&WorkflowVersion {
                id: "mixed-weather-rss-agent-runtime-v1".into(),
                workflow_id: workflow.id.clone(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: workflow,
                created_at: timestamp(),
                approval_mode: None,
                planner_rationale: None,
            })
            .unwrap();
        grant_capability_for_latest_workflow(
            repository,
            "mixed-weather-rss-agent-runtime",
            "local_app.write_artifact",
        );
        grant_capability_for_latest_workflow(
            repository,
            "mixed-weather-rss-agent-runtime",
            "agent.run_task",
        );
    }

    fn probe_server_url() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 1024];
                let _ = stream.read(&mut buffer);
                let body = "ok";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{address}/health")
    }

    fn weather_agent_envelope() -> AgentTaskEnvelope {
        AgentTaskEnvelope {
            title: "Weather Today".into(),
            content_markdown: "# Weather Today\n\nDenver is mild and clear.".into(),
            metadata: serde_json::json!({ "kind": "agent_task" }),
            source_refs: vec!["web:weather".into()],
            tool_trace: vec![ToolTraceEntry {
                tool_id: "web.search".into(),
                status: "succeeded".into(),
                input_summary: serde_json::json!({ "query": "Denver weather today" }),
                output_summary: Some(serde_json::json!({ "summary": "mild and clear" })),
                source_refs: vec!["web:weather".into()],
                error: None,
            }],
            raw_result_json: serde_json::json!({ "temperature": "74 F" }),
        }
    }

    fn site_report_agent_envelope() -> AgentTaskEnvelope {
        AgentTaskEnvelope {
            title: "Site Check Report".into(),
            content_markdown: "# Site Check Report\n\nAll configured sites are reachable.".into(),
            metadata: serde_json::json!({ "kind": "agent_task" }),
            source_refs: vec![],
            tool_trace: vec![],
            raw_result_json: serde_json::json!({ "summary": "all reachable" }),
        }
    }

    #[test]
    fn deterministic_provider_runtime_executes_data_steps_and_writes_artifact() {
        let mut repository = repo();
        insert_data_provider_artifact_workflow(&repository);
        grant_capability_for_latest_workflow(
            &repository,
            "data-provider-artifact-runtime",
            "local_app.write_artifact",
        );

        let result = run_workflow(
            &mut repository,
            "data-provider-artifact-runtime",
            RunTrigger::Manual,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.failure_reason
        );
        let artifact = result.artifact.unwrap();
        assert_eq!(artifact.title, "Runtime Scores");
        assert_eq!(artifact.artifact_type, "data_report");
        assert!(artifact.content_markdown.contains("\"Linus\""));
        assert!(artifact.content_markdown.contains("\"Ada\""));

        let step_runs = repository
            .workflow_step_runs_for_run(&result.run.id)
            .unwrap();
        let shape = step_runs
            .iter()
            .find(|step| step.step_id == "shape")
            .unwrap();
        assert_eq!(shape.status, RunStatus::Succeeded);
        assert_eq!(
            shape.output_json.as_ref().unwrap()["count"],
            serde_json::json!(2)
        );
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn runtime_blocks_unregistered_capability() {
        let mut repository = repo();
        insert_unregistered_provider_workflow(&repository);

        let result = run_workflow(
            &mut repository,
            "unregistered-provider-runtime",
            RunTrigger::Manual,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert_eq!(result.run.required_provider_id.as_deref(), Some("approval"));
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("unregistered"));

        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].step_id, "unknown-step");
        assert_eq!(events[0].capability_id, "unknown_provider.do_thing");
        assert_eq!(events[0].decision, "blocked");
    }

    #[test]
    fn runtime_blocks_write_without_required_grant() {
        let mut repository = repo();
        insert_data_provider_artifact_workflow(&repository);

        let result = run_workflow(
            &mut repository,
            "data-provider-artifact-runtime",
            RunTrigger::Manual,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert_eq!(result.run.required_provider_id.as_deref(), Some("approval"));
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("local_app.write_artifact"));
        assert!(result.artifact.is_none());

        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let write_event = events
            .iter()
            .find(|event| event.step_id == "write-artifact")
            .unwrap();
        assert_eq!(write_event.capability_id, "local_app.write_artifact");
        assert_eq!(write_event.decision, "needs_grant");
        assert!(write_event.grant_id.is_none());
    }

    #[test]
    fn runtime_blocks_write_when_grant_path_scope_mismatches_generated_artifact_path() {
        let mut repository = repo();
        insert_data_provider_artifact_workflow(&repository);
        grant_capability_for_latest_workflow_with_paths(
            &repository,
            "data-provider-artifact-runtime",
            "local_app.write_artifact",
            vec!["/tmp/not-raven-artifacts/*.md".into()],
        );

        let result = run_workflow(
            &mut repository,
            "data-provider-artifact-runtime",
            RunTrigger::Manual,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("scope matches"));
        assert!(result.artifact.is_none());
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let write_event = events
            .iter()
            .find(|event| event.step_id == "write-artifact")
            .unwrap();
        assert_eq!(write_event.decision, "needs_grant");
        assert!(write_event.grant_id.is_none());
    }

    #[test]
    fn agent_runtime_blocks_local_app_sink_without_required_grant() {
        let mut repository = repo();
        insert_agent_weather_workflow_without_sink_grant(&repository, "codex-oauth-local");
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime-no-sink-grant",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert_eq!(result.run.required_provider_id.as_deref(), Some("approval"));
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("local_app.write_artifact"));
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let sink_event = events
            .iter()
            .find(|event| event.step_id == "write-artifact")
            .unwrap();
        assert_eq!(sink_event.capability_id, "local_app.write_artifact");
        assert_eq!(sink_event.decision, "needs_grant");
        assert!(sink_event.grant_id.is_none());
    }

    #[test]
    fn agent_runtime_blocks_agent_task_without_required_grant() {
        let mut repository = repo();
        insert_agent_weather_workflow_for_id(
            &repository,
            "agent-weather-runtime-no-agent-grant",
            "codex-oauth-local",
            "write-artifact",
            None,
        );
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime-no-agent-grant",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert_eq!(result.run.required_provider_id.as_deref(), Some("approval"));
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("agent.run_task"));
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let agent_event = events
            .iter()
            .find(|event| event.step_id == "ask-ai")
            .unwrap();
        assert_eq!(agent_event.capability_id, "agent.run_task");
        assert_eq!(agent_event.decision, "needs_grant");
        assert!(agent_event.grant_id.is_none());
    }

    #[test]
    fn agent_runtime_blocks_generated_artifact_persistence_without_explicit_sink_grant() {
        let mut repository = repo();
        insert_agent_weather_workflow_without_sink(
            &repository,
            "agent-weather-runtime-without-sink",
            "codex-oauth-local",
        );
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime-without-sink",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert_eq!(result.run.required_provider_id.as_deref(), Some("approval"));
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("local_app.write_artifact"));
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let write_event = events
            .iter()
            .find(|event| event.capability_id == "local_app.write_artifact")
            .unwrap();
        assert_eq!(write_event.step_id, "persist-artifact");
        assert_eq!(write_event.decision, "needs_grant");
        assert!(write_event.grant_id.is_none());
    }

    #[test]
    fn agent_runtime_rejects_pre_agent_local_app_write_sink_as_unsupported_shape() {
        let steps = vec![
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "write-before-agent".into(),
                name: "Write before agent".into(),
                provider: "local_app".into(),
                action: "write_artifact".into(),
                depends_on: vec![],
                permissions: vec!["artifact:write".into()],
                inputs: serde_json::json!({ "artifact": "too early" }),
                llm_profile_ref: None,
                destination_ref: Some("local-app".into()),
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::AgentTask,
                id: "ask-ai".into(),
                name: "Ask AI".into(),
                provider: "agent".into(),
                action: "run_task".into(),
                depends_on: vec!["write-before-agent".into()],
                permissions: vec!["llm:generate".into()],
                inputs: serde_json::json!({ "objective": "Summarize." }),
                llm_profile_ref: Some("codex-oauth-local".into()),
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
        ];

        assert!(!is_deterministic_provider_action_step(&steps[0]));
        let error = unsupported_agent_runtime_shape(&steps).unwrap();
        assert!(error.contains("write-before-agent"));
        assert!(error.contains("local_app/write_artifact"));
    }

    #[test]
    fn local_app_write_artifact_registry_descriptor_is_sink_not_deterministic_provider() {
        let snapshot = crate::capability_registry::builtin_registry_snapshot();
        let capability = snapshot
            .capabilities
            .iter()
            .find(|capability| capability.id == "local_app.write_artifact")
            .unwrap();

        assert!(!capability.deterministic);
        assert!(capability.writes_files);
        assert_eq!(capability.status, CapabilityAvailability::Available);

        let step = WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "write-artifact".into(),
            name: "Write artifact".into(),
            provider: "local_app".into(),
            action: "write_artifact".into(),
            depends_on: vec![],
            permissions: vec!["artifact:write".into()],
            inputs: serde_json::json!({ "artifact": "content" }),
            llm_profile_ref: None,
            destination_ref: Some("local-app".into()),
            inline_code: None,
            parallel: None,
        };
        assert!(!is_deterministic_provider_action_step_with_registry(
            &step, &snapshot
        ));
    }

    #[test]
    fn deterministic_provider_artifact_write_failure_marks_run_failed() {
        let dir = std::env::temp_dir().join(format!(
            "raven-runtime-artifact-failure-test-{}",
            uuid::Uuid::new_v4()
        ));
        let mut repository = repo_at(&dir);
        insert_data_provider_artifact_workflow(&repository);
        grant_capability_for_latest_workflow(
            &repository,
            "data-provider-artifact-runtime",
            "local_app.write_artifact",
        );
        let artifacts_path = dir.join("artifacts");
        std::fs::remove_dir_all(&artifacts_path).unwrap();
        std::fs::write(&artifacts_path, "not a directory").unwrap();

        let result = run_workflow(
            &mut repository,
            "data-provider-artifact-runtime",
            RunTrigger::Manual,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Failed);
        assert!(result.run.failure_reason.is_some());
        assert!(result.artifact.is_none());
        let persisted = repository.workflow_run(&result.run.id).unwrap().unwrap();
        assert_eq!(persisted.status, RunStatus::Failed);
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn mixed_runtime_passes_weather_and_rss_outputs_to_agent_without_tools() {
        let mut repository = repo();
        insert_mixed_weather_rss_agent_workflow(&repository);
        grant_capability_for_latest_workflow(
            &repository,
            "mixed-weather-rss-agent-runtime",
            "weather.alerts",
        );
        grant_capability_for_latest_workflow(
            &repository,
            "mixed-weather-rss-agent-runtime",
            "rss.fetch_feed",
        );
        let recorded_request = std::sync::Arc::new(std::sync::Mutex::new(None));
        let executor = RecordingAgentExecutor {
            request: recorded_request.clone(),
            envelope: site_report_agent_envelope(),
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "mixed-weather-rss-agent-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.failure_reason
        );
        let request = recorded_request.lock().unwrap().clone().unwrap();
        assert!(request.tool_manifest.is_empty());
        assert_eq!(
            request.prior_step_outputs["weather-alerts"]["status"],
            serde_json::json!("unsupported")
        );
        assert_eq!(
            request.prior_step_outputs["headlines"]["entries"][0]["title"],
            serde_json::json!("Deterministic workflow tools ship")
        );
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    fn assert_run_error_event(
        events: &[crate::models::AgentEvent],
        run_id: &str,
        expected_error: &str,
        expected_classification: &str,
    ) {
        assert!(
            events.iter().any(|event| matches!(
                event,
                crate::models::AgentEvent::RunError {
                    run_id: event_run_id,
                    error,
                    classification,
                    ..
                } if event_run_id == run_id
                    && error.contains(expected_error)
                    && classification == expected_classification
            )),
            "missing RUN_ERROR containing {expected_error:?} and classification {expected_classification:?}; events: {events:?}"
        );
    }

    #[test]
    fn agent_task_run_persists_artifact_without_dedicated_capability() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.failure_reason
        );
        let artifact = result.artifact.unwrap();
        assert!(artifact.content_markdown.contains("Weather Today"));
        assert_eq!(
            artifact.metadata["agent_task"]["profile_id"],
            "codex-oauth-local"
        );
        assert_eq!(artifact.metadata["agent_task"]["model"], "gpt-5.4");
        assert_eq!(artifact.metadata["agent_task"]["effort"], "medium");
        assert_eq!(
            artifact.metadata["agent_task"]["allowed_tools"],
            serde_json::json!(["web"])
        );
        assert!(artifact.metadata["agent_task"]["tool_manifest_hash"].is_string());
        assert_eq!(
            artifact.metadata["agent_task"]["tool_trace"][0]["tool_id"],
            "web.search"
        );
        assert_eq!(
            artifact.metadata["agent_task"]["raw_result_json"]["temperature"],
            "74 F"
        );

        let events = repository
            .agent_tool_events_for_run(&result.run.id)
            .unwrap();
        assert!(!events.is_empty());
        assert!(events
            .iter()
            .any(|event| event.status == AgentToolEventStatus::Succeeded
                && event.completed_at.is_some()));
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn mixed_runtime_runs_http_probe_then_agent_then_writes_artifact() {
        let mut repository = repo();
        insert_mixed_http_probe_agent_workflow(&repository);
        let executor = FakeAgentExecutor {
            error: None,
            envelope: Some(site_report_agent_envelope()),
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "mixed-http-probe-agent-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.failure_reason
        );
        let artifact = result.artifact.unwrap();
        assert!(std::path::Path::new(&artifact.content_path).exists());
        assert_eq!(
            std::fs::read_to_string(&artifact.content_path).unwrap(),
            "# Site Check Report\n\nAll configured sites are reachable."
        );

        let step_runs = repository
            .workflow_step_runs_for_run(&result.run.id)
            .unwrap();
        assert_eq!(
            step_runs
                .iter()
                .filter(|step| step.status == RunStatus::Succeeded)
                .count(),
            3
        );
        let probe_step = step_runs
            .iter()
            .find(|step| step.step_id == "check-sites")
            .unwrap();
        assert!(probe_step.output_json.as_ref().unwrap()["results"].is_array());
        assert_eq!(
            probe_step.output_json.as_ref().unwrap()["results"][0]["ok"],
            serde_json::json!(true)
        );
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn mixed_runtime_passes_probe_output_to_agent_without_web_tools() {
        let mut repository = repo();
        insert_mixed_http_probe_agent_workflow(&repository);
        let recorded_request = std::sync::Arc::new(std::sync::Mutex::new(None));
        let executor = RecordingAgentExecutor {
            request: recorded_request.clone(),
            envelope: site_report_agent_envelope(),
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "mixed-http-probe-agent-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.failure_reason
        );
        let request = recorded_request.lock().unwrap().clone().unwrap();
        assert!(request.tool_manifest.is_empty());
        assert!(request.prior_step_outputs["check-sites"]["results"].is_array());
        assert_eq!(
            request.prior_step_outputs["check-sites"]["results"][0]["ok"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn mixed_runtime_preserves_http_probe_output_when_agent_executor_fails() {
        let mut repository = repo();
        insert_mixed_http_probe_agent_workflow(&repository);
        let executor = FakeAgentExecutor {
            error: Some("model unavailable".into()),
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "mixed-http-probe-agent-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Retryable);
        assert!(result.artifact.is_none());

        let step_runs = repository
            .workflow_step_runs_for_run(&result.run.id)
            .unwrap();
        let probe_step = step_runs
            .iter()
            .find(|step| step.step_id == "check-sites")
            .unwrap();
        assert_eq!(probe_step.status, RunStatus::Succeeded);
        assert_eq!(
            probe_step.output_json.as_ref().unwrap()["results"][0]["ok"],
            serde_json::json!(true)
        );
        let agent_step = step_runs
            .iter()
            .find(|step| step.step_id == "compile-report")
            .unwrap();
        assert_eq!(agent_step.status, RunStatus::Retryable);
        assert!(agent_step.output_json.is_none());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn mixed_runtime_preserves_http_probe_output_when_agent_auth_blocks() {
        let mut repository = repo();
        insert_mixed_http_probe_agent_workflow(&repository);
        let executor = FakeAgentExecutor {
            error: Some("not logged in".into()),
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "mixed-http-probe-agent-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());

        let step_runs = repository
            .workflow_step_runs_for_run(&result.run.id)
            .unwrap();
        let probe_step = step_runs
            .iter()
            .find(|step| step.step_id == "check-sites")
            .unwrap();
        assert_eq!(probe_step.status, RunStatus::Succeeded);
        assert_eq!(
            probe_step.output_json.as_ref().unwrap()["results"][0]["ok"],
            serde_json::json!(true)
        );
        let agent_step = step_runs
            .iter()
            .find(|step| step.step_id == "compile-report")
            .unwrap();
        assert_eq!(agent_step.status, RunStatus::Blocked);
        assert!(agent_step.output_json.is_none());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn mixed_runtime_resume_skips_completed_http_probe_after_agent_failure() {
        let mut repository = repo();
        insert_mixed_http_probe_agent_workflow(&repository);
        let failing_executor = FakeAgentExecutor {
            error: Some("model unavailable".into()),
            envelope: None,
        };

        let first = run_workflow_with_agent_executor(
            &mut repository,
            "mixed-http-probe-agent-runtime",
            RunTrigger::Manual,
            &failing_executor,
        )
        .unwrap();
        assert_eq!(first.run.status, RunStatus::Retryable);

        let recorded_request = std::sync::Arc::new(std::sync::Mutex::new(None));
        let succeeding_executor = RecordingAgentExecutor {
            request: recorded_request.clone(),
            envelope: site_report_agent_envelope(),
        };
        let resumed = run_workflow_with_agent_executor(
            &mut repository,
            "mixed-http-probe-agent-runtime",
            RunTrigger::ApprovedResume(first.run.id.clone()),
            &succeeding_executor,
        )
        .unwrap();

        assert_eq!(
            resumed.run.status,
            RunStatus::Succeeded,
            "{:?}",
            resumed.run.failure_reason
        );
        let request = recorded_request.lock().unwrap().clone().unwrap();
        assert_eq!(
            request.prior_step_outputs["check-sites"]["results"][0]["ok"],
            serde_json::json!(true)
        );

        let step_runs = repository
            .workflow_step_runs_for_run(&resumed.run.id)
            .unwrap();
        let probe_step = step_runs
            .iter()
            .find(|step| step.step_id == "check-sites")
            .unwrap();
        assert_eq!(probe_step.status, RunStatus::Succeeded);
        assert!(probe_step.output_json.is_some());
        assert_all_step_runs_terminal(&repository, &resumed.run.id);
    }

    #[test]
    fn agent_task_run_emits_tool_trace_events_from_executor_output() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let sink = crate::stream::EventLog::default();
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor_and_event_sink(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
            &sink,
        )
        .unwrap();
        let events = sink.events();
        let kinds = events
            .iter()
            .map(|event| event.kind_name())
            .collect::<Vec<_>>();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.failure_reason
        );
        assert!(kinds
            .windows(2)
            .any(|window| window == ["TOOL_CALL_START", "TOOL_CALL_END"]));
        assert!(events.iter().any(|event| matches!(
            event,
            crate::models::AgentEvent::ThinkingContent { content, .. }
                if content.contains("Executing agent task")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            crate::models::AgentEvent::TextMessageContent { content, .. }
                if content.contains("Weather Today")
        )));
    }

    #[test]
    fn agent_task_runtime_redacts_token_shaped_values_before_persistence() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let secret = ["sk", "test-agent-runtime-secret"].join("-");
        let executor = FakeAgentExecutor {
            error: None,
            envelope: Some(AgentTaskEnvelope {
                title: "Weather Today".into(),
                content_markdown: "# Weather Today\n\nDenver is mild and clear.".into(),
                metadata: serde_json::json!({
                    "secret": &secret,
                    "nested": { "token": &secret }
                }),
                source_refs: vec![format!("web:{secret}")],
                tool_trace: vec![ToolTraceEntry {
                    tool_id: "web.search".into(),
                    status: "succeeded".into(),
                    input_summary: serde_json::json!({ "query": &secret }),
                    output_summary: Some(serde_json::json!({ "result": &secret })),
                    source_refs: vec![format!("trace:{secret}")],
                    error: Some(format!("temporary error {secret}")),
                }],
                raw_result_json: serde_json::json!({ "raw": &secret }),
            }),
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.failure_reason
        );
        let artifact = result.artifact.unwrap();
        assert!(!artifact.metadata.to_string().contains(&secret));
        assert!(!artifact.content_path.contains(&secret));
        assert!(!artifact.metadata_path.contains(&secret));
        let metadata_file = std::fs::read_to_string(&artifact.metadata_path).unwrap();
        assert!(!metadata_file.contains(&secret));
        let events = repository
            .agent_tool_events_for_run(&result.run.id)
            .unwrap();
        assert!(!format!("{events:?}").contains(&secret));
    }

    #[test]
    fn agent_task_runtime_redacts_sensitive_key_values_before_persistence() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let executor = FakeAgentExecutor {
            error: None,
            envelope: Some(AgentTaskEnvelope {
                title: "Weather Today".into(),
                content_markdown: "# Weather Today\n\nDenver is mild and clear.".into(),
                metadata: serde_json::json!({
                    "api_key": "plain-secret",
                    "apiKey": "plain-secret",
                    "github_token": "plain-secret",
                    "openai_api_key": "abcd1234",
                    "auth_header": "plain-secret",
                    "authorization_header": "abcd1234",
                    "credentialRef": "plain-secret",
                    "nested": { "token": "abcd1234" },
                    "credential_ref": "plain-secret"
                }),
                source_refs: vec!["web:weather".into()],
                tool_trace: vec![ToolTraceEntry {
                    tool_id: "web.search".into(),
                    status: "succeeded".into(),
                    input_summary: serde_json::json!({
                        "authorization": "abcd1234",
                        "normal": "safe"
                    }),
                    output_summary: Some(serde_json::json!({
                        "client_secret": "plain-secret",
                        "client_secret_value": "abcd1234"
                    })),
                    source_refs: vec!["trace:weather".into()],
                    error: Some("safe error".into()),
                }],
                raw_result_json: serde_json::json!({
                    "refresh_token": "abcd1234",
                    "private_key": "plain-secret",
                    "private_key_pem": "abcd1234"
                }),
            }),
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.blocked_reason
        );
        let artifact = result.artifact.unwrap();
        let metadata_file = std::fs::read_to_string(&artifact.metadata_path).unwrap();
        let events = repository
            .agent_tool_events_for_run(&result.run.id)
            .unwrap();
        let persisted = format!("{}{}{:?}", artifact.metadata, metadata_file, events);
        assert!(!persisted.contains("plain-secret"));
        assert!(!persisted.contains("abcd1234"));
        assert!(persisted.contains("[redacted]"));
    }

    #[test]
    fn agent_task_runtime_redacts_sensitive_assignments_in_unstructured_text() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let executor = FakeAgentExecutor {
            error: None,
            envelope: Some(AgentTaskEnvelope {
                title: "Weather openai_api_key: abcd1234".into(),
                content_markdown: "# Weather\n\ngithub_token=plain-secret\nauth_header: plain-secret\ncredentialRef: plain-secret\nclient_secret_value=plain-secret\nprivate_key_pem: plain-secret".into(),
                metadata: serde_json::json!({
                    "note": "authorization_header: abcd1234"
                }),
                source_refs: vec!["source github_token=plain-secret".into()],
                tool_trace: vec![ToolTraceEntry {
                    tool_id: "web.search".into(),
                    status: "succeeded".into(),
                    input_summary: serde_json::json!({ "query": "auth_header: plain-secret" }),
                    output_summary: Some(serde_json::json!({
                        "text": "client_secret_value=plain-secret"
                    })),
                    source_refs: vec!["trace credentialRef: plain-secret".into()],
                    error: Some("private_key_pem: plain-secret".into()),
                }],
                raw_result_json: serde_json::json!({
                    "summary": "openai_api_key: abcd1234"
                }),
            }),
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.blocked_reason
        );
        let artifact = result.artifact.unwrap();
        let markdown_file = std::fs::read_to_string(&artifact.content_path).unwrap();
        let metadata_file = std::fs::read_to_string(&artifact.metadata_path).unwrap();
        let events = repository
            .agent_tool_events_for_run(&result.run.id)
            .unwrap();
        let persisted = format!(
            "{}{}{}{}{:?}",
            artifact.title,
            markdown_file,
            metadata_file,
            artifact.source_refs.join("\n"),
            events
        );
        for raw in ["plain-secret", "abcd1234"] {
            assert!(
                !persisted.contains(raw),
                "{raw} leaked into persisted output"
            );
        }
        assert!(persisted.contains("[redacted]"));
    }

    #[test]
    fn agent_task_runtime_redacts_full_sensitive_assignment_values() {
        let raw = concat!(
            "Authorization: Bearer abc123\n",
            "token = Basic abc123\n",
            "openai_api_key=\"plain secret value\"\n",
            "client_secret_value=plain secret value; keep=this"
        );

        let sanitized = sanitize_agent_text(raw);

        for leaked in ["Bearer abc123", "Basic abc123", "plain secret value"] {
            assert!(
                !sanitized.contains(leaked),
                "{leaked} leaked in {sanitized}"
            );
        }
        assert!(sanitized.contains("Authorization: [redacted]"));
        assert!(sanitized.contains("token = [redacted]"));
        assert!(sanitized.contains("openai_api_key=[redacted]"));
        assert!(sanitized.contains("client_secret_value=[redacted]; keep=this"));
    }

    #[test]
    fn agent_task_tool_event_insert_failure_marks_run_and_steps_terminal() {
        let mut repository = repo();
        insert_agent_weather_workflow_for_id_with_objective(
            &repository,
            "agent-weather-runtime",
            "codex-oauth-local",
            "write-artifact",
            "github_token=plain-secret",
            None,
        );
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Failed);
        assert!(result.artifact.is_none());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn agent_task_tool_event_complete_failure_marks_run_and_steps_terminal() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let executor = FakeAgentExecutor {
            error: Some("github_token=plain-secret".into()),
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Retryable);
        assert!(result.artifact.is_none());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn agent_task_tool_event_success_completion_failure_does_not_publish_artifact() {
        let dir = std::env::temp_dir().join(format!("raven-runtime-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("raven.sqlite3");
        let mut repository = Repository::open(&db_path).unwrap();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let executor = PrematureToolEventCompletingExecutor { db_path };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Failed);
        assert!(result.artifact.is_none());
        assert!(repository
            .artifact_for_run(&result.run.id)
            .unwrap()
            .is_none());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn agent_task_tool_event_persistence_error_still_closes_run_and_steps() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let run = WorkflowRun {
            id: "run-tool-event-persistence-error".into(),
            workflow_id: "agent-weather-runtime".into(),
            workflow_name: "Agent Weather".into(),
            status: RunStatus::Running,
            started_at: timestamp(),
            completed_at: None,
            failure_reason: None,
            idempotency_key: "manual:agent-weather-runtime:persistence-error".into(),
            trigger_kind: "manual".into(),
            retry_count: 0,
            parent_run_id: None,
            error_classification: None,
            provider_profile_id: Some("codex-oauth-local".into()),
            blocked_reason: None,
            required_provider_id: None,
            required_profile_id: None,
            setup_action: None,
            total_tokens: None,
            input_tokens: None,
            output_tokens: None,
            total_cost_usd: None,
        };
        let step_runs = vec![
            WorkflowStepRun {
                id: "step-tool-event-persistence-error-ask-ai".into(),
                workflow_run_id: run.id.clone(),
                step_id: "ask-ai".into(),
                status: RunStatus::Running,
                output_json: None,
                error: None,
                started_at: timestamp(),
                completed_at: None,
            },
            WorkflowStepRun {
                id: "step-tool-event-persistence-error-write".into(),
                workflow_run_id: run.id.clone(),
                step_id: "write-artifact".into(),
                status: RunStatus::Running,
                output_json: None,
                error: None,
                started_at: timestamp(),
                completed_at: None,
            },
        ];
        repository.create_run_with_steps(&run, &step_runs).unwrap();

        let result = finish_agent_runtime_executor_error(
            &repository,
            run.clone(),
            &step_runs,
            "missing-tool-event",
            RunStatus::Retryable,
            "retryable",
            "executor failed",
        );

        assert!(matches!(result, Err(RuntimeError::Db(_))));
        let persisted = repository.workflow_run(&run.id).unwrap().unwrap();
        assert_eq!(persisted.status, RunStatus::Retryable);
        assert_eq!(persisted.error_classification.as_deref(), Some("retryable"));
        assert_all_step_runs_terminal(&repository, &run.id);
    }

    #[test]
    fn edited_current_weather_agent_workflow_routes_to_agent_runtime() {
        let mut repository = repo();
        insert_agent_weather_workflow_for_id(
            &repository,
            "current-weather",
            "missing-agent-profile",
            "save-result",
            None,
        );

        let result = run_workflow(&mut repository, "current-weather", RunTrigger::Manual).unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert_eq!(
            result.run.required_profile_id.as_deref(),
            Some("missing-agent-profile")
        );
        assert!(result.artifact.is_none());
    }

    #[test]
    fn seeded_current_weather_runs_through_agent_executor_helper() {
        let mut repository = repo();
        grant_capability_for_latest_workflow(
            &repository,
            "current-weather",
            "local_app.write_artifact",
        );
        grant_capability_for_latest_workflow(&repository, "current-weather", "agent.run_task");
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "current-weather",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Succeeded);
        let artifact = result.artifact.unwrap();
        assert!(artifact.content_markdown.contains("Weather Today"));
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    #[ignore = "live Claude Code OAuth workflow smoke"]
    fn live_claude_oauth_workflow_smoke() {
        let mut repository = repo();
        insert_agent_weather_workflow_for_id_with_objective(
            &repository,
            "claude-live-smoke",
            "claude-code-oauth-local",
            "write-artifact",
            "Return a concise Raven workflow smoke-test artifact proving Claude Code OAuth executed the workflow. Do not use external tools.",
            None,
        );

        let result =
            run_workflow(&mut repository, "claude-live-smoke", RunTrigger::Manual).unwrap();

        println!(
            "{}",
            serde_json::json!({
                "run_id": result.run.id,
                "status": result.run.status,
                "profile": result.run.provider_profile_id,
                "failure_reason": result.run.failure_reason,
                "blocked_reason": result.run.blocked_reason,
                "artifact_title": result.artifact.as_ref().map(|artifact| artifact.title.clone()),
                "artifact_preview": result.artifact.as_ref().map(|artifact| artifact.content_markdown.chars().take(500).collect::<String>()),
                "source_refs": result.artifact.as_ref().map(|artifact| artifact.source_refs.clone()),
                "metadata": result.artifact.as_ref().map(|artifact| artifact.metadata.clone()),
            })
        );
        assert_eq!(result.run.status, RunStatus::Succeeded);
        assert_eq!(
            result.run.provider_profile_id.as_deref(),
            Some("claude-code-oauth-local")
        );
        let artifact = result.artifact.expect("artifact");
        assert!(!artifact.content_markdown.trim().is_empty());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    #[ignore = "live Codex OAuth workflow smoke"]
    fn live_codex_oauth_workflow_smoke() {
        let mut repository = repo();
        insert_agent_weather_workflow_for_id_with_objective(
            &repository,
            "codex-live-smoke",
            "codex-oauth-local",
            "write-artifact",
            "Return a concise Raven workflow smoke-test artifact proving Codex OAuth executed the workflow. Do not use external tools.",
            None,
        );

        let result = run_workflow(&mut repository, "codex-live-smoke", RunTrigger::Manual).unwrap();

        println!(
            "{}",
            serde_json::json!({
                "run_id": result.run.id,
                "status": result.run.status,
                "profile": result.run.provider_profile_id,
                "failure_reason": result.run.failure_reason,
                "blocked_reason": result.run.blocked_reason,
                "artifact_title": result.artifact.as_ref().map(|artifact| artifact.title.clone()),
                "artifact_preview": result.artifact.as_ref().map(|artifact| artifact.content_markdown.chars().take(500).collect::<String>()),
                "source_refs": result.artifact.as_ref().map(|artifact| artifact.source_refs.clone()),
                "metadata": result.artifact.as_ref().map(|artifact| artifact.metadata.clone()),
            })
        );
        assert_eq!(result.run.status, RunStatus::Succeeded);
        assert_eq!(
            result.run.provider_profile_id.as_deref(),
            Some("codex-oauth-local")
        );
        let artifact = result.artifact.expect("artifact");
        assert!(!artifact.content_markdown.trim().is_empty());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn agent_task_missing_profile_blocks_without_artifact() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "missing-agent-profile");
        let sink = crate::stream::EventLog::default();
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor_and_event_sink(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
            &sink,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert_run_error_event(
            &sink.events(),
            &result.run.id,
            "missing-agent-profile",
            "terminal",
        );
        assert_eq!(
            result.run.required_profile_id.as_deref(),
            Some("missing-agent-profile")
        );
        assert!(result.artifact.is_none());
        assert!(repository
            .artifact_for_run(&result.run.id)
            .unwrap()
            .is_none());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn agent_task_api_key_profile_runs_through_executor() {
        std::env::set_var("OPENAI_API_KEY", "test-openai-key");
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "openai-api-key");
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();
        std::env::remove_var("OPENAI_API_KEY");

        assert_eq!(result.run.status, RunStatus::Succeeded);
        assert_eq!(
            result.run.provider_profile_id.as_deref(),
            Some("openai-api-key")
        );
        assert!(result.artifact.is_some());
        assert!(repository
            .artifact_for_run(&result.run.id)
            .unwrap()
            .is_some());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn agent_task_executor_error_fails_without_artifact_and_completes_tool_event() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let executor = FakeAgentExecutor {
            error: Some("model unavailable".into()),
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Retryable);
        assert!(result.artifact.is_none());
        assert!(repository
            .artifact_for_run(&result.run.id)
            .unwrap()
            .is_none());

        let events = repository
            .agent_tool_events_for_run(&result.run.id)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].status, AgentToolEventStatus::Failed);
        assert!(events[0].completed_at.is_some());
        assert!(events[0]
            .error
            .as_deref()
            .unwrap()
            .contains("model unavailable"));
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn agent_task_oauth_cli_errors_block_run_with_setup_fields() {
        for message in [
            "not logged in",
            "authentication required",
            "login required",
            "no auth token",
        ] {
            let mut repository = repo();
            insert_agent_weather_workflow(&repository, "codex-oauth-local");
            let executor = FakeAgentExecutor {
                error: Some(message.into()),
                envelope: None,
            };

            let result = run_workflow_with_agent_executor(
                &mut repository,
                "agent-weather-runtime",
                RunTrigger::Manual,
                &executor,
            )
            .unwrap();

            assert_eq!(result.run.status, RunStatus::Blocked, "{message}");
            assert!(result.artifact.is_none());
            assert!(repository
                .artifact_for_run(&result.run.id)
                .unwrap()
                .is_none());
            assert!(result
                .run
                .blocked_reason
                .as_deref()
                .unwrap()
                .contains(message));
            assert_eq!(
                result.run.required_profile_id.as_deref(),
                Some("codex-oauth-local")
            );
            assert!(result
                .run
                .setup_action
                .as_deref()
                .unwrap()
                .contains("Sign in"));
            assert_all_step_runs_terminal(&repository, &result.run.id);

            let events = repository
                .agent_tool_events_for_run(&result.run.id)
                .unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].status, AgentToolEventStatus::Blocked);
            assert!(events[0].completed_at.is_some());
            assert!(events[0].error.as_deref().unwrap().contains(message));
        }
    }

    #[test]
    fn agent_task_metadata_failure_fails_run_without_running_step_leak() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let sink = crate::stream::EventLog::default();
        let executor = FakeAgentExecutor {
            error: None,
            envelope: Some(AgentTaskEnvelope {
                metadata: serde_json::json!("not an object"),
                ..weather_agent_envelope()
            }),
        };

        let result = run_workflow_with_agent_executor_and_event_sink(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
            &sink,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Failed);
        assert_run_error_event(&sink.events(), &result.run.id, "metadata", "terminal");
        assert!(result.artifact.is_none());
        assert!(repository
            .artifact_for_run(&result.run.id)
            .unwrap()
            .is_none());
        let events = repository
            .agent_tool_events_for_run(&result.run.id)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].status, AgentToolEventStatus::Failed);
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn agent_task_runtime_fails_unsupported_extra_steps_without_running_step_leak() {
        let mut repository = repo();
        insert_agent_weather_workflow_with_extra_step(
            &repository,
            "codex-oauth-local",
            Some(WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "notify-user".into(),
                name: "Notify user".into(),
                provider: "notification".into(),
                action: "send".into(),
                depends_on: vec!["write-artifact".into()],
                permissions: vec!["notification:send".into()],
                inputs: serde_json::json!({}),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            }),
        );
        let sink = crate::stream::EventLog::default();
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor_and_event_sink(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
            &sink,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Failed);
        assert_run_error_event(
            &sink.events(),
            &result.run.id,
            "does not support step",
            "terminal",
        );
        assert!(result.artifact.is_none());
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn agent_task_runtime_finishes_local_app_sink_with_custom_step_id() {
        let mut repository = repo();
        insert_agent_weather_workflow_with_sink_and_extra_step(
            &repository,
            "codex-oauth-local",
            "save-result",
            None,
        );
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let result = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Succeeded);
        assert_all_step_runs_terminal(&repository, &result.run.id);
    }

    #[test]
    fn plugin_runtime_executes_step_persists_trace_and_writes_artifact() {
        let mut repository = repo();
        let fixture_dir = std::env::current_dir()
            .unwrap()
            .join("tests")
            .join("fixtures")
            .join("plugins")
            .join("deterministic-artifact-plugin");
        let plugin = crate::plugins::load_plugin_manifest(&fixture_dir).unwrap();
        insert_plugin_artifact_workflow(&repository, "auto_approve");
        grant_capability_for_latest_workflow(
            &repository,
            "plugin-artifact-runtime",
            "deterministic_artifact.build_artifact",
        );
        grant_capability_for_latest_workflow(
            &repository,
            "plugin-artifact-runtime",
            "local_app.write_artifact",
        );
        let sink = crate::stream::EventLog::default();

        let result = run_workflow_with_plugins_and_event_sink(
            &mut repository,
            "plugin-artifact-runtime",
            RunTrigger::Manual,
            &[plugin],
            &sink,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.failure_reason
        );
        let artifact = result.artifact.unwrap();
        assert_eq!(artifact.title, "Plugin Artifact for Task 11");
        assert!(artifact
            .content_markdown
            .contains("deterministic plugin output"));
        assert_eq!(
            artifact.metadata["plugin"]["provider"],
            "deterministic_artifact"
        );
        let step_runs = repository
            .workflow_step_runs_for_run(&result.run.id)
            .unwrap();
        let plugin_step = step_runs
            .iter()
            .find(|step| step.step_id == "build-artifact")
            .unwrap();
        assert_eq!(
            plugin_step.output_json.as_ref().unwrap()["artifact"],
            serde_json::json!(
                "# Plugin Artifact for Task 11\n\nThis is deterministic plugin output."
            )
        );
        let tool_events = repository
            .agent_tool_events_for_run(&result.run.id)
            .unwrap();
        assert_eq!(tool_events.len(), 1);
        assert_eq!(
            tool_events[0].tool_id,
            "plugin.deterministic_artifact.build_artifact"
        );
        assert_eq!(tool_events[0].status, AgentToolEventStatus::Succeeded);
        assert!(sink.events().iter().any(|event| matches!(
            event,
            crate::models::AgentEvent::ToolCallStart { tool_name, .. }
                if tool_name == "plugin.deterministic_artifact.build_artifact"
        )));
        assert!(sink.events().iter().any(|event| matches!(
            event,
            crate::models::AgentEvent::RunFinished {
                artifact_id: Some(_),
                ..
            }
        )));
        let audit_events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let plugin_audit = audit_events
            .iter()
            .find(|event| event.step_id == "build-artifact")
            .unwrap();
        assert_eq!(
            plugin_audit.capability_id,
            "deterministic_artifact.build_artifact"
        );
        assert_eq!(plugin_audit.decision, "allowed_with_grant");
        assert!(plugin_audit.grant_id.is_some());
    }

    #[test]
    fn plugin_runtime_blocks_provider_step_without_required_grant() {
        let mut repository = repo();
        let fixture_dir = std::env::current_dir()
            .unwrap()
            .join("tests")
            .join("fixtures")
            .join("plugins")
            .join("deterministic-artifact-plugin");
        let plugin = crate::plugins::load_plugin_manifest(&fixture_dir).unwrap();
        insert_plugin_artifact_workflow(&repository, "auto_approve");

        let result = run_workflow_with_plugins_and_event_sink(
            &mut repository,
            "plugin-artifact-runtime",
            RunTrigger::Manual,
            &[plugin],
            &NoopRuntimeEventSink,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert_eq!(result.run.required_provider_id.as_deref(), Some("approval"));
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("deterministic_artifact.build_artifact"));
        let audit_events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let plugin_audit = audit_events
            .iter()
            .find(|event| event.step_id == "build-artifact")
            .unwrap();
        assert_eq!(
            plugin_audit.capability_id,
            "deterministic_artifact.build_artifact"
        );
        assert_eq!(plugin_audit.decision, "needs_grant");
        assert!(plugin_audit.grant_id.is_none());
    }

    #[test]
    fn plugin_runtime_blocks_generated_artifact_persistence_without_optional_sink_grant() {
        let mut repository = repo();
        let fixture_dir = std::env::current_dir()
            .unwrap()
            .join("tests")
            .join("fixtures")
            .join("plugins")
            .join("deterministic-artifact-plugin");
        let plugin = crate::plugins::load_plugin_manifest(&fixture_dir).unwrap();
        insert_plugin_artifact_workflow_without_sink(
            &repository,
            "plugin-artifact-runtime-without-sink",
            "auto_approve",
        );
        grant_capability_for_latest_workflow(
            &repository,
            "plugin-artifact-runtime-without-sink",
            "deterministic_artifact.build_artifact",
        );

        let result = run_workflow_with_plugins_and_event_sink(
            &mut repository,
            "plugin-artifact-runtime-without-sink",
            RunTrigger::Manual,
            &[plugin],
            &NoopRuntimeEventSink,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert_eq!(result.run.required_provider_id.as_deref(), Some("approval"));
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("local_app.write_artifact"));
        let audit_events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let write_audit = audit_events
            .iter()
            .find(|event| event.capability_id == "local_app.write_artifact")
            .unwrap();
        assert_eq!(write_audit.step_id, "persist-artifact");
        assert_eq!(write_audit.decision, "needs_grant");
        assert!(write_audit.grant_id.is_none());
    }

    #[test]
    fn plugin_resume_rejects_changed_approved_capability() {
        let mut repository = repo();
        let fixture_dir = std::env::current_dir()
            .unwrap()
            .join("tests")
            .join("fixtures")
            .join("plugins")
            .join("deterministic-artifact-plugin");
        let plugin = crate::plugins::load_plugin_manifest(&fixture_dir).unwrap();
        insert_plugin_artifact_workflow(&repository, "review_changes");

        let first = run_workflow_with_plugins_and_event_sink(
            &mut repository,
            "plugin-artifact-runtime",
            RunTrigger::Manual,
            &[plugin.clone()],
            &NoopRuntimeEventSink,
        )
        .unwrap();
        assert_eq!(first.run.status, RunStatus::Blocked);
        let approval = repository.list_pending_approvals().unwrap().remove(0);
        let (approved, changed) = repository
            .resolve_approval(&approval.id, "approved", Some("baseline plugin"))
            .unwrap();
        assert!(changed);

        let mut changed_plugin = plugin;
        changed_plugin.steps[0].execution.args = vec!["--changed-after-approval".into()];

        let resumed = run_workflow_with_plugins_and_event_sink(
            &mut repository,
            "plugin-artifact-runtime",
            RunTrigger::ApprovedResume(approved.unwrap().run_id),
            &[changed_plugin],
            &NoopRuntimeEventSink,
        )
        .unwrap();

        assert_eq!(resumed.run.status, RunStatus::Failed);
        assert!(resumed
            .run
            .failure_reason
            .as_deref()
            .unwrap_or_default()
            .contains("approved plugin capability signature mismatch"));
        assert!(resumed.artifact.is_none());
    }

    #[test]
    #[cfg(unix)]
    fn plugin_timeout_terminates_process_group_children() {
        use std::os::unix::fs::PermissionsExt;

        let plugin_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(plugin_dir.path().join("bin")).unwrap();
        let marker_path = plugin_dir.path().join("leaked-child-marker");
        let command_path = plugin_dir.path().join("bin").join("timeout-plugin");
        std::fs::write(
            &command_path,
            r#"#!/bin/sh
(sleep 1; printf leaked > "$1") &
sleep 5
"#,
        )
        .unwrap();
        std::fs::set_permissions(&command_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manifest = crate::plugins::PluginManifest {
            id: "timeout_plugin".into(),
            name: "Timeout Plugin".into(),
            version: "0.1.0".into(),
            description: String::new(),
            steps: vec![crate::plugins::PluginStepDefinition {
                kind: "provider_action".into(),
                provider: "timeout_plugin".into(),
                action: "run".into(),
                display_name: "Run".into(),
                permissions: vec!["plugin:execute".into()],
                input_schema: serde_json::json!({ "type": "object" }),
                output_schema: serde_json::json!({ "type": "object" }),
                execution: crate::plugins::PluginExecutionConfig {
                    command: "bin/timeout-plugin".into(),
                    args: vec![marker_path.to_string_lossy().to_string()],
                    env: Default::default(),
                    timeout_ms: Some(100),
                },
            }],
            plugin_dir: Some(plugin_dir.path().to_path_buf()),
        };

        let error = match execute_plugin_step(
            &manifest,
            &manifest.steps[0],
            serde_json::json!({ "subject": "timeout" }),
        ) {
            Ok(_) => panic!("plugin command should have timed out"),
            Err(error) => error,
        };

        assert_eq!(error, "Plugin command timed out.");
        std::thread::sleep(Duration::from_millis(1_200));
        assert!(!marker_path.exists());
    }

    #[test]
    fn agent_task_executor_helper_rejects_workflows_without_agent_task() {
        let mut repository = repo();
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let error = run_workflow_with_agent_executor(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &executor,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            RuntimeError::MissingAgentTask(workflow_id) if workflow_id == "daily-work-journal"
        ));
    }

    #[test]
    fn scheduled_agent_task_window_is_idempotent() {
        let mut repository = repo();
        insert_agent_weather_workflow(&repository, "codex-oauth-local");
        let executor = FakeAgentExecutor {
            error: None,
            envelope: None,
        };

        let first = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::ScheduleWindow("2026-06-08T17:00".into()),
            &executor,
        )
        .unwrap();
        let second = run_workflow_with_agent_executor(
            &mut repository,
            "agent-weather-runtime",
            RunTrigger::ScheduleWindow("2026-06-08T17:00".into()),
            &executor,
        )
        .unwrap();

        assert!(!first.duplicate);
        assert!(second.duplicate);
        assert_eq!(first.run.id, second.run.id);
    }

    fn assert_all_step_runs_terminal(repository: &Repository, run_id: &str) {
        let step_runs = repository.workflow_step_runs_for_run(run_id).unwrap();
        assert!(!step_runs.is_empty());
        assert!(step_runs.iter().all(|step_run| {
            !matches!(step_run.status, RunStatus::Queued | RunStatus::Running)
                && step_run.completed_at.is_some()
        }));
    }

    #[test]
    fn live_manual_run_without_credentials_persists_blocked_run_without_artifact() {
        let openai = std::env::var("OPENAI_API_KEY").ok();
        let anthropic = std::env::var("ANTHROPIC_API_KEY").ok();
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("ANTHROPIC_API_KEY");
        let mut repository = repo();
        let result =
            run_workflow(&mut repository, "daily-work-journal", RunTrigger::Manual).unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert_eq!(result.run.required_provider_id.as_deref(), Some("openai"));
        assert_eq!(
            result.run.required_profile_id.as_deref(),
            Some("default-openai")
        );
        assert!(result
            .run
            .setup_action
            .as_deref()
            .unwrap_or_default()
            .contains("OpenAI"));

        let persisted = repository.workflow_run(&result.run.id).unwrap().unwrap();
        assert_eq!(persisted.status, RunStatus::Blocked);
        assert!(repository
            .artifact_for_run(&result.run.id)
            .unwrap()
            .is_none());

        if let Some(value) = openai {
            std::env::set_var("OPENAI_API_KEY", value);
        }
        if let Some(value) = anthropic {
            std::env::set_var("ANTHROPIC_API_KEY", value);
        }
    }

    #[test]
    fn provider_backed_run_persists_structured_artifact_envelope() {
        let mut repository = repo();
        grant_daily_work_journal_all_runtime_capabilities(&repository);
        let generator = FakeGenerator {
            result: Ok(ArtifactEnvelope {
                title: "Provider Journal".into(),
                content_markdown: "# Provider Journal\n\nGenerated by model.".into(),
                metadata: serde_json::json!({ "provider": "openai", "model": "gpt-4.1" }),
                source_refs: vec!["git:abc123".into()],
            }),
        };

        let result = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &generator,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Succeeded);
        let artifact = result.artifact.unwrap();
        assert_eq!(artifact.title, "Provider Journal");
        assert!(artifact.content_markdown.contains("Generated by model."));
        assert_eq!(artifact.metadata["provider"], "openai");
        assert_eq!(artifact.source_refs, vec!["git:abc123"]);
    }

    #[test]
    fn provider_backed_run_blocks_collect_context_without_required_grant() {
        let mut repository = repo();
        let generator = FakeGenerator {
            result: Ok(ArtifactEnvelope {
                title: "Provider Journal".into(),
                content_markdown: "# Provider Journal\n\nGenerated by model.".into(),
                metadata: serde_json::json!({ "provider": "openai", "model": "gpt-4.1" }),
                source_refs: vec!["git:abc123".into()],
            }),
        };

        let result = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &generator,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("local_git.recent_activity"));
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let collect_event = events
            .iter()
            .find(|event| event.capability_id == "local_git.recent_activity")
            .unwrap();
        assert_eq!(collect_event.step_id, "collect-context");
        assert_eq!(collect_event.decision, "needs_grant");
        assert!(collect_event.grant_id.is_none());
    }

    #[test]
    fn provider_backed_run_blocks_generate_artifact_without_required_grant() {
        let mut repository = repo();
        grant_capability_for_latest_workflow(
            &repository,
            "daily-work-journal",
            "local_git.recent_activity",
        );
        let generator = FakeGenerator {
            result: Ok(ArtifactEnvelope {
                title: "Provider Journal".into(),
                content_markdown: "# Provider Journal\n\nGenerated by model.".into(),
                metadata: serde_json::json!({ "provider": "openai", "model": "gpt-4.1" }),
                source_refs: vec!["git:abc123".into()],
            }),
        };

        let result = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &generator,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("openai.generate_artifact"));
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let generate_event = events
            .iter()
            .find(|event| event.capability_id == "openai.generate_artifact")
            .unwrap();
        assert_eq!(generate_event.step_id, "compose-artifact");
        assert_eq!(generate_event.decision, "needs_grant");
        assert!(generate_event.grant_id.is_none());
    }

    #[test]
    fn provider_backed_run_requires_credential_and_network_grants_for_generate_artifact() {
        let mut repository = repo();
        grant_capability_for_latest_workflow(
            &repository,
            "daily-work-journal",
            "local_git.recent_activity",
        );
        let version = repository
            .latest_workflow_version("daily-work-journal")
            .unwrap()
            .unwrap();
        let step = version
            .definition
            .steps
            .iter()
            .find(|step| step.id == "compose-artifact")
            .unwrap();
        let capability =
            runtime_capability_descriptor_for_step(step, &runtime_registry_snapshot()).unwrap();
        repository
            .create_approval_grant(&ApprovalGrant {
                id: "grant-openai-credential-only".into(),
                workflow_id: "daily-work-journal".into(),
                workflow_version: version.version,
                capability_id: capability.id.clone(),
                grant_type: ApprovalGrantType::CredentialUse,
                scope: ApprovalGrantScope {
                    credential_ref: Some("default-openai".into()),
                    paths: vec![],
                    domains: vec![],
                    resource_ids: vec![],
                    max_deletes: None,
                    max_overwrite_bytes: None,
                    external_targets: vec![],
                },
                approved_by_user_at: timestamp(),
                expires_at: None,
                signature_hash: capability.signature_hash.clone(),
                status: ApprovalGrantStatus::Active,
            })
            .unwrap();

        let result = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &PanickingGenerator,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("openai.generate_artifact"));
    }

    #[test]
    fn provider_backed_run_allows_generate_artifact_with_credential_and_network_grants() {
        let mut repository = repo();
        grant_daily_work_journal_provider_capabilities(&repository);
        grant_capability_for_latest_workflow(
            &repository,
            "daily-work-journal",
            "local_app.write_artifact",
        );
        let generator = FakeGenerator {
            result: Ok(ArtifactEnvelope {
                title: "Provider Journal".into(),
                content_markdown: "# Provider Journal\n\nGenerated by model.".into(),
                metadata: serde_json::json!({ "provider": "openai", "model": "gpt-4.1" }),
                source_refs: vec!["git:abc123".into()],
            }),
        };

        let result = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &generator,
        )
        .unwrap();

        assert_eq!(
            result.run.status,
            RunStatus::Succeeded,
            "{:?}",
            result.run.blocked_reason
        );
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let generate_event = events
            .iter()
            .find(|event| event.capability_id == "openai.generate_artifact")
            .unwrap();
        assert_eq!(generate_event.decision, "allowed_with_grant");
        assert!(generate_event.grant_id.as_deref().unwrap().contains(','));
    }

    #[test]
    fn provider_backed_run_blocks_generated_artifact_persistence_without_write_grant() {
        let mut repository = repo();
        grant_daily_work_journal_provider_capabilities(&repository);
        let generator = FakeGenerator {
            result: Ok(ArtifactEnvelope {
                title: "Provider Journal".into(),
                content_markdown: "# Provider Journal\n\nGenerated by model.".into(),
                metadata: serde_json::json!({ "provider": "openai", "model": "gpt-4.1" }),
                source_refs: vec!["git:abc123".into()],
            }),
        };

        let result = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &generator,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert_eq!(result.run.required_provider_id.as_deref(), Some("approval"));
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("local_app.write_artifact"));
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let write_event = events
            .iter()
            .find(|event| event.capability_id == "local_app.write_artifact")
            .unwrap();
        assert_eq!(write_event.step_id, "write-artifact");
        assert_eq!(write_event.decision, "needs_grant");
        assert!(write_event.grant_id.is_none());
    }

    #[test]
    fn provider_backed_run_blocks_generated_artifact_persistence_with_mismatched_write_grant() {
        let mut repository = repo();
        grant_daily_work_journal_provider_capabilities(&repository);
        grant_capability_for_latest_workflow_with_paths(
            &repository,
            "daily-work-journal",
            "local_app.write_artifact",
            vec!["/tmp/not-raven-artifacts/*.md".into()],
        );
        let generator = FakeGenerator {
            result: Ok(ArtifactEnvelope {
                title: "Provider Journal".into(),
                content_markdown: "# Provider Journal\n\nGenerated by model.".into(),
                metadata: serde_json::json!({ "provider": "openai", "model": "gpt-4.1" }),
                source_refs: vec!["git:abc123".into()],
            }),
        };

        let result = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &generator,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("scope matches"));
    }

    #[test]
    fn provider_backed_run_emits_ordered_runtime_events() {
        let mut repository = repo();
        grant_daily_work_journal_all_runtime_capabilities(&repository);
        let sink = crate::stream::EventLog::default();
        let generator = FakeGenerator {
            result: Ok(ArtifactEnvelope {
                title: "Provider Journal".into(),
                content_markdown: "# Provider Journal\n\nGenerated by model.".into(),
                metadata: serde_json::json!({
                    "provider": "openai",
                    "model": "gpt-4.1",
                    "usage": { "total_tokens": 42 },
                    "estimated_cost_usd": 0.0004
                }),
                source_refs: vec!["git:abc123".into()],
            }),
        };

        let result = run_workflow_with_generator_and_event_sink(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &generator,
            &sink,
        )
        .unwrap();
        let events = sink.events();
        let kinds = events
            .iter()
            .map(|event| event.kind_name())
            .collect::<Vec<_>>();

        assert_eq!(result.run.status, RunStatus::Succeeded);
        assert_eq!(
            kinds,
            vec![
                "RUN_STARTED",
                "STEP_STARTED",
                "STEP_FINISHED",
                "STEP_STARTED",
                "TEXT_MESSAGE_CONTENT",
                "STEP_FINISHED",
                "STEP_STARTED",
                "STEP_FINISHED",
                "RUN_FINISHED"
            ]
        );
        assert!(matches!(
            events.last(),
            Some(crate::models::AgentEvent::RunFinished {
                token_count: Some(42),
                estimated_cost_usd: Some(cost),
                ..
            }) if (cost - 0.0004).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn weather_run_persists_real_provider_artifact_without_llm_credentials() {
        let mut repository = repo();
        grant_current_weather_all_runtime_capabilities(&repository);

        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Succeeded);
        assert_eq!(
            result.run.provider_profile_id.as_deref(),
            Some("open-meteo")
        );
        let artifact = result.artifact.unwrap();
        assert_eq!(artifact.artifact_type, "weather_report");
        assert_eq!(artifact.title, "Current Weather");
        assert!(artifact.content_markdown.contains("Denver, CO"));
        assert!(artifact.content_markdown.contains("74.2°F"));
        assert_eq!(artifact.metadata["provider"], "open-meteo");
        assert_eq!(artifact.source_refs, vec!["open-meteo:39.75,-104.99"]);
    }

    #[test]
    fn current_weather_blocks_provider_action_without_required_grant() {
        let mut repository = repo();

        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &PanickingWeatherProvider,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("open_meteo.current_weather"));
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let weather_event = events
            .iter()
            .find(|event| event.capability_id == "open_meteo.current_weather")
            .unwrap();
        assert_eq!(weather_event.step_id, "fetch-weather");
        assert_eq!(weather_event.decision, "needs_grant");
        assert!(weather_event.grant_id.is_none());
    }

    #[test]
    fn current_weather_blocks_provider_action_with_stale_signature_grant() {
        let mut repository = repo();
        let version = repository
            .latest_workflow_version("current-weather")
            .unwrap()
            .unwrap();
        repository
            .create_approval_grant(&ApprovalGrant {
                id: "grant-stale-weather-signature".into(),
                workflow_id: "current-weather".into(),
                workflow_version: version.version,
                capability_id: "open_meteo.current_weather".into(),
                grant_type: ApprovalGrantType::ToolExecution,
                scope: ApprovalGrantScope {
                    credential_ref: None,
                    paths: vec![],
                    domains: vec![],
                    resource_ids: vec![],
                    max_deletes: None,
                    max_overwrite_bytes: None,
                    external_targets: vec![],
                },
                approved_by_user_at: timestamp(),
                expires_at: None,
                signature_hash: "stale-signature".into(),
                status: ApprovalGrantStatus::Active,
            })
            .unwrap();

        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &PanickingWeatherProvider,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("open_meteo.current_weather"));
        let weather_event = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap()
            .into_iter()
            .find(|event| event.capability_id == "open_meteo.current_weather")
            .unwrap();
        assert_eq!(weather_event.decision, "needs_grant");
        assert!(weather_event.grant_id.is_none());
    }

    #[test]
    fn current_weather_blocks_artifact_write_without_required_grant() {
        let mut repository = repo();
        grant_current_weather_provider_capability(&repository);

        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("local_app.write_artifact"));
        assert!(repository
            .artifact_for_run(&result.run.id)
            .unwrap()
            .is_none());
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let write_event = events
            .iter()
            .find(|event| event.capability_id == "local_app.write_artifact")
            .unwrap();
        assert_eq!(write_event.step_id, "write-artifact");
        assert_eq!(write_event.decision, "needs_grant");
        assert!(write_event.grant_id.is_none());
    }

    #[test]
    fn current_weather_blocks_artifact_write_with_wrong_grant_type() {
        let mut repository = repo();
        grant_current_weather_provider_capability(&repository);
        let version = repository
            .latest_workflow_version("current-weather")
            .unwrap()
            .unwrap();
        let (content_path, metadata_path) = repository.artifact_paths("artifact-*");
        let capability = runtime_capability_descriptor_for_step(
            &artifact_persistence_policy_step(&version.definition.steps, "fetch-weather"),
            &runtime_registry_snapshot(),
        )
        .unwrap();
        repository
            .create_approval_grant(&ApprovalGrant {
                id: "grant-wrong-write-type".into(),
                workflow_id: "current-weather".into(),
                workflow_version: version.version,
                capability_id: "local_app.write_artifact".into(),
                grant_type: ApprovalGrantType::ToolExecution,
                scope: ApprovalGrantScope {
                    credential_ref: None,
                    paths: vec![content_path, metadata_path],
                    domains: vec![],
                    resource_ids: vec![],
                    max_deletes: None,
                    max_overwrite_bytes: None,
                    external_targets: vec![],
                },
                approved_by_user_at: timestamp(),
                expires_at: None,
                signature_hash: capability.signature_hash,
                status: ApprovalGrantStatus::Active,
            })
            .unwrap();

        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("scope matches"));
    }

    #[test]
    fn current_weather_blocks_artifact_write_with_mismatched_grant() {
        let mut repository = repo();
        grant_current_weather_provider_capability(&repository);
        grant_capability_for_latest_workflow_with_paths(
            &repository,
            "current-weather",
            "local_app.write_artifact",
            vec!["/tmp/not-raven-artifacts/*.md".into()],
        );

        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Blocked);
        assert!(result.artifact.is_none());
        assert!(result
            .run
            .blocked_reason
            .as_deref()
            .unwrap_or_default()
            .contains("scope matches"));
        let events = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap();
        let write_event = events
            .iter()
            .find(|event| event.capability_id == "local_app.write_artifact")
            .unwrap();
        assert_eq!(write_event.step_id, "write-artifact");
        assert_eq!(write_event.decision, "needs_grant");
        assert!(write_event.grant_id.is_none());
    }

    #[test]
    fn current_weather_provider_audit_distinguishes_allowed_with_grant() {
        let mut repository = repo();
        grant_current_weather_all_runtime_capabilities(&repository);

        let result = run_current_weather_workflow_with_provider(
            &mut repository,
            RunTrigger::Manual,
            &FakeWeatherProvider,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Succeeded);
        let weather_event = repository
            .capability_audit_events_for_run(&result.run.id)
            .unwrap()
            .into_iter()
            .find(|event| event.capability_id == "open_meteo.current_weather")
            .unwrap();
        assert_eq!(weather_event.decision, "allowed_with_grant");
        assert_eq!(weather_event.status.as_deref(), Some("succeeded"));
        assert!(weather_event.error_details.is_none());
        assert!(weather_event.grant_id.is_some());
    }

    #[test]
    fn grant_scope_rejects_network_domain_mismatch() {
        let manifest = crate::plugins::PluginManifest {
            id: "network_plugin".into(),
            name: "Network Plugin".into(),
            version: "0.1.0".into(),
            description: String::new(),
            steps: vec![crate::plugins::PluginStepDefinition {
                kind: "provider_action".into(),
                provider: "network_plugin".into(),
                action: "fetch".into(),
                display_name: "Fetch".into(),
                permissions: vec!["network:read".into()],
                input_schema: serde_json::json!({ "type": "object" }),
                output_schema: serde_json::json!({ "type": "object" }),
                execution: crate::plugins::PluginExecutionConfig {
                    command: "bin/network-plugin".into(),
                    args: vec![],
                    env: Default::default(),
                    timeout_ms: Some(100),
                },
            }],
            plugin_dir: None,
        };
        let capability = plugin_capability_descriptor(&manifest, &manifest.steps[0]);
        let grant = ApprovalGrant {
            id: "grant-network-domain".into(),
            workflow_id: "network-workflow".into(),
            workflow_version: 1,
            capability_id: capability.id.clone(),
            grant_type: ApprovalGrantType::NetworkAccess,
            scope: ApprovalGrantScope {
                credential_ref: None,
                paths: vec![],
                domains: vec!["api.allowed.test".into()],
                resource_ids: vec![],
                max_deletes: None,
                max_overwrite_bytes: None,
                external_targets: vec![],
            },
            approved_by_user_at: timestamp(),
            expires_at: None,
            signature_hash: capability.signature_hash.clone(),
            status: ApprovalGrantStatus::Active,
        };

        assert!(!grant_scope_allows_step(
            &grant,
            &capability,
            &serde_json::json!({ "url": "https://api.blocked.test/data" })
        ));
    }

    fn resource_plugin_policy_fixture(
        repository: &mut Repository,
    ) -> (
        WorkflowVersion,
        WorkflowRun,
        WorkflowStepDefinition,
        CapabilityDescriptor,
    ) {
        let version = repository
            .latest_workflow_version("daily-work-journal")
            .unwrap()
            .unwrap();
        let run = WorkflowRun {
            id: format!("run-{}", uuid::Uuid::new_v4()),
            workflow_id: version.workflow_id.clone(),
            workflow_name: version.definition.name.clone(),
            status: RunStatus::Running,
            started_at: timestamp(),
            completed_at: None,
            failure_reason: None,
            idempotency_key: format!("manual:resource-plugin:{}", uuid::Uuid::new_v4()),
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
        let step = WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "resource-plugin".into(),
            name: "Resource plugin".into(),
            provider: "resource_plugin".into(),
            action: "execute".into(),
            depends_on: vec![],
            permissions: vec!["plugin:execute".into()],
            inputs: serde_json::json!({ "id": "some-resource" }),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        };
        let manifest = crate::plugins::PluginManifest {
            id: "resource_plugin".into(),
            name: "Resource Plugin".into(),
            version: "0.1.0".into(),
            description: String::new(),
            steps: vec![crate::plugins::PluginStepDefinition {
                kind: "provider_action".into(),
                provider: "resource_plugin".into(),
                action: "execute".into(),
                display_name: "Execute".into(),
                permissions: vec!["plugin:execute".into()],
                input_schema: serde_json::json!({ "type": "object" }),
                output_schema: serde_json::json!({ "type": "object" }),
                execution: crate::plugins::PluginExecutionConfig {
                    command: "bin/resource-plugin".into(),
                    args: vec![],
                    env: Default::default(),
                    timeout_ms: Some(100),
                },
            }],
            plugin_dir: None,
        };
        let capability = plugin_capability_descriptor(&manifest, &manifest.steps[0]);
        (version, run, step, capability)
    }

    #[test]
    fn resource_scoped_tool_execution_requirement_blocks_without_grant() {
        let mut repository = repo();
        let (version, run, step, capability) = resource_plugin_policy_fixture(&mut repository);

        let check = enforce_provider_step_policy_for_descriptor(
            &repository,
            &version,
            &run,
            &step,
            &step.inputs,
            capability,
        )
        .unwrap();

        assert!(matches!(check, RuntimeCapabilityPolicyCheck::Blocked(_)));
        let audit = repository
            .capability_audit_events_for_run(&run.id)
            .unwrap()
            .into_iter()
            .find(|event| event.capability_id == "resource_plugin.execute")
            .unwrap();
        assert_eq!(audit.decision, "needs_grant");
        assert!(audit.grant_id.is_none());
    }

    #[test]
    fn resource_scoped_tool_execution_grant_allows_matching_resource() {
        let mut repository = repo();
        let (version, run, step, capability) = resource_plugin_policy_fixture(&mut repository);
        repository
            .create_approval_grant(&ApprovalGrant {
                id: "grant-resource-plugin".into(),
                workflow_id: version.workflow_id.clone(),
                workflow_version: version.version,
                capability_id: capability.id.clone(),
                grant_type: ApprovalGrantType::ToolExecution,
                scope: ApprovalGrantScope {
                    credential_ref: None,
                    paths: vec![],
                    domains: vec![],
                    resource_ids: vec!["some-resource".into()],
                    max_deletes: None,
                    max_overwrite_bytes: None,
                    external_targets: vec![],
                },
                approved_by_user_at: timestamp(),
                expires_at: None,
                signature_hash: capability.signature_hash.clone(),
                status: ApprovalGrantStatus::Active,
            })
            .unwrap();

        let check = enforce_provider_step_policy_for_descriptor(
            &repository,
            &version,
            &run,
            &step,
            &step.inputs,
            capability,
        )
        .unwrap();

        assert!(matches!(check, RuntimeCapabilityPolicyCheck::Allowed));
        let audit = repository
            .capability_audit_events_for_run(&run.id)
            .unwrap()
            .into_iter()
            .find(|event| event.capability_id == "resource_plugin.execute")
            .unwrap();
        assert_eq!(audit.decision, "allowed_with_grant");
        assert_eq!(audit.grant_id.as_deref(), Some("grant-resource-plugin"));
    }

    #[test]
    fn runtime_policy_uses_persisted_autonomy_mode() {
        let mut repository = repo();
        repository
            .set_setting(
                "autonomy_mode",
                serde_json::json!(crate::autonomy::AutonomyMode::WorkspaceAuto),
            )
            .unwrap();
        let version = repository
            .latest_workflow_version("daily-work-journal")
            .unwrap()
            .unwrap();
        let run = WorkflowRun {
            id: format!("run-{}", uuid::Uuid::new_v4()),
            workflow_id: version.workflow_id.clone(),
            workflow_name: version.definition.name.clone(),
            status: RunStatus::Running,
            started_at: timestamp(),
            completed_at: None,
            failure_reason: None,
            idempotency_key: format!("manual:workspace-auto:{}", uuid::Uuid::new_v4()),
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
        let step = WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "write-artifact".into(),
            name: "Write artifact".into(),
            provider: "local_app".into(),
            action: "write_artifact".into(),
            depends_on: vec![],
            permissions: vec!["artifact:write".into()],
            inputs: serde_json::json!({ "destination_path": "/tmp/raven/report.md" }),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        };
        let mut capability =
            runtime_capability_descriptor_for_step(&step, &runtime_registry_snapshot()).unwrap();
        capability.id = "workspace_auto.write_report".into();
        capability.provider = "workspace_auto".into();
        capability.action = "write_report".into();
        capability.display_name = "Write report".into();
        capability.destructive = false;
        capability.requires_credentials = false;
        capability.requires_network = false;
        capability.writes_files = true;
        capability.deterministic = true;
        capability.open_world = false;
        capability.read_only = false;
        capability.idempotent = true;
        capability.trust_tier = CapabilityTrustTier::RavenBuiltin;
        capability.status = CapabilityAvailability::Available;
        capability.permissions = vec!["artifact:write".into()];

        let check = enforce_provider_step_policy_for_descriptor(
            &repository,
            &version,
            &run,
            &step,
            &step.inputs,
            capability,
        )
        .unwrap();

        assert!(matches!(check, RuntimeCapabilityPolicyCheck::Allowed));
        let audit = repository
            .capability_audit_events_for_run(&run.id)
            .unwrap()
            .into_iter()
            .find(|event| event.capability_id == "workspace_auto.write_report")
            .unwrap();
        assert_eq!(audit.decision, "auto");
        assert_eq!(audit.status.as_deref(), Some("succeeded"));
        assert!(audit.error_details.is_none());
    }

    #[test]
    fn destructive_scope_matches_delete_path_keys() {
        let grant = ApprovalGrant {
            id: "grant-delete-path".into(),
            workflow_id: "workflow".into(),
            workflow_version: 1,
            capability_id: "filesystem.delete".into(),
            grant_type: ApprovalGrantType::FileDelete,
            scope: ApprovalGrantScope {
                credential_ref: None,
                paths: vec!["/tmp/raven/*.tmp".into()],
                domains: vec![],
                resource_ids: vec![],
                max_deletes: Some(3),
                max_overwrite_bytes: None,
                external_targets: vec![],
            },
            approved_by_user_at: timestamp(),
            expires_at: None,
            signature_hash: "sig".into(),
            status: ApprovalGrantStatus::Active,
        };
        let inputs = serde_json::json!({
            "delete_path": "/tmp/raven/stale.tmp",
            "delete_paths": ["/tmp/raven/old.tmp"],
            "max_deletes": 3
        });

        assert!(destructive_scope_matches(&grant, &inputs));
    }

    #[test]
    fn file_write_grant_does_not_authorize_overwrite_inputs() {
        let capability = crate::capability_registry::descriptor_from_static_capability(
            crate::capabilities::capability_for("local_app", "write_artifact").unwrap(),
        );
        let inputs = serde_json::json!({
            "destination_path": "/tmp/raven/report.md",
            "allow_overwrite": true,
            "max_overwrite_bytes": 128
        });
        let write_grant = ApprovalGrant {
            id: "grant-write-path".into(),
            workflow_id: "workflow".into(),
            workflow_version: 1,
            capability_id: "local_app.write_artifact".into(),
            grant_type: ApprovalGrantType::FileWrite,
            scope: ApprovalGrantScope {
                credential_ref: None,
                paths: vec!["/tmp/raven/report.md".into()],
                domains: vec![],
                resource_ids: vec![],
                max_deletes: None,
                max_overwrite_bytes: None,
                external_targets: vec![],
            },
            approved_by_user_at: timestamp(),
            expires_at: None,
            signature_hash: capability.signature_hash.clone(),
            status: ApprovalGrantStatus::Active,
        };
        let overwrite_grant = ApprovalGrant {
            grant_type: ApprovalGrantType::FileOverwrite,
            scope: ApprovalGrantScope {
                max_overwrite_bytes: Some(128),
                ..write_grant.scope.clone()
            },
            id: "grant-overwrite-path".into(),
            ..write_grant.clone()
        };

        assert!(!grant_satisfies_requirement(
            &write_grant,
            &capability,
            &inputs,
            GrantRequirement::FileWrite
        ));
        assert!(grant_satisfies_requirement(
            &overwrite_grant,
            &capability,
            &inputs,
            GrantRequirement::FileWrite
        ));
    }

    #[test]
    fn file_overwrite_grant_enforces_max_overwrite_bytes() {
        let capability = crate::capability_registry::descriptor_from_static_capability(
            crate::capabilities::capability_for("local_app", "write_artifact").unwrap(),
        );
        let grant = ApprovalGrant {
            id: "grant-overwrite-path".into(),
            workflow_id: "workflow".into(),
            workflow_version: 1,
            capability_id: "local_app.write_artifact".into(),
            grant_type: ApprovalGrantType::FileOverwrite,
            scope: ApprovalGrantScope {
                credential_ref: None,
                paths: vec!["/tmp/raven/report.md".into()],
                domains: vec![],
                resource_ids: vec![],
                max_deletes: None,
                max_overwrite_bytes: Some(16),
                external_targets: vec![],
            },
            approved_by_user_at: timestamp(),
            expires_at: None,
            signature_hash: capability.signature_hash.clone(),
            status: ApprovalGrantStatus::Active,
        };

        assert!(grant_satisfies_requirement(
            &grant,
            &capability,
            &serde_json::json!({
                "destination_path": "/tmp/raven/report.md",
                "allow_overwrite": true,
                "content_markdown": "small"
            }),
            GrantRequirement::FileWrite
        ));
        assert!(!grant_satisfies_requirement(
            &grant,
            &capability,
            &serde_json::json!({
                "destination_path": "/tmp/raven/report.md",
                "allow_overwrite": true,
                "max_overwrite_bytes": 17
            }),
            GrantRequirement::FileWrite
        ));
        assert!(!grant_satisfies_requirement(
            &ApprovalGrant {
                scope: ApprovalGrantScope {
                    max_overwrite_bytes: None,
                    ..grant.scope.clone()
                },
                ..grant.clone()
            },
            &capability,
            &serde_json::json!({
                "destination_path": "/tmp/raven/report.md",
                "allow_overwrite": true,
                "max_overwrite_bytes": 16
            }),
            GrantRequirement::FileWrite
        ));
    }

    #[test]
    fn destructive_scope_enforces_max_deletes() {
        let grant = ApprovalGrant {
            id: "grant-delete-path".into(),
            workflow_id: "workflow".into(),
            workflow_version: 1,
            capability_id: "filesystem.delete".into(),
            grant_type: ApprovalGrantType::FileDelete,
            scope: ApprovalGrantScope {
                credential_ref: None,
                paths: vec!["/tmp/raven/*.tmp".into()],
                domains: vec![],
                resource_ids: vec![],
                max_deletes: Some(1),
                max_overwrite_bytes: None,
                external_targets: vec![],
            },
            approved_by_user_at: timestamp(),
            expires_at: None,
            signature_hash: "sig".into(),
            status: ApprovalGrantStatus::Active,
        };

        assert!(!destructive_scope_matches(
            &grant,
            &serde_json::json!({
                "delete_path": "/tmp/raven/stale.tmp",
                "max_deletes": 2
            })
        ));
        assert!(!destructive_scope_matches(
            &grant,
            &serde_json::json!({
                "delete_paths": ["/tmp/raven/old.tmp", "/tmp/raven/stale.tmp"]
            })
        ));
    }

    #[test]
    fn external_publish_scope_matches_preflight_target_keys() {
        let grant = ApprovalGrant {
            id: "grant-external-publish".into(),
            workflow_id: "workflow".into(),
            workflow_version: 1,
            capability_id: "slack.publish".into(),
            grant_type: ApprovalGrantType::ExternalPublish,
            scope: ApprovalGrantScope {
                credential_ref: None,
                paths: vec![],
                domains: vec![],
                resource_ids: vec![],
                max_deletes: None,
                max_overwrite_bytes: None,
                external_targets: vec![
                    "slack:#ops".into(),
                    "https://hooks.slack.com/services/test".into(),
                ],
            },
            approved_by_user_at: timestamp(),
            expires_at: None,
            signature_hash: "sig".into(),
            status: ApprovalGrantStatus::Active,
        };

        assert!(external_publish_scope_matches(
            &grant,
            &serde_json::json!({
                "external_targets": ["slack:#ops"],
                "target_url": "https://hooks.slack.com/services/test"
            })
        ));
    }

    #[test]
    fn credential_scope_requires_all_step_credentials() {
        let single_ref_grant = ApprovalGrant {
            id: "grant-single-credential".into(),
            workflow_id: "workflow".into(),
            workflow_version: 1,
            capability_id: "agent.run_task".into(),
            grant_type: ApprovalGrantType::CredentialUse,
            scope: ApprovalGrantScope {
                credential_ref: Some("keychain:openai".into()),
                paths: vec![],
                domains: vec![],
                resource_ids: vec![],
                max_deletes: None,
                max_overwrite_bytes: None,
                external_targets: vec![],
            },
            approved_by_user_at: timestamp(),
            expires_at: None,
            signature_hash: "sig".into(),
            status: ApprovalGrantStatus::Active,
        };
        let grouped_grant = ApprovalGrant {
            id: "grant-grouped-credentials".into(),
            scope: ApprovalGrantScope {
                credential_ref: Some("keychain:openai".into()),
                resource_ids: vec!["keychain:openai".into(), "keychain:github".into()],
                ..single_ref_grant.scope.clone()
            },
            ..single_ref_grant.clone()
        };
        let inputs = serde_json::json!({
            "credential_ref": "keychain:openai",
            "nested": { "credential": "keychain:github" }
        });

        assert!(!credential_scope_matches(&single_ref_grant, &inputs));
        assert!(credential_scope_matches(&grouped_grant, &inputs));
    }

    #[test]
    fn retryable_provider_failure_persists_retryable_run_without_artifact() {
        let mut repository = repo();
        grant_daily_work_journal_provider_capabilities(&repository);
        let generator = FakeGenerator {
            result: Err(LlmError::RequestFailed("429 rate limit".into())),
        };

        let result = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &generator,
        )
        .unwrap();

        assert_eq!(result.run.status, RunStatus::Retryable);
        assert_eq!(
            result.run.error_classification.as_deref(),
            Some("retryable")
        );
        assert!(result.run.failure_reason.unwrap().contains("429"));
        assert!(result.artifact.is_none());
    }

    #[test]
    fn scheduled_window_is_idempotent() {
        let mut repository = repo();
        let first = run_workflow(
            &mut repository,
            "daily-work-journal",
            RunTrigger::ScheduleWindow("2026-06-08T17:00".into()),
        )
        .unwrap();
        let second = run_workflow(
            &mut repository,
            "daily-work-journal",
            RunTrigger::ScheduleWindow("2026-06-08T17:00".into()),
        )
        .unwrap();
        assert!(!first.duplicate);
        assert!(second.duplicate);
        assert_eq!(first.run.id, second.run.id);
    }

    #[test]
    fn scheduled_due_workflows_reuse_window_idempotency() {
        let mut repository = repo();
        let first = run_scheduled_due_workflows(&mut repository, "2026-06-08T17:00").unwrap();
        let second = run_scheduled_due_workflows(&mut repository, "2026-06-08T17:00").unwrap();

        assert!(!first.is_empty());
        assert_eq!(first.len(), second.len());
        assert!(second.iter().all(|result| result.duplicate));
    }

    #[test]
    fn scheduled_due_workflows_run_only_matching_window() {
        let mut repository = repo();
        let future = RavenWorkflow {
            id: "future-journal".into(),
            name: "Future Journal".into(),
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "daily".into(),
                local_time: Some("18:00".into()),
            }),
            ..daily_work_journal()
        };
        repository
            .insert_workflow_version(&WorkflowVersion {
                id: "future-journal-v1".into(),
                workflow_id: "future-journal".into(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: future,
                created_at: timestamp(),
                approval_mode: None,
                planner_rationale: None,
            })
            .unwrap();

        let results = run_scheduled_due_workflows(&mut repository, "2026-06-08T17:00").unwrap();

        assert_eq!(
            results
                .iter()
                .map(|result| result.run.workflow_id.as_str())
                .collect::<Vec<_>>(),
            vec!["daily-work-journal"]
        );
    }

    #[test]
    fn scheduled_due_workflows_honor_one_off_schedule_overrides() {
        let mut repository = repo();
        repository
            .save_schedule_override("daily-work-journal", "2026-06-08T17:00", "2026-06-09T09:30")
            .unwrap();

        let original_results =
            run_scheduled_due_workflows(&mut repository, "2026-06-08T17:00").unwrap();
        let assigned_results =
            run_scheduled_due_workflows(&mut repository, "2026-06-09T09:30").unwrap();

        assert!(original_results.is_empty());
        assert_eq!(
            assigned_results
                .iter()
                .map(|result| result.run.workflow_id.as_str())
                .collect::<Vec<_>>(),
            vec!["daily-work-journal"]
        );
    }

    #[test]
    fn scheduled_due_workflows_filter_allowed_workflow_ids_with_matching_window() {
        let mut repository = repo();
        let same_window_retryable = RavenWorkflow {
            id: "same-minute-retryable".into(),
            name: "Same Minute Retryable".into(),
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "daily".into(),
                local_time: Some("17:00".into()),
            }),
            ..daily_work_journal()
        };
        repository
            .insert_workflow_version(&WorkflowVersion {
                id: "same-minute-retryable-v1".into(),
                workflow_id: "same-minute-retryable".into(),
                version: 1,
                status: WorkflowStatus::Enabled,
                definition: same_window_retryable,
                created_at: timestamp(),
                approval_mode: None,
                planner_rationale: None,
            })
            .unwrap();

        let allowed_workflow_ids = vec!["daily-work-journal".to_string()];
        let results = run_scheduled_due_workflows_for_ids(
            &mut repository,
            "2026-06-08T17:00",
            Some(&allowed_workflow_ids),
        )
        .unwrap();

        assert_eq!(
            results
                .iter()
                .map(|result| result.run.workflow_id.as_str())
                .collect::<Vec<_>>(),
            vec!["daily-work-journal"]
        );
    }

    #[test]
    fn regenerate_artifact_without_credentials_creates_blocked_manual_run() {
        let mut repository = repo();
        grant_daily_work_journal_all_runtime_capabilities(&repository);
        let result = run_workflow_with_generator(
            &mut repository,
            "daily-work-journal",
            RunTrigger::Manual,
            &FakeGenerator {
                result: Ok(ArtifactEnvelope {
                    title: "Seed Journal".into(),
                    content_markdown: "# Seed Journal\n\nGenerated.".into(),
                    metadata: serde_json::json!({ "schema_version": "0.1.0" }),
                    source_refs: vec!["test fixture".into()],
                }),
            },
        )
        .unwrap();
        let artifact = result.artifact.unwrap();
        let regenerated = regenerate_artifact(&mut repository, &artifact.id).unwrap();

        assert!(!regenerated.duplicate);
        assert_ne!(regenerated.run.id, result.run.id);
        assert_eq!(regenerated.run.status, RunStatus::Blocked);
        assert!(regenerated.artifact.is_none());
    }
}
