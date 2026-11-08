import { useState } from "react";
import { View } from "react-native";
import { formatBytes, type TransferInfo } from "@pi-remote/protocol";
import { Button, Txt } from "../ds/primitives";
import { F, usePalette } from "../ds/tokens";
import { relTime } from "../lib/format";
import { cancel, forget, openLocal, removeLocal, saveToFolder, shareLocal, startDownload, useTransfers } from "../state/transfers";

/** Thin bar under a moving file; the filled part is the share already acknowledged. */
export function ProgressLine({ value, color }: { value: number; color: string }) {
  const p = usePalette();
  return (
    <View style={{ height: 3, backgroundColor: p.faint, marginTop: 6 }}>
      <View style={{ height: 3, width: `${Math.max(0, Math.min(1, value)) * 100}%`, backgroundColor: color }} />
    </View>
  );
}

const pct = (bytes: number, size: number) => (size ? Math.floor((bytes / size) * 100) : 100);

function daysLeft(at: number): string {
  const h = (at - Date.now()) / 3_600_000;
  if (h < 1) return "expires within the hour";
  if (h < 48) return `expires in ${Math.round(h)} h`;
  return `expires in ${Math.round(h / 24)} days`;
}

/**
 * One file in either direction: name, size, where it stands, and what can be done with it now.
 * `known` covers files mentioned in old messages after hostd forgot them.
 */
export function FileRow(props: { id: string; known?: { name: string; size: number }; full?: boolean; origin?: string }) {
  const p = usePalette();
  const t = useTransfers((s) => s.items[props.id]) as TransferInfo | undefined;
  const pr = useTransfers((s) => s.progress[props.id]);
  const local = useTransfers((s) => !!s.local[props.id]);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | undefined>();
  const a = (s: string) => `file-${s}-${props.id}`;
  const name = t?.name ?? props.known?.name ?? "file";
  const size = t?.size ?? props.known?.size ?? 0;
  const toPhone = (t?.dir ?? "to_phone") === "to_phone";

  const say = (text: string | undefined, bad = true) => setNote(text ? { text, bad } : undefined);
  let status: string;
  let statusColor = p.soft;
  const actions: { label: string; a11y: string; run: () => void | Promise<void>; kind?: "outline" | "text"; color?: string }[] = [];
  const running = !!pr?.running;
  const queued = !!pr?.queued && !running;

  if (!t) {
    status = "no longer available";
  } else if (toPhone) {
    if (local) {
      status = "on this phone";
      statusColor = p.ok;
      actions.push({ label: "open", a11y: a("open"), run: async () => say(await openLocal(t.id)), kind: "outline" });
      actions.push({ label: "share", a11y: a("share"), run: async () => say(await shareLocal(t.id)) });
      actions.push({ label: "save to folder", a11y: a("save"), run: async () => { try { say(`Saved as ${await saveToFolder(t.id)}`, false); } catch (e) { say((e as Error)?.message ?? String(e)); } } });
      if (props.full) actions.push({ label: "delete from phone", a11y: a("delete-local"), run: () => removeLocal(t.id), color: p.danger });
    } else if (running) {
      status = `receiving ${pct(pr!.bytes, size)}%`;
      statusColor = p.blue;
      actions.push({ label: "stop", a11y: a("stop"), run: () => cancel(t.id) });
    } else if (queued) {
      status = pr?.error ? `retrying · ${pr.error}` : "waiting to start";
      statusColor = p.blue;
    } else if (t.state === "expired") status = "expired on the computer";
    else if (t.state === "cancelled") status = "cancelled";
    else if (t.state === "failed" && t.error?.code === "changed") { status = "changed on the computer — ask pi to send it again"; statusColor = p.danger; }
    else if (t.state === "failed") { status = t.error?.message ?? "failed"; statusColor = p.danger; }
    else {
      const until = t.expiresAt ? ` · ${daysLeft(t.expiresAt)}` : "";
      status = pr?.error ? pr.error : pr?.bytes ? `paused at ${pct(pr.bytes, size)}%` : t.state === "done" ? `downloaded before, not on this phone now${until}` : `waiting${until}`;
      if (pr?.error) statusColor = p.danger;
      actions.push({ label: pr?.bytes ? "resume" : t.state === "done" ? "download again" : "download", a11y: a("download"), run: () => startDownload(t.id), kind: "outline", color: p.pink });
    }
  } else {
    if (t.state === "done") { status = "saved on the computer"; statusColor = p.ok; }
    else if (running) {
      status = `sending ${pct(pr!.bytes, size)}%`;
      statusColor = p.blue;
      actions.push({ label: "cancel", a11y: a("cancel"), run: () => cancel(t.id), color: p.danger });
    } else if (queued) { status = pr?.error ? `retrying · ${pr.error}` : "waiting to start"; statusColor = p.blue; }
    else if (t.state === "cancelled") status = "cancelled";
    else if (t.state === "expired") status = "expired";
    else { status = pr?.error ?? "interrupted — pick the file again"; statusColor = p.danger; }
  }
  if (props.full && t && (t.state !== "waiting" || !toPhone) && !running) actions.push({ label: "remove", a11y: a("forget"), run: () => forget(t.id) });

  const bytes = pr?.bytes ?? 0;
  return (
    <View accessibilityLabel={`file-${props.id}`} style={{ paddingVertical: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Txt v="mono" color={toPhone ? p.pink : p.blue} style={{ fontFamily: F.monoBold, width: 14 }}>{toPhone ? "↓" : "↑"}</Txt>
        <Txt v="mono" style={{ flex: 1, fontFamily: F.monoBold }} lines={2} selectable>{name}</Txt>
        <Txt v="mono" soft>{formatBytes(size)}</Txt>
      </View>
      <View style={{ marginLeft: 22 }}>
        <Txt v="label" color={statusColor} a11y={a("status")} style={{ marginTop: 2 }}>{status}</Txt>
        {running || (bytes > 0 && !local && (t?.state === "waiting" || t?.state === "active")) ? <ProgressLine value={size ? bytes / size : 1} color={running ? p.blue : p.faint} /> : null}
        {!toPhone && t?.state === "done" && t.computerPath ? <Txt v="mono" soft selectable style={{ fontSize: 11, marginTop: 2 }}>{t.computerPath}</Txt> : null}
        {props.full && t?.note ? <Txt v="small" soft style={{ marginTop: 2 }}>“{t.note}”</Txt> : null}
        {props.full && (props.origin || t) ? <Txt v="small" soft style={{ marginTop: 2, fontSize: 12 }}>{[props.origin, t ? relTime(t.createdAt) : undefined].filter(Boolean).join(" · ")}</Txt> : null}
        {actions.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 14, marginTop: 8 }}>
            {actions.map((x) => <Button key={x.a11y} a11y={x.a11y} label={x.label} kind={x.kind ?? "text"} compact color={x.color} onPress={() => { setNote(undefined); void x.run(); }} />)}
          </View>
        ) : null}
        {note ? <Txt v="small" color={note.bad ? p.danger : p.ok} a11y={a("note")} style={{ marginTop: 6 }}>{note.text}</Txt> : null}
      </View>
    </View>
  );
}
