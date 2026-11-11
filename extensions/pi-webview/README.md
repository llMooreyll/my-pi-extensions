# pi-webview

Pi Coding Agent 的浏览器阅读与提问扩展。在浏览器中打开 md、html、pdf、pptx、docx 等文件，选中内容或点选元素后，把位置和上下文发给当前 pi 会话；回复直接显示在页面上。

扩展在 pi 进程内启动一个只监听 `127.0.0.1` 的本地网页服务，不需要安装浏览器扩展。

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
4. **页面上的回复**：
   - 提问过的位置显示橙色标记 `◉ n`，钉住的位置显示蓝色标记 `◆`，对应文字带高亮。
   - 点击 `◉` 在原处展开该位置的所有问答，回复实时流式显示，运行中的工具显示在回复下方。
   - 右下角 `✦` 打开面板，Wire 页列出当前会话的全部问答，可按来源筛选，也可以直接给 pi 发消息。
   - 恢复会话后，扩展从会话记录重建问答，页面标记重新出现。

## 命令与工具

| 命令 / 工具 | 说明 |
|---|---|
| `/view <文件>` | 在浏览器中打开文件 |
| `/view <文件>:<N>` | 打开并跳到第 N 行（md、html）或第 N 页（pdf、Office） |
| `/view <文件> --new` | 文件已在标签页中打开时，另开一个标签页 |
| `/view` | 打开索引页，列出本会话打开过的文件 |
| `/view-clear` | 清空钉住、尚未发送的引用 |
| `/view-stop` | 断开所有页面并关闭本地服务；钉住的引用和问答保留 |
| `view_open` 工具 | 模型调用，打开文件或跳到指定行、页 |

## 浏览器内操作

| 操作 | 说明 |
|---|---|
| 选中文字 → Ask | 打开提问卡 |
| 选中文字 → Pin | 钉住引用 |
| 提问卡中 `Enter` | 发送问题 |
| 提问卡中 `Shift+Enter` | 换行 |
| 提问卡中 `Ctrl+Enter` | 钉住，输入的文字作为该引用的指令 |
| `Esc` | 关闭提问卡 |
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

终端里这个块折叠成一行显示，模型收到的是完整内容。

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

## 文件位置

| 路径 | 内容 |
|---|---|
| `~/.cache/pi-webview/office/` | Office 文件转换出的 PDF，保留 30 天 |
| `~/.cache/pi-webview/shots/` | PDF 框选区域的截图，保留 30 天 |
| `~/.cache/pi-webview/lo-profiles/` | 各 pi 进程的 LibreOffice profile，进程退出时删除 |
| 会话文件中的 `pi-webview-pins` 条目 | 钉住的引用，不发送给模型 |

## 实现

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 注册命令、工具和事件；处理提问、钉住、终端输入和钉住的保存与恢复 |
| `src/hub.ts` | 进程级状态（文档、钉住、问答、连接），本地服务的启停 |
| `src/routes.ts` | HTTP 路由：页面、文件、事件流（SSE）、提问与钉住接口 |
| `src/threads.ts` | 从会话消息推导问答，流式推送到页面 |
| `src/context.ts` | 校验页面请求，生成和解析 `<browser-context>` 块 |
| `src/render.ts` | markdown 渲染与页面模板 |
| `src/docs.ts` | 文件类型、路径处理、Office 转换 |
| `web/core.js` | 页面公共层：提问卡、标记、回复展开、面板 |
| `web/md.js`、`web/pdf.js`、`web/html.js` | 各类文档的选区、定位与刷新 |

问答与会话的对应关系完全由会话记录推导：每条用户消息是一组问答，消息中的 `<browser-context>` 块标明位置，随后的助手输出是回复。实时更新使用 pi 的 `message_start`、`message_update`、`message_end` 事件；恢复会话时读取 `sessionManager.getBranch()`。

钉住的引用用 `pi.appendEntry()` 写入会话。每次变化停顿 0.8 秒后写一条，pi 工作期间等到本轮结束再写。恢复时取当前分支上最后一条，时机是 `session_start` 和 `session_tree`。

## 安全

- 服务只监听 `127.0.0.1`。URL 带随机 token，并校验 `Host` 与 `Origin`。
- 只提供已打开文档所在目录下的文件，拒绝以点开头的路径。
- 模型回复按 Markdown 渲染，禁用原始 HTML。
- 只有在你点击发送时才向 pi 发消息。

## 已知限制

- 页面字体从 Google Fonts 加载，离线时使用系统字体。
- md 中指向文档目录之外的相对链接（如 `../other.md`）无法打开。
- HTML 元素对应的源码行号靠文本匹配推断，匹配不唯一时只提供 CSS 选择器。
- 框选截图只在当前模型支持图像输入时作为图片发送，否则只附截图文件路径。

## 许可

MIT 许可证，Copyright (c) 2026 llMooreyll。详见 package.json。
