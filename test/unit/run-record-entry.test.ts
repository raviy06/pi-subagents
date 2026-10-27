import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RUN_RECORD_ENTRY_TYPE,
	RUN_RECORD_TASK_LIMIT,
	RUN_RECORD_VERSION,
	buildRunRecord,
	runRecordStateFromStatus,
} from "../../src/runs/shared/run-record-entry.ts";
import { PROMPT_REDACTED } from "../../src/shared/utils.ts";

describe("run-record-entry constants", () => {
	it("exposes the entry type, version, and task limit", () => {
		assert.equal(RUN_RECORD_ENTRY_TYPE, "subagents:record");
		assert.equal(RUN_RECORD_VERSION, 1);
		assert.equal(RUN_RECORD_TASK_LIMIT, 200);
	});
});

describe("runRecordStateFromStatus", () => {
	const table: Array<[string | undefined, string]> = [
		["complete", "completed"],
		["completed", "completed"],
		["failed", "failed"],
		["partial", "partial"],
		["stopped", "stopped"],
		["rejected", "rejected"],
		["running", "unknown"],
		["pending", "unknown"],
		["", "unknown"],
		[undefined, "unknown"],
	];
	for (const [status, expected] of table) {
		it(`maps ${JSON.stringify(status)} to ${expected}`, () => {
			assert.equal(runRecordStateFromStatus(status), expected);
		});
	}
});

describe("buildRunRecord", () => {
	it("builds the full shape for a completed job", () => {
		const record = buildRunRecord({
			runId: "run-1",
			agent: "worker",
			handle: "h-1",
			task: "Implement the thing",
			status: "complete",
			startedAt: 1_000,
			endedAt: 4_500,
			model: { requested: "sonnet", effective: "haiku", fallbackReason: "quota" },
			usage: { input: 120, output: 34 },
			workflowRunId: "wf-9",
			missionId: "m-2",
		});
		assert.deepEqual(record, {
			version: 1,
			runId: "run-1",
			agent: "worker",
			handle: "h-1",
			task: "Implement the thing",
			state: "completed",
			startedAt: 1_000,
			endedAt: 4_500,
			durationMs: 3_500,
			model: { requested: "sonnet", effective: "haiku", fallbackReason: "quota" },
			usage: { input: 120, output: 34 },
			workflowRunId: "wf-9",
			missionId: "m-2",
		});
	});

	it("drops the prompt-redaction placeholder instead of recording it as a task", () => {
		assert.equal("task" in buildRunRecord({ runId: "r", task: PROMPT_REDACTED }), false);
		assert.equal("task" in buildRunRecord({ runId: "r", task: `  ${PROMPT_REDACTED} ` }), false);
	});

	it("truncates long tasks to exactly the limit ending with an ellipsis", () => {
		const record = buildRunRecord({ runId: "r", task: "x".repeat(RUN_RECORD_TASK_LIMIT + 50) });
		assert.equal(record.task?.length, RUN_RECORD_TASK_LIMIT);
		assert.ok(record.task?.endsWith("…"));
		assert.equal(record.task, `${"x".repeat(RUN_RECORD_TASK_LIMIT - 1)}…`);
	});

	it("does not truncate a task exactly at the limit", () => {
		const task = "y".repeat(RUN_RECORD_TASK_LIMIT);
		assert.equal(buildRunRecord({ runId: "r", task }).task, task);
	});

	it("collapses whitespace in the task", () => {
		const record = buildRunRecord({ runId: "r", task: "  fix \n\n the\t\tbug   now  " });
		assert.equal(record.task, "fix the bug now");
	});

	it("omits optional keys that are missing or invalid and defaults agent to unknown", () => {
		const record = buildRunRecord({
			runId: "r",
			task: "   ",
			handle: "",
			model: { requested: "", effective: undefined },
			usage: { input: 10 },
			workflowRunId: undefined,
		});
		assert.deepEqual(record, { version: 1, runId: "r", agent: "unknown", state: "unknown" });
		assert.ok(!("task" in record));
		assert.ok(!("handle" in record));
		assert.ok(!("model" in record));
		assert.ok(!("usage" in record));
		assert.ok(!("startedAt" in record));
		assert.ok(!("endedAt" in record));
		assert.ok(!("durationMs" in record));
		assert.ok(!("workflowRunId" in record));
		assert.ok(!("missionId" in record));
	});

	it("omits usage when either count is negative or non-finite", () => {
		assert.ok(!("usage" in buildRunRecord({ runId: "r", usage: { input: -1, output: 5 } })));
		assert.ok(!("usage" in buildRunRecord({ runId: "r", usage: { input: 1, output: Number.NaN } })));
		assert.ok(!("usage" in buildRunRecord({ runId: "r", usage: { input: Number.POSITIVE_INFINITY, output: 1 } })));
		assert.deepEqual(buildRunRecord({ runId: "r", usage: { input: 0, output: 0 } }).usage, { input: 0, output: 0 });
	});

	it("copies only non-empty string model fields", () => {
		const record = buildRunRecord({ runId: "r", model: { requested: "sonnet", effective: "", fallbackReason: undefined } });
		assert.deepEqual(record.model, { requested: "sonnet" });
		assert.ok(!("effective" in (record.model ?? {})));
		assert.ok(!("fallbackReason" in (record.model ?? {})));
	});

	it("defaults endedAt to now for terminal states when startedAt is present", () => {
		const record = buildRunRecord({ runId: "r", status: "failed", startedAt: 2_000 }, 5_250);
		assert.equal(record.endedAt, 5_250);
		assert.equal(record.durationMs, 3_250);
	});

	it("does not default endedAt for non-terminal states", () => {
		const record = buildRunRecord({ runId: "r", status: "running", startedAt: 2_000 }, 5_250);
		assert.equal(record.state, "unknown");
		assert.ok(!("endedAt" in record));
		assert.ok(!("durationMs" in record));
	});

	it("does not default endedAt when startedAt is missing", () => {
		const record = buildRunRecord({ runId: "r", status: "complete" }, 5_250);
		assert.ok(!("endedAt" in record));
		assert.ok(!("durationMs" in record));
	});

	it("prefers an explicit endedAt over now", () => {
		const record = buildRunRecord({ runId: "r", status: "stopped", startedAt: 100, endedAt: 400 }, 9_999);
		assert.equal(record.endedAt, 400);
		assert.equal(record.durationMs, 300);
	});

	it("omits durationMs when endedAt precedes startedAt", () => {
		const record = buildRunRecord({ runId: "r", status: "complete", startedAt: 500, endedAt: 400 });
		assert.equal(record.endedAt, 400);
		assert.ok(!("durationMs" in record));
	});

	it("produces plain JSON that round-trips exactly", () => {
		const record = buildRunRecord(
			{
				runId: "run-json",
				agent: "reviewer",
				task: "Review\n the diff",
				status: "partial",
				startedAt: 10,
				model: { effective: "haiku" },
				usage: { input: 1, output: 2 },
				missionId: "m",
			},
			70,
		);
		assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
		for (const value of Object.values(record)) {
			assert.notEqual(value, undefined);
			assert.notEqual(value, null);
		}
	});
});
