# pi-remote 完整验收清单

> 读者：负责执行一轮完整验收的 AI agent。
> 目标：逐条执行本文的检查，记录每一条的实际结果，最后交一份报告。**不要修改项目代码**。发现问题只记录现象、复现步骤和证据，不要修复。
> 设计背景见同目录的 `plan.md`（第 6 章协议、第 7 章组件、第 10 章端到端清单），实现中的偏差见 `NOTES.md`。两者与本文冲突时，以本文为准。

---

## 0. 必须遵守的规则

### 0.1 省钱：所有 AI 一律用 Gemini 3.8 Flash，思考关闭

本次验收中，凡是会调用大模型的地方，都必须使用 `antigravity-vps/gemini-3.8-flash-high`，并把思考级别设为 `off`。只有思考设为 `off` 失败时，才允许改用 `minimal` 或 `low`，并在报告中注明。具体要求如下：

| 场景 | 做法 |
|---|---|
| 你自己（验收 agent） | 由用户启动时指定。你派生的 subagent / team 成员一律传 `model: "antigravity-vps/gemini-3.8-flash-high:off"`，不传就不要派生 |
| 你手动启动的被测 pi | `pi --model antigravity-vps/gemini-3.8-flash-high --thinking off ...` |
| hostd 启动的 pi（`open_session` / `new_process` / App 里的"打开会话""新会话"） | 这类 pi 用全局默认模型 `zero-cat/deepseek-v4.1-flash-1017`，该模型**余额不足、一定会返回 403**。进程启动后，先用 App 的 `/model`（或 `dev-client op set_model`）切到 `antigravity-vps/gemini-3.8-flash-high`，再用 `/thinking` 切到 `off`，然后才能发消息。这本身也是 M7f 的测试内容 |
| 让被测 pi 启动子 agent / team 成员 | 在提示词里写明工具参数 `model` 为 `"antigravity-vps/gemini-3.8-flash-high:off"`。`researcher` 等 agent 定义里的模型链第一项是 zero-cat，会先失败再回退，既浪费时间又多花钱 |
| 读图 | 用户全局 AGENTS.md 规定的 `zhipu/glm-4.6v-flashx`，这是唯一例外，也尽量少用。能用 `tools/wd.mjs state` / `labels` 判断的，就不要截图 |

其他省钱要求：

- 给被测 pi 的提示词尽量短，结果要确定。不需要工具时写 `Do not use any tools.`。
- 用户全局 AGENTS.md 会让模型在回答末尾追加中文 recap，这是正常现象，不算缺陷。
- **禁止**修改 `~/.pi/agent/settings.json` 里的 `defaultModel` / `defaultProvider`。`set_model` 只改当前进程（已实测不会写进 settings.json），可以放心用。

### 0.2 安全边界

- 禁止 `sudo`。禁止修改 `extensions/pi-remote/` 以外的项目文件。禁止 `git commit`、`git stash`、`git checkout`、`git reset`。只读的 git 命令可以用。
- VPS（`ssh TencentVPS`）上**只允许**以下操作：
  - `docker logs pi-relay`
  - `docker restart pi-relay`
  - `docker stop pi-relay` / `docker start pi-relay`（停机时间不超过 2 分钟）
  - `docker ps`

  **不得碰** `blog`、`st-proxy`、`sillytavern`、`emb-proxy` 这几个容器，也不得改系统配置。
- Waydroid 中不得修改系统设置、输入法、其他应用，也不得卸载或重置 Waydroid。允许安装、卸载、清数据 `dev.moorey.piremote`。
- 不得关闭用户自己的 pi 进程。只操作你自己创建的 tmux 会话，以及 tmux 会话 `pi-remote` 里由 hostd 启动的 pi。`tmux ls` 中的会话 `0` 属于用户，不要碰。
- 被测 pi 拥有完整工具权限。让它执行"危险命令"时，只用 `/tmp/pr/` 下**不存在**的路径，例如 `rm -rf /tmp/pr/nothing-xyz`，并且只用于触发确认框。
- 改动任何全局状态之前先备份，测完恢复：
  - `~/.pi/agent/settings.json` → `cp` 到 `/tmp/pr/acc/settings.json.orig`
  - `~/.config/pi-remote/` → `cp -a` 到 `/tmp/pr/acc/pi-remote-config.orig`

  恢复后用 `cmp` / `diff -r` 证明与备份一致。

### 0.3 证据与报告

每条检查记录四项：**编号、结果（PASS / FAIL / BLOCKED / SKIP）、证据、备注**。证据可以是命令输出片段、`wd.mjs state` 的 JSON、日志行或截图路径。FAIL 必须附复现步骤。报告格式见第 14 章。

---

## 1. 系统组成与当前状态（验收开始时）

```
Android App (Waydroid / 真机)  ──ws──>  VPS 中继 pi-relay (62.234.87.78:7443, Docker)  <──ws──  本机 pi-hostd (systemd 用户服务)
                                 └─────────────── 可选直连 ws://<IP>:7444 ───────────────┘            │ Unix socket
                                                                                                      ▼
                                                                    每个 TUI 模式 pi 进程里的 bridge 扩展 (pi-remote-bridge)
```

- 项目根目录：`/home/moorey/Projects/Pi-extension-dev/extensions/pi-remote`（下文的相对路径都以它为准）。
- hostd：`systemctl --user status pi-hostd`。日志在 `journalctl --user -u pi-hostd` 和 `~/.local/state/pi-remote/hostd.log`。
- 配置：`~/.config/pi-remote/`，包括：
  - `identity.json`、`config.json`、`devices.json`
  - `dev-client.json`（命令行调试客户端的凭据）
  - `relay-secret`（中继密钥，**不要打印到报告里**）
- bridge 日志：`~/.local/state/pi-remote/bridge-<pid>.log`。审计日志：`~/.local/state/pi-remote/audit.jsonl`。
- 中继：VPS 上的 Docker 容器 `pi-relay`，健康检查地址 `curl --noproxy '*' http://62.234.87.78:7443/healthz`。
- bridge 已通过 `pi install` 加入 `~/.pi/agent/settings.json` 的 `packages`，位于第一位。之后启动的每个 TUI pi 都会加载它。
- 直连：当前是**关闭**的（`pi-hostd direct disable`）。App 经中继连接。
- App：Waydroid 中装的是**调试版**（只含 x86_64，开启了测试钩子），依赖 Metro。Metro 跑在 tmux 窗口 `prdev:metro`，监听 8081 端口，带 `EXPO_PUBLIC_TEST_HOOKS=1`。这台 Waydroid 已与本机 hostd 配对。
- 之前测试留下的 tmux 会话：
  - `prdev`：窗口 `hostd`（空 shell）、`relay`（本地测试中继，端口 7450，密钥 `dev`）、`metro`
  - `prt1`：加载了 rpc-demo 扩展的测试 pi
  - `pi-remote`：hostd 启动的 pi

  可以复用，也可以关掉重开，不影响用户。

### 1.1 常用命令简写

```zsh
cd ~/Projects/Pi-extension-dev/extensions/pi-remote
H="node packages/hostd/src/main.ts"                        # pi-hostd CLI
DC="node packages/hostd/scripts/dev-client.ts --via relay" # 命令行客户端（经 VPS 中继）
DCD="node packages/hostd/scripts/dev-client.ts --via direct"
W="node tools/wd.mjs"                                      # Waydroid 界面助手
mkdir -p /tmp/pr/acc
```

dev-client 子命令：
- `procs`
- `sessions [cwd]`
- `listen`：持续打印 proc 帧
- `watch <processId> [sinceSeq]`：先打印 subscribe 结果，再持续打印 evt
- `prompt <pid> <text>`
- `ui <pid> <uiId> '<json>'`
- `op <opName> '<json>'`
- `pair '<PairQr JSON>'`

全局开关 `--dump-wire` 会把外层原始帧打印到 stderr。用环境变量 `PI_REMOTE_DEV_CLIENT=/path.json` 可以使用另一份凭据，用来模拟第二台设备，**不要覆盖默认凭据**。

`watch` / `listen` 是长期运行的命令，要放到后台并重定向到文件：

```zsh
($DC watch $P > /tmp/pr/acc/watch.out 2>&1 &)
pkill -f '^node packages/hostd/scripts/dev-client.ts'   # 结束；只能用这个写法，不要用会匹配到 shell 自身命令行的 pkill -f 模式
```

### 1.2 Waydroid 界面助手 `tools/wd.mjs`

先执行 `adb connect 192.168.240.112:5555`，确认 `adb devices` 中状态为 `device`。若为 `unauthorized`，进入人工检查点，请用户在 Waydroid 弹窗中勾选 "Always allow"。若 `waydroid status` 中 Session 不是 RUNNING，执行 `waydroid session start &` 并等待最多 90 秒。

| 命令 | 作用 | 说明 |
|---|---|---|
| `$W press <label>` | 通过测试钩子"按下"一个按钮或卡片 | **首选**。不依赖坐标，界面不停刷新时也能用 |
| `$W type <label> '<text>'` | 通过测试钩子把文字写入输入框 | 支持中文。Waydroid 的拼音键盘无法用 `input text` 打字 |
| `$W labels` | 列出当前已注册的可操作标签 | 页面栈里仍挂载的下层页面也会出现在列表中 |
| `$W haslabel <label 或 前缀*>` / `$W waitlabel <label> [秒]` | 判断标签是否存在，或等它出现 | |
| `$W state` | 输出 store 摘要 JSON | 字段：`conn`、`via`、`lastError`、`processes[]`、`active`，以及 `view{seq,status,messages,lastRole,lastText,inflight,pendingUi,pendingRpiv,extWidgets,resyncing,gone}` |
| `$W dump` / `$W tap <label>` / `$W wait <text>` | 基于 uiautomator 的界面读取和坐标点击 | 只在界面静止时可靠。pi 运行中（状态栏每秒刷新）时 uiautomator 会一直等界面空闲，非常慢 |
| `$W back` / `$W key <KEYCODE>` | 返回键 / 任意按键 | |

调用时出现的 `Warning: Activity not started, intent has been delivered...` 是正常输出，可以忽略。

需要看画面时：`adb -s 192.168.240.112:5555 exec-out screencap -p > /tmp/pr/acc/xx.png`，再按用户全局 AGENTS.md 的"读图"规则处理。尽量少用。

**常用标签**（完整列表在实际界面上用 `$W labels` 查看）：

| 页面 | 标签 |
|---|---|
| 首页 | `conn-bar` `conn-state` `conn-via` `conn-error` `home-new` `home-settings` `home-no-procs` `home-busy` `proc-<processId>` `proc-status-<processId>` `project-<目录名>` `project-new-<目录名>` `session-item-<序号>` |
| 配对 | `pair-scan-button` `pair-text-input` `pair-text-submit` `pair-error` `pair-confirm-card` `pair-confirm-host` `pair-confirm-button` `pair-confirm-cancel` `pair-busy` `pair-back` |
| 信任对话框 | `trust-dialog` `trust-approve` `trust-deny` `trust-remember`（开关，测试钩子按不到，需要用 `$W tap`） `trust-cancel` |
| 会话页 | `session-title` `chip-model` `chip-thinking` `chip-parent` `session-role` `session-ext-status` `child-strip` `child-<processId>` `session-gone` `session-reopen` `transcript` `transcript-load-more` `transcript-jump-latest` `msg-<序号>` `msg-inflight` `tool-toggle-<toolCallId>` `tool-showall-<id>` `tool-open-child-<id>` `patch-view` `thinking-*` `toast` `widget-<key>` `session-confirm` `session-confirm-yes` `session-confirm-no` |
| 输入栏 | `composer-input` `composer-send` `composer-image` `composer-mode-steer` `composer-mode-followup` `composer-stop` `composer-hint` `slash-menu` `slash-<命令名>` `composer-image-<序号>` |
| 对话框卡片 | `ui-card` `ui-title` `ui-option-<序号>` `ui-input` `ui-submit` `ui-confirm` `ui-cancel` `ui-custom-cancel` `ui-submitted` |
| 问卷 | `rpiv-card-<toolCallId>` `rpiv-sheet` `rpiv-option-<序号>` `rpiv-text` `rpiv-next` `rpiv-prev` `rpiv-submit` `rpiv-decline` `rpiv-error` |
| 弹层（Sheet） | `<sheet>-close`；`model-sheet` `model-<provider>/<id>` `model-error`；`thinking-sheet` `thinking-<级别>`；`tree-sheet` `tree-filter-<f>` `tree-node-<entryId>` `tree-confirm` `tree-summarize` `tree-instructions` `tree-go` `tree-cancel`；`fork-sheet` `fork-point-<序号>`；`resume-sheet` `resume-scope` `resume-item-<序号>`；`compact-sheet` `compact-input` `compact-run` `compact-error`；`session-sheet` `session-rename` `session-name-input` `session-name-save` `session-shutdown` `session-shutdown-confirm` |
| 设置页 | `setting-<key>` `setting-switch-<key>` `setting-value-<key>` `setting-option-<值>` `settings-relay-input` `settings-direct-input` `settings-save-conn` `settings-test-conn` `settings-test-<序号>` `settings-conn-msg` `settings-scan-endpoint` `settings-endpoint-input` `settings-endpoint-apply` `settings-unpair` `settings-unpair-yes` `settings-keepalive` `settings-notify-child` `settings-battery` `settings-clear-trust` |
| 只读历史页 | `history-readonly` `history-open-live` `history-continue` `history-continue-yes` `history-continue-no` |
| 通用 | `error-dialog` `error-text` `error-close` |

### 1.3 App 的构建与安装

- **调试版**：先确认 `tmux capture-pane -p -t prdev:metro` 中 Metro 在运行。在 Metro 窗口按 `r`（`tmux send-keys -t prdev:metro r`）可以重新加载 JS。修改了原生配置才需要重新构建。
- **重新安装调试版**：
  ```zsh
  adb -s 192.168.240.112:5555 install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
  adb -s 192.168.240.112:5555 reverse tcp:8081 tcp:8081
  adb -s 192.168.240.112:5555 shell pm grant dev.moorey.piremote android.permission.POST_NOTIFICATIONS
  ```
- **启动 / 停止 App**：
  ```zsh
  adb -s 192.168.240.112:5555 shell am start -n dev.moorey.piremote/.MainActivity
  adb -s 192.168.240.112:5555 shell am force-stop dev.moorey.piremote
  ```
- **正式版**（第 12 章用）：
  ```zsh
  cd apps/mobile/android && JAVA_HOME=/usr/lib/jvm/java-17-openjdk ANDROID_HOME=$HOME/Android/Sdk ./gradlew assembleRelease
  ```
  产物是 `app/build/outputs/apk/release/app-release.apk`。**构建时环境中不能有 `EXPO_PUBLIC_TEST_HOOKS`**。首次构建约需 10 分钟。

---

## 2. 准备工作（P）

| # | 操作 | 预期 |
|---|---|---|
| P1 | 按 0.2 备份 settings.json 和 `~/.config/pi-remote` | 备份文件存在 |
| P2 | `npm run typecheck`（项目根目录） | 无输出错误，退出码 0 |
| P3 | `systemctl --user is-active pi-hostd`；`$H relay show` | `active`；`status: connected` |
| P4 | `curl --noproxy '*' -s http://62.234.87.78:7443/healthz` | `{"ok":true,"hosts":1,...}`，hosts ≥ 1 |
| P5 | `adb connect` Waydroid，`$W state` | `conn:"ready"`，`via:"relay"` |
| P6 | 启动一个**测试 pi A**（加载 rpc-demo，用于对话框测试）：`tmux new-session -d -s acc1 -x 200 -y 50 -c "$PWD" "pi --model antigravity-vps/gemini-3.8-flash-high --thinking off -e /usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/rpc-demo.ts"`，等 8 秒后执行 `$DC procs` | 列表里出现新进程：`cwd` 为项目根目录，`model.id` 为 `gemini-3.8-flash-high`，`thinkingLevel` 为 `off`，`compat` 为 `ok`，`spawnedByHostd` 为 false，`role.kind` 为 `main`，`tmuxPane` 有值。记下它的 processId，记为 `$PA` |
| P7 | `tmux capture-pane -p -t acc1` | TUI 画面正常，没有 bridge 输出的杂字（例如 JSON、"connected"、堆栈） |

---

## 3. hostd 命令行（C）

| # | 操作 | 预期 |
|---|---|---|
| C1 | `ls -la ~/.config/pi-remote` | 目录权限 `drwx------`；`identity.json`、`config.json`、`devices.json`、`dev-client.json`、`relay-secret` 都是 `-rw-------` |
| C2 | `$H init` | 拒绝执行，提示 identity 已存在、需要 `--force`，退出码 1。**不要**真的执行 `--force` |
| C3 | `$H` 不带参数；`$H bogus` | 打印用法。第二条退出码为 1 |
| C4 | `$H relay set http://x:1 --secret a`；`$H relay set ws://x:1/path --secret a`；`$H relay set ws://x:1` | 前两条报 URL 格式错误，第三条报缺少 secret。三条都不修改 config.json（`cmp` 备份） |
| C5 | `$H pair --json` | 输出一行合法 JSON：`v:2`、`kind:"pair"`、`hostId`、`hostKey`、`hostName`、`relays:["ws://62.234.87.78:7443"]`，没有 `direct` 字段，`code` 形如 `XXXX-XXXX`，字符集不含 `0`、`O`、`1`、`I`、`L` |
| C6 | `$H pair`（不带 --json） | 终端打印二维码、配对码和 JSON |
| C7 | `$H qr --json` | `kind:"endpoint"`，不含 `code` |
| C8 | `$H devices list` | 至少列出 `dev-client` 和 Waydroid 设备（名称以 `Android` 开头）两项，各有 id 和创建时间 |
| C9 | `$H devices revoke 不存在的id` | 输出 `no device ...` |
| C10 | `$H direct enable --advertise ws://192.168.240.1:7444`，5 秒后执行 `curl -s http://192.168.240.1:7444/healthz` 和 `curl -s -o /dev/null -w '%{http_code}' http://192.168.240.1:7444/other` | 前者返回 `{"ok":true}`，后者返回 404。`$H relay show` 显示 direct 为 listening |
| C11 | `$H direct disable`，5 秒后再 curl healthz | 连接被拒绝 |
| C12 | 两个 pi-hostd 同时 serve：`timeout 10 $H serve` | 启动失败或给出明确报错，**不能**把正在运行的 systemd 实例弄坏。之后 `$DC procs` 仍然正常。如果第二个实例抢走了 bridge socket，导致 systemd 实例收不到 bridge，记为 FAIL，并执行 `systemctl --user restart pi-hostd` 恢复 |

---

## 4. 安全与加密（S）

| # | 操作 | 预期 |
|---|---|---|
| S1 | `$DC --dump-wire procs 2>&1 \| head` | 只有第一对帧（`e2ee_hello` / `e2ee_ready`）是可读 JSON。之后的帧都是 base64 或二进制密文，搜不到 `list_processes`、`processes`、`cwd` 等明文 |
| S2 | 复制一份 dev-client 凭据到 `/tmp/pr/acc/dc-badkey.json`，把其中的 `endpoint.hostKey` 换成新生成的随机公钥（`node -e 'import("@getpaseo/relay/e2ee").then(m=>console.log(m.exportPublicKey(m.generateKeyPair().publicKey)))'`，在 packages/hostd 目录下运行）。然后执行 `PI_REMOTE_DEV_CLIENT=/tmp/pr/acc/dc-badkey.json $DC procs` | 握手阶段失败，不能拿到进程列表。hostd 日志里没有该连接的 `client authed` 记录 |
| S3 | 复制凭据，把 `secret` 改成错误值后执行 procs | 输出 `auth failed: unauthorized`。审计日志末尾新增一条 `auth_failed` |
| S4 | 复制凭据，把 `deviceId` 改成不存在的 UUID | 同 S3 |
| S5 | 用 `PI_REMOTE_DEV_CLIENT=/tmp/pr/acc/dc2.json $DC pair "$($H pair --json)"` 配对第二台设备，再用同一个码配对第三台 | 第一次 `paired as ...`；第二次 `pairing failed: invalid_code`（一次性码） |
| S6 | 生成新码后，连续 10 次使用错误码配对（把 JSON 里的 `code` 改错），再用正确码配对 | 每次失败约有 1 秒延迟。第 10 次失败后 `~/.config/pi-remote/pairing.json` 被删除，之后正确码也失败 |
| S7 | 配对码过期：把 `pairing.json` 中的 `expiresAt` 改成过去的时间（备份后修改），再用该码配对 | `invalid_code`，`pairing.json` 被删除 |
| S8 | 未鉴权超时：写一个小 node 脚本，只完成加密握手（参考 `packages/hostd/scripts/dev-client.ts` 的 `connect`），之后不发 auth，等 12 秒 | 连接被 hostd 以 4408 关闭 |
| S9 | 未鉴权就发 req：握手后直接发 `{"t":"req",...}` | 连接以 4411 关闭 |
| S10 | 吊销正在连接的设备：用 dc2 凭据后台运行 `listen`，然后 `$H devices revoke <dc2 的 deviceId>` | 5 秒内 listen 输出 `connection closed: 4411 device revoked` 后退出 |
| S11 | App 被吊销：在 `$H devices list` 中找到 Waydroid 设备的 id 并吊销，观察 `$W state` | 5 秒内 App 断开，`conn` 变为 `no_credentials`，自动跳到配对页，`lastError` 提示本机已被解除配对。**之后需要重新配对**：用 S12 的深链接方法配对 |
| S12 | 深链接配对：`QR=$($H pair --json)`，然后 `adb -s 192.168.240.112:5555 shell am start -a android.intent.action.VIEW -d "'piremote://pair?qr=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$QR")'"` | 配对页弹出确认卡片 `pair-confirm-card`，显示电脑名、公钥指纹（4 位一组）、中继地址。**在点确认之前不会发起配对**（hostd 日志里没有新的 `device paired`）。`$W press pair-confirm-button` 后回到首页，状态为 ready |
| S13 | 深链接后按取消：重复 S12，但按 `pair-confirm-cancel` | 卡片消失，不配对，之前的凭据不变（仍处于 ready） |
| S14 | 恶意深链接：`piremote://pair?qr=not-json`；`kind:"endpoint"` 的 JSON；缺少 `hostKey` 的 JSON | 分别提示 "Not a pi-remote pairing code" / "connection-info code" 类提示，不崩溃，不发起连接 |
| S15 | 手动粘贴配对（`$W type pair-text-input '<JSON>'` 然后 `$W press pair-text-submit`） | 同样能配对成功（**手动粘贴不弹确认框**，这是设计如此） |
| S16 | 中继密钥错误：`$H relay set ws://62.234.87.78:7443 --secret wrong`，等 7 秒后执行 `$H relay show`，再执行 `$DC procs` | 显示 `auth_failed`；App 和 dev-client 收到 4404（电脑离线）。**恢复**：用 `--secret "$(cat ~/.config/pi-remote/relay-secret)"` 设回去，5 秒内恢复为 `connected` |
| S17 | 审计日志：`tail -20 ~/.local/state/pi-remote/audit.jsonl` | 每行都是 JSON，含 `ts`、`deviceId`、`op`。`prompt` 的 summary 不超过 200 字符，不包含密钥 |
| S18 | 中继日志不含内容：`ssh TencentVPS 'docker logs --tail 50 pi-relay'` | 只有 `host_up` / `client_open` / `client_spliced` / `client_closed` 等事件，字段只有时间、hostId 前 6 位、IP，没有帧内容 |

---

## 5. 中继（R）

| # | 操作 | 预期 |
|---|---|---|
| R1 | `curl --noproxy '*' -s http://62.234.87.78:7443/healthz`；`curl -s -o /dev/null -w '%{http_code}' http://62.234.87.78:7443/xyz` | 前者返回 JSON，后者返回 404 |
| R2 | hostd 不在线：`systemctl --user stop pi-hostd`，然后 `$DC procs` | `closed before handshake: 4404 host offline`。App 显示 Reconnecting…，`conn-error` 文案为 "Computer is offline…" |
| R3 | `systemctl --user start pi-hostd` | 10 秒内 relay show 为 connected，App 回到 ready，进程列表恢复，**processId 与之前相同** |
| R4 | `ssh TencentVPS 'docker restart pi-relay'` | hostd 在 30 秒内重连，App 在 30 秒内回到 ready |
| R5 | `ssh TencentVPS 'docker stop pi-relay'`，等 60 秒后再 `docker start pi-relay` | 停机期间 hostd 的重连间隔按 1、2、4、8、16、30 秒退避（看 `journalctl --user -u pi-hostd`）。启动后 30 秒内恢复。App 期间显示 Reconnecting…，之后自动恢复 |
| R6 | 本地中继迁移演练：`prdev:relay` 窗口里已有一个本地中继（端口 7450，密钥 dev；如果没有就运行 `RELAY_SECRET=dev RELAY_PORT=7450 node packages/relay/src/main.ts`）。执行 `$H relay set ws://127.0.0.1:7450 --secret dev` | 5 秒内 relay show 为 connected。dev-client 改用本地中继：复制凭据并把 `endpoint.relays` 改为 `["ws://127.0.0.1:7450"]`，能直接 procs，**无需重新配对**。此时 App 因为连不上本地 127.0.0.1 而断开。在 App 设置页把中继地址改成 `ws://192.168.240.1:7450`（M7j 测试，见 J-SET）后应能连上。**最后把 hostd 和 App 都改回 VPS 中继** |
| R7 | 同一 hostId 的两个控制连接顶替：用 `wscat` 或 node 脚本，以同一 hostId、正确密钥连接 `/v1/host/control` | 旧连接（hostd）收到 4409 后重连，两者来回顶替。验证这个现象后立即断开测试连接，确认 hostd 恢复 connected |
| R8 | App 连接数上限：不要求做（可选） | |

---

## 6. bridge 与事件流（B，用 dev-client 观察 pi A）

先在后台启动：`($DC watch $PA > /tmp/pr/acc/wA.out 2>&1 &)` 和 `($DC listen > /tmp/pr/acc/listen.out 2>&1 &)`。

| # | 操作 | 预期 |
|---|---|---|
| B1 | 看 wA.out 第一行 | `{"mode":"snapshot","snapshot":{...}}`：`messages` 是活动分支最近 200 条；`extWidgets` 含 `rpc-demo`（证明在 session_start 之前设置的 widget 也被捕获）；`extStatus` 中没有 ANSI 转义 |
| B2 | 在 acc1 的 TUI 里输入 `Reply with exactly: hello there. Do not use any tools.`（`tmux send-keys -t acc1 -l '...'` 再 `tmux send-keys -t acc1 Enter`） | watch 依次出现 `agent_start`、info(running)、`message_start`(user)、`message_end`(user)、`message_start`(assistant)、若干 `message_update`（text_delta）、`message_end`(assistant)、`agent_settled`、`context_usage`、info(idle)。**不出现 role 为 system 的消息** |
| B3 | 检查 seq 连续性：`jq -r 'select(.t=="evt")\|.seq' wA.out` | 严格递增，步长为 1，没有重复 |
| B4 | `$DC prompt $PA 'Reply with one word: pong. Do not use any tools.'` | 返回 `{"accepted":true}`，TUI 中出现这条消息并给出回答 |
| B5 | 运行中发送：先让 pi 执行 `Use the bash tool to run exactly: sleep 20; echo done`，在运行期间执行 `$DC op prompt '{"processId":"'$PA'","text":"hi"}'`（不带 deliverAs） | 返回错误 `busy_need_deliver_as`。用 dev-client 的 `prompt` 子命令（运行中会自动带 steer）则被接受，并在当前轮次插入 |
| B6 | 运行中执行 `$DC op abort '{"processId":"'$PA'"}'` | TUI 显示 Operation aborted，watch 出现 `agent_settled{aborted:true}` |
| B7 | 补发：记下 wA.out 中最后一个 seq，记为 L，结束 watch；在 TUI 里再问一句；然后 `$DC watch $PA $L` | 第一行为 `{"mode":"replay"}`，之后是 L+1 起的连续事件 |
| B8 | 缺口走快照：`$DC watch $PA 1` | `mode:"snapshot"`（seq 1 早已不在环形缓冲里，或者早于 hostd 重启） |
| B9 | sinceSeq 大于当前 seq：`$DC watch $PA 99999999` | `mode:"snapshot"`，不报错 |
| B10 | hostd 重启后 processId 不变、事件不丢：在 pi 输出期间 `systemctl --user restart pi-hostd`，重启后用之前的 sinceSeq 订阅 | processId 不变。replay 或 snapshot 后的消息数与 `read_session`（会话文件）的消息数一致 |
| B11 | TUI 中执行 `/new` | watch 出现 `session_changed{reason:"new"}`；procs 中 sessionId 改变，processId 不变 |
| B12 | TUI 中执行 `/reload` | 出现 `session_changed{reason:"reload"}`；之后对话框镜像仍然有效（复测 D1） |
| B13 | `cd /tmp && timeout 60 pi -p "say hi" --model antigravity-vps/gemini-3.8-flash-high --thinking off` 运行期间执行 procs | 这个进程**不出现**在列表中（只有 TUI 模式才启用 bridge） |
| B14 | `PI_REMOTE_DISABLE=1` 启动一个 TUI pi（`tmux new-session -d -s acc2 "PI_REMOTE_DISABLE=1 pi --model antigravity-vps/gemini-3.8-flash-high --thinking off"`） | 不出现在 procs 中。测完关闭 acc2 |
| B15 | bridge 日志：`ls ~/.local/state/pi-remote/bridge-*.log` | pi A 的 pid 对应的日志存在，里面没有 ERROR（若有 ERROR，摘录到报告） |
| B16 | NDJSON 特殊字符：`$DC prompt $PA` 发送一条包含 U+2028、U+2029、emoji、中文、反斜杠和引号的文本，例如 `node -e 'process.stdout.write("Echo exactly this: a\u2028b\u2029c 😀 中文 \\\\ \"q\"")'` 的输出，并要求 `Do not use any tools` | 消息完整到达 TUI，watch 中的 message_end 内容一致；hostd 和 bridge 日志中没有 `bad bridge line` |
| B17 | 大输出：让 pi 执行 `Use the bash tool to run exactly: seq 1 20000`，看 toolResult | watch 中的 toolResult 文本不超过 32000 字符，并带 `truncated: true`；`tool_update` 事件的间隔大约不小于 250ms |
| B18 | 用 `/quit` 退出 pi A 的副本（**不要退出 pi A 本身**。另开一个测试 pi acc3，退出它） | listen 收到 `proc down`，procs 中不再出现 |
| B19 | 杀进程：`kill -9` 一个测试 pi（另开 acc4） | 几秒内收到 `proc down`；hostd 不崩溃 |
| B20 | `ext_status` 去重：观察 watch 中的 `ext_status` 事件 | 同一个 key 连续两条的 text 不相同（内容不变时不重复发送）；所有 text 中没有 `\u001b` |

---

## 7. 对话框与问卷镜像（D，pi A + dev-client，再在 App 上复做一遍）

| # | 操作 | 预期 |
|---|---|---|
| D1 | TUI 中输入 `/rpc-input`；`$DC ui $PA <uiId> '{"value":"abc"}'` | watch 依次出现 `ui_request{kind:"input",title:"Enter a value"}`、`ui_closed{by:"remote"}`、`notify "You entered: abc"`；TUI 的输入框自动消失 |
| D2 | 再次 `/rpc-input`，这次在 TUI 里回答；然后对同一个 uiId 执行 `$DC ui` | 出现 `ui_closed{by:"local"}`；ui 返回 `not_found` |
| D3 | `/rpc-editor`，用 dev-client 回答 `{"value":"x\ny"}` | 扩展收到手机的值（notify "Editor submitted (2 lines)"）。TUI 的编辑框**仍然留着**（设计限制 D13），按 Esc 关闭后不会产生第二次结果 |
| D4 | 让 pi 执行 `rm -rf /tmp/pr/nothing-xyz`（触发 rpc-demo 的 select），用 dev-client 选 `Block` | 工具被阻止，toolResult 为 "Blocked by user"；运行期间 procs 中该进程的 status 为 `waiting_ui`，`pendingUiCount` 为 1 |
| D5 | 同 D4，但选 `Allow` | 命令执行（路径不存在，不会删除任何东西） |
| D6 | confirm：在 pi A 中执行 `/new`（rpc-demo 在新建会话前会调用 confirm），用 dev-client 回答 `{"confirmed":false}` | 新建被取消，TUI 显示 "Clear cancelled"；再回答 true 则新建成功 |
| D7 | 对话框回答的类型不匹配：对 confirm 发送 `{"value":"x"}`；对 select 发送 `{"confirmed":true}` | 不崩溃。confirm 收到 value 时视为 false；select 收到 confirmed 时视为取消（undefined）。记录实际行为 |
| D8 | ask_user_question：提示 pi `Call ask_user_question once with two single-select questions: Q1 "Pick a fruit" (header "Fruit") options Apple, Pear; Q2 "Pick a drink" (header "Drink") options Tea, Coffee. Then report my picks. Do not use other tools.` | watch 出现 `rpiv_prompt`（两题）和 `ui_request{kind:"custom", coveredBy:<toolCallId>}`。`$DC op rpiv_answer '{"processId":"'$PA'","answer":{"toolCallId":"<id>","answers":[{"questionIndex":0,"optionIndexes":[1]},{"questionIndex":1,"optionIndexes":[0]}]}}'` 返回 `{"ok":true}`；之后出现 `rpiv_closed` 和 `ui_closed`；模型回答 Pear 和 Tea |
| D9 | 问卷：自定义文本答案、多选题（让模型出一道 multiSelect 题）、放弃（`"cancel":true`）、错误的 toolCallId | 文本和多选都能被模型收到；放弃时工具结果显示用户拒绝；错误的 toolCallId 返回 `ok:false` 并带原因 |
| D10 | 问卷在电脑上回答 | 手机端收到 `rpiv_closed`，App 中的问卷卡片消失；如果问卷弹层已打开，会自动关闭 |
| D11 | custom()：TUI 中执行 `/tool-display` | 出现 `ui_request{kind:"custom"}`（不带 coveredBy）；`$DC ui ... '{"cancelled":true}'` 后 TUI 中的界面关闭 |
| D12 | 带超时的对话框：pi 自带的对话框里没有带 timeout 的，**SKIP**。如有带 timeout 的扩展可以验证 App 的倒计时显示 | |
| D13 | 多个对话框并存：让 pi 并行触发两个危险命令（`Run two bash tool calls in parallel: rm -rf /tmp/pr/n1 and rm -rf /tmp/pr/n2`） | 两个 select 都出现在 pendingUi 中，可以分别回答。记录实际行为 |
| D14 | 兼容模式（只读核对，不要求执行）：`SUPPORTED_PI_VERSIONS` 不包含当前 pi 版本时，`compat` 为 untested，对话框不镜像（已在开发中验过） | SKIP 或只读核对代码 |

**在 App 上复做**（打开 pi A 的会话页：`$W press proc-$PA`）：

| # | 操作 | 预期 |
|---|---|---|
| D-A1 | TUI 中 `/rpc-input`；在 App 上 `$W waitlabel ui-submit`，`$W type ui-input '手机输入'`，`$W press ui-submit` | TUI 中的输入框消失，显示 "You entered: 手机输入"（中文完整）；App 中的卡片消失 |
| D-A2 | TUI 中 `/rpc-input` 后直接在 TUI 回答 | App 中的卡片在 1 到 2 秒内消失 |
| D-A3 | 同一个对话框在 App 中按 `ui-cancel` | TUI 收到取消（"Input cancelled"） |
| D-A4 | 在 App 中发送危险命令提示，触发 select 后按 `ui-option-1`（Block） | 被阻止 |
| D-A5 | 问卷：`$W press rpiv-card-<id>` → `rpiv-option-0` → `rpiv-next` → 在第二题 `$W type rpiv-text '自定义'` → `rpiv-next` → `rpiv-submit` | 模型收到第一题的选项和第二题的自定义文本 |
| D-A6 | 问卷按 `rpiv-decline` | 模型收到拒绝 |
| D-A7 | TUI 中 `/tool-display`；App 中按 `ui-custom-cancel` | TUI 中的界面关闭 |
| D-A8 | 问卷（coveredBy）对应的 custom 卡片 | **不应**在 App 中显示为单独的卡片（只显示问卷卡片） |
| D-A9 | 在 App 回答的同时在 TUI 回答（竞争） | 只有一个答案生效，另一边提示已回答（App 显示 "Already answered on the computer."），两边都不崩溃 |

---

## 8. 会话操作、启动 pi、设置（O，dev-client，然后在 App 上复做为 M7f）

| # | 操作 | 预期 |
|---|---|---|
| O1 | `$DC op get_models '{"processId":"'$PA'"}'` | 列出所有可用模型，`current` 为 gemini |
| O2 | `set_model` 到 `antigravity-vps/gemini-3.8-flash-high`（当前模型本身），再设一个不存在的 id | 前者成功并出现 `model_changed`；后者返回 `not_found`。settings.json 的 defaultModel 不变 |
| O3 | `get_thinking_levels`；`set_thinking` 到 `off`，再到 `bogus` | 返回级别列表；设置 off 后 TUI 状态栏显示 think off；bogus 返回 `bad_request` |
| O4 | `compact`：先让会话积累足够内容（让 pi 输出 3 到 4 段各约 500 字的文字），再执行 `$DC op compact '{"processId":"'$PA'"}'` | 成功返回 `{}`；watch 出现 `compaction{phase:"end"}`。内容太少时返回 internal 错误并说明会话太小，也算符合预期 |
| O5 | 运行中执行 compact、navigate_tree、fork、new_session、switch_session | 都返回 `busy` |
| O6 | `get_tree` | nodes 中 `onActivePath` 与 TUI 的 `/tree` 一致；`leafId` 对应 `isLeaf` 节点 |
| O7 | `navigate_tree` 到较早的一条用户消息（summarize:false） | 返回 `{cancelled:false}`；watch 出现 `session_changed{reason:"tree"}`；TUI 的编辑器被预填为该消息 |
| O8 | navigate_tree 时 summarize:true | 生成分支摘要（branchSummary 消息），会调用模型 |
| O9 | `get_fork_points`，然后 `fork position:"before"` | 进入新会话（session_changed fork）；返回 `prefillText` |
| O10 | fork position:"at"（/clone 的实现） | 新会话包含该点之前的完整内容 |
| O11 | `new_session` | 新会话；pi A 加载了 rpc-demo，会弹出 confirm，需要回答 |
| O12 | `switch_session` 到旧会话文件 | 成功，TUI 切换。切到另一个正在运行的 pi 的会话 → `conflict_live_elsewhere`，message 为目标 processId |
| O13 | `set_name` | TUI 显示新名称；procs 中出现 sessionName；`session_info_changed` 触发 info |
| O14 | `get_commands` | 包含扩展命令、模板、`skill:*`；**不包含** `pi-remote-op` |
| O15 | TUI 中手动输入 `/pi-remote-op abc` | 只提示 unknown or expired op，没有其他副作用 |
| O16 | `list_sessions`（不带参数 / 带 cwd / refresh:true） | 按 modified 降序；有进程打开的会话带 `liveProcessId`；没有 `allMessagesText` 字段 |
| O17 | `list_projects` | 按 cwd 分组并计数；在线进程的 cwd 也会出现 |
| O18 | `read_session` 读一个旧会话：调用前后对文件做 `sha256sum` 和 `stat -c %Y` | 内容和 mtime 都不变。传入 `beforeEntryId` 时分页正确，`hasMoreBefore` 正确 |
| O19 | read_session 传入非法路径：`/etc/passwd`、`~/.pi/agent/sessions/../settings.json`、相对路径、不存在的 .jsonl | 分别返回 bad_request / bad_request / bad_request / not_found |
| O20 | `open_session` 打开一个没有进程在用的旧会话（trust deny） | 45 秒内返回 `{processId, spawned:true}`；`tmux list-windows -t pi-remote` 多出一个窗口；procs 中 `spawnedByHostd:true`。**新进程的模型是 zero-cat**：按 0.1 切到 gemini 并把思考设为 off |
| O21 | 对同一个会话再次 open_session | 返回同一个 processId，`spawned:false` |
| O22 | open_session 传入 settings.json、/etc 下的文件、非 .jsonl 文件 | 都返回 bad_request |
| O23 | `new_process {cwd: 项目根目录, trust:"approve"}` | 启动成功。`cwd:"/etc"` → bad_request；cwd 为相对路径或不存在的目录 → bad_request |
| O24 | spawn 超时：备份 config.json，把 `piCommand` 改成 `pi-nonexistent`，等 6 秒后执行 new_process | 约 45 秒后返回 `spawn_timeout`，message 中包含 pane 输出和 `command not found`，之后该 pane 被关闭。**恢复 config.json** |
| O25 | `shutdown` 一个 hostd 启动的 pi | 进程退出，它所在的 tmux 窗口关闭，listen 收到 down |
| O26 | `reload` 空闲进程 | TUI 中 reload；运行中的进程会在本轮结束后才 reload（让它跑一个 sleep 15 的命令期间调用 reload，看时间点） |
| O27 | 设置读取：`get_settings` | 只返回 `REMOTE_SETTINGS` 白名单中已设置的键 |
| O28 | `set_setting hideThinkingBlock true`，与备份 `diff`，然后设回原值，再用备份 `cp` 恢复并 `cmp` | settings.json 中只有这一个字段变化（另外 SettingsManager 会去掉文件末尾换行，这是已知现象）；在线的空闲 pi 执行了 reload |
| O29 | set_setting 传非法值：key 不在白名单中；布尔项传字符串；枚举项传不在选项中的值 | 都返回 bad_request，文件不变 |
| O30 | 枚举项：`defaultThinkingLevel` 设为 `off` 后恢复 | applies 为 new_session，**不触发** reload |
| O31 | 参数校验：每个 op 少传必填参数、类型错误，以及传入未知 op | 都返回 bad_request，不崩溃 |
| O32 | 请求不存在的 processId | not_found |
| O33 | 请求进行中 pi 退出：发一个长 compact 或 navigate 后立刻 `kill` 该 pi | 返回 `bridge_gone` |

---

## 9. 子 agent 与 team（T）

在 pi A 中提示（**所有子进程必须用 gemini、思考关闭**）：

`Call the subagent tool exactly once with agent "researcher", name "probe", model "antigravity-vps/gemini-3.8-flash-high:off", task "Reply with the single word DONE. Do not use any tools." Then wait for the result.`

| # | 操作 | 预期 |
|---|---|---|
| T1 | procs | 出现子进程：`role.kind:"subagent"`，name 为 probe，agent 为 researcher，`autoExit:true`，`parentProcessId` 等于 $PA；pi A 的 `childSessionFiles` 包含子进程的 sessionFile |
| T2 | pi A 的 watch 中 `ext_widget{key:"subagent-status"}` | lines 是可读文本、没有 ANSI，内容与 TUI 中的面板一致；子进程运行期间约每 2 秒更新一次（运行时长变化）；子进程结束后收到 lines 为空的事件 |
| T3 | 子进程的快照 | extWidgets 包含 `subagent-tools` |
| T4 | 子进程结束 | 收到 proc down；pi A 出现 `message_end{role:"custom", customType:"subagent_result"}`，details 中有 name、agent、exitCode、elapsed、sessionFile；对该 sessionFile 执行 read_session 能读到完整对话 |
| T5 | `subagent_resume` 恢复 probe（同样传 gemini 和 off） | 新的子进程的 parentProcessId 仍为 $PA |
| T6 | team：`Call team_spawn exactly once: name "helper", agent "researcher", model "antigravity-vps/gemini-3.8-flash-high:off", task "Reply READY via team_report, then wait."` | 成员进程 `role.kind:"team_member"`，`leadPid` 等于 pi A 的 pid，parentProcessId 正确；pi A 出现 `team-status` widget，成员出现 `team-member` widget；出现 `team_message` 类型的自定义消息 |
| T7 | `$DC prompt <成员> 'Reply PONG. No tools.'` | 成员所在的 tmux pane 中出现这条消息并回答 PONG |
| T8 | hostd 重启后 | 子进程和成员的 parentProcessId 恢复正确 |
| T9 | 结束：让 pi A 执行 `team_stop helper` | 成员下线 |
| T10 | 父进程先于子进程退出（可选）：在子 agent 运行中关闭父进程 | 子进程变成顶层显示，仍带角色徽标，App 不崩溃 |

---

## 10. App 功能（A，Waydroid）

### 10.1 连接与配对（A-CONN）

| # | 操作 | 预期 |
|---|---|---|
| A1 | `$W state` | ready / relay |
| A2 | 开启直连：`$H direct enable --advertise ws://192.168.240.1:7444`，然后重新配对，或在设置页的直连地址里填 `ws://192.168.240.1:7444` 并保存 | `via` 变为 `direct`，首页状态条显示 "Direct" |
| A3 | `$H direct disable` | 直连断开后自动切到中继，`via` 变为 `relay`。尝试直连失败时等待不超过 3 秒 |
| A4 | hostd 停 / 起（同 R2、R3） | App 显示 Reconnecting…，并给出原因；恢复后自动变为 ready，**之前打开的会话页数据仍然正确**（seq 与快照一致） |
| A5 | 中继重启（R4） | 自动恢复 |
| A6 | 强制停止 App 后重新启动 | 凭据保留，自动连上，**不需要**重新配对 |
| A7 | 清除 App 数据（`adb shell pm clear dev.moorey.piremote`，之后重新 `pm grant` 通知权限） | 回到配对页；重新配对成功。旧设备记录仍在 `$H devices list` 中，用 revoke 清理 |
| A8 | 断线期间的 UI | 输入栏禁用并显示 "Not connected"；按钮不会发出请求 |
| A9 | 心跳：让 App 静置 3 分钟 | 连接保持 ready（每 20 秒 ping 一次，hostd 60 秒没收到帧才会断开），hostd 日志中没有 idle 断开记录 |

### 10.2 首页（A-HOME）

| # | 操作 | 预期 |
|---|---|---|
| H1 | 首页 `$W dump`（空闲时） | "Running (N)" 与 procs 一致；每项显示状态徽标、会话名或目录名、模型、lastText |
| H2 | 子 agent 运行中查看首页 | 子项缩进显示在父项下方，带 "Subagent · probe (researcher)" 徽标；父项显示 "Subtasks running 1"；子项需要输入时，父项显示 "Subtasks need input" |
| H3 | 等待输入的进程排在最前 | 符合 |
| H4 | 项目列表：`$W press project-pi-remote` | 展开后显示会话列表；有进程在用的会话带 "Running" 标记，点击后直接跳到那个进程 |
| H5 | 打开没有进程在用的会话：`$W press session-item-N` | 弹出信任对话框（未记住选择时）；按 `trust-deny` 后显示 "Starting pi…"，然后进入会话页并显示历史 |
| H6 | 记住信任：`$W tap trust-remember`（开关需要坐标点击），再按 trust-approve；之后打开同一目录的另一个会话 | 第二次不再弹出对话框 |
| H7 | 设置页中 `settings-clear-trust` | 之后再次弹出信任对话框 |
| H8 | spawn 失败的展示（配合 O24 的 piCommand 改法） | 弹出 `error-dialog`，内容可滚动，包含 pane 输出。**记得恢复 config.json** |
| H9 | 下拉刷新（`$W swipedown`） | 列表刷新，不崩溃 |
| H10 | 进程上线 / 下线 | 首页实时增减，无需刷新 |
| H11 | `home-new` → 新会话页：`$W type new-cwd-input '<项目根目录>'` 或 `$W press new-project-0`，再按 `new-start` | 启动后进入会话页。输入非法路径（`/etc`）时显示错误对话框 |

### 10.3 会话页（A-SESS）

| # | 操作 | 预期 |
|---|---|---|
| SP1 | 进入页面 | 顶栏显示会话名和状态；`chip-model`、`chip-thinking`、上下文百分比；ext 状态行可读、没有 ANSI；rpc-demo 的 widget 显示为等宽文本（`widget-rpc-demo`） |
| SP2 | 发消息：`$W type composer-input 'Reply: ok. No tools.'`，`$W press composer-send` | TUI 中同步出现；App 中流式显示（运行期间 `state.view.inflight` 为 true）；结束后 messages 增加 2 条 |
| SP3 | 电脑上输入，手机观看 | 实时显示 |
| SP4 | 长回答（`Write about 2000 characters of plain text about the sea. No tools.`） | 流式显示过程中界面不卡死；最终文本与 TUI 一致；列表自动停在最新位置 |
| SP5 | 运行中：`composer-stop`、`composer-mode-steer` / `composer-mode-followup` 出现；用 steer 和 queue 各发一条 | steer 插入当前轮次；queue 在本轮结束后执行；stop 中止运行（queue 中尚未执行的消息会被 pi 放回 TUI 的编辑器，这是 pi 本身的行为） |
| SP6 | 工具卡片：bash、read、write、edit 的摘要分别为 `$ cmd`、`Read path`、`Write path (N lines)`、`Edit path (N changes)`。`$W press tool-toggle-<id>` 展开 edit 卡片 | 展开后显示 PatchView：`+` 行绿底、`-` 行红底、`@@` 行蓝字（截图核对一次即可） |
| SP7 | 工具输出超过 200 行（`seq 1 500`） | 展开后只显示前 200 行，并有 `tool-showall-<id>` 按钮，按下后显示全部；超过 32000 字符时显示 "(output truncated)" |
| SP8 | 运行中的工具 | 显示 partialText 的最后 20 行，并随输出更新 |
| SP9 | 出错的工具 | 红框加 "error" 标记 |
| SP10 | 思考内容：在电脑上把思考级别临时设为 low，发一条消息 | 思考块折叠显示，点击可展开；`hideThinkingBlock` 为 true 时只显示 "Thinking hidden"。**测完把思考级别设回 off** |
| SP11 | toast：TUI 中执行 `/rpc-input` 并回答 | App 顶部出现 toast "You entered…"，约 3 秒后消失 |
| SP12 | 加载更早的消息：打开一个超过 200 条消息的旧会话（用 `list_sessions` 找 messageCount 大于 220 的）。如果没有，SKIP 并说明 | 列表顶部出现 `transcript-load-more`，按下后插入更早的消息，滚动位置不跳动 |
| SP13 | `transcript-jump-latest`：向上滚动后（`$W swipedown` 几次） | 出现 "↓ Latest"，按下后回到底部 |
| SP14 | 中文、emoji、长单词、Markdown（表格、代码块、链接） | 渲染正常，不崩溃 |
| SP15 | 进程退出（在会话页中关闭对应的 pi） | 显示 `session-gone` 卡片 "The pi process has exited."，按 `session-reopen` 后重新打开会话（会弹信任对话框），回到正常状态 |
| SP16 | 父进程链接：在子 agent 的会话页 | 显示 `chip-parent` "↑ <父会话名>"，以及 `session-role` 角色行，按下 chip-parent 跳到父进程页面 |
| SP17 | ChildStrip：父进程页面在子进程运行时 | 显示 `child-strip`，每个子进程一个 chip（状态色点），按下 `child-<pid>` 进入子进程页面 |
| SP18 | 页面视图上限：依次打开 6 个以上不同进程的会话页 | 最久没看的那个视图被退订（hostd 收到 unsubscribe），重新进入时重新拿快照 |
| SP19 | 手机发图片：`adb -s ... push <一张 png> /sdcard/Pictures/acc.png`，然后 `adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/acc.png`；按 `composer-image` 打开系统相册（之后需要坐标点击，或截图辅助选择），选中后缩略图显示在输入栏，发送 "Describe this image in one sentence. No tools." | 模型能描述图片内容；TUI 中用户消息带图片；App 中用户气泡显示 "[1 image]" |
| SP20 | 切到只支持文本的模型（例如 `deepseek/deepseek-v4-pro`，只切换不发消息） | `composer-image` 按钮置灰；绕过 UI 直接发图片（dev-client 的 op prompt 带 images）返回 `model_no_image`。**切回 gemini 并把思考设为 off** |
| SP21 | 发送空消息 | 发送按钮禁用 |
| SP22 | 发送失败（例如在进程切换会话期间发送） | 弹出 error-dialog，并给出可理解的英文提示 |

### 10.4 斜杠命令（A-SLASH，即 M7f）

在会话页的 composer 中用 `$W type composer-input '/xxx'` 输入命令，再 `$W press composer-send`：

| # | 命令 | 预期 |
|---|---|---|
| SL1 | 只输入 `/` | 出现 `slash-menu`，包含内置命令和扩展命令；输入 `/mo` 时只剩以 mo 开头的命令；按 `slash-model` 后输入框变为 `/model ` |
| SL2 | `/model` | 打开 model-sheet，按 provider 分组，当前模型打勾；按 `model-antigravity-vps/gemini-3.8-flash-high` 后关闭，TUI 状态栏同步 |
| SL3 | `/thinking` | thinking-sheet；按 `thinking-off`，TUI 同步 |
| SL4 | `/tree` | tree-sheet；过滤器 `tree-filter-*` 可以切换；按节点 `tree-node-<id>` 出现确认区，按 `tree-go` 跳转，会话视图重新加载（view.seq 变化，messages 变少）；运行中节点不可点击 |
| SL5 | `/fork` | fork-sheet 倒序列出用户消息；按 `fork-point-0` 后进入新会话，输入框被预填为该消息 |
| SL6 | `/clone` | 出现 `session-confirm`；按 `session-confirm-yes` 后进入克隆出的新会话，内容一致 |
| SL7 | `/new` | 确认后进入新会话；pi A 上 rpc-demo 的 confirm 会出现在 App 中，需要回答 |
| SL8 | `/resume` | resume-sheet 列出本项目的会话；`resume-scope` 切换到全部项目；选中正在别的进程中运行的会话时直接跳到那个进程；选中普通旧会话时 TUI 切换过去 |
| SL9 | `/compact` | compact-sheet；可以填说明，按 `compact-run` 后显示进度，完成后关闭；会话太小时显示错误 |
| SL10 | `/compact 保留关键结论` | 直接执行，不打开弹层 |
| SL11 | `/settings` | 跳转到设置页 |
| SL12 | `/name 新名字`；以及不带参数的 `/name` | 前者直接改名；后者打开 session-sheet 的改名输入框；TUI 和首页同步 |
| SL13 | `/reload` | 确认后 TUI 执行 reload |
| SL14 | `/session` | session-sheet 显示 cwd、会话文件、sessionId、tmux pane、pid、pi 版本、上下文。只有 hostd 启动的进程或非 main 角色才显示 `session-shutdown` |
| SL15 | `/copy` | 剪贴板内容为最后一条 assistant 文本（`adb shell cmd clipboard get-primary-clip` 不一定可用，可在 App 内把它粘贴到输入框验证，或 SKIP 并说明） |
| SL16 | `/hotkeys`、`/login`、`/quit`、`/share`、`/export`、`/trust` 各试一个以上 | 提示 "/xxx is only available on the computer."，**不发送**给 pi |
| SL17 | `/rpc-input`（扩展命令） | 作为 prompt 发送，TUI 中弹出输入框，App 中出现卡片 |
| SL18 | `/skill:defuddle`（或其他技能、模板） | 作为 prompt 发送。只确认被接受，**立即按 stop**，避免花钱 |
| SL19 | 运行中输入扩展命令 `/rpc-input` | 立即执行（扩展命令不排队） |

### 10.5 设置页（A-SET，即 M7f 和 M7j）

| # | 操作 | 预期 |
|---|---|---|
| ST1 | 进入设置页 | 列出 REMOTE_SETTINGS 中的 14 项；布尔项是开关，枚举项显示当前值（未设置的显示 "Default"）；每项下方有生效说明 |
| ST2 | 切换 `setting-switch-hideThinkingBlock` 后再切回 | settings.json 对应变化后复原；在线的空闲 pi reload。最后用备份 `cp` 恢复并 `cmp` |
| ST3 | 枚举：`setting-defaultThinkingLevel` → `setting-option-off` → 恢复原值（原值为空时在 settings.json 中删除该字段，**用备份恢复**） | 正常 |
| ST4 | 连接信息区 | 显示电脑名、hostId、公钥指纹、deviceId、hostd 版本、当前通道 |
| ST5 | 修改中继地址：`$W type settings-relay-input 'ws://192.168.240.1:7450'`，按 `settings-save-conn`（配合 R6，hostd 此时指向本地中继） | 自动重连成功；改回 `ws://62.234.87.78:7443`（同时把 hostd 也改回）后恢复 |
| ST6 | 非法地址：`http://x`、`ws://x/path`、两个地址都为空 | 显示错误提示，不保存 |
| ST7 | `settings-test-conn` | 每个候选地址一行，显示成功或失败原因（例如直连关闭时显示 timeout 或 closed） |
| ST8 | 粘贴连接信息：`$W type settings-endpoint-input "$($H qr --json)"`，按 `settings-endpoint-apply` | 提示 updated 并重连 |
| ST9 | 粘贴**另一台电脑**的连接信息（把 qr JSON 里的 hostId 改掉） | 提示 "This QR code belongs to another computer"，不保存 |
| ST10 | `settings-keepalive` 关闭后再打开 | 关闭后 `adb shell dumpsys activity services dev.moorey.piremote` 中前台服务消失，打开后重新出现 |
| ST11 | `settings-unpair` → `settings-unpair-yes` | 回到配对页，前台服务停止；之后重新配对，并在电脑上吊销旧设备 |
| ST12 | `settings-battery` | 打开系统电池优化页面或应用设置页，不崩溃，按返回键回到 App |

### 10.6 通知与后台（A-NOTIF，即 M7h 的 Waydroid 部分）

| # | 操作 | 预期 |
|---|---|---|
| N1 | App 处于 ready 状态 | `adb shell dumpsys activity services dev.moorey.piremote` 中有 notifee 的 ForegroundService，类型为 remoteMessaging；`dumpsys notification --noredact \| grep -A5 dev.moorey.piremote` 中有常驻通知，正文为 "N running · M waiting for input" |
| N2 | 常驻通知正文随状态变化 | pi 运行时正文中的 running 数量变化 |
| N3 | `$W key KEYCODE_HOME` 让 App 进入后台，然后在电脑上让 pi A 跑一个短任务直到完成 | 出现 "Finished" 通知，正文为 lastText；通知渠道为 `pi-remote-events` |
| N4 | 后台时触发确认框（rpc-input） | 出现 "Needs input" 通知，正文为会话名或目录名 |
| N5 | 子 agent 需要确认 | 通知标题为 "Subagent <name> needs input" |
| N6 | 子 agent 完成 | 默认**不**通知；在设置中打开 `settings-notify-child` 后会通知 |
| N7 | App 前台且正停留在该会话页时 | 不弹该进程的通知 |
| N8 | 同一进程同类通知 10 秒内连续触发 | 只出现一次 |
| N9 | `adb shell dumpsys deviceidle force-idle`，在电脑上触发任务完成，再 `dumpsys deviceidle unforce` | 记录通知是否送达（冒烟测试，结果供参考） |
| N10 | 点击通知跳转 | Waydroid 上不验，留给真机 |

### 10.7 只读历史页（A-HIST，即 M7i 的一部分）

| # | 操作 | 预期 |
|---|---|---|
| HI1 | 在 pi A 的会话页里，`subagent_result` 卡片的 "View subagent session"（`custom-open-child-<序号>`） | 子进程已结束时打开历史页：显示 `history-readonly` 徽标和完整对话，没有输入栏；子进程仍在线时直接跳到它的会话页 |
| HI2 | 历史页中的 `history-continue` → `history-continue-yes` | 弹出信任对话框，确认后在电脑上启动 pi 并打开该会话，进入会话页 |
| HI3 | 历史页中会话正在运行时 | 显示 `history-open-live` |
| HI4 | 自定义消息卡片 | `subagent_result` 卡片显示名称、用时、退出码，正文默认折叠为 12 行；`team_message` 卡片显示 from 徽标、类型、状态颜色；`subagent_status` 和 `team_notice` 显示为灰色小字 |

---

## 11. 迁移与长期稳定性（M）

| # | 操作 | 预期 |
|---|---|---|
| M1 | 换电脑演练：`$H export /tmp/pr/acc/x-identity.json`（权限必须是 0600）；`mv ~/.config/pi-remote ~/.config/pi-remote.acc`；`$H import /tmp/pr/acc/x-identity.json`；`systemctl --user restart pi-hostd` | App 和 dev-client 不改任何配置即可连接。注意：dev-client.json 和 relay-secret 不在导出范围内，需要从 .acc 目录复制回来。**最后恢复**：删掉新目录，把 .acc 改回原名，重启 hostd，删除导出文件 |
| M2 | import 校验：导入一个损坏的 JSON、v 字段不等于 1 的文件、缺少 identity 的文件 | 报错，原有配置不变 |
| M3 | 换 VPS：同 R6 和 ST5 | 无需重新配对 |
| M4 | 长时间运行：让 App 保持连接 30 分钟以上（可以与其他测试并行），期间 pi A 每隔几分钟收到一条消息 | 不掉线；`ps -o rss` 观察 hostd 内存没有持续增长（记录前后两个数值） |
| M5 | 并发客户端：dev-client watch 与 App 同时看同一个进程，双方都发消息 | 两边都能看到全部事件，seq 一致 |
| M6 | 快速连发：用 for 循环通过 dev-client 连发 20 条 `/rpc-prefill`（扩展命令，不调用模型） | 全部被接受，hostd 和 bridge 都不报错，TUI 不卡死 |
| M7 | bridge 发送队列：hostd 停止期间让 pi 产生大量事件（`seq 1 3000` 的工具输出，或长回答），然后启动 hostd | 能重新连上；App 用快照或补发恢复，内容与会话文件一致 |

---

## 12. 正式版构建（REL）

| # | 操作 | 预期 |
|---|---|---|
| REL1 | 按 1.3 构建正式版（构建环境中没有 EXPO_PUBLIC_TEST_HOOKS） | 构建成功 |
| REL2 | `unzip -p app-release.apk AndroidManifest.xml` 不可读，改为检查 `apps/mobile/android/app/src/main/AndroidManifest.xml` | 包含 `usesCleartextTraffic="true"`、`FOREGROUND_SERVICE_REMOTE_MESSAGING`、`foregroundServiceType="remoteMessaging"`、`piremote` scheme |
| REL3 | 在 Waydroid 中卸载调试版并安装正式版（**会清除配对**，之后需要重新配对） | 能启动；用 S12 的深链接方式配对（深链接是正式功能。正式版没有 type 钩子，Waydroid 的拼音键盘也无法输入，所以不能用 S15 的手动粘贴） |
| REL4 | 正式版中的测试钩子已关闭：`adb shell am start -d 'piremote://test/dump'`，然后 `adb logcat -d -s ReactNativeJS \| grep PIREMOTE_TEST` | 没有任何 PIREMOTE_TEST 输出，App 不崩溃，也不跳到 404 页面 |
| REL5 | 正式版连接、首页、会话页冒烟 | 正常 |
| REL6 | 结束后改回调试版（`install -r` 调试版 APK，`adb reverse 8081`，重新配对） | 恢复到验收开始时的状态 |

---

## 13. 清理与恢复（结束前必须执行）

1. 结束所有 dev-client 后台进程：`pkill -f '^node packages/hostd/scripts/dev-client.ts'`。
2. 关闭你创建的 tmux 会话（acc1、acc2 等），以及 hostd 在 `pi-remote` 会话中为验收启动的 pi。可以用 App 或 dev-client 的 shutdown。
3. `$H relay set ws://62.234.87.78:7443 --secret "$(cat ~/.config/pi-remote/relay-secret)"`，然后 `$H direct disable`，最后确认 `$H relay show` 为 connected。
4. `cmp ~/.pi/agent/settings.json /tmp/pr/acc/settings.json.orig`，不一致就恢复。`~/.config/pi-remote/config.json` 和备份做同样比较（`devices.json` 会因为验收增删设备而变化，属于正常）。
5. `$H devices list`：吊销验收中新增的测试设备，保留 dev-client 和最终在用的 Waydroid 设备。
6. `ssh TencentVPS 'docker ps --format "{{.Names}} {{.Status}}"'`：pi-relay 为 Up，其他容器状态与开始时一致。
7. Waydroid 中 App 处于调试版并已配对，`$W state` 为 ready。
8. 在 `extensions/pi-remote` 下执行 `git status --short`：验收不应产生任何代码改动。

---

## 14. 报告格式

在 `/tmp/pr/acc/REPORT.md` 写报告（不要写进仓库），内容依次为：

1. **总览**：各章 PASS / FAIL / BLOCKED / SKIP 的数量；执行时间；所用模型（确认全程都是 gemini-3.8-flash-high，思考为 off）。
2. **FAIL 清单**：每条包含编号、现象、复现步骤、证据（命令输出或日志片段，或截图路径）、严重度判断（阻断 / 主要 / 次要 / 外观）。
3. **BLOCKED 和 SKIP 的原因**。
4. **全量结果表**：编号、结果、证据摘要。
5. **观察到的其他问题和建议**（不属于任何条目，但值得注意的现象）。
6. **第 13 章清理结果**。
7. **留给真机的项目**（原样附上第 15 章）。

---

## 15. 只能在真机上验收的项目（本轮不做，原样列入报告）

- 扫描二维码配对；扫描连接信息二维码。
- 锁屏 30 分钟后任务完成时收到通知；点击通知后直接进入对应会话页并看到确认卡片。
- 前台服务在国产 ROM 上的常驻情况；电池优化设置入口。
- Wi-Fi 与移动数据切换后自动重连，消息不丢不重。
- 用真实输入法（含中文、语音输入）打字。
- 同一局域网时走直连（直连地址需要设为电脑的局域网 IP），离开局域网后自动切到中继。
