use chrono::Utc;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::time::Duration;

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_MAX_BYTES: u64 = 512 * 1024;
const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub fn fetch_page(inputs: &Value) -> Value {
    let fetched_at = Utc::now().to_rfc3339();
    let Some(url) = string_input(inputs, "url") else {
        return fetch_error(
            None,
            None,
            fetched_at,
            "validation_error",
            "url must be a non-empty string",
        );
    };

    let timeout_ms = inputs
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let max_bytes = inputs
        .get("max_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_MAX_BYTES)
        .min(MAX_BYTES);

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(timeout_ms))
        .redirects(10)
        .build();

    match agent.get(&url).call() {
        Ok(response) => response_to_value(response, max_bytes, fetched_at, true, None, None),
        Err(ureq::Error::Status(_, response)) => response_to_value(
            response,
            max_bytes,
            fetched_at,
            false,
            Some("http_status_error"),
            None,
        ),
        Err(error) => fetch_error(
            Some(url),
            None,
            fetched_at,
            classify_error(&error.to_string()),
            &error.to_string(),
        ),
    }
}

pub fn extract_metadata(inputs: &Value) -> Value {
    let body = body_input(inputs);
    let title = body.as_deref().and_then(extract_title);
    let description = body.as_deref().and_then(extract_description);
    let canonical_url = body
        .as_deref()
        .and_then(extract_canonical_url)
        .or_else(|| string_input(inputs, "url"));
    let open_graph = body.as_deref().map(extract_open_graph).unwrap_or_default();

    json!({
        "title": title,
        "description": description,
        "canonical_url": canonical_url,
        "open_graph": open_graph,
    })
}

pub fn extract_article(inputs: &Value) -> Value {
    let body = body_input(inputs).unwrap_or_default();
    let title = extract_title(&body).or_else(|| extract_first_heading(&body));
    let text = normalize_whitespace(&strip_tags(&remove_html_blocks(
        &body,
        &["script", "style"],
    )));
    let word_count = text.split_whitespace().count();
    let excerpt = excerpt(&text, 280);
    let source_url = string_input(inputs, "url");

    json!({
        "title": title,
        "text": text,
        "excerpt": excerpt,
        "word_count": word_count,
        "source_url": source_url,
    })
}

fn response_to_value(
    response: ureq::Response,
    max_bytes: u64,
    fetched_at: String,
    ok: bool,
    error_type: Option<&str>,
    error_message: Option<String>,
) -> Value {
    let status_code = response.status();
    let content_type = response.header("Content-Type").map(str::to_string);
    let effective_url = response.get_url().to_string();
    let body_text = read_bounded_text(response, max_bytes);
    let error_message = error_message.or_else(|| {
        if ok {
            None
        } else {
            Some(format!("HTTP status {status_code}"))
        }
    });

    json!({
        "ok": ok,
        "status_code": status_code,
        "final_url": effective_url,
        "effective_url": effective_url,
        "content_type": content_type,
        "body_text": body_text,
        "fetched_at": fetched_at,
        "error_type": error_type,
        "error_message": error_message,
    })
}

fn fetch_error(
    url: Option<String>,
    status_code: Option<u16>,
    fetched_at: String,
    error_type: &str,
    error_message: &str,
) -> Value {
    json!({
        "ok": false,
        "status_code": status_code,
        "final_url": url,
        "effective_url": url,
        "content_type": Value::Null,
        "body_text": "",
        "fetched_at": fetched_at,
        "error_type": error_type,
        "error_message": error_message,
    })
}

fn read_bounded_text(response: ureq::Response, max_bytes: u64) -> String {
    let mut bytes = Vec::new();
    let _ = response
        .into_reader()
        .take(max_bytes)
        .read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn string_input(inputs: &Value, key: &str) -> Option<String> {
    inputs
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn body_input(inputs: &Value) -> Option<String> {
    string_input(inputs, "body_text")
        .or_else(|| string_input(inputs, "html"))
        .or_else(|| {
            string_input(inputs, "url").and_then(|_| {
                let fetched = fetch_page(inputs);
                if fetched["ok"].as_bool().unwrap_or(false) {
                    string_input(&fetched, "body_text")
                } else {
                    None
                }
            })
        })
}

fn classify_error(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") {
        "timeout"
    } else if lower.contains("dns")
        || lower.contains("resolve")
        || lower.contains("lookup")
        || lower.contains("name resolution")
    {
        "dns"
    } else if lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("certificate")
        || lower.contains("cert")
    {
        "tls_handshake"
    } else if lower.contains("connect")
        || lower.contains("connection refused")
        || lower.contains("network unreachable")
    {
        "connect"
    } else {
        "request_error"
    }
}

fn extract_title(html: &str) -> Option<String> {
    extract_tag_text(html, "title").map(|value| normalize_whitespace(&value))
}

fn extract_first_heading(html: &str) -> Option<String> {
    extract_tag_text(html, "h1").map(|value| normalize_whitespace(&strip_tags(&value)))
}

fn extract_description(html: &str) -> Option<String> {
    for tag in find_start_tags(html, "meta") {
        let attrs = parse_attrs(&tag);
        let key = attrs
            .get("name")
            .or_else(|| attrs.get("property"))
            .map(|value| value.to_ascii_lowercase());
        if matches!(key.as_deref(), Some("description" | "og:description")) {
            if let Some(content) = attrs.get("content") {
                return Some(decode_html_entities(content.trim()));
            }
        }
    }
    None
}

fn extract_canonical_url(html: &str) -> Option<String> {
    for tag in find_start_tags(html, "link") {
        let attrs = parse_attrs(&tag);
        let rel = attrs
            .get("rel")
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if rel.split_whitespace().any(|part| part == "canonical") {
            if let Some(href) = attrs.get("href") {
                return Some(decode_html_entities(href.trim()));
            }
        }
    }
    None
}

fn extract_open_graph(html: &str) -> Map<String, Value> {
    let mut graph = Map::new();
    for tag in find_start_tags(html, "meta") {
        let attrs = parse_attrs(&tag);
        let Some(property) = attrs
            .get("property")
            .or_else(|| attrs.get("name"))
            .map(|value| value.to_ascii_lowercase())
        else {
            continue;
        };
        let Some(key) = property.strip_prefix("og:") else {
            continue;
        };
        if let Some(content) = attrs.get("content") {
            graph.insert(
                key.to_string(),
                Value::String(decode_html_entities(content.trim())),
            );
        }
    }
    graph
}

fn extract_tag_text(html: &str, tag_name: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag_name}");
    let close = format!("</{tag_name}>");
    let open_start = lower.find(&open)?;
    let content_start = lower[open_start..].find('>')? + open_start + 1;
    let content_end = lower[content_start..].find(&close)? + content_start;
    Some(decode_html_entities(&html[content_start..content_end]))
}

fn find_start_tags(html: &str, tag_name: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let lower = html.to_ascii_lowercase();
    let needle = format!("<{tag_name}");
    let mut offset = 0;
    while let Some(relative_start) = lower[offset..].find(&needle) {
        let start = offset + relative_start;
        let after_name = start + needle.len();
        let Some(next_char) = lower[after_name..].chars().next() else {
            break;
        };
        if !next_char.is_whitespace() && next_char != '>' && next_char != '/' {
            offset = after_name;
            continue;
        }
        let Some(relative_end) = lower[start..].find('>') else {
            break;
        };
        let end = start + relative_end + 1;
        tags.push(html[start..end].to_string());
        offset = end;
    }
    tags
}

fn parse_attrs(tag: &str) -> BTreeMap<String, String> {
    let mut attrs = BTreeMap::new();
    let mut chars = tag
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim_end_matches('/')
        .chars()
        .peekable();

    while let Some(ch) = chars.peek() {
        if ch.is_whitespace() {
            break;
        }
        chars.next();
    }

    loop {
        while chars.peek().is_some_and(|ch| ch.is_whitespace()) {
            chars.next();
        }
        let mut name = String::new();
        while chars
            .peek()
            .is_some_and(|ch| !ch.is_whitespace() && *ch != '=' && *ch != '/' && *ch != '>')
        {
            name.push(chars.next().unwrap());
        }
        if name.is_empty() {
            break;
        }
        while chars.peek().is_some_and(|ch| ch.is_whitespace()) {
            chars.next();
        }
        if chars.peek() != Some(&'=') {
            attrs.insert(name.to_ascii_lowercase(), String::new());
            continue;
        }
        chars.next();
        while chars.peek().is_some_and(|ch| ch.is_whitespace()) {
            chars.next();
        }
        let quote = chars.peek().copied().filter(|ch| *ch == '"' || *ch == '\'');
        if quote.is_some() {
            chars.next();
        }
        let mut value = String::new();
        while let Some(ch) = chars.peek().copied() {
            if quote.is_some_and(|quote| ch == quote)
                || (quote.is_none() && (ch.is_whitespace() || ch == '/' || ch == '>'))
            {
                break;
            }
            value.push(ch);
            chars.next();
        }
        if quote.is_some() && chars.peek().is_some() {
            chars.next();
        }
        attrs.insert(name.to_ascii_lowercase(), value);
    }

    attrs
}

fn remove_html_blocks(html: &str, tag_names: &[&str]) -> String {
    let mut output = html.to_string();
    for tag_name in tag_names {
        loop {
            let lower = output.to_ascii_lowercase();
            let open = format!("<{tag_name}");
            let close = format!("</{tag_name}>");
            let Some(start) = lower.find(&open) else {
                break;
            };
            let Some(close_relative) = lower[start..].find(&close) else {
                output.replace_range(start..output.len(), " ");
                break;
            };
            let end = start + close_relative + close.len();
            output.replace_range(start..end, " ");
        }
    }
    output
}

fn strip_tags(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                output.push(' ');
            }
            '>' => {
                in_tag = false;
                output.push(' ');
            }
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    decode_html_entities(&output)
}

fn normalize_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn excerpt(text: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for ch in text.chars() {
        if output.len() + ch.len_utf8() > max_chars {
            break;
        }
        output.push(ch);
    }
    output.trim().to_string()
}

pub(crate) fn decode_html_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

pub(crate) fn text_between(input: &str, start: &str, end: &str) -> Option<String> {
    let lower = input.to_ascii_lowercase();
    let start_lower = start.to_ascii_lowercase();
    let end_lower = end.to_ascii_lowercase();
    let value_start = lower.find(&start_lower)? + start.len();
    let value_end = lower[value_start..].find(&end_lower)? + value_start;
    Some(input[value_start..value_end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const HTML: &str = r#"
<!doctype html>
<html>
  <head>
    <title>Fixture Article</title>
    <meta name="description" content="Short fixture description.">
    <meta property="og:title" content="OG Fixture Title">
    <meta property="og:type" content="article">
    <link rel="canonical" href="https://example.com/articles/fixture">
    <script>window.noise = true;</script>
    <style>body { color: red; }</style>
  </head>
  <body>
    <article>
      <h1>Fixture Article</h1>
      <p>The first paragraph has readable article text.</p>
      <p>The second paragraph includes enough words for a useful excerpt.</p>
    </article>
  </body>
</html>
"#;

    fn test_server(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");

        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0; 1024];
                let _ = stream.read(&mut buffer);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            }
        });

        format!("http://{address}")
    }

    #[test]
    fn fetch_page_returns_bounded_text_and_response_metadata() {
        let url = test_server("abcdef");

        let output = fetch_page(&json!({
            "url": url,
            "timeout_ms": 1000,
            "max_bytes": 3
        }));

        assert_eq!(output["ok"], true);
        assert_eq!(output["status_code"], 200);
        assert_eq!(output["body_text"], "abc");
        assert_eq!(output["content_type"], "text/html; charset=utf-8");
        assert!(output["effective_url"]
            .as_str()
            .unwrap()
            .starts_with("http://127.0.0.1:"));
        assert!(output["fetched_at"].as_str().unwrap().contains('T'));
    }

    #[test]
    fn extract_metadata_scans_title_description_canonical_and_open_graph() {
        let output = extract_metadata(&json!({
            "body_text": HTML,
            "url": "https://example.com/raw"
        }));

        assert_eq!(output["title"], "Fixture Article");
        assert_eq!(output["description"], "Short fixture description.");
        assert_eq!(
            output["canonical_url"],
            "https://example.com/articles/fixture"
        );
        assert_eq!(output["open_graph"]["title"], "OG Fixture Title");
        assert_eq!(output["open_graph"]["type"], "article");
    }

    #[test]
    fn extract_article_strips_scripts_styles_and_tags() {
        let output = extract_article(&json!({
            "body_text": HTML,
            "url": "https://example.com/articles/fixture"
        }));

        let text = output["text"].as_str().expect("article text");
        assert_eq!(output["title"], "Fixture Article");
        assert_eq!(output["source_url"], "https://example.com/articles/fixture");
        assert!(text.contains("The first paragraph has readable article text."));
        assert!(text.contains("The second paragraph includes enough words"));
        assert!(!text.contains("window.noise"));
        assert!(!text.contains("body { color"));
        assert!(output["word_count"].as_u64().unwrap() >= 15);
        assert!(output["excerpt"].as_str().unwrap().len() <= 280);
    }
}
