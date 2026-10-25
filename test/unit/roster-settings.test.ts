import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readRosterSettings, writeTeam, removeTeam, ROSTER_SETTINGS_KEY } from "../../src/roster/settings.ts";

let home: string;
let project: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "roster-home-"));
	project = fs.mkdtempSync(path.join(os.tmpdir(), "roster-project-"));
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
});
afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(project, { recursive: true, force: true });
});

const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

describe("roster settings", () => {
	it("reads user and project teams, merges project over user, and reports paths", () => {
		write(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), { [ROSTER_SETTINGS_KEY]: { teams: { a: { shape: "parallel", members: ["x"] }, b: { shape: "parallel", members: ["y"] } } } });
		write(path.join(project, ".pi", "settings.json"), { [ROSTER_SETTINGS_KEY]: { teams: { b: { shape: "pipeline", members: ["z"] } } } });
		const roster = readRosterSettings(project);
		assert.equal(roster.userPath, path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"));
		assert.equal(roster.projectPath, path.join(project, ".pi", "settings.json"));
		assert.deepEqual(Object.keys(roster.teams).sort(), ["a", "b"]);
		assert.equal(roster.teams.b?.shape, "pipeline");
		assert.equal(roster.teams.b?.source, "project");
		assert.deepEqual(roster.diagnostics, []);
	});

	it("keeps a malformed scope as a diagnostic instead of failing the whole roster", () => {
		write(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), { [ROSTER_SETTINGS_KEY]: { teams: { ok: { shape: "parallel", members: ["x"] } } } });
		write(path.join(project, ".pi", "settings.json"), { [ROSTER_SETTINGS_KEY]: { teams: { bad: { shape: "circle", members: ["x"] } } } });
		const roster = readRosterSettings(project);
		assert.deepEqual(Object.keys(roster.teams), ["ok"]);
		assert.equal(roster.diagnostics.length, 1);
		assert.match(roster.diagnostics[0]!.error, /shape/);
		assert.equal(roster.diagnostics[0]!.scope, "project");
	});

	it("ignores unrelated settings and tolerates a missing key", () => {
		write(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), { subagents: { agentOverrides: {} } });
		const roster = readRosterSettings(project);
		assert.deepEqual(roster.teams, {});
		assert.deepEqual(roster.diagnostics, []);
	});

	it("writes and removes a team in the chosen scope without disturbing other settings", () => {
		const userPath = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
		write(userPath, { subagents: { agentOverrides: { worker: { model: "a/b" } } }, [ROSTER_SETTINGS_KEY]: { teams: { keep: { shape: "parallel", members: ["x"] } } } });
		const written = writeTeam(project, "user", { name: "pair", shape: "parallel", members: [{ agent: "reviewer" }, { agent: "scout", model: "c/d" }] });
		assert.equal(written, userPath);
		const after = JSON.parse(fs.readFileSync(userPath, "utf8"));
		assert.deepEqual(after.subagents, { agentOverrides: { worker: { model: "a/b" } } });
		assert.deepEqual(after[ROSTER_SETTINGS_KEY].teams.pair, { shape: "parallel", members: [{ agent: "reviewer" }, { agent: "scout", model: "c/d" }] });
		assert.ok(after[ROSTER_SETTINGS_KEY].teams.keep);

		assert.equal(removeTeam(project, "user", "pair").removed, true);
		assert.equal(removeTeam(project, "user", "pair").removed, false);
		assert.equal(JSON.parse(fs.readFileSync(userPath, "utf8"))[ROSTER_SETTINGS_KEY].teams.pair, undefined);

		const projectPath = writeTeam(project, "project", { name: "p", shape: "pipeline", members: [{ agent: "worker" }] });
		assert.equal(projectPath, path.join(project, ".pi", "settings.json"));
		assert.equal(readRosterSettings(project).teams.p?.source, "project");
	});
});
