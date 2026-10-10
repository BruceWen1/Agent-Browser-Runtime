# TASK-003 会话与引擎管理

- Goal：实现会话状态、引擎选择、资源限额及幂等动作调度。
- Changes：EngineRegistry、Runtime、创建配额、不可变元数据、输入所有权、超时及幂等关闭。
- Tests run：`corepack pnpm typecheck` 和 `corepack pnpm test:unit` 已通过；4 项测试涵盖幂等请求、创建限额、并发关闭、暂停/恢复、旧快照和输入所有权竞争。
- Tests blocked：浏览器进程与 GUI 输入清理在后端任务中实测。
- Known issues：所有生产入口必须注入 PolicyEngine；测试授权对象仅存在于测试目录。
- Contract changes：BrowserEngine 增加 currentUrl 和可选 cancel，用于即时域名验证及超时中止。
- ADR references：执行后端保持单一引擎身份。
- Next task：TASK-004 策略、路径与审批。
