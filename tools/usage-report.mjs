// 全量用量报表:按 model / 按天(本地时区与 UTC 各一份)聚合 $DSH_HOME/sessions。
//
// 用法:
//   node tools/usage-report.mjs                 # 用 $DSH_HOME 或 ~/.dsh
//   DSH_HOME=/path/to/fakehome node tools/usage-report.mjs
//   node tools/usage-report.mjs --days 30       # 多列几天
//
// 切帧走 lib/usage-stats.mjs 的 forEachFrameText —— 与插件统计的是同一份逻辑。

import { readSessionJsonl, localDayKey, walkLogs } from '../lib/usage-stats.mjs'
import { dshHome, sessionsRoot, tildify } from './dsh-home.mjs'

const argv = process.argv.slice(2)
const daysIdx = argv.indexOf('--days')
const daysShown = daysIdx !== -1 ? Number(argv[daysIdx + 1]) || 10 : 10

const ZERO = () => ({ req: 0, input: 0, output: 0, cacheRead: 0, total: 0 })
const add = (a, u) => {
  a.req++
  a.input += u.inputTokens ?? 0
  a.output += u.outputTokens ?? 0
  a.cacheRead += u.cacheReadTokens ?? 0
  a.total += u.totalTokens ?? 0
}
/** 取 map[key] 的桶(没有就建),再累加一次用量。 */
const bump = (map, key, u) => {
  let bucket = map.get(key)
  if (!bucket) { bucket = ZERO(); map.set(key, bucket) }
  add(bucket, u)
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10)

const files = walkLogs(sessionsRoot(), [])
const usageByType = new Map()
const byDayLocal = new Map()
const byDayUtc = new Map()
const byModel = new Map()
const allTime = ZERO()
let parsed = 0
let failed = 0

for (const file of files) {
  let lines
  try { lines = readSessionJsonl(file) } catch { failed++; continue }
  parsed++
  for (const line of lines) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    const u = rec?.data?.usage ?? rec?.usage
    if (!u || typeof u !== 'object') continue
    if (!(u.totalTokens || u.inputTokens || u.outputTokens)) continue
    usageByType.set(rec.type, (usageByType.get(rec.type) ?? 0) + 1)
    if (rec.type !== 'assistant/message') continue // 只算真正的助手回合
    const t = rec.time ?? rec.data?.message?.time ?? null
    const model = rec.data?.message?.source?.model ?? 'unknown'
    bump(byModel, model, u)
    if (typeof t === 'number') {
      bump(byDayLocal, localDayKey(t), u)
      bump(byDayUtc, utcDay(t), u)
    }
    add(allTime, u)
  }
}

const f = (n) => n.toLocaleString('en-US')
const show = (label, v) =>
  `${label}: req=${v.req}  in=${f(v.input)}  out=${f(v.output)}  cacheRead=${f(v.cacheRead)}  total=${f(v.total)} (${(v.total / 1e6).toFixed(2)}M)`

console.log(`DSH_HOME : ${tildify(dshHome())}`)
console.log(`sessions : ${tildify(sessionsRoot())}`)
console.log(`files: ${files.length}  parsed: ${parsed}  failed: ${failed}`)

console.log('\n== 带 usage 的记录类型 ==')
console.log([...usageByType.entries()].map(([k, n]) => `  ${k}: ${n}`).join('\n') || '  (无)')

console.log('\n== 全部时间 ==')
console.log(`  ${show('ALL', allTime)}`)

console.log('\n== 按 model ==')
for (const [m, v] of [...byModel.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${show(m, v)}`)
}

const desc = (map) => [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, daysShown)
console.log(`\n== 按天(本地时区,最近 ${daysShown} 天)==`)
for (const [d, v] of desc(byDayLocal)) console.log(`  ${show(d, v)}`)

console.log(`\n== 按天(UTC,最近 ${daysShown} 天)==`)
for (const [d, v] of desc(byDayUtc)) console.log(`  ${show(d, v)}`)