# TASK-014 Linux X11 DesktopAgent

当前 origin authority 通过独立 credential-verified AT-SPI metadata walk 读取。顶层 document web 使用 Document.GetAttributeValue("URI")，与 native node 的 peer/object-path identity 绑定；在 document boundary 停止深入，HTML 同名 toolbar/textbox 与 nested iframe URI 排除于候选。地址栏备用需要 document 之外的原生 tool bar ancestor、已识别的 editable address control 与明确 unfocused 状态。公共 privacy tree 前后分别核验 window/document/source identity、URI 和文档/窗口几何，变化返回 TARGET_STALE。

EWMH client list 与 AT-SPI window/frame 的同 PID 几何匹配均要求完整枚举和唯一候选，bind、focus 与后续观察复用该检查。窗口歧义返回 TARGET_STALE，缺少窗口几何或超出枚举预算返回明确能力错误。private metadata 的 GetChildren provider 错误终止 traversal，provider/object-path identity 在读取过程中保持验证。

独立 ASCII word Card 的默认 hint 限于输入与标签角色，case-insensitive 匹配；Cardboard/Discard/card2/card_name 和 document/window/group/title 的 Card 保持原有 scope。公共 AX 与 PNG pixel mask 使用同一保护分类，既有 sensitive phrases 和 trusted literal patterns 保持原有语义。43 处泛化注释已按原生 keymap、窗口命中、用户输入、modifier release 和遮罩循环等实际逻辑修整。

实现状态：平台代码、Linux 目标 Rust 类型检查与静态检查已完成。Ubuntu X11 实体桌面运行和 GUI 验收待 Linux runner 执行。

`native/desktop-agent/src/backend/linux.rs` 使用 EWMH client list、`_NET_WM_PID`、进程可执行文件元数据和 `_NET_ACTIVE_WINDOW` 验证浏览器身份。原生坐标命中检查按当前 X11 stacking children 逐层读取，输入点属于遮挡窗口时返回 `TARGET_OCCLUDED`。EWMH window manager 缺失时返回 `INPUT_BACKEND_UNAVAILABLE`。

AX 观察使用当前用户 AT-SPI D-Bus，按 D-Bus peer 的 Unix process PID 匹配浏览器。树读取设有远程方法超时、节点/深度/时间预算和对象引用循环检查。当前 URL 通过文档 URI 属性或已识别地址栏读取；受保护字段的文本与全部子树在 IPC 前移除。窗口截图读取 X11 native pixels，按实际 byte order、scanline padding 和 RGB masks 转换，在内存中遮罩捕获前后观察到的保护矩形并编码 PNG。缺少保护几何、URL 改变或不支持的像素格式产生明确错误。

输入采用 XTest；XInput2 只读观察按 source ID 区分用户设备与 XTEST 虚拟设备，并记录外部输入 generation。设备层次变化或监测失效立即停止后续注入。每个输入批次检查前台身份、取消、超时与用户输入。物理键盘映射使用实际 X11 keymap，并通过 XKB 验证当前 group、Caps Lock 和用户持有的 modifier。当前支持 first keyboard group；其他 group、Caps Lock、Unicode/IME 独立策略返回明确能力状态。wheel 使用离散 X11 button steps，转换比例在实现中限定为每 120 个请求 delta 对应一轮 step，后续实体桌面基线需记录该语义。

跨 Agent 输入与窗口 focus 使用同用户座席文件 `flock` 互斥。运行目录动态选取，创建权限为 `0700`，lease 文件采用 native `O_NOFOLLOW`、`0600` 和 UID/link-count 校验。锁在成对输入释放完成后解除。可信 runtime 可提供 bounded literal sensitive label patterns，额外标记凭据或业务敏感字段，并在 native IPC 编码前应用完整子树过滤和像素遮罩。

OS 观察采用原生 screen-physical coordinates，`viewportMetricsVerified=false`。CSS viewport 坐标、Chrome zoom/DPR、GPU 合成截图表现、文件选择器、IME、窗口管理器版本和实际桌面缩放需要分别验证。真实桌面人工基线是 GUI 等价验收条件。

验证命令及结果：

- `cargo check --workspace --tests --target x86_64-unknown-linux-gnu`：成功，包含 AT-SPI/X11/XInput2/XKB 实现及测试代码。
- `cargo clippy --workspace --tests --target x86_64-unknown-linux-gnu -- -D warnings`：成功。
- `rustfmt --edition 2024 native/desktop-agent/src/backend/linux.rs`：成功。
- `cargo test --workspace --locked`：Windows 实际执行 20 项通过，包含 6 项共享 private native-URL/window metadata tests，同时覆盖 Linux/Mac vocabularies 的页面伪 toolbar、iframe、focus fallback、sensitive-root pruning、identity race、provider 读取失败与唯一完整窗口几何选择。
- `cargo clippy --workspace --all-targets --locked --target x86_64-unknown-linux-gnu -- -D warnings`：最新代码与测试通过，包含 authVersion=2 双向本地认证模块。
- 三项 Linux 平台测试执行、原生链接与 Ubuntu X11 Chrome GUI fixture：Blocked，当前设备为 Windows。共享 metadata tests 验证 pure authority policy；真实 AT-SPI/X11 操作保留实体桌面验收状态。

Linux 实机验收应记录发行版、desktop session、window manager、显示器缩放和键盘布局。执行原生 `cargo build`、`cargo test`、`abr doctor` 后，在自有 fixture 上检查浏览器 PID/window binding、AX ref、click、text、wheel、protected screenshot、窗口遮挡、用户输入抢占、取消与超时。人工操作数据使用独立采集流程形成基线。
