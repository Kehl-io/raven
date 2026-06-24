use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_RETRIES: u8 = 5;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HttpProbeConfig {
    pub urls: Vec<String>,
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    pub accepted_status_codes: Vec<u16>,
    pub retries: u8,
}

impl Default for HttpProbeConfig {
    fn default() -> Self {
        Self {
            urls: Vec::new(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            follow_redirects: true,
            accepted_status_codes: default_accepted_status_codes(),
            retries: 0,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HttpProbeResult {
    pub url: String,
    pub ok: bool,
    pub status_code: Option<u16>,
    pub effective_url: Option<String>,
    pub duration_ms: u64,
    pub content_type: Option<String>,
    pub redirect_count: u32,
    pub error_type: Option<String>,
    pub error_message: Option<String>,
    pub checked_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HttpProbeOutput {
    pub results: Vec<HttpProbeResult>,
}

pub fn config_from_inputs(inputs: &Value) -> Result<HttpProbeConfig, String> {
    let urls_value = inputs
        .get("urls")
        .ok_or_else(|| "urls must contain at least one non-empty string".to_string())?;
    let urls_array = urls_value
        .as_array()
        .ok_or_else(|| "urls must be an array of non-empty strings".to_string())?;

    let mut urls = Vec::with_capacity(urls_array.len());
    for url in urls_array {
        let Some(url) = url.as_str() else {
            return Err("urls must be an array of non-empty strings".to_string());
        };
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return Err("urls must contain only non-empty strings".to_string());
        }
        urls.push(trimmed.to_string());
    }

    if urls.is_empty() {
        return Err("urls must contain at least one non-empty string".to_string());
    }

    Ok(HttpProbeConfig {
        urls,
        timeout_ms: inputs
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
        follow_redirects: inputs
            .get("follow_redirects")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        accepted_status_codes: accepted_status_codes_from_inputs(inputs)?,
        retries: inputs
            .get("retries")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u64::from(MAX_RETRIES)) as u8,
    })
}

pub fn check_urls(config: &HttpProbeConfig) -> HttpProbeOutput {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(config.timeout_ms))
        .redirects(if config.follow_redirects { 10 } else { 0 })
        .build();

    let results = config
        .urls
        .iter()
        .map(|url| check_url(&agent, config, url))
        .collect();

    HttpProbeOutput { results }
}

fn check_url(agent: &ureq::Agent, config: &HttpProbeConfig, url: &str) -> HttpProbeResult {
    let started_at = Instant::now();
    let mut last_error = None;

    for attempt in 0..=config.retries {
        match agent.get(url).call() {
            Ok(response) => {
                return result_from_response(
                    url,
                    response,
                    &config.accepted_status_codes,
                    started_at.elapsed(),
                    None,
                );
            }
            Err(ureq::Error::Status(_, response)) => {
                return result_from_response(
                    url,
                    response,
                    &config.accepted_status_codes,
                    started_at.elapsed(),
                    None,
                );
            }
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt == config.retries {
                    break;
                }
            }
        }
    }

    let error_message = last_error.unwrap_or_else(|| "request failed".to_string());
    HttpProbeResult {
        url: url.to_string(),
        ok: false,
        status_code: None,
        effective_url: Some(url.to_string()),
        duration_ms: elapsed_ms(started_at.elapsed()),
        content_type: None,
        redirect_count: 0,
        error_type: Some(classify_error(&error_message).to_string()),
        error_message: Some(error_message),
        checked_at: Utc::now().to_rfc3339(),
    }
}

fn result_from_response(
    url: &str,
    response: ureq::Response,
    accepted_status_codes: &[u16],
    elapsed: Duration,
    error_message: Option<String>,
) -> HttpProbeResult {
    let status_code = response.status();
    let ok = accepted_status_codes.contains(&status_code);
    let content_type = response
        .header("Content-Type")
        .map(|value| value.to_string());
    let effective_url = Some(response.get_url().to_string());
    let error_type = if ok {
        None
    } else {
        Some("http_status_error".to_string())
    };
    let error_message = if ok {
        None
    } else {
        error_message.or_else(|| Some(format!("HTTP status {status_code} was not accepted")))
    };

    HttpProbeResult {
        url: url.to_string(),
        ok,
        status_code: Some(status_code),
        effective_url,
        duration_ms: elapsed_ms(elapsed),
        content_type,
        redirect_count: 0,
        error_type,
        error_message,
        checked_at: Utc::now().to_rfc3339(),
    }
}

fn accepted_status_codes_from_inputs(inputs: &Value) -> Result<Vec<u16>, String> {
    let Some(value) = inputs.get("accepted_status_codes") else {
        return Ok(default_accepted_status_codes());
    };
    let codes = value
        .as_array()
        .ok_or_else(|| "accepted_status_codes must be an array of HTTP status codes".to_string())?;
    if codes.is_empty() {
        return Ok(default_accepted_status_codes());
    }

    let mut accepted_status_codes = Vec::with_capacity(codes.len());
    for code in codes {
        let Some(code) = code.as_u64() else {
            return Err("accepted_status_codes must contain integer HTTP status codes".to_string());
        };
        if !(100..=599).contains(&code) {
            return Err(
                "accepted_status_codes must contain HTTP status codes from 100 through 599"
                    .to_string(),
            );
        }
        accepted_status_codes.push(code as u16);
    }
    Ok(accepted_status_codes)
}

fn default_accepted_status_codes() -> Vec<u16> {
    (200..400).collect()
}

fn elapsed_ms(elapsed: Duration) -> u64 {
    elapsed.as_millis().try_into().unwrap_or(u64::MAX)
}

fn classify_error(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("certificate")
        || lower.contains("cert")
    {
        "tls_handshake"
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "timeout"
    } else if lower.contains("dns")
        || lower.contains("resolve")
        || lower.contains("lookup")
        || lower.contains("name resolution")
    {
        "dns"
    } else if lower.contains("connect")
        || lower.contains("connection refused")
        || lower.contains("network unreachable")
    {
        "connect"
    } else {
        "request_error"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn test_server(status_code: u16, content_type: Option<&'static str>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");

        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0; 1024];
                let _ = stream.read(&mut buffer);
                let reason = match status_code {
                    200 => "OK",
                    201 => "Created",
                    404 => "Not Found",
                    500 => "Internal Server Error",
                    _ => "Status",
                };
                let content_type_header = content_type
                    .map(|value| format!("Content-Type: {value}\r\n"))
                    .unwrap_or_default();
                let response = format!(
                    "HTTP/1.1 {status_code} {reason}\r\n{content_type_header}Content-Length: 2\r\nConnection: close\r\n\r\nok"
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            }
        });

        format!("http://{address}")
    }

    #[test]
    fn classifies_accepted_status_as_ok() {
        let url = test_server(201, Some("text/plain"));
        let config = HttpProbeConfig {
            urls: vec![url.clone()],
            timeout_ms: 1_000,
            follow_redirects: true,
            accepted_status_codes: vec![200, 201],
            retries: 0,
        };

        let output = check_urls(&config);
        let result = output.results.first().expect("probe result");

        assert_eq!(result.url, url);
        assert!(result.ok);
        assert_eq!(result.status_code, Some(201));
        assert_eq!(result.content_type.as_deref(), Some("text/plain"));
        assert_eq!(result.error_type, None);
        assert_eq!(result.error_message, None);
    }

    #[test]
    fn classifies_rejected_status_as_http_status_error() {
        let url = test_server(404, None);
        let config = HttpProbeConfig {
            urls: vec![url],
            timeout_ms: 1_000,
            follow_redirects: true,
            accepted_status_codes: vec![200],
            retries: 0,
        };

        let output = check_urls(&config);
        let result = output.results.first().expect("probe result");

        assert!(!result.ok);
        assert_eq!(result.status_code, Some(404));
        assert_eq!(result.error_type.as_deref(), Some("http_status_error"));
        assert!(result.error_message.is_some());
    }

    #[test]
    fn classifies_tls_failure_without_status_code() {
        let error_type = classify_error("TLS handshake failed: invalid certificate");

        assert_eq!(error_type, "tls_handshake");
    }

    #[test]
    fn config_from_inputs_requires_urls() {
        let error = config_from_inputs(&json!({ "urls": ["", "   "] })).expect_err("invalid urls");

        assert!(error.contains("urls"));
    }

    #[test]
    fn config_from_inputs_clamps_timeout_and_retries() {
        let config = config_from_inputs(&json!({
            "urls": ["https://example.com"],
            "timeout_ms": 100,
            "retries": 99
        }))
        .expect("config");

        assert_eq!(config.timeout_ms, 1_000);
        assert_eq!(config.retries, 5);
        assert_eq!(config.accepted_status_codes.first(), Some(&200));
        assert_eq!(config.accepted_status_codes.last(), Some(&399));
    }

    #[test]
    fn config_from_inputs_accepts_status_code_boundaries() {
        let config = config_from_inputs(&json!({
            "urls": ["https://example.com"],
            "accepted_status_codes": [100, 599]
        }))
        .expect("config");

        assert_eq!(config.accepted_status_codes, vec![100, 599]);
    }

    #[test]
    fn config_from_inputs_rejects_status_codes_outside_http_range() {
        for status_code in [0, 99, 600, 65_535] {
            let error = config_from_inputs(&json!({
                "urls": ["https://example.com"],
                "accepted_status_codes": [status_code]
            }))
            .expect_err("invalid status code");

            assert!(error.contains("accepted_status_codes"));
        }
    }
}
