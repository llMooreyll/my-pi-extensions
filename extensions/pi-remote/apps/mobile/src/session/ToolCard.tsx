import { createContext, memo, useContext, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { Button, Spinner, Txt } from "../ds/primitives";
import { F, usePalette, type Palette } from "../ds/tokens";
import { openSessionFile } from "../lib/nav";
import { TEST_HOOKS, useTestAction } from "../lib/test-hooks";
import { FoldBar, useAnchor } from "./anchor";
import { FileRow } from "./FileRow";
import { PatchView } from "./PatchView";
import { describeTool, formatDuration, textOfResult, type ToolFamily } from "./toolView";

const MAX_LINES = 200;

/** The session folder, so paths inside it are shown relative. */
export const ToolCwdContext = createContext<string | undefined>(undefined);

export function familyColor(f: ToolFamily, p: Palette): string {
  switch (f) {
    case "web": case "agent": case "team": return p.blue;
    case "user": return p.pink;
    case "file": case "shell": case "code": return p.ink;
    default: return p.soft;
  }
}

/** Ticks once a second while a tool runs. */
function Elapsed({ since, color }: { since: number; color: string }) {
  const [now, setNow] = useState(Date.now());
  // Test builds keep it still, like Spinner: uiautomator cannot read a window that keeps changing.
  useEffect(() => { if (TEST_HOOKS) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return <Txt v="mono" color={color} style={{ fontSize: 11 }}>{formatDuration(Math.max(0, now - since))}</Txt>;
}

type Result = WireMessage & { isError?: boolean; truncated?: boolean; details?: Record<string, unknown>; durationMs?: number; nestedCalls?: { calls?: { id: string; name: string; status: string; durationMs?: number; error?: string }[]; complete?: boolean } };

/**
 * One tool call: a rail in the tool's family colour, a header with what kind of call it is and how long it took,
 * the thing it acted on in bold mono, then why, what and the outcome. Tapping opens the output.
 */
function ToolCardInner(props: { id: string; name: string; args: unknown; result?: WireMessage; running?: { partialText: string; startedAt?: number }; pending?: boolean }) {
  const p = usePalette();
  const cwd = useContext(ToolCwdContext);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const r = props.result as Result | undefined;
  const isError = !!r?.isError;
  const live = !!props.running || !!props.pending;
  const v = describeTool(props.name, props.args, r, cwd);
  const text = r ? textOfResult(r) : "";
  const lines = text.split("\n");
  const images = Array.isArray(r?.content) ? (r!.content as { type?: string; mimeType?: string }[]).filter((c) => c?.type === "image") : [];
  const patch = props.name === "edit" && typeof r?.details?.patch === "string" ? (r.details.patch as string) : undefined;
  const nested = r?.nestedCalls?.calls ?? [];
  const childFile = (props.name === "subagent" || props.name === "subagent_resume") ? ((r?.details?.sessionFile ?? r?.details?.sessionPath) as string | undefined) : undefined;
  const sent = props.name === "send_to_phone" && !isError && Array.isArray(r?.details?.transfers)
    ? (r!.details!.transfers as { id: string; name: string; size: number }[]).filter((x) => x && typeof x.id === "string")
    : undefined;
  const fam = familyColor(v.family, p);
  const rail = isError ? p.danger : live ? p.blue : fam;
  const anchor = useAnchor();
  const toggle = () => { anchor("top"); setOpen((o) => !o); };
  useTestAction(`tool-toggle-${props.id}`, r ? toggle : undefined);
  const shell = v.family === "shell";
  const partial = props.running?.partialText ? props.running.partialText.split("\n").filter((l, i, a) => l || i < a.length - 1).slice(-8).join("\n") : "";

  return (
    <View accessibilityLabel={`tool-${props.id}`} style={{ flexDirection: "row", marginVertical: 5 }}>
      <View style={{ width: 3, backgroundColor: rail, opacity: live || isError ? 1 : 0.85 }} />
      <View style={{ flex: 1, paddingLeft: 10 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`tool-toggle-${props.id}`} onPress={toggle} disabled={!r}
          style={({ pressed }) => ({ paddingVertical: 2, backgroundColor: pressed ? p.tint : "transparent", gap: 3 })}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Txt v="label" color={isError ? p.danger : fam} style={{ fontFamily: F.monoBold, letterSpacing: 1.2 }}>{v.verb}</Txt>
            {v.diff ? (
              <Txt v="mono" style={{ fontSize: 11 }}>
                <Txt v="mono" color={p.ok} style={{ fontSize: 11, fontFamily: F.monoBold }}>+{v.diff.add}</Txt>
                <Txt v="mono" soft style={{ fontSize: 11 }}> </Txt>
                <Txt v="mono" color={p.danger} style={{ fontSize: 11, fontFamily: F.monoBold }}>−{v.diff.del}</Txt>
              </Txt>
            ) : null}
            <View style={{ flex: 1 }} />
            {live ? (props.running?.startedAt ? <Elapsed since={props.running.startedAt} color={p.blue} /> : null)
              : r?.durationMs !== undefined ? <Txt v="mono" soft style={{ fontSize: 11 }}>{formatDuration(r.durationMs)}</Txt> : null}
            <View style={{ width: 16, alignItems: "center" }}>
              {live ? <Spinner color={p.blue} /> : <Txt v="mono" color={isError ? p.danger : p.soft} style={{ fontFamily: F.monoBold }}>{isError ? "✕" : r ? (open ? "−" : "+") : "·"}</Txt>}
            </View>
          </View>
          <Txt v="mono" color={isError ? p.danger : p.ink} style={{ fontFamily: F.monoBold, fontSize: 13 }} lines={open ? undefined : shell ? 4 : 2}>
            {shell ? <Txt v="mono" soft style={{ fontFamily: F.monoBold, fontSize: 13 }}>$ </Txt> : null}{v.target}
          </Txt>
          {v.why ? <Txt v="small" soft lines={open ? undefined : 2} style={{ fontFamily: F.serifItalic, fontSize: 15 }}>↳ {v.why}</Txt> : null}
          {v.body ? <Txt v="small" lines={open ? undefined : 3} style={{ fontSize: 13.5 }}>{v.body}</Txt> : null}
          {v.meta ? <Txt v="mono" color={isError ? p.danger : p.soft} lines={open ? undefined : 1} style={{ fontSize: 11 }}>{v.meta}</Txt> : null}
        </Pressable>
        {partial ? (
          <View style={{ backgroundColor: p.tint, paddingHorizontal: 8, paddingVertical: 5, marginTop: 4 }}>
            <Txt v="mono" soft style={{ fontSize: 11 }}>{partial}</Txt>
          </View>
        ) : null}
        {open && r ? (
          <View style={{ marginTop: 6, gap: 6 }}>
            {patch ? <PatchView patch={patch} /> : text ? (
              <View style={{ backgroundColor: p.tint, paddingHorizontal: 8, paddingVertical: 6 }}>
                <Txt v="mono" selectable style={{ fontSize: 11.5 }}>{(all ? lines : lines.slice(0, MAX_LINES)).join("\n")}</Txt>
              </View>
            ) : <Txt v="small" soft>no output</Txt>}
            {!patch && lines.length > MAX_LINES && !all ? <Button a11y={`tool-showall-${props.id}`} label={`show all ${lines.length} lines`} onPress={() => { anchor("top"); setAll(true); }} /> : null}
            {images.length ? <Txt v="label" soft>{images.length} image{images.length > 1 ? "s" : ""} for the model, not sent to the phone</Txt> : null}
            {nested.length ? (
              <View accessibilityLabel={`tool-nested-${props.id}`} style={{ gap: 2 }}>
                <Txt v="label" soft>tool calls made by the script{r.nestedCalls?.complete === false ? " (not all recorded)" : ""}</Txt>
                {nested.map((c, i) => (
                  <View key={c.id ?? i} style={{ flexDirection: "row", gap: 8 }}>
                    <Txt v="mono" color={c.status === "ok" ? p.soft : p.danger} style={{ fontSize: 11, width: 12 }}>{c.status === "ok" ? "·" : c.status === "error" ? "✕" : "…"}</Txt>
                    <Txt v="mono" style={{ fontSize: 11, flex: 1 }} lines={1}>{c.name}{c.error ? ` — ${c.error}` : ""}</Txt>
                    {c.durationMs !== undefined ? <Txt v="mono" soft style={{ fontSize: 11 }}>{formatDuration(c.durationMs)}</Txt> : null}
                  </View>
                ))}
              </View>
            ) : null}
            {r.truncated ? <Txt v="label" soft>output shortened for the phone</Txt> : null}
            <FoldBar a11y={`tool-fold-${props.id}`} onFold={() => { setOpen(false); setAll(false); }} />
          </View>
        ) : null}
        {sent?.length ? (
          // Files offered to the phone stay visible: they are something to act on, not a log to fold away.
          <View accessibilityLabel={`tool-files-${props.id}`} style={{ marginTop: 4 }}>
            {sent.map((f) => <FileRow key={f.id} id={f.id} known={{ name: f.name, size: f.size }} />)}
          </View>
        ) : null}
        {childFile ? <View style={{ marginTop: 4 }}><Button a11y={`tool-open-child-${props.id}`} label="open the subagent →" color={p.blue} onPress={() => openSessionFile(childFile)} /></View> : null}
      </View>
    </View>
  );
}

export const ToolCard = memo(ToolCardInner);
