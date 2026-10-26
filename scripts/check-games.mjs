import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {
  GAME_MODES,CHALLENGES,normalizeAnswer,isSpellingCard,shuffle,uniqueGameCards,
  makeListeningOptions,scoreForResult,chooseChallengeCards,challengeKind,
  comboMultiplier,secondsLeft,isAudioEligible
} from "../web/game-engine.js";

const root=resolve(import.meta.dirname,"..");
const read=name=>readFileSync(resolve(root,name),"utf8");
for(const path of ["web/app.js","web/games.js","web/game-engine.js","api/src/server.js"]){
  execFileSync(process.execPath,["--check",resolve(root,path)],{stdio:"inherit"});
  console.log("Syntax OK:",path);
}
assert.deepEqual(GAME_MODES,["match","listen","spell","recall"]);
assert.deepEqual(Object.keys(CHALLENGES),GAME_MODES);
assert.equal(CHALLENGES.match.limit,60);
assert.equal(CHALLENGES.match.lives,3);
assert.equal(CHALLENGES.recall.lives,0);
assert.ok(CHALLENGES.listen.round>0);
assert.equal(normalizeAnswer("  Resilience!  "),"resilience");
assert.equal(normalizeAnswer("New   York"),"new york");
assert.equal(normalizeAnswer("don't"),"don't");
assert.ok(isSpellingCard({front:"long-term",back:"长期的"}));
assert.ok(!isSpellingCard({front:"二氧化碳",back:"CO2"}));
assert.ok(!isSpellingCard({front:"What is the effect of...?",back:"结果"}));
assert.ok(isAudioEligible({front:"What is resilience?"}));
assert.ok(!isAudioEligible({front:"韧性 resilience"}));

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

const prioritized=deduped.map((card,i)=>({...card,priority:100-i*20}));
const chosen=chooseChallengeCards(prioritized,3,()=>0);
assert.equal(chosen.length,3);
assert.equal(new Set(chosen.map(c=>c.id)).size,3);
assert.ok(chosen.filter(c=>prioritized.slice(0,3).some(p=>p.id===c.id)).length>=2);
assert.equal(chooseChallengeCards(prioritized,99).length,5);
assert.equal(challengeKind("match",prioritized[0],2),"type");
assert.equal(challengeKind("match",prioritized[0],0),"choice");
assert.equal(challengeKind("match",{front:"氧气",back:"气体"},2),"choice");
assert.equal(challengeKind("recall",prioritized[0],2),"recall");
assert.equal(challengeKind("listen",prioritized[0],0),"audio");
assert.equal(challengeKind("spell",prioritized[0],0),"type");
assert.equal(comboMultiplier(0),1);
assert.equal(comboMultiplier(3),2);
assert.equal(comboMultiplier(10),4);
assert.equal(secondsLeft(15000,5500),10);
assert.equal(secondsLeft(15000,17000),0);

const html=read("web/index.html");
for(const id of [
  "gamesPage","gameBoard","gameStage","gameModes","gameClock","gameSpellCount","gameLobbyStatus",
  "gameRoundBar","gameRoundTimer","gameBossPanel","gameBossBar","gameLives","gameCombo",
  "gameChallengeType","gameClockLabel"
]){
  assert.ok(html.includes('id="'+id+'"'),"Missing arcade element: "+id);
}
for(const filename of ["games.js","games.css"]){
  assert.ok(html.includes(filename),"Missing browser asset: "+filename);
}
assert.ok(html.includes("challenge-20261026"),"Cache-busting hash was not updated");
for(const mode of GAME_MODES){
  assert.ok(html.includes('data-game-mode="'+mode+'"'),"Challenge entry missing: "+mode);
}
const game=read("web/games.js");
for(const method of [
  "startGame(mode)","renderQuestion(s)","answerCurrent(s,correct,detail={})",
  "revealBoss(s,skipped)","finishGame(s,reason)","pauseCurrentCard(s)",
  "speechSynthesis","visibilitychange","/games/attempt","comboMultiplier"
]){
  assert.ok(game.includes(method),"Missing challenge gameplay: "+method);
}
assert.ok(game.includes("game-engine.js?v=challenge-v2"),"Game logic import must use new engine version");
const api=read("api/src/server.js");
for(const route of ['"/games/cards"','"/games/attempt"','"/games/stats"']){
  assert.ok(api.includes(route),"Missing game route "+route);
}
assert.ok(api.includes("c.hidden_until IS NULL OR c.hidden_until<=NOW()"),"Paused cards are not filtered");
assert.ok(api.includes("game_attempts"),"Game practice is not persisted");
assert.ok(api.includes("last_correct_at"),"Recent mastery should reduce immediate repeats");
assert.ok(!/ai_feynman_provider/.test(api),"Retired feature unexpectedly returned");
console.log("Arcade challenge rules and integration checks passed.");
