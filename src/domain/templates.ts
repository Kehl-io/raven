import type { RavenWorkflow } from "./types";
import {
  dailyWorkJournalWorkflow,
  morningBriefWorkflow,
  currentWeatherWorkflow,
} from "./workflow";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: "productivity" | "research" | "monitoring" | "content" | "devops";
  tags: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  requirements: string[];
  workflow: RavenWorkflow;
  versions?: WorkflowTemplateVersion[];
  source?: WorkflowTemplateSource;
  lifecycle?: WorkflowTemplateLifecycle;
}

export interface WorkflowTemplateVersion {
  version: string;
  releasedAt: string;
  changelog: string[];
  workflow: RavenWorkflow;
  deprecated?: boolean;
  deprecationReason?: string;
}

export interface WorkflowTemplateSource {
  kind: "first-party" | "community";
  maintainer: string;
  repository: string;
  trust: "verified" | "review-required" | "deprecated";
  reviewedAt?: string;
}

export interface WorkflowTemplateLifecycle {
  review: "verified" | "required";
  import: "draft-review" | "direct";
  install: "new-workflow" | "update-existing";
  update: "manual-review";
  deprecate?: string;
}

function cloneWorkflow(definition: RavenWorkflow): RavenWorkflow {
  return JSON.parse(JSON.stringify(definition)) as RavenWorkflow;
}

const dailyWorkJournalWorkflowV12: RavenWorkflow = {
  ...cloneWorkflow(dailyWorkJournalWorkflow),
  description: "Summarizes local project activity with context carry-forward into a daily work journal artifact.",
  permissions: ["git:read", "artifact:read", "artifact:write", "llm:generate"],
  schedule: {
    cadence: "daily",
    localTime: "18:00",
  },
};

const firstPartySource: WorkflowTemplateSource = {
  kind: "first-party",
  maintainer: "Raven templates",
  repository: "raven://templates/core",
  trust: "verified",
  reviewedAt: "2026-06-15",
};

const communityAgentSource: WorkflowTemplateSource = {
  kind: "community",
  maintainer: "Raven community",
  repository: "raven://community/agent-workflows",
  trust: "review-required",
};

const firstPartyLifecycle: WorkflowTemplateLifecycle = {
  review: "verified",
  import: "draft-review",
  install: "new-workflow",
  update: "manual-review",
};

const communityAgentLifecycle: WorkflowTemplateLifecycle = {
  review: "required",
  import: "draft-review",
  install: "new-workflow",
  update: "manual-review",
};

const weeklySummaryWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "weekly-summary",
  name: "Weekly Summary",
  description: "Compiles weekly project highlights from git activity into a concise summary artifact.",
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
      id: "collect-git-logs",
      name: "Collect git logs",
      provider: "local_git",
      action: "recent_activity",
      dependsOn: [],
      permissions: ["git:read"],
      inputs: { window: "week" },
    },
    {
      kind: "provider_action",
      id: "compose-summary",
      name: "Compose weekly summary",
      provider: "openai",
      action: "generate_artifact",
      dependsOn: ["collect-git-logs"],
      permissions: ["llm:generate"],
      llmProfileRef: "default-openai",
      inputs: {
        template: "weekly_summary",
        prompt: "$steps.collect-git-logs.summary",
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save artifact locally",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["compose-summary"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.compose-summary.artifact",
      },
    },
  ],
};

const meetingNotesDigestWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "meeting-notes-digest",
  name: "Meeting Notes Digest",
  description: "Summarizes imported meeting notes into a concise list of action items.",
  permissions: ["document:read", "artifact:write", "llm:generate"],
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
      id: "extract-actions",
      name: "Extract action items from meeting notes",
      provider: "agent",
      action: "run_task",
      dependsOn: [],
      permissions: ["llm:generate", "document:read"],
      llmProfileRef: "codex-oauth-local",
      inputs: {
        objective: "Read the imported meeting notes documents and extract a prioritized list of action items with owners and due dates where available.",
        output_schema: "artifact_envelope",
        allowed_tools: ["document_import"],
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save action items artifact",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["extract-actions"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.extract-actions.artifact",
      },
    },
  ],
};

const topicResearchReportWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "topic-research-report",
  name: "Topic Research Report",
  description: "Researches a topic using web search and produces a structured markdown report.",
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
      id: "research-topic",
      name: "Research topic via web search",
      provider: "agent",
      action: "run_task",
      dependsOn: [],
      permissions: ["llm:generate", "network:read"],
      llmProfileRef: "codex-oauth-local",
      inputs: {
        objective: "Research the given topic thoroughly using web search. Compile findings into a well-structured markdown report with key takeaways, sources, and a summary.",
        output_schema: "artifact_envelope",
        allowed_tools: ["web"],
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save research report",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["research-topic"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.research-topic.artifact",
      },
    },
  ],
};

const competitorAnalysisWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "competitor-analysis",
  name: "Competitor Analysis",
  description: "Analyzes competitor products from web sources and summarizes findings.",
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
      id: "analyze-competitors",
      name: "Analyze competitors via web",
      provider: "agent",
      action: "run_task",
      dependsOn: [],
      permissions: ["llm:generate", "network:read"],
      llmProfileRef: "codex-oauth-local",
      inputs: {
        objective: "Search the web for information about the specified competitors. Analyze their products, pricing, strengths, and weaknesses. Produce a structured comparison report.",
        output_schema: "artifact_envelope",
        allowed_tools: ["web"],
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save analysis artifact",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["analyze-competitors"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.analyze-competitors.artifact",
      },
    },
  ],
};

const siteHealthCheckWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "site-health-check",
  name: "Site Health Check",
  description: "Checks if specified URLs are responding and reports their status.",
  permissions: ["llm:generate", "network:read", "artifact:write"],
  defaults: {
    llmProfileRef: "codex-oauth-local",
    destinationRef: "local-app",
  },
  schedule: {
    cadence: "daily",
    localTime: "09:00",
  },
  steps: [
    {
      kind: "provider_action",
      id: "check-sites",
      name: "Check site availability",
      provider: "http_probe",
      action: "check_urls",
      dependsOn: [],
      permissions: ["network:read"],
      inputs: {
        urls: ["https://example.com"],
        timeout_ms: 5000,
        accepted_status_codes: [200, 204],
      },
    },
    {
      kind: "agent_task",
      id: "compile-report",
      name: "Compile status report",
      provider: "agent",
      action: "run_task",
      dependsOn: ["check-sites"],
      permissions: ["llm:generate"],
      llmProfileRef: "codex-oauth-local",
      inputs: {
        objective: "Summarize the deterministic HTTP probe results from $steps.check-sites.results into a concise status report with URL, status code, latency, and error details.",
        output_schema: "artifact_envelope",
        allowed_tools: [],
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save status report",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["compile-report"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.compile-report.artifact",
      },
    },
  ],
};

const rssFeedDigestWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "rss-feed-digest",
  name: "RSS Feed Digest",
  description: "Fetches and summarizes RSS feeds into a daily digest artifact.",
  permissions: ["llm:generate", "network:read", "artifact:write"],
  defaults: {
    llmProfileRef: "codex-oauth-local",
    destinationRef: "local-app",
  },
  schedule: {
    cadence: "daily",
    localTime: "08:30",
  },
  steps: [
    {
      kind: "agent_task",
      id: "fetch-and-summarize",
      name: "Fetch and summarize RSS feeds",
      provider: "agent",
      action: "run_task",
      dependsOn: [],
      permissions: ["llm:generate", "network:read"],
      llmProfileRef: "codex-oauth-local",
      inputs: {
        objective: "Fetch the configured RSS feeds and summarize the top stories from each. Group by feed source and highlight the most important items. Produce a readable digest.",
        output_schema: "artifact_envelope",
        allowed_tools: ["web"],
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save digest artifact",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["fetch-and-summarize"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.fetch-and-summarize.artifact",
      },
    },
  ],
};

const blogPostDraftWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "blog-post-draft",
  name: "Blog Post Draft",
  description: "Generates a blog post draft from a topic prompt using web research.",
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
      id: "draft-post",
      name: "Draft blog post",
      provider: "agent",
      action: "run_task",
      dependsOn: [],
      permissions: ["llm:generate", "network:read"],
      llmProfileRef: "codex-oauth-local",
      inputs: {
        objective: "Research the given topic using web search, then write a complete blog post draft with a compelling title, introduction, sections with headers, and a conclusion. Use a clear and engaging tone.",
        output_schema: "artifact_envelope",
        allowed_tools: ["web"],
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save blog post draft",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["draft-post"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.draft-post.artifact",
      },
    },
  ],
};

const socialMediaRecapWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "social-media-recap",
  name: "Social Media Recap",
  description: "Summarizes recent social media mentions and trends into a recap artifact.",
  permissions: ["llm:generate", "network:read", "artifact:write"],
  defaults: {
    llmProfileRef: "codex-oauth-local",
    destinationRef: "local-app",
  },
  schedule: {
    cadence: "daily",
    localTime: "09:00",
  },
  steps: [
    {
      kind: "agent_task",
      id: "gather-mentions",
      name: "Search and summarize social mentions",
      provider: "agent",
      action: "run_task",
      dependsOn: [],
      permissions: ["llm:generate", "network:read"],
      llmProfileRef: "codex-oauth-local",
      inputs: {
        objective: "Search the web for recent social media mentions and discussions related to the specified topic or brand. Summarize sentiment, key themes, and notable posts into a concise recap.",
        output_schema: "artifact_envelope",
        allowed_tools: ["web"],
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save recap artifact",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["gather-mentions"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.gather-mentions.artifact",
      },
    },
  ],
};

const prReviewSummaryWorkflow: RavenWorkflow = {
  schemaVersion: "0.1.0",
  id: "pr-review-summary",
  name: "PR Review Summary",
  description: "Summarizes open pull requests from a GitHub repo into a daily digest.",
  permissions: ["llm:generate", "github:read", "artifact:write"],
  defaults: {
    llmProfileRef: "codex-oauth-local",
    destinationRef: "local-app",
  },
  schedule: {
    cadence: "weekdays",
    localTime: "09:00",
  },
  steps: [
    {
      kind: "agent_task",
      id: "summarize-prs",
      name: "Summarize open pull requests",
      provider: "agent",
      action: "run_task",
      dependsOn: [],
      permissions: ["llm:generate", "github:read"],
      llmProfileRef: "codex-oauth-local",
      inputs: {
        objective: "Fetch the open pull requests from the configured GitHub repository. For each PR summarize the title, author, size, and any review status. Group by ready-to-merge, needs-review, and draft.",
        output_schema: "artifact_envelope",
        allowed_tools: ["github"],
      },
    },
    {
      kind: "provider_action",
      id: "write-artifact",
      name: "Save PR summary artifact",
      provider: "local_app",
      action: "write_artifact",
      dependsOn: ["summarize-prs"],
      permissions: ["artifact:write"],
      destinationRef: "local-app",
      inputs: {
        artifact: "$steps.summarize-prs.artifact",
      },
    },
  ],
};

export const TEMPLATE_CATALOG: WorkflowTemplate[] = [
  {
    id: "tpl-daily-work-journal",
    name: "Daily Work Journal",
    description: "Summarizes local project activity into a concise daily work journal artifact.",
    category: "productivity",
    tags: ["git", "daily", "journal"],
    difficulty: "beginner",
    requirements: ["Local Git"],
    workflow: dailyWorkJournalWorkflow,
    versions: [
      {
        version: "1.2.0",
        releasedAt: "2026-06-15",
        changelog: [
          "Adds prior artifact context before composing the journal.",
          "Moves the default schedule to an end-of-day daily run.",
        ],
        workflow: dailyWorkJournalWorkflowV12,
      },
      {
        version: "1.0.0",
        releasedAt: "2026-05-20",
        changelog: ["Initial daily git activity journal release."],
        workflow: dailyWorkJournalWorkflow,
      },
    ],
    source: firstPartySource,
    lifecycle: firstPartyLifecycle,
  },
  {
    id: "tpl-morning-brief",
    name: "Morning Brief",
    description: "Builds a morning planning brief from local project context and recent artifacts.",
    category: "productivity",
    tags: ["git", "planning", "morning"],
    difficulty: "beginner",
    requirements: ["Local Git"],
    workflow: morningBriefWorkflow,
    source: firstPartySource,
    lifecycle: firstPartyLifecycle,
  },
  {
    id: "tpl-weekly-summary",
    name: "Weekly Summary",
    description: "Compiles weekly project highlights from git activity into a concise summary.",
    category: "productivity",
    tags: ["git", "weekly", "summary"],
    difficulty: "beginner",
    requirements: ["Local Git"],
    workflow: weeklySummaryWorkflow,
    versions: [
      {
        version: "1.1.0",
        releasedAt: "2026-06-10",
        changelog: ["Clarifies summary grouping and artifact handoff metadata."],
        workflow: weeklySummaryWorkflow,
      },
      {
        version: "1.0.0",
        releasedAt: "2026-05-22",
        changelog: ["Initial weekly git digest release."],
        workflow: weeklySummaryWorkflow,
      },
    ],
    source: firstPartySource,
    lifecycle: firstPartyLifecycle,
  },
  {
    id: "tpl-meeting-notes-digest",
    name: "Meeting Notes Digest",
    description: "Summarizes imported meeting notes into a concise list of action items.",
    category: "productivity",
    tags: ["meetings", "action items", "documents"],
    difficulty: "intermediate",
    requirements: ["Document Import", "Agent (Codex or Claude)"],
    workflow: meetingNotesDigestWorkflow,
    source: communityAgentSource,
    lifecycle: communityAgentLifecycle,
  },
  {
    id: "tpl-topic-research-report",
    name: "Topic Research Report",
    description: "Researches a topic using web search and produces a structured markdown report.",
    category: "research",
    tags: ["web", "research", "report"],
    difficulty: "beginner",
    requirements: ["Agent (Codex or Claude)"],
    workflow: topicResearchReportWorkflow,
    versions: [
      {
        version: "1.1.0",
        releasedAt: "2026-06-12",
        changelog: ["Adds explicit source capture instructions for community review."],
        workflow: topicResearchReportWorkflow,
      },
      {
        version: "1.0.0",
        releasedAt: "2026-05-30",
        changelog: ["Initial community research agent workflow."],
        workflow: topicResearchReportWorkflow,
      },
      {
        version: "0.9.0",
        releasedAt: "2026-05-10",
        changelog: ["Preview workflow with broad web access defaults."],
        workflow: topicResearchReportWorkflow,
        deprecated: true,
        deprecationReason: "Replaced by versions with narrower review guidance.",
      },
    ],
    source: communityAgentSource,
    lifecycle: communityAgentLifecycle,
  },
  {
    id: "tpl-competitor-analysis",
    name: "Competitor Analysis",
    description: "Analyzes competitor products from web sources and summarizes key findings.",
    category: "research",
    tags: ["web", "competitive intelligence", "analysis"],
    difficulty: "intermediate",
    requirements: ["Agent (Codex or Claude)"],
    workflow: competitorAnalysisWorkflow,
    source: communityAgentSource,
    lifecycle: communityAgentLifecycle,
  },
  {
    id: "tpl-current-weather",
    name: "Current Weather",
    description: "Asks an agent for today's weather and stores the result as an artifact.",
    category: "monitoring",
    tags: ["weather", "agent", "quick"],
    difficulty: "beginner",
    requirements: ["Agent (Codex or Claude)"],
    workflow: currentWeatherWorkflow,
    source: firstPartySource,
    lifecycle: firstPartyLifecycle,
  },
  {
    id: "tpl-site-health-check",
    name: "Site Health Check",
    description: "Checks if specified URLs are responding and reports their status.",
    category: "monitoring",
    tags: ["uptime", "http", "status"],
    difficulty: "intermediate",
    requirements: ["HTTP probe", "Agent for final summary"],
    workflow: siteHealthCheckWorkflow,
    source: communityAgentSource,
    lifecycle: communityAgentLifecycle,
  },
  {
    id: "tpl-rss-feed-digest",
    name: "RSS Feed Digest",
    description: "Fetches and summarizes RSS feeds into a daily digest artifact.",
    category: "monitoring",
    tags: ["rss", "feeds", "digest"],
    difficulty: "beginner",
    requirements: ["Agent (Codex or Claude)"],
    workflow: rssFeedDigestWorkflow,
    source: communityAgentSource,
    lifecycle: communityAgentLifecycle,
  },
  {
    id: "tpl-blog-post-draft",
    name: "Blog Post Draft",
    description: "Generates a blog post draft from a topic prompt using web research.",
    category: "content",
    tags: ["writing", "blog", "web"],
    difficulty: "beginner",
    requirements: ["Agent (Codex or Claude)"],
    workflow: blogPostDraftWorkflow,
    source: communityAgentSource,
    lifecycle: communityAgentLifecycle,
  },
  {
    id: "tpl-social-media-recap",
    name: "Social Media Recap",
    description: "Summarizes recent social media mentions and trends into a recap artifact.",
    category: "content",
    tags: ["social", "mentions", "trends"],
    difficulty: "intermediate",
    requirements: ["Agent (Codex or Claude)"],
    workflow: socialMediaRecapWorkflow,
    source: communityAgentSource,
    lifecycle: communityAgentLifecycle,
  },
  {
    id: "tpl-pr-review-summary",
    name: "PR Review Summary",
    description: "Summarizes open pull requests from a GitHub repo into a daily digest.",
    category: "devops",
    tags: ["github", "pull requests", "code review"],
    difficulty: "intermediate",
    requirements: ["GitHub Context", "Agent (Codex or Claude)"],
    workflow: prReviewSummaryWorkflow,
    source: communityAgentSource,
    lifecycle: communityAgentLifecycle,
  },
];
