/**
 * 云图 · 接口调用封装（2026-10-28）
 *
 * 只保留两组：
 * ```
 * embedding  向量   空 = 关闭向量通道（返回 null，引擎跳过）
 * rerank     精排   空 = 不做精排（返回 null）
 * ```
 *
 * 摘要与回顾不在这里 —— 它们交给对话窗口里的模型（插件不代跑 LLM 生成）。
 * 所有 key 只在本进程内存 + 本地 config.json 里，不写日志、不进提示词。
 */
/** 拼接接口地址：base 已带目标 path（如用户直接贴了 .../v1/embeddings）时不再重复拼接。 */
function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '')
  if (!b) return b
  if (b.endsWith(path)) return b
  return b + path
}

async function post(base, path, body, key, timeoutMs = 60000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(joinUrl(base, path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 向量（embedding 组）：没配置就返回 null（引擎跳过向量通道）。 */
export async function embed(cfg, texts) {
  const c = cfg.embedding
  if (!c.base) return null
  const data = await post(c.base, '/embeddings', {
    model: c.model || 'bge-m3',
    input: texts,
  }, c.key, 30000)
  return (data?.data || []).map(d => d.embedding)
}

/**
 * 精排（rerank 组）：cross-encoder 重排召回候选。
 * 返回 `[{ index, relevance_score }]`（index 对应 documents 下标）；没配置返回 null。
 */
export async function rerank(cfg, query, documents, opts = {}) {
  const c = cfg.rerank
  if (!c.base || !Array.isArray(documents) || !documents.length) return null
  // key 可只填在 embedding 组（同一家 provider 常见），这里做一次兜底
  const key = c.key || (cfg.embedding && cfg.embedding.key) || ''
  const data = await post(c.base, '/rerank', {
    model: c.model || 'BAAI/bge-reranker-v2-m3',
    query,
    documents,
    top_n: opts.topN || documents.length,
    return_documents: false,
  }, key, 30000)
  return Array.isArray(data?.results) ? data.results : null
}

/**
 * 通用对话（复用 hindsight 组的端点，默认本地 30B）。
 * 用于意图生成这类"要模型自己想"的场景，不绑定固定 system prompt。
 */

/* ------------------------------------------------------------------
 * 2026-11-06：生成类的活交给宿主（DSH）自己的模型
 *
 * 抽取与回顾本来就是 agent 调工具完成的；这里再拦两道，
 * 避免插件背着宿主偷偷调一次模型（浪费、且和宿主的记忆口径不一致）。
 * 需要恢复：环境变量 MEMORY_HOST_MODEL_ONLY=0
 * ------------------------------------------------------------------ */
function hostModelOnly() {
  return process.env.MEMORY_HOST_MODEL_ONLY === '1'
}

export async function chat(cfg, messages, opts = {}) {
  // 2026-11-06：意图生成仍用这里（云图自己管理）
  const c = cfg.hindsight
  if (!c.base) throw new Error('没有可用的对话接口：请在设置里配置 hindsight 的 base')
  const data = await post(c.base, '/chat/completions', {
    model: c.model || 'local',
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 600,
    messages,
  }, c.key, opts.timeoutMs || 120000)
  return String(data?.choices?.[0]?.message?.content || '').trim()
}

/**
 * 回顾（hindsight 组）：外挂的记忆回顾模型（默认本地 llama.cpp，OpenAI 兼容 /v1）。
 * 输入近期记忆块，输出一段第一人称复盘；evidenceIds 由调用方（panel）负责。
 */
export async function hindsight(cfg, memoryText, opts = {}) {
  // 2026-11-06：回顾仍由 hindsight（本地模型）生成，不受 hostModelOnly 影响
  const c = cfg.hindsight
  if (!c.base) throw new Error('没有可用的回顾接口：请在设置里配置 hindsight 的 base（如本地 http://127.0.0.1:8091/v1）')
  const data = await post(c.base, '/chat/completions', {
    model: c.model || 'local',
    temperature: opts.temperature ?? 0.5,
    max_tokens: opts.maxTokens ?? 800,
    messages: [
      {
        role: 'system',
        content: '你是一个记忆回顾器。根据给定的记忆条目，用第一人称写一段 3–6 句的回顾：发生了什么、当时的感受、关系或状态有什么变化、还惦记着什么。像睡前日记，不列条目，不编造原文没有的事。',
      },
      { role: 'user', content: memoryText },
    ],
  }, c.key, opts.timeoutMs || 120000)
  return String(data?.choices?.[0]?.message?.content || '').trim()
}
