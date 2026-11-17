---
name: pi-board
description: 在含有 docs/board/ 的项目里记录和更新计划文档（任务 T、决定 D、冲突 C 和扩展板块）的格式与规则。用户提出新要求、修改原要求、做出决定、需要用户裁决，或你要修改 docs/board/ 下任何文件时使用；每次 write/edit 的 message 与 task 参数写法也在这里。
---

# pi-board：计划文档的格式与规则

用户不读代码，也读不完长文档，只看一个面板：现在在做什么、哪些事在等他决定、新旧要求哪里冲突、你每次改了哪个文件为什么改。面板的数据全部来自 `docs/board/` 和每次 write/edit 的 `message`。所以这里的记录必须准确、及时、格式严格。

只有主代理（lead）可以修改 `docs/board/`。团队成员和子代理不能写，也不能用 bash 写；它们把需要的计划变更写进给主代理的汇报里。

## 一、规则

1. 用户提出新要求、修改原要求或做出决定时，**先**记录 D，或新建、修改 T，**再**改代码。
2. 记录新 D 时，与全部 `active` 的 D 和相关文档章节逐一比对。发现矛盾就新建一条 C，`owner: user`；用户裁决前，不执行与该冲突有关的改动。
3. 开始一个任务时把 `status` 改为 `doing`；完成时改为 `done`，并填写 `result`。
4. 需要用户决定的事，新建或修改 T，`status: waiting`、`owner: user`，不能只在对话里问。
5. 每次提交代码时，把当时的 `docs/board/` 一并提交。
6. 每次 write/edit 都要带 `message`，必要时带 `task`（见第四节）。

条目只能改状态，不能删除，编号不复用。需要作废就把 T 改为 `dropped`，把 D 改为 `superseded`。

## 二、文件与条目格式

| 文件 | 内容 | 编号前缀 |
|---|---|---|
| `docs/board/tasks.md` | 任务 | `T` |
| `docs/board/decisions.md` | 决定 | `D` |
| `docs/board/conflicts.md` | 冲突 | `C` |
| `docs/board/<其他>.md` | 扩展板块（第三节） | frontmatter 里的 `prefix` |

每个条目是一个二级标题，字段行**紧跟标题，中间不空行**，再往下是可选的自由正文：

```markdown
## T12 标点改用 ct-punc
- status: doing
- priority: high
- owner: ai
- next: 在《火线》上对比 ct-punc 与旧结果
- refs: D26, [设计 §6](../../设计方案.md#6-处理流水线)

自由正文，可以写背景、过程、链接。面板默认折叠它。
```

- 标题格式 `## <编号> <标题>`：编号是前缀加正整数（`T12`）。旧项目的前导零写法（`T05`）可以保留，但 `T5` 与 `T05` 视为同一个编号；新编号不写前导零，取该前缀已有最大编号加 1。标题紧跟一个空格，不加冒号。
- 字段行格式 `- <key>: <value>`，key 用英文小写，顺序不限，同一个 key 不重复。
- 标题和正文用中文，字段名和取值用英文。
- 每个文件里所有二级标题都必须是条目；不要在这些文件里写别的 `##` 标题。`###` 及更深的标题可以放在正文里。
- 代码块里的 `##` 不算标题。

### 任务 T（tasks.md）

| key | 必填 | 取值 |
|---|---|---|
| `status` | 是 | `todo` `doing` `waiting` `paused` `done` `dropped` |
| `priority` | 是 | `high` `medium` `low` |
| `owner` | 是 | `user` `ai` 或团队成员名 |
| `next` | `status` 为 `todo` `doing` `waiting` 时必填 | 下一步，一句话 |
| `refs` | 否 | 逗号分隔的条目编号或 Markdown 链接 |
| `branch` | 否 | 分支名 |
| `commits` | 否 | 逗号分隔的提交号 |
| `result` | `status` 为 `done` 时必填 | 验收结果，一句话 |

`waiting` 表示等用户决定，此时 `owner` 必须是 `user`。

### 决定 D（decisions.md）

| key | 必填 | 取值 |
|---|---|---|
| `status` | 是 | `active` `superseded` |
| `date` | 是 | `YYYY-MM-DD` |
| `by` | 是 | `user` `ai` |
| `rejected` | 否 | 没选的方案，一句话 |
| `reason` | 是 | 理由，一句话 |
| `supersedes` | 否 | 被本条取代的 D 编号，逗号分隔 |
| `superseded-by` | `status` 为 `superseded` 时必填 | 取代本条的 D 编号 |
| `affects` | 否 | 受影响的 T 编号或文档链接 |

决定的内容写在标题里。标题写不下时，正文第一段写完整决定。

### 冲突 C（conflicts.md）

| key | 必填 | 取值 |
|---|---|---|
| `status` | 是 | `open` `resolved` |
| `between` | 是 | 两处冲突的来源，逗号分隔，每处是条目编号或文档链接 |
| `owner` | 是 | `user` `ai` |
| `resolved-by` | `status` 为 `resolved` 时必填 | D 编号 |

“设计文档和现状不一致”也记为冲突，`between` 写设计文档章节和对应的 D 或 T。

### 引用

- 条目编号：`T12`、`D26`、`C3`，或扩展板块的编号。
- 文档链接：`[文字](相对路径#锚点)`，路径相对于该计划文件（`docs/board/` 下的文件指向项目根的文档要写 `../../`）。锚点按 GitHub 风格由标题生成：小写，去掉标点，空格变 `-`，如 `## 6. 处理流水线` 对应 `#6-处理流水线`。
- 引用字段（`refs`、`between`、`affects`、`supersedes`、`superseded-by`、`resolved-by`）里的编号必须存在，链接指向的文件和锚点必须存在。

## 三、扩展板块

需要记录评测结论之类的新类别时，在 `docs/board/` 下新建文件，开头用 frontmatter 声明：

```markdown
---
section: Findings
prefix: F
status: [valid, superseded]
closed: [superseded]
fields: [date, reference, metric, verdict]
---

## F1 ct-punc 在中文播客上标点 F1 更高
- status: valid
- date: 2026-11-17
- reference: eval/punc-2026-11-17.md
- metric: F1 0.91 vs 0.84
- verdict: adopt
```

- `section` 是显示名，`prefix` 是一个或多个大写字母且不能与 T、D、C 或其他板块重复。
- `status` 列出允许的状态，`closed` 列出其中哪些算已关闭（没有就写 `closed: []`）。
- `fields` 列出额外的必填字段，代码只检查字段齐全和状态取值。
- 条目格式与上面相同。

## 四、write/edit 的 message 与 task

每次调用 write 或 edit 都必须传：

- `message`：一句话写清“改了什么、为什么改”，有 T 或 D 就带上编号。代码只检查长度（10–120 个字符），内容质量由你负责：用户在面板里就靠这句话看你改了什么。
- `task`（可选）：这次改动属于哪个任务，如 `T12`，必须已存在于 `tasks.md`。

合格：

- `标点阶段默认引擎改为 ct-punc，落实 D26`
- `修正 split_chapters 对空章节的越界，T12 对比时发现`
- `新增 T31：等用户决定是否保留旧标点引擎`

不合格（用户看不出变化，即使长度达标也不该这样写）：

- `修改文件`、`更新代码`、`fix`、`update`
- `改了 pipeline.py`（只说改了哪里，没说为什么）
- 与实际改动无关的泛泛描述

## 五、校验与错误处理

对 `docs/board/` 的每次 write/edit，扩展会在执行前算出写入后的内容，整体检查全部计划文件。有新问题就拒绝，并按“文件、行号、编号、怎么改”逐行列出；按提示修改后重新提交同一个调用。检查内容：

1. 每个二级标题有编号和标题，编号前缀与所在文件一致。
2. 字段行紧跟标题，key 已知，必填字段齐全，取值在枚举内。
3. 编号在 `docs/board/` 内唯一；与 git `HEAD` 相比，已存在的编号不能消失。
4. 引用里的编号必须存在。
5. D 甲的 `supersedes` 含 D 乙，则 D 乙必须是 `superseded` 且 `superseded-by` 含 D 甲；反之亦然。
6. `resolved-by` 指向的决定必须是 `active`。
7. 文档链接指向的文件必须存在；带锚点时，锚点对应的标题必须存在。
8. 未关闭的 T，其 `refs` 不能指向 `superseded` 的 D。

做法建议：

- 用 edit 改单个条目；新建文件或大改再用 write。**计划文档的 edit 必须逐字匹配 `oldText`**（空白、引号、标点都要一致）：校验在写入前按精确匹配推算结果，不做模糊匹配，对不上会被拒绝；被拒绝或不确定时先重新 read 该文件再提交。
- 取代一个决定时，新旧两条 D 必须在**同一次调用**里改好：一次 edit（`edits` 数组里放两处替换）或一次 write。只改一边的中间状态会被规则 5 拒绝。
- 跨文件的引用要先建被引用的条目：先新建 D，再让 T 的 `refs`、C 的 `resolved-by` 指向它。
- 取代旧 D 的完整顺序：① 新建 D（先不写 `supersedes`）；② 把未关闭 T 的 `refs` 从旧 D 改指新 D（规则 8）；③ 同一次调用里改旧 D（`superseded`、`superseded-by`）和新 D（加 `supersedes`）。
- 不要用 bash（`>`、`tee`、`sed -i`、`mv`、`rm` 等）改 `docs/board/`，会被拒绝；只读命令（`cat`、`rg`）可以。

## 六、完整示例

`docs/board/tasks.md`：

```markdown
## T12 标点改用 ct-punc
- status: doing
- priority: high
- owner: ai
- next: 在《火线》上对比 ct-punc 与旧结果
- refs: D30, [设计 §6](../../设计方案.md#6-处理流水线)

先在一集上跑通，再批量。

## T13 是否保留旧标点引擎
- status: waiting
- priority: medium
- owner: user
- next: 等用户决定旧引擎是否保留为备选
- refs: D30, C3

## T9 抽取章节标题
- status: done
- priority: low
- owner: ai
- result: 20 集抽样，章节标题完整率 100%
- commits: 3fa9c21
```

`docs/board/decisions.md`：

```markdown
## D26 标点阶段默认用 punc-v1
- status: superseded
- date: 2026-10-30
- by: ai
- reason: 当时只评测过 punc-v1
- superseded-by: D30

## D30 标点阶段默认改用 ct-punc
- status: active
- date: 2026-11-17
- by: user
- rejected: 继续用 punc-v1
- reason: 中文播客上 F1 更高，见 F1
- supersedes: D26
- affects: T12, [设计 §6](../../设计方案.md#6-处理流水线)
```

`docs/board/conflicts.md`：

```markdown
## C3 设计 §6 仍写默认 punc-v1，与 D30 不一致
- status: open
- between: [设计 §6](../../设计方案.md#6-处理流水线), D30
- owner: user
```

C3 解决后：把 `status` 改为 `resolved`，加上 `- resolved-by: D31`（D31 是记录裁决的 `active` 决定）。
