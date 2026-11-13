# pi-home 工作日志

## 0. 当前状态（2026-11-13 收尾）

按用户要求加快进度，在这里收尾。所有代码都已提交到 `main`；`npx tsc -p tsconfig.json` 没有报错。

### 已完成

| 模块 | 内容 | 主要文件 |
|---|---|---|
| 终端引擎 | 格子缓冲、按行比较的 ANSI 渲染、鼠标和按键、四档能力检测、字符层 CRT（暗角、伪扫描线、闪烁、开关机动画） | `src/term/*` |
| 外观 | 从主题取荧光色和调色板、外壳、标题栏、标签栏、状态行、像素大字 | `src/theme.ts`、`src/ui/chrome.ts`、`src/ui/bigtext.ts` |
| 索引 | 逐行流式解析、增量缓存、筛选、项目汇总、标签/收藏/备注、rg 全文搜索、会话操作 | `src/index/*` |
| 首页 | 项目、最近会话、当天和本周指标、新建/继续/打开路径/置顶 | `src/ui/pages/home.ts` |
| 会话页 | 列表、筛选、下钻、全文搜索、整理助手、批量操作、详情栏 | `src/ui/pages/sessions.ts` |
| 会话详情 | 上下文水位、累计花费、轮次甘特图、工具 DNA、工具/模型/文件、分支树 | `src/ui/pages/session-detail.ts`、`src/index/session-tree.ts` |
| 分析 | 8 个子页约 50 张图、Wrapped 卡片、自包含的 HTML 报告 | `src/ui/charts/*`、`src/index/aggregate.ts`、`src/ui/pages/analytics*`、`src/ui/pages/wrapped.ts`、`src/report/html.ts` |
| Profile | 资源发现、生成启动参数、profile 编辑器（含命令预览）、预设页、项目默认和全局默认 | `src/resources/*`、`src/launch/*`、`shared/profile.ts`、`src/ui/pages/profile-*.ts`、`presets.ts` |
| 配套扩展 | `--home-profile`、`appendEntry`、挑选/追加 contextFiles、隐藏 skill、运行状态文件、`/home-profile` | `extension/index.ts` |
| 入口 | zsh 函数 `pi`、启动循环 `pi-home-loop`、`pi-home --crt-window` | `shell/pi-home.zsh`、`src/main.ts` |
| T3 着色器 | Ghostty CRT：弯曲、扫描线、辉光、暗角、色差、噪点；靠暗号行开关 | `shaders/crt.glsl` |

### 未完成 / 已知问题

| 项目 | 状态 | 说明 |
|---|---|---|
| 安装 | 未做 | 没有改动 `~/.zshrc`，需要用户自己加一行 `source …/shell/pi-home.zsh`，见 README |
| `/home-relaunch`（PLAN §5.3，M4） | 未做 | 在 pi 里 `/resume` 到另一个 profile 不同的会话时，扩展只弹出提示，不会按正确参数重新启动 |
| 首页直接改 profile 后启动、配套扩展在运行中生效 | 部分验证 | V3 用探针确认了 provider 请求的内容；还没有通过完整的「pi-home → pi 交互界面」流程手动走一遍 |
| V7：退出界面后紧接着运行 pi | 未验证 | 需要在真实终端里手动确认 |
| Review 剩余项 | 未修 | #4 运行 spawnSync 期间收到 SIGINT；#5 单个子目录读不了时整个刷新失败；#7 配置文件损坏时直接用默认值覆盖，没有先备份；#8 多个 pi-home 窗口同时写配置会互相覆盖；#11 没有 `XDG_RUNTIME_DIR` 时 launch 文件放在 `/tmp`，文件名可预测；#14 最后一个参数末尾的换行会丢；#18 进程号被复用时会把别的进程误判为运行中；#22 部分计算每帧都重做 |
| 视觉复查 | 部分 | 用 Ghostty 截图看过首页、分析页的总览/时间/花费/模型，以及 T3 着色器；会话详情、Wrapped、HTML 报告、预设页和编辑器只看了 tmux 文字截图 |
| 缓存预热「节省」估算（SESSIONS §5.3） | 不做 | 没有单价数据，见 D3 |
| T3 档在 tmux 里使用 | 不支持 | 着色器只通过 `--crt-window` 加载；tmux 分屏时效果会作用到整个窗口 |

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

### 2026-11-13（续）团队协作、验证与收尾

- 团队成员（模型 `claude-vps/claude-sonnet-5-5:low`）：
  - `ana`：简报 A1–A5（图表库、聚合计算、分析页、Wrapped 和 HTML 报告、视觉修正）；
  - `prof`：简报 B1–B6（资源发现、profile、启动参数、编辑器、预设、配套扩展）；
  - `det`：简报 C1–C3（命令预览、分支树、会话详情）、D（只读代码审查，22 条发现）、E（修复其中属于自己负责文件的部分）。
- 集成方式：`team_integrate` 在 `registry.ts` 上冲突，改为主代理逐个 `git cherry-pick` 成员的提交，手动解决 `registry.ts` 冲突。成员分支的基点 `pi-team snapshot` 提交没有 cherry-pick，因为它是建 worktree 时对工作区的快照，里面有与本任务无关的改动。成员的 worktree 和分支保留在 `~/.pi/agent/team/worktrees/…`，其中的提交都已进入 `main`，可以用 `git worktree remove` 加 `git branch -D` 清理。
- 给成员的决定（成员请示后由主代理决定）：
  - 趋势箭头用 `↑↓`，标记用 `↓`（`▲▼` 不在字符白名单里）；
  - 包的安装位置和 trust.json 的格式以 pi 的 `package-manager.js` 和 `trust-manager.js` 为准；
  - 包的过滤对象（filter）暂不实现；
  - `--home-profile` 只在 `buildArgs` 里拼接：配套扩展没有默认加载时自动补 `-e`；
  - `ThinkingLevel` 增加 `max`；
  - 预算比例 = 已花 / 预算；模型切换的起点取切换前一刻正在用的模型；缺失的思考等级记为 `unknown`。
- 成员越权一次：`prof` 在允许的 load test 之外又运行了一次 `pi --help`（不调用模型，没有副作用），已自行报告。
- 着色器调试：
  - 第一次运行时暗号检测不到。原因是 Ghostty 1.4 交给着色器的是线性色彩空间的颜色，写回时再编码成 sRGB；用 `pow(x, 2.2)` 近似换算会出错，因为低亮度值落在 sRGB 曲线的线性段。改用精确的 sRGB EOTF 后检测正常。
  - 暗号从「左上角 2 格」改为「整个第一行」，见 D5。
  - T3 档关闭字符层暗角，避免和着色器的暗角叠加后看不清状态行。
- 截图方式改进：
  - 用户在使用电脑，`grim` 截全屏时截到了用户切换过去的窗口。改用 `niri msg action screenshot-window --id`，不抢焦点。这个命令同时会写剪贴板和 `~/Pictures/Screenshots`，所以事先保存文字剪贴板、事后恢复，截图文件移到 `/tmp`。
  - 测试窗口内用独立的 tmux socket（`-L phvis -f /dev/null`）运行 pi-home，再用 `tmux send-keys` 发按键，不需要窗口焦点。脚本：`/tmp/pihome-shot{,2,3}.sh`。
- 运行时验证：用临时 `--session-dir /tmp/ph-verify/...` 跑 pi，加载探针扩展 `/tmp/ph-verify/probe.ts`。探针在 `before_provider_request` 记下请求内容后直接退出，不真正调用模型。结果见 PLAN §9。
  - 发现用户默认 provider **zero-cat 额度已用完**（403 `insufficient_user_quota`）。唯一一次真实调用因此失败，但会话文件已经写入，不影响 V4/V5 的结论。
  - 临时文件都在 `/tmp/ph-verify/`，没有写进 `~/.pi/agent/sessions`。
- 代码审查（det，任务 D）：
  - 主代理修复了 #1（输入和渲染加异常保护，`uncaughtException`/`exit` 时恢复终端）、#2（恢复终端后不再渲染）、#3（先清掉剩余输入再恢复终端）、#9（会话在运行中时拒绝重命名）、#12（删除操作只接受 `y` 确认）、#16（打开运行中会话的确认统一放到 `launchTarget`）、#19（列表行点击完全失效：滚轮区域盖住了点击区域）。
  - det 修复了 #6、#10、#13、#15、#17、#20、#21。
  - 其余见第 0 节。
- 端到端（tmux 160×46）：首页按 Enter，退出码 0，launch 文件内容为 `cwd` 且没有其他参数（新建会话）；会话详情页、预设页可以正常打开。

### 2026-11-13（续）用户反馈修复

- **退出后 shell 键盘失灵，出现 `execute:`，Ctrl+C 无效**：
  - 根因：pi-tui 的 `terminal.start()` 会立即推入 kitty 键盘标志（flags 7），而当时 pi-home 还在主屏；kitty 协议给主屏和备用屏各维护一个标志栈。review #3 的修复把 `drainInput`（它会弹出标志）挪到了离开备用屏之前，弹出落在备用屏的栈上，主屏的 flags 7 一直留着。回到 zsh 后，按键松开会发出 `ESC[13;1:3u`；vi 模式把 `ESC` 当成进入命令模式，`:` 触发 execute-named-cmd。tmux 不转发 kitty 协议，所以 tmux 里不会出现。
  - 修复：在 `terminal.start()` 之前就进入备用屏，`restoreTerminal()` 里先 `stop()` 再离开备用屏，保证推入和弹出都在备用屏上。
  - 验证：在真实的 Ghostty 窗口里退出后，向终端查询 `ESC[?u`。修复前返回 `?7u`，修复后返回 `?0u`。对照时临时换回了 HEAD 版的 `app.ts`，测完已恢复。
- **按键统一**：`App.handleKey` 里把 h/j/k/l 映射成方向键；当前页面或弹窗在输入文字时（`captureText`）不映射。原来占用这几个字母的功能改到别的键：
  - Behaviour 页的子代理树滚动：j/k → J/K；
  - Wrapped 子页的 HTML 报告：h/H → w/W；
  - 编辑器的「加载预设」：l → L。
  - 各页面的按键提示同步修改。
- **会话页布局**：
  - 时间统一为 `now / Nm ago / Nh ago / Nd ago`，不再出现 yesterday 和日期；
  - 右侧详情栏收窄到 36–52 列；
  - 列表行里，项目名截到 12 列，模型列截到 14 列，行宽不足 110 时隐藏模型列；
  - 160 列宽时，标题从约 25 列增加到约 70 列。
- **会话页详情栏的标题**：
  - 改为固定高度的多行块，行数只由面板高度决定，切换会话时布局不跳动；标题不足行数时留空。
  - 最多 5 行，最少 3 行。只有在 11 个字段放不下时才少于 3 行。
  - 在不少于 3 行的前提下，取不会让 CONTEXT_LEVEL 和 MODELS 消失的最大行数（以只占 1 行时能显示的区块为准）。
  - MODELS 区块原来要求至少空出 3 行，现在只要 2 行（标题加一行数据）。
  - 详情栏宽度改为 50–56 列，TURNS、TOKENS、ERRORS 不再被截断。
  - 验证（tmux，160 列）：
    - 46 行：标题 5 行，字段、CONTEXT、MODELS、FILES 全部显示；
    - 40 行：标题 3 行，字段、CONTEXT、MODELS 全部显示；
    - 36 行：标题 3 行，字段、CONTEXT 显示；
    - 30 行：标题 3 行，全部字段显示；
    - 上面 4 种高度下，显示的区块都和标题只占 1 行时相同。

## 3. 与计划不一致的地方

| 编号 | 计划原文 | 实际做法 | 原因 |
|---|---|---|---|
| D1 | PLAN §4.1：界面使用 pi-tui 的 `TuiAltScreen`、`SelectList` 等组件 | 自写基于格子的画面缓冲和渲染器，pi-tui 只用于终端输入（`ProcessTerminal`、`matchesKey`）、宽度计算和颜色解析 | CRT 效果（暗角、渐变外壳、开关机动画、着色器暗号）需要按格子控制前景色和背景色并做后处理；pi-tui 组件按行输出 ANSI 字符串，无法做这种后处理 |

| D2 | PLAN §4.3：首次建立索引放到后台 worker 线程（S4） | 不用 worker，直接在主线程异步解析，每个文件之间让出事件循环 | 实测全量解析只要 5.5 秒；按文件逐个 await 时界面仍能刷新，增加 worker 不划算 |
| D3 | SESSIONS §5.3「缓存预热账本」要对比预热花费和节省的钱 | 只显示预热花费和次数，不估算节省 | 会话记录里没有模型单价，估算节省需要编造价格，这一项需要用户另行决定 |
| D4 | VISUAL §6：T3 着色器档靠检测画面中的暗号像素来开关 | 环境变量 `PI_HOME_CRT_SHADER=1` 由 `pi-home --crt-window` 设置，pi-home 据此进入 T3 并绘制暗号 | pi-home 无法得知 Ghostty 是否加载了着色器；暗号只在 T3 下绘制，T1 的 256 色量化会破坏暗号颜色 |

| D5 | VISUAL §6：暗号是左上角 2 个格子 | T3 档整个第一行涂成暗号色；着色器在 50% 和 30% 宽度处、上下两端 10% 的范围内各取 12 个点 | 格子位置受窗口内边距和 tmux 布局影响；整行只需要沿纵向找，每个像素的采样次数更少 |
| D6 | PLAN §5.2：用到 `-ne` 时才额外加 `-e` 加载配套扩展 | 只要需要传 `--home-profile`，而配套扩展又不在默认加载的列表里，就补 `-e` | pi 遇到没有扩展注册的参数会报 `Unknown option` 退出（`agent-session-services.js` 第 20–45 行） |
| D7 | SESSIONS §4：子代理会话的判断依据是名称以 `<subagent:` 开头 | 名称以 `<team:` 开头也算 | pi-interactive-subagents 的团队成员会话使用 `<team:…>` 命名 |

## 4. 注意事项

- 会话文件中有行包含不合法的 UTF-16 代理对转义，`jq` 读到会中断。索引器必须逐行解析并跳过坏行。
- 仓库工作区里有与本任务无关的未提交改动（pi-remote、pi-session-view），还有未跟踪的 `extensions/pi-input-complete/` 和 `.playwright-mcp/`。提交时只 `git add extensions/pi-home`。
