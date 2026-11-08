import { ATTACH_HEADER, formatBytes, type TransferInfo } from "@pi-remote/protocol";

/** The block appended to a prompt that carries uploaded files (plan 7.7.5): header, then one line per file. */
export function attachmentBlock(files: TransferInfo[]): string {
  const lines = files.map((t) => `${t.computerPath} (${formatBytes(t.size)}${t.mime ? `, ${t.mime}` : ""})`);
  return `${ATTACH_HEADER}\n${lines.join("\n")}`;
}

export function withAttachments(text: string, files: TransferInfo[]): string {
  if (!files.length) return text;
  const body = text.trimEnd();
  return body ? `${body}\n\n${attachmentBlock(files)}` : attachmentBlock(files);
}

export interface AttachedLine { path: string; name: string; meta: string }

/** Split a sent message into what the user wrote and the files block at its end. */
export function splitAttachments(text: string): { body: string; files: AttachedLine[] } {
  const at = text.startsWith(ATTACH_HEADER + "\n") ? 0 : text.lastIndexOf(`\n\n${ATTACH_HEADER}\n`);
  if (at < 0) return { body: text, files: [] };
  const block = text.slice(at === 0 ? 0 : at + 2);
  const lines = block.split("\n").slice(1).filter((l) => l.trim());
  const files = lines.map((l) => {
    const m = /^(.*) \(([^()]*)\)$/.exec(l);
    const path = m ? m[1]! : l;
    return { path, name: path.split("/").pop() || path, meta: m ? m[2]! : "" };
  });
  return { body: at === 0 ? "" : text.slice(0, at), files };
}
