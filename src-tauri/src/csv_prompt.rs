pub(crate) fn csv_content_from_prompt(prompt: &str) -> String {
    let lines = prompt.lines().map(str::trim).collect::<Vec<_>>();
    if let Some(start_index) = csv_table_start(&lines) {
        return csv_table_content(&lines, start_index);
    }

    if let Some(inline_lines) = inline_csv_lines(&lines) {
        let inline_refs = inline_lines.iter().map(String::as_str).collect::<Vec<_>>();
        if let Some(start_index) = csv_table_start(&inline_refs) {
            return csv_table_content(&inline_refs, start_index);
        }
    }

    let csv_lines = lines
        .into_iter()
        .filter(|line| line.contains(','))
        .collect::<Vec<_>>();
    if csv_lines.is_empty() {
        prompt.into()
    } else {
        csv_lines.join("\n")
    }
}

fn csv_table_content(lines: &[&str], start_index: usize) -> String {
    let header_field_count =
        csv_field_count(lines[start_index]).expect("CSV table start has a parseable header");
    lines[start_index..]
        .iter()
        .copied()
        .take_while(|line| is_csv_table_line(line, header_field_count))
        .collect::<Vec<_>>()
        .join("\n")
}

fn inline_csv_lines(lines: &[&str]) -> Option<Vec<String>> {
    lines.iter().enumerate().find_map(|(index, line)| {
        let inline_header = inline_csv_header(line)?;
        let mut csv_lines = vec![inline_header];
        csv_lines.extend(lines[index + 1..].iter().map(|line| (*line).to_string()));
        Some(csv_lines)
    })
}

fn inline_csv_header(line: &str) -> Option<String> {
    let tail = tail_after_case_insensitive(line, "csv:")
        .or_else(|| tail_after_case_insensitive(line, "csv data:"))?
        .trim();
    if csv_field_count(tail).is_some() {
        Some(tail.to_string())
    } else {
        None
    }
}

fn tail_after_case_insensitive<'a>(value: &'a str, phrase: &str) -> Option<&'a str> {
    let normalized = value.to_ascii_lowercase();
    let start = normalized.find(phrase)?;
    value.get(start + phrase.len()..)
}

fn csv_table_start(lines: &[&str]) -> Option<usize> {
    lines.iter().enumerate().find_map(|(index, line)| {
        let field_count = csv_field_count(line)?;
        if !looks_like_csv_header(line) {
            return None;
        }
        let next_table_candidate = lines[index + 1..]
            .iter()
            .copied()
            .filter(|next_line| !next_line.is_empty())
            .find(|next_line| {
                csv_field_count(next_line).is_some() || looks_like_embedded_non_csv(next_line)
            })?;
        is_csv_table_line(next_table_candidate, field_count).then_some(index)
    })
}

fn is_csv_table_line(line: &str, expected_field_count: usize) -> bool {
    !line.is_empty()
        && !looks_like_embedded_non_csv(line)
        && csv_field_count(line) == Some(expected_field_count)
}

fn looks_like_embedded_non_csv(line: &str) -> bool {
    let line = line.trim_start();
    if line.starts_with('"') {
        return false;
    }

    looks_like_structured_payload(line) || looks_like_prompt_transition(line)
}

fn looks_like_structured_payload(line: &str) -> bool {
    let Some(first) = line.chars().next() else {
        return false;
    };

    match first {
        '{' => line.ends_with('}') && line.contains(':'),
        '[' => line.ends_with(']') && (line.contains(':') || line.contains(',')),
        '<' => line.ends_with('>') && line.contains('/'),
        _ => false,
    }
}

fn looks_like_prompt_transition(line: &str) -> bool {
    let normalized = line.to_ascii_lowercase();
    [
        "and ",
        "also ",
        "then ",
        "next ",
        "now ",
        "validate ",
        "summarize ",
        "summary ",
        "json ",
        "json-ld ",
        "payload ",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
}

fn looks_like_csv_header(line: &str) -> bool {
    let Some(fields) = csv_fields(line) else {
        return false;
    };
    let normalized = line.to_ascii_lowercase();
    if normalized.contains("csv")
        || normalized.contains(", then ")
        || [
            "create ",
            "parse ",
            "summarize ",
            "filter ",
            "sort ",
            "select ",
            "limit ",
            "write ",
        ]
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
    {
        return false;
    }

    fields.iter().all(|field| {
        let field = field.trim();
        !field.is_empty()
            && field.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | ' ')
            })
    })
}

fn csv_field_count(line: &str) -> Option<usize> {
    csv_fields(line).map(|fields| fields.len())
}

fn csv_fields(line: &str) -> Option<Vec<String>> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut chars = line.chars().peekable();
    let mut in_quotes = false;
    let mut saw_delimiter = false;

    while let Some(character) = chars.next() {
        if in_quotes {
            if character == '"' {
                if matches!(chars.peek(), Some('"')) {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(character);
            }
        } else if character == '"' && field.is_empty() {
            in_quotes = true;
        } else if character == ',' {
            saw_delimiter = true;
            fields.push(std::mem::take(&mut field));
        } else {
            field.push(character);
        }
    }

    if in_quotes || !saw_delimiter {
        return None;
    }
    fields.push(field);
    Some(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_content_stops_before_json_ld_payload() {
        let prompt = r#"Create a deterministic QA workflow: parse this CSV, select name, then validate this JSON-LD payload and summarize both results.
name,status
Acme,active
{"@context":"https://schema.org","@type":"FAQPage"}"#;

        assert_eq!(csv_content_from_prompt(prompt), "name,status\nAcme,active");
    }

    #[test]
    fn csv_content_keeps_quoted_json_shaped_field() {
        let prompt = r#"Parse this CSV and summarize payloads.
payload,status
"{""@context"":""https://schema.org"",""@type"":""FAQPage""}",active"#;

        assert_eq!(
            csv_content_from_prompt(prompt),
            r#"payload,status
"{""@context"":""https://schema.org"",""@type"":""FAQPage""}",active"#
        );
    }

    #[test]
    fn csv_content_extracts_inline_header_after_csv_marker() {
        let prompt = "Parse this CSV: name,status\nAcme,active";

        assert_eq!(csv_content_from_prompt(prompt), "name,status\nAcme,active");
    }
}
