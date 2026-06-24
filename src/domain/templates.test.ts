import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition } from "./workflow";
import { TEMPLATE_CATALOG } from "./templates";

describe("workflow template catalog", () => {
  it("keeps Site Health Check valid with deterministic HTTP probe steps", () => {
    const template = TEMPLATE_CATALOG.find((item) => item.name === "Site Health Check");

    expect(template).toBeDefined();
    expect(template?.workflow.steps[0]).toMatchObject({
      provider: "http_probe",
      action: "check_urls",
    });
    expect(template?.requirements).toEqual(["HTTP probe", "Agent for final summary"]);
    expect(validateWorkflowDefinition(template!.workflow)).toEqual({ valid: true, errors: [] });
  });
});
