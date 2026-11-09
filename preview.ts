import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { getMarkdownTheme } from "@oh-my-pi/pi-coding-agent";
import { highlightCode, supportsLanguage } from "@oh-my-pi/pi-natives";
import { Markdown } from "@oh-my-pi/pi-tui";
import { parseUnifiedDiff } from "./diff.ts";
import { type Entry, formatSize, listDirectory } from "./fsx.ts";
import { type TreeRange, fileDiff } from "./git.ts";
import type { Theme } from "./host.ts";
import { imageSize } from "./image.ts";
import { prettyJson } from "./json.ts";
import type { PreviewLine } from "./lines.ts";

export type { PreviewLine } from "./lines.ts";

/**
 * `file`: the file's content. `diff`: its change against HEAD. `rendered`: Markdown rendered.
 * `agent`: its change between two working-tree snapshots, i.e. what the agent did (see agent.ts).
 */
export type PreviewMode = "file" | "diff" | "rendered" | "agent";

export interface Preview {
	lines: PreviewLine[];
	/** One-line caption: language, size, truncation. */
	note: string;
	/** Which gutter to draw: none, line numbers, or line numbers plus a +/- column. */
	gutter: "none" | "number" | "diff";
	/** Digits needed for the largest line number. */
	numW: number;
	/** Line to open an editor at when the user has not placed a cursor (first change of a diff). */
	jump?: number;
	/** Width-dependent rendering (Markdown). When set, `lines` is empty and the view is read-only. */
	render?: (width: number) => string[];
}

const MAX_BYTES = 256 * 1024;
const MAX_LINES = 3000;
const MAX_DIR_ITEMS = 300;
const BINARY_SNIFF_BYTES = 8000;

/** natives palette key → theme token that supplies its colour */
const PALETTE = {
	comment: "syntaxComment",
	keyword: "syntaxKeyword",
	function: "syntaxFunction",
	variable: "syntaxVariable",
	string: "syntaxString",
	number: "syntaxNumber",
	type: "syntaxType",
	operator: "syntaxOperator",
	punctuation: "syntaxPunctuation",
	inserted: "toolDiffAdded",
	deleted: "toolDiffRemoved",
} as const;

const MARKDOWN_EXT: Record<string, true> = { md: true, markdown: true, mdx: true };
const IMAGE_EXT: Record<string, string> = { png: "PNG", jpg: "JPEG", jpeg: "JPEG", gif: "GIF", webp: "WebP" };

export function isMarkdown(path: string): boolean {
	return MARKDOWN_EXT[extname(path).slice(1).toLowerCase()] === true;
}

function highlight(text: string, lang: string | undefined, theme: Theme): string[] {
	let coloured = text;
	if (lang) {
		const colors = Object.fromEntries(Object.entries(PALETTE).map(([name, token]) => [name, theme.getFgAnsi(token)]));
		try {
			coloured = highlightCode(text, lang, colors);
		} catch {
			coloured = text; // unhighlightable input: show it plain rather than fail
		}
	}
	return coloured.split("\n").map(line => line.replace(/\r$/, "").replaceAll("\t", "  "));
}

function languageFor(path: string): string | undefined {
	// extension first (ts, py, md…), then the file name (Makefile, Dockerfile…)
	return [extname(path).slice(1), basename(path)].map(c => c.toLowerCase()).find(c => c.length > 0 && supportsLanguage(c));
}

/** Preview built from rows; fills in the gutter width from the largest line number. */
function build(lines: PreviewLine[], note: string, gutter: Preview["gutter"], extra: Partial<Preview> = {}): Preview {
	const maxNo = lines.reduce((max, l) => Math.max(max, l.no ?? 0), 0);
	return { lines, note, gutter, numW: Math.max(1, String(maxNo).length), ...extra };
}

function plain(rows: string[], note: string): Preview {
	return build(
		rows.map(text => ({ text })),
		note,
		"none",
	);
}

async function readHead(path: string, size: number): Promise<{ buf: Buffer; truncated: boolean }> {
	const handle = await open(path, "r");
	try {
		const buf = Buffer.alloc(Math.min(size, MAX_BYTES));
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		return { buf: buf.subarray(0, bytesRead), truncated: size > MAX_BYTES };
	} finally {
		await handle.close();
	}
}

async function imagePreview(entry: Entry, format: string): Promise<Preview> {
	const { buf } = await readHead(entry.path, entry.size);
	const size = imageSize(buf);
	const rows = [`${format} image`, size ? `${size.width} × ${size.height} px` : "dimensions unavailable", formatSize(entry.size)];
	return plain(rows, `${format.toLowerCase()} · image`);
}

async function directoryPreview(entry: Entry, theme: Theme): Promise<Preview> {
	const items = (await listDirectory(entry.path, false)).filter(e => e.name !== "..");
	const rows = items.slice(0, MAX_DIR_ITEMS).map(e => (e.isDirectory ? theme.fg("accent", `${e.name}/`) : e.name));
	const more = items.length > MAX_DIR_ITEMS ? ` · first ${MAX_DIR_ITEMS}` : "";
	return plain(rows, items.length === 0 ? "empty directory" : `${items.length} items${more}`);
}

function markdownPreview(text: string, truncated: boolean): Preview {
	return {
		lines: [],
		note: `markdown · rendered (view only)${truncated ? " · truncated" : ""}`,
		gutter: "none",
		numW: 1,
		render: width => new Markdown(text, 0, 0, getMarkdownTheme()).render(Math.max(10, width)),
	};
}

async function fileContent(entry: Entry, mode: PreviewMode, theme: Theme): Promise<Preview> {
	// Opening a named pipe blocks until a writer appears; devices and sockets have no content to show.
	if (!(await stat(entry.path)).isFile()) return plain([], "special file · not previewed");
	const ext = extname(entry.path).slice(1).toLowerCase();
	const imageFormat = IMAGE_EXT[ext];
	if (imageFormat) return await imagePreview(entry, imageFormat);

	const { buf, truncated } = await readHead(entry.path, entry.size);
	if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return plain([], `binary file · ${formatSize(entry.size)}`);
	const text = buf.toString("utf8");
	if (text.length === 0) return plain([], "empty file");
	if (mode === "rendered" && isMarkdown(entry.path)) return markdownPreview(text, truncated);

	const lang = languageFor(entry.path);
	const all = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
	const cut = all.length > MAX_LINES || truncated ? " · truncated" : "";

	const pretty = ext === "json" && !truncated ? prettyJson(text, all.length) : undefined;
	if (pretty !== undefined) return plain(highlight(pretty, "json", theme).slice(0, MAX_LINES), "json · minified, shown indented (view only)");

	const rows = highlight(all.slice(0, MAX_LINES).join("\n"), lang, theme);
	const lines = rows.map((row, i): PreviewLine => ({ text: row, no: i + 1 }));
	return build(lines, `${lang ?? "text"} · ${all.length}${truncated ? "+" : ""} lines${cut}`, "number");
}

/** A diff preview, or undefined when the patch has no hunks. */
function diffPreview(patch: string, label: string, path: string, theme: Theme): Preview | undefined {
	const lang = languageFor(path);
	const parsed = parseUnifiedDiff(patch, code => highlight(code, lang, theme));
	if (!parsed) return undefined;
	return build(parsed.lines.slice(0, MAX_LINES), `${label} · +${parsed.added} -${parsed.removed}`, "diff", { jump: parsed.jump });
}

/** Build the preview for one entry. Never throws: failures become a caption. */
export async function loadPreview(entry: Entry, mode: PreviewMode, theme: Theme, gitRoot: string | null, agent?: TreeRange): Promise<Preview> {
	try {
		if (entry.isDirectory) return await directoryPreview(entry, theme);
		if (mode === "agent" && agent) {
			const patch = (await fileDiff(agent.root, entry.path, agent)).trimEnd();
			const diff = patch ? diffPreview(patch, agent.label, entry.path, theme) : undefined;
			if (diff) return diff;
		}
		if (mode === "diff" && gitRoot) {
			const patch = (await fileDiff(gitRoot, entry.path)).trimEnd();
			const diff = patch ? diffPreview(patch, "diff vs HEAD", entry.path, theme) : undefined;
			if (diff) return diff;
		}
		return await fileContent(entry, mode, theme);
	} catch (err) {
		return plain([], `cannot read: ${err instanceof Error ? err.message : String(err)}`);
	}
}
