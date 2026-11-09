import { expect, test } from "bun:test";
import { fuzzyScore, parseGrep, rankFiles } from "../find.ts";

const files = ["src/util/index.ts", "src/utils.ts", "src/app.ts", "src/lib/apple-pie.ts", "README.md", "src/components/UserCard.tsx", "docs/guide.md"];

test("non-matching paths are excluded", () => {
	expect(rankFiles(files, "zzz", 10)).toEqual([]);
	expect(fuzzyScore("xyz", "src/app.ts")).toBeUndefined();
});

test("matching is case-insensitive and in order, not contiguous", () => {
	expect(rankFiles(files, "readme", 10)).toEqual(["README.md"]);
	expect(rankFiles(files, "sapp", 10)[0]).toBe("src/app.ts"); // s…app across the path
	expect(fuzzyScore("tpa", "src/app.ts")).toBeUndefined(); // letters must appear in order
});

test("a match in the file name beats one reached through directory names", () => {
	const ranked = rankFiles(files, "util", 10);
	expect(ranked.indexOf("src/utils.ts")).toBeLessThan(ranked.indexOf("src/util/index.ts"));
});

test("shorter paths win when the match is otherwise equal", () => {
	const ranked = rankFiles(files, "app", 10);
	expect(ranked.slice(0, 2)).toEqual(["src/app.ts", "src/lib/apple-pie.ts"]);
});

test("camelCase word starts count as boundaries", () => {
	expect(rankFiles(files, "uc", 10)[0]).toBe("src/components/UserCard.tsx");
});

test("an empty query keeps the given order and the limit applies", () => {
	expect(rankFiles(files, "  ", 3)).toEqual(files.slice(0, 3));
	expect(rankFiles(files, "s", 2)).toHaveLength(2);
});

test("grep output: path, line number and the whole matching text, even when it contains colons", () => {
	const { hits, capped } = parseGrep(["src/a.ts:12:  const x = { a: 1 };", "b.ts:3:foo()", ""].join("\n"), 10);
	expect(capped).toBe(false);
	expect(hits).toEqual([
		{ path: "src/a.ts", line: 12, text: "const x = { a: 1 };" },
		{ path: "b.ts", line: 3, text: "foo()" },
	]);
});

test("grep results are capped and the cap is reported", () => {
	const out = Array.from({ length: 5 }, (_, i) => `f.ts:${i + 1}:x`).join("\n");
	const { hits, capped } = parseGrep(out, 3);
	expect(hits).toHaveLength(3);
	expect(capped).toBe(true);
});

test("noise lines in grep output are skipped", () => {
	expect(parseGrep("warning: something\nBinary file x matches\n", 10).hits).toEqual([]);
});

test("grep -r prints paths as ./path; the prefix is dropped", () => {
	expect(parseGrep("./src/a.ts:4:x\n", 10).hits[0].path).toBe("src/a.ts");
	expect(parseGrep("a/./b.ts:4:x\n", 10).hits[0].path).toBe("a/./b.ts"); // only a leading ./ is a prefix
});

test("grep output with NUL after the path: both the git grep and the ripgrep/grep shapes", async () => {
	const { parseGrep } = await import("../find.ts");
	const out = ["a:1:b.ts\x001\x00text one", "./c.ts\x0012:text: two", "plain.ts:3:old shape", ""].join("\n");
	expect(parseGrep(out, 10).hits).toEqual([
		{ path: "a:1:b.ts", line: 1, text: "text one" },
		{ path: "c.ts", line: 12, text: "text: two" },
		{ path: "plain.ts", line: 3, text: "old shape" },
	]);
});
