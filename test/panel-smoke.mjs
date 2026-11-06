// 引擎契约 + 面板六区 + 配置层 + 现实时间（断言式）
import { createEngine } from '../lib/engine.js'
import { loadConfig, saveConfig, publicView } from '../lib/config.js'
import { buildPanel, realTime } from '../lib/panel.js'
import { check, checkAsync, summary, section, assert } from './_harness.mjs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = path.join(os.homedir(), '.dsh', 'storages', 'neural-cloud-test')
fs.rmSync(dir, { recursive: true, force: true })
const storePath = path.join(dir, 'memory.json')
const configPath = path.join(dir, 'config.json')
const engine = createEngine({ storePath, maxRecords: 100 })

section('engine › remember / recall / feedback / forget / context')

let rec1
await checkAsync('remember 返回 ok + id', async () => {
  const r = await engine.handle('remember', {
    content: '10-22 上午，星野在门口等老师下班。',
    keys: ['星星', '门口', '等下班'],
    tier: 'A', event: '等他下班', scene: '校门口',
    entities: ['校门口', '老师', '星野'],
    quote: '……你迟到了。',
    eventTime: '2026-10-22', planState: 'done',
    valence: 'positive', arousal: 6, tags: ['事件', '约定'],
  })
  assert.equal(r.ok, true)
  assert.ok(Number.isInteger(r.id))
  rec1 = r.id
})

await checkAsync('recall 命中且带 stamp/tier/planState/why', async () => {
  const r = await engine.handle('recall', { query: '门口等下班那次', limit: 5 })
  assert.equal(r.ok, true)
  assert.ok(r.items.length >= 1, 'expected at least one hit')
  const it = r.items[0]
  for (const k of ['id', 'stamp', 'content', 'tier', 'planState', 'score', 'why']) {
    assert.ok(Object.hasOwn(it, k), `missing ${k}`)
  }
  assert.match(it.stamp, /^\d{2}-\d{2} .+（.+）$/)
  assert.ok(it.why.length > 0)
})

await checkAsync('纯语气/动作句不查库（问句门槛）', async () => {
  const r = await engine.handle('recall', { query: '嗯' })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 0)
})

await checkAsync('feedback hit 增加命中', async () => {
  const r = await engine.handle('feedback', { ids: [rec1], signal: 'hit' })
  assert.equal(r.ok, true)
  assert.equal(r.updated, 1)
})

await checkAsync('feedback pin 升到 S 级', async () => {
  await engine.handle('feedback', { ids: [rec1], signal: 'pin' })
  const st = await engine.ensure()
  assert.equal(st.records.find(r => r.id === rec1).tier, 'S')
})

await checkAsync('forget 软删（归档）可回溯', async () => {
  const r = await engine.handle('forget', { ids: [rec1], hard: false })
  assert.equal(r.ok, true)
  assert.equal(r.archived, 1)
  const st = await engine.ensure()
  assert.equal(st.records.find(r => r.id === rec1).archived, true)
})

await checkAsync('context 块含【云图记忆】前缀', async () => {
  // 先补一条可用记忆：上一条已归档，active 为空时 context 返回空串属正常
  await engine.handle('remember', { content: '10-23 傍晚，校门口一起吃了面。', keys: ['面', '校门口'], tags: ['事件'] })
  const r = await engine.handle('context', {})
  assert.equal(r.ok, true)
  assert.ok(r.block.includes('【云图记忆】'))
})

section('panel › 六区与统计')

const panel = await buildPanel({ engine, personaPath: path.join(dir, 'persona.json') }, { query: '', limit: 5 })
check('panel 返回六区键', () => {
  for (const k of ['persona', 'mood', 'memory', 'time', 'location', 'hindsight']) {
    assert.ok(Object.hasOwn(panel, k), `missing ${k}`)
  }
})
check('memory 分档统计存在', () => {
  assert.ok(Object.hasOwn(panel.memory, 'byTier'))
  assert.ok(Number.isInteger(panel.memory.total))
})
check('time.line 是现实时间格式', () => {
  assert.match(panel.time.line, /^\d{4}-\d{2}-\d{2} 周. \d{2}:\d{2}/)
})
check('hindsightStats 有 total/today/avgMs', () => {
  for (const k of ['total', 'today', 'avgMs']) {
    assert.ok(Object.hasOwn(panel.hindsightStats, k), `missing ${k}`)
  }
})

section('config › 默认值 / 打码 / 落盘')

const cfgA = loadConfig(configPath, { embedding: { base: 'https://api.siliconflow.cn/v1', key: 'sk-abcdef123456', model: 'BAAI/bge-m3' } })
check('embedding 读取到 base 与模型', () => {
  assert.equal(cfgA.embedding.base, 'https://api.siliconflow.cn/v1')
  assert.equal(cfgA.embedding.model, 'BAAI/bge-m3')
})
check('key 打码不回显完整值', () => {
  const v = publicView(cfgA).embedding.key
  assert.ok(v.includes('…'), 'expected masked key')
  assert.ok(!v.includes('abcdef'))
})
check('saveConfig 落盘', () => {
  saveConfig(configPath, cfgA)
  assert.ok(fs.existsSync(configPath))
})
check('rerank / hindsight 缺省为空 base', () => {
  assert.equal(cfgA.rerank.base, '')
  assert.equal(cfgA.hindsight.base, '')
})

section('realTime › 格式')

check('realTime 含日期/星期/时区', () => {
  const t = realTime()
  assert.match(t.line, /^\d{4}-\d{2}-\d{2} 周. \d{2}:\d{2}/)
  assert.equal(t.today.length, 10)
})

fs.rmSync(dir, { recursive: true, force: true })
summary()
