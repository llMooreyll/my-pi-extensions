# my-pi-extensions

Pi Coding Agent 扩展合集仓库。包含自建扩展与基于上游修改的插件。

## 扩展列表

| 扩展 | 说明 | 来源 | 本地修改摘要 | 详细文档 |
|---|---|---|---|---|
| [pi-remote](extensions/pi-remote) | Android 手机端远程控制与流式查看 Pi 会话 | 本地编写 | 包含 hostd、relay、mobile app 与 bridge 扩展，Noise NK 端到端加密 | [README](extensions/pi-remote/README.md) |
| [pi-session-view](extensions/pi-session-view) | 全屏模式会话轮次大纲（Turn rail）与 Neovim 查看器 | 本地编写 | 常驻轮次轨道、Alt+S 大纲面板、Alt+O / /open-msg 在 Neovim 中打开轮次内容 | [README](extensions/pi-session-view/README.md) |
| [pi-webview](extensions/pi-webview) | 在浏览器中阅读 md/html/pdf/Office 文件，选中内容向 pi 提问 | 本地编写 | `/view` 命令与 `view_open` 工具、选区提问与钉住引用、原处抽屉展开与连续追问、轮次标号与上文引用、接入系统 ASR 语音输入、PDF 框选与 HTML 元素拾取 | [README](extensions/pi-webview/README.md) |
| [pi-interactive-subagents](extensions/pi-interactive-subagents) | 终端复用器非阻塞子代理与协同团队 | HazAT/pi-interactive-subagents | 有序模型回退链、基于 Git worktree 隔离分支的团队模式（team_* 工具）、agent_before_settle 退出时序修复 | [README](extensions/pi-interactive-subagents/README.md) |
| [statusline-pi](extensions/statusline-pi) | 底部状态栏（费用、速度、Git、上下文区间） | luongnv89/pi-extensions | 异步非阻塞 GitHub PR 查询、边框样式编辑、实时 TPS 速度统计、统一上下文区间比例计算 | [README](extensions/statusline-pi/README.md) |
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
│   └── pi-voice/                 # 本地语音识别（ASR）服务
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

上游地址与基线记录详见 [docs/UPSTREAM.md](docs/UPSTREAM.md)。
