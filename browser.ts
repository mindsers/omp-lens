import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { warmHighlighter } from "@oh-my-pi/pi-natives";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { AgentChanges, AgentScope } from "./agent.ts";
import { parseGrep, rankFiles } from "./find.ts";
import { type Entry, formatSize, listDirectory } from "./fsx.ts";
import { type GitInfo, type TreeRange, gitInfo, listFiles, repoRoot } from "./git.ts";
import type { Component, Theme, Tui } from "./host.ts";
import { lineRange, nearestLineNo } from "./lines.ts";
import { type Preview, type PreviewMode, isMarkdown, loadPreview } from "./preview.ts";
import type { FileRef } from "./refs.ts";
import { grepText, walkFiles } from "./search.ts";

/** Which version of a file the preview shows. */
export type PreviewView = "file" | "diff" | "agent";

/** State that survives closing and reopening the overlay (e.g. around an edit). */
export interface BrowserState {
	path: string;
	showHidden: boolean;
	changedOnly: boolean;
	/** Show the preview pane (when the terminal has room for it). */
	preview: boolean;
	/** Which version of a file the preview shows: its content, its change against HEAD, or what the agent changed. */
	view: PreviewView;
	/** Restrict the list to the files the agent changed in its last turn, or since the session began. */
	agentScope: "off" | "last" | "session";
	/** Preview Markdown files rendered instead of as source. */
	previewRendered: boolean;
	/** Wrap long preview lines instead of cutting them off. */
	wrap: boolean;
	selectedName?: string;
	marks: Set<string>;
	/** An active find. Kept here so it survives an edit; its results are refreshed when the browser reopens. */
	finder?: Finder;
}

export type BrowserResult =
	| { action: "cancel" }
	| { action: "insert"; refs: FileRef[] }
	| { action: "edit"; filePath: string; line?: number };

/** Narrowest inner width (columns) at which the list and preview fit side by side. */
const SPLIT_MIN = 90;
/**
 * Narrower than that, the preview goes below the list when the terminal is tall enough.
 * STACK_CHROME: rows that are not list or preview: overlay margins (4), borders, dividers, status line
 * and up to three hint rows (9).
 */
const STACK_CHROME = 13;
/** Rows left over for a usable stack: at least 5 list rows plus the preview caption and 6 preview rows. */
const STACK_MIN_BODY = 12;
/** Most results a repo-wide find shows. */
const MAX_FIND_RESULTS = 300;
const PREVIEW_CACHE_MAX = 40;
/** How long git status stays fresh: the agent may be changing files while the browser is open. */
const GIT_TTL_MS = 2_000;
const NO_ROOM = "terminal too small for a preview";
const PREVIEW_OFF = "the preview is off (press v)";

/** `side`: list beside preview. `stack`: preview below the list. `none`: no room for a preview. */
type Layout = "side" | "stack" | "none";

/** git status codes that have a diff against HEAD ("?" untracked has none). */
const DIFFABLE: Record<string, true> = { M: true, A: true, D: true, R: true };

const key = (data: string, id: string): boolean => data === id || matchesKey(data, id);

function isPrintable(data: string): boolean {
	const cp = data.codePointAt(0);
	return cp !== undefined && cp >= 0x20 && cp !== 0x7f && [...data].length === 1;
}

/** An active repo-wide search: file names (`files`) or file contents (`text`). Its results replace the directory listing. */
export interface Finder {
	kind: "files" | "text";
	query: string;
	/** True while the query is being typed; the results are browsed otherwise. */
	typing: boolean;
	results: Entry[];
	/** Result count, or progress. */
	note: string;
	/** The selected result's name, to select again when the results are refreshed. */
	selected?: string;
	/** The directory entry selected before find started, to return to when it ends. */
	returnTo?: string;
}

/**
 * A new find. A file find ranks as the query is typed, so it starts in typing mode; a text search with a query
 * runs it straight away.
 */
export function newFinder(kind: Finder["kind"], query = "", returnTo?: string): Finder {
	const note = kind === "files" ? "indexing…" : query === "" ? "type a query, Enter searches" : "searching…";
	return { kind, query, typing: kind === "files" || query === "", results: [], note, returnTo };
}

/** One entry in the hint bar. `off` holds the reason when the action is currently unavailable. */
interface Action {
	keys: string;
	label: string;
	off?: string;
}

/** One drawn preview row. `line` indexes `Preview.lines` (-1 for rendered views); `first` is false on wrapped continuations. */
interface DisplayRow {
	line: number;
	text: string;
	first: boolean;
}

export class FileBrowser implements Component {
	private all: Entry[] = [];
	private view: Entry[] = [];
	private sel = 0;
	private top = 0;
	private query = "";
	private searching = false;
	private loading = true;
	private flash = "";
	private git: GitInfo | null = null;
	private seq = 0;
	private readonly gitByRoot = new Map<string, { info: GitInfo; at: number }>();

	// Repo-wide find: `f` for file names, `s` for text. The finder itself lives in `state`.
	private get finder(): Finder | undefined {
		return this.state.finder;
	}
	private set finder(finder: Finder | undefined) {
		this.state.finder = finder;
	}
	/** File lists by search root (a repo root, or a folder outside any repo), kept for the life of the overlay. */
	private readonly repoFiles = new Map<string, string[]>();
	/** Search roots whose file list hit the size limit. */
	private readonly partialRoots = new Set<string>();
	private finderSeq = 0;
	/** Preview row of the text-search hit being shown, and a one-shot request to scroll it into view. */
	private pvHit: number | undefined;
	private pvReveal: number | undefined;

	// Preview pane
	private pv: Preview | undefined;
	private pvKey = "";
	private pvSeq = 0;
	private readonly pvCache = new Map<string, Preview>();
	/** Keyboard focus: the file list, or the preview's line cursor. */
	private focus: "list" | "preview" = "list";
	/** First visible display row. */
	private pvScroll = 0;
	/** Line cursor (index into `pv.lines`) and the other end of a range selection, when one is open. */
	private pvCursor = 0;
	private pvAnchor: number | undefined;
	/** Rows available to preview content on the last render (for page-sized moves). */
	private pvBody = 10;
	// Display rows depend on the preview, its width and the wrap setting; rebuilt only when one changes.
	private dispRows: DisplayRow[] = [];
	private dispFor: Preview | undefined;
	private dispW = 0;
	private dispWrap = false;

	/** Where a preview fits at the current terminal size (set on every render), whether or not the user turned it on. */
	private fit: Layout = "none";
	/** Rows the list shows; the stacked layout trades some of them for preview height. Set on every render. */
	private listRows = 10;

	constructor(
		private readonly state: BrowserState,
		private readonly tui: Tui,
		private readonly theme: Theme,
		private readonly done: (result: BrowserResult) => void,
		private readonly isIdle: () => boolean,
		private readonly agent: AgentChanges,
	) {
		void warmHighlighter(); // build grammars off the render path so the first preview is not slow
		void this.load(state.path, state.selectedName).then(() => this.resumeFinder());
	}

	invalidate(): void {}

	// ── Loading ───────────────────────────────────────────────────────────

	private async gitFor(dir: string): Promise<GitInfo | null> {
		const root = await repoRoot(dir);
		if (!root) return null;
		const cached = this.gitByRoot.get(root);
		if (cached && Date.now() - cached.at < GIT_TTL_MS) return cached.info;
		try {
			const info = await gitInfo(root);
			this.gitByRoot.set(root, { info, at: Date.now() });
			return info;
		} catch {
			return cached?.info ?? null;
		}
	}

	private async load(dir: string, selectName?: string): Promise<void> {
		const seq = ++this.seq; // a newer navigation supersedes this one
		this.loading = true;
		this.tui.requestRender();
		try {
			const [entries, git] = await Promise.all([listDirectory(dir, this.state.showHidden), this.gitFor(dir)]);
			if (seq !== this.seq) return;
			this.all = entries;
			this.git = git;
			this.state.path = dir;
			this.flash = "";
			this.query = "";
			this.searching = false;
			this.focus = "list";
		} catch (err) {
			if (seq !== this.seq) return;
			this.flash = `cannot read ${basename(dir)}: ${err instanceof Error ? err.message : String(err)}`;
		}
		this.loading = false;
		this.applyView(selectName);
		this.tui.requestRender();
	}

	private applyView(selectName?: string): void {
		if (this.finder) {
			// find results replace the directory listing; filters and the agent scope do not apply to them
			this.view = this.finder.results;
			const found = selectName ? this.view.findIndex(e => e.name === selectName) : -1;
			this.select(Math.max(0, found));
			return;
		}
		const q = this.query.toLowerCase();
		let list = this.all;
		if (this.state.changedOnly && this.git) {
			const git = this.git;
			list = list.filter(e => e.name === ".." || git.changed.has(e.path) || git.dirty.has(e.path));
		}
		const scope = this.scope();
		if (scope) list = list.filter(e => e.name === ".." || scope.files.has(e.path) || scope.dirs.has(e.path));
		if (q) {
			list = list
				.filter(e => e.name !== ".." && e.name.toLowerCase().includes(q))
				.sort((a, b) => {
					if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
					const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
					const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
					return ap - bp || a.name.localeCompare(b.name);
				});
		}
		this.view = list;
		const idx = selectName ? list.findIndex(e => e.name === selectName) : -1;
		// Without a remembered selection, start on the first real entry rather than ".." (whose preview is the parent directory).
		this.select(idx >= 0 ? idx : list[0]?.name === ".." && list.length > 1 ? 1 : 0);
	}

	// ── Selection ─────────────────────────────────────────────────────────

	/** Keep the selection inside the visible window of the list. */
	private clampTop(): void {
		const rows = this.listRows;
		if (this.sel < this.top) this.top = this.sel;
		else if (this.sel >= this.top + rows) this.top = this.sel - rows + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.view.length - rows)));
	}

	private select(index: number): void {
		this.sel = Math.max(0, Math.min(index, this.view.length - 1));
		this.clampTop();
		const name = this.view[this.sel]?.name;
		if (this.finder) this.finder.selected = name; // find results are not directory entries
		else this.state.selectedName = name;
		this.refreshPreview();
	}

	private current(): Entry | undefined {
		return this.view[this.sel];
	}

	// ── Preview ───────────────────────────────────────────────────────────

	/** The agent's changes over the active scope. */
	private scope(): AgentScope | undefined {
		return this.state.agentScope === "last" ? this.agent.last : this.state.agentScope === "session" ? this.agent.session : undefined;
	}

	/** The snapshot range in which the agent changed `entry`: the active scope's, or else its last turn's, or else the session's. */
	private agentRangeFor(entry: Entry): TreeRange | undefined {
		if (entry.isDirectory) return undefined;
		const scope = this.scope();
		const candidates = scope ? [scope] : [this.agent.last, this.agent.session];
		return candidates.find(s => s?.files.has(entry.path))?.range;
	}

	private modeFor(entry: Entry): PreviewMode {
		if (entry.isDirectory) return "file";
		if (this.state.view === "agent" && this.agentRangeFor(entry)) return "agent";
		if (this.state.view === "diff" && DIFFABLE[this.git?.changed.get(entry.path) ?? ""] === true) return "diff";
		return this.state.previewRendered && isMarkdown(entry.path) ? "rendered" : "file";
	}

	/** Text-search hits: mark the matching line in the preview and scroll it into view. */
	private revealHit(entry: Entry, pv: Preview): void {
		const hit = entry.hit;
		const idx = hit ? pv.lines.findIndex(l => l.no === hit.line && l.kind !== "hunk") : -1;
		this.pvHit = idx >= 0 ? idx : undefined;
		if (idx >= 0) {
			this.pvCursor = idx;
			this.pvReveal = idx;
		}
	}

	/** Load the preview for the current selection unless it is already shown or loading. */
	private refreshPreview(): void {
		const entry = this.current();
		if (!entry || !this.state.preview) {
			this.pv = undefined;
			this.pvKey = "";
			return;
		}
		if (entry.size < 0) {
			// a find result: its size is not known until it is stat'ed
			this.pv = undefined;
			this.pvKey = "";
			void stat(entry.path).then(
				info => {
					entry.size = info.size;
					entry.mtimeMs = info.mtimeMs;
					this.refreshPreview();
					this.tui.requestRender();
				},
				() => {
					entry.size = 0; // vanished: the preview will say so
					this.refreshPreview();
					this.tui.requestRender();
				},
			);
			return;
		}
		const mode = this.modeFor(entry);
		const range = mode === "agent" ? this.agentRangeFor(entry) : undefined;
		const cacheKey = `${mode}:${range ? `${range.from}..${range.to}` : ""}:${entry.path}:${entry.size}:${entry.mtimeMs}`;
		if (cacheKey === this.pvKey) return;
		this.pvKey = cacheKey;
		this.pvScroll = 0;
		this.pvCursor = 0;
		this.pvAnchor = undefined;
		this.pvHit = undefined;
		const hit = this.pvCache.get(cacheKey);
		if (hit) {
			this.pv = hit;
			this.revealHit(entry, hit);
			this.checkFresh(entry);
			return;
		}
		this.pv = undefined; // renders as "loading…" until the read finishes
		const seq = ++this.pvSeq;
		void loadPreview(entry, mode, this.theme, this.git?.root ?? null, range).then(preview => {
			this.pvCache.set(cacheKey, preview);
			if (this.pvCache.size > PREVIEW_CACHE_MAX) this.pvCache.delete(this.pvCache.keys().next().value as string);
			if (seq !== this.pvSeq) return; // the selection moved on
			this.pv = preview;
			this.revealHit(entry, preview);
			this.tui.requestRender();
		});
	}

	/** A cached preview is only as new as the directory listing; re-stat and reload when the file changed since. */
	private checkFresh(entry: Entry): void {
		void stat(entry.path).then(
			info => {
				if (info.mtimeMs === entry.mtimeMs && info.size === entry.size) return;
				entry.mtimeMs = info.mtimeMs;
				entry.size = info.size;
				this.pvKey = "";
				this.refreshPreview();
				this.tui.requestRender();
			},
			() => undefined, // file vanished; the next directory load will drop it
		);
	}

	/** Why the preview pane cannot be used right now, if it cannot. */
	private previewOff(): string | undefined {
		if (this.fit === "none") return NO_ROOM;
		return this.state.preview ? undefined : PREVIEW_OFF;
	}

	/** Why the line cursor cannot be used right now, if it cannot. */
	private focusOff(): string | undefined {
		const off = this.previewOff();
		if (off) return off;
		if (!this.pv) return "the preview is still loading";
		if (this.pv.render) return "a rendered view has no line numbers (press m for the source)";
		if (this.pv.lines.length === 0) return "nothing to select here";
		return undefined;
	}

	/** Scroll the preview from the list when `data` is a scroll key. `letters` also accepts J/K (not while typing a filter). */
	private scrollKey(data: string, letters: boolean): boolean {
		const down = key(data, "pageDown") || key(data, "ctrl+d") || (letters && data === "J");
		const up = key(data, "pageUp") || key(data, "ctrl+u") || (letters && data === "K");
		if (!down && !up) return false;
		const off = this.previewOff();
		if (off) this.flash = off;
		else this.pvScroll = Math.max(0, this.pvScroll + (down ? 1 : -1) * Math.max(1, this.pvBody >> 1));
		return true;
	}

	// ── Lines ─────────────────────────────────────────────────────────────

	/** The file line at or nearest to preview row `index`. */
	private nearestNo(index: number): number | undefined {
		return nearestLineNo(this.pv?.lines ?? [], index);
	}

	/** The file lines covered by the cursor, or by the open range selection. Rows without a file line are skipped. */
	private selection(): { from: number; to: number } | undefined {
		return lineRange(this.pv?.lines ?? [], this.pvAnchor ?? this.pvCursor, this.pvCursor);
	}

	/** Where `e` should open the editor: the cursor line, else the first change of a diff, else the top visible line. */
	private editLine(): number | undefined {
		const hit = this.current()?.hit;
		if (hit && this.focus === "list") return hit.line;
		const pv = this.pv;
		if (!pv || pv.render) return undefined;
		if (this.focus === "preview") return this.nearestNo(this.pvCursor);
		if (this.pvScroll === 0 && pv.jump !== undefined) return pv.jump;
		const row = this.dispFor === pv ? this.dispRows[this.pvScroll] : undefined;
		return row ? this.nearestNo(row.line) : undefined;
	}

	private moveCursor(delta: number): void {
		const last = Math.max(0, (this.pv?.lines.length ?? 1) - 1);
		this.pvCursor = Math.max(0, Math.min(last, this.pvCursor + delta));
	}

	private enterPreview(): void {
		this.focus = "preview";
		this.pvAnchor = undefined;
		const row = this.dispFor === this.pv ? this.dispRows[this.pvScroll] : undefined;
		this.pvCursor = this.pvHit ?? (row && row.line >= 0 ? row.line : 0); // start on the search hit, else where the user was looking
	}

	// ── Actions ───────────────────────────────────────────────────────────

	private goUp(): void {
		const parent = dirname(this.state.path);
		if (parent !== this.state.path) void this.load(parent, basename(this.state.path));
	}

	private openDirectory(entry: Entry): void {
		if (entry.name === "..") this.goUp();
		else void this.load(entry.path);
	}

	/** Enter: open a folder, or open a file in the preview. */
	private open(): void {
		const entry = this.current();
		if (!entry) return;
		if (entry.isDirectory) return this.openDirectory(entry);
		this.guarded("Enter", () => {
			this.searching = false; // keep the filter, leave typing mode
			this.enterPreview();
		});
	}

	/** `i`: put the marked files, or the selected file, in the prompt. */
	private insertFiles(): void {
		const entry = this.current();
		const hit = entry?.hit;
		if (this.state.marks.size === 0 && entry && hit) return this.done({ action: "insert", refs: [{ path: entry.path, from: hit.line }] });
		const paths = this.state.marks.size > 0 ? [...this.state.marks] : entry && !entry.isDirectory ? [entry.path] : [];
		if (paths.length > 0) this.done({ action: "insert", refs: paths.map(path => ({ path })) });
	}

	private toggleMark(): void {
		const entry = this.current();
		if (!entry || entry.isDirectory) return;
		if (!this.state.marks.delete(entry.path)) this.state.marks.add(entry.path);
		this.select(this.sel + 1);
	}

	private toggleChangedOnly(): void {
		this.state.changedOnly = !this.state.changedOnly;
		this.applyView(this.state.selectedName);
	}

	/** The next scope in the order off → last turn → session → off, skipping scopes with nothing to show. */
	private nextScope(): "off" | "last" | "session" {
		const order = ["off", "last", "session"] as const;
		for (let step = 1; step <= order.length; step++) {
			const next = order[(order.indexOf(this.state.agentScope) + step) % order.length];
			if (next === "off" || (next === "last" && this.agent.last) || (next === "session" && this.agent.session)) return next;
		}
		return "off";
	}

	private cycleAgentScope(): void {
		this.state.agentScope = this.nextScope();
		// entering a scope shows the agent's diff by default; leaving it drops back to the file
		if (this.state.agentScope !== "off") this.state.view = "agent";
		else if (this.state.view === "agent") this.state.view = "file";
		this.applyView(this.state.selectedName);
	}

	/** "•" next to files and directories the agent changed. */
	private agentMark(entry: Entry): string {
		const { last, session } = this.agent;
		const touched = [last, session].some(s => s && (s.files.has(entry.path) || s.dirs.has(entry.path)));
		return touched && entry.name !== ".." ? "•" : " ";
	}

	/** The views a file offers, in the order `d` steps through them. */
	private viewsFor(file: Entry): PreviewView[] {
		const views: PreviewView[] = ["file"];
		if (DIFFABLE[this.git?.changed.get(file.path) ?? ""] === true) views.push("diff");
		if (this.agentRangeFor(file)) views.push("agent");
		return views;
	}

	private nextView(file: Entry): PreviewView {
		const views = this.viewsFor(file);
		const mode = this.modeFor(file);
		return views[(views.indexOf(mode === "rendered" ? "file" : mode) + 1) % views.length];
	}

	// ── Find ──────────────────────────────────────────────────────────────

	/** Where a find looks, when that is not the whole repository. */
	private scopeNote(root: string): string {
		if (this.git) return "";
		return this.partialRoots.has(root) ? " · this folder (partial)" : " · this folder";
	}

	/** Start finding file names (`files`) or text (`text`): across the repository, or the current folder outside one. */
	private startFinder(kind: Finder["kind"]): void {
		if (this.finder?.kind === kind) {
			this.finder.typing = true; // edit the same query again
			return;
		}
		this.finder = newFinder(kind, "", this.finder?.returnTo ?? this.state.selectedName);
		this.focus = "list";
		this.applyView();
		if (kind === "files") void this.refreshFileResults();
	}

	private exitFinder(): void {
		const returnTo = this.finder?.returnTo;
		this.finder = undefined;
		this.applyView(returnTo);
	}

	/** On (re)opening with a find in `state`: fetch fresh results, keeping the selected one. */
	private resumeFinder(): void {
		const finder = this.finder;
		if (!finder) return;
		if (finder.kind === "files") void this.refreshFileResults(finder.selected);
		else if (finder.query !== "" && !finder.typing) void this.runTextSearch(finder.selected);
	}

	/** Rank the repository's files against the query as it is typed. `select` names the result to select. */
	private async refreshFileResults(select?: string): Promise<void> {
		const finder = this.finder;
		const root = this.git?.root ?? this.state.path;
		if (!finder || finder.kind !== "files") return;
		const seq = ++this.finderSeq;
		let files = this.repoFiles.get(root);
		if (!files) {
			if (this.git) files = await listFiles(root).catch(() => []);
			else {
				const walked = await walkFiles(root);
				files = walked.files;
				if (walked.partial) this.partialRoots.add(root);
			}
			this.repoFiles.set(root, files);
		}
		if (seq !== this.finderSeq || this.finder !== finder) return; // typed on, or left find
		const changed = this.git?.changed;
		const ranked = rankFiles(files, finder.query, MAX_FIND_RESULTS + 1).filter(rel => changed?.get(join(root, rel)) !== "D");
		finder.results = ranked.slice(0, MAX_FIND_RESULTS).map(rel => ({ name: rel, path: join(root, rel), isDirectory: false, size: -1, mtimeMs: 0 }));
		finder.note = `${finder.results.length}${ranked.length > MAX_FIND_RESULTS ? "+" : ""} files${this.scopeNote(root)}`;
		this.applyView(select);
		this.tui.requestRender();
	}

	/** Search file contents for the query; results arrive asynchronously. `select` names the result to select. */
	private async runTextSearch(select?: string): Promise<void> {
		const finder = this.finder;
		const root = this.git?.root ?? this.state.path;
		if (!finder || finder.kind !== "text" || finder.query === "") return;
		const seq = ++this.finderSeq;
		finder.note = "searching…";
		this.tui.requestRender();
		const { hits, capped } = parseGrep(await grepText(root, finder.query, this.git !== null), MAX_FIND_RESULTS);
		if (seq !== this.finderSeq || this.finder !== finder) return;
		finder.results = hits.map(h => ({
			name: `${h.path}:${h.line}`,
			path: join(root, h.path),
			isDirectory: false,
			size: -1,
			mtimeMs: 0,
			hit: { line: h.line, text: h.text },
		}));
		finder.note = `${hits.length === 0 ? "no matches" : `${hits.length}${capped ? "+" : ""} hits`}${this.scopeNote(root)}`;
		this.applyView(select);
		this.tui.requestRender();
	}

	/** Keys while typing a find query. */
	private finderInput(data: string): void {
		const finder = this.finder;
		if (!finder) return;
		if (key(data, "escape")) this.exitFinder();
		else if (key(data, "enter")) {
			if (finder.kind === "text") {
				if (finder.query === "") return;
				finder.typing = false;
				void this.runTextSearch();
			} else {
				finder.typing = false;
				if (this.current()) this.open();
			}
		} else if (key(data, "backspace")) {
			if (finder.query === "") return this.exitFinder();
			finder.query = [...finder.query].slice(0, -1).join("");
			if (finder.kind === "files") void this.refreshFileResults();
		} else if (key(data, "up")) this.select(this.sel - 1);
		else if (key(data, "down")) this.select(this.sel + 1);
		else if (isPrintable(data)) {
			finder.query += data;
			if (finder.kind === "files") void this.refreshFileResults();
		}
	}

	/** A find result's label: directory part dimmed for files; path:line then the matching text for hits. */
	private finderLabel(entry: Entry, room: number): { plain: string; styled: string } {
		const t = this.theme;
		const hit = entry.hit;
		if (hit) {
			const plain = truncateToWidth(`${entry.name}  ${hit.text}`, room);
			const cut = Math.min(plain.length, entry.name.length);
			return { plain, styled: t.fg("accent", plain.slice(0, cut)) + t.fg("dim", plain.slice(cut)) };
		}
		const plain = truncateToWidth(entry.name, room);
		const slash = plain.lastIndexOf("/") + 1;
		return { plain, styled: t.fg("dim", plain.slice(0, slash)) + plain.slice(slash) };
	}

	/** Insert the cursor line, or the selected range, as a reference to the previewed file. */
	private insertSelection(): void {
		const entry = this.current();
		const sel = this.selection();
		if (entry && sel) this.done({ action: "insert", refs: [{ path: entry.path, from: sel.from, to: sel.to }] });
	}

	private editCurrent(): void {
		const entry = this.current();
		if (entry) this.done({ action: "edit", filePath: entry.path, line: this.editLine() });
	}

	/** The d / m / w actions, shared by both focus modes. */
	private viewActions(file: Entry | undefined): Action[] {
		const off = this.previewOff();
		const mode = file ? this.modeFor(file) : "file";
		const next = file ? this.nextView(file) : "diff";
		const noOtherView = this.git ? "this file has no changes" : "not a git repository";
		const viewOff = !file ? "select a file first" : (off ?? (this.viewsFor(file).length > 1 ? undefined : noOtherView));
		const mdOff = file && isMarkdown(file.path) ? off : "only for Markdown files";
		return [
			{ keys: "d", label: next === "agent" ? "agent diff" : next, off: viewOff },
			{ keys: "m", label: mode === "rendered" ? "source" : "rendered", off: mdOff },
			{ keys: "w", label: this.state.wrap ? "no wrap" : "wrap", off },
		];
	}

	/** The actions offered right now, each with the reason it is unavailable (if it is). Drives hints and key handling alike. */
	private actions(): Action[] {
		const entry = this.current();
		if (this.finder?.typing) {
			const text = this.finder.kind === "text";
			return [
				{ keys: "Enter", label: text ? "search" : "open", off: text ? (this.finder.query === "" ? "type something to search for" : undefined) : entry ? undefined : "no match" },
				{ keys: "Up/Down", label: "move" },
				{ keys: "Backspace", label: "delete" },
				{ keys: "Esc", label: "stop finding" },
			];
		}
		if (this.searching) {
			return [
				{ keys: "Enter", label: "open", off: !entry ? "no match" : entry.isDirectory ? undefined : this.focusOff() },
				{ keys: "Up/Down", label: "move" },
				{ keys: "Backspace", label: "delete" },
				{ keys: "Esc", label: "clear filter" },
			];
		}
		const file = entry && !entry.isDirectory ? entry : undefined;
		const editOff = !file ? "select a file first" : this.isIdle() ? undefined : "the agent is working";
		if (this.focus === "preview") {
			const sel = this.selection();
			const range = sel ? (sel.from === sel.to ? `L${sel.from}` : `L${sel.from}-${sel.to}`) : undefined;
			const at = this.nearestNo(this.pvCursor);
			return [
				{ keys: "Up/Down", label: "move" },
				{ keys: "Space", label: this.pvAnchor === undefined ? "select lines" : "end selection" },
				{ keys: "Enter/i", label: range ? `insert @ref ${range}` : "insert @ref", off: sel ? undefined : "this row is not a line of the file" },
				{ keys: "e", label: at === undefined ? "edit" : `edit at line ${at}`, off: editOff },
				...this.viewActions(file),
				{ keys: "Tab", label: "back to list" },
			];
		}
		const marks = this.state.marks.size;
		return [
			{ keys: "Enter", label: "open", off: !entry ? "nothing selected" : entry.isDirectory ? undefined : this.focusOff() },
			{ keys: "i", label: marks > 0 ? `insert ${marks} @refs` : "insert @ref", off: file || marks > 0 ? undefined : "select a file first" },
			{ keys: "Space", label: file && this.state.marks.has(file.path) ? "unmark" : "mark", off: file ? undefined : "select a file first" },
			{ keys: "e", label: "edit", off: editOff },
			...this.viewActions(file),
			{ keys: "v", label: this.state.preview ? "hide preview" : "show preview", off: this.fit === "none" ? NO_ROOM : undefined },
			{ keys: "g", label: this.state.changedOnly ? "show all" : "changed only", off: this.git ? undefined : "not a git repository" },
			{
				keys: "a",
				label: { off: "all files", last: "agent last turn", session: "agent session" }[this.nextScope()],
				off: this.agent.last ? undefined : "no agent changes recorded yet (needs a git repository)",
			},
			{ keys: "f", label: "find files" },
			{ keys: "s", label: "search text" },
			{ keys: ".", label: this.state.showHidden ? "hide dotfiles" : "show dotfiles" },
			{ keys: "/", label: this.finder ? "edit query" : "filter" },
			{ keys: "Esc", label: this.finder ? "stop finding" : "close" },
		];
	}

	/** Run `run` unless the action is unavailable, in which case say why. */
	private guarded(keys: string, run: () => void): void {
		const why = this.actions().find(a => a.keys === keys)?.off;
		if (why) this.flash = why;
		else run();
	}

	/** Hint bar rows: only the available actions, packed to the box width. Unavailable ones stay silent until their key is pressed. */
	private hintRows(inner: number): string[] {
		const t = this.theme;
		const rows: string[] = [];
		let line = "";
		for (const a of this.actions().filter(action => !action.off)) {
			const piece = `${t.fg("accent", a.keys)} ${t.fg("muted", a.label)}`;
			const next = line ? `${line}  ${piece}` : ` ${piece}`;
			if (line && visibleWidth(next) > inner) {
				rows.push(line);
				line = ` ${piece}`;
			} else line = next;
		}
		if (line) rows.push(line);
		return rows;
	}

	// ── Input ─────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		this.flash = "";
		if (this.finder?.typing) this.finderInput(data);
		else if (this.searching) this.searchInput(data);
		else if (this.focus === "preview") this.previewInput(data);
		else this.browseInput(data);
		this.tui.requestRender();
	}

	/** The d / m / w toggles, shared by both focus modes. Returns whether `data` was one of them. */
	private viewKey(data: string): boolean {
		if (key(data, "d")) {
			this.guarded("d", () => {
				const file = this.current();
				if (file) this.state.view = this.nextView(file);
				this.refreshPreview();
			});
		} else if (key(data, "m")) {
			this.guarded("m", () => {
				this.state.previewRendered = !this.state.previewRendered;
				this.refreshPreview();
			});
		} else if (key(data, "w")) {
			this.guarded("w", () => {
				this.state.wrap = !this.state.wrap;
			});
		} else return false;
		return true;
	}

	private browseInput(data: string): void {
		if (key(data, "up") || key(data, "k")) this.select(this.sel - 1);
		else if (key(data, "down") || key(data, "j")) this.select(this.sel + 1);
		else if (key(data, "left") || key(data, "h") || key(data, "backspace")) {
			if (this.finder) this.exitFinder();
			else this.goUp();
		}
		else if (key(data, "right") || key(data, "l")) {
			const entry = this.current();
			if (entry?.isDirectory) this.openDirectory(entry);
			else if (!this.focusOff()) this.enterPreview();
		} else if (key(data, "enter")) this.open();
		else if (data === " " || key(data, "space")) this.guarded("Space", () => this.toggleMark());
		else if (key(data, "e")) this.guarded("e", () => this.editCurrent());
		else if (key(data, "tab")) this.guarded("Tab", () => this.enterPreview());
		else if (data === "i") this.guarded("i", () => this.insertFiles());
		else if (this.viewKey(data)) return;
		else if (key(data, "v")) {
			this.guarded("v", () => {
				this.state.preview = !this.state.preview;
				this.pvKey = "";
				this.refreshPreview();
			});
		} else if (this.scrollKey(data, true)) return;
		else if (key(data, "g")) this.guarded("g", () => this.toggleChangedOnly());
		else if (key(data, "a")) this.guarded("a", () => this.cycleAgentScope());
		else if (key(data, "f")) this.guarded("f", () => this.startFinder("files"));
		else if (key(data, "s")) this.guarded("s", () => this.startFinder("text"));
		else if (key(data, ".")) {
			this.state.showHidden = !this.state.showHidden;
			void this.load(this.state.path, this.state.selectedName);
		} else if (key(data, "/")) {
			if (this.finder) this.finder.typing = true;
			else {
				this.searching = true;
				this.query = "";
			}
		} else if (key(data, "escape") || key(data, "q")) {
			if (this.finder) this.exitFinder();
			else this.done({ action: "cancel" });
		}
		else if (isPrintable(data)) {
			// fzf-style: any other printable key starts filtering
			this.searching = true;
			this.query = data;
			this.applyView();
		}
	}

	private previewInput(data: string): void {
		const page = Math.max(1, this.pvBody >> 1);
		if (key(data, "up") || key(data, "k")) this.moveCursor(-1);
		else if (key(data, "down") || key(data, "j")) this.moveCursor(1);
		else if (key(data, "pageUp") || key(data, "ctrl+u") || data === "K") this.moveCursor(-page);
		else if (key(data, "pageDown") || key(data, "ctrl+d") || data === "J") this.moveCursor(page);
		else if (data === "g") this.pvCursor = 0;
		else if (data === "G") this.moveCursor(Number.MAX_SAFE_INTEGER);
		else if (data === " " || key(data, "space") || data === "v") this.pvAnchor = this.pvAnchor === undefined ? this.pvCursor : undefined;
		else if (key(data, "enter") || data === "i") this.guarded("Enter/i", () => this.insertSelection());
		else if (key(data, "e")) this.guarded("e", () => this.editCurrent());
		else if (this.viewKey(data)) return;
		else if (key(data, "escape") && this.pvAnchor !== undefined) this.pvAnchor = undefined;
		else if (key(data, "escape") || key(data, "tab") || key(data, "left") || data === "h" || data === "q") this.focus = "list";
	}

	private searchInput(data: string): void {
		if (key(data, "escape") || key(data, "left")) {
			this.searching = false;
			this.query = "";
			this.applyView(this.state.selectedName);
		} else if (key(data, "enter")) {
			this.open();
		} else if (key(data, "backspace")) {
			if (this.query.length === 0) this.searching = false;
			else this.query = [...this.query].slice(0, -1).join("");
			this.applyView();
		} else if (key(data, "up")) this.select(this.sel - 1);
		else if (key(data, "down")) this.select(this.sel + 1);
		else if (key(data, "right")) {
			const entry = this.current();
			if (entry?.isDirectory) this.openDirectory(entry);
		} else if (this.scrollKey(data, false)) return;
		else if (isPrintable(data)) {
			this.query += data;
			this.applyView();
		}
	}

	// ── Rendering ─────────────────────────────────────────────────────────

	private gitMark(entry: Entry): string {
		if (!this.git || entry.name === "..") return " ";
		const code = this.git.changed.get(entry.path);
		if (code) return code;
		return this.git.dirty.has(entry.path) ? "*" : " ";
	}

	private colorGit(mark: string): string {
		if (mark === " ") return mark;
		const token = mark === "D" ? "error" : mark === "M" || mark === "*" || mark === "R" ? "warning" : "success";
		return this.theme.fg(token, mark);
	}

	/** Exactly `w` visible columns: truncated if too long, space-padded if short. */
	private cell(s: string, w: number): string {
		const clipped = truncateToWidth(s, w);
		return `${clipped}${" ".repeat(Math.max(0, w - visibleWidth(clipped)))}`;
	}

	/** The rows the preview draws at content width `cw`: one per line, or several when wrapping. */
	private displayRows(pv: Preview, cw: number): DisplayRow[] {
		if (this.dispFor === pv && this.dispW === cw && this.dispWrap === this.state.wrap) return this.dispRows;
		const rows: DisplayRow[] = [];
		if (pv.render) {
			for (const text of pv.render(cw)) rows.push({ line: -1, text, first: true });
		} else {
			pv.lines.forEach((l, line) => {
				const parts = this.state.wrap ? wrapTextWithAnsi(l.text, cw) : [truncateToWidth(l.text, cw)];
				(parts.length > 0 ? parts : [""]).forEach((text, k) => rows.push({ line, text, first: k === 0 }));
			});
		}
		this.dispFor = pv;
		this.dispW = cw;
		this.dispWrap = this.state.wrap;
		this.dispRows = rows;
		return rows;
	}

	/** The preview pane: a caption row, then `h - 1` rows of content, each exactly `w` columns. */
	private previewCells(w: number, h: number): string[] {
		const t = this.theme;
		const entry = this.current();
		const pv = this.pv;
		const visible = h - 1;
		this.pvBody = visible;
		const gutterW = pv && pv.gutter !== "none" ? pv.numW + (pv.gutter === "diff" ? 1 : 0) + 1 : 0;
		const rows = pv ? this.displayRows(pv, Math.max(5, w - 1 - gutterW)) : [];

		if (this.focus === "preview") {
			// keep the cursor row on screen
			const at = rows.findIndex(r => r.line === this.pvCursor && r.first);
			if (at >= 0 && at < this.pvScroll) this.pvScroll = at;
			else if (at >= this.pvScroll + visible) this.pvScroll = at - visible + 1;
		}
		if (this.pvReveal !== undefined) {
			const at = rows.findIndex(r => r.line === this.pvReveal && r.first);
			if (at >= 0) this.pvScroll = Math.max(0, at - 3);
			this.pvReveal = undefined;
		}
		this.pvScroll = Math.max(0, Math.min(this.pvScroll, rows.length - visible));

		const first = this.pvScroll + 1;
		const last = Math.min(rows.length, this.pvScroll + visible);
		const where = rows.length > visible ? ` · ${first}-${last}/${rows.length}` : "";
		const sel = this.focus === "preview" && this.pvAnchor !== undefined ? this.selection() : undefined;
		const selecting = sel ? ` · selecting L${sel.from}${sel.to === sel.from ? "" : `-${sel.to}`}` : "";
		const badge = this.focus === "preview" ? `${t.fg("success", "LINES")} ` : "";
		const caption = entry ? ` ${badge}${t.fg("accent", entry.name)}  ${t.fg("dim", pv ? `${pv.note}${where}${selecting}` : "loading…")}` : "";
		const out = [this.cell(caption, w)];

		const lo = Math.min(this.pvAnchor ?? this.pvCursor, this.pvCursor);
		const hi = Math.max(this.pvAnchor ?? this.pvCursor, this.pvCursor);
		for (let i = 0; i < visible; i++) {
			const row = rows[this.pvScroll + i];
			if (!row || !pv) {
				out.push(this.cell("", w));
				continue;
			}
			const src = row.line >= 0 ? pv.lines[row.line] : undefined;
			let gutter = "";
			if (gutterW > 0) {
				const no = row.first && src?.no !== undefined && src.kind !== "hunk" ? String(src.no).padStart(pv.numW) : " ".repeat(pv.numW);
				let mark = "";
				if (pv.gutter === "diff") {
					const m = row.first ? src?.mark : undefined;
					mark = m === "+" ? t.fg("toolDiffAdded", "+") : m === "-" ? t.fg("toolDiffRemoved", "-") : " ";
				}
				gutter = `${t.fg("dim", no)}${mark} `;
			}
			const text = src?.kind === "hunk" ? t.fg("accent", row.text) : src?.kind === "info" ? t.fg("dim", row.text) : row.text;
			let line = this.cell(` ${gutter}${text}`, w);
			if (this.focus === "preview" && row.line >= 0) {
				if (row.line === this.pvCursor) line = t.bg("selectedBg", line);
				else if (this.pvAnchor !== undefined && row.line >= lo && row.line <= hi) line = t.bg("userMessageBg", line);
			}
			else if (row.line >= 0 && row.line === this.pvHit) line = t.bg("userMessageBg", line);
			// the trailing fg reset stops a clipped highlight colour from bleeding into the border
			out.push(`${line}\x1b[39m`);
		}
		return out;
	}

	render(width: number): readonly string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 2);
		const termRows = process.stdout.rows ?? 30;
		this.fit = inner >= SPLIT_MIN ? "side" : termRows - STACK_CHROME >= STACK_MIN_BODY ? "stack" : "none";
		const layout: Layout = this.state.preview ? this.fit : "none";
		const side = layout === "side";
		const stack = layout === "stack";
		if (layout === "none") this.focus = "list";
		const stackBody = termRows - STACK_CHROME; // rows shared by the list, the preview caption and the preview
		const rows = stack ? Math.max(5, Math.min(12, Math.floor(((stackBody - 1) * 2) / 5))) : Math.max(6, Math.min(28, termRows - 10));
		this.listRows = rows;
		this.clampTop();
		const lw = side ? Math.max(30, Math.floor(inner * 0.38)) : inner;
		const pw = side ? inner - lw - 1 : 0;
		const border = (s: string) => t.fg("border", s);
		const row = (s: string) => border("│") + this.cell(s, inner) + border("│");

		let title = this.state.path;
		const maxTitle = lw - 4;
		if (visibleWidth(title) > maxTitle) {
			while (title.length > 1 && visibleWidth(title) > maxTitle - 1) title = title.slice(1);
			title = `…${title}`;
		}
		const scopeTag = this.state.agentScope === "last" ? " [agent: last turn]" : this.state.agentScope === "session" ? " [agent: session]" : "";
		const findTag = this.finder ? (this.finder.kind === "files" ? " [find files]" : " [search text]") : "";
		const tag = findTag || scopeTag || (this.state.changedOnly ? " [changed]" : this.state.showHidden ? " [hidden]" : "");
		const headEdge = `─ ${title}${tag} `;

		const out: string[] = [];
		const topLeft = border("╭") + t.fg("accent", headEdge) + border("─".repeat(Math.max(0, lw - visibleWidth(headEdge))));
		out.push(side ? `${topLeft}${border(`┬${"─".repeat(pw)}╮`)}` : `${topLeft}${border("╮")}`);

		// List column
		const list: string[] = [];
		const finder = this.finder;
		const filtering = finder !== undefined || this.searching || this.query !== "";
		if (finder) list.push(this.cell(` ${t.fg("accent", finder.kind === "files" ? "find" : "text")} ${finder.query}${finder.typing ? "█" : ""}  ${t.fg("dim", finder.note)}`, lw));
		else if (filtering) list.push(this.cell(` ${t.fg("accent", "/")} ${this.query}${this.searching ? "█" : ""}`, lw));
		const visible = this.view.slice(this.top, this.top + rows);
		if (this.loading && this.view.length === 0) list.push(this.cell(t.fg("muted", " loading…"), lw));
		else if (visible.length === 0) list.push(this.cell(t.fg("muted", finder ? "" : this.query ? " no match" : " empty"), lw));
		for (let i = 0; i < visible.length; i++) {
			const entry = visible[i];
			const selected = this.top + i === this.sel;
			const marked = this.state.marks.has(entry.path);
			const gitMark = this.gitMark(entry);
			const name = entry.isDirectory ? `${entry.name}${entry.name === ".." ? "" : "/"}` : entry.name;
			const size = entry.isDirectory || finder ? "" : formatSize(entry.size);
			const agentMark = this.agentMark(entry);
			const room = lw - 7 - visibleWidth(size) - 1;
			const label = finder ? this.finderLabel(entry, Math.max(4, room)) : undefined;
			const shown = label?.plain ?? truncateToWidth(name, Math.max(4, room));
			const gap = " ".repeat(Math.max(1, lw - 6 - visibleWidth(shown) - visibleWidth(size) - 1));
			if (selected) {
				list.push(t.bg("selectedBg", this.cell(` ${marked ? "+" : " "}${gitMark}${agentMark} ${shown}${gap}${size} `, lw)));
			} else {
				const markCell = marked ? t.fg("success", "+") : " ";
				const nameCell = label?.styled ?? (entry.isDirectory ? t.fg("accent", shown) : shown);
				list.push(this.cell(` ${markCell}${this.colorGit(gitMark)}${t.fg("accent", agentMark)} ${nameCell}${gap}${t.fg("dim", size)} `, lw));
			}
		}

		// Body. Side by side keeps a fixed height so the box does not jump while browsing. Stacked is short on rows:
		// the list takes only what it needs (at least 3, at most `rows`) and the preview gets the rest.
		const extra = filtering ? 1 : 0;
		const bodyH = side ? rows + extra : stack ? Math.max(3, Math.min(rows + extra, list.length)) : list.length;
		const previewSide = side ? this.previewCells(pw, bodyH) : [];
		for (let i = 0; i < bodyH; i++) {
			const left = list[i] ?? this.cell("", lw);
			out.push(border("│") + left + (side ? border("│") + previewSide[i] : "") + border("│"));
		}
		if (stack) {
			out.push(border(`├${"─".repeat(inner)}┤`));
			for (const line of this.previewCells(inner, stackBody - bodyH + extra)) out.push(border("│") + line + border("│"));
		}

		out.push(border(`├${"─".repeat(lw)}${side ? `┴${"─".repeat(pw)}` : ""}┤`));
		const entry = this.current();
		const parts: string[] = [];
		if (this.flash) parts.push(t.fg("warning", this.flash));
		else if (entry) parts.push(t.fg("accent", `${entry.isDirectory ? "DIR" : "FILE"} ${entry.name}`));
		if (this.state.marks.size > 0) parts.push(t.fg("success", `${this.state.marks.size} marked`));
		if (this.loading) parts.push(t.fg("muted", "loading…"));
		out.push(row(` ${parts.join("  ")}`));
		for (const hint of this.hintRows(inner)) out.push(row(hint));
		out.push(border(`╰${"─".repeat(inner)}╯`));
		return out;
	}
}
