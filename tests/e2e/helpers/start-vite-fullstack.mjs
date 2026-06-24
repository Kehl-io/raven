import { spawn } from "node:child_process";
import { createServer } from "node:http";

const backendUrl = process.env.RAVEN_E2E_BACKEND_URL;
const browserBackendUrl =
  process.env.RAVEN_E2E_BROWSER_BACKEND_URL ?? process.env.VITE_RAVEN_BACKEND_URL;
const browserBackendPort = process.env.RAVEN_E2E_BROWSER_BACKEND_PORT;
const frontendPort = process.env.RAVEN_E2E_FRONTEND_PORT ?? "1420";

if (!backendUrl) {
  console.error("RAVEN_E2E_BACKEND_URL is required.");
  process.exit(1);
}

if (!browserBackendUrl || !browserBackendPort) {
  console.error("RAVEN_E2E_BROWSER_BACKEND_URL and RAVEN_E2E_BROWSER_BACKEND_PORT are required.");
  process.exit(1);
}

await waitForBackendHealth(backendUrl);
const proxy = await startCorsProxy({
  backendUrl,
  port: Number(browserBackendPort),
});

const child = spawn("pnpm", ["dev", "--host", "127.0.0.1", "--port", frontendPort], {
  env: {
    ...process.env,
    VITE_RAVEN_BACKEND_URL: browserBackendUrl,
  },
  stdio: "inherit",
});

let exiting = false;

function stopChild(signal) {
  if (exiting) return;
  exiting = true;
  proxy.close();
  child.kill(signal);
}

process.on("SIGINT", () => stopChild("SIGINT"));
process.on("SIGTERM", () => stopChild("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

async function waitForBackendHealth(url) {
  const healthUrl = `${url.replace(/\/+$/, "")}/health`;
  const deadline = Date.now() + 120_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
      lastError = new Error(`Backend health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out waiting for backend health at ${healthUrl}: ${detail}`);
}

async function startCorsProxy({ backendUrl, port }) {
  const server = createServer(async (request, response) => {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const body = await readRequestBody(request);
      const upstream = await fetch(`${backendUrl.replace(/\/+$/, "")}${request.url}`, {
        method: request.method,
        headers: {
          "content-type": request.headers["content-type"] ?? "application/json",
        },
        body: body.length > 0 ? body : undefined,
      });

      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
