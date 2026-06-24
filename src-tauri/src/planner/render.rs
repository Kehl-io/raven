use std::collections::HashSet;

use crate::capabilities::capability_for;
use crate::models::{
    RavenWorkflow, WorkflowDefaults, WorkflowScheduleDefinition, WorkflowStepDefinition,
    WorkflowStepKind,
};
use crate::planner::operations::{OperationKind, OperationPlan, OperationStatus};

pub fn render_workflow(prompt: &str, mapped_plan: &OperationPlan) -> Result<RavenWorkflow, String> {
    let mut steps: Vec<WorkflowStepDefinition> = Vec::new();
    let mut seen_step_ids = HashSet::new();

    for operation in &mapped_plan.operations {
        match operation.status {
            OperationStatus::Covered => {
                let Some(step_id) = operation.step_id.as_deref() else {
                    return Err(format!(
                        "Covered operation {:?} is missing a step id.",
                        operation.kind
                    ));
                };
                if !seen_step_ids.insert(step_id.to_owned()) {
                    continue;
                }
                let step = match operation.kind {
                    OperationKind::ParseCsv => build_provider_step(
                        "data",
                        "parse_csv",
                        "parse-csv",
                        "Parse CSV",
                        vec![],
                        serde_json::json!({
                            "content": csv_content_from_prompt(prompt),
                            "has_headers": true
                        }),
                    )?,
                    OperationKind::TransformFilter
                    | OperationKind::TransformSort
                    | OperationKind::TransformProject
                    | OperationKind::TransformLimit => {
                        let depends_on = if steps.iter().any(|step| step.id == "parse-csv") {
                            vec!["parse-csv".into()]
                        } else {
                            vec![]
                        };
                        build_provider_step(
                            "data",
                            "transform_json",
                            "transform-data",
                            "Transform data",
                            depends_on,
                            data_transform_inputs(
                                prompt,
                                steps.iter().any(|step| step.id == "parse-csv"),
                            ),
                        )?
                    }
                    OperationKind::CollectWebPage => {
                        let Some(url) = select_web_url(prompt) else {
                            continue;
                        };
                        build_provider_step(
                            "web",
                            "fetch_page",
                            "fetch-page",
                            "Fetch page",
                            vec![],
                            serde_json::json!({ "url": url, "max_bytes": 524288 }),
                        )?
                    }
                    OperationKind::ExtractArticle => {
                        let Some(url) = select_web_url(prompt) else {
                            continue;
                        };
                        build_provider_step(
                            "web",
                            "extract_article",
                            "extract-article",
                            "Extract article",
                            vec!["fetch-page".into()],
                            serde_json::json!({
                                "body_text": "$steps.fetch-page.body_text",
                                "url": url
                            }),
                        )?
                    }
                    OperationKind::ExtractMetadata => {
                        let Some(url) = select_web_url(prompt) else {
                            continue;
                        };
                        build_provider_step(
                            "web",
                            "extract_metadata",
                            "extract-metadata",
                            "Extract metadata",
                            vec!["fetch-page".into()],
                            serde_json::json!({
                                "body_text": "$steps.fetch-page.body_text",
                                "url": url
                            }),
                        )?
                    }
                    OperationKind::CollectRssFeed => {
                        let Some(url) = select_feed_url(prompt) else {
                            continue;
                        };
                        build_provider_step(
                            "rss",
                            "fetch_feed",
                            "feed",
                            "Fetch feed",
                            vec![],
                            serde_json::json!({ "url": url, "max_items": 10 }),
                        )?
                    }
                    OperationKind::CollectWeather => build_provider_step(
                        "weather",
                        "forecast_24h",
                        "weather",
                        "Fetch weather",
                        vec![],
                        weather_inputs(prompt),
                    )?,
                    OperationKind::CollectNews => {
                        if operation.capability_id.as_deref() == Some("news.search") {
                            build_provider_step(
                                "news",
                                "search",
                                "news-search",
                                "Search news",
                                vec![],
                                news_search_inputs(operation),
                            )?
                        } else {
                            build_provider_step(
                                "news",
                                "trending",
                                "news",
                                "Fetch news",
                                vec![],
                                serde_json::json!({ "max_items": 5 }),
                            )?
                        }
                    }
                    OperationKind::ValidateJsonLd => build_provider_step(
                        "seo",
                        "validate_json_ld",
                        "validate-json-ld",
                        "Validate JSON-LD",
                        vec![],
                        serde_json::json!({ "json_ld": json_ld_payload_from_prompt(prompt) }),
                    )?,
                    OperationKind::PrepareSearchIntent => {
                        let topic = content_topic(prompt);
                        build_provider_step(
                            "content",
                            "map_search_intent",
                            "map-search-intent",
                            "Map search intent",
                            vec![],
                            serde_json::json!({
                                "topic": topic,
                                "audience": audience_from_prompt(prompt),
                                "page_type": page_type_from_prompt(&prompt.to_ascii_lowercase()),
                                "business_goal": business_goal_from_prompt(&prompt.to_ascii_lowercase()),
                            }),
                        )?
                    }
                    OperationKind::PrepareContentBrief => {
                        let source_step_ids = deterministic_source_step_ids(&steps);
                        let source_refs = deterministic_source_refs(&steps);
                        let topic = content_topic(prompt);
                        let mut depends_on =
                            if steps.iter().any(|step| step.id == "map-search-intent") {
                                vec!["map-search-intent".into()]
                            } else {
                                vec![]
                            };
                        depends_on.extend(source_step_ids);
                        build_provider_step(
                            "content",
                            "generate_brief",
                            "generate-brief",
                            "Generate content brief",
                            unique_strings(depends_on),
                            serde_json::json!({
                                "topic": topic,
                                "audience": audience_from_prompt(prompt),
                                "page_type": page_type_from_prompt(&prompt.to_ascii_lowercase()),
                                "sources": source_refs,
                            }),
                        )?
                    }
                    _ => {
                        return Err(format!(
                            "Planner renderer does not support covered operation {:?}.",
                            operation.kind
                        ))
                    }
                };
                steps.push(step);
            }
            OperationStatus::AgentRequired => continue,
            OperationStatus::Requested
            | OperationStatus::Unsupported
            | OperationStatus::Blocked => {
                return Err(format!(
                    "Planner renderer cannot build workflow with operation {:?} in status {:?}.",
                    operation.kind, operation.status
                ));
            }
        }
    }

    if steps.is_empty() {
        return Err("Planner did not produce any deterministic capability steps.".into());
    }

    Ok(finalize_workflow(prompt, steps))
}

fn build_provider_step(
    provider: &str,
    action: &str,
    id: &str,
    fallback_name: &str,
    depends_on: Vec<String>,
    inputs: serde_json::Value,
) -> Result<WorkflowStepDefinition, String> {
    let capability = capability_for(provider, action).ok_or_else(|| {
        format!("Capability {provider}.{action} is unavailable for planner rendering.")
    })?;

    Ok(WorkflowStepDefinition {
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
    })
}

fn finalize_workflow(prompt: &str, mut steps: Vec<WorkflowStepDefinition>) -> RavenWorkflow {
    let metadata = metadata_for_steps(&steps);
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

struct WorkflowMetadata {
    id_prefix: &'static str,
    name: &'static str,
    description: &'static str,
}

fn metadata_for_steps(steps: &[WorkflowStepDefinition]) -> WorkflowMetadata {
    let family_count = family_presence(steps)
        .into_iter()
        .filter(|present| *present)
        .count();
    if family_count > 1 {
        return WorkflowMetadata {
            id_prefix: "deterministic-workflow",
            name: "Deterministic Workflow",
            description:
                "Runs the requested deterministic provider operations before writing a final artifact.",
        };
    }

    let has_web = steps.iter().any(|step| step.provider == "web");
    let has_seo = steps.iter().any(|step| step.provider == "seo");
    let has_data = steps.iter().any(|step| step.provider == "data");
    let has_rss = steps.iter().any(|step| step.provider == "rss");
    let has_content = steps.iter().any(|step| step.provider == "content");
    let has_weather = steps
        .iter()
        .any(|step| matches!(step.provider.as_str(), "weather" | "open_meteo"));
    let has_news = steps.iter().any(|step| step.provider == "news");

    let has_csv_parse = steps
        .iter()
        .any(|step| step.provider == "data" && step.action == "parse_csv");
    let has_data_transform = steps
        .iter()
        .any(|step| step.provider == "data" && step.action == "transform_json");

    if has_data && has_data_transform && !has_csv_parse {
        WorkflowMetadata {
            id_prefix: "data-transformation",
            name: "Data Transformation Summary",
            description: "Transforms available structured data before writing a concise summary.",
        }
    } else if has_data {
        WorkflowMetadata {
            id_prefix: "data-summary",
            name: "CSV Data Summary",
            description:
                "Parses and shapes deterministic CSV data before writing a concise summary.",
        }
    } else if has_seo {
        WorkflowMetadata {
            id_prefix: "json-ld-validation",
            name: "JSON-LD Validation",
            description: "Validates a JSON-LD payload before writing a concise validation summary.",
        }
    } else if has_rss {
        WorkflowMetadata {
            id_prefix: "feed-summary",
            name: "Feed Summary",
            description: "Fetches a deterministic feed before writing a concise summary.",
        }
    } else if has_content {
        WorkflowMetadata {
            id_prefix: "content-research-draft",
            name: "Content Research Draft",
            description:
                "Prepares deterministic content research and a brief before drafting final prose.",
        }
    } else if has_weather && has_news {
        WorkflowMetadata {
            id_prefix: "weather-news-brief",
            name: "Weather and News Brief",
            description:
                "Collects deterministic weather and news data before writing a planning brief.",
        }
    } else if has_weather {
        WorkflowMetadata {
            id_prefix: "weather-brief",
            name: "Weather Brief",
            description: "Fetches deterministic weather data before writing a concise brief.",
        }
    } else if has_news {
        WorkflowMetadata {
            id_prefix: "news-brief",
            name: "News Brief",
            description: "Collects deterministic news data before writing a concise brief.",
        }
    } else if has_web
        && steps.iter().any(|step| step.action == "extract_metadata")
        && !steps.iter().any(|step| step.action == "extract_article")
    {
        WorkflowMetadata {
            id_prefix: "web-metadata-extraction",
            name: "Web Metadata Extraction",
            description:
                "Fetches a page and extracts deterministic metadata before writing a summary.",
        }
    } else {
        WorkflowMetadata {
            id_prefix: "web-research-summary",
            name: "Web Research Summary",
            description:
                "Fetches and extracts deterministic web evidence before writing a summary.",
        }
    }
}

fn family_presence(steps: &[WorkflowStepDefinition]) -> [bool; 6] {
    [
        steps.iter().any(|step| step.provider == "web"),
        steps.iter().any(|step| step.provider == "seo"),
        steps.iter().any(|step| step.provider == "data"),
        steps.iter().any(|step| step.provider == "rss"),
        steps.iter().any(|step| step.provider == "content"),
        steps
            .iter()
            .any(|step| matches!(step.provider.as_str(), "weather" | "open_meteo" | "news")),
    ]
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn data_transform_inputs(prompt: &str, has_parse_csv_step: bool) -> serde_json::Value {
    let mut inputs = if has_parse_csv_step {
        serde_json::json!({ "data": "$steps.parse-csv.rows" })
    } else {
        serde_json::json!({ "data": structured_data_from_prompt(prompt) })
    };
    if let Some((field, value)) = filter_equals_from_prompt(prompt) {
        inputs["filter_equals"] = serde_json::json!({ field: value });
    }
    if let Some(select_fields) = select_fields_from_prompt(prompt) {
        inputs["select_fields"] = serde_json::json!(select_fields);
    }
    if let Some(sort_by) = value_after_any_phrase(
        prompt,
        &[
            "sort by",
            "sorting by",
            "sorted by",
            "order by",
            "ordered by",
        ],
    ) {
        inputs["sort_by"] = serde_json::json!(sort_by);
    }
    if let Some(limit) = numeric_value_after_any(prompt, &["limit", "limiting to", "top", "first"])
    {
        inputs["limit"] = serde_json::json!(limit);
    }
    inputs
}

fn filter_equals_from_prompt(prompt: &str) -> Option<(String, String)> {
    let after_filter =
        tail_after_any_case_insensitive(prompt, &["filtering ", "filter ", "where "])?;
    let (field, value) = filter_equals_from_tail(after_filter)?;
    let field = clean_identifier(field);
    let value = clean_identifier(value);
    if field.is_empty() || value.is_empty() {
        None
    } else {
        Some((field, value))
    }
}

fn filter_equals_from_tail(tail: &str) -> Option<(&str, &str)> {
    if let Some(token) = tail.split_whitespace().find(|token| token.contains('=')) {
        return token.split_once('=');
    }

    let (left, right) = tail.split_once('=')?;
    let field = left.split_whitespace().last()?;
    let value = right.split_whitespace().next()?;
    Some((field, value))
}

fn select_fields_from_prompt(prompt: &str) -> Option<Vec<String>> {
    let tail = tail_after_any_case_insensitive(
        prompt,
        &[
            "select ",
            "projecting ",
            "project ",
            "projection ",
            "fields ",
            "columns ",
            "keep only ",
        ],
    )?;
    let stop_words = [
        "then",
        "summarize",
        "summary",
        "report",
        "sort",
        "sorting",
        "filter",
        "filtering",
        "limit",
        "limiting",
        "limited",
        "top",
        "first",
        "where",
        "from",
    ];
    let skip_words = ["field", "fields", "column", "columns", "only", "and"];
    let mut fields = Vec::new();
    for token in tail.split(|character: char| {
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

fn value_after_any_phrase(prompt: &str, phrases: &[&str]) -> Option<String> {
    phrases
        .iter()
        .filter_map(|phrase| value_after_phrase(prompt, phrase))
        .next()
}

fn numeric_value_after_any(prompt: &str, phrases: &[&str]) -> Option<u64> {
    phrases.iter().find_map(|phrase| {
        let tail = tail_after_case_insensitive(prompt, phrase)?;
        tail.split(|character: char| !character.is_ascii_digit())
            .find(|token| !token.is_empty())
            .and_then(|token| token.parse::<u64>().ok())
    })
}

fn structured_data_from_prompt(prompt: &str) -> serde_json::Value {
    json_value_candidates(prompt)
        .into_iter()
        .filter_map(|candidate| serde_json::from_str::<serde_json::Value>(candidate).ok())
        .find(|value| value.is_array() || value.is_object())
        .unwrap_or_else(|| serde_json::json!({ "source": "provided_structured_records" }))
}

fn json_value_candidates(prompt: &str) -> Vec<&str> {
    let mut candidates = Vec::new();
    let mut start = None;
    let mut stack = Vec::new();
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
            '{' | '[' => {
                if stack.is_empty() {
                    start = Some(index);
                }
                stack.push(character);
            }
            '}' | ']' => {
                let Some(open) = stack.pop() else {
                    continue;
                };
                if !matches!((open, character), ('{', '}') | ('[', ']')) {
                    start = None;
                    stack.clear();
                    continue;
                }
                if stack.is_empty() {
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

fn content_topic(prompt: &str) -> String {
    let first_line = prompt.lines().next().unwrap_or(prompt).trim();
    if let Some((_, topic)) = first_line.split_once(" for ") {
        topic.trim().trim_end_matches('.').to_string()
    } else if let Some((_, topic)) = first_line.split_once(" about ") {
        topic.trim().trim_end_matches('.').to_string()
    } else {
        first_line.trim_end_matches('.').to_string()
    }
}

fn weather_inputs(prompt: &str) -> serde_json::Value {
    serde_json::json!({ "location": location_from_prompt(prompt), "hours": 24 })
}

fn news_search_inputs(
    operation: &crate::planner::operations::PlannedOperation,
) -> serde_json::Value {
    serde_json::json!({
        "query": operation.inputs["query"].as_str().unwrap_or("news"),
        "max_items": 5
    })
}

fn location_from_prompt(prompt: &str) -> &'static str {
    let normalized = prompt.to_ascii_lowercase();
    if normalized.contains("denver") {
        "Denver, CO"
    } else {
        "Denver, CO"
    }
}

fn audience_from_prompt(prompt: &str) -> &'static str {
    let normalized = prompt.to_ascii_lowercase();
    if normalized.contains("founder") || normalized.contains("executive") {
        "decision makers"
    } else if normalized.contains("developer") || normalized.contains("engineer") {
        "technical practitioners"
    } else {
        "general audience"
    }
}

fn page_type_from_prompt(normalized: &str) -> &'static str {
    if normalized.contains("service page") {
        "service_page"
    } else if normalized.contains("landing page") {
        "landing_page"
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
    deterministic_source_step_ids(steps)
        .into_iter()
        .map(|step| serde_json::json!({ "step": step }))
        .collect()
}

fn deterministic_source_step_ids(steps: &[WorkflowStepDefinition]) -> Vec<String> {
    unique_strings(
        steps
            .iter()
            .filter(|step| {
                step.provider == "web" || step.provider == "seo" || step.provider == "rss"
            })
            .map(|step| step.id.clone())
            .collect(),
    )
}

fn select_feed_url(prompt: &str) -> Option<String> {
    crate::planner::extract::detected_urls(prompt)
        .into_iter()
        .find(|url| is_feed_url(url))
}

fn select_web_url(prompt: &str) -> Option<String> {
    let urls = crate::planner::extract::detected_urls(prompt);
    urls.into_iter().find(|url| !is_feed_url(url))
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

fn stable_prompt_hash(prompt: &str) -> String {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    prompt.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::operations::{
        OperationKind, OperationPlan, OperationStatus, PlannedOperation,
    };

    #[test]
    fn content_brief_depends_on_rendered_source_steps() {
        let plan = OperationPlan {
            prompt: "Analyze https://example.com/article and write a content brief.".into(),
            operations: vec![
                PlannedOperation {
                    id: "op-fetch".into(),
                    kind: OperationKind::CollectWebPage,
                    status: OperationStatus::Covered,
                    evidence: "Prompt includes a web page URL.".into(),
                    capability_id: Some("web.fetch_page".into()),
                    step_id: Some("fetch-page".into()),
                    inputs: serde_json::json!({ "url": "https://example.com/article" }),
                },
                PlannedOperation {
                    id: "op-map-search-intent".into(),
                    kind: OperationKind::PrepareSearchIntent,
                    status: OperationStatus::Covered,
                    evidence: "Prompt asks for content intent planning.".into(),
                    capability_id: Some("content.map_search_intent".into()),
                    step_id: Some("map-search-intent".into()),
                    inputs: serde_json::json!({ "topic": "article" }),
                },
                PlannedOperation {
                    id: "op-generate-brief".into(),
                    kind: OperationKind::PrepareContentBrief,
                    status: OperationStatus::Covered,
                    evidence: "Prompt asks for a content brief.".into(),
                    capability_id: Some("content.generate_brief".into()),
                    step_id: Some("generate-brief".into()),
                    inputs: serde_json::json!({ "topic": "article" }),
                },
            ],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let brief = workflow
            .steps
            .iter()
            .find(|step| step.id == "generate-brief")
            .expect("brief step should exist");

        assert_eq!(
            brief.inputs["sources"],
            serde_json::json!([{ "step": "fetch-page" }])
        );
        assert_eq!(brief.depends_on, vec!["map-search-intent", "fetch-page"]);
    }

    #[test]
    fn rendered_where_clause_sets_transform_filter_equals() {
        let plan = OperationPlan {
            prompt:
                "Parse this CSV, where status=active, then summarize.\nname,status\nAcme,active"
                    .into(),
            operations: vec![
                PlannedOperation {
                    id: "op-parse-csv".into(),
                    kind: OperationKind::ParseCsv,
                    status: OperationStatus::Covered,
                    evidence: "Prompt mentions CSV parsing.".into(),
                    capability_id: Some("data.parse_csv".into()),
                    step_id: Some("parse-csv".into()),
                    inputs: serde_json::json!({}),
                },
                PlannedOperation {
                    id: "op-transform-filter".into(),
                    kind: OperationKind::TransformFilter,
                    status: OperationStatus::Covered,
                    evidence: "Prompt requests filtering.".into(),
                    capability_id: Some("data.transform_json".into()),
                    step_id: Some("transform-data".into()),
                    inputs: serde_json::json!({}),
                },
                PlannedOperation {
                    id: "op-synthesize".into(),
                    kind: OperationKind::SynthesizeMarkdownArtifact,
                    status: OperationStatus::AgentRequired,
                    evidence: "Prompt requests final written output.".into(),
                    capability_id: None,
                    step_id: Some("summarize".into()),
                    inputs: serde_json::json!({}),
                },
            ],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let transform = workflow
            .steps
            .iter()
            .find(|step| step.id == "transform-data")
            .expect("transform step should exist");

        assert_eq!(
            transform.inputs["filter_equals"],
            serde_json::json!({ "status": "active" })
        );
    }

    #[test]
    fn rendered_transform_inputs_preserve_prompt_case() {
        let plan = OperationPlan {
            prompt: "Parse this CSV, filter Status=Active, sort by Revenue, select Name,Revenue, then summarize.\nName,Status,Revenue\nAcme,Active,42".into(),
            operations: vec![
                PlannedOperation {
                    id: "op-parse-csv".into(),
                    kind: OperationKind::ParseCsv,
                    status: OperationStatus::Covered,
                    evidence: "Prompt mentions CSV parsing.".into(),
                    capability_id: Some("data.parse_csv".into()),
                    step_id: Some("parse-csv".into()),
                    inputs: serde_json::json!({}),
                },
                PlannedOperation {
                    id: "op-transform-filter".into(),
                    kind: OperationKind::TransformFilter,
                    status: OperationStatus::Covered,
                    evidence: "Prompt requests filtering.".into(),
                    capability_id: Some("data.transform_json".into()),
                    step_id: Some("transform-data".into()),
                    inputs: serde_json::json!({}),
                },
            ],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let transform = workflow
            .steps
            .iter()
            .find(|step| step.id == "transform-data")
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
    fn rendered_transform_inputs_preserve_mixed_case_fields_and_values() {
        let plan = OperationPlan {
            prompt: "Parse this CSV, FILTER Status=Active, SELECT Name,Revenue, SORT BY Revenue, then summarize.\nName,Status,Revenue\nAcme,Active,42".into(),
            operations: vec![
                PlannedOperation {
                    id: "op-parse-csv".into(),
                    kind: OperationKind::ParseCsv,
                    status: OperationStatus::Covered,
                    evidence: "Prompt mentions CSV parsing.".into(),
                    capability_id: Some("data.parse_csv".into()),
                    step_id: Some("parse-csv".into()),
                    inputs: serde_json::json!({}),
                },
                PlannedOperation {
                    id: "op-transform-filter".into(),
                    kind: OperationKind::TransformFilter,
                    status: OperationStatus::Covered,
                    evidence: "Prompt requests filtering.".into(),
                    capability_id: Some("data.transform_json".into()),
                    step_id: Some("transform-data".into()),
                    inputs: serde_json::json!({}),
                },
            ],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let transform = workflow
            .steps
            .iter()
            .find(|step| step.id == "transform-data")
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
    fn rendered_parse_csv_skips_comma_instruction_line() {
        let plan = OperationPlan {
            prompt: "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42".into(),
            operations: vec![PlannedOperation {
                id: "op-parse-csv".into(),
                kind: OperationKind::ParseCsv,
                status: OperationStatus::Covered,
                evidence: "Prompt mentions CSV parsing.".into(),
                capability_id: Some("data.parse_csv".into()),
                step_id: Some("parse-csv".into()),
                inputs: serde_json::json!({}),
            }],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let parse_csv = workflow
            .steps
            .iter()
            .find(|step| step.id == "parse-csv")
            .expect("parse CSV step should exist");

        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!("name,status,revenue\nAcme,active,42")
        );
    }

    #[test]
    fn rendered_csv_content_skips_comma_instruction_prose() {
        let plan = OperationPlan {
            prompt: "Parse this CSV, filter active rows, select name,revenue.\nname,status,revenue\nAcme,active,42\nBeta,inactive,9".into(),
            operations: vec![
                PlannedOperation {
                    id: "op-parse-csv".into(),
                    kind: OperationKind::ParseCsv,
                    status: OperationStatus::Covered,
                    evidence: "Prompt mentions CSV parsing.".into(),
                    capability_id: Some("data.parse_csv".into()),
                    step_id: Some("parse-csv".into()),
                    inputs: serde_json::json!({}),
                },
                PlannedOperation {
                    id: "op-synthesize".into(),
                    kind: OperationKind::SynthesizeMarkdownArtifact,
                    status: OperationStatus::AgentRequired,
                    evidence: "Prompt requests final written output.".into(),
                    capability_id: None,
                    step_id: Some("summarize".into()),
                    inputs: serde_json::json!({}),
                },
            ],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let parse_csv = workflow
            .steps
            .iter()
            .find(|step| step.id == "parse-csv")
            .expect("parse-csv step should exist");

        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!("name,status,revenue\nAcme,active,42\nBeta,inactive,9")
        );
    }

    #[test]
    fn rendered_parse_csv_extracts_inline_header_after_csv_label() {
        let plan = OperationPlan {
            prompt: "Parse this CSV: name,status\nAcme,active".into(),
            operations: vec![PlannedOperation {
                id: "op-parse-csv".into(),
                kind: OperationKind::ParseCsv,
                status: OperationStatus::Covered,
                evidence: "Prompt mentions CSV parsing.".into(),
                capability_id: Some("data.parse_csv".into()),
                step_id: Some("parse-csv".into()),
                inputs: serde_json::json!({}),
            }],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let parse_csv = workflow
            .steps
            .iter()
            .find(|step| step.id == "parse-csv")
            .expect("parse CSV step should exist");

        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!("name,status\nAcme,active")
        );
    }

    #[test]
    fn rendered_parse_csv_stops_before_json_ld_payload() {
        let plan = OperationPlan {
            prompt: r#"Create a deterministic QA workflow: parse this CSV, select name, then validate this JSON-LD payload and summarize both results.
name,status
Acme,active
{"@context":"https://schema.org","@type":"FAQPage"}"#
                .into(),
            operations: vec![PlannedOperation {
                id: "op-parse-csv".into(),
                kind: OperationKind::ParseCsv,
                status: OperationStatus::Covered,
                evidence: "Prompt mentions CSV parsing.".into(),
                capability_id: Some("data.parse_csv".into()),
                step_id: Some("parse-csv".into()),
                inputs: serde_json::json!({}),
            }],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let parse_csv = workflow
            .steps
            .iter()
            .find(|step| step.id == "parse-csv")
            .expect("parse CSV step should exist");

        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!("name,status\nAcme,active")
        );
    }

    #[test]
    fn rendered_json_ld_uses_schema_object_after_json_shaped_csv_field() {
        let plan = OperationPlan {
            prompt: r#"Create a deterministic QA workflow: parse this CSV, select name, then validate this JSON-LD payload and summarize both results.
name,notes
Acme,"{""draft"":true}"
{"@context":"https://schema.org","@type":"FAQPage"}"#
                .into(),
            operations: vec![
                PlannedOperation {
                    id: "op-parse-csv".into(),
                    kind: OperationKind::ParseCsv,
                    status: OperationStatus::Covered,
                    evidence: "Prompt mentions CSV parsing.".into(),
                    capability_id: Some("data.parse_csv".into()),
                    step_id: Some("parse-csv".into()),
                    inputs: serde_json::json!({}),
                },
                PlannedOperation {
                    id: "op-validate-json-ld".into(),
                    kind: OperationKind::ValidateJsonLd,
                    status: OperationStatus::Covered,
                    evidence: "Prompt requests JSON-LD validation.".into(),
                    capability_id: Some("seo.validate_json_ld".into()),
                    step_id: Some("validate-json-ld".into()),
                    inputs: serde_json::json!({}),
                },
            ],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let validate_json_ld = workflow
            .steps
            .iter()
            .find(|step| step.id == "validate-json-ld")
            .expect("validate JSON-LD step should exist");

        assert_eq!(
            validate_json_ld.inputs["json_ld"],
            serde_json::json!({"@context":"https://schema.org","@type":"FAQPage"})
        );
    }

    #[test]
    fn rendered_json_ld_uses_first_valid_object_when_schema_keys_are_absent() {
        let plan = OperationPlan {
            prompt: r#"Validate this JSON-LD payload and summarize errors: {"headline":"Example"}"#
                .into(),
            operations: vec![PlannedOperation {
                id: "op-validate-json-ld".into(),
                kind: OperationKind::ValidateJsonLd,
                status: OperationStatus::Covered,
                evidence: "Prompt requests JSON-LD validation.".into(),
                capability_id: Some("seo.validate_json_ld".into()),
                step_id: Some("validate-json-ld".into()),
                inputs: serde_json::json!({}),
            }],
            warnings: vec![],
        };

        let workflow = render_workflow(&plan.prompt, &plan).expect("workflow should render");
        let validate_json_ld = workflow
            .steps
            .iter()
            .find(|step| step.id == "validate-json-ld")
            .expect("validate JSON-LD step should exist");

        assert_eq!(
            validate_json_ld.inputs["json_ld"],
            serde_json::json!({"headline":"Example"})
        );
    }

    #[test]
    fn rendered_content_brief_workflow_keeps_agent_tools_disabled() {
        let prompt =
            "Create a content brief for https://example.com using content.generate_brief, then draft final copy.";
        let mapped = crate::planner::map::map_operations_to_capabilities(
            crate::planner::extract::extract_operations(prompt),
        )
        .expect("plan should map");

        let workflow = render_workflow(prompt, &mapped).expect("workflow should render");
        let brief = workflow
            .steps
            .iter()
            .find(|step| step.provider == "content" && step.action == "generate_brief")
            .expect("content brief step should exist");
        let summarize = workflow
            .steps
            .iter()
            .find(|step| step.id == "summarize")
            .expect("summarize step should exist");

        assert_eq!(brief.depends_on, vec!["map-search-intent", "fetch-page"]);
        assert_eq!(summarize.inputs["allowed_tools"], serde_json::json!([]));
    }

    #[test]
    fn rendered_explicit_news_search_uses_query_input() {
        let prompt =
            "Create a brief: news.search AI regulation updates, then summarize implications.";
        let mapped = crate::planner::map::map_operations_to_capabilities(
            crate::planner::extract::extract_operations(prompt),
        )
        .expect("plan should map");

        let workflow = render_workflow(prompt, &mapped).expect("workflow should render");
        let news = workflow
            .steps
            .iter()
            .find(|step| step.id == "news-search")
            .expect("news search step should exist");

        assert_eq!(workflow.name, "News Brief");
        assert_eq!(news.provider, "news");
        assert_eq!(news.action, "search");
        assert_eq!(news.inputs["query"], "AI regulation updates");
        assert_eq!(news.inputs["max_items"], 5);
    }

    #[test]
    fn rendered_web_steps_use_collectable_url_after_structured_payload_url() {
        let prompt = r#"Create a metadata report from this payload and page:
{"source":"https://example.com/embedded"}
Fetch https://example.com/real-page and extract title metadata."#;
        let mapped = crate::planner::map::map_operations_to_capabilities(
            crate::planner::extract::extract_operations(prompt),
        )
        .expect("plan should map");

        let workflow = render_workflow(prompt, &mapped).expect("workflow should render");
        let fetch_page = workflow
            .steps
            .iter()
            .find(|step| step.id == "fetch-page")
            .expect("fetch page step should exist");
        let extract_metadata = workflow
            .steps
            .iter()
            .find(|step| step.id == "extract-metadata")
            .expect("extract metadata step should exist");

        assert_eq!(
            fetch_page.inputs["url"],
            serde_json::json!("https://example.com/real-page")
        );
        assert_eq!(
            extract_metadata.inputs["url"],
            serde_json::json!("https://example.com/real-page")
        );
    }
}
