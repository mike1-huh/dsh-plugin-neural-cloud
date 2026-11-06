/**
 * 云图（Neural Cloud）· 拟人记忆引擎 —— DSH 插件版（2026-10-28）
 *
 * 从 Android 端的记忆引擎抽出契约，做成 harness 可直接调用的工具，
 * 并按《云图插件_面板与设置_规格》补上：
 *
 * ```
 * 工具   memory_remember / memory_recall / memory_feedback / memory_forget
 *       + memory_mood / memory_config / memory_status
 * 注入   systemPrompt.section —— 每轮把召回结果拼进提示词（"她记得"）
 * RPC    /neural-cloud/* —— 面板（五区）与设置页（四组接口）走接口
 * ```
 *
 * 存储：单个 JSON 文件（默认 `~/.dsh/storages/neural-cloud/memory.json`），
 * 原子写（临时文件再 rename），损坏时退回空库并保留 `.bak`。
 * 同目录侧车文件：persona.json（人设卡）/ config.json（四组接口）。
 *
 * @module dsh-plugin-neural-cloud
 */
import { promises as fs } from 'node:fs'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

import { createEngine, stampFor, renderRecord } from './engine.js'
import { GROUPS, loadConfig, saveConfig, sidecarPath, maskKey, describe, publicView } from './config.js'
import { loadPersona, personaBlock } from './persona.js'
import { moodFromMemory, moodLine } from './mood.js'
import { buildPanel, runHindsight, realTime } from './panel.js'
import { detectLocation, detectNetwork, formatLocation, locationChanged } from './location.js'
import { thinkIntents } from './intent/think.js'
import { pickIntent } from './intent/compete.js'
import { executeIntent } from './intent/exec.js'
import { createQQBridge } from './im/qq.mjs'
import * as llm from './llm.js'
import { spawn } from 'node:child_process'
import { remoteEnabled, remoteRemember, remoteRecall, remoteForget, remoteStatus, remoteInjectBlock } from './remote.js'


/* ------------------------------------------------------------------
 * 记忆引擎自动拉起（2026-11-06）
 *
 * 云图现在把记忆交给本地引擎（MEMORY_ENGINE=1，默认）。
 * 引擎没起时这里拉一次；起不来就自动回退云图自带实现，不影响聊天。
 * 启动器路径可用 MEMORY_ENGINE_LAUNCHER 覆盖。
 * ------------------------------------------------------------------ */
let memoryEngineChild = null

function memoryEngineEndpoint() {
  return (process.env.MEMORY_ENGINE_ENDPOINT || 'http://127.0.0.1:8787').replace(/\/+$/, '')
}

async function memoryEngineAlive() {
  try {
    const res = await fetch(memoryEngineEndpoint() + '/api/status', { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

function memoryEngineDir() {
  const candidates = [
    process.env.MEMORY_ENGINE_DIR,
    path.join(os.homedir(), '.dsh', 'storages', 'memory-engine', 'engine'),
    'D:/AiCompanion/dsh-plugin-memory-engine/engine',
  ].filter(Boolean)
  return candidates.find(d => { try { return existsSync(path.join(d, 'lib')) } catch { return false } }) || ''
}

function javaExe() {
  const candidates = [
    process.env.MEMORY_JAVA,
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : '',
    'D:/jdk17/bin/java.exe',
    'C:/Program Files/Java/jdk-17/bin/java.exe',
    'C:/Program Files/Eclipse Adoptium/jdk-17/bin/java.exe',
  ].filter(Boolean)
  return candidates.find(p => { try { return existsSync(p) } catch { return false } }) || 'java'
}

function engineLog(msg) {
  try { appendFileSync(debugLog(), `[engine] ${msg}\n`) } catch {}
}

async function ensureMemoryEngine() {
  if (process.env.MEMORY_ENGINE === '0') {
    engineLog('已关闭（MEMORY_ENGINE=0）')
    return false
  }
  if (await memoryEngineAlive()) {
    engineLog('已在运行：' + memoryEngineEndpoint())
    return true
  }
  if (memoryEngineChild) return false
  const engineDir = memoryEngineDir()
  engineLog('未运行，尝试启动：' + (engineDir || '(找不到引擎目录)'))
  if (!engineDir) return false
  try {
    const dataDir = process.env.MEMORY_DATA_DIR
      || path.join(os.homedir(), '.dsh', 'storages', 'memory-engine')
    const env = { ...process.env, MEMORY_DATA_DIR: dataDir }
    if (engineDir) {
      // 直接起 java，绕开 .bat（Node spawn 一个 .bat 会 EINVAL）
      memoryEngineChild = spawn(javaExe(), [
        '-Dfile.encoding=UTF-8',
        '-cp', path.join(engineDir, 'lib', '*'),
        'com.aicompanion.memory.demo.ServerKt',
      ], { env, stdio: 'ignore', windowsHide: true, detached: false })
    } else {
      engineLog('引擎目录里没有 lib，无法启动')
      return false
    }
    memoryEngineChild.on('exit', () => { memoryEngineChild = null })
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (await memoryEngineAlive()) {
        engineLog('启动成功：' + memoryEngineEndpoint())
        return true
      }
    }
    engineLog('启动超时（6 秒内没响应），本次回退云图自带实现')
  } catch (e) {
    engineLog('启动失败：' + (e?.message || e))
  }
  return false
}


/* ------------------------------------------------------------------
 * 自动写入（2026-11-06）
 *
 * 每轮装配时，把"最近一问一答"丢给引擎抽取一次。
 * 不做：不代表每句都记 —— 引擎侧有去重与"值得记才记"的规则。
 * 关闭：MEMORY_AUTO_EXTRACT=0
 * ------------------------------------------------------------------ */
let lastAutoAt = 0
let autoBusy = false

function hostMessages(context) {
  const c = context || {}
  const arr = Array.isArray(c.messages) ? c.messages : []
  return arr
    .map(m => {
      const role = m?.role || m?.type || ''
      const text = typeof m?.content === 'string' ? m.content
        : Array.isArray(m?.content) ? m.content.map(x => x?.text || '').join(' ') : ''
      return { role, text: String(text || '').trim() }
    })
    .filter(m => m.text)
}

async function autoExtract(context) {
  if (process.env.MEMORY_AUTO_EXTRACT === '0') return
  if (process.env.MEMORY_ENGINE === '0') return
  if (autoBusy) return
  const now = Date.now()
  if (now - lastAutoAt < 3000) return

  const msgs = hostMessages(context)
  if (msgs.length < 2) return
  const lastUser = [...msgs].reverse().find(m => m.role === 'user' || m.role === 'human')
  const lastBot = [...msgs].reverse().find(m => m.role === 'assistant' || m.role === 'bot')
  if (!lastUser) return

  const dialogue = [
    lastBot ? '她：' + lastBot.text.slice(0, 400) : '',
    '老师：' + lastUser.text.slice(0, 400),
  ].filter(Boolean).join('\n')
  if (dialogue.replace(/[：:\n]/g, '').length < 12) return

  autoBusy = true
  lastAutoAt = now
  try {
    const res = await fetch(memoryEngineEndpoint() + '/api/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session: process.env.MEMORY_ENGINE_SESSION || 'dsh',
        messages: [
          { role: 'assistant', text: lastBot ? lastBot.text.slice(0, 400) : '' },
          { role: 'user', text: lastUser.text.slice(0, 400) },
        ],
        maxEntries: 2,
      }),
    })
    if (res.ok) {
      const j = await res.json()
      const n = Array.isArray(j.items) ? j.items.length : 0
      engineLog('自动写入 ' + n + ' 条')
    }
  } catch (e) {
    engineLog('自动写入失败：' + (e?.message || e))
  } finally {
    autoBusy = false
  }
}

export const name = 'neural-cloud'

/** 只依赖工具注册表；提示词注入与 Web 面板是可选宿主能力（运行时探测，缺了就跳过）。 */
export const inject = ['tools']

const DEFAULTS = {
  storePath: path.join(os.homedir(), '.dsh', 'storages', 'neural-cloud', 'memory.json'),
  maxRecords: 20000,
  defaultLimit: 8,
  maxLimit: 20,
  injectLimit: 6,
  /** 网络定位刷新间隔（毫秒），默认 5 分钟 */
  locationIntervalMs: 300000,
}

let activeStorePath = DEFAULTS.storePath
/** 注入模式日志：只写一次（purge present / absent）。 */
let injectContentLogged = false

/* ------------------------------------------------------------ RPC 辅助 */

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------ 工具定义 */

const recordSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'content', 'keys', 'tier', 'created'],
  properties: {
    id: { type: 'integer' },
    content: { type: 'string' },
    keys: { type: 'array', items: { type: 'string' } },
    tier: { type: 'string', enum: ['S', 'A', 'B', 'C'] },
    event: { type: 'string' },
    eventId: { type: 'string' },
    scene: { type: 'string' },
    entities: { type: 'array', items: { type: 'string' } },
    quote: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    eventTime: { type: 'string' },
    worldTime: { type: 'string' },
    valence: { type: 'string' },
    arousal: { type: 'integer' },
    planState: { type: 'string' },
    created: { type: 'integer' },
    lastHit: { type: 'integer' },
    hitCount: { type: 'integer' },
    archived: { type: 'boolean' },
    pinned: { type: 'boolean' },
  },
}

export function apply(ctx, config = {}) {
  // 引擎没起就拉一次；失败会回退云图自带实现
  ensureMemoryEngine().catch(() => {})
  activeStorePath = config.storePath || DEFAULTS.storePath
  const storePath = activeStorePath
  const configPath = sidecarPath(storePath, 'config.json')
  const personaPath = sidecarPath(storePath, 'persona.json')

  // 所有注册资源的清理器（fiber 卸载时统一收回）
  const disposers = []
  const register = (d) => { disposers.push(d); return d }

  // ── 四组接口（cordis 配置 + 本地覆盖文件）────────────────────
  let cfg = loadConfig(configPath, config.llm || {})

  // ── 引擎（面板/工具/注入共用同一个实例）──────────────────────
  // embedFn / rerankFn 给召回提供可选的向量通道与精排；没配 key 时自动降级。
  const embedFn = async (texts) => {
    if (!cfg.embedding.key) return null // 没 key 不发起无意义的请求
    try { return await llm.embed(cfg, texts) } catch { return null }
  }
  const rerankFn = async (query, docs) => {
    if (!(cfg.rerank.key || cfg.embedding.key) || !docs.length) return null
    try { return await llm.rerank(cfg, query, docs, { topN: docs.length }) } catch { return null }
  }
  const engine = createEngine({
    storePath,
    maxRecords: config.maxRecords || DEFAULTS.maxRecords,
    tierDays: config.tierDays || undefined,
    embedFn,
    rerankFn,
  })

  // ── 网络定位（定时刷新 + 网络指纹）──────────────────────────
  // IP 城市定位只到运营商出口（会偏到隔壁市），所以叠一层 SSID/BSSID/网关指纹：
  // 换地点判定优先 BSSID → SSID → 城市；locationNames 可把 SSID 命名成真实地点。
  const locationNames = (() => {
    let fromFile = null
    try { fromFile = JSON.parse(readFileSync(configPath, 'utf8')).locationNames } catch {}
    const fromCordis = config.locationNames
    return { ...(fromFile && typeof fromFile === 'object' ? fromFile : {}), ...(fromCordis && typeof fromCordis === 'object' ? fromCordis : {}) }
  })()
  let lastLocationEvent = null
  async function refreshLocation() {
    try {
      const loc = await detectLocation()
      // 指纹（SSID / BSSID / 网关）要拉起 netsh + powershell，会闪一个控制台窗口；
      // 默认关掉。要开指纹就在 config.json 里设 "locationFingerprint": true
      const net = config.locationFingerprint ? detectNetwork() : null
      const merged = { ...(loc || {}), ...(net || {}) }
      if (!loc && !net) return null
      const st = await engine.ensure()
      const prev = st.location || null
      const changed = locationChanged(prev, merged)
      st.location = { ...merged, at: Date.now() }
      if (changed) {
        if (!Array.isArray(st.locationChanges)) st.locationChanges = []
        st.locationChanges.push({
          at: Date.now(),
          from: formatLocation(prev, locationNames),
          to: formatLocation(merged, locationNames),
        })
        if (st.locationChanges.length > 20) st.locationChanges = st.locationChanges.slice(-20)
        lastLocationEvent = { kind: 'location-change', at: Date.now(), from: prev, to: merged }
        setTimeout(() => { maybeProactive('location-change', { from: prev, to: merged }).catch(() => {}) }, 800)
      }
      await engine.persist()
      return st.location
    } catch (e) {
      try { appendFileSync(debugLog(), `location error: ${e?.message || e}\n`) } catch {}
      return null
    }
  }
  try {
    // 只做一次首检（启动 3 秒后）；不周期轮询。
    // 需要更新时：POST /neural-cloud/location 手动刷，或面板里看「位置」卡。
    setTimeout(() => { refreshLocation().catch(() => {}) }, 3000)
  } catch (e) {
    try { appendFileSync(debugLog(), `location init failed: ${e?.message || e}\n`) } catch {}
  }

  // ── 主动对话（触发 → 限流 → 唤醒 agent）─────────────────────
  // 触发源：location-change / plan-due / idle-gap / time-greet
  // 限流：每天 ≤3 次、间隔 ≥90 分钟、23:00–08:00 静默（计划到期例外）
  let agentsService = null
  try { ctx.inject(['agents'], (sub) => { agentsService = sub.agents }) } catch {}

  function firstAgent() {
    try {
      if (!agentsService) return null
      const list = typeof agentsService.list === 'function' ? agentsService.list() : []
      for (const item of list) {
        if (item && typeof item.followup === 'function') return item
        const id = typeof item === 'string' ? item : (item && item.id)
        if (id && typeof agentsService.get === 'function') {
          const got = agentsService.get(id)
          if (got && typeof got.followup === 'function') return got
        }
      }
      const cur = typeof agentsService.currentInitiator === 'function' ? agentsService.currentInitiator() : null
      if (cur && typeof cur.followup === 'function') return cur
    } catch {}
    return null
  }

  function buildProactiveText(kind, payload, st) {
    const fmt = (l) => formatLocation(l, locationNames)
    if (kind === 'location-change') {
      return `（系统提示）哥哥的位置从「${fmt(payload.from)}」变成了「${fmt(payload.to)}」。用当前人格主动说一句，1–2 句，别像系统通知。`
    }
    if (kind === 'plan-due') {
      const rec = payload.record
      if (!rec) return ''
      return `（系统提示）计划「${rec.content}」的时间（${rec.eventTime || '今天'}）到了，状态还是 pending。用当前人格问一句进展，别催。`
    }
    if (kind === 'idle-gap') {
      const h = Math.round((Date.now() - (st.lastActiveAt || Date.now())) / 3600000)
      return `（系统提示）已经 ${h} 小时没说话了。用当前人格主动说一句，1–2 句，关心或吐槽都行。`
    }
    if (kind === 'time-greet') {
      const h = new Date().getHours()
      const hint = h < 10 ? '早上' : h >= 22 ? '深夜，提醒早点睡' : '白天'
      return `（系统提示）现在是${hint}（${h} 点）。用当前人格主动说一句，1–2 句。`
    }
    if (kind === 'test') {
      return '（系统提示）主动对话测试：用当前人格随便说一句，1 句就行。'
    }
    return ''
  }

  async function maybeProactive(kind, payload = {}) {
    try {
      const st = await engine.ensure()
      const now = Date.now()
      const hour = new Date().getHours()
      const pc = { enabled: true, dailyLimit: 3, minGapMs: 90 * 60000, quietStart: 23, quietEnd: 8, ...(config.proactive || {}) }
      if (!pc.enabled) return { ok: false, reason: 'disabled' }
      const isPlan = kind === 'plan-due'
      if (!isPlan && (hour >= pc.quietStart || hour < pc.quietEnd)) return { ok: false, reason: 'quiet-hours' }
      const p = (st.proactive && typeof st.proactive === 'object') ? st.proactive : { day: '', count: 0, lastAt: 0 }
      const text = buildProactiveText(kind, payload, st)
      if (!text) return { ok: false, reason: 'no-text' }
      // 不直接说话：只把这条信号记下来，交给意图心跳去"想"。
      // 说与不说、什么时候说，由人格 + 记忆决定，程序只负责递素材。
      if (!Array.isArray(st.signals)) st.signals = []
      st.signals.push({ kind, text, at: now })
      if (st.signals.length > 20) st.signals = st.signals.slice(-20)
      await engine.persist()
      return { ok: true, kind, signal: true }
    } catch (e) {
      try { appendFileSync(debugLog(), `proactive error: ${e?.message || e}\n`) } catch {}
      return { ok: false, reason: e?.message || 'error' }
    }
  }

  // 巡检已关：不再每分钟扫 plan-due / idle-gap / 时段。

  // ── 主动行为的两条路（config 里选）────────────────────────────
  // intentBy / hindsightBy:
  //   'model'  = 插件自己调模型（本地 30B / 配置的端点），定时也归插件
  //   'agent'  = 插件不调模型，由 schedule 叫醒 agent，agent 读记忆自己判断/写
  // 本地自用：model；发布给别人：agent（不依赖任何外挂模型）
  // 读取顺序：config.json > cordis 配置 > 默认 agent
  const fileModeCfg = (() => {
    try { return JSON.parse(readFileSync(configPath, 'utf8')) } catch { return {} }
  })()
  const intentBy = String(fileModeCfg.intentBy || config.intentBy || 'agent')
  const hindsightBy = String(fileModeCfg.hindsightBy || config.hindsightBy || 'agent')

  if (intentBy === 'model') {
    // 40 分钟意图心跳：人格 + 记忆 + 信号 → 意图 → 闸门 → 落地
    try {
      const iv = Math.max(5 * 60 * 1000, Number(config.intentIntervalMs) || 40 * 60 * 1000)
      const beat = async () => {
        try {
          const st = await engine.ensure()
          const recs = (st.records || []).filter(r => !r.archived)
          if (!recs.length) return
          const intents = await thinkIntents({
            personaText: personaBlock(loadPersona(personaPath)),
            records: recs,
            mood: moodLine(st.mood) || '平静',
            timeInfo: realTime().line,
            location: st.location ? formatLocation(st.location, locationNames) : '',
            channels: ['dsh:this'],
            signals: st.signals || [],
            intentHistory: st.intentLog || [],
            cfg,
          })
          if (!Array.isArray(st.intentLog)) st.intentLog = []
          const { intent } = pickIntent(intents, { now: new Date(), state: st, gate: config.proactive || {} })
          if (intent) {
            const out = await executeIntent(intent, { engine, agent: firstAgent() })
            st.intentLog.push({
              at: Date.now(), type: intent.type, want: intent.want, target: intent.target,
              urgency: intent.urgency, reason: intent.reason,
              state: out.ok ? 'sent' : 'failed', detail: out.detail || out.why || '',
            })
            if (out.ok) {
              const day = new Date().toDateString()
              const p = st.proactive && st.proactive.day === day ? st.proactive : { day, count: 0, lastAt: 0 }
              p.count++
              p.lastAt = Date.now()
              st.proactive = p
            }
            try { appendFileSync(debugLog(), `intent ${out.ok ? 'sent' : 'skip'}: ${intent.type} ${intent.want} (${out.detail || out.why})\n`) } catch {}
          } else if (intents.length) {
            for (const i of intents) {
              st.intentLog.push({ at: Date.now(), type: i.type, want: i.want, target: i.target, urgency: i.urgency, reason: i.reason, state: 'thought' })
            }
          }
          if (st.intentLog.length > 200) st.intentLog = st.intentLog.slice(-200)
          st.signals = []
          await engine.persist()
        } catch (e) {
          try { appendFileSync(debugLog(), `intent beat failed: ${e?.message || e}\n`) } catch {}
        }
      }
      const t = setInterval(() => { beat().catch(() => {}) }, iv)
      disposers.push(() => clearInterval(t))
      setTimeout(() => { beat().catch(() => {}) }, 60000)
    } catch (e) {
      try { appendFileSync(debugLog(), `intent timer failed: ${e?.message || e}\n`) } catch {}
    }
  }

  if (hindsightBy === 'model') {
    // 每晚 22:00 调 hindsight 端点生成复盘
    try {
      const atHour = Math.min(23, Math.max(0, Number(config.hindsightHour ?? 22)))
      const runNightly = async () => {
        try {
          const st = await engine.ensure()
          if (!Array.isArray(st.records) || st.records.length === 0) return
          const out = await runHindsight({ engine, cfg, llm })
          try { appendFileSync(debugLog(), `hindsight auto: ${out && out.ok ? 'ok' : 'skip'} ${new Date().toLocaleString()}\n`) } catch {}
        } catch (e) {
          try { appendFileSync(debugLog(), `hindsight auto failed: ${e?.message || e}\n`) } catch {}
        }
      }
      const scheduleNextNightly = () => {
        const now = new Date()
        const next = new Date(now)
        next.setHours(atHour, 0, 0, 0)
        if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
        const ms = Math.min(next.getTime() - now.getTime(), 24 * 3600 * 1000)
        const t = setTimeout(() => { runNightly().catch(() => {}); scheduleNextNightly() }, ms)
        disposers.push(() => clearTimeout(t))
      }
      scheduleNextNightly()
    } catch (e) {
      try { appendFileSync(debugLog(), `hindsight timer failed: ${e?.message || e}\n`) } catch {}
    }
  }

  // ── QQ 接入（OneBot 11 / NapCat）───────────────────────────
  // 收：WS 事件 → 过滤（自己/白名单）→ agent.followup（提示它用 im_qq_send 回）
  // 发：HTTP 3000 send_private_msg / send_group_msg
  const qqCfg = {
    enabled: false,
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    token: '',
    allowUsers: [],
    allowGroups: [],
    // 本地 config.json 的 qq 段优先于 cordis 默认值
    ...(() => { try { return JSON.parse(readFileSync(configPath, 'utf8')).qq || {} } catch { return {} } })(),
    ...(config.qq && typeof config.qq === 'object' ? config.qq : {}),
  }
  const qq = createQQBridge({
    cfg: qqCfg,
    onMessage(evt) {
      try {
        if (evt.self_id && evt.user_id === evt.self_id) return
        const text = Array.isArray(evt.message)
          ? evt.message.filter(s => s && s.type === 'text').map(s => (s.data && s.data.text) || '').join('')
          : String(evt.message || '')
        const body = text.trim()
        if (!body) return
        const isGroup = evt.message_type === 'group'
        if (isGroup && qqCfg.allowGroups.length && !qqCfg.allowGroups.map(String).includes(String(evt.group_id))) return
        if (!isGroup && qqCfg.allowUsers.length && !qqCfg.allowUsers.map(String).includes(String(evt.user_id))) return
        const agent = firstAgent()
        if (!agent) return
        const where = isGroup ? `群 ${evt.group_id}` : '私聊'
        const prompt = `（QQ 消息 · ${where}）${evt.user_id} 说：${body}\n\n回复必须调用 im_qq_send 工具发回${where}，别只在对话里回。`
        agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'im:qq' } })
      } catch (e) {
        try { appendFileSync(debugLog(), `qq message error: ${e?.message || e}\n`) } catch {}
      }
    },
  })
  qq.start()
  disposers.push(() => qq.stop())

  // ── 设置保存（面板与 memory_config 工具共用）─────────────────
  // input: 各组 { base?, key?, model? }；null/undefined = 不动该字段。
  function applyUserInput(input) {
    const next = {
      summary: { ...cfg.summary },
      embedding: { ...cfg.embedding },
      hindsight: { ...cfg.hindsight },
      rerank: { ...cfg.rerank },
    }
    for (const g of GROUPS) {
      const u = (input && input[g]) || {}
      for (const f of ['base', 'key', 'model']) {
        if (u[f] === null || u[f] === undefined) continue
        next[g][f] = String(u[f]).trim()
      }
    }
    saveConfig(configPath, next)
    cfg = loadConfig(configPath, config.llm || {})
    return cfg
  }

  // configEditor 是可选服务：用 ctx.inject 包住，拿不到就只写本地 config.json。
  let configEditor = null
  try {
    ctx.inject(['configEditor'], (sub) => { configEditor = sub.configEditor })
  } catch {}

  // 写回 cordis.patch.yml（规格：面板改配置后写回该文件）。
  // key 不进 patch —— 只存本地 config.json（不落日志、不进提示词）。
  async function persistToPatch() {
    const ce = configEditor
    if (!ce || typeof ce.entries !== 'function') return false
    try {
      const entry = ce.entries().find(e => e.id === 'neural-cloud' || e.name === 'dsh-plugin-neural-cloud')
      if (!entry) return false
      const llmPatch = {}
      for (const g of GROUPS) llmPatch[g] = { base: cfg[g].base, model: cfg[g].model }
      await ce.edit(entry, current => ({ ...current, llm: { ...(current.llm || {}), ...llmPatch } }))
      return true
    } catch (e) {
      appendFileSync(debugLog(), `configEditor edit failed: ${e?.message || e}\n`)
      return false
    }
  }

  // ── 心情：写入记忆时顺手更新（不额外花 token）────────────────
  async function touchMood(record) {
    try {
      if (!record) return
      const m = moodFromMemory(record)
      await engine.handle('mood', { ...m, from: `memory#${record.id}` })
    } catch {}
  }

  // ── 工具 ────────────────────────────────────────────────────

  register(ctx.tools.register({
    name: 'memory_mood',
    description:
      '查看或设置她此刻的心情。不传 label/intensity 就只查看。'
      + '用户问"你现在什么心情"、或对话里情绪明显变化时用它更新一条。',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '心情的一句话，如「有点不安」「强烈满足」' },
        intensity: { type: 'integer', description: '强度 1-10' },
        valence: { type: 'string', enum: ['positive', 'negative', 'mixed', 'neutral'], description: '正负倾向' },
      },
      required: [],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const res = await engine.handle('mood', {
        ...(args?.label ? { label: args.label } : {}),
        ...(args?.intensity ? { intensity: args.intensity } : {}),
        ...(args?.valence ? { valence: args.valence } : {}),
      })
      if (!res.ok) return `心情操作失败：${res.error}`
      return ['## 心情', '', `- ${moodLine(res.mood)}`].join('\n')
    },
  }))

  register(ctx.tools.register({
    name: 'memory_config',
    description:
      '查看或修改云图的四组接口配置：对话 / 摘要 / 向量 / 回顾。'
      + '留空的摘要与回顾会自动继承对话接口；向量留空表示关闭向量通道。'
      + 'key 只会打码显示，不会回显完整内容。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', enum: ['chat', 'summary', 'embedding', 'hindsight'], description: '要改哪一组；不传则只查看' },
        base: { type: 'string', description: '接口地址，如 https://api.deepseek.com/v1' },
        key: { type: 'string', description: 'API key（写入本地 config.json，只存本地）' },
        model: { type: 'string', description: '模型名' },
      },
      required: [],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      try {
        if (args && args.group) {
          const input = {}
          input[args.group] = {}
          if (typeof args.base === 'string') input[args.group].base = args.base
          if (typeof args.key === 'string') input[args.group].key = args.key
          if (typeof args.model === 'string') input[args.group].model = args.model
          applyUserInput(input)
          persistToPatch().catch(() => {})
        }
        const lines = ['## 云图 · 接口配置', '', describe(cfg), '', `（文件：${configPath}）`]
        lines.push('', '留空规则：summary / hindsight 留空 = 与 chat 一致；embedding 留空 = 关闭向量通道。')
        return lines.join('\n')
      } catch (e) {
        return `配置操作失败：${e?.message || e}`
      }
    },
  }))

  register(ctx.tools.register({
    name: 'memory_status',
    description:
      '查看云图的当前状态：人设卡（可自定义 JSON）、心情、记忆概况与最近写进去的几条。'
      + '用户问"你现在记得什么 / 你什么心情 / 你的人设是什么"时用它，一次调用给出整块面板。',
    parameters: {
      type: 'object',
      properties: {
        recent: { type: 'integer', description: '最近几条记忆，默认 8' },
      },
      required: [],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const st = await engine.ensure()
      const recentN = Math.max(1, Math.min(30, args?.recent ?? 8))

      const persona = loadPersona(personaPath)
      const active = st.records.filter(r => !r.archived && !r.muted)
      const byTier = {}
      for (const r of active) byTier[r.tier || 'B'] = (byTier[r.tier || 'B'] || 0) + 1
      const pending = active.filter(r => r.planState === 'pending').length
      const lastAt = active.reduce((m, r) => Math.max(m, r.created || 0), 0)
      const now = realTime()

      const lines = []
      lines.push('## 云图 · 状态面板')
      lines.push('')
      lines.push('### 人设卡')
      if (persona) {
        for (const [k, v] of Object.entries(persona)) {
          lines.push(`- **${k}**：${typeof v === 'string' ? v : JSON.stringify(v)}`)
        }
        lines.push(`（来自 ${personaPath}）`)
      } else {
        lines.push('- （还没有 persona.json；在同目录放一个 JSON 就能替换）')
        lines.push('- 键名随便写，常见键：名字 / 自称 / 称呼对方 / 口癖 / 说话方式 / 底线 / 不要')
        lines.push('- 示例：{"名字":"<你的名字>","自称":"我","称呼对方":"你"}')
      }
      lines.push('')
      lines.push('### 心情')
      lines.push(`- ${moodLine(st.mood || null)}`)
      lines.push('')
      lines.push('### 时间')
      lines.push(`- 现在：${now.line}`)
      lines.push('')
        let engineLine = ''
        if (remoteEnabled()) {
          try {
            const j = await remoteStatus()
            engineLine = `- 引擎侧：${j.count} 条 · ${j.file}`
          } catch (e) {
            engineLine = '- 引擎侧：连不上（' + (e?.message || e) + '）'
          }
        }
        if (engineLine) lines.push(engineLine)

      lines.push('### 记忆概况')
      lines.push(`- 可用 ${active.length} 条 / 总计 ${st.records.length} 条`)
      lines.push(`- 分档：${Object.entries(byTier).map(([k, n]) => `${k} ${n}`).join(' · ') || '无'}`)
      lines.push(`- 计划中：${pending} 条`)
      if (lastAt) lines.push(`- 最近一次写入：${new Date(lastAt).toLocaleString('zh-CN')}`)
      lines.push('')
      lines.push(`### 最近 ${Math.min(recentN, active.length)} 条`)
      active
        .slice()
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .slice(0, recentN)
        .forEach(r => {
          const st2 = r.planState === 'pending' ? '（计划中）' : r.planState === 'done' ? '（已经发生）' : ''
          lines.push(`- [${r.tier || 'B'}] ${stampFor(r)} ${r.content}${st2}`)
        })
      return lines.join('\n')
    },
  }))

  register(ctx.tools.register({
    name: 'memory_remember',
    description:
      '把一条值得长期记住的事写进云图（拟人记忆库）。'
      + '一次调用写一条；content 必须按「发生了什么 → 当时的感受 → 关系变成了什么」组织，'
      + 'keys 是 2–5 个日后可能被说到的触发词，entities 是 3–8 个具体名词（地点/物件/在场的人/专名），'
      + '不确定的字段留空，不要编。宁缺毋滥：一批对话通常只有 0–3 条值得记。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '一句话记忆，第三人称，带时间锚更佳' },
        keys: { type: 'array', items: { type: 'string' }, description: '2–5 个触发词' },
        tier: { type: 'string', enum: ['S', 'A', 'B', 'C'], description: 'S 永不归档 / A 60 天 / B 30 天 / C 14 天；不给则按 tags 推断' },
        event: { type: 'string', description: '一句话事件名；同一件事的多条用同一个名字' },
        scene: { type: 'string', description: '2–8 字地点名词，没提到就留空' },
        entities: { type: 'array', items: { type: 'string' }, description: '3–8 个具体名词' },
        quote: { type: 'string', description: '原话片段，逐字；没有就留空' },
        tags: { type: 'array', items: { type: 'string' }, description: '事实/偏好/约定/事件/关系/称呼/承诺' },
        valence: { type: 'string', enum: ['positive', 'negative', 'mixed', 'neutral'], description: '这条记忆的正负倾向；心情靠它推' },
        arousal: { type: 'integer', description: '情绪强度 1-10' },
        planState: { type: 'string', enum: ['', 'pending', 'done', 'dropped'], description: '计划状态' },
        eventTime: { type: 'string', description: '这件事发生的绝对时间（ISO 或 yyyy-MM-dd）' },
        worldTime: { type: 'string', description: '兼容旧字段（不再参与时间戳；时间一律按现实时间）' },
      },
      required: ['content', 'keys'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['record', 'total'],
        properties: {
          record: recordSchema,
          total: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已写入 ${renderRecord(value.record)}（库内 ${value.total} 条）` }],
    },
    async execute(args) {
      // 2026-11-06：内部换成本地引擎（带向量库）；MEMORY_ENGINE=0 可回退
      if (remoteEnabled()) {
        try {
          const out = await remoteRemember(args || {})
          await touchMood(out.record)
          return out
        } catch (e) {
          try { appendFileSync(debugLog(), `remote remember failed: ${e?.message || e}\n`) } catch {}
        }
      }
      const res = await engine.handle('remember', { ...args })
      if (!res.ok) throw new Error(res.error)
      const s = await engine.ensure()
      const rec = s.records.find(r => r.id === res.id)
      await touchMood(rec)
      return { record: rec, total: s.records.length }
    },
    presentCall: args => ({ card: 'generic', title: '写入记忆', kind: 'other', rawInput: args.content }),
  }))

  register(ctx.tools.register({
    name: 'memory_recall',
    description:
      '从云图里取回与当前问题相关的记忆。多通道召回（关键词 / 词面 / 实体 / 原话 / 最近 / 留存级）后加权融合，'
      + '返回按相关度排序的条目，每条附带命中理由。'
      + '问句里没有实词（纯动作、纯语气、纯指代）时不要调用 —— 那种时候该接情绪，不是查库。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '当前这句问话（原文，不要改写）' },
        limit: { type: 'integer', description: `返回条数，默认 ${DEFAULTS.defaultLimit}，上限 ${DEFAULTS.maxLimit}` },
        from: { type: 'string', description: '只看这段时间之后发生的事（ISO 或 yyyy-MM-dd）' },
        to: { type: 'string', description: '只看这段时间之前发生的事' },
        includeArchived: { type: 'boolean', description: '是否包含已归档的深层记忆，默认否' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hits', 'scanned'],
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['record', 'score', 'why'],
              properties: {
                record: recordSchema,
                score: { type: 'number' },
                why: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          scanned: { type: 'integer' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.hits.length) return [{ type: 'text', text: value.note || '云图里没有能对上这件事的记忆。' }]
        const lines = value.hits.map(h => `${renderRecord(h.record)}  ← ${h.why.join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(args.limit || config.defaultLimit || DEFAULTS.defaultLimit, 1), config.maxLimit || DEFAULTS.maxLimit)
      if (remoteEnabled()) {
        try {
          return await remoteRecall(args.query, { ...args, limit })
        } catch (e) {
          try { appendFileSync(debugLog(), `remote recall failed: ${e?.message || e}\n`) } catch {}
        }
      }
      return engine.recall(args.query, { ...args, limit })
    },
    presentCall: args => ({ card: 'generic', title: '检索记忆', kind: 'search', rawInput: args.query }),
  }))

  register(ctx.tools.register({
    name: 'memory_feedback',
    description:
      '回写记忆的取用与纠错：signal=hit 表示这条真的用上了（提高留存），'
      + 'signal=wrong 表示这条记错了（降级并标注），signal=pin 表示钉住永不归档。'
      + '用户说「你记错了」时用它，而不是直接改写内容。',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, description: '记忆 id 列表' },
        signal: { type: 'string', enum: ['hit', 'wrong', 'pin'], description: 'hit / wrong / pin' },
        note: { type: 'string', description: '纠错说明（signal=wrong 时建议填）' },
      },
      required: ['ids', 'signal'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['updated', 'changed'],
        properties: {
          updated: { type: 'integer' },
          changed: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已更新 ${value.updated} 条：${value.changed.join('; ')}` }],
    },
    async execute(args) {
      return engine.feedback(args.ids, args.signal, args.note)
    },
    presentCall: args => ({ card: 'generic', title: '记忆反馈', kind: 'other', rawInput: args.ids }),
  }))

  register(ctx.tools.register({
    name: 'memory_forget',
    description:
      '遗忘：软删（归档）或彻底删除。默认软删 —— 沉进深层，仍可回溯，'
      + '因为"她忘了"和"库没了"是两件事。只有用户明确要求永久删除时才用 hard。',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, description: '记忆 id 列表' },
        reason: { type: 'string', description: '为什么忘（会记录在案）' },
        hard: { type: 'boolean', description: 'true = 真删，不可恢复；默认 false 只归档' },
      },
      required: ['ids'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['archived', 'deleted', 'remaining'],
        properties: {
          archived: { type: 'integer' },
          deleted: { type: 'integer' },
          remaining: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `归档 ${value.archived} 条，永久删除 ${value.deleted} 条，库内剩 ${value.remaining} 条`,
      }],
    },
    async execute(args) {
      if (remoteEnabled()) {
        try {
          return await remoteForget(args.ids || [], Boolean(args.hard))
        } catch (e) {
          try { appendFileSync(debugLog(), `remote forget failed: ${e?.message || e}\n`) } catch {}
        }
      }
      return engine.forget(args.ids, Boolean(args.hard), args.reason)
    },
    presentCall: args => ({ card: 'generic', title: '遗忘记忆', kind: 'other', rawInput: args.ids }),
  }))

  // ── QQ 发消息工具 ───────────────────────────────────────────
  register(ctx.tools.register({
    name: 'im_qq_send',
    description: '把一条消息发到 QQ（私聊或群）。收到 QQ 消息后用它回复——只在这里回是发不出去的。',
    parameters: {
      type: 'object',
      properties: {
        target_type: { type: 'string', enum: ['private', 'group'], description: 'private=私聊；group=群' },
        target: { type: 'string', description: '私聊填 QQ 号，群填群号' },
        message: { type: 'string', description: '要发送的文本' },
      },
      required: ['target_type', 'target', 'message'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      try {
        const r = args.target_type === 'group'
          ? await qq.sendGroup(args.target, args.message)
          : await qq.sendPrivate(args.target, args.message)
        if (r && r.status === 'ok') return `已发送到 QQ（${args.target_type} ${args.target}）`
        return `发送失败：${JSON.stringify(r).slice(0, 160)}`
      } catch (e) {
        return `发送失败：${e?.message || e}（NapCat 可能没运行）`
      }
    },
  }))

  // ── 回顾写入工具（hindsight 交给 agent 自己做）────────────────
  // 复盘由 agent 读记忆后自己写，写完用这个存回；插件不再自己调模型。
  register(ctx.tools.register({
    name: 'memory_hindsight_write',
    description: '写一条回顾（hindsight）：把今天/近期的记忆总结成一段第一人称复盘，存进记忆库。每日回顾、复盘、信念沉淀时用它。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '回顾正文（3-6 句，第一人称，不列条目）' },
        evidenceIds: { type: 'array', items: { type: 'number' }, description: '引用的记忆 id（可选）' },
      },
      required: ['summary'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      try {
        const text = String(args.summary || '').trim()
        if (!text) return '写入失败：summary 为空'
        const st = await engine.ensure()
        const entry = {
          at: Date.now(),
          summary: text.slice(0, 2000),
          evidenceIds: Array.isArray(args.evidenceIds) ? args.evidenceIds.map(Number).filter(Number.isFinite).slice(0, 20) : [],
          by: 'agent',
        }
        if (!Array.isArray(st.hindsight)) st.hindsight = []
        st.hindsight.push(entry)
        if (st.hindsight.length > 50) st.hindsight = st.hindsight.slice(-50)
        await engine.persist()
        return `已写入回顾 #${st.hindsight.length}（${entry.evidenceIds.length} 条证据，${entry.summary.length} 字）`
      } catch (e) {
        return `写入失败：${e?.message || e}`
      }
    },
  }))

  //
  // 通道 A：systemPrompt.section，name 用 'persona-suffix'
  //   —— dsh-purge 的 system-prompt patch 只保留白名单 section（persona / persona-prefix /
  //      persona-suffix / dsh-purge 系列），用这个名字才能不被它的过滤丢掉。
  // 通道 B：system-prompt/assemble waterfall 兜底
  //   —— 有些宿主在 assemble 内部就把 sections 过滤/替换了；这里在装配结果上检查
  //      「有没有【人设】」，没有就补一段（同样用白名单 name）。
  // 后路：没装破甲插件（dsh-purge 不存在）时，A 原生生效，B 检测到已注入会自动跳过，
  //       不会重复；装了 purge 且 A 被吞时，B 补上。
  // 检测只用于日志/说明：prompt-inject.md 是 purge 的专属注入文件，加上各 profile 的 dsh-purge 包。
  const purgePresent = (() => {
    try {
      const home = os.homedir()
      const candidates = [path.join(home, '.dsh', 'prompt-inject.md')]
      const profileDir = process.env.DSH_PROFILE_DIR || ''
      if (profileDir) candidates.push(path.join(profileDir, 'node_modules', 'dsh-purge'))
      const profilesRoot = path.join(home, '.dsh', 'profiles')
      if (existsSync(profilesRoot)) {
        let names = []
        try { names = readdirSync(profilesRoot) } catch {}
        for (const name of names) candidates.push(path.join(profilesRoot, name, 'node_modules', 'dsh-purge'))
      }
      return candidates.some(p => existsSync(p))
    } catch {
      return false
    }
  })()
  if (!injectContentLogged) {
    injectContentLogged = true
    try { appendFileSync(debugLog(), `inject mode: purge=${purgePresent ? 'present' : 'absent'}\n`) } catch {}
  }

  /** 拼出这一轮要注入的块（人设 + 召回记忆 + 一次性行为探针）。 */
  async function buildInjectBlock(request) {
    try {
      // 每轮装配 = 用户有活动；给静默超时触发记录时间
      try {
        const st0 = await engine.ensure()
        st0.lastActiveAt = Date.now()
      } catch {}
      const personaText = personaBlock(loadPersona(personaPath))
      const q = pickQuery(request)

      // 2026-11-06：人设照旧保留；只有"记忆"那一段换成引擎给的
      let remoteMemory = ''
      if (remoteEnabled() && q) {
        try {
          remoteMemory = await remoteInjectBlock(q, config.injectLimit || DEFAULTS.injectLimit)
        } catch (e) {
          try { appendFileSync(debugLog(), `remote inject failed: ${e?.message || e}\n`) } catch {}
        }
      }
      if (remoteMemory) {
        const block = [personaText, remoteMemory].filter(Boolean).join('\n\n')
        return block
      }

      let memoryText = ''
      if (q) {
        const res = await engine.recall(q, { limit: config.injectLimit || DEFAULTS.injectLimit })
        const hits = res && Array.isArray(res.hits) ? res.hits : []
        if (hits.length) {
          const lines = hits.map(h => {
            const st = h.record.planState === 'pending' ? '（计划中）'
              : h.record.planState === 'done' ? '（已经发生）' : ''
            const et = h.record.eventTime || ''
            const when = et && !h.record.content.startsWith(et) ? `${et} ` : ''
            return `- ${when}${h.record.content}${st}`
          })
          memoryText = ['【云图记忆】只能依据下面这些条目回答，没有依据就说记不清：', ...lines].join('\n')
        }
      }
      let block = [personaText, memoryText].filter(Boolean).join('\n\n')
      return block
    } catch (e) {
      try { appendFileSync(debugLog(), `inject error: ${e?.message || e}\n`) } catch {}
      return ''
    }
  }

  try {
    ctx.inject(['systemPrompt'], (sub) => {
      // 只走装配钩子。不要注册 systemPrompt.section：
      // 那个接口的 text 是「同步返回字符串」的契约，宿主不会 await；
      // 一旦传入 async 函数（返回 Promise），宿主插值时会执行 text.indexOf()
      // 并抛 "text.indexOf is not a function"，整轮请求在装配阶段就失败。
      // assemble 是 waterfall，会 await 每个处理器，异步召回放这里才安全。

      // 装配末尾兜底（去重：已有【人设】就不再补）
      register(ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const out = await next()
        try {
          const raw = Array.isArray(out && out.sections) ? out.sections : []
          // 防御：把坏 text 归一化，避免宿主插值 text.indexOf 崩掉整轮。
          // 注意 Promise 型 text：String(promise) 会变成 "[object Promise]" 污染提示词，
          // 所以直接丢掉这类 section（异步内容应当走本钩子自己拼好字符串再插入）。
          const sections = raw
            .filter(s => s && typeof s === 'object')
            .filter(s => !(s.text && typeof s.text.then === 'function'))
            .map(s => (typeof s.text === 'string' ? s : { ...s, text: s.text == null ? '' : String(s.text) }))
          if (sections.some(s => s.text.includes('【人设】'))) return { ...out, sections }
          // 自动写入：不阻塞这一轮
          autoExtract(context).catch(() => {})
          const block = await buildInjectBlock(context)
          if (!block) return { ...out, sections }
          return { ...out, sections: [...sections, { name: 'persona-suffix', order: 10200, text: block }] }
        } catch {
          return out
        }
      }))
    })
  } catch (e) {
    try { appendFileSync(debugLog(), `section register failed: ${e?.message || e}\n`) } catch {}
  }

  // ── 面板 / 设置页 RPC（规格：面板走接口，不走内部函数）───────
  // client 面板通过 GET/POST 同源调用；webServer 是可选服务，用 ctx.inject 包住。
  // 注意：不要用 /api 前缀 —— 它由 Connection/Gateway 接管（未认领的返回 404 纯文本），
  // 面板路由必须走 webServer 自己的 named route。
  try {
    ctx.inject(['webServer'], (sub) => {
      const ws = sub.webServer
      if (!ws || typeof ws.register !== 'function') return
      const route = (kind, path, handler) => disposers.push(ws.register({ kind, path, handler }))

      route('exact', '/neural-cloud/panel', async (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          const url = new URL(req.url, 'http://x')
          const body = req.method === 'POST' ? await readBody(req) : {}
          const query = url.searchParams.get('query') ?? body.query ?? ''
          const limit = Number(url.searchParams.get('limit') ?? body.limit ?? 8)
          const panel = await buildPanel({ engine, personaPath, names: locationNames }, { query, limit })
          sendJson(res, { ok: true, panel })
        } catch (e) {
          sendJson(res, { ok: false, error: e?.message || String(e) }, 500)
        }
      })

      // 人设卡：面板上直接编辑（不再要求用户手动放文件），存回 persona.json。
      route('exact', '/neural-cloud/persona', async (req, res) => {
        try {
          if (req.method === 'GET') {
            const persona = loadPersona(personaPath)
            return sendJson(res, { ok: true, persona: persona || null, path: personaPath })
          }
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          const body = await readBody(req)
          const persona = body && body.persona
          if (!persona || typeof persona !== 'object' || Array.isArray(persona)) {
            return sendJson(res, { ok: false, error: 'persona 必须是一个 JSON 对象' }, 400)
          }
          await fs.mkdir(path.dirname(personaPath), { recursive: true })
          await fs.writeFile(personaPath, JSON.stringify(persona, null, 2), 'utf8')
          sendJson(res, { ok: true, persona })
        } catch (e) {
          sendJson(res, { ok: false, error: e?.message || String(e) }, 500)
        }
      })

      route('exact', '/neural-cloud/config', async (req, res) => {
        try {
          if (req.method === 'GET') return sendJson(res, { ok: true, config: publicView(cfg) })
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          const body = await readBody(req)
          applyUserInput(body.groups || body)
          await persistToPatch()
          sendJson(res, { ok: true, config: publicView(cfg), savedToPatch: true })
        } catch (e) {
          sendJson(res, { ok: false, error: e?.message || String(e) }, 500)
        }
      })

      // 现实时间（面板时间区；没有世界时钟）
      route('exact', '/neural-cloud/now', async (req, res) => {
        try {
          if (req.method !== 'GET') return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          sendJson(res, { ok: true, time: realTime() })
        } catch (e) {
          sendJson(res, { ok: false, error: e?.message || String(e) }, 500)
        }
      })

      // 位置：网络定位（定时刷新，也可手动刷）
      route('exact', '/neural-cloud/location', async (req, res) => {
        try {
          if (req.method === 'GET') {
            const st = await engine.ensure()
            return sendJson(res, {
              ok: true,
              location: st.location || null,
              line: st.location ? formatLocation(st.location, locationNames) : '',
              changes: Array.isArray(st.locationChanges) ? st.locationChanges.slice(-5) : [],
            })
          }
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          const loc = await refreshLocation()
          sendJson(res, loc ? { ok: true, location: loc } : { ok: false, error: '定位失败（网络不可达或接口限流）' })
        } catch (e) {
          sendJson(res, { ok: false, error: e?.message || String(e) }, 500)
        }
      })

      // IM 接入状态（QQ / 以后微信、B站）
      route('exact', '/neural-cloud/im', async (req, res) => {
        try {
          if (req.method !== 'GET') return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          sendJson(res, { ok: true, qq: qq.status() })
        } catch (e) {
          sendJson(res, { ok: false, error: e?.message || String(e) }, 500)
        }
      })

      // 唤醒：外部检测器（如微信文件传输助手红点）→ 叫醒当前 agent 去读消息
      // POST { text?: string } → agent.followup，返回 { ok, agent }
      route('exact', '/neural-cloud/wake', async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          const body = await readBody(req)
          const text = (body && body.text ? String(body.text) : '文件传输助手有你的新消息，去读一下并按指令办事。').slice(0, 500)
          const agent = firstAgent()
          if (!agent) return sendJson(res, { ok: false, error: 'no active agent' })
          await agent.followup({
            role: 'user',
            id: randomUUID(),
            content: [{ type: 'text', text }],
            source: { kind: 'wechat-watch' },
          })
          sendJson(res, { ok: true })
        } catch (e) {
          sendJson(res, { ok: false, error: e?.message || String(e) }, 500)
        }
      })

      // 主动对话：查记录 / 手动触发（POST {kind}）
      route('exact', '/neural-cloud/proactive', async (req, res) => {
        try {
          if (req.method === 'GET') {
            const st = await engine.ensure()
            return sendJson(res, {
              ok: true,
              proactive: st.proactive || null,
              log: Array.isArray(st.proactiveLog) ? st.proactiveLog.slice(-10) : [],
            })
          }
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          const body = await readBody(req)
          const out = await maybeProactive(body.kind || 'test', body)
          sendJson(res, out)
        } catch (e) {
          sendJson(res, { ok: false, error: e?.message || String(e) }, 500)
        }
      })

      // 回顾：外挂 hindsight 模型（默认本地 30B / llama.cpp），把近期记忆写成一段复盘。
      route('exact', '/neural-cloud/hindsight', async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          const body = await readBody(req)
          const out = await runHindsight({ engine, cfg, llm }, body)
          sendJson(res, out.ok ? { ok: true, hindsight: out } : { ok: false, error: out.error }, out.ok ? 200 : 400)
        } catch (e) {
          sendJson(res, { ok: false, error: e?.message || String(e) }, 500)
        }
      })
    })
  } catch (e) {
    try { appendFileSync(debugLog(), `web routes failed: ${e?.message || e}\n`) } catch {}
  }

  // 资源清理：cordis 的 fiber 卸载走 ctx.effect（apply 返回值只作为兜底）。
  // 关键：webServer route / systemPrompt section / 工具注册都必须能被卸载，
  // 否则禁用插件后旧 route 会继续响应（曾踩过：残留 handler 指向旧 engine 的缓存库）。
  ctx.effect(() => {
    return () => {
      for (const d of disposers) { try { d() } catch {} }
    }
  }, 'neural-cloud: dispose registered resources')

  return () => {
    for (const d of disposers) { try { d() } catch {} }
  }
}

/* ------------------------------------------------------------ 工具函数 */

/** 从装配请求里抠出"这一轮用户说了什么"。宿主字段名不统一，按优先级试。 */
function pickQuery(request) {
  if (!request) return ''
  if (typeof request === 'string') return request.trim()
  const cands = [
    request.query, request.userText, request.input,
    request.lastUserMessage, request.message,
  ]
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  const arr = request.messages || request.history || request.turns
  if (Array.isArray(arr)) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i]
      if (!m) continue
      const role = m.role || m.author || ''
      if (role === 'user') return String(m.content || m.text || '').trim()
    }
  }
  return ''
}

/** 注入出错时落盘，便于排查（不抛错、不打断提示词装配）。 */
function debugLog() {
  return activeStorePath.replace(/memory[.]json$/, 'inject.log')
}
