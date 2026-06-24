import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityDescriptor, RavenWorkflow, WorkflowVersion } from "../../domain/types";
import { currentWeatherWorkflow, dailyWorkJournalWorkflow } from "../../domain/workflow";
import { WorkflowDag } from "./WorkflowDag";

const branchedWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "branched-workflow",
  name: "Branched Workflow",
  description: "Runs two context branches before composing.",
  permissions: ["git:read", "llm:generate", "artifact:write"],
  defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
  schedule: { cadence: "manual" },
  steps: [
    {
      kind: "provider_action",
      id: "collect-git",
      name: "Collect Git",
      provider: "local_git",
      action: "summarize",
      dependsOn: [],
      permissions: ["git:read"],
      inputs: {},
    },
    {
      kind: "provider_action",
      id: "collect-docs",
      name: "Collect Docs",
      provider: "document_import",
      action: "summarize",
      dependsOn: [],
      permissions: ["document:read"],
      inputs: {},
    },
    {
      kind: "provider_action",
      id: "compose",
      name: "Compose",
      provider: "openai",
      action: "generate",
      dependsOn: ["collect-git", "collect-docs"],
      permissions: ["llm:generate"],
      inputs: {},
      llmProfileRef: "default-openai",
    },
  ],
};

const schemaInvalidWorkflow: RavenWorkflow = {
  ...dailyWorkJournalWorkflow,
  schemaVersion: "9.9.9" as unknown as RavenWorkflow["schemaVersion"],
};

const pluginWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "plugin-fullstack-artifact",
  name: "Plugin Fullstack Artifact",
  description: "Builds an artifact through the deterministic plugin.",
  permissions: ["plugin:execute", "artifact:write"],
  defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
  schedule: { cadence: "manual" },
  steps: [
    {
      kind: "provider_action",
      id: "build-artifact",
      name: "Build plugin artifact",
      provider: "deterministic_artifact",
      action: "build_artifact",
      dependsOn: [],
      permissions: ["plugin:execute"],
      inputs: { subject: "Task 11" },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save plugin artifact",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["build-artifact"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: { artifact: "$steps.build-artifact.artifact" },
    },
  ],
};

const httpProbeWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "http-probe-artifact",
  name: "HTTP Probe Artifact",
  description: "Checks URLs with the deterministic HTTP probe and writes the artifact.",
  permissions: ["network:read", "artifact:write"],
  defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
  schedule: { cadence: "manual" },
  steps: [
    {
      kind: "provider_action",
      id: "check-urls",
      name: "Check URLs",
      provider: "http_probe",
      action: "check_urls",
      dependsOn: [],
      permissions: ["network:read"],
      inputs: { urls: ["https://example.com"] },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save HTTP probe artifact",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["check-urls"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: { artifact: "$steps.check-urls.artifact" },
    },
  ],
};

const pluginCapability: CapabilityDescriptor = {
  id: "deterministic_artifact.build_artifact",
  provider: "deterministic_artifact",
  action: "build_artifact",
  displayName: "Build artifact",
  description: "Builds deterministic artifacts for plugin workflow tests.",
  category: "plugin",
  source: "plugin",
  detectedFrom: "deterministic_artifact",
  version: "0.1.0",
  status: "available",
  executionMode: "open_agentic",
  deterministic: false,
  readOnly: false,
  idempotent: false,
  destructive: false,
  openWorld: true,
  requiresNetwork: false,
  writesFiles: false,
  requiresCredentials: false,
  permissions: ["plugin:execute"],
  intentTags: ["plugin", "deterministic_artifact"],
  bestFor: ["Build artifact"],
  notFor: [],
  builderGuidance: "Use this plugin capability only when the workflow explicitly selects it.",
  fallbackStrategy: "Request an approval grant or choose a registered built-in capability.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  trustTier: "unknown",
  defaultApproval: "always_review",
  adapter: { kind: "plugin", pluginId: "deterministic_artifact", stepAction: "build_artifact", timeoutMs: 5000 },
  signatureHash: "plugin-signature",
};

function workflowVersion(definition: RavenWorkflow): WorkflowVersion {
  return {
    id: `${definition.id}-v1`,
    workflowId: definition.id,
    version: 1,
    status: "enabled",
    approvalMode: "review_changes",
    definition,
    createdAt: "2026-06-19T10:00:00.000Z",
  };
}

function renderWorkflowDag(definition: RavenWorkflow = currentWeatherWorkflow) {
  const providers = definition.id === dailyWorkJournalWorkflow.id
    ? [
        { id: "local_git", name: "Local Git", kind: "context" as const, status: "available" as const, summary: "Ready" },
        { id: "openai", name: "OpenAI", kind: "llm" as const, status: "available" as const, summary: "Ready" },
        { id: "local_app", name: "Local App", kind: "artifact_destination" as const, status: "available" as const, summary: "Ready" },
      ]
    : [
        { id: "local_app", name: "Local App", kind: "artifact_destination" as const, status: "available" as const, summary: "Ready" },
      ];
  const llmProfiles = definition.id === dailyWorkJournalWorkflow.id
    ? [{ id: "default-openai", providerId: "openai", model: "gpt-5", effort: "medium" as const, supportsStructuredOutputs: true }]
    : [];
  const agentAuthProfiles = definition.id === dailyWorkJournalWorkflow.id
    ? []
    : [
        {
          id: "codex-oauth-local",
          displayName: "Codex local",
          runnerKind: "codex_cli" as const,
          authMode: "codex_oauth_local_cli" as const,
          credentialRef: "local",
          model: "gpt-5",
          effort: "medium" as const,
          status: "available" as const,
          summary: "Ready",
        },
      ];
  return render(
    <WorkflowDag
      workflow={workflowVersion(definition)}
      originalDefinition={definition}
      providers={providers}
      llmProfiles={llmProfiles}
      agentAuthProfiles={agentAuthProfiles}
      runs={[]}
      artifacts={[]}
      onChangeDefinition={vi.fn()}
    />,
  );
}

describe("WorkflowDag", () => {
  it("shows builder actions for editing workflow structure", () => {
    renderWorkflowDag();

    expect(screen.getByRole("button", { name: "Add step" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview run path" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review version diff" })).toBeInTheDocument();
  });

  it("opens guided add-step help when arbitrary step persistence is unavailable", async () => {
    const user = userEvent.setup();
    renderWorkflowDag();

    await user.click(screen.getByRole("button", { name: "Add step" }));

    expect(screen.getByText("Add steps through a guided draft")).toBeInTheDocument();
    expect(screen.getByText(/arbitrary step persistence is still limited/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add completion notification" })).toBeInTheDocument();
  });

  it("shows validation results from the builder action", async () => {
    const user = userEvent.setup();
    renderWorkflowDag(dailyWorkJournalWorkflow);

    await user.click(screen.getByRole("button", { name: "Validate workflow" }));

    expect(screen.getByRole("heading", { name: /workflow validation/i })).toBeInTheDocument();
    expect(screen.getAllByText(/no schema errors or missing builder requirements detected/i)).toHaveLength(2);
  });

  it("does not treat available agent tasks as missing context providers", async () => {
    const user = userEvent.setup();
    renderWorkflowDag(currentWeatherWorkflow);

    await user.click(screen.getByRole("button", { name: "Validate workflow" }));

    expect(screen.getAllByText(/no schema errors or missing builder requirements detected/i)).toHaveLength(2);
    expect(screen.queryByText("Context: Missing agent")).not.toBeInTheDocument();
  });

  it("shows auto approval mode in the visual builder approval node", () => {
    render(
      <WorkflowDag
        workflow={{ ...workflowVersion(currentWeatherWorkflow), approvalMode: "auto_approve" }}
        originalDefinition={currentWeatherWorkflow}
        providers={[
          { id: "local_app", name: "Local App", kind: "artifact_destination" as const, status: "available" as const, summary: "Ready" },
        ]}
        llmProfiles={[]}
        agentAuthProfiles={[
          {
            id: "codex-oauth-local",
            displayName: "Codex local",
            runnerKind: "codex_cli" as const,
            authMode: "codex_oauth_local_cli" as const,
            credentialRef: "local",
            model: "gpt-5",
            effort: "medium" as const,
            status: "available" as const,
            summary: "Ready",
          },
        ]}
        runs={[]}
        artifacts={[]}
        onChangeDefinition={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /ApprovalReview gateAuto-approve/i })).toBeInTheDocument();
  });

  it("keeps the builder banner honest when schema validation fails", () => {
    renderWorkflowDag(schemaInvalidWorkflow);

    expect(screen.getByText("1 schema issue")).toBeInTheDocument();
    expect(screen.getByText(/open validate workflow to review schema issues before saving this version/i)).toBeInTheDocument();
    expect(screen.queryByText("Builder validation clear")).not.toBeInTheDocument();
  });

  it("uses registry capabilities when validating plugin-backed workflow steps", () => {
    render(
      <WorkflowDag
        workflow={workflowVersion(pluginWorkflow)}
        originalDefinition={pluginWorkflow}
        providers={[
          { id: "local_app", name: "Local App", kind: "artifact_destination" as const, status: "available" as const, summary: "Ready" },
        ]}
        llmProfiles={[]}
        agentAuthProfiles={[]}
        runs={[]}
        artifacts={[]}
        capabilities={[pluginCapability]}
        onChangeDefinition={vi.fn()}
      />,
    );

    expect(screen.queryByText("Step build-artifact references unavailable provider deterministic_artifact.")).not.toBeInTheDocument();
  });

  it("does not require provider health for deterministic http_probe validation", async () => {
    const user = userEvent.setup();
    renderWorkflowDag(httpProbeWorkflow);

    await user.click(screen.getByRole("button", { name: "Validate workflow" }));

    expect(screen.queryByText(/Missing http_probe/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/no schema errors or missing builder requirements detected/i)).toHaveLength(2);
  });

  it("shows the run path preview from the builder action", async () => {
    const user = userEvent.setup();
    renderWorkflowDag();

    await user.click(screen.getByRole("button", { name: "Preview run path" }));

    expect(screen.getByText("Run path preview")).toBeInTheDocument();
    expect(screen.getByText("1. Ask AI for today's weather")).toBeInTheDocument();
    expect(screen.getByText("2. Save weather artifact locally")).toBeInTheDocument();
  });

  it("shows a branch-aware structure preview for branched workflows", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowDag
        workflow={workflowVersion(branchedWorkflow)}
        originalDefinition={branchedWorkflow}
        providers={[]}
        llmProfiles={[]}
        agentAuthProfiles={[]}
        runs={[]}
        artifacts={[]}
        onChangeDefinition={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Preview run path" }));

    expect(screen.getByText("Branching workflow structure")).toBeInTheDocument();
    expect(screen.getByText("Entry stage")).toBeInTheDocument();
    expect(screen.getByText("Merge stage")).toBeInTheDocument();
    expect(screen.getByText(/without pretending there is a single execution path/i)).toBeInTheDocument();
  });

  it("shows the current version diff review from the builder action", async () => {
    const user = userEvent.setup();
    renderWorkflowDag();

    await user.click(screen.getByRole("button", { name: "Review version diff" }));

    expect(screen.getByText("Version diff review")).toBeInTheDocument();
    expect(screen.getByText("No unsaved builder changes yet.")).toBeInTheDocument();
  });

  it("explains that branching workflow ordering is read-only", () => {
    render(
      <WorkflowDag
        workflow={workflowVersion(branchedWorkflow)}
        originalDefinition={branchedWorkflow}
        providers={[]}
        llmProfiles={[]}
        agentAuthProfiles={[]}
        runs={[]}
        artifacts={[]}
        onChangeDefinition={vi.fn()}
      />,
    );

    expect(screen.getByText("Branching workflow ordering is read-only in the guided builder.")).toBeInTheDocument();
  });

  it("opens disable-specific guidance instead of add-step messaging", async () => {
    const user = userEvent.setup();
    renderWorkflowDag();

    await user.click(screen.getByRole("button", { name: "Disable options" }));

    expect(screen.getByText("Disable the workflow from status controls")).toBeInTheDocument();
    expect(screen.getAllByText(/use the workflow status control to disable runs for this workflow/i)).toHaveLength(2);
    expect(screen.queryByText("Add steps through a guided draft")).not.toBeInTheDocument();
  });
});
