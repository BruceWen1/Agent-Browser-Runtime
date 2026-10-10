# Agent Browser Runtime

ABR 为 AI Agent 与 Playwright 项目提供本地浏览器运行环境。Compatible、GUI 和 Native 共享会话、策略、能力声明与操作结果；每个会话通过 `browser_capabilities` 返回当前支持的操作及 unavailable 原因。运行时的工具目录包含 21 个浏览器工具。

## 源码运行

固定工具链为 Node.js 24.15.0、Corepack 0.34.6、pnpm 12.10.1 和 Rust 1.99.0。Windows 的 Rust MSVC 构建需要 Visual Studio C++ Build Tools 与 Windows SDK；macOS 的桌面绑定构建需要 Xcode command-line tools、系统 SDK 和 Swift 编译器。运行下列命令时工作目录为仓库根目录。

```powershell
npm install --global corepack@0.34.6
corepack enable
corepack pnpm install --frozen-lockfile
rustup toolchain install 1.99.0 --profile minimal --component rustfmt --component clippy
cargo build --workspace --locked
corepack pnpm build
corepack pnpm --filter @abr/playwright-worker exec playwright install chromium --no-shell
corepack pnpm abr init
corepack pnpm abr doctor --json
corepack pnpm abr test contract
corepack pnpm abr mcp serve --stdio
```

`playwright install chromium --no-shell` 安装完整 Chromium 及对应辅助资源，供默认有头会话使用。Linux 安装浏览器及系统运行库时使用 `corepack pnpm --filter @abr/playwright-worker exec playwright install chromium --with-deps --no-shell`。Linux 有头 Compatible 测试需要可用显示服务；CI 使用 Xvfb。独立 headless-shell 资源在显式安装后按实际 inventory 分发。

初始化命令以独占创建方式写入 `.abr/config.yaml`。默认引擎为 Compatible，浏览器为官方 bundled Chromium，有头运行。CLI 按 `bin/`、`target/release/`、`target/debug/` 查找平台 DesktopAgent，也支持可信本地配置中的 `gui.agentExecutable`。`doctor` 展示平台、浏览器候选和已注册 adapter；会话内能力由实际权限和后端检查决定。

MCP 客户端可使用 `node packages/cli/dist/main.js mcp serve --stdio` 启动服务。MCP 标准输出仅包含协议消息，诊断使用标准错误。

## 三引擎与平台状态

| 引擎       | 观察与输入                                             | 当前实施和验收状态                                                                                 |
| ---------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Compatible | 官方 Playwright 1.64.0 的页面、定位、输入和浏览器 API  | Windows 自有 fixture 自动测试已通过；其他平台的 hosted CI 与实体桌面分别待验证                     |
| GUI        | 系统无障碍树、系统截图、系统鼠标和键盘输入             | Windows 已编译并通过 AX 定位、系统点击、Unicode 文本与截图主路径实机检查；扩展人工事件基线独立验收 |
| Native     | 定制 Chromium 的只读 Browser/AX observer，复用系统输入 | 需要 exact-pin 定制浏览器、observer 身份握手和同构建回归；当前开发包报告 unavailable               |

Windows GUI 使用 UI Automation、Windows Graphics Capture 和 SendInput。原子导航在同一个 native input lease 内完成 Control+L、URL 输入和 Enter。默认 auto 文本策略记录实际 `os-unicode` provenance；物理 keyboard 策略检查输入法状态，IME composition 保持 unsupported。文件选择器和独立会话控制已实现，完整专项人工验收按场景记录。

macOS 具有独立 AX、Quartz 输入和 ScreenCaptureKit 后端；截图要求 macOS 14 及 Accessibility、Input Monitoring、Screen Recording 授权。当前验证包含 Rust 类型检查，原生 Swift/SDK 链接及实体桌面验收待对应设备执行。Linux X11 具有独立 EWMH、AT-SPI、XTest、XInput2 和 XKB 后端，已通过跨 target 编译检查；其实体桌面验收待执行。两平台的原子浏览器导航能力当前均为 unavailable。

Wayland 当前完成 Portal 版本、设备声明和 XWayland 环境识别。授权 RemoteDesktop/ScreenCast 会话、可信浏览器窗口绑定、输入及截图数据路径属于待实施范围，输入能力明确报告 unavailable。XWayland 的存在作为独立环境信息记录。

平台能力分别检测 foreground、权限、输入监测、文件对话框、IME、导航与坐标空间。系统观察使用物理屏幕坐标；`viewport-css` 目标需要已验证 viewport/DPR/zoom 元数据，缺失时返回 `UNSUPPORTED_CAPABILITY`。多显示器、分数缩放、125% DPI、中文 composition 和平台文件选择器保留各自的验收状态。

## GUI 控制与本地授权

GUI/Native 的系统输入检查可信启动 PID、当前窗口、前台状态和最新观察身份，并在桌面输入 lease 内串行执行。外部用户输入、焦点变化、取消和超时中断操作；已注入的按下事件保留配对释放。窗口或页面状态变化要求新的 observation，能力缺失产生解释性错误。

Windows GUI 会话使用独立的本地 Pause/Resume/Stop 控制窗口；热键 `Ctrl+Alt+Pause` 在系统注册成功后报告可用。Pause 取消当前输入，Resume 重新检查窗口和观察状态，Stop 请求关闭当前会话所绑定的进程。控制面故障及抢占恢复仍需要实体桌面专项验收。macOS/Linux 的同等本地控制面保留独立实施状态。

浏览器 profile、运行数据和 artifacts 默认位于当前用户应用数据目录，可通过 `ABR_DATA_DIR` 选择独立目录。初始允许范围为 `http://127.0.0.1:*` 与 `http://localhost:*`；其他目标通过可信本地配置的 origin allowlist 授权。默认人工批准类别包含 file-upload、payment、send-message、delete，上传目录受 `allowedUploadRoots` 限制。人工决定来自独立本地用户界面。

密码和敏感文本在观察树输出前过滤，截图敏感区域在编码及 IPC 传输之前遮罩。截图持久化默认关闭。诊断记录排除凭据、输入值、浏览器存储和 URL query。

## 检查与 Native 构建

Node 集成测试使用实际编译的 Rust Agent。以下检查先完成原生构建，再执行认证跨语言 IPC；GUI 实机验收采用独立桌面授权。

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --locked
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm exec vitest run --config vitest.config.ts --exclude "tests/e2e/compatible/**"
node --test release/update.test.mjs release/package.test.mjs chromium/build/budget.test.mjs chromium/build/pipeline.test.mjs experiments/research.test.mjs
```

含浏览器的 Node/parity 测试需要显示服务，Linux CI 为该 Vitest suite 使用 `xvfb-run -a -s '-screen 0 1920x1080x24'` 前缀。有头 Compatible 检查在桌面可用时执行 `corepack pnpm test:compatible`；Linux CI 执行 `xvfb-run -a -s '-screen 0 1920x1080x24' corepack pnpm test:compatible`。三平台 workflow 先验证 runner 身份、原生 SDK 和 Rust 构建，再安装官方浏览器并执行测试。macOS CI 要求实际 Swift/SDK 编译，物理 GUI 测试按显式 opt-in 单独执行。当前 workflow 已完成本地静态检查，hosted runner 结果待执行。

定制 Chromium 锁定版本为 `156.0.8078.12`，upstream commit 为 `634b046faf2137b83af71c87baf362b533af9104`，DEPS、depot_tools 和只读 observer patches 使用固定 SHA。外部 checkout 根目录需要无空格路径，并满足实际 SDK、内存和磁盘 gate。Windows 构建要求 Visual Studio 18、ATL/MFC、Windows SDK 10.0.28000.2270 及对应 DebugTools；构建管线实际测量系统工具和空间余量。

```text
node chromium/build/pipeline.mjs preflight --checkout-root "<external-chromium-root>"
node chromium/build/pipeline.mjs checkout --checkout-root "<external-chromium-root>"
node chromium/build/pipeline.mjs sync --checkout-root "<external-chromium-root>" --jobs 8
node chromium/build/pipeline.mjs build --checkout-root "<external-chromium-root>" --variant original --jobs 8
node chromium/build/pipeline.mjs apply-patches --checkout-root "<external-chromium-root>"
node chromium/build/pipeline.mjs build --checkout-root "<external-chromium-root>" --variant patched --jobs 8
```

这些阶段针对新选定的独立源码根目录；已有源码由身份验证和明确 adopt 流程接入。原版与补丁产物分别生成 binary digest 和 build manifest。当前实际 Chromium 成功编译及三平台 Native parity 仍待完成，`native.enabled` 默认 false。启用条件包含真实定制浏览器 executable、匹配的 `chromium/VERSION.lock` 和有效只读 observer 握手。Chromium observer 的 macOS/Linux OS window ID 映射仍待实施，该条件保持为 Unix Native capability 的独立 gate。Chromium 官方隔离 Python 使用已授权的工具链例外，其他 Python 配置遵守 Conda 环境规则。

## 开发分发

`node release/package.mjs --native-agent target/debug/abr-desktop-agent.exe --output .cache/release` 生成 Windows development ZIP；macOS/Linux 的参数使用实际 `target/release/abr-desktop-agent`。软件包包含当前平台 Node runtime、production Node dependencies、JSON contracts、实际浏览器资源、提供的 DesktopAgent、完整 component inventory、SHA256、SBOM 与 license notice。`app/chromium/VERSION.lock` 保留 Native configuration 使用的 upstream identity。

软件包运行入口为 Windows 的 `abr.cmd` 或 macOS/Linux 的 `./abr`。`node release/package-smoke.mjs --archive <package.zip> --sha256 <verified-digest>` 在独立临时目录执行安装、完整 inventory、版本、21-tool contract、doctor、重复 launch 和 exact replay 验证。已核验 Windows development snapshot 包含 CFT 156.0.8078.4、ffmpeg 1013、Winldd 1007；metadata smoke 的 browser launch 数为 0。该 snapshot 的 Native compiled/available 为 false，DesktopAgent build attestation 为 null。

本地 update/rollback 校验 archive SHA、platform、protocol major、publisher trust 和逐文件 inventory后原子切换 active version。用户数据位于版本目录之外。development archive 使用明确的 unsigned opt-in；正式签名发布需要真实 code signing/notarization、独立可信 reviewer、精确源码 P0 证据和批准的三平台人工事件基线。当前分发状态为 development。

源码注释与 Google-style 函数说明使用英文，使用文档和实施报告使用中文。每个平台分别记录工具实现、编译结果、自动测试、实体桌面检查和人工基线批准。
