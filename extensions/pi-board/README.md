# pi-board

基于计划文档的任务面板。AI 按固定格式在 `docs/board/` 里记录任务、决定和冲突，每次 write/edit 都附一句改动说明；tmux 右侧窗格实时显示这些内容，用户不用读长文档和代码，也能知道现在在做什么、还剩什么、哪里有冲突、这一轮改了什么。

设计与取舍见 [DESIGN.md](DESIGN.md)；给 AI 的格式与规则见 [skills/pi-board/SKILL.md](skills/pi-board/SKILL.md)。

## 组成

| 部分 | 说明 |
|---|---|
| 计划文档 | `docs/board/tasks.md`（T）、`decisions.md`（D）、`conflicts.md`（C），以及 AI 用 frontmatter 声明的扩展板块。每个条目是 `## <编号> <标题>` 加 `- key: value` 字段行加正文 |
| 格式校验 | 主代理写计划文档前，扩展在内存中算出写入后的内容并整体解析；本次写入新引入格式或一致性问题时拒绝调用并返回错误清单，AI 自动重写。团队成员与子代理不能写计划文档；bash 写计划文档会被拦截 |
| write/edit 覆盖 | 启用的项目里 write/edit 增加必填参数 `message`（10–120 字符，写清改了什么、为什么）与可选参数 `task`（T 编号，校验存在） |
| 改动记录 | 每次成功的 write/edit 记一条（时间、谁、文件、message、增删行数、diff），写到主仓库 `.pi/changes/<会话>.jsonl`（自动加入 `.gitignore`）。团队成员在 worktree 里的改动也写到这里，合入前标 `unmerged` |
| 面板窗格 | 主 pi 启动时在 tmux 右侧打开（宽 40%），只读 `docs/board/` 与 `.pi/changes/` |
| widget | 输入框上方的 `Board` 摘要框：进行中的任务、本轮改动数、冲突数、等你决定的数量 |
| 规则注入 | 启用的项目里向系统提示注入计划文档规则；用户发出新消息后若 AI 先改代码、没先更新计划文档，会在工具结果末尾提醒一次 |

## 启用

只在项目根目录存在 `docs/board/` 时启用，其他项目不受影响。

| 命令 | 作用 |
|---|---|
| `/board init` | 在当前项目创建 `docs/board/` 与三个空文件 |
| `/board` | 打开或关闭面板窗格 |
| `Alt+J` | 列出子代理与团队成员，选中后跳到它所在的后台窗格 |

## 面板

```
 Conflicts 2  Waiting on you 3  Doing 1  Todo 8  Decisions 32  Changes 41   project
 ✕ 1 FORMAT ISSUE · x quotes them into pi
   conflicts.md:75 C09 …
╭─ THIS TURN #14 · 22:31 · 2 files · 3 plan ──────────────╮
│ + C14  标点引擎与设计 §6 不一致                new open  │
│ ~ T12  标点改用 ct-punc                  todo → doing   │
│ ✎ stages/punct/run.py  +12 −3 ×3                        │
│   默认引擎改为 ct-punc，落实 D26 (+2 more)               │
╰─ t full view · T in Changes ────────────────────────────╯
  （当前栏目的条目）
```

- 每类一个栏目，标签上是未关闭条目数；最后一个栏目 Changes 按“用户的每一轮输入”分组列出全部改动。
- 格式问题固定在标签栏下方，所有栏目可见。
- “本轮改动”框列出最近一轮新建或改动的计划条目（状态变化写成 `todo → doing`）和改过的文件。条目变化通过倒序撤销本轮计划文档的 diff、与轮次开始时的版本逐条比较得出；撤销不了时（例如手动改过文件）退回近似模式，条目标 `≈`。
- 展开的条目显示为卡片：状态、优先级、负责人在第一行，字段按类型着色，正文按 Markdown 排版，文中的 T/D/C 编号着色。

| 键 | 作用 |
|---|---|
| `Tab` / `→`、`Shift+Tab` / `←`、`1`–`9`、点击标签 | 切换栏目 |
| `j` `k` / `↑` `↓` | 移动 |
| `Ctrl+D` `Ctrl+U` / 滚轮 | 翻动 |
| `Enter` | 展开或收起（条目卡片、改动 diff） |
| `Space` / `y` | 选中 / 把选中条目引用到 pi 输入框（`〔T12 标题〕`），不发送 |
| `x` | 把全部格式问题引用到 pi |
| `t` / `T` | 本轮改动的完整视图（每个文件的全部 message） / 在 Changes 中定位本轮 |
| `c` / `f` | 查看当前任务的全部改动 / 清除筛选 |
| `h` | 显示已关闭的条目（计划栏目）或计划文档的改动（Changes） |
| `o` | 用 nvim 打开：条目所在文件，或改动前后对比（`nvim -d`） |
| `Esc` / `q` | 清除选中或返回 / 关闭面板（`/board` 重新打开） |

## 后台窗格

配合本仓库修改过的 [pi-interactive-subagents](../pi-interactive-subagents)：tmux 下子代理与团队成员默认放进每个主 pi 一个的后台 window（`agents:<项目目录名>`，平铺，窗格标题 `sub:名字` / `team:名字`），主 window 只留 pi 和面板。在 subagent / team widget 上点击某一行（全屏模式），或按 `Alt+J` 选择，可跳到对应窗格；`prefix + l` 返回。`PI_SUBAGENT_TMUX_LAYOUT=split` 恢复原来的分屏方式。

## 安装

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/pi-board
```

要求：

- tmux（面板窗格与后台 window）；Node.js 需支持直接运行 TypeScript（type stripping，Node 22.18 及以上默认开启），面板是独立进程，以 `node src/pane/main.ts` 运行。
- 可选：nvim（`o` 键）。
- 若同时安装了 pi-tool-display，需在 `~/.pi/agent/extensions/pi-tool-display/config.json` 中把 `registerToolOverrides.edit` 与 `registerToolOverrides.write` 设为 `false`，否则两个扩展争用 write/edit。

## 限制

- 计划文档的 edit 只做逐字匹配，不复现内置 edit 的模糊匹配；对不上时拒绝并提示先重新读取。
- bash 写操作按命令文本检测，内联脚本等间接写入可能漏判。
- message 的质量代码判断不了，只检查长度。
- 冲突能否发现依赖 AI 遵守规则；代码只发现编号、引用、取代关系等结构性矛盾。
- widget 的鼠标点击只在 pi 全屏模式下可用。
