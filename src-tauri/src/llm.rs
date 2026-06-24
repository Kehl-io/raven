use crate::models::RavenWorkflow;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactEnvelope {
    pub title: String,
    pub content_markdown: String,
    pub metadata: serde_json::Value,
    pub source_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactGenerationRequest {
    pub workflow: RavenWorkflow,
    pub context_summary: String,
    pub source_refs: Vec<String>,
    pub provider_id: String,
    pub model: String,
    pub effort: String,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum LlmError {
    #[error("provider auth is missing")]
    MissingCredential,
    #[error("provider returned malformed structured output: {0}")]
    MalformedOutput(String),
    #[error("provider refused the request: {0}")]
    Refusal(String),
    #[error("provider request failed: {0}")]
    RequestFailed(String),
}

pub trait LlmArtifactGenerator {
    fn generate_artifact(
        &self,
        request: &ArtifactGenerationRequest,
    ) -> Result<ArtifactEnvelope, LlmError>;
}

pub struct LocalPreviewArtifactGenerator;

impl LlmArtifactGenerator for LocalPreviewArtifactGenerator {
    fn generate_artifact(
        &self,
        request: &ArtifactGenerationRequest,
    ) -> Result<ArtifactEnvelope, LlmError> {
        Ok(ArtifactEnvelope {
            title: request.workflow.name.clone(),
            content_markdown: format!(
                "# {}\n\n## Context\n{}\n\n## Output\n- Generated as Markdown content with JSON metadata.\n- Stored in the local app artifact destination.",
                request.workflow.name, request.context_summary
            ),
            metadata: serde_json::json!({
                "schema_version": "0.1.0",
                "workflow_id": request.workflow.id,
                "provider": request.provider_id,
                "model": request.model,
                "effort": request.effort,
                "structured_outputs": false,
                "generated_by": "local_preview"
            }),
            source_refs: request.source_refs.clone(),
        })
    }
}

pub struct OpenAiResponsesArtifactGenerator {
    api_key: String,
}

impl OpenAiResponsesArtifactGenerator {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
        }
    }

    pub fn request_body(request: &ArtifactGenerationRequest) -> serde_json::Value {
        serde_json::json!({
            "model": request.model,
            "input": [
                {
                    "role": "system",
                    "content": "You generate Raven workflow artifacts. Return only the requested structured JSON."
                },
                {
                    "role": "user",
                    "content": format!(
                        "Workflow: {}\nTemplate: {}\nContext:\n{}\nSource refs:\n{}",
                        request.workflow.name,
                        artifact_type(&request.workflow.id),
                        request.context_summary,
                        request.source_refs.join("\n")
                    )
                }
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "raven_artifact_envelope",
                    "strict": true,
                    "schema": artifact_envelope_schema()
                }
            }
        })
    }

    pub fn parse_response(response: &serde_json::Value) -> Result<ArtifactEnvelope, LlmError> {
        if let Some(refusal) = response
            .pointer("/output/0/content/0/refusal")
            .and_then(|value| value.as_str())
        {
            return Err(LlmError::Refusal(refusal.into()));
        }

        let output_text = response
            .get("output_text")
            .and_then(|value| value.as_str())
            .or_else(|| {
                response
                    .pointer("/output/0/content/0/text")
                    .and_then(|value| value.as_str())
            })
            .ok_or_else(|| LlmError::MalformedOutput("missing output_text".into()))?;

        serde_json::from_str(output_text)
            .map_err(|error| LlmError::MalformedOutput(error.to_string()))
    }
}

impl LlmArtifactGenerator for OpenAiResponsesArtifactGenerator {
    fn generate_artifact(
        &self,
        request: &ArtifactGenerationRequest,
    ) -> Result<ArtifactEnvelope, LlmError> {
        if self.api_key.trim().is_empty() {
            return Err(LlmError::MissingCredential);
        }

        let response: serde_json::Value = ureq::post("https://api.openai.com/v1/responses")
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .set("Content-Type", "application/json")
            .send_json(Self::request_body(request))
            .map_err(|error| LlmError::RequestFailed(error.to_string()))?
            .into_json()
            .map_err(|error| LlmError::MalformedOutput(error.to_string()))?;

        Self::parse_response(&response)
    }
}

pub struct AnthropicMessagesArtifactGenerator {
    api_key: String,
}

impl AnthropicMessagesArtifactGenerator {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
        }
    }

    pub fn request_body(request: &ArtifactGenerationRequest) -> serde_json::Value {
        serde_json::json!({
            "model": request.model,
            "max_tokens": 2048,
            "system": "You generate Raven workflow artifacts. Return one tool call to emit_artifact with schema-compliant fields.",
            "messages": [
                {
                    "role": "user",
                    "content": format!(
                        "Workflow: {}\nTemplate: {}\nContext:\n{}\nSource refs:\n{}",
                        request.workflow.name,
                        artifact_type(&request.workflow.id),
                        request.context_summary,
                        request.source_refs.join("\n")
                    )
                }
            ],
            "tools": [
                {
                    "name": "emit_artifact",
                    "description": "Return the generated Raven Markdown artifact and metadata.",
                    "input_schema": artifact_envelope_schema()
                }
            ],
            "tool_choice": { "type": "tool", "name": "emit_artifact" }
        })
    }

    pub fn parse_response(response: &serde_json::Value) -> Result<ArtifactEnvelope, LlmError> {
        let content = response
            .get("content")
            .and_then(|value| value.as_array())
            .ok_or_else(|| LlmError::MalformedOutput("missing content".into()))?;
        let tool_input = content
            .iter()
            .find(|item| {
                item.get("type").and_then(|value| value.as_str()) == Some("tool_use")
                    && item.get("name").and_then(|value| value.as_str()) == Some("emit_artifact")
            })
            .and_then(|item| item.get("input"))
            .ok_or_else(|| LlmError::MalformedOutput("missing emit_artifact tool input".into()))?;

        serde_json::from_value(tool_input.clone())
            .map_err(|error| LlmError::MalformedOutput(error.to_string()))
    }
}

impl LlmArtifactGenerator for AnthropicMessagesArtifactGenerator {
    fn generate_artifact(
        &self,
        request: &ArtifactGenerationRequest,
    ) -> Result<ArtifactEnvelope, LlmError> {
        if self.api_key.trim().is_empty() {
            return Err(LlmError::MissingCredential);
        }

        let response: serde_json::Value = ureq::post("https://api.anthropic.com/v1/messages")
            .set("x-api-key", &self.api_key)
            .set("anthropic-version", "2023-06-01")
            .set("Content-Type", "application/json")
            .send_json(Self::request_body(request))
            .map_err(|error| LlmError::RequestFailed(error.to_string()))?
            .into_json()
            .map_err(|error| LlmError::MalformedOutput(error.to_string()))?;

        Self::parse_response(&response)
    }
}

fn artifact_type(workflow_id: &str) -> &'static str {
    if workflow_id == "morning-brief" {
        "morning_brief"
    } else {
        "daily_work_journal"
    }
}

fn artifact_envelope_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "content_markdown", "metadata", "source_refs"],
        "properties": {
            "title": { "type": "string" },
            "content_markdown": { "type": "string" },
            "metadata": {
                "type": "object",
                "additionalProperties": true
            },
            "source_refs": {
                "type": "array",
                "items": { "type": "string" }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow;

    fn request() -> ArtifactGenerationRequest {
        ArtifactGenerationRequest {
            workflow: workflow::daily_work_journal(),
            context_summary: "Recent commits touched runtime.rs and providers.rs.".into(),
            source_refs: vec!["git:abc123".into()],
            provider_id: "openai".into(),
            model: "gpt-4.1".into(),
            effort: "medium".into(),
        }
    }

    #[test]
    fn openai_request_uses_responses_structured_outputs() {
        let body = OpenAiResponsesArtifactGenerator::request_body(&request());

        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert_eq!(body["text"]["format"]["strict"], true);
        assert_eq!(body["text"]["format"]["name"], "raven_artifact_envelope");
        assert!(body.to_string().contains("Daily Work Journal"));
    }

    #[test]
    fn openai_parser_extracts_structured_artifact_envelope() {
        let response = serde_json::json!({
            "output_text": serde_json::json!({
                "title": "Daily Work Journal",
                "content_markdown": "# Daily Work Journal\n\nGenerated.",
                "metadata": { "schema_version": "0.1.0" },
                "source_refs": ["git:abc123"]
            }).to_string()
        });

        let envelope = OpenAiResponsesArtifactGenerator::parse_response(&response).unwrap();

        assert_eq!(envelope.title, "Daily Work Journal");
        assert!(envelope.content_markdown.contains("Generated."));
        assert_eq!(envelope.source_refs, vec!["git:abc123"]);
    }

    #[test]
    fn anthropic_request_uses_tool_schema_for_structured_artifact() {
        let body = AnthropicMessagesArtifactGenerator::request_body(&request());

        assert_eq!(body["tools"][0]["name"], "emit_artifact");
        assert_eq!(body["tool_choice"]["name"], "emit_artifact");
        assert!(body.to_string().contains("Daily Work Journal"));
    }

    #[test]
    fn anthropic_parser_extracts_tool_use_artifact_envelope() {
        let response = serde_json::json!({
            "content": [
                {
                    "type": "tool_use",
                    "name": "emit_artifact",
                    "input": {
                        "title": "Daily Work Journal",
                        "content_markdown": "# Daily Work Journal\n\nGenerated.",
                        "metadata": { "schema_version": "0.1.0" },
                        "source_refs": ["git:abc123"]
                    }
                }
            ]
        });

        let envelope = AnthropicMessagesArtifactGenerator::parse_response(&response).unwrap();

        assert_eq!(envelope.title, "Daily Work Journal");
        assert!(envelope.content_markdown.contains("Generated."));
        assert_eq!(envelope.source_refs, vec!["git:abc123"]);
    }
}
