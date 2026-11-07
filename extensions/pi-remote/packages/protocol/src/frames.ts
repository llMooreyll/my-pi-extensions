import type { RemoteError } from "./errors.ts";
import type { BridgeEvent } from "./events.ts";
import type { ProcessInfo } from "./model.ts";

export type BridgeInternalOp = "get_snapshot" | "reload_when_idle";

// ---------- bridge ↔ hostd（Unix socket，NDJSON） ----------
export type BridgeToHost =
  | { t: "hello"; protocol: number; bridgeVersion: string; spawnToken?: string; info: ProcessInfo }
  | { t: "ev"; processId: string; seq: number; ev: BridgeEvent }
  | { t: "res"; id: string; ok: true; data: unknown }
  | { t: "res"; id: string; ok: false; error: RemoteError }
  | { t: "bye"; processId: string };

export type HostToBridge =
  | { t: "welcome"; protocol: number }
  | { t: "req"; id: string; op: string; args: Record<string, unknown> };

// ---------- app ↔ hostd（加密通道内的 JSON 文本帧，6.11） ----------
export type ClientToHost =
  | { t: "auth"; protocol: number; deviceId: string; secret: string }
  | { t: "pair"; protocol: number; code: string; deviceName: string }
  | { t: "req"; id: string; op: string; args: Record<string, unknown> }
  | { t: "ping"; ts: number };

export type HostToClient =
  | { t: "auth_ok"; hostVersion: string; hostName: string }
  | { t: "auth_err"; code: "unauthorized" | "incompatible" }
  | { t: "pair_ok"; deviceId: string; secret: string; hostName: string; hostVersion: string }
  | { t: "pair_err"; code: "invalid_code" | "incompatible" }
  | { t: "res"; id: string; ok: true; data: unknown }
  | { t: "res"; id: string; ok: false; error: RemoteError }
  | { t: "evt"; processId: string; seq: number; ev: BridgeEvent }
  | { t: "proc"; kind: "up" | "down" | "changed"; info: ProcessInfo }
  | { t: "pong"; ts: number };

/** 一台电脑的连接信息。relays 中是中继的基础地址，例如 "ws://203.0.113.5:7443" 或 "wss://relay.example.com" */
export interface HostEndpoint {
  hostId: string;          // 22 字符 base64url（16 字节随机）
  hostKey: string;         // hostd 长期公钥，base64（D5）
  hostName: string;
  relays: string[];        // 本期只用第一个
  direct?: string;         // 例如 "ws://192.168.1.10:7444"
}

/** 配对二维码内容（JSON 字符串）。`pi-hostd pair` 生成 */
export interface PairQr extends HostEndpoint { v: 2; kind: "pair"; code: string }
/** 连接信息二维码（不含配对码）。`pi-hostd qr` 生成，用于换 VPS 后更新手机上的地址 */
export interface EndpointQr extends HostEndpoint { v: 2; kind: "endpoint" }
