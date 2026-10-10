# NativeObserver v1

观察服务运行于浏览器进程。浏览器 UI 线程提供只读窗口、标签、可访问性节点和 viewport 元数据，专用工作线程处理受保护的本机 IPC。输入由运行时的系统桌面后端承担。

上游身份为 `156.0.8078.12`，commit 为 `634b046faf2137b83af71c87baf362b533af9104`。构建参数 `abr_native_observer=true` 编译观察服务；默认值为 false。浏览器启动参数 `--abr-observer` 启用服务，`--user-data-dir` 指定独立浏览器数据目录，`--force-renderer-accessibility` 提供浏览器缓存 AX 状态。

浏览器创建后调用 StartNativeObserver，浏览器主消息循环退出时调用 StopNativeObserver。服务停止标志终止等待中的连接、读写和 UI 回调等待，工作线程退出后进入浏览器状态清理。

## 启动与认证

控制器将以下 JSON 通过独立继承 stdin 管道写入，并以换行结束。启动消息最多 4096 字节。

```json
{
  "schemaVersion": 1,
  "secret": "64 lowercase hexadecimal characters",
  "endpoint": "platform-specific private endpoint",
  "profileId": "ephemeral-example",
  "parentPid": 1234
}
```

profileId 必须与浏览器数据目录中 `.abr-profile.json` 的 `name` 字段一致，标记的 schemaVersion 为 1。服务仅访问该目录下的浏览器 profile，默认 profile 的目录结构为 `Default/`。Incognito profile 具有独立上下文，观察服务限定常规 profile。

Windows endpoint 格式为 `\\.\pipe\abr-observer-<opaque-id>`。命名管道设置当前用户 SID 的显式 DACL，拒绝远程连接，并校验连接进程 PID 与 parentPid 一致。Unix endpoint 是当前用户所有、权限 0700 的 runtime 目录下的 socket，文件权限为 0600；连接校验当前用户和控制器 PID。每个服务接受一个控制器。

stdout 输出一行启动元数据，包含 schemaVersion、protocolVersion、authVersion、endpoint、profileId、pid、observerVersion、browserVersion 和 browserCommit。控制器保留浏览器 stderr 的原始诊断于浏览器进程边界内，通过运行时提供安全诊断字段。

私有认证版本为 `authVersion=2`；消息外层的 `schemaVersion=1` 与 `protocolVersion=1` 保持一致。控制器连接后发送 `observer.challenge`，params 的完整字段为 `authVersion: 2` 与 `clientNonce`。成功 result 的完整字段为 `authVersion: 2`、`serverPid`、`clientNonce`、`serverNonce` 与 `serverProof`。三个 nonce/proof 字符串均采用 64 位小写十六进制编码。

控制器依据自身创建的 child PID 和私有 bootstrap key 验证 serverProof，然后发送 `observer.hello`，params 的完整字段为 `authVersion: 2`、`clientNonce`、`serverNonce` 与 `clientProof`。成功 hello 返回版本、profile、能力和 authVersion 元数据。每个连接仅发起一次挑战，挑战及确认共享连接接受之后的 10 秒绝对 deadline。Windows 保持实际 named-pipe client PID 校验；服务器身份由绑定 expected PID 的 bootstrap secret 持有证明确认。

HMAC-SHA256 key 是 bootstrap secret 十六进制解码得到的 32 个字节。消息为以下 ASCII 字符串的顺序拼接，最后一行采用完整 nonce 字节且以其末尾结束：

```text
abr-local-ipc-auth-v2\n
observer\n
server|client\n
serverPIDdecimal\n
clientNonce\n
serverNonce
```

server 与 client 使用独立证明方向。服务采用固定长度 HMAC 验证和密码学安全的 server nonce，密钥在继承 stdin 接收后保持于私有认证处理器，并通过平台安全清理函数释放。认证失败关闭该连接。

## 请求与响应

消息帧为 `uint32_be payloadLength + UTF-8 JSON`，长度限制为 4 MiB。请求结构为：

```json
{
  "schemaVersion": 1,
  "requestId": "opaque-request-id",
  "method": "observer.listWindows",
  "params": {}
}
```

成功响应携带 `result`；失败响应携带 `error`，其中 code 使用运行时稳定错误枚举，message 为固定技术说明，retryable 为布尔值。

| Method                      | Params                                             | Result                                                        |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| observer.challenge          | authVersion, clientNonce                           | authVersion, serverPid, clientNonce, serverNonce, serverProof |
| observer.hello              | authVersion, clientNonce, serverNonce, clientProof | 版本、profile 和能力元数据                                    |
| observer.getState           | 空对象                                             | 浏览器 commit、版本、功能状态                                 |
| observer.listWindows        | 空对象                                             | 已授权浏览器窗口列表                                          |
| observer.listTabs           | windowId                                           | 标签 id、title、已提交 URL、active                            |
| observer.readAccessibility  | tabId, limit?, treeDepth?, sensitivePatterns?      | 当前只读 AX 树、URL、窗口、标签和几何                         |
| observer.getViewportMetrics | tabId                                              | scale、geometry、viewportBounds、windowBounds                 |

windowId 使用浏览器 SessionID，tabId 使用 SessionTabHelper 的稳定 tab SessionID。Windows 的 osWindowId 使用已验证的 HWND 标识，运行时系统输入绑定采用该值。Unix 原生窗口映射保留独立验收状态。

窗口 bounds 使用带标签的 screen DIP 几何。AX 节点 bounds 使用 `screen-physical`。BrowserAccessibilityManager 从当前主框架 AXTreeID 查找缓存节点，BrowserAccessibility.GetBoundsRect 完成屏幕物理坐标转换。节点 id 组合 AXTreeID 与 node id，覆盖跨框架节点身份。

observe 最多读取 6000 个节点和 32 层树深。读取范围超过限制时返回 TIMEOUT。受保护控件只保留角色、状态、矩形和 id，名称、值及后代在序列化之前移除。文本经过有效 UTF-8 转换和长度限制。输入与关联文本标签角色中的独立单词 Card 采用大小写无关的 ASCII 单词边界分类；文档与窗口标题采用原有观察范围。当前缓存已存在的 HTML `data-sensitive` 和敏感 `autocomplete` token 可加强过滤。控制器可提供最多 64 个敏感名称字面模式，每项要求非空字符串且最多 256 UTF-8 字节；浏览器枚举前整体校验，策略无效时返回 `INVALID_ARGUMENT`。

viewport 元数据使用浏览器实际 zoom level 转换因子和 renderer view device scale。Windows 从 HWND 获取物理窗口原点，并由浏览器 AX 缓存获取物理 viewport 原点，`viewportMetricsVerified=true`。Unix 窗口映射的验证状态为 false。每个 UI 请求等待最多 5 秒，等待期间可被浏览器服务停止标志中止。

## 验证状态

源接口已经与锁定 commit 的实际声明核对。mailbox patch 在从该 commit 创建的独立 Git index 上执行 `git apply --check --cached`。Chromium GN 生成、C++ 编译和原版与定制版事件回归需要官方工具链与依赖同步结果，当前保留待验证状态。

订阅型事件推送当前报告 unavailable，状态元数据通过 `subscriptions=false` 表示。只读接口覆盖窗口、标签、AX 与 viewport 查询。
