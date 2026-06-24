import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

interface TopStatusPopoverProps {
  id: string;
  title: string;
  buttonLabel: string;
  buttonTitle: string;
  className?: string;
  icon: ReactNode;
  summary: string;
  badgeCount?: number;
  badgeLabel?: string;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}

export function TopStatusPopover({
  id,
  title,
  buttonLabel,
  buttonTitle,
  className = "",
  icon,
  summary,
  badgeCount = 0,
  badgeLabel,
  isOpen,
  onToggle,
  onClose,
  children,
}: TopStatusPopoverProps) {
  const panelId = `${id}-status-popover`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const focusRestoreRef = useRef<"sync" | "defer">("sync");

  const isFocusableOutsideTarget = (element: Element | null): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || rootRef.current?.contains(element)) return false;
    if (element.closest(".top-status-popover")) return false;
    if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
    if (element.tabIndex >= 0) return true;
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button" || tagName === "input" || tagName === "select" || tagName === "textarea") {
      return true;
    }
    if (tagName === "a") return element.hasAttribute("href");
    return false;
  };

  const restoreFocusIfSafe = () => {
    const activeElement = document.activeElement;
    if (
      document.querySelector(".top-status-popover-panel") ||
      (activeElement instanceof HTMLElement &&
        activeElement.closest(".top-status-popover") &&
        !rootRef.current?.contains(activeElement))
    ) {
      return;
    }
    if (isFocusableOutsideTarget(activeElement)) return;
    triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      closeRef.current?.focus();
      return;
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      if (focusRestoreRef.current === "defer") {
        window.setTimeout(restoreFocusIfSafe, 0);
      } else {
        triggerRef.current?.focus();
      }
      focusRestoreRef.current = "sync";
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      focusRestoreRef.current = "sync";
      onClose();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      focusRestoreRef.current = "defer";
      onClose();
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      focusRestoreRef.current = "defer";
      onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [isOpen, onClose]);

  return (
    <div className="top-status-popover" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`top-bar-status-item${className}`}
        aria-label={buttonLabel}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        onClick={onToggle}
        title={buttonTitle}
      >
        {icon}
        <span>{summary}</span>
        {badgeCount > 0 && (
          <span className="top-status-badge" aria-label={badgeLabel ?? `${title} issues: ${badgeCount}`}>
            {badgeCount}
          </span>
        )}
      </button>
      {isOpen && (
        <section
          id={panelId}
          className="top-status-popover-panel"
          role="dialog"
          aria-label={`${title} details`}
        >
          <div className="top-status-popover-heading">
            <span className="panel-kicker">Top status</span>
            <h2>{title}</h2>
            <button
              ref={closeRef}
              type="button"
              className="icon-button top-status-close"
              aria-label={`Close ${title.toLowerCase()}`}
              onClick={() => {
                focusRestoreRef.current = "sync";
                onClose();
              }}
            >
              <X size={16} />
            </button>
          </div>
          {children}
        </section>
      )}
    </div>
  );
}
