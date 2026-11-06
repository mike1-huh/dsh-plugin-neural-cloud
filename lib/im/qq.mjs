/**
 * 云图 · QQ 接入（OneBot 11 / NapCat）
 *
 * 只做两件事：
 *   1. 连 OneBot WS（默认 ws://127.0.0.1:3001?access_token=…），把收到的 message 事件交给回调
 *   2. 提供发送 API（HTTP 3000：send_private_msg / send_group_msg）
 *
 * 不依赖任何 SDK：Node 22+ 自带 WebSocket / fetch。
 * NapCat 没起来时，start() 静默重连；发送失败会抛错，由调用方兜底。
 */
export function createQQBridge({ cfg = {}, onMessage } = {}) {
  let ws = null
  let closed = false
  let reconnectTimer = null

  const httpUrl = () => String(cfg.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')

  async function api(action, params) {
    const res = await fetch(`${httpUrl()}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(params || {}),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
    return res.json()
  }

  const sendPrivate = (userId, message) => api('send_private_msg', { user_id: Number(userId), message })
  const sendGroup = (groupId, message) => api('send_group_msg', { group_id: Number(groupId), message })

  function connect() {
    if (closed) return
    const base = String(cfg.wsUrl || 'ws://127.0.0.1:3001').replace(/^http/, 'ws').replace(/\/+$/, '')
    const url = cfg.token ? `${base}/?access_token=${encodeURIComponent(cfg.token)}` : base
    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      try { console.log('[neural-cloud] QQ bridge connected') } catch {}
    }
    ws.onmessage = (ev) => {
      try {
        const evt = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
        if (evt && evt.post_type === 'message' && typeof onMessage === 'function') onMessage(evt)
      } catch {}
    }
    ws.onclose = () => { ws = null; scheduleReconnect() }
    ws.onerror = () => {}
  }

  function scheduleReconnect() {
    if (closed) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, 5000)
  }

  return {
    start() {
      if (!cfg.enabled) return
      closed = false
      connect()
    },
    stop() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      try { ws && ws.close() } catch {}
      ws = null
    },
    sendPrivate,
    sendGroup,
    status() {
      return {
        enabled: Boolean(cfg.enabled),
        connected: Boolean(ws && ws.readyState === 1),
        wsUrl: cfg.wsUrl || '',
        httpUrl: cfg.httpUrl || '',
      }
    },
  }
}
