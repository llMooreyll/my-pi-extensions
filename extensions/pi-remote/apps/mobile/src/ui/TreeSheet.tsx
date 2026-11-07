import { Spinner } from "./Spinner";
import { useEffect, useMemo, useState } from "react";
import { Switch, View } from "react-native";
import type { TreeNodeWire } from "@pi-remote/protocol";
import { call, errText } from "../net/connection";
import { Btn, Field, T } from "./kit";
import { Option, Sheet } from "./Sheet";
import { usePalette } from "./theme";

export type TreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
const FILTERS: TreeFilter[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

function visible(n: TreeNodeWire, f: TreeFilter): boolean {
  switch (f) {
    case "all": return true;
    case "user-only": return n.kind === "user";
    case "labeled-only": return !!n.label;
    case "no-tools": return n.kind !== "toolResult" && n.kind !== "other" && !(n.kind === "assistant" && !n.preview);
    default: return n.kind !== "toolResult" && n.kind !== "other";
  }
}

export function TreeSheet({ processId, running, defaultFilter, onClose }: { processId: string; running: boolean; defaultFilter?: string; onClose: () => void }) {
  const c = usePalette();
  const [nodes, setNodes] = useState<TreeNodeWire[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState<TreeFilter>(FILTERS.includes(defaultFilter as TreeFilter) ? (defaultFilter as TreeFilter) : "default");
  const [target, setTarget] = useState<TreeNodeWire | undefined>();
  const [summarize, setSummarize] = useState(false);
  const [instr, setInstr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { call("get_tree", { processId }).then((r) => setNodes(r.nodes), (e) => setError(errText(e))); }, [processId]);

  const depth = useMemo(() => {
    const byId = new Map((nodes ?? []).map((n) => [n.id, n]));
    const d = new Map<string, number>();
    for (const n of nodes ?? []) {
      // Depth = number of branching ancestors, so linear chains stay flat.
      let k = 0;
      let p = n.parentId ? byId.get(n.parentId) : undefined;
      let guard = 0;
      while (p && guard++ < 5000) { if (p.childCount > 1) k++; p = p.parentId ? byId.get(p.parentId) : undefined; }
      d.set(n.id, Math.min(k, 12));
    }
    return d;
  }, [nodes]);

  const go = async () => {
    if (!target) return;
    setBusy(true);
    try { await call("navigate_tree", { processId, entryId: target.id, summarize, ...(summarize && instr.trim() ? { customInstructions: instr.trim() } : {}) }, 310_000); onClose(); }
    catch (e) { setError(errText(e)); setTarget(undefined); }
    finally { setBusy(false); }
  };

  return (
    <Sheet visible a11y="tree-sheet" title="Session tree" onClose={onClose}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {FILTERS.map((f) => <Btn key={f} small a11y={`tree-filter-${f}`} kind={f === filter ? "primary" : "plain"} label={f} onPress={() => setFilter(f)} />)}
      </View>
      {running ? <T color={c.warn} size={13}>The agent is running; switching is disabled.</T> : null}
      {error ? <T color={c.danger} a11y="tree-error">{error}</T> : null}
      {!nodes && !error ? <Spinner /> : null}
      {target ? (
        <View accessibilityLabel="tree-confirm" style={{ gap: 8, padding: 8, backgroundColor: c.cardAlt, borderRadius: 8 }}>
          <T bold>Jump to this point?</T>
          <T size={13} numberOfLines={3}>{target.preview || target.kind}</T>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Switch accessibilityLabel="tree-summarize" value={summarize} onValueChange={setSummarize} />
            <T size={14}>Summarize the abandoned branch</T>
          </View>
          {summarize ? <Field a11y="tree-instructions" value={instr} onChangeText={setInstr} placeholder="Optional summary instructions" /> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn a11y="tree-go" kind="primary" label="Jump" busy={busy} onPress={() => void go()} />
            <Btn a11y="tree-cancel" label="Cancel" onPress={() => setTarget(undefined)} />
          </View>
        </View>
      ) : null}
      {nodes?.filter((n) => visible(n, filter)).map((n) => (
        <Option key={n.id} a11y={`tree-node-${n.id}`} indent={depth.get(n.id) ?? 0} bold={n.onActivePath} disabled={running || busy}
          label={`${n.kind === "user" ? "› " : ""}${n.preview || `[${n.kind}]`}`}
          sub={[n.kind, n.label ? `#${n.label}` : "", n.isLeaf ? "current" : ""].filter(Boolean).join(" · ")}
          selected={n.isLeaf} onPress={() => setTarget(n)} />
      ))}
    </Sheet>
  );
}
