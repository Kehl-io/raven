import { useEffect, useRef, useState } from "react";
import { completeOnboarding, setDockVisibility } from "../tauriBridge";

export function OnboardingOverlay({ onComplete }: { onComplete: () => void }) {
  const [dockVisible, setDockVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const focusable = card.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        completeOnboarding().then(onComplete);
        return;
      }
      if (e.key !== "Tab") return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onComplete]);

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label="Welcome to Raven">
      <div className="onboarding-card" ref={cardRef}>
        <h2>Welcome to Raven</h2>
        <p>
          Raven lives in your <strong>menu bar</strong> — look for the icon at
          the top of your screen. You can always open Raven with:
        </p>
        <kbd className="shortcut-badge">⌘ Shift R</kbd>
        <p>
          Close this window anytime — Raven keeps running in the background.
        </p>
        <div className="onboarding-option">
          <label>
            <input
              type="checkbox"
              checked={dockVisible}
              onChange={(e) => {
                const visible = e.target.checked;
                setDockVisible(visible);
                setDockVisibility(visible);
              }}
            />
            Show in Dock instead
          </label>
        </div>
        <button
          className="onboarding-continue"
          onClick={async () => {
            await completeOnboarding();
            onComplete();
          }}
        >
          Get Started
        </button>
      </div>
    </div>
  );
}
