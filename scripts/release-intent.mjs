import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { versionChanged } from "./check-release.mjs";

const zeroSha="0".repeat(40);
export function createReleaseIntent(root,{name,before,sha}) {
 for(const value of [before,sha])assert.match(value??"",/^[a-f0-9]{40}$/, "Expected exact commit SHA");
 assert.notEqual(sha,zeroSha,"Missing source commit");
 const git=args=>execFileSync("git",args,{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 assert.equal(git(["rev-parse","HEAD"]),sha,"Intent must match the checkout");
 const current=JSON.parse(git(["show",`${sha}:package.json`]));
 assert.equal(current.name,name,"Package identity mismatch");
 let previous;
 if(before!==zeroSha){
  git(["merge-base","--is-ancestor",before,sha]);
  // A package's first commit can follow repository setup without package.json.
  const exists=spawnSync("git",["cat-file","-e",`${before}:package.json`],{cwd:root,encoding:"utf8"});
  if(exists.status===0)previous=JSON.parse(git(["show",`${before}:package.json`]));
  else {
   // Distinguish an absent file from an invalid/unavailable commit or Git failure.
   git(["cat-file","-e",`${before}^{commit}`]);
   assert.equal(git(["ls-tree","--name-only",before,"--","package.json"]),"","Cannot read previous package manifest");
  }
 }
 return {schemaVersion:1,name,before,sha,version:current.version,release:versionChanged(current.version,previous?.version)};
}
export function verifyReleaseIntent(root,record,{name,sha}) {
 assert.ok(record&&typeof record==="object"&&!Array.isArray(record),"Invalid release intent");
 const expected=createReleaseIntent(root,{name,before:record.before,sha});
 assert.deepEqual(record,expected,"Release intent does not match trusted source");
 return expected;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{verify:{type:"string"},sha:{type:"string"}}});
 const name=process.env.PACKAGE_NAME;
 assert.ok(name,"PACKAGE_NAME is required");
 if(values.verify){
  assert.ok(fs.statSync(values.verify).size<=4096,"Release intent is too large");
  const record=verifyReleaseIntent(process.cwd(),JSON.parse(fs.readFileSync(values.verify,"utf8")),{name,sha:values.sha});
  console.log(`release=${record.release}\nsha=${record.sha}\nversion=${record.version}`);
 }else{
  console.log(JSON.stringify(createReleaseIntent(process.cwd(),{name,before:process.env.BEFORE_SHA,sha:process.env.AFTER_SHA}),null,2));
 }
}
