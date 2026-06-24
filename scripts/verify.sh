#!/usr/bin/env bash
set -euo pipefail

pnpm build
pnpm test:run
pnpm test:e2e
pnpm test:e2e:fullstack
(cd src-tauri && cargo build)
(cd src-tauri && cargo test)
pnpm release:smoke
