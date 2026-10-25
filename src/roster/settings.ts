/**
 * Fork addition (roster): team definitions in pi settings.
 *
 * Teams live under the top-level `agentRoster.teams` key of the user settings file
 * (`<agent dir>/settings.json`) and the project settings file (`<project>/.pi/settings.json`).
 * Project definitions win by name. Model assignments are *not* stored here: they are the
 * existing `subagents.agentOverrides.<name>.{model,fallbacks,thinking}` fields, so there is one
 * canonical place for them and nothing to keep in sync.
 */
import { getProjectAgentSettingsPath, getUserAgentSettingsPath, readSettingsFileStrict, writeSettingsFile } from "../agents/agents.ts";
import { withSettingsFileLease } from "../shared/settings-file-lease.ts";
import { mergeTeamSets, parseTeams, type TeamDefinition, type TeamSet } from "./teams.ts";

export const ROSTER_SETTINGS_KEY = "agentRoster";
export type RosterScope = "user" | "project";

export interface RosterDiagnostic {
	scope: RosterScope;
	path: string;
	error: string;
}

export interface RosterSettings {
	teams: TeamSet;
	userPath: string;
	projectPath: string | null;
	diagnostics: RosterDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function teamsFromFile(filePath: string | null, scope: RosterScope, diagnostics: RosterDiagnostic[]): TeamSet {
	if (!filePath) return {};
	try {
		const settings = readSettingsFileStrict(filePath);
		const roster = settings[ROSTER_SETTINGS_KEY];
		if (roster === undefined) return {};
		if (!isRecord(roster)) throw new Error(`'${ROSTER_SETTINGS_KEY}' must be an object.`);
		for (const key of Object.keys(roster)) if (key !== "teams") throw new Error(`'${ROSTER_SETTINGS_KEY}' has unknown field '${key}'.`);
		return parseTeams(roster.teams, `${filePath} ${ROSTER_SETTINGS_KEY}.teams`);
	} catch (error) {
		diagnostics.push({ scope, path: filePath, error: error instanceof Error ? error.message : String(error) });
		return {};
	}
}

export function readRosterSettings(cwd: string): RosterSettings {
	const userPath = getUserAgentSettingsPath();
	const projectPath = getProjectAgentSettingsPath(cwd);
	const diagnostics: RosterDiagnostic[] = [];
	const user = teamsFromFile(userPath, "user", diagnostics);
	const project = teamsFromFile(projectPath, "project", diagnostics);
	return { teams: mergeTeamSets(user, project), userPath, projectPath, diagnostics };
}

function scopePath(cwd: string, scope: RosterScope): string {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project roster settings are not available here. No project config root was found.");
	return filePath;
}

/** The on-disk shape of a team: the definition without its name and merge source. */
export function teamToSettings(team: TeamDefinition): Record<string, unknown> {
	const value: Record<string, unknown> = { shape: team.shape };
	if (team.description) value.description = team.description;
	value.members = team.members.map((member) => (member.model ? { agent: member.agent, model: member.model } : { agent: member.agent }));
	if (team.chair) value.chair = team.chair.model ? { agent: team.chair.agent, model: team.chair.model } : { agent: team.chair.agent };
	if (team.passes !== undefined) value.passes = team.passes;
	return value;
}

function updateTeams(cwd: string, scope: RosterScope, update: (teams: Record<string, unknown>) => boolean): { path: string; changed: boolean } {
	const filePath = scopePath(cwd, scope);
	return withSettingsFileLease(filePath, () => {
		const settings = readSettingsFileStrict(filePath);
		const roster = isRecord(settings[ROSTER_SETTINGS_KEY]) ? { ...(settings[ROSTER_SETTINGS_KEY] as Record<string, unknown>) } : {};
		const teams = isRecord(roster.teams) ? { ...(roster.teams as Record<string, unknown>) } : {};
		const changed = update(teams);
		if (!changed) return { path: filePath, changed: false };
		roster.teams = teams;
		settings[ROSTER_SETTINGS_KEY] = roster;
		writeSettingsFile(filePath, settings);
		return { path: filePath, changed: true };
	});
}

/** Write (create or replace) a team in the given scope. Returns the settings path. */
export function writeTeam(cwd: string, scope: RosterScope, team: TeamDefinition): string {
	return updateTeams(cwd, scope, (teams) => {
		teams[team.name] = teamToSettings(team);
		return true;
	}).path;
}

export function removeTeam(cwd: string, scope: RosterScope, name: string): { path: string; removed: boolean } {
	const result = updateTeams(cwd, scope, (teams) => {
		if (!(name in teams)) return false;
		delete teams[name];
		return true;
	});
	return { path: result.path, removed: result.changed };
}
