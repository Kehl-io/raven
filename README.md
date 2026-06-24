<p align="center">
  <img src="assets/raven-icon.png" width="120" alt="Raven">
</p>

<p align="center">
  <strong>Local-first AI workflows that turn your daily work into useful artifacts.</strong>
</p>

<p align="center">
  <a href="https://github.com/Kehl-io/raven/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Kehl-io/raven/ci.yml?branch=main&label=CI&style=flat-square" alt="CI"></a>
  <a href="https://github.com/Kehl-io/raven/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
  <a href="https://github.com/Kehl-io/raven/releases"><img src="https://img.shields.io/github/v/release/Kehl-io/raven?style=flat-square&label=release" alt="Latest Release"></a>
</p>

---

Raven is a local-first AI workflow desktop app for creating, scheduling, and running workflows that generate trusted daily artifacts from your project context. It runs as a macOS menu bar app by default — close the window and it keeps working in the background.

## Features

- **Workflow engine** — create, schedule, and run multi-step AI workflows that produce artifacts from your project context
- **Menu bar integration** — state-aware tray icon, Quick Launch submenu, and global keyboard shortcut (⌘⇧R)
- **Background mode** — closing the window keeps Raven running silently; reopen from the tray or the shortcut
- **Scheduler** — cron-style scheduling with daily/weekday cadence, timezone-aware local times, and schedule overrides
- **Approval & autonomy controls** — configurable autonomy modes, per-capability approval grants, and a pending-approval queue
- **Context adapters** — pull context from local git, GitHub repos, document folders, AI chat exports, and NestWeaver knowledge graphs
- **Artifact management** — browse, export, and regenerate workflow outputs with Markdown preview
- **Provider support** — pluggable AI providers with credential management and health checks
- **Template marketplace** — install pre-built workflow templates or build your own with the AI builder chat
- **First-launch onboarding** — guided setup wizard with a menu bar orientation overlay
- **Theming** — Aurora Light/Dark themes with custom accent color and theme import/export

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/)
- [Tauri CLI](https://v2.tauri.app/) — `cargo install tauri-cli`

### Run the desktop app

```sh
git clone https://github.com/Kehl-io/raven.git && cd raven
pnpm install
pnpm tauri:dev
```

### Browser-only frontend development

To work on the frontend without the Tauri shell:

```sh
cd src-tauri && cargo build --bin raven-test-server
./target/debug/raven-test-server --db /tmp/raven-dev.sqlite3 --port 9876
# In another terminal:
VITE_RAVEN_BACKEND_URL=http://127.0.0.1:9876 pnpm dev
```

Open `http://localhost:1420` in a browser.

## Development

| Command | Description |
|---------|-------------|
| `pnpm tauri:dev` | Start the Tauri desktop app (frontend + backend) |
| `pnpm dev` | Start only the React/Vite frontend |
| `pnpm build` | Build the frontend for production |
| `pnpm typecheck` | Verify TypeScript types |
| `pnpm test:run` | Run frontend unit tests |
| `pnpm test:e2e` | Run the Playwright smoke flow |
| `cargo test` | Run Rust backend tests (from `src-tauri/`) |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture overview, module map, data flow, and concurrency model.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, conventions, and the agent verification checklist.

## License

[MIT](LICENSE)

---

<p align="center">
  <a href="https://kehl.io">
    <img src="assets/kehl-io/kehl-icon.png" width="56" alt="kehl.io" />
  </a>
  <br>
  <sub>Built by <a href="https://kehl.io">kehl.io</a></sub>
</p>
