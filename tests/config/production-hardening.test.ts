import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const defaultCapability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
const packageConfig = JSON.parse(readFileSync("package.json", "utf8"));

describe("production hardening config", () => {
  it("uses a restrictive production CSP compatible with Raven runtime and tests", () => {
    const csp = tauriConfig.app.security.csp;

    expect(typeof csp).toBe("string");
    expect(csp).not.toContain("default-src *");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect(csp).toContain("img-src 'self' data: asset:");
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost");
    expect(csp).not.toContain("img-src 'self' data: asset: https:");
    expect(csp).not.toContain("http://localhost:*");
    expect(csp).not.toContain("http://127.0.0.1:*");
    expect(csp).not.toContain("ws://localhost:*");
    expect(csp).not.toContain("ws://127.0.0.1:*");
    expect(csp).not.toContain("https://api.openai.com");
    expect(csp).not.toContain("https://api.anthropic.com");
    expect(csp).not.toContain("https://api.open-meteo.com");
    expect(csp).not.toContain("https://api.github.com");
    expect(csp).not.toContain("http://localhost:11434");
  });

  it("keeps updater naming aligned to Raven and prevents unguarded release builds without a key", () => {
    expect(tauriConfig.productName).toBe("Raven");
    expect(tauriConfig.identifier).toBe("io.kehl.raven");
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://releases.crabnebula.cloud/raven/{{target}}/{{arch}}/{{current_version}}",
    ]);

    expect(packageConfig.scripts["verify:release-config"]).toBe(
      "node scripts/verify-release-config.mjs",
    );
    expect(packageConfig.scripts["release:smoke"]).toBe(
      "pnpm verify:release-config --smoke && pnpm build && (cd src-tauri && cargo build --release)",
    );
    expect(packageConfig.scripts["tauri:build"]).toBe("node scripts/tauri-build.mjs");
  });

  it("does not grant unused frontend plugin permissions", () => {
    expect(defaultCapability.permissions).toEqual([
      "core:default",
      "core:tray:default",
      "core:menu:default",
      "core:window:allow-create",
      "core:window:allow-show",
      "core:window:allow-set-focus",
      "core:window:allow-close",
      "dialog:default",
      "notification:default",
      "global-shortcut:default",
    ]);
    expect(packageConfig.dependencies).not.toHaveProperty("@tauri-apps/plugin-opener");
  });
});
