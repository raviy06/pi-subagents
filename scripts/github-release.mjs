import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function extractReleaseNotes(changelog,version) {
 assert.match(version,/^\d+\.\d+\.\d+$/,"Invalid release version");
 const lines=changelog.replace(/\r\n/g,"\n").split("\n");
 const prefix=`## [${version}] - `;
 const matches=lines.flatMap((line,index)=>line.startsWith(prefix)&&/^\d{4}-\d{2}-\d{2}$/.test(line.slice(prefix.length))?[index]:[]);
 assert.ok(matches.length,"Missing dated release notes");
 assert.equal(matches.length,1,"Duplicate release notes for this version");
 const tail=lines.slice(matches[0]+1);
 const end=tail.findIndex(line=>line.startsWith("## "));
 const body=(end<0?tail:tail.slice(0,end)).join("\n").trim();
 assert.ok(body.split("\n").some(line=>line.trim()&&!/^#{1,6}\s/.test(line)),"Empty release notes");
 return body+"\n";
}
function runGh(args) {
 return execFileSync("gh",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
}
function normalizeNotes(text) {return String(text??"").replace(/\r\n/g,"\n").trim();}
export function resolveTagCommit(repo,tag,gh=runGh) {
 const raw=gh(["api",`repos/${repo}/git/matching-refs/tags/${encodeURIComponent(tag)}`,"--jq",`.[] | select(.ref == ${JSON.stringify("refs/tags/"+tag)}) | .object`]).trim();
 if(!raw)return undefined;
 let object=JSON.parse(raw);
 const seen=new Set();
 for(let depth=0;depth<=8;depth++){
  assert.match(object?.sha??"",/^[a-f0-9]{40}$/,"Invalid remote tag object");
  assert.ok(!seen.has(object.sha),"Remote tag cycle");seen.add(object.sha);
  if(object.type==="commit")return object.sha;
  assert.equal(object.type,"tag","Remote release tag does not resolve to a commit");
  assert.ok(depth<8,"Remote tag nesting limit exceeded");
  object=JSON.parse(gh(["api",`repos/${repo}/git/tags/${object.sha}`,"--jq",".object"]));
 }
}
function assertAssets(release,expected) {
 for(const artifact of expected){
  const asset=release.assets?.find(item=>item.name===artifact.name);
  assert.ok(asset,`Missing release asset ${artifact.name}`);
  assert.equal(asset.state,"uploaded",`Incomplete release asset ${artifact.name}`);
  assert.equal(asset.size,artifact.size,`Release asset size mismatch: ${artifact.name}`);
  assert.equal(asset.digest,artifact.digest,`Release asset digest mismatch: ${artifact.name}`);
 }
}

/** Publish only after assets and changelog are verified on a draft release. */
export function publishGitHubRelease(options,gh=runGh) {
 const {repo,tag,target,title,notesFile,assets}=options;
 assert.match(repo,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,"Invalid repository");
 assert.match(tag,/^(?:fork-)?v\d+\.\d+\.\d+$/,"Invalid release tag");
 assert.match(target,/^[a-f0-9]{40}$/,"Invalid source commit");
 assert.ok(Array.isArray(assets)&&assets.length,"Missing package tarball");
 const notes=fs.readFileSync(notesFile,"utf8");
 assert.ok(notes.trim(),"Empty release notes");
 const expected=assets.map(file=>{
  const stat=fs.lstatSync(file);
  assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&file.endsWith(".tgz"),"Expected a regular npm tarball");
  return {name:path.basename(file),size:stat.size,digest:"sha256:"+createHash("sha256").update(fs.readFileSync(file)).digest("hex")};
 });
 assert.equal(new Set(expected.map(asset=>asset.name)).size,expected.length,"Duplicate asset names");
 const lookup=()=>{
  // Listing (rather than GET by tag) also finds authenticated, unpublished drafts.
  const json=gh(["api","--paginate",`repos/${repo}/releases?per_page=100`,"--jq",`.[] | select(.tag_name == ${JSON.stringify(tag)}) | {id,tag_name,draft,target_commitish,body,assets}`]).trim();
  return json?JSON.parse(json):undefined;
 };
 const validate=release=>{
  assert.ok(release,"Release is not visible after creation");
  assert.equal(release.tag_name,tag,"Release tag mismatch");
  assert.equal(normalizeNotes(release.body),normalizeNotes(notes),"Release changelog mismatch");
 };
 const verifyTag=release=>{
  const commit=resolveTagCommit(repo,tag,gh);
  if(commit!==undefined)assert.equal(commit,target,"Remote release tag points to a different source commit");
  else {
   assert.ok(!release||release.draft===true,"Published release is missing its remote tag commit");
   if(release)assert.equal(release.target_commitish,target,"Draft release targets a different source commit");
  }
 };
 let release=lookup();
 verifyTag(release);
 if(!release){
  gh(["release","create",tag,"--repo",repo,"--target",target,"--title",title,"--notes-file",notesFile,"--draft"]);
  release=lookup();
  verifyTag(release);
 }
 validate(release);
 if(release.draft===false){
  try {assertAssets(release,expected);}
  catch {throw Error(`Release ${tag} is already published and has missing or mismatched assets; create a new version instead of modifying an immutable release.`);}
  return {tag,alreadyPublished:true};
 }
 assert.equal(release.draft,true,"Unexpected release state");
 gh(["release","upload",tag,...assets.map(file=>path.resolve(file)),"--repo",repo,"--clobber"]);
 release=lookup();validate(release);
 assert.equal(release.draft,true,"Release was published before asset verification");
 assertAssets(release,expected);
 verifyTag(release);
 gh(["release","edit",tag,"--repo",repo,"--draft=false","--latest"]);
 release=lookup();validate(release);assertAssets(release,expected);
 assert.equal(release.draft,false,"Release publication did not finish");
 verifyTag(release);
 return {tag,alreadyPublished:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));
 assert.equal(pkg.name,process.env.PACKAGE_NAME,"Unexpected release package");
 const notes=extractReleaseNotes(fs.readFileSync("CHANGELOG.md","utf8"),pkg.version);
 if(process.argv[2]==="--validate-notes"){
  assert.equal(process.argv.length,3,"Unexpected arguments");
  console.log(`Release notes OK: ${pkg.name}@${pkg.version}`);
 }else{
 assert.equal(process.argv.length,2,"Unexpected arguments");
 assert.equal(pkg.version,process.env.VERSION,"Unexpected release version");
 const repo=process.env.GITHUB_REPOSITORY;
 assert.equal(pkg.repository?.url,`git+https://github.com/${repo}.git`,"Release repository mismatch");
 const prefix=process.env.TAG_PREFIX;
 assert.ok(prefix==="v"||prefix==="fork-v","Invalid tag prefix");
 const notesFile=path.join(process.env.RUNNER_TEMP||os.tmpdir(),`release-notes-${pkg.version}.md`);
 fs.writeFileSync(notesFile,notes);
 const asset=`${pkg.name.replace(/^@/,"").replace("/","-")}-${pkg.version}.tgz`;
 const target=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
 const result=publishGitHubRelease({repo,tag:prefix+pkg.version,target,title:`${pkg.name} ${pkg.version}`,notesFile,assets:[asset]});
 console.log(`GitHub release ${result.tag}: ${result.alreadyPublished?"already complete":"published with verified assets and changelog"}`);
 }
}
