# TASK-015 Linux Wayland capability detection

实现状态：Wayland/XWayland 分类、Portal 服务检测和解释性失败已完成。授权 Portal session、PipeWire stream 与浏览器窗口身份绑定、RemoteDesktop/libei 输入实施待 Wayland 实机开发与验收。

检测以 `WAYLAND_DISPLAY` 和 `XDG_SESSION_TYPE` 为依据。Wayland 会话同时存在 `DISPLAY` 时保持 Wayland 分类，并单独报告 XWayland present。当前用户 D-Bus 上读取 RemoteDesktop Portal version 和 AvailableDeviceTypes；版本信息描述 API 声明，授权状态、EIS 连接、ScreenCast session 和输入许可分别报告。Agent 启动和 doctor 检测采用只读查询。

| Desktop session | 观察/输入路径 | 当前行为 |
| --- | --- | --- |
| X11 + EWMH + XTest + XInput2 | AT-SPI / X11 native pixels / XTest | 按运行时能力检查启用；实体桌面待验收 |
| Wayland + XWayland | 当前用户 Portal/AT-SPI 能力检测 | 输入与截图保持 unavailable；需要授权 stream 和可验证浏览器绑定 |
| Wayland + RemoteDesktop Portal | Portal version/device properties | 报告 API 声明、授权状态和未连接 EIS 状态 |
| Wayland Portal 缺失或设备不可用 | 解释性错误 | `INPUT_BACKEND_UNAVAILABLE`，包含所需授权通道和窗口绑定要求 |

Wayland 的 `desktop.bind`、native capture 与 input 目前返回 `INPUT_BACKEND_UNAVAILABLE`，信息明确说明需要授权 Portal stream 和 verified browser window binding。后续授权流程须由用户在 Portal UI 中选择屏幕/窗口与输入设备；校验返回 stream logical geometry 和设备 grant 后绑定浏览器身份，再启用 Notify 输入或 EIS sender。EIS 建立后采用 EIS 作为该 session 的唯一输入通道。session 撤销或窗口身份失效时停止输入并释放 lease。

验证命令及结果：

- `cargo check --workspace --tests --target x86_64-unknown-linux-gnu`：成功。
- `cargo clippy --workspace --tests --target x86_64-unknown-linux-gnu -- -D warnings`：成功。
- GNOME/KDE Wayland Portal UI、session grant/revoke、PipeWire/EIS、真实浏览器 GUI fixture：Blocked，当前设备为 Windows，且授权 stream/window binding 子功能待实现。
