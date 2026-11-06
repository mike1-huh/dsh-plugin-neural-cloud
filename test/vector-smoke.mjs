// 向量通道（离线断言）：假 embedFn 验证 vector 通道进 RRF 与 vectors.json 缓存
import { createEngine } from '../lib/engine.js'
import { checkAsync, summary, section, assert } from './_harness.mjs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = path.join(os.homedir(), '.dsh', 'storages', 'nc-vec-test')
fs.rmSync(dir, { recursive: true, force: true })
const storePath = path.join(dir, 'memory.json')

// 假 embed：猫 → [1,0]，狗 → [0,1]，其它 → [0.7,0.7]
const embedFn = async (texts) => texts.map(t => (t.includes('猫') ? [1, 0] : t.includes('狗') ? [0, 1] : [0.7, 0.7]))
const engine = createEngine({ storePath, embedFn })

section('vector channel')

await checkAsync('写入两条记忆', async () => {
  const a = await engine.handle('remember', { content: '猫在窗台上睡觉', keys: ['窗台'], tags: ['事件'] })
  const b = await engine.handle('remember', { content: '狗在院子里追球', keys: ['院子'], tags: ['事件'] })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
})

await checkAsync('召回命中且 why 含 vector#', async () => {
  const res = await engine.handle('recall', { query: '窗台上有只猫吗', limit: 5 })
  assert.ok(res.items.length >= 1, 'expected hits')
  const hit = res.items.find(i => i.content.includes('猫'))
  assert.ok(hit, 'expected cat memory')
  // 契约里 handle('recall') 的 why 是逗号分隔字符串（工具返回的 hits 才是数组）
  assert.ok(String(hit.why).includes('vector#'), `why = ${hit.why}`)
})

await checkAsync('vectors.json 已写入', async () => {
  assert.ok(fs.existsSync(path.join(dir, 'vectors.json')), 'vectors.json missing')
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'))
  assert.ok(Object.keys(cache).length >= 1)
})

await checkAsync('无 embedFn 时静默降级（不报错、无 vector 通道）', async () => {
  const plain = createEngine({ storePath: path.join(dir, 'm2', 'memory.json') })
  await plain.handle('remember', { content: '窗台上的猫', keys: ['窗台'], tags: ['事件'] })
  const res = await plain.handle('recall', { query: '窗台上有猫吗', limit: 5 })
  assert.equal(res.ok, true)
  assert.ok(res.items.length >= 1)
  assert.ok(!res.items.some(i => String(i.why).includes('vector#')))
})

fs.rmSync(dir, { recursive: true, force: true })
summary()
