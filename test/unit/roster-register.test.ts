import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerTeamResources } from "../../src/roster/register.ts";
import { teamResourceName, type TeamSet } from "../../src/roster/teams.ts";
import { resolveWorkflowResource } from "../../src/workflows/workflow-resources.ts";

const teams: TeamSet = {
	pair: { name: "pair", shape: "parallel", members: [{ agent: "reviewer" }, { agent: "scout" }], source: "user" },
	ship: { name: "ship", shape: "pipeline", members: [{ agent: "worker" }, { agent: "ghost" }], source: "project" },
};

describe("roster team resources", () => {
	it("registers one team.<name> resource per team for the session and resolves args into a script", () => {
		const registration = registerTeamResources({ sessionId: "S-register-1", teams, knownAgents: ["reviewer", "scout", "worker"] });
		try {
			assert.deepEqual(registration.registered.sort(), ["pair", "ship"]);
			assert.deepEqual(registration.warnings, [`Team 'ship' names unknown agents: ghost`]);
			const resolved = resolveWorkflowResource(teamResourceName("pair"), { task: "Review the diff" }, "S-register-1");
			assert.ok(resolved.ok, JSON.stringify(resolved));
			assert.match(resolved.resource.script, /runs\.all\(\[/);
			assert.match(resolved.resource.script, /agent: "reviewer"/);
			assert.equal(resolved.resource.permit.hostCommands?.length ?? 0, 0, "teams never grant host authority");

			const rejected = resolveWorkflowResource(teamResourceName("pair"), { task: "" }, "S-register-1");
			assert.equal(rejected.ok, false);
			assert.match((rejected as { error: string }).error, /task/);
			const extra = resolveWorkflowResource(teamResourceName("pair"), { task: "x", cwd: "/" }, "S-register-1");
			assert.equal(extra.ok, false);
			assert.equal(resolveWorkflowResource(teamResourceName("pair"), { task: "x" }, "S-other").ok, false, "scoped to the session");
		} finally {
			registration.dispose();
		}
		assert.equal(resolveWorkflowResource(teamResourceName("pair"), { task: "x" }, "S-register-1").ok, false, "disposed");
	});

	it("re-registering the same session replaces the previous set", () => {
		const first = registerTeamResources({ sessionId: "S-register-2", teams });
		first.dispose();
		const second = registerTeamResources({ sessionId: "S-register-2", teams: { pair: teams.pair! } });
		try {
			assert.deepEqual(second.registered, ["pair"]);
			assert.equal(resolveWorkflowResource(teamResourceName("ship"), { task: "x" }, "S-register-2").ok, false);
		} finally {
			second.dispose();
		}
	});

	it("skips a team whose name collides with a registered resource and reports it", () => {
		const first = registerTeamResources({ sessionId: "S-register-3", teams: { pair: teams.pair! } });
		try {
			const dup = registerTeamResources({ sessionId: "S-register-3", teams: { pair: teams.pair! } });
			assert.deepEqual(dup.registered, []);
			assert.equal(dup.warnings.length, 1);
			assert.match(dup.warnings[0]!, /already registered/);
			dup.dispose();
		} finally {
			first.dispose();
		}
	});
});
