# my-pi-extensions

Pi Coding Agent 扩展合集仓库。包含自建扩展与基于上游修改的插件。

## 扩展列表

| 扩展 | 说明 | 来源 | 本地修改摘要 | 详细文档 |
|---|---|---|---|---|
| [pi-remote](extensions/pi-remote) | Android 手机端远程控制与流式查看 Pi 会话 | 新编写 | 包含 hostd、relay、mobile app 与 bridge 扩展，Noise NK 端到端加密 | [README](extensions/pi-remote/README.md) |
| [pi-session-view](extensions/pi-session-view) | 全屏模式会话轮次大纲（Turn rail）与 Neovim 查看器 | 新编写 | 常驻轮次轨道、Alt+S 大纲面板、Alt+O / /open-msg 在 Neovim 中打开轮次内容 | [README](extensions/pi-session-view/README.md) |
| [pi-webview](extensions/pi-webview) | 在浏览器中阅读 md/html/pdf/Office 文件，选中内容向 pi 提问 | 新编写 | `/view` 命令（无参数时打开 pi-input-plus 文件选择器）与 `view_open` 工具、选区提问与钉住引用、原处抽屉展开与连续追问、轮次标号与上文引用、接入系统 ASR 语音输入、PDF 框选与 HTML 元素拾取 | [README](extensions/pi-webview/README.md) |
| [pi-input-plus](extensions/pi-input-plus) | 输入框扩展：`@` 与 Tab 打开 vim 风格文件选择器、大段粘贴与剪贴板图片的预览浮窗、供其他扩展调用的选择器服务 | 新编写 | 行首或空白后输入 `@` 打开选择器（文件插入 `name[绝对路径]`，目录插入绝对路径）；路径以 `/` 结尾时按 Tab 打开选择器，否则补全到最长公共前缀且不显示候选列表；光标在粘贴块前按空格或单击打开预览；`globalThis[Symbol.for("pi.file-picker.v1")]` 选择器服务 | [README](extensions/pi-input-plus/README.md) |
| [pi-video](extensions/pi-video) | `read_video` 工具与 `/read-video` 命令 | 新编写 | 把本地视频放进模型上下文；`/read-video` 用 pi-input-plus 的选择器选 mp4，在输入框插入 `name.mp4[绝对路径]` | [README](extensions/pi-video/README.md) |
| [pi-interactive-subagents](extensions/pi-interactive-subagents) | 终端复用器非阻塞子代理与协同团队 | HazAT/pi-interactive-subagents | 有序模型回退链、基于 Git worktree 隔离分支的团队模式（team_* 工具）、agent_before_settle 退出时序修复 | [README](extensions/pi-interactive-subagents/README.md) |
| [statusline-pi](extensions/statusline-pi) | 底部状态栏（费用、速度、Git、上下文区间） | luongnv89/pi-extensions | 异步非阻塞 GitHub PR 查询、边框样式编辑（叠加在已有输入框上，不替换输入框组件）、实时 TPS 速度统计、统一上下文区间比例计算 | [README](extensions/statusline-pi/README.md) |
| [pi-language-tutor](extensions/pi-language-tutor) | 语言学习与 Prompt 写作检查 | mackt/pi-language-tutor | 新增 /dismiss 命令临时隐藏面板、写作对比忽略大小写差异 | [README](extensions/pi-language-tutor/README.md) |
| [pi-voice](extensions/pi-voice) | 本地语音识别（ASR）与系统级语音转写服务 | earendil-works/pi-voice | 通过 `Symbol.for("pi.asr.v1")` 与 `pi.events` 对外提供同进程 ASR 服务，新增音频字节流解码 | [README](extensions/pi-voice/README.md) |

## 安装与配置

在终端中执行对应扩展的安装命令：

```zsh
# statusline-pi（需先构建）
cd ~/Projects/Pi-extension-dev/extensions/statusline-pi && npm run build
pi install ~/Projects/Pi-extension-dev/extensions/statusline-pi

# pi-interactive-subagents
pi install ~/Projects/Pi-extension-dev/extensions/pi-interactive-subagents

# pi-session-view（需开启 tuiMode: fullscreen）
pi install ~/Projects/Pi-extension-dev/extensions/pi-session-view

# pi-language-tutor
cd ~/Projects/Pi-extension-dev/extensions/pi-language-tutor && npm install
pi install ~/Projects/Pi-extension-dev/extensions/pi-language-tutor

# pi-voice
cd ~/Projects/Pi-extension-dev/extensions/pi-voice && npm install --ignore-scripts
pi install ~/Projects/Pi-extension-dev/extensions/pi-voice

# pi-input-plus（图片预览需要 chafa，递归搜索需要 fd）
pi install ~/Projects/Pi-extension-dev/extensions/pi-input-plus

# pi-video（/read-video 的文件选择器依赖 pi-input-plus；先删除旧的 ~/.pi/agent/extensions/video-reader.ts）
pi install ~/Projects/Pi-extension-dev/extensions/pi-video

# pi-webview（打开 Office 文件需要 LibreOffice）
cd ~/Projects/Pi-extension-dev/extensions/pi-webview && npm install
pi install ~/Projects/Pi-extension-dev/extensions/pi-webview

# pi-remote bridge（与 hostd 配合使用）
pi install ~/Projects/Pi-extension-dev/extensions/pi-remote/packages/bridge
```

或将路径加入 `~/.pi/agent/settings.json`：

```json
{
  "packages": [
    "~/Projects/Pi-extension-dev/extensions/statusline-pi",
    "~/Projects/Pi-extension-dev/extensions/pi-interactive-subagents",
    "~/Projects/Pi-extension-dev/extensions/pi-session-view",
    "~/Projects/Pi-extension-dev/extensions/pi-language-tutor",
    "~/Projects/Pi-extension-dev/extensions/pi-voice",
    "~/Projects/Pi-extension-dev/extensions/pi-input-plus",
    "~/Projects/Pi-extension-dev/extensions/pi-video",
    "~/Projects/Pi-extension-dev/extensions/pi-webview"
  ]
}
```

在 Pi 会话中运行 `/reload` 加载更新。

## 目录结构

```text
my-pi-extensions/
├── extensions/
│   ├── pi-remote/                # Android 远程控制套件（hostd, relay, mobile, bridge）
│   ├── pi-session-view/          # 全屏会话大纲与 Neovim 查看器
│   ├── pi-webview/               # 浏览器阅读与提问
│   ├── pi-interactive-subagents/ # 终端复用器子代理与长期团队协同
│   ├── statusline-pi/            # 底部状态栏
│   ├── pi-language-tutor/        # 外语学习与写作检查
│   ├── pi-voice/                 # 本地语音识别（ASR）服务
│   ├── pi-input-plus/            # 输入框扩展：文件选择器、粘贴预览
│   └── pi-video/                 # read_video 工具与 /read-video 命令
├── docs/
│   └── UPSTREAM.md               # 上游仓库地址与基线 commit 记录
├── package.json
├── LICENSE
└── README.md
```

## 许可

仓库整体采用 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 许可。

第三方分叉扩展保留各上游原作者的 MIT 版权声明与许可文本：
- `statusline-pi`: MIT License, Copyright (c) 2024 luongnv89（见 [extensions/statusline-pi/LICENSE](extensions/statusline-pi/LICENSE)）
- `pi-interactive-subagents`: MIT License, Copyright (c) 2026 HazAT（见 [extensions/pi-interactive-subagents/LICENSE](extensions/pi-interactive-subagents/LICENSE)）
- `pi-language-tutor`: MIT License, Copyright (c) 2026 Mack（见 [extensions/pi-language-tutor/LICENSE](extensions/pi-language-tutor/LICENSE)）
- `pi-voice`: MIT License, Copyright (c) 2026 Earendil Works contributors（见 [extensions/pi-voice/LICENSE](extensions/pi-voice/LICENSE)）
- `pi-session-view`: MIT License, Copyright (c) 2026 llMooreyll
- `pi-webview`: MIT License, Copyright (c) 2026 llMooreyll
- `pi-input-plus`: MIT License, Copyright (c) 2026 llMooreyll
- `pi-video`: MIT License, Copyright (c) 2026 llMooreyll

上游地址与基线记录详见 [docs/UPSTREAM.md](docs/UPSTREAM.md)。
