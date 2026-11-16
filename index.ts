import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { type AgentChanges, agentChanges, registerAgentTracking } from "./agent.ts";
import { completeArgs, parseArgs } from "./args.ts";
import { type BrowserResult, type BrowserState, FileBrowser, newFinder } from "./browser.ts";
import { editAndInform, registerEditRenderer } from "./editmode.ts";
import type { CommandContext, ExtensionApi, Tui } from "./host.ts";
import { reference } from "./refs.ts";

/** Why `/lens changes [session]` has nothing to show. */
export function noAgentScope(agent: AgentChanges, scope: "last" | "session"): string {
	if (!agent.last) return agent.error ? `Agent-change tracking failed: ${agent.error}` : "No agent changes recorded yet (they are tracked in git repositories).";
	if (scope === "session" && agent.sessionError) return `The session's agent diff is unavailable (git may have pruned its snapshots): ${agent.sessionError}`;
	return "The agent has no net changes this session.";
}

/** Apply `/lens …` arguments to a fresh browser state. Returns false (after saying why) when they cannot be honoured. */
export async function applyArgs(raw: string, state: BrowserState, cwd: string, ctx: CommandContext): Promise<boolean> {
	const args = parseArgs(raw);
	switch (args.kind) {
		case "browse":
			return true;
		case "error":
			ctx.ui.notify(args.message, "error");
			return false;
		case "find":
			state.finder = newFinder("files", args.query);
			return true;
		case "grep":
			state.finder = newFinder("text", args.query);
			return true;
		case "changes": {
			const agent = await agentChanges();
			if (!agent[args.scope]) {
				ctx.ui.notify(noAgentScope(agent, args.scope), "warning");
				return false;
			}
			state.agentScope = args.scope;
			state.view = "agent";
			return true;
		}
		case "path": {
			const typed = args.path.startsWith("~/") ? `${homedir()}${args.path.slice(1)}` : args.path;
			try {
				const target = await realpath(resolve(cwd, typed));
				if ((await stat(target)).isDirectory()) state.path = target;
				else {
					state.path = dirname(target);
					state.selectedName = basename(target);
					if (state.selectedName.startsWith(".")) state.showHidden = true; // else the list would hide it
				}
				return true;
			} catch {
				ctx.ui.notify(`No such file or folder: ${args.path}`, "error");
				return false;
			}
		}
	}
}

export default function lensExtension(pi: ExtensionApi): void {
	registerEditRenderer(pi);
	registerAgentTracking(pi);
	pi.registerCommand("lens", {
		description: "Browse files, find, search, review the agent's changes; insert @refs or edit in $EDITOR and tell the agent",
		getArgumentCompletions: completeArgs,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/lens needs the interactive TUI", "error");
				return;
			}

			// Resolve symlinks (macOS /tmp → /private/tmp) so paths match what git reports.
			const cwd = await realpath(ctx.cwd);
			const state: BrowserState = {
				path: cwd,
				showHidden: false,
				changedOnly: false,
				preview: true,
				view: "file",
				agentScope: "off",
				previewRendered: false,
				wrap: false,
				marks: new Set(),
			};
			if (!(await applyArgs(args, state, cwd, ctx))) return;
			let tui: Tui | undefined;

			for (;;) {
				const agent = await agentChanges(); // fresh each time: an edit or an agent turn may have happened
				const result = await ctx.ui.custom<BrowserResult | undefined>(
					(t, theme, _keybindings, done) => {
						tui = t;
						return new FileBrowser(state, t, theme, done, () => ctx.isIdle(), agent);
					},
					{ overlay: true, overlayOptions: { width: "96%", anchor: "center", margin: { top: 2, bottom: 2 } } },
				);

				if (!result || result.action === "cancel") return;

				if (result.action === "insert") {
					const text = result.refs.map(ref => reference(ref, cwd)).join(" ");
					if (ctx.ui.supportsEditor === false) ctx.ui.notify(`Cannot paste into the prompt here: ${text}`, "warning");
					else ctx.ui.pasteToEditor(`${text} `);
					return;
				}

				// result.action === "edit": run the editor, then reopen the browser where the user left off.
				if (!tui) return;
				await editAndInform(pi, ctx, tui, result.filePath, cwd, result.line);
			}
		},
	});
}
