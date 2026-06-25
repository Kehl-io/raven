import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FileJson, Sparkles, X } from "lucide-react";
import { useAppState } from "./contexts/AppStateContext";
import { useUI } from "./contexts/UIContext";
import { ProviderGroupCard } from "./components/ProviderGroupCard";
import ravenMark from "../assets/raven-icon.png";
import {
  currentWeatherWorkflow,
  dailyWorkJournalWorkflow,
  morningBriefWorkflow,
  validateWorkflowDefinition,
} from "../domain/workflow";
import { buildPreflightApprovalGrants } from "./domain/preflightGrants";
import { resolveApprovalGrantResult } from "./domain/approvalGrantResults";
import type {
  ApprovalMode,
  Artifact,
  ArtifactDestinationRef,
  PreflightManifest,
  RavenWorkflow,
  WorkflowState,
  WorkflowRunResult,
  WorkflowVersion,
} from "../domain/types";
import { formatSchedule, groupProviderProfiles } from "../domain/format";
import {
  approveWorkflowSignatureBaseline,
  detectNestWeaver,
  detectTools,
  evaluateWorkflowDefinitionPreflight,
  type NestWeaverDetection,
} from "./tauriBridge";

type ContextSourceId = "local_git" | "github" | "documents" | "chat_imports" | "nestweaver";
type OutputDestinationId = "local_app" | "markdown_folder" | "obsidian_vault";
type WorkflowChoiceMode = "template" | "describe" | "import";
type FinishProgress = {
  approvalMode?: ApprovalMode;
  installed: WorkflowVersion;
  runSample: boolean;
  sampleApplied: boolean;
  signature: string;
  status: WorkflowState;
  workflowId: string;
};
type ReviewReadiness =
  | { kind: "simulated_preview" }
  | { kind: "loading" }
  | { kind: "live_ready"; manifest: PreflightManifest }
  | { kind: "approval_required"; manifest: PreflightManifest }
  | { kind: "blocked"; manifest: PreflightManifest; reason: string }
  | { kind: "error"; message: string };

type NestWeaverContextState = {
  detail: string;
  keepLocalGitSelected: boolean;
  selectable: boolean;
  status: "available" | "needs_config" | "unavailable";
};

const FINISH_PROGRESS_STORAGE_KEY = "raven:onboarding-finish-progress";

const WIZARD_STEPS = [
  "Welcome and value orientation",
  "Connect AI provider",
  "Choose context sources",
  "Choose output destination",
  "Set safety defaults",
  "Choose/create first workflow",
  "Review and optionally run sample",
] as const;

const contextSources: Array<{
  id: ContextSourceId;
  label: string;
  description: string;
  providerId?: string;
  required?: boolean;
}> = [
  {
    id: "local_git",
    label: "Local git",
    description: "Ready by default for commits, diffs, and project activity.",
    providerId: "local_git",
    required: true,
  },
  {
    id: "github",
    label: "GitHub",
    description: "Optional pull request and issue context after setup.",
    providerId: "github",
  },
  {
    id: "documents",
    label: "Documents",
    description: "Optional PDF and document imports from a local folder.",
    providerId: "document_import",
  },
  {
    id: "chat_imports",
    label: "Chat imports",
    description: "Optional local AI chat export imports.",
    providerId: "ai_chat_import",
  },
  {
    id: "nestweaver",
    label: "NestWeaver",
    description: "Optional indexed project context when connected.",
    providerId: "nestweaver",
  },
];

const outputDestinations: Array<{
  id: OutputDestinationId;
  workflowRef: ArtifactDestinationRef;
  label: string;
  description: string;
}> = [
  {
    id: "local_app",
    workflowRef: "local-app",
    label: "Local app",
    description: "Store artifacts in Raven's local library.",
  },
  {
    id: "markdown_folder",
    workflowRef: "markdown_folder",
    label: "Markdown folder",
    description: "Write Markdown files to a configured local folder.",
  },
  {
    id: "obsidian_vault",
    workflowRef: "obsidian_vault",
    label: "Obsidian-compatible folder",
    description: "Write Markdown files into an Obsidian vault folder when available.",
  },
];

const safetyDefaults: Array<{
  id: ApprovalMode;
  label: string;
  impact: string;
}> = [
  {
    id: "review_changes",
    label: "Review changes",
    impact: "Raven can run familiar steps, but pauses when a workflow changes behavior.",
  },
  {
    id: "always_review",
    label: "Always review",
    impact: "Every run waits for approval before writing or taking external actions.",
  },
  {
    id: "auto_approve",
    label: "Auto approve",
    impact: "Ready workflows can run without review, so use it only for low-risk local tasks.",
  },
];

const templates: {
  workflow: RavenWorkflow;
  needs: string;
  requirementMet: (hasAnyProvider: boolean) => boolean;
}[] = [
  {
    workflow: dailyWorkJournalWorkflow,
    needs: "Local git context + AI provider",
    requirementMet: (hasAnyProvider) => hasAnyProvider,
  },
  {
    workflow: morningBriefWorkflow,
    needs: "Local git context + AI provider",
    requirementMet: (hasAnyProvider) => hasAnyProvider,
  },
  {
    workflow: currentWeatherWorkflow,
    needs: "AI provider with web access",
    requirementMet: (hasAnyProvider) => hasAnyProvider,
  },
];

function cloneWorkflow(workflow: RavenWorkflow): RavenWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as RavenWorkflow;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "first-raven-workflow";
}

function statusLabel(status?: string): string {
  switch (status) {
    case "available":
      return "Ready";
    case "degraded":
      return "Degraded";
    case "needs_config":
      return "Needs setup";
    case "unavailable":
      return "Unavailable";
    default:
      return "Optional";
  }
}

function providerStatusClass(status?: string): string {
  return status ?? "optional";
}

function applyWizardSelections(
  workflow: RavenWorkflow,
  profileId: string | undefined,
  destinationRef: ArtifactDestinationRef,
): RavenWorkflow {
  return {
    ...workflow,
    defaults: {
      ...workflow.defaults,
      llmProfileRef: profileId ?? workflow.defaults.llmProfileRef,
      destinationRef,
    },
    steps: workflow.steps.map((step) => ({
      ...step,
      llmProfileRef: step.llmProfileRef && profileId ? profileId : step.llmProfileRef,
      destinationRef: step.destinationRef ? destinationRef : step.destinationRef,
    })),
  };
}

function workflowFromPrompt(prompt: string): RavenWorkflow {
  const base = cloneWorkflow(dailyWorkJournalWorkflow);
  const trimmedPrompt = prompt.trim();
  const name = trimmedPrompt
    ? trimmedPrompt
        .split(/\s+/)
        .slice(0, 6)
        .join(" ")
        .replace(/^\w/, (char) => char.toUpperCase())
    : "First Raven Workflow";

  return {
    ...base,
    id: slugify(name),
    name,
    description: trimmedPrompt
      ? `Draft workflow based on: ${trimmedPrompt}`
      : "Draft local workflow created during setup.",
    schedule: { cadence: "manual" },
  };
}

function normalizeImportedWorkflowJson(input: unknown): RavenWorkflow {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const defaults = raw.defaults && typeof raw.defaults === "object"
    ? raw.defaults as Record<string, unknown>
    : {};
  const schedule = raw.schedule && typeof raw.schedule === "object"
    ? raw.schedule as Record<string, unknown>
    : undefined;
  const steps = Array.isArray(raw.steps) ? raw.steps : [];

  return {
    schemaVersion: String(raw.schemaVersion ?? raw.schema_version ?? "") as RavenWorkflow["schemaVersion"],
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    description: String(raw.description ?? ""),
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map(String) : [],
    defaults: {
      llmProfileRef: String(defaults.llmProfileRef ?? defaults.llm_profile_ref ?? ""),
      destinationRef: String(defaults.destinationRef ?? defaults.destination_ref ?? "") as ArtifactDestinationRef,
    },
    schedule: schedule
      ? {
          cadence: String(schedule.cadence ?? "manual") as NonNullable<RavenWorkflow["schedule"]>["cadence"],
          localTime: typeof schedule.localTime === "string"
            ? schedule.localTime
            : typeof schedule.local_time === "string"
              ? schedule.local_time
              : undefined,
        }
      : undefined,
    steps: steps.map((step) => {
      const rawStep = step && typeof step === "object" ? step as Record<string, unknown> : {};
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
        inputs: rawStep.inputs && typeof rawStep.inputs === "object"
          ? rawStep.inputs as Record<string, unknown>
          : {},
        llmProfileRef: typeof rawStep.llmProfileRef === "string"
          ? rawStep.llmProfileRef
          : typeof rawStep.llm_profile_ref === "string"
            ? rawStep.llm_profile_ref
            : undefined,
        destinationRef: typeof rawStep.destinationRef === "string"
          ? rawStep.destinationRef as ArtifactDestinationRef
          : typeof rawStep.destination_ref === "string"
            ? rawStep.destination_ref as ArtifactDestinationRef
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
}

function artifactTypeForWorkflow(workflowId: string): Artifact["type"] {
  if (workflowId === "current-weather") return "weather_report";
  if (workflowId === "morning-brief") return "morning_brief";
  if (workflowId === "daily-work-journal") return "daily_work_journal";
  return "plugin_artifact";
}

function createSimulatedSampleResult(workflow: WorkflowVersion): WorkflowRunResult {
  const createdAt = new Date().toISOString();
  const runId = `run-onboarding-simulated-${workflow.workflowId}`;
  return {
    duplicate: false,
    run: {
      id: runId,
      workflowId: workflow.workflowId,
      workflowName: workflow.definition.name,
      status: "succeeded",
      startedAt: createdAt,
      completedAt: createdAt,
      idempotencyKey: `onboarding-simulated:${workflow.workflowId}`,
      triggerKind: "onboarding_sample",
    },
    artifact: {
      id: `artifact-onboarding-simulated-${workflow.workflowId}`,
      title: `${workflow.definition.name} Sample`,
      type: artifactTypeForWorkflow(workflow.workflowId),
      workflowRunId: runId,
      contentMarkdown: `# ${workflow.definition.name} Sample\n\nThis is a local-only simulated artifact created during onboarding.\n\n## Next Action\nConfigure a ready provider to generate live output from this workflow.`,
      metadata: {
        schemaVersion: "0.1.0",
        workflowId: workflow.workflowId,
        workflowVersion: workflow.version,
        simulated: true,
        source: "onboarding",
      },
      sourceRefs: ["onboarding selections"],
      createdAt,
    },
  };
}

function workflowSignature(workflow: RavenWorkflow): string {
  return JSON.stringify({
    schemaVersion: workflow.schemaVersion,
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    permissions: workflow.permissions,
    defaults: workflow.defaults,
    schedule: workflow.schedule ?? null,
    steps: workflow.steps.map((step) => ({
      kind: step.kind,
      id: step.id,
      name: step.name,
      provider: step.provider,
      action: step.action,
      dependsOn: step.dependsOn,
      permissions: step.permissions,
      inputs: step.inputs,
      llmProfileRef: step.llmProfileRef ?? null,
      destinationRef: step.destinationRef ?? null,
      inlineCode: step.inlineCode ?? null,
      parallel: step.parallel ?? null,
    })),
  });
}

function loadFinishProgress(): FinishProgress | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(FINISH_PROGRESS_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FinishProgress;
  } catch {
    localStorage.removeItem(FINISH_PROGRESS_STORAGE_KEY);
    return null;
  }
}

function storeFinishProgress(progress: FinishProgress | null) {
  if (typeof window === "undefined") return;
  if (!progress) {
    localStorage.removeItem(FINISH_PROGRESS_STORAGE_KEY);
    return;
  }
  localStorage.setItem(FINISH_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
}

export function SetupWizard() {
  const { state, actions } = useAppState();
  const ui = useUI();
  const [step, setStep] = useState(0);
  const [ollamaReadiness, setOllamaReadiness] = useState<Record<string, { isReady: boolean; resolved: boolean }>>({});
  const [providerRefreshState, setProviderRefreshState] = useState<"idle" | "loading" | "ready">("idle");
  const [selectedTemplate, setSelectedTemplate] = useState<number | null>(null);
  const [workflowMode, setWorkflowMode] = useState<WorkflowChoiceMode>("template");
  const [workflowPrompt, setWorkflowPrompt] = useState("");
  const [workflowImportText, setWorkflowImportText] = useState("");
  const [workflowImportError, setWorkflowImportError] = useState("");
  const [nestWeaverDetection, setNestWeaverDetection] = useState<NestWeaverDetection | null | undefined>(undefined);
  const [detectedTools, setDetectedTools] = useState<Array<{ id: string; status: string }>>([]);
  const [selectedContexts, setSelectedContexts] = useState<Record<ContextSourceId, boolean>>({
    local_git: true,
    github: false,
    documents: false,
    chat_imports: false,
    nestweaver: false,
  });
  const [outputDestination, setOutputDestination] = useState<OutputDestinationId>("local_app");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("review_changes");
  const [providerSkipped, setProviderSkipped] = useState(false);
  const [runSample, setRunSample] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [finishNotice, setFinishNotice] = useState("");
  const [reviewPreflight, setReviewPreflight] = useState<PreflightManifest | null>(null);
  const [reviewPreflightLoading, setReviewPreflightLoading] = useState(false);
  const [reviewPreflightError, setReviewPreflightError] = useState("");
  const [sampleApprovalGranted, setSampleApprovalGranted] = useState(false);
  const providerRefreshRequestIdRef = useRef(0);
  const nestWeaverDetectionRequestIdRef = useRef(0);
  const reviewPreflightRequestIdRef = useRef(0);
  const finishProgressRef = useRef<{
    approvalMode?: ApprovalMode;
    installed: WorkflowVersion;
    runSample: boolean;
    sampleApplied: boolean;
    signature: string;
    status: WorkflowState;
    workflowId: string;
  } | null>(null);
  const hasLegacySetupMarker = typeof window !== "undefined" &&
    localStorage.getItem("hugin:setup-complete") === "true";

  useEffect(() => {
    void detectTools().then((tools) => {
      setDetectedTools(tools.map((t) => ({ id: t.id, status: t.status })));
    });
  }, []);

  const isToolAvailable = (toolId: string) =>
    detectedTools.some((t) => t.id === toolId && t.status === "available");

  const visibleContextSources = contextSources.filter((source) => {
    if (source.id === "github") return isToolAvailable("cli.gh");
    if (source.id === "nestweaver") return isToolAvailable("cli.nestweaver");
    return true;
  });

  const providerGroups = useMemo(
    () => groupProviderProfiles(state.agentAuthProfiles),
    [state.agentAuthProfiles],
  );
  const effectiveAgentAuthProfiles = useMemo(() => state.agentAuthProfiles.map((profile) => {
    if (profile.runnerKind !== "ollama_local") {
      return profile;
    }

    const liveReadiness = ollamaReadiness[profile.id];
    if (!liveReadiness?.resolved) {
      return {
        ...profile,
        status: "unavailable" as const,
        summary: "Checking whether Ollama is running.",
      };
    }

    if (!liveReadiness.isReady) {
      return {
        ...profile,
        status: "unavailable" as const,
        summary: "Ollama is not running. Start Ollama to use local AI.",
      };
    }

    return {
      ...profile,
      status: "available" as const,
      summary: "Ollama is running locally.",
    };
  }), [ollamaReadiness, state.agentAuthProfiles]);
  const effectiveProviderGroups = useMemo(
    () => groupProviderProfiles(effectiveAgentAuthProfiles),
    [effectiveAgentAuthProfiles],
  );
  const providerRefreshReady = providerRefreshState === "ready";
  const hasAnyProvider = providerRefreshReady && effectiveProviderGroups.some((g) => g.isReady);
  const availableProfile = providerRefreshReady
    ? effectiveProviderGroups.find((g) => g.isReady)?.primaryProfile
    : undefined;
  const selectedDestination = outputDestinations.find((destination) => destination.id === outputDestination) ??
    outputDestinations[0];
  const selectedOutputProvider = state.providers.find((provider) => provider.id === selectedDestination.id);
  const nestWeaverProvider = state.providers.find((provider) => provider.id === "nestweaver");
  const selectedOutputReady =
    selectedDestination.id === "local_app"
      ? selectedOutputProvider?.status !== "needs_config" && selectedOutputProvider?.status !== "unavailable"
      : selectedOutputProvider?.status === "available";
  const nestWeaverContextState = useMemo<NestWeaverContextState>(() => {
    if (nestWeaverProvider?.status === "available") {
      return {
        status: "available",
        detail: "Indexed project context ready.",
        selectable: true,
        keepLocalGitSelected: false,
      };
    }
    if (nestWeaverProvider?.status === "needs_config" || nestWeaverDetection) {
      return {
        status: "needs_config",
        detail: "Detected, needs project configuration.",
        selectable: false,
        keepLocalGitSelected: true,
      };
    }
    return {
      status: "unavailable",
      detail: "Unavailable on this machine.",
      selectable: false,
      keepLocalGitSelected: true,
    };
  }, [nestWeaverDetection, nestWeaverProvider?.status]);

  useEffect(() => {
    if (hasAnyProvider && providerSkipped) {
      setProviderSkipped(false);
    }
  }, [hasAnyProvider, providerSkipped]);

  useEffect(() => {
    if (step !== 1 || providerRefreshState !== "loading") return;

    const requestId = providerRefreshRequestIdRef.current;
    void (async () => {
      try {
        await actions.refreshState();
      } finally {
        if (providerRefreshRequestIdRef.current === requestId) {
          setProviderRefreshState("ready");
        }
      }
    })();
  }, [actions, providerRefreshState, step]);

  useEffect(() => {
    if (step !== 2) return;

    const requestId = nestWeaverDetectionRequestIdRef.current;
    void (async () => {
      const detection = await detectNestWeaver();
      if (nestWeaverDetectionRequestIdRef.current === requestId) {
        setNestWeaverDetection(detection);
      }
    })();
  }, [step]);

  useEffect(() => {
    if (nestWeaverContextState.selectable) return;
    setSelectedContexts((current) => (
      current.nestweaver
        ? {
            ...current,
            nestweaver: false,
          }
        : current
    ));
  }, [nestWeaverContextState.selectable]);

  const draftWorkflow = useMemo(() => {
    if (workflowMode === "describe") {
      if (!workflowPrompt.trim()) return null;
      return workflowFromPrompt(workflowPrompt);
    }
    if (workflowMode === "import") {
      if (!workflowImportText.trim()) return null;
      try {
        return normalizeImportedWorkflowJson(JSON.parse(workflowImportText));
      } catch {
        return null;
      }
    }
    if (selectedTemplate === null) return null;
    return cloneWorkflow(templates[selectedTemplate].workflow);
  }, [selectedTemplate, workflowImportText, workflowMode, workflowPrompt]);

  const selectedWorkflow = useMemo(() => {
    if (!draftWorkflow) return null;
    return applyWizardSelections(
      draftWorkflow,
      availableProfile?.id,
      selectedDestination.workflowRef,
    );
  }, [availableProfile?.id, draftWorkflow, selectedDestination.workflowRef]);

  const validation = useMemo(
    () => selectedWorkflow ? validateWorkflowDefinition(selectedWorkflow) : { valid: false, errors: [] },
    [selectedWorkflow],
  );

  const shouldSaveDraft = providerSkipped || !hasAnyProvider || !selectedOutputReady || !validation.valid;
  const selectedContextLabels = contextSources
    .filter((source) => selectedContexts[source.id])
    .map((source) => source.label);
  const finishProgressSignature = useMemo(() => {
    if (!selectedWorkflow) return null;
    return JSON.stringify({
      workflow: workflowSignature(selectedWorkflow),
      status: shouldSaveDraft ? "draft" : "enabled",
      approvalMode,
      runSample,
    });
  }, [approvalMode, runSample, selectedWorkflow, shouldSaveDraft]);
  const reviewApprovalSignature = useMemo(() => {
    if (!selectedWorkflow) return null;
    return JSON.stringify({
      workflow: workflowSignature(selectedWorkflow),
      status: shouldSaveDraft ? "draft" : "enabled",
      approvalMode,
      autonomyMode: state.autonomyMode,
      categoryOverrides: state.autonomyCategoryOverrides,
    });
  }, [
    approvalMode,
    selectedWorkflow,
    shouldSaveDraft,
    state.autonomyCategoryOverrides,
    state.autonomyMode,
  ]);

  useEffect(() => {
    const persisted = loadFinishProgress();
    if (
      persisted &&
      finishProgressSignature &&
      persisted.signature === finishProgressSignature
    ) {
      finishProgressRef.current = persisted;
      return;
    }
    finishProgressRef.current = null;
  }, [finishProgressSignature]);

  useEffect(() => {
    setSampleApprovalGranted(false);
  }, [reviewApprovalSignature]);

  useEffect(() => {
    if (step !== 6 || !selectedWorkflow || shouldSaveDraft) {
      reviewPreflightRequestIdRef.current += 1;
      setReviewPreflight(null);
      setReviewPreflightLoading(false);
      setReviewPreflightError("");
      return;
    }

    const requestId = ++reviewPreflightRequestIdRef.current;
    setReviewPreflightLoading(true);
    setReviewPreflightError("");
    setReviewPreflight(null);
    void evaluateWorkflowDefinitionPreflight(
      selectedWorkflow,
      1,
      state.autonomyMode,
      state.autonomyCategoryOverrides,
    ).then((manifest) => {
      if (reviewPreflightRequestIdRef.current !== requestId) return;
      setReviewPreflight(manifest);
    }).catch(() => {
      if (reviewPreflightRequestIdRef.current !== requestId) return;
      setReviewPreflightError("Raven could not verify live sample safety yet. Save the workflow first, then review run readiness from Command Center.");
    }).finally(() => {
      if (reviewPreflightRequestIdRef.current === requestId) {
        setReviewPreflightLoading(false);
      }
    });
  }, [
    selectedWorkflow,
    shouldSaveDraft,
    state.autonomyCategoryOverrides,
    state.autonomyMode,
    step,
  ]);

  const reviewGrantDrafts = useMemo(() => {
    if (!reviewPreflight || !selectedWorkflow) return [];
    return buildPreflightApprovalGrants(reviewPreflight, {
      workflowId: selectedWorkflow.id,
      workflowVersion: reviewPreflight.workflowVersion,
      approvedAt: "2026-06-23T00:00:00.000Z",
      idFactory: (() => {
        let counter = 0;
        return () => `onboarding-preflight-${++counter}`;
      })(),
    });
  }, [reviewPreflight, selectedWorkflow]);

  const reviewReadiness = useMemo<ReviewReadiness>(() => {
    if (!selectedWorkflow || shouldSaveDraft) {
      return { kind: "simulated_preview" };
    }
    if (reviewPreflightLoading) return { kind: "loading" };
    if (reviewPreflightError) return { kind: "error", message: reviewPreflightError };
    if (!reviewPreflight) return { kind: "loading" };
    if (reviewPreflight.blockingItems.length > 0) {
      return {
        kind: "blocked",
        manifest: reviewPreflight,
        reason: reviewPreflight.blockingItems[0]?.reason ?? "Blocking items need to be resolved before a live sample can run.",
      };
    }
    if (reviewGrantDrafts.length > 0) {
      return { kind: "approval_required", manifest: reviewPreflight };
    }
    return { kind: "live_ready", manifest: reviewPreflight };
  }, [
    reviewGrantDrafts.length,
    reviewPreflight,
    reviewPreflightError,
    reviewPreflightLoading,
    selectedWorkflow,
    shouldSaveDraft,
  ]);

  const handleConfigureKey = (profileId: string, apiKey: string) => {
    void actions.configureProviderCredential(profileId, apiKey);
  };

  const handleOllamaReadinessChange = (profileId: string, readiness: { isReady: boolean; resolved: boolean }) => {
    setOllamaReadiness((current) => {
      const previous = current[profileId];
      if (
        previous &&
        previous.isReady === readiness.isReady &&
        previous.resolved === readiness.resolved
      ) {
        return current;
      }
      return {
        ...current,
        [profileId]: readiness,
      };
    });
  };

  const navigateToStep = (nextStep: number) => {
    if (nextStep === 1 && step !== 1) {
      providerRefreshRequestIdRef.current += 1;
      setOllamaReadiness({});
      setProviderRefreshState("loading");
    }
    if (nextStep === 2 && step !== 2) {
      nestWeaverDetectionRequestIdRef.current += 1;
      setNestWeaverDetection(undefined);
    }
    setStep(nextStep);
  };

  const goNext = () => navigateToStep(Math.min(step + 1, WIZARD_STEPS.length - 1));
  const goBack = () => navigateToStep(Math.max(step - 1, 0));
  const skipCurrent = () => {
    if (step === 1) setProviderSkipped(true);
    if (step === 5) {
      setSelectedTemplate(null);
      setWorkflowPrompt("");
      setWorkflowImportText("");
      setWorkflowImportError("");
    }
    goNext();
  };

  const completeWithoutWorkflow = async () => {
    setFinishNotice("");
    const result = await actions.completeSetup({ skipped: true, postOnboardingLandingPending: true });
    if (!result.ok) {
      setFinishNotice(result.message);
      return;
    }
    storeFinishProgress(null);
    ui.openCommandCenterTarget("overview");
  };

  const migratePreviousSetup = async () => {
    setFinishNotice("");
    const result = await actions.completeSetup({ migratedLegacy: true });
    if (!result.ok) {
      setFinishNotice(result.message);
      return;
    }
    storeFinishProgress(null);
    ui.openCommandCenterTarget("overview");
  };

  const continueFromWorkflowStep = () => {
    if (workflowMode === "import") {
      try {
        normalizeImportedWorkflowJson(JSON.parse(workflowImportText));
        setWorkflowImportError("");
      } catch {
        setWorkflowImportError("Workflow JSON could not be parsed.");
        return;
      }
    }
    goNext();
  };

  const handleFinish = async () => {
    if (!selectedWorkflow) {
      await completeWithoutWorkflow();
      return;
    }

    setIsFinishing(true);
    setFinishNotice("");
    const status = shouldSaveDraft ? "draft" : "enabled";
    const signature = finishProgressSignature;
    if (!signature) {
      setIsFinishing(false);
      setFinishNotice("Workflow could not be saved. Please try again.");
      return;
    }
    let progress = finishProgressRef.current;

    if (
      !progress ||
      progress.signature !== signature
    ) {
      const installed = await actions.installWorkflowTemplate(selectedWorkflow, status, approvalMode);
      if (!installed) {
        setIsFinishing(false);
        setFinishNotice("Workflow could not be saved. Please try again.");
        return;
      }
      progress = {
        workflowId: selectedWorkflow.id,
        status,
        approvalMode,
        runSample,
        signature,
        installed,
        sampleApplied: false,
      };
      finishProgressRef.current = progress;
      storeFinishProgress(progress);
    }
    if (!progress) {
      setIsFinishing(false);
      setFinishNotice("Workflow could not be saved. Please try again.");
      return;
    }

    if (runSample && !progress.sampleApplied) {
      if (reviewReadiness.kind === "simulated_preview") {
        actions.applyRunResults([createSimulatedSampleResult(progress.installed)]);
        actions.pushToast({
          level: "info",
          message: "Simulated preview artifact created locally. Enable the workflow after setup for live runs.",
        });
        progress.sampleApplied = true;
        storeFinishProgress(progress);
      } else if (reviewReadiness.kind === "live_ready") {
        await actions.runWorkflow(progress.installed.workflowId, progress.installed);
        progress.sampleApplied = true;
        storeFinishProgress(progress);
      } else if (reviewReadiness.kind === "approval_required") {
        if (!sampleApprovalGranted) {
          actions.pushToast({
            level: "info",
            message: "Workflow saved without a live sample. Approve required access before Raven runs it.",
          });
        } else {
          const grantResults = await Promise.all(
            buildPreflightApprovalGrants(reviewReadiness.manifest, {
              workflowId: progress.installed.workflowId,
              workflowVersion: progress.installed.version,
            }).map((grant) => resolveApprovalGrantResult(actions.createApprovalGrant(grant))),
          );
          if (grantResults.some((result) => !result.ok)) {
            actions.pushToast({
              level: "warning",
              message: "Raven could not create every required approval grant for the live sample.",
            });
          } else {
            let baselineRecorded = true;
            if (progress.installed.approvalMode === "review_changes") {
              try {
                await approveWorkflowSignatureBaseline(
                  progress.installed.workflowId,
                  progress.installed.version,
                );
              } catch {
                baselineRecorded = false;
                actions.pushToast({
                  level: "warning",
                  message: "Raven could not record the workflow review baseline for the live sample.",
                });
              }
            }
            if (baselineRecorded) {
              await actions.runWorkflow(progress.installed.workflowId, progress.installed);
              progress.sampleApplied = true;
              storeFinishProgress(progress);
            }
          }
        }
      } else if (reviewReadiness.kind === "blocked") {
        actions.pushToast({
          level: "warning",
          message: `Workflow saved without a live sample. ${reviewReadiness.reason}`,
        });
      } else if (reviewReadiness.kind === "error") {
        actions.pushToast({
          level: "warning",
          message: reviewReadiness.message,
        });
      } else {
        actions.pushToast({
          level: "info",
          message: "Workflow saved while Raven finishes checking live sample readiness.",
        });
      }
    }
    setIsFinishing(false);
    const completion = await actions.completeSetup({ postOnboardingLandingPending: true });
    if (!completion.ok) {
      setFinishNotice(completion.message);
      return;
    }
    finishProgressRef.current = null;
    storeFinishProgress(null);
    ui.openCommandCenterTarget("overview");
  };

  const sampleOptionLabel = !selectedWorkflow
    ? ""
    : reviewReadiness.kind === "simulated_preview"
      ? "Create a simulated preview artifact after saving draft"
      : reviewReadiness.kind === "approval_required" && !sampleApprovalGranted
        ? "Run a sample after saving once required access is approved"
        : reviewReadiness.kind === "blocked"
          ? "Live sample unavailable until blocking items are resolved"
          : "Run a sample after saving";
  const sampleOptionDetail = reviewReadiness.kind === "simulated_preview"
    ? "Local-only preview; live runs stay unavailable until setup is complete."
    : reviewReadiness.kind === "approval_required" && !sampleApprovalGranted
      ? "Raven will save the workflow now, and it will only run a live sample after you approve the required access."
      : reviewReadiness.kind === "approval_required"
        ? "Raven will create the required grants first, then run the saved workflow."
        : reviewReadiness.kind === "blocked"
          ? "Resolve blocking preflight items first."
          : reviewReadiness.kind === "error"
            ? reviewReadiness.message
            : reviewReadiness.kind === "loading"
              ? "Checking live sample safety."
              : "Uses the saved workflow. If the backend is unavailable, Raven leaves the run notice visible.";
  const sampleOptionDisabled = reviewReadiness.kind === "blocked" ||
    reviewReadiness.kind === "error" ||
    reviewReadiness.kind === "loading";

  return (
    <div className="setup-wizard">
      <div className="wizard-card">
        <nav className="wizard-steps" aria-label="Setup progress">
          {WIZARD_STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              className={`wizard-step-marker${index === step ? " active" : ""}${index < step ? " complete" : ""}`}
              onClick={() => {
                if (index <= step) navigateToStep(index);
              }}
              disabled={index > step}
              aria-current={index === step ? "step" : undefined}
              aria-label={label}
            >
              <span className="wizard-step-number">{index + 1}</span>
              <span className="wizard-step-label">{label}</span>
            </button>
          ))}
        </nav>

        {step === 0 && (
          <div className="wizard-step-content wizard-welcome">
            <img src={ravenMark} alt="Raven" className="wizard-logo" />
            <h1>Welcome to Raven</h1>
            <p>Set up a local command center for useful workflows, visible context, safe approvals, and traceable output.</p>
            <div className="wizard-step-actions">
              <button className="primary-action" type="button" onClick={goNext}>
                Get started
                <ArrowRight size={16} />
              </button>
              <button type="button" onClick={() => void completeWithoutWorkflow()}>
                I know what I&apos;m doing
              </button>
              <button type="button" onClick={() => void completeWithoutWorkflow()}>
                Skip setup
              </button>
            </div>
            {finishNotice && <small className="wizard-skip-note">{finishNotice}</small>}
            {hasLegacySetupMarker && (
              <div className="wizard-migration-card" role="status">
                <FileJson size={16} aria-hidden="true" />
                <span>
                  <strong>Previous app setup found</strong>
                  <small>Use existing local app data and continue in Raven.</small>
                </span>
                <button type="button" onClick={() => void migratePreviousSetup()}>
                  Use existing data
                </button>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="wizard-step-content">
            <h2>Connect AI provider</h2>
            <p>Provider readiness controls whether your first workflow can be enabled now or saved as a draft.</p>
            <div className="wizard-provider-groups">
              {providerRefreshState === "loading" ? (
                <div className="provider-group-card" role="status" aria-live="polite">
                  <div className="provider-group-header">
                    <div>
                      <h3>Refreshing provider readiness…</h3>
                      <p>Checking local CLI and Ollama status before showing provider cards.</p>
                    </div>
                  </div>
                </div>
              ) : (
                providerGroups.map((group) => (
                  <ProviderGroupCard
                    key={group.groupName}
                    group={group}
                    onConfigureKey={handleConfigureKey}
                    onOllamaReadinessChange={handleOllamaReadinessChange}
                  />
                ))
              )}
            </div>
            {providerSkipped && (
              <small className="wizard-skip-note">
                Provider skipped. Your first workflow will be saved as a draft.
              </small>
            )}
            <div className="wizard-step-actions">
              <button type="button" onClick={goBack}>
                <ArrowLeft size={16} />
                Back
              </button>
              <button
                className={hasAnyProvider ? "primary-action" : undefined}
                type="button"
                onClick={goNext}
                disabled={providerRefreshState === "loading"}
              >
                Continue
                {hasAnyProvider && <ArrowRight size={16} />}
              </button>
              <button type="button" onClick={skipCurrent} disabled={providerRefreshState === "loading"}>
                Skip
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-step-content">
            <h2>Choose context sources</h2>
            <p>Local git is ready by default. Optional sources can be connected later without blocking setup.</p>
            <div className="wizard-option-list">
              {visibleContextSources.map((source) => {
                const provider = state.providers.find((item) => item.id === source.providerId);
                const checked = selectedContexts[source.id];
                const isNestWeaver = source.id === "nestweaver";
                const disabled = source.required || (isNestWeaver && !nestWeaverContextState.selectable);
                const status = isNestWeaver ? nestWeaverContextState.status : provider?.status;
                const detail = isNestWeaver ? nestWeaverContextState.detail : null;
                return (
                  <label key={source.id} className="wizard-option-card">
                    <input
                      type="checkbox"
                      aria-label={source.label}
                      checked={checked}
                      disabled={disabled}
                      onChange={(event) => {
                        const isChecked = event.currentTarget.checked;
                        setSelectedContexts((current) => ({
                          ...current,
                          [source.id]: isChecked,
                        }));
                      }}
                    />
                    <span>
                      <strong>{source.label}</strong>
                      <small>{source.description}</small>
                      {detail && <small>{detail}</small>}
                      {isNestWeaver && nestWeaverContextState.keepLocalGitSelected && (
                        <small>Local Git stays selected until NestWeaver is ready.</small>
                      )}
                    </span>
                    <em className={`readiness-pill readiness-pill-${providerStatusClass(status)}`}>
                      {source.required ? "Ready" : statusLabel(status)}
                    </em>
                  </label>
                );
              })}
            </div>
            <div className="wizard-step-actions">
              <button type="button" onClick={goBack}>
                <ArrowLeft size={16} />
                Back
              </button>
              <button className="primary-action" type="button" onClick={goNext}>
                Continue
                <ArrowRight size={16} />
              </button>
              <button type="button" onClick={skipCurrent}>
                Skip
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="wizard-step-content">
            <h2>Choose output destination</h2>
            <p>Raven can keep artifacts in the local app now and write Markdown or Obsidian-compatible files when configured.</p>
            <div className="wizard-option-list">
              {outputDestinations.map((destination) => {
                const provider = state.providers.find((item) => item.id === destination.id);
                return (
                  <label key={destination.id} className="wizard-option-card">
                    <input
                      type="radio"
                      aria-label={destination.label}
                      name="output-destination"
                      checked={outputDestination === destination.id}
                      onChange={() => setOutputDestination(destination.id)}
                    />
                    <span>
                      <strong>{destination.label}</strong>
                      <small>{destination.description}</small>
                    </span>
                    <em className={`readiness-pill readiness-pill-${providerStatusClass(provider?.status)}`}>
                      {destination.id === "local_app" ? "Ready" : statusLabel(provider?.status)}
                    </em>
                  </label>
                );
              })}
            </div>
            <div className="wizard-step-actions">
              <button type="button" onClick={goBack}>
                <ArrowLeft size={16} />
                Back
              </button>
              <button className="primary-action" type="button" onClick={goNext}>
                Continue
                <ArrowRight size={16} />
              </button>
              <button type="button" onClick={skipCurrent}>
                Skip
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="wizard-step-content">
            <h2>Set safety defaults</h2>
            <p>Choose how much approval Raven should ask for before workflows write artifacts or run changed steps.</p>
            <div className="wizard-option-list">
              {safetyDefaults.map((option) => (
                <label key={option.id} className="wizard-option-card">
                  <input
                    type="radio"
                    aria-label={option.label}
                    name="approval-mode"
                    checked={approvalMode === option.id}
                    onChange={() => setApprovalMode(option.id)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.impact}</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="wizard-step-actions">
              <button type="button" onClick={goBack}>
                <ArrowLeft size={16} />
                Back
              </button>
              <button className="primary-action" type="button" onClick={goNext}>
                Continue
                <ArrowRight size={16} />
              </button>
              <button type="button" onClick={skipCurrent}>
                Skip
              </button>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="wizard-step-content">
            <h2>Choose/create first workflow</h2>
            <p>Start from a template or describe a first workflow so Raven can save a reviewable local draft.</p>
            <div className="wizard-segmented" role="group" aria-label="Workflow creation mode">
              <button
                type="button"
                className={workflowMode === "template" ? "active" : undefined}
                aria-pressed={workflowMode === "template"}
                onClick={() => setWorkflowMode("template")}
              >
                Templates
              </button>
              <button
                type="button"
                className={workflowMode === "describe" ? "active" : undefined}
                aria-pressed={workflowMode === "describe"}
                onClick={() => setWorkflowMode("describe")}
              >
                Describe with Raven
              </button>
              <button
                type="button"
                className={workflowMode === "import" ? "active" : undefined}
                aria-pressed={workflowMode === "import"}
                onClick={() => setWorkflowMode("import")}
              >
                Import workflow
              </button>
            </div>
            {workflowMode === "template" ? (
              <div className="wizard-templates">
                {templates.map((template, index) => {
                  const met = template.requirementMet(hasAnyProvider);
                  return (
                    <button
                      key={template.workflow.id}
                      type="button"
                      aria-label={`Use template ${template.workflow.name}`}
                      className={`wizard-template-card${selectedTemplate === index ? " selected" : ""}`}
                      onClick={() => setSelectedTemplate(index)}
                      aria-pressed={selectedTemplate === index}
                    >
                      <strong>{template.workflow.name}</strong>
                      <small>{template.workflow.description}</small>
                      <div className="wizard-template-meta">
                        <span>{formatSchedule(template.workflow.schedule)}</span>
                        <span className="wizard-template-needs">
                          {met ? (
                            <Check size={12} className="needs-met" aria-label="Requirement met" />
                          ) : (
                            <X size={12} className="needs-unmet" aria-label="Requirement not met" />
                          )}
                          {template.needs}
                        </span>
                      </div>
                      <span className="wizard-template-action">Use template {template.workflow.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : workflowMode === "describe" ? (
              <label className="wizard-prompt-field">
                <span>Describe the workflow</span>
                <textarea
                  value={workflowPrompt}
                  onChange={(event) => setWorkflowPrompt(event.currentTarget.value)}
                  placeholder="Summarize my project activity every Friday afternoon."
                />
              </label>
            ) : (
              <label className="wizard-prompt-field">
                <span>Workflow JSON</span>
                <textarea
                  aria-label="Workflow JSON"
                  value={workflowImportText}
                  onChange={(event) => {
                    setWorkflowImportText(event.currentTarget.value);
                    setWorkflowImportError("");
                  }}
                  placeholder='{"schema_version":"0.1.0","id":"weekly-summary","name":"Weekly Summary",...}'
                />
                <small className="wizard-skip-note">
                  Imports are validated locally. Unsupported or incomplete workflows are saved as drafts.
                </small>
                {workflowImportError && (
                  <small className="wizard-error-note" role="alert">{workflowImportError}</small>
                )}
              </label>
            )}
            <div className="wizard-step-actions">
              <button type="button" onClick={goBack}>
                <ArrowLeft size={16} />
                Back
              </button>
              <button
                className="primary-action"
                type="button"
                disabled={!selectedWorkflow}
                onClick={continueFromWorkflowStep}
              >
                Continue
                <ArrowRight size={16} />
              </button>
              <button type="button" onClick={skipCurrent}>
                Skip
              </button>
            </div>
          </div>
        )}

        {step === 6 && (
          <div className="wizard-step-content">
            <h2>Review and optionally run sample</h2>
            <p>Confirm readiness before Raven opens Command Center with your next action visible.</p>
            <dl className="wizard-review-summary">
              <div>
                <dt>Provider</dt>
                <dd>{hasAnyProvider ? `${availableProfile?.displayName ?? "Provider"} ready` : "No provider ready"}</dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>{selectedContextLabels.join(", ") || "Local git"}</dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>{selectedDestination.label}</dd>
              </div>
              <div>
                <dt>Safety</dt>
                <dd>{safetyDefaults.find((option) => option.id === approvalMode)?.label}</dd>
              </div>
              <div>
                <dt>Workflow</dt>
                <dd>
                  {selectedWorkflow?.name ?? "No first workflow selected"}
                  {selectedWorkflow && workflowMode === "import" ? " · imported JSON" : ""}
                </dd>
              </div>
              <div>
                <dt>Next action</dt>
                <dd>
                  {selectedWorkflow
                    ? shouldSaveDraft
                      ? "Save draft and open Command Center"
                      : "Create enabled workflow and open Command Center"
                    : "Open Command Center"}
                </dd>
              </div>
            </dl>
            {selectedWorkflow && !validation.valid && (
              <div className="wizard-validation" role="status">
                <strong>Workflow will be saved as a draft.</strong>
                <ul>
                  {validation.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            )}
            {selectedWorkflow && (providerSkipped || !hasAnyProvider) && (
              <small className="wizard-skip-note">
                No provider is ready, so Raven will not create an enabled workflow accidentally.
              </small>
            )}
            {selectedWorkflow && !selectedOutputReady && (
              <small className="wizard-skip-note">
                Selected output is not ready, so Raven will save this workflow as a draft.
              </small>
            )}
            {selectedWorkflow && reviewReadiness.kind === "simulated_preview" && (
              <div className="wizard-validation" role="status">
                <strong>Simulated preview only.</strong>
                <p>Raven will save a draft and create a local preview artifact.</p>
              </div>
            )}
            {selectedWorkflow && reviewReadiness.kind === "loading" && (
              <small className="wizard-skip-note">Checking live sample safety.</small>
            )}
            {selectedWorkflow && reviewReadiness.kind === "live_ready" && (
              <small className="wizard-skip-note">
                Live sample ready. Raven can run the saved workflow after setup.
              </small>
            )}
            {selectedWorkflow && reviewReadiness.kind === "approval_required" && (
              <div className="wizard-validation" role="status">
                <strong>Approval required before Raven can run a live sample.</strong>
                <p>Approve the detected access first, then Raven can create grants and run the saved workflow.</p>
                <button
                  type="button"
                  onClick={() => setSampleApprovalGranted(true)}
                  disabled={sampleApprovalGranted}
                >
                  {sampleApprovalGranted
                    ? "Required access approved for this sample"
                    : "Approve required access for a live sample"}
                </button>
              </div>
            )}
            {selectedWorkflow && reviewReadiness.kind === "blocked" && (
              <div className="wizard-validation" role="status">
                <strong>Live sample blocked by current safety checks.</strong>
                <p>{reviewReadiness.reason}</p>
              </div>
            )}
            {selectedWorkflow && reviewReadiness.kind === "error" && (
              <div className="wizard-validation" role="status">
                <strong>Live sample safety check unavailable.</strong>
                <p>{reviewReadiness.message}</p>
              </div>
            )}
            {selectedWorkflow && (
              <label className="wizard-run-sample">
                <input
                  aria-label="Run a sample after saving"
                  type="checkbox"
                  checked={runSample}
                  disabled={sampleOptionDisabled}
                  onChange={(event) => setRunSample(event.currentTarget.checked)}
                />
                {sampleOptionLabel}
                <small>
                  {sampleOptionDetail}
                </small>
              </label>
            )}
            <div className="wizard-step-actions">
              <button type="button" onClick={goBack}>
                <ArrowLeft size={16} />
                Back
              </button>
              <button
                className="primary-action"
                type="button"
                disabled={isFinishing}
                onClick={() => void handleFinish()}
              >
                {isFinishing ? "Saving..." : "Finish setup"}
                {!isFinishing && <Sparkles size={16} />}
              </button>
              <button type="button" onClick={() => void completeWithoutWorkflow()}>
                Skip
              </button>
            </div>
            {finishNotice && <small className="wizard-skip-note">{finishNotice}</small>}
          </div>
        )}
      </div>
    </div>
  );
}
