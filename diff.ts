import type { PreviewLine } from "./lines.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ParsedDiff {
	lines: PreviewLine[];
	/** Line to open an editor at: the first added line, else the first hunk's start. */
	jump?: number;
	added: number;
	removed: number;
}

/**
 * Turn a unified diff into preview rows: no git headers, one header row per hunk, and the real
 * new-file line number on every context and added row. Removed rows carry no number.
 *
 * `highlight` colours a block of code and returns one string per input line; each hunk body is
 * highlighted as one block so multi-line constructs keep their colour.
 * Returns undefined when the patch has no hunks (binary files, mode changes).
 */
export function parseUnifiedDiff(patch: string, highlight: (code: string) => string[]): ParsedDiff | undefined {
	const rows = patch.split("\n");
	let i = rows.findIndex(r => HUNK_HEADER.test(r));
	if (i < 0) return undefined;
	const lines: PreviewLine[] = [];
	let jump: number | undefined;
	let firstHunk: number | undefined;
	let added = 0;
	let removed = 0;
	while (i < rows.length) {
		const header = HUNK_HEADER.exec(rows[i]);
		if (!header) {
			i++;
			continue;
		}
		let newNo = Number(header[3]);
		firstHunk ??= newNo;
		lines.push({ text: rows[i], no: newNo, kind: "hunk" });
		// The header says how many old and new lines the body holds. Count them rather than reading up to the
		// next "@@", which can start a body line (a diff of a .patch file).
		let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
		let newLeft = header[4] === undefined ? 1 : Number(header[4]);
		const body: string[] = [];
		for (i++; i < rows.length; i++) {
			const row = rows[i];
			if (row.startsWith("\\")) body.push(row); // "\ No newline at end of file" follows the line it is about
			else if (oldLeft <= 0 && newLeft <= 0) break;
			else if (row.startsWith("+")) {
				newLeft--;
				body.push(row);
			} else if (row.startsWith("-")) {
				oldLeft--;
				body.push(row);
			} else if (row.startsWith(" ") || row === "") {
				// a context line; "" is a blank one whose space was trimmed (the preview trims the patch's end)
				oldLeft--;
				newLeft--;
				body.push(row);
			} else break; // malformed: stop this hunk
		}
		const code = highlight(body.map(r => (r.startsWith("\\") ? "" : r.slice(1))).join("\n"));
		body.forEach((row, idx) => {
			const text = code[idx] ?? "";
			if (row.startsWith("\\")) lines.push({ text: row, kind: "info" });
			else if (row.startsWith("+")) {
				jump ??= newNo;
				added++;
				lines.push({ text, no: newNo++, mark: "+" });
			} else if (row.startsWith("-")) {
				removed++;
				lines.push({ text, mark: "-" });
			} else lines.push({ text, no: newNo++, mark: " " });
		});
	}
	return { lines, jump: jump ?? firstHunk, added, removed };
}
