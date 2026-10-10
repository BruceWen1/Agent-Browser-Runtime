# TASK-007 受控产物存储

- Goal：实现受控 blob、保存期限、资源配额和隐私过滤。
- Changes：会话归属、PNG 解码重编码与遮盖、内存截图默认值、严格 MIME、受控文件名和 JSON/HTML 轨迹导出。
- Tests run：TypeScript、lint 和 15 项单测已通过；新增 5 项验证归属、过期、配额、PNG 实际像素遮盖、轨迹过滤和保护字段过滤。真实 MCP 测试已验证图片内容块、分块读取 PNG 签名和 HTML 轨迹导出；4 项契约测试通过。
- Tests blocked：实际截图敏感区映射随各平台后端验证。
- Known issues：导出默认由运行时内存提供；持久化需显式启用。
- Contract changes：保护字段在快照缓存和返回前过滤；artifact_read 增加 offset、maxBytes 可选参数，以受控分块返回大产物。
- ADR references：协议传输使用 opaque blobId。
- Next task：TASK-008 CLI 与配置装配。
