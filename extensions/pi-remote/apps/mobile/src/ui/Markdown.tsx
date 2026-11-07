import { memo } from "react";
import MarkdownDisplay from "react-native-markdown-display";
import { usePalette } from "./theme";

function MarkdownInner({ text }: { text: string }) {
  const c = usePalette();
  return (
    <MarkdownDisplay
      style={{
        body: { color: c.text, fontSize: 15, lineHeight: 21 },
        code_inline: { backgroundColor: c.code, color: c.text, fontFamily: "monospace", fontSize: 13 },
        code_block: { backgroundColor: c.code, color: c.text, fontFamily: "monospace", fontSize: 12, borderColor: c.border },
        fence: { backgroundColor: c.code, color: c.text, fontFamily: "monospace", fontSize: 12, borderColor: c.border },
        blockquote: { backgroundColor: c.cardAlt, borderColor: c.border },
        link: { color: c.accent },
        table: { borderColor: c.border },
        tr: { borderColor: c.border },
        hr: { backgroundColor: c.border },
      }}
    >
      {text}
    </MarkdownDisplay>
  );
}

export const Markdown = memo(MarkdownInner);
