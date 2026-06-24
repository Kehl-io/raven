import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWeatherWorkflow, dailyWorkJournalWorkflow, morningBriefWorkflow } from "../../domain/workflow";
import type { AppState, ProviderHealth, WorkflowRun, WorkflowVersion } from "../../domain/types";
import { ScheduleTimelinePanel } from "./ScheduleTimelinePanel";

const provider = (id: string): ProviderHealth => ({
  id,
  name: id === "openai" ? "OpenAI" : "Local App Store",
  kind: id === "openai" ? "llm" : "artifact_destination",
  status: "available",
  summary: "Ready",
});

function workflow(
  definition = dailyWorkJournalWorkflow,
  status: WorkflowVersion["status"] = "enabled",
): WorkflowVersion {
  return {
    id: `${definition.id}-v1`,
    workflowId: definition.id,
    version: 1,
    status,
    approvalMode: "review_changes",
    definition,
    createdAt: "2026-06-01T08:00:00.000Z",
  };
}

function run(overrides: Partial<WorkflowRun> & Pick<WorkflowRun, "id" | "workflowId" | "workflowName" | "status">): WorkflowRun {
  return {
    startedAt: "2026-06-19T09:00:00.000Z",
    idempotencyKey: overrides.id,
    ...overrides,
  };
}

function scheduled(id: string, name: string, localTime: string) {
  return {
    ...dailyWorkJournalWorkflow,
    id,
    name,
    schedule: { cadence: "daily" as const, localTime },
  };
}

function state(overrides: Partial<AppState> = {}): AppState {
  const defaults: AppState = {
    theme: "aurora-dark",
    autonomyMode: "safe_auto",
    autonomyCategoryOverrides: {},
    capabilityRegistry: { hash: "", generatedAt: "2026-06-19T09:00:00.000Z", capabilities: [] },
    rawToolInventory: [],
    approvalGrants: [],
    workflows: [
      workflow(scheduled("upcoming-workflow", "Upcoming Workflow", "17:00")),
      workflow(scheduled("missed-workflow", "Missed Workflow", "08:00")),
      workflow(currentWeatherWorkflow),
      workflow(morningBriefWorkflow, "disabled"),
    ],
    runs: [],
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
  return {
    ...defaults,
    ...overrides,
    autonomyMode: overrides.autonomyMode ?? defaults.autonomyMode,
    autonomyCategoryOverrides: overrides.autonomyCategoryOverrides ?? defaults.autonomyCategoryOverrides,
    capabilityRegistry: overrides.capabilityRegistry ?? defaults.capabilityRegistry,
    approvalGrants: overrides.approvalGrants ?? defaults.approvalGrants,
  };
}

describe("ScheduleTimelinePanel", () => {
  beforeEach(() => {
    localStorage.removeItem("raven_schedule_view_mode");
  });

  it("shows timezone, day/week views, manual workflows, and state labels", async () => {
    render(
      <ScheduleTimelinePanel
        state={state()}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    expect(screen.getByText(/Timezone:/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today timeline" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Manual workflows" })).toBeInTheDocument();
    expect(screen.getByText("Upcoming")).toBeInTheDocument();
    expect(screen.getByText("Missed")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(screen.getByRole("heading", { name: "Next 7 days" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Week" })).toHaveAttribute("aria-checked", "true");
  });

  it("renders missed, paused, retryable, and failed actions", () => {
    render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("failed-workflow", "Failed Workflow", "10:00")),
            workflow(scheduled("retryable-workflow", "Retryable Workflow", "10:00")),
            workflow(scheduled("paused-workflow", "Paused Workflow", "10:00"), "disabled"),
            workflow(scheduled("missed-workflow", "Missed Workflow", "08:00")),
          ],
          runs: [
            run({
              id: "failed-run",
              workflowId: "failed-workflow",
              workflowName: "Failed Workflow",
              status: "failed",
            }),
            run({
              id: "retryable-run",
              workflowId: "retryable-workflow",
              workflowName: "Retryable Workflow",
              status: "retryable",
            }),
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Retry Failed Workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry Retryable Workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume Paused Workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss Missed Workflow missed schedule locally" })).toBeInTheDocument();
  });

  it("dismisses only the missed occurrence and keeps future occurrences visible", async () => {
    render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("missed-workflow", "Missed Workflow", "08:00")),
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    const today = screen.getByRole("article", { name: "Missed Workflow schedule entry" });
    expect(within(today).getByText("8:00 AM")).toBeInTheDocument();
    expect(within(today).getByText("4h ago")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss Missed Workflow missed schedule locally" }));

    expect(screen.queryByRole("article", { name: "Missed Workflow schedule entry" })).not.toBeInTheDocument();
    expect(screen.getByText("No scheduled workflow occurrences today.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(screen.getByText("6 occurrences")).toBeInTheDocument();
    expect(screen.getByText("No scheduled occurrences")).toBeInTheDocument();
    expect(screen.getAllByRole("article", { name: "Missed Workflow schedule occurrence" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Tomorrow")).toBeInTheDocument();
  });

  it("recomputes the CTA from visible entries after dismissing a missed occurrence", async () => {
    render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("missed-workflow", "Missed Workflow", "08:00")),
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Run due schedules" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss Missed Workflow missed schedule locally" }));

    expect(screen.getByRole("button", { name: "No schedules due" })).toBeDisabled();
    expect(screen.getByText(/next scheduled run is Missed Workflow/i)).toBeInTheDocument();
  });

  it("runs now and pauses or resumes schedules with safe-field updates", async () => {
    const onRunWorkflow = vi.fn();
    const onUpdateWorkflowSafeFields = vi.fn();
    render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("upcoming-workflow", "Upcoming Workflow", "17:00")),
            workflow(scheduled("paused-workflow", "Paused Workflow", "10:00"), "disabled"),
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={onRunWorkflow}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={onUpdateWorkflowSafeFields}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    const upcoming = screen.getByRole("article", { name: "Upcoming Workflow schedule entry" });
    await userEvent.click(within(upcoming).getByRole("button", { name: "Run Upcoming Workflow now" }));
    await userEvent.click(within(upcoming).getByRole("button", { name: "Pause Upcoming Workflow schedule" }));
    await userEvent.click(screen.getByRole("button", { name: "Resume Paused Workflow" }));

    expect(onRunWorkflow).toHaveBeenCalledWith("upcoming-workflow");
    expect(onUpdateWorkflowSafeFields).toHaveBeenCalledWith("upcoming-workflow", expect.objectContaining({
      status: "disabled",
      cadence: "daily",
      localTime: "17:00",
    }));
    expect(onUpdateWorkflowSafeFields).toHaveBeenCalledWith("paused-workflow", expect.objectContaining({
      status: "enabled",
      cadence: "daily",
      localTime: "10:00",
    }));
  });

  it("runs due schedules and surfaces categorized schedule notice counts", async () => {
    const onRunDueSchedules = vi.fn();
    render(
      <ScheduleTimelinePanel
        state={state()}
        schedulerStatus={{ running: false, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice="Scheduled runs: 2 started, 1 skipped, 1 error"
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={onRunDueSchedules}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Scheduler unavailable" })).toBeDisabled();
    expect(screen.getByText("Scheduler is stopped. Resume it to run the schedules shown here.")).toBeInTheDocument();
    expect(screen.getByText("Scheduler stopped. Scheduled entries will not run until scheduler resumes.")).toBeInTheDocument();
    expect(screen.getByText("Scheduled runs: 2 started, 1 skipped, 1 error")).toBeInTheDocument();
  });

  it("disables the primary CTA when visible entries are only upcoming", () => {
    render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("upcoming-workflow", "Upcoming Workflow", "17:00")),
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "No schedules due" })).toBeDisabled();
    expect(screen.getByText(/next scheduled run/i)).toBeInTheDocument();
  });

  it("enables the primary CTA when at least one schedule is overdue", async () => {
    const onRunDueSchedules = vi.fn();
    render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("due-workflow", "Due Workflow", "08:00")),
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 9)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={onRunDueSchedules}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Run due schedules" })).toBeEnabled();
    expect(screen.getByText("Overdue")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Run due schedules" }));

    expect(onRunDueSchedules).toHaveBeenCalledTimes(1);
  });

  it("labels paused future occurrences as future in week view", async () => {
    render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("paused-workflow", "Paused Workflow", "10:00"), "disabled"),
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: "Week" }));

    const tomorrowHeading = screen.getByText("Tomorrow").closest(".schedule-day-group");
    expect(tomorrowHeading).not.toBeNull();
    const tomorrow = tomorrowHeading as HTMLElement;
    const pausedOccurrence = within(tomorrow).getByRole("article", { name: "Paused Workflow schedule occurrence" });
    expect(within(pausedOccurrence).getByText("Future")).toBeInTheDocument();
  });

  it("persists segmented schedule mode and exposes calendar drag/drop rescheduling", async () => {
    const onUpdateWorkflowSafeFields = vi.fn();
    const onAssignScheduleOverride = vi.fn();
    const { unmount } = render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("upcoming-workflow", "Upcoming Workflow", "17:00")),
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={onUpdateWorkflowSafeFields}
        onAssignScheduleOverride={onAssignScheduleOverride}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: "Calendar" }));

    expect(localStorage.getItem("raven_schedule_view_mode")).toBe("calendar");
    expect(screen.getByRole("heading", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Monthly schedule calendar" })).toBeInTheDocument();
    expect(screen.getByText("Drag events or use time controls to assign one-off occurrences.")).toBeInTheDocument();

    const currentDay = screen.getByRole("gridcell", { name: /Jun 19 schedule day/ });
    const event = within(currentDay).getByRole("article", { name: /Upcoming Workflow scheduled at/ });
    const applyTime = within(event).getByLabelText("Upcoming Workflow calendar time");
    await userEvent.clear(applyTime);
    await userEvent.type(applyTime, "14:00");
    await userEvent.click(within(event).getByRole("button", { name: "Apply Upcoming Workflow calendar time" }));
    expect(onAssignScheduleOverride).toHaveBeenCalledWith(
      "upcoming-workflow",
      "2026-06-19T17:00",
      "2026-06-19T14:00",
    );

    const slot = screen.getByRole("gridcell", { name: /Jun 20 schedule day/ });
    const dataTransfer = {
      effectAllowed: "move",
      data: new Map<string, string>(),
      setData(type: string, value: string) {
        this.data.set(type, value);
      },
      getData(type: string) {
        return this.data.get(type) ?? "";
      },
    };

    fireEvent.dragStart(event, { dataTransfer });
    fireEvent.drop(slot, { dataTransfer });

    expect(onAssignScheduleOverride).toHaveBeenLastCalledWith(
      "upcoming-workflow",
      "2026-06-19T17:00",
      "2026-06-20T17:00",
    );

    unmount();
    const overrideRender = render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("upcoming-workflow", "Upcoming Workflow", "17:00")),
          ],
          scheduleOverrides: [
            {
              id: "schedule-override-upcoming-workflow",
              workflowId: "upcoming-workflow",
              originalRunAt: "2026-06-19T17:00",
              scheduledRunAt: "2026-06-20T17:00",
              createdAt: "2026-06-19T12:10:00.000Z",
            },
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    const overriddenOriginalDay = screen.getByRole("gridcell", { name: /Jun 19 schedule day/ });
    const overriddenTargetDay = screen.getByRole("gridcell", { name: /Jun 20 schedule day/ });
    expect(within(overriddenOriginalDay).queryByRole("article", { name: /Upcoming Workflow scheduled at/ })).not.toBeInTheDocument();
    expect(within(overriddenTargetDay).getByRole("article", { name: /Upcoming Workflow scheduled at/ })).toBeInTheDocument();
    overrideRender.unmount();

    unmount();
    render(
      <ScheduleTimelinePanel
        state={state({
          workflows: [
            workflow(scheduled("upcoming-workflow", "Upcoming Workflow", "17:00")),
          ],
        })}
        schedulerStatus={{ running: true, pollIntervalSeconds: 60 }}
        now={new Date(2026, 5, 19, 12)}
        runNotice=""
        onOpenWorkflow={vi.fn()}
        onRunWorkflow={vi.fn()}
        onRetryRun={vi.fn()}
        onRunDueSchedules={vi.fn()}
        onUpdateWorkflowSafeFields={vi.fn()}
        onAssignScheduleOverride={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Calendar" })).toHaveAttribute("aria-checked", "true");
  });
});
