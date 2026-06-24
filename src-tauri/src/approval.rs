use crate::db::Repository;
use crate::models::{ApprovalDecision, PendingApproval};
use crate::services;
use std::sync::Mutex;

#[tauri::command]
pub fn list_pending_approvals(
    repository: tauri::State<Mutex<Repository>>,
) -> Result<Vec<PendingApproval>, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::list_pending_approvals(&repository)
}

#[tauri::command]
pub fn list_approval_history(
    repository: tauri::State<Mutex<Repository>>,
) -> Result<Vec<PendingApproval>, String> {
    let repository = repository.lock().map_err(|error| error.to_string())?;
    services::list_approval_history(&repository)
}

#[tauri::command]
pub fn resolve_approval(
    repository: tauri::State<Mutex<Repository>>,
    id: String,
    decision: ApprovalDecision,
    reason: Option<String>,
) -> Result<Option<PendingApproval>, String> {
    let mut repository = repository.lock().map_err(|error| error.to_string())?;
    services::resolve_approval(&mut repository, &id, decision, reason.as_deref())
}
