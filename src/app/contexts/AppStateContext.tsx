import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  currentWeatherWorkflow,
  dailyWorkJournalWorkflow,
  morningBriefWorkflow,
} from "../../domain/workflow";
import type {
  AppState,
  AgentAuthProfile,
  ApprovalMode,
  ApprovalGrantDraft,
  AutonomyMode,
  Artifact,
  CapabilityRegistrySnapshot,
  PlannerRationale,
  ProviderAccount,
  RavenWorkflow,
  Toast,
  WorkflowRunResult,
  WorkflowState,
  WorkflowVersion,
} from "../../domain/types";
import {
  archivePersistedWorkflow,
  assignPersistedScheduleOverride,
  checkPersistedProviderReadiness,
  configurePersistedArtifactDestination,
  configurePersistedAiChatImportFolder,
  configurePersistedDocumentImportFolder,
  configurePersistedGithubContext,
  configurePersistedNestWeaver,
  configurePersistedProviderAccount,
  exportPersistedArtifact,
  generatePersistedArtifactPreview,
  getSavedSettings,
  indexPersistedNestWeaverProject,
  installPersistedWorkflowTemplate,
  loadPersistedAppState,
  loadPersistedSchedulerStatus,
  regeneratePersistedArtifact,
  retryPersistedWorkflowRun,
  runPersistedDueSchedules,
  runPersistedWorkflow,
  scanPersistedAiChatImportFolder,
  scanPersistedDocumentImportFolder,
  scanPersistedGithubContext,
  setPersistedAutonomyCategoryOverrides,
  setPersistedBuilderProfile,
  setPersistedAutonomyMode,
  startPersistedScheduler,
  stopPersistedScheduler,
  updatePersistedWorkflowSafeFields,
  availableCapabilityCatalog,
  createApprovalGrant as createPersistedApprovalGrant,
  completeOnboarding,
  detectTools,
  listApprovalGrants,
  revokeApprovalGrant as revokePersistedApprovalGrant,
} from "../tauriBridge";
import {
  chooseAiChatImportFolder,
  chooseArtifactDestinationFolder,
  choosePdfDocumentImportFolder,
  notifyWorkflowRunCompleted,
  notifyWorkflowRunFailed,
} from "../nativeIntegrations";

const now = () => new Date().toISOString();

function emptyCapabilityRegistry(): CapabilityRegistrySnapshot {
  return {
    hash: "",
    generatedAt: now(),
    capabilities: [],
  };
}

function isAutonomyMode(value: unknown): value is AutonomyMode {
  return value === "ask_first" ||
    value === "safe_auto" ||
    value === "workspace_auto" ||
    value === "power_auto";
}

function autonomyModeFromSettings(settings: Record<string, unknown> | null): AutonomyMode | null {
  const value = settings?.autonomy_mode ?? settings?.autonomyMode;
  return isAutonomyMode(value) ? value : null;
}

function autonomyCategoryOverridesFromSettings(settings: Record<string, unknown> | null): Record<string, AutonomyMode> {
  const value = settings?.autonomy_category_overrides ?? settings?.autonomyCategoryOverrides;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, AutonomyMode] => isAutonomyMode(entry[1])),
  );
}

function localScheduleWindow(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type ArtifactDestinationId = "local_app" | "markdown_folder" | "obsidian_vault";
type WorkflowCadence = NonNullable<RavenWorkflow["schedule"]>["cadence"];
export type WorkflowSafeFields = {
  status: WorkflowState;
  cadence: WorkflowCadence;
  localTime?: string;
  approvalMode?: ApprovalMode;
  llmProfileRef?: string;
};
export interface RunDueSchedulesOptions {
  scheduleWindow?: string;
  workflowIds?: string[];
}

const artifactDestinationLabels: Record<ArtifactDestinationId, string> = {
  local_app: "Local App Store",
  markdown_folder: "Markdown Folder",
  obsidian_vault: "Obsidian Vault",
};

function versionFromWorkflow(
  definition: WorkflowVersion["definition"],
  version: number,
  status: WorkflowVersion["status"],
): WorkflowVersion {
  return {
    id: `${definition.id}-v${version}`,
    workflowId: definition.id,
    version,
    status,
    approvalMode: "always_review",
    definition,
    createdAt: now(),
  };
}

export const initialState: AppState = {
  theme: "aurora-dark",
  autonomyMode: "safe_auto",
  autonomyCategoryOverrides: {},
  capabilityRegistry: emptyCapabilityRegistry(),
  rawToolInventory: [],
  approvalGrants: [],
  workflows: [
    versionFromWorkflow(dailyWorkJournalWorkflow, 1, "enabled"),
    versionFromWorkflow(morningBriefWorkflow, 1, "draft"),
    versionFromWorkflow(currentWeatherWorkflow, 1, "enabled"),
  ],
  runs: [
    {
      id: "run-seed-1",
      workflowId: "daily-work-journal",
      workflowName: "Daily Work Journal",
      status: "succeeded",
      startedAt: now(),
      completedAt: now(),
      idempotencyKey: "seed:daily-work-journal",
    },
  ],
  artifacts: [
    {
      id: "artifact-seed-1",
      title: "Daily Work Journal",
      type: "daily_work_journal",
      workflowRunId: "run-seed-1",
      contentMarkdown:
        "# Daily Work Journal\n\n## Progress\n- Reviewed recent project activity from local git context.\n- Generated summary artifact with structured metadata.\n\n## Next Focus\n- Configure additional context sources for richer output.",
      metadata: {
        schemaVersion: "0.1.0",
        template: "daily_work_journal",
        generatedBy: "local-preview",
      },
      sourceRefs: ["local git context"],
      createdAt: now(),
    },
  ],
  scheduleOverrides: [],
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      kind: "llm",
      status: "needs_config",
      summary: "API key reference required before live generation.",
    },
    {
      id: "local_git",
      name: "Local Git",
      kind: "context",
      status: "available",
      summary: "Reads recent commits and changed files from the current project.",
    },
    {
      id: "nestweaver",
      name: "NestWeaver",
      kind: "context",
      status: "unavailable",
      summary: "NestWeaver is not connected. Raven will use Local Git context until it is configured.",
      fallbackProviderId: "local_git",
    },
    {
      id: "local_app",
      name: "Local App Store",
      kind: "artifact_destination",
      status: "available",
      summary: "Stores Markdown plus JSON metadata in local app storage.",
    },
    {
      id: "markdown_folder",
      name: "Markdown Folder",
      kind: "artifact_destination",
      status: "needs_config",
      summary: "Writes Markdown artifacts to a configured local folder.",
      fallbackProviderId: "local_app",
    },
    {
      id: "obsidian_vault",
      name: "Obsidian Vault",
      kind: "artifact_destination",
      status: "needs_config",
      summary: "Writes Markdown artifacts into a configured Obsidian vault folder.",
      fallbackProviderId: "markdown_folder",
    },
    {
      id: "ai_chat_import",
      name: "AI Chat Import Folder",
      kind: "context",
      status: "needs_config",
      summary: "Imports supported local AI chat exports from a configured folder.",
      fallbackProviderId: "local_git",
    },
    {
      id: "document_import",
      name: "PDF Document Import Folder",
      kind: "context",
      status: "needs_config",
      summary: "Imports digital PDF text and OCRs scanned PDFs when local tools are installed.",
      fallbackProviderId: "local_git",
    },
    {
      id: "github",
      name: "GitHub",
      kind: "context",
      status: "needs_config",
      summary: "Reads pull request and issue context after repo and token configuration.",
      fallbackProviderId: "local_git",
    },
  ],
  llmProfiles: [
    {
      id: "default-openai",
      providerId: "openai",
      model: "gpt-4.1",
      effort: "medium",
      supportsStructuredOutputs: true,
    },
  ],
  agentAuthProfiles: [
    {
      id: "codex-oauth-local",
      displayName: "Codex (local)",
      runnerKind: "codex_cli",
      authMode: "codex_oauth_local_cli",
      credentialRef: "codex:oauth:local-cli",
      model: "gpt-5.4",
      effort: "medium",
      status: "available",
      summary: "Runs codex exec through your local Codex CLI session.",
    },
    {
      id: "claude-code-oauth-local",
      displayName: "Claude Code (local)",
      runnerKind: "claude_code_cli",
      authMode: "claude_code_oauth_local_cli",
      credentialRef: "claude-code:oauth:local-cli",
      model: "sonnet",
      effort: "medium",
      status: "available",
      summary:
        "Runs claude --print through your local Claude Code session and suppresses API-key env vars for this mode.",
    },
    {
      id: "openai-api-key",
      displayName: "OpenAI",
      runnerKind: "openai_api",
      authMode: "api_key_env",
      credentialRef: "env:OPENAI_API_KEY",
      model: "gpt-4.1",
      effort: "medium",
      status: "needs_config",
      summary: "Uses an environment or keychain reference for direct OpenAI API-backed agent work.",
    },
    {
      id: "anthropic-api-key",
      displayName: "Anthropic",
      runnerKind: "anthropic_api",
      authMode: "api_key_env",
      credentialRef: "env:ANTHROPIC_API_KEY",
      model: "claude-sonnet-4-5",
      effort: "medium",
      status: "needs_config",
      summary:
        "Uses an environment or keychain reference for direct Anthropic API-backed agent work.",
    },
    {
      id: "ollama-local",
      displayName: "Ollama (local)",
      runnerKind: "ollama_local",
      authMode: "none",
      credentialRef: "",
      model: "llama3.1:8b",
      effort: "medium",
      status: "needs_config",
      summary: "Local AI via Ollama. No API key required.",
    },
  ],
  chatMessages: [
    {
      id: "chat-seed-system",
      role: "system",
      content: "Raven Builder helps draft validated workflow definitions before anything is approved.",
      createdAt: now(),
    },
  ],
};

function runResultNotice(result: WorkflowRunResult, successFallback = "Run completed") {
  if (result.duplicate) return "Run already completed for this window";
  if (result.run.status === "blocked") {
    return `Run blocked: ${result.run.setupAction ?? result.run.blockedReason ?? "Configure the required provider in Settings."}`;
  }
  if (result.run.status === "failed")
    return `Run failed: ${result.run.failureReason ?? "Review run details."}`;
  if (result.run.status === "retryable")
    return `Run retryable: ${result.run.failureReason ?? "Retry when ready."}`;
  return successFallback;
}

function scheduledRunResultsNotice(results: WorkflowRunResult[]): string {
  const counts = {
    started: 0,
    failed: 0,
    blocked: 0,
    retryable: 0,
    skippedOrUnavailable: 0,
  };

  for (const result of results) {
    if (result.duplicate) {
      counts.skippedOrUnavailable += 1;
      continue;
    }
    if (result.run.status === "succeeded" || result.run.status === "running" || result.run.status === "queued") {
      counts.started += 1;
    }
    else if (result.run.status === "failed") counts.failed += 1;
    else if (result.run.status === "blocked") counts.blocked += 1;
    else if (result.run.status === "retryable") counts.retryable += 1;
    else counts.skippedOrUnavailable += 1;
  }

  const errorCount = counts.failed + counts.blocked + counts.retryable;
  const errorDetail = [
    formatCount(counts.failed, "failed"),
    formatCount(counts.blocked, "blocked"),
    formatCount(counts.retryable, "retryable"),
  ].filter(Boolean);
  const parts = [
    `${counts.started} started`,
    `${counts.skippedOrUnavailable} skipped/unavailable`,
    `${errorCount} error${errorCount === 1 ? "" : "s"}${errorDetail.length > 0 ? ` (${errorDetail.join(", ")})` : ""}`,
  ];

  return `Scheduled runs: ${parts.join(", ")}`;
}

function formatCount(count: number, label: string): string {
  return count > 0 ? `${count} ${label}` : "";
}

function providerIdForAgentProfile(profile: AgentAuthProfile): "openai" | "anthropic" {
  switch (profile.runnerKind) {
    case "openai_api":
      return "openai";
    case "anthropic_api":
      return "anthropic";
    default:
      throw new Error(`${profile.displayName} does not accept API keys.`);
  }
}

export function providerAccountForAgentProfile(profile: AgentAuthProfile): ProviderAccount {
  const providerId = providerIdForAgentProfile(profile);
  return {
    id: profile.id,
    providerKind: "llm",
    displayName: profile.displayName,
    credentialRef: "keychain:pending",
    settingsJson: {
      provider_id: providerId,
      profile_id: profile.id,
    },
  };
}

interface AppStateActions {
  runWorkflow: (workflowId: string, workflowOverride?: WorkflowVersion) => Promise<void>;
  retryRun: (runId: string) => Promise<void>;
  runDueSchedules: (options?: RunDueSchedulesOptions) => Promise<string>;
  installWorkflowTemplate: (
    definition: RavenWorkflow,
    status: WorkflowState,
    approvalMode?: ApprovalMode,
    plannerRationale?: PlannerRationale | null,
  ) => Promise<WorkflowVersion | null>;
  archiveWorkflow: (workflowId: string) => Promise<WorkflowVersion | null>;
  updateWorkflowSafeFields: (workflowId: string, fields: WorkflowSafeFields) => Promise<string>;
  assignScheduleOverride: (
    workflowId: string,
    originalRunAt: string,
    scheduledRunAt: string,
  ) => Promise<string>;
  copyArtifact: (artifact: Artifact) => Promise<void>;
  exportArtifact: (artifact: Artifact) => Promise<void>;
  regenerateArtifact: (artifact: Artifact) => Promise<void>;
  refreshProviderReadiness: () => Promise<string>;
  setAutonomyMode: (mode: AutonomyMode) => Promise<string>;
  setAutonomyCategoryOverride: (category: string, mode: AutonomyMode | "inherit") => Promise<string>;
  setAutonomyCategoryOverrides: (updates: Record<string, AutonomyMode | "inherit">) => Promise<string>;
  refreshCapabilityRegistry: () => Promise<string>;
  createApprovalGrant: (grant: ApprovalGrantDraft) => Promise<string>;
  revokeApprovalGrant: (id: string) => Promise<string>;
  addWorkflow: (workflow: WorkflowVersion) => void;
  removeWorkflow: (workflowId: string) => void;
  pushToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  updateBuilderProfile: (profileId: string) => void;
  completeSetup: (
    options?: {
      skipped?: boolean;
      migratedLegacy?: boolean;
      preserveSkipped?: boolean;
      postOnboardingLandingPending?: boolean;
    },
  ) => Promise<{ ok: boolean; message: string }>;
  consumePostOnboardingLanding: () => void;
  resumeSetup: () => void;
  configureProviderCredential: (profileId: string, rawSecret: string) => Promise<string>;
  configureArtifactDestination: (
    destinationId: ArtifactDestinationId,
    folderPath: string,
  ) => Promise<string>;
  chooseArtifactDestinationFolderPath: () => Promise<string | null>;
  configureAiChatImportFolder: (folderPath: string) => Promise<string>;
  chooseAiChatImportFolderPath: () => Promise<string | null>;
  scanAiChatImportFolder: () => ReturnType<typeof scanPersistedAiChatImportFolder>;
  configureDocumentImportFolder: (folderPath: string) => Promise<string>;
  chooseDocumentImportFolderPath: () => Promise<string | null>;
  scanDocumentImportFolder: () => ReturnType<typeof scanPersistedDocumentImportFolder>;
  configureGithubContext: (repoSlug: string, token?: string) => Promise<string>;
  scanGithubContext: () => ReturnType<typeof scanPersistedGithubContext>;
  configureNestWeaver: (
    binaryPath: string,
    dbPath: string,
    project: string,
    tokenBudget: number,
  ) => Promise<string>;
  scanNestWeaverProject: () => ReturnType<typeof indexPersistedNestWeaverProject>;
  toggleScheduler: (enabled: boolean) => Promise<string>;
  loadSchedulerStatus: () => ReturnType<typeof loadPersistedSchedulerStatus>;
  generateArtifactPreview: (workflowId: string) => Promise<string | null>;
  applyRunResults: (results: WorkflowRunResult[]) => void;
  refreshState: () => Promise<void>;
}

interface AppStateContextValue {
  state: AppState;
  toasts: Toast[];
  runNotice: string;
  artifactNotice: string;
  artifactDestinationId: ArtifactDestinationId;
  artifactDestinationPaths: Partial<Record<ArtifactDestinationId, string>>;
  builderProfileId: string;
  hasCompletedSetup: boolean;
  hasSkippedSetup: boolean;
  postOnboardingLandingPending: boolean;
  actions: AppStateActions;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialState);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [runNotice, setRunNotice] = useState("");
  const [artifactNotice, setArtifactNotice] = useState("");
  const [artifactDestinationId, setArtifactDestinationId] =
    useState<ArtifactDestinationId>("local_app");
  const [artifactDestinationPaths, setArtifactDestinationPaths] = useState<
    Partial<Record<ArtifactDestinationId, string>>
  >({});
  const [builderProfileId, setBuilderProfileId] = useState(
    initialState.agentAuthProfiles[0]?.id ?? "",
  );
  const [setupComplete, setSetupComplete] = useState(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      if (localStorage.getItem("raven:setup-complete") === "true") return true;
    }
    return false;
  });
  const [setupSkipped, setSetupSkipped] = useState(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      return localStorage.getItem("raven:setup-skipped") === "true";
    }
    return false;
  });
  const [postOnboardingLandingPending, setPostOnboardingLandingPending] = useState(false);
  const capabilityRegistryRequestId = useRef(0);
  const appStateRequestId = useRef(0);
  const autonomyModeChangedByUser = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  useEffect(() => {
    let mounted = true;
    const appStateLoadRequestId = ++appStateRequestId.current;
    Promise.all([loadPersistedAppState(), getSavedSettings()]).then(([persistedState, settings]) => {
      const autonomyMode =
        autonomyModeFromSettings(settings) ?? persistedState?.autonomyMode ?? initialState.autonomyMode;
      const autonomyCategoryOverrides =
        Object.keys(autonomyCategoryOverridesFromSettings(settings)).length > 0
          ? autonomyCategoryOverridesFromSettings(settings)
          : persistedState?.autonomyCategoryOverrides ?? initialState.autonomyCategoryOverrides;
      const isLatestAppStateRequest = appStateLoadRequestId === appStateRequestId.current;
      if (mounted && persistedState && isLatestAppStateRequest) {
        setState((current) => ({
          ...persistedState,
          autonomyMode: autonomyModeChangedByUser.current ? current.autonomyMode : autonomyMode,
          autonomyCategoryOverrides: autonomyModeChangedByUser.current
            ? current.autonomyCategoryOverrides
            : autonomyCategoryOverrides,
          capabilityRegistry: autonomyModeChangedByUser.current
            ? current.capabilityRegistry
            : persistedState.capabilityRegistry,
          approvalGrants: autonomyModeChangedByUser.current
            ? current.approvalGrants
            : persistedState.approvalGrants,
          theme: current.theme,
          chatMessages:
            persistedState.chatMessages.length > 0
              ? persistedState.chatMessages
              : current.chatMessages,
        }));
        const savedBuilderProfileId =
          typeof settings?.builder_profile_id === "string" ? settings.builder_profile_id : "";
        const builderProfile =
          persistedState.agentAuthProfiles.find((profile) => profile.id === savedBuilderProfileId) ??
          persistedState.agentAuthProfiles[0] ??
          initialState.agentAuthProfiles[0];
        setBuilderProfileId(builderProfile?.id ?? "");
      } else if (mounted && isLatestAppStateRequest && !autonomyModeChangedByUser.current) {
        setState((current) => ({ ...current, autonomyMode, autonomyCategoryOverrides }));
      }
      if (autonomyModeChangedByUser.current) return;
      const capabilityRequestId = ++capabilityRegistryRequestId.current;
      void Promise.all([
        detectTools().catch(() => []),
        availableCapabilityCatalog(autonomyMode, autonomyCategoryOverrides).catch(() => emptyCapabilityRegistry()),
        listApprovalGrants().catch(() => []),
      ]).then(([rawToolInventory, capabilityRegistry, approvalGrants]) => {
        if (!mounted || capabilityRequestId !== capabilityRegistryRequestId.current) return;
        setState((current) => ({
          ...current,
          rawToolInventory,
          capabilityRegistry,
          approvalGrants,
        }));
      });
    });
    return () => {
      mounted = false;
    };
  }, []);

  const hasCompletedSetup = setupComplete;

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { ...toast, id }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const completeSetup = useCallback(async (
    options: {
      skipped?: boolean;
      migratedLegacy?: boolean;
      preserveSkipped?: boolean;
      postOnboardingLandingPending?: boolean;
    } = {},
  ) => {
    try {
      await completeOnboarding();
    } catch {
      return {
        ok: false,
        message: "Raven could not finalize onboarding yet. Please try again.",
      };
    }

    const preservedSkippedState = options.skipped ?? (
      options.preserveSkipped &&
      (localStorage.getItem("raven:setup-skipped") === "true" || setupSkipped)
    );

    localStorage.setItem("raven:setup-complete", "true");
    if (options.migratedLegacy) {
      localStorage.removeItem("hugin:setup-complete");
      localStorage.setItem("raven:setup-migrated", "true");
    }
    if (preservedSkippedState) {
      localStorage.setItem("raven:setup-skipped", "true");
      setSetupSkipped(true);
    } else {
      localStorage.removeItem("raven:setup-skipped");
      setSetupSkipped(false);
    }
    setSetupComplete(true);
    setPostOnboardingLandingPending(options.postOnboardingLandingPending === true);
    return { ok: true, message: "" };
  }, [setupSkipped]);

  const consumePostOnboardingLanding = useCallback(() => {
    setPostOnboardingLandingPending(false);
  }, []);

  const resumeSetup = useCallback(() => {
    localStorage.removeItem("raven:setup-complete");
    setSetupComplete(false);
    setPostOnboardingLandingPending(false);
  }, []);

  const applyRunResults = useCallback((results: WorkflowRunResult[]) => {
    setState((current) => ({
      ...current,
      runs: [
        ...results.map((result) => result.run),
        ...current.runs.filter((run) => !results.some((result) => result.run.id === run.id)),
      ],
      artifacts: [
        ...results.flatMap((result) => (result.artifact ? [result.artifact] : [])),
        ...current.artifacts.filter(
          (artifact) => !results.some((result) => result.artifact?.id === artifact.id),
        ),
      ],
    }));
  }, []);

  const refreshState = useCallback(async () => {
    const requestId = ++appStateRequestId.current;
    const persistedState = await loadPersistedAppState();
    if (!persistedState) return;
    setState((current) => ({
      ...(requestId === appStateRequestId.current ? {
        ...persistedState,
        autonomyMode: current.autonomyMode,
        autonomyCategoryOverrides: current.autonomyCategoryOverrides,
        capabilityRegistry: current.capabilityRegistry,
        rawToolInventory: current.rawToolInventory,
        approvalGrants: current.approvalGrants,
        theme: current.theme,
        chatMessages:
          persistedState.chatMessages.length > 0
            ? persistedState.chatMessages
            : current.chatMessages,
      } : current),
    }));
  }, []);

  const notifyRunResults = useCallback(async (results: WorkflowRunResult[]) => {
    await Promise.all(
      results
        .filter((result) => !result.duplicate)
        .map((result) => {
          if (result.run.status === "succeeded") {
            return notifyWorkflowRunCompleted(result.run.workflowName);
          }
          if (result.run.status === "failed" || result.run.status === "retryable") {
            return notifyWorkflowRunFailed(result.run.workflowName);
          }
          return Promise.resolve();
        }),
    );
  }, []);

  const runWorkflow = useCallback(
    async (workflowId: string, workflowOverride?: WorkflowVersion) => {
      const workflow =
        state.workflows.find((item) => item.workflowId === workflowId) ??
        (workflowOverride?.workflowId === workflowId ? workflowOverride : undefined);
      if (!workflow) return;
      if (workflow.status !== "enabled") {
        setRunNotice(`${workflow.definition.name} is ${workflow.status} and cannot be run`);
        return;
      }

      let persistedResult: WorkflowRunResult | null;
      try {
        persistedResult = await runPersistedWorkflow(workflowId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRunNotice(`Run failed: ${message || "Review run details."}`);
        return;
      }
      if (persistedResult) {
        applyRunResults([persistedResult]);
        await notifyRunResults([persistedResult]);
        setRunNotice(runResultNotice(persistedResult));
        return;
      }

      const runId = `run-${crypto.randomUUID()}`;
      const artifactId = `artifact-${crypto.randomUUID()}`;
      const artifact: Artifact = {
        id: artifactId,
        title: workflow.definition.name,
        type:
          workflowId === "current-weather"
            ? "weather_report"
            : workflowId === "morning-brief"
              ? "morning_brief"
              : "daily_work_journal",
        workflowRunId: runId,
        contentMarkdown: `# ${workflow.definition.name}\n\n## Progress\n- Workflow run simulated in browser.\n\n## Next Steps\n- Configure providers for live generation.`,
        metadata: {
          schemaVersion: "0.1.0",
          workflowId,
          workflowVersion: workflow.version,
        },
        sourceRefs: ["local git context"],
        createdAt: now(),
      };

      setState((current) => ({
        ...current,
        runs: [
          {
            id: runId,
            workflowId,
            workflowName: workflow.definition.name,
            status: "succeeded",
            startedAt: now(),
            completedAt: now(),
            idempotencyKey: `manual:${workflowId}:${runId}`,
          },
          ...current.runs,
        ],
        artifacts: [artifact, ...current.artifacts],
      }));
      await notifyWorkflowRunCompleted(workflow.definition.name);
      setRunNotice("Run completed");
    },
    [state.workflows, applyRunResults, notifyRunResults],
  );

  const retryRun = useCallback(
    async (runId: string) => {
      const persistedResult = await retryPersistedWorkflowRun(runId);
      if (!persistedResult) {
        setRunNotice("Retry unavailable");
        return;
      }
      applyRunResults([persistedResult]);
      await notifyRunResults([persistedResult]);
      setRunNotice(runResultNotice(persistedResult, "Retry completed"));
    },
    [applyRunResults, notifyRunResults],
  );

  const runDueSchedules = useCallback(async (options: RunDueSchedulesOptions = {}) => {
    const scheduleWindow = options.scheduleWindow ?? localScheduleWindow(new Date());
    const results = await runPersistedDueSchedules(scheduleWindow, options.workflowIds);
    if (!results) {
      const notice = "Scheduled runs unavailable";
      setRunNotice(notice);
      return notice;
    }
    if (results.length === 0) {
      const notice = "No due schedules";
      setRunNotice(notice);
      return notice;
    }
    applyRunResults(results);
    await notifyRunResults(results);
    const notice = scheduledRunResultsNotice(results);
    setRunNotice(notice);
    return notice;
  }, [applyRunResults, notifyRunResults]);

  const updateWorkflowSafeFields = useCallback(
    async (workflowId: string, fields: WorkflowSafeFields): Promise<string> => {
      const persistedWorkflow = await updatePersistedWorkflowSafeFields({
        workflowId,
        status: fields.status,
        cadence: fields.cadence,
        localTime: fields.localTime,
        approvalMode: fields.approvalMode,
        llmProfileRef: fields.llmProfileRef,
      });

      if (persistedWorkflow) {
        setState((current) => ({
          ...current,
          workflows: current.workflows.map((workflow) =>
            workflow.workflowId === workflowId
              ? { ...persistedWorkflow, approvalMode: fields.approvalMode ?? persistedWorkflow.approvalMode }
              : workflow,
          ),
        }));
        return `Saved ${persistedWorkflow.definition.name} v${persistedWorkflow.version}`;
      }

      return "Workflow save failed";
    },
    [],
  );

  const assignScheduleOverride = useCallback(
    async (workflowId: string, originalRunAt: string, scheduledRunAt: string): Promise<string> => {
      const override = await assignPersistedScheduleOverride(workflowId, originalRunAt, scheduledRunAt);
      if (!override) return "Schedule override failed";
      setState((current) => ({
        ...current,
        scheduleOverrides: [
          override,
          ...current.scheduleOverrides.filter((item) =>
            item.workflowId !== workflowId || item.originalRunAt !== originalRunAt,
          ),
        ],
      }));
      return "Schedule occurrence moved";
    },
    [],
  );

  const copyArtifact = useCallback(async (artifact: Artifact) => {
    try {
      await navigator.clipboard.writeText(artifact.contentMarkdown);
      setArtifactNotice("Artifact copied");
    } catch {
      setArtifactNotice("Failed to copy — clipboard unavailable");
    }
  }, []);

  const exportArtifact = useCallback(
    async (artifact: Artifact) => {
      const slugged = artifact.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const destinationPath = `exports/${slugged}.md`;
      const exportedPath = await exportPersistedArtifact(
        artifact.id,
        artifactDestinationId === "local_app"
          ? { destinationPath }
          : { destinationId: artifactDestinationId },
      );
      setArtifactNotice(
        exportedPath ? `Artifact exported to ${exportedPath}` : "Artifact export unavailable",
      );
    },
    [artifactDestinationId],
  );

  const regenerateArtifact = useCallback(
    async (artifact: Artifact) => {
      const persistedResult = await regeneratePersistedArtifact(artifact.id);
      if (!persistedResult) {
        setArtifactNotice("Artifact regeneration unavailable");
        return;
      }
      applyRunResults([persistedResult]);
      await notifyRunResults([persistedResult]);
      setArtifactNotice(runResultNotice(persistedResult, "Artifact regenerated"));
    },
    [applyRunResults, notifyRunResults],
  );

  const refreshProviderReadiness = useCallback(async (): Promise<string> => {
    const providers = await checkPersistedProviderReadiness();
    if (providers.length === 0) return "Provider readiness unavailable";
    setState((current) => ({ ...current, providers }));
    return "Provider readiness refreshed";
  }, []);

  const refreshCapabilityRegistry = useCallback(async (): Promise<string> => {
    const mode = state.autonomyMode;
    const categoryOverrides = state.autonomyCategoryOverrides;
    const requestId = ++capabilityRegistryRequestId.current;
    const [rawToolInventory, capabilityRegistry, approvalGrants] = await Promise.all([
      detectTools().catch(() => []),
      availableCapabilityCatalog(mode, categoryOverrides).catch(() => null),
      listApprovalGrants().catch(() => null),
    ]);
    if (!capabilityRegistry) return "Tool registry unavailable";
    setState((current) =>
      requestId === capabilityRegistryRequestId.current && current.autonomyMode === mode
        ? {
            ...current,
            rawToolInventory,
            capabilityRegistry,
            approvalGrants: approvalGrants ?? current.approvalGrants,
          }
        : current,
    );
    return "Tool registry refreshed";
  }, [state.autonomyMode, state.autonomyCategoryOverrides]);

  const setAutonomyMode = useCallback(async (mode: AutonomyMode): Promise<string> => {
    autonomyModeChangedByUser.current = true;
    const requestId = ++capabilityRegistryRequestId.current;
    setState((current) => ({ ...current, autonomyMode: mode }));
    const categoryOverrides = state.autonomyCategoryOverrides;
    const [saved, capabilityRegistry] = await Promise.all([
      setPersistedAutonomyMode(mode),
      availableCapabilityCatalog(mode, categoryOverrides).catch(() => null),
    ]);
    if (capabilityRegistry && requestId === capabilityRegistryRequestId.current) {
      setState((current) =>
        current.autonomyMode === mode ? { ...current, capabilityRegistry } : current,
      );
    }
    return saved ? "Autonomy mode saved" : "Autonomy mode updated for this session; save failed";
  }, [state.autonomyCategoryOverrides]);

  const setAutonomyCategoryOverride = useCallback(async (
    category: string,
    mode: AutonomyMode | "inherit",
  ): Promise<string> => {
    const nextOverrides = { ...state.autonomyCategoryOverrides };
    if (mode === "inherit") {
      delete nextOverrides[category];
    } else {
      nextOverrides[category] = mode;
    }
    const requestId = ++capabilityRegistryRequestId.current;
    setState((current) => ({ ...current, autonomyCategoryOverrides: nextOverrides }));
    const [saved, capabilityRegistry] = await Promise.all([
      setPersistedAutonomyCategoryOverrides(nextOverrides),
      availableCapabilityCatalog(state.autonomyMode, nextOverrides).catch(() => null),
    ]);
    if (capabilityRegistry && requestId === capabilityRegistryRequestId.current) {
      setState((current) => ({ ...current, capabilityRegistry }));
    }
    return saved ? "Category override saved" : "Category override updated for this session; save failed";
  }, [state.autonomyCategoryOverrides, state.autonomyMode]);

  const setAutonomyCategoryOverrides = useCallback(async (
    updates: Record<string, AutonomyMode | "inherit">,
  ): Promise<string> => {
    const nextOverrides = { ...state.autonomyCategoryOverrides };
    Object.entries(updates).forEach(([category, mode]) => {
      if (mode === "inherit") {
        delete nextOverrides[category];
      } else {
        nextOverrides[category] = mode;
      }
    });
    const requestId = ++capabilityRegistryRequestId.current;
    setState((current) => ({ ...current, autonomyCategoryOverrides: nextOverrides }));
    const [saved, capabilityRegistry] = await Promise.all([
      setPersistedAutonomyCategoryOverrides(nextOverrides),
      availableCapabilityCatalog(state.autonomyMode, nextOverrides).catch(() => null),
    ]);
    if (capabilityRegistry && requestId === capabilityRegistryRequestId.current) {
      setState((current) => ({ ...current, capabilityRegistry }));
    }
    return saved ? "Category overrides saved" : "Category overrides updated for this session; save failed";
  }, [state.autonomyCategoryOverrides, state.autonomyMode]);

  const revokeApprovalGrant = useCallback(async (id: string): Promise<string> => {
    try {
      await revokePersistedApprovalGrant(id);
    } catch {
      return "Approval grant revoke failed";
    }
    const approvalGrants = await listApprovalGrants().catch(() => null);
    setState((current) => ({
      ...current,
      approvalGrants: approvalGrants ?? current.approvalGrants.map((grant) =>
        grant.id === id ? { ...grant, status: "revoked" } : grant,
      ),
    }));
    return "Approval grant revoked";
  }, []);

  const createApprovalGrant = useCallback(async (grant: ApprovalGrantDraft): Promise<string> => {
    try {
      const persistedGrant = await createPersistedApprovalGrant(grant);
      const approvalGrants = await listApprovalGrants().catch(() => null);
      setState((current) => ({
        ...current,
        approvalGrants: approvalGrants ?? [
          ...current.approvalGrants.filter((existing) => existing.id !== persistedGrant.id),
          persistedGrant,
        ],
      }));
      return "Approval grant created";
    } catch {
      return "Approval grant failed";
    }
  }, []);

  const installWorkflowTemplate = useCallback(
    async (
      definition: RavenWorkflow,
      status: WorkflowState,
      approvalMode?: ApprovalMode,
      plannerRationale?: PlannerRationale | null,
    ): Promise<WorkflowVersion | null> => {
      const persistedWorkflow = await installPersistedWorkflowTemplate(
        definition,
        status,
        approvalMode,
        plannerRationale,
      );
      if (!persistedWorkflow) return null;

      setState((current) => ({
        ...current,
        workflows: [
          persistedWorkflow,
          ...current.workflows.filter(
            (workflow) => workflow.workflowId !== persistedWorkflow.workflowId,
          ),
        ],
      }));
      return persistedWorkflow;
    },
    [],
  );

  const archiveWorkflow = useCallback(
    async (workflowId: string): Promise<WorkflowVersion | null> => {
      const archivedWorkflow = await archivePersistedWorkflow(workflowId);
      if (!archivedWorkflow) return null;

      setState((current) => ({
        ...current,
        workflows: current.workflows.map((workflow) =>
          workflow.workflowId === workflowId ? archivedWorkflow : workflow,
        ),
      }));
      return archivedWorkflow;
    },
    [],
  );

  const addWorkflow = useCallback((workflow: WorkflowVersion) => {
    setState((current) => ({
      ...current,
      workflows: [
        workflow,
        ...current.workflows.filter((item) => item.workflowId !== workflow.workflowId),
      ],
    }));
  }, []);

  const removeWorkflow = useCallback((workflowId: string) => {
    void archivePersistedWorkflow(workflowId).then((archivedWorkflow) => {
      if (archivedWorkflow) {
        setState((current) => ({
          ...current,
          workflows: current.workflows.map((workflow) =>
            workflow.workflowId === workflowId ? archivedWorkflow : workflow,
          ),
        }));
        return;
      }
      setState((current) => ({
        ...current,
        workflows: current.workflows.filter((item) => item.workflowId !== workflowId),
      }));
    });
  }, []);

  const updateBuilderProfile = useCallback((profileId: string) => {
    setBuilderProfileId(profileId);
    void setPersistedBuilderProfile(profileId);
  }, []);

  const configureProviderCredential = useCallback(
    async (profileId: string, rawSecret: string): Promise<string> => {
      const profile = state.agentAuthProfiles.find((profile) => profile.id === profileId);
      if (!profile) return `Unknown provider profile ${profileId}.`;

      let account: ProviderAccount;
      try {
        account = providerAccountForAgentProfile(profile);
      } catch (error) {
        return error instanceof Error ? error.message : "Provider profile does not accept API keys.";
      }

      const configured = await configurePersistedProviderAccount(account, rawSecret);
      if (!configured) return "Credential storage unavailable";
      const providerId = String(configured.settingsJson.provider_id ?? "");

      setState((current) => ({
        ...current,
        providers: current.providers.map((provider) =>
          provider.id === providerId
            ? {
                ...provider,
                status: "available",
                summary: `${configured.displayName} is configured through ${configured.credentialRef}.`,
              }
            : provider,
        ),
        agentAuthProfiles: current.agentAuthProfiles.map((profile) =>
          profile.id === profileId
            ? {
                ...profile,
                authMode: "api_key_keychain",
                credentialRef: configured.credentialRef,
                status: "available",
              }
            : profile,
        ),
      }));

      return `${configured.displayName} stored as ${configured.credentialRef}`;
    },
    [state.agentAuthProfiles],
  );

  const configureArtifactDestination = useCallback(
    async (destinationId: ArtifactDestinationId, folderPath: string): Promise<string> => {
      const saved = await configurePersistedArtifactDestination(destinationId, folderPath);
      if (!saved) return "Artifact destination unavailable";

      setArtifactDestinationId(destinationId);
      setArtifactDestinationPaths((current) => ({ ...current, [destinationId]: folderPath }));
      setState((current) => ({
        ...current,
        providers: current.providers.map((provider) =>
          provider.id === destinationId
            ? {
                ...provider,
                status: "available",
                summary: `${artifactDestinationLabels[destinationId]} writes to ${folderPath}.`,
              }
            : provider,
        ),
      }));

      return `${artifactDestinationLabels[destinationId]} destination saved`;
    },
    [],
  );

  const chooseArtifactDestinationFolderPath = useCallback(
    () => chooseArtifactDestinationFolder(),
    [],
  );

  const configureAiChatImportFolder = useCallback(async (folderPath: string): Promise<string> => {
    const saved = await configurePersistedAiChatImportFolder(folderPath);
    if (!saved) return "AI chat import folder unavailable";

    setState((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === "ai_chat_import"
          ? {
              ...provider,
              status: "available",
              summary: `AI Chat Import Folder reads exported chats from ${folderPath}.`,
            }
          : provider,
      ),
    }));

    return "AI chat import folder saved";
  }, []);

  const chooseAiChatImportFolderPath = useCallback(() => chooseAiChatImportFolder(), []);

  const scanAiChatImportFolder = useCallback(() => scanPersistedAiChatImportFolder(), []);

  const configureDocumentImportFolder = useCallback(
    async (folderPath: string): Promise<string> => {
      const saved = await configurePersistedDocumentImportFolder(folderPath);
      if (!saved) return "PDF document import folder unavailable";

      setState((current) => ({
        ...current,
        providers: current.providers.map((provider) =>
          provider.id === "document_import"
            ? {
                ...provider,
                status: "available",
                summary: `PDF Document Import Folder reads digital PDFs from ${folderPath}.`,
              }
            : provider,
        ),
      }));

      return "PDF document import folder saved";
    },
    [],
  );

  const chooseDocumentImportFolderPath = useCallback(() => choosePdfDocumentImportFolder(), []);

  const scanDocumentImportFolder = useCallback(() => scanPersistedDocumentImportFolder(), []);

  const configureGithubContext = useCallback(async (repoSlug: string, token?: string): Promise<string> => {
    const trimmedToken = token?.trim();
    if (trimmedToken) {
      const account: ProviderAccount = {
        id: "github-api-key",
        providerKind: "context",
        displayName: "GitHub",
        credentialRef: "keychain:pending",
        settingsJson: {
          provider_id: "github",
        },
      };
      const configured = await configurePersistedProviderAccount(account, trimmedToken);
      if (!configured) return "GitHub token storage unavailable";
    }

    const saved = await configurePersistedGithubContext(repoSlug);
    if (!saved) return "GitHub context unavailable";

    const providers = await checkPersistedProviderReadiness();
    setState((current) => ({
      ...current,
      providers:
        providers.length > 0
          ? providers
          : current.providers.map((provider) =>
              provider.id === "github"
                ? {
                    ...provider,
                    status: trimmedToken ? "available" : "needs_config",
                    summary: trimmedToken
                      ? `GitHub context reads pull requests and issues from ${repoSlug}.`
                      : `GitHub repo ${repoSlug} saved. Add a token to scan private or rate-limited repositories.`,
                  }
                : provider,
            ),
    }));

    return trimmedToken ? "GitHub context and token saved" : "GitHub context saved";
  }, []);

  const scanGithubContext = useCallback(() => scanPersistedGithubContext(), []);

  const configureNestWeaver = useCallback(
    async (
      binaryPath: string,
      dbPath: string,
      project: string,
      tokenBudget: number,
    ): Promise<string> => {
      const saved = await configurePersistedNestWeaver({
        binaryPath,
        dbPath: dbPath.trim() ? dbPath : undefined,
        project: project.trim() ? project : undefined,
        tokenBudget,
      });
      if (!saved) return "NestWeaver configuration unavailable";
      const providers = await checkPersistedProviderReadiness();
      setState((current) => ({
        ...current,
        providers:
          providers.length > 0
            ? providers
            : current.providers.map((provider) =>
                provider.id === "nestweaver"
                  ? {
                      ...provider,
                      status: "available",
                      summary: `NestWeaver configured with ${binaryPath || "nestweaver"}.`,
                    }
                  : provider,
              ),
      }));
      return "NestWeaver configuration saved";
    },
    [],
  );

  const scanNestWeaverProject = useCallback(() => indexPersistedNestWeaverProject(), []);

  const toggleScheduler = useCallback(async (enabled: boolean): Promise<string> => {
    const saved = enabled ? await startPersistedScheduler() : await stopPersistedScheduler();
    return saved
      ? enabled
        ? "Scheduler enabled"
        : "Scheduler disabled"
      : "Scheduler unavailable";
  }, []);

  const loadSchedulerStatus = useCallback(() => loadPersistedSchedulerStatus(), []);

  const generateArtifactPreview = useCallback(
    (workflowId: string) => generatePersistedArtifactPreview(workflowId),
    [],
  );

  const actions = useMemo<AppStateActions>(
    () => ({
      runWorkflow,
      retryRun,
      runDueSchedules,
      installWorkflowTemplate,
      archiveWorkflow,
      updateWorkflowSafeFields,
      assignScheduleOverride,
      copyArtifact,
      exportArtifact,
      regenerateArtifact,
      refreshProviderReadiness,
      setAutonomyMode,
      setAutonomyCategoryOverride,
      setAutonomyCategoryOverrides,
      refreshCapabilityRegistry,
      createApprovalGrant,
      revokeApprovalGrant,
      addWorkflow,
      removeWorkflow,
      pushToast,
      dismissToast,
      updateBuilderProfile,
      completeSetup,
      consumePostOnboardingLanding,
      resumeSetup,
      configureProviderCredential,
      configureArtifactDestination,
      chooseArtifactDestinationFolderPath,
      configureAiChatImportFolder,
      chooseAiChatImportFolderPath,
      scanAiChatImportFolder,
      configureDocumentImportFolder,
      chooseDocumentImportFolderPath,
      scanDocumentImportFolder,
      configureGithubContext,
      scanGithubContext,
      configureNestWeaver,
      scanNestWeaverProject,
      toggleScheduler,
      loadSchedulerStatus,
      generateArtifactPreview,
      applyRunResults,
      refreshState,
    }),
    [
      runWorkflow,
      retryRun,
      runDueSchedules,
      installWorkflowTemplate,
      archiveWorkflow,
      updateWorkflowSafeFields,
      assignScheduleOverride,
      copyArtifact,
      exportArtifact,
      regenerateArtifact,
      refreshProviderReadiness,
      setAutonomyMode,
      setAutonomyCategoryOverride,
      setAutonomyCategoryOverrides,
      refreshCapabilityRegistry,
      createApprovalGrant,
      revokeApprovalGrant,
      addWorkflow,
      removeWorkflow,
      pushToast,
      dismissToast,
      updateBuilderProfile,
      completeSetup,
      consumePostOnboardingLanding,
      resumeSetup,
      configureProviderCredential,
      configureArtifactDestination,
      chooseArtifactDestinationFolderPath,
      configureAiChatImportFolder,
      chooseAiChatImportFolderPath,
      scanAiChatImportFolder,
      configureDocumentImportFolder,
      chooseDocumentImportFolderPath,
      scanDocumentImportFolder,
      configureGithubContext,
      scanGithubContext,
      configureNestWeaver,
      scanNestWeaverProject,
      toggleScheduler,
      loadSchedulerStatus,
      generateArtifactPreview,
      applyRunResults,
      refreshState,
    ],
  );

  const value = useMemo<AppStateContextValue>(
    () => ({
      state,
      toasts,
      runNotice,
      artifactNotice,
      artifactDestinationId,
      artifactDestinationPaths,
      builderProfileId,
      hasCompletedSetup,
      hasSkippedSetup: setupSkipped,
      postOnboardingLandingPending,
      actions,
    }),
    [
      state,
      toasts,
      runNotice,
      artifactNotice,
      artifactDestinationId,
      artifactDestinationPaths,
      builderProfileId,
      hasCompletedSetup,
      setupSkipped,
      postOnboardingLandingPending,
      actions,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
