# 本地事件记录与差异报告

服务仅绑定 `127.0.0.1`，提供点击、双击、复选框、英文输入、系统输入法、文本区、原生选择、日期时间、文件选择、拖放、嵌套滚动、iframe、shadow DOM、弹窗激活、标签可见性、导航、剪贴板、下载、上传确认、焦点导航、触摸、延迟布局和敏感字段场景。

```powershell
corepack pnpm --filter @abr/test-fixtures build
corepack pnpm --filter @abr/test-fixtures fixture
```

浏览器访问命令输出的本地地址。人工操作结束后选择 `Export candidate recording` 导出 JSON。程序化测试使用 `window.abrFixture.exportTrace()` 读取复制的观察结果。这个页面 API 只提供读取；Recorder 按实际浏览器事件采集 `isTrusted`、User Activation、capture/bubble、Pointer、Keyboard、Input、Composition、Focus、Selection、可见性、导航和安全 DOM mutation 摘要。

普通输入的最终内容以 SHA-256 摘要保存，事件字符以结构信息保存。密码、信用卡和声明为敏感的控件排除值、摘要、选择偏移及字符详情。文件选择控件排除文件名和文件内容。Trace 包含配额截断标志。上传确认在页面内保存布尔状态。

元数据通过 `serve metadata.json` 参数提供，JSON 格式如下。系统版本和架构从运行设备读取；浏览器 commit、窗口系统、键盘布局、输入法、DPI、Profile 标识、权限和标签数需由实际测试环境填入。

```json
{
  "engine": "manual",
  "environment": {
    "browserCommit": "实际验证的 40 位 Chromium commit",
    "windowSystem": "win32",
    "keyboardLayout": "实际键盘布局",
    "ime": "实际系统输入法",
    "monitorDpi": 120,
    "profileId": "独立测试 Profile 标识",
    "initialState": {
      "cookieStorageHash": "由 recorder 自动记录",
      "viewportWidth": 0,
      "viewportHeight": 0,
      "permissions": "实际初始权限",
      "focused": true,
      "tabCount": 1
    }
  }
}
```

Recorder 自动记录初始视口、焦点与初始 Cookie/localStorage 摘要。未知浏览器 commit、DPI、输入法或其他固定元数据使报告状态为 `invalid-fixture`。单个场景的人工和引擎轨迹应使用相同构建、平台、布局、权限、窗口状态与初始存储。

```powershell
node packages/test-fixtures/dist/main.js candidate actual-trace.json candidate.json
node packages/test-fixtures/dist/main.js compare baseline-trace.json actual-trace.json reports/run-001
node packages/test-fixtures/dist/main.js review manual-candidate.json approved-baseline.json
node packages/test-fixtures/dist/main.js compare-approved approved-baseline.json actual-trace.json reports/run-002
```

`candidate` 对任意引擎记录建立候选文件。`review` 要求独立本地交互终端、人工 GUI provenance、完整元数据、审核者姓名，以及包含完整 trace SHA-256 的明确确认。审核结果保存至新的文件。候选写入、已审核文件和报告均使用独占创建，已有产物保持原样。自动化录制和测试失败保持 candidate 状态。

比较结果为 `identical`、`accepted-diff`、`unexpected-diff`、`unsupported` 或 `invalid-fixture`。时间偏移按相对首个事件归一化，默认耗时容差 1000 ms，CSS 坐标容差 2 px。`isTrusted`、User Activation、事件顺序、Composition、Focus、Selection 与最终公有控件摘要严格比较。Pointer 连续采样压缩可显式开启，保留可信、焦点、激活与目标的任何变化。报告保存 JSON、已转义的离线 HTML、两份源 trace 与版本 manifest。

测试命令：

```powershell
corepack pnpm exec vitest run --config vitest.config.ts tests/parity
```

其中 browser 测试通过锁定的官方 Playwright 启动真实 headed Chromium，验证 Compatible 事件记录。人工 GUI 基线、系统输入法和 OS-input 对照依赖真实操作者与平台输入配置，其验收状态单独记录。
