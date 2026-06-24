import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dailyWorkJournalWorkflow, morningBriefWorkflow } from "../../domain/workflow";
import type { AppState, ProviderHealth, WorkflowRun, WorkflowVersion } from "../../domain/types";
import { UsageCommandPanel } from "./UsageCommandPanel";

const bridgeMocks = vi.hoisted(() => ({
  analyzePersistedUsageHistory: vi.fn(async () => null),
  loadUsagePricingCatalog: vi.fn(async () => ({
    source: "Backend test catalog",
    version: "test-pricing-v2",
    fetchedAt: "2026-06-20T12:00:00.000Z",
    loadedAt: "2026-06-20T12:00:01.000Z",
    entries: [
      {
        providerId: "openai",
        model: "gpt-4.1",
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
        contextWindowTokens: 1_047_576,
      },
      {
        providerId: "openai",
        model: "gpt-4.1-nano",
        aliases: ["openai-nano-test"],
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.4,
        contextWindowTokens: 1_047_576,
      },
    ],
  })),
}));

vi.mock("../tauriBridge", () => bridgeMocks);

const provider = (id: string): ProviderHealth => ({
  id,
  name: id === "openai" ? "OpenAI" : id,
  kind: id === "openai" ? "llm" : "artifact_destination",
  status: "available",
  summary: "Ready",
});

function workflow(definition = dailyWorkJournalWorkflow): WorkflowVersion {
  return {
    id: `${definition.id}-v1`,
    workflowId: definition.id,
    version: 1,
    status: "enabled",
    approvalMode: "always_review",
    definition,
    createdAt: "2026-06-01T08:00:00.000Z",
  };
}

function run(overrides: Partial<WorkflowRun> & Pick<WorkflowRun, "id" | "workflowId" | "workflowName">): WorkflowRun {
  return {
    status: "succeeded",
    startedAt: "2026-06-19T10:00:00.000Z",
    idempotencyKey: overrides.id,
    ...overrides,
  };
}

function state(runs: WorkflowRun[] = []): AppState {
  return {
    theme: "aurora-dark",
    autonomyMode: "safe_auto",
    autonomyCategoryOverrides: {},
    capabilityRegistry: { hash: "", generatedAt: "2026-06-19T09:00:00.000Z", capabilities: [] },
    rawToolInventory: [],
    approvalGrants: [],
    workflows: [workflow(dailyWorkJournalWorkflow), workflow(morningBriefWorkflow)],
    runs,
    artifacts: [],
    scheduleOverrides: [],
    providers: [provider("openai"), provider("local_app")],
    llmProfiles: [
      {
        id: "default-openai",
        providerId: "openai",
        model: "gpt-4.1",
        effort: "medium",
        supportsStructuredOutputs: true,
      },
    ],
    agentAuthProfiles: [],
    chatMessages: [],
  };
}

describe("UsageCommandPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("repairs an invalid persisted usage period", () => {
    localStorage.setItem("raven_usage_period", "quarter");

    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "today",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalCostUsd: 1,
            totalTokens: 100,
            startedAt: "2026-06-19T10:00:00.000Z",
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Usage period")).toHaveValue("today");
    expect(localStorage.getItem("raven_usage_period")).toBe("today");
  });

  it("updates metrics and daily chart when the period changes", async () => {
    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "today",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalCostUsd: 1,
            totalTokens: 100,
            startedAt: "2026-06-19T10:00:00.000Z",
          }),
          run({
            id: "week",
            workflowId: "morning-brief",
            workflowName: "Morning Brief",
            totalCostUsd: 2,
            totalTokens: 200,
            startedAt: "2026-06-16T10:00:00.000Z",
          }),
          run({
            id: "old",
            workflowId: "morning-brief",
            workflowName: "Morning Brief",
            totalCostUsd: 4,
            totalTokens: 400,
            startedAt: "2026-05-12T10:00:00.000Z",
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Total estimated cost")).toHaveTextContent("$1.00");
    expect(screen.getByLabelText("Total tokens")).toHaveTextContent("100");
    expect(screen.getByRole("list", { name: "Daily cost by day" })).toHaveTextContent("$1.00");

    await userEvent.selectOptions(screen.getByLabelText("Usage period"), "7d");

    expect(screen.getByLabelText("Total estimated cost")).toHaveTextContent("$3.00");
    expect(screen.getByLabelText("Total tokens")).toHaveTextContent("300");
    expect(screen.getByRole("list", { name: "Daily cost by day" })).toHaveTextContent("$2.00");
  });

  it("separates missing cost from reported zero cost", () => {
    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "zero",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalCostUsd: 0,
            totalTokens: 50,
          }),
          run({
            id: "unknown",
            workflowId: "morning-brief",
            workflowName: "Morning Brief",
            totalTokens: 75,
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Total estimated cost")).toHaveTextContent("$0.00");
    expect(screen.getAllByText("Partial data").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 run missing cost telemetry.").length).toBeGreaterThan(0);
    expect(screen.getByText("Token split unavailable")).toBeInTheDocument();
    expect(screen.getByText("125 total tokens preserved")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Top workflows by cost" })).not.toBeInTheDocument();
  });

  it("renders unavailable usage states instead of cost visuals when only token data is reported", () => {
    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "unknown",
            workflowId: "morning-brief",
            workflowName: "Morning Brief",
            totalTokens: 75,
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Usage visualization unavailable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Usage runs reported activity, but none reported cost telemetry for daily spend.").length)
      .toBeGreaterThan(0);
    expect(screen.getByText("Provider rows would imply spend breakdown without reported cost telemetry.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Daily cost by day" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Provider/model breakdown" })).not.toBeInTheDocument();
  });

  it("shows empty visualization states when runs have no reported usage fields", () => {
    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "unknown-no-tokens",
            workflowId: "morning-brief",
            workflowName: "Morning Brief",
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    expect(screen.getAllByText("No reported usage yet").length).toBeGreaterThan(0);
    expect(screen.queryByText("No reported cost")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Daily cost by day" })).not.toBeInTheDocument();
  });

  it("shows token split unavailable while preserving total tokens", () => {
    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "tokens-only",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalTokens: 400,
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    expect(screen.getByText("Token split unavailable")).toBeInTheDocument();
    expect(screen.getByText("400 total tokens preserved")).toBeInTheDocument();
  });

  it("shows token telemetry unavailable when cost is reported without token data", () => {
    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "cost-only",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalCostUsd: 2.5,
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    expect(screen.getByText("Token split unavailable")).toBeInTheDocument();
    expect(screen.getByText("Usage runs reported cost, but providers did not report token telemetry for this period."))
      .toBeInTheDocument();
    expect(screen.queryByText(/No reported usage yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/total tokens preserved/i)).not.toBeInTheDocument();
  });

  it("replaces unavailable chart visuals with neutral empty states when no usage is reported", () => {
    render(
      <UsageCommandPanel
        state={state([])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    expect(screen.getAllByText("No reported usage yet").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Run a workflow with token/cost reporting enabled to populate this chart.").length)
      .toBeGreaterThan(0);
    expect(screen.queryByRole("list", { name: "Daily cost by day" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Input and output token split")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Top workflows by cost" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Provider/model breakdown" })).not.toBeInTheDocument();
  });

  it("shows a partial confidence state instead of a fake token split chart", async () => {
    const onOpenWorkflow = vi.fn();

    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "with-split",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalCostUsd: 2,
            totalTokens: 900,
            inputTokens: 600,
            outputTokens: 300,
          }),
          run({
            id: "missing-split",
            workflowId: "morning-brief",
            workflowName: "Morning Brief",
            totalCostUsd: 1,
            totalTokens: 300,
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={onOpenWorkflow}
      />,
    );

    expect(screen.getByText("Partial data")).toBeInTheDocument();
    expect(screen.getByText(/token split excludes runs without input\/output detail/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Input and output token split")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open workflow usage detail" }));
    expect(onOpenWorkflow).toHaveBeenCalled();
  });

  it("opens workflow detail from a workflow cost bar", async () => {
    const onOpenWorkflow = vi.fn();
    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "cost-driver",
            workflowId: "morning-brief",
            workflowName: "Morning Brief",
            totalCostUsd: 8,
            totalTokens: 800,
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={onOpenWorkflow}
      />,
    );

    const topWorkflows = screen.getByRole("list", { name: "Top workflows by cost" });
    await userEvent.click(within(topWorkflows).getByRole("button", { name: "Open Morning Brief usage detail" }));

    expect(onOpenWorkflow).toHaveBeenCalledWith("morning-brief", "usage");
    expect(screen.queryByText(/not yet persisted/i)).not.toBeInTheDocument();
  });

  it("shows configured budget threshold danger", () => {
    localStorage.setItem("raven_usage_budget_threshold_usd", "4");

    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "over-budget",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalCostUsd: 5,
            totalTokens: 100,
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    expect(screen.getByText("$4.00 cost alert")).toBeInTheDocument();
    expect(screen.getByText("125% used")).toBeInTheDocument();
  });

  it("detects anomalies against persisted historical run windows", () => {
    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "today-spike",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalCostUsd: 9,
            totalTokens: 900,
            startedAt: "2026-06-19T10:00:00.000Z",
          }),
          ...Array.from({ length: 7 }, (_, index) => run({
            id: `baseline-${index}`,
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalCostUsd: 1,
            totalTokens: 100,
            startedAt: `2026-06-${String(12 + index).padStart(2, "0")}T10:00:00.000Z`,
          })),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    const anomalyPanel = screen.getByRole("region", { name: "Anomaly detection" });
    expect(within(anomalyPanel).getByText("Cost anomaly detected")).toBeInTheDocument();
    expect(within(anomalyPanel).getByText("Baseline")).toBeInTheDocument();
    expect(within(anomalyPanel).getByText("7 days · 7 runs")).toBeInTheDocument();
    expect(within(anomalyPanel).getByText("Window")).toBeInTheDocument();
    expect(within(anomalyPanel).getByText("1 runs")).toBeInTheDocument();
  });

  it("recommends model substitutions from the backend pricing catalog and shows catalog status", async () => {
    render(
      <UsageCommandPanel
        state={state([
          run({
            id: "catalog-priced",
            workflowId: "daily-work-journal",
            workflowName: "Daily Work Journal",
            totalCostUsd: 3.8,
            totalTokens: 1_000_000,
            startedAt: "2026-06-19T10:00:00.000Z",
          }),
        ])}
        now={new Date("2026-06-19T12:00:00.000Z")}
        onOpenWorkflow={vi.fn()}
      />,
    );

    const suggestions = screen.getByRole("region", { name: "Model substitution suggestions" });
    expect(await within(suggestions).findAllByText(/Backend test catalog · test-pricing-v2/)).toHaveLength(2);
    expect(within(suggestions).getByText(/Fetched Jun 20, 2026/)).toBeInTheDocument();
    expect(within(suggestions).getByText(/OpenAI: gpt-4\.1 to gpt-4\.1-nano/)).toBeInTheDocument();
    expect(within(suggestions).getByText(/Save 95%/)).toBeInTheDocument();
    expect(bridgeMocks.loadUsagePricingCatalog).toHaveBeenCalled();
  });
});
