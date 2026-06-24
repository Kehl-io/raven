#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const configuredPubkey = tauriConfig.plugins?.updater?.pubkey?.trim() ?? "";
const envPubkey = process.env.TAURI_UPDATER_PUBKEY?.trim() ?? "";

if (!configuredPubkey && !envPubkey) {
  console.error(
    "A production updater public key is required before packaging. Set plugins.updater.pubkey or TAURI_UPDATER_PUBKEY.",
  );
  process.exit(1);
}

const args = ["exec", "tauri", "build"];
let tempDir;

if (!configuredPubkey && envPubkey) {
  tempDir = mkdtempSync(join(tmpdir(), "raven-tauri-config-"));
  const configPath = join(tempDir, "updater-pubkey.json");
  writeFileSync(
    configPath,
    JSON.stringify({ plugins: { updater: { pubkey: envPubkey } } }),
    { mode: 0o600 },
  );
  args.push("--config", configPath);
}

const result = spawnSync("pnpm", args, { stdio: "inherit" });

if (tempDir) {
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(result.status ?? 1);
