import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTeamAddArgs, renderRosterOverview, renderTeam, rosterRowsFromCapabilities } from "../../src/roster/overview.ts";
import type { AgentCapabilitiesSnapshot } from "../../src/shared/types.ts";

const snapshot: AgentCapabilitiesSnapshot = {
	restrictedCount: 0,
	disabledCount: 1,
	agents: [
		{ name: "scout", description: "Recon", source: "builtin", executable: true, runner: { type: "pi" }, tools: { ambient: false, names: ["read"], mcpDirectTools: [] }, model: { value: "devaigateway/gpt-6-sol:high", fallbacks: ["anthropic/claude-sonnet-5:medium"] }, provenance: { filePath: "/pkg/agents/scout.md", override: { scope: "user", path: "/home/.pi/agent/settings.json", fields: ["fallbacks", "model"] } } },
		{ name: "reviewer", description: "Review", source: "builtin", executable: true, runner: { type: "pi" }, tools: { ambient: true, names: [], mcpDirectTools: [] } },
		{ name: "auditor", description: "Audit", source: "project", executable: true, runner: { type: "pi" }, tools: { ambient: true, names: [], mcpDirectTools: [] }, model: { value: "anthropic/claude-opus-5-5:high", thinking: "high" }, provenance: { filePath: "/proj/.pi/agents/auditor.md" } },
		{ name: "worker", description: "Work", source: "builtin", executable: false, disabled: true, runner: { type: "pi" }, tools: { ambient: true, names: [], mcpDirectTools: [] } },
		{ name: "cc", description: "Claude Code", source: "builtin", executable: false, restrictionSources: ["ceiling"], runner: { type: "external-cli", command: "claude", available: false, capabilities: {} as never }, tools: { ambient: true, names: [], mcpDirectTools: [] } },
	],
};

describe("roster overview", () => {
	it("turns capability rows into roster rows with model chain, flags and provenance", () => {
		const rows = rosterRowsFromCapabilities(snapshot);
		const scout = rows.find((row) => row.name === "scout")!;
		assert.equal(scout.modelChain, "devaigateway/gpt-6-sol:high → anthropic/claude-sonnet-5:medium");
		assert.deepEqual(scout.flags, ["user override: fallbacks, model"]);
		const reviewer = rows.find((row) => row.name === "reviewer")!;
		assert.equal(reviewer.modelChain, "inherit");
		const worker = rows.find((row) => row.name === "worker")!;
		assert.deepEqual(worker.flags, ["disabled"]);
		const cc = rows.find((row) => row.name === "cc")!;
		assert.deepEqual(cc.flags, ["restricted", "external-cli: claude (unavailable)"]);
	});

	it("renders agents grouped by source and teams with members, chair and source", () => {
		const text = renderRosterOverview({
			rows: rosterRowsFromCapabilities(snapshot),
			teams: {
				"spec-council": { name: "spec-council", shape: "council", chair: { agent: "oracle", model: "x/y" }, members: [{ agent: "karl-popper" }, { agent: "amos-tversky", model: "a/b" }], passes: 2, source: "user" },
				pair: { name: "pair", shape: "parallel", members: [{ agent: "reviewer" }, { agent: "auditor" }], source: "project" },
			},
			diagnostics: [{ scope: "project", path: "/proj/.pi/settings.json", error: "team 'bad' has invalid 'shape'" }],
			registered: ["spec-council", "pair"],
			warnings: ["Team 'pair' names unknown agents: ghost"],
		});
		assert.match(text, /^Roster/m);
		assert.match(text, /Project agents\n- auditor .*anthropic\/claude-opus-5-5:high.*thinking: high/);
		assert.match(text, /Builtin agents\n(?:.*\n)*- scout .*devaigateway\/gpt-6-sol:high → anthropic\/claude-sonnet-5:medium/);
		assert.match(text, /- worker .*\[disabled\]/);
		assert.match(text, /Teams\n- pair \(parallel, project\): reviewer, auditor → subagent\(\{ workflow: "team\.pair", args: \{ task \} \}\)/);
		assert.match(text, /- spec-council \(council, user, 2 passes\): chair oracle \(x\/y\); karl-popper, amos-tversky \(a\/b\)/);
		assert.match(text, /Warnings\n- Team 'pair' names unknown agents: ghost/);
		assert.match(text, /Roster settings problems\n- project \/proj\/\.pi\/settings\.json: team 'bad'/);
		assert.match(text, /\/roster team add/);
	});

	it("renders one team with its compiled script", () => {
		const text = renderTeam({ name: "pair", shape: "parallel", members: [{ agent: "reviewer" }, { agent: "auditor" }], source: "project" });
		assert.match(text, /Team pair/);
		assert.match(text, /runs\.all\(\[/);
	});

	it("parses team add arguments", () => {
		assert.deepEqual(parseTeamAddArgs(["pair", "parallel", "reviewer,auditor"]), { ok: true, scope: "user", team: { name: "pair", shape: "parallel", members: [{ agent: "reviewer" }, { agent: "auditor" }] } });
		assert.deepEqual(parseTeamAddArgs(["sc", "council", "a,b=x/y", "--chair", "oracle=p/q", "--passes", "3", "--project", "--description", "Spec critique"]), {
			ok: true, scope: "project",
			team: { name: "sc", shape: "council", description: "Spec critique", members: [{ agent: "a" }, { agent: "b", model: "x/y" }], chair: { agent: "oracle", model: "p/q" }, passes: 3 },
		});
		assert.equal(parseTeamAddArgs(["sc", "council", "a,b"]).ok, false, "council without chair");
		assert.equal(parseTeamAddArgs(["x"]).ok, false);
		assert.match((parseTeamAddArgs(["x", "triangle", "a"]) as { ok: false; message: string }).message, /shape/);
	});
});
