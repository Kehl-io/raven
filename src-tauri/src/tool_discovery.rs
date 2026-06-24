use crate::models::{
    CapabilitySource, RawToolAnnotations, RawToolAuthStatus, RawToolInventoryItem,
    RawToolOperation, RawToolStatus,
};

pub fn detect_raw_tools() -> Vec<RawToolInventoryItem> {
    vec![
        detect_cli_version("cli.git", "Git", "git", &["--version"]),
        detect_cli_version("cli.gh", "GitHub CLI", "gh", &["--version"]),
        detect_cli_version("cli.rg", "ripgrep", "rg", &["--version"]),
        detect_cli_version("cli.pdftotext", "pdftotext", "pdftotext", &["-v"]),
        detect_cli_version("cli.pdftoppm", "pdftoppm", "pdftoppm", &["-v"]),
        detect_cli_version(
            "cli.tesseract",
            "Tesseract OCR",
            "tesseract",
            &["--version"],
        ),
        detect_cli_version("cli.pnpm", "pnpm", "pnpm", &["--version"]),
        detect_cli_version("cli.cargo", "Cargo", "cargo", &["--version"]),
    ]
}

pub fn detect_cli_version(
    id: &str,
    display_name: &str,
    command: &str,
    args: &[&str],
) -> RawToolInventoryItem {
    let output = std::process::Command::new(command).args(args).output();
    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let text = if stdout.is_empty() { stderr } else { stdout };
            raw_cli_tool(
                id,
                display_name,
                command,
                Ok(text.clone()),
                first_version_token(&text),
            )
        }
        Ok(output) => raw_cli_tool(
            id,
            display_name,
            command,
            Err(non_success_diagnostic(
                command,
                &output.status.to_string(),
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr),
            )),
            None,
        ),
        Err(error) => raw_cli_tool(id, display_name, command, Err(error.to_string()), None),
    }
}

pub fn raw_cli_tool(
    id: &str,
    display_name: &str,
    command: &str,
    result: Result<String, String>,
    version: Option<String>,
) -> RawToolInventoryItem {
    let (mut status, detection_errors) = match result {
        Ok(_) => (RawToolStatus::Available, Vec::new()),
        Err(error) => {
            let error = error.trim().to_string();
            let error = if error.is_empty() {
                format!("{command} is unavailable")
            } else {
                error
            };
            (RawToolStatus::Unavailable, vec![error])
        }
    };
    let auth_status = if id == "cli.gh" && status == RawToolStatus::Available {
        detect_github_auth_status(command)
    } else {
        RawToolAuthStatus::Unknown
    };
    if id == "cli.gh" {
        status = match (&status, &auth_status) {
            (RawToolStatus::Available, RawToolAuthStatus::NeedsAuth) => RawToolStatus::NeedsAuth,
            (RawToolStatus::Available, RawToolAuthStatus::Unknown) => RawToolStatus::Degraded,
            _ => status,
        };
    }
    RawToolInventoryItem {
        id: id.into(),
        source: CapabilitySource::Cli,
        display_name: display_name.into(),
        binary_path: Some(command.into()),
        version,
        status,
        auth_status: Some(auth_status),
        operations: Vec::<RawToolOperation>::new(),
        annotations: RawToolAnnotations::default(),
        detection_errors,
        last_checked_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn detect_github_auth_status(command: &str) -> RawToolAuthStatus {
    match std::process::Command::new(command)
        .args(["auth", "status"])
        .output()
    {
        Ok(output) => github_auth_status_from_output(
            output.status.success(),
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        ),
        Err(_) => RawToolAuthStatus::Unknown,
    }
}

fn github_auth_status_from_output(success: bool, stdout: &str, stderr: &str) -> RawToolAuthStatus {
    let text = format!("{stdout}\n{stderr}").to_lowercase();
    if text.contains("not logged")
        || text.contains("not authenticated")
        || text.contains("authentication required")
        || text.contains("gh auth login")
        || text.contains("no oauth token")
    {
        return RawToolAuthStatus::NeedsAuth;
    }
    if success {
        return RawToolAuthStatus::Authenticated;
    }
    RawToolAuthStatus::Unknown
}

fn first_version_token(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|token| token.chars().any(|character| character.is_ascii_digit()))
        .map(|token| {
            token
                .trim_matches(|character: char| character == ',' || character == ';')
                .to_string()
        })
}

fn non_success_diagnostic(command: &str, status: &str, stdout: &str, stderr: &str) -> String {
    let mut parts = vec![format!("{command} exited with status {status}")];
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        parts.push(format!("stdout: {stdout}"));
    }
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        parts.push(format!("stderr: {stderr}"));
    }
    parts.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_output_detector_parses_available_tool() {
        let item = raw_cli_tool(
            "cli.git",
            "Git",
            "git",
            Ok("git version 2.45.0".into()),
            Some("2.45.0".into()),
        );

        assert_eq!(item.id, "cli.git");
        assert_eq!(item.status, RawToolStatus::Available);
        assert_eq!(item.version.as_deref(), Some("2.45.0"));
    }

    #[test]
    fn command_output_detector_reports_unavailable_tool() {
        let item = raw_cli_tool("cli.gh", "GitHub CLI", "gh", Err("not found".into()), None);

        assert_eq!(item.status, RawToolStatus::Unavailable);
        assert_eq!(item.detection_errors, vec!["not found"]);
    }

    #[test]
    fn github_auth_status_output_maps_success_to_authenticated() {
        assert_eq!(
            github_auth_status_from_output(true, "", "Logged in to github.com account octocat"),
            RawToolAuthStatus::Authenticated
        );
    }

    #[test]
    fn github_auth_status_output_maps_auth_failure_to_needs_auth() {
        assert_eq!(
            github_auth_status_from_output(
                false,
                "",
                "You are not logged into any GitHub hosts. Run gh auth login."
            ),
            RawToolAuthStatus::NeedsAuth
        );
    }

    #[test]
    fn github_auth_status_output_preserves_unknown_for_ambiguous_failures() {
        assert_eq!(
            github_auth_status_from_output(false, "", "gh auth status failed unexpectedly"),
            RawToolAuthStatus::Unknown
        );
    }

    #[test]
    fn first_version_token_returns_first_token_with_a_digit() {
        assert_eq!(
            first_version_token("ripgrep 14.1.1 (rev 4649aa9700)").as_deref(),
            Some("14.1.1")
        );
        assert_eq!(
            first_version_token("pdftotext version 24.02.0; copyright").as_deref(),
            Some("24.02.0")
        );
    }

    #[test]
    fn non_success_diagnostic_includes_status_and_output() {
        let diagnostic = non_success_diagnostic(
            "example",
            "exit status: 2",
            "usage: example --help\n",
            "fatal: invalid argument\n",
        );

        assert!(diagnostic.contains("example exited with status exit status: 2"));
        assert!(diagnostic.contains("stdout: usage: example --help"));
        assert!(diagnostic.contains("stderr: fatal: invalid argument"));
    }

    #[test]
    fn non_success_diagnostic_falls_back_when_output_is_empty() {
        assert_eq!(
            non_success_diagnostic("example", "exit status: 2", "", ""),
            "example exited with status exit status: 2"
        );
    }
}
