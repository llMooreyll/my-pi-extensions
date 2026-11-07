import type { Config } from "./config.ts";
import type { Identity } from "./identity.ts";

/** Process-wide mutable state of `pi-hostd serve`. */
export const runtime = {
  config: undefined as unknown as Config,
  identity: undefined as unknown as Identity,
  relayStatus: "off" as "connected" | "connecting" | "auth_failed" | "off",
  directStatus: "off" as "listening" | "off",
};
