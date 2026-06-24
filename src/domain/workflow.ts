import type {
  ArtifactDestinationRef,
  CapabilityDescriptor,
  PluginManifest,
  RavenWorkflow,
  WorkflowStepDefinition,
} from "./types";
import { capabilityId, capabilityMap } from "./capabilityRegistry";

const providerCapabilities: Record<string, Set<string>> = {
  http_probe: new Set(["check_urls"]),
  local_git: new Set(["recent_activity", "context_pack"]),
  nestweaver: new Set(["health", "project_context"]),
  open_meteo: new Set(["current_weather"]),
  weather: new Set(["forecast_24h", "hourly_forecast", "alerts"]),
  news: new Set(["trending", "search"]),
  rss: new Set(["fetch_feed"]),
  web: new Set(["fetch_page", "extract_article", "extract_metadata"]),
  seo: new Set([
    "fetch_robots_txt",
    "parse_robots_txt",
    "fetch_sitemap",
    "parse_sitemap",
    "audit_indexability",
    "audit_metadata",
    "extract_structured_data",
    "validate_json_ld",
    "audit_links",
    "audit_canonical_hreflang",
  ]),
  content: new Set(["map_search_intent", "generate_brief", "identify_gaps", "score_quality"]),
  data: new Set(["parse_csv", "transform_json"]),
  scheduler: new Set(["preview_next_runs"]),
  notification: new Set(["local"]),
  mcp: new Set(["discover_tools"]),
  openai: new Set(["chat_stream", "generate_artifact", "structured_output"]),
  local_app: new Set(["write_artifact", "read_artifact"]),
};
const deterministicProviderCapabilities = new Set([
  "http_probe.check_urls",
  "open_meteo.current_weather",
  "weather.forecast_24h",
  "weather.hourly_forecast",
  "weather.alerts",
  "news.trending",
  "news.search",
  "rss.fetch_feed",
  "web.fetch_page",
  "web.extract_article",
  "web.extract_metadata",
  "seo.fetch_robots_txt",
  "seo.parse_robots_txt",
  "seo.fetch_sitemap",
  "seo.parse_sitemap",
  "seo.audit_indexability",
  "seo.audit_metadata",
  "seo.extract_structured_data",
  "seo.validate_json_ld",
  "seo.audit_links",
  "seo.audit_canonical_hreflang",
  "content.map_search_intent",
  "content.generate_brief",
  "content.identify_gaps",
  "content.score_quality",
  "data.parse_csv",
  "data.transform_json",
  "scheduler.preview_next_runs",
  "notification.local",
  "mcp.discover_tools",
]);

export function isDeterministicProviderAction(provider: string, action: string): boolean {
  return deterministicProviderCapabilities.has(`${provider}.${action}`);
}
const providerCapabilityPermissions: Record<string, string[]> = {
  "http_probe.check_urls": ["network:read"],
  "open_meteo.current_weather": ["weather:read"],
  "weather.forecast_24h": ["weather:read"],
  "weather.hourly_forecast": ["weather:read"],
  "weather.alerts": ["weather:read"],
  "news.trending": ["network:read"],
  "news.search": ["network:read"],
  "rss.fetch_feed": ["network:read"],
  "web.fetch_page": ["network:read"],
  "web.extract_article": ["data:read"],
  "web.extract_metadata": ["data:read"],
  "seo.fetch_robots_txt": ["network:read", "data:read"],
  "seo.parse_robots_txt": ["network:read", "data:read"],
  "seo.fetch_sitemap": ["network:read", "data:read"],
  "seo.parse_sitemap": ["network:read", "data:read"],
  "seo.audit_indexability": ["network:read", "data:read"],
  "seo.audit_metadata": ["network:read", "data:read"],
  "seo.extract_structured_data": ["network:read", "data:read"],
  "seo.validate_json_ld": ["network:read", "data:read"],
  "seo.audit_links": ["network:read", "data:read"],
  "seo.audit_canonical_hreflang": ["network:read", "data:read"],
  "content.map_search_intent": ["data:read"],
  "content.generate_brief": ["data:read"],
  "content.identify_gaps": ["data:read"],
  "content.score_quality": ["data:read"],
  "data.parse_csv": ["data:read"],
  "data.transform_json": ["data:read"],
  "scheduler.preview_next_runs": ["schedule:read"],
  "notification.local": ["notification:write"],
  "mcp.discover_tools": ["mcp:read"],
};

const allowedLlmProfiles = new Set([
  "default-openai",
  "codex-oauth-local",
  "claude-code-oauth-local",
  "openai-api-key",
  "anthropic-api-key",
  "ollama-local",
]);
const allowedAgentTaskLlmProfiles = new Set([
  "codex-oauth-local",
  "claude-code-oauth-local",
  "openai-api-key",
  "anthropic-api-key",
  "ollama-local",
]);
const allowedDestinations = new Set<ArtifactDestinationRef>([
  "local-app",
  "local_app",
  "markdown_folder",
  "obsidian_vault",
]);
const whitelistedExpression = /^\$steps\.[a-z0-9-]+\.[a-zA-Z0-9_.-]+$/;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export const dailyWorkJournalWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "daily-work-journal",
  name: "Daily Work Journal",
  description: "Summarizes local project activity into a concise daily work journal artifact.",
  permissions: ["git:read", "artifact:write", "llm:generate"],
  defaults: {
    llmProfileRef: "default-openai",
    destinationRef: "local-app",
  },
  schedule: {
    cadence: "weekdays",
    localTime: "17:00",
  },
  steps: [
    {
      kind: "provider_action",
      id: "collect-context",
      name: "Collect local git context",
      provider: "local_git",
      action: "recent_activity",
      dependsOn: [],
      permissions: ["git:read"],
      inputs: { window: "today" },
    },
    {
      kind: "provider_action",
      id: "compose-artifact",
      name: "Compose journal artifact",
      provider: "openai",
      action: "generate_artifact",
      dependsOn: ["collect-context"],
      permissions: ["llm:generate"],
      llmProfileRef: "default-openai",
      inputs: {
        template: "daily_work_journal",
        prompt: "$steps.collect-context.summary",
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save artifact locally",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["compose-artifact"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.compose-artifact.artifact",
      },
    },
  ],
};

export const morningBriefWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "morning-brief",
  name: "Morning Brief",
  description: "Builds a morning planning brief from local project context and recent artifacts.",
  permissions: ["git:read", "artifact:read", "artifact:write", "llm:generate"],
  defaults: {
    llmProfileRef: "default-openai",
    destinationRef: "local-app",
  },
  schedule: {
    cadence: "weekdays",
    localTime: "08:00",
  },
  steps: [
    {
      kind: "provider_action",
      id: "collect-context",
      name: "Collect project context",
      provider: "local_git",
      action: "context_pack",
      dependsOn: [],
      permissions: ["git:read"],
      inputs: { window: "yesterday" },
    },
    {
      kind: "provider_action",
      id: "compose-artifact",
      name: "Compose morning brief",
      provider: "openai",
      action: "generate_artifact",
      dependsOn: ["collect-context"],
      permissions: ["llm:generate"],
      llmProfileRef: "default-openai",
      inputs: {
        template: "morning_brief",
        prompt: "$steps.collect-context.summary",
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save artifact locally",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["compose-artifact"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.compose-artifact.artifact",
      },
    },
  ],
};

export const currentWeatherWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "current-weather",
  name: "Current Weather",
  description: "Asks an agent for today's Denver weather and stores the result.",
  permissions: ["llm:generate", "network:read", "artifact:write"],
  defaults: {
    llmProfileRef: "codex-oauth-local",
    destinationRef: "local-app",
  },
  schedule: {
    cadence: "manual",
  },
  steps: [
    {
      kind: "agent_task",
      id: "ask-ai",
      name: "Ask AI for today's weather",
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
      name: "Save weather artifact locally",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["ask-ai"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.ask-ai.artifact",
      },
    },
  ],
};

export function validateWorkflowDefinition(
  workflow: RavenWorkflow,
  plugins: PluginManifest[] = [],
  capabilities: CapabilityDescriptor[] = [],
): ValidationResult {
  const errors: string[] = [];
  const stepIds = new Set<string>();
  const registry = capabilityMap(capabilities);

  if (workflow.schemaVersion !== "0.1.0") {
    errors.push("Workflow schema version must be 0.1.0.");
  }

  if (!allowedLlmProfiles.has(workflow.defaults.llmProfileRef)) {
    errors.push(
      `Workflow defaults reference missing LLM profile ${workflow.defaults.llmProfileRef}.`,
    );
  }

  if (!allowedDestinations.has(workflow.defaults.destinationRef)) {
    errors.push(
      `Workflow defaults reference unavailable destination ${workflow.defaults.destinationRef}.`,
    );
  }

  for (const step of workflow.steps) {
    if (stepIds.has(step.id)) {
      errors.push(`Step id ${step.id} is duplicated.`);
    }
    stepIds.add(step.id);
  }

  for (const step of workflow.steps) {
    validateStep(workflow, step, stepIds, plugins, registry, errors);
  }

  validateAgentRuntimeShape(workflow, registry, errors);
  validatePluginRuntimeShape(workflow, plugins, registry, errors);
  validateDeterministicProviderRuntimeShape(workflow, registry, errors);

  if (hasCycle(workflow.steps)) {
    errors.push("Workflow graph contains a cycle.");
  }

  return { valid: errors.length === 0, errors };
}

function validateStep(
  workflow: RavenWorkflow,
  step: WorkflowStepDefinition,
  stepIds: Set<string>,
  plugins: PluginManifest[],
  registry: Map<string, CapabilityDescriptor>,
  errors: string[],
) {
  const kind = step.kind ?? "provider_action";
  if (kind === "provider_action") {
    const registryCapability = registry.get(providerCapabilityId(step));
    if (registryCapability) {
      validateRegistryProviderAction(workflow, step, registryCapability, errors);
    } else {
      const capabilities = providerCapabilities[step.provider];
      if (!capabilities) {
        validatePluginProviderAction(step, plugins, registry, errors);
      } else if (!capabilities.has(step.action)) {
        errors.push(`Step ${step.id} references unsupported action ${step.provider}.${step.action}.`);
      } else {
        validateFirstPartyProviderAction(workflow, step, errors);
      }
    }
  } else {
    validateAgentTaskStep(workflow, step, errors);
  }

  for (const dependency of step.dependsOn) {
    if (!stepIds.has(dependency)) {
      errors.push(`Step ${step.id} depends on missing step ${dependency}.`);
    }
  }

  for (const permission of step.permissions) {
    if (!workflow.permissions.includes(permission)) {
      errors.push(`Step ${step.id} requires undeclared permission ${permission}.`);
    }
  }

  if (step.llmProfileRef && !allowedLlmProfiles.has(step.llmProfileRef)) {
    errors.push(`Step ${step.id} references missing LLM profile ${step.llmProfileRef}.`);
  }

  if (step.destinationRef && !allowedDestinations.has(step.destinationRef)) {
    errors.push(`Step ${step.id} references unavailable destination ${step.destinationRef}.`);
  }

  if (step.inlineCode) {
    errors.push(`Step ${step.id} contains inline arbitrary code.`);
  }

  if (containsInvalidExpression(step.inputs)) {
    errors.push(`Step ${step.id} contains an expression outside the whitelist.`);
  }
}

function validateRegistryProviderAction(
  workflow: RavenWorkflow,
  step: WorkflowStepDefinition,
  capability: CapabilityDescriptor,
  errors: string[],
) {
  if (!isValidRegistryProviderAction(step, capability)) {
    errors.push(`Step ${step.id} references unsupported action ${step.provider}.${step.action}.`);
    return;
  }

  for (const permission of capability.permissions) {
    if (!step.permissions.includes(permission)) {
      errors.push(
        `Step ${step.id} must declare capability permission ${permission} required by ${step.provider}.${step.action}.`,
      );
    }
    if (!workflow.permissions.includes(permission)) {
      errors.push(
        `Workflow must declare capability permission ${permission} required by step ${step.id}.`,
      );
    }
  }

  if (step.provider === "http_probe" && step.action === "check_urls") {
    validateHttpProbeInputs(step, errors);
  }
  validateDeterministicProviderInputs(step, errors);
}

function isValidRegistryProviderAction(
  step: WorkflowStepDefinition,
  capability: CapabilityDescriptor,
): boolean {
  return (
    capability.status === "available" &&
    capability.provider === step.provider &&
    capability.action === step.action &&
    capability.provider !== "agent" &&
    capability.provider !== "agent_tool"
  );
}

function hasValidRegistryProviderAction(
  step: WorkflowStepDefinition,
  registry: Map<string, CapabilityDescriptor>,
): boolean {
  const capability = registry.get(providerCapabilityId(step));
  return capability ? isValidRegistryProviderAction(step, capability) : false;
}

function validateFirstPartyProviderAction(
  workflow: RavenWorkflow,
  step: WorkflowStepDefinition,
  errors: string[],
) {
  const capabilityId = providerCapabilityId(step);
  for (const permission of providerCapabilityPermissions[capabilityId] ?? []) {
    if (!step.permissions.includes(permission)) {
      errors.push(
        `Step ${step.id} must declare capability permission ${permission} required by ${step.provider}.${step.action}.`,
      );
    }
    if (!workflow.permissions.includes(permission)) {
      errors.push(
        `Workflow must declare capability permission ${permission} required by step ${step.id}.`,
      );
    }
  }

  if (step.provider === "http_probe" && step.action === "check_urls") {
    validateHttpProbeInputs(step, errors);
  }
  validateDeterministicProviderInputs(step, errors);
}

function validateDeterministicProviderInputs(
  step: WorkflowStepDefinition,
  errors: string[],
) {
  const inputs = isJsonObject(step.inputs) ? step.inputs : {};
  const capability = providerCapabilityId(step);
  switch (capability) {
    case "web.fetch_page":
      requireNonEmptyString(step, inputs, "url", errors);
      break;
    case "web.extract_article":
    case "web.extract_metadata":
      if (
        !hasNonEmptyString(inputs, "body_text") &&
        !hasNonEmptyString(inputs, "html") &&
        !hasNonEmptyString(inputs, "url")
      ) {
        errors.push(
          `Step ${step.id} ${step.provider}.${step.action} inputs must include body_text, html, or url.`,
        );
      }
      break;
    case "seo.fetch_robots_txt":
      if (
        !hasNonEmptyString(inputs, "site_url") &&
        !hasNonEmptyString(inputs, "base_url") &&
        !hasNonEmptyString(inputs, "url")
      ) {
        errors.push(
          `Step ${step.id} seo.fetch_robots_txt inputs must include site_url, base_url, or url.`,
        );
      }
      break;
    case "seo.parse_robots_txt":
    case "seo.parse_sitemap":
      requireString(step, inputs, "body_text", errors);
      break;
    case "seo.fetch_sitemap":
      if (
        !hasNonEmptyString(inputs, "sitemap_url") &&
        !hasNonEmptyString(inputs, "site_url") &&
        !hasNonEmptyString(inputs, "url")
      ) {
        errors.push(
          `Step ${step.id} seo.fetch_sitemap inputs must include sitemap_url, site_url, or url.`,
        );
      }
      break;
    case "seo.audit_indexability":
      if (
        !hasNonEmptyString(inputs, "url") &&
        !hasNonEmptyString(inputs, "html") &&
        !hasNonEmptyString(inputs, "body_text")
      ) {
        errors.push(
          `Step ${step.id} seo.audit_indexability inputs must include url, html, or body_text.`,
        );
      }
      break;
    case "seo.audit_metadata":
    case "seo.extract_structured_data":
    case "seo.audit_links":
    case "seo.audit_canonical_hreflang":
      if (
        !hasNonEmptyString(inputs, "body_text") &&
        !hasNonEmptyString(inputs, "html") &&
        !hasNonEmptyString(inputs, "url")
      ) {
        errors.push(
          `Step ${step.id} ${step.provider}.${step.action} inputs must include body_text, html, or url.`,
        );
      }
      break;
    case "seo.validate_json_ld":
      if (!("json_ld" in inputs) && !("structured_data" in inputs)) {
        errors.push(`Step ${step.id} seo.validate_json_ld inputs must include json_ld or structured_data.`);
      }
      break;
    case "content.map_search_intent":
    case "content.generate_brief":
      requireNonEmptyString(step, inputs, "topic", errors);
      break;
    case "content.score_quality":
      requireString(step, inputs, "content", errors);
      break;
    case "rss.fetch_feed":
      if (!hasNonEmptyString(inputs, "url") && !hasNonEmptyString(inputs, "body_text")) {
        errors.push(`Step ${step.id} rss.fetch_feed inputs must include url or body_text.`);
      }
      break;
    case "news.search":
      requireNonEmptyString(step, inputs, "query", errors);
      break;
    case "data.parse_csv":
      requireString(step, inputs, "content", errors);
      break;
    case "data.transform_json":
      if (!("data" in inputs)) {
        errors.push(`Step ${step.id} data.transform_json inputs must include data.`);
      }
      break;
    case "scheduler.preview_next_runs":
      requireNonEmptyString(step, inputs, "cadence", errors);
      if (inputs.cadence !== "manual") {
        requireNonEmptyString(step, inputs, "local_time", errors);
      }
      break;
    case "notification.local":
      requireString(step, inputs, "title", errors);
      requireString(step, inputs, "body", errors);
      break;
    case "open_meteo.current_weather":
    case "weather.forecast_24h":
    case "weather.hourly_forecast":
    case "weather.alerts": {
      const hasLatitude = "latitude" in inputs;
      const hasLongitude = "longitude" in inputs;
      if (hasLatitude !== hasLongitude) {
        errors.push(
          `Step ${step.id} ${step.provider}.${step.action} inputs.latitude and inputs.longitude must be provided together.`,
        );
      }
      break;
    }
  }
}

function requireString(
  step: WorkflowStepDefinition,
  inputs: Record<string, unknown>,
  key: string,
  errors: string[],
) {
  if (typeof inputs[key] !== "string") {
    errors.push(
      `Step ${step.id} ${step.provider}.${step.action} inputs.${key} must be a string.`,
    );
  }
}

function requireNonEmptyString(
  step: WorkflowStepDefinition,
  inputs: Record<string, unknown>,
  key: string,
  errors: string[],
) {
  if (!hasNonEmptyString(inputs, key)) {
    errors.push(
      `Step ${step.id} ${step.provider}.${step.action} inputs.${key} must be a non-empty string.`,
    );
  }
}

function hasNonEmptyString(inputs: Record<string, unknown>, key: string): boolean {
  return typeof inputs[key] === "string" && inputs[key].trim() !== "";
}

function validateHttpProbeInputs(step: WorkflowStepDefinition, errors: string[]) {
  if (!isJsonObject(step.inputs)) {
    errors.push(
      `Step ${step.id} http_probe.check_urls inputs.urls must be a non-empty array of strings.`,
    );
    return;
  }

  const urls = step.inputs.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    errors.push(
      `Step ${step.id} http_probe.check_urls inputs.urls must be a non-empty array of strings.`,
    );
    return;
  }

  urls.forEach((url, index) => {
    if (typeof url !== "string" || url.trim() === "") {
      errors.push(
        `Step ${step.id} http_probe.check_urls inputs.urls[${index}] must be a non-empty string.`,
      );
    }
  });

  const acceptedStatusCodes = step.inputs.accepted_status_codes;
  if (acceptedStatusCodes === undefined) return;
  if (!Array.isArray(acceptedStatusCodes)) {
    errors.push(
      `Step ${step.id} http_probe.check_urls inputs.accepted_status_codes must be an array of HTTP status codes.`,
    );
    return;
  }

  acceptedStatusCodes.forEach((statusCode, index) => {
    if (typeof statusCode !== "number" || !Number.isInteger(statusCode)) {
      errors.push(
        `Step ${step.id} http_probe.check_urls inputs.accepted_status_codes[${index}] must be an integer HTTP status code.`,
      );
      return;
    }
    if (statusCode < 100 || statusCode > 599) {
      errors.push(
        `Step ${step.id} http_probe.check_urls inputs.accepted_status_codes[${index}] must be an HTTP status code from 100 through 599.`,
      );
    }
  });
}

function validatePluginProviderAction(
  step: WorkflowStepDefinition,
  plugins: PluginManifest[],
  registry: Map<string, CapabilityDescriptor>,
  errors: string[],
) {
  const providerExists = plugins.some((plugin) =>
    plugin.steps.some((candidate) => candidate.provider === step.provider),
  ) || [...registry.values()].some((capability) => capability.provider === step.provider);
  const capability = plugins
    .flatMap((plugin) => plugin.steps)
    .find((candidate) => candidate.provider === step.provider && candidate.action === step.action);

  if (!capability) {
    if (providerExists) {
      const unavailableProvider = `Step ${step.id} references unavailable provider ${step.provider}.`;
      const index = errors.indexOf(unavailableProvider);
      if (index >= 0) errors.splice(index, 1);
      errors.push(`Step ${step.id} references unsupported action ${step.provider}.${step.action}.`);
    } else {
      errors.push(`Step ${step.id} references unavailable provider ${step.provider}.`);
    }
    return;
  }

  const unavailableProvider = `Step ${step.id} references unavailable provider ${step.provider}.`;
  const index = errors.indexOf(unavailableProvider);
  if (index >= 0) errors.splice(index, 1);

  for (const permission of capability.permissions) {
    if (!step.permissions.includes(permission)) {
      errors.push(
        `Step ${step.id} must declare plugin permission ${permission} required by ${step.provider}.${step.action}.`,
      );
    }
  }
  for (const permission of step.permissions) {
    if (!capability.permissions.includes(permission)) {
      errors.push(
        `Step ${step.id} declares permission ${permission} not allowed by plugin capability ${step.provider}.${step.action}.`,
      );
    }
  }

  const schema = capability.inputSchema;
  const inputsAreObject = isJsonObject(step.inputs);
  if (schema?.type === "object" && !inputsAreObject) {
    errors.push(`Step ${step.id} plugin inputs must be a JSON object.`);
  }
  const required = Array.isArray(schema?.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && (!inputsAreObject || !(key in step.inputs))) {
      errors.push(`Step ${step.id} plugin inputs must include required field ${key}.`);
    }
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateAgentTaskStep(
  workflow: RavenWorkflow,
  step: WorkflowStepDefinition,
  errors: string[],
) {
  if (step.provider !== "agent" || step.action !== "run_task") {
    errors.push(`Step ${step.id} agent_task must use provider agent and action run_task.`);
  }

  if (!step.permissions.includes("llm:generate")) {
    errors.push(`Step ${step.id} agent_task must include llm:generate in step permissions.`);
  }

  const profile = step.llmProfileRef ?? workflow.defaults.llmProfileRef;
  if (!allowedAgentTaskLlmProfiles.has(profile)) {
    errors.push(`Step ${step.id} agent_task references unsupported LLM profile ${profile}.`);
  }

  const inputs = isJsonObject(step.inputs) ? step.inputs : {};
  const objective = inputs.objective;
  if (typeof objective !== "string" || objective.trim() === "") {
    errors.push(`Step ${step.id} agent_task must include non-empty inputs.objective.`);
  }

  const allowedAgentPermissions = new Set(["llm:generate"]);
  const tools = inputs.allowed_tools;
  if (tools === undefined) {
    validateAgentTaskPermissionBoundary(step, allowedAgentPermissions, errors);
    return;
  }
  if (!Array.isArray(tools)) {
    errors.push(`Step ${step.id} inputs.allowed_tools must be an array when present.`);
    validateAgentTaskPermissionBoundary(step, allowedAgentPermissions, errors);
    return;
  }

  tools.forEach((tool, index) => {
    if (typeof tool !== "string") {
      errors.push(`Step ${step.id} allowed_tools[${index}] must be a string.`);
      return;
    }
    const requiredPermission = permissionForAgentTool(tool);
    if (!requiredPermission) {
      errors.push(`Step ${step.id} allows unknown tool ${tool}.`);
      return;
    }
    allowedAgentPermissions.add(requiredPermission);
    if (!workflow.permissions.includes(requiredPermission)) {
      errors.push(
        `Step ${step.id} allows tool ${tool} but workflow does not declare ${requiredPermission}.`,
      );
    }
    if (!step.permissions.includes(requiredPermission)) {
      errors.push(
        `Step ${step.id} allows tool ${tool} but step does not declare ${requiredPermission}.`,
      );
    }
  });
  if (
    typeof objective === "string" &&
    objectiveLooksLikeUrlCheck(objective) &&
    toolsIncludeWebOrHttp(tools)
  ) {
    errors.push(
      `Step ${step.id} objective is a URL or website reachability check. Use deterministic provider http_probe.check_urls.`,
    );
  }
  validateAgentTaskPermissionBoundary(step, allowedAgentPermissions, errors);
}

function objectiveLooksLikeUrlCheck(objective: string): boolean {
  const normalized = objective.toLowerCase();
  const words = new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean));
  const mentionsUrlTarget =
    normalized.includes("http://") ||
    normalized.includes("https://") ||
    normalized.includes("www.") ||
    words.has("url") ||
    words.has("urls") ||
    words.has("website") ||
    words.has("websites") ||
    words.has("site") ||
    words.has("sites") ||
    containsDomainLikeToken(normalized);
  const mentionsReachability =
    words.has("uptime") ||
    words.has("reachable") ||
    words.has("reachability") ||
    words.has("available") ||
    words.has("availability") ||
    words.has("unavailable") ||
    words.has("down") ||
    looksLikeUpStatusQuestion(normalized, words) ||
    words.has("responding") ||
    words.has("response") ||
    words.has("status") ||
    words.has("health") ||
    words.has("healthy") ||
    words.has("alive") ||
    words.has("online") ||
    words.has("offline") ||
    words.has("probe") ||
    words.has("monitor");

  return mentionsUrlTarget && mentionsReachability;
}

function looksLikeUpStatusQuestion(normalized: string, words: Set<string>): boolean {
  return (
    words.has("up") &&
    (words.has("is") ||
      words.has("are") ||
      normalized.includes("site up") ||
      normalized.includes("sites up") ||
      normalized.includes("website up") ||
      normalized.includes("websites up"))
  );
}

function containsDomainLikeToken(text: string): boolean {
  return text.split(/\s+/).some((rawToken) => {
    const token = rawToken.replace(/^[,;:!?()[\]{}"']+|[,;:!?()[\]{}"']+$/g, "");
    if (token.startsWith("$steps.") || token.startsWith(".") || token.endsWith(".")) {
      return false;
    }

    const labels = token.split(".");
    if (labels.length < 2 || labels.some((label) => label.length === 0)) {
      return false;
    }

    const topLevelDomain = labels[labels.length - 1];
    return (
      typeof topLevelDomain === "string" &&
      topLevelDomain.length >= 2 &&
      /^[a-z]{2,}$/.test(topLevelDomain) &&
      labels
        .slice(0, -1)
        .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    );
  });
}

function toolsIncludeWebOrHttp(tools: unknown[]): boolean {
  return tools.some((tool) => tool === "web" || tool === "http");
}

function validateAgentTaskPermissionBoundary(
  step: WorkflowStepDefinition,
  allowedAgentPermissions: Set<string>,
  errors: string[],
) {
  for (const permission of step.permissions) {
    if (!allowedAgentPermissions.has(permission)) {
      errors.push(
        `Step ${step.id} declares permission ${permission} not granted by agent allowed_tools.`,
      );
    }
  }
}

function validateAgentRuntimeShape(
  workflow: RavenWorkflow,
  registry: Map<string, CapabilityDescriptor>,
  errors: string[],
) {
  const agentSteps = workflow.steps.filter(
    (step) => (step.kind ?? "provider_action") === "agent_task",
  );
  if (agentSteps.length === 0) return;
  const agentStep = agentSteps[0];
  const agentIndex = workflow.steps.findIndex((step) => step.id === agentStep.id);
  const sinks = workflow.steps.filter(
    (step) =>
      (step.kind ?? "provider_action") === "provider_action" &&
      step.provider === "local_app" &&
      step.action === "write_artifact",
  );
  const deterministicProviderSteps = workflow.steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        (step.kind ?? "provider_action") === "provider_action" &&
        isDeterministicProviderCapability(step, registry) &&
        !(step.provider === "local_app" && step.action === "write_artifact"),
    );
  const deterministicProviderCount = deterministicProviderSteps.length;
  const hasMixedDeterministicShape =
    deterministicProviderCount > 0 &&
    agentSteps.length === 1 &&
    sinks.length <= 1 &&
    workflow.steps.length === deterministicProviderCount + 1 + sinks.length &&
    deterministicProviderSteps.every(({ index }) => index < agentIndex) &&
    sinks.every((sink) => {
      const sinkIndex = workflow.steps.findIndex((step) => step.id === sink.id);
      return sinkIndex > agentIndex;
    });

  if (
    !hasMixedDeterministicShape &&
    (agentSteps.length !== 1 || workflow.steps.length !== 1 + sinks.length || sinks.length > 1)
  ) {
    errors.push(
      "Agent runtime supports exactly one agent_task step plus optional local_app.write_artifact sink.",
    );
  }

  if (hasMixedDeterministicShape) {
    validateMixedDeterministicAgentWiring(
      workflow,
      agentStep,
      deterministicProviderSteps,
      errors,
    );
  }

  const sink = sinks[0];
  if (!sink) return;
  if (sink.dependsOn.length !== 1 || sink.dependsOn[0] !== agentStep.id) {
    errors.push(`Agent runtime sink ${sink.id} must depend only on ${agentStep.id}.`);
  }
  const expectedArtifact = `$steps.${agentStep.id}.artifact`;
  const sinkInputs = isJsonObject(sink.inputs) ? sink.inputs : {};
  if (sinkInputs.artifact !== expectedArtifact) {
    errors.push(
      `Agent runtime sink ${sink.id} inputs.artifact must reference ${expectedArtifact}.`,
    );
  }
}

function validateMixedDeterministicAgentWiring(
  workflow: RavenWorkflow,
  agentStep: WorkflowStepDefinition,
  deterministicProviderSteps: Array<{ step: WorkflowStepDefinition; index: number }>,
  errors: string[],
) {
  const stepIndices = new Map(workflow.steps.map((step, index) => [step.id, index]));
  const deterministicStepIds = new Set(deterministicProviderSteps.map(({ step }) => step.id));

  for (const { step, index } of deterministicProviderSteps) {
    if (
      step.dependsOn.some((dependency) => {
        const dependencyIndex = stepIndices.get(dependency);
        return (
          dependencyIndex !== undefined &&
          (dependencyIndex >= index || !deterministicStepIds.has(dependency))
        );
      })
    ) {
      errors.push(
        `Agent runtime deterministic step ${step.id} may depend only on earlier deterministic steps.`,
      );
    }
  }

  for (const { step } of deterministicProviderSteps) {
    if (!agentStep.dependsOn.includes(step.id)) {
      errors.push(`Agent runtime step ${agentStep.id} must depend on ${step.id}.`);
    }
  }

  if (agentStep.dependsOn.some((dependency) => !deterministicStepIds.has(dependency))) {
    errors.push(
      `Agent runtime step ${agentStep.id} may depend only on deterministic provider pre-steps.`,
    );
  }
}

function validateDeterministicProviderRuntimeShape(
  workflow: RavenWorkflow,
  registry: Map<string, CapabilityDescriptor>,
  errors: string[],
) {
  const agentSteps = workflow.steps.filter(
    (step) => (step.kind ?? "provider_action") === "agent_task",
  );
  if (agentSteps.length > 0) return;
  if (workflow.steps.some(isLegacyProviderAction)) return;

  const deterministicProviderSteps = workflow.steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        (step.kind ?? "provider_action") === "provider_action" &&
        !(step.provider === "local_app" && step.action === "write_artifact") &&
        isDeterministicProviderCapability(step, registry),
    );
  if (deterministicProviderSteps.length === 0) return;

  const sinks = workflow.steps.filter(
    (step) =>
      (step.kind ?? "provider_action") === "provider_action" &&
      step.provider === "local_app" &&
      step.action === "write_artifact",
  );
  if (
    workflow.steps.length !== deterministicProviderSteps.length + sinks.length ||
    sinks.length > 1
  ) {
    errors.push(
      "Deterministic provider runtime supports deterministic provider steps plus optional local_app.write_artifact sink.",
    );
    return;
  }

  const stepIndices = new Map(workflow.steps.map((step, index) => [step.id, index]));
  const deterministicStepIds = new Set(deterministicProviderSteps.map(({ step }) => step.id));
  for (const { step, index } of deterministicProviderSteps) {
    if (
      step.dependsOn.some((dependency) => {
        const dependencyIndex = stepIndices.get(dependency);
        return (
          dependencyIndex !== undefined &&
          (dependencyIndex >= index || !deterministicStepIds.has(dependency))
        );
      })
    ) {
      errors.push(
        `Deterministic provider step ${step.id} may depend only on earlier deterministic provider steps.`,
      );
    }
  }

  const sink = sinks[0];
  if (!sink) return;
  const sinkIndex = stepIndices.get(sink.id) ?? Number.MAX_SAFE_INTEGER;
  if (
    sink.dependsOn.some((dependency) => {
      const dependencyIndex = stepIndices.get(dependency);
      return (
        dependencyIndex !== undefined &&
        (dependencyIndex >= sinkIndex || !deterministicStepIds.has(dependency))
      );
    })
  ) {
    errors.push(
      `Deterministic provider sink ${sink.id} may depend only on earlier deterministic provider steps.`,
    );
  }

  const sinkInputs = isJsonObject(sink.inputs) ? sink.inputs : {};
  const artifactStepId =
    typeof sinkInputs.artifact === "string" ? stepIdFromStepExpression(sinkInputs.artifact) : undefined;
  if (!artifactStepId) {
    errors.push(
      `Deterministic provider sink ${sink.id} inputs.artifact must reference a deterministic provider step output.`,
    );
  } else if (!sink.dependsOn.includes(artifactStepId)) {
    errors.push(
      `Deterministic provider sink ${sink.id} inputs.artifact must reference one of its dependencies.`,
    );
  }
}

function isLegacyProviderAction(step: WorkflowStepDefinition): boolean {
  return (
    step.provider === "openai" &&
    ["chat_stream", "generate_artifact", "structured_output"].includes(step.action)
  );
}

function stepIdFromStepExpression(expression: string): string | undefined {
  if (!expression.startsWith("$steps.")) return undefined;
  return expression.slice("$steps.".length).split(".")[0];
}

function providerCapabilityId(step: WorkflowStepDefinition): string {
  return capabilityId(step.provider, step.action);
}

function isDeterministicProviderCapability(
  step: WorkflowStepDefinition,
  registry: Map<string, CapabilityDescriptor>,
): boolean {
  const registryCapability = registry.get(providerCapabilityId(step));
  if (registryCapability) {
    return registryCapability.deterministic;
  }
  return deterministicProviderCapabilities.has(providerCapabilityId(step));
}

function validatePluginRuntimeShape(
  workflow: RavenWorkflow,
  plugins: PluginManifest[],
  registry: Map<string, CapabilityDescriptor>,
  errors: string[],
) {
  const pluginSteps = workflow.steps.filter((step) =>
    plugins.some((plugin) =>
      plugin.steps.some(
        (candidate) => candidate.provider === step.provider && candidate.action === step.action,
      ),
    ) &&
    !hasValidRegistryProviderAction(step, registry),
  );
  if (pluginSteps.length === 0) return;
  if (pluginSteps.length !== 1) {
    errors.push("Plugin runtime supports exactly one plugin-backed provider action step.");
    return;
  }
  const pluginStep = pluginSteps[0];
  const sinks = workflow.steps.filter(
    (step) =>
      (step.kind ?? "provider_action") === "provider_action" &&
      step.provider === "local_app" &&
      step.action === "write_artifact",
  );

  if (workflow.steps.length !== 1 + sinks.length || sinks.length > 1) {
    errors.push(
      "Plugin runtime supports one plugin step plus optional local_app.write_artifact sink.",
    );
  }

  const sink = sinks[0];
  if (!sink) return;
  const expectedArtifact = `$steps.${pluginStep.id}.artifact`;
  if (
    sink.dependsOn.length !== 1 ||
    sink.dependsOn[0] !== pluginStep.id ||
    !isJsonObject(sink.inputs) ||
    sink.inputs.artifact !== expectedArtifact
  ) {
    errors.push(
      `Plugin runtime sink ${sink.id} must depend on ${pluginStep.id} and reference ${expectedArtifact}.`,
    );
  }
}

function permissionForAgentTool(tool: string): string | undefined {
  switch (tool) {
    case "web":
    case "http":
      return "network:read";
    case "local_git":
      return "git:read";
    case "github":
      return "github:read";
    case "nestweaver":
      return "nestweaver:read";
    case "document_import":
      return "document:read";
    case "ai_chat_import":
      return "chat:read";
    default:
      return undefined;
  }
}

function containsInvalidExpression(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("{{") || (value.startsWith("$") && !whitelistedExpression.test(value));
  }

  if (Array.isArray(value)) {
    return value.some(containsInvalidExpression);
  }

  if (value && typeof value === "object") {
    return Object.values(value).some(containsInvalidExpression);
  }

  return false;
}

function hasCycle(steps: WorkflowStepDefinition[]): boolean {
  const graph = new Map(steps.map((step) => [step.id, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;

    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency) && visit(dependency)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return steps.some((step) => visit(step.id));
}
