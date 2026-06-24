import { useCallback, useEffect, useRef, useState } from "react";
import {
  UIProvider,
  AppStateProvider,
  AssistantProvider,
  RunStreamProvider,
  useUI,
  useAppState,
} from "./contexts";
import {
  Sidebar,
  TopBar,
  ErrorBoundary,
  NotificationToast,
  AssistantFab,
} from "./components";
import { CreateWorkflowHub } from "./components/CreateWorkflowHub";
import { OnboardingOverlay } from "./components/OnboardingOverlay";
import { getOnboardingCompleted } from "./tauriBridge";
import {
  HomeView,
  ArtifactsView,
  WorkflowsView,
  WorkflowDetailView,
  SettingsView,
  TemplateMarketplace,
} from "./views";
import { AssistantDrawer } from "./panels/AssistantDrawer";
import { CommandPalette } from "./CommandPalette";
import { SetupWizard } from "./SetupWizard";
import "./aurora.css";

function AppShell() {
  const {
    theme,
    view,
    assistantOpen,
    commandPaletteOpen,
    createWorkflowHubOpen,
    setCommandPaletteOpen,
    setAssistantOpen,
  } =
    useUI();
  const { toasts, hasCompletedSetup, actions } = useAppState();
  const [drawerClosing, setDrawerClosing] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingRepairInFlightRef = useRef(false);
  const onboardingRepairAutoAttemptedRef = useRef(false);
  const toastsRef = useRef(toasts);

  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  const dismissOnboardingRepairToasts = useCallback(() => {
    toastsRef.current
      .filter((toast) => toast.message === "Raven could not finalize onboarding yet. Please try again.")
      .forEach((toast) => actions.dismissToast(toast.id));
  }, [actions]);

  const attemptOnboardingRepair = useCallback(async () => {
    if (!hasCompletedSetup || onboardingRepairInFlightRef.current) return;
    onboardingRepairInFlightRef.current = true;
    setShowOnboarding(false);
    const result = await actions.completeSetup({ preserveSkipped: true });
    onboardingRepairInFlightRef.current = false;
    if (result.ok) {
      dismissOnboardingRepairToasts();
      return;
    }
    if (toastsRef.current.some((toast) => toast.message === result.message)) return;
    actions.pushToast({
      level: "warning",
      message: result.message,
      action: {
        label: "Retry",
        onClick: () => {
          void attemptOnboardingRepair();
        },
      },
    });
  }, [actions, dismissOnboardingRepairToasts, hasCompletedSetup]);

  useEffect(() => {
    if (!hasCompletedSetup) {
      onboardingRepairInFlightRef.current = false;
      onboardingRepairAutoAttemptedRef.current = false;
      setShowOnboarding(false);
      dismissOnboardingRepairToasts();
      return;
    }

    let cancelled = false;

    void getOnboardingCompleted().then(async (completed) => {
      if (cancelled) return;
      if (completed) {
        onboardingRepairInFlightRef.current = false;
        onboardingRepairAutoAttemptedRef.current = false;
        setShowOnboarding(false);
        dismissOnboardingRepairToasts();
        return;
      }
      if (onboardingRepairInFlightRef.current) return;
      if (onboardingRepairAutoAttemptedRef.current) return;
      onboardingRepairAutoAttemptedRef.current = true;
      await attemptOnboardingRepair();
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [attemptOnboardingRepair, dismissOnboardingRepairToasts, hasCompletedSetup]);
  const appBackgroundRef = useRef<HTMLDivElement>(null);
  const modalOpen = commandPaletteOpen || assistantOpen || drawerClosing || createWorkflowHubOpen || showOnboarding;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const appBackground = appBackgroundRef.current;
    if (!appBackground) return;

    if (modalOpen) {
      appBackground.inert = true;
      return;
    }

    appBackground.inert = false;
  }, [modalOpen]);

  const handleCloseDrawer = useCallback(() => {
    setDrawerClosing(true);
  }, []);

  const handleDrawerAnimationEnd = useCallback(() => {
    if (drawerClosing) {
      setAssistantOpen(false);
      setDrawerClosing(false);
    }
  }, [drawerClosing, setAssistantOpen]);

  useEffect(() => {
    if (!drawerClosing) return;
    const timeoutId = window.setTimeout(() => {
      setAssistantOpen(false);
      setDrawerClosing(false);
    }, 220);
    return () => window.clearTimeout(timeoutId);
  }, [drawerClosing, setAssistantOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && key === "j") {
        e.preventDefault();
        if (assistantOpen) {
          handleCloseDrawer();
        } else {
          setAssistantOpen(true);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setCommandPaletteOpen, setAssistantOpen, assistantOpen, handleCloseDrawer]);

  if (!hasCompletedSetup) {
    return <SetupWizard />;
  }

  return (
    <div className="raven-shell">
      {showOnboarding && (
        <OnboardingOverlay onComplete={() => setShowOnboarding(false)} />
      )}
      <div
        className="raven-app-background"
        ref={appBackgroundRef}
        aria-hidden={modalOpen ? true : undefined}
      >
        <Sidebar />
        <main className="workspace" role="main">
          <TopBar />
          <ErrorBoundary>
            {view === "home" && <HomeView />}
            {view === "artifacts" && <ArtifactsView />}
            {view === "workflows" && <WorkflowsView />}
            {view === "workflow-detail" && <WorkflowDetailView />}
            {view === "settings" && <SettingsView />}
            {view === "marketplace" && <TemplateMarketplace />}
          </ErrorBoundary>
        </main>
        <NotificationToast toasts={toasts} onDismiss={actions.dismissToast} assistantOpen={assistantOpen} />
        <AssistantFab />
      </div>
      {(assistantOpen || drawerClosing) && (
        <>
          <div
            className={`assistant-backdrop${drawerClosing ? " assistant-backdrop-closing" : ""}`}
            onClick={handleCloseDrawer}
            aria-hidden="true"
          />
          <ErrorBoundary>
            <AssistantDrawer
              closing={drawerClosing}
              onClose={handleCloseDrawer}
              onAnimationEnd={handleDrawerAnimationEnd}
            />
          </ErrorBoundary>
        </>
      )}
      {commandPaletteOpen && <CommandPalette />}
      {createWorkflowHubOpen && <CreateWorkflowHub />}
    </div>
  );
}

function App() {
  return (
    <UIProvider>
      <AppStateProvider>
        <AssistantProvider>
          <RunStreamProvider>
            <AppShell />
          </RunStreamProvider>
        </AssistantProvider>
      </AppStateProvider>
    </UIProvider>
  );
}

export default App;
