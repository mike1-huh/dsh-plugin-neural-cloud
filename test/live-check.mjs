// 真实接口连通性检查：用本地 config.json 里的 key 调 embedding / rerank
import { loadConfig } from '../lib/config.js'
import { embed, rerank } from '../lib/llm.js'
import os from 'node:os'
import path from 'node:path'

const p = path.join(os.homedir(), '.dsh', 'storages', 'neural-cloud', 'config.json')
const cfg = loadConfig(p)

console.log('embedding base:', cfg.embedding.base, '| key set:', Boolean(cfg.embedding.key))
try {
  const vec = await embed(cfg, ['窗台上的猫在睡觉'])
  console.log('embed ok, dim =', Array.isArray(vec) && vec[0] ? vec[0].length : 'null')
} catch (e) {
  console.log('embed FAIL:', e.message)
}

console.log('rerank base:', cfg.rerank.base, '| key set:', Boolean(cfg.rerank.key))
try {
  const r = await rerank(cfg, '窗台上的猫', ['窗台上的猫在睡觉', '狗在院子里追球'])
  console.log('rerank ok:', JSON.stringify(r))
} catch (e) {
  console.log('rerank FAIL:', e.message)
}
