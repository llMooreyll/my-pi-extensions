import type { BridgeEvent } from "../../protocol/src/index.ts";

export interface RingItem { seq: number; ev: BridgeEvent }

/** Fixed-capacity buffer of the most recent events of one pi process. */
export class EventRing {
  lastSeq: number;
  private items: RingItem[] = [];
  private capacity: number;
  constructor(capacity: number, lastSeq: number) {
    this.capacity = capacity;
    this.lastSeq = lastSeq;
  }
  push(seq: number, ev: BridgeEvent): void {
    // A seq that does not follow the previous one means events were dropped upstream; older items are useless for replay.
    if (this.items.length && seq !== this.items[this.items.length - 1]!.seq + 1) this.items = [];
    this.items.push({ seq, ev });
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    this.lastSeq = seq;
  }
  /** Events after `seq`; [] when up to date; null when there is a gap (caller must snapshot). */
  since(seq: number): RingItem[] | null {
    if (seq >= this.lastSeq) return seq === this.lastSeq ? [] : null;
    const first = this.items[0];
    if (!first || first.seq > seq + 1) return null;
    return this.items.filter((i) => i.seq > seq);
  }
}
