// Minimal ZIP writer: stored (no compression), UTF-8 names, no zip64 (plan 7.7.4). No dependencies.
import { lstat, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { crc32 } from "node:zlib";

const MAX_ENTRIES = 10_000;
const BUF = 1024 * 1024;
const FLAG_UTF8 = 0x0800;
const ZIP4G = 0xffffffff;

interface Entry { rel: string; abs: string; dir: boolean; size: number; mode: number; mtime: Date; crc: number; offset: number }

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Regular files and directories under root, depth first, sorted; symlinks, sockets and devices are skipped. */
async function walk(root: string, prefix: string, out: Entry[]): Promise<void> {
  const names = (await readdir(root)).sort();
  for (const n of names) {
    const abs = join(root, n);
    const st = await lstat(abs);
    const rel = `${prefix}${n}`;
    if (st.isDirectory()) {
      out.push({ rel: rel + "/", abs, dir: true, size: 0, mode: st.mode, mtime: st.mtime, crc: 0, offset: 0 });
      await walk(abs, rel + "/", out);
    } else if (st.isFile()) {
      out.push({ rel, abs, dir: false, size: st.size, mode: st.mode, mtime: st.mtime, crc: 0, offset: 0 });
    }
    if (out.length > MAX_ENTRIES) throw new Error("too many files (more than 10000)");
  }
}

async function fileCrc(path: string, size: number, buf: Buffer): Promise<number> {
  const fh = await open(path, "r");
  try {
    let c = 0;
    let pos = 0;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) throw new Error(`file shrank while packing: ${path}`);
      c = crc32(buf.subarray(0, bytesRead), c);
      pos += bytesRead;
    }
    return c;
  } finally { await fh.close(); }
}

/**
 * Pack folder `src` into `dest` as "<folder name>/…". Returns the archive size.
 * Throws Error("too_large") when the archive would exceed maxBytes; dest is removed on any failure.
 */
export async function zipFolder(src: string, dest: string, maxBytes: number): Promise<number> {
  const top = basename(src);
  const st = await lstat(src);
  const entries: Entry[] = [{ rel: top + "/", abs: src, dir: true, size: 0, mode: st.mode, mtime: st.mtime, crc: 0, offset: 0 }];
  await walk(src, top + "/", entries);
  let estimate = 22;
  for (const e of entries) estimate += 30 + 46 + 2 * Buffer.byteLength(e.rel) + e.size;
  if (estimate > maxBytes || estimate > ZIP4G) throw new Error("too_large");

  const buf = Buffer.allocUnsafe(BUF);
  let out: FileHandle | undefined;
  try {
    out = await open(dest, "w", 0o600);
    let pos = 0;
    const write = async (b: Buffer) => { await out!.write(b, 0, b.length, pos); pos += b.length; };
    for (const e of entries) {
      if (!e.dir) e.crc = await fileCrc(e.abs, e.size, buf);
      const name = Buffer.from(e.rel, "utf8");
      const { time, date } = dosTime(e.mtime);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(FLAG_UTF8, 6);
      h.writeUInt16LE(0, 8);
      h.writeUInt16LE(time, 10);
      h.writeUInt16LE(date, 12);
      h.writeUInt32LE(e.crc >>> 0, 14);
      h.writeUInt32LE(e.size, 18);
      h.writeUInt32LE(e.size, 22);
      h.writeUInt16LE(name.length, 26);
      h.writeUInt16LE(0, 28);
      e.offset = pos;
      await write(h);
      await write(name);
      if (!e.dir) {
        const fh = await open(e.abs, "r");
        try {
          let left = e.size;
          let at = 0;
          while (left > 0) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), at);
            if (!bytesRead) throw new Error(`file shrank while packing: ${e.abs}`);
            await write(buf.subarray(0, bytesRead));
            left -= bytesRead;
            at += bytesRead;
          }
        } finally { await fh.close(); }
      }
    }
    const cdStart = pos;
    for (const e of entries) {
      const name = Buffer.from(e.rel, "utf8");
      const { time, date } = dosTime(e.mtime);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE((3 << 8) | 20, 4);        // made by Unix, spec 2.0
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(FLAG_UTF8, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(e.crc >>> 0, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt16LE(0, 30);
      c.writeUInt16LE(0, 32);
      c.writeUInt16LE(0, 34);
      c.writeUInt16LE(0, 36);
      c.writeUInt32LE((((e.mode & 0xffff) << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
      c.writeUInt32LE(e.offset, 42);
      await write(c);
      await write(name);
    }
    const cdSize = pos - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    await write(end);
    await out.close();
    out = undefined;
    if (pos > maxBytes) throw new Error("too_large");
    return pos;
  } catch (e) {
    try { await out?.close(); } catch { /* ignore */ }
    await rm(dest, { force: true });
    throw e;
  }
}
