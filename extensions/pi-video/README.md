# pi-video

| 项 | 说明 |
|---|---|
| `read_video` 工具 | 把本地视频（mp4、webm、mov 等，最大 80 MB）以原始多模态数据放进模型上下文，目前面向 Gemini。从 `~/.pi/agent/extensions/video-reader.ts` 迁入，行为不变；新增了让模型看到 `name.mp4[/绝对路径]` 就调用它的提示 |
| `/read-video [文件]` | 不带参数时打开 pi-input-plus 的文件选择器，只列出 `.mp4`；带参数时直接使用该文件。选中后在输入框插入 `name.mp4[/绝对路径] `，补上问题后发送，由模型调用 `read_video` |

没有 TUI 或没有加载 pi-input-plus 时，`/read-video` 必须带文件参数。

## 迁移

加载本扩展之前，先删除 `~/.pi/agent/extensions/video-reader.ts`，否则两个扩展注册同名的 `read_video` 工具。
