import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = process.env.PI_REMOTE_CONFIG_DIR ?? join(homedir(), ".config", "pi-remote");
export const IDENTITY_FILE = join(CONFIG_DIR, "identity.json");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const DEVICES_FILE = join(CONFIG_DIR, "devices.json");
export const PAIRING_FILE = join(CONFIG_DIR, "pairing.json");
export const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-remote");
export const AUDIT_FILE = join(STATE_DIR, "audit.jsonl");
export const HOSTD_LOG = join(STATE_DIR, "hostd.log");
export const RUNTIME_DIR = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "pi-remote");
export const BRIDGE_SOCKET = join(RUNTIME_DIR, "bridge.sock");
export const STATUS_FILE = join(RUNTIME_DIR, "status.json");
