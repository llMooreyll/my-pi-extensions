# pi-interactive-subagents

为 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 提供多窗格非阻塞子代理（Subagent）与长期协同团队（Team Mode）支持。

原版基于 [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)，由 **llMooreyll** 进行了大规模深度开发与架构增强，扩展了**多模型自动回退链**、**长期存活团队协作模式（Worktree 隔离）**与**高可靠性生命周期监管**。

---

## 核心新特性（本地重大增强）

### 1. 🔄 有序模型回退链（Ordered Model Fallback Chain）
- **多模型配置**：允许在 Agent 定义（frontmatter `model` 字段）或 `subagent({ model: "..." })` 中传入逗号分隔的模型序列：
  ```yaml
  model: zero-cat/deepseek-v4.1-flash-1017,antigravity-vps/gemini-3.8-flash-high,claude-vps/claude-haiku-5-5
  ```
- **派生前凭据校验**：主 Agent 派生子 Agent 前会自动核对凭据，跳过不可用模型；当链上全部模型不可用时，拒绝盲目派生并请求用户介入。
- **自动无缝故障转移**：子 Agent 在遭遇提供商限流、网络故障或模型异常并在消耗完 Pi 内部重试次数后，自动切换至链中的下一个模型继续执行任务；若整条链路耗尽，则回传完整的故障尝试日志。

### 2. 👥 长期存活团队模式（Team Collaboration Suite）
不同于一次性、只读的 `subagent`，团队模式支持长驻的多角色独立协作：
- **独立的 Git Worktree 开发空间（`write: true`）**：
  为可写入的团队成员（Worker）自动分配独立的 Git worktree 和私有分支（`pi-team/<name>`）。成员在其专有目录中执行代码修改与测试，绝不污染主代理的工作区。
- **安全的成果集成机制**：
  - `team_integrate`：将写成员已提交的代码以未暂存（unstaged）形式合并回主工作树，发生冲突时保持主工作树安全无损。
  - `team_sync`：将主工作树的最新变更一键同步给空闲的写成员。
- **双向信箱与指令分发**：
  通过 `team_send` 与成员持续对话，支持 `urgent: true` 紧急插队递送。
- **主题化专属界面**：
  支持全局主题的 Team Banner 横幅、实时状态窗格（Member List、状态流转）与边框高亮。

### 3. 🛡️ 稳健的生命周期治理（agent_before_settle 与 .exit Sidecar）
- **杜绝过早关闭**：原版在 `agent_end` 触发时即尝试退出，导致网络瞬态故障在 Pi 重试前误触发退出关闭窗格。现将判定逻辑延后至 `agent_before_settle`，确保重试流程完整执行完毕。
- **统一 Sidecar 信号**：正常完成与异常结束均写入确定性的 `.exit` sidecar 文件，主会话无竞态、零轮询捕获子 Agent 终态。

### 4. 🏷️ 会话标签标准化
所有派生的子代理会话自动附加 `<subagent:name>` 标签，方便在进程管理器与历史记录中快速检索。

---

## 工具生态（Tools）

### 一次性代理调度（只读 / 独立任务）
- `subagent({ name, agent, task, model, tools, ... })`：派生异步子代理，立即返回，完成后自动回传结果（Steer message）。
- `subagent_interrupt({ name, id })`：向正在运行的子 Agent 发送中断信号（Escape），保持窗格存活。
- `subagent_resume({ sessionPath, ... })`：恢复此前意外中断的子 Agent 会话。
- `subagents_list`：列出全局与项目本地可用的子 Agent 规范文件。

### 团队模式协作（长期存活 / 独立 Worktree）
- `team_spawn({ name, agent, task, write, ... })`：派生长期成员，`write: true` 自动创建 Git worktree。
- `team_send({ to, message, urgent })`：向团队成员发送后续任务或指示。
- `team_list`：查看当前团队所有成员的状态、分支与最新进展。
- `team_integrate({ name })`：集成写成员的成果到主工作区。
- `team_sync({ name })`：同步主工作区最新代码至成员 worktree。
- `team_interrupt({ name })` / `team_stop({ name })`：暂停当前轮次或安全关闭成员。

---

## 终端复用器支持（Multiplexers）

支持在以下复用器中全自动分屏：
- **cmux**：原生长驻侧边栏集成
- **tmux**：`tmux new -A -s pi`
- **zellij**：`zellij --session pi`
- **WezTerm**：原生终端标签与分屏

---

## 安装与使用

在 Pi 中安装本本地扩展：

```zsh
pi install ~/Projects/Pi-extension-dev/extensions/pi-interactive-subagents
```

在 Pi 中输入 `/reload` 重新加载。

---

## 许可

本项目整体基于 GPL-3.0 聚合分发。
本插件核心历史与组件保留原作者版权：Copyright (c) 2026 HazAT (MIT License)。详见 [LICENSE](LICENSE)。
