# TASK-011 本地 IPC 与 Rust Agent

实施状态：版本化跨语言 framing、受保护本地启动、身份握手、请求关联、取消接收与断线清理已实现；Windows 实际 Node-to-Rust 进程集成验证通过。macOS/Linux 的原生 transport 权限与实体桌面验收分别待对应设备执行。

协议采用 4 MiB frame 硬限制和严格 UTF-8 JSON。请求与响应使用共享 schemaVersion/requestId 信封，拒绝无效版本、未知信封字段和不完整响应。Node 客户端最多保留 32 个 pending requests；Rust dispatch 使用有界 32-item channel。身份验证阶段使用独立 authVersion=2，按 agent.challenge、agent.hello 顺序完成一次双向认证。

父进程生成 32-byte 随机启动密钥，通过继承标准输入传递；进程参数、IPC request payload 与诊断记录保持原始密钥排除。bootstrap 返回的 PID 必须匹配本次启动的 child PID。客户端先发送 32-byte 随机 clientNonce；Agent 生成操作系统随机 serverNonce，并返回 HMAC-SHA256 serverProof。客户端验证 serverProof 后发送独立 clientProof。两侧 transcript 依次包含固定协议标记、agent namespace、server/client direction、server PID 与两个 nonce，并使用换行分隔。Agent 以 constant-time MAC verification 校验 clientProof，挑战有效期为 10 秒，每个连接仅接受一次挑战与一次 hello attempt；字段、版本、nonce、证明和顺序错误关闭认证连接。schemaVersion 保持 1。Windows named pipe 使用当前用户 SID DACL、远程客户端拒绝及独立 overlapped read/write event。Unix 使用 0700 父目录与 0600 socket，在建立连接后移除 socket pathname。

Rust Agent 接入 Windows、macOS 和 Linux 的独立 desktop backend，doctor 返回真实权限、输入监测和能力状态。认证后的独立 reader 可以在输入 dispatch 进行期间接收 desktop.cancel 并更新 bound session 的原子取消代次；监督连接断开时取消所有已登记会话。Node transport 断开会拒绝全部 pending requests 并释放 timers。桌面输入的 foreground、窗口 PID、配对释放和 deadline 由相应 backend 校验。

实际验证命令与结果：

- `cargo build --workspace --locked`、`cargo test --workspace --locked`、`cargo clippy --workspace --all-targets --locked -- -D warnings`：Windows 实际构建与检查通过，20 项测试通过。包含 6 项双向认证、6 项共享 private URL/window authority、4 项 Windows backend、3 项 framing/JSON 与 1 项本地控制 bootstrap 测试。认证验证已知 HMAC vector、独立协议 server/client vectors、direction/namespace/PID/nonce 分离、TTL、重放、严格字段以及真实操作系统 nonce 的跨连接分离。
- `corepack pnpm exec vitest run tests/integration/native/ipc.test.ts tests/unit/authentication.test.ts`：Windows 实际执行 3 项通过。真实 Rust Agent 完成双向认证，关联 8 个并发 doctor 响应，验证未知方法返回 `UNSUPPORTED_CAPABILITY`，随后关闭 Agent 和测试目录。客户端测试同时验证独立固定证明与替换 socket 的 server-proof 验证边界。
- `corepack pnpm typecheck`：通过，包含生产 TypeScript build 和 tests 类型检查。
- `corepack pnpm lint`：通过，包含 ESLint、Prettier 和 dependency boundary 检查；workflow YAML 已通过实际 parser 读取并核验步骤顺序、三平台 target 和 GUI opt-in 关闭状态。
- `cargo clippy --workspace --all-targets --locked --target x86_64-unknown-linux-gnu -- -D warnings`：通过。对应 macOS `aarch64-apple-darwin` 命令在 `DOCS_RS=1` 类型检查环境中通过。macOS 原生 Swift/SDK 编译和两个 Unix 平台的 runtime socket 权限检查保留待执行状态。

CI 定义先安装 pinned Rust compiler、执行 cargo fmt/clippy/test/build，并核验实际 debug Agent 文件存在，再运行 Node IPC tests。macOS runner 使用真实 SDK/Swift，documentation-only 标志需要为空。官方完整 Chromium 使用 no-shell 安装；Linux 的包含 headed parity 的 Node suite 和 Compatible E2E 都在 Xvfb 内执行。实体 GUI 测试采用显式 opt-in。当前 CI 配置完成本地检查，hosted jobs 待执行。

Windows GUI 主路径已有独立实机结果；macOS/Linux backend 的实现、跨 target 编译、原生 transport 与物理桌面验收分别记录。Wayland 当前 Portal discovery 已实现，授权 session、可信 window binding、input/capture 数据路径保持待实施状态。macOS/Linux 原子导航 capability 明确为 unavailable。
