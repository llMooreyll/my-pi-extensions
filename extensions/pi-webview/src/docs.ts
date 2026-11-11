import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type DocKind = "md" | "html" | "pdf" | "office";

export interface Doc {
  id: string;
  path: string;
  dir: string;
  name: string;
  kind: DocKind;
  /** Office files are shown through a PDF rendition; this resolves to its path. */
  rendition?: Promise<string>;
}

const KIND_BY_EXT: Record<string, DocKind> = {
  ".md": "md",
  ".markdown": "md",
  ".html": "html",
  ".htm": "html",
  ".pdf": "pdf",
  ".pptx": "office",
  ".ppt": "office",
  ".odp": "office",
  ".docx": "office",
  ".doc": "office",
  ".odt": "office",
  ".rtf": "office",
};

const SLIDE_EXTS = new Set([".pptx", ".ppt", ".odp"]);

export const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-webview");

export function kindOf(path: string): DocKind | undefined {
  return KIND_BY_EXT[extname(path).toLowerCase()];
}

/** "slide" for presentations, "page" for everything paginated. */
export function pageUnit(doc: Doc): "slide" | "page" {
  return SLIDE_EXTS.has(extname(doc.path).toLowerCase()) ? "slide" : "page";
}

export function docId(path: string): string {
  return createHash("sha1").update(path).digest("hex").slice(0, 10);
}

/** Resolve symlinks so one file always maps to one document, however it was named. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function expandPath(input: string, cwd: string): string {
  const p = input.startsWith("~/") || input === "~" ? join(homedir(), input.slice(1)) : input;
  return canonicalPath(isAbsolute(p) ? resolve(p) : resolve(cwd, p));
}

/** Path shown to the user and the model: relative to cwd when inside it. */
export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd) {
    const rel = relative(canonicalPath(cwd), path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  const home = homedir();
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

export function makeDoc(path: string): Doc {
  const kind = kindOf(path);
  if (!kind) throw new Error(`Unsupported file type: ${extname(path) || basename(path)} (supported: md, html, pdf, pptx/ppt/odp, docx/doc/odt/rtf)`);
  return { id: docId(path), path, dir: dirname(path), name: basename(path), kind };
}

let conversionQueue: Promise<unknown> = Promise.resolve();
const PROFILES_DIR = join(CACHE_DIR, "lo-profiles");
// soffice refuses concurrent use of one profile, so every pi process gets its own.
const PROFILE_DIR = join(PROFILES_DIR, String(process.pid));
let profilesSwept = false;

/** Remove profiles left behind by pi processes that are gone. */
async function sweepProfiles(): Promise<void> {
  if (profilesSwept) return;
  profilesSwept = true;
  const names = await readdir(PROFILES_DIR).catch(() => [] as string[]);
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") await rm(join(PROFILES_DIR, name), { recursive: true, force: true });
    }
  }
}

export function removeOfficeProfile(): void {
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}

const CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
let cachePruned = false;

/** Drop PDF renditions and region screenshots older than 30 days; runs once per process. */
export async function pruneCache(): Promise<void> {
  if (cachePruned) return;
  cachePruned = true;
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  for (const sub of ["office", "shots"]) {
    const dir = join(CACHE_DIR, sub);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
      } catch {
        // Removed concurrently by another pi process.
      }
    }
  }
}

/**
 * Convert an office file to PDF with LibreOffice, cached by path + mtime + size.
 * Conversions in one process run one at a time; other pi processes may convert the same file
 * concurrently, so each writes into its own temp directory and moves the result into place.
 */
export function convertOffice(path: string): Promise<string> {
  const st = statSync(path);
  const key = createHash("sha1").update(`${path}\0${st.mtimeMs}\0${st.size}`).digest("hex").slice(0, 16);
  const outDir = join(CACHE_DIR, "office", key);
  const out = join(outDir, basename(path, extname(path)) + ".pdf");
  if (existsSync(out)) return Promise.resolve(out);

  const job = conversionQueue.then(async () => {
    if (existsSync(out)) return out;
    await sweepProfiles();
    await mkdir(outDir, { recursive: true });
    const work = await mkdtemp(join(outDir, ".work-"));
    try {
      // A private profile also keeps conversion working while the user has LibreOffice open.
      const profile = pathToFileURL(PROFILE_DIR).href;
      const args = ["--headless", "--norestore", `-env:UserInstallation=${profile}`, "--convert-to", "pdf", "--outdir", work, path];
      const output = await new Promise<string>((resolveRun) => {
        execFile("soffice", args, { timeout: 180_000 }, (err, stdout, stderr) => {
          resolveRun(err ? `${err.message}\n${stderr}` : `${stdout}${stderr}`);
        });
      });
      const produced = join(work, basename(out));
      if (!existsSync(produced)) throw new Error(`LibreOffice conversion failed: ${output.trim().slice(-400) || "no PDF was produced"}`);
      // Same filesystem, so the rename is atomic: readers see no PDF or a whole one.
      await rename(produced, out);
      return out;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
  conversionQueue = job.catch(() => undefined);
  return job;
}
