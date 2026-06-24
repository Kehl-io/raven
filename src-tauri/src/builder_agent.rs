use crate::agent_auth::{self, AgentAuthProfile, AgentRunnerKind};
use crate::capabilities;
use crate::llm_provider;
use crate::models::{RavenWorkflow, WorkflowDraft, WorkflowDraftRevisionContext, WorkflowStepKind};
use crate::workflow;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const DEFAULT_AGENT_CLI_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Deserialize)]
struct AgentDraftEnvelope {
    summary: String,
    permission_changes: Vec<String>,
    destination_writes: Vec<String>,
    diff_json: serde_json::Value,
    definition: RavenWorkflow,
}

pub trait AgentExecutor {
    fn execute(&self, profile: &AgentAuthProfile, system_prompt: &str) -> Result<String, String>;
    fn execute_streaming(
        &self,
        profile: &AgentAuthProfile,
        system_prompt: &str,
        request_id: &str,
        events: &dyn BuilderDraftEventSink,
    ) -> Result<String, String> {
        let _ = request_id;
        let _ = events;
        self.execute(profile, system_prompt)
    }
}

pub trait AgentCredentialResolver {
    fn resolve(&self, profile: &AgentAuthProfile) -> Option<String>;
}

pub trait OllamaTextGenerator {
    fn generate(
        &self,
        model: &str,
        prompt: &str,
        format: serde_json::Value,
    ) -> Result<String, String>;
}

struct LocalOllamaTextGenerator;

impl OllamaTextGenerator for LocalOllamaTextGenerator {
    fn generate(
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

static LOCAL_OLLAMA_TEXT_GENERATOR: LocalOllamaTextGenerator = LocalOllamaTextGenerator;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BuilderDraftEvent {
    pub request_id: String,
    pub phase: String,
    pub step_id: String,
    pub status: String,
    pub title: String,
    pub detail: String,
    pub emitted_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_event_type: Option<String>,
}

pub trait BuilderDraftEventSink {
    fn emit(&self, event: BuilderDraftEvent);
}

struct NoopBuilderDraftEventSink;

impl BuilderDraftEventSink for NoopBuilderDraftEventSink {
    fn emit(&self, _event: BuilderDraftEvent) {}
}

#[cfg_attr(not(test), allow(dead_code))]
pub struct EnvAgentCredentialResolver;

impl AgentCredentialResolver for EnvAgentCredentialResolver {
    fn resolve(&self, profile: &AgentAuthProfile) -> Option<String> {
        resolve_env_credential(&profile.credential_ref)
    }
}

pub struct DefaultAgentExecutor<'a> {
    credential_resolver: &'a dyn AgentCredentialResolver,
    ollama_generator: &'a dyn OllamaTextGenerator,
}

impl<'a> DefaultAgentExecutor<'a> {
    pub fn new(credential_resolver: &'a dyn AgentCredentialResolver) -> Self {
        Self {
            credential_resolver,
            ollama_generator: &LOCAL_OLLAMA_TEXT_GENERATOR,
        }
    }

    #[cfg(test)]
    pub fn new_with_ollama(
        credential_resolver: &'a dyn AgentCredentialResolver,
        ollama_generator: &'a dyn OllamaTextGenerator,
    ) -> Self {
        Self {
            credential_resolver,
            ollama_generator,
        }
    }
}

impl AgentExecutor for DefaultAgentExecutor<'_> {
    fn execute(&self, profile: &AgentAuthProfile, system_prompt: &str) -> Result<String, String> {
        match profile.runner_kind {
            AgentRunnerKind::CodexCli | AgentRunnerKind::ClaudeCodeCli => {
                let plan = builder_command_plan_for_profile(profile, system_prompt)?;
                let output = execute_plan(&plan).map_err(|error| error.to_string())?;
                if output.status.success() {
                    Ok(String::from_utf8_lossy(&output.stdout).to_string())
                } else {
                    Err(String::from_utf8_lossy(&output.stderr).to_string())
                }
            }
            AgentRunnerKind::OpenAiApi => {
                execute_openai_builder(profile, system_prompt, self.credential_resolver)
            }
            AgentRunnerKind::AnthropicApi => {
                execute_anthropic_builder(profile, system_prompt, self.credential_resolver)
            }
            AgentRunnerKind::OllamaLocal => {
                execute_ollama_builder(profile, system_prompt, self.ollama_generator)
            }
        }
    }

    fn execute_streaming(
        &self,
        profile: &AgentAuthProfile,
        system_prompt: &str,
        request_id: &str,
        events: &dyn BuilderDraftEventSink,
    ) -> Result<String, String> {
        match profile.runner_kind {
            AgentRunnerKind::CodexCli | AgentRunnerKind::ClaudeCodeCli => {
                let plan = builder_command_plan_for_profile(profile, system_prompt)?;
                execute_plan_streaming(&plan, request_id, events)
            }
            AgentRunnerKind::OpenAiApi => execute_openai_builder_streaming(
                profile,
                system_prompt,
                self.credential_resolver,
                request_id,
                events,
            ),
            AgentRunnerKind::AnthropicApi => execute_anthropic_builder_streaming(
                profile,
                system_prompt,
                self.credential_resolver,
                request_id,
                events,
            ),
            AgentRunnerKind::OllamaLocal => {
                let output = execute_ollama_builder(profile, system_prompt, self.ollama_generator)?;
                emit_builder_stream_event(
                    events,
                    request_id,
                    "text_delta",
                    Some(output.clone()),
                    Some("ollama.generate"),
                    "Builder output",
                    "Streaming assistant output.",
                );
                Ok(output)
            }
        }
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn builder_system_prompt(user_request: &str, profile: &AgentAuthProfile) -> String {
    builder_system_prompt_with_revision(user_request, profile, None)
}

pub fn builder_system_prompt_with_revision(
    user_request: &str,
    profile: &AgentAuthProfile,
    previous_draft: Option<&WorkflowDraftRevisionContext>,
) -> String {
    let capability_catalog_json = serde_json::to_string_pretty(&capabilities::builder_capability_summary())
        .unwrap_or_else(|_| {
            "- http_probe.check_urls: deterministic, read-only URL reachability/status checks with urls, timeout_ms, accepted_status_codes inputs.".into()
        });
    let revision_context = previous_draft
        .and_then(|draft| serde_json::to_string_pretty(draft).ok())
        .map(|draft_json| {
            format!(
                r#"
Previous draft context:
{draft_json}

Revision behavior:
- Treat the user request as feedback on the previous draft, not as an unrelated replacement request.
- Preserve the previous workflow's intent, destination, implemented deterministic steps, and safe permissions unless the feedback explicitly changes them.
- Update only the fields and steps needed to satisfy the feedback.
- Do not infer CSV headers, rows, URLs, secrets, or provider inputs from revision prose unless they are in a clearly delimited data block.
"#
            )
        })
        .unwrap_or_default();

    format!(
        r#"You are Raven Builder.

User request:
{user_request}
{revision_context}

Builder profile:
- id: {profile_id}
- model: {model}
- effort: {effort}

Raven purpose:
Raven is a local-first desktop app for creating, validating, scheduling, running, and reviewing AI-powered artifact workflows.

Raven Workflow schema v0.1.0:
- Required: schema_version, id, name, description, permissions, defaults, steps.
- permissions MUST be an array of permission strings, for example ["llm:generate", "artifact:write"].
- defaults MUST be an object with llm_profile_ref and destination_ref string fields.
- steps MUST be an array. Each step requires kind, id, name, provider, action, depends_on, permissions, inputs.
- Use snake_case field names only: schema_version, llm_profile_ref, destination_ref, depends_on.
- The workflow name MUST be a short title (2-5 words), NOT the user's raw prompt. Example: "24h Weather Forecast", "Daily Work Journal".
- The workflow id MUST be a short kebab-case slug derived from the name. Example: "24h-weather-forecast", "daily-work-journal".
- The description should be one sentence explaining what the workflow does.
- Valid workflows are declarative DAGs.
- Expressions are limited to $steps.<step-id>.<field-path>.
- disallow inline arbitrary code.

Provider capabilities:

Supported capability catalog:
{capability_catalog_json}

Other provider capabilities:
- agent.run_task for prompt-native objectives after deterministic provider actions have done all steps they can satisfy.
- local_git.recent_activity, local_git.context_pack
- nestweaver.health, nestweaver.project_context; NestWeaver may be unavailable and must fall back to Local Git
- open_meteo.current_weather
- openai.chat_stream, openai.generate_artifact, openai.structured_output
- local_app.write_artifact, local_app.read_artifact

Deterministic-first routing policy:
- If an implemented deterministic capability can satisfy a step, use it before agent.run_task.
- If the catalog includes capabilities with status planned, do not generate provider_action steps for them until they are implemented; if needed, use the narrowest safe fallback and mention the gap in the draft summary.
- Use execution_mode to route work: deterministic data gathering first, bounded_agentic summarization second, open_agentic tool access only when no deterministic path exists.
- agent.run_task may summarize deterministic outputs, but must not alter ok, status_code, url, effective_url, error_type, error_message, timestamps, durations, or other raw provider facts.
- Do not use agent web/http tools for URL uptime, status, or reachability checks when http_probe.check_urls exists.
- For mixed workflows, route deterministic provider output into an agent_task only for interpretation, formatting, or summarization, then save the resulting artifact with local_app.write_artifact when requested.
- For weather/news briefs, prefer weather.forecast_24h and news.trending before agent.run_task, then use agent.run_task only for summarization or unsupported source needs.
- For SEO and site-content workflows, first gather deterministic evidence with web.fetch_page, seo.fetch_robots_txt, seo.parse_robots_txt, seo.fetch_sitemap, seo.parse_sitemap, seo.audit_indexability, seo.audit_metadata, seo.extract_structured_data, seo.audit_links, and seo.audit_canonical_hreflang as applicable.
- SEO research is topic-, audience-, page-type-, geography-, and intent-specific. Use content.map_search_intent and content.generate_brief to turn the user's topic/business goal into structured writing instructions before any agent writing step.
- For writing homepage, service page, landing page, blog, FAQ, metadata, or schema copy, use agent.run_task after deterministic SEO/content brief steps. The agent objective must cite the deterministic step outputs it should use and should not invent crawl, metadata, schema, sitemap, or source facts.
- After an agent drafts site content, use content.score_quality or seo.validate_json_ld as deterministic QA steps only when they can run before the final artifact sink in the supported workflow shape. If runtime shape prevents post-agent deterministic QA, include the QA requirement in the agent objective and summarize the limitation.

Prompt-native guidance:
- Use agent_task for open-ended natural-language objectives only when no deterministic provider capability can satisfy the step.
- If using agent_task without web access, omit allowed_tools or set allowed_tools to [] and declare only llm:generate on that step.
- To save an agent result locally, add a local_app.write_artifact sink whose inputs.artifact is "$steps.<agent-step-id>.artifact".

Example deterministic website-check workflow shape:
- provider_action check-sites: http_probe.check_urls with inputs urls, timeout_ms, accepted_status_codes.
- agent_task compile-report depending on check-sites, allowed_tools [], objective: write Markdown from prior deterministic output in $steps.check-sites.results and do not re-check websites.
- provider_action write-artifact depending on compile-report, local_app.write_artifact with inputs.artifact "$steps.compile-report.artifact".

Safety and approval:
- A workflow generated by AI is inert until validation and explicit user approval.
- Always summarize permission changes and destination writes.
- Do not include secrets, OAuth tokens, raw API keys, shell scripts, Python, JavaScript, or arbitrary inline code.

Return only one JSON object with exactly these top-level keys:
summary, permission_changes, destination_writes, diff_json, definition.

Use this shape exactly:
{{
  "summary": "Daily Ops Note creates a short operations note and saves it locally.",
  "permission_changes": ["llm:generate", "artifact:write"],
  "destination_writes": ["local-app"],
  "diff_json": [{{ "op": "template", "workflow_id": "daily-ops-note", "name": "Daily Ops Note" }}],
  "definition": {{
    "schema_version": "0.1.0",
    "id": "daily-ops-note",
    "name": "Daily Ops Note",
    "description": "Writes a short daily operations note and saves it as a local artifact.",
    "permissions": ["llm:generate", "artifact:write"],
    "defaults": {{ "llm_profile_ref": "{profile_id}", "destination_ref": "local-app" }},
    "schedule": {{ "cadence": "manual" }},
    "steps": [
      {{
        "kind": "agent_task",
        "id": "ask-ai",
        "name": "Write note",
        "provider": "agent",
        "action": "run_task",
        "depends_on": [],
        "permissions": ["llm:generate"],
        "llm_profile_ref": "{profile_id}",
        "inputs": {{
          "objective": "Write a short daily operations note in Markdown.",
          "output_schema": "artifact_envelope",
          "allowed_tools": []
        }}
      }},
      {{
        "kind": "provider_action",
        "id": "write-artifact",
        "name": "Save note locally",
        "provider": "local_app",
        "action": "write_artifact",
        "depends_on": ["ask-ai"],
        "permissions": ["artifact:write"],
        "destination_ref": "local-app",
        "inputs": {{ "artifact": "$steps.ask-ai.artifact" }}
      }}
    ]
  }}
}}
"#,
        profile_id = profile.id,
        model = profile.model,
        effort = profile.effort,
    )
}

pub fn parse_agent_draft(
    prompt: &str,
    builder_profile_id: &str,
    output: &str,
) -> Result<WorkflowDraft, serde_json::Error> {
    let envelope: AgentDraftEnvelope = serde_json::from_str(output)?;
    let validation = workflow::validate_workflow(&envelope.definition)
        .err()
        .map(|error| vec![error.to_string()])
        .unwrap_or_default();
    let validation_status = if validation.is_empty() {
        "valid"
    } else {
        "invalid"
    };

    Ok(WorkflowDraft {
        id: format!("draft-{}", Uuid::new_v4()),
        prompt: prompt.into(),
        summary: envelope.summary,
        permission_changes: envelope.permission_changes,
        destination_writes: envelope.destination_writes,
        diff_json: envelope.diff_json,
        validation_status: validation_status.into(),
        approval_status: "needs_review".into(),
        builder_profile_id: Some(builder_profile_id.into()),
        approval_mode: workflow::approval_mode_from_prompt(prompt),
        validation_errors: validation,
        planner_rationale: None,
        definition: envelope.definition,
        created_at: Utc::now().to_rfc3339(),
    })
}

fn revision_fallback_draft(
    prompt: &str,
    builder_profile_id: &str,
    previous_draft: &WorkflowDraftRevisionContext,
) -> WorkflowDraft {
    let validation = workflow::validate_workflow(&previous_draft.definition)
        .err()
        .map(|error| vec![error.to_string()])
        .unwrap_or_default();
    let validation_status = if validation.is_empty() {
        "valid"
    } else {
        "invalid"
    };

    WorkflowDraft {
        id: format!("draft-{}", Uuid::new_v4()),
        prompt: prompt.into(),
        summary:
            "Builder fallback kept the previous draft because revision generation was unavailable."
                .into(),
        permission_changes: previous_draft.definition.permissions.clone(),
        destination_writes: vec![previous_draft.definition.defaults.destination_ref.clone()],
        diff_json: serde_json::json!([{ "op": "revision_fallback", "source_label": previous_draft.source_label, "changed": false }]),
        validation_status: validation_status.into(),
        approval_status: "needs_review".into(),
        builder_profile_id: Some(builder_profile_id.into()),
        approval_mode: workflow::approval_mode_from_prompt(prompt),
        validation_errors: validation,
        planner_rationale: previous_draft.planner_rationale.clone(),
        definition: previous_draft.definition.clone(),
        created_at: Utc::now().to_rfc3339(),
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn draft_from_profile_or_template(
    prompt: &str,
    profiles: &[AgentAuthProfile],
    builder_profile_id: Option<&str>,
) -> Result<WorkflowDraft, String> {
    draft_from_profile_or_template_with_executor(
        prompt,
        profiles,
        builder_profile_id,
        &DefaultAgentExecutor::new(&EnvAgentCredentialResolver),
    )
}

pub fn draft_from_profile_or_template_with_executor(
    prompt: &str,
    profiles: &[AgentAuthProfile],
    builder_profile_id: Option<&str>,
    executor: &dyn AgentExecutor,
) -> Result<WorkflowDraft, String> {
    draft_from_profile_or_template_with_events(
        prompt,
        profiles,
        builder_profile_id,
        executor,
        "local-builder-request",
        &NoopBuilderDraftEventSink,
    )
}

pub fn draft_from_profile_or_template_with_events(
    prompt: &str,
    profiles: &[AgentAuthProfile],
    builder_profile_id: Option<&str>,
    executor: &dyn AgentExecutor,
    request_id: &str,
    events: &dyn BuilderDraftEventSink,
) -> Result<WorkflowDraft, String> {
    draft_from_profile_or_template_with_revision_events(
        prompt,
        profiles,
        builder_profile_id,
        executor,
        request_id,
        None,
        events,
    )
}

pub fn draft_from_profile_or_template_with_revision_events(
    prompt: &str,
    profiles: &[AgentAuthProfile],
    builder_profile_id: Option<&str>,
    executor: &dyn AgentExecutor,
    request_id: &str,
    previous_draft: Option<&WorkflowDraftRevisionContext>,
    events: &dyn BuilderDraftEventSink,
) -> Result<WorkflowDraft, String> {
    let profile = select_profile(profiles, builder_profile_id).ok_or_else(|| {
        emit_builder_event(
            events,
            request_id,
            "failed",
            "profile",
            "failed",
            "Builder profile missing",
            "No builder agent profiles are configured.",
        );
        "No builder agent profiles are configured.".to_string()
    })?;
    emit_builder_event(
        events,
        request_id,
        "thinking",
        "profile",
        "complete",
        "Builder profile selected",
        &format!("{} selected.", profile.display_name),
    );

    let system_prompt = builder_system_prompt_with_revision(prompt, profile, previous_draft);
    emit_builder_event(
        events,
        request_id,
        "thinking",
        "context",
        "active",
        "Preparing Raven context",
        "Attaching schema, provider capabilities, permissions, templates, and approval rules.",
    );
    emit_builder_event(
        events,
        request_id,
        "thinking",
        "context",
        "complete",
        "Raven context ready",
        "Builder context delivered.",
    );

    if profile.status == "available" {
        emit_builder_event(
            events,
            request_id,
            "typing",
            "draft",
            "active",
            "Builder is drafting",
            "Waiting for structured workflow draft output.",
        );
        match executor.execute_streaming(profile, &system_prompt, request_id, events) {
            Ok(output) => {
                if let Some(json) = extract_json_object(&output) {
                    match parse_agent_draft(prompt, &profile.id, &json) {
                        Ok(draft) => {
                            emit_builder_event(
                                events,
                                request_id,
                                "typing",
                                "draft",
                                "complete",
                                "Draft output received",
                                &draft.definition.name,
                            );
                            emit_validation_event(events, request_id, &draft);
                            if draft.validation_status == "valid" {
                                if previous_draft.is_some() {
                                    return Ok(draft);
                                }
                                if let Some(deterministic_draft) =
                                    deterministic_first_replacement(prompt, &draft, &profile.id)
                                {
                                    emit_builder_event(
                                        events,
                                        request_id,
                                        "thinking",
                                        "deterministic-routing",
                                        "complete",
                                        "Deterministic routing applied",
                                        "Builder draft replaced with implemented deterministic capability steps.",
                                    );
                                    emit_validation_event(events, request_id, &deterministic_draft);
                                    return Ok(deterministic_draft);
                                }
                                return Ok(draft);
                            }
                        }
                        Err(error) => emit_builder_event(
                            events,
                            request_id,
                            "failed",
                            "draft",
                            "failed",
                            "Draft parse failed",
                            &error.to_string(),
                        ),
                    }
                } else {
                    emit_builder_event(
                        events,
                        request_id,
                        "failed",
                        "draft",
                        "failed",
                        "Draft output missing",
                        "Builder output did not include a JSON workflow draft.",
                    );
                }
            }
            Err(error) => emit_builder_event(
                events,
                request_id,
                "failed",
                "draft",
                "failed",
                "Builder execution failed",
                &error,
            ),
        }
    } else {
        emit_builder_event(
            events,
            request_id,
            "thinking",
            "draft",
            "failed",
            "Builder profile unavailable",
            &format!("{} is {}.", profile.display_name, profile.status),
        );
    }

    emit_builder_event(
        events,
        request_id,
        "typing",
        "draft",
        "active",
        "Using template fallback",
        "Generating a local validated draft without mutating workflows.",
    );
    if let Some(previous_draft) = previous_draft {
        let draft = revision_fallback_draft(prompt, &profile.id, previous_draft);
        emit_builder_event(
            events,
            request_id,
            "typing",
            "draft",
            "complete",
            "Revision fallback ready",
            &draft.definition.name,
        );
        emit_validation_event(events, request_id, &draft);
        return Ok(draft);
    }
    let mut draft = workflow::draft_from_prompt(prompt).map_err(|error| error.to_string())?;
    draft.builder_profile_id = Some(profile.id.clone());
    draft.summary = format!(
        "{} Builder fallback: {}",
        profile.display_name, draft.summary
    );
    emit_builder_event(
        events,
        request_id,
        "typing",
        "draft",
        "complete",
        "Fallback draft ready",
        &draft.definition.name,
    );
    emit_validation_event(events, request_id, &draft);
    Ok(draft)
}

fn deterministic_first_replacement(
    prompt: &str,
    draft: &WorkflowDraft,
    builder_profile_id: &str,
) -> Option<WorkflowDraft> {
    workflow::deterministic_first_workflow_for_prompt(prompt)?;
    let mut replacement = workflow::draft_from_prompt(prompt).ok()?;
    if deterministic_provider_steps_satisfied(&draft.definition, &replacement.definition)
        && deterministic_agent_synthesis_satisfied(&draft.definition, &replacement.definition)
        && draft.planner_rationale == replacement.planner_rationale
    {
        return None;
    }
    replacement.builder_profile_id = Some(builder_profile_id.into());
    replacement.summary = format!("Deterministic-first draft: {}", replacement.summary);
    Some(replacement)
}

fn deterministic_provider_steps_satisfied(
    candidate: &RavenWorkflow,
    required: &RavenWorkflow,
) -> bool {
    let candidate_steps = candidate
        .steps
        .iter()
        .filter(|step| deterministic_provider_step_requires_exact_match(step))
        .collect::<Vec<_>>();
    let required_steps = required
        .steps
        .iter()
        .filter(|step| deterministic_provider_step_requires_exact_match(step))
        .collect::<Vec<_>>();
    if candidate_steps.len() != required_steps.len() {
        return false;
    }
    let mut matched = vec![false; candidate_steps.len()];

    required_steps.iter().all(|required_step| {
        let Some((index, _)) =
            candidate_steps
                .iter()
                .enumerate()
                .find(|(index, candidate_step)| {
                    !matched[*index]
                        && deterministic_provider_step_matches(candidate_step, required_step)
                })
        else {
            return false;
        };
        matched[index] = true;
        true
    })
}

fn deterministic_provider_step_requires_exact_match(
    step: &crate::models::WorkflowStepDefinition,
) -> bool {
    step.kind == WorkflowStepKind::ProviderAction
        && step.provider != "local_app"
        && step.provider != "agent"
}

fn deterministic_provider_step_matches(
    candidate: &crate::models::WorkflowStepDefinition,
    required: &crate::models::WorkflowStepDefinition,
) -> bool {
    candidate.provider == required.provider
        && candidate.action == required.action
        && candidate.depends_on == required.depends_on
        && candidate.inputs == required.inputs
}

fn deterministic_agent_synthesis_satisfied(
    candidate: &RavenWorkflow,
    required: &RavenWorkflow,
) -> bool {
    let required_uses_agent = required
        .steps
        .iter()
        .any(|step| step.kind == WorkflowStepKind::AgentTask);
    let candidate_agents = candidate
        .steps
        .iter()
        .filter(|step| step.kind == WorkflowStepKind::AgentTask)
        .collect::<Vec<_>>();
    if required_uses_agent && candidate_agents.is_empty() {
        return false;
    }
    candidate_agents
        .iter()
        .all(|step| deterministic_agent_step_is_synthesis_only(step))
}

fn deterministic_agent_step_is_synthesis_only(
    step: &crate::models::WorkflowStepDefinition,
) -> bool {
    if step.provider != "agent" || step.action != "run_task" {
        return false;
    }
    if step
        .permissions
        .iter()
        .any(|permission| permission != "llm:generate")
    {
        return false;
    }
    match step.inputs.get("allowed_tools") {
        None => true,
        Some(allowed_tools) => allowed_tools
            .as_array()
            .map(|tools| tools.is_empty())
            .unwrap_or(false),
    }
}

fn emit_validation_event(
    events: &dyn BuilderDraftEventSink,
    request_id: &str,
    draft: &WorkflowDraft,
) {
    let valid = draft.validation_status == "valid";
    let detail = if draft.validation_errors.is_empty() {
        "Schema accepted.".to_string()
    } else {
        draft.validation_errors.join("; ")
    };
    emit_builder_event(
        events,
        request_id,
        if valid { "complete" } else { "failed" },
        "validation",
        if valid { "complete" } else { "failed" },
        if valid {
            "Draft validated"
        } else {
            "Draft needs fixes"
        },
        &detail,
    );
}

fn emit_builder_event(
    events: &dyn BuilderDraftEventSink,
    request_id: &str,
    phase: &str,
    step_id: &str,
    status: &str,
    title: &str,
    detail: &str,
) {
    events.emit(BuilderDraftEvent {
        request_id: request_id.into(),
        phase: phase.into(),
        step_id: step_id.into(),
        status: status.into(),
        title: title.into(),
        detail: detail.into(),
        emitted_at: Utc::now().to_rfc3339(),
        event_kind: None,
        delta: None,
        raw_event_type: None,
    });
}

fn emit_builder_stream_event(
    events: &dyn BuilderDraftEventSink,
    request_id: &str,
    event_kind: &str,
    delta: Option<String>,
    raw_event_type: Option<&str>,
    title: &str,
    detail: &str,
) {
    events.emit(BuilderDraftEvent {
        request_id: request_id.into(),
        phase: if event_kind == "failed" {
            "failed".into()
        } else if event_kind == "completed" {
            "complete".into()
        } else {
            "typing".into()
        },
        step_id: "draft".into(),
        status: if event_kind == "failed" {
            "failed".into()
        } else {
            "active".into()
        },
        title: title.into(),
        detail: detail.into(),
        emitted_at: Utc::now().to_rfc3339(),
        event_kind: Some(event_kind.into()),
        delta,
        raw_event_type: raw_event_type.map(str::to_string),
    });
}

fn execute_openai_builder(
    profile: &AgentAuthProfile,
    system_prompt: &str,
    credential_resolver: &dyn AgentCredentialResolver,
) -> Result<String, String> {
    let api_key = resolve_profile_credential(profile, credential_resolver)
        .ok_or_else(|| "OpenAI API credential reference is not available.".to_string())?;
    let response: serde_json::Value = ureq::post("https://api.openai.com/v1/responses")
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_json(openai_builder_request_body(profile, system_prompt))
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| error.to_string())?;

    response
        .get("output_text")
        .and_then(|value| value.as_str())
        .or_else(|| {
            response
                .pointer("/output/0/content/0/text")
                .and_then(|value| value.as_str())
        })
        .map(str::to_string)
        .ok_or_else(|| "OpenAI builder response did not include output_text.".to_string())
}

fn execute_openai_builder_streaming(
    profile: &AgentAuthProfile,
    system_prompt: &str,
    credential_resolver: &dyn AgentCredentialResolver,
    request_id: &str,
    events: &dyn BuilderDraftEventSink,
) -> Result<String, String> {
    let api_key = resolve_profile_credential(profile, credential_resolver)
        .ok_or_else(|| "OpenAI API credential reference is not available.".to_string())?;
    let mut body = openai_builder_request_body(profile, system_prompt);
    body["stream"] = serde_json::Value::Bool(true);
    let response = ureq::post("https://api.openai.com/v1/responses")
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|error| error.to_string())?;

    read_sse_stream(
        response.into_reader(),
        request_id,
        events,
        sse_delta_from_openai_event,
    )
}

fn execute_anthropic_builder(
    profile: &AgentAuthProfile,
    system_prompt: &str,
    credential_resolver: &dyn AgentCredentialResolver,
) -> Result<String, String> {
    let api_key = resolve_profile_credential(profile, credential_resolver)
        .ok_or_else(|| "Anthropic API credential reference is not available.".to_string())?;
    let response: serde_json::Value = ureq::post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", &api_key)
        .set("anthropic-version", "2023-06-01")
        .set("Content-Type", "application/json")
        .send_json(anthropic_builder_request_body(profile, system_prompt))
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| error.to_string())?;

    response
        .get("content")
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items
                .iter()
                .find(|item| {
                    item.get("type").and_then(|value| value.as_str()) == Some("tool_use")
                        && item.get("name").and_then(|value| value.as_str())
                            == Some("emit_workflow_draft")
                })
                .and_then(|item| item.get("input"))
        })
        .map(ToString::to_string)
        .ok_or_else(|| {
            "Anthropic builder response did not include emit_workflow_draft input.".to_string()
        })
}

fn execute_anthropic_builder_streaming(
    profile: &AgentAuthProfile,
    system_prompt: &str,
    credential_resolver: &dyn AgentCredentialResolver,
    request_id: &str,
    events: &dyn BuilderDraftEventSink,
) -> Result<String, String> {
    let api_key = resolve_profile_credential(profile, credential_resolver)
        .ok_or_else(|| "Anthropic API credential reference is not available.".to_string())?;
    let mut body = anthropic_builder_request_body(profile, system_prompt);
    body["stream"] = serde_json::Value::Bool(true);
    let response = ureq::post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", &api_key)
        .set("anthropic-version", "2023-06-01")
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|error| error.to_string())?;

    read_sse_stream(
        response.into_reader(),
        request_id,
        events,
        sse_delta_from_anthropic_event,
    )
}

fn execute_ollama_builder(
    profile: &AgentAuthProfile,
    system_prompt: &str,
    generator: &dyn OllamaTextGenerator,
) -> Result<String, String> {
    generator.generate(
        profile.model.as_str(),
        system_prompt,
        workflow_draft_schema(),
    )
}

fn builder_command_plan_for_profile(
    profile: &AgentAuthProfile,
    system_prompt: &str,
) -> Result<agent_auth::AgentCommandPlan, String> {
    match profile.runner_kind {
        AgentRunnerKind::CodexCli => Ok(agent_auth::AgentCommandPlan {
            program: "codex".into(),
            args: vec![
                "exec".into(),
                "--json".into(),
                "--ignore-user-config".into(),
                "--sandbox".into(),
                "read-only".into(),
                "--ephemeral".into(),
                "--ignore-rules".into(),
                "--skip-git-repo-check".into(),
                "--model".into(),
                profile.model.clone(),
                system_prompt.into(),
            ],
            env_refs: vec![],
            remove_env: vec![],
            env_allowlist: oauth_cli_env_allowlist("CODEX_HOME"),
            isolate_cwd: true,
        }),
        AgentRunnerKind::ClaudeCodeCli => Ok(agent_auth::AgentCommandPlan {
            program: "claude".into(),
            args: vec![
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--safe-mode".into(),
                "--disable-slash-commands".into(),
                "--no-session-persistence".into(),
                "--permission-mode".into(),
                "dontAsk".into(),
                "--model".into(),
                profile.model.clone(),
                "--effort".into(),
                profile.effort.clone(),
                "--tools=".into(),
                "--disallowedTools=Bash,Edit,Write".into(),
                "--json-schema".into(),
                workflow_draft_schema().to_string(),
                system_prompt.into(),
            ],
            env_refs: vec![],
            remove_env: vec!["ANTHROPIC_API_KEY".into(), "ANTHROPIC_AUTH_TOKEN".into()],
            env_allowlist: oauth_cli_env_allowlist("CLAUDE_CONFIG_DIR"),
            isolate_cwd: true,
        }),
        AgentRunnerKind::OpenAiApi
        | AgentRunnerKind::AnthropicApi
        | AgentRunnerKind::OllamaLocal => {
            agent_auth::command_plan_for_profile(profile, system_prompt)
        }
    }
}

fn oauth_cli_env_allowlist(extra_config_dir: &str) -> Vec<String> {
    [
        "PATH",
        "HOME",
        "USER",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "XDG_CONFIG_HOME",
        extra_config_dir,
    ]
    .iter()
    .map(|value| value.to_string())
    .collect()
}

fn openai_builder_request_body(
    profile: &AgentAuthProfile,
    system_prompt: &str,
) -> serde_json::Value {
    serde_json::json!({
        "model": profile.model,
        "input": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": "Return the workflow draft JSON now." }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "raven_workflow_draft",
                "strict": false,
                "schema": workflow_draft_schema()
            }
        }
    })
}

fn anthropic_builder_request_body(
    profile: &AgentAuthProfile,
    system_prompt: &str,
) -> serde_json::Value {
    serde_json::json!({
        "model": profile.model,
        "max_tokens": 4096,
        "system": system_prompt,
        "messages": [{ "role": "user", "content": "Return the workflow draft JSON now." }],
        "tools": [{
            "name": "emit_workflow_draft",
            "description": "Emit a complete Raven workflow draft envelope.",
            "input_schema": workflow_draft_schema()
        }],
        "tool_choice": { "type": "tool", "name": "emit_workflow_draft" }
    })
}

fn workflow_draft_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "permission_changes", "destination_writes", "diff_json", "definition"],
        "properties": {
            "summary": { "type": "string" },
            "permission_changes": { "type": "array", "items": { "type": "string" } },
            "destination_writes": { "type": "array", "items": { "type": "string" } },
            "diff_json": {
                "type": "array",
                "items": { "type": "object" }
            },
            "definition": { "type": "object" }
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
    credential_resolver: &dyn AgentCredentialResolver,
) -> Option<String> {
    credential_resolver
        .resolve(profile)
        .or_else(|| resolve_env_credential(&profile.credential_ref))
}

fn select_profile<'a>(
    profiles: &'a [AgentAuthProfile],
    builder_profile_id: Option<&str>,
) -> Option<&'a AgentAuthProfile> {
    if let Some(id) = builder_profile_id {
        return profiles.iter().find(|profile| profile.id == id);
    }

    [
        "codex-oauth-local",
        "claude-code-oauth-local",
        "openai-api-key",
        "anthropic-api-key",
    ]
    .iter()
    .find_map(|id| profiles.iter().find(|profile| profile.id == *id))
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
        let path =
            std::env::temp_dir().join(format!("raven-builder-agent-{}", uuid::Uuid::new_v4()));
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

fn execute_plan_streaming(
    plan: &agent_auth::AgentCommandPlan,
    request_id: &str,
    events: &dyn BuilderDraftEventSink,
) -> Result<String, String> {
    execute_plan_streaming_with_timeout(plan, request_id, events, DEFAULT_AGENT_CLI_TIMEOUT)
}

enum StreamReadEvent {
    StdoutLine(String),
    StdoutError(String),
    StdoutDone,
}

fn execute_plan_streaming_with_timeout(
    plan: &agent_auth::AgentCommandPlan,
    request_id: &str,
    events: &dyn BuilderDraftEventSink,
    timeout: Duration,
) -> Result<String, String> {
    let mut command = Command::new(&plan.program);
    command.args(&plan.args);
    apply_plan_environment(&mut command, plan);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let isolated_cwd = if plan.isolate_cwd {
        let path = std::env::temp_dir().join(format!("raven-builder-agent-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        command.current_dir(&path);
        Some(path)
    } else {
        None
    };

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture agent stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture agent stderr".to_string())?;
    let (stdout_tx, stdout_rx) = mpsc::channel();

    let stderr_handle = thread::spawn(move || {
        let mut buffer = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut buffer);
        buffer
    });
    let stdout_handle = thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if stdout_tx.send(StreamReadEvent::StdoutLine(line)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = stdout_tx.send(StreamReadEvent::StdoutError(error.to_string()));
                    return;
                }
            }
        }
        let _ = stdout_tx.send(StreamReadEvent::StdoutDone);
    });

    let mut output = String::new();
    let mut stdout_done = false;
    let mut exit_status = None;
    let started_at = Instant::now();

    while exit_status.is_none() || !stdout_done {
        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            if let Some(path) = isolated_cwd {
                let _ = std::fs::remove_dir_all(path);
            }
            return Err(format!(
                "agent command timed out after {} seconds",
                timeout.as_secs()
            ));
        }

        match stdout_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(StreamReadEvent::StdoutLine(line)) => {
                output.push_str(&line);
                output.push('\n');
                emit_stream_event_from_json_line(request_id, events, &line);
            }
            Ok(StreamReadEvent::StdoutError(error)) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                if let Some(path) = isolated_cwd {
                    let _ = std::fs::remove_dir_all(path);
                }
                return Err(error);
            }
            Ok(StreamReadEvent::StdoutDone) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                stdout_done = true;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if exit_status.is_none() {
            exit_status = child.try_wait().map_err(|error| error.to_string())?;
        }
    }

    let status = exit_status.unwrap_or_else(|| child.wait().expect("child process should wait"));
    let _ = stdout_handle.join();
    let stderr = stderr_handle
        .join()
        .unwrap_or_else(|_| "failed to read agent stderr".to_string());
    if let Some(path) = isolated_cwd {
        let _ = std::fs::remove_dir_all(path);
    }
    if status.success() {
        Ok(output)
    } else {
        Err(stderr)
    }
}

fn apply_plan_environment(command: &mut Command, plan: &agent_auth::AgentCommandPlan) {
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
}

fn emit_stream_event_from_json_line(
    request_id: &str,
    events: &dyn BuilderDraftEventSink,
    line: &str,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let raw_event_type = value
        .get("type")
        .and_then(|event_type| event_type.as_str())
        .unwrap_or("jsonl");

    if let Some(delta) = text_delta_from_json_stream_event(&value) {
        emit_builder_stream_event(
            events,
            request_id,
            "text_delta",
            Some(delta),
            Some(raw_event_type),
            "Builder output",
            "Streaming assistant output.",
        );
        return;
    }

    let (event_kind, title, detail) = match raw_event_type {
        "thread.started" | "turn.started" | "system" => (
            "lifecycle",
            "Agent session started",
            "The selected agent started processing.",
        ),
        "turn.completed" | "message_stop" => (
            "completed",
            "Agent stream completed",
            "The selected agent finished streaming output.",
        ),
        "turn.failed" | "error" => (
            "failed",
            "Agent stream failed",
            "The selected agent reported a streaming error.",
        ),
        "item.started" => (
            "tool_call_started",
            "Tool started",
            "The agent started a tool call.",
        ),
        "item.completed" => (
            "tool_call_completed",
            "Tool completed",
            "The agent completed a tool call.",
        ),
        _ => ("lifecycle", "Agent event", raw_event_type),
    };

    emit_builder_stream_event(
        events,
        request_id,
        event_kind,
        None,
        Some(raw_event_type),
        title,
        detail,
    );
}

fn text_delta_from_json_stream_event(value: &serde_json::Value) -> Option<String> {
    value
        .get("item")
        .and_then(|item| item.get("text"))
        .and_then(|text| text.as_str())
        .filter(|_| {
            value.get("type").and_then(|event_type| event_type.as_str()) == Some("item.completed")
                && value
                    .get("item")
                    .and_then(|item| item.get("type"))
                    .and_then(|item_type| item_type.as_str())
                    == Some("agent_message")
        })
        .map(str::to_string)
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| content.as_array())
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        item.get("text")
                            .and_then(|text| text.as_str())
                            .map(str::to_string)
                    })
                })
        })
        .or_else(|| {
            value
                .get("delta")
                .and_then(|delta| delta.get("text"))
                .and_then(|text| text.as_str())
                .map(str::to_string)
        })
}

#[derive(Debug, Clone, PartialEq)]
struct SseEvent {
    event_type: Option<String>,
    data: serde_json::Value,
}

fn parse_sse_events(input: &str) -> Vec<SseEvent> {
    input
        .split("\n\n")
        .filter_map(|chunk| {
            let mut event_type = None;
            let mut data_lines = Vec::new();
            for line in chunk.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    event_type = Some(value.trim().to_string());
                } else if let Some(value) = line.strip_prefix("data:") {
                    data_lines.push(value.trim_start());
                }
            }
            if data_lines.is_empty() {
                return None;
            }
            let data = data_lines.join("\n");
            let data =
                serde_json::from_str(&data).unwrap_or_else(|_| serde_json::json!({ "text": data }));
            Some(SseEvent { event_type, data })
        })
        .collect()
}

fn read_sse_stream<R: Read>(
    mut reader: R,
    request_id: &str,
    events: &dyn BuilderDraftEventSink,
    delta_from_event: fn(&SseEvent) -> SseDelta,
) -> Result<String, String> {
    let mut pending = String::new();
    let mut output = String::new();
    let mut buffer = [0_u8; 8192];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        pending.push_str(&String::from_utf8_lossy(&buffer[..read]));
        let complete_len = pending
            .rfind("\n\n")
            .map(|index| index + 2)
            .unwrap_or_default();
        if complete_len == 0 {
            continue;
        }
        let complete = pending[..complete_len].to_string();
        pending = pending[complete_len..].to_string();
        for event in parse_sse_events(&complete) {
            match delta_from_event(&event) {
                SseDelta::Text(delta) | SseDelta::Json(delta) => {
                    output.push_str(&delta);
                    emit_builder_stream_event(
                        events,
                        request_id,
                        "text_delta",
                        Some(delta),
                        event.event_type.as_deref(),
                        "Builder output",
                        "Streaming assistant output.",
                    );
                }
                SseDelta::Completed => emit_builder_stream_event(
                    events,
                    request_id,
                    "completed",
                    None,
                    event.event_type.as_deref(),
                    "Agent stream completed",
                    "The selected agent finished streaming output.",
                ),
                SseDelta::Failed(message) => {
                    emit_builder_stream_event(
                        events,
                        request_id,
                        "failed",
                        None,
                        event.event_type.as_deref(),
                        "Agent stream failed",
                        &message,
                    );
                    return Err(message);
                }
                SseDelta::Ignore => {}
            }
        }
    }

    if !pending.trim().is_empty() {
        for event in parse_sse_events(&(pending + "\n\n")) {
            match delta_from_event(&event) {
                SseDelta::Text(delta) | SseDelta::Json(delta) => output.push_str(&delta),
                SseDelta::Failed(message) => return Err(message),
                SseDelta::Completed | SseDelta::Ignore => {}
            }
        }
    }

    Ok(output)
}

enum SseDelta {
    Text(String),
    Json(String),
    Completed,
    Failed(String),
    Ignore,
}

fn sse_delta_from_openai_event(event: &SseEvent) -> SseDelta {
    let event_type = event
        .event_type
        .as_deref()
        .or_else(|| event.data.get("type").and_then(|value| value.as_str()))
        .unwrap_or("");
    match event_type {
        "response.output_text.delta" => event
            .data
            .get("delta")
            .and_then(|value| value.as_str())
            .map(|delta| SseDelta::Text(delta.to_string()))
            .unwrap_or(SseDelta::Ignore),
        "response.function_call_arguments.delta" => event
            .data
            .get("delta")
            .and_then(|value| value.as_str())
            .map(|delta| SseDelta::Json(delta.to_string()))
            .unwrap_or(SseDelta::Ignore),
        "response.completed" => SseDelta::Completed,
        "response.failed" | "error" => SseDelta::Failed(
            event
                .data
                .get("message")
                .or_else(|| event.data.pointer("/error/message"))
                .and_then(|value| value.as_str())
                .unwrap_or("OpenAI streaming response failed.")
                .to_string(),
        ),
        _ => SseDelta::Ignore,
    }
}

fn sse_delta_from_anthropic_event(event: &SseEvent) -> SseDelta {
    let event_type = event
        .event_type
        .as_deref()
        .or_else(|| event.data.get("type").and_then(|value| value.as_str()))
        .unwrap_or("");
    match event_type {
        "content_block_delta" => {
            let delta = event.data.get("delta").unwrap_or(&serde_json::Value::Null);
            match delta.get("type").and_then(|value| value.as_str()) {
                Some("text_delta") => delta
                    .get("text")
                    .and_then(|value| value.as_str())
                    .map(|text| SseDelta::Text(text.to_string()))
                    .unwrap_or(SseDelta::Ignore),
                Some("input_json_delta") => delta
                    .get("partial_json")
                    .and_then(|value| value.as_str())
                    .map(|json| SseDelta::Json(json.to_string()))
                    .unwrap_or(SseDelta::Ignore),
                _ => SseDelta::Ignore,
            }
        }
        "message_stop" => SseDelta::Completed,
        "error" => SseDelta::Failed(
            event
                .data
                .pointer("/error/message")
                .and_then(|value| value.as_str())
                .unwrap_or("Anthropic streaming response failed.")
                .to_string(),
        ),
        _ => SseDelta::Ignore,
    }
}

fn extract_json_object(output: &str) -> Option<String> {
    for line in output.lines().rev() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(json) = extract_json_object_from_event(&value) {
            return Some(json);
        }
    }

    let trimmed = output.trim();
    let value = serde_json::from_str::<serde_json::Value>(trimmed).ok()?;
    json_string_from_draft_candidate(&value)
}

fn extract_json_object_from_event(value: &serde_json::Value) -> Option<String> {
    if is_draft_envelope(value) {
        return Some(value.to_string());
    }

    if value.get("type").and_then(|item_type| item_type.as_str()) == Some("item.completed")
        && value
            .get("item")
            .and_then(|item| item.get("type"))
            .and_then(|item_type| item_type.as_str())
            == Some("agent_message")
    {
        let text = value
            .get("item")
            .and_then(|item| item.get("text"))
            .and_then(|text| text.as_str())?;
        return json_string_from_text(text);
    }

    if let Some(structured_output) = value.get("structured_output") {
        return json_string_from_draft_candidate(structured_output);
    }

    if let Some(result) = value.get("result").and_then(|result| result.as_str()) {
        if let Some(json) = json_string_from_text(result) {
            return Some(json);
        }
    }

    let content = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_array())?;
    for block in content.iter().rev() {
        if block.get("type").and_then(|block_type| block_type.as_str()) == Some("tool_use") {
            if let Some(input) = block.get("input") {
                if let Some(json) = json_string_from_draft_candidate(input) {
                    return Some(json);
                }
            }
        }
        if let Some(text) = block.get("text").and_then(|text| text.as_str()) {
            if let Some(json) = json_string_from_text(text) {
                return Some(json);
            }
        }
    }

    None
}

fn json_string_from_text(text: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) {
        if let Some(json) = json_string_from_draft_candidate(&value) {
            return Some(json);
        }
    }

    if let Some(fenced) = extract_fenced_json(text) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&fenced) {
            if let Some(json) = json_string_from_draft_candidate(&value) {
                return Some(json);
            }
        }
    }

    for candidate in balanced_json_candidates(text) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
            if let Some(json) = json_string_from_draft_candidate(&value) {
                return Some(json);
            }
        }
    }

    None
}

fn json_string_from_draft_candidate(value: &serde_json::Value) -> Option<String> {
    if is_draft_envelope(value) {
        Some(value.to_string())
    } else {
        None
    }
}

fn is_draft_envelope(value: &serde_json::Value) -> bool {
    value.get("summary").is_some()
        && value.get("permission_changes").is_some()
        && value.get("destination_writes").is_some()
        && value.get("diff_json").is_some()
        && value.get("definition").is_some()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_auth::{AgentAuthMode, AgentAuthProfile, AgentRunnerKind};
    use crate::models::{
        WorkflowDefaults, WorkflowScheduleDefinition, WorkflowStepDefinition, WorkflowStepKind,
    };
    use crate::workflow;

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
            summary: "local cli".into(),
        }
    }

    #[test]
    fn builder_prompt_includes_schema_capabilities_and_safety_rules() {
        let prompt = builder_system_prompt("Create a daily journal", &profile());

        assert!(prompt.contains("Raven Workflow schema v0.1.0"));
        assert!(prompt.contains("Provider capabilities"));
        assert!(prompt.contains("local_git.recent_activity"));
        assert!(prompt.contains("open_meteo.current_weather"));
        assert!(prompt.contains("agent.run_task"));
        assert!(prompt.contains("Use agent_task for open-ended natural-language objectives"));
        assert!(prompt.contains("NestWeaver"));
        assert!(prompt.contains("approval"));
        assert!(prompt.contains("disallow inline arbitrary code"));
    }

    #[test]
    fn builder_prompt_includes_deterministic_capabilities_and_policy() {
        let prompt = builder_system_prompt("Check website status", &profile());

        assert!(prompt.contains("Deterministic-first routing policy"));
        assert!(prompt.contains("http_probe.check_urls"));
        assert!(prompt.contains("weather.forecast_24h"));
        assert!(prompt.contains("news.trending"));
        assert!(prompt.contains("status\": \"implemented\""));
        assert!(prompt.contains(
            "If an implemented deterministic capability can satisfy a step, use it before agent.run_task"
        ));
        assert!(prompt.contains("do not generate provider_action steps for them"));
        assert!(prompt.contains("For weather/news briefs"));
        assert!(prompt.contains("agent.run_task may summarize deterministic outputs"));
        assert!(prompt.contains(
            "write Markdown from prior deterministic output in $steps.check-sites.results and do not re-check websites"
        ));
        assert!(prompt.contains("allowed_tools []"));
    }

    #[test]
    fn builder_prompt_includes_revision_context_when_previous_draft_is_supplied() {
        let previous_draft = WorkflowDraftRevisionContext {
            source_label: "Initial project pulse draft.".into(),
            validation_errors: vec![],
            planner_rationale: None,
            definition: workflow::daily_work_journal(),
        };

        let prompt = builder_system_prompt_with_revision(
            "Make the schedule weekdays at 4pm and keep the artifact sink.",
            &profile(),
            Some(&previous_draft),
        );

        assert!(prompt.contains("Previous draft context"));
        assert!(prompt.contains("Initial project pulse draft."));
        assert!(prompt.contains("Revision behavior"));
        assert!(prompt.contains("Treat the user request as feedback on the previous draft"));
        assert!(prompt.contains("daily-work-journal"));
        assert!(prompt.contains("Do not infer CSV headers"));
    }

    #[test]
    fn parses_agent_structured_draft_with_diff_destinations_and_validation() {
        let definition = workflow::daily_work_journal();
        let output = serde_json::json!({
            "summary": "Daily Work Journal collects local Git context and writes Markdown locally.",
            "permission_changes": ["git:read", "llm:generate", "artifact:write"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "replace", "path": "/schedule/local_time", "value": "17:00" }],
            "definition": definition
        })
        .to_string();

        let draft =
            parse_agent_draft("Create a daily journal", "codex-oauth-local", &output).unwrap();

        assert_eq!(
            draft.builder_profile_id.as_deref(),
            Some("codex-oauth-local")
        );
        assert_eq!(draft.approval_status, "needs_review");
        assert_eq!(draft.destination_writes, vec!["local-app"]);
        assert!(draft.validation_errors.is_empty());
        assert_eq!(draft.definition.id, "daily-work-journal");
    }

    #[test]
    fn parses_deterministic_website_check_draft_shape_into_valid_draft() {
        let output = serde_json::json!({
            "summary": "Website Status Report checks URLs deterministically and writes a Markdown report.",
            "permission_changes": ["network:read", "llm:generate", "artifact:write"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "template", "workflow_id": "website-status-report" }],
            "definition": RavenWorkflow {
                schema_version: "0.1.0".into(),
                id: "website-status-report".into(),
                name: "Website Status Report".into(),
                description: "Checks websites deterministically, compiles a report, and stores it locally.".into(),
                permissions: vec!["network:read".into(), "llm:generate".into(), "artifact:write".into()],
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
                            "urls": ["https://example.com", "https://www.rust-lang.org"],
                            "timeout_ms": 10000,
                            "accepted_status_codes": [200, 201, 202, 203, 204]
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
                            "objective": "Write Markdown from prior deterministic output in $steps.check-sites.results and do not re-check websites.",
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
                        name: "Write artifact".into(),
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
        })
        .to_string();

        let draft =
            parse_agent_draft("Check these websites", "codex-oauth-local", &output).unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert!(draft.validation_errors.is_empty());
        assert_eq!(draft.definition.steps.len(), 3);
        assert_eq!(draft.definition.steps[0].id, "check-sites");
        assert_eq!(draft.definition.steps[0].provider, "http_probe");
        assert_eq!(draft.definition.steps[0].action, "check_urls");
        assert_eq!(draft.definition.steps[1].id, "compile-report");
        assert_eq!(draft.definition.steps[1].provider, "agent");
        assert_eq!(draft.definition.steps[1].action, "run_task");
        assert_eq!(draft.definition.steps[1].depends_on, vec!["check-sites"]);
        assert_eq!(
            draft.definition.steps[1].inputs["allowed_tools"],
            serde_json::json!([])
        );
        assert_eq!(draft.definition.steps[2].id, "write-artifact");
        assert_eq!(draft.definition.steps[2].provider, "local_app");
        assert_eq!(draft.definition.steps[2].depends_on, vec!["compile-report"]);
        assert_eq!(
            draft.definition.steps[2].inputs["artifact"],
            "$steps.compile-report.artifact"
        );
    }

    #[test]
    fn invalid_agent_definition_is_returned_as_invalid_draft() {
        let mut definition = workflow::daily_work_journal();
        definition.steps[1].inline_code = Some("eval()".into());
        let output = serde_json::json!({
            "summary": "Invalid workflow",
            "permission_changes": ["git:read"],
            "destination_writes": ["local-app"],
            "diff_json": [],
            "definition": definition
        })
        .to_string();

        let draft =
            parse_agent_draft("Create unsafe workflow", "codex-oauth-local", &output).unwrap();

        assert_eq!(draft.validation_status, "invalid");
        assert_eq!(draft.approval_status, "needs_review");
        assert!(draft
            .validation_errors
            .iter()
            .any(|error| error.contains("inline arbitrary code")));
    }

    struct FakeExecutor {
        output: String,
    }

    impl AgentExecutor for FakeExecutor {
        fn execute(
            &self,
            _profile: &AgentAuthProfile,
            _system_prompt: &str,
        ) -> Result<String, String> {
            Ok(self.output.clone())
        }
    }

    #[derive(Default)]
    struct RecordingBuilderEvents {
        events: std::cell::RefCell<Vec<BuilderDraftEvent>>,
    }

    impl BuilderDraftEventSink for RecordingBuilderEvents {
        fn emit(&self, event: BuilderDraftEvent) {
            self.events.borrow_mut().push(event);
        }
    }

    #[test]
    fn emits_builder_lifecycle_events_for_successful_agent_draft() {
        let output = serde_json::json!({
            "summary": "Morning Brief draft ready.",
            "permission_changes": ["git:read", "artifact:read", "artifact:write", "llm:generate"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "template", "workflow_id": "morning-brief" }],
            "definition": workflow::morning_brief()
        })
        .to_string();
        let events = RecordingBuilderEvents::default();

        let draft = draft_from_profile_or_template_with_events(
            "Create a morning brief",
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor { output },
            "request-123",
            &events,
        )
        .unwrap();

        let events = events.events.borrow();
        assert_eq!(draft.definition.id, "morning-brief");
        assert!(events.iter().all(|event| event.request_id == "request-123"));
        assert!(events.iter().any(|event| {
            event.phase == "thinking"
                && event.step_id == "profile"
                && event.status == "complete"
                && event.detail.contains("Codex OAuth")
        }));
        assert!(events.iter().any(|event| {
            event.phase == "thinking" && event.step_id == "context" && event.status == "complete"
        }));
        assert!(events.iter().any(|event| {
            event.phase == "typing" && event.step_id == "draft" && event.status == "active"
        }));
        assert!(events.iter().any(|event| {
            event.phase == "complete"
                && event.step_id == "validation"
                && event.status == "complete"
                && event.detail.contains("Schema accepted")
        }));
    }

    #[test]
    fn invalid_agent_draft_falls_back_to_valid_template() {
        let mut definition = workflow::prompt_native_agent_workflow("Write a morning brief.");
        definition.id = "invalid-morning-brief".into();
        definition.steps[0].inputs["objective"] = serde_json::json!("");
        definition.steps.insert(
            0,
            WorkflowStepDefinition {
                kind: WorkflowStepKind::ProviderAction,
                id: "collect-context".into(),
                name: "Collect context".into(),
                provider: "local_git".into(),
                action: "recent_activity".into(),
                depends_on: vec![],
                permissions: vec!["git:read".into()],
                inputs: serde_json::json!({}),
                llm_profile_ref: None,
                destination_ref: None,
                inline_code: None,
                parallel: None,
            },
        );
        definition.steps[1].depends_on = vec!["collect-context".into()];
        let output = serde_json::json!({
            "summary": "Invalid morning brief draft.",
            "permission_changes": ["git:read", "artifact:write", "llm:generate"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "template", "workflow_id": "morning-brief" }],
            "definition": definition
        })
        .to_string();
        let events = RecordingBuilderEvents::default();

        let draft = draft_from_profile_or_template_with_events(
            "Create a morning brief",
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor { output },
            "request-invalid",
            &events,
        )
        .unwrap();

        assert_eq!(draft.definition.id, "morning-brief");
        assert_eq!(draft.validation_status, "valid");
        assert!(draft.summary.contains("Builder fallback"));
        let events = events.events.borrow();
        assert!(events.iter().any(|event| {
            event.phase == "failed"
                && event.step_id == "validation"
                && event
                    .detail
                    .contains("Step ask-ai agent_task must include non-empty inputs.objective")
        }));
        assert!(events.iter().any(|event| {
            event.phase == "complete" && event.step_id == "validation" && event.status == "complete"
        }));
    }

    #[test]
    fn revision_fallback_preserves_previous_draft_instead_of_reparsing_feedback() {
        let previous_draft = WorkflowDraftRevisionContext {
            source_label: "Initial daily journal draft.".into(),
            validation_errors: vec![],
            planner_rationale: None,
            definition: workflow::daily_work_journal(),
        };
        let events = RecordingBuilderEvents::default();

        let draft = draft_from_profile_or_template_with_revision_events(
            "Revise this workflow to be clearer. Rows: Acme,active,42",
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor {
                output: "not json".into(),
            },
            "request-revision-fallback",
            Some(&previous_draft),
            &events,
        )
        .unwrap();

        assert_eq!(draft.definition.id, "daily-work-journal");
        assert_eq!(
            draft.summary,
            "Builder fallback kept the previous draft because revision generation was unavailable."
        );
        assert_eq!(draft.validation_status, "valid");
        assert_eq!(draft.diff_json[0]["changed"], serde_json::json!(false));
    }

    #[test]
    fn valid_builder_revision_is_accepted_and_preserves_previous_data() {
        let initial_draft = workflow::draft_from_prompt(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500",
        )
        .unwrap();
        let previous_draft = WorkflowDraftRevisionContext {
            source_label: initial_draft.summary,
            validation_errors: vec![],
            planner_rationale: initial_draft.planner_rationale,
            definition: initial_draft.definition,
        };
        let mut revised_definition = previous_draft.definition.clone();
        let transform = revised_definition
            .steps
            .iter_mut()
            .find(|step| step.provider == "data" && step.action == "transform_json")
            .expect("expected transform step");
        transform.inputs["filter_equals"] = serde_json::json!({ "status": "inactive" });
        let output = serde_json::json!({
            "summary": "CSV Data Summary updates the previous draft to filter inactive records.",
            "permission_changes": revised_definition.permissions.clone(),
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "replace", "path": "/steps/transform-data/inputs/filter_equals", "changed": true }],
            "definition": revised_definition
        })
        .to_string();
        let events = RecordingBuilderEvents::default();

        let draft = draft_from_profile_or_template_with_revision_events(
            "Change the existing workflow to filter status=inactive instead. Keep the same CSV rows.",
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor { output },
            "request-valid-revision",
            Some(&previous_draft),
            &events,
        )
        .unwrap();

        let parse_csv = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "parse_csv")
            .expect("expected parse step");
        let transform = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "data" && step.action == "transform_json")
            .expect("expected transform step");
        assert_eq!(
            parse_csv.inputs["content"],
            serde_json::json!(
                "name,status,revenue\nAcme,active,1200\nBeta,inactive,900\nZen,active,1500"
            )
        );
        assert_eq!(
            transform.inputs["filter_equals"],
            serde_json::json!({ "status": "inactive" })
        );
        assert_eq!(draft.validation_status, "valid");
        assert!(!draft.summary.contains("Builder fallback"));
    }

    #[test]
    fn valid_generic_agent_draft_for_seo_prompt_is_replaced_with_deterministic_first_draft() {
        let output = serde_json::json!({
            "summary": "Generic agent SEO audit.",
            "permission_changes": ["llm:generate", "network:read", "artifact:write"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "template", "workflow_id": "agent-seo-audit" }],
            "definition": workflow::prompt_native_agent_workflow(
                "Create a manual SEO audit workflow for https://kehl.io that deterministically fetches the page, robots.txt, and sitemap, extracts metadata and links, then uses an agent only at the final step to write a concise Markdown SEO recommendations artifact.",
            )
        })
        .to_string();
        let events = RecordingBuilderEvents::default();

        let draft = draft_from_profile_or_template_with_events(
            "Create a manual SEO audit workflow for https://kehl.io that deterministically fetches the page, robots.txt, and sitemap, extracts metadata and links, then uses an agent only at the final step to write a concise Markdown SEO recommendations artifact.",
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor { output },
            "request-deterministic-first",
            &events,
        )
        .unwrap();

        assert_eq!(draft.validation_status, "valid");
        assert_eq!(draft.definition.id, "seo-audit");
        assert!(draft
            .definition
            .steps
            .iter()
            .any(|step| { step.provider == "web" && step.action == "fetch_page" }));
        assert!(draft
            .definition
            .steps
            .iter()
            .any(|step| { step.provider == "seo" && step.action == "audit_metadata" }));
        assert!(draft
            .definition
            .steps
            .iter()
            .any(|step| { step.provider == "seo" && step.action == "audit_links" }));
        let agent_steps = draft
            .definition
            .steps
            .iter()
            .filter(|step| step.provider == "agent")
            .collect::<Vec<_>>();
        assert_eq!(agent_steps.len(), 1);
        assert_eq!(
            agent_steps[0].inputs["allowed_tools"],
            serde_json::json!([])
        );
    }

    #[test]
    fn deterministic_seo_draft_with_web_enabled_agent_is_replaced() {
        let prompt = "Create a manual SEO audit workflow for https://kehl.io that deterministically fetches the page, robots.txt, and sitemap, extracts metadata and links, then uses an agent only at the final step to write a concise Markdown SEO recommendations artifact.";
        let mut definition = workflow::deterministic_first_workflow_for_prompt(prompt).unwrap();
        let agent_step = definition
            .steps
            .iter_mut()
            .find(|step| step.provider == "agent" && step.action == "run_task")
            .unwrap();
        agent_step.permissions = vec!["llm:generate".into(), "network:read".into()];
        agent_step.inputs["allowed_tools"] = serde_json::json!(["web"]);

        let output = serde_json::json!({
            "summary": "Deterministic SEO audit with a browsing agent.",
            "permission_changes": ["llm:generate", "network:read", "data:read", "artifact:write"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "template", "workflow_id": "seo-audit" }],
            "definition": definition
        })
        .to_string();
        let events = RecordingBuilderEvents::default();

        let draft = draft_from_profile_or_template_with_events(
            prompt,
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor { output },
            "request-deterministic-agent-scope",
            &events,
        )
        .unwrap();

        let agent_steps = draft
            .definition
            .steps
            .iter()
            .filter(|step| step.provider == "agent")
            .collect::<Vec<_>>();
        assert_eq!(agent_steps.len(), 1);
        assert_eq!(agent_steps[0].permissions, vec!["llm:generate"]);
        assert_eq!(
            agent_steps[0].inputs["allowed_tools"],
            serde_json::json!([])
        );
        assert!(draft.summary.starts_with("Deterministic-first draft:"));
    }

    #[test]
    fn valid_generic_agent_draft_for_weather_news_prompt_is_replaced_with_catalog_plan() {
        let prompt = "Create a morning brief report that collects the next 24 hour Denver weather forecast and trending news, then summarizes the planning implications.";
        let output = serde_json::json!({
            "summary": "Generic morning brief agent.",
            "permission_changes": ["llm:generate", "network:read", "artifact:write"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "template", "workflow_id": "agent-morning-brief" }],
            "definition": workflow::prompt_native_agent_workflow(prompt)
        })
        .to_string();
        let events = RecordingBuilderEvents::default();

        let draft = draft_from_profile_or_template_with_events(
            prompt,
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor { output },
            "request-catalog-deterministic-first",
            &events,
        )
        .unwrap();

        let provider_actions = draft
            .definition
            .steps
            .iter()
            .map(|step| (step.provider.as_str(), step.action.as_str()))
            .collect::<Vec<_>>();
        assert!(provider_actions.contains(&("weather", "forecast_24h")));
        assert!(provider_actions.contains(&("news", "trending")));
        let agent_steps = draft
            .definition
            .steps
            .iter()
            .filter(|step| step.provider == "agent")
            .collect::<Vec<_>>();
        assert_eq!(agent_steps.len(), 1);
        assert_eq!(
            agent_steps[0].inputs["allowed_tools"],
            serde_json::json!([])
        );
        assert!(draft.summary.starts_with("Deterministic-first draft:"));
    }

    #[test]
    fn deterministic_builder_draft_with_wrong_news_query_is_replaced() {
        let prompt =
            "Create a brief: news search for AI regulation updates, then summarize implications.";
        let mut definition = workflow::deterministic_first_workflow_for_prompt(prompt).unwrap();
        let news_step = definition
            .steps
            .iter_mut()
            .find(|step| step.provider == "news" && step.action == "search")
            .expect("news search step should exist");
        news_step.inputs["query"] = serde_json::json!("wrong topic");

        let output = serde_json::json!({
            "summary": "Deterministic-looking news draft.",
            "permission_changes": ["llm:generate", "network:read", "artifact:write"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "template", "workflow_id": "news-brief" }],
            "definition": definition
        })
        .to_string();
        let events = RecordingBuilderEvents::default();

        let draft = draft_from_profile_or_template_with_events(
            prompt,
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor { output },
            "request-deterministic-news-query",
            &events,
        )
        .unwrap();

        let news_step = draft
            .definition
            .steps
            .iter()
            .find(|step| step.provider == "news" && step.action == "search")
            .expect("news search step should exist");
        assert_eq!(news_step.inputs["query"], "AI regulation updates");
        assert!(draft.planner_rationale.is_some());
        assert!(draft.summary.starts_with("Deterministic-first draft:"));
    }

    #[test]
    fn deterministic_builder_draft_with_extra_provider_action_is_replaced() {
        let prompt =
            "Create a brief: news search for AI regulation updates, then summarize implications.";
        let mut builder_draft = workflow::draft_from_prompt(prompt).unwrap();
        assert!(builder_draft.planner_rationale.is_some());
        builder_draft.definition.steps.push(WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "extra-headlines".into(),
            name: "Fetch extra headlines".into(),
            provider: "news".into(),
            action: "trending".into(),
            depends_on: vec![],
            permissions: vec!["network:read".into()],
            inputs: serde_json::json!({ "max_items": 5 }),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        });

        let draft = deterministic_first_replacement(prompt, &builder_draft, "codex-oauth-local")
            .expect("extra deterministic provider action should trigger replacement");

        assert!(draft
            .definition
            .steps
            .iter()
            .any(|step| step.provider == "news" && step.action == "search"));
        assert!(!draft
            .definition
            .steps
            .iter()
            .any(|step| step.provider == "news" && step.action == "trending"));
        assert!(draft.summary.starts_with("Deterministic-first draft:"));
    }

    #[test]
    fn deterministic_provider_steps_reject_extra_provider_action() {
        let prompt =
            "Create a brief: news search for AI regulation updates, then summarize implications.";
        let required = workflow::deterministic_first_workflow_for_prompt(prompt).unwrap();
        let mut candidate = required.clone();
        candidate.steps.push(WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: "extra-headlines".into(),
            name: "Fetch extra headlines".into(),
            provider: "news".into(),
            action: "trending".into(),
            depends_on: vec![],
            permissions: vec!["network:read".into()],
            inputs: serde_json::json!({ "max_items": 5 }),
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        });

        assert!(!deterministic_provider_steps_satisfied(
            &candidate, &required
        ));
    }

    #[test]
    fn streaming_cli_plan_emits_jsonl_deltas_before_returning_output() {
        let events = RecordingBuilderEvents::default();
        let draft_json = serde_json::json!({
            "summary": "Streamed draft chunk from CLI.",
            "permission_changes": ["git:read", "artifact:write", "llm:generate"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "template", "workflow_id": "morning-brief" }],
            "definition": workflow::morning_brief()
        })
        .to_string();
        let line_one = serde_json::json!({ "type": "thread.started", "thread_id": "thread-1" });
        let line_two = serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "agent_message",
                "text": draft_json
            }
        });
        let script = format!(
            "printf '%s\\n' '{}' '{}'",
            line_one.to_string().replace('\'', "'\\''"),
            line_two.to_string().replace('\'', "'\\''")
        );
        let plan = agent_auth::AgentCommandPlan {
            program: "sh".into(),
            args: vec!["-c".into(), script],
            env_refs: vec![],
            remove_env: vec![],
            env_allowlist: vec!["PATH".into()],
            isolate_cwd: true,
        };

        let output = execute_plan_streaming(&plan, "request-stream", &events).unwrap();

        assert!(output.contains("Streamed draft chunk from CLI."));
        let events = events.events.borrow();
        assert!(events.iter().any(|event| {
            event.event_kind.as_deref() == Some("lifecycle")
                && event.raw_event_type.as_deref() == Some("thread.started")
        }));
        assert!(events.iter().any(|event| {
            event.event_kind.as_deref() == Some("text_delta")
                && event
                    .delta
                    .as_deref()
                    .is_some_and(|delta| delta.contains("Streamed draft chunk from CLI."))
        }));
    }

    #[test]
    fn streaming_cli_plan_times_out_when_agent_never_finishes() {
        let events = RecordingBuilderEvents::default();
        let plan = agent_auth::AgentCommandPlan {
            program: "sh".into(),
            args: vec!["-c".into(), "sleep 2".into()],
            env_refs: vec![],
            remove_env: vec![],
            env_allowlist: vec!["PATH".into()],
            isolate_cwd: true,
        };

        let result = execute_plan_streaming_with_timeout(
            &plan,
            "request-timeout",
            &events,
            Duration::from_millis(100),
        );

        assert!(result
            .unwrap_err()
            .contains("agent command timed out after 0 seconds"));
    }

    #[test]
    fn openai_sse_parser_extracts_text_delta_events() {
        let chunk = "event: response.output_text.delta\n\
data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n\
event: response.completed\n\
data: {\"type\":\"response.completed\"}\n\n";

        let events = parse_sse_events(chunk);

        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].event_type.as_deref(),
            Some("response.output_text.delta")
        );
        assert_eq!(events[0].data["delta"], "hello");
        assert_eq!(events[1].event_type.as_deref(), Some("response.completed"));
    }

    #[test]
    fn openai_builder_request_uses_typed_non_strict_schema() {
        let body = openai_builder_request_body(&profile(), "Build a workflow.");
        let format = &body["text"]["format"];

        assert_eq!(format["type"], "json_schema");
        assert_ne!(format["strict"].as_bool(), Some(true));
        assert_eq!(
            format["schema"]["properties"]["diff_json"],
            serde_json::json!({
                "type": "array",
                "items": { "type": "object" }
            })
        );
        assert_eq!(
            format["schema"]["properties"]["definition"],
            serde_json::json!({ "type": "object" })
        );
    }

    #[test]
    fn available_api_profile_uses_agent_executor_structured_output() {
        let mut api_profile = profile();
        api_profile.id = "openai-api-key".into();
        api_profile.runner_kind = AgentRunnerKind::OpenAiApi;
        api_profile.auth_mode = AgentAuthMode::ApiKeyEnv;
        api_profile.credential_ref = "env:OPENAI_API_KEY".into();
        api_profile.status = "available".into();
        let output = serde_json::json!({
            "summary": "Morning Brief draft ready.",
            "permission_changes": ["git:read", "artifact:read", "artifact:write", "llm:generate"],
            "destination_writes": ["local-app"],
            "diff_json": [{ "op": "template", "workflow_id": "morning-brief" }],
            "definition": workflow::morning_brief()
        })
        .to_string();

        let draft = draft_from_profile_or_template_with_executor(
            "Create a morning brief",
            &[api_profile],
            Some("openai-api-key"),
            &FakeExecutor { output },
        )
        .unwrap();

        assert_eq!(draft.definition.id, "morning-brief");
        assert_eq!(draft.builder_profile_id.as_deref(), Some("openai-api-key"));
        assert!(draft.summary.contains("Morning Brief draft"));
        assert!(draft.validation_errors.is_empty());
    }

    #[test]
    fn parses_codex_jsonl_agent_message_as_structured_draft() {
        let output = format!(
            "{}\n{}\n{}\n{}",
            "2026-06-19T05:45:45Z WARN plugin diagnostic before jsonl",
            serde_json::json!({ "type": "thread.started", "thread_id": "thread-1" }),
            serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": format!(
                        "Here is the workflow draft:\n```json\n{}\n```",
                        serde_json::json!({
                            "summary": "Weather workflow draft ready.",
                            "permission_changes": ["weather:read", "artifact:write"],
                            "destination_writes": ["local-app"],
                            "diff_json": [{ "op": "template", "workflow_id": "current-weather" }],
                            "definition": workflow::current_weather()
                        })
                    )
                }
            }),
            serde_json::json!({ "type": "turn.completed" })
        );

        let draft = draft_from_profile_or_template_with_executor(
            "Create a weather workflow",
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor { output },
        )
        .unwrap();

        assert_eq!(
            draft.builder_profile_id.as_deref(),
            Some("codex-oauth-local")
        );
        assert!(draft.definition.id.starts_with("weather-brief-"));
        assert_eq!(draft.validation_status, "valid");
        assert!(draft.summary.starts_with("Deterministic-first draft:"));
        assert!(draft
            .definition
            .steps
            .iter()
            .any(|step| step.provider == "weather" && step.action == "forecast_24h"));
    }

    #[test]
    fn parses_claude_structured_output_as_workflow_draft() {
        let output = format!(
            "{}\n{}",
            "diagnostic prefix should be ignored",
            serde_json::json!({
                "type": "result",
                "subtype": "success",
                "result": "Structured output provided successfully.",
                "structured_output": {
                    "summary": "Weather workflow draft ready.",
                    "permission_changes": ["weather:read", "artifact:write"],
                    "destination_writes": ["local-app"],
                    "diff_json": [{ "op": "template", "workflow_id": "current-weather" }],
                    "definition": workflow::current_weather()
                }
            })
        );

        let draft = draft_from_profile_or_template_with_executor(
            "Create a weather workflow",
            &[profile()],
            Some("codex-oauth-local"),
            &FakeExecutor { output },
        )
        .unwrap();

        assert!(draft.definition.id.starts_with("weather-brief-"));
        assert_eq!(draft.validation_status, "valid");
        assert!(draft.summary.starts_with("Deterministic-first draft:"));
        assert!(draft
            .definition
            .steps
            .iter()
            .any(|step| step.provider == "weather" && step.action == "forecast_24h"));
    }

    struct FakeCredentialResolver;

    impl AgentCredentialResolver for FakeCredentialResolver {
        fn resolve(&self, _profile: &AgentAuthProfile) -> Option<String> {
            Some("credential-placeholder-from-keychain".into())
        }
    }

    #[derive(Default)]
    struct RecordingOllamaGenerator {
        calls: std::cell::RefCell<Vec<serde_json::Value>>,
    }

    impl OllamaTextGenerator for RecordingOllamaGenerator {
        fn generate(
            &self,
            model: &str,
            prompt: &str,
            format: serde_json::Value,
        ) -> Result<String, String> {
            self.calls.borrow_mut().push(serde_json::json!({
                "model": model,
                "prompt": prompt,
                "format": format,
            }));
            Ok(serde_json::json!({
                "summary": "Morning Brief draft ready.",
                "permission_changes": ["git:read", "artifact:read", "artifact:write", "llm:generate"],
                "destination_writes": ["local-app"],
                "diff_json": [{ "op": "template", "workflow_id": "morning-brief" }],
                "definition": workflow::morning_brief()
            })
            .to_string())
        }
    }

    #[test]
    fn api_profile_credentials_can_resolve_from_non_env_references() {
        let mut api_profile = profile();
        api_profile.id = "openai-api-key".into();
        api_profile.runner_kind = AgentRunnerKind::OpenAiApi;
        api_profile.credential_ref = "credential-file:openai-api-key".into();

        assert_eq!(
            resolve_profile_credential(&api_profile, &FakeCredentialResolver).as_deref(),
            Some("credential-placeholder-from-keychain")
        );
    }

    #[test]
    fn ollama_profile_uses_local_generator_for_builder_draft() {
        let mut ollama_profile = profile();
        ollama_profile.id = "ollama-local".into();
        ollama_profile.display_name = "Ollama (local)".into();
        ollama_profile.runner_kind = AgentRunnerKind::OllamaLocal;
        ollama_profile.auth_mode = AgentAuthMode::None;
        ollama_profile.credential_ref = "".into();
        ollama_profile.model = "llama3.1:8b".into();
        ollama_profile.status = "available".into();
        let generator = RecordingOllamaGenerator::default();
        let executor =
            DefaultAgentExecutor::new_with_ollama(&EnvAgentCredentialResolver, &generator);

        let draft = draft_from_profile_or_template_with_executor(
            "Create a morning brief",
            &[ollama_profile],
            Some("ollama-local"),
            &executor,
        )
        .unwrap();

        assert_eq!(draft.definition.id, "morning-brief");
        assert_eq!(draft.builder_profile_id.as_deref(), Some("ollama-local"));
        let call = generator.calls.borrow()[0].clone();
        assert_eq!(call["model"], "llama3.1:8b");
        assert!(call["prompt"]
            .as_str()
            .is_some_and(|prompt| prompt.contains("Raven Workflow schema v0.1.0")));
        assert_eq!(call["format"]["type"], "object");
    }

    #[test]
    fn falls_back_to_template_when_selected_agent_is_unavailable() {
        let mut unavailable = profile();
        unavailable.status = "needs_config".into();

        let draft = draft_from_profile_or_template(
            "Create a morning brief",
            &[unavailable],
            Some("codex-oauth-local"),
        )
        .unwrap();

        assert_eq!(draft.definition.id, "morning-brief");
        assert_eq!(
            draft.builder_profile_id.as_deref(),
            Some("codex-oauth-local")
        );
        assert!(draft.summary.contains("Builder fallback"));
    }

    #[test]
    #[ignore = "live Codex OAuth builder streaming smoke"]
    fn live_codex_oauth_builder_streaming_smoke() {
        let events = RecordingBuilderEvents::default();
        let executor = DefaultAgentExecutor::new(&EnvAgentCredentialResolver);

        let draft = draft_from_profile_or_template_with_events(
            "Create a Morning Brief workflow using the built-in Morning Brief template. Keep the local app destination and require approval before saving.",
            &[profile()],
            Some("codex-oauth-local"),
            &executor,
            "live-codex-builder-smoke",
            &events,
        )
        .unwrap();

        let recorded_events = events.events.borrow();
        println!(
            "{}",
            serde_json::json!({
                "draft_id": draft.id,
                "workflow_id": draft.definition.id,
                "workflow_name": draft.definition.name,
                "validation_status": draft.validation_status,
                "builder_profile_id": draft.builder_profile_id,
                "event_count": recorded_events.len(),
                "stream_events": recorded_events.iter().filter(|event| event.event_kind.is_some()).count(),
                "text_delta_events": recorded_events
                    .iter()
                    .filter(|event| event.event_kind.as_deref() == Some("text_delta"))
                    .count(),
                "last_event": recorded_events.last().map(|event| serde_json::json!({
                    "phase": event.phase,
                    "step_id": event.step_id,
                    "status": event.status,
                    "event_kind": event.event_kind,
                    "raw_event_type": event.raw_event_type,
                })),
            })
        );

        assert_eq!(
            draft.builder_profile_id.as_deref(),
            Some("codex-oauth-local")
        );
        assert_eq!(draft.validation_status, "valid");
        assert!(recorded_events.iter().any(|event| {
            event.event_kind.as_deref() == Some("text_delta")
                && event
                    .delta
                    .as_deref()
                    .is_some_and(|delta| delta.contains('{'))
        }));
        assert!(recorded_events.iter().any(|event| {
            event.phase == "complete" && event.step_id == "validation" && event.status == "complete"
        }));
    }
}
