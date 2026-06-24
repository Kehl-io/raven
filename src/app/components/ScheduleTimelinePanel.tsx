import { CalendarClock, Play, RotateCcw } from "lucide-react";
import { forwardRef, useMemo, useState } from "react";
import { formatSchedule } from "../../domain/format";
import type { AppState, SchedulerStatus, WorkflowVersion } from "../../domain/types";
import {
  buildScheduleTimelineModel,
  deriveProviderReadiness,
  type CommandCenterScheduleEntry,
  type ScheduleBucket,
  type SchedulePrimaryAction,
  type ScheduleTimelineDay,
} from "../selectors/commandCenter";
import type { WorkflowSafeFields } from "../contexts/AppStateContext";

type ScheduleViewMode = "day" | "week" | "calendar";
interface CalendarDay {
  date: Date;
  isoDate: string;
  label: string;
  dayNumber: string;
  inCurrentMonth: boolean;
  entries: CommandCenterScheduleEntry[];
}

interface ScheduleTimelinePanelProps {
  state: Pick<AppState, "workflows" | "runs" | "providers" | "llmProfiles" | "agentAuthProfiles" | "scheduleOverrides">;
  schedulerStatus: SchedulerStatus | null;
  now?: Date;
  runNotice?: string;
  isTargeted?: boolean;
  onOpenWorkflow: (workflowId: string) => void;
  onRunWorkflow: (workflowId: string) => void;
  onRetryRun: (runId: string) => void;
  onRunDueSchedules: () => void;
  onUpdateWorkflowSafeFields: (workflowId: string, fields: WorkflowSafeFields) => void;
  onAssignScheduleOverride: (workflowId: string, originalRunAt: string, scheduledRunAt: string) => void;
}

const STATUS_LABELS: Record<ScheduleBucket, string> = {
  manual: "Manual",
  upcoming: "Upcoming",
  running: "Running",
  completed: "Completed",
  missed: "Missed",
  failed: "Failed",
  retryable: "Retryable",
  paused: "Paused",
  unknown: "Unknown",
};

function statusLabel(bucket: ScheduleBucket, mode: "actions" | "summary"): string {
  if (mode === "actions") return STATUS_LABELS[bucket];
  if (bucket === "upcoming") return "Scheduled";
  return `${STATUS_LABELS[bucket]} occurrence`;
}

function formatLocalTime(iso: string | null): string {
  if (!iso) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function isoDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function localScheduleWindow(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function occurrenceForDate(
  workflow: WorkflowVersion,
  date: Date,
  baseEntry: CommandCenterScheduleEntry | undefined,
  now: Date,
  overrideRunAt?: string,
): CommandCenterScheduleEntry | null {
  const schedule = workflow.definition.schedule;
  if (!schedule || schedule.cadence === "manual" || !schedule.localTime) return null;
  if (schedule.cadence === "weekdays") {
    const day = date.getDay();
    if (day === 0 || day === 6) return null;
  }
  const [hour = "0", minute = "0"] = schedule.localTime.split(":");
  const occurrence = overrideRunAt ? new Date(overrideRunAt) : new Date(date);
  if (!overrideRunAt) occurrence.setHours(Number(hour), Number(minute), 0, 0);
  const isToday = isoDateKey(occurrence) === isoDateKey(now);
  const bucket: ScheduleBucket = workflow.status === "disabled"
    ? "paused"
    : isToday && occurrence.getTime() < now.getTime()
      ? baseEntry?.bucket === "completed" || baseEntry?.bucket === "failed" || baseEntry?.bucket === "retryable"
        ? baseEntry.bucket
        : "missed"
      : "upcoming";
  return {
    workflowId: workflow.workflowId,
    workflowName: workflow.definition.name,
    bucket,
    status: baseEntry?.status ?? (workflow.status === "enabled" ? "enabled" : workflow.status === "draft" ? "draft" : "paused"),
    scheduleLabel: formatSchedule(schedule),
    cadence: schedule.cadence,
    nextRunAt: occurrence.toISOString(),
    displayRunAt: occurrence.toISOString(),
    occurrenceKey: `${workflow.workflowId}:${occurrence.toISOString()}`,
    lastRunId: baseEntry?.lastRunId ?? null,
    lastRunStatus: baseEntry?.lastRunStatus ?? null,
    reason: isToday ? baseEntry?.reason ?? null : null,
  };
}

function buildCalendarMonth(
  workflows: WorkflowVersion[],
  baseEntries: CommandCenterScheduleEntry[],
  now: Date,
  overrides: AppState["scheduleOverrides"],
): CalendarDay[] {
  const baseEntryByWorkflow = new Map(baseEntries.map((entry) => [entry.workflowId, entry]));
  const overridesByOriginal = new Map(overrides.map((override) => [
    `${override.workflowId}:${localScheduleWindow(new Date(override.originalRunAt))}`,
    override,
  ]));
  const overridesByScheduled = new Map(overrides.map((override) => [
    `${override.workflowId}:${localScheduleWindow(new Date(override.scheduledRunAt))}`,
    override,
  ]));
  const overridesByDate = new Map<string, typeof overrides>();
  for (const override of overrides) {
    const key = isoDateKey(new Date(override.scheduledRunAt));
    overridesByDate.set(key, [...(overridesByDate.get(key) ?? []), override]);
  }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const recurringEntries = workflows
      .map((workflow) => {
        const entry = occurrenceForDate(workflow, date, baseEntryByWorkflow.get(workflow.workflowId), now);
        if (!entry?.displayRunAt) return entry;
        const localRunAt = localScheduleWindow(new Date(entry.displayRunAt));
        return overridesByOriginal.has(`${entry.workflowId}:${localRunAt}`) ||
          overridesByScheduled.has(`${entry.workflowId}:${localRunAt}`)
          ? null
          : entry;
      })
      .filter((entry): entry is CommandCenterScheduleEntry => entry != null)
    const overrideEntries = (overridesByDate.get(isoDateKey(date)) ?? [])
      .map((override) => {
        const workflow = workflows.find((candidate) => candidate.workflowId === override.workflowId);
        if (!workflow) return null;
        return occurrenceForDate(
          workflow,
          new Date(override.scheduledRunAt),
          baseEntryByWorkflow.get(workflow.workflowId),
          now,
          override.scheduledRunAt,
        );
      })
      .filter((entry): entry is CommandCenterScheduleEntry => entry != null);
    const entries = [...recurringEntries, ...overrideEntries]
      .sort((a, b) => (a.displayRunAt ?? "").localeCompare(b.displayRunAt ?? ""));
    return {
      date,
      isoDate: isoDateKey(date),
      label: new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date),
      dayNumber: new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(date),
      inCurrentMonth: date.getMonth() === now.getMonth(),
      entries,
    };
  });
}

function formatRelativeTime(iso: string | null, now: Date): string {
  if (!iso) return "time unavailable";
  const diffMs = new Date(iso).getTime() - now.getTime();
  const absMinutes = Math.max(1, Math.round(Math.abs(diffMs) / 60000));
  if (diffMs < 0) {
    if (absMinutes < 60) return `${absMinutes}m ago`;
    const hours = Math.round(absMinutes / 60);
    return `${hours}h ago`;
  }
  if (absMinutes < 60) return `in ${absMinutes}m`;
  const hours = Math.round(absMinutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

type EntryTemporalTone = "overdue" | "due-now" | "today" | "future";

function entryTemporalState(entry: CommandCenterScheduleEntry, now: Date): {
  tone: EntryTemporalTone;
  label: string;
} {
  const runAt = entry.displayRunAt ? new Date(entry.displayRunAt) : null;
  const diffMs = runAt ? runAt.getTime() - now.getTime() : null;
  const isToday = runAt
    ? runAt.getFullYear() === now.getFullYear() &&
      runAt.getMonth() === now.getMonth() &&
      runAt.getDate() === now.getDate()
    : false;

  if (entry.bucket === "missed" && diffMs !== null && Math.abs(diffMs) < 60_000) {
    return { tone: "due-now", label: "Due now" };
  }
  if (entry.bucket === "missed" || entry.bucket === "failed" || entry.bucket === "retryable") {
    return { tone: "overdue", label: "Overdue" };
  }
  if (isToday || entry.bucket === "running" || entry.bucket === "completed") {
    return { tone: "today", label: "Today" };
  }
  return { tone: "future", label: "Future" };
}

function scheduleActionForPanel(
  action: SchedulePrimaryAction,
  schedulerStatus: SchedulerStatus | null,
): SchedulePrimaryAction {
  if (schedulerStatus?.running) return action;
  return {
    label: "Scheduler unavailable",
    disabled: true,
    dueCount: action.dueCount,
    reason: schedulerStatus
      ? "Scheduler is stopped. Resume it to run the schedules shown here."
      : "Scheduler status is unavailable. Refresh scheduler status to run schedules.",
  };
}

function visibleScheduleAction(
  todayEntries: CommandCenterScheduleEntry[],
  nextSevenDays: ScheduleTimelineDay[],
): SchedulePrimaryAction {
  const visibleDueEntries = todayEntries.filter((entry) => entry.bucket === "missed");
  if (visibleDueEntries.length > 0) {
    return {
      label: "Run due schedules",
      disabled: false,
      dueCount: visibleDueEntries.length,
      reason: visibleDueEntries.length === 1
        ? "1 schedule is overdue and ready to run."
        : `${visibleDueEntries.length} schedules are overdue and ready to run.`,
    };
  }

  const nextVisibleEntry = nextSevenDays
    .flatMap((day) => day.entries)
    .filter((entry) => entry.bucket === "upcoming" && entry.displayRunAt)
    .sort((a, b) => new Date(a.displayRunAt!).getTime() - new Date(b.displayRunAt!).getTime())[0];
  if (nextVisibleEntry?.displayRunAt) {
    return {
      label: "No schedules due",
      disabled: true,
      dueCount: 0,
      reason: `The next scheduled run is ${nextVisibleEntry.workflowName} at ${nextVisibleEntry.displayRunAt}.`,
    };
  }

  return {
    label: "No schedules due",
    disabled: true,
    dueCount: 0,
    reason: "No automatic schedules are due right now.",
  };
}

function approvalModeLabel(workflow: WorkflowVersion): string {
  if (workflow.approvalMode === "auto_approve") return "Auto approval";
  if (workflow.approvalMode === "review_changes") return "Review changes";
  return "Always review";
}

function safeFieldsForStatus(workflow: WorkflowVersion, status: WorkflowVersion["status"]): WorkflowSafeFields {
  return {
    status,
    cadence: workflow.definition.schedule?.cadence ?? "manual",
    localTime: workflow.definition.schedule?.localTime,
    approvalMode: workflow.approvalMode,
    llmProfileRef: workflow.definition.defaults.llmProfileRef,
  };
}

function safeFieldsForTime(workflow: WorkflowVersion, localTime: string): WorkflowSafeFields {
  return {
    status: workflow.status,
    cadence: workflow.definition.schedule?.cadence ?? "daily",
    localTime,
    approvalMode: workflow.approvalMode,
    llmProfileRef: workflow.definition.defaults.llmProfileRef,
  };
}

export const ScheduleTimelinePanel = forwardRef<HTMLElement, ScheduleTimelinePanelProps>(
  function ScheduleTimelinePanel(
    {
      state,
      schedulerStatus,
      now,
      runNotice = "",
      isTargeted = false,
      onOpenWorkflow,
      onRunWorkflow,
      onRetryRun,
      onRunDueSchedules,
      onUpdateWorkflowSafeFields,
      onAssignScheduleOverride,
    },
    ref,
  ) {
    const currentTime = now ?? new Date();
    const [dismissedMisses, setDismissedMisses] = useState<Set<string>>(new Set());
    const [viewMode, setViewMode] = useState<ScheduleViewMode>(() => {
      const stored = localStorage.getItem("raven_schedule_view_mode");
      return stored === "day" || stored === "week" || stored === "calendar" ? stored : "day";
    });
    const [timeDrafts, setTimeDrafts] = useState<Record<string, string>>({});
    const [naturalLanguageDraft, setNaturalLanguageDraft] = useState("");
    const model = useMemo(
      () => buildScheduleTimelineModel(state, currentTime),
      [state, currentTime],
    );
    const workflowById = useMemo(
      () => new Map(state.workflows.map((workflow) => [workflow.workflowId, workflow])),
      [state.workflows],
    );
    const isDismissedMiss = (entry: CommandCenterScheduleEntry) =>
      entry.bucket === "missed" && entry.occurrenceKey != null && dismissedMisses.has(entry.occurrenceKey);
    const todayEntries = model.todayEntries.filter((entry) => !isDismissedMiss(entry));
    const nextSevenDays = model.nextSevenDays.map((day) => ({
      ...day,
      entries: day.entries.filter((entry) => !isDismissedMiss(entry)),
    }));
    const calendarDays = buildCalendarMonth(
      state.workflows,
      [...todayEntries, ...nextSevenDays.flatMap((day) => day.entries)],
      currentTime,
      state.scheduleOverrides ?? [],
    ).map((day) => ({
      ...day,
      entries: day.entries.filter((entry) => !isDismissedMiss(entry)),
    }));
    const calendarWeekdayLabels = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(2026, 5, 14 + index);
      return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
    });
    const nextSevenDayOccurrenceCount = nextSevenDays.reduce((sum, day) => sum + day.entries.length, 0);
    const manualEntries = model.manualEntries;
    const primaryAction = scheduleActionForPanel(
      visibleScheduleAction(todayEntries, nextSevenDays),
      schedulerStatus,
    );
    const scheduleNotice = runNotice.startsWith("Scheduled runs:") ? runNotice : "";
    const conflictGroups = nextSevenDays
      .flatMap((day) => day.entries.map((entry) => ({ day: day.label, entry })))
      .reduce<Map<string, Array<{ day: string; entry: CommandCenterScheduleEntry }>>>((groups, item) => {
        if (!item.entry.displayRunAt || item.entry.bucket === "manual" || item.entry.bucket === "paused") return groups;
        const key = new Date(item.entry.displayRunAt).toISOString().slice(0, 16);
        groups.set(key, [...(groups.get(key) ?? []), item]);
        return groups;
      }, new Map());
    const conflicts = [...conflictGroups.entries()]
      .filter(([, items]) => items.length > 1)
      .map(([key, items]) => ({ key, items }));
    const assignOccurrenceToDate = (
      workflowId: string,
      originalRunAt: string,
      targetDate: Date,
      localTime: string,
    ) => {
      const [hour = "0", minute = "0"] = localTime.split(":");
      const scheduled = new Date(targetDate);
      scheduled.setHours(Number(hour), Number(minute), 0, 0);
      onAssignScheduleOverride(
        workflowId,
        localScheduleWindow(new Date(originalRunAt)),
        localScheduleWindow(scheduled),
      );
    };

    const renderEntry = (entry: CommandCenterScheduleEntry, mode: "actions" | "summary") => {
      const workflow = workflowById.get(entry.workflowId);
      if (!workflow) return null;
      const readiness = deriveProviderReadiness(workflow, state);
      const providerLabel =
        readiness.status === "ready" || readiness.status === "degraded"
          ? `Provider ${readiness.status}`
          : "Provider needs setup";
      const canPause = workflow.status === "enabled" && entry.cadence !== "manual";
      const canResume = workflow.status === "disabled";
      const canRetry = (entry.bucket === "failed" || entry.bucket === "retryable") && entry.lastRunId;
      const timeDraft = timeDrafts[entry.workflowId] ?? workflow.definition.schedule?.localTime ?? "";
      const temporalState = entryTemporalState(entry, currentTime);

      return (
        <article
          key={`${entry.occurrenceKey ?? entry.workflowId}:${entry.bucket}:${mode}`}
          className={`schedule-entry schedule-entry-${entry.bucket} schedule-entry-${temporalState.tone}`}
          aria-label={mode === "actions"
            ? `${entry.workflowName} schedule entry`
            : `${entry.workflowName} schedule occurrence`}
        >
          <div className={`schedule-entry-rail schedule-entry-rail-${temporalState.tone}`} aria-hidden="true">
            <span className="schedule-entry-marker" />
            <span className="schedule-entry-line" />
          </div>
          <div className="schedule-entry-time">
            <strong>{formatLocalTime(entry.displayRunAt)}</strong>
            <span>{formatRelativeTime(entry.displayRunAt, currentTime)}</span>
          </div>
          <div className="schedule-entry-main">
            <div className="schedule-entry-title">
              <strong>{entry.workflowName}</strong>
              <span className={`schedule-state-pill schedule-state-${entry.bucket}`}>
                {statusLabel(entry.bucket, mode)}
              </span>
              <span className={`schedule-temporal-label schedule-temporal-label-${temporalState.tone}`}>
                {temporalState.label}
              </span>
            </div>
            <p>
              {entry.reason ?? entry.scheduleLabel}
            </p>
            <dl>
              <div>
                <dt>Approval</dt>
                <dd>{approvalModeLabel(workflow)}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{providerLabel}</dd>
              </div>
            </dl>
          </div>
          {mode === "actions" ? (
            <div className="schedule-entry-actions">
              <button type="button" onClick={() => onOpenWorkflow(entry.workflowId)}>
                Open workflow
              </button>
              {workflow.status === "enabled" && (
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => onRunWorkflow(entry.workflowId)}
                  aria-label={`Run ${entry.workflowName} now`}
                >
                  <Play size={14} />
                  Run now
                </button>
              )}
              {canPause && (
                <button
                  type="button"
                  onClick={() => onUpdateWorkflowSafeFields(
                    entry.workflowId,
                    safeFieldsForStatus(workflow, "disabled"),
                  )}
                  aria-label={`Pause ${entry.workflowName} schedule`}
                >
                  Pause
                </button>
              )}
              {canResume && (
                <button
                  type="button"
                  onClick={() => onUpdateWorkflowSafeFields(
                    entry.workflowId,
                    safeFieldsForStatus(workflow, "enabled"),
                  )}
                  aria-label={`Resume ${entry.workflowName}`}
                >
                  Resume
                </button>
              )}
              {canRetry && (
                <button
                  type="button"
                  onClick={() => entry.lastRunId && onRetryRun(entry.lastRunId)}
                  aria-label={`Retry ${entry.workflowName}`}
                >
                  <RotateCcw size={14} />
                  Retry
                </button>
              )}
              {canRetry && (
                <small className="schedule-backoff-note">
                  Retry/backoff details unavailable until scheduled run attempts are persisted.
                </small>
              )}
              {entry.cadence !== "manual" && (
                <label className="schedule-inline-edit">
                  Local time
                  <span>
                    <input
                      type="time"
                      value={timeDraft}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setTimeDrafts((current) => ({ ...current, [entry.workflowId]: value }));
                      }}
                      aria-label={`${entry.workflowName} local schedule time`}
                    />
                    <button
                      type="button"
                      onClick={() => onUpdateWorkflowSafeFields(entry.workflowId, safeFieldsForTime(workflow, timeDraft))}
                    >
                      Save time
                    </button>
                  </span>
                </label>
              )}
              {entry.bucket === "missed" && (
                <button
                  type="button"
                  onClick={() => {
                    if (!entry.occurrenceKey) return;
                    setDismissedMisses((current) => new Set(current).add(entry.occurrenceKey!));
                  }}
                  aria-label={`Dismiss ${entry.workflowName} missed schedule locally`}
                >
                  Dismiss
                </button>
              )}
            </div>
          ) : (
            <div className="schedule-entry-actions">
              <button type="button" onClick={() => onOpenWorkflow(entry.workflowId)}>
                Open
              </button>
            </div>
          )}
        </article>
      );
    };

    return (
      <section
        ref={ref}
        className={`schedule-command-panel command-panel ${isTargeted ? "command-panel-targeted" : ""}`}
        aria-label="Schedule command panel"
        role="region"
        tabIndex={-1}
      >
        <div className="command-panel-heading">
          <div>
            <span className="panel-kicker">Command Center / Schedule</span>
            <h2>Schedule</h2>
            <span className="timezone-label">Timezone: {model.timezone}</span>
          </div>
          <div className="schedule-view-switch" role="radiogroup" aria-label="Schedule view">
            {(["day", "week", "calendar"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                className={viewMode === mode ? "active" : undefined}
                aria-checked={viewMode === mode}
                onClick={() => {
                  setViewMode(mode);
                  localStorage.setItem("raven_schedule_view_mode", mode);
                }}
              >
                {mode === "day" ? "Day" : mode === "week" ? "Week" : "Calendar"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="primary-action"
            onClick={onRunDueSchedules}
            disabled={primaryAction.disabled}
          >
            <CalendarClock size={15} />
            {primaryAction.label}
          </button>
        </div>
        <p className="schedule-action-reason">{primaryAction.reason}</p>

        {schedulerStatus && !schedulerStatus.running && (
          <p className="schedule-stopped-note">
            Scheduler stopped. Scheduled entries will not run until scheduler resumes.
          </p>
        )}
        {scheduleNotice && <p className="schedule-run-notice">{scheduleNotice}</p>}
        {conflicts.length > 0 && (
          <div className="schedule-conflict-warning" role="status">
            <strong>Schedule conflict warning</strong>
            <span>
              {conflicts.length} time slot{conflicts.length === 1 ? "" : "s"} contain multiple workflow occurrences.
            </span>
          </div>
        )}

        {viewMode === "day" && <div className="schedule-panel-section">
          <div className="schedule-section-heading">
            <h3>Today timeline</h3>
            <span>{todayEntries.length} entries</span>
          </div>
          <div className="schedule-entry-list">
            {todayEntries.length > 0 ? (
              todayEntries.map((entry) => renderEntry(entry, "actions"))
            ) : (
              <p className="empty-state compact-empty">No scheduled workflow occurrences today.</p>
            )}
          </div>
        </div>}

        {viewMode === "week" && <div className="schedule-panel-section">
          <div className="schedule-section-heading">
            <h3>Next 7 days</h3>
            <span>{nextSevenDayOccurrenceCount} occurrences</span>
          </div>
          <div className="schedule-week-list">
            {nextSevenDays.map((day) => (
              <div key={day.isoDate} className="schedule-day-group">
                <div>
                  <strong>{day.label}</strong>
                  <span>{day.isoDate}</span>
                </div>
                <div className="schedule-entry-list compact">
                  {day.entries.map((entry) => renderEntry(entry, "summary"))}
                  {day.entries.length === 0 && <small>No scheduled occurrences</small>}
                </div>
              </div>
            ))}
          </div>
        </div>}

        {viewMode === "calendar" && (
          <div className="schedule-panel-section">
            <div className="schedule-section-heading">
              <h3>Calendar</h3>
              <span>{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(currentTime)}</span>
            </div>
            <div className="schedule-calendar-grid" role="grid" aria-label="Monthly schedule calendar">
              {calendarWeekdayLabels.map((label) => (
                <div key={label} className="schedule-calendar-day-heading" role="columnheader">
                  <strong>{label}</strong>
                </div>
              ))}
              {calendarDays.map((day) => (
                <div
                  key={day.isoDate}
                  className={`schedule-calendar-slot ${day.inCurrentMonth ? "" : "is-adjacent-month"}`}
                  role="gridcell"
                  aria-label={`${day.label} schedule day`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const workflowId = event.dataTransfer.getData("text/plain");
                    const originalRunAt = event.dataTransfer.getData("application/x-raven-original-run-at");
                    const workflow = workflowById.get(workflowId);
                    const localTime = workflow?.definition.schedule?.localTime ?? "09:00";
                    if (originalRunAt) {
                      assignOccurrenceToDate(workflowId, originalRunAt, day.date, localTime);
                    }
                  }}
                >
                  <div className="schedule-calendar-date">
                    <strong>{day.dayNumber}</strong>
                    <span>{day.entries.length} scheduled</span>
                  </div>
                  {day.entries.map((entry) => {
                    const draftedTime = timeDrafts[`${entry.workflowId}:${day.isoDate}`] ??
                      workflowById.get(entry.workflowId)?.definition.schedule?.localTime ??
                      "";
                    return (
                      <article
                        key={entry.occurrenceKey ?? `${entry.workflowId}:${day.isoDate}`}
                        className={`schedule-calendar-event schedule-entry-${entry.bucket}`}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", entry.workflowId);
                          if (entry.displayRunAt) {
                            event.dataTransfer.setData("application/x-raven-original-run-at", entry.displayRunAt);
                          }
                        }}
                        aria-label={`${entry.workflowName} scheduled at ${formatLocalTime(entry.displayRunAt)}`}
                      >
                        <button type="button" onClick={() => onOpenWorkflow(entry.workflowId)}>
                          <strong>{entry.workflowName}</strong>
                          <span>{formatLocalTime(entry.displayRunAt)}</span>
                        </button>
                        <label>
                          Time
                          <span>
                            <input
                              type="time"
                              value={draftedTime}
                              onChange={(event) => {
                                const value = event.currentTarget.value;
                                setTimeDrafts((current) => ({
                                  ...current,
                                  [`${entry.workflowId}:${day.isoDate}`]: value,
                                }));
                              }}
                              aria-label={`${entry.workflowName} calendar time`}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (entry.displayRunAt) {
                                  assignOccurrenceToDate(entry.workflowId, entry.displayRunAt, day.date, draftedTime);
                                }
                              }}
                              aria-label={`Apply ${entry.workflowName} calendar time`}
                            >
                              Apply
                            </button>
                          </span>
                        </label>
                      </article>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="schedule-natural-edit">
              <label>
                Calendar schedule note
                <input
                  value={naturalLanguageDraft}
                  onChange={(event) => setNaturalLanguageDraft(event.currentTarget.value)}
                  placeholder="Add an internal note before rescheduling"
                />
              </label>
              <small>
                Drag events or use time controls to assign one-off occurrences.
              </small>
            </div>
          </div>
        )}

        <div className="schedule-panel-section">
          <div className="schedule-section-heading">
            <h3>Manual workflows</h3>
            <span>{manualEntries.length} not scheduled</span>
          </div>
          <div className="manual-workflow-list">
            {manualEntries.map((entry) => {
              const workflow = workflowById.get(entry.workflowId);
              if (!workflow) return null;
              return (
                <article key={entry.workflowId} className="manual-workflow-entry">
                  <div>
                    <strong>{entry.workflowName}</strong>
                    <span>{formatSchedule(workflow.definition.schedule)}</span>
                  </div>
                  <span className="schedule-state-pill schedule-state-manual">Manual</span>
                  <button type="button" onClick={() => onOpenWorkflow(entry.workflowId)}>
                    Open workflow
                  </button>
                  {workflow.status === "enabled" && (
                    <button
                      type="button"
                      className="primary-action"
                      onClick={() => onRunWorkflow(entry.workflowId)}
                      aria-label={`Run ${entry.workflowName} now`}
                    >
                      <Play size={14} />
                      Run now
                    </button>
                  )}
                </article>
              );
            })}
            {manualEntries.length === 0 && (
              <p className="empty-state compact-empty">No manual workflows.</p>
            )}
          </div>
        </div>
      </section>
    );
  },
);
