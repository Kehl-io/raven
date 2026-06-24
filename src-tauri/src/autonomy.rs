use crate::models::{CapabilityAvailability, CapabilityDescriptor, CapabilityTrustTier};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyMode {
    AskFirst,
    SafeAuto,
    WorkspaceAuto,
    PowerAuto,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecisionKind {
    Auto,
    NeedsGrant,
    Blocked,
    Hidden,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CapabilityPolicyDecision {
    pub capability_id: String,
    pub decision: PolicyDecisionKind,
    pub reason: String,
}

pub type CategoryAutonomyOverrides = BTreeMap<String, AutonomyMode>;

pub fn effective_mode_for_capability(
    capability: &CapabilityDescriptor,
    mode: AutonomyMode,
    category_overrides: &CategoryAutonomyOverrides,
) -> AutonomyMode {
    category_overrides
        .get(&capability.category)
        .copied()
        .unwrap_or(mode)
}

pub fn evaluate_capability_policy_with_overrides(
    capability: &CapabilityDescriptor,
    mode: AutonomyMode,
    category_overrides: &CategoryAutonomyOverrides,
) -> CapabilityPolicyDecision {
    evaluate_capability_policy(
        capability,
        effective_mode_for_capability(capability, mode, category_overrides),
    )
}

pub fn evaluate_capability_policy(
    capability: &CapabilityDescriptor,
    mode: AutonomyMode,
) -> CapabilityPolicyDecision {
    let decision = if capability.trust_tier == CapabilityTrustTier::Unknown {
        (
            PolicyDecisionKind::NeedsGrant,
            "Unknown tools require review.",
        )
    } else if capability.destructive {
        (PolicyDecisionKind::NeedsGrant, "Capability is destructive.")
    } else if capability.requires_credentials {
        (
            PolicyDecisionKind::NeedsGrant,
            "Capability requires credentials.",
        )
    } else if capability.status == CapabilityAvailability::Unavailable {
        (PolicyDecisionKind::Blocked, "Capability is unavailable.")
    } else if capability.status == CapabilityAvailability::NeedsAuth {
        (
            PolicyDecisionKind::NeedsGrant,
            "Capability needs authentication before use.",
        )
    } else if capability.status == CapabilityAvailability::Degraded {
        (
            PolicyDecisionKind::NeedsGrant,
            "Capability is degraded and requires review.",
        )
    } else if matches!(mode, AutonomyMode::AskFirst) {
        (
            PolicyDecisionKind::NeedsGrant,
            "Ask First requires review before using this capability.",
        )
    } else if capability.writes_files
        && !matches!(mode, AutonomyMode::WorkspaceAuto | AutonomyMode::PowerAuto)
    {
        (PolicyDecisionKind::NeedsGrant, "Capability writes files.")
    } else if capability.writes_files
        && capability.deterministic
        && !capability.open_world
        && matches!(mode, AutonomyMode::WorkspaceAuto | AutonomyMode::PowerAuto)
    {
        (
            PolicyDecisionKind::Auto,
            "Trusted deterministic workspace file write capability.",
        )
    } else if capability.read_only && capability.idempotent && capability.deterministic {
        (
            PolicyDecisionKind::Auto,
            "Trusted read-only deterministic capability.",
        )
    } else if matches!(mode, AutonomyMode::PowerAuto) {
        (
            PolicyDecisionKind::Auto,
            "Power Auto allows this trusted capability.",
        )
    } else {
        (
            PolicyDecisionKind::NeedsGrant,
            "Capability needs scoped approval.",
        )
    };

    CapabilityPolicyDecision {
        capability_id: capability.id.clone(),
        decision: decision.0,
        reason: decision.1.into(),
    }
}

#[cfg(test)]
mod tests {
    use crate::models::{CapabilityAvailability, CapabilityTrustTier};

    use super::*;

    fn safe_test_capability() -> CapabilityDescriptor {
        crate::capability_registry::descriptor_from_static_capability(
            crate::capabilities::capability_for("http_probe", "check_urls").unwrap(),
        )
    }

    #[test]
    fn safe_auto_allows_trusted_read_only_deterministic_capability() {
        let capability = safe_test_capability();

        let decision = evaluate_capability_policy(&capability, AutonomyMode::SafeAuto);

        assert_eq!(decision.decision, PolicyDecisionKind::Auto);
    }

    #[test]
    fn ask_first_requires_grant_for_trusted_read_only_deterministic_capability() {
        let capability = safe_test_capability();

        let decision = evaluate_capability_policy(&capability, AutonomyMode::AskFirst);

        assert_eq!(decision.decision, PolicyDecisionKind::NeedsGrant);
        assert!(decision.reason.contains("Ask First"));
    }

    #[test]
    fn safe_auto_requires_grant_for_destructive_capability() {
        let mut capability = crate::capability_registry::descriptor_from_static_capability(
            crate::capabilities::capability_for("local_app", "write_artifact").unwrap(),
        );
        capability.destructive = true;

        let decision = evaluate_capability_policy(&capability, AutonomyMode::SafeAuto);

        assert_eq!(decision.decision, PolicyDecisionKind::NeedsGrant);
        assert!(decision.reason.contains("destructive"));
    }

    #[test]
    fn workspace_auto_allows_safe_deterministic_workspace_file_write() {
        let mut capability = safe_test_capability();
        capability.writes_files = true;
        capability.read_only = false;
        capability.destructive = false;
        capability.requires_credentials = false;
        capability.open_world = false;

        let decision = evaluate_capability_policy(&capability, AutonomyMode::WorkspaceAuto);

        assert_eq!(decision.decision, PolicyDecisionKind::Auto);
        assert!(decision.reason.contains("workspace file write"));
    }

    #[test]
    fn unavailable_capability_is_blocked() {
        let mut capability = safe_test_capability();
        capability.status = CapabilityAvailability::Unavailable;

        let decision = evaluate_capability_policy(&capability, AutonomyMode::PowerAuto);

        assert_eq!(decision.decision, PolicyDecisionKind::Blocked);
        assert!(decision.reason.contains("unavailable"));
    }

    #[test]
    fn destructive_precedes_unavailable_status() {
        let mut capability = safe_test_capability();
        capability.destructive = true;
        capability.status = CapabilityAvailability::Unavailable;

        let decision = evaluate_capability_policy(&capability, AutonomyMode::PowerAuto);

        assert_eq!(decision.decision, PolicyDecisionKind::NeedsGrant);
        assert!(decision.reason.contains("destructive"));
    }

    #[test]
    fn unknown_trust_requires_grant() {
        let mut capability = safe_test_capability();
        capability.trust_tier = CapabilityTrustTier::Unknown;
        capability.status = CapabilityAvailability::Unavailable;

        let decision = evaluate_capability_policy(&capability, AutonomyMode::PowerAuto);

        assert_eq!(decision.decision, PolicyDecisionKind::NeedsGrant);
        assert!(decision.reason.contains("Unknown"));
    }

    #[test]
    fn credentials_require_grant_before_workspace_file_write_auto() {
        let mut capability = safe_test_capability();
        capability.writes_files = true;
        capability.read_only = false;
        capability.destructive = false;
        capability.requires_credentials = true;
        capability.open_world = false;

        let decision = evaluate_capability_policy(&capability, AutonomyMode::WorkspaceAuto);

        assert_eq!(decision.decision, PolicyDecisionKind::NeedsGrant);
        assert!(decision.reason.contains("credentials"));
    }
}
