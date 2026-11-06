const fs = require('fs')
const p = 'lib/index.js'
let s = fs.readFileSync(p, 'utf8')
const oldCall = "      await agent.followup({ content: [{ type: 'text', text }], source: { kind: 'neural-cloud' } })"
if (!s.includes(oldCall)) { console.error('call site not found'); process.exit(1) }
const newCall = [
  "      // followup 的消息对象会原样落进会话日志；缺 role 时宿主序列化出的 messages[n] 只剩",
  "      // {content, source}，提供方 serde 报 missing field `role`，整轮 INVALID_REQUEST。",
  "      const message = {",
  "        role: 'user',",
  "        id: randomUUID(),",
  "        content: [{ type: 'text', text }],",
  "        source: { kind: 'neural-cloud' },",
  "      }",
  "      await agent.followup(message)",
].join('\n')
s = s.replace(oldCall, newCall)
if (!s.includes("import { randomUUID } from 'node:crypto'")) {
  s = s.replace("import os from 'node:os'", "import os from 'node:os'\nimport { randomUUID } from 'node:crypto'")
}
fs.writeFileSync(p, s)
console.log('patched ok')
