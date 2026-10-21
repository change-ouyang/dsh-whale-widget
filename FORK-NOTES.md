# dsh-whale-widget fork 说明

- **上游**：`dsh-whale-widget@0.4.2`（MIT，[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)）
- **本 fork 版本**：`0.4.2-fork.1`
- **安装方式**：`dsh plugin --profile web add github:change-ouyang/dsh-whale-widget`，
  或本地开发安装 `dsh plugin --profile web add link:<本目录绝对路径>`

## 加了什么

在原有「今日已用」`today` 模块上扩展出 **今日请求数 / 今日 token 用量**：

| 占位符 | 含义 |
|---|---|
| `{reqs}` | 今日请求数（LLM 调用次数） |
| `{tokens}` | 今日 token 总量（未缓存输入 + 输出 + 缓存读 + 缓存写） |
| `{tokens_billed}` | 计费 token（未缓存输入 + 输出，不含缓存） |
| `{tokens_in}` / `{tokens_out}` | 未缓存输入 / 输出 |
| `{tokens_cache}` | 缓存读 |
| `{tokens_raw}` | 总量原始整数（不加 K/M 单位） |
| `{cache_hit}` | 缓存命中率 |

- 泡泡编辑里多了一个置顶模块 **「今日请求/用量」**，默认模板：`今日 {reqs} 次 · {tokens} token`
- 模块列表名字会自动区分：模板里出现 `{reqs}`/`{tokens*}`/`{cache_hit}` 就叫「今日请求/用量」，否则仍是「今日已用」
- 口径是**全部工作区合计 / 本地自然日**

## 实现位置

| 文件 | 改动 |
|---|---|
| `lib/usage-stats.mjs` | **新增**。递归扫 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`，按 zstd magic 切帧逐帧解码，统计 `assistant/message.usage`；每文件贡献按天缓存到 `$DSH_HOME/.dshw-usage-stats.json`，只有 size/mtime 变过的文件重扫，总表由各文件贡献汇总 ⇒ 幂等。另导出 `forEachFrameText` / `readSessionJsonl` 供 `tools/` 复用同一份切帧逻辑 |
| `lib/index.js` | 引入并实例化统计器（启动预热）；`/dsh-whale/balance.json` 增加 `usageStats` 字段（成功/失败都带）；新增路由 `/dsh-whale/usage-stats.json`（带 `?refresh=1` 可强制重扫） |
| `assets/whale-widget.js` | `state.usageStats` 接数据；`today` 模块占位符表、? 帮助、悬浮编辑器提示；调色板 chip 与拖拽键 `todayTokens` |
| `locale/` | **新增**。插件管理界面用的标题/描述（中英） |
| `tools/` | **新增**。会话日志探针 + 合成夹具生成器（`make-fixture.mjs`），详见 [`tools/README.md`](tools/README.md) |
| `test/` | **新增**。`lib/usage-stats.mjs` 的 19 项回归测试，跑 `npm test` |

## 会话日志的两个坑（`tools/` 就是为它们写的）

1. **追加写的多帧 zstd**：每次追加是**接着拼一个新的 zstd 帧**。Node 的
   `zstdDecompressSync` **只解第一帧**，连 `createZstdDecompress()` 的流式解码
   在 v24 下也只解第一帧 —— 必须按 magic `28 B5 2F FD` 切帧。
   （`node tools/zstd-frames.mjs <日志>` 可自行验证三条路径的差异。）
2. **末帧可能正被写入**：zstd 对截断的原始块不报错，而是**返回半截内容**，
   于是最后会多出一个不完整的 JSON 行。所有消费者都逐行 `try/JSON.parse`。

## 已知边界

- 统计只读会话日志，不碰账本；小鲸鱼自己的账本（`.dshw-usage.json`）仍只覆盖「装上之后」
- `compaction/summary` 的用量不计入（与 `dsh-usage-panel` 同口径）；被 resume/fork 的会话若继承了父会话前缀事件，目前会各算一次
- 前端 60s 一次余额轮询顺带刷新统计；宿主侧最快 30s 重扫一次
- 改 `lib/` 下宿主代码**必须重启客户端**才生效；只改 `assets/` 的话硬刷新（`Ctrl+F5`）即可
- 依赖 Node 的 zstd API ⇒ 要求 **Node ^22.19.0 || >=24.0.0**
