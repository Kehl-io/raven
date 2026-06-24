import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../domain/types";
import { TraceTimeline } from "./TraceTimeline";

describe("TraceTimeline", () => {
  it("renders a workflow execution graph with step dependencies", () => {
    render(
      <TraceTimeline
        runs={[
          {
            id: "run-graph",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            status: "succeeded",
            startedAt: "2026-06-19T10:00:00.000Z",
            completedAt: "2026-06-19T10:02:00.000Z",
            idempotencyKey: "run-graph",
          },
        ]}
        workflowSteps={[
          {
            kind: "provider_action",
            id: "collect-context",
            name: "Collect context",
            provider: "local_git",
            action: "summarize",
            dependsOn: [],
            permissions: ["git:read"],
            inputs: {},
          },
          {
            kind: "provider_action",
            id: "compose-artifact",
            name: "Compose artifact",
            provider: "openai",
            action: "generate",
            dependsOn: ["collect-context"],
            permissions: ["llm:generate"],
            inputs: {},
          },
        ]}
        stepRunsByRunId={{
          "run-graph": [
            {
              id: "step-context",
              workflowRunId: "run-graph",
              stepId: "collect-context",
              status: "succeeded",
              outputJson: {},
              startedAt: "2026-06-19T10:00:00.000Z",
              completedAt: "2026-06-19T10:00:10.000Z",
            },
          ],
        }}
      />,
    );

    const graph = screen.getByRole("region", { name: "Workflow execution graph" });
    expect(within(graph).getByText("Collect context")).toBeInTheDocument();
    expect(within(graph).getByText("Compose artifact")).toBeInTheDocument();
    expect(within(graph).getByText("After Collect context")).toBeInTheDocument();
  });

  it("shows resolved approval decisions as an audit trail", () => {
    const approvalAudit: ApprovalRequest[] = [
      {
        id: "approval-run-1",
        runId: "run-1",
        stepId: "approval",
        workflowName: "Daily Work Journal",
        description: "Review before writing artifact.",
        riskLevel: "normal",
        status: "approved",
        createdAt: "2026-06-19T10:00:00.000Z",
        resolvedAt: "2026-06-19T10:01:00.000Z",
        decisionReason: "Looks good",
      },
    ];

    render(
      <TraceTimeline
        approvalAudit={approvalAudit}
        runs={[
          {
            id: "run-1",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            status: "succeeded",
            startedAt: "2026-06-19T10:00:00.000Z",
            completedAt: "2026-06-19T10:02:00.000Z",
            idempotencyKey: "run-1",
          },
        ]}
      />,
    );

    const audit = screen.getByRole("region", { name: "Approval decision audit trail" });
    expect(within(audit).getByText("Daily Work Journal approved")).toBeInTheDocument();
    expect(within(audit).getByText("Reason: Looks good")).toBeInTheDocument();
  });

  it("shows capability grant and policy metadata in the audit trail", () => {
    render(
      <TraceTimeline
        runs={[
          {
            id: "run-1",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            status: "succeeded",
            startedAt: "2026-06-19T10:00:00.000Z",
            completedAt: "2026-06-19T10:02:00.000Z",
            idempotencyKey: "run-1",
          },
        ]}
        capabilityAudit={[
          {
            id: "audit-1",
            runId: "run-1",
            workflowId: "daily-work-journal",
            workflowVersion: 3,
            stepId: "publish",
            capabilityId: "github.issue.comment",
            decision: "needs_grant",
            grantId: "grant-1",
            reason: "Matched pre-approved GitHub publishing grant.",
            createdAt: "2026-06-19T10:01:30.000Z",
          },
        ]}
      />,
    );

    const audit = screen.getByRole("region", { name: "Capability policy audit trail" });
    expect(within(audit).getByText("github.issue.comment")).toBeInTheDocument();
    expect(within(audit).getByText("Needs pre-approval")).toBeInTheDocument();
    expect(within(audit).getByText("Grant grant-1")).toBeInTheDocument();
    expect(within(audit).getByText("Matched pre-approved GitHub publishing grant.")).toBeInTheDocument();
  });
});
