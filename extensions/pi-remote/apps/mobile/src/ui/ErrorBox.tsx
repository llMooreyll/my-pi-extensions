import { Modal, Pressable, ScrollView } from "react-native";
import { Btn, T } from "./kit";
import { usePalette } from "./theme";

/** Scrollable error dialog (e.g. spawn_timeout with tmux pane output). */
export function ErrorBox(props: { text?: string; onClose: () => void }) {
  const c = usePalette();
  return (
    <Modal transparent visible={!!props.text} animationType="fade" onRequestClose={props.onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "#0008", justifyContent: "center", padding: 20 }} onPress={props.onClose}>
        <Pressable accessibilityLabel="error-dialog" style={{ backgroundColor: c.card, borderRadius: 12, padding: 16, maxHeight: "80%", gap: 10 }} onPress={() => {}}>
          <T bold color={c.danger}>Error</T>
          <ScrollView><T mono size={12} selectable a11y="error-text">{props.text}</T></ScrollView>
          <Btn a11y="error-close" label="Close" onPress={props.onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
