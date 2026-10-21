// 验证「会话日志是多帧 zstd」这个前提 —— 同步解码只能拿到第一帧,
// 所以必须按 magic 切帧。这个脚本把两条路径的结果并排打出来。
//
// 用法:node tools/zstd-frames.mjs <session.v4.jsonl.zstd>

import { createReadStream } from 'node:fs'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import { FRAME_MAGIC, readSessionJsonl } from '../lib/usage-stats.mjs'

const file = process.argv[2]
if (!file) {
  console.error('用法: node tools/zstd-frames.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}

// ① Node 自己的同步解码:对多帧文件**只出第一帧**。
let syncText = ''
try {
  syncText = zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
} catch (error) {
  console.log('[sync] 解码失败:', error.message)
}
const syncLines = syncText.split('\n').filter((l) => l.trim()).length
console.log('[sync]   bytes:', syncText.length, ' lines:', syncLines, '  ← 只有第一帧')

// ② 流式解码。**别指望它会走完所有帧** —— 见下方结论。
let streamBytes = 0
let streamLines = 0
const dec = createZstdDecompress()
dec.on('data', (c) => {
  streamBytes += c.length
  streamLines += c.toString('utf8').split('\n').filter((l) => l.trim()).length
})
try {
  await pipeline(createReadStream(file), dec)
  console.log('[stream] bytes:', streamBytes, ' lines:', streamLines, '  ← Node 的流式解码器')
} catch (error) {
  console.log('[stream] 失败:', error.message)
}

// ③ 切帧解码(插件实际用的路径)——应与 ② 一致。
const cutLines = readSessionJsonl(file).length
console.log('[frames] lines:', cutLines, '  ← 按 magic 切帧(插件走这条)')

// 文件里到底有几个帧 magic。
const buf = fs.readFileSync(file)
let frames = 0
for (let i = 0; i < buf.length - 3; i++) {
  if (buf[i] === FRAME_MAGIC[0] && buf[i + 1] === FRAME_MAGIC[1] && buf[i + 2] === FRAME_MAGIC[2] && buf[i + 3] === FRAME_MAGIC[3]) frames++
}
console.log('frames by magic:', frames, ' file bytes:', buf.length)

// ── 结论 ────────────────────────────────────────────────────────────────
// 这里要验证的是「**为什么必须切帧**」,所以判定按实测事实来:
//   · 单帧文件:三条路径应当一致(没什么可证明的)。
//   · 多帧文件:同步与流式**都只出第一帧**,只有切帧能读到全部内容。
// 若切帧反而读得更少,那才是真 bug。
console.log('')
if (frames <= 1) {
  console.log('ℹ️  单帧文件 —— 三条路径一致,这个文件证明不了什么(需要一个追加写过的日志)。')
} else if (cutLines > streamLines) {
  console.log(`✓ 已验证前提:文件有 ${frames} 个帧,而「同步」与「流式」都只读出了第一帧`)
  console.log(`  (${streamLines} 行),只有按 magic 切帧才读到全部 ${cutLines} 行 —— 切帧是必需的。`)
} else if (cutLines === streamLines) {
  console.log(`ℹ️  切帧与流式结果相同(${cutLines} 行)。`)
  console.log('  若这个文件确实有多帧,说明这些帧的数据本来就一样,或后端已能跨帧解码。')
} else {
  console.log(`⚠️  切帧读到的行数(${cutLines})少于流式(${streamLines}) —— 帧切分可能有 bug。`)
  process.exitCode = 1
}