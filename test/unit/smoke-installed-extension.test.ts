import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installedExtensionPath } from "../smoke/installed-extension.mjs";

test("npm smoke resolves the scoped installed package rather than the upstream path", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-smoke-path-"));
	try {
		const installed = path.join(root, "extension/node_modules/@raviy06/pi-subagents");
		fs.mkdirSync(installed, { recursive: true });
		fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "@raviy06/pi-subagents" }));
		assert.equal(installedExtensionPath(root, "@raviy06/pi-subagents"), installed);
		assert.throws(() => installedExtensionPath(root, "pi-subagents"), /ENOENT/);
		assert.throws(() => installedExtensionPath(root, "../outside"), /Invalid package name/);
		fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "other-package" }));
		assert.throws(() => installedExtensionPath(root, "@raviy06/pi-subagents"), /Installed package identity mismatch/);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
