pub mod extract;
pub mod map;
pub mod operations;
pub mod render;
pub mod verify;

use crate::models::RavenWorkflow;

pub fn workflow_for_prompt(prompt: &str) -> Option<(RavenWorkflow, operations::OperationPlan)> {
    let plan = extract::extract_operations(prompt);
    let mapped = map::map_operations_to_capabilities(plan).ok()?;
    let workflow = render::render_workflow(prompt, &mapped).ok()?;
    Some((workflow, mapped))
}
