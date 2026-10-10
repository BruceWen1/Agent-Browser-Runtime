# TASK-005 确定性测试引擎

- Goal：支持无浏览器、无桌面的运行时端到端测试。
- Changes：显式 testing 入口、内存会话、可访问树、导航/输入状态、目标引用和可选截图存储。
- Tests run：`corepack pnpm typecheck`、`corepack pnpm lint` 和 `corepack pnpm test:unit` 已通过；当前共 10 项单测，新增的完整工作流涵盖授权导航、观察、点击、输入、旧快照、拒绝域名及 IME 能力拒绝。
- Tests blocked：本引擎用于契约测试，桌面与浏览器实机验证由对应后端完成。
- Known issues：所有结果明确标记 fake-test-only 和 not-executed。
- Contract changes：生产配置继续保留三种引擎；测试引擎通过显式注入提供。
- ADR references：测试适配器与生产装配分离。
- Next task：TASK-006 MCP stdio。
