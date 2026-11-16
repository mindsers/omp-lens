import { expect, test } from "bun:test";
import { agentSessionFiles } from "../agent.ts";

test("the session scope keeps only files some agent turn changed, not the user's edits between turns", () => {
	const net = new Map([
		["/r/agent.ts", "M"],
		["/r/user-only.ts", "M"],
		["/r/both.ts", "A"],
	]);
	const turns = [{ files: [["/r/agent.ts", "M"]] as [string, string][] }, { files: [["/r/both.ts", "A"]] as [string, string][] }];
	expect([...agentSessionFiles(net, turns)]).toEqual([
		["/r/agent.ts", "M"],
		["/r/both.ts", "A"],
	]);
});

test("a file the agent changed and later reverted has no net change, so it drops out", () => {
	const turns = [{ files: [["/r/a.ts", "M"]] as [string, string][] }, { files: [["/r/a.ts", "M"]] as [string, string][] }];
	expect(agentSessionFiles(new Map(), turns).size).toBe(0);
});

import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentChanges, registerAgentTracking } from "../agent.ts";
import type { EventContext, ExtensionApi } from "../host.ts";

type Handler = (event: unknown, ctx: EventContext) => void | Promise<void>;

/** A stand-in for omp: records handlers and appended entries, and fires events the way omp awaits them. */
function fakeOmp() {
	const handlers = new Map<string, Handler[]>();
	const entries: unknown[] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		appendEntry: (_type: string, data: unknown) => entries.push(data),
	} as unknown as ExtensionApi;
	const fire = async (event: string, ctx: EventContext) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
	};
	return { pi, handlers, entries, fire };
}

test("tracking: an edit made the instant the loop starts is the agent's; the user's edits between loops are not", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "lens-agent-")));
	try {
		execFileSync("git", ["init", "-q", "."], { cwd: root });
		await writeFile(join(root, "a.txt"), "a\n");
		const omp = fakeOmp();
		registerAgentTracking(omp.pi);
		expect(omp.handlers.has("tool_call")).toBe(false); // a tool_call handler would turn off omp's speculative execution
		const ctx: EventContext = { cwd: root, mode: "tui", sessionModes: {}, sessionManager: { getBranch: () => [] } };
		await omp.fire("session_start", ctx);

		await omp.fire("before_agent_start", ctx);
		await omp.fire("agent_start", ctx);
		await writeFile(join(root, "agent.txt"), "by the agent\n"); // no await between start and edit: the race case
		await omp.fire("agent_end", ctx);
		await agentChanges(); // the end-of-loop snapshot runs in the background; a user acts long after it

		await writeFile(join(root, "user.txt"), "by the user, between loops\n");

		await omp.fire("before_agent_start", ctx);
		await omp.fire("agent_start", ctx);
		await writeFile(join(root, "a.txt"), "changed by the agent\n");
		await omp.fire("agent_end", ctx);

		const changes = await agentChanges();
		expect([...(changes.last?.files.keys() ?? [])]).toEqual([join(root, "a.txt")]);
		expect([...(changes.session?.files.keys() ?? [])].sort()).toEqual([join(root, "a.txt"), join(root, "agent.txt")]);
		expect(omp.entries).toHaveLength(2); // one persisted record per loop that changed files
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("tracking ignores subagents (no sessionModes)", async () => {
	const omp = fakeOmp();
	registerAgentTracking(omp.pi);
	await omp.fire("session_start", { cwd: tmpdir(), mode: "tui", sessionModes: {}, sessionManager: { getBranch: () => [] } }); // start clean
	const ctx: EventContext = { cwd: tmpdir(), mode: "tui", sessionManager: { getBranch: () => [] } };
	await omp.fire("before_agent_start", ctx);
	await omp.fire("agent_start", ctx);
	await omp.fire("agent_end", ctx);
	expect(omp.entries).toHaveLength(0);
});

/** A main-session context in `cwd` whose branch holds `entries`. */
const mainCtx = (cwd: string, entries: EventContext["sessionManager"] extends { getBranch(): infer E } ? E : never = []): EventContext => ({
	cwd,
	mode: "tui",
	sessionModes: {},
	sessionManager: { getBranch: () => entries },
});

async function tempRepo(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "lens-agent-")));
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	await writeFile(join(root, "a.txt"), "a\n");
	return root;
}

async function agentLoop(omp: ReturnType<typeof fakeOmp>, ctx: EventContext, edit: () => Promise<void>): Promise<void> {
	await omp.fire("before_agent_start", ctx);
	await omp.fire("agent_start", ctx);
	await edit();
	await omp.fire("agent_end", ctx);
}

test("/new starts with no agent changes; a loop still finishing from the old session is not recorded into it", async () => {
	const root = await tempRepo();
	try {
		const omp = fakeOmp();
		registerAgentTracking(omp.pi);
		await omp.fire("session_start", mainCtx(root));
		await agentLoop(omp, mainCtx(root), () => writeFile(join(root, "first.txt"), "x\n"));
		expect((await agentChanges()).last).toBeDefined();

		// The old loop's "after" snapshot is still in flight when the user switches session.
		await agentLoop(omp, mainCtx(root), () => writeFile(join(root, "second.txt"), "x\n"));
		await omp.fire("session_switch", mainCtx(root));

		expect(await agentChanges()).toEqual({ error: undefined });
		expect(omp.entries).toHaveLength(1); // only the first loop; the second belonged to the old session
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("switching to a session restores the turns on its branch, skipping malformed entries", async () => {
	const root = await tempRepo();
	try {
		const recorder = fakeOmp();
		registerAgentTracking(recorder.pi);
		await recorder.fire("session_start", mainCtx(root));
		await agentLoop(recorder, mainCtx(root), () => writeFile(join(root, "a.txt"), "changed\n"));
		await agentChanges();
		const [record] = recorder.entries;

		const omp = fakeOmp();
		registerAgentTracking(omp.pi);
		await omp.fire("session_start", mainCtx(root)); // a fresh launch with an empty session
		expect((await agentChanges()).last).toBeUndefined();
		const branch = [
			{ type: "custom", customType: "lens.agent-turn", data: { root, from: "x" } }, // malformed: dropped
			{ type: "custom", customType: "other.plugin", data: record },
			{ type: "custom", customType: "lens.agent-turn", data: record },
		];
		await omp.fire("session_tree", mainCtx(root, branch));
		const changes = await agentChanges();
		expect([...(changes.last?.files.keys() ?? [])]).toEqual([join(root, "a.txt")]);
		expect([...(changes.session?.files.keys() ?? [])]).toEqual([join(root, "a.txt")]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a git failure is reported as a tracking failure, not as 'no changes'", async () => {
	const root = await tempRepo();
	try {
		const omp = fakeOmp();
		registerAgentTracking(omp.pi);
		await omp.fire("session_start", mainCtx(root));
		await writeFile(join(root, ".git", "config"), "[broken\n"); // git refuses to read it, so lens runs no git here
		await agentLoop(omp, mainCtx(root), () => writeFile(join(root, "a.txt"), "changed\n"));
		const changes = await agentChanges();
		expect(changes.last).toBeUndefined();
		expect(changes.error).toBe("fatal: bad config line 1 in file .git/config"); // git's reason, not the command line
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
