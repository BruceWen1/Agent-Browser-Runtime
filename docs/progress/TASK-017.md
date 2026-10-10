# TASK-017 生产 GUI 与 MCP

生产应用在检测到本地 DesktopAgent 后注册 GUI 适配器。MCP 的 21 个工具共用已验证的 Runtime、Policy 与 ArtifactStore，GUI 的输入结果使用 executionPath=os-input，观察源使用 os-accessibility。

Windows 支持 read-only AX/当前 URL、masked WGC PNG、鼠标、按键、Unicode 文本、浏览器导航、Chrome 标签和受控文件选择。GUI 标签的 inactive URL 在观测缺失时保持可选字段。页面文档内的 ARIA tab 由浏览器标签管理排除，目标由 Chrome-only 状态与当前窗口复核。

GUI/Native 会话在独立 Windows 控制窗口 ready 后进入输入就绪状态；控制初始化失败会关闭已经分配的浏览器。Resume 由真实 UI 按钮向该会话 Agent PID 定向授权前台资格。审批仅通过独立本地 UI 收集决定，MCP 提供只读状态。

TypeScript、lint、真实跨语言 IPC、GUI 主路径和共享 MCP 契约已验证。完整生产 MCP GUI 回归等待当前桌面空闲时段；文件选择与独立 UI 手动决策、热键等物理场景保留独立验收状态。
