import { Search, Rows3, LayoutGrid, X } from "lucide-react";
import type { WorkflowOperationalStatus } from "../selectors/commandCenter";

export type WorkflowScheduleFilter = "manual" | "scheduled" | "due-soon" | "overdue";
export type WorkflowApprovalFilter = "auto" | "review-changes" | "always-review" | "pending-approval";
export type WorkflowCostFilter = "has-cost" | "high-cost" | "no-reported-cost";
export type WorkflowRosterSortKey =
  | "next-run"
  | "last-run"
  | "status-severity"
  | "name"
  | "cost"
  | "created-updated";
export type WorkflowRosterDensity = "compact" | "comfortable";

export interface WorkflowRosterState {
  query: string;
  statuses: WorkflowOperationalStatus[];
  schedules: WorkflowScheduleFilter[];
  approvals: WorkflowApprovalFilter[];
  costs: WorkflowCostFilter[];
  sortKey: WorkflowRosterSortKey;
  density: WorkflowRosterDensity;
}

export interface WorkflowRosterChip {
  id: string;
  label: string;
  removeLabel?: string;
  onRemove: () => void;
}

interface WorkflowRosterToolbarProps {
  state: WorkflowRosterState;
  chips: WorkflowRosterChip[];
  resultCount: number;
  totalCount: number;
  onStateChange: (nextState: WorkflowRosterState) => void;
  onClearFilters: () => void;
}

const statusOptions: Array<{ value: WorkflowOperationalStatus; label: string }> = [
  { value: "enabled", label: "Enabled" },
  { value: "draft", label: "Draft" },
  { value: "paused", label: "Paused" },
  { value: "blocked", label: "Blocked" },
  { value: "failed-retryable", label: "Failed/retryable" },
  { value: "needs-setup", label: "Needs setup" },
];

const scheduleOptions: Array<{ value: WorkflowScheduleFilter; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "scheduled", label: "Scheduled" },
  { value: "due-soon", label: "Due soon" },
  { value: "overdue", label: "Overdue" },
];

const approvalOptions: Array<{ value: WorkflowApprovalFilter; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "review-changes", label: "Review changes" },
  { value: "always-review", label: "Always review" },
  { value: "pending-approval", label: "Pending approval" },
];

const costOptions: Array<{ value: WorkflowCostFilter; label: string }> = [
  { value: "has-cost", label: "Has cost" },
  { value: "high-cost", label: "High cost" },
  { value: "no-reported-cost", label: "No reported cost" },
];

const sortOptions: Array<{ value: WorkflowRosterSortKey; label: string }> = [
  { value: "next-run", label: "Next run" },
  { value: "last-run", label: "Last run" },
  { value: "status-severity", label: "Status severity" },
  { value: "name", label: "Name" },
  { value: "cost", label: "Cost this period" },
  { value: "created-updated", label: "Created/updated" },
];

export function WorkflowRosterToolbar({
  state,
  chips,
  resultCount,
  totalCount,
  onStateChange,
  onClearFilters,
}: WorkflowRosterToolbarProps) {
  const update = <K extends keyof WorkflowRosterState>(key: K, value: WorkflowRosterState[K]) => {
    onStateChange({ ...state, [key]: value });
  };

  return (
    <section className="workflow-roster-toolbar" aria-label="Workflow roster controls">
      <div className="workflow-roster-toolbar-primary">
        <label className="workflow-roster-search">
          <span>Search workflows</span>
          <Search size={16} />
          <input
            type="search"
            value={state.query}
            onChange={(event) => update("query", event.target.value)}
            placeholder="Name, provider, destination"
          />
        </label>
        <label>
          <span>Sort</span>
          <select
            value={state.sortKey}
            onChange={(event) => update("sortKey", event.target.value as WorkflowRosterSortKey)}
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="workflow-density-toggle" role="group" aria-label="Roster density">
          <button
            type="button"
            className={state.density === "compact" ? "active" : ""}
            aria-pressed={state.density === "compact"}
            onClick={() => update("density", "compact")}
          >
            <Rows3 size={16} />
            Compact
          </button>
          <button
            type="button"
            className={state.density === "comfortable" ? "active" : ""}
            aria-pressed={state.density === "comfortable"}
            onClick={() => update("density", "comfortable")}
          >
            <LayoutGrid size={16} />
            Cards
          </button>
        </div>
      </div>

      <div className="workflow-roster-filter-grid">
        <FilterSelect
          label="Status"
          value=""
          options={statusOptions.filter((option) => !state.statuses.includes(option.value))}
          onChange={(value) => update("statuses", [...state.statuses, value as WorkflowOperationalStatus])}
        />
        <FilterSelect
          label="Schedule"
          value=""
          options={scheduleOptions.filter((option) => !state.schedules.includes(option.value))}
          onChange={(value) => update("schedules", [...state.schedules, value as WorkflowScheduleFilter])}
        />
        <FilterSelect
          label="Approval"
          value=""
          options={approvalOptions.filter((option) => !state.approvals.includes(option.value))}
          onChange={(value) => update("approvals", [...state.approvals, value as WorkflowApprovalFilter])}
        />
        <FilterSelect
          label="Cost"
          value=""
          options={costOptions.filter((option) => !state.costs.includes(option.value))}
          onChange={(value) => update("costs", [...state.costs, value as WorkflowCostFilter])}
        />
      </div>

      <div className="workflow-roster-chip-row" aria-label="Active workflow filters">
        <span>{resultCount} of {totalCount}</span>
        {chips.length === 0 ? (
          <small>No filters active</small>
        ) : (
          chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="workflow-filter-chip"
              onClick={chip.onRemove}
              aria-label={chip.removeLabel ?? `Remove filter ${chip.label}`}
            >
              {chip.label}
              <X size={14} />
            </button>
          ))
        )}
        {chips.length > 0 && (
          <button type="button" className="workflow-clear-filters" onClick={onClearFilters}>
            Clear filters
          </button>
        )}
      </div>
    </section>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => {
          const next = event.target.value as T;
          if (next) onChange(next);
        }}
      >
        <option value="">Add {label.toLowerCase()}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
