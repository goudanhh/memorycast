// Deterministic, testable rules for the Knowledge Adventure.
// A level is a walkable world, not a renamed sequence of quiz questions.
export const ADVENTURE_LEVEL_COUNT=8;
export const MAP_WIDTH=13;
export const MAP_HEIGHT=9;

const stages=[
  ["记忆草原","找回第一束记忆之光","🌱"],
  ["萤火森林","在发光的岔路寻找知识宝石","🌿"],
  ["迷雾溪谷","突破迷雾与游荡的影子","💧"],
  ["森林守卫","面对第一位关底守卫","🌳"],
  ["星际书库","进入漂浮在群星间的书库","📚"],
  ["浮空遗迹","穿过古老知识遗迹","🏛️"],
  ["时间裂缝","在时间的裂缝中守住记忆","⏳"],
  ["记忆之心","击败最终守卫，点亮记忆之心","💎"]
];

const obstacleCandidates=[
  [2,4],[3,4],[4,4],[5,1],[6,2],[6,3],[6,5],[6,6],
  [8,5],[8,6],[2,5],[9,5],[4,2],[4,3],[10,4],[2,3],
  [3,6],[7,1],[9,1],[7,7],[5,7],[10,5],[2,2],[4,6]
];
const crystalSets=[
  [[2,1],[3,2],[4,1]],
  [[8,2],[9,3],[10,2]],
  [[9,7],[10,6],[8,7]]
];
const enemyLanes=[
  [[5,4],[6,4],[7,4],[8,4]],
  [[7,6],[8,6],[9,6],[10,6]],
  [[2,3],[3,3],[4,3],[5,3]]
];
const key=(x,y)=>x+","+y;
function randomFor(seed){
  let s=seed>>>0;
  return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296};
}
function reachable(walls,start,target){
  const seen=new Set([key(start.x,start.y)]),queue=[start];
  for(let i=0;i<queue.length;i++){
    const p=queue[i];if(p.x===target.x&&p.y===target.y)return true;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const x=p.x+dx,y=p.y+dy,k=key(x,y);
      if(x<=0||x>=MAP_WIDTH-1||y<=0||y>=MAP_HEIGHT-1||walls.has(k)||seen.has(k))continue;
      seen.add(k);queue.push({x,y});
    }
  }
  return false;
}

export function buildAdventureLevel(number){
  const level=Number(number);
  if(!Number.isInteger(level)||level<1||level>ADVENTURE_LEVEL_COUNT)throw Error("Invalid level");
  const [name,description,icon]=stages[level-1];
  const random=randomFor(level*3829+17);
  const start={x:1,y:7},portal={x:11,y:1};
  const crystals=crystalSets.map((arr,i)=>{
    const p=arr[(level+i)%arr.length];return {id:"crystal-"+i,x:p[0],y:p[1]};
  });
  const lanes=enemyLanes.slice(0,level>=6?3:level>=3?2:1);
  const protectedTiles=new Set([
    key(start.x,start.y),key(portal.x,portal.y),
    ...crystals.map(p=>key(p.x,p.y)),
    ...lanes.flat().map(p=>key(...p))
  ]);
  const available=obstacleCandidates.filter(p=>!protectedTiles.has(key(...p)));
  const shuffled=[...available].sort(()=>random()-.5); // seeded layout, validated below
  const walls=new Set();
  for(const p of shuffled.slice(0,Math.min(12+Math.floor(level/2),shuffled.length))){
    const k=key(...p);walls.add(k);
    if(![portal,...crystals].every(target=>reachable(walls,start,target)))walls.delete(k);
  }
  const enemies=lanes.map((lane,i)=>({
    id:"shade-"+i,route:lane.map(([x,y])=>({x,y})),offset:(level+i)%lane.length
  }));
  return {
    level,name,description,icon,world:Math.floor((level-1)/2),start,portal,
    crystals,enemies,walls:[...walls],
    bossRounds:level===8?3:level===4?2:1,
    motto:level===8?"终极守卫已苏醒":"收集三枚知识水晶，进入传送门挑战守卫"
  };
}

export function isWalkable(map,x,y){
  return Number.isInteger(x)&&Number.isInteger(y)&&x>0&&x<MAP_WIDTH-1&&
    y>0&&y<MAP_HEIGHT-1&&!map.walls.includes(key(x,y));
}
export function stepPosition(map,pos,dx,dy){
  const x=pos.x+dx,y=pos.y+dy;
  return isWalkable(map,x,y)?{x,y}:pos;
}
export function enemyPosition(enemy,tick){
  return enemy.route[(Math.floor(tick)+enemy.offset)%enemy.route.length];
}
export function canVisitLevel(level,highestCompleted){
  return Number.isInteger(level)&&level>=1&&level<=ADVENTURE_LEVEL_COUNT&&level<=highestCompleted+1;
}
export function starsForAdventure({mistakes=0,hearts=3}){
  if(mistakes===0&&hearts===3)return 3;
  if(mistakes<=2&&hearts>=1)return 2;
  return 1;
}
export function findTokenAt(map,x,y,taken){
  return map.crystals.find(c=>c.x===x&&c.y===y&&!taken.has(c.id))||null;
}
