/**
 * lib/usage-stats.mjs 的回归测试 —— 全部基于 tools/make-fixture.mjs 生成的
 * **合成**会话日志,不读也不依赖任何真实数据。
 *
 * 运行:node test/usage-stats.test.mjs    (或 npm test)
 *
 * 重点钉住三件容易错的事:
 *   1. **多帧 zstd 必须逐帧解** —— Node 的 zstdDecompressSync 只解第一帧。
 *      夹具特意写成 3 个拼接帧,所以切帧一旦退化成立即报错。
 *   2. **只算 assistant/message,且只算今天** —— 干扰记录与昨天那条不能进今日口径。
 *   3. **重扫幂等** —— 同一份日志扫两次,数字不能涨。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { createUsageStats, forEachFrameText, readSessionJsonl, FRAME_MAGIC } from '../lib/usage-stats.mjs'
import { makeFixture } from '../tools/make-fixture.mjs'

let passed = 0
const failures = []
const chain = []

/** 串行跑用例(before/after 里要临时改磁盘,并发会互相干扰)。 */
function test(name, body) {
  const run = async () => {
    try { await body(); passed++; console.log(`  ok  ${name}`) }
    catch (error) { failures.push({ name, error }); console.log(`FAIL  ${name}\n      ${error.message}`) }
  }
  chain.push(chain.length === 0 ? run() : chain[chain.length - 1].then(run))
}

/** 每个用例一个独立的临时 home。 */
function tempHome(body) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-usage-test-'))
    try { await body(home) } finally { fs.rmSync(home, { recursive: true, force: true }) }
  }
}

const countFrames = (file) => {
  const buf = fs.readFileSync(file)
  let n = 0
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === FRAME_MAGIC[0] && buf[i + 1] === FRAME_MAGIC[1] && buf[i + 2] === FRAME_MAGIC[2] && buf[i + 3] === FRAME_MAGIC[3]) n++
  }
  return n
}

const firstLog = (home) => {
  const sessions = path.join(home, 'sessions')
  for (const dir of fs.readdirSync(sessions)) {
    const p = path.join(sessions, dir)
    for (const sid of fs.readdirSync(p)) {
      const f = path.join(p, sid, 'session.v4.jsonl.zstd')
      if (fs.existsSync(f)) return f
    }
  }
  throw new Error('夹具里没找到会话日志')
}

console.log('夹具本身')

test('夹具生成 2 个会话日志', tempHome(async (home) => {
  const { files } = makeFixture(home)
  const found = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl.zstd')) found.push(p)
    }
  }
  walk(path.join(home, 'sessions'))
  assert.equal(files, 2)
  assert.equal(found.length, 2)
}))

test('会话日志必须是**多帧**拼接(否则切帧 bug 测不出来)', tempHome(async (home) => {
  makeFixture(home)
  const n = countFrames(firstLog(home))
  assert.ok(n > 1, `夹具应是多帧,实际 ${n} 帧`)
}))

test('前提确认:zstdDecompressSync 只解第一帧', tempHome(async (home) => {
  makeFixture(home)
  const file = firstLog(home)
  const firstOnly = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
  const all = readSessionJsonl(file).join('\n')
  assert.ok(all.length > firstOnly.length, '逐帧解出来的内容应多于只解第一帧')
  assert.ok(all.includes('fake question'), '第一帧之外的内容也要能读到')
}))

console.log('逐帧读取')

test('forEachFrameText 访问到每一帧且不重复', tempHome(async (home) => {
  makeFixture(home)
  const file = firstLog(home)
  const texts = []
  forEachFrameText(file, (t) => texts.push(t))
  assert.equal(texts.length, countFrames(file), '回调次数应等于帧数')
  // 用帧内独有内容确认没有漏帧
  const joined = texts.join('\n')
  for (const marker of ['workspace-alpha', 'fake question', 'fake-tool']) {
    assert.ok(joined.includes(marker), `应包含 ${marker}`)
  }
}))

test('readSessionJsonl 跨帧返回全部行', tempHome(async (home) => {
  makeFixture(home)
  const lines = readSessionJsonl(firstLog(home))
  assert.ok(lines.length >= 5, `应读到全部 5 条记录,实际 ${lines.length}`)
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), '每行都应是合法 JSON')
}))

test('末帧被截断时不抛异常,统计不受影响', tempHome(async (home) => {
  makeFixture(home)
  const file = firstLog(home)
  const frame = zlib.zstdCompressSync(Buffer.from('{"type":"assistant/message"}\n', 'utf8'))
  fs.appendFileSync(file, frame.subarray(0, Math.floor(frame.length / 2))) // 半帧

  // 不能抛
  assert.doesNotThrow(() => readSessionJsonl(file), '截断的帧不该让读取失败')

  // ⚠️ 已知行为:zstd 对截断的原始块**不报错,而是返回半截内容**,
  //    于是会多出一个不完整的行。所以调用方必须容忍解析失败。
  const lines = readSessionJsonl(file)
  const bad = lines.filter((l) => { try { JSON.parse(l); return false } catch { return true } })
  assert.equal(bad.length, 1, '截断处应恰好留下一个不完整的行')
  assert.ok(bad[0].startsWith('{"type":"a'), `不完整的行应是被切掉的那条,实际 ${JSON.stringify(bad[0])}`)

  // 真正要守住的是**统计结果**:坏行必须被 JSON.parse 挡掉,数字一分不差。
  const stats = createUsageStats({ home, refreshMs: 0 })
  await stats.refresh()
  assert.equal(stats.payload().today.reqs, 3, '坏行不该被算成一个回合')
  stats.dispose()
}))

console.log('今日统计口径')

test('今日汇总与夹具期望值逐项相等', tempHome(async (home) => {
  const { expected } = makeFixture(home)
  const stats = createUsageStats({ home, refreshMs: 0 })
  await stats.refresh()
  const p = stats.payload()
  assert.equal(p.ok, true)
  assert.equal(p.today.reqs, expected.reqs, 'reqs')
  assert.equal(p.today.input, expected.input, 'input')
  assert.equal(p.today.output, expected.output, 'output')
  assert.equal(p.today.cacheRead, expected.cacheRead, 'cacheRead')
  assert.equal(p.today.cacheWrite, expected.cacheWrite, 'cacheWrite')
  stats.dispose()
}))

test('派生字段 tokens / billed / hitRate 口径正确', tempHome(async (home) => {
  const { expected } = makeFixture(home)
  const stats = createUsageStats({ home, refreshMs: 0 })
  await stats.refresh()
  const t = stats.payload().today
  const tokens = expected.input + expected.output + expected.cacheRead + expected.cacheWrite
  assert.equal(t.tokens, tokens, 'tokens 应含缓存读与缓存写')
  assert.equal(t.billed, expected.input + expected.output, 'billed 不应含缓存')
  const denom = expected.input + expected.cacheRead + expected.cacheWrite
  assert.ok(Math.abs(t.hitRate - expected.cacheRead / denom) < 1e-12, 'hitRate')
  stats.dispose()
}))

test('没有 usage 的记录与昨天那条都不进今日口径', tempHome(async (home) => {
  makeFixture(home)
  const stats = createUsageStats({ home, refreshMs: 0 })
  await stats.refresh()
  const p = stats.payload()
  // 夹具里今天只有 3 条 assistant/message;user/message 与 tool/call 必须被忽略
  assert.equal(p.today.reqs, 3, '只应计 3 条助手回合')
  // 昨天那条 9999 input 不能混进来
  assert.ok(p.today.input < 9999, '昨天的大额记录不该计入今天')
  stats.dispose()
}))

test('昨天仍是独立的一天(按天报表保留)', tempHome(async (home) => {
  makeFixture(home)
  const stats = createUsageStats({ home, refreshMs: 0 })
  await stats.refresh()
  const p = stats.payload()
  assert.ok(p.daysTracked >= 2, `应至少追踪到今天与昨天,实际 ${p.daysTracked}`)
  stats.dispose()
}))

test('today.day 就是本地自然日', tempHome(async (home) => {
  makeFixture(home)
  const stats = createUsageStats({ home, refreshMs: 0 })
  await stats.refresh()
  const d = new Date()
  const pad2 = (n) => (n < 10 ? '0' + n : String(n))
  assert.equal(stats.payload().day, `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)
  stats.dispose()
}))

console.log('幂等与缓存')

test('重扫幂等:第二次 refresh 改动数为 0,数字不变', tempHome(async (home) => {
  makeFixture(home)
  const stats = createUsageStats({ home, refreshMs: 0 })
  const first = await stats.refresh()
  const before = stats.payload().today
  const second = await stats.refresh()
  assert.ok(first > 0, '首次应扫到文件')
  assert.equal(second, 0, '第二次不该有改动')
  assert.deepEqual(stats.payload().today, before, '数字不能涨')
  stats.dispose()
}))

test('缓存可复用:新实例读缓存后重扫改动数为 0', tempHome(async (home) => {
  makeFixture(home)
  const a = createUsageStats({ home, refreshMs: 0 })
  await a.refresh()
  const expected = a.payload().today
  a.dispose()

  assert.ok(fs.existsSync(path.join(home, '.dshw-usage-stats.json')), '应写出缓存')

  const b = createUsageStats({ home, refreshMs: 0 })
  const changed = await b.refresh()
  assert.equal(changed, 0, '缓存命中,不该重解文件')
  assert.deepEqual(b.payload().today, expected, '缓存恢复的数字应与首次一致')
  b.dispose()
}))

test('日志变大后只重扫该文件,数字随之更新', tempHome(async (home) => {
  makeFixture(home)
  const stats = createUsageStats({ home, refreshMs: 0 })
  await stats.refresh()
  const before = stats.payload().today.reqs

  const file = firstLog(home)
  const rec = {
    type: 'assistant/message',
    time: Date.now(),
    data: { usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 } },
  }
  const frame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(rec) + '\n', 'utf8'))
  fs.appendFileSync(file, frame)
  const future = new Date(Date.now() + 2000)
  fs.utimesSync(file, future, future) // 确保 size/mtime 都变了

  const changed = await stats.refresh()
  assert.equal(changed, 1, '只该重扫这一个文件')
  assert.equal(stats.payload().today.reqs, before + 1, '新增的回合要被算进来')
  stats.dispose()
}))

console.log('健壮性')

test('sessions 目录不存在时不抛异常,返回全零', tempHome(async (home) => {
  const stats = createUsageStats({ home, refreshMs: 0 })
  await stats.refresh()
  const p = stats.payload()
  assert.equal(p.today.reqs, 0)
  assert.equal(p.today.tokens, 0)
  assert.equal(p.today.hitRate, null, '没有分母时应为 null 而不是 NaN')
  stats.dispose()
}))

test('缓存文件被写坏时降级为全量重扫,而不是崩掉', tempHome(async (home) => {
  makeFixture(home)
  fs.writeFileSync(path.join(home, '.dshw-usage-stats.json'), '{ 这不是 JSON')
  const stats = createUsageStats({ home, refreshMs: 0 })
  const changed = await stats.refresh()
  assert.equal(changed, 2, '读不了缓存就重扫全部文件')
  assert.equal(stats.payload().today.reqs, 3)
  stats.dispose()
}))

test('snapshot() 是同步的,永不抛异常、永不返回 Promise', tempHome(async (home) => {
  makeFixture(home)
  const stats = createUsageStats({ home, refreshMs: 0 })
  const snap = stats.snapshot()
  assert.ok(!(snap instanceof Promise), 'snapshot 必须是同步返回值(界面每帧都可能调它)')
  assert.equal(snap.ok, true)
  assert.equal(typeof snap.today.reqs, 'number')
  assert.equal(typeof snap.today.tokens, 'number')
  assert.equal(typeof snap.files, 'number')

  // 注意:夹具只有 2 个文件,扫描里没有让出事件循环的机会,所以这次 snapshot
  // 可能已经看到完整结果 —— 这不算错,只能断言「数已经对」而不能断言「数还是 0」。
  await stats.refresh()
  assert.equal(stats.payload().today.reqs, 3)
  stats.dispose()
}))

test('大量文件时 snapshot() 仍立即返回(扫描让出事件循环)', tempHome(async (home) => {
  // 造 20 个会话文件:refresh() 每 8 个文件让出一次,于是首次 snapshot 一定
  // 拿到的是「还没扫完」的快照 —— 这正是要守住的契约:绝不阻塞调用方。
  const sessions = path.join(home, 'sessions')
  for (let i = 0; i < 20; i++) {
    const dir = path.join(sessions, `--fake-ws-${i}--`, `session-00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`)
    fs.mkdirSync(dir, { recursive: true })
    const rec = { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 } } }
    const frame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(rec) + '\n', 'utf8'))
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frame)
  }
  const stats = createUsageStats({ home, refreshMs: 0 })
  const snap = stats.snapshot()
  assert.equal(snap.today.reqs, 0, '首次 snapshot 应在扫描完成前就返回')
  assert.equal(snap.scanning, true, '应标记正在扫描')
  await stats.refresh()
  assert.equal(stats.payload().today.reqs, 20, '扫描完成后应全部算上')
  stats.dispose()
}))

test('dispose() 之后 snapshot 不再触发新扫描', tempHome(async (home) => {
  makeFixture(home)
  const stats = createUsageStats({ home, refreshMs: 0 })
  await stats.refresh()
  stats.dispose()
  const snap = stats.snapshot(true) // force 也不该起作用
  assert.equal(snap.scanning, false)
  assert.equal(snap.today.reqs, 3, '仍能读到已有数据')
}))

await Promise.all(chain)

console.log(`\n${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exitCode = 1
}