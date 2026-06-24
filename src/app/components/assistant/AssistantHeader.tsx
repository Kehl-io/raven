import { X } from "lucide-react";

export function AssistantHeader({
  subtitle,
  onClose,
}: {
  subtitle: string;
  onClose: () => void;
}) {
  return (
    <header className="assistant-drawer-header">
      <div>
        <p className="eyebrow">Raven</p>
        <h2 id="chat-panel-title">{subtitle}</h2>
      </div>
      <button
        className="icon-button"
        type="button"
        aria-label="Close assistant"
        title="Close assistant"
        onClick={onClose}
      >
        <X size={18} />
      </button>
    </header>
  );
}
