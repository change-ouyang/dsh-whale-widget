// 把「今天」的用量按 provider 与 provider/model 分组,用来核对卡片上的汇总数。
//
// 用法:node tools/today-by-provider.mjs   （DSH_HOME 可覆盖）

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
const byProvider = new Map()
const byProviderModel = new Map()

for (const file of walkLogs(sessionsRoot(), [])) {
  let lines
  try { lines = readSessionJsonl(file) } catch { continue }
  for (const line of lines) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type !== 'assistant/message') continue
    const u = rec?.data?.usage
    const t = rec.time
    if (!u || typeof t !== 'number' || localDayKey(t) !== TODAY) continue
    const src = rec.data?.message?.source ?? {}
    const p = src.provider ?? 'unknown'
    bump(byProvider, p, u)
    bump(byProviderModel, p + ' / ' + (src.model ?? 'unknown'), u)
  }
}

const f = (n) => n.toLocaleString('en-US')
const row = (k, v) =>
  `  ${k.padEnd(42)} req=${String(v.req).padStart(4)}  in=${f(v.input).padStart(10)}  out=${f(v.output).padStart(8)}  cacheRead=${f(v.cacheRead).padStart(11)}  total=${(v.total / 1e6).toFixed(2)}M  in+out=${((v.input + v.output) / 1e6).toFixed(2)}M`

console.log(`DSH_HOME = ${tildify(dshHome())}`)
console.log(`TODAY = ${TODAY}`)

console.log('\n== 按 provider ==')
for (const [k, v] of [...byProvider.entries()].sort((a, b) => b[1].total - a[1].total)) console.log(row(k, v))

console.log('\n== 按 provider / model ==')
for (const [k, v] of [...byProviderModel.entries()].sort((a, b) => b[1].total - a[1].total)) console.log(row(k, v))