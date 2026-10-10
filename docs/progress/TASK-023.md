# TASK-023 NativeEngine 观察与系统输入适配

需求映射：RPD-012、RPD-006、RPD-007、RPD-009、RPD-030。

## 实现状态

NativeEngine 使用独立 Chromium 观察通道读取窗口、稳定标签 ID、已提交 URL、浏览器 AX 缓存及实测 viewport。会话选择要求 `custom-chromium`。启动元数据与握手验证精确 browser commit、browser version、profile ID、协议版本和受监督进程 PID；启动并发由独立创建状态约束，失败路径关闭本次创建的观察通道及会话资源。

浏览器观察保持只读接口。指针、键盘、文本、导航、文件对话框及截图复用 GuiEngine 与 DesktopAgent 的窗口 ownership、前台焦点、独占、取消、deadline 和隐私处理。操作结果使用 `executionPath=os-input`；公开页面快照使用 `source=chromium-accessibility`。

稳定标签切换先读取指定 browser window 的 authoritative listTabs，再将该列表与独立系统观察中的 Chrome 标签栏控件对应。映射要求唯一 browser window 与精确 OS window identity、唯一稳定 ID、唯一非空标题、标签数量和顺序一致、标题 Unicode canonical identity 一致，以及 selected 状态与浏览器 active 状态一致。网页 document 后代的 tab role 保留在页面观察中，浏览器标签映射仅遍历 document 外的 `browser-tab` 控件。

物理目标必须具有可见的 screen-physical 边界，完整位于绑定窗口内。标签中心须避开其他标签矩形及标签内部按钮。重复标题、窗口映射歧义、标签顺序或 selected 差异分别提供显式 unsupported 状态；不可见及窗口外目标提供 TARGET_OCCLUDED。live capability 查询根据当前映射返回 browser.tabs 支持状态与具体 unavailable reason。

切换将稳定 ID 转换成一次物理坐标 click，保留 requestId、sessionId 和共有 OS 输入路径。AsyncLocalStorage 将本次校验限定在对应执行上下文；GuiEngine 获得共享输入所有权后，其首次 Native.observe 在返回前再次读取 browser windows、tabs 和 OS Chrome 控件，并核验完整映射及几何指纹。指纹变化或 deadline 到达会在输入前失败。系统观察树仅用于浏览器 Chrome 输入定位，公开 snapshot 保持 Chromium AX 来源。

完成单次 click 后，只读轮询浏览器 authoritative active ID，并生成目标标签的 Native AX 快照。轮询覆盖异步激活发布；取消、标签关闭或 deadline 到达提供明确失败。物理输入完成后，整个确认阶段仅执行读取。

## 已执行验证

- `corepack.cmd pnpm typecheck`：workspace TypeScript 构建与 tests 类型检查通过。
- `corepack.cmd pnpm exec vitest run tests/unit/native.test.ts tests/unit/native-tabs.test.ts tests/unit/geometry.test.ts`：3 个文件、9 个测试通过。
- 新增 Native 标签单元场景覆盖单次 OS 调用及 Native 公开快照、重复标题和顺序歧义、外部或重复 HWND、selected 差异、隐藏或窗口外控件、重叠目标及内部关闭按钮、网页伪造 tab role、输入前布局变更、激活发布延迟、deadline、取消、目标关闭及 live capability 状态。
- `corepack.cmd pnpm exec eslint packages/native-ipc-client/src/native-engine.ts tests/unit/native-tabs.test.ts`：通过。
- `corepack.cmd pnpm exec prettier --check packages/native-ipc-client/src/native-engine.ts tests/unit/native-tabs.test.ts docs/progress/TASK-023.md`：通过。
- `git diff --check`：通过。

单元场景使用明确的内存 observer 与 desktop channel doubles，执行实际 NativeEngine 及继承的 GuiEngine dispatch。该证据覆盖接口映射与拒绝边界，实体浏览器及系统输入状态独立记录。

## 待执行验证

锁定 Chromium 的 C++ 编译、观察协议真实 smoke、Native 会话 MCP 闭环、真实稳定标签 ID 切换、同版本原版与补丁浏览器的 GUI 回归尚待编译产物和实际运行证据。现有 Windows GUI 实机证据与 Native 实机验证分别记录。

macOS 和 Linux 的 browser-to-OS 窗口映射与实体桌面输入保留独立验收状态。原生窗口映射未验证的平台通过明确 capability 状态限制 Native 标签切换。订阅型观察推送保持独立实现状态。
