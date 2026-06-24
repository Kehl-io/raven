import { useMemo, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import {
  DEFAULT_OVERWRITE_GRANT_BYTES,
  derivePreflightApprovalGrants,
} from "../domain/preflightGrants";
import { resolveApprovalGrantResult } from "../domain/approvalGrantResults";
import type {
  ApprovalGrant,
  ApprovalGrantDraft,
  ApprovalGrantType,
  AutonomyMode,
  CapabilityDescriptor,
  PreflightCapabilityUse,
  PreflightCredentialUse,
  PreflightManifest,
  PreflightScopedValueUse,
} from "../../domain/types";

type ActionNotice = {
  message: string;
  tone: "success" | "error";
};

interface RunReadinessPanelProps {
  manifest: PreflightManifest | null;
  capabilities: CapabilityDescriptor[];
  approvalGrants?: ApprovalGrant[];
  onCreateGrant?: (grant: ApprovalGrantDraft) => unknown;
  onCategoryOverrideChange?: (category: string, mode: AutonomyMode | "inherit") => unknown;
  onCategoryOverridesChange?: (updates: Record<string, AutonomyMode | "inherit">) => unknown;
  isLoading?: boolean;
}

type PolicyTone = "auto" | "needs_grant" | "blocked";

interface GrantTarget {
  capability: PreflightCapabilityUse;
  grantType: ApprovalGrantType;
  scope: ApprovalGrant["scope"];
  ariaLabel: string;
}

type NetworkReadinessItem = PreflightScopedValueUse & {
  scopeKind: "domain" | "resource";
  label: string;
};

type GrantDuration = "this_run" | "workflow_version" | "1h" | "24h";
type FileGrantScope = "exact" | "destination_folder";

const policyLabels: Record<PolicyTone, string> = {
  auto: "Allowed automatically",
  needs_grant: "Needs pre-approval",
  blocked: "Blocked",
};

const categoryLabels: Record<string, string> = {
  agent: "Agent",
  artifact: "Artifacts",
  document_import: "Document import",
  generation: "Generation",
  local_context: "Local context",
  source_control: "Source control",
  workspace_automation: "Workspace automation",
  web_content: "Web content",
  web_monitoring: "Web monitoring",
};

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function policyTone(decision: PreflightCapabilityUse["policyDecision"]): PolicyTone {
  if (decision === "auto") return "auto";
  if (decision === "blocked" || decision === "hidden") return "blocked";
  return "needs_grant";
}

function grantId(): string {
  return `grant-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function blankScope(): ApprovalGrant["scope"] {
  return {
    paths: [],
    domains: [],
    resourceIds: [],
    externalTargets: [],
  };
}

function expiresAtForDuration(duration: GrantDuration, approvedAt: Date): string | undefined {
  const expiresAt = new Date(approvedAt);
  if (duration === "this_run") {
    expiresAt.setMinutes(expiresAt.getMinutes() + 30);
    return expiresAt.toISOString();
  }
  if (duration === "1h") {
    expiresAt.setHours(expiresAt.getHours() + 1);
    return expiresAt.toISOString();
  }
  if (duration === "24h") {
    expiresAt.setHours(expiresAt.getHours() + 24);
    return expiresAt.toISOString();
  }
  return undefined;
}

function categoryLabel(category: string): string {
  return categoryLabels[category] ?? category.replace(/[_-]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function grantIsUsable(grant: ApprovalGrant): boolean {
  if (grant.status !== "active") return false;
  if (!grant.expiresAt) return true;
  const expiresAt = Date.parse(grant.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function includesAll(allowed: string[] = [], requested: string[] = []): boolean {
  return requested.every((value) => allowed.includes(value));
}

function scopeIncludes(grantScope: ApprovalGrant["scope"], requestedScope: ApprovalGrant["scope"]): boolean {
  return includesAll(grantScope.paths, requestedScope.paths) &&
    includesAll(grantScope.domains, requestedScope.domains) &&
    includesAll(grantScope.resourceIds, requestedScope.resourceIds) &&
    includesAll(grantScope.externalTargets, requestedScope.externalTargets) &&
    (requestedScope.credentialRef ? grantScope.credentialRef === requestedScope.credentialRef : true) &&
    (requestedScope.maxDeletes ? (grantScope.maxDeletes ?? 0) >= requestedScope.maxDeletes : true) &&
    (requestedScope.maxOverwriteBytes ? (grantScope.maxOverwriteBytes ?? 0) >= requestedScope.maxOverwriteBytes : true);
}

function scopeKey(scope: ApprovalGrant["scope"]): string {
  return JSON.stringify({
    paths: [...scope.paths].sort(),
    domains: [...scope.domains].sort(),
    resourceIds: [...scope.resourceIds].sort(),
    externalTargets: [...scope.externalTargets].sort(),
    credentialRef: scope.credentialRef ?? "",
    maxDeletes: scope.maxDeletes ?? null,
    maxOverwriteBytes: scope.maxOverwriteBytes ?? null,
  });
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="run-readiness-section" role="region" aria-label={title}>
      <div className="run-readiness-section-header">
        <h3>{title}</h3>
      </div>
      {children}
    </section>
  );
}

function EmptySection({ label }: { label: string }) {
  return <p className="run-readiness-empty">{label}</p>;
}

export function RunReadinessPanel({
  manifest,
  capabilities,
  approvalGrants = [],
  onCreateGrant,
  onCategoryOverrideChange,
  onCategoryOverridesChange,
  isLoading = false,
}: RunReadinessPanelProps) {
  const [busyGrantKey, setBusyGrantKey] = useState<string | null>(null);
  const [busyPolicyAction, setBusyPolicyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [grantDuration, setGrantDuration] = useState<GrantDuration>("workflow_version");
  const [fileGrantScope, setFileGrantScope] = useState<FileGrantScope>("exact");
  const capabilityById = useMemo(
    () => new Map(capabilities.map((capability) => [capability.id, capability])),
    [capabilities],
  );
  const preflightByCapabilityId = useMemo(
    () => new Map((manifest?.capabilities ?? []).map((capability) => [capability.capabilityId, capability])),
    [manifest?.capabilities],
  );
  const needsGrantCapabilities = useMemo(
    () => manifest?.capabilities.filter((capability) => capability.policyDecision === "needs_grant") ?? [],
    [manifest?.capabilities],
  );
  const activeGrants = useMemo(
    () => approvalGrants.filter(grantIsUsable),
    [approvalGrants],
  );
  const needsGrantCategories = useMemo(
    () => unique(needsGrantCapabilities
      .map((capability) => capabilityById.get(capability.capabilityId)?.category ?? "")
      .filter(Boolean)),
    [capabilityById, needsGrantCapabilities],
  );
  const helperGrantTargets = useMemo(() => {
    if (!manifest) return [];
    return derivePreflightApprovalGrants(manifest, {
      approvedAt: "2026-06-23T00:00:00.000Z",
      dedupe: false,
      idFactory: (() => {
        let counter = 0;
        return () => `preflight-preview-${++counter}`;
      })(),
    }).map(({ capability, draft }) => {
      const descriptor = capabilityById.get(capability.capabilityId);
      const primaryLabel =
        draft.scope.paths[0] ??
        draft.scope.domains[0] ??
        draft.scope.resourceIds[0] ??
        draft.scope.externalTargets[0] ??
        draft.scope.credentialRef ??
        descriptor?.displayName ??
        capability.capabilityId;
      const ariaLabel = (() => {
        switch (draft.grantType) {
          case "file_write":
            return `Pre-approve write for ${primaryLabel}`;
          case "file_overwrite":
            return `Pre-approve overwrite for ${primaryLabel}`;
          case "file_delete":
            return `Pre-approve delete for ${primaryLabel}`;
          case "network_access":
            return `Pre-approve network access for ${primaryLabel}`;
          case "external_publish":
            return `Pre-approve external publish for ${primaryLabel}`;
          case "credential_use":
            return `Pre-approve credential use for ${primaryLabel}`;
          case "tool_execution":
          default:
            return `Pre-approve ${descriptor?.displayName ?? capability.capabilityId}`;
        }
      })();
      return {
        capability,
        grantType: draft.grantType,
        scope: draft.scope,
        ariaLabel,
      };
    });
  }, [capabilityById, manifest]);

  if (isLoading) {
    return (
      <section className="workflow-editor-panel run-readiness-panel" aria-label="Run readiness">
        <div className="run-readiness-header">
          <h2>Run readiness</h2>
          <span className="settings-card-detail">Evaluating preflight manifest...</span>
        </div>
      </section>
    );
  }

  if (!manifest) {
    return (
      <section className="workflow-editor-panel run-readiness-panel" aria-label="Run readiness">
        <div className="run-readiness-header">
          <h2>Run readiness</h2>
          <span className="settings-card-detail">Preflight has not been evaluated.</span>
        </div>
      </section>
    );
  }

  const createGrant = async (target: GrantTarget) => {
    if (!onCreateGrant) return;
    if ((target.grantType === "file_write" || target.grantType === "file_overwrite") && fileGrantScope === "destination_folder") {
      setNotice({
        message: "Destination folder grants are not available for this preflight; use exact displayed paths.",
        tone: "error",
      });
      return;
    }
    setBusyGrantKey(`${target.grantType}:${target.capability.capabilityId}:${target.ariaLabel}`);
    setNotice(null);
    try {
      const approvedAt = new Date();
      const resultNotice = await resolveApprovalGrantResult(onCreateGrant(grantDraftForTarget(target, approvedAt)));
      setNotice({ message: resultNotice.message, tone: resultNotice.ok ? "success" : "error" });
    } catch {
      setNotice({ message: "Approval grant failed", tone: "error" });
    } finally {
      setBusyGrantKey(null);
    }
  };

  const grantDraftForTarget = (target: GrantTarget, approvedAt: Date): ApprovalGrantDraft => ({
    id: grantId(),
    workflowId: manifest.workflowId,
    workflowVersion: manifest.workflowVersion,
    capabilityId: target.capability.capabilityId,
    grantType: target.grantType,
    scope: target.scope,
    approvedByUserAt: approvedAt.toISOString(),
    expiresAt: expiresAtForDuration(grantDuration, approvedAt),
    signatureHash: target.capability.signatureHash,
    status: "active",
  });

  const markCategoriesAlwaysAsk = async () => {
    if ((!onCategoryOverridesChange && !onCategoryOverrideChange) || needsGrantCategories.length === 0) return;
    setBusyPolicyAction("always_ask");
    setNotice(null);
    try {
      if (onCategoryOverridesChange) {
        await onCategoryOverridesChange(Object.fromEntries(
          needsGrantCategories.map((category) => [category, "ask_first" as const]),
        ));
      } else if (onCategoryOverrideChange) {
        await Promise.all(needsGrantCategories.map((category) => onCategoryOverrideChange(category, "ask_first")));
      }
      const label = needsGrantCategories.map(categoryLabel).join(", ");
      setNotice({ message: `Always ask saved for ${label}.`, tone: "success" });
    } catch {
      setNotice({ message: "Always ask policy update failed", tone: "error" });
    } finally {
      setBusyPolicyAction(null);
    }
  };

  const showBlockCapabilityNotice = () => {
    setNotice({
      message: "Capability-level blocking is not available from run readiness; set category policy in Tools and Autonomy.",
      tone: "error",
    });
  };

  const candidateForRequirement = (
    predicate: (capability: CapabilityDescriptor | undefined, preflight: PreflightCapabilityUse) => boolean,
  ): PreflightCapabilityUse | null => {
    const matchingCapability = needsGrantCapabilities.find((preflight) =>
      predicate(capabilityById.get(preflight.capabilityId), preflight)
    );
    if (matchingCapability) return matchingCapability;
    return capabilities.length === 0 ? needsGrantCapabilities[0] ?? null : null;
  };

  const preflightForScopedItem = (item: PreflightScopedValueUse): PreflightCapabilityUse | null => {
    return manifest.capabilities.find((capability) =>
      capability.stepId === item.stepId && capability.capabilityId === item.capabilityId
    ) ?? preflightByCapabilityId.get(item.capabilityId) ?? null;
  };

  const groupedScopedValues = (
    items: PreflightScopedValueUse[],
    item: PreflightScopedValueUse | undefined,
    fallbackValue: string,
  ) => {
    if (!item?.capabilityId) return [fallbackValue];
    const values = items
      .filter((candidate) =>
        candidate.stepId === item.stepId &&
        candidate.capabilityId === item.capabilityId
      )
      .map((candidate) => candidate.value);
    return unique(values.length > 0 ? values : [fallbackValue]);
  };

  const groupedCredentials = (credential: PreflightCredentialUse) => {
    return unique(manifest.credentials
      .filter((candidate) =>
        candidate.stepId === credential.stepId &&
        candidate.capabilityId === credential.capabilityId
      )
      .map((candidate) => candidate.credentialRef));
  };

  const writes = unique(manifest.fileWrites);
  const overwrites = unique(manifest.overwrites);
  const networkResourceItems = manifest.scopedNetworkResources ?? [];
  const networkDomainItems = manifest.scopedNetworkDomains.length > 0
    ? manifest.scopedNetworkDomains
    : networkResourceItems.length === 0
      ? unique(manifest.networkDomains).map((value) => ({ stepId: "", capabilityId: "", value }))
      : [];
  const networkItems: NetworkReadinessItem[] = [
    ...networkDomainItems.map((item) => ({
      ...item,
      scopeKind: "domain" as const,
      label: item.value,
    })),
    ...networkResourceItems.map((item) => ({
      ...item,
      scopeKind: "resource" as const,
      label: capabilityById.get(item.capabilityId)?.displayName ?? item.value,
    })),
  ];
  const rawWriteItems = manifest.scopedFileWrites.length > 0
    ? manifest.scopedFileWrites
    : writes.map((value) => ({ stepId: "", capabilityId: "", value }));
  const overwriteItems = manifest.scopedOverwrites.length > 0
    ? manifest.scopedOverwrites
    : overwrites.map((value) => ({ stepId: "", capabilityId: "", value }));
  const overwriteItemKeys = new Set(overwriteItems.map((item) =>
    item.stepId || item.capabilityId ? `${item.stepId}:${item.capabilityId}:${item.value}` : item.value,
  ));
  const overwriteValues = new Set(overwriteItems.map((item) => item.value));
  const writeItems = rawWriteItems.filter((item) => {
    const isScoped = Boolean(item.stepId || item.capabilityId);
    const key = isScoped ? `${item.stepId}:${item.capabilityId}:${item.value}` : item.value;
    return isScoped ? !overwriteItemKeys.has(key) : !overwriteValues.has(item.value);
  });
  const externalPublishItems = manifest.scopedExternalPublishes.length > 0
    ? manifest.scopedExternalPublishes
    : unique(manifest.externalPublishes).map((value) => ({ stepId: "", capabilityId: "", value }));

  const targetKey = (target: GrantTarget) =>
    `${target.grantType}:${target.capability.capabilityId}:${target.capability.signatureHash}:${scopeKey(target.scope)}`;

  const targetHasActiveGrant = (target: GrantTarget) =>
    activeGrants.some((grant) =>
      grant.workflowId === manifest.workflowId &&
      grant.workflowVersion === manifest.workflowVersion &&
      grant.capabilityId === target.capability.capabilityId &&
      grant.grantType === target.grantType &&
      grant.signatureHash === target.capability.signatureHash &&
      scopeIncludes(grant.scope, target.scope)
    );

  const capabilityGrantTargets = (capability: PreflightCapabilityUse) =>
    helperGrantTargets.filter((target) =>
      target.capability.stepId === capability.stepId &&
      target.capability.capabilityId === capability.capabilityId &&
      target.capability.signatureHash === capability.signatureHash
    );

  const capabilityHasCoveredGrantTargets = (capability: PreflightCapabilityUse) => {
    if (capability.policyDecision !== "needs_grant") return false;
    const targets = capabilityGrantTargets(capability);
    return targets.length > 0 && targets.every(targetHasActiveGrant);
  };

  const grantButton = (target: GrantTarget | null) => {
    if (!target) return null;
    const key = targetKey(target);
    if (targetHasActiveGrant(target)) {
      return (
        <span className="run-readiness-grant-approved">
          <ShieldCheck size={14} />
          Approved
        </span>
      );
    }
    if (!onCreateGrant) return null;
    return (
      <button
        type="button"
        className="run-readiness-grant-button"
        aria-label={target.ariaLabel}
        disabled={busyGrantKey === key || busyGrantKey === "all"}
        onClick={() => void createGrant(target)}
      >
        <ShieldCheck size={14} />
        {busyGrantKey === key ? "Granting..." : "Pre-approve"}
      </button>
    );
  };

  const networkGrantTarget = (item: NetworkReadinessItem): GrantTarget | null => {
    const scopedItem = item.capabilityId ? item : undefined;
    if (!scopedItem) return null;
    const capability = preflightForScopedItem(scopedItem);
    if (!capability || capability.policyDecision !== "needs_grant") return null;
    const scope = item.scopeKind === "resource"
      ? {
          ...blankScope(),
          resourceIds: groupedScopedValues(networkResourceItems, scopedItem, item.value),
        }
      : {
          ...blankScope(),
          domains: groupedScopedValues(networkDomainItems, scopedItem, item.value),
        };
    return {
      capability,
      grantType: "network_access",
      scope,
      ariaLabel: `Pre-approve network access for ${item.label}`,
    };
  };

  const credentialGrantTarget = (credential: PreflightCredentialUse): GrantTarget | null => {
    const capability = preflightByCapabilityId.get(credential.capabilityId) ??
      candidateForRequirement((descriptor) => Boolean(descriptor?.requiresCredentials));
    if (!capability || capability.policyDecision !== "needs_grant") return null;
    const credentialRefs = groupedCredentials(credential);
    return {
      capability,
      grantType: "credential_use",
      scope: {
        ...blankScope(),
        credentialRef: credential.credentialRef,
        resourceIds: credentialRefs.length > 1 ? credentialRefs : [],
      },
      ariaLabel: `Pre-approve credential use for ${credential.credentialRef}`,
    };
  };

  const writeGrantTarget = (path: string, isOverwrite: boolean, scopedItem?: PreflightScopedValueUse): GrantTarget | null => {
    const capability = scopedItem
      ? preflightForScopedItem(scopedItem)
      : candidateForRequirement((descriptor) => Boolean(descriptor?.writesFiles));
    if (!capability || capability.policyDecision !== "needs_grant") return null;
    const paths = groupedScopedValues(isOverwrite ? overwriteItems : writeItems, scopedItem, path);
    return {
      capability,
      grantType: isOverwrite ? "file_overwrite" : "file_write",
      scope: {
        ...blankScope(),
        paths,
        maxOverwriteBytes: isOverwrite ? DEFAULT_OVERWRITE_GRANT_BYTES : undefined,
      },
      ariaLabel: `Pre-approve ${isOverwrite ? "overwrite" : "write"} for ${path}`,
    };
  };

  const groupedDeletes = (stepId: string, capabilityId: string) => {
    const deletes = manifest.deletes.filter((candidate) =>
      candidate.stepId === stepId && candidate.capabilityId === capabilityId
    );
    const paths = unique(deletes.map((deleteUse) => deleteUse.pathPattern));
    const maxDeletes = Math.max(
      paths.length,
      ...deletes
        .map((deleteUse) => deleteUse.maxDeletes)
        .filter((value): value is number => typeof value === "number"),
    );
    return {
      paths,
      maxDeletes: Number.isFinite(maxDeletes) && maxDeletes > 0 ? maxDeletes : undefined,
    };
  };

  const deleteGrantTarget = (deleteUse: PreflightManifest["deletes"][number]): GrantTarget | null => {
    const capability = preflightByCapabilityId.get(deleteUse.capabilityId) ??
      candidateForRequirement((descriptor) => Boolean(descriptor?.destructive));
    if (!capability || capability.policyDecision !== "needs_grant") return null;
    const scope = groupedDeletes(deleteUse.stepId, deleteUse.capabilityId);
    return {
      capability,
      grantType: "file_delete",
      scope: { ...blankScope(), paths: scope.paths, maxDeletes: scope.maxDeletes },
      ariaLabel: `Pre-approve delete for ${deleteUse.pathPattern}`,
    };
  };

  const externalPublishGrantTarget = (target: string, scopedItem?: PreflightScopedValueUse): GrantTarget | null => {
    const capability = scopedItem
      ? preflightForScopedItem(scopedItem)
      : candidateForRequirement((descriptor) =>
          Boolean(descriptor?.permissions.some((permission) => permission.includes(":publish") || permission.includes("publish"))),
        );
    if (!capability || capability.policyDecision !== "needs_grant") return null;
    const externalTargets = groupedScopedValues(externalPublishItems, scopedItem, target);
    return {
      capability,
      grantType: "external_publish",
      scope: { ...blankScope(), externalTargets },
      ariaLabel: `Pre-approve external publish for ${target}`,
    };
  };

  const missingGrantTargets = Array.from(
    new Map(
      helperGrantTargets
        .filter((target) => !targetHasActiveGrant(target))
        .map((target) => [targetKey(target), target]),
    ).values(),
  );

  const createAllGrants = async () => {
    if (!onCreateGrant || missingGrantTargets.length === 0) return;
    if (fileGrantScope === "destination_folder" && missingGrantTargets.some((target) =>
      target.grantType === "file_write" || target.grantType === "file_overwrite"
    )) {
      setNotice({
        message: "Destination folder grants are not available for this preflight; use exact displayed paths.",
        tone: "error",
      });
      return;
    }
    setBusyGrantKey("all");
    setNotice(null);
    try {
      const approvedAt = new Date();
      const results = await Promise.all(missingGrantTargets.map((target) =>
        resolveApprovalGrantResult(onCreateGrant(grantDraftForTarget(target, approvedAt)))
      ));
      const failedGrant = results.find((result) => !result.ok);
      if (failedGrant) {
        setNotice({ message: failedGrant.message, tone: "error" });
        return;
      }
      setNotice({ message: "All required grants approved. Run the workflow when ready.", tone: "success" });
    } catch {
      setNotice({ message: "Approval grant failed", tone: "error" });
    } finally {
      setBusyGrantKey(null);
    }
  };

  return (
    <section className="workflow-editor-panel run-readiness-panel" aria-label="Run readiness">
      <div className="run-readiness-header">
        <div>
          <h2>Run readiness</h2>
          <span className="settings-card-detail">
            Preflight v{manifest.workflowVersion} · recommended {manifest.policyRecommendation.replace("_", " ")}
          </span>
        </div>
      </div>
      {notice && (
        <span className={notice.tone === "error" ? "error-note" : "success-note"}>
          {notice.message}
        </span>
      )}

      <section className="run-readiness-section" role="region" aria-label="Grant options">
        <div className="run-readiness-section-header">
          <h3>Grant options</h3>
        </div>
        <div className="tools-autonomy-controls">
          <label>
            <span>Grant scope</span>
            <select
              aria-label="Grant scope"
              value={grantDuration}
              onChange={(event) => setGrantDuration(event.currentTarget.value as GrantDuration)}
            >
              <option value="this_run">This run</option>
              <option value="workflow_version">Workflow version</option>
              <option value="1h">1 hour expiration</option>
              <option value="24h">24 hour expiration</option>
            </select>
          </label>
          <label>
            <span>File scope</span>
            <select
              aria-label="File scope"
              value={fileGrantScope}
              onChange={(event) => setFileGrantScope(event.currentTarget.value as FileGrantScope)}
            >
              <option value="exact">Exact displayed paths</option>
              <option value="destination_folder">Destination folder</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => void markCategoriesAlwaysAsk()}
            disabled={
              (!onCategoryOverridesChange && !onCategoryOverrideChange) ||
              needsGrantCategories.length === 0 ||
              busyPolicyAction === "always_ask"
            }
          >
            {busyPolicyAction === "always_ask" ? "Saving..." : "Always ask"}
          </button>
          <button type="button" onClick={showBlockCapabilityNotice} disabled={needsGrantCapabilities.length === 0}>
            Block capability
          </button>
          <button
            type="button"
            className="run-readiness-grant-button"
            aria-label="Pre-approve all required grants"
            onClick={() => void createAllGrants()}
            disabled={!onCreateGrant || missingGrantTargets.length === 0 || busyGrantKey === "all"}
          >
            <ShieldCheck size={14} />
            {busyGrantKey === "all" ? "Granting..." : "Pre-approve all"}
          </button>
        </div>
      </section>

      <div className="run-readiness-sections">
        <Section title="Required tools">
          {manifest.capabilities.length === 0 ? (
            <EmptySection label="No tool capabilities are required." />
          ) : (
            <ul className="run-readiness-list">
              {manifest.capabilities.map((capability) => {
                const descriptor = capabilityById.get(capability.capabilityId);
                const coveredByGrants = capabilityHasCoveredGrantTargets(capability);
                const tone = coveredByGrants ? "auto" : policyTone(capability.policyDecision);
                const toolGrantTarget = helperGrantTargets.find((target) =>
                  target.capability.stepId === capability.stepId &&
                  target.capability.capabilityId === capability.capabilityId &&
                  target.grantType === "tool_execution"
                ) ?? null;
                return (
                  <li key={`${capability.stepId}:${capability.capabilityId}`}>
                    <span>
                      <strong>{descriptor?.displayName ?? capability.capabilityId}</strong>
                      <small>{capability.reason}</small>
                    </span>
                    <span className={`run-readiness-policy run-readiness-policy-${tone}`}>
                      {coveredByGrants ? "Approved" : policyLabels[tone]}
                    </span>
                    {grantButton(toolGrantTarget)}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Network">
          {networkItems.length === 0 ? (
            <EmptySection label="No network domains detected." />
          ) : (
            <ul className="run-readiness-list">
              {networkItems.map((item) => (
                <li key={`${item.scopeKind}:${item.stepId}:${item.capabilityId}:${item.value}`}>
                  <span>
                    <strong>{item.label}</strong>
                    {item.scopeKind === "resource" && <small>Resource-scoped network access</small>}
                  </span>
                  {grantButton(networkGrantTarget(item))}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Credentials">
          {manifest.credentials.length === 0 ? (
            <EmptySection label="No credential use detected." />
          ) : (
            <ul className="run-readiness-list">
              {manifest.credentials.map((credential) => (
                <li key={`${credential.stepId}:${credential.credentialRef}`}>
                  <span>
                    <strong>{credential.credentialRef}</strong>
                    <small>{capabilityById.get(credential.capabilityId)?.displayName ?? credential.capabilityId}</small>
                  </span>
                  {grantButton(credentialGrantTarget(credential))}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Writes and overwrites">
          {writeItems.length === 0 && overwriteItems.length === 0 ? (
            <EmptySection label="No file writes or overwrites detected." />
          ) : (
            <ul className="run-readiness-list">
              {writeItems.map((item) => (
                <li key={`write:${item.stepId}:${item.capabilityId}:${item.value}`}>
                  <span>{item.value}</span>
                  {grantButton(writeGrantTarget(item.value, false, item.capabilityId ? item : undefined))}
                </li>
              ))}
              {overwriteItems.map((item) => (
                <li key={`overwrite:${item.stepId}:${item.capabilityId}:${item.value}`}>
                  <span>
                    <strong>{item.value}</strong>
                    <small>Overwrite</small>
                  </span>
                  {grantButton(writeGrantTarget(item.value, true, item.capabilityId ? item : undefined))}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Deletes">
          {manifest.deletes.length === 0 ? (
            <EmptySection label="No deletes detected." />
          ) : (
            <ul className="run-readiness-list">
              {manifest.deletes.map((deleteUse) => (
                <li key={`${deleteUse.stepId}:${deleteUse.pathPattern}`}>
                  <span>
                    <strong>{deleteUse.pathPattern}</strong>
                    <small>{deleteUse.maxDeletes != null ? `Up to ${deleteUse.maxDeletes}` : "Delete scope"}</small>
                  </span>
                  {grantButton(deleteGrantTarget(deleteUse))}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="External publishing">
          {externalPublishItems.length === 0 ? (
            <EmptySection label="No external publishing targets detected." />
          ) : (
            <ul className="run-readiness-list">
              {externalPublishItems.map((item) => (
                <li key={`${item.stepId}:${item.capabilityId}:${item.value}`}>
                  <span>{item.value}</span>
                  {grantButton(externalPublishGrantTarget(item.value, item.capabilityId ? item : undefined))}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Blocking items">
          {manifest.blockingItems.length === 0 ? (
            <EmptySection label="No blocking items." />
          ) : (
            <ul className="run-readiness-list">
              {manifest.blockingItems.map((item) => (
                <li key={`${item.stepId}:${item.capabilityId}:${item.reason}`}>
                  <span>
                    <strong>{capabilityById.get(item.capabilityId)?.displayName ?? item.capabilityId}</strong>
                    <small>{item.reason}</small>
                  </span>
                  <span className="run-readiness-policy run-readiness-policy-blocked">
                    Blocked
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </section>
  );
}
