/**
 * Fork addition (roster): expose every team as a named workflow resource for one session.
 *
 * Registration goes through the same registry `registerWorkflowResource` uses, so a team is
 * invoked exactly like any other named resource: `subagent({ workflow: "team.<name>", args: { task } })`.
 * Teams never grant host-command authority. Register at `session_start`, dispose at
 * `session_shutdown`, and re-register when the settings change.
 */
import { registerWorkflowResource, type WorkflowResourceRegistration } from "../workflows/workflow-resources.ts";
import { compileTeamScript, parseTeamRunArgs, teamDefinitionVersion, teamResourceName, type TeamSet } from "./teams.ts";

export interface RegisterTeamResourcesInput {
	sessionId: string;
	teams: TeamSet;
	/** When given, teams naming agents outside this list produce a warning (they still register; launch validates again). */
	knownAgents?: readonly string[];
}

export interface TeamResourcesRegistration {
	registered: string[];
	warnings: string[];
	dispose(): void;
}

export function registerTeamResources(input: RegisterTeamResourcesInput): TeamResourcesRegistration {
	const registrations: WorkflowResourceRegistration[] = [];
	const registered: string[] = [];
	const warnings: string[] = [];
	const known = input.knownAgents ? new Set(input.knownAgents) : undefined;
	for (const team of Object.values(input.teams)) {
		if (known) {
			const unknown = [...new Set([...team.members.map((member) => member.agent), ...(team.chair ? [team.chair.agent] : [])])].filter((agent) => !known.has(agent));
			if (unknown.length) warnings.push(`Team '${team.name}' names unknown agents: ${unknown.join(", ")}`);
		}
		try {
			registrations.push(registerWorkflowResource({
				sessionId: input.sessionId,
				definition: {
					name: teamResourceName(team.name),
					version: teamDefinitionVersion(team),
					resolve(args) {
						const parsed = parseTeamRunArgs(args);
						if ("error" in parsed) return { error: parsed.error };
						try {
							return { script: compileTeamScript(team, parsed) };
						} catch (error) {
							return { error: error instanceof Error ? error.message : String(error) };
						}
					},
				},
			}));
			registered.push(team.name);
		} catch (error) {
			warnings.push(`Team '${team.name}' was not registered: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		registered,
		warnings,
		dispose() {
			for (const registration of registrations.splice(0)) registration.dispose();
		},
	};
}
