/**
 * Fork addition (roster): pure rendering and argument parsing for the `/roster` command.
 */
import type { AgentCapabilitiesSnapshot, AgentCapabilityRow } from "../shared/types.ts";
import type { RosterDiagnostic, RosterScope } from "./settings.ts";
import { compileTeamScript, parseTeam, TEAM_SHAPES, teamResourceName, type TeamDefinition, type TeamMember, type TeamSet } from "./teams.ts";

export interface RosterRow {
	name: string;
	source: AgentCapabilityRow["source"];
	description: string;
	/** `primary → fallback → …`, or `inherit`. */
	modelChain: string;
	thinking?: string;
	flags: string[];
	filePath?: string;
}

const SOURCE_ORDER: AgentCapabilityRow["source"][] = ["project", "user", "package", "runtime", "builtin"];
const SOURCE_TITLES: Record<AgentCapabilityRow["source"], string> = { project: "Project agents", user: "User agents", package: "Package agents", runtime: "Runtime agents", builtin: "Builtin agents" };

export function rosterRowsFromCapabilities(snapshot: AgentCapabilitiesSnapshot): RosterRow[] {
	return snapshot.agents.map((agent) => {
		const chain = [agent.model?.value ?? "inherit", ...(agent.model?.fallbacks ?? [])].join(" → ");
		const flags: string[] = [];
		if (agent.disabled) flags.push("disabled");
		else if (!agent.executable) flags.push("restricted");
		if (agent.runner.type === "external-cli") flags.push(`external-cli: ${agent.runner.command}${agent.runner.available ? "" : " (unavailable)"}`);
		if (agent.runner.type === "external-job") flags.push(`external-job: ${agent.runner.provider}`);
		if (agent.provenance?.override) flags.push(`${agent.provenance.override.scope} override${agent.provenance.override.fields?.length ? `: ${agent.provenance.override.fields.join(", ")}` : ""}`);
		if (agent.provenance?.modelSource) flags.push(`${agent.provenance.modelSource.scope} defaultModel`);
		if (agent.provenance?.launcher) flags.push(`launcher: ${agent.provenance.launcher}`);
		const row: RosterRow = { name: agent.name, source: agent.source, description: agent.description, modelChain: chain, flags };
		if (typeof agent.model?.thinking === "string") row.thinking = agent.model.thinking;
		else if (agent.model?.thinking === false) row.thinking = "off";
		if (agent.provenance?.filePath) row.filePath = agent.provenance.filePath;
		return row;
	});
}

function memberText(member: TeamMember): string {
	return member.model ? `${member.agent} (${member.model})` : member.agent;
}

export function describeTeam(team: TeamDefinition): string {
	const meta = [team.shape, team.source ?? "user", ...(team.shape === "council" ? [`${team.passes ?? 2} passes`] : [])].join(", ");
	const chair = team.chair ? `chair ${memberText(team.chair)}; ` : "";
	return `${team.name} (${meta}): ${chair}${team.members.map(memberText).join(", ")}`;
}

export interface RosterOverviewInput {
	rows: RosterRow[];
	teams: TeamSet;
	diagnostics: RosterDiagnostic[];
	registered: string[];
	warnings: string[];
}

export function renderRosterOverview(input: RosterOverviewInput): string {
	const lines: string[] = ["Roster", ""];
	for (const source of SOURCE_ORDER) {
		const rows = input.rows.filter((row) => row.source === source).sort((a, b) => a.name.localeCompare(b.name));
		if (rows.length === 0) continue;
		lines.push(SOURCE_TITLES[source]);
		for (const row of rows) {
			const parts = [row.modelChain];
			if (row.thinking) parts.push(`thinking: ${row.thinking}`);
			lines.push(`- ${row.name} · ${parts.join(" · ")}${row.flags.length ? ` [${row.flags.join("; ")}]` : ""}`);
		}
		lines.push("");
	}
	lines.push("Teams");
	const teams = Object.values(input.teams).sort((a, b) => a.name.localeCompare(b.name));
	if (teams.length === 0) lines.push("- (none)");
	for (const team of teams) {
		const launch = input.registered.includes(team.name) ? ` → subagent({ workflow: "${teamResourceName(team.name)}", args: { task } })` : " (not registered this session)";
		lines.push(`- ${describeTeam(team)}${launch}`);
	}
	if (input.warnings.length) lines.push("", "Warnings", ...input.warnings.map((warning) => `- ${warning}`));
	if (input.diagnostics.length) lines.push("", "Roster settings problems", ...input.diagnostics.map((diagnostic) => `- ${diagnostic.scope} ${diagnostic.path}: ${diagnostic.error}`));
	lines.push(
		"",
		"Commands",
		"- /roster agent <name>                    edit model, fallbacks, thinking (same as /subagents <name>)",
		"- /roster team <name>                     show a team and its compiled workflow",
		"- /roster team add <name> <shape> <agent[=model],...> [--chair <agent[=model]>] [--passes n] [--description text] [--project]",
		"- /roster team remove <name> [--project]",
		"- /roster run <team> <task...>            launch a team in the background",
		"- /roster reload                          re-read settings and re-register teams",
		`Shapes: ${TEAM_SHAPES.join(", ")}. Models are assigned per agent in settings (subagents.agentOverrides.<name>.{model,fallbacks,thinking}) or agent frontmatter; teams live in agentRoster.teams.`,
	);
	return lines.join("\n");
}

export function renderTeam(team: TeamDefinition): string {
	const script = compileTeamScript(team, { task: "<task>" });
	return [`Team ${describeTeam(team)}`, team.description ? `Description: ${team.description}` : undefined, `Launch: subagent({ workflow: "${teamResourceName(team.name)}", args: { task: "..." } })`, "", "Compiled workflow:", "```js", script, "```"].filter((line): line is string => line !== undefined).join("\n");
}

function parseMemberToken(token: string): TeamMember {
	const [agent, model] = token.split("=", 2);
	const member: TeamMember = { agent: (agent ?? "").trim() };
	if (model?.trim()) member.model = model.trim();
	return member;
}

export type TeamAddParse = { ok: true; scope: RosterScope; team: TeamDefinition } | { ok: false; message: string };

/** `<name> <shape> <agent[=model],...> [--chair <agent[=model]>] [--passes n] [--description text...] [--project]` */
export function parseTeamAddArgs(tokens: string[]): TeamAddParse {
	const usage = "Usage: /roster team add <name> <shape> <agent[=model],...> [--chair <agent[=model]>] [--passes n] [--description text] [--project]";
	const [name, shape, membersToken, ...rest] = tokens;
	if (!name || !shape || !membersToken) return { ok: false, message: usage };
	const raw: Record<string, unknown> = { shape, members: membersToken.split(",").map((token) => token.trim()).filter(Boolean).map(parseMemberToken) };
	let scope: RosterScope = "user";
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index]!;
		if (flag === "--project") { scope = "project"; continue; }
		if (flag === "--user") { scope = "user"; continue; }
		const value = rest[index + 1];
		if (flag === "--chair" && value) { raw.chair = parseMemberToken(value); index++; continue; }
		if (flag === "--passes" && value) { raw.passes = Number(value); index++; continue; }
		if (flag === "--description") {
			const words: string[] = [];
			while (index + 1 < rest.length && !rest[index + 1]!.startsWith("--")) words.push(rest[++index]!);
			raw.description = words.join(" ");
			continue;
		}
		return { ok: false, message: `${usage}\nUnknown or incomplete option '${flag}'.` };
	}
	try {
		return { ok: true, scope, team: parseTeam(name, raw, "/roster team add") };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
