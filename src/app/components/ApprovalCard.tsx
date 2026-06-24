import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { ApprovalRequest } from "../../domain/types";

interface ApprovalCardProps {
  approval: ApprovalRequest;
  onApprove: (id: string, reason?: string) => void;
  onReject: (id: string, reason?: string) => void;
}

export function ApprovalCard({ approval, onApprove, onReject }: ApprovalCardProps) {
  const riskClass = `risk-${approval.riskLevel}`;
  const [reason, setReason] = useState("");

  let payload: unknown = null;
  if (approval.payloadJson) {
    try {
      payload = JSON.parse(approval.payloadJson);
    } catch {
      payload = null;
    }
  }

  return (
    <div className={`approval-card ${riskClass}`}>
      <div className="approval-card-header">
        <ShieldAlert size={20} style={{ color: "var(--accent)", flex: "0 0 auto" }} />
        <strong>Approval Required</strong>
        <span className={`approval-risk-badge ${riskClass}`}>{approval.riskLevel}</span>
      </div>

      <p className="approval-card-desc">{approval.description}</p>

      {payload != null && typeof payload === "object" && (
        <details className="approval-card-payload">
          <summary>View payload ({Object.keys(payload).length} fields)</summary>
          <pre>{JSON.stringify(payload, null, 2)}</pre>
        </details>
      )}

      <details className="approval-card-reason">
        <summary>Add reason (optional)</summary>
        <textarea
          className="approval-card-reason-input"
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          placeholder="Why are you approving or rejecting?"
          rows={2}
        />
      </details>

      <div className="approval-card-actions">
        <button
          type="button"
          className="primary-action"
          onClick={() => onApprove(approval.id, reason || undefined)}
        >
          Approve
        </button>
        <button type="button" onClick={() => onReject(approval.id, reason || undefined)}>
          Reject
        </button>
      </div>
    </div>
  );
}
