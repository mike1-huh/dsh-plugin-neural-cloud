/**
 * 意图执行：把"想做什么"落到具体能力上。
 *
 * say / care  → 走 DSH 对话（followup 让当前 agent 用自己口吻说）
 * remember    → memory_remember
 * recall      → memory_recall（自己串联旧事）
 * act         → 暂不支持（留给后续接工具）
 */
import { randomUUID } from 'node:crypto'

export async function executeIntent(intent, deps = {}) {
  const { engine, agent } = deps
  const type = String(intent.type || '')
  const want = String(intent.want || '').trim()
  if (!want) return { ok: false, why: 'empty' }

  if (type === 'say' || type === 'care') {
    if (!agent || typeof agent.followup !== 'function') return { ok: false, why: 'no-agent' }
    await agent.followup({
      role: 'user',
      id: randomUUID(),
      content: [{
        type: 'text',
        text: `（这是你自己此刻的念头，不是用户发的）${want}\n用自己的口吻说出来或做掉它，1–2 句，别像系统通知。`,
      }],
      source: { kind: 'intent' },
    })
    return { ok: true, detail: 'dsh-followup' }
  }

  if (type === 'act') {
    // 2026-10-28 用户口径：act 是**现实里的身体动作**（起身、走过去、拿东西、调灯），
    // 不是"查资料/操作电脑"。所以这里不再调 agent 的工具链 ——
    // 伴侣场景里她做了什么，只需要：
    //   ① 记一条动作记忆（她"刚做过什么"，之后能被想起）
    //   ② 返回 ok，让上层决定要不要把这个动作变成旁白
    await engine.handle('remember', {
      content: want,
      keys: [want.slice(0, 12)],
      tags: ['动作'],
      tier: 'C',
      valence: 'neutral',
      arousal: 3,
    })
    return { ok: true, detail: 'companion-act', narration: want }
  }

  if (type === 'remember') {
    const r = await engine.handle('remember', {
      content: want,
      keys: [want.slice(0, 12)],
      tags: ['主动', '意图'],
      tier: 'B',
    })
    return { ok: Boolean(r && r.ok), detail: 'remembered' }
  }

  if (type === 'recall') {
    const r = await engine.handle('recall', { query: want, limit: 5 })
    return { ok: Boolean(r && r.ok), detail: `recalled ${(r && r.items && r.items.length) || 0}` }
  }

  return { ok: false, why: `unsupported:${type}` }
}
