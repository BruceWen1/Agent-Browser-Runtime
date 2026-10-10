# TASK-018 本地自有事件 fixture

需求映射：RPD-028、RPD-024、RPD-029。实现 `packages/test-fixtures` 的 loopback HTTP 服务和只读浏览器事件导出，覆盖 23 个独立场景。

Recorder 保存 capture/bubble、Pointer/Mouse/Wheel、Keyboard、BeforeInput/Input、Composition、Focus/Blur、Selection、可见性、导航生命周期与 DOM mutation 的安全摘要。事件来自浏览器实际派发路径，可信状态和用户激活以浏览器当前属性记录。公有输入最终状态保存 SHA-256；敏感控件值、摘要、字符、选择偏移与文件名排除于 trace。记录达到配额时置位 `truncated`，比较器将该组标记为无效。

本地 API：`startEventFixture()` 提供 origin、命名 URL 和显式 close；页面 `window.abrFixture.exportTrace()` 提供复制的 trace。页面导出按钮下载 candidate 记录。服务拒绝未登记路由和修改方法，页面资源限于同一自有 loopback origin。

验证结果：`corepack pnpm --filter @abr/test-fixtures build`、针对本包与 `tests/parity` 的 ESLint、`tsc -p tsconfig.tests.json --noEmit` 通过。`corepack pnpm exec vitest run --config vitest.config.ts tests/parity` 通过全部 recorder、HTTP、comparator 和 baseline 测试。Windows 的真实 headed 官方 Chromium 验证点击的 trusted/activation、Pointer/capture/bubble、输入隐私、shadow DOM 和 iframe。该验证保存 Compatible provenance，人工 GUI/OS-input 对照仍需独立平台基线。

人工输入法、权限弹窗、BFCache、触摸、下载和文件选择对照需要具备对应平台输入配置和操作者。当前单元/浏览器 recorder 测试覆盖 HTTP 边界、点击事件、键盘输入隐私、shadow DOM 与 iframe 采集。
