// Two-way file transfer (plan 7.7).

export type TransferDir = "to_phone" | "to_computer";
/** waiting: registered and not started, or interrupted and resumable; active: a lane is moving bytes. */
export type TransferState = "waiting" | "active" | "done" | "failed" | "cancelled" | "expired";

export type TransferErrorCode =
  | "changed"       // the source changed after it was offered (size or mtime differ)
  | "missing"       // the source or the .part file is gone
  | "too_large"
  | "no_space"
  | "denied"        // path on the deny list, or not a regular file / directory
  | "expired"
  | "busy"          // too many lanes open for this device
  | "cancelled"
  | "io";

export interface TransferInfo {
  id: string;                  // 22 chars base64url (16 random bytes)
  dir: TransferDir;
  name: string;                // display name; folders become "<name>.zip"
  size: number;                // bytes
  mime?: string;
  state: TransferState;
  bytesDone: number;           // to_phone: last acknowledged by a lane; to_computer: size of the .part on the computer
  computerPath?: string;       // to_phone: the source path (display only); to_computer: final absolute path once done
  note?: string;
  processId?: string;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  error?: { code: TransferErrorCode; message: string };
}

export const FILE_CHUNK_BYTES = 64 * 1024;
/** Bytes sent but not yet acknowledged. Small on purpose: on a slow relay link everything in flight queues in front of
 *  the session's own frames. Measured at 0.55 MB/s: 2 MiB gave ~2 s per request, 512 KiB ~1 s. 256 KiB still allows
 *  ~2.8 MB/s at 90 ms RTT and is no limit on the LAN. */
export const FILE_WINDOW_BYTES = 256 * 1024;
export const MAX_LANES_PER_DEVICE = 2;
/** First line of the block the app appends to a prompt that carries uploaded files. */
export const ATTACH_HEADER = "[Files from the phone, saved on the computer]";
/** Feature flag announced in auth_ok when hostd supports file transfer. */
export const FEATURE_FILES = "files";

// JSON text frames on a file lane. Data travels as binary frames without a header; the channel keeps them in order.
export type LaneOpen =
  | { t: "lane"; kind: "get"; id: string; offset: number }
  | { t: "lane"; kind: "put"; id: string };
export type LaneFromClient = LaneOpen | { t: "ack"; bytes: number } | { t: "cancel" };
export type LaneFromHost =
  | { t: "lane_ok"; offset: number; size: number }
  | { t: "lane_err"; code: TransferErrorCode; message: string }
  | { t: "ack"; bytes: number }
  | { t: "put_done"; info: TransferInfo };

/** "report.pdf (2.3 MB, application/pdf)" style size text shared by the bridge and the app. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
