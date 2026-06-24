use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub parameter_size: Option<String>,
    #[serde(default)]
    pub quantization_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OllamaVersionResponse {
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OllamaGenerateResponse {
    response: String,
}

pub fn ollama_health_check(host: &str) -> Result<String, String> {
    let url = format!("{}/api/version", host);
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(2))
        .build();
    let resp: OllamaVersionResponse = agent
        .get(&url)
        .call()
        .map_err(|e| format!("Ollama not reachable: {}", e))?
        .into_json()
        .map_err(|e| e.to_string())?;
    Ok(resp.version)
}

pub fn ollama_list_models(host: &str) -> Result<Vec<OllamaModel>, String> {
    let url = format!("{}/api/tags", host);
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(5))
        .build();
    let resp: OllamaTagsResponse = agent
        .get(&url)
        .call()
        .map_err(|e| format!("Ollama not reachable: {}", e))?
        .into_json()
        .map_err(|e| e.to_string())?;
    Ok(resp.models)
}

pub fn ollama_generate(
    host: &str,
    model: &str,
    prompt: &str,
    format: Option<serde_json::Value>,
) -> Result<String, String> {
    let url = format!("{}/api/generate", host);
    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
    });
    if let Some(format) = format {
        body["format"] = format;
    }

    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(120))
        .build();
    let resp: OllamaGenerateResponse = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("Ollama generation failed: {}", e))?
        .into_json()
        .map_err(|e| e.to_string())?;
    Ok(resp.response)
}
