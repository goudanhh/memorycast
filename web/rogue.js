import {
  BIOMES,MAX_WAVE,UPGRADES,SKILLS,clamp,distance,direction,closestEnemy,
  getUpgradeCost,normalizeProfile,startStats,rollWave,spawnType,skillChoices,
  canEnterSector,chooseRuneCard
} from "./rogue-engine.js?v=hybrid-1";
import {uniqueGameCards,makeListeningOptions,normalizeAnswer,isSpellingCard,chooseChallengeCards} from "./game-engine.js?v=challenge-v2";

const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,k=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[k]));
const W=960,H=600,CORE={x:480,y:300},PADS=[
  {x:335,y:245},{x:625,y:245},{x:335,y:365},{x:625,y:365},
  {x:425,y:160},{x:535,y:440}
];
const canvas=$("rogueCanvas"),ctx=canvas.getContext("2d");
let profile=normalizeProfile(),knowledge=[],s=null,raf=0,busy=false,keys=new Set(),touch={x:0,y:0},lastOpen=0;
const rnd=(a,b)=>a+Math.random()*(b-a);
const byId=id=>$(id);
async function api(path,opts={}){
  const response=await fetch("/api"+path,{
    ...opts,headers:{"Content-Type":"application/json",...(opts.headers||{})}
  });
  let body={};try{body=await response.json()}catch{}
  if(!response.ok)throw Error(body.error||"HTTP "+response.status);
  return body;
}
function message(text="",warn=false){
  $("rogueStatus").textContent=text;
  $("rogueStatus").classList.toggle("warning",warn);
}
async function openArcade(){
  if(busy||s?.active)return;
  busy=true;
  try{
    const result=await api("/arcade/profile");
    profile=normalizeProfile(result.profile);
    renderLobby();
    // Cards are optional; the action game runs even with an empty library.
    try{
      const c=await api("/games/cards");
      knowledge=chooseChallengeCards(uniqueGameCards(c.cards||[]),30);
    }catch(err){knowledge=[];message("战斗可正常游玩，但知识卡暂时无法载入："+err.message,true)}
    $("rogueKnowledge").textContent=knowledge.length?
      "✦ "+knowledge.length+" 张知识卡已装入可选符文":"✦ 纯战斗模式 · 导入知识卡即可开启知识符文";
  }catch(err){message("无法载入游戏存档："+err.message,true)}
  finally{busy=false}
}
function renderLobby(){
  $("rogueLobby").classList.remove("hidden");
  $("rogueBattle").classList.add("hidden");
  $("rogueResult").classList.add("hidden");
  $("rogueWallet").textContent=profile.coins+" 🪙";
  $("rogueXpTotal").textContent=profile.totalXp.toLocaleString()+" XP";
  $("rogueWins").textContent=profile.wins;
  $("rogueRuns").textContent=profile.runs;
  $("rogueSectors").innerHTML=BIOMES.map(b=>{
    const ok=canEnterSector(b.id,profile);
    return '<button type="button" class="rogue-sector '+(ok?"unlocked":"locked")+
      '" data-sector="'+b.id+'" '+(ok?"":"disabled")+'> '+
      '<span class="rogue-sector-number">ZONE 0'+b.id+'</span>'+
      '<span class="rogue-sector-icon">'+["🌿","🏜️","🚀"][b.id-1]+'</span>'+
      '<strong>'+esc(b.name)+'</strong><small>'+esc(b.subtitle)+'</small>'+
      '<span class="rogue-sector-enter">'+(ok?"▶ 开始防守":"🔒 上一区胜利后解锁")+'</span></button>';
  }).join("");
  $("rogueSectors").querySelectorAll("[data-sector]").forEach(button=>
    button.addEventListener("click",()=>startRun(Number(button.dataset.sector))));
  $("rogueShop").innerHTML=Object.entries(UPGRADES).map(([key,u])=>{
    const level=profile.upgrades[key],cost=getUpgradeCost(key,level);
    return '<div class="rogue-shop-item"><span class="rogue-shop-icon">'+u.icon+'</span>'+
      '<div><strong>'+esc(u.name)+' <small>Lv.'+level+'/5</small></strong>'+
      '<p>'+esc(u.description)+'</p></div>'+
      '<button type="button" data-upgrade="'+key+'" '+(cost===null||profile.coins<cost?"disabled":"")+'>'+
      (cost===null?"已满级":cost+" 🪙")+'</button></div>';
  }).join("");
  $("rogueShop").querySelectorAll("[data-upgrade]").forEach(button=>
    button.addEventListener("click",()=>buyUpgrade(button.dataset.upgrade)));
}
async function buyUpgrade(key){
  if(busy||s?.active)return;
  busy=true;
  try{
    const p=await api("/arcade/upgrade",{method:"POST",body:JSON.stringify({key})});
    profile=normalizeProfile(p.profile);
    renderLobby();message("永久装备升级成功！下一场战斗自动生效。");
  }catch(err){message(err.message,true)}
  finally{busy=false}
}
function startRun(sector){
  if(!canEnterSector(sector,profile)||s?.active)return;
  const stats=startStats(profile);
  s={
    active:true,finished:false,sector,biome:BIOMES[sector-1],wave:0,
    phase:"intermission",phaseTime:2.8,spawnLeft:0,spawnTime:0,
    hero:{x:480,y:420,hp:stats.heroMax,max:stats.heroMax,cd:0,inv:0,dash:0,look:0},
    core:{...CORE,hp:260,max:260,flash:0},damage:stats.damage,fireInterval:stats.fireInterval,
    pickupRadius:stats.pickupRadius,multi:1,thunder:0,bonusDamage:1,
    enemies:[],bullets:[],particles:[],drops:[],runes:[],towers:[],
    padTowers:new Set(),shots:0,kills:0,runGold:50,xp:0,level:1,skillQueue:0,
    skills:[],usedCards:[],runeChallenge:null,runeTimer:0,runeCount:0,
    time:0,frame:0,hoverPad:-1,lastHud:0,won:false,recorded:false,
    vfx:[],lastTime:performance.now()
  };
  $("rogueLobby").classList.add("hidden");
  $("rogueBattle").classList.remove("hidden");
  $("rogueResult").classList.add("hidden");
  $("rogueSkillDialog").classList.add("hidden");
  $("rogueRuneBox").classList.add("hidden");
  $("rogueBattleTitle").textContent=s.biome.name;
  $("rogueBattleSubtitle").textContent=s.biome.subtitle+" · 6 波防御挑战";
  message("WASD 移动，鼠标或触屏控制方向；Space/闪避键冲刺。靠近防御塔基座可建塔。");
  updateHud();
  cancelAnimationFrame(raf);
  raf=requestAnimationFrame(loop);
}
function startWave(){
  const g=s;if(!g||!g.active)return;
  g.wave++;
  g.phase="combat";
  const cfg=rollWave(g.sector,g.wave);
  g.spawnLeft=cfg.count;
  g.spawnTime=.3;
  g.phaseTime=0;
  g.hero.hp=Math.min(g.hero.max,g.hero.hp+Math.round(g.hero.max*.12));
  g.core.hp=Math.min(g.core.max,g.core.hp+14);
  if(g.wave===2||g.wave===4){spawnRune(); }
  burst(CORE.x,CORE.y,g.biome.accent,28);
  message(g.wave===MAX_WAVE?"⚠ Boss 入侵！保卫能量核心，击败守卫！":"第 "+g.wave+" 波来袭！躲避攻击并守住中央核心。");
}
function spawnEnemy(){
  const g=s,cfg=rollWave(g.sector,g.wave);
  const index=cfg.count-g.spawnLeft;
  const type=spawnType(g.sector,g.wave,index);
  const edge=Math.floor(Math.random()*4),point=edge===0?{x:rnd(20,940),y:15}:
    edge===1?{x:945,y:rnd(20,580)}:edge===2?{x:rnd(20,940),y:585}:{x:15,y:rnd(20,580)};
  const config={
    grunt:[40,61,11,14,"#6de3b4"],runner:[26,102,9,11,"#fbbf73"],
    charger:[64,84,16,17,"#fb7598"],tank:[115,36,19,22,"#bd9bf3"],
    boss:[660,39,30,43,"#ff759d"]
  }[type];
  const hp=Math.round(config[0]*cfg.hpScale);
  g.enemies.push({...point,type,hp,max:hp,speed:config[1]*(1+(g.sector-1)*.08),
    dmg:config[2],radius:config[3],color:config[4],attack:0,
    fired:0,phase:rnd(0,Math.PI*2),t:0});
}
function spawnRune(){
  if(!knowledge.length)return;
  const g=s;
  const card=chooseRuneCard(knowledge,g.usedCards);
  if(!card)return;
  const place={x:rnd(160,800),y:rnd(95,510)};
  // Runes do not block movement; player can choose to collect or ignore them.
  g.runes.push({...place,card,life:45,phase:Math.random()*6});
}
function showRune(card){
  const g=s;if(!g||g.runeChallenge)return;
  g.usedCards.push(card.id);
  const canSpell=isSpellingCard(card)&&g.runeCount%2===1;
  const options=makeListeningOptions(card,knowledge,4);
  const type=canSpell?"spell":options.length===4?"choice":"spell";
  if(type==="spell"&&!isSpellingCard(card)){
    // For non-English cards with too few options, give an instant powerup.
    castRune(true,false);return;
  }
  g.runeCount++;g.runeChallenge={card,type,options,started:g.time,expires:g.time+12,locked:false};
  $("rogueRuneBox").classList.remove("hidden");
  $("rogueRuneHint").textContent=type==="spell"?"主动回忆 · 拼对获得范围清屏":"限时知识符文 · 答对释放范围技能";
  $("rogueRunePrompt").textContent=type==="spell"?card.back:card.front;
  $("rogueRuneActions").innerHTML=type==="spell"?
    '<form id="rogueRuneForm"><input id="rogueRuneInput" autocomplete="off" spellcheck="false"'+
    ' placeholder="输入英文词汇" aria-label="知识符文拼写"/><button type="submit">施放魔法 ↵</button></form>':
    '<div class="rogue-rune-options">'+options.map((o,i)=>
      '<button type="button" data-rune-answer="'+esc(o.id)+'"><kbd>'+ (i+1)+'</kbd>'+esc(o.label)+'</button>').join("")+'</div>';
  $("rogueRuneActions").querySelectorAll("[data-rune-answer]").forEach(button=>
    button.addEventListener("click",()=>answerRune(button.dataset.runeAnswer===card.id)));
  if(type==="spell")$("rogueRuneForm").onsubmit=e=>{
    e.preventDefault();const value=$("rogueRuneInput").value.trim();
    if(value)answerRune(normalizeAnswer(value)===normalizeAnswer(card.front));
  };
}
function answerRune(correct){
  const g=s,r=g?.runeChallenge;
  if(!r||r.locked)return;
  r.locked=true;
  const ms=Math.min(600000,Math.floor((g.time-r.started)*1000));
  api("/games/attempt",{method:"POST",body:JSON.stringify({
    cardId:r.card.id,mode:r.type==="spell"?"spell":"match",correct,elapsedMs:ms
  })}).catch(err=>console.warn("Rune learning history:",err));
  castRune(correct,true);
}
function castRune(correct,close){
  const g=s;if(!g||!g.active)return;
  if(correct){
    g.core.hp=Math.min(g.core.max,g.core.hp+32);
    g.hero.hp=Math.min(g.hero.max,g.hero.hp+24);
    let hit=0;
    for(const enemy of g.enemies){
      enemy.hp-=140;hit++;
      burst(enemy.x,enemy.y,"#8bfff1",6);
    }
    burst(g.hero.x,g.hero.y,"#87ffee",44);
    message("✨ 知识符文释放！震荡波击中 "+hit+" 个敌人，恢复护盾！");
  }else message("符文能量消散。战斗继续，下一枚符文再试！",true);
  if(close){g.runeChallenge=null;$("rogueRuneBox").classList.add("hidden")}
}
function collectDrops(dt){
  const g=s,p=g.hero;
  for(let i=g.drops.length-1;i>=0;i--){
    const d=g.drops[i];d.life-=dt;
    if(d.life<=0){g.drops.splice(i,1);continue}
    const dis=distance(p,d);
    if(dis<g.pickupRadius+36){
      const v=direction(d,p);
      d.x+=v.x*(300+g.pickupRadius)*dt;d.y+=v.y*(300+g.pickupRadius)*dt;
    }
    if(distance(p,d)<19){
      if(d.type==="gold")g.runGold+=d.amount;
      else {g.xp+=d.amount;checkLevelUp()}
      burst(d.x,d.y,d.type==="gold"?"#ffd56b":"#58eccc",4);
      g.drops.splice(i,1);
    }
  }
}
function checkLevelUp(){
  const g=s;
  while(g.xp>=g.level*28){
    g.xp-=g.level*28;
    g.level++;g.skillQueue++;
  }
  if(g.skillQueue&&!g.pausedSkill)showSkills();
}
function showSkills(){
  const g=s;if(!g||!g.active||g.pausedSkill)return;
  g.pausedSkill=true;
  const choices=skillChoices(g.skills,g.level);
  if(!choices.length){
    g.hero.hp=Math.min(g.hero.max,g.hero.hp+30);g.skillQueue=0;g.pausedSkill=false;return;
  }
  $("rogueSkillDialog").classList.remove("hidden");
  $("rogueSkillChoices").innerHTML=choices.map(skill=>
    '<button type="button" data-skill="'+skill.id+'"><span>'+skill.icon+'</span>'+
    '<strong>'+esc(skill.name)+'</strong><small>'+esc(skill.description)+'</small></button>').join("");
  $("rogueSkillChoices").querySelectorAll("[data-skill]").forEach(button=>
    button.addEventListener("click",()=>applySkill(button.dataset.skill)));
}
function applySkill(id){
  const g=s;if(!g||!g.pausedSkill||!SKILLS.some(k=>k.id===id))return;
  g.skills.push(id);
  if(id==="rapid")g.fireInterval*=.8;
  if(id==="multi")g.multi++;
  if(id==="pierce")g.bonusDamage*=1.25;
  if(id==="heal"){g.hero.max+=30;g.hero.hp=Math.min(g.hero.max,g.hero.hp+65)}
  if(id==="thunder")g.thunder++;
  if(id==="shield")g.core.hp=Math.min(g.core.max,g.core.hp+70);
  g.skillQueue=Math.max(0,g.skillQueue-1);
  g.pausedSkill=false;
  $("rogueSkillDialog").classList.add("hidden");
  burst(g.hero.x,g.hero.y,"#e4bcff",35);
  message("获得技能："+SKILLS.find(k=>k.id===id).name);
  if(g.skillQueue)showSkills();
}
function buildTower(index){
  const g=s;if(!g||!g.active||g.pausedSkill)return;
  if(g.padTowers.has(index)||g.runGold<35){
    message(g.padTowers.has(index)?"此基座已有防御塔":"需要 35 战场金币才能建造防御塔",true);return;
  }
  const pad=PADS[index];
  if(distance(g.hero,pad)>130){
    message("靠近发光基座才能建造防御塔",true);return;
  }
  g.runGold-=35;
  g.padTowers.add(index);
  g.towers.push({...pad,idx:index,cd:0,level:1});
  burst(pad.x,pad.y,"#65efff",20);
  message("🏰 防御塔已建成！自动攻击靠近能量核心的敌人。");
}
function dash(){
  const g=s;if(!g||!g.active||g.hero.dash>0||g.pausedSkill)return;
  const input=movementVector();
  const vx=input.x||Math.cos(g.hero.look),vy=input.y||Math.sin(g.hero.look);
  const norm=Math.max(.1,Math.hypot(vx,vy));
  const start={x:g.hero.x,y:g.hero.y};
  g.hero.x=clamp(g.hero.x+vx/norm*125,23,W-23);
  g.hero.y=clamp(g.hero.y+vy/norm*125,23,H-23);
  g.hero.dash=3.2;g.hero.inv=.42;
  for(let i=0;i<12;i++)burst(start.x+(g.hero.x-start.x)*i/12,start.y+(g.hero.y-start.y)*i/12,"#7df3ed",2);
}
function movementVector(){
  const ax=(keys.has("KeyD")||keys.has("ArrowRight")?1:0)-(keys.has("KeyA")||keys.has("ArrowLeft")?1:0)+touch.x;
  const ay=(keys.has("KeyS")||keys.has("ArrowDown")?1:0)-(keys.has("KeyW")||keys.has("ArrowUp")?1:0)+touch.y;
  const d=Math.hypot(ax,ay);
  return d>1?{x:ax/d,y:ay/d}:{x:ax,y:ay};
}
function burst(x,y,color,count=8){
  const g=s;if(!g)return;
  for(let i=0;i<count;i++){
    const a=rnd(0,Math.PI*2),speed=rnd(30,180);
    g.particles.push({x,y,vx:Math.cos(a)*speed,vy:Math.sin(a)*speed,life:rnd(.16,.7),max:.7,color,r:rnd(1,4)});
  }
  if(g.particles.length>400)g.particles.splice(0,g.particles.length-400);
}
function shoot(from,target,damage,color,speed=540,kind="hero",angle=0){
  const g=s,v=direction(from,target),a=Math.atan2(v.y,v.x)+angle;
  g.bullets.push({x:from.x,y:from.y,vx:Math.cos(a)*speed,vy:Math.sin(a)*speed,
    damage,color,kind,r:kind==="enemy"?6:4,life:2.4});
}
function hurtHero(dmg){
  const g=s;if(g.hero.inv>0)return;
  g.hero.hp=Math.max(0,g.hero.hp-dmg);
  g.hero.inv=.72;burst(g.hero.x,g.hero.y,"#ff8fa3",17);
}
function killEnemy(enemy){
  const g=s;
  g.kills++;g.runGold+=enemy.type==="boss"?45:enemy.type==="tank"?6:2;
  const count=enemy.type==="boss"?12:enemy.type==="tank"?3:2;
  for(let i=0;i<count;i++){
    g.drops.push({x:enemy.x+rnd(-12,12),y:enemy.y+rnd(-12,12),
      type:i%3===0?"gold":"xp",amount:i%3===0?3:7,life:17});
  }
  burst(enemy.x,enemy.y,enemy.color,enemy.type==="boss"?65:16);
}
function tick(dt){
  const g=s;if(!g||!g.active||g.pausedSkill)return;
  g.time+=dt;g.frame++;
  const p=g.hero;
  p.cd-=dt;p.inv=Math.max(0,p.inv-dt);p.dash=Math.max(0,p.dash-dt);
  g.core.flash=Math.max(0,g.core.flash-dt);
  const movement=movementVector(),length=Math.hypot(movement.x,movement.y);
  if(length>.01){
    p.x=clamp(p.x+movement.x*200*dt,21,W-21);
    p.y=clamp(p.y+movement.y*200*dt,21,H-21);
    p.look=Math.atan2(movement.y,movement.x);
  }
  if(g.phase==="intermission"){
    g.phaseTime-=dt;
    if(g.phaseTime<=0)startWave();
  }else if(g.phase==="combat"){
    if(g.spawnLeft>0){
      g.spawnTime-=dt;
      if(g.spawnTime<=0){
        spawnEnemy();g.spawnLeft--;g.spawnTime=rollWave(g.sector,g.wave).interval;
      }
    }else if(g.enemies.length===0){
      if(g.wave===MAX_WAVE){endRun(true);return}
      g.phase="intermission";g.phaseTime=3;
      message("✓ 第 "+g.wave+" 波已击退！准备迎接下一波。");
    }
  }
  const target=closestEnemy(g.enemies,p,415);
  if(target&&p.cd<=0){
    p.cd=g.fireInterval;
    const spread=g.multi;
    for(let n=0;n<spread;n++){
      const angle=(n-(spread-1)/2)*.22;
      shoot(p,target,g.damage*g.bonusDamage,"#63f7db",635,"hero",angle);
    }
  }
  for(const tower of g.towers){
    tower.cd-=dt;
    const near=closestEnemy(g.enemies,tower,265);
    if(near&&tower.cd<=0){
      tower.cd=.64;shoot(tower,near,14*g.bonusDamage,"#ffce7b",480,"tower");
    }
  }
  if(g.thunder&&g.frame%18===0){
    const near=closestEnemy(g.enemies,p,165);
    if(near){
      near.hp-=9*g.thunder;
      g.vfx.push({x1:p.x,y1:p.y,x2:near.x,y2:near.y,life:.14});
    }
  }
  for(const e of g.enemies){
    e.t+=dt;e.attack=Math.max(0,e.attack-dt);
    e.fired=Math.max(0,e.fired-dt);
    const boss=e.type==="boss";
    const dest=distance(e,p)<(boss?175:125)?p:g.core;
    const dist=distance(e,dest);
    if(dist>e.radius+(dest===p?13:36)){
      const v=direction(e,dest);
      e.x+=v.x*e.speed*dt;e.y+=v.y*e.speed*dt;
    }else if(e.attack<=0){
      e.attack=boss?.7:1.05;
      if(dest===p)hurtHero(e.dmg);
      else {g.core.hp=Math.max(0,g.core.hp-e.dmg);g.core.flash=.28}
    }
    if(boss&&e.fired<=0&&distance(e,p)<390){
      e.fired=2.4;
      // A boss can launch radial projectiles: dodge with movement or dash.
      for(let n=0;n<9;n++){
        const angle=n*Math.PI*2/9+e.t*.24;
        g.bullets.push({x:e.x,y:e.y,vx:Math.cos(angle)*152,vy:Math.sin(angle)*152,
          damage:12,kind:"enemy",color:"#ff91c0",r:6,life:3});
      }
    }
  }
  for(let i=g.bullets.length-1;i>=0;i--){
    const b=g.bullets[i];
    b.x+=b.vx*dt;b.y+=b.vy*dt;b.life-=dt;
    if(b.life<=0||b.x<-40||b.x>W+40||b.y<-40||b.y>H+40){g.bullets.splice(i,1);continue}
    if(b.kind==="enemy"){
      if(distance(b,p)<b.r+13){
        hurtHero(b.damage);
        g.bullets.splice(i,1);continue;
      }
      if(distance(b,g.core)<b.r+33){
        g.core.hp=Math.max(0,g.core.hp-b.damage);
        g.core.flash=.24;
        g.bullets.splice(i,1);continue;
      }
    }else{
      const victim=g.enemies.find(e=>e.hp>0&&distance(b,e)<e.radius+b.r);
      if(victim){
        victim.hp-=b.damage;
        burst(b.x,b.y,victim.color,3);g.bullets.splice(i,1);
      }
    }
  }
  for(let i=g.enemies.length-1;i>=0;i--){
    if(g.enemies[i].hp<=0){
      killEnemy(g.enemies[i]);g.enemies.splice(i,1);
    }
  }
  collectDrops(dt);
  for(let i=g.runes.length-1;i>=0;i--){
    const rune=g.runes[i];rune.life-=dt;
    if(rune.life<=0){g.runes.splice(i,1);continue}
    if(!g.runeChallenge&&distance(p,rune)<30){
      g.runes.splice(i,1);showRune(rune.card);
    }
  }
  if(g.runeChallenge&&g.time>=g.runeChallenge.expires&&!g.runeChallenge.locked){
    g.runeChallenge.locked=true;
    castRune(false,true);
  }
  for(const v of g.vfx)v.life-=dt;
  g.vfx=g.vfx.filter(v=>v.life>0);
  for(const q of g.particles){q.x+=q.vx*dt;q.y+=q.vy*dt;q.life-=dt;}
  g.particles=g.particles.filter(p=>p.life>0);
  if(g.hero.hp<=0||g.core.hp<=0){endRun(false);return}
  if(g.time-g.lastHud>.13){g.lastHud=g.time;updateHud()}
}
function updateHud(){
  const g=s;if(!g)return;
  const format=(a,b)=>Math.max(0,Math.ceil(a))+" / "+Math.ceil(b);
  $("rogueHealth").textContent=format(g.hero.hp,g.hero.max);
  $("rogueHealthBar").style.width=clamp(g.hero.hp/g.hero.max*100,0,100)+"%";
  $("rogueCore").textContent=format(g.core.hp,g.core.max);
  $("rogueCoreBar").style.width=clamp(g.core.hp/g.core.max*100,0,100)+"%";
  $("rogueWave").textContent=g.wave+" / "+MAX_WAVE;
  $("rogueGold").textContent=g.runGold;
  $("rogueKills").textContent=g.kills;
  $("rogueLevel").textContent=g.level;
  $("rogueXpBar").style.width=clamp(g.xp/(g.level*28)*100,0,100)+"%";
  $("rogueDashText").textContent=g.hero.dash>0?g.hero.dash.toFixed(1)+"s":"就绪";
  $("roguePhase").textContent=g.phase==="intermission"?
    "下一波："+Math.max(0,Math.ceil(g.phaseTime))+" 秒":"正在防守 · "+g.enemies.length+" 名敌人";
  if(g.runeChallenge){
    $("rogueRuneTimer").textContent=Math.max(0,Math.ceil(g.runeChallenge.expires-g.time))+" 秒";
  }
  // Show contextual build control near the closest free tower pad.
  const available=PADS.map((p,i)=>({i,d:distance(g.hero,p)})).filter(p=>
    p.d<130&&!g.padTowers.has(p.i)).sort((a,b)=>a.d-b.d)[0];
  g.hoverPad=available?available.i:-1;
  $("rogueBuild").disabled=g.hoverPad<0||g.runGold<35;
  $("rogueBuild").textContent=available?"🏰 建塔 · 35 金币":"🏰 靠近蓝色基座";
}
function draw(){
  const g=s;if(!g)return;
  const b=g.biome;
  ctx.fillStyle=b.floor;ctx.fillRect(0,0,W,H);
  const bg=ctx.createRadialGradient(CORE.x,CORE.y,60,CORE.x,CORE.y,470);
  bg.addColorStop(0,b.accent+"12");bg.addColorStop(1,"#050c2600");
  ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
  ctx.strokeStyle="#ffffff0b";ctx.lineWidth=1;
  ctx.beginPath();
  for(let x=0;x<=W;x+=40){ctx.moveTo(x,0);ctx.lineTo(x,H)}
  for(let y=0;y<=H;y+=40){ctx.moveTo(0,y);ctx.lineTo(W,y)}
  ctx.stroke();
  for(let i=0;i<65;i++){
    const x=(i*117+g.sector*19)%W,y=(i*263+g.sector*47)%H;
    ctx.fillStyle="#d5edff"+(i%3?"18":"38");
    ctx.fillRect(x,y,2,2);
  }
  for(const [index,p] of PADS.entries()){
    const built=g.padTowers.has(index),near=g.hoverPad===index;
    ctx.save();ctx.translate(p.x,p.y);
    ctx.shadowBlur=near?25:12;ctx.shadowColor=built?"#6fecf1":"#427bfa";
    ctx.fillStyle=built?"#1a869a":"#1a345a";ctx.strokeStyle=near?"#90fff4":"#5d99e6";
    ctx.lineWidth=2.5;ctx.beginPath();ctx.arc(0,0,21,0,Math.PI*2);ctx.fill();ctx.stroke();
    if(built){
      ctx.fillStyle="#c3fcff";ctx.fillRect(-9,-9,18,18);
      ctx.fillStyle="#18375f";ctx.fillRect(-3,-20,6,20);
    }else{
      ctx.fillStyle="#7aaaff";ctx.font="23px sans-serif";ctx.textAlign="center";ctx.fillText("+",0,8);
    }
    ctx.restore();
  }
  const core=g.core;
  ctx.save();ctx.translate(CORE.x,CORE.y);
  ctx.shadowBlur=30+Math.sin(g.time*3)*8;ctx.shadowColor=core.flash?"#ff6986":b.accent;
  ctx.strokeStyle=core.flash?"#ff8fa3":b.accent;ctx.lineWidth=4;
  ctx.beginPath();ctx.arc(0,0,46+Math.sin(g.time*2)*2,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle=core.flash?"#fb8398":"#8af5f1";
  ctx.beginPath();
  for(let i=0;i<6;i++){
    const a=i*Math.PI/3+g.time*.22;
    const x=Math.cos(a)*29,y=Math.sin(a)*29;
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  }
  ctx.closePath();ctx.fill();
  ctx.fillStyle="#17375c";ctx.beginPath();ctx.arc(0,0,12,0,Math.PI*2);ctx.fill();
  ctx.restore();
  for(const rune of g.runes){
    ctx.save();ctx.translate(rune.x,rune.y+Math.sin(g.time*3+rune.phase)*7);
    ctx.shadowBlur=25;ctx.shadowColor="#d3a4ff";
    ctx.fillStyle="#b6a7ff";ctx.font="29px sans-serif";ctx.textAlign="center";ctx.fillText("✦",0,10);
    ctx.restore();
  }
  for(const drop of g.drops){
    ctx.fillStyle=drop.type==="gold"?"#ffd66a":"#7fffe0";
    ctx.shadowBlur=9;ctx.shadowColor=ctx.fillStyle;
    ctx.beginPath();ctx.arc(drop.x,drop.y,drop.type==="gold"?5:4,0,Math.PI*2);ctx.fill();
    ctx.shadowBlur=0;
  }
  for(const enemy of g.enemies){
    const boss=enemy.type==="boss";
    ctx.save();ctx.translate(enemy.x,enemy.y);
    ctx.shadowBlur=boss?35:15;ctx.shadowColor=enemy.color;
    ctx.fillStyle=enemy.color;ctx.beginPath();ctx.arc(0,0,enemy.radius,0,Math.PI*2);ctx.fill();
    ctx.fillStyle="#14233c";
    ctx.beginPath();ctx.arc(-enemy.radius*.25,-enemy.radius*.15,Math.max(2,enemy.radius*.12),0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(enemy.radius*.25,-enemy.radius*.15,Math.max(2,enemy.radius*.12),0,Math.PI*2);ctx.fill();
    ctx.strokeStyle="#15213e";ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(0,4,enemy.radius*.35,0,Math.PI);ctx.stroke();
    ctx.restore();
    if(enemy.hp<enemy.max||boss){
      ctx.fillStyle="#09243c";ctx.fillRect(enemy.x-enemy.radius,enemy.y-enemy.radius-13,enemy.radius*2,5);
      ctx.fillStyle=boss?"#ff79ba":"#76e9d1";
      ctx.fillRect(enemy.x-enemy.radius,enemy.y-enemy.radius-13,enemy.radius*2*clamp(enemy.hp/enemy.max,0,1),5);
    }
  }
  for(const bullet of g.bullets){
    ctx.fillStyle=bullet.color;ctx.shadowColor=bullet.color;ctx.shadowBlur=12;
    ctx.beginPath();ctx.arc(bullet.x,bullet.y,bullet.r,0,Math.PI*2);ctx.fill();
  }
  ctx.shadowBlur=0;
  for(const beam of g.vfx){
    ctx.strokeStyle="#a8ffff";ctx.lineWidth=3;ctx.beginPath();
    ctx.moveTo(beam.x1,beam.y1);ctx.lineTo(beam.x2,beam.y2);ctx.stroke();
  }
  for(const particle of g.particles){
    ctx.globalAlpha=clamp(particle.life/particle.max,0,1);
    ctx.fillStyle=particle.color;
    ctx.fillRect(particle.x,particle.y,particle.r,particle.r);
  }
  ctx.globalAlpha=1;
  const hero=g.hero;
  ctx.save();ctx.translate(hero.x,hero.y);
  ctx.rotate(hero.look+Math.PI/2);
  ctx.shadowBlur=20;ctx.shadowColor="#5ef3dc";
  ctx.globalAlpha=hero.inv>0&&Math.floor(g.time*17)%2===0?.47:1;
  ctx.fillStyle="#d2fcff";ctx.beginPath();ctx.moveTo(0,-19);ctx.lineTo(16,13);ctx.lineTo(0,8);ctx.lineTo(-16,13);ctx.closePath();ctx.fill();
  ctx.fillStyle=b.accent;ctx.fillRect(-7,-3,14,9);
  ctx.fillStyle="#18243e";ctx.beginPath();ctx.arc(0,-8,5,0,Math.PI*2);ctx.fill();
  ctx.restore();
  if(g.phase==="intermission"&&!g.pausedSkill){
    ctx.fillStyle="#040b21bb";ctx.fillRect(W/2-202,56,404,60);
    ctx.textAlign="center";ctx.fillStyle="#e5fff9";ctx.font="bold 24px system-ui";
    ctx.fillText(g.wave===0?"准备出发":"下一波即将来袭",W/2,94);
  }
  if(g.wave===MAX_WAVE&&g.enemies.some(e=>e.type==="boss")){
    ctx.fillStyle="#ffb1c4";ctx.textAlign="center";ctx.font="bold 19px system-ui";
    ctx.fillText("⚠ 守卫入侵",W/2,34);
  }
  ctx.shadowBlur=0;
}
function loop(now){
  const g=s;
  if(!g||!g.active)return;
  const dt=Math.min(.04,(now-g.lastTime)/1000);
  g.lastTime=now;
  if(!document.hidden){tick(Math.max(0,dt));draw();}
  if(s===g&&g.active)raf=requestAnimationFrame(loop);
}
async function endRun(won){
  const g=s;if(!g||!g.active)return;
  g.active=false;g.finished=true;g.won=won;
  cancelAnimationFrame(raf);
  keys.clear();touch={x:0,y:0};
  $("rogueSkillDialog").classList.add("hidden");
  $("rogueRuneBox").classList.add("hidden");
  $("rogueBattle").classList.add("hidden");
  $("rogueResult").classList.remove("hidden");
  $("rogueResultIcon").textContent=won?"🏆":"💫";
  $("rogueResultTitle").textContent=won?"战区胜利 · 核心保卫成功":"本次防线失守";
  $("rogueResultInfo").textContent=g.biome.name+" · 击杀 "+g.kills+
    " · 抵挡 "+g.wave+" 波 · 游戏时间 "+Math.ceil(g.time)+" 秒";
  $("rogueResultRewards").textContent="正在结算战利品…";
  $("rogueResultActions").classList.add("hidden");
  try{
    const result=await api("/arcade/finish",{method:"POST",body:JSON.stringify({
      sector:g.sector,wave:Math.max(1,g.wave),kills:Math.min(260,g.kills),
      seconds:Math.max(1,Math.ceil(g.time)),won
    })});
    if(s!==g)return;
    profile=normalizeProfile(result.profile);
    $("rogueResultRewards").textContent="+"+result.rewards.coins+" 金币 · +"+
      result.rewards.xp+" 经验"+(won?" · 解锁下一战区！":"");
    $("rogueResultActions").classList.remove("hidden");
  }catch(err){
    if(s!==g)return;
    $("rogueResultRewards").textContent="结算失败："+err.message;
    $("rogueResultActions").classList.remove("hidden");
    $("rogueRetrySave").classList.remove("hidden");
    $("rogueRetrySave").onclick=()=>endRunRetry(g);
  }
}
async function endRunRetry(g){
  if(s!==g||!g.finished)return;
  $("rogueRetrySave").disabled=true;
  try{
    const out=await api("/arcade/finish",{method:"POST",body:JSON.stringify({
      sector:g.sector,wave:Math.max(1,g.wave),kills:Math.min(260,g.kills),
      seconds:Math.max(1,Math.ceil(g.time)),won:g.won
    })});
    if(s!==g)return;
    profile=normalizeProfile(out.profile);
    $("rogueResultRewards").textContent="结算成功：+"+out.rewards.coins+" 金币 · +"+out.rewards.xp+" XP";
    $("rogueRetrySave").classList.add("hidden");
  }catch(err){$("rogueResultRewards").textContent="仍未保存："+err.message;}
  finally{$("rogueRetrySave").disabled=false;}
}
function stopRun(){
  if(s)s.active=false;
  cancelAnimationFrame(raf);s=null;keys.clear();touch={x:0,y:0};
  $("rogueRuneBox").classList.add("hidden");
  $("rogueSkillDialog").classList.add("hidden");
  renderLobby();
}
function canvasCoords(event){
  const rect=canvas.getBoundingClientRect();
  return {x:(event.clientX-rect.left)/rect.width*W,y:(event.clientY-rect.top)/rect.height*H};
}
canvas.addEventListener("pointerdown",event=>{
  const g=s;
  if(!g?.active||g.pausedSkill)return;
  const p=canvasCoords(event);
  for(let i=0;i<PADS.length;i++){
    if(distance(p,PADS[i])<35){buildTower(i);return}
  }
  // Drag anywhere on the canvas to steer, including touch devices.
  canvas.setPointerCapture(event.pointerId);
  g.pointerStart={x:event.clientX,y:event.clientY};
});
canvas.addEventListener("pointermove",event=>{
  const g=s;if(!g?.pointerStart)return;
  const x=event.clientX-g.pointerStart.x,y=event.clientY-g.pointerStart.y;
  const len=Math.max(1,Math.hypot(x,y));
  touch={x:clamp(x/Math.max(44,len),-1,1),y:clamp(y/Math.max(44,len),-1,1)};
});
for(const eventName of ["pointerup","pointercancel","lostpointercapture"]){
  canvas.addEventListener(eventName,()=>{touch={x:0,y:0};if(s)s.pointerStart=null});
}
const moves={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]};
for(const button of document.querySelectorAll("[data-rogue-dir]")){
  const [x,y]=moves[button.dataset.rogueDir];
  button.addEventListener("pointerdown",event=>{
    if(!s?.active)return;event.preventDefault();button.setPointerCapture(event.pointerId);
    touch={x,y};
  });
  for(const eventName of ["pointerup","pointercancel","lostpointercapture"]){
    button.addEventListener(eventName,()=>touch={x:0,y:0});
  }
}
document.addEventListener("keydown",event=>{
  const g=s;if(!g?.active||!$("gamesPage").classList.contains("active"))return;
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||""))return;
  if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.code))event.preventDefault();
  if(event.code==="Space"&&!event.repeat)dash();
  if(event.code==="KeyE"&&!event.repeat&&g.hoverPad>=0)buildTower(g.hoverPad);
  if(["KeyW","KeyS","KeyA","KeyD","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.code))
    keys.add(event.code);
  if(g.runeChallenge&&/^[1-4]$/.test(event.key)){
    const b=$("rogueRuneActions").querySelectorAll("[data-rune-answer]")[Number(event.key)-1];
    b?.click();
  }
});
document.addEventListener("keyup",event=>keys.delete(event.code));
window.addEventListener("blur",()=>{keys.clear();touch={x:0,y:0}});
$("rogueDash").onclick=dash;
$("rogueBuild").onclick=()=>{if(s?.hoverPad>=0)buildTower(s.hoverPad)};
$("rogueQuit").onclick=()=>{if(s?.active)endRun(false)};
$("rogueToLobby").onclick=()=>{stopRun();openArcade()};
$("roguePlayAgain").onclick=()=>{
  const sector=s?.sector||1;stopRun();startRun(sector);
};
document.querySelector('[data-page="gamesPage"]')?.addEventListener("click",openArcade);
document.querySelector('[data-go="gamesPage"]')?.addEventListener("click",openArcade);
document.querySelectorAll('.nav [data-page]').forEach(button=>{
  if(button.dataset.page!=="gamesPage")button.addEventListener("click",()=>{
    if(s?.active){s.lastTime=performance.now();s.pausedSkill=true;message("战斗已暂停。返回游戏页面可继续。");}
  });
});
document.querySelector('[data-page="gamesPage"]')?.addEventListener("click",()=>{
  if(s?.active&&s.pausedSkill&&!(!$("rogueSkillDialog").classList.contains("hidden"))){
    s.pausedSkill=false;s.lastTime=performance.now();
  }
});
