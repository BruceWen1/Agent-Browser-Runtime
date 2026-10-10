# TASK-006 MCP stdio

- Goal：通过官方 MCP SDK v2 提供完整工具目录与核心调用。
- Changes：21 个工具注册、输入校验、操作调度、语义等待、结构化结果、错误归类及连接关闭清理。
- Tests run：`corepack pnpm typecheck`、`corepack pnpm lint` 已通过；真实 SDK 客户端 stdio 集成测试已通过，验证 21 个工具、完整会话调用、重复请求、语义等待、域名拒绝、非法字段和诊断通道隔离。
- Tests blocked：截图存储与导出依赖 TASK-007；生产后端依赖对应引擎任务。
- Known issues：区域截图暂通过明确能力错误报告，待截图后端补齐。
- Contract changes：保持公共工具名称和严格输入边界；提供结构化 MCP 结果。
- ADR references：官方 stdio factory、协议 stdout 与诊断 stderr 分离。
- Next task：TASK-007 受控产物存储。
