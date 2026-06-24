use crate::capabilities::{capability_catalog, Capability};
use crate::planner::operations::{OperationKind, OperationPlan, OperationStatus, PlannedOperation};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::capability_catalog;
    use crate::planner::extract::extract_operations;

    #[test]
    fn maps_csv_transform_operations_to_parse_then_transform_steps() {
        let plan = extract_operations(
            "Parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42",
        );
        let mapped = map_operations_to_capabilities(plan).unwrap();

        let covered = mapped
            .operations
            .iter()
            .filter(|operation| operation.capability_id.is_some())
            .collect::<Vec<_>>();
        assert!(covered
            .iter()
            .any(|operation| operation.capability_id.as_deref() == Some("data.parse_csv")));
        assert!(covered
            .iter()
            .any(|operation| operation.capability_id.as_deref() == Some("data.transform_json")));
    }

    #[test]
    fn maps_json_ld_validation_without_web_fetch() {
        let plan = extract_operations(
            r#"Validate this JSON-LD and summarize errors: {"@context":"https://schema.org","@type":"FAQPage"}"#,
        );
        let mapped = map_operations_to_capabilities(plan).unwrap();
        let capabilities = mapped
            .operations
            .iter()
            .filter_map(|operation| operation.capability_id.as_deref())
            .collect::<Vec<_>>();

        assert!(capabilities.contains(&"seo.validate_json_ld"));
        assert!(!capabilities.contains(&"web.fetch_page"));
    }

    #[test]
    fn maps_explicit_news_search_to_search_capability() {
        let plan = extract_operations(
            "Create a brief: news search for AI regulation updates, then summarize implications.",
        );
        let mapped = map_operations_to_capabilities(plan).unwrap();
        let news = mapped
            .operations
            .iter()
            .find(|operation| operation.kind == OperationKind::CollectNews)
            .expect("news operation should be present");

        assert_eq!(news.capability_id.as_deref(), Some("news.search"));
        assert_eq!(news.step_id.as_deref(), Some("news-search"));
        assert_eq!(news.inputs["query"], "AI regulation updates");
    }

    #[test]
    fn maps_bare_explicit_news_search_to_search_capability() {
        let plan = extract_operations("Create a brief with news.search, then summarize.");
        let mapped = map_operations_to_capabilities(plan).unwrap();
        let news = mapped
            .operations
            .iter()
            .find(|operation| operation.kind == OperationKind::CollectNews)
            .expect("news operation should be present");

        assert_eq!(news.capability_id.as_deref(), Some("news.search"));
        assert_eq!(news.inputs["query"], "news");
    }

    #[test]
    fn blocks_matching_tag_capabilities_when_required_schema_field_is_missing() {
        let mut operation = PlannedOperation {
            id: "op-parse-csv".into(),
            kind: OperationKind::ParseCsv,
            status: OperationStatus::Requested,
            evidence: "Prompt mentions CSV parsing.".into(),
            capability_id: None,
            step_id: None,
            inputs: serde_json::json!({}),
        };
        let mut capability = capability_catalog()
            .into_iter()
            .find(|capability| capability.id == "data.parse_csv")
            .expect("data.parse_csv should exist");
        capability.input_schema = serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["rows"],
            "properties": {
                "rows": { "type": "array" }
            }
        });

        let warning = cover(
            &mut operation,
            &[capability],
            "data.parse_csv",
            "parse-csv",
            "parse.csv",
        );

        assert_eq!(operation.status, OperationStatus::Blocked);
        assert!(operation.capability_id.is_none());
        assert!(operation.step_id.is_none());
        assert!(warning
            .as_deref()
            .unwrap()
            .contains("required input field content"));
    }
}

pub fn map_operations_to_capabilities(mut plan: OperationPlan) -> Result<OperationPlan, String> {
    let catalog = capability_catalog();
    let mut warnings = Vec::new();

    for operation in &mut plan.operations {
        match operation.kind {
            OperationKind::CollectUrlStatus => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "http_probe.check_urls",
                    "check-urls",
                    "collect.url_status",
                ));
            }
            OperationKind::CollectWebPage => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "web.fetch_page",
                    "fetch-page",
                    "collect.web_page",
                ));
            }
            OperationKind::CollectRssFeed => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "rss.fetch_feed",
                    "feed",
                    "collect.rss_feed",
                ));
            }
            OperationKind::CollectWeather => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "weather.forecast_24h",
                    "weather",
                    "collect.weather",
                ));
            }
            OperationKind::CollectNews => {
                if news_search_query(operation).is_some() {
                    warnings.extend(cover_with_required_input_field(
                        operation,
                        &catalog,
                        "news.search",
                        "news-search",
                        "collect.news",
                        Some("query"),
                    ));
                } else {
                    warnings.extend(cover(
                        operation,
                        &catalog,
                        "news.trending",
                        "news",
                        "collect.news",
                    ));
                }
            }
            OperationKind::ParseCsv => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "data.parse_csv",
                    "parse-csv",
                    "parse.csv",
                ));
            }
            OperationKind::ExtractArticle => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "web.extract_article",
                    "extract-article",
                    "extract.article",
                ));
            }
            OperationKind::ExtractMetadata => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "web.extract_metadata",
                    "extract-metadata",
                    "extract.metadata",
                ));
            }
            OperationKind::ValidateJsonLd => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "seo.validate_json_ld",
                    "validate-json-ld",
                    "validate.json_ld",
                ));
            }
            OperationKind::PrepareContentBrief => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "content.generate_brief",
                    "generate-brief",
                    "prepare.content_brief",
                ));
            }
            OperationKind::PrepareSearchIntent => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "content.map_search_intent",
                    "map-search-intent",
                    "prepare.search_intent",
                ));
            }
            OperationKind::TransformFilter => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "data.transform_json",
                    "transform-data",
                    "transform.filter",
                ));
            }
            OperationKind::TransformSort => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "data.transform_json",
                    "transform-data",
                    "transform.sort",
                ));
            }
            OperationKind::TransformProject => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "data.transform_json",
                    "transform-data",
                    "transform.project",
                ));
            }
            OperationKind::TransformLimit => {
                warnings.extend(cover(
                    operation,
                    &catalog,
                    "data.transform_json",
                    "transform-data",
                    "transform.limit",
                ));
            }
            OperationKind::SynthesizeMarkdownArtifact => {
                operation.status = OperationStatus::AgentRequired;
                operation.capability_id = None;
                operation.step_id = Some("summarize".into());
            }
            OperationKind::ExtractLinks | OperationKind::ExtractStructuredData => {
                operation.status = OperationStatus::Unsupported;
                operation.capability_id = None;
                operation.step_id = None;
                warnings.push(format!(
                    "Operation {:?} is not mapped in planner v1.",
                    operation.kind
                ));
            }
        }
    }

    plan.warnings.extend(warnings);
    Ok(plan)
}

fn cover(
    operation: &mut PlannedOperation,
    catalog: &[Capability],
    capability_id: &str,
    step_id: &str,
    operation_tag: &str,
) -> Option<String> {
    cover_with_required_input_field(
        operation,
        catalog,
        capability_id,
        step_id,
        operation_tag,
        expected_required_input_field(operation.kind),
    )
}

fn cover_with_required_input_field(
    operation: &mut PlannedOperation,
    catalog: &[Capability],
    capability_id: &str,
    step_id: &str,
    operation_tag: &str,
    required_input_field: Option<&str>,
) -> Option<String> {
    let Some(capability) = catalog
        .iter()
        .find(|capability| capability.id == capability_id)
    else {
        operation.status = OperationStatus::Blocked;
        operation.capability_id = None;
        operation.step_id = None;
        return Some(format!(
            "Capability {capability_id} was not found for operation {operation_tag}."
        ));
    };

    if !capability
        .operation_tags
        .iter()
        .any(|tag| tag == operation_tag)
    {
        operation.status = OperationStatus::Blocked;
        operation.capability_id = None;
        operation.step_id = None;
        return Some(format!(
            "Capability {capability_id} does not declare operation tag {operation_tag}."
        ));
    }

    if let Some(required_field) = required_input_field {
        if !schema_compatible(capability, required_field) {
            operation.status = OperationStatus::Blocked;
            operation.capability_id = None;
            operation.step_id = None;
            return Some(format!(
                "Capability {capability_id} does not expose required input field {required_field} for operation {operation_tag}."
            ));
        }
    }

    operation.status = OperationStatus::Covered;
    operation.capability_id = Some(capability_id.into());
    operation.step_id = Some(step_id.into());
    None
}

fn news_search_query(operation: &PlannedOperation) -> Option<&str> {
    operation
        .inputs
        .get("query")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|query| !query.is_empty())
}

fn schema_compatible(capability: &Capability, required_field: &str) -> bool {
    schema_is_object(&capability.input_schema)
        && schema_is_object(&capability.output_schema)
        && schema_supports_required_field(&capability.input_schema, required_field)
}

fn schema_is_object(schema: &serde_json::Value) -> bool {
    schema
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value == "object")
}

fn schema_supports_required_field(schema: &serde_json::Value, required_field: &str) -> bool {
    schema
        .get("required")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|required| {
            required
                .iter()
                .any(|field| field.as_str().is_some_and(|value| value == required_field))
        })
        || schema
            .get("anyOf")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|schemas| {
                schemas
                    .iter()
                    .any(|schema| schema_supports_required_field(schema, required_field))
            })
        || schema
            .get("oneOf")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|schemas| {
                schemas
                    .iter()
                    .any(|schema| schema_supports_required_field(schema, required_field))
            })
        || schema
            .get("allOf")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|schemas| {
                schemas
                    .iter()
                    .all(|schema| schema_supports_required_field(schema, required_field))
            })
}

fn expected_required_input_field(operation_kind: OperationKind) -> Option<&'static str> {
    match operation_kind {
        OperationKind::CollectUrlStatus => Some("urls"),
        OperationKind::CollectWebPage => Some("url"),
        OperationKind::CollectRssFeed => Some("url"),
        OperationKind::ParseCsv => Some("content"),
        OperationKind::ExtractArticle | OperationKind::ExtractMetadata => Some("body_text"),
        OperationKind::TransformFilter
        | OperationKind::TransformSort
        | OperationKind::TransformProject
        | OperationKind::TransformLimit => Some("data"),
        OperationKind::ValidateJsonLd => Some("json_ld"),
        OperationKind::PrepareContentBrief | OperationKind::PrepareSearchIntent => Some("topic"),
        OperationKind::SynthesizeMarkdownArtifact
        | OperationKind::CollectWeather
        | OperationKind::CollectNews
        | OperationKind::ExtractLinks
        | OperationKind::ExtractStructuredData => None,
    }
}
