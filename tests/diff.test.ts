import { expect, test } from "bun:test";
import { parseUnifiedDiff } from "../diff.ts";

const plain = (code: string) => code.split("\n");

const patch = [
	"diff --git a/f.ts b/f.ts",
	"index 1111111..2222222 100644",
	"--- a/f.ts",
	"+++ b/f.ts",
	"@@ -5,7 +5,8 @@ export function one() {",
	" }",
	" ",
	" export function two() {",
	"-  return 2;",
	"+  const d = 2;",
	"+  return d;",
	" }",
	" ",
	" export function three() {",
	"@@ -15,3 +16,4 @@ export function three() {",
	" export function four() {",
	"   return 4;",
	" }",
	"+// end",
].join("\n");

test("git headers are dropped and numbering follows the new file", () => {
	const parsed = parseUnifiedDiff(patch, plain);
	expect(parsed).toBeDefined();
	const rows = parsed!.lines;
	expect(rows.some(r => r.text.startsWith("diff --git") || r.text.startsWith("index "))).toBe(false);
	expect(rows.map(r => r.no)).toEqual([5, 5, 6, 7, undefined, 8, 9, 10, 11, 12, 16, 16, 17, 18, 19]);
	expect(rows.map(r => r.mark)).toEqual([undefined, " ", " ", " ", "-", "+", "+", " ", " ", " ", undefined, " ", " ", " ", "+"]);
});

test("numbering restarts at each hunk's new-file start, not where the previous hunk ended", () => {
	const rows = parseUnifiedDiff(patch, plain)!.lines;
	const hunks = rows.filter(r => r.kind === "hunk");
	expect(hunks.map(h => h.no)).toEqual([5, 16]);
});

test("counts and the editor jump line", () => {
	const parsed = parseUnifiedDiff(patch, plain)!;
	expect(parsed.added).toBe(3);
	expect(parsed.removed).toBe(1);
	expect(parsed.jump).toBe(8); // first added line, not the hunk's context start
});

test("a deletion-only diff jumps to the hunk start", () => {
	const parsed = parseUnifiedDiff(["@@ -3,3 +3,2 @@", " a", "-b", " c"].join("\n"), plain)!;
	expect(parsed.jump).toBe(3);
	expect(parsed.removed).toBe(1);
	expect(parsed.lines.map(l => l.no)).toEqual([3, 3, undefined, 4]);
});

test("a no-newline marker is not a file line and does not shift numbering", () => {
	const parsed = parseUnifiedDiff(["@@ -1,1 +1,2 @@", " a", "+b", "\\ No newline at end of file", "@@ -9,1 +10,1 @@", " z"].join("\n"), plain)!;
	const info = parsed.lines.find(l => l.kind === "info");
	expect(info?.no).toBeUndefined();
	expect(parsed.lines.filter(l => l.mark).map(l => l.no)).toEqual([1, 2, 10]);
});

test("each hunk body is highlighted as one block with the +/- prefix removed", () => {
	const seen: string[] = [];
	parseUnifiedDiff(["@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n"), code => {
		seen.push(code);
		return code.split("\n");
	});
	expect(seen).toEqual(["keep\nold\nnew"]);
});

test("a patch without hunks (binary file, mode change) is not a diff view", () => {
	expect(parseUnifiedDiff("Binary files a/x.png and b/x.png differ", plain)).toBeUndefined();
	expect(parseUnifiedDiff("", plain)).toBeUndefined();
});

test("a body line starting with @@ (a diff of a patch file) stays in its hunk", () => {
	const parsed = parseUnifiedDiff(["@@ -1,2 +1,3 @@", " context", "+@@ -1 +1 @@ inside the patch", " end", ""].join("\n"), plain)!;
	expect(parsed.lines.filter(l => l.kind === "hunk")).toHaveLength(1);
	expect(parsed.added).toBe(1);
	expect(parsed.lines.map(l => l.no)).toEqual([1, 1, 2, 3]);
});

test("a blank context line whose space was trimmed off the end of the patch still counts", () => {
	const parsed = parseUnifiedDiff(["@@ -1,2 +1,3 @@", "+new", " a", ""].join("\n"), plain)!;
	expect(parsed.lines.map(l => l.mark)).toEqual([undefined, "+", " ", " "]);
});
