const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** One-line description of a tool call (plan 7.3.11 and 7.6.5). */
export function toolSummary(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "bash": return `$ ${s(a.command)}`;
    case "read": return `Read ${s(a.path)}${a.offset !== undefined || a.limit !== undefined ? ` (${a.offset ?? 1}${a.limit !== undefined ? `, ${a.limit} lines` : ""})` : ""}`;
    case "write": return `Write ${s(a.path)} (${s(a.content).split("\n").length} lines)`;
    case "edit": return `Edit ${s(a.path)} (${Array.isArray(a.edits) ? a.edits.length : 1} change${Array.isArray(a.edits) && a.edits.length === 1 ? "" : "s"})`;
    case "subagent": return `Start subagent ${s(a.name)}${a.agent ? ` (${s(a.agent)})` : ""}${a.task ? `\n${s(a.task).slice(0, 200)}` : ""}`;
    case "subagent_resume": return `Resume subagent ${s(a.name ?? a.id ?? a.sessionPath)}`;
    case "subagent_interrupt": return `Interrupt subagent ${s(a.name ?? a.id)}`;
    case "subagents_list": return "List subagents";
    case "team_spawn": return `Add member ${s(a.name)}${a.agent ? ` (${s(a.agent)})` : ""}${a.write ? " · can write" : ""}`;
    case "team_send": return `To ${s(a.to)}: ${s(a.message).slice(0, 80)}`;
    case "team_list": return "List members";
    case "team_stop": return `Stop member ${s(a.name)}`;
    case "team_interrupt": return `Interrupt member ${s(a.name)}`;
    case "team_integrate": return `Integrate changes of ${s(a.name)}`;
    case "team_sync": return `Sync member ${s(a.name)}`;
    case "team_report": return "Report to lead";
    case "team_ask": return "Ask the lead";
    case "caller_ping": return "Ask parent agent for help";
    case "subagent_done": return "Subagent finished";
    default: {
      let j = "";
      try { j = JSON.stringify(args); } catch { j = ""; }
      return `${name} ${j.length > 300 ? j.slice(0, 300) + "…" : j}`;
    }
  }
}
