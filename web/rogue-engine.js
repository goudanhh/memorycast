// MemoryCast hybrid arcade: pure rules shared by the game and CI.
// Canvas renderer contains no scheduling or user-data mutations.
export const BIOMES=[
  {id:1,name:"霓虹草原",subtitle:"发现失控的记忆孢子",sky:"#0d1830",floor:"#102b36",accent:"#36e5c8",boss:"深渊巨藤"},
  {id:2,name:"晶核沙漠",subtitle:"穿过沙丘保卫能量核心",sky:"#251631",floor:"#34253e",accent:"#ffbd6b",boss:"沙漠吞噬者"},
  {id:3,name:"星舰废墟",subtitle:"击退最终入侵者",sky:"#101a3f",floor:"#152754",accent:"#aa89ff",boss:"机械记忆王"}
];
export const MAX_WAVE=6;
export const UPGRADE_MAX=5;
export const UPGRADES=Object.freeze({
  power:{name:"脉冲火力",description:"永久提高子弹伤害",icon:"⚡",cost:65,step:45},
  armor:{name:"反应护盾",description:"永久提高生命上限",icon:"🛡️",cost:65,step:50},
  magnet:{name:"磁场拾取",description:"更容易吸取掉落物",icon:"🧲",cost:45,step:35}
});
export const SKILLS=Object.freeze([
  {id:"rapid",icon:"⚡",name:"速射",description:"射击间隔 -20%"},
  {id:"multi",icon:"🎯",name:"散射",description:"额外发射一枚子弹"},
  {id:"pierce",icon:"💥",name:"重炮",description:"所有攻击伤害 +25%"},
  {id:"heal",icon:"💚",name:"修复模块",description:"恢复大量生命并提高上限"},
  {id:"thunder",icon:"🌩️",name:"雷暴",description:"持续攻击附近的敌人"},
  {id:"shield",icon:"🔰",name:"防卫强化",description:"能量核心回复护盾"},
]);
const round=(x)=>Math.max(0,Math.floor(Number(x)||0));
export function clamp(v,min,max){return Math.min(max,Math.max(min,Number(v)||0))}
export function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
export function direction(from,to){
  const d=Math.max(.0001,distance(from,to));
  return {x:(to.x-from.x)/d,y:(to.y-from.y)/d};
}
export function closestEnemy(enemies,pos,range=Infinity){
  let best=null,bestD=range;
  for(const enemy of enemies){
    if(enemy.hp<=0)continue;
    const d=distance(enemy,pos);
    if(d<bestD){best=enemy;bestD=d}
  }
  return best;
}
export function getUpgradeCost(key,level){
  const spec=UPGRADES[key];
  if(!spec||!Number.isInteger(level)||level<0||level>=UPGRADE_MAX)return null;
  return spec.cost+level*spec.step;
}
export function initialProfile(){
  return {coins:0,totalXp:0,runs:0,bestWave:0,highestSector:1,wins:0,
    upgrades:{power:0,armor:0,magnet:0}};
}
export function normalizeProfile(p={}){
  const out=initialProfile();
  for(const field of ["coins","totalXp","runs","bestWave","wins"]){
    out[field]=round(p[field]);
  }
  out.highestSector=clamp(Math.floor(p.highestSector||1),1,3);
  for(const key of Object.keys(UPGRADES)){
    out.upgrades[key]=clamp(Math.floor(p.upgrades?.[key]||0),0,UPGRADE_MAX);
  }
  return out;
}
export function computeRewards(sector,wave,kills,won){
  const safeSector=clamp(Math.floor(sector),1,3);
  const safeWave=clamp(Math.floor(wave),1,MAX_WAVE);
  const safeKills=clamp(Math.floor(kills),0,260);
  return {
    coins:Math.min(260,Math.floor(safeWave*8+safeKills*1.4+(won?45:0)+safeSector*3)),
    xp:Math.min(700,Math.floor(safeWave*25+safeKills*3+(won?105:0)+safeSector*12))
  };
}
export function startStats(profile){
  const p=normalizeProfile(profile);
  return {
    heroMax:100+p.upgrades.armor*20,
    damage:16+p.upgrades.power*4,
    pickupRadius:27+p.upgrades.magnet*15,
    fireInterval:.44
  };
}
export function rollWave(sector,wave){
  const b=clamp(Math.floor(sector),1,3),w=clamp(Math.floor(wave),1,MAX_WAVE);
  const count=6+w*3+b*2;
  return {count,boss:w===MAX_WAVE,interval:clamp(.8-w*.07,.27,.8),
    hpScale:1+(w-1)*.27+(b-1)*.42};
}
export function spawnType(sector,wave,index){
  if(wave===MAX_WAVE&&index===0)return "boss";
  if(wave>=3&&index%6===0)return "charger";
  if(sector>=2&&index%5===0)return "tank";
  if(wave>=2&&index%4===0)return "runner";
  return "grunt";
}
export function skillChoices(owned=[],seed=0){
  const candidates=SKILLS.filter(x=>!owned.includes(x.id));
  if(candidates.length===0)return [];
  const rotated=candidates.slice(seed%candidates.length).concat(candidates.slice(0,seed%candidates.length));
  return rotated.slice(0,3);
}
export function canEnterSector(sector,profile){
  return Number.isInteger(sector)&&sector>=1&&sector<=3&&
    sector<=normalizeProfile(profile).highestSector;
}
// Knowledge boost is optional and only triggered by the player stepping
// onto a glowing rune. No interruption or forced recall prompt.
export function chooseRuneCard(pool,usedIds=[]){
  const used=new Set(usedIds);
  return (pool||[]).find(c=>c?.id&&!used.has(c.id)&&String(c.back||"").trim()&&String(c.front||"").trim())||null;
}
