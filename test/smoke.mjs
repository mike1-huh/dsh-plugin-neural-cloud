/**
 * 插件自测（不依赖 harness）：把 apply 里的 ctx.tools.register 换成收集器，
 * 直接跑 4 个工具的 execute，验证写入 / 召回 / 反馈 / 遗忘这条闭环。
 *
 * 用法：node test/smoke.mjs
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../lib/index.js'

const storePath = path.join(os.tmpdir(), `nc-smoke-${Date.now()}.json`)
const tools = new Map()
const ctx = { tools: { register: t => tools.set(t.name, t) } }

plugin.apply(ctx, { storePath })
console.log('注册工具:', [...tools.keys()].join(', '))

const call = async (name, args) => {
  const t = tools.get(name)
  if (!t) throw new Error(`工具不存在: ${name}`)
  return t.execute(args, {})
}

// ① 写入四条记忆（模拟一次对话抽出来的东西）
const write = async (a) => call('memory_remember', a)
await write({
  content: '10-18 下午，星野在婚纱店试衣间里让老师守在门口，说要第一个看到的人是他。',
  keys: ['婚纱', '试衣间', '第一个看到'],
  tier: 'A',
  event: '试婚纱',
  scene: '婚纱店',
  entities: ['婚纱店', '试衣间', '薄雾白婚纱', '老师', '星野'],
  quote: '等我出来，要第一个看到的人是你哦。',
  tags: ['事件', '约定'],
  eventTime: '2026-10-18',
})
await write({
  content: '同一天在婚纱店，星野给老师立了挑裙子的规矩：必须一眼看中，超过五分钟就罚两杯拿铁。',
  keys: ['拿铁赌约', '挑裙子', '规矩'],
  tier: 'B',
  event: '挑裙子',
  scene: '婚纱店',
  entities: ['婚纱店', '蕾丝边白色连衣裙', '拿铁'],
  quote: '到时可要罚你……请我喝两杯拿铁。',
  tags: ['事件', '约定'],
  eventTime: '2026-10-18',
})
await write({
  content: '2026-10-16 深夜，星野在被窝里戳老师腰侧逗他，被喊痒后嘴上嫌弃却更往他怀里缩。',
  keys: ['被窝', '戳腰', '取暖器'],
  tier: 'B',
  event: '睡前打闹',
  scene: '被窝',
  entities: ['被窝', '老师', '星野'],
  quote: '谁要当你的取暖器。',
  tags: ['事件', '关系'],
  eventTime: '2026-10-16',
})
await write({
  content: '她的称呼规则：只在两个人独处时叫他老师，有别人在就装不熟。',
  keys: ['称呼', '独处'],
  tier: 'S',
  entities: ['老师', '星野'],
  tags: ['设定', '称呼'],
})

// ② 召回三种问法
for (const q of ['婚纱店那次拿铁赌约是怎么回事', '谁要当你的取暖器', '她怎么称呼他']) {
  const r = await call('memory_recall', { query: q, limit: 3 })
  console.log(`\n问：${q}`)
  console.log('  ' + r.note)
  for (const h of r.hits) {
    console.log(`  #${h.record.id} [${h.record.tier}] ${h.record.content.slice(0, 28)}… 分=${h.score} 理由=${h.why.join(',')}`)
  }
}

// ③ 纯动作句：应该一条都不该被当成"实词命中"
const lift = await call('memory_recall', { query: '（抱住星野，进入梦乡）', limit: 3 })
console.log(`\n纯动作句命中 ${lift.hits.length} 条（预期很少或 0）`)

// ④ 反馈与遗忘
console.log('\n反馈:', await call('memory_feedback', { ids: [1], signal: 'hit' }))
console.log('纠错:', await call('memory_feedback', { ids: [3], signal: 'wrong', note: '她说记错了' }))
console.log('软删:', await call('memory_forget', { ids: [2], reason: '用户要求' }))
const after = await call('memory_recall', { query: '拿铁赌约', limit: 3 })
console.log('软删后还能否取到 #2：', after.hits.some(h => h.record.id === 2) ? '能（说明归档≠删除，符合设计）' : '不能')

await fs.unlink(storePath).catch(() => {})
console.log('\n冒烟测试完成，临时库已清理。')
