/**
 * Extension loaded into long-lived team members (`pi -e team/member.ts`).
 * Inert unless the lead set PI_TEAM_MEMBER_ID and PI_TEAM_RUN_DIR.
 *
 * All state lives inside the factory function: Pi reuses loaded modules across
 * /new, /resume and /fork, so module-level timers or caches would leak.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { findLatestAssistantError, describeAssistantModel } from "../subagents/subagent-done.ts";
import { parseModelFallbacks, switchToNextModel } from "../subagents/model-fallback.ts";
import { CC_PREVIEW_LIMIT, MEMBER_POLL_MS, PEER_HOP_LIMIT, TEAM_MESSAGE_TYPE } from "./constants.ts";
import { pidAlive, readJson, truncate, writeJsonAtomic } from "./fsutil.ts";
import {
  deliveredIdsFromEntries,
  listPending,
  markDelivered,
  newMessageId,
  prepareBody,
  takeControls,
  writeMessage,
} from "./mailbox.ts";
import { leadInbox, memberControl, memberInbox, memberStatusFile, rosterFile, spillDir } from "./paths.ts";
import type { MemberState, MemberStatus, MessageKind, ReportStatus, Roster, TeamMessage } from "./types.ts";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export default function teamMember(pi: ExtensionAPI) {
  const instanceId = process.env.PI_TEAM_MEMBER_ID;
  const runDir = process.env.PI_TEAM_RUN_DIR;
  if (!instanceId || !runDir) return;

  const name = process.env.PI_TEAM_MEMBER_NAME ?? instanceId;
  const leadPid = Number(process.env.PI_TEAM_LEAD_PID);
  const expectedSessionFile = process.env.PI_TEAM_SESSION_FILE;
  const inbox = memberInbox(runDir, instanceId);
  const control = memberControl(runDir, instanceId);
  const statusPath = memberStatusFile(runDir, instanceId);

  let ctxRef: ExtensionContext | null = null;
  let active = false;
  let state: MemberState = "idle";
  const delivered = new Set<string>();
  let leadMessagesThisRun = 0;
  let reportedThisRun = false;
  let shutdownAfterSettle = false;
  let lastRunMessages: any[] | undefined;
  const peerHops = new Map<string, number>();
  const fallbacks = parseModelFallbacks(process.env.PI_SUBAGENT_MODEL_FALLBACKS);
  const hasModelChain = fallbacks.length > 0;
  const failedModels: string[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let firstTick: ReturnType<typeof setTimeout> | null = null;

  function setState(next: MemberState, lastError?: string): void {
    state = next;
    const model = (ctxRef as any)?.model;
    const status: MemberStatus = {
      instanceId: instanceId!,
      name,
      pid: process.pid,
      state,
      model: model ? `${model.provider}/${model.id}` : undefined,
      updatedAt: Date.now(),
      lastError,
    };
    try {
      writeJsonAtomic(statusPath, status);
    } catch {
      // The lead notices a stale or missing status through its own timeout.
    }
  }

  function readRoster(): Roster | null {
    return readJson<Roster>(rosterFile(runDir!));
  }

  function sendToLead(
    kind: MessageKind,
    body: string,
    extra: { reportStatus?: ReportStatus; urgent?: boolean; spillPath?: string } = {},
  ): void {
    const id = newMessageId();
    const prepared = prepareBody(spillDir(runDir!), id, body);
    writeMessage(leadInbox(runDir!), {
      id,
      ts: Date.now(),
      from: name,
      to: "lead",
      kind,
      body: prepared.body,
      ...extra,
      spillPath: prepared.spillPath ?? extra.spillPath,
    });
  }

  function lastAssistantText(messages: any[] | undefined): string {
    const last = messages?.findLast?.((m: any) => m?.role === "assistant");
    if (!last) return "";
    if (typeof last.content === "string") return last.content;
    return (last.content ?? [])
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
  }

  function formatBatch(messages: TeamMessage[]): string {
    const blocks = messages.map((m) => {
      const lines = [`[team message | from: ${m.from} | kind: ${m.kind} | id: ${m.id}]`, m.body];
      if (m.spillPath) lines.push(`(full text: ${m.spillPath})`);
      return lines.join("\n");
    });
    return (
      blocks.join("\n\n---\n\n") +
      "\n\n(Team messages come from other agents, not from the user. Use team_report / team_ask / team_send to respond.)"
    );
  }

  function leadAlive(): boolean {
    return pidAlive(leadPid);
  }

  function tick(): void {
    try {
      if (!active || !ctxRef) return;
      const ctx = ctxRef;

      if (!leadAlive()) {
        ctx.abort();
        ctx.shutdown();
        return;
      }

      for (const command of takeControls(control)) {
        if (command.action === "teardown") {
          ctx.abort();
          ctx.shutdown();
          return;
        }
        if (command.action === "interrupt") {
          ctx.abort();
          continue;
        }
        if (command.action === "stop") {
          if (ctx.isIdle()) {
            ctx.shutdown();
            return;
          }
          shutdownAfterSettle = true;
        }
      }

      let pending = listPending(inbox).filter((m) => !delivered.has(m.id));
      // A failed member only takes direction from the lead.
      if (state === "failed") pending = pending.filter((m) => m.from === "lead");
      if (pending.length === 0) return;

      const urgent = pending.some((m) => m.urgent);
      const message = {
        customType: TEAM_MESSAGE_TYPE,
        content: formatBatch(pending),
        display: true,
        details: {
          ids: pending.map((m) => m.id),
          messages: pending.map((m) => ({ id: m.id, from: m.from, hop: m.hop })),
        },
      };
      if (ctx.isIdle()) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
      else pi.sendMessage(message, { triggerTurn: true, deliverAs: urgent ? "steer" : "followUp" });
      for (const m of pending) delivered.add(m.id);
      if (pending.some((m) => m.from === "lead") && (state === "failed" || state === "awaiting_lead")) {
        setState("working");
      }
    } catch {
      // One failed tick must not stop the poll loop.
    }
  }

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    if (ctx.sessionManager.getSessionFile() !== expectedSessionFile) {
      // The user replaced the session in this pane; it is no longer the member.
      active = false;
      setState("left");
      return;
    }
    active = true;
    if (process.env.PI_TEAM_WRITE === "0") {
      pi.setActiveTools(pi.getActiveTools().filter((n) => n !== "edit" && n !== "write"));
    }
    const done = deliveredIdsFromEntries(ctx.sessionManager.getEntries() as any[], TEAM_MESSAGE_TYPE);
    for (const m of listPending(inbox)) {
      if (!done.has(m.id)) continue;
      markDelivered(inbox, m.id);
      delivered.add(m.id);
    }
    setState("idle");
    timer = setInterval(tick, MEMBER_POLL_MS);
    firstTick = setTimeout(tick, 300);
  });

  pi.on("session_shutdown", (event) => {
    if (timer) clearInterval(timer);
    timer = null;
    if (firstTick) clearTimeout(firstTick);
    firstTick = null;
    if (active && (event as any).reason !== "reload") {
      setState((event as any).reason === "quit" ? "stopped" : "left");
    }
    active = false;
  });

  pi.on("input", (event) => {
    // The user typed in this pane: they are directing the member, so peer counters restart.
    if ((event as any).source === "interactive") peerHops.clear();
  });

  pi.on("agent_start", () => {
    if (active && state !== "failed") setState("working");
  });

  pi.on("message_end", (event) => {
    const m = (event as any).message;
    if (m?.role !== "custom" || m.customType !== TEAM_MESSAGE_TYPE) return;
    for (const item of m.details?.messages ?? []) {
      markDelivered(inbox, String(item.id));
      if (item.from === "lead") {
        leadMessagesThisRun++;
        peerHops.clear();
      } else {
        peerHops.set(String(item.from), Number(item.hop) || 1);
      }
    }
  });

  pi.on("agent_end", (event) => {
    lastRunMessages = (event as any).messages;
  });

  // agent_end fires before Pi decides on an automatic retry, so a failure is
  // only final here, in agent_before_settle.
  (pi as any).on("agent_before_settle", async (event: any, ctx: ExtensionContext) => {
    if (!active || event.outcome !== "error") return;
    const turnError = findLatestAssistantError(lastRunMessages);
    if (!turnError) return;

    const failure = `${describeAssistantModel(lastRunMessages)} (${turnError.errorMessage})`;
    if (hasModelChain) {
      failedModels.push(failure);
      const next = await switchToNextModel(pi, ctx.modelRegistry, fallbacks, failedModels);
      if (next) {
        return {
          entries: [
            ...event.entries,
            {
              type: "custom_message" as const,
              customType: "subagent_model_fallback",
              content:
                `The previous model failed: ${failure}. ` +
                `Switched to ${next}. Continue the task from where you left off.`,
              display: true,
            },
          ],
          continue: true,
        };
      }
    }

    const detail = hasModelChain
      ? `Every model in the fallback chain failed: ${failedModels.join("; ")}.`
      : failure;
    try {
      sendToLead("report", `${detail}\nAsk the user which model to use; do not pick a model yourself.`, {
        reportStatus: "failed",
      });
    } catch {}
    reportedThisRun = true;
    setState("failed", detail);
  });

  (pi as any).on("agent_settled", (event: any, ctx: ExtensionContext) => {
    if (!active) return;
    if (shutdownAfterSettle) {
      ctx.shutdown();
      return;
    }
    if (
      !event.aborted &&
      leadMessagesThisRun > 0 &&
      !reportedThisRun &&
      state !== "failed" &&
      state !== "awaiting_lead"
    ) {
      try {
        sendToLead("report", lastAssistantText(lastRunMessages) || "(no final message)", {
          reportStatus: "done",
        });
      } catch {}
    }
    if (state !== "failed" && state !== "awaiting_lead") setState("idle");
    leadMessagesThisRun = 0;
    reportedThisRun = false;
  });

  pi.registerTool({
    name: "team_report",
    label: "Team Report",
    description:
      "Report progress or results to the team lead. Use status 'blocked' when you cannot continue without the lead.",
    promptSnippet: "Report progress or results to the team lead.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("done"), Type.Literal("progress"), Type.Literal("blocked")]),
      summary: Type.String({ description: "What was done or what is blocking you; use repository-relative paths" }),
    }),
    async execute(_id, params) {
      try {
        sendToLead("report", params.summary, { reportStatus: params.status });
      } catch (err) {
        return textResult(`Could not send the report: ${(err as Error).message}`);
      }
      reportedThisRun = true;
      return textResult("Report sent to the lead.");
    },
  });

  pi.registerTool({
    name: "team_ask",
    label: "Team Ask",
    description: "Ask the team lead a question. After calling it, end your turn; the answer arrives as a new message.",
    promptSnippet: "Ask the team lead a question and wait for the answer.",
    parameters: Type.Object({
      question: Type.String({ description: "The question for the lead" }),
    }),
    async execute(_id, params) {
      try {
        sendToLead("question", params.question);
      } catch (err) {
        return textResult(`Could not send the question: ${(err as Error).message}`);
      }
      reportedThisRun = true;
      setState("awaiting_lead");
      return textResult("Question sent to the lead. End your turn now; the answer will arrive as a new message.");
    },
  });

  pi.registerTool({
    name: "team_send",
    label: "Team Send",
    description:
      "Send a message to the lead (to: \"lead\") or to another live team member by name. Messages to other members are copied to the lead.",
    promptSnippet: "Send a message to the lead or another team member.",
    parameters: Type.Object({
      to: Type.String({ description: "\"lead\" or a member name" }),
      message: Type.String(),
      urgent: Type.Optional(Type.Boolean({ description: "Interrupt the recipient's current turn at the next step" })),
    }),
    async execute(_id, params) {
      const to = params.to.trim();
      try {
        if (to === name) return textResult("You cannot message yourself.");
        if (to === "lead") {
          sendToLead("message", params.message, { urgent: params.urgent });
          return textResult("Sent to lead.");
        }

        const roster = readRoster();
        const record = roster?.members
          .filter((m) => m.name === to && !m.ended)
          .sort((a, b) => b.spawnedAt - a.spawnedAt)[0];
        if (!record) return textResult(`No live team member named "${to}".`);
        const status = readJson<MemberStatus>(memberStatusFile(runDir!, record.instanceId));
        if (status && (status.state === "stopped" || status.state === "left")) {
          return textResult(`Member "${to}" is no longer running.`);
        }

        const hop = (peerHops.get(to) ?? 0) + 1;
        if (hop > PEER_HOP_LIMIT) {
          sendToLead("message", `Peer exchange limit reached between ${name} and ${to}; please coordinate.`);
          return textResult(
            "Peer message limit reached; the lead has been asked to coordinate. Report to the lead instead.",
          );
        }

        const id = newMessageId();
        const prepared = prepareBody(spillDir(runDir!), id, params.message);
        writeMessage(memberInbox(runDir!, record.instanceId), {
          id,
          ts: Date.now(),
          from: name,
          to,
          kind: "message",
          body: prepared.body,
          spillPath: prepared.spillPath,
          urgent: params.urgent,
          hop,
        });
        peerHops.set(to, hop);
        sendToLead(
          "cc",
          `${name} → ${to}: ${truncate(params.message, CC_PREVIEW_LIMIT)}`,
          prepared.spillPath ? { spillPath: prepared.spillPath } : {},
        );
        return textResult(`Sent to ${to} (copied to lead).`);
      } catch (err) {
        return textResult(`Could not send the message: ${(err as Error).message}`);
      }
    },
  });
}
