import type {
  ApprovalGrant,
  ApprovalGrantDraft,
  PreflightCapabilityUse,
  PreflightManifest,
} from "../../domain/types";

export const DEFAULT_OVERWRITE_GRANT_BYTES = 1_048_576;

export interface PreflightDerivedGrant {
  capability: PreflightCapabilityUse;
  draft: ApprovalGrantDraft;
}

interface PreflightGrantBuildOptions {
  approvedAt?: string;
  dedupe?: boolean;
  idFactory?: () => string;
  workflowId?: string;
  workflowVersion?: number;
}

function capabilityIdsWithScopedGrantRequirements(manifest: PreflightManifest): Set<string> {
  const capabilityIds = new Set<string>();
  const addScopedItems = (items: Array<{ capabilityId: string }>) => {
    for (const item of items) {
      if (item.capabilityId) capabilityIds.add(item.capabilityId);
    }
  };

  addScopedItems(manifest.scopedFileWrites);
  addScopedItems(manifest.scopedOverwrites);
  addScopedItems(manifest.scopedNetworkDomains);
  addScopedItems(manifest.scopedNetworkResources);
  addScopedItems(manifest.scopedExternalPublishes);
  addScopedItems(manifest.credentials);
  addScopedItems(manifest.deletes);

  return capabilityIds;
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

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function scopedValues(
  items: PreflightManifest["scopedFileWrites"],
  stepId: string,
  capabilityId: string,
): string[] {
  return unique(items
    .filter((item) => item.stepId === stepId && item.capabilityId === capabilityId)
    .map((item) => item.value));
}

function grantDraft(
  capability: PreflightCapabilityUse,
  grantType: ApprovalGrantDraft["grantType"],
  scope: ApprovalGrantDraft["scope"],
  options: Required<PreflightGrantBuildOptions>,
): ApprovalGrantDraft {
  return {
    id: options.idFactory(),
    workflowId: options.workflowId,
    workflowVersion: options.workflowVersion,
    capabilityId: capability.capabilityId,
    grantType,
    scope,
    approvedByUserAt: options.approvedAt,
    signatureHash: capability.signatureHash,
    status: "active",
  };
}

export function derivePreflightApprovalGrants(
  manifest: PreflightManifest,
  options: PreflightGrantBuildOptions = {},
): PreflightDerivedGrant[] {
  const resolvedOptions: Required<PreflightGrantBuildOptions> = {
    approvedAt: options.approvedAt ?? new Date().toISOString(),
    dedupe: options.dedupe ?? true,
    idFactory: options.idFactory ?? grantId,
    workflowId: options.workflowId ?? manifest.workflowId,
    workflowVersion: options.workflowVersion ?? manifest.workflowVersion,
  };

  const derivedGrants: PreflightDerivedGrant[] = [];
  const capabilityIdsWithScopedRequirements = capabilityIdsWithScopedGrantRequirements(manifest);
  const pushGrant = (
    capability: PreflightCapabilityUse,
    grantType: ApprovalGrantDraft["grantType"],
    scope: ApprovalGrantDraft["scope"],
  ) => {
    derivedGrants.push({
      capability,
      draft: grantDraft(capability, grantType, scope, resolvedOptions),
    });
  };

  for (const capability of manifest.capabilities) {
    if (capability.policyDecision !== "needs_grant") continue;
    let addedScopedGrant = false;

    const overwrites = scopedValues(manifest.scopedOverwrites, capability.stepId, capability.capabilityId);
    const overwritePaths = new Set(overwrites);
    const fileWrites = scopedValues(manifest.scopedFileWrites, capability.stepId, capability.capabilityId)
      .filter((path) => !overwritePaths.has(path));
    if (fileWrites.length > 0) {
      pushGrant(capability, "file_write", { ...blankScope(), paths: fileWrites });
      addedScopedGrant = true;
    }

    if (overwrites.length > 0) {
      pushGrant(capability, "file_overwrite", {
        ...blankScope(),
        paths: overwrites,
        maxOverwriteBytes: DEFAULT_OVERWRITE_GRANT_BYTES,
      });
      addedScopedGrant = true;
    }

    const domains = scopedValues(manifest.scopedNetworkDomains, capability.stepId, capability.capabilityId);
    if (domains.length > 0) {
      pushGrant(capability, "network_access", { ...blankScope(), domains });
      addedScopedGrant = true;
    }

    const resources = scopedValues(manifest.scopedNetworkResources, capability.stepId, capability.capabilityId);
    if (resources.length > 0) {
      pushGrant(capability, "network_access", { ...blankScope(), resourceIds: resources });
      addedScopedGrant = true;
    }

    const externalTargets = scopedValues(manifest.scopedExternalPublishes, capability.stepId, capability.capabilityId);
    if (externalTargets.length > 0) {
      pushGrant(capability, "external_publish", { ...blankScope(), externalTargets });
      addedScopedGrant = true;
    }

    const credentials = unique(manifest.credentials
      .filter((credential) =>
        credential.stepId === capability.stepId && credential.capabilityId === capability.capabilityId
      )
      .map((credential) => credential.credentialRef));
    for (const credentialRef of credentials) {
      pushGrant(capability, "credential_use", { ...blankScope(), credentialRef });
      addedScopedGrant = true;
    }

    const deletes = manifest.deletes.filter((deleteUse) =>
      deleteUse.stepId === capability.stepId && deleteUse.capabilityId === capability.capabilityId
    );
    if (deletes.length > 0) {
      pushGrant(capability, "file_delete", {
        ...blankScope(),
        paths: unique(deletes.map((deleteUse) => deleteUse.pathPattern)),
        maxDeletes: Math.max(...deletes.map((deleteUse) => deleteUse.maxDeletes ?? 1)),
      });
      addedScopedGrant = true;
    }

    if (!addedScopedGrant && !capabilityIdsWithScopedRequirements.has(capability.capabilityId)) {
      pushGrant(capability, "tool_execution", blankScope());
    }
  }

  if (!resolvedOptions.dedupe) return derivedGrants;

  return Array.from(new Map(derivedGrants.map((grant) => [
    JSON.stringify({
      capabilityId: grant.draft.capabilityId,
      grantType: grant.draft.grantType,
      signatureHash: grant.draft.signatureHash,
      scope: grant.draft.scope,
    }),
    grant,
  ])).values());
}

export function buildPreflightApprovalGrants(
  manifest: PreflightManifest,
  options: PreflightGrantBuildOptions = {},
): ApprovalGrantDraft[] {
  return derivePreflightApprovalGrants(manifest, options).map((grant) => grant.draft);
}
