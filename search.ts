import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { GIT_SAFETY } from "./git.ts";

/**
 * Directories not worth indexing or searching outside a git repository, where there is no .gitignore to
 * say so. (Hidden directories are skipped as well.)
 */
const SKIP_DIRS: Record<string, true> = {
	node_modules: true,
	__pycache__: true,
	venv: true,
	"site-packages": true,
	target: true,
	dist: true,
	build: true,
	coverage: true,
};

export const MAX_WALK_FILES = 50_000;
const MAX_WALK_DIRS = 20_000;
const SEARCH_MAX_LINES = 2_000;
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * Every file under `root` as a root-relative path, breadth first so shallow files come first. Hidden entries,
 * symlinks and the directories in SKIP_DIRS are skipped. `partial` says a size limit cut the walk short.
 */
export async function walkFiles(root: string, limit = MAX_WALK_FILES): Promise<{ files: string[]; partial: boolean }> {
	const files: string[] = [];
	const queue: string[] = [""]; // directories, relative to root
	for (let i = 0; i < queue.length; i++) {
		if (i >= MAX_WALK_DIRS) return { files, partial: true };
		const rel = queue[i];
		let entries: Dirent[];
		try {
			entries = await readdir(join(root, rel), { withFileTypes: true });
		} catch {
			continue; // unreadable directory
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (SKIP_DIRS[entry.name] !== true) queue.push(path);
			} else if (entry.isFile()) {
				if (files.length >= limit) return { files, partial: true };
				files.push(path);
			}
		}
	}
	return { files, partial: false };
}

/**
 * Run a command and return its stdout, stopping it once it has printed `maxLines` lines or run for `timeoutMs`
 * (a text search over a huge tree must not hang the browser). Undefined when the command cannot be started.
 */
export function runCapped(cmd: string, args: string[], cwd: string, maxLines: number, timeoutMs: number): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
	let out = "";
	let lines = 0;
	let finished = false;
	const finish = (value: string | undefined): void => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		child.kill();
		resolve(value);
	};
	const timer = setTimeout(() => finish(out), timeoutMs);
	child.stdout.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		out += text;
		lines += text.split("\n").length - 1;
		if (lines >= maxLines) finish(out);
	});
	child.on("error", () => finish(undefined)); // e.g. the command is not installed
	child.on("close", () => finish(out));
	return promise;
}

/**
 * Search file contents for `query` as a fixed string; smart case (no capitals: ignore case). Output lines are
 * `path\0line:text` (`path\0line\0text` from git grep): see parseGrep. Inside a repository that is `git grep` over tracked and untracked files. Elsewhere it is
 * ripgrep if installed (`ripgrep` false skips it), else `find` handing files to the system grep, over `cwd` and
 * below, skipping hidden entries, symlinks and SKIP_DIRS like `walkFiles` does.
 */
export async function grepText(cwd: string, query: string, inRepo: boolean, ripgrep = true): Promise<string> {
	const ignoreCase = query === query.toLowerCase();
	if (inRepo) {
		const args = [...GIT_SAFETY, "grep", "-n", "-z", "-I", "-F", "--untracked", ...(ignoreCase ? ["-i"] : []), "-e", query];
		return (await runCapped("git", args, cwd, SEARCH_MAX_LINES, SEARCH_TIMEOUT_MS)) ?? "";
	}
	const skip = Object.keys(SKIP_DIRS);
	const rgArgs = [
		"--line-number",
		"--no-heading",
		"--with-filename",
		"--null",
		"--fixed-strings",
		"--color",
		"never",
		ignoreCase ? "--ignore-case" : "--case-sensitive",
		...skip.flatMap(dir => ["--glob", `!${dir}`]),
		"-e",
		query,
		".",
	];
	if (ripgrep) {
		const viaRipgrep = await runCapped("rg", rgArgs, cwd, SEARCH_MAX_LINES, SEARCH_TIMEOUT_MS);
		if (viaRipgrep !== undefined) return viaRipgrep;
	}
	// `find` prunes by name. grep's own --exclude-dir cannot: BSD grep matches it against the whole path, so
	// ".?*" (hidden) would also exclude "./src". /dev/null makes grep print the file name even for one file.
	const pruned = [".?*", ...skip].flatMap((name, i) => (i === 0 ? ["-name", name] : ["-o", "-name", name]));
	const findArgs = [".", "(", ...pruned, ")", "-prune", "-o", "-type", "f", "-exec", "grep", "-nIF", "--null", ...(ignoreCase ? ["-i"] : []), "-e", query, "/dev/null", "{}", "+"];
	return (await runCapped("find", findArgs, cwd, SEARCH_MAX_LINES, SEARCH_TIMEOUT_MS)) ?? "";
}
