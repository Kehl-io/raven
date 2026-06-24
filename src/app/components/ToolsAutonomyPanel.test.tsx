import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalGrant, AutonomyMode, CapabilityDescriptor, RawToolInventoryItem } from "../../domain/types";
import { ToolsAutonomyPanel } from "./ToolsAutonomyPanel";

function capability(overrides: Partial<CapabilityDescriptor> & Pick<CapabilityDescriptor, "id" | "displayName" | "category" | "status">): CapabilityDescriptor {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "local_app",
    action: overrides.action ?? "read",
    displayName: overrides.displayName,
    description: overrides.description ?? `${overrides.displayName} description.`,
    category: overrides.category,
    source: overrides.source ?? "builtin",
    status: overrides.status,
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
    builderGuidance: overrides.builderGuidance ?? "Use when local context is enough.",
    fallbackStrategy: overrides.fallbackStrategy ?? "Ask for review.",
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
  };
}

function grant(overrides: Partial<ApprovalGrant> & Pick<ApprovalGrant, "id" | "capabilityId">): ApprovalGrant {
  return {
    id: overrides.id,
    workflowId: overrides.workflowId ?? "daily-work-journal",
    workflowVersion: overrides.workflowVersion ?? 1,
    capabilityId: overrides.capabilityId,
    grantType: overrides.grantType ?? "file_write",
    scope: overrides.scope ?? {
      paths: ["artifacts/*.md"],
      domains: [],
      resourceIds: [],
      externalTargets: [],
    },
    approvedByUserAt: overrides.approvedByUserAt ?? "2026-06-20T10:00:00.000Z",
    expiresAt: overrides.expiresAt,
    signatureHash: overrides.signatureHash ?? "grant-sig",
    status: overrides.status ?? "active",
  };
}

function rawTool(overrides: Partial<RawToolInventoryItem> & Pick<RawToolInventoryItem, "id" | "displayName">): RawToolInventoryItem {
  return {
    id: overrides.id,
    source: overrides.source ?? "cli",
    displayName: overrides.displayName,
    binaryPath: overrides.binaryPath ?? overrides.displayName.toLowerCase(),
    version: overrides.version ?? "1.0.0",
    status: overrides.status ?? "available",
    authStatus: overrides.authStatus ?? "unknown",
    operations: overrides.operations ?? [],
    annotations: overrides.annotations ?? {},
    detectionErrors: overrides.detectionErrors ?? [],
    lastCheckedAt: overrides.lastCheckedAt ?? "2026-06-20T10:00:00.000Z",
  };
}

describe("ToolsAutonomyPanel", () => {
  it("renders autonomy controls, grouped capabilities, auth status, active grants, and revoke action", async () => {
    const onModeChange = vi.fn(async () => "Autonomy mode saved");
    const onRefreshTools = vi.fn(async () => "Tool registry refreshed");
    const onRevokeGrant = vi.fn(async () => "Approval grant revoked");
    const githubCapability = capability({
      id: "github.issues",
      displayName: "Read GitHub issues",
      category: "Research",
      status: "needs_auth",
      source: "connector",
      requiresCredentials: true,
      requiresNetwork: true,
      defaultApproval: "review_changes",
    }) as CapabilityDescriptor & {
      policy: { decision: "needs_grant"; reason: string };
    };
    githubCapability.policy = {
      decision: "needs_grant",
      reason: "Backend policy reason: GitHub auth grant required.",
    };
    const blockedCapability = capability({
      id: "publish.send",
      displayName: "Publish notification",
      category: "Publishing",
      status: "unavailable",
      source: "plugin",
      defaultApproval: "blocked",
    }) as CapabilityDescriptor & {
      policy: { decision: "blocked"; reason: string };
    };
    blockedCapability.policy = {
      decision: "blocked",
      reason: "Backend policy reason: Publishing is blocked.",
    };

    render(
      <ToolsAutonomyPanel
        autonomyMode={"safe_auto" satisfies AutonomyMode}
        capabilities={[
          capability({
            id: "local_git.diff",
            displayName: "Read git diff",
            category: "local_context",
            status: "available",
          }),
          githubCapability,
          blockedCapability,
        ]}
        rawTools={[rawTool({ id: "cli.rg", displayName: "ripgrep", binaryPath: "/usr/local/bin/rg" })]}
        grants={[grant({ id: "grant-1", capabilityId: "github.issues" })]}
        onModeChange={onModeChange}
        onRefreshTools={onRefreshTools}
        onRevokeGrant={onRevokeGrant}
      />,
    );

    const modeSelector = screen.getByLabelText("Autonomy mode");
    expect(modeSelector).toHaveValue("safe_auto");
    await userEvent.selectOptions(modeSelector, "workspace_auto");
    expect(onModeChange).toHaveBeenCalledWith("workspace_auto");

    expect(screen.getByText("Current policy: Safe Auto")).toBeInTheDocument();
    expect(screen.getByText("Available 1")).toBeInTheDocument();
    expect(screen.getByText("Needs auth 1")).toBeInTheDocument();
    expect(screen.getByText("Blocked 1")).toBeInTheDocument();

    expect(screen.getByRole("region", { name: "Local context capabilities" })).toHaveTextContent("Read git diff");
    const inventory = screen.getByRole("region", { name: "Detected tool inventory" });
    expect(inventory).toHaveTextContent("ripgrep");
    expect(inventory).toHaveTextContent("/usr/local/bin/rg");
    const researchGroup = screen.getByRole("region", { name: "Research capabilities" });
    expect(researchGroup).toHaveTextContent("Read GitHub issues");
    expect(researchGroup).toHaveTextContent("Needs auth");
    expect(researchGroup).toHaveTextContent("Why review is required");
    expect(researchGroup).toHaveTextContent("Backend policy reason: GitHub auth grant required.");
    expect(researchGroup).not.toHaveTextContent("Why allowed");
    expect(researchGroup).not.toHaveTextContent("Safe Auto requires review for credentials or workspace-changing tools.");
    const publishingGroup = screen.getByRole("region", { name: "Publishing capabilities" });
    expect(publishingGroup).toHaveTextContent("Why blocked");
    expect(publishingGroup).toHaveTextContent("Backend policy reason: Publishing is blocked.");

    const grantsList = screen.getByRole("list", { name: "Active approval grants" });
    expect(within(grantsList).getByText("Read GitHub issues")).toBeInTheDocument();
    await userEvent.click(within(grantsList).getByRole("button", { name: "Revoke grant for Read GitHub issues" }));
    expect(onRevokeGrant).toHaveBeenCalledWith("grant-1");
    await waitFor(() => expect(screen.getByText("Approval grant revoked")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Refresh tools" }));
    expect(onRefreshTools).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Tool registry refreshed")).toBeInTheDocument());
  });

  it("renders failed action notices with error styling", async () => {
    render(
      <ToolsAutonomyPanel
        autonomyMode="safe_auto"
        capabilities={[]}
        rawTools={[]}
        grants={[]}
        onModeChange={vi.fn()}
        onRefreshTools={vi.fn(async () => "Tool registry unavailable")}
        onRevokeGrant={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Refresh tools" }));

    const notice = await screen.findByText("Tool registry unavailable");
    expect(notice).toHaveClass("error-note");
    expect(notice).not.toHaveClass("success-note");
  });

  it("shows review-new-tools queue and saves category override controls", async () => {
    const onCategoryOverrideChange = vi.fn(async () => "Category override saved");
    render(
      <ToolsAutonomyPanel
        autonomyMode="ask_first"
        categoryOverrides={{}}
        capabilities={[
          capability({
            id: "cli.pdftotext.extract_text",
            displayName: "Extract PDF text",
            category: "document_import",
            status: "available",
            source: "cli",
            rawToolId: "cli.pdftotext",
            defaultApproval: "always_review",
          }),
        ]}
        rawTools={[rawTool({ id: "cli.pdftotext", displayName: "pdftotext" })]}
        grants={[]}
        onModeChange={vi.fn()}
        onCategoryOverrideChange={onCategoryOverrideChange}
        onRefreshTools={vi.fn()}
        onRevokeGrant={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Review new tools" })).toHaveTextContent("Extract PDF text");
    await userEvent.click(screen.getByRole("button", { name: "Approve Document import category for Extract PDF text" }));
    expect(onCategoryOverrideChange).toHaveBeenCalledWith("document_import", "safe_auto");
    await waitFor(() => expect(screen.getByText("Category override saved")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Restrict Document import category for Extract PDF text" }));
    expect(onCategoryOverrideChange).toHaveBeenCalledWith("document_import", "ask_first");

    await userEvent.click(screen.getByRole("button", { name: "Review Document import category for Extract PDF text" }));
    expect(screen.getByText("Review Document import category policy below.")).toBeInTheDocument();

    expect(screen.getByRole("region", { name: "Document import capabilities" })).toBeInTheDocument();
    const overrides = screen.getByRole("region", { name: "Category autonomy overrides" });
    const select = within(overrides).getByLabelText("Document import override");
    expect(select).toHaveValue("inherit");

    await userEvent.selectOptions(select, "safe_auto");

    expect(onCategoryOverrideChange).toHaveBeenCalledWith("document_import", "safe_auto");
  });
});
