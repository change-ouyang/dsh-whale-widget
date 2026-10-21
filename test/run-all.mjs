// 跑全部测试：node test/run-all.mjs
//
// 自足：不依赖 DSH，也不读任何真实会话日志（夹具由 tools/make-fixture.mjs 现场生成）。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = ['usage-stats.test.mjs']

let failed = 0
for (const file of files) {
  console.log(`\n=== ${file} ===`)
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed++
}

console.log(failed === 0 ? '\n全部测试通过' : `\n${failed} 个测试文件失败`)
process.exitCode = failed === 0 ? 0 : 1