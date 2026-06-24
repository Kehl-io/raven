use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunnerKind {
    CodexCli,
    ClaudeCodeCli,
    OpenAiApi,
    AnthropicApi,
    OllamaLocal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentAuthMode {
    CodexOauthLocalCli,
    ClaudeCodeOauthLocalCli,
    ApiKeyEnv,
    ApiKeyKeychain,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthProfile {
    pub id: String,
    pub display_name: String,
    pub runner_kind: AgentRunnerKind,
    pub auth_mode: AgentAuthMode,
    pub credential_ref: String,
    pub model: String,
    pub effort: String,
    pub status: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentCommandPlan {
    pub program: String,
    pub args: Vec<String>,
    pub env_refs: Vec<String>,
    pub remove_env: Vec<String>,
    pub env_allowlist: Vec<String>,
    pub isolate_cwd: bool,
}

pub fn default_agent_auth_profiles() -> Vec<AgentAuthProfile> {
    vec![
        AgentAuthProfile {
            id: "codex-oauth-local".into(),
            display_name: "Codex OAuth (local CLI)".into(),
            runner_kind: AgentRunnerKind::CodexCli,
            auth_mode: AgentAuthMode::CodexOauthLocalCli,
            credential_ref: "codex:oauth:local-cli".into(),
            model: "gpt-5.4".into(),
            effort: "medium".into(),
            status: command_available("codex"),
            summary: "Runs codex exec through the local Codex CLI and reuses its cached ChatGPT/Codex sign-in. Raven never reads the OAuth token.".into(),
        },
        AgentAuthProfile {
            id: "claude-code-oauth-local".into(),
            display_name: "Claude Code OAuth (local CLI)".into(),
            runner_kind: AgentRunnerKind::ClaudeCodeCli,
            auth_mode: AgentAuthMode::ClaudeCodeOauthLocalCli,
            credential_ref: "claude-code:oauth:local-cli".into(),
            model: "sonnet".into(),
            effort: "medium".into(),
            status: command_available("claude"),
            summary: "Runs claude --print through the local Claude Code CLI and lets Claude Code use its subscription OAuth credentials. Raven suppresses API-key env vars for this mode so they do not take precedence.".into(),
        },
        AgentAuthProfile {
            id: "openai-api-key".into(),
            display_name: "OpenAI API key".into(),
            runner_kind: AgentRunnerKind::OpenAiApi,
            auth_mode: AgentAuthMode::ApiKeyEnv,
            credential_ref: "env:OPENAI_API_KEY".into(),
            model: "gpt-4.1".into(),
            effort: "medium".into(),
            status: env_available("OPENAI_API_KEY"),
            summary: "Uses an OpenAI API key reference for direct API-backed agent work. Raw key values stay in the environment or keychain adapter.".into(),
        },
        AgentAuthProfile {
            id: "anthropic-api-key".into(),
            display_name: "Anthropic API key".into(),
            runner_kind: AgentRunnerKind::AnthropicApi,
            auth_mode: AgentAuthMode::ApiKeyEnv,
            credential_ref: "env:ANTHROPIC_API_KEY".into(),
            model: "claude-sonnet-4-5".into(),
            effort: "medium".into(),
            status: env_available("ANTHROPIC_API_KEY"),
            summary: "Uses an Anthropic API key reference for direct Claude API calls. Raw key values stay in the environment or keychain adapter.".into(),
        },
        AgentAuthProfile {
            id: "ollama-local".into(),
            display_name: "Ollama (local)".into(),
            runner_kind: AgentRunnerKind::OllamaLocal,
            auth_mode: AgentAuthMode::None,
            credential_ref: "".into(),
            model: "llama3.1:8b".into(),
            effort: "medium".into(),
            status: ollama_available(),
            summary: "Local AI via Ollama. No API key required.".into(),
        },
    ]
}

pub fn command_plan_for_profile(
    profile: &AgentAuthProfile,
    prompt: &str,
) -> Result<AgentCommandPlan, String> {
    command_plan_for_profile_with_tool_classes(profile, prompt, &[], false)
}

pub fn command_plan_for_profile_with_tool_classes(
    profile: &AgentAuthProfile,
    prompt: &str,
    tool_classes: &[String],
    allows_writes: bool,
) -> Result<AgentCommandPlan, String> {
    match profile.runner_kind {
        AgentRunnerKind::CodexCli => Ok(AgentCommandPlan {
            program: "codex".into(),
            args: vec![
                "exec".into(),
                "--json".into(),
                "--sandbox".into(),
                if allows_writes {
                    "workspace-write".into()
                } else {
                    "read-only".into()
                },
                "--ephemeral".into(),
                "--ignore-rules".into(),
                "--skip-git-repo-check".into(),
                "--model".into(),
                profile.model.clone(),
                prompt.into(),
            ],
            env_refs: vec![],
            remove_env: vec![],
            env_allowlist: oauth_cli_env_allowlist("CODEX_HOME"),
            isolate_cwd: !allows_writes,
        }),
        AgentRunnerKind::ClaudeCodeCli => Ok(AgentCommandPlan {
            program: "claude".into(),
            args: {
                let mut args = vec![
                    "--print".into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--verbose".into(),
                    "--safe-mode".into(),
                    "--no-session-persistence".into(),
                    "--permission-mode".into(),
                    if allows_writes {
                        "default".into()
                    } else {
                        "dontAsk".into()
                    },
                    "--model".into(),
                    profile.model.clone(),
                    "--effort".into(),
                    profile.effort.clone(),
                    "--json-schema".into(),
                    agent_task_envelope_json_schema(),
                ];
                if !allows_writes {
                    let allowed_tools = claude_allowed_tools_for_tool_classes(tool_classes);
                    if allowed_tools.is_empty() {
                        args.push("--tools=".into());
                    } else {
                        args.push(format!("--allowedTools={allowed_tools}"));
                    }
                    args.push("--disallowedTools=Bash,Edit,Write".into());
                }
                args.push(prompt.into());
                args
            },
            env_refs: vec![],
            remove_env: vec!["ANTHROPIC_API_KEY".into(), "ANTHROPIC_AUTH_TOKEN".into()],
            env_allowlist: oauth_cli_env_allowlist("CLAUDE_CONFIG_DIR"),
            isolate_cwd: !allows_writes,
        }),
        AgentRunnerKind::OpenAiApi | AgentRunnerKind::AnthropicApi => Err(format!(
            "{} is a native Raven API profile and does not use a shell command plan.",
            profile.display_name
        )),
        AgentRunnerKind::OllamaLocal => Err(format!(
            "{} is a local Raven provider profile and does not use a shell command plan.",
            profile.display_name
        )),
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

fn claude_allowed_tools_for_tool_classes(tool_classes: &[String]) -> String {
    let mut tools = Vec::new();
    for tool_class in tool_classes {
        match tool_class.as_str() {
            "web" | "http" => {
                tools.push("WebSearch");
                tools.push("WebFetch");
            }
            "local_git" => {
                tools.push("Read");
                tools.push("Grep");
                tools.push("Glob");
            }
            _ => {}
        }
    }
    tools.sort_unstable();
    tools.dedup();
    if tools.is_empty() {
        return String::new();
    }
    tools.join(",")
}

fn agent_task_envelope_json_schema() -> String {
    serde_json::json!({
        "type": "object",
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
            "source_refs": {
                "type": "array",
                "items": { "type": "string" }
            },
            "tool_trace": { "type": "array" },
            "raw_result_json": { "type": "object" }
        },
        "additionalProperties": false
    })
    .to_string()
}

fn command_available(program: &str) -> String {
    let mut command = std::process::Command::new(program);
    command.arg("--version");
    command.env_clear();
    for name in oauth_cli_env_allowlist(if program == "claude" {
        "CLAUDE_CONFIG_DIR"
    } else {
        "CODEX_HOME"
    }) {
        if let Some(value) = std::env::var_os(&name) {
            command.env(name, value);
        }
    }
    command
        .output()
        .map(|output| {
            if output.status.success() {
                "available"
            } else {
                "needs_config"
            }
        })
        .unwrap_or("needs_config")
        .into()
}

fn env_available(name: &str) -> String {
    if std::env::var_os(name).is_some() {
        "available"
    } else {
        "needs_config"
    }
    .into()
}

fn ollama_available() -> String {
    let host =
        std::env::var("RAVEN_OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".into());
    let url = format!("{host}/api/version");
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_millis(300))
        .build();
    match agent.get(&url).call() {
        Ok(response) if response.status() == 200 => "available",
        _ => "needs_config",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_oauth_uses_local_cli_without_token_material() {
        let profiles = default_agent_auth_profiles();
        let profile = profiles
            .iter()
            .find(|profile| profile.id == "codex-oauth-local")
            .expect("codex oauth profile");
        let plan = command_plan_for_profile(profile, "summarize this workflow").unwrap();

        assert_eq!(profile.credential_ref, "codex:oauth:local-cli");
        assert_eq!(plan.program, "codex");
        assert!(plan.args.contains(&"exec".into()));
        assert!(plan.args.contains(&"--json".into()));
        assert!(plan.args.contains(&"read-only".into()));
        assert!(!plan.args.contains(&"workspace-write".into()));
        assert!(plan.env_refs.is_empty());
        assert!(plan.env_allowlist.contains(&"HOME".into()));
        assert!(plan.env_allowlist.contains(&"CODEX_HOME".into()));
        assert!(plan.isolate_cwd);
        assert!(!format!("{plan:?}").contains("token_material"));
    }

    #[test]
    fn codex_web_agent_plan_uses_read_only_sandbox() {
        let profiles = default_agent_auth_profiles();
        let profile = profiles
            .iter()
            .find(|profile| profile.id == "codex-oauth-local")
            .expect("codex oauth profile");
        let plan = command_plan_for_profile_with_tool_classes(
            profile,
            "summarize this workflow",
            &["web".into()],
            false,
        )
        .unwrap();

        assert_eq!(plan.program, "codex");
        assert!(plan.args.contains(&"--sandbox".into()));
        assert!(plan.args.contains(&"read-only".into()));
        assert!(plan.args.contains(&"--ephemeral".into()));
        assert!(plan.args.contains(&"--ignore-rules".into()));
        assert!(plan.args.contains(&"--skip-git-repo-check".into()));
        assert!(!plan.args.contains(&"workspace-write".into()));
        assert!(plan.isolate_cwd);
        assert!(plan.env_allowlist.contains(&"HOME".into()));
        assert!(!plan.env_allowlist.contains(&"OPENAI_API_KEY".into()));
    }

    #[test]
    fn claude_web_only_agent_plan_uses_read_only_permission_mode() {
        let profiles = default_agent_auth_profiles();
        let profile = profiles
            .iter()
            .find(|profile| profile.id == "claude-code-oauth-local")
            .expect("claude oauth profile");
        let plan = command_plan_for_profile_with_tool_classes(
            profile,
            "build an artifact",
            &["web".into()],
            false,
        )
        .unwrap();

        assert_eq!(plan.program, "claude");
        assert!(plan.args.contains(&"--permission-mode".into()));
        assert!(plan.args.contains(&"dontAsk".into()));
        assert!(plan.args.contains(&"--verbose".into()));
        assert!(plan.args.contains(&"--safe-mode".into()));
        assert!(plan.args.contains(&"--json-schema".into()));
        assert!(plan
            .args
            .contains(&"--allowedTools=WebFetch,WebSearch".into()));
        assert!(plan
            .args
            .contains(&"--disallowedTools=Bash,Edit,Write".into()));
        assert!(!plan.args.contains(&"default".into()));
        assert!(plan.isolate_cwd);
        assert!(plan.env_allowlist.contains(&"HOME".into()));
        assert!(!plan.env_allowlist.contains(&"ANTHROPIC_API_KEY".into()));
    }

    #[test]
    fn claude_code_oauth_uses_local_cli_and_suppresses_api_key_precedence() {
        let profiles = default_agent_auth_profiles();
        let profile = profiles
            .iter()
            .find(|profile| profile.id == "claude-code-oauth-local")
            .expect("claude oauth profile");
        let plan = command_plan_for_profile(profile, "build an artifact").unwrap();

        assert_eq!(profile.credential_ref, "claude-code:oauth:local-cli");
        assert_eq!(plan.program, "claude");
        assert!(plan.args.contains(&"--print".into()));
        assert!(plan.args.contains(&"--output-format".into()));
        assert!(plan.remove_env.contains(&"ANTHROPIC_API_KEY".into()));
        assert!(plan.remove_env.contains(&"ANTHROPIC_AUTH_TOKEN".into()));
        assert!(plan.env_allowlist.contains(&"CLAUDE_CONFIG_DIR".into()));
    }

    #[test]
    fn command_available_clears_ambient_secrets_for_status_probe() {
        use std::os::unix::fs::PermissionsExt;

        let secret_name = "RAVEN_AGENT_AUTH_TEST_SECRET";
        std::env::set_var(secret_name, "leaky");
        let dir = std::env::temp_dir().join(format!("raven-agent-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("probe");
        std::fs::write(
            &script,
            format!("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '1.0.0'; exit 0; fi\nif [ -n \"${{{secret_name}:-}}\" ]; then exit 42; fi\nexit 0\n"),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        let status = command_available(script.to_str().unwrap());

        std::env::remove_var(secret_name);
        let _ = std::fs::remove_dir_all(dir);
        assert_eq!(status, "available");
    }

    #[test]
    fn agent_plan_privileges_come_from_tool_classes_not_workflow_permissions() {
        let profiles = default_agent_auth_profiles();
        let claude = profiles
            .iter()
            .find(|profile| profile.id == "claude-code-oauth-local")
            .expect("claude oauth profile");

        let claude_plan = command_plan_for_profile_with_tool_classes(
            claude,
            "web only task with artifact sink elsewhere",
            &["web".into()],
            false,
        )
        .unwrap();

        assert!(claude_plan.args.contains(&"dontAsk".into()));
        assert!(!claude_plan.args.contains(&"default".into()));
        assert!(claude_plan
            .args
            .contains(&"--allowedTools=WebFetch,WebSearch".into()));
        assert!(!claude_plan
            .args
            .contains(&"--allowedTools=Glob,Grep,Read".into()));
        assert!(claude_plan.isolate_cwd);
    }

    #[test]
    fn api_key_profiles_use_references_not_raw_secret_values() {
        let profiles = default_agent_auth_profiles();

        assert!(profiles.iter().any(|profile| {
            profile.id == "openai-api-key"
                && profile.credential_ref == "env:OPENAI_API_KEY"
                && profile.auth_mode == AgentAuthMode::ApiKeyEnv
        }));
        assert!(profiles.iter().any(|profile| {
            profile.id == "anthropic-api-key"
                && profile.credential_ref == "env:ANTHROPIC_API_KEY"
                && profile.auth_mode == AgentAuthMode::ApiKeyEnv
        }));
        assert!(!format!("{profiles:?}").contains("sk-"));
    }

    #[test]
    fn api_key_profiles_do_not_emit_placeholder_shell_command_plans() {
        let profiles = default_agent_auth_profiles();
        let openai = profiles
            .iter()
            .find(|profile| profile.id == "openai-api-key")
            .unwrap();
        let anthropic = profiles
            .iter()
            .find(|profile| profile.id == "anthropic-api-key")
            .unwrap();

        assert!(command_plan_for_profile(openai, "build a draft")
            .unwrap_err()
            .contains("native"));
        assert!(command_plan_for_profile(anthropic, "build a draft")
            .unwrap_err()
            .contains("native"));
    }

    #[test]
    fn ollama_profile_uses_local_provider_not_placeholder_shell_plan() {
        let profiles = default_agent_auth_profiles();
        let ollama = profiles
            .iter()
            .find(|profile| profile.id == "ollama-local")
            .unwrap();

        assert!(command_plan_for_profile(ollama, "build a draft")
            .unwrap_err()
            .contains("local Raven provider"));
    }
}
