/**
 * 意图闸门：程序唯一有权说"不"的地方。
 *
 * 意图由人格和记忆产生，能不能落地由这里卡：
 * 阈值 / 静默时段 / 用户正忙 / 每日上限 / 最小间隔 / 同对象 24h 去重。
 */
export const DEFAULT_GATE = {
  threshold: 0.6,
  quietStart: 23,
  quietEnd: 8,
  dailyLimit: 3,
  minGapMs: 90 * 60 * 1000,
  userActiveMs: 5 * 60 * 1000,
  sameTargetMs: 24 * 3600 * 1000,
}

const isSpeaking = type => type === 'say' || type === 'care'

export function gateIntent(intent, { now = new Date(), state = {}, gate = {} } = {}) {
  const g = { ...DEFAULT_GATE, ...gate }
  const type = String(intent.type || 'idle')
  if (type === 'idle') return { pass: false, why: 'idle' }
  if ((Number(intent.urgency) || 0) < g.threshold) return { pass: false, why: 'below-threshold' }

  const hour = now.getHours()
  const speaking = isSpeaking(type)

  if (speaking) {
    if (hour >= g.quietStart || hour < g.quietEnd) return { pass: false, why: 'quiet-hours' }
    if (Date.now() - (Number(state.lastUserAt) || 0) < g.userActiveMs) return { pass: false, why: 'user-active' }

    const day = now.toDateString()
    const p = state.proactive && state.proactive.day === day ? state.proactive : { day, count: 0, lastAt: 0 }
    if (Number(p.count) >= g.dailyLimit) return { pass: false, why: 'daily-limit' }
    if (Date.now() - (Number(p.lastAt) || 0) < g.minGapMs) return { pass: false, why: 'min-gap' }
  }

  const target = String(intent.target || '')
  if (target) {
    const log = Array.isArray(state.intentLog) ? state.intentLog : []
    const dup = log.some(x => x && x.target === target && x.state === 'sent' && Date.now() - (Number(x.at) || 0) < g.sameTargetMs)
    if (dup) return { pass: false, why: 'same-target-24h' }
  }

  return { pass: true }
}

/** 竞争：按 urgency 从高到低，返回第一个过闸的意图（其余留给下一轮）。 */
export function pickIntent(intents, opts = {}) {
  const ranked = [...(intents || [])].sort((a, b) => (Number(b.urgency) || 0) - (Number(a.urgency) || 0))
  const rejected = []
  for (const it of ranked) {
    const r = gateIntent(it, opts)
    if (r.pass) return { intent: it, rejected }
    rejected.push({ want: it.want, urgency: it.urgency, why: r.why })
  }
  return { intent: null, rejected }
}
