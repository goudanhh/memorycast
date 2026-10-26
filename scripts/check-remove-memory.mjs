import assert from "node:assert/strict";
import {existsSync,readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";

const root=resolve(import.meta.dirname,"..");
const read=p=>readFileSync(resolve(root,p),"utf8");

const retired=[
  "web/memory-gym.js","web/memory-gym.css","web/memory-engine.js",
  "scripts/check-memory.mjs","scripts/smoke-memory.mjs",
  ".github/workflows/smoke-memory.yml",
  "web/games.js","web/adventure.js","web/rogue.js"
];
for(const path of retired){
  assert.equal(existsSync(resolve(root,path)),false,"Retired module still exists: "+path);
}
const html=read("web/index.html");
const app=read("web/app.js");
const api=read("api/src/server.js");
const db=read("db/init.sql");
const readme=read("README.md");
const workflow=read(".github/workflows/check-learning-stats.yml");

for(const body of [html,app,api,db,readme,workflow]){
  assert.doesNotMatch(body,/memory-gym|memory-engine|\/memory\/(sessions|attempts|overview)|gamesPage|记忆训练场|记忆训练/, 
    "A removed training entry or endpoint is still referenced");
}
assert.doesNotMatch(html,/<section id="gamesPage"|data-go="gamesPage"|data-page="gamesPage"/,
  "Removed training page remains in navigation");
assert.doesNotMatch(db,/CREATE TABLE IF NOT EXISTS memory_sessions|CREATE TABLE IF NOT EXISTS memory_attempts/,
  "New installations still initialize retired tables");
assert.doesNotMatch(api,/CREATE TABLE IF NOT EXISTS memory_sessions|CREATE TABLE IF NOT EXISTS memory_attempts/,
  "Server still initializes retired training tables");
assert.doesNotMatch(api,/DROP\s+TABLE|TRUNCATE\s+TABLE/i,
  "Removal must never delete user data");
for(const path of ["api/src/server.js","web/app.js"]){
  execFileSync(process.execPath,["--check",resolve(root,path)],{stdio:"inherit"});
}
for(const id of ["notesPage","todayPage","quizPage","listeningPage",
  "libraryPage","statsPage","settingsPage","homePage","walkmanPlayBtn"]){
  assert.ok(html.includes('id="'+id+'"'),"Existing core page missing: "+id);
}
for(const url of ['"/quiz/generate"','"/quiz/grade"','"/walkman"','"/due"']){
  assert.ok(api.includes(url),"Core learning endpoint disappeared: "+url);
}
for(const path of ["cards","reviews","notes"]){
  assert.ok(db.includes("CREATE TABLE IF NOT EXISTS "+path),
    "Required core table missing from schema: "+path);
}
assert.ok(!workflow.includes("smoke-memory.mjs")&&!workflow.includes("check-memory.mjs"));
console.log("Removed memory trainer: no dangling links/routes/assets; retained study modules and historical DB data.");
