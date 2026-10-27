import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVITY_CHANGED_EVENT } from "../../src/runs/shared/activity-change-notifier.ts";
import { registerActivityFoundations } from "../../src/runs/shared/activity-foundations.ts";
import { RUN_RECORD_ENTRY_TYPE } from "../../src/runs/shared/run-record-entry.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CHILD_STATUS_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_JOBS_CHANGED_EVENT,
	SUBAGENT_PROCESS_TERMINAL_EVENT,
	type SubagentState,
} from "../../src/shared/types.ts";

class FakeEvents {
	handlers = new Map<string, Set<(data: unknown) => void>>();
	emitted: Array<{ event: string; data: unknown }> = [];
	on(event: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}
	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		for (const handler of this.handlers.get(event) ?? []) handler(data);
	}
}

function state(overrides: Partial<SubagentState> = {}): SubagentState {
	return {
		currentSessionId: "S1",
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		...overrides,
	} as unknown as SubagentState;
}

function harness(s = state()) {
	const events = new FakeEvents();
	const entries: Array<{ type: string; data: unknown }> = [];
	let clock = 1_000;
	const timers: Array<() => void> = [];
	const registration = registerActivityFoundations({
		events,
		state: s,
		appendEntry: (type, data) => entries.push({ type, data }),
		now: () => clock,
		setTimer: ((fn: () => void) => { timers.push(fn); return 1 as unknown as NodeJS.Timeout; }) as typeof setTimeout,
		clearTimer: (() => { timers.length = 0; }) as typeof clearTimeout,
	});
	return { events, entries, registration, flush: () => { const pending = timers.splice(0); pending.forEach((fn) => fn()); }, advance: (ms: number) => { clock += ms; } };
}

describe("registerActivityFoundations", () => {
	it("coalesces lifecycle events into one activity-changed notification per window", () => {
		const h = harness();
		for (const event of [SUBAGENT_CHILD_STATUS_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_PROCESS_TERMINAL_EVENT, SUBAGENT_CHILD_STATUS_EVENT]) h.events.emit(event, { id: "x" });
		assert.equal(h.events.emitted.filter((e) => e.event === ACTIVITY_CHANGED_EVENT).length, 0);
		h.flush();
		const changed = h.events.emitted.filter((e) => e.event === ACTIVITY_CHANGED_EVENT);
		assert.equal(changed.length, 1);
		assert.deepEqual(changed[0]!.data, { version: 1, revision: 1, generatedAt: 1_000 });
		h.registration.dispose();
		h.events.emit(SUBAGENT_CHILD_STATUS_EVENT, { id: "y" });
		h.flush();
		assert.equal(h.events.emitted.filter((e) => e.event === ACTIVITY_CHANGED_EVENT).length, 1);
	});

	it("folds the upstream jobs-changed hint into the coalesced activity-changed event", () => {
		const h = harness();
		h.events.emit(SUBAGENT_JOBS_CHANGED_EVENT, { version: 1 });
		h.events.emit(SUBAGENT_JOBS_CHANGED_EVENT, { version: 1 });
		h.flush();
		const changed = h.events.emitted.filter((e) => e.event === ACTIVITY_CHANGED_EVENT);
		assert.equal(changed.length, 1);
		assert.deepEqual(changed[0]!.data, { version: 1, revision: 1, generatedAt: 1_000 });
		h.registration.dispose();
	});

	it("appends one durable record for a top-level async completion using job facts", () => {
		const s = state();
		s.asyncJobs.set("run-1", {
			asyncId: "run-1", asyncDir: "/tmp/run-1", status: "complete", sessionId: "S1", description: "  Review   the auth module  ",
			startedAt: 500, steps: [{ index: 0, agent: "reviewer", status: "completed", model: "openai/gpt-5-mini" }],
			totalTokens: { input: 120, output: 30, total: 150 },
		} as never);
		const h = harness(s);
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "run-1", runId: "run-1", sessionId: "S1", agent: "reviewer", state: "complete", success: true, timestamp: 1_000 });
		assert.equal(h.entries.length, 1);
		assert.equal(h.entries[0]!.type, RUN_RECORD_ENTRY_TYPE);
		assert.deepEqual(h.entries[0]!.data, {
			version: 1, runId: "run-1", agent: "reviewer", task: "Review the auth module", state: "completed",
			startedAt: 500, endedAt: 1_000, durationMs: 500, model: { effective: "openai/gpt-5-mini" }, usage: { input: 120, output: 30 },
		});
		// Same run reported again (retry, re-delivery) is not recorded twice.
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "run-1", runId: "run-1", sessionId: "S1", agent: "reviewer", state: "complete", success: true, timestamp: 1_001 });
		assert.equal(h.entries.length, 1);
	});

	it("records foreground completions from the run control and skips workflow-owned or foreign-session runs", () => {
		const s = state();
		s.foregroundControls.set("fg-1", { runId: "fg-1", sessionId: "S1", mode: "single", startedAt: 700, updatedAt: 900, description: "Scan tests", inputTokens: 10, outputTokens: 5 } as never);
		const h = harness(s);
		h.events.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, { id: "fg-1:0", runId: "fg-1", source: "foreground", agent: "scout", success: false, state: "failed", timestamp: 950, sessionId: "S1", taskIndex: 0 });
		assert.equal(h.entries.length, 1);
		assert.deepEqual(h.entries[0]!.data, { version: 1, runId: "fg-1", agent: "scout", task: "Scan tests", state: "failed", startedAt: 700, endedAt: 950, durationMs: 250, usage: { input: 10, output: 5 } });

		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "wf-child", runId: "wf-child", sessionId: "S1", agent: "worker", state: "complete", success: true, awaitedByWorkflow: true, parentWorkflowRunId: "wf" });
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "other", runId: "other", sessionId: "S2", agent: "worker", state: "complete", success: true });
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "nested", runId: "nested", sessionId: "S1", agent: "worker", state: "complete", success: true, parentWorkflowRunId: "wf" });
		assert.equal(h.entries.length, 1, "workflow-owned and foreign-session completions are not top-level records");
	});

	it("never throws when appendEntry fails", () => {
		const events = new FakeEvents();
		registerActivityFoundations({ events, state: state(), appendEntry: () => { throw new Error("no session"); } });
		assert.doesNotThrow(() => events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "r", runId: "r", sessionId: "S1", agent: "a", state: "complete", success: true }));
	});
});
