import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test("fork release identity is scoped, versioned and synchronized without changing upstream attribution", () => {
	const pkg = JSON.parse(read("package.json"));
	const lock = JSON.parse(read("package-lock.json"));
	assert.equal(pkg.name, "@raviy06/pi-subagents");
	assert.equal(pkg.version, "0.81.1");
	assert.equal(pkg.private, true, "publish only the built distribution");
	assert.equal(pkg.bin, undefined, "do not expose the shared upstream installer bin");
	assert.equal(pkg.repository.url, "git+https://github.com/raviy06/pi-subagents.git");
	assert.equal(pkg.author, "Nico Bailon");
	assert.equal(pkg.license, "MIT");
	for (const manifest of [lock, lock.packages[""]]) {
		assert.equal(manifest.name, pkg.name); assert.equal(manifest.version, pkg.version);
	}
	assert.equal(lock.packages[""].bin, undefined);
	assert.ok(read("CHANGELOG.md").includes(`## [${pkg.version}] - `));
});

test("fork legacy installer refuses mutation even when invoked with --remove", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "fork-installer-safety-"));
	try {
		const installed = path.join(home, ".pi/agent/extensions/subagent");
		fs.mkdirSync(installed, { recursive: true });
		fs.writeFileSync(path.join(installed, "keep"), "upstream installation");
		const result = spawnSync(process.execPath, [path.join(root, "install.mjs"), "--remove"], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /pi install/);
		assert.equal(fs.readFileSync(path.join(installed, "keep"), "utf8"), "upstream installation");
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("fork publishing requires successful main CI and verifies its protected scoped artifact", () => {
	const workflow = read(".github/workflows/release.yml");
	assert.match(workflow, /workflow_dispatch:/);
	assert.match(workflow, /github\.repository == 'raviy06\/pi-subagents'/);
	assert.match(workflow, /workflow_run:/);
	assert.match(workflow, /environment: npm/);
	assert.match(workflow, /conclusion == 'success'/);
	assert.match(workflow, /Require successful main CI for this exact commit/);
	assert.doesNotMatch(workflow, /pull_request_target/);
	assert.match(workflow, /@raviy06\/pi-subagents/);
	assert.match(workflow, /npm publish \.\/dist-pkg --provenance --access public/);
});
