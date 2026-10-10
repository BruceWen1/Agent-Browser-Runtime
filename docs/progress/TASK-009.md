# TASK-009 官方 Playwright Worker

- Goal：隔离官方 Playwright 的启动、页面、上下文和关闭生命周期。
- Changes：受保护 fork IPC、惰性进程、匹配浏览器、持久上下文、官方 AX JSON 快照和受控截图分块传输。
- Tests run：TypeScript 检查通过；有界面 Chrome for Testing 156.0.8078.4 在受控 fork Worker 中完成导航、AX 观察、真实按钮激活结果检查、PNG 截图及关闭。
- Tests blocked：macOS/Linux 实机运行等待对应机器。
- Known issues：Compatible 指针坐标使用 viewport-css；其他坐标空间明确报告能力不足。
- Contract changes：Worker 使用共享 IPC 信封，保留官方浏览器 API 语义。
- ADR references：worker 与 Core 分离、默认独立 Profile。
- Next task：TASK-010 Compatible 与运行时的集成验收。

独立语义检查增量采用官方 CDPSession 的 Accessibility、DOM 和 Page 只读接口。AX node ID、DOM border quad、CSS viewport 与实际两轴 pixel ratio/zoom 来自浏览器协议；before/after FrameTree、URL 和 layout 必须保持一致。inspection 保留 caller snapshotId、locator map 和 injected ARIA reference cache。坐标支持已验证的单 frame、axis-aligned、正常 visual viewport CSS 范围；其他空间或不完整几何提供明确状态。

execute 接收私有 inspection witness，复核坐标语义后通过原官方输入路径执行。mixed drag 的 AX endpoint 使用原 caller locator，coordinate endpoint 使用独立 CSS 几何；目标在 drop 前再次确认，异常释放鼠标并取消拖动状态。公共 action envelope 保持严格字段。

6 个 browser-free unit 场景验证独立缓存、只读 CDP metrics、geometry/frames 失败边界、privacy、预输入语义漂移和 mixed drag 释放。main-world evaluate、page title 与 ARIA snapshot 在这些 doubles 中显式拒绝调用。TypeScript 与所属 lint/format 通过；完整非桌面检查共 53 项通过。GUI parity 保留独立执行状态。

实际浏览器增量验收：`corepack pnpm exec vitest run tests/e2e/compatible/inspection.test.ts` 在官方 Chrome for Testing 156.0.8078.4 的 headless 模式通过，1 项测试、4.30 秒。独立 CDP inspection 保留原官方 ARIA 引用，后续 AX 点击与坐标点击分别产生计数 1 和 2；配置为敏感目标的 Query 坐标点击返回 approval-required，焦点保持在 Activate，审批状态为 pending。该场景通过真实 worker、Core 和策略执行，完成后确认 ephemeral profile 释放；运行过程保持桌面焦点。完成输入后的新操作采用重新观察获得的引用。
