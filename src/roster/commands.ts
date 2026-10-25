/**
 * Fork addition (roster): the `/roster` slash command.
 *
 * Overview of every agent with its model chain and provenance, teams and their launch form,
 * team add/remove with a confirmed settings write, and launching a team in the background.
 * Per-agent model/fallbacks/thinking editing delegates to the existing `/subagents <agent>` admin.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleManagementAction } from "../agents/agent-management.ts";
import { discoverAgents } from "../agents/agents.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { buildActivityStatus } from "../runs/shared/activity-status-projection.ts";
import { canRenderComponents } from "../shared/extension-context.ts";
import { toModelInfo } from "../shared/model-info.ts";
import { SLASH_TEXT_RESULT_TYPE, SLASH_TEXT_VIEW_ONLY_DETAILS, type SubagentState } from "../shared/types.ts";
import { buildModelView } from "./model-view.ts";
import { parseTeamAddArgs, renderRosterOverview, renderTeam, rosterRowsFromCapabilities, type RosterRow } from "./overview.ts";
import { removeTeam, teamToSettings, writeTeam, type RosterScope } from "./settings.ts";
import type { RosterRuntime } from "./runtime.ts";
import { teamResourceName, type TeamDefinition } from "./teams.ts";
import { RosterComponent, type RosterComponentData, type RosterResult, type RosterTab } from "./tui.ts";
import { resolveMention, withMentionCompletions, type MentionCatalogue } from "./mentions.ts";

export interface RegisterRosterCommandsOptions {
	runtime: RosterRuntime;
	runCommand: (ctx: ExtensionContext, params: SubagentParamsLike) => Promise<void>;
	openAgentAdmin: (pi: ExtensionAPI, ctx: ExtensionContext, args: string) => Promise<void>;
	/** Whether activity entries carry the task preview (config.activityTaskPreview). */
	activityTaskPreview?: boolean;
	/** `@handle` prompt routing (config.mentions). Defaults to true. */
	mentions?: boolean;
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

	const writeTeamWithConfirm = async (ctx: ExtensionContext, scope: RosterScope, team: TeamDefinition, names: string[]): Promise<boolean> => {
		const unknown = [...team.members.map((member) => member.agent), ...(team.chair ? [team.chair.agent] : [])].filter((agent) => !names.includes(agent));
		const preview = JSON.stringify({ agentRoster: { teams: { [team.name]: teamToSettings(team) } } }, null, 2);
		const target = scope === "project" ? runtime.state().settings?.projectPath ?? "<project>/.pi/settings.json" : runtime.state().settings?.userPath ?? "~/.pi/agent/settings.json";
		const confirmed = ctx.hasUI
			? await ctx.ui.confirm(`Write team '${team.name}' to ${scope} settings?`, `${target}\n\n${preview}${unknown.length ? `\n\nWarning: unknown agents: ${unknown.join(", ")}` : ""}`)
			: true;
		if (!confirmed) { ctx.ui.notify("Team not written.", "info"); return false; }
		const filePath = writeTeam(ctx.cwd, scope, team);
		const refreshed = runtime.refresh(names);
		const registeredNote = refreshed.registered.includes(team.name) ? `Launch with subagent({ workflow: "${teamResourceName(team.name)}", args: { task } }).` : `Not registered this session: ${refreshed.warnings.join("; ") || "no session"}.`;
		send(pi, `Wrote team '${team.name}' (${team.shape}) to ${filePath}.\n${registeredNote}${unknown.length ? `\nWarning: unknown agents: ${unknown.join(", ")}` : ""}`);
		return true;
	};

	const runTeam = async (ctx: ExtensionContext, name: string, task: string): Promise<void> => {
		const current = runtime.state();
		if (!current.registered.includes(name)) {
			ctx.ui.notify(current.settings?.teams[name] ? `Team '${name}' is not registered this session (${current.warnings.join("; ") || "try /roster reload"}).` : `No team '${name}'.`, "error");
			return;
		}
		await options.runCommand(ctx, { workflow: teamResourceName(name), args: { task }, async: true });
	};

	/** Gather every tab's data. Pure views over the catalogue, registry, roster settings and the activity snapshot. */
	const collect = (ctx: ExtensionContext, rows: RosterRow[], names: string[]): RosterComponentData => {
		const current = runtime.refresh(names);
		const registry = ctx.modelRegistry?.getAvailable?.() ?? [];
		const models = buildModelView({
			models: registry.map((model) => toModelInfo(model)),
			agents: rows,
			modelScope: discoverAgents(ctx.cwd, "both", ctx.model?.provider).modelScope,
		});
		const teams = Object.values(current.settings?.teams ?? {}).map((team) => ({ team, registered: current.registered.includes(team.name) }));
		const runs = buildActivityStatus(state, ctx.sessionManager.getSessionId(), Date.now(), { taskPreview: options.activityTaskPreview !== false }).entries;
		const warnings = [...current.warnings, ...(current.settings?.diagnostics ?? []).map((diagnostic) => `${diagnostic.scope} ${diagnostic.path}: ${diagnostic.error}`)];
		return { agents: rows, models, teams, runs, warnings };
	};

	/** Interactive roster: select in the component, act outside it, reopen on the same tab. */
	const interactive = async (ctx: ExtensionContext, initialTab: RosterTab = "agents"): Promise<void> => {
		let tab: RosterTab = initialTab;
		for (;;) {
			const { snapshot, names } = catalogueNames(pi, ctx);
			const data = collect(ctx, snapshot, names);
			const result = await ctx.ui.custom<RosterResult>((tui, theme, kb, done) => new RosterComponent(tui, theme, kb, { ...data, initialTab: tab, done }), { overlay: false });
			if (!result || result.kind === "cancel") return;
			switch (result.kind) {
				case "agent": tab = "agents"; await options.openAgentAdmin(pi, ctx, result.name); break;
				case "model": {
					tab = "models";
					const row = data.models.rows.find((entry) => entry.id === result.id);
					const lines = [`Model ${result.id}`, ...(row?.primary.length ? [`Primary for: ${row.primary.join(", ")}`] : []), ...(row?.fallback.length ? [`Fallback for: ${row.fallback.join(", ")}`] : []), ...(row?.inScope === false ? ["Outside the enforced model scope: launches that resolve to it fail or fall back."] : []), "", "Assign it with /roster agent <name> → Change model / Change fallbacks."];
					send(pi, lines.join("\n"));
					break;
				}
				case "team-add": {
					tab = "teams";
					const line = await ctx.ui.input("New team: <name> <shape> <agent[=model],...> [--chair <agent[=model]>] [--passes n] [--description text] [--project]", "");
					if (!line?.trim()) break;
					const parsed = parseTeamAddArgs(line.trim().split(/\s+/));
					if (!parsed.ok) { ctx.ui.notify(parsed.message, "error"); break; }
					await writeTeamWithConfirm(ctx, parsed.scope, parsed.team, names);
					break;
				}
				case "team": {
					tab = "teams";
					const entry = data.teams.find(({ team }) => team.name === result.name);
					if (!entry) break;
					const choice = await ctx.ui.select(`Team ${result.name} (${entry.team.shape})`, ["Show compiled workflow", "Run with a task…", `Remove from ${entry.team.source ?? "user"} settings`, "Back"]);
					if (choice === "Show compiled workflow") send(pi, renderTeam(entry.team));
					else if (choice === "Run with a task…") {
						const task = await ctx.ui.input(`Task for team ${result.name}`, "");
						if (task?.trim()) { await runTeam(ctx, result.name, task.trim()); return; }
					} else if (choice?.startsWith("Remove")) {
						const scope: RosterScope = entry.team.source ?? "user";
						const confirmed = await ctx.ui.confirm(`Remove team '${result.name}' from ${scope} settings?`, "The team definition is deleted from the settings file; nothing else changes.");
						if (confirmed) {
							const removed = removeTeam(ctx.cwd, scope, result.name);
							runtime.refresh(names);
							send(pi, removed.removed ? `Removed team '${result.name}' from ${removed.path}.` : `No team '${result.name}' in ${removed.path}.`);
						}
					}
					break;
				}
				case "run":
					await options.runCommand(ctx, { action: "status", view: "fleet" });
					return;
			}
		}
	};

	const teamCommand = async (ctx: ExtensionContext, tokens: string[]): Promise<void> => {
		const [sub, ...rest] = tokens;
		if (!sub) { ctx.ui.notify("Usage: /roster team <name> | add ... | remove <name>", "error"); return; }
		if (sub === "add") {
			const parsed = parseTeamAddArgs(rest);
			if (!parsed.ok) { ctx.ui.notify(parsed.message, "error"); return; }
			const { names } = catalogueNames(pi, ctx);
			try {
				await writeTeamWithConfirm(ctx, parsed.scope, parsed.team, names);
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
			if (words.length === 1) return ["agents", "models", "teams", "runs", "agent", "team", "run", "text", "reload"].filter((word) => word.startsWith(prefix)).map((value) => ({ value, label: value }));
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
				if (!command) { if (canRenderComponents(ctx) && ctx.hasUI) await interactive(ctx); else overview(ctx); return; }
				if (command === "text" || command === "list" || command === "status") { overview(ctx); return; }
				if (command === "reload") { overview(ctx); return; }
				if (command === "models" || command === "runs" || (command === "teams" && rest.length === 0) || (command === "agents" && rest.length === 0)) {
					if (canRenderComponents(ctx) && ctx.hasUI) { await interactive(ctx, command as RosterTab); return; }
					overview(ctx); return;
				}
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
					await runTeam(ctx, name, task);
					return;
				}
				ctx.ui.notify(`Unknown /roster command '${command}'. Use /roster, /roster agent <name>, /roster team ..., /roster run <team> <task>, /roster reload.`, "error");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	// ---- @mention routing -----------------------------------------------------------------------
	const mentionCatalogue = (ctx: ExtensionContext): MentionCatalogue => {
		const { names } = catalogueNames(pi, ctx);
		const current = runtime.state().settings ?? runtime.refresh(names).settings;
		const liveRuns: Array<{ id: string; agent: string }> = [];
		for (const job of state.asyncJobs.values()) {
			if (job.status !== "running" && job.status !== "queued") continue;
			if (job.sessionId && state.currentSessionId && job.sessionId !== state.currentSessionId) continue;
			const agent = job.agents?.length === 1 ? job.agents[0] : job.steps?.length === 1 ? job.steps[0]?.agent : undefined;
			if (agent) liveRuns.push({ id: job.asyncId, agent });
		}
		return { agents: names, teams: Object.keys(current?.teams ?? {}), liveRuns };
	};
	// Hosts and test doubles may return nothing from pi.on; dispose tolerates that.
	const unsubscribes: Array<(() => void) | void | undefined> = [];
	if (options.mentions !== false) {
		unsubscribes.push(pi.on("input", async (event, ctx) => {
			if (event.source !== "interactive") return { action: "continue" };
			if (!/^\s*@/.test(event.text)) return { action: "continue" };
			const resolution = resolveMention(event.text, mentionCatalogue(ctx));
			switch (resolution.kind) {
				case "none": return { action: "continue" };
				case "main": return { action: "transform", text: resolution.text, ...(event.images ? { images: event.images } : {}) };
				case "empty": ctx.ui.notify(`Write the task after @${resolution.handle}, e.g. "@${resolution.handle} review the diff".`, "warning"); return { action: "handled" };
				case "ambiguous": ctx.ui.notify(`@${resolution.agent} has ${resolution.runIds.length} live runs (${resolution.runIds.join(", ")}); steer one with /subagents-steer <id> <message>.`, "warning"); return { action: "handled" };
				case "team": state.lastUiContext = ctx; await runTeam(ctx, resolution.name, resolution.task); return { action: "handled" };
				case "steer": state.lastUiContext = ctx; await options.runCommand(ctx, { action: "steer", id: resolution.runId, message: resolution.message }); return { action: "handled" };
				case "launch": state.lastUiContext = ctx; await options.runCommand(ctx, { agent: resolution.agent, task: resolution.task, async: true }); return { action: "handled" };
			}
		}));
		let completionsInstalled = false;
		unsubscribes.push(pi.on("session_start", (_event, ctx) => {
			if (completionsInstalled || !ctx.hasUI || typeof ctx.ui.addAutocompleteProvider !== "function") return;
			completionsInstalled = true;
			ctx.ui.addAutocompleteProvider((current) => withMentionCompletions(current, () => mentionCatalogue(ctx)));
		}));
	}

	return { dispose() { for (const unsubscribe of unsubscribes.splice(0)) if (typeof unsubscribe === "function") unsubscribe(); } };
}
