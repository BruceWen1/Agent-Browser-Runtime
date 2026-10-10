# Chromium 源码与构建管线

源码在显式配置的外部目录中维护，源目录和 depot_tools 目录使用无空格的本地路径。应用仓库保存精确版本、可重放补丁与构建工具。`VERSION.lock` 使用 JSON 格式，包含 upstream tag/commit、DEPS 和 depot_tools 摘要、补丁顺序与目标平台。

当前 tag `156.0.8078.12` 对应 commit `634b046faf2137b83af71c87baf362b533af9104`，tag 已通过 Chromium 官方 GitHub mirror 和 GoogleSource 核对。DEPS 已从该 commit 的官方 mirror 读取并锁定为 `b4de748ba5abac43952bdc0945795d9c3a07238d18b37ae0f82231669f68fc94`。mirror 选择使用显式 `--source-origin mirror` 并进入 audit/source manifest。官方 depot_tools 已按实际 clone 锁定 commit `a03dfbf7f2d1cefa2795d81d59ca4f16c8616a8f`；实际同构建 Playwright 回归单独记录。

以下命令使用已配置的 `$env:ABR_CHROMIUM_ROOT`；默认源码子目录为 `src`，可使用 `--source-dir` 指向同一外部根目录内的已准备 checkout。

```powershell
node chromium/build/pipeline.mjs status --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror
node chromium/build/pipeline.mjs preflight --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror
node chromium/build/pipeline.mjs verify-upstream --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror
node chromium/build/pipeline.mjs verify-source --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror
node chromium/build/pipeline.mjs verify-patches --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror
```

准备新的目录使用 `checkout`。上游路径运行官方 `fetch --nohooks --no-history chromium`；mirror 路径使用同一官方 gclient solution 和精确 tag clone。准备期间的 Git 与 HTTPS 查询保留 TLS 校验，采用限定重试和 deadline。已有精确 source checkout 使用 `adopt` 核验 origin、HEAD、clean state 和 DEPS，然后建立归属 marker，源码内容保持完整。

Windows 初始准备 gate 核验 x64/NTFS、内存至少 8 GiB、源码卷可用空间至少 100 GiB、Visual Studio >=18.0.0、ATL/MFC、Windows SDK >=10.0.28000.2270 与 Debug Tools >=10.0.26100.3323。SDK 使用实际 rc.exe 版本，debugger 使用实际 dbghelp.dll 版本；目录存在状态单独用于准备判断。macOS 检测原生 Xcode、SDK 与 APFS，并从锁定 commit 的 SDK GN 配置读取最低版本。Linux 在 exact source 校验后运行该 pin 的官方只读 `--quick-check`，缺失 package 或上游未声明该选项时保持 blocked；fresh checkout 的资源 gate 与 build dependency gate 分别记录。macOS/Linux 实机证据保持独立 pending。

```powershell
node chromium/build/pipeline.mjs adopt --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror
node chromium/build/pipeline.mjs sync --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror --timeout-seconds 21600
node chromium/build/pipeline.mjs hooks --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror --timeout-seconds 21600
node chromium/build/pipeline.mjs build --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror --variant original --jobs 8 --timeout-seconds 21600
node chromium/build/pipeline.mjs apply-patches --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror
node chromium/build/pipeline.mjs build --checkout-root "$env:ABR_CHROMIUM_ROOT" --source-origin mirror --variant patched --jobs 8 --timeout-seconds 21600
```

`sync` 在 origin/HEAD/DEPS/depot_tools/归属/平台 gate 通过后运行精确 revision 的 `gclient sync --nohooks --no-history --jobs=8` 和 `gclient runhooks`。Windows 在生成的 git.bat 缺失时执行该 pin 的 `bootstrap/win_tools.bat`，生成 Git/Python wrappers，并重新核验 depot_tools HEAD/跟踪文件保持一致。depot_tools 的 Python 属于已批准的官方隔离工具链；进程环境使用独立 PATH，保持用户系统配置。

已有精确 owned source 的 `sync` 阶段采用新鲜 SDK、内存和至少 20 GiB 空间的独立 gate，并在运行期间监测相同 reserve。官方同步 exit 0 后生成 append-only `sync-complete-<timestamp>.json`，绑定 source/DEPS/depot_tools/host、精确 revision 以及 `.gclient`、`.gclient_entries`、`.gclient_previous_sync_commits` 的 SHA256。工具证据保存完成状态、返回码、耗时与输出摘要。

`hooks` 是已完成同步的独立恢复入口。它要求当前完成凭据匹配，并根据官方 literal parser 的 selected entries 和 previous commits 核验完整 Git scope 集合、目录存在、独立 Git root、origin、HEAD 和 clean state。已初始化目录计数提供附加观察证据。CIPD 完成证据由官方同步 exit 0 与绑定 marker 提供。该阶段重新执行原生 toolchain/resource gate，保留至少 20 GiB 和实时监控；官方 runhooks 接收本次进程内已核验的 previous-sync 元数据，保持完成 marker。hooks 成功后写独立 receipt。`sync` 自动调用同一 hooks 实现；hooks 失败时可在问题解决后单独运行该入口。

中断恢复使用独立的 sync-resume 校验：parent tracked content 保持 exact pin，变更仅允许 DEPS 声明的 Git link；`_gclient_<destination>_<suffix>` 临时目录须匹配 pinned destination、独立 Git root 和 expected origin。DEPS 通过 pinned gclient_eval 与官方隔离 Python `-I` 解析，工作目录和环境模块排除于解析器导入路径。恢复阶段保留原有内容和 Git 状态。官方 sync 成功后，hooks 前重新验证 parent clean，以及所有已初始化依赖的 origin、exact revision 和 clean state。Root 源码修改、未知 untracked 数据及未匹配临时 clone 均保留为显式 review gate。

补丁为 `git am --3way` 可读取的 mailbox 文件。Manifest 必须声明 `file`、64 位 `sha256`、`scope: browser-readonly` 和逐文件/目录 `allowedPaths`。路径相对于 `chromium/`。修改路径限于 manifest 指定的 browser 层；Renderer、Blink、V8、sandbox 和网络服务路径排除于该管线。冲突停止应用，保留实际 Git 状态供后续处理。新的 pin 或 patchset 使用新的工作目录和审核记录。

原版和补丁构建分别使用 `out/ABROriginal` 与 `out/ABRPatched`。GN 参数写入 `args.gn`，现有输出目录仅复用完全相同的配置。补丁构建显式启用 `abr_native_observer=true`。原版 HEAD 要求等于 upstream commit；补丁 HEAD 要求与已验证应用 receipt 相等，并具有相同 upstream ancestry 和 DEPS。

显式 preflight、fresh checkout 和 adopt 保留初始 100 GiB 准备门槛。首次 original build 使用该值作为完整工作区规划基数 W；S 为含隐藏 `.git` 和 deps 的 active source storage，排除根目录整个 `out`；O 为已有 original output。所需剩余空间为 `max(20, W - S - O + 20)` GiB。Windows 计量显式包含 Hidden 项、逐级排除根 `out`、拒绝 reparse；计量范围限制在同一 owned root 和 filesystem，单次期限 120 秒。S 达到 W 时预算保持 unresolved。记录使用 `estimate-unverified` 和 `capacityVerified=false`，用于有界阶段 admission。

完成的原版 manifest 记录完整本地输出存储量，后续相同 source/DEPS/toolchain/GN/platform 的小范围补丁构建使用 `max(20, original * 1.25 + 20 - existingPatched)`。精确匹配的原版测量缺失时 patched budget 保持 unresolved。预算包括对象、库、生成文件、符号与链接产物；当前锁定 Windows symbol_level=0 仍生成链接 PDB。源同步/hooks/build 每 5 秒实际查询磁盘可用空间，低于 20 GiB 只终止本阶段 owned 子进程树。原版和补丁的完整输出保留独立、可核验的生命周期。

每阶段记录安全 JSON audit、tool 返回码、输出字节数和 SHA-256、耗时与资源 gate。缺失官方 git.bat、工具依赖、TLS、网络 timeout、磁盘和权限错误归类为固定 code，仅保留已知工具名称。命令原始输出、环境机密和完整网络 query 排除于诊断。deadline 终止该阶段创建的子进程树，等实际句柄释放后报告失败。构建完成后保存 binary digest、实际 source/patch/toolchain/GN/version manifest；Compiled、Compatible smoke、人工 GUI parity、Native Observer、安全审核和签名发布分别记录。

```powershell
node --test chromium/build/budget.test.mjs chromium/build/pipeline.test.mjs experiments/research.test.mjs
corepack pnpm exec eslint chromium/build experiments
```

当前边界测试验证 exact pin、版本排序、路径/patch containment、真实 subprocess deadline、错误与诊断隐私，以及临时 owned 目录的 Hidden storage/out pruning、首次预算 unresolved、阶段 reserve、同 pin 输出匹配和完整同步 marker/receipt 边界。Windows preflight 已在当前设备执行；源码同步、hooks、原版/补丁编译和同构建平台回归依各阶段实际 manifest 记录。
