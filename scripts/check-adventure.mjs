import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {
  ADVENTURE_LEVEL_COUNT,MAP_WIDTH,MAP_HEIGHT,buildAdventureLevel,
  isWalkable,stepPosition,enemyPosition,canVisitLevel,starsForAdventure,findTokenAt
} from "../web/adventure-engine.js";

const root=resolve(import.meta.dirname,"..");
const read=p=>readFileSync(resolve(root,p),"utf8");
for(const path of ["web/adventure.js","web/adventure-engine.js","web/games.js","api/src/server.js"]){
  execFileSync(process.execPath,["--check",resolve(root,path)],{stdio:"inherit"});
  console.log("Syntax OK:",path);
}
assert.equal(ADVENTURE_LEVEL_COUNT,8);
assert.equal(MAP_WIDTH,13);
assert.equal(MAP_HEIGHT,9);
assert.throws(()=>buildAdventureLevel(0));
assert.throws(()=>buildAdventureLevel(9));
assert.equal(canVisitLevel(1,0),true);
assert.equal(canVisitLevel(2,0),false);
assert.equal(canVisitLevel(8,7),true);
assert.equal(canVisitLevel(9,8),false);
assert.equal(starsForAdventure({mistakes:0,hearts:3}),3);
assert.equal(starsForAdventure({mistakes:1,hearts:2}),2);
assert.equal(starsForAdventure({mistakes:4,hearts:1}),1);

function reachable(map,start,target){
  const visited=new Set([start.x+","+start.y]),queue=[start];
  for(let i=0;i<queue.length;i++){
    const p=queue[i];
    if(p.x===target.x&&p.y===target.y)return true;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const next=stepPosition(map,p,dx,dy),k=next.x+","+next.y;
      if(!visited.has(k)){visited.add(k);queue.push(next)}
    }
  }
  return false;
}
for(let level=1;level<=ADVENTURE_LEVEL_COUNT;level++){
  const a=buildAdventureLevel(level),b=buildAdventureLevel(level);
  assert.deepEqual(a,b,"Stage layout must be stable");
  assert.equal(a.crystals.length,3);
  assert.ok(a.enemies.length>=1);
  assert.ok(a.bossRounds>=1);
  for(const destination of [...a.crystals,a.portal]){
    assert.ok(isWalkable(a,destination.x,destination.y),"Collectible/portal blocked at level "+level);
    assert.ok(reachable(a,a.start,destination),"Stage "+level+" is not traversable");
  }
  const collected=new Set();
  assert.ok(findTokenAt(a,a.crystals[0].x,a.crystals[0].y,collected));
  collected.add(a.crystals[0].id);
  assert.equal(findTokenAt(a,a.crystals[0].x,a.crystals[0].y,collected),null);
  for(const enemy of a.enemies){
    for(let t=0;t<enemy.route.length*2;t++){
      const p=enemyPosition(enemy,t);
      assert.ok(isWalkable(a,p.x,p.y),"Enemy patrol enters blocked tile");
    }
  }
}

const html=read("web/index.html"),client=read("web/adventure.js"),api=read("api/src/server.js"),db=read("db/init.sql");
for(const id of [
  "adventureCampaign","adventureWorldPanel","adventureMap","adventureChapters",
  "adventureQuest","adventureAnswers","adventureHearts","adventureCrystals",
  "adventureBossProgress","adventureBack","adventureEndScreen",
  "adventureWorldContent","adventureReload","adventureNotice"
]){
  assert.ok(html.includes('id="'+id+'"'),"Missing adventure DOM element: "+id);
}
for(const asset of ["adventure.js?v=story-1","adventure.css?v=story-1"]){
  assert.ok(html.includes(asset),"Missing new adventure asset "+asset);
}
for(const token of ["function move(dx,dy)","function openQuestion(s,target)",
  "function submitAnswer(s,correct)","function failLevel(s)",
  "async function finishLevel(s)","/adventure/progress","/adventure/complete",
  "starsForAdventure","/games/attempt","adventureSpellInput"]){
  assert.ok(client.includes(token),"Missing adventure client integration "+token);
}
assert.ok(html.includes("adventure-classic"),"Classic modes should remain optional");
assert.ok(api.includes('app.get("/adventure/progress"'));
assert.ok(api.includes('app.post("/adventure/complete"'));
assert.ok(api.includes("WHERE $2=1 OR EXISTS"),"Sequential level unlocking not enforced");
assert.ok(api.includes("CREATE TABLE IF NOT EXISTS adventure_progress"));
assert.ok(db.includes("CREATE TABLE IF NOT EXISTS adventure_progress"));
assert.ok(!/DROP\s+TABLE/i.test(api),"The migration must not delete learning history");
console.log("All eight stage layouts are reachable; progression and UI contracts passed.");
