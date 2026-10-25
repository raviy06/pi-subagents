/**
 * Fork addition (roster): teams as data.
 *
 * A team is a named, reusable set of agents plus a shape. Teams live in pi settings under
 * `agentRoster.teams` (user `~/.pi/agent/settings.json`, project `.pi/settings.json`; project wins
 * by name) and compile to ordinary workflow scripts that are registered as named workflow
 * resources (`team.<name>`), so the model launches one with
 * `subagent({ workflow: "team.<name>", args: { task } })`.
 *
 * Compilation is static: every child key, agent and model is a literal in the script, so the
 * existing workflow validator checks the whole team before anything launches. Named resources are
 * expansions (the executor drops `args` after `resolve`), so the task is embedded as a JSON string
 * literal; it is never interpolated into code.
 */

export const TEAM_RESOURCE_PREFIX = "team.";
export const TEAM_SHAPES = ["parallel", "council", "pipeline"] as const;
export type TeamShape = typeof TEAM_SHAPES[number];
export const MAX_TEAM_MEMBERS = 8;
export const MAX_COUNCIL_PASSES = 3;
const TEAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface TeamMember {
	agent: string;
	/** Per-member model override (`provider/id[:thinking]`); otherwise the agent's own assignment applies. */
	model?: string;
}

export interface TeamDefinition {
	name: string;
	shape: TeamShape;
	description?: string;
	members: TeamMember[];
	/** Council only: synthesises member positions and writes the memo. */
	chair?: TeamMember;
	/** Council only: total chair rounds (1 = no cross-examination). Default 2. */
	passes?: number;
	/** Set by merging: which settings scope supplied this definition. */
	source?: "user" | "project";
}

export type TeamSet = Record<string, TeamDefinition>;

export function teamResourceName(name: string): string {
	return `${TEAM_RESOURCE_PREFIX}${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMember(value: unknown, where: string): TeamMember {
	const record = typeof value === "string" ? { agent: value } : value;
	if (!isRecord(record)) throw new Error(`${where} must be an agent name or an object with 'agent'.`);
	for (const key of Object.keys(record)) {
		if (key !== "agent" && key !== "model") throw new Error(`${where} has unknown field '${key}'.`);
	}
	const agent = record.agent;
	if (typeof agent !== "string" || !AGENT_NAME_PATTERN.test(agent.trim())) throw new Error(`${where} needs a valid 'agent' name.`);
	const member: TeamMember = { agent: agent.trim() };
	if (record.model !== undefined) {
		if (typeof record.model !== "string" || !record.model.trim()) throw new Error(`${where} has invalid 'model'; expected a non-empty string.`);
		member.model = record.model.trim();
	}
	return member;
}

const TEAM_FIELDS = new Set(["shape", "description", "members", "chair", "passes"]);

export function parseTeam(name: string, value: unknown, where: string): TeamDefinition {
	if (!TEAM_NAME_PATTERN.test(name)) throw new Error(`${where} team '${name}' has an invalid name; use letters, digits, '.', '_' or '-' (max 64).`);
	const at = `${where} team '${name}'`;
	if (!isRecord(value)) throw new Error(`${at} must be an object.`);
	for (const key of Object.keys(value)) {
		if (!TEAM_FIELDS.has(key)) throw new Error(`${at} has unknown field '${key}'.`);
	}
	if (typeof value.shape !== "string" || !(TEAM_SHAPES as readonly string[]).includes(value.shape)) {
		throw new Error(`${at} has invalid 'shape'; expected one of ${TEAM_SHAPES.join(", ")}.`);
	}
	const shape = value.shape as TeamShape;
	if (!Array.isArray(value.members) || value.members.length === 0) throw new Error(`${at} needs at least one member.`);
	if (value.members.length > MAX_TEAM_MEMBERS) throw new Error(`${at} lists ${value.members.length} members; at most ${MAX_TEAM_MEMBERS} are allowed.`);
	const members = value.members.map((member, index) => parseMember(member, `${at} members[${index}]`));
	const team: TeamDefinition = { name, shape, members };
	if (value.description !== undefined) {
		if (typeof value.description !== "string") throw new Error(`${at} has invalid 'description'; expected a string.`);
		if (value.description.trim()) team.description = value.description.trim();
	}
	if (value.chair !== undefined) team.chair = parseMember(value.chair, `${at} chair`);
	if (value.passes !== undefined) {
		if (!Number.isSafeInteger(value.passes) || (value.passes as number) < 1 || (value.passes as number) > MAX_COUNCIL_PASSES) {
			throw new Error(`${at} has invalid 'passes'; expected an integer from 1 to ${MAX_COUNCIL_PASSES}.`);
		}
		team.passes = value.passes as number;
	}
	if (shape === "council") {
		if (!team.chair) throw new Error(`${at}: a council needs a 'chair'.`);
		if (members.length < 2) throw new Error(`${at}: a council needs at least two members.`);
	}
	return team;
}

export function parseTeams(value: unknown, where: string): TeamSet {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw new Error(`${where} must be an object keyed by team name.`);
	const teams: TeamSet = {};
	for (const [name, definition] of Object.entries(value)) teams[name] = parseTeam(name, definition, where);
	return teams;
}

/** Project definitions replace user definitions of the same name; everything else is kept. */
export function mergeTeamSets(user: TeamSet, project: TeamSet): TeamSet {
	const merged: TeamSet = {};
	for (const [name, team] of Object.entries(user)) merged[name] = { ...team, source: "user" };
	for (const [name, team] of Object.entries(project)) merged[name] = { ...team, source: "project" };
	return merged;
}

// ---- compilation -------------------------------------------------------------------------------

const q = (value: string): string => JSON.stringify(value);

/** Distinct literal child keys for members, even when the same agent appears twice. */
export function memberKeys(members: readonly TeamMember[]): string[] {
	const seen = new Map<string, number>();
	return members.map((member) => {
		const count = (seen.get(member.agent) ?? 0) + 1;
		seen.set(member.agent, count);
		return count === 1 ? member.agent : `${member.agent}-${count}`;
	});
}

function childLiteral(key: string, member: TeamMember, taskExpression: string): string {
	return `{ key: ${q(key)}, agent: ${q(member.agent)}${member.model ? `, model: ${q(member.model)}` : ""}, task: ${taskExpression} }`;
}

function resumeOrFreshLiteral(key: string, member: TeamMember, previous: string, taskExpression: string, freshTaskExpression: string): string {
	return `${previous}.runId ? { key: ${q(key)}, resume: ${previous}.runId, task: ${taskExpression} } : ${childLiteral(key, member, freshTaskExpression)}`;
}

const MEMBER_BRIEF = "Give your independent position, the strongest evidence for it, and the single biggest risk. Be concise and concrete.";
const CHAIR_BRIEF = "You chair this council. Do not add new positions. From the member responses below, list agreements, disputed claims that change the recommendation, missing proof, and then one recommendation. Keep every claim attributed to its member.";
const CHALLENGE_BRIEF = "The chair summarised the council as follows. Respond only to disputed claims that affect the recommendation: concede with reasons, or defend with evidence. Do not restate agreed points.";

function compileParallel(team: TeamDefinition, args: TeamRunArgs): string {
	const keys = memberKeys(team.members);
	const children = team.members.map((member, index) => `\t${childLiteral(keys[index]!, member, "task")},`).join("\n");
	return [
		`const task = ${q(args.task)};`,
		`const results = await runs.all([`,
		children,
		`]);`,
		`const members = ${JSON.stringify(team.members.map((member) => member.agent))};`,
		`return { team: ${q(team.name)}, shape: "parallel", members, results: results.map((result, index) => ({ member: members[index], runId: result.runId, output: result.output })) };`,
	].join("\n");
}

function compilePipeline(team: TeamDefinition, args: TeamRunArgs): string {
	const keys = memberKeys(team.members);
	const lines = [`const task = ${q(args.task)};`, `const stages = [];`];
	team.members.forEach((member, index) => {
		const variable = `stage${index + 1}`;
		const taskExpression = index === 0
			? "task"
			: `"Previous stage (" + ${q(team.members[index - 1]!.agent)} + ") output:\\n" + stage${index}.output + "\\n\\nYour task: " + task`;
		lines.push(`const ${variable} = await runs.run(${q(keys[index]!)}, { agent: ${q(member.agent)}${member.model ? `, model: ${q(member.model)}` : ""}, task: ${taskExpression} });`);
		lines.push(`stages.push({ member: ${q(member.agent)}, runId: ${variable}.runId, output: ${variable}.output });`);
	});
	lines.push(`return { team: ${q(team.name)}, shape: "pipeline", stages, output: stage${team.members.length}.output };`);
	return lines.join("\n");
}

function compileCouncil(team: TeamDefinition, args: TeamRunArgs): string {
	const chair = team.chair!;
	const passes = team.passes ?? 2;
	const keys = memberKeys(team.members);
	const memberNames = JSON.stringify(team.members.map((member) => member.agent));
	const chairChild = (key: string, taskExpression: string) => `await runs.run(${q(key)}, { agent: ${q(chair.agent)}${chair.model ? `, model: ${q(chair.model)}` : ""}, task: ${taskExpression} });`;
	const lines = [
		`const task = ${q(args.task)};`,
		`const members = ${memberNames};`,
		`const brief = "Council question:\\n" + task;`,
		`const positions = (round) => members.map((name, index) => "### " + name + "\\n" + round[index].output).join("\\n\\n");`,
		`const rounds = [];`,
		`const pass1 = await runs.all([`,
		...team.members.map((member, index) => `\t${childLiteral(keys[index]!, member, `brief + "\\n\\n" + ${q(MEMBER_BRIEF)}`)},`),
		`]);`,
		`rounds.push(positions(pass1));`,
		`let memo = ${chairChild("chair-1", `${q(CHAIR_BRIEF)} + "\\n\\n" + brief + "\\n\\n" + positions(pass1)`)}`,
		`let latest = pass1;`,
	];
	for (let pass = 2; pass <= passes; pass++) {
		const previous = `pass${pass - 1}`;
		const current = `pass${pass}`;
		lines.push(
			`const ${current} = await runs.all([`,
			...team.members.map((member, index) => `\t${resumeOrFreshLiteral(
				`${keys[index]!}-p${pass}`,
				member,
				`${previous}[${index}]`,
				`${q(CHALLENGE_BRIEF)} + "\\n\\n" + memo.output`,
				`brief + "\\n\\nYour earlier position:\\n" + ${previous}[${index}].output + "\\n\\n" + ${q(CHALLENGE_BRIEF)} + "\\n\\n" + memo.output`,
			)},`),
			`]);`,
			`rounds.push(positions(${current}));`,
			`memo = ${chairChild(`chair-${pass}`, `${q(CHAIR_BRIEF)} + "\\n\\n" + brief + "\\n\\nRound ${pass} responses:\\n" + positions(${current}) + "\\n\\nPrevious memo:\\n" + memo.output`)}`,
			`latest = ${current};`,
		);
	}
	lines.push(`return { team: ${q(team.name)}, shape: "council", chair: ${q(chair.agent)}, members, passes: ${passes}, rounds, memo: memo.output, memoRunId: memo.runId, memberRunIds: latest.map((result) => result.runId) };`);
	return lines.join("\n");
}

export interface TeamRunArgs {
	task: string;
}

/** Validate the plain-JSON args a team resource accepts. */
export function parseTeamRunArgs(args: Readonly<Record<string, unknown>>): TeamRunArgs | { error: string } {
	for (const key of Object.keys(args)) if (key !== "task") return { error: `Team workflows accept only 'task'; unknown field '${key}'.` };
	if (typeof args.task !== "string" || !args.task.trim()) return { error: "Team workflows need a non-empty string 'task'." };
	return { task: args.task };
}

/** Compile a team to a workflow script with the validated task embedded as a string literal. */
export function compileTeamScript(team: TeamDefinition, args: TeamRunArgs): string {
	if (!args.task.trim()) throw new Error("Team workflows need a non-empty task.");
	switch (team.shape) {
		case "parallel": return compileParallel(team, args);
		case "pipeline": return compilePipeline(team, args);
		case "council": return compileCouncil(team, args);
	}
}

/** Workflow receipts accept resource versions from 1 to 1,000,000. */
export const MAX_TEAM_RESOURCE_VERSION = 1_000_000;

/** Stable version for resource registration: changes whenever the definition changes (bounded for receipts). */
export function teamDefinitionVersion(team: TeamDefinition): number {
	const { source: _source, ...definition } = team;
	const text = JSON.stringify(definition);
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return (hash % MAX_TEAM_RESOURCE_VERSION) + 1;
}
