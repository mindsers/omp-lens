import type { ArgumentCompletion } from "./host.ts";

/** What `/lens …` asks for. */
export type LensArgs =
	| { kind: "browse" }
	| { kind: "find"; query: string }
	| { kind: "grep"; query: string }
	| { kind: "changes"; scope: "last" | "session" }
	| { kind: "path"; path: string }
	| { kind: "error"; message: string };

const SUBCOMMANDS: ArgumentCompletion[] = [
	{ label: "find", value: "find ", description: "Find files by name" },
	{ label: "grep", value: "grep ", description: "Search file contents" },
	{ label: "changes", value: "changes", description: "Files the agent changed in its last turn (add 'session' for all)" },
];

/**
 * `/lens` browses the working directory. `/lens find [query]`, `/lens grep [query]` and `/lens changes [session]`
 * open straight into a mode. Anything else is a folder or file to open at; write `./find` for a folder named
 * like a subcommand.
 */
export function parseArgs(raw: string): LensArgs {
	const args = raw.trim();
	if (args === "") return { kind: "browse" };
	const space = args.search(/\s/);
	const head = space < 0 ? args : args.slice(0, space);
	const rest = space < 0 ? "" : args.slice(space + 1).trim();
	if (head === "find") return { kind: "find", query: rest };
	if (head === "grep") return { kind: "grep", query: rest };
	if (head === "changes") {
		if (rest === "" || rest === "last") return { kind: "changes", scope: "last" };
		if (rest === "session") return { kind: "changes", scope: "session" };
		return { kind: "error", message: `/lens changes takes "session" or nothing, not "${rest}"` };
	}
	return { kind: "path", path: args };
}

/** Subcommand suggestions while the first word is being typed. */
export function completeArgs(prefix: string): ArgumentCompletion[] | null {
	if (/\s/.test(prefix)) return null;
	const matches = SUBCOMMANDS.filter(c => c.label.startsWith(prefix.toLowerCase()));
	return matches.length > 0 ? matches : null;
}
