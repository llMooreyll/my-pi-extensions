import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { DirEntry } from "../../protocol/src/index.ts";
import { err } from "./errors.ts";

const LIMIT = 300;

/**
 * Subdirectories of `path` for the phone's folder completion. "~" expands to the home directory and a
 * relative path is taken from home. Hidden folders are left out unless the path itself is hidden-aware
 * (the phone filters by the typed prefix, so it asks with the parent directory only).
 */
export async function listDirs(input: string): Promise<{ path: string; home: string; dirs: string[] }> {
  const home = homedir();
  const raw = input.trim() || "~";
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? home + raw.slice(1) : raw;
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded);
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (e) { throw err("not_found", `cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`); }
  const dirs = entries
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name)
    .sort((a, b) => (a.startsWith(".") === b.startsWith(".") ? a.localeCompare(b) : a.startsWith(".") ? 1 : -1))
    .slice(0, LIMIT);
  return { path, home, dirs };
}

const ENTRY_LIMIT = 500;

/** Folders and files of `path` (folders first), for picking a file on the computer to mention to pi. Names only. */
export async function listEntries(input: string): Promise<{ path: string; home: string; entries: DirEntry[] }> {
  const home = homedir();
  const path = expandPath(input, home);
  let list;
  try { list = await readdir(path, { withFileTypes: true }); }
  catch (e) { throw err("not_found", `cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`); }
  const hiddenLast = (a: string, b: string) => (a.startsWith(".") === b.startsWith(".") ? a.localeCompare(b) : a.startsWith(".") ? 1 : -1);
  const entries = await Promise.all(list.slice(0, ENTRY_LIMIT * 2).map(async (d): Promise<DirEntry | undefined> => {
    try {
      // Symlinks count as what they point to; dangling ones are left out.
      const st = await stat(join(path, d.name));
      if (st.isDirectory()) return { name: d.name, dir: true, mtime: Math.round(st.mtimeMs) };
      if (st.isFile()) return { name: d.name, dir: false, size: st.size, mtime: Math.round(st.mtimeMs) };
      return undefined;
    } catch { return undefined; }
  }));
  const ok = entries.filter((e): e is DirEntry => !!e).sort((a, b) => (a.dir === b.dir ? hiddenLast(a.name, b.name) : a.dir ? -1 : 1)).slice(0, ENTRY_LIMIT);
  return { path, home, entries: ok };
}

/** Create a folder (and missing parents) inside the home directory, for starting pi in a new project. */
export async function makeDir(input: string): Promise<{ path: string; created: boolean }> {
  const home = homedir();
  const path = expandPath(input, home);
  if (!isAbsolute(input.trim()) && !input.trim().startsWith("~")) throw err("bad_request", "path must start with / or ~/");
  // Check against the real home through the deepest folder that exists, so a symlink cannot lead outside.
  let probe = path;
  while (!existsSync(probe)) probe = dirname(probe);
  const realHome = realpathSync(home);
  const realProbe = realpathSync(probe);
  if (realProbe !== realHome && !realProbe.startsWith(realHome + sep)) throw err("bad_request", "The folder must be inside the home directory");
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) throw err("bad_request", `${path} exists and is not a folder`);
    return { path, created: false };
  }
  try { await mkdir(path, { recursive: true, mode: 0o755 }); }
  catch (e) { throw err("bad_request", `cannot create ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`); }
  return { path, created: true };
}

function expandPath(input: string, home: string): string {
  const raw = input.trim() || "~";
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? home + raw.slice(1) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded);
}
