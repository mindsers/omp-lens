import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Text } from "@oh-my-pi/pi-tui";
import { editorCommand } from "./editor-args.ts";
import { type EditDiff, type Snapshot, diffSince, takeSnapshot } from "./git.ts";
import type { CommandContext, ExtensionApi, Tui } from "./host.ts";

const MAX_PATCH_CHARS = 50_000;
const EDIT_MESSAGE_TYPE = "lens.user-edit";
const SUMMARY_PREFIX = "Changed files ";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

function describe(diff: EditDiff, cwd: string): string {
	const list = diff.files.map(f => `${f.status} ${relative(cwd, f.path) || f.path}`).join(", ");
	const header = [
		"The user edited files directly in their own editor, outside your tools.",
		"Treat the result as the current state. Re-read a file before editing it: line anchors from earlier reads may be stale.",
		"",
		`${SUMMARY_PREFIX}(${diff.files.length}, +${diff.added} -${diff.removed}): ${list}`,
	];
	if (diff.patch.length <= MAX_PATCH_CHARS) {
		return [...header, "", "```diff", diff.patch.trimEnd(), "```"].join("\n");
	}
	const inspect = diff.trees ? `Diff omitted (${diff.patch.length} chars). Inspect with: git diff ${diff.trees.from} ${diff.trees.to}` : `Diff omitted (${diff.patch.length} chars). Read the file.`;
	return [...header, "", inspect].join("\n");
}

/**
 * The agent receives the full diff, but the transcript only shows the summary line;
 * the whole message appears when the entry is expanded.
 */
export function registerEditRenderer(pi: ExtensionApi): void {
	pi.registerMessageRenderer(EDIT_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		if (expanded) return new Text(text, 1, 0);
		const summary = text.split("\n").find(line => line.startsWith(SUMMARY_PREFIX));
		const detail = summary ? summary.slice(SUMMARY_PREFIX.length) : "";
		return new Text(`${theme.fg("accent", "You edited")} ${detail} ${theme.fg("dim", "(sent to the agent)")}`, 1, 0);
	});
}

/**
 * Run the user's editor on a file, then tell the agent what changed.
 * Delivery is "nextTurn": the agent sees it on the next prompt; no turn starts now.
 * Returns false when the edit could not start.
 */
export async function editAndInform(pi: ExtensionApi, ctx: CommandContext, tui: Tui, filePath: string, cwd: string, line?: number): Promise<boolean> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("The agent is still working. Wait for it to finish before editing.", "warning");
		return false;
	}

	const editor = process.env.VISUAL || process.env.EDITOR || "vi";
	const command = editorCommand(editor, filePath, line);
	if (!command) {
		ctx.ui.notify("$VISUAL / $EDITOR is blank: set it to your editor command.", "error");
		return false;
	}

	let before: Snapshot;
	try {
		before = await takeSnapshot(filePath);
	} catch (err) {
		ctx.ui.notify(`Not editing: could not snapshot the working tree first (${errorText(err)}).`, "error");
		return false;
	}

	// Never call tui.stop() here: it flushes the transcript into terminal scrollback and the chat
	// comes back blank. A full-screen editor switches to the alternate screen itself and restores
	// this screen on exit. spawnSync blocks omp's event loop, so nothing reads stdin or paints meanwhile.
	tui.requestRender();
	await sleep(50); // let the repaint that closed the overlay reach the terminal first
	const { error } = spawnSync(command.cmd, command.args, { stdio: "inherit" });
	tui.requestRender();
	if (error) {
		ctx.ui.notify(`Could not run ${command.cmd}: ${error.message}`, "error");
		return false;
	}

	let diff: EditDiff | null;
	try {
		diff = await diffSince(before);
	} catch (err) {
		ctx.ui.notify(`Edit saved, but the agent was not told: could not diff the working tree (${errorText(err)}).`, "error");
		return true;
	}
	if (!diff) {
		ctx.ui.notify("No changes.", "info");
		return true;
	}
	pi.sendMessage({ customType: EDIT_MESSAGE_TYPE, content: describe(diff, cwd), display: true }, { deliverAs: "nextTurn" });
	ctx.ui.notify(`Agent informed: ${diff.files.length} file(s), +${diff.added} -${diff.removed}`, "info");
	return true;
}
