// 一键跑全部离线测试；任一失败 → 进程退出码 1
// 用法：node test/run-all.mjs  （或 pnpm test）
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = [
  'panel-smoke.mjs',
  'vector-smoke.mjs',
  'rerank-smoke.mjs',
  'persona-block.mjs',
]

let failed = 0
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  // stdio: inherit —— 沙箱下 pipe 捕获会 EPERM
  const r = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}

if (failed) {
  console.error(`\n${failed} suite(s) FAILED`)
  process.exit(1)
}
console.log('\nALL SUITES PASSED')
