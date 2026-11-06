/**
 * 集成自检：用 mock ctx 跑一遍 apply，验证注册面与关键路径。
 * 只做静态可验证的部分（不连真实宿主）。
 */
import { apply, name, inject } from '../lib/index.js'

const tools = []
const events = []
const sections = []
const disposers = []

const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: { register: (t) => { tools.push(t); return () => {} } },
  on: (event, handler) => { events.push({ event, handler }); return () => {} },
  inject: (deps, cb) => {
    // 模拟：只提供 systemPrompt 这一个可选服务，其余回调不执行
    if (Array.isArray(deps) && deps.includes('systemPrompt')) {
      cb({ systemPrompt: { section: (s) => { sections.push(s); return () => {} } } })
    }
  },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  get: () => undefined,
}

apply(ctx, {})

const checks = []
const ok = (label, cond, detail) => checks.push({ label, pass: Boolean(cond), detail })

ok('name 导出', name === 'neural-cloud', String(name))
ok('inject 声明 tools', Array.isArray(inject) && inject.includes('tools'), JSON.stringify(inject))

const toolNames = tools.map(t => t && t.name).filter(Boolean)
const expected = ['memory_remember', 'memory_recall', 'memory_feedback', 'memory_forget', 'memory_mood', 'memory_config', 'memory_status', 'im_qq_send', 'memory_hindsight_write']
ok('工具数量 = 9', toolNames.length === 9, toolNames.join(','))
for (const n of expected) ok(`工具存在: ${n}`, toolNames.includes(n))

for (const t of tools) {
  if (!t || !t.name) continue
  ok(`工具 ${t.name} 有 execute`, typeof t.execute === 'function')
  ok(`工具 ${t.name} 有 schema`, t.parameters && t.parameters.type === 'object', JSON.stringify(t.parameters && t.parameters.type))
  if (t.parameters && t.parameters.required) {
    ok(`工具 ${t.name} required 是数组`, Array.isArray(t.parameters.required), typeof t.parameters.required)
  }
}

const eventNames = events.map(e => e.event)
ok('注册了 assemble 钩子', eventNames.includes('system-prompt/assemble'), eventNames.join(','))
ok('没有注册 section（修复验证）', sections.length === 0, `sections=${sections.length}`)

for (const e of events) {
  if (e.event !== 'system-prompt/assemble') continue
  ok('assemble 处理器是函数', typeof e.handler === 'function')
}

// assemble 钩子行为：喂一个含 Promise text 的装配结果，应被归一化成字符串
const asm = events.find(e => e.event === 'system-prompt/assemble')
if (asm) {
  const badOut = {
    sections: [
      { name: 'x', order: 1, text: 'ok' },
      { name: 'y', order: 2, text: Promise.resolve('bad') },
      { name: 'z', order: 3, text: null },
    ],
  }
  const next = async () => badOut
  const result = await asm.handler({}, {}, next)
  const texts = (result && result.sections || []).map(s => typeof s.text)
  ok('assemble 归一化非字符串 text', texts.every(t => t === 'string'), texts.join(','))
  ok('assemble 保留原有字符串', texts.includes('string'))
}

const failed = checks.filter(c => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? '  → ' + c.detail : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) process.exitCode = 1
