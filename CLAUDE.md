# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Electron + Vite with hot reload (primary dev loop).
- `npm run lint` — ESLint with cache. Minimum validation before committing.
- `npm run typecheck` — runs both `typecheck:node` (main/preload, `tsconfig.node.json`) and `typecheck:web` (renderer, `tsconfig.web.json`). Strict TS.
- `npm run format` — Prettier.
- `npm run build` — typecheck then `electron-vite build`.
- `npm run build:unpack` — build + sidecar + unpacked app for packaging checks.
- `npm run build:sidecar[:win|:mac|:linux]` — build the .NET sidecar for a target runtime (PowerShell script under `scripts/`).
- `npm run benchmark:sidecar` — `dotnet run --project ./src/dotnet/OpenCowork.Agent -- benchmark`.
- `npm run build:{win|mac|linux}` — full packaged installer.
- Docs workspace (separate Next.js + Fumadocs project in `docs/`): `npm --prefix docs run dev|build|types:check`.

There is no root test suite. For UI/IPC/workflow changes, smoke test with `npm run dev`. For sidecar or packaging changes, run the corresponding `build:sidecar:*` / `build:*` command.

## Architecture

Four-layer Electron + .NET app. Keep process boundaries explicit — system access stays in main, UI state stays in renderer, shared types go through `src/shared`.

1. **Electron main (`src/main/`)** — system layer. App bootstrap (`index.ts`), window lifecycle, IPC handlers (`ipc/`), SQLite via `better-sqlite3` (`db/`, `migration/`), cron (`cron/`, `node-cron`), channels/plugins for Feishu/DingTalk/Discord (`channels/`), MCP clients (`mcp/`), SSH (`ssh/`, `ssh2` + `node-pty`), auto-updates (`updater.ts`), crash logging.
2. **Preload (`src/preload/`)** — secure bridge exposing a narrow API surface to the renderer. All main↔renderer traffic goes through here; do not add `nodeIntegration` shortcuts.
3. **Renderer (`src/renderer/src/`)** — React 19 UI. Zustand stores (`stores/`), i18n (`locales/`, `react-i18next`), Tailwind v4, Monaco, xterm, recharts. The agent loop itself lives in the renderer under `lib/agent/` — it drives provider calls (`lib/api/{anthropic,openai-chat,openai-responses}.ts`), sub-agent orchestration (`lib/agent/sub-agents/`), and session routing (`lib/agent/session-runtime-router.ts`). Tool execution is bridged back to main/sidecar via `lib/ipc/`.
4. **.NET sidecar (`src/dotnet/OpenCowork.Agent/`)** — alternate agent runtime used by the session router and for benchmarks. Layout: `Engine/` (AgentLoop, ToolRegistry, Types), `Protocol/` (AgentRuntimeService — the IPC protocol spoken to the renderer), `Providers/` (provider message formatting), `SubAgents/`, `Tools/`, `Serialization/AppJsonContext.cs` (source-generated `System.Text.Json` context — any DTO the sidecar serializes must be registered here). Launched by main and spoken to over the protocol defined in `src/renderer/src/lib/ipc/sidecar-protocol.ts`.

Two runtimes coexist for the agent loop: the TypeScript one in the renderer and the .NET sidecar. `session-runtime-router.ts` decides which runs a given session. Changes to agent behavior often need to land in **both** places and their shared protocol types.

Bundled runtime assets (shipped to users, loaded at runtime — not source): `resources/agents`, `resources/skills`, `resources/prompts`, `resources/commands`, `resources/sidecar`.

`src/shared/` holds cross-process TypeScript contracts. `src/components`, `src/hooks`, `src/lib` at the repo root (not under `renderer/`) are additional shared utilities.

Generated/ignored: `dist/`, `out/`, `build/`, `node_modules/`. Do not edit.

## Conventions

- `.editorconfig`: UTF-8, LF, 2 spaces, final newline, trimmed trailing whitespace.
- `.prettierrc.yaml`: single quotes, **no semicolons**, 100-column width, no trailing commas.
- React component files are PascalCase (`Layout.tsx`); stores/helpers/non-component modules are kebab-case (`settings-store.ts`).
- Commit style from history: conventional commits — `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, `refactor(scope): ...`, `style(scope): ...`. Keep commits focused; don't mix refactors with behavior changes.
- When bumping the app version in `package.json`, also update the docs homepage version in `docs/src/app/(home)/page.tsx` and keep download links aligned with release assets.
- Never commit local runtime data from `~/.open-cowork/`.
