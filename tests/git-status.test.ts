import { expect, test } from "bun:test";
import { parseNameStatus, parseStatus } from "../git.ts";

const root = "/r";

test("unstaged, staged and untracked files get one status letter each", () => {
	const { changed } = parseStatus([" M a.ts", "M  b.ts", "A  c.ts", " D d.ts", "?? e.ts", ""].join("\0"), root);
	expect(changed.get("/r/a.ts")).toBe("M");
	expect(changed.get("/r/b.ts")).toBe("M");
	expect(changed.get("/r/c.ts")).toBe("A");
	expect(changed.get("/r/d.ts")).toBe("D");
	expect(changed.get("/r/e.ts")).toBe("?");
});

test("a rename record's extra origin path is consumed, not read as a file", () => {
	const { changed } = parseStatus(["R  new.ts", "old.ts", " M after.ts", ""].join("\0"), root);
	expect([...changed.keys()].sort()).toEqual(["/r/after.ts", "/r/new.ts"]);
	expect(changed.get("/r/new.ts")).toBe("R");
});

test("directories containing changes are marked, up to and including the root", () => {
	const { dirty } = parseStatus([" M src/lib/a.ts", ""].join("\0"), root);
	expect([...dirty].sort()).toEqual(["/r", "/r/src", "/r/src/lib"]);
});

test("paths with spaces survive (NUL-separated output)", () => {
	const { changed } = parseStatus([" M my file.ts", ""].join("\0"), root);
	expect(changed.has("/r/my file.ts")).toBe(true);
});

test("clean repo", () => {
	const { changed, dirty } = parseStatus("", root);
	expect(changed.size).toBe(0);
	expect(dirty.size).toBe(0);
});

test("name-status (-z) keeps the new name of a rename or copy", () => {
	const rows = parseNameStatus(["M", "src/a.ts", "R100", "old.ts", "new.ts", "C075", "x.ts", "y.ts", "A", "b.ts", ""].join("\0"), root);
	expect(rows).toEqual([
		{ status: "M", path: "/r/src/a.ts" },
		{ status: "R", path: "/r/new.ts" },
		{ status: "C", path: "/r/y.ts" },
		{ status: "A", path: "/r/b.ts" },
	]);
});

test("name-status (-z) keeps quotes, backslashes, tabs and newlines in names as they are", () => {
	const names = ['we"ird.txt', "back\\slash.txt", "tab\tname.txt", "new\nline.txt"];
	const rows = parseNameStatus([...names.flatMap(name => ["M", name]), ""].join("\0"), root);
	expect(rows.map(r => r.path)).toEqual(names.map(name => `/r/${name}`));
});

test("name-status (-z) stops at a truncated record instead of inventing a path", () => {
	expect(parseNameStatus(["M", "a.ts", "R100", "old.ts"].join("\0"), root)).toEqual([{ status: "M", path: "/r/a.ts" }]);
});

test("directories containing paths run up to and including the root, and never beyond it", async () => {
	const { dirsContaining } = await import("../git.ts");
	expect([...dirsContaining(["/r/a/b/c.ts", "/r/a/d.ts"], "/r")].sort()).toEqual(["/r", "/r/a", "/r/a/b"]);
	expect([...dirsContaining(["/elsewhere/x.ts"], "/r")]).toEqual([]);
});

test("a repository at the filesystem root still gets its directories marked", async () => {
	const { dirsContaining } = await import("../git.ts");
	expect([...dirsContaining(["/a/b.ts"], "/")].sort()).toEqual(["/", "/a"]);
});
