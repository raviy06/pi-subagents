import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

function versionParts(value) {
 assert.equal(typeof value,"string","Expected stable semantic version");
 assert.match(value,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,"Expected stable semantic version");
 const parts=value.split(".").map(Number);
 assert.ok(parts.every(Number.isSafeInteger),"Expected stable semantic version");
 return parts;
}
export function newerVersion(current,base) {
 const a=versionParts(current),b=versionParts(base);
 for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}
 return false;
}
export function validateRelease(root,{name,base,packed=false}) {
 assert.match(name,/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,"Invalid package identity");
 const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),"utf8"));
 const source=read("package.json"),lock=read("package-lock.json");
 assert.equal(source.name,name,"Release package identity mismatch");
 assert.equal(source.private,true,"Source checkout must remain private");
 versionParts(source.version);
 for(const entry of [lock,lock.packages?.[""]]) {
  assert.equal(entry?.name,source.name,"Root lockfile package identity mismatch");
  assert.equal(entry?.version,source.version,"Root lockfile version mismatch");
 }
 const notes=fs.readFileSync(path.join(root,"CHANGELOG.md"),"utf8");
 const prefix=`## [${source.version}] - `;
 assert.ok(notes.split(/\r?\n/).some(line=>line.startsWith(prefix)&&/^\d{4}-\d{2}-\d{2}$/.test(line.slice(prefix.length))),"Missing dated changelog release entry");
 if(base){
  assert.match(base,/^[a-f0-9]{40}$/,"PR base must be an exact commit SHA");
  const previous=JSON.parse(execFileSync("git",["show",`${base}:package.json`],{cwd:root,encoding:"utf8"}));
  assert.ok(newerVersion(source.version,previous.version),`PR must bump package version above ${previous.version}`);
 }
 if(packed){
  const distribution=read("dist-pkg/package.json");
  assert.equal(distribution.name,name,"Built package identity mismatch");
  assert.equal(distribution.version,source.version,"Built package version mismatch");
  assert.equal(distribution.private,undefined,"Built package must be publishable");
  assert.ok(Array.isArray(distribution.pi?.extensions)&&distribution.pi.extensions.length,"Missing extension entry");
  const packageRoot=path.resolve(root,"dist-pkg");
  for(const entry of distribution.pi.extensions){
   assert.equal(typeof entry,"string","Invalid extension entry");
   const target=path.resolve(packageRoot,entry);
   assert.ok(target.startsWith(packageRoot+path.sep)&&fs.existsSync(target)&&fs.statSync(target).isFile(),"Missing/unsafe built extension entry");
  }
 }
 return source;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{name:{type:"string"},base:{type:"string"},packed:{type:"boolean"}}});
 const pkg=validateRelease(process.cwd(),values);
 console.log(`Release metadata OK: ${pkg.name}@${pkg.version}`);
}
