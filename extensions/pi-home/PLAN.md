# pi-home 方案

pi 的首页控制台。在终端输入不带参数的 `pi` 时先进入首页：选择项目和会话，为单个会话设置扩展、skill、AGENTS.md、系统提示词、模型和工具，查看会话统计，然后带着这些设置启动 pi。

状态：方案阶段，未实现。基线版本：pi 1.5.2，Node v26.13.1。

## 1. 总体结构（方案 C：启动器 + 配套扩展）

```text
zsh 函数 pi（只拦截无参数调用）
   │
   ▼
pi-home 启动器（独立 Node 程序，pi-tui 界面）
   ├── 会话索引与统计（读取 ~/.pi/agent/sessions/**.jsonl）
   ├── 会话设置（profile）编辑
   └── 生成启动参数 → 写入 launch 文件 → 退出
   │
   ▼
zsh 函数读取 launch 文件 → command pi <参数>
   │
   ▼
pi 进程 + pi-home 配套扩展
   ├── 读取 --home-profile，把 profile 写进会话（appendEntry）
   ├── 应用运行中可改的设置（AGENTS.md 选择等）
   └── 写入运行状态文件（供首页显示「运行中」）
   │
   ▼ pi 退出
zsh 函数回到 pi-home（可配置）
```

分成两部分的原因：
- 扩展、skill、系统提示词、工具集等多数设置只能在 pi 启动时通过 CLI 参数决定，进程内的扩展改不了，所以需要启动器。
- CLI 参数不会写进会话文件，在 pi 内 `/resume` 或下次重新打开时会丢失，所以需要扩展把设置存进会话。

## 2. 单会话可设置项

「层」一列表示由谁生效：`CLI` 是启动器拼参数，`EXT` 是配套扩展在运行中应用。

| 分组 | 设置 | 层 | 对应参数或接口 | 备注 |
|---|---|---|---|---|
| 会话 | 新建 / 继续最近 / 打开指定 / 分叉 | CLI | （无参数）/ `-c` / `--session` / `--fork` | |
| | 会话名 | CLI | `-n` | |
| | 不保存 | CLI | `--no-session` | |
| | 指定 ID | CLI | `--session-id` | |
| 模型 | 模型、思考等级 | CLI | `--model provider/id`、`--thinking` | 只用于新会话；打开已有会话时以会话记录为准（待验证 V4） |
| | Ctrl+P 切换范围 | CLI | `--models` | |
| 扩展 | 默认 / 排除部分 / 只用指定 | CLI | 默认不加参数；后两者用 `-ne` + 逐个 `-e <path>` | pi 没有单独禁用某个扩展的参数 |
| | MCP | CLI | `--no-mcp` | |
| | 内置扩展 | CLI | `-e builtin:mcp`、`builtin:codemode` 等 | `-ne` 会连带关掉内置扩展 |
| Skill | 默认 / 只用指定 / 全关 | CLI | `-ns` + `--skill <path>` | |
| | 只在提示词里隐藏部分 skill | EXT | `before_agent_start` 修改 `systemPromptOptions.skills` | `/skill:` 命令仍可用 |
| 提示词模板 | 默认 / 只用指定 / 全关 | CLI | `-np` + `--prompt-template` | |
| AGENTS.md | 默认 / 全关 | CLI | 默认 / `-nc` | |
| | 挑选部分文件、追加额外文件 | EXT | `before_agent_start` 过滤或追加 `systemPromptOptions.contextFiles` | 每次运行前重新生成提示词，见 §5.3 |
| 系统提示词 | 替换 | CLI | `--system-prompt <file>` | |
| | 追加（可多条） | CLI | `--append-system-prompt <file>` | |
| 工具 | 白名单 / 增减 / 排除 | CLI | `--tools`、`--tools +a,-b`、`-xt` | |
| | 关闭内置工具 / 全关 | CLI | `-nbt` / `-nt` | |
| 其他 | 项目信任 | CLI | `-a` / `-na` | |
| | 离线 | CLI | `--offline` | |
| | 界面模式、主题 | CLI | `--tui-mode`、`--use-theme` | |
| | 扩展自定义参数 | CLI | 例如 `--plan` | 从 `pi --help` 读取 |

按项目生效、不按会话生效的设置（`.pi/settings.json`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`、`.pi/extensions`）只在首页中显示和跳转编辑，不纳入 profile。

依据：`/usr/lib/node_modules/pi/packages/coding-agent/docs/cli.md`、`settings.md`、`configuration.md`、`extensions.md`（`before_agent_start` 第 615–661 行）。

## 3. 入口与进程交接

### 3.1 zsh 函数

```zsh
pi() {
  if (( $# == 0 )) && [[ -t 0 && -t 1 ]]; then
    pi-home-loop          # 首页循环，见 3.2
  else
    command pi "$@"
  fi
}
```

- 带参数的调用全部直接执行原来的 pi。pi-interactive-subagents 用 `pi --session …` 启动子代理（`pi-interactive-subagents/pi-extension/subagents/index.ts` 第 1090、1836 行）；pi-remote 用 `zsh -lic 'pi --approve|--no-approve [--session …]'`（`pi-remote/packages/hostd/src/spawner.ts` 第 52–56 行）。两者都带参数，不受影响。
- 想跳过首页时，执行 `command pi` 或带任意参数即可。

### 3.2 launch 文件交接

启动器不以子进程方式运行 pi，而是把要执行的命令写进文件后退出，由 zsh 执行：
- pi 是 shell 的直接子进程，作业控制、信号和终端状态与直接运行 pi 时一致；
- pi 运行期间启动器不占内存。

```zsh
pi-home-loop() {
  local f="${XDG_RUNTIME_DIR:-/tmp}/pi-home.$$"
  while true; do
    command pi-home --launch-file "$f" || break   # 用户在首页按 q 时返回非 0
    [[ -s "$f" ]] || break
    local -a spec=("${(@0)$(<"$f")}")             # NUL 分隔：第 1 项为 cwd，其余为参数
    rm -f "$f"
    ( cd "${spec[1]}" && command pi "${spec[@]:1}" )
    [[ "$(command pi-home --config returnToHome)" == true ]] || break
  done
}
```

脚本会随 `package.json` 的 `bin` 提供，并附带安装说明，用户自行写入 `~/.zshrc`。

## 4. 启动器设计

### 4.1 技术选型

- 运行方式：与 pi-remote hostd 一致，`node src/main.ts` 直接运行 TypeScript（Node 26 类型剥离），不需要构建。
- 界面：`@earendil-works/pi-tui`，使用 `ProcessTerminal` + `TuiAltScreen`，组件用 `SelectList`、`SettingsList`、`Input`、`Markdown`、`Box`、`Container`、`fuzzyFilter`。外观与 pi 保持一致。
- 主题：读取 `~/.pi/agent/settings.json` 的 `theme` 和 `~/.pi/agent/themes/<name>.json`（当前为 `noctalia`），映射到界面颜色。
- 依赖版本与本机 pi 对齐（`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 用 1.5.x）。只用到 `SessionManager` 的路径常量和 `getAgentDir()`，会话文件由自己的索引器读取，不调用 `SessionManager.listAll()`：它会抽取全部消息文本，493 个文件共 1.4G，太慢。

### 4.2 页面

顶部是标签栏 `首页 | 会话 | 分析 | 预设`，用 `1`–`4` 或 `Tab` 切换。「会话」和「分析」两个标签页的完整设计见 [SESSIONS.md](SESSIONS.md)。

| 页面 | 内容 | 主要操作 |
|---|---|---|
| 首页（标签） | 左栏为最近项目（置顶在前，按最近活动排序，显示会话数和近 7 天费用）；右栏为所选项目最近的会话；顶部为全局搜索 | `Enter` 用项目默认 profile 新建会话；`c` 继续最近会话；`o` 输入路径打开新目录（带路径补全）；`p` 置顶；`/` 搜索；`q` 退出 |
| 会话（标签） | 会话管理：全量列表、筛选、全文搜索、详情栏、批量操作、整理助手、标签与收藏；单会话详情页 | 见 SESSIONS.md §4、§5.10 |
| 分析（标签） | 子页：总览、时间、花费、模型、工具、文件、项目、行为、报告；热力图、柱状图、braille 曲线、treemap、华夫图等，图表可下钻 | 见 SESSIONS.md §5、§6 |
| 预设（标签） | 命名 profile 列表，例如「只读调研」「不加载扩展」 | 新建、编辑、删除 |
| 会话设置（子页面） | 从首页或会话页进入；按 §2 分组编辑 profile；每项标注「启动时生效」或「运行中生效」；底部实时预览最终命令行 | 保存到本会话、存为项目默认、存为预设、从预设套用 |

会话操作的实现：
- 重命名：通过 `SessionManager` 打开会话后追加 `session_info` 记录，与 `/name` 一致。
- 删除：优先用 `trash` 命令，与 pi 内 `/resume` 删除的行为一致。
- 导出 HTML：调用 `pi --export <file>`。
- 分叉：启动时传 `--fork`。

### 4.3 会话索引

下面是 L1 会话摘要。L2 事件明细和 L3 预聚合供分析页使用，见 SESSIONS.md §3。

数据源是 `~/.pi/agent/sessions/--<cwd>--/*.jsonl`；如果 `settings.json` 设置了 `sessionDir`，同时扫描该目录。

每个会话的索引记录：

| 字段 | 来源 |
|---|---|
| `id`、`cwd`、`created`、`parentSession` | 第一行 `type: "session"` |
| `name` | 最后一条 `session_info` |
| `lastActivity` | 最后一条记录的 `timestamp` |
| `firstUserMessage` | 第一条 `role: "user"` 消息，截断到 200 字 |
| `userTurns`、`assistantMessages` | 消息计数 |
| `tokens.{input,output,cacheRead,cacheWrite}`、`cost` | 累加 assistant 消息的 `usage`；工具结果的 `usage` 单独计为 `nestedCost` |
| `models` | 以 `provider/model` 为键：调用次数、tokens、费用 |
| `tools` | 以工具名为键的调用次数；`errors` 为 `stopReason` 等于 `error` 或 `aborted` 的次数 |
| `filesTouched` | `edit`、`write` 调用参数中的 `path`，最多保留 50 个 |
| `compactions`、`branches` | `compaction` 记录数；子节点数大于 1 的节点数 |
| `activeMinutes` | 相邻记录间隔小于 5 分钟的部分累加 |
| `profile` | 最后一条 `customType: "pi-home/profile"` 的 `custom` 记录 |

字段定义依据：`docs/session-format.md`、`docs/message-types.md`（`Usage` 第 69–90 行）。

增量更新：
- 缓存文件为 `~/.pi/agent/pi-home/index.json`，以文件路径为键，记录 `size`、`mtimeMs` 和上表的统计。启动时先显示缓存，再在后台逐个检查文件，只重新解析有变化的文件，用 `readline` 流式读取，完成后原子写回。
- 首次建立索引需要读完 1.4G，界面显示进度，可以随时进入其他页面。
- 逐行 `JSON.parse`，坏行跳过并计数。本机实测有行包含不合法的 UTF-16 代理对转义，`jq` 遇到会中断。
- 会话数是几百个，JSON 足够用；事件明细增长到数十万条时换成 `node:sqlite`。

全文搜索：用 `rg --json` 直接扫描会话目录，不把正文存进索引，见 SESSIONS.md §4。

### 4.4 项目列表

- 项目由索引中的 `cwd` 汇总得到，逻辑与 `pi-remote/packages/hostd/src/sessions-index.ts` 的 `listProjects()` 相同，可以直接复用。
- 目录已不存在的项目标灰；打开时提示 pi 会询问继续或分叉（见 `docs/sessions.md`）。
- 置顶项目和项目默认 profile 存在 `config.json`。

### 4.5 扩展与 skill 清单

设置页需要列出可选的扩展和 skill，生成规则与 pi 一致：

| 来源 | 位置 |
|---|---|
| 全局包 | `~/.pi/agent/settings.json` 的 `packages`：`npm:` → `~/.pi/agent/npm/node_modules/<name>`，`git:` → `~/.pi/agent/git/...`，本地路径相对 agent 目录解析；扩展入口读包内 `package.json` 的 `pi.extensions`，没有时按约定目录查找 |
| 全局 extensions | `settings.json` 的 `extensions`，以及 `~/.pi/agent/extensions/*`。需要判断目录里是否真有扩展入口，例如 `~/.pi/agent/extensions/pi-tool-display` 里只有 `config.json` |
| 内置 | `builtin:mcp`、`builtin:llama.cpp`、`builtin:codemode`、`builtin:tool-search` |
| 项目 | `<cwd>/.pi/settings.json`、`<cwd>/.pi/extensions`，仅在项目已信任时读取 |
| skill | 同上各处的 `skills` 字段和 `skills/` 目录；条目前的 `+`、`-` 表示默认启用状态 |

规则依据 `docs/packages.md`、`docs/settings.md` 的 Resources 一节。用户选择「排除扩展 X」时，启动器生成 `-ne` 并对其余每个扩展加 `-e <入口>`，内置扩展用 `-e builtin:<name>`。

模型清单：执行一次 `pi --offline --list-models` 并缓存，设置页里手动刷新。

## 5. 配套扩展设计（同一包内的 `extension/index.ts`）

### 5.1 profile 的传入与保存

- `pi.registerFlag("home-profile", { type: "string" })`：启动器传入 profile 文件路径，路径为 `~/.pi/agent/pi-home/run/<随机>.json`，用完即删。
- `session_start`：
  1. 读取 flag 指向的文件；
  2. 与会话中最后一条 `pi-home/profile` 记录比较，不同时调用 `pi.appendEntry("pi-home/profile", profile)`；
  3. 没有 flag 时（例如在 pi 内 `/resume` 进入其他会话），从当前会话记录中读取 profile。
- pi 在会话产生第一条对话消息前不会写文件，之前的记录先留在内存，之后一并写入（`coding-agent/dist/core/session-manager.js` 第 795–814 行）。新会话在第一条消息发出前退出时不会留下文件，profile 也随之丢弃，这是预期行为。

### 5.2 加载方式

- profile 没有用到 `-ne` 时，配套扩展通过 `settings.json` 的 `packages` 正常加载，安装时需要加入。
- 用到 `-ne` 时，启动器额外加 `-e <配套扩展入口>`。只在这种情况下加，避免重复加载。

### 5.3 运行中应用的设置

- AGENTS.md 挑选：在 `before_agent_start` 中按 profile 过滤 `event.systemPromptOptions.contextFiles`，并把额外文件以 `{ path, content }` 追加进去。pi 在每次运行前用处理后的选项重新生成提示词（`agent-session.js` 第 1544–1590 行），`contextFiles` 会拼成 `project_context` 段（`system-prompt.js` 第 98–99 行）。
- 在提示词中隐藏部分 skill：过滤 `systemPromptOptions.skills`。
- 当前会话的 profile 与本进程启动参数不一致时（例如在 pi 内 `/resume` 到另一个会话），`ctx.ui.notify` 提示，并提供 `/home-relaunch` 命令：把该会话的启动命令写入 launch 文件后执行 `ctx.shutdown()`，由 zsh 循环用正确参数重新打开。需要 zsh 循环支持「launch 文件已存在时跳过首页」，放在 M4。

### 5.4 运行状态

- `session_start` 时写入 `~/.pi/agent/pi-home/live/<pid>.json`，内容为 `{ pid, sessionFile, cwd, startedAt }`；`session_shutdown` 时删除。
- 首页读取时用 `process.kill(pid, 0)` 检查进程是否还在，清理残留文件。
- 打开一个正在运行的会话时给出提示，避免两个进程写同一个会话文件。

## 6. 数据与配置

```text
~/.pi/agent/pi-home/
├── config.json      # piBinary, returnToHome, pinnedProjects, projectDefaults{cwd: profile}, presets{name: profile}
├── index.json       # 会话索引缓存（L1 + L2，见 SESSIONS.md §3）
├── meta.json        # 会话标签、收藏、备注
├── prompts/         # 用户在首页编写的系统提示词片段（*.md），profile 按路径引用
├── run/             # 一次性 profile 文件
└── live/            # 运行状态
```

profile 结构（v1）：

```json
{
  "version": 1,
  "model": "zero-cat/deepseek-v4.1-flash-1017",
  "thinking": "high",
  "modelsScope": ["zero-cat/*"],
  "extensions": { "mode": "default", "exclude": [], "only": [] },
  "mcp": true,
  "skills": { "mode": "default", "only": [], "hideInPrompt": [] },
  "promptTemplates": { "mode": "default", "only": [] },
  "contextFiles": { "mode": "default", "include": [], "extra": [] },
  "systemPrompt": { "replace": null, "append": [] },
  "tools": { "allow": null, "add": ["codemode"], "remove": [], "exclude": [] },
  "trust": "ask",
  "offline": false,
  "extensionFlags": {}
}
```

- `mode` 的取值：`extensions` 为 `default | exclude | only`；`skills` 和 `promptTemplates` 为 `default | only | none`；`contextFiles` 为 `default | none | pick`。
- 优先级：会话自身的 profile > 项目默认 > 全局默认（空 profile 等于 pi 原生行为）。

参数生成写在 `src/launch/args.ts`，是纯函数 `profile → string[]`，便于审查。设置页底部预览的就是它的输出。

## 7. 目录规划

```text
extensions/pi-home/
├── PLAN.md
├── README.md
├── package.json            # bin: { "pi-home": "src/main.ts" }; pi.extensions: ["./extension/index.ts"]
├── shell/pi-home.zsh       # §3 的 zsh 函数
├── src/                    # 启动器
│   ├── main.ts             # 参数解析（--launch-file、--config）、启动界面
│   ├── theme.ts
│   ├── config.ts           # config.json 读写
│   ├── index/
│   │   ├── indexer.ts      # 扫描、增量解析、缓存
│   │   ├── events.ts       # L2 事件明细与文本派生统计
│   │   ├── aggregate.ts    # L3 预聚合
│   │   ├── search.ts       # rg 全文搜索
│   │   └── meta.ts         # 标签、收藏、备注（meta.json）
│   ├── resources/
│   │   ├── extensions.ts   # §4.5 扩展清单
│   │   ├── skills.ts
│   │   └── context-files.ts # 按 pi 规则列出某个 cwd 会加载的 AGENTS.md
│   ├── launch/
│   │   ├── args.ts         # profile → 参数
│   │   └── launch-file.ts
│   └── ui/
│       ├── home.ts
│       ├── sessions.ts
│       ├── tabs.ts         # 标签栏
│       ├── profile-editor.ts
│       ├── session-detail.ts
│       ├── presets.ts
│       ├── analytics/      # 总览、时间、花费、模型、工具、文件、项目、行为、报告子页
│       └── charts/         # 图表组件库（SESSIONS.md §6）
├── extension/
│   └── index.ts            # §5 配套扩展
└── shared/
    └── profile.ts          # profile 类型、校验、合并
```

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | 运行 §9 的验证项，结论写回本文件 | 每项有结论 |
| M1 | 索引器、首页、会话列表，支持新建、继续、打开，加上 zsh 循环；暂不支持 profile | 无参数 `pi` 进入首页，选会话后进入 pi，退出后回到首页；带参数的 `pi` 行为不变；子代理和 pi-remote 正常 |
| M2 | profile 编辑器、参数生成、配套扩展（flag、appendEntry、AGENTS.md 挑选）、项目默认、预设 | 为会话关闭某个扩展、换系统提示词后启动，`/session` 和实际行为与设置一致；重新打开该会话时设置还在 |
| M3 | SESSIONS.md 批次 A：会话标签页基础功能、总览和首批图表、单会话水位线 | 汇总费用与 pi 内 `/session` 显示的费用一致（抽查 3 个会话）；图表下钻得到的会话列表与筛选条件一致 |
| M4 | 运行状态、`/home-relaunch`、导出 | 逐项可用 |
| M5 | SESSIONS.md 批次 B：其余图表、全文搜索、整理助手、标签与收藏 | 逐项可用 |
| M6 | SESSIONS.md 批次 C：Pi Wrapped、HTML 报告 | 逐项可用 |

## 9. 验证结果（2026-11-13 实测，详见 JOURNAL）

| 编号 | 问题 | 结论 | 对设计的影响 |
|---|---|---|---|
| V1 | `-ne` 是否同时停用包里提供的 skill | **不会**。加 `-ne` 后 14 个 skill 仍然全部在（包括 pi-telegram 包带的 4 个）；工具数从 34 个降到 4 个 | 「排除扩展」不影响 skill；要控制 skill，请用 skill 分组的设置 |
| V2 | `-e <目录>` 是否按包加载 | 文档 `docs/cli.md` 写明 `-e` 接受文件或目录；资源发现按包目录处理 | `-e` 直接传包目录 |
| V3 | 在 `before_agent_start` 中修改 `contextFiles` 和 `skills` 是否生效 | **生效**。发给 provider 的请求里 AGENTS.md 消失，额外文件的标记出现，被隐藏的 `office` skill 消失 | §5.3 的方案成立 |
| V4 | `--session` 和 `--model` 同时使用时 | **`--model` 优先**，打开的会话会切换到新模型 | 打开已有会话时不传 `--model`（profileArgs 只在新建会话时传） |
| V5 | 打开已有会话时启用哪些工具 | 沿用会话记录里的工具设置（之前用 `--tools read` 建的会话，不带参数再打开时仍然只有 `read`） | 打开已有会话时不需要再传工具参数 |
| V6 | zsh `${(@0)$(<file)}` 能否完整解析参数 | 空格、换行、空字符串都完整保留；只有最后一个参数末尾的换行会丢 | launch 文件格式不变 |
| V7 | 退出界面后终端状态是否正常 | 在 tmux 中测试，选中会话后退出码为 0，launch 文件写入正确；终端恢复的顺序已按 review 修正（先清掉剩余输入，再恢复终端）。**还没有实际验证退出后紧接着运行 pi 的显示是否正常** | — |
