# pi-remote 实施计划

> 目标读者：负责实现本项目的编码 agent。
> 读法：先通读第 0～4 章，再按第 9 章的里程碑顺序逐个实现。每个里程碑结束时完成该节的"验收"，再进入下一个。
> 本文所有"已核实"的事实均来自 pi 1.5.0 本机安装（`/usr/lib/node_modules/pi/packages/coding-agent`）的文档与源码，路径写在附录 A。

---

## 0. 给实现者的硬性规则

1. **不要修改第 2 章"已锁定决策"。** 发现文档与实际行为不符时，在项目根目录的 `NOTES.md` 记录现象、证据和你采取的最保守做法，然后继续。
2. **语言与运行时**
   - 本机 Node 为 v26，直接运行 `.ts` 文件（Node 原生类型擦除）。因此 hostd、bridge、protocol 的 TypeScript 只能用"可擦除语法"：禁止 `enum`、`namespace`、构造函数参数属性（`constructor(private x)`）、`import x = require()`。用字符串字面量联合类型代替 enum。
   - 相对导入必须写完整扩展名：`import { x } from "./foo.ts"`。纯类型导入用 `import type`。
   - 所有 `tsconfig.json` 开启 `"strict": true`、`"noEmit": true`、`"allowImportingTsExtensions": true`、`"verbatimModuleSyntax": true`、`"erasableSyntaxOnly": true`（TypeScript 版本不支持该选项时删掉这一项并在 NOTES.md 记录）。
3. **bridge 扩展运行在用户正在使用的 pi TUI 进程里**，必须遵守：
   - 绝对不要 `console.log` / `console.error` / 写 stdout / stderr，否则会破坏终端画面。日志只写文件（见 7.1.9）。
   - 每个 `pi.on(...)` 处理函数必须立刻返回：函数体整体包在 `try/catch` 里，不得 `await` 任何网络操作；发数据只做"放进发送队列"。pi 会顺序 `await` 每个扩展的处理函数（附录 A-7），慢了会拖慢 pi。
   - `message_end`、`tool_result`、`tool_call`、`context`、`input`、`before_agent_start`、`session_before_*` 这些事件的处理函数**不得返回任何值**（返回值会改写 pi 的行为）。bridge 只订阅第 7.1.4 节列出的事件。
4. **NDJSON 分帧**：每条记录 `JSON.stringify(obj) + "\n"`；读取时自己按 `\n`（0x0A）切分 Buffer，不要用 `readline`（它会在 U+2028/U+2029 处错误切分，见 pi `docs/rpc.md` Framing 一节）。
5. **文件写入**：配置、设备、状态文件一律"写临时文件 → `fs.renameSync` 覆盖"，含密钥的文件权限 `0o600`，所在目录 `0o700`。
6. **依赖**：只用本文列出的依赖。确需新增时在 NOTES.md 说明原因。
7. **每个里程碑结束**：在项目根目录运行 `npm run typecheck` 必须通过；按该里程碑"验收"逐条手工验证；然后提交。
8. **不确定时选择失败可见的做法**：返回明确的错误码给客户端，而不是静默忽略。
9. **Git 边界**：本项目位于已有仓库 `/home/moorey/Projects/Pi-extension-dev` 的 `extensions/pi-remote/` 下，不要 `git init`。该仓库里有用户自己的未提交改动，提交时只暂存本项目目录：`git add extensions/pi-remote && git commit -m "pi-remote: <里程碑>"`，禁止 `git add -A`、`git add .`、`git commit -a`，不要改动 `extensions/pi-remote/` 以外的任何文件（包括仓库根目录的 README.md）。
10. **执行授权**（用户已同意，以下操作无需逐项确认；这一条覆盖用户全局 AGENTS.md 中"禁止主动编译、运行、测试、安装"的默认规则，但仅限本项目）：
    - 在 `extensions/pi-remote/` 内：`npm install`、`npx`、`npm run typecheck`、运行 node 脚本（hostd、relay、dev-client）、Expo / Gradle 构建。
    - 第 5.1 节列出的本机环境准备：下载 Android 命令行工具到 `~/Android/Sdk`、运行 `sdkmanager`（含接受许可）、在 `~/.zshrc` 末尾追加标记块、`loginctl enable-linger moorey`。
    - 在 tmux 中启动、操作、关闭 pi 进程做验收（只操作你自己创建的 tmux 会话/窗口，不碰用户已有的 pi）；`pi install <bridge 路径>`（会修改 `~/.pi/agent/settings.json` 的 `packages`）。
    - 读写 `~/.config/pi-remote/`、`~/.local/state/pi-remote/`、`$XDG_RUNTIME_DIR/pi-remote/`；安装并启用 `~/.config/systemd/user/pi-hostd.service`。
    - 对已连接的手机和 Waydroid 执行 `adb devices`、`adb connect`、`adb reverse`、`adb install`、`adb logcat`、`adb shell input/uiautomator/screencap/am/monkey/getprop`；按第 5.3 节启动、停止 Waydroid 会话（`waydroid session start/stop`、`waydroid show-full-ui`）。
    - 按第 5.2 节通过 `ssh TencentVPS` 部署中继，范围严格限定在 5.2 列出的命令。
    - 按第 9 条规则 `git add extensions/pi-remote && git commit`。仓库中其他目录已有的未提交改动属于用户，保持原样，不要 stash、提交或还原。
    - **禁止**：任何 `sudo`；修改 `extensions/pi-remote/` 以外的项目文件；在 VPS 上做 5.2 以外的改动（包括动现有的 blog、sillytavern、st-proxy、emb-proxy、nginx 容器和系统配置）；升级 pi（必须保持 1.5.0）。
11. **界面与输出一律英文**：App 的所有界面文字（按钮、标题、提示、错误信息、空状态、对话框、通知标题与正文、前台服务通知、通知渠道名、权限说明文字）、`accessibilityLabel`、hostd / relay / bridge / dev-client 的日志、命令行输出与错误信息、代码注释、提交信息，全部使用英文。本文中用中文写出的界面文案（例如"重连中"、"需要确认"、"已在电脑上回答"）只是描述含义，实现时翻译成简洁自然的英文。唯一例外：`NOTES.md` 是给用户看的工作记录，用中文写。
12. **人工检查点**：遇到下列情况时停下，向用户说明需要做什么、做完后如何验证，等用户回复再继续。不要用猜测或跳过验收的方式绕过。
    | 情况 | 需要用户做的 |
    |---|---|
    | 需要 sudo | 用户执行你给出的确切命令 |
    | 5.2 第 1 步端口连通性检查失败 | 用户在腾讯云轻量服务器控制台 → 防火墙放行 TCP 7443 |
    | `waydroid-container` 未运行，或 Waydroid 的 adb 变成 `unauthorized`（5.3 第 1、2 步；正常情况下不会发生） | 用户启动容器服务，或在 Waydroid 弹窗中勾选 "Always allow" 后允许 |
    | 开始真机验收时 `adb devices` 没有真机 | 用户打开手机开发者选项与 USB 调试、连线并在手机上允许调试；国产系统还要打开"USB 安装" |
    | 真机专属验收项（M7 开头表格中标为"真机项"的项） | 用户在手机上操作并反馈结果。M0～M7 中除此之外的所有步骤都应无人值守完成；把真机项留到最后，一次性逐条列给用户 |
    | 任何验收条目连续两次修复后仍失败 | 用户决定是否继续 |

---

## 1. 目标与范围

### 1.1 要做到的

- Android 手机 App（React Native），远程使用本机上运行的 pi：
  - 查看所有正在运行的 pi 进程及其会话；实时看到流式输出、思考、工具调用与结果。
  - 发送消息（含图片）；运行中可"插话（steer）"或"排队（followUp）"；中止。
  - 回答 pi 及扩展弹出的对话框（select / confirm / input / editor）；回答 `ask_user_question` 多题问卷。
  - 原生界面实现：`/model`、`/thinking`、`/tree`、`/new`、`/fork`、`/clone`、`/resume`、`/compact`、`/settings`、`/name`、`/reload`、`/session`、`/copy`。
  - 透传扩展命令、提示模板、技能命令（`/xxx`、`/skill:xxx`）。
  - 本机**没有** pi 进程时，由守护进程在 tmux 里启动 pi（新会话或恢复旧会话）。
  - 后台保持连接（Android 前台服务），有确认请求或任务完成时发本地通知。
  - 子 agent（`subagent` 工具）和 team 成员（`team_spawn` 工具）启动的 pi 进程：在手机上按父子关系显示、可单独进入操作；它们在电脑上的状态面板（widget）、结果消息、求助消息、team 消息在手机上都有对应显示（7.6）。
- 本机终端里的 pi 与手机操作的是**同一个进程**：两边同时可见、可输入。
- 网络全部自建，且三端都可迁移（7.5）：
  - VPS 上运行一个中继服务 `pi-relay`，电脑上运行 `pi-hostd`，手机 App 在设置里填写中继地址。
  - 手机与电脑之间端到端加密，中继只转发密文；身份靠配对时交换的密钥，不绑定任何 IP 或域名。
  - 换 VPS：新 VPS 部署中继，电脑和手机各改一个地址，不需重新配对。换电脑：导出/导入身份文件。换手机：重新扫码配对。

### 1.2 明确不做的

- 手机端终端视图；`/login`、`/logout`、`/hotkeys`、`/share`、`/export`、`/import`、`/bug`、`/changelog`、`/scoped-models`、`/trust`、`/quit`。
- 推送服务（FCM 等）。只用前台服务 + 本地通知。
- iOS / Web 客户端（框架选型保留扩展性，但本期不实现、不测试）。
- 工具调用审批门（pi 本身没有，见 2 章 D9）。
- 本机睡眠/关机唤醒。
- 同时连接多台电脑（App 的数据结构按"电脑列表"设计，界面本期只用第一台）。
- 由 `cli: "claude"` 定义启动的子 agent（它不是 pi 进程，没有 bridge）：只显示在父进程的状态面板和结果消息里。

---

## 2. 已锁定决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | pi 一律以 TUI 模式运行在 tmux 中。用户自己开的 pi 照旧；守护进程启动的 pi 放在名为 `pi-remote` 的 tmux 会话里 | 保留 TUI 全部能力；本地随时 `tmux attach -t pi-remote` 接手；同一会话只有一个进程，避免 JSONL 无锁并发写坏（附录 A-5） |
| D2 | 每个 pi 进程加载扩展 `pi-remote-bridge`，只在 `ctx.mode === "tui"` 时启用 | 扩展能拿到事件、发消息、会话控制 API；`pi -p` 等一次性进程不应出现在列表里 |
| D3 | 本机守护进程 `pi-hostd`：Node 26 + TypeScript，systemd 用户服务 | 与 pi 同生态；负责鉴权、进程注册表、事件缓冲、启动 pi、会话列表、设置 |
| D4 | 网络拓扑：VPS 运行自研中继 `pi-relay`（`packages/relay`）。hostd 和 App 都**主动连接**中继；中继按 `hostId` 把一条 App 连接和 hostd 新开的一条数据连接拼接起来，之后只原样转发帧。hostd 另可开一个"直连"监听口（局域网/开发用），协议与经中继完全相同 | 电脑无需公网 IP；中继无状态、只需一个密钥配置，换 VPS 只是重新部署；中继不解析内容 |
| D5 | 端到端加密：使用 `@getpaseo/relay@0.15.3` 的 `e2ee` 模块（Noise `NK_25519_ChaChaPoly_SHA256`，纯 JS），hostd 持有长期密钥对，公钥在配对二维码中交给手机。中继与 App 之间可以是 `ws://`（无域名）或 `wss://`（有域名时在中继前加 TLS 反代） | 身份由密钥决定，与地址无关，因此换 VPS 不需要重签证书、不需要重新配对；中继或网络被攻破也无法读取或伪造消息。该库是 Paseo（Apache-2.0）手机端在 React Native 中实际使用的实现，不自己写密码学代码 |
| D6 | 设备鉴权：在加密通道内进行。一次性配对码换取设备长期密钥（32 字节随机），hostd 只存哈希；可吊销 | 单用户场景足够，实现简单 |
| D7 | 客户端：React Native，用 Expo 的 prebuild（CNG）+ development build，不用 Expo Go | 需要原生模块（前台服务）；Expo 工具链对弱编码模型最友好；以后可扩展 iOS/Web |
| D8 | 后台：`react-native-notify-kit`（Notifee 的维护分支）启动前台服务，类型 `remoteMessaging`；通知也用它发 | Notifee 已归档（2026-04），该分支官方推荐；`dataSync` 类型在 Android 15 每 24 小时限 6 小时，`remoteMessaging` 无此限制 |
| D9 | 本期不做工具审批门 | pi 本身不逐个审批工具调用（`docs/security.md:3`）。已有扩展的确认框会自动经 D11 转发到手机 |
| D10 | 会话操作语义 = 在该进程里做与本地输入相同的事：`/new`、`/fork`、`/clone`、`/tree`、`/resume` 都在当前进程内执行。会话列表里点开一个没在运行的会话 → hostd 新启动一个 pi | 与本地行为一致；`/resume` 目标若已在别的进程运行，则不切换，直接跳到那个进程 |
| D11 | 对话框镜像：bridge 包装 `ctx.ui` 的 `select/confirm/input/editor/custom`，本地 TUI 与手机同时显示，先回答者生效，另一边自动关闭 | 依赖 pi 内部结构（附录 A-6），因此仅在 pi 版本 ∈ `SUPPORTED_PI_VERSIONS` 时启用 |
| D12 | `custom()`（扩展自绘 TUI 组件）在手机上只显示"需在电脑上操作"卡片，并提供"取消"按钮（让扩展收到 `undefined`）。`ask_user_question` 用其自带事件协议在手机上原生渲染 | 自绘组件无法结构化；用户的扩展里，运行中会阻塞 agent 的 `custom()` 只有 ask_user_question |
| D13 | `editor()` 若手机先回答，本地 TUI 的编辑框不会自动关闭（API 不支持 signal），本地关闭时结果被忽略 | pi API 限制，接受 |
| D14 | 设置：只改全局设置（`~/.pi/agent/settings.json`）中白名单项，由 hostd 用 pi SDK 的 `SettingsManager` 写入；写完通知所有在线进程在空闲时 `reload` | `SettingsManager` 带文件锁并按字段合并（附录 A-9） |
| D15 | pi 版本锁定 1.5.0。bridge 检测到其他版本时：照常工作，但关闭 D11 的 UI 包装，并在进程信息里标 `compat: "untested"` | 降低升级风险 |
| D16 | 对守护进程启动的 pi，一律显式传 `--approve` 或 `--no-approve` | 否则 pi 可能在无人看的 TUI 里弹出项目信任提示而卡住（`docs/security.md` "How Pi chooses a trust decision"） |
| D17 | 子 agent 与 team 成员：不修改 `pi-interactive-subagents` 扩展。bridge 从环境变量识别进程角色，hostd 推导父子关系；扩展用组件函数绘制的 widget 由 bridge 在 60 列宽度下渲染成纯文本转发 | 该扩展的子进程本身就是 TUI 模式的 pi，会加载 bridge；所需信息都已在环境变量、工具结果 `details` 和自定义消息 `details` 中（附录 A-20～A-23） |
| D18 | 迁移：电脑身份（hostId + 密钥对 + 已配对设备）保存在一个目录中，可导出/导入；手机保存"电脑列表"，每台电脑的中继地址、直连地址可在设置里修改 | 满足"换 VPS / 换电脑 / 换手机都能迁移" |

---

## 3. 架构

```
Android App (React Native)
   │  ws(s)://<中继地址>/v1/client?hostId=H        ← 地址在 App 设置里可改
   │  内层：Noise NK 加密通道（手机持有 hostd 公钥），其中再跑 JSON 帧
   ▼
VPS: pi-relay（Node 服务或 Docker 容器，监听 7443）
   │  按 hostId 把手机连接与 hostd 的数据连接拼接，只转发密文帧
   ▲
   │  hostd 主动出站：控制连接 /v1/host/control + 每个手机一条 /v1/host/data
   │  （携带中继密钥，防止陌生人占用中继）
本机 pi-hostd（systemd 用户服务）          （可选：直连监听 ws://<局域网IP>:7444/v1/client，同样的加密通道）
   ├─ 加密通道、配对、设备鉴权、请求路由
   ├─ 进程注册表：processId → bridge 连接、ProcessInfo、事件环形缓冲
   ├─ 订阅与重放：断线后按 seq 补发，否则发快照
   ├─ 启动器：tmux new-window … pi [--session f] --approve/--no-approve
   ├─ 会话列表：SessionManager.listAll()
   └─ 设置：SettingsManager 写全局白名单项
        ▲
        │ Unix socket  $XDG_RUNTIME_DIR/pi-remote/bridge.sock（NDJSON）
        │
   pi (TUI, 在 tmux pane 中) + pi-remote-bridge 扩展
   pi (TUI)                  + pi-remote-bridge 扩展
   子 agent / team 成员 pi (TUI) + pi-remote-bridge 扩展（上报角色，hostd 推导父进程）
```

数据流要点：

- **seq 由 bridge 生成**：每个 pi 进程一个计数器，进程内跨会话切换不归零。hostd 只缓存、转发。
- **processId 由 bridge 生成**（UUID），整个 pi 进程生命周期不变；会话切换时发 `session_changed` 事件。
- **hostd 无业务状态持久化**：进程信息全部来自 bridge；重启 hostd 后 bridge 会自动重连并重新上报。hostd 只持久化身份与配置（`~/.config/pi-remote/`）。
- **中继完全无状态**：不存任何数据，不解析拼接后的帧；重启或更换后，hostd 与 App 各自重连即可。
- **网络层分两层**：外层是 WebSocket（经中继或直连），内层是 D5 的加密通道。应用协议（6.7 节 `ClientToHost` / `HostToClient`）只在内层中传输，与外层走哪条路无关。

---

## 4. 仓库结构

项目根目录：`/home/moorey/Projects/Pi-extension-dev/extensions/pi-remote/`（本文件所在目录），下文的"项目根目录"、"根目录"都指这里。它是 Git 仓库 `/home/moorey/Projects/Pi-extension-dev` 的子目录，npm workspaces 的根在项目根目录。

```
pi-remote/
├─ plan.md                     本文件
├─ NOTES.md                    实现中发现的偏差记录（实现者创建）
├─ package.json                npm workspaces 根
├─ tsconfig.base.json
├─ .gitignore
├─ packages/
│  ├─ protocol/                共享类型与常量（纯 TS，无依赖）
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ version.ts
│  │     ├─ model.ts           ProcessInfo、ModelSummary、SessionListItem 等
│  │     ├─ events.ts          BridgeEvent 联合类型
│  │     ├─ ui.ts              UiRequest / UiResponse / Rpiv*
│  │     ├─ ops.ts             所有 op 的参数与返回类型
│  │     ├─ frames.ts          线上帧格式（bridge↔hostd、app↔hostd）
│  │     ├─ relay.ts           中继路径、控制帧、关闭码（hostd 与 relay 共用）
│  │     ├─ settings.ts        远程可改设置白名单
│  │     └─ errors.ts          错误码
│  ├─ relay/                   VPS 中继服务（7.4）
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ Dockerfile
│  │  ├─ pi-relay.service      不用 Docker 时的 systemd 单元
│  │  └─ src/main.ts
│  ├─ bridge/                  pi 扩展
│  │  ├─ package.json          含 "pi": { "extensions": ["./src/index.ts"] }
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts           扩展入口：注册事件与命令
│  │     ├─ state.ts           globalThis 单例
│  │     ├─ host-conn.ts       Unix socket 客户端（重连、发送队列）
│  │     ├─ ndjson.ts          分帧
│  │     ├─ events.ts          pi 事件 → BridgeEvent 转换与裁剪
│  │     ├─ ui-mirror.ts       ctx.ui 包装（D11/D12/D13）
│  │     ├─ widget-text.ts     组件 widget 渲染成文本（D17）
│  │     ├─ role.ts            从环境变量判断进程角色（7.6.1）
│  │     ├─ rpiv.ts            ask_user_question 事件协议
│  │     ├─ ops.ts             op 处理
│  │     ├─ remote-op-cmd.ts   隐藏命令，用于拿 ExtensionCommandContext
│  │     ├─ snapshot.ts        快照、历史分页、会话树
│  │     ├─ sanitize.ts        消息裁剪（图片、长文本）
│  │     └─ log.ts             文件日志
│  └─ hostd/                   守护进程
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ scripts/
│     │  └─ dev-client.ts      命令行调试客户端（无 App 时验收用）
│     ├─ systemd/
│     │  └─ pi-hostd.service
│     └─ src/
│        ├─ main.ts            CLI：serve / init / pair / qr / relay / direct / devices / export / import
│        ├─ paths.ts
│        ├─ config.ts
│        ├─ log.ts
│        ├─ ndjson.ts          与 bridge 相同实现（复制一份，不跨包引用）
│        ├─ devices.ts         设备与配对码
│        ├─ audit.ts
│        ├─ bridge-server.ts   Unix socket 服务端
│        ├─ registry.ts        进程注册表
│        ├─ event-ring.ts      事件环形缓冲
│        ├─ client-hub.ts      App 连接管理（鉴权、配对）、订阅、路由
│        ├─ ops.ts             op 分发表与参数校验
│        ├─ spawner.ts         tmux 启动 pi
│        ├─ sessions-index.ts  会话列表
│        ├─ settings-service.ts
│        ├─ identity.ts        hostId 与长期密钥对
│        ├─ links.ts           推导子 agent / team 成员的父进程
│        ├─ session-reader.ts  只读解析会话 JSONL（read_session）
│        ├─ secure-socket.ts   把一条 WebSocket 包装成加密通道（服务端）
│        ├─ relay-client.ts    到中继的控制连接与数据连接
│        └─ direct-server.ts   可选的直连监听
└─ apps/
   └─ mobile/                  Expo 应用
      ├─ app.json
      ├─ index.js              入口：先注册前台服务，再加载 expo-router
      ├─ metro.config.js
      └─ src/
         ├─ app/               expo-router 页面
         ├─ net/
         ├─ state/
         ├─ bg/
         ├─ ui/
         └─ lib/
```

---

## 5. 环境准备

### 5.1 本机（Arch Linux）——由实现者在 M0 之前完成

已就绪（2026-11-06 核实，不要重装）：Node v26、npm 12、git、tmux 3.8（`~/.tmux.conf` 已开启 `extended-keys` 与 `csi-u`）、openssh、openssl、adb（`android-tools`，用户已在 `adbusers` 组）、pi 1.5.0、**JDK 17（`/usr/lib/jvm/java-17-openjdk`，`javac 17.0.21`）**。系统默认 Java 仍是 21，不要改默认值（不要运行 `archlinux-java set`）。

按顺序执行，每步执行后做括号里的检查：

1. **Android 命令行工具**（装在用户目录，不需要 sudo；目录可写，Gradle 才能自动补装 NDK、CMake）：
   ```zsh
   set -euo pipefail
   sdk="$HOME/Android/Sdk"
   mkdir -p "$sdk/cmdline-tools"
   zip=$(curl -fsS https://dl.google.com/android/repository/repository2-3.xml \
         | grep -o 'commandlinetools-linux-[0-9]*_latest.zip' | sort -t- -k3 -n -u | tail -1)
   curl -fL -o /tmp/cmdline-tools.zip "https://dl.google.com/android/repository/$zip"
   rm -rf /tmp/cmdline-tools-unzip && mkdir /tmp/cmdline-tools-unzip
   unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-unzip
   rm -rf "$sdk/cmdline-tools/latest"
   mv /tmp/cmdline-tools-unzip/cmdline-tools "$sdk/cmdline-tools/latest"
   rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools-unzip
   ```
   （检查：`$sdk/cmdline-tools/latest/bin/sdkmanager` 存在。2026-11-06 时最新的是 `commandlinetools-linux-16111833_latest.zip`。）
2. **环境变量**：在 `~/.zshrc` 末尾追加下面的块（先 `grep -q 'pi-remote android env' ~/.zshrc` 检查，已存在就跳过，保证只追加一次）。只追加，不修改文件中已有的任何行：
   ```zsh
   # >>> pi-remote android env >>>
   export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
   export ANDROID_HOME="$HOME/Android/Sdk"
   path+=("$ANDROID_HOME/cmdline-tools/latest/bin" "$ANDROID_HOME/platform-tools")
   # <<< pi-remote android env <<<
   ```
   当前 shell 中同样 `export` 一遍（agent 自己的 shell 不会重新加载 zshrc）。所有 Gradle/Expo 命令前都要确认 `JAVA_HOME` 指向 JDK 17。（检查：`$JAVA_HOME/bin/javac -version` 输出 17；`sdkmanager --version` 能运行。）
3. **SDK 组件**：
   ```zsh
   yes | sdkmanager --licenses >/dev/null
   sdkmanager "platform-tools" "platforms;android-37" "build-tools;37.0.0"
   ```
   以上版本对应 Expo SDK 58（compileSdk 37）。M7a 创建 App 后若 Expo 版本不同，或 Gradle 报缺少某个 platform/build-tools/NDK/CMake 版本，按报错用 `sdkmanager` 补装，并记入 NOTES.md。（检查：`sdkmanager --list_installed` 中包含这三项。）
   注意：`platform-tools` 会带来另一个 `adb`。PATH 中 `/usr/bin/adb` 在前即可，两者都能用；若出现 adb 版本冲突提示，执行 `adb kill-server` 后重试。
4. **linger**：`loginctl enable-linger moorey`，让 pi-hostd 在用户未登录时也运行。若提示需要认证而失败，不要用 sudo，记入 NOTES.md 并在第一次人工检查点告诉用户（不影响开发）。（检查：`loginctl show-user moorey -p Linger` 为 `yes`。）
5. **本机代理**：本机网络经过一个 TUN 模式的代理（连接外部地址时源地址显示为 `198.18.0.1`）。2026-11-06 核实经此代理可以访问 `62.234.87.78` 的 8000 端口。若 M6 时 hostd 连不上中继而 VPS 本机能访问，记录现象并在人工检查点让用户把 `62.234.87.78` 设为代理直连规则。

### 5.2 VPS：TencentVPS（由实现者在 M6 部署）

**环境事实**（2026-11-06 只读核实）：

| 项 | 值 |
|---|---|
| SSH 别名 | `TencentVPS`（`~/.ssh/config` 已配置密钥，`ssh TencentVPS` 免密码登录） |
| 地址 | `62.234.87.78`（腾讯云轻量服务器，北京） |
| 系统 | Debian 12，x86_64，2 核，约 1.9GB 内存（可用约 1.1GB），磁盘剩余约 42GB |
| 用户 | `moorey`，在 `docker` 组（docker 命令不需要 sudo）；`sudo` 需要密码 → **实现者不得使用 sudo** |
| Docker | 29.9，已配置腾讯云镜像加速 `mirror.ccs.tencentyun.com`；`docker pull node:24-alpine` 已成功（镜像已在 VPS 上） |
| Node | 未安装 → 中继**只用 Docker 方式**部署 |
| 已占用端口 | 22、80（blog 容器）、8000（st-proxy 容器）；**7443 空闲** |
| 已有容器 | `blog`、`st-proxy`、`sillytavern`、`emb-proxy`：**一律不得改动、停止或重启** |
| 网络 | 容器内可访问 registry.npmjs.org；Docker Hub 直连不通，只能经镜像加速拉取 |
| 防火墙 | 腾讯云控制台防火墙已放行 TCP 7443（2026-11-07 从本机经代理和直连访问临时监听均返回 200）。部署前仍按第 1 步复查一次 |

**部署步骤**（实现者执行，范围仅限以下命令）：

1. **端口连通性检查**（部署前）：
   ```zsh
   ssh TencentVPS 'nohup timeout 30 python3 -m http.server 7443 --bind 0.0.0.0 >/tmp/pi-relay-porttest.log 2>&1 &'
   sleep 3
   curl -sS --noproxy '*' -m 8 -o /dev/null -w '%{http_code}\n' http://62.234.87.78:7443/
   ssh TencentVPS 'cat /tmp/pi-relay-porttest.log; rm -f /tmp/pi-relay-porttest.log'
   ```
   通过的标准：curl 输出 `200`，且日志里有一行 GET 请求。不通过 → 人工检查点（第 0 章第 12 条），请用户在控制台放行 TCP 7443。
2. **生成中继密钥**（本机）：`openssl rand -base64 32`，写入本机 `~/.config/pi-remote/relay-secret`（0600，供 `relay set` 使用；该目录在 M2 已创建）。不要把密钥写进仓库、NOTES.md 或提交信息。
3. **拷贝代码**：`ssh TencentVPS 'mkdir -p ~/pi-relay'`，然后 `scp -r packages/relay/{package.json,Dockerfile,src} TencentVPS:~/pi-relay/`。
4. **构建与运行**：
   ```zsh
   ssh TencentVPS 'cd ~/pi-relay && docker build -t pi-relay .'
   ssh TencentVPS "docker rm -f pi-relay 2>/dev/null; docker run -d --name pi-relay --restart unless-stopped \
     -p 7443:7443 -e RELAY_SECRET='$(cat ~/.config/pi-remote/relay-secret)' pi-relay"
   ```
   `docker rm -f` 只能作用于名为 `pi-relay` 的容器。Dockerfile 中的 `RUN npm install` 在 VPS 上可以访问 npm（已核实）；若失败，在 Dockerfile 中加 `RUN npm config set registry https://registry.npmmirror.com` 后重试，并记入 NOTES.md。
5. **验证**：`curl -sS --noproxy '*' http://62.234.87.78:7443/healthz` 返回 `{"ok":true,...}`；`ssh TencentVPS 'docker logs --tail 20 pi-relay'` 无报错。
6. **本机指向中继**：`node packages/hostd/src/main.ts relay set ws://62.234.87.78:7443 --secret "$(cat ~/.config/pi-remote/relay-secret)"`，5 秒后 `relay show` 为 `connected`。
7. **更新中继**（以后改了 relay 代码时）：重复第 3、4 步。

抓包类验收一律不用 tcpdump（需要 sudo），改用 dev-client 的 `--dump-wire` 开关（7.2.15）。

使用其他 VPS 时，按同样步骤部署，只是替换 SSH 别名和地址（迁移见 7.5）。

### 5.3 Waydroid（本机安卓调试环境，M7 使用）

M7 中真机验收之前的所有步骤都在 Waydroid 上**无人值守**完成。以下事实已在 2026-11-07 实测：

| 项 | 实测结果 |
|---|---|
| 系统 | LineageOS 20（Android 13，SDK 33），x86_64（abilist `x86_64,x86`），屏幕 2305×1513 |
| 容器与会话 | `waydroid-container.service` 已由用户启用并运行；会话 RUNNING，Wayland display `wayland-1`，niri 中窗口标题 `Waydroid` |
| 地址 | 容器 `192.168.240.112`；主机在 `waydroid0` 网桥上的地址 `192.168.240.1` |
| adb | `adb connect 192.168.240.112:5555` 可用；本机 adb 公钥**已被永久授权**（重启 adb 服务后重连无需确认） |
| 网络 | 容器能访问 VPS（`curl http://62.234.87.78:8000/` 得到 401）；能访问主机 `192.168.240.1` 上的监听；`adb reverse` 可用 |
| 可用命令 | `curl`、`nc`、`uiautomator`、`screencap`、`input`、`am`、`pm`、`svc`、`cmd`、`dumpsys` |
| 界面读取 | `adb exec-out uiautomator dump /dev/tty` 返回完整 XML（text、content-desc、bounds）；按 bounds 中心点 `input tap` 已验证能正确进入目标页面 |
| 截图 | `adb exec-out screencap -p` 正常 |
| **文字输入** | **`input text` 不可靠**：容器内 Gboard 当前是中文拼音键盘，按键进入拼音候选而不直接上屏（实测输入 `battery` 只得到 `atte` 或没有内容）。**不要修改 Waydroid 的输入法设置**，改用第 7 条的测试钩子输入文字 |
| 断网模拟 | `cmd connectivity airplane-mode enable` **不会**断开容器网络（容器走以太网）。断线重连改为在服务端模拟：停止/重启 hostd、`ssh TencentVPS 'docker restart pi-relay'` |
| 通知检查 | `dumpsys notification --noredact` 可用，用于确认 App 发出的通知 |
| 省电模拟 | `dumpsys deviceidle force-idle` / `unforce` 可用 |

**使用步骤**（全部由 agent 执行）：

1. 检查：`systemctl is-active waydroid-container` 为 `active`，否则进入人工检查点（需要用户 `sudo systemctl start waydroid-container`）。`waydroid status` 中 `Session` 不是 `RUNNING` 时执行 `waydroid session start &` 并轮询最多 90 秒；若报找不到显示，先 `export WAYLAND_DISPLAY=wayland-1`（以 `ls $XDG_RUNTIME_DIR/wayland-*` 实际结果为准）。
2. 连接：`adb connect 192.168.240.112:5555`，之后所有命令用 `adb -s 192.168.240.112:5555 ...`。若状态为 `unauthorized`（只会在用户重置过 Waydroid 时发生）→ 人工检查点：请用户在 Waydroid 窗口的弹窗中勾选 "Always allow from this computer" 后点 Allow。
3. 构建与安装：Waydroid 用"测试构建"（第 7 条），`./gradlew assembleRelease` 后 `adb -s ... install -r <apk>`，再 `adb -s ... shell pm grant dev.moorey.piremote android.permission.POST_NOTIFICATIONS`（SDK 33 支持），避免权限弹窗卡住无人值守流程。启动：`adb -s ... shell monkey -p dev.moorey.piremote 1`。Expo 默认 ABI 列表包含 `x86_64`，不要删掉。使用 release 构建可以不依赖 Metro；需要热更新调试时再用 dev build + `adb -s ... reverse tcp:8081 tcp:8081`。
4. 直连地址：在 Waydroid 中测试直连用 `pi-hostd direct enable --advertise ws://192.168.240.1:7444`。真机验收前改成电脑的局域网地址或关闭直连。
5. 操作界面：
   - 读界面：`uiautomator dump`，按 `content-desc`（即 RN 的 `accessibilityLabel`）找元素，用 `bounds` 中心点 `input tap`。
   - 为此，**App 中所有可交互元素和需要检查的文本容器都必须设置英文 `accessibilityLabel`**（例如 `composer-input`、`send-button`、`ui-request-option-0`），在 NOTES.md 维护"标签 → 页面/作用"对照表。
   - 需要看画面时：`screencap` 后按用户全局 AGENTS.md 的"读图"规则处理。
6. 配对（不扫码）：`qr=$(node packages/hostd/src/main.ts pair --json)`，然后
   `adb -s ... shell am start -a android.intent.action.VIEW -d "piremote://pair?qr=<encodeURIComponent($qr)>"`，在确认对话框中点 `pair-confirm-button`。
7. **测试钩子**（只在测试构建中存在）：
   - 构建开关：构建时环境变量 `EXPO_PUBLIC_TEST_HOOKS=1`。代码中用 `process.env.EXPO_PUBLIC_TEST_HOOKS === "1"` 判断；该值为假时，钩子代码不注册任何深链接处理，也不输出 `PIREMOTE_TEST` 日志。**交给真机验收的 APK 必须不带此开关构建**。
   - `piremote://test/type?label=<accessibilityLabel>&text=<encodeURIComponent(文本)>`：把文本写入该标签对应的 `TextInput`（各 TextInput 组件挂载时把自己的 setter 注册到 `src/lib/test-hooks.ts` 的表里，卸载时注销）。中文文本也可以这样输入。
   - `piremote://test/dump`：把 store 摘要（连接状态、通道、进程列表的 processId/status/role/parentProcessId、当前页面的 messages 条数与最后一条消息前 200 字符、pendingUi、pendingRpiv、extWidgets 的 key）作为一行 JSON，以 `PIREMOTE_TEST ` 前缀 `console.log` 输出。agent 用 `adb -s ... logcat -d -s ReactNativeJS | grep PIREMOTE_TEST | tail -1` 读取。验收时用它核对状态，用 uiautomator 核对界面。
   - 深链接打开前先 `adb -s ... logcat -c` 清空日志，避免读到旧结果。
8. 通知与后台：`input keyevent KEYCODE_HOME` 让 App 进入后台，`dumpsys deviceidle force-idle` 模拟省电；在电脑上触发任务完成或确认请求后，用 `dumpsys notification --noredact | grep -A3 dev.moorey.piremote` 确认通知标题与内容；前台服务用 `dumpsys activity services dev.moorey.piremote` 确认。最后 `dumpsys deviceidle unforce`。"点击通知跳转到会话页"不在 Waydroid 上验收，留作真机项。
9. 结束：`waydroid session stop` 不需要执行（用户可能在用），保持现状即可。不要卸载或重置 Waydroid，不要改它的系统设置、输入法和其他应用。

---

## 6. 协议规范（`packages/protocol`）

本章代码**原样**放入对应文件。所有类型都是 JSON 可序列化的。

### 6.1 `version.ts`

```ts
export const PROTOCOL_VERSION = 1;
export const BRIDGE_VERSION = "0.1.0";
export const HOSTD_VERSION = "0.1.0";
/** D11 的 UI 包装只在这些 pi 版本启用 */
export const SUPPORTED_PI_VERSIONS: readonly string[] = ["1.5.0"];
export const HIDDEN_COMMAND = "pi-remote-op";
export const RELAY_DEFAULT_PORT = 7443;
export const DIRECT_DEFAULT_PORT = 7444;
/** widget 组件渲染成文本时使用的列宽（D17） */
export const WIDGET_RENDER_COLUMNS = 60;
```

### 6.2 `errors.ts`

```ts
export type ErrorCode =
  | "bad_request"          // 参数缺失或类型错误
  | "unauthorized"
  | "not_found"            // processId / uiId / entryId 不存在
  | "busy"                 // 需要空闲但 agent 正在运行
  | "busy_need_deliver_as" // 运行中发消息但没指定 steer/followUp
  | "replacing"            // 进程正在切换会话，稍后重试
  | "conflict_live_elsewhere" // 目标会话已在别的进程中打开
  | "model_no_image"       // 当前模型不支持图片输入
  | "no_model"
  | "no_auth"              // setModel 返回 false
  | "spawn_failed"
  | "spawn_timeout"
  | "bridge_gone"          // 请求期间 pi 进程退出
  | "timeout"
  | "incompatible"         // 协议版本不匹配
  | "unsupported"
  | "internal";

export interface RemoteError { code: ErrorCode; message: string }
```

### 6.3 `model.ts`

```ts
export type ProcessStatus = "idle" | "running" | "waiting_ui";

export interface ModelSummary {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];          // 例如 ["text","image"]
  contextWindow?: number;
}

export interface ContextUsageWire {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** 进程角色，由 bridge 从环境变量判断（7.6.1） */
export type ProcessRole =
  | { kind: "main" }
  | { kind: "subagent"; subagentId: string; name: string; agent?: string; autoExit: boolean }
  | { kind: "team_member"; memberId: string; name: string; agent?: string; write: boolean;
      branch?: string; worktree?: string; leadPid: number; runDir?: string };

export interface ProcessInfo {
  processId: string;
  pid: number;
  role: ProcessRole;
  /** 由 hostd 填写（7.6.2）；父进程不在线或无法推导时为空。bridge 上报时不带此字段 */
  parentProcessId?: string;
  /** bridge 上报：本进程启动过的子 agent 会话文件（最多 50 个，新的在前），供 hostd 推导父子关系 */
  childSessionFiles: string[];
  tmuxPane?: string;        // $TMUX_PANE，例如 "%12"
  spawnedByHostd: boolean;
  piVersion: string;
  compat: "ok" | "untested";
  cwd: string;
  sessionId: string;
  sessionFile?: string;     // --no-session 时为空
  sessionName?: string;
  model?: ModelSummary;
  thinkingLevel: string;
  status: ProcessStatus;
  pendingUiCount: number;   // 未关闭的对话框 + 问卷数
  lastText?: string;        // 最近一次 agent_settled 时最后一条 assistant 文本的前 120 字符
  contextUsage?: ContextUsageWire;
  lastSeq: number;
}

export interface SessionListItem {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  name?: string;
  created: string;          // ISO
  modified: string;         // ISO
  messageCount: number;
  firstMessage: string;     // 截断到 200 字符
  liveProcessId?: string;
}

export interface ProjectItem { cwd: string; lastModified: string; sessionCount: number }

/** 消息的线上形态：pi AgentMessage 经过 sanitize（见 7.1.7） */
export interface WireMessage {
  role: string;             // user | assistant | toolResult | bashExecution | custom | branchSummary | compactionSummary
  entryId?: string;         // 来自会话树的条目才有
  [key: string]: unknown;
}

export interface TreeNodeWire {
  id: string;
  parentId: string | null;
  kind: "user" | "assistant" | "toolResult" | "custom" | "compaction" | "branch_summary" | "bash" | "other";
  preview: string;          // 前 120 字符
  label?: string;
  timestamp: string;
  onActivePath: boolean;
  isLeaf: boolean;          // 是否为当前活动叶子
  childCount: number;
}

export interface ForkPoint { entryId: string; text: string; timestamp: string }

export interface CommandInfo { name: string; description?: string; source: string }
```

### 6.4 `ui.ts`

```ts
export type UiRequest =
  | { uiId: string; kind: "select"; title: string; options: string[]; timeoutMs?: number }
  | { uiId: string; kind: "confirm"; title: string; message: string; timeoutMs?: number }
  | { uiId: string; kind: "input"; title: string; placeholder?: string; timeoutMs?: number }
  | { uiId: string; kind: "editor"; title: string; prefill?: string }
  | { uiId: string; kind: "custom"; title?: string; coveredBy?: string };

export type UiResponse =
  | { value: string }          // select / input / editor
  | { confirmed: boolean }     // confirm
  | { cancelled: true };       // 任意类型；custom 只接受这一种

export interface RpivOption { label: string; description?: string; hasPreview?: boolean }
export interface RpivQuestion { question: string; header: string; multiSelect: boolean; options: RpivOption[] }
export interface RpivPrompt { toolCallId: string; questions: RpivQuestion[] }

export interface RpivAnswerItem {
  questionIndex: number;
  optionIndexes?: number[];
  text?: string;
}
export interface RpivAnswer {
  toolCallId: string;
  answers?: RpivAnswerItem[];
  globalNote?: string;
  cancel?: true;
}
```

### 6.5 `events.ts`

```ts
import type { ContextUsageWire, ModelSummary, ProcessInfo, WireMessage } from "./model.ts";
import type { RpivPrompt, UiRequest } from "./ui.ts";

/** assistant 流式增量。来自 pi 的 assistantMessageEvent，去掉了 partial / message 字段 */
export type AssistantDelta =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } };

export type BridgeEvent =
  | { type: "session_changed"; reason: string; info: ProcessInfo }
  | { type: "info"; info: ProcessInfo }                 // ProcessInfo 任一字段变化时发送完整新值
  | { type: "agent_start" }
  | { type: "agent_settled"; aborted: boolean; lastText?: string }
  | { type: "message_start"; message: WireMessage }
  | { type: "message_update"; delta: AssistantDelta }
  | { type: "message_end"; message: WireMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; partialText: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; durationMs?: number }
  | { type: "model_changed"; model: ModelSummary }
  | { type: "thinking_changed"; level: string }
  | { type: "compaction"; phase: "end" | "failed"; error?: string }
  | { type: "context_usage"; usage: ContextUsageWire }
  | { type: "ui_request"; req: UiRequest }
  | { type: "ui_closed"; uiId: string; by: "local" | "remote" }
  | { type: "rpiv_prompt"; prompt: RpivPrompt }
  | { type: "rpiv_closed"; toolCallId: string }
  | { type: "notify"; message: string; level: "info" | "warning" | "error" }
  | { type: "ext_status"; key: string; text?: string }
  | { type: "ext_widget"; key: string; lines?: string[]; placement: "aboveEditor" | "belowEditor" }
  | { type: "error"; message: string };                 // 例如异步 prompt 失败
```

说明：`tool_end` 不带结果正文，结果以随后的 `message_end`（`role: "toolResult"`）为准，避免重复传输。

### 6.6 `ops.ts`

```ts
import type { CommandInfo, ForkPoint, ModelSummary, ProcessInfo, ProjectItem, SessionListItem, TreeNodeWire, WireMessage } from "./model.ts";
import type { RpivAnswer, RpivPrompt, UiRequest, UiResponse } from "./ui.ts";

export type Trust = "approve" | "deny";
export type DeliverAs = "steer" | "followUp";

export interface ImageInput { data: string; mimeType: string }   // base64

export interface Snapshot {
  info: ProcessInfo;
  seq: number;                       // 快照对应的最后事件序号
  messages: WireMessage[];           // 活动分支上最近 N 条（含 entryId）
  hasMoreBefore: boolean;
  inflight?: WireMessage;            // 正在流式生成的 assistant 消息
  runningTools: { toolCallId: string; toolName: string; args: unknown; partialText: string }[];
  pendingUi: UiRequest[];
  pendingRpiv: RpivPrompt[];
  extStatus: Record<string, string>;
  extWidgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
}

/** 键为 op 名，值为 [参数, 返回] */
export interface OpMap {
  // ---- hostd 本地处理 ----
  list_processes: [{}, { processes: ProcessInfo[] }];
  list_sessions: [{ cwd?: string; refresh?: boolean }, { sessions: SessionListItem[] }];
  list_projects: [{}, { projects: ProjectItem[] }];
  open_session: [{ sessionFile: string; trust: Trust }, { processId: string; spawned: boolean }];
  new_process: [{ cwd: string; trust: Trust }, { processId: string }];
  subscribe: [{ processId: string; sinceSeq?: number }, { mode: "replay" } | { mode: "snapshot"; snapshot: Snapshot }];
  unsubscribe: [{ processId: string }, {}];
  get_settings: [{}, { values: Record<string, unknown> }];
  set_setting: [{ key: string; value: unknown }, { values: Record<string, unknown> }];
  /** 只读查看任意会话文件（例如已结束的子 agent），不启动 pi；7.2.16 */
  read_session: [{ sessionFile: string; beforeEntryId?: string; limit?: number }, { cwd: string; name?: string; messages: WireMessage[]; hasMoreBefore: boolean }];
  // ---- 转发给 bridge ----
  prompt: [{ processId: string; text: string; images?: ImageInput[]; deliverAs?: DeliverAs }, { accepted: true }];
  abort: [{ processId: string }, {}];
  ui_respond: [{ processId: string; uiId: string; response: UiResponse }, {}];
  rpiv_answer: [{ processId: string; answer: RpivAnswer }, { ok: boolean; code?: string; reason?: string }];
  get_history: [{ processId: string; beforeEntryId: string; limit?: number }, { messages: WireMessage[]; hasMoreBefore: boolean }];
  get_commands: [{ processId: string }, { commands: CommandInfo[] }];
  get_models: [{ processId: string }, { current?: ModelSummary; models: ModelSummary[] }];
  set_model: [{ processId: string; provider: string; id: string }, { model: ModelSummary }];
  get_thinking_levels: [{ processId: string }, { current: string; levels: string[] }];
  set_thinking: [{ processId: string; level: string }, {}];
  compact: [{ processId: string; customInstructions?: string }, {}];
  get_tree: [{ processId: string }, { nodes: TreeNodeWire[]; leafId: string | null }];
  navigate_tree: [{ processId: string; entryId: string; summarize: boolean; customInstructions?: string }, { cancelled: boolean }];
  get_fork_points: [{ processId: string }, { points: ForkPoint[] }];
  fork: [{ processId: string; entryId: string; position: "before" | "at" }, { cancelled: boolean; prefillText?: string }];
  new_session: [{ processId: string }, { cancelled: boolean }];
  switch_session: [{ processId: string; sessionFile: string }, { cancelled: boolean }];
  set_name: [{ processId: string; name: string }, {}];
  reload: [{ processId: string }, {}];
  shutdown: [{ processId: string }, {}];
}

export type OpName = keyof OpMap;
export type OpArgs<K extends OpName> = OpMap[K][0];
export type OpResult<K extends OpName> = OpMap[K][1];

export const HOSTD_LOCAL_OPS: readonly OpName[] = [
  "list_processes", "list_sessions", "list_projects", "open_session", "new_process",
  "subscribe", "unsubscribe", "get_settings", "set_setting", "read_session",
];

/** hostd → bridge 请求超时（毫秒）。未列出的用 DEFAULT */
export const OP_TIMEOUT_MS: Partial<Record<OpName, number>> & { DEFAULT: number } = {
  DEFAULT: 15_000,
  compact: 600_000,
  navigate_tree: 300_000,
  fork: 60_000,
  new_session: 60_000,
  switch_session: 60_000,
  reload: 120_000,
};
```

bridge 内部还处理两个不在 `OpMap` 里、只由 hostd 发起的请求：`get_snapshot { maxMessages: number }` → `Snapshot`，`reload_when_idle {}` → `{}`。在 `frames.ts` 里以 `BridgeInternalOp` 定义：

### 6.7 `frames.ts`

```ts
import type { RemoteError } from "./errors.ts";
import type { BridgeEvent } from "./events.ts";
import type { ProcessInfo } from "./model.ts";

export type BridgeInternalOp = "get_snapshot" | "reload_when_idle";

// ---------- bridge ↔ hostd（Unix socket，NDJSON） ----------
export type BridgeToHost =
  | { t: "hello"; protocol: number; bridgeVersion: string; spawnToken?: string; info: ProcessInfo }
  | { t: "ev"; processId: string; seq: number; ev: BridgeEvent }
  | { t: "res"; id: string; ok: true; data: unknown }
  | { t: "res"; id: string; ok: false; error: RemoteError }
  | { t: "bye"; processId: string };

export type HostToBridge =
  | { t: "welcome"; protocol: number }
  | { t: "req"; id: string; op: string; args: Record<string, unknown> };

// ---------- app ↔ hostd（加密通道内的 JSON 文本帧，6.11） ----------
export type ClientToHost =
  | { t: "auth"; protocol: number; deviceId: string; secret: string }
  | { t: "pair"; protocol: number; code: string; deviceName: string }
  | { t: "req"; id: string; op: string; args: Record<string, unknown> }
  | { t: "ping"; ts: number };

export type HostToClient =
  | { t: "auth_ok"; hostVersion: string; hostName: string }
  | { t: "auth_err"; code: "unauthorized" | "incompatible" }
  | { t: "pair_ok"; deviceId: string; secret: string; hostName: string; hostVersion: string }
  | { t: "pair_err"; code: "invalid_code" | "incompatible" }
  | { t: "res"; id: string; ok: true; data: unknown }
  | { t: "res"; id: string; ok: false; error: RemoteError }
  | { t: "evt"; processId: string; seq: number; ev: BridgeEvent }
  | { t: "proc"; kind: "up" | "down" | "changed"; info: ProcessInfo }
  | { t: "pong"; ts: number };

/** 一台电脑的连接信息。relays 中是中继的基础地址，例如 "ws://203.0.113.5:7443" 或 "wss://relay.example.com" */
export interface HostEndpoint {
  hostId: string;          // 22 字符 base64url（16 字节随机）
  hostKey: string;         // hostd 长期公钥，base64（D5）
  hostName: string;
  relays: string[];        // 本期只用第一个
  direct?: string;         // 例如 "ws://192.168.1.10:7444"
}

/** 配对二维码内容（JSON 字符串）。`pi-hostd pair` 生成 */
export interface PairQr extends HostEndpoint { v: 2; kind: "pair"; code: string }
/** 连接信息二维码（不含配对码）。`pi-hostd qr` 生成，用于换 VPS 后更新手机上的地址 */
export interface EndpointQr extends HostEndpoint { v: 2; kind: "endpoint" }
```

### 6.8 `settings.ts`

```ts
export interface RemoteSettingDef {
  key: string;
  label: string;
  type: "boolean" | "enum";
  options?: string[];
  /** reload：需要在线进程 reload 才生效；new_session：仅新会话生效；app：只影响 App 显示 */
  applies: "reload" | "new_session" | "app";
}

export const REMOTE_SETTINGS: readonly RemoteSettingDef[] = [
  { key: "defaultThinkingLevel", label: "Default thinking level", type: "enum", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], applies: "new_session" },
  { key: "hideThinkingBlock", label: "Hide thinking blocks", type: "boolean", applies: "reload" },
  { key: "steeringMode", label: "Steering delivery", type: "enum", options: ["one-at-a-time", "all"], applies: "reload" },
  { key: "followUpMode", label: "Follow-up delivery", type: "enum", options: ["one-at-a-time", "all"], applies: "reload" },
  { key: "compaction.enabled", label: "Auto compaction", type: "boolean", applies: "reload" },
  { key: "retry.enabled", label: "Auto retry on failure", type: "boolean", applies: "reload" },
  { key: "transport", label: "Model transport", type: "enum", options: ["auto", "sse", "websocket", "websocket-cached"], applies: "reload" },
  { key: "cacheWarming", label: "Prompt cache warming", type: "enum", options: ["off", "streaming", "idle"], applies: "reload" },
  { key: "images.blockImages", label: "Block images to model", type: "boolean", applies: "reload" },
  { key: "images.autoResize", label: "Auto-resize images", type: "boolean", applies: "reload" },
  { key: "enableSkillCommands", label: "Register skills as /skill: commands", type: "boolean", applies: "reload" },
  { key: "showCacheMissNotices", label: "Show cache miss notices", type: "boolean", applies: "reload" },
  { key: "defaultProjectTrust", label: "Default project trust", type: "enum", options: ["ask", "always", "never"], applies: "new_session" },
  { key: "treeFilterMode", label: "Default /tree filter", type: "enum", options: ["default", "no-tools", "user-only", "labeled-only", "all"], applies: "app" },
];
```

### 6.9 `index.ts`

```ts
export * from "./version.ts";
export * from "./errors.ts";
export * from "./model.ts";
export * from "./ui.ts";
export * from "./events.ts";
export * from "./ops.ts";
export * from "./frames.ts";
export * from "./relay.ts";
export * from "./settings.ts";
```

### 6.10 交互时序（实现时对照）

**订阅（无缺口重放）**
```
App → hostd  req subscribe {processId, sinceSeq: 120}
hostd: ring 中存在 121..lastSeq → res {mode:"replay"}，随后逐条发 evt(121..)
```

**订阅（快照）**
```
App → hostd  req subscribe {processId}            （或 sinceSeq 已不在 ring 中）
hostd: 把该客户端标为 pending，期间收到的该进程 evt 暂存到 pendingBuf
hostd → bridge req get_snapshot {maxMessages: 200}
bridge → hostd res Snapshot{seq: S, ...}
hostd → App  res {mode:"snapshot", snapshot}
hostd: 发送 pendingBuf 中 seq > S 的事件，清空 pendingBuf，取消 pending 标记
```

**对话框**
```
扩展调用 ctx.ui.select → bridge 发 ev ui_request{uiId}，同时本地 TUI 显示
  情况 A：手机先答  App → ui_respond → bridge：中止本地对话框，返回手机答案，发 ui_closed{by:"remote"}
  情况 B：本地先答  bridge：返回本地答案，发 ui_closed{by:"local"}，之后收到的 ui_respond 返回 not_found
```

### 6.11 `relay.ts` 与连接建立顺序

```ts
/** 中继的 WebSocket 路径。查询参数 hostId、connId 都用 encodeURIComponent */
export const RELAY_PATH_CLIENT = "/v1/client";             // ?hostId=H          App 使用，不带密钥
export const RELAY_PATH_HOST_CONTROL = "/v1/host/control"; // ?hostId=H          hostd 使用，Authorization: Bearer <RELAY_SECRET>
export const RELAY_PATH_HOST_DATA = "/v1/host/data";       // ?hostId=H&connId=C hostd 使用，同上
export const DIRECT_PATH_CLIENT = "/v1/client";            // 直连监听上的路径（无查询参数）

/** 中继 → hostd 控制连接上的文本帧（JSON） */
export type RelayToHost =
  | { t: "client"; connId: string }      // 有一个 App 连接在等待，请为它开一条数据连接
  | { t: "ping"; ts: number };
export type HostToRelay = { t: "pong"; ts: number };

/** WebSocket 关闭码 */
export const CLOSE = {
  HOST_OFFLINE: 4404,        // 中继：该 hostId 没有在线的 hostd
  HOST_REPLACED: 4409,       // 中继：同一 hostId 的新控制连接顶替了旧的
  BAD_RELAY_SECRET: 4401,    // 中继：hostd 的 RELAY_SECRET 不对
  PAIR_TIMEOUT: 4504,        // 中继：hostd 没在 10 秒内接上数据连接
  RATE_LIMITED: 4429,
  UNAUTHORIZED: 4411,        // hostd：设备鉴权失败或被吊销
  AUTH_TIMEOUT: 4408,        // hostd：通道建立后 10 秒内没有 auth/pair
} as const;
```

**一次 App 连接的完整过程（经中继）**

```
1. App   → relay   WS 连接 ws(s)://R/v1/client?hostId=H
2. relay → hostd   控制连接上发 {t:"client", connId:C}（hostd 不在线 → relay 以 4404 关闭 App 连接）
3. hostd → relay   新开 WS ws(s)://R/v1/host/data?hostId=H&connId=C（带 Bearer 密钥）
4. relay           把两条 WebSocket 拼接：此后双向原样转发每一帧（保留文本/二进制类型），任一端关闭则关闭另一端
5. App ↔ hostd     在拼接后的连接上做 D5 加密握手：App 调 openClientSecureChannel（用二维码里的 hostKey），
                   hostd 调 openDaemonSecureChannel（用自己的密钥对）。握手失败即关闭
6. App → hostd     加密通道内第一帧：auth（已配对）或 pair（首次配对）
7. hostd → App     auth_ok / pair_ok，之后就是 6.10 的正常请求与事件
```

直连时跳过 1～4：App 直接连 `ws://<direct>/v1/client`，从第 5 步开始。

---

## 7. 组件规格

### 7.1 bridge（`packages/bridge`）

#### 7.1.1 package.json

```json
{
  "name": "pi-remote-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./src/index.ts"] },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "1.5.0",
    "@earendil-works/pi-ai": "1.5.0",
    "typescript": "^5"
  }
}
```

- 宿主提供的包（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`）只能放 devDependencies，运行时由 pi 映射到自己的副本（`docs/extensions.md` "Available Imports"）。
- 不得有运行时依赖。只用 `node:net`、`node:crypto`、`node:fs`、`node:path`、`node:os`。
- 引用 protocol 用相对路径：`import type { BridgeEvent } from "../../protocol/src/index.ts";`，值导入同理。

安装（M3 时执行）：`pi install /home/moorey/Projects/Pi-extension-dev/extensions/pi-remote/packages/bridge`，它会把本地路径加入 `~/.pi/agent/settings.json` 的 `packages`。

#### 7.1.2 `state.ts`：进程级单例

扩展实例在会话替换、reload 时会被重新创建，旧的 `pi`、`ctx` 会失效并抛错（`docs/extensions.md` "Session replacement lifecycle and footguns"）。因此把跨实例的东西放 `globalThis`：

```ts
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpivPrompt, UiRequest, UiResponse } from "../../protocol/src/index.ts";
import type { HostConn } from "./host-conn.ts";

export interface PendingUi {
  req: UiRequest;
  respond: (r: UiResponse) => void;   // 手机回答时调用
}

export interface Binding {               // 当前会话实例，session_start 时创建，session_shutdown 时置空
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  sessionId: string;
}

export interface BridgeGlobal {
  processId: string;
  seq: number;
  enabled: boolean;
  compat: "ok" | "untested";
  conn?: HostConn;
  binding?: Binding;
  pendingUi: Map<string, PendingUi>;
  rpivOpen: Map<string, RpivPrompt>;
  remoteOps: Map<string, (cmdCtx: unknown) => Promise<unknown>>;   // 隐藏命令待执行的操作
  inflight?: unknown;                  // 最近的 message_update 的 event.message（累计消息）
  runningTools: Map<string, { toolName: string; args: unknown; partialText: string }>;
  extStatus: Map<string, string>;
  extWidgets: Map<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  lastText?: string;
  reloadPending: boolean;
  childSessionFiles: string[];         // 7.6.1，新的在前，最多 50 个
  widgetFactories: Map<string, { factory: Function; placement: "aboveEditor" | "belowEditor"; lastText?: string }>;
  widgetTimer?: ReturnType<typeof setInterval>;
}

const KEY = "__piRemoteBridge";
export function g(): BridgeGlobal {
  const any = globalThis as Record<string, unknown>;
  if (!any[KEY]) {
    any[KEY] = {
      processId: randomUUID(), seq: 0, enabled: false, compat: "ok",
      pendingUi: new Map(), rpivOpen: new Map(), remoteOps: new Map(),
      runningTools: new Map(), extStatus: new Map(), extWidgets: new Map(),
      reloadPending: false, childSessionFiles: [], widgetFactories: new Map(),
    } satisfies BridgeGlobal;
  }
  return any[KEY] as BridgeGlobal;
}
```

#### 7.1.3 `host-conn.ts`：到 hostd 的连接

行为：

- socket 路径：`path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), "pi-remote", "bridge.sock")`。
- `connect()`：`net.createConnection(path)`。成功后先发 `hello`，收到 `welcome` 后才把发送队列里的 `ev` 冲出去。
- 失败或断开：5 秒后重连，无限次。断开期间 `ev` 进入内存队列，队列上限 2000 条，超出丢弃最旧的（hostd 重连后会走快照路径）。
- `send(frame)`：同步放入队列并尝试 `socket.write`，不返回 Promise。
- 收到 `req`：交给 `ops.ts` 的 `handleRequest(req)`，其返回的 Promise 结束后发 `res`。
- `close()`：发 `bye`，`socket.end()`，不再重连。
- 任何异常只写日志。

`emit(ev: BridgeEvent)` 工具函数放在这里：`g().seq += 1`，发送 `{t:"ev", processId, seq, ev}`。**所有事件都必须通过 `emit` 发送**，以保证 seq 连续。

`hello.info` 由 `buildInfo()` 生成（7.1.8）。`spawnToken` 取 `process.env.PI_REMOTE_SPAWN_TOKEN`，只在进程第一次 hello 时带上。

#### 7.1.4 `index.ts`：扩展入口

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { SUPPORTED_PI_VERSIONS, HIDDEN_COMMAND } from "../../protocol/src/index.ts";
import { g } from "./state.ts";

export default function (pi: ExtensionAPI) {
  // 工厂函数里只注册，不启动 socket（docs/extensions.md "Long-lived resources and shutdown"）
  registerRemoteOpCommand(pi);        // remote-op-cmd.ts
  registerEventForwarders(pi);        // events.ts
  registerRpiv(pi);                   // rpiv.ts

  pi.on("session_start", async (event, ctx) => {
    try {
      if (process.env.PI_REMOTE_DISABLE === "1" || ctx.mode !== "tui") return;
      const s = g();
      s.enabled = true;
      s.compat = SUPPORTED_PI_VERSIONS.includes(VERSION) ? "ok" : "untested";
      s.binding = { pi, ctx, sessionId: ctx.sessionManager.getSessionId() };
      if (s.compat === "ok") patchUi(ctx.ui);   // ui-mirror.ts，幂等
      ensureConnected();                          // host-conn.ts
      emit({ type: "session_changed", reason: event.reason, info: buildInfo() });
    } catch (e) { logError("session_start", e); }
  });

  pi.on("session_shutdown", async (event) => {
    try {
      const s = g();
      if (!s.enabled) return;
      s.binding = undefined;
      // 会话被替换时，本地 TUI 上残留的对话框会随旧实例销毁；通知手机关闭
      for (const uiId of s.pendingUi.keys()) emit({ type: "ui_closed", uiId, by: "local" });
      s.pendingUi.clear();
      s.widgetFactories.clear();
      if (s.widgetTimer) { clearInterval(s.widgetTimer); s.widgetTimer = undefined; }
      if (event.reason === "quit") s.conn?.close();
    } catch (e) { logError("session_shutdown", e); }
  });
}
```

`registerEventForwarders(pi)`（`events.ts`）订阅并转换下列事件，**每个处理函数里先判断 `g().enabled && g().binding`**，否则直接返回：

| pi 事件 | 发出的 BridgeEvent | 额外动作 |
|---|---|---|
| `agent_start` | `agent_start` | 刷新状态（见下） |
| `agent_settled` | `agent_settled{aborted, lastText}` | `lastText` = 活动分支最后一条 assistant 消息的文本拼接前 120 字符；存到 `g().lastText`；清空 `inflight`、`runningTools`；发 `context_usage`（来自 `ctx.getContextUsage()`）；刷新状态；若 `g().reloadPending` 则执行 reload（7.1.6） |
| `message_start` | `message_start{message: sanitize(event.message)}` | assistant 时 `g().inflight = event.message` |
| `message_update` | `message_update{delta}` | `delta` = `stripDelta(event.assistantMessageEvent)`：复制对象并删除 `partial`、`message` 字段；类型为 `start`/`done`/`error` 的直接丢弃不发。`g().inflight = event.message` |
| `message_end` | `message_end{message: sanitize(event.message)}` | assistant 时清空 `inflight` |
| `tool_execution_start` | `tool_start` | 记入 `runningTools` |
| `tool_execution_update` | `tool_update{partialText}` | `partialText` = `partialResult.content` 中所有 text 拼接后**取末尾 8000 字符**；更新 `runningTools`。同一 toolCallId 两次发送间隔小于 250ms 的丢弃（节流） |
| `tool_execution_end` | `tool_end` | 从 `runningTools` 删除 |
| `model_select` | `model_changed{model: summarizeModel(event.model)}`，再发 `info` | |
| `thinking_level_select` | `thinking_changed{level}`，再发 `info` | |
| `session_compact` | `compaction{phase:"end"}`，再发 `context_usage` | |
| `session_compact_failed` | `compaction{phase:"failed", error}` | 事件字段名以 `docs/extensions.md` 534 行起的说明为准 |
| `session_info_changed` | `info` | |
| `message_end`（`role === "toolResult"` 且 `toolName` 为 `subagent` 或 `subagent_resume`） | 除上面 `message_end` 的处理外 | 取 `details.sessionFile ?? details.sessionPath`（`subagent` 用前者，`subagent_resume` 用后者，附录 A-21），是非空字符串时把它放到 `g().childSessionFiles` 最前面（去重、截到 50 个），然后 `emit({type:"info", info: buildInfo()})`（7.6.1） |

`session_start` 时还要重建 `childSessionFiles`：遍历 `ctx.sessionManager.getBranch()`，收集 `type === "message"`、`message.role === "toolResult"`、`toolName` 为 `subagent`/`subagent_resume` 且 `details.sessionFile ?? details.sessionPath` 为字符串的条目，按出现顺序倒序去重，取前 50 个。

**状态刷新** `refreshStatus()`：计算 `status = pendingUi.size + rpivOpen.size > 0 ? "waiting_ui" : (ctx.isIdle() ? "idle" : "running")`，与上次不同则 `emit({type:"info", info: buildInfo()})`。在 `agent_start`、`agent_settled`、对话框打开/关闭、问卷打开/关闭后调用。

`summarizeModel(m)`：`{ provider: m.provider, id: m.id, name: m.name ?? m.id, reasoning: !!m.reasoning, input: m.input ?? ["text"], contextWindow: m.contextWindow }`。

#### 7.1.5 `ui-mirror.ts`：对话框镜像（D11、D12、D13）

```ts
const PATCHED = Symbol.for("pi-remote.uiPatched");

export function patchUi(ui: ExtensionUIContext): void {
  const u = ui as ExtensionUIContext & { [PATCHED]?: true };
  if (u[PATCHED]) return;
  const o = {
    select: ui.select, confirm: ui.confirm, input: ui.input, editor: ui.editor, custom: ui.custom,
    notify: ui.notify, setStatus: ui.setStatus, setWidget: ui.setWidget,
  };

  ui.select = (title, options, opts) =>
    mirror({ kind: "select", title, options, timeoutMs: opts?.timeout },
      (signal) => o.select(title, options, { ...opts, signal: anySignal(opts?.signal, signal) }),
      (r) => ("value" in r ? r.value : undefined));

  ui.confirm = (title, message, opts) =>
    mirror({ kind: "confirm", title, message, timeoutMs: opts?.timeout },
      (signal) => o.confirm(title, message, { ...opts, signal: anySignal(opts?.signal, signal) }),
      (r) => ("confirmed" in r ? r.confirmed : false));

  ui.input = (title, placeholder, opts) =>
    mirror({ kind: "input", title, placeholder, timeoutMs: opts?.timeout },
      (signal) => o.input(title, placeholder, { ...opts, signal: anySignal(opts?.signal, signal) }),
      (r) => ("value" in r ? r.value : undefined));

  // D13：editor 没有 signal 参数，手机先答时本地编辑框不会关闭
  ui.editor = (title, prefill) =>
    mirror({ kind: "editor", title, prefill },
      (_signal) => o.editor(title, prefill),
      (r) => ("value" in r ? r.value : undefined));

  ui.custom = (factory, options) => mirrorCustom(o.custom, factory, options);

  ui.notify = (message, type) => { o.notify(message, type); emitSafe({ type: "notify", message, level: type ?? "info" }); };
  ui.setStatus = (key, text) => { o.setStatus(key, text); emitSafe({ type: "ext_status", key, text }); trackStatus(key, text); };
  ui.setWidget = ((key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => {
    (o.setWidget as Function)(key, content, options);
    const placement = options?.placement ?? "aboveEditor";
    if (typeof content === "function") {
      // D17：组件 widget（例如 subagent-status、team-status、team-member）渲染成文本后转发
      g().widgetFactories.set(key, { factory: content, placement });
      publishFactoryWidget(key, ui);
      ensureWidgetTimer(ui);
      return;
    }
    g().widgetFactories.delete(key);
    emitSafe({ type: "ext_widget", key, lines: content as string[] | undefined, placement });
    trackWidget(key, content as string[] | undefined, placement);
  }) as typeof ui.setWidget;

  u[PATCHED] = true;
}
```

注意：

- 先用 `grep -n "setWidget" node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` 核对 `setWidget` 的真实签名，按实际参数顺序改写上面的转发代码。
- `anySignal(a, b)`：`a ? AbortSignal.any([a, b]) : b`。
- `emitSafe` = try/catch 包裹的 `emit`。

**组件 widget 转文本**（`widget-text.ts`，D17）：

```ts
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** 只供组件工厂调用的假 TUI：任何方法都是空操作，尺寸固定 */
function stubTui(): unknown {
  const target = { terminal: { columns: WIDGET_RENDER_COLUMNS, rows: 30 }, requestRender() {} };
  return new Proxy(target, { get: (t, k) => (k in t ? (t as any)[k] : () => undefined) });
}

export function renderFactoryText(factory: Function, theme: unknown): string[] | undefined {
  let comp: any;
  try {
    comp = factory(stubTui(), theme);
    if (!comp || typeof comp.render !== "function" || typeof comp.then === "function") return undefined;
    const lines: string[] = comp.render(WIDGET_RENDER_COLUMNS);
    return lines.map((l) => String(l).replace(ANSI, "").replace(/\s+$/, ""));
  } catch (e) { logError("widget render", e); return undefined; }
  finally { try { comp?.dispose?.(); } catch {} }
}

function publishFactoryWidget(key: string, ui: ExtensionUIContext) {
  const w = g().widgetFactories.get(key); if (!w) return;
  const lines = renderFactoryText(w.factory, ui.theme);
  if (!lines) return;                         // 渲染失败：不发送，App 上不显示这个 widget
  const text = lines.join("\n");
  if (text === w.lastText) return;            // 内容没变不重复发送
  w.lastText = text;
  emitSafe({ type: "ext_widget", key, lines, placement: w.placement });
  trackWidget(key, lines, w.placement);
}

/** 组件 widget 的内容可能随时间变化（例如已运行时长），每 2 秒重新渲染一次；没有组件 widget 时停止 */
function ensureWidgetTimer(ui: ExtensionUIContext) {
  const s = g();
  if (s.widgetTimer) return;
  s.widgetTimer = setInterval(() => {
    if (s.widgetFactories.size === 0 || !s.binding) { clearInterval(s.widgetTimer); s.widgetTimer = undefined; return; }
    for (const key of s.widgetFactories.keys()) publishFactoryWidget(key, s.binding.ctx.ui);
  }, 2000);
  s.widgetTimer.unref?.();
}
```

`session_shutdown` 时清空 `widgetFactories` 并停止定时器（新实例会重新 setWidget）。

`mirror<T>(req, runLocal, fromRemote): Promise<T>`：

```ts
function mirror<T>(
  reqNoId: DistributiveOmit<UiRequest, "uiId">,
  runLocal: (signal: AbortSignal) => Promise<T>,
  fromRemote: (r: UiResponse) => T,
): Promise<T> {
  const s = g();
  const uiId = randomUUID();
  const ac = new AbortController();
  const req = { ...reqNoId, uiId } as UiRequest;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (by: "local" | "remote") => {
      s.pendingUi.delete(uiId);
      emitSafe({ type: "ui_closed", uiId, by });
      refreshStatus();
    };
    s.pendingUi.set(uiId, {
      req,
      respond: (r) => {
        if (done) return;
        done = true;
        ac.abort();                       // 关闭本地对话框；本地 Promise 稍后以 undefined/false 结束，被忽略
        finish("remote");
        resolve(fromRemote(r));
      },
    });
    emitSafe({ type: "ui_request", req });
    refreshStatus();
    runLocal(ac.signal).then(
      (v) => { if (done) return; done = true; finish("local"); resolve(v); },
      (err) => { if (done) return; done = true; finish("local"); reject(err); },
    );
  });
}
```

`DistributiveOmit<T, K>` = `T extends unknown ? Omit<T, K> : never`，放 bridge 内部的 `types.ts`。

`mirrorCustom(origCustom, factory, options)`：

```ts
function mirrorCustom(origCustom, factory, options) {
  const s = g();
  const uiId = randomUUID();
  let doneRef: ((v: unknown) => void) | undefined;
  let cancelRequested = false;
  const wrapped = (tui, theme, kb, done) => {
    doneRef = done;
    if (cancelRequested) queueMicrotask(() => done(undefined));
    return factory(tui, theme, kb, done);
  };
  const coveredBy = latestUncoveredRpiv();   // rpiv.ts：最近 2 秒内打开、尚未被绑定的问卷 toolCallId
  const req: UiRequest = { uiId, kind: "custom", title: options?.blocked?.message, coveredBy };
  s.pendingUi.set(uiId, {
    req,
    respond: (r) => {
      if (!("cancelled" in r)) return;        // custom 只接受取消
      cancelRequested = true;
      doneRef?.(undefined);
    },
  });
  emitSafe({ type: "ui_request", req });
  refreshStatus();
  return origCustom(wrapped, options).finally(() => {
    s.pendingUi.delete(uiId);
    emitSafe({ type: "ui_closed", uiId, by: cancelRequested ? "remote" : "local" });
    refreshStatus();
  });
}
```

#### 7.1.6 `remote-op-cmd.ts`：拿到 ExtensionCommandContext

`newSession`、`fork`、`navigateTree`、`switchSession`、`reload` 只存在于命令处理函数收到的 `ExtensionCommandContext` 上。已核实：`pi.sendUserMessage("/x", { expandPromptTemplates: true })` 会进入 `prompt()`，在流式状态检查之前调用 `_tryExecuteExtensionCommand`，后者用 `createCommandContext()` 生成命令上下文（附录 A-3）。

```ts
export function registerRemoteOpCommand(pi: ExtensionAPI) {
  pi.registerCommand(HIDDEN_COMMAND, {
    description: "internal: used by pi-remote (do not run manually)",
    handler: async (args, ctx) => {
      const id = args.trim();
      const op = g().remoteOps.get(id);
      if (!op) { ctx.ui.notify("pi-remote-op: unknown or expired op", "warning"); return; }
      g().remoteOps.delete(id);
      await op(ctx);
    },
  });
}

/** 在命令上下文里执行 fn，返回其结果 */
export function runWithCommandCtx<T>(fn: (cmdCtx: ExtensionCommandContext) => Promise<T>): Promise<T> {
  const s = g();
  const b = s.binding;
  if (!b) return Promise.reject(remoteError("replacing", "session is being replaced"));
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    s.remoteOps.set(id, async (c) => {
      try { resolve(await fn(c as ExtensionCommandContext)); } catch (e) { reject(e); }
    });
    b.pi.sendUserMessage(`/${HIDDEN_COMMAND} ${id}`, { expandPromptTemplates: true })
      .catch((e) => { s.remoteOps.delete(id); reject(e); });
  });
}
```

会话替换后，命令上下文不能再用（`withSession` 之外的旧 ctx 会抛错），所以 `fn` 里只调用一次替换方法并立即返回纯数据。

**reload_when_idle**：若 `ctx.isIdle()` → `runWithCommandCtx(c => c.reload())`；否则 `g().reloadPending = true`，在 `agent_settled` 处理函数里置回 false 并执行同样的调用。（`ctx.reload()` 不能在 agent 运行中执行，见 `docs/extensions.md` "ctx.reload()"。）

#### 7.1.7 `sanitize.ts`：消息裁剪

`sanitize(message): WireMessage`，深拷贝后：

1. 所有 `{type:"image", data, mimeType}` 替换为 `{type:"image", mimeType, omitted: true}`。
2. `role === "toolResult"`：`content` 中 text 拼接总长超过 32000 字符时，截成前 32000 字符，并加字段 `truncated: true`；`details` 的 `JSON.stringify` 长度超过 65536 时删除 `details`。（保留 details 是为了 edit 工具的 `details.patch`，见附录 A-10。）
3. `role === "bashExecution"`：`output` 超过 32000 字符截断，`truncated: true`。
4. `role === "assistant"`：保留 `content`、`stopReason`、`errorMessage`、`model`、`provider`、`usage`、`timestamp`；删除 `diagnostics`、`deferred`、各类 `*Signature` 字段。
5. 其他角色原样保留。

`entryMessage(entry): WireMessage | undefined`（把会话条目转成消息，用于快照、历史）：

| entry.type | 结果 |
|---|---|
| `message` | `{ ...sanitize(entry.message), entryId: entry.id }` |
| `custom_message`（`display === true`） | `{ role: "custom", customType, content, entryId }`，content 同样经过图片替换 |
| `compaction` | `{ role: "compactionSummary", summary: entry.summary, entryId }` |
| `branch_summary` | `{ role: "branchSummary", summary: entry.summary, entryId }` |
| 其他 | `undefined`（跳过） |

#### 7.1.8 `snapshot.ts` 与 `buildInfo()`

`buildInfo(): ProcessInfo`：

```ts
const b = g().binding!; const ctx = b.ctx;
return {
  processId: g().processId, pid: process.pid, role: detectRole(), childSessionFiles: g().childSessionFiles,
  tmuxPane: process.env.TMUX_PANE,
  spawnedByHostd: !!process.env.PI_REMOTE_SPAWN_TOKEN, piVersion: VERSION, compat: g().compat,
  cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(),
  sessionFile: ctx.sessionManager.getSessionFile(), sessionName: ctx.sessionManager.getSessionName(),
  model: ctx.model ? summarizeModel(ctx.model) : undefined,
  thinkingLevel: b.pi.getThinkingLevel(),
  status: currentStatus(), pendingUiCount: g().pendingUi.size + g().rpivOpen.size,
  lastText: g().lastText, contextUsage: ctx.getContextUsage() ?? undefined, lastSeq: g().seq,
};
```

`getSnapshot({maxMessages})`：

1. `branch = ctx.sessionManager.getBranch()`（根到叶子的条目数组）。
2. 映射 `entryMessage`，过滤 undefined，取最后 `maxMessages` 条；`hasMoreBefore` = 被截掉的数量 > 0。
3. `inflight` = `g().inflight ? sanitize(g().inflight) : undefined`。
4. 其余字段从 `g()` 中的 Map 转成数组或对象。
5. `seq` = `g().seq`。**快照必须同步构建，不要在中间 await**，保证 seq 与内容一致。

`getHistory({beforeEntryId, limit = 100})`：在 `branch` 中找到 `beforeEntryId` 的下标 i，取 `[max(0,i-limit), i)` 区间映射；找不到返回 `not_found`。

`getTree()`：

```ts
const sm = ctx.sessionManager;
const active = new Set(sm.getBranch().map((e) => e.id));
const leafId = sm.getLeafId();
const out: TreeNodeWire[] = [];
const walk = (nodes: SessionTreeNode[]) => {
  for (const n of nodes) {
    out.push({
      id: n.entry.id, parentId: n.entry.parentId, kind: kindOf(n.entry),
      preview: previewOf(n.entry).slice(0, 120), label: n.label, timestamp: n.entry.timestamp,
      onActivePath: active.has(n.entry.id), isLeaf: n.entry.id === leafId, childCount: n.children.length,
    });
    walk(n.children);
  }
};
walk(sm.getTree());
return { nodes: out, leafId };
```

`kindOf`：`message` 按 `message.role` 映射（`user`、`assistant`、`toolResult`、`bashExecution`→`bash`）；`custom_message`→`custom`；`compaction`、`branch_summary` 同名；其余 `other`。`previewOf`：取首个文本块或 summary 或工具名。

`getForkPoints()`：活动分支中 `type==="message" && message.role==="user"` 的条目 → `{ entryId, text: 首个文本块（content 为字符串时直接用）, timestamp }`。

#### 7.1.9 `ops.ts`：请求处理

`handleRequest({id, op, args})` 用一张 `Record<string, (args) => Promise<unknown>>` 分发。所有处理函数开头取 `const b = g().binding`，为空时抛 `replacing`。抛出的错误统一转成 `{code, message}`：自定义 `RemoteErr` 直接用；其他错误为 `internal`。

| op | 实现 |
|---|---|
| `get_snapshot` | 7.1.8 |
| `get_history` | 7.1.8 |
| `prompt` | 见下方 |
| `abort` | `b.ctx.abort()` |
| `ui_respond` | `g().pendingUi.get(uiId)` 不存在 → `not_found`；否则 `.respond(response)` |
| `rpiv_answer` | 7.1.10 |
| `get_commands` | `b.pi.getCommands().map(c => ({ name: c.name, description: c.description, source: c.source }))`，并过滤掉 `HIDDEN_COMMAND` |
| `get_models` | `{ current: ctx.model && summarizeModel(ctx.model), models: ctx.modelRegistry.getAvailable().map(summarizeModel) }` |
| `set_model` | `m = ctx.modelRegistry.find(provider, id)`，无 → `not_found`；`ok = await b.pi.setModel(m)`，false → `no_auth`；返回 `{ model: summarizeModel(m) }` |
| `get_thinking_levels` | `import { getSupportedThinkingLevels } from "@earendil-works/pi-ai"`；无模型时 `["off"]`；`current = b.pi.getThinkingLevel()` |
| `set_thinking` | 校验 level 在支持列表中，否则 `bad_request`；`b.pi.setThinkingLevel(level)` |
| `compact` | 非空闲 → `busy`；返回 Promise，调用 `ctx.compact({ customInstructions, onComplete: () => resolve({}), onError: (e) => reject(RemoteErr("internal", e.message)) })` |
| `get_tree` | 7.1.8 |
| `navigate_tree` | 非空闲 → `busy`；`runWithCommandCtx(c => c.navigateTree(entryId, { summarize, customInstructions }))`，返回 `{ cancelled }` |
| `get_fork_points` | 7.1.8 |
| `fork` | 非空闲 → `busy`；先从 fork points 找到该条目的文本 `prefillText`（`position === "before"` 时）；`runWithCommandCtx(c => c.fork(entryId, { position }))` |
| `new_session` | 非空闲 → `busy`；`runWithCommandCtx(c => c.newSession())` |
| `switch_session` | 非空闲 → `busy`；`runWithCommandCtx(c => c.switchSession(sessionFile))` |
| `set_name` | `b.pi.setSessionName(name)` |
| `reload` / `reload_when_idle` | 7.1.6 |
| `shutdown` | `b.ctx.shutdown()` |

**prompt 的实现**（注意 `sendUserMessage` 会等到这次运行结束才 resolve，附录 A-3、SDK 文档 "prompt() resolves when the run finishes"）：

```ts
async function opPrompt(a: OpArgs<"prompt">) {
  const b = need();
  const isCommand = a.text.startsWith("/");
  const idle = b.ctx.isIdle();
  if (!idle && !a.deliverAs && !isCommand) throw err("busy_need_deliver_as", "agent is running");
  if (a.images?.length) {
    const input = b.ctx.model?.input ?? [];
    if (!input.includes("image")) throw err("model_no_image", "current model does not accept images");
  }
  const content = a.images?.length
    ? [{ type: "text" as const, text: a.text }, ...a.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))]
    : a.text;
  const run = b.pi.sendUserMessage(content, {
    deliverAs: idle || isCommand ? undefined : a.deliverAs,
    expandPromptTemplates: true,
  });
  // 400ms 内失败视为拒绝；否则视为已接受，后续失败以 error 事件报告
  const early = await Promise.race([
    run.then(() => "ok" as const, (e: unknown) => e),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), 400)),
  ]);
  if (early !== "ok" && early !== "pending") throw err("internal", String((early as Error)?.message ?? early));
  if (early === "pending") run.catch((e) => emitSafe({ type: "error", message: String(e?.message ?? e) }));
  return { accepted: true };
}
```

#### 7.1.10 `rpiv.ts`：ask_user_question

事件名与载荷见 `~/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/docs/tool-schema.md` "Event contract"。

```ts
const PROMPT = "rpiv:ask-user:prompt";
const BLOCKED = "rpiv:ask-user:blocked";
const ANSWER = "rpiv:ask-user:answer";
const ANSWER_RESULT = "rpiv:ask-user:answer-result";

export function registerRpiv(pi: ExtensionAPI) {
  pi.events.on(PROMPT, (p: any) => {
    if (!g().enabled) return;
    const prompt: RpivPrompt = {
      toolCallId: p.toolCallId,
      questions: (p.questions ?? []).map((q: any) => ({
        question: q.question, header: q.header, multiSelect: !!q.multiSelect,
        options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description, hasPreview: o.hasPreview })),
      })),
    };
    g().rpivOpen.set(prompt.toolCallId, prompt);
    openedAt.set(prompt.toolCallId, Date.now());
    emitSafe({ type: "rpiv_prompt", prompt });
    refreshStatus();
  });
  pi.events.on(BLOCKED, (p: any) => {
    if (p?.active === false && g().rpivOpen.delete(p.toolCallId)) {
      emitSafe({ type: "rpiv_closed", toolCallId: p.toolCallId });
      refreshStatus();
    }
  });
  pi.events.on(ANSWER_RESULT, (v: any) => { resultWaiters.get(v?.requestId)?.(v); });
}
```

`rpiv_answer` op：生成 `requestId`，`b.pi.events.emit(ANSWER, { ...answer, requestId })`，等待 `ANSWER_RESULT` 里同 requestId 的结果，最多 3 秒（超时返回 `{ ok: false, code: "timeout" }`），返回 `{ ok, code, reason }`。

注意：pi.events 是会话级总线（文档说"The bus is per session"）。`pi.events.on` 在扩展工厂函数里注册，每个新扩展实例都会重新注册，旧实例随会话销毁，不会重复。

`latestUncoveredRpiv()`：返回 `openedAt` 中 2 秒内打开、且尚未被返回过的 toolCallId（返回后记入一个 Set）。

#### 7.1.11 `log.ts`

写入 `${XDG_STATE_HOME ?? ~/.local/state}/pi-remote/bridge-${pid}.log`，追加模式，每行 `ISO时间 级别 消息`。文件超过 5MB 时截断重写。进程退出不清理（hostd 每次启动时删除 7 天前的 bridge-*.log）。

---

### 7.2 hostd（`packages/hostd`）

#### 7.2.1 package.json

```json
{
  "name": "pi-hostd",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "pi-hostd": "src/main.ts" },
  "scripts": { "start": "node src/main.ts serve" },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "1.5.0",
    "@getpaseo/relay": "0.15.3",
    "ws": "^8",
    "qrcode-terminal": "^0.12"
  },
  "devDependencies": { "@types/ws": "^8", "@types/node": "^24", "@types/qrcode-terminal": "^0.12", "typescript": "^5" }
}
```

为什么 hostd 用 npm 上的 SDK 而不是本机安装的 pi：已实测从 `/usr/lib/node_modules/pi/packages/coding-agent/dist/index.js` 动态导入失败（`Cannot find package '@earendil-works/pi-schema'`），本机安装只有 bundle 可用。`dependencies` 里的版本必须与 `pi --version` 一致；hostd 启动时执行 `pi --version` 比较，不一致时只在日志里写 WARN，其余照常工作（bridge 的 `compat` 字段由 bridge 自己判断，hostd 不改）。

`@getpaseo/relay` 版本**精确锁定** `0.15.3`（0.x 版本 API 可能变化）。只从子路径 `@getpaseo/relay/e2ee` 导入：`openDaemonSecureChannel`、`generateKeyPair`、`exportPublicKey`、`exportSecretKey`、`importSecretKey`、`importPublicKey`，以及类型 `Transport`、`SecureChannel`、`KeyPair`。该 npm 包的 package.json 没有 license 字段，其源码仓库 getpaseo/paseo 为 Apache-2.0；在 NOTES.md 记录这一点。

引用 protocol 用相对路径：`../../protocol/src/index.ts`。

#### 7.2.2 `paths.ts`

```ts
export const CONFIG_DIR = join(homedir(), ".config", "pi-remote");        // 0700。"电脑身份"目录，迁移时整体导出（7.5）
export const IDENTITY_FILE = join(CONFIG_DIR, "identity.json");          // 0600
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");              // 0600（含中继密钥）
export const DEVICES_FILE = join(CONFIG_DIR, "devices.json");            // 0600
export const PAIRING_FILE = join(CONFIG_DIR, "pairing.json");            // 0600
export const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-remote");
export const AUDIT_FILE = join(STATE_DIR, "audit.jsonl");
export const HOSTD_LOG = join(STATE_DIR, "hostd.log");
export const RUNTIME_DIR = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "pi-remote");   // 0700
export const BRIDGE_SOCKET = join(RUNTIME_DIR, "bridge.sock");
export const STATUS_FILE = join(RUNTIME_DIR, "status.json");             // relay show 读取
```

#### 7.2.3 `identity.ts` 与 `config.ts`

`identity.json`（`pi-hostd init` 生成，之后不变，除非 `init --force`）：

```json
{ "hostId": "<16 字节随机数的 base64url>", "publicKey": "<base64>", "secretKey": "<base64>", "createdAt": "<ISO>" }
```

密钥对用 `generateKeyPair()` 生成，`exportPublicKey` / `exportSecretKey` 序列化；读取时用 `importPublicKey` / `importSecretKey` 还原为 `KeyPair`。

`config.json` 结构与默认值：

```json
{
  "hostName": "<os.hostname()>",
  "relays": [],
  "direct": { "enabled": false, "listenHost": "0.0.0.0", "listenPort": 7444, "advertise": "" },
  "tmuxSession": "pi-remote",
  "piCommand": "pi",
  "spawnShell": "zsh",
  "snapshotMessages": 200,
  "ringSize": 5000
}
```

- `relays`：`[{ "url": "ws://203.0.113.5:7443", "secret": "<RELAY_SECRET>" }]`。`url` 只能是 `ws://` 或 `wss://` 开头、不带路径的地址。本期只连接第一个。
- `direct.advertise`：写进二维码的直连地址（例如 `ws://192.168.1.10:7444`），为空则二维码不含直连地址。
- 读取时对每个字段做类型校验，缺失用默认值。
- serve 运行中每 5 秒检查 config.json 的 mtime，变化时重新读取：`relays` 变化则断开旧中继连接、按新配置重连；`direct` 变化则重启直连监听。这样 `pi-hostd relay set` 之后不必重启服务。

`endpoint(): HostEndpoint` = `{ hostId, hostKey: identity.publicKey, hostName, relays: config.relays.map(r => r.url), direct: config.direct.enabled && config.direct.advertise ? config.direct.advertise : undefined }`。

#### 7.2.4 `main.ts`：命令行

| 命令 | 行为 |
|---|---|
| `pi-hostd init [--name <电脑名>] [--force]` | 创建目录（权限见 7.2.2），生成 identity.json，写默认 config.json。identity.json 已存在时拒绝，除非 `--force`（会使所有已配对手机失效，执行前要求输入 `yes` 确认） |
| `pi-hostd serve` | 启动服务（7.2.5～7.2.12）。systemd 用这个 |
| `pi-hostd relay set <url> --secret <s>` | 校验 url 格式后写入 `config.relays = [{url, secret}]` |
| `pi-hostd relay show` | 打印当前中继地址与连接状态（读 `STATUS_FILE`，serve 每 5 秒写一次 `{ relay: "connected" \| "connecting" \| "auth_failed" \| "off", direct: "listening" \| "off" }`） |
| `pi-hostd relay remove` | `config.relays = []` |
| `pi-hostd direct enable --advertise <ws://IP:端口> [--port 7444]` / `pi-hostd direct disable` | 修改 `config.direct` |
| `pi-hostd pair` | 要求至少配置了一个中继或开启了直连，否则报错。生成配对码（8 位，字符集 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`，显示为 `XXXX-XXXX`），把 `{ codeHash: sha256(去掉连字符后的大写码), expiresAt: now+10min, failures: 0 }` 写入 pairing.json；用 qrcode-terminal 打印 `PairQr` 的 JSON（`{v:2, kind:"pair", ...endpoint(), code}`），并以文字打印同样内容 |
| `pi-hostd pair --json` | 同上，但只向 stdout 输出一行 `PairQr` JSON（不打印二维码与说明），供 5.3 第 8 条的深链接使用 |
| `pi-hostd qr` | 打印 `EndpointQr`（`{v:2, kind:"endpoint", ...endpoint()}`）。换 VPS 后让手机扫它更新地址，不需要配对码 |
| `pi-hostd devices list` | 打印 id、名称、创建时间、最后连接时间 |
| `pi-hostd devices revoke <id>` | 删除设备；运行中的 serve 每 5 秒重读 devices.json（比较 mtime），被吊销设备的连接立即断开（close code `CLOSE.UNAUTHORIZED`） |
| `pi-hostd export <文件>` | 把 identity.json、config.json、devices.json 打包为一个 JSON：`{ v: 1, identity, config, devices }`，以 0600 权限写出。打印警告："此文件包含电脑私钥与中继密钥，请只通过安全方式传输，导入后删除" |
| `pi-hostd import <文件> [--force]` | 校验结构后写回三个文件（已有 identity.json 时需要 `--force`）；`config.hostName` 改为当前 `os.hostname()`，除非 `--keep-name` |

#### 7.2.5 `secure-socket.ts`：加密通道的服务端包装

hostd 收到的每条 App 连接（来自中继的数据连接或直连）都是一个 `ws` 库的 `WebSocket`。把它包装成 e2ee 库要求的 `Transport`，完成握手，得到统一的 `ClientSocket` 交给 client-hub：

```ts
import { openDaemonSecureChannel, type SecureChannel, type Transport } from "@getpaseo/relay/e2ee";
import type { WebSocket } from "ws";

export interface ClientSocket {
  send(text: string): void;                 // 内部按顺序排队发送（见下）
  close(code: number, reason: string): void;
  onText: ((text: string) => void) | null;
  onClose: (() => void) | null;
  remote: string;                           // 日志用："relay:<connId>" 或 "direct:<ip>"
}

export async function secureServerSocket(ws: WebSocket, keyPair: KeyPair, remote: string): Promise<ClientSocket> {
  const transport: Transport = {
    send: (data) => { ws.send(data); },
    close: (code, reason) => ws.close(code, reason),
    onmessage: null, onclose: null, onerror: null,
  };
  ws.on("message", (data, isBinary) => {
    const payload = isBinary ? toArrayBuffer(data as Buffer) : (data as Buffer).toString("utf8");
    transport.onmessage?.({ data: payload, isBinary });
  });
  ws.on("close", (code, reason) => transport.onclose?.(code, reason.toString()));
  ws.on("error", (e) => transport.onerror?.(e));

  const sock: ClientSocket = { send: () => {}, close: () => {}, onText: null, onClose: null, remote };
  const channel: SecureChannel = await openDaemonSecureChannel(transport, {
    daemonKeyPair: keyPair,
    minimumMode: "protected",
    events: {
      onmessage: (d) => sock.onText?.(typeof d === "string" ? d : new TextDecoder().decode(d)),
      onclose: () => sock.onClose?.(),
      onerror: (e) => log.warn("channel error", remote, e.message),
    },
  });
  let chain = Promise.resolve();
  sock.send = (text) => { chain = chain.then(() => channel.send(text)).catch((e) => log.warn("send", remote, e)); };
  sock.close = (code, reason) => channel.close(code, reason);
  return sock;
}
```

要点：

- `toArrayBuffer(buf)` = `buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)`。
- `openDaemonSecureChannel` 抛 `SecureChannelRejectedError` 时用它的 `closeCode`、`closeReason` 关闭 ws；抛其他错误时 `ws.close(1011)`。握手 10 秒未完成也关闭。
- **发送必须串行**（上面的 `chain`）：`channel.send` 是异步的，client-hub 依赖"先写入的帧先到达"（7.2.9 subscribe 的 res 必须先于补发事件）。
- 函数的正确性以 `@getpaseo/relay/dist/secure-channel.d.ts` 与 `encrypted-channel.d.ts` 的注释为准；若与上面写法冲突，以库为准并记入 NOTES.md。

#### 7.2.6 `relay-client.ts` 与 `direct-server.ts`

**relay-client**（对每个 `config.relays[0]`）：

1. 打开控制连接：`new WebSocket(url + RELAY_PATH_HOST_CONTROL + "?hostId=" + encodeURIComponent(hostId), { headers: { authorization: "Bearer " + secret } })`。
2. 断开后重连：1 秒起，每次翻倍，最多 30 秒；连上后重置。关闭码为 `CLOSE.BAD_RELAY_SECRET` 时状态记为 `auth_failed`，仍按 60 秒间隔重试。
3. 收到 `{t:"ping"}` 回 `{t:"pong", ts}`。若 60 秒没有收到任何帧，主动 `terminate()` 并重连。
4. 收到 `{t:"client", connId}`：打开数据连接 `url + RELAY_PATH_HOST_DATA + "?hostId=...&connId=..."`（同样带 Bearer 头），`open` 后调用 `secureServerSocket(ws, keyPair, "relay:" + connId)`，成功则 `clientHub.accept(sock)`。
5. 状态写入 status.json（7.2.4 `relay show`）。

**direct-server**（`config.direct.enabled` 时）：

- `http.createServer` 监听 `listenHost:listenPort`；`GET /healthz` 返回 `{"ok":true}`，其他 HTTP 请求 404。
- `WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })`，`upgrade` 只接受路径 `DIRECT_PATH_CLIENT`，否则 `socket.destroy()`。
- 连接后 `secureServerSocket(ws, keyPair, "direct:" + remoteAddress)` → `clientHub.accept(sock)`。
- 同一来源 IP 同时最多 10 个连接。

两者共用：未完成鉴权的连接总数上限 20 个（超出直接关闭）。

#### 7.2.7 `devices.ts`

- `devices.json`：`{ devices: [{ id, name, secretHash, createdAt, lastSeenAt? }] }`。`id` = `randomUUID()`；`secret` = `randomBytes(32).toString("base64url")`；`secretHash` = sha256 十六进制。
- `verify(deviceId, secret)`：找到设备，`timingSafeEqual(Buffer.from(sha256(secret),"hex"), Buffer.from(secretHash,"hex"))`。
- `consumePairing(code, deviceName)`：
  - 读 pairing.json；不存在或过期 → 失败。
  - 规范化输入（去连字符、转大写）后比较哈希；不匹配 → `failures += 1` 写回；`failures >= 10` 时删除 pairing.json。
  - 匹配 → 删除 pairing.json，创建设备，返回 `{ deviceId, secret }`。
- 配对全局串行处理（同一时刻只处理一个），每次失败后延迟 1 秒再回复。

#### 7.2.8 `bridge-server.ts` 与 `registry.ts`

启动时：`mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })`；若 `BRIDGE_SOCKET` 已存在则先 `unlinkSync`；`net.createServer().listen(BRIDGE_SOCKET)`；监听后 `chmodSync(BRIDGE_SOCKET, 0o600)`。

每个连接：

1. 收到 `hello`：协议版本不同 → 写日志并关闭连接。否则发 `welcome`，`registry.upsert(processId, conn, info)`，向所有已鉴权客户端广播 `{t:"proc", kind:"up", info}`；若带 `spawnToken`，唤醒等待该 token 的 spawn 请求（7.2.10）。
2. 收到 `ev`：`entry.ring.push(seq, ev)`。若 `ev.type` 为 `info` 或 `session_changed`，更新 `entry.info` 并广播 `{t:"proc", kind:"changed", info}`；同时把 `entry.info.lastSeq = seq`。然后交给 client-hub 分发给订阅者（7.2.9）。
3. 收到 `res`：按 id 结束对应的待处理请求。
4. 连接关闭或收到 `bye`：拒绝该连接上所有待处理请求（`bridge_gone`），`registry.remove(processId)`，广播 `{t:"proc", kind:"down", info}`。
5. 第 1、2、4 步之后都调用 `links.recompute()`（7.6.2），它会补上或清除各进程的 `parentProcessId`，有变化的进程再广播一次 `{t:"proc", kind:"changed", info}`。注意：bridge 上报的 info 不含 `parentProcessId`，`upsert` 和更新 `entry.info` 时要保留 hostd 已算出的值，再由 `recompute` 修正。

`registry` 接口：

```ts
interface ProcEntry { conn: BridgeConn; info: ProcessInfo; ring: EventRing; }
upsert(processId, conn, info): void
get(processId): ProcEntry | undefined
remove(processId): void
list(): ProcessInfo[]
findBySessionFile(file: string): ProcEntry | undefined   // 比较 fs.realpathSync 后的路径；文件不存在时比较原字符串
request(processId, op, args, timeoutMs): Promise<unknown>  // 生成 id，发 req，等 res
```

`event-ring.ts`：固定容量数组，构造时传入初始 `lastSeq`（取 hello 中的 `info.lastSeq`，hostd 重启后 ring 为空但 lastSeq 已知）。`push(seq, ev)` 同时更新 `lastSeq`；`since(seq)`：若 `seq >= lastSeq` 返回空数组；若 ring 非空且最早缓存的 seq ≤ `seq + 1` 返回 seq 之后的全部事件；否则返回 `null`（有缺口，走快照）。同一 processId 重新 hello 时（bridge 重连），保留已有 ring，只更新 conn 与 info。

#### 7.2.9 `client-hub.ts` 与 `ops.ts`

`clientHub.accept(sock: ClientSocket)` 为每条已加密的连接创建：`{ sock, deviceId?, authed: false, lastFrameAt, subs: Map<processId, { pending: boolean; buf: Frame[] }> }`。所有发送都走 `sock.send(JSON.stringify(frame))`。

- 10 秒内没有收到 `auth` 或 `pair` → `sock.close(CLOSE.AUTH_TIMEOUT, "auth timeout")`。未鉴权前收到其他帧 → 关闭。
- 收到 `pair`：`protocol !== PROTOCOL_VERSION` → `pair_err incompatible` 后关闭；`consumePairing(code, deviceName)` 失败 → `pair_err invalid_code` 后关闭；成功 → `pair_ok {deviceId, secret, hostName, hostVersion}`，并把该连接视为已鉴权（等同于随后收到了合法 auth）。
- 收到 `auth`：`protocol !== PROTOCOL_VERSION` → `auth_err incompatible` 后关闭；验证失败 → `auth_err unauthorized`，`close(CLOSE.UNAUTHORIZED)`；成功 → `auth_ok {hostVersion, hostName}`，更新 `lastSeenAt`，然后对每个在线进程发一次 `{t:"proc", kind:"up", info}`。
- 收到 `ping` → 回 `pong`。任何帧都更新 `lastFrameAt`；每 20 秒检查一次，60 秒没有收到任何帧的连接直接关闭（App 每 20 秒发一次 ping，7.3.7）。
- 收到 `req`：
  1. 校验 `op` 是 `OpMap` 的键，否则 `bad_request`。
  2. 用 `ops.ts` 中该 op 的校验函数检查 args（手写：`str(args,"processId")`、`optStr`、`bool`、`oneOf` 等小工具，失败抛 `bad_request`）。
  3. 本地 op 由 hostd 处理；其余 op：`registry.get(args.processId)` 不存在 → `not_found`；否则 `registry.request(processId, op, args, OP_TIMEOUT_MS[op] ?? DEFAULT)`。
  4. 有副作用的 op（`prompt`、`abort`、`ui_respond`、`rpiv_answer`、`set_model`、`set_thinking`、`compact`、`navigate_tree`、`fork`、`new_session`、`switch_session`、`set_name`、`reload`、`shutdown`、`open_session`、`new_process`、`set_setting`）以及配对成功、鉴权失败写审计日志：`{ts, deviceId, op, processId?, summary}`，`prompt` 的 summary 为文本前 200 字符。
- 事件分发：对订阅了该 processId 的客户端，`pending` 时放进 `buf`，否则直接发 `{t:"evt", processId, seq, ev}`。

**subscribe 实现**（对照 6.10）：

```ts
async function subscribe(client, { processId, sinceSeq }) {
  const e = registry.get(processId); if (!e) throw err("not_found");
  if (sinceSeq !== undefined) {
    const missed = e.ring.since(sinceSeq);
    if (missed) {
      client.subs.set(processId, { pending: false, buf: [] });
      // 先回 res，再补发（客户端在收到 res 后才处理 evt）
      queueMicrotask(() => { for (const m of missed) send(client, { t: "evt", processId, seq: m.seq, ev: m.ev }); });
      return { mode: "replay" };
    }
  }
  const sub = { pending: true, buf: [] as Frame[] };
  client.subs.set(processId, sub);
  try {
    const snapshot = await registry.request(processId, "get_snapshot", { maxMessages: config.snapshotMessages }, 15000) as Snapshot;
    queueMicrotask(() => {
      for (const f of sub.buf) if (f.seq > snapshot.seq) send(client, f);
      sub.buf = []; sub.pending = false;
    });
    return { mode: "snapshot", snapshot };
  } catch (e) { client.subs.delete(processId); throw e; }
}
```

发送 `res` 必须在 `queueMicrotask` 回调执行**之前**进入发送队列：处理函数 return 后立即同步调用 `sock.send(res)`，补发在 microtask 中进行；`ClientSocket.send` 内部串行（7.2.5），顺序即可保证。

#### 7.2.10 `spawner.ts`

```ts
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function ensureTmuxSession(name: string) {
  const r = await execFileP("tmux", ["has-session", "-t", `=${name}`]).then(() => true, () => false);
  if (!r) await execFileP("tmux", ["new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-n", "hostd"]);
}

export async function spawnPi(opts: { cwd: string; sessionFile?: string; trust: Trust }): Promise<string /*processId*/> {
  const cwd = validateCwd(opts.cwd);   // 绝对路径、存在、是目录、realpath 位于 homedir() 之下，否则 bad_request
  await ensureTmuxSession(config.tmuxSession);
  const token = randomUUID();
  const args = [config.piCommand, opts.trust === "approve" ? "--approve" : "--no-approve"];
  if (opts.sessionFile) args.push("--session", opts.sessionFile);
  const inner = "exec " + args.map(shQuote).join(" ");
  const shellCmd = `${config.spawnShell} -lic ${shQuote(inner)}`;   // 用登录+交互 shell，加载 zshrc 里的 PATH、API key、代理
  const windowName = basename(cwd).slice(0, 30) || "pi";
  const { stdout } = await execFileP("tmux", [
    "new-window", "-d", "-P", "-F", "#{pane_id}",
    "-t", `=${config.tmuxSession}:`, "-n", windowName, "-c", cwd,
    "-e", `PI_REMOTE_SPAWN_TOKEN=${token}`, shellCmd,
  ]);
  const paneId = stdout.trim();
  try {
    return await waitForSpawnToken(token, 45_000);   // bridge 的 hello 带回 token 时 resolve(processId)
  } catch {
    const tail = await execFileP("tmux", ["capture-pane", "-p", "-t", paneId, "-S", "-20"]).then((r) => r.stdout, () => "");
    throw err("spawn_timeout", `pi did not register within 45s. tmux pane ${paneId} last lines:\n${tail}`);
  }
}
```

`execFileP` = `promisify(execFile)`，参数以数组传递，不经过 shell。

`open_session {sessionFile, trust}`：
1. `registry.findBySessionFile(sessionFile)` 命中 → `{ processId, spawned: false }`。
2. 校验文件存在且以 `.jsonl` 结尾，且位于 `getAgentDir()/sessions` 之下（`getAgentDir` 从 SDK 导入）。
3. 读取会话头拿到 cwd（`SessionManager.listAll()` 缓存中找该文件的 `cwd`；cwd 为空或已不存在 → `bad_request`）。
4. `spawnPi({ cwd, sessionFile, trust })` → `{ processId, spawned: true }`。

信任选择的"记住"功能只在 App 端实现（7.3.10），hostd 不保存。

`new_process {cwd, trust}`：`spawnPi({ cwd, trust })`。

`switch_session` 在转发给 bridge 之前，hostd 先检查：`registry.findBySessionFile(sessionFile)` 命中且不是同一个 processId → `conflict_live_elsewhere`（错误 message 里带目标 processId，App 据此跳转）。

#### 7.2.11 `sessions-index.ts`

```ts
import { SessionManager } from "@earendil-works/pi-coding-agent";
let cache: { at: number; items: SessionInfo[] } | undefined;
async function all(refresh: boolean) {
  if (!refresh && cache && Date.now() - cache.at < 10_000) return cache.items;
  const items = await SessionManager.listAll();
  cache = { at: Date.now(), items };
  return items;
}
```

`list_sessions {cwd?}`：映射为 `SessionListItem`（`firstMessage` 截 200 字符，日期转 ISO），按 `modified` 降序；填 `liveProcessId`（用 `findBySessionFile`）；给了 cwd 就只返回该 cwd 的。**不要返回 `allMessagesText`**。

`list_projects`：按 cwd 分组，`lastModified` 取组内最大值，`sessionCount` 计数；加上在线进程的 cwd；按 `lastModified` 降序。

#### 7.2.12 `settings-service.ts`

```ts
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTERS: Record<string, (sm: SettingsManager, v: any) => void> = {
  "defaultThinkingLevel": (sm, v) => sm.setDefaultThinkingLevel(v),
  "hideThinkingBlock": (sm, v) => sm.setHideThinkingBlock(v),
  "steeringMode": (sm, v) => sm.setSteeringMode(v),
  "followUpMode": (sm, v) => sm.setFollowUpMode(v),
  "compaction.enabled": (sm, v) => sm.setCompactionEnabled(v),
  "retry.enabled": (sm, v) => sm.setRetryEnabled(v),
  "transport": (sm, v) => sm.setTransport(v),
  "cacheWarming": (sm, v) => sm.setCacheWarmingMode(v),
  "images.blockImages": (sm, v) => sm.setBlockImages(v),
  "images.autoResize": (sm, v) => sm.setImageAutoResize(v),
  "enableSkillCommands": (sm, v) => sm.setEnableSkillCommands(v),
  "showCacheMissNotices": (sm, v) => sm.setShowCacheMissNotices(v),
  "defaultProjectTrust": (sm, v) => sm.setDefaultProjectTrust(v),
  "treeFilterMode": (sm, v) => sm.setTreeFilterMode(v),
};
```

- `get_settings`：`sm = SettingsManager.create(homedir(), getAgentDir())`；`s = sm.getSettings()`；对 `REMOTE_SETTINGS` 每个 key 按点号路径从 `s` 取值。缺失时留空，App 显示"默认"。
- `set_setting {key, value}`：key 必须在 `REMOTE_SETTINGS` 中；boolean 类型校验 `typeof value === "boolean"`；enum 校验 `options.includes(value)`；调用 setter，`await sm.flush()`，`sm.drainErrors()` 非空 → `internal`。成功后若 `applies === "reload"`，对每个在线进程发 `reload_when_idle`（不等待结果，失败只写日志）。返回最新 `get_settings`。
- setter 方法名均已在 `settings-manager.d.ts` 核实（附录 A-9）。

#### 7.2.13 `audit.ts`、`log.ts`

- 审计：每条一行 JSON 追加到 AUDIT_FILE，文件 > 20MB 时重命名为 `.1` 再新建。
- 日志：写 HOSTD_LOG 并同时写 stderr（systemd journal 会收）。

#### 7.2.14 systemd 单元

`systemd/pi-hostd.service`：

```ini
[Unit]
Description=pi-remote host daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/Projects/Pi-extension-dev/extensions/pi-remote/packages/hostd
ExecStart=/usr/bin/node src/main.ts serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

安装：

```zsh
mkdir -p ~/.config/systemd/user
ln -sf ~/Projects/Pi-extension-dev/extensions/pi-remote/packages/hostd/systemd/pi-hostd.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-hostd.service
```

可选：`loginctl enable-linger moorey`，让服务在未登录图形会话时也运行。

#### 7.2.15 `scripts/dev-client.ts`：命令行调试客户端

无 App 时用于验收。用 `ws` 库连接，用 `@getpaseo/relay/e2ee` 的 `openClientSecureChannel` 建立加密通道（Transport 包装方式与 7.2.5 对称，`daemonPublicKeyB64` 取二维码里的 `hostKey`，`minimumMode: "protected"`）。凭据存 `~/.config/pi-remote/dev-client.json`（0600），内容 `{ endpoint: HostEndpoint, deviceId, secret }`。

```
node scripts/dev-client.ts [--via relay|direct] <命令>        默认 relay；连接地址取自 dev-client.json
  pair '<PairQr JSON>'              用 `pi-hostd pair` 打印的 JSON 配对并保存凭据
  procs                             list_processes
  listen                            保持连接，持续打印收到的 proc 帧，Ctrl-C 退出
  sessions [cwd]                    list_sessions
  watch <processId>                 subscribe 后持续打印 evt（每行一个 JSON），Ctrl-C 退出
  prompt <processId> <text...>      发送消息（运行中自动用 steer）
  ui <processId> <uiId> <json>      ui_respond，例如 '{"value":"Allow"}'
  op <opName> '<json args>'         任意 op，打印结果

全局开关 --dump-wire：把外层 WebSocket 每一帧（加密前/解密前的原始数据）以 "<< " / ">> " 前缀打印到 stderr，用于确认线上没有明文。
```

#### 7.2.16 `session-reader.ts`：只读查看会话（`read_session`）

用于查看已经结束的子 agent 会话等不在运行中的会话，**不启动 pi、不写文件**。不要用 `SessionManager.open()`：它在加载旧版本文件时会迁移并重写文件（附录 A-24）。

1. 校验 `sessionFile`：绝对路径、以 `.jsonl` 结尾、`realpath` 位于 `getAgentDir()/sessions` 之下、文件存在；否则 `bad_request` / `not_found`。
2. 若该文件正被某个在线进程打开（`registry.findBySessionFile`），仍然按下面的方式只读解析（不转发给 bridge），App 会另外提供"跳到运行中的进程"按钮。
3. `entries = parseSessionEntries(readFileSync(f, "utf8"))`，再 `migrateSessionEntries(entries)`（两者都从 `@earendil-works/pi-coding-agent` 导入，只在内存中处理）。
4. 第一条 `type === "session"` 的条目是会话头，取 `cwd`；`session_info` 条目中最后一个的 `name` 作为会话名。
5. 活动叶子 = 文件中最后一个非头部条目的 `id`（与 pi 自己加载会话时的规则相同，附录 A-24）；建 `id → entry` 索引，从叶子沿 `parentId` 回溯到根，反转得到活动分支。
6. 用与 bridge 相同的 `entryMessage` 规则（7.1.7）把分支条目转成 `WireMessage`。**把 bridge 的 `sanitize.ts` 复制一份到 hostd**（与 ndjson.ts 一样不跨包引用）。
7. 分页：没有 `beforeEntryId` 时取最后 `limit`（默认 200）条；有则取该条目之前的 `limit` 条。
8. 若第 3 步解析失败，返回 `internal` 并在 message 中带上解析错误。

---

### 7.3 Android App（`apps/mobile`）

#### 7.3.1 创建与依赖

```zsh
cd ~/Projects/Pi-extension-dev/extensions/pi-remote/apps
npx create-expo-app@latest mobile --template default
cd mobile
npm run reset-project          # 模板自带脚本，清掉示例页面；若不存在则手动删除示例
npx expo install expo-router expo-secure-store expo-camera expo-image-picker expo-clipboard expo-constants expo-build-properties
npm install zustand react-native-markdown-display react-native-notify-kit react-native-get-random-values
npm install --save-exact @getpaseo/relay@0.15.3
```

- `@getpaseo/relay` 是纯 JS（依赖 tweetnacl、@noble/*、base64-js），App 只从 `@getpaseo/relay/e2ee` 导入 `openClientSecureChannel` 和类型。它需要全局 `crypto.getRandomValues`（由 `react-native-get-random-values` 提供，必须在入口第一行导入，见 7.3.5）和 `TextEncoder`/`TextDecoder`。若运行时报 `TextDecoder is not defined`，安装 `text-encoding` 并在入口第二行做 polyfill，记入 NOTES.md。
- 若 Metro 解析 `@getpaseo/relay/e2ee` 子路径失败，在 metro.config.js 中设置 `config.resolver.unstable_enablePackageExports = true`。

- 记录所选 Expo SDK、React Native 版本到 NOTES.md，之后不升级。
- 新架构保持默认开启（notify-kit 只支持新架构）。
- 不使用 Expo Go。开发用 `npx expo run:android`（会自动 prebuild）。**不要手改 `android/` 目录**：所有原生配置写在 `app.json` 和 `plugins/` 中；`android/` 加入 `.gitignore`，需要时 `npx expo prebuild -p android --clean` 重新生成。
- `react-native-markdown-display` 若与所选 RN 版本不兼容，改用 `react-native-marked` 并记入 NOTES.md；两者都不行时退化为纯 `<Text>` 显示。

#### 7.3.2 `app.json` 关键字段

```json
{
  "expo": {
    "name": "pi-remote",
    "slug": "pi-remote",
    "scheme": "piremote",
    "android": {
      "package": "dev.moorey.piremote",
      "permissions": ["CAMERA", "POST_NOTIFICATIONS", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_REMOTE_MESSAGING"]
    },
    "plugins": [
      "expo-router",
      "expo-secure-store",
      ["expo-camera", { "cameraPermission": "Scan the pairing QR code" }],
      ["expo-image-picker", { "photosPermission": "Pick images to send to pi" }],
      ["react-native-notify-kit", { "android": { "foregroundService": { "types": ["remoteMessaging"] } } }],
      ["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
    ]
  }
}
```

`react-native-notify-kit` 的插件参数结构以其 README "Expo" 一节为准；目标是：manifest 里有该库的前台服务声明且 `android:foregroundServiceType="remoteMessaging"`，并有 `FOREGROUND_SERVICE_REMOTE_MESSAGING` 权限。prebuild 后检查 `android/app/src/main/AndroidManifest.xml` 确认。

#### 7.3.3 明文 WebSocket 说明

`usesCleartextTraffic: true` 允许 App 用 `ws://` 连接没有域名/证书的中继或直连地址。这是有意为之：应用数据全部在 D5 的加密通道内，外层是否 TLS 不影响内容安全（只影响 hostId、流量大小等元数据是否可见）。有域名时用户可在设置里填 `wss://` 地址。prebuild 后检查 `AndroidManifest.xml` 的 `<application>` 上有 `android:usesCleartextTraffic="true"`。

#### 7.3.4 `metro.config.js`

```js
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
module.exports = config;
```

App 通过 workspace 包名引用 protocol：在 `apps/mobile/package.json` 的 dependencies 加 `"@pi-remote/protocol": "*"`。`packages/protocol/package.json`：

```json
{ "name": "@pi-remote/protocol", "version": "0.1.0", "private": true, "type": "module", "main": "src/index.ts", "types": "src/index.ts" }
```

App 的 `tsconfig.json` 加 `"allowImportingTsExtensions": true`（Expo 用 Babel 编译，`noEmit` 已默认）。

#### 7.3.5 `index.js`（入口）

```js
import "react-native-get-random-values";               // 必须是第一行：为加密库提供 crypto.getRandomValues
import notifee from "react-native-notify-kit";
import { foregroundRunner } from "./src/bg/foreground";
notifee.registerForegroundService(foregroundRunner);   // 必须在应用注册前调用
import "expo-router/entry";
```

`apps/mobile/package.json` 中 `"main": "index.js"`。

#### 7.3.6 目录与模块

```
src/
├─ app/
│  ├─ _layout.tsx            Stack 导航；启动时 connection.start()
│  ├─ index.tsx              首页：在线进程 + 项目/会话列表
│  ├─ pair.tsx               配对（扫码/手输）
│  ├─ new.tsx                新会话：选项目或输入路径 + 信任选择
│  ├─ settings.tsx           pi 全局设置（REMOTE_SETTINGS）+ 连接设置 + App 设置
│  ├─ history.tsx            只读会话查看（read_session），参数 sessionFile
│  └─ session/[processId].tsx  会话页
├─ net/
│  ├─ secure-ws.ts           WebSocket + 加密通道（客户端）
│  ├─ endpoints.ts           由 HostEndpoint 生成候选连接地址
│  ├─ pairing.ts             扫码配对
│  ├─ connection.ts          连接单例：鉴权、重连、请求、事件批处理
│  └─ api.ts                 call<K extends OpName>(op, args): Promise<OpResult<K>>
├─ state/
│  ├─ store.ts               zustand store
│  ├─ view-reducer.ts        applyEvent(view, ev) 纯函数
│  └─ types.ts               ProcessView
├─ bg/
│  ├─ foreground.ts          前台服务 runner、启停
│  └─ notifications.ts       本地通知规则
├─ ui/
│  ├─ Transcript.tsx
│  ├─ MessageItem.tsx        按 role 分发
│  ├─ AssistantMessage.tsx
│  ├─ ToolCallCard.tsx       工具调用 + 结果
│  ├─ PatchView.tsx          统一 diff 着色
│  ├─ Markdown.tsx
│  ├─ Composer.tsx
│  ├─ SlashMenu.tsx
│  ├─ UiRequestCard.tsx      select/confirm/input/editor/custom
│  ├─ RpivSheet.tsx          问卷
│  ├─ ModelSheet.tsx
│  ├─ ThinkingSheet.tsx
│  ├─ TreeSheet.tsx
│  ├─ ForkSheet.tsx
│  ├─ ResumeSheet.tsx
│  ├─ CompactSheet.tsx
│  ├─ SessionInfoSheet.tsx
│  ├─ TrustDialog.tsx
│  ├─ ChildStrip.tsx         会话页顶部的子 agent / team 成员条（7.6.4）
│  ├─ CustomMessageCard.tsx  按 customType 渲染扩展消息（7.6.5）
│  └─ Sheet.tsx              基于 RN 内置 Modal 的底部弹层（不引入 bottom-sheet 库）
└─ lib/
   ├─ slash.ts               内置命令路由
   ├─ test-hooks.ts          测试构建专用：深链接 piremote://test/*、TextInput setter 注册表、PIREMOTE_TEST 日志（5.3 第 7 条）
   ├─ credentials.ts         expo-secure-store 读写
   └─ format.ts
```

#### 7.3.7 `net/` 连接层

**`lib/credentials.ts`**：expo-secure-store 中键 `pi-remote.hosts` 保存 JSON：

```ts
export interface SavedHost {
  endpoint: HostEndpoint;        // hostId、hostKey、hostName、relays、direct（来自二维码，relays/direct 可在设置里改）
  deviceId: string;
  secret: string;
  pairedAt: string;
}
// 读写整个数组：loadHosts(): Promise<SavedHost[]>；saveHosts(hosts)。本期界面只使用 hosts[0]
```

**`net/secure-ws.ts`**：把 RN 的 `WebSocket` 包装成加密通道（与 hostd 7.2.5 对称）：

```ts
import { openClientSecureChannel, type SecureChannel, type Transport } from "@getpaseo/relay/e2ee";

export interface SecureConn {
  send(text: string): void;               // 内部串行
  close(): void;
  onText: ((t: string) => void) | null;
  onClose: (() => void) | null;
}

/** url 例：中继 "ws://1.2.3.4:7443/v1/client?hostId=..."，直连 "ws://192.168.1.10:7444/v1/client" */
export function openSecure(url: string, hostKey: string, timeoutMs: number): Promise<SecureConn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const transport: Transport = {
      send: (d) => ws.send(d), close: (c, r) => ws.close(c, r),
      onmessage: null, onclose: null, onerror: null,
    };
    const conn: SecureConn = { send: () => {}, close: () => ws.close(), onText: null, onClose: null };
    let settled = false;
    const fail = (e: unknown) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} reject(e); };
    const timer = setTimeout(() => fail(new Error("connect timeout")), timeoutMs);
    ws.onmessage = (m) => transport.onmessage?.({ data: m.data as string | ArrayBuffer, isBinary: typeof m.data !== "string" });
    ws.onclose = (e) => { transport.onclose?.(e.code, e.reason); if (!settled) fail(new Error(`closed ${e.code}`)); else conn.onClose?.(); };
    ws.onerror = () => transport.onerror?.(new Error("ws error"));
    ws.onopen = async () => {
      try {
        let chain = Promise.resolve();
        const ch: SecureChannel = await openClientSecureChannel(transport, {
          daemonPublicKeyB64: hostKey,
          minimumMode: "protected",
          events: {
            onopen: () => { if (settled) return; settled = true; clearTimeout(timer); resolve(conn); },
            onmessage: (d) => conn.onText?.(typeof d === "string" ? d : new TextDecoder().decode(d)),
          },
        });
        conn.send = (t) => { chain = chain.then(() => ch.send(t)).catch(() => {}); };
        conn.close = () => ch.close(1000, "bye");
      } catch (e) { fail(e); }
    };
  });
}
```

**`net/endpoints.ts`**：`candidateUrls(h: HostEndpoint): string[]` = 直连（若有）`h.direct + DIRECT_PATH_CLIENT`，然后每个中继 `relay + RELAY_PATH_CLIENT + "?hostId=" + encodeURIComponent(h.hostId)`。地址末尾的 `/` 先去掉。

**`net/connection.ts`**：

状态：`"no_credentials" | "connecting" | "ready" | "backoff"`，另存 `via: "direct" | "relay" | undefined` 与 `lastError?: string`，都放 store（首页状态条显示）。

```ts
class Connection {
  private conn?: SecureConn;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: RemoteError) => void; timer: ReturnType<typeof setTimeout> }>();
  private backoffMs = 1000;
  private evtQueue: { processId: string; seq: number; ev: BridgeEvent }[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastFrameAt = 0;
  private generation = 0;              // 每次 open() 加一，旧连接的回调据此忽略

  async start() { /* loadHosts()；为空 → no_credentials；否则 open() */ }

  private async open() {
    const gen = ++this.generation;
    const host = (await loadHosts())[0];
    if (!host) { store.setConn("no_credentials"); return; }
    store.setConn("connecting");
    let lastErr = "";
    for (const url of candidateUrls(host.endpoint)) {
      try {
        const isDirect = url.startsWith((host.endpoint.direct ?? "\0"));
        const c = await openSecure(url, host.endpoint.hostKey, isDirect ? 3000 : 10000);
        if (gen !== this.generation) { c.close(); return; }
        this.conn = c;
        store.setVia(isDirect ? "direct" : "relay");
        c.onText = (t) => { this.lastFrameAt = Date.now(); this.onFrame(JSON.parse(t) as HostToClient); };
        c.onClose = () => { if (gen === this.generation) this.scheduleReconnect(); };
        c.send(JSON.stringify({ t: "auth", protocol: PROTOCOL_VERSION, deviceId: host.deviceId, secret: host.secret }));
        return;
      } catch (e) { lastErr = String((e as Error)?.message ?? e); }
    }
    store.setLastError(lastErr);
    this.scheduleReconnect();
  }

  private onFrame(f: HostToClient) {
    switch (f.t) {
      case "auth_ok": this.backoffMs = 1000; store.setConn("ready"); store.setHostInfo(f.hostName, f.hostVersion); this.startHeartbeat(); this.resubscribeAll(); break;
      case "auth_err": store.setConn(f.code === "unauthorized" ? "no_credentials" : "backoff"); store.setLastError(f.code); this.conn?.close(); break;
      case "res": { const p = this.pending.get(f.id); if (!p) break; clearTimeout(p.timer); this.pending.delete(f.id); f.ok ? p.resolve(f.data) : p.reject(f.error); break; }
      case "evt": this.evtQueue.push(f); this.flushTimer ??= setTimeout(() => this.flush(), 50); break;
      case "proc": store.onProc(f.kind, f.info); notifications.onProc(f.kind, f.info); break;
      case "pong": break;
    }
  }

  private flush() { this.flushTimer = undefined; const q = this.evtQueue; this.evtQueue = []; store.applyEvents(q); }

  request(op: string, args: object, timeoutMs = 20000): Promise<unknown> { /* 未 ready 立即 reject {code:"timeout"}；生成 id；this.conn.send；超时 reject */ }

  private resubscribeAll() {
    for (const pid of store.subscribedProcessIds()) {
      const sinceSeq = store.view(pid)?.seq;
      this.request("subscribe", { processId: pid, sinceSeq }).then((r) => store.onSubscribed(pid, r as OpResult<"subscribe">), () => store.dropView(pid));
    }
  }

  private scheduleReconnect() {
    store.setConn("backoff");
    this.conn = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject({ code: "timeout", message: "disconnected" }); }
    this.pending.clear();
    setTimeout(() => this.open(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
  }

  /** 设置页修改地址、扫描新的连接二维码后调用：丢弃当前连接，立即用新地址重连 */
  async reconnectNow() { this.generation++; this.conn?.close(); this.backoffMs = 1000; await this.open(); }

  // 每 20 秒发 {t:"ping"}；45 秒内没收到任何帧就 close() 触发重连
  private startHeartbeat() { /* ... */ }
}
export const connection = new Connection();
```

**`net/pairing.ts`**：`pairWithQr(qr: PairQr, deviceName: string): Promise<SavedHost>`：

1. 依次尝试 `candidateUrls(qr)`，用 `openSecure(url, qr.hostKey, ...)` 建立加密通道（握手成功即证明对方持有二维码中公钥对应的私钥）。
2. 发送 `{t:"pair", protocol: PROTOCOL_VERSION, code: qr.code, deviceName}`。
3. 收到 `pair_ok` → 关闭这条连接，返回 `{ endpoint: { hostId, hostKey, hostName: pair_ok.hostName, relays, direct }, deviceId, secret, pairedAt }`；收到 `pair_err` 或 15 秒超时 → 抛出错误（`invalid_code` 显示"配对码无效或已过期"）。
4. 调用方 `saveHosts([saved])`（本期替换掉已有的），然后 `connection.reconnectNow()`。

- `store.applyEvents(q)`：按 processId 分组，逐条处理：
  - 该进程视图处于 `resyncing`（正在等待 subscribe 结果）→ 丢弃该事件；
  - `seq <= view.seq` → 重复，丢弃；
  - `seq > view.seq + 1` → 有缺口：视图标 `resyncing`，重新 `subscribe`（不带 sinceSeq）；
  - 否则调用 `applyEvent`。
- `store.onSubscribed(pid, r)`：`mode === "snapshot"` 时 `view = fromSnapshot(r.snapshot)`；`mode === "replay"` 时保留现有视图；两种情况都清除 `resyncing`。hostd 保证先回 `res` 再发后续事件（7.2.9），所以清除标记后收到的事件都可直接按上面的规则处理。
- 任何需要"重新 subscribe 拿快照"的地方（缺口、`session_changed`、`compaction` 结束）都走同一个函数 `resync(pid)`：设 `resyncing`，发 `subscribe {processId}`，结果交给 `onSubscribed`。
- App 切到前台（`AppState` 变为 `active`）时，若连接不是 `ready`，立即重连（重置 backoff）。

#### 7.3.8 `state/view-reducer.ts`（核心，逐条实现）

```ts
export interface ProcessView {
  seq: number;
  info: ProcessInfo;
  messages: WireMessage[];
  hasMoreBefore: boolean;
  inflight?: AssistantDraft;            // { role:"assistant", content: Block[] }
  runningTools: Record<string, { toolName: string; args: unknown; partialText: string }>;
  pendingUi: UiRequest[];
  pendingRpiv: RpivPrompt[];
  extStatus: Record<string, string>;
  extWidgets: Record<string, { lines: string[]; placement: string }>;
  toasts: { id: string; text: string; level: string }[];
}
```

`fromSnapshot(s: Snapshot): ProcessView` 直接映射。

`applyEvent(v, ev, seq)` 先 `v.seq = seq`，再：

| ev.type | 处理 |
|---|---|
| `session_changed` | `info = ev.info`，然后调用 `resync(pid)`（7.3.7）获取新会话快照。reducer 本身保持纯函数：返回更新后的视图并附带 `needsResync: true` 标记，由 store 在 reducer 返回后调用 `resync` |
| `info` | `info = ev.info` |
| `agent_start` | 无（状态由 info 驱动） |
| `agent_settled` | `inflight = undefined`；`runningTools = {}` |
| `message_start` | `role === "assistant"` → `inflight = { role: "assistant", content: [] }`；其他角色忽略 |
| `message_update` | 对 `inflight.content[delta.contentIndex]`：`text_start` → `{type:"text",text:""}`；`text_delta` → `text += delta`；`text_end` → `text = content`；`thinking_start` → `{type:"thinking",thinking:""}`；`thinking_delta` → 追加；`thinking_end` → 覆盖；`toolcall_start` → `{type:"toolCall", id, name: toolName, arguments: {}, argsText: ""}`；`toolcall_delta` → `argsText += delta`；`toolcall_end` → 用 `toolCall` 覆盖。`inflight` 不存在时先按 `message_start` 创建 |
| `message_end` | `messages.push(ev.message)`；`role === "assistant"` 时 `inflight = undefined` |
| `tool_start` | `runningTools[id] = { toolName, args, partialText: "" }` |
| `tool_update` | `runningTools[id].partialText = partialText` |
| `tool_end` | `delete runningTools[id]` |
| `model_changed`、`thinking_changed` | 更新 `info.model` / `info.thinkingLevel` |
| `compaction` | 加一条 toast；`phase === "end"` 时同样返回 `needsResync: true`（压缩会改变显示） |
| `context_usage` | `info.contextUsage = usage` |
| `ui_request` | `pendingUi.push(req)` |
| `ui_closed` | 从 `pendingUi` 删除该 uiId |
| `rpiv_prompt` | `pendingRpiv.push(prompt)` |
| `rpiv_closed` | 删除该 toolCallId |
| `notify` | 加 toast（3 秒后自动移除，由 UI 负责） |
| `ext_status` | `text` 为空则删除 key，否则设置 |
| `ext_widget` | `lines` 为空则删除 key，否则设置 |
| `error` | 加 error 级 toast |

reducer 必须是纯函数（返回新对象，不修改入参），方便 zustand 触发渲染。

#### 7.3.9 页面行为

**pair.tsx**
- 深链接：`piremote://pair?qr=<encodeURIComponent(JSON)>` 打开配对页并预填（用 expo-router 的 `useLocalSearchParams` 读 `qr`）。**深链接来的配对信息必须先弹确认框**，显示电脑名称、公钥指纹（`hostKey` 前 16 个字符）和中继地址，用户点"确认配对"后才执行；已经配对过时额外提示"将替换当前配对的电脑"。
- 扫码（expo-camera `CameraView` 的 `onBarcodeScanned`）得到 JSON；或"粘贴配对信息"文本框（内容同二维码 JSON，供无法扫码时用 `pi-hostd pair` 打印的文字）。
- 解析后校验：`v === 2`、`kind === "pair"`、`hostId`/`hostKey`/`code` 为非空字符串、`relays` 是数组且（`relays.length > 0` 或有 `direct`）。不合格显示"不是 pi-remote 配对码"。若 `kind === "endpoint"`，提示"这是连接信息二维码，请到 设置 → 连接 中扫描"。
- 调用 `pairWithQr(qr, "Android " + 设备型号)`（设备型号用 `expo-constants` 能取到的字段，取不到就用 "Android"）。成功：保存并跳首页。失败按错误显示："配对码无效或已过期，在电脑上重新执行 pi-hostd pair" / "连不上：检查中继地址、电脑上 pi-hostd 是否运行（`pi-hostd relay show`）" / "电脑身份校验失败：二维码与电脑不匹配"（握手失败）。

**index.tsx（首页）**
- 顶部：连接状态条（ready 绿 / backoff 黄"重连中" / no_credentials → 跳转 pair）。
- 状态条在 ready 时附带小字显示通道（"直连" / "经中继"）；backoff 时显示 `lastError`。
- "运行中"分组：store 中所有 ProcessInfo，**按父子关系显示为树**（7.6.3）。顶层按 status 排序（waiting_ui 优先），子项缩进显示在父项下方。每项显示：角色徽标（子 agent / 成员，主进程不显示）、会话名或首条消息、cwd 的最后一级目录、模型、状态徽标（运行中/等待确认 N/空闲）、`lastText`。子项的"等待确认"也要在父项上汇总显示（"子任务待确认 N"）。点击 → `session/[processId]`。
- "项目"分组：`list_projects`；展开某项目时 `list_sessions {cwd}`。会话项若有 `liveProcessId` 显示"运行中"并直接跳转；否则点击 → 信任选择（7.3.10）→ `open_session` → 跳转。加载中显示"正在启动 pi…（最多 45 秒）"。`spawn_timeout` 错误把 message 全文显示在可滚动对话框里。
- 右上角："新会话"（→ new.tsx）、"设置"。
- 下拉刷新：`list_sessions {refresh: true}`。

**new.tsx**：项目列表（`list_projects`）单选，或输入绝对路径；信任选择；`new_process` → 跳转会话页。

**session/[processId].tsx**
- 进入时：若 store 无该进程视图，`subscribe {processId}`，用快照建视图；离开页面**不取消订阅**（后台需要状态），但最多保留 5 个视图，超出时对最久未看的执行 `unsubscribe` 并丢弃视图。
- 顶栏：会话名（点击 → SessionInfoSheet）；模型 chip（→ ModelSheet）；思考级别 chip（→ ThinkingSheet）；上下文占用百分比；状态。
- `extStatus` 以小字一行显示在顶栏下方；`extWidgets` 按 placement 显示在输入框上方或下方（等宽字体，原样显示行）。
- 主体：Transcript（7.3.11）。`hasMoreBefore` 时顶部显示"加载更早消息"，调用 `get_history {beforeEntryId: messages[0].entryId}`，结果插到前面。
- 底部依次：`pendingRpiv`（每个一张卡片，点击打开 RpivSheet）；`pendingUi`（UiRequestCard，`coveredBy` 有值的 custom 卡片不显示）；Composer。
- 网络未 ready 时，输入框禁用并显示"未连接"。
- 进程下线（`proc down`）：页面显示"pi 进程已退出"，提供"重新打开此会话"（`open_session`）。

#### 7.3.10 信任选择 TrustDialog

两个按钮："信任项目资源（--approve）"、"不加载项目资源（--no-approve）"，加一个"记住此项目"勾选。记住的结果存在 App 本地（secure-store 中的一个 JSON map：cwd → trust），下次同 cwd 直接用。设置页提供"清除记住的信任选择"。

#### 7.3.11 Transcript 渲染

- `FlatList`，数据 = `messages` + （有 `inflight` 时）末尾的 inflight + 每个 runningTool 一个临时项。
- 自动滚动：用户位于底部（距离底部 < 80px）时，内容变化后 `scrollToEnd`；否则显示"↓ 最新"按钮。
- `MessageItem` 按 role：

| role | 显示 |
|---|---|
| `user` | 右侧气泡；content 为字符串直接显示，数组时显示 text 块，image 块显示"[图片]" |
| `assistant` | 左侧；按 content 顺序：`text` → Markdown；`thinking` → 可折叠灰色块（默认折叠，若 `hideThinkingBlock` 为 true 则只显示"思考已隐藏"）；`toolCall` → ToolCallCard（参数摘要）。`stopReason === "error"` 时显示 `errorMessage` 红字；`aborted` 显示"已中止" |
| `toolResult` | 合并显示到对应 toolCall 卡片下方：按 `toolCallId` 关联；找不到时独立显示。`isError` 红色边框。`truncated` 显示"（输出已截断）" |
| `bashExecution` | 等宽块：`$ command` + output |
| `custom` | `CustomMessageCard`：已知 `customType` 按 7.6.5 渲染；其他为灰底卡片，标题 `customType`，内容按 Markdown 显示 |
| `compactionSummary` | 分隔线"上下文已压缩"，点击展开 summary |
| `branchSummary` | 分隔线"分支摘要"，点击展开 |

- ToolCallCard 参数摘要规则：`bash` → `$ {command}`；`read` → `读取 {path}`（有 offset/limit 时附上）；`write` → `写入 {path}（{content 行数} 行）`；`edit` → `编辑 {path}（{edits.length} 处）`，结果 `details.patch` 存在时用 PatchView 渲染；子 agent / team 工具按 7.6.5 的摘要规则；其他工具 → 工具名 + `JSON.stringify(args)` 前 300 字符。卡片默认折叠结果，点击展开；结果超过 200 行时只显示前 200 行和"显示全部"。
- PatchView：按行着色，`+` 开头绿底、`-` 开头红底、`@@` 开头蓝字，等宽字体，横向可滚动。
- 运行中工具：显示工具摘要 + 旋转指示 + `partialText` 末尾 20 行。

#### 7.3.12 Composer 与斜杠命令

- 多行 `TextInput`，`blurOnSubmit={false}`，发送按钮发送（不要用回车发送，手机输入法回车是换行）。
- 运行中（`info.status !== "idle"`）：显示分段开关"插话 / 排队"（默认插话，即 `steer`）与红色"停止"按钮（`abort`）。
- 图片按钮：`expo-image-picker` `launchImageLibraryAsync({ base64: true, quality: 0.7 })`，最多 4 张，缩略图显示在输入框上方，可删除。当前模型 `info.model.input` 不含 `image` 时按钮置灰并提示。
- 输入以 `/` 开头时显示 SlashMenu：内置命令（下表）+ `get_commands` 结果（进入会话页时拉取一次并缓存），按前缀过滤。
- 发送时先经过 `lib/slash.ts`：

| 输入 | App 行为 |
|---|---|
| `/model` | 打开 ModelSheet |
| `/thinking` | 打开 ThinkingSheet |
| `/tree` | 打开 TreeSheet |
| `/fork` | 打开 ForkSheet（position `before`） |
| `/clone` | `get_tree` 取 `leafId` → `fork {entryId: leafId, position: "at"}`，确认后执行 |
| `/new` | 确认框 → `new_session` |
| `/resume` | 打开 ResumeSheet |
| `/compact [说明]` | 有参数直接 `compact {customInstructions}`；无参数打开 CompactSheet |
| `/settings` | 跳转 settings.tsx |
| `/name <名称>` | `set_name`；无参数时弹输入框 |
| `/reload` | 确认框 → `reload` |
| `/session` | 打开 SessionInfoSheet |
| `/copy` | 把最后一条 assistant 文本复制到剪贴板（expo-clipboard），不发请求 |
| `/login` `/logout` `/hotkeys` `/share` `/export` `/import` `/bug` `/changelog` `/scoped-models` `/trust` `/quit` | 提示"该命令只能在电脑上使用"，不发送 |
| 其他 `/xxx` | 作为普通 `prompt` 发送（扩展命令、模板、技能由 pi 处理） |
| 普通文本 | `prompt {text, images, deliverAs}`；空闲时不带 deliverAs |

发送失败按错误码提示：`busy_need_deliver_as`（不应出现，出现说明 UI 状态过期，刷新 info）、`model_no_image`、`replacing`（"会话切换中，请稍后重试"）等。

#### 7.3.13 各弹层

- **UiRequestCard**：
  - select → 选项按钮列表 + "取消"；confirm → 标题、message、"确认"/"取消"；input → 单行输入 + 确定/取消；editor → 多行输入（预填 prefill）+ 确定/取消；custom → 文案"扩展界面需在电脑上操作"+ 标题（若有）+ "取消该界面"按钮（发 `{cancelled:true}`）。
  - 有 `timeoutMs` 时显示倒计时（从收到事件时开始算），到时只是变灰，不发请求（本地 pi 自己处理超时）。
  - 回答后立即把卡片标为"已提交"，收到 `ui_closed` 再移除；`ui_respond` 返回 `not_found` 时提示"已在电脑上回答"。
- **RpivSheet**：每题一页（顶部显示 header 作为标签），单选题用单选列表 + "其他（自己输入）"输入框；多选题用复选列表 + 可选补充文本；最后一页"提交"。组装 `RpivAnswer`：单选选项 → `{questionIndex, optionIndexes:[i]}`；自定义文本 → `{questionIndex, text}`；多选 → `{questionIndex, optionIndexes:[...], text?}`。"放弃回答" → `{toolCallId, cancel: true}`。返回 `ok:false` 时显示 `reason` 并停留在 sheet。`hasPreview` 的选项显示"（电脑端可预览）"。
- **ModelSheet**：`get_models`，按 provider 分组，当前模型打勾，显示是否支持图片、是否推理模型；点击 → `set_model`；`no_auth` → 提示"该提供商未登录，请在电脑上 /login"。
- **ThinkingSheet**：`get_thinking_levels`，单选 → `set_thinking`。
- **TreeSheet**：`get_tree`；按父子关系计算缩进深度（深度超过 12 时按 12 显示）；过滤器（默认值取设置 `treeFilterMode`，App 内可切换）：
  - `default`：隐藏 `toolResult` 和 `other`；
  - `no-tools`：在 default 基础上隐藏只含工具调用的 assistant（preview 为空的 assistant）；
  - `user-only`：只显示 `user`；
  - `labeled-only`：只显示有 label 的；
  - `all`：全部显示。
  活动路径上的节点加粗，叶子标"当前"。点击节点 → 确认框（"是否总结被放弃的分支"开关 + 可选总结说明）→ `navigate_tree`。运行中时整个 sheet 只读并提示"agent 运行中，无法切换"。
- **ForkSheet**：`get_fork_points`，倒序列出用户消息；点击 → `fork {entryId, position:"before"}`；成功后把 `prefillText` 填进输入框。
- **ResumeSheet**：`list_sessions {cwd: 当前 info.cwd}`，再加一个"全部项目"切换。点击：目标是当前会话 → 关闭；`liveProcessId` 存在且不是当前进程 → 直接跳转到那个进程页面；否则 `switch_session`。`conflict_live_elsewhere` → 跳转到 message 中给的 processId。
- **CompactSheet**：可选说明输入框 + "压缩"按钮 → `compact`，期间显示进度，完成后关闭。
- **SessionInfoSheet**：显示 ProcessInfo 全部字段（cwd、sessionFile、sessionId、tmuxPane、pid、piVersion、compat、上下文占用），提供"重命名"（`set_name`）与"关闭此 pi 进程"（确认后 `shutdown`；仅当 `spawnedByHostd` 为 true 或 `role.kind !== "main"` 时显示，避免误关用户自己开的主进程）。子 agent / team 成员还显示 7.6.4 的角色信息。

#### 7.3.14 settings.tsx

- "pi 全局设置"：`get_settings`，按 `REMOTE_SETTINGS` 渲染：boolean → Switch；enum → 点击后弹出单选。修改后 `set_setting`，用返回值刷新。`applies` 为 `reload` 的项下方注明"在线进程将在空闲时重新加载"，`new_session` 注明"新会话生效"。
- "连接"（D18，换 VPS / 换网络时在这里改）：
  - 只读：电脑名称（hostName）、hostId、电脑公钥指纹（`hostKey` 的前 16 个字符，按 4 位分组）、deviceId、hostVersion、当前通道（直连/中继）、最近错误。
  - 可编辑：**中继地址**（单行，例如 `ws://203.0.113.5:7443` 或 `wss://relay.example.com`；保存时校验以 `ws://` 或 `wss://` 开头、能被 `new URL()` 解析、没有路径/查询参数）；**直连地址**（可空，同样校验）。保存 → 写入 `SavedHost.endpoint.relays = [地址]` / `direct` → `connection.reconnectNow()`。
  - "测试连接"按钮：对每个候选地址单独调用 `openSecure`（不鉴权，握手成功即关闭），逐条显示"成功 / 失败原因"。
  - "扫描连接信息二维码"：扫描 `pi-hostd qr` 的 `EndpointQr`；`hostId` 和 `hostKey` 必须与已保存的一致（不一致提示"这是另一台电脑的二维码"并拒绝），一致则用其中的 `relays`、`direct`、`hostName` 覆盖并重连。
  - "解除配对"：删除本地凭据，跳 pair 页，提示在电脑上 `pi-hostd devices revoke <deviceId>`。
- "App"：后台保持连接开关（默认开）；电池优化设置入口（notify-kit 的 `openBatteryOptimizationSettings`，若该 API 不存在则用 `Linking.openSettings()`）；清除记住的信任选择；子 agent 完成时是否通知（默认关，7.6.6）。

#### 7.3.15 `bg/foreground.ts` 与 `bg/notifications.ts`

```ts
import notifee, { AndroidImportance } from "react-native-notify-kit";
let stopResolver: (() => void) | undefined;

export function foregroundRunner(): Promise<void> {
  // 连接本身由 connection 单例维持；runner 只需保持 Promise 不结束
  return new Promise<void>((resolve) => { stopResolver = resolve; });
}

export async function startForeground(summary: string) {
  await notifee.requestPermission();
  await notifee.createChannel({ id: "pi-remote-conn", name: "Connection status", importance: AndroidImportance.LOW });
  await notifee.displayNotification({
    id: "pi-remote-fg", title: "pi-remote", body: summary,
    android: {
      channelId: "pi-remote-conn", asForegroundService: true, ongoing: true,
      pressAction: { id: "default" },
      // 前台服务类型字段名以 notify-kit README 为准（例如 foregroundServiceTypes）
    },
  });
}

export async function stopForeground() {
  await notifee.stopForegroundService();
  stopResolver?.(); stopResolver = undefined;
}
```

- 连接进入 `ready` 且"后台保持连接"开启 → `startForeground`；用户关闭开关或解除配对 → `stopForeground`。
- 前台通知正文每当进程状态变化时更新（同 id 再次 `displayNotification`）：`"{运行中数} 个运行中 · {等待确认数} 个等待确认"`。
- 事件通知（channel `pi-remote-events`，importance HIGH）规则，在 `onProc(kind, info)` 中判断，与该进程上一次的 info 比较：
  - status 变为 `waiting_ui`，或 `pendingUiCount` 增加 → 标题"需要确认"，正文为会话名或 cwd 最后一级目录。
  - status 从 `running` 变为 `idle` → 标题"已完成"，正文 `lastText`。`role.kind !== "main"` 的进程默认不发"已完成"（结果会回到父进程，父进程完成时再通知），除非设置里打开"子 agent 完成时通知"。"需要确认"对所有角色都发，标题写成"子 agent {name} 需要确认" / "成员 {name} 需要确认"。
  - 仅当 App 不在前台，或前台页面不是该进程的会话页时发送。同一进程同类通知 10 秒内只发一次。
  - 通知 `data: { processId }`；`notifee.onForegroundEvent` / `onBackgroundEvent` 中处理 PRESS，`router.push(\`/session/${processId}\`)`。

---

### 7.4 relay（`packages/relay`，运行在 VPS）

中继是一个独立的小服务，**不依赖本仓库的其他包**（Docker 构建时只拷贝这个目录），因此把 6.11 中的常量复制一份到 `src/wire.ts`，文件头注释写明"必须与 packages/protocol/src/relay.ts 保持一致"。

#### 7.4.1 package.json

```json
{
  "name": "pi-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node src/main.ts" },
  "dependencies": { "ws": "^8" },
  "devDependencies": { "@types/ws": "^8", "@types/node": "^24", "typescript": "^5" }
}
```

运行要求：Node ≥ 22.18（原生运行 `.ts`）。TypeScript 写法规则同第 0 章第 2 条。

#### 7.4.2 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_PORT` | `7443` | 监听端口 |
| `RELAY_HOST` | `0.0.0.0` | 监听地址 |
| `RELAY_SECRET` | 无，必填 | hostd 连接时必须提供的密钥。未设置时启动失败并打印说明 |
| `RELAY_TRUST_PROXY` | `0` | 为 `1` 时从 `X-Forwarded-For` 取客户端 IP（前面有 TLS 反代时用） |

#### 7.4.3 `src/main.ts` 行为

数据结构：

```ts
interface HostRecord { control: WebSocket; lastSeen: number }
interface PendingClient { ws: WebSocket; hostId: string; buffered: { data: RawData; isBinary: boolean }[]; bufferedBytes: number; timer: NodeJS.Timeout }
const hosts = new Map<string, HostRecord>();          // hostId → 控制连接
const pending = new Map<string, PendingClient>();     // connId → 等待拼接的 App 连接
```

HTTP：`GET /healthz` → `200 {"ok":true,"hosts":<在线 hostd 数>,"pending":<等待数>}`；其他 404。

WebSocket（`new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })`，在 `upgrade` 事件中按路径分发；路径不匹配 → `socket.destroy()`）：

1. **`/v1/host/control?hostId=H`**
   - `hostId` 必须匹配 `/^[A-Za-z0-9_-]{16,64}$/`；`Authorization` 头必须等于 `Bearer ${RELAY_SECRET}`（用 `timingSafeEqual` 比较等长 Buffer，长度不同直接判失败）。失败：完成升级后立即 `close(CLOSE.BAD_RELAY_SECRET)`。
   - 已有同 hostId 的控制连接 → 旧的 `close(CLOSE.HOST_REPLACED)`，新的替换它。
   - 每 25 秒发 `{t:"ping", ts}`；60 秒没有收到任何帧 → `terminate()` 并从 `hosts` 删除。
2. **`/v1/client?hostId=H`**
   - 同一 IP 同时打开的 client 连接上限 20 个，超出 `close(CLOSE.RATE_LIMITED)`。
   - `hosts` 中没有 H → `close(CLOSE.HOST_OFFLINE)`。
   - 生成 `connId = randomBytes(16).toString("base64url")`，放入 `pending`；在等待期间收到的帧放入 `buffered`（最多 64 帧且总计 1MB，超出则 `close(1009)`）。
   - 向 H 的控制连接发送 `{t:"client", connId}`。
   - 10 秒内没有对应的数据连接 → `close(CLOSE.PAIR_TIMEOUT)` 并删除。
3. **`/v1/host/data?hostId=H&connId=C`**
   - 校验 `Authorization` 同上；`pending` 中 C 必须存在且其 `hostId === H`，否则关闭（1008）。
   - 拼接：先把 `buffered` 按顺序 `data.send(frame, { binary: isBinary })`，然后双向转发：`a.on("message", (d, isBinary) => b.send(d, { binary: isBinary }))`。
   - 任一端 `close` → 关闭另一端：关闭码在 1000 或 3000～4999 范围内时原样传递，否则用 1000。任一端 `error` → 两端 `terminate()`。
   - 从 `pending` 删除 C，清除定时器。

中继**不解析**拼接后的任何帧。日志只记录：时间、事件（host_up/host_down/client_open/client_spliced/client_closed）、hostId 前 6 个字符、客户端 IP；不记录帧内容。

#### 7.4.4 部署文件

`Dockerfile`：

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV RELAY_PORT=7443
EXPOSE 7443
USER node
CMD ["node", "src/main.ts"]
```

`pi-relay.service`（不用 Docker 时，系统级服务）：

```ini
# 安装：把 packages/relay 复制到 /opt/pi-relay，在其中 npm install --omit=dev
# 新建 /etc/pi-relay.env，内容 RELAY_SECRET=...，权限 600
# cp pi-relay.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now pi-relay
[Unit]
Description=pi-remote relay
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/pi-relay
EnvironmentFile=/etc/pi-relay.env
ExecStart=/usr/bin/node src/main.ts
Restart=always
RestartSec=3
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```

---

### 7.5 迁移（D18）

三端各自只保存自己的东西：

| 端 | 保存的内容 | 位置 |
|---|---|---|
| VPS | 只有 `RELAY_SECRET` | 容器环境变量或 `/etc/pi-relay.env` |
| 电脑 | 身份（hostId、密钥对）、已配对设备、中继地址与密钥、直连设置 | `~/.config/pi-remote/` |
| 手机 | 电脑列表（每台：hostId、电脑公钥、中继地址、直连地址、设备凭据） | App 的 secure-store |

**换 VPS**

1. 新 VPS 按 5.2 部署中继（可以沿用旧的 `RELAY_SECRET`，也可以新生成）。
2. 电脑：`pi-hostd relay set ws://<新地址>:7443 --secret <RELAY_SECRET>`。hostd 5 秒内自动切换（7.2.3），`pi-hostd relay show` 显示 `connected`。
3. 手机：设置 → 连接 → 修改中继地址；或在电脑上 `pi-hostd qr`，手机"扫描连接信息二维码"。
4. 不需要重新配对。旧 VPS 直接停掉。

换 VPS 期间，若电脑开着直连且手机与电脑在同一局域网，手机会走直连，不受影响。

**换电脑**

1. 旧电脑：`pi-hostd export ~/pi-remote-identity.json`，通过安全方式拷到新电脑（例如 `scp`），然后删除旧电脑上的这个文件。
2. 新电脑：拷贝本仓库、`npm install`、`pi install .../packages/bridge`、`pi-hostd import ~/pi-remote-identity.json`、按 7.2.14 安装服务；删除导入文件。
3. 手机无需任何操作（hostId 与公钥不变）。旧电脑上的 hostd 必须停掉：同一 hostId 的两个 hostd 会在中继上互相顶替（`HOST_REPLACED`）。
4. pi 的会话文件（`~/.pi/agent/sessions`）、pi 配置和扩展的迁移属于 pi 本身，不在本项目范围内。

不想迁移身份时：新电脑 `pi-hostd init` 后让手机重新扫码配对即可。

**换手机**

1. 新手机安装 APK；电脑上 `pi-hostd pair`；新手机扫码。
2. 电脑上 `pi-hostd devices list` 找到旧手机，`pi-hostd devices revoke <id>`。

**安全说明**：中继地址、中继密钥泄露只会让别人能占用你的中继带宽，读不到也伪造不了内容；电脑身份文件（含私钥）和手机里的设备凭据才是需要保护的东西。

---

### 7.6 子 agent 与 team 成员（D17）

依据：`extensions/pi-interactive-subagents`（本仓库内）的实际实现，见附录 A-20～A-23。不修改该扩展。

#### 7.6.1 bridge：识别角色（`role.ts`）

子 agent 和 team 成员都是在 tmux pane 里以 TUI 模式启动的 pi，会正常加载 bridge，出现在进程列表里。启动它们的扩展通过环境变量传入身份，bridge 据此判断角色：

```ts
export function detectRole(): ProcessRole {
  const e = process.env;
  if (e.PI_TEAM_MEMBER_ID && e.PI_TEAM_LEAD_PID) {
    return {
      kind: "team_member", memberId: e.PI_TEAM_MEMBER_ID, name: e.PI_TEAM_MEMBER_NAME || e.PI_TEAM_MEMBER_ID,
      agent: e.PI_TEAM_AGENT || undefined, write: e.PI_TEAM_WRITE === "1",
      branch: e.PI_TEAM_BRANCH || undefined, worktree: e.PI_TEAM_WORKTREE || undefined,
      leadPid: Number(e.PI_TEAM_LEAD_PID), runDir: e.PI_TEAM_RUN_DIR || undefined,
    };
  }
  if (e.PI_SUBAGENT_ID) {
    return {
      kind: "subagent", subagentId: e.PI_SUBAGENT_ID, name: e.PI_SUBAGENT_NAME || e.PI_SUBAGENT_ID,
      agent: e.PI_SUBAGENT_AGENT || undefined, autoExit: e.PI_SUBAGENT_AUTO_EXIT === "1",
    };
  }
  return { kind: "main" };
}
```

父进程一侧：bridge 维护 `childSessionFiles`（7.1.4 表格最后一行），记录本进程用 `subagent` / `subagent_resume` 工具启动过的子 agent 会话文件。

#### 7.6.2 hostd：推导父进程（`links.ts`）

```ts
const realCache = new Map<string, string>();
const norm = (f?: string) => {
  if (!f) return undefined;
  let r = realCache.get(f);
  if (r === undefined) { try { r = realpathSync(f); } catch { r = f; } realCache.set(f, r); }
  return r;
};

export function recompute(): ProcessInfo[] /* 返回 parentProcessId 发生变化的进程 */ {
  const all = registry.entries();
  const changed: ProcessInfo[] = [];
  for (const e of all) {
    const role = e.info.role;
    let parent: string | undefined;
    if (role.kind === "team_member") {
      parent = all.find((x) => x !== e && x.info.pid === role.leadPid)?.info.processId;
    } else if (role.kind === "subagent") {
      const mine = norm(e.info.sessionFile);
      parent = mine ? all.find((x) => x !== e && x.info.childSessionFiles.some((c) => norm(c) === mine))?.info.processId : undefined;
    }
    if (parent !== e.info.parentProcessId) { e.info.parentProcessId = parent; changed.push(e.info); }
  }
  return changed;
}
```

`realCache` 只增不减即可（条目数量很小）。推导不出父进程时（例如用 `/iterate` 命令启动的子 agent 不经过 `subagent` 工具，或父进程已退出），`parentProcessId` 为空，App 把它当作顶层进程显示，但仍带角色徽标。

#### 7.6.3 App：首页树形列表

- 以 `parentProcessId` 建树；`parentProcessId` 指向不在线的进程时视为顶层。递归深度最多显示 4 层（防御循环引用：遍历时记录已访问的 processId）。
- 子项缩进 16px，左侧竖线连接。角色徽标：`子 agent · {name}`（有 `agent` 时追加 `（{agent}）`）；`成员 · {name}`，`write` 为 true 时追加 `· 写入 {branch}`。
- 父项汇总：子孙中 `waiting_ui` 的数量 > 0 时，父项显示橙色"子任务待确认 N"；子孙中 `running` 的数量显示为"子任务运行中 N"。

#### 7.6.4 App：会话页

- **ChildStrip**（顶栏下方，横向滚动）：当前进程的直接子进程，每个一个小卡片：名称、角色、状态色点（running 蓝 / waiting_ui 橙 / idle 灰）。点击进入子进程的会话页。没有子进程时不显示。
- 子进程的会话页顶栏显示"↑ {父进程会话名}"链接，点击回到父进程。顶栏下方一行显示角色信息：
  - 子 agent：`子 agent {name}`、`agent {agent}`、`完成后自动退出`（autoExit 为 true 时）。
  - team 成员：`成员 {name}`、`agent {agent}`、`只读` 或 `写入分支 {branch}`、worktree 路径（可复制）。
- 子进程的会话页功能与普通会话完全相同（发消息、插话、停止、回答确认框、/model 等），相当于电脑上切到那个 tmux pane 接手。
- 父进程会话页里由扩展绘制的状态面板（`subagent-status`、`team-status`）以 `extWidgets` 的纯文本形式显示在输入框上方（7.1.5 组件 widget 转文本）；子进程页同理显示 `subagent-tools`、`team-member` 面板。等宽字体，可横向滚动，可点击折叠。

#### 7.6.5 App：消息与工具卡片

`CustomMessageCard` 按 `customType`：

| customType | 显示 |
|---|---|
| `subagent_result` | 标题"子 agent {details.name} 已结束"（`details.agent` 存在时附上）、用时 `details.elapsed`、退出码 `details.exitCode`；`details.errorMessage` / `details.error` 存在时红字显示；正文 content 用 Markdown，默认折叠为前 12 行。按钮"查看子 agent 记录"：`details.sessionFile` 对应的会话若有在线进程（store 中 `sessionFile` 相同的 ProcessInfo）→ 跳到其会话页；否则 → `history?sessionFile=...`（只读，7.6.6） |
| `subagent_ping` | 橙色卡片"子 agent {details.name} 请求协助"，正文 `details.message`；按钮同上 |
| `subagent_status` | 灰色小字列表，每行一条 `details.lines`；有 `details.overflow` 时末尾加"…还有 N 条" |
| `subagent_model_fallback` | 灰色一行通知，显示 content |
| `team_message` | 对 `details.items` 逐条显示：`{from}` 徽标、`kind`（task/message/report/question/cc 分别显示为 任务/消息/汇报/提问/抄送）、`status`（done/progress/blocked/failed 显示为 完成/进行中/受阻/失败，不同颜色）、`body`（Markdown，默认折叠为前 8 行）。`details.items` 缺失时按普通文本显示 content |
| `team_notice` | 灰色一行通知，显示 content |

ToolCallCard 摘要规则（参数字段以实际 args 为准，缺失字段省略）：

| 工具 | 摘要 |
|---|---|
| `subagent` | `启动子 agent {name}（{agent}）`，下一行 `task` 前 200 字符；结果中 `details.sessionFile` 存在时显示"查看"按钮（同 subagent_result） |
| `subagent_resume` | `恢复子 agent {name}` |
| `subagent_interrupt` | `中断子 agent {name 或 id}` |
| `subagents_list` | `列出子 agent` |
| `team_spawn` | `加入成员 {name}（{agent}）`，`write` 为 true 时加"可写" |
| `team_send` | `发给 {to}：{message 前 80 字符}` |
| `team_list` / `team_stop` / `team_interrupt` / `team_integrate` / `team_sync` | `成员列表` / `停止成员 {name}` / `中断成员 {name}` / `合并成员 {name} 的改动` / `同步成员 {name}` |
| `team_report` / `team_ask` | `向负责人汇报` / `向负责人提问` |
| `caller_ping` / `subagent_done` | `请求父 agent 协助` / `子 agent 结束` |

#### 7.6.6 App：只读历史页（`history.tsx`）

- 参数 `sessionFile`。调用 `read_session`，用与会话页相同的 Transcript 组件渲染（不显示 Composer、ChildStrip）。顶部显示会话名、cwd、"只读"标记。
- "加载更早消息"用 `read_session {beforeEntryId}`。
- 若该会话当前有在线进程，顶部显示"该会话正在运行 → 打开"按钮。
- 底部按钮"在电脑上继续此会话"：先弹确认"这会在电脑上启动一个独立的 pi 打开该会话；它不再受原父 agent 管理"，确认后走首页同样的 `open_session` 流程（含信任选择）。

#### 7.6.7 已知边界

- `cli: "claude"` 的子 agent 不是 pi 进程：只出现在父进程的状态面板文本和 `subagent_result` 消息中。
- 组件 widget 转文本依赖组件不需要真实 TUI 实例；渲染失败的 widget 不会出现在 App 上（bridge 日志会记录）。
- 子 agent 的 `Ctrl+J` 等快捷键只在电脑上可用。

---

## 8. 本机运行方式汇总

```zsh
# 一次性
cd ~/Projects/Pi-extension-dev/extensions/pi-remote && npm install
node packages/hostd/src/main.ts init
node packages/hostd/src/main.ts relay set ws://<VPS 地址>:7443 --secret '<RELAY_SECRET>'
node packages/hostd/src/main.ts direct enable --advertise ws://<电脑局域网 IP>:7444    # 可选
pi install ~/Projects/Pi-extension-dev/extensions/pi-remote/packages/bridge
# 服务
systemctl --user enable --now pi-hostd.service
node packages/hostd/src/main.ts relay show
# 配对
node packages/hostd/src/main.ts pair
# App 开发
cd apps/mobile && adb reverse tcp:8081 tcp:8081 && npx expo run:android
# App 发布包
cd apps/mobile/android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

开发阶段 App 直连本机（不经 VPS）：`pi-hostd direct enable --advertise ws://127.0.0.1:7444`，`adb reverse tcp:7444 tcp:7444`，然后 `pi-hostd pair` 扫码。

本机也可以临时跑一个中继做联调：`RELAY_SECRET=dev node packages/relay/src/main.ts`，hostd 用 `relay set ws://127.0.0.1:7443 --secret dev`，手机端用 `adb reverse tcp:7443 tcp:7443`。

---

## 9. 里程碑

每个里程碑：实现 → `npm run typecheck` → 逐条验收 → commit。验收中的"观察到"都要实际看到，不要推断。

### M0 环境准备与仓库脚手架

任务：
- 先完成第 5.1 节全部步骤（Android SDK、环境变量、linger）。5.2、5.3 分别在 M6、M7 执行。
- 不要 `git init`（见第 0 章第 9 条）。在项目根目录建 `.gitignore`，包含 `node_modules/`、`apps/mobile/android/`、`apps/mobile/ios/`、`.expo/`、`*.log`、`*identity*.json`（防止误提交导出的身份文件）。
- 根 `package.json`：
  ```json
  { "name": "pi-remote", "private": true, "workspaces": ["packages/*", "apps/*"],
    "scripts": { "typecheck": "tsc -p packages/protocol && tsc -p packages/bridge && tsc -p packages/hostd && tsc -p packages/relay && tsc -p apps/mobile" },
    "devDependencies": { "typescript": "^5.8", "@types/node": "^24" } }
  ```
  （`apps/mobile` 在 M7 前不存在时，先从脚本中去掉这一段，M7 再加回。）
- `tsconfig.base.json`：
  ```json
  { "compilerOptions": { "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true,
      "noEmit": true, "allowImportingTsExtensions": true, "verbatimModuleSyntax": true, "erasableSyntaxOnly": true,
      "skipLibCheck": true, "types": ["node"] } }
  ```
  各包 `tsconfig.json` 继承它，`include: ["src", "scripts"]`。

验收：`npm install` 成功；`npm run typecheck` 通过。

### M1 protocol

任务：按第 6 章建文件。

验收：typecheck 通过；`node -e 'import("./packages/protocol/src/index.ts").then(m=>console.log(m.PROTOCOL_VERSION))'` 输出 `1`（验证 Node 能直接运行，无不可擦除语法）。

### M2 hostd 基础：身份、直连、加密通道、配对、鉴权

任务：7.2.1～7.2.7（此时只实现 direct-server，relay-client 留到 M6）、7.2.13、7.2.15（dev-client 的 `pair`、`procs`、`listen`、`op`，只支持 `--via direct`）。此时 `list_processes` 返回空数组即可。

验收：
1. `pi-hostd init` 生成 `~/.config/pi-remote/identity.json`、`config.json`，`ls -l` 显示 `-rw-------`，目录 `drwx------`。再次 `init` 被拒绝。
2. `pi-hostd direct enable --advertise ws://127.0.0.1:7444` 后 `pi-hostd serve`；`curl http://127.0.0.1:7444/healthz` 返回 `{"ok":true}`。
3. `pi-hostd pair` 打印二维码与 JSON；`dev-client pair '<JSON>'` 成功；再用同一个码配对失败（`invalid_code`）。
4. `dev-client --via direct procs` 返回 `{"processes":[]}`。
5. 把 dev-client.json 里的 `endpoint.hostKey` 改成另一个随机公钥（用 `generateKeyPair` 生成）：连接在握手阶段失败，hostd 不会收到任何应用帧（hostd 日志里没有 auth 记录）。改回。
6. 篡改 dev-client.json 中的 secret 后 `procs` 失败且连接以 `CLOSE.UNAUTHORIZED` 关闭。
7. 先运行 `dev-client listen` 保持连接，另开终端执行 `pi-hostd devices revoke <id>`：5 秒内 listen 被断开。
8. 用 dev-client 的 `--dump-wire` 开关（打印外层 WebSocket 收发的原始帧）运行 `procs`：除 `e2ee_hello` / `e2ee_ready` 握手帧外全是密文，看不到 `list_processes`、`processes` 等明文。（不要用 tcpdump，它需要 sudo。）

### M3 bridge 核心 + 订阅

任务：7.1 全部，**但** `ui-mirror.ts` 中 `patchUi` 暂时为空函数，`rpiv.ts` 暂不注册；hostd 7.2.8、7.2.9（不含会话列表与设置相关 op）；dev-client `watch`、`prompt`。

验收（在 tmux 里开一个 pi：`tmux new -s t1 pi`）：
1. `dev-client procs` 列出该进程，`cwd`、`sessionFile`、`model` 正确，`compat` 为 `ok`。
2. `dev-client watch <pid>` 先打印快照（包含该会话已有消息），之后在 pi 本地输入"你好"，watch 实时打印 `message_start`/`message_update`/`message_end`/`agent_settled`。
3. `dev-client prompt <pid> 用一句话介绍你自己`：pi TUI 中出现这条用户消息并开始回答；watch 同步打印。
4. 运行中再 `dev-client prompt <pid> 改成英文`：被作为 steer 接受（TUI 显示排队/插话）。
5. `dev-client op abort '{"processId":"<pid>"}'`：TUI 中运行中止。
6. pi TUI 画面没有出现任何 bridge 输出的杂字。`~/.local/state/pi-remote/bridge-<pid>.log` 存在。
7. 停止 hostd（Ctrl-C），pi 继续正常使用；5 秒内重启 hostd，`procs` 再次列出该进程（processId 不变）。
8. `watch` 断开后，在 pi 里再问一句，然后 `dev-client op subscribe '{"processId":"<pid>","sinceSeq":<断开前看到的最后 seq>}'` 返回 `{"mode":"replay"}` 并补发缺失事件。
9. 在 pi 里执行 `/new`：watch 收到 `session_changed`，`procs` 中 sessionId 改变，processId 不变。
10. 退出 pi（`/quit`）：`procs` 不再列出，dev-client 收到 `proc down`。
11. `pi -p "hi"` 一次性运行期间，`procs` 不会出现它（D2）。

### M4 对话框与问卷镜像

任务：完成 `ui-mirror.ts`、`rpiv.ts`；hostd 无需改动（只是转发）。

测试夹具：pi 自带的演示扩展 `/usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/rpc-demo.ts`（它会在危险 bash 时 select、在切换会话前 confirm、`/rpc-input` 调 input、`/rpc-editor` 调 editor，并调用 notify/setStatus/setWidget）。启动：`pi -e /usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/rpc-demo.ts`。

验收：
1. watch 中能看到 `ext_widget`（rpc-demo 在 session_start 设置）与 `ext_status`。
2. 在 pi 输入 `/rpc-input`：TUI 出现输入框，watch 出现 `ui_request{kind:"input"}`。用 `dev-client ui <pid> <uiId> '{"value":"abc"}'` 回答：TUI 输入框自动消失，扩展拿到 `abc`（rpc-demo 会 notify，watch 里能看到 `notify`），watch 出现 `ui_closed{by:"remote"}`。
3. 再次 `/rpc-input`，这次在 TUI 里回答：watch 出现 `ui_closed{by:"local"}`；之后 `dev-client ui` 同一 uiId 返回 `not_found`。
4. `/rpc-editor`：手机侧（dev-client）回答后，扩展拿到手机的值；TUI 编辑框仍在（D13），按 Esc 关闭后不产生第二次结果。
5. 让 agent 执行一条会触发 rpc-demo select 的危险 bash（看 rpc-demo 源码中的判断条件），用 dev-client 选择"Block"：工具被阻止。
6. ask_user_question：在已安装 `@juicesharp/rpiv-ask-user-question` 的 pi 里让模型"用 ask_user_question 问我两个单选题"。watch 出现 `rpiv_prompt`，以及一个 `ui_request{kind:"custom", coveredBy:<toolCallId>}`。用 `dev-client op rpiv_answer '{"processId":"<pid>","answer":{"toolCallId":"<id>","answers":[{"questionIndex":0,"optionIndexes":[0]},{"questionIndex":1,"optionIndexes":[1]}]}}'`：返回 `ok:true`，TUI 问卷消失，模型收到答案；watch 出现 `rpiv_closed` 与 `ui_closed`。
7. 在 pi 中运行一个使用 `custom()` 的用户命令（如 pi-session-finder 的命令），watch 出现 `ui_request{kind:"custom"}`（无 coveredBy）。`dev-client ui <pid> <uiId> '{"cancelled":true}'`：TUI 中该界面关闭。
8. 把 `SUPPORTED_PI_VERSIONS` 临时改成 `["0.0.0"]` 重启 pi：`compat` 为 `untested`，对话框不再出现在 watch 中，其余功能正常。改回。

### M5 会话操作、启动 pi、设置

任务：bridge 的全部 op；hostd 7.2.10～7.2.12 与对应 op。

验收（用 dev-client `op`）：
0. `read_session {sessionFile: <任意一个旧会话>}` 返回消息列表；对比文件的 mtime 与 sha256，调用前后不变（只读）。
1. `get_models` 列出模型；`set_model` 切换后 TUI 状态栏模型改变，watch 收到 `model_changed`。
2. `get_thinking_levels` / `set_thinking` 生效并反映在 TUI。
3. `compact`：TUI 中执行压缩；完成后返回 `{}`，watch 收到 `compaction{phase:"end"}`。
4. `get_tree` 返回节点，`onActivePath` 与 TUI `/tree` 一致；`navigate_tree` 到一个较早的用户消息（`summarize:false`）后，TUI 显示分支已切换；运行中调用返回 `busy`。
5. `get_fork_points` + `fork {position:"before"}`：TUI 进入新会话，返回 `prefillText`；watch 收到 `session_changed`。
6. `new_session`、`switch_session` 正常；`switch_session` 到另一个正在运行的 pi 的会话返回 `conflict_live_elsewhere`。
7. `set_name` 后 TUI 会话名改变；`get_commands` 包含扩展命令、模板、技能，不包含 `pi-remote-op`。
8. 选一个当前没有任何进程打开的旧会话（`list_sessions` 中 `liveProcessId` 为空的项；**不要关闭用户或你自己正在使用的 pi**）。`open_session {sessionFile, trust:"deny"}` 在 45 秒内返回 processId；`tmux attach -t pi-remote` 能看到该 pi 已加载这个会话；`procs` 中 `spawnedByHostd: true`。
9. 对同一会话再次 `open_session` 返回同一 processId，`spawned:false`。
10. `new_process {cwd:"/home/moorey/Projects/Pi-extension-dev/extensions/pi-remote", trust:"approve"}` 启动新 pi。`cwd` 指向 `/etc` 返回 `bad_request`。
11. 临时把 config 的 `piCommand` 改成不存在的命令，`new_process` 在 45 秒后返回 `spawn_timeout`，message 中包含 tmux pane 的最后几行输出。改回。
12. `get_settings` 返回白名单值；`set_setting {key:"hideThinkingBlock", value:true}` 后 `~/.pi/agent/settings.json` 中该字段为 true、其他字段未被改动（对比修改前后的文件）；在线的空闲 pi 执行了 reload（TUI 有 reload 提示），运行中的 pi 在本轮结束后 reload。验收完成后用 `set_setting` 把该项改回原值，并确认 settings.json 与修改前一致（这是用户的全局设置）。
13. `shutdown` 让 hostd 启动的 pi 退出，tmux 窗口关闭。

### M5b 子 agent 与 team 成员

任务：7.6.1、7.6.2（bridge 的 role、childSessionFiles，组件 widget 转文本；hostd 的 links）。

验收（在已安装 pi-interactive-subagents 的 pi 中）：
1. 让主 pi 用 `subagent` 工具启动一个子 agent：`dev-client procs` 中出现子进程，`role.kind === "subagent"`、`name` 正确，`parentProcessId` 等于主进程的 processId；主进程的 `childSessionFiles` 含子进程的 sessionFile。
2. 主进程 watch 中出现 `ext_widget{key:"subagent-status"}`，`lines` 是可读文本（无 ANSI 转义），内容与电脑上的状态面板一致；子进程运行期间每 2 秒内容会更新（例如运行时长）；子 agent 结束后收到 `lines` 为空的 `ext_widget`。
3. 子 agent 自动退出后：子进程 `proc down`；主进程 watch 出现 `message_end`，其中 `role:"custom"`、`customType:"subagent_result"`、`details.sessionFile` 存在；对该文件 `read_session` 能读出子 agent 的完整对话。
4. 用 `subagent_resume` 恢复该子 agent：新子进程的 `parentProcessId` 仍指向主进程（来自 `details.sessionPath`）。
5. 让主 pi 用 `team_spawn` 加入一个成员：成员进程 `role.kind === "team_member"`，`leadPid` 等于主进程 pid，`parentProcessId` 正确；主进程 watch 出现 `ext_widget{key:"team-status"}` 文本；成员进程 watch 出现 `ext_widget{key:"team-member"}`。
6. 对子进程 `prompt` 一句话：电脑上该子 agent 的 tmux pane 中出现这条消息并回答。
7. 重启 hostd：子进程重新出现后 `parentProcessId` 恢复正确。

### M6 网络：中继、VPS、迁移

任务：7.4 全部；hostd 的 relay-client（7.2.6）；dev-client 支持 `--via relay`；7.2.4 中的 `relay`、`qr`、`export`、`import` 命令；用户按 5.2 部署 VPS；安装 7.2.14 服务。

验收：
1. 先在本机跑中继（`RELAY_SECRET=dev node packages/relay/src/main.ts`），`relay set ws://127.0.0.1:7443 --secret dev`：`relay show` 显示 `connected`；`dev-client --via relay procs` 成功。
2. 用错误的 secret：`relay show` 显示 `auth_failed`。hostd 停止时，`dev-client --via relay procs` 收到 `CLOSE.HOST_OFFLINE`。
3. 部署到 VPS 后 `relay set ws://<VPS>:7443 --secret <S>`（不重启 hostd），5 秒内 `relay show` 为 `connected`。在**另一个网络**（如手机热点下的另一台电脑）用 dev-client 经中继访问成功。
4. 经中继运行 `dev-client --via relay --dump-wire procs`：除握手帧外全是密文；`ssh TencentVPS 'docker logs pi-relay'` 中只有连接事件，没有任何帧内容。
5. VPS 上 `docker restart pi-relay`（或 `systemctl restart pi-relay`）：hostd 与 dev-client listen 在 30 秒内自动恢复。
6. 本机断网 1 分钟再恢复，`relay show` 自动回到 `connected`。
7. 迁移演练（换 VPS）：在第二个地址（可以是本机另一个端口的中继）`relay set` 切换；dev-client 只改 dev-client.json 的 `endpoint.relays` 即可继续使用，无需重新配对。
8. 迁移演练（换电脑）：`pi-hostd export /tmp/x.json`；`mv ~/.config/pi-remote ~/.config/pi-remote.bak`；`pi-hostd import /tmp/x.json`；重启 hostd；dev-client 不改任何配置即可连接。最后删除 /tmp/x.json，恢复或保留目录均可。
9. `systemctl --user status pi-hostd` 为 active。

### M7 Android App

按顺序做。每个子里程碑先在 Waydroid 上按 5.3 的方法自动验收；下表中 Waydroid 无法覆盖的项目记为"真机项"，全部子里程碑完成后统一进入人工检查点，交给用户在真机上验收。

| 验收内容 | Waydroid | 真机 |
|---|---|---|
| 页面功能、消息收发、确认框、问卷、原生命令、子 agent 显示、设置页、图片发送（用 `adb push` 放一张图到相册后选择） | ✓ | 抽查 |
| 经中继 / 直连连接、断线重连（在服务端模拟：重启 hostd、`docker restart pi-relay`；Waydroid 的飞行模式断不了网） | ✓ | ✓ |
| 文字输入（含中文内容） | ✓（测试钩子 `piremote://test/type`） | 真机项：用真实输入法打字 |
| 通知内容、前台服务存在 | ✓（`dumpsys notification` / `dumpsys activity services`） | ✓ |
| 扫描二维码配对、扫描连接信息二维码 | ✗（用深链接代替） | 真机项 |
| 锁屏 30 分钟后的通知、点击通知跳转、电池优化设置 | 仅用 `deviceidle force-idle` 冒烟 | 真机项 |
| Wi-Fi ↔ 移动数据切换 | ✗ | 真机项 |
| 语音输入法 | ✗ | 真机项 |

- **M7a 脚手架**：完成 5.3 第 1～3 步与第 7 条的测试钩子框架（`src/lib/test-hooks.ts`、深链接注册、`PIREMOTE_TEST` 输出）；7.3.1～7.3.5，App 在 Waydroid 中能启动并显示空白首页；prebuild 后检查 `AndroidManifest.xml` 含 `usesCleartextTraffic="true"` 和前台服务声明。在任意页面临时调用一次 `openSecure` 连本机直连地址，握手成功（验证加密库在 RN 中可用），然后删掉临时代码。
- **M7b 配对与连接**：pair.tsx、credentials、secure-ws、endpoints、pairing、connection（含心跳、重连）。验收：经 VPS 中继扫码配对成功；同一 Wi-Fi 下开启直连后首页显示"直连"，离开 Wi-Fi 后自动切到"经中继"；关闭 hostd 时首页显示"重连中"，恢复后自动变绿；飞行模式开关后自动重连。
- **M7c 首页**：在线进程、项目、会话、打开/新建（含 TrustDialog）。验收：从手机打开一个没有进程在运行的旧会话，进入会话页能看到历史。
- **M7d 会话页**：view-reducer、Transcript、ToolCallCard、PatchView、Composer（文本、steer/followUp、停止）。验收：手机发消息，电脑 TUI 同步；电脑输入，手机同步；长输出流畅（一次回答 2000 字以上不卡顿）；edit 工具的 diff 有颜色；断网 30 秒后恢复，消息不丢不重。
- **M7e 对话框与问卷**：UiRequestCard、RpivSheet。按 M4 验收第 2、3、5、6、7 条在手机上复做。
- **M7f 原生命令**：slash.ts 与所有 Sheet、settings.tsx。按 M5 验收第 1～7、12 条在手机上复做；`/copy`、`/session`、`/name` 可用；`/hotkeys` 提示仅电脑端。
- **M7g 图片**：选择图片发送，支持图片的模型能描述图片内容；切到纯文本模型后按钮置灰。
- **M7h 后台与通知**：前台服务、事件通知、点击跳转。验收：App 切后台、锁屏 30 分钟后，让电脑上的 pi 跑一个任务，完成时手机收到"已完成"通知；需要确认时收到"需要确认"通知，点击直接进入该会话并看到确认卡片；常驻通知文字随状态变化。
- **M7i 子 agent 与 team**：7.6.3～7.6.6。按 M5b 验收第 1～6 条在手机上复做：首页树形显示、父项汇总、ChildStrip 跳转、子进程页角色信息与"↑ 父进程"链接、状态面板文本、`subagent_result` / `subagent_ping` / `team_message` 卡片、只读历史页。
- **M7j 连接设置与迁移**：7.3.14"连接"部分。验收：在设置里把中继地址改成第二个中继后自动重连成功；"测试连接"逐条显示结果；扫描 `pi-hostd qr` 更新地址成功；扫描另一台电脑的二维码被拒绝；按 M6 第 8 条换电脑演练后手机无需操作即可连接。

### M8 收尾与加固

- 审计日志内容抽查（应包含 M5～M7 的操作）。
- hostd 启动时 `pi --version` 与 SDK 版本比较的告警。
- 清理 7 天前的 bridge 日志。
- 在**项目根目录**（`extensions/pi-remote/`）的 `README.md` 写安装与运维步骤（第 8 章与 7.5 的内容 + 故障排查：`relay show` 各状态的含义、握手失败、spawn_timeout 的查看方法、吊销设备）。不要改动仓库根目录的 README.md。
- 全量跑第 10 章端到端清单。

---

## 10. 端到端验收清单（M8 必须全部通过）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 电脑 tmux 中正在用 pi，手机打开该会话 | 手机显示完整历史，状态一致 |
| 2 | 手机发消息，电脑同时在看 | 电脑 TUI 显示用户消息和流式回答 |
| 3 | 电脑输入，手机在看 | 手机实时显示 |
| 4 | 运行中手机插话 / 排队 / 停止 | 行为与电脑上相同 |
| 5 | 扩展弹出 select，手机回答 | 电脑对话框消失，结果生效 |
| 6 | 扩展弹出 select，电脑回答 | 手机卡片消失 |
| 7 | ask_user_question 两题 | 手机原生问卷提交后，模型收到答案 |
| 8 | 自定义 TUI 组件 | 手机显示"需在电脑上操作"并可取消 |
| 9 | /model、/thinking 切换 | 电脑状态栏同步 |
| 10 | /tree 跳转、/fork、/clone、/new、/resume、/compact、/name、/reload | 均与电脑上执行效果一致 |
| 11 | /settings 修改 hideThinkingBlock | settings.json 只改该字段；在线进程空闲时 reload |
| 12 | 电脑上没有任何 pi，手机打开旧会话 | 45 秒内可用；电脑 `tmux attach -t pi-remote` 可接手 |
| 13 | 手机新建会话（选择项目 + 信任） | 可用 |
| 14 | 手机锁屏 30 分钟后任务完成 | 收到通知，点击进入 |
| 15 | 手机网络切换（Wi-Fi ↔ 移动数据） | 自动重连，无丢失、无重复消息 |
| 16 | hostd 重启 | 手机自动重连，所有进程重新出现，processId 不变 |
| 17 | 吊销手机设备 | 手机立即断开并回到配对页 |
| 18 | VPS 抓包 | 无明文 |
| 19 | 主 pi 启动子 agent | 手机首页显示在主进程下方；进入后可发消息、停止；主进程页显示状态面板文本 |
| 20 | 子 agent 结束 | 主进程页出现"子 agent 已结束"卡片，"查看子 agent 记录"打开只读历史 |
| 21 | 子 agent 请求协助 / 需要确认 | 手机收到通知，卡片可跳转 |
| 22 | team 成员 | 显示在负责人下方，带成员名与写入分支；team 消息以列表卡片显示 |
| 23 | 图片消息 | 支持图片的模型正确识别 |
| 24 | 换 VPS | 电脑 `relay set` + 手机改地址后恢复，无需重新配对 |
| 25 | 换电脑（export/import） | 手机无需操作即可连接 |
| 26 | 同一局域网 | 走直连；离开局域网自动走中继 |

---

## 11. 已知限制与风险

| 项 | 说明 | 处理 |
|---|---|---|
| UI 包装依赖 pi 内部结构 | `ctx.ui` 是 `runner.uiContext` 同一个对象（附录 A-6）。pi 升级可能改变 | D15 版本锁；升级 pi 后先在 M4 验收第 2、3、6 条上回归，通过后再把新版本加入 `SUPPORTED_PI_VERSIONS` |
| 隐藏命令出现在本地自动补全中 | `/pi-remote-op` 会被 TUI 列出 | 描述写明"internal"；手动执行只会提示 unknown op |
| editor 对话框（D13） | 手机先答时本地编辑框残留 | 接受 |
| custom 组件只能取消 | 无法远程操作扩展自绘界面 | D12；需要时为具体扩展单独做适配（参照 rpiv 方式） |
| reload 会在电脑 TUI 中显示 | 修改设置后在线进程 reload | 接受；设置页已提示 |
| 守护进程启动的 pi 依赖 zsh 配置 | `zsh -lic` 加载 zshrc；若 zshrc 在非 tmux 时自动 exec tmux，已在 tmux 中不受影响 | spawn_timeout 的错误信息包含 pane 输出，便于排查 |
| 会话文件无锁 | 若用户在 tmux 外另开 pi 打开同一会话文件，仍可能冲突 | hostd 只在注册表中查重；文档提醒用户本地也通过手机列表或 `tmux attach` 接手 |
| Android 厂商后台限制 | 部分 ROM 仍会杀前台服务 | 设置页提供电池优化入口；前台恢复时立即重连 |
| 工具无审批（D9） | 手机发出的指令以本机用户权限执行 | 设备吊销、审计日志；配对码只在执行 `pi-hostd pair` 后 10 分钟内有效 |
| 加密库是第三方 0.x 版本 | `@getpaseo/relay` 的 API 可能变化；npm 包未声明 license 字段（源码仓库为 Apache-2.0） | 精确锁定 0.15.3；只用 `e2ee` 子路径的 5 个函数；若以后需要替换，只影响 hostd `secure-socket.ts`、App `secure-ws.ts`、dev-client 三处 |
| 中继元数据可见 | 中继能看到 hostId、IP、时间、流量大小 | 需要时在中继前加 TLS 反代并使用 `wss://` |
| 同一身份两台 hostd | 换电脑后旧电脑的 hostd 仍运行时，两者在中继上互相顶替 | 7.5 要求停掉旧 hostd；`relay show` 频繁出现重连时检查这一点 |
| 子 agent 父子关系推导 | 依赖 pi-interactive-subagents 的环境变量和工具结果字段（附录 A-20～A-23）；该扩展改动后可能失效 | 失效时子进程仍显示，只是作为顶层并带角色徽标；M5b 验收覆盖 |
| 组件 widget 转文本 | 依赖组件只用 `theme` 而不依赖真实 TUI | 渲染失败的 widget 不显示，不影响其他功能 |

---

## 附录 A：本方案依据的 pi 1.5.0 事实

路径前缀 `P = /usr/lib/node_modules/pi/packages/coding-agent`。

| # | 事实 | 出处 |
|---|---|---|
| A-1 | RPC 模式下 `custom()` 返回 undefined，多个 TUI 方法无效 | `P/docs/rpc-extension-ui.md` Limitations |
| A-2 | `ui_prompt_start/end` 事件覆盖 select/confirm/input/editor/custom | `P/docs/extensions.md` 697 行起 |
| A-3 | `sendUserMessage` → `prompt()`；`expandPromptTemplates` 为真且文本以 `/` 开头时，先于流式检查执行扩展命令，命令拿到 `createCommandContext()` | `P/dist/core/agent-session.js` 1654～1725、1928～1955 行 |
| A-4 | `ExtensionCommandContext` 提供 `waitForIdle/newSession/fork/navigateTree/switchSession/reload`；`fork` 的 `position: "before" \| "at"` | `P/dist/core/extensions/types.d.ts` 305～345 行；`P/docs/extensions.md` 1381 行起 |
| A-5 | 会话 JSONL 没有文件锁（`proper-lockfile` 只用于 settings/auth/trust） | 在 `P/dist` 中检索 lockfile 的结果 |
| A-6 | `setUIContext` 用 `wrapUIPromptContext` 生成新对象并存为 `runner.uiContext`；`ctx.ui` getter 每次返回该对象；对话框 opts 支持 `signal`；`editor(title, prefill)` 无 opts | `P/dist/core/extensions/runner.js` 355～367、612～621 行；bundle `P/dist/bundle/chunks/chunk-44DLKSKE.js` 中同样实现；`types.d.ts` 40～45、83～158 行 |
| A-7 | 事件处理函数被逐个 `await`；`message_end` 等返回值会改写行为 | 同上 bundle 中 `emit`、`emitMessageEnd` 实现 |
| A-8 | 会话替换后旧 `pi`/`ctx` 失效；后台资源应在 `session_start` 后启动 | `P/docs/extensions.md` 252、1469 行起 |
| A-9 | `SettingsManager.create(cwd, agentDir)`；setter 列表；持久化时在锁内按被修改字段合并 | `P/dist/core/settings-manager.d.ts`；`settings-manager.js` 440～470 行 |
| A-10 | edit 工具参数 `{path, edits:[{oldText,newText}]}`，结果 details 含 `diff`、`patch` | `P/dist/core/tools/edit.d.ts` |
| A-11 | `SessionManager.listAll()`、`getTree()`、`getBranch()`、`getLeafId()` 等 | `P/dist/core/session-manager.d.ts` 243～421 行 |
| A-12 | `--approve` / `--no-approve` 覆盖项目信任决策 | `P/docs/security.md` "How Pi chooses a trust decision"；`pi --help` |
| A-13 | 内置斜杠命令列表：bug changelog clone compact copy export fork hotkeys import login logout model name new quit reload resume scoped-models session settings share thinking tree trust | `P/dist/core/slash-commands.js` |
| A-14 | 从本机安装路径导入非 bundle 的 SDK 失败（缺 `@earendil-works/pi-schema`） | 实测 `node -e 'import(".../coding-agent/dist/index.js")'` |
| A-15 | `getSupportedThinkingLevels(model)` 由 `@earendil-works/pi-ai` 导出 | `/usr/lib/node_modules/pi/packages/ai/dist/models.d.ts` 271 行 |
| A-16 | 流式事件格式：`message_update` 的 `assistantMessageEvent` 类型与字段 | `P/docs/json.md` "Reconstruct streaming messages" |
| A-17 | ask_user_question 事件协议：prompt / blocked / answer / answer-result；先答者生效 | `~/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/docs/tool-schema.md` |
| A-18 | Android 15 起 `dataSync` 前台服务 24 小时内限 6 小时；`specialUse`、`remoteMessaging` 等类型无此限制 | developer.android.com "Foreground service timeouts"、"Foreground service types" |
| A-19 | Notifee 于 2026-04 归档，推荐 `react-native-notify-kit`（新架构、支持 Expo prebuild、前台服务） | github.com/invertase/notifee、github.com/marcocrupi/react-native-notify-kit |
| A-20 | 子 agent 启动时的环境变量：`PI_SUBAGENT_NAME`、`PI_SUBAGENT_AGENT`、`PI_SUBAGENT_AUTO_EXIT`、`PI_SUBAGENT_SESSION`、`PI_SUBAGENT_ID` 等；team 成员：`PI_TEAM_RUN_DIR`、`PI_TEAM_MEMBER_ID`、`PI_TEAM_MEMBER_NAME`、`PI_TEAM_AGENT`、`PI_TEAM_LEAD_PID`、`PI_TEAM_SESSION_FILE`、`PI_TEAM_WRITE`、`PI_TEAM_WORKTREE`、`PI_TEAM_BRANCH` | `extensions/pi-interactive-subagents/pi-extension/subagents/index.ts` 1140～1152 行；`team/lead.ts` 685～697 行 |
| A-21 | `subagent` 工具结果 `details` 含 `id/name/task/agent/sessionFile`；`subagent_resume` 含 `sessionPath` | `subagents/index.ts` 1568～1576、1991～1997 行 |
| A-22 | 自定义消息：`subagent_result`（details: name/task/agent/exitCode/elapsed/sessionFile/errorMessage）、`subagent_ping`（name/message/agent/sessionFile）、`subagent_status`（lines/overflow）、`team_message`（ids/items[{from,kind,status,body,spillPath}]）、`team_notice`、`subagent_model_fallback` | `subagents/index.ts` 863～870、1505～1550 行；`team/member.ts` 208～219 行；`team/lead.ts` 211、327～335 行；`team/constants.ts` |
| A-23 | 状态面板用组件工厂调用 `setWidget`：`subagent-status`、`team-status`、`team-member`、`subagent-tools`，工厂忽略 `tui` 参数，只用 `theme` | `subagents/index.ts` 610～637 行；`team/lead.ts` 240～256 行；`team/member.ts` 100～118 行；`subagents/subagent-done.ts` 103 行起 |
| A-24 | `SessionManager.open` 加载旧版本文件时会迁移并重写文件；加载后叶子为文件中最后一个条目 | `P/dist/core/session-manager.js` 718～742 行 |
| A-25 | `@getpaseo/relay@0.15.3` 的 `e2ee` 子路径导出 `openClientSecureChannel`、`openDaemonSecureChannel`、密钥生成与序列化函数；依赖 tweetnacl、@noble/*、base64-js，需要 `crypto.getRandomValues` 与 `TextEncoder`/`TextDecoder` | 本机 `npm pack` 后检查 `dist/e2ee.d.ts`、`dist/secure-channel.d.ts`、`dist/crypto.js` |
