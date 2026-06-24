use crate::db::Repository;
use crate::models::WorkflowRunResult;
use crate::runtime::{self, RuntimeError};
use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, FixedOffset, NaiveTime, SecondsFormat, TimeZone,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatus {
    pub running: bool,
    pub poll_interval_seconds: u64,
}

pub struct SchedulerService {
    db_path: PathBuf,
    poll_interval: Duration,
    stop_sender: Option<Sender<()>>,
    handle: Option<JoinHandle<()>>,
    app_handle: Option<AppHandle>,
}

impl SchedulerService {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            poll_interval: Duration::from_secs(60),
            stop_sender: None,
            handle: None,
            app_handle: None,
        }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }

        let (sender, receiver) = mpsc::channel();
        let db_path = self.db_path.clone();
        let poll_interval = self.poll_interval;
        let app_handle_clone = self.app_handle.clone();
        self.stop_sender = Some(sender);
        self.handle = Some(thread::spawn(move || loop {
            match Repository::open(&db_path) {
                Ok(mut repository) => match run_scheduler_tick(&mut repository) {
                    Ok(results) => {
                        if let Some(ref handle) = app_handle_clone {
                            use tauri::Emitter;
                            for result in &results {
                                let _ = handle.emit(
                                    "workflow:started",
                                    serde_json::json!({
                                        "workflow_id": result.run.workflow_id,
                                        "workflow_name": &result.run.workflow_name,
                                    }),
                                );
                                let event_name = match result.run.status {
                                    crate::models::RunStatus::Succeeded => "workflow:completed",
                                    crate::models::RunStatus::Failed => "workflow:errored",
                                    _ => "workflow:completed",
                                };
                                let _ = handle.emit(
                                    event_name,
                                    serde_json::json!({
                                        "workflow_id": result.run.workflow_id,
                                        "workflow_name": &result.run.workflow_name,
                                        "status": format!("{:?}", result.run.status),
                                    }),
                                );
                            }
                        }
                    }
                    Err(err) => {
                        eprintln!("[raven] scheduler tick failed: {err}");
                    }
                },
                Err(err) => {
                    eprintln!("[raven] scheduler could not open database: {err}");
                }
            }
            if receiver.recv_timeout(poll_interval).is_ok() {
                break;
            }
        }));
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(sender) = self.stop_sender.take() {
            let _ = sender.send(());
        }
        if let Some(handle) = self.handle.take() {
            handle
                .join()
                .map_err(|_| "scheduler thread panicked".to_string())?;
        }
        Ok(())
    }

    pub fn status(&self) -> SchedulerStatus {
        SchedulerStatus {
            running: self.is_running(),
            poll_interval_seconds: self.poll_interval.as_secs(),
        }
    }

    fn is_running(&self) -> bool {
        self.handle.is_some()
    }
}

impl Drop for SchedulerService {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub fn run_scheduler_tick(
    repository: &mut Repository,
) -> Result<Vec<WorkflowRunResult>, RuntimeError> {
    let now = chrono::Local::now().fixed_offset();
    run_scheduler_tick_at(repository, &now.to_rfc3339_opts(SecondsFormat::Secs, false))
}

pub fn run_scheduler_tick_at(
    repository: &mut Repository,
    now_iso: &str,
) -> Result<Vec<WorkflowRunResult>, RuntimeError> {
    let now = DateTime::parse_from_rfc3339(now_iso).unwrap_or_else(|_| {
        chrono::Local::now()
            .fixed_offset()
            .to_rfc3339()
            .parse()
            .expect("local rfc3339 timestamp")
    });
    let last_check = repository
        .setting_json("scheduler:last_check_at")?
        .and_then(|value| value.as_str().map(str::to_string))
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .unwrap_or_else(|| now - ChronoDuration::minutes(1));
    let earliest = now - ChronoDuration::days(7);
    let from = if last_check < earliest {
        earliest
    } else {
        last_check
    };

    let mut results = Vec::new();
    for window in due_schedule_windows(repository, from, now)? {
        results.extend(runtime::run_scheduled_due_workflows(repository, &window)?);
    }
    repository.set_setting(
        "scheduler:last_check_at",
        serde_json::json!(now.to_rfc3339_opts(SecondsFormat::Secs, false)),
    )?;
    Ok(results)
}

fn due_schedule_windows(
    repository: &Repository,
    from: DateTime<FixedOffset>,
    to: DateTime<FixedOffset>,
) -> Result<Vec<String>, RuntimeError> {
    let workflows = repository.enabled_scheduled_workflows()?;
    let overrides = repository.schedule_overrides()?;
    let mut windows = Vec::new();

    for workflow in workflows {
        let Some(schedule) = workflow.definition.schedule else {
            continue;
        };
        let Some(local_time) = schedule.local_time else {
            continue;
        };
        let Ok(time) = NaiveTime::parse_from_str(&local_time, "%H:%M") else {
            continue;
        };

        let mut date = from.date_naive();
        while date <= to.date_naive() {
            if cadence_allows_date(&schedule.cadence, date.weekday()) {
                if let Some(window) = to
                    .offset()
                    .from_local_datetime(&date.and_time(time))
                    .single()
                {
                    let window_key = window.format("%Y-%m-%dT%H:%M").to_string();
                    let moved_from_window = overrides.iter().any(|override_entry| {
                        override_entry.workflow_id == workflow.workflow_id
                            && override_entry.original_run_at == window_key
                    });
                    if !moved_from_window && window > from && window <= to {
                        windows.push(window.format("%Y-%m-%dT%H:%M").to_string());
                    }
                }
            }
            date = date
                .succ_opt()
                .unwrap_or_else(|| to.date_naive() + ChronoDuration::days(1));
        }
    }

    for override_entry in overrides {
        let window = DateTime::parse_from_rfc3339(&override_entry.scheduled_run_at)
            .ok()
            .or_else(|| {
                chrono::NaiveDateTime::parse_from_str(
                    &override_entry.scheduled_run_at,
                    "%Y-%m-%dT%H:%M",
                )
                .ok()
                .and_then(|naive| to.offset().from_local_datetime(&naive).single())
            });
        if let Some(window) = window {
            if window > from && window <= to {
                windows.push(window.format("%Y-%m-%dT%H:%M").to_string());
            }
        }
    }

    windows.sort();
    windows.dedup();
    Ok(windows)
}

fn cadence_allows_date(cadence: &str, weekday: chrono::Weekday) -> bool {
    match cadence {
        "daily" => true,
        "weekdays" => !matches!(weekday, chrono::Weekday::Sat | chrono::Weekday::Sun),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> Repository {
        let dir =
            std::env::temp_dir().join(format!("raven-scheduler-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Repository::open(dir.join("raven.sqlite3")).unwrap()
    }

    #[test]
    fn tick_runs_due_weekday_window_and_persists_last_check() {
        let mut repository = repo();
        repository
            .set_setting(
                "scheduler:last_check_at",
                serde_json::json!("2026-06-08T16:59:00-06:00"),
            )
            .unwrap();

        let results = run_scheduler_tick_at(&mut repository, "2026-06-08T17:00:05-06:00").unwrap();

        assert!(!results.is_empty());
        assert!(results
            .iter()
            .all(|result| result.run.trigger_kind == "schedule"));
        assert_eq!(
            repository
                .setting_json("scheduler:last_check_at")
                .unwrap()
                .and_then(|value| value.as_str().map(str::to_string))
                .as_deref(),
            Some("2026-06-08T17:00:05-06:00")
        );
    }

    #[test]
    fn scheduler_controller_reports_running_state() {
        let dir = std::env::temp_dir().join(format!(
            "raven-scheduler-controller-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("raven.sqlite3");
        let mut controller = SchedulerService::new(db_path);

        assert!(!controller.status().running);
        controller.start().unwrap();
        assert!(controller.status().running);
        controller.stop().unwrap();
        assert!(!controller.status().running);
    }
}
