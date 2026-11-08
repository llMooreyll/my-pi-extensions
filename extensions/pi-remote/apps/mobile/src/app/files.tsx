import { useState } from "react";
import { View } from "react-native";
import type { TransferInfo } from "@pi-remote/protocol";
import { ErrorDialog } from "../ds/common";
import { Button, Pad, Rule, Screen, SectionHead, Txt } from "../ds/primitives";
import { usePalette } from "../ds/tokens";
import { processTitle } from "../lib/format";
import { pickFiles } from "../lib/pick";
import { errText } from "../net/connection";
import { FileRow } from "../session/FileRow";
import { useStore } from "../state/store";
import { filesSupported, uploadFiles, useTransfers } from "../state/transfers";

/** Everything moving between the computer and this phone, in both directions. */
export default function Files() {
  const p = usePalette();
  const items = useTransfers((s) => s.items);
  const progress = useTransfers((s) => s.progress);
  const local = useTransfers((s) => s.local);
  const inboxDir = useTransfers((s) => s.inboxDir);
  const procs = useStore((s) => s.procs);
  const conn = useStore((s) => s.conn);
  useStore((s) => s.features);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const supported = filesSupported();

  const all = Object.values(items).sort((a, b) => b.createdAt - a.createdAt);
  const moving = (t: TransferInfo) => !!progress[t.id]?.running || !!progress[t.id]?.queued;
  const waiting = all.filter((t) => t.dir === "to_phone" && t.state === "waiting" && !local[t.id] && !moving(t));
  const active = all.filter((t) => moving(t) || (t.dir === "to_computer" && (t.state === "waiting" || t.state === "active")));
  const shown = new Set([...waiting, ...active].map((t) => t.id));
  const done = all.filter((t) => !shown.has(t.id));
  const origin = (t: TransferInfo) => {
    const pr = t.processId ? procs[t.processId] : undefined;
    return pr ? processTitle(pr) : t.dir === "to_computer" && !t.processId ? "sent from Files" : undefined;
  };

  const send = async () => {
    setBusy(true);
    try {
      const files = await pickFiles();
      if (files?.length) await uploadFiles(files);
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  const section = (n: string, title: string, list: TransferInfo[], a11y: string, empty: string) => (
    <>
      <SectionHead n={n} title={title} a11y={a11y} color={n === "01" && list.length ? p.pink : undefined} />
      <Pad indent>
        {list.length ? list.map((t, i) => (
          <View key={t.id}>
            {i ? <Rule color={p.faint} /> : null}
            <FileRow id={t.id} full origin={origin(t)} />
          </View>
        )) : <Txt v="small" soft style={{ paddingVertical: 10 }}>{empty}</Txt>}
      </Pad>
    </>
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
          {section("01", "Waiting for you", waiting, "files-waiting", "Nothing to download. Ask pi to send you a file.")}
          {section("02", "In progress", active, "files-active", "Nothing moving right now.")}
          {section("03", "Done", done, "files-done", "No finished transfers yet.")}
          {inboxDir ? (
            <Pad indent style={{ paddingTop: 18 }}>
              <Txt v="label" soft>files you send arrive on the computer in</Txt>
              <Txt v="mono" selectable a11y="files-inbox">{inboxDir}</Txt>
            </Pad>
          ) : null}
        </>
      )}
      <ErrorDialog text={error} onClose={() => setError(undefined)} />
    </Screen>
  );
}
