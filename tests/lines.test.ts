import { expect, test } from "bun:test";
import { lineRange, nearestLineNo, type PreviewLine } from "../lines.ts";

// A diff view: hunk header (no=5 is the hunk start), a context row, a removed row, two added rows.
const diffRows: PreviewLine[] = [
	{ text: "@@", no: 5, kind: "hunk" },
	{ text: "ctx", no: 5, mark: " " },
	{ text: "gone", mark: "-" },
	{ text: "new a", no: 6, mark: "+" },
	{ text: "new b", no: 7, mark: "+" },
];

test("a range never starts or ends at a hunk header or removed row", () => {
	expect(lineRange(diffRows, 0, 4)).toEqual({ from: 5, to: 7 });
	expect(lineRange(diffRows, 2, 3)).toEqual({ from: 6, to: 6 });
});

test("a range is the same whichever end the cursor is on", () => {
	expect(lineRange(diffRows, 4, 1)).toEqual(lineRange(diffRows, 1, 4));
});

test("a selection of only non-file rows has no range", () => {
	expect(lineRange(diffRows, 0, 0)).toBeUndefined();
	expect(lineRange(diffRows, 2, 2)).toBeUndefined();
});

test("a range with min/max handles out-of-order line numbers", () => {
	const rows: PreviewLine[] = [{ text: "a", no: 30 }, { text: "b", no: 4 }];
	expect(lineRange(rows, 0, 1)).toEqual({ from: 4, to: 30 });
});

test("nearest line prefers the row itself, then forward, then backward", () => {
	expect(nearestLineNo(diffRows, 1)).toBe(5);
	expect(nearestLineNo(diffRows, 2)).toBe(6); // removed row → next added line
	expect(nearestLineNo(diffRows, 0)).toBe(5); // hunk header is skipped
	expect(nearestLineNo(diffRows.slice(0, 3), 2)).toBe(5); // nothing after → look back
});

test("nearest line is undefined when no row is a file line", () => {
	expect(nearestLineNo([{ text: "x" }, { text: "y", mark: "-" }], 0)).toBeUndefined();
	expect(nearestLineNo([], 0)).toBeUndefined();
});
