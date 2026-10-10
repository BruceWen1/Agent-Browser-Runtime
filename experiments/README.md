# 独立 Compatible 研究

A1/A2 在 `experiments/flags.json` 中默认关闭，研究模块保持独立于生产 engine/MCP 注册和 Chromium 安全行为。研究页面限于自有 loopback fixture，所有结论随具体版本和 trace 保存。

```powershell
node experiments/research.mjs evidence --output research/run-001/source-evidence.json
node --test experiments/research.test.mjs
```

`evidence` 从当前安装的官方 Playwright 1.64.0 读取发布包，保存 coreBundle.js 完整 SHA-256、CDP 调用行位置、输入路径差异和 Apache-2.0 许可标识。仓库的 `source-evidence.json` 为实际静态检查产物。未知版本或已变更的协议调用位置要求重新记录证据。

命令矩阵如下：

| 输入/操作                                        | 已观察的执行语义        | 独立 prototype                                       |
| ------------------------------------------------ | ----------------------- | ---------------------------------------------------- |
| `Input.dispatchMouseEvent(mouseMoved,buttons=0)` | CDP pointer input       | GUI pointer-move，坐标仍由受保护 runtime 验证        |
| `mousePressed/mouseReleased`                     | 独立按钮转换及 callback | 当前原子动作 API 保持 unsupported                    |
| `Input.dispatchKeyEvent(keyDown/keyUp)`          | 独立按键转换及 callback | 当前原子按键 API 保持 unsupported                    |
| `Input.insertText`                               | CDP 文本提交            | GUI type-text，返回实际策略和待验证 Composition 差异 |
| `selectOption`                                   | DOM 注入选择            | 保留 Compatible 语义                                 |
| `Runtime.evaluate`                               | JavaScript 执行         | 保留 Compatible 语义                                 |
| `DOM.setFileInputFiles`                          | CDP 文件输入赋值        | 保留 Compatible 语义                                 |
| network route / context permissions              | 协议或 Context 控制     | 保留 Compatible 语义                                 |

A1 使用显式已审核的 flags 文件开启 `a1DiffAnalysis`，对固定构建与平台的候选 trace 进行比较：

```powershell
node experiments/research.mjs a1 baseline.json actual.json --flags research/reviewed-flags.json --output research/run-002/a1-evidence.json
```

报告保持候选基线状态；未知环境返回 `invalid-fixture`，独立人工审核采用 trace SHA-256 绑定的基线流程。当前分析的 `patchProposals` 和 `securityBehaviorChanges` 均为空。实际事件差异经同构建/同平台复现和审核后，才建立有界 patch、回归和回滚记录。

A2 提供 `planA2Command()` 和 `executeA2Command()`，要求显式 `a2OsInputPrototype`、GUI session/window 标识、当前 owned fixture URL 及已有受保护的 runtime adapter。Pointer plan 仅接收无按钮、无 modifier 的坐标移动；Text plan 仅接收有界文本。执行前重新读取当前 URL；Core adapter 保留 domain policy、审批、输入所有权、DPI/窗口/焦点及 stale 验证。成功返回要求 `executionPath=os-input`，任何 adapter fallback 均拒绝。

Prototype 的验证状态为 pending，物理按键、IME、独立 down/up、协议 callback 时序和用户激活分别需要实际 OS-input trace。纯单元测试中的 synthetic adapter 只验证边界和 provenance 拒绝逻辑。研究的输出包含实际策略与限制，生产开关保持关闭。

每个后续 patch 需记录观察差异、精确变更语义、公开 API/权限影响、Windows/macOS/Linux 同版本测试与回滚方案。当前研究保存原版 Playwright，浏览器事件和安全属性按上游行为采集。
