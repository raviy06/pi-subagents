import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildActivityStatus } from "../../src/runs/shared/activity-status-projection.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function state(): SubagentState {
	return { currentSessionId: "S1", statusProjectionSessionId: "S1", foregroundControls: new Map(), foregroundRuns: new Map(), asyncJobs: new Map(), fleetJobs: new Map() } as unknown as SubagentState;
}
function foreground(id = "run-private", index = 0) {
	return { runId: id, sessionId: "S1", mode: "single", startedAt: 100, updatedAt: 300, currentAgent: "worker", currentIndex: index,
		activeChildren: new Map([[index, { index, agent: "worker", startedAt: 100, updatedAt: 300, currentTool: "read", inputTokens: 80, outputTokens: 20 }]]) } as any;
}
function asyncJob(id = "async-private") {
	return { asyncId: id, sessionId: "S1", status: "running", mode: "single", startedAt: 100,
		steps: [{ index: 0, agent: "worker", status: "running", startedAt: 100, currentTool: "bash", tokens: { input: 100, output: 30, total: 999 } }] } as any;
}

describe("public activity snapshot", () => {
	it("fails closed for unavailable/unrestored/foreign contexts, distinguishes available idle", () => {
		assert.equal(buildActivityStatus(undefined, "S1", 500).available, false);
		const s = state(); s.foregroundControls.set("foreign", { ...foreground(), sessionId: "S2" });
		assert.deepEqual(buildActivityStatus(s, "S1", 500).entries, []);
		assert.equal(buildActivityStatus(s, "S1", 500).available, true);
		assert.equal(buildActivityStatus(s, "S2", 500).available, false);
		s.statusProjectionSessionId = null;
		assert.equal(buildActivityStatus(s, "S1", 500).available, false);
	});
	it("foreground identity survives projection rebuilds and separates same-name children", () => {
		const s = state(); const control = foreground();
		control.activeChildren.set(1, { ...control.activeChildren.get(0), index: 1 });
		s.foregroundControls.set(control.runId, control);
		const a = buildActivityStatus(s, "S1", 500), b = buildActivityStatus(s, "S1", 700);
		assert.equal(a.entries.length, 2);
		assert.notEqual(a.entries[0].key, a.entries[1].key);
		assert.equal(a.entries[0].key, b.entries[0].key);
		assert.equal(a.entries[0].state, "running");
		assert.equal(a.entries[0].activity?.tool, "read");
		assert.equal(a.entries[0].elapsedMs, 400);
		assert.deepEqual(a.entries[0].usage, { input: 80, output: 20, source: "reported-own" });
		assert.ok(!JSON.stringify(a).includes("run-private"));
	});
	it("restored terminal foreground retains identity without inventing timing or split usage", () => {
		const s = state(); s.foregroundControls.set("r", foreground("r"));
		const key = buildActivityStatus(s, "S1", 500).entries[0].key;
		s.foregroundControls.clear();
		s.foregroundRuns!.set("r", { runId: "r", mode: "single", cwd: "/secret", sessionId: "S1", updatedAt: 500, children: [{ agent: "worker", index: 0, status: "completed", tokens: 100 }] });
		const row = buildActivityStatus(s, "S1", 9999).entries[0];
		assert.equal(row.key, key); assert.equal(row.state, "completed");
		assert.equal(row.elapsedMs, undefined); assert.equal(row.usage, undefined);
	});
	it("deduplicates live and remembered rows and workflow shells referencing a concrete child", () => {
		const s = state(); s.foregroundControls.set("leaf", foreground("leaf"));
		s.foregroundRuns!.set("leaf", { runId: "leaf", mode: "single", cwd: "/repo", sessionId: "S1", updatedAt: 500, children: [{ agent: "worker", index: 0, status: "completed" }] });
		s.asyncJobs.set("wf", { asyncId: "wf", sessionId: "S1", mode: "workflow", status: "running", steps: [{ agent: "worker", runId: "leaf", workflowKey: "implement", status: "running" }] } as any);
		const rows = buildActivityStatus(s, "S1", 600).entries;
		assert.equal(rows.length, 1); assert.equal(rows[0].state, "running");
	});
	it("async live state beats retained duplicates, freezes terminal time, omits aggregate fallback", () => {
		const s = state(), job = asyncJob(); s.asyncJobs.set(job.asyncId, job);
		s.fleetJobs!.set(job.asyncId, { ...job, status: "complete" });
		assert.equal(buildActivityStatus(s, "S1", 500).entries.length, 1);
		assert.deepEqual(buildActivityStatus(s, "S1", 500).entries[0].usage, { input: 100, output: 30, source: "reported-own" });
		job.steps[0] = { ...job.steps[0], status: "complete", endedAt: 400 };
		job.status = "complete";
		assert.equal(buildActivityStatus(s, "S1", 9000).entries[0].elapsedMs, 300);
		delete job.steps[0].tokens; job.totalTokens = { input: 999, output: 111, total: 1110 };
		assert.equal(buildActivityStatus(s, "S1", 9000).entries[0].usage, undefined);
	});
	it("maps stop and attention separately and never infers quiet agents are stalled", () => {
		const s = state(), job = asyncJob(); s.asyncJobs.set(job.asyncId, job);
		job.steps[0].activityState = "needs_attention"; job.steps[0].lastActivityAt = 101;
		let row = buildActivityStatus(s, "S1", 100000).entries[0];
		assert.equal(row.state, "running"); assert.equal(row.activity?.reason, "needs-attention");
		job.steps[0].stopRequested = true;
		assert.equal(buildActivityStatus(s, "S1", 100000).entries[0].state, "stopping");
		for (const [source, expected] of [["paused", "paused"], ["stopped", "stopped"], ["partial", "failed"], ["rejected", "failed"], ["pending", "queued"]]) {
			job.steps[0].stopRequested = false; job.steps[0].status = source;
			assert.equal(buildActivityStatus(s, "S1", 100000).entries[0].state, expected);
		}
	});
	it("includes nested children with parent identity and no aggregate usage", () => {
		const s = state(), control = foreground("parent");
		control.nestedChildren = [{ id: "nested", parentRunId: "parent", parentStepIndex: 0, depth: 1, path: [], state: "running", agent: "scout", startedAt: 200, currentTool: "read", totalTokens: { input: 999, output: 20 }, capabilityToken: "secret-token" }];
		s.foregroundControls.set("parent", control);
		const rows = buildActivityStatus(s, "S1", 500).entries;
		const parent = rows.find(r => r.agent === "worker")!, child = rows.find(r => r.agent === "scout")!;
		assert.equal(child.parentKey, parent.key); assert.equal(child.usage, undefined);
		assert.ok(!JSON.stringify(rows).includes("secret-token"));
	});
	it("repairs cyclic nested parent projections instead of emitting an invalid graph", () => {
		const s = state(), control = foreground("parent");
		control.nestedChildren = [{ id: "nested", parentRunId: "parent", parentStepIndex: 0, depth: 1, path: [], state: "running", agent: "scout", children: [
			{ id: "parent", parentRunId: "nested", depth: 2, path: [], state: "running", agent: "worker" },
		] }];
		s.foregroundControls.set("parent", control);
		const result = buildActivityStatus(s, "S1", 500);
		const rows = new Map(result.entries.map(row => [row.key, row]));
		for (const row of result.entries) {
			const seen = new Set([row.key]); let parent = row.parentKey;
			while (parent) { assert.ok(!seen.has(parent), "cycle must not escape projection"); seen.add(parent); parent = rows.get(parent)?.parentKey; }
		}
		assert.equal(result.incomplete, true);
	});
	it("does not export prompts, raw arguments, paths or unsafe labels", () => {
		const s = state(), job = asyncJob();
		Object.assign(job.steps[0], { description: "SECRET prompt", currentToolArgs: "SECRET args", currentPath: "/SECRET/path", label: "SECRET label", currentTool: "read\u001b]0;SECRET\u0007", agent: "worker\u202e" });
		s.asyncJobs.set(job.asyncId, job);
		const json = JSON.stringify(buildActivityStatus(s, "S1", 500));
		assert.ok(!json.includes("SECRET args") && !json.includes("SECRET label") && !json.includes("\u202e") && !json.includes("/SECRET"));
		assert.ok(json.includes("SECRET prompt"), "the task preview is on by default");
		const withoutTask = JSON.stringify(buildActivityStatus(s, "S1", 500, { taskPreview: false }));
		assert.ok(!withoutTask.includes("SECRET"), "taskPreview: false keeps every prompt-derived text out");
	});
	it("caps output and scan work and makes incomplete coverage explicit", () => {
		const s = state();
		for (let i = 0; i < 2000; i++) s.foregroundControls.set(`r${i}`, foreground(`r${i}`));
		const result = buildActivityStatus(s, "S1", 500);
		assert.ok(result.entries.length <= 64); assert.ok(result.incomplete);
		assert.ok(result.omitted.active > 0); assert.ok(result.omitted.scanTruncated);
		assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
	});

	it("carries task, startedAt and model facts on entries (fork additive fields)", () => {
		const s = state();
		s.asyncJobs.set("a", { asyncId: "a", sessionId: "S1", status: "running", mode: "single", startedAt: 100,
			steps: [{ index: 0, agent: "reviewer", status: "running", startedAt: 100, description: "  Review   " + "x".repeat(300), model: "openai/gpt-5-mini", requestedModel: "nope/none", fallbackReason: "unregistered", tokens: { input: 1, output: 2, total: 3 } }] } as any);
		s.foregroundControls.set("f", { ...foreground("f"), description: "Scan the tests" });
		const status = buildActivityStatus(s, "S1", 500);
		const job = status.entries.find((entry) => entry.agent === "reviewer");
		assert.ok(job);
		assert.equal(job.startedAt, 100);
		assert.ok(job.task!.startsWith("Review x"));
		assert.ok(job.task!.length <= 120);
		assert.deepEqual(job.model, { requested: "nope/none", effective: "openai/gpt-5-mini", fallbackReason: "unregistered" });
		const fg = status.entries.find((entry) => entry.key !== job.key);
		assert.ok(fg);
		assert.equal(fg.task, undefined, "active children do not inherit the control description");
		assert.equal(fg.startedAt, 100);
		assert.equal("model" in fg, false);
		assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 32768);
	});
});
