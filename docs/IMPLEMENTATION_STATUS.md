# 实施进度

基线日期为 2026-10-11。共享运行时、官方 Compatible、原生桌面后端、GUI/Native 适配器、事件比较、独立控制与审批、构建和发布工具已建立。实现、编译、物理交互验收与生产发布分别记录。

| 范围 | 实现与验证 | 当前验收范围 |
| --- | --- | --- |
| TASK-001 至 008 | 工程、闭合契约、会话、策略、Fake 测试适配器、MCP、产物和 CLI | 真实 stdio 与 Inspector 21 工具目录已验证 |
| TASK-009 至 010 | 官方 Playwright 1.64.0 原样集成，Chrome for Testing 156.0.8078.4 | Windows 两项 headed Compatible E2E 已通过；独立 CDP、引用缓存与坐标审批的实际 headless 回归通过 |
| TASK-011 | 4 MiB 分帧、继承启动密钥、双向 HMAC v2、当前用户 IPC、并发关联和断线取消 | Windows Rust/Node 真实认证 IPC 已通过；替换端点拒绝已验证；Unix 权限实机待验收 |
| TASK-012 | Windows UIA、WGC、SendInput、原子导航、IME 策略、原始进程句柄关闭 | 单屏当前 DPI 的 GUI 主流程、中文 Unicode 输入和敏感字段遮罩像素检查通过；125% DPI、多屏、手工 IME、文件选择验收待执行 |
| TASK-013 至 014 | macOS AX/Quartz/SCK、Linux AT-SPI/X11/XTest/XInput2 | Linux Rust 跨目标检查通过；macOS Rust 检查通过，Swift/系统链接和两平台实机待验收 |
| TASK-015 | Wayland Portal 能力发现和显式权限/不可用结果 | 授权流与窗口绑定的 EIS 输入通道待实施 |
| TASK-016 至 017 | GUI 目标、空间转换、坐标语义授权、审批目标绑定、独立引用缓存、输入独占和生产 MCP 注册 | 58 项非桌面检查通过；最新两项 Windows GUI 实测通过，覆盖中文、遮罩、生产 MCP 系统输入、协议与诊断隐私及 profile 清理；扩展场景继续验收 |
| TASK-018 至 019 | 23 个自有 fixture、真实事件记录、严格比较、候选基线与人工审核 | 7 项 fixture/parity 测试通过；人工轨迹基线保持待审核 |
| TASK-020 | Windows 独立审批进程、Pause/Resume/Stop 控制窗口与定向前台授权 | 协议/编译测试通过；实际按钮、热键和其他平台 UI 待人工验收 |
| TASK-021 | 完整上游 SHA、DEPS、depot_tools、工具链、恢复/同步/补丁/构建管线 | Windows 工具链、156 个 Git scope、89 项 CIPD、同步和 hooks 通过；原版全量编译及同版本 Playwright headless smoke 通过，定制版以 2 jobs 继续编译 |
| TASK-022 至 023 | 浏览器层只读 C++ Bridge、可回放 patch、版本认证与 Native OS 输入适配器 | Windows HWND 映射、patch 应用及 GN、生产 C++ 编译单元语法与适配器单元测试通过；定制版完整编译链接、Native 实机/MCP 以及 Unix 原生窗口映射待完成 |
| TASK-024 | A1/A2 独立证据、研究工具与默认关闭的实验边界 | 静态证据和边界测试通过；完整同版本 A/B/C/D 物理轨迹继续验收 |
| TASK-025 | 版本清单、真实 SBOM、ZIP、校验、签名门禁、安装/升级/回滚 | 完整 Windows 开发包已隔离安装验证；正式签名、公证和三平台生产基线待提供 |

生产启动仅注册实际存在的适配器。Native 需要用户显式启用、自定义 Chromium 可执行文件及匹配的私有只读握手；版本或权限不匹配返回稳定错误。GUI 文本返回实际 `os-keyboard` 或 `os-unicode` 策略，IME 组合使用独立能力门禁。

最新 Windows 开发包为 `abr-0.1.0-win32-x64-development-eb5d8552ee32.zip`，大小 267313182 bytes，SHA-256 为 `eb5d8552ee32bc1959cc5ff4aafdcf1609562ab5b8bb1eb60bf02f6961bd5dcb`，代码 commit 为 `1124bc7465af518d1202df1b62b681410befbeb7`，打包阶段 gitDirty 为 false。实际隔离安装验证覆盖 2904 项 inventory、21 项 MCP 工具契约、版本、doctor、重复启动和 exact replay。SBOM 包含 36 项 runtime npm、127 项 all-target Cargo，以及按实际 binary 和完整许可证校验的 ffmpeg/Winldd 组件。包内 Native availability 为 false，DesktopAgent buildAttestation 为 null，保留实际二进制校验和和验收状态。

人工基线审核、macOS/Linux 物理设备、正式发布证书和 Chromium 实际编译结果构成独立发布条件。自动测试产物采用 candidate provenance，发布工具依据实际条件生成结果。

最新实体 GUI 验收于 2026-10-11 00:10:19 Asia/Shanghai 开始，命令为 `$env:ABR_GUI_E2E='1'; corepack pnpm exec vitest run tests/e2e/gui/windows.test.ts tests/e2e/gui/windows-mcp.test.ts`，2 项通过，总计 25.11 秒。DesktopAgent SHA-256 与上述开发包的 `97d7a6828015b1ee7eec9913914a500326ece02e67c2bccb7eabaa73a6e0f7d5` 一致。测试完成后的 Chromium 与控制进程关闭、ephemeral profile 清理均通过；人工轨迹基线和正式签名状态保持独立。

原版 Chromium 于 2026-10-11 07:34 Asia/Shanghai 完成全量编译，版本为 156.0.8078.12，实际输出测量为 11869252851 bytes。定制版锁定补丁已应用且 GN 通过；本机 AppContainer ACL 工具的输出编码经官方独立目标修复。后续 8 jobs 构建返回 Windows `0xc000012d` 与 LLVM out-of-memory，完整输出和缓存保留。13:03 读取系统提交量为 34.45 GiB、提交上限为 42.25 GiB，恢复配置采用 2 jobs；Native 完整编译和实体握手状态继续依据实际完成凭据记录。

同构建原版验证于 2026-10-11 13:19 Asia/Shanghai 完成，生产 CompatibleEngine、Core Runtime/Policy 和官方 Playwright 1.64.0 使用实际 156.0.8078.12 浏览器，以单个 headless 根进程完成 7 项检查，耗时 13.568 秒。loopback 导航、AX、按钮计数、键盘输入、PNG、受保护 AX 和 6615 个敏感内部像素的 opaque-black 遮罩均通过，context/profile/worker/浏览器进程与临时资源完整清理；编译清单保持原样，独立回执记录通过状态。定制版于 2026-10-11 20:22 实测 remaining=33054，2026-10-12 00:18 实测 remaining=24538；唯一 2 jobs 构建仍运行，尚未生成 compiled manifest。
