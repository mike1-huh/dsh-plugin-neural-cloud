/**
 * 人设卡（2026-10-28）
 *
 * 用户自己写一个 `persona.json` 就能换人 —— 不动代码。
 * 位置：和 `memory.json` 同目录（默认 `~/.dsh/storages/neural-cloud/persona.json`）。
 *
 * ```json
 * {
 *   "名字": "<你的名字>",
 *   "自称": "我",
 *   "称呼对方": "你",
 *   "口癖": ["嗯", "嘛"],
 *   "说话方式": "简短、直接",
 *   "底线": ["不编造事实"],
 *   "不要": ["不要客套"]
 * }
 * ```
 *
 * 键名随便写，面板会原样列出来；但下面这几个键会被拼进提示词（有就用，没有就跳过）。
 */
import { existsSync, readFileSync } from 'node:fs'

/** 这些键会被拼进系统提示词（有就用，没有就跳过）；其余键只在面板展示。 */
export const PROMPT_KEYS = [
  '名字', '自称', '称呼对方',
  '性格', '关系', '口癖', '说话方式', '关心方式', '玩笑', '小毛病', '情绪',
  '底线', '不要', '示例',
]

export function loadPersona(personaPath) {
  try {
    if (existsSync(personaPath)) {
      const raw = JSON.parse(readFileSync(personaPath, 'utf8'))
      return raw && typeof raw === 'object' ? raw : null
    }
  } catch {
    return null
  }
  return null
}

/** 拼成一段能给模型看的人设块；没有 persona.json 返回空串。 */
export function personaBlock(persona) {
  if (!persona) return ''
  const lines = []
  for (const k of PROMPT_KEYS) {
    const v = persona[k]
    if (v === null || v === undefined || v === '') continue
    if (k === '名字') lines.push(`你是「${v}」。`)
    else if (k === '自称') lines.push(`自称「${v}」。`)
    else if (k === '称呼对方') lines.push(`叫对方「${v}」。`)
    else if (Array.isArray(v)) { if (v.length) lines.push(`${k}：${v.join('；')}`) }
    else if (typeof v === 'string' && v.trim()) lines.push(`${k}：${v}`)
  }
  return lines.length ? ['【人设】', ...lines].join('\n') : ''
}

/** 面板展示用：所有键都列出来（不限 PROMPT_KEYS）。 */
export function personaRows(persona) {
  if (!persona) return []
  return Object.entries(persona).map(([k, v]) => ({
    key: k,
    value: typeof v === 'string' ? v : JSON.stringify(v),
    inPrompt: PROMPT_KEYS.includes(k),
  }))
}
