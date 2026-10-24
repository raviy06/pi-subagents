import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Follow the package identity provisioned by clean-install, including npm scopes. */
export function installedExtensionPath(root, packageName) {
	assert.match(packageName, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "Invalid package name");
	const installed = path.join(root, "extension", "node_modules", ...packageName.split("/"));
	const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
	assert.equal(manifest.name, packageName, "Installed package identity mismatch");
	return installed;
}
