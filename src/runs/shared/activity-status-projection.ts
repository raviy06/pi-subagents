import type { AsyncJobState, AsyncJobStep, NestedRunSummary, SubagentState } from "../../shared/types.ts";
import { ownerSessionIds } from "./run-ownership.ts";
import { ACTIVITY_STATUS_VERSION, activeEntry, activityEntry, activityKey, validCount, type ActivityEntry, type ActivityEntryOptions, type ActivityFacts, type ActivityStatus } from "./activity-status-model.ts";

export { ACTIVITY_STATUS_VERSION } from "./activity-status-model.ts";
export type { ActivityStatus, ActivityEntry } from "./activity-status-model.ts";
const MAX_SCAN = 1024;
const MAX_ENTRIES = 64;
const MAX_BYTES = 32768;
const MAX_DEPTH = 4;
type Candidate = { entry: ActivityEntry; rank: number; order: number };

/** Pure projection: bounded reads of owner-held state, no IO, reconciliation, or execution. */
export function buildActivityStatus(state: SubagentState | undefined, sessionId: string | null | undefined, now = Date.now(), options: ActivityEntryOptions = {}): ActivityStatus {
	const result: ActivityStatus = {
		version: ACTIVITY_STATUS_VERSION, scope: "current-session", generatedAt: validCount(now) ? now : 0,
		available: false, entries: [], incomplete: false,
		omitted: { active: 0, recent: 0, children: 0, scanTruncated: false },
	};
	if (!state || !sessionId || state.currentSessionId !== sessionId || state.statusProjectionSessionId !== sessionId) return result;
	result.available = true;
	const owners = ownerSessionIds(sessionId);
	const candidates = new Map<string, Candidate>();
	let scanned = 0;
	const visit = () => {
		if (scanned++ < MAX_SCAN) return true;
		result.incomplete = true; result.omitted.scanTruncated = true;
		return false;
	};
	const add = (owner: string, run: string, child: string | number, facts: ActivityFacts, rank: number, parentKey?: string) => {
		const key = activityKey(owner, run, child);
		const entry = activityEntry(key, facts, result.generatedAt, parentKey, options);
		if (!entry) { result.incomplete = true; return key; }
		const prior = candidates.get(key);
		if (!prior || rank > prior.rank) {
			if (!entry.parentKey && prior?.entry.parentKey) entry.parentKey = prior.entry.parentKey;
			candidates.set(key, { entry, rank, order: prior?.order ?? candidates.size });
		} else if (!prior.entry.parentKey && entry.parentKey) prior.entry.parentKey = entry.parentKey;
		return key;
	};
	const nestedSeen = new Set<string>();
	const nested = (runs: readonly NestedRunSummary[] | undefined, owner: string, parentRun: string, parentKey?: string, depth = 1): void => {
		if (!runs?.length) return;
		if (depth > MAX_DEPTH) { result.incomplete = true; result.omitted.children += runs.length; return; }
		for (const run of runs) {
			if (!visit()) break;
			if (run.parentRunId !== parentRun) { result.incomplete = true; continue; }
			const identity = activityKey(owner, run.id, "nested-visit");
			if (nestedSeen.has(identity)) continue;
			nestedSeen.add(identity);
			let ownParent = parentKey;
			if (run.steps?.length) {
				for (const [index, step] of run.steps.entries()) {
					if (!visit()) break;
					const key = add(owner, run.id, index, { ...step, state: step.status }, 0, parentKey);
					if (run.steps.length === 1) ownParent = key;
					nested(step.children, owner, run.id, key, depth + 1);
				}
			} else if (run.agent && run.mode !== "workflow") {
				ownParent = add(owner, run.id, 0, { ...run, agent: run.agent }, 0, parentKey);
			}
			nested(run.children, owner, run.id, ownParent, depth + 1);
		}
	};
	for (const control of state.foregroundControls.values()) {
		if (!visit()) break;
		if (control.sessionId !== sessionId) continue;
		const live = control.activeChildren;
		if (live?.size) {
			for (const child of live.values()) {
				if (!visit()) break;
				add(sessionId, control.runId, child.index, { ...child, state: "running", activityState: child.currentActivityState, input: child.inputTokens, output: child.outputTokens }, 4);
			}
		} else if (control.currentAgent) {
			add(sessionId, control.runId, control.currentIndex ?? 0, { ...control, agent: control.currentAgent, state: "running", activityState: control.currentActivityState, input: control.inputTokens, output: control.outputTokens }, 4);
		}
		for (const child of control.nestedChildren ?? []) {
			const parentIndex = child.parentStepIndex ?? (live?.size === 1 ? live.values().next().value?.index : control.currentIndex);
			const parentKey = parentIndex === undefined ? undefined : activityKey(sessionId, control.runId, parentIndex);
			nested([child], sessionId, control.runId, parentKey);
			if (result.omitted.scanTruncated) break;
		}
	}
	const stepFacts = (step: AsyncJobStep): ActivityFacts => ({ ...step, state: step.status, input: step.tokens?.input, output: step.tokens?.output });
	const jobs = (source: Map<string, AsyncJobState> | undefined, rank: number) => {
		for (const job of source?.values() ?? []) {
			if (!visit()) break;
			if (!job.sessionId || !owners.has(job.sessionId)) continue;
			const owner = job.sessionId;
			if (job.steps?.length) {
				for (const [offset, step] of job.steps.entries()) {
					if (!visit()) break;
					const run = step.runId ?? job.asyncId;
					const child = step.runId ? 0 : (step.workflowKey ?? step.index ?? offset);
					const key = add(owner, run, child, stepFacts(step), rank);
					nested(step.children, owner, run, key);
				}
			} else if (job.mode !== "workflow" && job.agents?.length === 1) {
				add(owner, job.asyncId, 0, { ...job, agent: job.agents[0], state: job.status }, rank);
			} else if (job.mode !== "workflow") result.incomplete = true;
			for (const child of job.nestedChildren ?? []) {
				const parentIndex = child.parentStepIndex ?? (job.steps?.length === 1 ? job.steps[0]?.index ?? 0 : undefined);
				nested([child], owner, job.asyncId, parentIndex === undefined ? undefined : activityKey(owner, job.asyncId, parentIndex));
				if (result.omitted.scanTruncated) break;
			}
		}
	};
	jobs(state.asyncJobs, 3);
	jobs(state.fleetJobs, 2);
	for (const run of state.foregroundRuns?.values() ?? []) {
		if (!visit()) break;
		if (run.sessionId !== sessionId) continue;
		for (const child of run.children) {
			if (!visit()) break;
			add(sessionId, run.runId, child.index, { ...child, state: child.status }, 1);
		}
	}
	const ordered = [...candidates.values()].sort((a, b) => {
		const priority = (entry: ActivityEntry) => entry.activity?.reason || ["failed", "paused"].includes(entry.state) ? 0 : activeEntry(entry) ? 1 : 2;
		return priority(a.entry) - priority(b.entry) || a.order - b.order;
	});
	for (const candidate of ordered) {
		if (result.entries.length < MAX_ENTRIES) result.entries.push(candidate.entry);
		else { result.omitted[activeEntry(candidate.entry) ? "active" : "recent"]++; result.incomplete = true; }
	}
	const repairParents = () => {
		const entries = new Map(result.entries.map(entry => [entry.key, entry]));
		for (const entry of result.entries) {
			const seen = new Set([entry.key]);
			let parent = entry.parentKey;
			while (parent) {
				if (!entries.has(parent) || seen.has(parent)) {
					delete entry.parentKey; entry.parentOmitted = true; result.incomplete = true;
					break;
				}
				seen.add(parent); parent = entries.get(parent)?.parentKey;
			}
		}
	};
	repairParents();
	while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES && result.entries.length) {
		const entry = result.entries.pop()!;
		result.omitted[activeEntry(entry) ? "active" : "recent"]++; result.incomplete = true;
		repairParents();
	}
	return result;
}
