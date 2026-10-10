# TASK-004 策略与授权

- Goal：实现有效域名范围、Profile 归属、上传边界和用户审批。
- Changes：严格配置校验、精确 Origin 匹配、会话范围收窄、临时 Profile 清理、上传重定向拒绝及审批状态绑定。
- Tests run：`corepack pnpm typecheck`、`corepack pnpm lint` 已通过；`corepack pnpm test:unit` 共 9 项通过，包含 5 项 Origin、目录、上传、审批及重复请求测试。
- Tests blocked：可信审批 UI 与平台 IPC 权限将在后续任务验证。
- Known issues：通用点击的业务敏感性需要配置可信目标规则；明确文件上传始终触发审批。
- Contract changes：增加 currentUrl、取消和生命周期钩子；审批结果返回独立 approvalId。
- ADR references：ADR-0001；MCP 提供只读审批状态查询。
- Next task：TASK-005 FakeEngine 端到端支持。
