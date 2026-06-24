use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, FixedOffset, NaiveTime, SecondsFormat,
    TimeZone, Weekday,
};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;

const DEFAULT_MAX_ROWS: usize = 1_000;
const MAX_ROWS_LIMIT: usize = 10_000;
const DEFAULT_RUN_COUNT: usize = 5;
const MAX_RUN_COUNT: usize = 50;

pub fn parse_csv(input: &Value) -> Value {
    let content = input
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let has_headers = input
        .get("has_headers")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let max_rows = clamped_usize(input.get("max_rows"), DEFAULT_MAX_ROWS, MAX_ROWS_LIMIT);
    let (delimiter, mut errors) = parse_delimiter(input.get("delimiter"));
    let records = parse_csv_records(content, delimiter, &mut errors);

    let (headers, data_rows) = if has_headers {
        let headers = records
            .first()
            .map(|row| normalize_headers(row))
            .unwrap_or_default();
        (headers, records.into_iter().skip(1).collect::<Vec<_>>())
    } else {
        (Vec::new(), records)
    };

    let row_count = data_rows.len();
    let truncated = row_count > max_rows;
    let rows = data_rows
        .iter()
        .take(max_rows)
        .enumerate()
        .map(|(row_index, row)| {
            if has_headers {
                row_to_object(row, &headers, row_index, &mut errors)
            } else {
                Value::Array(
                    row.iter()
                        .map(|field| Value::String(field.clone()))
                        .collect(),
                )
            }
        })
        .collect::<Vec<_>>();

    json!({
        "headers": headers,
        "rows": rows,
        "row_count": row_count,
        "truncated": truncated,
        "errors": errors
    })
}

pub fn transform_json(input: &Value) -> Value {
    let Some(data) = input.get("data") else {
        return json!({ "records": [], "count": 0, "truncated": false });
    };
    let filter_equals = input.get("filter_equals").and_then(Value::as_object);
    let select_fields = input
        .get("select_fields")
        .and_then(Value::as_array)
        .map(|fields| {
            fields
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
    let sort_by = input.get("sort_by").and_then(Value::as_str);
    let limit = input
        .get("limit")
        .map(|value| clamped_usize(Some(value), usize::MAX, MAX_ROWS_LIMIT));

    let source_records = match data {
        Value::Array(values) => values.iter().collect::<Vec<_>>(),
        Value::Object(_) => vec![data],
        _ => Vec::new(),
    };

    let mut records = source_records
        .into_iter()
        .enumerate()
        .filter_map(|(index, record)| {
            let object = record.as_object()?;
            if filter_matches(object, filter_equals) {
                Some((index, object.clone()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    if let Some(field) = sort_by {
        records.sort_by(|(left_index, left), (right_index, right)| {
            compare_json_values(left.get(field), right.get(field))
                .then_with(|| left_index.cmp(right_index))
        });
        if sort_direction(input).is_some_and(|direction| direction == "desc") {
            records.reverse();
        }
    }

    let count = records.len();
    let output_limit = limit.unwrap_or(count);
    let truncated = count > output_limit;
    let records = records
        .into_iter()
        .take(output_limit)
        .map(|(_, record)| project_record(record, select_fields.as_deref()))
        .collect::<Vec<_>>();

    json!({
        "records": records,
        "count": count,
        "truncated": truncated
    })
}

fn sort_direction(input: &Value) -> Option<&'static str> {
    let direction = input
        .get("sort_direction")
        .or_else(|| input.get("order"))
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    match direction.as_str() {
        "desc" | "descending" => Some("desc"),
        "asc" | "ascending" => Some("asc"),
        _ => None,
    }
}

pub fn preview_next_runs(input: &Value) -> Value {
    let cadence = input
        .get("cadence")
        .and_then(Value::as_str)
        .unwrap_or("manual");
    let count = clamped_usize(input.get("count"), DEFAULT_RUN_COUNT, MAX_RUN_COUNT);
    let mut errors = Vec::new();

    if cadence == "manual" || count == 0 {
        return json!({ "next_runs": [], "errors": errors });
    }

    let Some(local_time) = input.get("local_time").and_then(Value::as_str) else {
        return json!({
            "next_runs": [],
            "errors": ["local_time is required for scheduled cadences"]
        });
    };
    let Ok(time) = NaiveTime::parse_from_str(local_time, "%H:%M") else {
        return json!({
            "next_runs": [],
            "errors": ["local_time must use HH:MM format"]
        });
    };

    let start_at = parse_start_at(input.get("start_at"), &mut errors);
    let Some(start_at) = start_at else {
        return json!({ "next_runs": [], "errors": errors });
    };

    let mut date = start_at.date_naive();
    let mut next_runs = Vec::new();
    let mut guard = 0usize;

    while next_runs.len() < count && guard < 370 {
        if cadence_allows_date(cadence, date.weekday(), start_at.date_naive().weekday()) {
            if let Some(candidate) = start_at
                .offset()
                .from_local_datetime(&date.and_time(time))
                .single()
            {
                if candidate > start_at {
                    next_runs.push(candidate.to_rfc3339_opts(SecondsFormat::Secs, false));
                }
            }
        }
        date = date
            .succ_opt()
            .unwrap_or_else(|| date + ChronoDuration::days(1));
        guard += 1;
    }

    if next_runs.len() < count && !matches!(cadence, "daily" | "weekdays" | "weekly") {
        errors.push(format!("unsupported cadence: {cadence}"));
    }

    json!({
        "next_runs": next_runs,
        "errors": errors
    })
}

pub fn local_notification(input: &Value) -> Value {
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let body = input
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let level = match input.get("level").and_then(Value::as_str) {
        Some("success" | "warning" | "error" | "info") => input["level"].as_str().unwrap(),
        _ => "info",
    };

    json!({
        "would_notify": true,
        "notification": {
            "title": title,
            "body": body,
            "level": level
        }
    })
}

pub fn discover_mcp_tools(input: &Value) -> Value {
    let mut discovered = Vec::new();

    if let Some(servers) = input.get("servers").and_then(Value::as_array) {
        for server in servers {
            let server_name = server
                .get("name")
                .or_else(|| server.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if let Some(tools) = server.get("tools").and_then(Value::as_array) {
                for tool in tools {
                    if let Some(capability) = normalize_mcp_tool(Some(server_name), tool) {
                        discovered.push(capability);
                    }
                }
            }
        }
    }

    if let Some(tools) = input.get("tools").and_then(Value::as_array) {
        for tool in tools {
            if let Some(capability) = normalize_mcp_tool(None, tool) {
                discovered.push(capability);
            }
        }
    }

    if discovered.is_empty() {
        return json!({
            "status": "unavailable",
            "detail": "no configured MCP discovery runtime; supply servers or tools metadata to normalize",
            "discovered": []
        });
    }

    json!({
        "status": "ok",
        "detail": "normalized supplied MCP tool metadata",
        "count": discovered.len(),
        "discovered": discovered
    })
}

fn parse_delimiter(value: Option<&Value>) -> (char, Vec<String>) {
    let Some(delimiter) = value.and_then(Value::as_str) else {
        return (',', Vec::new());
    };
    let mut chars = delimiter.chars();
    match (chars.next(), chars.next()) {
        (Some(delimiter), None) => (delimiter, Vec::new()),
        _ => (
            ',',
            vec!["delimiter must be a single character; defaulted to comma".to_string()],
        ),
    }
}

fn parse_csv_records(content: &str, delimiter: char, errors: &mut Vec<String>) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = content.chars().peekable();
    let mut in_quotes = false;
    let mut just_finished_row = true;

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if matches!(chars.peek(), Some('"')) {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
            just_finished_row = false;
            continue;
        }

        if ch == '"' && field.is_empty() {
            in_quotes = true;
            just_finished_row = false;
        } else if ch == delimiter {
            row.push(std::mem::take(&mut field));
            just_finished_row = false;
        } else if ch == '\n' {
            row.push(std::mem::take(&mut field));
            records.push(std::mem::take(&mut row));
            just_finished_row = true;
        } else if ch == '\r' {
            if matches!(chars.peek(), Some('\n')) {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            records.push(std::mem::take(&mut row));
            just_finished_row = true;
        } else {
            field.push(ch);
            just_finished_row = false;
        }
    }

    if in_quotes {
        errors.push("unterminated quoted field".to_string());
    }
    if !just_finished_row || !field.is_empty() || !row.is_empty() {
        row.push(field);
        records.push(row);
    }

    records
}

fn normalize_headers(headers: &[String]) -> Vec<String> {
    let mut seen = Map::new();
    headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            let base = if header.is_empty() {
                format!("column_{}", index + 1)
            } else {
                header.clone()
            };
            let count = seen.get(&base).and_then(Value::as_u64).unwrap_or(0) + 1;
            seen.insert(base.clone(), json!(count));
            if count == 1 {
                base
            } else {
                format!("{base}_{count}")
            }
        })
        .collect()
}

fn row_to_object(
    row: &[String],
    headers: &[String],
    row_index: usize,
    errors: &mut Vec<String>,
) -> Value {
    if row.len() != headers.len() {
        errors.push(format!(
            "row {} has {} fields but header has {} fields",
            row_index + 1,
            row.len(),
            headers.len()
        ));
    }

    let mut object = Map::new();
    let width = headers.len().max(row.len());
    for index in 0..width {
        let key = headers
            .get(index)
            .cloned()
            .unwrap_or_else(|| format!("column_{}", index + 1));
        let value = row
            .get(index)
            .map(|field| Value::String(field.clone()))
            .unwrap_or(Value::Null);
        object.insert(key, value);
    }
    Value::Object(object)
}

fn filter_matches(record: &Map<String, Value>, filter_equals: Option<&Map<String, Value>>) -> bool {
    filter_equals
        .map(|filters| {
            filters
                .iter()
                .all(|(field, expected)| record.get(field) == Some(expected))
        })
        .unwrap_or(true)
}

fn project_record(record: Map<String, Value>, select_fields: Option<&[String]>) -> Value {
    let Some(fields) = select_fields else {
        return Value::Object(record);
    };

    let mut projected = Map::new();
    for field in fields {
        if let Some(value) = record.get(field) {
            projected.insert(field.clone(), value.clone());
        }
    }
    Value::Object(projected)
}

fn compare_json_values(left: Option<&Value>, right: Option<&Value>) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(Value::Null), Some(Value::Null)) => Ordering::Equal,
        (Some(Value::Null), Some(_)) => Ordering::Less,
        (Some(_), Some(Value::Null)) => Ordering::Greater,
        (Some(Value::Number(left)), Some(Value::Number(right))) => left
            .as_f64()
            .partial_cmp(&right.as_f64())
            .unwrap_or(Ordering::Equal),
        (Some(Value::String(left)), Some(Value::String(right))) => left.cmp(right),
        (Some(Value::Bool(left)), Some(Value::Bool(right))) => left.cmp(right),
        (Some(left), Some(right)) => left.to_string().cmp(&right.to_string()),
    }
}

fn parse_start_at(
    value: Option<&Value>,
    errors: &mut Vec<String>,
) -> Option<DateTime<FixedOffset>> {
    let start_at = value
        .and_then(Value::as_str)
        .unwrap_or("1970-01-01T00:00:00+00:00");
    DateTime::parse_from_rfc3339(start_at)
        .map_err(|_| {
            errors.push("start_at must be an ISO 8601 timestamp with offset".to_string());
        })
        .ok()
}

fn cadence_allows_date(cadence: &str, weekday: Weekday, weekly_anchor: Weekday) -> bool {
    match cadence {
        "daily" => true,
        "weekdays" => !matches!(weekday, Weekday::Sat | Weekday::Sun),
        "weekly" => weekday == weekly_anchor,
        _ => false,
    }
}

fn clamped_usize(value: Option<&Value>, default: usize, maximum: usize) -> usize {
    value
        .and_then(Value::as_u64)
        .map(|value| value.min(maximum as u64) as usize)
        .unwrap_or(default.min(maximum))
}

fn normalize_mcp_tool(server_name: Option<&str>, tool: &Value) -> Option<Value> {
    let name = tool
        .get("name")
        .or_else(|| tool.get("id"))
        .and_then(Value::as_str)?;
    let server = server_name
        .or_else(|| tool.get("server").and_then(Value::as_str))
        .unwrap_or("unknown");
    let description = tool
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let input_schema = tool
        .get("input_schema")
        .or_else(|| tool.get("inputSchema"))
        .or_else(|| tool.get("schema"))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "additionalProperties": true }));
    let annotations = tool.get("annotations").and_then(Value::as_object);
    let read_only = annotation_bool(annotations, "readOnlyHint", true);
    let idempotent = annotation_bool(annotations, "idempotentHint", false);
    let destructive = annotation_bool(annotations, "destructiveHint", false);
    let open_world = annotation_bool(annotations, "openWorldHint", true);

    Some(json!({
        "id": format!("mcp.{}.{}", slug(server), slug(name)),
        "provider": "mcp",
        "action": name,
        "server": server,
        "display_name": tool
            .get("title")
            .or_else(|| tool.get("display_name"))
            .and_then(Value::as_str)
            .unwrap_or(name),
        "description": description,
        "status": "external",
        "execution_mode": "bounded_agentic",
        "deterministic": false,
        "read_only": read_only,
        "idempotent": idempotent,
        "destructive": destructive,
        "open_world": open_world,
        "permissions": ["mcp:read"],
        "input_schema": input_schema
    }))
}

fn annotation_bool(
    annotations: Option<&Map<String, Value>>,
    key: &str,
    default_value: bool,
) -> bool {
    annotations
        .and_then(|annotations| annotations.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(default_value)
}

fn slug(value: &str) -> String {
    let slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");

    if slug.is_empty() {
        "unknown".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_csv_preserves_quoted_commas_quotes_and_newlines() {
        let result = parse_csv(&json!({
            "content": "name,note\nAda,\"hello, \"\"world\"\"\"\nGrace,\"line one\nline two\"",
            "has_headers": true,
            "delimiter": ",",
            "max_rows": 10
        }));

        assert_eq!(result["headers"], json!(["name", "note"]));
        assert_eq!(result["row_count"], 2);
        assert_eq!(result["truncated"], false);
        assert_eq!(result["errors"], json!([]));
        assert_eq!(
            result["rows"][0],
            json!({"name": "Ada", "note": "hello, \"world\""})
        );
        assert_eq!(
            result["rows"][1],
            json!({"name": "Grace", "note": "line one\nline two"})
        );
    }

    #[test]
    fn transform_json_filters_sorts_projects_and_limits_records() {
        let result = transform_json(&json!({
            "data": [
                {"name": "Ada", "team": "runtime", "score": 3, "extra": true},
                {"name": "Grace", "team": "data", "score": 1, "extra": false},
                {"name": "Linus", "team": "runtime", "score": 2, "extra": true}
            ],
            "filter_equals": {"team": "runtime"},
            "select_fields": ["name", "score"],
            "sort_by": "score",
            "limit": 1
        }));

        assert_eq!(result["count"], 2);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["records"], json!([{"name": "Linus", "score": 2}]));
    }

    #[test]
    fn transform_json_sorts_descending_when_requested() {
        let result = transform_json(&json!({
            "data": [
                {"name": "Ada", "score": 3},
                {"name": "Grace", "score": 1},
                {"name": "Linus", "score": 2}
            ],
            "sort_by": "score",
            "sort_direction": "desc"
        }));

        assert_eq!(
            result["records"],
            json!([
                {"name": "Ada", "score": 3},
                {"name": "Linus", "score": 2},
                {"name": "Grace", "score": 1}
            ])
        );
    }

    #[test]
    fn preview_next_runs_skips_weekends_for_weekday_cadence() {
        let result = preview_next_runs(&json!({
            "cadence": "weekdays",
            "local_time": "09:30",
            "start_at": "2026-06-19T10:00:00-06:00",
            "count": 3
        }));

        assert_eq!(
            result["next_runs"],
            json!([
                "2026-06-22T09:30:00-06:00",
                "2026-06-23T09:30:00-06:00",
                "2026-06-24T09:30:00-06:00"
            ])
        );
    }

    #[test]
    fn local_notification_returns_deterministic_payload_without_side_effects() {
        let result = local_notification(&json!({
            "title": "Build finished",
            "body": "All checks completed.",
            "level": "success"
        }));

        assert_eq!(
            result,
            json!({
                "would_notify": true,
                "notification": {
                    "title": "Build finished",
                    "body": "All checks completed.",
                    "level": "success"
                }
            })
        );
    }

    #[test]
    fn discover_mcp_tools_reports_no_runtime_when_no_metadata_supplied() {
        let result = discover_mcp_tools(&json!({}));

        assert_eq!(result["status"], "unavailable");
        assert_eq!(result["discovered"], json!([]));
        assert!(result["detail"]
            .as_str()
            .unwrap()
            .contains("no configured MCP discovery runtime"));
    }
}
