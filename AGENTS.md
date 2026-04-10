# Repository Guidelines

## Project Structure & Module Organization

- `src/main/`: Electron 主进程，负责应用生命周期、窗口管理、IPC 路由、SQLite、Cron 调度、插件/频道（Feishu/DingTalk/Discord 等）、MCP、SSH、自动更新与崩溃治理。
- `src/preload/`: `contextBridge` 暴露给渲染进程的安全 API；禁止在此层做业务逻辑。
- `src/renderer/src/`: React 19 UI 与状态层。核心目录：`components/`、`stores/`、`hooks/`、`lib/`、`locales/`、`assets/`。
- `src/shared/`: 跨进程共享的 TypeScript 类型与常量。
- `src/dotnet/OpenCowork.Agent/`: .NET sidecar（双运行时策略的一部分），用于高性能/隔离运行的 agent 逻辑。
- 资源与运行时资产：`resources/agents`、`resources/skills`、`resources/prompts`、`resources/commands`、`resources/sidecar`。
- 文档站点：`docs/`（独立 Next.js/Fumadocs workspace）。
- 构建产物与本地缓存：`out/`、`dist/`、`build/`、`node_modules/` 仅用于运行/构建，不直接编辑源码。

## Architecture Overview

仓库采用「`main` ↔ `preload` ↔ `renderer`」三层 + sidecar 混合架构：系统能力与 I/O 集中在 `src/main`，UI 和会话编排在 `src/renderer/src`，共享契约在 `src/shared`，重计算/工具执行部分可通过 sidecar (`src/dotnet/OpenCowork.Agent`) 处理。贡献时请优先确认流程边界未越权。

## Build, Test, and Development Commands

- `npm install`：安装根依赖。
- `npm run dev`：启动 Electron+Vite 开发模式（如：`npm run dev`）。
- `npm run start`：预览打包产物。
- `npm run lint`：ESLint 校验。
- `npm run typecheck`：执行 `typecheck:node` 与 `typecheck:web`。
- `npm run format`：运行 Prettier 格式化。
- `npm run build`：类型检查后打包主进程与渲染进程。
- `npm run build:sidecar:win|mac|linux`：编译平台 sidecar；如：`npm run build:sidecar:win`。
- `npm run build:unpack`：本地打包校验；`npm run build:{win|mac|linux}`：正式构建安装包。
- `npm run benchmark:sidecar`：`dotnet run --project ./src/dotnet/OpenCowork.Agent -- benchmark`。
- 文档站点：`npm --prefix docs run dev|build|types:check`。

## Coding Style & Naming Conventions

- 统一风格由 `.editorconfig` 与 `.prettierrc.yaml` 约束：UTF-8、LF、2 空格缩进、无尾空白，单引号，关闭分号，`printWidth: 100`。
- TypeScript 使用严格模式（见 `tsconfig.node.json` 与 `tsconfig.web.json`）。
- React 组件采用 PascalCase 文件名（如 `Layout.tsx`）；非组件模块偏向 kebab-case（如 `settings-store.ts`）。
- 遵守现有 `alias` 约定：在 renderer 中可使用 `@renderer/*`。
- 公开事件名、IPC 通道、Sidecar 协议保持语义化、可逆向追踪。

## Testing Guidelines

- 当前仓库未配置独立 `npm test`。
- 每次改动至少跑：`npm run lint && npm run typecheck`。
- 涉及主进程/IPC/渲染交互改动：先 `npm run dev` 做冒烟验证。
- 涉及发布链路/sidecar 改动：先执行对应 `npm run build:sidecar:*`，再执行 `npm run build:*`。
- 文档修改：至少执行 `npm --prefix docs run types:check` 与 `npm --prefix docs run build`。

## Commit & Pull Request Guidelines

- 使用 Conventional Commits（与历史一致）：`feat(scope): ...`、`fix(scope): ...`、`chore(scope): ...`。
- 一个 PR 只做一类目标；大改动拆分为多个提交，避免功能与重构混杂。
- PR 描述需包含：变更范围、复现步骤、验证命令（至少 `npm run lint`、`npm run typecheck`）、必要截图或录屏。
- 涉及 packaging/sidecar 的变更，补充平台影响说明（Windows/macOS/Linux）。

## Security & Configuration

- 禁止提交密钥、`~/.open-cowork/` 本地运行数据、`.env`/私钥或下载缓存。
- 仅通过参数和配置文件注入敏感信息（如 API Key、代理配置）。
- 发布前确认 `electron-builder.yml` 与签名/打包入口文件一致；侧载资源应最终位于 `resources/sidecar`。
