import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { RosterComponent, type RosterComponentData, type RosterResult } from "../../src/roster/tui.ts";

initTheme("dark");

const data: RosterComponentData = {
	agents: [
		{ name: "scout", source: "builtin", description: "Recon", modelChain: "openai/gpt-5-mini:high → anthropic/claude-sonnet-4", thinking: "high", flags: ["user override: model"] },
		{ name: "auditor", source: "project", description: "Audit", modelChain: "anthropic/claude-opus-4", flags: [] },
		{ name: "worker", source: "builtin", description: "Work", modelChain: "inherit", flags: ["disabled"] },
	],
	models: {
		rows: [{ id: "openai/gpt-5-mini", provider: "openai", primary: ["scout"], fallback: [], inScope: false }, { id: "anthropic/claude-sonnet-4", provider: "anthropic", primary: [], fallback: ["scout"], inScope: true }],
		inherit: ["worker"], unregistered: [{ id: "nope/none", agents: ["x"], role: "primary" }], outOfScope: [{ id: "openai/gpt-5-mini", agents: ["scout"] }],
		willFallBack: [{ agent: "scout", from: "openai/gpt-5-mini:high", to: "anthropic/claude-sonnet-4", reason: "out-of-scope" }],
	},
	teams: [
		{ team: { name: "pair", shape: "parallel", members: [{ agent: "scout" }, { agent: "auditor" }], source: "user" }, registered: true },
		{ team: { name: "council", shape: "council", chair: { agent: "oracle" }, members: [{ agent: "a" }, { agent: "b" }], passes: 2, source: "project" }, registered: false },
	],
	runs: [
		{ key: "k1", agent: "scout", state: "running", task: "Map the auth flow", elapsedMs: 65_000, model: { effective: "anthropic/claude-sonnet-4", requested: "openai/gpt-5-mini:high", fallbackReason: "out-of-scope" } },
		{ key: "k2", agent: "reviewer", state: "completed", elapsedMs: 2_000 },
	],
	warnings: ["Team 'council' names unknown agents: a, b"],
};

function harness(initialTab?: RosterComponentData["initialTab"]) {
	const results: RosterResult[] = [];
	const component = new RosterComponent(
		{ requestRender() {} } as never,
		{ fg(_color: string, text: string) { return text; }, bold(text: string) { return text; } } as never,
		{ matches(key: string, binding: string) { return key === binding; } } as never,
		{ ...data, ...(initialTab ? { initialTab } : {}), done: (result) => results.push(result) },
	);
	return { component, results, text: () => component.render(120).join("\n") };
}

describe("RosterComponent", () => {
	it("opens on Agents, shows tabs and rows with model chain, and confirms the selected agent", () => {
		const { component, results, text } = harness();
		assert.match(text(), /\[Agents\].*Models.*Teams.*Runs/);
		assert.match(text(), /auditor .*anthropic\/claude-opus-4/);
		assert.match(text(), /scout .*openai\/gpt-5-mini:high → anthropic\/claude-sonnet-4.*high/);
		assert.match(text(), /worker .*disabled/);
		component.handleInput("tui.select.down");
		component.handleInput("tui.select.confirm");
		assert.deepEqual(results, [{ kind: "agent", name: "scout" }]);
	});

	it("switches tabs with Tab / arrows and surfaces model problems before launch", () => {
		const { component, results, text } = harness();
		component.handleInput("\t");
		assert.match(text(), /Agents.*\[Models\]/);
		assert.match(text(), /anthropic\/claude-sonnet-4 .*fallback: scout/);
		assert.match(text(), /openai\/gpt-5-mini .*primary: scout.*out of scope/);
		assert.match(text(), /unregistered: nope\/none \(x\)/);
		assert.match(text(), /scout: openai\/gpt-5-mini:high → anthropic\/claude-sonnet-4 \(out-of-scope\)/);
		assert.match(text(), /inherit: worker/);
		component.handleInput("tui.select.confirm");
		assert.deepEqual(results.at(-1), { kind: "model", id: "openai/gpt-5-mini" });
		component.handleInput("\x1b[C");
		assert.match(text(), /\[Teams\]/);
		assert.match(text(), /council .*not registered/);
		component.handleInput("tui.select.down");
		component.handleInput("tui.select.confirm");
		assert.deepEqual(results.at(-1), { kind: "team", name: "council" });
		component.handleInput("\x1b[C");
		assert.match(text(), /\[Runs\]/);
		assert.match(text(), /scout .*running.*Map the auth flow.*1m05s.*↷ anthropic\/claude-sonnet-4 \(out-of-scope\)/);
		component.handleInput("tui.select.confirm");
		assert.deepEqual(results.at(-1), { kind: "run", key: "k1" });
		component.handleInput("\x1b[D");
		assert.match(text(), /\[Teams\]/);
		component.handleInput("\x1b[Z");
		assert.match(text(), /\[Models\]/);
	});

	it("filters within the active tab, offers add on Teams, and cancels", () => {
		const { component, results, text } = harness("teams");
		assert.match(text(), /\[Teams\]/);
		for (const char of "coun") component.handleInput(char);
		assert.doesNotMatch(text(), /- pair/);
		assert.match(text(), /council/);
		component.handleInput("tui.select.cancel");
		assert.deepEqual(results.at(-1), { kind: "cancel" });
		const fresh = harness("teams");
		fresh.component.handleInput("a");
		assert.match(fresh.text(), /Add a team/);
		// "a" matches both teams; the add row is pinned first.
		fresh.component.handleInput("tui.select.confirm");
		assert.deepEqual(fresh.results.at(-1), { kind: "team-add" });
	});

	it("shows warnings and renders empty tabs without rows", () => {
		const { text, component } = harness("runs");
		assert.match(text(), /Team 'council' names unknown agents/);
		const empty = new RosterComponent({ requestRender() {} } as never, { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never, { matches: (k: string, b: string) => k === b } as never, { agents: [], models: { rows: [], inherit: [], unregistered: [], outOfScope: [], willFallBack: [] }, teams: [], runs: [], warnings: [], initialTab: "runs", done() {} });
		assert.match(empty.render(100).join("\n"), /No active or recent runs/);
		component.handleInput("tui.select.up");
		component.handleInput("tui.select.confirm");
	});
});
