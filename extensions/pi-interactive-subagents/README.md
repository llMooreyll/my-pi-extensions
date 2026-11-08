# pi-interactive-subagents

在终端复用器分屏中运行非阻塞子代理（Subagent）与长期协同团队（Team）。基于 [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) 修改。

## 本地修改

1. **有序模型回退链（Ordered Model Fallback Chain）**：
   - 支持在 Agent frontmatter 或 `subagent` 参数的 `model` 字段中传入逗号分隔的模型列表（如 `providerA/model1,providerB/model2`）。
   - 派生前核对凭据，跳过不可用模型；全不可用时终止派生。
   - 子代理遇到错误并在耗尽 Pi 内置重试后，在 `agent_before_settle` 阶段自动切换到下一个模型继续执行任务；若链上模型全部失败，返回包含各次尝试详情的错误报告。
2. **长期存活团队模式（Team Tools）**：
   - 增加长期协作工具集：`team_spawn`、`team_send`、`team_list`、`team_integrate`、`team_sync`、`team_interrupt`、`team_stop`。
   - 写成员隔离（`write: true`）：自动建立专有 Git worktree 与分支（`pi-team/<name>`），修改和提交在独立目录内进行，不污染主工作区。
   - 结果集成与同步：`team_integrate` 将写成员的提交以未暂存形式合并到主树，冲突时保持主树不变；`team_sync` 将主树状态同步给空闲写成员。
   - 增加团队成员状态面板与横幅 UI。
3. **退出信号时序修复**：
   - 原版在 `agent_end` 事件触发时即判定退出，在遭遇瞬态网络错误时会导致子代理在 Pi 尚未完成自动重试前过早写入错误信号并关闭窗格。现将退出处理移至 `agent_before_settle`。
   - 正常完成统一写入 `.exit` sidecar 文件，主进程通过文件状态感知结束。
4. **会话标签**：
   - 派生的子代理会话命名添加 `<subagent:name>` 标签。

## 工具列表

### 单次子代理调度（subagent）
- `subagent({ name, agent, task, model, tools, ... })`：派生异步子代理，立即返回，执行结束后自动递送结果。
- `subagent_interrupt({ name, id })`：向运行中的子代理发送中断信号（Escape），不关闭窗格。
- `subagent_resume({ sessionPath, ... })`：恢复中断的子代理会话。
- `subagents_list`：列出可用的子代理定义文件。

### 团队模式（team）
- `team_spawn({ name, agent, task, write, link, ... })`：派生长期成员；`write: true` 时创建独立的 Git worktree。
- `team_send({ to, message, urgent })`：向团队成员发送消息。
- `team_list`：查看当前团队成员状态、分支和最新活动。
- `team_integrate({ name })`：将写成员已提交的变更应用到主工作区（未暂存）。
- `team_sync({ name })`：将主工作区当前内容同步到空闲写成员的 worktree。
- `team_interrupt({ name })`：中断成员当前轮次。
- `team_stop({ name })`：关闭成员并清理窗格。

## 支持的终端复用器

- cmux
- tmux（`tmux new -A -s pi`）
- zellij（`zellij --session pi`）
- WezTerm

## 安装

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/pi-interactive-subagents
```

在 Pi 中执行 `/reload` 重新加载。

## 许可

整体作为 GPL-3.0 作品分发。
原项目部分保留原作者版权：Copyright (c) 2026 HazAT (MIT License)。详见 [LICENSE](LICENSE)。
