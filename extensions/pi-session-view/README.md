# pi-session-view

Pi Coding Agent 的全屏模式会话轮次大纲轨道（Turn rail）与 Neovim 查看扩展。

## 功能

1. **会话轮次轨道（Turn Rail）**：
   - 在全屏 TUI 模式下常驻显示当前会话的所有对话轮次。
   - 显示每一轮的用户提问首句预览。
   - 实时显示当前轮次执行状态（运行中/空闲）与上下文压缩（compacted turns）计数。
2. **大纲面板**：
   - 快捷键 `Alt+S` 或 `/outline panel`：打开会话大纲抽屉面板。
   - 命令 `/outline`：切换常驻轮次轨道的显示与隐藏。
3. **在 Neovim 中查看轮次内容**：
   - 快捷键 `Alt+O`：将最新一轮的完整上下文（包含 Prompt、思考过程、代码块与工具调用输出）转录为 Markdown 文件并在 Neovim 中打开。
   - 命令 `/open-msg`：
     - `/open-msg`：弹出轮次选择列表供交互式选择；
     - `/open-msg <数字>`：直接打开指定编号的轮次（如 `/open-msg 5`）；
     - `/open-msg last`：打开最后一轮。

## 快捷键与命令

| 快捷键 / 命令 | 说明 |
|---|---|
| `Alt+S` | 打开或关闭会话大纲面板 |
| `/outline` | 切换常驻轮次轨道的可见性 |
| `/outline panel` | 打开会话大纲面板 |
| `Alt+O` | 在 Neovim 中打开最新一轮的 Markdown 对话记录 |
| `/open-msg [编号\|last]` | 打开指定轮次的对话记录 |

## 前置要求与安装

1. 系统需安装 Neovim（可执行文件 `nvim` 位于 `PATH` 中）。
2. Pi 需开启全屏模式，在 `~/.pi/agent/settings.json` 中设置：
   ```json
   {
     "tuiMode": "fullscreen"
   }
   ```
3. 安装本地扩展：
   ```zsh
   pi install ~/Projects/Pi-extension-dev/extensions/pi-session-view
   ```
4. 在 Pi 中执行 `/reload` 生效。

## 许可

MIT 许可证，Copyright (c) 2026 llMooreyll。详见 package.json。
