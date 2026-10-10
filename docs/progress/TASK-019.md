# TASK-019 Trace 比较器、报告与基线审核

需求映射：RPD-028、RPD-027、RPD-029。实现五态事件差异比较器、离线 HTML/JSON 报告、版本证据和独立本地终端基线审核。

比较固定 OS/架构/窗口系统、键盘布局、IME、DPI、Chromium commit、fixture 版本、ABR 版本与初始存储/权限/焦点/视口/标签数。元数据缺失、跨组配置或截断录制返回 `invalid-fixture`。序列比较严格保留事件顺序、可信属性、User Activation、Composition、Focus、Selection 和最终控件摘要；时间偏移与 CSS 坐标使用显式容差。连续 Pointer motion 压缩为可选归一化项，任何安全语义变化保留。

报告输出 `parity-report.json`、`parity-report.html`、baseline/actual trace 和 version manifest。HTML 字段全部转义，脚本和网络连接由 CSP 限制。产物采用独占写入，已有报告和 baseline 保持原样。

`candidate` 创建未批准产物。`review` 仅接受完整人工 GUI candidate，要求真实 TTY、审核者、绑定完整 trace SHA-256 的明确确认。`compare-approved` 验证审核 receipt 与 trace 的 digest 一致性后标记人工基线已批准。普通比较始终标记 candidate；生成记录、程序化测试和失败记录均保持未批准状态。

验证结果：本包 build、ESLint、测试类型检查通过；`corepack pnpm exec vitest run --config vitest.config.ts tests/parity` 的单元和 headed browser 场景通过。单元测试涵盖缺失按键、Composition 顺序、trusted/activation 差异、耗时/几何容差、Pointer 采样归一化的可信语义保留、初始焦点/IME 漂移、unknown commit、截断、不可用能力、候选隔离、人工审核终端要求、摘要篡改和 HTML 注入。Synthetic receipt 仅用于篡改验证，保持隔离测试证据。

当前自动化测试验证比较逻辑与 recorder 功能。跨平台人工对照和 100 次/平台可靠性验收需实际平台数据，其结果依独立已审核 trace 更新。
