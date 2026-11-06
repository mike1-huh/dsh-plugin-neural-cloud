/**
 * 云图 · 记忆引擎内核（2026-10-28 从 lib/index.js 拆出）
 *
 * 纯逻辑，不碰工具注册、不碰网络、不碰模型：
 * 存储读写 · 留存级衰减 · 计划状态 · 多通道召回 · 时间戳渲染 · JSON 协议。
 *
 * 契约对齐 `引擎契约_20261028.md`：
 * - 时间戳由引擎给，宿主不要自己拼（stampFor）
 * - `handle(action, payload)`：JSON 进 → JSON 出，错误一律 `{ok:false,error}`
 * - remember / recall / feedback / forget / context 五个方法
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const DAY = 86400000
export const DEFAULT_TIER_DAYS = { S: 0, A: 60, B: 30, C: 14 }
export const CONTENT_CHANNELS = ['key', 'lexical', 'entity', 'quote']

/* ------------------------------------------------------------ 存储 */

export async function loadStoreFile(storePath) {
  let store = { version: 1, nextId: 1, records: [] }
  try {
    let raw = await fs.readFile(storePath, 'utf8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1) // 用户手改可能带 BOM
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.records)) store = parsed
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 坏库不丢：留一份 .bak，然后从空库继续
      await fs.rename(storePath, storePath + '.bak').catch(() => {})
    }
  }
  return store
}

export async function saveStoreFile(storePath, store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  const tmp = storePath + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(store, null, 1), 'utf8')
  await fs.rename(tmp, storePath)
}

/* ------------------------------------------------------- 文本与匹配 */

/** 中文 2–3gram + 英文/数字整词。与 Android 版 retrievalTerms 同构。 */
export function terms(text) {
  const out = new Set()
  const s = String(text || '')
  for (const m of s.match(/[A-Za-z0-9_]+|[\u4e00-\u9fa5]+/g) || []) {
    if (/^[A-Za-z0-9_]+$/.test(m)) {
      if (m.length >= 2) out.add(m.toLowerCase())
      continue
    }
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= m.length; i++) out.add(m.slice(i, i + n))
    }
  }
  return [...out]
}

/** 库内 df（一条记忆算一次），把"到处都有的词"自动压到 0 分。 */
export function documentFrequency(records) {
  const df = new Map()
  for (const r of records) {
    for (const t of new Set(terms(r.content + ' ' + (r.keys || []).join(' ')))) {
      df.set(t, (df.get(t) || 0) + 1)
    }
  }
  return df
}

/** 问句侧门槛：这句到底需不需要检索（移植自 Android 版 QueryLift）。 */
export function needsRetrieval(query) {
  const q = String(query || '').trim()
  if (!q) return false
  // 整句被括号/星号包起来且没有台词 → 纯动作
  const isAction = /^[（(\[【*][\s\S]*[）)\]】*]$/.test(q)
  if (isAction && !/[「『"“][^」』"”]+[」』"”]/.test(q)) return false
  // 去掉标点后只剩 1–2 字，或只有代词/称呼 → 纯语气 / 纯指代
  const bare = q.replace(/[\s，。、！？~～…·,.!?]/g, '')
  if (bare.length <= 2) return false
  if (['你', '我', '他', '她', '那个', '这个', '这里', '那里'].includes(bare)) return false
  return true
}

/** 留存级判定：调用方没给就用标签猜。 */
export function guessTier(tags, hasEventTime) {
  const t = new Set(tags || [])
  if (t.has('设定') || t.has('身份') || t.has('称呼')) return 'S'
  if (t.has('承诺') || t.has('约定') || hasEventTime) return 'A'
  if (t.has('事件')) return 'B'
  return 'C'
}

/* ------------------------------------------------------------ 衰减 */

/** 按留存级天数归为 archived（软删，仍可回溯）。 */
export function decay(records, tierDays = DEFAULT_TIER_DAYS) {
  const now = Date.now()
  let archived = 0
  for (const r of records) {
    if (r.archived) continue
    const days = tierDays[r.tier] ?? 14
    if (!days) continue // S 永不归档
    // 多重豁免：有事件时间 / 有实体 / 是承诺 → 不动
    if (r.eventTime) continue
    if (r.entities && r.entities.length) continue
    if ((r.tags || []).some(t => t === '承诺' || t === '约定')) continue
    const last = r.lastHit || r.created
    if ((now - last) / DAY > days) {
      r.archived = true
      r.archiveReason = `decay:${r.tier}`
      archived++
    }
  }
  return archived
}

/* ------------------------------------------------------------ 召回 */

const RRF_K = 60
/** 高精度通道用更小的 k：一路第 1 名不该输给"到处沾一点"（Android 版实测过）。 */
const TIGHT = { key: 10, lexical: 10, entity: 10 }

/**
 * 多通道召回 → 加权 RRF。
 * key / lexical / entity / quote / recent / tier 六路。
 */
export function recall(records, query, opts = {}) {
  const active = records.filter(r => !r.archived && !r.muted)
  const df = documentFrequency(active)
  const N = Math.max(active.length, 1)
  const q = String(query || '')
  const qTerms = new Set(terms(q))
  const qLower = q.toLowerCase()

  const lists = []

  // key 通道
  const keyHits = []
  for (const r of active) {
    let hit = 0
    for (const k of r.keys || []) if (k && q.includes(k)) hit++
    if (hit > 0) keyHits.push([r, hit])
  }
  keyHits.sort((a, b) => b[1] - a[1])
  lists.push(['key', 3.0, keyHits.map(x => x[0])])

  // lexical 通道（idf 加权）
  const lexHits = []
  for (const r of active) {
    let score = 0
    for (const t of new Set(terms(r.content))) {
      if (qTerms.has(t)) score += Math.log(N / Math.max(df.get(t) || 1, 1))
    }
    if (score > 0) lexHits.push([r, score])
  }
  lexHits.sort((a, b) => b[1] - a[1])
  lists.push(['lexical', 1.0, lexHits.map(x => x[0])])

  // entity 通道
  const entHits = []
  for (const r of active) {
    const hit = (r.entities || []).filter(e => e && qLower.includes(String(e).toLowerCase())).length
    if (hit > 0) entHits.push([r, hit])
  }
  entHits.sort((a, b) => b[1] - a[1])
  lists.push(['entity', 0.9, entHits.map(x => x[0])])

  // quote 通道：原话里的碎片被问到
  const quoteHits = []
  for (const r of active) {
    if (!r.quote) continue
    const qt = terms(r.quote)
    const hit = qt.filter(t => q.includes(t)).length
    if (hit >= 2) quoteHits.push([r, hit])
  }
  quoteHits.sort((a, b) => b[1] - a[1])
  lists.push(['quote', 1.2, quoteHits.map(x => x[0])])

  // recent 通道
  const recent = [...active].sort((a, b) => (b.lastHit || b.created) - (a.lastHit || a.created))
  lists.push(['recent', 1.0, recent])

  // tier 通道（S/A 保底）
  const stier = active.filter(r => r.tier === 'S' || r.tier === 'A')
    .sort((a, b) => (a.tier === 'S' ? 0 : 1) - (b.tier === 'S' ? 0 : 1))
  lists.push(['stier', 1.0, stier])

  // vector 通道（可选：embedFn 可用时，由 recallMemory 传入按余弦相似度排好的列表）
  if (Array.isArray(opts.vectorList) && opts.vectorList.length) {
    lists.push(['vector', 1.4, opts.vectorList])
  }

  // 融合
  const scores = new Map()
  const why = new Map()
  for (const [source, weight, list] of lists) {
    const k = TIGHT[source] ?? RRF_K
    const seen = new Set()
    list.forEach((r, rank) => {
      if (seen.has(r.id)) return
      seen.add(r.id)
      scores.set(r.id, (scores.get(r.id) || 0) + weight / (k + rank + 1))
      if (!why.has(r.id)) why.set(r.id, [])
      why.get(r.id).push(`${source}#${rank + 1}`)
    })
  }

  const order = [...scores.entries()].sort((a, b) => b[1] - a[1])

  // 时间范围收窄（用户点名某天/某段）
  let pool = order
  if (opts.from || opts.to) {
    const from = opts.from ? Date.parse(opts.from) : 0
    const to = opts.to ? Date.parse(opts.to) : Number.MAX_SAFE_INTEGER
    const narrowed = order.filter(([id]) => {
      const r = active.find(x => x.id === id)
      const at = r?.eventTime ? Date.parse(r.eventTime) : (r?.worldTime ? Date.parse(r.worldTime) : r?.created || 0)
      return at >= (from || 0) && at <= (to || Number.MAX_SAFE_INTEGER)
    })
    if (narrowed.length >= 3) pool = narrowed
  }

  const limit = Math.min(Math.max(opts.limit || 8, 1), 20)
  const byId = new Map(active.map(r => [r.id, r]))

  // ★ 只靠 recent / stier 进来的条目不算命中 —— 那两个通道永远有输出，
  //   不剪掉的话任何一句"嗯"都会返回一堆无关记忆。
  const filtered = pool
    .map(([id, score]) => ({ id, score, why: why.get(id) || [] }))
    .filter(x => x.why.some(w => CONTENT_CHANNELS.some(c => w.startsWith(c + '#'))))
    .slice(0, limit)

  return filtered.map(x => ({
    record: byId.get(x.id),
    score: Number(x.score.toFixed(6)),
    why: x.why,
  }))
}

/* ------------------------------------------------------------ 时间戳（引擎给） */

const pad = n => String(n).padStart(2, '0')

/** 时段（和 app 同口径）。 */
export function periodOf(date) {
  const h = date.getHours()
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 18) return '下午'
  return '晚上'
}

/** 相对量词。 */
export function relativeOf(ts) {
  const a = new Date(ts)
  const b = new Date()
  const ax = new Date(a.getFullYear(), a.getMonth(), a.getDate())
  const bx = new Date(b.getFullYear(), b.getMonth(), b.getDate())
  const diff = Math.round((bx - ax) / DAY)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff === 2) return '前天'
  return `${diff} 天前`
}

/**
 * 渲染一条记忆的时间戳（契约：宿主不要自己拼时间）。
 * 按现实时间：`10-22 上午（今天）`；带 eventTime 就用事件时间，否则用写入时间。
 */
export function stampFor(r) {
  const ts = r.eventTime ? Date.parse(r.eventTime) : (r.created || Date.now())
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const mmdd = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${mmdd} ${periodOf(d)}（${relativeOf(ts)}）`
}

export function renderRecord(r) {
  const bits = [`#${r.id}`, `[${r.tier}]`]
  if (r.eventTime) bits.push(r.eventTime)
  if (r.scene) bits.push(`@${r.scene}`)
  return `${bits.join(' ')} ${r.content}`
}

/* ------------------------------------------------------------ 引擎对象 */

/**
 * 建一个引擎实例：内部缓存 store，五个方法 + JSON 协议 handle()。
 * 面板（面板走接口）、工具、注入共用这一个实例。
 *
 * embedFn 可选：`async (texts) => number[][] | null`。配置了 embedding 接口
 * 且拿到了 key 时，召回会多一路向量通道；拿不到就静默降级为关键词/recent/tier。
 * rerankFn 可选：`async (query, documents) => [{ index, relevance_score }] | null`。
 * 配置了 rerank 接口时，对 RRF 融合后的候选做 cross-encoder 精排；失败自动跳过。
 */
export function createEngine({ storePath, maxRecords = 20000, tierDays = DEFAULT_TIER_DAYS, embedFn = null, rerankFn = null } = {}) {
  let store = null

  /** 精排：按 rerank 接口给出的 relevance_score 重排候选；失败返回 null（保持 RRF 顺序）。 */
  async function rerankHits(query, hits) {
    if (!rerankFn || hits.length < 2) return null
    try {
      const docs = hits.map(h => h.record.content)
      const results = await rerankFn(query, docs)
      if (!Array.isArray(results) || !results.length) return null
      const scoreOf = new Map()
      for (const r of results) {
        if (r && Number.isInteger(r.index) && typeof r.relevance_score === 'number') {
          scoreOf.set(r.index, r.relevance_score)
        }
      }
      if (!scoreOf.size) return null
      return hits
        .map((h, i) => ({ h, i, s: scoreOf.has(i) ? scoreOf.get(i) : -1 }))
        .sort((a, b) => (b.s - a.s) || (a.i - b.i))
        .map(x => x.h)
    } catch {
      return null
    }
  }

  /* ---- 向量通道（可选）：缓存侧车 vectors.json，按内容 hash 失效 ---- */
  const vectorPath = storePath.replace(/memory[.]json$/, 'vectors.json')
  let vecCache = null
  const hashOf = s => {
    let h = 0
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
    return String(h)
  }
  async function loadVecCache() {
    if (vecCache) return vecCache
    vecCache = new Map()
    try {
      const raw = await fs.readFile(vectorPath, 'utf8')
      const obj = JSON.parse(raw)
      for (const [id, v] of Object.entries(obj || {})) {
        if (v && Array.isArray(v.v)) vecCache.set(Number(id), { h: v.h, v: v.v })
      }
    } catch {}
    return vecCache
  }
  async function saveVecCache() {
    try {
      const obj = {}
      for (const [id, v] of vecCache) obj[id] = v
      await fs.mkdir(path.dirname(vectorPath), { recursive: true })
      await fs.writeFile(vectorPath, JSON.stringify(obj), 'utf8')
    } catch {}
  }
  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    if (!na || !nb) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }
  /** 返回按语义相似度排好的记录列表；任何失败（无 key/网络/报错）都返回 null。 */
  async function vectorChannel(pool, query) {
    if (!embedFn || !query || !pool.length) return null
    try {
      const qv = (await embedFn([query]))?.[0]
      if (!Array.isArray(qv) || !qv.length) return null
      await loadVecCache()
      const missing = []
      for (const r of pool) {
        const c = vecCache.get(r.id)
        if (!c || c.h !== hashOf(r.content)) missing.push(r)
      }
      if (missing.length) {
        const vecs = await embedFn(missing.map(r => r.content))
        if (!Array.isArray(vecs) || vecs.length !== missing.length) return null
        missing.forEach((r, i) => {
          if (Array.isArray(vecs[i]) && vecs[i].length) {
            // 压缩精度：向量只用于排序，1e-4 足够
            vecCache.set(r.id, { h: hashOf(r.content), v: vecs[i].map(x => Math.round(x * 1e4) / 1e4) })
          }
        })
        await saveVecCache()
      }
      const scored = []
      for (const r of pool) {
        const c = vecCache.get(r.id)
        if (!c) continue
        const score = cosine(qv, c.v)
        if (score > 0.2) scored.push([score, r])
      }
      scored.sort((a, b) => b[0] - a[0])
      return scored.map(x => x[1])
    } catch {
      return null
    }
  }

  async function ensure() {
    if (!store) store = await loadStoreFile(storePath)
    return store
  }
  /** 强制重读磁盘（面板 RPC 用：外部改动文件后立即看到真值，不吃旧缓存）。 */
  async function reload() {
    store = await loadStoreFile(storePath)
    return store
  }
  async function persist() {
    await saveStoreFile(storePath, store)
  }

  /* 五个方法（与 Android MemoryEngine 同构） */

  async function remember(input) {
    const s = await ensure()
    const hasEventTime = Boolean(input.eventTime)
    const tags = input.tags || []
    const tier = input.tier || guessTier(tags, hasEventTime)
    const ts = Date.now()
    const eventId = (input.event || input.scene || input.eventTime)
      ? `e:${(input.event || '').trim()}|${(input.scene || '').trim()}|${input.eventTime || ''}`
      : ''
    const rec = {
      id: s.nextId++,
      content: String(input.content || '').trim(),
      keys: (input.keys || []).map(k => String(k).trim()).filter(Boolean).slice(0, 8),
      tier,
      event: input.event || '',
      eventId,
      scene: (input.scene || '').trim(),
      entities: (input.entities || []).map(e => String(e).trim()).filter(Boolean).slice(0, 10),
      quote: (input.quote || '').trim(),
      tags,
      eventTime: input.eventTime || '',
      worldTime: input.worldTime || '',
      valence: input.valence || 'neutral',
      arousal: Number(input.arousal || 5),
      planState: input.planState || '',
      created: ts,
      lastHit: ts,
      hitCount: 0,
      archived: false,
    }
    s.records.push(rec)
    if (s.records.length > maxRecords) {
      const victims = s.records.filter(r => !r.archived && r.tier === 'C')
        .sort((a, b) => (a.lastHit || a.created) - (b.lastHit || b.created))
      const need = s.records.length - maxRecords
      for (const v of victims.slice(0, need)) { v.archived = true; v.archiveReason = 'capacity' }
    }
    await persist()
    return rec
  }

  async function recallMemory(query, opts = {}) {
    const s = await ensure()
    if (!needsRetrieval(query)) {
      return { hits: [], scanned: 0, note: '这句话不承载检索需求（纯动作 / 语气 / 指代），不必查云图。' }
    }
    decay(s.records, tierDays)
    const pool = opts.includeArchived ? s.records : s.records.filter(r => !r.archived)
    // 可选向量通道：embedFn 没配 / 没 key / 网络失败都会返回 null，自动降级
    const vectorList = await vectorChannel(pool, query)
    let hits = recall(pool, query, { ...opts, vectorList })
    // 可选精排：rerank 接口可用时对候选重排，失败保持 RRF 顺序
    const reranked = await rerankHits(query, hits)
    if (reranked) hits = reranked
    await persist()
    const note = hits.length
      ? `扫描 ${pool.length} 条，取回 ${hits.length} 条。`
      : `扫描 ${pool.length} 条，没有命中 —— 如实说"记不清"，不要编。`
    return { hits, scanned: pool.length, note }
  }

  async function feedback(ids, signal, note = '') {
    const s = await ensure()
    const changed = []
    let updated = 0
    for (const id of ids || []) {
      const r = s.records.find(x => x.id === id)
      if (!r) { changed.push(`#${id} 不存在`); continue }
      if (signal === 'hit') {
        r.hitCount = (r.hitCount || 0) + 1
        r.lastHit = Date.now()
        changed.push(`#${id} hit=${r.hitCount}`)
      } else if (signal === 'wrong') {
        r.muted = true
        r.wrongNote = note
        changed.push(`#${id} 标记为记错并停用`)
      } else if (signal === 'pin') {
        r.tier = 'S'
        r.pinned = true
        changed.push(`#${id} 钉住（S 级）`)
      }
      updated++
    }
    await persist()
    return { updated, changed }
  }

  async function forget(ids, hard = false, reason = 'forget') {
    const s = await ensure()
    let archived = 0
    let deleted = 0
    const idSet = new Set(ids || [])
    if (hard) {
      const before = s.records.length
      s.records = s.records.filter(r => !idSet.has(r.id))
      deleted = before - s.records.length
    } else {
      for (const r of s.records) {
        if (idSet.has(r.id) && !r.archived) {
          r.archived = true
          r.archiveReason = reason
          archived++
        }
      }
    }
    await persist()
    return { archived, deleted, remaining: s.records.length }
  }

  /** context：装配成可直接拼提示词的块（L1 核心 / L2 近期 / L3 兜底）。 */
  async function context(req = {}) {
    const s = await ensure()
    const active = s.records.filter(r => !r.archived && !r.muted)
    const byTier = r => r.tier === 'S' || r.tier === 'A'
    const l1 = active.filter(byTier).sort((a, b) => (b.lastHit || b.created) - (a.lastHit || a.created)).slice(0, 12)
    const l2 = active.filter(r => !byTier(r)).sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 8)
    const lines = []
    for (const r of [...l1, ...l2]) {
      const st = r.planState === 'pending' ? '（计划中）' : r.planState === 'done' ? '（已经发生）' : ''
      lines.push(`- ${stampFor(r)} ${r.content}${st}`)
    }
    return lines.length ? ['【云图记忆】只能依据下面这些条目回答，没有依据就说记不清：', ...lines].join('\n') : ''
  }

  /* JSON 协议（契约二：MemoryEngineJson 等价物） */

  async function handle(action, payload = {}) {
    try {
      switch (action) {
        case 'remember': {
          const rec = await remember(payload)
          return { ok: true, id: rec.id }
        }
        case 'recall': {
          const t0 = Date.now()
          const { hits, scanned, note } = await recallMemory(payload.query || '', payload)
          const items = hits.map(h => ({
            id: h.record.id,
            stamp: stampFor(h.record),
            content: h.record.content,
            tier: h.record.tier,
            planState: h.record.planState || '',
            eventTime: h.record.eventTime || '',
            scene: h.record.scene || '',
            score: h.score,
            why: h.why.join(', '),
            created: h.record.created,
          }))
          return { ok: true, items, note, timings: { recall: Date.now() - t0 } }
        }
        case 'feedback': {
          const res = await feedback(payload.ids, payload.signal, payload.note)
          return { ok: true, ...res }
        }
        case 'forget': {
          const res = await forget(payload.ids, Boolean(payload.hard), payload.reason)
          return { ok: true, ...res }
        }
        case 'context': {
          const block = await context(payload)
          return { ok: true, block }
        }
        case 'mood': {
          const s = await ensure()
          if (payload.label || payload.intensity) {
            s.mood = {
              label: String((payload.label || s.mood?.label || '平静')).trim(),
              intensity: Math.max(1, Math.min(10, Number(payload.intensity || s.mood?.intensity || 5))),
              valence: payload.valence || s.mood?.valence || 'neutral',
              updated: Date.now(),
              from: payload.from || 'mood',
            }
            await persist()
          }
          return { ok: true, mood: s.mood || null }
        }
        default:
          return { ok: false, error: `unknown action: ${action}` }
      }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  return {
    handle,
    remember,
    recall: recallMemory,
    feedback,
    forget,
    context,
    ensure,
    reload,
    persist,
  }
}
