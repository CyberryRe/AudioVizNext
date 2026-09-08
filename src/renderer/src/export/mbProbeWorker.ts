/** 探针 Worker：仅用于验证 file:// 源下模块 Worker 能否创建/通信（迁移可行性门槛） */
self.onmessage = (e: MessageEvent): void => {
  ;(self as unknown as Worker).postMessage(`pong:${String(e.data)}`)
}
