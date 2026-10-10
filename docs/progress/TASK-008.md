# TASK-008 CLI 与运行时装配

- Goal：提供配置初始化、诊断、版本、契约检查和 MCP 启动命令。
- Changes：生产装配、严格命令参数、配置独占创建、机器可读诊断和关键步骤耗时。
- Tests run：TypeScript、lint 和 17 项单测已通过；CLI 进程测试验证 JSON 诊断、21 工具契约检查、可移植配置生成及已有文件保护。
- Tests blocked：实际引擎能力随后端注册更新；跨进程会话命令依赖 RuntimeHost IPC。
- Known issues：生产入口通过已注册后端提供能力，测试引擎使用独立测试入口。
- Contract changes：默认配置增加明确的动作超时和可信敏感目标规则。
- ADR references：协议通道与诊断通道分离。
- Next task：TASK-009 官方 Playwright Worker。
