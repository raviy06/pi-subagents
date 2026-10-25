import { resolveModelCandidate, splitThinkingSuffix, type AvailableModelInfo } from "./model-resolution.ts";
import { checkModelScope, type ModelScopeCheckRule } from "./model-scope.ts";

export type ModelFallbackReason = "unregistered" | "out-of-scope";

export interface SkippedModelCandidate {
	model: string;
	reason: ModelFallbackReason;
}

export interface ModelCandidatePick {
	requested: string;
	effective: string;
	/** Reason the primary model was skipped; absent when the primary model itself was picked. */
	fallbackReason?: ModelFallbackReason;
	skipped: SkippedModelCandidate[];
}

export const MAX_MODEL_FALLBACKS = 8;

/** Accepts a string array or a comma-separated string; trims, drops empties, and dedupes preserving order. */
export function normalizeFallbacks(value: unknown, where: string): string[] {
	if (value === undefined || value === null) return [];
	const items = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(items)) throw new Error(`${where} must be a string array or a comma-separated string.`);
	const fallbacks: string[] = [];
	for (const item of items) {
		if (typeof item !== "string") throw new Error(`${where} must contain only strings.`);
		const trimmed = item.trim();
		if (trimmed && !fallbacks.includes(trimmed)) fallbacks.push(trimmed);
	}
	if (fallbacks.length > MAX_MODEL_FALLBACKS) {
		throw new Error(`${where} lists ${fallbacks.length} fallback models; at most ${MAX_MODEL_FALLBACKS} are allowed.`);
	}
	return fallbacks;
}

/**
 * `resolveModelCandidate` echoes an unresolvable id unchanged, so a candidate is registered only when
 * its resolved base id is an actual registry `fullId`. Without a registry every candidate is kept.
 */
function resolveRegisteredCandidate(
	candidate: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider: string | undefined,
): string | undefined {
	const resolved = resolveModelCandidate(candidate, availableModels, preferredProvider);
	if (resolved === undefined) return undefined;
	if (!availableModels || availableModels.length === 0) return resolved;
	const { baseModel } = splitThinkingSuffix(resolved);
	return availableModels.some((entry) => entry.fullId === baseModel) ? resolved : undefined;
}

/**
 * Pick the first candidate from `[model, ...fallbacks]` that is registered and not rejected
 * (error severity) by any scope. Returns `undefined` when no candidate is viable.
 */
export function pickModelCandidate(input: {
	model: string;
	fallbacks?: readonly string[];
	availableModels?: AvailableModelInfo[];
	preferredProvider?: string;
	scopes?: readonly ModelScopeCheckRule[];
}): ModelCandidatePick | undefined {
	const candidates: string[] = [];
	for (const candidate of [input.model, ...(input.fallbacks ?? [])]) {
		if (!candidates.includes(candidate)) candidates.push(candidate);
	}
	const skipped: SkippedModelCandidate[] = [];
	for (const candidate of candidates) {
		const resolved = resolveRegisteredCandidate(candidate, input.availableModels, input.preferredProvider);
		if (resolved === undefined) {
			skipped.push({ model: candidate, reason: "unregistered" });
			continue;
		}
		const rejected = (input.scopes ?? []).some((scope) => checkModelScope(resolved, scope, "explicit")?.severity === "error");
		if (rejected) {
			skipped.push({ model: candidate, reason: "out-of-scope" });
			continue;
		}
		const fallbackReason = skipped[0]?.reason;
		return {
			requested: input.model,
			effective: resolved,
			...(fallbackReason ? { fallbackReason } : {}),
			skipped,
		};
	}
	return undefined;
}
