// ============================================================================
// 今日用量统计(fork:难度不高但很实用的一个增量)
// ----------------------------------------------------------------------------
// 存在的理由:小鲸鱼自己的账本(.dshw-usage.json)只记「装上之后」的事件,
// 所以它回答不了「我今天总共调用了多少次 / 用了多少 token」。这里直接读
// DSH 的会话日志,把当天全部工作区的真实用量算出来。
//
// 数据源:$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd
//   · 追加写的多帧 zstd 文件:Node 的 zstdDecompressSync 只解第一帧,
//     所以这里按 magic(28 B5 2F FD)切帧,逐帧解。
//   · 只统计 assistant/message 的 usage(与 dsh-usage-panel 的 reducer 一致:
//     同一步重试不重复计数,reasoning 已含在 output 内,compaction 不并入)。
//
// 增量策略:每个文件的贡献**按天**分别记账,缓存在 $DSH_HOME/.dshw-usage-stats.json;
//   只有 size/mtime 变过的文件才重新解码,总表由各文件贡献汇总而成 ⇒
//   重扫幂等(文件被截断/重写也不会重复累计),且不必做易错的"增量相减"。
//   扫描在后台进行,快照立即返回(绝不阻塞 /dsh-whale/balance.json)。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_SUFFIX = '.jsonl.zstd'
const CACHE_NAME = '.dshw-usage-stats.json'
const CACHE_VERSION = 1

const pad2 = (n) => (n < 10 ? '0' + n : String(n))

// 本地自然日(跟用户看到的"今天"一致,不用 UTC 免得跨零点错位)
function localDayKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function emptyBucket() {
  return { reqs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function walkLogs(dir, acc) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkLogs(p, acc)
    else if (e.name.endsWith(LOG_SUFFIX)) acc.push(p)
  }
  return acc
}

// 把单个会话日志的全部用量折成 { 'YYYY-MM-DD': bucket }
function foldLogFile(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  let idx = buf.indexOf(FRAME_MAGIC, 0)
  while (idx !== -1) { starts.push(idx); idx = buf.indexOf(FRAME_MAGIC, idx + 4) }
  const contrib = {}
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    let text
    try { text = zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8') } catch {
      // 末帧可能正在写入(被截断):再试一次到 EOF,仍失败就跳过这一帧
      try { text = zlib.zstdDecompressSync(buf.subarray(from)).toString('utf8') } catch { continue }
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.type !== 'assistant/message') continue
      const u = rec.data && rec.data.usage
      const t = rec.time
      if (!u || typeof t !== 'number') continue
      const day = localDayKey(t)
      const b = contrib[day] || (contrib[day] = emptyBucket())
      b.reqs += 1
      b.input += Number(u.inputTokens) || 0
      b.output += Number(u.outputTokens) || 0
      b.cacheRead += Number(u.cacheReadTokens) || 0
      b.cacheWrite += Number(u.cacheWriteTokens) || 0
    }
  }
  return contrib
}

export function createUsageStats(options = {}) {
  const home = options.home
  const refreshMs = Number.isFinite(options.refreshMs) ? options.refreshMs : 30000
  const keepDays = Number.isFinite(options.keepDays) ? options.keepDays : 60
  const sessionsRoot = path.join(home, 'sessions')
  const cachePath = path.join(home, CACHE_NAME)

  let cache = { version: CACHE_VERSION, updatedAt: 0, files: {}, days: {} }
  let inFlight = null
  let disposed = false

  function loadCache() {
    try {
      const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      if (j && j.version === CACHE_VERSION && j.files && j.days) cache = j
    } catch (err) {}
  }

  function saveCache() {
    try {
      fs.mkdirSync(home, { recursive: true })
      const tmp = cachePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8')
      fs.renameSync(tmp, cachePath)
    } catch (err) {}
  }

  // 早于 cutoff 的天不再保留(日志文件可能很大,别让缓存无限长)
  function cutoffKey() {
    return localDayKey(Date.now() - keepDays * 86400000)
  }

  async function refresh() {
    const files = walkLogs(sessionsRoot, [])
    const cutoff = cutoffKey()
    let changed = 0
    let seen = 0
    for (const file of files) {
      let st
      try { st = fs.statSync(file) } catch { continue }
      const rel = path.relative(sessionsRoot, file)
      const prev = cache.files[rel]
      seen++
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue
      let contrib
      try { contrib = foldLogFile(file) } catch { continue }
      cache.files[rel] = { size: st.size, mtimeMs: st.mtimeMs, contrib }
      changed++
      // 每 8 个文件让出一次事件循环:首次全量扫描别把宿主卡住
      if (changed % 8 === 0) await new Promise((r) => setImmediate(r))
      if (disposed) return changed
    }
    // 汇总:总表 = 各文件贡献之和(不依赖上次的总表 ⇒ 幂等)
    const days = {}
    for (const rel in cache.files) {
      const contrib = cache.files[rel].contrib || {}
      for (const day in contrib) {
        if (day < cutoff) continue
        const src = contrib[day]
        const dst = days[day] || (days[day] = emptyBucket())
        dst.reqs += src.reqs || 0
        dst.input += src.input || 0
        dst.output += src.output || 0
        dst.cacheRead += src.cacheRead || 0
        dst.cacheWrite += src.cacheWrite || 0
      }
    }
    cache.days = days
    cache.updatedAt = Date.now()
    cache.filesSeen = seen
    saveCache()
    return changed
  }

  function payload() {
    const day = localDayKey(Date.now())
    const t = cache.days[day] || emptyBucket()
    const denom = t.input + t.cacheRead + t.cacheWrite
    return {
      ok: true,
      day,
      updatedAt: cache.updatedAt || null,
      scanning: !!inFlight,
      files: cache.filesSeen || Object.keys(cache.files).length,
      daysTracked: Object.keys(cache.days).length,
      today: {
        reqs: t.reqs,
        input: t.input,
        output: t.output,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite,
        // 真实消耗总量(含缓存读),与卡片上那个"真实消耗 Tokens"同口径
        tokens: t.input + t.output + t.cacheRead + t.cacheWrite,
        // 计费输入+输出(不含缓存读)
        billed: t.input + t.output,
        hitRate: denom > 0 ? t.cacheRead / denom : null,
      },
    }
  }

  function kick() {
    if (inFlight) return inFlight
    inFlight = refresh()
      .catch(() => {})
      .finally(() => { inFlight = null })
    return inFlight
  }

  // 读取快照:过期就在后台起一次扫描,本次立刻返回旧数据(绝不 await)
  function snapshot(force) {
    if (disposed) return payload()
    if (force || Date.now() - (cache.updatedAt || 0) > refreshMs) kick()
    return payload()
  }

  loadCache()
  return {
    snapshot,
    prime: kick,
    refresh: () => kick(),
    payload,
    dispose() { disposed = true },
  }
}
