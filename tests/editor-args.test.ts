import { expect, test } from "bun:test";
import { openAt } from "../editor-args.ts";

test("vi-family and nano take +LINE before the file", () => {
	expect(openAt("nvim", "/a/b.ts", 12)).toEqual(["+12", "/a/b.ts"]);
	expect(openAt("vim", "/a/b.ts", 1)).toEqual(["+1", "/a/b.ts"]);
	expect(openAt("nano", "/a/b.ts", 7)).toEqual(["+7", "/a/b.ts"]);
});

test("the editor is matched by its file name, not its full path", () => {
	expect(openAt("/opt/homebrew/bin/nvim", "/a/b.ts", 3)).toEqual(["+3", "/a/b.ts"]);
});

test("helix and sublime take file:line", () => {
	expect(openAt("hx", "/a/b.ts", 9)).toEqual(["/a/b.ts:9"]);
	expect(openAt("subl", "/a/b.ts", 9)).toEqual(["/a/b.ts:9"]);
});

test("VS Code family uses --goto", () => {
	expect(openAt("code", "/a/b.ts", 4)).toEqual(["--goto", "/a/b.ts:4"]);
	expect(openAt("cursor", "/a/b.ts", 4)).toEqual(["--goto", "/a/b.ts:4"]);
});

test("no line, or an editor we do not know, opens the file plainly rather than passing a wrong flag", () => {
	expect(openAt("nvim", "/a/b.ts", undefined)).toEqual(["/a/b.ts"]);
	expect(openAt("some-editor", "/a/b.ts", 5)).toEqual(["/a/b.ts"]);
	expect(openAt("vimfoo", "/a/b.ts", 5)).toEqual(["/a/b.ts"]); // anchored match: only the exact names
});

import { editorCommand, splitCommand } from "../editor-args.ts";

test("editor commands split like a shell: quotes and backslashes keep spaces inside a word", () => {
	expect(splitCommand("nvim")).toEqual(["nvim"]);
	expect(splitCommand("  code   --wait ")).toEqual(["code", "--wait"]);
	expect(splitCommand('"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" -w')).toEqual([
		"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl",
		"-w",
	]);
	expect(splitCommand("'/opt/my editor/bin/ed' -x")).toEqual(["/opt/my editor/bin/ed", "-x"]);
	expect(splitCommand("/opt/my\\ editor/ed")).toEqual(["/opt/my editor/ed"]);
	expect(splitCommand('emacs -nw --eval "(setq x \\"y\\")"')).toEqual(["emacs", "-nw", "--eval", '(setq x "y")']);
	expect(splitCommand("ed ''")).toEqual(["ed", ""]);
	expect(splitCommand("   ")).toEqual([]);
});

test("GUI editors are told to wait, unless the command already says so", () => {
	expect(editorCommand("code", "/a.ts", 3)).toEqual({ cmd: "code", args: ["--wait", "--goto", "/a.ts:3"] });
	expect(editorCommand("code -w", "/a.ts", 3)).toEqual({ cmd: "code", args: ["-w", "--goto", "/a.ts:3"] });
	expect(editorCommand("subl --wait", "/a.ts", undefined)).toEqual({ cmd: "subl", args: ["--wait", "/a.ts"] });
	expect(editorCommand("zed", "/a.ts", 2)).toEqual({ cmd: "zed", args: ["--wait", "/a.ts:2"] });
});

test("terminal editors keep their own arguments and get no wait flag", () => {
	expect(editorCommand("nvim -u NONE", "/a.ts", 5)).toEqual({ cmd: "nvim", args: ["-u", "NONE", "+5", "/a.ts"] });
	expect(editorCommand("hx", "/a.ts", 5)).toEqual({ cmd: "hx", args: ["/a.ts:5"] });
});

test("a blank editor command is reported, not run", () => {
	expect(editorCommand("  ", "/a.ts", 1)).toBeUndefined();
});
