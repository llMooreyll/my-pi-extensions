import * as Clipboard from "expo-clipboard";
import { createContext, useContext, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { hasCJK } from "../ds/cjk";
import { Button, Sheet, Txt } from "../ds/primitives";
import { F, usePalette } from "../ds/tokens";
import { Seg } from "./Sheets";

/**
 * Android selects text only inside one Text view, and a rendered message is many (paragraphs, list items,
 * code, tables). This sheet shows a whole message as a single Text, so any range of it can be selected.
 */
export const SelectContext = createContext<(text: string) => void>(() => {});
export const useSelectText = () => useContext(SelectContext);

/** Markdown to plain text, keeping line structure: drops fences, heading marks, emphasis and quote marks. */
export function plainText(md: string): string {
  return md
    .replace(/^```.*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function SelectSheet({ text, onClose }: { text?: string; onClose: () => void }) {
  const p = usePalette();
  const [plain, setPlain] = useState(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t); }, [copied]);
  useEffect(() => { setCopied(false); }, [text]);
  const shown = text === undefined ? "" : plain ? plainText(text) : text;
  const cjk = hasCJK(shown);
  return (
    <Sheet visible={text !== undefined} a11y="select-sheet" kicker="press and drag to select" title="Select text" onClose={onClose}
      footer={<Button kind="solid" a11y="select-copy-all" label={copied ? "Copied" : "Copy all"} arrow={copied ? "✓" : "→"} onPress={() => { void Clipboard.setStringAsync(shown); setCopied(true); }} />}>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 12, marginBottom: 12 }}>
        <Seg a11y="select-plain" label="plain text" on={plain} onPress={() => setPlain(true)} />
        <Seg a11y="select-markdown" label="markdown" on={!plain} onPress={() => setPlain(false)} />
      </View>
      <Text selectable accessibilityLabel="select-text"
        style={{ color: p.ink, fontFamily: plain ? (cjk ? F.cjkSans : F.sans) : F.mono, fontSize: plain ? 15.5 : 13, lineHeight: plain ? 26 : 20 }}>
        {shown}
      </Text>
      <Txt v="label" faint style={{ marginTop: 14 }}>{shown.length} characters</Txt>
    </Sheet>
  );
}
