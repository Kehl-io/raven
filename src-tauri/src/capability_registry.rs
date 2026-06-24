use crate::models::{
    CapabilityAdapter, CapabilityAvailability, CapabilityDefaultApproval, CapabilityDescriptor,
    CapabilitySource, CapabilityTrustTier,
};
use serde::{Deserialize, Serialize};

const FNV1A_64_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV1A_64_PRIME: u64 = 0x100000001b3;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CapabilityRegistrySnapshot {
    pub hash: String,
    pub generated_at: String,
    pub capabilities: Vec<CapabilityDescriptor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub policy_decisions: Vec<crate::autonomy::CapabilityPolicyDecision>,
}

pub fn builtin_registry_snapshot() -> CapabilityRegistrySnapshot {
    let mut capabilities = crate::capabilities::capability_catalog()
        .into_iter()
        .map(descriptor_from_static_capability)
        .collect::<Vec<_>>();
    capabilities.push(legacy_openai_generate_artifact_descriptor());
    capabilities.sort_by(|left, right| left.id.cmp(&right.id));
    let generated_at = chrono::Utc::now().to_rfc3339();
    let hash = registry_hash(&capabilities);
    CapabilityRegistrySnapshot {
        hash,
        generated_at,
        capabilities,
        policy_decisions: vec![],
    }
}

pub fn registry_snapshot_with_raw_tools(
    raw_tools: &[crate::models::RawToolInventoryItem],
) -> CapabilityRegistrySnapshot {
    let mut capabilities = builtin_registry_snapshot().capabilities;
    capabilities.extend(map_raw_tools_to_capabilities(raw_tools));
    capabilities.sort_by(|left, right| left.id.cmp(&right.id));
    capabilities.dedup_by(|left, right| left.id == right.id);
    let hash = registry_hash(&capabilities);
    CapabilityRegistrySnapshot {
        hash,
        generated_at: chrono::Utc::now().to_rfc3339(),
        capabilities,
        policy_decisions: vec![],
    }
}

pub fn map_raw_tools_to_capabilities(
    raw_tools: &[crate::models::RawToolInventoryItem],
) -> Vec<CapabilityDescriptor> {
    raw_tools
        .iter()
        .flat_map(raw_tool_capabilities)
        .collect::<Vec<_>>()
}

fn raw_tool_capabilities(
    raw_tool: &crate::models::RawToolInventoryItem,
) -> Vec<CapabilityDescriptor> {
    if raw_tool.source != CapabilitySource::Cli {
        return vec![];
    }
    match raw_tool.id.as_str() {
        "cli.gh" => vec![cli_capability(
            raw_tool,
            "github_context",
            "GitHub Context",
            "Reads GitHub repository, pull request, and issue context through the local GitHub CLI.",
            "source_control",
            crate::capabilities::ExecutionMode::BoundedAgentic,
            false,
            false,
            false,
            true,
            false,
            vec!["github:read", "network:read"],
            vec!["github", "pull_requests", "issues", "repo_context"],
            "Use when GitHub CLI is installed and authenticated for repository context.",
            "Authenticate gh or use the built-in GitHub context provider.",
            CapabilityDefaultApproval::AlwaysReview,
        )],
        "cli.rg" => vec![cli_capability(
            raw_tool,
            "search_workspace",
            "Search Workspace",
            "Searches local workspace text using ripgrep.",
            "local_context",
            crate::capabilities::ExecutionMode::Deterministic,
            true,
            true,
            false,
            false,
            false,
            vec!["workspace:read"],
            vec!["search", "workspace", "text"],
            "Use for bounded local text search before agent synthesis.",
            "Use configured document or repository context providers when available.",
            CapabilityDefaultApproval::Auto,
        )],
        "cli.git" => vec![cli_capability(
            raw_tool,
            "read_context",
            "Read Git Context",
            "Reads local Git metadata and recent repository activity.",
            "local_context",
            crate::capabilities::ExecutionMode::Deterministic,
            true,
            true,
            false,
            false,
            false,
            vec!["git:read", "workspace:read"],
            vec!["git", "repository", "diff", "history"],
            "Use for local repository status, diffs, and commit history.",
            "Use the built-in local Git provider for known workflow shapes.",
            CapabilityDefaultApproval::Auto,
        )],
        "cli.pdftotext" => vec![cli_capability(
            raw_tool,
            "extract_text",
            "Extract PDF Text",
            "Extracts text from local PDF files using pdftotext.",
            "document_import",
            crate::capabilities::ExecutionMode::Deterministic,
            true,
            true,
            false,
            false,
            false,
            vec!["document:read", "workspace:read"],
            vec!["pdf", "document", "text_extraction"],
            "Use for text extraction from digital PDFs.",
            "Use OCR when the PDF is scanned or text extraction fails.",
            CapabilityDefaultApproval::Auto,
        )],
        "cli.pdftoppm" => vec![cli_capability(
            raw_tool,
            "render_pages",
            "Render PDF Pages",
            "Renders local PDF pages to images using pdftoppm.",
            "document_import",
            crate::capabilities::ExecutionMode::Deterministic,
            true,
            true,
            false,
            false,
            true,
            vec!["document:read", "workspace:read", "artifact:write"],
            vec!["pdf", "document", "render"],
            "Use for page rendering before OCR or visual inspection.",
            "Use pdftotext for digital PDFs when images are unnecessary.",
            CapabilityDefaultApproval::AlwaysReview,
        )],
        "cli.pnpm" => vec![cli_capability(
            raw_tool,
            "run_scripts",
            "Run pnpm Scripts",
            "Runs configured package scripts through pnpm.",
            "workspace_automation",
            crate::capabilities::ExecutionMode::BoundedAgentic,
            false,
            false,
            false,
            true,
            true,
            vec!["workspace:read", "workspace:write", "command:run"],
            vec!["javascript", "test", "build", "package_scripts"],
            "Use for project test, lint, and build scripts when explicitly requested.",
            "Prefer dedicated deterministic checks when available.",
            CapabilityDefaultApproval::AlwaysReview,
        )],
        "cli.cargo" => vec![cli_capability(
            raw_tool,
            "run_commands",
            "Run Cargo Commands",
            "Runs Rust project checks, tests, and builds through cargo.",
            "workspace_automation",
            crate::capabilities::ExecutionMode::BoundedAgentic,
            false,
            false,
            false,
            true,
            true,
            vec!["workspace:read", "workspace:write", "command:run"],
            vec!["rust", "test", "build", "cargo"],
            "Use for Rust project test, check, and build commands when explicitly requested.",
            "Prefer targeted deterministic validation for known workflow capabilities.",
            CapabilityDefaultApproval::AlwaysReview,
        )],
        _ => vec![],
    }
}

#[allow(clippy::too_many_arguments)]
fn cli_capability(
    raw_tool: &crate::models::RawToolInventoryItem,
    action: &str,
    display_name: &str,
    description: &str,
    category: &str,
    execution_mode: crate::capabilities::ExecutionMode,
    read_only: bool,
    idempotent: bool,
    destructive: bool,
    open_world: bool,
    writes_files: bool,
    permissions: Vec<&str>,
    intent_tags: Vec<&str>,
    best_for: &str,
    fallback_strategy: &str,
    default_approval: CapabilityDefaultApproval,
) -> CapabilityDescriptor {
    let status = raw_tool_status(raw_tool);
    let command = raw_tool
        .binary_path
        .clone()
        .unwrap_or_else(|| raw_tool.display_name.to_ascii_lowercase());
    let provider = raw_tool.id.trim_start_matches("cli.").replace('.', "_");
    let mut descriptor = CapabilityDescriptor {
        id: format!("cli.{}.{}", provider, action),
        provider: format!("cli.{}", provider),
        action: action.into(),
        display_name: display_name.into(),
        description: description.into(),
        category: category.into(),
        source: CapabilitySource::Cli,
        detected_from: raw_tool.binary_path.clone(),
        raw_tool_id: Some(raw_tool.id.clone()),
        version: raw_tool.version.clone(),
        status,
        execution_mode: execution_mode.clone(),
        deterministic: execution_mode == crate::capabilities::ExecutionMode::Deterministic,
        read_only,
        idempotent,
        destructive,
        open_world,
        requires_network: permissions
            .iter()
            .any(|permission| *permission == "network:read"),
        writes_files,
        requires_credentials: raw_tool.auth_status
            == Some(crate::models::RawToolAuthStatus::Authenticated)
            || permissions
                .iter()
                .any(|permission| permission.contains("github")),
        permissions: permissions.into_iter().map(str::to_string).collect(),
        intent_tags: intent_tags.into_iter().map(str::to_string).collect(),
        operation_tags: vec![],
        best_for: vec![best_for.into()],
        not_for: vec![],
        builder_guidance: format!(
            "{display_name} is available from detected local tool `{}`.",
            raw_tool.id
        ),
        fallback_strategy: fallback_strategy.into(),
        input_schema: serde_json::json!({
            "type": "object",
            "additionalProperties": true
        }),
        output_schema: serde_json::json!({
            "type": "object",
            "additionalProperties": true
        }),
        trust_tier: CapabilityTrustTier::VerifiedLocal,
        default_approval,
        adapter: CapabilityAdapter::Cli {
            command,
            args_template: vec![],
            timeout_ms: 30_000,
        },
        signature_hash: String::new(),
        last_checked_at: Some(raw_tool.last_checked_at.clone()),
    };
    descriptor.signature_hash = capability_signature_hash(&descriptor);
    descriptor
}

fn raw_tool_status(raw_tool: &crate::models::RawToolInventoryItem) -> CapabilityAvailability {
    if raw_tool.auth_status == Some(crate::models::RawToolAuthStatus::NeedsAuth) {
        return CapabilityAvailability::NeedsAuth;
    }
    match raw_tool.status {
        crate::models::RawToolStatus::Available => CapabilityAvailability::Available,
        crate::models::RawToolStatus::NeedsAuth => CapabilityAvailability::NeedsAuth,
        crate::models::RawToolStatus::Degraded => CapabilityAvailability::Degraded,
        crate::models::RawToolStatus::Unavailable => CapabilityAvailability::Unavailable,
    }
}

pub fn descriptor_from_static_capability(
    capability: crate::capabilities::Capability,
) -> CapabilityDescriptor {
    let mut descriptor = CapabilityDescriptor {
        id: capability.id.clone(),
        provider: capability.provider.clone(),
        action: capability.action.clone(),
        display_name: capability.display_name,
        description: capability.description,
        category: capability.category,
        source: CapabilitySource::Builtin,
        detected_from: None,
        raw_tool_id: None,
        version: None,
        status: match capability.status {
            crate::capabilities::CapabilityStatus::Implemented => CapabilityAvailability::Available,
            crate::capabilities::CapabilityStatus::Planned => CapabilityAvailability::Unavailable,
            crate::capabilities::CapabilityStatus::External => CapabilityAvailability::Degraded,
        },
        execution_mode: capability.execution_mode,
        deterministic: capability.deterministic,
        read_only: capability.read_only,
        idempotent: capability.idempotent,
        destructive: capability.destructive,
        open_world: capability.open_world,
        requires_network: requires_network(&capability.permissions),
        writes_files: writes_files(&capability.permissions),
        requires_credentials: requires_credentials(&capability.permissions),
        permissions: capability.permissions,
        intent_tags: capability.intent_tags,
        operation_tags: capability.operation_tags,
        best_for: capability.best_for,
        not_for: capability.not_for,
        builder_guidance: capability.builder_guidance,
        fallback_strategy: capability.fallback_strategy,
        input_schema: capability.input_schema,
        output_schema: capability.output_schema,
        trust_tier: CapabilityTrustTier::RavenBuiltin,
        default_approval: default_approval_for(
            capability.destructive,
            capability.open_world,
            capability.read_only,
        ),
        adapter: CapabilityAdapter::Native {
            handler: format!("{}.{}", capability.provider, capability.action),
        },
        signature_hash: String::new(),
        last_checked_at: None,
    };
    descriptor.signature_hash = capability_signature_hash(&descriptor);
    descriptor
}

pub fn legacy_openai_generate_artifact_descriptor() -> CapabilityDescriptor {
    let mut descriptor = CapabilityDescriptor {
        id: "openai.generate_artifact".into(),
        provider: "openai".into(),
        action: "generate_artifact".into(),
        display_name: "Generate Artifact".into(),
        description: "Generates a workflow artifact with the configured OpenAI profile.".into(),
        category: "generation".into(),
        source: CapabilitySource::Builtin,
        detected_from: Some("legacy_llm_runtime".into()),
        raw_tool_id: None,
        version: None,
        status: CapabilityAvailability::Available,
        execution_mode: crate::capabilities::ExecutionMode::BoundedAgentic,
        deterministic: false,
        read_only: false,
        idempotent: false,
        destructive: false,
        open_world: true,
        requires_network: true,
        writes_files: false,
        requires_credentials: true,
        permissions: vec!["llm:generate".into()],
        intent_tags: vec!["llm".into(), "artifact_generation".into()],
        operation_tags: vec![],
        best_for: vec!["Generating a markdown artifact from gathered workflow context.".into()],
        not_for: vec!["Writing generated artifacts to local storage.".into()],
        builder_guidance:
            "Use only for legacy workflows that intentionally generate an artifact with an LLM."
                .into(),
        fallback_strategy: "Request an approval grant or choose a registered generator capability."
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "additionalProperties": true
        }),
        output_schema: serde_json::json!({
            "type": "object",
            "required": ["artifact"],
            "properties": {
                "artifact": { "type": "string" },
                "format": { "type": "string" }
            }
        }),
        trust_tier: CapabilityTrustTier::Unknown,
        default_approval: CapabilityDefaultApproval::AlwaysReview,
        adapter: CapabilityAdapter::Native {
            handler: "openai.generate_artifact".into(),
        },
        signature_hash: String::new(),
        last_checked_at: None,
    };
    descriptor.signature_hash = capability_signature_hash(&descriptor);
    descriptor
}

fn requires_network(permissions: &[String]) -> bool {
    permissions
        .iter()
        .any(|permission| permission == "network:read")
}

fn writes_files(permissions: &[String]) -> bool {
    permissions
        .iter()
        .any(|permission| permission == "artifact:write")
}

fn requires_credentials(permissions: &[String]) -> bool {
    permissions.iter().any(|permission| {
        matches!(
            permission.as_str(),
            "github:read" | "github:write" | "llm:generate"
        )
    })
}

fn default_approval_for(
    destructive: bool,
    open_world: bool,
    read_only: bool,
) -> CapabilityDefaultApproval {
    if destructive || (open_world && !read_only) {
        CapabilityDefaultApproval::AlwaysReview
    } else {
        CapabilityDefaultApproval::Auto
    }
}

pub fn capability_signature_hash(capability: &CapabilityDescriptor) -> String {
    let stable = serde_json::json!({
        "id": capability.id,
        "provider": capability.provider,
        "action": capability.action,
        "source": capability.source,
        "execution_mode": capability.execution_mode,
        "read_only": capability.read_only,
        "idempotent": capability.idempotent,
        "destructive": capability.destructive,
        "open_world": capability.open_world,
        "requires_network": capability.requires_network,
        "writes_files": capability.writes_files,
        "requires_credentials": capability.requires_credentials,
        "permissions": capability.permissions,
        "input_schema": capability.input_schema,
        "output_schema": capability.output_schema,
        "adapter": capability.adapter,
    });
    hash_json(&stable)
}

pub(crate) fn registry_hash(capabilities: &[CapabilityDescriptor]) -> String {
    let stable = capabilities
        .iter()
        .map(|capability| capability.signature_hash.clone())
        .collect::<Vec<_>>();
    hash_json(&stable)
}

fn hash_json(value: &impl Serialize) -> String {
    let encoded =
        serde_json::to_string(value).expect("capability registry hash input should serialize");
    format!("{:016x}", fnv1a_64(encoded.as_bytes()))
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV1A_64_OFFSET_BASIS, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(FNV1A_64_PRIME)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_cli_tool(
        id: &str,
        display_name: &str,
        binary_path: &str,
        version: Option<&str>,
        auth_status: Option<crate::models::RawToolAuthStatus>,
    ) -> crate::models::RawToolInventoryItem {
        crate::models::RawToolInventoryItem {
            id: id.into(),
            source: crate::models::CapabilitySource::Cli,
            display_name: display_name.into(),
            binary_path: Some(binary_path.into()),
            version: version.map(str::to_string),
            status: crate::models::RawToolStatus::Available,
            auth_status,
            operations: vec![],
            annotations: Default::default(),
            detection_errors: vec![],
            last_checked_at: "2026-06-21T00:00:00Z".into(),
        }
    }

    #[test]
    fn registry_snapshot_contains_existing_builtin_capabilities() {
        let snapshot = builtin_registry_snapshot();

        assert!(snapshot
            .capabilities
            .iter()
            .any(|capability| capability.id == "http_probe.check_urls"));
        assert!(snapshot
            .capabilities
            .iter()
            .any(|capability| capability.id == "seo.audit_metadata"));
        assert!(!snapshot.hash.is_empty());
    }

    #[test]
    fn registry_snapshot_capabilities_are_sorted_by_id() {
        let snapshot = builtin_registry_snapshot();
        let ids = snapshot
            .capabilities
            .iter()
            .map(|capability| capability.id.as_str())
            .collect::<Vec<_>>();
        let mut sorted_ids = ids.clone();
        sorted_ids.sort_unstable();

        assert_eq!(ids, sorted_ids);
    }

    #[test]
    fn default_approval_is_auto_for_safe_read_only_capabilities() {
        let capability = descriptor_from_static_capability(
            crate::capabilities::capability_for("http_probe", "check_urls").unwrap(),
        );

        assert_eq!(capability.default_approval, CapabilityDefaultApproval::Auto);
    }

    #[test]
    fn default_approval_requires_review_for_file_writing_capabilities() {
        let capability = descriptor_from_static_capability(
            crate::capabilities::capability_for("local_app", "write_artifact").unwrap(),
        );

        assert_eq!(
            capability.default_approval,
            CapabilityDefaultApproval::AlwaysReview
        );
    }

    #[test]
    fn hash_json_uses_stable_fnv1a_64() {
        assert_eq!(hash_json(&"capability-registry"), "4891bea814ecbf8d");
    }

    #[test]
    fn capability_signatures_change_when_risk_metadata_changes() {
        let mut capability = descriptor_from_static_capability(
            crate::capabilities::capability_for("http_probe", "check_urls").unwrap(),
        );
        let first = capability_signature_hash(&capability);
        capability.destructive = true;
        let second = capability_signature_hash(&capability);

        assert_ne!(first, second);
    }

    #[test]
    fn maps_authenticated_github_cli_to_reviewed_dynamic_capability() {
        let raw = raw_cli_tool(
            "cli.gh",
            "GitHub CLI",
            "gh",
            Some("2.0.0"),
            Some(crate::models::RawToolAuthStatus::Authenticated),
        );

        let mapped = map_raw_tools_to_capabilities(&[raw]);

        let capability = mapped
            .iter()
            .find(|capability| capability.id == "cli.gh.github_context")
            .unwrap();
        assert_eq!(capability.source, crate::models::CapabilitySource::Cli);
        assert_eq!(capability.status, CapabilityAvailability::Available);
        assert!(capability.requires_credentials);
        assert!(capability.requires_network);
        assert_eq!(
            capability.default_approval,
            CapabilityDefaultApproval::AlwaysReview
        );
    }

    #[test]
    fn maps_unauthenticated_github_cli_as_needs_auth_dynamic_capability() {
        let raw = raw_cli_tool(
            "cli.gh",
            "GitHub CLI",
            "gh",
            Some("2.0.0"),
            Some(crate::models::RawToolAuthStatus::NeedsAuth),
        );

        let mapped = map_raw_tools_to_capabilities(&[raw]);

        let capability = mapped
            .iter()
            .find(|capability| capability.id == "cli.gh.github_context")
            .unwrap();
        assert_eq!(capability.status, CapabilityAvailability::NeedsAuth);
        assert_eq!(
            capability.default_approval,
            CapabilityDefaultApproval::AlwaysReview
        );
    }

    #[test]
    fn maps_ripgrep_as_read_only_workspace_search_capability() {
        let raw = raw_cli_tool(
            "cli.rg",
            "ripgrep",
            "/usr/local/bin/rg",
            Some("14.1.0"),
            None,
        );

        let mapped = map_raw_tools_to_capabilities(&[raw]);
        let capability = mapped
            .iter()
            .find(|capability| capability.id == "cli.rg.search_workspace")
            .unwrap();
        assert_eq!(capability.status, CapabilityAvailability::Available);
        assert_eq!(capability.category, "local_context");
        assert!(capability.read_only);
        assert!(!capability.requires_network);
        assert_eq!(capability.default_approval, CapabilityDefaultApproval::Auto);
    }

    #[test]
    fn maps_pdf_tools_as_read_only_document_capabilities() {
        let raw = raw_cli_tool(
            "cli.pdftotext",
            "pdftotext",
            "/opt/homebrew/bin/pdftotext",
            Some("24.02.0"),
            None,
        );

        let mapped = map_raw_tools_to_capabilities(&[raw]);
        let capability = mapped
            .iter()
            .find(|capability| capability.id == "cli.pdftotext.extract_text")
            .unwrap();
        assert_eq!(capability.status, CapabilityAvailability::Available);
        assert_eq!(capability.category, "document_import");
        assert!(capability.read_only);
    }

    #[test]
    fn registry_snapshot_with_raw_tools_sorts_and_deduplicates_capabilities() {
        let first = raw_cli_tool(
            "cli.gh",
            "GitHub CLI",
            "gh",
            Some("2.0.0"),
            Some(crate::models::RawToolAuthStatus::Authenticated),
        );
        let duplicate = raw_cli_tool(
            "cli.gh",
            "GitHub CLI",
            "gh",
            Some("2.0.0"),
            Some(crate::models::RawToolAuthStatus::Authenticated),
        );

        let snapshot = registry_snapshot_with_raw_tools(&[first, duplicate]);
        let ids = snapshot
            .capabilities
            .iter()
            .map(|capability| capability.id.as_str())
            .collect::<Vec<_>>();
        let mut sorted_ids = ids.clone();
        sorted_ids.sort_unstable();

        assert_eq!(ids, sorted_ids);
        assert!(snapshot
            .capabilities
            .iter()
            .any(|capability| capability.source == crate::models::CapabilitySource::Cli));
    }
}
