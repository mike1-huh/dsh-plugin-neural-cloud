import { loadPersona, personaBlock } from '../lib/persona.js'
import { createEngine } from '../lib/engine.js'
import os from 'node:os'
import path from 'node:path'

const dir = path.join(os.homedir(), '.dsh', 'storages', 'neural-cloud')
const persona = loadPersona(path.join(dir, 'persona.json'))
const engine = createEngine({ storePath: path.join(dir, 'memory.json') })

// 模拟 systemPrompt.section 的 text(request)：先人设，再按当前这句话召回
const userText = '云图是给谁用的？'
const personaText = personaBlock(persona)
const res = await engine.recall(userText, { limit: 6 })
const memoryText = res.hits.length
  ? ['【云图记忆】只能依据下面这些条目回答，没有依据就说记不清：',
     ...res.hits.map(h => `- ${h.record.eventTime || ''}${h.record.content}`)].join('\n')
  : ''
const injected = [personaText, memoryText].filter(Boolean).join('\n\n')

console.log(injected)
console.log('\n--- 统计 ---')
console.log('persona 块:', personaText.length, '字符')
console.log('memory 块:', memoryText.length, '字符')
console.log('合计:', injected.length, '字符')
