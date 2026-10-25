/**
 * Fork addition (roster): `@handle` routing at the prompt.
 *
 * A prompt that *starts* with `@<agent>` or `@<team>` goes to that agent or team instead of the
 * main model, without a model turn: a team launches its `team.<name>` workflow, an agent with
 * exactly one live run is steered, any other agent is launched. `@main` strips the prefix and
 * continues normally. Anything else (unknown handle, `@path/to/file`, a mention mid-text) is left
 * for the model and pi's own file picker, so the existing `@` behaviour is extended, not replaced.
 *
 * Only interactive input is routed; RPC and extension-originated input is never intercepted.
 */
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const LEADING = /^\s*@([^\s]+)(?:\s+([\s\S]*))?$/u;

export interface MentionCatalogue {
	agents: readonly string[];
	teams: readonly string[];
	liveRuns: ReadonlyArray<{ id: string; agent: string }>;
}

export type MentionResolution =
	| { kind: "none" }
	| { kind: "main"; text: string }
	| { kind: "empty"; handle: string }
	| { kind: "team"; name: string; task: string }
	| { kind: "steer"; agent: string; runId: string; message: string }
	| { kind: "ambiguous"; agent: string; runIds: string[] }
	| { kind: "launch"; agent: string; task: string };

export function resolveMention(text: string, catalogue: MentionCatalogue): MentionResolution {
	const match = LEADING.exec(text);
	if (!match) return { kind: "none" };
	const handle = match[1]!;
	if (!HANDLE.test(handle)) return { kind: "none" };
	const body = (match[2] ?? "").trim();
	if (handle === "main") return { kind: "main", text: body };
	const isTeam = catalogue.teams.includes(handle);
	const isAgent = catalogue.agents.includes(handle);
	if (!isTeam && !isAgent) return { kind: "none" };
	if (!body) return { kind: "empty", handle };
	if (isTeam) return { kind: "team", name: handle, task: body };
	const live = catalogue.liveRuns.filter((run) => run.agent === handle);
	if (live.length === 1) return { kind: "steer", agent: handle, runId: live[0]!.id, message: body };
	if (live.length > 1) return { kind: "ambiguous", agent: handle, runIds: live.map((run) => run.id) };
	return { kind: "launch", agent: handle, task: body };
}

/** Completions for a leading `@token` on the first line; null leaves the built-in provider alone. */
export function mentionCompletions(lines: string[], cursorLine: number, cursorCol: number, catalogue: MentionCatalogue): AutocompleteSuggestions | null {
	if (cursorLine !== 0) return null;
	const line = lines[0] ?? "";
	const before = line.slice(0, cursorCol);
	const match = /^\s*@([A-Za-z0-9._-]*)$/u.exec(before);
	if (!match) return null;
	const typed = match[1]!;
	const prefix = `@${typed}`;
	const starts = (name: string) => name.toLowerCase().startsWith(typed.toLowerCase());
	const live = new Set(catalogue.liveRuns.map((run) => run.agent));
	const items: AutocompleteItem[] = [
		...catalogue.teams.filter(starts).sort().map((name) => ({ value: `@${name}`, label: `@${name}`, description: "team" })),
		...catalogue.agents.filter(starts).sort().map((name) => ({ value: `@${name}`, label: `@${name}`, description: live.has(name) ? "agent · live run (steer)" : "agent" })),
		...("main".startsWith(typed.toLowerCase()) ? [{ value: "@main", label: "@main", description: "main model" }] : []),
	];
	return items.length ? { items, prefix } : null;
}

/** Wrap pi's autocomplete provider: mention items first, then whatever the built-in provider offers. */
export function withMentionCompletions(current: AutocompleteProvider, catalogue: () => MentionCatalogue): AutocompleteProvider {
	return {
		...(current.triggerCharacters ? { triggerCharacters: [...new Set([...current.triggerCharacters, "@"])] } : { triggerCharacters: ["@"] }),
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const mentions = mentionCompletions(lines, cursorLine, cursorCol, catalogue());
			const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!mentions) return base;
			if (!base || base.prefix !== mentions.prefix) return mentions;
			return { prefix: mentions.prefix, items: [...mentions.items, ...base.items.filter((item) => !mentions.items.some((mention) => mention.value === item.value))] };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const isMention = /^@[A-Za-z0-9._-]+$/u.test(item.value) && /^\s*@[A-Za-z0-9._-]*$/u.test(line.slice(0, cursorCol));
			if (!isMention) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const start = cursorCol - prefix.length;
			const replaced = `${line.slice(0, start)}${item.value} ${line.slice(cursorCol)}`;
			const next = [...lines];
			next[cursorLine] = replaced;
			return { lines: next, cursorLine, cursorCol: start + item.value.length + 1 };
		},
		...(current.shouldTriggerFileCompletion ? { shouldTriggerFileCompletion: current.shouldTriggerFileCompletion.bind(current) } : {}),
	};
}
