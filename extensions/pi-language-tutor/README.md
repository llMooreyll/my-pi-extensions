# pi-language-tutor

Pi Coding Agent 的外语学习与 Prompt 写作检查扩展。基于 [mackt/pi-language-tutor](https://github.com/mackt/pi-language-tutor) 修改。

## 功能

- **Prompt 写作检查**：在后台分析提问的语法结构与用词，在面板中使用母语展示修正建议。
- **生词闪卡**：记录会话中遇到的生词并支持终端内复习。
- **双语翻译**：将部分助手回复转换为双语对照。

## 本地修改

1. **`/dismiss` 命令**：
   - 增加 `/dismiss` 指令，用于临时清空并隐藏写作检查面板，避免长时间遮挡终端输出；在发送下一次 Prompt 时自动恢复检查。
2. **大小写容错**：
   - 优化写作检查的差异对比逻辑，忽略纯大小写差异导致的提示。

## 命令

| 命令 | 说明 |
|---|---|
| `/lang` | 配置母语和学习目标语言（如 `/lang native zh`、`/lang target en`） |
| `/dismiss` | 隐藏当前写作检查面板，下一次提问自动恢复 |
| `/flashcards` | 管理生词闪卡 |
| `/review` | 进入单词复习会话 |

## 安装

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/pi-language-tutor
```

如需更新依赖：

```zsh
cd ~/Projects/Pi-extension-dev/extensions/pi-language-tutor
npm install
```

在 Pi 中执行 `/reload` 重新加载。

## 许可

保留原作者版权声明：Copyright (c) 2026 Mack (MIT License)。详见 [LICENSE](LICENSE)。
