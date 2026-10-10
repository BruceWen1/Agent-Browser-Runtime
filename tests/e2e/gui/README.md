# Windows GUI 验证入口

Windows GUI 实体桌面用例通过 `ABR_GUI_E2E=1` 显式启用，并要求 Windows 与 `target/debug/abr-desktop-agent.exe`。默认测试运行将这些用例标记为 skipped。执行前需由测试协调者确认可用桌面及输入时段。

`windows.test.ts` 使用直接 Runtime 验证系统导航、AX 点击、文本、截图和资源关闭。`windows-mcp.test.ts` 使用生产 CLI 与官方 MCP stdio client，覆盖 create、capabilities、navigate、observe、click、type-text、screenshot、artifact read 和 close。

`capabilities.test.ts` 通过只读 doctor doubles 验证原子导航能力边界，独立于实体桌面开关。该用例覆盖显式 false、字段缺失、输入 unavailable 及 Windows 显式支持状态。

MCP 用例动态创建独立配置、应用数据目录、ephemeral profile 和 loopback fixture，固定使用本次构建的桌面 agent。输入结果要求 `executionPath=os-input`；auto 文本结果要求实际 `os-unicode` 策略与 Query 控件完整文本一致。截图通过受控 artifact 的 PNG 签名验证，关闭通过 MCP closed 状态及 profile 清理核验。

协议检查使用官方 stdio parser 的 message/error callbacks，并保留计数。诊断隐私检查覆盖 fixture 文本、密码值与 URL query canary；测试诊断保留匹配状态。清理流程先确认 owned browser 关闭与 profile release，再递归删除本次分配的临时根目录。清理失败时保留目录供后续检查。

构建与非桌面验证命令：

```powershell
corepack.cmd pnpm typecheck
$env:ABR_GUI_E2E='0'
corepack.cmd pnpm exec vitest run tests/e2e/gui/capabilities.test.ts tests/e2e/gui/windows.test.ts tests/e2e/gui/windows-mcp.test.ts tests/integration/mcp/stdio.test.ts
```

经测试协调者确认后执行 MCP 实体桌面用例：

```powershell
cargo build --workspace
corepack.cmd pnpm build
$env:ABR_GUI_E2E='1'
corepack.cmd pnpm exec vitest run tests/e2e/gui/windows-mcp.test.ts
```

本次新增 MCP 用例已完成 TypeScript 编译和默认禁用状态检查。非桌面运行结果为 capability gate 与 browser-free MCP stdio 的 2 个用例通过，2 个实体桌面用例 skipped。`cargo check --workspace --all-targets --locked`、所属 TypeScript ESLint、Prettier 和 `git diff --check` 通过。实体桌面执行结果待单独记录，默认 skipped 表示启用边界验证。

GUI 导航能力要求桌面 backend 明确返回 `atomicNavigate=true`。Windows 完整导航序列保持同一原生输入 lease；当前 macOS/Linux 返回 false，并提供明确的 browser.navigate unavailable reason。平台能力状态和实体桌面验证分别记录。
