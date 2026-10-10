# TASK-024 独立 A1/A2 差异研究

需求映射：RPD-013、RPD-028、RPD-029。实现默认关闭的研究 flags、官方发布包静态证据、候选 trace A1 分析及有界 A2 GUI adapter prototype。

实际检视官方 Playwright 1.64.0 的发布包 `lib/coreBundle.js`，记录完整 SHA-256、Input.dispatchMouseEvent/dispatchKeyEvent/insertText、DOM.setFileInputFiles 和 DOM option selection 的实际代码位置。协议命令与 DOM/context 路径形成显式研究矩阵，source-evidence.json 为真实静态产物。

A1 在显式独立 flags 下对自有 loopback trace 运行已实现的严格 comparator，固定环境与人工基线 gate 保留。当前 patchProposals/securityBehaviorChanges 为空。A2 对无按钮/无修饰键 pointer move 和有界 text submission 生成 Core 动作；显式核验 GUI 会话/窗口及当前 fixture URL，并通过现有受保护 adapter 执行。成功要求真实 os-input provenance，实际 strategy 从结果记录；其事件/Composition/IME 等价性保持待实测状态。

独立 mouse/key down/up 的 CDP callback 需要 native split-transition API，当前原子 click/key API 对这些情况显式 unsupported。Evaluate、option assignment、文件赋值、网络 route 与 Context permission 维持其已有 Compatible 语义。研究入口与生产引擎注册保持独立，默认 flags 均为 false。

验证：`node experiments/research.mjs evidence --output <new-relative-artifact>` 已生成静态证据；`node --test chromium/build/pipeline.test.mjs experiments/research.test.mjs` 的 5 个场景通过，ESLint/Prettier 通过。Synthetic adapter 测试仅用于边界与 fallback 拒绝验证，当前未声称真实 A2 输入或人工 GUI parity 通过。

下一阶段证据包括同 commit 的原版人工/官方 Playwright/补丁人工/补丁自动化四组 trace、三个平台真实 OS-input 与实际 IME、callback 时序、安全影响审核及每条有界 patch 的回滚记录。
