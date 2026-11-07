import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView } from "react-native";
import type { ProjectItem } from "@pi-remote/protocol";
import { baseName } from "../lib/format";
import { useOpenFlow } from "../lib/open";
import { call, errText } from "../net/connection";
import { ErrorBox } from "../ui/ErrorBox";
import { Btn, Card, Field, Section, T } from "../ui/kit";
import { Option } from "../ui/Sheet";
import { TrustDialog } from "../ui/TrustDialog";
import { usePalette } from "../ui/theme";

export default function NewSession() {
  const c = usePalette();
  const [projects, setProjects] = useState<ProjectItem[] | undefined>();
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | undefined>();
  const flow = useOpenFlow();
  useEffect(() => { call("list_projects", {}).then((r) => setProjects(r.projects), (e) => setError(errText(e))); }, []);
  return (
    <>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }} keyboardShouldPersistTaps="handled">
        <Section title="Directory">
          <Field a11y="new-cwd-input" value={cwd} onChangeText={setCwd} placeholder="/home/you/project" autoCapitalize="none" autoCorrect={false} />
          <Btn a11y="new-start" kind="primary" label="Start pi here" disabled={!cwd.startsWith("/")} busy={!!flow.busy} onPress={() => void flow.newProcess(cwd.trim())} />
          {flow.busy ? <Card style={{ flexDirection: "row", gap: 8 }}><ActivityIndicator /><T>{flow.busy}</T></Card> : null}
        </Section>
        <Section title="Projects">
          {error ? <T color={c.danger}>{error}</T> : null}
          {!projects && !error ? <ActivityIndicator /> : null}
          {projects?.map((p, i) => <Option key={p.cwd} a11y={`new-project-${i}`} label={baseName(p.cwd)} sub={p.cwd} selected={cwd === p.cwd} onPress={() => setCwd(p.cwd)} />)}
        </Section>
      </ScrollView>
      <TrustDialog {...flow.trustDialog} />
      <ErrorBox text={flow.error} onClose={flow.clearError} />
    </>
  );
}
