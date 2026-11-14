# pi-input-complete 方案

在输入框任意位置引用文件和 skill，并提供一个样式可控的引用选择器。全部通过 pi 扩展 API 实现，不修改 pi 源码，不替换编辑器组件。

状态：方案阶段，未实现。基线版本：pi 1.5.2。

## 1. 要解决的问题

| 现象 | 原因（pi 1.5.2 源码） |
|---|---|
| 汉字后面紧跟 `@`（如 `看看@src`）不弹出文件补全 | 编辑器只在行首、空白或中文标点之后的 `@` 上自动触发：`/usr/lib/node_modules/pi/packages/tui/dist/components/editor.js` 第 170–179、1028–1037 行 |
| 已有文字时按 Tab 补全不到路径 | Tab 走强制补全，取光标前最后一个分隔符之后的整段作为路径前缀；分隔符只有空白、引号、`=`、中文标点。中文句子没有空格，整句都成了前缀：`autocomplete.js` 第 7、38–50、372–400 行 |
| 输入框已有文字时无法引用 skill | 命令补全要求整段输入以 `/` 开头：`autocomplete.js` 第 230 行；`/skill:name` 只在消息开头展开：`coding-agent/dist/core/agent-session.js` 第 1811–1812 行 |
| 补全列表样式无法调整 | 列表是 `SelectList`，只开放 `selectedPrefix`、`selectedText`、`description`、`scrollInfo`、`noMatch` 五个颜色函数：`tui/dist/components/select-list.d.ts` 第 7–13 行 |

## 2. 与 statusline-pi 的关系：分开实现

结论：新建独立扩展，不并入 `extensions/statusline-pi`。

- 本方案不调用 `ctx.ui.setEditorComponent()`，不需要编辑器子类。用到的接口是 `addAutocompleteProvider`、`input` 事件、`ctx.ui.custom` 浮层、`registerShortcut`、`pasteToEditor`，这些接口与谁替换了编辑器无关。
- statusline-pi 的 `StatusBorderEditor` 只重写上下边框（`statusline-pi/src/editor.ts` 第 20–37 行），它的注释写明补全列表画在下边框之下、不受影响，两者可以同时生效。
- statusline-pi 是上游 `luongnv89/pi-extensions` 的分叉（见 `docs/UPSTREAM.md`），塞入无关功能会增加与上游同步的冲突面；状态栏和输入补全也是两个独立职责。

只有一种情况需要合并：将来决定用编辑器子类调用 `Editor` 的私有方法来实现「汉字后 `@` 自动弹出内置列表」。本方案不采用这条路线（见 §4.4）。

## 3. 功能范围

| 编号 | 功能 | 实现接口 |
|---|---|---|
| F1 | 句中任意位置 `@xxx` + Tab 补全文件，复用 pi 内置的 fd 模糊搜索 | `ctx.ui.addAutocompleteProvider` |
| F2 | `$skill名` 补全（空白后自动弹出，任意位置 Tab 弹出） | `ctx.ui.addAutocompleteProvider`（`triggerCharacters: ["$"]`） |
| F3 | 发送时把句中的 `$skill名` 展开为 skill 内容块 | `pi.on("input")` 返回 `transform` |
| F4 | 引用选择器浮层：文件 / 目录 / skill 分页，模糊搜索，右侧预览，多选，自定义样式 | `ctx.ui.custom(..., { overlay: true })` + `pi.registerShortcut` + `ctx.ui.pasteToEditor` |
| F5 | 多个 skill 块在对话记录中折叠为一行显示 | `pi.registerMarkdownTransformer`（`messageTypes: ["user"]`） |

不做：修改 pi 内置补全列表的外观（只能跟随主题色）；改变 `/命令` 的补全行为；替换编辑器。

## 4. 设计

### 4.1 F1：句中 `@` 的 Tab 补全

包装内置 provider（`current`）：

1. `getSuggestions(lines, line, col, options)`：取光标前文本，从后往前找最近的 `@`，满足以下条件时视为引用 token：
   - `@` 到光标之间不含空白和中文标点（与内置分隔规则一致）；
   - `@` 前一个字符不是 ASCII 字母或数字，避免把 `a@b.com` 当成文件引用；
   - 支持 `@"带空格的路径` 的引号形式。
2. 命中时构造只含该 token 的合成输入：`current.getSuggestions([token], 0, token.length, options)`。内置逻辑会把它当成行首的 `@token`，返回 `{ prefix: "@...", items }`，从而复用 fd 搜索、引号处理和目录展开。
3. 未命中时原样调用 `current.getSuggestions(...)`。
4. `applyCompletion` 直接委托给 `current.applyCompletion(...)`。内置实现按 `prefix.length` 从光标往回替换，`@` 分支不检查 `@` 前面的字符（`autocomplete.js` 第 290–330 行，`@` 分支在第 313 行），所以对句中 token 同样正确。
5. `shouldTriggerFileCompletion` 委托给 `current`。

列表出现后，后续输入沿用强制模式刷新（`editor.js` 第 2045–2048 行），再次调用 provider 时第 1 步仍会命中。

### 4.2 F2：`$skill` 补全

- skill 列表来自 `pi.getCommands().filter(c => c.source === "skill")`：
  - 名称取 `name` 去掉 `skill:` 前缀；
  - 文件为 `sourceInfo.path`（SKILL.md）；
  - 目录为 `sourceInfo.baseDir ?? dirname(path)`（来源 `coding-agent/dist/core/skills.js` 第 90–100、261 行）。
- 在 `session_start` 时读取并缓存，`/reload` 后会重新执行。
- token 规则：`$` 前面是行首、空白或中文标点（编辑器自动触发的条件）；Tab 强制补全时 `$` 前面可以是任意非 ASCII 字母数字的字符。
- 候选项：`value = "$" + name`，`label = name`，`description` 取 skill 描述，用 `fuzzyFilter` 排序（从 `@earendil-works/pi-tui` 导入）。
- `applyCompletion` 自行实现：把 `prefix` 替换为 `$name `，光标放到空格之后。

### 4.3 F3：发送时展开 skill

`pi.on("input", ...)`：

1. 跳过 `event.source === "extension"` 的输入，避免二次展开其他扩展发出的消息。
2. 跳过代码块和行内代码中的文本，只匹配已知 skill 名：`(^|[^A-Za-z0-9_$])\$(<已知名称>)(?=$|[^A-Za-z0-9_-])`。
3. 按出现顺序去重，读取每个 SKILL.md，去掉 frontmatter，生成与 pi 一致的块：

   ```text
   <skill name="NAME" location="PATH">
   References are relative to BASEDIR.

   BODY
   </skill>
   ```

4. 组装规则：
   - 只有一个 skill：输出 `块 + "\n\n" + 用户原文`。这与 `parseSkillBlock` 的正则完全匹配（`agent-session.js` 第 63–72 行），对话记录中会用 pi 原生的可折叠 skill 组件显示（`interactive-mode.js` 第 3303–3315 行）。
   - 多个 skill：块依次拼接后接用户原文。原生组件只认第一个块，其余块落在「用户消息」部分，由 F5 折叠显示。
5. 用户原文中的 `$name` 保留不变，模型可以看到引用位置。
6. 消息本身以 `/skill:` 开头时不处理，交给 pi 内置展开。
7. 读取失败时 `ctx.ui.notify` 报错，该 skill 保持原文。

### 4.4 F4：引用选择器浮层

触发方式：
- 快捷键，默认 `alt+i`，可配置。核对结果：pi 内置快捷键和本机已装扩展都没有使用 `alt+i`；`alt+o`、`alt+s`、`alt+t` 已被其他扩展占用。
- 可选的启发式触发：`ctx.ui.onTerminalInput` 收到 `@`，且 `getEditorText()` 末尾是非分隔字符（汉字等）时打开浮层并吞掉该 `@`。扩展 API 不提供光标位置，这里只能假设光标在文末，所以默认关闭，作为配置项提供。

浮层内容：
- 分页：`文件`、`目录`、`Skill`、`最近`（本会话已引用过的路径）。
- 数据源：
  - 文件和目录用 `fd --type f|d --hidden --exclude .git`（本机 `/usr/bin/fd`），找不到时用 `rg --files`；
  - 以 cwd 为键缓存，打开浮层时在后台刷新；
  - 遵守 `.gitignore`。
- 搜索：用 `fuzzyFilter` 模糊匹配，路径分段加权（文件名命中优先）。
- 预览：
  - 文件显示前 N 行，按扩展名高亮（pi-coding-agent 导出 `highlightCode`、`getLanguageFromPath`）；
  - 目录显示前若干个条目；
  - skill 显示描述和 SKILL.md 开头。
- 多选：空格切换选中，回车插入。
- 插入：通过 `ctx.ui.pasteToEditor(text)` 插到光标处。
  - 文件插入 `@path`，路径含空格时用 `@"path"`；skill 插入 `$name`；多项用空格连接。
  - 单次插入不超过 10 行和 1000 字符，因此不会被折叠成 `[paste #n]` 占位（`editor.js` 第 1093–1095 行）；文本以 `@` 或 `$` 开头，不会触发「粘贴路径前自动补空格」的逻辑（第 1081–1088 行）。
- 样式：
  - 颜色全部取 `theme.fg/bg` 的主题 token，不写死 ANSI；
  - 图标表按扩展名映射，提供 Nerd Font 和纯 ASCII 两套，可配置；
  - 布局：上方搜索框，左侧列表，右侧预览，宽度足够时左右分栏，窄屏时上下排列。

不采用的路线：继承 `CustomEditor` 后调用 `Editor` 的私有方法 `tryTriggerAutocomplete`。这样做可以让汉字后的 `@` 弹出内置列表，但依赖未公开实现，pi 升级后容易失效，还需要与 statusline-pi 的编辑器合并。

### 4.5 F5：多 skill 块的显示折叠

`pi.registerMarkdownTransformer(fn, { messageTypes: ["user"] })`：把用户消息里完整的 `<skill name="X" location="...">…</skill>` 块替换为一行 `> ⚑ skill: X`。这只影响显示，会话记录和模型上下文不变。

已知冲突：pi-tool-display 的 `enableNativeUserMessageBox` 在消息小于 10 万字符、2000 行时，会重建 `Markdown` 但不传 `transform`（`~/.pi/agent/npm/node_modules/pi-tool-display/src/user-message-box-renderer.ts` 第 147–157 行），导致所有用户消息的 markdown transformer 失效，pi-webview 的引用折叠也受影响。F5 生效的前提是关闭该选项，或在重写 tool display 时修复。

## 5. 目录与文件规划

```text
extensions/pi-input-complete/
├── PLAN.md
├── package.json            # pi.extensions: ["./src/index.ts"]; peerDependencies 同 pi-webview
├── README.md
└── src/
    ├── index.ts            # 注册 provider、input 处理、快捷键、markdown transformer、读取配置
    ├── at-token.ts         # F1：句中 @ token 识别（纯函数）
    ├── skill-registry.ts   # skill 列表缓存，从 pi.getCommands() 构建
    ├── skill-provider.ts   # F2
    ├── skill-expand.ts     # F3：查找、去重、读取、生成块（纯函数 + 文件读取）
    ├── picker/
    │   ├── picker.ts       # F4 浮层组件（render/handleInput）
    │   ├── sources.ts      # fd / rg 文件源与缓存
    │   ├── preview.ts      # 预览渲染
    │   └── icons.ts        # 图标表
    └── fold.ts             # F5
```

配置文件：`~/.pi/agent/pi-input-complete.json`。

```json
{
  "inlineAtTab": true,
  "skillPrefix": "$",
  "expandInlineSkills": true,
  "picker": {
    "shortcut": "alt+i",
    "openOnInlineAt": false,
    "icons": "nerd",
    "previewLines": 20,
    "tabs": ["files", "dirs", "skills", "recent"]
  },
  "foldSkillBlocks": true
}
```

## 6. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | F1 | 输入 `帮我看看@src/in` 后按 Tab 出现候选，选中后得到 `帮我看看@src/index.ts `，前面的文字不变；`a@b.com` 按 Tab 不出现文件候选 |
| M2 | F2 + F3 | `请用 $office 处理` 发送后，对话中显示可折叠的 office skill 块和原文；两个 skill 时第二个块折叠为一行（需满足 §4.5 前提）；代码块中的 `$office` 不展开 |
| M3 | F4 | `alt+i` 打开浮层；搜索、预览、多选、插入都正常；与 statusline-pi 同时启用时边框和补全都正常 |
| M4 | F5 + 配置项 + README | 配置项逐项生效 |

## 7. 待验证（需要实际运行，未执行）

1. `current.getSuggestions` 收到合成单行输入时，fd 搜索的基准目录仍是会话 cwd（provider 构造时传入的 `basePath`，与输入行无关，预计成立）。
2. `pasteToEditor` 在内置补全列表打开时的行为；浮层打开期间输入焦点是否完全由浮层接管。
3. `enableSkillCommands: false` 时 `pi.getCommands()` 是否仍包含 skill；若不包含，改为在 `before_agent_start` 中读取 `systemPromptOptions.skills` 并缓存。
4. 包内 skill 的 `sourceInfo.baseDir` 是否总是 skill 目录；不是时退回 `dirname(path)`。
5. `input` 事件中 `event.source` 在 pi-remote（RPC）和 Telegram 通道下的取值，确认这些来源也应展开。
