use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResult {
    pub output: String,
    pub token_count: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug)]
pub enum ExecutionError {
    NotAvailable(String),
    AuthError(String),
    RuntimeError(String),
}

impl std::fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAvailable(msg) => write!(f, "Executor not available: {}", msg),
            Self::AuthError(msg) => write!(f, "Authentication error: {}", msg),
            Self::RuntimeError(msg) => write!(f, "Runtime error: {}", msg),
        }
    }
}

impl std::error::Error for ExecutionError {}

pub trait WorkflowExecutor: Send + Sync {
    fn execute_task(&self, objective: &str, model: &str) -> Result<TaskResult, ExecutionError>;
    fn display_name(&self) -> &str;
    fn is_available(&self) -> bool;
}

pub struct CodexExecutor;

impl WorkflowExecutor for CodexExecutor {
    fn execute_task(&self, objective: &str, model: &str) -> Result<TaskResult, ExecutionError> {
        let output = std::process::Command::new("codex")
            .args([
                "exec",
                "--json",
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--model",
                model,
                objective,
            ])
            .output()
            .map_err(|e| ExecutionError::NotAvailable(format!("codex CLI not found: {}", e)))?;

        if output.status.success() {
            Ok(TaskResult {
                output: String::from_utf8_lossy(&output.stdout).to_string(),
                token_count: None,
                cost_usd: None,
            })
        } else {
            Err(ExecutionError::RuntimeError(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ))
        }
    }

    fn display_name(&self) -> &str {
        "Codex CLI"
    }

    fn is_available(&self) -> bool {
        std::process::Command::new("codex")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}

pub struct OllamaExecutor {
    pub host: String,
}

impl OllamaExecutor {
    pub fn default() -> Self {
        Self {
            host: "http://localhost:11434".into(),
        }
    }
}

impl WorkflowExecutor for OllamaExecutor {
    fn execute_task(&self, objective: &str, model: &str) -> Result<TaskResult, ExecutionError> {
        let url = format!("{}/v1/chat/completions", self.host);
        let body = serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": objective}],
            "stream": false
        });

        let resp = ureq::post(&url)
            .send_json(&body)
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        let json: serde_json::Value = resp
            .into_json()
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        let tokens = json["usage"]["total_tokens"].as_u64();

        Ok(TaskResult {
            output: content,
            token_count: tokens,
            cost_usd: Some(0.0),
        })
    }

    fn display_name(&self) -> &str {
        "Ollama (local)"
    }

    fn is_available(&self) -> bool {
        crate::llm_provider::ollama_health_check(&self.host).is_ok()
    }
}
