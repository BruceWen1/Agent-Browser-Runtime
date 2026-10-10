# TASK-022 Chromium 只读观察服务

## 实现状态

浏览器进程观察服务已提供独立源文件和可回放 mailbox patch。基础版本为 `156.0.8078.12`，上游 commit 为 `634b046faf2137b83af71c87baf362b533af9104`。接口声明和 GN 集成位置均与该 commit 的实际文件核对。

GN 参数 `abr_native_observer` 默认 false。启用时，浏览器 `core` target 编译观察服务，生成 `ENABLE_ABR_NATIVE_OBSERVER` 构建标记。可访问性依赖通过公开的 `//ui/accessibility` target 传递，其 public dependency 提供 platform API，并保持 upstream platform target 的原始可见性范围。浏览器创建完成后启动服务，在主消息循环退出时先停止服务，再继续 profile 和缓存状态清理。

控制器经独立继承 stdin 管道提供严格启动 JSON，包括一次性 secret、endpoint、profileId 和 parentPid。服务验证独立数据目录 ownership marker、当前用户 endpoint 权限、连接控制器 PID 和协议版本。stdout 提供单行浏览器版本及 endpoint 元数据。Windows 使用当前 SID DACL、远程连接拒绝和 overlapped pipe IO；Unix 使用私有 runtime 目录、0600 socket 和 peer credentials。

私有双向认证采用 `authVersion=2`。挑战 result 具有固定的五字段结构，确认请求具有固定的四字段结构。HMAC-SHA256 transcript 绑定 `abr-local-ipc-auth-v2` domain、`observer` namespace、server/client direction、预期服务器 PID 和双 nonce；各字段以单个换行连接，最后 nonce 结束消息。密钥是继承 secret 解码得到的 32 字节，仅认证处理器持有。每连接仅创建一次挑战，全部握手帧读写及确认响应共享 10 秒绝对 deadline，成功后使用安全清理函数清除 key。Windows 的真实 client PID 校验与 HMAC secret-possession 服务器身份绑定分别提供独立证据。

只读接口覆盖 observer.hello、observer.getState、observer.listWindows、observer.listTabs、observer.readAccessibility 和 observer.getViewportMetrics。浏览器及标签仅从授权 profile 的 BrowserWindowInterface 与 TabStripModel 解析。URL 来自 WebContents 的已提交地址。

AX 节点来自 BrowserAccessibilityManager 的浏览器缓存，在浏览器 UI 线程读取。节点身份由 AXTreeID 与 node id 组合，物理边界由 BrowserAccessibility.GetBoundsRect 转换。受保护节点在序列化之前移除名称、值和后代。树深、节点总量、字符串长度、传输帧和 UI 等待均设有固定限额。

Card 隐私规则限定于输入、选择器、数值输入和关联文本标签角色，并按 ASCII 字母、数字与下划线边界识别独立单词。文档和窗口标题保持原有观察范围。已有缓存中的 `data-sensitive` 与 HTML `autocomplete` 敏感 token 可加强保护；读取采用当前 AX 模式及现有缓存。敏感名称模式在浏览器对象枚举前完成整体校验，每项要求非空 UTF-8 字符串且最多 256 字节，总数最多 64；无效策略统一返回 `INVALID_ARGUMENT`。

Windows 原生窗口映射使用当前浏览器 PID 的 HWND。viewport 采用浏览器实际 zoom 和 renderer device scale，Windows 物理原点来自缓存 AX 与 HWND 矩形。Unix 原生窗口映射保留独立验收状态。观察服务公开只读方法，系统输入由桌面后端承担。

## 已执行验证

- 从锁定上游 commit 读取实际源码 blob，生成独立临时 Git repository 的 mailbox patch。
- `git diff --cached --check`：临时 patch repository 通过。
- 在独立 GIT_INDEX_FILE 中执行 `git read-tree <locked-commit>`，随后执行 `git apply --check --cached <patch>`：通过。
- 完整 patch 字节 SHA256 已计算，可供版本 manifest 绑定。
- 最新 patch 为 78432 字节，SHA256 为 `88d988d3012bff214b1f01826cfe42f608d7c813d49ac661fc70f3a4ea0a74f4`；Unix 启动接收继承 FIFO 或 socketpair stream，与 Node 控制器的实际 stdio 传输兼容。
- Windows 编译前源码审查确认 `//ui/accessibility/platform` 的直接依赖可见性受限；patch 的 `core` 依赖使用其公开 facade，并在 opt-in block 声明 `//crypto`。最终 mailbox 已重新执行锁定 upstream 独立 index 的 `git apply --check --cached`，并执行 `git apply --whitespace=error-all --check --cached`；八个修改路径匹配原有 browser scope，六个生产 C++ 文件与 `chromium/bridge` 内容一致。
- 使用该源码工具链的 `clang-cl /std:c++20 /W4 /WX /EHsc` 对 `chromium/bridge/tests/privacy_policy_test.cc` 独立编译、链接并运行：21 个生产纯规则断言通过，覆盖 Card 单词/角色边界、已有缓存 autocomplete 语义以及 256/257 字节模式界限。该结果表示纯规则的编译与执行状态。
- 使用同一工具链的 `clang-cl /std:c++20 /W4 /WX /EHsc ... /link bcrypt.lib` 对 `chromium/bridge/tests/auth_policy_test.cc` 独立编译、链接并运行：生产 transcript 的 canonical metadata、方向、namespace、PID、nonce 与 key 分离检查通过；独立 Windows CNG HMAC 复现 Node/OpenSSL observer 固定向量和 .NET agent 固定向量。测试采用公开 key `00..1f`、固定 nonce 与 PID，表示 transcript 及独立算法互操作状态。
- 使用 `clang-cl /std:c++latest /Zs`、Windows Unicode defines、锁定源头文件和原版已生成 buildflags，对生产 `observer_transport.cc` 执行真实语法检查：通过。补丁头文件位于独立临时 overlay，upstream 工作树保持原有内容。HMAC SignSha256/VerifySha256、固定数组 span、HexStringToSpan、RandBytesAsArray 与 SecureZeroBuffer API 探针同样通过。该结果表示头文件及生产传输文件语法状态，完整 Chromium 链接保持独立待验证状态。
- 验证过程使用独立 index，主 Chromium checkout 的工作树与 index 保留原有状态。

## 待执行验证

Windows 官方工具链预检及精确 DEPS 同步已完成。GN 生成、完整 Chromium C++ 编译、真实浏览器观察协议调用，以及原版和定制版事件回归保留独立验收状态。当前完整浏览器编译状态与真实 Native 隐私 fixture 验收状态均为待验证。

macOS 和 Linux 传输代码、窗口原生映射与实体桌面验证保留独立状态。订阅型事件推送当前通过 `subscriptions=false` 表示 unavailable。
