import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateRelease, newerVersion } from "../../scripts/check-release.mjs";
import { versionExists } from "../../scripts/npm-status.mjs";

function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"release-policy-"));
 const pkg={name:"@owner/extension",version:"0.1.1",private:true,pi:{extensions:["./dist/index.js"]}};
 fs.writeFileSync(path.join(root,"package.json"),JSON.stringify(pkg));
 fs.writeFileSync(path.join(root,"package-lock.json"),JSON.stringify({name:pkg.name,version:pkg.version,packages:{"":{name:pkg.name,version:pkg.version}}}));
 fs.writeFileSync(path.join(root,"CHANGELOG.md"),"## [0.1.1] - 2026-10-25\n");
 return {root,pkg};
}
test("release guard requires matching versions, dated notes and the intended package",()=>{
 const {root,pkg}=fixture();
 try {
  assert.equal(validateRelease(root,{name:pkg.name}).version,"0.1.1");
  assert.throws(()=>validateRelease(root,{name:"upstream"}),/identity/);
  fs.writeFileSync(path.join(root,"CHANGELOG.md"),"## [Unreleased]\n");
  assert.throws(()=>validateRelease(root,{name:pkg.name}),/changelog/);
  fs.writeFileSync(path.join(root,"CHANGELOG.md"),"## [0.1.1] - 2026-10-25\n");
  fs.writeFileSync(path.join(root,"package-lock.json"),JSON.stringify({version:"0.1.0",packages:{"":pkg}}));
  assert.throws(()=>validateRelease(root,{name:pkg.name}),/lockfile/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test("release guard checks the actual distributable entry and prohibits private artifacts",()=>{
 const {root,pkg}=fixture();
 try {
  fs.mkdirSync(path.join(root,"dist-pkg/dist"),{recursive:true});
  fs.writeFileSync(path.join(root,"dist-pkg/package.json"),JSON.stringify(pkg));
  assert.throws(()=>validateRelease(root,{name:pkg.name,packed:true}),/publishable/);
  const packed={...pkg};delete packed.private;
  fs.writeFileSync(path.join(root,"dist-pkg/package.json"),JSON.stringify(packed));
  assert.throws(()=>validateRelease(root,{name:pkg.name,packed:true}),/entry/);
  fs.writeFileSync(path.join(root,"dist-pkg/dist/index.js"),"export default () => {};\n");
  assert.ok(validateRelease(root,{name:pkg.name,packed:true}));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test("version policy rejects stale/downgrade versions and invalid semver",()=>{
 assert.equal(newerVersion("0.1.1","0.1.0"),true);
 assert.equal(newerVersion("1.0.0","0.99.9"),true);
 assert.equal(newerVersion("0.1.0","0.1.0"),false);
 assert.equal(newerVersion("0.0.9","0.1.0"),false);
 assert.throws(()=>newerVersion("0.1.1\nevil","0.1.0"),/stable semantic version/);
});
test("registry absence is only a 404; auth/server/invalid responses fail closed",async()=>{
 const fake=(status,version="0.1.1")=>async()=>({status,ok:status===200,json:async()=>({version})});
 assert.equal(await versionExists("@owner/extension","0.1.1",fake(404)),false);
 assert.equal(await versionExists("@owner/extension","0.1.1",fake(200)),true);
 for(const status of [401,403,429,500])await assert.rejects(versionExists("@owner/extension","0.1.1",fake(status)),/registry/);
 await assert.rejects(versionExists("@owner/extension","0.1.1",fake(200,"wrong")),/version/);
});
