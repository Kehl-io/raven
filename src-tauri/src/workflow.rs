use crate::capabilities::{capability_for, Capability, CapabilityStatus, ExecutionMode};
use crate::models::{
    CapabilityAvailability, CapabilityDescriptor, RavenWorkflow, WorkflowDefaults, WorkflowDraft,
    WorkflowDraftRevisionContext, WorkflowScheduleDefinition, WorkflowStepDefinition,
    WorkflowStepKind,
};
use crate::plugins::{self, PluginManifest};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum WorkflowError {
    #[error("{0}")]
    Validation(String),
}

pub fn daily_work_journal() -> RavenWorkflow {
    RavenWorkflow {
        schema_version: "0.1.0".into(),
        id: "daily-work-journal".into(),
        name: "Daily Work Journal".into(),
        description:
            "Summarizes local project activity into a concise daily work journal artifact.".into(),
        permissions: vec![
            "git:read".into(),
            "artifact:write".into(),
            "llm:generate".into(),
        ],
        defaults: WorkflowDefaults {
            llm_profile_ref: "default-openai".into(),
            destination_ref: "local-app".into(),
        },
        schedule: Some(WorkflowScheduleDefinition {
            cadence: "weekdays".into(),
            local_time: Some("17:00".into()),
        }),
        steps: vec![
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "collect-context".into(),
                name: "Collect local git context".into(),
                provider: "local_git".into(),
                action: "recent_activity".into(),
                depends_on: vec![],
                permissions: vec!["git:read".into()],
                inputs: serde_json::json!({ "window": "today" }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "compose-artifact".into(),
                name: "Compose journal artifact".into(),
                provider: "openai".into(),
                action: "generate_artifact".into(),
                depends_on: vec!["collect-context".into()],
                permissions: vec!["llm:generate".into()],
                inputs: serde_json::json!({ "template": "daily_work_journal", "prompt": "$steps.collect-context.summary" }),
                llm_profile_ref: Some("default-openai".into()),
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "write-artifact".into(),
                name: "Save artifact locally".into(),
                provider: "local_app".into(),
                action: "write_artifact".into(),
                depends_on: vec!["compose-artifact".into()],
                permissions: vec!["artifact:write".into()],
                inputs: serde_json::json!({ "artifact": "$steps.compose-artifact.artifact" }),
                llm_profile_ref: None,
                destination_ref: Some("local-app".into()),
                inline_code: None,
                parallel: None,
            },
        ],
    }
}

pub fn morning_brief() -> RavenWorkflow {
    let mut workflow = daily_work_journal();
    workflow.id = "morning-brief".into();
    workflow.name = "Morning Brief".into();
    workflow.description =
        "Builds a morning planning brief from local project context and recent artifacts.".into();
    workflow.permissions = vec![
        "git:read".into(),
        "artifact:read".into(),
        "artifact:write".into(),
        "llm:generate".into(),
    ];
    workflow.schedule = Some(WorkflowScheduleDefinition {
        cadence: "weekdays".into(),
        local_time: Some("08:00".into()),
    });
    workflow.steps[1].name = "Compose morning brief".into();
    workflow.steps[1].inputs = serde_json::json!({ "template": "morning_brief", "prompt": "$steps.collect-context.summary" });
    workflow
}

pub fn current_weather() -> RavenWorkflow {
    let mut workflow = prompt_native_agent_workflow("What's the weather today in Denver?");
    workflow.id = "current-weather".into();
    workflow.name = "Current Weather".into();
    workflow.description = "Asks an agent for today's Denver weather and stores the result.".into();
    workflow.defaults.llm_profile_ref = "codex-oauth-local".into();
    workflow.steps[0].name = "Ask AI for today's weather".into();
    workflow.steps[0].llm_profile_ref = Some("codex-oauth-local".into());
    workflow.steps[1].name = "Save weather artifact locally".into();
    workflow
}

#[cfg(test)]
pub fn deterministic_weather_workflow() -> RavenWorkflow {
    RavenWorkflow {
        schema_version: "0.1.0".into(),
        id: "open-meteo-weather".into(),
        name: "Open-Meteo Weather".into(),
        description: "Fetches current weather from Open-Meteo and stores the result.".into(),
        permissions: vec!["weather:read".into(), "artifact:write".into()],
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
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "write-artifact".into(),
                name: "Save weather artifact locally".into(),
                provider: "local_app".into(),
                action: "write_artifact".into(),
                depends_on: vec!["fetch-weather".into()],
                permissions: vec!["artifact:write".into()],
                inputs: serde_json::json!({ "artifact": "$steps.fetch-weather.artifact" }),
                llm_profile_ref: None,
                destination_ref: Some("local-app".into()),
                inline_code: None,
                parallel: None,
            },
        ],
    }
}

pub fn prompt_native_agent_workflow(prompt: &str) -> RavenWorkflow {
    RavenWorkflow {
        schema_version: "0.1.0".into(),
        id: format!(
            "agent-{}-{}",
            slugify_prompt(prompt),
            stable_prompt_hash(prompt)
        ),
        name: readable_title_from_prompt(prompt),
        description: "Runs a natural-language objective through the selected AI agent.".into(),
        permissions: vec![
            "llm:generate".into(),
            "network:read".into(),
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
                kind: WorkflowStepKind::AgentTask,
                id: "ask-ai".into(),
                name: "Ask AI".into(),
                provider: "agent".into(),
                action: "run_task".into(),
                depends_on: vec![],
                permissions: vec!["llm:generate".into(), "network:read".into()],
                inputs: serde_json::json!({
                    "objective": prompt,
                    "output_schema": "artifact_envelope",
                    "allowed_tools": ["web"]
                }),
                llm_profile_ref: Some("codex-oauth-local".into()),
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "write-artifact".into(),
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
        ],
    }
}

pub fn draft_from_prompt(prompt: &str) -> Result<WorkflowDraft, WorkflowError> {
    let normalized_prompt = prompt.to_lowercase();
    let (definition, planner_rationale) = if objective_looks_like_url_check(prompt) {
        (website_status_workflow(prompt), None)
    } else if is_seo_audit_prompt(prompt) {
        (seo_audit_workflow(prompt), None)
    } else if is_daily_work_journal_prompt(&normalized_prompt) {
        (daily_work_journal(), None)
    } else if is_morning_brief_prompt(&normalized_prompt) {
        (morning_brief(), None)
    } else if let Some((definition, planner_rationale)) =
        crate::planner::workflow_for_prompt(prompt)
    {
        (definition, Some(planner_rationale))
    } else if let Some(definition) = catalog_deterministic_workflow(prompt) {
        (definition, None)
    } else {
        (prompt_native_agent_workflow(prompt), None)
    };
    validate_workflow(&definition)?;
    let summary = draft_summary(&definition);

    Ok(WorkflowDraft {
        id: format!("draft-{}", Uuid::new_v4()),
        prompt: prompt.into(),
        summary,
        permission_changes: definition.permissions.clone(),
        destination_writes: vec![definition.defaults.destination_ref.clone()],
        diff_json: serde_json::json!([
            { "op": "template", "workflow_id": definition.id, "name": definition.name }
        ]),
        validation_status: "valid".into(),
        approval_status: "needs_review".into(),
        builder_profile_id: None,
        approval_mode: approval_mode_from_prompt(prompt),
        validation_errors: vec![],
        planner_rationale,
        definition,
        created_at: Utc::now().to_rfc3339(),
    })
}

pub fn draft_revision_from_prompt(
    prompt: &str,
    previous_draft: &WorkflowDraftRevisionContext,
) -> Result<WorkflowDraft, WorkflowError> {
    let mut definition = previous_draft.definition.clone();
    let mut changed = false;

    changed |= apply_transform_revision(prompt, &mut definition);
    changed |= apply_metadata_revision(prompt, &mut definition);
    changed |= apply_schedule_revision(prompt, &mut definition);
    changed |= apply_artifact_intent_revision(prompt, &mut definition);

    validate_workflow(&definition)?;
    let summary = if changed {
        "Deterministic revision updated the previous workflow draft.".to_string()
    } else {
        "Deterministic revision kept the previous workflow draft because no supported deterministic edit was detected.".to_string()
    };

    Ok(WorkflowDraft {
        id: format!("draft-{}", Uuid::new_v4()),
        prompt: prompt.into(),
        summary,
        permission_changes: definition.permissions.clone(),
        destination_writes: vec![definition.defaults.destination_ref.clone()],
        diff_json: serde_json::json!([
            {
                "op": "deterministic_revision",
                "workflow_id": definition.id,
                "changed": changed
            }
        ]),
        validation_status: "valid".into(),
        approval_status: "needs_review".into(),
        builder_profile_id: None,
        approval_mode: approval_mode_from_prompt(prompt),
        validation_errors: vec![],
        planner_rationale: previous_draft.planner_rationale.clone(),
        definition,
        created_at: Utc::now().to_rfc3339(),
    })
}

fn apply_transform_revision(prompt: &str, definition: &mut RavenWorkflow) -> bool {
    let Some(transform_step) = definition
        .steps
        .iter_mut()
        .find(|step| step.provider == "data" && step.action == "transform_json")
    else {
        return false;
    };

    let mut changed = false;
    if request_removes_filter(prompt) {
        if let Some(inputs) = transform_step.inputs.as_object_mut() {
            changed |= inputs.remove("filter_equals").is_some();
        }
    } else if let Some((field, value)) = filter_equals_from_prompt(prompt) {
        let next = serde_json::json!({ field: value });
        if transform_step.inputs.get("filter_equals") != Some(&next) {
            transform_step.inputs["filter_equals"] = next;
            changed = true;
        }
    }

    if let Some(select_fields) = select_fields_from_prompt(prompt) {
        let next = serde_json::json!(select_fields);
        if transform_step.inputs.get("select_fields") != Some(&next) {
            transform_step.inputs["select_fields"] = next;
            changed = true;
        }
    }

    if let Some(sort_by) = sort_field_from_prompt(prompt) {
        let next = serde_json::json!(sort_by);
        if transform_step.inputs.get("sort_by") != Some(&next) {
            transform_step.inputs["sort_by"] = next;
            changed = true;
        }
    }

    if let Some(sort_direction) = sort_direction_from_prompt(prompt) {
        let next = serde_json::json!(sort_direction);
        if transform_step.inputs.get("sort_direction") != Some(&next) {
            transform_step.inputs["sort_direction"] = next;
            changed = true;
        }
    }

    if let Some(limit) = numeric_value_after_any(prompt, &["limit", "top", "first"]) {
        let next = serde_json::json!(limit);
        if transform_step.inputs.get("limit") != Some(&next) {
            transform_step.inputs["limit"] = next;
            changed = true;
        }
    }

    changed
}

fn apply_metadata_revision(prompt: &str, definition: &mut RavenWorkflow) -> bool {
    let mut changed = false;
    if let Some(name) = text_after_any_phrase(
        prompt,
        &[
            "rename workflow to",
            "rename it to",
            "change workflow name to",
            "change name to",
            "name it",
        ],
    ) {
        let name = trim_title_value(&name);
        if !name.is_empty() && definition.name != name {
            definition.name = name;
            changed = true;
        }
    }

    if let Some(description) = text_after_any_phrase(
        prompt,
        &[
            "change description to",
            "update description to",
            "description to",
        ],
    ) {
        let description = trim_sentence_value(&description);
        if !description.is_empty() && definition.description != description {
            definition.description = description;
            changed = true;
        }
    }

    changed
}

fn apply_schedule_revision(prompt: &str, definition: &mut RavenWorkflow) -> bool {
    let normalized = prompt.to_ascii_lowercase();
    if !contains_any(
        &normalized,
        &["schedule", "cadence", "run daily", "run weekdays", "manual"],
    ) {
        return false;
    }

    let Some(cadence) = schedule_cadence_from_prompt(&normalized) else {
        return false;
    };
    let next = WorkflowScheduleDefinition {
        cadence: cadence.into(),
        local_time: if cadence == "manual" {
            None
        } else {
            local_time_from_prompt(prompt)
        },
    };
    if definition.schedule.as_ref() == Some(&next) {
        false
    } else {
        definition.schedule = Some(next);
        true
    }
}

fn apply_artifact_intent_revision(prompt: &str, definition: &mut RavenWorkflow) -> bool {
    let normalized = prompt.to_ascii_lowercase();
    if !contains_any(
        &normalized,
        &[
            "artifact summary",
            "summary intent",
            "summary to",
            "summarize to",
            "focus on",
        ],
    ) {
        return false;
    }
    let Some(agent_step) = definition
        .steps
        .iter_mut()
        .find(|step| step.provider == "agent" && step.action == "run_task")
    else {
        return false;
    };
    let focus = text_after_any_phrase(
        prompt,
        &[
            "focus on",
            "artifact summary to",
            "summary intent to",
            "summary to",
            "summarize to",
        ],
    )
    .map(|value| trim_sentence_value(&value))
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| prompt.trim().to_string());
    let existing = agent_step
        .inputs
        .get("objective")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if existing
        .to_ascii_lowercase()
        .contains(&focus.to_ascii_lowercase())
    {
        return false;
    }
    agent_step.inputs["objective"] =
        serde_json::json!(format!("{existing} Revision focus: {focus}"));
    true
}

pub fn deterministic_first_workflow_for_prompt(prompt: &str) -> Option<RavenWorkflow> {
    if objective_looks_like_url_check(prompt) {
        Some(website_status_workflow(prompt))
    } else if is_seo_audit_prompt(prompt) {
        Some(seo_audit_workflow(prompt))
    } else if let Some((workflow, _plan)) = crate::planner::workflow_for_prompt(prompt) {
        Some(workflow)
    } else if let Some(workflow) = catalog_deterministic_workflow(prompt) {
        Some(workflow)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeterministicPlanKind {
    WeatherNews,
    WebExtraction,
    WebMetadata,
    ContentPreparation,
    DataPreparation,
    FeedSummary,
    Weather,
    NewsBrief,
    JsonLdValidation,
}

impl DeterministicPlanKind {
    fn id_prefix(self) -> &'static str {
        match self {
            Self::WeatherNews => "weather-news-brief",
            Self::WebExtraction => "web-research-summary",
            Self::WebMetadata => "web-metadata-extraction",
            Self::ContentPreparation => "content-research-draft",
            Self::DataPreparation => "data-summary",
            Self::FeedSummary => "feed-summary",
            Self::Weather => "weather-brief",
            Self::NewsBrief => "news-brief",
            Self::JsonLdValidation => "json-ld-validation",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::WeatherNews => "Weather News Brief",
            Self::WebExtraction => "Web Research Summary",
            Self::WebMetadata => "Web Metadata Extraction",
            Self::ContentPreparation => "Content Research Draft",
            Self::DataPreparation => "CSV Data Summary",
            Self::FeedSummary => "Feed Summary",
            Self::Weather => "Weather Brief",
            Self::NewsBrief => "News Brief",
            Self::JsonLdValidation => "JSON-LD Validation",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::WeatherNews => {
                "Collects deterministic weather and news data before writing a planning brief."
            }
            Self::WebExtraction => {
                "Fetches and extracts deterministic web evidence before writing a summary."
            }
            Self::WebMetadata => {
                "Fetches a page and extracts deterministic metadata before writing a summary."
            }
            Self::ContentPreparation => {
                "Prepares deterministic content research and a brief before drafting final prose."
            }
            Self::DataPreparation => {
                "Parses and shapes deterministic CSV data before writing a concise summary."
            }
            Self::FeedSummary => "Fetches a deterministic feed before writing a concise summary.",
            Self::Weather => "Fetches deterministic weather data before writing a concise brief.",
            Self::NewsBrief => "Collects deterministic news data before writing a concise brief.",
            Self::JsonLdValidation => {
                "Validates a JSON-LD payload before writing a concise validation summary."
            }
        }
    }
}

fn catalog_deterministic_workflow(prompt: &str) -> Option<RavenWorkflow> {
    let normalized = prompt.to_lowercase();
    let mut steps = Vec::new();
    let mut kind = None;
    let urls = detected_urls(prompt);

    if should_plan_weather(&normalized) {
        kind = Some(if should_plan_news(&normalized) {
            DeterministicPlanKind::WeatherNews
        } else {
            DeterministicPlanKind::Weather
        });
        let weather_provider = if contains_any(&normalized, &["open-meteo", "open meteo"])
            || (normalized.contains("current") && !normalized.contains("forecast"))
        {
            "open_meteo"
        } else {
            "weather"
        };
        push_catalog_step(
            &mut steps,
            weather_provider,
            if normalized.contains("hourly") {
                "hourly_forecast"
            } else if contains_any(&normalized, &["open-meteo", "open meteo"])
                || (normalized.contains("current") && !normalized.contains("forecast"))
            {
                "current_weather"
            } else {
                "forecast_24h"
            },
            "weather",
            "Fetch weather",
            vec![],
            weather_inputs(prompt),
        )?;
    }

    if should_plan_news(&normalized) {
        kind.get_or_insert(DeterministicPlanKind::NewsBrief);
        push_catalog_step(
            &mut steps,
            "news",
            "trending",
            "news",
            "Fetch news",
            vec![],
            serde_json::json!({ "max_items": 5 }),
        )?;
    }

    if should_plan_feed(&normalized, &urls) {
        let feed_url = urls.iter().find(|url| is_feed_url(url)).cloned()?;
        kind.get_or_insert(DeterministicPlanKind::FeedSummary);
        push_catalog_step(
            &mut steps,
            "rss",
            "fetch_feed",
            "feed",
            "Fetch feed",
            vec![],
            serde_json::json!({
                "url": feed_url,
                "max_items": 10
            }),
        )?;
    } else if should_plan_web_extraction(&normalized, &urls) {
        kind.get_or_insert_with(|| {
            if should_extract_metadata(&normalized) && !should_extract_article(&normalized) {
                DeterministicPlanKind::WebMetadata
            } else {
                DeterministicPlanKind::WebExtraction
            }
        });
        let url = urls
            .first()
            .cloned()
            .unwrap_or_else(|| "https://example.com".into());
        push_catalog_step(
            &mut steps,
            "web",
            "fetch_page",
            "fetch-page",
            "Fetch page",
            vec![],
            serde_json::json!({ "url": url, "max_bytes": 524288 }),
        )?;
        if should_extract_article(&normalized) {
            push_catalog_step(
                &mut steps,
                "web",
                "extract_article",
                "extract-article",
                "Extract article",
                vec!["fetch-page".into()],
                serde_json::json!({
                    "body_text": "$steps.fetch-page.body_text",
                    "url": url
                }),
            )?;
        }
        if should_extract_metadata(&normalized) {
            push_catalog_step(
                &mut steps,
                "web",
                "extract_metadata",
                "extract-metadata",
                "Extract metadata",
                vec!["fetch-page".into()],
                serde_json::json!({
                    "body_text": "$steps.fetch-page.body_text",
                    "url": url
                }),
            )?;
        }
    }

    if should_plan_content_preparation(&normalized) {
        kind.get_or_insert(DeterministicPlanKind::ContentPreparation);
        let topic = content_topic(prompt);
        let page_type = page_type_from_prompt(&normalized);
        push_catalog_step(
            &mut steps,
            "content",
            "map_search_intent",
            "map-search-intent",
            "Map search intent",
            vec![],
            serde_json::json!({
                "topic": topic,
                "audience": audience_from_prompt(prompt),
                "page_type": page_type,
                "business_goal": business_goal_from_prompt(&normalized),
            }),
        )?;
        let content_sources = deterministic_source_refs(&steps);
        push_catalog_step(
            &mut steps,
            "content",
            "generate_brief",
            "generate-brief",
            "Generate content brief",
            vec!["map-search-intent".into()],
            serde_json::json!({
                "topic": topic,
                "audience": audience_from_prompt(prompt),
                "page_type": page_type,
                "business_goal": business_goal_from_prompt(&normalized),
                "sources": content_sources,
            }),
        )?;
    }

    if should_plan_csv_parse(&normalized) {
        kind.get_or_insert(DeterministicPlanKind::DataPreparation);
        push_catalog_step(
            &mut steps,
            "data",
            "parse_csv",
            "parse-csv",
            "Parse CSV",
            vec![],
            serde_json::json!({ "content": csv_content_from_prompt(prompt), "has_headers": true }),
        )?;
        if should_plan_data_transform(&normalized) {
            push_catalog_step(
                &mut steps,
                "data",
                "transform_json",
                "transform-data",
                "Transform data",
                vec!["parse-csv".into()],
                data_transform_inputs(prompt),
            )?;
        }
    }

    if should_plan_json_ld_validation(&normalized) {
        kind.get_or_insert(DeterministicPlanKind::JsonLdValidation);
        push_catalog_step(
            &mut steps,
            "seo",
            "validate_json_ld",
            "validate-json-ld",
            "Validate JSON-LD",
            vec![],
            serde_json::json!({ "json_ld": json_ld_payload_from_prompt(prompt) }),
        )?;
    }

    if steps.is_empty() {
        return None;
    }

    Some(deterministic_mixed_workflow(
        prompt,
        kind.unwrap_or(DeterministicPlanKind::WebExtraction),
        steps,
    ))
}

fn push_catalog_step(
    steps: &mut Vec<WorkflowStepDefinition>,
    provider: &str,
    action: &str,
    id: &str,
    fallback_name: &str,
    depends_on: Vec<String>,
    inputs: serde_json::Value,
) -> Option<()> {
    let capability = deterministic_catalog_capability(provider, action)?;
    steps.push(WorkflowStepDefinition {
        kind: WorkflowStepKind::ProviderAction,
        id: id.into(),
        name: if capability.display_name.is_empty() {
            fallback_name.into()
        } else {
            capability.display_name
        },
        provider: capability.provider,
        action: capability.action,
        depends_on,
        permissions: capability.permissions,
        inputs,
        llm_profile_ref: None,
        destination_ref: None,
        inline_code: None,
        parallel: None,
    });
    Some(())
}

fn deterministic_catalog_capability(provider: &str, action: &str) -> Option<Capability> {
    crate::capabilities::capability_catalog()
        .into_iter()
        .find(|capability| {
            capability.status == CapabilityStatus::Implemented
                && capability.execution_mode == ExecutionMode::Deterministic
                && capability.provider == provider
                && capability.action == action
        })
}

fn deterministic_mixed_workflow(
    prompt: &str,
    kind: DeterministicPlanKind,
    mut steps: Vec<WorkflowStepDefinition>,
) -> RavenWorkflow {
    let metadata = deterministic_workflow_metadata(kind, &steps);
    let deterministic_step_ids = steps.iter().map(|step| step.id.clone()).collect::<Vec<_>>();
    let deterministic_refs = deterministic_step_ids
        .iter()
        .map(|id| format!("$steps.{id}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut permissions = steps
        .iter()
        .flat_map(|step| step.permissions.clone())
        .collect::<Vec<_>>();
    permissions.push("llm:generate".into());
    permissions.push("artifact:write".into());
    permissions = unique_strings(permissions);

    steps.push(WorkflowStepDefinition {
        kind: WorkflowStepKind::AgentTask,
        id: "summarize".into(),
        name: "Summarize findings".into(),
        provider: "agent".into(),
        action: "run_task".into(),
        depends_on: deterministic_step_ids,
        permissions: vec!["llm:generate".into()],
        inputs: serde_json::json!({
            "objective": format!(
                "Using only deterministic provider outputs from {deterministic_refs}, write the requested Markdown artifact for this workflow: {prompt}. Do not fetch the web or invent source facts."
            ),
            "output_schema": "artifact_envelope",
            "allowed_tools": []
        }),
        llm_profile_ref: Some("codex-oauth-local".into()),
        destination_ref: None,
        inline_code: None,
        parallel: None,
    });
    steps.push(WorkflowStepDefinition {
        kind: WorkflowStepKind::ProviderAction,
        id: "write-artifact".into(),
        name: "Save artifact locally".into(),
        provider: "local_app".into(),
        action: "write_artifact".into(),
        depends_on: vec!["summarize".into()],
        permissions: vec!["artifact:write".into()],
        inputs: serde_json::json!({ "artifact": "$steps.summarize.artifact" }),
        llm_profile_ref: None,
        destination_ref: Some("local-app".into()),
        inline_code: None,
        parallel: None,
    });

    RavenWorkflow {
        schema_version: "0.1.0".into(),
        id: format!("{}-{}", metadata.id_prefix, stable_prompt_hash(prompt)),
        name: metadata.name.into(),
        description: metadata.description.into(),
        permissions,
        defaults: WorkflowDefaults {
            llm_profile_ref: "codex-oauth-local".into(),
            destination_ref: "local-app".into(),
        },
        schedule: Some(WorkflowScheduleDefinition {
            cadence: "manual".into(),
            local_time: None,
        }),
        steps,
    }
}

struct DeterministicWorkflowMetadata {
    id_prefix: &'static str,
    name: &'static str,
    description: &'static str,
}

fn deterministic_workflow_metadata(
    kind: DeterministicPlanKind,
    steps: &[WorkflowStepDefinition],
) -> DeterministicWorkflowMetadata {
    if matches!(
        kind,
        DeterministicPlanKind::WeatherNews | DeterministicPlanKind::ContentPreparation
    ) {
        return kind_metadata(kind);
    }

    let families = [
        steps.iter().any(|step| step.provider == "web"),
        steps.iter().any(|step| step.provider == "seo"),
        steps.iter().any(|step| step.provider == "data"),
        steps.iter().any(|step| step.provider == "rss"),
        steps
            .iter()
            .any(|step| matches!(step.provider.as_str(), "weather" | "open_meteo")),
        steps.iter().any(|step| step.provider == "news"),
        steps.iter().any(|step| step.provider == "content"),
    ];
    if families.into_iter().filter(|present| *present).count() > 1 {
        return DeterministicWorkflowMetadata {
            id_prefix: "deterministic-workflow",
            name: "Deterministic Workflow",
            description:
                "Runs the requested deterministic provider operations before writing a final artifact.",
        };
    }

    kind_metadata(kind)
}

fn kind_metadata(kind: DeterministicPlanKind) -> DeterministicWorkflowMetadata {
    DeterministicWorkflowMetadata {
        id_prefix: kind.id_prefix(),
        name: kind.name(),
        description: kind.description(),
    }
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn should_plan_weather(normalized: &str) -> bool {
    contains_any(
        normalized,
        &["weather", "forecast", "hourly", "open-meteo", "open meteo"],
    ) && (prompt_mentions_capability(normalized, "weather", "forecast_24h")
        || prompt_mentions_capability(normalized, "weather", "hourly_forecast")
        || prompt_mentions_capability(normalized, "open_meteo", "current_weather"))
}

fn should_plan_news(normalized: &str) -> bool {
    contains_any(normalized, &["news", "headline", "headlines", "trending"])
        && (prompt_mentions_capability(normalized, "news", "trending")
            || prompt_mentions_capability(normalized, "news", "search"))
}

fn should_plan_feed(normalized: &str, urls: &[String]) -> bool {
    let has_feed_url = urls.iter().any(|url| is_feed_url(url));
    let prompt_requests_feed = contains_word_any(normalized, &["rss", "feed", "atom"])
        || contains_any(
            normalized,
            &[
                "rss feed",
                "atom feed",
                "feed digest",
                "fetch the feed",
                "parse the feed",
            ],
        );
    let feed_url_summary = urls.iter().any(|url| is_feed_url(url))
        && contains_any(
            normalized,
            &["summarize", "summary", "digest", "fetch", "parse"],
        );
    has_feed_url
        && (prompt_requests_feed || feed_url_summary)
        && deterministic_catalog_capability("rss", "fetch_feed").is_some()
}

fn should_plan_web_extraction(normalized: &str, urls: &[String]) -> bool {
    let explicit_web_collection = contains_any(
        normalized,
        &[
            "fetch",
            "fetches",
            "fetching",
            "web page",
            "article",
            "metadata",
            "extract",
            "scrape",
            "crawl page",
        ],
    );
    let url_summary = contains_any(
        normalized,
        &[
            "summarize",
            "summary",
            "report",
            "brief",
            "analyze",
            "recommendation",
        ],
    ) && !is_embedded_data_only_prompt(normalized);

    !urls.is_empty()
        && (explicit_web_collection || url_summary)
        && deterministic_catalog_capability("web", "fetch_page").is_some()
}

fn should_extract_article(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "extract article",
            "article text",
            "readable article",
            "full text",
            "body text",
        ],
    ) || (contains_word(normalized, "article")
        && contains_any(normalized, &["summarize", "summary", "report", "brief"]))
}

fn should_extract_metadata(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "metadata",
            "title",
            "description",
            "canonical",
            "open graph",
            "og:",
        ],
    )
}

fn should_plan_content_preparation(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "content brief",
            "service page",
            "landing page",
            "homepage",
            "home page",
            "site content",
            "site copy",
            "final draft",
            "draft for",
            "seo",
        ],
    ) && (prompt_mentions_capability(normalized, "content", "map_search_intent")
        || prompt_mentions_capability(normalized, "content", "generate_brief"))
}

fn should_plan_csv_parse(normalized: &str) -> bool {
    normalized.contains("csv") && prompt_mentions_capability(normalized, "data", "parse_csv")
}

fn should_plan_data_transform(normalized: &str) -> bool {
    normalized.contains("csv")
        && contains_any(
            normalized,
            &[
                "filter",
                "where ",
                "sort",
                "limit",
                "top ",
                "select",
                "project",
                "transform",
            ],
        )
        && deterministic_catalog_capability("data", "transform_json").is_some()
}

fn should_plan_json_ld_validation(normalized: &str) -> bool {
    contains_any(
        normalized,
        &["json-ld", "json ld", "schema payload", "structured data"],
    ) && contains_any(
        normalized,
        &["validate", "validation", "validates", "errors"],
    ) && prompt_mentions_capability(normalized, "seo", "validate_json_ld")
}

fn is_embedded_data_only_prompt(normalized: &str) -> bool {
    should_plan_json_ld_validation(normalized)
        && !contains_any(
            normalized,
            &[
                "fetch",
                "fetches",
                "fetching",
                "web page",
                "page at",
                "from http",
                "at http",
                "scrape",
                "crawl",
            ],
        )
}

fn prompt_mentions_capability(normalized: &str, provider: &str, action: &str) -> bool {
    let Some(capability) = deterministic_catalog_capability(provider, action) else {
        return false;
    };
    let prompt_tokens = token_set(normalized);
    let capability_text = format!(
        "{} {} {} {} {}",
        capability.display_name,
        capability.description,
        capability.intent_tags.join(" "),
        capability.best_for.join(" "),
        capability.builder_guidance
    )
    .to_ascii_lowercase();
    let capability_tokens = token_set(&capability_text);
    let overlapping_specific_terms = prompt_tokens
        .iter()
        .filter(|token| token.len() >= 3)
        .filter(|token| !generic_planning_token(token))
        .filter(|token| capability_tokens.contains(*token))
        .count();
    overlapping_specific_terms > 0
}

fn token_set(text: &str) -> HashSet<String> {
    text.split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| token.len() > 1)
        .map(str::to_ascii_lowercase)
        .collect()
}

fn generic_planning_token(token: &str) -> bool {
    matches!(
        token,
        "workflow"
            | "about"
            | "after"
            | "before"
            | "create"
            | "build"
            | "from"
            | "write"
            | "writes"
            | "with"
            | "then"
            | "that"
            | "this"
            | "these"
            | "those"
            | "into"
            | "only"
            | "using"
            | "uses"
            | "use"
            | "and"
            | "the"
            | "for"
            | "all"
            | "any"
            | "summary"
            | "summarize"
            | "brief"
            | "report"
            | "research"
            | "markdown"
            | "artifact"
            | "final"
            | "daily"
            | "weekly"
            | "morning"
    )
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn contains_word_any(haystack: &str, words: &[&str]) -> bool {
    words.iter().any(|word| contains_word(haystack, word))
}

fn contains_word(haystack: &str, word: &str) -> bool {
    haystack.match_indices(word).any(|(start, _)| {
        let end = start + word.len();
        let before = haystack[..start].chars().next_back();
        let after = haystack[end..].chars().next();
        before
            .map(|character| !character.is_ascii_alphanumeric() && character != '_')
            .unwrap_or(true)
            && after
                .map(|character| !character.is_ascii_alphanumeric() && character != '_')
                .unwrap_or(true)
    })
}

fn is_feed_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let path = parsed.path().trim_matches('/').to_ascii_lowercase();
    if path.is_empty() {
        return false;
    }
    let last_segment = path.rsplit('/').next().unwrap_or_default();
    matches!(last_segment, "feed" | "rss" | "atom")
        || matches!(
            last_segment,
            "feed.xml" | "rss.xml" | "atom.xml" | "index.rss" | "index.atom"
        )
        || last_segment.ends_with(".rss")
        || last_segment.ends_with(".atom")
}

fn weather_inputs(prompt: &str) -> serde_json::Value {
    serde_json::json!({ "location": location_from_prompt(prompt), "hours": 24 })
}

fn location_from_prompt(prompt: &str) -> String {
    let normalized = prompt.to_lowercase();
    if normalized.contains("denver") {
        "Denver, CO".into()
    } else {
        "Denver, CO".into()
    }
}

fn content_topic(prompt: &str) -> String {
    let collapsed = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .split_once(" for ")
        .map(|(_, tail)| tail.trim_end_matches('.').to_string())
        .filter(|topic| !topic.is_empty())
        .unwrap_or_else(|| collapsed)
}

fn audience_from_prompt(prompt: &str) -> String {
    prompt
        .split_once(" for ")
        .map(|(_, tail)| tail.trim_end_matches('.').to_string())
        .unwrap_or_else(|| "general audience".into())
}

fn page_type_from_prompt(normalized: &str) -> &'static str {
    if normalized.contains("service page") || normalized.contains("service-page") {
        "service"
    } else if normalized.contains("landing") {
        "landing"
    } else if normalized.contains("blog") || normalized.contains("article") {
        "blog"
    } else if normalized.contains("homepage") || normalized.contains("home page") {
        "homepage"
    } else {
        "other"
    }
}

fn business_goal_from_prompt(normalized: &str) -> &'static str {
    if normalized.contains("book") || normalized.contains("lead") || normalized.contains("convert")
    {
        "generate qualified leads"
    } else {
        "produce useful source-grounded content"
    }
}

fn deterministic_source_refs(steps: &[WorkflowStepDefinition]) -> Vec<serde_json::Value> {
    steps
        .iter()
        .filter(|step| step.provider == "web" || step.provider == "seo" || step.provider == "rss")
        .map(|step| serde_json::json!({ "step": step.id }))
        .collect()
}

fn data_transform_inputs(prompt: &str) -> serde_json::Value {
    let mut inputs = serde_json::json!({ "data": "$steps.parse-csv.rows" });
    if let Some((field, value)) = filter_equals_from_prompt(prompt) {
        inputs["filter_equals"] = serde_json::json!({ field: value });
    }
    if let Some(select_fields) = select_fields_from_prompt(prompt) {
        inputs["select_fields"] = serde_json::json!(select_fields);
    }
    if let Some(sort_by) = sort_field_from_prompt(prompt) {
        inputs["sort_by"] = serde_json::json!(sort_by);
    }
    if let Some(limit) = numeric_value_after_any(prompt, &["limit", "top"]) {
        inputs["limit"] = serde_json::json!(limit);
    }
    inputs
}

fn filter_equals_from_prompt(prompt: &str) -> Option<(String, String)> {
    let after_filter = tail_after_any_case_insensitive(prompt, &["filter ", "where "])?;
    let token = after_filter
        .split_whitespace()
        .find(|token| token.contains('='))?;
    let (field, value) = token.split_once('=')?;
    let field = clean_identifier(field);
    let value = clean_identifier(value);
    if field.is_empty() || value.is_empty() {
        None
    } else {
        Some((field, value))
    }
}

fn select_fields_from_prompt(prompt: &str) -> Option<Vec<String>> {
    let clause = clause_after_any_case_insensitive(
        prompt,
        &[
            "replace selected fields with",
            "replace selected columns with",
            "replace fields with",
            "replace columns with",
            "projected fields to",
            "projected fields with",
            "projected columns to",
            "projected columns with",
            "selected fields to",
            "selected fields with",
            "selected columns to",
            "selected columns with",
            "fields to",
            "fields with",
            "columns to",
            "columns with",
            "only keep",
            "keep only",
            "select ",
            "project ",
        ],
        field_list_clause_boundaries(),
    )?;
    field_list_from_clause(&clause)
}

fn field_list_from_clause(clause: &str) -> Option<Vec<String>> {
    let stop_words = ["then", "instead"];
    let skip_words = [
        "field", "fields", "column", "columns", "only", "and", "to", "with",
    ];
    let mut fields = Vec::new();
    for token in clause.split(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                ',' | ';' | ':' | '.' | ')' | '(' | '[' | ']' | '{' | '}'
            )
    }) {
        let token = clean_identifier(token);
        let normalized_token = token.to_ascii_lowercase();
        if token.is_empty() || skip_words.contains(&normalized_token.as_str()) {
            continue;
        }
        if stop_words.contains(&normalized_token.as_str()) {
            break;
        }
        fields.push(token);
    }
    (!fields.is_empty()).then_some(fields)
}

fn sort_field_from_prompt(prompt: &str) -> Option<String> {
    ["sort by", "order by", "sorted by", "sorting by"]
        .iter()
        .find_map(|phrase| value_after_phrase(prompt, phrase))
}

fn field_list_clause_boundaries() -> &'static [&'static str] {
    &[
        "\n",
        ".",
        ";",
        " then ",
        " before writing",
        " before saving",
        " sort by",
        " sorted by",
        " sorting by",
        " order by",
        " ordered by",
        " limit ",
        " top ",
        " schedule ",
        " cadence ",
        " rename ",
        " change description",
        " update description",
        " description ",
        " focus on",
        " artifact ",
        " summary ",
        " filter ",
        " where ",
        " remove filter",
        " remove the filter",
        " clear filter",
        " clear the filter",
    ]
}

fn clause_after_any_case_insensitive(
    value: &str,
    phrases: &[&str],
    boundaries: &[&str],
) -> Option<String> {
    let normalized = value.to_ascii_lowercase();
    let (start, phrase_len) = phrases
        .iter()
        .filter_map(|phrase| normalized.find(phrase).map(|index| (index, phrase.len())))
        .min_by(|(left_index, left_len), (right_index, right_len)| {
            left_index
                .cmp(right_index)
                .then_with(|| right_len.cmp(left_len))
        })?;
    let tail_start = start + phrase_len;
    let tail = value
        .get(tail_start..)?
        .trim_start_matches(|character: char| {
            character.is_whitespace() || matches!(character, ':' | '-' | '"' | '\'')
        });
    if tail.is_empty() {
        return None;
    }

    let normalized_tail = tail.to_ascii_lowercase();
    let end = boundaries
        .iter()
        .filter_map(|boundary| normalized_tail.find(boundary))
        .min()
        .unwrap_or(tail.len());
    Some(tail[..end].trim().to_string())
}

fn request_removes_filter(prompt: &str) -> bool {
    let normalized = prompt.to_ascii_lowercase();
    contains_any(
        &normalized,
        &[
            "remove the filter",
            "remove filter",
            "clear the filter",
            "clear filter",
            "drop the filter",
            "drop filter",
            "no filter",
            "without a filter",
            "without filtering",
            "include all rows",
        ],
    )
}

fn sort_direction_from_prompt(prompt: &str) -> Option<&'static str> {
    let normalized = prompt.to_ascii_lowercase();
    if contains_any(
        &normalized,
        &[
            "descending",
            "desc",
            "highest first",
            "largest first",
            "newest first",
            "reverse sort",
        ],
    ) {
        Some("desc")
    } else if contains_any(
        &normalized,
        &[
            "ascending",
            "asc",
            "lowest first",
            "smallest first",
            "oldest first",
        ],
    ) {
        Some("asc")
    } else {
        None
    }
}

fn value_after_phrase(prompt: &str, phrase: &str) -> Option<String> {
    let value = tail_after_case_insensitive(prompt, phrase)?
        .split(|character: char| {
            character.is_whitespace()
                || matches!(character, ',' | ';' | ':' | '.' | ')' | '(' | '[' | ']')
        })
        .find(|token| !token.is_empty())?;
    let value = clean_identifier(value);
    (!value.is_empty()).then_some(value)
}

fn text_after_any_phrase(prompt: &str, phrases: &[&str]) -> Option<String> {
    phrases
        .iter()
        .filter_map(|phrase| text_after_phrase(prompt, phrase))
        .next()
}

fn text_after_phrase(prompt: &str, phrase: &str) -> Option<String> {
    let tail = tail_after_case_insensitive(prompt, phrase)?;
    let trimmed = tail.trim_start_matches(|character: char| {
        character.is_whitespace() || matches!(character, ':' | '-' | '"' | '\'')
    });
    if trimmed.is_empty() {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    let mut end = trimmed.len();
    for separator in [
        "\n",
        ";",
        ". ",
        " and ",
        " schedule ",
        " update ",
        " change ",
    ] {
        if let Some(index) = lower.find(separator) {
            end = end.min(if separator == ". " { index + 1 } else { index });
        }
    }
    Some(trimmed[..end].trim().to_string())
}

fn trim_title_value(value: &str) -> String {
    value
        .trim()
        .trim_matches(|character: char| matches!(character, '"' | '\'' | '.' | ',' | ';' | ':'))
        .trim()
        .to_string()
}

fn trim_sentence_value(value: &str) -> String {
    let trimmed = value
        .trim()
        .trim_matches(|character: char| matches!(character, '"' | '\''))
        .trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.to_string()
    }
}

fn schedule_cadence_from_prompt(normalized: &str) -> Option<&'static str> {
    if contains_word(normalized, "manual") {
        Some("manual")
    } else if contains_word(normalized, "weekdays") || normalized.contains("weekday") {
        Some("weekdays")
    } else if contains_word(normalized, "daily") {
        Some("daily")
    } else {
        None
    }
}

fn local_time_from_prompt(prompt: &str) -> Option<String> {
    let bytes = prompt.as_bytes();
    if bytes.len() < 5 {
        return None;
    }
    for index in 0..=(bytes.len() - 5) {
        if bytes[index].is_ascii_digit()
            && bytes[index + 1].is_ascii_digit()
            && bytes[index + 2] == b':'
            && bytes[index + 3].is_ascii_digit()
            && bytes[index + 4].is_ascii_digit()
        {
            let hour = std::str::from_utf8(&bytes[index..index + 2])
                .ok()
                .and_then(|value| value.parse::<u8>().ok())?;
            let minute = std::str::from_utf8(&bytes[index + 3..index + 5])
                .ok()
                .and_then(|value| value.parse::<u8>().ok())?;
            if hour < 24 && minute < 60 {
                return Some(format!("{hour:02}:{minute:02}"));
            }
        }
    }
    None
}

fn numeric_value_after_any(prompt: &str, phrases: &[&str]) -> Option<u64> {
    phrases.iter().find_map(|phrase| {
        let tail = tail_after_case_insensitive(prompt, phrase)?;
        tail.split(|character: char| !character.is_ascii_digit())
            .find(|token| !token.is_empty())
            .and_then(|token| token.parse::<u64>().ok())
    })
}

fn tail_after_any_case_insensitive<'a>(value: &'a str, phrases: &[&str]) -> Option<&'a str> {
    phrases
        .iter()
        .filter_map(|phrase| tail_after_case_insensitive(value, phrase))
        .next()
}

fn tail_after_case_insensitive<'a>(value: &'a str, phrase: &str) -> Option<&'a str> {
    let normalized = value.to_ascii_lowercase();
    let start = normalized.find(phrase)?;
    value.get(start + phrase.len()..)
}

fn clean_identifier(value: &str) -> String {
    value
        .trim_matches(|character: char| {
            !character.is_ascii_alphanumeric() && character != '_' && character != '-'
        })
        .to_string()
}

fn json_ld_payload_from_prompt(prompt: &str) -> serde_json::Value {
    let parsed_candidates = json_object_candidates(prompt)
        .into_iter()
        .filter_map(|candidate| serde_json::from_str::<serde_json::Value>(candidate).ok())
        .collect::<Vec<_>>();
    let schema_candidate = parsed_candidates
        .iter()
        .find(|value| {
            value.get("@context").is_some()
                || value.get("@type").is_some()
                || value
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| value.contains("schema.org"))
        })
        .cloned();

    schema_candidate
        .or_else(|| parsed_candidates.into_iter().next())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn json_object_candidates(prompt: &str) -> Vec<&str> {
    let mut candidates = Vec::new();
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, character) in prompt.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        match character {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = Some(index);
                }
                depth += 1;
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start_index) = start.take() {
                        candidates.push(&prompt[start_index..=index]);
                    }
                }
            }
            _ => {}
        }
    }

    candidates
}

fn csv_content_from_prompt(prompt: &str) -> String {
    crate::csv_prompt::csv_content_from_prompt(prompt)
}

pub fn approval_mode_from_prompt(prompt: &str) -> Option<String> {
    let normalized = prompt.to_lowercase();
    [
        ("auto approve", "auto_approve"),
        ("auto-approve", "auto_approve"),
        ("auto approval", "auto_approve"),
        ("auto_approve", "auto_approve"),
        ("review changes", "review_changes"),
        ("review-changes", "review_changes"),
        ("review_changes", "review_changes"),
        ("always review", "always_review"),
        ("always-review", "always_review"),
        ("always_review", "always_review"),
    ]
    .iter()
    .filter_map(|(needle, mode)| normalized.rfind(needle).map(|index| (index, *mode)))
    .max_by_key(|(index, _)| *index)
    .map(|(_, mode)| mode.to_string())
}

fn is_daily_work_journal_prompt(normalized_prompt: &str) -> bool {
    normalized_prompt.contains("daily work journal")
        || normalized_prompt.contains("work journal")
        || normalized_prompt.contains("daily journal")
}

fn is_morning_brief_prompt(normalized_prompt: &str) -> bool {
    let normalized = normalized_prompt
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    matches!(
        normalized
            .trim_matches(|character: char| !character.is_ascii_alphanumeric())
            .trim(),
        "morning brief"
            | "morning briefing"
            | "create morning brief"
            | "create a morning brief"
            | "create morning briefing"
            | "create a morning briefing"
    )
}

fn is_seo_audit_prompt(prompt: &str) -> bool {
    let normalized = prompt.to_lowercase();
    let words = normalized
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<HashSet<_>>();
    let mentions_seo = words.contains("seo")
        || normalized.contains("search engine optimization")
        || normalized.contains("search-engine optimization");
    let mentions_audit = words.contains("audit")
        || words.contains("analyze")
        || words.contains("analyse")
        || words.contains("check")
        || words.contains("review")
        || words.contains("recommendations");
    let mentions_deterministic_evidence = words.contains("deterministic")
        || words.contains("deterministically")
        || words.contains("robots")
        || normalized.contains("robots.txt")
        || words.contains("sitemap")
        || words.contains("metadata")
        || words.contains("links")
        || words.contains("indexability")
        || words.contains("canonical");
    mentions_seo
        && mentions_audit
        && mentions_deterministic_evidence
        && (normalized.contains("http://")
            || normalized.contains("https://")
            || normalized.contains("www.")
            || contains_domain_like_token(&normalized))
}

fn seo_audit_workflow(prompt: &str) -> RavenWorkflow {
    let url = website_status_urls(prompt)
        .into_iter()
        .next()
        .unwrap_or_else(|| "https://example.com".into());
    RavenWorkflow {
        schema_version: "0.1.0".into(),
        id: "seo-audit".into(),
        name: "SEO Audit".into(),
        description:
            "Collects deterministic SEO evidence for a page and writes concise recommendations."
                .into(),
        permissions: vec![
            "network:read".into(),
            "data:read".into(),
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
                id: "fetch-page".into(),
                name: "Fetch page".into(),
                provider: "web".into(),
                action: "fetch_page".into(),
                depends_on: vec![],
                permissions: vec!["network:read".into()],
                inputs: serde_json::json!({ "url": url }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "fetch-robots".into(),
                name: "Fetch robots.txt".into(),
                provider: "seo".into(),
                action: "fetch_robots_txt".into(),
                depends_on: vec![],
                permissions: vec!["network:read".into(), "data:read".into()],
                inputs: serde_json::json!({ "site_url": url }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "parse-robots".into(),
                name: "Parse robots.txt".into(),
                provider: "seo".into(),
                action: "parse_robots_txt".into(),
                depends_on: vec!["fetch-robots".into()],
                permissions: vec!["network:read".into(), "data:read".into()],
                inputs: serde_json::json!({ "body_text": "$steps.fetch-robots.body_text" }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "fetch-sitemap".into(),
                name: "Fetch sitemap".into(),
                provider: "seo".into(),
                action: "fetch_sitemap".into(),
                depends_on: vec![],
                permissions: vec!["network:read".into(), "data:read".into()],
                inputs: serde_json::json!({ "site_url": url }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "parse-sitemap".into(),
                name: "Parse sitemap".into(),
                provider: "seo".into(),
                action: "parse_sitemap".into(),
                depends_on: vec!["fetch-sitemap".into()],
                permissions: vec!["network:read".into(), "data:read".into()],
                inputs: serde_json::json!({ "body_text": "$steps.fetch-sitemap.body_text" }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "audit-indexability".into(),
                name: "Audit indexability".into(),
                provider: "seo".into(),
                action: "audit_indexability".into(),
                depends_on: vec!["fetch-page".into(), "fetch-robots".into()],
                permissions: vec!["network:read".into(), "data:read".into()],
                inputs: serde_json::json!({
                    "url": url,
                    "body_text": "$steps.fetch-page.body_text",
                    "robots_txt": "$steps.fetch-robots.body_text"
                }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "audit-metadata".into(),
                name: "Audit metadata".into(),
                provider: "seo".into(),
                action: "audit_metadata".into(),
                depends_on: vec!["fetch-page".into()],
                permissions: vec!["network:read".into(), "data:read".into()],
                inputs: serde_json::json!({
                    "url": url,
                    "body_text": "$steps.fetch-page.body_text"
                }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "audit-links".into(),
                name: "Audit links".into(),
                provider: "seo".into(),
                action: "audit_links".into(),
                depends_on: vec!["fetch-page".into()],
                permissions: vec!["network:read".into(), "data:read".into()],
                inputs: serde_json::json!({
                    "base_url": url,
                    "body_text": "$steps.fetch-page.body_text"
                }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::AgentTask,
                id: "write-recommendations".into(),
                name: "Write recommendations".into(),
                provider: "agent".into(),
                action: "run_task".into(),
                depends_on: vec![
                    "fetch-page".into(),
                    "fetch-robots".into(),
                    "parse-robots".into(),
                    "fetch-sitemap".into(),
                    "parse-sitemap".into(),
                    "audit-indexability".into(),
                    "audit-metadata".into(),
                    "audit-links".into(),
                ],
                permissions: vec!["llm:generate".into()],
                inputs: serde_json::json!({
                    "objective": "Write concise Markdown SEO recommendations using only deterministic evidence from $steps.parse-robots, $steps.parse-sitemap, $steps.audit-indexability, $steps.audit-metadata, and $steps.audit-links. Do not fetch the web or invent crawl, sitemap, metadata, or link facts.",
                    "output_schema": "artifact_envelope",
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
                name: "Save recommendations".into(),
                provider: "local_app".into(),
                action: "write_artifact".into(),
                depends_on: vec!["write-recommendations".into()],
                permissions: vec!["artifact:write".into()],
                inputs: serde_json::json!({ "artifact": "$steps.write-recommendations.artifact" }),
                llm_profile_ref: None,
                destination_ref: Some("local-app".into()),
                inline_code: None,
                parallel: None,
            },
        ],
    }
}

fn website_status_workflow(prompt: &str) -> RavenWorkflow {
    RavenWorkflow {
        schema_version: "0.1.0".into(),
        id: "website-status-check".into(),
        name: "Website Status Check".into(),
        description:
            "Checks website reachability with a deterministic HTTP probe and stores a Markdown report."
                .into(),
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
                name: "Check websites".into(),
                provider: "http_probe".into(),
                action: "check_urls".into(),
                depends_on: vec![],
                permissions: vec!["network:read".into()],
                inputs: serde_json::json!({
                    "urls": website_status_urls(prompt),
                    "timeout_ms": 10_000
                }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
            WorkflowStepDefinition {
                kind: WorkflowStepKind::AgentTask,
                id: "compile-report".into(),
                name: "Compile status report".into(),
                provider: "agent".into(),
                action: "run_task".into(),
                depends_on: vec!["check-sites".into()],
                permissions: vec!["llm:generate".into()],
                inputs: serde_json::json!({
                    "objective": "Write a concise Markdown status report from deterministic URL check results in $steps.check-sites.results. Do not re-check websites or use web tools.",
                    "output_schema": "artifact_envelope",
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
                name: "Save status report".into(),
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
    }
}

fn website_status_urls(prompt: &str) -> Vec<String> {
    let mut urls = detected_urls(prompt);
    if urls.is_empty() {
        urls.push("https://example.com".into());
    }
    urls
}

fn detected_urls(prompt: &str) -> Vec<String> {
    let mut urls = prompt
        .split_whitespace()
        .filter_map(normalize_url_token)
        .collect::<Vec<_>>();
    urls.sort();
    urls.dedup();
    urls
}

fn normalize_url_token(token: &str) -> Option<String> {
    let token = token.trim_matches(|character: char| {
        matches!(
            character,
            ',' | ';' | ':' | '!' | '?' | ')' | '(' | '[' | ']' | '{' | '}' | '"' | '\''
        )
    });
    if token.is_empty() || token.starts_with("$steps.") {
        return None;
    }
    if token.starts_with("http://") || token.starts_with("https://") {
        return Some(token.to_string());
    }
    if token.starts_with("www.") {
        return Some(format!("https://{token}"));
    }
    let host = token.split('/').next().unwrap_or(token);
    if contains_domain_like_token(host) {
        return Some(format!("https://{token}"));
    }
    None
}

fn slugify_prompt(prompt: &str) -> String {
    let mut slug = String::new();
    let mut previous_was_separator = false;

    for character in prompt.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            previous_was_separator = false;
        } else if !previous_was_separator && !slug.is_empty() {
            slug.push('-');
            previous_was_separator = true;
        }
    }

    while slug.ends_with('-') {
        slug.pop();
    }

    if slug.is_empty() {
        "task".into()
    } else {
        slug
    }
}

fn stable_prompt_hash(prompt: &str) -> String {
    let hash = prompt
        .as_bytes()
        .iter()
        .fold(0x811c_9dc5_u32, |hash, byte| {
            hash.wrapping_mul(0x0100_0193) ^ u32::from(*byte)
        });
    format!("{hash:08x}")
}

fn readable_title_from_prompt(prompt: &str) -> String {
    let collapsed = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = collapsed.chars();
    let Some(first) = characters.next() else {
        return "Agent Task".into();
    };

    first.to_uppercase().chain(characters).collect()
}

fn draft_summary(definition: &RavenWorkflow) -> String {
    if definition
        .steps
        .first()
        .is_some_and(|step| step.kind == WorkflowStepKind::AgentTask)
    {
        return format!(
            "{} asks the selected AI agent to complete the objective and saves the returned artifact locally.",
            definition.name
        );
    }

    format!(
        "{} collects context, generates a Markdown artifact, and writes JSON metadata locally.",
        definition.name
    )
}

pub fn validate_workflow(workflow: &RavenWorkflow) -> Result<(), WorkflowError> {
    let plugins = plugins::discover_plugins();
    validate_workflow_with_plugins(workflow, &plugins)
}

pub fn validate_workflow_with_plugins(
    workflow: &RavenWorkflow,
    plugins: &[PluginManifest],
) -> Result<(), WorkflowError> {
    let registry = crate::capability_registry::builtin_registry_snapshot();
    validate_workflow_with_registry(workflow, &registry, plugins)
}

pub fn validate_workflow_with_registry(
    workflow: &RavenWorkflow,
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
    plugins: &[PluginManifest],
) -> Result<(), WorkflowError> {
    let mut errors = Vec::new();
    let registry_capabilities = registry
        .capabilities
        .iter()
        .map(|capability| (capability.id.as_str(), capability))
        .collect::<HashMap<_, _>>();
    let step_ids: HashSet<&str> = workflow.steps.iter().map(|step| step.id.as_str()).collect();

    if workflow.schema_version != "0.1.0" {
        errors.push("Workflow schema version must be 0.1.0.".to_string());
    }
    if !allowed_llm_profiles().contains(workflow.defaults.llm_profile_ref.as_str()) {
        errors.push(format!(
            "Workflow defaults reference missing LLM profile {}.",
            workflow.defaults.llm_profile_ref
        ));
    }
    if !is_allowed_destination_ref(&workflow.defaults.destination_ref) {
        errors.push(format!(
            "Workflow defaults reference unavailable destination {}.",
            workflow.defaults.destination_ref
        ));
    }
    if step_ids.len() != workflow.steps.len() {
        errors.push("Workflow contains duplicate step ids.".to_string());
    }

    for step in &workflow.steps {
        match step.kind {
            WorkflowStepKind::ProviderAction => {
                let capability_id = provider_capability_id(step);
                if let Some(capability) = registry_capabilities.get(capability_id.as_str()) {
                    validate_registry_provider_action(workflow, step, capability, &mut errors);
                } else if let Some(capability) = capability_for(&step.provider, &step.action) {
                    validate_static_provider_action(workflow, step, &capability, &mut errors);
                } else if is_legacy_provider_action(step) {
                    validate_legacy_provider_action(step, &mut errors);
                } else {
                    let registry_provider_exists = registry
                        .capabilities
                        .iter()
                        .any(|capability| capability.provider == step.provider)
                        || static_provider_exists(step.provider.as_str())
                        || is_legacy_provider(step.provider.as_str());
                    validate_plugin_provider_action(
                        step,
                        plugins,
                        registry_provider_exists,
                        &mut errors,
                    );
                }
            }
            WorkflowStepKind::AgentTask => validate_agent_task_step(workflow, step, &mut errors),
        }

        for dependency in &step.depends_on {
            if !step_ids.contains(dependency.as_str()) {
                errors.push(format!(
                    "Step {} depends on missing step {}.",
                    step.id, dependency
                ));
            }
        }

        for permission in &step.permissions {
            if !workflow.permissions.contains(permission) {
                errors.push(format!(
                    "Step {} requires undeclared permission {}.",
                    step.id, permission
                ));
            }
        }

        if let Some(profile) = &step.llm_profile_ref {
            if !allowed_llm_profiles().contains(profile.as_str()) {
                errors.push(format!(
                    "Step {} references missing LLM profile {}.",
                    step.id, profile
                ));
            }
        }

        if let Some(destination) = &step.destination_ref {
            if !is_allowed_destination_ref(destination) {
                errors.push(format!(
                    "Step {} references unavailable destination {}.",
                    step.id, destination
                ));
            }
        }

        if step.inline_code.is_some() {
            errors.push(format!("Step {} contains inline arbitrary code.", step.id));
        }

        if contains_invalid_expression(&step.inputs) {
            errors.push(format!(
                "Step {} contains an expression outside the whitelist.",
                step.id
            ));
        }
    }

    validate_agent_runtime_shape(workflow, &registry_capabilities, &mut errors);
    validate_plugin_runtime_shape(workflow, plugins, &registry_capabilities, &mut errors);
    validate_deterministic_provider_runtime_shape(workflow, &registry_capabilities, &mut errors);

    if has_cycle(&workflow.steps) {
        errors.push("Workflow graph contains a cycle.".to_string());
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(WorkflowError::Validation(errors.join(" ")))
    }
}

fn validate_registry_provider_action(
    workflow: &RavenWorkflow,
    step: &WorkflowStepDefinition,
    capability: &CapabilityDescriptor,
    errors: &mut Vec<String>,
) {
    if !is_valid_registry_provider_action(step, capability) {
        errors.push(format!(
            "Step {} references unsupported action {}.{}.",
            step.id, step.provider, step.action
        ));
        return;
    }

    for permission in &capability.permissions {
        if !step.permissions.contains(permission) {
            errors.push(format!(
                "Step {} must declare capability permission {} required by {}.{}.",
                step.id, permission, step.provider, step.action
            ));
        }
        if !workflow.permissions.contains(permission) {
            errors.push(format!(
                "Workflow must declare capability permission {} required by step {}.",
                permission, step.id
            ));
        }
    }

    if capability.provider == "http_probe" && capability.action == "check_urls" {
        validate_http_probe_inputs(step, errors);
    }
    validate_deterministic_provider_inputs(step, errors);
}

fn is_valid_registry_provider_action(
    step: &WorkflowStepDefinition,
    capability: &CapabilityDescriptor,
) -> bool {
    capability.status == CapabilityAvailability::Available
        && capability.provider == step.provider
        && capability.action == step.action
        && capability.provider != "agent"
        && capability.provider != "agent_tool"
}

fn validate_static_provider_action(
    workflow: &RavenWorkflow,
    step: &WorkflowStepDefinition,
    capability: &Capability,
    errors: &mut Vec<String>,
) {
    for permission in &capability.permissions {
        if !step.permissions.contains(permission) {
            errors.push(format!(
                "Step {} must declare capability permission {} required by {}.{}.",
                step.id, permission, step.provider, step.action
            ));
        }
        if !workflow.permissions.contains(permission) {
            errors.push(format!(
                "Workflow must declare capability permission {} required by step {}.",
                permission, step.id
            ));
        }
    }

    if capability.provider == "http_probe" && capability.action == "check_urls" {
        validate_http_probe_inputs(step, errors);
    }
    validate_deterministic_provider_inputs(step, errors);
}

fn static_provider_exists(provider: &str) -> bool {
    crate::capabilities::capability_catalog()
        .into_iter()
        .any(|capability| {
            capability.provider == provider
                && capability.provider != "agent"
                && capability.provider != "agent_tool"
        })
}

fn is_legacy_provider(provider: &str) -> bool {
    provider == "openai"
}

fn is_legacy_provider_action(step: &WorkflowStepDefinition) -> bool {
    step.provider == "openai"
        && matches!(
            step.action.as_str(),
            "chat_stream" | "generate_artifact" | "structured_output"
        )
}

fn validate_legacy_provider_action(step: &WorkflowStepDefinition, errors: &mut Vec<String>) {
    if is_legacy_provider(step.provider.as_str()) && !is_legacy_provider_action(step) {
        errors.push(format!(
            "Step {} references unsupported action {}.{}.",
            step.id, step.provider, step.action
        ));
    }
}

fn validate_deterministic_provider_inputs(step: &WorkflowStepDefinition, errors: &mut Vec<String>) {
    match (step.provider.as_str(), step.action.as_str()) {
        ("web", "fetch_page") => require_non_empty_string(step, "url", errors),
        ("web", "extract_article") | ("web", "extract_metadata") => {
            if !has_non_empty_string(step, "body_text")
                && !has_non_empty_string(step, "html")
                && !has_non_empty_string(step, "url")
            {
                errors.push(format!(
                    "Step {} {}.{} inputs must include body_text, html, or url.",
                    step.id, step.provider, step.action
                ));
            }
        }
        ("seo", "fetch_robots_txt") => {
            if !has_non_empty_string(step, "site_url")
                && !has_non_empty_string(step, "base_url")
                && !has_non_empty_string(step, "url")
            {
                errors.push(format!(
                    "Step {} seo.fetch_robots_txt inputs must include site_url, base_url, or url.",
                    step.id
                ));
            }
        }
        ("seo", "parse_robots_txt") | ("seo", "parse_sitemap") => {
            require_string(step, "body_text", errors);
        }
        ("seo", "fetch_sitemap") => {
            if !has_non_empty_string(step, "sitemap_url")
                && !has_non_empty_string(step, "site_url")
                && !has_non_empty_string(step, "url")
            {
                errors.push(format!(
                    "Step {} seo.fetch_sitemap inputs must include sitemap_url, site_url, or url.",
                    step.id
                ));
            }
        }
        ("seo", "audit_indexability") => {
            if !has_non_empty_string(step, "url")
                && !has_non_empty_string(step, "html")
                && !has_non_empty_string(step, "body_text")
            {
                errors.push(format!(
                    "Step {} seo.audit_indexability inputs must include url, html, or body_text.",
                    step.id
                ));
            }
        }
        ("seo", "audit_metadata")
        | ("seo", "extract_structured_data")
        | ("seo", "audit_links")
        | ("seo", "audit_canonical_hreflang") => {
            if !has_non_empty_string(step, "body_text")
                && !has_non_empty_string(step, "html")
                && !has_non_empty_string(step, "url")
            {
                errors.push(format!(
                    "Step {} {}.{} inputs must include body_text, html, or url.",
                    step.id, step.provider, step.action
                ));
            }
        }
        ("seo", "validate_json_ld") => {
            if !step.inputs.get("json_ld").is_some()
                && !step.inputs.get("structured_data").is_some()
            {
                errors.push(format!(
                    "Step {} seo.validate_json_ld inputs must include json_ld or structured_data.",
                    step.id
                ));
            }
        }
        ("content", "map_search_intent") | ("content", "generate_brief") => {
            require_non_empty_string(step, "topic", errors);
        }
        ("content", "score_quality") => {
            require_string(step, "content", errors);
        }
        ("rss", "fetch_feed") => {
            if !has_non_empty_string(step, "url") && !has_non_empty_string(step, "body_text") {
                errors.push(format!(
                    "Step {} rss.fetch_feed inputs must include url or body_text.",
                    step.id
                ));
            }
        }
        ("news", "search") => require_non_empty_string(step, "query", errors),
        ("data", "parse_csv") => require_string(step, "content", errors),
        ("data", "transform_json") => {
            if !step.inputs.get("data").is_some() {
                errors.push(format!(
                    "Step {} data.transform_json inputs must include data.",
                    step.id
                ));
            }
        }
        ("scheduler", "preview_next_runs") => {
            require_non_empty_string(step, "cadence", errors);
            if step
                .inputs
                .get("cadence")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|cadence| cadence != "manual")
            {
                require_non_empty_string(step, "local_time", errors);
            }
        }
        ("notification", "local") => {
            require_string(step, "title", errors);
            require_string(step, "body", errors);
        }
        ("open_meteo", "current_weather")
        | ("weather", "forecast_24h")
        | ("weather", "hourly_forecast")
        | ("weather", "alerts") => {
            let latitude = step.inputs.get("latitude");
            let longitude = step.inputs.get("longitude");
            if latitude.is_some() != longitude.is_some() {
                errors.push(format!(
                    "Step {} {}.{} inputs.latitude and inputs.longitude must be provided together.",
                    step.id, step.provider, step.action
                ));
            }
        }
        _ => {}
    }
}

fn require_string(step: &WorkflowStepDefinition, key: &str, errors: &mut Vec<String>) {
    if !step
        .inputs
        .get(key)
        .is_some_and(serde_json::Value::is_string)
    {
        errors.push(format!(
            "Step {} {}.{} inputs.{} must be a string.",
            step.id, step.provider, step.action, key
        ));
    }
}

fn require_non_empty_string(step: &WorkflowStepDefinition, key: &str, errors: &mut Vec<String>) {
    if !has_non_empty_string(step, key) {
        errors.push(format!(
            "Step {} {}.{} inputs.{} must be a non-empty string.",
            step.id, step.provider, step.action, key
        ));
    }
}

fn has_non_empty_string(step: &WorkflowStepDefinition, key: &str) -> bool {
    step.inputs
        .get(key)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn validate_http_probe_inputs(step: &WorkflowStepDefinition, errors: &mut Vec<String>) {
    let Some(urls) = step.inputs.get("urls") else {
        errors.push(format!(
            "Step {} http_probe.check_urls inputs.urls must be a non-empty array of strings.",
            step.id
        ));
        return;
    };
    let Some(urls) = urls.as_array() else {
        errors.push(format!(
            "Step {} http_probe.check_urls inputs.urls must be a non-empty array of strings.",
            step.id
        ));
        return;
    };
    if urls.is_empty() {
        errors.push(format!(
            "Step {} http_probe.check_urls inputs.urls must be a non-empty array of strings.",
            step.id
        ));
        return;
    }
    for (index, url) in urls.iter().enumerate() {
        if !url.as_str().is_some_and(|value| !value.trim().is_empty()) {
            errors.push(format!(
                "Step {} http_probe.check_urls inputs.urls[{}] must be a non-empty string.",
                step.id, index
            ));
        }
    }

    let Some(accepted_status_codes) = step.inputs.get("accepted_status_codes") else {
        return;
    };
    let Some(accepted_status_codes) = accepted_status_codes.as_array() else {
        errors.push(format!(
            "Step {} http_probe.check_urls inputs.accepted_status_codes must be an array of HTTP status codes.",
            step.id
        ));
        return;
    };
    for (index, status_code) in accepted_status_codes.iter().enumerate() {
        let Some(status_code) = status_code.as_u64() else {
            errors.push(format!(
                "Step {} http_probe.check_urls inputs.accepted_status_codes[{}] must be an integer HTTP status code.",
                step.id, index
            ));
            continue;
        };
        if !(100..=599).contains(&status_code) {
            errors.push(format!(
                "Step {} http_probe.check_urls inputs.accepted_status_codes[{}] must be an HTTP status code from 100 through 599.",
                step.id, index
            ));
        }
    }
}

fn validate_plugin_provider_action(
    step: &WorkflowStepDefinition,
    plugins: &[PluginManifest],
    registry_provider_exists: bool,
    errors: &mut Vec<String>,
) {
    let provider_exists = registry_provider_exists
        || plugins.iter().any(|plugin| {
            plugin
                .steps
                .iter()
                .any(|candidate| candidate.provider == step.provider)
        });
    let Some(capability) = plugins::plugin_step(plugins, &step.provider, &step.action) else {
        if provider_exists {
            errors.push(format!(
                "Step {} references unsupported action {}.{}.",
                step.id, step.provider, step.action
            ));
        } else {
            errors.push(format!(
                "Step {} references unavailable provider {}.",
                step.id, step.provider
            ));
        }
        return;
    };

    for permission in &capability.permissions {
        if !step.permissions.contains(permission) {
            errors.push(format!(
                "Step {} must declare plugin permission {} required by {}.{}.",
                step.id, permission, step.provider, step.action
            ));
        }
    }
    for permission in &step.permissions {
        if !capability.permissions.contains(permission) {
            errors.push(format!(
                "Step {} declares permission {} not allowed by plugin capability {}.{}.",
                step.id, permission, step.provider, step.action
            ));
        }
    }
    validate_plugin_step_inputs(step, &capability.input_schema, errors);
}

fn validate_plugin_step_inputs(
    step: &WorkflowStepDefinition,
    input_schema: &serde_json::Value,
    errors: &mut Vec<String>,
) {
    if input_schema.is_null() {
        return;
    }
    if input_schema
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value == "object")
        && !step.inputs.is_object()
    {
        errors.push(format!(
            "Step {} plugin inputs must be a JSON object.",
            step.id
        ));
    }
    if let Some(required) = input_schema
        .get("required")
        .and_then(serde_json::Value::as_array)
    {
        for key in required.iter().filter_map(serde_json::Value::as_str) {
            if !step.inputs.get(key).is_some() {
                errors.push(format!(
                    "Step {} plugin inputs must include required field {}.",
                    step.id, key
                ));
            }
        }
    }
}

fn is_allowed_destination_ref(destination: &str) -> bool {
    matches!(
        destination,
        "local-app" | "local_app" | "markdown_folder" | "obsidian_vault"
    )
}

fn allowed_llm_profiles() -> HashSet<&'static str> {
    HashSet::from([
        "default-openai",
        "codex-oauth-local",
        "claude-code-oauth-local",
        "openai-api-key",
        "anthropic-api-key",
        "ollama-local",
    ])
}

fn allowed_agent_task_llm_profiles() -> HashSet<&'static str> {
    HashSet::from([
        "codex-oauth-local",
        "claude-code-oauth-local",
        "openai-api-key",
        "anthropic-api-key",
        "ollama-local",
    ])
}

fn validate_agent_task_step(
    workflow: &RavenWorkflow,
    step: &WorkflowStepDefinition,
    errors: &mut Vec<String>,
) {
    if step.provider != "agent" || step.action != "run_task" {
        errors.push(format!(
            "Step {} agent_task must use provider agent and action run_task.",
            step.id
        ));
    }

    if !step
        .permissions
        .iter()
        .any(|permission| permission == "llm:generate")
    {
        errors.push(format!(
            "Step {} agent_task must include llm:generate in step permissions.",
            step.id
        ));
    }

    let profile = step
        .llm_profile_ref
        .as_deref()
        .unwrap_or(&workflow.defaults.llm_profile_ref);
    if !allowed_agent_task_llm_profiles().contains(profile) {
        errors.push(format!(
            "Step {} agent_task references unsupported LLM profile {}.",
            step.id, profile
        ));
    }

    let objective = step
        .inputs
        .get("objective")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if objective.trim().is_empty() {
        errors.push(format!(
            "Step {} agent_task must include non-empty inputs.objective.",
            step.id
        ));
    }

    let mut allowed_agent_permissions = HashSet::from(["llm:generate".to_string()]);
    let Some(allowed_tools) = step.inputs.get("allowed_tools") else {
        validate_agent_task_permission_boundary(step, &allowed_agent_permissions, errors);
        return;
    };
    let Some(tools) = allowed_tools.as_array() else {
        errors.push(format!(
            "Step {} inputs.allowed_tools must be an array when present.",
            step.id
        ));
        validate_agent_task_permission_boundary(step, &allowed_agent_permissions, errors);
        return;
    };

    for (index, tool_value) in tools.iter().enumerate() {
        let Some(tool) = tool_value.as_str() else {
            errors.push(format!(
                "Step {} allowed_tools[{}] must be a string.",
                step.id, index
            ));
            continue;
        };
        let Some(required_permission) = permission_for_agent_tool(tool) else {
            errors.push(format!("Step {} allows unknown tool {}.", step.id, tool));
            continue;
        };
        allowed_agent_permissions.insert(required_permission.to_string());
        if !workflow
            .permissions
            .iter()
            .any(|permission| permission == required_permission)
        {
            errors.push(format!(
                "Step {} allows tool {} but workflow does not declare {}.",
                step.id, tool, required_permission
            ));
        }
        if !step
            .permissions
            .iter()
            .any(|permission| permission == required_permission)
        {
            errors.push(format!(
                "Step {} allows tool {} but step does not declare {}.",
                step.id, tool, required_permission
            ));
        }
    }
    if objective_looks_like_url_check(objective) && tools_include_web_or_http(tools) {
        errors.push(format!(
            "Step {} objective is a URL or website reachability check. Use deterministic provider http_probe.check_urls.",
            step.id
        ));
    }
    validate_agent_task_permission_boundary(step, &allowed_agent_permissions, errors);
}

fn objective_looks_like_url_check(objective: &str) -> bool {
    let normalized = objective.to_lowercase();
    if is_embedded_data_only_prompt(&normalized) {
        return false;
    }
    if looks_like_web_content_extraction_request(&normalized) {
        return false;
    }
    let words = normalized
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<HashSet<_>>();
    let mentions_url_target = normalized.contains("http://")
        || normalized.contains("https://")
        || normalized.contains("www.")
        || words.contains("url")
        || words.contains("urls")
        || words.contains("website")
        || words.contains("websites")
        || words.contains("site")
        || words.contains("sites")
        || contains_domain_like_token(&normalized);
    let mentions_reachability = words.contains("uptime")
        || words.contains("reachable")
        || words.contains("reachability")
        || words.contains("available")
        || words.contains("availability")
        || words.contains("unavailable")
        || words.contains("down")
        || looks_like_up_status_question(&normalized, &words)
        || words.contains("responding")
        || words.contains("response")
        || words.contains("status")
        || words.contains("health")
        || words.contains("healthy")
        || words.contains("alive")
        || words.contains("online")
        || words.contains("offline")
        || words.contains("probe")
        || words.contains("monitor");

    mentions_url_target && mentions_reachability
}

fn looks_like_web_content_extraction_request(normalized: &str) -> bool {
    let intent = normalized_prompt_without_urls(normalized);
    contains_any(
        &intent,
        &[
            "extract",
            "metadata",
            "title metadata",
            "page title",
            "title of",
            "meta description",
            "description metadata",
            "page description",
            "article",
            "read the page",
            "fetch the page",
            "content brief",
            "generate_brief",
        ],
    )
}

fn normalized_prompt_without_urls(prompt: &str) -> String {
    prompt
        .split_whitespace()
        .filter(|token| normalize_url_token(token).is_none())
        .collect::<Vec<_>>()
        .join(" ")
}

fn looks_like_up_status_question(normalized: &str, words: &HashSet<&str>) -> bool {
    words.contains("up")
        && (words.contains("is")
            || words.contains("are")
            || normalized.contains("site up")
            || normalized.contains("sites up")
            || normalized.contains("website up")
            || normalized.contains("websites up")
            || normalized.contains("site-up")
            || normalized.contains("sites-up")
            || normalized.contains("website-up")
            || normalized.contains("websites-up"))
}

fn contains_domain_like_token(text: &str) -> bool {
    text.split_whitespace().any(|token| {
        let token = token.trim_matches(|character: char| {
            matches!(
                character,
                ',' | ';' | ':' | '!' | '?' | ')' | '(' | '[' | ']' | '{' | '}' | '"' | '\''
            )
        });
        if token.starts_with("$steps.") || token.starts_with('.') || token.ends_with('.') {
            return false;
        }
        let labels = token.split('.').collect::<Vec<_>>();
        if labels.len() < 2 {
            return false;
        }
        let Some(tld) = labels.last() else {
            return false;
        };
        tld.len() >= 2
            && tld.chars().all(|character| character.is_ascii_alphabetic())
            && labels.iter().all(|label| {
                !label.is_empty()
                    && label
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
                    && !label.starts_with('-')
                    && !label.ends_with('-')
            })
    })
}

fn tools_include_web_or_http(tools: &[serde_json::Value]) -> bool {
    tools
        .iter()
        .filter_map(serde_json::Value::as_str)
        .any(|tool| {
            let normalized = tool.to_lowercase();
            normalized == "web" || normalized == "http"
        })
}

fn validate_agent_task_permission_boundary(
    step: &WorkflowStepDefinition,
    allowed_agent_permissions: &HashSet<String>,
    errors: &mut Vec<String>,
) {
    for permission in &step.permissions {
        if !allowed_agent_permissions.contains(permission) {
            errors.push(format!(
                "Step {} declares permission {} not granted by agent allowed_tools.",
                step.id, permission
            ));
        }
    }
}

fn validate_agent_runtime_shape(
    workflow: &RavenWorkflow,
    registry: &HashMap<&str, &CapabilityDescriptor>,
    errors: &mut Vec<String>,
) {
    let agent_steps = workflow
        .steps
        .iter()
        .filter(|step| step.kind == WorkflowStepKind::AgentTask)
        .collect::<Vec<_>>();
    if agent_steps.is_empty() {
        return;
    }
    let Some(agent_step) = agent_steps.first() else {
        return;
    };

    let sinks = workflow
        .steps
        .iter()
        .filter(|step| {
            step.kind == WorkflowStepKind::ProviderAction
                && step.provider == "local_app"
                && step.action == "write_artifact"
        })
        .collect::<Vec<_>>();

    let agent_index = workflow
        .steps
        .iter()
        .position(|step| step.id == agent_step.id)
        .unwrap_or(usize::MAX);
    let deterministic_provider_steps = workflow
        .steps
        .iter()
        .enumerate()
        .filter(|(_, step)| {
            step.kind == WorkflowStepKind::ProviderAction
                && !(step.provider == "local_app" && step.action == "write_artifact")
                && is_supported_agent_pre_step(step, registry)
        })
        .collect::<Vec<_>>();
    let deterministic_provider_count = deterministic_provider_steps.len();
    let has_mixed_deterministic_shape = deterministic_provider_count > 0
        && agent_steps.len() == 1
        && sinks.len() <= 1
        && workflow.steps.len() == deterministic_provider_count + 1 + sinks.len()
        && deterministic_provider_steps
            .iter()
            .all(|(index, _)| *index < agent_index)
        && sinks.iter().all(|sink| {
            workflow
                .steps
                .iter()
                .position(|step| step.id == sink.id)
                .is_some_and(|index| index > agent_index)
        });

    if !has_mixed_deterministic_shape
        && (agent_steps.len() != 1 || workflow.steps.len() != 1 + sinks.len() || sinks.len() > 1)
    {
        errors.push(
            "Agent runtime supports exactly one agent_task step plus optional local_app.write_artifact sink."
            .to_string(),
        );
    }

    if has_mixed_deterministic_shape {
        validate_mixed_deterministic_agent_wiring(
            workflow,
            agent_step,
            &deterministic_provider_steps,
            errors,
        );
    }

    if let Some(sink) = sinks.first() {
        if sink.depends_on != vec![agent_step.id.clone()] {
            errors.push(format!(
                "Agent runtime sink {} must depend only on {}.",
                sink.id, agent_step.id
            ));
        }
        let expected_artifact = format!("$steps.{}.artifact", agent_step.id);
        if sink
            .inputs
            .get("artifact")
            .and_then(serde_json::Value::as_str)
            != Some(expected_artifact.as_str())
        {
            errors.push(format!(
                "Agent runtime sink {} inputs.artifact must reference {}.",
                sink.id, expected_artifact
            ));
        }
    }
}

fn is_supported_agent_pre_step(
    step: &WorkflowStepDefinition,
    registry: &HashMap<&str, &CapabilityDescriptor>,
) -> bool {
    registry
        .get(provider_capability_id(step).as_str())
        .map(|capability| {
            is_valid_registry_provider_action(step, capability) && capability.deterministic
        })
        .unwrap_or_else(|| {
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
        })
}

fn validate_mixed_deterministic_agent_wiring(
    workflow: &RavenWorkflow,
    agent_step: &WorkflowStepDefinition,
    deterministic_provider_steps: &[(usize, &WorkflowStepDefinition)],
    errors: &mut Vec<String>,
) {
    let step_indices = workflow
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| (step.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let deterministic_step_ids = deterministic_provider_steps
        .iter()
        .map(|(_, step)| step.id.as_str())
        .collect::<HashSet<_>>();

    for (step_index, step) in deterministic_provider_steps {
        for dependency in &step.depends_on {
            let Some(dependency_index) = step_indices.get(dependency.as_str()) else {
                continue;
            };
            if *dependency_index >= *step_index
                || !deterministic_step_ids.contains(dependency.as_str())
            {
                errors.push(format!(
                    "Agent runtime deterministic step {} may depend only on earlier deterministic steps.",
                    step.id
                ));
                break;
            }
        }
    }

    for (_, step) in deterministic_provider_steps {
        if !agent_step
            .depends_on
            .iter()
            .any(|dependency| dependency == &step.id)
        {
            errors.push(format!(
                "Agent runtime step {} must depend on {}.",
                agent_step.id, step.id
            ));
        }
    }

    for dependency in &agent_step.depends_on {
        if !deterministic_step_ids.contains(dependency.as_str()) {
            errors.push(format!(
                "Agent runtime step {} may depend only on deterministic provider pre-steps.",
                agent_step.id
            ));
            break;
        }
    }
}

fn validate_deterministic_provider_runtime_shape(
    workflow: &RavenWorkflow,
    registry: &HashMap<&str, &CapabilityDescriptor>,
    errors: &mut Vec<String>,
) {
    if workflow
        .steps
        .iter()
        .any(|step| step.kind == WorkflowStepKind::AgentTask || is_legacy_provider_action(step))
    {
        return;
    }

    let deterministic_steps = workflow
        .steps
        .iter()
        .enumerate()
        .filter(|(_, step)| {
            step.kind == WorkflowStepKind::ProviderAction
                && !(step.provider == "local_app" && step.action == "write_artifact")
                && is_supported_agent_pre_step(step, registry)
        })
        .collect::<Vec<_>>();
    if deterministic_steps.is_empty() {
        return;
    }

    let sinks = workflow
        .steps
        .iter()
        .filter(|step| {
            step.kind == WorkflowStepKind::ProviderAction
                && step.provider == "local_app"
                && step.action == "write_artifact"
        })
        .collect::<Vec<_>>();
    if workflow.steps.len() != deterministic_steps.len() + sinks.len() || sinks.len() > 1 {
        errors.push(
            "Deterministic provider runtime supports deterministic provider steps plus optional local_app.write_artifact sink."
                .to_string(),
        );
        return;
    }

    let step_indices = workflow
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| (step.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let deterministic_step_ids = deterministic_steps
        .iter()
        .map(|(_, step)| step.id.as_str())
        .collect::<HashSet<_>>();

    for (step_index, step) in deterministic_steps {
        for dependency in &step.depends_on {
            let Some(dependency_index) = step_indices.get(dependency.as_str()) else {
                continue;
            };
            if *dependency_index >= step_index
                || !deterministic_step_ids.contains(dependency.as_str())
            {
                errors.push(format!(
                    "Deterministic provider step {} may depend only on earlier deterministic provider steps.",
                    step.id
                ));
                break;
            }
        }
    }

    if let Some(sink) = sinks.first() {
        for dependency in &sink.depends_on {
            let Some(dependency_index) = step_indices.get(dependency.as_str()) else {
                continue;
            };
            let Some(sink_index) = step_indices.get(sink.id.as_str()) else {
                continue;
            };
            if *dependency_index >= *sink_index
                || !deterministic_step_ids.contains(dependency.as_str())
            {
                errors.push(format!(
                    "Deterministic provider sink {} may depend only on earlier deterministic provider steps.",
                    sink.id
                ));
                break;
            }
        }

        let artifact_step_ref = sink
            .inputs
            .get("artifact")
            .and_then(serde_json::Value::as_str)
            .and_then(step_id_from_step_expression);
        if let Some(artifact_step_ref) = artifact_step_ref {
            if !sink
                .depends_on
                .iter()
                .any(|dependency| dependency == artifact_step_ref)
            {
                errors.push(format!(
                    "Deterministic provider sink {} inputs.artifact must reference one of its dependencies.",
                    sink.id
                ));
            }
        } else {
            errors.push(format!(
                "Deterministic provider sink {} inputs.artifact must reference a deterministic provider step output.",
                sink.id
            ));
        }
    }
}

fn step_id_from_step_expression(expression: &str) -> Option<&str> {
    let remainder = expression.strip_prefix("$steps.")?;
    remainder.split('.').next()
}

fn provider_capability_id(step: &WorkflowStepDefinition) -> String {
    format!("{}.{}", step.provider, step.action)
}

fn validate_plugin_runtime_shape(
    workflow: &RavenWorkflow,
    plugins: &[PluginManifest],
    registry: &HashMap<&str, &CapabilityDescriptor>,
    errors: &mut Vec<String>,
) {
    let plugin_steps = workflow
        .steps
        .iter()
        .filter(|step| {
            plugins::plugin_for_step(plugins, &step.provider, &step.action).is_some()
                && !registry
                    .get(provider_capability_id(step).as_str())
                    .is_some_and(|capability| is_valid_registry_provider_action(step, capability))
        })
        .collect::<Vec<_>>();
    if plugin_steps.is_empty() {
        return;
    }
    if plugin_steps.len() != 1 {
        errors.push(
            "Plugin runtime supports exactly one plugin-backed provider action step.".to_string(),
        );
        return;
    }
    let plugin_step = plugin_steps[0];
    let sinks = workflow
        .steps
        .iter()
        .filter(|step| {
            step.kind == WorkflowStepKind::ProviderAction
                && step.provider == "local_app"
                && step.action == "write_artifact"
        })
        .collect::<Vec<_>>();

    if workflow.steps.len() != 1 + sinks.len() || sinks.len() > 1 {
        errors.push(
            "Plugin runtime supports one plugin step plus optional local_app.write_artifact sink."
                .to_string(),
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
            errors.push(format!(
                "Plugin runtime sink {} must depend on {} and reference {}.",
                sink.id, plugin_step.id, expected_artifact
            ));
        }
    }
}

fn permission_for_agent_tool(tool: &str) -> Option<&'static str> {
    match tool {
        "web" | "http" => Some("network:read"),
        "local_git" => Some("git:read"),
        "github" => Some("github:read"),
        "nestweaver" => Some("nestweaver:read"),
        "document_import" => Some("document:read"),
        "ai_chat_import" => Some("chat:read"),
        _ => None,
    }
}

fn contains_invalid_expression(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(text) => {
            text.contains("{{")
                || (text.starts_with('$')
                    && !(text.starts_with("$steps.") && text.matches('.').count() >= 2))
        }
        serde_json::Value::Array(items) => items.iter().any(contains_invalid_expression),
        serde_json::Value::Object(map) => map.values().any(contains_invalid_expression),
        _ => false,
    }
}

fn has_cycle(steps: &[WorkflowStepDefinition]) -> bool {
    let graph: HashMap<&str, Vec<&str>> = steps
        .iter()
        .map(|step| {
            (
                step.id.as_str(),
                step.depends_on
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();

    fn visit<'a>(
        id: &'a str,
        graph: &HashMap<&'a str, Vec<&'a str>>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> bool {
        if visiting.contains(id) {
            return true;
        }
        if visited.contains(id) {
            return false;
        }
        visiting.insert(id);
        for dependency in graph.get(id).into_iter().flatten() {
            if graph.contains_key(dependency) && visit(dependency, graph, visiting, visited) {
                return true;
            }
        }
        visiting.remove(id);
        visited.insert(id);
        false
    }

    steps
        .iter()
        .any(|step| visit(&step.id, &graph, &mut visiting, &mut visited))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::capability_for;

    #[test]
    fn validates_first_party_templates() {
        validate_workflow(&daily_work_journal()).unwrap();
        validate_workflow(&morning_brief()).unwrap();
        validate_workflow(&current_weather()).unwrap();
        validate_workflow(&deterministic_weather_workflow()).unwrap();
    }

    #[test]
    fn current_weather_seed_is_prompt_native_agent_task() {
        let workflow = current_weather();

        assert_eq!(
            workflow.permissions,
            vec!["llm:generate", "network:read", "artifact:write"]
        );
        assert_eq!(workflow.defaults.llm_profile_ref, "codex-oauth-local");
        assert_eq!(workflow.steps[0].kind, WorkflowStepKind::AgentTask);
        assert_eq!(workflow.steps[0].provider, "agent");
        assert_eq!(workflow.steps[0].action, "run_task");
        assert_eq!(
            workflow.steps[0].inputs["objective"],
            serde_json::json!("What's the weather today in Denver?")
        );
        assert_eq!(
            workflow.steps[0].inputs["allowed_tools"],
            serde_json::json!(["web"])
        );
        assert_eq!(workflow.steps[1].depends_on, vec!["ask-ai"]);
    }

    #[test]
    fn draft_from_open_ended_prompt_creates_agent_task() {
        let prompt = "write a friendly note for a new teammate";
        let draft = draft_from_prompt(prompt).unwrap();

        assert_eq!(
            draft.definition.name,
            "Write a friendly note for a new teammate"
        );
        assert!(draft
            .summary
            .contains("asks the selected AI agent to complete the objective"));
        assert!(!draft.summary.contains("collects context"));
        assert_eq!(draft.definition.steps[0].kind, WorkflowStepKind::AgentTask);
        assert_eq!(draft.definition.steps[0].provider, "agent");
        assert_eq!(draft.definition.steps[0].action, "run_task");
        assert_eq!(
            draft.definition.steps[0].inputs["objective"],
            serde_json::json!(prompt)
        );
    }

    #[test]
    fn draft_approval_mode_uses_latest_explicit_prompt_instruction() {
        let draft = draft_from_prompt(
            "Create a workflow with auto approve but always review before running.",
        )
        .unwrap();

        assert_eq!(draft.approval_mode.as_deref(), Some("always_review"));
    }

    #[test]
    fn prompt_native_agent_workflow_ids_include_hash_suffix_for_slug_collisions() {
        let first = prompt_native_agent_workflow("Hello, world!");
        let second = prompt_native_agent_workflow("Hello world");

        assert_ne!(first.id, second.id);
        assert!(first.id.starts_with("agent-hello-world-"));
        assert!(second.id.starts_with("agent-hello-world-"));
    }

    #[test]
    fn prompt_native_agent_workflow_ids_distinguish_punctuation_heavy_prompts() {
        let first = prompt_native_agent_workflow("!!!");
        let second = prompt_native_agent_workflow("¿¿¿");

        assert_ne!(first.id, second.id);
        assert!(first.id.starts_with("agent-task-"));
        assert!(second.id.starts_with("agent-task-"));
    }

    #[test]
    fn draft_from_explicit_deterministic_weather_creates_provider_action() {
        let draft = draft_from_prompt("open-meteo weather").unwrap();

        assert_eq!(
            draft.definition.steps[0].kind,
            WorkflowStepKind::ProviderAction
        );
        assert_eq!(draft.definition.steps[0].provider, "open_meteo");
        assert_eq!(draft.definition.steps[0].action, "current_weather");
    }

    #[test]
    fn draft_from_open_meteo_weather_matches_canonical_deterministic_route() {
        let prompt = "open-meteo weather";
        let draft = draft_from_prompt(prompt).unwrap();
        let workflow = deterministic_first_workflow_for_prompt(prompt)
            .expect("canonical deterministic route should exist");

        assert_eq!(draft.definition, workflow);
        assert!(draft.planner_rationale.is_none());
    }

    #[test]
    fn draft_from_website_status_prompt_creates_http_probe_workflow() {
        let draft = draft_from_prompt(
            "Create a website-up check workflow for example.com and https://www.rust-lang.org",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_eq!(draft.definition.id, "website-status-check");
        assert_eq!(draft.definition.steps[0].provider, "http_probe");
        assert_eq!(draft.definition.steps[0].action, "check_urls");
        assert_eq!(
            draft.definition.steps[0].inputs["urls"],
            serde_json::json!(["https://example.com", "https://www.rust-lang.org"])
        );
        assert_eq!(draft.definition.steps[1].provider, "agent");
        assert_eq!(
            draft.definition.steps[1].inputs["allowed_tools"],
            serde_json::json!([])
        );
    }

    #[test]
    fn draft_from_article_path_status_prompt_creates_http_probe_workflow() {
        let draft = draft_from_prompt("Is https://example.com/article up?").unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_eq!(draft.definition.id, "website-status-check");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("http_probe", "check_urls"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[("web", "fetch_page"), ("web", "extract_article")],
        );
        assert_eq!(
            draft.definition.steps[0].inputs["urls"],
            serde_json::json!(["https://example.com/article"])
        );
        assert!(draft.planner_rationale.is_none());
    }

    #[test]
    fn draft_from_generic_brief_prompt_uses_weather_and_news_before_agent_summary() {
        let draft = draft_from_prompt(
            "Create a morning brief report that collects the next 24 hour Denver weather forecast and trending news, then summarizes the planning implications.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("weather", "forecast_24h"),
                ("news", "trending"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_explicit_news_search_prompt_uses_news_search() {
        let draft = draft_from_prompt(
            "Create a brief: news search for AI regulation updates, then summarize implications.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("news", "search"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(&draft.definition, &[("news", "trending")]);
        assert_eq!(draft.definition.name, "News Brief");
        assert_planner_rationale_includes(&draft, &["news.search"]);
        let news = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "news" && step.action == "search")
            .expect("news search step should exist");
        assert_eq!(news.inputs["query"], "AI regulation updates");
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_web_article_summary_uses_fetch_and_extract_before_agent_summary() {
        let draft = draft_from_prompt(
            "Create a research summary report for https://example.com/blog/launch that fetches the page, extracts article text and metadata, then writes a concise Markdown summary.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_article"),
                ("web", "extract_metadata"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_content_research_prompt_uses_content_brief_before_agent_writing() {
        let draft = draft_from_prompt(
            "Create a research-backed service page brief and final draft for fractional CTO consulting for B2B SaaS founders.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("content", "map_search_intent"),
                ("content", "generate_brief"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_csv_report_prompt_parses_data_before_agent_summary() {
        let draft = draft_from_prompt(
            "Create a weekly summary report from this CSV, parse the rows deterministically, then summarize anomalies:\nregion,revenue\nwest,42\neast,37",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_csv_weather_news_prompt_keeps_all_deterministic_steps() {
        let draft = draft_from_prompt(
            "Create a deterministic operations brief: parse this CSV, collect the Denver weather forecast and trending news headlines, then summarize all results.\nregion,revenue\nwest,42\neast,37",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("weather", "forecast_24h"),
                ("news", "trending"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_planner_rationale_includes(
            &draft,
            &["data.parse_csv", "weather.forecast_24h", "news.trending"],
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_csv_headlines_column_does_not_collect_news() {
        let draft = draft_from_prompt(
            "Create a CSV report summarizing the headlines column.\nheadlines,count\nLaunch update,3",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(&draft.definition, &[("news", "trending")]);
        assert_planner_rationale_includes(&draft, &["data.parse_csv"]);
        assert_planner_rationale_excludes(&draft, &["news.trending"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn planner_does_not_insert_web_for_local_csv_summary() {
        let draft = draft_from_prompt(
            "Create a local CSV summary, parse this CSV deterministically, then summarize anomalies.\nregion,revenue\nwest,42\neast,37",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_article"),
                ("web", "extract_metadata"),
                ("rss", "fetch_feed"),
                ("news", "trending"),
            ],
        );
        assert_planner_rationale_includes(&draft, &["data.parse_csv"]);
        assert_planner_rationale_excludes(&draft, &["web.fetch_page", "rss.fetch_feed"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn planner_does_not_claim_article_extraction_for_local_csv_article_column() {
        let draft = draft_from_prompt(
            "Create a CSV report: parse this CSV and summarize the article column.\narticle,score\nLaunch plan,42",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_article"),
                ("web", "extract_metadata"),
            ],
        );
        assert_planner_rationale_includes(&draft, &["data.parse_csv"]);
        assert_planner_rationale_excludes(&draft, &["web.extract_article"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_planned_prompt_includes_planner_rationale() {
        let draft = draft_from_prompt(
            "Create a weekly summary report from this CSV, parse the rows deterministically, then summarize anomalies:\nregion,revenue\nwest,42\neast,37",
        )
        .unwrap();

        let rationale = draft
            .planner_rationale
            .expect("planned drafts should include planner rationale");
        assert_eq!(rationale.prompt, draft.prompt);
        assert!(rationale
            .operations
            .iter()
            .any(|operation| serde_json::to_value(operation.kind).ok()
                == Some(serde_json::json!("parse.csv"))));
        assert!(rationale
            .operations
            .iter()
            .any(|operation| operation.step_id.as_deref() == Some("parse-csv")));
    }

    #[test]
    fn draft_from_legacy_template_prompt_omits_planner_rationale() {
        let draft = draft_from_prompt("Create a daily work journal").unwrap();

        assert!(draft.planner_rationale.is_none());
    }

    #[test]
    fn draft_from_legacy_website_status_prompt_omits_planner_rationale() {
        let prompt =
            "Create a website-up check workflow for example.com and https://www.rust-lang.org";
        let draft = draft_from_prompt(prompt).unwrap();

        assert_eq!(draft.definition, website_status_workflow(prompt));
        assert!(draft.planner_rationale.is_none());
    }

    #[test]
    fn draft_from_legacy_seo_audit_prompt_omits_planner_rationale() {
        let draft = draft_from_prompt(
            "Run a deterministic SEO audit for https://example.com with robots, sitemap, metadata, and recommendations.",
        )
        .unwrap();

        assert_eq!(draft.definition.id, "seo-audit");
        assert!(draft.planner_rationale.is_none());
    }

    #[test]
    fn draft_from_legacy_morning_brief_prompt_omits_planner_rationale() {
        let draft = draft_from_prompt("Create a morning brief").unwrap();

        assert_eq!(draft.definition, morning_brief());
        assert!(draft.planner_rationale.is_none());
    }

    #[test]
    fn draft_from_csv_filter_sort_prompt_parses_and_transforms_without_unrelated_sources() {
        let draft = draft_from_prompt(
            "Create a CSV operations report: parse this CSV, filter status=active, sort by revenue, limit 5, then summarize the result.\nname,status,revenue\nAcme,active,42\nBeta,inactive,9",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("data", "transform_json"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_article"),
                ("news", "trending"),
                ("rss", "fetch_feed"),
            ],
        );
        let transform = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "transform_json")
            .unwrap();
        assert_eq!(transform.depends_on, vec!["parse-csv"]);
        assert_eq!(
            transform.inputs["data"],
            serde_json::json!("$steps.parse-csv.rows")
        );
        assert_eq!(
            transform.inputs["filter_equals"]["status"],
            serde_json::json!("active")
        );
        assert_eq!(transform.inputs["sort_by"], serde_json::json!("revenue"));
        assert_eq!(transform.inputs["limit"], serde_json::json!(5));
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_csv_projection_prompt_selects_requested_fields() {
        let draft = draft_from_prompt(
            "Create a CSV summary: parse this CSV, select name,revenue, then summarize the projected rows.\nname,status,revenue\nAcme,active,42\nBeta,inactive,9",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("data", "transform_json"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        let transform = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "transform_json")
            .unwrap();
        assert_eq!(
            transform.inputs["select_fields"],
            serde_json::json!(["name", "revenue"])
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_csv_transform_prompt_preserves_mixed_case_inputs() {
        let draft = draft_from_prompt(
            "Create a CSV summary: parse this CSV, FILTER Status=Active, SELECT Name,Revenue, SORT BY Revenue, then summarize.\nName,Status,Revenue\nAcme,Active,42\nBeta,Inactive,9",
        )
        .unwrap();

        let transform = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "transform_json")
            .unwrap();

        assert_eq!(
            transform.inputs["filter_equals"],
            serde_json::json!({ "Status": "Active" })
        );
        assert_eq!(
            transform.inputs["select_fields"],
            serde_json::json!(["Name", "Revenue"])
        );
        assert_eq!(transform.inputs["sort_by"], serde_json::json!("Revenue"));
    }

    #[test]
    fn draft_from_csv_instruction_with_commas_passes_only_csv_block() {
        let draft = draft_from_prompt(
            "Create a CSV summary: parse this CSV, filter active rows, select name,revenue, then summarize.\nname,status,revenue\nAcme,active,42\nBeta,inactive,9",
        )
        .unwrap();

        let parse_csv = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "parse_csv")
            .expect("parse_csv step should exist");

        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!("name,status,revenue\nAcme,active,42\nBeta,inactive,9")
        );
    }

    #[test]
    fn draft_from_csv_where_prompt_sets_transform_filter_equals() {
        let draft = draft_from_prompt(
            "Create a CSV operations report: parse this CSV, where status=active, then summarize the result.\nname,status,revenue\nAcme,active,42\nBeta,inactive,9",
        )
        .unwrap();

        let transform = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "transform_json")
            .unwrap();

        assert_eq!(
            transform.inputs["filter_equals"],
            serde_json::json!({ "status": "active" })
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_content_brief_url_prompt_uses_generate_brief_before_agent_writing() {
        let draft = draft_from_prompt(
            "Create a content brief for https://example.com using content.generate_brief, then draft final copy.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("content", "map_search_intent"),
                ("content", "generate_brief"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        let brief = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "content" && step.action == "generate_brief")
            .unwrap();
        assert_eq!(brief.depends_on, vec!["map-search-intent", "fetch-page"]);
        assert_planner_rationale_includes(
            &draft,
            &["content.map_search_intent", "content.generate_brief"],
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_metadata_only_prompt_does_not_extract_article_or_add_research_steps() {
        let draft = draft_from_prompt(
            "Create a metadata extraction workflow for https://example.com/pricing that fetches the page and extracts only title, description, canonical URL, and Open Graph metadata.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_metadata"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("web", "extract_article"),
                ("news", "trending"),
                ("content", "map_search_intent"),
                ("content", "generate_brief"),
            ],
        );
        assert!(draft.definition.name.contains("Metadata"));
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_status_path_metadata_prompt_uses_web_planner_not_http_probe() {
        let draft = draft_from_prompt(
            "Fetch https://example.com/status and extract title and description metadata.",
        )
        .unwrap();

        assert_ne!(draft.definition.id, "website-status-check");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_metadata"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(&draft.definition, &[("http_probe", "check_urls")]);
        assert_planner_rationale_includes(&draft, &["web.fetch_page", "web.extract_metadata"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_metadata_prompt_with_article_url_path_does_not_extract_article() {
        let draft =
            draft_from_prompt("Extract title metadata from https://example.com/article").unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_metadata"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(&draft.definition, &[("web", "extract_article")]);
        assert_planner_rationale_includes(&draft, &["web.fetch_page", "web.extract_metadata"]);
        assert_planner_rationale_excludes(&draft, &["web.extract_article"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_title_question_fetches_page_and_extracts_metadata() {
        let draft = draft_from_prompt("What is the title of https://example.com?").unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_metadata"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(&draft.definition, &[("http_probe", "check_urls")]);
        assert_planner_rationale_includes(&draft, &["web.fetch_page", "web.extract_metadata"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_status_description_prompt_uses_http_probe_without_planner_rationale() {
        let prompt =
            "Check the HTTP status for https://example.com and write a short description of whether it is reachable.";
        let draft = draft_from_prompt(prompt).unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_eq!(draft.definition.id, "website-status-check");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("http_probe", "check_urls"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[("web", "fetch_page"), ("web", "extract_metadata")],
        );
        assert!(draft.planner_rationale.is_none());
    }

    #[test]
    fn draft_from_status_prompt_with_report_title_uses_http_probe() {
        let prompt =
            "Check HTTP status for https://example.com and title the report Site Reachability.";
        let draft = draft_from_prompt(prompt).unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_eq!(draft.definition.id, "website-status-check");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("http_probe", "check_urls"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[("web", "fetch_page"), ("web", "extract_metadata")],
        );
        assert!(draft.planner_rationale.is_none());
    }

    #[test]
    fn draft_from_article_summary_prompt_fetches_and_extracts_article() {
        let draft = draft_from_prompt(
            "Summarize this article at https://example.com/posts/deterministic-planning into a concise Markdown report.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_article"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("rss", "fetch_feed"),
                ("news", "trending"),
                ("content", "generate_brief"),
            ],
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_explicit_article_path_text_prompt_fetches_and_extracts_article() {
        let draft = draft_from_prompt(
            "Extract article text from https://example.com/article and write a concise summary.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_article"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(&draft.definition, &[("http_probe", "check_urls")]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_feed_like_page_url_does_not_insert_rss_step() {
        let draft = draft_from_prompt(
            "Create a metadata report for https://example.com/feedback that fetches the page and extracts title and description.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_metadata"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[("rss", "fetch_feed"), ("web", "extract_article")],
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn planner_does_not_insert_rss_for_feedback_url() {
        let draft = draft_from_prompt(
            "Create a metadata report for https://example.com/feedback that fetches the page and extracts title and description.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_metadata"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[("rss", "fetch_feed"), ("news", "trending")],
        );
        assert_planner_rationale_includes(&draft, &["web.fetch_page", "web.extract_metadata"]);
        assert_planner_rationale_excludes(&draft, &["rss.fetch_feed"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_rss_feed_prompt_fetches_feed_without_web_page_or_news_trending() {
        let draft = draft_from_prompt(
            "Create an RSS feed digest from https://example.com/feed.xml; fetch and parse the feed entries, then summarize the titles.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("rss", "fetch_feed"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_article"),
                ("news", "trending"),
                ("weather", "forecast_24h"),
            ],
        );
        assert!(draft.definition.name.contains("RSS") || draft.definition.name.contains("Feed"));
        assert_planner_rationale_includes(&draft, &["rss.fetch_feed"]);
        assert_planner_rationale_excludes(&draft, &["web.fetch_page", "web.extract_metadata"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_feed_prompt_without_url_does_not_render_placeholder_feed() {
        let draft = draft_from_prompt("Create an RSS feed digest.").unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_exclude(&draft.definition, &[("rss", "fetch_feed")]);
        assert!(draft.planner_rationale.is_none());
        let definition_json = serde_json::to_string(&draft.definition).unwrap();
        assert!(!definition_json.contains("https://example.com/feed.xml"));
    }

    #[test]
    fn draft_from_mixed_feed_and_page_prompt_keeps_both_deterministic_steps() {
        let draft = draft_from_prompt(
            "Fetch the RSS feed https://example.com/feed.xml and summarize the page https://example.com/article page",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        let actions = draft
            .definition
            .steps
            .iter()
            .map(|step| (step.provider.as_str(), step.action.as_str()))
            .collect::<Vec<_>>();

        let feed_index = actions
            .iter()
            .position(|action| *action == ("rss", "fetch_feed"))
            .expect("rss.fetch_feed should render");
        let page_index = actions
            .iter()
            .position(|action| *action == ("web", "fetch_page"))
            .expect("web.fetch_page should render");
        let agent_index = actions
            .iter()
            .position(|action| *action == ("agent", "run_task"))
            .expect("agent.run_task should render");

        assert!(feed_index < agent_index);
        assert!(page_index < agent_index);
        assert_ne!(feed_index, page_index);

        let feed_step = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "rss" && step.action == "fetch_feed")
            .unwrap();
        assert_eq!(
            feed_step.inputs["url"],
            serde_json::json!("https://example.com/feed.xml")
        );

        let page_step = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "web" && step.action == "fetch_page")
            .unwrap();
        assert_eq!(
            page_step.inputs["url"],
            serde_json::json!("https://example.com/article")
        );

        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_json_ld_validation_prompt_validates_without_web_fetch() {
        let draft = draft_from_prompt(
            r#"Create a JSON-LD validation workflow that validates this schema payload and summarizes errors: {"@context":"https://schema.org","@type":"FAQPage"}"#,
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("seo", "validate_json_ld"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("seo", "fetch_robots_txt"),
                ("seo", "fetch_sitemap"),
                ("content", "generate_brief"),
            ],
        );
        assert!(
            draft.definition.name.contains("JSON-LD")
                || draft.definition.name.contains("Validation")
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_mixed_data_and_json_ld_prompt_uses_neutral_deterministic_title() {
        let draft = draft_from_prompt(
            r#"Create a deterministic QA workflow: parse this CSV, select name, then validate this JSON-LD payload and summarize both results.
name,status
Acme,active
{"@context":"https://schema.org","@type":"FAQPage"}"#,
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("data", "transform_json"),
                ("seo", "validate_json_ld"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[("web", "fetch_page"), ("rss", "fetch_feed")],
        );
        assert_eq!(draft.definition.name, "Deterministic Workflow");
        assert!(draft
            .definition
            .description
            .contains("deterministic provider operations"));
        let parse_csv = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "parse_csv")
            .expect("parse_csv step should exist");
        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!("name,status\nAcme,active")
        );
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn draft_from_mixed_csv_with_json_shaped_field_validates_json_ld_payload() {
        let draft = draft_from_prompt(
            r#"Create a deterministic QA workflow: parse this CSV, select name, then validate this JSON-LD payload and summarize both results.
name,notes
Acme,"{""draft"":true}"
{"@context":"https://schema.org","@type":"FAQPage"}"#,
        )
        .unwrap();

        let validate_json_ld = draft
            .definition
            .steps
            .iter()
            .find(|step| step.id == "validate-json-ld")
            .expect("validate-json-ld step should exist");

        assert_eq!(
            validate_json_ld.inputs["json_ld"],
            serde_json::json!({"@context":"https://schema.org","@type":"FAQPage"})
        );
        assert_ne!(validate_json_ld.inputs["json_ld"], serde_json::json!({}));
    }

    #[test]
    fn planner_includes_parse_transform_validate_for_mixed_prompt() {
        let draft = draft_from_prompt(
            r#"Create a deterministic QA workflow: parse this CSV, select name, then validate this JSON-LD payload and summarize both results.
name,status
Acme,active
{"@context":"https://schema.org","@type":"FAQPage"}"#,
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("data", "transform_json"),
                ("seo", "validate_json_ld"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("web", "extract_article"),
                ("web", "extract_metadata"),
                ("rss", "fetch_feed"),
            ],
        );
        assert_planner_rationale_includes(
            &draft,
            &[
                "data.parse_csv",
                "data.transform_json",
                "seo.validate_json_ld",
            ],
        );
        assert_planner_rationale_excludes(&draft, &["web.fetch_page", "rss.fetch_feed"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn operation_planner_builds_csv_transform_chain_without_web_steps() {
        let draft = draft_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("data", "transform_json"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("web", "fetch_page"),
                ("rss", "fetch_feed"),
                ("news", "trending"),
            ],
        );
    }

    #[test]
    fn operation_planner_transforms_inline_json_records_without_collection_steps() {
        let draft = draft_from_prompt(
            r#"Transform these records by filtering status=active, sorting by revenue, projecting name,revenue, limiting to 2, then summarize.
[{"name":"Beta","status":"inactive","revenue":5},{"name":"Acme","status":"active","revenue":42},{"name":"Zen","status":"active","revenue":7}]"#,
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_eq!(draft.definition.name, "Data Transformation Summary");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "transform_json"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("web", "fetch_page"),
                ("rss", "fetch_feed"),
                ("news", "trending"),
            ],
        );
        assert_planner_rationale_includes(&draft, &["data.transform_json"]);
        assert_planner_rationale_excludes(
            &draft,
            &["data.parse_csv", "web.fetch_page", "rss.fetch_feed"],
        );
        let transform = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "transform_json")
            .expect("transform step should exist");
        assert!(transform.depends_on.is_empty());
        assert_eq!(
            transform.inputs["data"],
            serde_json::json!([
                {"name":"Beta","status":"inactive","revenue":5},
                {"name":"Acme","status":"active","revenue":42},
                {"name":"Zen","status":"active","revenue":7}
            ])
        );
        assert_eq!(
            transform.inputs["filter_equals"],
            serde_json::json!({ "status": "active" })
        );
        assert_eq!(
            transform.inputs["select_fields"],
            serde_json::json!(["name", "revenue"])
        );
        assert_eq!(transform.inputs["sort_by"], serde_json::json!("revenue"));
        assert_eq!(transform.inputs["limit"], serde_json::json!(2));
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn operation_planner_transforms_provided_records_without_inventing_collection() {
        let draft = draft_from_prompt(
            "Using the provided structured records, reshape the data to select customer,total, sort by total, limit 3, then write a short summary.",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "transform_json"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("web", "fetch_page"),
                ("rss", "fetch_feed"),
                ("news", "trending"),
            ],
        );
        assert_planner_rationale_includes(&draft, &["data.transform_json"]);
        assert_planner_rationale_excludes(
            &draft,
            &["data.parse_csv", "web.fetch_page", "rss.fetch_feed"],
        );
        let transform = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "transform_json")
            .expect("transform step should exist");
        assert!(transform.depends_on.is_empty());
        assert_eq!(
            transform.inputs["data"],
            serde_json::json!({ "source": "provided_structured_records" })
        );
        assert_eq!(
            transform.inputs["select_fields"],
            serde_json::json!(["customer", "total"])
        );
        assert_eq!(transform.inputs["sort_by"], serde_json::json!("total"));
        assert_eq!(transform.inputs["limit"], serde_json::json!(3));
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn operation_planner_parse_csv_input_starts_at_real_header() {
        let draft = draft_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42",
        )
        .unwrap();

        let parse_csv = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "parse_csv")
            .expect("parse CSV step should exist");

        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!("name,status,revenue\nAcme,active,42")
        );
    }

    #[test]
    fn operation_planner_preserves_transform_input_case() {
        let draft = draft_from_prompt(
            "Create a CSV report: parse this CSV, filter Status=Active, sort by Revenue, select Name,Revenue, limit 5, then summarize.\nName,Status,Revenue\nAcme,Active,42",
        )
        .unwrap();

        let transform = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "transform_json")
            .expect("transform step should exist");

        assert_eq!(
            transform.inputs["filter_equals"],
            serde_json::json!({ "Status": "Active" })
        );
        assert_eq!(
            transform.inputs["select_fields"],
            serde_json::json!(["Name", "Revenue"])
        );
        assert_eq!(transform.inputs["sort_by"], serde_json::json!("Revenue"));
    }

    #[test]
    fn operation_planner_keeps_csv_article_column_out_of_article_extraction() {
        let draft = draft_from_prompt(
            "Create a CSV article report and summarize the article column.\narticle,count\nLaunch post,3",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[("web", "fetch_page"), ("web", "extract_article")],
        );
        assert_planner_rationale_includes(&draft, &["data.parse_csv"]);
        assert_planner_rationale_excludes(&draft, &["web.extract_article"]);
    }

    #[test]
    fn operation_planner_keeps_csv_title_description_columns_out_of_web_metadata() {
        let draft = draft_from_prompt(
            "Create a CSV report: parse this CSV and summarize title and description.\ntitle,description\nLaunch plan,Internal draft",
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("data", "parse_csv"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(
            &draft.definition,
            &[("web", "fetch_page"), ("web", "extract_metadata")],
        );
        assert_planner_rationale_includes(&draft, &["data.parse_csv"]);
        assert_planner_rationale_excludes(&draft, &["web.fetch_page", "web.extract_metadata"]);
        assert_synthesis_agent_has_no_tools(&draft.definition);
    }

    #[test]
    fn operation_planner_keeps_json_ld_url_out_of_web_fetch() {
        let draft = draft_from_prompt(
            r#"Validate this JSON-LD and summarize errors: {"@context":"https://schema.org","@type":"FAQPage"}"#,
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_provider_actions_include(
            &draft.definition,
            &[
                ("seo", "validate_json_ld"),
                ("agent", "run_task"),
                ("local_app", "write_artifact"),
            ],
        );
        assert_provider_actions_exclude(&draft.definition, &[("web", "fetch_page")]);
    }

    #[test]
    fn planner_uses_agent_only_for_final_synthesis_when_prep_exists() {
        let draft = draft_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42",
        )
        .unwrap();

        let agent_step = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "agent" && step.action == "run_task")
            .expect("expected final synthesis agent step");
        assert!(agent_step
            .depends_on
            .iter()
            .any(|dependency| dependency == "parse-csv"));
        assert!(agent_step
            .depends_on
            .iter()
            .any(|dependency| dependency == "transform-data"));
        assert_eq!(agent_step.permissions, vec!["llm:generate"]);
        assert_eq!(agent_step.inputs["allowed_tools"], serde_json::json!([]));
        assert_planner_rationale_includes(&draft, &["data.parse_csv", "data.transform_json"]);
    }

    #[test]
    fn deterministic_revision_updates_transform_options_without_replacing_csv() {
        let previous = revision_context_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
        );

        let revised = draft_revision_from_prompt(
            "Remove the filter, sort by name descending, select name,status, and limit 2.",
            &previous,
        )
        .unwrap();

        let parse_csv = step(&revised.definition, "parse-csv");
        let transform = step(&revised.definition, "transform-data");
        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!(
                "name,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500"
            )
        );
        assert!(transform.inputs.get("filter_equals").is_none());
        assert_eq!(transform.inputs["sort_by"], serde_json::json!("name"));
        assert_eq!(
            transform.inputs["sort_direction"],
            serde_json::json!("desc")
        );
        assert_eq!(
            transform.inputs["select_fields"],
            serde_json::json!(["name", "status"])
        );
        assert_eq!(transform.inputs["limit"], serde_json::json!(2));
        assert_eq!(revised.diff_json[0]["changed"], serde_json::json!(true));
    }

    #[test]
    fn deterministic_revision_parses_natural_selected_field_updates() {
        let previous = revision_context_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
        );

        for prompt in [
            "Change selected fields to name,status.",
            "Select name,status instead.",
            "Project name,status.",
            "Only keep name and status.",
            "Replace selected fields with name,status.",
        ] {
            let revised = draft_revision_from_prompt(prompt, &previous).unwrap();
            let transform = step(&revised.definition, "transform-data");
            assert_eq!(
                transform.inputs["select_fields"],
                serde_json::json!(["name", "status"]),
                "prompt should update selected fields: {prompt}"
            );
            assert_eq!(revised.diff_json[0]["changed"], serde_json::json!(true));
        }
    }

    #[test]
    fn deterministic_revision_splits_multi_instruction_transform_clauses() {
        let previous = revision_context_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
        );

        let revised = draft_revision_from_prompt(
            "Change projected fields to name and status order by name descending limit 2 schedule weekdays at 09:30 focus on account status.",
            &previous,
        )
        .unwrap();

        let parse_csv = step(&revised.definition, "parse-csv");
        let transform = step(&revised.definition, "transform-data");
        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!(
                "name,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500"
            )
        );
        assert_eq!(
            transform.inputs["select_fields"],
            serde_json::json!(["name", "status"])
        );
        assert_eq!(transform.inputs["sort_by"], serde_json::json!("name"));
        assert_eq!(
            transform.inputs["sort_direction"],
            serde_json::json!("desc")
        );
        assert_eq!(transform.inputs["limit"], serde_json::json!(2));
        assert_eq!(
            revised.definition.schedule,
            Some(WorkflowScheduleDefinition {
                cadence: "weekdays".into(),
                local_time: Some("09:30".into()),
            })
        );
        assert!(step(&revised.definition, "summarize").inputs["objective"]
            .as_str()
            .unwrap_or_default()
            .contains("account status"));
        assert_eq!(revised.diff_json[0]["changed"], serde_json::json!(true));
    }

    #[test]
    fn deterministic_revision_leaves_unrelated_transform_settings_when_only_fields_change() {
        let previous = revision_context_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
        );

        let revised = draft_revision_from_prompt(
            "Only keep name and status before writing the artifact.",
            &previous,
        )
        .unwrap();

        let transform = step(&revised.definition, "transform-data");
        assert_eq!(
            transform.inputs["filter_equals"],
            serde_json::json!({ "status": "active" })
        );
        assert_eq!(transform.inputs["sort_by"], serde_json::json!("revenue"));
        assert_eq!(transform.inputs["limit"], serde_json::json!(5));
        assert_eq!(
            transform.inputs["select_fields"],
            serde_json::json!(["name", "status"])
        );
    }

    #[test]
    fn deterministic_revision_updates_workflow_metadata_schedule_and_summary_intent() {
        let previous = revision_context_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900",
        );

        let revised = draft_revision_from_prompt(
            "Rename workflow to Inactive Accounts. Change description to Reports inactive account revenue. Schedule weekdays at 09:30. Update the artifact summary to focus on inactive accounts.",
            &previous,
        )
        .unwrap();

        assert_eq!(revised.definition.id, previous.definition.id);
        assert_eq!(revised.definition.name, "Inactive Accounts");
        assert_eq!(
            revised.definition.description,
            "Reports inactive account revenue."
        );
        assert_eq!(
            revised.definition.schedule,
            Some(WorkflowScheduleDefinition {
                cadence: "weekdays".into(),
                local_time: Some("09:30".into()),
            })
        );
        let summarize = step(&revised.definition, "summarize");
        assert!(summarize.inputs["objective"]
            .as_str()
            .unwrap_or_default()
            .contains("inactive accounts"));
        assert_eq!(revised.diff_json[0]["changed"], serde_json::json!(true));
    }

    #[test]
    fn deterministic_revision_flags_unsupported_feedback_as_unchanged() {
        let previous = revision_context_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200",
        );

        let revised =
            draft_revision_from_prompt("Make the chart blue and animated.", &previous).unwrap();

        assert_eq!(revised.definition, previous.definition);
        assert_eq!(revised.diff_json[0]["changed"], serde_json::json!(false));
        assert!(revised.summary.contains("kept the previous workflow draft"));
    }

    #[test]
    fn deterministic_revision_ignores_rows_like_feedback_prose_for_csv_content() {
        let previous = revision_context_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900",
        );

        let revised = draft_revision_from_prompt(
            "Change sort by name. Notes, not rows: Fake,active,999 and Other,inactive,111.",
            &previous,
        )
        .unwrap();

        let parse_csv = step(&revised.definition, "parse-csv");
        let transform = step(&revised.definition, "transform-data");
        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!("name,status,revenue\nAcme,active,1200\nBeta,inactive,900")
        );
        assert_eq!(transform.inputs["sort_by"], serde_json::json!("name"));
        assert_eq!(revised.diff_json[0]["changed"], serde_json::json!(true));
    }

    fn revision_context_from_prompt(prompt: &str) -> WorkflowDraftRevisionContext {
        let draft = draft_from_prompt(prompt).unwrap();
        WorkflowDraftRevisionContext {
            source_label: draft.summary,
            validation_errors: draft.validation_errors,
            planner_rationale: draft.planner_rationale,
            definition: draft.definition,
        }
    }

    fn step<'a>(workflow: &'a RavenWorkflow, id: &str) -> &'a WorkflowStepDefinition {
        workflow
            .steps
            .iter()
            .find(|step| step.id == id)
            .unwrap_or_else(|| panic!("expected step {id}"))
    }

    fn assert_provider_actions_include(workflow: &RavenWorkflow, expected: &[(&str, &str)]) {
        let actions = workflow
            .steps
            .iter()
            .map(|step| (step.provider.as_str(), step.action.as_str()))
            .collect::<Vec<_>>();
        for action in expected {
            assert!(
                actions.contains(action),
                "expected {action:?} in {actions:?}"
            );
        }
    }

    fn assert_provider_actions_exclude(workflow: &RavenWorkflow, unexpected: &[(&str, &str)]) {
        let actions = workflow
            .steps
            .iter()
            .map(|step| (step.provider.as_str(), step.action.as_str()))
            .collect::<Vec<_>>();
        for action in unexpected {
            assert!(
                !actions.contains(action),
                "did not expect {action:?} in {actions:?}"
            );
        }
    }

    fn assert_planner_rationale_includes(draft: &WorkflowDraft, expected: &[&str]) {
        let capability_ids = draft
            .planner_rationale
            .as_ref()
            .expect("planned drafts should include planner rationale")
            .operations
            .iter()
            .filter_map(|operation| operation.capability_id.as_deref())
            .collect::<Vec<_>>();
        for capability_id in expected {
            assert!(
                capability_ids.contains(capability_id),
                "expected planner rationale to include {capability_id:?} in {capability_ids:?}"
            );
        }
    }

    fn assert_planner_rationale_excludes(draft: &WorkflowDraft, unexpected: &[&str]) {
        let capability_ids = draft
            .planner_rationale
            .as_ref()
            .expect("planned drafts should include planner rationale")
            .operations
            .iter()
            .filter_map(|operation| operation.capability_id.as_deref())
            .collect::<Vec<_>>();
        for capability_id in unexpected {
            assert!(
                !capability_ids.contains(capability_id),
                "did not expect planner rationale to include {capability_id:?} in {capability_ids:?}"
            );
        }
    }

    fn assert_synthesis_agent_has_no_tools(workflow: &RavenWorkflow) {
        let agent_steps = workflow
            .steps
            .iter()
            .filter(|step| step.provider == "agent" && step.action == "run_task")
            .collect::<Vec<_>>();
        assert_eq!(agent_steps.len(), 1);
        assert_eq!(agent_steps[0].permissions, vec!["llm:generate"]);
        assert_eq!(
            agent_steps[0].inputs["allowed_tools"],
            serde_json::json!([])
        );
    }

    #[test]
    fn rejects_inline_code_and_cycles() {
        let mut workflow = daily_work_journal();
        workflow.steps[0].depends_on = vec!["write-artifact".into()];
        assert!(validate_workflow(&workflow)
            .unwrap_err()
            .to_string()
            .contains("cycle"));

        let mut workflow = daily_work_journal();
        workflow.steps[1].inline_code = Some("eval()".into());
        assert!(validate_workflow(&workflow)
            .unwrap_err()
            .to_string()
            .contains("inline"));
    }

    #[test]
    fn accepts_prompt_native_agent_task_with_declared_permissions() {
        let workflow = agent_weather_workflow();

        validate_workflow(&workflow).unwrap();
    }

    #[test]
    fn accepts_agent_task_with_implemented_agent_profiles() {
        for profile in [
            "codex-oauth-local",
            "claude-code-oauth-local",
            "openai-api-key",
            "anthropic-api-key",
            "ollama-local",
        ] {
            let mut workflow = agent_weather_workflow();
            workflow.defaults.llm_profile_ref = profile.into();
            workflow.steps[0].llm_profile_ref = Some(profile.into());

            validate_workflow(&workflow).unwrap();
        }
    }

    #[test]
    fn rejects_agent_task_with_unknown_llm_profile() {
        let mut workflow = agent_weather_workflow();
        workflow.defaults.llm_profile_ref = "made-up-agent".into();
        workflow.steps[0].llm_profile_ref = Some("made-up-agent".into());

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains("Workflow defaults reference missing LLM profile made-up-agent."));
        assert!(error.contains("Step ask-ai references missing LLM profile made-up-agent."));
    }

    #[test]
    fn rejects_agent_task_with_permissions_not_granted_by_allowed_tools() {
        let mut workflow = agent_weather_workflow();
        workflow.steps[0].permissions = vec![
            "llm:generate".into(),
            "network:read".into(),
            "git:read".into(),
            "artifact:write".into(),
        ];
        workflow.permissions.push("git:read".into());

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains(
            "Step ask-ai declares permission git:read not granted by agent allowed_tools."
        ));
        assert!(error.contains(
            "Step ask-ai declares permission artifact:write not granted by agent allowed_tools."
        ));
    }

    #[test]
    fn rejects_agent_task_when_allowed_tools_exceed_permissions() {
        let mut workflow = agent_weather_workflow();
        workflow.permissions = vec!["llm:generate".into(), "artifact:write".into()];

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error
            .contains("Step ask-ai allows tool web but workflow does not declare network:read."));
    }

    #[test]
    fn rejects_agent_task_when_step_permissions_omit_allowed_tool_permission() {
        let mut workflow = agent_weather_workflow();
        workflow.steps[0].permissions = vec!["llm:generate".into()];

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(
            error.contains("Step ask-ai allows tool web but step does not declare network:read.")
        );
    }

    #[test]
    fn accepts_http_probe_provider_action() {
        let workflow = http_probe_workflow();

        validate_workflow(&workflow).unwrap();
    }

    #[test]
    fn accepts_builtin_provider_action_when_registry_is_empty() {
        let workflow = http_probe_workflow();
        let registry = empty_test_registry();

        validate_workflow_with_registry(&workflow, &registry, &[]).unwrap();
    }

    #[test]
    fn accepts_builtin_provider_with_registry_backed_artifact_sink() {
        let mut workflow = http_probe_workflow();
        workflow.permissions.push("artifact:write".into());
        workflow.steps.push(WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "write-artifact".into(),
            name: "Save artifact".into(),
            provider: "local_app".into(),
            action: "write_artifact".into(),
            depends_on: vec!["check-urls".into()],
            permissions: vec!["artifact:write".into()],
            inputs: serde_json::json!({ "artifact": "$steps.check-urls.artifact" }),
            llm_profile_ref: None,
            destination_ref: Some("local-app".into()),
            inline_code: None,
            parallel: None,
        });
        let registry = test_registry(vec![]);

        validate_workflow_with_registry(&workflow, &registry, &[]).unwrap();
    }

    #[test]
    fn rejects_http_probe_provider_action_without_urls() {
        let mut workflow = http_probe_workflow();
        workflow.steps[0].inputs = serde_json::json!({});

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains(
            "Step check-urls http_probe.check_urls inputs.urls must be a non-empty array of strings."
        ));
    }

    #[test]
    fn rejects_http_probe_status_codes_below_http_range() {
        let mut workflow = http_probe_workflow();
        workflow.steps[0].inputs["accepted_status_codes"] = serde_json::json!([99]);

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains(
            "Step check-urls http_probe.check_urls inputs.accepted_status_codes[0] must be an HTTP status code from 100 through 599."
        ));
    }

    #[test]
    fn rejects_http_probe_status_codes_above_http_range() {
        let mut workflow = http_probe_workflow();
        workflow.steps[0].inputs["accepted_status_codes"] = serde_json::json!([600]);

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains(
            "Step check-urls http_probe.check_urls inputs.accepted_status_codes[0] must be an HTTP status code from 100 through 599."
        ));
    }

    #[test]
    fn accepts_http_probe_status_code_boundaries() {
        let mut workflow = http_probe_workflow();
        workflow.steps[0].inputs["accepted_status_codes"] = serde_json::json!([100, 599]);

        validate_workflow(&workflow).unwrap();
    }

    #[test]
    fn rejects_agent_web_for_url_check_when_http_probe_is_available() {
        for objective in [
            "Check whether https://example.com is reachable.",
            "Check uptime for example.com",
            "Is example.com up?",
            "Is https://example.com/article up?",
        ] {
            let mut workflow = agent_weather_workflow();
            workflow.steps[0].inputs["objective"] = serde_json::json!(objective);

            let error = validate_workflow(&workflow).unwrap_err().to_string();

            assert!(
                error.contains("Use deterministic provider http_probe.check_urls"),
                "{objective} should use deterministic provider: {error}"
            );
        }
    }

    #[test]
    fn accepts_agent_web_for_content_inspection_tasks() {
        for objective in [
            "Check https://example.com docs for API changes",
            "Verify pricing on example.com",
            "Look up pricing on example.com",
        ] {
            let mut workflow = agent_weather_workflow();
            workflow.steps[0].inputs["objective"] = serde_json::json!(objective);

            validate_workflow(&workflow).unwrap();
        }
    }

    #[test]
    fn accepts_mixed_http_probe_agent_artifact_shape() {
        let workflow = mixed_http_probe_agent_artifact_workflow();

        validate_workflow(&workflow).unwrap();
    }

    #[test]
    fn accepts_mixed_roadmap_provider_agent_artifact_shape() {
        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "weather-news-summary".into(),
            name: "Weather News Summary".into(),
            description: "Collects deterministic weather and news data before agent synthesis."
                .into(),
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
                    id: "forecast".into(),
                    name: "Fetch forecast".into(),
                    provider: "weather".into(),
                    action: "forecast_24h".into(),
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
                    provider: "news".into(),
                    action: "trending".into(),
                    depends_on: vec![],
                    permissions: vec!["network:read".into()],
                    inputs: serde_json::json!({ "max_items": 5 }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::AgentTask,
                    id: "summarize".into(),
                    name: "Summarize".into(),
                    provider: "agent".into(),
                    action: "run_task".into(),
                    depends_on: vec!["forecast".into(), "headlines".into()],
                    permissions: vec!["llm:generate".into()],
                    inputs: serde_json::json!({
                        "objective": "Summarize deterministic forecast and news outputs.",
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
                    name: "Save artifact".into(),
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

        validate_workflow(&workflow).unwrap();
    }

    #[test]
    fn accepts_seo_content_brief_before_agent_writing_shape() {
        let workflow = RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "seo-service-page".into(),
            name: "SEO Service Page".into(),
            description:
                "Audits SEO context, prepares a content brief, writes a service page, and saves it."
                    .into(),
            permissions: vec![
                "network:read".into(),
                "data:read".into(),
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
                    id: "fetch-page".into(),
                    name: "Fetch page".into(),
                    provider: "web".into(),
                    action: "fetch_page".into(),
                    depends_on: vec![],
                    permissions: vec!["network:read".into()],
                    inputs: serde_json::json!({ "url": "https://example.com/services/seo" }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "audit-metadata".into(),
                    name: "Audit metadata".into(),
                    provider: "seo".into(),
                    action: "audit_metadata".into(),
                    depends_on: vec!["fetch-page".into()],
                    permissions: vec!["network:read".into(), "data:read".into()],
                    inputs: serde_json::json!({
                        "body_text": "$steps.fetch-page.body_text",
                        "url": "https://example.com/services/seo"
                    }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "brief".into(),
                    name: "Generate brief".into(),
                    provider: "content".into(),
                    action: "generate_brief".into(),
                    depends_on: vec!["audit-metadata".into()],
                    permissions: vec!["data:read".into()],
                    inputs: serde_json::json!({
                        "topic": "SEO consulting for SaaS",
                        "audience": "B2B SaaS founders",
                        "page_type": "service",
                        "business_goal": "book consultations"
                    }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::AgentTask,
                    id: "write-page".into(),
                    name: "Write service page".into(),
                    provider: "agent".into(),
                    action: "run_task".into(),
                    depends_on: vec!["fetch-page".into(), "audit-metadata".into(), "brief".into()],
                    permissions: vec!["llm:generate".into()],
                    inputs: serde_json::json!({
                        "objective": "Write site content using deterministic SEO evidence from $steps.audit-metadata.checks and the brief from $steps.brief.",
                        "allowed_tools": [],
                        "output_schema": "artifact_envelope"
                    }),
                    llm_profile_ref: Some("codex-oauth-local".into()),
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "write-artifact".into(),
                    name: "Save page draft".into(),
                    provider: "local_app".into(),
                    action: "write_artifact".into(),
                    depends_on: vec!["write-page".into()],
                    permissions: vec!["artifact:write".into()],
                    inputs: serde_json::json!({ "artifact": "$steps.write-page.artifact" }),
                    llm_profile_ref: None,
                    destination_ref: Some("local-app".into()),
                    inline_code: None,
                    parallel: None,
                },
            ],
        };

        validate_workflow(&workflow).unwrap();
    }

    #[test]
    fn rejects_provider_only_deterministic_steps_that_depend_on_later_steps() {
        let mut workflow = http_probe_workflow();
        workflow.id = "out-of-order-deterministic".into();
        workflow.permissions.push("data:read".into());
        workflow.steps.insert(
            0,
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "shape".into(),
                name: "Shape rows".into(),
                provider: "data".into(),
                action: "transform_json".into(),
                depends_on: vec!["check-urls".into()],
                permissions: vec!["data:read".into()],
                inputs: serde_json::json!({ "data": "$steps.check-urls.results" }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
        );

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains(
            "Deterministic provider step shape may depend only on earlier deterministic provider steps."
        ));
    }

    #[test]
    fn rejects_provider_only_sink_that_references_non_dependency() {
        let mut workflow = http_probe_workflow();
        workflow.permissions.push("artifact:write".into());
        workflow.steps.push(WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "write-artifact".into(),
            name: "Save artifact".into(),
            provider: "local_app".into(),
            action: "write_artifact".into(),
            depends_on: vec![],
            permissions: vec!["artifact:write".into()],
            inputs: serde_json::json!({ "artifact": "$steps.check-urls.results" }),
            llm_profile_ref: None,
            destination_ref: Some("local-app".into()),
            inline_code: None,
            parallel: None,
        });

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains(
            "Deterministic provider sink write-artifact inputs.artifact must reference one of its dependencies."
        ));
    }

    #[test]
    fn rejects_mixed_http_probe_agent_shape_with_invalid_dependency_direction() {
        let mut missing_agent_dependency = mixed_http_probe_agent_artifact_workflow();
        missing_agent_dependency.steps[1].depends_on = vec![];

        let error = validate_workflow(&missing_agent_dependency)
            .unwrap_err()
            .to_string();

        assert!(error.contains("Agent runtime step summarize must depend on check-urls."));

        let mut later_step_dependency = mixed_http_probe_agent_artifact_workflow();
        let second_probe = WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "check-api".into(),
            name: "Check API URL".into(),
            provider: "http_probe".into(),
            action: "check_urls".into(),
            depends_on: vec![],
            permissions: vec!["network:read".into()],
            inputs: serde_json::json!({ "urls": ["https://api.example.com"] }),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        };
        later_step_dependency.steps.insert(1, second_probe);
        later_step_dependency.steps[0].depends_on = vec!["check-api".into()];
        later_step_dependency.steps[2].depends_on = vec!["check-urls".into(), "check-api".into()];

        let error = validate_workflow(&later_step_dependency)
            .unwrap_err()
            .to_string();

        assert!(
            error.contains(
                "Agent runtime deterministic step check-urls may depend only on earlier deterministic steps."
            ),
            "{error}"
        );
    }

    #[test]
    fn rejects_agent_runtime_shape_with_extra_provider_step() {
        let mut workflow = agent_weather_workflow();
        workflow.steps.push(WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "fetch-weather".into(),
            name: "Fetch current weather".into(),
            provider: "open_meteo".into(),
            action: "current_weather".into(),
            depends_on: vec!["ask-ai".into()],
            permissions: vec!["weather:read".into()],
            inputs: serde_json::json!({ "location": "Denver, CO" }),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        });
        workflow.permissions.push("weather:read".into());

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains(
            "Agent runtime supports exactly one agent_task step plus optional local_app.write_artifact sink."
        ));
    }

    #[test]
    fn rejects_agent_runtime_sink_with_invalid_dependency_or_input() {
        let mut invalid_dependency = agent_weather_workflow();
        invalid_dependency.steps[1].depends_on = vec!["other-step".into()];

        let error = validate_workflow(&invalid_dependency)
            .unwrap_err()
            .to_string();

        assert!(error.contains("Agent runtime sink write-artifact must depend only on ask-ai."));

        let mut invalid_input = agent_weather_workflow();
        invalid_input.steps[1].inputs = serde_json::json!({ "artifact": "$steps.other.artifact" });

        let error = validate_workflow(&invalid_input).unwrap_err().to_string();

        assert!(error.contains(
            "Agent runtime sink write-artifact inputs.artifact must reference $steps.ask-ai.artifact."
        ));
    }

    #[test]
    fn defaults_missing_step_kind_to_provider_action_when_deserializing() {
        let workflow: RavenWorkflow =
            serde_json::from_value(serde_json::json!(legacy_weather_workflow_json())).unwrap();

        assert_eq!(workflow.steps[0].kind, WorkflowStepKind::ProviderAction);
    }

    #[test]
    fn defaults_unknown_step_kind_to_provider_action_when_deserializing() {
        let mut json = legacy_weather_workflow_json();
        json["steps"][0]["kind"] = serde_json::json!("surprise_kind");

        let workflow: RavenWorkflow = serde_json::from_value(json).unwrap();

        assert_eq!(workflow.steps[0].kind, WorkflowStepKind::ProviderAction);
    }

    #[test]
    fn rejects_agent_task_with_unknown_allowed_tool() {
        let mut workflow = agent_weather_workflow();
        workflow.steps[0].inputs["allowed_tools"] = serde_json::json!(["shell"]);

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains("Step ask-ai allows unknown tool shell."));
    }

    #[test]
    fn rejects_agent_task_with_malformed_allowed_tools() {
        let mut workflow = agent_weather_workflow();
        workflow.steps[0].inputs["allowed_tools"] = serde_json::json!("web");

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains("Step ask-ai inputs.allowed_tools must be an array when present."));

        let mut workflow = agent_weather_workflow();
        workflow.steps[0].inputs["allowed_tools"] = serde_json::json!(["web", 42]);

        let error = validate_workflow(&workflow).unwrap_err().to_string();

        assert!(error.contains("Step ask-ai allowed_tools[1] must be a string."));
    }

    #[test]
    fn accepts_provider_action_backed_by_plugin_capability() {
        let workflow = plugin_artifact_workflow();
        let plugins = vec![plugin_manifest()];

        validate_workflow_with_plugins(&workflow, &plugins).unwrap();
    }

    #[test]
    fn accepts_registry_backed_provider_action_before_plugin_validation() {
        let mut workflow = plugin_artifact_workflow();
        workflow.permissions = vec!["data:read".into()];
        workflow.steps = vec![WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "inspect".into(),
            name: "Inspect".into(),
            provider: "registry_only".into(),
            action: "inspect".into(),
            depends_on: vec![],
            permissions: vec!["data:read".into()],
            inputs: serde_json::json!({}),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        }];
        let mut capability = crate::capability_registry::descriptor_from_static_capability(
            capability_for("seo", "audit_metadata").unwrap(),
        );
        capability.id = "registry_only.inspect".into();
        capability.provider = "registry_only".into();
        capability.action = "inspect".into();
        capability.source = crate::models::CapabilitySource::Cli;
        capability.permissions = vec!["data:read".into()];
        capability.adapter = crate::models::CapabilityAdapter::Native {
            handler: "registry_only.inspect".into(),
        };
        let registry = crate::capability_registry::CapabilityRegistrySnapshot {
            hash: "test-registry".into(),
            generated_at: "2026-06-21T00:00:00Z".into(),
            capabilities: vec![capability],
            policy_decisions: vec![],
        };
        let plugins = vec![plugin_manifest()];

        validate_workflow_with_registry(&workflow, &registry, &plugins).unwrap();

        workflow.steps[0].permissions.clear();
        let error = validate_workflow_with_registry(&workflow, &registry, &plugins)
            .unwrap_err()
            .to_string();
        assert!(error.contains(
            "Step inspect must declare capability permission data:read required by registry_only.inspect."
        ));
    }

    #[test]
    fn rejects_agent_registry_capabilities_as_provider_actions() {
        for (provider, action, permission) in [
            ("agent", "run_task", "llm:generate"),
            ("agent_tool", "web_search", "network:read"),
        ] {
            let workflow = RavenWorkflow {
                schema_version: "0.1.0".into(),
                id: format!("{provider}-{action}"),
                name: "Invalid agent provider action".into(),
                description: "Agent capabilities must not validate as provider_action.".into(),
                permissions: vec![permission.into()],
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
                    id: "invalid-agent-capability".into(),
                    name: "Invalid agent capability".into(),
                    provider: provider.into(),
                    action: action.into(),
                    depends_on: vec![],
                    permissions: vec![permission.into()],
                    inputs: serde_json::json!({ "objective": "Summarize" }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                }],
            };
            let mut capability = registry_capability(provider, action);
            capability.id = format!("{provider}.{action}");
            capability.permissions = vec![permission.into()];
            let registry = test_registry(vec![capability]);

            let error = validate_workflow_with_registry(&workflow, &registry, &[])
                .unwrap_err()
                .to_string();

            assert!(error.contains(&format!(
                "Step invalid-agent-capability references unsupported action {provider}.{action}."
            )));
        }
    }

    #[test]
    fn rejects_unavailable_registry_capabilities_as_provider_actions() {
        let workflow = registry_inspect_workflow(false);
        let mut capability = registry_capability("registry_only", "inspect");
        capability.status = crate::models::CapabilityAvailability::Unavailable;
        let registry = test_registry(vec![capability]);

        let error = validate_workflow_with_registry(&workflow, &registry, &[])
            .unwrap_err()
            .to_string();

        assert!(error.contains("Step inspect references unsupported action registry_only.inspect."));
    }

    #[test]
    fn registry_capability_wins_over_overlapping_plugin_runtime_shape() {
        let workflow = registry_inspect_workflow(true);
        let plugins = vec![overlapping_plugin_manifest()];
        let registry = test_registry(vec![registry_capability("registry_only", "inspect")]);

        validate_workflow_with_registry(&workflow, &registry, &plugins).unwrap();
    }

    #[test]
    fn builtin_source_registry_determinism_extends_runtime_shape() {
        let workflow = registry_inspect_workflow(true);
        let mut capability = registry_capability("registry_only", "inspect");
        capability.source = crate::models::CapabilitySource::Builtin;
        capability.deterministic = true;
        let registry = test_registry(vec![capability]);

        validate_workflow_with_registry(&workflow, &registry, &[]).unwrap();
    }

    #[test]
    fn rejects_plugin_step_missing_manifest_permission() {
        let mut workflow = plugin_artifact_workflow();
        workflow.steps[0].permissions.clear();
        let plugins = vec![plugin_manifest()];

        let error = validate_workflow_with_plugins(&workflow, &plugins)
            .unwrap_err()
            .to_string();

        assert!(error.contains(
            "Step build-artifact must declare plugin permission plugin:execute required by deterministic_artifact.build_artifact."
        ));
    }

    #[test]
    fn rejects_plugin_step_with_unknown_action() {
        let mut workflow = plugin_artifact_workflow();
        workflow.steps[0].action = "missing_action".into();
        let plugins = vec![plugin_manifest()];

        let error = validate_workflow_with_plugins(&workflow, &plugins)
            .unwrap_err()
            .to_string();

        assert!(error.contains(
            "Step build-artifact references unsupported action deterministic_artifact.missing_action."
        ));
    }

    #[test]
    fn rejects_plugin_workflows_with_extra_runtime_steps() {
        let mut workflow = plugin_artifact_workflow();
        workflow.permissions.push("weather:read".into());
        workflow.steps.push(WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "fetch-weather".into(),
            name: "Fetch weather".into(),
            provider: "open_meteo".into(),
            action: "current_weather".into(),
            depends_on: vec!["build-artifact".into()],
            permissions: vec!["weather:read".into()],
            inputs: serde_json::json!({ "location": "Denver, CO" }),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        });
        let plugins = vec![plugin_manifest()];

        let error = validate_workflow_with_plugins(&workflow, &plugins)
            .unwrap_err()
            .to_string();

        assert!(error.contains(
            "Plugin runtime supports one plugin step plus optional local_app.write_artifact sink."
        ));
    }

    #[test]
    fn rejects_plugin_workflows_with_invalid_sink_wiring() {
        let mut workflow = plugin_artifact_workflow();
        workflow.steps[1].depends_on = vec!["other-step".into()];
        let plugins = vec![plugin_manifest()];

        let error = validate_workflow_with_plugins(&workflow, &plugins)
            .unwrap_err()
            .to_string();

        assert!(error.contains(
            "Plugin runtime sink write-artifact must depend on build-artifact and reference $steps.build-artifact.artifact."
        ));
    }

    fn legacy_weather_workflow_json() -> serde_json::Value {
        serde_json::json!({
            "schema_version": "0.1.0",
            "id": "legacy-weather",
            "name": "Legacy Weather",
            "description": "Legacy workflow without step kind.",
            "permissions": ["weather:read"],
            "defaults": {
                "llm_profile_ref": "open-meteo",
                "destination_ref": "local-app"
            },
            "steps": [
                {
                    "id": "fetch-weather",
                    "name": "Fetch current weather",
                    "provider": "open_meteo",
                    "action": "current_weather",
                    "depends_on": [],
                    "permissions": ["weather:read"],
                    "inputs": { "location": "Denver, CO" },
                    "llm_profile_ref": null,
                    "destination_ref": null,
                    "inline_code": null
                }
            ]
        })
    }

    fn http_probe_workflow() -> RavenWorkflow {
        RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "url-check".into(),
            name: "URL Check".into(),
            description: "Checks URLs with a deterministic provider.".into(),
            permissions: vec!["network:read".into()],
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
                id: "check-urls".into(),
                name: "Check URLs".into(),
                provider: "http_probe".into(),
                action: "check_urls".into(),
                depends_on: vec![],
                permissions: vec!["network:read".into()],
                inputs: serde_json::json!({ "urls": ["https://example.com"] }),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            }],
        }
    }

    fn mixed_http_probe_agent_artifact_workflow() -> RavenWorkflow {
        RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "url-check-summary".into(),
            name: "URL Check Summary".into(),
            description:
                "Checks URLs deterministically, asks an agent to summarize, and stores the artifact."
                    .into(),
            permissions: vec![
                "network:read".into(),
                "llm:generate".into(),
                "artifact:write".into(),
            ],
            defaults: WorkflowDefaults {
                llm_profile_ref: "claude-code-oauth-local".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "check-urls".into(),
                    name: "Check URLs".into(),
                    provider: "http_probe".into(),
                    action: "check_urls".into(),
                    depends_on: vec![],
                    permissions: vec!["network:read".into()],
                    inputs: serde_json::json!({ "urls": ["https://example.com"] }),
                    llm_profile_ref: None,
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::AgentTask,
                    id: "summarize".into(),
                    name: "Summarize URL results".into(),
                    provider: "agent".into(),
                    action: "run_task".into(),
                    depends_on: vec!["check-urls".into()],
                    permissions: vec!["llm:generate".into()],
                    inputs: serde_json::json!({
                        "objective": "Summarize the deterministic URL check results from $steps.check-urls.results.",
                        "output_schema": "artifact_envelope",
                        "allowed_tools": []
                    }),
                    llm_profile_ref: Some("claude-code-oauth-local".into()),
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "write-artifact".into(),
                    name: "Save summary artifact".into(),
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
        }
    }

    fn agent_weather_workflow() -> RavenWorkflow {
        RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "agent-weather".into(),
            name: "Agent Weather".into(),
            description: "Asks an agent for the current Denver weather and stores the result."
                .into(),
            permissions: vec![
                "llm:generate".into(),
                "network:read".into(),
                "artifact:write".into(),
            ],
            defaults: WorkflowDefaults {
                llm_profile_ref: "claude-code-oauth-local".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::AgentTask,
                    id: "ask-ai".into(),
                    name: "Ask AI".into(),
                    provider: "agent".into(),
                    action: "run_task".into(),
                    depends_on: vec![],
                    permissions: vec!["llm:generate".into(), "network:read".into()],
                    inputs: serde_json::json!({
                        "objective": "What's the weather today in Denver?",
                        "output_schema": "artifact_envelope",
                        "allowed_tools": ["web"]
                    }),
                    llm_profile_ref: Some("claude-code-oauth-local".into()),
                    destination_ref: None,
                    inline_code: None,
                    parallel: None,
                },
                WorkflowStepDefinition {
                    kind: WorkflowStepKind::ProviderAction,
                    id: "write-artifact".into(),
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
            ],
        }
    }

    fn plugin_manifest() -> crate::plugins::PluginManifest {
        crate::plugins::PluginManifest {
            id: "deterministic_artifact".into(),
            name: "Deterministic Artifact".into(),
            version: "0.1.0".into(),
            description: "Builds deterministic test artifacts.".into(),
            steps: vec![crate::plugins::PluginStepDefinition {
                kind: "provider_action".into(),
                provider: "deterministic_artifact".into(),
                action: "build_artifact".into(),
                display_name: "Build artifact".into(),
                permissions: vec!["plugin:execute".into()],
                input_schema: serde_json::json!({ "type": "object" }),
                output_schema: serde_json::json!({ "type": "object" }),
                execution: crate::plugins::PluginExecutionConfig {
                    command: "bin/deterministic-artifact-plugin".into(),
                    args: vec![],
                    env: HashMap::new(),
                    timeout_ms: Some(5_000),
                },
            }],
            plugin_dir: None,
        }
    }

    fn overlapping_plugin_manifest() -> crate::plugins::PluginManifest {
        let mut manifest = plugin_manifest();
        manifest.id = "overlap_plugin".into();
        manifest.steps[0].provider = "registry_only".into();
        manifest.steps[0].action = "inspect".into();
        manifest.steps[0].permissions = vec!["plugin:execute".into()];
        manifest
    }

    fn registry_capability(provider: &str, action: &str) -> CapabilityDescriptor {
        let mut capability = crate::capability_registry::descriptor_from_static_capability(
            capability_for("seo", "audit_metadata").unwrap(),
        );
        capability.id = format!("{provider}.{action}");
        capability.provider = provider.into();
        capability.action = action.into();
        capability.source = crate::models::CapabilitySource::Cli;
        capability.status = crate::models::CapabilityAvailability::Available;
        capability.deterministic = true;
        capability.permissions = vec!["data:read".into()];
        capability.adapter = crate::models::CapabilityAdapter::Native {
            handler: format!("{provider}.{action}"),
        };
        capability
    }

    fn test_registry(
        mut capabilities: Vec<CapabilityDescriptor>,
    ) -> crate::capability_registry::CapabilityRegistrySnapshot {
        capabilities.push(
            crate::capability_registry::descriptor_from_static_capability(
                capability_for("local_app", "write_artifact").unwrap(),
            ),
        );
        crate::capability_registry::CapabilityRegistrySnapshot {
            hash: "test-registry".into(),
            generated_at: "2026-06-21T00:00:00Z".into(),
            capabilities,
            policy_decisions: vec![],
        }
    }

    fn empty_test_registry() -> crate::capability_registry::CapabilityRegistrySnapshot {
        crate::capability_registry::CapabilityRegistrySnapshot {
            hash: "empty-test-registry".into(),
            generated_at: "2026-06-21T00:00:00Z".into(),
            capabilities: vec![],
            policy_decisions: vec![],
        }
    }

    fn plugin_artifact_workflow() -> RavenWorkflow {
        RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "plugin-artifact".into(),
            name: "Plugin Artifact".into(),
            description: "Builds an artifact with a deterministic plugin.".into(),
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
                    name: "Build artifact".into(),
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
        }
    }

    fn registry_inspect_workflow(with_sink: bool) -> RavenWorkflow {
        let mut steps = vec![WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "inspect".into(),
            name: "Inspect".into(),
            provider: "registry_only".into(),
            action: "inspect".into(),
            depends_on: vec![],
            permissions: vec!["data:read".into()],
            inputs: serde_json::json!({}),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        }];
        let mut permissions = vec!["data:read".into()];
        if with_sink {
            permissions.push("artifact:write".into());
            steps.push(WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "write-artifact".into(),
                name: "Save artifact".into(),
                provider: "local_app".into(),
                action: "write_artifact".into(),
                depends_on: vec!["inspect".into()],
                permissions: vec!["artifact:write".into()],
                inputs: serde_json::json!({ "artifact": "$steps.inspect.artifact" }),
                llm_profile_ref: None,
                destination_ref: Some("local-app".into()),
                inline_code: None,
                parallel: None,
            });
        }

        RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "registry-inspect".into(),
            name: "Registry Inspect".into(),
            description: "Validates registry-backed provider action behavior.".into(),
            permissions,
            defaults: WorkflowDefaults {
                llm_profile_ref: "default-openai".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps,
        }
    }
}
