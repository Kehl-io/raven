import type { ReactNode } from "react";
import type { ChatMessage } from "../../../domain/types";

function renderMessageContent(content: string): ReactNode {
  const lines = content.split("\n");
  return lines.map((line, i) => {
    if (line.trim() === "") return <br key={i} />;

    const isBullet = line.trimStart().startsWith("- ");
    const text = isBullet ? line.replace(/^\s*- /, "") : line;

    // Split on **bold** markers and build spans
    const parts = text.split(/\*\*(.*?)\*\*/g);
    const elements = parts.map((part, j) =>
      j % 2 === 1 ? <strong key={j}>{part}</strong> : part
    );

    if (isBullet) {
      return <p key={i} className="bullet-line">• {elements}</p>;
    }
    return <p key={i} style={{ margin: "0.15rem 0" }}>{elements}</p>;
  });
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <span>{message.role}</span>
      {message.role === "assistant"
        ? <div>{renderMessageContent(message.content)}</div>
        : <p>{message.content}</p>}
    </article>
  );
}
