import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {
 MEMORY_PHASES,VALID_GRADES,GRADE_NAMES,normalizeRecall,matchesAnswer,
 canReverse,promptFor,practiceDeck,stageOrder,scoreTrial,summarizeMemory
} from "../web/memory-engine.js";

const root=resolve(import.meta.dirname,"..");
const read=p=>readFileSync(resolve(root,p),"utf8");
for(const path of ["web/app.js","web/memory-gym.js","web/memory-engine.js","api/src/server.js"]){
  execFileSync(process.execPath,["--check",resolve(root,path)],{stdio:"inherit"});
  console.log("Syntax OK:",path);
}
assert.deepEqual(MEMORY_PHASES.map(p=>p.id),["retrieve","interleave","delayed"]);
assert.deepEqual(VALID_GRADES,[0,1,2]);
assert.equal(GRADE_NAMES[0],"没想起");
assert.equal(normalizeRecall("  Resilience! "), "resilience");
assert.ok(matchesAnswer("长期性。","长期性"));
assert.ok(!matchesAnswer("resilience","resistance"));
assert.equal(scoreTrial(2,"delayed"),32);
assert.equal(scoreTrial(1,"retrieve"),10);
assert.ok(scoreTrial(2,"retrieve")>scoreTrial(2,"retrieve",true));
assert.equal(scoreTrial(0,"delayed"),0);
const cards=[
{id:"1",front:"resilience",back:"韧性",priority:120},
{id:"2",front:"remarkable",back:"非凡的",priority:110},
{id:"3",front:"estimate",back:"估计",priority:100},
{id:"4",front:"interpret",back:"解释",priority:90},
{id:"5",front:"analyze",back:"分析",priority:80},
{id:"6",front:"predict",back:"预测",priority:70}
];
const deck=practiceDeck([...cards,{id:"7",front:"resilience",back:"其他",priority:1}],6);
assert.equal(deck.length,6);
assert.deepEqual(deck.map(c=>c.id),["1","2","3","4","5","6"]);
assert.equal(stageOrder(deck,"retrieve")[0].id,"1");
assert.equal(stageOrder(deck,"interleave")[0].id,"6");
assert.equal(stageOrder(deck,"delayed")[0].id,"6");
assert.equal(promptFor(deck[0],"retrieve",0).direction,"front-to-back");
assert.equal(promptFor(deck[0],"interleave",0).direction,"back-to-front");
assert.equal(promptFor(deck[1],"interleave",1).direction,"front-to-back");
assert.equal(promptFor(deck[0],"delayed",0).direction,"front-to-back");
assert.ok(canReverse(deck[0]));
const trials=[];
for(const phase of MEMORY_PHASES){
  for(const card of deck){
    trials.push({cardId:card.id,phase:phase.id,grade:card.id==="1"?0:2,hinted:false});
  }
}
const summary=summarizeMemory(trials,deck);
assert.equal(summary.weak.length,1);
assert.equal(summary.weak[0].id,"1");
assert.equal(summary.retained,5);
assert.equal(summary.forgot,3);
assert.equal(summary.fullyCorrect,15);
assert.ok(summary.score>0);

const html=read("web/index.html"),script=read("web/memory-gym.js"),
      api=read("api/src/server.js"),sql=read("db/init.sql"),css=read("web/memory-gym.css");
for(const id of ["gamesPage","memoryWelcome","memoryPreview","memoryTrainer",
  "memoryFinish","memoryStart","memoryStartWeak","memoryResponse",
  "memoryReveal","memoryForgot","memoryHint","memoryFinishRetained",
  "memoryFinishWeak","memoryPhaseResults","memoryInterlude","memoryCorrectAnswer"]){
  assert.ok(html.includes('id="'+id+'"'),"Missing memory trainer element: "+id);
}
for(const phrase of ["memory-gym.js?v=recall-1","memory-gym.css?v=recall-1","记忆训练场"]){
  assert.ok(html.includes(phrase),"Missing memory entry/asset "+phrase);
}
for(const token of ["beginTraining(","startRecall()","reveal(unknown=false)","record(grade)",
    "stageOrder(","promptFor(","summarizeMemory(","/memory/attempts","/memory/overview",
    "memoryStartWeak","memoryCount"]){
  assert.ok(script.includes(token),"Missing active retrieval behavior: "+token);
}
for(const route of [
  '"/memory/overview"','"/memory/sessions"','"/memory/attempts"',
  '"/memory/sessions/:id/complete"'
]){
  assert.ok(api.includes(route),"Missing isolated memory endpoint "+route);
}
assert.ok(api.includes("AND c.id=ANY(s.card_ids)"),"Card ownership/session allowlist missing");
assert.ok(api.includes("cardinality(s.card_ids)*3"),"Three rounds must be required before completion");
assert.ok(api.includes("c.hidden_until IS NULL OR c.hidden_until<=NOW()"),"Snoozed cards must be excluded");
for(const token of ["CREATE TABLE IF NOT EXISTS memory_sessions",
                    "CREATE TABLE IF NOT EXISTS memory_attempts",
                    "UNIQUE(session_id,card_id,phase)"]){
  assert.ok(api.includes(token)&&sql.includes(token),"Missing persistence constraint: "+token);
}
for(const file of ["web/games.js","web/games.css","web/game-engine.js","web/adventure.js",
 "web/adventure.css","web/adventure-engine.js","web/rogue.js","web/rogue.css","web/rogue-engine.js",
 "scripts/check-games.mjs","scripts/check-adventure.mjs","scripts/check-rogue.mjs"]){
  assert.ok(!existsSync(resolve(root,file)),"Old game file must be deleted: "+file);
}
assert.doesNotMatch(api,/\/games\/|\/arcade\/|\/adventure\//,
  "Retired game APIs unexpectedly still exist");
assert.doesNotMatch(html,/rogueShell|adventureShell|gameModes|gameBoard/,
  "Retired game DOM unexpectedly still exists");
assert.doesNotMatch(sql,/game_attempts|arcade_profiles|adventure_progress/,
  "Fresh database must not initialize old game tables");
assert.doesNotMatch(api,/DROP\s+TABLE/i,"Never destroy legacy game or user study history");
assert.ok(css.length>1000,"New trainer styles missing");
console.log("Memory retrieval rules, retired-game deletion, training integration, history safety: PASS");
