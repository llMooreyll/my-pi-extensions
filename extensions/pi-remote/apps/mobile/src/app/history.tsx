import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { baseName } from "../lib/format";
import { openProcess } from "../lib/nav";
import { useOpenFlow } from "../lib/open";
import { call, errText } from "../net/connection";
import { useStore } from "../state/store";
import { ErrorBox } from "../ui/ErrorBox";
import { Badge, Btn, Card, T } from "../ui/kit";
import { Transcript } from "../ui/Transcript";
import { TrustDialog } from "../ui/TrustDialog";
import { usePalette } from "../ui/theme";

export default function History() {
  const c = usePalette();
  const { sessionFile } = useLocalSearchParams<{ sessionFile: string }>();
  const file = String(sessionFile);
  const [data, setData] = useState<{ cwd: string; name?: string; messages: WireMessage[]; hasMoreBefore: boolean } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState(false);
  const live = useStore((s) => Object.values(s.procs).find((p) => p.sessionFile === file));
  const flow = useOpenFlow();
  useEffect(() => { call("read_session", { sessionFile: file }).then(setData, (e) => setError(errText(e))); }, [file]);
  const loadMore = async () => {
    const first = data?.messages.find((m) => m.entryId)?.entryId;
    if (!first || !data) return;
    try { const r = await call("read_session", { sessionFile: file, beforeEntryId: first }); setData({ ...data, messages: [...r.messages, ...data.messages], hasMoreBefore: r.hasMoreBefore }); }
    catch (e) { setError(errText(e)); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: data?.name ?? (data ? baseName(data.cwd) : "Session") }} />
      <View style={{ padding: 10, gap: 6, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <Badge label="Read-only" color={c.dim} a11y="history-readonly" />
          <T dim size={12} numberOfLines={1} style={{ flex: 1 }}>{data?.cwd}</T>
        </View>
        {live ? <Btn small a11y="history-open-live" kind="primary" label="This session is running → open" onPress={() => openProcess(live.processId)} /> : null}
      </View>
      {error ? <T color={c.danger} style={{ padding: 10 }}>{error}</T> : null}
      {data ? <Transcript messages={data.messages} hasMoreBefore={data.hasMoreBefore} onLoadMore={loadMore} /> : !error ? <ActivityIndicator style={{ marginTop: 40 }} /> : null}
      {!live && data ? (
        confirm ? (
          <Card a11y="history-continue-confirm" style={{ margin: 8, gap: 8 }}>
            <T size={14}>This starts a separate pi on the computer for this session. It will no longer be managed by its original parent agent.</T>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn a11y="history-continue-yes" kind="primary" label="Continue" onPress={() => { setConfirm(false); void flow.openSession(file, data.cwd); }} />
              <Btn a11y="history-continue-no" label="Cancel" onPress={() => setConfirm(false)} />
            </View>
          </Card>
        ) : <Btn a11y="history-continue" label="Continue this session on the computer" busy={!!flow.busy} onPress={() => setConfirm(true)} style={{ margin: 8 }} />
      ) : null}
      <TrustDialog {...flow.trustDialog} />
      <ErrorBox text={flow.error} onClose={flow.clearError} />
    </View>
  );
}
