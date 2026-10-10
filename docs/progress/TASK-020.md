# TASK-020 独立人工接管控制 UI

需求映射：RPD-010、RPD-021、RPD-030。增加 `native/desktop-agent/src/control.rs` 与 `packages/native-ipc-client/src/control-ui.ts`，提供独立于浏览器与 MCP 输入通道的 Windows 本地控制窗口。

控制进程以 `--control` 启动，通过 inherited stdin 接收闭合、限长的 `{schemaVersion,sessionId,parentPid,inputProcessId}`。窗口标题显示对应 session；窗口提供原生 Pause/Resume/Stop，首次显示采用 `SW_SHOWNOACTIVATE`，暂停快捷键 Ctrl+Alt+Pause 的支持状态取决于实际 OS 注册结果并显示在窗口内。实际 Resume 按钮通知中调用 `AllowSetForegroundWindow(inputProcessId)`，仅向当前已认证 Agent PID 授予前台资格；持有的 process handle 用于拒绝已退出的 Agent。窗口 X 与 Stop 均发出已绑定会话的 stop 请求；父进程 liveness timer 在应用退出后关闭窗口。

stdout 仅包含闭合 ready/pause/resume/stop JSON；Node supervisor 核验 schema、exact session、严格 UTF-8、字段、ready 次序、消息配额与输入速率。Pause/Resume 按序交给应用 Core；Stop 立即交给 Core.close，并阻止已排队的 Resume。UI 请求状态与 Core 实际生命周期分别记录。GUI 输入仍由已有后端核验浏览器 PID、窗口/焦点、DPI、stale 引用及输入 lease；本窗口不增加浏览器之外的输入目标。

Native HWND 及 parent process handle 采用 RAII，原生 repaint/teardown 消息保持附加状态的安全生命周期。父应用在 owned session close 时关闭该 UI；意外 helper 退出或协议失效通过安全 failure callback 交给应用暂停/清理流程。高风险审批继续使用独立的审批进程，其权限决定与本控制窗口的暂停/恢复/停止分别处理，MCP 工具保持只读 approval status。

验证：`cargo test -p abr-desktop-agent control::tests` 通过 1 个 bootstrap 场景，包含正确 session、未知 approve 字段、控制字符、零 parent PID 与超长 payload；`cargo clippy -p abr-desktop-agent -- -D warnings` 通过。Node package build、针对 control-ui 的 ESLint、`vitest ... tests/unit/control-ui.test.ts` 通过，验证 foreign session、unknown action、approve 字段、错误 capabilities、schema 版本与原生快捷键 unavailable 状态。

Windows 控制窗口已编译，实际手动按钮/快捷键、UI 可见性、首次显示焦点与运行中强制停止需要独立桌面交互验证。macOS/Linux 控制 UI 当前返回显式 unsupported，保留原生平台独立实现状态。单元测试验证边界与状态处理，人工点击和跨平台验收依实际用户操作记录。

应用集成：每个 GUI/Native owned session 对应一个 `LocalControlUi.start()`；`onEvent` 调用该 session 的 Core.pause/resume/close；`onFailure` 暂停或清理该 session；session close 和应用 dispose 调用 `surface.close()`。控制通道通过 `close` 事件等待 stdout 完成解析，保留退出前最后一个有效 stop 请求。
