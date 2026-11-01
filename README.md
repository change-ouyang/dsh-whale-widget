# DSH 小鲸鱼记账挂件（DeepSeek Balance Whale Widget）

![DSH 小鲸鱼记账挂件](assets/DSH2.png)

DSH Web 界面右下角的常驻挂件：小鲸鱼气泡图 + DeepSeek API 余额 + 今日已用 + 每轮对话消耗，泡泡内容可完全自定义（点击序列、模块化排版、并列加权出泡、随机语句/随机图片）。标准 DSH bundle 插件，`dsh plugin` 一键安装，无需任何会话令牌。

> ⚠️ **Codex 版小鲸鱼已迁至独立仓库** → <https://github.com/Yang-huai406/Codex-Whale-Public>（已安装用户无需重装；后续更新、问题反馈与版本发布都在新仓库）

## ⚠️ 本仓库是 fork（与上游的差异）

基于 [上游 MeteorNOX/DeepSeek-Balance-Whale-Widget v0.4.2](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）继续开发，不是上游官方仓库；上游作者与历史贡献者署名见文末「致谢」。除下表所列外，其余文件与上游 v0.4.2 **逐字节相同**（含 `LICENSE` 与 `PROVENANCE.md`）。

| 文件 | 改动 |
| --- | --- |
| `lib/usage-stats.mjs` | **新增**。递归扫 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd` 聚合今日 usage，按文件缓存增量重扫，幂等 |
| `lib/index.js` | 实例化统计器；`balance.json` 增加 `usageStats`；新增 `/dsh-whale/usage-stats.json`（带 `?refresh=1`） |
| `assets/whale-widget.js` | 前端接用量数据；新增下方占位符与置顶模块「今日请求/用量」 |
| `locale/` | **新增**。插件管理界面显示用的标题与描述（中英各一份） |
| `tools/` | **新增**。会话日志探针 + 合成夹具生成器，见 [`tools/README.md`](tools/README.md) |
| `test/` | **新增**。`usage-stats` 回归测试 19 项（合成夹具，不读真实日志） |
| `FORK-NOTES.md` | **新增**。本 fork 的详细说明 |

核心新增是**今日请求 / 用量统计**，对应泡泡占位符（口径：全部工作区合计 / 本地自然日）：

| 占位符 | 含义 |
| --- | --- |
| `{reqs}` | 今日请求数 |
| `{tokens}` | 今日 token 总量（含缓存读写） |
| `{tokens_billed}` | 计费 token（未缓存输入 + 输出） |
| `{tokens_in}` / `{tokens_out}` | 未缓存输入 / 输出 |
| `{tokens_cache}` | 缓存读 |
| `{tokens_raw}` | 总量原始整数（不加 K/M 单位） |
| `{cache_hit}` | 缓存命中率 |

## 安装

- **DSH Web**：`dsh plugin --profile web add dsh-whale-widget`（npm 已发布版，推荐）；装完重启 `dsh web`、浏览器 Ctrl+F5。也可 `github:change-ouyang/dsh-whale-widget` 或本地 `link:<目录>`，但装的是当前状态、不跟随已发布版本。
- **官方桌面端（Electron）**：读的是 `desktop` profile，`--profile web` 装了它读不到、CLI 也拒绝 `--profile desktop`——请在**桌面端会话里让 DSH 自己装**（宿主内置 `plugin_manager` 安装 `dsh-whale-widget`）；装完没出现就完全退出客户端重开。
- ⚠️ **两条线互不兼容**：Codex 版装不进 DSH Web，本插件也不能在 Codex 桌面里运行。
- ⚠️ **安装方式二选一、别混用**：npm 名 / `github:` / `link:` 是同一个包名，先后安装会并存冲突；换来源前先 `dsh plugin --profile web remove dsh-whale-widget`。

## 特性

- 💰 **余额**：60 秒自动刷新 + 点击鲸鱼手动刷新；**API key 优先**（`DEEPSEEK_API_KEY`），没配 key 时自动兜底走 DSH「设置 → 账号与余额」的登录态（不需要去 platform 建 key）；网络抖动沿用最近余额不报错。
- 📊 **小鲸鱼记账（今日已用）**：零令牌；余额下降按观测累计为消费、余额上升（充值/赠金）单独记录不冲销，可在「小鲸鱼记账 → DeepSeek（内置）→ 设置 → 余额校正」按实际到账校正；口径为 DeepSeek 账户口径（该 key 余额观测，不含其它厂商），逐轮明细留 90 天 / 2 万条、逐日归档 365 天。
- 💬 **每轮消耗泡泡**：按模型真实 usage（input / cache / output / reasoning）换算金额，每轮结束弹出；可开关与自动关闭，内容模块化自定义（金额 `{cost}`），入口「音效与提示 → 全局设置 → 每轮消耗提示」。
- ⛰️ **峰谷定价**：高峰 = 工作日 9:00–12:00、14:00–18:00（北京时间），其余空闲；2026-08-23 起周末全天谷价；峰谷模块支持状态文字与倒计时。
- 📒 **用量记录窗口**：今日 / 近 7 天 / 全部消费与模型占比条，逐日展开明细，支持按日期或模型名搜索（`deepseek-flash` 标注为 DeepSeek-V4.1-Flash）。
- 🖱️ **拖拽吸附 / 移动端**：四边吸附区可自定义（顶部默认 0 = 关闭）、贴左水平镜像翻转、按压 Q 弹；移动端触摸拖动与长按排序；隐藏菜单按钮后电脑右键 / 手机长按唤出菜单。
- 🧩 **泡泡系统**：点击序列可增删排序、两泡可并列 A/B 加权抽选；模块化内容（文本 / 链接 / 随机语句 / 图片 / 随机图片 / 余额类 / 今日已用 / 峰谷 / 对话名），逐模块样式与拖拽排版，模块库复用。
- 🔔 **提醒**：余额预警、今日预算、每轮消耗提示，内容均可编辑；等待提问 / 授权时有提示音与常驻气泡（默认只冒泡不响，点气泡收起）。
- 🔊 **音效**：按压 / 松开音效组、任务结束音、提问 / 授权音，每事件独立音量（未拖过滑块则跟随按压音量）、逐行试听。
- 🧱 **自定义 API（多厂商）**：34 个厂商模板（可查余额 / 仅探活 / 订阅额度），密钥写 DSH 凭据服务、配置只存凭据名；额度按会话 token 自动累计或手动；可自填单价（美元需填汇率，账目统一按人民币结算，单价不分峰谷）。
- 📂 **Codex 本地统计**：直接读本机 Codex 会话日志统计 token（只读、不联网、不需要密钥）；这只是把 Codex 当数据源，与「Codex 版挂件」是两回事。

## 工具与测试

```bash
npm test                                   # 19 项，全部基于合成夹具，不读你的任何日志
node tools/make-fixture.mjs /tmp/fakehome  # 造一份假日志来试工具
DSH_HOME=/tmp/fakehome node tools/today-breakdown.mjs
node tools/today-breakdown.mjs             # 对着自己的真实日志只读统计
```

`tools/` 下还有 `usage-report.mjs`（按 model / 按天）、`today-by-provider.mjs`、`inspect-session.mjs`、`zstd-frames.mjs`，用途与口径见 [`tools/README.md`](tools/README.md)。

> 坑：会话日志是追加写的**多帧 zstd**，而 Node 的 `zstdDecompressSync` 与流式解码都**只解第一帧**，必须按 magic `28 B5 2F FD` 切帧（可用 `node tools/zstd-frames.mjs <日志>` 自验）。因依赖 Node zstd API，要求 **Node ^22.19.0 || >=24.0.0**。

## 文档

- [`FORK-NOTES.md`](FORK-NOTES.md) —— 本 fork 的详细说明（改动逐条与设计取舍）
- [`tools/README.md`](tools/README.md) —— 探针工具用途与统计口径
- [`PROVENANCE.md`](PROVENANCE.md) —— 美术素材来源与权利说明

## 许可证与致谢

代码基于 MIT（[LICENSE](LICENSE)）；`assets/` 美术素材不在 MIT 覆盖内，详见 [PROVENANCE.md](PROVENANCE.md)。

- 上游原作者 **月匠（MeteorNOX）** 与 macOS 适配贡献者 [@1llysviel](https://github.com/1llysviel)，完整历史贡献者名单见[上游仓库](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。
- Codex 版小鲸鱼由 [@Yang-huai406](https://github.com/Yang-huai406) 迁移并维护，开发历史、历代版本与作者贡献完整保留。
- 其余 issue 报告与 PR 贡献者（@ztzpro、@under-the-ocean、@21253soursweetlemon、@fangbm、@xiaolinnnnnnn、@yybai25、@Jy-EggRoll、@ELFsay、@0Sakura721、@VaeKaras、@MengLs1620 等）一并致谢。
