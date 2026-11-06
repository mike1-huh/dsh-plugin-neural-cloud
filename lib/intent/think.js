/**
 * 意图生成：人格 + 记忆 + 此刻 → 0-3 条「想做什么」
 *
 * 这是整个主动系统的起点。程序不决定说什么，只负责把上下文摆好；
 * 说什么、找谁、急不急，全由模型在这个人格下自己判断。
 */
import * as llm from '../llm.js'

const SYSTEM = `你现在就是这个人格本体，不是在扮演助手。
根据【人格】【记忆】【此刻】【心情】【信号】，判断你此刻想做什么。
只输出一个 JSON 数组（0 到 3 条），不要解释、不要 markdown、不要代码块。

每条格式：
{"type":"say|care|remember|recall|act|idle","want":"一句话说清想做什么","target":"通道（从给定的里选，可不填）","urgency":0到1,"reason":"依据（哪条记忆或什么信号）"}

type 的含义（只选一个）：
- say       想说句话（找对方说话、发个消息）
- care      关心对方（吃没吃、早点睡、天冷多穿）
- remember  该把某件事记下来
- recall    想整理 / 串联旧事
- act       想动一下身体：起身、走过去、拿东西、倒水、把灯调暗、给人披件衣服
            —— 是**现实里的动作**，不是查资料、不是操作电脑、不是搜东西
- idle      什么都不做

规则：
- 确实没什么想做的，输出 []
- urgency 是"现在就想做的冲动"：0.85+ 憋不住；0.6-0.85 想说；0.6 以下只是念头
- target 只能从【可用通道】里选；say/care 必须给 target
- reason 必须指向具体的记忆 id 或信号，不要写"感觉很自然"这种
- 不要为了填满数组而编，宁少勿多`

/** 从模型输出里抠出 JSON 数组（容忍前后废话和代码块）。 */
export function parseIntents(raw) {
  if (!raw) return []
  const text = String(raw)
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .filter(x => x && typeof x === 'object')
      .map(x => ({
        type: String(x.type || 'idle'),
        want: String(x.want || '').trim(),
        target: String(x.target || '').trim(),
        urgency: Math.max(0, Math.min(1, Number(x.urgency) || 0)),
        reason: String(x.reason || '').trim(),
      }))
      .filter(x => x.want)
      .slice(0, 3)
  } catch {
    return []
  }
}

export async function thinkIntents({ personaText, records, mood, timeInfo, location, channels, signals, intentHistory, cfg }) {
  const mem = (records || [])
    .slice(-30)
    .map(r => `- [${r.id}] ${r.stamp || ''} ${r.planState === 'pending' ? '（计划中）' : ''}${r.content}`)
    .join('\n')
  const hist = (intentHistory || [])
    .slice(-6)
    .map(i => `- ${i.type}「${i.want || ''}」→ ${i.state}${i.repliedMs ? `（${Math.round(i.repliedMs / 60000)} 分钟后回应）` : ''}`)
    .join('\n')

  const user = [
    `【人格】\n${personaText || '（未设置）'}`,
    `【此刻】${timeInfo}${location ? ` · ${location}` : ''}`,
    `【心情】${mood || '平静'}`,
    `【可用通道】${(channels || ['dsh:this']).join(' / ')}`,
    `【最近记忆】\n${mem || '（空）'}`,
    `【信号】\n${(signals || []).length ? signals.map(s => `- ${s.kind}: ${s.text}`).join('\n') : '（无）'}`,
    `【最近主动记录】\n${hist || '（无）'}`,
  ].join('\n\n')

  const raw = await llm.chat(cfg, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ], { temperature: 0.8, maxTokens: 500 })

  return parseIntents(raw)
}
