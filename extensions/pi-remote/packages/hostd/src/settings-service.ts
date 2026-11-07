import { homedir } from "node:os";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { REMOTE_SETTINGS } from "../../protocol/src/index.ts";
import { err } from "./errors.ts";
import { log } from "./log.ts";
import { registry } from "./registry.ts";

// Setter names verified against settings-manager.d.ts (plan appendix A-9).
const SETTERS: Record<string, (sm: SettingsManager, v: never) => void> = {
  "defaultThinkingLevel": (sm, v) => sm.setDefaultThinkingLevel(v),
  "hideThinkingBlock": (sm, v) => sm.setHideThinkingBlock(v),
  "steeringMode": (sm, v) => sm.setSteeringMode(v),
  "followUpMode": (sm, v) => sm.setFollowUpMode(v),
  "compaction.enabled": (sm, v) => sm.setCompactionEnabled(v),
  "retry.enabled": (sm, v) => sm.setRetryEnabled(v),
  "transport": (sm, v) => sm.setTransport(v),
  "cacheWarming": (sm, v) => sm.setCacheWarmingMode(v),
  "images.blockImages": (sm, v) => sm.setBlockImages(v),
  "images.autoResize": (sm, v) => sm.setImageAutoResize(v),
  "enableSkillCommands": (sm, v) => sm.setEnableSkillCommands(v),
  "showCacheMissNotices": (sm, v) => sm.setShowCacheMissNotices(v),
  "defaultProjectTrust": (sm, v) => sm.setDefaultProjectTrust(v),
  "treeFilterMode": (sm, v) => sm.setTreeFilterMode(v),
};

const create = () => SettingsManager.create(homedir(), getAgentDir());

function pick(obj: unknown, path: string): unknown {
  let cur = obj as Record<string, unknown> | undefined;
  for (const k of path.split(".")) { if (!cur || typeof cur !== "object") return undefined; cur = cur[k] as Record<string, unknown>; }
  return cur;
}

export function getSettings(): { values: Record<string, unknown> } {
  const s = create().getGlobalSettings();
  const values: Record<string, unknown> = {};
  for (const d of REMOTE_SETTINGS) { const v = pick(s, d.key); if (v !== undefined) values[d.key] = v; }
  return { values };
}

export async function setSetting(key: string, value: unknown): Promise<{ values: Record<string, unknown> }> {
  const def = REMOTE_SETTINGS.find((d) => d.key === key);
  const setter = SETTERS[key];
  if (!def || !setter) throw err("bad_request", `setting ${key} is not remotely editable`);
  if (def.type === "boolean" && typeof value !== "boolean") throw err("bad_request", `${key} must be a boolean`);
  if (def.type === "enum" && !(def.options ?? []).includes(value as string)) throw err("bad_request", `${key} must be one of ${(def.options ?? []).join(", ")}`);
  const sm = create();
  setter(sm, value as never);
  await sm.flush();
  const errors = sm.drainErrors();
  if (errors.length) throw err("internal", errors.map((e) => String((e as { error?: unknown }).error ?? e)).join("; "));
  if (def.applies === "reload") {
    for (const e of registry.entries()) {
      e.conn.request("reload_when_idle", {}, 15_000).catch((x) => log.warn("reload_when_idle failed", e.info.processId, x?.message ?? x));
    }
  }
  return getSettings();
}
