import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGrep } from "../find.ts";
import { changedBetween, diffSince, fileDiff, filterOverrides, gitInfo, snapshotTree, takeSnapshot } from "../git.ts";
import { safeText } from "../safe.ts";
import { grepText } from "../search.ts";

const made: string[] = [];
afterAll(async () => {
	for (const dir of made) await rm(dir, { recursive: true, force: true });
});

test("escape sequences and other controls become visible, tabs and newlines stay", () => {
	expect(safeText("a\x1b]52;c;ZXZpbA==\x07b")).toBe("a␛]52;c;ZXZpbA==␇b");
	expect(safeText("\x1b[2J")).toBe("␛[2J");
	expect(safeText("x\x9b31my")).toBe("x�31my"); // a C1 CSI
	expect(safeText("del\x7f")).toBe("del␡");
	expect(safeText("keep\tthis\nline")).toBe("keep\tthis\nline");
	expect(safeText("crlf\r\nline\r")).toBe("crlf\nline␍");
	expect(safeText("héllo ✓")).toBe("héllo ✓");
});

test("grep hit text is made safe", () => {
	expect(parseGrep("a.ts\x001:evil \x1b[31mred", 10).hits[0].text).toBe("evil ␛[31mred");
});

const exists = (path: string) => stat(path).then(() => true, () => false);

test("a repository's config cannot make the plugin run programs (fsmonitor, textconv, clean and process filters)", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "lens-hostile-")));
	made.push(root);
	const marker = join(root, "PWNED");
	const script = join(root, "evil.sh");
	await writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat "$1" 2>/dev/null\n`);
	await chmod(script, 0o755);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init", "-q", ".");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	await writeFile(join(root, ".gitignore"), "evil.sh\nPWNED\n");
	await writeFile(join(root, ".gitattributes"), "*.txt diff=evil filter=evil\n*.md filter=evil.proc\n");
	await writeFile(join(root, "a.txt"), "one\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("config", "core.fsmonitor", script);
	git("config", "diff.evil.textconv", script);
	git("config", "filter.evil.clean", script);
	git("config", "filter.evil.required", "true");
	git("config", "filter.evil.proc.process", script); // a driver name with a dot
	await rm(marker, { force: true }); // the setup's own git calls may have run it

	await writeFile(join(root, "a.txt"), "two\n");
	await gitInfo(root);
	const from = await snapshotTree(root);
	await writeFile(join(root, "a.txt"), "three\n");
	await writeFile(join(root, "new.md"), "untracked, bound to the process filter\n");
	await changedBetween(root, from, await snapshotTree(root));
	await fileDiff(root, join(root, "a.txt"));
	await diffSince(await takeSnapshot(join(root, "a.txt")));
	await grepText(root, "three", true);
	expect(await exists(marker)).toBe(false);
});

test("filter overrides cover every configured driver, dotted names included", () => {
	const out = ["filter.lfs.clean git-lfs clean -- %f", "filter.lfs.required true", "filter.a.b.process /x", ""].join("\n");
	expect(filterOverrides(out)).toEqual([
		..."clean smudge process".split(" ").flatMap(k => ["-c", `filter.lfs.${k}=`]),
		"-c",
		"filter.lfs.required=false",
		..."clean smudge process".split(" ").flatMap(k => ["-c", `filter.a.b.${k}=`]),
		"-c",
		"filter.a.b.required=false",
	]);
	expect(filterOverrides("")).toEqual([]);
});

test("a filter defined only in a submodule's own config is not run either", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "lens-submodule-")));
	made.push(base);
	const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const marker = join(base, "PWNED");
	const script = join(base, "evil.sh");
	await writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
	await chmod(script, 0o755);

	const lib = join(base, "lib");
	execFileSync("mkdir", [lib]);
	git(lib, "init", "-q", ".");
	await writeFile(join(lib, ".gitattributes"), "*.txt filter=subevil\n");
	await writeFile(join(lib, "a.txt"), "x\n");
	git(lib, "add", "-A");
	git(lib, "commit", "-qm", "lib");

	const root = join(base, "super");
	execFileSync("mkdir", [root]);
	git(root, "init", "-q", ".");
	await writeFile(join(root, "s.txt"), "y\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "super");
	git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "sub");
	git(root, "commit", "-qm", "add sub");
	git(join(root, "sub"), "config", "filter.subevil.clean", script);
	await Bun.sleep(1100); // a same-size edit with a newer mtime makes git re-hash the file, through the filter
	await writeFile(join(root, "sub", "a.txt"), "q\n");

	await gitInfo(root);
	await fileDiff(root, join(root, "sub"));
	const from = await snapshotTree(root);
	await changedBetween(root, from, await snapshotTree(root));
	expect(await exists(marker)).toBe(false);
	git(root, "status", "--porcelain"); // plain git does run it: the test would notice if the setup stopped triggering it
	expect(await exists(marker)).toBe(true);
});

test("fails closed: when the repository's config cannot be read, no git command runs there", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "lens-badconfig-")));
	made.push(root);
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	await writeFile(join(root, ".git", "config"), "[core\nthis is not config\n");
	await expect(gitInfo(root)).rejects.toThrow();
	await expect(snapshotTree(root)).rejects.toThrow();
});
