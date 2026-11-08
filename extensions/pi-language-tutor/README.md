# pi-language-tutor

边写代码边学外语 —— 为 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 打造的无感沉浸式外语学习与写作检查助手。

原版基于 [mackt/pi-language-tutor](https://github.com/mackt/pi-language-tutor)，由 **llMooreyll** 维护并加入体验优化。

---

## 核心功能

- ✏️ **Prompt 写作检查（Writing Check）**：使用学习中的目标语言提问，插件在后台并发分析语法、表达与选词，并在独立面板中使用你的母语指出修正建议与更地道的表达。
- 🗂️ **生词闪卡（Flashcards）**：随时将交互过程中遇到的新单词保存为闪卡，方便后续在终端内复习。
- 🌐 **双语沉浸式翻译（Bilingual Replies）**：无缝将 Agent 的部分技术回复转换为双语对照，拓展真实技术语境词汇。

---

## 本地新增与优化特性

1. **🚫 `/dismiss` 隐藏复习面板命令**
   - **痛点**：在连续快速提问或终端空间紧张时，写作分析面板可能会遮挡重要的代码输出。
   - **改进**：新增 `/dismiss` 命令，一键清空并隐藏当前界面的写作检查与复习面板。当下一次发送新的 prompt 时，面板会自动重新唤起，既不中断交互节奏，又保持视野干净。
2. **🔤 写作对比大小写容错（Case-Insensitive Normalization）**
   - 优化了写作语法差异对比逻辑，忽略纯大小写差异导致的误报，让纠错建议集中在真正的语法结构与地道选词上。

---

## 常用命令

| 命令 | 说明 |
|---|---|
| `/lang` | 查看或设置学习目标语言与母语（如 `/lang native zh`、`/lang target en`） |
| `/dismiss` | **[新增]** 临时隐藏当前写作检查/复习面板，下次提问自动恢复 |
| `/flashcards` | 浏览、管理已保存的生词与短语 |
| `/review` | 开启交互式单词复习会话 |

---

## 安装

在 Pi 中直接安装本地扩展：

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/pi-language-tutor
```

若修改了依赖或代码，可进入目录执行：

```zsh
cd ~/Projects/Pi-extension-dev/extensions/pi-language-tutor
npm install
```

在 Pi 中运行 `/reload` 即可加载生效。

---

## 许可

本项目整体基于 GPL-3.0 聚合分发。
本插件保留原作者版权：Copyright (c) 2026 Mack (MIT License)。详见 [LICENSE](LICENSE)。
