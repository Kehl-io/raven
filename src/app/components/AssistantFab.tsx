import { useUI } from "../contexts";
import { useRunStream } from "../contexts/RunStreamContext";
import ravenMark from "../../assets/raven-icon.png";

interface AssistantFabProps {
  hasUnread?: boolean;
  isStreaming?: boolean;
  hasPendingApproval?: boolean;
}

export function AssistantFab({ hasUnread = false, isStreaming: isStreamingProp = false, hasPendingApproval: hasPendingApprovalProp = false }: AssistantFabProps) {
  const { assistantOpen, setAssistantOpen } = useUI();
  const { runStream } = useRunStream();

  const hasPendingApproval = hasPendingApprovalProp || runStream.pendingApproval != null;
  const isStreaming = isStreamingProp || runStream.activeRunId != null;

  if (assistantOpen) return null;

  let badgeClass = "";
  if (hasPendingApproval) badgeClass = "assistant-fab-badge assistant-fab-badge-warning";
  else if (hasUnread) badgeClass = "assistant-fab-badge assistant-fab-badge-accent";

  return (
    <button
      className={`assistant-fab${isStreaming ? " assistant-fab-pulse" : ""}`}
      type="button"
      aria-label="Open Raven assistant"
      onClick={(event) => {
        event.currentTarget.focus();
        setAssistantOpen(true);
      }}
    >
      <img src={ravenMark} alt="" />
      {badgeClass && <span className={badgeClass} />}
    </button>
  );
}
