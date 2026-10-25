/**
 * Fork addition (roster): the `/roster` slash command.
 *
 * Overview of every agent with its model chain and provenance, teams and their launch form,
 * team add/remove with a confirmed settings write, and launching a team in the background.
 * Per-agent model/fallbacks/thinking editing delegates to the existing `/subagents <agent>` admin.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleManagementAction } from "../agents/agent-management.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { SLASH_TEXT_RESULT_TYPE, SLASH_TEXT_VIEW_ONLY_DETAILS, type SubagentState } from "../shared/types.ts";
import { parseTeamAddArgs, renderRosterOverview, renderTeam, rosterRowsFromCapabilities } from "./overview.ts";
import { removeTeam, teamToSettings, writeTeam, type RosterScope } from "./settings.ts";
import type { RosterRuntime } from "./runtime.ts";
import { teamResourceName } from "./teams.ts";

export interface RegisterRosterCommandsOptions {
	runtime: RosterRuntime;
	runCommand: (ctx: ExtensionContext, params: SubagentParamsLike) => Promise<void>;
	openAgentAdmin: (pi: ExtensionAPI, ctx: ExtensionContext, args: string) => Promise<void>;
}

function send(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true, details: SLASH_TEXT_VIEW_ONLY_DETAILS });
}

function catalogueNames(pi: ExtensionAPI, ctx: ExtensionContext): { snapshot: ReturnType<typeof rosterRowsFromCapabilities>; names: string[] } {
	const listed = handleManagementAction("list", { agentScope: "both", capabilities: true }, { cwd: ctx.cwd, modelRegistry: ctx.modelRegistry, model: ctx.model, runtimeAgentOwner: pi });
	const capabilities = listed.details?.agentCapabilities;
	const rows = capabilities ? rosterRowsFromCapabilities(capabilities) : [];
	return { snapshot: rows, names: rows.filter((row) => !row.flags.includes("disabled")).map((row) => row.name) };
}

function scopeFlag(tokens: string[]): { scope: RosterScope; rest: string[] } {
	const scope: RosterScope = tokens.includes("--project") ? "project" : "user";
	return { scope, rest: tokens.filter((token) => token !== "--project" && token !== "--user") };
}

export function registerRosterCommands(pi: ExtensionAPI, state: SubagentState, options: RegisterRosterCommandsOptions): { dispose(): void } {
	const { runtime } = options;

	const overview = (ctx: ExtensionContext): void => {
		const { snapshot, names } = catalogueNames(pi, ctx);
		const current = runtime.refresh(names);
		send(pi, renderRosterOverview({
			rows: snapshot,
			teams: current.settings?.teams ?? {},
			diagnostics: current.settings?.diagnostics ?? [],
			registered: current.registered,
			warnings: current.warnings,
		}));
	};

	const teamCommand = async (ctx: ExtensionContext, tokens: string[]): Promise<void> => {
		const [sub, ...rest] = tokens;
		if (!sub) { ctx.ui.notify("Usage: /roster team <name> | add ... | remove <name>", "error"); return; }
		if (sub === "add") {
			const parsed = parseTeamAddArgs(rest);
			if (!parsed.ok) { ctx.ui.notify(parsed.message, "error"); return; }
			const { names } = catalogueNames(pi, ctx);
			const unknown = [...parsed.team.members.map((member) => member.agent), ...(parsed.team.chair ? [parsed.team.chair.agent] : [])].filter((agent) => !names.includes(agent));
			const preview = JSON.stringify({ agentRoster: { teams: { [parsed.team.name]: teamToSettings(parsed.team) } } }, null, 2);
			const target = parsed.scope === "project" ? runtime.state().settings?.projectPath ?? "<project>/.pi/settings.json" : runtime.state().settings?.userPath ?? "~/.pi/agent/settings.json";
			const confirmed = ctx.hasUI
				? await ctx.ui.confirm(`Write team '${parsed.team.name}' to ${parsed.scope} settings?`, `${target}\n\n${preview}${unknown.length ? `\n\nWarning: unknown agents: ${unknown.join(", ")}` : ""}`)
				: true;
			if (!confirmed) { ctx.ui.notify("Team not written.", "info"); return; }
			try {
				const filePath = writeTeam(ctx.cwd, parsed.scope, parsed.team);
				const refreshed = runtime.refresh(names);
				const registeredNote = refreshed.registered.includes(parsed.team.name) ? `Launch with subagent({ workflow: "${teamResourceName(parsed.team.name)}", args: { task } }).` : `Not registered this session: ${refreshed.warnings.join("; ") || "no session"}.`;
				send(pi, `Wrote team '${parsed.team.name}' (${parsed.team.shape}) to ${filePath}.\n${registeredNote}${unknown.length ? `\nWarning: unknown agents: ${unknown.join(", ")}` : ""}`);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			return;
		}
		if (sub === "remove" || sub === "rm" || sub === "delete") {
			const { scope, rest: names } = scopeFlag(rest);
			const name = names[0];
			if (!name) { ctx.ui.notify("Usage: /roster team remove <name> [--project]", "error"); return; }
			const confirmed = ctx.hasUI ? await ctx.ui.confirm(`Remove team '${name}' from ${scope} settings?`, "The team definition is deleted from the settings file; nothing else changes.") : true;
			if (!confirmed) return;
			try {
				const result = removeTeam(ctx.cwd, scope, name);
				runtime.refresh();
				send(pi, result.removed ? `Removed team '${name}' from ${result.path}.` : `No team '${name}' in ${result.path}.`);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			return;
		}
		const current = runtime.state().settings ?? runtime.refresh().settings;
		const team = current?.teams[sub];
		if (!team) { ctx.ui.notify(`No team '${sub}'. Teams: ${Object.keys(current?.teams ?? {}).join(", ") || "(none)"}`, "error"); return; }
		send(pi, renderTeam(team));
	};

	pi.registerCommand("roster", {
		description: "Agent roster: models, fallbacks, teams; /roster team add|remove, /roster run <team> <task>",
		getArgumentCompletions: (prefix) => {
			const words = prefix.split(/\s+/);
			if (words.length === 1) return ["agent", "team", "run", "reload"].filter((word) => word.startsWith(prefix)).map((value) => ({ value, label: value }));
			const [first, second] = words;
			if (words.length === 2 && (first === "team" || first === "run")) {
				const teams = Object.keys(runtime.state().settings?.teams ?? {});
				const options = first === "team" ? ["add", "remove", ...teams] : teams;
				return options.filter((option) => option.startsWith(second ?? "")).map((option) => ({ value: `${first} ${option}`, label: option }));
			}
			if (words.length === 2 && first === "agent" && state.baseCwd) {
				const { names } = catalogueNames(pi, state.lastUiContext ?? ({ cwd: state.baseCwd } as ExtensionContext));
				return names.filter((name) => name.startsWith(second ?? "")).map((name) => ({ value: `agent ${name}`, label: name }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			state.lastUiContext = ctx;
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [command, ...rest] = tokens;
			try {
				if (!command || command === "list" || command === "status") { overview(ctx); return; }
				if (command === "reload") { overview(ctx); return; }
				if (command === "agent" || command === "agents") {
					if (!rest[0]) { overview(ctx); return; }
					await options.openAgentAdmin(pi, ctx, rest.join(" "));
					return;
				}
				if (command === "team" || command === "teams") { await teamCommand(ctx, rest); return; }
				if (command === "run") {
					const [name, ...taskWords] = rest;
					const task = taskWords.join(" ").trim();
					if (!name || !task) { ctx.ui.notify("Usage: /roster run <team> <task...>", "error"); return; }
					const current = runtime.state();
					if (!current.registered.includes(name)) {
						ctx.ui.notify(current.settings?.teams[name] ? `Team '${name}' is not registered this session (${current.warnings.join("; ") || "try /roster reload"}).` : `No team '${name}'.`, "error");
						return;
					}
					await options.runCommand(ctx, { workflow: teamResourceName(name), args: { task }, async: true });
					return;
				}
				ctx.ui.notify(`Unknown /roster command '${command}'. Use /roster, /roster agent <name>, /roster team ..., /roster run <team> <task>, /roster reload.`, "error");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	return { dispose() { /* pi owns command registrations for the runtime lifetime */ } };
}
