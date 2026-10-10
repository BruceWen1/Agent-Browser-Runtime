# 发布与本地更新

`node release/package.mjs --native-agent target/debug/abr-desktop-agent.exe --output .cache/release` 在 Windows 创建实际 development ZIP。macOS/Linux 的参数使用 `target/release/abr-desktop-agent`。打包先执行 TypeScript build，再以 exact pnpm 版本和 frozen lock 部署 production dependencies。软件包保留独立 CLI 布局、内置当前 pinned Node runtime、JSON contracts、可用的官方 Playwright browser assets 和实际提供的 DesktopAgent。工具读取 Cargo metadata 的全部 target dependency graph，生成 CycloneDX 1.6 SBOM、third-party notice、component versions、lock SHA256、Native patch/depot-tools 状态和逐文件 inventory。

构建命令采用 bounded output/deadline、stderr metadata 和独立暂存目录。Node license 网络读取采用 HTTPS、固定 version 和有限重试。源码与 lock 在打包前后分别校验，发生并行修改时返回 `SOURCE_CHANGED`。development 输出明确记录 Native Chromium unavailable、GUI manual baseline pending 和 production approval pending。`--exclude-browser` 用于快速依赖及 CLI 验证；默认打包包含实际已安装的 Chromium、ffmpeg/Winldd 和可用 headless-shell assets。

`node release/package-smoke.mjs --archive <development.zip> --sha256 <digest>` 将实际 archive 安装到标记的临时目录。验证完整 inventory 后，使用包内 Node 执行 version、21-tool contract 和 doctor，运行数据另置独立测试目录。该验证读取能力与元数据，浏览器实体桌面验证由独立 fixture 流程执行。

`node --test release/update.test.mjs` 验证两个真实 ZIP 的安装、精确 replay、版本更新和 rollback；检查 checksum、platform、major protocol、unsigned opt-in、publisher trust、payload tampering、ZIP symlink/traversal/case aliases 和缺失生产证据的拒绝行为。更新模块从单一 regular-file descriptor 读取有界 archive bytes，对同一 buffer 校验独立 SHA256 anchor并解析。它校验全部 member 后写入同一安装根目录的 side-by-side `versions/`，完成逐文件验证后原子替换 `active-release.json`。rollback 对先前 payload 重新执行完整验证。原有用户运行数据保存在版本目录之外。

macOS/Linux archive 保留 sealed app 的内部相对 symlink identities；target 必须指向同包已有 member 或目录，按原始分量展开目录 alias 后处理 parent traversal，拒绝外部路径、缺失 target、alias chain cycle 和 directory cycle。路径深度上限为 64，隐式目录上限为 50,000；regular-only 包跳过链接图分配。提取先写 regular files，再建立已验证的 links。Windows archive 保持 regular-file-only。payload 文件、pointer 文件均 flush，POSIX 目录按提交顺序同步；Windows 当前提供 process-failure atomic rename，并对系统断电持久性保持未验证状态。

正式签名使用 `node release/sign.mjs`，要求明确的 staging directory、独立 reviewer trust keys、code-bound evidence、真实 platform installer、certificate/team identity 和 protected publisher private key。review evidence 的 payload 由 Ed25519 signer 独立签名，包含当前 git commit、code SHA256 和带 artifact SHA256 的 P0、manual parity 与 installer binding records。P0 records 覆盖 contracts、unit、MCP integration、Compatible E2E、security、license review 和 ordinary/Native regression。manual parity 覆盖 Windows x64、macOS arm64、Linux x64 的 GUI 与 Native 必需 fixture。每项报告保留 manual engine provenance、明确 baseline approval、固定 browser commit、平台与有限 normalization。

Windows installer 验证使用操作系统 Authenticode 和指定 certificate thumbprint；macOS application/package 分别验证 code signature/package signature、指定 Developer ID team、stapled notarization 和 Gatekeeper；Linux package 使用显式 trust keyring 和 GPG fingerprint。独立 installer review 将签名 artifact SHA256 绑定到当前完整 payload inventory。publisher signature 采用 Ed25519，对 complete canonical version manifest 签名。当前缺少已批准的三平台人工基线、Native Chromium 实际编译产物和正式签名材料，production gate 保持 closed。

GitHub workflow 使用 immutable action commit，分别执行三平台原生 build 和 development package smoke。production runner 入口要求 protected external inputs 与 signer material。workflow 的输出为 CI development artifacts；网络发布由独立授权流程执行。当前文件已完成静态验证，远程 runners 待执行。
