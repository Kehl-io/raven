import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileJson,
  Hammer,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { TEMPLATE_CATALOG, type WorkflowTemplate } from "../../domain/templates";
import {
  dailyWorkJournalWorkflow,
  validateWorkflowDefinition,
} from "../../domain/workflow";
import { formatSchedule, groupProviderProfiles } from "../../domain/format";
import { buildPreflightApprovalGrants } from "../domain/preflightGrants";
import { resolveApprovalGrantResult } from "../domain/approvalGrantResults";
import type {
  ApprovalGrantDraft,
  PreflightManifest,
  PlannerOperation,
  PlannerRationale,
  RavenWorkflow,
  WorkflowDraftRevisionContext,
  WorkflowVersion,
  WorkflowRunResult,
  WorkflowState,
} from "../../domain/types";
import { RunReadinessPanel } from "./RunReadinessPanel";
import { deriveProviderReadiness } from "../selectors/commandCenter";
import { useAppState } from "../contexts/AppStateContext";
import { useUI, type CreateWorkflowPath } from "../contexts/UIContext";
import { restoreFocusIfSafe, trapFocus } from "../lib/focusTrap";
import { createPersistedWorkflowDraft, evaluateWorkflowPreflight, runPersistedWorkflow } from "../tauriBridge";

type Category = "all" | WorkflowTemplate["category"];
type SaveAction = "draft" | "enabled" | "run-once";
type SupportedCadence = NonNullable<RavenWorkflow["schedule"]>["cadence"];
type PendingApprovedRun = {
  workflow: WorkflowVersion;
  manifest: PreflightManifest;
  grants: ApprovalGrantDraft[];
};
type RecentDraft = {
  definition: RavenWorkflow;
  sourceLabel: string;
  savedAt: string;
  selectedPath: CreateWorkflowPath;
  prompt?: string;
  importText?: string;
  templateId?: string;
  validationErrors?: string[];
  plannerRationale?: PlannerRationale | null;
  diffJson?: unknown;
  marketplace?: {
    templateId: string;
    version: string;
    sourceKind: "first-party" | "community";
  };
};

const RECENT_DRAFTS_KEY = "raven:create-hub-recent-drafts";
const MARKETPLACE_INSTALLS_KEY = "raven:marketplace-template-installs";

const SUPPORTED_CADENCES = new Set<SupportedCadence>(["manual", "daily", "weekdays"]);

function createAndRunNotice(workflowName: string, result: WorkflowRunResult): string {
  if (result.duplicate) return `${workflowName} created, but run already completed for this window.`;
  if (result.run.status === "blocked") {
    return `${workflowName} created, but run blocked: ${
      result.run.setupAction ?? result.run.blockedReason ?? "Configure the required provider in Settings."
    }`;
  }
  if (result.run.status === "failed") {
    return `${workflowName} created, but run failed: ${result.run.failureReason ?? "Review run details."}`;
  }
  if (result.run.status === "retryable") {
    return `${workflowName} created, but run retryable: ${result.run.failureReason ?? "Retry when ready."}`;
  }
  if (result.run.status === "running" || result.run.status === "queued") {
    return `${workflowName} created and run started.`;
  }
  return `${workflowName} created and run once.`;
}

function deterministicRevisionUnchanged(diffJson: unknown): boolean {
  if (!Array.isArray(diffJson)) return false;
  return diffJson.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    return (
      (record.op === "deterministic_revision" || record.op === "revision_fallback") &&
      record.changed === false
    );
  });
}

const PATHS: Array<{
  id: CreateWorkflowPath;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: "describe",
    label: "Describe with Raven",
    description: "Turn a short intent into a reviewable local draft.",
    icon: <Sparkles size={16} />,
  },
  {
    id: "template",
    label: "Start from template",
    description: "Browse reusable starting points by category.",
    icon: <Search size={16} />,
  },
  {
    id: "import",
    label: "Import workflow",
    description: "Paste a workflow JSON definition and validate it.",
    icon: <FileJson size={16} />,
  },
  {
    id: "manual",
    label: "Build manually",
    description: "Start from a small editable draft.",
    icon: <Hammer size={16} />,
  },
];

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "all", label: "All" },
  { value: "productivity", label: "Productivity" },
  { value: "research", label: "Research" },
  { value: "monitoring", label: "Monitoring" },
  { value: "content", label: "Content" },
  { value: "devops", label: "DevOps" },
];

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || `workflow-${Date.now()}`;
}

function cloneWorkflow(definition: RavenWorkflow): RavenWorkflow {
  return JSON.parse(JSON.stringify(definition)) as RavenWorkflow;
}

function readRecentDrafts(): RecentDraft[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_DRAFTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => sanitizeRecentDraft(item)).slice(0, 5);
  } catch {
    return [];
  }
}

function rememberRecentDraft(
  definition: RavenWorkflow,
  sourceLabel: string,
  context: {
    selectedPath: CreateWorkflowPath;
    prompt?: string;
    importText?: string;
    templateId?: string;
    validationErrors?: string[];
    plannerRationale?: PlannerRationale | null;
    diffJson?: unknown;
    marketplace?: RecentDraft["marketplace"];
  },
) {
  const recent = readRecentDrafts().filter((item) => item.definition.id !== definition.id);
  localStorage.setItem(RECENT_DRAFTS_KEY, JSON.stringify([
    { definition, sourceLabel, savedAt: new Date().toISOString(), ...context },
    ...recent,
  ].slice(0, 5)));
}

function sanitizeRecentDraft(value: unknown): RecentDraft[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Partial<RecentDraft>;
  if (!record.definition || typeof record.sourceLabel !== "string" || typeof record.savedAt !== "string") return [];
  return [{
    definition: record.definition,
    sourceLabel: record.sourceLabel,
    savedAt: record.savedAt,
    selectedPath: isCreateWorkflowPath(record.selectedPath) ? record.selectedPath : "manual",
    prompt: typeof record.prompt === "string" ? record.prompt : undefined,
    importText: typeof record.importText === "string" ? record.importText : undefined,
    templateId: typeof record.templateId === "string" ? record.templateId : undefined,
    validationErrors: Array.isArray(record.validationErrors) ? record.validationErrors.map(String) : [],
    plannerRationale: sanitizePlannerRationale(record.plannerRationale),
    diffJson: record.diffJson,
    marketplace: sanitizeMarketplaceDraft(record.marketplace),
  }];
}

function sanitizePlannerRationale(value: unknown): PlannerRationale | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    prompt: typeof record.prompt === "string" ? record.prompt : "",
    operations: Array.isArray(record.operations)
      ? record.operations.flatMap((operation) => sanitizePlannerOperation(operation))
      : [],
    warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
  };
}

function sanitizePlannerOperation(value: unknown): PlannerOperation[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || typeof record.kind !== "string"
    || typeof record.status !== "string"
    || typeof record.evidence !== "string"
  ) {
    return [];
  }
  const capabilityId = typeof record.capabilityId === "string"
    ? record.capabilityId
    : typeof record.capability_id === "string"
      ? record.capability_id
      : null;
  const stepId = typeof record.stepId === "string"
    ? record.stepId
    : typeof record.step_id === "string"
      ? record.step_id
      : null;
  return [{
    id: record.id,
    kind: record.kind,
    status: record.status as PlannerOperation["status"],
    evidence: record.evidence,
    capabilityId,
    capability_id: capabilityId,
    stepId,
    step_id: stepId,
    inputs: record.inputs ?? {},
  }];
}

function sanitizeMarketplaceDraft(value: unknown): RecentDraft["marketplace"] {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.templateId !== "string" || typeof record.version !== "string") return undefined;
  const sourceKind = record.sourceKind === "community" ? "community" : "first-party";
  return {
    templateId: record.templateId,
    version: record.version,
    sourceKind,
  };
}

function rememberMarketplaceInstall(
  workflowId: string,
  marketplace: NonNullable<RecentDraft["marketplace"]>,
) {
  try {
    const parsed = JSON.parse(localStorage.getItem(MARKETPLACE_INSTALLS_KEY) ?? "{}");
    const current = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    current[workflowId] = {
      ...marketplace,
      installedAt: new Date().toISOString(),
    };
    localStorage.setItem(MARKETPLACE_INSTALLS_KEY, JSON.stringify(current));
  } catch {
    localStorage.setItem(MARKETPLACE_INSTALLS_KEY, JSON.stringify({
      [workflowId]: {
        ...marketplace,
        installedAt: new Date().toISOString(),
      },
    }));
  }
}

function isCreateWorkflowPath(value: unknown): value is CreateWorkflowPath {
  return value === "describe" || value === "template" || value === "import" || value === "manual";
}

function normalizeWorkflowJson(input: unknown): { definition: RavenWorkflow; validationErrors: string[] } {
  const raw = input as Record<string, unknown>;
  const defaults = (raw.defaults ?? {}) as Record<string, unknown>;
  const schedule = raw.schedule as Record<string, unknown> | undefined;
  const rawCadence = schedule ? String(schedule.cadence ?? "manual") : undefined;
  const cadenceSupported = rawCadence === undefined || SUPPORTED_CADENCES.has(rawCadence as SupportedCadence);
  const validationErrors = cadenceSupported
    ? []
    : [`Workflow schedule cadence ${rawCadence} is unsupported.`];
  const steps = Array.isArray(raw.steps) ? raw.steps : [];

  const definition: RavenWorkflow = {
    schemaVersion: String(raw.schemaVersion ?? raw.schema_version ?? "") as RavenWorkflow["schemaVersion"],
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    description: String(raw.description ?? ""),
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map(String) : [],
    defaults: {
      llmProfileRef: String(defaults.llmProfileRef ?? defaults.llm_profile_ref ?? ""),
      destinationRef: String(defaults.destinationRef ?? defaults.destination_ref ?? "") as RavenWorkflow["defaults"]["destinationRef"],
    },
    schedule: schedule
      ? {
          cadence: cadenceSupported ? rawCadence as SupportedCadence : "manual",
          localTime: typeof schedule.localTime === "string"
            ? schedule.localTime
            : typeof schedule.local_time === "string"
              ? schedule.local_time
              : undefined,
        }
      : undefined,
    steps: steps.map((step) => {
      const rawStep = step as Record<string, unknown>;
      return {
        kind: String(rawStep.kind ?? "provider_action") as RavenWorkflow["steps"][number]["kind"],
        id: String(rawStep.id ?? ""),
        name: String(rawStep.name ?? ""),
        provider: String(rawStep.provider ?? ""),
        action: String(rawStep.action ?? ""),
        dependsOn: Array.isArray(rawStep.dependsOn)
          ? rawStep.dependsOn.map(String)
          : Array.isArray(rawStep.depends_on)
            ? rawStep.depends_on.map(String)
            : [],
        permissions: Array.isArray(rawStep.permissions) ? rawStep.permissions.map(String) : [],
        inputs: (rawStep.inputs && typeof rawStep.inputs === "object"
          ? rawStep.inputs
          : {}) as Record<string, unknown>,
        llmProfileRef: typeof rawStep.llmProfileRef === "string"
          ? rawStep.llmProfileRef
          : typeof rawStep.llm_profile_ref === "string"
            ? rawStep.llm_profile_ref
            : undefined,
        destinationRef: typeof rawStep.destinationRef === "string"
          ? rawStep.destinationRef as RavenWorkflow["defaults"]["destinationRef"]
          : typeof rawStep.destination_ref === "string"
            ? rawStep.destination_ref as RavenWorkflow["defaults"]["destinationRef"]
            : undefined,
        inlineCode: typeof rawStep.inlineCode === "string"
          ? rawStep.inlineCode
          : typeof rawStep.inline_code === "string"
            ? rawStep.inline_code
            : undefined,
        parallel: typeof rawStep.parallel === "boolean" ? rawStep.parallel : undefined,
      };
    }),
  };

  return { definition, validationErrors };
}

function workflowWithNameDescription(
  definition: RavenWorkflow,
  name: string,
  description: string,
): RavenWorkflow {
  const id = slugify(name);
  return {
    ...cloneWorkflow(definition),
    id,
    name,
    description,
  };
}

function providerLabel(definition: RavenWorkflow): string {
  return definition.defaults.llmProfileRef || "Provider not set";
}

function destinationLabel(definition: RavenWorkflow): string {
  return definition.defaults.destinationRef.replace(/[_-]/g, " ");
}

function workflowCapabilityLabels(definition: RavenWorkflow): string[] {
  return Array.from(new Set(definition.steps.map((step) => `${step.provider}.${step.action}`)));
}

function templateMarketplaceDraft(template: WorkflowTemplate): NonNullable<RecentDraft["marketplace"]> | undefined {
  const currentVersion = template.versions?.[0];
  if (!currentVersion) return undefined;
  return {
    templateId: template.id,
    version: currentVersion.version,
    sourceKind: template.source?.kind ?? "first-party",
  };
}

function plannerCoverageValue(operation: PlannerOperation): string {
  return operation.capabilityId ?? operation.capability_id ?? "Agent";
}

function plannerStepValue(operation: PlannerOperation): string {
  return operation.stepId ?? operation.step_id ?? "";
}

function templateDraftSourceLabel(template: WorkflowTemplate): string {
  const currentVersion = template.versions?.[0];
  return currentVersion ? `Template: ${template.name} v${currentVersion.version}` : `Template: ${template.name}`;
}

function templateDraftWorkflow(template: WorkflowTemplate): RavenWorkflow {
  return template.versions?.[0]?.workflow ?? template.workflow;
}

export function CreateWorkflowHub() {
  const { state, actions } = useAppState();
  const ui = useUI();
  const {
    selectedPath,
    prompt,
    importText,
    templateSearch,
    templateCategory,
    templateId,
    draft,
    reviewVisible,
  } = ui.createWorkflowHubState;
  const [parseError, setParseError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [draftGenerationError, setDraftGenerationError] = useState("");
  const [saveAction, setSaveAction] = useState<SaveAction | null>(null);
  const [draftGenerating, setDraftGenerating] = useState(false);
  const [draftFeedback, setDraftFeedback] = useState(
    "Improve this draft with clearer readiness, traceability, and artifact review steps.",
  );
  const [pendingApprovedRun, setPendingApprovedRun] = useState<PendingApprovedRun | null>(null);
  const [recentDrafts, setRecentDrafts] = useState<RecentDraft[]>(readRecentDrafts);
  const saveInFlightRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const providerGroups = useMemo(
    () => groupProviderProfiles(state.agentAuthProfiles),
    [state.agentAuthProfiles],
  );
  const hasReadyProvider = providerGroups.some((group) => group.isReady);
  const hasReadyOutput = state.providers.some(
    (provider) => provider.kind === "artifact_destination" && provider.status === "available",
  );
  const noWorkflowSuggestions = state.workflows.length === 0
    ? TEMPLATE_CATALOG.filter((template) => template.difficulty === "beginner").slice(0, 3)
    : [];
  const artifactRecommendations = state.artifacts.slice(0, 2).map((artifact) => ({
    id: artifact.id,
    label: `Follow up on ${artifact.title}`,
    prompt: `Create a follow-up workflow for artifact "${artifact.title}".`,
  }));
  const failedRunRecommendations = state.runs
    .filter((run) => run.status === "failed" || run.status === "retryable")
    .slice(0, 2)
    .map((run) => ({
      id: run.id,
      label: `Repair ${run.workflowName}`,
      prompt: `Create a repair workflow for ${run.workflowName} after run ${run.id}.`,
    }));

  const filteredTemplates = useMemo(() => {
    const query = templateSearch.trim().toLowerCase();
    return TEMPLATE_CATALOG.filter((template) => {
      const categoryMatch = templateCategory === "all" || template.category === templateCategory;
      if (!categoryMatch) return false;
      if (!query) return true;
      return [
        template.name,
        template.description,
        template.category,
        template.difficulty,
        ...template.tags,
        ...template.requirements,
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [templateCategory, templateSearch]);

  const draftValidation = useMemo(() => {
    if (!draft) return { valid: false, errors: ["No draft selected."] };
    const validation = validateWorkflowDefinition(draft.definition);
    const errors = [...(draft.validationErrors ?? []), ...validation.errors];
    return { valid: errors.length === 0, errors };
  }, [draft]);

  const providerReadiness = useMemo(() => {
    if (!draft) return null;
    return deriveProviderReadiness({
      id: `${draft.definition.id}-draft`,
      workflowId: draft.definition.id,
      version: 0,
      status: "draft",
      approvalMode: "review_changes",
      definition: draft.definition,
      createdAt: new Date(0).toISOString(),
    }, state);
  }, [draft, state]);

  const requirementIssues = useMemo(() => {
    const issues: string[] = [];
    if (!hasReadyProvider) issues.push("Provider setup required before enabling.");
    if (providerReadiness && providerReadiness.status !== "ready" && providerReadiness.status !== "degraded") {
      issues.push(...providerReadiness.issues);
    }
    if (!hasReadyOutput) issues.push("No artifact destination is ready.");
    return Array.from(new Set(issues));
  }, [hasReadyOutput, hasReadyProvider, providerReadiness]);

  const canEnable =
    Boolean(draft) &&
    draftValidation.valid &&
    requirementIssues.length === 0 &&
    hasReadyProvider &&
    hasReadyOutput;
  const revisionUnchanged = deterministicRevisionUnchanged(draft?.diffJson);
  const reviewActionsDisabled = saveAction !== null || draftGenerating;

  const selectedTemplate = useMemo(
    () => TEMPLATE_CATALOG.find((template) => template.id === templateId),
    [templateId],
  );
  const existingWorkflowForDraft = draft
    ? state.workflows.find((workflow) => workflow.workflowId === draft.definition.id)
    : undefined;
  const draftComparison = existingWorkflowForDraft
    ? [
        existingWorkflowForDraft.definition.name !== draft!.definition.name ? "name" : "",
        existingWorkflowForDraft.definition.description !== draft!.definition.description ? "description" : "",
        JSON.stringify(existingWorkflowForDraft.definition.schedule) !== JSON.stringify(draft!.definition.schedule)
          ? "schedule"
          : "",
        existingWorkflowForDraft.definition.steps.length !== draft!.definition.steps.length ? "steps" : "",
      ].filter(Boolean)
    : [];

  const selectPath = useCallback((path: CreateWorkflowPath) => {
    ui.updateCreateWorkflowHubState({ selectedPath: path });
    setSaveNotice("");
    setParseError("");
    setDraftGenerationError("");
  }, [ui]);

  const openReview = useCallback((
    definition: RavenWorkflow,
    sourceLabel: string,
    nextTemplateId = "",
    validationErrors: string[] = [],
    plannerRationale?: PlannerRationale | null,
    marketplace?: RecentDraft["marketplace"],
    diffJson?: unknown,
  ) => {
    ui.updateCreateWorkflowHubState({
      draft: { definition, sourceLabel, validationErrors, plannerRationale, marketplace, diffJson },
      templateId: nextTemplateId,
      reviewVisible: true,
    });
    rememberRecentDraft(definition, sourceLabel, {
      selectedPath,
      prompt,
      importText,
      templateId: nextTemplateId,
      validationErrors,
      plannerRationale,
      marketplace,
      diffJson,
    });
    setRecentDrafts(readRecentDrafts());
    setSaveNotice("");
    setParseError("");
    setDraftGenerationError("");
  }, [importText, prompt, selectedPath, ui]);

  const resumeRecentDraft = useCallback((item: RecentDraft) => {
    ui.updateCreateWorkflowHubState({
      selectedPath: item.selectedPath,
      prompt: item.prompt ?? "",
      importText: item.importText ?? "",
      templateId: item.templateId ?? "",
      draft: {
        definition: cloneWorkflow(item.definition),
        sourceLabel: item.sourceLabel,
        validationErrors: item.validationErrors ?? [],
        plannerRationale: item.plannerRationale,
        diffJson: item.diffJson,
        marketplace: item.marketplace,
      },
      reviewVisible: true,
    });
    setSaveNotice(`Resumed ${item.definition.name}.`);
    setParseError("");
  }, [ui]);

  const removeRecentDraft = useCallback((item: RecentDraft) => {
    const nextDrafts = readRecentDrafts().filter((draftItem) => draftItem.definition.id !== item.definition.id);
    localStorage.setItem(RECENT_DRAFTS_KEY, JSON.stringify(nextDrafts));
    setRecentDrafts(nextDrafts);
    setSaveNotice(`Removed ${item.definition.name} from recent drafts.`);
  }, []);

  const draftRevisionContext = useCallback((): WorkflowDraftRevisionContext | undefined => {
    if (!draft) return undefined;
    return {
      sourceLabel: draft.sourceLabel,
      validationErrors: draft.validationErrors ?? [],
      plannerRationale: draft.plannerRationale,
      definition: draft.definition,
    };
  }, [draft]);

  const requestWorkflowDraft = useCallback(async (
    cleanPrompt: string,
    previousDraft?: WorkflowDraftRevisionContext,
  ) => {
    if (!cleanPrompt) return;
    if (draftGenerating) return;

    setDraftGenerating(true);
    setDraftGenerationError("");
    setSaveNotice("");
    setPendingApprovedRun(null);
    const readyProfile = state.agentAuthProfiles.find((profile) => profile.status === "available");
    try {
      const workflowDraft = await createPersistedWorkflowDraft(
        cleanPrompt,
        readyProfile?.id,
        undefined,
        previousDraft,
      );
      if (!workflowDraft) {
        setDraftGenerationError("Workflow draft could not be generated.");
        return;
      }

      openReview(
        workflowDraft.definition,
        workflowDraft.summary || "Draft generated from prompt",
        "",
        workflowDraft.validationErrors,
        workflowDraft.plannerRationale ?? workflowDraft.planner_rationale,
        undefined,
        workflowDraft.diffJson,
      );
    } finally {
      setDraftGenerating(false);
    }
  }, [draftGenerating, openReview, state.agentAuthProfiles]);

  const generatePromptDraft = useCallback(async () => {
    const cleanPrompt = prompt.trim();
    await requestWorkflowDraft(cleanPrompt, draftRevisionContext());
  }, [draftRevisionContext, prompt, requestWorkflowDraft]);

  const createManualDraft = useCallback(() => {
    openReview(
      workflowWithNameDescription(
        dailyWorkJournalWorkflow,
        "Manual Workflow Draft",
        "Editable starter workflow for a local artifact-producing automation.",
      ),
      "Manual starter draft",
    );
  }, [openReview]);

  const reviewImport = useCallback(() => {
    setParseError("");
    try {
      const parsed = JSON.parse(importText);
      const normalized = normalizeWorkflowJson(parsed);
      openReview(normalized.definition, "Imported workflow JSON", "", normalized.validationErrors);
    } catch {
      setParseError("Workflow JSON could not be parsed.");
    }
  }, [importText, openReview]);

  const updateDraftFields = useCallback((fields: Partial<Pick<RavenWorkflow, "name" | "description">>) => {
    if (!draft) return;
    const nextDefinition = {
      ...draft.definition,
      ...fields,
      id: fields.name ? slugify(fields.name) : draft.definition.id,
    };
    ui.updateCreateWorkflowHubState({
      draft: {
        ...draft,
        definition: nextDefinition,
      },
    });
    rememberRecentDraft(nextDefinition, draft.sourceLabel, {
      selectedPath,
      prompt,
      importText,
      templateId,
      validationErrors: draft.validationErrors,
      plannerRationale: draft.plannerRationale,
      marketplace: draft.marketplace,
      diffJson: draft.diffJson,
    });
    setRecentDrafts(readRecentDrafts());
  }, [draft, importText, prompt, selectedPath, templateId, ui]);

  const improveDraft = useCallback(async () => {
    if (!draft) return;
    const cleanFeedback = draftFeedback.trim() || "Improve this draft.";
    await requestWorkflowDraft(cleanFeedback, draftRevisionContext());
  }, [draft, draftFeedback, draftRevisionContext, requestWorkflowDraft]);

  const saveDraft = useCallback(async (status: WorkflowState) => {
    if (!draft) return;
    if (draftGenerating) return;
    if (saveInFlightRef.current) return;
    const enabledStatus = status === "enabled";
    if (enabledStatus && (!canEnable || revisionUnchanged)) return;
    if (status === "draft" && !draftValidation.valid) {
      setSaveNotice("Draft kept in this session until validation passes.");
      return;
    }

    saveInFlightRef.current = true;
    setSaveAction(enabledStatus ? "enabled" : "draft");
    setSaveNotice("Saving...");
    try {
      const saved = await actions.installWorkflowTemplate(
        draft.definition,
        status,
        enabledStatus ? "review_changes" : "always_review",
        draft.plannerRationale,
      );
      if (saved && draft.marketplace) {
        rememberMarketplaceInstall(saved.workflowId, draft.marketplace);
      }
      setSaveNotice(
        saved
          ? `${saved.definition.name} ${status === "enabled" ? "created" : "saved as draft"}.`
          : "Workflow could not be saved.",
      );
    } finally {
      saveInFlightRef.current = false;
      setSaveAction(null);
    }
  }, [actions, canEnable, draft, draftGenerating, draftValidation.valid, revisionUnchanged]);

  const createAndRunOnce = useCallback(async () => {
    if (!draft || !canEnable || revisionUnchanged) return;
    if (draftGenerating) return;
    if (saveInFlightRef.current) return;

    saveInFlightRef.current = true;
    setSaveAction("run-once");
    setSaveNotice("Saving...");
    setPendingApprovedRun(null);
    try {
      const saved = await actions.installWorkflowTemplate(
        draft.definition,
        "enabled",
        "auto_approve",
        draft.plannerRationale,
      );
      if (!saved) {
        setSaveNotice("Workflow could not be saved.");
        return;
      }
      if (draft.marketplace) {
        rememberMarketplaceInstall(saved.workflowId, draft.marketplace);
      }

      setSaveNotice(`${saved.definition.name} created. Reviewing tools...`);
      const manifest = await evaluateWorkflowPreflight(
        saved.workflowId,
        saved.version,
        state.autonomyMode,
        state.autonomyCategoryOverrides,
      );
      const grants = buildPreflightApprovalGrants(manifest);
      if (manifest.blockingItems.length > 0 || grants.length > 0) {
        setPendingApprovedRun({ workflow: saved, manifest, grants });
        setSaveNotice(`${saved.definition.name} needs tool approval before running.`);
        return;
      }

      setSaveNotice(`${saved.definition.name} created. Running once...`);
      const result = await runPersistedWorkflow(saved.workflowId);
      if (result) {
        actions.applyRunResults([result]);
        setSaveNotice(createAndRunNotice(saved.definition.name, result));
        return;
      }

      await actions.runWorkflow(saved.workflowId);
      setSaveNotice(`${saved.definition.name} created and run once.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveNotice(`Workflow created, but run failed: ${message || "Review run details."}`);
    } finally {
      saveInFlightRef.current = false;
      setSaveAction(null);
    }
  }, [actions, canEnable, draft, draftGenerating, revisionUnchanged, state.autonomyCategoryOverrides, state.autonomyMode, state.capabilityRegistry.capabilities]);

  const approveToolsAndRun = useCallback(async () => {
    if (!pendingApprovedRun) return;
    if (saveInFlightRef.current) return;

    saveInFlightRef.current = true;
    setSaveAction("run-once");
    setSaveNotice("Approving tools...");
    try {
      const grantResults = await Promise.all(pendingApprovedRun.grants.map((grant) =>
        resolveApprovalGrantResult(actions.createApprovalGrant(grant))
      ));
      const failedGrant = grantResults.find((result) => !result.ok);
      if (failedGrant) throw new Error(failedGrant.message);

      setSaveNotice(`${pendingApprovedRun.workflow.definition.name} approved. Running once...`);
      const result = await runPersistedWorkflow(pendingApprovedRun.workflow.workflowId);
      if (result) {
        actions.applyRunResults([result]);
        setSaveNotice(createAndRunNotice(pendingApprovedRun.workflow.definition.name, result));
        if (result.run.status !== "blocked" && result.run.status !== "failed" && result.run.status !== "retryable") {
          setPendingApprovedRun(null);
        }
        return;
      }

      await actions.runWorkflow(pendingApprovedRun.workflow.workflowId);
      setSaveNotice(`${pendingApprovedRun.workflow.definition.name} created and run once.`);
      setPendingApprovedRun(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveNotice(`Workflow created, but approval or run failed: ${message || "Review run details."}`);
    } finally {
      saveInFlightRef.current = false;
      setSaveAction(null);
    }
  }, [actions, pendingApprovedRun]);

  const configureProvider = useCallback(() => {
    ui.setActiveSettingsTab("providers");
    ui.setView("settings");
    ui.closeCreateWorkflowHub();
  }, [ui]);

  const close = useCallback(() => {
    ui.closeCreateWorkflowHub();
  }, [ui]);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      restoreFocusIfSafe(previousFocusRef.current, '[aria-label="Open Raven assistant"]');
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [close]);

  return (
    <div
      className="create-hub-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="create-hub"
        role="dialog"
        aria-modal="true"
        aria-label="Create workflow"
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={(event) => trapFocus(event, dialogRef.current)}
      >
        <header className="create-hub-header">
          <div>
            <p className="eyebrow">Workflows / Create</p>
            <h2>Create workflow</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close create hub"
            title="Close create hub"
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>

        {!hasReadyProvider && (
          <div className="create-hub-callout" role="status">
            <AlertTriangle size={16} />
            <div>
              <strong>No provider is ready</strong>
              <p>Drafts can be saved now. Configure a provider before enabling or running workflows.</p>
            </div>
            <button type="button" onClick={configureProvider}>
              Configure provider
            </button>
          </div>
        )}

        {noWorkflowSuggestions.length > 0 && (
          <div className="create-hub-recommendations" aria-label="Recommended starts">
            <span>Recommended starts</span>
            {noWorkflowSuggestions.map((template) => (
              <button
                type="button"
                key={template.id}
                onClick={() => {
                  selectPath("template");
                  openReview(
                    cloneWorkflow(templateDraftWorkflow(template)),
                    templateDraftSourceLabel(template),
                    template.id,
                    [],
                    undefined,
                    templateMarketplaceDraft(template),
                  );
                }}
              >
                {template.name}
              </button>
            ))}
          </div>
        )}

        {(recentDrafts.length > 0 || artifactRecommendations.length > 0 || failedRunRecommendations.length > 0) && (
          <div className="create-hub-recommendations" aria-label="Recent drafts and recommendations">
            <span>Recent drafts and recommendations</span>
            {recentDrafts.map((item) => (
              <article
                className="create-hub-recent-draft"
                key={`${item.definition.id}:${item.savedAt}`}
              >
                <div>
                  <strong>{item.definition.name}</strong>
                  <small>
                    {item.sourceLabel} · {formatSchedule(item.definition.schedule)}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => resumeRecentDraft(item)}
                >
                  Resume
                </button>
                <button
                  type="button"
                  onClick={() => removeRecentDraft(item)}
                  aria-label={`Remove recent draft ${item.definition.name}`}
                >
                  Remove
                </button>
              </article>
            ))}
            {[...failedRunRecommendations, ...artifactRecommendations].map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  ui.updateCreateWorkflowHubState({ selectedPath: "describe", prompt: item.prompt });
                  selectPath("describe");
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        <div className="create-hub-layout">
          <nav className="create-hub-paths" aria-label="Create workflow paths">
            {PATHS.map((path) => (
              <button
                type="button"
                key={path.id}
                className={selectedPath === path.id ? "active" : ""}
                aria-pressed={selectedPath === path.id}
                aria-label={path.label}
                onClick={() => selectPath(path.id)}
              >
                {path.icon}
                <span>{path.label}</span>
                <small>{path.description}</small>
              </button>
            ))}
          </nav>

          <section className="create-hub-stage" aria-label="Create path details">
            {selectedPath === "describe" && (
              <div className="create-hub-panel">
                <label htmlFor="create-hub-prompt">Describe the workflow</label>
                <textarea
                  id="create-hub-prompt"
                  value={prompt}
                  onChange={(event) => ui.updateCreateWorkflowHubState({ prompt: event.currentTarget.value })}
                  placeholder="Summarize project updates every Friday and save a Markdown artifact"
                />
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => void generatePromptDraft()}
                  disabled={!prompt.trim() || draftGenerating}
                >
                  {draftGenerating ? "Generating..." : "Generate draft"}
                </button>
                {draftGenerationError && <p className="error-note">{draftGenerationError}</p>}
              </div>
            )}

            {selectedPath === "template" && (
              <div className="create-hub-panel">
                <label htmlFor="create-hub-template-search">Search templates</label>
                <input
                  id="create-hub-template-search"
                  type="search"
                  value={templateSearch}
                  onChange={(event) => ui.updateCreateWorkflowHubState({ templateSearch: event.currentTarget.value })}
                />
                <div className="create-hub-category-row" aria-label="Template categories">
                  {CATEGORIES.map((category) => (
                    <button
                      type="button"
                      key={category.value}
                      className={templateCategory === category.value ? "active" : ""}
                      aria-pressed={templateCategory === category.value}
                      onClick={() => ui.updateCreateWorkflowHubState({ templateCategory: category.value })}
                    >
                      {category.label}
                    </button>
                  ))}
                </div>
                <div className="create-hub-template-list">
                  {filteredTemplates.map((template) => (
                    <article key={template.id} className="create-hub-template-card">
                      <div>
                        <strong>{template.name}</strong>
                        <p>{template.description}</p>
                        <span>{template.category} · {template.difficulty}</span>
                        <small>
                          Preview: creates a {template.workflow.defaults.destinationRef} Markdown artifact using{" "}
                          {workflowCapabilityLabels(template.workflow).join(", ") || template.requirements.join(", ") || "built-in context"}.
                        </small>
                      </div>
                      <button
                        type="button"
                        className={templateId === template.id ? "primary-action" : ""}
                        onClick={() => openReview(
                          cloneWorkflow(templateDraftWorkflow(template)),
                          templateDraftSourceLabel(template),
                          template.id,
                          [],
                          undefined,
                          templateMarketplaceDraft(template),
                        )}
                        aria-label={`Use template ${template.name}`}
                      >
                        Use template
                      </button>
                    </article>
                  ))}
                </div>
              </div>
            )}

            {selectedPath === "import" && (
              <div className="create-hub-panel">
                <label htmlFor="create-hub-import">Workflow JSON</label>
                <textarea
                  id="create-hub-import"
                  className="create-hub-json"
                  value={importText}
                  onChange={(event) => ui.updateCreateWorkflowHubState({ importText: event.currentTarget.value })}
                  spellCheck={false}
                />
                {parseError && <p className="error-note">{parseError}</p>}
                <button
                  type="button"
                  className="primary-action"
                  onClick={reviewImport}
                  disabled={!importText.trim()}
                >
                  Review imported workflow
                </button>
              </div>
            )}

            {selectedPath === "manual" && (
              <div className="create-hub-panel">
                <h3>Manual starter</h3>
                <p>
                  Start from a small local workflow draft, then edit the name and description before saving.
                </p>
                <button type="button" className="primary-action" onClick={createManualDraft}>
                  Start manual draft
                </button>
              </div>
            )}
          </section>

          {reviewVisible && draft && (
            <aside className="create-hub-review" aria-label="Draft review">
              <div className="create-hub-review-heading">
                <div>
                  <h3>Review draft</h3>
                  <span>{draft.sourceLabel}</span>
                </div>
                {draftValidation.valid && requirementIssues.length === 0 ? (
                  <CheckCircle2 size={18} aria-label="Draft ready" />
                ) : (
                  <AlertTriangle size={18} aria-label="Draft needs review" />
                )}
              </div>

              <label htmlFor="create-hub-draft-name">Workflow name</label>
              <input
                id="create-hub-draft-name"
                value={draft.definition.name}
                onChange={(event) => updateDraftFields({ name: event.currentTarget.value })}
              />
              <label htmlFor="create-hub-draft-description">Description</label>
              <textarea
                id="create-hub-draft-description"
                value={draft.definition.description}
                onChange={(event) => updateDraftFields({ description: event.currentTarget.value })}
              />

              <dl className="create-hub-review-grid">
                <div>
                  <dt>Trigger / Schedule</dt>
                  <dd>{formatSchedule(draft.definition.schedule)}</dd>
                </div>
                <div>
                  <dt>Provider / Model</dt>
                  <dd>{providerReadiness?.providerName ?? providerLabel(draft.definition)} · {providerReadiness?.model ?? "model in profile"}</dd>
                </div>
                <div>
                  <dt>Approval mode</dt>
                  <dd>Review changes</dd>
                </div>
                <div>
                  <dt>Artifact destination</dt>
                  <dd>{destinationLabel(draft.definition)} · Markdown artifact</dd>
                </div>
                <div>
                  <dt>Requirements / Permissions</dt>
                  <dd>{draft.definition.permissions.length > 0 ? draft.definition.permissions.join(", ") : "None declared"}</dd>
                </div>
                <div>
                  <dt>Provider actions</dt>
                  <dd>{workflowCapabilityLabels(draft.definition).join(", ") || "None declared"}</dd>
                </div>
              </dl>

              {(requirementIssues.length > 0 || !draftValidation.valid) && (
                <div className="create-hub-validation" role="alert">
                  <strong>Validation errors and missing requirements</strong>
                  <ul>
                    {requirementIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                    {draftValidation.errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}

              {draft.plannerRationale && (
                <section className="create-hub-planner-coverage" aria-label="Planner coverage">
                  <div className="create-hub-planner-header">
                    <h4>Planner coverage</h4>
                    <span>{draft.plannerRationale.operations.length} operations</span>
                  </div>
                  <div className="create-hub-planner-list">
                    {draft.plannerRationale.operations.map((operation) => {
                      const coverage = plannerCoverageValue(operation);
                      const stepId = plannerStepValue(operation);
                      return (
                        <article
                          key={operation.id}
                          className="create-hub-planner-row"
                        >
                          <div className="create-hub-planner-row-header">
                            <strong>{operation.kind}</strong>
                            <span>{operation.status}</span>
                          </div>
                          <dl>
                            <div>
                              <dt>Capability</dt>
                              <dd>{coverage}</dd>
                            </div>
                            <div>
                              <dt>Step</dt>
                              <dd>{stepId || "None"}</dd>
                            </div>
                            <div>
                              <dt>Evidence</dt>
                              <dd>{operation.evidence}</dd>
                            </div>
                          </dl>
                        </article>
                      );
                    })}
                  </div>
                  {draft.plannerRationale.warnings.length > 0 && (
                    <div className="create-hub-planner-warnings" role="alert">
                      <strong>Warnings</strong>
                      <ul>
                        {draft.plannerRationale.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}

              <div className="create-hub-feedback">
                <label htmlFor="create-hub-draft-feedback">Tell Raven what to improve</label>
                <textarea
                  id="create-hub-draft-feedback"
                  value={draftFeedback}
                  onChange={(event) => setDraftFeedback(event.currentTarget.value)}
                  disabled={draftGenerating}
                />
                {revisionUnchanged && (
                  <p className="create-hub-revision-warning" role="status">
                    Raven kept the draft unchanged because that edit is not supported yet.
                  </p>
                )}
              </div>

              <div className="create-hub-actions">
                <button
                  type="button"
                  onClick={() => void improveDraft()}
                  disabled={reviewActionsDisabled || !draftFeedback.trim()}
                >
                  Ask Raven to improve this draft
                </button>
                <button
                  type="button"
                  onClick={() => void saveDraft("draft")}
                  disabled={reviewActionsDisabled}
                >
                  Save as draft
                </button>
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => void saveDraft("enabled")}
                  disabled={reviewActionsDisabled || !canEnable || revisionUnchanged}
                >
                  Create enabled workflow
                </button>
                <button
                  type="button"
                  onClick={() => void createAndRunOnce()}
                  disabled={reviewActionsDisabled || !canEnable || revisionUnchanged}
                  title={
                    revisionUnchanged
                      ? "Ask Raven for a supported revision before creating and running."
                      : canEnable
                      ? "Create the enabled workflow and run it once."
                      : "Resolve validation, provider, and output requirements before running."
                  }
                >
                  Create and run once
                </button>
                <button type="button" onClick={configureProvider}>
                  Provider settings
                </button>
              </div>
              {!canEnable && (
                <p className="create-hub-disabled-reason">
                  Enable and run actions unlock after validation, provider, and output requirements are ready.
                </p>
              )}
              {canEnable && revisionUnchanged && (
                <p className="create-hub-disabled-reason">
                  Create and run actions stay locked until Raven applies a supported change or you save the draft.
                </p>
              )}
              {saveNotice && <p className="success-note">{saveNotice}</p>}
              {pendingApprovedRun && (
                <section className="create-hub-preflight" aria-label="Approve tools before running">
                  <div className="create-hub-preflight-header">
                    <h4>Approve tools before running</h4>
                    <button
                      type="button"
                      className="primary-action"
                      onClick={() => void approveToolsAndRun()}
                      disabled={
                        saveAction !== null ||
                        pendingApprovedRun.manifest.blockingItems.length > 0 ||
                        pendingApprovedRun.grants.length === 0
                      }
                    >
                      {saveAction === "run-once" ? "Approving..." : "Approve tools and run once"}
                    </button>
                  </div>
                  <RunReadinessPanel
                    manifest={pendingApprovedRun.manifest}
                    capabilities={state.capabilityRegistry.capabilities}
                    approvalGrants={state.approvalGrants}
                    onCreateGrant={actions.createApprovalGrant}
                    onCategoryOverrideChange={actions.setAutonomyCategoryOverride}
                    onCategoryOverridesChange={actions.setAutonomyCategoryOverrides}
                  />
                </section>
              )}
              {selectedTemplate && (
                <p className="create-hub-source-note">Selected template: {selectedTemplate.name}</p>
              )}
              {existingWorkflowForDraft && (
                <p className="create-hub-source-note">
                  Version comparison: imported workflow matches existing v{existingWorkflowForDraft.version}
                  {draftComparison.length > 0 ? ` with changes to ${draftComparison.join(", ")}.` : " with no detected changes."}
                </p>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
