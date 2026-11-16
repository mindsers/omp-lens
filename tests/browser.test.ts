import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// omp supplies these modules at runtime; stand-ins good enough to drive the component.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
mock.module("@oh-my-pi/pi-tui", () => ({
	matchesKey: (data: string, id: string) =>
		({ up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", escape: "\x1b", tab: "\t", backspace: "\x7f", space: " " })[id] === data,
	truncateToWidth: (s: string, w: number) => (stripAnsi(s).length <= w ? s : stripAnsi(s).slice(0, w)),
	visibleWidth: (s: string) => stripAnsi(s).length,
	wrapTextWithAnsi: (s: string, w: number) => stripAnsi(s).match(new RegExp(`.{1,${w}}`, "g")) ?? [""],
	Markdown: class {
		render() {
			return ["(markdown)"];
		}
	},
	Text: class {},
}));
mock.module("@oh-my-pi/pi-natives", () => ({ highlightCode: (code: string) => code, supportsLanguage: () => false, warmHighlighter: () => undefined }));
mock.module("@oh-my-pi/pi-coding-agent", () => ({ getMarkdownTheme: () => ({}) }));

const { FileBrowser, newFinder } = await import("../browser.ts");
type State = import("../browser.ts").BrowserState;
type Result = import("../browser.ts").BrowserResult;

const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, getFgAnsi: () => "" };
let root = "";

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "lens-browser-")));
	await mkdir(join(root, "src"));
	await writeFile(join(root, "README.md"), "# hi\n");
	await writeFile(join(root, "src", "browser.ts"), "export const a = 1;\nexport const needle = 2;\n");
	await writeFile(join(root, "src", "other.ts"), "nothing\n");
	execFileSync("mkfifo", [join(root, "pipe")]);
	execFileSync("git", ["init", "-q", "."], { cwd: root });
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

function state(extra: Partial<State> = {}): State {
	return { path: root, showHidden: false, changedOnly: false, preview: true, view: "file", agentScope: "off", previewRendered: false, wrap: false, marks: new Set(), ...extra };
}

/** A browser plus a way to wait until its async work has settled and to read what it draws. */
function open(s: State) {
	let result: Result | undefined;
	const tui = { requestRender: () => undefined };
	const browser = new FileBrowser(s, tui, theme, r => (result = r), () => true, {});
	const screen = () => browser.render(120).map(stripAnsi).join("\n");
	const until = async (cond: () => boolean) => {
		for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10);
		expect(cond()).toBe(true);
	};
	const type = (text: string) => {
		for (const ch of text) browser.handleInput(ch);
	};
	return { browser, screen, until, type, result: () => result };
}

test("opens a folder, lists it and previews the selection", async () => {
	const b = open(state());
	await b.until(() => b.screen().includes("src/"));
	expect(b.screen()).toContain("README.md");
});

test("a named pipe is listed but not opened by the preview (it would block)", async () => {
	const b = open(state({ selectedName: "pipe" }));
	await b.until(() => b.screen().includes("special file"));
});

test("find files: typing ranks results; Enter opens one in the preview, i inserts it", async () => {
	const b = open(state());
	await b.until(() => b.screen().includes("README.md"));
	b.type("f");
	b.type("brow");
	await b.until(() => b.screen().includes("src/browser.ts") && b.screen().includes("1 files"));
	await b.until(() => b.screen().includes("export const needle")); // the preview has loaded
	b.browser.handleInput("\r"); // into the preview's line mode
	expect(b.screen()).toContain("LINES");
	b.browser.handleInput("\t"); // back to the list
	b.type("i");
	expect(b.result()).toEqual({ action: "insert", refs: [{ path: join(root, "src", "browser.ts") }] });
});

test("/lens grep <query> opens with results, and the find survives a reopen (as after an edit)", async () => {
	const s = state({ finder: newFinder("text", "needle") });
	const first = open(s);
	await first.until(() => first.screen().includes("src/browser.ts:2"));
	expect(s.finder?.selected).toBe("src/browser.ts:2");

	// The edit flow closes the overlay and builds a new browser on the same state.
	const second = open(s);
	await second.until(() => second.screen().includes("[search text]") && second.screen().includes("FILE src/browser.ts:2"));
	second.type("i");
	expect(second.result()).toEqual({ action: "insert", refs: [{ path: join(root, "src", "browser.ts"), from: 2 }] });
});

test("leaving find returns to the entry selected before it started", async () => {
	const s = state({ selectedName: "README.md" });
	const b = open(s);
	await b.until(() => b.screen().includes("FILE README.md"));
	b.type("f");
	b.type("other");
	await b.until(() => b.screen().includes("src/other.ts"));
	b.browser.handleInput("\r"); // open the result in the preview
	b.browser.handleInput("\t"); // back to the list
	b.browser.handleInput("\x1b"); // leave find
	await b.until(() => b.screen().includes("FILE README.md"));
	expect(s.finder).toBeUndefined();
});

// ── Preview ──────────────────────────────────────────────────────────────

const { loadPreview } = await import("../preview.ts");

async function previewOf(name: string, content: string | Buffer, mode: import("../preview.ts").PreviewMode = "file", gitRoot: string | null = null) {
	const path = join(root, name);
	await writeFile(path, content);
	const size = typeof content === "string" ? Buffer.byteLength(content) : content.length;
	return loadPreview({ name, path, isDirectory: false, size, mtimeMs: 0 }, mode, theme, gitRoot);
}

test("preview: escape sequences in a file never reach the terminal raw", async () => {
	const p = await previewOf("evil.txt", "a\x1b]52;c;aGk=\x07b\n\x1b[2Jc\n");
	const drawn = p.lines.map(l => l.text).join("\n");
	expect(drawn).not.toContain("\x1b");
	expect(drawn).toContain("␛");
});

test("preview: binary, empty and oversized files say so in the caption", async () => {
	expect((await previewOf("bin.dat", Buffer.from([1, 0, 2]))).note).toContain("binary file");
	expect((await previewOf("empty.txt", "")).note).toBe("empty file");
	const long = await previewOf("long.txt", "x\n".repeat(3500));
	expect(long.note).toContain("truncated");
	expect(long.lines).toHaveLength(3000);
});

test("preview: a diff view of an unchanged file falls back to its content; a failed diff says why", async () => {
	const clean = await previewOf("clean.txt", "same\n", "diff", root); // the repo has no commits: no diff
	expect(clean.lines.map(l => l.text)).toEqual(["same"]);
	expect(clean.note).not.toContain("diff unavailable");
	const failed = await previewOf("clean.txt", "same\n", "diff", join(root, "no-such-dir"));
	expect(failed.lines.map(l => l.text)).toEqual(["same"]);
	expect(failed.note).toContain("diff unavailable");
});

// ── Browser state across reopenings ──────────────────────────────────────

test("a remembered agent scope that no longer exists is dropped on reopen, not shown over the full list", async () => {
	const s = state({ agentScope: "session", view: "agent" });
	const b = open(s); // opened with no agent changes at all
	await b.until(() => b.screen().includes("README.md"));
	expect(s.agentScope).toBe("off");
	expect(s.view).toBe("file");
	expect(b.screen()).not.toContain("[agent:");
});

// ── /lens arguments ──────────────────────────────────────────────────────

const { applyArgs, noAgentScope } = await import("../index.ts");

function argsCtx() {
	const notes: string[] = [];
	return { notes, ctx: { mode: "tui", cwd: root, isIdle: () => true, ui: { notify: (m: string) => notes.push(m), custom: async () => undefined, pasteToEditor: () => undefined } } };
}

test("/lens <file> opens its folder with it selected; a dotfile turns on hidden files; a bad path is an error", async () => {
	await writeFile(join(root, "src", ".hidden.ts"), "x\n");
	const { ctx, notes } = argsCtx();
	const s = state();
	expect(await applyArgs("src/.hidden.ts", s, root, ctx)).toBe(true);
	expect(s).toMatchObject({ path: join(root, "src"), selectedName: ".hidden.ts", showHidden: true });
	expect(await applyArgs("nope/missing.ts", state(), root, ctx)).toBe(false);
	expect(notes).toEqual(["No such file or folder: nope/missing.ts"]);
});

test("/lens changes explains why there is nothing to show", () => {
	expect(noAgentScope({}, "last")).toContain("No agent changes recorded yet");
	expect(noAgentScope({ error: "bad config" }, "last")).toBe("Agent-change tracking failed: bad config");
	const last = { files: new Map(), dirs: new Set<string>(), range: { root, from: "a", to: "b", label: "" } };
	expect(noAgentScope({ last }, "session")).toBe("The agent has no net changes this session.");
	expect(noAgentScope({ last, sessionError: "bad object" }, "session")).toContain("unavailable");
});

// ── Edit in $EDITOR ──────────────────────────────────────────────────────

const { editAndInform } = await import("../editmode.ts");

async function runEdit(script: string, file: string, idle = true) {
	const editor = join(root, "fake-editor.sh");
	await writeFile(editor, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	const sent: { content: string; deliverAs?: string }[] = [];
	const notes: string[] = [];
	const pi = { sendMessage: (m: { content: string }, o?: { deliverAs?: string }) => sent.push({ content: m.content, deliverAs: o?.deliverAs }) };
	const ctx = { mode: "tui", cwd: root, isIdle: () => idle, ui: { notify: (m: string) => notes.push(m), custom: async () => undefined, pasteToEditor: () => undefined } };
	const saved = process.env.VISUAL;
	process.env.VISUAL = editor;
	try {
		const ok = await editAndInform(pi as never, ctx, { requestRender: () => undefined }, file, root);
		return { ok, sent, notes };
	} finally {
		if (saved === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = saved;
	}
}

test("edit: a saved change is sent to the agent for its next turn", async () => {
	const file = join(root, "edited.txt");
	await writeFile(file, "one\n");
	const r = await runEdit(`echo two >> "$1"`, file);
	expect(r.ok).toBe(true);
	expect(r.sent).toHaveLength(1);
	expect(r.sent[0].deliverAs).toBe("nextTurn");
	expect(r.sent[0].content).toContain("Changed files (1, +1 -0): M edited.txt");
	expect(r.sent[0].content).toContain("+two");
});

test("edit: no change sends nothing; a busy agent or a missing editor stops before anything runs", async () => {
	const file = join(root, "README.md");
	expect(await runEdit("true", file)).toMatchObject({ sent: [], notes: ["No changes."] });
	const busy = await runEdit(`echo x >> "$1"`, file, false);
	expect(busy.ok).toBe(false);
	expect(busy.notes[0]).toContain("still working");
	const saved = process.env.VISUAL;
	process.env.VISUAL = join(root, "no-such-editor");
	try {
		const notes: string[] = [];
		const ctx = { mode: "tui", cwd: root, isIdle: () => true, ui: { notify: (m: string) => notes.push(m), custom: async () => undefined, pasteToEditor: () => undefined } };
		expect(await editAndInform({ sendMessage: () => undefined } as never, ctx, { requestRender: () => undefined }, file, root)).toBe(false);
		expect(notes[0]).toContain("Could not run");
	} finally {
		if (saved === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = saved;
	}
});
