import { useState } from "react";
import type {
  ApprovalGrant,
  AutonomyMode,
  CapabilityAvailability,
  CapabilityDescriptor,
  RawToolInventoryItem,
} from "../../domain/types";
import { ApprovalGrantList } from "./ApprovalGrantList";

type ActionNotice = {
  message: string;
  tone: "success" | "error";
};

interface ToolsAutonomyPanelProps {
  autonomyMode: AutonomyMode;
  categoryOverrides?: Record<string, AutonomyMode>;
  capabilities: CapabilityDescriptor[];
  rawTools?: RawToolInventoryItem[];
  grants: ApprovalGrant[];
  onModeChange: (mode: AutonomyMode) => unknown;
  onCategoryOverrideChange?: (category: string, mode: AutonomyMode | "inherit") => unknown;
  onRefreshTools: () => unknown;
  onRevokeGrant: (id: string) => unknown;
}

const modeLabels: Record<AutonomyMode, string> = {
  ask_first: "Ask First",
  safe_auto: "Safe Auto",
  workspace_auto: "Workspace Auto",
  power_auto: "Power Auto",
};

const modeDescriptions: Record<AutonomyMode, string> = {
  ask_first: "Review newly detected capabilities before use.",
  safe_auto: "Auto-allow trusted read-only and idempotent deterministic tools.",
  workspace_auto: "Allow safe workspace reads, artifact writes, and test or lint commands.",
  power_auto: "Expose broader trusted tool access while keeping high-risk grants explicit.",
};

const categoryLabels: Record<string, string> = {
  agent: "Agent",
  artifact: "Artifacts",
  document_import: "Document import",
  generation: "Generation",
  local_context: "Local context",
  source_control: "Source control",
  workspace_automation: "Workspace automation",
  web_content: "Web content",
  web_monitoring: "Web monitoring",
};

const categoryOverrideOptions: Array<{ value: AutonomyMode | "inherit"; label: string }> = [
  { value: "inherit", label: "Use global mode" },
  { value: "ask_first", label: "Always ask" },
  { value: "safe_auto", label: "Safe auto" },
  { value: "workspace_auto", label: "Workspace auto" },
  { value: "power_auto", label: "Power auto" },
];

function statusLabel(status: CapabilityAvailability): string {
  switch (status) {
    case "available":
      return "Available";
    case "needs_auth":
      return "Needs auth";
    case "degraded":
      return "Degraded";
    case "unavailable":
      return "Blocked";
  }
}

function blockedCount(capabilities: CapabilityDescriptor[]): number {
  return capabilities.filter((capability) =>
    capability.status === "unavailable" || capability.defaultApproval === "blocked"
  ).length;
}

function groupCapabilities(capabilities: CapabilityDescriptor[]): Array<[string, CapabilityDescriptor[]]> {
  const groups = capabilities.reduce<Map<string, CapabilityDescriptor[]>>((acc, capability) => {
    const category = capability.category || "Other";
    acc.set(category, [...(acc.get(category) ?? []), capability]);
    return acc;
  }, new Map());

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function categoryLabel(category: string): string {
  return categoryLabels[category] ?? category.replace(/[_-]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function policyReasonLabel(capability: CapabilityDescriptor): string {
  switch (capability.policy?.decision) {
    case "auto":
      return "Why allowed";
    case "needs_grant":
      return "Why review is required";
    case "blocked":
      return "Why blocked";
    case "hidden":
      return "Why hidden";
    default:
      return "Policy reason";
  }
}

async function actionMessage(result: unknown): Promise<string> {
  const resolved = await result;
  return typeof resolved === "string" && resolved.trim() ? resolved : "";
}

function noticeTone(message: string): ActionNotice["tone"] {
  const lower = message.toLowerCase();
  return lower.includes("failed") ||
    lower.includes("failure") ||
    lower.includes("unavailable") ||
    lower.includes("error")
    ? "error"
    : "success";
}

export function ToolsAutonomyPanel({
  autonomyMode,
  categoryOverrides = {},
  capabilities,
  rawTools = [],
  grants,
  onModeChange,
  onCategoryOverrideChange,
  onRefreshTools,
  onRevokeGrant,
}: ToolsAutonomyPanelProps) {
  const available = capabilities.filter((capability) => capability.status === "available").length;
  const needsAuth = capabilities.filter((capability) => capability.status === "needs_auth").length;
  const blocked = blockedCount(capabilities);
  const groupedCapabilities = groupCapabilities(capabilities);
  const categoryNames = groupedCapabilities.map(([category]) => category);
  const reviewCapabilities = capabilities.filter((capability) =>
    capability.source !== "builtin" &&
    (capability.defaultApproval !== "auto" || capability.status !== "available")
  );
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [busyAction, setBusyAction] = useState<"mode" | "refresh" | "revoke" | "category" | null>(null);

  async function runAction(action: "mode" | "refresh" | "revoke" | "category", callback: () => unknown) {
    setBusyAction(action);
    setActionNotice(null);
    try {
      const message = await actionMessage(callback());
      if (message) setActionNotice({ message, tone: noticeTone(message) });
    } catch {
      setActionNotice({ message: "Action failed", tone: "error" });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section className="settings-card tools-autonomy-panel" role="region" aria-label="Tools and autonomy settings">
      <div className="settings-card-header tools-autonomy-header">
        <div>
          <h2>Tools and autonomy</h2>
          <p className="settings-card-detail">Current policy: {modeLabels[autonomyMode]}</p>
        </div>
        <button
          type="button"
          onClick={() => void runAction("refresh", onRefreshTools)}
          aria-label="Refresh tools"
          disabled={busyAction === "refresh"}
        >
          {busyAction === "refresh" ? "Refreshing..." : "Refresh tools"}
        </button>
      </div>
      {actionNotice && (
        <span className={actionNotice.tone === "error" ? "error-note" : "success-note"}>
          {actionNotice.message}
        </span>
      )}

      <div className="tools-autonomy-controls">
        <label>
          <span>Autonomy mode</span>
          <select
            aria-label="Autonomy mode"
            value={autonomyMode}
            disabled={busyAction === "mode"}
            onChange={(event) =>
              void runAction("mode", () => onModeChange(event.currentTarget.value as AutonomyMode))
            }
          >
            {Object.entries(modeLabels).map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p>{modeDescriptions[autonomyMode]}</p>
      </div>

      <div className="tools-autonomy-summary" aria-label="Capability status counts">
        <span className="readiness-pill readiness-pill-available">Available {available}</span>
        <span className="readiness-pill readiness-pill-needs_config">Needs auth {needsAuth}</span>
        <span className="readiness-pill readiness-pill-unavailable">Blocked {blocked}</span>
      </div>

      <section className="tools-capability-group" role="region" aria-label="Detected tool inventory">
        <div className="tools-capability-group-header">
          <h3>Detected tool inventory</h3>
          <span className="settings-card-detail">{rawTools.length} detected</span>
        </div>
        {rawTools.length === 0 ? (
          <p className="empty-state">No raw tools detected yet.</p>
        ) : (
          <div className="tools-capability-list">
            {rawTools.map((tool) => (
              <article key={tool.id} className="tools-capability-row">
                <span className="profile-row-main">
                  <span className="profile-row-title">
                    {tool.displayName}
                    <span>{tool.source}</span>
                    {tool.version && <span>{tool.version}</span>}
                  </span>
                  <span className="profile-row-summary">
                    {tool.binaryPath ?? tool.id}
                    {tool.detectionErrors.length > 0 ? ` · ${tool.detectionErrors.join("; ")}` : ""}
                  </span>
                </span>
                <span className={`readiness-pill readiness-pill-${tool.status}`}>
                  {statusLabel(tool.status as CapabilityAvailability)}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="tools-capability-group" role="region" aria-label="Review new tools">
        <div className="tools-capability-group-header">
          <h3>Review new tools</h3>
          <span className="settings-card-detail">{reviewCapabilities.length} pending review</span>
        </div>
        {reviewCapabilities.length === 0 ? (
          <p className="empty-state">No newly detected tools need review.</p>
        ) : (
          <div className="tools-capability-list">
            {reviewCapabilities.map((capability) => (
              <article key={capability.id} className="tools-capability-row">
                <span className="profile-row-main">
                  <span className="profile-row-title">
                    {capability.displayName}
                    <span>{categoryLabel(capability.category)}</span>
                  </span>
                  <span className="profile-row-summary">{capability.fallbackStrategy}</span>
                </span>
                <span className={`readiness-pill readiness-pill-${capability.status}`}>
                  {statusLabel(capability.status)}
                </span>
                <span className="tools-review-actions" aria-label={`${capability.displayName} review actions`}>
                  <button
                    type="button"
                    onClick={() =>
                      void runAction("category", () =>
                        onCategoryOverrideChange?.(capability.category, "safe_auto"),
                      )
                    }
                    disabled={!onCategoryOverrideChange || busyAction === "category"}
                    aria-label={`Approve ${categoryLabel(capability.category)} category for ${capability.displayName}`}
                  >
                    Approve category
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void runAction("category", () =>
                        onCategoryOverrideChange?.(capability.category, "ask_first"),
                      )
                    }
                    disabled={!onCategoryOverrideChange || busyAction === "category"}
                    aria-label={`Restrict ${categoryLabel(capability.category)} category for ${capability.displayName}`}
                  >
                    Restrict category
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setActionNotice({
                        message: `Review ${categoryLabel(capability.category)} category policy below.`,
                        tone: "success",
                      })
                    }
                    aria-label={`Review ${categoryLabel(capability.category)} category for ${capability.displayName}`}
                  >
                    Review category
                  </button>
                </span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="tools-capability-group" role="region" aria-label="Category autonomy overrides">
        <div className="tools-capability-group-header">
          <h3>Category overrides</h3>
          <span className="settings-card-detail">{categoryNames.length} categories</span>
        </div>
        <div className="tools-capability-list">
          {categoryNames.map((category) => (
            <label key={category} className="tools-category-override">
              <span>{categoryLabel(category)}</span>
              <select
                aria-label={`${categoryLabel(category)} override`}
                value={categoryOverrides[category] ?? "inherit"}
                onChange={(event) =>
                  void runAction("category", () =>
                    onCategoryOverrideChange?.(
                      category,
                      event.currentTarget.value as AutonomyMode | "inherit",
                    ),
                  )
                }
                disabled={!onCategoryOverrideChange || busyAction === "category"}
              >
                {categoryOverrideOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      <div className="tools-capability-groups">
        {groupedCapabilities.length === 0 ? (
          <p className="empty-state">No capabilities detected yet.</p>
        ) : (
          groupedCapabilities.map(([category, categoryCapabilities]) => {
            const label = categoryLabel(category);
            return (
            <section
              key={category}
              className="tools-capability-group"
              role="region"
              aria-label={`${label} capabilities`}
            >
              <div className="tools-capability-group-header">
                <h3>{label}</h3>
                <span className="settings-card-detail">{categoryCapabilities.length} tools</span>
              </div>
              <div className="tools-capability-list">
                {categoryCapabilities.map((capability) => (
                  <article key={capability.id} className="tools-capability-row">
                    <span className="profile-row-main">
                      <span className="profile-row-title">
                        {capability.displayName}
                        <span>{capability.source}</span>
                        <span>{capability.executionMode.replace("_", " ")}</span>
                      </span>
                      <span className="profile-row-summary">{capability.description}</span>
                      <span className="tools-policy-reason">
                        <strong>{policyReasonLabel(capability)}</strong>
                        {capability.policy?.reason ?? "Policy reason unavailable from capability catalog."}
                      </span>
                    </span>
                    <span className={`readiness-pill readiness-pill-${capability.status}`}>
                      {statusLabel(capability.status)}
                    </span>
                  </article>
                ))}
              </div>
            </section>
          );
          })
        )}
      </div>

      <section className="tools-grants-section" aria-label="Approval grants">
        <div className="tools-capability-group-header">
          <h3>Active grants</h3>
          <span className="settings-card-detail">
            {grants.filter((grant) => grant.status === "active").length} active
          </span>
        </div>
        <ApprovalGrantList
          grants={grants}
          capabilities={capabilities}
          onRevokeGrant={(id) => runAction("revoke", () => onRevokeGrant(id))}
        />
      </section>
    </section>
  );
}
