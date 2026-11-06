// 精排（离线断言）：假 rerankFn 验证重排生效；抛错时保持 RRF 原序
import { createEngine } from '../lib/engine.js'
import { checkAsync, summary, section, assert } from './_harness.mjs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = path.join(os.homedir(), '.dsh', 'storages', 'nc-rerank-test')
fs.rmSync(dir, { recursive: true, force: true })
const storePath = path.join(dir, 'memory.json')

// 假 rerank：把第二条（index 1）排第一
const rerankFn = async (query, docs) => docs.map((d, i) => ({ index: i, relevance_score: i === 1 ? 0.99 : 0.01 }))
const engine = createEngine({ storePath, rerankFn })

section('rerank')

await checkAsync('两条候选写入', async () => {
  await engine.handle('remember', { content: '窗台上的猫在睡觉', keys: ['窗台'], tags: ['事件'] })
  await engine.handle('remember', { content: '窗台边的猫粮吃完了', keys: ['窗台'], tags: ['事件'] })
})

await checkAsync('精排把 #2 排到第一', async () => {
  const res = await engine.handle('recall', { query: '窗台上的猫', limit: 5 })
  assert.ok(res.items.length >= 2, 'expected two candidates')
  assert.equal(res.items[0].id, 2, `first id = ${res.items[0].id}`)
})

await checkAsync('rerank 抛错时回退 RRF 顺序（不崩）', async () => {
  const broken = createEngine({
    storePath: path.join(dir, 'm2', 'memory.json'),
    rerankFn: async () => { throw new Error('boom') },
  })
  await broken.handle('remember', { content: '窗台上的猫在睡觉', keys: ['窗台'], tags: ['事件'] })
  const res = await broken.handle('recall', { query: '窗台上的猫', limit: 5 })
  assert.equal(res.ok, true)
  assert.equal(res.items.length, 1)
})

fs.rmSync(dir, { recursive: true, force: true })
summary()
