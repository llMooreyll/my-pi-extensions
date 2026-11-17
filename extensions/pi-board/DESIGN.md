# pi-board 设计文档

状态：待用户确认。确认前不开始开发。
来源：2026-11-17 与用户的逐题讨论（Q1–Q40），以及子代理对 pi 扩展 API、test1 文档、pi-interactive-subagents、tmux 环境的只读调查。

## 0. 目标

用户不读代码，也读不完长文档。用户看一个终端面板，就能知道：

- 现在在做什么，还剩什么，哪些事在等用户决定；
- 新要求和旧决定、设计文档哪里冲突；
- AI 每次改代码改了哪个文件、为什么改，并能点开看 diff。

面板取代“读文档”和“读代码”两件事。长文档保留为参考资料，只被条目链接。

## 1. 组成

| 部分 | 位置 | 运行在 | 职责 |
|---|---|---|---|
| 扩展本体 | `extensions/pi-board/` | 每个 pi 进程（主代理、子代理、团队成员） | 覆盖 write/edit；校验计划文档；记录改动；主代理里显示 widget、打开面板窗格、接收引用 |
| 面板程序 | `extensions/pi-board/`（独立入口） | 主 window 右侧的 tmux 窗格，独立进程 | 显示 Plan 页和 Changes 页；把选中条目发回 pi |
| skill | `extensions/pi-board/skills/` | 随扩展加载 | 告诉 AI 计划文档的格式和更新规则 |
| 后台 window | `extensions/pi-interactive-subagents/` | 主代理进程 | 子代理和团队成员的窗格移到一个后台 window |

解析器只写一份，扩展的校验和面板的显示共用。

pi-tool-display 当前也覆盖 write/edit。用户自行在其配置中关闭 `registerToolOverrides.edit` 与 `registerToolOverrides.write`，本项目不改它。

## 2. 启用条件

- 只在项目根目录存在 `docs/board/` 时启用。其他项目里，扩展不覆盖 write/edit、不注入规则、不显示 widget。
- `/board init` 在当前项目创建 `docs/board/` 和三个空文件（见 §3）。
- 项目根目录：`git rev-parse --show-toplevel`。团队成员在 worktree 里时，用 `git rev-parse --git-common-dir` 找到主仓库，改动记录写到主仓库（§6）。

## 3. 计划文档格式

### 3.1 文件

| 文件 | 内容 | 编号前缀 |
|---|---|---|
| `docs/board/tasks.md` | 任务 | `T` |
| `docs/board/decisions.md` | 决定 | `D` |
| `docs/board/conflicts.md` | 冲突 | `C` |
| `docs/board/<其他>.md` | AI 新增的板块（§3.5） | 板块自定 |

### 3.2 条目

每个条目是一个二级标题，下面紧跟字段行，再往下是自由正文。正文可选，面板默认折叠。

```markdown
## T12 标点改用 ct-punc
- status: doing
- priority: high
- owner: ai
- next: 在《火线》上对比 ct-punc 与旧结果
- refs: D26, [设计 §6](../../设计方案.md#6-处理流水线)

自由正文。
```

规则：

- 标题格式 `## <编号> <标题>`。编号是前缀加正整数，由 AI 按顺序新建，不重复，不复用。
- 字段行格式 `- <key>: <value>`，key 用英文小写，紧跟标题，中间不空行。字段顺序不限。
- 条目关闭后留在原处，只改 `status`。面板默认隐藏已关闭的条目。
- 标题和正文用中文，字段名和取值用英文。

### 3.3 字段

**任务 T**

| key | 必填 | 取值 |
|---|---|---|
| `status` | 是 | `todo` `doing` `waiting` `paused` `done` `dropped` |
| `priority` | 是 | `high` `medium` `low` |
| `owner` | 是 | `user` `ai` 或团队成员名 |
| `next` | `status` 为 `todo` `doing` `waiting` 时必填 | 下一步，一句话 |
| `refs` | 否 | 逗号分隔的条目编号或 Markdown 链接 |
| `branch` | 否 | 分支名 |
| `commits` | 否 | 逗号分隔的提交号 |
| `result` | `status` 为 `done` 时必填 | 验收结果，一句话 |

`waiting` 表示等用户决定，此时 `owner` 必须是 `user`。

**决定 D**

| key | 必填 | 取值 |
|---|---|---|
| `status` | 是 | `active` `superseded` |
| `date` | 是 | `YYYY-MM-DD` |
| `by` | 是 | `user` `ai` |
| `rejected` | 否 | 没选的方案，一句话 |
| `reason` | 是 | 理由，一句话 |
| `supersedes` | 否 | 被本条取代的 D 编号，逗号分隔 |
| `superseded-by` | `status` 为 `superseded` 时必填 | 取代本条的 D 编号 |
| `affects` | 否 | 受影响的 T 编号或文档链接 |

决定的内容写在标题里。标题写不下时，正文第一段写完整决定。

**冲突 C**

| key | 必填 | 取值 |
|---|---|---|
| `status` | 是 | `open` `resolved` |
| `between` | 是 | 两处冲突的来源，逗号分隔，每处是条目编号或文档链接 |
| `owner` | 是 | `user` `ai` |
| `resolved-by` | `status` 为 `resolved` 时必填 | D 编号 |

“设计文档和现状不一致”也记为冲突，`between` 写设计文档章节和对应的 D 或 T。

### 3.4 引用

- 条目编号：`T12`、`D26`、`C3`，或扩展板块的编号。
- 文档链接：`[文字](相对路径#锚点)`，路径相对于该计划文件。锚点按 GitHub 风格由标题生成。

### 3.5 扩展板块

AI 可以在 `docs/board/` 下新建文件作为新板块，例如评测结论。文件开头用 frontmatter 声明：

```markdown
---
section: Findings
prefix: F
status: [valid, superseded]
closed: [superseded]
fields: [date, reference, metric, verdict]
---
```

- `status` 列出允许的状态，`closed` 列出其中哪些算已关闭。
- `fields` 列出额外的必填字段。代码只校验字段齐全和状态取值，不理解字段含义。
- 面板对扩展板块统一用列表显示。

## 4. 计划文档的校验

### 4.1 时机与方式

- 主代理调用 write 或 edit、目标在 `docs/board/` 下时，扩展在执行前（`tool_call`）先在内存中算出写入后的完整内容，用解析器整体检查 `docs/board/` 下的全部文件（被改的文件用新内容）。
- 不通过时拒绝本次调用，把错误清单作为拒绝原因返回给 AI，AI 修改后重新提交。判断完全由代码完成。
- 只拦截计划文档。其他文件的 write/edit 只要求 `message`（§5），不做内容校验。

### 4.2 规则

格式：

1. 每个二级标题都能解析出编号和标题；编号前缀与所在文件一致。
2. 字段行紧跟标题，key 已知，必填字段齐全，取值在枚举内。
3. 编号在整个 `docs/board/` 内唯一。与 git `HEAD` 中的版本相比，已存在的编号不能消失，也就是条目只能改状态、不能删除。

一致性：

4. `refs`、`between`、`affects`、`supersedes`、`superseded-by`、`resolved-by` 里的编号必须存在。
5. D 甲的 `supersedes` 含 D 乙，则 D 乙必须是 `superseded` 且 `superseded-by` 含 D 甲；反之亦然。
6. `resolved-by` 指向的决定必须是 `active`。
7. 文档链接指向的文件必须存在；带锚点时，锚点对应的标题必须存在。
8. 状态为未关闭的 T，其 `refs` 不能指向 `superseded` 的 D。

拒绝原因的格式：每条错误一行，写明文件、行号、编号和应怎么改。

### 4.3 写入权限

- 只有主代理能修改 `docs/board/`。扩展通过环境变量（`PI_TEAM_MEMBER_ID`、`PI_SUBAGENT_ID`）识别团队成员和子代理，它们对 `docs/board/` 的 write/edit 直接拒绝，并提示改为向主代理汇报。
- bash 命令里出现 `docs/board/` 路径且带写操作（`>`、`>>`、`tee`、`sed -i`、`perl -i`、`mv`、`cp`、`rm`、`truncate`）时拒绝，提示改用 edit。只读命令（如 `cat`、`rg`）放行。这是按文本匹配的近似判断。

## 5. write/edit 覆盖

启用的项目里，扩展用同名 `registerTool` 覆盖内置 write/edit。执行逻辑委托给内置实现，界面沿用内置的渲染，并在顶部加一行 message。

新增参数：

| 参数 | 必填 | 约束 |
|---|---|---|
| `message` | 是 | 10–120 字，一句话写清“改了什么、为什么改” |
| `task` | 否 | T 编号，必须存在于 `docs/board/tasks.md` |

参数校验不通过时，pi 把错误返回给 AI，AI 会自动补上。覆盖时要把内置工具的 `promptSnippet`、`promptGuidelines` 一并带上，因为它们不会自动继承。

## 6. 改动记录

### 6.1 存放

- 位置：主仓库的 `.pi/changes/<sessionId>.jsonl`，每个 pi 会话一个文件，多进程同时写不冲突。
- 扩展首次写入时把 `.pi/changes/` 加入主仓库的 `.gitignore`。
- 团队成员和子代理也写到主仓库这一份（§2），所以主面板能实时看到它们的改动。

### 6.2 每条记录

| 字段 | 说明 |
|---|---|
| `id` | 记录编号 |
| `time` | ISO 时间 |
| `session` | 会话 ID |
| `actor` | `lead`、`team:<成员名>` 或 `sub:<名字>` |
| `memberId` | 团队成员的 instanceId，主代理为空 |
| `branch` | 成员所在分支，主代理为空 |
| `turn` | 主代理的“用户轮次”编号；成员记录取写入时主代理正在进行的轮次 |
| `tool` | `write` 或 `edit` |
| `path` | 相对仓库根目录的路径 |
| `message`、`task` | 来自参数 |
| `category` | `plan`（`docs/board/` 下）或 `code` |
| `added`、`removed` | 增删行数 |
| `diff` | unified diff；超过 200 KB 时截断并标记 `truncated` |
| `status` | 只对成员记录：`unmerged`，合入后由主代理追加一条 `merged` 事件 |

- edit 的 diff 来自工具结果；write 的 diff 由扩展在执行前读取磁盘旧内容，与新内容比较得出，新文件按全部新增计。
- 只记录执行成功的调用。
- 主代理的扩展监听 `team_integrate` 的工具结果，成功后为该成员的全部记录追加 `merged` 事件。

## 7. AI 的规则

写在 skill 里，启用的项目由扩展注入提示词：

1. 用户提出新要求、修改原要求或做出决定时，先记录 D 或新建、修改 T，再改代码。
2. 记录新 D 时，与全部 `active` 的 D 和相关文档章节逐一比对。发现矛盾就写一条 C，`owner: user`；用户裁决前，不执行与该冲突有关的改动。
3. 开始一个任务时把状态改为 `doing`；完成时改为 `done`，并填写 `result`。
4. 需要用户决定的事，新建或修改 T，`status: waiting`、`owner: user`，不能只在对话里问。
5. 每次提交代码时，把当时的 `docs/board/` 一并提交。
6. message 一句话写清改了什么、为什么改，例如“标点阶段默认引擎改为 ct-punc，落实 D26”。“修改文件”“更新代码”这类不合格。

代码辅助：用户发出新消息后，如果 AI 在修改 `docs/board/` 之前就先修改了代码文件，扩展在这次工具结果末尾附加一次提醒，不拦截。每个用户轮次最多提醒一次。

## 8. 面板程序

### 8.1 打开与关闭

- 启用的项目里，主代理在 tmux 中启动时，自动在主 window 右侧开一个窗格（宽 40%，不抢焦点），运行面板程序。
- `/board` 开关面板窗格。主代理退出时关闭面板窗格。
- 面板只读 `docs/board/` 和 `.pi/changes/`，监听文件变化后刷新。

### 8.2 Plan 页

从上到下依次是：

1. `Conflicts`：`open` 的 C
2. `Waiting on you`：`owner: user` 且未关闭的 T
3. `In progress`：`doing` 的 T
4. `Todo`：`todo` 的 T，按优先级排序
5. `Recent decisions`：最近的 `active` D
6. 扩展板块，每个板块一节

每个条目占一行，显示编号、标题、关键字段。回车展开正文。已关闭的条目默认隐藏，按键切换显示。

### 8.3 Changes 页

- 按主代理的用户轮次分组，最新的在上。
- 组内每次 write/edit 占一行：时间、actor、文件、`+增/-删`、message、task。成员记录标出成员名，未合入标 `unmerged`。
- `category: plan` 的记录默认隐藏，按键切换显示。
- 回车在面板里展开 unified diff（带颜色）；`o` 用 nvim 的 diff 模式打开这次改动前后的文件。

### 8.4 引用到 pi

- 空格选中一个或多个条目，`y` 发回 pi，插入到输入框光标处，不发送。
- Plan 条目插入 `〔T12 标点改用 ct-punc〕`；Changes 条目插入 `〔改动 src/x.py：<message>〕`。
- 通道：主代理扩展监听 unix socket `$XDG_RUNTIME_DIR/pi-board/<sessionId>.sock`，面板启动时由参数得到路径。扩展收到后调用 `ctx.ui.pasteToEditor`。

### 8.5 按键

| 键 | 作用 |
|---|---|
| `Tab` 或 `1` / `2` | 切换 Plan / Changes |
| `j` `k` / 方向键 | 移动 |
| `Enter` | 展开或收起 |
| `Space` | 选中 |
| `y` | 引用到 pi |
| `h` | 显示或隐藏已关闭的条目（Plan）、计划文档的改动（Changes） |
| `o` | 用 nvim 打开 diff（Changes） |

界面文字全部用英文。

## 9. 主代理里的 widget

放在输入框上方，只在主代理里显示：

- 第一行是摘要：`doing T12 · conflicts 2 · waiting on you 3 · this turn 5 changes`。
- 之后每个后台进程一行：`sub:scout running`、`team:dev waiting` 等。
- 鼠标点击某一行，就切换到后台 window 并选中对应窗格，不放大。点击是根据代码推断可行的，需要实测。
- 键盘：`Alt+G` 打开选择列表，选中后跳转。从后台 window 回来用 tmux 的 `prefix + l`。
- widget 不获取输入焦点。

## 10. 后台 window（修改 pi-interactive-subagents）

- tmux 后端新增 window 模式，设为默认；环境变量 `PI_SUBAGENT_TMUX_LAYOUT=split` 切回原来的分屏方式。cmux、zellij、wezterm 后端不变。
- 每个主 pi 一个后台 window。第一次创建子代理或成员时用 `tmux new-window -d -n <名字>` 建立，记下 window id；之后在该 window 里 `split-window -d`，再 `select-layout tiled`。
- window 名为 `agents:<项目目录名>`；同一 tmux session 里已有同名 window 时，后面加会话 ID 的前 4 位。
- 每个窗格用 `select-pane -T` 设置标题：`sub:<名字>` 或 `team:<名字>`。用户的 tmux 已开启 `pane-border-status top`，标题会显示出来。
- 关闭仍用 `kill-pane`；window 里最后一个窗格关闭时，tmux 自动关闭该 window。主代理记下的 window id 失效后，下次创建时重新建立。
- 对外提供跳转所需的信息：每个后台进程的名字、类型、状态、pane id。pi-board 的 widget 通过 `pi.events` 或 `globalThis` 上的共享对象读取，两个扩展在同一进程内。

## 11. 测试项目

- 复制 `/home/moorey/Projects/PodcastsYou/test1` 到 `/home/moorey/Projects/PodcastsYou/test1-board`，用 btrfs reflink 复制，不复制任何 `.venv`，复制后删除副本里的 `.git/worktrees`。复制命令执行前给用户确认。
- 只测文档相关的功能，不要求项目本身能运行。
- 迁移：子代理把副本里的 `docs/todo.md`（T 条目）、`docs/worklog.md` 的决定（D01–D32）、`docs/status.md` §6（设计偏差）转成 `docs/board/` 的格式，同时把盘点中发现的冲突（设计文档与 D26/D27 不一致、人数口径、悬空引用等）记成 C。之后 `todo.md`、`worklog.md`、`status.md` 移到 `docs/archive/`。设计方案、`team/contracts.md`、`plans/`、`eval/`、`team/README.md`、`team/tasks/` 留在原位，作为参考资料。

## 12. 开发分工

团队模式，三个写入成员，各自一个分支：

| 成员 | 范围 |
|---|---|
| 成员一 | 扩展本体：write/edit 覆盖、解析器与校验、改动记录、提示注入与提醒、widget、socket、`/board` 命令、skill |
| 成员二 | 面板程序：Plan 页、Changes 页、diff 显示、引用发回 |
| 成员三 | pi-interactive-subagents 的 window 模式与后台进程信息接口 |

- 解析器由成员一先写定接口，成员二按接口使用。
- 主代理负责审查和合入，只做静态检查。编译、运行和实际试用由用户进行。

## 13. 未确认事项与风险

- widget 的鼠标点击是根据代码推断可行的，未实测；不可行时只保留 `Alt+G`。
- 覆盖 write/edit 后，新增参数在 pi 的参数校验中的表现未实测。
- RPC 模式下 widget 不支持组件，pi-remote 手机端看不到可点击的列表，只显示摘要文字。
- bash 写操作的检测按文本匹配，可能漏判或误判。
- message 写得好不好，代码只能检查长度，判断不了质量。
- 冲突能否发现，依赖 AI 遵守 §7 第 2 条；代码只能发现 §4.2 中的结构性矛盾。
