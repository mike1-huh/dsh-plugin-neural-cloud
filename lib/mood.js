/**
 * 心情（2026-10-28）
 *
 * 存进 `memory.json` 的 `mood` 字段，结构：
 * ```json
 * { "label": "有点不安", "intensity": 6, "valence": "mixed", "updated": 1793158000000 }
 * ```
 *
 * 两个来源：
 *  ```
 * ① 写入记忆时顺手更新  —— valence/arousal 已经表达了当时的情绪，不用再花一次调用
 * ② 模型显式设置        —— memory_mood 工具（她说"我现在有点难过"这类）
 *  ```
 * 为什么不让 LLM 单独判：那是每轮一次额外请求；valence 本来就在记忆里。
 */

/** 由 valence + arousal 推一个心情标签（确定性，不花 token）。 */
export function moodFromMemory(record) {
  const v = (record.valence || '').toLowerCase()
  const a = Number(record.arousal || 0)
  let label
  if (v === 'positive') {
    label = a >= 8 ? '强烈满足' : a >= 5 ? '开心' : '平静偏暖'
  } else if (v === 'negative') {
    label = a >= 8 ? '激烈的难过或生气' : a >= 5 ? '不安' : '低落'
  } else if (v === 'mixed') {
    label = a >= 7 ? '又爱又气' : '复杂'
  } else {
    label = a >= 7 ? '有点上头' : '平静'
  }
  return {
    label,
    intensity: Math.max(1, Math.min(10, a || 5)),
    valence: v || 'neutral',
    updated: Date.now(),
    from: `memory#${record.id ?? '?'}`,
  }
}

/** 面板展示：一行话。 */
export function moodLine(mood) {
  if (!mood) return '（还没有心情记录）'
  const t = mood.updated ? new Date(mood.updated).toLocaleString('zh-CN') : ''
  return `${mood.label}${mood.intensity ? `（${mood.intensity}/10）` : ''}${t ? ` · ${t}` : ''}`
}
