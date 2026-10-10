# TASK-002 契约与运行时校验

- Goal：统一 TS、JSON Schema、MCP 输入和 IPC 信封的运行时验证。
- Changes：AJV 2020-12 校验、Zod 适配、动作参数边界、会话模式约束、类型化错误及 IPC 响应互斥验证。
- Tests run：`corepack pnpm typecheck` 已通过；`corepack pnpm test:contracts` 的 4 项测试已通过，涵盖全部 21 个工具、原始样例、非法联合字段及 IPC 响应互斥。
- Tests blocked：Rust IPC 消息往返验证在 TASK-011 实现后补齐。
- Known issues：MCP Schema 转换接口已固定版本，并加入全部工具的接受与拒绝验证。
- Contract changes：ActionResult 增加 approvalId、actualStrategy；BrowserSnapshot 增加 url、tabs、geometry。
- ADR references：ADR-0001。
- Next task：TASK-003 会话状态机和引擎注册。
