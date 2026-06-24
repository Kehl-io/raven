import type { ApprovalGrant, CapabilityDescriptor } from "../../domain/types";

interface ApprovalGrantListProps {
  grants: ApprovalGrant[];
  capabilities: CapabilityDescriptor[];
  onRevokeGrant: (id: string) => unknown;
}

function grantTypeLabel(type: ApprovalGrant["grantType"]): string {
  switch (type) {
    case "credential_use":
      return "Credential";
    case "file_write":
      return "File write";
    case "file_overwrite":
      return "Overwrite";
    case "file_delete":
      return "Delete";
    case "network_access":
      return "Network";
    case "external_publish":
      return "Publish";
    case "tool_execution":
      return "Tool execution";
  }
}

function scopeSummary(scope: ApprovalGrant["scope"]): string {
  const parts = [
    scope.credentialRef,
    ...scope.paths,
    ...scope.domains,
    ...scope.resourceIds,
    ...scope.externalTargets,
  ].filter(Boolean);
  if (scope.maxDeletes !== undefined) parts.push(`${scope.maxDeletes} deletes`);
  if (scope.maxOverwriteBytes !== undefined) parts.push(`${scope.maxOverwriteBytes} overwrite bytes`);
  return parts.length > 0 ? parts.join(", ") : "Scoped grant";
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function ApprovalGrantList({ grants, capabilities, onRevokeGrant }: ApprovalGrantListProps) {
  const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const activeGrants = grants.filter((grant) => grant.status === "active");

  if (activeGrants.length === 0) {
    return <p className="empty-state">No active approval grants.</p>;
  }

  return (
    <ul className="approval-grant-list" aria-label="Active approval grants">
      {activeGrants.map((grant) => {
        const capability = capabilityById.get(grant.capabilityId);
        const capabilityName = capability?.displayName ?? grant.capabilityId;
        return (
          <li key={grant.id} className="approval-grant-row">
            <span className="approval-grant-main">
              <strong>{capabilityName}</strong>
              <span>{grantTypeLabel(grant.grantType)} · {scopeSummary(grant.scope)}</span>
              <span>
                Approved {formatDate(grant.approvedByUserAt)}
                {grant.expiresAt ? ` · Expires ${formatDate(grant.expiresAt)}` : ""}
              </span>
            </span>
            <button
              type="button"
              className="profile-expand-btn"
              aria-label={`Revoke grant for ${capabilityName}`}
              onClick={() => void onRevokeGrant(grant.id)}
            >
              Revoke
            </button>
          </li>
        );
      })}
    </ul>
  );
}
