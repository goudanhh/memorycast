import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {
 BIOMES,MAX_WAVE,UPGRADES,clamp,distance,direction,closestEnemy,getUpgradeCost,
 initialProfile,normalizeProfile,computeRewards,startStats,rollWave,spawnType,
 skillChoices,canEnterSector,chooseRuneCard
} from "../web/rogue-engine.js";
const root=resolve(import.meta.dirname,"..");
const read=path=>readFileSync(resolve(root,path),"utf8");
for(const path of ["web/rogue-engine.js","web/rogue.js","web/adventure.js","web/games.js","api/src/server.js"]){
  execFileSync(process.execPath,["--check",resolve(root,path)],{stdio:"inherit"});
  console.log("Syntax verified:",path);
}
assert.equal(BIOMES.length,3);
assert.equal(MAX_WAVE,6);
assert.deepEqual(Object.keys(UPGRADES),["power","armor","magnet"]);
assert.equal(getUpgradeCost("power",0),65);
assert.equal(getUpgradeCost("power",1),110);
assert.equal(getUpgradeCost("armor",4),265);
assert.equal(getUpgradeCost("magnet",5),null);
assert.equal(getUpgradeCost("unknown",0),null);
assert.equal(clamp(100,0,50),50);
assert.equal(Math.round(distance({x:0,y:0},{x:3,y:4})),5);
assert.deepEqual(direction({x:0,y:0},{x:4,y:0}),{x:1,y:0});
assert.equal(closestEnemy([{hp:0,x:0,y:0},{hp:3,x:8,y:0}],{x:0,y:0},9).x,8);
assert.equal(closestEnemy([{hp:0,x:0,y:0}],{x:0,y:0}),null);
const starter=initialProfile();
assert.equal(starter.highestSector,1);
assert.equal(canEnterSector(1,starter),true);
assert.equal(canEnterSector(2,starter),false);
assert.equal(canEnterSector(4,{highestSector:3}),false);
assert.equal(canEnterSector(3,{highestSector:3}),true);
const advanced=normalizeProfile({coins:103,totalXp:999,highestSector:3,
  upgrades:{power:2,armor:1,magnet:4}});
assert.equal(startStats(advanced).damage,24);
assert.equal(startStats(advanced).heroMax,120);
assert.equal(startStats(advanced).pickupRadius,87);
for(let sector=1;sector<=3;sector++){
  for(let wave=1;wave<=6;wave++){
    const roll=rollWave(sector,wave);
    assert.ok(roll.count>0&&roll.interval>.2&&roll.hpScale>0);
    if(wave===6)assert.equal(spawnType(sector,wave,0),"boss");
    else assert.notEqual(spawnType(sector,wave,0),"boss");
  }
}
assert.ok(rollWave(3,5).hpScale>rollWave(1,1).hpScale);
assert.equal(skillChoices(["rapid","multi","pierce","heal","thunder","shield"]).length,0);
assert.equal(skillChoices([],0).length,3);
assert.equal(new Set(skillChoices([],0).map(x=>x.id)).size,3);
assert.deepEqual(chooseRuneCard([{id:"x",front:"apple",back:"苹果"}],[]).id,"x");
assert.equal(chooseRuneCard([{id:"x",front:"apple",back:"苹果"}],["x"]),null);
assert.ok(computeRewards(3,6,100,true).coins>computeRewards(1,1,1,false).coins);

const html=read("web/index.html"),client=read("web/rogue.js"),server=read("api/src/server.js"),db=read("db/init.sql");
for(const element of ["rogueShell","rogueLobby","rogueSectors","rogueShop",
  "rogueCanvas","rogueBattle","rogueSkillDialog","rogueRuneBox",
  "rogueDash","rogueBuild","rogueResult","rogueHealthBar","rogueCoreBar"]){
  assert.ok(html.includes('id="'+element+'"'),"Missing hybrid game element "+element);
}
for(const path of ["rogue.js?v=hybrid-1","rogue.css?v=hybrid-1"]){
  assert.ok(html.includes(path),"Missing game asset "+path);
}
assert.ok(html.includes("rogue-legacy"),"Old-game progress must remain accessible");
for(const token of ["function startRun(sector)","function spawnEnemy()","function shoot(",
  "function dash()","function buildTower(index)","function applySkill(id)",
  "function answerRune(correct)","function endRun(won)","requestAnimationFrame(loop)",
  "pointerdown","/games/attempt","/arcade/finish"]){
  assert.ok(client.includes(token),"Missing actual combat gameplay feature "+token);
}
for(const route of ['"/arcade/profile"','"/arcade/upgrade"','"/arcade/finish"']){
  assert.ok(server.includes(route),"Missing profile endpoint "+route);
}
assert.ok(server.includes("UPDATE arcade_profiles"),"Arcade run results not persisted");
assert.ok(server.includes("GREATEST(highest_sector"),"Winning should unlock next area");
assert.ok(db.includes("CREATE TABLE IF NOT EXISTS arcade_profiles"),"Missing persistence schema");
assert.ok(!/DROP TABLE arcade_profiles/i.test(server),"Never delete existing progress");
console.log("Hybrid gameplay mechanics, account progression, knowledge buffs, HTML and API contracts: PASS");
