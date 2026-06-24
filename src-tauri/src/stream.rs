use crate::db::Repository;
use crate::models::{AgentEvent, WorkflowRunResult};
use crate::{default_db_path, runtime};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Emitter;

pub trait RuntimeEventSink {
    fn emit(&self, event: AgentEvent);
}

pub struct NoopRuntimeEventSink;

impl RuntimeEventSink for NoopRuntimeEventSink {
    fn emit(&self, _event: AgentEvent) {}
}

#[derive(Default)]
pub struct EventLog {
    events: Mutex<Vec<AgentEvent>>,
}

impl EventLog {
    pub fn events(&self) -> Vec<AgentEvent> {
        self.events
            .lock()
            .map(|events| events.clone())
            .unwrap_or_default()
    }
}

impl RuntimeEventSink for EventLog {
    fn emit(&self, event: AgentEvent) {
        if let Ok(mut events) = self.events.lock() {
            events.push(event);
        }
    }
}

pub struct ChannelRuntimeEventSink {
    channel: Channel<AgentEvent>,
}

impl ChannelRuntimeEventSink {
    fn new(channel: Channel<AgentEvent>) -> Self {
        Self { channel }
    }
}

impl RuntimeEventSink for ChannelRuntimeEventSink {
    fn emit(&self, event: AgentEvent) {
        let _ = self.channel.send(event);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamedWorkflowRunResult {
    pub result: WorkflowRunResult,
    pub events: Vec<AgentEvent>,
}

pub fn run_workflow_to_event_log(
    repository: &mut Repository,
    workflow_id: &str,
) -> Result<StreamedWorkflowRunResult, String> {
    let sink = EventLog::default();
    let result = runtime::run_workflow_with_event_sink(
        repository,
        workflow_id,
        runtime::RunTrigger::Manual,
        &sink,
    )
    .map_err(|error| error.to_string())?;
    Ok(StreamedWorkflowRunResult {
        result,
        events: sink.events(),
    })
}

#[tauri::command(async)]
pub fn run_workflow_streamed(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, Mutex<Repository>>,
    workflow_id: String,
    on_event: Channel<AgentEvent>,
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
    let sink = ChannelRuntimeEventSink::new(on_event);
    let result = runtime::run_workflow_with_event_sink(
        &mut repository,
        &workflow_id,
        runtime::RunTrigger::Manual,
        &sink,
    )
    .map_err(|error| error.to_string())?;
    let event_name = match result.run.status {
        crate::models::RunStatus::Succeeded => "workflow:completed",
        crate::models::RunStatus::Failed => "workflow:errored",
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
