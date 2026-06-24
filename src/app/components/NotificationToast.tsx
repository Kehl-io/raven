import { AlertTriangle, Check, Info, X } from "lucide-react";
import type { Toast, ToastLevel } from "../../domain/types";

const icons: Record<ToastLevel, typeof Check> = {
  success: Check,
  error: X,
  warning: AlertTriangle,
  info: Info,
};

export function NotificationToast({
  toasts,
  onDismiss,
  assistantOpen = false,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  assistantOpen?: boolean;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className={`toast-stack${!assistantOpen ? " toast-stack-shifted" : ""}`} aria-live="polite">
      {toasts.map((toast) => {
        const Icon = icons[toast.level];
        return (
          <div key={toast.id} className={`toast toast-${toast.level}`} role="alert">
            <Icon size={16} aria-hidden="true" />
            <span>{toast.message}</span>
            {toast.action && (
              <button type="button" className="toast-action" onClick={toast.action.onClick}>
                {toast.action.label}
              </button>
            )}
            <button type="button" className="icon-button toast-dismiss" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
