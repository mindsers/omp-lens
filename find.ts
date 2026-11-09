const SEPARATORS = "/_-. ";

/** Does `text[i]` start a word: after a separator, or a lower→UPPER camelCase step? */
function isBoundary(text: string, i: number): boolean {
	if (i === 0) return true;
	const prev = text[i - 1];
	return SEPARATORS.includes(prev) || (prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase());
}

/** Score `query` as a case-insensitive subsequence of `text`: consecutive and word-start matches score higher. Undefined when it does not match. */
function scoreIn(query: string, text: string): number | undefined {
	const lowerText = text.toLowerCase();
	let pos = 0;
	let prev = -2;
	let score = 0;
	for (const ch of query.toLowerCase()) {
		const at = lowerText.indexOf(ch, pos);
		if (at < 0) return undefined;
		score += 1;
		if (at === prev + 1) score += 8;
		else if (prev >= 0) score -= Math.min(5, at - prev - 1);
		if (isBoundary(text, at)) score += 6;
		prev = at;
		pos = at + 1;
	}
	return score;
}

/**
 * Match score of `query` against a repo-relative path, or undefined. A match inside the file name beats one
 * that only reaches it through directory names; shorter paths win ties.
 */
export function fuzzyScore(query: string, path: string): number | undefined {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const inBase = scoreIn(query, base);
	if (inBase !== undefined) return 100 + inBase - base.length * 0.05 - path.length * 0.01;
	const inPath = scoreIn(query, path);
	return inPath === undefined ? undefined : inPath - path.length * 0.05;
}

/** The best `limit` paths for `query`, best first. An empty query keeps the given order. */
export function rankFiles(files: readonly string[], query: string, limit: number): string[] {
	if (query.trim() === "") return files.slice(0, limit);
	const scored: { path: string; score: number }[] = [];
	for (const path of files) {
		const score = fuzzyScore(query.trim(), path);
		if (score !== undefined) scored.push({ path, score });
	}
	scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return scored.slice(0, limit).map(s => s.path);
}

export interface GrepHit {
	/** Repo-relative path. */
	path: string;
	line: number;
	/** The matching line, trimmed. */
	text: string;
}

const MAX_HIT_TEXT = 200;

/**
 * Parse grep output. The backends run with `--null`, which ends the path with a NUL: `path\0line\0text` from
 * git grep, `path\0line:text` from ripgrep and grep. That keeps a path containing `:12:` intact. Plain
 * `path:line:text` rows are still accepted. Rows that fit neither shape are skipped; `capped` says the limit
 * cut results off.
 */
export function parseGrep(out: string, limit: number): { hits: GrepHit[]; capped: boolean } {
	const hits: GrepHit[] = [];
	for (const row of out.split("\n")) {
		const nul = row.indexOf("\0");
		const m = nul >= 0 ? /^()(\d+)[\0:](.*)$/s.exec(row.slice(nul + 1)) : /^(.+?):(\d+):(.*)$/.exec(row);
		if (!m) continue;
		if (hits.length >= limit) return { hits, capped: true };
		const path = nul >= 0 ? row.slice(0, nul) : m[1];
		hits.push({ path: path.replace(/^\.\//, ""), line: Number(m[2]), text: m[3].trim().slice(0, MAX_HIT_TEXT) }); // grep -r prints "./path"
	}
	return { hits, capped: false };
}
