use crate::web_tools::{decode_html_entities, fetch_page, text_between};
use serde_json::{json, Value};

const DEFAULT_MAX_ITEMS: usize = 10;
const MAX_ITEMS: usize = 50;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_FEED_BYTES: u64 = 1024 * 1024;

const DEFAULT_FEEDS: &[&str] = &[
    "https://feeds.npr.org/1001/rss.xml",
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://apnews.com/hub/ap-top-news?output=rss",
];

#[derive(Clone, Debug, PartialEq)]
struct FeedEntry {
    title: Option<String>,
    link: Option<String>,
    summary: Option<String>,
    published: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct FeedDocument {
    title: Option<String>,
    entries: Vec<FeedEntry>,
}

pub fn fetch_feed(inputs: &Value) -> Value {
    let url = string_input(inputs, "url");
    let max_items = max_items(inputs);
    let Some(body) = string_input(inputs, "body_text") else {
        let Some(url) = url.clone() else {
            return json!({
                "ok": false,
                "url": Value::Null,
                "title": Value::Null,
                "entries": [],
                "error_type": "validation_error",
                "error_message": "url must be a non-empty string when body_text is not provided",
            });
        };
        let fetched = fetch_page(&json!({
            "url": url,
            "timeout_ms": inputs
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_TIMEOUT_MS),
            "max_bytes": inputs
                .get("max_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_FEED_BYTES),
        }));
        if !fetched["ok"].as_bool().unwrap_or(false) {
            return json!({
                "ok": false,
                "url": fetched["effective_url"].clone(),
                "title": Value::Null,
                "entries": [],
                "error_type": fetched["error_type"].clone(),
                "error_message": fetched["error_message"].clone(),
            });
        }
        return feed_value(
            url_from_value(&fetched["effective_url"]).or(Some(url)),
            parse_feed(
                &fetched["body_text"].as_str().unwrap_or_default(),
                max_items,
            ),
            true,
            None,
            None,
        );
    };

    feed_value(url, parse_feed(&body, max_items), true, None, None)
}

pub fn trending(inputs: &Value) -> Value {
    let max_items = max_items(inputs);
    let feeds = configured_feeds(inputs);
    let mut items = Vec::new();
    let mut source_errors = Vec::new();

    for feed in feeds {
        if items.len() >= max_items {
            break;
        }
        let feed_output = fetch_feed(&json!({
            "url": feed.url,
            "body_text": feed.body_text,
            "max_items": max_items,
            "timeout_ms": inputs
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_TIMEOUT_MS),
            "max_bytes": inputs
                .get("max_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_FEED_BYTES),
        }));

        if !feed_output["ok"].as_bool().unwrap_or(false) {
            source_errors.push(json!({
                "url": feed_output["url"].clone(),
                "error_type": feed_output["error_type"].clone(),
                "error_message": feed_output["error_message"].clone(),
            }));
            continue;
        }

        let source_title = feed_output["title"].as_str().map(str::to_string);
        let source_url = feed_output["url"].as_str().map(str::to_string);
        for entry in feed_output["entries"].as_array().into_iter().flatten() {
            if items.len() >= max_items {
                break;
            }
            let mut item = entry.clone();
            if let Some(object) = item.as_object_mut() {
                object.insert("source_title".to_string(), json!(source_title));
                object.insert("source_url".to_string(), json!(source_url));
            }
            items.push(item);
        }
    }

    json!({
        "items": items,
        "source_errors": source_errors,
    })
}

pub fn search(inputs: &Value) -> Value {
    let terms = string_input(inputs, "query")
        .unwrap_or_default()
        .to_ascii_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .filter(|term| !term.is_empty())
        .collect::<Vec<_>>();

    let trending_output = trending(inputs);
    let mut items = Vec::new();
    for item in trending_output["items"].as_array().into_iter().flatten() {
        let haystack = format!(
            "{} {}",
            item["title"].as_str().unwrap_or_default(),
            item["summary"].as_str().unwrap_or_default()
        )
        .to_ascii_lowercase();
        if terms.iter().all(|term| haystack.contains(term)) {
            items.push(item.clone());
        }
    }

    json!({
        "query": string_input(inputs, "query").unwrap_or_default(),
        "items": items,
        "source_errors": trending_output["source_errors"].clone(),
    })
}

fn feed_value(
    url: Option<String>,
    document: FeedDocument,
    ok: bool,
    error_type: Option<&str>,
    error_message: Option<&str>,
) -> Value {
    let entries = document
        .entries
        .into_iter()
        .map(|entry| {
            json!({
                "title": entry.title,
                "link": entry.link,
                "summary": entry.summary,
                "published": entry.published,
            })
        })
        .collect::<Vec<_>>();

    json!({
        "ok": ok,
        "url": url,
        "title": document.title,
        "entries": entries,
        "error_type": error_type,
        "error_message": error_message,
    })
}

fn parse_feed(body: &str, max_items: usize) -> FeedDocument {
    if body.to_ascii_lowercase().contains("<entry") {
        parse_atom(body, max_items)
    } else {
        parse_rss(body, max_items)
    }
}

fn parse_rss(body: &str, max_items: usize) -> FeedDocument {
    let channel = text_between(body, "<channel", "</channel>").unwrap_or_else(|| body.to_string());
    let first_item_index = channel
        .to_ascii_lowercase()
        .find("<item")
        .unwrap_or(channel.len());
    let title = extract_xml_text(&channel[..first_item_index], "title");
    let entries = blocks(&channel, "item")
        .into_iter()
        .take(max_items)
        .filter_map(|block| {
            let entry = FeedEntry {
                title: extract_xml_text(&block, "title"),
                link: extract_xml_text(&block, "link"),
                summary: extract_xml_text(&block, "description"),
                published: extract_xml_text(&block, "pubdate"),
            };
            if entry.title.is_some() || entry.link.is_some() || entry.summary.is_some() {
                Some(entry)
            } else {
                None
            }
        })
        .collect();

    FeedDocument { title, entries }
}

fn parse_atom(body: &str, max_items: usize) -> FeedDocument {
    let first_entry_index = body
        .to_ascii_lowercase()
        .find("<entry")
        .unwrap_or(body.len());
    let title = extract_xml_text(&body[..first_entry_index], "title");
    let entries = blocks(body, "entry")
        .into_iter()
        .take(max_items)
        .filter_map(|block| {
            let entry = FeedEntry {
                title: extract_xml_text(&block, "title"),
                link: extract_atom_link(&block),
                summary: extract_xml_text(&block, "summary")
                    .or_else(|| extract_xml_text(&block, "content")),
                published: extract_xml_text(&block, "updated")
                    .or_else(|| extract_xml_text(&block, "published")),
            };
            if entry.title.is_some() || entry.link.is_some() || entry.summary.is_some() {
                Some(entry)
            } else {
                None
            }
        })
        .collect();

    FeedDocument { title, entries }
}

fn blocks(input: &str, tag_name: &str) -> Vec<String> {
    let lower = input.to_ascii_lowercase();
    let open = format!("<{tag_name}");
    let close = format!("</{tag_name}>");
    let mut offset = 0;
    let mut blocks = Vec::new();

    while let Some(relative_start) = lower[offset..].find(&open) {
        let start = offset + relative_start;
        let after_name = start + open.len();
        let Some(next_char) = lower[after_name..].chars().next() else {
            break;
        };
        if !next_char.is_whitespace() && next_char != '>' {
            offset = after_name;
            continue;
        }
        let Some(relative_end) = lower[start..].find(&close) else {
            break;
        };
        let end = start + relative_end + close.len();
        blocks.push(input[start..end].to_string());
        offset = end;
    }

    blocks
}

fn extract_xml_text(input: &str, tag_name: &str) -> Option<String> {
    let lower = input.to_ascii_lowercase();
    let open = format!("<{tag_name}");
    let close = format!("</{tag_name}>");
    let start = lower.find(&open)?;
    let content_start = lower[start..].find('>')? + start + 1;
    let content_end = lower[content_start..].find(&close)? + content_start;
    let raw = input[content_start..content_end].trim();
    let cleaned = raw
        .strip_prefix("<![CDATA[")
        .and_then(|value| value.strip_suffix("]]>"))
        .unwrap_or(raw)
        .trim();
    Some(normalize_whitespace(&decode_html_entities(cleaned))).filter(|value| !value.is_empty())
}

fn extract_atom_link(input: &str) -> Option<String> {
    let lower = input.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(relative_start) = lower[offset..].find("<link") {
        let start = offset + relative_start;
        let Some(relative_end) = lower[start..].find('>') else {
            break;
        };
        let end = start + relative_end + 1;
        let tag = &input[start..end];
        let attrs = parse_attrs(tag);
        if attrs
            .get("rel")
            .is_none_or(|rel| rel == "alternate" || rel.is_empty())
        {
            if let Some(href) = attrs.get("href") {
                return Some(decode_html_entities(href.trim()));
            }
        }
        offset = end;
    }
    extract_xml_text(input, "link")
}

fn parse_attrs(tag: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let mut chars = tag
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim_end_matches('/')
        .chars()
        .peekable();

    while chars.peek().is_some_and(|ch| !ch.is_whitespace()) {
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
            attrs.push((name.to_ascii_lowercase(), String::new()));
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
        attrs.push((name.to_ascii_lowercase(), value));
    }

    attrs
}

trait AttrLookup {
    fn get(&self, name: &str) -> Option<&String>;
}

impl AttrLookup for Vec<(String, String)> {
    fn get(&self, name: &str) -> Option<&String> {
        self.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }
}

#[derive(Clone, Debug)]
struct ConfiguredFeed {
    url: Option<String>,
    body_text: Option<String>,
}

fn configured_feeds(inputs: &Value) -> Vec<ConfiguredFeed> {
    let Some(feeds) = inputs.get("feeds").and_then(Value::as_array) else {
        return DEFAULT_FEEDS
            .iter()
            .map(|url| ConfiguredFeed {
                url: Some((*url).to_string()),
                body_text: None,
            })
            .collect();
    };

    feeds
        .iter()
        .map(|feed| {
            if let Some(url) = feed.as_str() {
                ConfiguredFeed {
                    url: Some(url.trim().to_string()).filter(|value| !value.is_empty()),
                    body_text: None,
                }
            } else {
                ConfiguredFeed {
                    url: string_input(feed, "url"),
                    body_text: string_input(feed, "body_text"),
                }
            }
        })
        .collect()
}

fn max_items(inputs: &Value) -> usize {
    inputs
        .get("max_items")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_MAX_ITEMS as u64)
        .clamp(1, MAX_ITEMS as u64) as usize
}

fn string_input(inputs: &Value, key: &str) -> Option<String> {
    inputs
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn url_from_value(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn normalize_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RSS: &str = r#"
<rss version="2.0">
  <channel>
    <title>Fixture RSS</title>
    <item>
      <title>Rust ships deterministic providers</title>
      <link>https://example.com/rust</link>
      <description>Provider capabilities are now testable.</description>
      <pubDate>Sun, 21 Jun 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Weather providers are implemented</title>
      <link>https://example.com/weather</link>
      <description>Forecast work is separate.</description>
    </item>
  </channel>
</rss>
"#;

    const ATOM: &str = r#"
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Fixture Atom</title>
  <entry>
    <title>Atom headline</title>
    <link href="https://example.com/atom"/>
    <summary>Atom summary text.</summary>
    <updated>2026-06-21T13:00:00Z</updated>
  </entry>
</feed>
"#;

    #[test]
    fn fetch_feed_parses_rss_fixture_without_network_when_body_text_is_supplied() {
        let output = fetch_feed(&json!({
            "url": "https://example.com/rss.xml",
            "body_text": RSS,
            "max_items": 1
        }));

        assert_eq!(output["ok"], true);
        assert_eq!(output["title"], "Fixture RSS");
        assert_eq!(output["entries"].as_array().unwrap().len(), 1);
        assert_eq!(
            output["entries"][0]["title"],
            "Rust ships deterministic providers"
        );
        assert_eq!(output["entries"][0]["link"], "https://example.com/rust");
        assert_eq!(
            output["entries"][0]["summary"],
            "Provider capabilities are now testable."
        );
        assert_eq!(
            output["entries"][0]["published"],
            "Sun, 21 Jun 2026 12:00:00 GMT"
        );
    }

    #[test]
    fn fetch_feed_parses_atom_links_and_updated_dates() {
        let output = fetch_feed(&json!({
            "url": "https://example.com/atom.xml",
            "body_text": ATOM,
            "max_items": 5
        }));

        assert_eq!(output["ok"], true);
        assert_eq!(output["title"], "Fixture Atom");
        assert_eq!(output["entries"][0]["title"], "Atom headline");
        assert_eq!(output["entries"][0]["link"], "https://example.com/atom");
        assert_eq!(output["entries"][0]["published"], "2026-06-21T13:00:00Z");
    }

    #[test]
    fn fetch_feed_returns_empty_entries_for_malformed_xml() {
        let output = fetch_feed(&json!({
            "url": "https://example.com/bad.xml",
            "body_text": "<rss><channel><item>",
            "max_items": 10
        }));

        assert_eq!(output["ok"], true);
        assert_eq!(output["entries"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn trending_uses_supplied_feeds_best_effort_and_reports_source_errors() {
        let output = trending(&json!({
            "max_items": 5,
            "feeds": [
                { "url": "https://example.com/rss.xml", "body_text": RSS },
                { "url": "", "body_text": "" }
            ]
        }));

        assert_eq!(output["items"].as_array().unwrap().len(), 2);
        assert_eq!(output["items"][0]["source_title"], "Fixture RSS");
        assert_eq!(output["source_errors"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn search_filters_trending_feed_items_by_query_terms() {
        let output = search(&json!({
            "query": "deterministic provider",
            "max_items": 10,
            "feeds": [
                { "url": "https://example.com/rss.xml", "body_text": RSS },
                { "url": "https://example.com/atom.xml", "body_text": ATOM }
            ]
        }));

        assert_eq!(output["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            output["items"][0]["title"],
            "Rust ships deterministic providers"
        );
    }
}
