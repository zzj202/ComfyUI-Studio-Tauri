/**
 * ComfyUI /ws 实时进度。
 *
 * WebSocket 不受同源策略约束（ComfyUI 也不校验 Origin），所以这里直接由
 * WebView 原生连接，不用经过 Rust 中转，延迟更低。
 */

export interface WsHandlers {
  onOpen?: () => void
  onClose?: () => void
  onStatus?: (payload: { queueRemaining: number }) => void
  onProgress?: (payload: { promptId: string; node?: string; value: number; max: number }) => void
  onExecuting?: (payload: { promptId: string; node?: string | null }) => void
  onExecuted?: (payload: { promptId: string; node: string; outputs: any[] }) => void
  onError?: (payload: {
    promptId: string
    node?: string
    message: string
    traceback?: string
  }) => void
}

function toWs(base: string, clientId: string): string {
  const u = new URL(base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws'
  u.search = `?clientId=${encodeURIComponent(clientId)}`
  return u.toString()
}

export class ComfyWs {
  private ws: WebSocket | null = null
  private disposed = false
  private retry = 0
  private retryTimer: number | null = null

  constructor(private base: string, private clientId: string, private handlers: WsHandlers) {}

  connect() {
    this.disposed = false
    this.open()
  }

  private open() {
    if (this.disposed) return
    let url: string
    try {
      url = toWs(this.base, this.clientId)
    } catch {
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.retry = 0
      this.handlers.onOpen?.()
    }
    ws.onclose = () => {
      this.handlers.onClose?.()
      this.scheduleRetry()
    }
    ws.onerror = () => {
      /* onclose 会接着触发，重连交给它 */
    }
    ws.onmessage = (ev) => {
      // 预览帧是二进制数据，直接忽略
      if (typeof ev.data !== 'string') return
      let msg: any
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: any) {
    const d = msg?.data ?? {}
    switch (msg?.type) {
      case 'status':
        this.handlers.onStatus?.({
          queueRemaining: Number(d?.status?.exec_info?.queue_remaining ?? 0),
        })
        break
      case 'progress':
        this.handlers.onProgress?.({
          promptId: String(d?.prompt_id ?? ''),
          node: d?.node,
          value: Number(d?.value ?? 0),
          max: Number(d?.max ?? 0),
        })
        break
      case 'executing':
        // node 为 null 表示该 prompt 已整体结束
        this.handlers.onExecuting?.({ promptId: String(d?.prompt_id ?? ''), node: d?.node ?? null })
        break
      case 'executed': {
        const outputs: any[] = []
        for (const listKey of ['images', 'gifs', 'videos', 'audio']) {
          for (const item of d?.output?.[listKey] ?? []) {
            outputs.push({ ...item, listKey })
          }
        }
        this.handlers.onExecuted?.({
          promptId: String(d?.prompt_id ?? ''),
          node: String(d?.node ?? ''),
          outputs,
        })
        break
      }
      case 'execution_error':
        this.handlers.onError?.({
          promptId: String(d?.prompt_id ?? ''),
          node: d?.node,
          message: String(d?.exception_message ?? '执行出错'),
          traceback: d?.traceback ? String(d.traceback) : undefined,
        })
        break
      default:
        break
    }
  }

  private scheduleRetry() {
    if (this.disposed || this.retryTimer != null) return
    const delay = Math.min(1000 * 2 ** this.retry, 15000)
    this.retry = Math.min(this.retry + 1, 6)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
  }

  dispose() {
    this.disposed = true
    if (this.retryTimer != null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }
}
