import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { randomHex } from "./fsutil.ts";

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {}

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
}

function gitEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  // Never block on a credential prompt (e.g. during submodule updates).
  return { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" };
}

function failure(args: string[], err: any): GitError {
  const stderr = err?.stderr ? String(err.stderr).trim() : "";
  return new GitError(`git ${args.join(" ")} failed: ${stderr || err?.message || String(err)}`);
}

function git(args: string[], cwd: string, options: GitOptions = {}): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      env: gitEnv(options.env),
      input: options.input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    throw failure(args, err);
  }
}

/** Same as git() but keeps raw bytes, so patches with non-UTF-8 content survive. */
function gitBuffer(args: string[], cwd: string, options: GitOptions = {}): Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      env: gitEnv(options.env),
      input: options.input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    throw failure(args, err);
  }
}

export interface RepoInfo {
  /** Real path of the working-tree root. */
  top: string;
  /** Real path of the shared .git directory. */
  commonDir: string;
  /** Path of `cwd` relative to `top` ("" at the root). */
  subdir: string;
}

/** Null when `cwd` is not inside a non-bare git working tree. */
export function getRepoInfo(cwd: string): RepoInfo | null {
  let top: string;
  try {
    top = git(["rev-parse", "--show-toplevel"], cwd).trim();
  } catch {
    return null;
  }
  if (!top) return null;
  const commonRaw = git(["rev-parse", "--git-common-dir"], cwd).trim();
  const commonDir = realpathSync(isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw));
  const realTop = realpathSync(top);
  return { top: realTop, commonDir, subdir: relative(realTop, realpathSync(cwd)) };
}

export function repoKey(commonDir: string): string {
  return createHash("sha1").update(commonDir).digest("hex").slice(0, 12);
}

/** A reason string when a merge, rebase, cherry-pick or revert is in progress. */
export function repoBusyReason(top: string): string | null {
  const markers: Array<[string, string]> = [
    ["MERGE_HEAD", "a merge"],
    ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase or am"],
    ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ["REVERT_HEAD", "a revert"],
  ];
  for (const [name, label] of markers) {
    const raw = git(["rev-parse", "--git-path", name], top).trim();
    if (existsSync(isAbsolute(raw) ? raw : resolve(top, raw))) {
      return `the repository is in the middle of ${label}`;
    }
  }
  return null;
}

/**
 * Commit the current working tree, including uncommitted and untracked
 * (non-ignored) files, without touching the user's index or files.
 */
export function createSnapshot(top: string, message: string): string {
  const tmpIndex = join(tmpdir(), `pi-team-index-${process.pid}-${randomHex(4)}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    let hasHead = true;
    try {
      git(["rev-parse", "--verify", "-q", "HEAD"], top);
    } catch {
      hasHead = false;
    }
    if (hasHead) git(["read-tree", "HEAD"], top, { env });
    git(["add", "-A"], top, { env });
    const tree = git(["write-tree"], top, { env }).trim();
    const args = [
      "-c", "user.name=pi-team",
      "-c", "user.email=pi-team@localhost",
      "-c", "commit.gpgsign=false",
      "commit-tree", tree,
      "-m", message,
    ];
    if (hasHead) args.push("-p", "HEAD");
    return git(args, top).trim();
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

export function addWorktree(top: string, branch: string, path: string, commit: string): void {
  mkdirSync(dirname(path), { recursive: true });
  git(["worktree", "add", "-b", branch, path, commit], top);
}

/** Returns a warning when submodule initialisation fails; null otherwise. */
export function initSubmodules(top: string, worktree: string): string | null {
  if (!existsSync(join(top, ".gitmodules"))) return null;
  try {
    git(["submodule", "update", "--init", "--recursive"], worktree);
    return null;
  } catch (err) {
    return `submodule init failed: ${(err as Error).message}`;
  }
}

/**
 * Symlink git-ignored paths (such as node_modules) from the main tree into the
 * worktree. Paths that are not ignored are refused, because a link to them
 * would show up as an untracked change. Returns one warning per skipped path.
 */
export function linkIgnoredPaths(
  top: string,
  worktree: string,
  links: string[],
): { linked: string[]; warnings: string[] } {
  const linked: string[] = [];
  const warnings: string[] = [];
  for (const raw of links) {
    const rel = normalize(raw).replace(/[/\\]+$/, "");
    if (!rel || rel === "." || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      warnings.push(`${raw}: must be a path inside the repository`);
      continue;
    }
    const source = join(top, rel);
    if (!existsSync(source)) {
      warnings.push(`${rel}: does not exist in the main tree`);
      continue;
    }
    try {
      git(["check-ignore", "-q", rel], top);
    } catch {
      warnings.push(`${rel}: not ignored by git, not linked`);
      continue;
    }
    const target = join(worktree, rel);
    let targetExists = false;
    try {
      lstatSync(target);
      targetExists = true;
    } catch {}
    if (targetExists) {
      warnings.push(`${rel}: already exists in the worktree, not linked`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
    linked.push(rel);
  }
  return { linked, warnings };
}

/**
 * True when `git status` reports nothing. `linkedPaths` are symlinks created by
 * linkIgnoredPaths: a pattern such as `node_modules/` matches only directories,
 * so git shows the link itself as untracked; those entries are not changes.
 */
export function isWorktreeClean(worktree: string, linkedPaths: string[] = []): boolean {
  const links = new Set(linkedPaths.map((p) => normalize(p).replace(/[/\\]+$/, "")));
  const lines = git(["status", "--porcelain", "-z"], worktree).split("\0").filter(Boolean);
  return lines.every((line) => line.startsWith("?? ") && links.has(line.slice(3).replace(/\/$/, "")));
}

export function revParse(ref: string, cwd: string): string {
  return git(["rev-parse", ref], cwd).trim();
}

export type IntegrateResult =
  | { status: "empty" }
  | { status: "applied"; files: string[]; head: string }
  | { status: "conflict"; files: string[]; reason: string };

/**
 * Apply the changes `from..branch` to the working tree at `top`. `git apply` is
 * all-or-nothing, so a conflict leaves the working tree untouched.
 */
export function integrateBranch(top: string, from: string, branch: string): IntegrateResult {
  const head = revParse(branch, top);
  const patch = gitBuffer(["diff", "--binary", "--no-ext-diff", "--no-textconv", from, head], top);
  if (patch.length === 0) return { status: "empty" };
  const files = git(["diff", "--name-only", "-z", from, head], top).split("\0").filter(Boolean);
  try {
    gitBuffer(["apply", "--check", "--binary", "-"], top, { input: patch });
  } catch (err) {
    return { status: "conflict", files, reason: (err as Error).message };
  }
  gitBuffer(["apply", "--binary", "-"], top, { input: patch });
  return { status: "applied", files, head };
}

export function resetWorktree(worktree: string, commit: string): void {
  git(["reset", "--hard", commit], worktree);
}

/** Remove a worktree that the caller has verified to be clean, then its branch. */
export function removeWorktreeAndBranch(top: string, worktree: string, branch: string): void {
  // --force only skips the submodule check; the caller verified there are no changes.
  git(["worktree", "remove", "--force", worktree], top);
  try {
    git(["branch", "-D", branch], top);
  } catch {}
}

export function pruneWorktrees(top: string): void {
  try {
    git(["worktree", "prune"], top);
  } catch {}
}

export function deleteBranch(top: string, branch: string): void {
  try {
    git(["branch", "-D", branch], top);
  } catch {}
}

export function branchExists(top: string, branch: string): boolean {
  try {
    git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], top);
    return true;
  } catch {
    return false;
  }
}
