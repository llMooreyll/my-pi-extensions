# Pi extensions (personal forks)

本仓库汇总我在 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 上使用并修改过的三个插件。每个插件都以上游版本为基线，本地改动以独立 commit 保留。上游地址、基线和改动摘要见 [docs/UPSTREAM.md](docs/UPSTREAM.md)。

| 插件 | 作用 | 上游 |
|---|---|---|
| [statusline-pi](extensions/statusline-pi) | 底部状态栏：费用、上下文、tokens/s、Git/PR | luongnv89/pi-extensions |
| [pi-interactive-subagents](extensions/pi-interactive-subagents) | 在终端复用器窗格中运行交互式子 agent | HazAT/pi-interactive-subagents |
| [pi-language-tutor](extensions/pi-language-tutor) | 语言学习（翻译、复习、写作检查） | mackt/pi-language-tutor |

## 安装

在 `~/.pi/agent/settings.json` 的 `packages` 中加入本地路径，或执行：

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/statusline-pi
pi install ~/Projects/Pi-extension-dev/extensions/pi-interactive-subagents
pi install ~/Projects/Pi-extension-dev/extensions/pi-language-tutor
```

`statusline-pi` 需先 `npm run build`；`pi-language-tutor` 需先 `npm install`。

## 许可

MIT，保留各上游作者的版权声明（见根目录与各插件的 LICENSE）。
