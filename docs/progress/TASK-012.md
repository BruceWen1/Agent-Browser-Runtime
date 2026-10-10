# TASK-012 Windows 桌面后端

## 实现状态

Windows 后端已实现窗口枚举、可信启动 PID 与 HWND 绑定、进程句柄生命周期校验、只读 UI Automation 树、前台焦点验证和 Windows Graphics Capture 截图。所有 UIA 节点使用物理屏幕坐标，受保护控件移除名称、值及后代节点。截图通过 D3D11 staging texture 在内存读取，敏感控件矩形在 PNG 编码和 IPC 传输之前覆盖为黑色。

系统输入使用 SendInput，提供鼠标点击、双击、移动、滚轮、拖动、扫描码按键和 Unicode 文本提交。命名 mutex 在当前 Windows 登录会话内串行化输入。低层键盘及鼠标 hooks 记录外部输入计数，自有输入使用非零 32 位标识。每个输入批次重新验证窗口归属、前台状态、取消代次和操作期限。部分插入失败仅释放已插入的自有按下记录，拖动始终释放自有鼠标按下状态。

文件选择器限于浏览器 PID 所有、通过 owner 链关联的原生公共对话框。只读 UIA 定位文件名输入框后，系统点击、Ctrl+A、Unicode 输入及 Enter 完成路径提交，并验证对话框关闭。该路径仍需实体桌面 fixture 验收。

当前地址优先读取顶层 RootWebArea 的只读文档 value 元数据。地址栏备用路径要求完整协议；已聚焦且处于编辑状态的地址栏承担初始 about:blank 观察。网页文档内部的工具栏和文本框与浏览器地址栏权限分离。浏览器文件版本通过 PE 版本资源读取。

浏览器 CSS zoom 与设备像素比保留显式测量状态：`geometry.viewportMetricsVerified=false`。后端验证 monitorScale 和物理窗口几何，viewport CSS 坐标转换由上层能力检查约束。IME composition 返回明确的 unsupported 状态。

## 已执行验证

- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo test --workspace`：最新 7 项通过，包含 3 项 IPC 测试、3 项 Windows 后端测试和 1 项独立控制服务 bootstrap 测试。
- Windows 测试覆盖 PNG 编码后的遮罩边界、Unicode surrogate pair 的成对释放记录，以及不完整地址的策略拒绝。
- `cargo build --workspace`：Windows x64 编译通过。
- `target/debug/abr-desktop-agent.exe --doctor`：实际系统报告 UIA、Windows Graphics Capture 和输入 hooks 可用；输入权限遵守 Windows UIPI，IME composition unavailable。

## 实体桌面验证状态

已在获得桌面空闲授权后执行 `$env:ABR_GUI_E2E='1'; corepack.cmd pnpm exec vitest run tests/e2e/gui/windows.test.ts`，1 项通过，耗时 7.45 秒。验证范围为浏览器导航、只读 AX 定位、系统点击触发 counter=1、文本框聚焦、auto 策略返回 os-unicode、输入值精确保持 `ABR native`、Windows Graphics Capture PNG 获取，以及关闭浏览器后的独立 profile 清理。实体环境为单显示器，实际 AX monitorScale=2.0。

后续代码加入原子导航、Chrome tab selected/browser-tab 元数据和独立 URL 发现。原子导航在同一系统输入 lease 内完成 Control+L、Unicode URL 提交和 Enter；公开 AX 隐私过滤独立于可信 URL 读取，默认敏感名称提示作用于输入及标签角色。上述增量已通过编译与单元测试，实体 GUI 扩展用例由独立测试协调执行。

会话绑定保留原始浏览器进程的 query、synchronize 和 terminate 权限句柄，内部 closeProcess 操作仅终止该原始句柄指向的进程，并在最多 5 秒内等待 kernel-ended 确认。原始进程已结束时返回幂等确认。只读窗口枚举使用 query 权限，清理范围由既有会话绑定限定。

物理键盘文本实验同时确认当前输入法将 Space 作为 composition 提交操作。后端在 keyboard 策略发现 IME 打开或 CJK 输入上下文状态未验证时，在文本输入之前返回 UNSUPPORTED_CAPABILITY。auto 策略采用可审计的 os-unicode 文本提交。doctor 返回 keyboard layout、languageId、openStatus 及其验证状态，所有读取均保留现有输入法和系统键盘布局。

外部输入与焦点变化的真实运行返回 DESKTOP_BUSY 和 FOCUS_LOST，正常 GUI fixture 使用自有输入标识通过验证。UIA 树遍历分别校验原始 COM HRESULT 和返回接口指针，成功的空关系表示正常叶节点，provider 错误中止观察。

最新实体回归于 2026-10-10 完成，1 项通过，耗时 6.31 秒。实际覆盖原子系统导航、只读 AX、单次按钮点击的 counter=1、auto 文本的 os-unicode 策略与完整空格保持、WGC PNG、原始进程句柄关闭和 profile 清理。此次运行使用最终关闭与输入保护实现。

中文 Unicode 文本、文件选择器、截图敏感矩形像素检查、多显示器、125% DPI 专项、IME composition，以及用户抢占后的完整恢复分别保留独立验收状态。编译、单元测试与已完成的实体 GUI 主路径分别记录。
