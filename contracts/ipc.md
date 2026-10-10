# ABR 本地 IPC 协议 v1

与技术文档第 9 章完全一致。帧采用 `u32_be payloadLength + JSON UTF-8 payload`，最大 4 MiB。负责 Frame Decoder 的进程必须在分配内存前检查长度。

- `schemaVersion: 1` 强制。
- `requestId` 是非空字符串；响应复制原值。
- 请求字段：`schemaVersion`, `requestId`, `method`, `params`。
- 响应字段：`schemaVersion`, `requestId`, `ok`, `result` 或 `error`。
- 每次连接先执行以受保护继承句柄/本地通道传递 secret 的认证握手；拒绝远程连接。
- 对 `desktop.pointerClick` 等动作先执行 `PolicyEngine` 和 `DesktopInputLease` 验证。
- 跨语言 schema 同步由 TASK-002 测试维护；不能私自将 Rust enum 命名转换为驼峰、却不更新 TS decoder。

## Request

```json
{
  "schemaVersion": 1,
  "requestId": "req-0001",
  "method": "desktop.doctor",
  "params": {}
}
```

## Response

```json
{
  "schemaVersion": 1,
  "requestId": "req-0001",
  "ok": true,
  "result": { "platform": "windows", "screenCapture": false, "input": false }
}
```

## Error

```json
{
  "schemaVersion": 1,
  "requestId": "req-0001",
  "ok": false,
  "error": {
    "code": "PERMISSION_REQUIRED",
    "message": "Accessibility permission denied",
    "retryable": true
  }
}
```

**安全提醒**：不得通过 IPC 获取或导出浏览器 Password Store/Cookie；不得允许网页内容构造任意 IPC 参数越权执行。
