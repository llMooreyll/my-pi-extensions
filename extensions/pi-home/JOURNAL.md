# pi-home 工作日志

本文件随开发过程持续更新，记录每一步操作、与计划（PLAN.md、SESSIONS.md、VISUAL.md）不一致的地方、需要注意的事项，以及对本机环境做过的改动和撤销方法。新条目追加在对应章节末尾。

## 1. 环境改动登记（全部可逆）

| 时间 | 改动 | 撤销方法 |
|---|---|---|
| 2026-11-13 | 在 `extensions/pi-home/` 下执行 `npm install`，生成 `node_modules/`（已被 .gitignore 忽略） | 删除 `extensions/pi-home/node_modules` |
| 2026-11-13 | pi-home 运行时会创建 `~/.pi/agent/pi-home/`，其中有 `index.json`（会话索引缓存，约 8MB）；之后还会有 `config.json`、`meta.json`、`run/`、`live/` | 删除 `~/.pi/agent/pi-home/` |
| 2026-11-13 | 视觉测试时临时打开 Ghostty 窗口（标题为 `pihome-visual-*`），截图存放在 `/tmp/pihome-v*.png`；测试脚本为 `/tmp/pihome-shot.sh` | 窗口在测试结束时关闭，焦点恢复到测试前的窗口；`/tmp` 下的文件可以直接删除 |

## 2. 操作记录

### 2026-11-13

- 只读调查，没有改动：
  - `~/.pi/agent/sessions`：493 个文件，共 1.5G。assistant 的 `stopReason` 计数为 toolUse 37053、stop 1723、error 468、aborted 168。
  - 会话头为 `{"type":"session","version":3,"id","timestamp","cwd","parentSession?"}`。
  - `session_info.name`、`compaction.tokensBefore` 和 `details.{readFiles,modifiedFiles}`、`model_change.{provider,modelId}`、`thinking_level_change.thinkingLevel`、`context_edit.{targetId,replacement}` 的结构已核对。
  - toolResult 的工具名在 `message.toolName`，不在记录顶层。
- 环境：
  - Ghostty 1.4.0，配置在 `~/.config/ghostty/config`：`background-opacity=0.85`，`background-opacity-cells` 为默认值 false，即显式设了背景色的格子不透明；没有配置 `custom-shader`。
  - tmux 中 `COLORTERM=truecolor`，`TERM=tmux-256color`，`status-position bottom`，`pane_top=1`。
  - niri 26.04。tmux 里没有 `NIRI_SOCKET`，socket 文件为 `/run/user/1001/niri.wayland-1.1207.sock`。
  - 截图工具 `grim` 可用。
- 依赖：
  - npm 上有 `@earendil-works/pi-tui@1.5.2`，与本机 pi 一致。
  - 它的 `StdinBuffer` 能把 SGR 鼠标序列拆分重组；`parseColor` 和 `colorToRgb` 可以解析主题里的 `okhsl()` 等颜色写法。
- 新增 VISUAL.md：把视觉方案（四档能力、调色、画面结构、着色器暗号）固定成文档。
- 团队成员使用的模型按用户要求定为 `claude-vps/claude-sonnet-5-5:low`。
- 用户追加要求：所有 UI 文本和程序输出都用英文。设计文档和本日志仍用中文。
- 提交记录：
  - `592fe8f` 文档；
  - `191739d` 包骨架；
  - `f5a1814` 终端引擎（格子缓冲、按行比较的渲染器、输入解析、档位检测、字符层 CRT）；
  - `c6951c8` 调色、配置、路径、profile 类型；
  - `4884e27` 会话索引；
  - `e0b3067` App 运行时与外壳；
  - `bde4856` 入口和首页。
- 索引实测：494 个文件，5.5 秒解析完（流式读取加逐行 `JSON.parse`）。其中 22 行是坏行，已跳过。全部费用合计 $507.44，assistant 消息共 47396 条。缓存 JSON 约 7.7MB。
- tmux 文字截图：中文行的宽度与 tmux 的计算一致（Python `east_asian_width` 复核每行都是 158 列），没有错位。
- Ghostty 截图：
  - 第 1 次截图时窗口只有半屏宽，首页退化成单栏，效果正常。
  - 第 2 次尝试用 `maximize-column` 撑满整屏，打乱了布局，已放弃这个做法。
  - 第 3、4 次因为用 `niri close-window` 关窗失败，留下了 3 个测试窗口：Ghostty 检测到窗口内还有进程在跑，弹出确认框，窗口没有关掉。随后改为结束 pi-home 进程来关窗，残留窗口已全部关闭。
  - 期间一次 `pkill -f` 的匹配模式包含了当前 shell 的命令行，把执行它的 bash 也杀掉了（退出码 143），没有其他影响。之后改为按 PID 逐个结束进程。
  - 第 5 次用 `--font-size=7` 得到约 190 列的宽布局，CRT 效果、暗角、配色都正常。发现大字 `PI.HOME` 宽度超出左栏，已加入按宽度缩放（每个像素占 2 列或 1 列）。
- App 增加了 SIGTERM/SIGHUP 处理：进程被结束时先恢复终端状态再退出。
- 任务拆分（简报在 `docs/tasks/`）：
  - 成员 A：图表库、聚合计算、分析标签页、Wrapped 和 HTML 报告；
  - 成员 B：资源发现、profile 工具函数、参数生成、profile 编辑器、预设页、配套扩展；
  - 主代理：会话页、会话详情、着色器、zsh 脚本、集成、视觉验收和 README。

## 3. 与计划不一致的地方

| 编号 | 计划原文 | 实际做法 | 原因 |
|---|---|---|---|
| D1 | PLAN §4.1：界面使用 pi-tui 的 `TuiAltScreen`、`SelectList` 等组件 | 自写基于格子的画面缓冲和渲染器，pi-tui 只用于终端输入（`ProcessTerminal`、`matchesKey`）、宽度计算和颜色解析 | CRT 效果（暗角、渐变外壳、开关机动画、着色器暗号）需要按格子控制前景色和背景色并做后处理；pi-tui 组件按行输出 ANSI 字符串，无法做这种后处理 |

| D2 | PLAN §4.3：首次建立索引放到后台 worker 线程（S4） | 不用 worker，直接在主线程异步解析，每个文件之间让出事件循环 | 实测全量解析只要 5.5 秒；按文件逐个 await 时界面仍能刷新，增加 worker 不划算 |
| D3 | SESSIONS §5.3「缓存预热账本」要对比预热花费和节省的钱 | 只显示预热花费和次数，不估算节省 | 会话记录里没有模型单价，估算节省需要编造价格，这一项需要用户另行决定 |
| D4 | VISUAL §6：T3 着色器档靠检测画面中的暗号像素来开关 | 环境变量 `PI_HOME_CRT_SHADER=1` 由 `pi-home --crt-window` 设置，pi-home 据此进入 T3 并绘制暗号 | pi-home 无法得知 Ghostty 是否加载了着色器；暗号只在 T3 下绘制，T1 的 256 色量化会破坏暗号颜色 |

## 4. 注意事项

- 会话文件中有行包含不合法的 UTF-16 代理对转义，`jq` 读到会中断。索引器必须逐行解析并跳过坏行。
- 仓库工作区里有与本任务无关的未提交改动（pi-remote、pi-session-view），还有未跟踪的 `extensions/pi-input-complete/` 和 `.playwright-mcp/`。提交时只 `git add extensions/pi-home`。
