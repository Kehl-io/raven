use serde_json::{json, Value};
use std::collections::BTreeSet;

pub fn map_search_intent(inputs: &Value) -> Value {
    let topic = string_input(inputs, "topic").unwrap_or_default();
    let page_type = string_input(inputs, "page_type").unwrap_or_default();
    let explicit_intent = string_input(inputs, "search_intent");
    let inferred_intent = explicit_intent.unwrap_or_else(|| infer_intent(&topic, &page_type));
    let audience = string_input(inputs, "audience");
    let goal = string_input(inputs, "business_goal");

    json!({
        "topic": topic,
        "page_type": page_type,
        "search_intent": inferred_intent,
        "audience": audience,
        "business_goal": goal,
        "content_angle": content_angle(&inferred_intent, &page_type),
        "recommended_sections": recommended_sections(&inferred_intent, &page_type),
    })
}

pub fn generate_content_brief(inputs: &Value) -> Value {
    let intent = map_search_intent(inputs);
    let topic = intent["topic"].as_str().unwrap_or_default();
    let audience = intent["audience"].as_str();
    let business_goal = intent["business_goal"].as_str();
    let primary_keyword =
        string_input(inputs, "primary_keyword").unwrap_or_else(|| topic.to_string());
    let secondary_keywords = string_array(inputs, "secondary_keywords");
    let sources = array_or_empty(inputs, "sources");
    let competitors = array_or_empty(inputs, "competitors");
    let required_evidence = source_refs(&sources, &competitors);
    let questions = question_set(
        topic,
        intent["search_intent"].as_str().unwrap_or("informational"),
    );

    json!({
        "topic": topic,
        "audience": audience,
        "business_goal": business_goal,
        "page_type": intent["page_type"].clone(),
        "search_intent": intent["search_intent"].clone(),
        "primary_keyword": primary_keyword,
        "secondary_keywords": secondary_keywords,
        "content_angle": intent["content_angle"].clone(),
        "recommended_sections": intent["recommended_sections"].clone(),
        "questions_to_answer": questions,
        "required_evidence": required_evidence,
        "internal_link_targets": string_array(inputs, "internal_link_targets"),
        "schema_recommendations": schema_recommendations(intent["page_type"].as_str().unwrap_or_default()),
        "writing_instructions": writing_instructions(),
    })
}

pub fn identify_content_gaps(inputs: &Value) -> Value {
    let target_sections = string_array(inputs, "target_sections");
    let own_sections = string_array(inputs, "own_sections");
    let competitor_sections = string_array(inputs, "competitor_sections");
    let own = own_sections
        .iter()
        .map(|value| normalize_key(value))
        .collect::<BTreeSet<_>>();
    let mut missing = Vec::new();
    for section in target_sections.iter().chain(competitor_sections.iter()) {
        if !own.contains(&normalize_key(section))
            && !missing
                .iter()
                .any(|value: &String| normalize_key(value) == normalize_key(section))
        {
            missing.push(section.clone());
        }
    }

    json!({
        "missing_sections": missing,
        "own_section_count": own_sections.len(),
        "competitor_section_count": competitor_sections.len(),
        "recommendations": gap_recommendations(&own_sections, &competitor_sections),
    })
}

pub fn score_content_quality(inputs: &Value) -> Value {
    let content = string_input(inputs, "content").unwrap_or_default();
    let topic = string_input(inputs, "topic").unwrap_or_default();
    let audience = string_input(inputs, "audience");
    let required_terms = string_array(inputs, "required_terms");
    let word_count = content.split_whitespace().count();
    let heading_count = content
        .lines()
        .filter(|line| line.trim_start().starts_with('#'))
        .count();
    let lower = content.to_ascii_lowercase();
    let missing_terms = required_terms
        .iter()
        .filter(|term| !lower.contains(&term.to_ascii_lowercase()))
        .cloned()
        .collect::<Vec<_>>();
    let has_topic = topic.is_empty() || lower.contains(&topic.to_ascii_lowercase());
    let has_audience = audience
        .as_deref()
        .map(|value| lower.contains(&value.to_ascii_lowercase()))
        .unwrap_or(true);
    let score = quality_score(
        word_count,
        heading_count,
        has_topic,
        has_audience,
        missing_terms.len(),
    );

    json!({
        "score": score,
        "word_count": word_count,
        "heading_count": heading_count,
        "has_topic": has_topic,
        "has_audience": has_audience,
        "missing_terms": missing_terms,
        "recommendations": quality_recommendations(score, word_count, heading_count, has_topic, has_audience),
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

fn string_array(inputs: &Value, key: &str) -> Vec<String> {
    inputs
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn array_or_empty(inputs: &Value, key: &str) -> Vec<Value> {
    inputs
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn infer_intent(topic: &str, page_type: &str) -> String {
    let haystack = format!("{topic} {page_type}").to_ascii_lowercase();
    if haystack.contains("buy")
        || haystack.contains("pricing")
        || haystack.contains("quote")
        || haystack.contains("landing")
    {
        "transactional".into()
    } else if haystack.contains("best")
        || haystack.contains("compare")
        || haystack.contains("alternative")
        || haystack.contains("service")
    {
        "commercial".into()
    } else if haystack.contains("login") || haystack.contains("brand") {
        "navigational".into()
    } else {
        "informational".into()
    }
}

fn content_angle(intent: &str, page_type: &str) -> String {
    match (intent, page_type) {
        ("transactional", _) => {
            "Make the offer, proof, conversion path, and next action immediately clear.".into()
        }
        ("commercial", _) => {
            "Help the reader compare options and understand why this solution fits.".into()
        }
        ("informational", "blog") => {
            "Answer the query completely with source-grounded, practical guidance.".into()
        }
        ("informational", _) => {
            "Explain the topic clearly, then guide readers toward the next useful step.".into()
        }
        _ => "Make the page useful, specific, and easy to scan.".into(),
    }
}

fn recommended_sections(intent: &str, page_type: &str) -> Vec<String> {
    match (intent, page_type) {
        ("transactional", _) => vec![
            "Hero offer",
            "Who this is for",
            "Benefits",
            "Proof",
            "Process",
            "FAQ",
            "Primary call to action",
        ],
        ("commercial", _) => vec![
            "Problem framing",
            "Evaluation criteria",
            "Solution fit",
            "Proof",
            "Comparison notes",
            "FAQ",
            "Next step",
        ],
        (_, "service") => vec![
            "Service overview",
            "Problems solved",
            "Deliverables",
            "Process",
            "Proof",
            "FAQ",
            "Contact path",
        ],
        (_, "homepage") => vec![
            "Primary offer",
            "Audience fit",
            "Core capabilities",
            "Proof",
            "Featured resources",
            "Primary call to action",
        ],
        _ => vec![
            "Direct answer",
            "Key context",
            "Step-by-step guidance",
            "Examples",
            "FAQ",
            "Next reading",
        ],
    }
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn question_set(topic: &str, intent: &str) -> Vec<String> {
    let subject = if topic.is_empty() {
        "this topic"
    } else {
        topic
    };
    match intent {
        "transactional" => vec![
            format!("What does the reader get from {subject}?"),
            "What proof supports the offer?".into(),
            "What should the reader do next?".into(),
        ],
        "commercial" => vec![
            format!("How should readers evaluate {subject}?"),
            "What tradeoffs or alternatives matter?".into(),
            "Why is this option credible?".into(),
        ],
        _ => vec![
            format!("What is the clearest answer about {subject}?"),
            "What context prevents misunderstanding?".into(),
            "What practical next step should readers take?".into(),
        ],
    }
}

fn source_refs(sources: &[Value], competitors: &[Value]) -> Vec<Value> {
    sources
        .iter()
        .chain(competitors.iter())
        .filter_map(|source| {
            if let Some(url) = source.as_str() {
                Some(json!({ "url": url }))
            } else if source.is_object() {
                Some(source.clone())
            } else {
                None
            }
        })
        .collect()
}

fn schema_recommendations(page_type: &str) -> Vec<String> {
    match page_type {
        "service" => vec!["Service", "FAQPage", "BreadcrumbList"],
        "homepage" => vec!["Organization", "WebSite", "BreadcrumbList"],
        "blog" | "article" => vec!["Article", "FAQPage", "BreadcrumbList"],
        "product" => vec!["Product", "FAQPage", "BreadcrumbList"],
        _ => vec!["WebPage", "BreadcrumbList"],
    }
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn writing_instructions() -> Vec<String> {
    vec![
        "Prioritize people-first usefulness over keyword stuffing.".into(),
        "Ground factual claims in supplied sources or mark them for verification.".into(),
        "Make the page scannable with clear headings and concise sections.".into(),
        "Include metadata and schema recommendations when publishing output is requested.".into(),
    ]
}

fn normalize_key(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn gap_recommendations(own_sections: &[String], competitor_sections: &[String]) -> Vec<String> {
    let mut recommendations = Vec::new();
    if own_sections.is_empty() {
        recommendations.push("Add a structured outline before drafting.".into());
    }
    if competitor_sections.len() > own_sections.len() {
        recommendations.push(
            "Review competitor section coverage and add missing reader questions where relevant."
                .into(),
        );
    }
    if recommendations.is_empty() {
        recommendations
            .push("Coverage appears aligned; focus on differentiation and proof.".into());
    }
    recommendations
}

fn quality_score(
    word_count: usize,
    heading_count: usize,
    has_topic: bool,
    has_audience: bool,
    missing_terms: usize,
) -> u64 {
    let mut score = 40u64;
    if word_count >= 300 {
        score += 20;
    } else if word_count >= 150 {
        score += 10;
    }
    if heading_count >= 2 {
        score += 15;
    } else if heading_count == 1 {
        score += 8;
    }
    if has_topic {
        score += 10;
    }
    if has_audience {
        score += 5;
    }
    score = score.saturating_sub((missing_terms as u64).saturating_mul(5));
    score.min(100)
}

fn quality_recommendations(
    score: u64,
    word_count: usize,
    heading_count: usize,
    has_topic: bool,
    has_audience: bool,
) -> Vec<String> {
    let mut recommendations = Vec::new();
    if word_count < 300 {
        recommendations.push("Add enough useful detail to fully answer the page intent.".into());
    }
    if heading_count < 2 {
        recommendations.push("Use descriptive headings to make the page easier to scan.".into());
    }
    if !has_topic {
        recommendations.push("Make the target topic explicit in the content.".into());
    }
    if !has_audience {
        recommendations.push("Reflect the intended audience or use case more directly.".into());
    }
    if score >= 85 {
        recommendations.push(
            "Content is structurally strong; focus review on factual accuracy and brand voice."
                .into(),
        );
    }
    recommendations
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_topic_aware_content_brief() {
        let brief = generate_content_brief(&json!({
            "topic": "SEO consulting for SaaS",
            "audience": "B2B SaaS founders",
            "business_goal": "book consultations",
            "page_type": "service",
            "secondary_keywords": ["technical SEO", "content strategy"],
            "sources": ["https://developers.google.com/search/docs/fundamentals/seo-starter-guide"]
        }));

        assert_eq!(brief["search_intent"], "commercial");
        assert_eq!(
            brief["schema_recommendations"],
            json!(["Service", "FAQPage", "BreadcrumbList"])
        );
        assert!(brief["questions_to_answer"].as_array().unwrap().len() >= 3);
    }

    #[test]
    fn scores_content_quality_with_missing_terms() {
        let score = score_content_quality(&json!({
            "topic": "technical SEO",
            "audience": "marketing teams",
            "required_terms": ["crawlability"],
            "content": "# Technical SEO\n\nTechnical SEO helps marketing teams improve site quality.\n\n## Audits\n\nUse audits to find issues."
        }));

        assert_eq!(score["has_topic"], true);
        assert_eq!(score["has_audience"], true);
        assert_eq!(score["missing_terms"], json!(["crawlability"]));
    }
}
