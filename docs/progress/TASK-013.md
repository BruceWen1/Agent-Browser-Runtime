# TASK-013 macOS DesktopAgent

当前 URL authority 使用独立的只读 native metadata traversal。绑定窗口内的顶层 AXWebArea 优先读取 AXURL，CFURL/NSURL 值通过 CFURLGetString 转为 UTF-8；document boundary 停止深入，页面同名 toolbar/textbox 与 iframe URL 排除于 authority 候选。备用地址栏限于 document 之外的原生 AXToolbar、已识别的 editable address control 与明确 unfocused 状态。公共 privacy tree 读取前后分别核验 URL、document/native source identity 和几何；保留 AX 对象并通过 CFEqual 比较实际身份。

原生 Core Graphics window 与 AX window 的同 PID 几何匹配均要求完整枚举和唯一候选，bind、focus 与后续观察复用该检查。窗口歧义返回 TARGET_STALE，缺少必要几何或超出枚举预算返回明确能力错误。private metadata 的 AXChildren provider 错误、超时与异常类型直接终止读取；只有明确 unsupported/no-value 或成功空数组形成叶节点。

输入和标签角色中的独立 ASCII word Card 使用 case-insensitive 分类，Cardboard/Discard/card2/card_name 保持普通文本；document/window/group/title 的 Card 标签保持原有 scope。公共节点过滤与 screenshot mask 使用同一分类，既有 sensitive phrases 与可信 custom patterns 保持原有语义。86 处泛化流程注释已替换为实际权限、窗口、键盘布局、配对释放或遮罩逻辑。

实现状态：平台代码、Rust 类型检查与静态检查已完成。macOS 原生链接、签名应用权限行为和实体桌面验收待 macOS runner 执行。

`native/desktop-agent/src/backend/macos.rs` 使用进程 PID、Core Graphics window ID、原生窗口几何和前台 AX 窗口建立会话绑定。AX 读取采用每次调用 1 秒超时、4096 节点、32 层和 8 秒遍历预算；当前 URL 来自浏览器文档属性或已识别的地址栏。受保护字段的值和全部子树在 IPC 编码前移除。ScreenCaptureKit 在内存中捕获绑定窗口，关闭窗口阴影，并根据捕获前后 AX 保护区域遮罩 PNG。受保护区域缺少几何或捕获过程中 URL 改变时返回明确错误。

输入采用 Quartz HID event post。每个字符或指针批次检查前台 PID、窗口几何、动作期限、取消 generation 和用户输入 generation。只读 CGEventTap 按事件类别累计外部输入；本进程事件带独立标记，监测过程中保留事件类别而省略键值。Accessibility、PostEvent、ListenEvent 与 Screen Recording 权限分别检查。权限不足时输出 `PERMISSION_REQUIRED`。输入监听失效时停止注入并输出 `INPUT_BACKEND_UNAVAILABLE`。物理按键使用当前 TIS 键盘布局和 UCKeyTranslate；`auto`/`unicode` 文本使用 Quartz Unicode 并报告 `os-unicode`，`keyboard` 报告 `os-keyboard`。

跨 Agent 输入与窗口 focus 使用同用户座席文件 `flock` 互斥。运行目录动态选取，创建权限为 `0700`，lease 文件采用 native `O_NOFOLLOW`、`0600` 和 UID/link-count 校验。锁在成对输入释放完成后解除。可信 runtime 可为观察与捕获提供最多 64 项、每项 256 字符的 literal sensitive label patterns，标签在 native 子树过滤和截图遮罩前使用。

坐标采用单显示器 Retina 映射，支持负显示器原点。跨显示器窗口返回 `UNSUPPORTED_CAPABILITY`。OS 观察将 `viewportMetricsVerified` 设置为 `false`，CSS viewport 坐标使用能力检查。IME composition 与文件选择器独立能力仍待实现；系统键盘布局、中文/日文输入法、权限撤销、文件选择器及事件与人工基线的匹配度需要实体桌面验证。截图最低系统版本为 macOS 14。

验证命令及结果：

- `cargo check --workspace --tests --target aarch64-apple-darwin`：成功；命令执行环境设置 `DOCS_RS=1`，ScreenCaptureKit 跳过 Swift bridge 构建，仅验证 Rust 代码和测试代码的目标类型。
- `cargo clippy --workspace --tests --target aarch64-apple-darwin -- -D warnings`：同一类型检查环境下成功。
- `rustfmt --edition 2024 native/desktop-agent/src/backend/macos.rs`：成功。
- `cargo test --workspace --locked`：Windows 实际执行 20 项通过，包含 6 项共享 native-URL/window authority synthetic metadata 测试；该组同时覆盖 Mac/Linux role vocabularies，验证伪 toolbar/iframe、focus fallback、privacy pruning、document identity 变化、provider 读取失败与唯一完整窗口几何选择。
- `cargo clippy --workspace --all-targets --locked --target aarch64-apple-darwin -- -D warnings`：最新代码与测试在 `DOCS_RS=1` 类型检查环境中通过，包含 authVersion=2 双向本地认证模块。
- macOS Framework/Swift 链接、三项 Mac 平台测试运行、签名和公证、真实 Chrome GUI fixture：Blocked，当前设备为 Windows。共享 metadata 单元测试属于真实进程内逻辑验证，原生 Accessibility/Quartz 行为仍需 macOS 实机验证。

macOS 实机验收应执行原生 `cargo build`、`cargo test` 和 `abr doctor`，在系统设置中分别授予 Accessibility、Input Monitoring 和 Screen Recording 后重启 Agent，再验证 AX 观察、物理按键、Unicode、鼠标点击、截图遮罩、焦点变化与用户输入抢占。签名交付的 TCC 权限与开发进程权限分别记录。
