# my-pi-extensions

个人专属的 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 高性能扩展与全栈工具套件。

本项目汇聚了自主研发的移动端远程控制套件、全屏会话大纲工具，以及在开源社区优质项目基础上进行深度重构、增强与性能调优的多个核心插件。

---

## 插件清单与导航

| 插件 | 类型 | 核心作用 | 本地新功能与重大增强 | 详细文档 |
|---|---|---|---|---|
| **[pi-remote](extensions/pi-remote)** | 🌟 原创自研 | Android 手机端远程遥控 Pi 会话 | 端到端加密（Noise NK）、VPS 无状态中继、实时流式查看、多代理（Subagent & Team）协同监控与常用指令控制 | [查看文档](extensions/pi-remote/README.md) |
| **[pi-session-view](extensions/pi-session-view)** | 🌟 原创自研 | 全屏模式会话大纲与 Neovim 查看器 | 全屏 Turn Rail 轮次轨、`Alt+S` 会话大纲抽屉、`Alt+O` / `/open-msg` 将任意对话轮次一键提取并在 Neovim 中打开 | [查看文档](extensions/pi-session-view/README.md) |
| **[pi-interactive-subagents](extensions/pi-interactive-subagents)** | ⚡ 深度增强 | 终端分屏非阻塞子代理与协同团队 | **多模型有序回退链**（故障自动降级切换）、**长期存活团队协作模式**（独立 Git Worktree 分支开发与成果集成）、`agent_before_settle` 与 `.exit` 稳健生命周期 | [查看文档](extensions/pi-interactive-subagents/README.md) |
| **[statusline-pi](extensions/statusline-pi)** | ⚡ 性能重构 | 响应式底部状态栏（费用/速度/Git/上下文） | **异步非阻塞 GitHub PR 查询**（彻底消除原版 ~1.1s 事件循环卡死）、边框编辑器（Border Editor）、实时 TPS 统计与上下文统一水位 | [查看文档](extensions/statusline-pi/README.md) |
| **[pi-language-tutor](extensions/pi-language-tutor)** | 🛠️ 定制优化 | 边写代码边学外语（写作检查与生词闪卡） | **新增 `/dismiss` 命令**（临时隐藏面板不遮挡视线，下轮自动唤醒）、写作修正对比大小写容错 | [查看文档](extensions/pi-language-tutor/README.md) |

---

## 快速安装与配置

### 1. 批量安装到 Pi

在终端中直接通过 `pi install` 命令安装本地插件：

```zsh
# 状态栏（需先构建）
cd ~/Projects/Pi-extension-dev/extensions/statusline-pi && npm run build
pi install ~/Projects/Pi-extension-dev/extensions/statusline-pi

# 交互式子代理与团队协作
pi install ~/Projects/Pi-extension-dev/extensions/pi-interactive-subagents

# 全屏会话大纲与 Neovim 轮次查看器（需开启 tuiMode: fullscreen）
pi install ~/Projects/Pi-extension-dev/extensions/pi-session-view

# 语言学习助教（需先安装依赖）
cd ~/Projects/Pi-extension-dev/extensions/pi-language-tutor && npm install
pi install ~/Projects/Pi-extension-dev/extensions/pi-language-tutor

# 远程控制桥接插件（可选，搭配 hostd 与 Android App 使用）
pi install ~/Projects/Pi-extension-dev/extensions/pi-remote/packages/bridge
```

### 2. 配置文件配置

也可以直接将插件路径加入到 `~/.pi/agent/settings.json` 的 `packages` 列表中：

```json
{
  "packages": [
    "~/Projects/Pi-extension-dev/extensions/statusline-pi",
    "~/Projects/Pi-extension-dev/extensions/pi-interactive-subagents",
    "~/Projects/Pi-extension-dev/extensions/pi-session-view",
    "~/Projects/Pi-extension-dev/extensions/pi-language-tutor"
  ]
}
```

在 Pi 会话中输入 `/reload` 即可实时热重载所有扩展。

---

## 项目结构

```text
my-pi-extensions/
├── extensions/
│   ├── pi-remote/                # Android 远程控制套件（hostd, relay, mobile, bridge）
│   ├── pi-session-view/          # 全屏会话大纲与 Neovim 查看器
│   ├── pi-interactive-subagents/ # 终端复用器子代理与长期团队协同
│   ├── statusline-pi/            # 异步非阻塞自适应状态栏
│   └── pi-language-tutor/        # 沉浸式外语学习与 Prompt 语法检查
├── docs/
│   └── UPSTREAM.md               # 各分叉插件的上游仓库地址与基线 Commit 记录
├── package.json                  # Monorepo 元数据配置
├── LICENSE                       # GNU General Public License v3.0 (GPL-3.0)
└── README.md                     # 本总览文档
```

---

## 许可与开源声明

本项目整体采用 **[GNU General Public License v3.0 (GPL-3.0)](LICENSE)** 授权。

第三方分叉插件保留各上游原作者的 MIT 版权声明与许可文本（详见各插件目录下的 `LICENSE` 及 [docs/UPSTREAM.md](docs/UPSTREAM.md)）：
- `statusline-pi`: MIT License, Copyright (c) 2024 luongnv89
- `pi-interactive-subagents`: MIT License, Copyright (c) 2026 HazAT
- `pi-language-tutor`: MIT License, Copyright (c) 2026 Mack
