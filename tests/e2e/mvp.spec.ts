import { expect, test, type Page } from "@playwright/test";

const workflowArtifacts: Record<
  string,
  { title: string; type: string; contentMarkdown: string; sourceRefs: string[] }
> = {
  "daily-work-journal": {
    title: "Daily Work Journal",
    type: "daily_work_journal",
    contentMarkdown:
      "# Daily Work Journal\n\n## Progress\n- Reviewed recent project activity from local git context.\n\n## Run provenance\n- local git context",
    sourceRefs: ["local git context"],
  },
  "morning-brief": {
    title: "Morning Brief",
    type: "morning_brief",
    contentMarkdown:
      "# Morning Brief\n\n## Focus\n- Protect the production-readiness path.\n\n## Watch Items\n- Keep local git context fresh.\n\n## Run provenance\n- local git context",
    sourceRefs: ["local git context"],
  },
  "current-weather": {
    title: "Current Weather",
    type: "weather_report",
    contentMarkdown:
      "# Current Weather\n\n## Conditions\nDenver, CO has clear test weather.\n\nSource: Open-Meteo forecast API",
    sourceRefs: ["Open-Meteo forecast API"],
  },
};

async function installViteTauriRunMock(page: Page) {
  await page.addInitScript((artifacts) => {
    type WorkflowArtifact = {
      title: string;
      type: string;
      contentMarkdown: string;
      sourceRefs: string[];
    };

    const artifactByWorkflow = artifacts as Record<string, WorkflowArtifact>;
    const callbacks = new Map<number, (...args: unknown[]) => unknown>();
    let callbackId = 1;

    window.__TAURI_INTERNALS__ = {
      ...(window.__TAURI_INTERNALS__ ?? {}),
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === "run_workflow" || command === "run_workflow_streamed") {
          const workflowId = String(args?.workflowId ?? "");
          const artifact = artifactByWorkflow[workflowId];
          if (!artifact) throw new Error(`Unknown workflow ${workflowId}`);

          const runId = `run-${crypto.randomUUID()}`;
          const artifactId = `artifact-${crypto.randomUUID()}`;
          const createdAt = new Date().toISOString();

          return {
            run: {
              id: runId,
              workflow_id: workflowId,
              workflow_name: artifact.title,
              status: "succeeded",
              started_at: createdAt,
              completed_at: createdAt,
              idempotency_key: `manual:${workflowId}:${runId}`,
            },
            artifact: {
              id: artifactId,
              title: artifact.title,
              artifact_type: artifact.type,
              workflow_run_id: runId,
              content_markdown: artifact.contentMarkdown,
              metadata: {
                schemaVersion: "0.1.0",
                workflowId,
                workflowVersion: 1,
              },
              source_refs: artifact.sourceRefs,
              created_at: createdAt,
            },
            events: [
              {
                kind: "RUN_STARTED",
                run_id: runId,
                timestamp: createdAt,
              },
              {
                kind: "RUN_FINISHED",
                run_id: runId,
                token_count: 0,
                estimated_cost_usd: 0,
                timestamp: createdAt,
              },
            ],
            result: {
              run: {
                id: runId,
                workflow_id: workflowId,
                workflow_name: artifact.title,
                status: "succeeded",
                started_at: createdAt,
                completed_at: createdAt,
                idempotency_key: `manual:${workflowId}:${runId}`,
              },
              artifact: {
                id: artifactId,
                title: artifact.title,
                artifact_type: artifact.type,
                workflow_run_id: runId,
                content_markdown: artifact.contentMarkdown,
                metadata: {
                  schemaVersion: "0.1.0",
                  workflowId,
                  workflowVersion: 1,
                },
                source_refs: artifact.sourceRefs,
                created_at: createdAt,
              },
            },
          };
        }

        if (command === "plugin:event|listen") return crypto.randomUUID();
        if (command === "plugin:event|unlisten") return null;

        throw new Error("Tauri unavailable");
      },
      transformCallback: (callback: (...args: unknown[]) => unknown, once = false) => {
        const id = callbackId++;
        callbacks.set(id, (...args: unknown[]) => {
          const result = callback(...args);
          if (once) callbacks.delete(id);
          return result;
        });
        return id;
      },
      unregisterCallback: (id: number) => {
        callbacks.delete(id);
      },
      runCallback: (id: number, ...args: unknown[]) => callbacks.get(id)?.(...args),
    };

    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      ...(window.__TAURI_EVENT_PLUGIN_INTERNALS__ ?? {}),
      unregisterListener: () => undefined,
    };
  }, workflowArtifacts);
}

async function openArtifactsAndExpectArtifact(page: Page, artifactTitle: string) {
  await openPrimaryNav(page, "Artifacts");
  await page.locator(".artifact-list").getByRole("button", { name: new RegExp(artifactTitle) }).first().click();
  await expect(
    page.locator(".artifact-viewer header").getByRole("heading", { name: artifactTitle }),
  ).toBeVisible({ timeout: 15_000 });
}

async function openPrimaryNav(page: Page, label: "Artifacts" | "Workflows") {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: label, exact: true })
    .click();
}

async function expectArtifactLineage(page: Page) {
  await expect(page.getByRole("region", { name: "Artifact lineage" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await installViteTauriRunMock(page);
});

test("user can switch themes, run the journal template, and view the artifact", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to Light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora-light");

  await page.getByRole("button", { name: "Open Raven assistant" }).click();
  await expect(page.getByRole("dialog", { name: "Your AI assistant" })).toBeVisible();
  await page.getByRole("button", { name: "Close assistant" }).click();
  await expect(page.getByRole("dialog", { name: "Your AI assistant" })).toBeHidden();

  await page.getByRole("button", { name: "Open Daily Work Journal details" }).click();
  await expect(page.getByRole("heading", { name: "Daily Work Journal" })).toBeVisible();
  await page.getByRole("button", { name: "Run now for Daily Work Journal", exact: true }).click();
  await openArtifactsAndExpectArtifact(page, "Daily Work Journal");
  await expectArtifactLineage(page);

  await openPrimaryNav(page, "Workflows");
  await expect(page.getByRole("button", { name: "Edit Daily Work Journal setup", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run now for Current Weather", exact: true }).click();
  await openArtifactsAndExpectArtifact(page, "Current Weather");
  await expectArtifactLineage(page);
});

test("user can inspect the morning brief draft workflow", async ({ page }) => {
  await page.goto("/");

  await openPrimaryNav(page, "Workflows");
  await page.getByRole("button", { name: "Open Morning Brief details" }).click();
  await expect(page.getByRole("heading", { name: "Morning Brief" })).toBeVisible();
  await expect(page.getByLabel("Workflow summary").getByText("Draft", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Visual workflow builder")).toBeVisible();
});

test("user can run the current weather workflow and inspect the live artifact", async ({ page }) => {
  await page.goto("/");

  await openPrimaryNav(page, "Workflows");
  await page.getByRole("button", { name: "Run now for Current Weather", exact: true }).click();
  await openArtifactsAndExpectArtifact(page, "Current Weather");

  await expect(page.getByRole("heading", { name: "Conditions" })).toBeVisible();
  await expect(page.getByText("Denver, CO")).toBeVisible();
  await expect(
    page.locator(".markdown-preview").getByText("Source: Open-Meteo forecast API"),
  ).toBeVisible();
});
