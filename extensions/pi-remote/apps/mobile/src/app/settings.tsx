import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Modal, ScrollView, Switch, View } from "react-native";
import notifee from "react-native-notify-kit";
import { REMOTE_SETTINGS, type RemoteSettingDef } from "@pi-remote/protocol";
import { reloadPrefs } from "../bg/notifications";
import { stopForeground } from "../bg/foreground";
import { clearTrust, loadHosts, loadPrefs, saveHosts, savePrefs, type AppPrefs, type SavedHost } from "../lib/credentials";
import { call, connection, errText } from "../net/connection";
import { candidates, fingerprint, validateWsBase } from "../net/endpoints";
import { parseQr } from "../net/pairing";
import { openSecure } from "../net/secure-ws";
import { useStore } from "../state/store";
import { Btn, Card, Field, Section, T } from "../ui/kit";
import { Option, Sheet } from "../ui/Sheet";
import { usePalette } from "../ui/theme";

function PiSettings() {
  const c = usePalette();
  const conn = useStore((s) => s.conn);
  const [values, setValues] = useState<Record<string, unknown> | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pick, setPick] = useState<RemoteSettingDef | undefined>();
  useEffect(() => { if (conn === "ready") call("get_settings", {}).then((r) => setValues(r.values), (e) => setError(errText(e))); }, [conn]);
  const set = async (key: string, value: unknown) => {
    try { setValues((await call("set_setting", { key, value })).values); setError(undefined); } catch (e) { setError(errText(e)); }
  };
  const note = (d: RemoteSettingDef) => d.applies === "reload" ? "Running pi processes reload when idle" : d.applies === "new_session" ? "Applies to new sessions" : "Only affects this app";
  return (
    <Section title="pi settings (global)">
      {conn !== "ready" ? <T dim>Connect to the computer to edit pi settings.</T> : null}
      {error ? <T color={c.danger} a11y="settings-error">{error}</T> : null}
      {conn === "ready" && !values && !error ? <ActivityIndicator /> : null}
      {values ? REMOTE_SETTINGS.map((d) => (
        <Card key={d.key} a11y={`setting-${d.key}`} onPress={d.type === "enum" ? () => setPick(d) : undefined} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <T>{d.label}</T>
            <T dim size={12}>{note(d)}</T>
          </View>
          {d.type === "boolean"
            ? <Switch accessibilityLabel={`setting-switch-${d.key}`} value={values[d.key] === true} onValueChange={(v) => void set(d.key, v)} />
            : <T color={c.accent} a11y={`setting-value-${d.key}`}>{values[d.key] === undefined ? "Default" : String(values[d.key])}</T>}
        </Card>
      )) : null}
      {pick ? (
        <Sheet visible a11y="setting-pick" title={pick.label} onClose={() => setPick(undefined)}>
          {(pick.options ?? []).map((o) => <Option key={o} a11y={`setting-option-${o}`} label={o} selected={values?.[pick.key] === o} onPress={() => { const k = pick.key; setPick(undefined); void set(k, o); }} />)}
        </Sheet>
      ) : null}
    </Section>
  );
}

function ConnectionSettings() {
  const c = usePalette();
  const st = useStore();
  const [host, setHost] = useState<SavedHost | undefined>();
  const [relay, setRelay] = useState("");
  const [direct, setDirect] = useState("");
  const [msg, setMsg] = useState<string | undefined>();
  const [tests, setTests] = useState<string[] | undefined>();
  const [scanning, setScanning] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const load = async () => {
    const h = (await loadHosts())[0];
    setHost(h);
    setRelay(h?.endpoint.relays[0] ?? "");
    setDirect(h?.endpoint.direct ?? "");
  };
  useEffect(() => { void load(); }, []);
  if (!host) return <Section title="Connection"><T dim>Not paired.</T><Btn a11y="settings-pair" kind="primary" label="Pair with computer" onPress={() => router.push("/pair")} /></Section>;

  const save = async () => {
    try {
      const relays = relay.trim() ? [validateWsBase(relay)] : [];
      const d = direct.trim() ? validateWsBase(direct) : undefined;
      if (!relays.length && !d) throw new Error("Enter a relay address or a direct address");
      const next: SavedHost = { ...host, endpoint: { ...host.endpoint, relays, ...(d ? { direct: d } : {}) } };
      if (!d) delete next.endpoint.direct;
      await saveHosts([next]);
      setHost(next);
      setMsg("Saved. Reconnecting…");
      await connection.reconnectNow();
    } catch (e) { setMsg((e as Error).message); }
  };

  const test = async () => {
    setTests(["Testing…"]);
    const out: string[] = [];
    for (const cand of candidates(host.endpoint)) {
      try { const s = await openSecure(cand.url, host.endpoint.hostKey, cand.via === "direct" ? 4000 : 10000); s.close(); out.push(`✓ ${cand.via} ${cand.base}: OK`); }
      catch (e) { out.push(`✗ ${cand.via} ${cand.base}: ${(e as Error).message}`); }
      setTests([...out]);
    }
    if (!out.length) setTests(["No address configured"]);
  };

  const applyEndpointQr = async (raw: string) => {
    const r = parseQr(raw);
    if (!r.ok) { setMsg(r.error); return; }
    if (r.qr.hostId !== host.endpoint.hostId || r.qr.hostKey !== host.endpoint.hostKey) { setMsg("This QR code belongs to another computer"); return; }
    const next: SavedHost = { ...host, endpoint: { ...host.endpoint, hostName: r.qr.hostName, relays: r.qr.relays } };
    if (r.qr.direct) next.endpoint.direct = r.qr.direct; else delete next.endpoint.direct;
    await saveHosts([next]);
    await load();
    setMsg("Connection info updated. Reconnecting…");
    await connection.reconnectNow();
  };

  return (
    <Section title="Connection">
      <Card style={{ gap: 4 }}>
        <T a11y="settings-hostname">Computer: {host.endpoint.hostName}</T>
        <T dim size={12} mono>Host ID: {host.endpoint.hostId}</T>
        <T dim size={12} mono a11y="settings-fingerprint">Key: {fingerprint(host.endpoint.hostKey)}</T>
        <T dim size={12} mono>Device ID: {host.deviceId}</T>
        <T dim size={12}>pi-hostd {st.hostVersion ?? "?"} · {st.conn === "ready" ? (st.via === "direct" ? "direct" : "via relay") : st.conn}</T>
        {st.lastError ? <T size={12} color={c.warn}>{st.lastError}</T> : null}
      </Card>
      <T dim size={13}>Relay address</T>
      <Field a11y="settings-relay-input" value={relay} onChangeText={setRelay} placeholder="ws://203.0.113.5:7443 or wss://relay.example.com" autoCapitalize="none" autoCorrect={false} />
      <T dim size={13}>Direct address (optional)</T>
      <Field a11y="settings-direct-input" value={direct} onChangeText={setDirect} placeholder="ws://192.168.1.10:7444" autoCapitalize="none" autoCorrect={false} />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Btn a11y="settings-save-conn" kind="primary" label="Save" onPress={() => void save()} />
        <Btn a11y="settings-test-conn" label="Test connection" onPress={() => void test()} />
        <Btn a11y="settings-scan-endpoint" label="Scan connection QR" onPress={async () => {
          if (!perm?.granted) { const p = await requestPerm(); if (!p.granted) { setMsg("Camera permission denied"); return; } }
          setScanning(true);
        }} />
      </View>
      {msg ? <T a11y="settings-conn-msg" size={13}>{msg}</T> : null}
      {tests ? <Card a11y="settings-test-results">{tests.map((t, i) => <T key={i} size={13} a11y={`settings-test-${i}`}>{t}</T>)}</Card> : null}
      {confirmUnpair ? (
        <Card style={{ gap: 8 }}>
          <T size={14}>Remove this computer from the phone? Also run on the computer: pi-hostd devices revoke {host.deviceId}</T>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn a11y="settings-unpair-yes" kind="danger" label="Unpair" onPress={async () => { await saveHosts([]); connection.disconnect(); await stopForeground(); router.replace("/pair"); }} />
            <Btn a11y="settings-unpair-no" label="Cancel" onPress={() => setConfirmUnpair(false)} />
          </View>
        </Card>
      ) : <Btn a11y="settings-unpair" kind="danger" label="Unpair" onPress={() => setConfirmUnpair(true)} />}
      <Modal visible={scanning} onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: "black" }}>
          <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => { setScanning(false); void applyEndpointQr(data); }} />
          <Btn a11y="settings-scan-cancel" label="Cancel" onPress={() => setScanning(false)} style={{ margin: 16 }} />
        </View>
      </Modal>
      <T dim size={12}>Tip: pasting the text of pi-hostd qr also works:</T>
      <PasteEndpoint onApply={(t) => void applyEndpointQr(t)} />
    </Section>
  );
}

function PasteEndpoint({ onApply }: { onApply: (t: string) => void }) {
  const [t, setT] = useState("");
  return (
    <View style={{ gap: 6 }}>
      <Field a11y="settings-endpoint-input" value={t} onChangeText={setT} placeholder='{"v":2,"kind":"endpoint",...}' autoCapitalize="none" autoCorrect={false} multiline />
      <Btn small a11y="settings-endpoint-apply" label="Apply connection info" disabled={!t.trim()} onPress={() => { onApply(t); setT(""); }} />
    </View>
  );
}

function AppSettings() {
  const [prefs, setPrefs] = useState<AppPrefs | undefined>();
  const [msg, setMsg] = useState<string | undefined>();
  useEffect(() => { void loadPrefs().then(setPrefs); }, []);
  if (!prefs) return null;
  const update = async (p: AppPrefs) => { setPrefs(p); await savePrefs(p); await reloadPrefs(); };
  return (
    <Section title="App">
      <Card style={{ flexDirection: "row", alignItems: "center" }}>
        <T style={{ flex: 1 }}>Keep connected in background</T>
        <Switch accessibilityLabel="settings-keepalive" value={prefs.keepAlive} onValueChange={(v) => void update({ ...prefs, keepAlive: v })} />
      </Card>
      <Card style={{ flexDirection: "row", alignItems: "center" }}>
        <T style={{ flex: 1 }}>Notify when a subagent finishes</T>
        <Switch accessibilityLabel="settings-notify-child" value={prefs.notifyChildDone} onValueChange={(v) => void update({ ...prefs, notifyChildDone: v })} />
      </Card>
      <Btn a11y="settings-battery" label="Battery optimization settings" onPress={() => { notifee.openBatteryOptimizationSettings().catch(() => Linking.openSettings()); }} />
      <Btn a11y="settings-clear-trust" label="Clear remembered trust choices" onPress={async () => { await clearTrust(); setMsg("Cleared"); }} />
      {msg ? <T dim size={13}>{msg}</T> : null}
    </Section>
  );
}

export default function SettingsScreen() {
  return (
    <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <PiSettings />
      <ConnectionSettings />
      <AppSettings />
    </ScrollView>
  );
}
