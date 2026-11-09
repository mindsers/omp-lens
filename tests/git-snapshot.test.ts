import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedBetween, diffSince, snapshotTree, takeSnapshot } from "../git.ts";

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
	expect(diff?.patch).toContain("-a");
	expect(diff?.patch).toContain("+b");
});
