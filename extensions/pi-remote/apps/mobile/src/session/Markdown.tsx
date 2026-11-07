import { memo } from "react";
import MarkdownDisplay from "react-native-markdown-display";
import { F, usePalette } from "../ds/tokens";

function MarkdownInner({ text, color }: { text: string; color?: string }) {
  const p = usePalette();
  const ink = color ?? p.ink;
  return (
    <MarkdownDisplay
      style={{
        body: { color: ink, fontSize: 15.5, lineHeight: 23, fontFamily: F.sans },
        strong: { fontFamily: F.sansBold, fontWeight: "normal" },
        heading1: { fontFamily: F.serif, fontSize: 28, lineHeight: 32, marginTop: 10, marginBottom: 4 },
        heading2: { fontFamily: F.serif, fontSize: 23, lineHeight: 27, marginTop: 10 },
        heading3: { fontFamily: F.serifItalic, fontSize: 20, marginTop: 8 },
        code_inline: { backgroundColor: p.tint, color: ink, fontFamily: F.mono, fontSize: 13, borderWidth: 0 },
        code_block: { backgroundColor: "transparent", color: ink, fontFamily: F.mono, fontSize: 12, borderWidth: 0, borderLeftWidth: 1, borderColor: p.soft, borderRadius: 0, paddingLeft: 10 },
        fence: { backgroundColor: "transparent", color: ink, fontFamily: F.mono, fontSize: 12, borderWidth: 0, borderLeftWidth: 1, borderColor: p.soft, borderRadius: 0, paddingLeft: 10 },
        blockquote: { backgroundColor: "transparent", borderLeftWidth: 1, borderColor: p.pink, paddingLeft: 12, marginLeft: 0 },
        link: { color: p.blue, textDecorationLine: "underline" },
        bullet_list_icon: { color: p.soft, fontFamily: F.mono },
        ordered_list_icon: { color: p.soft, fontFamily: F.mono },
        table: { borderColor: ink, borderRadius: 0 },
        th: { fontFamily: F.sansBold },
        tr: { borderColor: p.faint },
        hr: { backgroundColor: p.faint, height: 1 },
      }}
    >
      {text}
    </MarkdownDisplay>
  );
}

export const Markdown = memo(MarkdownInner);
