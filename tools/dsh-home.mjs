// 解析 DSH 主目录与会话日志根目录 —— 不写死任何本机路径。
//
// 口径与插件宿主 lib/index.js 完全一致:`DSH_HOME` 环境变量优先,
// 否则 ~/.dsh。所以探针看到的目录,就是插件统计的那个目录。

import os from 'node:os'
import path from 'node:path'

/** DSH 主目录(绝对路径)。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 会话日志根目录:$DSH_HOME/sessions。 */
export function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

/** 把绝对路径里的家目录压成 ~,便于贴日志时不泄露用户名。 */
export function tildify(p) {
  const home = os.homedir()
  return p.startsWith(home) ? '~' + p.slice(home.length) : p
}