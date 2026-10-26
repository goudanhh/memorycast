import {
  ADVENTURE_LEVEL_COUNT,MAP_WIDTH,MAP_HEIGHT,buildAdventureLevel,
  stepPosition,enemyPosition,canVisitLevel,starsForAdventure,findTokenAt
} from "./adventure-engine.js?v=1";
import {
  uniqueGameCards,chooseChallengeCards,makeListeningOptions,normalizeAnswer,
  isSpellingCard,isAudioEligible
} from "./game-engine.js?v=challenge-v2";

const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));
const posKey=p=>p.x+","+p.y;
let progress=[],cards=[],highest=0,run=null,loading=false;
async function api(path,options={}){
  const res=await fetch("/api"+path,{
    ...options,headers:{"Content-Type":"application/json",...(options.headers||{})}
  });
  let data={};try{data=await res.json()}catch{}
  if(!res.ok)throw Error(data.error||"HTTP "+res.status);
  return data;
}
function note(message="",danger=false){
  $("adventureNotice").textContent=message;
  $("adventureNotice").classList.toggle("danger",danger);
}
async function openAdventure(){
  if(loading||run)return;
  loading=true;
  try{
    const [p,c]=await Promise.all([api("/adventure/progress"),api("/games/cards")]);
    progress=p.levels||[];highest=p.highestCompleted||0;
    cards=uniqueGameCards(c.cards||[]);
    $("adventureLibraryCount").textContent=cards.length+" 张可用知识卡";
    drawCampaign();
    note(cards.length<4?"至少需要 4 张正反面各不相同的知识卡，才能开启探索。":"选择一关，开始探索！");
  }catch(error){note("冒险数据加载失败："+error.message,true)}
  finally{loading=false}
}
function starsText(count){return "★".repeat(count)+"☆".repeat(3-count)}
function drawCampaign(){
  const container=$("adventureChapters");
  let total=progress.reduce((sum,l)=>sum+Number(l.stars||0),0);
  $("adventureTotalStars").textContent=total+" / "+ADVENTURE_LEVEL_COUNT*3+" ★";
  $("adventureUnlocked").textContent=Math.min(ADVENTURE_LEVEL_COUNT,highest+1)+" / "+ADVENTURE_LEVEL_COUNT+" 关解锁";
  container.innerHTML=Array.from({length:ADVENTURE_LEVEL_COUNT},(_,index)=>{
    const level=index+1,stage=buildAdventureLevel(level);
    const record=progress.find(p=>Number(p.level)===level);
    const unlocked=canVisitLevel(level,highest);
    return '<button type="button" class="adventure-node world-'+stage.world+
      (record?' completed':'')+(unlocked?' unlocked':' locked')+
      '" data-adventure-level="'+level+'" '+(unlocked?'':'disabled aria-label="第'+level+'关尚未解锁"')+'>'+
      '<span class="adventure-number">LEVEL '+String(level).padStart(2,"0")+'</span>'+
      '<span class="adventure-node-icon">'+(unlocked?stage.icon:"🔒")+'</span>'+
      '<strong>'+esc(stage.name)+'</strong>'+
      '<small>'+ (record?starsText(record.stars):unlocked?"▶ 可以挑战":"完成前一关解锁")+'</small></button>';
  }).join("");
  container.querySelectorAll("[data-adventure-level]").forEach(btn=>btn.addEventListener("click",()=>
    startLevel(Number(btn.dataset.adventureLevel))));
}
function stopRun(){
  if(run?.timer)clearInterval(run.timer);
  if("speechSynthesis" in window)speechSynthesis.cancel();
  run=null;
  $("adventureQuest").classList.add("hidden");
  $("adventureWorldPanel").classList.add("hidden");
  $("adventureCampaign").classList.remove("hidden");
  $("adventureMap").replaceChildren();
  $("adventureWorldPanel").classList.remove("adventure-shake");
}
function startLevel(level){
  if(run)stopRun();
  if(!canVisitLevel(level,highest))return note("这一关还没有解锁。",true);
  if(cards.length<4)return note("知识卡数量不足：至少需要4张不同释义的知识卡。",true);
  const map=buildAdventureLevel(level);
  const deck=chooseChallengeCards(cards,Math.min(cards.length,3+map.bossRounds+3));
  const now=Date.now();
  run={
    level,map,deck,deckIndex:0,pos:{...map.start},hp:3,
    taken:new Set(),bossWins:0,errors:0,score:0,
    questions:0,attemptPromises:[],question:null,lastMoveAt:now,
    enemyTick:0,invulnUntil:0,finished:false,started:now,
    hiddenAt:0,timer:null
  };
  const s=run;
  $("adventureCampaign").classList.add("hidden");
  $("adventureWorldPanel").classList.remove("hidden");
  $("adventureWorldPanel").dataset.world=map.world;
  $("adventureName").textContent=map.icon+" 第 "+level+" 关 · "+map.name;
  $("adventureStory").textContent=map.description;
  $("adventureMotto").textContent=map.motto;
  $("adventureQuest").classList.add("hidden");
  $("adventureEndScreen").classList.add("hidden");
  $("adventureWorldContent").classList.remove("hidden");
  $("adventureWorldPanel").scrollIntoView({behavior:"smooth",block:"start"});
  s.timer=setInterval(()=>updateWorld(s),550);
  renderMap(s);
  updateHud(s);
  note("使用方向键或 WASD 移动，手机可以点击地图下方方向按钮。");
}
function updateHud(s){
  if(s!==run)return;
  $("adventureHearts").textContent="❤️".repeat(s.hp)+"🖤".repeat(3-s.hp);
  $("adventureCrystals").textContent=s.taken.size+" / 3";
  $("adventureBossProgress").textContent=s.bossWins+" / "+s.map.bossRounds;
  $("adventureElapsed").textContent=Math.floor((Date.now()-s.started)/1000)+"s";
}
function enemiesAt(s){
  return s.map.enemies.map(enemy=>enemyPosition(enemy,s.enemyTick));
}
function renderMap(s){
  if(s!==run||s.finished)return;
  const walls=new Set(s.map.walls),enemies=new Set(enemiesAt(s).map(posKey));
  const crystalByPlace=new Map(s.map.crystals.map(c=>[posKey(c),c]));
  const entries=[];
  for(let y=0;y<MAP_HEIGHT;y++){
    for(let x=0;x<MAP_WIDTH;x++){
      const k=x+","+y,edge=x===0||y===0||x===MAP_WIDTH-1||y===MAP_HEIGHT-1;
      const solid=edge||walls.has(k);
      const portal=x===s.map.portal.x&&y===s.map.portal.y;
      const relic=crystalByPlace.get(k),hasRelic=relic&&!s.taken.has(relic.id);
      const player=x===s.pos.x&&y===s.pos.y;
      const enemy=enemies.has(k);
      const classNames=["adventure-tile",solid?"wall":(x+y+s.level)%5===0?"grass":"ground"];
      let symbol="";
      if(portal){classNames.push("portal");symbol="🌀"}
      if(hasRelic){classNames.push("relic");symbol="💎"}
      if(enemy){classNames.push("enemy");symbol="👾"}
      if(player){classNames.push("player");symbol="🧑‍🚀"}
      if(solid&& !edge)symbol="🪨";
      if(!symbol&&!solid&&(x*5+y*7+s.level)%13===0)symbol="✦";
      entries.push('<div class="'+classNames.join(" ")+'" data-x="'+x+'" data-y="'+y+
        '" role="img" aria-label="'+(player?"玩家":hasRelic?"知识水晶":enemy?"怪物":portal?"传送门":solid?"障碍":"道路")+
        '"><span>'+symbol+'</span></div>');
    }
  }
  $("adventureMap").innerHTML=entries.join("");
  updateHud(s);
}
function damage(s,message){
  if(s!==run||s.finished)return;
  const now=Date.now();
  if(now<s.invulnUntil)return;
  s.hp--;s.errors++;s.invulnUntil=now+1350;
  $("adventureWorldPanel").classList.remove("adventure-shake");
  void $("adventureWorldPanel").offsetWidth;
  $("adventureWorldPanel").classList.add("adventure-shake");
  note(message+" · 剩余 "+s.hp+" 颗心",true);
  if(s.hp<=0){
    failLevel(s);
  }else updateHud(s);
}
function updateWorld(s){
  if(s!==run||s.finished||s.question||document.hidden)return;
  s.enemyTick++;
  if(enemiesAt(s).some(p=>posKey(p)===posKey(s.pos))){
    damage(s,"碰到了巡逻的记忆影子");
  }
  renderMap(s);
}
function move(dx,dy){
  const s=run;if(!s||s.finished||s.question)return;
  const next=stepPosition(s.map,s.pos,dx,dy);
  if(next===s.pos)return;
  s.pos=next;
  if(enemiesAt(s).some(p=>posKey(p)===posKey(s.pos)))damage(s,"撞上了巡逻的影子");
  if(s.finished)return;
  const crystal=findTokenAt(s.map,next.x,next.y,s.taken);
  if(crystal){openQuestion(s,{kind:"relic",id:crystal.id});return}
  if(next.x===s.map.portal.x&&next.y===s.map.portal.y){
    if(s.taken.size!==3){
      note("传送门还没有启动：请先点亮三枚知识水晶！");
    }else openQuestion(s,{kind:"boss",id:"guardian"});
    renderMap(s);return;
  }
  renderMap(s);
}
function nextCard(s){
  if(!s.deck.length)throw Error("没有可用的知识卡");
  const card=s.deck[s.deckIndex%s.deck.length];
  s.deckIndex++;
  return card;
}
function makeQuestion(s,target){
  const card=nextCard(s),index=s.questions;
  // New gates mix recognition, spelling and audio. Boss requires typed
  // recall when possible, rather than earning progress by clicking reveal.
  let type="choice";
  if(target.kind==="boss"&&isSpellingCard(card))type="type";
  else if(target.kind==="relic"&&s.taken.size===1&&isSpellingCard(card))type="type";
  else if(target.kind==="relic"&&s.taken.size===2&&isAudioEligible(card)&&
    "speechSynthesis" in window&&typeof SpeechSynthesisUtterance!=="undefined")type="audio";
  const options=type==="choice"||type==="audio"?
    makeListeningOptions(card,cards,4):[];
  if(options.length===0&&type!=="type")throw Error("当前知识库不足以生成四个不同释义");
  return {target,card,type,options,index,answered:false,result:null,started:Date.now()};
}
function openQuestion(s,target){
  if(s!==run||s.finished||s.question)return;
  s.question=makeQuestion(s,target);
  renderMap(s);
  renderQuestion(s);
}
function playWord(s){
  const q=s.question;
  if(!q||q.type!=="audio"||!("speechSynthesis" in window))return;
  try{
    speechSynthesis.cancel();
    const item=new SpeechSynthesisUtterance(q.card.front);
    item.lang="en-US";item.rate=.9;speechSynthesis.speak(item);
  }catch{note("浏览器语音播放失败，可以选择其他挑战。",true)}
}
function renderQuestion(s){
  if(s!==run||!s.question)return;
  const q=s.question,card=q.card;
  const boss=q.target.kind==="boss";
  $("adventureQuest").classList.remove("hidden");
  $("adventureQuestTitle").textContent=boss?"🦖 守卫挑战 "+(s.bossWins+1)+"/"+s.map.bossRounds:
    "💎 知识水晶守卫";
  $("adventureQuestSubtitle").textContent=q.type==="audio"?"听发音辨认含义":
    q.type==="type"?"主动拼写才能开启机关":"回答正确，才能获得水晶";
  const prompt=$("adventureQuestionPrompt"),options=$("adventureAnswers");
  if(q.result!==null){
    prompt.textContent=q.result?"回答正确！机关已打开":"回答错误，先看看正确答案";
    options.innerHTML='<div class="adventure-correction"><strong>'+
      esc(card.front)+'</strong> — '+esc(card.back)+'</div>'+
      '<button type="button" id="adventureContinue" class="adventure-action">'+
      (s.finished?"查看结果":q.result?"继续探索 →":"知道了，继续尝试")+'</button>';
    $("adventureContinue").onclick=()=>closeQuestion(s);
    return;
  }
  if(q.type==="type"){
    prompt.textContent=card.back;
    options.innerHTML='<form id="adventureSpellForm" class="adventure-spell">'+
      '<input id="adventureSpellInput" autocomplete="off" autocapitalize="off" spellcheck="false"'+
      ' placeholder="输入对应的英文单词或短语" aria-label="输入英文">'+
      '<button type="submit" class="adventure-action">释放记忆魔法</button></form>'+
      '<button id="adventureSkipAnswer" class="adventure-skip">不会，查看正确答案</button>';
    $("adventureSpellForm").onsubmit=e=>{
      e.preventDefault();
      const value=$("adventureSpellInput").value.trim();
      if(!value)return;
      submitAnswer(s,normalizeAnswer(value)===normalizeAnswer(card.front));
    };
    $("adventureSkipAnswer").onclick=()=>submitAnswer(s,false);
    $("adventureSpellInput").focus({preventScroll:true});
  }else{
    prompt.textContent=q.type==="audio"?"🔊 听音辨义":card.front;
    options.innerHTML=(q.type==="audio"?'<button id="adventureSpeak" class="adventure-action" type="button">🔊 播放词汇发音</button>':'')+
      '<div class="adventure-answers">'+q.options.map((option,i)=>
      '<button class="adventure-answer" data-answer="'+esc(option.id)+'">'+
      '<span>'+String(i+1)+'</span>'+esc(option.label)+'</button>').join("")+'</div>';
    options.querySelectorAll("[data-answer]").forEach(btn=>
      btn.onclick=()=>submitAnswer(s,btn.dataset.answer===card.id));
    if(q.type==="audio")$("adventureSpeak").onclick=()=>playWord(s);
  }
}
function submitAnswer(s,correct){
  const q=s.question;
  if(s!==run||!q||q.answered||s.finished)return;
  q.answered=true;q.result=correct;
  s.questions++;
  const mode=q.type==="type"?"spell":q.type==="audio"?"listen":"match";
  const elapsed=Math.min(600000,Date.now()-q.started);
  s.attemptPromises.push(api("/games/attempt",{
    method:"POST",body:JSON.stringify({
      cardId:q.card.id,mode,correct,elapsedMs:elapsed
    })
  }).then(()=>true).catch(error=>{console.warn("Practice save:",error);return false}));
  if(correct){
    s.score+=100+(q.type==="type"?60:0);
    if(q.target.kind==="relic")s.taken.add(q.target.id);
    else s.bossWins++;
    note(q.target.kind==="relic"?"水晶收集成功！":"守卫受到记忆魔法攻击！");
  }else{
    damage(s,"机关回答错误");
  }
  renderMap(s);
  renderQuestion(s);
}
function closeQuestion(s){
  if(s!==run||!s.question)return;
  const q=s.question;
  s.question=null;
  $("adventureQuest").classList.add("hidden");
  if(s.finished)return;
  if(!q.result){
    // Retry requires walking into the crystal / portal again.
    if(q.target.kind==="relic"){
      s.pos={...s.map.start};
    }else{
      s.pos={x:s.map.portal.x,y:s.map.portal.y+1};
    }
  }
  if(q.result&&q.target.kind==="boss"){
    if(s.bossWins===s.map.bossRounds){finishLevel(s);return}
    openQuestion(s,{kind:"boss",id:"guardian"});
    return;
  }
  renderMap(s);
}
function failLevel(s){
  if(s!==run||s.finished)return;
  s.finished=true;clearInterval(s.timer);
  $("adventureQuest").classList.add("hidden");
  $("adventureWorldContent").classList.add("hidden");
  const panel=$("adventureEndScreen");
  panel.classList.remove("hidden");
  panel.innerHTML='<div class="adventure-result-icon">💫</div><h2>挑战失败 · 返回营地</h2>'+
    '<p>你收集了 '+s.taken.size+' / 3 枚水晶。别担心，可以重新进入这一关。</p>'+
    '<button id="adventureRetry" class="adventure-action">重新挑战第 '+s.level+' 关</button>'+
    '<button id="adventureGoCamp" class="adventure-secondary">返回关卡地图</button>';
  $("adventureRetry").onclick=()=>startLevel(s.level);
  $("adventureGoCamp").onclick=()=>{stopRun();drawCampaign()};
}
async function finishLevel(s){
  if(s!==run||s.finished)return;
  s.finished=true;clearInterval(s.timer);
  $("adventureWorldContent").classList.add("hidden");
  $("adventureQuest").classList.add("hidden");
  const stars=starsForAdventure({mistakes:s.errors,hearts:s.hp});
  const seconds=Math.max(1,Math.min(3600,Math.ceil((Date.now()-s.started)/1000)));
  const panel=$("adventureEndScreen");
  panel.classList.remove("hidden");
  panel.innerHTML='<div class="adventure-result-icon">🏆</div>'+
    '<h2>第 '+s.level+' 关通关！</h2>'+
    '<div class="adventure-stars">'+starsText(stars)+'</div>'+
    '<p>探索用时 '+seconds+' 秒 · 得分 '+s.score+' · 错误 '+s.errors+' 次</p>'+
    '<p id="adventureSyncMessage">正在保存通关记录…</p>'+
    '<div id="adventureWinActions"></div>';
  const saves=await Promise.all(s.attemptPromises);
  if(s!==run)return;
  const lost=saves.filter(ok=>!ok).length;
  try{
    await api("/adventure/complete",{
      method:"POST",body:JSON.stringify({level:s.level,stars,seconds})
    });
    if(s!==run)return;
    const p=await api("/adventure/progress");
    if(s!==run)return;
    progress=p.levels||[];highest=p.highestCompleted||0;
    $("adventureSyncMessage").textContent=lost?
      "关卡已解锁，但有 "+lost+" 条练习记录同步失败。":
      "通关记录已保存，下一关已解锁！";
    $("adventureWinActions").innerHTML='<button id="adventureNextLevel" class="adventure-action">'+
      (s.level<ADVENTURE_LEVEL_COUNT?"进入下一关 →":"重玩最终关")+'</button>'+
      '<button id="adventureBackMap" class="adventure-secondary">返回世界地图</button>';
    $("adventureNextLevel").onclick=()=>startLevel(Math.min(ADVENTURE_LEVEL_COUNT,s.level+1));
    $("adventureBackMap").onclick=()=>{stopRun();drawCampaign()};
  }catch(error){
    if(s!==run)return;
    $("adventureSyncMessage").textContent="关卡成绩保存失败："+error.message;
    $("adventureWinActions").innerHTML='<button id="adventureSaveRetry" class="adventure-action">重新保存通关记录</button>';
    $("adventureSaveRetry").onclick=()=>{s.finished=false;finishLevel(s)};
  }
}

document.addEventListener("keydown",e=>{
  const s=run;if(!s||s.finished||s.question||!$("gamesPage").classList.contains("active"))return;
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||""))return;
  const dirs={ArrowUp:[0,-1],KeyW:[0,-1],ArrowDown:[0,1],KeyS:[0,1],
    ArrowLeft:[-1,0],KeyA:[-1,0],ArrowRight:[1,0],KeyD:[1,0]};
  if(dirs[e.code]){e.preventDefault();move(...dirs[e.code])}
});
document.querySelectorAll("[data-adventure-move]").forEach(btn=>{
  btn.addEventListener("click",()=>{
    const dir=btn.dataset.adventureMove;
    move(...({up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[dir]||[0,0]));
  });
});
$("adventureBack").onclick=()=>{stopRun();drawCampaign()};
$("adventureReload").onclick=openAdventure;
document.querySelector('[data-page="gamesPage"]')?.addEventListener("click",openAdventure);
document.querySelector('[data-go="gamesPage"]')?.addEventListener("click",openAdventure);
document.querySelectorAll('.nav [data-page]').forEach(btn=>{
  if(btn.dataset.page!=="gamesPage")btn.addEventListener("click",()=>{if(run)stopRun()});
});
document.addEventListener("visibilitychange",()=>{
  const s=run;if(!s||s.finished)return;
  if(document.hidden)s.hiddenAt=Date.now();
  else if(s.hiddenAt){s.started+=Date.now()-s.hiddenAt;s.hiddenAt=0}
});
