import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compileTeamScript,
	mergeTeamSets,
	parseTeams,
	teamResourceName,
	TEAM_RESOURCE_PREFIX,
	type TeamDefinition,
} from "../../src/roster/teams.ts";
import { validateWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

const where = "settings.json agentRoster.teams";

describe("roster team parsing", () => {
	it("parses the three built-in shapes with members, chair, passes and per-member model", () => {
		const teams = parseTeams({
			"review-pair": { shape: "parallel", members: [{ agent: "reviewer" }, { agent: "evidence-auditor", model: "anthropic/claude-opus-5-5:high" }] },
			"spec-council": { shape: "council", description: "Spec critique", chair: { agent: "oracle", model: "devaigateway/gpt-6-astra:high" }, members: ["karl-popper", { agent: "amos-tversky" }], passes: 2 },
			"ship": { shape: "pipeline", members: [{ agent: "worker" }, { agent: "reviewer" }] },
		}, where);
		assert.deepEqual(Object.keys(teams).sort(), ["review-pair", "ship", "spec-council"]);
		assert.deepEqual(teams["review-pair"], { name: "review-pair", shape: "parallel", members: [{ agent: "reviewer" }, { agent: "evidence-auditor", model: "anthropic/claude-opus-5-5:high" }] });
		assert.deepEqual(teams["spec-council"], {
			name: "spec-council", shape: "council", description: "Spec critique",
			chair: { agent: "oracle", model: "devaigateway/gpt-6-astra:high" },
			members: [{ agent: "karl-popper" }, { agent: "amos-tversky" }], passes: 2,
		});
	});

	it("rejects malformed teams with the settings path in the message", () => {
		assert.throws(() => parseTeams({ "Bad Name": { shape: "parallel", members: ["a"] } }, where), /agentRoster\.teams.*'Bad Name'.*name/);
		assert.throws(() => parseTeams({ t: { shape: "circle", members: ["a"] } }, where), /shape/);
		assert.throws(() => parseTeams({ t: { shape: "parallel", members: [] } }, where), /at least one member/);
		assert.throws(() => parseTeams({ t: { shape: "council", members: ["a", "b"] } }, where), /council.*chair/);
		assert.throws(() => parseTeams({ t: { shape: "council", chair: "c", members: ["a"] } }, where), /council.*two members/);
		assert.throws(() => parseTeams({ t: { shape: "parallel", members: ["a"], passes: 9 } }, where), /passes/);
		assert.throws(() => parseTeams({ t: { shape: "parallel", members: new Array(9).fill("a") } }, where), /at most 8/);
		assert.throws(() => parseTeams({ t: { shape: "parallel", members: ["a"], extra: 1 } }, where), /unknown field 'extra'/);
		assert.deepEqual(parseTeams(undefined, where), {});
	});

	it("merges user and project teams with project winning by name", () => {
		const user = parseTeams({ a: { shape: "parallel", members: ["x"] }, b: { shape: "parallel", members: ["y"] } }, "user");
		const project = parseTeams({ b: { shape: "pipeline", members: ["z"] } }, "project");
		const merged = mergeTeamSets(user, project);
		assert.deepEqual(Object.keys(merged).sort(), ["a", "b"]);
		assert.equal(merged.b?.shape, "pipeline");
		assert.equal(merged.b?.source, "project");
		assert.equal(merged.a?.source, "user");
	});

	it("names resources with a stable prefix", () => {
		assert.equal(teamResourceName("spec-council"), `${TEAM_RESOURCE_PREFIX}spec-council`);
	});
});

describe("roster team compilation", () => {
	const check = (team: TeamDefinition, task = "Audit the auth module") => {
		const script = compileTeamScript(team, { task });
		const validation = validateWorkflowScript(script);
		assert.ok(validation.ok, `script must validate: ${JSON.stringify(validation.errors)}\n${script}`);
		return script;
	};

	it("parallel: one runs.all batch with literal keys, per-member model and a shaped return", () => {
		const script = check({ name: "review-pair", shape: "parallel", members: [{ agent: "reviewer" }, { agent: "evidence-auditor", model: "anthropic/claude-opus-5-5:high" }] });
		assert.match(script, /runs\.all\(\[/);
		assert.match(script, /key: "reviewer"/);
		assert.match(script, /key: "evidence-auditor", agent: "evidence-auditor", model: "anthropic\/claude-opus-5-5:high"/);
		assert.match(script, /team: "review-pair", shape: "parallel"/);
		assert.equal((script.match(/runs\.run\(/g) ?? []).length, 0);
	});

	it("pipeline: sequential runs.run steps feeding the previous output forward", () => {
		const script = check({ name: "ship", shape: "pipeline", members: [{ agent: "worker" }, { agent: "reviewer" }] });
		const first = script.indexOf('runs.run("worker"');
		const second = script.indexOf('runs.run("reviewer"');
		assert.ok(first > 0 && second > first, "steps appear in member order");
		assert.match(script, /Previous stage/);
	});

	it("council: members in parallel, chair synthesis, bounded cross-exam passes via resume with fresh fallback", () => {
		const script = check({ name: "spec-council", shape: "council", chair: { agent: "oracle" }, members: [{ agent: "karl-popper" }, { agent: "amos-tversky" }], passes: 2 });
		assert.match(script, /runs\.all\(\[/);
		assert.match(script, /runs\.run\("chair-1"/);
		assert.match(script, /runs\.run\("chair-2"/);
		assert.match(script, /resume: /, "pass 2 resumes retained advisors");
		assert.match(script, /agent: "karl-popper"/, "fresh fallback when a member is not resumable");
		assert.doesNotMatch(script, /chair-3/);
		assert.match(script, /memo: /);
	});

	it("escapes member names, models and the task safely", () => {
		const script = compileTeamScript({ name: "t", shape: "parallel", members: [{ agent: 'we"ird' }] }, { task: 'say "hi"\n${x}' });
		assert.match(script, /agent: "we\\"ird"/);
		assert.match(script, /args\.task/);
		assert.doesNotMatch(script, /\$\{x\}/);
	});

	it("duplicate member agents get distinct keys", () => {
		const script = check({ name: "dup", shape: "parallel", members: [{ agent: "reviewer" }, { agent: "reviewer", model: "a/b" }] });
		assert.match(script, /key: "reviewer"/);
		assert.match(script, /key: "reviewer-2"/);
	});
});
