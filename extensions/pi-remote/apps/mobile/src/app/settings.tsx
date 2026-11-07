import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, Modal, Pressable, View } from "react-native";
import { REMOTE_SETTINGS, type RemoteSettingDef } from "@pi-remote/protocol";
import { stopForeground } from "../bg/foreground";
import { reloadPrefs } from "../bg/notifications";
import { openBatteryOptimization } from "../bg/platform";
import { Button, Choice, Field, Pad, Screen, SectionHead, Sheet, Spinner, Toggle, Txt } from "../ds/primitives";
import { F, GUTTER, MARGIN, usePalette } from "../ds/tokens";
import { clearTrust, loadHosts, loadPrefs, saveHosts, savePrefs, type AppPrefs, type SavedHost } from "../lib/credentials";
import { useTestAction } from "../lib/test-hooks";
import { call, connection, errText } from "../net/connection";
import { candidates, fingerprint, validateWsBase } from "../net/endpoints";
import { parseQr } from "../net/pairing";
import { openSecure } from "../net/secure-ws";
import { useStore } from "../state/store";

function Fact({ k, v, a11y }: { k: string; v: string; a11y?: string }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: p.faint }}>
      <Txt v="label" soft style={{ width: 110, paddingTop: 2 }}>{k}</Txt>
      <Txt v="mono" a11y={a11y} selectable style={{ flex: 1 }}>{v}</Txt>
    </View>
  );
}

function Connection() {
  const p = usePalette();
  const st = useStore();
  const [host, setHost] = useState<SavedHost | undefined>();
  const [relay, setRelay] = useState("");
  const [direct, setDirect] = useState("");
  const [msg, setMsg] = useState<string | undefined>();
  const [tests, setTests] = useState<string[] | undefined>();
  const [scanning, setScanning] = useState(false);
  const [paste, setPaste] = useState("");
  const [perm, requestPerm] = useCameraPermissions();
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const load = async () => {
    const h = (await loadHosts())[0];
    setHost(h); setRelay(h?.endpoint.relays[0] ?? ""); setDirect(h?.endpoint.direct ?? "");
  };
  useEffect(() => { void load(); }, []);
  if (!host) {
    return (
      <Pad indent style={{ paddingTop: 12, gap: 12 }}>
        <Txt v="body">This phone is not paired.</Txt>
        <Button kind="solid" a11y="settings-pair" label="Pair with a computer" onPress={() => router.push("/pair")} />
      </Pad>
    );
  }
  const save = async () => {
    try {
      const relays = relay.trim() ? [validateWsBase(relay)] : [];
      const d = direct.trim() ? validateWsBase(direct) : undefined;
      if (!relays.length && !d) throw new Error("Enter a relay address, a direct address, or both.");
      const next: SavedHost = { ...host, endpoint: { ...host.endpoint, relays, ...(d ? { direct: d } : {}) } };
      if (!d) delete next.endpoint.direct;
      await saveHosts([next]); setHost(next); setMsg("Saved. Reconnecting…");
      await connection.reconnectNow();
    } catch (e) { setMsg((e as Error).message); }
  };
  const test = async () => {
    setTests(["testing…"]);
    const out: string[] = [];
    for (const c of candidates(host.endpoint)) {
      try { const s = await openSecure(c.url, host.endpoint.hostKey, c.via === "direct" ? 4000 : 10000); s.close(); out.push(`✓ ${c.via} ${c.base}`); }
      catch (e) { out.push(`✕ ${c.via} ${c.base} — ${(e as Error).message}`); }
      setTests([...out]);
    }
    if (!out.length) setTests(["no address configured"]);
  };
  const applyEndpoint = async (raw: string) => {
    const r = parseQr(raw);
    if (!r.ok) { setMsg(r.error); return; }
    if (r.qr.hostId !== host.endpoint.hostId || r.qr.hostKey !== host.endpoint.hostKey) { setMsg("That code belongs to another computer."); return; }
    const next: SavedHost = { ...host, endpoint: { ...host.endpoint, hostName: r.qr.hostName, relays: r.qr.relays } };
    if (r.qr.direct) next.endpoint.direct = r.qr.direct; else delete next.endpoint.direct;
    await saveHosts([next]); await load(); setMsg("Connection details updated. Reconnecting…");
    await connection.reconnectNow();
  };

  const linked = st.conn === "ready";
  return (
    <Pad indent style={{ paddingTop: 10, gap: 6 }}>
      <Txt v="title" a11y="settings-hostname">{host.endpoint.hostName}</Txt>
      <Txt v="label" color={linked ? p.ok : p.pink} style={{ fontFamily: F.monoBold, fontSize: 12 }}>{linked ? `● connected ${st.via === "direct" ? "directly" : "via relay"}` : `● ${st.conn === "backoff" ? "offline" : st.conn}`}</Txt>
      {st.lastError ? <Txt v="small" color={p.pink}>{st.lastError}</Txt> : null}
      <View style={{ marginTop: 8 }}>
        <Fact k="key" v={fingerprint(host.endpoint.hostKey)} a11y="settings-fingerprint" />
        <Fact k="host id" v={host.endpoint.hostId} />
        <Fact k="this phone" v={host.deviceId} />
        <Fact k="pi-hostd" v={st.hostVersion ?? "?"} />
      </View>
      <Txt v="em" style={{ marginTop: 22 }}>Addresses</Txt>
      <Txt v="small" soft>Change these when you move the relay to another server. Pairing stays valid.</Txt>
      <View style={{ gap: 14, marginTop: 8 }}>
        <Field a11y="settings-relay-input" label="relay" value={relay} onChangeText={setRelay} placeholder="ws://203.0.113.5:7443" mono autoCapitalize="none" autoCorrect={false} />
        <Field a11y="settings-direct-input" label="direct, same network (optional)" value={direct} onChangeText={setDirect} placeholder="ws://192.168.1.10:7444" mono autoCapitalize="none" autoCorrect={false} />
        <Button kind="solid" a11y="settings-save-conn" label="Save and reconnect" onPress={() => void save()} />
        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
          <Button kind="outline" compact a11y="settings-test-conn" label="test each address" onPress={() => void test()} />
          <Button kind="outline" compact a11y="settings-scan-endpoint" label="scan pi-hostd qr" onPress={async () => {
            if (!perm?.granted) { const r = await requestPerm(); if (!r.granted) { setMsg("Camera permission was denied."); return; } }
            setScanning(true);
          }} />
        </View>
        {msg ? <Txt v="small" a11y="settings-conn-msg">{msg}</Txt> : null}
        {tests ? <View accessibilityLabel="settings-test-results">{tests.map((t, i) => <Txt key={i} v="mono" a11y={`settings-test-${i}`} color={t.startsWith("✕") ? p.danger : p.ink}>{t}</Txt>)}</View> : null}
        <Field a11y="settings-endpoint-input" label="or paste the output of pi-hostd qr" value={paste} onChangeText={setPaste} placeholder='{"v":2,"kind":"endpoint",…}' mono multiline autoCapitalize="none" autoCorrect={false} />
        <Button kind="outline" compact a11y="settings-endpoint-apply" label="apply connection details" style={{ alignSelf: "flex-start" }} disabled={!paste.trim()} onPress={() => { void applyEndpoint(paste); setPaste(""); }} />
      </View>
      <View style={{ marginTop: 30, borderTopWidth: 2, borderTopColor: p.danger, paddingTop: 14, gap: 10 }}>
        <Txt v="label" color={p.danger} style={{ fontFamily: F.monoBold }}>danger zone</Txt>
        <Txt v="title">Unpair this phone</Txt>
        <Txt v="small" soft>The phone forgets this computer and its key. To use it again you must pair from scratch with pi-hostd pair.</Txt>
        {confirmUnpair ? (
          <View style={{ gap: 10 }}>
            <Txt v="body">Also revoke the phone on the computer, so the old key stops working:</Txt>
            <Txt v="mono" selectable>pi-hostd devices revoke {host.deviceId}</Txt>
            <Button kind="danger" a11y="settings-unpair-yes" label="Yes, forget this computer" onPress={async () => { await saveHosts([]); connection.disconnect(); await stopForeground(); router.replace("/pair"); }} />
            <Button kind="outline" a11y="settings-unpair-no" label="keep it paired" onPress={() => setConfirmUnpair(false)} />
          </View>
        ) : <Button kind="danger" a11y="settings-unpair" label="Unpair this phone" onPress={() => setConfirmUnpair(true)} />}
      </View>
      <Modal visible={scanning} onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: "black" }}>
          <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => { setScanning(false); void applyEndpoint(data); }} />
          <Button kind="solid" a11y="settings-scan-cancel" label="Cancel scanning" arrow="✕" onPress={() => setScanning(false)} />
        </View>
      </Modal>
    </Pad>
  );
}

function SettingRow({ d, value, onSet, onPick }: { d: RemoteSettingDef; value: unknown; onSet: (v: unknown) => void; onPick: () => void }) {
  const p = usePalette();
  const note = d.applies === "reload" ? "running pis reload when idle" : d.applies === "new_session" ? "for new sessions" : "only this app";
  useTestAction(`setting-${d.key}`, d.type === "enum" ? onPick : undefined);
  // Unset booleans show "default": pi's built-in default differs per setting, so do not pretend it is off.
  if (d.type === "boolean") return <Toggle a11y={`setting-switch-${d.key}`} value={value === true} unset={value === undefined} onChange={(v) => onSet(v)} label={d.label} hint={note} />;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`setting-${d.key}`} onPress={onPick}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: p.faint, backgroundColor: pressed ? p.tint : "transparent", gap: 12 })}>
      <View style={{ flex: 1 }}>
        <Txt v="body">{d.label}</Txt>
        <Txt v="small" soft>{note}</Txt>
      </View>
      <Txt v="mono" a11y={`setting-value-${d.key}`} color={value === undefined ? p.soft : p.ink} style={{ fontFamily: value === undefined ? F.mono : F.monoBold }}>{value === undefined ? "default" : String(value)}  ›</Txt>
    </Pressable>
  );
}

function PiSettings() {
  const p = usePalette();
  const conn = useStore((s) => s.conn);
  const [values, setValues] = useState<Record<string, unknown> | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pick, setPick] = useState<RemoteSettingDef | undefined>();
  useEffect(() => { if (conn === "ready") call("get_settings", {}).then((r) => setValues(r.values), (e) => setError(errText(e))); }, [conn]);
  const set = async (key: string, value: unknown) => {
    try { setValues((await call("set_setting", { key, value })).values); setError(undefined); } catch (e) { setError(errText(e)); }
  };
  return (
    <Pad indent style={{ paddingTop: 6 }}>
      <Txt v="small" soft style={{ marginVertical: 8 }}>These are the computer's global pi settings (~/.pi/agent/settings.json).</Txt>
      {conn !== "ready" ? <Txt v="small" soft>Connect to edit them.</Txt> : null}
      {error ? <Txt v="small" color={p.danger} a11y="settings-error">{error}</Txt> : null}
      {conn === "ready" && !values && !error ? <Spinner /> : null}
      {values ? REMOTE_SETTINGS.map((d) => <SettingRow key={d.key} d={d} value={values[d.key]} onSet={(v) => void set(d.key, v)} onPick={() => setPick(d)} />) : null}
      {pick ? (
        <Sheet visible a11y="setting-pick" kicker="pi setting" title={pick.label} onClose={() => setPick(undefined)}>
          {(pick.options ?? []).map((o) => <Choice key={o} a11y={`setting-option-${o}`} label={o} selected={values?.[pick.key] === o} onPress={() => { const k = pick.key; setPick(undefined); void set(k, o); }} />)}
        </Sheet>
      ) : null}
    </Pad>
  );
}

function PhoneSettings() {
  const [prefs, setPrefs] = useState<AppPrefs | undefined>();
  const [msg, setMsg] = useState<string | undefined>();
  useEffect(() => { void loadPrefs().then(setPrefs); }, []);
  if (!prefs) return null;
  const update = async (n: AppPrefs) => { setPrefs(n); await savePrefs(n); await reloadPrefs(); };
  return (
    <Pad indent style={{ paddingTop: 6, gap: 4 }}>
      <Toggle a11y="settings-keepalive" value={prefs.keepAlive} onChange={(v) => void update({ ...prefs, keepAlive: v })} label="Stay connected in the background" hint="keeps a small notification; needed for alerts" />
      <Toggle a11y="settings-notify-child" value={prefs.notifyChildDone} onChange={(v) => void update({ ...prefs, notifyChildDone: v })} label="Alert when a subagent finishes" hint="you are always alerted when one needs you" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
        <Button kind="outline" compact a11y="settings-battery" label="battery optimisation" onPress={() => { openBatteryOptimization().catch(() => Linking.openSettings()); }} />
        <Button kind="outline" compact a11y="settings-clear-trust" label="forget trust choices" onPress={async () => { await clearTrust(); setMsg("Trust choices forgotten."); }} />
      </View>
      {msg ? <Txt v="small" soft style={{ marginTop: 8 }}>{msg}</Txt> : null}
    </Pad>
  );
}

export default function SettingsScreen() {
  return (
    <Screen back kicker="pi remote" title="Settings">
      <SectionHead n="01" title="Connection" />
      <Connection />
      <SectionHead n="02" title="pi on the computer" />
      <PiSettings />
      <SectionHead n="03" title="This phone" />
      <PhoneSettings />
      <View style={{ height: 30, marginLeft: MARGIN + GUTTER }} />
    </Screen>
  );
}
