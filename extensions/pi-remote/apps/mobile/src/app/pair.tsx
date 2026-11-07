import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import type { PairQr } from "@pi-remote/protocol";
import { loadHosts, saveHosts } from "../lib/credentials";
import { connection } from "../net/connection";
import { fingerprint } from "../net/endpoints";
import { pairWithQr, parseQr } from "../net/pairing";
import { requestNotificationPermission } from "../bg/notifications";
import { useStore } from "../state/store";
import { Btn, Card, Field, T } from "../ui/kit";
import { usePalette } from "../ui/theme";

function deviceName(): string {
  const d = Constants.deviceName;
  return d ? `Android ${d}` : "Android";
}

export default function PairScreen() {
  const c = usePalette();
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
    if (r.qr.kind === "endpoint") { setError("This is a connection-info code. Scan it in Settings → Connection."); return; }
    setError(undefined);
    if (fromLink) setConfirmQr(r.qr); else void doPair(r.qr);
  };

  useEffect(() => {
    if (typeof params.qr === "string" && params.qr) accept(params.qr, true);
  }, [params.qr]);

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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: "black" }}>
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => { setScanning(false); accept(data, false); }}
        />
        <Btn a11y="pair-scan-cancel" label="Cancel" onPress={() => setScanning(false)} style={{ margin: 16 }} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
      <T dim>On the computer run <T mono>pi-hostd pair</T>, then scan the QR code it prints.</T>
      <Btn a11y="pair-scan-button" kind="primary" label="Scan QR code" busy={busy} onPress={async () => {
        if (!perm?.granted) { const p = await requestPerm(); if (!p.granted) { setError("Camera permission denied"); return; } }
        setScanning(true);
      }} />
      <T dim>Or paste the pairing info printed below the QR code:</T>
      <Field a11y="pair-text-input" value={text} onChangeText={setText} placeholder='{"v":2,"kind":"pair",...}' multiline style={{ minHeight: 90, textAlignVertical: "top" }} autoCapitalize="none" autoCorrect={false} />
      <Btn a11y="pair-text-submit" label="Pair" busy={busy} disabled={!text.trim()} onPress={() => accept(text, false)} />
      {error ? <T a11y="pair-error" color={c.danger}>{error}</T> : null}
      {confirmQr ? (
        <Card a11y="pair-confirm-card" style={{ gap: 8 }}>
          <T bold>Pair with this computer?</T>
          <T a11y="pair-confirm-host">Computer: {confirmQr.hostName}</T>
          <T mono size={13}>Key: {fingerprint(confirmQr.hostKey)}</T>
          <T size={13} dim>Relay: {confirmQr.relays.join(", ") || "(none)"}{confirmQr.direct ? `\nDirect: ${confirmQr.direct}` : ""}</T>
          {already ? <T color={c.warn} size={13}>This replaces the computer currently paired with this phone.</T> : null}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Btn a11y="pair-confirm-button" kind="primary" label="Pair" onPress={() => void doPair(confirmQr)} />
            <Btn a11y="pair-confirm-cancel" label="Cancel" onPress={() => setConfirmQr(undefined)} />
          </View>
        </Card>
      ) : null}
      {busy ? <T dim a11y="pair-busy">Pairing…</T> : null}
      {already && !confirmQr ? <Btn a11y="pair-back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} /> : null}
    </ScrollView>
  );
}

