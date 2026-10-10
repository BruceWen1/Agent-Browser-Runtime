# TASK-010 Compatible 端到端集成

- Goal：通过生产 CLI/MCP 入口控制实际官方浏览器。
- Changes：生产注册 CompatibleEngine、受控 Profile、策略、当前 URL 校验、截图归属与输入结果溯源。
- Tests run：两项有界面浏览器 E2E 均通过，产品入口验证真实输入、页面结果、PNG、域名拒绝和 Profile 清理。TypeScript、lint、17 项单测、4 项契约测试及真实 MCP 集成测试通过。
- Tests blocked：macOS/Linux 对应浏览器组合等待实机验证。
- Known issues：Compatible 采用官方 Playwright 语义，输入及程序化文件设置分别记录执行路径。
- Contract changes：生产装配启用 compatible；GUI 和 Native 由后续后端注册。
- ADR references：进程隔离和明确引擎身份。
- Next task：TASK-011 受保护本地 IPC 与 Rust Agent。
