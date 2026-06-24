use std::collections::HashSet;

use crate::planner::operations::{OperationPlan, OperationStatus};

pub fn verify_selected_capabilities(
    plan: &OperationPlan,
    selected_capability_ids: &[String],
) -> Vec<String> {
    let justified = plan
        .operations
        .iter()
        .filter_map(|operation| operation.capability_id.as_deref())
        .collect::<HashSet<_>>();

    let mut errors = Vec::new();

    for selected in selected_capability_ids {
        if !justified.contains(selected.as_str()) {
            errors.push(format!(
                "Selected capability {selected} is not justified by a requested operation."
            ));
        }
    }

    for operation in &plan.operations {
        if operation.status == OperationStatus::Blocked {
            errors.push(format!(
                "Requested operation {:?} is blocked.",
                operation.kind
            ));
        }
    }

    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::operations::{
        OperationKind, OperationPlan, OperationStatus, PlannedOperation,
    };

    #[test]
    fn verifier_rejects_unjustified_provider_action() {
        let mut plan = OperationPlan::new("parse csv and summarize");
        plan.operations.push(PlannedOperation {
            id: "op-parse-csv".into(),
            kind: OperationKind::ParseCsv,
            status: OperationStatus::Covered,
            evidence: "Prompt requested CSV parsing.".into(),
            capability_id: Some("data.parse_csv".into()),
            step_id: Some("parse-csv".into()),
            inputs: serde_json::json!({}),
        });

        let selected = vec!["data.parse_csv".to_string(), "web.fetch_page".to_string()];
        let errors = verify_selected_capabilities(&plan, &selected);

        assert!(errors.iter().any(|error| error.contains("web.fetch_page")));
    }

    #[test]
    fn verifier_allows_agent_synthesis_after_deterministic_prep() {
        let mut plan = OperationPlan::new("parse csv and summarize");
        plan.operations.push(PlannedOperation {
            id: "op-parse-csv".into(),
            kind: OperationKind::ParseCsv,
            status: OperationStatus::Covered,
            evidence: "Prompt requested CSV parsing.".into(),
            capability_id: Some("data.parse_csv".into()),
            step_id: Some("parse-csv".into()),
            inputs: serde_json::json!({}),
        });
        plan.operations.push(PlannedOperation {
            id: "op-synthesize".into(),
            kind: OperationKind::SynthesizeMarkdownArtifact,
            status: OperationStatus::AgentRequired,
            evidence: "Prompt requested final written output.".into(),
            capability_id: None,
            step_id: Some("summarize".into()),
            inputs: serde_json::json!({}),
        });

        let selected = vec!["data.parse_csv".to_string()];
        assert!(verify_selected_capabilities(&plan, &selected).is_empty());
    }
}
