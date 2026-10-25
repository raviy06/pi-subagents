export const RUN_RECORD_ENTRY_TYPE = "subagents:record" as const;
export const RUN_RECORD_VERSION = 1 as const;
export const RUN_RECORD_TASK_LIMIT = 200;

export interface RunRecordModel {
	requested?: string;
	effective?: string;
	fallbackReason?: string;
}

export interface RunRecord {
	version: typeof RUN_RECORD_VERSION;
	runId: string;
	agent: string;
	handle?: string;
	task?: string;
	state: "completed" | "failed" | "partial" | "stopped" | "rejected" | "unknown";
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	model?: RunRecordModel;
	usage?: { input: number; output: number };
	workflowRunId?: string;
	missionId?: string;
}

export interface RunRecordFacts {
	runId: string;
	agent?: string;
	handle?: string;
	task?: string;
	status?: string;
	startedAt?: number;
	endedAt?: number;
	model?: RunRecordModel;
	usage?: { input?: number; output?: number };
	workflowRunId?: string;
	missionId?: string;
}

const TASK_ELLIPSIS = "…";

export function runRecordStateFromStatus(status: string | undefined): RunRecord["state"] {
	switch (status) {
		case "complete":
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "partial":
			return "partial";
		case "stopped":
			return "stopped";
		case "rejected":
			return "rejected";
		default:
			return "unknown";
	}
}

export function buildRunRecord(facts: RunRecordFacts, now: number = Date.now()): RunRecord {
	const state = runRecordStateFromStatus(facts.status);
	const record: RunRecord = {
		version: RUN_RECORD_VERSION,
		runId: facts.runId,
		agent: nonEmptyString(facts.agent) ?? "unknown",
		state,
	};

	const handle = nonEmptyString(facts.handle);
	if (handle !== undefined) record.handle = handle;

	const task = normalizeTask(facts.task);
	if (task !== undefined) record.task = task;

	const startedAt = finiteNumber(facts.startedAt);
	if (startedAt !== undefined) record.startedAt = startedAt;

	let endedAt = finiteNumber(facts.endedAt);
	if (endedAt === undefined && startedAt !== undefined && state !== "unknown") {
		endedAt = finiteNumber(now);
	}
	if (endedAt !== undefined) record.endedAt = endedAt;

	if (startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt) {
		record.durationMs = endedAt - startedAt;
	}

	const model = normalizeModel(facts.model);
	if (model !== undefined) record.model = model;

	const usage = normalizeUsage(facts.usage);
	if (usage !== undefined) record.usage = usage;

	const workflowRunId = nonEmptyString(facts.workflowRunId);
	if (workflowRunId !== undefined) record.workflowRunId = workflowRunId;

	const missionId = nonEmptyString(facts.missionId);
	if (missionId !== undefined) record.missionId = missionId;

	return record;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTask(task: string | undefined): string | undefined {
	if (task === undefined) return undefined;
	const collapsed = task.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	if (collapsed.length <= RUN_RECORD_TASK_LIMIT) return collapsed;
	return collapsed.slice(0, RUN_RECORD_TASK_LIMIT - TASK_ELLIPSIS.length) + TASK_ELLIPSIS;
}

function normalizeModel(model: RunRecordModel | undefined): RunRecordModel | undefined {
	if (!model) return undefined;
	const result: RunRecordModel = {};
	const requested = nonEmptyString(model.requested);
	if (requested !== undefined) result.requested = requested;
	const effective = nonEmptyString(model.effective);
	if (effective !== undefined) result.effective = effective;
	const fallbackReason = nonEmptyString(model.fallbackReason);
	if (fallbackReason !== undefined) result.fallbackReason = fallbackReason;
	return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeUsage(usage: RunRecordFacts["usage"]): RunRecord["usage"] | undefined {
	if (!usage) return undefined;
	const input = finiteNumber(usage.input);
	const output = finiteNumber(usage.output);
	if (input === undefined || output === undefined || input < 0 || output < 0) return undefined;
	return { input, output };
}
