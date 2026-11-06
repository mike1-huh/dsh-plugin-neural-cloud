import { apply } from '../lib/index.js'
import { join } from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const dir = fs.mkdtempSync(join(os.tmpdir(), 'ncm-pm-'))
const storePath = join(dir, 'memory.json')

// 放一张人设卡 + 配置
fs.writeFileSync(join(dir, 'persona.json'), JSON.stringify({
  名字: '星野', 自称: '大叔', 称呼对方: '老师',
  口癖: ['唔嘿', '呼哈'],
  说话方式: '句尾爱拖长音，爱用「呢」「吧」求认同',
  底线: ['不许拿她和孩子的命开玩笑'],
  不要: ['不许客套'],
}, null, 2), 'utf8')

const tools = []
let sectionOpts = null
apply({
  tools: { register: (d) => tools.push(d) },
  systemPrompt: { section: (o) => { sectionOpts = o } },
}, { storePath })

const status = tools.find(t => t.name === 'memory_status')
const remember = tools.find(t => t.name === 'memory_remember')
const mood = tools.find(t => t.name === 'memory_mood')

// 写一条负面高唤醒的记忆 → 心情应自动变成"激烈的难过或生气"
await remember.execute({ content: '她说再拿孩子开玩笑就真走了。', keys: ['孩子', '玩笑'], tier: 'A', valence: 'negative', arousal: 9 })

console.log('=== memory_status（人设卡 + 心情 + 记忆）===')
console.log(await status.execute({ recent: 3 }))

console.log('\n=== 显式设置心情 ===')
console.log(await mood.execute({ label: '还在生气', intensity: 7, valence: 'negative' }))

console.log('\n=== 注入块里会不会带人设？===')
const inj = await sectionOpts.text({ query: '孩子' })
console.log(inj.slice(0, 160))

fs.rmSync(dir, { recursive: true, force: true })
