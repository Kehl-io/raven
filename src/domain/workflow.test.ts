import { describe, expect, it } from "vitest";
import type { CapabilityDescriptor, PluginManifest, RavenWorkflow } from "./types";
import {
  currentWeatherWorkflow,
  dailyWorkJournalWorkflow,
  morningBriefWorkflow,
  validateWorkflowDefinition,
} from "./workflow";

describe("Raven workflow schema v0.1.0", () => {
  function testCapability(
    overrides: Partial<CapabilityDescriptor> & Pick<CapabilityDescriptor, "id" | "provider" | "action">,
  ): CapabilityDescriptor {
    return {
      displayName: "Test capability",
      description: "Validates registry behavior.",
      category: "test",
      source: "cli",
      status: "available",
      executionMode: "deterministic",
      deterministic: true,
      readOnly: true,
      idempotent: true,
      destructive: false,
      openWorld: false,
      requiresNetwork: false,
      writesFiles: false,
      requiresCredentials: false,
      permissions: ["data:read"],
      intentTags: [],
      bestFor: [],
      notFor: [],
      builderGuidance: "",
      fallbackStrategy: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      trustTier: "raven_builtin",
      defaultApproval: "auto",
      adapter: { kind: "native", handler: overrides.id },
      signatureHash: overrides.id,
      ...overrides,
    };
  }

  function artifactWriteCapability(): CapabilityDescriptor {
    return testCapability({
      id: "local_app.write_artifact",
      provider: "local_app",
      action: "write_artifact",
      source: "builtin",
      deterministic: true,
      permissions: ["artifact:write"],
      adapter: { kind: "native", handler: "local_app.write_artifact" },
      signatureHash: "local-app-write-artifact",
    });
  }

  it("accepts the first-party artifact templates", () => {
    expect(validateWorkflowDefinition(dailyWorkJournalWorkflow).valid).toBe(true);
    expect(validateWorkflowDefinition(morningBriefWorkflow).valid).toBe(true);
    expect(validateWorkflowDefinition(currentWeatherWorkflow).valid).toBe(true);
  });

  it("seeds current weather as a prompt-native agent task", () => {
    expect(currentWeatherWorkflow.permissions).toEqual([
      "llm:generate",
      "network:read",
      "artifact:write",
    ]);
    expect(currentWeatherWorkflow.defaults.llmProfileRef).toBe("codex-oauth-local");
    expect(currentWeatherWorkflow.steps[0]).toMatchObject({
      kind: "agent_task",
      id: "ask-ai",
      provider: "agent",
      action: "run_task",
      dependsOn: [],
      permissions: ["llm:generate", "network:read"],
      llmProfileRef: "codex-oauth-local",
      inputs: {
        objective: "What's the weather today in Denver?",
        allowed_tools: ["web"],
      },
    });
    expect(currentWeatherWorkflow.steps[1]).toMatchObject({
      kind: "provider_action",
      id: "write-artifact",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["ask-ai"],
      inputs: { artifact: "$steps.ask-ai.artifact" },
    });
  });

  it("accepts prompt-native agent tasks with declared permissions", () => {
    const workflow: RavenWorkflow = {
      ...currentWeatherWorkflow,
      id: "agent-weather",
      permissions: ["llm:generate", "network:read", "artifact:write"],
      defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
      steps: [
        {
          kind: "agent_task",
          id: "ask-ai",
          name: "Ask AI",
          provider: "agent",
          action: "run_task",
          dependsOn: [],
          permissions: ["llm:generate", "network:read"],
          llmProfileRef: "codex-oauth-local",
          inputs: {
            objective: "What's the weather today in Denver?",
            output_schema: "artifact_envelope",
            allowed_tools: ["web"],
          },
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save result locally",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: ["ask-ai"],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.ask-ai.artifact" },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow).valid).toBe(true);
  });

  it("accepts configured artifact destinations allowed by the backend validator", () => {
    for (const destinationRef of ["local_app", "markdown_folder", "obsidian_vault"] as const) {
      const workflow = structuredClone(currentWeatherWorkflow);
      workflow.defaults.destinationRef = destinationRef;
      workflow.steps[1].destinationRef = destinationRef;

      expect(validateWorkflowDefinition(workflow).valid).toBe(true);
    }
  });

  it("accepts agent tasks with implemented agent profiles", () => {
    for (const profile of [
      "codex-oauth-local",
      "claude-code-oauth-local",
      "openai-api-key",
      "anthropic-api-key",
      "ollama-local",
    ]) {
      const workflow = structuredClone(currentWeatherWorkflow);
      workflow.defaults.llmProfileRef = profile;
      workflow.steps[0].llmProfileRef = profile;

      expect(validateWorkflowDefinition(workflow).valid).toBe(true);
    }
  });

  it("rejects agent tasks with unknown LLM profiles", () => {
    const workflow = structuredClone(currentWeatherWorkflow);
    workflow.defaults.llmProfileRef = "made-up-agent";
    workflow.steps[0].llmProfileRef = "made-up-agent";

    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Step ask-ai references missing LLM profile made-up-agent.",
    );
    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Workflow defaults reference missing LLM profile made-up-agent.",
    );
  });

  it("rejects agent tasks with permissions not granted by allowed tools", () => {
    const workflow = structuredClone(currentWeatherWorkflow);
    workflow.permissions.push("git:read");
    workflow.steps[0].permissions = [
      "llm:generate",
      "network:read",
      "git:read",
      "artifact:write",
    ];

    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Step ask-ai declares permission git:read not granted by agent allowed_tools.",
    );
    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Step ask-ai declares permission artifact:write not granted by agent allowed_tools.",
    );
  });

  it("rejects agent tasks when step permissions omit allowed tool permissions", () => {
    const workflow: RavenWorkflow = {
      ...currentWeatherWorkflow,
      id: "agent-weather",
      permissions: ["llm:generate", "network:read", "artifact:write"],
      defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
      steps: [
        {
          kind: "agent_task",
          id: "ask-ai",
          name: "Ask AI",
          provider: "agent",
          action: "run_task",
          dependsOn: [],
          permissions: ["llm:generate"],
          llmProfileRef: "codex-oauth-local",
          inputs: {
            objective: "What's the weather today in Denver?",
            output_schema: "artifact_envelope",
            allowed_tools: ["web"],
          },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Step ask-ai allows tool web but step does not declare network:read.",
    );
  });

  it("rejects agent tasks with null inputs without throwing", () => {
    const workflow = structuredClone(currentWeatherWorkflow);
    workflow.steps[0].inputs = null as unknown as Record<string, unknown>;

    expect(() => validateWorkflowDefinition(workflow)).not.toThrow();
    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Step ask-ai agent_task must include non-empty inputs.objective.",
    );
  });

  it("rejects agent tasks with unknown allowed tools", () => {
    const workflow: RavenWorkflow = {
      ...currentWeatherWorkflow,
      id: "agent-weather",
      permissions: ["llm:generate", "network:read", "artifact:write"],
      defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
      steps: [
        {
          kind: "agent_task",
          id: "ask-ai",
          name: "Ask AI",
          provider: "agent",
          action: "run_task",
          dependsOn: [],
          permissions: ["llm:generate"],
          llmProfileRef: "codex-oauth-local",
          inputs: {
            objective: "What's the weather today in Denver?",
            output_schema: "artifact_envelope",
            allowed_tools: ["shell"],
          },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Step ask-ai allows unknown tool shell.",
    );
  });

  it("rejects agent tasks with malformed allowed_tools", () => {
    const workflow: RavenWorkflow = {
      ...currentWeatherWorkflow,
      id: "agent-weather",
      permissions: ["llm:generate", "network:read", "artifact:write"],
      defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
      steps: [
        {
          kind: "agent_task",
          id: "ask-ai",
          name: "Ask AI",
          provider: "agent",
          action: "run_task",
          dependsOn: [],
          permissions: ["llm:generate", "network:read"],
          llmProfileRef: "codex-oauth-local",
          inputs: {
            objective: "What's the weather today in Denver?",
            output_schema: "artifact_envelope",
            allowed_tools: "web",
          },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Step ask-ai inputs.allowed_tools must be an array when present.",
    );

    const malformedEntry = structuredClone(workflow);
    malformedEntry.steps[0].inputs.allowed_tools = ["web", 42];

    expect(validateWorkflowDefinition(malformedEntry).errors).toContain(
      "Step ask-ai allowed_tools[1] must be a string.",
    );
  });

  it("accepts workflow steps backed by plugin capabilities", () => {
    const plugin: PluginManifest = {
      id: "deterministic_artifact",
      name: "Deterministic Artifact",
      version: "0.1.0",
      description: "Builds deterministic test artifacts.",
      steps: [
        {
          kind: "provider_action",
          provider: "deterministic_artifact",
          action: "build_artifact",
          displayName: "Build artifact",
          permissions: ["plugin:execute"],
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          execution: {
            command: "bin/deterministic-artifact-plugin",
            args: [],
            timeoutMs: 5000,
          },
        },
      ],
    };
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "plugin-artifact",
      name: "Plugin Artifact",
      description: "Builds an artifact with a deterministic plugin.",
      permissions: ["plugin:execute", "artifact:write"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "build-artifact",
          name: "Build artifact",
          provider: "deterministic_artifact",
          action: "build_artifact",
          dependsOn: [],
          permissions: ["plugin:execute"],
          inputs: { subject: "Task 11" },
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save plugin artifact",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: ["build-artifact"],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.build-artifact.artifact" },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow, [plugin])).toEqual({ valid: true, errors: [] });

    workflow.steps[0].permissions = [];
    expect(validateWorkflowDefinition(workflow, [plugin]).errors).toContain(
      "Step build-artifact must declare plugin permission plugin:execute required by deterministic_artifact.build_artifact.",
    );
  });

  it("returns plugin validation errors for malformed plugin inputs", () => {
    const plugin: PluginManifest = {
      id: "deterministic_artifact",
      name: "Deterministic Artifact",
      version: "0.1.0",
      description: "Builds deterministic test artifacts.",
      steps: [
        {
          kind: "provider_action",
          provider: "deterministic_artifact",
          action: "build_artifact",
          displayName: "Build artifact",
          permissions: ["plugin:execute"],
          inputSchema: { type: "object", required: ["subject"] },
          outputSchema: { type: "object" },
          execution: {
            command: "bin/deterministic-artifact-plugin",
            args: [],
            timeoutMs: 5000,
          },
        },
      ],
    };
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "plugin-artifact",
      name: "Plugin Artifact",
      description: "Builds an artifact with a deterministic plugin.",
      permissions: ["plugin:execute"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "build-artifact",
          name: "Build artifact",
          provider: "deterministic_artifact",
          action: "build_artifact",
          dependsOn: [],
          permissions: ["plugin:execute"],
          inputs: null as unknown as Record<string, unknown>,
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow, [plugin]).errors).toEqual(
      expect.arrayContaining([
        "Step build-artifact plugin inputs must be a JSON object.",
        "Step build-artifact plugin inputs must include required field subject.",
      ]),
    );
  });

  it("accepts provider actions from a supplied capability registry before plugin validation", () => {
    const registryCapability = testCapability({
      id: "registry_only.inspect",
      provider: "registry_only",
      action: "inspect",
      displayName: "Inspect registry input",
    });
    const seoCapability = testCapability({
      ...registryCapability,
      id: "seo.audit_metadata",
      provider: "seo",
      action: "audit_metadata",
      displayName: "Audit metadata",
      permissions: ["network:read", "data:read"],
      adapter: { kind: "native", handler: "seo.audit_metadata" },
      signatureHash: "seo-audit-metadata",
    });
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "registry-backed-validation",
      name: "Registry Backed Validation",
      description: "Validates provider actions from the capability registry.",
      permissions: ["data:read", "network:read"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "inspect",
          name: "Inspect",
          provider: "registry_only",
          action: "inspect",
          dependsOn: [],
          permissions: ["data:read"],
          inputs: {},
        },
        {
          kind: "provider_action",
          id: "audit-metadata",
          name: "Audit metadata",
          provider: "seo",
          action: "audit_metadata",
          dependsOn: ["inspect"],
          permissions: ["network:read", "data:read"],
          inputs: { body_text: "$steps.inspect.body_text" },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow, [], [registryCapability, seoCapability])).toEqual({
      valid: true,
      errors: [],
    });

    workflow.steps[0].permissions = [];
    expect(validateWorkflowDefinition(workflow, [], [registryCapability, seoCapability]).errors).toContain(
      "Step inspect must declare capability permission data:read required by registry_only.inspect.",
    );
  });

  it("uses registry matches instead of overlapping plugin runtime validation", () => {
    const plugin: PluginManifest = {
      id: "overlap_plugin",
      name: "Overlap Plugin",
      version: "0.1.0",
      description: "Overlaps a registry capability.",
      steps: [
        {
          kind: "provider_action",
          provider: "registry_only",
          action: "inspect",
          displayName: "Inspect",
          permissions: ["plugin:execute"],
          inputSchema: { type: "object", required: ["subject"] },
          outputSchema: { type: "object" },
          execution: {
            command: "bin/overlap-plugin",
            args: [],
            timeoutMs: 5000,
          },
        },
      ],
    };
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "registry-plugin-overlap",
      name: "Registry Plugin Overlap",
      description: "Validates registry precedence over plugin runtime shape.",
      permissions: ["data:read", "artifact:write"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "inspect",
          name: "Inspect",
          provider: "registry_only",
          action: "inspect",
          dependsOn: [],
          permissions: ["data:read"],
          inputs: {},
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save artifact",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: ["inspect"],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.inspect.artifact" },
        },
      ],
    };

    expect(
      validateWorkflowDefinition(workflow, [plugin], [
        testCapability({ id: "registry_only.inspect", provider: "registry_only", action: "inspect" }),
      ]),
    ).toEqual({ valid: true, errors: [] });
  });

  it("uses registry deterministic flags for builtin-source capabilities outside the static list", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "registry-builtin-deterministic",
      name: "Registry Builtin Deterministic",
      description: "Validates registry determinism from builtin-source descriptors.",
      permissions: ["data:read", "artifact:write"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "inspect",
          name: "Inspect",
          provider: "registry_only",
          action: "inspect",
          dependsOn: [],
          permissions: ["data:read"],
          inputs: {},
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save artifact",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: ["inspect"],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.inspect.artifact" },
        },
      ],
    };

    expect(
      validateWorkflowDefinition(workflow, [], [
        testCapability({
          id: "registry_only.inspect",
          provider: "registry_only",
          action: "inspect",
          source: "builtin",
          deterministic: true,
        }),
      ]),
    ).toEqual({ valid: true, errors: [] });
  });

  it("does not double-count local_app write_artifact as deterministic when supplied by registry", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "registry-deterministic-sink",
      name: "Registry Deterministic Sink",
      description: "Validates deterministic registry runtime shape with an artifact sink.",
      permissions: ["data:read", "artifact:write"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "inspect",
          name: "Inspect",
          provider: "registry_only",
          action: "inspect",
          dependsOn: [],
          permissions: ["data:read"],
          inputs: {},
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save artifact",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: ["inspect"],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.inspect.artifact" },
        },
      ],
    };

    expect(
      validateWorkflowDefinition(workflow, [], [
        testCapability({ id: "registry_only.inspect", provider: "registry_only", action: "inspect" }),
        artifactWriteCapability(),
      ]),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects unavailable registry capabilities as provider actions", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "unavailable-registry-action",
      name: "Unavailable Registry Action",
      description: "Rejects unavailable registry capabilities.",
      permissions: ["data:read"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "inspect",
          name: "Inspect",
          provider: "registry_only",
          action: "inspect",
          dependsOn: [],
          permissions: ["data:read"],
          inputs: {},
        },
      ],
    };

    expect(
      validateWorkflowDefinition(workflow, [], [
        testCapability({
          id: "registry_only.inspect",
          provider: "registry_only",
          action: "inspect",
          status: "unavailable",
        }),
      ]).errors,
    ).toContain("Step inspect references unsupported action registry_only.inspect.");
  });

  it("rejects agent registry capabilities as provider actions", () => {
    for (const [provider, action, permission] of [
      ["agent", "run_task", "llm:generate"],
      ["agent_tool", "web_search", "network:read"],
    ] as const) {
      const workflow: RavenWorkflow = {
        schemaVersion: "0.1.0",
        id: `${provider}-${action}`,
        name: "Agent Registry Provider Action",
        description: "Rejects agent-only registry capabilities as provider actions.",
        permissions: [permission],
        defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
        schedule: { cadence: "manual" },
        steps: [
          {
            kind: "provider_action",
            id: "agent-capability",
            name: "Agent capability",
            provider,
            action,
            dependsOn: [],
            permissions: [permission],
            inputs: { objective: "Summarize" },
          },
        ],
      };

      expect(
        validateWorkflowDefinition(workflow, [], [
          testCapability({
            id: `${provider}.${action}`,
            provider,
            action,
            permissions: [permission],
            deterministic: false,
          }),
        ]).errors,
      ).toContain(`Step agent-capability references unsupported action ${provider}.${action}.`);
    }
  });

  it("accepts http_probe provider action", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "url-check",
      name: "URL Check",
      description: "Checks URLs with a deterministic provider.",
      permissions: ["network:read"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "check-urls",
          name: "Check URLs",
          provider: "http_probe",
          action: "check_urls",
          dependsOn: [],
          permissions: ["network:read"],
          inputs: { urls: ["https://example.com"] },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow)).toEqual({ valid: true, errors: [] });
  });

  it("rejects http_probe without urls", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "url-check",
      name: "URL Check",
      description: "Checks URLs with a deterministic provider.",
      permissions: ["network:read"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "check-urls",
          name: "Check URLs",
          provider: "http_probe",
          action: "check_urls",
          dependsOn: [],
          permissions: ["network:read"],
          inputs: {},
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Step check-urls http_probe.check_urls inputs.urls must be a non-empty array of strings.",
    );
  });

  it("rejects http_probe with null inputs without throwing", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "url-check",
      name: "URL Check",
      description: "Checks URLs with a deterministic provider.",
      permissions: ["network:read"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "check-urls",
          name: "Check URLs",
          provider: "http_probe",
          action: "check_urls",
          dependsOn: [],
          permissions: ["network:read"],
          inputs: null as unknown as Record<string, unknown>,
        },
      ],
    };

    expect(() => validateWorkflowDefinition(workflow)).not.toThrow();
    expect(validateWorkflowDefinition(workflow).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "http_probe.check_urls inputs.urls must be a non-empty array of strings",
        ),
      ]),
    );
  });

  it("validates http_probe accepted_status_codes bounds", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "url-check",
      name: "URL Check",
      description: "Checks URLs with a deterministic provider.",
      permissions: ["network:read"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "check-urls",
          name: "Check URLs",
          provider: "http_probe",
          action: "check_urls",
          dependsOn: [],
          permissions: ["network:read"],
          inputs: { urls: ["https://example.com"], accepted_status_codes: [100, 599] },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow)).toEqual({ valid: true, errors: [] });

    const belowRange = structuredClone(workflow);
    belowRange.steps[0].inputs.accepted_status_codes = [99];

    expect(validateWorkflowDefinition(belowRange).errors).toContain(
      "Step check-urls http_probe.check_urls inputs.accepted_status_codes[0] must be an HTTP status code from 100 through 599.",
    );

    const aboveRange = structuredClone(workflow);
    aboveRange.steps[0].inputs.accepted_status_codes = [600];

    expect(validateWorkflowDefinition(aboveRange).errors).toContain(
      "Step check-urls http_probe.check_urls inputs.accepted_status_codes[0] must be an HTTP status code from 100 through 599.",
    );
  });

  it("rejects agent web for URL/uptime checks", () => {
    for (const objective of [
      "Check whether https://example.com is reachable.",
      "Check uptime for example.com",
      "Is example.com up?",
    ]) {
      const workflow = structuredClone(currentWeatherWorkflow);
      workflow.steps[0].inputs.objective = objective;

      expect(validateWorkflowDefinition(workflow).errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Use deterministic provider http_probe.check_urls"),
        ]),
      );
    }
  });

  it("accepts agent web for content inspection tasks", () => {
    for (const objective of [
      "Check https://example.com docs for API changes",
      "Verify pricing on example.com",
      "Look up pricing on example.com",
    ]) {
      const workflow = structuredClone(currentWeatherWorkflow);
      workflow.steps[0].inputs.objective = objective;

      expect(validateWorkflowDefinition(workflow)).toEqual({ valid: true, errors: [] });
    }
  });

  it("accepts mixed http_probe -> agent -> write-artifact shape", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "url-check-summary",
      name: "URL Check Summary",
      description: "Checks URLs deterministically, asks an agent to summarize, and stores the artifact.",
      permissions: ["network:read", "llm:generate", "artifact:write"],
      defaults: { llmProfileRef: "claude-code-oauth-local", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "check-urls",
          name: "Check URLs",
          provider: "http_probe",
          action: "check_urls",
          dependsOn: [],
          permissions: ["network:read"],
          inputs: { urls: ["https://example.com"] },
        },
        {
          kind: "agent_task",
          id: "summarize",
          name: "Summarize URL results",
          provider: "agent",
          action: "run_task",
          dependsOn: ["check-urls"],
          permissions: ["llm:generate"],
          llmProfileRef: "claude-code-oauth-local",
          inputs: {
            objective: "Summarize the deterministic URL check results from $steps.check-urls.results.",
            output_schema: "artifact_envelope",
            allowed_tools: [],
          },
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save summary artifact",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: ["summarize"],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.summarize.artifact" },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow)).toEqual({ valid: true, errors: [] });
  });

  it("accepts mixed roadmap provider -> agent -> write-artifact shape", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "weather-news-summary",
      name: "Weather News Summary",
      description: "Collects deterministic weather and news before agent synthesis.",
      permissions: ["weather:read", "network:read", "llm:generate", "artifact:write"],
      defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "forecast",
          name: "Fetch forecast",
          provider: "weather",
          action: "forecast_24h",
          dependsOn: [],
          permissions: ["weather:read"],
          inputs: { location: "Denver, CO" },
        },
        {
          kind: "provider_action",
          id: "headlines",
          name: "Fetch headlines",
          provider: "news",
          action: "trending",
          dependsOn: [],
          permissions: ["network:read"],
          inputs: { max_items: 5 },
        },
        {
          kind: "agent_task",
          id: "summarize",
          name: "Summarize",
          provider: "agent",
          action: "run_task",
          dependsOn: ["forecast", "headlines"],
          permissions: ["llm:generate"],
          llmProfileRef: "codex-oauth-local",
          inputs: {
            objective: "Summarize deterministic forecast and news outputs.",
            allowed_tools: [],
          },
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save artifact",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: ["summarize"],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.summarize.artifact" },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow)).toEqual({ valid: true, errors: [] });
  });

  it("accepts SEO evidence and content brief before agent writing", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "seo-service-page",
      name: "SEO Service Page",
      description: "Audits SEO context, prepares a content brief, writes a service page, and saves it.",
      permissions: ["network:read", "data:read", "llm:generate", "artifact:write"],
      defaults: { llmProfileRef: "codex-oauth-local", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "fetch-page",
          name: "Fetch page",
          provider: "web",
          action: "fetch_page",
          dependsOn: [],
          permissions: ["network:read"],
          inputs: { url: "https://example.com/services/seo" },
        },
        {
          kind: "provider_action",
          id: "audit-metadata",
          name: "Audit metadata",
          provider: "seo",
          action: "audit_metadata",
          dependsOn: ["fetch-page"],
          permissions: ["network:read", "data:read"],
          inputs: { body_text: "$steps.fetch-page.body_text", url: "https://example.com/services/seo" },
        },
        {
          kind: "provider_action",
          id: "brief",
          name: "Generate brief",
          provider: "content",
          action: "generate_brief",
          dependsOn: ["audit-metadata"],
          permissions: ["data:read"],
          inputs: {
            topic: "SEO consulting for SaaS",
            audience: "B2B SaaS founders",
            page_type: "service",
            business_goal: "book consultations",
          },
        },
        {
          kind: "agent_task",
          id: "write-page",
          name: "Write service page",
          provider: "agent",
          action: "run_task",
          dependsOn: ["fetch-page", "audit-metadata", "brief"],
          permissions: ["llm:generate"],
          llmProfileRef: "codex-oauth-local",
          inputs: {
            objective:
              "Write site content using deterministic SEO evidence from $steps.audit-metadata.checks and the brief from $steps.brief.",
            allowed_tools: [],
            output_schema: "artifact_envelope",
          },
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save page draft",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: ["write-page"],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.write-page.artifact" },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow)).toEqual({ valid: true, errors: [] });
  });

  it("rejects provider-only deterministic steps that depend on later steps", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "out-of-order-deterministic",
      name: "Out of Order Deterministic",
      description: "Invalid deterministic provider order.",
      permissions: ["network:read", "data:read"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "shape",
          name: "Shape rows",
          provider: "data",
          action: "transform_json",
          dependsOn: ["check-urls"],
          permissions: ["data:read"],
          inputs: { data: "$steps.check-urls.results" },
        },
        {
          kind: "provider_action",
          id: "check-urls",
          name: "Check URLs",
          provider: "http_probe",
          action: "check_urls",
          dependsOn: [],
          permissions: ["network:read"],
          inputs: { urls: ["https://example.com"] },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Deterministic provider step shape may depend only on earlier deterministic provider steps.",
    );
  });

  it("rejects provider-only sink that references a non-dependency", () => {
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "bad-provider-sink",
      name: "Bad Provider Sink",
      description: "Invalid deterministic provider sink.",
      permissions: ["network:read", "artifact:write"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "check-urls",
          name: "Check URLs",
          provider: "http_probe",
          action: "check_urls",
          dependsOn: [],
          permissions: ["network:read"],
          inputs: { urls: ["https://example.com"] },
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save artifact",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: [],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.check-urls.results" },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Deterministic provider sink write-artifact inputs.artifact must reference one of its dependencies.",
    );
  });

  it("rejects mixed http_probe -> agent shape with invalid dependency direction", () => {
    const missingAgentDependency = mixedHttpProbeAgentArtifactWorkflow();
    missingAgentDependency.steps[1].dependsOn = [];

    expect(validateWorkflowDefinition(missingAgentDependency).errors).toContain(
      "Agent runtime step summarize must depend on check-urls.",
    );

    const laterStepDependency = mixedHttpProbeAgentArtifactWorkflow();
    laterStepDependency.steps.splice(1, 0, {
      kind: "provider_action",
      id: "check-api",
      name: "Check API URL",
      provider: "http_probe",
      action: "check_urls",
      dependsOn: [],
      permissions: ["network:read"],
      inputs: { urls: ["https://api.example.com"] },
    });
    laterStepDependency.steps[0].dependsOn = ["check-api"];
    laterStepDependency.steps[2].dependsOn = ["check-urls", "check-api"];

    expect(validateWorkflowDefinition(laterStepDependency).errors).toContain(
      "Agent runtime deterministic step check-urls may depend only on earlier deterministic steps.",
    );
  });

  it("rejects plugin workflows with unsupported runtime shape", () => {
    const plugin: PluginManifest = {
      id: "deterministic_artifact",
      name: "Deterministic Artifact",
      version: "0.1.0",
      description: "Builds deterministic test artifacts.",
      steps: [
        {
          kind: "provider_action",
          provider: "deterministic_artifact",
          action: "build_artifact",
          displayName: "Build artifact",
          permissions: ["plugin:execute"],
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          execution: {
            command: "bin/deterministic-artifact-plugin",
            args: [],
            timeoutMs: 5000,
          },
        },
      ],
    };
    const workflow: RavenWorkflow = {
      schemaVersion: "0.1.0",
      id: "plugin-artifact",
      name: "Plugin Artifact",
      description: "Builds an artifact with a deterministic plugin.",
      permissions: ["plugin:execute", "artifact:write", "weather:read"],
      defaults: { llmProfileRef: "default-openai", destinationRef: "local-app" },
      schedule: { cadence: "manual" },
      steps: [
        {
          kind: "provider_action",
          id: "build-artifact",
          name: "Build artifact",
          provider: "deterministic_artifact",
          action: "build_artifact",
          dependsOn: [],
          permissions: ["plugin:execute"],
          inputs: { subject: "Task 11" },
        },
        {
          kind: "provider_action",
          id: "write-artifact",
          name: "Save plugin artifact",
          provider: "local_app",
          action: "write_artifact",
          dependsOn: ["other-step"],
          permissions: ["artifact:write"],
          destinationRef: "local-app",
          inputs: { artifact: "$steps.build-artifact.artifact" },
        },
        {
          kind: "provider_action",
          id: "fetch-weather",
          name: "Fetch weather",
          provider: "open_meteo",
          action: "current_weather",
          dependsOn: ["build-artifact"],
          permissions: ["weather:read"],
          inputs: { location: "Denver, CO" },
        },
      ],
    };

    expect(validateWorkflowDefinition(workflow, [plugin]).errors).toEqual(
      expect.arrayContaining([
        "Plugin runtime supports one plugin step plus optional local_app.write_artifact sink.",
        "Plugin runtime sink write-artifact must depend on build-artifact and reference $steps.build-artifact.artifact.",
      ]),
    );
  });

  it("rejects agent workflows with extra executable provider steps", () => {
    const workflow = structuredClone(currentWeatherWorkflow);
    workflow.permissions.push("weather:read");
    workflow.steps.push({
      kind: "provider_action",
      id: "fetch-weather",
      name: "Fetch current weather",
      provider: "open_meteo",
      action: "current_weather",
      dependsOn: ["ask-ai"],
      permissions: ["weather:read"],
      inputs: { location: "Denver, CO" },
    });

    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Agent runtime supports exactly one agent_task step plus optional local_app.write_artifact sink.",
    );
  });

  it("rejects agent workflows with invalid write artifact sink wiring", () => {
    const invalidDependency = structuredClone(currentWeatherWorkflow);
    invalidDependency.steps[1].dependsOn = ["other-step"];

    expect(validateWorkflowDefinition(invalidDependency).errors).toContain(
      "Agent runtime sink write-artifact must depend only on ask-ai.",
    );

    const invalidInput = structuredClone(currentWeatherWorkflow);
    invalidInput.steps[1].inputs = { artifact: "$steps.other.artifact" };

    expect(validateWorkflowDefinition(invalidInput).errors).toContain(
      "Agent runtime sink write-artifact inputs.artifact must reference $steps.ask-ai.artifact.",
    );
  });

  it("rejects agent write artifact sink with null inputs without throwing", () => {
    const workflow = structuredClone(currentWeatherWorkflow);
    workflow.steps[1].inputs = null as unknown as Record<string, unknown>;

    expect(() => validateWorkflowDefinition(workflow)).not.toThrow();
    expect(validateWorkflowDefinition(workflow).errors).toContain(
      "Agent runtime sink write-artifact inputs.artifact must reference $steps.ask-ai.artifact.",
    );
  });

  it("rejects cycles, missing providers, missing permissions, invalid expressions, and inline code", () => {
    const cyclic = structuredClone(dailyWorkJournalWorkflow);
    cyclic.steps[0].dependsOn = ["write-artifact"];
    expect(validateWorkflowDefinition(cyclic).errors).toContain("Workflow graph contains a cycle.");

    const missingProvider = structuredClone(dailyWorkJournalWorkflow);
    missingProvider.steps[0].provider = "unknown";
    expect(validateWorkflowDefinition(missingProvider).errors).toContain(
      "Step collect-context references unavailable provider unknown.",
    );

    const missingPermission = structuredClone(dailyWorkJournalWorkflow);
    missingPermission.steps[0].permissions = ["git:write"];
    expect(validateWorkflowDefinition(missingPermission).errors).toContain(
      "Step collect-context requires undeclared permission git:write.",
    );

    const invalidExpression = structuredClone(dailyWorkJournalWorkflow);
    invalidExpression.steps[1].inputs.prompt = "{{ process.exit(1) }}";
    expect(validateWorkflowDefinition(invalidExpression).errors).toContain(
      "Step compose-artifact contains an expression outside the whitelist.",
    );

    const inlineCode = structuredClone(dailyWorkJournalWorkflow);
    inlineCode.steps[1].inlineCode = "console.log('nope')";
    expect(validateWorkflowDefinition(inlineCode).errors).toContain(
      "Step compose-artifact contains inline arbitrary code.",
    );
  });
});

function mixedHttpProbeAgentArtifactWorkflow(): RavenWorkflow {
  return {
    schemaVersion: "0.1.0",
    id: "url-check-summary",
    name: "URL Check Summary",
    description: "Checks URLs deterministically, asks an agent to summarize, and stores the artifact.",
    permissions: ["network:read", "llm:generate", "artifact:write"],
    defaults: { llmProfileRef: "claude-code-oauth-local", destinationRef: "local-app" },
    schedule: { cadence: "manual" },
    steps: [
      {
        kind: "provider_action",
        id: "check-urls",
        name: "Check URLs",
        provider: "http_probe",
        action: "check_urls",
        dependsOn: [],
        permissions: ["network:read"],
        inputs: { urls: ["https://example.com"] },
      },
      {
        kind: "agent_task",
        id: "summarize",
        name: "Summarize URL results",
        provider: "agent",
        action: "run_task",
        dependsOn: ["check-urls"],
        permissions: ["llm:generate"],
        llmProfileRef: "claude-code-oauth-local",
        inputs: {
          objective: "Summarize the deterministic URL check results from $steps.check-urls.results.",
          output_schema: "artifact_envelope",
          allowed_tools: [],
        },
      },
      {
        kind: "provider_action",
        id: "write-artifact",
        name: "Save summary artifact",
        provider: "local_app",
        action: "write_artifact",
        dependsOn: ["summarize"],
        permissions: ["artifact:write"],
        destinationRef: "local-app",
        inputs: { artifact: "$steps.summarize.artifact" },
      },
    ],
  };
}
