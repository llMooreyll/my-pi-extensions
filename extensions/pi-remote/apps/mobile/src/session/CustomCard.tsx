import { useState, type ReactNode } from "react";
import { View } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { Button, Txt } from "../ds/primitives";
import { F, usePalette } from "../ds/tokens";
import { textOf } from "../lib/format";
import { openSessionFile } from "../lib/nav";
import { FoldBar, useAnchor } from "./anchor";
import { Markdown } from "./Markdown";
import { formatDuration } from "./toolView";

function Folded({ text, lines, a11y }: { text: string; lines: number; a11y: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useAnchor();
  const all = text.split("\n");
  const long = all.length > lines;
  return (
    <View>
      <Markdown text={open || !long ? text : all.slice(0, lines).join("\n")} />
      {long && !open ? <Button a11y={a11y} label={`read all ${all.length} lines`} onPress={() => { anchor("top"); setOpen(true); }} /> : null}
      {long && open ? <FoldBar a11y={a11y} onFold={() => setOpen(false)} /> : null}
    </View>
  );
}

/** A message an extension put into the conversation: a rail in its colour, a header, then the text. */
function Dispatch({ a11y, color, head, right, children }: { a11y: string; color: string; head: string; right?: string; children?: ReactNode }) {
  const p = usePalette();
  return (
    <View accessibilityLabel={a11y} style={{ flexDirection: "row", marginVertical: 6 }}>
      <View style={{ width: 3, backgroundColor: color }} />
      <View style={{ flex: 1, paddingLeft: 10, gap: 5 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Txt v="label" color={color} style={{ fontFamily: F.monoBold, letterSpacing: 1.2, flex: 1 }}>{head}</Txt>
          {right ? <Txt v="mono" soft style={{ fontSize: 11 }}>{right}</Txt> : null}
        </View>
        {children}
      </View>
    </View>
  );
}

/** One line for small notices (model fallback, web status): a mark and the text, no frame. */
function Notice({ a11y, mark, color, text }: { a11y: string; mark: string; color: string; text: string }) {
  return (
    <View accessibilityLabel={a11y} style={{ flexDirection: "row", gap: 8, marginVertical: 3 }}>
      <Txt v="mono" color={color} style={{ fontSize: 11, fontFamily: F.monoBold }}>{mark}</Txt>
      <Txt v="mono" color={color} style={{ fontSize: 11, flex: 1 }}>{text}</Txt>
    </View>
  );
}

/** Messages that extensions inject: subagents, team mail, web search, notices. */
export function CustomCard({ m, idx }: { m: WireMessage; idx: number }) {
  const p = usePalette();
  const type = String(m.customType ?? "custom");
  const d = (m.details ?? {}) as Record<string, any>;
  const text = textOf(m.content);
  const a11y = `custom-${type}-${idx}`;
  const open = typeof d.sessionFile === "string"
    ? <Button a11y={`custom-open-child-${idx}`} label="open the subagent session →" color={p.blue} onPress={() => openSessionFile(d.sessionFile)} />
    : null;
  const who = `${d.name ?? ""}${d.agent ? ` (${d.agent})` : ""}`;
  switch (type) {
    case "subagent_result": {
      const failed = !!(d.exitCode || d.error || d.errorMessage);
      const took = typeof d.elapsed === "number" ? formatDuration(d.elapsed * 1000) : undefined;
      return (
        <Dispatch a11y={a11y} color={failed ? p.danger : p.blue} head={`subagent · ${who}`} right={[failed ? (d.exitCode ? `failed · exit ${d.exitCode}` : "failed") : "finished", took].filter(Boolean).join(" · ")}>
          {d.task ? <Txt v="small" soft lines={2}>{String(d.task)}</Txt> : null}
          {d.errorMessage || d.error ? <Txt v="small" color={p.danger}>{String(d.errorMessage ?? d.error)}</Txt> : null}
          <Folded text={text} lines={12} a11y={`custom-more-${idx}`} />
          {open}
        </Dispatch>
      );
    }
    case "subagent_ping":
      return (
        <Dispatch a11y={a11y} color={p.pink} head={`subagent · ${who}`} right="needs help">
          <Txt v="em">{String(d.message ?? text)}</Txt>
          {open}
        </Dispatch>
      );
    case "subagent_status":
      return (
        <Dispatch a11y={a11y} color={p.soft} head="subagents running">
          {(Array.isArray(d.lines) ? d.lines : [text]).map((l: string, i: number) => <Txt key={i} v="mono" soft style={{ fontSize: 11 }}>{l}</Txt>)}
          {d.overflow ? <Txt v="mono" soft style={{ fontSize: 11 }}>+{d.overflow} more running</Txt> : null}
        </Dispatch>
      );
    case "subagent_model_fallback": return <Notice a11y={a11y} mark="↻" color={p.soft} text={text} />;
    case "team_notice": return <Notice a11y={a11y} mark={d.level === "warn" ? "▲" : "◇"} color={d.level === "warn" ? p.pink : p.soft} text={text.replace(/^\[team\]\s*/, "team — ")} />;
    case "team_message": {
      const items = Array.isArray(d.items) ? d.items : undefined;
      if (!items) return <Dispatch a11y={a11y} color={p.blue} head="team mail"><Markdown text={text} /></Dispatch>;
      return (
        <View accessibilityLabel={a11y}>
          {items.map((it: Record<string, any>, i: number) => {
            const col = it.status === "failed" || it.status === "blocked" ? p.danger : it.kind === "question" ? p.pink : it.status === "done" ? p.ok : p.blue;
            const mark = it.kind === "question" ? "?" : it.kind === "task" ? "◆" : it.status === "done" ? "✓" : it.status === "blocked" ? "!" : it.status === "failed" ? "✕" : "…";
            if (it.kind === "cc") return <Notice key={i} a11y={`${a11y}-${i}`} mark="↳" color={p.soft} text={`${it.from ?? "?"}: ${String(it.body ?? "").split("\n")[0]}`} />;
            return (
              <Dispatch key={i} a11y={`${a11y}-${i}`} color={col} head={`${mark} team · from ${it.from ?? "?"}`} right={[it.kind, it.status].filter(Boolean).join(" · ")}>
                <Folded text={String(it.body ?? "")} lines={8} a11y={`custom-more-${idx}-${i}`} />
              </Dispatch>
            );
          })}
        </View>
      );
    }
    // pi-web-access
    case "web-search-results":
      return <Dispatch a11y={a11y} color={p.blue} head="web search results" right={typeof d.totalResults === "number" ? `${d.totalResults} results` : undefined}><Folded text={text} lines={8} a11y={`custom-more-${idx}`} /></Dispatch>;
    case "web-search-content-ready": return <Notice a11y={a11y} mark="↓" color={p.blue} text={text} />;
    case "web-search-error": return <Notice a11y={a11y} mark="✕" color={p.danger} text={text} />;
    case "curator-config":
    case "google-account": return <Notice a11y={a11y} mark="◇" color={p.soft} text={text} />;
    default:
      return <Dispatch a11y={a11y} color={p.soft} head={type.replace(/[-_]/g, " ")}><Folded text={text} lines={12} a11y={`custom-more-${idx}`} /></Dispatch>;
  }
}
