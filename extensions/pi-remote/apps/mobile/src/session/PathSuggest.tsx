import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Txt } from "../ds/primitives";
import { F, usePalette } from "../ds/tokens";
import { useTestAction } from "../lib/test-hooks";
import { call, errText } from "../net/connection";

/** Splits "/home/me/pro" into the folder to list ("/home/me/") and the part being typed ("pro"). */
export function splitPath(text: string): { dir: string; prefix: string } {
  const i = text.lastIndexOf("/");
  if (i < 0) return { dir: text.startsWith("~") ? "~/" : "", prefix: text.startsWith("~") ? "" : text };
  return { dir: text.slice(0, i + 1), prefix: text.slice(i + 1) };
}

/** "~/x" -> "/home/me/x"; trailing slashes dropped. */
export function expandHome(text: string, home: string | undefined): string {
  let t = text.trim();
  if (home && (t === "~" || t.startsWith("~/"))) t = home + t.slice(1);
  return t.length > 1 ? t.replace(/\/+$/, "") : t;
}

function Suggestion({ name, prefix, onPick, a11y }: { name: string; prefix: string; onPick: () => void; a11y: string }) {
  const p = usePalette();
  useTestAction(a11y, onPick);
  const n = prefix && name.toLowerCase().startsWith(prefix.toLowerCase()) ? prefix.length : 0;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPick}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: p.faint, backgroundColor: pressed ? p.tint : "transparent" })}>
      <Txt v="mono" soft style={{ width: 22 }}>↳</Txt>
      <Txt v="mono" lines={1} style={{ flex: 1, fontSize: 13.5 }}>
        <Txt v="mono" style={{ fontFamily: F.monoBold, fontSize: 13.5 }}>{name.slice(0, n)}</Txt>{name.slice(n)}/
      </Txt>
      <Txt v="label" soft>open ›</Txt>
    </Pressable>
  );
}

/**
 * Folder completion under the path field: lists the sub-folders of what has been typed so far
 * (asked from the computer), narrowed by the last segment. Picking one appends it and lists its children.
 */
export function PathSuggest({ value, onChange, onHome }: { value: string; onChange: (t: string) => void; onHome: (home: string) => void }) {
  const p = usePalette();
  const cache = useRef(new Map<string, string[]>());
  const [dirs, setDirs] = useState<string[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const { dir, prefix } = splitPath(value);

  useEffect(() => {
    if (!dir) { setDirs(undefined); setError(undefined); return; }
    const hit = cache.current.get(dir);
    if (hit) { setDirs(hit); setError(undefined); return; }
    let live = true;
    const t = setTimeout(() => {
      call("list_dirs", { path: dir }).then((r) => {
        cache.current.set(dir, r.dirs);
        onHome(r.home);
        if (live) { setDirs(r.dirs); setError(undefined); }
      }, (e) => { if (live) { setDirs(undefined); setError(errText(e)); } });
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [dir]);

  if (!dir) return <Txt v="small" soft style={{ marginTop: 6 }}>Start with / or ~/ to browse the computer's folders.</Txt>;
  if (error) return <Txt v="small" color={p.pink} a11y="path-error" style={{ marginTop: 6 }}>No such folder on the computer.</Txt>;
  if (!dirs) return null;
  const q = prefix.toLowerCase();
  const hidden = q.startsWith(".");
  const pool = dirs.filter((d) => hidden || !d.startsWith("."));
  const starts = pool.filter((d) => d.toLowerCase().startsWith(q));
  const contains = q ? pool.filter((d) => !d.toLowerCase().startsWith(q) && d.toLowerCase().includes(q)) : [];
  const shown = [...starts, ...contains];
  return (
    <View accessibilityLabel="path-suggestions" style={{ marginTop: 4 }}>
      {shown.map((d, i) => <Suggestion key={d} a11y={`path-suggest-${i}`} name={d} prefix={prefix} onPick={() => onChange(`${dir}${d}/`)} />)}
      {!shown.length ? <Txt v="small" soft style={{ marginTop: 6 }}>{q ? "No folder starts with that." : "No sub-folders here."}</Txt> : null}
    </View>
  );
}
