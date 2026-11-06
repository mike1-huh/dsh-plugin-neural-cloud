/**
 * Fix session-log messages that have no `role`.
 *
 * Symptom (provider / host error):
 *   Failed to deserialize the JSON body into the target type:
 *   messages[1110]: missing field `role` at line 1 column 2535179
 *   (INVALID_REQUEST)
 *
 * Cause: the old proactive-injection path called
 *   agent.followup({ content, source })
 * without `role`, so the host persisted a user message shaped {content, source}.
 * Every later request rebuilds `messages` from the log and ships one entry with no
 * role -> serde rejects the whole turn.
 *
 * This script: multi-frame zstd -> one JSON per line -> add role (and id) where missing
 * -> recompress line by line. Backs up to .bak-<ts> first; skips files written in the
 * last 10 minutes (a live session holds them).
 *
 * Usage:
 *   node scripts/repair-session-role.mjs --dry
 *   node scripts/repair-session-role.mjs
 *   node scripts/repair-session-role.mjs <session-file>
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SKIP_MS = 10 * 60 * 1000
/** Multi-frame zstd -> text (each frame was compressed on its own; concat = original). */
function decodeAll(buf) {
  const offs = []
  let i = 0
  for (;;) {
    const k = buf.indexOf(MAGIC, i)
    if (k < 0) break
    offs.push(k)
    i = k + 4
  }
  const parts = []
  for (let n = 0; n < offs.length; n++) {
    const s = offs[n]
    const e = n + 1 < offs.length ? offs[n + 1] : buf.length
    parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'))
  }
  return parts.join('')
}

/** One frame per line, matching the host's write pattern. */
function encodeLines(text) {
  const lines = text.split('\n')
  return Buffer.concat(
    lines.map((line, idx) =>
      zlib.zstdCompressSync(Buffer.from(idx === lines.length - 1 ? line : line + '\n', 'utf8'))),
  )
}
/** Patch missing role on message records; returns text + count. */
function patchText(text) {
  const lines = text.split('\n')
  let fixed = 0
  const touched = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim()) continue
    let rec
    try { rec = JSON.parse(raw) } catch { continue }
    if (!rec || !rec.data) continue
    // user/message keeps the message body in data; other kinds keep it in data.message
    const box = rec.type === 'user/message' ? rec.data : rec.data.message
    if (!box || typeof box !== 'object' || Array.isArray(box)) continue
    if (!('content' in box) && !('toolCallId' in box)) continue
    if (typeof box.role === 'string' && box.role) continue
    box.role = rec.type === 'tool/result' ? 'tool' : 'user'
    if (!box.id) box.id = randomUUID()
    lines[i] = JSON.stringify(rec)
    fixed++
    touched.push({ line: i + 1, type: rec.type, seq: rec.seq })
  }
  return { text: lines.join('\n'), fixed, touched }
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, out)
    else if (ent.name.endsWith('.jsonl.zstd')) out.push(full)
  }
  return out
}
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const only = args.find((a) => !a.startsWith('--'))
const root = path.join(os.homedir(), '.dsh', 'sessions')
const files = only ? [only] : (fs.existsSync(root) ? walk(root) : [])

let total = 0
for (const f of files) {
  const st = fs.statSync(f)
  if (!only && Date.now() - st.mtimeMs < SKIP_MS) {
    console.log('skip (live)  ' + f)
    continue
  }
  let text
  try {
    text = decodeAll(fs.readFileSync(f))
  } catch (e) {
    console.log('unreadable   ' + f + ': ' + e.message)
    continue
  }
  const { text: out, fixed, touched } = patchText(text)
  if (!fixed) continue
  total += fixed
  console.log((dry ? 'would fix  ' : 'fix  ') + f + '  ->  ' + fixed + ' record(s)  ' + JSON.stringify(touched.slice(0, 5)))
  if (dry) continue
  fs.copyFileSync(f, f + '.bak-' + Date.now())
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, encodeLines(out))
  fs.renameSync(tmp, f)
}
console.log('\n' + (dry ? '[dry-run] ' : '') + 'total records patched: ' + total)
