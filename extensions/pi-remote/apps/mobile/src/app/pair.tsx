import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { PairQr } from "@pi-remote/protocol";
import { requestNotificationPermission } from "../bg/notifications";
import { Button, Dialog, Field, Pad, Screen, SectionHead, Txt } from "../ds/primitives";
import { MARGIN, usePalette } from "../ds/tokens";
import { loadHosts, saveHosts } from "../lib/credentials";
import { connection } from "../net/connection";
import { fingerprint } from "../net/endpoints";
import { pairWithQr, parseQr } from "../net/pairing";
import { useStore } from "../state/store";

const deviceName = () => (Constants.deviceName ? `Android ${Constants.deviceName}` : "Android");

export default function PairScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{ qr?: string }>();
  const [text, setText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(useStore.getState().lastError);
  const [confirmQr, setConfirmQr] = useState<PairQr | undefined>();
  const [already, setAlready] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();

  useEffect(() => { loadHosts().then((h) => setAlready(h.length > 0)); }, []);

  const accept = (raw: string, fromLink: boolean) => {
    const r = parseQr(raw);
    if (!r.ok) { setError(r.error); return; }
    if (r.qr.kind === "endpoint") { setError("That is a connection-info code. Use it in Settings → Connection."); return; }
    setError(undefined);
    if (fromLink) setConfirmQr(r.qr); else void doPair(r.qr);
  };
  useEffect(() => { if (typeof params.qr === "string" && params.qr) accept(params.qr, true); }, [params.qr]);

  const doPair = async (qr: PairQr) => {
    setConfirmQr(undefined);
    setBusy(true);
    setError(undefined);
    try {
      const saved = await pairWithQr(qr, deviceName());
      await saveHosts([saved]);
      await requestNotificationPermission();
      await connection.reconnectNow();
      if (router.canDismiss()) router.dismissAll(); else router.replace("/");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: "black" }}>
        <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => { setScanning(false); accept(data, false); }} />
        <Button kind="solid" a11y="pair-scan-cancel" label="Cancel scanning" arrow="✕" onPress={() => setScanning(false)} />
      </View>
    );
  }

  return (
    <Screen back={already} kicker="pi remote" title="Pair this phone"
      footer={busy ? <Txt v="label" color={p.blue} a11y="pair-busy" style={{ padding: MARGIN }}>● pairing…</Txt> : undefined}>
      <Pad style={{ paddingTop: 18 }}>
        <Txt v="em">Your phone talks to the computer through an encrypted channel. Pairing happens once.</Txt>
      </Pad>
      <SectionHead n="01" title="On the computer" />
      <Pad indent style={{ paddingTop: 10, gap: 6 }}>
        <Txt v="body">Open a terminal and run</Txt>
        <Txt v="mono" selectable style={{ fontSize: 15 }}>pi-hostd pair</Txt>
        <Txt v="small" soft>It prints a QR code and a one-time code valid for 10 minutes.</Txt>
      </Pad>
      <SectionHead n="02" title="Scan it" />
      <Pad indent style={{ paddingTop: 12 }}>
        <Button kind="solid" a11y="pair-scan-button" label="Open the camera" busy={busy} onPress={async () => {
          if (!perm?.granted) { const r = await requestPerm(); if (!r.granted) { setError("Camera permission was denied."); return; } }
          setScanning(true);
        }} />
      </Pad>
      <SectionHead n="03" title="…or paste it" />
      <Pad indent style={{ paddingTop: 10, gap: 12 }}>
        <Field a11y="pair-text-input" label="the JSON printed under the QR code" value={text} onChangeText={setText} placeholder='{"v":2,"kind":"pair",…}' multiline mono autoCapitalize="none" autoCorrect={false} style={{ minHeight: 70 }} />
        <Button kind="outline" a11y="pair-text-submit" label="pair with this text" style={{ alignSelf: "flex-start" }} busy={busy} disabled={!text.trim()} onPress={() => accept(text, false)} />
      </Pad>
      {error ? <Pad indent style={{ paddingTop: 18 }}><Txt v="body" color={p.danger} a11y="pair-error">{error}</Txt></Pad> : null}
      {already ? <Pad indent style={{ paddingTop: 18 }}><Button a11y="pair-back" label="keep the current computer" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} /></Pad> : null}

      <Dialog visible={!!confirmQr} title="Pair with this computer?" a11y="pair-confirm-card" onClose={() => setConfirmQr(undefined)}
        actions={<>
          <Button kind="solid" a11y="pair-confirm-button" label="Pair" onPress={() => confirmQr && void doPair(confirmQr)} />
          <Button kind="outline" a11y="pair-confirm-cancel" label="cancel" onPress={() => setConfirmQr(undefined)} />
        </>}>
        {confirmQr ? (
          <View style={{ gap: 8 }}>
            <Txt v="title" a11y="pair-confirm-host">{confirmQr.hostName}</Txt>
            <Txt v="label" soft>key fingerprint</Txt>
            <Txt v="mono" style={{ fontSize: 15 }}>{fingerprint(confirmQr.hostKey)}</Txt>
            <Txt v="label" soft>reached via</Txt>
            <Txt v="mono">{[...confirmQr.relays, confirmQr.direct].filter(Boolean).join("\n") || "(no address)"}</Txt>
            {already ? <Txt v="small" color={p.pink}>This replaces the computer this phone is paired with now.</Txt> : null}
            <Txt v="small" soft>Only continue if you just ran pi-hostd pair yourself.</Txt>
          </View>
        ) : null}
      </Dialog>
    </Screen>
  );
}
