import { useEffect, useMemo, useState } from "react";
import { Archive, Copy, ExternalLink, FileDown, History, RefreshCcw, SlidersHorizontal, Workflow } from "lucide-react";
import { useAppState } from "../contexts/AppStateContext";
import { useUI } from "../contexts/UIContext";
import { MarkdownPreview } from "../components/MarkdownPreview";
import type { Artifact, WorkflowRun, WorkflowVersion } from "../../domain/types";

type RecencyFilter = "all" | "7d" | "30d";

const artifactTypeLabels: Record<Artifact["type"], string> = {
  daily_work_journal: "Daily work journal",
  morning_brief: "Morning brief",
  weather_report: "Weather report",
  plugin_artifact: "Plugin artifact",
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ");
}

function metadataString(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function findArtifactRun(artifact: Artifact | undefined, runs: WorkflowRun[]): WorkflowRun | null {
  if (!artifact) return null;
  return runs.find((run) => run.id === artifact.workflowRunId) ?? null;
}

function findArtifactWorkflow(
  artifact: Artifact | undefined,
  run: WorkflowRun | null,
  workflows: WorkflowVersion[],
): WorkflowVersion | null {
  if (!artifact) return null;
  const workflowId = run?.workflowId ?? metadataString(artifact.metadata, ["workflowId", "workflow_id"]);
  if (!workflowId) return null;
  return workflows.find((workflow) => workflow.workflowId === workflowId) ?? null;
}

function artifactDestination(artifact: Artifact, workflow: WorkflowVersion | null): string {
  return (
    metadataString(artifact.metadata, [
      "destinationRef",
      "destination_ref",
      "destination",
      "exportedPath",
      "exported_path",
    ]) ??
    workflow?.definition.steps.find((step) => step.destinationRef)?.destinationRef ??
    workflow?.definition.defaults.destinationRef ??
    "Destination unresolved"
  );
}

function formatCost(value: number): string {
  if (value === 0) return "$0.0000";
  return `$${value.toFixed(4)}`;
}

export function ArtifactsView() {
  const { state, artifactNotice, actions } = useAppState();
  const {
    selectedArtifactId,
    setAssistantOpen,
    setSelectedArtifactId,
    setView,
    openWorkflow,
    openWorkflowRun,
  } = useUI();

  const { artifacts, runs, workflows } = state;
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | Artifact["type"]>("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [recencyFilter, setRecencyFilter] = useState<RecencyFilter>("all");

  const sortedArtifacts = useMemo(
    () => [...artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [artifacts],
  );

  const availableTypes = useMemo(
    () => Array.from(new Set(sortedArtifacts.map((artifact) => artifact.type))),
    [sortedArtifacts],
  );

  const filteredArtifacts = useMemo(() => {
    const trimmedQuery = normalize(query.trim());
    const nowMs = Date.now();
    const recencyMs =
      recencyFilter === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : recencyFilter === "30d"
          ? 30 * 24 * 60 * 60 * 1000
          : null;

    return sortedArtifacts.filter((artifact) => {
      const run = findArtifactRun(artifact, runs);
      const workflow = findArtifactWorkflow(artifact, run, workflows);
      const sourceText = [
        artifact.title,
        artifact.type,
        artifact.contentMarkdown,
        ...artifact.sourceRefs,
        run?.workflowName,
        workflow?.definition.name,
      ]
        .filter(Boolean)
        .join(" ");

      if (trimmedQuery && !normalize(sourceText).includes(trimmedQuery)) return false;
      if (typeFilter !== "all" && artifact.type !== typeFilter) return false;
      if (workflowFilter !== "all" && workflow?.workflowId !== workflowFilter) return false;
      if (recencyMs != null) {
        const createdMs = new Date(artifact.createdAt).getTime();
        if (!Number.isFinite(createdMs) || nowMs - createdMs > recencyMs) return false;
      }
      return true;
    });
  }, [query, recencyFilter, runs, sortedArtifacts, typeFilter, workflowFilter, workflows]);

  const selectedArtifact = useMemo(
    () =>
      filteredArtifacts.find((artifact) => artifact.id === selectedArtifactId) ??
      filteredArtifacts[0] ??
      sortedArtifacts.find((artifact) => artifact.id === selectedArtifactId) ??
      null,
    [filteredArtifacts, selectedArtifactId, sortedArtifacts],
  );

  useEffect(() => {
    if (selectedArtifact && selectedArtifact.id !== selectedArtifactId) {
      setSelectedArtifactId(selectedArtifact.id);
    }
  }, [selectedArtifact, selectedArtifactId, setSelectedArtifactId]);

  const selectedRun = useMemo(
    () => findArtifactRun(selectedArtifact ?? undefined, runs),
    [runs, selectedArtifact],
  );

  const selectedWorkflow = useMemo(
    () => findArtifactWorkflow(selectedArtifact ?? undefined, selectedRun, workflows),
    [selectedArtifact, selectedRun, workflows],
  );

  const selectedDestination = selectedArtifact
    ? artifactDestination(selectedArtifact, selectedWorkflow)
    : "";

  const selectedModelProvider = useMemo(() => {
    const profileId = selectedRun?.providerProfileId ?? selectedWorkflow?.definition.defaults.llmProfileRef;
    if (!profileId) return "Model unavailable";
    const authProfile = state.agentAuthProfiles.find((profile) => profile.id === profileId);
    if (authProfile) return `${authProfile.displayName} / ${authProfile.model}`;
    const llmProfile = state.llmProfiles.find((profile) => profile.id === profileId);
    if (llmProfile) return `${llmProfile.providerId} / ${llmProfile.model}`;
    return profileId;
  }, [selectedRun, selectedWorkflow, state.agentAuthProfiles, state.llmProfiles]);

  const selectedCost = selectedRun?.totalCostUsd != null
    ? formatCost(selectedRun.totalCostUsd)
    : "Cost unavailable";

  const selectedArtifactHistory = useMemo(() => {
    if (!selectedArtifact) return [];
    const selectedWorkflowId =
      selectedWorkflow?.workflowId ?? metadataString(selectedArtifact.metadata, ["workflowId", "workflow_id"]);
    return sortedArtifacts.filter((artifact) => {
      if (artifact.id === selectedArtifact.id) return false;
      if (artifact.type !== selectedArtifact.type) return false;
      const run = findArtifactRun(artifact, runs);
      const workflow = findArtifactWorkflow(artifact, run, workflows);
      const workflowId = workflow?.workflowId ?? metadataString(artifact.metadata, ["workflowId", "workflow_id"]);
      return selectedWorkflowId ? workflowId === selectedWorkflowId : artifact.workflowRunId === selectedArtifact.workflowRunId;
    });
  }, [runs, selectedArtifact, selectedWorkflow, sortedArtifacts, workflows]);

  const compareArtifact = selectedArtifactHistory[0] ?? null;
  const compareDelta = selectedArtifact && compareArtifact
    ? selectedArtifact.contentMarkdown.length - compareArtifact.contentMarkdown.length
    : null;

  const openSourceWorkflow = () => {
    if (selectedWorkflow) openWorkflow(selectedWorkflow.workflowId, "artifacts");
  };

  const tuneSourceWorkflow = () => {
    if (!selectedWorkflow) return;
    openWorkflow(selectedWorkflow.workflowId, "artifacts");
    setAssistantOpen(true);
  };

  const viewSourceRun = () => {
    if (!selectedWorkflow || !selectedRun) return;
    openWorkflowRun(selectedWorkflow.workflowId, selectedRun.id, "artifacts");
  };

  return (
    <section className="artifact-layout">
      <div className="artifact-sidebar">
        <div className="artifact-sidebar-header">
          <div>
            <p className="eyebrow">Generated results</p>
            <h1>Artifacts</h1>
          </div>
          <span className="artifact-count">{filteredArtifacts.length}</span>
        </div>
        <div className="artifact-filters" aria-label="Artifact filters">
          <label>
            Search
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Title, source, content"
            />
          </label>
          <div className="artifact-filter-grid">
            <label>
              Type
              <select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.currentTarget.value as typeof typeFilter)}
              >
                <option value="all">All types</option>
                {availableTypes.map((type) => (
                  <option key={type} value={type}>
                    {artifactTypeLabels[type] ?? normalize(type)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Recency
              <select
                value={recencyFilter}
                onChange={(event) => setRecencyFilter(event.currentTarget.value as RecencyFilter)}
              >
                <option value="all">All time</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </select>
            </label>
          </div>
          <label>
            Workflow
            <select
              value={workflowFilter}
              onChange={(event) => setWorkflowFilter(event.currentTarget.value)}
            >
              <option value="all">All workflows</option>
              {workflows.map((workflow) => (
                <option key={workflow.workflowId} value={workflow.workflowId}>
                  {workflow.definition.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="artifact-list">
          {artifacts.length === 0 && (
            <div className="artifact-empty-state">
              <Archive size={28} aria-hidden="true" />
              <strong>No artifacts yet</strong>
              <p>Artifacts are generated when workflows run. Run a workflow to create your first result.</p>
              <button type="button" className="primary-action" onClick={() => setView("workflows")}>
                Run a workflow
              </button>
            </div>
          )}
          {artifacts.length > 0 && filteredArtifacts.length === 0 && (
            <p className="empty-state">No artifacts match the current filters.</p>
          )}
          {filteredArtifacts.map((artifact) => {
            const run = findArtifactRun(artifact, runs);
            const workflow = findArtifactWorkflow(artifact, run, workflows);
            return (
            <button
              key={artifact.id}
              type="button"
              aria-current={artifact.id === selectedArtifact?.id ? "true" : undefined}
              onClick={() => setSelectedArtifactId(artifact.id)}
            >
              <strong>{artifact.title}</strong>
              <small>{workflow?.definition.name ?? run?.workflowName ?? "Workflow unresolved"}</small>
              <span>{artifactTypeLabels[artifact.type] ?? normalize(artifact.type)}</span>
              <small>{new Date(artifact.createdAt).toLocaleString()}</small>
            </button>
            );
          })}
        </div>
      </div>

      {selectedArtifact && (
        <article className="artifact-viewer">
          <header>
            <p className="eyebrow">{artifactTypeLabels[selectedArtifact.type] ?? normalize(selectedArtifact.type)}</p>
            <h1>{selectedArtifact.title}</h1>
            <p>
              {selectedWorkflow ? (
                <button
                  type="button"
                  className="inline-link-button"
                  onClick={openSourceWorkflow}
                >
                  Source workflow: {selectedWorkflow.definition.name}
                </button>
              ) : (
                "Source workflow unresolved"
              )}
            </p>
          </header>

          <div className="viewer-actions">
            <button
              type="button"
              aria-label="Copy artifact"
              onClick={() => actions.copyArtifact(selectedArtifact)}
            >
              <Copy size={16} />
              Copy
            </button>
            <button
              type="button"
              aria-label="Export artifact"
              onClick={() => actions.exportArtifact(selectedArtifact)}
            >
              <FileDown size={16} />
              Export
            </button>
            <button
              type="button"
              aria-label="Regenerate artifact"
              onClick={() => actions.regenerateArtifact(selectedArtifact)}
            >
              <RefreshCcw size={16} />
              Regenerate
            </button>
            <button
              type="button"
              aria-label="Tune source workflow"
              onClick={tuneSourceWorkflow}
              disabled={!selectedWorkflow}
            >
              <SlidersHorizontal size={16} />
              Tune workflow
            </button>
            <button
              type="button"
              aria-label="Open source workflow"
              onClick={openSourceWorkflow}
              disabled={!selectedWorkflow}
            >
              <Workflow size={16} />
              Open workflow
            </button>
            <button
              type="button"
              aria-label="View source run"
              onClick={viewSourceRun}
              disabled={!selectedRun || !selectedWorkflow}
            >
              <History size={16} />
              View run
            </button>
          </div>
          {artifactNotice && <span className="success-note">{artifactNotice}</span>}

          <section className="artifact-lineage" aria-label="Artifact lineage">
            <div className="lineage-node">
              <span>Workflow</span>
              {selectedWorkflow ? (
                <button type="button" onClick={openSourceWorkflow}>
                  {selectedWorkflow.definition.name}
                  <ExternalLink size={14} aria-hidden="true" />
                </button>
              ) : (
                <strong>Unresolved</strong>
              )}
            </div>
            <div className="lineage-node">
              <span>Run</span>
              <strong>{selectedRun?.id ?? selectedArtifact.workflowRunId}</strong>
              {selectedRun && <small>{selectedRun.status}</small>}
            </div>
            <div className="lineage-node">
              <span>Context sources</span>
              <strong>{selectedArtifact.sourceRefs.length} source{selectedArtifact.sourceRefs.length === 1 ? "" : "s"}</strong>
              <small>{selectedArtifact.sourceRefs.slice(0, 2).join(", ") || "No source refs"}</small>
            </div>
            <div className="lineage-node">
              <span>Model/provider</span>
              <strong>{selectedModelProvider}</strong>
              <small>{selectedRun?.totalTokens != null ? `${selectedRun.totalTokens.toLocaleString()} tokens` : "Tokens unavailable"}</small>
            </div>
            <div className="lineage-node">
              <span>Cost</span>
              <strong>{selectedCost}</strong>
              <small>{selectedRun?.totalCostUsd != null ? "Reported by run" : "Not reported"}</small>
            </div>
            <div className="lineage-node active">
              <span>Artifact</span>
              <strong>{selectedArtifact.title}</strong>
              <small>{new Date(selectedArtifact.createdAt).toLocaleString()}</small>
            </div>
            <div className="lineage-node">
              <span>Destination</span>
              <strong>{selectedDestination}</strong>
            </div>
          </section>

          <section className="artifact-history-panel" aria-label="Artifact compare and regeneration history">
            <div className="section-heading">
              <h2>Compare and regeneration history</h2>
              <span>{selectedArtifactHistory.length} related artifact{selectedArtifactHistory.length === 1 ? "" : "s"}</span>
            </div>
            {compareArtifact ? (
              <div className="artifact-compare-grid">
                <article>
                  <span>Current</span>
                  <strong>{selectedArtifact.title}</strong>
                  <small>{selectedArtifact.contentMarkdown.length.toLocaleString()} characters</small>
                </article>
                <article>
                  <span>Previous</span>
                  <strong>{compareArtifact.title}</strong>
                  <small>{new Date(compareArtifact.createdAt).toLocaleString()}</small>
                </article>
                <article>
                  <span>Content delta</span>
                  <strong>{compareDelta != null && compareDelta >= 0 ? "+" : ""}{compareDelta?.toLocaleString() ?? "Unavailable"}</strong>
                  <small>Line-level artifact diff requires persisted regeneration metadata.</small>
                </article>
              </div>
            ) : (
              <p className="empty-state">No prior artifact is available for comparison. Regeneration history will appear after another artifact of this type is created.</p>
            )}
            {selectedArtifactHistory.length > 0 && (
              <ol className="artifact-history-list">
                {selectedArtifactHistory.slice(0, 4).map((artifact) => (
                  <li key={artifact.id}>
                    <button type="button" onClick={() => setSelectedArtifactId(artifact.id)}>
                      {artifact.title}
                    </button>
                    <span>{new Date(artifact.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <MarkdownPreview markdown={selectedArtifact.contentMarkdown} />

          <details className="provenance">
            <summary>Provenance</summary>
            <dl>
              <dt>Workflow</dt>
              <dd>{selectedWorkflow?.definition.name ?? "Unresolved"}</dd>
              <dt>Workflow ID</dt>
              <dd>{selectedWorkflow?.workflowId ?? "Unresolved"}</dd>
              <dt>Workflow run</dt>
              <dd>{selectedArtifact.workflowRunId}</dd>
              <dt>Destination</dt>
              <dd>{selectedDestination}</dd>
            </dl>
            <h3>Source refs</h3>
            <ul>
              {selectedArtifact.sourceRefs.map((ref) => (
                <li key={ref}>{ref}</li>
              ))}
            </ul>
          </details>
        </article>
      )}
    </section>
  );
}
