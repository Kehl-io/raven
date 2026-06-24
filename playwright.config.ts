import { defineConfig, devices } from "@playwright/test";
import { prepareFullStackHarness } from "./tests/e2e/helpers/fullstackHarness";

const isFullStackRun =
  process.env.RAVEN_E2E_FULLSTACK === "1" ||
  process.argv.some((argument) => argument.includes("fullstack.spec.ts"));
const fullStackHarness = isFullStackRun ? await prepareFullStackHarness() : null;
const frontendUrl = fullStackHarness?.frontendUrl ?? "http://127.0.0.1:1420";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: isFullStackRun ? [] : ["**/fullstack.spec.ts"],
  fullyParallel: !isFullStackRun,
  retries: 0,
  webServer: fullStackHarness
    ? [
        {
          command:
            'cargo run --manifest-path src-tauri/Cargo.toml --bin raven-test-server -- --db "$RAVEN_E2E_DB_PATH" --port "$RAVEN_E2E_BACKEND_PORT" --deterministic',
          url: `${fullStackHarness.backendUrl}/health`,
          reuseExistingServer: false,
          timeout: 120_000,
          env: {
            RAVEN_E2E_DB_PATH: fullStackHarness.dbPath,
            RAVEN_E2E_BACKEND_PORT: String(fullStackHarness.backendPort),
            RAVEN_PLUGIN_DIR: process.env.RAVEN_E2E_PLUGIN_DIR ?? "",
          },
        },
        {
          command: "node tests/e2e/helpers/start-vite-fullstack.mjs",
          url: fullStackHarness.frontendUrl,
          reuseExistingServer: false,
          timeout: 120_000,
          env: {
            RAVEN_E2E_BACKEND_URL: fullStackHarness.backendUrl,
            RAVEN_E2E_BROWSER_BACKEND_PORT: String(fullStackHarness.browserBackendPort),
            RAVEN_E2E_BROWSER_BACKEND_URL: fullStackHarness.browserBackendUrl,
            RAVEN_E2E_FRONTEND_PORT: String(fullStackHarness.frontendPort),
            VITE_RAVEN_BACKEND_URL: fullStackHarness.browserBackendUrl,
          },
        },
      ]
    : {
        command: "pnpm dev --host 127.0.0.1 --port 1420",
        url: frontendUrl,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  use: {
    baseURL: frontendUrl,
    storageState: fullStackHarness
      ? undefined
      : "tests/e2e/helpers/setup-complete-storage-state.json",
    trace: "on-first-retry",
  },
  projects: isFullStackRun
    ? [
        {
          name: "chromium-desktop",
          use: { ...devices["Desktop Chrome"] },
        },
      ]
    : [
        {
          name: "chromium-desktop",
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "chromium-mobile",
          use: { ...devices["Pixel 7"] },
        },
      ],
});
