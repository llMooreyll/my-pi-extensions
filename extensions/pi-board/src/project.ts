// Project, actor and plan-file helpers (DESIGN §2, §4.1, §6.1).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BOARD_DIR } from "./shared/parse.ts";
import type { Actor, BoardFile } from "./shared/types.ts";

export interface ProjectInfo {
	/** `git rev-parse --show-toplevel` of the process cwd (the worktree root for team members). */
	root: string;
	/** Main repository root, derived from `git rev-parse --git-common-dir`; equals `root` outside worktrees. */
	mainRoot: string;
	isGit: boolean;
}

export interface ActorInfo {
	actor: Actor;
	isLead: boolean;
	memberId?: string;
	branch?: string;
}

function git(args: string[], cwd: string): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch {
		return undefined;
	}
}

export function resolveProject(cwd: string): ProjectInfo {
	const top = git(["rev-parse", "--show-toplevel"], cwd)?.trim();
	if (!top) return { root: cwd, mainRoot: cwd, isGit: false };
	const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)?.trim();
	// A regular or linked-worktree checkout has <main>/.git as its common dir; anything else keeps the toplevel.
	const mainRoot = common && basename(common) === ".git" ? dirname(common) : top;
	return { root: top, mainRoot, isGit: true };
}

function hasBoardDir(dir: string): boolean {
	try {
		return statSync(join(dir, BOARD_DIR)).isDirectory();
	} catch {
		return false;
	}
}

/** DESIGN §2: enabled when docs/board/ exists. Team members in worktrees also count the main repository's copy. */
export function isEnabled(project: ProjectInfo): boolean {
	return hasBoardDir(project.root) || hasBoardDir(project.mainRoot);
}

/** Directory whose docs/board/ is the plan the actor works against. */
export function boardRootFor(project: ProjectInfo, actor: ActorInfo): string {
	if (actor.isLead) return hasBoardDir(project.root) ? project.root : project.mainRoot;
	return hasBoardDir(project.mainRoot) ? project.mainRoot : project.root;
}

export function currentActor(env: NodeJS.ProcessEnv = process.env): ActorInfo {
	const memberId = env.PI_TEAM_MEMBER_ID;
	if (memberId) {
		return {
			actor: `team:${env.PI_TEAM_MEMBER_NAME || memberId}`,
			isLead: false,
			memberId,
			branch: env.PI_TEAM_BRANCH || undefined,
		};
	}
	const subId = env.PI_SUBAGENT_ID;
	if (subId) return { actor: `sub:${env.PI_SUBAGENT_NAME || subId}`, isLead: false };
	return { actor: "lead", isLead: true };
}

/** Resolves a tool path argument the way the built-in tools do (leading @, ~, relative to cwd). */
export function resolveTarget(path: string, cwd: string): string {
	let p = path.startsWith("@") ? path.slice(1) : path;
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Repo-relative POSIX path; the absolute path when the target lies outside the root. */
export function toRepoPath(abs: string, root: string): string {
	const rel = relative(root, abs);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return abs;
	return rel.split(sep).join("/");
}

export function isPlanPath(repoPath: string): boolean {
	return repoPath.startsWith(`${BOARD_DIR}/`);
}

/** Top-level `docs/board/*.md` of a directory as repo-relative path -> content. */
export function readBoardDir(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const dir = join(root, BOARD_DIR);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names.sort()) {
		if (!name.endsWith(".md")) continue;
		try {
			const full = join(dir, name);
			if (!statSync(full).isFile()) continue;
			out.set(`${BOARD_DIR}/${name}`, readFileSync(full, "utf8"));
		} catch {
			// unreadable file: the parser simply does not see it
		}
	}
	return out;
}

/** `docs/board/*.md` as committed at HEAD; empty without commits. */
export function headBoardFiles(root: string): BoardFile[] {
	const listing = git(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", `${BOARD_DIR}/`], root);
	if (!listing) return [];
	const files: BoardFile[] = [];
	for (const path of listing.split("\0")) {
		if (!new RegExp(`^${BOARD_DIR}/[^/]+\\.md$`).test(path)) continue;
		const content = git(["show", `HEAD:${path}`], root);
		if (content !== undefined) files.push({ path, content });
	}
	return files;
}

export function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function fileExists(path: string): boolean {
	return existsSync(path);
}
