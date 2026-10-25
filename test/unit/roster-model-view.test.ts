import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildModelView } from "../../src/roster/model-view.ts";
import type { RosterRow } from "../../src/roster/overview.ts";

const row = (name: string, chain: string, source: RosterRow["source"] = "builtin"): RosterRow => ({ name, source, description: name, modelChain: chain, flags: [] });
const models = [
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	{ provider: "anthropic", id: "claude-opus-4", fullId: "anthropic/claude-opus-4" },
];

describe("roster model view", () => {
	it("lists registry models with their primary and fallback assignments", () => {
		const view = buildModelView({
			models,
			agents: [row("scout", "openai/gpt-5-mini:high → anthropic/claude-sonnet-4"), row("reviewer", "anthropic/claude-sonnet-4"), row("worker", "inherit")],
		});
		const mini = view.rows.find((entry) => entry.id === "openai/gpt-5-mini")!;
		assert.deepEqual(mini.primary, ["scout"]);
		assert.deepEqual(mini.fallback, []);
		const sonnet = view.rows.find((entry) => entry.id === "anthropic/claude-sonnet-4")!;
		assert.deepEqual(sonnet.primary, ["reviewer"]);
		assert.deepEqual(sonnet.fallback, ["scout"]);
		assert.equal(view.rows.find((entry) => entry.id === "anthropic/claude-opus-4")!.primary.length, 0);
		assert.deepEqual(view.unregistered, []);
		assert.equal(view.rows.every((entry) => entry.inScope === undefined), true, "no scope configured");
		assert.deepEqual(view.inherit, ["worker"]);
	});

	it("flags assigned models that are unregistered or outside an enforced scope before any launch fails", () => {
		const view = buildModelView({
			models,
			agents: [row("scout", "nope/none → anthropic/claude-sonnet-4"), row("auditor", "openai/gpt-5-mini", "project")],
			modelScope: { enforce: true, allow: ["anthropic/*"] },
		});
		assert.deepEqual(view.unregistered, [{ id: "nope/none", agents: ["scout"], role: "primary" }]);
		assert.equal(view.rows.find((entry) => entry.id === "openai/gpt-5-mini")!.inScope, false);
		assert.equal(view.rows.find((entry) => entry.id === "anthropic/claude-sonnet-4")!.inScope, true);
		assert.deepEqual(view.outOfScope, [{ id: "openai/gpt-5-mini", agents: ["auditor"] }]);
		// Primary unregistered but a registered in-scope fallback exists: the launch will fall back, which the view says.
		assert.deepEqual(view.willFallBack, [{ agent: "scout", from: "nope/none", to: "anthropic/claude-sonnet-4", reason: "unregistered" }]);
	});

	it("sorts assigned models first, then by id", () => {
		const view = buildModelView({ models, agents: [row("a", "anthropic/claude-opus-4")] });
		assert.deepEqual(view.rows.map((entry) => entry.id), ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "openai/gpt-5-mini"]);
	});
});
