import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { newerVersion } from "./check-release.mjs";

export async function versionExists(name,version,request=fetch) {
 assert.match(name,/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,"Invalid package identity");
 assert.match(version,/^\d+\.\d+\.\d+$/,"Invalid release version");
 const response=await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,{signal:AbortSignal.timeout(15000)});
 if(response.status===404)return false;
 assert.ok(response.ok,`npm registry check failed: HTTP ${response.status}`);
 assert.equal((await response.json()).version,version,"npm registry returned a different version");
 return true;
}
export async function assertPublishOrder(name,version,request=fetch) {
 const response=await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,{signal:AbortSignal.timeout(15000)});
 if(response.status===404)return;
 assert.ok(response.ok,`npm registry latest check failed: HTTP ${response.status}`);
 const latest=(await response.json()).version;
 assert.ok(newerVersion(version,latest),`Refusing to publish ${version} over npm latest ${latest}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));
 assert.equal(pkg.name,process.env.PACKAGE_NAME,"Release package identity mismatch");
 const exists=await versionExists(pkg.name,pkg.version);
 if(!exists)await assertPublishOrder(pkg.name,pkg.version);
 console.log(`version=${pkg.version}`);
 console.log(`needs_publish=${!exists}`);
}
