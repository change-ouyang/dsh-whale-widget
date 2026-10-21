// 只读查看单个会话日志:记录类型分布 + 带 usage 的样本 + 首尾记录。
// 排查「某个字段到底长什么样」时用。
//
// 用法:node tools/inspect-session.mjs <session.v4.jsonl.zstd>

import { readSessionJsonl } from '../lib/usage-stats.mjs'

const file = process.argv[2]
if (!file) {
  console.error('用法: node tools/inspect-session.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}

let lines
try {
  lines = readSessionJsonl(file)
} catch (error) {
  console.error(`读不了这个文件: ${error.message}`)
  process.exit(1)
}

console.log('lines:', lines.length)

const kinds = new Map()
const usageSamples = []
for (const line of lines) {
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  const type = rec.type ?? rec.kind ?? Object.keys(rec).join(',')
  kinds.set(type, (kinds.get(type) ?? 0) + 1)
  if (usageSamples.length < 3 && /token|usage/i.test(line)) usageSamples.push(rec)
}

console.log('types:', [...kinds.entries()].slice(0, 40))

console.log('\n--- 带 token/usage 的样本 ---')
for (const r of usageSamples) {
  console.log(JSON.stringify(r).slice(0, 1200))
  console.log('---')
}
if (usageSamples.length === 0) console.log('(没有)')

console.log('\n--- 第一条 ---')
console.log(lines[0]?.slice(0, 600))
console.log('\n--- 最后一条 ---')
console.log(lines[lines.length - 1]?.slice(0, 600))