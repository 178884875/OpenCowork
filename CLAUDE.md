# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenCowork is an AI-powered collaborative development platform built with Electron + React + TypeScript. It provides an agentic chat interface where LLMs (OpenAI, Anthropic Claude, DeepSeek, etc.) can use tools (file system, shell, search, sub-agents) to accomplish development tasks. Features include:
- Multi-provider AI agent system with tool execution and approval workflow
- Sub-agent framework for specialized tasks (code review, debugging, refactoring, security audits)
- Three working modes: Chat, Cowork, and Code
- Plugin system for messaging platform integration (Feishu, DingTalk, Telegram, Discord, WhatsApp, WeCom)
- Persistent session management with SQLite database
- Real-time streaming with token usage tracking

## Commands

```bash
# Development (starts Electron with HMR)
npm run dev

# Type checking
npm run typecheck          # both main + renderer
npm run typecheck:node     # main process only
npm run typecheck:web      # renderer process only

# Linting & formatting
npm run lint
npm run format

# Production build
npm run build              # typecheck + electron-vite build
npm run build:win          # build + package for Windows
npm run build:mac          # build + package for macOS
npm run build:linux        # build + package for Linux
```

There are no test scripts configured. The project uses `electron-vite` for build tooling.

## Architecture

### Process Model (Electron)

The app follows the standard Electron two-process model:

- **Main process** (`src/main/`): Node.js backend — IPC handlers, SQLite database, plugin services, cron scheduler, MCP server management, process management, crash logging.
- **Renderer process** (`src/renderer/`): React frontend — chat UI, agent loop execution, state management, tool execution, preview system.
- **Preload** (`src/preload/`): Bridge exposing IPC to the renderer via `window.electron`.

All communication between processes uses typed IPC channels defined in `src/renderer/src/lib/ipc/channels.ts`.

### Main Process (`src/main/`)

- **Entry**: `index.ts` — creates BrowserWindow (frameless), system tray, registers all IPC handlers, initializes PluginManager and McpManager.
- **IPC handlers** (`ipc/`): Each domain has its own handler file (fs, shell, db, plugins, mcp, cron, settings, etc.). Registered at startup via `register*Handlers()` functions.
- **Database** (`db/database.ts`): SQLite via `better-sqlite3`, stored at `~/.open-cowork/data.db`. WAL mode. Tables: `sessions`, `messages`, `plans`, `tasks`, `cron_jobs`, `cron_runs`. Schema migrations are inline ALTER TABLE with try/catch for idempotency.
- **Plugin system** (`plugins/`): Factory-registry pattern. `PluginManager` holds factories and parsers per provider type. Each provider (`providers/{name}/`) implements `MessagingPluginService`. Providers using WebSocket extend `BasePluginService` with a `WsMessageParser`. Feishu uses the official Lark SDK instead of raw WS.
- **Cron** (`cron/`): Persistent scheduled jobs using `node-cron`. Jobs stored in SQLite, loaded at startup via `loadPersistedJobs()`.
- **MCP** (`mcp/`): Model Context Protocol server management via `@modelcontextprotocol/sdk`.

### Renderer Process (`src/renderer/src/`)

- **Entry**: `main.tsx` — renders `<App />` or `<NotifyWindow />` based on URL hash.
- **App init** (`App.tsx`): Synchronously registers providers and viewers, async-registers tools, initializes plugin event listener. Loads sessions/plans/cron from SQLite on mount.

#### State Management (Zustand + Immer)

All stores in `stores/` use Zustand with Immer middleware. Key stores:
- `chat-store`: Sessions and messages. Persists to SQLite via fire-and-forget IPC calls.
- `agent-store`: Agent loop runtime state — streaming text, tool calls, approval flow, sub-agent tracking. Persisted to IPC storage.
- `plugin-store`: Plugin instances, statuses, incoming message events.
- `settings-store`: User preferences (theme, language, model, API keys).
- `provider-store`: AI provider configurations (Anthropic, OpenAI-chat, OpenAI-responses).
- `task-store`, `plan-store`, `team-store`, `cron-store`, `mcp-store`, `ui-store`, `notify-store`.

#### Agent Loop (`lib/agent/`)

The core agentic loop is in `agent-loop.ts` — an `AsyncGenerator<AgentEvent>` that:
1. Sends conversation to LLM via a provider
2. Streams response (text, thinking, tool calls)
3. Executes tool calls via `toolRegistry`
4. Appends tool results and loops until no more tool calls or max iterations

Key types in `types.ts`: `AgentLoopConfig`, `AgentEvent` (discriminated union), `ToolCallState`, `MessageQueue`.

System prompt is built dynamically in `system-prompt.ts` based on mode (cowork/code), working folder, language, plan mode, and active team state.

Sub-agents (`lib/agent/sub-agents/`) are defined as `.md` files in `resources/agents/` (code-search, code-review, planner, cron-agent) and registered as a unified `Task` tool.

#### Tool System (`lib/tools/`)

Tools are registered globally via `toolRegistry` (in `lib/agent/tool-registry.ts`). Each tool implements `ToolHandler` from `tool-types.ts`:
- `definition`: JSON Schema tool definition
- `execute(input, ctx)`: Returns `ToolResultContent`
- `requiresApproval?(input, ctx)`: Optional approval gate

Built-in tools: TaskCreate/Update/Get/List, Read/Write/Edit (fs), Glob/Grep (search), Shell (bash), Skill, Preview, AskUserQuestion, Plan tools, Cron tools, Notify.

Plugin tools are registered/unregistered dynamically via `plugin-tools.ts` when plugins are toggled.

#### API Providers (`lib/api/`)

Three provider protocols: `anthropic`, `openai-chat`, `openai-responses`. Each implements `APIProvider` interface with `sendMessage()` returning `AsyncIterable<StreamEvent>`. Provider configs support vision, thinking/reasoning modes, and per-model pricing.

#### Preview System (`lib/preview/`)

Viewer registry pattern. Viewers registered at startup via `register-viewers.ts`. Supports spreadsheet (xlsx), PDF, images, markdown, docx.

#### i18n

Uses `i18next` + `react-i18next`. Locale files in `locales/{en,zh}/`. Language synced from `settings-store`.

### Key Patterns

- **IPC channel constants**: All channels centralized in `lib/ipc/channels.ts` as a const object.
- **Path alias**: `@renderer/*` maps to `src/renderer/src/*` (configured in tsconfig.web.json and electron.vite.config.ts).
- **Plugin auto-reply**: When a plugin receives a message, it can trigger the agent loop with `forceApproval` to run tools with user permission gates. Handled in `hooks/use-plugin-auto-reply.ts`.
- **Agent teams**: Lead agent can spawn parallel teammate agents via `TeamCreate` + `Task(run_in_background=true)`. Communication via `MessageQueue` and `SendMessage` tool.
- **Context compression**: Between agent loop iterations, conversation history can be compressed (summarized) or pre-compressed (stale tool results cleared) based on token thresholds.
- **Data directory**: `~/.open-cowork/` — contains `data.db`, agent definitions, workflows, and plugin configs.

### Documentation Site (`docs/`)

A separate Next.js + [Fumadocs](https://fumadocs.dev) documentation site. Run independently with `npm run dev` inside `docs/`. Not part of the Electron build.

### Configuration Files

- `electron.vite.config.ts`: Vite config for main/preload/renderer. `better-sqlite3` is external. Renderer uses `@renderer` alias and Tailwind CSS v4 plugin.
- `tsconfig.node.json`: Main + preload TypeScript config.
- `tsconfig.web.json`: Renderer TypeScript config with `@renderer/*` path mapping.
- Styling: Tailwind CSS v4 via `@tailwindcss/vite` plugin, with `tailwind-merge`, `class-variance-authority`, and `tw-animate-css`.
- UI components: Radix UI primitives, Lucide icons, Motion for animations, Monaco Editor, cmdk for command palette.

## Working with Sub-Agents

Sub-agents are specialized AI agents defined in markdown files at `resources/agents/*.md`. Each defines:
- Agent name, description, and capabilities
- System prompt tailored for specific tasks
- Available tools (subset of main tool registry)
- Input/output format

Available sub-agents include:
- `code-reviewer.md` - Code review and quality analysis
- `debugger.md` - Bug investigation and debugging
- `refactor-expert.md` - Code refactoring and optimization
- `security-auditor.md` - Security vulnerability scanning
- `test-automator.md` - Test generation and automation
- `api-designer.md` - API design and documentation
- `architect-reviewer.md` - Architecture review
- `performance-engineer.md` - Performance optimization
- `doc-writer.md` - Documentation generation
- `frontend-developer.md`, `fullstack-developer.md` - Specialized development agents
- `data-analyst.md`, `copywriter.md`, `translator.md`, `meeting-summarizer.md` - Domain-specific agents

Sub-agents are loaded dynamically at startup via IPC from the main process and registered as a unified `Task` tool in the tool registry.

## Important Implementation Notes

- **Frameless Window**: The app uses a custom title bar with window controls handled via IPC (`window:minimize`, `window:maximize`, `window:close`)
- **Database Persistence**: All sessions and messages are persisted to SQLite. Messages are lazy-loaded (session list shows metadata only, full history loads on activation)
- **Tool Approval System**: Tools can require user approval based on settings. The agent loop pauses and yields an approval event, waiting for user confirmation before execution
- **Context Window Management**: Automatic compression when approaching token limits - either lightweight pre-compression (removes stale tool results) or full compression (summarizes history via LLM)
- **Error Recovery**: Provider requests retry up to 3 times with exponential backoff. Tool execution errors are captured and returned as tool results to the agent
- **Process Cleanup**: All managed background processes are killed on app quit to prevent orphaned processes
- **Security**: API keys stored securely in main process via `secure-key-store.ts`, not accessible from renderer

## Development Workflow

1. **Hot Reload**: Renderer process supports HMR. Main process changes require full restart (`Ctrl+C` then `npm run dev`)
2. **Type Safety**: Always run `npm run typecheck` before committing to catch type errors
3. **Code Style**: Use `npm run format` to auto-format with Prettier. Follow existing patterns in the codebase
4. **Adding Tools**: Register new tools in `src/renderer/src/lib/tools/index.ts` via `registerAllTools()`
5. **Adding IPC Handlers**: Create handler file in `src/main/ipc/`, register in `src/main/index.ts`
6. **State Management**: Use Zustand stores with Immer for immutable updates. Keep stores focused and single-purpose
