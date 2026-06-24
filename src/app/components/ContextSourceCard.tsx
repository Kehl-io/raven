import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

type ContextSourceStatus = "ready" | "not_configured" | "unavailable" | "error";

interface ContextSourceCardProps {
  title: string;
  description: string;
  status: ContextSourceStatus;
  statusLabel: string;
  summary?: string;
  children: ReactNode;
}

export function ContextSourceCard({
  title,
  description,
  status,
  statusLabel,
  summary,
  children,
}: ContextSourceCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="context-source-card" data-expanded={expanded}>
      <div
        className="context-source-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        <div className={`context-source-dot context-source-dot-${status}`} />
        <div className="context-source-info">
          <strong>{title}</strong>
          <small>{summary || description}</small>
        </div>
        <span className={`readiness-pill readiness-pill-${status}`}>{statusLabel}</span>
        <ChevronDown size={18} className="context-source-chevron" />
      </div>

      {expanded && <div className="context-source-body">{children}</div>}
    </div>
  );
}
