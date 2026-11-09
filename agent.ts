import { setTimeout as sleep } from "node:timers/promises";
import { type TreeRange, changedBetween, dirsContaining, repoRoot, snapshotTree } from "./git.ts";
import type { EventContext, ExtensionApi } from "./host.ts";

/**
 * Which files did the agent change? Take a whole-working-tree snapshot (a git tree id) when each agent
 * loop starts and ends, and diff the two. That catches edits made by any tool, including bash and
 * formatters, and ignores what the user did between loops. Each loop is persisted in the session, so
 * the record survives a resume as long as git still has the tree objects.
 */

const ENTRY_TYPE = "lens.agent-turn";
/**
 * How long a prompt waits for its "before" snapshot. omp abandons a handler that outlives its handler timeout
 * (30 s by default), so stay well under it: past this the snapshot finishes in the background, and edits the
 * agent makes meanwhile may land in it.
 */
const SNAPSHOT_WAIT_MS = 10_000;
/** A prepared snapshot older than this belongs to a prompt whose loop never started; it is not reused. */
const PREPARED_MAX_AGE_MS = 60_000;

interface TurnRecord {
	root: string;
	from: string;
	to: string;
	/** [absolute path, one-letter status] */
	files: [string, string][];
}

function isFileEntry(entry: unknown): entry is [string, string] {
	return Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string";
}

/** Persisted entries come back from disk: check the shape before trusting it. */
function isTurnRecord(data: unknown): data is TurnRecord {
	if (typeof data !== "object" || data === null) return false;
	if (!("root" in data) || typeof data.root !== "string") return false;
	if (!("from" in data) || typeof data.from !== "string") return false;
	if (!("to" in data) || typeof data.to !== "string") return false;
	return "files" in data && Array.isArray(data.files) && data.files.every(isFileEntry);
}

/** What the agent changed over some span, ready for the browser. */
export interface AgentScope {
	files: Map<string, string>;
	/** Directories containing at least one of `files`. */
	dirs: Set<string>;
	range: TreeRange;
}

export interface AgentChanges {
	/** The agent's most recent loop. */
	last?: AgentScope;
	/** Net change since the session's first recorded loop. */
	session?: AgentScope;
}

type Start = Promise<{ root: string; tree: string } | undefined>;

interface Tracker {
	/** Snapshot taken before a prompt's agent loop, waiting for that loop's agent_start, and when it was taken. */
	prepared: { start: Start; at: number } | undefined;
	/** Snapshot taken when the current agent loop started. */
	started: Start | undefined;
	turns: TurnRecord[];
	/** Net files changed from the first loop's start to the last loop's end, limited to files some loop touched. */
	sessionFiles: Map<string, string>;
	/** Settles when the bookkeeping for the latest event has finished. */
	pending: Promise<void>;
}

const emptyTracker = (turns: TurnRecord[] = []): Tracker => ({ prepared: undefined, started: undefined, turns, sessionFiles: new Map(), pending: Promise.resolve() });

let tracker: Tracker = emptyTracker();

/** Snapshot the repository containing `cwd`; undefined outside one or on a git failure. */
async function snapshotAt(cwd: string): Start {
	const root = await repoRoot(cwd);
	if (!root) return undefined;
	try {
		return { root, tree: await snapshotTree(root) };
	} catch {
		return undefined;
	}
}

/** Only the main interactive session is tracked: subagents have no `sessionModes`. */
function isMainSession(ctx: EventContext): boolean {
	return ctx.mode === "tui" && ctx.sessionModes !== undefined;
}

/**
 * The session scope: the net change from the first loop's start to the last loop's end, keeping only files that
 * some agent loop changed. The net diff alone would also pick up what the user edited between loops.
 */
export function agentSessionFiles(net: Map<string, string>, turns: readonly { files: [string, string][] }[]): Map<string, string> {
	const touched = new Set(turns.flatMap(turn => turn.files.map(([path]) => path)));
	return new Map([...net].filter(([path]) => touched.has(path)));
}

async function recomputeSession(): Promise<void> {
	const first = tracker.turns[0];
	const last = tracker.turns[tracker.turns.length - 1];
	if (!first || !last) {
		tracker.sessionFiles = new Map();
		return;
	}
	try {
		tracker.sessionFiles = agentSessionFiles(await changedBetween(last.root, first.from, last.to), tracker.turns);
	} catch {
		tracker.sessionFiles = new Map(); // tree objects were garbage-collected
	}
}

async function finishLoop(pi: ExtensionApi, started: Tracker["started"]): Promise<void> {
	const begin = await started;
	if (!begin) return;
	try {
		const to = await snapshotTree(begin.root);
		if (to === begin.tree) return; // the loop changed no files
		const files = [...(await changedBetween(begin.root, begin.tree, to))];
		const record: TurnRecord = { root: begin.root, from: begin.tree, to, files };
		tracker.turns.push(record);
		pi.appendEntry(ENTRY_TYPE, record);
		await recomputeSession();
	} catch {
		// tracking is best-effort: a git failure must never disturb the session
	}
}

/** Start recording what the agent changes. */
export function registerAgentTracking(pi: ExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		if (!isMainSession(ctx)) return;
		const records = ctx.sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === ENTRY_TYPE)
			.map(entry => entry.data)
			.filter(isTurnRecord);
		tracker = emptyTracker(records);
		tracker.pending = recomputeSession();
	});
	// A snapshot started at agent_start races the agent's first edits, which could land in the "before" tree
	// and be attributed to nobody. omp awaits before_agent_start before a prompt's loop begins, so take the
	// snapshot there. (Not in a tool_call handler: registering one turns off omp's speculative tool execution.)
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!isMainSession(ctx)) return;
		const start = snapshotAt(ctx.cwd);
		tracker.prepared = { start, at: Date.now() };
		await Promise.race([start, sleep(SNAPSHOT_WAIT_MS, undefined, { ref: false })]);
	});
	pi.on("agent_start", (_event, ctx) => {
		if (!isMainSession(ctx)) return;
		// Loops that do not start from a prompt (continuations) have no prepared snapshot: take one now.
		const prepared = tracker.prepared;
		tracker.prepared = undefined;
		tracker.started = prepared && Date.now() - prepared.at < PREPARED_MAX_AGE_MS ? prepared.start : snapshotAt(ctx.cwd);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (!isMainSession(ctx)) return;
		const started = tracker.started; // capture now: a new loop may start before this one finishes
		tracker.started = undefined;
		tracker.pending = tracker.pending.then(() => finishLoop(pi, started));
	});
}

/** What the agent has changed so far, once any in-flight bookkeeping has finished. */
export async function agentChanges(): Promise<AgentChanges> {
	await tracker.pending;
	const first = tracker.turns[0];
	const last = tracker.turns[tracker.turns.length - 1];
	if (!first || !last) return {};
	const files = new Map(last.files);
	const net = tracker.sessionFiles;
	return {
		last: { files, dirs: dirsContaining(files.keys(), last.root), range: { root: last.root, from: last.from, to: last.to, label: "agent diff · last turn" } },
		session:
			net.size > 0
				? { files: net, dirs: dirsContaining(net.keys(), last.root), range: { root: last.root, from: first.from, to: last.to, label: "agent diff · session" } }
				: undefined,
	};
}
