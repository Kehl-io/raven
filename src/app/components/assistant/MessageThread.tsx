import { type ReactNode, useEffect, useRef, useState } from "react";

export function MessageThread({ children }: { children: ReactNode }) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const userWasNearBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  useEffect(() => {
    if (userWasNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
  }, [children]);

  function updateScrollPosition() {
    const messages = messagesRef.current;
    if (!messages) return;

    const distanceFromBottom =
      messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    const nearBottom = distanceFromBottom <= 56;
    userWasNearBottomRef.current = nearBottom;
    if (nearBottom) setShowJumpToLatest(false);
  }

  function jumpToLatest() {
    userWasNearBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowJumpToLatest(false);
  }

  return (
    <div
      className="assistant-drawer-messages"
      role="log"
      aria-label="Assistant messages"
      ref={messagesRef}
      onScroll={updateScrollPosition}
    >
      {children}
      <div ref={messagesEndRef} />
      {showJumpToLatest && (
        <button
          className="assistant-jump-latest"
          type="button"
          onClick={jumpToLatest}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
