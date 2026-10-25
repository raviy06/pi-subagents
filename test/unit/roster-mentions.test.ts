import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mentionCompletions, resolveMention, type MentionCatalogue } from "../../src/roster/mentions.ts";

const catalogue: MentionCatalogue = {
	agents: ["scout", "reviewer", "worker", "code-review"],
	teams: ["review-pair", "spec-council"],
	liveRuns: [{ id: "run-1", agent: "scout" }, { id: "run-2", agent: "reviewer" }, { id: "run-3", agent: "reviewer" }],
};

describe("mention resolution", () => {
	it("routes @team to the team workflow and @agent to a launch", () => {
		assert.deepEqual(resolveMention("@review-pair look at the diff", catalogue), { kind: "team", name: "review-pair", task: "look at the diff" });
		assert.deepEqual(resolveMention("  @worker implement the fix\nwith tests", catalogue), { kind: "launch", agent: "worker", task: "implement the fix\nwith tests" });
	});

	it("steers the single live run of a mentioned agent, and reports ambiguity", () => {
		assert.deepEqual(resolveMention("@scout also check the RPC path", catalogue), { kind: "steer", agent: "scout", runId: "run-1", message: "also check the RPC path" });
		assert.deepEqual(resolveMention("@reviewer focus on tests", catalogue), { kind: "ambiguous", agent: "reviewer", runIds: ["run-2", "run-3"] });
	});

	it("leaves unknown handles, file paths, mid-text mentions and @main to the model", () => {
		assert.deepEqual(resolveMention("@src/index.ts explain this", catalogue), { kind: "none" });
		assert.deepEqual(resolveMention("@ghost do it", catalogue), { kind: "none" });
		assert.deepEqual(resolveMention("please ask @scout later", catalogue), { kind: "none" });
		assert.deepEqual(resolveMention("@main continue the plan", catalogue), { kind: "main", text: "continue the plan" });
		assert.deepEqual(resolveMention("@scout", catalogue), { kind: "empty", handle: "scout" });
		assert.deepEqual(resolveMention("", catalogue), { kind: "none" });
	});

	it("prefers a team over an agent with the same name", () => {
		assert.equal(resolveMention("@code-review x", { ...catalogue, teams: ["code-review"] }).kind, "team");
	});
});

describe("mention completions", () => {
	it("completes only a leading @token, teams first, then agents, then main", () => {
		const items = mentionCompletions(["@re"], 0, 3, catalogue);
		assert.ok(items);
		assert.deepEqual(items.items.map((item) => item.value), ["@review-pair", "@reviewer"]);
		assert.equal(items.prefix, "@re");
		const all = mentionCompletions(["@"], 0, 1, catalogue)!;
		assert.deepEqual(all.items.map((item) => item.value).slice(0, 2), ["@review-pair", "@spec-council"]);
		assert.ok(all.items.some((item) => item.value === "@main"));
		assert.equal(mentionCompletions(["ask @sc"], 0, 7, catalogue), null, "not at the start of the prompt");
		assert.equal(mentionCompletions(["@src/"], 0, 5, catalogue), null, "paths belong to the file picker");
		assert.equal(mentionCompletions(["@scout do"], 0, 9, catalogue), null, "cursor past the handle");
	});
});
