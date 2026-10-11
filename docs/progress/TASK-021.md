# TASK-021 Chromium exact-pin 构建管线

需求映射：RPD-032、RPD-027、RPD-029。实现 `chromium/build/common.mjs`、`pipeline.mjs`、边界测试、`VERSION.lock` 与独立构建说明。

`156.0.8078.12` 的 tag 已通过官方 GitHub mirror 和 GoogleSource 核验到完整 commit `634b046faf2137b83af71c87baf362b533af9104`。`verify-upstream` 实际 Git 查询返回精确 SHA；从同一 commit 的官方 mirror 成功读取 192396 bytes DEPS，锁定 SHA-256 为 `b4de748ba5abac43952bdc0945795d9c3a07238d18b37ae0f82231669f68fc94`。官方 depot_tools 实际 clone 的 origin/HEAD 已核验，锁定 `a03dfbf7f2d1cefa2795d81d59ca4f16c8616a8f`，官方隔离 Python bootstrap 已执行成功。原版/补丁编译结果依实际源码阶段记录，保持显式 gate。

管线支持 status/preflight、官方 tag/DEPS 读取、既有 source adopt、官方 fetch/明确 mirror checkout、精确 gclient sync/hooks、browser 层 mailbox patch 验证与 `git am --3way`、原版/补丁 GN/autoninja 与 build manifest。源码、depot_tools 与产物位于显式外部根目录，拒绝空格、shell metacharacters、workspace 内路径、驱动器根和目录重定向。Manifest 绑定 origin、HEAD、DEPS、depot_tools、patch SHA、GN 与实际 binary digest。

当前 Windows toolchain gate 全部通过：x64/NTFS、20 logical CPUs、39.75 GiB RAM、Visual Studio 18.6.11806.211、ATL/MFC，以及实际 SDK/DebugTools 10.0.28000.2957。最初 10.0.28000.1839 SDK 和缺失 debugger 的 probe 保留为历史 audit，官方签名 SDK 更新后的 probe 记录 ready。源码位于配置的独立本地工作目录，应用仓库保持独立。macOS 原生 Xcode/SDK/APFS 检测以及锁定 SDK GN 配置读取已实现；Linux 使用 exact source 的官方只读 quick-check 进行包依赖检测。两平台需要真实 runner 数据，当前 physical validation pending。

验证：`node --check chromium/build/common.mjs`、`node --check chromium/build/pipeline.mjs`、针对 `chromium/build`/`experiments` 的 ESLint/Prettier、`node --test chromium/build/pipeline.test.mjs experiments/research.test.mjs` 通过。共 5 个 Node 场景验证 exact lock、数值版本、path/patch gate、实际子进程成功/失败/缺失/deadline、日志字节/digest 隐私和研究边界。

Deadline 只停止本阶段创建的进程树，并等待关闭后释放 cwd 句柄。执行日志保存安全元数据和完整输出 SHA；原始输出与 URL query 排除于诊断。失败或 patch conflict 保留实际状态，后续阶段根据 gate 拒绝执行。

本任务状态为工具实现和 Windows preflight 完成，源码同步、DEPS/tool pin、Chromium 原版/补丁编译、A/B/C/D 同构建回归保持独立验证状态。

后续实际准备记录：完整 source checkout 的 HEAD、clean state 和 DEPS 校验及 adopt 通过；官方 SDK/DebugTools 更新到 10.0.28000.2957 后 preflight 全部 gate 通过。官方 Windows bootstrap 已生成 git.bat，Root 对 source 同步采用 no-history 和限定并发。源码目录从发生实际 IO 压力的同步目录迁移到独立本地目录，pin、DEPS 与 marker 保持一致。未生成成功 build manifest，当前源码阶段状态与实际编译状态分别保留。

当前 mailbox 锁定 SHA-256 `88d988d3012bff214b1f01826cfe42f608d7c813d49ac661fc70f3a4ea0a74f4`，大小 78432 bytes；实际 checksum/scope 验证以及 locked upstream 独立 Git index apply-check 通过。只读桥通过公开 accessibility facade 获取平台 API，GN 依赖遵守上游 target visibility。敏感字段分类、闭合 pattern 校验及双向 HMAC transcript 通过独立实际 C++ 编译运行检查；生产 transport 编译单元完成锁定头文件下的语法检查。Source/hooks/build 采用 owned process tree deadline、已识别工具错误的固定类别和真实磁盘保留监测。初始准备门槛与构建阶段剩余空间估计独立记录。

中断同步恢复已在实际源码验证：parent origin/HEAD/DEPS 保持正确；两项 gitlink 状态和 V8/TensorFlow 的 `_gclient_*` 临时 clone 通过 pinned DEPS scope/独立 Git root/origin 校验。sync-resume 专用模式保留未知数据与 root tracked 变更的拒绝 gate，采用官方隔离 Python `-I` 调用 pinned gclient_eval。正式 sync 成功后在 hooks 前验证 parent 和 initialized dependency exact revision/clean state。新增边界测试覆盖 root 文件修改、未知 untracked、错配临时 scope 与错误 gitlink revision；当前 Node 6 tests、ESLint/format 通过。该恢复校验没有 reset/remove 操作。

阶段预算增量保留 VERSION.lock 的 100 GiB 初始准备门槛及固定 GN 参数。首次 original 预算使用 `max(20, 100 - S - O + 20)`，S 为包含 Hidden Git/deps、排除根 out 的 active source storage，O 为当前 original output。S 达到 100 时返回 unresolved，预算记录 `estimate-unverified` 与 `capacityVerified=false`。patched 使用精确匹配 original 完整输出测量加 25% 和 20 GiB，再扣已有 patched output。计量限定同 owned root/filesystem，Windows 使用原生目录元数据枚举、长路径和显式剪枝，单次期限 120 秒。包内链接与构建日志别名保持独立 opaque 条目，其目标及链接存储量均从扣减估计排除。隐藏数据、根 out 排除及链接目标隔离由实际临时文件系统测试验证。实时 20 GiB reserve 保持。

已验收 existing source 的同步和 hooks 使用独立新鲜 native toolchain/内存/20 GiB 阶段 gate。官方同步 exit 0 生成绑定 source/DEPS/depot_tools/host/revision 和三个配置/marker SHA256 的 append-only完成凭据。closed hooks 入口校验匹配凭据及完整 selected Git scope 的 presence/ownroot/origin/HEAD/clean；sync 复用同一 hooks 实现。官方 gclient 的 previous-sync 元数据由本次进程继承已验证原值，保留 runhooks 的完成 marker。工具 receipt 保留安全元数据与摘要。

实际外部源码只读验收已覆盖 156 个 selected Git scopes（含 parent）、7 个递归父 DEPS blob 的 exact HEAD 与声明；Git集合、存在、root/origin/HEAD/clean全部通过，官方 `--nohooks` 同步记录 exit 0。当前 entries/config/previous marker SHA256 分别为 `e892b01755dcfd03cec8568cfd10bbc3e64d5ebcb88fe30f34e3c4d66cfcccb5`、`d622261512b1c1c2294623654741eb17824530056801ed9c7d07a5d84d614eff`、`2f6fd69b1279d702be0912299714aa70ce54ea1dc2558e35e11387c2370b4c2b`。DEPS parser 接受官方 MutableMapping 类型，覆盖字典型 Git 声明。

增量验证命令：`node --test chromium/build/budget.test.mjs chromium/build/pipeline.test.mjs experiments/research.test.mjs`：12 个测试通过；预算场景使用临时 owned 小目录及明确 test metadata。所属 ESLint、Prettier、`node --check` 和 `git diff --check` 通过。本轮未执行大源码计量、hooks、Chromium 编译或实体 GUI；后续真实阶段依据新命令生成各自凭据。

最新真实阶段：官方同步及 hooks 均返回 exit 0，完成凭据绑定 156 个 selected Git scopes 和 89 项官方 CIPD marker；直接 Git 声明检查包含 143 个已初始化条目。hooks 完成时间为 2026-10-10 12:41:39 UTC。首次源码计量为 38485397219 bytes，约 35.84 GiB；上游 Node package link 和 Siso 日志别名采用 opaque 统计。原版 GN generation 与全量编译均已通过。

原版完成凭据为外部构建根目录下 `audit/build-original-1791675244297.json`，state=compiled，完成时间 2026-10-10 23:34:04 UTC，即 2026-10-11 07:34:04 Asia/Shanghai。PE 实际版本为 156.0.8078.12，source/DEPS/depot_tools/GN 与锁定值一致，完整输出测量为 11869252851 bytes。`out/ABROriginal/chrome.exe` 为 4200448 bytes，SHA-256 为 `285c11b6df4525a1d6d109063c36eb25bb859ebbc804cd3e212358af09ba6945`；`chrome.dll` 为 462582272 bytes，SHA-256 为 `a4170598db0ba8caf3d307a0b9aaf014b70caf6e9236965a63c0be003fe74003`。独立实际测量与 manifest 相同，对应 owned process tree 已确认关闭。同版本 Playwright、人工事件对照及正式发布仍为独立验收条件。

定制版在验证原版完整输出、33.8176289 GiB 剩余空间预算及实际 83.7540588 GiB 可用空间后，按原 mailbox 进行 `git am --3way`，生成 applied-patches receipt。初次构建的 AppContainer ACL 步骤发生官方隔离 Python UTF-8 与本机 icacls 输出编码不一致；仅以进程局部 `PYTHONUTF8=0` 执行官方 `obj/build/config/win/acls.stamp` 目标，实际 ACL 操作 exit 0 后生成 stamp，后续恢复原环境和相同 GN。源码、补丁摘要及系统全局配置保持原有状态。

随后定制版 8 jobs 阶段于 2026-10-11 07:59:55 Asia/Shanghai 返回 `0xc000012d` 与 LLVM out-of-memory。确认的所有 owned 构建进程已结束，原版、定制版部分输出、日志与缓存完整保留。后验系统提交上限为 42.25 GiB，分页文件为 2.5 GiB；13:03 的提交量为 34.45 GiB。后续恢复采用 2 jobs 和原有 86400 秒期限、固定 GN、完整源码及实时 20 GiB 磁盘保留规则，成功状态由新 compiled manifest 确认。

原版同构建 Compatible smoke 已完成：独立回执为外部构建根目录下 `audit/compatible-original-1791695996787-a55db976-cc31-4e72-9c4d-50b2036dbc66.json`，state=passed，2026-10-11 13:19:56 Asia/Shanghai 完成，耗时 13.568 秒。实际生产 CompatibleEngine、Core Runtime/Policy 和官方 Playwright 1.64.0 启动 156.0.8078.12 单个 headless 浏览器根进程，7 项检查通过，涵盖授权 loopback 导航、AX 与计数初态、单次按钮计数 0 到 1、键盘输入的观察结果、PNG 格式与敏感内容隐私，以及全部 context/profile/worker/浏览器进程和临时资源清理。输入动作 provenance 为 playwright-cdp；6615 个受保护输入框内部像素均为 opaque-black，截图在内存验证。残留自有浏览器进程为 0。

首个验证 helper 将 Chromium 子进程数量作为浏览器数量，导航前返回 ERR_ASSERTION；修正为单个浏览器根进程及其自有子进程后，完整 smoke 通过。首轮实际 EXE hash 与 manifest 匹配，后续验证相同 size/mtime；DLL identity 使用已验证 hash 及一致 metadata。原版 compiled manifest SHA-256 保持 `38530ae8897700077cd2d8d4cbe507ea4e8a32b055fc970bdcd945b9d1d6b7f0`，两次验证回执独立保存，人工 GUI parity、Native observer 和签名状态继续保持 pending。

定制版低并发恢复于 2026-10-11 13:05 进入实际编译。2026-10-11 12:22:33 UTC，即 20:22:33 Asia/Shanghai，只读进度为 done=27833、total=60887、skipped=36310、remaining=33054。2026-10-11 16:18:45 UTC，即 2026-10-12 00:18:45 Asia/Shanghai，进度为 done=35689、total=60227、skipped=36970、remaining=24538；唯一构建进程仍运行，GN、source、patch 与 2 jobs 参数保持。独立全局提交内存采样采用 5 秒间隔，采样峰值和最小余量分别记录；系统提交上限及分页文件实际分配量在运行中发生变化，构建工具保持原有系统设置。最新完成状态仍等待定制版 compiled manifest。
