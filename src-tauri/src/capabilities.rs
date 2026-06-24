use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    Implemented,
    Planned,
    External,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Deterministic,
    BoundedAgentic,
    OpenAgentic,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Capability {
    pub id: String,
    pub provider: String,
    pub action: String,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub status: CapabilityStatus,
    pub execution_mode: ExecutionMode,
    pub deterministic: bool,
    pub read_only: bool,
    pub idempotent: bool,
    pub destructive: bool,
    pub open_world: bool,
    pub permissions: Vec<String>,
    pub intent_tags: Vec<String>,
    pub operation_tags: Vec<String>,
    pub best_for: Vec<String>,
    pub not_for: Vec<String>,
    pub builder_guidance: String,
    pub fallback_strategy: String,
    pub input_schema: Value,
    pub output_schema: Value,
}

pub fn capability_catalog() -> Vec<Capability> {
    vec![
        http_probe_check_urls(),
        open_meteo_current_weather(),
        local_git_recent_activity(),
        local_git_context_pack(),
        nestweaver_health(),
        nestweaver_project_context(),
        local_app_write_artifact(),
        local_app_read_artifact(),
        agent_run_task(),
        agent_tool_web_search(),
        agent_tool_http_get(),
        agent_tool_local_git_context(),
        agent_tool_github_context(),
        agent_tool_nestweaver_context(),
        agent_tool_document_import_context(),
        agent_tool_ai_chat_import_context(),
        weather_forecast_24h(),
        weather_hourly_forecast(),
        weather_alerts(),
        news_trending(),
        news_search(),
        rss_fetch_feed(),
        web_fetch_page(),
        web_extract_article(),
        web_extract_metadata(),
        seo_fetch_robots_txt(),
        seo_parse_robots_txt(),
        seo_fetch_sitemap(),
        seo_parse_sitemap(),
        seo_audit_indexability(),
        seo_audit_metadata(),
        seo_extract_structured_data(),
        seo_validate_json_ld(),
        seo_audit_links(),
        seo_audit_canonical_hreflang(),
        content_map_search_intent(),
        content_generate_brief(),
        content_identify_gaps(),
        content_score_quality(),
        data_parse_csv(),
        data_transform_json(),
        scheduler_preview_next_runs(),
        notification_local(),
        mcp_discover_tools(),
    ]
}

pub fn trusted_capabilities() -> Vec<Capability> {
    capability_catalog()
        .into_iter()
        .filter(|capability| capability.status == CapabilityStatus::Implemented)
        .filter(|capability| {
            capability.provider != "agent_tool"
                && capability.provider != "agent"
                && capability.provider != "openai"
        })
        .collect()
}

pub fn builder_capability_catalog() -> Vec<Capability> {
    capability_catalog()
}

pub fn builder_capability_summary() -> Vec<Value> {
    capability_catalog()
        .into_iter()
        .map(|capability| {
            json!({
                "id": capability.id,
                "provider": capability.provider,
                "action": capability.action,
                "status": capability.status,
                "execution_mode": capability.execution_mode,
                "category": capability.category,
                "permissions": capability.permissions,
                "intent_tags": capability.intent_tags,
                "operation_tags": capability.operation_tags,
                "best_for": capability.best_for,
                "not_for": capability.not_for,
                "builder_guidance": capability.builder_guidance,
                "fallback_strategy": capability.fallback_strategy
            })
        })
        .collect()
}

pub fn capability_for(provider: &str, action: &str) -> Option<Capability> {
    capability_catalog().into_iter().find(|capability| {
        capability.status == CapabilityStatus::Implemented
            && capability.provider != "agent_tool"
            && capability.provider != "agent"
            && capability.provider == provider
            && capability.action == action
    })
}

pub fn deterministic_capabilities_for_intent(tags: &[&str]) -> Vec<Capability> {
    capability_catalog()
        .into_iter()
        .filter(|capability| {
            capability.status == CapabilityStatus::Implemented
                && capability.execution_mode == ExecutionMode::Deterministic
                && tags.iter().any(|tag| {
                    capability
                        .intent_tags
                        .iter()
                        .any(|intent_tag| intent_tag == tag)
                })
        })
        .collect()
}

fn capability(
    id: &str,
    provider: &str,
    action: &str,
    display_name: &str,
    description: &str,
    category: &str,
    status: CapabilityStatus,
    execution_mode: ExecutionMode,
    read_only: bool,
    idempotent: bool,
    destructive: bool,
    open_world: bool,
    permissions: Vec<&str>,
    intent_tags: Vec<&str>,
    operation_tags: Vec<&str>,
    best_for: Vec<&str>,
    not_for: Vec<&str>,
    builder_guidance: &str,
    fallback_strategy: &str,
    input_schema: Value,
    output_schema: Value,
) -> Capability {
    Capability {
        id: id.to_string(),
        provider: provider.to_string(),
        action: action.to_string(),
        display_name: display_name.to_string(),
        description: description.to_string(),
        category: category.to_string(),
        deterministic: execution_mode == ExecutionMode::Deterministic,
        status,
        execution_mode,
        read_only,
        idempotent,
        destructive,
        open_world,
        permissions: permissions.into_iter().map(str::to_string).collect(),
        intent_tags: intent_tags.into_iter().map(str::to_string).collect(),
        operation_tags: operation_tags.into_iter().map(str::to_string).collect(),
        best_for: best_for.into_iter().map(str::to_string).collect(),
        not_for: not_for.into_iter().map(str::to_string).collect(),
        builder_guidance: builder_guidance.to_string(),
        fallback_strategy: fallback_strategy.to_string(),
        input_schema,
        output_schema,
    }
}

fn http_probe_check_urls() -> Capability {
    capability(
        "http_probe.check_urls",
        "http_probe",
        "check_urls",
        "Check URLs",
        "Checks one or more URLs for reachability, response status, redirects, timing, TLS failures, and content type.",
        "web_monitoring",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        true,
        vec!["network:read"],
        vec!["http", "uptime", "website", "url_check", "monitoring"],
        vec!["collect.url_status"],
        vec![
            "website uptime checks",
            "HTTP status checks",
            "TLS failure detection",
            "redirect and response timing checks",
        ],
        vec![
            "reading page content",
            "extracting article text",
            "checking pricing or documentation changes",
        ],
        "Use before any agent when the user asks whether sites, URLs, endpoints, or services are up, reachable, down, healthy, or returning expected statuses.",
        "If the user needs content inspection rather than reachability, use a web extraction capability when available; otherwise use agent.run_task with web access.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["urls"],
            "properties": {
                "urls": {
                    "type": "array",
                    "minItems": 1,
                    "items": { "type": "string", "format": "uri" }
                },
                "timeout_ms": { "type": "integer", "minimum": 1, "default": 10000 },
                "follow_redirects": { "type": "boolean", "default": true },
                "accepted_status_codes": {
                    "type": "array",
                    "items": { "type": "integer", "minimum": 100, "maximum": 599 },
                    "default": [200, 201, 202, 203, 204, 205, 206]
                },
                "retries": { "type": "integer", "minimum": 0, "default": 0 }
            }
        }),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["results"],
            "properties": {
                "results": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                            "url", "ok", "status_code", "effective_url", "duration_ms",
                            "content_type", "redirect_count", "error_type", "error_message",
                            "checked_at"
                        ],
                        "properties": {
                            "url": { "type": "string", "format": "uri" },
                            "ok": { "type": "boolean" },
                            "status_code": { "type": ["integer", "null"], "minimum": 100, "maximum": 599 },
                            "effective_url": { "type": ["string", "null"], "format": "uri" },
                            "duration_ms": { "type": "integer", "minimum": 0 },
                            "content_type": { "type": ["string", "null"] },
                            "redirect_count": { "type": "integer", "minimum": 0 },
                            "error_type": { "type": ["string", "null"] },
                            "error_message": { "type": ["string", "null"] },
                            "checked_at": { "type": "string", "format": "date-time" }
                        }
                    }
                }
            }
        }),
    )
}

fn open_meteo_current_weather() -> Capability {
    capability(
        "open_meteo.current_weather",
        "open_meteo",
        "current_weather",
        "Current Weather",
        "Fetches current weather conditions from Open-Meteo for the configured location.",
        "weather",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        false,
        false,
        true,
        vec!["weather:read"],
        vec!["weather", "current_weather", "forecast"],
        vec![],
        vec!["current weather", "weather snapshot", "today's conditions"],
        vec!["hourly forecast", "24 hour forecast", "weather alerts"],
        "Use for current conditions. For period forecasts, prefer weather.forecast_24h or weather.hourly_forecast.",
        "Use agent.run_task with web access only when the user needs a source or interpretation outside the deterministic weather providers.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "latitude": { "type": "number" },
                "longitude": { "type": "number" },
                "units": { "type": "string", "enum": ["fahrenheit", "celsius"], "default": "fahrenheit" }
            }
        }),
        json!({
            "type": "object",
            "required": ["temperature", "condition", "observed_at"],
            "properties": {
                "temperature": { "type": "number" },
                "condition": { "type": "string" },
                "observed_at": { "type": "string", "format": "date-time" }
            }
        }),
    )
}

fn local_git_recent_activity() -> Capability {
    simple_provider(
        "local_git.recent_activity",
        "local_git",
        "recent_activity",
        "Recent Git Activity",
        "Collects recent local Git changes for workflow context.",
        "local_context",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        vec!["git:read"],
        vec!["git", "repository", "activity", "journal"],
        "Use for daily journals, changelog context, and local project summaries.",
    )
}

fn local_git_context_pack() -> Capability {
    simple_provider(
        "local_git.context_pack",
        "local_git",
        "context_pack",
        "Git Context Pack",
        "Collects broader local repository context for agent summarization.",
        "local_context",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        vec!["git:read"],
        vec!["git", "repository", "context"],
        "Use when a workflow needs local repository context before a bounded agent summary.",
    )
}

fn nestweaver_health() -> Capability {
    simple_provider(
        "nestweaver.health",
        "nestweaver",
        "health",
        "NestWeaver Health",
        "Checks NestWeaver availability.",
        "local_context",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        vec!["nestweaver:read"],
        vec!["nestweaver", "health", "context"],
        "Use before NestWeaver project context and fall back to local_git when unavailable.",
    )
}

fn nestweaver_project_context() -> Capability {
    simple_provider(
        "nestweaver.project_context",
        "nestweaver",
        "project_context",
        "NestWeaver Project Context",
        "Fetches project context from NestWeaver.",
        "local_context",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        vec!["nestweaver:read"],
        vec!["nestweaver", "project", "context"],
        "Use for project-aware summaries when NestWeaver is configured; otherwise prefer local_git context.",
    )
}

fn local_app_write_artifact() -> Capability {
    capability(
        "local_app.write_artifact",
        "local_app",
        "write_artifact",
        "Write Artifact",
        "Writes a workflow artifact to Raven's local artifact store.",
        "artifact",
        CapabilityStatus::Implemented,
        ExecutionMode::BoundedAgentic,
        false,
        false,
        true,
        false,
        vec!["artifact:write"],
        vec!["artifact", "markdown", "write", "save"],
        vec![],
        vec!["saving markdown reports", "persisting generated artifacts"],
        vec!["generating report content", "external publishing"],
        "Use as the final sink when the user asks to save, output, export, or create a Markdown report.",
        "If no artifact write is requested, omit this sink.",
        json!({
            "type": "object",
            "required": ["artifact"],
            "properties": { "artifact": { "type": "string" } }
        }),
        json!({
            "type": "object",
            "properties": {
                "content_path": { "type": "string" },
                "metadata_path": { "type": "string" }
            }
        }),
    )
}

fn local_app_read_artifact() -> Capability {
    simple_provider(
        "local_app.read_artifact",
        "local_app",
        "read_artifact",
        "Read Artifact",
        "Reads an existing Raven artifact.",
        "artifact",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        vec!["artifact:read"],
        vec!["artifact", "read", "review"],
        "Use when a workflow needs to inspect an existing local artifact.",
    )
}

fn agent_run_task() -> Capability {
    capability(
        "agent.run_task",
        "agent",
        "run_task",
        "Run Agent Task",
        "Runs a bounded or open-ended language-model task through the selected agent profile.",
        "agent",
        CapabilityStatus::Implemented,
        ExecutionMode::OpenAgentic,
        false,
        false,
        false,
        true,
        vec!["llm:generate", "network:read"],
        vec!["summarize", "write", "reason", "agent"],
        vec![],
        vec!["summarizing deterministic outputs", "open-ended research", "writing Markdown reports"],
        vec!["deterministic data gathering when a provider exists"],
        "Use after deterministic provider steps for synthesis with allowed_tools []. Use web/http tools only when no deterministic provider can satisfy the data-gathering step.",
        "Add or implement deterministic provider capabilities for recurring factual tasks.",
        json!({
            "type": "object",
            "required": ["objective"],
            "properties": {
                "objective": { "type": "string" },
                "allowed_tools": { "type": "array", "items": { "type": "string" } },
                "output_schema": { "type": ["string", "object"] }
            }
        }),
        json!({ "type": "object", "properties": { "artifact": { "type": "string" } } }),
    )
}

fn agent_tool_web_search() -> Capability {
    agent_tool(
        "agent_tool.web_search",
        "web",
        "Web Search",
        "Allows an agent to search and read web information.",
        vec!["web", "search", "news", "open_world"],
        "Use only when no deterministic provider or feed-backed source exists for the requested information.",
    )
}

fn agent_tool_http_get() -> Capability {
    agent_tool(
        "agent_tool.http_get",
        "http",
        "HTTP GET",
        "Allows an agent to fetch HTTP resources.",
        vec!["http", "fetch", "open_world"],
        "Use only for bounded fetches when a dedicated provider is unavailable.",
    )
}

fn agent_tool_local_git_context() -> Capability {
    agent_tool(
        "agent_tool.local_git_context",
        "local_git",
        "Local Git Context Tool",
        "Allows an agent to inspect local Git context.",
        vec!["git", "context"],
        "Prefer local_git provider steps before using agent tool access.",
    )
}

fn agent_tool_github_context() -> Capability {
    agent_tool(
        "agent_tool.github_context",
        "github",
        "GitHub Context Tool",
        "Allows an agent to inspect configured GitHub context.",
        vec!["github", "issues", "pull_requests"],
        "Use for GitHub research when deterministic GitHub provider actions are not available.",
    )
}

fn agent_tool_nestweaver_context() -> Capability {
    agent_tool(
        "agent_tool.nestweaver_context",
        "nestweaver",
        "NestWeaver Context Tool",
        "Allows an agent to inspect NestWeaver context.",
        vec!["nestweaver", "context"],
        "Prefer NestWeaver provider steps before using agent tool access.",
    )
}

fn agent_tool_document_import_context() -> Capability {
    agent_tool(
        "agent_tool.document_import_context",
        "document_import",
        "Document Import Context Tool",
        "Allows an agent to use imported document context.",
        vec!["document", "pdf", "context"],
        "Use for document-based summaries after deterministic import/extraction.",
    )
}

fn agent_tool_ai_chat_import_context() -> Capability {
    agent_tool(
        "agent_tool.ai_chat_import_context",
        "ai_chat_import",
        "AI Chat Import Context Tool",
        "Allows an agent to use imported chat context.",
        vec!["chat", "context", "import"],
        "Use for summaries over imported chat archives.",
    )
}

fn weather_forecast_24h() -> Capability {
    capability(
        "weather.forecast_24h",
        "weather",
        "forecast_24h",
        "24 Hour Weather Forecast",
        "Fetches hourly or period-based weather forecast data for the next 24 hours.",
        "weather",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        false,
        false,
        true,
        vec!["weather:read"],
        vec!["weather", "forecast", "24h", "hourly"],
        vec!["collect.weather"],
        vec![
            "next 24 hours weather",
            "hourly forecast",
            "daily weather brief",
        ],
        vec!["current conditions only", "severe weather alerts"],
        "Use before an agent summary for any next-24-hour weather request. Defaults to Denver, CO when no coordinates are supplied.",
        "If Open-Meteo is unavailable, report the provider error and ask the user whether to retry or use agent.run_task with web access.",
        weather_forecast_input_schema(false),
        weather_forecast_output_schema(),
    )
}

fn weather_hourly_forecast() -> Capability {
    capability(
        "weather.hourly_forecast",
        "weather",
        "hourly_forecast",
        "Hourly Weather Forecast",
        "Fetches hourly weather periods for a requested time range.",
        "weather",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        false,
        false,
        true,
        vec!["weather:read"],
        vec!["weather", "hourly", "forecast"],
        vec![],
        vec!["hour-by-hour weather", "forecast charts", "commute weather"],
        vec!["current conditions only", "severe weather alerts"],
        "Use for precise hourly weather reporting and visualization. Clamp requested hours to the supported 1..=168 range.",
        "If Open-Meteo is unavailable, report the provider error and ask the user whether to retry or use agent.run_task with web access.",
        weather_forecast_input_schema(true),
        weather_forecast_output_schema(),
    )
}

fn weather_alerts() -> Capability {
    capability(
        "weather.alerts",
        "weather",
        "alerts",
        "Weather Alerts",
        "Returns deterministic best-effort weather alert status for a location.",
        "weather",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        false,
        false,
        true,
        vec!["weather:read"],
        vec!["weather", "alerts", "warnings", "safety"],
        vec![],
        vec!["severe weather alerts", "storm warnings", "weather risk briefs"],
        vec!["forecast periods", "current conditions"],
        "Include in weather briefs when the user asks for safety or planning context. This capability returns a structured empty list with status detail when no no-key global alerts source is configured.",
        "Use agent.run_task with web access only when the user needs live severe-weather verification from a specific public agency.",
        weather_alerts_input_schema(),
        weather_alerts_output_schema(),
    )
}

fn weather_forecast_input_schema(include_hours: bool) -> Value {
    let mut properties = serde_json::Map::from_iter([
        (
            "latitude".to_string(),
            json!({ "type": "number", "minimum": -90, "maximum": 90 }),
        ),
        (
            "longitude".to_string(),
            json!({ "type": "number", "minimum": -180, "maximum": 180 }),
        ),
        (
            "location".to_string(),
            json!({ "type": "string", "default": "Denver, CO" }),
        ),
        (
            "units".to_string(),
            json!({ "type": "string", "enum": ["fahrenheit", "celsius"], "default": "fahrenheit" }),
        ),
    ]);
    if include_hours {
        properties.insert(
            "hours".to_string(),
            json!({ "type": "integer", "minimum": 1, "maximum": 168, "default": 24 }),
        );
    }

    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties
    })
}

fn weather_alerts_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "latitude": { "type": "number", "minimum": -90, "maximum": 90 },
            "longitude": { "type": "number", "minimum": -180, "maximum": 180 },
            "location": { "type": "string", "default": "Denver, CO" }
        }
    })
}

fn weather_forecast_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["location", "latitude", "longitude", "fetched_at", "source_refs", "units", "hourly"],
        "properties": {
            "location": { "type": "string" },
            "latitude": { "type": "number" },
            "longitude": { "type": "number" },
            "timezone": { "type": "string" },
            "fetched_at": { "type": "string", "format": "date-time" },
            "source_refs": { "type": "array", "items": { "type": "string" } },
            "units": {
                "type": "object",
                "additionalProperties": false,
                "required": ["temperature", "apparent_temperature", "precipitation_probability", "precipitation", "wind_speed"],
                "properties": {
                    "temperature": { "type": "string" },
                    "apparent_temperature": { "type": "string" },
                    "precipitation_probability": { "type": "string" },
                    "precipitation": { "type": "string" },
                    "wind_speed": { "type": "string" }
                }
            },
            "hourly": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["time", "temperature", "condition"],
                    "properties": {
                        "time": { "type": "string" },
                        "temperature": { "type": "number" },
                        "apparent_temperature": { "type": "number" },
                        "precipitation_probability": { "type": "number" },
                        "precipitation": { "type": "number" },
                        "wind_speed": { "type": "number" },
                        "weather_code": { "type": "integer" },
                        "condition": { "type": "string" }
                    }
                }
            }
        }
    })
}

fn weather_alerts_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["location", "latitude", "longitude", "fetched_at", "source_refs", "status", "detail", "alerts"],
        "properties": {
            "location": { "type": "string" },
            "latitude": { "type": "number" },
            "longitude": { "type": "number" },
            "fetched_at": { "type": "string", "format": "date-time" },
            "source_refs": { "type": "array", "items": { "type": "string" } },
            "status": { "type": "string" },
            "detail": { "type": "string" },
            "alerts": { "type": "array", "items": { "type": "object" } }
        }
    })
}

fn news_trending() -> Capability {
    capability(
        "news.trending",
        "news",
        "trending",
        "Trending News",
        "Fetches trending or top news from configured sources and regions.",
        "news",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        true,
        vec!["network:read"],
        vec!["news", "trending", "headlines", "brief"],
        vec!["collect.news"],
        vec!["top news brief", "trending news", "morning briefing"],
        vec!["open-ended analysis", "paywalled news sources", "personalized social trends"],
        "Use before an agent summary for trending-news workflows. Prefer explicit feeds when the workflow needs repeatable source selection.",
        "If all feeds fail, return source errors and ask the user whether to retry or provide source-specific RSS feeds.",
        news_trending_input_schema(false),
        news_trending_output_schema(),
    )
}

fn news_search() -> Capability {
    capability(
        "news.search",
        "news",
        "search",
        "News Search",
        "Searches configured news sources for a topic.",
        "news",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        true,
        vec!["network:read"],
        vec!["news", "search", "topic"],
        vec!["collect.news"],
        vec!["topic news search", "company news", "market headlines"],
        vec!["full web search", "semantic ranking", "paywalled news databases"],
        "Use for topic-specific news gathering from configured RSS feeds before summarization.",
        "If RSS sources do not contain matching terms, ask the user for additional feeds or use agent.run_task with web access.",
        news_trending_input_schema(true),
        news_trending_output_schema(),
    )
}

fn rss_fetch_feed() -> Capability {
    capability(
        "rss.fetch_feed",
        "rss",
        "fetch_feed",
        "Fetch RSS Feed",
        "Fetches and parses RSS or Atom feed entries.",
        "web_content",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        true,
        vec!["network:read"],
        vec!["rss", "feed", "news", "content"],
        vec!["collect.rss_feed"],
        vec!["source-specific headlines", "blog rollups", "release feeds"],
        vec!["HTML article extraction", "JavaScript-rendered feed discovery"],
        "Prefer source-owned RSS feeds over open web search for repeatable news workflows.",
        "If the feed cannot be fetched or parsed, return a structured provider error and ask for a different feed URL.",
        rss_fetch_feed_input_schema(),
        rss_fetch_feed_output_schema(),
    )
}

fn web_fetch_page() -> Capability {
    capability(
        "web.fetch_page",
        "web",
        "fetch_page",
        "Fetch Web Page",
        "Fetches a URL and returns status, headers, and bounded body text.",
        "web_content",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        true,
        vec!["network:read"],
        vec!["web", "fetch", "page", "content"],
        vec!["collect.web_page"],
        vec!["page content extraction", "documentation checks", "pricing page inspection"],
        vec!["browser automation", "JavaScript-rendered pages", "form submission"],
        "Use for deterministic page retrieval before extraction or summary. Clamp body size with max_bytes for predictable artifacts.",
        "If the page requires browser execution or authentication, use an approved agent/browser workflow instead.",
        web_fetch_page_input_schema(),
        web_fetch_page_output_schema(),
    )
}

fn web_extract_article() -> Capability {
    capability(
        "web.extract_article",
        "web",
        "extract_article",
        "Extract Article",
        "Extracts readable article text and metadata from a fetched page.",
        "web_content",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        false,
        vec!["data:read"],
        vec!["web", "article", "extract", "content"],
        vec!["extract.article"],
        vec!["article summaries", "source-grounded news briefs"],
        vec!["JavaScript rendering", "layout-sensitive extraction", "paywalled content"],
        "Use after web.fetch_page or rss.fetch_feed and before agent summarization.",
        "If conservative tag stripping loses essential content, use an agent/browser workflow with source attribution.",
        web_extract_input_schema(),
        web_extract_article_output_schema(),
    )
}

fn web_extract_metadata() -> Capability {
    capability(
        "web.extract_metadata",
        "web",
        "extract_metadata",
        "Extract Web Metadata",
        "Extracts title, description, canonical URL, and Open Graph metadata.",
        "web_content",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        false,
        vec!["data:read"],
        vec!["web", "metadata", "seo", "page"],
        vec!["extract.metadata"],
        vec![
            "link previews",
            "source attribution",
            "page identity checks",
        ],
        vec!["full article extraction", "JavaScript-rendered metadata"],
        "Use for lightweight page inspection without full article extraction.",
        "If metadata is missing from static HTML, fetch the page in a browser-capable workflow.",
        web_extract_input_schema(),
        web_extract_metadata_output_schema(),
    )
}

fn web_fetch_page_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["url"],
        "properties": {
            "url": { "type": "string", "format": "uri" },
            "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 60000, "default": 10000 },
            "max_bytes": { "type": "integer", "minimum": 0, "maximum": 5242880, "default": 524288 }
        }
    })
}

fn web_fetch_page_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["ok", "status_code", "final_url", "effective_url", "content_type", "body_text", "fetched_at", "error_type", "error_message"],
        "properties": {
            "ok": { "type": "boolean" },
            "status_code": { "type": ["integer", "null"], "minimum": 100, "maximum": 599 },
            "final_url": { "type": ["string", "null"] },
            "effective_url": { "type": ["string", "null"] },
            "content_type": { "type": ["string", "null"] },
            "body_text": { "type": "string" },
            "fetched_at": { "type": "string", "format": "date-time" },
            "error_type": { "type": ["string", "null"] },
            "error_message": { "type": ["string", "null"] }
        }
    })
}

fn web_extract_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "body_text": { "type": "string" },
            "html": { "type": "string" },
            "url": { "type": "string", "format": "uri" }
        },
        "anyOf": [
            { "required": ["body_text"] },
            { "required": ["html"] },
            { "required": ["url"] }
        ]
    })
}

fn web_extract_metadata_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "description", "canonical_url", "open_graph"],
        "properties": {
            "title": { "type": ["string", "null"] },
            "description": { "type": ["string", "null"] },
            "canonical_url": { "type": ["string", "null"] },
            "open_graph": { "type": "object", "additionalProperties": { "type": "string" } }
        }
    })
}

fn web_extract_article_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "text", "excerpt", "word_count", "source_url"],
        "properties": {
            "title": { "type": ["string", "null"] },
            "text": { "type": "string" },
            "excerpt": { "type": "string" },
            "word_count": { "type": "integer", "minimum": 0 },
            "source_url": { "type": ["string", "null"] }
        }
    })
}

fn seo_fetch_robots_txt() -> Capability {
    seo_capability(
        "seo.fetch_robots_txt",
        "fetch_robots_txt",
        "Fetch Robots.txt",
        "Fetches the robots.txt file for a site origin.",
        vec!["seo", "robots", "crawlability", "technical_seo"],
        vec![],
        vec![
            "technical SEO audits",
            "crawlability checks",
            "site discovery",
        ],
        "Use before indexability audits when a site URL is known.",
        seo_site_input_schema("site_url"),
        web_fetch_page_output_schema(),
    )
}

fn seo_parse_robots_txt() -> Capability {
    seo_capability(
        "seo.parse_robots_txt",
        "parse_robots_txt",
        "Parse Robots.txt",
        "Parses robots.txt directives, selected user-agent rules, sitemaps, and crawl delay.",
        vec!["seo", "robots", "crawlability", "parse"],
        vec![],
        vec![
            "crawl policy extraction",
            "sitemap discovery",
            "indexability context",
        ],
        "Use after seo.fetch_robots_txt or when robots.txt body text is already available.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["body_text"],
            "properties": {
                "body_text": { "type": "string" },
                "user_agent": { "type": "string", "default": "*" }
            }
        }),
        json!({
            "type": "object",
            "additionalProperties": true,
            "required": ["user_agent", "allows", "disallows", "sitemaps", "groups"]
        }),
    )
}

fn seo_fetch_sitemap() -> Capability {
    seo_capability(
        "seo.fetch_sitemap",
        "fetch_sitemap",
        "Fetch Sitemap",
        "Fetches a sitemap XML document from a sitemap URL or site origin.",
        vec!["seo", "sitemap", "crawlability", "url_inventory"],
        vec![],
        vec!["URL inventory", "site structure checks", "content audits"],
        "Use before seo.parse_sitemap. Prefer sitemaps discovered from robots.txt when available.",
        seo_site_input_schema("sitemap_url"),
        web_fetch_page_output_schema(),
    )
}

fn seo_parse_sitemap() -> Capability {
    seo_capability(
        "seo.parse_sitemap",
        "parse_sitemap",
        "Parse Sitemap",
        "Parses sitemap URL entries and sitemap index entries.",
        vec!["seo", "sitemap", "parse", "url_inventory"],
        vec![],
        vec![
            "URL inventory",
            "content gap analysis",
            "internal page discovery",
        ],
        "Use after seo.fetch_sitemap before agent summarization or content planning.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["body_text"],
            "properties": {
                "body_text": { "type": "string" },
                "max_urls": { "type": "integer", "minimum": 1, "maximum": 10000, "default": 500 }
            }
        }),
        json!({
            "type": "object",
            "additionalProperties": true,
            "required": ["url_count", "sitemap_count", "urls", "sitemaps", "truncated"]
        }),
    )
}

fn seo_audit_indexability() -> Capability {
    seo_capability(
        "seo.audit_indexability",
        "audit_indexability",
        "Audit Indexability",
        "Checks fetch status, robots directives, and robots meta noindex signals for a page.",
        vec!["seo", "indexability", "robots", "technical_seo"],
        vec![],
        vec!["indexability audits", "technical SEO checks", "crawl diagnostics"],
        "Use for page-level SEO health before agent recommendations. Feed robots_txt when available to avoid refetching.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "url": { "type": "string", "format": "uri" },
                "html": { "type": "string" },
                "body_text": { "type": "string" },
                "robots_txt": { "type": "string" },
                "user_agent": { "type": "string", "default": "*" },
                "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 60000, "default": 10000 },
                "max_bytes": { "type": "integer", "minimum": 0, "maximum": 5242880, "default": 1048576 }
            },
            "anyOf": [
                { "required": ["url"] },
                { "required": ["html"] },
                { "required": ["body_text"] }
            ]
        }),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["url", "indexable", "status_code", "robots_allowed", "robots_meta", "noindex", "reasons", "checked_at"]
        }),
    )
}

fn seo_audit_metadata() -> Capability {
    seo_capability(
        "seo.audit_metadata",
        "audit_metadata",
        "Audit Metadata",
        "Audits title, meta description, canonical URL, Open Graph data, and heading structure.",
        vec!["seo", "metadata", "headings", "technical_seo", "content"],
        vec![],
        vec![
            "metadata QA",
            "on-page SEO checks",
            "content publishing review",
        ],
        "Use before writing or publishing site content so the agent has concrete page SEO gaps.",
        web_extract_input_schema(),
        json!({
            "type": "object",
            "additionalProperties": true,
            "required": ["metadata", "headings", "checks", "issue_count"]
        }),
    )
}

fn seo_extract_structured_data() -> Capability {
    seo_capability(
        "seo.extract_structured_data",
        "extract_structured_data",
        "Extract Structured Data",
        "Extracts JSON-LD structured data items and schema types from a page.",
        vec!["seo", "schema", "structured_data", "json_ld"],
        vec![],
        vec!["schema audits", "rich result preparation", "content QA"],
        "Use before schema recommendations and before validating generated JSON-LD.",
        web_extract_input_schema(),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["items", "types", "errors", "count"]
        }),
    )
}

fn seo_validate_json_ld() -> Capability {
    seo_capability(
        "seo.validate_json_ld",
        "validate_json_ld",
        "Validate JSON-LD",
        "Performs deterministic structural validation for JSON-LD payloads.",
        vec!["seo", "schema", "structured_data", "json_ld", "validate"],
        vec!["validate.json_ld"],
        vec!["schema QA", "generated JSON-LD checks", "publishing review"],
        "Use after an agent drafts schema JSON-LD; this is a structural check, not a rich-results guarantee.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "json_ld": {},
                "structured_data": {}
            },
            "anyOf": [
                { "required": ["json_ld"] },
                { "required": ["structured_data"] }
            ]
        }),
        json!({
            "type": "object",
            "additionalProperties": true,
            "required": ["valid", "item_count", "errors", "warnings", "items"]
        }),
    )
}

fn seo_audit_links() -> Capability {
    seo_capability(
        "seo.audit_links",
        "audit_links",
        "Audit Links",
        "Extracts links and classifies internal, external, relative, and utility targets.",
        vec!["seo", "links", "internal_links", "crawlability"],
        vec![],
        vec![
            "internal link audits",
            "content brief link targets",
            "page QA",
        ],
        "Use when content workflows need internal-link recommendations or page link inventory.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "html": { "type": "string" },
                "body_text": { "type": "string" },
                "url": { "type": "string", "format": "uri" },
                "base_url": { "type": "string", "format": "uri" }
            },
            "anyOf": [
                { "required": ["html"] },
                { "required": ["body_text"] },
                { "required": ["url"] }
            ]
        }),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["links", "internal_count", "external_count"]
        }),
    )
}

fn seo_audit_canonical_hreflang() -> Capability {
    seo_capability(
        "seo.audit_canonical_hreflang",
        "audit_canonical_hreflang",
        "Audit Canonical Hreflang",
        "Checks canonical and hreflang link declarations.",
        vec!["seo", "canonical", "hreflang", "international_seo"],
        vec![],
        vec![
            "canonical QA",
            "international SEO checks",
            "publishing review",
        ],
        "Use for canonical and hreflang validation before publishing page recommendations.",
        web_extract_input_schema(),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["canonical_url", "canonical_count", "hreflang", "issues"]
        }),
    )
}

fn content_map_search_intent() -> Capability {
    content_capability(
        "content.map_search_intent",
        "map_search_intent",
        "Map Search Intent",
        "Maps topic, audience, page type, and business goal into a search-intent model.",
        vec!["content", "seo", "search_intent", "topic_research"],
        vec!["prepare.search_intent"],
        vec![
            "SEO content planning",
            "topic-aware briefs",
            "site copy strategy",
        ],
        "Use before content.generate_brief when the user wants SEO research or site content.",
        content_strategy_input_schema(false),
        json!({ "type": "object", "additionalProperties": true }),
    )
}

fn content_generate_brief() -> Capability {
    content_capability(
        "content.generate_brief",
        "generate_brief",
        "Generate Content Brief",
        "Builds a deterministic SEO content brief from topic, audience, page intent, sources, and competitor context.",
        vec!["content", "seo", "brief", "topic_research", "site_copy"],
        vec!["prepare.content_brief"],
        vec!["site content writing", "SEO page briefs", "blog and service page planning"],
        "Use before agent.run_task for writing. The agent should draft from this brief and supplied deterministic SEO evidence.",
        content_strategy_input_schema(true),
        json!({ "type": "object", "additionalProperties": true }),
    )
}

fn content_identify_gaps() -> Capability {
    content_capability(
        "content.identify_gaps",
        "identify_gaps",
        "Identify Content Gaps",
        "Compares own page sections with target and competitor sections.",
        vec!["content", "seo", "content_gap", "competitor"],
        vec![],
        vec!["content refreshes", "competitor-informed briefs", "page expansion planning"],
        "Use after metadata/article extraction when comparing existing content with competitor or target coverage.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "own_sections": { "type": "array", "items": { "type": "string" } },
                "target_sections": { "type": "array", "items": { "type": "string" } },
                "competitor_sections": { "type": "array", "items": { "type": "string" } }
            }
        }),
        json!({ "type": "object", "additionalProperties": true }),
    )
}

fn content_score_quality() -> Capability {
    content_capability(
        "content.score_quality",
        "score_quality",
        "Score Content Quality",
        "Scores draft content for structural SEO quality, topic coverage, audience fit, headings, and required terms.",
        vec!["content", "seo", "quality", "review", "helpful_content"],
        vec![],
        vec!["draft QA", "content publishing checks", "people-first content review"],
        "Use after agent.run_task drafts site content. Keep this deterministic score separate from final editorial judgment.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["content"],
            "properties": {
                "content": { "type": "string" },
                "topic": { "type": "string" },
                "audience": { "type": "string" },
                "required_terms": { "type": "array", "items": { "type": "string" } }
            }
        }),
        json!({ "type": "object", "additionalProperties": true }),
    )
}

fn seo_site_input_schema(primary_key: &str) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            primary_key: { "type": "string", "format": "uri" },
            "site_url": { "type": "string", "format": "uri" },
            "url": { "type": "string", "format": "uri" },
            "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 60000, "default": 10000 },
            "max_bytes": { "type": "integer", "minimum": 0, "maximum": 5242880, "default": 1048576 }
        },
        "anyOf": [
            { "required": [primary_key] },
            { "required": ["site_url"] },
            { "required": ["url"] }
        ]
    })
}

fn content_strategy_input_schema(include_sources: bool) -> Value {
    let mut properties = serde_json::Map::from_iter([
        ("topic".to_string(), json!({ "type": "string" })),
        ("audience".to_string(), json!({ "type": "string" })),
        ("business_goal".to_string(), json!({ "type": "string" })),
        (
            "page_type".to_string(),
            json!({ "type": "string", "enum": ["homepage", "service", "landing", "blog", "article", "product", "docs", "other"] }),
        ),
        (
            "search_intent".to_string(),
            json!({ "type": "string", "enum": ["informational", "commercial", "transactional", "navigational"] }),
        ),
        ("primary_keyword".to_string(), json!({ "type": "string" })),
        (
            "secondary_keywords".to_string(),
            json!({ "type": "array", "items": { "type": "string" } }),
        ),
    ]);
    if include_sources {
        properties.insert(
            "sources".to_string(),
            json!({ "type": "array", "items": {} }),
        );
        properties.insert(
            "competitors".to_string(),
            json!({ "type": "array", "items": {} }),
        );
        properties.insert(
            "internal_link_targets".to_string(),
            json!({ "type": "array", "items": { "type": "string" } }),
        );
    }

    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["topic"],
        "properties": properties
    })
}

fn seo_capability(
    id: &str,
    action: &str,
    display_name: &str,
    description: &str,
    intent_tags: Vec<&str>,
    operation_tags: Vec<&str>,
    best_for: Vec<&str>,
    builder_guidance: &str,
    input_schema: Value,
    output_schema: Value,
) -> Capability {
    capability(
        id,
        "seo",
        action,
        display_name,
        description,
        "seo",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        true,
        vec!["network:read", "data:read"],
        intent_tags,
        operation_tags,
        best_for,
        vec!["prose generation", "subjective brand writing"],
        builder_guidance,
        "If live SERP or competitor discovery is needed beyond supplied URLs/RSS sources, use agent.run_task with web access after deterministic SEO checks.",
        input_schema,
        output_schema,
    )
}

fn content_capability(
    id: &str,
    action: &str,
    display_name: &str,
    description: &str,
    intent_tags: Vec<&str>,
    operation_tags: Vec<&str>,
    best_for: Vec<&str>,
    builder_guidance: &str,
    input_schema: Value,
    output_schema: Value,
) -> Capability {
    capability(
        id,
        "content",
        action,
        display_name,
        description,
        "content",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        false,
        vec!["data:read"],
        intent_tags,
        operation_tags,
        best_for,
        vec!["fetching live sources", "writing final prose without agent synthesis"],
        builder_guidance,
        "Use agent.run_task for final prose after deterministic brief and SEO evidence are prepared.",
        input_schema,
        output_schema,
    )
}

fn rss_fetch_feed_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "url": { "type": "string", "format": "uri" },
            "body_text": { "type": "string" },
            "max_items": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
            "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 60000, "default": 10000 },
            "max_bytes": { "type": "integer", "minimum": 0, "maximum": 5242880, "default": 1048576 }
        },
        "anyOf": [
            { "required": ["url"] },
            { "required": ["body_text"] }
        ]
    })
}

fn rss_fetch_feed_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["ok", "url", "title", "entries", "error_type", "error_message"],
        "properties": {
            "ok": { "type": "boolean" },
            "url": { "type": ["string", "null"] },
            "title": { "type": ["string", "null"] },
            "entries": { "type": "array", "items": news_item_schema(false) },
            "error_type": { "type": ["string", "null"] },
            "error_message": { "type": ["string", "null"] }
        }
    })
}

fn news_trending_input_schema(require_query: bool) -> Value {
    let mut properties = serde_json::Map::from_iter([
        (
            "feeds".to_string(),
            json!({
                "type": "array",
                "items": {
                    "oneOf": [
                        { "type": "string", "format": "uri" },
                        {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "url": { "type": "string", "format": "uri" },
                                "body_text": { "type": "string" }
                            }
                        }
                    ]
                }
            }),
        ),
        (
            "max_items".to_string(),
            json!({ "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }),
        ),
        (
            "timeout_ms".to_string(),
            json!({ "type": "integer", "minimum": 1, "maximum": 60000, "default": 10000 }),
        ),
        (
            "max_bytes".to_string(),
            json!({ "type": "integer", "minimum": 0, "maximum": 5242880, "default": 1048576 }),
        ),
    ]);
    if require_query {
        properties.insert(
            "query".to_string(),
            json!({ "type": "string", "minLength": 1 }),
        );
    }

    json!({
        "type": "object",
        "additionalProperties": false,
        "required": if require_query { vec!["query"] } else { Vec::<&str>::new() },
        "properties": properties
    })
}

fn news_trending_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["items", "source_errors"],
        "properties": {
            "query": { "type": "string" },
            "items": { "type": "array", "items": news_item_schema(true) },
            "source_errors": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["url", "error_type", "error_message"],
                    "properties": {
                        "url": { "type": ["string", "null"] },
                        "error_type": { "type": ["string", "null"] },
                        "error_message": { "type": ["string", "null"] }
                    }
                }
            }
        }
    })
}

fn news_item_schema(include_source: bool) -> Value {
    let mut properties = serde_json::Map::from_iter([
        ("title".to_string(), json!({ "type": ["string", "null"] })),
        ("link".to_string(), json!({ "type": ["string", "null"] })),
        ("summary".to_string(), json!({ "type": ["string", "null"] })),
        (
            "published".to_string(),
            json!({ "type": ["string", "null"] }),
        ),
    ]);
    if include_source {
        properties.insert(
            "source_title".to_string(),
            json!({ "type": ["string", "null"] }),
        );
        properties.insert(
            "source_url".to_string(),
            json!({ "type": ["string", "null"] }),
        );
    }

    json!({
        "type": "object",
        "additionalProperties": false,
        "required": properties.keys().cloned().collect::<Vec<_>>(),
        "properties": properties
    })
}

fn data_parse_csv() -> Capability {
    capability(
        "data.parse_csv",
        "data",
        "parse_csv",
        "Parse CSV",
        "Parses CSV data into structured rows with validation diagnostics.",
        "data",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        false,
        vec!["data:read"],
        vec!["csv", "data", "parse"],
        vec!["parse.csv"],
        vec!["CSV summaries", "data cleaning", "table artifacts"],
        vec!["large-scale statistical analysis", "semantic interpretation of table contents"],
        "Use before agent summaries over CSV data or when workflow steps need deterministic CSV rows.",
        "Use agent.run_task only when the CSV requires semantic interpretation beyond deterministic parsing.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["content"],
            "properties": {
                "content": { "type": "string" },
                "has_headers": { "type": "boolean", "default": true },
                "delimiter": { "type": "string", "minLength": 1, "maxLength": 1, "default": "," },
                "max_rows": { "type": "integer", "minimum": 0, "maximum": 10000, "default": 1000 }
            }
        }),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["headers", "rows", "row_count", "truncated", "errors"],
            "properties": {
                "headers": { "type": "array", "items": { "type": "string" } },
                "rows": { "type": "array" },
                "row_count": { "type": "integer", "minimum": 0 },
                "truncated": { "type": "boolean" },
                "errors": { "type": "array", "items": { "type": "string" } }
            }
        }),
    )
}

fn data_transform_json() -> Capability {
    capability(
        "data.transform_json",
        "data",
        "transform_json",
        "Transform JSON",
        "Applies safe JSON projection, filtering, sorting, and limiting.",
        "data",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        false,
        vec!["data:read"],
        vec!["json", "data", "transform"],
        vec![
            "transform.filter",
            "transform.sort",
            "transform.project",
            "transform.limit",
        ],
        vec![
            "JSON report prep",
            "field extraction",
            "deterministic data shaping",
        ],
        vec!["semantic summarization", "open-ended data cleaning"],
        "Use instead of asking an agent to perform mechanical JSON transforms.",
        "Use agent.run_task only when the transformation requires judgment or unsupported operations.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["data"],
            "properties": {
                "data": {},
                "select_fields": { "type": "array", "items": { "type": "string" } },
                "filter_equals": { "type": "object", "additionalProperties": true },
                "limit": { "type": "integer", "minimum": 0, "maximum": 10000 },
                "sort_by": { "type": "string" }
            }
        }),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["records", "count", "truncated"],
            "properties": {
                "records": { "type": "array", "items": { "type": "object" } },
                "count": { "type": "integer", "minimum": 0 },
                "truncated": { "type": "boolean" }
            }
        }),
    )
}

fn scheduler_preview_next_runs() -> Capability {
    capability(
        "scheduler.preview_next_runs",
        "scheduler",
        "preview_next_runs",
        "Preview Schedule",
        "Computes upcoming run windows for a schedule definition.",
        "schedule",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        false,
        vec!["schedule:read"],
        vec!["schedule", "calendar", "preview"],
        vec![],
        vec![
            "schedule timeline",
            "next run preview",
            "calendar validation",
        ],
        vec!["executing scheduled workflows", "persisting schedule overrides"],
        "Use for schedule timeline UI and schedule validation workflows.",
        "Use the scheduler service only when the workflow must actually run or persist schedule state.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["cadence", "local_time"],
            "properties": {
                "cadence": { "type": "string", "enum": ["manual", "daily", "weekdays", "weekly"] },
                "local_time": { "type": "string", "pattern": "^\\d{2}:\\d{2}$" },
                "start_at": { "type": "string", "format": "date-time" },
                "count": { "type": "integer", "minimum": 0, "maximum": 50, "default": 5 }
            }
        }),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["next_runs", "errors"],
            "properties": {
                "next_runs": { "type": "array", "items": { "type": "string", "format": "date-time" } },
                "errors": { "type": "array", "items": { "type": "string" } }
            }
        }),
    )
}

fn notification_local() -> Capability {
    capability(
        "notification.local",
        "notification",
        "local",
        "Local Notification",
        "Builds a deterministic local desktop notification payload without invoking OS notification APIs.",
        "notification",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        false,
        vec!["notification:write"],
        vec!["notification", "alert", "local"],
        vec![],
        vec!["desktop alerts", "workflow completion notices"],
        vec!["sending remote notifications", "performing OS side effects during provider execution"],
        "Use to preview or record the local notification that would be displayed after a workflow condition is met.",
        "Use a side-effecting notification runtime only after explicit user approval.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["title", "body"],
            "properties": {
                "title": { "type": "string" },
                "body": { "type": "string" },
                "level": { "type": "string", "enum": ["info", "success", "warning", "error"], "default": "info" }
            }
        }),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["would_notify", "notification"],
            "properties": {
                "would_notify": { "type": "boolean" },
                "notification": {
                    "type": "object",
                    "required": ["title", "body", "level"],
                    "properties": {
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "level": { "type": "string" }
                    }
                }
            }
        }),
    )
}

fn mcp_discover_tools() -> Capability {
    capability(
        "mcp.discover_tools",
        "mcp",
        "discover_tools",
        "Discover MCP Tools",
        "Normalizes supplied MCP tool metadata into external capability records.",
        "integration",
        CapabilityStatus::Implemented,
        ExecutionMode::Deterministic,
        true,
        true,
        false,
        false,
        vec!["mcp:read"],
        vec!["mcp", "tools", "discovery", "integration"],
        vec![],
        vec!["MCP tool import", "connector capability discovery"],
        vec!["executing MCP tools", "discovering tools from an unwired runtime"],
        "Use to normalize MCP tool annotations into Raven capability metadata when metadata is supplied.",
        "If no MCP runtime metadata is supplied, return an unavailable status and continue without failing the workflow draft.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "servers": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": true,
                        "properties": {
                            "name": { "type": "string" },
                            "tools": { "type": "array", "items": { "type": "object", "additionalProperties": true } }
                        }
                    }
                },
                "tools": { "type": "array", "items": { "type": "object", "additionalProperties": true } }
            }
        }),
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["status", "detail", "discovered"],
            "properties": {
                "status": { "type": "string" },
                "detail": { "type": "string" },
                "count": { "type": "integer", "minimum": 0 },
                "discovered": { "type": "array", "items": { "type": "object" } }
            }
        }),
    )
}

fn simple_provider(
    id: &str,
    provider: &str,
    action: &str,
    display_name: &str,
    description: &str,
    category: &str,
    status: CapabilityStatus,
    execution_mode: ExecutionMode,
    permissions: Vec<&str>,
    intent_tags: Vec<&str>,
    builder_guidance: &str,
) -> Capability {
    capability(
        id,
        provider,
        action,
        display_name,
        description,
        category,
        status,
        execution_mode,
        true,
        false,
        false,
        true,
        permissions,
        intent_tags.clone(),
        vec![],
        intent_tags,
        vec!["unrelated open-ended reasoning"],
        builder_guidance,
        "Use agent.run_task only when the provider is unavailable or cannot satisfy the requested data shape.",
        json!({ "type": "object", "additionalProperties": true }),
        json!({ "type": "object", "additionalProperties": true }),
    )
}

fn agent_tool(
    id: &str,
    tool_class: &str,
    display_name: &str,
    description: &str,
    intent_tags: Vec<&str>,
    builder_guidance: &str,
) -> Capability {
    capability(
        id,
        "agent_tool",
        tool_class,
        display_name,
        description,
        "agent_tool",
        CapabilityStatus::Implemented,
        ExecutionMode::OpenAgentic,
        true,
        false,
        false,
        true,
        vec!["network:read"],
        intent_tags.clone(),
        vec![],
        intent_tags,
        vec!["deterministic provider work"],
        builder_guidance,
        "Prefer implemented deterministic provider actions before exposing agent tool access.",
        json!({ "type": "object", "additionalProperties": true }),
        json!({ "type": "object", "additionalProperties": true }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_http_probe_as_deterministic_network_read() {
        let capability = capability_for("http_probe", "check_urls")
            .expect("http_probe.check_urls should be registered");

        assert_eq!(capability.id, "http_probe.check_urls");
        assert_eq!(capability.provider, "http_probe");
        assert_eq!(capability.action, "check_urls");
        assert_eq!(capability.status, CapabilityStatus::Implemented);
        assert_eq!(capability.execution_mode, ExecutionMode::Deterministic);
        assert!(capability.deterministic);
        assert!(capability.read_only);
        assert!(capability.idempotent);
        assert!(capability.open_world);
        assert!(!capability.destructive);
        assert_eq!(capability.permissions, vec!["network:read"]);
        assert!(capability.intent_tags.contains(&"url_check".to_string()));
        assert!(capability
            .best_for
            .contains(&"TLS failure detection".to_string()));
        assert!(capability.input_schema["properties"].get("urls").is_some());
        assert!(capability.input_schema["properties"]
            .get("timeout_ms")
            .is_some());
        assert!(capability.input_schema["properties"]
            .get("follow_redirects")
            .is_some());
        assert!(capability.input_schema["properties"]
            .get("accepted_status_codes")
            .is_some());
        assert!(capability.input_schema["properties"]
            .get("retries")
            .is_some());

        let result_properties =
            &capability.output_schema["properties"]["results"]["items"]["properties"];
        for field in [
            "url",
            "ok",
            "status_code",
            "effective_url",
            "duration_ms",
            "content_type",
            "redirect_count",
            "error_type",
            "error_message",
            "checked_at",
        ] {
            assert!(
                result_properties.get(field).is_some(),
                "{field} should be declared"
            );
        }
    }

    #[test]
    fn deterministic_capability_lookup_matches_website_check_intents() {
        let capabilities = deterministic_capabilities_for_intent(&["website", "monitoring"]);

        assert_eq!(capabilities.len(), 1);
        assert_eq!(capabilities[0].id, "http_probe.check_urls");
    }

    #[test]
    fn catalog_tracks_implemented_provider_tool_groups() {
        let catalog = capability_catalog();
        let implemented = catalog
            .iter()
            .filter(|capability| capability.status == CapabilityStatus::Implemented)
            .count();

        assert!(implemented >= 21);
        assert!(catalog
            .iter()
            .any(|capability| capability.id == "weather.forecast_24h"
                && capability.status == CapabilityStatus::Implemented));
        assert!(catalog
            .iter()
            .any(|capability| capability.id == "weather.hourly_forecast"
                && capability.status == CapabilityStatus::Implemented));
        assert!(catalog
            .iter()
            .any(|capability| capability.id == "weather.alerts"
                && capability.status == CapabilityStatus::Implemented));
        for id in [
            "news.trending",
            "news.search",
            "rss.fetch_feed",
            "web.fetch_page",
            "web.extract_article",
            "web.extract_metadata",
            "seo.fetch_robots_txt",
            "seo.parse_robots_txt",
            "seo.fetch_sitemap",
            "seo.parse_sitemap",
            "seo.audit_indexability",
            "seo.audit_metadata",
            "seo.extract_structured_data",
            "seo.validate_json_ld",
            "seo.audit_links",
            "seo.audit_canonical_hreflang",
            "content.map_search_intent",
            "content.generate_brief",
            "content.identify_gaps",
            "content.score_quality",
            "data.parse_csv",
            "data.transform_json",
            "scheduler.preview_next_runs",
            "notification.local",
            "mcp.discover_tools",
        ] {
            assert!(
                catalog.iter().any(|capability| capability.id == id
                    && capability.status == CapabilityStatus::Implemented),
                "{id} should be implemented"
            );
        }
    }

    #[test]
    fn deterministic_capabilities_declare_operation_tags() {
        let catalog = capability_catalog();
        for id in [
            "http_probe.check_urls",
            "web.fetch_page",
            "web.extract_article",
            "web.extract_metadata",
            "rss.fetch_feed",
            "data.parse_csv",
            "data.transform_json",
            "seo.validate_json_ld",
            "content.map_search_intent",
            "content.generate_brief",
        ] {
            let capability = catalog
                .iter()
                .find(|capability| capability.id == id)
                .unwrap();
            assert!(
                !capability.operation_tags.is_empty(),
                "{id} must declare operation_tags"
            );
        }
    }

    #[test]
    fn operation_tags_are_specific_not_generic_template_words() {
        let generic = ["summary", "report", "brief", "research", "artifact"];
        for capability in capability_catalog() {
            for tag in &capability.operation_tags {
                assert!(
                    !generic.contains(&tag.as_str()),
                    "{} has generic operation tag {tag}",
                    capability.id
                );
            }
        }
    }

    #[test]
    fn planned_capabilities_are_not_executable_by_validation_lookup() {
        assert!(capability_for("weather", "forecast_24h").is_some());
        assert!(capability_for("news", "trending").is_some());
        assert!(capability_for("rss", "fetch_feed").is_some());
        assert!(capability_for("web", "fetch_page").is_some());
        assert!(capability_for("agent_tool", "web").is_none());
    }

    #[test]
    fn builder_catalog_includes_guidance_for_gap_aware_generation() {
        let catalog = builder_capability_catalog();
        let forecast = catalog
            .iter()
            .find(|capability| capability.id == "weather.forecast_24h")
            .unwrap();

        assert_eq!(forecast.status, CapabilityStatus::Implemented);
        assert!(forecast.builder_guidance.contains("next-24-hour"));
        assert!(forecast
            .fallback_strategy
            .contains("Open-Meteo is unavailable"));
        assert!(forecast.input_schema["properties"]
            .get("latitude")
            .is_some());
        assert!(forecast.output_schema["properties"].get("hourly").is_some());

        let summary = builder_capability_summary();
        let forecast_summary = summary
            .iter()
            .find(|capability| capability["id"] == "weather.forecast_24h")
            .unwrap();
        assert_eq!(forecast_summary["status"], "implemented");
        assert!(forecast_summary.get("input_schema").is_none());
        assert!(forecast_summary["fallback_strategy"]
            .as_str()
            .unwrap()
            .contains("Open-Meteo is unavailable"));
    }
}
