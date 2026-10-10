# Agent Browser Runtime（ABR）— RPD 产品需求与研发定义

> 版本：v1.0 · 状态：可实施基线 · 日期：2026-10-10  
> RPD = Requirements & Product Definition（产品需求与研发定义）。技术细节以《02_技术架构与实施方案.md》为准。  
> 本文件是产品侧的单一需求来源（Source of Truth）；变更须同时更新需求编号、验收用例和技术方案映射。

## 0. 执行摘要

ABR 是面向 AI Agent、MCP 客户端与已有 Playwright 项目的跨平台浏览器运行时。它不是以修改指纹和绕过特定网站挑战为主要能力的传统反检测浏览器，也不是仅为消费者提供聊天侧边栏的 AI 浏览器。其核心是：在授权页面上提供可靠的浏览器观察、操作、会话管理与可核验的 GUI 事件一致性。

产品同时保留三条研发路线：**A. Playwright Compatible**（官方 Playwright 原样接入，并研究自动化特征修正与命令重定向）；**B. Native GUI**（外部 MCP + 系统级截图/无障碍/输入，Chrome 无需修改）；**C. Chromium Native**（自研 Browser API/MCP 与 Chromium 浏览器进程深度集成，尽量复用 B 的输入引擎）。三条路线共享会话、权限、事件记录、能力协商和测试设施。

**产品必须明确区分**：① API 可调用；② 操作结果等价；③ 浏览器可观察事件及状态与人工 GUI 一致；④ 站点是否进行风控。前两类是功能测试目标，第三类需要跨平台同版本对照，第四类不是可保证交付的承诺。

## 1. 背景、问题与机会

### 1.1 已确认背景

- 已有 AI/自动化通过 Playwright 操作 Chrome，遇到页面将自动化环境或操作方式与人工 GUI 区分的问题。
- 初始目标强调网页可读取的技术特征（`navigator.webdriver`、输入事件、焦点、User Activation、浏览器配置等），不把 IP、账号信誉、人的节奏轨迹作为核心研发范围。
- 用户希望降低迁移门槛，因此保留官方 Playwright；同时希望有更原生的 MCP 操作方式。
- 研发环境覆盖 Windows 与 macOS；正式版须支持 Windows、macOS 与 Linux。
- Chromium 尽量保持上游行为，升级成本可控；对深度定制路线采用按需补丁而非无界修改。

### 1.2 用户痛点

| ID | 问题 | 影响 | ABR 方向 |
|---|---|---|---|
| P-01 | Playwright 脚本执行与用户 GUI 交互存在事件语义差异 | 网站兼容问题、任务失败 | 事件差异基线 + 引擎选择 |
| P-02 | 自动化框架与浏览器版本耦合 | 升级、回归成本高 | 版本锁定与跨平台矩阵 |
| P-03 | 纯 GUI 自动化定位复杂，焦点/缩放会变化 | 误点击、不可恢复 | 观察与行动分离、重验目标 |
| P-04 | AI Agent 缺少统一易用的浏览器工具 | 实施成本高 | MCP 工具与独立 Browser API |
| P-05 | 用户不知道某条操作是否具有 GUI 语义 | 对可靠性的预期失真 | 能力声明及执行路径溯源 |
| P-06 | 深度修改 Chromium 破坏原版行为的风险 | 维护和安全负担 | A/B 回归与补丁治理 |

### 1.3 产品定位

**一句话：** 兼容 Playwright 的、跨平台的 AI Agent 高保真浏览器运行时。

**对开发者的价值主张：** 可继续使用现有 Playwright，同时逐步采用为 GUI 操作设计的 MCP/Browser API；每次操作均知道使用了何种执行引擎、可观察到什么差异、是否成功完成授权任务。

**对组织的价值主张：** 本地优先、明确授权、配置隔离、操作留痕、可交接、可升级。

### 1.4 明确不做的事

- 不承诺“不被任何网站检测”“100% 绕过风控”或自动处理 CAPTCHA、访问频率限制、服务端账号控制。
- 不默认提供代理池、账号批量养号、指纹随机化、绕过身份验证等业务功能。
- 不通过全局篡改 `isTrusted`、User Activation、安全沙箱或 Web 标准来伪装可信输入。
- 不将任意 Playwright `evaluate()` 或网络路由操作描述为人工 GUI 等价。
- 不为首版开发一个取代 Blink/V8/Network Service 的浏览器引擎。
- 不默认连接用户的常用 Chrome Profile 或导出密码、Cookie、访问令牌。

## 2. 目标用户、使用场景与用户故事

### 2.1 人群

| 人群 | 现有工具 | 要完成的任务 | 首选引擎 |
|---|---|---|---|
| Playwright 开发者 | Playwright 脚本/测试工程 | 复用现有脚本，诊断兼容问题 | A |
| AI Agent 开发者 | MCP 客户端、编排框架 | 观察网页、执行点击/输入等授权操作 | B |
| 企业 RPA/复杂网页开发者 | ERP/SaaS/内部网页 | 控制可登录桌面环境，可靠处理控件 | B/C |
| 浏览器基础设施团队 | 自有产品 | 集成原生浏览器观察与管理 | C |
| QA/兼容性工程师 | 浏览器自动化 | 比较人工 GUI 与自动化的事件差异 | A/B/C |

### 2.2 主流程用户故事

- US-01：作为 Playwright 用户，我希望选择 ABR 管理的 Compatible 会话，继续运行官方 Playwright 测试，以便低成本迁移。
- US-02：作为 Agent 开发者，我希望使用标准 MCP 启动浏览器、观察可访问树、点击元素、输入文字、截图，以便编排网页工作流。
- US-03：作为使用者，我希望选定 GUI 模式后，该模式不得偷偷回退到 DOM Script；不支持的能力必须显式失败。
- US-04：作为 QA，我希望在自己搭建的事件测试页比较人工、原版 Playwright、ABR GUI 与 ABR Native 四种轨迹，并输出差异报告。
- US-05：作为管理员，我希望所有浏览器 Profile 互相隔离，操作有审批，敏感输入与截图可脱敏。
- US-06：作为发布工程师，我希望在每次 Chromium 更新后重跑同一套测试并明确哪些差异改变。
- US-07：作为开发者，我希望启动多个 Compatible 后台会话，但 GUI 模式在同一图形桌面只允许一个活动输入所有者。
- US-08：作为研发人员，我希望 Chromium Native 不可用时可以清楚报告缺少能力，而不是强制重写 Blink 或回退到其他模式。

## 3. 范围和发布路线

### 3.1 三种执行引擎

| 标识 | 命名 | 描述 | 允许的底层执行 | 重要边界 |
|---|---|---|---|---|
| `compatible` | Playwright Compatible | 使用官方 Playwright；可以启动标准 Chrome/Chromium 或独立补丁的 Chromium | CDP/Playwright 既有语义 | 兼容 ≠ GUI 等价 |
| `gui` | Native GUI | 自研 Browser API + 系统截图/AX + 系统鼠标键盘 | OS 原生输入接口 | 不支持绕过 GUI 的脚本替代 |
| `native` | Chromium Native | Chromium 浏览器进程内只读观察/窗口管理 + 自研 Browser API | 原生浏览器观察 + 首选 OS GUI 输入 | Chromium 补丁须受控 |

A 线路内部研发支线：`A1=对照结果分析/限定补丁`；`A2=对具备 GUI 语义的命令进行输入重定向的可行性实验`。两者由独立 feature flag 驱动，不作为 v1.0 必需前置。

### 3.2 迭代交付门槛

| 里程碑 | 强制交付 | 非强制交付 | 退出门槛 |
|---|---|---|---|
| M0：仓库与契约 | Monorepo、Schema、mock 引擎、CI、事件测试页 | 正式 Chrome 修改 | 接口与 mock contract tests 全通过 |
| M1：Compatible MVP | 官方 Playwright 启动/关闭、navigate、screenshot、click、输入、MCP | 自定义 Chromium 补丁 | 已有 Playwright smoke tests、MCP E2E 全通过 |
| M2：GUI MVP | Win/macOS：AX、截图、前台点击、按键、滚动、观察、错误恢复 | Wayland 完整支持 | 各平台人工 GUI 对照基线通过 |
| M3：Linux GUI | Ubuntu X11 输入/AX/截图；Wayland 授权通道 | 任意发行版全覆盖 | X11 验收通过，Wayland 明确能力报告 |
| M4：Chromium Native | 同一上游版本、最小 Browser 层只读观察接口、原生桥接 | 大规模 Blink 改造 | 对照回归和权限检查通过 |
| M5：Playwright A1/A2 研究 | 差异矩阵、逐项可行性评估、补丁实验与风险结论 | “全 API GUI 等价”宣称 | 每一处补丁都有测试与回滚方案 |
| M6：发布 | 安装包、签名、公测文档、升级工具、审计/安全 | 云端多租户 | 三平台发布门槛全满足 |

> Windows/macOS 可作为首轮有界面 GUI 开发；Linux 在 M3 补足。Native 路线从 M4 开始，不阻塞 M1/M2 的可用性。

### 3.3 v1.0 必须覆盖的功能

- 创建/列举/关闭浏览器会话，选择三种引擎之一；配置独立持久/临时 Profile。
- 通过 MCP 列举工具并执行会话、截图、观察、点击、输入、按键、滚动、等待、浏览器导航和标签页管理。
- 可获取能力矩阵；未实现能力显式返回 `UNSUPPORTED_CAPABILITY`。
- GUI 模式始终经窗口/系统输入路径，不隐式执行 DOM JS；如控件不可达，明确报告需人工接管。
- 将截图、AX 快照、动作日志与事件对照记录按会话管理，并提供受控保留/删除设置。
- 敏感操作（提交付款、发送消息、上传文件、授权权限等）可在产品政策下要求批准。
- 对照测试页记录可信属性、Pointer/Keyboard/Input/Composition/Focus/Selection/User Activation、窗口状态与最终结果。
- 每次构建与发布记录 OS、架构、浏览器 commit、Playwright 版本、MCP SDK 版本及 Patch Set。

### 3.4 v1.0 不包含

- 多节点云端浏览器池、收费结算、组织 SSO、分布式任务调度。
- 在一个没有真实桌面会话的 Linux 容器内承诺 GUI 等价。
- 用户无确认情况下从脚本中自动抽取浏览器密码、Cookie 或系统隐私文件。
- 操作系统权限弹窗、验证码、网站登录校验的静默绕过。

## 4. 需求清单（编号即追踪 ID）

### 4.1 核心和兼容性需求

| 需求 | 优先级 | 可验收描述 |
|---|---|---|
| RPD-001 统一会话 | P0 | 可创建 `compatible/gui/native` 会话，状态机可查询；不存在时返回类型化错误 |
| RPD-002 明确引擎 | P0 | 会话创建后固定执行引擎，运行中不静默切换 |
| RPD-003 能力协商 | P0 | 每次会话返回 supported/unsupported capabilities 和 reason |
| RPD-004 官方 Playwright | P0 | Compatible 模式由未修改的官方 Playwright 包执行；锁版本并运行 smoke suite |
| RPD-005 Playwright 路径 | P0 | 支持捆绑 Chromium、有独立 Profile 的 Chrome、可选 `executablePath`；CDP attach 属于单独降级模式 |
| RPD-006 GUI 核心操作 | P0 | 点击、按键、输入、滚动、截图、观察、导航可以顺序完成并验证结果 |
| RPD-007 界面目标引用 | P0 | AX 元素引用包含快照 ID，旧快照不可悄悄执行 |
| RPD-008 错误分类 | P0 | 统一错误码、可重试属性、人工介入建议 |
| RPD-009 操作溯源 | P0 | 操作结果可指出执行引擎、底层输入路径、快照/动作 ID |
| RPD-010 用户可介入 | P0 | GUI 会话可以暂停/恢复；用户接管时释放自动化输入锁 |
| RPD-011 跨平台 | P0 | Windows x64、macOS arm64、Linux x64 在支持矩阵中有明确状态 |
| RPD-012 原生观察 | P1 | Native 模式能通过浏览器进程只读读取 AX/标签页数据，不篡改网页 |
| RPD-013 研究型补丁 | P2 | A1/A2 补丁只允许试验通道，具版本锁定、差异验证及一键关闭 |

### 4.2 安全、隐私与质量要求

| 需求 | 优先级 | 可验收描述 |
|---|---|---|
| RPD-020 本地默认 | P0 | MCP 默认 stdio；守护进程仅通过当前用户可访问的本地 IPC 通道 |
| RPD-021 权限确认 | P0 | 上传文件、发送消息、付款、删除等高风险动作需策略审批或人确认 |
| RPD-022 域名政策 | P0 | 支持允许/拒绝域名配置；禁止对未授权目标执行动作 |
| RPD-023 Profile 隔离 | P0 | 每会话有独立数据目录；禁止自动附着到默认用户 Chrome Profile |
| RPD-024 数据脱敏 | P0 | 密码框、信用卡等字段不输出原值；截图和日志可配置敏感区遮盖 |
| RPD-025 本地 Agent 安全 | P0 | IPC 不接受公网连接；进程身份验证；路径验证；最大请求限制 |
| RPD-026 可观测性 | P0 | 结构化日志（不含机密）、请求链路、错误原因、运行事件 |
| RPD-027 版本锁定 | P0 | 浏览器 commit、Playwright 版本、Node/Rust 版本、Patch SHA 全可复现 |
| RPD-028 GUI 回归 | P0 | 同版本/同平台人工 GUI 与引擎各自记录测试轨迹并形成差异结果 |
| RPD-029 安全边界 | P0 | 不修改 Blink `isTrusted` 规则、User Activation 授权规则及 Chromium sandbox |
| RPD-030 窗口独占 | P0 | 同一桌面会话一次只有一个 GUI 动作输入所有者；竞争请求按策略排队/失败 |
| RPD-031 安装/卸载 | P1 | 不改变用户原有 Chrome 配置；卸载可选择保留或安全删除 ABR Profile |
| RPD-032 Chromium 升级 | P1 | 上游 tag/commit 定位、补丁重放、构建和四组回归检查均可审计 |

## 5. 用户交互与 API 表面

### 5.1 入门流程

1. 安装 ABR 并运行 `abr doctor`，核对本机 Chrome、图形桌面权限、受支持的输入后端。
2. 运行 `abr init` 创建默认配置与独立 Profile 根目录（不得覆盖已有文件）。
3. 选择执行引擎：`compatible`、`gui` 或 `native`。
4. 将 ABR MCP Server 配置到 AI 客户端；启动后通过 `browser_capabilities` 查看支持的功能。
5. Agent 创建会话并执行只读观察；首次敏感动作触发权限确认。
6. 任务完成后关闭会话或保留会话；用户可以查看动作轨迹与故障原因。

### 5.2 引擎切换原则

- 引擎只能在 `createSession` 时选择；切换需要创建新会话。
- 不可将原有浏览器进程的 CDP/AX 句柄“无缝转换”为另一引擎而不告知用户。
- Profile 可经显式策略进行导入/复用，但默认不共享，绝不在同时运行的进程间共用同一用户数据目录。
- GUI/Native 模式不允许自动切换到 Compatible 执行仅用于成功率的 JavaScript 操作。

### 5.3 失败与人工接管体验

- `PERMISSION_REQUIRED`：操作系统屏幕录制/辅助功能或门户授权缺失，提供设置说明。
- `TARGET_STALE`：页面布局变更，返回新快照 ID 并要求重新定位。
- `FOCUS_LOST`：其他窗口抢焦点，停止输入并要求恢复窗口。
- `UNSUPPORTED_CAPABILITY`：目前所选引擎无法保证执行语义，不自动降级。
- `APPROVAL_REQUIRED`：动作需要用户批准；在确认前不能执行。
- `INPUT_BACKEND_UNAVAILABLE`：Wayland 未提供可用 Portal/输入通道。
- `BROWSER_DISCONNECTED`：进程退出或连接失效，保留错误诊断并释放资源。

## 6. 操作能力与验收标准

### 6.1 MVP 能力矩阵

| 操作 | Compatible | GUI | Native |
|---|---|---|---|
| 启动/关闭/截图/导航 | 必须 | 必须 | M4 后必须 |
| AX/截图观察 | Playwright 可提供；标准化结果 | OS AX / 截图 | Chromium AX 快照 |
| 点击/双击/滚动 | 原版 Playwright 语义 | 原生 OS 输入 | 复用 GUI 后端 |
| 逐键与文本输入 | 按 Playwright 方法处理 | 键盘/IME 分语义执行 | 复用 GUI 后端 |
| 下拉/文件对话框 | Playwright 原语义 | 真实控件/系统对话框 | 复用 GUI 后端 |
| 注入脚本/网络拦截 | 可单独启用 | 不支持 | 默认不支持 |
| 后台标签批量操作 | 可支持 | 不保证 | 原生 GUI 语义下不保证 |
| 人工接管 | 可选 | 必须 | 必须 |

### 6.2 GUI 一致性的严格定义

对于可表达为 GUI 的操作，固定以下变量：平台、系统版本、键盘布局、输入法、缩放、浏览器构建、网页 fixture、Profile 初始状态及操作目标。比较由同一 fixture 记录的事件序列和页面状态，必须至少采集：`pointerdown/up`、`mousedown/up`、`click`、`wheel/scroll`、`keydown/up`、`beforeinput/input/change`、`composition*`、`focus/blur`、selection、`navigator.userActivation`、`document.visibilityState`、导航生命周期及最终 DOM。

一旦存在产品不可控制的自然差异（如操作时间、鼠标轨迹）、或系统平台间合理差异，必须记录为“已解释偏差”，不通过修改安全语义掩盖。不得宣称与人工不可区分。

### 6.3 验收测试门槛（内部目标，并非既有表现）

| 维度 | P0 验收门槛 |
|---|---|
| 单元和 schema contract | 全部通过；无 unknown/untyped error 泄露 |
| Compatible smoke | 在锁定浏览器组合上全部 P0 场景通过 |
| GUI 操作可靠性 | 每个平台同一稳定 fixture 的重复验证成功率 ≥95%，累计至少 100 次/平台 |
| 安全权限 | 高风险动作无批准不执行；越界域名全部阻止 |
| 浏览器功能回归 | 同 commit 上游 Chromium A/C 对照无无关功能回归 |
| GUI 事件差异报告 | 每个 P0 操作均产出 pass/diff/not-applicable 三态结论 |
| 会话隔离 | 两个 Profile 的 Cookie/localStorage 测试互不影响 |
| Windows/macOS/Linux | 每个平台至少有可复现的安装、doctor、会话、截图、点击测试 |
| 升级可复现 | 文档中可查构建参数、版本指纹、补丁清单、测试产物 |

> 以上为第一版定义的验收目标；任何真实表现要由 CI 和实际桌面测试数据支持。

## 7. 发布与部署约束

- 默认：本地安装，MCP stdio，守护进程用户态运行；不开公网端口。
- Windows 首发目标 x64；macOS 首发 arm64，x64 后续；Linux 首发 Ubuntu LTS x64 X11，Wayland 单列兼容项目。
- 浏览器来源可以是产品自带 Playwright 匹配 Chromium、用户安装的 Chrome 或可选 ABR Chromium；所有来源必须记录到会话元数据。
- Chromium Native 必须遵守 Chromium 及第三方依赖的许可与公告要求；应用签名/公证、自动更新和安全补丁不应被推迟到生产后。

## 8. 风险、依赖、决策记录

| ID | 风险/问题 | 缓解策略 | 状态 |
|---|---|---|---|
| RISK-01 | 全 Playwright API 不能一般性改写为 GUI | Compatible 保留原始语义；GUI API 独立定义 | 已决策 |
| RISK-02 | Chrome 自定义构建与正式 Chrome 差异 | 产品同时提供外部 GUI 模式 | 已决策 |
| RISK-03 | Wayland 安全限制导致全局输入不可靠 | 走用户批准的 Portal/libei；不支持时显式失败 | 已决策 |
| RISK-04 | 物理键盘、系统合成输入与 CDP 无严格一一对应 | 对照测试，不做绝对无检测承诺 | 已决策 |
| RISK-05 | 用户日常 Profile 的凭据安全 | 只使用独立 Profile，受控导入 | 已决策 |
| RISK-06 | Chromium patch 随上游变动而失效 | patch stack + A/B/C/D 回归 + 发布闸门 | 已决策 |
| RISK-07 | MCP 客户端可被网页中的恶意指令诱导 | 结构化权限、域名策略、敏感动作审批 | 已决策 |
| RISK-08 | 产品范围膨胀导致三条路线无法交付 | 共享底座，按 M0→M6 冻结里程碑 | 已决策 |

## 9. 交付物清单与需求追踪

- 一个 monorepo：MCP SDK、Browser Core、Compatible Worker、Native Agent、Native Chromium Bridge、fixture、CI。
- 发布说明：Quickstart、不同引擎能力矩阵、平台权限引导、故障排查、更新策略。
- 可测试契约：TypeScript `contracts`、IPC schema、错误码、MCP tool schemas、配置文件 schema。
- QA 产物：GUI baseline traces、可比较报告、版本锁定清单、每平台测试录像/截图（受权限和隐私政策控制）。
- 开发工单：技术方案附录中 `TASK-*`，每项映射上述 `RPD-*` 需求与自动测试。

**变更控制：** 对外 API、执行语义、profile 默认配置、权限默认值、补丁位置发生任何变更，都必须同步修改两个文档、测试契约与版本锁定文件。

## 10. 需求验收示例（Given / When / Then）

**AC-01（RPD-002）**：Given GUI 会话已创建；When 收到一个只有 `compatible` 支持的 Evaluate 类操作；Then 返回 `UNSUPPORTED_CAPABILITY`，不得执行 JS，不得悄悄切换引擎。

**AC-02（RPD-007）**：Given 已读取 AX 快照 `s1`；When 页面导航并重排；Then 对 `s1` 的点击返回 `TARGET_STALE` 或经过二次定位后提供新快照引用，而非使用过期坐标点击。

**AC-03（RPD-022）**：Given 用户策略仅允许本地测试域；When Agent 请求打开未允许域并提交表单；Then 策略在导航及执行动作阶段都阻止，并记录审计事件。

**AC-04（RPD-024）**：Given 页面存在密码输入；When 执行 observe 与 screenshot；Then AX/日志不包含输入原值，截图根据安全配置进行模糊/禁止输出，且无永久明文副本。

**AC-05（RPD-030）**：Given 两个 GUI 会话共享一个桌面；When 同时请求输入；Then 只有一个取得输入租约，另一个排队或返回 `DESKTOP_BUSY`，不存在交叉输入。

**AC-06（RPD-032）**：Given 已锁定 Chromium 新 commit；When 应用 patch 并构建三个平台；Then 输出变更 diff、patch 状态、兼容性结果和发布决策记录。

## 11. 官方参考资料（已核对，2026-10-10）

1. Playwright `BrowserType`: https://playwright.dev/docs/api/class-browsertype
2. Playwright 浏览器版本与 Headless 差异: https://playwright.dev/docs/browsers
3. Chrome 136+ 远程调试和用户数据目录约束: https://developer.chrome.com/blog/remote-debugging-port
4. MCP 2026-07-28 工具规范: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
5. MCP TypeScript SDK v2 服务端: https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server
6. Chromium 官方源码和跨平台构建: https://chromium.googlesource.com/chromium/src/+/main/docs/get_the_code.md
7. Windows `SendInput` 和 UIPI: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
8. macOS AX UI: https://developer.apple.com/documentation/applicationservices/1459374-axuielementcreateapplication
9. Linux RemoteDesktop Portal: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html

---

**本 RPD 的范围冻结规则**：当需求与技术实施方式冲突时，首先保持授权、安全、现有浏览器功能与模式语义；不得为了达到“网页检测不到”而破坏 Web 安全机制或默默改变 API 约定。
