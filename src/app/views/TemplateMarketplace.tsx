import { useState, useMemo } from "react";
import { CheckCircle2, Download, Filter, GitCompare, ShieldCheck, Sparkles } from "lucide-react";
import {
  TEMPLATE_CATALOG,
  type WorkflowTemplate,
  type WorkflowTemplateSource,
  type WorkflowTemplateVersion,
} from "../../domain/templates";
import type { RavenWorkflow, WorkflowVersion } from "../../domain/types";
import { useAppState } from "../contexts/AppStateContext";
import { useUI } from "../contexts/UIContext";

type Category = "all" | WorkflowTemplate["category"];
type MarketplaceInstallMetadata = Record<string, {
  templateId: string;
  version: string;
  sourceKind: "first-party" | "community";
  installedAt: string;
}>;

const MARKETPLACE_INSTALLS_KEY = "raven:marketplace-template-installs";
const TRUST_REVIEWS_KEY = "raven:marketplace-trust-reviews";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "all", label: "All" },
  { value: "productivity", label: "Productivity" },
  { value: "research", label: "Research" },
  { value: "monitoring", label: "Monitoring" },
  { value: "content", label: "Content" },
  { value: "devops", label: "DevOps" },
];

function difficultyLabel(difficulty: WorkflowTemplate["difficulty"]): string {
  if (difficulty === "beginner") return "Beginner";
  if (difficulty === "intermediate") return "Intermediate";
  return "Advanced";
}

function cloneWorkflow(definition: RavenWorkflow): RavenWorkflow {
  return JSON.parse(JSON.stringify(definition)) as RavenWorkflow;
}

function fallbackVersion(template: WorkflowTemplate): WorkflowTemplateVersion {
  return {
    version: "1.0.0",
    releasedAt: "2026-06-01",
    changelog: ["Initial marketplace template release."],
    workflow: template.workflow,
  };
}

function versionsForTemplate(template: WorkflowTemplate): WorkflowTemplateVersion[] {
  return template.versions?.length ? template.versions : [fallbackVersion(template)];
}

function sourceForTemplate(template: WorkflowTemplate): WorkflowTemplateSource {
  return template.source ?? {
    kind: "first-party",
    maintainer: "Raven templates",
    repository: "raven://templates/core",
    trust: "verified",
    reviewedAt: "2026-06-15",
  };
}

function compareSemver(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const difference = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function readMarketplaceInstalls(): MarketplaceInstallMetadata {
  try {
    const parsed = JSON.parse(localStorage.getItem(MARKETPLACE_INSTALLS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as MarketplaceInstallMetadata
      : {};
  } catch {
    return {};
  }
}

function readTrustReviews(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRUST_REVIEWS_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function persistTrustReviews(templateIds: Set<string>) {
  localStorage.setItem(TRUST_REVIEWS_KEY, JSON.stringify(Array.from(templateIds)));
}

function installedMarketplaceVersion(workflow: WorkflowVersion, installs: MarketplaceInstallMetadata): string {
  const cached = installs[workflow.workflowId]?.version;
  return cached ?? `${workflow.version}.0.0`;
}

function workflowDiffs(installed: RavenWorkflow, marketplace: RavenWorkflow): string[] {
  const diffs = [
    installed.name !== marketplace.name ? "Name changed" : "",
    installed.description !== marketplace.description ? "Description changed" : "",
    JSON.stringify(installed.schedule) !== JSON.stringify(marketplace.schedule) ? "Schedule changed" : "",
    JSON.stringify([...installed.permissions].sort()) !== JSON.stringify([...marketplace.permissions].sort())
      ? "Permissions changed"
      : "",
    installed.steps.length !== marketplace.steps.length ||
      installed.steps.map((step) => step.id).join(",") !== marketplace.steps.map((step) => step.id).join(",")
      ? "Steps changed"
      : "",
  ].filter(Boolean);

  return diffs.length > 0 ? diffs : ["No workflow definition changes"];
}

function actionLabel(
  selectedVersion: WorkflowTemplateVersion,
  currentVersion: WorkflowTemplateVersion,
  installed: WorkflowVersion | undefined,
  installedVersion: string | null,
): string {
  if (selectedVersion.deprecated) return "Deprecated version";
  if (installed && installedVersion && compareSemver(selectedVersion.version, installedVersion) > 0) {
    return "Review update";
  }
  if (installed && installedVersion && compareSemver(selectedVersion.version, installedVersion) < 0) {
    return "Review rollback";
  }
  if (selectedVersion.version !== currentVersion.version) return "Review version";
  if (installed) return "Installed";
  return "Review draft";
}

function actionAriaLabel(
  template: WorkflowTemplate,
  selectedVersion: WorkflowTemplateVersion,
  currentVersion: WorkflowTemplateVersion,
  installed: WorkflowVersion | undefined,
  installedVersion: string | null,
): string {
  if (selectedVersion.deprecated) return `Deprecated ${template.name} version ${selectedVersion.version}`;
  if (installed && installedVersion && compareSemver(selectedVersion.version, installedVersion) > 0) {
    return `Review ${template.name} update to version ${selectedVersion.version}`;
  }
  if (installed && installedVersion && compareSemver(selectedVersion.version, installedVersion) < 0) {
    return `Review ${template.name} rollback to version ${selectedVersion.version}`;
  }
  if (selectedVersion.version !== currentVersion.version) {
    return `Review ${template.name} version ${selectedVersion.version} draft`;
  }
  return installed ? `${template.name} already installed` : `Review ${template.name} draft`;
}

export function TemplateMarketplace() {
  const { state } = useAppState();
  const { setView, openCreateWorkflowHub } = useUI();
  const [activeCategory, setActiveCategory] = useState<Category>("all");
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [trustedReviews, setTrustedReviews] = useState<Set<string>>(readTrustReviews);
  const installMetadata = useMemo(() => readMarketplaceInstalls(), []);

  const filtered = useMemo(
    () =>
      activeCategory === "all"
        ? TEMPLATE_CATALOG
        : TEMPLATE_CATALOG.filter((t) => t.category === activeCategory),
    [activeCategory],
  );

  function handleInstall(template: WorkflowTemplate, selectedVersion: WorkflowTemplateVersion) {
    const source = sourceForTemplate(template);
    const currentVersion = versionsForTemplate(template)[0];
    const installedWorkflow = state.workflows.find(
      (workflow) => workflow.workflowId === selectedVersion.workflow.id || workflow.workflowId === template.workflow.id,
    );
    const sourceLabel = selectedVersion.version === currentVersion.version && !installedWorkflow
      ? `Template: ${template.name}`
      : `Template: ${template.name} v${selectedVersion.version}`;
    openCreateWorkflowHub({
      selectedPath: "template",
      templateId: template.id,
      draft: {
        definition: cloneWorkflow(selectedVersion.workflow),
        sourceLabel,
        marketplace: {
          templateId: template.id,
          version: selectedVersion.version,
          sourceKind: source.kind,
        },
      },
      reviewVisible: true,
    });
  }

  function verifySource(templateId: string) {
    setTrustedReviews((current) => {
      const next = new Set(current);
      next.add(templateId);
      persistTrustReviews(next);
      return next;
    });
  }

  return (
    <section className="view-grid">
      <header className="page-header">
        <div>
          <p className="breadcrumb">Workflows / Templates</p>
          <h1>
            <Sparkles size={22} style={{ verticalAlign: "middle", marginRight: "0.4rem" }} />
            Workflows / Templates
          </h1>
          <p style={{ color: "var(--muted)", margin: 0, fontSize: "0.9rem" }}>
            {TEMPLATE_CATALOG.length} ready-to-use workflow templates
          </p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => setView("workflows")}>
            Back to Workflows
          </button>
        </div>
      </header>

      <div className="category-filters" aria-label="Filter by category">
        <Filter size={15} style={{ color: "var(--muted)", alignSelf: "center" }} />
        {CATEGORIES.map((cat) => (
          <button
            key={cat.value}
            type="button"
            className={`category-filter${activeCategory === cat.value ? " active" : ""}`}
            onClick={() => setActiveCategory(cat.value)}
            aria-pressed={activeCategory === cat.value}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <div className="template-grid">
        {filtered.map((template) => {
          const versions = versionsForTemplate(template);
          const currentVersion = versions[0];
          const selectedVersion =
            versions.find((version) => version.version === selectedVersions[template.id]) ?? currentVersion;
          const source = sourceForTemplate(template);
          const locallyVerified = trustedReviews.has(template.id);
          const agentStepCount = selectedVersion.workflow.steps.filter((step) => step.kind === "agent_task").length;
          const alreadyInstalled =
            state.workflows.find((w) => w.workflowId === selectedVersion.workflow.id || w.workflowId === template.workflow.id);
          const installedVersion = alreadyInstalled
            ? installedMarketplaceVersion(alreadyInstalled, installMetadata)
            : null;
          const updateAvailable =
            Boolean(alreadyInstalled && installedVersion && compareSemver(currentVersion.version, installedVersion) > 0);
          const selectedDiffs = alreadyInstalled
            ? workflowDiffs(alreadyInstalled.definition, selectedVersion.workflow)
            : [];
          const actionDisabled =
            Boolean(selectedVersion.deprecated) ||
            Boolean(alreadyInstalled && installedVersion && compareSemver(selectedVersion.version, installedVersion) === 0);

          return (
            <article key={template.id} className="template-card">
              <div>
                <div className="template-meta" style={{ marginBottom: "0.4rem" }}>
                  <span className={`template-badge template-badge-${template.category}`}>
                    {template.category}
                  </span>
                  <span className={`template-badge template-badge-${template.difficulty}`}>
                    {difficultyLabel(template.difficulty)}
                  </span>
                  <span className={`template-badge template-badge-${source.kind === "community" ? "community" : "verified"}`}>
                    {source.kind === "community" ? "Community" : "First-party"}
                  </span>
                </div>
                <h3>{template.name}</h3>
                <p>{template.description}</p>
              </div>

              <div className="template-version-panel">
                <label htmlFor={`${template.id}-version`}>Version</label>
                <select
                  id={`${template.id}-version`}
                  aria-label={`${template.name} version`}
                  value={selectedVersion.version}
                  onChange={(event) => setSelectedVersions((current) => ({
                    ...current,
                    [template.id]: event.currentTarget.value,
                  }))}
                >
                  {versions.map((version) => (
                    <option key={version.version} value={version.version}>
                      {version.version}{version.deprecated ? " deprecated" : ""}
                    </option>
                  ))}
                </select>
                <div className="template-version-status">
                  <span>Marketplace {currentVersion.version}</span>
                  {installedVersion && <span>Installed {installedVersion}</span>}
                  {updateAvailable && <strong>Update available</strong>}
                  {selectedVersion.deprecated && <strong>Deprecated</strong>}
                </div>
                <div className="template-changelog" aria-label={`${template.name} changelog`}>
                  <strong>Changelog</strong>
                  <ul>
                    {selectedVersion.changelog.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                    {selectedVersion.deprecationReason && <li>{selectedVersion.deprecationReason}</li>}
                  </ul>
                  <small>{selectedVersion.version} · {selectedVersion.releasedAt}</small>
                </div>
              </div>

              <div className="template-lifecycle" aria-label={`${template.name} lifecycle`}>
                <div>
                  <ShieldCheck size={15} aria-hidden="true" />
                  <span>{source.maintainer}</span>
                </div>
                <div>
                  <CheckCircle2 size={15} aria-hidden="true" />
                  <span>
                    {source.trust === "verified" || locallyVerified
                      ? "Source verified locally"
                      : "Source review pending"}
                  </span>
                </div>
                <div>
                  <GitCompare size={15} aria-hidden="true" />
                  <span>{agentStepCount > 0 ? "Multi-agent review required" : "Standard draft review"}</span>
                </div>
                <small>{source.repository}</small>
                {source.kind === "community" && !locallyVerified && (
                  <button type="button" onClick={() => verifySource(template.id)}>
                    Verify {template.name} source
                  </button>
                )}
              </div>

              {alreadyInstalled && (
                <div className="template-compare" aria-label={`${template.name} version comparison`}>
                  <strong>Compare installed to marketplace</strong>
                  <div className="template-tags">
                    {selectedDiffs.map((diff) => (
                      <span key={diff} className="template-tag">
                        {diff}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {template.requirements.length > 0 && (
                <div className="template-tags">
                  {template.requirements.map((req) => (
                    <span key={req} className="template-tag">
                      {req}
                    </span>
                  ))}
                </div>
              )}

              <div className="template-tags">
                {template.tags.map((tag) => (
                  <span key={tag} className="template-tag">
                    #{tag}
                  </span>
                ))}
              </div>

              <button
                type="button"
                className="primary-action"
                onClick={() => handleInstall(template, selectedVersion)}
                disabled={actionDisabled}
                aria-label={actionAriaLabel(template, selectedVersion, currentVersion, alreadyInstalled, installedVersion)}
              >
                <Download size={15} />
                {actionLabel(selectedVersion, currentVersion, alreadyInstalled, installedVersion)}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
