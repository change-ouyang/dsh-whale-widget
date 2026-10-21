# tools/ — 会话日志探针

一组只读小工具,用来**核对**小鲸鱼挂件上「今日请求 / 用量」那两个数字:
它们直接读 DSH 的会话日志,把用量按天、按工作区、按 provider 重新算一遍,
好跟界面上的数字对账。

## 先说数据从哪来

DSH 把每个会话写成:

```
$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd
```

`$DSH_HOME` 默认是 `~/.dsh`,可用环境变量覆盖 —— 这些工具与插件宿主
(`lib/index.js`)用的是**同一套解析规则**。

两个容易踩的坑,这些工具就是为它们写的:

1. **这是「追加写的多帧 zstd」,不是一个 zstd 流。**
   往里追加时是**接着拼一个新的 zstd 帧**,不是一个流的分段。而 Node 的
   `zstdDecompressSync` **只解第一帧**,连 `createZstdDecompress()` 的流式
   解码在 v24 下也只解第一帧(用 `zstd-frames.mjs` 可以自己验证)。
   所以读的时候必须**按 magic `28 B5 2F FD` 切帧、逐帧解** ——
   `lib/usage-stats.mjs` 的 `forEachFrameText()` 干的就是这件事。
2. **末帧可能正被写入。** 此时 zstd 对截断的原始块不报错,而是返回半截内容,
   于是最后会多出一个**不完整的 JSON 行**。所有消费者都逐行 `try/JSON.parse`,
   坏行直接跳过。

## 工具

| 脚本 | 干什么 |
| --- | --- |
| `make-fixture.mjs` | 生成一个**合成的**假 DSH_HOME(多帧 zstd + 干扰记录),用来试工具或跑测试 |
| `usage-report.mjs` | 全量报表:按 model、按天(本地时区与 UTC 各一份) |
| `today-breakdown.mjs` | 今天的用量拆到 工作区 / 主-子代理 / 小时 |
| `today-by-provider.mjs` | 今天的用量按 provider 与 provider/model 分组 |
| `inspect-session.mjs` | 只读查看单个日志:记录类型分布 + 带 usage 的样本 + 首尾记录 |
| `zstd-frames.mjs` | 验证「多帧」这个前提:同步 / 流式 / 切帧三条路径并排对比 |
| `dsh-home.mjs` | 共用的小模块:解析 `$DSH_HOME`、把家目录压成 `~` |

## 用法

先造一个合成夹具(不含任何真实数据,随便跑):

```bash
node tools/make-fixture.mjs /tmp/fakehome
DSH_HOME=/tmp/fakehome node tools/today-breakdown.mjs
DSH_HOME=/tmp/fakehome node tools/usage-report.mjs
```

对着**自己的真实日志**跑(只读):

```bash
node tools/today-breakdown.mjs
node tools/today-by-provider.mjs
node tools/usage-report.mjs --days 30
```

单独看某个会话:

```bash
node tools/inspect-session.mjs "$HOME/.dsh/sessions/<ws>/<sid>/session.v4.jsonl.zstd"
node tools/zstd-frames.mjs     "$HOME/.dsh/sessions/<ws>/<sid>/session.v4.jsonl.zstd"
```

Windows PowerShell 下设环境变量用 `$env:DSH_HOME = 'C:\path\to\home'`。

## 口径

与插件一致,只统计 `assistant/message` 记录的 `data.usage`:

| 字段 | 含义 |
| --- | --- |
| `inputTokens` | 未缓存输入 |
| `outputTokens` | 输出(已含 reasoning) |
| `cacheReadTokens` / `cacheWriteTokens` | 缓存读 / 写 |
| `totalTokens` | 各渠道自己报的总量(报表里用,插件不用) |

- **只算 `assistant/message`。** 同一步重试不重复计数,compaction 不并入 ——
  与 `dsh-usage-panel` 的 reducer 口径一致。
- **按本地自然日分天**,不用 UTC(免得跨零点错位)。
- `usage-report.mjs` 同时给本地与 UTC 两份按天表,方便排查时区错位。

## 这些工具不写任何东西

除了 `make-fixture.mjs` 会写你指定的目标目录,其余全是只读。
用量统计的缓存由插件写在 `$DSH_HOME/.dshw-usage-stats.json`(不在这些工具里)。

`lib/usage-stats.mjs` 的回归测试见 [`../test/usage-stats.test.mjs`](../test/usage-stats.test.mjs),
它用的正是 `make-fixture.mjs` 生成的合成日志 —— 所以测试**不需要**任何真实会话数据。