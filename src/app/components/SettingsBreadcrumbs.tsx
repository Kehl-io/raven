import type { SettingsFocusTarget } from "../contexts/UIContext";

type SettingsTabId = "general" | "context" | "tools" | "advanced";

interface SettingsBreadcrumbsProps {
  activeTab: SettingsTabId;
  target?: SettingsFocusTarget | null;
  onNavigate: (tab: SettingsTabId) => void;
}

const tabLabels: Record<SettingsTabId, string> = {
  general: "General",
  context: "Context Sources",
  tools: "Tools & Capabilities",
  advanced: "Advanced",
};

export function SettingsBreadcrumbs({ activeTab, target, onNavigate }: SettingsBreadcrumbsProps) {
  const targetLabel = target?.label ?? target?.id;
  const segments = targetLabel
    ? [
        { label: "Settings", tab: "general" as const, current: false },
        { label: tabLabels[activeTab], tab: activeTab, current: false },
        { label: targetLabel, tab: activeTab, current: true },
      ]
    : activeTab === "advanced"
      ? [
          { label: "Settings", tab: "general" as const, current: false },
          { label: "Advanced", tab: "advanced" as const, current: false },
          { label: "Scheduler", tab: "advanced" as const, current: true },
        ]
    : [
        { label: "Settings", tab: "general" as const, current: false },
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
