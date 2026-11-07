import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { Trust } from "@pi-remote/protocol";
import { rememberTrust } from "../lib/credentials";
import { useTestAction } from "../lib/test-hooks";
import { connection } from "../net/connection";
import { useStore } from "../state/store";
import { Button, Dialog, Toggle, Txt } from "./primitives";
import { MARGIN, usePalette } from "./tokens";

/** One line of mono under the masthead: where we are connected, or why not. */
export function ConnLine() {
  const p = usePalette();
  const conn = useStore((s) => s.conn);
  const via = useStore((s) => s.via);
  const lastError = useStore((s) => s.lastError);
  const host = useStore((s) => s.hostName ?? s.host?.endpoint.hostName);
  const ok = conn === "ready";
  const onPress = () => {
    if (conn === "no_credentials") router.push("/pair");
    else if (!ok) void connection.reconnectNow();
    else router.push("/settings");
  };
  useTestAction("conn-bar", onPress);
  const color = ok ? p.soft : conn === "connecting" ? p.soft : p.pink;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="conn-bar" onPress={onPress} style={{ paddingHorizontal: MARGIN, paddingVertical: 8, gap: 2 }}>
      <Txt v="label" a11y="conn-state" color={color} lines={1}>
        {ok ? `● ${host ?? "computer"} — ${via === "direct" ? "direct" : "via relay"}`
          : conn === "no_credentials" ? "○ not paired — tap to pair"
          : conn === "connecting" ? "○ connecting…"
          : "● offline — tap to retry"}
      </Txt>
      {!ok && lastError ? <Txt v="small" a11y="conn-error" color={color} lines={2}>{lastError}</Txt> : null}
      {ok ? <View accessibilityLabel="conn-via" /> : null}
    </Pressable>
  );
}

export function ErrorDialog(props: { text?: string; onClose: () => void }) {
  const p = usePalette();
  return (
    <Dialog visible={!!props.text} title="That did not work." color={p.danger} a11y="error-dialog" onClose={props.onClose}
      actions={<Button kind="solid" a11y="error-close" label="Understood" onPress={props.onClose} />}>
      <ScrollView style={{ maxHeight: 340 }}>
        <Txt v="mono" selectable a11y="error-text">{props.text}</Txt>
      </ScrollView>
    </Dialog>
  );
}

export function TrustDialog(props: { cwd?: string; onChoose: (t: Trust) => void; onCancel: () => void }) {
  const [remember, setRemember] = useState(false);
  const choose = async (t: Trust) => {
    if (remember && props.cwd) await rememberTrust(props.cwd, t);
    props.onChoose(t);
  };
  return (
    <Dialog visible={!!props.cwd} title="Trust this project?" a11y="trust-dialog" onClose={props.onCancel}>
      <Txt v="mono" soft lines={3}>{props.cwd}</Txt>
      <Txt v="body">A trusted project may load its own extensions, skills and prompts from <Txt v="mono">.pi/</Txt>. Choose safe mode for code you did not write.</Txt>
      <Button kind="solid" a11y="trust-approve" label="Trust and load project files" onPress={() => void choose("approve")} />
      <Button kind="solid" a11y="trust-deny" label="Safe mode" arrow="→" onPress={() => void choose("deny")} />
      <Toggle a11y="trust-remember" value={remember} onChange={setRemember} label="Remember for this project" />
      <Button a11y="trust-cancel" label="cancel" onPress={props.onCancel} />
    </Dialog>
  );
}

export function ConfirmDialog(props: { title?: string; body?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const p = usePalette();
  return (
    <Dialog visible={!!props.title} title={props.title ?? ""} a11y="session-confirm" color={props.danger ? p.danger : undefined} onClose={props.onCancel}
      actions={<>
        <Button kind="solid" a11y="session-confirm-yes" color={props.danger ? p.danger : undefined} label={props.confirmLabel ?? "Confirm"} onPress={props.onConfirm} />
        <Button a11y="session-confirm-no" label="cancel" onPress={props.onCancel} />
      </>}>
      {props.body ? <Txt v="body">{props.body}</Txt> : null}
    </Dialog>
  );
}
