import { useState } from "react";
import { Modal, Pressable, Switch, View } from "react-native";
import type { Trust } from "@pi-remote/protocol";
import { loadTrustMap, rememberTrust } from "../lib/credentials";
import { Btn, T } from "./kit";
import { usePalette } from "./theme";

/** Resolves the trust choice for a cwd: remembered value, or asks via the dialog. */
export async function rememberedTrust(cwd: string): Promise<Trust | undefined> {
  return (await loadTrustMap())[cwd];
}

export function TrustDialog(props: { cwd?: string; onChoose: (t: Trust) => void; onCancel: () => void }) {
  const c = usePalette();
  const [remember, setRemember] = useState(false);
  const choose = async (t: Trust) => {
    if (remember && props.cwd) await rememberTrust(props.cwd, t);
    props.onChoose(t);
  };
  return (
    <Modal transparent visible={!!props.cwd} animationType="fade" onRequestClose={props.onCancel}>
      <Pressable style={{ flex: 1, backgroundColor: "#0008", justifyContent: "center", padding: 24 }} onPress={props.onCancel}>
        <Pressable accessibilityLabel="trust-dialog" style={{ backgroundColor: c.card, borderRadius: 12, padding: 16, gap: 12 }} onPress={() => {}}>
          <T bold size={17}>Project trust</T>
          <T dim size={13}>{props.cwd}</T>
          <T size={14}>Load this project's local resources (.pi extensions, skills, prompts)?</T>
          <Btn a11y="trust-approve" kind="primary" label="Trust project resources (--approve)" onPress={() => void choose("approve")} />
          <Btn a11y="trust-deny" label="Don't load project resources (--no-approve)" onPress={() => void choose("deny")} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Switch accessibilityLabel="trust-remember" value={remember} onValueChange={setRemember} />
            <T size={14}>Remember for this project</T>
          </View>
          <Btn a11y="trust-cancel" small label="Cancel" onPress={props.onCancel} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
