// 人设块断言：进提示词的内容完整、长度合理、缺省为空
import { loadPersona, personaBlock } from '../lib/persona.js'
import { check, summary, section, assert } from './_harness.mjs'
import os from 'node:os'
import path from 'node:path'

const p = path.join(os.homedir(), '.dsh', 'storages', 'neural-cloud', 'persona.json')
const block = personaBlock(loadPersona(p))

section('persona')

check('人设块非空且带【人设】头', () => {
  assert.ok(block.length > 0, 'persona.json 为空？')
  assert.ok(block.startsWith('【人设】'))
})

check('关键键进入提示词', () => {
  for (const k of ['你是「', '自称「', '叫对方「', '性格：', '底线：', '不要：']) {
    assert.ok(block.includes(k), `missing ${k}`)
  }
})

check('长度在合理区间（300–3000 字符）', () => {
  assert.ok(block.length >= 300, `too short: ${block.length}`)
  assert.ok(block.length <= 3000, `too long: ${block.length}`)
})

check('缺省 persona 返回空串', () => {
  assert.equal(personaBlock(null), '')
})

summary()
