# TASK-006 MCP stdio

- Goal：通过官方 MCP SDK v2 提供完整工具目录与核心调用。
- Changes：21 个工具注册、输入校验、操作调度、语义等待、结构化结果、错误归类及连接关闭清理。
- Tests run：`corepack pnpm typecheck`、`corepack pnpm lint` 已通过；真实 SDK 客户端 stdio 集成测试已通过，验证 21 个工具、完整会话调用、重复请求、语义等待、域名拒绝、非法字段和诊断通道隔离。
- Inspector：官方 Inspector 2.10.1 的 CLI 已通过配置模式列出全部 21 个工具，输出保存于运行时测试缓存。
- Tests blocked：截图存储与导出依赖 TASK-007；生产后端依赖对应引擎任务。
- Known issues：区域截图暂通过明确能力错误报告，待截图后端补齐。
- Contract changes：保持公共工具名称和严格输入边界；提供结构化 MCP 结果。
- ADR references：官方 stdio factory、协议 stdout 与诊断 stderr 分离。
- Next task：TASK-007 受控产物存储。

坐标语义授权增量：Core 在当前允许的 origin 上通过独立 inspectionSnapshot 读取完整私有观察，对坐标和两个 drag endpoint 按共享 bounds/scale/geometry 解析可见语义链。未知、受保护、不同分支重叠或检查能力缺失提供明确失败。已有 AX 引用继续使用原 caller snapshot；busy 状态读取使用独立 inspection，保留 Core 和 adapter 的引用缓存。

PolicyEngine 对操作的全部语义目标统一分类与审批。批准绑定 input digest、当前 URL、source/window/tab、node ID/role/name/bounds 和风险类别，字段 value 及临时 focused/hovered 状态排除于 fingerprint。input digest 继续索引最新 ticket，维持审批后重试和 exactly-once；相同坐标的 Delete 目标换成 Payment 时要求新的 ticket。

Adapter execute 使用独立内部 inspection witness 在输入前复核语义，公共 MCP action schema 保持原有字段。GUI/Native 使用无缓存的 snapshot builder；Compatible 使用独立官方只读 CDP AX/DOM/layout channel，保持 injected ARIA 引用缓存。

实际增量验证：`corepack.cmd pnpm typecheck` 通过；`corepack.cmd pnpm exec vitest run tests/unit tests/contracts tests/integration/mcp/stdio.test.ts` 的 16 个文件、53 个测试通过。新场景验证 coordinate Delete 审批、已批准 Delete 到 Payment 的票据更新与后端零执行、配置型 mixed drag 审批、原 AX cache/busy read 保持、执行前漂移拒绝、effective DPR 单次转换和明确 unknown/ambiguous 状态。该阶段使用明确 doubles 与真实 Core/Policy，实体 GUI 和实际 Compatible inspection 回归另行记录。
