# statusline-pi

Pi Coding Agent 的底部状态栏扩展。基于 [luongnv89/pi-extensions](https://github.com/luongnv89/pi-extensions) 修改。

## 本地修改

1. **异步 GitHub PR 查询**：
   - 原版使用同步 `execFileSync` 调用 `gh pr view`，在网络较慢时阻塞 Node.js 事件循环约 1 秒，造成终端打字、光标移动和输入法选词停顿。
   - 改为异步 `execFile` 查询，查询期间不阻塞主循环；增加分支有效性检查（分支切换后丢弃过期的旧响应）以及并发去重。
2. **输入框边框显示状态**：
   - 增加 `src/editor.ts`，把模型、思考档位、上下文用量和响应速度画在输入框的上下边框上，底栏只保留其余信息。
   - 边框通过覆盖已有输入框实例的 `renderTopBorder` / `renderBottomBorder` 实现，不替换输入框组件，其他装饰输入框的扩展（如 pi-input-plus）可与它叠加，加载顺序不影响结果；`/statusline-pi` 关闭时恢复输入框自带边框。
   - 边框始终只占一行，内容放不下时先截断右侧，再截断左侧。pi-input-plus 按“上下边框各一行”判断点击位置，依赖这一点。
3. **响应速度统计**：
   - 增加 `src/speed.ts`，统计模型输出速度，在下边框右侧显示平滑后的 `tok/s`（生成中带 `~`）与首字延迟 `TTFT`。
4. **统一上下文区间计算**：
   - 统一各上下文阶段（Plan、Code、Dump、ExDump、Dead）的使用比例计算逻辑。
5. **窄屏折行适配**：
   - 终端宽度不足时底栏自动折行为多行显示，防止分支名或统计数据被截断；边框在宽度小于 72 列时改用精简格式。
6. **其他扩展的状态显示在边框上**：
   - 其他扩展只需调用 `ctx.ui.setStatus(key, text)`；`src/index.ts` 中的 `BORDER_STATUS_SLOTS` 决定哪些 key 画在边框上，这些 key 不再出现在底栏。
   - 目前只登记了 `cache-timer`（[pi-cache-timer](../pi-cache-timer) 的缓存倒计时），位置是下边框左侧。
   - 文字中的换行与制表符替换为空格。关闭 statusline-pi 后，这些状态回到 Pi 默认底栏显示。

## 显示格式

输入框边框：

```text
─ 提供商/模型 · think 档位 ──────────────────── 上下文进度条 百分比 已用/窗口 水位 ─
  （输入区）
─ 边框状态（如缓存倒计时） ──────────────────── 输出速度 TTFT ─
```

底栏：

```text
当前目录 │ 分支 [变更文件数] PR #编号 │ 会话累计费用 │ CPU % · MEM % │ 其他扩展状态
```

示例：

```text
─ claude-vps/claude-opus-5-5 · think high ──────── ▰▰▱▱▱▱▱▱▱▱ 18% 180k/1M (^_^) Plan ─
─ cache 42m ───────────────────────────────────── 42.5 tok/s TTFT 1.8s ─
/home/user/project │ main [2] PR #12 │ $0.18 │ CPU 42% · MEM 68%
```

上下文刚压缩完、Pi 尚未拿到新用量时，进度条显示 `?`。

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
| `/statusline-pi` | 切换底栏与输入框边框状态的开启/关闭 |
| `/statusline-refresh` | 手动触发 Git 变更数与 PR 状态刷新 |

## 安装与构建

安装本地扩展：

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/statusline-pi
```

Pi 按 `package.json` 中的 `pi.extensions` 直接加载 `src/index.ts`，修改源码后在 Pi 中执行 `/reload` 即可生效，不需要构建。

`npm run build` 只更新 `dist/`，供 npm 发布和 `test/` 下的测试使用（测试从 `dist/` 导入）：

```zsh
cd ~/Projects/Pi-extension-dev/extensions/statusline-pi
npm test
```

## 许可

MIT 许可证，保留原作者版权声明：Copyright (c) 2024 luongnv89。详见 [LICENSE](LICENSE)。
