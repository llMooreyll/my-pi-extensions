# pi-cache-timer

提示词缓存倒计时与发送前提醒：在输入框边框上显示当前缓存还能保留多久；缓存已失效且上下文较大时，发送消息前询问是否先压缩。

| 功能 | 说明 |
|---|---|
| 缓存倒计时 | 通过 `ctx.ui.setStatus("cache-timer", …)` 输出，每秒刷新。装有 [statusline-pi](../statusline-pi) 时显示在输入框下边框左侧，否则显示在 Pi 默认底栏 |
| 发送前提醒 | 空闲时输入的消息会先检查缓存状态。缓存已过期或已切换模型，且满足任一阈值时弹出选择框 |

## 倒计时

| 状态 | 显示 | 颜色 |
|---|---|---|
| Pi 正在运行 | `cache active` | 灰 |
| 剩余 ≥ 10 分钟 | `cache 42m` | 绿 |
| 剩余 < 10 分钟 | `cache 9:59` | 绿，最后 1 分钟变黄 |
| 已过期 | `cache expired 7m ago · 180k` | 红 |
| 当前模型与写入缓存的模型不同 | `cache lost: model changed · 180k` | 红 |
| 没有固定时长的缓存（如 DeepSeek 磁盘缓存） | `cache durable · 180k` | 灰 |
| 尚无请求、压缩或分支摘要之后尚无新请求、模型从未报告缓存用量 | 不显示 | |

- 起点是最近一次请求的开始时间（assistant 消息的 `timestamp`），厂商的缓存时长从请求开始计算，不从响应结束计算。
- Pi 自动续缓存（会话中的 `cache_warm` 用量记录）后，倒计时从续缓存的时间重新开始。
- 比标称时长提前 15 秒判定过期，留出请求到达服务端的时间。
- 剩余 10 分钟以上只显示分钟，状态大约每分钟才变一次，减少 pi-remote 向手机同步的次数。
- `180k` 是最近一次请求的提示词 token 数（`input + cacheRead + cacheWrite`），即未命中时要重新计费的部分。

## 发送前提醒

触发条件（全部满足）：

1. 消息是 Pi 空闲时输入的：插队或排队的消息、其他扩展发出的消息和 `!` 命令不检查；
2. 缓存已过期，或者当前模型与写入缓存的模型不同；
3. 上下文 ≥ `minTokens`（默认 50k），或预计比命中缓存多付 ≥ `minExtraCost`（默认 $0.20）。

选择框的标题写明过期多久和要重新计费的 token 数，例如 `Prompt cache expired (12m since the last request): 180k tokens will be billed again`。选项如下：

| 选项 | 行为 |
|---|---|
| `Compact, then send (compaction request ≈ $x)` | 拦下这条消息，调用 `ctx.compact()`；压缩完成后用 `pi.sendUserMessage(…, { expandPromptTemplates: true })` 发出原文，图片一并带上，`/skill`、`/template` 照常展开 |
| `Send now (≈ $y more than a cache hit)` | 照常发送 |
| `Cancel and put the message back in the editor` | 拦下这条消息并放回输入框；按 Esc 关闭选择框时相同 |

压缩失败或补发失败时，消息放回输入框；输入框里已有新内容时不覆盖，只弹出提示。图片附件无法放回输入框，需要重新添加。

费用估算使用当前模型的价格和 Pi 的 `calculateCost`（包含阶梯价）：

- 多付金额 = 未命中价 − 命中价。未命中价：观察到 1 小时缓存时按 2 倍输入价算，模型有写缓存价时按写缓存价算，否则按输入价算。
- 压缩请求金额 = (上下文 − 20k) × 输入价。Pi 压缩时把较早的对话作为新文本发出，不会读取对话缓存；20k 是 Pi 默认保留原文的最近部分（`compaction.keepRecentTokens`）。

压缩不一定比直接发送便宜：缓存过期后，压缩请求本身就要按输入价付一次较早对话的费用。它的收益主要在后续轮次的上下文更小。

## 缓存时长

按以下顺序取第一个可用值：

1. 配置文件 `ttlSeconds` 中的 `"provider/model"`，再查 `"provider"`；
2. 最近一次写缓存的返回结果报告了 1 小时缓存（`cacheWrite1h > 0`）：3600 秒；
3. 模型配置的 `promptCache`：设置 `PI_CACHE_RETENTION=long` 时取 `long`，否则取 `short`，与 Pi 选择缓存档位的方式一致；
4. 模型名包含 `deepseek`：按磁盘缓存处理，不倒计时；
5. `gpt-5.6` 及以后：1800 秒；
6. 其他：300 秒。

经过中转服务的模型，实际时长取决于中转方。时长不准时用 `ttlSeconds` 覆盖，或在 `models.json` 中设置该模型的 `promptCache`；后者同时影响 Pi 的自动续缓存。

## 配置

可选文件 `~/.pi/agent/pi-cache-timer.json`。文件不存在时使用默认值；内容无效时使用默认值并在会话开始时提示一次。修改后执行 `/reload` 生效。

```json
{
  "minTokens": 50000,
  "minExtraCost": 0.2,
  "ttlSeconds": {
    "zero-cat": 0,
    "thekeyrelay/gpt-5.5": 1800
  }
}
```

| 键 | 默认值 | 说明 |
|---|---|---|
| `minTokens` | `50000` | 上下文达到该 token 数即提醒 |
| `minExtraCost` | `0.2` | 预计多付达到该美元数即提醒 |
| `ttlSeconds` | `{}` | 缓存时长覆盖，单位秒；`0` 表示不倒计时，也不因过期提醒 |
| `extensionSends` | `{}` | 其他扩展发消息前调用 `prepareSend` 时的处理方式，按扩展名配置：`"pass"` 直接发送，`"compact"` 在满足上面提醒条件时先压缩、不弹框。未列出的扩展按 `"pass"` 处理。例如 `{ "pi-trigger": "compact" }`；pi-trigger 的 `/trigger compact` 可以按会话覆盖 |

## 对其他扩展提供的服务

`globalThis[Symbol.for("pi.cache-timer.v1")]`，定义见 `src/service.ts`：

| 方法 | 说明 |
|---|---|
| `prepareSend(ctx, { source, override? })` | 在 Pi 空闲、即将发出会开始一轮的消息前调用。策略取 `override`，否则取 `extensionSends[source]`，默认 `"pass"`。`"compact"` 且缓存已失效并超过阈值时调用 `ctx.compact()`，压缩结束或失败后返回 `{ policy, compacted, reason, error? }`。不弹框，不抛错 |
| `lifetimeMs(ctx)` | 当前缓存的时长（毫秒）；未知或磁盘缓存时为 `undefined` |

扩展通过 `pi.sendMessage(..., { triggerTurn: true })` 发出的消息不经过 `input` 事件，发送前提醒拦不住，所以由发送方主动调用 `prepareSend`。

## 安装

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/pi-cache-timer
```

在 Pi 中执行 `/reload` 加载。要把倒计时显示在输入框边框上，需要同时加载 statusline-pi，并在它的 `BORDER_STATUS_SLOTS` 中登记 `cache-timer`（已默认登记）。

## 文件

| 文件 | 内容 |
|---|---|
| `src/index.ts` | 倒计时刷新、发送前提醒、先压缩再发送 |
| `src/cache.ts` | 从会话分支找出当前缓存、确定缓存时长、估算未命中与压缩费用 |
| `src/config.ts` | 读取与校验配置文件 |
| `src/service.ts` | `pi.cache-timer.v1` 服务的接口与注册 |
