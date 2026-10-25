import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createReleaseIntent, verifyReleaseIntent } from "../../scripts/release-intent.mjs";

function repository() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"release-intent-"));
 const hooks=path.join(root,"empty-hooks");fs.mkdirSync(hooks);
 const git=args=>execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","-c",`core.hooksPath=${hooks}`,...args],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 git(["init","-q"]);
 const name="@owner/extension";
 const commit=version=>{
  fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({name,version}));
  git(["add","package.json"]);git(["commit","--allow-empty","-qm","change"]);
  return git(["rev-parse","HEAD"]);
 };
 return {root,name,commit,git,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test("normal main pushes never request publication",()=>{
 const r=repository();try{
  const before=r.commit("0.1.1"),sha=r.commit("0.1.1");
  const intent=createReleaseIntent(r.root,{name:r.name,before,sha});
  assert.equal(intent.release,false);
  assert.deepEqual(verifyReleaseIntent(r.root,intent,{name:r.name,sha}),intent);
 }finally{r.cleanup();}
});
test("a version change anywhere in a multi-commit push requests one batch release",()=>{
 const r=repository();try{
  const before=r.commit("0.1.1");r.commit("0.1.2");const sha=r.commit("0.1.2");
  assert.equal(createReleaseIntent(r.root,{name:r.name,before,sha}).release,true);
  assert.equal(createReleaseIntent(r.root,{name:r.name,before:r.git(["rev-parse","HEAD^1"]),sha}).release,false);
 }finally{r.cleanup();}
});
test("intent rejects forged fields, wrong source commits, identity changes and downgrades",()=>{
 const r=repository();try{
  const before=r.commit("0.1.1"),sha=r.commit("0.1.2");
  const intent=createReleaseIntent(r.root,{name:r.name,before,sha});
  for(const change of [{release:false},{version:"99.0.0"},{name:"@other/pkg"},{sha:before},{extra:true}]){
   assert.throws(()=>verifyReleaseIntent(r.root,{...intent,...change},{name:r.name,sha}));
  }
  assert.throws(()=>createReleaseIntent(r.root,{name:r.name,before:"--help",sha}),/SHA/);
  assert.throws(()=>createReleaseIntent(r.root,{name:"@other/pkg",before,sha}),/identity/);
  assert.throws(()=>createReleaseIntent(r.root,{name:r.name,before,sha:before}),/checkout/);
  const next=r.commit("0.1.0");
  assert.throws(()=>createReleaseIntent(r.root,{name:r.name,before:sha,sha:next}),/downgrade/);
 }finally{r.cleanup();}
});
test("initial package commits are releases; unrelated Git history fails closed",()=>{
 const r=repository();try{
  const sha=r.commit("0.1.1");
  assert.equal(createReleaseIntent(r.root,{name:r.name,before:"0".repeat(40),sha}).release,true);
  r.git(["checkout","--orphan","unrelated"]);const other=r.commit("0.1.2");
  assert.throws(()=>createReleaseIntent(r.root,{name:r.name,before:sha,sha:other}));
 }finally{r.cleanup();}
});
test("only verified version changes reach the protected publisher",()=>{
 const workflow=fs.readFileSync(".github/workflows/release.yml","utf8").replace(/\r\n/g,"\n");
 const [detect,publish]=workflow.split("\n  publish:\n");
 assert.match(detect,/actions: read/);
 assert.doesNotMatch(detect,/id-token: write|contents: write|environment: npm/);
 assert.match(detect,/--name release-intent/);
 assert.match(detect,/release-intent\.mjs --verify/);
 assert.match(detect,/\[\.head_sha,\.head_branch,\.event,\.conclusion,\.path\]/);
 assert.match(publish,/needs: detect\n {4}if: needs\.detect\.outputs\.release == 'true'/);
 assert.match(publish,/environment: npm/);
 assert.match(publish,/ref: \$\{\{ needs\.detect\.outputs\.sha \}\}/);
 assert.match(publish,/concurrency:\n {6}group: npm-release/);
 const ciPath=fs.existsSync(".github/workflows/test.yml")?".github/workflows/test.yml":".github/workflows/ci.yml";
 const ci=fs.readFileSync(ciPath,"utf8").replace(/\r\n/g,"\n");
 assert.match(ci,/Record this main push's release intent\n {8}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
 assert.match(ci,/BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
 assert.match(ci,/AFTER_SHA: \$\{\{ github\.sha \}\}/);
 assert.doesNotMatch(ci,/Require a new version on every PR/);
});
