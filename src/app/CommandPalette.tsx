import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Moon, Play, Plus, Search, Settings, Sun, Zap } from "lucide-react";
import { useAppState } from "./contexts/AppStateContext";
import { useUI } from "./contexts/UIContext";
import { useRunStream } from "./contexts/RunStreamContext";
import { restoreFocusIfSafe, trapFocus } from "./lib/focusTrap";

interface PaletteItem {
  id: string;
  category: string;
  label: string;
  icon: React.ReactNode;
  action: () => void;
}

function fuzzyMatch(query: string, text: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function CommandPalette() {
  const { state, actions } = useAppState();
  const ui = useUI();
  const { startStreamedRun } = useRunStream();
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Capture focus to restore on unmount
  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      restoreFocusIfSafe(previousFocusRef.current);
    };
  }, []);

  const close = useCallback(() => {
    ui.setCommandPaletteOpen(false);
  }, [ui]);

  // Escape to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [close]);

  // Build items list
  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];

    // Workflows
    for (const wf of state.workflows) {
      result.push({
        id: `wf-open-${wf.workflowId}`,
        category: "Workflow",
        label: wf.definition.name,
        icon: <Zap size={14} />,
        action: () => {
          ui.openWorkflow(wf.workflowId);
          close();
        },
      });
      if (wf.status === "enabled") {
        result.push({
          id: `wf-run-${wf.workflowId}`,
          category: "Action",
          label: `Run ${wf.definition.name}`,
          icon: <Play size={14} />,
          action: () => {
            void startStreamedRun(wf.workflowId).then((result) => {
              if (result) actions.applyRunResults([result]);
            });
            close();
          },
        });
      }
    }

    // Artifacts
    for (const art of state.artifacts) {
      result.push({
        id: `art-${art.id}`,
        category: "Artifact",
        label: art.title,
        icon: <Search size={14} />,
        action: () => {
          ui.openArtifact(art.id);
          close();
        },
      });
    }

    // Actions
    result.push({
      id: "action-create-workflow",
      category: "Action",
      label: "Create workflow",
      icon: <Plus size={14} />,
      action: () => {
        ui.openCreateWorkflowHub();
        close();
      },
    });

    result.push({
      id: "action-open-templates",
      category: "Navigate",
      label: "Open templates",
      icon: <Zap size={14} />,
      action: () => {
        ui.setView("marketplace");
        close();
      },
    });

    result.push({
      id: "action-install-template",
      category: "Action",
      label: "Install template",
      icon: <Plus size={14} />,
      action: () => {
        ui.setView("marketplace");
        close();
      },
    });

    result.push({
      id: "action-toggle-theme",
      category: "Action",
      label: `Toggle theme (${ui.theme === "aurora-dark" ? "switch to light" : "switch to dark"})`,
      icon: ui.theme === "aurora-dark" ? <Sun size={14} /> : <Moon size={14} />,
      action: () => {
        ui.toggleTheme();
        close();
      },
    });

    // Settings tab shortcuts
    result.push(
      {
        id: "nav-settings",
        category: "Navigate",
        label: "Settings",
        icon: <Settings size={14} />,
        action: () => {
          ui.setView("settings");
          close();
        },
      },
      {
        id: "settings-general",
        category: "Search Settings",
        label: "Search Settings: General",
        icon: <Settings size={14} />,
        action: () => {
          ui.openSettingsTarget("general");
          close();
        },
      },
      {
        id: "settings-context-github",
        category: "Search Settings",
        label: "Search Settings: Context / GitHub",
        icon: <Settings size={14} />,
        action: () => {
          ui.openSettingsTarget("context", { type: "context-source", id: "github", label: "GitHub" });
          close();
        },
      },
      {
        id: "settings-tools",
        category: "Search Settings",
        label: "Search Settings: Tools & Capabilities",
        icon: <Settings size={14} />,
        action: () => {
          ui.openSettingsTarget("tools");
          close();
        },
      },
      {
        id: "settings-advanced-scheduler",
        category: "Search Settings",
        label: "Search Settings: Advanced / Scheduler",
        icon: <Settings size={14} />,
        action: () => {
          ui.openSettingsTarget("advanced", { type: "automation", id: "scheduler", label: "Scheduler" });
          close();
        },
      },
    );

    result.push({
      id: "nav-home",
      category: "Navigate",
      label: "Command Center",
      icon: <Zap size={14} />,
      action: () => {
        ui.setView("home");
        close();
      },
    });

    result.push({
      id: "nav-workflows",
      category: "Navigate",
      label: "Workflows",
      icon: <Zap size={14} />,
      action: () => {
        ui.setView("workflows");
        close();
      },
    });

    result.push({
      id: "nav-artifacts",
      category: "Navigate",
      label: "Artifacts",
      icon: <Search size={14} />,
      action: () => {
        ui.setView("artifacts");
        close();
      },
    });

    return result;
  }, [state.workflows, state.artifacts, ui, actions, close, startStreamedRun]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    return items.filter(
      (item) => fuzzyMatch(query, item.label) || fuzzyMatch(query, item.category),
    );
  }, [items, query]);

  // Reset active index on query change
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const executeItem = useCallback(
    (index: number) => {
      const item = filtered[index];
      if (item) item.action();
    },
    [filtered],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          executeItem(activeIndex);
          break;
      }
    },
    [filtered.length, activeIndex, executeItem],
  );

  const handleDialogKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    trapFocus(e, dialogRef.current);
  }, []);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      className="command-palette-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      role="presentation"
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={dialogRef}
        onKeyDown={handleDialogKeyDown}
        tabIndex={-1}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          aria-label="Search workflows, artifacts, and actions"
          placeholder="Search workflows, artifacts, actions..."
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          aria-activedescendant={filtered[activeIndex]?.id}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-autocomplete="list"
        />
        <div
          className="command-palette-results"
          id="command-palette-results"
          ref={listRef}
          role="listbox"
        >
          {filtered.length === 0 && (
            <div className="command-palette-empty">No results found</div>
          )}
          {filtered.map((item, i) => (
            <div
              key={item.id}
              id={item.id}
              className={`command-palette-item${i === activeIndex ? " active" : ""}`}
              role="option"
              aria-selected={i === activeIndex}
              onClick={() => executeItem(i)}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="command-palette-category">{item.category}</span>
              {item.icon}
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
