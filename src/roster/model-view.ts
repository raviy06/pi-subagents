/**
 * Fork addition (roster): the Models view. Pure.
 *
 * Cross-references the host model registry with every agent's model chain so the roster can
 * say, before any launch fails, which assigned models are unregistered or outside an enforced
 * scope, and which agents will fall back.
 */
import type { ModelInfo } from "../shared/model-info.ts";
import { splitKnownThinkingSuffix } from "../shared/model-info.ts";
import { matchesScopePattern, type ModelScopeConfig } from "../runs/shared/model-scope.ts";
import type { RosterRow } from "./overview.ts";

export interface ModelViewRow {
	id: string;
	provider: string;
	primary: string[];
	fallback: string[];
	/** Undefined when no scope is configured or enforced. */
	inScope?: boolean;
}

export interface ModelView {
	rows: ModelViewRow[];
	/** Agents whose model chain is `inherit`. */
	inherit: string[];
	unregistered: Array<{ id: string; agents: string[]; role: "primary" | "fallback" }>;
	outOfScope: Array<{ id: string; agents: string[] }>;
	willFallBack: Array<{ agent: string; from: string; to: string; reason: "unregistered" | "out-of-scope" }>;
}

export interface ModelViewInput {
	models: readonly ModelInfo[];
	agents: readonly RosterRow[];
	modelScope?: ModelScopeConfig;
}

function chain(row: RosterRow): string[] {
	return row.modelChain.split("→").map((part) => part.trim()).filter(Boolean);
}

function baseId(model: string): string {
	return splitKnownThinkingSuffix(model).baseModel;
}

function resolveId(model: string, registry: Map<string, ModelInfo>, byBareId: Map<string, ModelInfo[]>): string | undefined {
	const base = baseId(model);
	if (registry.has(base)) return base;
	const matches = byBareId.get(base);
	return matches?.length === 1 ? matches[0]!.fullId : undefined;
}

export function buildModelView(input: ModelViewInput): ModelView {
	const registry = new Map(input.models.map((model) => [model.fullId, model] as const));
	const byBareId = new Map<string, ModelInfo[]>();
	for (const model of input.models) byBareId.set(model.id, [...(byBareId.get(model.id) ?? []), model]);
	const scopeEnforced = input.modelScope?.enforce === true && (input.modelScope.allow?.length ?? 0) > 0;
	const inScope = (id: string): boolean | undefined => scopeEnforced ? input.modelScope!.allow!.some((pattern) => matchesScopePattern(id, pattern)) : undefined;

	const rows = new Map<string, ModelViewRow>(input.models.map((model) => [model.fullId, { id: model.fullId, provider: model.provider, primary: [], fallback: [], ...(inScope(model.fullId) !== undefined ? { inScope: inScope(model.fullId) } : {}) }]));
	const inherit: string[] = [];
	const unregistered = new Map<string, { id: string; agents: string[]; role: "primary" | "fallback" }>();
	const outOfScope = new Map<string, { id: string; agents: string[] }>();
	const willFallBack: ModelView["willFallBack"] = [];

	for (const agent of input.agents) {
		const candidates = chain(agent);
		if (candidates.length === 0 || candidates[0] === "inherit") { inherit.push(agent.name); continue; }
		let primaryViable = true;
		let primaryReason: "unregistered" | "out-of-scope" | undefined;
		candidates.forEach((candidate, index) => {
			const role = index === 0 ? "primary" : "fallback";
			const id = resolveId(candidate, registry, byBareId);
			if (!id) {
				const key = `${candidate}|${role}`;
				const entry = unregistered.get(key) ?? { id: candidate, agents: [], role };
				entry.agents.push(agent.name);
				unregistered.set(key, entry);
				if (index === 0) { primaryViable = false; primaryReason = "unregistered"; }
				return;
			}
			const row = rows.get(id)!;
			(index === 0 ? row.primary : row.fallback).push(agent.name);
			if (row.inScope === false) {
				const entry = outOfScope.get(id) ?? { id, agents: [] };
				if (!entry.agents.includes(agent.name)) entry.agents.push(agent.name);
				outOfScope.set(id, entry);
				if (index === 0) { primaryViable = false; primaryReason = "out-of-scope"; }
			}
		});
		if (!primaryViable && primaryReason) {
			const to = candidates.slice(1).map((candidate) => resolveId(candidate, registry, byBareId)).find((id) => id && rows.get(id)!.inScope !== false);
			if (to) willFallBack.push({ agent: agent.name, from: candidates[0]!, to, reason: primaryReason });
		}
	}

	const sorted = [...rows.values()].sort((a, b) => {
		const assignedA = a.primary.length + a.fallback.length > 0 ? 0 : 1;
		const assignedB = b.primary.length + b.fallback.length > 0 ? 0 : 1;
		return assignedA - assignedB || a.id.localeCompare(b.id);
	});
	return { rows: sorted, inherit, unregistered: [...unregistered.values()], outOfScope: [...outOfScope.values()], willFallBack };
}
