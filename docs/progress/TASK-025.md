# TASK-025 版本清单、development packaging 与本地更新

实现状态：release tooling、SBOM、checksum inventory、独立 reviewer/publisher signing gates、三平台 CI 和本地 update/rollback 已实施。包含实际 Chromium/ffmpeg/Winldd 和最新 DesktopAgent 的 Windows development archive 与实际执行 smoke 已通过。正式签名、Native Chromium 编译产物、三平台人工 parity baseline 和 macOS/Linux 实机安装验收待外部构建及授权材料。

`release/package.mjs` 使用已锁定 Node 24.15.0、pnpm 12.10.1 和实际 production dependency graph。它保留可移植 CLI 布局、Node runtime、JSON contracts、实际 DesktopAgent 和可用的官方 Playwright browser assets。Node license 采用固定公开 version、HTTPS 和有限重试。source fingerprint 在构建前后覆盖 Node/Rust source、root/Agent Cargo manifests、root/package tsconfigs、Node/Rust pins、package-manager controls、可选 native build hooks、CI/build/runtime configuration、Chromium bridge/patch/build pipeline、release tooling 与 fixture source，并独立检查 lock SHA256。并行源码或 build control 变化返回 `SOURCE_CHANGED`，docs 和本地 user data 保持排除。

`release/sbom.mjs` 读取实际部署包的名字、版本、license 和 npm lock integrity，并使用 `cargo metadata --locked` 和 Cargo.lock 获取全部 target crate 的准确版本/license/checksum。CycloneDX 1.6 中 npm scope 为实际分发的 runtime graph，Rust target-conditional source inventory 分别标记 optional。版本 manifest 记录 Node、Rust、pnpm、TypeScript、Playwright、MCP SDK、DesktopAgent source/binary 状态、Chromium tag/commit/DEPS/depot-tools/patchset 信息和逐文件 SHA256。包内 `app/chromium/VERSION.lock` 保留 Native configuration 使用的 portable upstream identity。DesktopAgent executable、binary SHA256 与 pin SHA256 单独记录，buildAttestation 保持 null。distribution 状态明确标记 Native unavailable、GUI manual baseline pending。

ZIP writer 生成 deterministic archive，reader 在提取前检查 central/local header 一致性、CRC、长度上限、字节重叠、路径 containment、Windows reserved paths、Unicode/case aliases、file/directory collision 和特殊文件类型。macOS/Linux 保留 sealed bundle 的内部 relative symlink identities，按原始路径分量解析目录 alias 和 suffix 后校验 parent traversal；完整 inventory 验证 target 与 directory graph 的 containment、存在性和循环。路径深度上限为 64，隐式目录节点上限为 50,000；regular-only inventory 直接跳过 alias graph 分配，Windows采用 regular-only members。安装器从单一 bounded descriptor buffer 验证独立 archive SHA256 并解析，避免 checksum/parse 的重复读取竞争。它先验证完整 inventory/platform/protocol/publisher，再将 payload 写入独立 version directory，重新验证后原子替换 active pointer。独立 update lock 保持写入排他性，初始化 IO 失败会关闭并移除本次 exclusive lock；rollback 对 previous payload 重新校验。runtime data 位于版本目录之外。官方 Playwright 可以重新生成声明的零字节 host-dependency-validation marker，其他额外文件与 marker 内容变化会被拒绝。

payload 与 pointer 文件写入后 flush；POSIX 目录在 payload、version rename 和 pointer rename 的相应阶段同步。Windows 当前提供经过测试的 process-failure atomic rename，系统断电持久性保持未验证状态。代码与技术描述明确区分该平台限界。

production signing 要求 clean committed source、实际 Native Chromium build、可信 reviewer 对 exact source/evidence artifact 的 Ed25519 签名、全部 P0 checks 和 Windows x64/macOS arm64/Linux x64 的 GUI/Native manual parity coverage。installer SHA256 由独立 review 绑定到同一 payload inventory。OS verifier 检查 Authenticode certificate identity、Developer ID team/code/package signature/notarization/Gatekeeper 或 Linux GPG trust keyring/fingerprint。protected publisher key对 canonical manifest 进行 Ed25519 签名；缺失必要输入时 production gate 保持 closed。当前流程未签名或发布正式产品。

实际验证命令及结果：

- `node --test release/update.test.mjs`：9 项通过，覆盖 install/replay/update/rollback、preflight isolation、publisher trust、rollback tamper、hostile ZIP/path、missing production evidence、bounded mutable marker、真实 framework 中间 alias/越界/cycle rejection 和 metadata allocation quotas。
- `node --test release/package.test.mjs release/update.test.mjs`：10 项通过。新配置测试在独立 temporary workspace 中改变 10 类有效 build controls，pnpm/Cargo locks 保持相同而 source fingerprint 必须变化；新增 Cargo config 同样改变 fingerprint，docs/.abr user configuration 保持排除。
- `corepack pnpm exec eslint release`、`corepack pnpm exec prettier --check release .github/workflows/release.yml`：通过。
- `node release/ci-target.mjs win32-x64`：通过，target 来自实际 process platform/architecture。
- `node release/ci-production.mjs`：预期退出 1，返回 `RELEASE_GATES_REQUIRED`，保持缺失正式输入的阻止行为。
- `node release/package.mjs --native-agent target/debug/abr-desktop-agent.exe --output .cache/release`：实际生成完整 Windows development ZIP，267,240,365 bytes、2894 ZIP members、2893 inventory members、36 runtime npm entries、117 all-target Rust entries；build/deploy/source-lock validation 全部通过。
- `node release/package-smoke.mjs --archive .cache/release/abr-0.1.0-win32-x64-development-157b7f2891e5.zip --sha256 157b7f2891e51620473da792602d846bbe762761739993ed7d45c258d992d9f5`：通过。实际 archive 在独立标记目录安装；全量 inventory、Native pin、Agent binary identity、包内 Node 24.15.0/MCP 2.3.1、21-tool contract、doctor、重复 launch、exact replay 和 active pointer 稳定均通过；browser launch 数为 0。
- 实际 Chromium PE metadata 为 156.0.8078.4，revision 1248；browser chrome.exe 的 source SHA256 与包内 inventory SHA256 均为 `7f08161bbeb2853ffe1780a9ded4985087f52efb9725d7d8207aabdd42f7cfb9`。ffmpeg revision 1013、Winldd revision 1007 均已分发。archive SHA256 经独立 `Get-FileHash -Algorithm SHA256` 复核通过。
- 三平台 GitHub workflow、macOS/Linux 实机安装、正式 signing/notarization 与 manual-baseline approval：Blocked，当前设备及外部材料尚未满足验收条件。

补充校正：Linux XInput2 将 Hierarchy event mask 分别注册到 all devices，并将 raw event mask 保持在 all master devices。`cargo clippy --workspace --tests --target x86_64-unknown-linux-gnu -- -D warnings` 已通过。Linux 实体桌面验证状态保持 pending。

最新完整开发包：`.cache/release/abr-0.1.0-win32-x64-development-157b7f2891e5.zip`。archive SHA256：`157b7f2891e51620473da792602d846bbe762761739993ed7d45c258d992d9f5`。source code SHA256：`eb58090eae74674babf0017cf95ad3187e43b58df940170f6a7cbb9d66dbe16e`。DesktopAgent binary SHA256：`0246c742567bf770e829c403579d0818332fbf90ca37c308490807a84d875412`。产物与 manifest 均标记 development；Native compiled/available 均为 false，GUI 人工批准和正式发布保持 pending。
