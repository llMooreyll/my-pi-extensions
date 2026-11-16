# pi-input-plus

扩展 Pi 输入框的行为。名称为暂定，目录和 `package.json` 里的 `name` 可以一起改。

## 功能

| 功能 | 触发 | 说明 |
|---|---|---|
| 文件选择器（`@`） | 在行首或空白之后输入 `@` | 打开浮窗选择文件或目录，从当前 cwd 开始。文件插入 `name[/绝对路径] `，目录插入 `/绝对路径/ `。关闭浮窗不选时，插回一个 `@` |
| 文件选择器（Tab） | 光标前的路径以 `/` 结尾时按 Tab | 在该目录打开同一个选择器。以 `!` 或 `/` 开头的行插入纯绝对路径（含空格时加引号），其他行与 `@` 相同 |
| Tab 补全 | 光标前的路径不以 `/` 结尾时按 Tab | 补全到最长公共前缀，只有一个候选时补全完整名称，不显示候选列表 |
| 粘贴预览 | 光标紧挨在 `[paste #n …]` 或剪贴板图片路径之前时按空格；单击该内容 | 文本用可滚动的浮窗查看；图片用 `chafa` 转成字符画显示 |
| 选择器服务 | 其他扩展调用 | `globalThis[Symbol.for("pi.file-picker.v1")]`，见下文 |

内置的 `@` 候选列表被关闭。输入 `@` 之后不在行首或空白后面的情况（如 `a@b.com`）不受影响。

## 浮窗按键

| 模式 | 按键 | 动作 |
|---|---|---|
| 选择器，普通模式 | `j` `k` / `↓` `↑` | 移动 |
| | `h` / `←` / Backspace | 回到上级目录 |
| | `l` / `→` | 进入目录；在文件上等同于确定 |
| | `Enter` / `Space` | 确定（文件和目录都可以） |
| | `g` `G`、`Ctrl-d` `Ctrl-u` | 首行 / 末行、翻半页 |
| | `.` | 显示 / 隐藏点文件 |
| | `/` | 进入搜索模式 |
| | `q` / `Esc` | 关闭 |
| 选择器，搜索模式 | 可打印字符 | 输入搜索词（`fd` 递归搜索，模糊匹配） |
| | `↓` `↑` / `Ctrl-n` `Ctrl-p` | 移动 |
| | `Enter` | 确定 |
| | `Esc` | 回到普通模式，保留筛选结果 |
| 文本预览 | `j` `k`、`Ctrl-d` `Ctrl-u`、`g` `G`、Space | 滚动 |
| 图片预览 | `o` | 用 `xdg-open` 打开原图 |
| 预览 | `q` / `Esc` | 关闭 |

## 选择器服务

```ts
const picker = (globalThis as any)[Symbol.for("pi.file-picker.v1")];
if (ctx.mode === "tui" && picker?.version === 1) {
  const picked = await picker.pick(ctx.ui, {
    cwd: ctx.cwd,
    title: "…",
    extensions: [".mp4"],        // 只列出这些后缀的文件，目录始终列出
    accept: (path) => true,      // 额外的文件过滤
    selectDirectories: false,    // Enter 在目录上只进入，不选中
  });
  // picked: { path, isDirectory } | undefined
}
```

没有 TUI（RPC、print 模式）或没有加载本扩展时，调用方需要自己处理没有选择器的情况。`/view`（pi-webview）和 `/read-video`（pi-video）都是这样使用的。

## 与其他扩展的关系

- 通过 `getEditorComponent()` / `setEditorComponent()` 在已有输入框上叠加，不替换它。statusline-pi 用同样的方式，加载顺序不影响结果。
- 只使用公开接口：`addAutocompleteProvider`、`getEditorComponent`、`ctx.ui.custom`，以及输入框的 `handleInput`、`handleMouse`、`getText`、`getExpandedText`、`getLines`、`getCursor`、`insertTextAtCursor`。
- 粘贴预览依赖 `[paste #n +N lines]` / `[paste #n N chars]` 占位符的文本格式和剪贴板图片的 `.png` 等文件路径；这两种格式变化后，预览不会触发，输入不受影响。

## 已知限制

- 行首的绝对路径（如 `/home/moorey/`）按 Tab 时，pi 把它当作斜杠命令处理，不会打开选择器；`~/…`、`./…`、`src/` 和行中的路径可以。
- `@` 后面直接跟字符的补全（`@src`）不再有候选列表。
- 点击预览依赖点击后光标落在内容上；点在块右侧的空白处不会触发。
- `fd` 版本过低时，目录的搜索结果可能没有末尾的 `/`，会被当作文件。

## 依赖

`fd`（递归搜索；缺失时退回有限深度的遍历）、`chafa`（图片预览）、`xdg-open`（外部打开）。
