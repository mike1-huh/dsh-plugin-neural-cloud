/**
 * 云图 → 本地记忆引擎（2026-11-06）
 *
 * 只换内脏：云图的工具名/入参/出参、注入格式、面板都保留，
 * 底下的抽取、记忆库、检索换成 memory-engine 服务（Kotlin，带向量库）。
 *
 * 开关：环境变量 MEMORY_ENGINE=0 可回退到云图自带实现。
 */

const ENDPOINT = process.env.MEMORY_ENGINE_ENDPOINT || 'http://127.0.0.1:8787'
const SESSION = process.env.MEMORY_ENGINE_SESSION || 'dsh'
const ENABLED = process.env.MEMORY_ENGINE !== '0'

async function call(route, payload) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(ENDPOINT.replace(/\/+$/, '') + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export function remoteEnabled() {
  return ENABLED
}

/** 云图 memory_remember 的远端落点；返回云图要的 {record,total}。 */
export async function remoteRemember(args) {
  const j = await call('/api/remember', {
    session: SESSION,
    content: args.content,
    keys: args.keys || [],
    tier: args.tier || 'B',
    event: args.event || '',
    scene: args.scene || '',
    entities: args.entities || [],
    quote: args.quote || '',
    tags: args.tags || [],
    valence: args.valence || '',
    arousal: args.arousal ?? 0,
    planState: args.planState || '',
    eventTime: args.eventTime || '',
    // 溯源：这条记忆出自哪几条消息（B 路线新增）
    sourceMsgIds: Array.isArray(args.sourceMsgIds) ? args.sourceMsgIds : [],
  })
  return {
    record: {
      id: j.id,
      content: args.content,
      keys: args.keys || [],
      tier: args.tier || 'B',
      event: args.event || '',
      scene: args.scene || '',
      entities: args.entities || [],
      quote: args.quote || '',
      tags: args.tags || [],
      valence: args.valence || '',
      arousal: args.arousal ?? 0,
      planState: args.planState || '',
      eventTime: args.eventTime || '',
      created: Date.now(),
    },
    total: j.total ?? 0,
  }
}

/** memory_recall 的远端实现；映射成云图的 {hits:[{record,why}],scanned}。 */
export async function remoteRecall(query, opts = {}) {
  const limit = Math.min(Math.max(opts.limit || 8, 1), 20)
  const j = await call('/api/search', { session: SESSION, query, limit })
  const items = Array.isArray(j.items) ? j.items : []
  const hits = items.map((h) => ({
    record: {
      id: h.id,
      content: h.content,
      tier: h.tier,
      keys: [],
      created: Date.now(),
      planState: '',
      eventTime: '',
    },
    score: h.score,
    why: Object.entries(h.channels || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}#${Number(v).toFixed(3)}`),
  }))
  return { hits, scanned: items.length, note: hits.length ? '' : '云图里没有能对上这件事的记忆。' }
}

/** memory_forget 的远端实现。 */
export async function remoteForget(ids, hard) {
  const j = await call('/api/forget', { session: SESSION, ids })
  return { archived: hard ? 0 : (j.deleted ?? 0), deleted: j.deleted ?? 0, remaining: 0 }
}

/** 注入块：只给记忆（DSH 自己已经有系统提示词了）。 */
export async function remoteInjectBlock(query, limit = 6) {
  const j = await call('/api/blocks', { session: SESSION, query, budget: 1200 })
  const lines = String(j.facts || '')
    .split('\n')
    .filter((l) => l.trim().startsWith('-'))
  if (!lines.length) return ''
  return ['【云图记忆】只能依据下面这些条目回答，没有依据就说记不清：', ...lines].join('\n')
}

/** 引擎侧状态（条数 / 文件），给 memory_status 用。 */
export async function remoteStatus() {
  const res = await fetch(ENDPOINT.replace(/\/+$/, '') + '/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: SESSION }),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return await res.json()
}

/** 回顾写入引擎（R 档信念层）。 */
export async function remoteHindsight(summary, evidenceIds) {
  const j = await call('/api/hindsight', {
    session: SESSION,
    summary,
    evidenceIds: Array.isArray(evidenceIds) ? evidenceIds : [],
  })
  if (!j || j.ok !== true) throw new Error('引擎拒绝了这条回顾')
  return j
}
