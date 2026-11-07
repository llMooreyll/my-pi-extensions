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
