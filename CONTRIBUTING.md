# Contributing to Raven

## Prerequisites

- **Rust** (stable) — [rustup.rs](https://rustup.rs/)
- **Node.js** 20+ and **pnpm** — `npm install -g pnpm`
- **macOS** for tray/menu bar features (the rest builds cross-platform)

## Getting Started

```sh
git clone <repo-url> && cd raven
pnpm install
pnpm tauri:dev        # full desktop app with hot reload
```

For frontend-only work without the Tauri shell:

```sh
cd src-tauri && cargo build --bin raven-test-server
./target/debug/raven-test-server --db /tmp/raven-dev.sqlite3 --port 9876
# In another terminal:
VITE_RAVEN_BACKEND_URL=http://127.0.0.1:9876 pnpm dev
```

Then open `http://localhost:1420` in a browser.

## Project Structure

```
raven/
├── src/                    # React frontend
│   ├── app/
│   │   ├── views/          # Top-level pages
│   │   ├── components/     # Reusable UI components
│   │   ├── contexts/       # React contexts (state, UI, assistant)
│   │   ├── panels/         # Drawer panels
│   │   ├── tauriBridge.ts  # IPC wrapper — all backend calls go through here
│   │   └── App.tsx         # Root shell
│   └── domain/             # Pure domain logic and TypeScript types
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── lib.rs          # Tauri commands + app builder
│   │   ├── models.rs       # Domain types
│   │   ├── db.rs           # SQLite repository
│   │   ├── services.rs     # Business logic orchestration
│   │   ├── runtime.rs      # Workflow execution engine
│   │   ├── tray.rs         # macOS tray icon and menu
│   │   ├── scheduler.rs    # Background workflow scheduler
│   │   └── ...             # See docs/ARCHITECTURE.md for full module map
│   └── icons/              # App and tray icons
├── tests/                  # E2E and integration tests
├── docs/                   # Architecture and public documentation
├── CLAUDE.md               # Agent instructions (Claude Code)
└── AGENTS.md               # Agent instructions (other AI agents)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture overview.

## Development Workflow

### Running Tests

```sh
pnpm test:run          # frontend unit tests (Vitest)
pnpm typecheck         # TypeScript type checking
pnpm test:e2e          # Playwright end-to-end tests
cd src-tauri && cargo test   # Rust backend tests
```

### Adding a New Tauri Command

1. Add the business logic to `services.rs`
2. Add any new DB queries/mutations to `db.rs`
3. Add the `#[tauri::command]` function in `lib.rs`
4. Register it in `tauri::generate_handler![...]` in the `run()` function
5. Add an IPC wrapper in `src/app/tauriBridge.ts`
6. Add the route to `test_server.rs` so browser-mode development works
7. Add the command name to `ROUTED_COMMANDS` in `test_server.rs` (used by test coverage checks)

### Adding a Frontend View or Component

- Views go in `src/app/views/` and are routed from `App.tsx` via `UIContext`
- Components go in `src/app/components/` and should be exported from `components/index.ts` if shared
- All backend calls go through `tauriBridge.ts` — never call `invoke()` directly from a component
- Use existing CSS classes from `aurora.css` and the design token variables (`--surface-primary`, `--accent`, `--text-primary`, etc.)

## Conventions

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tray): add Quick Launch submenu
fix(runtime): handle empty step results
test(scheduler): cover timezone edge cases
docs: update architecture guide
```

Scopes: `tray`, `runtime`, `scheduler`, `db`, `ui`, `settings`, `onboarding`, or omit for cross-cutting changes.

### Rust

- Error handling: use `map_err(|e| e.to_string())?` in Tauri commands — never `unwrap()` on fallible operations in command/event handler code
- Mutex access in Tauri commands: always `.lock().map_err(|e| e.to_string())?`
- In void closures (event handlers, `on_window_event`): use `let Ok(guard) = mutex.lock() else { return };`
- Long-running operations: release the `Repository` mutex early — `drop()` the guard and open a fresh `Repository` connection (see `run_workflow_streamed` for the pattern)
- Platform-specific code: gate on `#[cfg(target_os = "macos")]` with a `#[cfg(not(...))]` fallback to suppress unused-variable warnings

### TypeScript

- All IPC calls go through `tauriBridge.ts` as named async functions
- State is managed via React contexts (`AppStateContext`, `UIContext`) — no prop drilling for app-wide state
- Avoid `any` — use types from `domain/types.ts` which mirror the Rust models

### CSS

- All styles live in `src/app/aurora.css`
- Use existing CSS custom properties for colors, spacing, and surfaces
- New component styles go at the end of the file with a section comment

## Security

This is a public repository. Before committing:

- **No secrets**: no API keys, tokens, passwords, private keys, or credentials in any file
- **No personal data**: no real email addresses, home directory paths, customer data, or internal URLs
- **Use placeholders** in test fixtures and examples (e.g., `https://example.com`, not a real personal site)
- **Credentials are references**: `provider_accounts.credential_ref` stores a reference key, never the raw secret. Actual secrets are resolved at runtime from environment variables or the system keychain
- **`.env*` files are gitignored**: use `.env.local` for development secrets, never commit them

## Working with AI Agents

This codebase is designed to be agent-friendly. The `CLAUDE.md` and `AGENTS.md` files provide instructions for AI coding agents.

### Key Principles for Agentic Workflows

- **`tauriBridge.ts` is the contract boundary.** An agent adding a backend feature should trace: Rust command → `services.rs` → `db.rs`, then add the IPC wrapper to `tauriBridge.ts`, the route to `test_server.rs`, and finally the frontend usage. This consistent chain makes it easy to verify completeness.
- **Each Rust module has a single responsibility.** `db.rs` owns all SQL, `services.rs` owns business logic, `runtime.rs` owns execution. An agent should never put SQL in `services.rs` or business logic in `db.rs`.
- **The test server mirrors the real backend.** Any new Tauri command must also be routed in `test_server.rs` — agents running the frontend in browser mode will hit the test server, not Tauri's IPC.
- **File ownership matters for parallel agents.** If two agents modify the same file concurrently, one will silently overwrite the other. Check the module map in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and assign files explicitly when parallelizing work.

### Agent Verification Checklist

Before marking a task complete, an agent should verify:

- [ ] `cargo check` passes (zero errors, warnings are OK)
- [ ] `pnpm build` passes (zero errors)
- [ ] `pnpm typecheck` passes
- [ ] New Tauri commands are registered in `generate_handler![]`
- [ ] New commands have a `tauriBridge.ts` wrapper
- [ ] New commands have a `test_server.rs` route and are listed in `ROUTED_COMMANDS`
- [ ] No `unwrap()` on mutex locks or fallible operations in command handlers
- [ ] No secrets, personal data, or absolute paths in committed code
- [ ] Commit message follows Conventional Commits
