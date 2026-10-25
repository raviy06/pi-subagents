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
function fakeGh(options,metadata,initial,remoteTag,tagObjects={}) {
 let release=initial?{id:101,...initial}:undefined;const calls=[];
 let tag=remoteTag===undefined&&initial&&!initial.draft?{type:"commit",sha:options.target}:remoteTag;
 const run=args=>{
  calls.push(args);
  if(args[0]==="api"){
   const endpoint=args.find(arg=>arg.startsWith("repos/"))??"";
   if(args.includes("POST")){
    assert.ok(args.includes("draft=true"));
    release={id:101,tag_name:options.tag,draft:true,target_commitish:options.target,assets:[],body:fs.readFileSync(options.notesFile,"utf8")};
    return JSON.stringify(release);
   }
   if(args.includes("PATCH")){
    assert.ok(args.includes("draft=false"));assert.equal(release.assets.length,1);
    release.draft=false;release.immutable=true;tag??={type:"commit",sha:options.target};
    return JSON.stringify(release);
   }
   if(endpoint.includes("/git/matching-refs/"))return tag?JSON.stringify(tag):"";
   if(endpoint.includes("/git/tags/"))return JSON.stringify(tagObjects[endpoint.split("/").at(-1)]);
   return release?JSON.stringify(release):"";
  }
  assert.equal(args[1],"upload","Unexpected release command");
  assert.equal(release.draft,true,"assets must be attached while draft");release.assets=[metadata];
  return "";
 };
 return {run,calls,get release(){return release;},get tag(){return tag;},set tag(value){tag=value;}};
}
test("draft creation, asset verification and publication happen in that order",()=>{
 const f=fixture();try{
  const gh=fakeGh(f.options,f.metadata);
  publishGitHubRelease(f.options,gh.run);
  assert.equal(gh.release.draft,false);
  const mutations=gh.calls.filter(args=>args[0]==="release"||args.includes("POST")||args.includes("PATCH"));
  assert.deepEqual(mutations.map(args=>args.includes("POST")?"create":args.includes("PATCH")?"edit":args[1]),["create","upload","edit"]);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("a stale release list after draft creation cannot hide the newly created release",()=>{
 const f=fixture();try{
  const gh=fakeGh(f.options,f.metadata);
  publishGitHubRelease(f.options,args=>{
   if(args.includes("--paginate")&&gh.release)return "";
   return gh.run(args);
  });
  assert.equal(gh.release.draft,false);
  assert.ok(gh.calls.some(args=>args.some(arg=>arg.startsWith("repos/owner/repo/releases/101"))));
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("a changed release ID after upload prevents publication",()=>{
 const f=fixture();try{
  const gh=fakeGh(f.options,f.metadata);
  assert.throws(()=>publishGitHubRelease(f.options,args=>{
   const result=gh.run(args);
   if(args.includes("repos/owner/repo/releases/101")&&!args.includes("PATCH"))return JSON.stringify({...JSON.parse(result),id:202});
   return result;
  }),/identity changed/);
  assert.equal(gh.release.draft,true);
  assert.equal(gh.calls.some(args=>args.includes("PATCH")),false);
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
test("matching creation metadata cannot hide an existing tag at the wrong commit",()=>{
 const f=fixture();try{
  for(const initial of [undefined,{tag_name:f.options.tag,draft:false,immutable:true,target_commitish:f.options.target,assets:[f.metadata],body:fs.readFileSync(f.options.notesFile,"utf8")}]){
   const gh=fakeGh(f.options,f.metadata,initial,{type:"commit",sha:"b".repeat(40)});
   assert.throws(()=>publishGitHubRelease(f.options,gh.run),/tag.*commit/i);
   assert.equal(gh.calls.some(args=>args[0]==="release"),false);
  }
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("annotated tags are peeled to their actual commit",()=>{
 const f=fixture();try{
  const initial={tag_name:f.options.tag,draft:false,immutable:true,target_commitish:"main",assets:[f.metadata],body:fs.readFileSync(f.options.notesFile,"utf8")};
  const gh=fakeGh(f.options,f.metadata,initial,{type:"tag",sha:"c".repeat(40)},{["c".repeat(40)]:{type:"tag",sha:"d".repeat(40)},["d".repeat(40)]:{type:"commit",sha:f.options.target}});
  publishGitHubRelease(f.options,gh.run);
  assert.equal(gh.calls.some(args=>args[0]==="release"),false);
  assert.equal(gh.calls.filter(args=>args.some(arg=>arg.includes("/git/tags/"))).length,2);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("a tag changed during publication is detected afterward without retagging",()=>{
 const f=fixture();try{
  const gh=fakeGh(f.options,f.metadata);
  assert.throws(()=>publishGitHubRelease(f.options,args=>{
   const result=gh.run(args);
   if(args.includes("--draft=false")||args.includes("draft=false"))gh.tag={type:"commit",sha:"b".repeat(40)};
   return result;
  }),/tag.*commit/i);
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
