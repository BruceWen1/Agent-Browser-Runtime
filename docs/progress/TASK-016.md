# TASK-016 GUI 目标与输入协调

GUI 适配器使用独立 Profile 启动普通可见浏览器，以 PID、原始进程句柄和窗口身份建立桌面绑定。目标通过新鲜的 OS AX 角色、名称、几何、标签和页面身份复核，坐标转换保留明确的 screen-physical、window-dip 与 viewport-css 空间。

CSS 转换要求已验证的 browser viewport 元数据；effective DPR 已包含浏览器 zoom。OS window DPI 与 browser viewport 测量独立，GUI 在测量缺失时报告明确不可用结果。负屏幕坐标、125% monitor scale、2 倍 zoom 的转换和 stale/disabled 拒绝由单元测试验证。

GUI 与 Native 共享进程内输入所有者，OS 后端另设座席互斥。Windows 导航的一次原生请求覆盖地址栏快捷键、Unicode URL 和 Enter，保持同一外部输入 epoch、取消 generation 和 deadline。暂停、断线和超时中止后续输入，进程关闭依据已绑定原始 kernel handle 确认。

Windows 自有页面的原子系统导航、AX 点击、可见计数变化、Unicode 文本、WGC PNG、原始进程关闭与 Profile 清理已通过最终主路径实测，最新一项回归耗时 6.31 秒。真实多显示器和手动 IME 组合验收待对应环境。

Agent 启动等待位于输入所有权的 finally 保护范围内。只读测试适配器验证连续两次启动拒绝均保持 INPUT_BACKEND_UNAVAILABLE，后续请求能够进入启动流程；共享输入所有权在失败路径释放。macOS/Linux 原子导航依据后端显式声明返回 unavailable，Windows atomicNavigate capability 已由真实实现提供。

私有 inspectionSnapshot 与公开 observe 共享纯 snapshot builder，只有公开 caller observation 写入 AX 引用缓存。Core busy read 同样使用私有检查。坐标及 mixed drag 的授权 witness 经内部第二参数传入 adapter，在共有输入所有权内按最新窗口、页面、scale、geometry 和命中 node ID/role/name/bounds 复核；现有 caller 几何/page freshness 继续验证。effective DPR 单次应用，字段值和 focus/hover 临时状态提供独立语义处理。

新的 GUI/Native dispatcher doubles 验证 mixed drag 的原 AX 引用、一次 native request 和坐标语义变化后的零输入；Native 公开 snapshot 保持 chromium-accessibility。统一 Core/契约/无浏览器 MCP 检查共 53 项通过。该增量的真实桌面验证待新认证协议及协调输入时段完成。
