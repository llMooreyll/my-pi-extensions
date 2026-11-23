import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { formatBytes, type ProcessInfo, type TransferInfo } from "@pi-remote/protocol";
import { ErrorDialog } from "../ds/common";
import { Button, Pad, Rule, Screen, SectionHead, Txt } from "../ds/primitives";
import { F, GUTTER, MARGIN, usePalette } from "../ds/tokens";
import { baseName, processTitle, relTime } from "../lib/format";
import { openProcess, openSessionFile } from "../lib/nav";
import { pickFiles } from "../lib/pick";
import { useTestAction } from "../lib/test-hooks";
import { errText } from "../net/connection";
import { FileRow } from "../session/FileRow";
import { useStore } from "../state/store";
import { dismiss, filesSupported, isPendingOffer, startDownload, undismiss, uploadFiles, useTransfers } from "../state/transfers";

/** Files of one conversation, or of the Files page itself. */
interface Group { key: string; title: string; folder?: string; sessionFile?: string; processId?: string; items: TransferInfo[]; latest: number }

/** One group per conversation; transfers nothing is known about share one group instead of one each. */
function groupKey(t: TransferInfo, procs: Record<string, ProcessInfo>): string {
  if (t.origin?.sessionFile) return t.origin.sessionFile;
  const live = t.processId ? procs[t.processId] : undefined;
  if (live) return live.sessionFile ?? live.processId;
  if (t.origin?.cwd) return `cwd:${t.origin.cwd}`;
  return t.dir === "to_computer" && !t.processId ? "files-page" : "unknown";
}

function buildGroups(list: TransferInfo[], procs: Record<string, ProcessInfo>): Group[] {
  const map = new Map<string, Group>();
  for (const t of list) {
    const key = groupKey(t, procs);
    let g = map.get(key);
    if (!g) {
      const live = (t.processId ? procs[t.processId] : undefined)
        ?? (t.origin?.sessionFile ? Object.values(procs).find((x) => x.sessionFile === t.origin!.sessionFile) : undefined);
      const folder = t.origin?.cwd ?? live?.cwd;
      const title = live ? processTitle(live) : t.origin?.title || (folder ? baseName(folder) : key === "files-page" ? "Sent from the Files page" : "Earlier files");
      g = { key, title, folder, sessionFile: t.origin?.sessionFile ?? live?.sessionFile, processId: live?.processId, items: [], latest: 0 };
      map.set(key, g);
    }
    g.items.push(t);
    g.latest = Math.max(g.latest, t.createdAt);
  }
  return [...map.values()].sort((a, b) => b.latest - a.latest);
}

/** "3 files · 1 waiting · 2 sent to the computer" */
function groupCounts(g: Group, pending: (t: TransferInfo) => boolean): { text: string; waiting: number } {
  const toPhone = g.items.filter((t) => t.dir === "to_phone").length;
  const toComputer = g.items.length - toPhone;
  const waiting = g.items.filter(pending).length;
  const parts = [
    toPhone ? `${toPhone} from the computer` : "",
    toComputer ? `${toComputer} to the computer` : "",
  ].filter(Boolean);
  return { text: parts.join(" · "), waiting };
}

function GroupHead({ g, index, open, onToggle, counts }: { g: Group; index: string; open: boolean; onToggle: () => void; counts: { text: string; waiting: number } }) {
  const p = usePalette();
  const a11y = `files-group-${index}`;
  useTestAction(a11y, onToggle);
  const size = g.items.reduce((n, t) => n + t.size, 0);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onToggle}
      style={({ pressed }) => ({ flexDirection: "row", paddingVertical: 14, paddingRight: MARGIN, borderBottomWidth: 1, borderBottomColor: p.faint, backgroundColor: pressed ? p.tint : "transparent" })}>
      <View style={{ width: GUTTER + MARGIN, paddingLeft: MARGIN }}>
        {counts.waiting ? <View style={{ position: "absolute", left: 0, top: -14, bottom: -14, width: 3, backgroundColor: p.pink }} /> : null}
        <Txt v="label" color={counts.waiting ? p.pink : p.soft}>{index}</Txt>
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Txt v="lead" lines={open ? undefined : 2}>{g.title}</Txt>
        <Txt v="mono" soft lines={1} style={{ fontSize: 11 }}>{[g.folder && baseName(g.folder) !== g.title ? baseName(g.folder) : "", `${g.items.length} file${g.items.length > 1 ? "s" : ""}`, formatBytes(size)].filter(Boolean).join(" · ")}</Txt>
        <Txt v="small" soft style={{ fontSize: 12 }}>
          {counts.waiting ? <Txt v="small" color={p.pink} style={{ fontSize: 12 }}>{counts.waiting} waiting · </Txt> : null}
          {counts.text} · latest {relTime(g.latest)}
        </Txt>
      </View>
      <Txt v="mono" soft style={{ paddingLeft: 10, fontFamily: F.monoBold }}>{open ? "−" : "+"}</Txt>
    </Pressable>
  );
}

/** Everything moving between the computer and this phone: what waits, what moves, and the record per conversation. */
export default function Files() {
  const p = usePalette();
  const st = useTransfers();
  const procs = useStore((s) => s.procs);
  const conn = useStore((s) => s.conn);
  useStore((s) => s.features);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showAside, setShowAside] = useState(false);
  const supported = filesSupported();

  const all = useMemo(() => Object.values(st.items).sort((a, b) => b.createdAt - a.createdAt), [st.items]);
  const pending = (t: TransferInfo) => isPendingOffer(st, t);
  const moving = (t: TransferInfo) => !!st.progress[t.id]?.running || !!st.progress[t.id]?.queued || (t.dir === "to_computer" && (t.state === "waiting" || t.state === "active"));
  const waiting = all.filter(pending);
  const active = all.filter(moving);
  const aside = all.filter((t) => st.dismissed[t.id] && t.state === "waiting" && !st.local[t.id] && !moving(t));
  const asideIds = new Set(aside.map((t) => t.id));
  const groups = useMemo(() => buildGroups(all.filter((t) => !asideIds.has(t.id)), procs), [all, procs, st.dismissed]);
  const origin = (t: TransferInfo) => buildGroups([t], procs)[0]?.title;
  const onPhone = all.filter((t) => st.local[t.id]).length;

  const send = async () => {
    setBusy(true);
    try {
      const files = await pickFiles();
      if (files?.length) await uploadFiles(files);
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  const list = (items: TransferInfo[], bare: boolean) => (
    <Pad indent>
      {items.map((t, i) => (
        <View key={t.id}>
          {i ? <Rule color={p.faint} /> : null}
          <FileRow id={t.id} full bare={bare} origin={bare ? undefined : origin(t)} />
        </View>
      ))}
    </Pad>
  );

  return (
    <Screen back kicker="between computer and phone" title="Files"
      footer={supported ? <Button kind="solid" a11y="files-send" label={busy ? "Choosing…" : "Send a file to the computer"} arrow="↑" busy={busy} disabled={conn !== "ready"} onPress={() => void send()} /> : undefined}>
      {!supported ? (
        <Pad style={{ paddingTop: 16 }}>
          <Txt v="body" soft>{conn !== "ready" ? "Not connected to the computer." : "File transfer needs the Android app and an up-to-date pi-hostd on the computer."}</Txt>
        </Pad>
      ) : (
        <>
          <Pad style={{ paddingTop: 10 }}>
            <Txt v="mono" soft a11y="files-summary" style={{ fontSize: 12 }}>
              {[`${waiting.length} waiting`, active.length ? `${active.length} moving` : "", `${onPhone} on this phone`, aside.length ? `${aside.length} not now` : ""].filter(Boolean).join("  ·  ")}
            </Txt>
          </Pad>

          <SectionHead n="01" title="Waiting for you" a11y="files-waiting" color={waiting.length ? p.pink : undefined}
            right={waiting.length > 1 ? <Txt v="label" color={p.pink}>{waiting.length}</Txt> : undefined} />
          {waiting.length ? (
            <>
              {list(waiting, false)}
              <Pad indent style={{ flexDirection: "row", gap: 18, paddingTop: 6 }}>
                {waiting.length > 1 ? <Button kind="outline" compact a11y="files-download-all" label={`download all ${waiting.length}`} color={p.pink} onPress={() => waiting.forEach((t) => startDownload(t.id))} /> : null}
                <Button compact a11y="files-dismiss-all" label={waiting.length > 1 ? "not now, all" : "not now"} onPress={() => dismiss(waiting.map((t) => t.id))} />
              </Pad>
            </>
          ) : <Pad indent><Txt v="small" soft style={{ paddingVertical: 10 }}>Nothing to download. Ask pi to send you a file.</Txt></Pad>}

          {active.length ? (
            <>
              <SectionHead n="02" title="Moving now" a11y="files-active" color={p.blue} />
              {list(active, false)}
            </>
          ) : null}

          <SectionHead n={active.length ? "03" : "02"} title="By conversation" a11y="files-groups" right={groups.length ? <Txt v="label" soft>{groups.length}</Txt> : undefined} />
          {groups.length ? groups.map((g, i) => {
            const isOpen = !!open[g.key];
            const counts = groupCounts(g, pending);
            return (
              <View key={g.key} accessibilityLabel={`files-group-box-${i + 1}`}>
                <GroupHead g={g} index={String(i + 1).padStart(2, "0")} open={isOpen} counts={counts} onToggle={() => setOpen({ ...open, [g.key]: !isOpen })} />
                {isOpen ? (
                  <View style={{ paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: p.faint }}>
                    {list(g.items, true)}
                    {g.processId || g.sessionFile ? (
                      <Pad indent style={{ paddingTop: 4 }}>
                        <Button compact a11y={`files-group-open-${i + 1}`} label="open the conversation →" color={p.blue}
                          onPress={() => (g.processId ? openProcess(g.processId) : openSessionFile(g.sessionFile!))} />
                      </Pad>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          }) : <Pad indent><Txt v="small" soft style={{ paddingVertical: 10 }}>No transfers yet.</Txt></Pad>}

          {aside.length ? (
            <>
              <SectionHead n={active.length ? "04" : "03"} title="Not now" a11y="files-aside"
                right={<Button compact a11y="files-aside-toggle" label={showAside ? "hide" : `show ${aside.length}`} onPress={() => setShowAside(!showAside)} />} />
              <Pad indent><Txt v="small" soft style={{ paddingTop: 8 }}>Set aside: kept on the computer until they expire, never downloaded on their own.</Txt></Pad>
              {showAside ? (
                <>
                  {list(aside, false)}
                  <Pad indent style={{ paddingTop: 6 }}>
                    <Button compact a11y="files-aside-restore" label="move all back to waiting" onPress={() => undismiss(aside.map((t) => t.id))} />
                  </Pad>
                </>
              ) : null}
            </>
          ) : null}

          {st.inboxDir ? (
            <Pad indent style={{ paddingTop: 22 }}>
              <Txt v="label" soft>files you send arrive on the computer in</Txt>
              <Txt v="mono" selectable a11y="files-inbox">{st.inboxDir}</Txt>
            </Pad>
          ) : null}
        </>
      )}
      <ErrorDialog text={error} onClose={() => setError(undefined)} />
    </Screen>
  );
}
