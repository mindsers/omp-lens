import { basename } from "node:path";

/** Editors that take `+LINE FILE`, editors that take `FILE:LINE`, and VS Code's family (`--goto FILE:LINE`). Anything else opens without a line. */
const PLUS_LINE = /^(vi|vim|nvim|view|vimx|nano|emacs|emacsclient|micro|kak)$/;
const COLON_LINE = /^(hx|subl|zed|xed)$/;
const GOTO_LINE = /^(code|code-insiders|codium|cursor|windsurf)$/;
/** GUI editors whose launcher returns at once unless told to wait for the file to be closed. */
const NEEDS_WAIT = /^(code|code-insiders|codium|cursor|windsurf|subl|zed|xed)$/;
const WAIT_FLAGS = ["--wait", "-w"];

/** Arguments that open `file` in `editor`, at `line` when the editor is known to support it. */
export function openAt(editor: string, file: string, line: number | undefined): string[] {
	const name = basename(editor);
	if (line === undefined) return [file];
	if (PLUS_LINE.test(name)) return [`+${line}`, file];
	if (COLON_LINE.test(name)) return [`${file}:${line}`];
	if (GOTO_LINE.test(name)) return ["--goto", `${file}:${line}`];
	return [file];
}

/**
 * Split an `$EDITOR`-style command into words the way a POSIX shell would for the common cases: whitespace
 * separates words, single quotes are literal, double quotes allow `\"` `\\` `\$` and `` \` ``, and a backslash
 * outside quotes escapes the next character. No expansion of variables, globs or `~`.
 */
export function splitCommand(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else word += ch;
		} else if (quote === '"') {
			if (ch === '"') quote = undefined;
			else if (ch === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) word += command[++i];
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === "\\" && i + 1 < command.length) {
			word += command[++i];
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
		} else {
			word += ch;
			inWord = true;
		}
	}
	if (inWord) words.push(word);
	return words;
}

/**
 * The program and arguments to edit `file` (at `line` when supported) with the editor command `command`
 * (`$VISUAL` / `$EDITOR`). GUI editors get their wait flag unless the command already has one, so the edit is
 * only diffed once the file is closed. Undefined when `command` is blank.
 */
export function editorCommand(command: string, file: string, line: number | undefined): { cmd: string; args: string[] } | undefined {
	const [cmd, ...args] = splitCommand(command);
	if (cmd === undefined) return undefined;
	const wait = NEEDS_WAIT.test(basename(cmd)) && !args.some(arg => WAIT_FLAGS.includes(arg)) ? ["--wait"] : [];
	return { cmd, args: [...args, ...wait, ...openAt(cmd, file, line)] };
}
