import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalGrant, CapabilityDescriptor, PreflightManifest } from "../../domain/types";
import { buildPreflightApprovalGrants } from "../domain/preflightGrants";
import { RunReadinessPanel } from "./RunReadinessPanel";

function capability(overrides: Partial<CapabilityDescriptor> & Pick<CapabilityDescriptor, "id" | "displayName">): CapabilityDescriptor {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "test",
    action: overrides.action ?? "run",
    displayName: overrides.displayName,
    description: overrides.description ?? `${overrides.displayName} description.`,
    category: overrides.category ?? "Test",
    source: overrides.source ?? "builtin",
    status: overrides.status ?? "available",
    executionMode: overrides.executionMode ?? "deterministic",
    deterministic: overrides.deterministic ?? true,
    readOnly: overrides.readOnly ?? true,
    idempotent: overrides.idempotent ?? true,
    destructive: overrides.destructive ?? false,
    openWorld: overrides.openWorld ?? false,
    requiresNetwork: overrides.requiresNetwork ?? false,
    writesFiles: overrides.writesFiles ?? false,
    requiresCredentials: overrides.requiresCredentials ?? false,
    permissions: overrides.permissions ?? [],
    intentTags: overrides.intentTags ?? [],
    bestFor: overrides.bestFor ?? [],
    notFor: overrides.notFor ?? [],
    builderGuidance: overrides.builderGuidance ?? "Use in tests.",
    fallbackStrategy: overrides.fallbackStrategy ?? "Ask for approval.",
    inputSchema: overrides.inputSchema ?? {},
    outputSchema: overrides.outputSchema ?? {},
    trustTier: overrides.trustTier ?? "raven_builtin",
    defaultApproval: overrides.defaultApproval ?? "auto",
    adapter: overrides.adapter ?? { kind: "native", handler: "test" },
    signatureHash: overrides.signatureHash ?? `${overrides.id}:sig`,
    detectedFrom: overrides.detectedFrom,
    rawToolId: overrides.rawToolId,
    version: overrides.version,
    lastCheckedAt: overrides.lastCheckedAt,
    policy: overrides.policy,
  };
}

const manifest: PreflightManifest = {
  id: "preflight-1",
  workflowId: "daily-work-journal",
  workflowVersion: 3,
  registrySnapshotHash: "registry-1",
  createdAt: "2026-06-21T12:00:00.000Z",
  capabilities: [
    {
      stepId: "collect",
      capabilityId: "local.git.diff",
      policyDecision: "auto",
      reason: "Trusted read-only workspace capability.",
      signatureHash: "local.git.diff:sig",
    },
    {
      stepId: "publish",
      capabilityId: "github.issue.comment",
      policyDecision: "needs_grant",
      reason: "External network and credential use need pre-approval.",
      signatureHash: "github.issue.comment:sig",
    },
    {
      stepId: "cleanup",
      capabilityId: "workspace.delete",
      policyDecision: "blocked",
      reason: "Bulk deletes are blocked in safe mode.",
      signatureHash: "workspace.delete:sig",
    },
  ],
  credentials: [
    {
      stepId: "publish",
      capabilityId: "github.issue.comment",
      credentialRef: "keychain:github",
    },
  ],
  networkDomains: ["api.github.com"],
  fileReads: ["repo/**/*.md"],
  fileWrites: ["artifacts/daily.md"],
  overwrites: ["artifacts/daily.md"],
  deletes: [
    {
      stepId: "cleanup",
      capabilityId: "workspace.delete",
      pathPattern: "tmp/**/*.json",
      maxDeletes: 5,
    },
  ],
  externalPublishes: ["github:issue-comment"],
  policyRecommendation: "workspace_auto",
  blockingItems: [
    {
      stepId: "cleanup",
      capabilityId: "workspace.delete",
      reason: "Bulk deletes are blocked in safe mode.",
    },
  ],
  scopedNetworkDomains: [
    { stepId: "publish", capabilityId: "github.issue.comment", value: "api.github.com" },
  ],
  scopedNetworkResources: [],
  scopedFileWrites: [
    { stepId: "publish", capabilityId: "github.issue.comment", value: "artifacts/daily.md" },
  ],
  scopedOverwrites: [
    { stepId: "publish", capabilityId: "github.issue.comment", value: "artifacts/daily.md" },
  ],
  scopedExternalPublishes: [
    { stepId: "publish", capabilityId: "github.issue.comment", value: "github:issue-comment" },
  ],
};

describe("RunReadinessPanel", () => {
  it("builds scoped grants without adding generic tool grants for scoped requirements", () => {
    const scopedManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "write-artifact",
          capabilityId: "local_app.write_artifact",
          policyDecision: "needs_grant",
          reason: "Artifact write requires review.",
          signatureHash: "local_app.write_artifact:sig",
        },
      ],
      credentials: [],
      networkDomains: [],
      fileWrites: ["artifacts/report.md"],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [],
      scopedNetworkResources: [],
      scopedFileWrites: [
        { stepId: "write-artifact", capabilityId: "local_app.write_artifact", value: "artifacts/report.md" },
      ],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    const grants = buildPreflightApprovalGrants(scopedManifest, {
      approvedAt: "2026-06-23T12:00:00.000Z",
      idFactory: (() => {
        let counter = 0;
        return () => `grant-${++counter}`;
      })(),
    });

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      capabilityId: "local_app.write_artifact",
      grantType: "file_write",
      scope: {
        paths: ["artifacts/report.md"],
      },
    });
    expect(grants.some((grant) => grant.grantType === "tool_execution")).toBe(false);
  });

  it("falls back to a generic tool grant when no scoped grant can be derived", () => {
    const genericManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "ask-agent",
          capabilityId: "agent.run_task",
          policyDecision: "needs_grant",
          reason: "Agent execution needs review.",
          signatureHash: "agent.run_task:sig",
        },
      ],
      credentials: [],
      networkDomains: [],
      fileWrites: [],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [],
      scopedNetworkResources: [],
      scopedFileWrites: [],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    const grants = buildPreflightApprovalGrants(genericManifest, {
      approvedAt: "2026-06-23T12:00:00.000Z",
      idFactory: () => "grant-1",
    });

    expect(grants).toEqual([
      expect.objectContaining({
        capabilityId: "agent.run_task",
        grantType: "tool_execution",
      }),
    ]);
  });

  it("does not emit a generic tool grant when the capability has scoped requirements on another step", () => {
    const mixedManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "publish-artifact",
          capabilityId: "local_app.write_artifact",
          policyDecision: "needs_grant",
          reason: "Artifact write requires review.",
          signatureHash: "local_app.write_artifact:sig",
        },
        {
          stepId: "publish-summary",
          capabilityId: "local_app.write_artifact",
          policyDecision: "needs_grant",
          reason: "Artifact write requires review.",
          signatureHash: "local_app.write_artifact:sig",
        },
      ],
      credentials: [],
      networkDomains: [],
      fileWrites: ["artifacts/report.md"],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [],
      scopedNetworkResources: [],
      scopedFileWrites: [
        { stepId: "publish-artifact", capabilityId: "local_app.write_artifact", value: "artifacts/report.md" },
      ],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    const grants = buildPreflightApprovalGrants(mixedManifest, {
      approvedAt: "2026-06-23T12:00:00.000Z",
      idFactory: (() => {
        let counter = 0;
        return () => `grant-${++counter}`;
      })(),
    });

    expect(grants).toEqual([
      expect.objectContaining({
        capabilityId: "local_app.write_artifact",
        grantType: "file_write",
        scope: expect.objectContaining({
          paths: ["artifacts/report.md"],
        }),
      }),
    ]);
    expect(grants.some((grant) => grant.grantType === "tool_execution")).toBe(false);
  });

  it("shows readiness sections, policy decisions, and creates a scoped grant", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({ id: "local.git.diff", displayName: "Read git diff" }),
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            requiresCredentials: true,
            requiresNetwork: true,
          }),
          capability({
            id: "workspace.delete",
            displayName: "Delete workspace files",
            destructive: true,
          }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    const requiredTools = screen.getByRole("region", { name: "Required tools" });
    expect(requiredTools).toHaveTextContent("Read git diff");
    expect(requiredTools).toHaveTextContent("Allowed automatically");
    expect(requiredTools).toHaveTextContent("Post GitHub issue comment");
    expect(requiredTools).toHaveTextContent("Needs pre-approval");
    expect(requiredTools).toHaveTextContent("Delete workspace files");
    expect(requiredTools).toHaveTextContent("Blocked");

    expect(screen.getByRole("region", { name: "Network" })).toHaveTextContent("api.github.com");
    expect(screen.getByRole("region", { name: "Credentials" })).toHaveTextContent("keychain:github");
    expect(screen.getByRole("region", { name: "Writes and overwrites" })).toHaveTextContent("artifacts/daily.md");
    expect(screen.getByRole("region", { name: "Deletes" })).toHaveTextContent("tmp/**/*.json");
    expect(screen.getByRole("region", { name: "External publishing" })).toHaveTextContent("github:issue-comment");
    expect(screen.getByRole("region", { name: "Blocking items" })).toHaveTextContent("Bulk deletes are blocked in safe mode.");

    await userEvent.click(
      within(screen.getByRole("region", { name: "Network" })).getByRole("button", {
        name: "Pre-approve network access for api.github.com",
      }),
    );

    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "daily-work-journal",
      workflowVersion: 3,
      capabilityId: "github.issue.comment",
      grantType: "network_access",
      signatureHash: "github.issue.comment:sig",
      status: "active",
      scope: {
        paths: [],
        domains: ["api.github.com"],
        resourceIds: [],
        externalTargets: [],
      },
    }));
    expect(await screen.findByText("Approval grant created")).toBeInTheDocument();
  });

  it("does not create generic tool grants for scoped requirements without descriptors", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const scopedManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "write-artifact",
          capabilityId: "local_app.write_artifact",
          policyDecision: "needs_grant",
          reason: "Artifact write requires review.",
          signatureHash: "local_app.write_artifact:sig",
        },
      ],
      credentials: [],
      networkDomains: [],
      fileWrites: ["artifacts/report.md"],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [],
      scopedNetworkResources: [],
      scopedFileWrites: [
        { stepId: "write-artifact", capabilityId: "local_app.write_artifact", value: "artifacts/report.md" },
      ],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    render(
      <RunReadinessPanel
        manifest={scopedManifest}
        capabilities={[]}
        onCreateGrant={onCreateGrant}
      />,
    );

    expect(
      within(screen.getByRole("region", { name: "Required tools" })).queryByRole("button", {
        name: "Pre-approve local_app.write_artifact",
      }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Pre-approve all required grants" }));

    expect(onCreateGrant).toHaveBeenCalledTimes(1);
    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: "local_app.write_artifact",
      grantType: "file_write",
      scope: expect.objectContaining({
        paths: ["artifacts/report.md"],
      }),
    }));
  });

  it("marks matching active grants as approved instead of prompting again", () => {
    const activeGrants: ApprovalGrant[] = [
      {
        id: "grant-network",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "network_access",
        scope: {
          paths: [],
          domains: ["api.github.com"],
          resourceIds: [],
          externalTargets: [],
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
      {
        id: "grant-overwrite",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "file_overwrite",
        scope: {
          paths: ["artifacts/daily.md"],
          domains: [],
          resourceIds: [],
          maxOverwriteBytes: 1048576,
          externalTargets: [],
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
    ];

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({ id: "local.git.diff", displayName: "Read git diff" }),
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            requiresCredentials: true,
            requiresNetwork: true,
            writesFiles: true,
          }),
        ]}
        approvalGrants={activeGrants}
        onCreateGrant={vi.fn()}
      />,
    );

    expect(
      within(screen.getByRole("region", { name: "Network" })).queryByRole("button", {
        name: "Pre-approve network access for api.github.com",
      }),
    ).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Network" })).getByText("Approved")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Writes and overwrites" })).queryByRole("button", {
        name: "Pre-approve overwrite for artifacts/daily.md",
      }),
    ).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Writes and overwrites" })).getByText("Approved")).toBeInTheDocument();
  });

  it("shows required tools as approved when active grants cover every required grant target", () => {
    const activeGrants: ApprovalGrant[] = [
      {
        id: "grant-network",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "network_access",
        scope: {
          paths: [],
          domains: ["api.github.com"],
          resourceIds: [],
          externalTargets: [],
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
      {
        id: "grant-credential",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "credential_use",
        scope: {
          paths: [],
          domains: [],
          resourceIds: [],
          externalTargets: [],
          credentialRef: "keychain:github",
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
      {
        id: "grant-overwrite",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "file_overwrite",
        scope: {
          paths: ["artifacts/daily.md"],
          domains: [],
          resourceIds: [],
          maxOverwriteBytes: 1048576,
          externalTargets: [],
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
      {
        id: "grant-publish",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "external_publish",
        scope: {
          paths: [],
          domains: [],
          resourceIds: [],
          externalTargets: ["github:issue-comment"],
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
    ];

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({ id: "local.git.diff", displayName: "Read git diff" }),
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            requiresCredentials: true,
            requiresNetwork: true,
            writesFiles: true,
            permissions: ["external:publish"],
          }),
        ]}
        approvalGrants={activeGrants}
        onCreateGrant={vi.fn()}
      />,
    );

    const requiredTools = screen.getByRole("region", { name: "Required tools" });
    expect(requiredTools).toHaveTextContent("Post GitHub issue comment");
    expect(requiredTools).toHaveTextContent("Approved");
    expect(within(requiredTools).queryByText("Needs pre-approval")).not.toBeInTheDocument();
  });

  it("keeps required tool approval status scoped when repeated steps share a capability signature", () => {
    const duplicateCapabilityManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "publish-primary",
          capabilityId: "github.issue.comment",
          policyDecision: "needs_grant",
          reason: "Primary publish needs network approval.",
          signatureHash: "github.issue.comment:sig",
        },
        {
          stepId: "publish-secondary",
          capabilityId: "github.issue.comment",
          policyDecision: "needs_grant",
          reason: "Secondary publish needs network approval.",
          signatureHash: "github.issue.comment:sig",
        },
      ],
      credentials: [],
      networkDomains: ["api.github.com", "uploads.github.com"],
      fileWrites: [],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [
        { stepId: "publish-primary", capabilityId: "github.issue.comment", value: "api.github.com" },
        { stepId: "publish-secondary", capabilityId: "github.issue.comment", value: "uploads.github.com" },
      ],
      scopedNetworkResources: [],
      scopedFileWrites: [],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };
    const activeGrants: ApprovalGrant[] = [
      {
        id: "grant-primary-network",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "network_access",
        scope: {
          paths: [],
          domains: ["api.github.com"],
          resourceIds: [],
          externalTargets: [],
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
      {
        id: "grant-secondary-network",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "network_access",
        scope: {
          paths: [],
          domains: ["uploads.github.com"],
          resourceIds: [],
          externalTargets: [],
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
    ];

    render(
      <RunReadinessPanel
        manifest={duplicateCapabilityManifest}
        capabilities={[
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            requiresNetwork: true,
          }),
        ]}
        approvalGrants={activeGrants}
        onCreateGrant={vi.fn()}
      />,
    );

    const requiredTools = screen.getByRole("region", { name: "Required tools" });
    expect(within(requiredTools).getAllByText("Approved")).toHaveLength(2);
    expect(within(requiredTools).queryByText("Needs pre-approval")).not.toBeInTheDocument();
  });

  it("shows repeated same-scope capability rows as approved when one grant covers both", () => {
    const duplicateCapabilityManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "publish-primary",
          capabilityId: "github.issue.comment",
          policyDecision: "needs_grant",
          reason: "Primary publish needs network approval.",
          signatureHash: "github.issue.comment:sig",
        },
        {
          stepId: "publish-secondary",
          capabilityId: "github.issue.comment",
          policyDecision: "needs_grant",
          reason: "Secondary publish needs network approval.",
          signatureHash: "github.issue.comment:sig",
        },
      ],
      credentials: [],
      networkDomains: ["api.github.com"],
      fileWrites: [],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [
        { stepId: "publish-primary", capabilityId: "github.issue.comment", value: "api.github.com" },
        { stepId: "publish-secondary", capabilityId: "github.issue.comment", value: "api.github.com" },
      ],
      scopedNetworkResources: [],
      scopedFileWrites: [],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };
    const activeGrants: ApprovalGrant[] = [
      {
        id: "grant-network",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "network_access",
        scope: {
          paths: [],
          domains: ["api.github.com"],
          resourceIds: [],
          externalTargets: [],
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
    ];

    render(
      <RunReadinessPanel
        manifest={duplicateCapabilityManifest}
        capabilities={[
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            requiresNetwork: true,
          }),
        ]}
        approvalGrants={activeGrants}
        onCreateGrant={vi.fn()}
      />,
    );

    const requiredTools = screen.getByRole("region", { name: "Required tools" });
    expect(within(requiredTools).getAllByText("Approved")).toHaveLength(2);
    expect(within(requiredTools).queryByText("Needs pre-approval")).not.toBeInTheDocument();
  });

  it("does not treat expired active grants as approved", () => {
    const expiredGrants: ApprovalGrant[] = [
      {
        id: "grant-network-expired",
        workflowId: "daily-work-journal",
        workflowVersion: 3,
        capabilityId: "github.issue.comment",
        grantType: "network_access",
        scope: {
          paths: [],
          domains: ["api.github.com"],
          resourceIds: [],
          externalTargets: [],
        },
        approvedByUserAt: "2026-06-21T12:00:00.000Z",
        expiresAt: "2000-01-01T00:00:00.000Z",
        signatureHash: "github.issue.comment:sig",
        status: "active",
      },
    ];

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            requiresNetwork: true,
          }),
        ]}
        approvalGrants={expiredGrants}
        onCreateGrant={vi.fn()}
      />,
    );

    const networkRegion = screen.getByRole("region", { name: "Network" });
    expect(within(networkRegion).queryByText("Approved")).not.toBeInTheDocument();
    expect(
      within(networkRegion).getByRole("button", {
        name: "Pre-approve network access for api.github.com",
      }),
    ).toBeInTheDocument();
  });


  it("applies expiration duration while keeping backend-scoped exact paths", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            writesFiles: true,
          }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText("Grant scope"), "1h");
    expect(screen.getByLabelText("File scope")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Always ask" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Block capability" })).toBeEnabled();

    await userEvent.click(
      within(screen.getByRole("region", { name: "Writes and overwrites" })).getByRole("button", {
        name: "Pre-approve overwrite for artifacts/daily.md",
      }),
    );

    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      expiresAt: expect.any(String),
      scope: expect.objectContaining({
        paths: ["artifacts/daily.md"],
      }),
    }));
  });

  it("offers run-scoped grants, policy actions, and guards unsupported destination-folder grants", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const onCategoryOverridesChange = vi.fn(async () => "Category overrides saved");

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            category: "web_content",
            writesFiles: true,
          }),
        ]}
        onCreateGrant={onCreateGrant}
        onCategoryOverridesChange={onCategoryOverridesChange}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText("Grant scope"), "this_run");
    await userEvent.click(
      within(screen.getByRole("region", { name: "Writes and overwrites" })).getByRole("button", {
        name: "Pre-approve overwrite for artifacts/daily.md",
      }),
    );

    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      expiresAt: expect.any(String),
      grantType: "file_overwrite",
    }));

    await userEvent.click(screen.getByRole("button", { name: "Always ask" }));
    expect(onCategoryOverridesChange).toHaveBeenCalledWith({ web_content: "ask_first" });
    expect(await screen.findByText("Always ask saved for Web content.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Block capability" }));
    expect(await screen.findByText("Capability-level blocking is not available from run readiness; set category policy in Tools and Autonomy.")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("File scope"), "destination_folder");
    await userEvent.click(
      within(screen.getByRole("region", { name: "Writes and overwrites" })).getByRole("button", {
        name: "Pre-approve overwrite for artifacts/daily.md",
      }),
    );

    expect(await screen.findByText("Destination folder grants are not available for this preflight; use exact displayed paths.")).toBeInTheDocument();
    expect(onCreateGrant).toHaveBeenCalledTimes(1);
  });

  it("can pre-approve all required scoped grants with setup-safe success copy", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({ id: "local.git.diff", displayName: "Read git diff" }),
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            requiresCredentials: true,
            requiresNetwork: true,
            writesFiles: true,
            permissions: ["external:publish"],
          }),
          capability({
            id: "workspace.delete",
            displayName: "Delete workspace files",
            destructive: true,
          }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Pre-approve all required grants" }));

    expect(onCreateGrant).toHaveBeenCalledTimes(4);
    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      grantType: "network_access",
      scope: expect.objectContaining({ domains: ["api.github.com"] }),
    }));
    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      grantType: "credential_use",
      scope: expect.objectContaining({ credentialRef: "keychain:github" }),
    }));
    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      grantType: "file_overwrite",
      scope: expect.objectContaining({ paths: ["artifacts/daily.md"] }),
    }));
    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      grantType: "external_publish",
      scope: expect.objectContaining({ externalTargets: ["github:issue-comment"] }),
    }));
    expect(await screen.findByText("All required grants approved. Run the workflow when ready.")).toBeInTheDocument();
    expect(screen.queryByText(/Retry the blocked run/i)).not.toBeInTheDocument();
  });

  it("does not report bulk approval success when any grant creation resolves as a failure", async () => {
    const onCreateGrant = vi.fn(async (grant) =>
      grant.grantType === "credential_use" ? "Approval grant failed" : "Approval grant created"
    );

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            requiresCredentials: true,
            requiresNetwork: true,
            writesFiles: true,
            permissions: ["external:publish"],
          }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Pre-approve all required grants" }));

    expect(onCreateGrant).toHaveBeenCalledTimes(4);
    expect(await screen.findByText("Approval grant failed")).toHaveClass("error-note");
    expect(screen.queryByText("All required grants approved. Run the workflow when ready.")).not.toBeInTheDocument();
  });

  it("deduplicates pre-approve all grants for grouped scoped values", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const groupedManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "crawl",
          capabilityId: "web.fetch",
          policyDecision: "needs_grant",
          reason: "Network access requires review.",
          signatureHash: "web.fetch:sig",
        },
      ],
      credentials: [],
      fileWrites: [],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      networkDomains: ["example.com", "www.example.com"],
      scopedNetworkDomains: [
        { stepId: "crawl", capabilityId: "web.fetch", value: "example.com" },
        { stepId: "crawl", capabilityId: "web.fetch", value: "www.example.com" },
      ],
      scopedFileWrites: [],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    render(
      <RunReadinessPanel
        manifest={groupedManifest}
        capabilities={[
          capability({ id: "web.fetch", displayName: "Fetch web page", requiresNetwork: true }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Pre-approve all required grants" }));

    expect(onCreateGrant).toHaveBeenCalledTimes(1);
    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: "web.fetch",
      grantType: "network_access",
      scope: expect.objectContaining({
        domains: ["example.com", "www.example.com"],
      }),
    }));
  });

  it("uses scoped item ownership when creating grants for ambiguous capabilities", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const ambiguousManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "slack",
          capabilityId: "slack.fetch",
          policyDecision: "needs_grant",
          reason: "Slack network access requires review.",
          signatureHash: "slack.fetch:sig",
        },
        {
          stepId: "github",
          capabilityId: "github.fetch",
          policyDecision: "needs_grant",
          reason: "GitHub network access requires review.",
          signatureHash: "github.fetch:sig",
        },
        {
          stepId: "artifact",
          capabilityId: "local_app.write_artifact",
          policyDecision: "needs_grant",
          reason: "Artifact writes require review.",
          signatureHash: "local_app.write_artifact:sig",
        },
        {
          stepId: "workspace",
          capabilityId: "workspace.write_file",
          policyDecision: "needs_grant",
          reason: "Workspace writes require review.",
          signatureHash: "workspace.write_file:sig",
        },
      ],
      networkDomains: ["slack.com", "api.github.com"],
      fileWrites: ["artifacts/daily.md", "/tmp/raven/workspace.txt"],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [
        { stepId: "slack", capabilityId: "slack.fetch", value: "slack.com" },
        { stepId: "github", capabilityId: "github.fetch", value: "api.github.com" },
      ],
      scopedFileWrites: [
        { stepId: "artifact", capabilityId: "local_app.write_artifact", value: "artifacts/daily.md" },
        { stepId: "workspace", capabilityId: "workspace.write_file", value: "/tmp/raven/workspace.txt" },
      ],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    render(
      <RunReadinessPanel
        manifest={ambiguousManifest}
        capabilities={[
          capability({ id: "slack.fetch", displayName: "Fetch Slack", requiresNetwork: true }),
          capability({ id: "github.fetch", displayName: "Fetch GitHub", requiresNetwork: true }),
          capability({ id: "local_app.write_artifact", displayName: "Write artifact", writesFiles: true }),
          capability({ id: "workspace.write_file", displayName: "Write workspace file", writesFiles: true }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    await userEvent.click(
      within(screen.getByRole("region", { name: "Network" })).getByRole("button", {
        name: "Pre-approve network access for api.github.com",
      }),
    );
    expect(onCreateGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      capabilityId: "github.fetch",
      grantType: "network_access",
      scope: expect.objectContaining({ domains: ["api.github.com"] }),
    }));

    await userEvent.click(
      within(screen.getByRole("region", { name: "Writes and overwrites" })).getByRole("button", {
        name: "Pre-approve write for /tmp/raven/workspace.txt",
      }),
    );
    expect(onCreateGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      capabilityId: "workspace.write_file",
      grantType: "file_write",
      scope: expect.objectContaining({ paths: ["/tmp/raven/workspace.txt"] }),
    }));
  });

  it("creates overwrite grants for paths marked as overwrites", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            writesFiles: true,
          }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    const writesRegion = screen.getByRole("region", { name: "Writes and overwrites" });
    expect(
      within(writesRegion).queryByRole("button", {
        name: "Pre-approve write for artifacts/daily.md",
      }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      within(writesRegion).getByRole("button", {
        name: "Pre-approve overwrite for artifacts/daily.md",
      }),
    );

    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: "github.issue.comment",
      grantType: "file_overwrite",
      scope: expect.objectContaining({
        paths: ["artifacts/daily.md"],
        maxOverwriteBytes: 1048576,
      }),
    }));
  });

  it("creates grouped scoped grants for multi-value step requirements", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const groupedManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "network-step",
          capabilityId: "http.fetch_many",
          policyDecision: "needs_grant",
          reason: "Network access requires review.",
          signatureHash: "http.fetch_many:sig",
        },
        {
          stepId: "write-step",
          capabilityId: "workspace.write_many",
          policyDecision: "needs_grant",
          reason: "Writes require review.",
          signatureHash: "workspace.write_many:sig",
        },
        {
          stepId: "overwrite-step",
          capabilityId: "workspace.overwrite_many",
          policyDecision: "needs_grant",
          reason: "Overwrites require review.",
          signatureHash: "workspace.overwrite_many:sig",
        },
        {
          stepId: "publish-step",
          capabilityId: "slack.publish_many",
          policyDecision: "needs_grant",
          reason: "Publishing requires review.",
          signatureHash: "slack.publish_many:sig",
        },
      ],
      networkDomains: ["api.github.com", "hooks.slack.com"],
      fileWrites: ["/tmp/raven/a.md", "/tmp/raven/b.md", "/tmp/raven/c.md", "/tmp/raven/d.md"],
      overwrites: ["/tmp/raven/c.md", "/tmp/raven/d.md"],
      deletes: [],
      externalPublishes: ["slack:#ops", "slack:#eng"],
      blockingItems: [],
      scopedNetworkDomains: [
        { stepId: "network-step", capabilityId: "http.fetch_many", value: "api.github.com" },
        { stepId: "network-step", capabilityId: "http.fetch_many", value: "hooks.slack.com" },
      ],
      scopedFileWrites: [
        { stepId: "write-step", capabilityId: "workspace.write_many", value: "/tmp/raven/a.md" },
        { stepId: "write-step", capabilityId: "workspace.write_many", value: "/tmp/raven/b.md" },
        { stepId: "overwrite-step", capabilityId: "workspace.overwrite_many", value: "/tmp/raven/c.md" },
        { stepId: "overwrite-step", capabilityId: "workspace.overwrite_many", value: "/tmp/raven/d.md" },
      ],
      scopedOverwrites: [
        { stepId: "overwrite-step", capabilityId: "workspace.overwrite_many", value: "/tmp/raven/c.md" },
        { stepId: "overwrite-step", capabilityId: "workspace.overwrite_many", value: "/tmp/raven/d.md" },
      ],
      scopedExternalPublishes: [
        { stepId: "publish-step", capabilityId: "slack.publish_many", value: "slack:#ops" },
        { stepId: "publish-step", capabilityId: "slack.publish_many", value: "slack:#eng" },
      ],
    };

    render(
      <RunReadinessPanel
        manifest={groupedManifest}
        capabilities={[
          capability({ id: "http.fetch_many", displayName: "Fetch many", requiresNetwork: true }),
          capability({ id: "workspace.write_many", displayName: "Write many", writesFiles: true }),
          capability({ id: "workspace.overwrite_many", displayName: "Overwrite many", writesFiles: true }),
          capability({
            id: "slack.publish_many",
            displayName: "Publish many",
            permissions: ["external:publish"],
          }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    await userEvent.click(
      within(screen.getByRole("region", { name: "Network" })).getByRole("button", {
        name: "Pre-approve network access for api.github.com",
      }),
    );
    expect(onCreateGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      capabilityId: "http.fetch_many",
      grantType: "network_access",
      scope: expect.objectContaining({ domains: ["api.github.com", "hooks.slack.com"] }),
    }));

    await userEvent.click(
      within(screen.getByRole("region", { name: "Writes and overwrites" })).getByRole("button", {
        name: "Pre-approve write for /tmp/raven/a.md",
      }),
    );
    expect(onCreateGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      capabilityId: "workspace.write_many",
      grantType: "file_write",
      scope: expect.objectContaining({ paths: ["/tmp/raven/a.md", "/tmp/raven/b.md"] }),
    }));

    await userEvent.click(
      within(screen.getByRole("region", { name: "Writes and overwrites" })).getByRole("button", {
        name: "Pre-approve overwrite for /tmp/raven/c.md",
      }),
    );
    expect(onCreateGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      capabilityId: "workspace.overwrite_many",
      grantType: "file_overwrite",
      scope: expect.objectContaining({
        paths: ["/tmp/raven/c.md", "/tmp/raven/d.md"],
        maxOverwriteBytes: 1048576,
      }),
    }));

    await userEvent.click(
      within(screen.getByRole("region", { name: "External publishing" })).getByRole("button", {
        name: "Pre-approve external publish for slack:#ops",
      }),
    );
    expect(onCreateGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      capabilityId: "slack.publish_many",
      grantType: "external_publish",
      scope: expect.objectContaining({ externalTargets: ["slack:#ops", "slack:#eng"] }),
    }));
  });

  it("creates grouped credential grants when a step uses multiple credentials", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const credentialManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "agent-step",
          capabilityId: "agent.run_task",
          policyDecision: "needs_grant",
          reason: "Credentials require review.",
          signatureHash: "agent.run_task:sig",
        },
      ],
      credentials: [
        { stepId: "agent-step", capabilityId: "agent.run_task", credentialRef: "keychain:openai" },
        { stepId: "agent-step", capabilityId: "agent.run_task", credentialRef: "keychain:github" },
      ],
      networkDomains: [],
      fileWrites: [],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [],
      scopedFileWrites: [],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    render(
      <RunReadinessPanel
        manifest={credentialManifest}
        capabilities={[
          capability({ id: "agent.run_task", displayName: "Run agent", requiresCredentials: true }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    await userEvent.click(
      within(screen.getByRole("region", { name: "Credentials" })).getByRole("button", {
        name: "Pre-approve credential use for keychain:openai",
      }),
    );

    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: "agent.run_task",
      grantType: "credential_use",
      scope: expect.objectContaining({
        credentialRef: "keychain:openai",
        resourceIds: ["keychain:openai", "keychain:github"],
      }),
    }));
  });

  it("creates resource-scoped network grants when no domain is derivable", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const resourceNetworkManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "sync-step",
          capabilityId: "internal_api.sync",
          policyDecision: "needs_grant",
          reason: "Network access requires review.",
          signatureHash: "internal_api.sync:sig",
        },
      ],
      credentials: [],
      networkDomains: [],
      fileWrites: [],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [],
      scopedNetworkResources: [
        { stepId: "sync-step", capabilityId: "internal_api.sync", value: "internal_api.sync" },
      ],
      scopedFileWrites: [],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    render(
      <RunReadinessPanel
        manifest={resourceNetworkManifest}
        capabilities={[
          capability({ id: "internal_api.sync", displayName: "Sync internal API", requiresNetwork: true }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    const networkRegion = screen.getByRole("region", { name: "Network" });
    expect(networkRegion).toHaveTextContent("Sync internal API");

    await userEvent.click(
      within(networkRegion).getByRole("button", {
        name: "Pre-approve network access for Sync internal API",
      }),
    );

    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: "internal_api.sync",
      grantType: "network_access",
      scope: expect.objectContaining({
        domains: [],
        resourceIds: ["internal_api.sync"],
      }),
    }));
  });

  it("groups delete grants by step and capability", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const deleteManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "cleanup-step",
          capabilityId: "filesystem.delete",
          policyDecision: "needs_grant",
          reason: "Deletes require review.",
          signatureHash: "filesystem.delete:sig",
        },
      ],
      credentials: [],
      networkDomains: [],
      fileWrites: [],
      overwrites: [],
      deletes: [
        {
          stepId: "cleanup-step",
          capabilityId: "filesystem.delete",
          pathPattern: "/tmp/raven/a.tmp",
          maxDeletes: 2,
        },
        {
          stepId: "cleanup-step",
          capabilityId: "filesystem.delete",
          pathPattern: "/tmp/raven/b.tmp",
          maxDeletes: 4,
        },
      ],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [],
      scopedNetworkResources: [],
      scopedFileWrites: [],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    render(
      <RunReadinessPanel
        manifest={deleteManifest}
        capabilities={[
          capability({ id: "filesystem.delete", displayName: "Delete files", destructive: true }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    await userEvent.click(
      within(screen.getByRole("region", { name: "Deletes" })).getByRole("button", {
        name: "Pre-approve delete for /tmp/raven/a.tmp",
      }),
    );

    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: "filesystem.delete",
      grantType: "file_delete",
      scope: expect.objectContaining({
        paths: ["/tmp/raven/a.tmp", "/tmp/raven/b.tmp"],
        maxDeletes: 4,
      }),
    }));
  });

  it("does not attach legacy global domains to resource-scoped network requirements", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const mixedNetworkManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "sync-step",
          capabilityId: "internal_api.sync",
          policyDecision: "needs_grant",
          reason: "Network access requires review.",
          signatureHash: "internal_api.sync:sig",
        },
      ],
      credentials: [],
      networkDomains: ["api.unrelated.example"],
      fileWrites: [],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [],
      scopedNetworkResources: [
        { stepId: "sync-step", capabilityId: "internal_api.sync", value: "internal_api.sync" },
      ],
      scopedFileWrites: [],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    render(
      <RunReadinessPanel
        manifest={mixedNetworkManifest}
        capabilities={[
          capability({ id: "internal_api.sync", displayName: "Sync internal API", requiresNetwork: true }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    const networkRegion = screen.getByRole("region", { name: "Network" });
    expect(networkRegion).not.toHaveTextContent("api.unrelated.example");

    await userEvent.click(
      within(networkRegion).getByRole("button", {
        name: "Pre-approve network access for Sync internal API",
      }),
    );

    expect(onCreateGrant).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: "internal_api.sync",
      grantType: "network_access",
      scope: expect.objectContaining({
        domains: [],
        resourceIds: ["internal_api.sync"],
      }),
    }));
  });

  it("does not create grants for legacy global-only network domains", () => {
    const onCreateGrant = vi.fn(async () => "Approval grant created");
    const legacyNetworkManifest: PreflightManifest = {
      ...manifest,
      capabilities: [
        {
          stepId: "legacy-step",
          capabilityId: "legacy.fetch",
          policyDecision: "needs_grant",
          reason: "Network access requires review.",
          signatureHash: "legacy.fetch:sig",
        },
      ],
      credentials: [],
      networkDomains: ["api.legacy.example"],
      fileWrites: [],
      overwrites: [],
      deletes: [],
      externalPublishes: [],
      blockingItems: [],
      scopedNetworkDomains: [],
      scopedNetworkResources: [],
      scopedFileWrites: [],
      scopedOverwrites: [],
      scopedExternalPublishes: [],
    };

    render(
      <RunReadinessPanel
        manifest={legacyNetworkManifest}
        capabilities={[
          capability({ id: "legacy.fetch", displayName: "Legacy fetch", requiresNetwork: true }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    const networkRegion = screen.getByRole("region", { name: "Network" });
    expect(networkRegion).toHaveTextContent("api.legacy.example");
    expect(within(networkRegion).queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders resolved grant failure messages as errors", async () => {
    const onCreateGrant = vi.fn(async () => "Approval grant failed");

    render(
      <RunReadinessPanel
        manifest={manifest}
        capabilities={[
          capability({
            id: "github.issue.comment",
            displayName: "Post GitHub issue comment",
            requiresNetwork: true,
          }),
        ]}
        onCreateGrant={onCreateGrant}
      />,
    );

    await userEvent.click(
      within(screen.getByRole("region", { name: "Network" })).getByRole("button", {
        name: "Pre-approve network access for api.github.com",
      }),
    );

    expect(await screen.findByText("Approval grant failed")).toHaveClass("error-note");
  });
});
