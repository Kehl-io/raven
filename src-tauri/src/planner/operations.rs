use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Requested,
    Covered,
    AgentRequired,
    Unsupported,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OperationKind {
    #[serde(rename = "collect.url_status")]
    CollectUrlStatus,
    #[serde(rename = "collect.web_page")]
    CollectWebPage,
    #[serde(rename = "collect.rss_feed")]
    CollectRssFeed,
    #[serde(rename = "collect.weather")]
    CollectWeather,
    #[serde(rename = "collect.news")]
    CollectNews,
    #[serde(rename = "parse.csv")]
    ParseCsv,
    #[serde(rename = "extract.article")]
    ExtractArticle,
    #[serde(rename = "extract.metadata")]
    ExtractMetadata,
    #[serde(rename = "extract.links")]
    ExtractLinks,
    #[serde(rename = "extract.structured_data")]
    ExtractStructuredData,
    #[serde(rename = "transform.filter")]
    TransformFilter,
    #[serde(rename = "transform.sort")]
    TransformSort,
    #[serde(rename = "transform.project")]
    TransformProject,
    #[serde(rename = "transform.limit")]
    TransformLimit,
    #[serde(rename = "validate.json_ld")]
    ValidateJsonLd,
    #[serde(rename = "prepare.search_intent")]
    PrepareSearchIntent,
    #[serde(rename = "prepare.content_brief")]
    PrepareContentBrief,
    #[serde(rename = "synthesize.markdown_artifact")]
    SynthesizeMarkdownArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedOperation {
    pub id: String,
    pub kind: OperationKind,
    pub status: OperationStatus,
    pub evidence: String,
    pub capability_id: Option<String>,
    pub step_id: Option<String>,
    pub inputs: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationPlan {
    pub prompt: String,
    pub operations: Vec<PlannedOperation>,
    pub warnings: Vec<String>,
}

impl OperationPlan {
    pub fn new(prompt: &str) -> Self {
        Self {
            prompt: prompt.to_owned(),
            operations: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_kind_serializes_as_stable_string() {
        assert_eq!(
            serde_json::to_value(OperationKind::TransformSort).unwrap(),
            serde_json::json!("transform.sort")
        );
    }

    #[test]
    fn operation_plan_records_covered_and_unsupported_operations() {
        let plan = OperationPlan {
            prompt: "parse csv and summarize".into(),
            operations: vec![
                PlannedOperation {
                    id: "op-parse-csv".into(),
                    kind: OperationKind::ParseCsv,
                    status: OperationStatus::Covered,
                    evidence: "Prompt requested CSV parsing.".into(),
                    capability_id: Some("data.parse_csv".into()),
                    step_id: Some("parse-csv".into()),
                    inputs: serde_json::json!({ "content": "name\nAda" }),
                },
                PlannedOperation {
                    id: "op-synthesize".into(),
                    kind: OperationKind::SynthesizeMarkdownArtifact,
                    status: OperationStatus::AgentRequired,
                    evidence: "Prompt requested a final summary.".into(),
                    capability_id: None,
                    step_id: Some("summarize".into()),
                    inputs: serde_json::json!({}),
                },
            ],
            warnings: vec![],
        };

        let value = serde_json::to_value(&plan).unwrap();
        assert_eq!(value["operations"][0]["kind"], "parse.csv");
        assert_eq!(value["operations"][0]["status"], "covered");
        assert_eq!(value["operations"][1]["status"], "agent_required");
    }
}
