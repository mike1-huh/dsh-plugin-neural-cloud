/**
 * 云图 · 配置层（2026-10-28）
 *
 * 三组接口：embedding / rerank / hindsight，每组 { base, key, model }。
 * （summary / chat 已移除：摘要交给对话窗口；回顾用外挂的 hindsight 模型，
 *   默认指向本地 llama.cpp（OpenAI 兼容 /v1）。）
 *
 * 读取优先级：本地 config.json 覆盖文件 > cordis 传入（cordis.patch.yml 的 config:）> 默认。
 * 留空规则：
 * - embedding 留空 → 关闭向量通道（引擎回退关键词召回）
 * - rerank 留空    → 不做精排（直接用 RRF 融合结果）
 * - hindsight 留空 → 无法生成回顾（面板按钮会报错）
 * - 所有 key 只存本地（config.json），不落日志、不进提示词
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const GROUPS = ['embedding', 'rerank', 'hindsight']

const DEFAULTS = {
  embedding: { base: '', key: '', model: 'bge-m3' },
  rerank: { base: '', key: '', model: 'BAAI/bge-reranker-v2-m3' },
  hindsight: { base: '', key: '', model: '' },
}

/** 由 storePath（…/memory.json）推导同目录的 config.json / persona.json。 */
export function sidecarPath(storePath, name) {
  return storePath.replace(/memory[.]json$/, name)
}

/** 读配置：本地覆盖文件 > cordis 传入 > 默认。 */
export function loadConfig(configPath, inline = {}) {
  let file = {}
  try {
    if (configPath && existsSync(configPath)) {
      file = JSON.parse(readFileSync(configPath, 'utf8'))
    }
  } catch {
    file = {}
  }
  const pick = k => ({
    base: '',
    key: '',
    model: DEFAULTS[k].model,
    ...(file[k] || {}),
    ...(inline[k] || {}),
  })
  return {
    embedding: pick('embedding'),
    rerank: pick('rerank'),
    hindsight: pick('hindsight'),
  }
}

export function saveConfig(configPath, cfg) {
  const out = {
    embedding: cfg.embedding,
    rerank: cfg.rerank,
    hindsight: cfg.hindsight,
  }
  mkdirSync(path.dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(out, null, 2), 'utf8')
}

/** key 打码：面板/工具里显示用，永远不回显完整 key。 */
export function maskKey(k) {
  if (!k) return ''
  if (k.length <= 8) return '***'
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}

export function describe(cfg) {
  const one = (name, c) => {
    if (!c.base) return `${name}: 未配置`
    return `${name}: ${c.base} · ${c.model || '(默认模型)'} · key ${maskKey(c.key) || '(无)'}`
  }
  return [
    one('向量', cfg.embedding) + (cfg.embedding.base ? '' : '（向量通道关闭）'),
    one('精排', cfg.rerank) + (cfg.rerank.base ? '' : '（不做精排）'),
    one('回顾', cfg.hindsight) + (cfg.hindsight.base ? '' : '（无法生成回顾）'),
  ].join('\n')
}

/** 面板视图：key 只给打码。 */
export function publicView(cfg) {
  const one = c => ({
    base: c.base,
    key: maskKey(c.key),
    hasKey: Boolean(c.key),
    model: c.model,
  })
  return {
    embedding: one(cfg.embedding),
    rerank: one(cfg.rerank),
    hindsight: one(cfg.hindsight),
    rule: '向量留空 = 关闭向量通道；精排留空 = 不做精排；回顾留空 = 不生成回顾。',
  }
}
