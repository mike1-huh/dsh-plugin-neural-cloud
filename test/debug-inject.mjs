// 调试：写入是否真的进了库、recall 能不能命中
import { apply } from '../lib/index.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'ncm-dbg-'))
const storePath = join(tmpDir, 'memory.json')

const tools = []
let sectionOpts = null
apply({
  tools: { register: (d) => tools.push(d) },
  systemPrompt: { section: (o) => { sectionOpts = o } },
}, { storePath, maxRecords: 100, defaultLimit: 8, injectLimit: 4 })

const remember = tools.find(t => t.name === 'memory_remember')
const recallTool = tools.find(t => t.name === 'memory_recall')

console.log('remember 参数键:', Object.keys(remember.parameters || {}))
console.log('recall 参数键:', Object.keys(recallTool.parameters || {}))

const w = await remember.execute({ content: '星野在校门口等老师，站了半小时。', keys: ['校门口', '等'], tier: 'B' })
console.log('写入结果:', JSON.stringify(w))

console.log('库文件存在:', fs.existsSync(storePath))
if (fs.existsSync(storePath)) {
  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'))
  console.log('库里条数:', raw.records?.length, '第一条:', raw.records?.[0]?.content?.slice(0, 30))
}

const r = await recallTool.execute({ query: '校门口等我的那次' })
console.log('recall 结果:', JSON.stringify(r).slice(0, 300))

const injected = sectionOpts ? await sectionOpts.text({ query: '校门口等我的那次' }) : ''
console.log('注入文本长度:', injected.length)
console.log('注入内容:', injected.slice(0, 200))

fs.rmSync(tmpDir, { recursive: true, force: true })
