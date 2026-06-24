# Project Instructions

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture overview and [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and setup.

## Architecture Rules

- **`db.rs`** owns all SQL — never put queries in `services.rs` or `runtime.rs`
- **`services.rs`** owns business logic orchestration — never put logic in `lib.rs` commands
- **`runtime.rs`** owns workflow execution — step running, LLM calls, event emission
- **`lib.rs`** is a thin Tauri command layer — acquire state, call services, return results
- **`tauriBridge.ts`** is the only file that calls `invoke()` — components never call it directly
- Every new Tauri command must also be routed in **`test_server.rs`** and listed in `ROUTED_COMMANDS`

## Error Handling (Rust)

- Tauri commands: `.lock().map_err(|e| e.to_string())?` — never `unwrap()` on mutexes or fallible operations
- Void closures (event handlers, `on_window_event`): `let Ok(guard) = mutex.lock() else { return };`
- Long-running commands: release the `Repository` mutex early with `drop()` and open a fresh connection (see `run_workflow_streamed` for the pattern)

## Commit Standards

- Always use Conventional Commits with scopes: `feat(tray):`, `fix(runtime):`, `test(scheduler):`, etc.
- Commit messages should be outcome-focused — the git history should read like a changelog.

## Repository Hygiene

- Do not commit project specs, implementation plans, or scratch notes unless they are intended as public documentation.
- Before committing, check that only source, configuration, tests, documentation, and other intended project artifacts are staged.

## Public Repository Safety

- Treat this repository as open source.
- Do not add secrets, credentials, tokens, private keys, personal information, customer data, internal URLs, or other non-public information to any file.
- Use placeholders for sensitive values. Keep real secrets in `.env.local` (gitignored) or a secrets manager.
- Review staged changes and commit messages for accidental disclosure before committing.

## Verification Checklist

Before marking work complete:

- [ ] `cargo check` passes (from `src-tauri/`)
- [ ] `pnpm build` passes
- [ ] New Tauri commands registered in `generate_handler![]`, wrapped in `tauriBridge.ts`, routed in `test_server.rs`
- [ ] No `unwrap()` on mutexes or fallible ops in command handlers
- [ ] No secrets, personal data, or absolute paths in committed code
