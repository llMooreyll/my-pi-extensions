import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { ErrorDialog, TrustDialog } from "../ds/common";
import { Button, Dialog, Screen, Spinner, Txt } from "../ds/primitives";
import { MARGIN, usePalette } from "../ds/tokens";
import { baseName } from "../lib/format";
import { openProcess } from "../lib/nav";
import { useOpenFlow } from "../lib/open";
import { call, errText } from "../net/connection";
import { Transcript } from "../session/Transcript";
import { useStore } from "../state/store";

/** A session that is not running, read from its file. Nothing here can change it. */
export default function History() {
  const p = usePalette();
  const { sessionFile } = useLocalSearchParams<{ sessionFile: string }>();
  const file = String(sessionFile);
  const [data, setData] = useState<{ cwd: string; name?: string; messages: WireMessage[]; hasMoreBefore: boolean } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState(false);
  const live = useStore((s) => Object.values(s.procs).find((x) => x.sessionFile === file));
  const flow = useOpenFlow();
  const conn = useStore((s) => s.conn);
  useEffect(() => { if (conn === "ready" && !data) call("read_session", { sessionFile: file }).then(setData, (e) => setError(errText(e))); }, [file, conn]);
  const loadMore = async () => {
    const first = data?.messages.find((m) => m.entryId)?.entryId;
    if (!first || !data) return;
    try { const r = await call("read_session", { sessionFile: file, beforeEntryId: first }); setData({ ...data, messages: [...r.messages, ...data.messages], hasMoreBefore: r.hasMoreBefore }); }
    catch (e) { setError(errText(e)); }
  };
  return (
    <Screen back scroll={false} kicker={data ? `read only — ${baseName(data.cwd)}` : "read only"} title={data?.name ?? "Past session"}
      footer={live ? (
        <Button kind="solid" a11y="history-open-live" label="It is running — open it" color={p.blue} onPress={() => openProcess(live.processId)} />
      ) : data ? (
        <Button kind="solid" a11y="history-continue" label="Continue it on the computer" busy={!!flow.busy} onPress={() => setConfirm(true)} />
      ) : undefined}>
      <View accessibilityLabel="history-readonly" />
      {error ? <Txt v="small" color={p.danger} style={{ padding: MARGIN }}>{error}</Txt> : null}
      {data ? <Transcript messages={data.messages} hasMoreBefore={data.hasMoreBefore} onLoadMore={loadMore} /> : !error ? <View style={{ padding: MARGIN }}><Spinner /></View> : null}
      <Dialog visible={confirm} title="Start a separate pi?" a11y="history-continue-confirm" onClose={() => setConfirm(false)}
        actions={<>
          <Button kind="solid" a11y="history-continue-yes" label="Start it" onPress={() => { setConfirm(false); if (data) void flow.openSession(file, data.cwd); }} />
          <Button a11y="history-continue-no" label="cancel" onPress={() => setConfirm(false)} />
        </>}>
        <Txt v="body">A new pi opens this session on the computer. If it came from a subagent, its original parent will not manage it any more.</Txt>
      </Dialog>
      <TrustDialog {...flow.trustDialog} />
      <ErrorDialog text={flow.error} onClose={flow.clearError} />
    </Screen>
  );
}
