use crate::agent_auth::{self, AgentAuthProfile, AgentRunnerKind};
use crate::llm_provider;
use crate::models::{AgentTaskEnvelope, RavenWorkflow};
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolSideEffectLevel {
    Read,
    Write,
    ExternalAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolApprovalPolicy {
    Auto,
    Review,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolDescriptor {
    pub id: String,
    pub display_name: String,
    pub tool_class: String,
    pub required_permission: String,
    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,
    pub side_effect_level: ToolSideEffectLevel,
    pub credential_ref: Option<String>,
    pub approval_policy: ToolApprovalPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTaskRequest {
    pub workflow: RavenWorkflow,
    pub step_id: String,
    pub objective: String,
    pub output_schema: serde_json::Value,
    pub tool_manifest: Vec<ToolDescriptor>,
    pub prior_step_outputs: serde_json::Value,
    pub permissions: Vec<String>,
    pub profile: AgentAuthProfile,
}

#[derive(Debug, thiserror::Error)]
pub enum AgentTaskError {
    #[error("unknown agent tool class {0}")]
    UnknownToolClass(String),
    #[error("malformed agent task output: {0}")]
    MalformedOutput(String),
    #[error("agent task execution failed: {0}")]
    ExecutionFailed(String),
}

pub trait AgentTaskExecutor {
    fn execute(&self, request: &AgentTaskRequest) -> Result<AgentTaskEnvelope, AgentTaskError>;
}

pub trait AgentTaskCredentialResolver {
    fn resolve(&self, profile: &AgentAuthProfile) -> Option<String>;
}

pub trait NativeAgentTaskClient {
    fn openai_response(
        &self,
        api_key: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String>;
    fn anthropic_message(
        &self,
        api_key: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String>;
    fn ollama_generate(
        &self,
        model: &str,
        prompt: &str,
        format: serde_json::Value,
    ) -> Result<String, String>;
}

pub struct EnvAgentTaskCredentialResolver;

impl AgentTaskCredentialResolver for EnvAgentTaskCredentialResolver {
    fn resolve(&self, profile: &AgentAuthProfile) -> Option<String> {
        resolve_env_credential(&profile.credential_ref)
    }
}

pub struct UreqNativeAgentTaskClient;

impl NativeAgentTaskClient for UreqNativeAgentTaskClient {
    fn openai_response(
        &self,
        api_key: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        ureq::post("https://api.openai.com/v1/responses")
            .set("Authorization", &format!("Bearer {api_key}"))
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|error| error.to_string())?
            .into_json()
            .map_err(|error| error.to_string())
    }

    fn anthropic_message(
        &self,
        api_key: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        ureq::post("https://api.anthropic.com/v1/messages")
            .set("x-api-key", api_key)
            .set("anthropic-version", "2023-06-01")
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|error| error.to_string())?
            .into_json()
            .map_err(|error| error.to_string())
    }

    fn ollama_generate(
        &self,
        model: &str,
        prompt: &str,
        format: serde_json::Value,
    ) -> Result<String, String> {
        let host =
            std::env::var("RAVEN_OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".into());
        llm_provider::ollama_generate(&host, model, prompt, Some(format))
    }
}

pub struct NativeAgentTaskExecutor<'a> {
    credential_resolver: &'a dyn AgentTaskCredentialResolver,
    client: &'a dyn NativeAgentTaskClient,
}

impl<'a> NativeAgentTaskExecutor<'a> {
    pub fn new(
        credential_resolver: &'a dyn AgentTaskCredentialResolver,
        client: &'a dyn NativeAgentTaskClient,
    ) -> Self {
        Self {
            credential_resolver,
            client,
        }
    }
}

pub struct DefaultAgentTaskExecutor;

impl AgentTaskExecutor for DefaultAgentTaskExecutor {
    fn execute(&self, request: &AgentTaskRequest) -> Result<AgentTaskEnvelope, AgentTaskError> {
        let credential_resolver = EnvAgentTaskCredentialResolver;
        let client = UreqNativeAgentTaskClient;
        NativeAgentTaskExecutor::new(&credential_resolver, &client).execute(request)
    }
}

impl AgentTaskExecutor for NativeAgentTaskExecutor<'_> {
    fn execute(&self, request: &AgentTaskRequest) -> Result<AgentTaskEnvelope, AgentTaskError> {
        let prompt = agent_task_prompt(request);
        match request.profile.runner_kind {
            AgentRunnerKind::OpenAiApi => {
                return execute_openai_agent_task(
                    request,
                    &prompt,
                    self.credential_resolver,
                    self.client,
                );
            }
            AgentRunnerKind::AnthropicApi => {
                return execute_anthropic_agent_task(
                    request,
                    &prompt,
                    self.credential_resolver,
                    self.client,
                );
            }
            AgentRunnerKind::OllamaLocal => {
                return execute_ollama_agent_task(request, &prompt, self.client);
            }
            AgentRunnerKind::CodexCli | AgentRunnerKind::ClaudeCodeCli => {}
        }
        let tool_classes = request
            .tool_manifest
            .iter()
            .map(|tool| tool.tool_class.clone())
            .collect::<Vec<_>>();
        let allows_writes = request.tool_manifest.iter().any(|tool| {
            tool.side_effect_level == ToolSideEffectLevel::Write
                || tool.side_effect_level == ToolSideEffectLevel::ExternalAction
        });
        let plan = agent_auth::command_plan_for_profile_with_tool_classes(
            &request.profile,
            &prompt,
            &tool_classes,
            allows_writes,
        )
        .map_err(AgentTaskError::ExecutionFailed)?;
        let output = execute_plan(&plan)
            .map_err(|error| AgentTaskError::ExecutionFailed(error.to_string()))?;

        if !output.status.success() {
            return Err(AgentTaskError::ExecutionFailed(sanitize_cli_stderr(
                &String::from_utf8_lossy(&output.stderr),
            )));
        }

        parse_cli_agent_task_output(
            &request.profile.runner_kind,
            &String::from_utf8_lossy(&output.stdout),
        )
    }
}

fn execute_openai_agent_task(
    request: &AgentTaskRequest,
    prompt: &str,
    credential_resolver: &dyn AgentTaskCredentialResolver,
    client: &dyn NativeAgentTaskClient,
) -> Result<AgentTaskEnvelope, AgentTaskError> {
    let api_key =
        resolve_profile_credential(&request.profile, credential_resolver).ok_or_else(|| {
            AgentTaskError::ExecutionFailed(
                "OpenAI API credential is required before agent task execution.".into(),
            )
        })?;
    let response = client
        .openai_response(
            &api_key,
            openai_agent_task_request_body(&request.profile, prompt),
        )
        .map_err(|error| AgentTaskError::ExecutionFailed(sanitize_cli_stderr(&error)))?;
    let text = response
        .get("output_text")
        .and_then(|value| value.as_str())
        .or_else(|| {
            response
                .pointer("/output/0/content/0/text")
                .and_then(|value| value.as_str())
        })
        .ok_or_else(|| {
            AgentTaskError::MalformedOutput("OpenAI response did not include output_text".into())
        })?;
    parse_agent_task_output(text)
}

fn execute_anthropic_agent_task(
    request: &AgentTaskRequest,
    prompt: &str,
    credential_resolver: &dyn AgentTaskCredentialResolver,
    client: &dyn NativeAgentTaskClient,
) -> Result<AgentTaskEnvelope, AgentTaskError> {
    let api_key =
        resolve_profile_credential(&request.profile, credential_resolver).ok_or_else(|| {
            AgentTaskError::ExecutionFailed(
                "Anthropic API credential is required before agent task execution.".into(),
            )
        })?;
    let response = client
        .anthropic_message(
            &api_key,
            anthropic_agent_task_request_body(&request.profile, prompt),
        )
        .map_err(|error| AgentTaskError::ExecutionFailed(sanitize_cli_stderr(&error)))?;
    let value = response
        .get("content")
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items.iter().find_map(|item| {
                if item.get("type").and_then(|value| value.as_str()) == Some("tool_use")
                    && item.get("name").and_then(|value| value.as_str()) == Some("StructuredOutput")
                {
                    return item.get("input").cloned();
                }
                item.get("text")
                    .and_then(|value| value.as_str())
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            })
        })
        .ok_or_else(|| {
            AgentTaskError::MalformedOutput(
                "Anthropic response did not include StructuredOutput".into(),
            )
        })?;
    parse_agent_task_envelope_value(&value)
}

fn execute_ollama_agent_task(
    request: &AgentTaskRequest,
    prompt: &str,
    client: &dyn NativeAgentTaskClient,
) -> Result<AgentTaskEnvelope, AgentTaskError> {
    let output = client
        .ollama_generate(
            &request.profile.model,
            prompt,
            agent_task_envelope_json_schema(),
        )
        .map_err(|error| AgentTaskError::ExecutionFailed(sanitize_cli_stderr(&error)))?;
    parse_agent_task_output(&output)
}

fn openai_agent_task_request_body(profile: &AgentAuthProfile, prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "model": profile.model,
        "input": [
            {
                "role": "user",
                "content": prompt
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "raven_agent_task_envelope",
                "strict": false,
                "schema": agent_task_envelope_json_schema()
            }
        }
    })
}

fn anthropic_agent_task_request_body(
    profile: &AgentAuthProfile,
    prompt: &str,
) -> serde_json::Value {
    serde_json::json!({
        "model": profile.model,
        "max_tokens": 4096,
        "messages": [{ "role": "user", "content": prompt }],
        "tools": [{
            "name": "StructuredOutput",
            "description": "Emit the Raven agent task envelope.",
            "input_schema": agent_task_envelope_json_schema()
        }],
        "tool_choice": { "type": "tool", "name": "StructuredOutput" }
    })
}

fn agent_task_envelope_json_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": [
            "title",
            "content_markdown",
            "metadata",
            "source_refs",
            "tool_trace",
            "raw_result_json"
        ],
        "properties": {
            "title": { "type": "string" },
            "content_markdown": { "type": "string" },
            "metadata": { "type": "object" },
            "source_refs": { "type": "array", "items": { "type": "string" } },
            "tool_trace": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": true,
                    "required": ["tool_id", "status", "input_summary", "source_refs"],
                    "properties": {
                        "tool_id": { "type": "string" },
                        "status": { "type": "string" },
                        "input_summary": {},
                        "output_summary": {},
                        "source_refs": { "type": "array", "items": { "type": "string" } },
                        "error": {}
                    }
                }
            },
            "raw_result_json": { "type": "object" }
        }
    })
}

fn resolve_env_credential(credential_ref: &str) -> Option<String> {
    credential_ref
        .strip_prefix("env:")
        .and_then(|name| std::env::var(name).ok())
        .filter(|value| !value.trim().is_empty())
}

fn resolve_profile_credential(
    profile: &AgentAuthProfile,
    credential_resolver: &dyn AgentTaskCredentialResolver,
) -> Option<String> {
    credential_resolver
        .resolve(profile)
        .or_else(|| resolve_env_credential(&profile.credential_ref))
}

pub fn agent_task_prompt(request: &AgentTaskRequest) -> String {
    let safe_tool_manifest = request
        .tool_manifest
        .iter()
        .map(|tool| {
            let mut safe_tool = tool.clone();
            safe_tool.credential_ref = None;
            safe_tool
        })
        .collect::<Vec<_>>();
    let output_schema =
        serde_json::to_string_pretty(&request.output_schema).unwrap_or_else(|_| "{}".to_string());
    let tool_manifest =
        serde_json::to_string_pretty(&safe_tool_manifest).unwrap_or_else(|_| "[]".to_string());
    let prior_step_outputs = serde_json::to_string_pretty(&request.prior_step_outputs)
        .unwrap_or_else(|_| "{}".to_string());
    let workflow_id = sanitize_prompt_input(&request.workflow.id);
    let workflow_name = sanitize_prompt_input(&request.workflow.name);
    let step_id = sanitize_prompt_input(&request.step_id);
    let objective = sanitize_prompt_input(&request.objective);
    let output_schema = sanitize_prompt_input(&output_schema);
    let tool_manifest = sanitize_prompt_input(&tool_manifest);
    let prior_step_outputs = sanitize_prompt_input(&prior_step_outputs);

    format!(
        r#"You are executing one Raven agent task.

Workflow:
- id: {workflow_id}
- name: {workflow_name}

Step id:
{step_id}

Objective:
{objective}

Output schema:
{output_schema}

Tool manifest:
{tool_manifest}

Prior step outputs:
{prior_step_outputs}

Safety:
- Use only manifest-approved capabilities and tools.
- Do not expose credentials, tokens, or secrets.
- Summarize tool activity in tool_trace.
- Return only the structured JSON envelope with no extra text.

The JSON envelope must include:
title, content_markdown, metadata, source_refs, tool_trace, raw_result_json.

Field requirements:
- source_refs must be an array of strings.
- tool_trace must be an array. Use [] when no tools were called.
- Each tool_trace item must include tool_id, status, input_summary, source_refs, and may include output_summary and error.
- raw_result_json must be a JSON object.
"#,
        workflow_id = workflow_id,
        workflow_name = workflow_name,
        step_id = step_id,
        objective = objective,
    )
}

pub fn parse_agent_task_output(output: &str) -> Result<AgentTaskEnvelope, AgentTaskError> {
    let trimmed = output.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if value.get("type").is_none() {
            return parse_agent_task_envelope_value(&value);
        }
    }

    let mut parsed_envelope = None;
    for line in trimmed.lines().filter(|line| !line.trim().is_empty()) {
        let value = serde_json::from_str::<serde_json::Value>(line)
            .map_err(|error| AgentTaskError::MalformedOutput(error.to_string()))?;
        match value.get("type").and_then(|value| value.as_str()) {
            Some("item.completed") => {
                let Some(item) = value.get("item") else {
                    continue;
                };
                if item.get("type").and_then(|value| value.as_str()) != Some("agent_message") {
                    continue;
                }
                let text = item
                    .get("text")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| {
                        AgentTaskError::MalformedOutput("agent message text missing".into())
                    })?;
                match parse_agent_task_envelope_text(text) {
                    Ok(envelope) => parsed_envelope = Some(envelope),
                    Err(error)
                        if parsed_envelope.is_none()
                            && looks_like_agent_task_envelope_attempt(text) =>
                    {
                        return Err(error);
                    }
                    Err(_) => {}
                }
            }
            Some("assistant") => {
                let Some(content) = value
                    .get("message")
                    .and_then(|message| message.get("content"))
                    .and_then(|content| content.as_array())
                else {
                    continue;
                };
                for block in content {
                    match block.get("type").and_then(|value| value.as_str()) {
                        Some("text") => {
                            let text = block
                                .get("text")
                                .and_then(|value| value.as_str())
                                .ok_or_else(|| {
                                    AgentTaskError::MalformedOutput("assistant text missing".into())
                                })?;
                            match parse_agent_task_envelope_text(text) {
                                Ok(envelope) => parsed_envelope = Some(envelope),
                                Err(error)
                                    if parsed_envelope.is_none()
                                        && looks_like_agent_task_envelope_attempt(text) =>
                                {
                                    return Err(error);
                                }
                                Err(_) => {}
                            }
                        }
                        Some("tool_use")
                            if block.get("name").and_then(|value| value.as_str())
                                == Some("StructuredOutput") =>
                        {
                            let input = block.get("input").ok_or_else(|| {
                                AgentTaskError::MalformedOutput(
                                    "structured output input missing".into(),
                                )
                            })?;
                            parsed_envelope = Some(parse_agent_task_envelope_value(input)?);
                        }
                        _ => {}
                    }
                }
            }
            Some("result") => {
                if let Some(structured_output) = value.get("structured_output") {
                    parsed_envelope = Some(parse_agent_task_envelope_value(structured_output)?);
                    continue;
                }
                if let Some(text) = value.get("result").and_then(|value| value.as_str()) {
                    match parse_agent_task_envelope_text(text) {
                        Ok(envelope) => parsed_envelope = Some(envelope),
                        Err(error)
                            if parsed_envelope.is_none()
                                && looks_like_agent_task_envelope_attempt(text) =>
                        {
                            return Err(error);
                        }
                        Err(_) => {}
                    }
                }
            }
            _ => {}
        }
    }

    parsed_envelope
        .ok_or_else(|| AgentTaskError::MalformedOutput("agent task envelope missing".into()))
}

fn parse_cli_agent_task_output(
    runner_kind: &AgentRunnerKind,
    output: &str,
) -> Result<AgentTaskEnvelope, AgentTaskError> {
    if !matches!(
        runner_kind,
        AgentRunnerKind::CodexCli | AgentRunnerKind::ClaudeCodeCli
    ) {
        return parse_agent_task_output(output);
    }

    let jsonl = output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str::<serde_json::Value>(trimmed)
                .ok()
                .map(|_| trimmed)
        })
        .collect::<Vec<_>>()
        .join("\n");

    if jsonl.is_empty() {
        return parse_agent_task_output(output);
    }

    parse_agent_task_output(&jsonl)
}

fn parse_agent_task_envelope_text(text: &str) -> Result<AgentTaskEnvelope, AgentTaskError> {
    let value = serde_json::from_str(text.trim())
        .or_else(|_| {
            extract_json_object_value(text, is_agent_task_envelope_value).ok_or_else(|| {
                serde_json::Error::io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "agent task envelope missing",
                ))
            })
        })
        .map_err(|error| AgentTaskError::MalformedOutput(error.to_string()))?;
    parse_agent_task_envelope_value(&value)
}

fn looks_like_agent_task_envelope_attempt(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with('{')
        || trimmed.starts_with("```json")
        || (trimmed.contains('{') && trimmed.contains("\"title\""))
}

fn parse_agent_task_envelope_value(
    value: &serde_json::Value,
) -> Result<AgentTaskEnvelope, AgentTaskError> {
    serde_json::from_value(normalize_agent_task_envelope_value(value))
        .map_err(|error| AgentTaskError::MalformedOutput(error.to_string()))
}

fn normalize_agent_task_envelope_value(value: &serde_json::Value) -> serde_json::Value {
    let mut normalized = value.clone();
    let Some(tool_trace) = normalized
        .as_object_mut()
        .and_then(|object| object.get_mut("tool_trace"))
        .and_then(|tool_trace| tool_trace.as_array_mut())
    else {
        return normalized;
    };

    for entry in tool_trace {
        let Some(entry_object) = entry.as_object_mut() else {
            continue;
        };
        if !entry_object.contains_key("tool_id") {
            if let Some(tool) = entry_object.get("tool").cloned() {
                entry_object.insert("tool_id".into(), tool);
            }
        }
        if !entry_object.contains_key("status") {
            entry_object.insert("status".into(), serde_json::json!("unknown"));
        }
        if !entry_object.contains_key("input_summary") {
            let summary = entry_object
                .get("input")
                .cloned()
                .or_else(|| entry_object.get("summary").cloned())
                .unwrap_or_else(|| serde_json::json!({}));
            entry_object.insert("input_summary".into(), summary);
        }
        if !entry_object.contains_key("source_refs") {
            entry_object.insert("source_refs".into(), serde_json::json!([]));
        }
    }

    normalized
}

fn is_agent_task_envelope_value(value: &serde_json::Value) -> bool {
    value.get("title").is_some()
        && value.get("content_markdown").is_some()
        && value.get("metadata").is_some()
        && value.get("source_refs").is_some()
        && value.get("tool_trace").is_some()
        && value.get("raw_result_json").is_some()
}

fn extract_json_object_value(
    text: &str,
    predicate: fn(&serde_json::Value) -> bool,
) -> Option<serde_json::Value> {
    if let Some(fenced) = extract_fenced_json(text) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&fenced) {
            if predicate(&value) {
                return Some(value);
            }
        }
    }

    for candidate in balanced_json_candidates(text) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
            if predicate(&value) {
                return Some(value);
            }
        }
    }
    None
}

fn extract_fenced_json(text: &str) -> Option<String> {
    let fence_start = text.find("```")?;
    let after_fence = &text[fence_start + 3..];
    let content_start = after_fence.find('\n').map(|index| index + 1).unwrap_or(0);
    let content = &after_fence[content_start..];
    let fence_end = content.find("```")?;
    Some(content[..fence_end].trim().to_string())
}

fn balanced_json_candidates(text: &str) -> Vec<&str> {
    let mut candidates = Vec::new();
    let mut stack = Vec::new();
    let mut start = None;
    let mut in_string = false;
    let mut escaped = false;

    for (index, character) in text.char_indices() {
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
                if stack.is_empty() {
                    start = Some(index);
                }
                stack.push(character);
            }
            '}' => {
                if stack.pop().is_some() && stack.is_empty() {
                    if let Some(start_index) = start.take() {
                        candidates.push(&text[start_index..=index]);
                    }
                }
            }
            _ => {}
        }
    }

    candidates
}

pub fn expand_allowed_tools(
    tool_classes: &[String],
) -> Result<Vec<ToolDescriptor>, AgentTaskError> {
    tool_classes
        .iter()
        .map(|tool_class| descriptor_for_tool_class(tool_class))
        .collect()
}

fn descriptor_for_tool_class(tool_class: &str) -> Result<ToolDescriptor, AgentTaskError> {
    let (id, display_name, required_permission) = match tool_class {
        "web" => ("web.search", "Web search", "network:read"),
        "http" => ("http.get", "HTTP GET", "network:read"),
        "local_git" => ("local_git.context", "Local Git context", "git:read"),
        "github" => ("github.context", "GitHub context", "github:read"),
        "nestweaver" => (
            "nestweaver.context",
            "NestWeaver context",
            "nestweaver:read",
        ),
        "document_import" => (
            "document_import.context",
            "Document import context",
            "document:read",
        ),
        "ai_chat_import" => (
            "ai_chat_import.context",
            "AI chat import context",
            "chat:read",
        ),
        unknown => return Err(AgentTaskError::UnknownToolClass(unknown.to_string())),
    };

    Ok(ToolDescriptor {
        id: id.to_string(),
        display_name: display_name.to_string(),
        tool_class: tool_class.to_string(),
        required_permission: required_permission.to_string(),
        input_schema: serde_json::json!({}),
        output_schema: serde_json::json!({}),
        side_effect_level: ToolSideEffectLevel::Read,
        credential_ref: None,
        approval_policy: ToolApprovalPolicy::Auto,
    })
}

fn execute_plan(
    plan: &agent_auth::AgentCommandPlan,
) -> Result<std::process::Output, std::io::Error> {
    let mut command = Command::new(&plan.program);
    command.args(&plan.args);
    if !plan.env_allowlist.is_empty() {
        command.env_clear();
        for name in &plan.env_allowlist {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
    for name in &plan.remove_env {
        command.env_remove(name);
    }
    let isolated_cwd = if plan.isolate_cwd {
        let path = std::env::temp_dir().join(format!("raven-agent-task-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)?;
        command.current_dir(&path);
        Some(path)
    } else {
        None
    };
    let output = command.output();
    if let Some(path) = isolated_cwd {
        let _ = std::fs::remove_dir_all(path);
    }
    output
}

fn sanitize_cli_stderr(stderr: &str) -> String {
    const MAX_STDERR_CHARS: usize = 2048;

    let redacted = redact_token_shaped_values(stderr);
    if redacted.chars().count() <= MAX_STDERR_CHARS {
        return redacted;
    }

    let mut truncated = redacted.chars().take(MAX_STDERR_CHARS).collect::<String>();
    truncated.push_str("\n[stderr truncated]");
    truncated
}

fn sanitize_prompt_input(value: &str) -> String {
    redact_credential_refs(&redact_token_shaped_values(value))
}

fn redact_credential_refs(value: &str) -> String {
    let mut redacted = value.to_string();
    for (prefix, min_suffix_len) in [("env:", 1), ("keychain:", 1)] {
        redacted = redact_token_with_prefix(&redacted, prefix, min_suffix_len, false);
    }
    for credential_ref in ["codex:oauth:local-cli", "claude-code:oauth:local-cli"] {
        redacted = redact_literal_credential_ref(&redacted, credential_ref);
    }
    redacted
}

fn redact_literal_credential_ref(value: &str, credential_ref: &str) -> String {
    let mut redacted = String::new();
    let mut index = 0;
    while index < value.len() {
        let has_ref = value[index..]
            .get(..credential_ref.len())
            .is_some_and(|candidate| candidate == credential_ref);
        if has_ref && is_token_boundary(value[..index].chars().next_back()) {
            let next_index = index + credential_ref.len();
            if is_token_boundary(value[next_index..].chars().next()) {
                redacted.push_str("[redacted]");
                index = next_index;
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

fn redact_token_shaped_values(value: &str) -> String {
    let mut redacted = value.to_string();
    for (prefix, min_suffix_len, case_insensitive) in [
        ("sk-", 8, false),
        ("github_pat_", 12, false),
        ("ghp_", 12, false),
        ("xoxb-", 20, false),
        ("AIza", 20, false),
        ("AKIA", 16, false),
        ("Bearer ", 20, true),
    ] {
        redacted = redact_token_with_prefix(&redacted, prefix, min_suffix_len, case_insensitive);
    }
    redacted
}

fn redact_token_with_prefix(
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
        if has_prefix && is_token_boundary(value[..index].chars().next_back()) {
            let suffix = &value[index + prefix.len()..];
            let suffix_len = token_suffix_len(suffix);
            if suffix_len >= min_suffix_len {
                redacted.push_str("[redacted]");
                index += prefix.len() + token_suffix_byte_len(suffix);
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

fn is_token_boundary(character: Option<char>) -> bool {
    character.is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
}

fn token_suffix_len(value: &str) -> usize {
    value.chars().take_while(is_token_character).count()
}

fn token_suffix_byte_len(value: &str) -> usize {
    value
        .chars()
        .take_while(is_token_character)
        .map(char::len_utf8)
        .sum()
}

fn is_token_character(character: &char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | '+' | '=')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_auth::{AgentAuthMode, AgentRunnerKind};
    use crate::models::{
        WorkflowDefaults, WorkflowScheduleDefinition, WorkflowStepDefinition, WorkflowStepKind,
    };

    struct FixedCredentialResolver;

    impl AgentTaskCredentialResolver for FixedCredentialResolver {
        fn resolve(&self, _profile: &AgentAuthProfile) -> Option<String> {
            Some("credential-placeholder-from-test-store".into())
        }
    }

    #[derive(Default)]
    struct RecordingNativeClient {
        calls: std::cell::RefCell<Vec<serde_json::Value>>,
    }

    impl NativeAgentTaskClient for RecordingNativeClient {
        fn openai_response(
            &self,
            api_key: &str,
            body: serde_json::Value,
        ) -> Result<serde_json::Value, String> {
            self.calls.borrow_mut().push(serde_json::json!({
                "provider": "openai",
                "api_key": api_key,
                "body": body,
            }));
            Ok(serde_json::json!({
                "output_text": serde_json::json!({
                    "title": "OpenAI Native Task",
                    "content_markdown": "OpenAI completed the task.",
                    "metadata": { "kind": "agent_task" },
                    "source_refs": ["openai:responses"],
                    "tool_trace": [],
                    "raw_result_json": { "provider": "openai" }
                }).to_string()
            }))
        }

        fn anthropic_message(
            &self,
            api_key: &str,
            body: serde_json::Value,
        ) -> Result<serde_json::Value, String> {
            self.calls.borrow_mut().push(serde_json::json!({
                "provider": "anthropic",
                "api_key": api_key,
                "body": body,
            }));
            Ok(serde_json::json!({
                "content": [{
                    "type": "tool_use",
                    "name": "StructuredOutput",
                    "input": {
                        "title": "Anthropic Native Task",
                        "content_markdown": "Anthropic completed the task.",
                        "metadata": { "kind": "agent_task" },
                        "source_refs": ["anthropic:messages"],
                        "tool_trace": [],
                        "raw_result_json": { "provider": "anthropic" }
                    }
                }]
            }))
        }

        fn ollama_generate(
            &self,
            model: &str,
            prompt: &str,
            format: serde_json::Value,
        ) -> Result<String, String> {
            self.calls.borrow_mut().push(serde_json::json!({
                "provider": "ollama",
                "model": model,
                "prompt": prompt,
                "format": format,
            }));
            Ok(serde_json::json!({
                "title": "Ollama Native Task",
                "content_markdown": "Ollama completed the task.",
                "metadata": { "kind": "agent_task" },
                "source_refs": ["ollama:local"],
                "tool_trace": [],
                "raw_result_json": { "provider": "ollama" }
            })
            .to_string())
        }
    }

    #[test]
    fn expands_allowed_tools_into_typed_manifest() {
        let manifest = expand_allowed_tools(&["web".into(), "local_git".into()]).unwrap();

        assert_eq!(manifest.len(), 2);
        assert_eq!(manifest[0].id, "web.search");
        assert_eq!(manifest[0].required_permission, "network:read");
        assert_eq!(manifest[0].side_effect_level, ToolSideEffectLevel::Read);
        assert_eq!(manifest[1].id, "local_git.context");
    }

    #[test]
    fn rejects_unknown_allowed_tools() {
        let error = expand_allowed_tools(&["shell".into()]).unwrap_err();

        assert_eq!(error.to_string(), "unknown agent tool class shell");
    }

    #[test]
    fn parses_codex_jsonl_agent_task_envelope() {
        let output = format!(
            "{}\n{}",
            serde_json::json!({ "type": "thread.started" }),
            serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": serde_json::json!({
                        "title": "Weather Today",
                        "content_markdown": "# Weather Today\n\nIt is clear.",
                        "metadata": { "kind": "agent_task" },
                        "source_refs": ["web.search"],
                        "tool_trace": [],
                        "raw_result_json": { "answer": "It is clear." }
                    }).to_string()
                }
            })
        );

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.title, "Weather Today");
        assert_eq!(envelope.source_refs, vec!["web.search"]);
    }

    #[test]
    fn parses_codex_jsonl_envelope_after_progress_messages() {
        let output = format!(
            "{}\n{}\n{}\n{}",
            serde_json::json!({ "type": "thread.started" }),
            serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": "Checking the requested URLs before composing the artifact."
                }
            }),
            serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "web_search",
                    "query": "https://kehl.io"
                }
            }),
            serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": serde_json::json!({
                        "title": "Website Uptime Check",
                        "content_markdown": "# Website Uptime Check\n\nAll requested sites were checked.",
                        "metadata": { "kind": "agent_task" },
                        "source_refs": ["https://kehl.io"],
                        "tool_trace": [],
                        "raw_result_json": { "results": [] }
                    }).to_string()
                }
            })
        );

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.title, "Website Uptime Check");
        assert_eq!(envelope.source_refs, vec!["https://kehl.io"]);
    }

    #[test]
    fn parses_oauth_cli_jsonl_after_stdout_diagnostics() {
        let output = format!(
            "{}\n{}\n{}\n{}",
            "Reading additional input from stdin...",
            "2026-06-19T05:45:45Z  WARN codex_core_plugins::manifest: plugin warning",
            serde_json::json!({ "type": "thread.started" }),
            serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": serde_json::json!({
                        "title": "Weather Probe",
                        "content_markdown": "Done.",
                        "metadata": { "kind": "agent_task" },
                        "source_refs": [],
                        "tool_trace": [],
                        "raw_result_json": { "ok": true }
                    }).to_string()
                }
            })
        );

        let envelope = parse_cli_agent_task_output(&AgentRunnerKind::CodexCli, &output).unwrap();
        let claude_envelope =
            parse_cli_agent_task_output(&AgentRunnerKind::ClaudeCodeCli, &output).unwrap();

        assert_eq!(envelope.title, "Weather Probe");
        assert_eq!(envelope.raw_result_json["ok"], true);
        assert_eq!(claude_envelope.title, "Weather Probe");
        assert_eq!(claude_envelope.raw_result_json["ok"], true);
    }

    #[test]
    fn native_non_cli_output_keeps_strict_non_json_rejection() {
        let output = format!(
            "{}\n{}",
            "diagnostic prefix",
            serde_json::json!({
                "type": "result",
                "subtype": "success",
                "result": serde_json::json!({
                    "title": "Claude Result",
                    "content_markdown": "Done.",
                    "metadata": { "kind": "agent_task" },
                    "source_refs": [],
                    "tool_trace": [],
                    "raw_result_json": { "ok": true }
                }).to_string()
            })
        );

        let error = parse_cli_agent_task_output(&AgentRunnerKind::OpenAiApi, &output).unwrap_err();

        assert!(matches!(error, AgentTaskError::MalformedOutput(_)));
    }

    #[test]
    fn parses_claude_stream_json_result_agent_task_envelope() {
        let output = format!(
            "{}\n{}\n{}",
            serde_json::json!({ "type": "system", "subtype": "init" }),
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "thinking",
                            "thinking": "internal reasoning omitted"
                        }
                    ]
                }
            }),
            serde_json::json!({
                "type": "result",
                "subtype": "success",
                "result": serde_json::json!({
                    "title": "Claude Weather",
                    "content_markdown": "# Claude Weather\n\nIt is windy.",
                    "metadata": { "kind": "agent_task" },
                    "source_refs": ["claude-code"],
                    "tool_trace": [],
                    "raw_result_json": { "answer": "It is windy." }
                }).to_string()
            })
        );

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.title, "Claude Weather");
        assert_eq!(envelope.source_refs, vec!["claude-code"]);
    }

    #[test]
    fn parses_claude_stream_json_assistant_text_agent_task_envelope() {
        let output = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "text",
                        "text": serde_json::json!({
                            "title": "Claude Assistant Text",
                            "content_markdown": "Done.",
                            "metadata": { "kind": "agent_task" },
                            "source_refs": [],
                            "tool_trace": [],
                            "raw_result_json": { "ok": true }
                        }).to_string()
                    }
                ]
            }
        })
        .to_string();

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.title, "Claude Assistant Text");
        assert_eq!(envelope.raw_result_json["ok"], true);
    }

    #[test]
    fn parses_claude_stream_json_structured_output_result() {
        let output = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "result": "Structured output provided successfully.",
            "structured_output": {
                "title": "Claude Structured Output",
                "content_markdown": "Done.",
                "metadata": { "kind": "agent_task" },
                "source_refs": [],
                "tool_trace": [],
                "raw_result_json": { "ok": true }
            }
        })
        .to_string();

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.title, "Claude Structured Output");
        assert_eq!(envelope.raw_result_json["ok"], true);
    }

    #[test]
    fn parses_claude_stream_json_structured_output_tool_use() {
        let output = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "StructuredOutput",
                        "input": {
                            "title": "Claude Structured Tool",
                            "content_markdown": "Done.",
                            "metadata": { "kind": "agent_task" },
                            "source_refs": [],
                            "tool_trace": [],
                            "raw_result_json": { "ok": true }
                        }
                    }
                ]
            }
        })
        .to_string();

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.title, "Claude Structured Tool");
        assert_eq!(envelope.raw_result_json["ok"], true);
    }

    #[test]
    fn parses_claude_structured_output_before_visible_text_continuation() {
        let output = format!(
            "{}\n{}\n{}",
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "name": "StructuredOutput",
                            "input": {
                                "title": "Claude Structured Tool",
                                "content_markdown": "Done.",
                                "metadata": { "kind": "agent_task" },
                                "source_refs": [],
                                "tool_trace": [],
                                "raw_result_json": { "ok": true }
                            }
                        }
                    ]
                }
            }),
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": "The agent task is complete."
                        }
                    ]
                }
            }),
            serde_json::json!({
                "type": "result",
                "subtype": "success",
                "result": "The agent task is complete."
            })
        );

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.title, "Claude Structured Tool");
        assert_eq!(envelope.raw_result_json["ok"], true);
    }

    #[test]
    fn parses_plain_json_agent_task_envelope() {
        let output = serde_json::json!({
            "title": "Plain Envelope",
            "content_markdown": "Done.",
            "metadata": { "kind": "agent_task" },
            "source_refs": [],
            "tool_trace": [],
            "raw_result_json": { "ok": true }
        })
        .to_string();

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.title, "Plain Envelope");
        assert_eq!(envelope.raw_result_json["ok"], true);
    }

    #[test]
    fn normalizes_agent_tool_trace_shorthand() {
        let output = serde_json::json!({
            "title": "Codex Envelope",
            "content_markdown": "Done.",
            "metadata": { "kind": "agent_task" },
            "source_refs": [],
            "tool_trace": [
                {
                    "tool": "none",
                    "status": "not_used",
                    "summary": "No tools were invoked."
                }
            ],
            "raw_result_json": { "ok": true }
        })
        .to_string();

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.tool_trace[0].tool_id, "none");
        assert_eq!(envelope.tool_trace[0].status, "not_used");
        assert_eq!(
            envelope.tool_trace[0].input_summary,
            serde_json::json!("No tools were invoked.")
        );
        assert!(envelope.tool_trace[0].source_refs.is_empty());
    }

    #[test]
    fn errors_on_malformed_agent_task_output() {
        let error = parse_agent_task_output("not json").unwrap_err();

        assert!(matches!(error, AgentTaskError::MalformedOutput(_)));
    }

    #[test]
    fn parses_prose_wrapped_model_message_when_full_envelope_is_present() {
        let output = serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "agent_message",
                "text": format!(
                    "Here is the envelope:\n```json\n{}\n```",
                    serde_json::json!({
                        "title": "Weather Today",
                        "content_markdown": "# Weather Today\n\nIt is clear.",
                        "metadata": { "kind": "agent_task" },
                        "source_refs": ["web.search"],
                        "tool_trace": [],
                        "raw_result_json": { "answer": "It is clear." }
                    })
                )
            }
        })
        .to_string();

        let envelope = parse_agent_task_output(&output).unwrap();

        assert_eq!(envelope.title, "Weather Today");
    }

    #[test]
    fn rejects_malformed_jsonl_agent_message_before_valid_envelope() {
        let output = format!(
            "{}\n{}",
            serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": "Here is the envelope: {\"title\":\"Wrapped\"}"
                }
            }),
            serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": serde_json::json!({
                        "title": "Weather Today",
                        "content_markdown": "# Weather Today\n\nIt is clear.",
                        "metadata": { "kind": "agent_task" },
                        "source_refs": ["web.search"],
                        "tool_trace": [],
                        "raw_result_json": { "answer": "It is clear." }
                    }).to_string()
                }
            })
        );

        let error = parse_agent_task_output(&output).unwrap_err();

        assert!(matches!(error, AgentTaskError::MalformedOutput(_)));
    }

    #[test]
    fn rejects_prose_contaminated_claude_stream_result() {
        let output = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "result": "Here is the envelope: {\"title\":\"Wrapped\"}"
        })
        .to_string();

        let error = parse_agent_task_output(&output).unwrap_err();

        assert!(matches!(error, AgentTaskError::MalformedOutput(_)));
    }

    #[test]
    fn rejects_plain_json_envelope_surrounded_by_prose() {
        let output = format!(
            "Here is the envelope:\n{}\nDone.",
            serde_json::json!({
                "title": "Prose Wrapped",
                "content_markdown": "Done.",
                "metadata": { "kind": "agent_task" },
                "source_refs": [],
                "tool_trace": [],
                "raw_result_json": { "ok": true }
            })
        );

        let error = parse_agent_task_output(&output).unwrap_err();

        assert!(matches!(error, AgentTaskError::MalformedOutput(_)));
    }

    #[test]
    fn agent_task_prompt_includes_task_context_without_credential_refs() {
        let mut tool = descriptor_for_tool_class("web").unwrap();
        tool.credential_ref = Some("env:SECRET_TOKEN".into());
        let request = AgentTaskRequest {
            workflow: workflow(),
            step_id: "weather".into(),
            objective: "Summarize today's weather.".into(),
            output_schema: serde_json::json!({ "type": "object" }),
            tool_manifest: vec![tool],
            prior_step_outputs: serde_json::json!({ "previous": { "ok": true } }),
            permissions: vec!["llm:generate".into(), "network:read".into()],
            profile: profile(),
        };

        let prompt = agent_task_prompt(&request);

        assert!(prompt.contains("Summarize today's weather."));
        assert!(prompt.contains("web.search"));
        assert!(prompt.contains("\"previous\""));
        assert!(!prompt.contains("SECRET_TOKEN"));
        assert!(prompt.contains("Use only manifest-approved capabilities and tools."));
        assert!(prompt.contains("Do not expose credentials, tokens, or secrets."));
        assert!(prompt.contains("Summarize tool activity in tool_trace."));
        assert!(prompt.contains("Return only the structured JSON envelope with no extra text."));
        assert!(prompt.contains("tool_trace must be an array"));
        assert!(prompt.contains("tool_id, status, input_summary, source_refs"));
    }

    #[test]
    fn agent_task_prompt_redacts_prompt_input_secrets_and_preserves_normal_text() {
        let openai_style_secret = ["sk", "test-agent-task-secret"].join("-");
        let github_pat_secret = format!("{}{}", "github_pat_", "promptNativeSecret1234567890");
        let google_secret = format!("{}{}", "AIza", "PromptNativeSecret1234567890");
        let bearer_secret = format!("{}{}", "Bearer ", "promptNativeSecret1234567890");
        let slack_secret = format!("{}{}", "xoxb-", "prompt-native-secret-1234567890");
        let github_classic_secret = format!("{}{}", "ghp_", "promptNativeSecret1234567890");
        let aws_secret = format!("{}{}", "AKIA", "PROMPTNATIVE123456");
        let mut tool = descriptor_for_tool_class("web").unwrap();
        tool.display_name = format!("Search with {github_pat_secret}");
        tool.input_schema = serde_json::json!({
            "description": "use keychain:agent-task-login for disk-space check"
        });
        tool.output_schema = serde_json::json!({
            "token": google_secret
        });
        tool.credential_ref = Some("claude-code:oauth:local-cli".into());
        let request = AgentTaskRequest {
            workflow: workflow(),
            step_id: "disk-space".into(),
            objective: format!(
                "Run disk-space check with {openai_style_secret} and env:OPENAI_API_KEY"
            ),
            output_schema: serde_json::json!({
                "authorization": bearer_secret
            }),
            tool_manifest: vec![tool],
            prior_step_outputs: serde_json::json!({
                "previous": slack_secret,
                "github": github_classic_secret,
                "aws": aws_secret,
                "credential": "codex:oauth:local-cli"
            }),
            permissions: vec!["llm:generate".into(), "network:read".into()],
            profile: profile(),
        };

        let prompt = agent_task_prompt(&request);

        assert!(prompt.contains("disk-space check"));
        for secret in vec![
            openai_style_secret,
            "env:OPENAI_API_KEY".into(),
            github_pat_secret,
            "keychain:agent-task-login".into(),
            google_secret,
            bearer_secret,
            slack_secret,
            github_classic_secret,
            aws_secret,
            "codex:oauth:local-cli".into(),
            "claude-code:oauth:local-cli".into(),
        ] {
            assert!(!prompt.contains(&secret), "prompt leaked {secret}");
        }
        assert!(prompt.contains("[redacted]"));
    }

    #[test]
    fn sanitizes_failed_cli_stderr_before_execution_error() {
        let secret = ["sk", "test-agent-task-secret"].join("-");
        let stderr = format!("provider failed with {secret}\n{}", "x".repeat(5000));

        let sanitized = sanitize_cli_stderr(&stderr);

        assert!(!sanitized.contains(&secret));
        assert!(sanitized.contains("[redacted]"));
        assert!(sanitized.len() < stderr.len());
        assert!(sanitized.contains("truncated"));
    }

    #[test]
    fn execute_plan_removes_configured_environment_variables() {
        let env_name = "RAVEN_AGENT_TASK_REMOVE_ENV_TEST_SECRET";
        std::env::set_var(env_name, "secret-value");
        let plan = agent_auth::AgentCommandPlan {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                format!(
                    "if [ -z \"${{{env_name}+x}}\" ]; then echo removed; else echo present; fi"
                ),
            ],
            env_refs: vec![],
            remove_env: vec![env_name.into()],
            env_allowlist: vec![],
            isolate_cwd: false,
        };

        let output = execute_plan(&plan).unwrap();
        std::env::remove_var(env_name);

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "removed");
    }

    #[test]
    fn execute_plan_clears_environment_to_allowlist() {
        let secret_name = "RAVEN_AGENT_TASK_TEST_SECRET";
        let allowed_name = "RAVEN_AGENT_TASK_TEST_ALLOWED";
        std::env::set_var(secret_name, "leaky");
        std::env::set_var(allowed_name, "visible");
        let plan = agent_auth::AgentCommandPlan {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                format!("echo allowed=${{{allowed_name}:-}} secret=${{{secret_name}:-}}"),
            ],
            env_refs: vec![],
            remove_env: vec![],
            env_allowlist: vec![allowed_name.into()],
            isolate_cwd: false,
        };

        let output = execute_plan(&plan).unwrap();
        std::env::remove_var(secret_name);
        std::env::remove_var(allowed_name);
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success());
        assert!(stdout.contains("allowed=visible"));
        assert!(stdout.contains("secret="));
        assert!(!stdout.contains("leaky"));
    }

    #[test]
    fn execute_plan_uses_isolated_working_directory() {
        let plan = agent_auth::AgentCommandPlan {
            program: "pwd".into(),
            args: vec![],
            env_refs: vec![],
            remove_env: vec![],
            env_allowlist: vec!["PATH".into()],
            isolate_cwd: true,
        };

        let output = execute_plan(&plan).unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success());
        assert!(stdout.contains("raven-agent-task-"));
        assert!(!stdout.contains("/dev/workspace/raven"));
    }

    #[test]
    fn openai_agent_task_request_does_not_use_strict_mode_with_open_schema() {
        let mut profile = profile();
        profile.runner_kind = AgentRunnerKind::OpenAiApi;
        profile.model = "gpt-4.1".into();

        let body = openai_agent_task_request_body(&profile, "Return an envelope.");

        assert_openai_schema_contract_allows_open_json(&body);
    }

    fn assert_openai_schema_contract_allows_open_json(body: &serde_json::Value) {
        let format = &body["text"]["format"];
        assert_eq!(format["type"], "json_schema");
        if format["strict"].as_bool() == Some(true) {
            assert_no_open_objects_for_strict_schema(&format["schema"], "$.text.format.schema");
        }
    }

    fn assert_no_open_objects_for_strict_schema(value: &serde_json::Value, path: &str) {
        let Some(object) = value.as_object() else {
            return;
        };
        if value.get("type").and_then(|value| value.as_str()) == Some("object") {
            assert_eq!(
                value.get("additionalProperties"),
                Some(&serde_json::Value::Bool(false)),
                "strict schema object at {path} must set additionalProperties: false"
            );
        }
        assert_ne!(
            value.get("additionalProperties"),
            Some(&serde_json::Value::Bool(true)),
            "strict schema object at {path} must not allow additional properties"
        );
        for (key, child) in object {
            assert_no_open_objects_for_strict_schema(child, &format!("{path}.{key}"));
        }
    }

    #[test]
    fn openai_api_profile_executes_agent_task_with_injected_native_client() {
        let mut profile = profile();
        profile.id = "openai-api-key".into();
        profile.display_name = "OpenAI API key".into();
        profile.runner_kind = AgentRunnerKind::OpenAiApi;
        profile.auth_mode = AgentAuthMode::ApiKeyKeychain;
        profile.credential_ref = "credential-file:openai-api-key".into();
        profile.model = "gpt-4.1".into();
        let client = RecordingNativeClient::default();
        let executor = NativeAgentTaskExecutor::new(&FixedCredentialResolver, &client);
        let request = AgentTaskRequest {
            workflow: workflow(),
            step_id: "weather".into(),
            objective: "Summarize today's weather.".into(),
            output_schema: serde_json::json!({ "type": "object" }),
            tool_manifest: expand_allowed_tools(&["web".into()]).unwrap(),
            prior_step_outputs: serde_json::json!({}),
            permissions: vec!["llm:generate".into(), "network:read".into()],
            profile,
        };

        let envelope = executor.execute(&request).unwrap();

        assert_eq!(envelope.title, "OpenAI Native Task");
        assert_eq!(envelope.source_refs, vec!["openai:responses"]);
        let call = client.calls.borrow()[0].clone();
        assert_eq!(call["api_key"], "credential-placeholder-from-test-store");
        assert_eq!(call["body"]["model"], "gpt-4.1");
        assert!(!call.to_string().contains("credential-file:openai-api-key"));
    }

    #[test]
    fn anthropic_api_profile_executes_agent_task_with_injected_native_client() {
        let mut profile = profile();
        profile.id = "anthropic-api-key".into();
        profile.display_name = "Anthropic API key".into();
        profile.runner_kind = AgentRunnerKind::AnthropicApi;
        profile.auth_mode = AgentAuthMode::ApiKeyKeychain;
        profile.credential_ref = "credential-file:anthropic-api-key".into();
        profile.model = "claude-sonnet-4-5".into();
        let client = RecordingNativeClient::default();
        let executor = NativeAgentTaskExecutor::new(&FixedCredentialResolver, &client);
        let request = AgentTaskRequest {
            workflow: workflow(),
            step_id: "weather".into(),
            objective: "Summarize today's weather.".into(),
            output_schema: serde_json::json!({ "type": "object" }),
            tool_manifest: expand_allowed_tools(&["web".into()]).unwrap(),
            prior_step_outputs: serde_json::json!({}),
            permissions: vec!["llm:generate".into(), "network:read".into()],
            profile,
        };

        let envelope = executor.execute(&request).unwrap();

        assert_eq!(envelope.title, "Anthropic Native Task");
        assert_eq!(envelope.source_refs, vec!["anthropic:messages"]);
        let call = client.calls.borrow()[0].clone();
        assert_eq!(call["api_key"], "credential-placeholder-from-test-store");
        assert_eq!(call["body"]["model"], "claude-sonnet-4-5");
        assert!(!call
            .to_string()
            .contains("credential-file:anthropic-api-key"));
    }

    #[test]
    fn ollama_profile_executes_agent_task_with_local_generate_client() {
        let mut profile = profile();
        profile.id = "ollama-local".into();
        profile.display_name = "Ollama (local)".into();
        profile.runner_kind = AgentRunnerKind::OllamaLocal;
        profile.auth_mode = AgentAuthMode::None;
        profile.credential_ref = "".into();
        profile.model = "llama3.1:8b".into();
        let client = RecordingNativeClient::default();
        let executor = NativeAgentTaskExecutor::new(&FixedCredentialResolver, &client);
        let request = AgentTaskRequest {
            workflow: workflow(),
            step_id: "weather".into(),
            objective: "Summarize today's weather.".into(),
            output_schema: serde_json::json!({ "type": "object" }),
            tool_manifest: expand_allowed_tools(&["web".into()]).unwrap(),
            prior_step_outputs: serde_json::json!({}),
            permissions: vec!["llm:generate".into(), "network:read".into()],
            profile,
        };

        let envelope = executor.execute(&request).unwrap();

        assert_eq!(envelope.title, "Ollama Native Task");
        let call = client.calls.borrow()[0].clone();
        assert_eq!(call["model"], "llama3.1:8b");
        assert!(call["prompt"]
            .as_str()
            .is_some_and(|prompt| prompt.contains("Return only the structured JSON envelope")));
        assert_eq!(call["format"]["type"], "object");
    }

    fn profile() -> AgentAuthProfile {
        AgentAuthProfile {
            id: "codex-oauth-local".into(),
            display_name: "Codex OAuth (local CLI)".into(),
            runner_kind: AgentRunnerKind::CodexCli,
            auth_mode: AgentAuthMode::CodexOauthLocalCli,
            credential_ref: "codex:oauth:local-cli".into(),
            model: "gpt-5.4".into(),
            effort: "medium".into(),
            status: "available".into(),
            summary: "Uses local CLI credentials.".into(),
        }
    }

    fn workflow() -> RavenWorkflow {
        RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "weather-workflow".into(),
            name: "Weather Workflow".into(),
            description: "Checks weather.".into(),
            permissions: vec!["llm:generate".into(), "network:read".into()],
            defaults: WorkflowDefaults {
                llm_profile_ref: "codex-oauth-local".into(),
                destination_ref: "local".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps: vec![WorkflowStepDefinition {
                id: "weather".into(),
                name: "Weather".into(),
                kind: WorkflowStepKind::AgentTask,
                provider: "agent".into(),
                action: "run_task".into(),
                depends_on: vec![],
                permissions: vec!["llm:generate".into(), "network:read".into()],
                inputs: serde_json::json!({
                    "objective": "Summarize today's weather.",
                    "output_schema": { "type": "object" },
                    "allowed_tools": ["web"]
                }),
                llm_profile_ref: Some("codex-oauth-local".into()),
                destination_ref: None,
                inline_code: None,
                parallel: None,
            }],
        }
    }
}
