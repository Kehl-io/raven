#!/usr/bin/env node
import { readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const requireUpdaterKey = args.has("--require-updater-key");
const smoke = args.has("--smoke");

const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
const packageConfig = JSON.parse(readFileSync("package.json", "utf8"));

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const csp = tauriConfig.app?.security?.csp;
expect(typeof csp === "string" && csp.trim().length > 0, "Tauri CSP must be a non-empty string.");
if (typeof csp === "string") {
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: asset:",
    "connect-src 'self' ipc: http://ipc.localhost",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]) {
    expect(csp.includes(directive), `Tauri CSP is missing directive: ${directive}`);
  }
  expect(!csp.includes("default-src *"), "Tauri CSP must not use default-src *.");
  for (const source of [
    "img-src 'self' data: asset: https:",
    "http://localhost:*",
    "http://127.0.0.1:*",
    "ws://localhost:*",
    "ws://127.0.0.1:*",
    "https://api.openai.com",
    "https://api.anthropic.com",
    "https://api.open-meteo.com",
    "https://api.github.com",
    "http://localhost:11434",
  ]) {
    expect(!csp.includes(source), `Tauri CSP must not include broad production source: ${source}`);
  }
}

expect(tauriConfig.productName === "Raven", "Tauri productName must be Raven.");
expect(tauriConfig.identifier === "io.kehl.raven", "Tauri identifier must be io.kehl.raven.");
expect(
  JSON.stringify(tauriConfig.plugins?.updater?.endpoints) ===
    JSON.stringify([
      "https://releases.crabnebula.cloud/raven/{{target}}/{{arch}}/{{current_version}}",
    ]),
  "Updater endpoint must use the Raven release product path.",
);

expect(
  JSON.stringify(capability.permissions) ===
    JSON.stringify(["core:default", "dialog:default", "notification:default"]),
  "Default capability must only grant the frontend permissions Raven uses.",
);
expect(
  packageConfig.dependencies?.["@tauri-apps/plugin-opener"] === undefined,
  "Package dependencies must not include the unused opener plugin.",
);

expect(
  packageConfig.scripts?.["tauri:build"] === "node scripts/tauri-build.mjs",
  "pnpm tauri:build must use the updater-key guarded build wrapper.",
);

const configuredPubkey = tauriConfig.plugins?.updater?.pubkey?.trim() ?? "";
const envPubkey = process.env.TAURI_UPDATER_PUBKEY?.trim() ?? "";
if (requireUpdaterKey) {
  expect(
    configuredPubkey.length > 0 || envPubkey.length > 0,
    "A production updater public key is required. Set plugins.updater.pubkey or TAURI_UPDATER_PUBKEY.",
  );
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`release config check failed: ${failure}`);
  }
  process.exit(1);
}

const keyStatus = configuredPubkey || envPubkey ? "configured" : "missing";
console.log(`release config check passed (${smoke ? "smoke" : "strict"}, updater pubkey: ${keyStatus})`);
