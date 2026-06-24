import { describe, expect, it } from "vitest";
import type { PreflightManifest } from "../../domain/types";
import {
  plannerOperationCapability,
  plannerOperationStep,
  preflightManifestMatchesContext,
} from "./WorkflowDetailView";

const manifest: PreflightManifest = {
  id: "preflight-1",
  workflowId: "workflow-a",
  workflowVersion: 2,
  registrySnapshotHash: "registry-1",
  createdAt: "2026-06-21T00:00:00Z",
  capabilities: [],
  credentials: [],
  networkDomains: [],
  fileReads: [],
  fileWrites: [],
  overwrites: [],
  deletes: [],
  externalPublishes: [],
  scopedNetworkDomains: [],
  scopedNetworkResources: [],
  scopedFileWrites: [],
  scopedOverwrites: [],
  scopedExternalPublishes: [],
  policyRecommendation: "safe_auto",
  blockingItems: [],
};

describe("preflightManifestMatchesContext", () => {
  it("requires matching workflow, version, and autonomy mode", () => {
    expect(preflightManifestMatchesContext(manifest, "workflow-a", 2, "safe_auto")).toBe(true);
    expect(preflightManifestMatchesContext(manifest, "workflow-b", 2, "safe_auto")).toBe(false);
    expect(preflightManifestMatchesContext(manifest, "workflow-a", 3, "safe_auto")).toBe(false);
    expect(preflightManifestMatchesContext(manifest, "workflow-a", 2, "workspace_auto")).toBe(false);
    expect(preflightManifestMatchesContext(null, "workflow-a", 2, "safe_auto")).toBe(false);
  });
});

describe("planner operation display helpers", () => {
  it("uses normalized and persisted planner operation field names", () => {
    expect(
      plannerOperationCapability({
        id: "op-1",
        kind: "weather.lookup",
        status: "covered",
        evidence: "Weather lookup requested.",
        capabilityId: "weather.current",
        stepId: "fetch-weather",
        inputs: {},
      }),
    ).toBe("weather.current");
    expect(
      plannerOperationStep({
        id: "op-2",
        kind: "rss.fetch",
        status: "covered",
        evidence: "RSS feed requested.",
        capability_id: "rss.fetch_feed",
        step_id: "fetch-feed",
        inputs: {},
      }),
    ).toBe("fetch-feed");
  });
});
