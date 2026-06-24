use crate::planner::operations::{OperationKind, OperationPlan, OperationStatus, PlannedOperation};

pub fn extract_operations(prompt: &str) -> OperationPlan {
    let normalized = prompt.to_ascii_lowercase();
    let mut plan = OperationPlan::new(prompt);

    if normalized.contains("csv") {
        push(
            &mut plan,
            OperationKind::ParseCsv,
            "Prompt mentions CSV parsing.",
        );
    }

    if requests_structured_data_transform(&normalized, prompt) {
        if requests_transform_filter(&normalized) {
            push(
                &mut plan,
                OperationKind::TransformFilter,
                "Prompt requests filtering structured data.",
            );
        }
        if requests_transform_sort(&normalized) {
            push(
                &mut plan,
                OperationKind::TransformSort,
                "Prompt requests sorting structured data.",
            );
        }
        if requests_transform_project(&normalized) {
            push(
                &mut plan,
                OperationKind::TransformProject,
                "Prompt requests projecting or reshaping structured data.",
            );
        }
        if requests_transform_limit(&normalized) {
            push(
                &mut plan,
                OperationKind::TransformLimit,
                "Prompt requests limiting structured data.",
            );
        }
        if !plan.operations.iter().any(|operation| {
            matches!(
                operation.kind,
                OperationKind::TransformFilter
                    | OperationKind::TransformSort
                    | OperationKind::TransformProject
                    | OperationKind::TransformLimit
            )
        }) {
            push(
                &mut plan,
                OperationKind::TransformProject,
                "Prompt requests transforming structured data.",
            );
        }
    }

    if is_json_ld_validation_prompt(&normalized) {
        push(
            &mut plan,
            OperationKind::ValidateJsonLd,
            "Prompt requests JSON-LD validation.",
        );
    }

    if requests_rss_feed(&normalized, prompt) {
        push(
            &mut plan,
            OperationKind::CollectRssFeed,
            "Prompt requests RSS or Atom feed collection.",
        );
    }

    if requests_weather_collection(&normalized) {
        push(
            &mut plan,
            OperationKind::CollectWeather,
            "Prompt requests deterministic weather collection.",
        );
    }

    if requests_news_collection(&normalized) {
        let inputs = explicit_news_search_query(prompt, &normalized)
            .map(|query| serde_json::json!({ "query": query }))
            .unwrap_or_else(|| serde_json::json!({}));
        push_with_inputs(
            &mut plan,
            OperationKind::CollectNews,
            "Prompt requests deterministic news collection.",
            inputs,
        );
    }

    if requests_web_page(&normalized, prompt) {
        push(
            &mut plan,
            OperationKind::CollectWebPage,
            "Prompt requests web page collection.",
        );
    }

    if requests_article_extraction(prompt) {
        push(
            &mut plan,
            OperationKind::ExtractArticle,
            "Prompt requests article extraction or article summary.",
        );
    }

    if requests_metadata_extraction(&normalized, prompt) {
        push(
            &mut plan,
            OperationKind::ExtractMetadata,
            "Prompt requests metadata extraction.",
        );
    }

    if requests_content_brief(&normalized) {
        push(
            &mut plan,
            OperationKind::PrepareSearchIntent,
            "Prompt requests content intent planning.",
        );
        push(
            &mut plan,
            OperationKind::PrepareContentBrief,
            "Prompt requests generating a content brief.",
        );
    }

    if contains_any(
        &normalized,
        &[
            "summarize",
            "summary",
            "report",
            "brief",
            "markdown",
            "artifact",
        ],
    ) {
        push(
            &mut plan,
            OperationKind::SynthesizeMarkdownArtifact,
            "Prompt requests final written output.",
        );
    }

    plan
}

fn push(plan: &mut OperationPlan, kind: OperationKind, evidence: &str) {
    push_with_inputs(plan, kind, evidence, serde_json::json!({}));
}

fn push_with_inputs(
    plan: &mut OperationPlan,
    kind: OperationKind,
    evidence: &str,
    inputs: serde_json::Value,
) {
    if plan
        .operations
        .iter()
        .any(|operation| operation.kind == kind)
    {
        return;
    }

    let id = format!(
        "op-{}",
        serde_json::to_value(kind)
            .unwrap()
            .as_str()
            .unwrap()
            .replace('.', "-")
    );

    plan.operations.push(PlannedOperation {
        id,
        kind,
        status: OperationStatus::Requested,
        evidence: evidence.into(),
        capability_id: None,
        step_id: None,
        inputs,
    });
}

fn is_json_ld_validation_prompt(normalized: &str) -> bool {
    contains_any(
        normalized,
        &["json-ld", "json ld", "schema payload", "structured data"],
    ) && contains_any(
        normalized,
        &["validate", "validation", "validates", "errors"],
    )
}

fn requests_web_page(normalized: &str, prompt: &str) -> bool {
    !detected_web_page_urls(prompt).is_empty()
        && !is_json_ld_validation_prompt(normalized)
        && (contains_any(
            normalized,
            &[
                "fetch",
                "open",
                "visit",
                "go to",
                "load",
                "read",
                "inspect",
                "browse",
                "web page",
                "article",
                "extract",
                "scrape",
                "summarize",
                "summary",
                "brief",
                "report",
                "analyze",
            ],
        ) || requests_metadata_extraction(normalized, prompt))
}

fn requests_rss_feed(normalized: &str, prompt: &str) -> bool {
    detected_urls(prompt).iter().any(|url| is_feed_url(url))
        && (contains_word(normalized, "rss")
            || contains_word(normalized, "atom")
            || contains_any(
                normalized,
                &[
                    "rss feed",
                    "atom feed",
                    "feed digest",
                    "fetch the feed",
                    "parse the feed",
                ],
            ))
}

fn requests_content_brief(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "content brief",
            "generate_brief",
            "generate brief",
            "final copy",
            "final draft",
            "site copy",
            "site content",
        ],
    )
}

fn requests_structured_data_transform(normalized: &str, prompt: &str) -> bool {
    contains_any(
        normalized,
        &[
            "transform",
            "filter",
            "where ",
            "sort",
            "order by",
            "select",
            "project",
            "limit",
            "top ",
            "reshape",
            "restructure",
            "keep only",
        ],
    ) && has_structured_data_context(normalized, prompt)
}

fn has_structured_data_context(normalized: &str, prompt: &str) -> bool {
    normalized.contains("csv")
        || contains_word(normalized, "data")
        || contains_any(
            normalized,
            &[
                "structured data",
                "structured record",
                "structured records",
                "record",
                "records",
                "dataset",
                "json",
                "array",
                "object",
                "rows",
                "items",
                "table",
                "provided",
                "available",
            ],
        )
        || contains_json_like_data(prompt)
}

fn requests_transform_filter(normalized: &str) -> bool {
    contains_any(normalized, &["filter", "where "])
}

fn requests_transform_sort(normalized: &str) -> bool {
    contains_any(normalized, &["sort", "order by", "ordered by"])
}

fn requests_transform_project(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "select",
            "project",
            "projection",
            "field",
            "fields",
            "column",
            "columns",
            "reshape",
            "restructure",
            "keep only",
        ],
    )
}

fn requests_transform_limit(normalized: &str) -> bool {
    contains_any(normalized, &["limit", "top ", "first "])
}

fn contains_json_like_data(prompt: &str) -> bool {
    prompt.contains("[{")
        || prompt.contains("[\n{")
        || prompt.contains("{\"")
        || prompt.contains("{\n\"")
}

fn requests_article_extraction(prompt: &str) -> bool {
    if detected_web_page_urls(prompt).is_empty() {
        return false;
    }

    let intent = normalized_prompt_without_urls(prompt);
    contains_any(
        &intent,
        &[
            "extract article",
            "article extraction",
            "article text",
            "readable article",
            "full text",
            "body text",
        ],
    ) || (contains_word(&intent, "article")
        && contains_any(&intent, &["summarize", "summary", "report", "brief"]))
}

fn normalized_prompt_without_urls(prompt: &str) -> String {
    let mut normalized = String::with_capacity(prompt.len());
    let mut search_from = 0;

    while search_from < prompt.len() {
        let next_http = prompt[search_from..].find("http://");
        let next_https = prompt[search_from..].find("https://");
        let Some(relative_start) = (match (next_http, next_https) {
            (Some(http), Some(https)) => Some(http.min(https)),
            (Some(http), None) => Some(http),
            (None, Some(https)) => Some(https),
            (None, None) => None,
        }) else {
            break;
        };

        let start = search_from + relative_start;
        normalized.push_str(&prompt[search_from..start].to_ascii_lowercase());
        normalized.push(' ');
        search_from = url_token_end(prompt, start);
    }

    normalized.push_str(&prompt[search_from..].to_ascii_lowercase());
    normalized
}

fn requests_metadata_extraction(normalized: &str, prompt: &str) -> bool {
    !detected_web_page_urls(prompt).is_empty() && has_metadata_extraction_language(normalized)
}

fn requests_weather_collection(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "weather.forecast_24h",
            "weather hourly_forecast",
            "weather.hourly_forecast",
            "weather forecast",
            "hourly forecast",
            "forecast for",
            "weather for",
            "weather in",
            "denver weather",
        ],
    )
}

fn requests_news_collection(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "news.trending",
            "news trending",
            "news.search",
            "news search",
            "trending news",
            "news headlines",
            "top news",
        ],
    )
}

fn explicit_news_search_query(prompt: &str, normalized: &str) -> Option<String> {
    let (start, marker) = ["news.search", "news search"]
        .iter()
        .filter_map(|marker| normalized.find(marker).map(|start| (start, *marker)))
        .min_by_key(|(start, _)| *start)?;
    let tail = &prompt[start + marker.len()..];
    let query = trim_news_search_prefix(tail);
    let query = truncate_news_search_query(query);
    let query = query.trim_matches(|character: char| {
        character.is_whitespace() || matches!(character, ',' | ';' | ':' | '.' | '-' | ')' | '(')
    });

    Some(if query.is_empty() {
        "news".to_string()
    } else {
        query.to_string()
    })
}

fn trim_news_search_prefix(mut value: &str) -> &str {
    loop {
        value = value.trim_start_matches(|character: char| {
            character.is_whitespace()
                || matches!(character, ',' | ';' | ':' | '.' | '-' | ')' | '(')
        });
        let lower = value.to_ascii_lowercase();
        let Some(prefix) = ["for ", "about ", "on ", "topic ", "query "]
            .iter()
            .find(|prefix| lower.starts_with(**prefix))
        else {
            return value;
        };
        value = &value[prefix.len()..];
    }
}

fn truncate_news_search_query(value: &str) -> &str {
    let lower = value.to_ascii_lowercase();
    let stop_at = [
        ", then",
        "; then",
        ". then",
        "\nthen",
        "then ",
        " then ",
        ", summarize",
        "; summarize",
        ". summarize",
        "\nsummarize",
        "summarize",
        " and summarize",
        ", write",
        "; write",
        ". write",
        " and write",
    ]
    .iter()
    .filter_map(|marker| lower.find(marker))
    .min()
    .unwrap_or(value.len());

    &value[..stop_at]
}

fn has_metadata_extraction_language(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "metadata",
            "title",
            "description",
            "canonical",
            "open graph",
        ],
    )
}

pub(crate) fn detected_urls(prompt: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut search_from = 0;

    while search_from < prompt.len() {
        let next_http = prompt[search_from..].find("http://");
        let next_https = prompt[search_from..].find("https://");
        let Some(relative_start) = (match (next_http, next_https) {
            (Some(http), Some(https)) => Some(http.min(https)),
            (Some(http), None) => Some(http),
            (None, Some(https)) => Some(https),
            (None, None) => None,
        }) else {
            break;
        };

        let start = search_from + relative_start;
        let end = url_token_end(prompt, start);
        let url = normalize_url_token(&prompt[start..end]);

        if is_collectable_url(prompt, start, end) && !url.is_empty() {
            urls.push(url);
        }

        search_from = start + 1;
    }

    urls
}

fn detected_web_page_urls(prompt: &str) -> Vec<String> {
    detected_urls(prompt)
        .into_iter()
        .filter(|url| !is_feed_url(url))
        .collect()
}

fn url_token_end(prompt: &str, start: usize) -> usize {
    for (offset, character) in prompt[start..].char_indices() {
        if character.is_whitespace()
            || matches!(
                character,
                '"' | '\'' | '`' | '<' | '>' | '{' | '}' | '[' | ']'
            )
        {
            return start + offset;
        }
    }

    prompt.len()
}

fn is_collectable_url(prompt: &str, start: usize, end: usize) -> bool {
    !is_inside_structured_payload(prompt, start) && has_explicit_web_context(prompt, start, end)
}

fn is_inside_structured_payload(prompt: &str, start: usize) -> bool {
    let mut in_double_quote = false;
    let mut in_single_quote = false;
    let mut in_backticks = false;
    let mut escaped = false;
    let mut brace_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut line_start = 0usize;

    for (index, character) in prompt.char_indices() {
        if index >= start {
            break;
        }

        if matches!(character, '\n' | '\r') {
            line_start = index + character.len_utf8();
            brace_depth = 0;
            bracket_depth = 0;
            continue;
        }

        if in_backticks {
            if character == '`' {
                in_backticks = false;
            }
            continue;
        }

        if in_double_quote {
            if escaped {
                escaped = false;
                continue;
            }

            if character == '\\' {
                escaped = true;
                continue;
            }

            if character == '"' {
                in_double_quote = false;
            }
            continue;
        }

        if in_single_quote {
            if escaped {
                escaped = false;
                continue;
            }

            if character == '\\' {
                escaped = true;
                continue;
            }

            if character == '\'' {
                in_single_quote = false;
            }
            continue;
        }

        match character {
            '`' => in_backticks = true,
            '"' => in_double_quote = true,
            '\'' if is_apostrophe_delimiter(prompt, index) => in_single_quote = true,
            '{' if is_structured_opener(prompt, line_start, index) => brace_depth += 1,
            '}' => brace_depth = brace_depth.saturating_sub(1),
            '[' if is_structured_opener(prompt, line_start, index) => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            _ => {}
        }
    }

    in_double_quote || in_single_quote || in_backticks || brace_depth > 0 || bracket_depth > 0
}

fn is_structured_opener(prompt: &str, line_start: usize, index: usize) -> bool {
    let prefix = prompt[line_start..index].trim_end();

    prefix.is_empty() || prefix.ends_with(':') || prefix.ends_with('=') || prefix.ends_with(',')
}

fn normalize_url_token(token: &str) -> String {
    token
        .trim_end_matches(|character: char| {
            matches!(
                character,
                ',' | ';' | '.' | ')' | '(' | '[' | ']' | '"' | '\'' | '`' | '>' | '<'
            )
        })
        .to_string()
}

fn has_explicit_web_context(prompt: &str, start: usize, end: usize) -> bool {
    let line_start = prompt[..start]
        .rfind(['\n', '\r'])
        .map(|index| index + 1)
        .unwrap_or(0);
    let line_end = prompt[end..]
        .find(['\n', '\r'])
        .map(|index| end + index)
        .unwrap_or(prompt.len());
    let line = prompt[line_start..line_end].to_ascii_lowercase();
    let line = line.as_str();

    has_web_context_text(line)
        || previous_short_line(prompt, line_start).is_some_and(|previous_line| {
            let combined = format!("{} {}", previous_line.to_ascii_lowercase(), line);
            has_web_context_text(&combined)
        })
}

fn is_feed_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };

    let last_segment = parsed
        .path()
        .trim_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();

    matches!(
        last_segment.as_str(),
        "feed" | "rss" | "atom" | "feed.xml" | "rss.xml" | "atom.xml"
    ) || last_segment.ends_with(".rss")
        || last_segment.ends_with(".atom")
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn previous_short_line(prompt: &str, line_start: usize) -> Option<&str> {
    let previous_line_end = line_start.checked_sub(1)?;
    let previous_line_start = prompt[..previous_line_end]
        .rfind(['\n', '\r'])
        .map(|index| index + 1)
        .unwrap_or(0);
    let previous_line = prompt[previous_line_start..line_start].trim_matches(['\r', '\n']);

    if previous_line.is_empty()
        || previous_line.len() > 80
        || contains_any(previous_line, &["http://", "https://"])
    {
        None
    } else {
        Some(previous_line)
    }
}

fn has_web_context_text(haystack: &str) -> bool {
    contains_any(
        haystack,
        &[
            "fetch", "open", "visit", "go to", "load", "read", "inspect", "browse", "scrape",
            "crawl", "retrieve",
        ],
    ) || has_metadata_extraction_language(haystack)
        || (contains_any(
            haystack,
            &["summarize", "summary", "extract", "report", "brief"],
        ) && contains_any(
            haystack,
            &[
                "page", "web page", "webpage", "article", "site", "website", "content", "source",
                "feed",
            ],
        ))
}

fn contains_word(haystack: &str, word: &str) -> bool {
    haystack.match_indices(word).any(|(start, _)| {
        let end = start + word.len();
        let before = haystack[..start].chars().next_back();
        let after = haystack[end..].chars().next();
        before
            .map(|c| !c.is_ascii_alphanumeric() && c != '_')
            .unwrap_or(true)
            && after
                .map(|c| !c.is_ascii_alphanumeric() && c != '_')
                .unwrap_or(true)
    })
}

fn is_apostrophe_delimiter(prompt: &str, index: usize) -> bool {
    let before = prompt[..index].chars().next_back();
    let after = prompt[index + '\''.len_utf8()..].chars().next();

    !matches!(
        (before, after),
        (Some(before), Some(after)) if before.is_ascii_alphabetic() && after.is_ascii_alphabetic()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::operations::OperationKind;

    #[test]
    fn extracts_csv_parse_filter_sort_project_limit_and_synthesis() {
        let plan = extract_operations(
            "Create a CSV report: parse this CSV, filter status=active, sort by revenue, select name,revenue, limit 5, then summarize.\nname,status,revenue\nAcme,active,42"
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::ParseCsv));
        assert!(kinds.contains(&OperationKind::TransformFilter));
        assert!(kinds.contains(&OperationKind::TransformSort));
        assert!(kinds.contains(&OperationKind::TransformProject));
        assert!(kinds.contains(&OperationKind::TransformLimit));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
    }

    #[test]
    fn json_ld_payload_does_not_request_web_collection() {
        let plan = extract_operations(
            r#"Validate this JSON-LD and summarize errors: {"@context":"https://schema.org","@type":"FAQPage"}"#,
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::ValidateJsonLd));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
        assert!(!kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::CollectUrlStatus));
    }

    #[test]
    fn json_payload_url_does_not_request_web_collection() {
        let plan = extract_operations(
            r#"Summarize this JSON payload: {"source":"https://example.com/pricing","status":"active"}"#,
        );
        let kinds = operation_kinds(&plan);

        assert!(!kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::CollectUrlStatus));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
    }

    #[test]
    fn same_line_plain_text_url_with_web_context_requests_web_collection() {
        let plan = extract_operations("Summarize https://example.com/article page");
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::CollectUrlStatus));
    }

    #[test]
    fn next_line_plain_text_url_with_previous_web_context_requests_web_collection() {
        let plan = extract_operations("Summarize this page:\nhttps://example.com/article");
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::CollectUrlStatus));
    }

    #[test]
    fn contraction_before_plain_text_url_does_not_block_web_collection() {
        let plan = extract_operations("don't summarize https://example.com/article page");
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::CollectUrlStatus));
    }

    #[test]
    fn csv_payload_url_does_not_request_web_collection() {
        let plan =
            extract_operations("Summarize this CSV: name,url\nAcme,https://example.com/pricing");
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::ParseCsv));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
        assert!(!kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::CollectUrlStatus));
    }

    #[test]
    fn structured_records_prompt_extracts_transform_without_csv_parse() {
        let plan = extract_operations(
            "Sort the provided JSON records by score, keep the top 3, then summarize.",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::TransformSort));
        assert!(kinds.contains(&OperationKind::TransformLimit));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
        assert!(!kinds.contains(&OperationKind::ParseCsv));
        assert!(!kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::CollectRssFeed));
    }

    #[test]
    fn available_structured_data_prompt_extracts_projection_transform() {
        let plan = extract_operations(
            "Using the available structured data, reshape the rows to select customer,total before the final summary.",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::TransformProject));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
        assert!(!kinds.contains(&OperationKind::ParseCsv));
        assert!(!kinds.contains(&OperationKind::CollectWebPage));
    }

    #[test]
    fn top_news_prompt_does_not_extract_data_limit_transform() {
        let plan = extract_operations("Create a brief with top news headlines, then summarize.");
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectNews));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
        assert!(!kinds.contains(&OperationKind::TransformLimit));
        assert!(!kinds.contains(&OperationKind::TransformProject));
    }

    #[test]
    fn metadata_prompt_does_not_use_data_substring_as_transform_context() {
        let plan = extract_operations(
            "Fetch https://example.com and extract metadata fields, then sort the metadata report by title.",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectWebPage));
        assert!(kinds.contains(&OperationKind::ExtractMetadata));
        assert!(!kinds.contains(&OperationKind::TransformSort));
        assert!(!kinds.contains(&OperationKind::TransformProject));
    }

    #[test]
    fn csv_title_description_columns_do_not_request_web_metadata() {
        let plan = extract_operations(
            "Create a CSV report: parse this CSV and summarize title and description.\ntitle,description\nLaunch plan,Internal draft",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::ParseCsv));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
        assert!(!kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::ExtractMetadata));
    }

    #[test]
    fn csv_article_column_does_not_request_article_extraction() {
        let plan = extract_operations(
            "Create a CSV report: parse this CSV and summarize the article column.\narticle,score\nLaunch plan,42",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::ParseCsv));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
        assert!(!kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::ExtractArticle));
    }

    #[test]
    fn feed_like_url_does_not_request_rss_feed() {
        let plan = extract_operations(
            "Fetch https://example.com/feedback and extract title and description metadata.",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectWebPage));
        assert!(kinds.contains(&OperationKind::ExtractMetadata));
        assert!(!kinds.contains(&OperationKind::CollectRssFeed));
    }

    #[test]
    fn metadata_prompt_with_article_url_path_does_not_request_article_extraction() {
        let plan = extract_operations("Extract title metadata from https://example.com/article");
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectWebPage));
        assert!(kinds.contains(&OperationKind::ExtractMetadata));
        assert!(!kinds.contains(&OperationKind::ExtractArticle));
    }

    #[test]
    fn article_text_and_metadata_prompt_requests_article_extraction() {
        let plan = extract_operations(
            "Summarize the article at https://example.com/article and extract article text and metadata.",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectWebPage));
        assert!(kinds.contains(&OperationKind::ExtractArticle));
        assert!(kinds.contains(&OperationKind::ExtractMetadata));
    }

    #[test]
    fn feed_only_prompt_does_not_request_web_page_or_metadata() {
        let plan = extract_operations(
            "Create an RSS feed digest from https://example.com/feed.xml; fetch and parse the feed entries, then summarize the titles.",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectRssFeed));
        assert!(!kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::ExtractMetadata));
    }

    #[test]
    fn feed_prompt_without_url_does_not_request_rss_collection() {
        let plan = extract_operations("Create an RSS feed digest.");
        let kinds = operation_kinds(&plan);

        assert!(!kinds.contains(&OperationKind::CollectRssFeed));
    }

    #[test]
    fn prompt_with_feed_and_page_requests_both_collections() {
        let plan = extract_operations(
            "Fetch the RSS feed https://example.com/feed.xml and summarize the page https://example.com/article page",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectRssFeed));
        assert!(kinds.contains(&OperationKind::CollectWebPage));
    }

    #[test]
    fn csv_prompt_can_request_weather_and_news_collection() {
        let plan = extract_operations(
            "Create a deterministic operations brief: parse this CSV, collect the Denver weather forecast and trending news headlines, then summarize all results.\nregion,revenue\nwest,42",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::ParseCsv));
        assert!(kinds.contains(&OperationKind::CollectWeather));
        assert!(kinds.contains(&OperationKind::CollectNews));
    }

    #[test]
    fn explicit_news_search_prompt_records_query_input() {
        let plan = extract_operations(
            "Create a brief: news.search AI regulation updates, then summarize implications.",
        );
        let news = plan
            .operations
            .iter()
            .find(|operation| operation.kind == OperationKind::CollectNews)
            .expect("explicit news search should request news collection");

        assert_eq!(news.inputs["query"], "AI regulation updates");
    }

    #[test]
    fn csv_headlines_column_does_not_request_news_collection() {
        let plan = extract_operations(
            "Create a CSV report summarizing the headlines column.\nheadlines,count\nLaunch update,3",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::ParseCsv));
        assert!(!kinds.contains(&OperationKind::CollectNews));
    }

    #[test]
    fn csv_article_column_does_not_request_article_extraction_without_url() {
        let plan = extract_operations(
            "Create a CSV article report and summarize the article column.\narticle,count\nLaunch post,3",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::ParseCsv));
        assert!(!kinds.contains(&OperationKind::ExtractArticle));
    }

    #[test]
    fn bracketed_prose_before_plain_text_url_still_requests_web_collection() {
        let plan = extract_operations("Summarize [draft notes\nhttps://example.com/article page");
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectWebPage));
        assert!(!kinds.contains(&OperationKind::CollectUrlStatus));
    }

    #[test]
    fn feed_url_with_sentence_period_still_requests_rss_collection() {
        let plan = extract_operations("Fetch the RSS feed https://example.com/feed.xml.");
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectRssFeed));
    }

    #[test]
    fn content_brief_prompt_with_url_extracts_prepare_content_brief() {
        let plan = extract_operations(
            "Create a content brief for https://example.com using content.generate_brief, then draft final copy.",
        );
        let kinds = operation_kinds(&plan);

        assert!(kinds.contains(&OperationKind::CollectWebPage));
        assert!(kinds.contains(&OperationKind::PrepareSearchIntent));
        assert!(kinds.contains(&OperationKind::PrepareContentBrief));
        assert!(kinds.contains(&OperationKind::SynthesizeMarkdownArtifact));
    }

    fn operation_kinds(plan: &crate::planner::operations::OperationPlan) -> Vec<OperationKind> {
        plan.operations
            .iter()
            .map(|operation| operation.kind)
            .collect()
    }
}
