import { AlertTriangle, Check, Circle, X } from "lucide-react";

function titleCase(value: string) {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function StatusIndicator({ status }: { status: string }) {
  const normalized = status.replace(/_/g, " ");
  return (
    <span className={`status status-${status}`} role="status">
      <StatusIcon status={status} />
      {titleCase(normalized)}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  const size = 12;
  switch (status) {
    case "available":
    case "enabled":
    case "succeeded":
    case "valid":
      return <Check size={size} aria-hidden="true" />;
    case "unavailable":
    case "failed":
      return <X size={size} aria-hidden="true" />;
    case "needs_config":
    case "draft":
    case "retryable":
    case "blocked":
      return <AlertTriangle size={size} aria-hidden="true" />;
    default:
      return <Circle size={size} aria-hidden="true" />;
  }
}
