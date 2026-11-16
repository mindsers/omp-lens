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
	expect(await runCapped("printf", ["a\\nb\\nc\\n"], tmpdir(), 100, 5000)).toEqual({ out: "a\nb\nc\n", code: 0, capped: false, timedOut: false, stderr: "" });
});

test("a run that times out returns what it printed so far, marked as timed out", async () => {
	const started = Date.now();
	const run = await runCapped("sh", ["-c", "echo early; sleep 5"], tmpdir(), 100, 200);
	expect(run).toMatchObject({ out: "early\n", timedOut: true, capped: false, code: null });
	expect(Date.now() - started).toBeLessThan(3000);
});

test("a failing command reports its exit code and the start of its stderr", async () => {
	const run = await runCapped("sh", ["-c", "echo 'fatal: broken' >&2; echo more >&2; exit 128"], tmpdir(), 100, 5000);
	expect(run).toMatchObject({ out: "", code: 128, stderr: "fatal: broken" });
});

test("a runaway command is stopped once it has printed enough lines", async () => {
	const started = Date.now();
	const run = await runCapped("yes", ["x"], tmpdir(), 50, 10_000);
	expect(run?.out.split("\n").length).toBeGreaterThanOrEqual(50);
	expect(run?.capped).toBe(true);
	expect(Date.now() - started).toBeLessThan(5000); // not the 10 s timeout
});

test("a command that is not installed gives undefined, not an error", async () => {
	expect(await runCapped("definitely-not-a-real-command-xyz", [], tmpdir(), 10, 1000)).toBeUndefined();
});

// Both backends (ripgrep, and find+grep when ripgrep is missing) must give the same answer. Without rg installed
// the "ripgrep" runs would silently test find+grep twice, so they are skipped.
const hasRipgrep = Bun.which("rg") !== null;
for (const ripgrep of [true, false]) {
	test.skipIf(ripgrep && !hasRipgrep)(`text search outside a repo (${ripgrep ? "ripgrep" : "find + grep"}): matches, skips hidden and dependency folders, smart case`, async () => {
		const root = await tree({
			"a.txt": "first\nHello TODO later\n",
			"node_modules/x.txt": "TODO hidden\n",
			".hidden/h.txt": "TODO hidden\n",
			".env": "TODO secret\n",
			"sub/b.txt": "nothing here\n",
			"sub/deep/c.txt": "also a todo\n",
		});
		const lower = parseGrep((await grepText(root, "todo", false, ripgrep)).out, 50).hits;
		expect(lower.map(h => `${h.path}:${h.line}`).sort()).toEqual(["a.txt:2", "sub/deep/c.txt:1"]);
		expect(lower.find(h => h.path === "a.txt")?.text).toBe("Hello TODO later");
		const upper = parseGrep((await grepText(root, "Todo", false, ripgrep)).out, 50).hits; // has a capital: case-sensitive
		expect(upper).toEqual([]);
	});
}

for (const ripgrep of [true, false]) {
	test.skipIf(ripgrep && !hasRipgrep)(`text search outside a repo (${ripgrep ? "ripgrep" : "find + grep"}): a path containing ":12:" is kept whole`, async () => {
		const root = await tree({ "odd:12:name.txt": "x\nneedle\n" });
		expect(parseGrep((await grepText(root, "needle", false, ripgrep)).out, 50).hits).toEqual([{ path: "odd:12:name.txt", line: 2, text: "needle" }]);
	});
}

test("text search in a repository (git grep): tracked and untracked files, odd paths kept whole", async () => {
	const { execFileSync } = await import("node:child_process");
	const root = await tree({ "tracked.txt": "needle\n", "odd:3:name.txt": "a\nb\nneedle\n" });
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	execFileSync("git", ["add", "tracked.txt"], { cwd: root });
	const result = await grepText(root, "needle", true);
	expect(result.error).toBeUndefined();
	const hits = parseGrep(result.out, 50).hits;
	expect(hits.map(h => `${h.path}@${h.line}`).sort()).toEqual(["odd:3:name.txt@3", "tracked.txt@1"]);
	expect(await grepText(root, "absent", true)).toEqual({ out: "", partial: false, timedOut: false }); // no matches is not an error
});

test("a git grep that fails says so instead of reporting no matches", async () => {
	const { execFileSync } = await import("node:child_process");
	const root = await tree({ "a.txt": "needle\n" });
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	// A repository git refuses to use: its HEAD is not a ref.
	await writeFile(join(root, ".git", "HEAD"), "garbage\n");
	const result = await grepText(root, "needle", true);
	expect(result.out).toBe("");
	expect(result.error).toMatch(/not a git repository|HEAD|fatal/i);
});
