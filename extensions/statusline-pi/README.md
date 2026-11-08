# statusline-pi

Pi Coding Agent 的底部状态栏扩展。基于 [luongnv89/pi-extensions](https://github.com/luongnv89/pi-extensions) 修改。

## 本地修改

1. **异步 GitHub PR 查询**：
   - 原版使用同步 `execFileSync` 调用 `gh pr view`，在网络较慢时阻塞 Node.js 事件循环约 1 秒，造成终端打字、光标移动和输入法选词停顿。
   - 改为异步 `execFile` 查询，查询期间不阻塞主循环；增加分支有效性检查（分支切换后丢弃过期的旧响应）以及并发去重。
2. **边框样式设置**：
   - 增加 `src/editor.ts`，支持修改状态栏边框显示样式。
3. **响应速度统计**：
   - 增加 `src/speed.ts`，统计模型输出的 tokens/s，并在状态栏显示平滑后的平均速度（`tps`）。
4. **统一上下文区间计算**：
   - 统一各上下文阶段（Plan、Code、Dump、ExDump、Dead）的使用比例计算逻辑。
5. **窄屏折行适配**：
   - 终端宽度不足时自动折行为多行显示，防止分支名或统计数据被截断。

## 状态栏格式

```text
当前目录 │ 分支 [变更文件数] PR #编号 │ 会话累计费用 │ CPU % · MEM % │ 剩余上下文 (百分比) 水位状态 │ 平均速度 │ 提供商/模型
```

示例：

```text
pi-extensions │ main [2] PR #12 │ $0.18 │ CPU 42% · MEM 68% │ (^_^) 840,037 (84.0%) Plan │ 42.5 tps │ openai-codex/gpt-5.5
```

上下文水位标识：

| 水位 | 文本图标 | 说明 |
|---|---|---|
| Plan | `(^_^)` | 上下文余量充足 |
| Code | `(>_>)` | 正常编码空间 |
| Dump | `(~_~)` | 上下文占用较高 |
| ExDump | `(!_!)` | 接近上限（OpenAI GPT 达到 272k 时提示单价翻倍） |
| Dead | `(x_x)` | 上下文基本耗尽 |

## 命令

| 命令 | 说明 |
|---|---|
| `/statusline-pi` | 切换状态栏开启/关闭 |
| `/statusline-refresh` | 手动触发 Git 变更数与 PR 状态刷新 |

## 安装与构建

安装本地扩展：

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/statusline-pi
```

修改 TypeScript 源码后需重新构建：

```zsh
cd ~/Projects/Pi-extension-dev/extensions/statusline-pi
npm run build
```

在 Pi 中执行 `/reload` 重新加载。

## 许可

MIT 许可证，保留原作者版权声明：Copyright (c) 2024 luongnv89。详见 [LICENSE](LICENSE)。
