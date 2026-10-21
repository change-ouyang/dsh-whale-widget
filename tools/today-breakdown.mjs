// 把「今天」的用量拆到工作区 / 主-子代理 / 小时,用来跟小鲸鱼面板上的数字对账。
//
// 用法:node tools/today-breakdown.mjs   （DSH_HOME 可覆盖）

import { readSessionJsonl, localDayKey, walkLogs } from '../lib/usage-stats.mjs'
import { dshHome, sessionsRoot, tildify } from './dsh-home.mjs'

const ZERO = () => ({ req: 0, input: 0, output: 0, cacheRead: 0, total: 0 })
const add = (a, u) => {
  a.req++
  a.input += u.inputTokens ?? 0
  a.output += u.outputTokens ?? 0
  a.cacheRead += u.cacheReadTokens ?? 0
  a.total += u.totalTokens ?? 0
}
const bump = (map, key, u) => {
  let bucket = map.get(key)
  if (!bucket) { bucket = ZERO(); map.set(key, bucket) }
  add(bucket, u)
}

const TODAY = localDayKey(Date.now())
const byCwd = new Map()
const byScope = new Map()
const byHour = new Map()
const totals = ZERO()
let sessionsToday = 0

for (const file of walkLogs(sessionsRoot(), [])) {
  let lines
  try { lines = readSessionJsonl(file) } catch { continue }
  let meta = null
  let producedToday = false
  for (const line of lines) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type === 'session') { meta = rec; continue }
    const u = rec?.data?.usage
    if (rec.type !== 'assistant/message' || !u) continue
    const t = rec.time
    if (typeof t !== 'number' || localDayKey(t) !== TODAY) continue
    producedToday = true
    add(totals, u)
    bump(byCwd, meta?.cwd ?? '(unknown)', u)
    bump(byScope, (meta?.delegationDepth ?? 0) > 0 ? 'subagent' : 'main', u)
    bump(byHour, String(new Date(t).getHours()).padStart(2, '0'), u)
  }
  if (producedToday) sessionsToday++
}

const f = (n) => n.toLocaleString('en-US')
const row = (k, v) =>
  `  ${k.padEnd(34)} req=${String(v.req).padStart(4)}  in=${f(v.input).padStart(11)}  out=${f(v.output).padStart(8)}  cacheRead=${f(v.cacheRead).padStart(11)}  total=${(v.total / 1e6).toFixed(2)}M`
const noCache = (v) => `in+out=${((v.input + v.output) / 1e6).toFixed(2)}M`

console.log(`DSH_HOME = ${tildify(dshHome())}`)
console.log(`TODAY = ${TODAY}   今天有用量的会话: ${sessionsToday}`)
console.log(row('TOTAL', totals), `| ${noCache(totals)}`)

console.log('\n== 按主/子代理 ==')
for (const [k, v] of byScope) console.log(row(k, v), `| ${noCache(v)}`)

console.log('\n== 按工作区 ==')
for (const [k, v] of [...byCwd.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(row(tildify(k), v), `| ${noCache(v)}`)
}

console.log('\n== 按小时(本地)==')
for (const [k, v] of [...byHour.entries()].sort()) console.log(row(k + ':00', v))