import { Archive, CalendarClock, Download, Ellipsis, Loader, LayoutGrid, Pause, Play, Power, Settings, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAppState } from "../contexts/AppStateContext";
import { useUI } from "../contexts/UIContext";
import { useRunStream } from "../contexts";
import {
  WorkflowRosterToolbar,
  type WorkflowApprovalFilter,
  type WorkflowCostFilter,
  type WorkflowRosterChip,
  type WorkflowRosterDensity,
  type WorkflowRosterSortKey,
  type WorkflowRosterState,
  type WorkflowScheduleFilter,
} from "../components/WorkflowRosterToolbar";
import {
  buildScheduleEntries,
  buildUsageSummary,
  deriveProviderReadiness,
  deriveWorkflowOperationalStatus,
  type CommandCenterScheduleEntry,
  type WorkflowOperationalStatus,
} from "../selectors/commandCenter";
import { formatRelativeTime, formatSchedule } from "../../domain/format";
import type {
  AppState,
  ApprovalMode,
  Artifact,
  RunState,
  WorkflowRun,
  WorkflowVersion,
  WorkflowState,
  ApprovalRequest,
} from "../../domain/types";

const ROSTER_STORAGE_KEY = "raven:workflow-roster";
const ROSTER_SAVED_VIEWS_STORAGE_KEY = "raven:workflow-roster-saved-views";
const HIGH_COST_USD = 1;
type WorkflowCadence = NonNullable<WorkflowVersion["definition"]["schedule"]>["cadence"];

const defaultRosterState: WorkflowRosterState = {
  query: "",
  statuses: [],
  schedules: [],
  approvals: [],
  costs: [],
  sortKey: "status-severity",
  density: "compact",
};

interface WorkflowSavedView {
  id: string;
  name: string;
  state: WorkflowRosterState;
  builtIn?: boolean;
}

const builtInSavedViews: WorkflowSavedView[] = [
  {
    id: "needs-attention",
    name: "Needs attention",
    builtIn: true,
    state: {
      ...defaultRosterState,
      statuses: ["failed-retryable", "blocked", "needs-setup"],
      sortKey: "status-severity",
    },
  },
  {
    id: "scheduled",
    name: "Scheduled",
    builtIn: true,
    state: {
      ...defaultRosterState,
      schedules: ["scheduled"],
      sortKey: "next-run",
    },
  },
  {
    id: "drafts",
    name: "Drafts",
    builtIn: true,
    state: {
      ...defaultRosterState,
      statuses: ["draft"],
      sortKey: "created-updated",
    },
  },
  {
    id: "high-cost",
    name: "High cost",
    builtIn: true,
    state: {
      ...defaultRosterState,
      costs: ["high-cost"],
      sortKey: "cost",
    },
  },
];

const statusLabels: Record<WorkflowOperationalStatus, string> = {
  enabled: "Enabled",
  draft: "Draft",
  paused: "Paused",
  blocked: "Blocked",
  "failed-retryable": "Failed/retryable",
  "needs-setup": "Needs setup",
};

const scheduleFilterLabels: Record<WorkflowScheduleFilter, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  "due-soon": "Due soon",
  overdue: "Overdue",
};

const approvalFilterLabels: Record<WorkflowApprovalFilter, string> = {
  auto: "Auto",
  "review-changes": "Review changes",
  "always-review": "Always review",
  "pending-approval": "Pending approval",
};

const costFilterLabels: Record<WorkflowCostFilter, string> = {
  "has-cost": "Has cost",
  "high-cost": "High cost",
  "no-reported-cost": "No reported cost",
};

const approvalLabels: Record<ApprovalMode, string> = {
  auto_approve: "Auto",
  review_changes: "Review changes",
  always_review: "Always review",
};

interface WorkflowRosterItem {
  workflow: WorkflowVersion;
  status: WorkflowOperationalStatus;
  latestRun: WorkflowRun | null;
  scheduleEntry: CommandCenterScheduleEntry;
  providerModel: string;
  destination: string;
  artifactCount: number;
  artifactTypes: string[];
  costUsd: number;
  reportedCostRunCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  searchText: string;
  pendingApproval: boolean;
  providerSetupRequired: boolean;
  healthScore: number;
  healthNotes: string[];
}

interface WorkflowOptimizationSuggestion {
  id: string;
  title: string;
  body: string;
}

type WorkflowSafeFieldPatch = Partial<{
  status: WorkflowState;
  cadence: WorkflowCadence;
  localTime: string;
  approvalMode: ApprovalMode;
}>;

export function WorkflowsView() {
  const { state, runNotice, actions } = useAppState();
  const {
    openCommandCenterTarget,
    openCreateWorkflowHub,
    openWorkflow,
    openWorkflowRun,
    setView,
    workflowRosterCommand,
  } = useUI();
  const { startStreamedRun, runStream } = useRunStream();
  const [rosterState, setRosterState] = useState<WorkflowRosterState>(readRosterState);
  const [customSavedViews, setCustomSavedViews] = useState<WorkflowSavedView[]>(readCustomSavedViews);
  const [savedViewName, setSavedViewName] = useState("");
  const [bulkNotice, setBulkNotice] = useState("No workflows selected.");
  const [bulkActionInFlight, setBulkActionInFlight] = useState(false);
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<string[]>([]);
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  useEffect(() => {
    localStorage.setItem(ROSTER_STORAGE_KEY, JSON.stringify(rosterState));
  }, [rosterState]);

  useEffect(() => {
    localStorage.setItem(ROSTER_SAVED_VIEWS_STORAGE_KEY, JSON.stringify(customSavedViews));
  }, [customSavedViews]);

  useEffect(() => {
    if (!workflowRosterCommand) return;
    setRosterState((current) => ({
      ...current,
      statuses: workflowRosterCommand.statuses
        ? arrayOf(workflowRosterCommand.statuses, isWorkflowOperationalStatus)
        : current.statuses,
      schedules: workflowRosterCommand.schedules
        ? arrayOf(workflowRosterCommand.schedules, isWorkflowScheduleFilter)
        : current.schedules,
      sortKey: isWorkflowRosterSortKey(workflowRosterCommand.sortKey)
        ? workflowRosterCommand.sortKey
        : current.sortKey,
    }));
    if (workflowRosterCommand.statuses || workflowRosterCommand.schedules) {
      setFiltersExpanded(true);
    }
  }, [workflowRosterCommand]);

  const rosterItems = useMemo(
    () => buildRosterItems(state, runStream.pendingApproval),
    [state, runStream.pendingApproval],
  );

  const filteredItems = useMemo(() => {
    const query = normalize(rosterState.query);
    return rosterItems
      .filter((item) => matchesSearch(item, query))
      .filter((item) => matchesStatus(item, rosterState.statuses))
      .filter((item) => matchesSchedule(item, rosterState.schedules))
      .filter((item) => matchesApproval(item, rosterState.approvals))
      .filter((item) => matchesCost(item, rosterState.costs))
      .sort((a, b) => compareRosterItems(a, b, rosterState.sortKey));
  }, [rosterItems, rosterState]);

  useEffect(() => {
    const workflowIds = new Set(rosterItems.map((item) => item.workflow.workflowId));
    setSelectedWorkflowIds((current) => current.filter((workflowId) => workflowIds.has(workflowId)));
  }, [rosterItems]);

  const selectedItems = useMemo(
    () => rosterItems.filter((item) => selectedWorkflowIds.includes(item.workflow.workflowId)),
    [rosterItems, selectedWorkflowIds],
  );

  const optimizationSuggestions = useMemo(
    () => buildOptimizationSuggestions(rosterItems),
    [rosterItems],
  );

  const activeChips = useMemo(
    () => buildActiveChips(rosterState, setRosterState),
    [rosterState],
  );
  const activeFilterCount = [rosterState.statuses, rosterState.schedules, rosterState.approvals, rosterState.costs].filter(
    (arr) => arr.length > 0,
  ).length;
  const clearFilters = () => {
    setRosterState((current) => ({
      ...defaultRosterState,
      sortKey: current.sortKey,
      density: current.density,
    }));
  };

  const applySavedView = (view: WorkflowSavedView) => {
    setRosterState((current) => ({
      ...view.state,
      density: view.state.density ?? current.density,
    }));
    setBulkNotice(`Applied saved view ${view.name}.`);
  };

  const saveCurrentView = () => {
    const trimmedName = savedViewName.trim();
    if (!trimmedName) {
      setBulkNotice("Name the current roster view before saving it.");
      return;
    }
    const savedView: WorkflowSavedView = {
      id: `custom:${slugForSavedView(trimmedName)}`,
      name: trimmedName,
      state: rosterState,
    };
    setCustomSavedViews((current) => [
      savedView,
      ...current.filter((view) => view.id !== savedView.id),
    ].slice(0, 12));
    setSavedViewName("");
    setBulkNotice(`Saved roster view ${trimmedName}.`);
  };

  const deleteCustomSavedView = (viewId: string) => {
    const view = customSavedViews.find((candidate) => candidate.id === viewId);
    setCustomSavedViews((current) => current.filter((candidate) => candidate.id !== viewId));
    setBulkNotice(view ? `Deleted saved view ${view.name}.` : "Deleted saved view.");
  };

  const runWorkflow = (workflow: WorkflowVersion) => {
    void startStreamedRun(workflow.workflowId).then((result) => {
      if (result) actions.applyRunResults([result]);
    });
  };

  const updateWorkflowSafeFields = (workflow: WorkflowVersion, patch: WorkflowSafeFieldPatch) => {
    const cadence = patch.cadence ?? workflow.definition.schedule?.cadence ?? "manual";
    const localTime =
      cadence === "manual"
        ? undefined
        : patch.localTime || workflow.definition.schedule?.localTime || "09:00";
    return actions.updateWorkflowSafeFields(workflow.workflowId, {
      status: patch.status ?? workflow.status,
      cadence,
      localTime,
      approvalMode: patch.approvalMode ?? workflow.approvalMode,
      llmProfileRef: workflow.definition.defaults.llmProfileRef,
    });
  };

  const updateWorkflowStatus = (workflow: WorkflowVersion, status: WorkflowVersion["status"]) => {
    void updateWorkflowSafeFields(workflow, { status });
  };

  const updateSelectedWorkflows = async (patch: WorkflowSafeFieldPatch, label: string) => {
    if (selectedItems.length === 0) return;
    setBulkActionInFlight(true);
    const count = selectedItems.length;
    try {
      await Promise.all(selectedItems.map((item) => updateWorkflowSafeFields(item.workflow, patch)));
      setSelectedWorkflowIds([]);
      setBulkNotice(`${label} updated ${count} workflow${count === 1 ? "" : "s"}.`);
    } finally {
      setBulkActionInFlight(false);
    }
  };

  const runSelectedWorkflows = async () => {
    if (selectedItems.length === 0) return;
    setBulkActionInFlight(true);
    const count = selectedItems.length;
    try {
      const results = await Promise.all(selectedItems.map((item) => startStreamedRun(item.workflow.workflowId)));
      actions.applyRunResults(results.filter((result) => result != null));
      setSelectedWorkflowIds([]);
      setBulkNotice(`Started ${count} workflow${count === 1 ? "" : "s"}.`);
    } finally {
      setBulkActionInFlight(false);
    }
  };

  const exportSelectedWorkflows = () => {
    if (selectedItems.length === 0) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      workflows: selectedItems.map((item) => ({
        workflowId: item.workflow.workflowId,
        version: item.workflow.version,
        status: item.workflow.status,
        approvalMode: item.workflow.approvalMode,
        definition: item.workflow.definition,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `raven-workflows-${selectedItems.length}.json`;
    document.body.appendChild(link);
    if (!navigator.userAgent.toLowerCase().includes("jsdom")) {
      link.click();
    }
    link.remove();
    URL.revokeObjectURL(url);
    setBulkNotice(`Exported ${selectedItems.length} workflow definition${selectedItems.length === 1 ? "" : "s"}.`);
  };

  const toggleWorkflowSelection = (workflowId: string, selected: boolean) => {
    setSelectedWorkflowIds((current) => {
      if (!selected) return current.filter((item) => item !== workflowId);
      return current.includes(workflowId) ? current : [...current, workflowId];
    });
  };

  const allFilteredSelected =
    filteredItems.length > 0 && filteredItems.every((item) => selectedWorkflowIds.includes(item.workflow.workflowId));

  const toggleFilteredSelection = (selected: boolean) => {
    setSelectedWorkflowIds((current) => {
      const filteredIds = filteredItems.map((item) => item.workflow.workflowId);
      if (!selected) return current.filter((workflowId) => !filteredIds.includes(workflowId));
      return Array.from(new Set([...current, ...filteredIds]));
    });
  };

  const canPauseSelected = selectedItems.some((item) => item.workflow.status === "enabled");
  const canResumeSelected = selectedItems.some((item) => item.workflow.status === "disabled" || item.workflow.status === "draft");
  const canRunSelected = selectedItems.some((item) => item.workflow.status === "enabled");
  const savedViews = [...builtInSavedViews, ...customSavedViews];

  return (
    <section className="view-grid">
      <header className="page-header">
        <div>
          <h1>Workflows</h1>
        </div>
        <div className="header-actions">
          <button className="primary-action" type="button" onClick={() => openCreateWorkflowHub()}>
            <Sparkles size={18} />
            Create workflow
          </button>
          <button type="button" onClick={() => setView("marketplace")}>
            <LayoutGrid size={18} />
            Browse templates
          </button>
          <button type="button" onClick={() => actions.runDueSchedules()}>
            <Play size={18} />
            Run due schedules
          </button>
        </div>
        {runNotice && <span className="success-note">{runNotice}</span>}
      </header>

      <div className="workflow-filter-toggle-row">
        <button
          className="workflow-filter-toggle"
          onClick={() => setFiltersExpanded(!filtersExpanded)}
          type="button"
        >
          Filters
          {activeFilterCount > 0 && (
            <span className="filter-active-chip">{activeFilterCount} active</span>
          )}
        </button>
      </div>
      {filtersExpanded && (
        <>
          <WorkflowRosterToolbar
            state={rosterState}
            chips={activeChips}
            resultCount={filteredItems.length}
            totalCount={rosterItems.length}
            onStateChange={setRosterState}
            onClearFilters={clearFilters}
          />

          <div className="workflow-saved-view-row" aria-label="Saved workflow views">
            <span>Saved views</span>
            <div className="workflow-saved-view-buttons">
              {savedViews.map((view) => (
                <span key={view.id} className="workflow-saved-view-item">
                  <button type="button" aria-label={`Saved view ${view.name}`} onClick={() => applySavedView(view)}>
                    {view.name}
                  </button>
                  {!view.builtIn && (
                    <button
                      type="button"
                      className="workflow-saved-view-delete"
                      aria-label={`Delete saved view ${view.name}`}
                      title={`Delete ${view.name}`}
                      onClick={() => deleteCustomSavedView(view.id)}
                    >
                      Delete
                    </button>
                  )}
                </span>
              ))}
            </div>
            <label className="workflow-save-view-control">
              <span>Save current view</span>
              <input
                value={savedViewName}
                onChange={(event) => setSavedViewName(event.currentTarget.value)}
                placeholder="My filtered view"
              />
            </label>
            <button type="button" onClick={saveCurrentView}>
              Save view
            </button>
          </div>
        </>
      )}

      <div className="workflow-bulk-action-bar" aria-label="Selected workflow bulk actions">
          <strong>{selectedItems.length} selected</strong>
          <button
            type="button"
            onClick={() => toggleFilteredSelection(true)}
            disabled={filteredItems.length === 0 || allFilteredSelected || bulkActionInFlight}
            aria-label="Select all visible workflows"
          >
            Select visible
          </button>
          <button
            type="button"
            onClick={() => setSelectedWorkflowIds([])}
            disabled={selectedItems.length === 0 || bulkActionInFlight}
            aria-label="Clear workflow selection"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => void updateSelectedWorkflows({ status: "disabled" }, "Pause")}
            disabled={!canPauseSelected || bulkActionInFlight}
            aria-label="Pause selected workflows"
          >
            <Pause size={16} />
            Pause
          </button>
          <button
            type="button"
            onClick={() => void updateSelectedWorkflows({ status: "enabled" }, "Resume")}
            disabled={!canResumeSelected || bulkActionInFlight}
            aria-label="Resume selected workflows"
          >
            <Power size={16} />
            Resume
          </button>
          <button
            type="button"
            onClick={() => void runSelectedWorkflows()}
            disabled={!canRunSelected || bulkActionInFlight}
            aria-label="Run selected workflows now"
          >
            <Play size={16} />
            Run now
          </button>
          <label>
            <span>Approval</span>
            <select
              aria-label="Set selected approval mode"
              value=""
              disabled={selectedItems.length === 0 || bulkActionInFlight}
              onChange={(event) => {
                const approvalMode = event.target.value as ApprovalMode | "";
                if (approvalMode) void updateSelectedWorkflows({ approvalMode }, "Approval mode");
              }}
            >
              <option value="">Set approval mode</option>
              <option value="auto_approve">Auto</option>
              <option value="review_changes">Review changes</option>
              <option value="always_review">Always review</option>
            </select>
          </label>
          <button
            type="button"
            onClick={exportSelectedWorkflows}
            disabled={selectedItems.length === 0 || bulkActionInFlight}
            aria-label="Export selected workflows"
          >
            <Download size={16} />
            Export
          </button>
          <span className="workflow-bulk-action-notice" role="status" aria-live="polite">
            {bulkActionInFlight ? "Updating selected workflows..." : bulkNotice}
          </span>
        </div>

      {rosterItems.length === 0 ? (
        <div className="workflow-roster-empty">
          <p>No workflows yet. Create one to get started.</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="workflow-roster-empty">
          <strong>No workflows match.</strong>
          <p>{activeChips.length > 0 ? activeChips.map((chip) => chip.label).join(", ") : "No active filters."}</p>
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : rosterState.density === "compact" ? (
        <div className="workflow-roster-table" role="region" aria-label="Compact workflow roster">
          <div className="workflow-roster-header">
            <label className="workflow-select-cell">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={(event) => toggleFilteredSelection(event.target.checked)}
                aria-label="Select all visible workflows"
              />
              <span>Select</span>
            </label>
            <span>Workflow</span>
            <span>Status</span>
            <span>Operations</span>
            <span>Routing</span>
            <span>Summary</span>
            <span>Actions</span>
          </div>
          {filteredItems.map((item) => (
            <WorkflowRosterRow
              key={item.workflow.id}
              item={item}
              mode="row"
              activeRunId={runStream.activeRunId}
              selected={selectedWorkflowIds.includes(item.workflow.workflowId)}
              onSelectedChange={(selected) => toggleWorkflowSelection(item.workflow.workflowId, selected)}
              onOpen={() => openWorkflow(item.workflow.workflowId, "workflows")}
              onOpenRun={() =>
                item.latestRun
                  ? openWorkflowRun(item.workflow.workflowId, item.latestRun.id, "workflows")
                  : openWorkflow(item.workflow.workflowId, "workflows")
              }
              onRun={() => runWorkflow(item.workflow)}
              onEnable={() => updateWorkflowStatus(item.workflow, "enabled")}
              onDisable={() => updateWorkflowStatus(item.workflow, "disabled")}
              onEditSchedule={() => openCommandCenterTarget("schedule")}
              onSetupProvider={() => setView("settings")}
              onQuickEdit={(patch) => void updateWorkflowSafeFields(item.workflow, patch)}
            />
          ))}
        </div>
      ) : (
        <div className="workflow-roster-card-grid" role="region" aria-label="Workflow roster cards">
          {filteredItems.map((item) => (
            <WorkflowRosterRow
              key={item.workflow.id}
              item={item}
              mode="card"
              activeRunId={runStream.activeRunId}
              selected={selectedWorkflowIds.includes(item.workflow.workflowId)}
              onSelectedChange={(selected) => toggleWorkflowSelection(item.workflow.workflowId, selected)}
              onOpen={() => openWorkflow(item.workflow.workflowId, "workflows")}
              onOpenRun={() =>
                item.latestRun
                  ? openWorkflowRun(item.workflow.workflowId, item.latestRun.id, "workflows")
                  : openWorkflow(item.workflow.workflowId, "workflows")
              }
              onRun={() => runWorkflow(item.workflow)}
              onEnable={() => updateWorkflowStatus(item.workflow, "enabled")}
              onDisable={() => updateWorkflowStatus(item.workflow, "disabled")}
              onEditSchedule={() => openCommandCenterTarget("schedule")}
              onSetupProvider={() => setView("settings")}
              onQuickEdit={(patch) => void updateWorkflowSafeFields(item.workflow, patch)}
            />
          ))}
        </div>
      )}

      <WorkflowRosterHealthFooter
        items={rosterItems}
        selectedItems={selectedItems}
        suggestions={optimizationSuggestions}
      />
    </section>
  );
}

function WorkflowRosterRow({
  item,
  mode,
  activeRunId,
  selected,
  onSelectedChange,
  onOpen,
  onOpenRun,
  onRun,
  onEnable,
  onDisable,
  onEditSchedule,
  onSetupProvider,
  onQuickEdit,
}: {
  item: WorkflowRosterItem;
  mode: "row" | "card";
  activeRunId: string | null;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onOpen: () => void;
  onOpenRun: () => void;
  onRun: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onEditSchedule: () => void;
  onSetupProvider: () => void;
  onQuickEdit: (patch: WorkflowSafeFieldPatch) => void;
}) {
  const workflow = item.workflow;
  const running = activeRunId != null;
  const compactMode = mode === "row";
  const scheduleSummary = formatSchedule(workflow.definition.schedule);
  const destinationSummary = destinationLabel(item.destination);
  const lastRunSummary = item.latestRun ? runLabel(item.latestRun) : "No runs";
  const nextRunSummary = item.nextRunAt ? formatCompactDateTime(item.nextRunAt) : "None";
  const setupNeeded = item.providerSetupRequired;
  const runButtonLabel = running
    ? `Running ${workflow.definition.name}`
    : `Run now for ${workflow.definition.name}`;
  const compactSummaryItems = [
    { label: "Cost", value: formatCostLabel(item) },
    { label: "Artifacts", value: `${item.artifactCount} artifact${item.artifactCount === 1 ? "" : "s"}` },
    { label: "Health", value: `${item.healthScore}/100` },
  ];

  return (
    <article
      className={mode === "row" ? "workflow-roster-row" : "workflow-roster-card"}
      aria-label={`${workflow.definition.name} workflow`}
    >
      <label className="workflow-select-cell">
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelectedChange(event.target.checked)}
          aria-label={`Select ${workflow.definition.name}`}
        />
      </label>
      <div className="workflow-roster-name">
        <strong>{workflow.definition.name}</strong>
        <span>{workflow.definition.description}</span>
      </div>
      <div className="workflow-roster-status">
        <span className={`workflow-status-pill status-${item.status}`}>{statusLabels[item.status]}</span>
        <small>{approvalLabels[workflow.approvalMode]}</small>
      </div>
      {compactMode ? (
        <>
          <CompactRosterSection
            className="workflow-roster-operations"
            ariaLabel={`${workflow.definition.name} operations`}
            items={[
              { label: "Last", value: lastRunSummary },
              { label: "Next", value: nextRunSummary },
            ]}
          />
          <CompactRosterSection
            className="workflow-roster-routing"
            ariaLabel={`${workflow.definition.name} routing`}
            items={[
              { label: "Schedule", value: scheduleSummary },
              { label: "Provider", value: item.providerModel },
              { label: "Destination", value: destinationSummary },
            ]}
          />
          <CompactRosterSection
            className="workflow-roster-summary"
            ariaLabel={`${workflow.definition.name} summary`}
            items={compactSummaryItems}
          />
        </>
      ) : (
        <div className="workflow-roster-metrics" aria-label={`${workflow.definition.name} operations summary`}>
          <RosterMetric label="Last run" value={lastRunSummary} />
          <RosterMetric label="Next run" value={nextRunSummary} />
          <RosterMetric label="Schedule" value={scheduleSummary} />
          <RosterMetric label="Provider/model" value={item.providerModel} />
          <RosterMetric label="Destination" value={destinationSummary} />
          <RosterMetric
            label="Artifacts"
            value={`${item.artifactCount} artifact${item.artifactCount === 1 ? "" : "s"}`}
          />
          <RosterMetric label="Cost" value={formatCostLabel(item)} />
          <RosterMetric label={`${workflow.definition.name} health score`} value={`${item.healthScore}/100`} />
        </div>
      )}
      {!compactMode && (
        <div className="workflow-quick-edit" aria-label={`Quick edit ${workflow.definition.name}`}>
          <select
            aria-label={`Quick status for ${workflow.definition.name}`}
            value={workflow.status}
            onChange={(event) => onQuickEdit({ status: event.target.value as WorkflowState })}
          >
            <option value="enabled">Enabled</option>
            <option value="disabled">Paused</option>
            <option value="draft">Draft</option>
          </select>
          <select
            aria-label={`Quick schedule for ${workflow.definition.name}`}
            value={workflow.definition.schedule?.cadence ?? "manual"}
            onChange={(event) => onQuickEdit({ cadence: event.target.value as WorkflowCadence })}
          >
            <option value="manual">Manual</option>
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
          </select>
          {(workflow.definition.schedule?.cadence ?? "manual") !== "manual" && (
            <input
              type="time"
              aria-label={`Quick schedule time for ${workflow.definition.name}`}
              value={workflow.definition.schedule?.localTime ?? "09:00"}
              onChange={(event) => onQuickEdit({ localTime: event.target.value })}
            />
          )}
          <select
            aria-label={`Quick approval mode for ${workflow.definition.name}`}
            value={workflow.approvalMode}
            onChange={(event) => onQuickEdit({ approvalMode: event.target.value as ApprovalMode })}
          >
            <option value="auto_approve">Auto</option>
            <option value="review_changes">Review changes</option>
            <option value="always_review">Always review</option>
          </select>
        </div>
      )}
      <div className="workflow-roster-actions">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${workflow.definition.name} details`}
        >
          <LayoutGrid size={16} />
          Open details
        </button>
        <button
          type="button"
          onClick={onEditSchedule}
          aria-label={`Edit ${workflow.definition.name} schedule`}
        >
          <CalendarClock size={16} />
          Edit schedule
        </button>
        {compactMode && setupNeeded ? (
          <button
            className="primary-action"
            type="button"
            onClick={onSetupProvider}
            aria-label={`Edit ${workflow.definition.name} setup`}
          >
            <Settings size={18} />
            Edit setup
          </button>
        ) : workflow.status === "enabled" ? (
          <button
            className="primary-action"
            type="button"
            onClick={onRun}
            disabled={running}
            aria-label={runButtonLabel}
          >
            {running ? (
              <>
                <Loader size={18} className="running-spinner" />
                Running
              </>
            ) : (
              <>
                <Play size={18} />
                Run now
              </>
            )}
          </button>
        ) : null}
        {compactMode ? (
          <details className="workflow-roster-overflow">
            <summary aria-label={`More actions for ${workflow.definition.name}`}>
              <Ellipsis size={16} />
              More actions
            </summary>
            <div className="workflow-roster-overflow-menu">
              {!setupNeeded && item.providerSetupRequired && (
                <button
                  type="button"
                  onClick={onSetupProvider}
                  aria-label={`Edit ${workflow.definition.name} setup`}
                >
                  <Settings size={16} />
                  Edit setup
                </button>
              )}
              {item.pendingApproval && (
                <button
                  type="button"
                  onClick={onOpenRun}
                  aria-label={`Open pending approval for ${workflow.definition.name}`}
                >
                  <ShieldCheck size={16} />
                  Review approval
                </button>
              )}
              {workflow.status === "disabled" ? (
                <button
                  type="button"
                  onClick={onEnable}
                  aria-label={`Enable ${workflow.definition.name}`}
                >
                  <Power size={16} />
                  Enable
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onDisable}
                  aria-label={`Disable ${workflow.definition.name}`}
                >
                  <Pause size={16} />
                  Disable
                </button>
              )}
              <button type="button" disabled aria-label={`Archive unavailable for ${workflow.definition.name}`}>
                <Archive size={16} />
                Archive
              </button>
            </div>
          </details>
        ) : (
          <>
            {item.pendingApproval && (
              <button
                type="button"
                onClick={onOpenRun}
                aria-label={`Open pending approval for ${workflow.definition.name}`}
              >
                <ShieldCheck size={16} />
                Approval
              </button>
            )}
            {workflow.status === "disabled" ? (
              <button
                type="button"
                onClick={onEnable}
                aria-label={`Enable ${workflow.definition.name}`}
              >
                <Power size={16} />
                Enable
              </button>
            ) : (
              <button
                type="button"
                onClick={onDisable}
                aria-label={`Disable ${workflow.definition.name}`}
              >
                <Pause size={16} />
                Disable
              </button>
            )}
            <button type="button" disabled aria-label={`Archive unavailable for ${workflow.definition.name}`}>
              <Archive size={16} />
              Archive
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function WorkflowRosterHealthFooter({
  items,
  selectedItems,
  suggestions,
}: {
  items: WorkflowRosterItem[];
  selectedItems: WorkflowRosterItem[];
  suggestions: WorkflowOptimizationSuggestion[];
}) {
  const averageHealth = items.length
    ? Math.round(items.reduce((total, item) => total + item.healthScore, 0) / items.length)
    : 0;

  return (
    <div className="workflow-roster-footer" aria-label="Workflow health and optimization insights">
      <div className="workflow-health-footer">
        Health: {averageHealth}/100 average
      </div>

      {selectedItems.length >= 2 && (
        <section className="workflow-compare-panel" aria-label="Selected workflow comparison">
          <header>
            <strong>Compare workflows</strong>
            <span>{selectedItems.length} selected</span>
          </header>
          <div className="workflow-compare-grid">
            {selectedItems.map((item) => (
              <article key={item.workflow.workflowId}>
                <strong>{item.workflow.definition.name}</strong>
                <dl>
                  <div>
                    <dt>Health</dt>
                    <dd>{item.healthScore}/100</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{statusLabels[item.status]}</dd>
                  </div>
                  <div>
                    <dt>Schedule</dt>
                    <dd>{formatSchedule(item.workflow.definition.schedule)}</dd>
                  </div>
                  <div>
                    <dt>Cost</dt>
                    <dd>{formatCostLabel(item)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </section>
      )}

      <details className="workflow-suggestions-collapse">
        <summary>
          {suggestions.length === 0
            ? "No optimization suggestions"
            : `${suggestions.length} optimization suggestion${suggestions.length === 1 ? "" : "s"}`}
        </summary>
        {suggestions.length > 0 && (
          <div className="workflow-suggestion-grid">
            {suggestions.map((suggestion) => (
              <article key={suggestion.id}>
                <strong>{suggestion.title}</strong>
                <p>{suggestion.body}</p>
              </article>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}

function RosterMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="workflow-roster-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CompactRosterSection({
  ariaLabel,
  className,
  items,
}: {
  ariaLabel: string;
  className: string;
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <div className={`workflow-roster-section ${className}`} aria-label={ariaLabel}>
      {items.map((entry) => (
        <div key={`${entry.label}:${entry.value}`} className="workflow-roster-section-item">
          <span>{entry.label}</span>
          <strong>{entry.value}</strong>
        </div>
      ))}
    </div>
  );
}

function buildRosterItems(state: AppState, livePendingApproval: ApprovalRequest | null): WorkflowRosterItem[] {
  const scheduleEntries = new Map(
    buildScheduleEntries(state).map((entry) => [entry.workflowId, entry]),
  );
  const usageByWorkflow = new Map(
    buildUsageSummary(state).byWorkflow.map((summary) => [summary.workflowId, summary]),
  );
  const runsByWorkflow = groupRunsByWorkflow(state.runs);
  const artifactsByWorkflow = groupArtifactsByWorkflow(state.artifacts, state.runs);

  return state.workflows.map((workflow) => {
    const latestRun = runsByWorkflow.get(workflow.workflowId)?.[0] ?? null;
    const scheduleEntry = scheduleEntries.get(workflow.workflowId) ?? fallbackScheduleEntry(workflow);
    const usage = usageByWorkflow.get(workflow.workflowId);
    const readiness = deriveProviderReadiness(workflow, state);
    const artifacts = artifactsByWorkflow.get(workflow.workflowId) ?? [];
    const artifactTypes = [...new Set(artifacts.map((artifact) => artifact.type))];
    const destination = workflow.definition.defaults.destinationRef;
    const providerModel = [
      readiness.providerName ?? readiness.providerId ?? readiness.profileId,
      readiness.model,
    ].filter(Boolean).join(" / ");
    const status = deriveWorkflowOperationalStatus(workflow, state);
    const latestRunPendingApproval = isApprovalBlockedRun(latestRun);
    const pendingApproval =
      latestRunPendingApproval || liveApprovalMatchesWorkflow(livePendingApproval, workflow, latestRun);
    const providerSetupRequired =
      readiness.status === "missing" ||
      readiness.status === "needs-setup" ||
      (latestRun?.status === "blocked" && !latestRunPendingApproval);

    const item: Omit<WorkflowRosterItem, "healthScore" | "healthNotes"> = {
      workflow,
      status,
      latestRun,
      scheduleEntry,
      providerModel: providerModel || "Provider unavailable",
      destination,
      artifactCount: artifacts.length,
      artifactTypes,
      costUsd: usage?.totalCostUsd ?? 0,
      reportedCostRunCount: usage?.reportedCostRunCount ?? 0,
      nextRunAt: scheduleEntry.nextRunAt,
      lastRunAt: latestRun?.completedAt ?? latestRun?.startedAt ?? null,
      pendingApproval,
      providerSetupRequired,
      searchText: normalize(
        [
          workflow.definition.name,
          workflow.definition.description,
          readiness.providerName,
          readiness.providerId,
          readiness.profileId,
          readiness.model,
          workflow.definition.defaults.destinationRef,
          ...workflow.definition.steps.flatMap((step) => [
            step.provider,
            step.action,
            step.destinationRef,
            step.llmProfileRef,
            artifactTypeFromStep(step.inputs),
          ]),
          ...artifactTypes,
        ]
          .filter(Boolean)
          .join(" "),
      ),
    };
    const health = deriveWorkflowHealthScore(item);
    return { ...item, ...health };
  });
}

function deriveWorkflowHealthScore(
  item: Omit<WorkflowRosterItem, "healthScore" | "healthNotes">,
): Pick<WorkflowRosterItem, "healthScore" | "healthNotes"> {
  let score = 100;
  const notes: string[] = [];

  if (item.status === "failed-retryable") {
    score -= 35;
    notes.push("Recent run needs retry attention");
  }
  if (item.status === "blocked") {
    score -= 30;
    notes.push("Blocked run is waiting on a dependency");
  }
  if (item.status === "needs-setup" || item.providerSetupRequired) {
    score -= 25;
    notes.push("Provider or destination setup is incomplete");
  }
  if (item.status === "draft") {
    score -= 20;
    notes.push("Draft workflows are not operational yet");
  }
  if (item.status === "paused") {
    score -= 15;
    notes.push("Paused workflows are inactive");
  }
  if (item.pendingApproval) {
    score -= 10;
    notes.push("Approval is pending");
  }
  if (item.costUsd >= HIGH_COST_USD) {
    score -= 10;
    notes.push("Cost is above the high-cost threshold");
  }
  if ((item.workflow.definition.schedule?.cadence ?? "manual") === "manual") {
    score -= 5;
    notes.push("No schedule is configured");
  }

  return { healthScore: Math.max(0, Math.min(100, score)), healthNotes: notes };
}

function buildOptimizationSuggestions(items: WorkflowRosterItem[]): WorkflowOptimizationSuggestion[] {
  const suggestions: WorkflowOptimizationSuggestion[] = [];
  const failed = items.find((item) => item.status === "failed-retryable");
  if (failed) {
    suggestions.push({
      id: `failed:${failed.workflow.workflowId}`,
      title: `Review ${failed.workflow.definition.name} failure handling`,
      body: "The latest run is retryable. Check provider readiness and retry policy before the next scheduled run.",
    });
  }

  const needsSetup = items.find((item) => item.status === "needs-setup");
  if (needsSetup) {
    suggestions.push({
      id: `setup:${needsSetup.workflow.workflowId}`,
      title: `Configure ${needsSetup.workflow.definition.name} dependencies`,
      body: "A provider or destination is not ready, so this workflow may block when it runs.",
    });
  }

  const draft = items.find((item) => item.status === "draft");
  if (draft) {
    suggestions.push({
      id: `draft:${draft.workflow.workflowId}`,
      title: `Finish ${draft.workflow.definition.name} setup`,
      body: "Draft workflows can be enabled after schedule, approval, and destination choices are reviewed.",
    });
  }

  const highCost = [...items].sort((a, b) => b.costUsd - a.costUsd).find((item) => item.costUsd >= HIGH_COST_USD);
  if (highCost) {
    suggestions.push({
      id: `cost:${highCost.workflow.workflowId}`,
      title: `Tune ${highCost.workflow.definition.name} cost`,
      body: "This workflow is above the roster high-cost threshold. Consider a cheaper model or less frequent schedule.",
    });
  }

  const unscheduled = items.find(
    (item) => item.workflow.status === "enabled" && (item.workflow.definition.schedule?.cadence ?? "manual") === "manual",
  );
  if (unscheduled) {
    suggestions.push({
      id: `schedule:${unscheduled.workflow.workflowId}`,
      title: `Schedule ${unscheduled.workflow.definition.name}`,
      body: "This enabled workflow only runs manually. Add a cadence if it should operate on its own.",
    });
  }

  return suggestions.slice(0, 4);
}

function isApprovalBlockedRun(run: WorkflowRun | null): boolean {
  return (
    run?.status === "blocked" &&
    (run.requiredProviderId === "approval" ||
      run.requiredProfileId?.startsWith("approval") ||
      run.blockedReason?.toLowerCase().includes("approval") === true)
  );
}

function liveApprovalMatchesWorkflow(
  approval: ApprovalRequest | null,
  workflow: WorkflowVersion,
  latestRun: WorkflowRun | null,
): boolean {
  if (!approval || approval.status !== "pending") return false;
  const approvalWorkflowName = normalize(approval.workflowName);
  const workflowName = normalize(workflow.definition.name);
  const workflowId = normalize(workflow.workflowId);
  const approvalRunId = normalize(approval.runId);
  return (
    approvalWorkflowName === workflowName ||
    approvalWorkflowName === workflowId ||
    approvalRunId === normalize(latestRun?.id ?? "") ||
    approvalRunId.includes(workflowId) ||
    approvalRunId.includes(workflowName.replace(/\s+/g, " "))
  );
}

function groupRunsByWorkflow(runs: WorkflowRun[]): Map<string, WorkflowRun[]> {
  const grouped = new Map<string, WorkflowRun[]>();
  for (const run of runs) {
    grouped.set(run.workflowId, [...(grouped.get(run.workflowId) ?? []), run]);
  }
  for (const [workflowId, workflowRuns] of grouped) {
    grouped.set(
      workflowId,
      workflowRuns.sort((a, b) => runTime(b) - runTime(a)),
    );
  }
  return grouped;
}

function groupArtifactsByWorkflow(artifacts: Artifact[], runs: WorkflowRun[]): Map<string, Artifact[]> {
  const runWorkflowIds = new Map(runs.map((run) => [run.id, run.workflowId]));
  const grouped = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    const workflowId =
      runWorkflowIds.get(artifact.workflowRunId) ??
      stringMetadata(artifact.metadata.workflowId) ??
      stringMetadata(artifact.metadata.workflow_id);
    if (!workflowId) continue;
    grouped.set(workflowId, [...(grouped.get(workflowId) ?? []), artifact]);
  }
  return grouped;
}

function fallbackScheduleEntry(workflow: WorkflowVersion): CommandCenterScheduleEntry {
  return {
    workflowId: workflow.workflowId,
    workflowName: workflow.definition.name,
    bucket: workflow.definition.schedule?.cadence === "manual" ? "manual" : "unknown",
    status: workflow.status === "disabled" ? "paused" : workflow.status,
    scheduleLabel: formatSchedule(workflow.definition.schedule),
    cadence: workflow.definition.schedule?.cadence ?? "unknown",
    nextRunAt: null,
    displayRunAt: null,
    occurrenceKey: null,
    lastRunId: null,
    lastRunStatus: null,
    reason: null,
  };
}

function matchesSearch(item: WorkflowRosterItem, query: string): boolean {
  return !query || item.searchText.includes(query);
}

function matchesStatus(item: WorkflowRosterItem, statuses: WorkflowOperationalStatus[]): boolean {
  return statuses.length === 0 || statuses.includes(item.status);
}

function matchesSchedule(item: WorkflowRosterItem, filters: WorkflowScheduleFilter[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => {
    if (filter === "manual") return item.scheduleEntry.cadence === "manual";
    if (filter === "scheduled") {
      return item.scheduleEntry.cadence !== "manual" && item.scheduleEntry.cadence !== "unknown";
    }
    if (filter === "overdue") return item.scheduleEntry.bucket === "missed";
    return isDueSoon(item.nextRunAt);
  });
}

function matchesApproval(item: WorkflowRosterItem, filters: WorkflowApprovalFilter[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => {
    if (filter === "auto") return item.workflow.approvalMode === "auto_approve";
    if (filter === "review-changes") return item.workflow.approvalMode === "review_changes";
    if (filter === "always-review") return item.workflow.approvalMode === "always_review";
    return item.pendingApproval;
  });
}

function matchesCost(item: WorkflowRosterItem, filters: WorkflowCostFilter[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => {
    if (filter === "has-cost") return item.reportedCostRunCount > 0;
    if (filter === "high-cost") return item.costUsd >= HIGH_COST_USD;
    return item.reportedCostRunCount === 0;
  });
}

function compareRosterItems(a: WorkflowRosterItem, b: WorkflowRosterItem, sortKey: WorkflowRosterSortKey): number {
  if (sortKey === "name") return compareNames(a, b);
  if (sortKey === "cost") return b.costUsd - a.costUsd || compareNames(a, b);
  if (sortKey === "last-run") return compareNullableTimeDesc(a.lastRunAt, b.lastRunAt) || compareNames(a, b);
  if (sortKey === "next-run") return compareNullableTimeAsc(a.nextRunAt, b.nextRunAt) || compareNames(a, b);
  if (sortKey === "created-updated") {
    return compareNullableTimeDesc(a.workflow.createdAt, b.workflow.createdAt) || compareNames(a, b);
  }
  return statusSeverity(b) - statusSeverity(a) || compareNames(a, b);
}

function statusSeverity(item: WorkflowRosterItem): number {
  if (item.status === "failed-retryable") return 100;
  if (item.scheduleEntry.bucket === "missed") return 95;
  if (item.status === "blocked") return 90;
  if (item.pendingApproval) return 85;
  if (item.status === "needs-setup") return 70;
  if (item.status === "draft") return 30;
  if (item.status === "paused") return 20;
  return 0;
}

function compareNames(a: WorkflowRosterItem, b: WorkflowRosterItem): number {
  return a.workflow.definition.name.localeCompare(b.workflow.definition.name);
}

function compareNullableTimeAsc(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return new Date(a).getTime() - new Date(b).getTime();
}

function compareNullableTimeDesc(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return new Date(b).getTime() - new Date(a).getTime();
}

function runTime(run: WorkflowRun): number {
  return new Date(run.completedAt ?? run.startedAt).getTime();
}

function runLabel(run: WorkflowRun): string {
  return `${runStatusLabel(run.status)} ${formatRelativeTime(run.startedAt)}`;
}

function runStatusLabel(status: RunState): string {
  return status.replace(/-/g, " ");
}

function isDueSoon(iso: string | null): boolean {
  if (!iso) return false;
  const diff = new Date(iso).getTime() - Date.now();
  return diff >= 0 && diff <= 24 * 60 * 60 * 1000;
}

function artifactTypeFromStep(inputs: Record<string, unknown>): string | undefined {
  const template = inputs.template;
  const outputSchema = inputs.output_schema ?? inputs.outputSchema;
  if (typeof template === "string") return template;
  if (typeof outputSchema === "string") return outputSchema;
  return undefined;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
}

function slugForSavedView(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `view-${Date.now()}`;
}

function destinationLabel(destination: string): string {
  return destination.replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCompactDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatCostLabel(item: WorkflowRosterItem): string {
  if (item.reportedCostRunCount === 0) return "No reported cost";
  if (item.costUsd > 0 && item.costUsd < 0.01) return `$${item.costUsd.toFixed(4)}`;
  return `$${item.costUsd.toFixed(2)}`;
}

function readRosterState(): WorkflowRosterState {
  try {
    const raw = localStorage.getItem(ROSTER_STORAGE_KEY);
    if (!raw) return defaultRosterState;
    return sanitizeRosterState(JSON.parse(raw));
  } catch {
    return defaultRosterState;
  }
}

function readCustomSavedViews(): WorkflowSavedView[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROSTER_SAVED_VIEWS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Partial<WorkflowSavedView>;
      if (typeof record.id !== "string" || typeof record.name !== "string" || !record.state) return [];
      return [{
        id: record.id,
        name: record.name,
        state: sanitizeRosterState(record.state),
      }];
    }).slice(0, 12);
  } catch {
    return [];
  }
}

function sanitizeRosterState(value: unknown): WorkflowRosterState {
  if (!value || typeof value !== "object") return defaultRosterState;
  const record = value as Partial<WorkflowRosterState>;
  return {
    query: typeof record.query === "string" ? record.query : "",
    statuses: arrayOf(record.statuses, isWorkflowOperationalStatus),
    schedules: arrayOf(record.schedules, isWorkflowScheduleFilter),
    approvals: arrayOf(record.approvals, isWorkflowApprovalFilter),
    costs: arrayOf(record.costs, isWorkflowCostFilter),
    sortKey: isWorkflowRosterSortKey(record.sortKey) ? record.sortKey : defaultRosterState.sortKey,
    density: isWorkflowRosterDensity(record.density) ? record.density : defaultRosterState.density,
  };
}

function arrayOf<T extends string>(value: unknown, guard: (item: unknown) => item is T): T[] {
  return Array.isArray(value) ? value.filter(guard) : [];
}

function isWorkflowOperationalStatus(value: unknown): value is WorkflowOperationalStatus {
  return (
    value === "enabled" ||
    value === "draft" ||
    value === "paused" ||
    value === "blocked" ||
    value === "failed-retryable" ||
    value === "needs-setup"
  );
}

function isWorkflowScheduleFilter(value: unknown): value is WorkflowScheduleFilter {
  return value === "manual" || value === "scheduled" || value === "due-soon" || value === "overdue";
}

function isWorkflowApprovalFilter(value: unknown): value is WorkflowApprovalFilter {
  return value === "auto" || value === "review-changes" || value === "always-review" || value === "pending-approval";
}

function isWorkflowCostFilter(value: unknown): value is WorkflowCostFilter {
  return value === "has-cost" || value === "high-cost" || value === "no-reported-cost";
}

function isWorkflowRosterSortKey(value: unknown): value is WorkflowRosterSortKey {
  return (
    value === "next-run" ||
    value === "last-run" ||
    value === "status-severity" ||
    value === "name" ||
    value === "cost" ||
    value === "created-updated"
  );
}

function isWorkflowRosterDensity(value: unknown): value is WorkflowRosterDensity {
  return value === "compact" || value === "comfortable";
}

function buildActiveChips(
  state: WorkflowRosterState,
  setRosterState: (updater: (current: WorkflowRosterState) => WorkflowRosterState) => void,
): WorkflowRosterChip[] {
  const chips: WorkflowRosterChip[] = [];
  if (state.query.trim()) {
    chips.push({
      id: "query",
      label: `Search: ${state.query.trim()}`,
      onRemove: () => setRosterState((current) => ({ ...current, query: "" })),
    });
  }

  state.statuses.forEach((status) => {
    chips.push({
      id: `status:${status}`,
      label: statusLabels[status],
      onRemove: () =>
        setRosterState((current) => ({
          ...current,
          statuses: current.statuses.filter((item) => item !== status),
        })),
    });
  });
  state.schedules.forEach((schedule) => {
    chips.push({
      id: `schedule:${schedule}`,
      label: scheduleFilterLabels[schedule],
      onRemove: () =>
        setRosterState((current) => ({
          ...current,
          schedules: current.schedules.filter((item) => item !== schedule),
        })),
    });
  });
  state.approvals.forEach((approval) => {
    chips.push({
      id: `approval:${approval}`,
      label: approvalFilterLabels[approval],
      onRemove: () =>
        setRosterState((current) => ({
          ...current,
          approvals: current.approvals.filter((item) => item !== approval),
        })),
    });
  });
  state.costs.forEach((cost) => {
    chips.push({
      id: `cost:${cost}`,
      label: costFilterLabels[cost],
      onRemove: () =>
        setRosterState((current) => ({
          ...current,
          costs: current.costs.filter((item) => item !== cost),
        })),
    });
  });

  return chips;
}
