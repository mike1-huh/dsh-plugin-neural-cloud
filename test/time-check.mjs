// 时间显示自检（2026-11-06）：确认只用真实时间
//   node dsh-plugin-neural-cloud/test/time-check.mjs
import { stampFor, periodOf, relativeOf } from '../lib/engine.js'

const now = Date.now()
const day = 86400000

const cases = [
  { label: '今天写的、事件是明天', rec: { created: now, eventTime: '2026-11-07', content: '明天去医院' } },
  { label: '昨天写的', rec: { created: now - day, content: '昨天的事' } },
  { label: '三天前', rec: { created: now - 3 * day, content: '三天前的事' } },
  { label: '带世界时间（应忽略）', rec: { created: now, worldTime: '2030-01-01T09:00:00Z', content: '虚拟时间' } },
]

let bad = 0
for (const c of cases) {
  const s = stampFor(c.rec)
  console.log(`${c.label.padEnd(22, '　')} → ${s}`)
  // 关键：虚拟时间/事件时间都不能改变"相对量词"
  if (c.rec.worldTime && !s.includes('今天')) {
    console.error('  ❌ worldTime 影响了时间戳')
    bad++
  }
  if (c.rec.eventTime && !s.includes('今天')) {
    console.error('  ❌ eventTime 顶替了时间戳')
    bad++
  }
}

console.log('\n时段:', periodOf(new Date(now)), '｜ 相对:', relativeOf(now), relativeOf(now - day))
console.log(bad === 0 ? '✅ 只用真实时间' : `❌ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
