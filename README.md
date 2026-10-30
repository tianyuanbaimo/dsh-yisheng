# dsh-yisheng

给 DSH 的持久记忆与人格插件。零依赖，只用 `node:fs` / `node:path` / `node:os`。

## 安装

```powershell
# 作为插件装进某个 profile（走 git 源时 PATH 上要有 git）
dsh plugin --profile web add github:tianyuanbaimo/dsh-yisheng

# 本地开发：改哪儿生效哪儿，重启宿主即可
dsh plugin --profile web add "link:D:\path\to\dsh-yisheng"
```

也可以在 DSH 的「插件 → 发现 → 索引源」里加下面这行，之后在界面上点装：

```
https://raw.githubusercontent.com/tianyuanbaimo/dsh-yisheng/main/market/index.json
```

装完必须**完整退出并重开**宿主（不是刷新页面），插件在进程启动时装配。启动日志里会出现一行：

```
[dsh-yisheng] 就绪 · v0.1.4 · 人格 v1 · N 张卡 / M 条细节 · 转生 0 次 · 工具 6/6 · <数据目录>
```

数据放在磁盘上的一棵小目录树里，关机、换会话、换 profile 都不会丢：

```
D:\洄的一生\
  persona.md        人格正文（soul_reflect / life_self 覆盖写，旧版进 snapshots/）
  cards.jsonl       摘要卡（一层：是什么、关键词、类型、归属、权重、命中）
  facts.jsonl       细节（二层：原话、路径、数字，按需展开）
  episodes.jsonl    会话片段（旧格式，一次性迁成卡）
  state.json        版本号、人格版本、转生次数、窗口大小
  journal.md        成长日志
  handoffs.jsonl    转生交接记录
  handoffs/         每份交接的 Markdown
  snapshots/        人格快照，可回滚
```

## 能力

- **摘要索引 + 细节外挂**：注入只给摘要，要原话用 `life_card` 展开，省 token。
- **写入流水线**：显式线索（"记住""我叫…"）当轮落卡；话题切换或 5 分钟没消息时把缓冲压成卡；"嗯/好/哈哈"这类低信息量直接丢；类型用关键词兜底判；Jaccard ≥ 0.85 的重复卡合并。
- **三路注入**：重要卡 + 最近聊到的 + 和本会话主题相关的（可选用本地 Ollama 重排，2 秒超时降级），记忆小节 2000 字硬预算，人格另算。
- **归属隔离**：卡片带 owner，群聊里查不到私聊内容；三因子打分（语义 0.7 / 新鲜 0.2 / 频率 0.1）。
- **90 天软遗忘**：非 important、权重低、长期没命中的卡归档，不物理删除。
- **32K 转生**：上下文用到阈值时把这一段收成交接卡、落盘、开新会话；新会话第一轮读一次交接。

## 工具

| 工具 | 用途 |
| --- | --- |
| `life_remember` | 写一张卡（可带 facts 细节、important） |
| `life_recall` | 按关键词检索摘要卡 |
| `life_card` | 展开一条卡的细节 |
| `life_forget` | 归档一张卡（可回滚） |
| `life_self` | 整篇重写人格（自动快照） |
| `life_rebirth` | 立刻转生：交接 + 开新会话 |

命令：`/life status|cards|card|search|remember|forget|merge|sweep|self|rollback|journal|export|rebirth|stats|help`

## 配置

见 `cordis.patch.yml`，所有键都有默认值。主要几项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `""` | 空 = `$DSH_HOME/yisheng` 或 `~/.dsh/yisheng` |
| `promptMaxChars` | `2000` | 记忆小节字数预算 |
| `personaMaxChars` | `2600` | 人格字数上限（超出截断） |
| `idleWriteMs` | `300000` | 多久没消息就把缓冲压成卡 |
| `minCardChars` | `10` | 自动落卡的最短长度；问句、命令、闲聊一律不记，显式"记住"不受限 |
| `rebirthAt` | `32000` | 上下文多少 token 转生 |
| `extractModel` / `rerankModel` | `""` | 填了就走本地 Ollama，留空走关键词兜底 |

## 测试

```powershell
& 'D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' scripts\smoke.mjs
```

41 项断言，覆盖存储/合并/归属隔离/检索/写入流水线/预算/转生/工具契约/重启持久化。

## 设计取舍

- **只归档不删除**：忘掉是 `archived: true`，回滚一条命令的事。
- **人格与记忆分开算预算**：人格写长了不该把"必须守住的"挤掉。
- **注入文本按版本冻结**：同一会话里同一份记忆只出现一次，护住前缀缓存。
- **零依赖**：依赖会过期，记忆不该跟着过期。

## 排障

插件没生效时，先确认它到底有没有被装载：设环境变量 `YISHENG_DEBUG=<文件路径>`，宿主启动时会往该文件追加 `apply` / `boot-ok v<版本>` / `boot-fail v<版本>: ...`。带版本号是为了分辨"进程里载入的是哪一份代码"——改了文件但没重启时，标记仍是旧版本。

- 只有 `apply` 没有 `boot-ok`：装配阶段卡住了，看 `boot-fail` 的原因。
- 一行都没有：bundle 没进 profile 的 `dsh.profile.bundles`，或者包解析不到。

宿主侧还有一份崩溃日志可查：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`。

**别在同步路径上调宿主的 async 接口。** 这是踩过的真坑：`ctx.get('llm').resolveModelInfo()` 是 `async` 的，同步 `try/catch` 只能接住"调用那一刻"的抛出，接不住返回 Promise 的拒绝；拒绝没人接就是 `unhandledRejection`，Node 24 会把整个宿主进程结束掉，现场表现是 `dsh desktop host exited with 1` 加一条 `NO_ADAPTER`。要用的数据从事件里拿（比如 `request/context` 的 `contextWindow`），或者 `return` 之后 `.catch()`。

