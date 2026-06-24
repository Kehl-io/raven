const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type FocusTrapKeyboardEvent = {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
};

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.getClientRects().length > 0 && !element.getAttribute("aria-hidden"),
  );
}

export function trapFocus(event: FocusTrapKeyboardEvent, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;

  const focusableElements = getFocusableElements(container);
  if (focusableElements.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }

  const first = focusableElements[0];
  const last = focusableElements[focusableElements.length - 1];
  const activeElement = document.activeElement;

  if (!container.contains(activeElement)) {
    event.preventDefault();
    first.focus();
    return;
  }

  if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function restoreFocusIfSafe(element: HTMLElement | null, fallbackSelector?: string) {
  let attempts = 0;
  const restore = () => {
    const target =
      element && document.contains(element)
        ? element
        : fallbackSelector
          ? document.querySelector<HTMLElement>(fallbackSelector)
          : null;
    if (!target) {
      attempts += 1;
      if (attempts < 10) window.setTimeout(restore, 20);
      return;
    }
    if (target.closest("[inert], [aria-hidden='true']")) {
      attempts += 1;
      if (attempts < 10) window.setTimeout(restore, 20);
      return;
    }
    target.focus();
  };
  window.setTimeout(restore, 0);
}
