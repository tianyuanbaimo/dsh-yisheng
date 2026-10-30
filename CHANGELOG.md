# 变更记录

## 0.1.4

不再把噪声写进记忆。

- **写入过滤**：新增 `whySkip(text, minChars)`，在落卡前挡住四类东西——问句（`？`/`?` 结尾）、朝我发的问句（"你还记得…吗""你叫什么"）、过短的句子（默认 < 10 字）、祈使命令（"你自己跑一下""帮我把…"）。判定顺序固定，显式"记住/我叫/我喜欢"一类线索直接放行，不受长度限制。
- **回答有内容时放行**：如果那一轮我的回答超过 40 字，说明信息在我这一侧（"为啥会崩？"→一段根因解释），短问句不会被连坐丢弃；只有"嗯/谢谢/晚安"这类仍然一律不记。
- **可配置**：新配置键 `minCardChars`（默认 10），`cordis.patch.yml` 已带注释。
- **计数**：`writer.stats` 新增 `skippedBy`，按原因分别计数，`/life status` 与测试都能看到。
- **清理历史噪声**：把此前误存的 5 张卡（"试试""你自己跑一下""用户：你自己装一个""你还记得我是谁吗？""你还记得自己叫什么名字吗"）归档，操作前备份到 `_system/backup/noise-clean-*`。
- **回归测试**：`scripts/smoke.mjs` 新增 8 项（5 项按原因分类 + 3 项端到端），共 55 项全过。

## 0.1.3

只改可观测性，行为不变。

- 排障钩子的落盘标记带上版本号：`boot-ok v0.1.3` / `boot-fail v0.1.3: ...`。此前只有 `boot-ok`，没法判断宿主进程里载入的是哪一版代码——重启前后都写同一行，等于没有证据。
- 版本号也从 `package.json` 读一次后复用，不再在日志里重复读盘。

## 0.1.2

0.1.1 的修法不彻底，这一版才是真修好。

- **根因**：宿主的 `llm.resolveModelInfo()` 是 `async` 的。在同步代码里调它、用 `try/catch` 包着，**接不住**它的拒绝——返回的 Promise 被丢掉，就变成 `unhandledRejection`，Node 24 默认直接结束进程，宿主报 `dsh desktop host exited with 1`，日志里是 `NO_ADAPTER: no adapter registered for provider "undefined"`。0.1.1 的 `try/catch` 因此形同虚设，15:24 又崩了一次。
- **修法**：`capacity()` 不再调用 `llm`，只用同步的 `tokenMeter.capacity()`，拿不到就返回 0；窗口大小改为从宿主自己的 `request/context` 事件里读 `data.contextWindow`，完全不主动问 llm。
- **回归测试**：`scripts/smoke.mjs` 新增 3 项——给一个 async 抛 `NO_ADAPTER` 的假 llm，断言 `capacity()` 返回 0、`observe()` 不抛、不留下未处理拒绝，并且 `request/context` 能把窗口大小带进来（44 项全过）。
- **文档**：README 的排障一节补上这条坑（async 接口不能用同步 try/catch 兜）。

## 0.1.1

修的是"插件在宿主里活不下来"这一类问题，功能没变。

- **崩溃修复（真事故）**：`lib/rebirth.js` 的水位检查里，`ctx.get('llm').resolveModelInfo()` 在宿主还没注册 provider 时会抛 `LlmError: no adapter registered for provider "undefined"`；这个异常从 `session/event` 观察者里冒出去，宿主判定为 fatal load failure 直接退出，重启后还会把这个 bundle 从 profile 里摘掉。现在 `capacity()` 抛错返回 0，`observe()` 整体再包一层 try/catch。
- **注册时机修复**：`apply()` 里原先 `await store.ready` 之后才注册 `systemPrompt` / 工具 / 命令，此时 context 可能已 inactive，报 `cannot get required service "systemPrompt" in inactive context`。现在一律同步注册，异步装配只负责读盘与日志。
- **注入兜底**：`buildText()` 包一层 try/catch，装配期抛错只会让这一轮没有记忆块，不会拖垮整轮。
- **未捕获 Promise**：`flush()` / `warmup()` / `dispose()` / `force()` 的所有 fire-and-forget 调用都补上 `.catch`，避免未处理拒绝把宿主带走。
- **排障钩子**：设 `YISHENG_DEBUG=<文件路径>` 时，插件会在 `apply` 与 `boot-ok` / `boot-fail` 时往该文件追加一行，用来确认它到底有没有被装载。

## 0.1.0

首个版本：摘要卡 + 细节外挂、五层写入流水线、三路注入与预算裁剪、owner 隔离与软遗忘、32K 转生。六个工具 `life_*` 与 `/life` 命令。零依赖，只用 `node:fs` / `node:path` / `node:os`。
