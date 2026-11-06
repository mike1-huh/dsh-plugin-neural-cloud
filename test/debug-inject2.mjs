import { apply } from '../lib/index.js'
import { join } from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'ncm-dbg2-'))
const storePath = join(tmpDir, 'memory.json')

const tools = []
let sectionOpts = null
apply({ tools: { register: (d) => tools.push(d) }, systemPrompt: { section: (o) => { sectionOpts = o } } },
  { storePath, maxRecords: 100, defaultLimit: 8, injectLimit: 4 })

const remember = tools.find(t => t.name === 'memory_remember')
await remember.execute({ content: '星野在校门口等老师。', keys: ['校门口', '等'], tier: 'B' })

const out = await sectionOpts.text({ query: '校门口等我的那次' })
console.log('注入长度:', out.length)
console.log('注入内容:', out)

const logPath = join(tmpDir, 'inject.log')
if (fs.existsSync(logPath)) {
  console.log('--- inject.log ---')
  console.log(fs.readFileSync(logPath, 'utf8'))
} else {
  console.log('（没有 inject.log，说明没走到 catch）')
}

fs.rmSync(tmpDir, { recursive: true, force: true })
