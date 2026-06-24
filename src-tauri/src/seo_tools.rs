use crate::web_tools::{decode_html_entities, fetch_page, text_between};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_MAX_BYTES: u64 = 1024 * 1024;
const DEFAULT_USER_AGENT: &str = "*";

pub fn fetch_robots_txt(inputs: &Value) -> Value {
    let fetched_at = Utc::now().to_rfc3339();
    let Some(site_url) = string_input(inputs, "site_url")
        .or_else(|| string_input(inputs, "base_url"))
        .or_else(|| string_input(inputs, "url"))
    else {
        return json!({
            "ok": false,
            "robots_url": Value::Null,
            "body_text": "",
            "fetched_at": fetched_at,
            "error_type": "validation_error",
            "error_message": "site_url must be a non-empty URL"
        });
    };
    let Some(origin) = origin_from_url(&site_url) else {
        return json!({
            "ok": false,
            "robots_url": Value::Null,
            "body_text": "",
            "fetched_at": fetched_at,
            "error_type": "validation_error",
            "error_message": "site_url must include http:// or https://"
        });
    };
    let robots_url = format!("{origin}/robots.txt");
    let fetched = fetch_page(&json!({
        "url": robots_url,
        "timeout_ms": inputs.get("timeout_ms").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS),
        "max_bytes": inputs.get("max_bytes").and_then(Value::as_u64).unwrap_or(DEFAULT_MAX_BYTES),
    }));

    json!({
        "ok": fetched["ok"].as_bool().unwrap_or(false),
        "robots_url": fetched["effective_url"].clone(),
        "body_text": fetched["body_text"].clone(),
        "fetched_at": fetched["fetched_at"].clone(),
        "status_code": fetched["status_code"].clone(),
        "error_type": fetched["error_type"].clone(),
        "error_message": fetched["error_message"].clone(),
    })
}

pub fn parse_robots_txt(inputs: &Value) -> Value {
    let body = string_input(inputs, "body_text").unwrap_or_default();
    let user_agent =
        string_input(inputs, "user_agent").unwrap_or_else(|| DEFAULT_USER_AGENT.into());
    let parsed = parse_robots(&body, &user_agent);

    json!({
        "user_agent": user_agent,
        "allows": parsed.allows,
        "disallows": parsed.disallows,
        "sitemaps": parsed.sitemaps,
        "crawl_delay": parsed.crawl_delay,
        "groups": parsed.groups,
    })
}

pub fn fetch_sitemap(inputs: &Value) -> Value {
    let fetched_at = Utc::now().to_rfc3339();
    let sitemap_url = string_input(inputs, "sitemap_url")
        .or_else(|| string_input(inputs, "url"))
        .or_else(|| {
            string_input(inputs, "site_url").and_then(|site_url| {
                origin_from_url(&site_url).map(|origin| format!("{origin}/sitemap.xml"))
            })
        });
    let Some(sitemap_url) = sitemap_url else {
        return json!({
            "ok": false,
            "sitemap_url": Value::Null,
            "body_text": "",
            "fetched_at": fetched_at,
            "error_type": "validation_error",
            "error_message": "sitemap_url, url, or site_url must be provided"
        });
    };
    let fetched = fetch_page(&json!({
        "url": sitemap_url,
        "timeout_ms": inputs.get("timeout_ms").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS),
        "max_bytes": inputs.get("max_bytes").and_then(Value::as_u64).unwrap_or(DEFAULT_MAX_BYTES),
    }));

    json!({
        "ok": fetched["ok"].as_bool().unwrap_or(false),
        "sitemap_url": fetched["effective_url"].clone(),
        "body_text": fetched["body_text"].clone(),
        "fetched_at": fetched["fetched_at"].clone(),
        "status_code": fetched["status_code"].clone(),
        "error_type": fetched["error_type"].clone(),
        "error_message": fetched["error_message"].clone(),
    })
}

pub fn parse_sitemap(inputs: &Value) -> Value {
    let body = string_input(inputs, "body_text").unwrap_or_default();
    let max_urls = inputs
        .get("max_urls")
        .and_then(Value::as_u64)
        .unwrap_or(500)
        .min(10_000) as usize;
    let urls = blocks(&body, "url")
        .into_iter()
        .take(max_urls)
        .filter_map(|block| {
            let loc = extract_xml_text(&block, "loc")?;
            Some(json!({
                "loc": loc,
                "lastmod": extract_xml_text(&block, "lastmod"),
                "changefreq": extract_xml_text(&block, "changefreq"),
                "priority": extract_xml_text(&block, "priority"),
            }))
        })
        .collect::<Vec<_>>();
    let sitemap_indexes = blocks(&body, "sitemap")
        .into_iter()
        .take(max_urls)
        .filter_map(|block| {
            let loc = extract_xml_text(&block, "loc")?;
            Some(json!({
                "loc": loc,
                "lastmod": extract_xml_text(&block, "lastmod"),
            }))
        })
        .collect::<Vec<_>>();

    json!({
        "url_count": urls.len(),
        "sitemap_count": sitemap_indexes.len(),
        "urls": urls,
        "sitemaps": sitemap_indexes,
        "truncated": urls.len() >= max_urls || sitemap_indexes.len() >= max_urls,
    })
}

pub fn audit_metadata(inputs: &Value) -> Value {
    let html = body_input(inputs).unwrap_or_default();
    let metadata = crate::web_tools::extract_metadata(&json!({
        "html": html,
        "url": string_input(inputs, "url"),
    }));
    let headings = headings(&html);
    let title = metadata["title"].as_str();
    let description = metadata["description"].as_str();
    let checks = vec![
        check(
            "title_present",
            title.is_some_and(|value| !value.trim().is_empty()),
            "Add a concise title tag.",
        ),
        check(
            "title_length",
            title.is_some_and(|value| (30..=65).contains(&value.chars().count())),
            "Keep title near 30-65 characters.",
        ),
        check(
            "description_present",
            description.is_some_and(|value| !value.trim().is_empty()),
            "Add a useful meta description.",
        ),
        check(
            "description_length",
            description.is_some_and(|value| (70..=160).contains(&value.chars().count())),
            "Keep meta description near 70-160 characters.",
        ),
        check(
            "single_h1",
            headings["h1"]
                .as_array()
                .is_some_and(|items| items.len() == 1),
            "Use exactly one clear H1.",
        ),
        check(
            "canonical_present",
            metadata["canonical_url"]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty()),
            "Add a canonical URL when this page is indexable.",
        ),
    ];
    let issue_count = checks
        .iter()
        .filter(|item| !item["passed"].as_bool().unwrap_or(false))
        .count();

    json!({
        "metadata": metadata,
        "headings": headings,
        "checks": checks,
        "issue_count": issue_count,
    })
}

pub fn audit_indexability(inputs: &Value) -> Value {
    let url = string_input(inputs, "url");
    let fetched = if let Some(url) = url.clone() {
        fetch_page(&json!({
            "url": url,
            "timeout_ms": inputs.get("timeout_ms").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS),
            "max_bytes": inputs.get("max_bytes").and_then(Value::as_u64).unwrap_or(DEFAULT_MAX_BYTES),
        }))
    } else {
        json!({
            "ok": true,
            "status_code": Value::Null,
            "body_text": body_input(inputs).unwrap_or_default(),
            "effective_url": Value::Null,
            "error_type": Value::Null,
            "error_message": Value::Null,
        })
    };
    let html = fetched["body_text"].as_str().unwrap_or_default();
    let robots_body = string_input(inputs, "robots_txt").unwrap_or_default();
    let user_agent =
        string_input(inputs, "user_agent").unwrap_or_else(|| DEFAULT_USER_AGENT.into());
    let robots = parse_robots(&robots_body, &user_agent);
    let robots_allowed = url
        .as_deref()
        .map(|url| robots_allows_url(&robots, url))
        .unwrap_or(true);
    let robots_meta = robots_meta_directives(html);
    let noindex = robots_meta.iter().any(|directive| directive == "noindex");
    let status_indexable = fetched["status_code"]
        .as_u64()
        .map(|status| (200..=299).contains(&status))
        .unwrap_or(true);
    let indexable =
        fetched["ok"].as_bool().unwrap_or(false) && status_indexable && robots_allowed && !noindex;

    json!({
        "url": url,
        "indexable": indexable,
        "status_code": fetched["status_code"].clone(),
        "robots_allowed": robots_allowed,
        "robots_meta": robots_meta,
        "noindex": noindex,
        "reasons": indexability_reasons(fetched["ok"].as_bool().unwrap_or(false), status_indexable, robots_allowed, noindex),
        "checked_at": Utc::now().to_rfc3339(),
    })
}

pub fn extract_structured_data(inputs: &Value) -> Value {
    let html = body_input(inputs).unwrap_or_default();
    let mut items = Vec::new();
    let mut errors = Vec::new();
    for script in json_ld_scripts(&html) {
        match serde_json::from_str::<Value>(&script) {
            Ok(value) => collect_json_ld_items(&value, &mut items),
            Err(error) => errors.push(error.to_string()),
        }
    }
    let types = items
        .iter()
        .filter_map(|item| {
            item.get("@type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    json!({
        "items": items,
        "types": types,
        "errors": errors,
        "count": items.len(),
    })
}

pub fn validate_json_ld(inputs: &Value) -> Value {
    let payload = inputs
        .get("json_ld")
        .cloned()
        .or_else(|| inputs.get("structured_data").cloned())
        .unwrap_or(Value::Null);
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut items = Vec::new();
    match payload {
        Value::String(source) => match serde_json::from_str::<Value>(&source) {
            Ok(value) => collect_json_ld_items(&value, &mut items),
            Err(error) => errors.push(error.to_string()),
        },
        Value::Array(_) | Value::Object(_) => collect_json_ld_items(&payload, &mut items),
        _ => {
            errors.push("json_ld or structured_data must be a JSON object, array, or string".into())
        }
    }
    for item in &items {
        if item.get("@type").is_none() {
            warnings.push("JSON-LD item is missing @type.".to_string());
        }
        if item.get("@context").is_none() {
            warnings.push("JSON-LD item is missing @context.".to_string());
        }
    }

    json!({
        "valid": errors.is_empty(),
        "item_count": items.len(),
        "errors": errors,
        "warnings": warnings,
        "items": items,
    })
}

pub fn audit_links(inputs: &Value) -> Value {
    let html = body_input(inputs).unwrap_or_default();
    let base_url = string_input(inputs, "base_url").or_else(|| string_input(inputs, "url"));
    let base_origin = base_url.as_deref().and_then(origin_from_url);
    let mut links = Vec::new();
    for tag in find_start_tags(&html, "a") {
        let attrs = parse_attrs(&tag);
        let Some(href) = attrs.get("href").filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        let href = decode_html_entities(href.trim());
        let classification = classify_link(&href, base_origin.as_deref());
        links.push(json!({
            "href": href,
            "text": Value::Null,
            "rel": attrs.get("rel").cloned(),
            "classification": classification,
        }));
    }
    let internal_count = links
        .iter()
        .filter(|link| link["classification"] == "internal")
        .count();
    let external_count = links
        .iter()
        .filter(|link| link["classification"] == "external")
        .count();

    json!({
        "links": links,
        "internal_count": internal_count,
        "external_count": external_count,
    })
}

pub fn audit_canonical_hreflang(inputs: &Value) -> Value {
    let html = body_input(inputs).unwrap_or_default();
    let mut canonicals = Vec::new();
    let mut alternates = Vec::new();
    for tag in find_start_tags(&html, "link") {
        let attrs = parse_attrs(&tag);
        let rel = attrs
            .get("rel")
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if rel.split_whitespace().any(|part| part == "canonical") {
            if let Some(href) = attrs.get("href") {
                canonicals.push(decode_html_entities(href.trim()));
            }
        }
        if rel.split_whitespace().any(|part| part == "alternate") {
            if let (Some(hreflang), Some(href)) = (attrs.get("hreflang"), attrs.get("href")) {
                alternates.push(json!({
                    "hreflang": decode_html_entities(hreflang.trim()),
                    "href": decode_html_entities(href.trim()),
                }));
            }
        }
    }

    json!({
        "canonical_url": canonicals.first().cloned(),
        "canonical_count": canonicals.len(),
        "hreflang": alternates,
        "issues": canonical_hreflang_issues(canonicals.len(), &alternates),
    })
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
            string_input(inputs, "url").and_then(|url| {
                let fetched = fetch_page(&json!({
                    "url": url,
                    "timeout_ms": inputs.get("timeout_ms").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS),
                    "max_bytes": inputs.get("max_bytes").and_then(Value::as_u64).unwrap_or(DEFAULT_MAX_BYTES),
                }));
                fetched["ok"]
                    .as_bool()
                    .unwrap_or(false)
                    .then(|| fetched["body_text"].as_str().unwrap_or_default().to_string())
            })
        })
}

fn origin_from_url(url: &str) -> Option<String> {
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        ("http", rest)
    } else {
        return None;
    };
    let authority = rest.split('/').next()?.trim();
    if authority.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{authority}"))
}

#[derive(Clone, Debug)]
struct RobotsRules {
    allows: Vec<String>,
    disallows: Vec<String>,
    sitemaps: Vec<String>,
    crawl_delay: Option<String>,
    groups: Vec<Value>,
}

fn parse_robots(body: &str, user_agent: &str) -> RobotsRules {
    let requested = user_agent.to_ascii_lowercase();
    let mut sitemaps = Vec::new();
    let mut groups: Vec<(Vec<String>, Vec<(String, String)>)> = Vec::new();
    let mut current_agents = Vec::new();
    let mut current_rules = Vec::new();

    for raw_line in body.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        let field = field.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        match field.as_str() {
            "user-agent" => {
                if !current_agents.is_empty() && !current_rules.is_empty() {
                    groups.push((
                        std::mem::take(&mut current_agents),
                        std::mem::take(&mut current_rules),
                    ));
                }
                current_agents.push(value.to_ascii_lowercase());
            }
            "sitemap" => sitemaps.push(value),
            "allow" | "disallow" | "crawl-delay" => {
                if current_agents.is_empty() {
                    current_agents.push("*".into());
                }
                current_rules.push((field, value));
            }
            _ => {}
        }
    }
    if !current_agents.is_empty() || !current_rules.is_empty() {
        groups.push((current_agents, current_rules));
    }

    let selected_rules = groups
        .iter()
        .find(|(agents, _)| agents.iter().any(|agent| agent == &requested))
        .or_else(|| {
            groups
                .iter()
                .find(|(agents, _)| agents.iter().any(|agent| agent == "*"))
        })
        .map(|(_, rules)| rules.clone())
        .unwrap_or_default();
    let allows = selected_rules
        .iter()
        .filter(|(field, value)| field == "allow" && !value.is_empty())
        .map(|(_, value)| value.clone())
        .collect::<Vec<_>>();
    let disallows = selected_rules
        .iter()
        .filter(|(field, value)| field == "disallow" && !value.is_empty())
        .map(|(_, value)| value.clone())
        .collect::<Vec<_>>();
    let crawl_delay = selected_rules
        .iter()
        .find(|(field, _)| field == "crawl-delay")
        .map(|(_, value)| value.clone());
    let groups_value = groups
        .iter()
        .map(|(agents, rules)| json!({ "user_agents": agents, "rules": rules }))
        .collect::<Vec<_>>();

    RobotsRules {
        allows,
        disallows,
        sitemaps,
        crawl_delay,
        groups: groups_value,
    }
}

fn robots_allows_url(rules: &RobotsRules, url: &str) -> bool {
    let path = path_from_url(url);
    let mut best: Option<(usize, bool)> = None;
    for allow in &rules.allows {
        if robots_path_matches(&path, allow) {
            best = Some(best.map_or((allow.len(), true), |current| {
                if allow.len() >= current.0 {
                    (allow.len(), true)
                } else {
                    current
                }
            }));
        }
    }
    for disallow in &rules.disallows {
        if robots_path_matches(&path, disallow) {
            best = Some(best.map_or((disallow.len(), false), |current| {
                if disallow.len() > current.0 {
                    (disallow.len(), false)
                } else {
                    current
                }
            }));
        }
    }
    best.map(|(_, allowed)| allowed).unwrap_or(true)
}

fn path_from_url(url: &str) -> String {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let path_start = rest.find('/').unwrap_or(rest.len());
    if path_start == rest.len() {
        "/".into()
    } else {
        rest[path_start..].to_string()
    }
}

fn robots_path_matches(path: &str, rule: &str) -> bool {
    if rule.is_empty() {
        return false;
    }
    if let Some(prefix) = rule.strip_suffix('$') {
        return path == prefix || path.starts_with(prefix.trim_end_matches('*'));
    }
    if let Some((prefix, suffix)) = rule.split_once('*') {
        return path.starts_with(prefix) && path.contains(suffix);
    }
    path.starts_with(rule)
}

fn robots_meta_directives(html: &str) -> Vec<String> {
    let mut directives = BTreeSet::new();
    for tag in find_start_tags(html, "meta") {
        let attrs = parse_attrs(&tag);
        let name = attrs.get("name").map(|value| value.to_ascii_lowercase());
        if matches!(name.as_deref(), Some("robots" | "googlebot")) {
            if let Some(content) = attrs.get("content") {
                for directive in content.split(',') {
                    let directive = directive.trim().to_ascii_lowercase();
                    if !directive.is_empty() {
                        directives.insert(directive);
                    }
                }
            }
        }
    }
    directives.into_iter().collect()
}

fn indexability_reasons(
    ok: bool,
    status_indexable: bool,
    robots_allowed: bool,
    noindex: bool,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if !ok {
        reasons.push("Page fetch failed.".into());
    }
    if !status_indexable {
        reasons.push("HTTP status is not indexable.".into());
    }
    if !robots_allowed {
        reasons.push("robots.txt disallows crawling for the selected user agent.".into());
    }
    if noindex {
        reasons.push("Robots meta contains noindex.".into());
    }
    reasons
}

fn check(id: &str, passed: bool, recommendation: &str) -> Value {
    json!({
        "id": id,
        "passed": passed,
        "recommendation": if passed { Value::Null } else { Value::String(recommendation.into()) },
    })
}

fn headings(html: &str) -> Value {
    let mut output = serde_json::Map::new();
    for level in 1..=6 {
        let tag = format!("h{level}");
        let items = blocks(html, &tag)
            .into_iter()
            .map(|block| normalize_whitespace(&strip_tags(&block)))
            .filter(|value| !value.is_empty())
            .map(Value::String)
            .collect::<Vec<_>>();
        output.insert(tag, Value::Array(items));
    }
    Value::Object(output)
}

fn json_ld_scripts(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut scripts = Vec::new();
    let mut offset = 0;
    while let Some(relative_start) = lower[offset..].find("<script") {
        let start = offset + relative_start;
        let Some(open_end_relative) = lower[start..].find('>') else {
            break;
        };
        let open_end = start + open_end_relative + 1;
        let open_tag = &html[start..open_end];
        let attrs = parse_attrs(open_tag);
        let script_type = attrs.get("type").map(|value| value.to_ascii_lowercase());
        let Some(close_relative) = lower[open_end..].find("</script>") else {
            break;
        };
        let close = open_end + close_relative;
        if script_type.as_deref() == Some("application/ld+json") {
            scripts.push(decode_html_entities(html[open_end..close].trim()));
        }
        offset = close + "</script>".len();
    }
    scripts
}

fn collect_json_ld_items(value: &Value, items: &mut Vec<Value>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_json_ld_items(value, items);
            }
        }
        Value::Object(object) => {
            if let Some(graph) = object.get("@graph") {
                collect_json_ld_items(graph, items);
            } else {
                items.push(Value::Object(object.clone()));
            }
        }
        _ => {}
    }
}

fn canonical_hreflang_issues(canonical_count: usize, alternates: &[Value]) -> Vec<String> {
    let mut issues = Vec::new();
    if canonical_count == 0 {
        issues.push("Missing canonical link.".into());
    } else if canonical_count > 1 {
        issues.push("Multiple canonical links found.".into());
    }
    let mut hreflangs = BTreeSet::new();
    for alternate in alternates {
        if let Some(hreflang) = alternate.get("hreflang").and_then(Value::as_str) {
            if !hreflangs.insert(hreflang.to_ascii_lowercase()) {
                issues.push(format!("Duplicate hreflang value {hreflang}."));
            }
        }
    }
    issues
}

fn classify_link(href: &str, base_origin: Option<&str>) -> &'static str {
    if href.starts_with('#') || href.starts_with("mailto:") || href.starts_with("tel:") {
        return "utility";
    }
    if href.starts_with('/') {
        return "internal";
    }
    if let Some(origin) = origin_from_url(href) {
        if Some(origin.as_str()) == base_origin {
            "internal"
        } else {
            "external"
        }
    } else {
        "relative"
    }
}

fn blocks(body: &str, tag: &str) -> Vec<String> {
    let lower = body.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut output = Vec::new();
    let mut offset = 0;
    while let Some(relative_start) = lower[offset..].find(&open) {
        let start = offset + relative_start;
        let Some(content_start_relative) = lower[start..].find('>') else {
            break;
        };
        let content_start = start + content_start_relative + 1;
        let Some(relative_end) = lower[content_start..].find(&close) else {
            break;
        };
        let end = content_start + relative_end;
        output.push(body[content_start..end].to_string());
        offset = end + close.len();
    }
    output
}

fn extract_xml_text(body: &str, tag: &str) -> Option<String> {
    text_between(body, &format!("<{tag}>"), &format!("</{tag}>"))
        .map(|value| decode_html_entities(value.trim()))
        .filter(|value| !value.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;

    const HTML: &str = r#"
<html>
  <head>
    <title>Practical SEO Consulting Services</title>
    <meta name="description" content="SEO strategy, technical audits, and content planning for growing teams.">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="https://example.com/services/seo">
    <link rel="alternate" hreflang="en" href="https://example.com/services/seo">
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Service","name":"SEO Consulting"}
    </script>
  </head>
  <body>
    <h1>SEO Consulting</h1>
    <h2>Technical audits</h2>
    <a href="/contact">Contact</a>
    <a href="https://schema.org/">Schema</a>
  </body>
</html>
"#;

    #[test]
    fn parses_robots_rules_for_selected_agent() {
        let output = parse_robots_txt(&json!({
            "user_agent": "*",
            "body_text": "User-agent: *\nAllow: /public\nDisallow: /private\nSitemap: https://example.com/sitemap.xml"
        }));

        assert_eq!(output["allows"], json!(["/public"]));
        assert_eq!(output["disallows"], json!(["/private"]));
        assert_eq!(
            output["sitemaps"],
            json!(["https://example.com/sitemap.xml"])
        );
    }

    #[test]
    fn parses_sitemap_urls_and_indexes() {
        let output = parse_sitemap(&json!({
            "body_text": "<urlset><url><loc>https://example.com/a</loc><lastmod>2026-01-01</lastmod></url></urlset>"
        }));

        assert_eq!(output["url_count"], 1);
        assert_eq!(output["urls"][0]["loc"], "https://example.com/a");
    }

    #[test]
    fn audits_metadata_and_structured_data() {
        let metadata =
            audit_metadata(&json!({ "html": HTML, "url": "https://example.com/services/seo" }));
        assert_eq!(
            metadata["metadata"]["title"],
            "Practical SEO Consulting Services"
        );
        assert_eq!(metadata["headings"]["h1"][0], "SEO Consulting");
        assert_eq!(metadata["issue_count"], 0);

        let structured = extract_structured_data(&json!({ "html": HTML }));
        assert_eq!(structured["count"], 1);
        assert_eq!(structured["types"], json!(["Service"]));
    }

    #[test]
    fn audits_indexability_and_links() {
        let indexability = audit_indexability(&json!({
            "url": "https://example.com/private/page",
            "html": HTML,
            "robots_txt": "User-agent: *\nDisallow: /private"
        }));
        assert_eq!(indexability["indexable"], false);
        assert_eq!(indexability["robots_allowed"], false);

        let links =
            audit_links(&json!({ "html": HTML, "base_url": "https://example.com/services/seo" }));
        assert_eq!(links["internal_count"], 1);
        assert_eq!(links["external_count"], 1);
    }
}
