import type { SettingsFocusTarget } from "../contexts/UIContext";

type SettingsTabId = "providers" | "context" | "outputs" | "automation" | "extensions" | "system";

interface SettingsBreadcrumbsProps {
  activeTab: SettingsTabId;
  target?: SettingsFocusTarget | null;
  onNavigate: (tab: SettingsTabId) => void;
}

const tabLabels: Record<SettingsTabId, string> = {
  providers: "Providers",
  context: "Context",
  outputs: "Outputs",
  automation: "Automation",
  extensions: "Extensions",
  system: "System",
};

export function SettingsBreadcrumbs({ activeTab, target, onNavigate }: SettingsBreadcrumbsProps) {
  const targetLabel = target?.label ?? target?.id;
  const segments = targetLabel
    ? [
        { label: "Settings", tab: "providers" as const, current: false },
        { label: tabLabels[activeTab], tab: activeTab, current: false },
        { label: targetLabel, tab: activeTab, current: true },
      ]
    : activeTab === "automation"
      ? [
          { label: "Settings", tab: "providers" as const, current: false },
          { label: "Automation", tab: "automation" as const, current: false },
          { label: "Scheduler", tab: "automation" as const, current: true },
        ]
    : [
        { label: "Settings", tab: "providers" as const, current: false },
        { label: tabLabels[activeTab], tab: activeTab, current: true },
      ];

  return (
    <nav className="settings-breadcrumbs" aria-label="Settings breadcrumbs">
      <ol>
        {segments.map((segment) => (
          <li key={`${segment.label}-${segment.tab}`}>
            {segment.current ? (
              <span aria-current="page">{segment.label}</span>
            ) : (
              <button type="button" onClick={() => onNavigate(segment.tab)}>
                {segment.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
