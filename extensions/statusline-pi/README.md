# statusline-pi

高度紧凑、自适应响应式的 Pi Coding Agent 底部状态栏扩展。

原版基于 [luongnv89/pi-extensions](https://github.com/luongnv89/pi-extensions)，由 **llMooreyll** 进行了深度重构与性能增强。

---

## 核心特性与本地改进

相比上游版本，此定制分支解决了事件循环卡顿，并强化了外观定制与统计精度：

1. **🚀 异步非阻塞 GitHub PR 查询（性能重构）**
   - **痛点解决**：原版通过同步 `execFileSync` 调用 `gh pr view`，每次网络查询耗时 ~1.1 秒，会导致主进程事件循环彻底挂起，终端打字、输入法（IME）上屏和滚动出现严重卡顿掉帧。
   - **优化实现**：改用异步 `execFile` 后台静默抓取，结果就绪后平滑渲染；内置并发请求合并（去重）与分支有效性校验（分支切换后自动丢弃过期的旧查询响应）。
2. **🎨 边框编辑器（Border Editor）与外观定制 (`src/editor.ts`)**
   - 支持动态切换与微调状态栏的边框样式，与全局 TUI 主题完美契合。
3. **⚡ 实时 TPS 速度跟踪器（Speed Tracker, `src/speed.ts`）**
   - 实时采集流式响应中的 Token 产出速度（tokens/s），并平滑维护历史平均响应速度；在输出中以紧凑 `tps` 呈现。
4. **📊 统一的上下文水位计算（Context Zone）**
   - 统一了上下文区间（Zone）的水位占比计算公式，消除不同模型上下文窗口下的比例偏差，更准确地预警上下文逼近上限。
5. **📱 窄屏自适应多行折叠**
   - 当终端宽度不足时，自动折叠为安全的多行排版，确保长分支名、PR 编号、费用与速度信息不会互相遮挡或溢出截断。

---

## 状态栏显示格式

```text
当前目录 │ 分支 [未暂存/暂存文件数] PR #编号 │ 会话累计费用 │ CPU % · MEM % │ 剩余上下文 (百分比) 水位图标 │ 响应速度 │ 模型信息
```

### 示例

```text
pi-extensions │ main [2] PR #12 │ $0.18 │ CPU 42% · MEM 68% │ (^_^) 840,037 (84.0%) Plan │ 42.5 tps │ openai-codex/gpt-5.5
```

### 上下文水位指示符（Pac-Man 表情）

| 水位分区 | 图标 | 说明 |
|---|---|---|
| **Plan** | `(^_^)` | 上下文充足，从容规划 |
| **Code** | `(>_>)` | 空间适中，适合高强度编码 |
| **Dump** | `(~_~)` | 正在构建高密度上下文 |
| **ExDump** | `(!_!)` | 接近上下文极限（OpenAI GPT 超过 272k 时自动触发费率告警） |
| **Dead** | `(x_x)` | 上下文基本耗尽 |

---

## 命令

| 命令 | 说明 |
|---|---|
| `/statusline-pi` | 开启 / 关闭自定义状态栏 |
| `/statusline-refresh` | 强制异步刷新 Git 变更数与 GitHub PR 状态 |

---

## 安装与配置

在 Pi 中安装本本地扩展：

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/statusline-pi
```

若修改了源码，需重新构建：

```zsh
cd ~/Projects/Pi-extension-dev/extensions/statusline-pi
npm run build
```

在 Pi 中运行 `/reload` 即可热生效。

---

## 许可

MIT License — 原作者保留版权：Copyright (c) 2024 luongnv89。详见 [LICENSE](LICENSE)。
