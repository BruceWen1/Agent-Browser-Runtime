# Agent Browser Runtime

ABR 为 AI Agent 与 Playwright 项目提供本地浏览器运行环境。运行时包含 Compatible、GUI 和 Native 三种执行引擎，统一管理会话、能力、策略和操作结果。

工程使用 Node.js 24.15.0、pnpm 12.10.1 和 Rust 1.99.0。安装 Node.js 后可通过 Corepack 使用锁定的 pnpm；Rust 使用 rustup 管理。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
cargo test --workspace
```

源码注释和函数说明使用英文，使用文档与实施报告使用中文。每项任务分别记录实现状态、编译验证和实机验收。

## 执行引擎

| 引擎       | 观察                | 输入            | 验证目标                  |
| ---------- | ------------------- | --------------- | ------------------------- |
| Compatible | 官方 Playwright     | 官方 Playwright | 原有 API 语义与页面功能   |
| GUI        | 系统无障碍与截图    | 系统鼠标键盘    | 同平台 GUI 事件和页面状态 |
| Native     | Chromium 只读观察桥 | 复用系统输入    | 浏览器集成与功能回归      |

Windows 是当前实机验证平台。macOS、Linux X11 和 Wayland 使用独立能力检测与验收记录。Chromium 构建工作目录由配置指定，并采用无空格路径。
