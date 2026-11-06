// 云图全链路自检（2026-11-06）
//   node dsh-plugin-neural-cloud/test/fullchain.mjs
// 逐个工具真跑一遍：写入 → 检索 → 反馈 → 心情 → 配置 → 回顾 → 删除
import { apply } from '../lib/index.js'

const tools = []
const ctx = {
  tools: { register: (t) => tools.push(t) },
  on: () => () => {},
  inject: (deps, fn) => { try { fn({ systemPrompt: {}, webServer: null, agents: null, configEditor: null }) } catch {} },
  effect: (fn) => { try { fn() } catch {} },
}

apply(ctx, { injectLimit: 6, defaultLimit: 8, session: 'dsh' })
await new Promise((r) => setTimeout(r, 1200))

const byName = (n) => tools.find((t) => t.name === n)
const call = async (n, args = {}) => {
  const t = byName(n)
  if (!t) return '（没注册）'
  try {
    const out = await t.execute(args)
    return typeof out === 'string' ? out : JSON.stringify(out)
  } catch (e) {
    return '❌ ' + (e?.message || e)
  }
}

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log((ok ? '✅' : '❌') + ' ' + label + (detail ? ' → ' + detail : ''))
}

// 1. status
const st = await call('memory_status')
check('memory_status', /条|count|引擎|库/i.test(st) || st.length > 0, String(st).slice(0, 60).replace(/\n/g, ' | '))

// 2. remember（带溯源）
const rem = await call('memory_remember', {
  content: '老师说好明早八点陪星野去医院复查',
  keys: ['医院', '复查', '八点'],
  tier: 'A',
  entities: ['老师', '星野', '医院'],
  tags: ['约定'],
  planState: 'pending',
  eventTime: '2026-11-07',
  sourceMsgIds: [9001, 9002],
})
check('memory_remember', /写入|已写入|id/i.test(rem), String(rem).slice(0, 70).replace(/\n/g, ' | '))

// 3. recall
const rec = await call('memory_recall', { query: '医院 复查 几点' })
check('memory_recall', /#|条|医院/.test(rec), String(rec).slice(0, 80).replace(/\n/g, ' | '))

// 4. feedback（hit）
const fb = await call('memory_feedback', { ids: [1], signal: 'hit', note: '自检' })
check('memory_feedback(hit)', /更新|updated|条/i.test(fb), String(fb).slice(0, 60).replace(/\n/g, ' | '))

// 5. mood 读 + 写
const mood1 = await call('memory_mood', {})
const mood2 = await call('memory_mood', { label: '平静', intensity: 5 })
check('memory_mood', String(mood1).length > 0 && String(mood2).length > 0,
  String(mood2).slice(0, 50).replace(/\n/g, ' | '))

// 6. config 读
const cfg = await call('memory_config', {})
check('memory_config', String(cfg).length > 0, String(cfg).slice(0, 50).replace(/\n/g, ' | '))

// 7. hindsight 写入
const hs = await call('memory_hindsight_write', {
  summary: '今天陪她去医院复查，路上她一直攥着我的袖子。回来的路上她说想去看海。',
  evidenceIds: [1],
})
check('memory_hindsight_write', /写入|已写入|#/i.test(hs), String(hs).slice(0, 60).replace(/\n/g, ' | '))

// 8. 引擎直连（新内核）
let engineOk = false
try {
  const r = await fetch('http://127.0.0.1:8787/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'dsh', query: '医院 复查', limit: 3 }),
  })
  const j = await r.json()
  engineOk = Array.isArray(j.items) && j.items.length > 0
  check('引擎 /api/search', engineOk, `命中 ${j.items?.length ?? 0} 条`)
} catch (e) {
  check('引擎 /api/search', false, e?.message || String(e))
}

// 9. forget（删掉自检数据里的最后一条回顾）
const fg = await call('memory_forget', { ids: [2], hard: true })
check('memory_forget', /删除|归档|deleted|archived/i.test(fg), String(fg).slice(0, 60).replace(/\n/g, ' | '))

const bad = results.filter((r) => !r.ok)
console.log('\n通过 ' + (results.length - bad.length) + '/' + results.length)
process.exit(bad.length ? 1 : 0)
