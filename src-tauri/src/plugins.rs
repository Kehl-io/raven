use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginStepDefinition {
    pub kind: String,
    pub provider: String,
    pub action: String,
    pub display_name: String,
    pub permissions: Vec<String>,
    #[serde(default)]
    pub input_schema: serde_json::Value,
    #[serde(default)]
    pub output_schema: serde_json::Value,
    pub execution: PluginExecutionConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginExecutionConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub steps: Vec<PluginStepDefinition>,
    #[serde(skip)]
    pub plugin_dir: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum PluginManifestError {
    #[error("plugin manifest is unreadable: {0}")]
    Io(#[from] std::io::Error),
    #[error("plugin manifest JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Validation(String),
}

static APP_DATA_PLUGINS_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn set_app_data_plugins_dir(path: PathBuf) {
    let _ = APP_DATA_PLUGINS_DIR.set(path);
}

pub fn plugins_dir() -> PathBuf {
    let env_override = std::env::var("RAVEN_PLUGIN_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let app_data_dir = APP_DATA_PLUGINS_DIR
        .get()
        .cloned()
        .unwrap_or_else(default_app_data_dir);
    let home_dir = std::env::var("HOME").ok().map(PathBuf::from);
    resolve_plugins_dir(env_override, &app_data_dir, home_dir.as_deref())
}

fn resolve_plugins_dir(
    env_override: Option<PathBuf>,
    app_data_dir: &Path,
    _legacy_home_dir: Option<&Path>,
) -> PathBuf {
    env_override.unwrap_or_else(|| app_data_dir.join("plugins"))
}

fn default_app_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        return std::env::var("HOME")
            .map(|home| {
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("Raven")
            })
            .unwrap_or_else(|_| PathBuf::from(".").join(".raven"));
    }

    #[cfg(target_os = "windows")]
    {
        return std::env::var("APPDATA")
            .map(|app_data| PathBuf::from(app_data).join("Raven"))
            .unwrap_or_else(|_| PathBuf::from(".").join(".raven"));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(xdg_data_home) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(xdg_data_home).join("raven");
        }
        std::env::var("HOME")
            .map(|home| {
                PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .join("raven")
            })
            .unwrap_or_else(|_| PathBuf::from(".").join(".raven"))
    }
}

pub fn load_plugin_manifest(plugin_dir: &Path) -> Result<PluginManifest, PluginManifestError> {
    let content = std::fs::read_to_string(plugin_dir.join("manifest.json"))?;
    let manifest = serde_json::from_str::<PluginManifest>(&content)?;
    validate_plugin_manifest(manifest, plugin_dir)
}

pub fn validate_plugin_manifest(
    mut manifest: PluginManifest,
    plugin_dir: &Path,
) -> Result<PluginManifest, PluginManifestError> {
    let mut errors = Vec::new();
    if !is_identifier(&manifest.id) {
        errors.push(
            "Plugin id must be 1-64 lowercase letters, numbers, hyphens, or underscores."
                .to_string(),
        );
    }
    if manifest.name.trim().is_empty() || manifest.name.len() > 120 {
        errors.push("Plugin name must be non-empty and at most 120 characters.".to_string());
    }
    if manifest.version.trim().is_empty() || manifest.version.len() > 64 {
        errors.push("Plugin version must be non-empty and at most 64 characters.".to_string());
    }
    if manifest.steps.is_empty() {
        errors.push("Plugin must declare at least one executable step.".to_string());
    }

    let mut seen = std::collections::HashSet::new();
    for (index, step) in manifest.steps.iter().enumerate() {
        if step.kind != "provider_action" {
            errors.push(format!("Step {index} kind must be provider_action."));
        }
        if step.provider != manifest.id {
            errors.push(format!(
                "Step {index} provider must match plugin id {}.",
                manifest.id
            ));
        }
        if !is_identifier(&step.provider) {
            errors.push(format!("Step {index} provider is invalid."));
        }
        if !is_identifier(&step.action) {
            errors.push(format!("Step {index} action is invalid."));
        }
        if !seen.insert((step.provider.clone(), step.action.clone())) {
            errors.push(format!(
                "Step {index} duplicates provider/action {}.{}.",
                step.provider, step.action
            ));
        }
        if step.display_name.trim().is_empty() || step.display_name.len() > 120 {
            errors.push(format!(
                "Step {index} display_name must be non-empty and at most 120 characters."
            ));
        }
        if step.permissions.is_empty() {
            errors.push(format!(
                "Step {index} must declare at least one permission."
            ));
        }
        for permission in &step.permissions {
            if !is_permission(permission) {
                errors.push(format!("Step {index} permission {permission} is invalid."));
            }
        }
        validate_schema(&step.input_schema, index, "input_schema", &mut errors);
        validate_schema(&step.output_schema, index, "output_schema", &mut errors);
        validate_execution(plugin_dir, index, &step.execution, &mut errors);
    }

    if !errors.is_empty() {
        return Err(PluginManifestError::Validation(errors.join(" ")));
    }
    manifest.plugin_dir = Some(plugin_dir.to_path_buf());
    Ok(manifest)
}

pub fn discover_plugins_in_dir(dir: &Path) -> Vec<PluginManifest> {
    if !dir.exists() {
        return vec![];
    }

    let mut plugins = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("manifest.json").exists() {
                if let Ok(manifest) = load_plugin_manifest(&path) {
                    plugins.push(manifest);
                }
            }
        }
    }
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    plugins
}

pub fn plugin_step<'a>(
    plugins: &'a [PluginManifest],
    provider: &str,
    action: &str,
) -> Option<&'a PluginStepDefinition> {
    plugins
        .iter()
        .flat_map(|plugin| plugin.steps.iter())
        .find(|step| step.provider == provider && step.action == action)
}

pub fn plugin_for_step<'a>(
    plugins: &'a [PluginManifest],
    provider: &str,
    action: &str,
) -> Option<(&'a PluginManifest, &'a PluginStepDefinition)> {
    plugins.iter().find_map(|plugin| {
        plugin
            .steps
            .iter()
            .find(|step| step.provider == provider && step.action == action)
            .map(|step| (plugin, step))
    })
}

fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn is_permission(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == ':' || c == '-' || c == '_'
        })
}

fn validate_schema(
    schema: &serde_json::Value,
    index: usize,
    field: &str,
    errors: &mut Vec<String>,
) {
    if schema.is_null() {
        return;
    }
    if !schema.is_object() {
        errors.push(format!("Step {index} {field} must be a JSON object."));
        return;
    }
    if schema
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value != "object")
    {
        errors.push(format!(
            "Step {index} {field}.type must be object when present."
        ));
    }
}

fn validate_execution(
    plugin_dir: &Path,
    index: usize,
    execution: &PluginExecutionConfig,
    errors: &mut Vec<String>,
) {
    let command_path = Path::new(&execution.command);
    if execution.command.trim().is_empty()
        || command_path.is_absolute()
        || command_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        errors.push(format!(
            "Step {index} execution.command must be a relative plugin-local path."
        ));
    } else if let Ok(plugin_root) = plugin_dir.canonicalize() {
        let candidate = plugin_dir.join(command_path);
        match candidate.canonicalize() {
            Ok(canonical)
                if canonical.starts_with(&plugin_root) && is_executable_file(&canonical) => {}
            _ => errors.push(format!(
                "Step {index} execution.command must resolve to an executable plugin-local file."
            )),
        }
    }

    if execution.args.len() > 16 {
        errors.push(format!(
            "Step {index} execution.args cannot contain more than 16 items."
        ));
    }
    for arg in &execution.args {
        if arg.len() > 256 || arg.contains('\0') {
            errors.push(format!(
                "Step {index} execution.args contains an invalid argument."
            ));
        }
    }
    if execution.env.len() > 16 {
        errors.push(format!(
            "Step {index} execution.env cannot contain more than 16 entries."
        ));
    }
    for (key, value) in &execution.env {
        if key.is_empty()
            || key.len() > 64
            || value.len() > 512
            || key.contains('\0')
            || value.contains('\0')
            || !key
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            errors.push(format!(
                "Step {index} execution.env contains an invalid entry."
            ));
        }
    }
    if let Some(timeout_ms) = execution.timeout_ms {
        if !(1_000..=30_000).contains(&timeout_ms) {
            errors.push(format!(
                "Step {index} execution.timeout_ms must be 1000-30000."
            ));
        }
    }
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.is_file()
        && std::fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

pub fn discover_plugins() -> Vec<PluginManifest> {
    discover_plugins_in_dir(&plugins_dir())
}

#[allow(dead_code)]
fn legacy_plugins_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".raven")
        .join("plugins")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_manifest_with_executable_step_contract() {
        let fixture_dir = std::env::current_dir()
            .unwrap()
            .join("tests")
            .join("fixtures")
            .join("plugins")
            .join("deterministic-artifact-plugin");
        let manifest = load_plugin_manifest(&fixture_dir).unwrap();

        assert_eq!(manifest.id, "deterministic_artifact");
        assert_eq!(manifest.steps.len(), 1);
        assert_eq!(manifest.steps[0].provider, "deterministic_artifact");
        assert_eq!(manifest.steps[0].action, "build_artifact");
        assert_eq!(manifest.steps[0].permissions, vec!["plugin:execute"]);
    }

    #[test]
    fn rejects_manifest_with_unsafe_execution_command() {
        let manifest = serde_json::json!({
            "id": "unsafe_plugin",
            "name": "Unsafe Plugin",
            "version": "0.1.0",
            "steps": [{
                "kind": "provider_action",
                "provider": "unsafe_plugin",
                "action": "run",
                "display_name": "Run",
                "permissions": ["plugin:execute"],
                "input_schema": { "type": "object" },
                "output_schema": { "type": "object" },
                "execution": {
                    "command": "/bin/sh",
                    "args": ["-c", "echo unsafe"]
                }
            }]
        });

        let error = validate_plugin_manifest(
            serde_json::from_value(manifest).unwrap(),
            &PathBuf::from("/tmp/unsafe-plugin"),
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("execution.command must be a relative plugin-local path"));
    }

    #[test]
    #[cfg(unix)]
    fn rejects_manifest_with_non_executable_command_file() {
        use std::os::unix::fs::PermissionsExt;

        let plugin_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(plugin_dir.path().join("bin")).unwrap();
        let command = plugin_dir.path().join("bin").join("plugin");
        std::fs::write(&command, "#!/bin/sh\necho {}\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o644)).unwrap();

        let manifest = serde_json::json!({
            "id": "safe_plugin",
            "name": "Safe Plugin",
            "version": "0.1.0",
            "steps": [{
                "kind": "provider_action",
                "provider": "safe_plugin",
                "action": "run",
                "display_name": "Run",
                "permissions": ["plugin:execute"],
                "input_schema": { "type": "object" },
                "output_schema": { "type": "object" },
                "execution": {
                    "command": "bin/plugin"
                }
            }]
        });

        let error =
            validate_plugin_manifest(serde_json::from_value(manifest).unwrap(), plugin_dir.path())
                .unwrap_err()
                .to_string();

        assert!(error.contains("execution.command must resolve to an executable plugin-local file"));
    }

    #[test]
    fn default_plugins_dir_is_scoped_under_app_data_not_legacy_home() {
        let app_data_dir = PathBuf::from("/tmp/raven-app-data");
        let legacy_home = PathBuf::from("/tmp/raven-home");

        let resolved = resolve_plugins_dir(None, &app_data_dir, Some(&legacy_home));

        assert_eq!(resolved, app_data_dir.join("plugins"));
        assert_ne!(resolved, legacy_home.join(".raven").join("plugins"));
    }

    #[test]
    fn plugins_dir_keeps_env_override_for_tests() {
        let override_dir = PathBuf::from("/tmp/raven-test-plugins");
        let app_data_dir = PathBuf::from("/tmp/raven-app-data");

        assert_eq!(
            resolve_plugins_dir(Some(override_dir.clone()), &app_data_dir, None),
            override_dir
        );
    }

    #[test]
    fn app_data_override_is_root_not_plugins_leaf() {
        let app_data_dir = PathBuf::from("/tmp/raven-app-data");

        assert_eq!(
            resolve_plugins_dir(None, &app_data_dir, None),
            app_data_dir.join("plugins")
        );
    }
}
