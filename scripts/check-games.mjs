import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {normalizeAnswer,isSpellingCard,shuffle,uniqueGameCards,makeListeningOptions,scoreForResult} from "../web/game-engine.mjs";

const root=resolve(import.meta.dirname,"..");
const read=name=>readFileSync(resolve(root,name),"utf8");

for(const name of ["api/src/server.js","web/app.js","web/games.js","web/game-engine.mjs"]){
  execFileSync(process.execPath,["--check",resolve(root,name)],{stdio:"inherit"});
  console.log("JavaScript syntax OK:",name);
}

assert.equal(normalizeAnswer("  Resilience!  "),"resilience");
assert.equal(normalizeAnswer("New   York"),"new york");
assert.equal(normalizeAnswer("don't"),"don't");
assert.ok(isSpellingCard({front:"long-term",back:"长期的"}));
assert.ok(!isSpellingCard({front:"二氧化碳",back:"CO2"}));
assert.ok(!isSpellingCard({front:"What is the effect of...?",back:"结果"}));

const input=[
  {id:"a",front:"apple",back:"苹果"},
  {id:"b",front:"banana",back:"香蕉"},
  {id:"c",front:"apple",back:"水果"},
  {id:"d",front:"cat",back:"苹果"},
  {id:"e",front:"dog",back:"狗"},
  {id:"f",front:"river",back:"河流"},
  {id:"g",front:"sun",back:"太阳"}
];
const deduped=uniqueGameCards(input);
assert.deepEqual(deduped.map(x=>x.id),["a","b","e","f","g"]);
assert.equal(uniqueGameCards([{id:"h",front:"same",back:"same"}]).length,0);
assert.deepEqual(shuffle([1,2,3,4],()=>0),[2,3,4,1]);
const options=makeListeningOptions(deduped[0],deduped);
assert.equal(options.length,4);
assert.equal(new Set(options.map(x=>x.id)).size,4);
assert.ok(options.some(x=>x.id==="a"));
assert.deepEqual(makeListeningOptions(deduped[0],deduped.slice(0,3)),[]);
assert.equal(scoreForResult("spell",false,1000),0);
assert.ok(scoreForResult("spell",true,1000)>scoreForResult("spell",true,1000,true));
assert.ok(scoreForResult("match",true,0)>=scoreForResult("match",true,30000));

const html=read("web/index.html");
for(const id of ["gamesPage","gameBoard","gameStage","gameModes","gameClock","gameSpellCount","gameLobbyStatus"]){
  assert.ok(html.includes('id="'+id+'"'),"Missing element "+id);
}
for(const path of ["games.js","games.css"]){
  assert.ok(html.includes(path),"Missing game asset link "+path);
}
assert.ok(read("web/games.js").includes("game-engine.mjs"),"Missing game-engine import");
const game=read("web/games.js");
for(const token of ["startGame(mode)","renderMatch()","renderQuestion()","finishGame()","pauseCurrentCard()","/games/attempt"]){
  assert.ok(game.includes(token),"Missing game client behavior "+token);
}
const server=read("api/src/server.js");
for(const route of ['"/games/cards"','"/games/attempt"','"/games/stats"']){
  assert.ok(server.includes(route),"Missing game route "+route);
}
assert.ok(server.includes("c.hidden_until IS NULL OR c.hidden_until<=NOW()"),"Missing snooze filter");
assert.ok(server.includes("game_attempts"),"Missing persisted game history");
console.log("Game engine and integration contracts passed.");
