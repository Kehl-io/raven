import {
  BarChart3,
  CalendarDays,
  HelpCircle,
  Plus,
  Settings,
  Wrench,
  Workflow,
} from "lucide-react";
import type { AssistantSuggestion } from "../../selectors/commandCenter";

function iconForSuggestion(suggestion: AssistantSuggestion) {
  if (suggestion.action.kind === "open-create-workflow") return <Plus size={14} />;
  if (suggestion.action.kind === "open-command-center" && suggestion.action.payload.target === "usage") {
    return <BarChart3 size={14} />;
  }
  if (suggestion.action.kind === "open-command-center" && suggestion.action.payload.target === "schedule") {
    return <CalendarDays size={14} />;
  }
  if (suggestion.action.kind === "open-settings") return <Settings size={14} />;
  if (suggestion.type === "repair" || suggestion.type === "configure") return <Wrench size={14} />;
  if (suggestion.type === "explain") return <HelpCircle size={14} />;
  return <Workflow size={14} />;
}

function reasonForSuggestion(suggestion: AssistantSuggestion) {
  if (suggestion.priority === "high") {
    return "This action needs attention before the rest of the workspace can stay current.";
  }
  if (suggestion.type === "configure") {
    return "Configuration shortcuts are available for the surface you are viewing.";
  }
  if (suggestion.type === "run") {
    return "A runnable automation action is available from the assistant.";
  }
  if (suggestion.type === "explain") {
    return "Ask for context when you want the current state summarized.";
  }
  return "Start with the most useful action, or choose another shortcut below.";
}

export function AssistantChips({
  contextTitle,
  suggestions,
  onSelect,
  onHideCategory,
}: {
  contextTitle: string;
  suggestions: AssistantSuggestion[];
  onSelect: (suggestion: AssistantSuggestion) => void;
  onHideCategory?: (category: AssistantSuggestion["type"]) => void;
}) {
  if (suggestions.length === 0) return null;
  const [primarySuggestion, ...secondarySuggestions] = suggestions;
  const repairVisible = suggestions.some((suggestion) => suggestion.type === "repair");

  return (
    <section className="assistant-suggestion-card" aria-label="Assistant suggestions">
      <div className="assistant-suggestion-context">
        <span className="eyebrow">Context</span>
        <h3>{contextTitle}</h3>
        <p>{reasonForSuggestion(primarySuggestion)}</p>
      </div>
      <button
        className={`assistant-chip assistant-chip-primary assistant-chip-${primarySuggestion.priority}`}
        type="button"
        onClick={() => onSelect(primarySuggestion)}
      >
        {iconForSuggestion(primarySuggestion)}
        <span>{primarySuggestion.label}</span>
      </button>
      {secondarySuggestions.length > 0 && (
        <div className="assistant-chip-strip">
          {secondarySuggestions.map((suggestion) => (
            <button
              className={`assistant-chip assistant-chip-${suggestion.priority}`}
              type="button"
              key={`${suggestion.action.kind}:${suggestion.label}`}
              onClick={() => onSelect(suggestion)}
            >
              {iconForSuggestion(suggestion)}
              <span>{suggestion.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="assistant-chip-settings">
        {repairVisible && onHideCategory && (
          <button type="button" onClick={() => onHideCategory("repair")}>
            Hide repair suggestions
          </button>
        )}
        <span>Personalized suggestions unavailable</span>
        <span>Task plan panel unavailable</span>
      </div>
    </section>
  );
}
