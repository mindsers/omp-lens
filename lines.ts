/** One row of preview content. */
export interface PreviewLine {
	/** Highlighted text (ANSI), tabs expanded. */
	text: string;
	/**
	 * The file line this row is. Absent for rows that are not a single line of the file (hunk headers,
	 * removed lines, pretty-printed or rendered views) so a line reference can never point at the wrong line.
	 */
	no?: number;
	/** Diff marker column. */
	mark?: "+" | "-" | " ";
	/** Non-code row: hunk header or a "\ No newline" note. */
	kind?: "hunk" | "info";
}

/** The file line a row stands for. Hunk headers carry the hunk's start for display but are not file lines. */
function fileLineNo(line: PreviewLine | undefined): number | undefined {
	return line && line.kind !== "hunk" ? line.no : undefined;
}

/** The file line at row `index`, else the nearest one: forward first, then backward. */
export function nearestLineNo(lines: readonly PreviewLine[], index: number): number | undefined {
	for (let i = Math.max(0, index); i < lines.length; i++) {
		const no = fileLineNo(lines[i]);
		if (no !== undefined) return no;
	}
	for (let i = Math.min(index, lines.length) - 1; i >= 0; i--) {
		const no = fileLineNo(lines[i]);
		if (no !== undefined) return no;
	}
	return undefined;
}

/** The inclusive file-line range covered by rows `a`..`b` (either order). Rows that are not file lines are skipped. */
export function lineRange(lines: readonly PreviewLine[], a: number, b: number): { from: number; to: number } | undefined {
	let from: number | undefined;
	let to: number | undefined;
	for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
		const no = fileLineNo(lines[i]);
		if (no === undefined) continue;
		from = Math.min(from ?? no, no);
		to = Math.max(to ?? no, no);
	}
	return from === undefined || to === undefined ? undefined : { from, to };
}
