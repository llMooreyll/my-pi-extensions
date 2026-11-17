// Prompt text injected in projects with docs/board/ (DESIGN §7). The full format lives in skills/pi-board/SKILL.md.

export const RULES_SECTION = "pi-board";

export const RULES_TEXT = [
	"This project keeps its plan in docs/board/ (tasks.md, decisions.md, conflicts.md and extension sections). The user reads that board instead of documents or code.",
	"Before you touch plan documents, read the `pi-board` skill (skills/pi-board/SKILL.md) for the file format and the full rules. In short:",
	"1. When the user states a new requirement, changes an old one or makes a decision, record a D entry or create/update a T entry first, then change code.",
	"2. When you record a new D, compare it with every active D and the related design sections; on a contradiction add a C entry with `owner: user` and do not carry out work related to it until the user decides.",
	"3. Set a task to `doing` when you start it; set it to `done` with `result` when finished.",
	"4. Anything the user has to decide becomes a T with `status: waiting` and `owner: user`; do not only ask in the conversation.",
	"5. Commit docs/board/ together with the code whenever you commit code.",
	"6. Every write and edit call needs `message` (one sentence, what changed and why, e.g. \"Default punctuation engine switched to ct-punc, implementing D26\"; vague text such as \"update file\" breaks the user's change view, so it is not acceptable). The code only checks the length, 10-120 characters; the quality is your responsibility. Pass `task` (e.g. T12) when the change belongs to a task.",
	"Plan documents are validated on every write/edit and a failing change is rejected with the list of problems; edits to them must copy oldText verbatim (read the file first). Only the lead agent may change them, and never through bash.",
].join("\n");

/** For team members and subagents: they cannot change the plan, but their write/edit calls still need a message. */
export const MEMBER_RULES_TEXT = [
	"This project keeps its plan in docs/board/. Only the lead agent may change it; do not write it (not even through bash). Describe plan changes you need in your report to the lead instead.",
	"Every write and edit call needs `message` (one sentence, what changed and why, e.g. \"Default punctuation engine switched to ct-punc, implementing D26\"; vague text such as \"update file\" breaks the user's change view, so it is not acceptable). The code only checks the length, 10-120 characters; the quality is your responsibility. Pass `task` (e.g. T12) when the change belongs to a task.",
].join("\n");

export const WRITE_GUIDELINE =
	"Use write with `message` (10-120 characters, one sentence: what changed and why) on every call, and `task` (e.g. T12) when the change belongs to a task.";
export const EDIT_GUIDELINE =
	"Use edit with `message` (10-120 characters, one sentence: what changed and why) on every call, and `task` (e.g. T12) when the change belongs to a task.";

export const REMINDER_TEXT =
	"[pi-board] You changed a code file before updating docs/board/ in this turn. If the user's last message added or changed a requirement or made a decision, record it in docs/board/ now (D or T entry, see the pi-board skill) before more code changes; otherwise ignore this note.";
