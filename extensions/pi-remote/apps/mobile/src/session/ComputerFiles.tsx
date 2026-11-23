import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { formatBytes, type DirEntry } from "@pi-remote/protocol";
import { Button, Field, Sheet, Spinner, Txt } from "../ds/primitives";
import { F, usePalette } from "../ds/tokens";
import { relTime } from "../lib/format";
import { useTestAction } from "../lib/test-hooks";
import { call, errText } from "../net/connection";

/** pi's own @-reference form: relative to the session folder when inside it, quoted when it has spaces. */
export function fileRef(path: string, cwd: string): string {
  const rel = path === cwd ? "." : path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
  return /[\s"']/.test(rel) ? `@"${rel}"` : `@${rel}`;
}

const parentOf = (path: string) => (path === "/" ? "/" : path.slice(0, path.lastIndexOf("/")) || "/");
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

function EntryRow({ e, picked, onPress, a11y }: { e: DirEntry; picked: boolean; onPress: () => void; a11y: string }) {
  const p = usePalette();
  useTestAction(a11y, onPress);
  const hidden = e.name.startsWith(".");
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: p.faint, backgroundColor: pressed || picked ? p.tint : "transparent" })}>
      <View style={{ width: 18, alignItems: "center" }}>
        {e.dir ? <Txt v="mono" soft style={{ fontFamily: F.monoBold }}>›</Txt>
          : <View style={{ width: 12, height: 12, borderWidth: 1.5, borderColor: picked ? p.pink : p.soft, backgroundColor: picked ? p.pink : "transparent" }} />}
      </View>
      <View style={{ flex: 1 }}>
        <Txt v="mono" lines={1} color={hidden ? p.soft : undefined} style={{ fontFamily: e.dir || picked ? F.monoBold : F.mono, fontSize: 13.5 }}>{e.name}{e.dir ? "/" : ""}</Txt>
      </View>
      <Txt v="mono" soft style={{ fontSize: 11 }}>{e.dir ? (e.mtime ? relTime(e.mtime) : "") : formatBytes(e.size ?? 0)}</Txt>
    </Pressable>
  );
}

/**
 * Browse the computer from the session folder and pick files to mention to pi. Nothing is copied: pi gets
 * @-references and reads the files itself.
 */
export function ComputerFilesSheet(props: { visible: boolean; cwd: string; onPick: (refs: string[]) => void; onClose: () => void }) {
  const p = usePalette();
  const [dir, setDir] = useState(props.cwd);
  const [entries, setEntries] = useState<DirEntry[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => { if (props.visible) { setDir(props.cwd); setPicked([]); setFilter(""); } }, [props.visible, props.cwd]);
  useEffect(() => {
    if (!props.visible) return;
    let live = true;
    setEntries(undefined);
    setError(undefined);
    call("list_entries", { path: dir }).then((r) => { if (live) setEntries(r.entries); }, (e) => { if (live) setError(errText(e)); });
    return () => { live = false; };
  }, [dir, props.visible]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = entries ?? [];
    return q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all.filter((e) => !e.name.startsWith("."));
  }, [entries, filter]);
  const hiddenCount = (entries ?? []).filter((e) => e.name.startsWith(".")).length;

  const toggle = (path: string) => setPicked(picked.includes(path) ? picked.filter((x) => x !== path) : [...picked, path]);
  const go = (path: string) => { setDir(path); setFilter(""); };
  const inCwd = dir === props.cwd;
  const shortDir = dir.startsWith(props.cwd + "/") ? `./${dir.slice(props.cwd.length + 1)}` : inCwd ? "." : dir;

  return (
    <Sheet visible={props.visible} a11y="computer-files" kicker="file on the computer" title="Mention a file" onClose={props.onClose}
      footer={
        <View style={{ gap: 10 }}>
          {picked.length ? <Txt v="mono" soft lines={2} style={{ fontSize: 11 }}>{picked.map((x) => fileRef(x, props.cwd)).join(" ")}</Txt> : null}
          <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
            <Button kind="solid" a11y="computer-files-insert" style={{ flex: 1 }} disabled={!picked.length}
              label={picked.length ? `Mention ${picked.length} file${picked.length > 1 ? "s" : ""}` : "Pick files below"}
              onPress={() => props.onPick(picked.map((x) => fileRef(x, props.cwd)))} />
            <Button compact a11y="computer-files-folder" label="this folder" onPress={() => props.onPick([fileRef(dir, props.cwd)])} />
          </View>
        </View>
      }>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 12 }}>
        <Txt v="mono" style={{ flex: 1, fontFamily: F.monoBold, fontSize: 12.5 }} lines={2} a11y="computer-files-dir">{shortDir}</Txt>
        {dir !== "/" ? <Button compact a11y="computer-files-up" label="↑ up" onPress={() => go(parentOf(dir))} /> : null}
        {!inCwd ? <Button compact a11y="computer-files-home" label="session folder" onPress={() => go(props.cwd)} /> : null}
      </View>
      <View style={{ marginTop: 8 }}>
        <Field a11y="computer-files-filter" value={filter} onChangeText={setFilter} placeholder="filter this folder" autoCapitalize="none" autoCorrect={false} mono />
      </View>
      {error ? <Txt v="small" color={p.danger} a11y="computer-files-error" style={{ marginTop: 10 }}>{error}</Txt> : null}
      {!entries && !error ? <View style={{ paddingVertical: 14 }}><Spinner /></View> : null}
      {shown.map((e, i) => {
        const path = join(dir, e.name);
        return <EntryRow key={e.name} e={e} a11y={`computer-files-entry-${i}`} picked={picked.includes(path)} onPress={() => (e.dir ? go(path) : toggle(path))} />;
      })}
      {entries && !shown.length ? <Txt v="small" soft style={{ marginTop: 10 }}>{filter ? "Nothing here matches." : "This folder is empty."}</Txt> : null}
      {entries && !filter && hiddenCount ? <Txt v="small" soft style={{ marginTop: 10 }}>{hiddenCount} hidden — type "." to show them</Txt> : null}
    </Sheet>
  );
}
