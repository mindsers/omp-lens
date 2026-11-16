import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { safeText } from "./safe.ts";

const MAX_BUFFER = 256 * 1024 * 1024;
/** A file snapshotted on its own (outside a repo, or ignored by git) above this size is compared by size and mtime only. */
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
/**
 * Untracked files larger than this are left out of working-tree snapshots: a stray dump or build artefact
 * would otherwise be hashed into .git/objects on every agent turn.
 */
export const MAX_UNTRACKED_SNAPSHOT_BYTES = 10 * 1024 * 1024;

/**
 * Options for every git call. `.git/config` is not always the user's own (an extracted archive, a shared folder),
 * and some settings name programs for git to run: never let them. `core.fsmonitor` is turned off here, filter
 * drivers by `safetyArgs`; diffs pass --no-ext-diff and --no-textconv, and status and diffs pass
 * --ignore-submodules=all, since a submodule's own config (with filters of its own) would apply inside it.
 */
export const GIT_SAFETY = ["-c", "core.quotepath=false", "-c", "core.fsmonitor=false"];

/**
 * Run git. A failure rejects with git's own first stderr line (made terminal-safe: it can quote file names and
 * config), not node's "Command failed: <the whole command>". Messages are in English (LC_ALL=C) so they can be
 * recognised.
 */
function run(cwd: string, args: string[], env: NodeJS.ProcessEnv, okCodes: number[]): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile("git", args, { cwd, env: { ...env, LC_ALL: "C" }, maxBuffer: MAX_BUFFER, encoding: "utf8" }, (err, stdout, stderr) => {
		if (!err) return resolve(stdout);
		// A non-zero exit the caller declared acceptable (e.g. `diff --no-index` exits 1 on differences).
		if (typeof err.code === "number" && okCodes.includes(err.code)) return resolve(stdout);
		const reason = stderr.split("\n").find(line => line.trim() !== "")?.trim() ?? err.message.split("\n")[0];
		reject(Object.assign(new Error(safeText(reason)), { code: err.code }));
	});
	return promise;
}

/**
 * `-c` overrides that disable every filter driver configured for `cwd`. The snapshots run `git add` on their own
 * at each agent turn, and `git add` (like status and diff) runs a driver's clean or process program on the files
 * its .gitattributes binds. Blank commands turn a driver off and `required=false` keeps git from failing for it.
 * Side effect: a changed git-lfs file is snapshotted with its content rather than its pointer.
 */
export function filterOverrides(configOut: string): string[] {
	const names = new Set<string>();
	for (const line of configOut.split("\n")) {
		const key = line.split(/\s/, 1)[0];
		const m = /^filter\.(.+)\.[^.]+$/.exec(key);
		if (m) names.add(m[1]);
	}
	return [...names].flatMap(name => ["clean", "smudge", "process"].flatMap(k => ["-c", `filter.${name}.${k}=`]).concat("-c", `filter.${name}.required=false`));
}

/**
 * GIT_SAFETY plus the filter overrides for the repository at `cwd`. Reading config runs nothing. Read afresh for
 * every call, so a driver added meanwhile is covered too. Fails closed: when the config cannot be read, the git
 * call is not made.
 */
export async function safetyArgs(cwd: string): Promise<string[]> {
	const out = await run(cwd, [...GIT_SAFETY, "config", "--get-regexp", "^filter\\."], process.env, [0, 1]); // 1: no filters
	return [...GIT_SAFETY, ...filterOverrides(out)];
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env, okCodes: number[] = [0]): Promise<string> {
	return run(cwd, [...(await safetyArgs(cwd)), ...args], env, okCodes);
}

// ── Status ────────────────────────────────────────────────────────────────

export interface GitInfo {
	root: string;
	/** absolute path → one-letter status (M A D R C U T, ? for untracked) */
	changed: Map<string, string>;
	/** directories that contain at least one changed path */
	dirty: Set<string>;
}

/** The repository containing `dir`, null outside one. Throws when git itself fails (not installed, unreadable config). */
export async function findRepoRoot(dir: string): Promise<string | null> {
	try {
		return (await git(dir, ["rev-parse", "--show-toplevel"])).trim() || null;
	} catch (err) {
		// Outside a repository, or inside its .git directory: either way there is no working tree to snapshot.
		if (/not a git repository|must be run in a work tree/i.test(String(err instanceof Error ? err.message : err))) return null;
		throw err;
	}
}

/** Like findRepoRoot, but any failure counts as "not in a repository". */
export async function repoRoot(dir: string): Promise<string | null> {
	return findRepoRoot(dir).catch(() => null);
}

/** True for a missing-file error; anything else (permissions, a directory) is a real failure. */
export function isMissing(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/** Every directory from each path's parent up to and including `root`. Paths outside `root` contribute nothing. */
export function dirsContaining(paths: Iterable<string>, root: string): Set<string> {
	const dirs = new Set<string>();
	const prefix = root.endsWith("/") ? root : `${root}/`;
	for (const path of paths) {
		if (!path.startsWith(prefix)) continue; // outside the root: not ours to mark
		for (let d = dirname(path); ; d = dirname(d)) {
			if (dirs.has(d)) break;
			dirs.add(d);
			if (d === root) break;
		}
	}
	return dirs;
}

/** Two snapshots (git tree ids) of the working tree, and what to call the difference between them. */
export interface TreeRange {
	root: string;
	from: string;
	to: string;
	label: string;
}

/** Parse `git status --porcelain=v1 -z` output into changed files (absolute paths) and the directories containing them. */
export function parseStatus(out: string, root: string): Pick<GitInfo, "changed" | "dirty"> {
	const fields = out.split("\0");
	const changed = new Map<string, string>();
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.length < 4) continue;
		const xy = field.slice(0, 2);
		const path = join(root, field.slice(3));
		if (xy.includes("R") || xy.includes("C")) i++; // -z rename records carry the origin path as the next field
		changed.set(path, xy === "??" ? "?" : xy[1] !== " " ? xy[1] : xy[0]);
	}
	return { changed, dirty: dirsContaining(changed.keys(), root) };
}

export async function gitInfo(root: string): Promise<GitInfo> {
	// GIT_OPTIONAL_LOCKS=0: never contend with the agent's own git commands for index.lock.
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
	const out = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"], env);
	return { root, ...parseStatus(out, root) };
}

// ── Snapshots ─────────────────────────────────────────────────────────────

/** One file's state before an edit: its bytes (null when absent), or only size and mtime when it is too large to keep. */
export type FileSnapshot = { path: string; before: Buffer | null } | { path: string; large: { size: number; mtimeMs: number } };

/**
 * The state before an edit. In a repository, the whole working tree plus the edited file on its own: git leaves
 * ignored files (and large untracked ones) out of the tree, and their edits must still be reported.
 */
export type Snapshot = { kind: "tree"; root: string; tree: string; file: FileSnapshot } | { kind: "file"; file: FileSnapshot };

export interface EditDiff {
	files: { status: string; path: string }[];
	added: number;
	removed: number;
	patch: string;
	/** Present for git snapshots: the two tree ids, usable with `git diff <from> <to>`. */
	trees?: { from: string; to: string };
	/** Why `patch` is missing a file's changes (it was too large to diff). */
	omitted?: string;
}

/** Untracked (not ignored) files above `maxBytes`, repo-relative. */
async function largeUntracked(root: string, env: NodeJS.ProcessEnv, maxBytes: number): Promise<string[]> {
	const out = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"], env);
	const sizes = await Promise.all(
		out
			.split("\0")
			.filter(Boolean)
			.map(async rel => {
				try {
					const info = await lstat(join(root, rel));
					return info.isFile() && info.size > maxBytes ? rel : undefined;
				} catch {
					return undefined; // vanished meanwhile
				}
			}),
	);
	return sizes.filter((rel): rel is string => rel !== undefined);
}

/**
 * Submodules (gitlink entries) in the index, repo-relative. `git add -A` looks inside a submodule it already
 * tracks, under the submodule's own config, filter drivers included; and `add` has no --ignore-submodules.
 */
async function gitlinks(root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
	const out = await git(root, ["ls-files", "-z", "--stage"], env);
	return out
		.split("\0")
		.filter(record => record.startsWith("160000 "))
		.map(record => record.slice(record.indexOf("\t") + 1));
}

/**
 * Hash the whole working tree (tracked + untracked, honouring .gitignore) into a tree object
 * using a throwaway copy of the index, so the user's staging area is never touched.
 * Untracked files above `maxUntrackedBytes` are left out, and submodules stay at the commit the index records.
 */
export async function snapshotTree(root: string, maxUntrackedBytes = MAX_UNTRACKED_SNAPSHOT_BYTES): Promise<string> {
	const indexPath = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
	const tmp = await mkdtemp(join(tmpdir(), "lens-index-"));
	try {
		const tmpIndex = join(tmp, "index");
		await copyFile(indexPath, tmpIndex).catch(err => {
			if (!isMissing(err)) throw err; // a fresh repo has no index yet
		});
		const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
		const skip = [...(await largeUntracked(root, env, maxUntrackedBytes)), ...(await gitlinks(root, env))];
		if (skip.length === 0) await git(root, ["add", "-A"], env);
		else {
			// Pathspecs go through a file: there may be too many for a command line. `literal` keeps names with * or ? exact.
			const specs = join(tmp, "pathspecs");
			await writeFile(specs, [".", ...skip.map(rel => `:(exclude,literal)${rel}`)].join("\0"));
			await git(root, ["add", "-A", `--pathspec-from-file=${specs}`, "--pathspec-file-nul"], env);
		}
		return (await git(root, ["write-tree"], env)).trim();
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

/** Read a file for a snapshot. Only a missing file counts as absent; other read errors are thrown. */
async function snapshotFile(path: string): Promise<FileSnapshot> {
	try {
		const info = await stat(path);
		if (info.size > MAX_SNAPSHOT_FILE_BYTES) return { path, large: { size: info.size, mtimeMs: info.mtimeMs } };
		return { path, before: await readFile(path) };
	} catch (err) {
		if (isMissing(err)) return { path, before: null }; // the edit will create it
		throw err;
	}
}

export async function takeSnapshot(filePath: string): Promise<Snapshot> {
	// When git refuses the repository (an unreadable config, another user's repository), the file alone is still
	// diffed: that diff runs in a temporary directory, away from the repository's config.
	const root = await findRepoRoot(dirname(filePath)).catch(() => null);
	// Resolve symlinks so the path matches what git reports for the tree diff.
	const path = await realpath(filePath).catch(() => filePath);
	if (!root) return { kind: "file", file: await snapshotFile(path) };
	const [tree, file] = await Promise.all([snapshotTree(root), snapshotFile(path)]);
	return { kind: "tree", root, tree, file };
}

export async function diffSince(snap: Snapshot): Promise<EditDiff | null> {
	if (snap.kind === "file") return diffFile(snap.file);
	const tree = await diffTrees(snap.root, snap.tree);
	if (tree?.files.some(f => f.path === snap.file.path)) return tree;
	// The edited file is not in the tree diff: git ignores it, or it is a large untracked file.
	const own = await diffFile(snap.file);
	if (!own) return tree;
	if (!tree) return own;
	return { ...tree, files: [...tree.files, ...own.files], added: tree.added + own.added, removed: tree.removed + own.removed, patch: tree.patch + own.patch, omitted: own.omitted };
}

/**
 * Parse `git diff --name-status -z` output into absolute paths with a one-letter status. NUL-separated output is
 * required: without it git C-quotes names containing `"`, `\`, tabs or newlines, even with core.quotepath=false.
 * Records are `status\0path\0`, or `R100\0old\0new\0` for renames and copies (the new name is kept).
 */
export function parseNameStatus(out: string, root: string): { status: string; path: string }[] {
	const fields = out.split("\0");
	const rows: { status: string; path: string }[] = [];
	for (let i = 0; i < fields.length; ) {
		const code = fields[i];
		if (!code) {
			i++;
			continue;
		}
		const twoPaths = code[0] === "R" || code[0] === "C";
		const path = fields[i + (twoPaths ? 2 : 1)];
		i += twoPaths ? 3 : 2;
		if (path === undefined || path === "") break; // truncated output
		rows.push({ status: code[0], path: join(root, path) });
	}
	return rows;
}

/** Files that differ between two snapshots (git tree ids), as absolute path → one-letter status. */
export async function changedBetween(root: string, from: string, to: string): Promise<Map<string, string>> {
	const out = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--name-status", "-z", "-M", from, to]);
	return new Map(parseNameStatus(out, root).map(f => [f.path, f.status]));
}

async function diffTrees(root: string, from: string): Promise<EditDiff | null> {
	const to = await snapshotTree(root);
	if (to === from) return null;
	const [status, numstat, patch] = await Promise.all([
		git(root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--name-status", "-z", "-M", from, to]),
		git(root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--numstat", "-M", from, to]),
		git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "-M", from, to]),
	]);
	const files = parseNameStatus(status, root);
	let added = 0;
	let removed = 0;
	for (const line of numstat.split("\n")) {
		const [a, r] = line.split("\t");
		if (/^\d+$/.test(a)) added += Number(a);
		if (/^\d+$/.test(r)) removed += Number(r);
	}
	return { files, added, removed, patch, trees: { from, to } };
}

async function diffFile(snap: FileSnapshot): Promise<EditDiff | null> {
	const path = snap.path;
	const now = await snapshotFile(path);
	if ("large" in snap || "large" in now) {
		// Too large to diff: say whether it changed, by size and mtime.
		const was = "large" in snap ? snap.large : snap.before && { size: snap.before.length, mtimeMs: -1 };
		const is = "large" in now ? now.large : now.before && { size: now.before.length, mtimeMs: -1 };
		if (was && is && was.size === is.size && was.mtimeMs === is.mtimeMs) return null;
		const status = !was ? "A" : !is ? "D" : "M";
		return { files: [{ status, path }], added: 0, removed: 0, patch: "", omitted: `${basename(path)} is over ${MAX_SNAPSHOT_FILE_BYTES / 1024 / 1024} MB` };
	}
	const before = snap.before;
	const after = now.before;
	if (before === null && after === null) return null;
	if (before !== null && after !== null && before.equals(after)) return null;

	const name = basename(path);
	const tmp = await mkdtemp(join(tmpdir(), "lens-diff-"));
	try {
		await mkdir(join(tmp, "a"));
		await mkdir(join(tmp, "b"));
		await writeFile(join(tmp, "a", name), before ?? "");
		await writeFile(join(tmp, "b", name), after ?? "");
		// `git diff --no-index` exits 1 when the files differ.
		const raw = await git(tmp, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", `a/${name}`, `b/${name}`], process.env, [0, 1]);
		const patch = raw.replaceAll(`a/a/${name}`, `a/${name}`).replaceAll(`b/b/${name}`, `b/${name}`);
		let added = 0;
		let removed = 0;
		for (const line of patch.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) added++;
			else if (line.startsWith("-") && !line.startsWith("---")) removed++;
		}
		const status = before === null ? "A" : after === null ? "D" : "M";
		return { files: [{ status, path }], added, removed, patch };
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

/**
 * One file's unified diff: against HEAD (staged and unstaged), or between two snapshots (git tree ids) when `range` is given.
 * Empty when there is nothing to show, or in a repo without commits. Throws when git fails.
 */
export async function fileDiff(root: string, path: string, range?: { from: string; to: string }): Promise<string> {
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
	const revs = range ? [range.from, range.to] : ["HEAD"];
	try {
		return await git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...revs, "--", path], env);
	} catch (err) {
		// No commits yet: nothing to diff against. Any other failure is the caller's to report.
		if (!range && (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], env, [0, 1]).catch(() => "x")) === "") return "";
		throw err;
	}
}

/** Every file git knows in the working tree, repo-relative: tracked plus untracked, minus ignored. */
export async function listFiles(root: string): Promise<string[]> {
	const out = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { ...process.env, GIT_OPTIONAL_LOCKS: "0" });
	return out.split("\0").filter(Boolean);
}
