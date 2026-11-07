/** NDJSON framing split on 0x0A only (readline would also split on U+2028/U+2029). */
export class NdjsonDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private onRecord: (value: unknown) => void;
  private onError: (e: unknown, line: string) => void;
  constructor(onRecord: (value: unknown) => void, onError: (e: unknown, line: string) => void) {
    this.onRecord = onRecord;
    this.onError = onError;
  }
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = this.buf.indexOf(0x0a, start);
      if (nl < 0) break;
      const line = this.buf.subarray(start, nl).toString("utf8");
      start = nl + 1;
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch (e) { this.onError(e, line); continue; }
      this.onRecord(value);
    }
    this.buf = start >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(start);
  }
}

export const encodeNdjson = (value: unknown): string => JSON.stringify(value) + "\n";
