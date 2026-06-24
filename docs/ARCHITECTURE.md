# Architecture

Raven is a local-first AI workflow desktop app built with [Tauri 2](https://v2.tauri.app/) (Rust backend) and React 19 (TypeScript frontend). It runs as a macOS menu bar app by default.

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  macOS Menu Bar                                              │
│  ┌─────────────┐  ┌──────────────────────────────────────┐   │
│  │  Tray Icon   │  │  Native NSMenu (Quick Launch, Quit)  │   │
│  └──────┬──────┘  └──────────────────────────────────────┘   │
│         │ Tauri events                                       │
│  ┌──────┴──────────────────────────────────────────────────┐  │
│  │  Tauri Shell (src-tauri/)                               │  │
│  │  ┌────────────┐ ┌──────────┐ ┌───────────┐             │  │
│  │  │  Commands   │ │ Runtime  │ │ Scheduler │             │  │
│  │  │  (lib.rs)   │ │          │ │           │             │  │
│  │  └──────┬─────┘ └────┬─────┘ └─────┬─────┘             │  │
│  │         │             │             │                    │  │
│  │  ┌──────┴─────────────┴─────────────┴──────────────┐    │  │
│  │  │  Services Layer (services.rs)                    │    │  │
│  │  └──────────────────────┬──────────────────────────┘    │  │
│  │                         │                               │  │
│  │  ┌──────────────────────┴──────────────────────────┐    │  │
│  │  │  Repository (db.rs) — SQLite via rusqlite       │    │  │
│  │  └─────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                            │ Tauri IPC                        │
│  ┌─────────────────────────┴───────────────────────────────┐  │
│  │  React Frontend (src/app/)                              │  │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐              │  │
│  │  │  Views   │ │Components│ │  Contexts   │              │  │
│  │  └────┬─────┘ └────┬─────┘ └──────┬─────┘              │  │
│  │       └─────────────┴──────────────┘                    │  │
│  │                     │                                   │  │
│  │  ┌──────────────────┴──────────────────────────────┐    │  │
│  │  │  tauriBridge.ts — IPC wrapper over invoke()     │    │  │
│  │  └─────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Backend (Rust — `src-tauri/src/`)

### Module Responsibilities

| Module | Role |
|--------|------|
| `lib.rs` | Tauri command registration, app builder setup, window lifecycle, activation policy |
| `models.rs` | All domain types: `RavenWorkflow`, `WorkflowRun`, `RunStatus`, `Artifact`, `AppState`, etc. |
| `db.rs` | SQLite repository — all reads/writes, schema migrations, settings |
| `services.rs` | Business logic layer — thin orchestration between db, runtime, providers |
| `runtime.rs` | Workflow execution engine — runs steps, calls LLMs, emits events, produces artifacts |
| `scheduler.rs` | Background scheduler thread — polls for due workflows, emits lifecycle events |
| `stream.rs` | `RuntimeEventSink` trait and implementations for streaming workflow events to the frontend |
| `tray.rs` | macOS tray icon, native menu, icon state management, workflow event listeners |
| `execution.rs` | Low-level step execution — HTTP calls, tool invocations, token counting |
| `llm.rs` | LLM client implementations (OpenAI, Anthropic) |
| `llm_provider.rs` | Provider detection, Ollama integration |
| `builder_agent.rs` | AI workflow builder — generates workflow definitions from natural language prompts |
| `workflow.rs` | Workflow validation, template seeding, definition parsing |
| `planner/` | Deterministic operation planner — maps prompts to workflow operations |
| `capabilities.rs` | Capability descriptors for tools/operations |
| `capability_registry.rs` | Runtime capability registry with trust tiers |
| `autonomy.rs` | Autonomy modes (full-auto, safe-auto, manual) and per-category overrides |
| `approval.rs` | Pending approval queue — pause/resume workflow execution at approval gates |
| `approval_grants.rs` | Pre-authorized approval grants for capabilities |
| `preflight.rs` | Pre-run safety checks — what capabilities a workflow needs, what's missing |
| `providers.rs` | Context providers — git, GitHub, documents, AI chat imports, NestWeaver |
| `plugins.rs` | Plugin manifest loading |
| `agent_auth.rs` | Agent auth profiles — credential routing for different LLM providers |
| `agent_task.rs` | Agent task execution — structured tool-use runs |
| `content_tools.rs` | Content extraction tools (PDF, HTML) |
| `http_probe.rs` | HTTP probing for tool discovery |
| `local_tools.rs` | Local CLI tool detection |
| `seo_tools.rs` | SEO audit tooling |
| `web_tools.rs` | Web scraping tools |
| `weather.rs` | Weather provider integration |
| `news.rs` | News feed integration |
| `csv_prompt.rs` | CSV-to-prompt conversion |
| `test_server.rs` | Standalone HTTP test server for browser-mode frontend development |

### Data Flow

1. **Frontend** calls a Tauri command via `tauriBridge.ts` → `invoke()`
2. **`lib.rs`** receives the command, acquires the `Repository` mutex, calls the corresponding `services::` function
3. **`services.rs`** orchestrates: reads from `db.rs`, runs logic in `runtime.rs`, returns results
4. **`runtime.rs`** executes workflow steps: calls `llm.rs` for AI generation, `execution.rs` for tool calls, emits `AgentEvent`s via `RuntimeEventSink`
5. Results flow back through the same chain to the frontend

### Event System

Workflow lifecycle events (`workflow:started`, `workflow:completed`, `workflow:errored`) are emitted as Tauri events from:
- `lib.rs` — manual `run_workflow` command
- `stream.rs` — streamed `run_workflow_streamed` command
- `scheduler.rs` — background scheduled runs

The tray module (`tray.rs`) listens for these events and updates the icon state, status text, tooltip, and Quick Launch menu.

### Concurrency Model

- The `Repository` is wrapped in `Mutex<Repository>` and managed as Tauri state
- Tauri commands acquire the mutex, but `run_workflow` and `run_workflow_streamed` release it immediately and open a fresh `Repository` connection for the duration of the run — this prevents long-running workflows from blocking the UI
- The `SchedulerService` runs on its own thread and opens its own `Repository` connection per tick
- `TrayState` uses atomics (`AtomicUsize`, `AtomicBool`) for lock-free state updates from event listeners

## Frontend (TypeScript/React — `src/app/`)

### Structure

| Path | Role |
|------|------|
| `App.tsx` | Root shell — setup wizard gate, onboarding overlay, view routing, modal management |
| `tauriBridge.ts` | IPC layer — wraps every Tauri command as an async function. Supports `VITE_RAVEN_BACKEND_URL` for browser-mode development against the test server |
| `contexts/` | React contexts — `AppStateContext` (data + actions), `UIContext` (view routing, theme), `AssistantContext`, `RunStreamContext` |
| `views/` | Top-level pages — `HomeView` (command center), `WorkflowsView`, `WorkflowDetailView`, `ArtifactsView`, `SettingsView`, `TemplateMarketplace` |
| `components/` | Reusable UI — `Sidebar`, `TopBar`, `OnboardingOverlay`, `ApprovalCard`, `RunReadinessPanel`, `ScheduleTimelinePanel`, `WorkflowDag`, etc. |
| `panels/` | Drawer panels — `AssistantDrawer` |
| `domain/` | Pure domain logic — `types.ts` (TypeScript types mirroring Rust models), `workflow.ts`, `templates.ts`, `format.ts` |
| `CommandPalette.tsx` | Cmd+K command palette |
| `SetupWizard.tsx` | First-run setup flow |

### State Management

- **`AppStateContext`** holds all app data (`AppState` from the backend), workflow drafts, approval queues, toasts, and setup state. It polls the backend on mount and exposes `actions` for mutations.
- **`UIContext`** manages view routing, sidebar state, theme, and modal state (`commandPaletteOpen`, `assistantOpen`, `createWorkflowHubOpen`).
- **`tauriBridge.ts`** is the single point of contact with the backend — no component calls `invoke()` directly.

### Styling

- Single CSS file: `aurora.css` (~8300 lines)
- Aurora Light/Dark themes via CSS custom properties and `[data-theme]` selector
- Custom accent colors applied via inline CSS variables

## Database

SQLite via `rusqlite` with bundled SQLite. Schema is migrated on `Repository::open()`.

Key tables:
- `workflows` — workflow definitions (JSON), status, schedule
- `workflow_runs` — execution history, status, timing
- `workflow_step_runs` — per-step results within a run
- `artifacts` — generated output content (Markdown)
- `settings` — key-value store for preferences (dock visibility, shortcuts, provider configs)
- `provider_accounts` — configured AI provider credentials (references, not raw secrets)
- `approval_grants` — pre-authorized capability grants
- `capability_audit_events` — audit trail for capability usage

## Build & Distribution

- **Desktop**: `pnpm tauri:build` produces a `.dmg` / `.app` bundle
- **Dev**: `pnpm tauri:dev` runs both frontend and backend with hot reload
- **Browser-only**: `VITE_RAVEN_BACKEND_URL=http://127.0.0.1:9876 pnpm dev` with the test server for frontend-only development
- **Tests**: `pnpm test:run` (Vitest), `cargo test` (Rust), `pnpm test:e2e` (Playwright)
