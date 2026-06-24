use crate::models::{
    CapabilityDescriptor, PreflightBlockingItem, PreflightCapabilityUse, PreflightCredentialUse,
    PreflightDeleteUse, PreflightManifest, PreflightScopedValueUse, RavenWorkflow,
    WorkflowStepDefinition,
};
use crate::workflow::WorkflowError;
use serde_json::Value;

pub fn evaluate_workflow_preflight(
    workflow: &RavenWorkflow,
    workflow_version: i64,
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
    mode: crate::autonomy::AutonomyMode,
) -> Result<PreflightManifest, WorkflowError> {
    evaluate_workflow_preflight_with_overrides(
        workflow,
        workflow_version,
        registry,
        mode,
        &crate::autonomy::CategoryAutonomyOverrides::new(),
    )
}

pub fn evaluate_workflow_preflight_with_overrides(
    workflow: &RavenWorkflow,
    workflow_version: i64,
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
    mode: crate::autonomy::AutonomyMode,
    category_overrides: &crate::autonomy::CategoryAutonomyOverrides,
) -> Result<PreflightManifest, WorkflowError> {
    evaluate_workflow_preflight_with_artifact_paths(
        workflow,
        workflow_version,
        registry,
        mode,
        category_overrides,
        default_generated_artifact_paths(),
    )
}

pub fn evaluate_workflow_preflight_with_artifact_paths(
    workflow: &RavenWorkflow,
    workflow_version: i64,
    registry: &crate::capability_registry::CapabilityRegistrySnapshot,
    mode: crate::autonomy::AutonomyMode,
    category_overrides: &crate::autonomy::CategoryAutonomyOverrides,
    generated_artifact_paths: Vec<String>,
) -> Result<PreflightManifest, WorkflowError> {
    let mut capabilities = Vec::new();
    let mut credentials = Vec::new();
    let mut network_domains = Vec::new();
    let mut file_reads = Vec::new();
    let mut file_writes = Vec::new();
    let mut overwrites = Vec::new();
    let mut deletes = Vec::new();
    let mut external_publishes = Vec::new();
    let mut scoped_network_domains = Vec::new();
    let mut scoped_network_resources = Vec::new();
    let mut scoped_file_writes = Vec::new();
    let mut scoped_overwrites = Vec::new();
    let mut scoped_external_publishes = Vec::new();
    let mut blocking_items = Vec::new();

    for step in &workflow.steps {
        let capability_id = format!("{}.{}", step.provider, step.action);
        let Some(capability) = registry
            .capabilities
            .iter()
            .find(|candidate| candidate.id == capability_id)
        else {
            blocking_items.push(PreflightBlockingItem {
                step_id: step.id.clone(),
                capability_id,
                reason: "Capability is not available in the registry snapshot.".into(),
            });
            continue;
        };
        let decision = crate::autonomy::evaluate_capability_policy_with_overrides(
            capability,
            mode,
            category_overrides,
        );
        let reason = decision.reason.clone();
        capabilities.push(PreflightCapabilityUse {
            capability_id: capability.id.clone(),
            step_id: step.id.clone(),
            policy_decision: decision.decision.clone(),
            reason: reason.clone(),
            signature_hash: capability.signature_hash.clone(),
        });

        if matches!(
            decision.decision,
            crate::autonomy::PolicyDecisionKind::Blocked
                | crate::autonomy::PolicyDecisionKind::Hidden
        ) {
            blocking_items.push(PreflightBlockingItem {
                step_id: step.id.clone(),
                capability_id: capability.id.clone(),
                reason,
            });
        }

        let scoped_inputs = step_scope_context(workflow, step);
        collect_capability_scope(
            capability,
            step,
            &scoped_inputs,
            &generated_artifact_paths,
            &mut credentials,
            &mut network_domains,
            &mut file_reads,
            &mut file_writes,
            &mut overwrites,
            &mut deletes,
            &mut external_publishes,
            &mut scoped_network_domains,
            &mut scoped_network_resources,
            &mut scoped_file_writes,
            &mut scoped_overwrites,
            &mut scoped_external_publishes,
        );
    }

    network_domains.extend(collect_network_domains(workflow));
    sort_dedup(&mut network_domains);
    sort_dedup(&mut file_reads);
    sort_dedup(&mut file_writes);
    sort_dedup(&mut overwrites);
    sort_dedup(&mut external_publishes);
    sort_dedup_scoped(&mut scoped_network_domains);
    sort_dedup_scoped(&mut scoped_network_resources);
    sort_dedup_scoped(&mut scoped_file_writes);
    sort_dedup_scoped(&mut scoped_overwrites);
    sort_dedup_scoped(&mut scoped_external_publishes);
    credentials.sort_by(|left, right| {
        (&left.step_id, &left.capability_id, &left.credential_ref).cmp(&(
            &right.step_id,
            &right.capability_id,
            &right.credential_ref,
        ))
    });
    credentials.dedup_by(|left, right| {
        left.step_id == right.step_id
            && left.capability_id == right.capability_id
            && left.credential_ref == right.credential_ref
    });
    deletes.sort_by(|left, right| {
        (
            &left.step_id,
            &left.capability_id,
            &left.path_pattern,
            left.max_deletes,
        )
            .cmp(&(
                &right.step_id,
                &right.capability_id,
                &right.path_pattern,
                right.max_deletes,
            ))
    });
    deletes.dedup_by(|left, right| {
        left.step_id == right.step_id
            && left.capability_id == right.capability_id
            && left.path_pattern == right.path_pattern
            && left.max_deletes == right.max_deletes
    });

    Ok(PreflightManifest {
        id: format!("preflight-{}", uuid::Uuid::new_v4()),
        workflow_id: workflow.id.clone(),
        workflow_version,
        registry_snapshot_hash: registry.hash.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        capabilities,
        credentials,
        network_domains,
        file_reads,
        file_writes,
        overwrites,
        deletes,
        external_publishes,
        scoped_network_domains,
        scoped_network_resources,
        scoped_file_writes,
        scoped_overwrites,
        scoped_external_publishes,
        policy_recommendation: mode,
        blocking_items,
    })
}

fn collect_capability_scope(
    capability: &CapabilityDescriptor,
    step: &WorkflowStepDefinition,
    inputs: &Value,
    generated_artifact_paths: &[String],
    credentials: &mut Vec<PreflightCredentialUse>,
    network_domains: &mut Vec<String>,
    file_reads: &mut Vec<String>,
    file_writes: &mut Vec<String>,
    overwrites: &mut Vec<String>,
    deletes: &mut Vec<PreflightDeleteUse>,
    external_publishes: &mut Vec<String>,
    scoped_network_domains: &mut Vec<PreflightScopedValueUse>,
    scoped_network_resources: &mut Vec<PreflightScopedValueUse>,
    scoped_file_writes: &mut Vec<PreflightScopedValueUse>,
    scoped_overwrites: &mut Vec<PreflightScopedValueUse>,
    scoped_external_publishes: &mut Vec<PreflightScopedValueUse>,
) {
    if capability.requires_credentials {
        for credential_ref in credential_refs_from_step_inputs(inputs) {
            credentials.push(PreflightCredentialUse {
                step_id: step.id.clone(),
                capability_id: capability.id.clone(),
                credential_ref,
            });
        }
    }

    if capability.requires_network
        || capability
            .permissions
            .iter()
            .any(|permission| permission.starts_with("network:"))
    {
        let domains = domains_from_step_inputs(inputs);
        network_domains.extend(domains.iter().cloned());
        if domains.is_empty() {
            scoped_network_resources.push(scoped_value(step, capability, capability.id.clone()));
        } else {
            scoped_network_domains.extend(
                domains
                    .into_iter()
                    .map(|domain| scoped_value(step, capability, domain)),
            );
        }
    }

    if is_file_read_capability(capability) {
        file_reads.extend(read_paths_from_step_inputs(inputs));
    }

    if capability.writes_files
        || capability
            .permissions
            .iter()
            .any(|permission| permission.contains(":write"))
    {
        let mut paths = file_write_paths_from_step_inputs(inputs);
        if paths.is_empty() && capability.id == "local_app.write_artifact" {
            paths = generated_artifact_paths.to_vec();
        }
        if overwrite_requested(inputs) {
            overwrites.extend(paths.iter().cloned());
            scoped_overwrites.extend(
                paths
                    .iter()
                    .cloned()
                    .map(|path| scoped_value(step, capability, path)),
            );
        }
        scoped_file_writes.extend(
            paths
                .iter()
                .cloned()
                .map(|path| scoped_value(step, capability, path)),
        );
        file_writes.extend(paths);
    }

    if is_delete_capability(capability) {
        let paths = delete_paths_from_step_inputs(inputs);
        let max_deletes = max_deletes_from_step_inputs(inputs);
        for path in paths {
            deletes.push(PreflightDeleteUse {
                step_id: step.id.clone(),
                capability_id: capability.id.clone(),
                path_pattern: path,
                max_deletes,
            });
        }
    }

    if is_publish_capability(capability) {
        let targets = external_targets_from_step_inputs(inputs);
        external_publishes.extend(targets.iter().cloned());
        scoped_external_publishes.extend(
            targets
                .into_iter()
                .map(|target| scoped_value(step, capability, target)),
        );
    }
}

fn scoped_value(
    step: &WorkflowStepDefinition,
    capability: &CapabilityDescriptor,
    value: String,
) -> PreflightScopedValueUse {
    PreflightScopedValueUse {
        step_id: step.id.clone(),
        capability_id: capability.id.clone(),
        value,
    }
}

fn collect_network_domains(workflow: &RavenWorkflow) -> Vec<String> {
    let mut domains = workflow
        .steps
        .iter()
        .flat_map(|step| domains_from_step_inputs(&step.inputs))
        .collect::<Vec<_>>();
    domains.sort();
    domains.dedup();
    domains
}

fn default_generated_artifact_paths() -> Vec<String> {
    vec!["artifact-*.md".into(), "artifact-*.metadata.json".into()]
}

fn step_scope_context(workflow: &RavenWorkflow, step: &WorkflowStepDefinition) -> Value {
    let mut inputs = step.inputs.as_object().cloned().unwrap_or_default();
    let profile_ref = step
        .llm_profile_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&workflow.defaults.llm_profile_ref);
    if !profile_ref.trim().is_empty() {
        inputs
            .entry("profile_ref")
            .or_insert_with(|| Value::String(profile_ref.into()));
        inputs
            .entry("llm_profile_ref")
            .or_insert_with(|| Value::String(profile_ref.into()));
    }
    if let Some(destination_ref) = step
        .destination_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        inputs
            .entry("destination_ref")
            .or_insert_with(|| Value::String(destination_ref.into()));
    }
    Value::Object(inputs)
}

fn is_file_read_capability(capability: &CapabilityDescriptor) -> bool {
    capability.read_only
        && capability.permissions.iter().any(|permission| {
            permission.contains("filesystem:read") || permission.contains("file:read")
        })
}

fn is_delete_capability(capability: &CapabilityDescriptor) -> bool {
    (!capability.writes_files && capability.destructive)
        || capability
            .permissions
            .iter()
            .any(|permission| permission.contains(":delete") || permission.contains(":destroy"))
}

fn is_publish_capability(capability: &CapabilityDescriptor) -> bool {
    capability
        .permissions
        .iter()
        .any(|permission| permission.contains(":publish") || permission.contains("publish"))
}

fn file_write_paths_from_step_inputs(inputs: &Value) -> Vec<String> {
    string_values_for_keys(
        inputs,
        &[
            "path",
            "paths",
            "output_path",
            "destination_path",
            "content_path",
            "metadata_path",
        ],
    )
}

fn read_paths_from_step_inputs(inputs: &Value) -> Vec<String> {
    string_values_for_keys(
        inputs,
        &["path", "paths", "input_path", "source_path", "read_path"],
    )
}

fn delete_paths_from_step_inputs(inputs: &Value) -> Vec<String> {
    let mut paths = string_values_for_keys(
        inputs,
        &["delete_path", "delete_paths", "target_path", "target_paths"],
    );
    if paths.is_empty() {
        paths = file_write_paths_from_step_inputs(inputs);
    }
    paths
}

fn credential_refs_from_step_inputs(inputs: &Value) -> Vec<String> {
    string_values_for_keys(
        inputs,
        &[
            "credential_ref",
            "credential",
            "profile_ref",
            "llm_profile_ref",
        ],
    )
}

fn external_targets_from_step_inputs(inputs: &Value) -> Vec<String> {
    string_values_for_keys(
        inputs,
        &[
            "target",
            "targets",
            "destination",
            "destination_ref",
            "external_target",
            "external_targets",
            "target_url",
        ],
    )
}

fn domains_from_step_inputs(inputs: &Value) -> Vec<String> {
    let mut domains = Vec::new();
    collect_domains_from_keys(
        inputs,
        &[
            "url",
            "urls",
            "uri",
            "uris",
            "domain",
            "domains",
            "host",
            "hosts",
            "endpoint",
            "base_url",
            "target_url",
        ],
        &mut domains,
    );
    domains.sort();
    domains.dedup();
    domains
}

fn string_values_for_keys(value: &Value, keys: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    collect_string_values_for_keys(value, keys, &mut values);
    values.sort();
    values.dedup();
    values
}

fn collect_string_values_for_keys(value: &Value, keys: &[&str], values: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if keys.iter().any(|candidate| candidate == key) {
                    collect_strings(value, values);
                }
                collect_string_values_for_keys(value, keys, values);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_string_values_for_keys(item, keys, values);
            }
        }
        _ => {}
    }
}

fn collect_strings(value: &Value, values: &mut Vec<String>) {
    match value {
        Value::String(value) => values.push(value.clone()),
        Value::Array(items) => {
            for item in items {
                collect_strings(item, values);
            }
        }
        Value::Object(object) => {
            for value in object.values() {
                collect_strings(value, values);
            }
        }
        _ => {}
    }
}

fn collect_domains_from_keys(value: &Value, keys: &[&str], domains: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if keys.iter().any(|candidate| candidate == key) {
                    collect_domains_from_value(value, domains);
                }
                collect_domains_from_keys(value, keys, domains);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_domains_from_keys(item, keys, domains);
            }
        }
        _ => {}
    }
}

fn collect_domains_from_value(value: &Value, domains: &mut Vec<String>) {
    match value {
        Value::String(value) => {
            if let Some(domain) = domain_from_string(value) {
                domains.push(domain);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_domains_from_value(item, domains);
            }
        }
        Value::Object(object) => {
            for value in object.values() {
                collect_domains_from_value(value, domains);
            }
        }
        _ => {}
    }
}

fn domain_from_string(value: &str) -> Option<String> {
    if let Ok(url) = url::Url::parse(value) {
        return url.host_str().map(|domain| domain.to_ascii_lowercase());
    }
    if value.contains('.') && !value.contains('/') && !value.contains(' ') {
        return Some(value.to_ascii_lowercase());
    }
    None
}

fn overwrite_requested(inputs: &Value) -> bool {
    bool_value_for_keys(inputs, &["overwrite", "overwrites", "allow_overwrite"])
        || !string_values_for_keys(inputs, &["overwrite_path", "overwrite_paths"]).is_empty()
}

fn bool_value_for_keys(value: &Value, keys: &[&str]) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            (keys.iter().any(|candidate| candidate == key) && value.as_bool().unwrap_or(false))
                || bool_value_for_keys(value, keys)
        }),
        Value::Array(items) => items.iter().any(|item| bool_value_for_keys(item, keys)),
        _ => false,
    }
}

fn max_deletes_from_step_inputs(inputs: &Value) -> Option<u64> {
    number_value_for_keys(inputs, &["max_deletes", "maxDeletes", "delete_limit"])
}

fn number_value_for_keys(value: &Value, keys: &[&str]) -> Option<u64> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if keys.iter().any(|candidate| candidate == key) {
                    if let Some(number) = value.as_u64() {
                        return Some(number);
                    }
                }
                if let Some(number) = number_value_for_keys(value, keys) {
                    return Some(number);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| number_value_for_keys(item, keys)),
        _ => None,
    }
}

fn sort_dedup(values: &mut Vec<String>) {
    values.sort();
    values.dedup();
}

fn sort_dedup_scoped(values: &mut Vec<PreflightScopedValueUse>) {
    values.sort_by(|left, right| {
        (&left.step_id, &left.capability_id, &left.value).cmp(&(
            &right.step_id,
            &right.capability_id,
            &right.value,
        ))
    });
    values.dedup_by(|left, right| {
        left.step_id == right.step_id
            && left.capability_id == right.capability_id
            && left.value == right.value
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        CapabilityAdapter, CapabilityAvailability, CapabilityDefaultApproval, CapabilityDescriptor,
        CapabilitySource, CapabilityTrustTier, RavenWorkflow, WorkflowDefaults,
        WorkflowScheduleDefinition, WorkflowStepDefinition, WorkflowStepKind,
    };

    fn test_capability(
        provider: &str,
        action: &str,
        configure: impl FnOnce(&mut CapabilityDescriptor),
    ) -> CapabilityDescriptor {
        let mut capability = CapabilityDescriptor {
            id: format!("{provider}.{action}"),
            provider: provider.into(),
            action: action.into(),
            display_name: format!("{provider} {action}"),
            description: "Test capability".into(),
            category: "test".into(),
            source: CapabilitySource::Builtin,
            detected_from: None,
            raw_tool_id: None,
            version: None,
            status: CapabilityAvailability::Available,
            execution_mode: crate::capabilities::ExecutionMode::Deterministic,
            deterministic: true,
            read_only: true,
            idempotent: true,
            destructive: false,
            open_world: false,
            requires_network: false,
            writes_files: false,
            requires_credentials: false,
            permissions: vec![],
            intent_tags: vec![],
            operation_tags: vec![],
            best_for: vec![],
            not_for: vec![],
            builder_guidance: "Test guidance".into(),
            fallback_strategy: "Test fallback".into(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
            trust_tier: CapabilityTrustTier::RavenBuiltin,
            default_approval: CapabilityDefaultApproval::Auto,
            adapter: CapabilityAdapter::Native {
                handler: format!("{provider}.{action}"),
            },
            signature_hash: format!("{provider}.{action}:sig"),
            last_checked_at: None,
        };
        configure(&mut capability);
        capability
    }

    fn test_step(
        provider: &str,
        action: &str,
        inputs: serde_json::Value,
    ) -> WorkflowStepDefinition {
        WorkflowStepDefinition {
            kind: WorkflowStepKind::ProviderAction,
            id: format!("{provider}-{action}"),
            name: format!("{provider} {action}"),
            provider: provider.into(),
            action: action.into(),
            depends_on: vec![],
            permissions: vec![],
            inputs,
            llm_profile_ref: None,
            destination_ref: None,
            inline_code: None,
            parallel: None,
        }
    }

    fn test_workflow(steps: Vec<WorkflowStepDefinition>) -> RavenWorkflow {
        RavenWorkflow {
            schema_version: "0.1.0".into(),
            id: "preflight-scope-test".into(),
            name: "Preflight Scope Test".into(),
            description: "Exercises scoped preflight requirements.".into(),
            permissions: vec![],
            defaults: WorkflowDefaults {
                llm_profile_ref: "default-openai".into(),
                destination_ref: "local-app".into(),
            },
            schedule: Some(WorkflowScheduleDefinition {
                cadence: "manual".into(),
                local_time: None,
            }),
            steps,
        }
    }

    fn test_registry(
        capabilities: Vec<CapabilityDescriptor>,
    ) -> crate::capability_registry::CapabilityRegistrySnapshot {
        crate::capability_registry::CapabilityRegistrySnapshot {
            hash: "test-registry".into(),
            generated_at: "2026-06-21T00:00:00Z".into(),
            capabilities,
            policy_decisions: vec![],
        }
    }

    #[test]
    fn preflight_manifest_lists_capabilities_and_domains() {
        let workflow = crate::workflow::deterministic_weather_workflow();
        let registry = crate::capability_registry::builtin_registry_snapshot();

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        assert_eq!(manifest.workflow_id, "open-meteo-weather");
        assert!(manifest
            .capabilities
            .iter()
            .any(|capability| capability.capability_id == "open_meteo.current_weather"));
    }

    #[test]
    fn category_override_changes_preflight_policy_decision() {
        let workflow = crate::workflow::deterministic_weather_workflow();
        let registry = crate::capability_registry::builtin_registry_snapshot();
        let mut overrides = crate::autonomy::CategoryAutonomyOverrides::new();
        overrides.insert("weather".into(), crate::autonomy::AutonomyMode::AskFirst);

        let manifest = evaluate_workflow_preflight_with_overrides(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
            &overrides,
        )
        .unwrap();

        let weather = manifest
            .capabilities
            .iter()
            .find(|capability| capability.capability_id == "open_meteo.current_weather")
            .unwrap();
        assert_eq!(
            weather.policy_decision,
            crate::autonomy::PolicyDecisionKind::NeedsGrant
        );
    }

    #[test]
    fn legacy_openai_generate_artifact_is_present_for_preflight_and_grants() {
        let workflow = crate::workflow::daily_work_journal();
        let registry = crate::capability_registry::builtin_registry_snapshot();

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        let capability = manifest
            .capabilities
            .iter()
            .find(|capability| capability.capability_id == "openai.generate_artifact")
            .expect("legacy OpenAI generate artifact capability");
        assert_eq!(capability.step_id, "compose-artifact");
        assert!(!capability.signature_hash.is_empty());
        assert!(manifest.credentials.iter().any(|credential| {
            credential.step_id == "compose-artifact"
                && credential.capability_id == "openai.generate_artifact"
                && credential.credential_ref == "default-openai"
        }));
        assert!(manifest.scoped_network_resources.iter().any(|resource| {
            resource.step_id == "compose-artifact"
                && resource.capability_id == "openai.generate_artifact"
                && resource.value == "openai.generate_artifact"
        }));
        assert!(!manifest
            .blocking_items
            .iter()
            .any(|item| item.capability_id == "openai.generate_artifact"));
    }

    #[test]
    fn current_weather_agent_preflight_includes_agent_network_resource_scope() {
        let workflow = crate::workflow::current_weather();
        let registry = crate::capability_registry::builtin_registry_snapshot();

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        assert!(manifest.scoped_network_resources.iter().any(|resource| {
            resource.step_id == "ask-ai"
                && resource.capability_id == "agent.run_task"
                && resource.value == "agent.run_task"
        }));
    }

    #[test]
    fn missing_registry_capability_creates_blocking_item() {
        let workflow = crate::workflow::deterministic_weather_workflow();
        let mut registry = crate::capability_registry::builtin_registry_snapshot();
        registry
            .capabilities
            .retain(|capability| capability.id != "open_meteo.current_weather");

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        assert!(manifest.blocking_items.iter().any(|item| {
            item.step_id == "fetch-weather"
                && item.capability_id == "open_meteo.current_weather"
                && item
                    .reason
                    .contains("not available in the registry snapshot")
        }));
    }

    #[test]
    fn unavailable_capability_is_blocked_and_preserves_signature_hash() {
        let workflow = crate::workflow::deterministic_weather_workflow();
        let mut registry = crate::capability_registry::builtin_registry_snapshot();
        let capability = registry
            .capabilities
            .iter_mut()
            .find(|capability| capability.id == "open_meteo.current_weather")
            .unwrap();
        capability.status = crate::models::CapabilityAvailability::Unavailable;
        let signature_hash = capability.signature_hash.clone();

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        let capability_use = manifest
            .capabilities
            .iter()
            .find(|capability| capability.capability_id == "open_meteo.current_weather")
            .unwrap();

        assert_eq!(
            capability_use.policy_decision,
            crate::autonomy::PolicyDecisionKind::Blocked
        );
        assert_eq!(capability_use.signature_hash, signature_hash);
    }

    #[test]
    fn network_domains_are_normalized_hosts_without_userinfo_or_url_parts() {
        let mut workflow = crate::workflow::deterministic_weather_workflow();
        workflow.steps[0].inputs = serde_json::json!({
            "primary": "https://User:Pass@Example.COM/path?token=secret#frag",
            "nested": {
                "urls": [
                    "https://example.com/duplicate",
                    "http://API.Example.com:8443/v1?query=value",
                    "not-a-url"
                ]
            }
        });
        let registry = crate::capability_registry::builtin_registry_snapshot();

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        assert_eq!(
            manifest.network_domains,
            vec!["api.example.com".to_string(), "example.com".to_string()]
        );
        assert!(!manifest
            .network_domains
            .iter()
            .any(|domain| domain.contains("User") || domain.contains("Pass")));
    }

    #[test]
    fn scoped_preflight_manifest_lists_credentials_network_writes_deletes_and_publishes() {
        let mut credential_step = test_step(
            "agent",
            "run_task",
            serde_json::json!({
                "objective": "Summarize a private issue."
            }),
        );
        credential_step.llm_profile_ref = Some("codex-oauth-local".into());

        let mut write_step = test_step(
            "local_app",
            "write_artifact",
            serde_json::json!({
                "artifact": "$steps.agent-run_task.artifact",
                "destination_path": "/tmp/raven/report.md",
                "overwrite": true
            }),
        );
        write_step.destination_ref = Some("local-app".into());

        let workflow = test_workflow(vec![
            credential_step,
            test_step(
                "http_probe",
                "check_urls",
                serde_json::json!({
                    "urls": ["https://Example.com/path", "api.example.com"],
                    "host": "Status.Example.com"
                }),
            ),
            write_step,
            test_step(
                "filesystem",
                "delete",
                serde_json::json!({
                    "path": "/tmp/raven/*.tmp",
                    "max_deletes": 3
                }),
            ),
            test_step(
                "slack",
                "publish",
                serde_json::json!({
                    "external_target": "slack:#ops",
                    "target_url": "https://hooks.slack.com/services/test"
                }),
            ),
        ]);
        let registry = test_registry(vec![
            test_capability("agent", "run_task", |capability| {
                capability.requires_credentials = true;
                capability.permissions = vec!["llm:generate".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            }),
            test_capability("http_probe", "check_urls", |capability| {
                capability.requires_network = true;
                capability.permissions = vec!["network:read".into()];
            }),
            test_capability("local_app", "write_artifact", |capability| {
                capability.writes_files = true;
                capability.permissions = vec!["artifact:write".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            }),
            test_capability("filesystem", "delete", |capability| {
                capability.destructive = true;
                capability.permissions = vec!["filesystem:delete".into()];
                capability.default_approval = CapabilityDefaultApproval::Blocked;
            }),
            test_capability("slack", "publish", |capability| {
                capability.requires_network = true;
                capability.permissions = vec!["external:publish".into(), "network:write".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            }),
        ]);

        let manifest = evaluate_workflow_preflight(
            &workflow,
            7,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        assert!(manifest.credentials.iter().any(|credential| {
            credential.step_id == "agent-run_task"
                && credential.capability_id == "agent.run_task"
                && credential.credential_ref == "codex-oauth-local"
        }));
        assert_eq!(
            manifest.network_domains,
            vec![
                "api.example.com".to_string(),
                "example.com".to_string(),
                "hooks.slack.com".to_string(),
                "status.example.com".to_string()
            ]
        );
        assert!(manifest
            .file_writes
            .contains(&"/tmp/raven/report.md".to_string()));
        assert!(manifest
            .overwrites
            .contains(&"/tmp/raven/report.md".to_string()));
        assert!(manifest.deletes.iter().any(|delete| {
            delete.step_id == "filesystem-delete"
                && delete.capability_id == "filesystem.delete"
                && delete.path_pattern == "/tmp/raven/*.tmp"
                && delete.max_deletes == Some(3)
        }));
        assert!(manifest
            .external_publishes
            .contains(&"slack:#ops".to_string()));
    }

    #[test]
    fn delete_preflight_uses_runtime_delete_key_precedence() {
        let workflow = test_workflow(vec![test_step(
            "filesystem",
            "delete",
            serde_json::json!({
                "path": "/tmp/raven/fallback.txt",
                "target_paths": [
                    "/tmp/raven/delete-a.tmp",
                    "/tmp/raven/delete-b.tmp"
                ],
                "max_deletes": 2
            }),
        )]);
        let registry = test_registry(vec![test_capability(
            "filesystem",
            "delete",
            |capability| {
                capability.destructive = true;
                capability.permissions = vec!["filesystem:delete".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            },
        )]);

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        let delete_paths = manifest
            .deletes
            .iter()
            .map(|delete| delete.path_pattern.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            delete_paths,
            vec!["/tmp/raven/delete-a.tmp", "/tmp/raven/delete-b.tmp"]
        );
        assert!(manifest
            .deletes
            .iter()
            .all(|delete| delete.max_deletes == Some(2)));
    }

    #[test]
    fn delete_preflight_falls_back_to_runtime_write_path_keys_when_delete_keys_absent() {
        let workflow = test_workflow(vec![test_step(
            "filesystem",
            "delete",
            serde_json::json!({
                "paths": ["/tmp/raven/fallback-a.tmp", "/tmp/raven/fallback-b.tmp"]
            }),
        )]);
        let registry = test_registry(vec![test_capability(
            "filesystem",
            "delete",
            |capability| {
                capability.destructive = true;
                capability.permissions = vec!["filesystem:delete".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            },
        )]);

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        let delete_paths = manifest
            .deletes
            .iter()
            .map(|delete| delete.path_pattern.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            delete_paths,
            vec!["/tmp/raven/fallback-a.tmp", "/tmp/raven/fallback-b.tmp"]
        );
    }

    #[test]
    fn blocked_policy_decisions_are_reported_as_blocking_items() {
        let workflow = test_workflow(vec![test_step(
            "danger",
            "destroy",
            serde_json::json!({ "path": "/tmp/raven/*" }),
        )]);
        let registry = test_registry(vec![test_capability("danger", "destroy", |capability| {
            capability.status = CapabilityAvailability::Unavailable;
            capability.default_approval = CapabilityDefaultApproval::Blocked;
        })]);

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        assert!(manifest.blocking_items.iter().any(|item| {
            item.step_id == "danger-destroy"
                && item.capability_id == "danger.destroy"
                && item.reason.contains("Capability is unavailable")
        }));
    }

    #[test]
    fn scoped_preflight_entries_preserve_capability_ownership_for_grants() {
        let workflow = test_workflow(vec![
            test_step(
                "github",
                "fetch",
                serde_json::json!({ "url": "https://api.github.com/repos/acme/app" }),
            ),
            test_step(
                "slack",
                "fetch",
                serde_json::json!({ "url": "https://slack.com/api/conversations.history" }),
            ),
            test_step(
                "local_app",
                "write_artifact",
                serde_json::json!({ "destination_path": "/tmp/raven/report.md" }),
            ),
            test_step(
                "workspace",
                "write_file",
                serde_json::json!({ "path": "/tmp/raven/workspace.txt" }),
            ),
        ]);
        let registry = test_registry(vec![
            test_capability("github", "fetch", |capability| {
                capability.requires_network = true;
                capability.permissions = vec!["network:read".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            }),
            test_capability("slack", "fetch", |capability| {
                capability.requires_network = true;
                capability.permissions = vec!["network:read".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            }),
            test_capability("local_app", "write_artifact", |capability| {
                capability.writes_files = true;
                capability.permissions = vec!["artifact:write".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            }),
            test_capability("workspace", "write_file", |capability| {
                capability.writes_files = true;
                capability.permissions = vec!["filesystem:write".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            }),
        ]);

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        assert!(manifest.scoped_network_domains.iter().any(|item| {
            item.step_id == "github-fetch"
                && item.capability_id == "github.fetch"
                && item.value == "api.github.com"
        }));
        assert!(manifest.scoped_network_domains.iter().any(|item| {
            item.step_id == "slack-fetch"
                && item.capability_id == "slack.fetch"
                && item.value == "slack.com"
        }));
        assert!(manifest.scoped_file_writes.iter().any(|item| {
            item.step_id == "local_app-write_artifact"
                && item.capability_id == "local_app.write_artifact"
                && item.value == "/tmp/raven/report.md"
        }));
        assert!(manifest.scoped_file_writes.iter().any(|item| {
            item.step_id == "workspace-write_file"
                && item.capability_id == "workspace.write_file"
                && item.value == "/tmp/raven/workspace.txt"
        }));
    }

    #[test]
    fn network_required_capability_without_domains_emits_resource_scope() {
        let workflow = test_workflow(vec![test_step(
            "internal_api",
            "sync",
            serde_json::json!({ "resource_id": "tenant-1" }),
        )]);
        let registry = test_registry(vec![test_capability(
            "internal_api",
            "sync",
            |capability| {
                capability.requires_network = true;
                capability.permissions = vec!["network:read".into()];
                capability.default_approval = CapabilityDefaultApproval::AlwaysReview;
            },
        )]);

        let manifest = evaluate_workflow_preflight(
            &workflow,
            1,
            &registry,
            crate::autonomy::AutonomyMode::SafeAuto,
        )
        .unwrap();

        assert!(manifest.network_domains.is_empty());
        assert!(manifest.scoped_network_domains.is_empty());
        assert!(manifest.scoped_network_resources.iter().any(|item| {
            item.step_id == "internal_api-sync"
                && item.capability_id == "internal_api.sync"
                && item.value == "internal_api.sync"
        }));
    }
}
