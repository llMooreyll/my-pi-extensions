import { Directory, File, FileMode, Paths } from "expo-file-system";
import { registerTestCommand, testLog } from "./test-hooks";

/**
 * Test builds: piremote://test/mkfile?name=a.txt&size=1000[&text=...] makes a file in the cache and queues it,
 * so the next pick returns it without driving the system picker (5.3 item 7).
 */
const queued: File[] = [];
registerTestCommand("mkfile", (q) => {
  const name = q.get("name") ?? "test.txt";
  const dir = new Directory(Paths.cache, `pick-${Date.now()}`);
  dir.create({ idempotent: true });
  const f = new File(dir, name.replace(/[/\\]/g, "_"));
  const text = q.get("text");
  if (text !== null) f.write(text);
  else {
    // Byte i is (i*31+7)&0xff, written in 1 MiB blocks so large test files need little memory.
    const size = Number(q.get("size") ?? "1024");
    const BLOCK = 1 << 20;
    const pattern = new Uint8Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) pattern[i] = (i * 31 + 7) & 0xff;
    f.create({ overwrite: true });
    const h = f.open(FileMode.Truncate);
    try { for (let at = 0; at < size; at += BLOCK) h.writeBytesSync(pattern.subarray(0, Math.min(BLOCK, size - at))); } finally { h.close(); }
  }
  queued.push(f);
  testLog("mkfile", { uri: f.uri, size: f.size });
});

/** System picker for one or more files; undefined when cancelled. */
export async function pickFiles(): Promise<File[] | undefined> {
  if (queued.length) return queued.splice(0, queued.length);
  const r = await File.pickFileAsync({ multipleFiles: true });
  if (r.canceled) return undefined;
  return r.result;
}
