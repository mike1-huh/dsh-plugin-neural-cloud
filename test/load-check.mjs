// 云图插件加载自检（2026-11-06）
//   node dsh-plugin-neural-cloud/test/load-check.mjs
// 只做"能不能被加载、工具能不能注册"的检查，不触发网络。
import { apply, name } from '../lib/index.js'

const tools = []
const hooks = []
const routes = []
const ctx = {
  tools: { register: (t) => tools.push(t) },
  on: (ev, fn) => { hooks.push({ ev, fn }); return () => {} },
  inject: (deps, fn) => { try { fn({ systemPrompt: {}, webServer: null, agents: null, configEditor: null }) } catch {} },
  effect: (fn) => { try { fn() } catch {} },
}

let bad = 0
try {
  apply(ctx, { injectLimit: 6, defaultLimit: 8 })
} catch (e) {
  console.error('❌ apply 抛错：', e?.message || e)
  bad++
}

console.log('插件名:', name)
console.log('工具:', tools.map((t) => t.name).join(', ') || '(无)')
console.log('钩子:', [...new Set(hooks.map((h) => h.ev))].join(', ') || '(无)')

for (const t of tools) {
  if (!t.name) { console.error('❌ 工具有空名'); bad++ }
  if (typeof t.execute !== 'function') { console.error('❌ 工具缺少 execute:', t.name); bad++ }
}

const want = ['memory_remember', 'memory_recall', 'memory_feedback', 'memory_forget', 'memory_status']
for (const w of want) {
  if (!tools.some((t) => t.name === w)) { console.error('❌ 缺工具', w); bad++ }
}

setTimeout(() => {
  console.log(bad === 0 ? '✅ 加载自检通过' : `❌ ${bad} 项不合格`)
  process.exit(bad === 0 ? 0 : 1)
}, 800)
