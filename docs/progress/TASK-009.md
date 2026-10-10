# TASK-009 官方 Playwright Worker

- Goal：隔离官方 Playwright 的启动、页面、上下文和关闭生命周期。
- Changes：受保护 fork IPC、惰性进程、匹配浏览器、持久上下文、官方 AX JSON 快照和受控截图分块传输。
- Tests run：TypeScript 检查通过；有界面 Chrome for Testing 156.0.8078.4 在受控 fork Worker 中完成导航、AX 观察、真实按钮激活结果检查、PNG 截图及关闭。
- Tests blocked：macOS/Linux 实机运行等待对应机器。
- Known issues：Compatible 指针坐标使用 viewport-css；其他坐标空间明确报告能力不足。
- Contract changes：Worker 使用共享 IPC 信封，保留官方浏览器 API 语义。
- ADR references：worker 与 Core 分离、默认独立 Profile。
- Next task：TASK-010 Compatible 与运行时的集成验收。
