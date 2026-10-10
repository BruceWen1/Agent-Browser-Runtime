# TASK-001 工程与工具链

- Goal：建立 pnpm/TypeScript、Rust 工程和跨平台 CI 基础。
- Changes：统一版本、编译选项、lint、测试入口、包边界检查与 Native Agent 入口。
- Tests run：`corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm test` 已通过。Vitest 当前报告 0 个测试文件，属于骨架验证；功能测试随后续任务加入。
- Tests blocked：macOS/Linux CI 需远程 runner 执行；本阶段尚无产品功能测试。
- Known issues：工程骨架验证与浏览器实机功能验证分别记录。
- Contract changes：保留实施包提供的类型及数据契约。
- ADR references：初始版本与注释语言已由用户确定。
- Next task：TASK-002 契约与运行时校验。
