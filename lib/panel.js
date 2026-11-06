/**
 * 云图 · 面板五区装配（2026-10-28）
 *
 * 面板走接口，不走内部函数 —— 与 app 一致：
 * - recall(query, limit) → items[]（带 stamp / tier / planState / why）
 * - memory_status       → 整块面板文本
 *
 * 这里把五区拼成一个 JSON，供 Host RPC 返回给 client 面板：
 * 人设卡 / 心情 / 记忆 / 时间 / 回顾。
 */
import { loadPersona, personaRows } from './persona.js'
import { moodLine } from './mood.js'
import { stampFor, CONTENT_CHANNELS } from './engine.js'
import { formatLocation } from './location.js'

/** 把引擎的一条 hit 渲染成面板条目（时间戳与命中理由都能点开看）。 */
export function itemView(h) {
  return {
    id: h.record.id,
    stamp: stampFor(h.record),
    content: h.record.content,
    tier: h.record.tier,
    planState: h.record.planState || '',
    eventTime: h.record.eventTime || '',
    scene: h.record.scene || '',
    score: h.score,
    why: h.why,
    hasContentChannel: h.why.some(w => CONTENT_CHANNELS.some(c => w.startsWith(c + '#'))),
    created: h.record.created,
  }
}

/** 现实时间（面板时间区用；不再有世界时钟）。 */
export function realTime() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  let tz = ''
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch {}
  return {
    now: now.toISOString(),
    today,
    weekday,
    hhmm,
    tz,
    line: `${today} ${weekday} ${hhmm}${tz ? ' · ' + tz : ''}`,
  }
}

/**
 * 五区面板。
 * @param deps { engine, personaPath }
 * @param req  { query, limit }
 */
export async function buildPanel(deps, req = {}) {
  const { engine, personaPath, names = {} } = deps
  const query = String(req.query || '').trim()
  const limit = Math.max(1, Math.min(20, Number(req.limit) || 8))

  // 人设卡：用户自写 persona.json，缺省读内置
  const persona = loadPersona(personaPath)

  // 引擎侧：状态 + 召回（走接口）。面板强制重读磁盘：外部改过文件也能立即看到真值。
  const st = await engine.reload()
  const active = st.records.filter(r => !r.archived && !r.muted)

  // 记忆区：有 query 走 recall，没有就走"最近 N 条"
  let items = []
  let note = ''
  if (query) {
    const res = await engine.recall(query, { limit })
    items = res.hits.map(h => itemView(h))
    note = res.note
  } else {
    items = active
      .slice()
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        stamp: stampFor(r),
        content: r.content,
        tier: r.tier,
        planState: r.planState || '',
        eventTime: r.eventTime || '',
        scene: r.scene || '',
        score: 0,
        why: ['recent'],
        hasContentChannel: true,
        created: r.created,
      }))
    note = `最近写入的 ${items.length} 条`
  }

  const byTier = {}
  for (const r of active) byTier[r.tier || 'B'] = (byTier[r.tier || 'B'] || 0) + 1
  const pending = active.filter(r => r.planState === 'pending').length

  // 心情
  const mood = st.mood || null

  // 时间区：现实时间
  const time = realTime()

  // 回顾区：最近一条 hindsight + 生成频次（30B 调用记录）
  const hindsightList = Array.isArray(st.hindsight) ? st.hindsight : []
  const lastHindsight = hindsightList[hindsightList.length - 1] || null
  const runs = Array.isArray(st.hindsightRuns) ? st.hindsightRuns : []
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const todayCount = runs.filter(r => (r.at || 0) >= dayStart.getTime()).length
  const avgMs = runs.length ? Math.round(runs.reduce((s, r) => s + (r.ms || 0), 0) / runs.length) : 0
  const lastRun = runs[runs.length - 1] || null

  return {
    persona: persona ? personaRows(persona) : null,
    personaPath,
    mood: mood
      ? { ...mood, line: moodLine(mood) }
      : null,
    memory: {
      total: st.records.length,
      active: active.length,
      byTier,
      pending,
      query: query || '',
      note,
      items,
    },
    time,
    location: st.location
      ? {
          ...st.location,
          line: formatLocation(st.location, names),
          changes: (Array.isArray(st.locationChanges) ? st.locationChanges : []).slice(-3),
        }
      : null,
    hindsight: lastHindsight
      ? { summary: lastHindsight.summary, evidenceIds: lastHindsight.evidenceIds || [], at: lastHindsight.at || 0 }
      : null,
    hindsightStats: {
      total: runs.length,
      today: todayCount,
      avgMs,
      lastAt: lastRun ? lastRun.at : 0,
      lastMs: lastRun ? lastRun.ms : 0,
    },
  }
}

/**
 * 生成回顾：把近期活跃记忆喂给外挂的 hindsight 模型（默认本地 30B），
 * 摘要写回 store.hindsight，evidenceIds 记录参与回顾的记忆 id。
 */
export async function runHindsight(deps, { maxEvidence = 20 } = {}) {
  const { engine, cfg, llm } = deps
  const st = await engine.reload()
  const active = st.records.filter(r => !r.archived && !r.muted)
  if (!active.length) return { ok: false, error: '记忆库是空的，没有可回顾的内容。' }

  const ranked = active
    .slice()
    .sort((a, b) => {
      const tierRank = t => (t === 'S' ? 0 : t === 'A' ? 1 : t === 'B' ? 2 : 3)
      const d = tierRank(a.tier) - tierRank(b.tier)
      return d !== 0 ? d : (b.created || 0) - (a.created || 0)
    })
    .slice(0, maxEvidence)

  const evidenceIds = ranked.map(r => r.id)
  const memoryText = ranked
    .map(r => `- [${r.tier}] ${r.eventTime || ''} ${r.content}`)
    .join('\n')

  // 生成频次：每次调用都记一条（成功/失败、耗时），最多留 200 条
  const t0 = Date.now()
  let summary = ''
  let failure = ''
  try {
    summary = await llm.hindsight(cfg, memoryText)
    if (!summary) {
      failure = process.env.MEMORY_HOST_MODEL_ONLY === '0'
        ? '回顾模型返回了空内容。'
        : '回顾已交给宿主模型：请让 agent 调用 memory_hindsight_write 写入这段复盘。'
    }
  } catch (e) {
    failure = e?.message || String(e)
  }
  const ms = Date.now() - t0

  if (!Array.isArray(st.hindsightRuns)) st.hindsightRuns = []
  st.hindsightRuns.push({ at: Date.now(), ms, ok: !failure, evidenceCount: evidenceIds.length })
  if (st.hindsightRuns.length > 200) st.hindsightRuns = st.hindsightRuns.slice(-200)

  if (failure) {
    await engine.persist()
    return { ok: false, error: failure, ms }
  }

  if (!Array.isArray(st.hindsight)) st.hindsight = []
  st.hindsight.push({ summary, evidenceIds, at: Date.now(), ms })
  if (st.hindsight.length > 50) st.hindsight = st.hindsight.slice(-50)
  await engine.persist()

  return { ok: true, summary, evidenceIds, at: st.hindsight[st.hindsight.length - 1].at, ms }
}
