import { describe, expect, it } from "vitest";
import { prepareFullStackHarness } from "../e2e/helpers/fullstackHarness";

const e2eEnvKeys = [
  "RAVEN_E2E_DB_PATH",
  "RAVEN_E2E_PLUGIN_DIR",
  "RAVEN_E2E_BACKEND_PORT",
  "RAVEN_E2E_BACKEND_URL",
  "RAVEN_E2E_BROWSER_BACKEND_PORT",
  "RAVEN_E2E_BROWSER_BACKEND_URL",
  "RAVEN_E2E_FRONTEND_PORT",
  "RAVEN_E2E_FRONTEND_URL",
] as const;

describe("full-stack Playwright harness", () => {
  it("reuses allocated ports when the config is evaluated more than once", async () => {
    const previous = new Map(e2eEnvKeys.map((key) => [key, process.env[key]]));
    for (const key of e2eEnvKeys) {
      delete process.env[key];
    }

    try {
      const first = await prepareFullStackHarness();
      const second = await prepareFullStackHarness();

      expect(second.backendUrl).toBe(first.backendUrl);
      expect(second.browserBackendUrl).toBe(first.browserBackendUrl);
      expect(second.frontendUrl).toBe(first.frontendUrl);
      expect(process.env.RAVEN_E2E_BACKEND_URL).toBe(first.backendUrl);
    } finally {
      for (const key of e2eEnvKeys) {
        const value = previous.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
