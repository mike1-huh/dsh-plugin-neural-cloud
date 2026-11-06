// 自测：模拟宿主（tools + systemPrompt），验证「注入」这条链路
// 不依赖 DSH 重启，纯进程内跑
import { apply } from '../lib/index.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'ncm-inject-'))
const storePath = join(tmpDir, 'memory.json')

// --- 假宿主 ---
const tools = []
let sectionOpts = null
const ctx = {
  tools: { register: (def) => tools.push(def) },
  systemPrompt: {
    section: (opts) => { sectionOpts = opts },
  },
}

apply(ctx, { storePath, maxRecords: 100, defaultLimit: 8, injectLimit: 4 })

console.log('注册工具:', tools.map(t => t.name).join(', '))
console.log('注入是否注册:', !!sectionOpts, sectionOpts ? `order=${sectionOpts.order} name=${sectionOpts.name}` : '')

// --- 写几条记忆 ---
const remember = tools.find(t => t.name === 'memory_remember')
async function write(content, keys, extra = {}) {
  return remember.execute({ content, keys, tier: 'B', ...extra })
}
await write('10-22 上午，星野在校门口等老师，嘴上说只等三分钟，实际站了半小时。',
  ['校门口', '等'], { entities: ['校门口', '老师'], eventTime: '10-22', scene: '校门口' })
await write('10-22 中午，两人在拉面店，她主动要了加面，说这顿算她请。',
  ['拉面店', '加面'], { entities: ['拉面店'], eventTime: '10-22', scene: '拉面店' })
await write('10-22 下午，她说下次想去看海，但要老师负责拍照。',
  ['看海', '拍照'], { entities: ['海边'], eventTime: '10-22', planState: 'pending' })

// --- 各种 request 形态都要能抠出 query ---
const shapes = [
  { name: '字符串', req: '她等我的那次是哪天' },
  { name: 'query 字段', req: { query: '拉面店那顿谁请的' } },
  { name: 'messages 数组', req: { messages: [{ role: 'assistant', content: '嗯' }, { role: 'user', content: '看海那次说要拍照' }] } },
  { name: '空请求', req: {} },
]

for (const { name, req } of shapes) {
  try {
    const out = await sectionOpts.text(req)
    const first = out ? out.split('\n').slice(0, 2).join(' / ') : '(空 —— 不注入)'
    console.log(`\n[${name}] 长度=${out.length}`)
    console.log('  ', first.slice(0, 110))
  } catch (e) {
    console.log(`\n[${name}] 抛错:`, e.message)
  }
}

// --- store 不存在时不能崩 ---
fs.rmSync(storePath, { force: true })
try {
  const out = await sectionOpts.text({ query: '随便什么' })
  console.log('\n[库不存在] 返回长度:', out.length, '（应为 0，不抛错）')
} catch (e) {
  console.log('\n[库不存在] 抛错（这就不对了）:', e.message)
}

// --- 没有 systemPrompt 的宿主也不能崩 ---
try {
  apply({ tools: { register: () => {} } }, { storePath })
  console.log('[无 systemPrompt 的宿主] 装载正常（只装工具）')
} catch (e) {
  console.log('[无 systemPrompt 的宿主] 抛错（这就不对了）:', e.message)
}

fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('\n自测完成，临时目录已清理。')
