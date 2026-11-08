import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
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
