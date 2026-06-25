import { useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, GitCompareArrows, Plus, RotateCcw, Route, ShieldCheck } from "lucide-react";
import type {
  AgentAuthProfile,
  ApprovalRequest,
  Artifact,
  CapabilityDescriptor,
  LlmProfile,
  ProviderHealth,
  PreflightManifest,
  RavenWorkflow,
  StepState,
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowVersion,
} from "../../domain/types";
import type { SettingsFocusTarget, SettingsTabId } from "../contexts/UIContext";
import { formatRelativeTime, formatSchedule } from "../../domain/format";
import { isDeterministicProviderAction, validateWorkflowDefinition } from "../../domain/workflow";
import { StatusIndicator } from "./StatusIndicator";

type BuilderNodeId =
  | "trigger"
  | "context"
  | "agent"
  | "tools"
  | "approval"
  | "artifact"
  | "destination"
  | "schedule";
type EditableFieldId = "status" | "provider" | "schedule" | "time" | "approval";

interface SettingsLink {
  tab: SettingsTabId;
  target?: SettingsFocusTarget | null;
}

interface WorkflowDagProps {
  workflow: WorkflowVersion;
  providers: ProviderHealth[];
  llmProfiles: LlmProfile[];
  agentAuthProfiles: AgentAuthProfile[];
  runs: WorkflowRun[];
  artifacts: Artifact[];
  pendingApproval?: ApprovalRequest | null;
  activeSteps?: Map<string, StepState>;
  onEditField?: (field: EditableFieldId) => void;
  onOpenSettingsTarget?: (tab: SettingsTabId, target?: SettingsFocusTarget | null) => void;
  originalDefinition?: RavenWorkflow;
  onChangeDefinition?: (definition: RavenWorkflow) => void;
  onUndoDefinition?: () => void;
  onSaveDefinition?: () => void;
  isSavingDefinition?: boolean;
  saveNotice?: string;
  preflightManifest?: PreflightManifest | null;
  capabilities?: CapabilityDescriptor[];
}

interface NodeRequirement {
  label: string;
  status: ProviderHealth["status"] | "missing";
  recovery?: string;
  settingsLink?: SettingsLink;
}

interface BuilderNode {
  id: BuilderNodeId;
  type: string;
  role: string;
  name: string;
  status: string;
  keyConfig: string;
  details: Array<[string, string]>;
  requirements: NodeRequirement[];
  stepIds: string[];
  editableFields: Array<{ id: EditableFieldId; label: string }>;
  unavailableEdits: Array<{ label: string; reason: string; settingsLink?: SettingsLink }>;
}

interface BuilderStepTemplate {
  id: string;
  label: string;
  description: string;
}

type BuilderActionId = "add-step" | "validate" | "preview" | "diff" | "disable";

interface PreviewStepSummary {
  id: string;
  label: string;
  detail: string;
}

interface PreviewStage {
  id: string;
  title: string;
  description: string;
  steps: PreviewStepSummary[];
}

const stepTemplates: BuilderStepTemplate[] = [
  {
    id: "context-review",
    label: "Context review",
    description: "Add a supported context collection checkpoint before the agent step.",
  },
  {
    id: "artifact-review",
    label: "Artifact review",
    description: "Add a supported review checkpoint before writing the artifact.",
  },
  {
    id: "notification",
    label: "Completion notification",
    description: "Add a supported notification step after the destination write.",
  },
];

function destinationProviderId(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref === "local-app" ? "local_app" : ref;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function slugTargetId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function providerSettingsLink(provider: ProviderHealth | undefined, label: string): SettingsLink {
  if (provider?.kind === "context") {
    return { tab: "context", target: { type: "context-source", id: provider.id, label: provider.name } };
  }
  if (provider?.kind === "artifact_destination") {
    return { tab: "general", target: { type: "output", id: provider.id, label: provider.name } };
  }
  return {
    tab: "general",
    target: { type: "provider", id: slugTargetId(provider?.name ?? label), label: provider?.name ?? label },
  };
}

function providerRequirement(provider: ProviderHealth | undefined, label: string): NodeRequirement | null {
  if (!provider) {
    return {
      label: `Missing ${label}`,
      status: "missing",
      recovery: "Configure or install this provider.",
      settingsLink: providerSettingsLink(undefined, label),
    };
  }
  if (provider.status === "available") return null;
  return {
    label: `${provider.name}: ${statusLabel(provider.status)}`,
    status: provider.status,
    recovery: provider.fallbackProviderId
      ? `Fallback available: ${provider.fallbackProviderId}`
      : provider.summary,
    settingsLink: providerSettingsLink(provider, label),
  };
}

function worstRequirementStatus(requirements: NodeRequirement[], fallback: string) {
  if (requirements.some((requirement) => requirement.status === "missing")) return "needs_config";
  if (requirements.some((requirement) => requirement.status === "unavailable")) return "unavailable";
  if (requirements.some((requirement) => requirement.status === "needs_config")) return "needs_config";
  if (requirements.some((requirement) => requirement.status === "degraded")) return "degraded";
  return fallback;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function stringifyConfigValue(value: unknown): string {
  if (value == null || value === "") return "Not set";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function describeInputs(step: WorkflowStepDefinition): string {
  const entries = Object.entries(step.inputs).filter(([, value]) => value != null && value !== "");
  if (entries.length === 0) return "No inputs";
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${stringifyConfigValue(value)}`)
    .join("; ");
}

function describeToolsAndPermissions(steps: WorkflowStepDefinition[], workflow: WorkflowVersion): string[] {
  const toolInputs = steps.flatMap((step) => {
    const allowedTools = step.inputs.allowed_tools;
    return Array.isArray(allowedTools)
      ? allowedTools.filter((tool): tool is string => typeof tool === "string")
      : [];
  });
  return unique([...workflow.definition.permissions, ...steps.flatMap((step) => step.permissions), ...toolInputs]);
}

function activeStatusForSteps(
  activeSteps: Map<string, StepState> | undefined,
  stepIds: string[],
): string | undefined {
  if (!activeSteps || stepIds.length === 0) return undefined;
  const states = stepIds
    .map((stepId) => activeSteps.get(stepId)?.status)
    .filter((status): status is StepState["status"] => status != null);
  if (states.includes("failed")) return "failed";
  if (states.includes("active")) return "running";
  if (states.length > 0 && states.every((status) => status === "complete")) return "succeeded";
  return undefined;
}

function nodeStatus(
  baseStatus: string,
  requirements: NodeRequirement[],
  activeSteps: Map<string, StepState> | undefined,
  stepIds: string[],
) {
  return activeStatusForSteps(activeSteps, stepIds) ?? worstRequirementStatus(requirements, baseStatus);
}

export function buildWorkflowBuilderNodes({
  workflow,
  providers,
  llmProfiles,
  agentAuthProfiles,
  runs,
  artifacts,
  pendingApproval,
  activeSteps,
}: WorkflowDagProps): BuilderNode[] {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const llmProfileById = new Map(llmProfiles.map((profile) => [profile.id, profile]));
  const authProfileById = new Map(agentAuthProfiles.map((profile) => [profile.id, profile]));
  const steps = workflow.definition.steps;
  const latestRun = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  )[0];
  const latestArtifact = [...artifacts].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];

  const contextSteps = steps.filter((step) => {
    const provider = providerById.get(step.provider);
    return (
      provider?.kind === "context" ||
      step.permissions.some((permission) => permission.includes(":read")) ||
      /context|activity|import|git/i.test(`${step.provider}.${step.action}`)
    );
  });
  const contextRequirements = contextSteps
    .filter((step) => step.kind !== "agent_task" && !isDeterministicProviderAction(step.provider, step.action))
    .map((step) => providerRequirement(providerById.get(step.provider), step.provider))
    .filter((requirement): requirement is NodeRequirement => requirement != null);
  const contextNames = unique(contextSteps.map((step) => providerById.get(step.provider)?.name ?? step.provider));

  const agentSteps = steps.filter((step) => {
    return (
      step.kind === "agent_task" ||
      step.permissions.includes("llm:generate") ||
      step.action === "generate_artifact" ||
      step.provider === "openai" ||
      step.provider === "anthropic"
    );
  });
  const agentProfileRefs = unique([
    workflow.definition.defaults.llmProfileRef,
    ...agentSteps.map((step) => step.llmProfileRef ?? workflow.definition.defaults.llmProfileRef),
  ].filter((profileRef): profileRef is string => Boolean(profileRef)));
  const agentRequirements = agentProfileRefs
    .flatMap((profileRef): NodeRequirement[] => {
      const authProfile = authProfileById.get(profileRef);
      if (authProfile) {
        return authProfile.status === "available"
          ? []
          : [{
              label: `${authProfile.displayName}: ${statusLabel(authProfile.status)}`,
              status: authProfile.status,
              recovery: authProfile.summary,
              settingsLink: {
                tab: "general",
                target: { type: "provider", id: authProfile.id, label: authProfile.displayName },
              },
            }];
      }
      const llmProfile = llmProfileById.get(profileRef);
      if (!llmProfile) {
        return [{
          label: `Missing AI profile ${profileRef}`,
          status: "missing",
          recovery: "Configure an AI provider profile before enabling this workflow.",
          settingsLink: {
            tab: "general",
            target: { type: "provider", id: slugTargetId(profileRef), label: profileRef },
          },
        }];
      }
      const provider = providerById.get(llmProfile.providerId);
      const requirement = providerRequirement(provider, llmProfile.providerId);
      return requirement ? [requirement] : [];
    });
  const agentNames = agentProfileRefs.map((profileRef) => {
    const authProfile = authProfileById.get(profileRef);
    if (authProfile) return `${authProfile.displayName} / ${authProfile.model}`;
    const llmProfile = llmProfileById.get(profileRef);
    if (llmProfile) return `${llmProfile.providerId} / ${llmProfile.model}`;
    return profileRef;
  });

  const artifactSteps = steps.filter((step) => {
    const outputSchema = step.inputs.output_schema;
    return (
      step.action === "generate_artifact" ||
      step.inputs.template != null ||
      outputSchema === "artifact_envelope"
    );
  });
  const artifactStepIds = artifactSteps.map((step) => step.id);
  const toolsAndPermissions = describeToolsAndPermissions(steps, workflow);
  const toolStepIds = steps
    .filter((step) => step.permissions.length > 0 || arrayHasTools(step.inputs.allowed_tools))
    .map((step) => step.id);

  const destinationRefs = unique([
    workflow.definition.defaults.destinationRef,
    ...steps.map((step) => step.destinationRef).filter((ref): ref is string => Boolean(ref)),
  ]);
  const destinationRequirements = destinationRefs
    .map((ref) => {
      const providerId = destinationProviderId(ref);
      return providerRequirement(providerId ? providerById.get(providerId) : undefined, ref);
    })
    .filter((requirement): requirement is NodeRequirement => requirement != null);
  const destinationNames = destinationRefs.map((ref) => {
    const provider = providerById.get(destinationProviderId(ref) ?? ref);
    return provider?.name ?? ref;
  });
  const destinationStepIds = steps
    .filter((step) => step.destinationRef || step.action === "write_artifact")
    .map((step) => step.id);

  const approvalStatus = pendingApproval?.workflowName === workflow.definition.name ? "blocked" : "available";

  return [
    {
      id: "trigger",
      type: "Trigger",
      role: "Entry point",
      name: workflow.definition.schedule?.cadence === "manual" ? "Manual run" : "Scheduled run",
      status: workflow.status,
      keyConfig: formatSchedule(workflow.definition.schedule),
      details: [
        ["Role", "Entry point"],
        ["Workflow status", statusLabel(workflow.status)],
        ["Schedule", formatSchedule(workflow.definition.schedule)],
        ["Last run", latestRun ? `${statusLabel(latestRun.status)} ${formatRelativeTime(latestRun.startedAt)}` : "No runs yet"],
      ],
      requirements: [],
      stepIds: [],
      editableFields: [
        { id: "status", label: "Edit status" },
      ],
      unavailableEdits: [
        {
          label: "Workflow name and description",
          reason: "Not supported by safe edits",
        },
      ],
    },
    {
      id: "context",
      type: "Context",
      role: "Source",
      name: contextNames.length > 0 ? contextNames.join(", ") : "Direct prompt",
      status: nodeStatus("available", contextRequirements, activeSteps, contextSteps.map((step) => step.id)),
      keyConfig:
        contextSteps.length > 0
          ? contextSteps.map((step) => `${step.name}: ${describeInputs(step)}`).join(" | ")
          : "No external context provider",
      details: [
        ["Role", "Source"],
        ["Steps", contextSteps.length > 0 ? contextSteps.map((step) => step.name).join(", ") : "No context collection step"],
        ["Providers", contextNames.length > 0 ? contextNames.join(", ") : "None"],
      ],
      requirements: contextRequirements,
      stepIds: contextSteps.map((step) => step.id),
      editableFields: [],
      unavailableEdits: [
        {
          label: "Context source enable/disable",
          reason: "Not supported by safe edits",
          settingsLink: { tab: "context" },
        },
      ],
    },
    {
      id: "agent",
      type: "Agent/model",
      role: "Execution",
      name: agentSteps.length > 0 ? agentSteps.map((step) => step.name).join(", ") : "No AI generation step",
      status: nodeStatus(agentSteps.length > 0 ? "available" : "needs_config", agentRequirements, activeSteps, agentSteps.map((step) => step.id)),
      keyConfig: agentNames.length > 0 ? agentNames.join(", ") : "No AI profile configured",
      details: [
        ["Role", "Execution"],
        ["Provider / model", agentNames.length > 0 ? agentNames.join(", ") : "None"],
        ["Profiles", agentNames.length > 0 ? agentNames.join(", ") : "None"],
        ["Steps", agentSteps.length > 0 ? agentSteps.map((step) => step.name).join(", ") : "No agent or LLM step"],
      ],
      requirements: agentRequirements,
      stepIds: agentSteps.map((step) => step.id),
      editableFields: [{ id: "provider", label: "Edit provider" }],
      unavailableEdits: [
        {
          label: "Workflow name and description",
          reason: "Not supported by safe edits",
        },
      ],
    },
    {
      id: "tools",
      type: "Tools/permissions",
      role: "Policy",
      name: toolsAndPermissions.length > 0 ? `${toolsAndPermissions.length} allowed` : "No tools declared",
      status: toolsAndPermissions.length > 0 ? "available" : "needs_config",
      keyConfig: toolsAndPermissions.length > 0 ? toolsAndPermissions.slice(0, 4).join(", ") : "No permissions or tools declared",
      details: [
        ["Role", "Execution policy"],
        ["Workflow permissions", workflow.definition.permissions.join(", ") || "None"],
        ["Step permissions", unique(steps.flatMap((step) => step.permissions)).join(", ") || "None"],
        ["Allowed tools", unique(steps.flatMap((step) => {
          const allowedTools = step.inputs.allowed_tools;
          return Array.isArray(allowedTools)
            ? allowedTools.filter((tool): tool is string => typeof tool === "string")
            : [];
        })).join(", ") || "None"],
      ],
      requirements: [],
      stepIds: toolStepIds,
      editableFields: [],
      unavailableEdits: [
        {
          label: "Tool and permission changes",
          reason: "Not supported by safe edits",
        },
      ],
    },
    {
      id: "approval",
      type: "Approval",
      role: "Review gate",
      name:
        workflow.approvalMode === "auto_approve"
          ? "Auto-approve"
          : workflow.approvalMode === "review_changes"
            ? "Review changes"
            : "Always review",
      status: approvalStatus,
      keyConfig: pendingApproval?.workflowName === workflow.definition.name ? pendingApproval.description : statusLabel(workflow.approvalMode),
      details: [
        ["Role", "Review gate"],
        ["Mode", statusLabel(workflow.approvalMode)],
        ["Pending approval", pendingApproval?.workflowName === workflow.definition.name ? pendingApproval.description : "None"],
      ],
      requirements: [],
      stepIds: [],
      editableFields: [{ id: "approval", label: "Edit approval mode" }],
      unavailableEdits: [],
    },
    {
      id: "artifact",
      type: "Artifact",
      role: "Artifact output",
      name:
        artifactSteps.length > 0
          ? artifactSteps.map((step) => step.name).join(", ")
          : artifacts.length > 0
            ? "Generated artifact"
            : "No artifact step",
      status: nodeStatus(artifactSteps.length > 0 || artifacts.length > 0 ? "available" : "needs_config", [], activeSteps, artifactStepIds),
      keyConfig:
        artifacts.length > 0
          ? `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}; latest ${latestArtifact ? formatRelativeTime(latestArtifact.createdAt) : "unknown"}`
          : artifactSteps.length > 0
            ? artifactSteps.map((step) => describeInputs(step)).join(" | ")
            : "No generated artifacts",
      details: [
        ["Role", "Artifact output"],
        ["Artifact count", String(artifacts.length)],
        ["Latest artifact", latestArtifact ? `${latestArtifact.title} (${formatRelativeTime(latestArtifact.createdAt)})` : "None"],
        ["Artifact steps", artifactSteps.length > 0 ? artifactSteps.map((step) => step.name).join(", ") : "None"],
      ],
      requirements: [],
      stepIds: artifactStepIds,
      editableFields: [],
      unavailableEdits: [
        {
          label: "Artifact type",
          reason: "Not supported by safe edits",
        },
      ],
    },
    {
      id: "destination",
      type: "Destination",
      role: "Delivery",
      name: destinationNames.length > 0 ? destinationNames.join(", ") : "No destination",
      status: nodeStatus("available", destinationRequirements, activeSteps, destinationStepIds),
      keyConfig: destinationRefs.length > 0 ? destinationRefs.join(", ") : "No destination configured",
      details: [
        ["Role", "Destination"],
        ["Default destination", workflow.definition.defaults.destinationRef],
        ["Destination steps", destinationStepIds.length > 0 ? destinationStepIds.join(", ") : "No write step"],
      ],
      requirements: destinationRequirements,
      stepIds: destinationStepIds,
      editableFields: [],
      unavailableEdits: [
        {
          label: "Artifact destination",
          reason: "Not supported by safe edits",
          settingsLink: { tab: "general" },
        },
      ],
    },
    {
      id: "schedule",
      type: "Schedule",
      role: "Timing",
      name: workflow.definition.schedule?.cadence === "manual" ? "Manual" : "Scheduled",
      status: workflow.status === "disabled" ? "disabled" : "available",
      keyConfig: formatSchedule(workflow.definition.schedule),
      details: [
        ["Role", "Schedule"],
        ["Cadence", workflow.definition.schedule?.cadence ?? "manual"],
        ["Run time", workflow.definition.schedule?.localTime ?? "Not set"],
        ["Next run", formatSchedule(workflow.definition.schedule)],
      ],
      requirements: [],
      stepIds: [],
      editableFields: [
        { id: "schedule", label: "Edit schedule" },
        { id: "time", label: "Edit run time" },
      ],
      unavailableEdits: [],
    },
  ];
}

function arrayHasTools(value: unknown): boolean {
  return Array.isArray(value) && value.some((tool) => typeof tool === "string");
}

function uniqueStepId(steps: WorkflowStepDefinition[], baseLabel: string): string {
  const existing = new Set(steps.map((step) => step.id));
  const base = baseLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "step";
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function artifactSourceStep(steps: WorkflowStepDefinition[]): WorkflowStepDefinition | undefined {
  return steps.find((step) => step.kind === "agent_task") ??
    steps.find((step) => step.action === "generate_artifact" || step.inputs.output_schema === "artifact_envelope");
}

function templateUnavailableReason(
  template: BuilderStepTemplate,
  workflow: WorkflowVersion,
): string | null {
  if (template.id !== "notification") {
    return "This template requires runtime support for checkpoint steps before it can be saved.";
  }
  const steps = workflow.definition.steps;
  if (steps.some((step) => step.provider === "local_app" && step.action === "write_artifact")) {
    return "This workflow already has an artifact sink.";
  }
  if (!artifactSourceStep(steps)) {
    return "Add an artifact-producing step before adding a completion sink.";
  }
  return null;
}

function stepForTemplate(
  template: BuilderStepTemplate,
  workflow: WorkflowVersion,
): WorkflowStepDefinition | null {
  const steps = workflow.definition.steps;
  if (templateUnavailableReason(template, workflow)) return null;
  const source = artifactSourceStep(steps);
  if (!source) return null;

  return {
    kind: "provider_action",
    id: uniqueStepId(steps, template.id),
    name: template.label,
    provider: "local_app",
    action: "write_artifact",
    dependsOn: [source.id],
    permissions: ["artifact:write"],
    destinationRef: workflow.definition.defaults.destinationRef,
    inputs: {
      artifact: `$steps.${source.id}.artifact`,
      builder_note: template.description,
    },
  };
}

function insertStepAfterAnchor(
  definition: RavenWorkflow,
  step: WorkflowStepDefinition,
  anchorStepId?: string,
): RavenWorkflow {
  const anchorIndex = anchorStepId
    ? definition.steps.findIndex((candidate) => candidate.id === anchorStepId)
    : -1;
  const dependsOn = anchorStepId ? [anchorStepId] : [];
  const nextStep = { ...step, dependsOn: step.dependsOn.length > 0 ? step.dependsOn : dependsOn };
  const nextSteps =
    anchorIndex >= 0
      ? [
          ...definition.steps.slice(0, anchorIndex + 1),
          nextStep,
          ...definition.steps.slice(anchorIndex + 1).map((candidate) =>
            candidate.dependsOn.includes(anchorStepId!)
              ? {
                  ...candidate,
                  dependsOn: candidate.dependsOn.map((dependency) =>
                    dependency === anchorStepId ? nextStep.id : dependency,
                  ),
                }
              : candidate,
          ),
        ]
      : [...definition.steps, nextStep];

  return {
    ...definition,
    permissions: unique([...definition.permissions, ...nextStep.permissions]),
    steps: nextSteps,
  };
}

function removeStepFromDefinition(definition: RavenWorkflow, stepId: string): RavenWorkflow {
  const removedStep = definition.steps.find((step) => step.id === stepId);
  if (!removedStep) return definition;
  const nextSteps = definition.steps
    .filter((step) => step.id !== stepId)
    .map((step) => {
      if (!step.dependsOn.includes(stepId)) return step;
      return {
        ...step,
        dependsOn: unique([
          ...step.dependsOn.filter((dependency) => dependency !== stepId),
          ...removedStep.dependsOn,
        ]),
      };
    });
  return { ...definition, steps: nextSteps };
}

function moveStep(definition: RavenWorkflow, draggedStepId: string, targetStepId: string): RavenWorkflow {
  if (draggedStepId === targetStepId) return definition;
  if (!isLinearStepChain(definition.steps)) return definition;
  const draggedIndex = definition.steps.findIndex((step) => step.id === draggedStepId);
  const targetIndex = definition.steps.findIndex((step) => step.id === targetStepId);
  if (draggedIndex < 0 || targetIndex < 0) return definition;
  const nextSteps = [...definition.steps];
  const [draggedStep] = nextSteps.splice(draggedIndex, 1);
  nextSteps.splice(targetIndex, 0, draggedStep);
  return { ...definition, steps: rewriteLinearDependencies(nextSteps) };
}

function isLinearStepChain(steps: WorkflowStepDefinition[]): boolean {
  return steps.every((step, index) => {
    if (index === 0) return step.dependsOn.length === 0;
    return step.dependsOn.length === 1 && step.dependsOn[0] === steps[index - 1].id;
  });
}

function rewriteLinearDependencies(steps: WorkflowStepDefinition[]): WorkflowStepDefinition[] {
  return steps.map((step, index) => ({
    ...step,
    dependsOn: index === 0 ? [] : [steps[index - 1].id],
  }));
}

function buildBuilderDiffs(original: RavenWorkflow | undefined, current: RavenWorkflow): string[] {
  if (!original) return [];
  const originalById = new Map(original.steps.map((step) => [step.id, step]));
  const currentById = new Map(current.steps.map((step) => [step.id, step]));
  const diffs: string[] = [];

  for (const step of current.steps) {
    if (!originalById.has(step.id)) diffs.push(`Add ${step.name}`);
  }
  for (const step of original.steps) {
    if (!currentById.has(step.id)) diffs.push(`Remove ${step.name}`);
  }
  for (const step of current.steps) {
    const originalStep = originalById.get(step.id);
    if (!originalStep) continue;
    if (JSON.stringify(originalStep.dependsOn) !== JSON.stringify(step.dependsOn)) {
      diffs.push(`Update dependencies for ${step.name}`);
    }
    if (originalStep.name !== step.name) {
      diffs.push(`Rename ${originalStep.name} to ${step.name}`);
    }
  }
  if (
    original.steps.map((step) => step.id).join("|") !==
    current.steps.map((step) => step.id).join("|")
  ) {
    diffs.push("Reorder workflow steps");
  }
  return unique(diffs);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function validationSummaryParts(schemaIssueCount: number, builderRequirementCount: number): string[] {
  const parts: string[] = [];
  if (schemaIssueCount > 0) parts.push(pluralize(schemaIssueCount, "schema issue"));
  if (builderRequirementCount > 0) parts.push(pluralize(builderRequirementCount, "builder requirement"));
  return parts;
}

function preflightStatusForNode(
  manifest: PreflightManifest | null | undefined,
  stepIds: string[],
): { blocked: number; needsGrant: number } {
  if (!manifest || stepIds.length === 0) return { blocked: 0, needsGrant: 0 };
  const stepIdSet = new Set(stepIds);
  return manifest.capabilities.reduce(
    (count, capability) => {
      if (!stepIdSet.has(capability.stepId)) return count;
      if (capability.policyDecision === "blocked" || capability.policyDecision === "hidden") {
        return { ...count, blocked: count.blocked + 1 };
      }
      if (capability.policyDecision === "needs_grant") {
        return { ...count, needsGrant: count.needsGrant + 1 };
      }
      return count;
    },
    { blocked: 0, needsGrant: 0 },
  );
}

function previewStepSummary(step: WorkflowStepDefinition, index: number): PreviewStepSummary {
  return {
    id: step.id,
    label: `${index + 1}. ${step.name}`,
    detail:
      step.dependsOn.length > 0
        ? `${step.provider}.${step.action} after ${step.dependsOn.join(", ")}`
        : `${step.provider}.${step.action} starts from the trigger`,
  };
}

function buildPreviewStages(steps: WorkflowStepDefinition[]): PreviewStage[] {
  if (steps.length === 0) return [];
  if (isLinearStepChain(steps)) {
    return [{
      id: "linear-path",
      title: "Run path",
      description: "Ordered execution from trigger to destination.",
      steps: steps.map(previewStepSummary),
    }];
  }

  const stepById = new Map(steps.map((step) => [step.id, step]));
  const levelByStepId = new Map<string, number>();

  const levelForStep = (step: WorkflowStepDefinition): number => {
    const cached = levelByStepId.get(step.id);
    if (cached != null) return cached;
    if (step.dependsOn.length === 0) {
      levelByStepId.set(step.id, 0);
      return 0;
    }
    const nextLevel = Math.max(
      ...step.dependsOn.map((dependencyId) => {
        const dependency = stepById.get(dependencyId);
        return dependency ? levelForStep(dependency) : 0;
      }),
    ) + 1;
    levelByStepId.set(step.id, nextLevel);
    return nextLevel;
  };

  const stageMap = new Map<number, WorkflowStepDefinition[]>();
  for (const step of steps) {
    const level = levelForStep(step);
    const existing = stageMap.get(level) ?? [];
    existing.push(step);
    stageMap.set(level, existing);
  }

  return Array.from(stageMap.entries())
    .sort(([left], [right]) => left - right)
    .map(([level, stageSteps]) => {
      const title = level === 0
        ? "Entry stage"
        : stageSteps.some((step) => step.dependsOn.length > 1)
          ? "Merge stage"
          : stageSteps.length > 1
            ? "Parallel branch stage"
            : "Downstream stage";
      const description = level === 0
        ? "These steps can start immediately from the trigger."
        : stageSteps.some((step) => step.dependsOn.length > 1)
          ? "These steps wait for multiple upstream branches to finish."
          : stageSteps.length > 1
            ? "These steps can proceed in parallel after the prior stage."
            : "This step continues after the prior stage resolves.";
      return {
        id: `stage-${level}`,
        title,
        description,
        steps: stageSteps.map((step, index) => previewStepSummary(step, index)),
      };
    });
}

export function WorkflowDag(props: WorkflowDagProps) {
  const nodes = useMemo(() => buildWorkflowBuilderNodes(props), [props]);
  const [selectedNodeId, setSelectedNodeId] = useState<BuilderNodeId>("trigger");
  const [draggedStepId, setDraggedStepId] = useState<string | null>(null);
  const [activeBuilderAction, setActiveBuilderAction] = useState<BuilderActionId>("validate");
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0];
  const validationCount = nodes.reduce((count, node) => count + node.requirements.length, 0);
  const validation = useMemo(
    () => validateWorkflowDefinition(props.workflow.definition, [], props.capabilities ?? []),
    [props.capabilities, props.workflow.definition],
  );
  const schemaIssueCount = validation.errors.length;
  const selectedExistingSteps = props.workflow.definition.steps.filter((step) =>
    selectedNode.stepIds.includes(step.id),
  );
  const hasWorkflowSteps = props.workflow.definition.steps.length > 0;
  const stagedDiffs = buildBuilderDiffs(props.originalDefinition, props.workflow.definition);
  const canEditDefinition = Boolean(props.onChangeDefinition);
  const canReorderDefinition = canEditDefinition && isLinearStepChain(props.workflow.definition.steps);
  const previewStages = useMemo(
    () => buildPreviewStages(props.workflow.definition.steps),
    [props.workflow.definition.steps],
  );
  const previewIsLinear = previewStages.length === 1 && previewStages[0]?.id === "linear-path";
  const nodeSettingsLink =
    selectedNode.requirements.find((requirement) => requirement.settingsLink)?.settingsLink ??
    selectedNode.unavailableEdits.find((edit) => edit.settingsLink)?.settingsLink;
  const canConfigureNode = (props.onEditField && selectedNode.editableFields.length > 0) ||
    (props.onOpenSettingsTarget && nodeSettingsLink);
  const moveHelperText =
    selectedExistingSteps.length === 0
      ? "No executable step is attached to this stage yet."
      : canReorderDefinition
        ? "Use the Move up and Move down controls below to reorder the current linear run path."
        : "Move is only supported for single-chain workflows in the guided builder.";
  const disableHelperText = selectedNode.id === "trigger" || selectedNode.id === "schedule"
    ? "Use the workflow status control to disable runs for this workflow."
    : "Per-step disable is not persisted yet. Create a draft version when you need structural step changes.";
  const addStepTemplates = stepTemplates.filter((template) => template.id === "notification");
  const validationSummary = validationSummaryParts(schemaIssueCount, validationCount);
  const bannerTitle = !hasWorkflowSteps && schemaIssueCount === 0
    ? "Start this workflow with a source step"
    : validationSummary.length > 0
      ? validationSummary.join(" and ")
      : "Builder validation clear";
  const bannerMessage = !hasWorkflowSteps && schemaIssueCount === 0
    ? "The workflow shell is ready; add the first provider or agent step before attaching artifact and destination steps."
    : schemaIssueCount > 0
      ? "Open Validate workflow to review schema issues before saving this version."
      : validationCount > 0
        ? "Open highlighted nodes to fix setup requirements."
        : "No schema errors or missing builder requirements detected.";
  const validationActionMessage = validationSummary.length === 0
    ? "No schema errors or missing builder requirements detected."
    : `Resolve ${validationSummary.join(" and ")} before saving this version.`;

  const addTemplateStep = (template: BuilderStepTemplate) => {
    if (!props.onChangeDefinition) return;
    const step = stepForTemplate(template, props.workflow);
    if (!step) return;
    const anchorStepId = step.dependsOn[0] ?? selectedExistingSteps[selectedExistingSteps.length - 1]?.id;
    props.onChangeDefinition(insertStepAfterAnchor(props.workflow.definition, step, anchorStepId));
  };

  const removeExistingStep = (stepId: string) => {
    props.onChangeDefinition?.(removeStepFromDefinition(props.workflow.definition, stepId));
  };

  const moveSelectedStep = (stepId: string, direction: -1 | 1) => {
    if (!props.onChangeDefinition) return;
    const index = props.workflow.definition.steps.findIndex((step) => step.id === stepId);
    const targetStep = props.workflow.definition.steps[index + direction];
    if (!targetStep) return;
    props.onChangeDefinition(moveStep(props.workflow.definition, stepId, targetStep.id));
  };

  const dropStepOn = (targetStepId: string) => {
    if (!draggedStepId || !props.onChangeDefinition) return;
    props.onChangeDefinition(moveStep(props.workflow.definition, draggedStepId, targetStepId));
    setDraggedStepId(null);
  };

  return (
    <div className={`workflow-builder${hasWorkflowSteps ? "" : " workflow-builder-empty"}`} aria-label="Visual workflow builder">
      <div className={`workflow-builder-validation${validationSummary.length > 0 ? " has-issues" : ""}`} role="status">
        <strong>
          {bannerTitle}
        </strong>
        <span>{bannerMessage}</span>
      </div>
      <div className="workflow-builder-actions" aria-label="Builder actions">
        <button
          type="button"
          className={activeBuilderAction === "add-step" ? "workflow-builder-action-active" : ""}
          onClick={() => setActiveBuilderAction("add-step")}
        >
          <Plus size={16} aria-hidden="true" />
          Add step
        </button>
        <button
          type="button"
          className={activeBuilderAction === "validate" ? "workflow-builder-action-active" : ""}
          onClick={() => setActiveBuilderAction("validate")}
        >
          <ShieldCheck size={16} aria-hidden="true" />
          Validate workflow
        </button>
        <button
          type="button"
          className={activeBuilderAction === "preview" ? "workflow-builder-action-active" : ""}
          onClick={() => setActiveBuilderAction("preview")}
        >
          <Route size={16} aria-hidden="true" />
          Preview run path
        </button>
        <button
          type="button"
          className={activeBuilderAction === "diff" ? "workflow-builder-action-active" : ""}
          onClick={() => setActiveBuilderAction("diff")}
        >
          <GitCompareArrows size={16} aria-hidden="true" />
          Review version diff
        </button>
      </div>
      <section className="workflow-builder-action-panel" aria-live="polite">
        {activeBuilderAction === "add-step" && (
          <div className="workflow-builder-action-copy">
            <div>
              <span className="workflow-node-type">Safe edit path</span>
              <h3>Add steps through a guided draft</h3>
              <p>
                Arbitrary step persistence is still limited in the guided builder. Use supported templates here,
                or create a draft version when you need a new provider, branching logic, or permission changes.
              </p>
            </div>
            <div className="workflow-builder-action-grid">
              <article>
                <strong>Safe now</strong>
                <ul>
                  <li>Add supported completion templates.</li>
                  <li>Reorder linear runs before saving a new version.</li>
                  <li>Remove a staged step and review the version diff.</li>
                </ul>
              </article>
              <article>
                <strong>Needs draft creation</strong>
                <ul>
                  <li>Insert arbitrary provider or agent steps.</li>
                  <li>Change branching structure or disable a single step.</li>
                  <li>Modify workflow permissions or destinations.</li>
                </ul>
              </article>
            </div>
            <div className="workflow-builder-guided-actions" aria-label="Guided add step actions">
              {addStepTemplates.map((template) => {
                const unavailableReason = templateUnavailableReason(template, props.workflow);
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => addTemplateStep(template)}
                    disabled={!canEditDefinition || unavailableReason != null}
                  >
                    Add {template.label.toLowerCase()}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {activeBuilderAction === "validate" && (
          <div className="workflow-builder-action-copy">
            <div>
              <span className="workflow-node-type">Builder validation</span>
              <h3>{validation.valid && validationCount === 0 ? "Workflow validation is ready to save." : "Workflow validation needs attention."}</h3>
              <p>
                {validationActionMessage}
              </p>
            </div>
            {(validation.errors.length > 0 || validationCount > 0) && (
              <div className="workflow-builder-action-grid">
                {validation.errors.length > 0 && (
                  <article>
                    <strong>Schema</strong>
                    <ul>
                      {validation.errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </article>
                )}
                {validationCount > 0 && (
                  <article>
                    <strong>Builder requirements</strong>
                    <ul>
                      {nodes.flatMap((node) =>
                        node.requirements.map((requirement) => (
                          <li key={`${node.id}-${requirement.label}`}>{node.type}: {requirement.label}</li>
                        )),
                      )}
                    </ul>
                  </article>
                )}
              </div>
            )}
          </div>
        )}
        {activeBuilderAction === "preview" && (
          <div className="workflow-builder-action-copy">
            <div>
              <span className="workflow-node-type">{previewIsLinear ? "Execution order" : "Execution structure"}</span>
              <h3>{previewIsLinear ? "Run path preview" : "Branching workflow structure"}</h3>
              <p>
                {previewIsLinear
                  ? "Review the current execution order before reordering or saving a new workflow version."
                  : "This grouped preview shows entry, branch, and merge stages without pretending there is a single execution path."}
              </p>
            </div>
            <div className="workflow-builder-preview-sections">
              {previewStages.map((stage) => (
                <section key={stage.id} className="workflow-builder-preview-section">
                  <div className="workflow-builder-preview-heading">
                    <strong>{stage.title}</strong>
                    <small>{stage.description}</small>
                  </div>
                  <ol className="workflow-builder-preview-list">
                    {stage.steps.map((step) => (
                      <li key={step.id}>
                        <strong>{step.label}</strong>
                        <small>{step.detail}</small>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          </div>
        )}
        {activeBuilderAction === "disable" && (
          <div className="workflow-builder-action-copy">
            <div>
              <span className="workflow-node-type">Disable guidance</span>
              <h3>{selectedNode.id === "trigger" || selectedNode.id === "schedule" ? "Disable the workflow from status controls" : "Disable this stage through a draft version"}</h3>
              <p>{disableHelperText}</p>
            </div>
            <div className="workflow-builder-action-grid">
              <article>
                <strong>Available now</strong>
                <ul>
                  <li>Set workflow status to disabled to stop new runs.</li>
                  <li>Keep the current version for history and approvals.</li>
                </ul>
                {props.onEditField && (
                  <button type="button" onClick={() => props.onEditField?.("status")}>
                    Edit workflow status
                  </button>
                )}
              </article>
              <article>
                <strong>Needs a draft version</strong>
                <ul>
                  <li>Disable a single node or step without disabling the whole workflow.</li>
                  <li>Restructure branches or dependencies around a removed step.</li>
                </ul>
              </article>
            </div>
          </div>
        )}
        {activeBuilderAction === "diff" && (
          <div className="workflow-builder-action-copy">
            <div>
              <span className="workflow-node-type">Version review</span>
              <h3>Version diff review</h3>
              <p>
                {stagedDiffs.length > 0
                  ? "Review staged structural changes before saving the next version."
                  : "No unsaved builder changes yet."}
              </p>
            </div>
            {stagedDiffs.length > 0 && (
              <ul className="workflow-builder-preview-list">
                {stagedDiffs.map((diff) => (
                  <li key={diff}>
                    <strong>{diff}</strong>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
      {!hasWorkflowSteps && (
        <section className="workflow-builder-start-panel" aria-label="Empty workflow builder start panel">
          <div>
            <span className="workflow-node-type">Empty canvas</span>
            <h3>Build the first working step</h3>
            <p>
              Configure the trigger, provider, and approval rules here, then add a source step from Create Hub
              or a template before wiring artifact delivery.
            </p>
          </div>
          <div className="workflow-builder-start-actions">
            <button type="button" onClick={() => setSelectedNodeId("trigger")}>
              Review trigger
            </button>
            <button type="button" onClick={() => setSelectedNodeId("agent")}>
              Check provider
            </button>
            <button type="button" onClick={() => setSelectedNodeId("approval")}>
              Set approval
            </button>
          </div>
        </section>
      )}
      <div className="workflow-builder-chain">
        {nodes.map((node, index) => (
          <div className="workflow-builder-stage" key={node.id}>
            <button
              type="button"
              className={`workflow-node${selectedNode.id === node.id ? " workflow-node-selected" : ""}`}
              onClick={() => setSelectedNodeId(node.id)}
              aria-pressed={selectedNode.id === node.id}
            >
              <span className="workflow-node-type">{node.type}</span>
              <span className="workflow-node-role">{node.role}</span>
              <strong>{node.name}</strong>
              <StatusIndicator status={node.status} />
              <span className="workflow-node-config">{node.keyConfig}</span>
              {node.requirements.length > 0 && (
                <span className="workflow-node-requirements" aria-label={`${node.type} validation`}>
                  <AlertTriangle size={14} aria-hidden="true" />
                  {node.requirements.length} requirement{node.requirements.length === 1 ? "" : "s"}
                </span>
              )}
              {(() => {
                const preflightStatus = preflightStatusForNode(props.preflightManifest, node.stepIds);
                if (preflightStatus.blocked > 0) {
                  return (
                    <span className="workflow-node-preflight workflow-node-preflight-blocked">
                      {preflightStatus.blocked} blocked
                    </span>
                  );
                }
                if (preflightStatus.needsGrant > 0) {
                  return (
                    <span className="workflow-node-preflight workflow-node-preflight-needs-grant">
                      {preflightStatus.needsGrant} pre-approval
                    </span>
                  );
                }
                return null;
              })()}
            </button>
            {index < nodes.length - 1 && (
              <ChevronRight className="workflow-builder-arrow" size={18} aria-hidden="true" />
            )}
          </div>
        ))}
      </div>

      <aside className="workflow-node-inspector" aria-label={`${selectedNode.type} inspector`}>
        <div className="section-heading">
          <h3>{selectedNode.type}</h3>
          <StatusIndicator status={selectedNode.status} />
        </div>
        <strong>{selectedNode.name}</strong>
        <span className="workflow-node-role-summary">{selectedNode.role}</span>
        <dl>
          {selectedNode.details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {selectedNode.requirements.length > 0 && (
          <div className="workflow-node-alerts" role="status">
            {selectedNode.requirements.map((requirement) => (
              <div key={`${requirement.label}-${requirement.status}`}>
                <AlertTriangle size={14} aria-hidden="true" />
                <span>
                  <strong>{requirement.label}</strong>
                  {requirement.recovery && <small>{requirement.recovery}</small>}
                </span>
                {requirement.settingsLink && props.onOpenSettingsTarget && (
                  <button
                    type="button"
                    onClick={() => props.onOpenSettingsTarget?.(
                      requirement.settingsLink!.tab,
                      requirement.settingsLink!.target,
                    )}
                  >
                    Configure in Settings
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {props.onEditField && selectedNode.editableFields.length > 0 && (
          <div className="workflow-node-edit-links" aria-label={`${selectedNode.type} safe edit controls`}>
            {selectedNode.editableFields.map((field) => (
              <button key={field.id} type="button" onClick={() => props.onEditField?.(field.id)}>
                {field.label}
              </button>
            ))}
          </div>
        )}
        <div className="workflow-node-affordances" aria-label={`${selectedNode.type} builder affordances`}>
          <div className="workflow-node-affordance-buttons">
            <button
              type="button"
              onClick={() => {
                if (props.onEditField && selectedNode.editableFields.length > 0) {
                  props.onEditField(selectedNode.editableFields[0].id);
                  return;
                }
                if (nodeSettingsLink && props.onOpenSettingsTarget) {
                  props.onOpenSettingsTarget(nodeSettingsLink.tab, nodeSettingsLink.target);
                }
              }}
              disabled={!canConfigureNode}
            >
              Configure
            </button>
            <button type="button" onClick={() => setActiveBuilderAction("preview")}>
              Move
            </button>
            <button type="button" onClick={() => setActiveBuilderAction("disable")}>
              Disable options
            </button>
          </div>
          <div className="workflow-node-affordance-copy">
            <small>{canConfigureNode ? "Configure opens the safe field editor or related settings target for this stage." : "No safe configuration control is wired for this stage yet."}</small>
            <small>{moveHelperText}</small>
            <small>{disableHelperText}</small>
          </div>
        </div>
        <section className="workflow-step-lab" aria-label={`${selectedNode.type} step editing`}>
          <div className="workflow-step-lab-heading">
            <strong>Step editor</strong>
            <span>Add, remove, reorder, review the diff, then save a new workflow version.</span>
          </div>
          {canEditDefinition && hasWorkflowSteps && !canReorderDefinition && (
            <p className="workflow-step-lab-empty">
              Branching workflow ordering is read-only in the guided builder.
            </p>
          )}
          {selectedExistingSteps.length > 0 ? (
            <div className="workflow-step-lab-list">
              {selectedExistingSteps.map((step) => {
                const stepIndex = props.workflow.definition.steps.findIndex((candidate) => candidate.id === step.id);
                return (
                <article
                  key={step.id}
                  draggable={canReorderDefinition}
                  onDragStart={() => setDraggedStepId(step.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropStepOn(step.id);
                  }}
                >
                  <span>
                    <strong>{step.name}</strong>
                    <small>{step.provider}.{step.action}</small>
                    <small>{selectedNode.role} role{step.llmProfileRef ? ` · ${step.llmProfileRef}` : ""}</small>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (props.onEditField && selectedNode.editableFields.length > 0) {
                        props.onEditField(selectedNode.editableFields[0].id);
                      }
                    }}
                    disabled={!props.onEditField || selectedNode.editableFields.length === 0}
                  >
                    Configure
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSelectedStep(step.id, -1)}
                    disabled={!canReorderDefinition || stepIndex <= 0}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSelectedStep(step.id, 1)}
                    disabled={!canReorderDefinition || stepIndex === props.workflow.definition.steps.length - 1}
                  >
                    Move down
                  </button>
                  <button type="button" disabled title="Per-step disable is only available through a draft version today.">
                    Disable via draft
                  </button>
                  <button type="button" onClick={() => removeExistingStep(step.id)} disabled={!canEditDefinition}>
                    Remove step
                  </button>
                  <button type="button" disabled title="Step-level dry runs require backend support for isolated step execution.">
                    Test step unavailable
                  </button>
                  <small className="workflow-step-lab-helper">
                    Configure uses safe field editors when this stage supports them. Disable requires a draft version because per-step disable is not persisted yet.
                  </small>
                </article>
                );
              })}
            </div>
          ) : (
            <p className="workflow-step-lab-empty">
              {hasWorkflowSteps
                ? "No existing steps are attached to this stage."
                : "No executable steps yet. Add a provider or agent step first, then artifact and delivery templates become available."}
            </p>
          )}
          <div className="workflow-step-template-grid" aria-label="Supported step templates">
            {stepTemplates.map((template) => {
              const unavailableReason = templateUnavailableReason(template, props.workflow);
              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => addTemplateStep(template)}
                  disabled={!canEditDefinition || unavailableReason != null}
                  title={unavailableReason ?? undefined}
                >
                  <strong>{template.label}</strong>
                  <small>{unavailableReason ?? template.description}</small>
                </button>
              );
            })}
          </div>
          {stagedDiffs.length > 0 && (
            <div className="workflow-builder-diff" aria-label="Builder diff before saving">
              <header>
                <strong>Unsaved builder diff</strong>
                <span>
                  <button type="button" onClick={props.onUndoDefinition}>
                    <RotateCcw size={14} />
                    Undo draft
                  </button>
                  {props.onSaveDefinition && (
                    <button
                      type="button"
                      className="primary-action"
                      onClick={props.onSaveDefinition}
                      disabled={props.isSavingDefinition}
                    >
                      {props.isSavingDefinition ? "Saving" : "Save builder changes"}
                    </button>
                  )}
                </span>
              </header>
              <ul>
                {stagedDiffs.map((diff) => (
                  <li key={diff}>{diff}</li>
                ))}
              </ul>
              {props.saveNotice && <p>{props.saveNotice}</p>}
            </div>
          )}
        </section>
        {selectedNode.unavailableEdits.length > 0 && (
          <div className="workflow-node-unavailable-edits" aria-label={`${selectedNode.type} unavailable safe edits`}>
            {selectedNode.unavailableEdits.map((edit) => (
              <div key={edit.label}>
                <span>
                  <strong>{edit.label}</strong>
                  <small>{edit.reason}</small>
                </span>
                {edit.settingsLink && props.onOpenSettingsTarget && (
                  <button
                    type="button"
                    onClick={() => props.onOpenSettingsTarget?.(edit.settingsLink!.tab, edit.settingsLink!.target)}
                  >
                    Configure in Settings
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
