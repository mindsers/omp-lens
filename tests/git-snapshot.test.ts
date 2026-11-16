import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedBetween, diffSince, fileDiff, findRepoRoot, snapshotTree, takeSnapshot } from "../git.ts";

const made: string[] = [];
afterAll(async () => {
	for (const dir of made) await rm(dir, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

/** A throwaway repository with one commit holding `files`. */
async function repo(files: Record<string, string>): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "lens-repo-")));
	made.push(root);
	git(root, "init", "-q", ".");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "test");
	for (const [rel, text] of Object.entries(files)) await writeFile(join(root, rel), text);
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
	return root;
}

test("snapshots see tracked and untracked changes, with exact names even when git would quote them", async () => {
	const root = await repo({ "a.txt": "a\n", 'we"ird name.txt': "x\n", "tab\tname.txt": "y\n" });
	const from = await snapshotTree(root);
	await writeFile(join(root, 'we"ird name.txt'), "changed\n");
	await writeFile(join(root, "tab\tname.txt"), "changed\n");
	await writeFile(join(root, "new.txt"), "new\n");
	const to = await snapshotTree(root);
	const changed = await changedBetween(root, from, to);
	expect([...changed].sort()).toEqual([
		[join(root, "new.txt"), "A"],
		[join(root, "tab\tname.txt"), "M"],
		[join(root, 'we"ird name.txt'), "M"],
	]);
});

test("a rename is reported under its new name", async () => {
	const root = await repo({ "old.txt": "some content that stays the same\nacross the rename\n" });
	const from = await snapshotTree(root);
	git(root, "mv", "old.txt", "new.txt");
	const changed = await changedBetween(root, from, await snapshotTree(root));
	expect([...changed]).toEqual([[join(root, "new.txt"), "R"]]);
});

test("snapshots never touch the staging area", async () => {
	const root = await repo({ "a.txt": "a\n" });
	await writeFile(join(root, "a.txt"), "b\n");
	await writeFile(join(root, "untracked.txt"), "u\n");
	const index = await readFile(join(root, ".git", "index"));
	await snapshotTree(root);
	expect((await readFile(join(root, ".git", "index"))).equals(index)).toBe(true);
	expect(git(root, "diff", "--cached", "--name-only")).toBe("");
});

test("ignored files and large untracked files are left out of snapshots", async () => {
	const root = await repo({ ".gitignore": "*.log\n", "a.txt": "a\n" });
	const from = await snapshotTree(root, 100);
	await writeFile(join(root, "debug.log"), "ignored\n");
	await writeFile(join(root, "big.bin"), "x".repeat(101));
	await writeFile(join(root, "small[1].txt"), "x".repeat(10)); // a glob character: excluded paths are literal
	const changed = await changedBetween(root, from, await snapshotTree(root, 100));
	expect([...changed.keys()]).toEqual([join(root, "small[1].txt")]);
});

test("an edit diff lists files with counts and carries the tree ids", async () => {
	const root = await repo({ "a.txt": "one\ntwo\n" });
	const before = await takeSnapshot(join(root, "a.txt"));
	expect(before.kind).toBe("tree");
	await writeFile(join(root, "a.txt"), "one\nTWO\nthree\n");
	const diff = await diffSince(before);
	expect(diff?.files).toEqual([{ status: "M", path: join(root, "a.txt") }]);
	expect(diff?.added).toBe(2);
	expect(diff?.removed).toBe(1);
	expect(diff?.trees).toBeDefined();
	expect(diff?.patch).toContain("+TWO");
});

test("no change gives no diff", async () => {
	const root = await repo({ "a.txt": "a\n" });
	expect(await diffSince(await takeSnapshot(join(root, "a.txt")))).toBeNull();
});

test("outside a repository only the opened file is diffed", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "lens-plain-")));
	made.push(dir);
	const file = join(dir, "f.txt");
	await writeFile(file, "a\n");
	const before = await takeSnapshot(file);
	expect(before.kind).toBe("file");
	await writeFile(file, "b\n");
	const diff = await diffSince(before);
	expect(diff?.files).toEqual([{ status: "M", path: file }]);
	expect(diff?.patch).toContain("--- a/f.txt\n+++ b/f.txt\n"); // not a/a/f.txt
	expect(diff?.patch).toContain("\n-a\n+b");
});

test("a file inside .git, or in a repository git refuses, is still diffed on its own", async () => {
	const root = await repo({ "a.txt": "a\n" });
	const exclude = join(root, ".git", "info", "exclude");
	const inGitDir = await takeSnapshot(exclude);
	expect(inGitDir.kind).toBe("file");
	await writeFile(exclude, "*.log\n");
	expect((await diffSince(inGitDir))?.patch).toContain("+*.log");

	const broken = await repo({ "b.txt": "b\n" });
	await writeFile(join(broken, ".git", "config"), "[broken\n");
	const snap = await takeSnapshot(join(broken, "b.txt"));
	expect(snap.kind).toBe("file");
	await writeFile(join(broken, "b.txt"), "c\n");
	expect((await diffSince(snap))?.files).toEqual([{ status: "M", path: join(broken, "b.txt") }]);
});

test("git reports its failure reason in English whatever the locale", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "lens-plain-")));
	made.push(dir);
	const saved = process.env.LC_ALL;
	process.env.LC_ALL = "fr_FR.UTF-8";
	try {
		expect(await findRepoRoot(dir)).toBeNull(); // recognised as "not a git repository", not an error
	} finally {
		if (saved === undefined) delete process.env.LC_ALL;
		else process.env.LC_ALL = saved;
	}
});

test("outside a repository a created file is A and a deleted one D", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "lens-plain-")));
	made.push(dir);
	const file = join(dir, "new.txt");
	const absent = await takeSnapshot(file);
	await writeFile(file, "hello\n");
	expect((await diffSince(absent))?.files).toEqual([{ status: "A", path: file }]);
	const present = await takeSnapshot(file);
	await rm(file);
	expect((await diffSince(present))?.files).toEqual([{ status: "D", path: file }]);
});

test("editing a gitignored file is still reported, with the rest of the tree's changes", async () => {
	const root = await repo({ ".gitignore": ".env\n", "a.txt": "a\n" });
	await writeFile(join(root, ".env"), "KEY=1\n");
	const before = await takeSnapshot(join(root, ".env"));
	await writeFile(join(root, ".env"), "KEY=2\n");
	await writeFile(join(root, "a.txt"), "b\n"); // e.g. a save hook touched a tracked file too
	const diff = await diffSince(before);
	expect(diff?.files).toEqual([
		{ status: "M", path: join(root, "a.txt") },
		{ status: "M", path: join(root, ".env") },
	]);
	expect(diff?.patch).toContain("+KEY=2");
	expect(diff?.added).toBe(2);
});

test("a file too large to diff is reported as changed, with the diff omitted", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "lens-plain-")));
	made.push(dir);
	const file = join(dir, "big.log");
	await writeFile(file, "x".repeat(3 * 1024 * 1024));
	const before = await takeSnapshot(file);
	expect(await diffSince(before)).toBeNull(); // untouched: same size and mtime
	await Bun.sleep(5);
	await writeFile(file, "y".repeat(3 * 1024 * 1024));
	const diff = await diffSince(before);
	expect(diff?.files).toEqual([{ status: "M", path: file }]);
	expect(diff?.omitted).toContain("big.log is over 2 MB");
});

test.skipIf(process.getuid?.() === 0)("an unreadable file is an error, not a file about to be created", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "lens-plain-")));
	made.push(dir);
	const file = join(dir, "secret.txt");
	await writeFile(file, "a\n");
	await chmod(file, 0o000);
	try {
		await expect(takeSnapshot(file)).rejects.toThrow(/EACCES|permission/i);
	} finally {
		await chmod(file, 0o600);
	}
});

test("a diff against HEAD is empty in a repository without commits, and an error when git fails", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "lens-repo-")));
	made.push(root);
	git(root, "init", "-q", ".");
	await writeFile(join(root, "a.txt"), "a\n");
	expect(await fileDiff(root, join(root, "a.txt"))).toBe("");
	const committed = await repo({ "a.txt": "a\n" });
	await expect(fileDiff(committed, join(committed, "a.txt"), { from: "0".repeat(40), to: "1".repeat(40) })).rejects.toThrow();
});
