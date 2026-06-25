import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type {
  CommandCenterTarget,
  PlannerRationale,
  RavenWorkflow,
  ThemeName,
  ViewName,
} from "../../domain/types";

export type CreateWorkflowPath = "describe" | "template" | "import" | "manual";
export type WorkflowDetailFocus = "usage" | "run-history" | null;
export type SettingsTabId = "general" | "context" | "tools" | "advanced";
export type SettingsFocusTarget =
  | { type: "provider"; id: string; label?: string }
  | { type: "context-source"; id: string; label?: string }
  | { type: "automation"; id: "scheduler"; label?: string }
  | { type: "output"; id: string; label?: string };

export interface WorkflowRosterCommand {
  id: number;
  statuses?: string[];
  schedules?: string[];
  sortKey?: string;
}

export interface CreateWorkflowDraftReview {
  definition: RavenWorkflow;
  sourceLabel: string;
  validationErrors?: string[];
  plannerRationale?: PlannerRationale | null;
  diffJson?: unknown;
  marketplace?: {
    templateId: string;
    version: string;
    sourceKind: "first-party" | "community";
  };
}

export interface CreateWorkflowHubState {
  selectedPath: CreateWorkflowPath;
  prompt: string;
  importText: string;
  templateSearch: string;
  templateCategory: string;
  templateId: string;
  draft: CreateWorkflowDraftReview | null;
  reviewVisible: boolean;
}

type CreateWorkflowHubStatePatch = Partial<CreateWorkflowHubState>;
type WorkflowDetailExitGuard = () => boolean;

const initialCreateWorkflowHubState: CreateWorkflowHubState = {
  selectedPath: "describe",
  prompt: "",
  importText: "",
  templateSearch: "",
  templateCategory: "all",
  templateId: "",
  draft: null,
  reviewVisible: false,
};

interface UIState {
  theme: ThemeName;
  view: ViewName;
  workflowDetailOrigin: ViewName | null;
  sidebarCollapsed: boolean;
  assistantOpen: boolean;
  commandPaletteOpen: boolean;
  createWorkflowHubOpen: boolean;
  createWorkflowHubState: CreateWorkflowHubState;
  commandCenterTarget: CommandCenterTarget;
  selectedArtifactId: string;
  selectedWorkflowId: string;
  selectedRunId: string;
  workflowDetailFocus: WorkflowDetailFocus;
  activeSettingsTab: SettingsTabId;
  settingsFocusTarget: SettingsFocusTarget | null;
  workflowRosterCommand: WorkflowRosterCommand | null;
}

interface UIActions {
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
  setView: (view: ViewName) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setAssistantOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  openCreateWorkflowHub: (statePatch?: CreateWorkflowHubStatePatch) => void;
  closeCreateWorkflowHub: () => void;
  updateCreateWorkflowHubState: (statePatch: CreateWorkflowHubStatePatch) => void;
  resetCreateWorkflowHubState: () => void;
  setCommandCenterTarget: (target: CommandCenterTarget) => void;
  openCommandCenterTarget: (target: CommandCenterTarget) => void;
  setSelectedArtifactId: (id: string) => void;
  setSelectedWorkflowId: (id: string) => void;
  setSelectedRunId: (id: string) => void;
  openWorkflow: (workflowId: string, origin?: ViewName, focus?: WorkflowDetailFocus) => void;
  openWorkflowRun: (workflowId: string, runId: string, origin?: ViewName, focus?: WorkflowDetailFocus) => void;
  returnFromWorkflowDetail: () => void;
  setWorkflowDetailExitGuard: (guard: WorkflowDetailExitGuard | null) => void;
  openArtifact: (artifactId: string) => void;
  setActiveSettingsTab: (tab: SettingsTabId) => void;
  setSettingsFocusTarget: (target: SettingsFocusTarget | null) => void;
  openSettingsTarget: (tab: SettingsTabId, target?: SettingsFocusTarget | null) => void;
  setWorkflowRosterCommand: (command: Omit<WorkflowRosterCommand, "id">) => void;
}

type UIContextValue = UIState & UIActions;

const UIContext = createContext<UIContextValue | null>(null);

function parseSettingsHash(): {
  view: ViewName;
  tab: SettingsTabId;
  target: SettingsFocusTarget | null;
} {
  if (typeof window === "undefined") {
    return { view: "home", tab: "general", target: null };
  }
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] !== "settings") {
    return { view: "home", tab: "general", target: null };
  }
  const tab = isSettingsTabId(parts[1]) ? parts[1] : "general";
  return { view: "settings", tab, target: settingsTargetFromHash(tab, parts[2]) };
}

function isSettingsTabId(value: unknown): value is SettingsTabId {
  return (
    value === "general" ||
    value === "context" ||
    value === "tools" ||
    value === "advanced"
  );
}

function settingsTargetFromHash(tab: SettingsTabId, anchor?: string): SettingsFocusTarget | null {
  if (!anchor) return tab === "advanced" ? { type: "automation", id: "scheduler", label: "Scheduler" } : null;
  if (tab === "context") {
    const labels: Record<string, string> = {
      github: "GitHub",
      document_import: "Documents",
      ai_chat_import: "AI chat imports",
      nestweaver: "NestWeaver",
    };
    return { type: "context-source", id: anchor, label: labels[anchor] ?? anchor };
  }
  if (tab === "advanced" && anchor === "scheduler") {
    return { type: "automation", id: "scheduler", label: "Scheduler" };
  }
  if (tab === "general") return { type: "provider", id: anchor, label: anchor };
  return null;
}

function hashForSettingsTarget(tab: SettingsTabId, target?: SettingsFocusTarget | null): string {
  const anchor = target?.id ?? (tab === "advanced" ? "scheduler" : "");
  return `#settings/${tab}${anchor ? `/${anchor}` : ""}`;
}

function replaceHash(hash: string) {
  if (typeof window === "undefined") return;
  if (window.location.hash === hash) return;
  window.history.replaceState(null, "", hash);
}

export function UIProvider({ children }: { children: ReactNode }) {
  const initialSettingsRoute = parseSettingsHash();
  const [theme, setTheme] = useState<ThemeName>("aurora-dark");
  const [view, setCurrentView] = useState<ViewName>(initialSettingsRoute.view);
  const [workflowDetailOrigin, setWorkflowDetailOrigin] = useState<ViewName | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [createWorkflowHubOpen, setCreateWorkflowHubOpen] = useState(false);
  const [createWorkflowHubState, setCreateWorkflowHubState] =
    useState<CreateWorkflowHubState>(initialCreateWorkflowHubState);
  const [commandCenterTarget, setCommandCenterTarget] = useState<CommandCenterTarget>("overview");
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [workflowDetailFocus, setWorkflowDetailFocus] = useState<WorkflowDetailFocus>(null);
  const [activeSettingsTab, setActiveSettingsTabState] = useState<SettingsTabId>(initialSettingsRoute.tab);
  const [settingsFocusTarget, setSettingsFocusTarget] = useState<SettingsFocusTarget | null>(initialSettingsRoute.target);
  const [workflowRosterCommand, setWorkflowRosterCommandState] = useState<WorkflowRosterCommand | null>(null);
  const [workflowDetailExitGuard, setWorkflowDetailExitGuardState] = useState<WorkflowDetailExitGuard | null>(null);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "aurora-dark" ? "aurora-light" : "aurora-dark"));
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => !c);
  }, []);

  const setView = useCallback((nextView: ViewName) => {
    setCurrentView(nextView);
  }, []);

  const setActiveSettingsTab = useCallback((tab: SettingsTabId) => {
    setActiveSettingsTabState(tab);
    const target = tab === "advanced" ? { type: "automation", id: "scheduler", label: "Scheduler" } as const : null;
    setSettingsFocusTarget(target);
    replaceHash(hashForSettingsTarget(tab, target));
  }, []);

  const openSettingsTarget = useCallback((tab: SettingsTabId, target?: SettingsFocusTarget | null) => {
    setActiveSettingsTabState(tab);
    setSettingsFocusTarget(target ?? null);
    setCurrentView("settings");
    replaceHash(hashForSettingsTarget(tab, target));
  }, []);

  const setWorkflowRosterCommand = useCallback((command: Omit<WorkflowRosterCommand, "id">) => {
    setWorkflowRosterCommandState((current) => ({
      ...command,
      id: (current?.id ?? 0) + 1,
    }));
    setCurrentView("workflows");
  }, []);

  const openCommandCenterTarget = useCallback((target: CommandCenterTarget) => {
    setCommandCenterTarget(target);
    setCurrentView("home");
  }, []);

  const openCreateWorkflowHub = useCallback((statePatch?: CreateWorkflowHubStatePatch) => {
    if (statePatch) {
      setCreateWorkflowHubState((current) => ({ ...current, ...statePatch }));
    }
    setAssistantOpen(false);
    setCommandPaletteOpen(false);
    setCreateWorkflowHubOpen(true);
  }, []);

  const closeCreateWorkflowHub = useCallback(() => {
    setCreateWorkflowHubOpen(false);
    setCreateWorkflowHubState(initialCreateWorkflowHubState);
  }, []);

  const updateCreateWorkflowHubState = useCallback((statePatch: CreateWorkflowHubStatePatch) => {
    setCreateWorkflowHubState((current) => ({ ...current, ...statePatch }));
  }, []);

  const resetCreateWorkflowHubState = useCallback(() => {
    setCreateWorkflowHubState(initialCreateWorkflowHubState);
  }, []);

  const openWorkflow = useCallback((workflowId: string, origin?: ViewName, focus: WorkflowDetailFocus = null) => {
    const inferredOrigin = view === "workflow-detail" ? workflowDetailOrigin : view;
    const nextOrigin = origin ?? inferredOrigin ?? "workflows";
    setSelectedWorkflowId(workflowId);
    setSelectedRunId("");
    setWorkflowDetailFocus(focus);
    setWorkflowDetailOrigin(nextOrigin === "workflow-detail" ? "workflows" : nextOrigin);
    setCurrentView("workflow-detail");
  }, [view, workflowDetailOrigin]);

  const openWorkflowRun = useCallback((workflowId: string, runId: string, origin?: ViewName, focus: WorkflowDetailFocus = "run-history") => {
    const inferredOrigin = view === "workflow-detail" ? workflowDetailOrigin : view;
    const nextOrigin = origin ?? inferredOrigin ?? "workflows";
    setSelectedWorkflowId(workflowId);
    setSelectedRunId(runId);
    setWorkflowDetailFocus(focus);
    setWorkflowDetailOrigin(nextOrigin === "workflow-detail" ? "workflows" : nextOrigin);
    setCurrentView("workflow-detail");
  }, [view, workflowDetailOrigin]);

  const returnFromWorkflowDetail = useCallback(() => {
    if (workflowDetailExitGuard && !workflowDetailExitGuard()) {
      return;
    }
    const destination = workflowDetailOrigin && workflowDetailOrigin !== "workflow-detail"
      ? workflowDetailOrigin
      : "workflows";
    setCurrentView(destination);
  }, [workflowDetailExitGuard, workflowDetailOrigin]);

  const setWorkflowDetailExitGuard = useCallback((guard: WorkflowDetailExitGuard | null) => {
    setWorkflowDetailExitGuardState(() => guard);
  }, []);

  const openArtifact = useCallback((artifactId: string) => {
    setSelectedArtifactId(artifactId);
    setCurrentView("artifacts");
  }, []);

  return (
    <UIContext.Provider
      value={{
        theme, view, workflowDetailOrigin, sidebarCollapsed, assistantOpen, commandPaletteOpen,
        createWorkflowHubOpen, createWorkflowHubState, commandCenterTarget,
        selectedArtifactId, selectedWorkflowId, selectedRunId, workflowDetailFocus, activeSettingsTab,
        settingsFocusTarget, workflowRosterCommand,
        setTheme, toggleTheme, setView, setSidebarCollapsed, toggleSidebar,
        setAssistantOpen, setCommandPaletteOpen,
        openCreateWorkflowHub, closeCreateWorkflowHub, updateCreateWorkflowHubState,
        resetCreateWorkflowHubState, setCommandCenterTarget, openCommandCenterTarget,
        setSelectedArtifactId, setSelectedWorkflowId, setSelectedRunId,
        openWorkflow, openWorkflowRun, returnFromWorkflowDetail, setWorkflowDetailExitGuard,
        openArtifact, setActiveSettingsTab,
        setSettingsFocusTarget, openSettingsTarget, setWorkflowRosterCommand,
      }}
    >
      {children}
    </UIContext.Provider>
  );
}

export function useUI(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI must be used within UIProvider");
  return ctx;
}
