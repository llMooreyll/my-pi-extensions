import { useEffect, useState } from "react";
import { ActivityIndicator } from "react-native";
import { call, errText } from "../net/connection";
import { T } from "./kit";
import { Option, Sheet } from "./Sheet";
import { usePalette } from "./theme";

export function ThinkingSheet({ processId, onClose }: { processId: string; onClose: () => void }) {
  const c = usePalette();
  const [data, setData] = useState<{ current: string; levels: string[] } | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { call("get_thinking_levels", { processId }).then(setData, (e) => setError(errText(e))); }, [processId]);
  return (
    <Sheet visible a11y="thinking-sheet" title="Thinking level" onClose={onClose}>
      {error ? <T color={c.danger}>{error}</T> : null}
      {!data && !error ? <ActivityIndicator /> : null}
      {data?.levels.map((l) => (
        <Option key={l} a11y={`thinking-${l}`} label={l} selected={l === data.current}
          onPress={async () => { try { await call("set_thinking", { processId, level: l }); onClose(); } catch (e) { setError(errText(e)); } }} />
      ))}
    </Sheet>
  );
}
