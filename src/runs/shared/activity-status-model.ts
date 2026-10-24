import { createHash } from "node:crypto";
import { sanitizeDisplayText, truncateDisplayText } from "../../shared/display-text.ts";

export const ACTIVITY_STATUS_VERSION = 1;
export type PublicActivityState = "queued" | "running" | "paused" | "stopping" | "completed" | "failed" | "stopped" | "unknown";
export interface ActivityEntry {
	key: string;
	parentKey?: string;
	parentOmitted?: true;
	agent: string;
	state: PublicActivityState;
	activity?: { tool?: string; observedAt?: number; reason?: "needs-attention" };
	elapsedMs?: number;
	usage?: { input: number; output: number; source: "reported-own" };
}
export interface ActivityStatus {
	version: 1;
	scope: "current-session";
	generatedAt: number;
	available: boolean;
	entries: ActivityEntry[];
	incomplete: boolean;
	omitted: { active: number; recent: number; children: number; scanTruncated: boolean };
}
export interface ActivityFacts {
	agent?: string;
	state: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	currentTool?: string;
	lastActivityAt?: number;
	activityState?: string;
	stopRequested?: boolean;
	input?: number;
	output?: number;
}
export function activityKey(sessionId: string, runId: string, child: string | number): string {
	return `activity-${createHash("sha256").update(JSON.stringify([sessionId, runId, String(child)])).digest("hex").slice(0, 32)}`;
}
export function validCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeText(value: string | undefined, limit: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const safe = sanitizeDisplayText(value.slice(0, 4096)).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
	return safe ? truncateDisplayText(safe, limit) : undefined;
}
export function activityState(facts: ActivityFacts): PublicActivityState {
	if (facts.stopRequested && (facts.state === "running" || facts.state === "pending" || facts.state === "queued")) return "stopping";
	switch (facts.state) {
		case "pending": case "queued": return "queued";
		case "running": return "running";
		case "complete": case "completed": return "completed";
		case "failed": case "partial": case "rejected": return "failed";
		case "paused": return "paused";
		case "stopped": return "stopped";
		default: return "unknown";
	}
}
export function activeEntry(entry: ActivityEntry): boolean {
	return ["running", "queued", "stopping", "unknown"].includes(entry.state);
}
export function activityEntry(key: string, facts: ActivityFacts, now: number, parentKey?: string): ActivityEntry | undefined {
	const agent = safeText(facts.agent, 96);
	if (!agent) return undefined;
	const state = activityState(facts);
	const tool = safeText(facts.currentTool, 64);
	const observedAt = validCount(facts.lastActivityAt) ? facts.lastActivityAt : undefined;
	const reason = facts.activityState === "needs_attention" ? "needs-attention" as const : undefined;
	let elapsedMs: number | undefined;
	if (validCount(facts.durationMs)) elapsedMs = facts.durationMs;
	else if (validCount(facts.startedAt)) {
		const end = validCount(facts.endedAt) ? facts.endedAt : ["running", "stopping"].includes(state) ? now : undefined;
		if (end !== undefined && end >= facts.startedAt) elapsedMs = end - facts.startedAt;
	}
	return {
		key, ...(parentKey ? { parentKey } : {}), agent, state,
		...(tool || observedAt !== undefined || reason ? { activity: { ...(tool ? { tool } : {}), ...(observedAt !== undefined ? { observedAt } : {}), ...(reason ? { reason } : {}) } } : {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(validCount(facts.input) && validCount(facts.output) ? { usage: { input: facts.input, output: facts.output, source: "reported-own" as const } } : {}),
	};
}
