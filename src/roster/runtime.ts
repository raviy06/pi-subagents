/**
 * Fork addition (roster): per-session lifecycle for team workflow resources.
 *
 * `bind` at `session_start` reads the roster settings for the session cwd and registers every
 * team as `team.<name>`; `refresh` re-reads after a settings change; `dispose` at
 * `session_shutdown`. Registration never throws: problems surface as warnings and diagnostics
 * that `/roster` shows.
 */
import { registerTeamResources, type TeamResourcesRegistration } from "./register.ts";
import { readRosterSettings, type RosterSettings } from "./settings.ts";

export interface RosterRuntimeState {
	sessionId: string | null;
	cwd: string | null;
	settings: RosterSettings | null;
	registered: string[];
	warnings: string[];
}

export interface RosterRuntime {
	bind(input: { sessionId: string | null | undefined; cwd: string; knownAgents?: readonly string[] }): RosterRuntimeState;
	refresh(knownAgents?: readonly string[]): RosterRuntimeState;
	state(): RosterRuntimeState;
	dispose(): void;
}

export function createRosterRuntime(deps: { read?: typeof readRosterSettings; register?: typeof registerTeamResources; onWarning?: (message: string) => void } = {}): RosterRuntime {
	const read = deps.read ?? readRosterSettings;
	const register = deps.register ?? registerTeamResources;
	let registration: TeamResourcesRegistration | undefined;
	let current: RosterRuntimeState = { sessionId: null, cwd: null, settings: null, registered: [], warnings: [] };
	let knownAgentsCache: readonly string[] | undefined;

	const apply = (): RosterRuntimeState => {
		registration?.dispose();
		registration = undefined;
		if (!current.cwd) return current;
		let settings: RosterSettings;
		try {
			settings = read(current.cwd);
		} catch (error) {
			current = { ...current, settings: null, registered: [], warnings: [`Roster settings could not be read: ${error instanceof Error ? error.message : String(error)}`] };
			deps.onWarning?.(current.warnings[0]!);
			return current;
		}
		const warnings = settings.diagnostics.map((diagnostic) => `${diagnostic.scope} ${diagnostic.path}: ${diagnostic.error}`);
		let registered: string[] = [];
		if (current.sessionId && Object.keys(settings.teams).length > 0) {
			registration = register({ sessionId: current.sessionId, teams: settings.teams, ...(knownAgentsCache ? { knownAgents: knownAgentsCache } : {}) });
			registered = registration.registered;
			warnings.push(...registration.warnings);
		}
		current = { ...current, settings, registered, warnings };
		for (const warning of warnings) deps.onWarning?.(warning);
		return current;
	};

	return {
		bind(input) {
			current = { sessionId: input.sessionId ?? null, cwd: input.cwd, settings: null, registered: [], warnings: [] };
			knownAgentsCache = input.knownAgents;
			return apply();
		},
		refresh(knownAgents) {
			if (knownAgents) knownAgentsCache = knownAgents;
			return apply();
		},
		state: () => current,
		dispose() {
			registration?.dispose();
			registration = undefined;
			current = { sessionId: null, cwd: null, settings: null, registered: [], warnings: [] };
		},
	};
}
