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

## M7 实测与偏差

20. App：Expo SDK 58、React Native 0.88.1、React 19.3，新架构。App 不加入 npm workspaces，protocol 通过 `file:../../packages/protocol` 链接，metro 的 watchFolders 指向它。
21. `react-native-markdown-display` 依赖的 markdown-it 需要 `punycode`，额外安装了用户态包 `punycode@2`。
22. Hermes 的 TextDecoder 不一定支持 `fatal`，加了 `src/lib/text-polyfill.js`（无依赖）。
23. Android 边到边显示：输入栏、底部弹层加了安全区底部内边距，否则会被系统导航栏挡住。
24. 消息列表改成倒置 FlatList（最新消息在 offset 0），普通 FlatList 的 scrollToEnd 在虚拟化下到不了底。
25. 测试钩子额外加了 `piremote://test/press?label=`、`piremote://test/labels`：run-timer 每秒刷新状态行，界面一直不空闲，uiautomator dump 会一直等待；测试构建里转圈动画换成静态的"…"。这些只在 `EXPO_PUBLIC_TEST_HOOKS=1` 时生效。
26. Waydroid 上已通过的验收：e2ee 握手与深链接配对、直连与中继切换、hostd 停止/恢复与中继重启后自动重连、首页打开旧会话（信任对话框）、手机发消息与电脑同步、流式输出、插话/排队/停止、edit diff 着色、hostd 停 30 秒后消息不丢不重（快照对比 seq 与条数一致）、select/input 对话框双向、ask_user_question 问卷。
27. 未在 Waydroid 上验收（功能已实现）：M7e 第 7 条 custom 取消、M7f 原生命令与设置页、M7g 图片、M7h 通知与前台服务、M7i 子 agent/team 界面、M7j 连接设置与迁移；M8 的 README 未写。

## UI 重做（分支 `pi-remote-ui-redesign`，worktree `~/.cache/pi-remote-dev/ui`）

28. 视觉："Folio" 编辑排版风格：衬线大标题（Instrument Serif，含斜体）、Space Grotesk 正文、JetBrains Mono 元信息。不用卡片、阴影和圆角，层级只靠字号、发丝线和左侧页边栏（编号、`you` / `pi` / `§` 标签都挂在页边栏）。只有两种强调色：粉色表示"等你处理"，蓝色表示"正在工作"。字体文件在 `apps/mobile/assets/fonts/`（均为 OFL 授权），用 `expo-font` 的 `useFonts` 运行时加载。
29. 交互逻辑重排：
    - 首页依次为"等你处理"、"电脑上正在运行的"（带父子缩进）、"最近会话"（跨项目、可搜索、按目录筛选）；底部固定"Start a new session"。
    - 新会话页把"在哪个目录"和"是否信任"两步放在同一页，不再弹信任框。
    - 会话页把模型、思考级别、上下文放成可点击的文字行；所有命令集中在"Commands"页，按用途分组（"How pi thinks"、"Move through the conversation"、"Sessions"、"Utilities"），另附扩展命令；"/" 斜杠命令仍然可用。
    - 对话框和问卷固定显示在输入栏上方的粉色区域，不会被忽略。
    - 运行中改为"send now / send after / stop"，取代原来的"steer / queue"。
30. 新增 Web 构建，用于设计预览和浏览器直接使用：`*.web.ts` 替换了安全存储（改用 localStorage）、前台服务和通知。启动方式：`EXPO_PUBLIC_TEST_HOOKS=1 npx expo start --web --port 8090`。为此新配对了一台 Web 设备，`devices.json` 中会多出一项。
31. **验收 D-A8 的修复**（问卷对应的 custom() 卡片偶尔单独显示）：原因不只是 2 秒时间窗。rpiv-ask-user-question 在内联位置被让出时会重新 mount 一次 custom()（`ask-user-question.ts` 397–402 行，STACKED_OVERLAY），第二次 mount 可能发生在问卷事件很久之后。现在的规则：custom() 打开时，只要有仍在打开的问卷，就归到最近打开的那个，不设时间窗；反过来，custom() 先于问卷事件 3 秒内打开的，会在问卷事件到达时补上 `coveredBy` 并重新发送 `ui_request`。已在运行的 pi 需要 `/reload` 或重启后才会加载新 bridge。
32. Markdown 改为自己用 markdown-it 渲染（不再依赖 react-native-markdown-display），支持 `$…$`、`$$…$$`、`\(…\)`、`\[…\]` 公式：手机上没有排版引擎，公式转成 Unicode（`src/lib/latex.ts`：希腊字母和运算符、上下标、`\frac`→a/b、`\sqrt`→√、`\mathbb`→ℝ 等）。复杂公式（矩阵、多行对齐）只能近似显示。
33. **中文排版**：拉丁字体（Instrument Serif / Space Grotesk）没有中文字形，以前中文一律回退到系统黑体常规体。现在打包了思源宋体（Regular、Bold）和思源黑体（Regular、Medium、Bold），用 pyftsubset 按 GB2312 全部 7730 字加中英标点子集化，5 个文件共 9.2MB（OFL）。`Txt` 和 Markdown 段落检测到中文时整段换用中文字体：
    - 标题用宋体粗体，引用和用户消息用宋体，正文用黑体，强调用加粗黑体；
    - 中文没有斜体，原来的斜体强调改用宋体；
    - 行高约 1.7，去掉字距和全大写；
    - GB2312 以外的生僻字回退到系统字体。
34. **关键信息**：
    - 首页：连接状态单独一行，用颜色区分（绿＝已连接，粉＝离线并显示原因和"retry now"）；下面三个大数字：运行中进程、正在工作的进程、等你处理的进程。删掉了原来夹着一句话的两条分隔线。
    - 会话页：顶部改为"模型 / 思考 / 上下文"三栏，每栏有标题、值和副信息，上下文带进度条（>50% 粉、>80% 红）；标题下的分隔线随状态变色（蓝＝工作中，粉＝等你）。
35. **控件分级**：按钮分为四级（实心、危险、描边、文字）。
    - 用危险按钮：Unpair（单独放在 "danger zone"）、退出 pi、停止运行（运行时输入框右侧出现红色方块按钮）。
    - 信任对话框把"安全模式"设为主按钮，"信任"改为红色描边按钮。
    - 开关改成 on/off 两格；设置里未设置的布尔项显示 "default"，不再显示成 off，因为 pi 各项默认值不同，例如自动压缩默认是开启的。
    - 筛选项改为可填充的标签。
    - 扩展面板默认折叠，只有子 agent 或 team 面板默认展开。
36. **团队/子代理层级丢失两处原因**：
    - 手机端：打开子会话时，`subscribe` 返回的快照信息（bridge 生成，没有 `parentProcessId`，该字段由 hostd 推导）会整体覆盖进程列表里的条目，子代理就脱离了树；之后发一条消息，hostd 重新广播才恢复。现在 hostd 在快照里补上父进程，手机端合并时也保留已有的父链接，会话页的"started by"取自进程列表。
    - 单次子代理：父链接靠父进程记住 `subagent` 工具结果里的 `sessionFile`。模型经 `codemode` 调用 `subagent` 时，工具结果只有 `calls` 摘要，没有 sessionFile，父子无法关联（实测复现）。现在 bridge 从 `PI_SUBAGENT_ACTIVITY_FILE`（路径含 `artifacts/<父会话 id>/`）解析 `role.parentSessionId`，hostd 在原有规则找不到时按父会话 id 匹配。
    - `links.ts` 的 realpath 缓存不再缓存失败结果（子会话文件刚启动时尚不存在）。
37. **上下文用量**：以前只在 `agent_settled` 和压缩后发送 `context_usage`，长时间运行期间手机上一直显示压缩后的 "?"，而 TUI 页脚每次重绘都重新读取。现在在每个 `turn_end`（助手消息和工具结果都已写入会话后）也发送。数值未知时显示 "?"，并注明"known after the next reply"。
38. **排队中的消息**：运行中发送（steer / follow-up）的消息，pi 在取走之前不会发任何事件，手机上看不到。现在发送时先显示为"queued"项（附发送方式和说明），pi 报告同文本的 user 消息后移除；run 结束（`agent_settled`）、会话切换或发送失败时清除。
39. **草稿**：未发送的文字按会话 id 保存（内存立即恢复，写入 key store 防抖落盘），离开页面或关闭 App 后回来可继续编辑；发送后清空。
40. **会话页**：
    - 顶部三栏的副信息改为轮播（每 3.2 秒滑动一行，测试构建不轮播）：模型（服务商、完整 id、图像支持、推理模型、窗口大小）、思考（等级）、上下文（已用/剩余）。
    - 思考档位 off / minimal / low / medium / high / xhigh 各有颜色，并有 6 格档位条。
    - 子代理 / team 面板改为输入框上方的 `CrewTray`（每人一张卡：状态、名字、agent、worktree/read-only、模型、上下文条，点击进入），数据来自进程列表，team 和单次子代理通用；扩展输出的方框字符横幅（`subagent-status`、`team-status`、`team-member`）不再显示。
    - 运行中的输入栏改为一条描边条：左侧红色 STOP，中间 working，右侧 send now / send after；输入框左侧的 "/" 与 "+" 垂直居中。
41. **首页**：顶部两行（左标题、右三个数字；下一行连接状态和 settings）。"Live on the computer" 用蓝色，"Recent sessions" 用灰色。
42. **输入栏**：
    - 上一版给多行 `TextInput` 加了 `numberOfLines={1}`，在 Android 上把输入框固定成了一行，已去掉。现在输入框行高 24，最多显示 8 行，再多就在框内滚动；网页版按内容高度设置。
    - 输入框左侧的 "/" 和 "+" 原来用字形画，字体上下留白不对称导致偏移，现在改用 View 画，放在与单行输入同高的盒子里垂直居中。
    - 运行中把两类控件分开：输入栏上方的运行状态行（"pi is working" 和红色描边 stop）作用于这次运行；输入框上方的 "deliver now / after" 是这条消息的属性，发送按钮下方会显示当前选择。
43. **会话页顶部**：三栏副信息和扩展状态行改为可左右滑动的一行，不再自动轮播；模型名过长时缩小字号。首页标题显示为 "pi/remote"，过窄时自动缩小。
44. **首页标题看不到 "remote"**：原来用嵌套 Text，并受系统字体缩放影响。手机字体调大时，整行超宽，"remote" 被挤出可见区域；Android 上 `adjustsFontSizeToFit` 也不会缩小自带字号的嵌套片段。现在改为三个并列的 Text，不随系统字体缩放（`allowFontScaling={false}`），字号按标题实际可用宽度计算（24–46）。右侧三个数字同样不随系统字体缩放。
45. **顶部三栏无法横向滑动**：原来整格是一个 Pressable，手势先被识别为点击。现在只有标题和值可以点击，副信息行是同级的横向 ScrollView，可以滑动。
46. **展开/收起时视图跳动**：对话列表是倒置 FlatList，行变高时默认保持底边不动、向上长；在顶部收起长内容时，下边缘不动，读者会被甩到别处。现在每行外面包一层 `Anchored`，记住行高，并在展开或收起时补偿滚动位置：
    - 点标题或"show all"：保持顶边不动，向下展开；
    - 已展开内容末尾新增 "− fold"：保持底边不动，收起后读者停在折叠后的那一行。
    - 工具调用、思考块、压缩/分支摘要、扩展消息的"read all"都已改用这套逻辑。
47. **流式输出时不打扰阅读**：`maintainVisibleContentPosition.minIndexForVisible` 由 0 改为"仍在增长的行数"（正在写的回答、运行中的工具、排队消息）。用户向上滑动后，系统以最近一条不再增长的行为锚点，回答在其下方增长，正在读的内容不动；用户在底部（40px 内）时仍然自动跟随。这些仍在增长的行在 Android 上由该机制保持顶边不动，`Anchored` 不再重复补偿。
48. **Spinner 改为三个固定尺寸的圆点**：原来的文字帧 `"·  " … "   "` 宽度逐帧变化，在工具调用 16px 宽的列里会折成两行，导致整个列表上下跳动。
