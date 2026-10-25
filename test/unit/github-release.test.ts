import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { publishGitHubRelease, extractReleaseNotes } from "../../scripts/github-release.mjs";

function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"immutable-release-"));
 const asset=path.join(root,"package-0.1.2.tgz"),notes=path.join(root,"notes.md");
 fs.writeFileSync(asset,"fixture package");fs.writeFileSync(notes,"### Fixed\n\n- Upload assets before publication.\n");
 const metadata={name:path.basename(asset),state:"uploaded",size:fs.statSync(asset).size,digest:"sha256:"+createHash("sha256").update(fs.readFileSync(asset)).digest("hex")};
 return {root,metadata,options:{repo:"owner/repo",tag:"v0.1.2",target:"a".repeat(40),title:"Package 0.1.2",notesFile:notes,assets:[asset]}};
}
function fakeGh(options,metadata,initial) {
 let release=initial;const calls=[];
 const run=args=>{
  calls.push(args);
  if(args[0]==="api")return release?JSON.stringify(release):"";
  if(args[1]==="create"){
   assert.ok(args.includes("--draft"));
   release={tag_name:options.tag,draft:true,target_commitish:options.target,assets:[],body:fs.readFileSync(options.notesFile,"utf8")};
  }else if(args[1]==="upload"){
   assert.equal(release.draft,true,"assets must be attached while draft");release.assets=[metadata];
  }else if(args[1]==="edit"&&args.includes("--draft=false")){
   assert.equal(release.assets.length,1,"cannot publish an empty release");release.draft=false;release.immutable=true;
  }
  return "";
 };
 return {run,calls,get release(){return release;}};
}
test("draft creation, asset verification and publication happen in that order",()=>{
 const f=fixture();try{
  const gh=fakeGh(f.options,f.metadata);
  publishGitHubRelease(f.options,gh.run);
  assert.equal(gh.release.draft,false);
  const mutations=gh.calls.filter(args=>args[0]==="release");
  assert.deepEqual(mutations.map(args=>args[1]),["create","upload","edit"]);
  assert.ok(mutations[2].includes("--draft=false"));
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("complete immutable releases are verified without attempting mutation",()=>{
 const f=fixture();try{
  const initial={tag_name:f.options.tag,draft:false,immutable:true,target_commitish:f.options.target,assets:[f.metadata],body:fs.readFileSync(f.options.notesFile,"utf8")};
  const gh=fakeGh(f.options,f.metadata,initial);
  publishGitHubRelease(f.options,gh.run);
  assert.equal(gh.calls.some(args=>args[0]==="release"),false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("an incomplete immutable release fails clearly without upload, deletion or retagging",()=>{
 const f=fixture();try{
  const gh=fakeGh(f.options,f.metadata,{tag_name:f.options.tag,draft:false,immutable:true,target_commitish:f.options.target,assets:[],body:fs.readFileSync(f.options.notesFile,"utf8")});
  assert.throws(()=>publishGitHubRelease(f.options,gh.run),/already published.*new version/i);
  assert.equal(gh.calls.some(args=>args[0]==="release"),false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("a failed upload leaves the release draft, and a retry can finish it",()=>{
 const f=fixture();try{
  const gh=fakeGh(f.options,f.metadata);
  assert.throws(()=>publishGitHubRelease(f.options,args=>{if(args[1]==="upload")throw Error("network failure");return gh.run(args);}),/network failure/);
  assert.equal(gh.release.draft,true);
  publishGitHubRelease(f.options,gh.run);
  assert.equal(gh.release.draft,false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("wrong asset digests or source commits never get published",()=>{
 const f=fixture();try{
  const gh=fakeGh(f.options,{...f.metadata,digest:"sha256:wrong"});
  assert.throws(()=>publishGitHubRelease(f.options,gh.run),/digest/);
  assert.equal(gh.release.draft,true);
  const wrong=fakeGh(f.options,f.metadata,{tag_name:f.options.tag,draft:true,target_commitish:"b".repeat(40),assets:[]});
  assert.throws(()=>publishGitHubRelease(f.options,wrong.run),/commit/);
  assert.equal(wrong.calls.some(args=>args[0]==="release"),false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("note validation runs before publication without GitHub credentials or mutation",()=>{
 const f=fixture();try{
  fs.writeFileSync(path.join(f.root,"package.json"),JSON.stringify({name:"@owner/package",version:"0.1.2"}));
  fs.writeFileSync(path.join(f.root,"CHANGELOG.md"),"## [0.1.2] - 2026-10-25\n\n- Fix immutable release sequencing.\n");
  const script=fileURLToPath(new URL("../../scripts/github-release.mjs",import.meta.url));
  const output=execFileSync(process.execPath,[script,"--validate-notes"],{cwd:f.root,env:{PACKAGE_NAME:"@owner/package"},encoding:"utf8"});
  assert.match(output,/Release notes OK/);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("release notes select exactly one nonempty dated version and handle CRLF",()=>{
 const text="# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [0.1.2] - 2026-10-25\r\n\r\n### Fixed\r\n- Correct release sequence.\r\n\r\n## [0.1.1] - 2026-10-24\r\n- Previous changes.\r\n";
 assert.equal(extractReleaseNotes(text,"0.1.2"),"### Fixed\n- Correct release sequence.\n");
 assert.throws(()=>extractReleaseNotes(text,"0.1.3"),/Missing/);
 assert.throws(()=>extractReleaseNotes(text+"\n## [0.1.2] - 2026-10-25\n- duplicate","0.1.2"),/Duplicate/);
 assert.throws(()=>extractReleaseNotes("## [0.1.2] - 2026-10-25\n\n### Fixed\n","0.1.2"),/Empty/);
});
