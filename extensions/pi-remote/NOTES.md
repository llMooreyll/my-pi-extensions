# pi-remote 实现记录

记录实现过程中与 plan.md 不一致的地方、实测事实和取舍。

## 环境（M0）

- Android 命令行工具装在 `~/Android/Sdk`；`~/.zshrc` 末尾追加了 `pi-remote android env` 标记块（JAVA_HOME=JDK 17、ANDROID_HOME、PATH）。
- `loginctl enable-linger moorey` 成功，`Linger=yes`。
- `@getpaseo/relay@0.15.3` 的 npm 包没有 license 字段；源码仓库 getpaseo/paseo 为 Apache-2.0。

## 与计划的偏差

1. **`pi.sendUserMessage()` 返回 `void`，不是 Promise**（`dist/core/extensions/types.d.ts:1290`；实现在 `agent-session.js:2792`，错误交给 `runner.emitError`，扩展拿不到）。
   - `prompt` op 无法按计划用"400ms 内失败视为拒绝"。改为发送前自行检查：运行中且未指定 deliverAs → `busy_need_deliver_as`；无模型 → `no_model`；模型不支持图片 → `model_no_image`。之后的失败（例如认证失败）只会显示在电脑 TUI 上，App 只能看到"已接受"但没有 agent_start。
   - 以 `/` 开头的输入在运行中默认用 `followUp`：扩展命令会立即执行（不受影响），模板/技能需要投递方式，否则 pi 抛错。
   - `runWithCommandCtx` 加了 30 秒"命令未被执行"超时，避免 remoteOps 表泄漏。
2. **`/tree` 跳转后发 `session_changed{reason:"tree"}`**：`navigateTree` 不替换会话，但活动分支变了，App 需要重新拿快照。bridge 订阅 `session_tree` 事件发出该事件。
3. **`display: false` 的自定义消息不转发**（快照里本来就不含），避免 App 显示隐藏消息。`custom_message` 的线上形态额外带了 `details`（7.6.5 的卡片需要 `details.name` 等）。
4. **会话替换时清空 extStatus / extWidgets / 未关闭的问卷**：客户端会因 `session_changed` 重新拿快照，新会话的扩展会重新设置状态与 widget。
5. **`conflict_live_elsewhere` 的 message 就是目标 processId**（不带其他文字），App 直接用它跳转。
6. bridge 重连 hostd 时，`hello.info.lastSeq` 取"队列中第一条未送达事件的 seq - 1"，保证 hostd 的环形缓冲与补发连续。
7. hostd 的 `EventRing.since(seq)` 在 `seq > lastSeq` 时返回 null（走快照），而不是空数组。
8. `get_settings` 用 `SettingsManager.getGlobalSettings()`（只读全局设置），与只写全局设置一致。
9. hostd 读写路径支持环境变量 `PI_REMOTE_CONFIG_DIR` 覆盖（只用于测试），dev-client 凭据路径支持 `PI_REMOTE_DEV_CLIENT` 覆盖。
10. **bridge 在 `ExtensionRunner.prototype.setUIContext` 上挂钩打补丁**（仅限 `SUPPORTED_PI_VERSIONS`）。原因：`session_start` 是第一个事件，加载顺序在 bridge 之前的扩展（包括 `-e` 指定的扩展）在它们自己的 `session_start` 里设置的 widget/status 会漏掉。实测 rpc-demo（`-e` 加载）的 widget 因此能出现在快照里。另外把 bridge 移到了 `~/.pi/agent/settings.json` 的 `packages` 第一位（其余字段未动）。
11. **状态文字去掉 ANSI 转义并去重**：run-timer 等扩展每秒刷新状态，内容不变时不再转发。字符串数组 widget 也去掉 ANSI。
12. **role 为 `system` 的消息不转发**：pi 1.5.0 每次运行会发出一条 `role:"system"` 的系统提示消息（`agent-session.js:1346`），体积大且不应显示。快照/历史同样过滤。
13. compat 为 `untested` 时 notify/status/widget 也不转发（它们与对话框包装在同一个 `patchUi` 里），与计划代码一致。
14. 测试用的默认模型 `zero-cat/deepseek-v4.1-flash-1017` 余额不足（403 insufficient_user_quota），验收中用 `--model antigravity-vps/gemini-3.8-flash-high` 启动 pi；`set_model` 实测不会改写 settings.json 的 defaultModel。

## M5～M6 实测

15. **spawner 启动失败时保留 pane**：计划的 `exec pi ...` 在命令不存在时 pane 立即消失，`spawn_timeout` 拿不到输出。改为 `pi ... || { echo "[pi-remote] pi exited with code $?"; sleep 120; }`，正常退出（code 0）时窗口照常关闭；超时报告输出后主动 `kill-pane`。用户的 zshrc 会打印 fastfetch，所以报错文本里会先出现那段 logo。
16. `SettingsManager` 写回 settings.json 时去掉了文件末尾换行；验收后已把 settings.json 恢复为修改前的原字节（`cmp` 一致，`packages` 中 bridge 移到首位这一项除外）。
17. 中继已部署到 TencentVPS：容器 `pi-relay`（`--restart unless-stopped`，端口 7443），镜像在 VPS 上本地构建，npm 直连可用；中继密钥在本机 `~/.config/pi-remote/relay-secret`。
18. M6 验收第 3 条"另一个网络的电脑经中继访问"没有可用的第二台电脑；本机经中继访问成功，M7 中 Waydroid 也经中继访问。第 6 条"本机断网"无 sudo 无法模拟，改为把 VPS 上的 pi-relay 停 60 秒再启动，检查 hostd 自动恢复。
19. hostd 已安装为 systemd 用户服务（`~/.config/systemd/user/pi-hostd.service` 是指向仓库的符号链接）。
