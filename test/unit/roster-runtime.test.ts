import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRosterRuntime } from "../../src/roster/runtime.ts";
import type { RosterSettings } from "../../src/roster/settings.ts";

const settings = (teams: RosterSettings["teams"], diagnostics: RosterSettings["diagnostics"] = []): RosterSettings => ({ teams, userPath: "/u", projectPath: "/p", diagnostics });

describe("roster runtime", () => {
	it("registers on bind, re-registers on refresh, and disposes", () => {
		const calls: Array<{ sessionId: string; names: string[]; known?: readonly string[] }> = [];
		let disposed = 0;
		let current = settings({ a: { name: "a", shape: "parallel", members: [{ agent: "x" }] } });
		const runtime = createRosterRuntime({
			read: () => current,
			register: (input) => {
				calls.push({ sessionId: input.sessionId, names: Object.keys(input.teams), known: input.knownAgents });
				return { registered: Object.keys(input.teams), warnings: [], dispose: () => { disposed++; } };
			},
		});
		const bound = runtime.bind({ sessionId: "S1", cwd: "/repo", knownAgents: ["x"] });
		assert.deepEqual(bound.registered, ["a"]);
		assert.deepEqual(calls, [{ sessionId: "S1", names: ["a"], known: ["x"] }]);

		current = settings({ a: { name: "a", shape: "parallel", members: [{ agent: "x" }] }, b: { name: "b", shape: "pipeline", members: [{ agent: "y" }] } }, [{ scope: "project", path: "/p", error: "bad" }]);
		const refreshed = runtime.refresh();
		assert.equal(disposed, 1, "previous registration disposed before re-registering");
		assert.deepEqual(refreshed.registered, ["a", "b"]);
		assert.deepEqual(refreshed.warnings, ["project /p: bad"]);

		runtime.dispose();
		assert.equal(disposed, 2);
		assert.equal(runtime.state().sessionId, null);
	});

	it("does not register without a session id or teams, and survives a read failure", () => {
		let registerCalls = 0;
		const runtime = createRosterRuntime({ read: () => settings({}), register: () => { registerCalls++; return { registered: [], warnings: [], dispose() {} }; } });
		runtime.bind({ sessionId: undefined, cwd: "/repo" });
		runtime.refresh();
		assert.equal(registerCalls, 0);
		const failing = createRosterRuntime({ read: () => { throw new Error("boom"); } });
		const state = failing.bind({ sessionId: "S", cwd: "/repo" });
		assert.equal(state.settings, null);
		assert.match(state.warnings[0]!, /boom/);
	});
});
