export interface RemoteSettingDef {
  key: string;
  label: string;
  type: "boolean" | "enum";
  options?: string[];
  /** reload：需要在线进程 reload 才生效；new_session：仅新会话生效；app：只影响 App 显示 */
  applies: "reload" | "new_session" | "app";
}

export const REMOTE_SETTINGS: readonly RemoteSettingDef[] = [
  { key: "defaultThinkingLevel", label: "Default thinking level", type: "enum", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], applies: "new_session" },
  { key: "hideThinkingBlock", label: "Hide thinking blocks", type: "boolean", applies: "reload" },
  { key: "steeringMode", label: "Steering delivery", type: "enum", options: ["one-at-a-time", "all"], applies: "reload" },
  { key: "followUpMode", label: "Follow-up delivery", type: "enum", options: ["one-at-a-time", "all"], applies: "reload" },
  { key: "compaction.enabled", label: "Auto compaction", type: "boolean", applies: "reload" },
  { key: "retry.enabled", label: "Auto retry on failure", type: "boolean", applies: "reload" },
  { key: "transport", label: "Model transport", type: "enum", options: ["auto", "sse", "websocket", "websocket-cached"], applies: "reload" },
  { key: "cacheWarming", label: "Prompt cache warming", type: "enum", options: ["off", "streaming", "idle"], applies: "reload" },
  { key: "images.blockImages", label: "Block images to model", type: "boolean", applies: "reload" },
  { key: "images.autoResize", label: "Auto-resize images", type: "boolean", applies: "reload" },
  { key: "enableSkillCommands", label: "Register skills as /skill: commands", type: "boolean", applies: "reload" },
  { key: "showCacheMissNotices", label: "Show cache miss notices", type: "boolean", applies: "reload" },
  { key: "defaultProjectTrust", label: "Default project trust", type: "enum", options: ["ask", "always", "never"], applies: "new_session" },
  { key: "treeFilterMode", label: "Default /tree filter", type: "enum", options: ["default", "no-tools", "user-only", "labeled-only", "all"], applies: "app" },
];
