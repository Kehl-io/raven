import { Download, FolderOpen, Palette, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppState } from "../contexts/AppStateContext";
import { useUI } from "../contexts/UIContext";
import { ProviderGroupCard } from "../components/ProviderGroupCard";
import { ContextSourceCard } from "../components/ContextSourceCard";
import { SettingsBreadcrumbs } from "../components/SettingsBreadcrumbs";
import { ToolsAutonomyPanel } from "../components/ToolsAutonomyPanel";
import { formatSchedule, getNextRunTime, groupProviderProfiles } from "../../domain/format";
import type {
  ContextPack,
  PluginManifest,
  ProviderHealth,
  ProviderState,
  SchedulerStatus,
  WorkflowVersion,
} from "../../domain/types";
import { detectNestWeaver, getAppVersion, getDockVisibility, getGlobalShortcut, getSavedSettings, listPlugins, setDockVisibility, setGlobalShortcut as tauriSetGlobalShortcut } from "../tauriBridge";

type SettingsTabId = "providers" | "context" | "outputs" | "automation" | "extensions" | "system";
type ReadinessStatus = "ready" | "not_configured" | "unavailable" | "error";
type AppearanceTheme = "aurora-dark" | "aurora-light";

interface ThemePreferences {
  schemaVersion: "raven.theme.v1";
  theme: AppearanceTheme;
  accent: string;
  exportedAt: string;
}

interface SettingsHistoryEntry {
  id: string;
  label: string;
  tab: SettingsTabId;
  changedAt: string;
}

const settingsTabs: { id: SettingsTabId; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "context", label: "Context" },
  { id: "outputs", label: "Outputs" },
  { id: "automation", label: "Automation" },
  { id: "extensions", label: "Extensions" },
  { id: "system", label: "System" },
];

const THEME_PREFERENCES_STORAGE_KEY = "raven:theme-preferences";
const DEFAULT_ACCENT = "#c43c3c";

function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === "aurora-dark" || value === "aurora-light";
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function buildThemePreferences(theme: AppearanceTheme, accent: string): ThemePreferences {
  return {
    schemaVersion: "raven.theme.v1",
    theme,
    accent,
    exportedAt: new Date().toISOString(),
  };
}

function isSuccessfulSettingsNotice(message: string): boolean {
  const lower = message.toLowerCase();
  return !(
    lower.includes("unavailable") ||
    lower.includes("failed") ||
    lower.includes("failure") ||
    lower.includes("error")
  );
}

function parseThemePreferences(text: string): ThemePreferences | null {
  try {
    const parsed = JSON.parse(text) as Partial<ThemePreferences>;
    if (parsed.schemaVersion !== "raven.theme.v1") return null;
    if (!isAppearanceTheme(parsed.theme)) return null;
    if (!isHexColor(parsed.accent)) return null;
    return buildThemePreferences(parsed.theme, parsed.accent.trim());
  } catch {
    return null;
  }
}

function readThemePreferences(): Partial<Pick<ThemePreferences, "theme" | "accent">> {
  const raw = localStorage.getItem(THEME_PREFERENCES_STORAGE_KEY);
  if (!raw) return {};
  const parsed = parseThemePreferences(raw);
  return parsed ? { theme: parsed.theme, accent: parsed.accent } : {};
}

function persistThemePreferences(theme: AppearanceTheme, accent: string) {
  localStorage.setItem(THEME_PREFERENCES_STORAGE_KEY, JSON.stringify(buildThemePreferences(theme, accent)));
}

function applyAccent(accent: string) {
  if (!isHexColor(accent)) return;
  const root = document.documentElement;
  root.style.setProperty("--action-primary", accent);
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--action-primary-hover", `color-mix(in srgb, ${accent} 78%, white)`);
  root.style.setProperty("--accent-strong", `color-mix(in srgb, ${accent} 78%, white)`);
  root.style.setProperty("--action-primary-pressed", `color-mix(in srgb, ${accent} 82%, black)`);
  root.style.setProperty("--accent-depth", `color-mix(in srgb, ${accent} 82%, black)`);
  root.style.setProperty("--focus-ring", accent);
  root.style.setProperty("--assistant-presence", accent);
  root.style.setProperty("--primary-gradient", `linear-gradient(180deg, color-mix(in srgb, ${accent} 78%, white), ${accent})`);
}

function clearAccent() {
  const root = document.documentElement;
  [
    "--action-primary",
    "--accent",
    "--action-primary-hover",
    "--accent-strong",
    "--action-primary-pressed",
    "--accent-depth",
    "--focus-ring",
    "--assistant-presence",
    "--primary-gradient",
  ].forEach((property) => root.style.removeProperty(property));
}

function downloadThemePreferences(preferences: ThemePreferences) {
  const blob = new Blob([JSON.stringify(preferences, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "raven-theme.json";
  link.click();
  URL.revokeObjectURL(url);
}

function githubSourceLabel(sourceRef: string) {
  const marker = ".com/";
  const markerIndex = sourceRef.indexOf(marker);
  if (markerIndex === -1) return sourceRef;
  const parts = sourceRef.slice(markerIndex + marker.length).split("/");
  return parts.length >= 4 ? `${parts[2]}/${parts[3]}` : sourceRef;
}

function providerStateToReadiness(status?: ProviderState): ReadinessStatus {
  switch (status) {
    case "available":
      return "ready";
    case "degraded":
      return "error";
    case "unavailable":
      return "unavailable";
    case "needs_config":
    case undefined:
      return "not_configured";
  }
}

function readinessLabel(status: ReadinessStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "not_configured":
      return "Not configured";
    case "unavailable":
      return "Unavailable";
    case "error":
      return "Error";
  }
}

function providerStatusLabel(status: ProviderState): string {
  return readinessLabel(providerStateToReadiness(status));
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "No scheduled run";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function workflowApprovalLabel(workflow: WorkflowVersion): string {
  switch (workflow.approvalMode) {
    case "always_review":
      return "Always review";
    case "review_changes":
      return "Review changes";
    case "auto_approve":
      return "Auto approve";
  }
}

function settingsTargetKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function slugTargetId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function readSettingsHistory(): SettingsHistoryEntry[] {
  try {
    const raw = localStorage.getItem("raven:settings-change-history");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SettingsHistoryEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function SettingsView() {
  const {
    state,
    runNotice,
    builderProfileId,
    artifactDestinationPaths,
    actions,
  } = useAppState();
  const { theme, setTheme, activeSettingsTab, settingsFocusTarget, setActiveSettingsTab, setView } = useUI();

  const { agentAuthProfiles, llmProfiles } = state;
  const llmProfile = llmProfiles[0];
  const selectedBuilder = agentAuthProfiles.find((p) => p.id === builderProfileId);
  const normalizedActiveTab = settingsTabs.some((tab) => tab.id === activeSettingsTab)
    ? activeSettingsTab as SettingsTabId
    : "providers";
  const providersById = new Map(state.providers.map((provider) => [provider.id, provider]));
  const focusedTargetKey = settingsFocusTarget
    ? settingsTargetKey(settingsFocusTarget.type, settingsFocusTarget.id)
    : "";
  const [recentlyChangedKey, setRecentlyChangedKey] = useState("");
  const [settingsHistory, setSettingsHistory] = useState<SettingsHistoryEntry[]>(readSettingsHistory);

  const providerGroups = groupProviderProfiles(agentAuthProfiles);
  const readyProviderGroups = providerGroups.filter((g) => g.isReady);
  const unreadyProviderGroups = providerGroups.filter((g) => !g.isReady);
  const groupsNeedingAttention = unreadyProviderGroups.length;

  // --- Providers tab state ---
  const [readinessNotice, setReadinessNotice] = useState("");

  // --- Context tab state ---
  const [nestWeaverBinaryPath, setNestWeaverBinaryPath] = useState("nestweaver");
  const [nestWeaverDbPath, setNestWeaverDbPath] = useState("");
  const [nestWeaverProject, setNestWeaverProject] = useState("");
  const [nestWeaverTokenBudget, setNestWeaverTokenBudget] = useState(4000);
  const [nestWeaverNotice, setNestWeaverNotice] = useState("");
  const [nestWeaverPack, setNestWeaverPack] = useState<ContextPack | null>(null);
  const [nestWeaverProjects, setNestWeaverProjects] = useState<string[]>([]);

  useEffect(() => {
    let mounted = true;
    void detectNestWeaver().then((detection) => {
      if (!mounted || !detection) return;
      setNestWeaverBinaryPath(detection.binary_path);
      if (detection.db_path) setNestWeaverDbPath(detection.db_path);
      if (detection.projects.length > 0) {
        setNestWeaverProjects(detection.projects);
        setNestWeaverProject(detection.projects[0]);
      }
      setNestWeaverNotice("Auto-detected NestWeaver installation.");
    });
    return () => { mounted = false; };
  }, []);

  const [githubRepoSlug, setGithubRepoSlug] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubNotice, setGithubNotice] = useState("");
  const [githubPack, setGithubPack] = useState<ContextPack | null>(null);

  const [aiChatImportPath, setAiChatImportPath] = useState("");
  const [aiChatImportNotice, setAiChatImportNotice] = useState("");
  const [aiChatImportPack, setAiChatImportPack] = useState<ContextPack | null>(null);

  const [documentImportPath, setDocumentImportPath] = useState("");
  const [documentImportNotice, setDocumentImportNotice] = useState("");
  const [documentImportPack, setDocumentImportPack] = useState<ContextPack | null>(null);

  // --- Output tab state ---
  type ArtifactDestinationId = "local_app" | "markdown_folder" | "obsidian_vault";
  const [artifactDestinationId, setArtifactDestinationId] =
    useState<ArtifactDestinationId>("markdown_folder");
  const [artifactDestinationPath, setArtifactDestinationPath] = useState("");
  const [artifactDestinationNotice, setArtifactDestinationNotice] = useState("");
  const [savedArtifactDestinationPaths, setSavedArtifactDestinationPaths] = useState<
    Partial<Record<ArtifactDestinationId, string>>
  >({});

  const setArtifactDestinationPathsFromSettings = (
    paths: Partial<Record<ArtifactDestinationId, string | undefined>>,
  ) => {
    const defined = Object.fromEntries(
      Object.entries(paths).filter((entry): entry is [ArtifactDestinationId, string] =>
        Boolean(entry[1]),
      ),
    ) as Partial<Record<ArtifactDestinationId, string>>;
    setSavedArtifactDestinationPaths(defined);
    if (Object.keys(defined).length > 0) {
      setArtifactDestinationPath(
        defined[artifactDestinationId] ?? defined.markdown_folder ?? defined.obsidian_vault ?? "",
      );
    }
  };

  useEffect(() => {
    let mounted = true;
    void getSavedSettings().then((settings) => {
      if (!mounted || !settings) return;
      const str = (obj: unknown, key: string) =>
        (obj as Record<string, unknown>)?.[key] as string | undefined;
      const nw = settings.nestweaver as Record<string, unknown> | null;
      if (nw) {
        if (str(nw, "binary_path")) setNestWeaverBinaryPath(str(nw, "binary_path")!);
        if (str(nw, "db_path")) setNestWeaverDbPath(str(nw, "db_path")!);
        if (str(nw, "project")) setNestWeaverProject(str(nw, "project")!);
        if (typeof nw.token_budget === "number") setNestWeaverTokenBudget(nw.token_budget);
      }
      const gh = settings.github as Record<string, unknown> | null;
      if (gh && str(gh, "repo_slug")) setGithubRepoSlug(str(gh, "repo_slug")!);
      const ai = settings.ai_chat_import as Record<string, unknown> | null;
      if (ai && str(ai, "folder_path")) setAiChatImportPath(str(ai, "folder_path")!);
      const doc = settings.document_import as Record<string, unknown> | null;
      if (doc && str(doc, "folder_path")) setDocumentImportPath(str(doc, "folder_path")!);
      const md = settings.artifact_destination_markdown_folder as Record<string, unknown> | null;
      if (md && str(md, "folder_path")) setArtifactDestinationPath(str(md, "folder_path")!);
      const obs = settings.artifact_destination_obsidian_vault as Record<string, unknown> | null;
      setArtifactDestinationPathsFromSettings({
        markdown_folder: md && str(md, "folder_path") ? str(md, "folder_path")! : undefined,
        obsidian_vault: obs && str(obs, "folder_path") ? str(obs, "folder_path")! : undefined,
      });
    });
    return () => { mounted = false; };
  }, []);

  // --- System tab state ---
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [schedulerNotice, setSchedulerNotice] = useState("");
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [updateNotice, setUpdateNotice] = useState("");
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [customAccent, setCustomAccent] = useState(() => readThemePreferences().accent ?? DEFAULT_ACCENT);
  const [themeImportText, setThemeImportText] = useState("");
  const [themeExportText, setThemeExportText] = useState("");
  const [themeNotice, setThemeNotice] = useState("");
  const [dockVisible, setDockVisible] = useState(false);
  const [globalShortcut, setGlobalShortcut] = useState("CmdOrCtrl+Shift+R");

  useEffect(() => {
    const preferences = readThemePreferences();
    if (preferences.theme) setTheme(preferences.theme);
    if (preferences.accent) {
      setCustomAccent(preferences.accent);
      applyAccent(preferences.accent);
    }
  }, [setTheme]);

  useEffect(() => {
    let mounted = true;
    void actions.loadSchedulerStatus().then((status) => {
      if (!mounted || !status) return;
      setSchedulerStatus(status);
      setSchedulerEnabled(status.running);
    });
    return () => {
      mounted = false;
    };
  }, [actions]);

  useEffect(() => {
    void getAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    void listPlugins().then(setPlugins);
  }, []);

  useEffect(() => {
    getDockVisibility().then(setDockVisible).catch(() => {});
    getGlobalShortcut().then((s) => setGlobalShortcut(s)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!focusedTargetKey) return;
    const element = document.querySelector<HTMLElement>(
      `[data-settings-target="${focusedTargetKey}"], [data-settings-targets~="${focusedTargetKey}"]`,
    );
    if (!element) return;
    element.focus();
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedTargetKey, normalizedActiveTab]);

  const checkForUpdates = () => {
    setUpdateNotice("You're on the latest version.");
  };

  const recordSettingsChange = (label: string, tab: SettingsTabId, targetKey: string) => {
    const entry = {
      id: `${Date.now()}:${label}`,
      label,
      tab,
      changedAt: new Date().toISOString(),
    };
    setRecentlyChangedKey(targetKey);
    setSettingsHistory((current) => {
      const next = [entry, ...current].slice(0, 8);
      localStorage.setItem("raven:settings-change-history", JSON.stringify(next));
      return next;
    });
  };

  const navItems = [
    { id: "providers", label: "Providers", badge: groupsNeedingAttention },
    {
      id: "context",
      label: "Context",
      badge: state.providers.filter((p) => p.kind === "context" && p.status !== "available").length,
    },
    {
      id: "outputs",
      label: "Outputs",
      badge: state.providers.filter((p) => p.kind === "artifact_destination" && p.status !== "available").length,
    },
    {
      id: "automation",
      label: "Automation",
      badge: state.runs.filter((run) => run.status === "retryable" || run.status === "blocked").length,
    },
    { id: "extensions", label: "Extensions", badge: 0 },
    { id: "system", label: "System", badge: 0 },
  ] as const;
  const destinationPaths = { ...savedArtifactDestinationPaths, ...artifactDestinationPaths };
  const contextSources = [
    {
      id: "local_git",
      title: "Local git",
      description: "Reads recent commits and changed files from this workspace.",
      status: providerStateToReadiness(providersById.get("local_git")?.status ?? "available"),
      summary: providersById.get("local_git")?.summary ?? "Ready for current workspace activity.",
    },
    {
      id: "github",
      title: "GitHub",
      description: "Pulls recent pull requests and issues for repository activity.",
      status: providerStateToReadiness(providersById.get("github")?.status),
      summary: githubRepoSlug.trim()
        ? `${githubRepoSlug.trim()}${providersById.get("github")?.status === "available" ? "" : " saved; token may still be required."}`
        : providersById.get("github")?.summary,
    },
    {
      id: "document_import",
      title: "Documents",
      description: "Reads digital PDFs from a configured local folder.",
      status: providerStateToReadiness(providersById.get("document_import")?.status),
      summary: documentImportPath.trim() || providersById.get("document_import")?.summary,
    },
    {
      id: "ai_chat_import",
      title: "AI chat imports",
      description: "Imports exported AI conversation files from a local folder.",
      status: providerStateToReadiness(providersById.get("ai_chat_import")?.status),
      summary: aiChatImportPath.trim() || providersById.get("ai_chat_import")?.summary,
    },
    {
      id: "nestweaver",
      title: "NestWeaver",
      description: "Indexes codebase structure for richer project context.",
      status: providerStateToReadiness(providersById.get("nestweaver")?.status),
      summary: nestWeaverDbPath.trim() || providersById.get("nestweaver")?.summary,
    },
  ];
  const readyContextSources = contextSources.filter((source) => source.status === "ready").length;
  const artifactDestinationProviders = [
    providersById.get("local_app") ?? {
      id: "local_app",
      name: "Local App Store",
      kind: "artifact_destination",
      status: "available",
      summary: "Stores Markdown plus JSON metadata in local app storage.",
    },
    providersById.get("markdown_folder") ?? {
      id: "markdown_folder",
      name: "Markdown Folder",
      kind: "artifact_destination",
      status: "needs_config",
      summary: "Writes Markdown artifacts to a configured local folder.",
      fallbackProviderId: "local_app",
    },
    providersById.get("obsidian_vault") ?? {
      id: "obsidian_vault",
      name: "Obsidian Vault",
      kind: "artifact_destination",
      status: "needs_config",
      summary: "Writes Markdown artifacts into a configured Obsidian vault folder.",
      fallbackProviderId: "markdown_folder",
    },
  ] satisfies ProviderHealth[];
  const fallbackDestination =
    artifactDestinationProviders.find((provider) => provider.status === "available") ??
    providersById.get("local_app");
  const scheduledWorkflows = state.workflows.filter(
    (workflow) => workflow.status === "enabled" && workflow.definition.schedule?.cadence !== "manual",
  );
  const scheduledWithNextRun = scheduledWorkflows
    .map((workflow) => ({
      workflow,
      nextRun: getNextRunTime(workflow.definition.schedule),
    }))
    .sort((a, b) => (a.nextRun ?? "").localeCompare(b.nextRun ?? ""));
  const nextScheduledRun = scheduledWithNextRun[0];
  const retryableRuns = state.runs.filter((run) => run.status === "retryable" || run.status === "blocked");
  const approvalDefaults = state.workflows.reduce<Record<string, number>>((counts, workflow) => {
    const label = workflowApprovalLabel(workflow);
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <section className="view-grid">
      <header className="page-header">
        <div>
          <SettingsBreadcrumbs
            activeTab={normalizedActiveTab}
            target={settingsFocusTarget}
            onNavigate={setActiveSettingsTab}
          />
          <h1>Settings</h1>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-item${normalizedActiveTab === item.id ? " active" : ""}`}
              onClick={() => setActiveSettingsTab(item.id)}
              aria-current={normalizedActiveTab === item.id ? "page" : undefined}
            >
              {item.label}
              {item.badge > 0 && (
                <span className="settings-nav-badge">{item.badge}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {/* Providers */}
          {normalizedActiveTab === "providers" && (
            <section>
              <div className="settings-status-bar">
                <span>{readyProviderGroups.length} of {providerGroups.length} provider groups ready</span>
                <button
                  type="button"
                  onClick={async () => setReadinessNotice(await actions.refreshProviderReadiness())}
                >
                  Refresh
                </button>
                {readinessNotice && <span className="success-note">{readinessNotice}</span>}
              </div>

              <ToolsAutonomyPanel
                autonomyMode={state.autonomyMode}
                categoryOverrides={state.autonomyCategoryOverrides}
                capabilities={state.capabilityRegistry.capabilities}
                rawTools={state.rawToolInventory}
                grants={state.approvalGrants}
                onModeChange={actions.setAutonomyMode}
                onCategoryOverrideChange={actions.setAutonomyCategoryOverride}
                onRefreshTools={actions.refreshCapabilityRegistry}
                onRevokeGrant={actions.revokeApprovalGrant}
              />

              {unreadyProviderGroups.length > 0 && (
                <div>
                  <h2>Setup required</h2>
                  <p>These provider groups need a working profile before live generation can use them.</p>
                  <div className="settings-cards">
                    {unreadyProviderGroups.map((group) => {
                      const groupTargetKey = settingsTargetKey("provider", slugTargetId(group.groupName));
                      const profileTargetKeys = group.profiles.map((profile) => settingsTargetKey("provider", profile.id));
                      return (
                      <section
                        key={group.groupName}
                        role="region"
                        aria-label={`${group.groupName} provider settings`}
                        tabIndex={-1}
                        data-settings-target={groupTargetKey}
                        data-settings-targets={[groupTargetKey, ...profileTargetKeys].join(" ")}
                        className={
                          focusedTargetKey === groupTargetKey || profileTargetKeys.includes(focusedTargetKey)
                            ? "settings-targeted"
                            : undefined
                        }
                      >
                        <ProviderGroupCard
                          group={group}
                          onConfigureKey={(profileId, apiKey) =>
                            void actions.configureProviderCredential(profileId, apiKey)
                          }
                        />
                      </section>
                    );
                    })}
                  </div>
                </div>
              )}

              <div>
                <h2>Ready providers</h2>
                <p>Ready groups can run workflow agent steps immediately.</p>
                <div className="settings-cards">
                  {readyProviderGroups.map((group) => {
                    const groupTargetKey = settingsTargetKey("provider", slugTargetId(group.groupName));
                    const profileTargetKeys = group.profiles.map((profile) => settingsTargetKey("provider", profile.id));
                    return (
                    <section
                      key={group.groupName}
                      role="region"
                      aria-label={`${group.groupName} provider settings`}
                      tabIndex={-1}
                      data-settings-target={groupTargetKey}
                      data-settings-targets={[groupTargetKey, ...profileTargetKeys].join(" ")}
                      className={
                        focusedTargetKey === groupTargetKey || profileTargetKeys.includes(focusedTargetKey)
                          ? "settings-targeted"
                          : undefined
                      }
                    >
                      <ProviderGroupCard
                        group={group}
                        onConfigureKey={(profileId, apiKey) =>
                          void actions.configureProviderCredential(profileId, apiKey)
                        }
                      />
                    </section>
                    );
                  })}
                  {readyProviderGroups.length === 0 && (
                    <p className="empty-state">No provider groups are ready yet.</p>
                  )}
                </div>
              </div>

            </section>
          )}

          {/* Context Sources */}
          {normalizedActiveTab === "context" && (
            <section>
              <div className="settings-status-bar">
                <span>{readyContextSources} of {contextSources.length} context sources ready</span>
                <span className="settings-card-detail">Local git remains the fallback when optional sources are not configured.</span>
                <button type="button" disabled aria-label="Restore Context defaults unavailable">
                  Restore defaults unavailable
                </button>
              </div>

              <ContextSourceCard
                title="Local git"
                description={contextSources[0].description}
                status={contextSources[0].status}
                statusLabel={readinessLabel(contextSources[0].status)}
                summary={contextSources[0].summary}
              >
                <p className="settings-card-detail">
                  Local git context is built in and supplies recent commits, changed files, and workspace activity.
                </p>
              </ContextSourceCard>

              <section
                role="region"
                aria-label="GitHub context settings"
                tabIndex={-1}
                data-settings-target={settingsTargetKey("context-source", "github")}
                className={focusedTargetKey === settingsTargetKey("context-source", "github") ? "settings-targeted" : undefined}
              >
                {recentlyChangedKey === settingsTargetKey("context-source", "github") && (
                  <span className="settings-recently-changed">Recently changed</span>
                )}
                <ContextSourceCard
                  title="GitHub"
                  description={contextSources[1].description}
                  status={contextSources[1].status}
                  statusLabel={readinessLabel(contextSources[1].status)}
                  summary={contextSources[1].summary}
                >
                  <form
                    className="credential-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const notice = await actions.configureGithubContext(githubRepoSlug, githubToken);
                      if (githubToken.trim()) setGithubToken("");
                      setGithubNotice(notice);
                      recordSettingsChange(
                        "GitHub context saved",
                        "context",
                        settingsTargetKey("context-source", "github"),
                      );
                    }}
                  >
                    <label>
                      GitHub repository
                      <input
                        value={githubRepoSlug}
                        onChange={(e) => setGithubRepoSlug(e.currentTarget.value)}
                        placeholder="owner/repo"
                      />
                    </label>
                    <label>
                      GitHub token
                      <input
                        type="password"
                        value={githubToken}
                        onChange={(e) => setGithubToken(e.currentTarget.value)}
                        placeholder="Optional if GITHUB_TOKEN is set"
                      />
                    </label>
                    <button
                      className="primary-action"
                      type="submit"
                      disabled={!githubRepoSlug.trim()}
                    >
                      Save GitHub context
                    </button>
                    <button
                      type="button"
                      disabled={!githubRepoSlug.trim()}
                      onClick={async () => {
                        const pack = await actions.scanGithubContext();
                        setGithubPack(pack);
                        setGithubNotice(
                          pack ? pack.summary.split("\n")[0] : "GitHub context scan unavailable",
                        );
                      }}
                    >
                      Scan GitHub context
                    </button>
                  </form>
                  {githubNotice && <span className="success-note">{githubNotice}</span>}
                  {githubPack && githubPack.sourceRefs.length > 0 && (
                    <ul className="source-ref-list">
                      {githubPack.sourceRefs.map((ref) => (
                        <li key={ref}>{githubSourceLabel(ref)}</li>
                      ))}
                    </ul>
                  )}
                </ContextSourceCard>
              </section>

              <section
                role="region"
                aria-label="Documents context settings"
                tabIndex={-1}
                data-settings-target={settingsTargetKey("context-source", "document_import")}
                className={focusedTargetKey === settingsTargetKey("context-source", "document_import") ? "settings-targeted" : undefined}
              >
                <ContextSourceCard
                  title="Documents"
                  description={contextSources[2].description}
                  status={contextSources[2].status}
                  statusLabel={readinessLabel(contextSources[2].status)}
                  summary={contextSources[2].summary}
                >
                  <form
                    className="credential-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const notice = await actions.configureDocumentImportFolder(documentImportPath);
                      setDocumentImportNotice(notice);
                    }}
                  >
                    <label>
                      PDF document import folder
                      <input
                        value={documentImportPath}
                        onChange={(e) => setDocumentImportPath(e.currentTarget.value)}
                        placeholder="~/Documents/Raven PDFs"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={async () => {
                        const selected = await actions.chooseDocumentImportFolderPath();
                        if (selected) setDocumentImportPath(selected);
                      }}
                    >
                      <FolderOpen size={16} />
                      Choose folder
                    </button>
                    <button
                      className="primary-action"
                      type="submit"
                      disabled={!documentImportPath.trim()}
                    >
                      Save document folder
                    </button>
                    <button
                      type="button"
                      disabled={!documentImportPath.trim()}
                      onClick={async () => {
                        const pack = await actions.scanDocumentImportFolder();
                        setDocumentImportPack(pack);
                        setDocumentImportNotice(
                          pack
                            ? pack.summary.split("\n")[0]
                            : "PDF document import scan unavailable",
                        );
                      }}
                    >
                      Scan document folder
                    </button>
                  </form>
                  {documentImportNotice && (
                    <span className="success-note">{documentImportNotice}</span>
                  )}
                  {documentImportPack && documentImportPack.sourceRefs.length > 0 && (
                    <ul className="source-ref-list">
                      {documentImportPack.sourceRefs.map((ref) => (
                        <li key={ref}>{ref.split("/").pop() ?? ref}</li>
                      ))}
                    </ul>
                  )}
                </ContextSourceCard>
              </section>

              <section
                role="region"
                aria-label="AI chat imports context settings"
                tabIndex={-1}
                data-settings-target={settingsTargetKey("context-source", "ai_chat_import")}
                className={focusedTargetKey === settingsTargetKey("context-source", "ai_chat_import") ? "settings-targeted" : undefined}
              >
                <ContextSourceCard
                  title="AI Chat imports"
                  description={contextSources[3].description}
                  status={contextSources[3].status}
                  statusLabel={readinessLabel(contextSources[3].status)}
                  summary={contextSources[3].summary}
                >
                  <form
                    className="credential-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const notice = await actions.configureAiChatImportFolder(aiChatImportPath);
                      setAiChatImportNotice(notice);
                    }}
                  >
                    <label>
                      AI chat import folder
                      <input
                        value={aiChatImportPath}
                        onChange={(e) => setAiChatImportPath(e.currentTarget.value)}
                        placeholder="~/Documents/AI Chat Exports"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={async () => {
                        const selected = await actions.chooseAiChatImportFolderPath();
                        if (selected) setAiChatImportPath(selected);
                      }}
                    >
                      <FolderOpen size={16} />
                      Choose folder
                    </button>
                    <button
                      className="primary-action"
                      type="submit"
                      disabled={!aiChatImportPath.trim()}
                    >
                      Save AI chat folder
                    </button>
                    <button
                      type="button"
                      disabled={!aiChatImportPath.trim()}
                      onClick={async () => {
                        const pack = await actions.scanAiChatImportFolder();
                        setAiChatImportPack(pack);
                        setAiChatImportNotice(
                          pack ? pack.summary.split("\n")[0] : "AI chat import scan unavailable",
                        );
                      }}
                    >
                      Scan AI chat import folder
                    </button>
                  </form>
                  {aiChatImportNotice && <span className="success-note">{aiChatImportNotice}</span>}
                  {aiChatImportPack && aiChatImportPack.sourceRefs.length > 0 && (
                    <ul className="source-ref-list">
                      {aiChatImportPack.sourceRefs.map((ref) => (
                        <li key={ref}>{ref.split("/").pop() ?? ref}</li>
                      ))}
                    </ul>
                  )}
                </ContextSourceCard>
              </section>

              <section
                role="region"
                aria-label="NestWeaver context settings"
                tabIndex={-1}
                data-settings-target={settingsTargetKey("context-source", "nestweaver")}
                className={focusedTargetKey === settingsTargetKey("context-source", "nestweaver") ? "settings-targeted" : undefined}
              >
                <ContextSourceCard
                  title="NestWeaver"
                  description={contextSources[4].description}
                  status={contextSources[4].status}
                  statusLabel={readinessLabel(contextSources[4].status)}
                  summary={contextSources[4].summary}
                >
                <form
                  className="credential-form stacked-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    setNestWeaverNotice(
                      await actions.configureNestWeaver(
                        nestWeaverBinaryPath,
                        nestWeaverDbPath,
                        nestWeaverProject,
                        nestWeaverTokenBudget,
                      ),
                    );
                  }}
                >
                  <label>
                    Binary
                    <input
                      value={nestWeaverBinaryPath}
                      onChange={(e) => setNestWeaverBinaryPath(e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Database
                    <input
                      value={nestWeaverDbPath}
                      onChange={(e) => setNestWeaverDbPath(e.currentTarget.value)}
                      placeholder="~/path/to/nestweaver.lbug"
                    />
                  </label>
                  <label>
                    Project
                    {nestWeaverProjects.length > 0 ? (
                      <select
                        value={nestWeaverProject}
                        onChange={(e) => setNestWeaverProject(e.currentTarget.value)}
                      >
                        {nestWeaverProjects.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={nestWeaverProject}
                        onChange={(e) => setNestWeaverProject(e.currentTarget.value)}
                        placeholder="raven"
                      />
                    )}
                  </label>
                  <label>
                    Token budget
                    <input
                      min={500}
                      step={500}
                      type="number"
                      value={nestWeaverTokenBudget}
                      onChange={(e) =>
                        setNestWeaverTokenBudget(Number(e.currentTarget.value) || 4000)
                      }
                    />
                  </label>
                  <button className="primary-action" type="submit">
                    Save NestWeaver
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const pack = await actions.scanNestWeaverProject();
                      setNestWeaverPack(pack);
                      setNestWeaverNotice(
                        pack ? pack.summary.split("\n")[0] : "NestWeaver scan unavailable",
                      );
                    }}
                  >
                    Scan NestWeaver
                  </button>
                </form>
                {nestWeaverNotice && <span className="success-note">{nestWeaverNotice}</span>}
                {nestWeaverPack && nestWeaverPack.sourceRefs.length > 0 && (
                  <ul className="source-ref-list">
                    {nestWeaverPack.sourceRefs.map((ref) => (
                      <li key={ref}>{ref}</li>
                    ))}
                  </ul>
                )}
                </ContextSourceCard>
              </section>
            </section>
          )}

          {/* Outputs */}
          {normalizedActiveTab === "outputs" && (
            <section>
              <div className="settings-status-bar">
                <span>{artifactDestinationProviders.filter((p) => p.status === "available").length} of {artifactDestinationProviders.length} destinations ready</span>
                <span className="settings-card-detail">
                  Fallback: {fallbackDestination?.name ?? "Local App Store"}
                </span>
              </div>

              <div className="settings-cards">
                {artifactDestinationProviders.map((provider) => {
                  const path = destinationPaths[provider.id as ArtifactDestinationId] ??
                    (provider.id === "local_app" ? "Local app storage" : "");
                  const fallback = provider.fallbackProviderId
                    ? providersById.get(provider.fallbackProviderId)?.name ?? provider.fallbackProviderId
                    : "None";
                  return (
                    <article
                      className={`settings-card settings-readiness-card${
                        focusedTargetKey === settingsTargetKey("output", provider.id) ? " settings-targeted" : ""
                      }`}
                      key={provider.id}
                      tabIndex={-1}
                      data-settings-target={settingsTargetKey("output", provider.id)}
                    >
                      <div className="settings-card-header">
                        <strong>{provider.name}</strong>
                        <span className={`readiness-pill readiness-pill-${provider.status}`}>
                          {providerStatusLabel(provider.status)}
                        </span>
                      </div>
                      <p>{provider.summary}</p>
                      <dl className="settings-compact-dl">
                        <dt>Path</dt>
                        <dd>{path || "No folder configured"}</dd>
                        <dt>Fallback</dt>
                        <dd>{fallback}</dd>
                      </dl>
                    </article>
                  );
                })}
              </div>

              <div className="settings-card">
                <h2>Artifact destinations</h2>
                <form
                  className="credential-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const notice = await actions.configureArtifactDestination(
                      artifactDestinationId,
                      artifactDestinationPath,
                    );
                    if (isSuccessfulSettingsNotice(notice)) {
                      setSavedArtifactDestinationPaths((current) => ({
                        ...current,
                        [artifactDestinationId]: artifactDestinationPath,
                      }));
                    }
                    setArtifactDestinationNotice(notice);
                  }}
                >
                  <label>
                    Artifact destination
                    <select
                      value={artifactDestinationId}
                      onChange={(e) => {
                        const id = e.currentTarget.value as ArtifactDestinationId;
                        setArtifactDestinationId(id);
                        setArtifactDestinationPath(destinationPaths[id] ?? "");
                      }}
                    >
                      <option value="markdown_folder">Markdown Folder</option>
                      <option value="obsidian_vault">Obsidian Vault</option>
                    </select>
                  </label>
                  <label>
                    Destination folder
                    <input
                      value={artifactDestinationPath}
                      onChange={(e) => setArtifactDestinationPath(e.currentTarget.value)}
                      placeholder="~/Documents/Raven"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={async () => {
                      const selected = await actions.chooseArtifactDestinationFolderPath();
                      if (selected) setArtifactDestinationPath(selected);
                    }}
                  >
                    <FolderOpen size={16} />
                    Choose destination folder
                  </button>
                  <button
                    className="primary-action"
                    type="submit"
                    disabled={!artifactDestinationPath.trim()}
                  >
                    Save artifact destination
                  </button>
                </form>
                {artifactDestinationNotice && (
                  <span className={isSuccessfulSettingsNotice(artifactDestinationNotice) ? "success-note" : "error-note"}>
                    {artifactDestinationNotice}
                  </span>
                )}
              </div>
            </section>
          )}

          {/* Automation */}
          {normalizedActiveTab === "automation" && (
            <section>
              <section
                className={`settings-card${focusedTargetKey === settingsTargetKey("automation", "scheduler") ? " settings-targeted" : ""}`}
                role="region"
                aria-label="Scheduler settings"
                tabIndex={-1}
                data-settings-target={settingsTargetKey("automation", "scheduler")}
              >
                <h2>Scheduler</h2>
                {schedulerStatus && (
                  <span className="success-note">
                    Scheduler {schedulerStatus.running ? "running" : "stopped"} · checks every{" "}
                    {schedulerStatus.pollIntervalSeconds}s
                  </span>
                )}
                <label className="toggle-row">
                  <input
                    checked={schedulerEnabled}
                    type="checkbox"
                    onChange={async (e) => {
                      const enabled = e.currentTarget.checked;
                      setSchedulerEnabled(enabled);
                      setSchedulerNotice(await actions.toggleScheduler(enabled));
                      setSchedulerStatus((current) =>
                        current ? { ...current, running: enabled } : current,
                      );
                    }}
                  />
                  Scheduled workflow checks
                </label>
                <button type="button" onClick={() => void actions.runDueSchedules()}>
                  Run due schedules now
                </button>
                {schedulerNotice && <span className="success-note">{schedulerNotice}</span>}
                {runNotice && <span className="success-note">{runNotice}</span>}
              </section>

              <div className="settings-cards">
                <article className="settings-card settings-readiness-card">
                  <h2>Due schedules</h2>
                  <dl className="settings-compact-dl">
                    <dt>Scheduled workflows</dt>
                    <dd>{scheduledWorkflows.length}</dd>
                    <dt>Next run</dt>
                    <dd>
                      {nextScheduledRun
                        ? `${nextScheduledRun.workflow.definition.name} · ${formatDateTime(nextScheduledRun.nextRun)}`
                        : "No enabled schedules"}
                    </dd>
                    <dt>Check interval</dt>
                    <dd>
                      {schedulerStatus
                        ? `${schedulerStatus.pollIntervalSeconds}s`
                        : "Scheduler status unavailable"}
                    </dd>
                  </dl>
                </article>

                <article className="settings-card settings-readiness-card">
                  <h2>Retry queue</h2>
                  <p>
                    {retryableRuns.length > 0
                      ? `${retryableRuns.length} run${retryableRuns.length === 1 ? "" : "s"} require retry or setup.`
                      : "No retryable or blocked runs."}
                  </p>
                  {retryableRuns.length > 0 && (
                    <ul className="source-ref-list">
                      {retryableRuns.slice(0, 4).map((run) => (
                        <li key={run.id}>{run.workflowName}: {run.setupAction ?? run.failureReason ?? run.status}</li>
                      ))}
                    </ul>
                  )}
                </article>

                <article className="settings-card settings-readiness-card">
                  <h2>Approval defaults</h2>
                  <dl className="settings-compact-dl">
                    {Object.entries(approvalDefaults).map(([label, count]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{count}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              </div>

              <div className="settings-card">
                <h2>Scheduled workflows</h2>
                {scheduledWithNextRun.length === 0 ? (
                  <p className="empty-state">No enabled workflow schedules.</p>
                ) : (
                  <div className="settings-table">
                    {scheduledWithNextRun.map(({ workflow, nextRun }) => (
                      <div className="settings-table-row" key={workflow.id}>
                        <strong>{workflow.definition.name}</strong>
                        <span>{formatSchedule(workflow.definition.schedule)}</span>
                        <span>{formatDateTime(nextRun)}</span>
                        <span>{workflowApprovalLabel(workflow)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Extensions */}
          {normalizedActiveTab === "extensions" && (
            <section>
              <div className="settings-status-bar">
                <span>{plugins.length} extension{plugins.length === 1 ? "" : "s"} installed</span>
                <button type="button" onClick={() => setView("marketplace")}>
                  Open templates
                </button>
              </div>

              <div className="settings-card">
                <h2>Templates</h2>
                <p>Workflow templates are available from Workflows / Templates.</p>
                <button type="button" onClick={() => setView("marketplace")}>
                  Browse templates
                </button>
              </div>

              <div>
                <h2>Extension capabilities</h2>
                {plugins.length === 0 ? (
                  <p className="empty-state">No extensions installed. Workflows currently use built-in steps only.</p>
                ) : (
                  <div className="settings-cards">
                    {plugins.map((plugin) => (
                      <article className="settings-card" key={plugin.id}>
                        <div className="settings-card-header">
                          <strong>{plugin.name}</strong>
                          <span className="settings-card-detail">v{plugin.version}</span>
                        </div>
                        <p>{plugin.description || "No description provided by the extension."}</p>
                        {plugin.steps.length > 0 ? (
                          <div className="settings-plugin-capabilities">
                            {plugin.steps.map((step) => (
                              <div
                                className="settings-plugin-capability"
                                key={`${plugin.id}-${step.provider}-${step.action}`}
                              >
                                <strong>{step.displayName}</strong>
                                <span className="settings-card-detail">
                                  {step.provider}.{step.action}
                                </span>
                                <span className="settings-card-detail">
                                  Permissions: {step.permissions.join(", ") || "None"}
                                </span>
                                {step.execution?.command && (
                                  <span className="settings-card-detail">
                                    Command: {step.execution.command}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="settings-card-detail">No executable steps</span>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* System */}
          {normalizedActiveTab === "system" && (
            <section>
              <div className="settings-card">
                <h2>Menu Bar</h2>
                <p>Control how Raven appears in your system.</p>
                <label>
                  Show in Dock
                  <span className="settings-card-detail">
                    When off, Raven runs as a menu bar app only
                  </span>
                  <input
                    type="checkbox"
                    checked={dockVisible}
                    onChange={async (e) => {
                      const visible = e.target.checked;
                      setDockVisible(visible);
                      await setDockVisibility(visible);
                    }}
                  />
                </label>
                <label>
                  Global Shortcut
                  <span className="settings-card-detail">
                    Opens Raven from anywhere
                  </span>
                  <input
                    type="text"
                    value={globalShortcut.replace(/CmdOrCtrl/g, "⌘").replace(/\+/g, " ")}
                    onKeyDown={(e) => {
                      e.preventDefault();
                      const parts: string[] = [];
                      if (e.metaKey) parts.push("CmdOrCtrl");
                      if (e.shiftKey) parts.push("Shift");
                      if (e.altKey) parts.push("Alt");
                      if (e.ctrlKey && !e.metaKey) parts.push("Ctrl");
                      const key = e.key;
                      const isModifier = ["Meta", "Shift", "Alt", "Control"].includes(key);
                      if (!isModifier && parts.length > 0) {
                        parts.push(key.length === 1 ? key.toUpperCase() : key);
                        const shortcut = parts.join("+");
                        setGlobalShortcut(shortcut);
                        void tauriSetGlobalShortcut(shortcut);
                      }
                    }}
                    readOnly
                    placeholder="Press keys..."
                  />
                </label>
              </div>

              <div className="settings-card">
                <h2>Default AI</h2>
                <p>Which AI provider Raven uses to build workflows.</p>
                <label>
                  Active builder
                  <select
                    value={builderProfileId}
                    onChange={(e) => actions.updateBuilderProfile(e.currentTarget.value)}
                  >
                    {agentAuthProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="settings-card">
                <h2>Generation Settings</h2>
                {llmProfile && (
                  <dl>
                    <dt>Builder</dt>
                    <dd>{selectedBuilder?.displayName ?? builderProfileId}</dd>
                    <dt>Provider</dt>
                    <dd>{llmProfile.providerId}</dd>
                    <dt>Model</dt>
                    <dd>{llmProfile.model}</dd>
                    <dt>Effort</dt>
                    <dd>{llmProfile.effort}</dd>
                    <dt>Structured output</dt>
                    <dd>{llmProfile.supportsStructuredOutputs ? "Enabled" : "Unavailable"}</dd>
                  </dl>
                )}
              </div>

              <div className="settings-card settings-appearance-card" role="region" aria-label="Appearance settings">
                <div className="settings-card-header">
                  <h2>Appearance</h2>
                  <Palette size={18} aria-hidden="true" />
                </div>
                <div className="appearance-controls">
                  <label>
                    Theme
                    <select
                      aria-label="Appearance theme"
                      value={theme}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        if (!isAppearanceTheme(next)) return;
                        setTheme(next);
                        persistThemePreferences(next, customAccent);
                        setThemeNotice("Theme saved locally.");
                        recordSettingsChange("Appearance theme saved", "system", settingsTargetKey("system", "appearance"));
                      }}
                    >
                      <option value="aurora-dark">Aurora dark</option>
                      <option value="aurora-light">Aurora light</option>
                    </select>
                  </label>
                  <label>
                    Accent
                    <span className="appearance-accent-row">
                      <input
                        type="color"
                        aria-label="Custom accent color"
                        value={customAccent}
                        onChange={(event) => {
                          const next = event.currentTarget.value;
                          setCustomAccent(next);
                          applyAccent(next);
                          persistThemePreferences(theme, next);
                          setThemeNotice("Accent saved locally.");
                        }}
                      />
                      <input
                        value={customAccent}
                        onChange={(event) => {
                          const next = event.currentTarget.value.trim();
                          setCustomAccent(next);
                          if (isHexColor(next)) {
                            applyAccent(next);
                            persistThemePreferences(theme, next);
                            setThemeNotice("Accent saved locally.");
                          }
                        }}
                        aria-label="Custom accent hex"
                      />
                    </span>
                  </label>
                </div>
                <div className="appearance-actions">
                  <button
                    type="button"
                    onClick={() => {
                      const preferences = buildThemePreferences(theme, customAccent);
                      persistThemePreferences(theme, customAccent);
                      const json = JSON.stringify(preferences, null, 2);
                      setThemeExportText(json);
                      downloadThemePreferences(preferences);
                      setThemeNotice("Theme exported.");
                    }}
                  >
                    <Download size={15} />
                    Export theme
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const imported = parseThemePreferences(themeImportText);
                      if (!imported) {
                        setThemeNotice("Theme import must be valid raven.theme.v1 JSON.");
                        return;
                      }
                      setTheme(imported.theme);
                      setCustomAccent(imported.accent);
                      applyAccent(imported.accent);
                      persistThemePreferences(imported.theme, imported.accent);
                      setThemeExportText(JSON.stringify(imported, null, 2));
                      setThemeNotice("Theme imported.");
                      recordSettingsChange("Appearance theme imported", "system", settingsTargetKey("system", "appearance"));
                    }}
                  >
                    <Upload size={15} />
                    Import theme
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearAccent();
                      setCustomAccent(DEFAULT_ACCENT);
                      localStorage.removeItem(THEME_PREFERENCES_STORAGE_KEY);
                      setThemeNotice("Theme reset locally.");
                    }}
                  >
                    Reset appearance
                  </button>
                </div>
                <label>
                  Theme import JSON
                  <textarea
                    value={themeImportText}
                    onChange={(event) => setThemeImportText(event.currentTarget.value)}
                    aria-label="Theme import JSON"
                    rows={4}
                  />
                </label>
                {themeExportText && (
                  <label>
                    Last exported theme JSON
                    <textarea
                      value={themeExportText}
                      aria-label="Last exported theme JSON"
                      readOnly
                      rows={4}
                    />
                  </label>
                )}
                {themeNotice && <span className="success-note">{themeNotice}</span>}
              </div>

              <div className="settings-card">
                <h2>About</h2>
                <dl>
                  <dt>Version</dt>
                  <dd>{appVersion}</dd>
                  <dt>Framework</dt>
                  <dd>Tauri v2</dd>
                </dl>
                <button type="button" onClick={checkForUpdates}>
                  Check for updates
                </button>
                {updateNotice && <span className="success-note">{updateNotice}</span>}
              </div>
            </section>
          )}

          <section className="settings-history-panel" role="region" aria-label="Settings change history">
            <h2>Change history</h2>
            {settingsHistory.length === 0 ? (
              <p className="empty-state">No settings changes recorded in this local session.</p>
            ) : (
              <ol>
                {settingsHistory.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.label}</strong>
                    <span>{new Date(entry.changedAt).toLocaleString()}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
