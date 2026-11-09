import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGrep } from "../find.ts";
import { grepText, runCapped, walkFiles } from "../search.ts";

const made: string[] = [];
afterAll(async () => {
	for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A throwaway folder (outside any git repository) with the given files. */
async function tree(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "lens-test-"));
	made.push(root);
	for (const [rel, text] of Object.entries(files)) {
		await mkdir(join(root, rel, ".."), { recursive: true });
		await writeFile(join(root, rel), text);
	}
	return root;
}

test("walk: breadth first, so shallow files come before deep ones", async () => {
	const root = await tree({ "a.txt": "", "sub/b.txt": "", "sub/deep/c.txt": "", "z.txt": "" });
	const { files, partial } = await walkFiles(root);
	expect(partial).toBe(false);
	expect(files.indexOf("z.txt")).toBeLessThan(files.indexOf("sub/deep/c.txt"));
	expect([...files].sort()).toEqual(["a.txt", "sub/b.txt", "sub/deep/c.txt", "z.txt"]);
});

test("walk skips hidden entries, dependency and build directories, and symlinks", async () => {
	const root = await tree({
		"keep.ts": "",
		".secret/x.txt": "",
		".env": "",
		"node_modules/dep/index.js": "",
		"dist/out.js": "",
		"src/app.ts": "",
	});
	await symlink(join(root, "src"), join(root, "linked"));
	expect([...(await walkFiles(root)).files].sort()).toEqual(["keep.ts", "src/app.ts"]);
});

test("walk reports when a size limit cut it short", async () => {
	const root = await tree({ "a.txt": "", "b.txt": "", "c.txt": "" });
	const { files, partial } = await walkFiles(root, 2);
	expect(files).toHaveLength(2);
	expect(partial).toBe(true);
});

test("a command's output is returned whole when it finishes", async () => {
	expect(await runCapped("printf", ["a\\nb\\nc\\n"], tmpdir(), 100, 5000)).toBe("a\nb\nc\n");
});

test("a runaway command is stopped once it has printed enough lines", async () => {
	const started = Date.now();
	const out = await runCapped("yes", ["x"], tmpdir(), 50, 10_000);
	expect(out?.split("\n").length).toBeGreaterThanOrEqual(50);
	expect(Date.now() - started).toBeLessThan(5000); // not the 10 s timeout
});

test("a command that is not installed gives undefined, not an error", async () => {
	expect(await runCapped("definitely-not-a-real-command-xyz", [], tmpdir(), 10, 1000)).toBeUndefined();
});

// Both backends (ripgrep, and find+grep when ripgrep is missing) must give the same answer.
for (const ripgrep of [true, false]) {
	test(`text search outside a repo (${ripgrep ? "ripgrep" : "find + grep"}): matches, skips hidden and dependency folders, smart case`, async () => {
		const root = await tree({
			"a.txt": "first\nHello TODO later\n",
			"node_modules/x.txt": "TODO hidden\n",
			".hidden/h.txt": "TODO hidden\n",
			".env": "TODO secret\n",
			"sub/b.txt": "nothing here\n",
			"sub/deep/c.txt": "also a todo\n",
		});
		const lower = parseGrep(await grepText(root, "todo", false, ripgrep), 50).hits;
		expect(lower.map(h => `${h.path}:${h.line}`).sort()).toEqual(["a.txt:2", "sub/deep/c.txt:1"]);
		expect(lower.find(h => h.path === "a.txt")?.text).toBe("Hello TODO later");
		const upper = parseGrep(await grepText(root, "Todo", false, ripgrep), 50).hits; // has a capital: case-sensitive
		expect(upper).toEqual([]);
	});
}

for (const ripgrep of [true, false]) {
	test(`text search outside a repo (${ripgrep ? "ripgrep" : "find + grep"}): a path containing ":12:" is kept whole`, async () => {
		const root = await tree({ "odd:12:name.txt": "x\nneedle\n" });
		expect(parseGrep(await grepText(root, "needle", false, ripgrep), 50).hits).toEqual([{ path: "odd:12:name.txt", line: 2, text: "needle" }]);
	});
}

test("text search in a repository (git grep): tracked and untracked files, odd paths kept whole", async () => {
	const { execFileSync } = await import("node:child_process");
	const root = await tree({ "tracked.txt": "needle\n", "odd:3:name.txt": "a\nb\nneedle\n" });
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	execFileSync("git", ["add", "tracked.txt"], { cwd: root });
	const hits = parseGrep(await grepText(root, "needle", true), 50).hits;
	expect(hits.map(h => `${h.path}@${h.line}`).sort()).toEqual(["odd:3:name.txt@3", "tracked.txt@1"]);
});
