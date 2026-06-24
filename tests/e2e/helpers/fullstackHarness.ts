import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

export type FullStackHarness = {
  dbPath: string;
  backendPort: number;
  backendUrl: string;
  browserBackendPort: number;
  browserBackendUrl: string;
  frontendPort: number;
  frontendUrl: string;
};

export async function prepareFullStackHarness(): Promise<FullStackHarness> {
  const existing = existingHarnessFromEnv();
  if (existing) return existing;

  const tempDir = mkdtempSync(join(tmpdir(), "raven-fullstack-"));
  const backendPort = await allocatePort();
  let browserBackendPort = await allocatePort();
  while (browserBackendPort === backendPort) {
    browserBackendPort = await allocatePort();
  }
  let frontendPort = await allocatePort();
  while (frontendPort === backendPort || frontendPort === browserBackendPort) {
    frontendPort = await allocatePort();
  }
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const browserBackendUrl = `http://127.0.0.1:${browserBackendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const dbPath = join(tempDir, "raven.sqlite3");
  const pluginDir = join(process.cwd(), "src-tauri", "tests", "fixtures", "plugins");

  process.env.RAVEN_E2E_DB_PATH = dbPath;
  process.env.RAVEN_E2E_PLUGIN_DIR = pluginDir;
  process.env.RAVEN_E2E_BACKEND_PORT = String(backendPort);
  process.env.RAVEN_E2E_BACKEND_URL = backendUrl;
  process.env.RAVEN_E2E_BROWSER_BACKEND_PORT = String(browserBackendPort);
  process.env.RAVEN_E2E_BROWSER_BACKEND_URL = browserBackendUrl;
  process.env.RAVEN_E2E_FRONTEND_PORT = String(frontendPort);
  process.env.RAVEN_E2E_FRONTEND_URL = frontendUrl;

  return {
    dbPath,
    backendPort,
    backendUrl,
    browserBackendPort,
    browserBackendUrl,
    frontendPort,
    frontendUrl,
  };
}

function existingHarnessFromEnv(): FullStackHarness | null {
  const dbPath = process.env.RAVEN_E2E_DB_PATH;
  const backendPort = numberFromEnv("RAVEN_E2E_BACKEND_PORT");
  const backendUrl = process.env.RAVEN_E2E_BACKEND_URL;
  const browserBackendPort = numberFromEnv("RAVEN_E2E_BROWSER_BACKEND_PORT");
  const browserBackendUrl = process.env.RAVEN_E2E_BROWSER_BACKEND_URL;
  const frontendPort = numberFromEnv("RAVEN_E2E_FRONTEND_PORT");
  const frontendUrl = process.env.RAVEN_E2E_FRONTEND_URL;

  if (
    !dbPath ||
    !backendPort ||
    !backendUrl ||
    !browserBackendPort ||
    !browserBackendUrl ||
    !frontendPort ||
    !frontendUrl
  ) {
    return null;
  }

  return {
    dbPath,
    backendPort,
    backendUrl,
    browserBackendPort,
    browserBackendUrl,
    frontendPort,
    frontendUrl,
  };
}

function numberFromEnv(key: string): number | null {
  const value = Number(process.env[key]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a backend port")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
