// 生成一个**合成的**假 DSH_HOME,用来验证用量统计 —— 不含任何真实会话数据。
//
// 存在的理由:会话日志里有真实对话内容与工作区路径,不能作为测试夹具随仓库分发。
// 这个脚本按需生成等价结构(含追加写的**多帧** zstd,这是最容易写错的地方),
// 于是任何人都能复现统计结果,而不必把自己的日志交出去。
//
// 用法:
//   node tools/make-fixture.mjs /tmp/fakehome
//   DSH_HOME=/tmp/fakehome node tools/today-breakdown.mjs
//
// 作为模块:
//   import { makeFixture } from './make-fixture.mjs'
//   const { home, expected } = makeFixture('/tmp/fakehome')

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

/**
 * 今天的某个钟点(本地时间)。dayOffset=-1 表示昨天。
 *
 * 只按**日期**比较,不看「是否已到那个点」,所以不管什么时候跑,
 * 结果都一样 —— 凌晨跑测试也不会红。
 */
export function atLocalHour(hour, minute = 0, dayOffset = 0, from = Date.now()) {
  const d = new Date(from)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

const usage = (inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
})

/**
 * 写一个追加写的多帧 zstd 会话日志。
 *
 * ⚠️ 这里必须写成**多个拼接的 zstd 帧**,而不是一个流 —— 只有这样才能
 * 复现 `zstdDecompressSync` 只解第一帧的行为,进而验证 `forEachFrameText`
 * 真的在按 magic 切帧。如果夹具只有一帧,这个 bug 就测不出来。
 */
function writeFrames(file, chunks) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const frames = chunks.map((lines) =>
    zlib.zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')),
  )
  fs.writeFileSync(file, Buffer.concat(frames))
}

/**
 * 在 home 下生成 fixture,返回期望值(测试直接拿它断言)。
 */
export function makeFixture(home, options = {}) {
  const now = options.now ?? Date.now()
  const sessions = path.join(home, 'sessions')

  // ── 会话 A:主代理,工作区 alpha,今天两条 ──────────────────────────
  const alphaSession = {
    type: 'session',
    id: '00000000-0000-4000-8000-000000000001',
    cwd: '/fake/workspace-alpha',
    delegationDepth: 0,
  }
  const alphaMsgs = [
    {
      type: 'assistant/message',
      time: atLocalHour(9, 30, 0, now),
      data: { usage: usage(1000, 200, 500, 50), message: { source: { provider: 'fake-provider-a', model: 'fake-model-1' } } },
    },
    // 干扰项:没有 usage 的记录不该被计数
    { type: 'user/message', time: atLocalHour(9, 29, 0, now), data: { text: 'fake question' } },
    { type: 'tool/call', time: atLocalHour(9, 31, 0, now), data: { name: 'fake-tool' } },
    {
      type: 'assistant/message',
      time: atLocalHour(14, 0, 0, now),
      data: { usage: usage(2000, 400, 1000, 100), message: { source: { provider: 'fake-provider-a', model: 'fake-model-1' } } },
    },
  ]

  // ── 会话 B:子代理,工作区 beta,今天一条 + 昨天一条 ────────────────
  const betaSession = {
    type: 'session',
    id: '00000000-0000-4000-8000-000000000002',
    cwd: '/fake/workspace-beta',
    delegationDepth: 1,
  }
  const betaMsgs = [
    {
      type: 'assistant/message',
      time: atLocalHour(16, 0, 0, now),
      data: { usage: usage(500, 100, 0, 0), message: { source: { provider: 'fake-provider-b', model: 'fake-model-2' } } },
    },
    {
      // 昨天 —— 必须被「今天」的口径排除,但仍在按天报表里
      type: 'assistant/message',
      time: atLocalHour(11, 0, -1, now),
      data: { usage: usage(9999, 888, 777, 66), message: { source: { provider: 'fake-provider-b', model: 'fake-model-2' } } },
    },
  ]

  // 每个日志切成 3 帧(首帧带 session 元数据,后面两帧是纯追加)
  writeFrames(path.join(sessions, '--fake-workspace-alpha--', 'session-00000000-0000-4000-8000-000000000001', 'session.v4.jsonl.zstd'), [
    [alphaSession, alphaMsgs[0]],
    [alphaMsgs[1], alphaMsgs[2]],
    [alphaMsgs[3]],
  ])
  writeFrames(path.join(sessions, '--fake-workspace-beta--', 'session-00000000-0000-4000-8000-000000000002', 'session.v4.jsonl.zstd'), [
    [betaSession, betaMsgs[0]],
    [betaMsgs[1]],
  ])

  return {
    home,
    sessions,
    files: 2,
    // 今天:alpha 两条 + beta 一条
    expected: {
      reqs: 3,
      input: 1000 + 2000 + 500,
      output: 200 + 400 + 100,
      cacheRead: 500 + 1000 + 0,
      cacheWrite: 50 + 100 + 0,
    },
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const target = process.argv[2]
  if (!target) {
    console.error('用法: node tools/make-fixture.mjs <目标目录>')
    process.exit(2)
  }
  const home = path.resolve(target)
  const { expected } = makeFixture(home)
  const tokens = expected.input + expected.output + expected.cacheRead + expected.cacheWrite
  console.log(`已生成合成夹具: ${home}`)
  console.log(`  sessions/ 下 2 个会话(各切成多帧 zstd,含干扰记录与一条昨天的记录)`)
  console.log(`  今日期望值: reqs=${expected.reqs}  input=${expected.input}  output=${expected.output}  cacheRead=${expected.cacheRead}  cacheWrite=${expected.cacheWrite}  tokens=${tokens}`)
  console.log(`\n接下来:`)
  console.log(`  DSH_HOME=${home} node tools/today-breakdown.mjs`)
  console.log(`  DSH_HOME=${home} node tools/usage-report.mjs`)
}