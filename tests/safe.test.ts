import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGrep } from "../find.ts";
import { changedBetween, diffSince, fileDiff, gitInfo, snapshotTree, takeSnapshot } from "../git.ts";
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

test("a repository's config cannot make the plugin run programs (fsmonitor, textconv)", async () => {
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
	await writeFile(join(root, ".gitattributes"), "*.txt diff=evil\n");
	await writeFile(join(root, "a.txt"), "one\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("config", "core.fsmonitor", script);
	git("config", "diff.evil.textconv", script);
	await rm(marker, { force: true }); // the setup's own git calls may have run it

	await writeFile(join(root, "a.txt"), "two\n");
	await gitInfo(root);
	const from = await snapshotTree(root);
	await writeFile(join(root, "a.txt"), "three\n");
	await changedBetween(root, from, await snapshotTree(root));
	await fileDiff(root, join(root, "a.txt"));
	await diffSince(await takeSnapshot(join(root, "a.txt")));
	await grepText(root, "three", true);
	expect(await exists(marker)).toBe(false);
});
