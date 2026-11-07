import type { ErrorCode, RemoteError } from "../../protocol/src/index.ts";

export class RemoteErr extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export const err = (code: ErrorCode, message?: string) => new RemoteErr(code, message);

export function toRemoteError(e: unknown): RemoteError {
  if (e instanceof RemoteErr) return { code: e.code, message: e.message };
  if (e && typeof e === "object" && "code" in e && "message" in e && typeof (e as RemoteError).code === "string") {
    const r = e as RemoteError;
    return { code: r.code, message: String(r.message) };
  }
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}
