import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { safetyArgs } from "./git.ts";
import { safeText } from "./safe.ts";

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

/** What a capped run produced. `code` is null when the run was stopped (`capped` or `timedOut`) or killed. */
export interface CappedRun {
	out: string;
	code: number | null;
	/** Stopped after `maxLines` lines: there may be more. */
	capped: boolean;
	/** Stopped after `timeoutMs`: the output is partial. */
	timedOut: boolean;
	/** The first line the command wrote to stderr, terminal-safe (it can quote file names). */
	stderr: string;
}

/**
 * Run a command and collect its stdout, stopping it once it has printed `maxLines` lines or run for `timeoutMs`
 * (a text search over a huge tree must not hang the browser). Undefined when the command cannot be started.
 */
export function runCapped(cmd: string, args: string[], cwd: string, maxLines: number, timeoutMs: number): Promise<CappedRun | undefined> {
	const { promise, resolve } = Promise.withResolvers<CappedRun | undefined>();
	const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	let lines = 0;
	let capped = false;
	let timedOut = false;
	let finished = false;
	const finish = (code: number | null, started = true): void => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		child.kill();
		resolve(started ? { out, code, capped, timedOut, stderr: safeText(err.split("\n", 1)[0].trim()) } : undefined);
	};
	const timer = setTimeout(() => {
		timedOut = true;
		finish(null);
	}, timeoutMs);
	child.stdout.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		out += text;
		lines += text.split("\n").length - 1;
		if (lines >= maxLines) {
			capped = true;
			finish(null);
		}
	});
	// Keep only the start of stderr, but keep reading it so a chatty command never blocks on a full pipe.
	child.stderr.on("data", (chunk: Buffer) => {
		if (err.length < 4096) err += chunk.toString("utf8");
	});
	child.on("error", () => finish(null, false)); // e.g. the command is not installed
	child.on("close", code => finish(code));
	return promise;
}

/** A text search's raw output (see parseGrep), whether it is partial, and why it failed if it did. */
export interface GrepResult {
	out: string;
	/** Stopped early (line cap or timeout): there may be more hits. */
	partial: boolean;
	timedOut: boolean;
	/** Set when the search failed and found nothing: not the same as "no matches". */
	error?: string;
}

/**
 * Turn a run into a result. `failed` says whether an exit code is an error for this command. A command that printed
 * hits and then hit an error (an unreadable file) still returns its hits.
 */
function grepResult(run: CappedRun, failed: (code: number) => boolean): GrepResult {
	const result: GrepResult = { out: run.out, partial: run.capped || run.timedOut, timedOut: run.timedOut };
	if (run.out === "" && run.code !== null && failed(run.code)) result.error = run.stderr || `exit code ${run.code}`;
	return result;
}

/**
 * Search file contents for `query` as a fixed string; smart case (no capitals: ignore case). Output lines are
 * `path\0line:text` (`path\0line\0text` from git grep): see parseGrep. Inside a repository that is `git grep`
 * over tracked and untracked files (a config that cannot be read rejects: see safetyArgs). Elsewhere it is
 * ripgrep if installed (`ripgrep` false skips it), else `find` handing files to the system grep, over `cwd` and
 * below, skipping hidden entries, symlinks and SKIP_DIRS like `walkFiles` does.
 */
export async function grepText(cwd: string, query: string, inRepo: boolean, ripgrep = true): Promise<GrepResult> {
	const ignoreCase = query === query.toLowerCase();
	if (inRepo) {
		const args = [...(await safetyArgs(cwd)), "grep", "-n", "-z", "-I", "-F", "--untracked", ...(ignoreCase ? ["-i"] : []), "-e", query];
		const run = await runCapped("git", args, cwd, SEARCH_MAX_LINES, SEARCH_TIMEOUT_MS);
		if (!run) return { out: "", partial: false, timedOut: false, error: "git could not be started" };
		return grepResult(run, code => code > 1); // 1: no matches
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
		if (viaRipgrep !== undefined) return grepResult(viaRipgrep, code => code > 1); // 1: no matches
	}
	// `find` prunes by name. grep's own --exclude-dir cannot: BSD grep matches it against the whole path, so
	// ".?*" (hidden) would also exclude "./src". /dev/null makes grep print the file name even for one file.
	const pruned = [".?*", ...skip].flatMap((name, i) => (i === 0 ? ["-name", name] : ["-o", "-name", name]));
	const findArgs = [".", "(", ...pruned, ")", "-prune", "-o", "-type", "f", "-exec", "grep", "-nIF", "--null", ...(ignoreCase ? ["-i"] : []), "-e", query, "/dev/null", "{}", "+"];
	const run = await runCapped("find", findArgs, cwd, SEARCH_MAX_LINES, SEARCH_TIMEOUT_MS);
	if (!run) return { out: "", partial: false, timedOut: false, error: "find could not be started" };
	// find's exit code is non-zero whenever one grep batch matched nothing: it says nothing about failure.
	return grepResult(run, () => false);
}
