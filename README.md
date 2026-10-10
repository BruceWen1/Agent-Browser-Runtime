# Agent Browser Runtime

ABR 为 AI Agent 与 Playwright 项目提供本地浏览器运行环境。运行时包含 Compatible、GUI 和 Native 三种执行引擎，统一管理会话、能力、策略和操作结果。

工程使用 Node.js 24.15.0、pnpm 12.10.1 和 Rust 1.99.0。安装 Node.js 后可通过 Corepack 使用锁定的 pnpm；Rust 使用 rustup 管理。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
cargo test --workspace
corepack pnpm abr init
corepack pnpm abr doctor --json
corepack pnpm abr mcp serve --stdio
```

源码注释和函数说明使用英文，使用文档与实施报告使用中文。每项任务分别记录实现状态、编译验证和实机验收。

## 执行引擎

| 引擎       | 观察                | 输入            | 验证目标                  |
| ---------- | ------------------- | --------------- | ------------------------- |
| Compatible | 官方 Playwright     | 官方 Playwright | 原有 API 语义与页面功能   |
| GUI        | 系统无障碍与截图    | 系统鼠标键盘    | 同平台 GUI 事件和页面状态 |
| Native     | Chromium 只读观察桥 | 复用系统输入    | 浏览器集成与功能回归      |

Windows 是当前实机验证平台。macOS、Linux X11 和 Wayland 使用独立能力检测与验收记录。Chromium 构建工作目录由配置指定，并采用无空格路径。

## 本地配置与授权

初始化命令在当前项目的 `.abr/config.yaml` 创建配置，已有文件受到独占创建保护。Profile 默认位于当前用户的 ABR 应用数据目录；可通过 `ABR_DATA_DIR` 指定独立测试目录。默认授权范围为本机 HTTP 测试域，其他目标需要由本地用户修改允许列表。

MCP 客户端使用 `node packages/cli/dist/main.js mcp serve --stdio` 启动运行时。协议使用标准输出，诊断使用标准错误。工具目录包含 21 个浏览器工具，可通过 `browser_capabilities` 查询当前会话的实际能力。
