# pi-home 工作日志

本文件随开发过程持续更新，记录每一步操作、与计划（PLAN.md、SESSIONS.md、VISUAL.md）不一致的地方、需要注意的事项，以及对本机环境做过的改动和撤销方法。新条目追加在对应章节末尾。

## 1. 环境改动登记（全部可逆）

| 时间 | 改动 | 撤销方法 |
|---|---|---|
| — | 暂无 | — |

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

## 3. 与计划不一致的地方

| 编号 | 计划原文 | 实际做法 | 原因 |
|---|---|---|---|
| D1 | PLAN §4.1：界面使用 pi-tui 的 `TuiAltScreen`、`SelectList` 等组件 | 自写基于格子的画面缓冲和渲染器，pi-tui 只用于终端输入（`ProcessTerminal`、`matchesKey`）、宽度计算和颜色解析 | CRT 效果（暗角、渐变外壳、开关机动画、着色器暗号）需要按格子控制前景色和背景色并做后处理；pi-tui 组件按行输出 ANSI 字符串，无法做这种后处理 |

## 4. 注意事项

- 会话文件中有行包含不合法的 UTF-16 代理对转义，`jq` 读到会中断。索引器必须逐行解析并跳过坏行。
- 仓库工作区里有与本任务无关的未提交改动（pi-remote、pi-session-view），还有未跟踪的 `extensions/pi-input-complete/` 和 `.playwright-mcp/`。提交时只 `git add extensions/pi-home`。
