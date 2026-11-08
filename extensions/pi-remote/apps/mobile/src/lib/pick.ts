import { Directory, File, Paths } from "expo-file-system";
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
    const size = Number(q.get("size") ?? "1024");
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
    f.write(b);
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
