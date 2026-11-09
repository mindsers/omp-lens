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
