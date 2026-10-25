/**
 * Fork addition: observability foundations for roster-style consumers.
 *
 * - Coalesces the existing child lifecycle events into one `subagents:activity:changed`
 *   notification per window, so consumers refresh `status` on demand instead of polling.
 * - Appends one durable `subagents:record` session entry per top-level run completion.
 *
 * Read-only: it never changes delegation, permissions or result delivery.
 */
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CHILD_STATUS_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_PROCESS_TERMINAL_EVENT,
	type SubagentState,
} from "../../shared/types.ts";
import { ACTIVITY_CHANGED_EVENT, createActivityChangeNotifier, type ActivityChangeNotifier, type ActivityChangeNotifierOptions } from "./activity-change-notifier.ts";
import { buildRunRecord, RUN_RECORD_ENTRY_TYPE, runRecordStateFromStatus, type RunRecordFacts } from "./run-record-entry.ts";

export { ACTIVITY_CHANGED_EVENT };

interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

export interface ActivityFoundationsInput extends Pick<ActivityChangeNotifierOptions, "windowMs" | "now" | "setTimer" | "clearTimer"> {
	events: EventBus;
	state: Pick<SubagentState, "currentSessionId" | "asyncJobs" | "foregroundControls">;
	appendEntry: (customType: string, data: unknown) => void;
}

export interface ActivityFoundationsRegistration {
	notifier: ActivityChangeNotifier;
	dispose(): void;
}

const LIFECYCLE_EVENTS = [
	SUBAGENT_CHILD_STATUS_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_PROCESS_TERMINAL_EVENT,
] as const;

/** Bounded memory for completion de-duplication across re-deliveries. */
const RECORDED_RUN_LIMIT = 512;

interface CompletionPayload {
	runId?: string;
	id?: string;
	sessionId?: string;
	agent?: string;
	state?: string;
	timestamp?: number;
	awaitedByWorkflow?: boolean;
	parentWorkflowRunId?: string;
}

function completionPayload(data: unknown): CompletionPayload | undefined {
	if (!data || typeof data !== "object") return undefined;
	return data as CompletionPayload;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function registerActivityFoundations(input: ActivityFoundationsInput): ActivityFoundationsRegistration {
	const now = input.now ?? Date.now;
	const notifier = createActivityChangeNotifier((event, payload) => input.events.emit(event, payload), {
		...(input.windowMs !== undefined ? { windowMs: input.windowMs } : {}),
		now,
		...(input.setTimer ? { setTimer: input.setTimer } : {}),
		...(input.clearTimer ? { clearTimer: input.clearTimer } : {}),
	});
	const recorded = new Set<string>();

	const remember = (runId: string): boolean => {
		if (recorded.has(runId)) return false;
		if (recorded.size >= RECORDED_RUN_LIMIT) {
			const oldest = recorded.values().next().value;
			if (oldest !== undefined) recorded.delete(oldest);
		}
		recorded.add(runId);
		return true;
	};

	const factsFor = (payload: CompletionPayload, runId: string): RunRecordFacts => {
		const facts: RunRecordFacts = { runId };
		if (payload.agent) facts.agent = payload.agent;
		facts.status = payload.state;
		const endedAt = finite(payload.timestamp) ?? now();
		facts.endedAt = endedAt;
		const job = input.state.asyncJobs.get(runId);
		if (job) {
			if (job.description) facts.task = job.description;
			if (finite(job.startedAt) !== undefined) facts.startedAt = job.startedAt;
			const model = job.steps?.find((step) => typeof step.model === "string" && step.model)?.model;
			if (model) facts.model = { effective: model };
			if (job.totalTokens) facts.usage = { input: job.totalTokens.input, output: job.totalTokens.output };
			if (job.parentWorkflowRunId) facts.workflowRunId = job.parentWorkflowRunId;
			return facts;
		}
		const control = input.state.foregroundControls.get(runId);
		if (control) {
			if (control.description) facts.task = control.description;
			if (finite(control.startedAt) !== undefined) facts.startedAt = control.startedAt;
			if (finite(control.inputTokens) !== undefined || finite(control.outputTokens) !== undefined) {
				facts.usage = { input: control.inputTokens ?? 0, output: control.outputTokens ?? 0 };
			}
			if (control.parentWorkflowRunId) facts.workflowRunId = control.parentWorkflowRunId;
		}
		return facts;
	};

	const recordCompletion = (data: unknown): void => {
		const payload = completionPayload(data);
		if (!payload) return;
		const runId = payload.runId ?? payload.id;
		if (!runId) return;
		// Workflow-owned children report through their workflow; only top-level runs get a record.
		if (payload.awaitedByWorkflow || payload.parentWorkflowRunId) return;
		if (payload.sessionId && input.state.currentSessionId && payload.sessionId !== input.state.currentSessionId) return;
		if (runRecordStateFromStatus(payload.state) === "unknown" && payload.state !== undefined) return;
		if (!remember(runId)) return;
		try {
			input.appendEntry(RUN_RECORD_ENTRY_TYPE, buildRunRecord(factsFor(payload, runId), now()));
		} catch (error) {
			console.error(`Failed to append the subagent run record for ${runId}:`, error);
		}
	};

	const unsubscribes: Array<(() => void) | void> = LIFECYCLE_EVENTS.map((event) => input.events.on(event, () => notifier.notify()));
	unsubscribes.push(input.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, recordCompletion));
	unsubscribes.push(input.events.on(SUBAGENT_FOREGROUND_COMPLETE_EVENT, recordCompletion));

	return {
		notifier,
		dispose() {
			for (const unsubscribe of unsubscribes.splice(0)) if (typeof unsubscribe === "function") unsubscribe();
			notifier.dispose();
			recorded.clear();
		},
	};
}
