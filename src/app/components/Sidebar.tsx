import { Archive, ClipboardList, Home, Moon, Settings, Sun } from "lucide-react";
import type { ViewName } from "../../domain/types";
import { useUI } from "../contexts";
import ravenMark from "../../assets/raven-icon.png";

type PrimaryNavView = Extract<ViewName, "home" | "artifacts" | "workflows" | "settings">;

const navItems: Array<{ id: PrimaryNavView; label: string; Icon: typeof Home }> = [
  { id: "home", label: "Command Center", Icon: Home },
  { id: "artifacts", label: "Artifacts", Icon: Archive },
  { id: "workflows", label: "Workflows", Icon: ClipboardList },
  { id: "settings", label: "Settings", Icon: Settings },
];

export function Sidebar() {
  const { theme, view, sidebarCollapsed, toggleTheme, setView, toggleSidebar } = useUI();
  const collapsed = sidebarCollapsed;
  const isNavActive = (id: PrimaryNavView) =>
    view === id ||
    (view === "workflow-detail" && id === "workflows") ||
    (view === "marketplace" && id === "workflows");

  return (
    <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`} aria-label="Primary">
      <div className="brand-lockup">
        <img src={ravenMark} alt="Raven" />
        <div className="sidebar-label"><strong>Raven</strong></div>
      </div>

      <button
        className="sidebar-collapse-toggle icon-button"
        type="button"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={toggleSidebar}
      >
        {collapsed ? "›" : "‹"}
      </button>

      <nav className="nav-stack" role="navigation" aria-label="Main navigation">
        {navItems.map(({ id, label, Icon }) => {
          const active = isNavActive(id);
          return (
          <button
            key={id}
            className={active ? "nav-item active" : "nav-item"}
            type="button"
            onClick={() => setView(id)}
            aria-current={active ? "page" : undefined}
            title={collapsed ? label : undefined}
          >
            <Icon size={18} />
            <span className="sidebar-label">{label}</span>
          </button>
          );
        })}
      </nav>

      <button
        className="theme-toggle"
        type="button"
        onClick={toggleTheme}
        aria-label={theme === "aurora-dark" ? "Switch to Light mode" : "Switch to Dark mode"}
        title={theme === "aurora-dark" ? "Light mode" : "Dark mode"}
      >
        {theme === "aurora-dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
    </aside>
  );
}
