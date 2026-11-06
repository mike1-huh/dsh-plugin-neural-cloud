// 验证：插件能否用 java 直接拉起引擎（2026-11-06）
//   node dsh-plugin-neural-cloud/test/spawn-check.mjs
import { apply } from '../lib/index.js'

const tools = []
const ctx = {
  tools: { register: (t) => tools.push(t) },
  on: () => () => {},
  inject: () => {},
  effect: () => {},
}

apply(ctx, { session: 'dsh' })

async function status() {
  const res = await fetch('http://127.0.0.1:8787/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'dsh' }),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try {
    const j = await status()
    console.log('✅ 引擎已就绪：', JSON.stringify(j))
    process.exit(0)
  } catch {}
}

console.log('❌ 15 秒内没起来，看 ~/.dsh/storages/neural-cloud/inject.log 的 [engine] 行')
process.exit(1)
