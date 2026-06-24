use crate::models::{ProviderHealth, ProviderKind, ProviderStatus};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub trait ContextProvider {
    fn status(&self) -> ProviderHealth;
    fn context_pack(&self, project_root: &Path) -> Result<ContextPack, ProviderError>;
}

pub trait WeatherProvider {
    fn current_weather(&self) -> Result<WeatherSnapshot, ProviderError>;
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContextPack {
    pub summary: String,
    pub source_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WeatherSnapshot {
    pub location: String,
    pub observed_at: String,
    pub temperature: f64,
    pub temperature_unit: String,
    pub apparent_temperature: f64,
    pub apparent_temperature_unit: String,
    pub humidity_percent: i64,
    pub precipitation: f64,
    pub precipitation_unit: String,
    pub wind_speed: f64,
    pub wind_speed_unit: String,
    pub weather_code: i64,
    pub condition: String,
    pub source_refs: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider unavailable")]
    Unavailable,
    #[error("command failed: {0}")]
    CommandFailed(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("pdf extraction failed: {0}")]
    PdfExtraction(String),
    #[error("github api failed: {0}")]
    GitHubApi(String),
    #[error("weather api failed: {0}")]
    WeatherApi(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PdfExtractionMode {
    Digital,
    Ocr,
}

pub struct OpenMeteoWeatherProvider {
    location: String,
    latitude: f64,
    longitude: f64,
}

impl OpenMeteoWeatherProvider {
    pub fn denver_default() -> Self {
        Self {
            location: "Denver, CO".into(),
            latitude: 39.7392,
            longitude: -104.9903,
        }
    }

    pub fn from_inputs(inputs: &serde_json::Value) -> Result<Self, ProviderError> {
        let location = inputs
            .get("location")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Denver, CO")
            .to_string();
        let latitude = inputs.get("latitude").and_then(serde_json::Value::as_f64);
        let longitude = inputs.get("longitude").and_then(serde_json::Value::as_f64);

        match (latitude, longitude) {
            (Some(latitude), Some(longitude)) => {
                if !(-90.0..=90.0).contains(&latitude) {
                    return Err(ProviderError::WeatherApi(
                        "latitude must be between -90 and 90".into(),
                    ));
                }
                if !(-180.0..=180.0).contains(&longitude) {
                    return Err(ProviderError::WeatherApi(
                        "longitude must be between -180 and 180".into(),
                    ));
                }
                Ok(Self {
                    location,
                    latitude,
                    longitude,
                })
            }
            (None, None) => Ok(Self {
                location,
                ..Self::denver_default()
            }),
            _ => Err(ProviderError::WeatherApi(
                "latitude and longitude must be provided together".into(),
            )),
        }
    }

    fn request_url(&self) -> String {
        format!(
            "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto",
            self.latitude, self.longitude
        )
    }

    pub fn snapshot_from_json(
        location: &str,
        value: &serde_json::Value,
    ) -> Result<WeatherSnapshot, ProviderError> {
        let current = value
            .get("current")
            .and_then(|value| value.as_object())
            .ok_or_else(|| ProviderError::WeatherApi("missing current weather payload".into()))?;
        let units = value
            .get("current_units")
            .and_then(|value| value.as_object())
            .ok_or_else(|| ProviderError::WeatherApi("missing current weather units".into()))?;
        let latitude = value
            .get("latitude")
            .and_then(|value| value.as_f64())
            .unwrap_or_default();
        let longitude = value
            .get("longitude")
            .and_then(|value| value.as_f64())
            .unwrap_or_default();
        let weather_code = current
            .get("weather_code")
            .and_then(|value| value.as_i64())
            .ok_or_else(|| ProviderError::WeatherApi("missing weather_code".into()))?;

        Ok(WeatherSnapshot {
            location: location.into(),
            observed_at: current
                .get("time")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
                .into(),
            temperature: required_f64(current, "temperature_2m")?,
            temperature_unit: unit(units, "temperature_2m"),
            apparent_temperature: required_f64(current, "apparent_temperature")?,
            apparent_temperature_unit: unit(units, "apparent_temperature"),
            humidity_percent: current
                .get("relative_humidity_2m")
                .and_then(|value| value.as_i64())
                .ok_or_else(|| ProviderError::WeatherApi("missing relative_humidity_2m".into()))?,
            precipitation: required_f64(current, "precipitation")?,
            precipitation_unit: unit(units, "precipitation"),
            wind_speed: required_f64(current, "wind_speed_10m")?,
            wind_speed_unit: unit(units, "wind_speed_10m"),
            weather_code,
            condition: weather_condition(weather_code).into(),
            source_refs: vec![format!("open-meteo:{latitude},{longitude}")],
        })
    }
}

impl WeatherProvider for OpenMeteoWeatherProvider {
    fn current_weather(&self) -> Result<WeatherSnapshot, ProviderError> {
        let response: serde_json::Value = ureq::get(&self.request_url())
            .call()
            .map_err(|error| ProviderError::WeatherApi(error.to_string()))?
            .into_json()
            .map_err(|error| ProviderError::WeatherApi(error.to_string()))?;
        Self::snapshot_from_json(&self.location, &response)
    }
}

fn required_f64(
    current: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<f64, ProviderError> {
    current
        .get(key)
        .and_then(|value| value.as_f64())
        .ok_or_else(|| ProviderError::WeatherApi(format!("missing {key}")))
}

fn unit(units: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
    units
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .into()
}

pub(crate) fn weather_condition(code: i64) -> &'static str {
    match code {
        0 => "Clear sky",
        1 => "Mainly clear",
        2 => "Partly cloudy",
        3 => "Overcast",
        45 | 48 => "Fog",
        51 | 53 | 55 => "Drizzle",
        56 | 57 => "Freezing drizzle",
        61 | 63 | 65 => "Rain",
        66 | 67 => "Freezing rain",
        71 | 73 | 75 => "Snowfall",
        77 => "Snow grains",
        80 | 81 | 82 => "Rain showers",
        85 | 86 => "Snow showers",
        95 => "Thunderstorm",
        96 | 99 => "Thunderstorm with hail",
        _ => "Unknown conditions",
    }
}

pub struct LocalGitProvider;

impl ContextProvider for LocalGitProvider {
    fn status(&self) -> ProviderHealth {
        ProviderHealth {
            id: "local_git".into(),
            name: "Local Git".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::Available,
            summary: "Reads recent commits and changed files using safe local git commands.".into(),
            fallback_provider_id: None,
        }
    }

    fn context_pack(&self, project_root: &Path) -> Result<ContextPack, ProviderError> {
        let status = Command::new("git")
            .args(["status", "--short"])
            .current_dir(project_root)
            .output()
            .map_err(|error| ProviderError::CommandFailed(error.to_string()))?;

        let log = Command::new("git")
            .args(["log", "--oneline", "-5"])
            .current_dir(project_root)
            .output()
            .map_err(|error| ProviderError::CommandFailed(error.to_string()))?;

        if !status.status.success() && !log.status.success() {
            return Err(ProviderError::CommandFailed(
                "git context unavailable".into(),
            ));
        }

        let status_text = String::from_utf8_lossy(&status.stdout).trim().to_string();
        let log_text = String::from_utf8_lossy(&log.stdout).trim().to_string();
        let summary = format!(
            "Recent commits:\n{}\n\nChanged files:\n{}",
            empty_as_none(&log_text),
            empty_as_none(&status_text)
        );

        Ok(ContextPack {
            summary,
            source_refs: vec!["local git status".into(), "local git log".into()],
        })
    }
}

pub struct NestWeaverProvider;

impl ContextProvider for NestWeaverProvider {
    fn status(&self) -> ProviderHealth {
        ProviderHealth {
            id: "nestweaver".into(),
            name: "NestWeaver".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::Unavailable,
            summary: "NestWeaver is not connected; Raven will use Local Git context until it is configured.".into(),
            fallback_provider_id: Some("local_git".into()),
        }
    }

    fn context_pack(&self, _project_root: &Path) -> Result<ContextPack, ProviderError> {
        Err(ProviderError::Unavailable)
    }
}

pub struct NestWeaverCliProvider {
    binary_path: PathBuf,
    db_path: Option<PathBuf>,
    project: Option<String>,
    token_budget: usize,
}

impl NestWeaverCliProvider {
    pub fn new(
        binary_path: impl AsRef<Path>,
        db_path: Option<PathBuf>,
        project: Option<String>,
        token_budget: usize,
    ) -> Self {
        Self {
            binary_path: binary_path.as_ref().to_path_buf(),
            db_path,
            project,
            token_budget,
        }
    }

    pub fn health_from_status_json(value: &serde_json::Value) -> ProviderHealth {
        let version = value
            .get("version")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");

        ProviderHealth {
            id: "nestweaver".into(),
            name: "NestWeaver".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::Available,
            summary: format!(
                "NestWeaver daemon {version} is ready with a configured project database."
            ),
            fallback_provider_id: Some("local_git".into()),
        }
    }

    fn unavailable_health(summary: impl Into<String>) -> ProviderHealth {
        ProviderHealth {
            id: "nestweaver".into(),
            name: "NestWeaver".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::Unavailable,
            summary: summary.into(),
            fallback_provider_id: Some("local_git".into()),
        }
    }

    fn needs_config_health(summary: impl Into<String>) -> ProviderHealth {
        ProviderHealth {
            id: "nestweaver".into(),
            name: "NestWeaver".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::NeedsConfig,
            summary: summary.into(),
            fallback_provider_id: Some("local_git".into()),
        }
    }

    pub fn context_from_json(value: &serde_json::Value) -> ContextPack {
        let summary = value
            .get("summary")
            .or_else(|| value.get("context"))
            .or_else(|| value.get("text"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        let source_refs = value
            .get("source_refs")
            .or_else(|| value.get("sources"))
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.as_str()
                            .map(str::to_string)
                            .or_else(|| {
                                item.get("path")
                                    .and_then(|value| value.as_str())
                                    .map(str::to_string)
                            })
                            .or_else(|| {
                                item.get("uid")
                                    .and_then(|value| value.as_str())
                                    .map(str::to_string)
                            })
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| vec!["nestweaver context".into()]);

        ContextPack {
            summary,
            source_refs,
        }
    }

    fn base_command(&self) -> Command {
        let mut command = Command::new(&self.binary_path);
        if let Some(db_path) = &self.db_path {
            command.args(["--db", &db_path.to_string_lossy()]);
        }
        command
    }

    fn run_json(
        &self,
        args: &[String],
        project_root: &Path,
    ) -> Result<serde_json::Value, ProviderError> {
        let mut command = self.base_command();
        command.args(args).arg("--json").current_dir(project_root);
        let output = command
            .output()
            .map_err(|error| ProviderError::CommandFailed(error.to_string()))?;
        if !output.status.success() {
            return Err(ProviderError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ));
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|error| ProviderError::CommandFailed(error.to_string()))
    }
}

impl ContextProvider for NestWeaverCliProvider {
    fn status(&self) -> ProviderHealth {
        if !command_exists(&self.binary_path) {
            return Self::unavailable_health(
                "NestWeaver is not available on this machine yet. Raven will use Local Git context.",
            );
        }
        if self.db_path.is_none() || self.project.is_none() {
            return Self::needs_config_health(
                "NestWeaver was detected, but it needs project configuration before Raven can use it.",
            );
        }
        let args = vec!["daemon".into(), "status".into()];
        self.run_json(&args, Path::new("."))
            .map(|value| Self::health_from_status_json(&value))
            .unwrap_or_else(|_error| {
                Self::unavailable_health(
                    "NestWeaver is unavailable right now. Raven will use Local Git context until it is ready.",
                )
            })
    }

    fn context_pack(&self, project_root: &Path) -> Result<ContextPack, ProviderError> {
        let args = if let Some(project) = &self.project {
            vec![
                "project-context".into(),
                project.clone(),
                "--token-budget".into(),
                self.token_budget.to_string(),
            ]
        } else {
            vec![
                "context".into(),
                "recent project activity".into(),
                "--token-budget".into(),
                self.token_budget.to_string(),
            ]
        };
        self.run_json(&args, project_root)
            .map(|value| Self::context_from_json(&value))
    }
}

pub struct AiChatImportProvider {
    folder_path: PathBuf,
}

impl AiChatImportProvider {
    pub fn new(folder_path: impl AsRef<Path>) -> Self {
        Self {
            folder_path: folder_path.as_ref().to_path_buf(),
        }
    }
}

impl ContextProvider for AiChatImportProvider {
    fn status(&self) -> ProviderHealth {
        ProviderHealth {
            id: "ai_chat_import".into(),
            name: "AI Chat Import Folder".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::Available,
            summary: format!(
                "Imports AI chat exports from {}.",
                self.folder_path.to_string_lossy()
            ),
            fallback_provider_id: Some("local_git".into()),
        }
    }

    fn context_pack(&self, _project_root: &Path) -> Result<ContextPack, ProviderError> {
        let mut entries = fs::read_dir(&self.folder_path)?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .filter(|entry| is_supported_chat_export(&entry.path()))
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.path());

        let mut source_refs = Vec::new();
        let summaries = entries
            .into_iter()
            .take(20)
            .filter_map(|entry| {
                let path = entry.path();
                let content = fs::read_to_string(&path).ok()?;
                source_refs.push(path.to_string_lossy().to_string());
                Some(format!(
                    "- {}: {}",
                    path.file_name()?.to_string_lossy(),
                    summarize_chat_export(&content)
                ))
            })
            .collect::<Vec<_>>();

        let summary = if summaries.is_empty() {
            "No supported AI chat export files found.".into()
        } else {
            format!(
                "Imported {} chat files from configured exports.\n{}",
                summaries.len(),
                summaries.join("\n")
            )
        };

        Ok(ContextPack {
            summary,
            source_refs,
        })
    }
}

pub struct DocumentImportProvider {
    folder_path: PathBuf,
}

impl DocumentImportProvider {
    pub fn new(folder_path: impl AsRef<Path>) -> Self {
        Self {
            folder_path: folder_path.as_ref().to_path_buf(),
        }
    }
}

impl ContextProvider for DocumentImportProvider {
    fn status(&self) -> ProviderHealth {
        let ocr_summary = if ocr_commands_available() {
            "Digital text extraction is available; scanned PDFs can be OCRed with pdftoppm and tesseract."
        } else {
            "Digital text extraction is available; install pdftoppm and tesseract to OCR scanned PDFs."
        };
        ProviderHealth {
            id: "document_import".into(),
            name: "PDF Document Import Folder".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::Available,
            summary: format!(
                "Imports PDF text from {}. {ocr_summary}",
                self.folder_path.to_string_lossy(),
            ),
            fallback_provider_id: Some("local_git".into()),
        }
    }

    fn context_pack(&self, _project_root: &Path) -> Result<ContextPack, ProviderError> {
        let mut entries = fs::read_dir(&self.folder_path)?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .filter(|entry| is_supported_document_import(&entry.path()))
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.path());

        let mut source_refs = Vec::new();
        let summaries = entries
            .into_iter()
            .take(20)
            .filter_map(|entry| {
                let path = entry.path();
                let (text, mode) = extract_pdf_text_with_fallback(&path).ok()?;
                let normalized_text = normalize_extracted_text(&text);
                if normalized_text.is_empty() {
                    return None;
                }
                source_refs.push(format!("{}#page=1", path.to_string_lossy()));
                let mode_label = match mode {
                    PdfExtractionMode::Digital => "digital text",
                    PdfExtractionMode::Ocr => "OCR",
                };
                Some(format!(
                    "- {} ({mode_label}): {}",
                    path.file_name()?.to_string_lossy(),
                    summarize_document_text(&normalized_text)
                ))
            })
            .collect::<Vec<_>>();

        let summary = if summaries.is_empty() {
            if ocr_commands_available() {
                "No readable PDF documents found after digital extraction and OCR.".into()
            } else {
                "No readable digital PDF documents found. Install pdftoppm and tesseract to OCR scanned PDFs.".into()
            }
        } else {
            format!(
                "Imported {} PDF {} from configured folder.\n{}",
                summaries.len(),
                if summaries.len() == 1 {
                    "document"
                } else {
                    "documents"
                },
                summaries.join("\n")
            )
        };

        Ok(ContextPack {
            summary,
            source_refs,
        })
    }
}

pub struct GitHubContextProvider {
    repo_slug: String,
    token: Option<String>,
    api_base_url: String,
}

impl GitHubContextProvider {
    pub fn new(repo_slug: impl Into<String>, token: Option<String>) -> Self {
        Self {
            repo_slug: repo_slug.into(),
            token,
            api_base_url: std::env::var("RAVEN_GITHUB_API_BASE")
                .unwrap_or_else(|_| "https://api.github.com".into()),
        }
    }

    #[cfg(test)]
    pub fn with_api_base(
        repo_slug: impl Into<String>,
        token: Option<String>,
        api_base_url: impl Into<String>,
    ) -> Self {
        Self {
            repo_slug: repo_slug.into(),
            token,
            api_base_url: api_base_url.into(),
        }
    }

    pub fn from_api_payloads(
        repo_slug: &str,
        pulls: &serde_json::Value,
        issues: &serde_json::Value,
    ) -> Result<ContextPack, ProviderError> {
        let mut source_refs = Vec::new();
        let mut rows = Vec::new();

        for pull in pulls.as_array().cloned().unwrap_or_default().iter().take(8) {
            let number = pull
                .get("number")
                .and_then(|value| value.as_i64())
                .unwrap_or_default();
            let state = pull
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let title = pull
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("Untitled PR");
            let url = pull
                .get("html_url")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if !url.is_empty() {
                source_refs.push(url.to_string());
            }
            rows.push(format!("- PR #{number} {state}: {title}"));
        }

        for issue in issues
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .take(8)
        {
            if issue.get("pull_request").is_some() {
                continue;
            }
            let number = issue
                .get("number")
                .and_then(|value| value.as_i64())
                .unwrap_or_default();
            let state = issue
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let title = issue
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("Untitled issue");
            let url = issue
                .get("html_url")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if !url.is_empty() {
                source_refs.push(url.to_string());
            }
            rows.push(format!("- Issue #{number} {state}: {title}"));
        }

        let summary = if rows.is_empty() {
            format!(
                "Imported GitHub context for {repo_slug}.\nNo open pull requests or issues found."
            )
        } else {
            format!(
                "Imported GitHub context for {repo_slug}.\n{}",
                rows.join("\n")
            )
        };

        Ok(ContextPack {
            summary,
            source_refs,
        })
    }

    fn fetch_json(&self, path: &str) -> Result<serde_json::Value, ProviderError> {
        let token = self.token.as_deref().ok_or(ProviderError::Unavailable)?;
        let (owner, repo) = self
            .repo_slug
            .split_once('/')
            .ok_or_else(|| ProviderError::GitHubApi("repo slug must be owner/repo".into()))?;
        let url = format!(
            "{}/repos/{owner}/{repo}/{path}",
            self.api_base_url.trim_end_matches('/')
        );
        ureq::get(&url)
            .set("Accept", "application/vnd.github+json")
            .set("Authorization", &format!("Bearer {token}"))
            .set("User-Agent", "Raven local workflow app")
            .set("X-GitHub-Api-Version", "2022-11-28")
            .call()
            .map_err(|error| ProviderError::GitHubApi(error.to_string()))?
            .into_json()
            .map_err(|error| ProviderError::GitHubApi(error.to_string()))
    }
}

impl ContextProvider for GitHubContextProvider {
    fn status(&self) -> ProviderHealth {
        ProviderHealth {
            id: "github".into(),
            name: "GitHub".into(),
            kind: ProviderKind::Context,
            status: if self.token.is_some() {
                ProviderStatus::Available
            } else {
                ProviderStatus::NeedsConfig
            },
            summary: format!(
                "Reads pull request and issue context for {}.",
                self.repo_slug
            ),
            fallback_provider_id: Some("local_git".into()),
        }
    }

    fn context_pack(&self, _project_root: &Path) -> Result<ContextPack, ProviderError> {
        let pulls = self.fetch_json("pulls?state=open&per_page=8")?;
        let issues = self.fetch_json("issues?state=open&per_page=8")?;
        Self::from_api_payloads(&self.repo_slug, &pulls, &issues)
    }
}

pub fn registry_health() -> Vec<ProviderHealth> {
    let openai = OpenAiProvider::development_default();
    let _structured_output_contract =
        openai.structured_artifact_envelope("Health Check", "# Health Check");
    let openai_status = if openai.credential_ref.starts_with("missing:") {
        ProviderStatus::NeedsConfig
    } else {
        ProviderStatus::Available
    };

    vec![
        ProviderHealth {
            id: "openai".into(),
            name: "OpenAI".into(),
            kind: ProviderKind::Llm,
            status: openai_status,
            summary: format!(
                "OpenAI-first provider is registered with model {} and effort {}. It uses credential references or OPENAI_API_KEY in development.",
                openai.model, openai.effort
            ),
            fallback_provider_id: None,
        },
        LocalGitProvider.status(),
        NestWeaverProvider.status(),
        ProviderHealth {
            id: "local_app".into(),
            name: "Local App Store".into(),
            kind: ProviderKind::ArtifactDestination,
            status: ProviderStatus::Available,
            summary: "Writes Markdown content and JSON metadata to local app storage.".into(),
            fallback_provider_id: None,
        },
        ProviderHealth {
            id: "markdown_folder".into(),
            name: "Markdown Folder".into(),
            kind: ProviderKind::ArtifactDestination,
            status: ProviderStatus::NeedsConfig,
            summary: "Exports Markdown artifacts to a user-selected folder when configured.".into(),
            fallback_provider_id: Some("local_app".into()),
        },
        ProviderHealth {
            id: "obsidian_vault".into(),
            name: "Obsidian Vault".into(),
            kind: ProviderKind::ArtifactDestination,
            status: ProviderStatus::NeedsConfig,
            summary: "Writes Markdown artifacts with frontmatter into a configured Obsidian vault.".into(),
            fallback_provider_id: Some("markdown_folder".into()),
        },
        ProviderHealth {
            id: "ai_chat_import".into(),
            name: "AI Chat Import Folder".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::NeedsConfig,
            summary: "Imports supported local AI chat exports from a configured folder.".into(),
            fallback_provider_id: Some("local_git".into()),
        },
        ProviderHealth {
            id: "document_import".into(),
            name: "PDF Document Import Folder".into(),
            kind: ProviderKind::Context,
            status: ProviderStatus::NeedsConfig,
            summary: "Imports digital PDF text and OCRs scanned PDFs when pdftoppm and tesseract are installed.".into(),
            fallback_provider_id: Some("local_git".into()),
        },
        ProviderHealth {
            id: "github".into(),
            name: "GitHub".into(),
            kind: ProviderKind::Context,
            status: github_status(),
            summary: "P1 context provider for PR and issue context when a GitHub token reference is configured.".into(),
            fallback_provider_id: Some("local_git".into()),
        },
    ]
}

pub fn nestweaver_health_check() -> ProviderHealth {
    NestWeaverProvider.status()
}

fn github_status() -> ProviderStatus {
    if std::env::var_os("GITHUB_TOKEN").is_some() {
        ProviderStatus::Available
    } else {
        ProviderStatus::NeedsConfig
    }
}

pub struct OpenAiProvider {
    pub credential_ref: String,
    pub model: String,
    pub effort: String,
}

impl OpenAiProvider {
    pub fn development_default() -> Self {
        let credential_ref = if std::env::var("OPENAI_API_KEY").is_ok() {
            "env:OPENAI_API_KEY"
        } else {
            "missing:OPENAI_API_KEY"
        };

        Self {
            credential_ref: credential_ref.into(),
            model: "gpt-4.1".into(),
            effort: "medium".into(),
        }
    }

    pub fn structured_artifact_envelope(&self, title: &str, markdown: &str) -> serde_json::Value {
        serde_json::json!({
            "schema_version": "0.1.0",
            "title": title,
            "content_markdown": markdown,
            "metadata": {
                "provider": "openai",
                "credential_ref": self.credential_ref,
                "model": self.model,
                "effort": self.effort,
                "structured_outputs": true
            }
        })
    }
}

fn empty_as_none(value: &str) -> &str {
    if value.is_empty() {
        "none"
    } else {
        value
    }
}

fn is_supported_chat_export(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("json" | "md" | "markdown" | "txt")
    )
}

fn is_supported_document_import(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("pdf")
    )
}

fn extract_pdf_text(path: &Path) -> Result<String, ProviderError> {
    pdf_extract::extract_text(path).map_err(|error| ProviderError::PdfExtraction(error.to_string()))
}

fn extract_pdf_text_with_fallback(
    path: &Path,
) -> Result<(String, PdfExtractionMode), ProviderError> {
    if let Ok(text) = extract_pdf_text(path) {
        let normalized = normalize_extracted_text(&text);
        if !normalized.is_empty() {
            return Ok((text, PdfExtractionMode::Digital));
        }
    }

    extract_pdf_text_with_ocr(path).map(|text| (text, PdfExtractionMode::Ocr))
}

fn extract_pdf_text_with_ocr(path: &Path) -> Result<String, ProviderError> {
    if !ocr_commands_available() {
        return Err(ProviderError::PdfExtraction(
            "OCR requires pdftoppm and tesseract on PATH".into(),
        ));
    }

    let temp = tempfile::tempdir()?;
    let image_prefix = temp.path().join("page");
    let output = Command::new("pdftoppm")
        .args(["-r", "150", "-png", "-singlefile"])
        .arg(path)
        .arg(&image_prefix)
        .output()
        .map_err(|error| ProviderError::PdfExtraction(error.to_string()))?;
    if !output.status.success() {
        return Err(ProviderError::PdfExtraction(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }

    let image_path = temp.path().join("page.png");
    let ocr_output = Command::new("tesseract")
        .arg(&image_path)
        .arg("stdout")
        .output()
        .map_err(|error| ProviderError::PdfExtraction(error.to_string()))?;
    if !ocr_output.status.success() {
        return Err(ProviderError::PdfExtraction(
            String::from_utf8_lossy(&ocr_output.stderr)
                .trim()
                .to_string(),
        ));
    }

    Ok(String::from_utf8_lossy(&ocr_output.stdout).to_string())
}

fn ocr_commands_available() -> bool {
    command_exists(Path::new("pdftoppm")) && command_exists(Path::new("tesseract"))
}

fn command_exists(binary_path: &Path) -> bool {
    if binary_path.components().count() > 1 || binary_path.is_absolute() {
        return binary_path.is_file();
    }
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|path| path.join(binary_path).is_file())
    })
}

fn normalize_extracted_text(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn summarize_document_text(content: &str) -> String {
    content
        .split_whitespace()
        .take(40)
        .collect::<Vec<_>>()
        .join(" ")
}

fn summarize_chat_export(content: &str) -> String {
    let parsed_json = serde_json::from_str::<serde_json::Value>(content).ok();
    let title = parsed_json
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            content
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(|line| line.trim_start_matches('#').trim())
        })
        .unwrap_or("Untitled chat export");
    let snippet_source = parsed_json
        .as_ref()
        .and_then(|value| value.get("messages"))
        .and_then(|messages| messages.as_array())
        .and_then(|messages| {
            messages
                .iter()
                .filter_map(|message| message.get("content").and_then(|content| content.as_str()))
                .find(|content| !content.trim().is_empty())
        })
        .unwrap_or(content);
    let snippet = snippet_source
        .split_whitespace()
        .take(24)
        .collect::<Vec<_>>()
        .join(" ");

    format!("{title} - {snippet}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    fn write_executable_script(path: &Path, contents: &str) {
        fs::write(path, contents).unwrap();
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }
    }

    #[test]
    fn nestweaver_reports_fallback_to_local_git() {
        let status = NestWeaverProvider.status();
        assert_eq!(status.status, ProviderStatus::Unavailable);
        assert_eq!(status.fallback_provider_id.as_deref(), Some("local_git"));
    }

    #[test]
    fn nestweaver_cli_health_parses_daemon_status_json() {
        let health = NestWeaverCliProvider::health_from_status_json(&serde_json::json!({
            "version": "0.1.0",
            "db_path": "/tmp/nestweaver.lbug"
        }));

        assert_eq!(health.status, ProviderStatus::Available);
        assert!(health.summary.contains("0.1.0"));
        assert!(health.summary.contains("configured project database"));
        assert_eq!(health.fallback_provider_id.as_deref(), Some("local_git"));
    }

    #[test]
    fn nestweaver_cli_context_parses_context_json_sources() {
        let pack = NestWeaverCliProvider::context_from_json(&serde_json::json!({
            "summary": "Runtime depends on provider contracts.",
            "source_refs": [
                { "path": "src-tauri/src/runtime.rs" },
                { "uid": "symbol:ProviderRegistry" }
            ]
        }));

        assert!(pack.summary.contains("Runtime depends"));
        assert_eq!(
            pack.source_refs,
            vec![
                "src-tauri/src/runtime.rs".to_string(),
                "symbol:ProviderRegistry".to_string()
            ]
        );
    }

    #[test]
    fn nestweaver_cli_missing_binary_reports_unavailable() {
        let health = NestWeaverCliProvider::new(
            "missing-nestweaver-binary-for-tests",
            Some(PathBuf::from("configured.nestweaver")),
            Some("raven".into()),
            4000,
        )
        .status();

        assert_eq!(health.status, ProviderStatus::Unavailable);
        assert!(
            health.summary.contains("not available"),
            "unexpected summary: {}",
            health.summary
        );
        assert_eq!(health.fallback_provider_id.as_deref(), Some("local_git"));
    }

    #[test]
    fn nestweaver_cli_detected_without_project_configuration_needs_config() {
        let dir = tempdir().unwrap();
        let binary_path = dir.path().join("nestweaver");
        write_executable_script(
            &binary_path,
            "#!/bin/sh\nprintf '{\"version\":\"0.1.0\",\"db_path\":\"ignored\"}'\n",
        );

        let health = NestWeaverCliProvider::new(
            &binary_path,
            Some(dir.path().join("configured.nestweaver")),
            None::<String>,
            4000,
        )
        .status();

        assert_eq!(health.status, ProviderStatus::NeedsConfig);
        assert!(
            health.summary.contains("needs project configuration"),
            "unexpected summary: {}",
            health.summary
        );
        assert_eq!(health.fallback_provider_id.as_deref(), Some("local_git"));
    }

    #[test]
    fn nestweaver_cli_configured_provider_reports_available() {
        let dir = tempdir().unwrap();
        let binary_path = dir.path().join("nestweaver");
        write_executable_script(
            &binary_path,
            "#!/bin/sh\nif [ \"$1\" = \"--db\" ]; then shift 2; fi\nif [ \"$1\" = \"daemon\" ] && [ \"$2\" = \"status\" ]; then printf '{\"version\":\"0.1.0\",\"db_path\":\"/tmp/hidden.nestweaver\"}'; exit 0; fi\nprintf 'unexpected args' >&2\nexit 1\n",
        );

        let health = NestWeaverCliProvider::new(
            &binary_path,
            Some(dir.path().join("configured.nestweaver")),
            Some("raven".into()),
            4000,
        )
        .status();

        assert_eq!(health.status, ProviderStatus::Available);
        assert!(health.summary.contains("0.1.0"));
        assert!(!health.summary.contains("/tmp/hidden.nestweaver"));
        assert_eq!(health.fallback_provider_id.as_deref(), Some("local_git"));
    }

    #[test]
    fn local_git_reads_fixture_repo() {
        let dir = tempdir().unwrap();
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap();
        fs::write(dir.path().join("note.md"), "hello").unwrap();

        let pack = LocalGitProvider.context_pack(dir.path()).unwrap();
        assert!(pack.summary.contains("note.md"));
        assert!(pack.source_refs.contains(&"local git status".into()));
    }

    #[test]
    fn openai_provider_never_uses_raw_key_as_credential_ref() {
        let provider = OpenAiProvider::development_default();
        assert!(!provider.credential_ref.starts_with("sk-"));
    }

    #[test]
    fn ai_chat_import_provider_reads_supported_chat_exports() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("claude-export.md"),
            "# Claude Session\n\nDiscussed Daily Work Journal permissions.",
        )
        .unwrap();
        fs::write(
            dir.path().join("chatgpt-export.json"),
            r#"{"title":"Morning Brief","messages":[{"role":"user","content":"Summarize commits"}]}"#,
        )
        .unwrap();
        fs::write(dir.path().join("ignored.png"), "not text").unwrap();

        let pack = AiChatImportProvider::new(dir.path())
            .context_pack(Path::new("."))
            .unwrap();

        assert!(pack.summary.contains("Claude Session"));
        assert!(pack.summary.contains("Morning Brief"));
        assert_eq!(pack.source_refs.len(), 2);
        assert!(pack
            .source_refs
            .iter()
            .any(|reference| reference.ends_with("claude-export.md")));
        assert!(pack
            .source_refs
            .iter()
            .any(|reference| reference.ends_with("chatgpt-export.json")));
    }

    #[test]
    fn document_import_provider_extracts_text_from_digital_pdfs() {
        let dir = tempdir().unwrap();
        write_minimal_pdf(
            &dir.path().join("raven-research.pdf"),
            "Raven PDF Workflow Research",
        );
        fs::write(dir.path().join("notes.txt"), "not part of PDF provider").unwrap();

        let pack = DocumentImportProvider::new(dir.path())
            .context_pack(Path::new("."))
            .unwrap();

        assert!(pack.summary.contains("Raven PDF Workflow Research"));
        assert_eq!(pack.source_refs.len(), 1);
        assert!(pack.source_refs[0].ends_with("raven-research.pdf#page=1"));
    }

    #[test]
    fn document_import_provider_status_reports_ocr_tool_availability() {
        let dir = tempdir().unwrap();
        let health = DocumentImportProvider::new(dir.path()).status();

        assert_eq!(health.status, ProviderStatus::Available);
        assert!(health.summary.contains("pdftoppm"));
        assert!(health.summary.contains("tesseract"));
        assert!(
            health.summary.contains("scanned PDFs can be OCRed")
                || health.summary.contains("install pdftoppm and tesseract"),
            "expected OCR availability or installation guidance, got {:?}",
            health.summary
        );
    }

    #[test]
    fn pdf_extraction_reports_digital_mode_before_ocr() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("digital.pdf");
        write_minimal_pdf(&path, "Digital PDF text wins");

        let (text, mode) = extract_pdf_text_with_fallback(&path).unwrap();

        assert_eq!(mode, PdfExtractionMode::Digital);
        assert!(text.contains("Digital PDF text wins"));
    }

    #[test]
    fn pdf_extraction_uses_ocr_for_scanned_pdf_when_commands_are_available() {
        if !ocr_commands_available() {
            eprintln!("skipping OCR test: pdftoppm and tesseract are not both installed");
            return;
        }
        let dir = tempdir().unwrap();
        let path = dir.path().join("scanned.pdf");
        write_scanned_text_pdf(&path, "OCR TEST");

        let (text, mode) = extract_pdf_text_with_fallback(&path).unwrap();
        let normalized = normalize_extracted_text(&text).to_ascii_uppercase();

        assert_eq!(mode, PdfExtractionMode::Ocr);
        assert!(
            normalized.contains("OCR") || normalized.contains("TEST"),
            "expected OCR output to include generated text, got {normalized:?}"
        );
    }

    #[test]
    fn github_context_provider_summarizes_pull_requests_and_issues() {
        let pulls = serde_json::json!([
            {
                "number": 12,
                "title": "Add workflow runtime",
                "state": "open",
                "html_url": "https://github.com/example-user/example-repo/pull/12",
                "user": { "login": "example-user" }
            }
        ]);
        let issues = serde_json::json!([
            {
                "number": 7,
                "title": "Support morning brief schedule",
                "state": "open",
                "html_url": "https://github.com/example-user/example-repo/issues/7",
                "user": { "login": "example-user" }
            }
        ]);

        let pack =
            GitHubContextProvider::from_api_payloads("example-user/example-repo", &pulls, &issues)
                .unwrap();

        assert!(pack.summary.contains("PR #12"));
        assert!(pack.summary.contains("Issue #7"));
        assert!(pack.summary.contains("Add workflow runtime"));
        assert!(pack.summary.contains("Support morning brief schedule"));
        assert_eq!(pack.source_refs.len(), 2);
        assert!(pack
            .source_refs
            .contains(&"https://github.com/example-user/example-repo/pull/12".into()));
        assert!(pack
            .source_refs
            .contains(&"https://github.com/example-user/example-repo/issues/7".into()));
    }

    #[test]
    fn github_context_provider_accepts_test_api_base() {
        let provider = GitHubContextProvider::with_api_base(
            "example-user/example-repo",
            Some("placeholder-token".into()),
            "http://127.0.0.1:9",
        );

        assert_eq!(provider.api_base_url, "http://127.0.0.1:9");
        assert_eq!(provider.status().status, ProviderStatus::Available);
    }

    #[test]
    fn open_meteo_weather_provider_parses_current_weather() {
        let payload = serde_json::json!({
            "latitude": 39.75,
            "longitude": -104.99,
            "timezone": "America/Denver",
            "current": {
                "time": "2026-06-08T17:30",
                "temperature_2m": 74.2,
                "relative_humidity_2m": 31,
                "apparent_temperature": 72.8,
                "precipitation": 0.0,
                "weather_code": 1,
                "wind_speed_10m": 9.4
            },
            "current_units": {
                "temperature_2m": "°F",
                "relative_humidity_2m": "%",
                "apparent_temperature": "°F",
                "precipitation": "inch",
                "wind_speed_10m": "mph"
            }
        });

        let snapshot =
            OpenMeteoWeatherProvider::snapshot_from_json("Denver, CO", &payload).unwrap();

        assert_eq!(snapshot.location, "Denver, CO");
        assert_eq!(snapshot.temperature, 74.2);
        assert_eq!(snapshot.temperature_unit, "°F");
        assert_eq!(snapshot.condition, "Mainly clear");
        assert_eq!(snapshot.humidity_percent, 31);
        assert_eq!(snapshot.source_refs, vec!["open-meteo:39.75,-104.99"]);
    }

    fn write_minimal_pdf(path: &Path, text: &str) {
        let escaped_text = text
            .replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)");
        let objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
            format!(
                "<< /Length {} >>\nstream\nBT /F1 18 Tf 72 720 Td ({escaped_text}) Tj ET\nendstream",
                format!("BT /F1 18 Tf 72 720 Td ({escaped_text}) Tj ET").len()
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut pdf = "%PDF-1.4\n".to_string();
        let mut offsets = vec![0usize];
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n", index + 1, object));
        }
        let xref_offset = pdf.len();
        pdf.push_str("xref\n0 6\n0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!(
            "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n"
        ));
        fs::write(path, pdf).unwrap();
    }

    fn write_scanned_text_pdf(path: &Path, text: &str) {
        let scale = 18usize;
        let glyphs = text.chars().map(glyph_rows).collect::<Vec<[[u8; 5]; 7]>>();
        let glyph_width = 6usize;
        let margin = 4usize;
        let width = (text.chars().count() * glyph_width + margin * 2) * scale;
        let height = (7 + margin * 2) * scale;
        let mut pixels = vec![255u8; width * height];

        for (glyph_index, glyph) in glyphs.iter().enumerate() {
            let base_x = (margin + glyph_index * glyph_width) * scale;
            let base_y = margin * scale;
            for (row_index, row) in glyph.iter().enumerate() {
                for (col_index, value) in row.iter().enumerate() {
                    if *value == 0 {
                        continue;
                    }
                    for y in 0..scale {
                        for x in 0..scale {
                            let px = base_x + col_index * scale + x;
                            let py = base_y + row_index * scale + y;
                            pixels[py * width + px] = 0;
                        }
                    }
                }
            }
        }

        let content = format!("q {width} 0 0 {height} 72 500 cm /Im1 Do Q");
        let objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"
            )
            .into_bytes(),
            [
                format!(
                    "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length {} >>\nstream\n",
                    pixels.len()
                )
                .into_bytes(),
                pixels,
                b"\nendstream".to_vec(),
            ]
            .concat(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len())
                .into_bytes(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0usize];
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            pdf.extend_from_slice(object);
            pdf.extend_from_slice(b"\nendobj\n");
        }
        let xref_offset = pdf.len();
        pdf.extend_from_slice(b"xref\n0 6\n0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n")
                .as_bytes(),
        );
        fs::write(path, pdf).unwrap();
    }

    fn glyph_rows(character: char) -> [[u8; 5]; 7] {
        match character.to_ascii_uppercase() {
            'C' => rows([
                "11111", "10000", "10000", "10000", "10000", "10000", "11111",
            ]),
            'E' => rows([
                "11111", "10000", "10000", "11110", "10000", "10000", "11111",
            ]),
            'O' => rows([
                "01110", "10001", "10001", "10001", "10001", "10001", "01110",
            ]),
            'R' => rows([
                "11110", "10001", "10001", "11110", "10100", "10010", "10001",
            ]),
            'S' => rows([
                "11111", "10000", "10000", "11110", "00001", "00001", "11110",
            ]),
            'T' => rows([
                "11111", "00100", "00100", "00100", "00100", "00100", "00100",
            ]),
            _ => rows([
                "00000", "00000", "00000", "00000", "00000", "00000", "00000",
            ]),
        }
    }

    fn rows(pattern: [&str; 7]) -> [[u8; 5]; 7] {
        let mut rows = [[0u8; 5]; 7];
        for (row_index, row) in pattern.iter().enumerate() {
            for (col_index, value) in row.bytes().enumerate().take(5) {
                rows[row_index][col_index] = u8::from(value == b'1');
            }
        }
        rows
    }
}
