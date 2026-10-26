import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerRosterCommands } from "../../src/roster/commands.ts";
import { createRosterRuntime } from "../../src/roster/runtime.ts";
import type { SubagentState } from "../../src/shared/types.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const messages: unknown[] = [];
	return {
		pi: {
			on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler)); },
			registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, definition); },
			sendMessage(message: unknown) { messages.push(message); },
			events: { on() { return () => {}; }, emit() {} },
		},
		handlers, commands, messages,
	};
}

let cwd: string;
let home: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "roster-cmd-"));
	home = fs.mkdtempSync(path.join(os.tmpdir(), "roster-cmd-home-"));
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ agentRoster: { teams: { pair: { shape: "parallel", members: ["reviewer", "scout"] } } } }));
});
afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	fs.rmSync(cwd, { recursive: true, force: true });
	fs.rmSync(home, { recursive: true, force: true });
});

function harness(asyncJobs: Array<Record<string, unknown>> = []) {
	const { pi, handlers, commands, messages } = fakePi();
	const launched: unknown[] = [];
	const notices: string[] = [];
	const state = { currentSessionId: "S1", baseCwd: cwd, asyncJobs: new Map(asyncJobs.map((job) => [job.asyncId as string, job])), foregroundControls: new Map(), foregroundRuns: new Map(), fleetJobs: new Map() } as unknown as SubagentState;
	const runtime = createRosterRuntime();
	runtime.bind({ sessionId: "S1", cwd });
	const registration = registerRosterCommands(pi as never, state, {
		runtime,
		runCommand: async (_ctx, params) => { launched.push(params); },
		openAgentAdmin: async () => {},
	});
	const ctx = { cwd, hasUI: false, mode: "rpc", model: undefined, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "S1" }, ui: { notify: (text: string) => notices.push(text) } };
	const input = async (text: string, source = "interactive") => {
		const results = [];
		for (const handler of handlers.get("input") ?? []) results.push(await handler({ type: "input", text, source }, ctx));
		return results[0];
	};
	return { input, launched, notices, commands, messages, ctx, dispose: () => { registration.dispose(); runtime.dispose(); } };
}

describe("roster @mention routing", () => {
	it("launches an agent, runs a team, steers a live run, and leaves other input alone", async () => {
		const h = harness([{ asyncId: "run-9", status: "running", sessionId: "S1", agents: ["scout"] }]);
		try {
			assert.deepEqual(await h.input("@worker implement the fix"), { action: "handled" });
			assert.deepEqual(h.launched.at(-1), { agent: "worker", task: "implement the fix", async: true });
			assert.deepEqual(await h.input("@pair review the diff"), { action: "handled" });
			assert.deepEqual(h.launched.at(-1), { workflow: "team.pair", args: { task: "review the diff" }, async: true });
			assert.deepEqual(await h.input("@scout also check the RPC path"), { action: "handled" });
			assert.deepEqual(h.launched.at(-1), { action: "steer", id: "run-9", message: "also check the RPC path" });
			assert.deepEqual(await h.input("@main carry on"), { action: "transform", text: "carry on" });
			assert.deepEqual(await h.input("@src/index.ts explain"), { action: "continue" });
			assert.deepEqual(await h.input("plain prompt mentioning @scout"), { action: "continue" });
			assert.deepEqual(await h.input("@worker do it", "rpc"), { action: "continue" }, "non-interactive input is never routed");
			assert.deepEqual(await h.input("@worker"), { action: "handled" });
			assert.match(h.notices.at(-1)!, /Write the task after @worker/);
		} finally { h.dispose(); }
	});

	it("registers /roster and its text overview lists teams and agents", async () => {
		const h = harness();
		try {
			const roster = h.commands.get("roster");
			assert.ok(roster);
			await roster.handler("text", h.ctx);
			const text = (h.messages.at(-1) as { content: string }).content;
			assert.match(text, /^Roster/);
			assert.match(text, /- pair \(parallel, user\): reviewer, scout → subagent\(\{ workflow: "team\.pair"/);
			assert.match(text, /- scout ·/);
		} finally { h.dispose(); }
	});

	it("can be disabled by config", async () => {
		const { pi, handlers } = fakePi();
		const runtime = createRosterRuntime();
		const registration = registerRosterCommands(pi as never, { asyncJobs: new Map(), currentSessionId: "S1" } as never, { runtime, runCommand: async () => {}, openAgentAdmin: async () => {}, mentions: false });
		assert.equal(handlers.get("input"), undefined);
		registration.dispose();
	});
});
