/**
 * 极简测试台：check / checkAsync 记录结果，summary 失败时置 exitCode=1。
 * 不依赖任何测试框架，node 直接跑。
 */
import assert from 'node:assert/strict'

const results = []

export function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: e })
    console.log(`  ✗ ${name}`)
    console.log(`    ${e && e.message ? e.message.split('\n')[0] : e}`)
  }
}

export async function checkAsync(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: e })
    console.log(`  ✗ ${name}`)
    console.log(`    ${e && e.message ? e.message.split('\n')[0] : e}`)
  }
}

export function summary() {
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED` : ''}`)
  if (failed.length) process.exitCode = 1
  return failed.length === 0
}

export function section(title) {
  console.log(`\n${title}`)
}

export { assert }
