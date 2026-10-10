# CODEX START HERE — Agent Browser Runtime (ABR)

> 使用方式：将整个压缩包解压到一个新的 Git 工作目录。首先阅读 `docs/01_RPD_产品需求与研发定义.md` 与 `docs/02_技术架构与实施方案.md`，再从 TASK-001 开始按依赖顺序实施。

## 0. 给本地 Codex 的总指令（可直接复制）

```text
你是 Agent Browser Runtime (ABR) 的实施工程师。当前目录包含产品 RPD、详细技术设计与 contracts。

请先完整阅读 docs/01_RPD_产品需求与研发定义.md、
docs/02_技术架构与实施方案.md、contracts/ 和 config/。
按技术设计第 15 节 TASK-001 → TASK-025 的依赖顺序实施。

本轮只实现我指派的 TASK。先做任务审计：
1. 列出该 TASK 的输入、输出、依赖与相关 RPD-ID；
2. 检查仓库是否已有实现，禁止破坏已存在的代码；
3. 列出具体文件变更、schema 兼容性和测试计划；
4. 实施最小可用功能，补齐失败与权限拒绝路径；
5. 运行类型检查、单测、集成测试，提供可复现的完整命令；
6. 输出改动摘要、已完成测试、尚未实测的硬件/OS 项及下一 TASK 阻塞项。

强制规则：
- 产品必须保留 compatible/gui/native 三种引擎；未实现能力显式报告 unsupported。
- Compatible 使用官方 Playwright，保持原语义；不承诺所有 API GUI 等价。
- GUI/Native 模式不得用 DOM 脚本静默代替系统输入。
- Native Chromium 初版只实现只读 Browser/AX 观察接口，输入复用 OS 后端。
- 不得全局修改 isTrusted、用户激活规则、TLS、沙箱或权限系统。
- 不访问未知第三方网站测试风控；所有诊断在本地自有 fixture 中完成。
- MCP 默认 stdio，日志写 stderr；敏感动作由独立本机 UI 批准。
- 没有对应 OS 机器/权限/Chromium checkout 时实现 mock 并标记阻塞，不能声称已经实机通过。
- 若发现与上游库 API 不符，先引用官方文档并写 ADR，禁止硬编码虚构 API。
- 每个里程碑都更新 docs/IMPLEMENTATION_STATUS.md 和 test evidence。

现在开始 TASK-001，只实现 TASK-001；达到其验收条件后停止并报告。
```

## 1. 文件阅读顺序

1. `docs/01_RPD_产品需求与研发定义.md`：问题、范围、需求编号、边界与验收。
2. `docs/02_技术架构与实施方案.md`：进程、模块、接口、平台后端、测试和任务。
3. `contracts/browser-api.ts`：核心稳定类型源。
4. `contracts/action.schema.json`：动作数据交换格式。
5. `contracts/browser-event.schema.json`：测试轨迹格式。
6. `config/abr.config.example.yaml`：部署默认选项。
7. 本文件：逐阶段操作与决策纪律。

## 2. 任务路线图

### M0：TASK-001 ~ TASK-008

创建 workspace → contracts → Core → Policy → FakeEngine → MCP v2 stdio → Artifacts → CLI。此阶段必须在无浏览器的 CI 机器上完成 FakeEngine 端到端测试。

最小 CLI：`abr init`, `abr doctor --json`, `abr mcp serve --stdio`, `abr test contract`。必须有能在 MCP Inspector 里列出工具并调用 `browser_capabilities` 的测试。

### M1：TASK-009 ~ TASK-010

只使用官方 Playwright；在 `http://127.0.0.1:<port>` 本地 fixture 跑启动、导航、点击、输入、截图与关闭。记录 Playwright、浏览器二进制与 Profile 信息。不要先 Fork Chromium。

### M2：TASK-011 ~ TASK-017, TASK-020

实现 Rust DesktopAgent 的 mock 和 IPC，然后按 Windows → macOS → Linux X11 → Wayland 推进。每个 OS 提供 `doctor` capability 状态。Windows/macOS 两者都能在真实 Chrome GUI 下完成自有 fixture 按钮点击与文字输入后，再认定这一里程碑核心成功。

### M3：TASK-018 ~ TASK-019

构建自有事件测试网页、Trace Schema、差异比较器；测试人工 GUI、Playwright 和 ABR GUI 的关键 DOM 事件与页面状态。不将业务网站反风控评分作为验收结果。

### M4：TASK-021 ~ TASK-023

选择正式 Chromium release tag，锁定完整 commit，创建源码 checkout，应用可回放 patch，加入最小只读 Chromium Observer Bridge。Native Engine 复用 GUI 输入。执行与未修改 Chromium 的 A/B/C/D 回归。

### M5/M6：TASK-024 ~ TASK-025

A1/A2 是独立研发实验；只对可复现、可安全验证的差异做实验。最后完成构建、安装包、安全扫描、SBOM、版本 manifest 和部署文档。

## 3. 工作纪律与输出

每个 TASK 创建 `docs/progress/TASK-xxx.md`，包含：`Goal / Changes / Tests run / Tests blocked / Known issues / Contract changes / ADR references / Next task`。

遇到不确定的问题，优先使用可测试的保守方案，且必须保持协议定义及安全边界。不可将“无法完成”替换为“从页面注入脚本偷偷完成”。

### Git 分支和提交

- 分支：`feat/TASK-001-workspace` 形式。
- 每个 TASK 至少一个完整可回滚提交；增量提交不应跨多个未完成 TASK。
- 修改 schema 时同步更新类型契约、测试和迁移说明。
- Chromium patch 与 core app 分开提交；独立 Patch ID、Sha256 和上下游版本记录。

## 4. 第一批测试的接受标准

| 测试             | 命令示例（最终以仓库 package.json 为准）                     | 判定                         |
| ---------------- | ------------------------------------------------------------ | ---------------------------- |
| 编译检查         | `pnpm typecheck`                                             | TS 无错误                    |
| 代码风格         | `pnpm lint`                                                  | 无错误                       |
| 单元测试         | `pnpm test:unit`                                             | 全通过                       |
| 契约测试         | `pnpm test:contracts`                                        | JSON Schema/TypeScript 一致  |
| MCP 测试         | `pnpm test:mcp`                                              | list/call 可用，拒绝非法参数 |
| Playwright smoke | `pnpm test:compatible`                                       | 本地页面交互成功             |
| Rust             | `cargo test --manifest-path native/desktop-agent/Cargo.toml` | 编译及 mock 测试全通过       |
| GUI 对照         | `abr test gui-parity --platform current`                     | 每个用例有 trace 与差异报告  |

上述命令是目标接口；TASK-001 负责建立项目根脚本。早期不存在某命令时，应新增脚本而非声称执行成功。

## 5. 阻塞与决定事项

- 如果当前目录没有 Chromium 源码，则 TASK-021 以前无需下载其庞大源码。
- 如果当前机器缺少 macOS 系统权限，提供用户可操作的授权指引；不要尝试自动绕过。
- 如果 Linux Wayland 不允许应用输入，按协议报告 `INPUT_BACKEND_UNAVAILABLE`，不要偷偷改用非授权全局注入。
- 如果 Playwright 的 CDP attach 行为不同，能力表中另列为 `compatible-attach` 子模式，不替代标准 `launch` 模式。
- 若发现旧文档说 SDK v1，而本实施基线要求 MCP SDK v2，则以本包经核实的 v2 官方文档为准并更新 ADR。

## 6. 下一轮调用模板

```text
继续 ABR 的 TASK-002。
先阅读两个核心文档及本任务依赖，检查 TASK-001 的测试结果。
本轮仅交付 TASK-002，要求：
- contracts/browser-api.ts 成为类型源；
- schema 验证器拒绝非法字段/非法 union；
- Rust IPC 数据形态能从 JSON Schema 自动验证；
- 输出单元测试和任务状态，不做 TASK-003。
```

将任务编号替换为下一个 TASK 即可持续推进，避免一次性把三条路线混成不可调试的大改动。
