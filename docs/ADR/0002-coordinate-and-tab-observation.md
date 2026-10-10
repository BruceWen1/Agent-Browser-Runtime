# 坐标和标签观测契约

scale.dpr 表示当前 CSS 像素到屏幕物理像素的 effective DPR，包含 browser zoom 的影响。scale.zoom 独立提供浏览器缩放诊断信息。CSS 点的物理位置为 viewport origin 加 CSS 点乘 effective DPR；window DIP 点乘 monitor scale。

geometry.viewportMetricsVerified 表示实际浏览器 viewport 测量已经核验。原生 Chromium Windows observer 提供该测量；OS-only GUI 提供窗口测量，并在 CSS viewport 测量缺失时返回显式 capability 错误。

标签包含稳定观测范围内的 id、title 和 active 状态。url 为可选字段，表示已取得已提交 URL 的观测。Compatible 与 Native 提供浏览器进程的已提交 URL；GUI 提供可核验 active URL，inactive URL 依 OS 观测范围返回。

身份复核覆盖 window、tab、URL、scale 和 geometry。未知 URL 与未知 viewport 测量由缺失字段或显式标记表达，控制器依据实际能力选择操作。
