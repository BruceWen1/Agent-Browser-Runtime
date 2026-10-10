# TASK-017 生产 GUI 与 MCP

生产应用在检测到本地 DesktopAgent 后注册 GUI 适配器。MCP 的 21 个工具共用已验证的 Runtime、Policy 与 ArtifactStore，GUI 的输入结果使用 executionPath=os-input，观察源使用 os-accessibility。

Windows 支持 read-only AX/当前 URL、masked WGC PNG、鼠标、按键、Unicode 文本、浏览器导航、Chrome 标签和受控文件选择。GUI 标签的 inactive URL 在观测缺失时保持可选字段。页面文档内的 ARIA tab 由浏览器标签管理排除，目标由 Chrome-only 状态与当前窗口复核。

GUI/Native 会话在独立 Windows 控制窗口 ready 后进入输入就绪状态；控制初始化失败会关闭已经分配的浏览器。Resume 由真实 UI 按钮向该会话 Agent PID 定向授权前台资格。审批仅通过独立本地 UI 收集决定，MCP 提供只读状态。

TypeScript、lint、真实跨语言 IPC、GUI 主路径和共享 MCP 契约已验证。完整生产 MCP GUI 主路径于 2026-10-11 在授权的桌面空闲时段通过实体回归；文件选择与独立 UI 手动决策、热键等物理场景保留独立验收状态。

执行 `$env:ABR_GUI_E2E='1'; corepack pnpm exec vitest run tests/e2e/gui/windows.test.ts tests/e2e/gui/windows-mcp.test.ts`，2 项通过，总计 25.11 秒。生产 MCP 用例使用实际 CLI `mcp serve --stdio`、官方 MCP Client 2.3.1 和隔离本地配置，以 engine=gui 创建真实浏览器。导航、AX 点击、文本框聚焦与文本提交返回 os-input，观察源为 os-accessibility，输入结果为 os-unicode；当前 URL 与受控 query 保持一致，Query 值精确保持提交文本，按钮实际计数为 1。

masked PNG 与受控 artifact read 通过标准 PNG header 检查；stdio 消息均为合法 JSON-RPC 2.0，protocol error 计数为 0。stderr 排除输入文本、fixture 敏感值及 URL query canary。会话关闭后状态为 closed、ephemeral profile 目录为空，控制和 MCP 进程完成清理。此结果表示生产 GUI/MCP 自动化实体主路径验收，人工审批决策和人工事件基线保持独立。
