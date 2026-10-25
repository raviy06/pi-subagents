/**
 * Fork addition (roster): the tabbed `/roster` component.
 *
 * Four tabs over data the command prepares: Agents (model chain, thinking, provenance flags),
 * Models (registry models with assignments, scope and pre-launch problems), Teams (shape, members,
 * registration) and Runs (the public activity snapshot). The component only selects; the command
 * performs the chosen action after it closes, so no write ever happens inside the view.
 *
 * Keys: ↑/↓ move, Enter select, Esc cancel, Tab / Shift-Tab / ←/→ switch tabs, type to filter.
 */
import { DynamicBorder, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, type KeybindingsManager, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ActivityEntry } from "../runs/shared/activity-status-model.ts";
import type { ModelView } from "./model-view.ts";
import type { RosterRow } from "./overview.ts";
import type { TeamDefinition } from "./teams.ts";

export type RosterTab = "agents" | "models" | "teams" | "runs";
const TABS: Array<{ id: RosterTab; title: string }> = [
	{ id: "agents", title: "Agents" },
	{ id: "models", title: "Models" },
	{ id: "teams", title: "Teams" },
	{ id: "runs", title: "Runs" },
];

export type RosterResult =
	| { kind: "agent"; name: string }
	| { kind: "model"; id: string }
	| { kind: "team"; name: string }
	| { kind: "team-add" }
	| { kind: "run"; key: string }
	| { kind: "cancel" };

export interface RosterComponentData {
	agents: RosterRow[];
	models: ModelView;
	teams: Array<{ team: TeamDefinition; registered: boolean }>;
	runs: ActivityEntry[];
	warnings: string[];
	initialTab?: RosterTab;
}

export interface RosterComponentOptions extends RosterComponentData {
	done: (result: RosterResult) => void;
}

interface Row {
	searchText: string;
	label: string;
	detail: string;
	result: RosterResult;
	pinned?: boolean;
}

const MAX_VISIBLE = 12;

export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${seconds}s`;
}

export class RosterComponent extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly data: RosterComponentData;
	private readonly done: (result: RosterResult) => void;
	private readonly tabsLine: Text;
	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private readonly notesContainer: Container;
	private tab: RosterTab;
	private rows: Row[] = [];
	private filtered: Row[] = [];
	private selectedIndex = 0;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, options: RosterComponentOptions) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.data = options;
		this.done = options.done;
		this.tab = options.initialTab ?? "agents";

		const border = () => new DynamicBorder((str) => theme.fg("border", str));
		this.addChild(border());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Roster")), 0, 0));
		this.tabsLine = new Text("", 0, 0);
		this.addChild(this.tabsLine);
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.searchInput.onSubmit = () => this.confirmSelection();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.notesContainer = new Container();
		this.addChild(this.notesContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${rawKeyHint("↑↓", "move")}  ${rawKeyHint("Tab ←→", "tab")}  ${keyHint("tui.select.confirm", "open")}  ${keyHint("tui.select.cancel", "close")}  ${rawKeyHint("type", "filter")}`, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(border());
		this.switchTab(this.tab);
	}

	private buildRows(): Row[] {
		const th = this.theme;
		switch (this.tab) {
			case "agents": {
				const order: RosterRow["source"][] = ["project", "user", "package", "runtime", "builtin"];
				return [...this.data.agents]
					.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source) || a.name.localeCompare(b.name))
					.map((agent) => ({
						searchText: `${agent.name} ${agent.source} ${agent.modelChain} ${agent.flags.join(" ")}`,
						label: agent.name,
						detail: [th.fg("muted", agent.source), agent.modelChain, ...(agent.thinking ? [th.fg("muted", agent.thinking)] : []), ...(agent.flags.length ? [th.fg("warning", agent.flags.join("; "))] : [])].join(" · "),
						result: { kind: "agent", name: agent.name },
					}));
			}
			case "models":
				return this.data.models.rows.map((model) => {
					const parts: string[] = [th.fg("muted", model.provider)];
					if (model.primary.length) parts.push(`primary: ${model.primary.join(", ")}`);
					if (model.fallback.length) parts.push(`fallback: ${model.fallback.join(", ")}`);
					if (model.inScope === false) parts.push(th.fg("warning", "out of scope"));
					else if (model.inScope === true) parts.push(th.fg("success", "in scope"));
					return { searchText: `${model.id} ${model.provider} ${model.primary.join(" ")} ${model.fallback.join(" ")}`, label: model.id, detail: parts.join(" · "), result: { kind: "model", id: model.id } };
				});
			case "teams":
				return [
					{ searchText: "add new team", label: th.fg("accent", "+ Add a team"), detail: th.fg("muted", "/roster team add …"), result: { kind: "team-add" }, pinned: true },
					...this.data.teams
						.sort((a, b) => a.team.name.localeCompare(b.team.name))
						.map(({ team, registered }) => ({
							searchText: `${team.name} ${team.shape} ${team.members.map((member) => member.agent).join(" ")} ${team.chair?.agent ?? ""}`,
							label: team.name,
							detail: [th.fg("muted", `${team.shape}, ${team.source ?? "user"}`), ...(team.chair ? [`chair ${team.chair.agent}`] : []), team.members.map((member) => member.agent).join(", "), ...(registered ? [] : [th.fg("warning", "not registered")])].join(" · "),
							result: { kind: "team", name: team.name } as RosterResult,
						})),
				];
			case "runs":
				return this.data.runs.map((run) => {
					const parts: string[] = [run.state === "running" || run.state === "queued" || run.state === "stopping" ? th.fg("success", run.state) : th.fg("muted", run.state)];
					if (run.task) parts.push(run.task);
					if (run.activity?.tool) parts.push(th.fg("muted", `last: ${run.activity.tool}`));
					if (run.elapsedMs !== undefined) parts.push(th.fg("muted", formatElapsed(run.elapsedMs)));
					if (run.model?.fallbackReason && run.model.effective) parts.push(th.fg("warning", `↷ ${run.model.effective} (${run.model.fallbackReason})`));
					return { searchText: `${run.agent} ${run.state} ${run.task ?? ""}`, label: run.agent, detail: parts.join(" · "), result: { kind: "run", key: run.key } };
				});
		}
	}

	private buildNotes(): string[] {
		const th = this.theme;
		const notes: string[] = [];
		if (this.tab === "models") {
			const view = this.data.models;
			for (const entry of view.unregistered) notes.push(th.fg("warning", `unregistered: ${entry.id} (${entry.agents.join(", ")})${entry.role === "fallback" ? " [fallback]" : ""}`));
			for (const entry of view.willFallBack) notes.push(th.fg("warning", `${entry.agent}: ${entry.from} → ${entry.to} (${entry.reason})`));
			if (view.inherit.length) notes.push(th.fg("muted", `inherit: ${view.inherit.join(", ")}`));
		}
		if (this.data.warnings.length) notes.push(...this.data.warnings.map((warning) => th.fg("warning", warning)));
		return notes;
	}

	private switchTab(tab: RosterTab): void {
		this.tab = tab;
		this.rows = this.buildRows();
		this.selectedIndex = 0;
		this.searchInput.setValue("");
		this.tabsLine.setText(TABS.map((entry) => entry.id === tab ? this.theme.fg("accent", this.theme.bold(`[${entry.title}]`)) : this.theme.fg("muted", ` ${entry.title} `)).join("  "));
		this.applyFilter("");
	}

	private applyFilter(query: string): void {
		const pinned = this.rows.filter((row) => row.pinned);
		const rest = this.rows.filter((row) => !row.pinned);
		this.filtered = [...pinned, ...(query ? fuzzyFilter(rest, query, (row) => row.searchText) : rest)];
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private emptyText(): string {
		switch (this.tab) {
			case "agents": return "No agents discovered";
			case "models": return "No models in the host registry";
			case "teams": return "No teams yet";
			case "runs": return "No active or recent runs";
		}
	}

	private updateList(): void {
		const th = this.theme;
		this.listContainer.clear();
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE));
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filtered.length);
		for (let index = startIndex; index < endIndex; index++) {
			const row = this.filtered[index]!;
			const selected = index === this.selectedIndex;
			const label = selected ? th.fg("accent", row.label) : row.label;
			this.listContainer.addChild(new Text(`${selected ? th.fg("accent", "→ ") : "  "}${label} ${th.fg("muted", "·")} ${row.detail}`, 0, 0));
		}
		if (startIndex > 0 || endIndex < this.filtered.length) this.listContainer.addChild(new Text(th.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0));
		if (this.filtered.length === 0) this.listContainer.addChild(new Text(th.fg("muted", `  ${this.rows.length === 0 ? this.emptyText() : "No matching entries"}`), 0, 0));
		this.notesContainer.clear();
		const notes = this.buildNotes();
		if (notes.length) {
			this.notesContainer.addChild(new Spacer(1));
			for (const note of notes.slice(0, 6)) this.notesContainer.addChild(new Text(`  ${note}`, 0, 0));
		}
	}

	private confirmSelection(): void {
		const selected = this.filtered[this.selectedIndex];
		if (selected) this.done(selected.result);
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
		this.updateList();
		this.tui.requestRender();
	}

	private cycleTab(delta: number): void {
		const index = TABS.findIndex((entry) => entry.id === this.tab);
		this.switchTab(TABS[(index + delta + TABS.length) % TABS.length]!.id);
		this.tui.requestRender();
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.up")) this.move(-1);
		else if (kb.matches(keyData, "tui.select.down")) this.move(1);
		else if (kb.matches(keyData, "tui.select.confirm")) this.confirmSelection();
		else if (kb.matches(keyData, "tui.select.cancel")) this.done({ kind: "cancel" });
		else if (keyData === "\t" || keyData === "\x1b[C") this.cycleTab(1);
		else if (keyData === "\x1b[Z" || keyData === "\x1b[D") this.cycleTab(-1);
		else {
			this.searchInput.handleInput(keyData);
			this.applyFilter(this.searchInput.getValue());
			this.tui.requestRender();
		}
	}
}
