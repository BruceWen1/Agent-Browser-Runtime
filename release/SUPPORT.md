# Agent Browser Runtime development distribution

此软件包包含当前平台的 Node runtime、production Node 依赖、共享 JSON contracts 和版本清单。存在已安装的 Playwright Chromium 时，打包程序将对应 revision 的浏览器资源加入软件包。DesktopAgent 仅在提供实际编译产物后加入。所有资产的 SHA256、byte length 和执行权限记录于 `version-manifest.json`。

Windows 使用 `abr.cmd`；macOS/Linux 使用 `./abr`。`version`、`doctor --json` 与 `mcp serve --stdio` 由同一 CLI 执行。启动器先验证完整包内文件清单，MCP stdout 保留协议输出。运行数据默认位于当前用户应用数据目录，使用 `ABR_DATA_DIR` 可显式选择独立测试目录。浏览器 profile、用户配置和 artifacts 保存在安装目录之外。

支持状态：

| Engine     | 实施状态                                                             | 验收状态                                                    |
| ---------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| compatible | 官方 Playwright 1.64.0，按包内 browser revision 或显式安装浏览器运行 | Windows 自有 fixture 自动测试已通过；其他平台实体桌面待验证 |
| gui        | 存在 DesktopAgent 时按运行时 OS 权限、窗口身份和输入能力启用         | 人工 GUI parity baseline 待独立批准                         |
| native     | 定制 Chromium 编译产物与只读 observer bridge 为启用条件              | 当前软件包报告 unavailable                                  |

macOS 截图需要 macOS 14、Accessibility、Input Monitoring 和 Screen Recording 授权。授予权限后重启 Agent。Retina 坐标采用单显示器窗口映射。Linux X11 需要 EWMH window manager、AT-SPI、XTest、XInput2 与 XKB；物理文本当前要求 first keyboard group 和关闭 Caps Lock。Wayland 输入需要授权 Portal stream、浏览器窗口身份绑定和输入设备 grant，能力缺失时产生解释性错误。IME composition 与平台文件选择器按能力分别报告。

升级采用安装根目录内的 content-addressed `versions/`。`maintenance/update.mjs install --root <installation-root> --archive <local-package.zip> --sha256 <verified-digest> --allow-unsigned-development` 校验 ZIP、platform、protocol major、逐文件 inventory 和显式 development 选择后原子切换 `active-release.json`。`rollback --root <installation-root> --allow-unsigned-development` 重新验证上一版本后切换同一指针。用户运行数据保持独立。中断事务保留旧指针；进程异常退出留下的 `.update.lock` 需要本地核验进程状态后恢复。

Development archive 未获得生产发布批准。生产发布要求独立批准的三平台人工事件基线、精确代码 fingerprint、安全与 license 验收、真实 OS code signing/notarization 和可信 publisher signature。信任密钥通过本地配置指定；正式软件包使用 Ed25519 发布签名及显式 trust anchors 验证。
