# pi-session-view

为 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 全屏模式（Fullscreen Mode）打造的会话大纲轨道（Turn Rail）与 Neovim 深度复核插件。

由 **llMooreyll** 原创开发。

---

## 解决的痛点

在长时间、数十乃至上百轮的 Pi 编码会话中：
1. **历史定位难**：全屏模式下向上滚屏翻找早期提问非常耗时，缺乏一个可视化的会话目录。
2. **长篇输出阅读受限**：Agent 生成的长篇架构文档、排错日志或多文件 Diff，在终端小窗格中阅读与检索不够高效，无法使用强大的 Vim 快捷键、正则搜索、代码折叠和分屏对比。

`pi-session-view` 通过**常驻大纲轨道**与**一键唤起 Neovim 查看轮次**优雅解决了上述问题。

---

## 核心功能

### 1. 🧭 全屏会话大纲指示轨（Turn Rail）
- 在全屏 TUI 模式下常驻运行，动态呈现整个会话的所有对话轮次（Turn）。
- 显示每一轮的用户提问首句预览（自动折叠空白与长文本）。
- 实时反映 Agent 运行状态（思考中、工具执行中、已完成）。
- 明确标识已执行上下文压缩的轮次（Compacted Turns）。

### 2. 📑 快速呼出会话大纲面板
- 快捷键 **`Alt+S`** 或命令 `/outline panel`：呼出会话大纲抽屉面板，纵览全部历史轮次。
- 命令 `/outline`：切换常驻大纲指示轨的显示与隐藏。

### 3. 📝 在 Neovim 中打开任意轮次（Open in Neovim）
- 快捷键 **`Alt+O`**：一键将**最新一轮**的完整上下文（包含 Prompt、思考链路、代码块及执行输出）转录为 Markdown 并在 Neovim 中打开。
- 命令 `/open-msg`：
  - `/open-msg`（无参数）：唤起交互式模糊选择框，直观列出 `#1`, `#2`, `#3`... 轮次供点选；
  - `/open-msg 4`：直接打开第 4 轮的详细记录；
  - `/open-msg last`：打开最后一轮。
- 借助 Neovim 强大的语法高亮、折叠、分屏与搜索功能，细致复核长篇交付物。

---

## 快捷键与命令速查

| 快捷键 / 命令 | 作用 |
|---|---|
| `Alt+S` | 展开 / 关闭会话大纲面板（Outline Panel） |
| `/outline` | 切换常驻轮次轨（Turn Rail）可见性 |
| `/outline panel` | 打开会话大纲面板 |
| `Alt+O` | 在 Neovim 中打开最新一轮的 Markdown 对话记录 |
| `/open-msg [num\|last]` | 交互式选择或直接打开指定轮次的内容 |

---

## 前置要求与安装

1. **环境依赖**：
   - 依赖本地已安装 `nvim`（Neovim）；
   - Pi 配置需开启全屏模式：在 `~/.pi/agent/settings.json` 中配置 `"tuiMode": "fullscreen"`。
2. **安装扩展**：
   ```zsh
   pi install ~/Projects/Pi-extension-dev/extensions/pi-session-view
   ```
3. 在 Pi 中执行 `/reload` 即可启用。

---

## 许可

本项目整体基于 GPL-3.0 聚合分发。
本插件代码版权归原作者所有：Copyright (c) 2026 llMooreyll (MIT License)。
