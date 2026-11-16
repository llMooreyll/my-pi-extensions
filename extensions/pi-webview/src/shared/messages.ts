/** Plain text of a message's content (text parts only). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text")
    .map((c) => String((c as { text?: unknown }).text ?? ""))
    .join("");
}

/** Latest thinking text from an assistant message's content array. */
export function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "thinking")
    .map((c) => String((c as { thinking?: unknown }).thinking ?? ""))
    .join("\n")
    .trim();
}

/** Name of the last toolCall block currently present in an assistant message. */
export function toolCallNameOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const c = content[i];
    if (c && typeof c === "object" && (c as { type?: unknown }).type === "toolCall") {
      const name = (c as { name?: unknown }).name;
      if (typeof name === "string" && name) return name;
    }
  }
  return undefined;
}
