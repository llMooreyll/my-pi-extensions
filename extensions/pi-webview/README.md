# pi-webview

Pi Coding Agent 的浏览器阅读与提问扩展。在浏览器中打开 md、html、pdf、pptx、docx 等文件，选中内容或点选元素后，把位置和上下文发给当前 pi 会话；回复直接显示在页面上。

扩展在 pi 进程内启动一个只监听 `127.0.0.1` 的本地网页服务，不需要安装浏览器扩展。

另有一套独立的视频学习功能（见[视频学习](#视频学习)）：通过 DevTools 协议接管浏览器里的 YouTube、Bilibili 视频标签页，用本地字幕文件替换网站字幕，在侧栏中浏览字幕、针对任意一句提问，并把课程、集数和播放时间发给 pi。

## 功能

1. **文档查看**：
   - md：服务端渲染，支持 KaTeX 公式、代码高亮、表格和任务列表。左侧显示目录，每个块对应源文件的行号。
   - html：原样提供页面并注入提问工具层，页面内的相对资源正常加载。
   - pdf：使用 pdf.js 渲染，带文本层，可以选中文字。
   - pptx、ppt、odp、docx、doc、odt、rtf：用 LibreOffice 转成 PDF 后显示。
   - 文件保存后页面自动更新。md 原位重新渲染，改动的块短暂高亮。
2. **提问**：
   - 选中文字后出现 `Ask / Pin` 标签。Ask 打开提问卡，输入问题后发给 pi；pi 正在工作时，问题排在当前任务之后。
   - 提问卡可以跟随选区滚动，也可以固定在屏幕上；拖动标题栏可以移动卡片。
   - PDF 可以框选区域提问，附带区域截图。
   - HTML 页面可以按住 Alt 点击元素提问，附带 CSS 选择器和 outerHTML。
3. **钉住引用**：
   - Pin 只保存引用，不立即发送。钉住的引用随下一条消息一起发出，这条消息可以在页面面板里输入，也可以在 pi 终端里输入。
   - 面板的 Pins 页可以查看、删除钉住的引用，并编辑每条引用附带的指令。
   - pi 终端编辑器上方显示待发送的引用列表。
   - 钉住的引用保存在会话里，关闭页面、`/reload`、重启 pi 后仍在；用 `/tree` 切换分支或 `/resume` 切换会话时，显示对应分支的引用。
4. **页面上的回复与连续追问**：
   - 提问过的位置显示橙色标记 `◉ n`，钉住的位置显示蓝色标记 `◆`，对应文字带高亮。
   - 点击 `◉` 在原处展开该位置的所有问答，回复实时流式显示，运行中的工具显示在回复下方；每条问答带有会话轮次标号 `#N`（追问附带 `↳ #M`）。
   - 抽屉底部保留追问输入框，可直接输入或按 `Enter` 继续针对同一位置追问；追问会自动重新附带 `<browser-context>`（不复传截图）以及上一轮问答的 `<follow-up>` 引用。
   - 右下角 `✦` 打开面板，Wire 页列出当前会话的全部问答，可按来源筛选，也可以直接给 pi 发消息。
   - 恢复会话后，扩展从会话记录重建问答，页面标记与轮次标号重新出现。
5. **语音输入（ASR）**：
   - 提问卡、抽屉追问框与面板输入框均提供 `🎙` 麦克风按钮，点击开始录音、再次点击停止并将识别文本填入输入框。
   - 音频通过本地 `/asr` 接口转发给同一 Pi 进程内的 `pi-voice` 系统 ASR 服务，使用用户在 `~/.pi/agent/pi-voice.json` 配置的本地模型（音频容器解码需要 `ffmpeg`）。

## 视频学习

视频功能与文档查看互不依赖，只共用会话问答的推导。pi 通过 Chrome DevTools 协议（CDP）连接一个开启了远程调试端口的 Chromium 系浏览器（默认 `http://127.0.0.1:9444`），在视频页面的隔离 JS 环境里注入侧栏，不需要浏览器扩展，也不嵌入播放器。

1. **接管视频**：
   - `/watch <链接>` 打开视频；浏览器里已有同一视频、且不属于其他 pi 会话的标签页时直接接管，否则新开标签页。支持 `youtu.be` 短链和裸 BV 号。
   - `/watch` 不带参数时列出浏览器中已打开、不属于其他 pi 会话的视频标签页供选择，只有一个时直接接管。
   - 接管后页面右侧（或左侧）出现 pi 侧栏。一个标签页只属于一个 pi 会话，见[视频页面的生命周期](#视频页面的生命周期)。
2. **课程信息**：从页面数据读取，不需要配置。
   - YouTube：播放列表标题作为课程名，列表中的序号作为集数，视频标题作为本集标题。没有播放列表时只有视频标题。
   - Bilibili：多 P 视频以主标题为课程名、P 号为集数、分 P 标题为本集标题；合集视频以合集标题为课程名、合集中的序号为集数。
   - 站内跳转到下一集、切换分 P 时自动更新。
3. **字幕**：只显示你准备好的本地文件（`.srt`、`.vtt`、`.ass`、`.ssa`），不做断句或其他处理。
   - 侧栏的 `CC` 按钮按目录树列出 pi 工作目录下（8 层以内）的字幕文件，可以模糊搜索，点选即替换；也可以在 pi 中执行 `/watch sub [文件]`。
   - 文件名包含视频 ID（YouTube 视频 ID 或 BV 号；多 P 视频还需包含 `p3` 这样的 P 号）时自动选用。手动选过的文件按视频记在当前 pi 会话里。
   - 显示本地字幕时隐藏网站自带的字幕；字幕文件保存后侧栏自动刷新。
   - 编码：UTF-8、带字节序标记的 UTF-16，以及 GBK / GB18030。
   - 双语字幕：同一条字幕里的多行原样分行显示；时间完全相同的多条字幕（双语 ASS 常把两种语言写成两条）合成一句，按文件中的顺序分行，同一时间的重复文字只保留一次。
   - 注音（ruby）：在字幕文字里用 WebVTT 的注音标记给词语加注释，注释显示在该词的正下方（或正上方），其余位置留空，适合只给关键词配中文。`.vtt`、`.srt`、`.ass` 都可以这样写：
     ```text
     The <ruby>depletion region<rt>耗尽区</rt></ruby> forms near the <ruby>junction<rt>结</rt></ruby>.
     ```
     一个 `<ruby>` 里可以有多组词和注释，`<rp>` 会被忽略。注释随侧栏、全屏转轮和画面字幕的折行一起移动，不靠空格对齐。发给模型和终端显示的文字写成 `depletion region (耗尽区)`。设置里的 `Annotations` 一组调整注释位置（下方或上方）、字号（正文的百分比）和不透明度。
4. **侧栏与画面字幕**：
   - 竖排列出全部字幕，当前句高亮并自动滚动跟随；手动滚动后停止跟随，点 `Back to current` 恢复。
   - 点击一句跳到该时间；在画面底部以侧栏的样式显示当前句（可关闭）。
   - 设置（`⚙`）：侧栏宽度、字号与行距，全屏字幕宽度（屏幕宽度的百分比）与字号，左右位置、深浅主题、挤压页面或浮在页面上、画面字幕（开关、字号、字重、背景深浅与模糊、文字阴影、圆角、离底部的高度、最大宽度，可一键恢复默认）、是否隐藏网站字幕、是否跟随播放、终端消息是否附带时间。也可以拖动侧栏内侧边缘调整宽度。设置是个人偏好，对所有网站和 pi 会话通用。
   - 全屏（或播放器占满窗口）时改为屏幕边缘的转轮字幕：每句按自身文字收窄并贴住屏幕边缘，当前句完整清晰；其余句子排在一个转轮上，离当前句越远越向后转、越靠拢、越小、越暗、越模糊。未悬停时只有文字所在的区域响应鼠标；鼠标移入后展开为普通列表，并显示底部输入框和右上角的按钮。当前句只用描边、光晕和大小突出，不改字重，所以变成当前句时不会重新折行。
   - 设置里的 `Fullscreen wheel` 一组调整转轮样式：转轮半径、向边缘弯曲的程度、与屏幕边缘的距离，其他句子的大小、亮度、不透明度和模糊，当前句的光晕和描边粗细，以及展开为列表时其他句子的不透明度；`Reset the wheel style` 恢复默认。全屏时打开设置，设置面板移到转轮旁边，转轮保持转轮形态，画面字幕也同时显示，调整即时可见。
5. **提问**：
   - 在字幕上按住拖动选中连续多句，或点每句末尾的圆形 `+` 按钮把它们加入选区（可连续追加或收窄范围）；在底部输入框输入问题后按 `Enter` 发送。没有选中字幕时，问题只附带当前播放时间。
   - 点输入框旁的相机按钮附带当前画面（同时暂停视频；当前模型支持图像时作为图片发送，否则附截图路径）。
   - 回答在输入框上方流式显示。问过的句子右侧有橙色圆点，滚动条上也会标出对应位置，点击重新打开那段问答并可继续追问；`Q&A` 页列出本视频的全部问答。问答属于 pi 会话，恢复会话后重新出现。
   - 在 pi 终端直接输入的消息也会附带当前课程和播放时间（最近 30 分钟内在看视频时；可在设置或用 `/watch auto off` 关闭）。

| 快捷键（视频页面中） | 说明 |
|---|---|
| `Alt+S` | 收起 / 展开侧栏 |
| `Alt+A` | 暂停并选中当前句，光标进入输入框 |
| `Alt+Q` | 在字幕和问答列表之间切换 |
| `Alt+↑` / `Alt+↓` | 跳到上一句 / 下一句 |
| `Alt+R` | 从头重播当前句 |
| `Enter` / `Shift+Enter`（输入框中） | 发送 / 换行 |
| `Esc`（输入框中） | 取消选中的字幕和追问对象 |

在侧栏输入框里打字不会触发网站的快捷键（如 YouTube 的 `k`、空格）。

发给模型的内容只有站点、视频 ID、课程名、集数、本集标题和时间；针对字幕提问时附带选中的字幕行。不发送资料路径，模型在工作目录中自行查找课程资料：

```text
<video-context site="youtube" video="youtube:6UNezo_GByE" course="Behzad Razavi - Electronics 1 Lectures" episode="4/45" episode-title="Razavi Electronics 1, Lec 4, PN Junction in Equilibrium & Reverse Bias" time="1:02">
<subtitle from="1:02" to="1:06">
[1:02] First, let's recall what happens when we dope silicon.
</subtitle>
</video-context>

explain this line
```

终端里折叠为一行：`▶ 课程 · E4/45 · 本集标题 @ 1:02 — “选中的字幕…”`。

## 命令与工具

| 命令 / 工具 | 说明 |
|---|---|
| `/view <文件>` | 在浏览器中打开文件 |
| `/view <文件>:<N>` | 打开并跳到第 N 行（md、html）或第 N 页（pdf、Office） |
| `/view <文件> --new` | 文件已在标签页中打开时，另开一个标签页 |
| `/view` | 打开文件选择器，选中的文件在浏览器中打开（需要同时启用 pi-input-plus 扩展；只列出支持的文件类型） |
| `/view-clear` | 清空钉住、尚未发送的引用 |
| `/view-stop` | 断开所有页面并关闭本地服务；钉住的引用和问答保留 |
| `view_open` 工具 | 模型调用，打开文件或跳到指定行、页 |
| `/watch [链接]` | 接管视频标签页并注入 pi 侧栏；不带链接时从已打开的视频标签页中选择 |
| `/watch sub [文件\|off]` | 为当前视频选择字幕文件（不带参数时打开文件选择器）或关闭字幕 |
| `/watch auto on\|off` | 终端消息是否附带当前课程和播放时间 |
| `/watch-close` | 关闭本会话的视频标签页（有多个时选择关闭哪个或全部） |
| `/watch-stop` | 从本会话的视频标签页移除侧栏并断开浏览器连接，标签页保留；`/watch off` 同义 |
| `/watch-stop --browser` | 同上，并在确认后退出整个浏览器（该调试浏览器的所有标签页都会关闭） |
| `video_state` 工具 | 模型调用，读取课程、集数、本集标题、播放时间和当前字幕句 |
| `video_seek` 工具 | 模型调用，把视频跳到指定时间，可选播放或暂停 |
| `video_frame` 工具 | 模型调用，截取视频当前画面（幻灯片、板书、电路图） |

## 浏览器内操作

| 操作 | 说明 |
|---|---|
| 选中文字 → Ask | 打开提问卡 |
| 选中文字 → Pin | 钉住引用 |
| 提问卡中 `Enter` | 发送问题 |
| 提问卡中 `Shift+Enter` | 换行 |
| 提问卡中 `Ctrl+Enter` | 钉住，输入的文字作为该引用的指令 |
| 抽屉追问框中 `Enter` / `Shift+Enter` | 发送追问 / 换行 |
| 麦克风按钮 `🎙` | 开始录音；再次点击（`■`）停止并转写为文字 |
| `Esc` | 关闭提问卡或收起抽屉 |
| `r` 或 `▭`，或按住 Alt 拖动 | PDF 框选区域 |
| `◎` 或按住 Alt 点击 | HTML 拾取元素 |
| `+` / `-` / `0`，Ctrl+滚轮 | PDF 缩放 / 适应宽度 |
| `◐` | 切换纸面与碳黑主题 |

## 发给模型的内容

每处引用是一个 `<browser-context>` 块，写明文件和位置，附带选中的文字和少量上下文：md 附源码行，pdf 附前后文，html 附元素 HTML。例如：

```text
<browser-context kind="md" file="notes/attention.md" lines="24-25">
<heading-path>Attention › Why scale?</heading-path>
<selection>
For large values of dk, the dot products grow large in magnitude
</selection>
<source lines="24-25">
> For large values of $d_k$, the dot products grow large in magnitude, …
</source>
</browser-context>

What gradient problem?
```

在抽屉中继续追问时，会在 `<browser-context>` 后附带一段紧凑的 `<follow-up>` 引用上一轮问题与回答开头，用于多轮对话定位（终端里同样折叠为单行显示）：

```text
<follow-up ref="#3">
<previous-question>What gradient problem?</previous-question>
<previous-answer>…</previous-answer>
</follow-up>
```

终端里上述标签折叠成引用行显示，模型收到的是完整内容。

## 同一文件多次打开

- **同一个 pi 会话内**：
  - 同一文件只对应一个文档。路径会先解析符号链接，通过不同路径打开同一文件也会合并。
  - 文档已在标签页中打开时，`/view` 只让那个标签页跳转，不再新开；加 `--new` 可以另开。
- **同一文档的多个标签页**：都接收同一份钉住列表和问答，各页的标记一致。
- **多个 pi 会话**：可以同时打开同一文件。每个会话有自己的端口、token 和状态，页面里的提问只发给打开该页面的会话。
- **Office 转换**：
  - 转换结果按文件路径、修改时间和大小缓存在 `~/.cache/pi-webview/office/`。
  - 每个 pi 进程使用自己的 LibreOffice profile，转换结果先写入临时目录再移动到位，因此多个进程同时转换同一文件不会冲突。

## 页面关闭与清理

- **关闭标签页**：页面的连接断开。没有标签页展示某个目录下的文档时，停止监听该目录。钉住的引用和问答存在 pi 里，重新 `/view` 后恢复显示。
- **未发送的提问卡文字**：只在页面里，关闭标签页后丢失。需要保留的内容先用 Pin 钉住。
- **`/view-stop`**：断开所有页面，关闭本地服务和目录监听，删除本进程的 LibreOffice profile。页面显示 closed 并停止重连，再次 `/view` 会启动新的服务。
- **pi 退出**：与 `/view-stop` 相同，没有保存的钉住修改会先写入会话。pi 异常退出时，页面按浏览器默认方式持续重连，关闭标签页即可。
- **缓存**：每个 pi 进程第一次打开文档时，删除 30 天前的 PDF 转换结果和截图，以及已退出进程留下的 LibreOffice profile。

### 视频页面的生命周期

- **一个标签页只属于一个 pi 会话**：侧栏在页面上标记所属的会话。另一个 pi 会话 `/watch` 同一视频时新开标签页，不会接管已被占用的页面；侧栏里的提问只发给所属会话。
- **数据随会话保存**：本会话接管的标签页和手动选择的字幕文件写在会话里（自定义条目，不发送给模型），问答从会话消息推导。设置是个人偏好，存在 `~/.pi/agent/pi-webview-video.json`，所有会话共用。
- **切换会话**（`/new`、`/resume`、`/reload`）：离开的会话的侧栏从页面移除，标签页保留；回到该会话时重新接管仍然打开的标签页。`/tree` 切换分支时标签页不变，字幕选择按分支恢复。浏览器重启后按视频重新匹配标签页，不会自动新开。
- **关闭标签页**：该页从会话中移除。用 `/watch-close` 关闭时同样处理。
- **`/watch-stop`**：移除本会话所有标签页上的侧栏，断开浏览器连接，并清空会话里记录的标签页，恢复会话时不再自动接管。
- **pi 退出**：移除侧栏、断开连接，会话里保留标签页记录，下次恢复该会话时重新接管。pi 异常退出时侧栏会留在页面上，但不再能发送；之后任一 pi 会话接管该页面时自动替换它。

## 安装

1. 安装依赖：
   ```zsh
   cd ~/Projects/Pi-extension-dev/extensions/pi-webview && npm install
   ```
   `.npmrc` 设置了 `omit=peer`，不会把 pi 宿主包装进 `node_modules`。
2. 安装本地扩展：
   ```zsh
   pi install ~/Projects/Pi-extension-dev/extensions/pi-webview
   ```
3. 在 pi 中执行 `/reload` 生效。

打开 Office 文件需要本机安装 LibreOffice（`soffice` 位于 `PATH` 中）。

## 配置

| 环境变量 | 说明 |
|---|---|
| `PI_WEBVIEW_BROWSER` | 打开网页使用的命令，默认 `xdg-open`，例如 `helium-browser --new-window` |
| `PI_WEBVIEW_CDP` | 视频功能连接的浏览器 DevTools 地址，默认 `http://127.0.0.1:9444` |
| `PI_WEBVIEW_CDP_LAUNCH` | DevTools 地址连不上时用 zsh 执行的启动命令，例如 `/opt/helium-browser-bin/helium --user-data-dir="$HOME/.local/share/browseruse/profile" --remote-debugging-port=9444`；未设置时只提示错误 |

## 文件位置

| 路径 | 内容 |
|---|---|
| `~/.cache/pi-webview/office/` | Office 文件转换出的 PDF，保留 30 天 |
| `~/.cache/pi-webview/shots/` | PDF 框选区域的截图，保留 30 天 |
| `~/.cache/pi-webview/lo-profiles/` | 各 pi 进程的 LibreOffice profile，进程退出时删除 |
| 会话文件中的 `pi-webview-pins` 条目 | 钉住的引用，不发送给模型 |
| `~/.cache/pi-webview/frames/` | 视频截取的画面，保留 30 天 |
| `~/.pi/agent/pi-webview-video.json` | 视频侧栏设置（个人偏好，各会话共用） |
| 会话文件中的 `pi-webview-video` 条目 | 本会话接管的视频标签页和手动选择的字幕文件，不发送给模型 |

## 实现

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 入口：先安装公共层，再注册文档模块和视频模块 |
| `src/shared/turns.ts` | 从会话消息推导问答（轮次、流式回复、工具进度），分发给各模块 |
| `src/shared/blocks.ts` | 上下文块的注册、去除与终端折叠；`<follow-up>` 追问块 |
| `src/shared/markdown.ts` | markdown 渲染引擎（文档、回复；视频侧栏用纯 MathML 公式） |
| `src/shared/send.ts`、`src/shared/messages.ts` | 发送用户消息；读取消息内容 |
| `src/text/index.ts` | 文档模块：`/view` 等命令、`view_open` 工具、提问、钉住、星标与终端输入 |
| `src/text/hub.ts` | 文档模块的进程级状态（文档、钉住、连接），本地服务的启停 |
| `src/text/routes.ts` | HTTP 路由：页面、文件、事件流（SSE）、提问、钉住与 `/asr` 接口 |
| `src/text/threads.ts` | 把问答连同 `<browser-context>` 位置推送到文档页面 |
| `src/text/context.ts` | 校验页面请求，生成和解析 `<browser-context>` 块 |
| `src/text/render.ts`、`src/text/docs.ts`、`src/text/export.ts` | 页面模板；文件类型与 Office 转换；导出 HTML |
| `web/core.js` | 文档页面公共层：提问卡、标记、回复展开、面板 |
| `web/md.js`、`web/pdf.js`、`web/html.js` | 各类文档的选区、定位与刷新 |
| `src/video/index.ts` | 视频模块：`/watch` 命令、`video_*` 工具、提问、终端消息附带时间、问答推送 |
| `src/video/tab.ts` | 一个被接管的标签页：注入侧栏、处理侧栏消息、读取课程信息、字幕加载与截帧 |
| `src/video/cdp.ts` | 基于 Node 内置 WebSocket 的 CDP 客户端 |
| `src/video/sites.ts` | YouTube、Bilibili 与通用网页的课程信息读取和页面结构 |
| `src/video/subtitles.ts`、`src/video/context.ts`、`src/video/store.ts` | 字幕解析与查找；`<video-context>` 块；侧栏设置与字幕选择的保存 |
| `src/video/inject/panel.js`、`panel.css` | 注入视频页面的侧栏（隔离环境、closed shadow root） |

问答与会话的对应关系完全由会话记录推导：每条用户消息是一组问答，消息中的 `<browser-context>` 或 `<video-context>` 块标明位置，随后的助手输出是回复。实时更新使用 pi 的 `message_start`、`message_update`、`message_end` 事件；恢复会话时读取 `sessionManager.getBranch()`。

钉住的引用用 `pi.appendEntry()` 写入会话。每次变化停顿 0.8 秒后写一条，pi 工作期间等到本轮结束再写。恢复时取当前分支上最后一条，时机是 `session_start` 和 `session_tree`。

## 安全

- 服务只监听 `127.0.0.1`。URL 带随机 token，并校验 `Host` 与 `Origin`。
- 只提供已打开文档所在目录下的文件，拒绝以点开头的路径。
- 模型回复按 Markdown 渲染，禁用原始 HTML。
- 只有在你点击发送时才向 pi 发消息。
- 视频侧栏运行在 CDP 创建的隔离环境里，与网站脚本不共享 JS；与 pi 通信的绑定只存在于这个环境，网站脚本无法调用。侧栏只能选用 pi 列给它的字幕文件，不能指定任意路径。
- 开着远程调试端口时，本机任何进程都能控制该浏览器；建议用专门的浏览器 profile 看课。

## 已知限制

- 页面字体从 Google Fonts 加载，离线时使用系统字体。
- md 中指向文档目录之外的相对链接（如 `../other.md`）无法打开。
- HTML 元素对应的源码行号靠文本匹配推断，匹配不唯一时只提供 CSS 选择器。
- 框选截图只在当前模型支持图像输入时作为图片发送，否则只附截图文件路径。
- 视频功能只支持 Chromium 系浏览器（CDP）；Firefox 系浏览器（含 Zen）不支持。
- 视频在跨域 iframe 中的网站（部分 MOOC 平台）暂不支持；通用网页只读取时间和页面标题。
- 课程信息依赖 YouTube、Bilibili 的页面数据结构，网站改版后可能需要更新 `src/video/sites.ts`。
- Chrome 不会为从未显示过的后台标签页加载视频，所以 `/watch <链接>` 会把标签页切到前台。

## 许可

MIT 许可证，Copyright (c) 2026 llMooreyll。详见 package.json。
