import {
  normalizeAnswer,isSpellingCard,uniqueGameCards,makeListeningOptions,
  scoreForResult,CHALLENGES,chooseChallengeCards,challengeKind,
  comboMultiplier,secondsLeft,isAudioEligible
} from "./game-engine.js?v=challenge-v2";

const $=id=>document.getElementById(id);
const escapeText=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));
const toMs=value=>Math.min(600000,Math.max(0,Math.floor(value||0)));
const clock=value=>Math.floor(value/60)+":"+String(Math.floor(value%60)).padStart(2,"0");
let pool=[],game=null,loading=false;

async function api(path,options={}){
  const response=await fetch("/api"+path,{
    ...options,headers:{"Content-Type":"application/json",...(options.headers||{})}
  });
  let data={};
  try{data=await response.json()}catch{}
  if(!response.ok)throw Error(data.error||("请求失败 HTTP "+response.status));
  return data;
}
function notice(message="",warning=false){
  $("gameNotice").textContent=message;
  $("gameNotice").classList.toggle("game-notice-bad",warning);
}
function lobby(message="",warning=false){
  $("gameLobbyStatus").textContent=message;
  $("gameLobbyStatus").style.color=warning?"#fca5a5":"#94a3b8";
}

async function refreshStats(){
  try{
    const {overall={}}=await api("/games/stats");
    $("gameStatTotal").textContent=Number(overall.attempts||0).toLocaleString();
    $("gameStatAccuracy").textContent=Number(overall.attempts)
      ?Math.round(Number(overall.correct||0)/Number(overall.attempts)*100)+"%":"—";
    $("gameStatWeek").textContent=Number(overall.last7||0).toLocaleString();
    $("gameStatCards").textContent=Number(overall.practiced_cards||0).toLocaleString();
  }catch(err){lobby("统计暂时无法载入："+err.message,true)}
}
async function refreshPool(){
  const data=await api("/games/cards");
  pool=uniqueGameCards(data.cards||[]);
  $("gameAvailable").textContent="可用知识卡 "+pool.length+" 张（已排除暂停卡片）";
  $("gameSpellCount").textContent=pool.filter(isSpellingCard).length+" 张英文卡可练";
}
async function openGames(){
  if(loading)return;
  loading=true;
  try{
    await Promise.all([refreshPool(),refreshStats()]);
    lobby(pool.length?"挑选一种挑战。到期与薄弱知识点优先上场。":"先添加一些知识卡片，再来挑战。",!pool.length);
  }catch(err){lobby("载入游戏失败："+err.message,true)}
  finally{loading=false}
}
function stopGame(){
  if(game?.timer)clearInterval(game.timer);
  if("speechSynthesis" in window)speechSynthesis.cancel();
  game=null;
  $("gameStage").classList.add("hidden");
  $("gameModes").classList.remove("hidden");
  $("gameStage").classList.remove("game-boost","game-damage");
  notice();
}
function currentCard(s){return s.queue[s.idx]}
function currentKind(s){return challengeKind(s.mode,currentCard(s),s.idx)}
function saveAttempt(s,card,correct,elapsed){
  s.writes.push(api("/games/attempt",{
    method:"POST",body:JSON.stringify({
      cardId:card.id,mode:s.mode,correct,elapsedMs:toMs(elapsed)
    })
  }).then(()=>true).catch(err=>{console.warn("Game attempt sync error",err);return false}));
}

async function startGame(mode){
  if(!CHALLENGES[mode]||loading)return;
  loading=true;
  lobby();
  try{
    await refreshPool();
    if(mode==="listen"&&(!("speechSynthesis" in window)||typeof SpeechSynthesisUtterance==="undefined")){
      lobby("当前浏览器没有语音朗读功能。请换一个浏览器，或先玩其他挑战。",true);return;
    }
    const candidates=mode==="spell"?pool.filter(isSpellingCard)
      :mode==="listen"?pool.filter(isAudioEligible):pool;
    const minimum=["match","listen"].includes(mode)?4:1;
    if(candidates.length<minimum||pool.length<(mode==="listen"?4:minimum)){
      lobby("可用卡片不足。限时选择题需要至少 4 张不同释义的卡片；拼写挑战需要英文词汇卡。",true);
      return;
    }
    stopGame();
    const cfg=CHALLENGES[mode];
    const queue=chooseChallengeCards(candidates,cfg.count);
    const now=Date.now();
    game={
      mode,cfg,queue,targets:new Set(queue.map(c=>c.id)),idx:0,
      started:now,roundStarted:now,globalDeadline:cfg.limit?now+cfg.limit*1000:0,
      roundDeadline:mode==="listen"?0:cfg.round?now+cfg.round*1000:0,
      lives:cfg.lives,score:0,streak:0,bestStreak:0,correct:0,mistakes:0,
      mastered:new Set(),weak:new Map(),recovered:new Set(),retried:new Set(),
      attempts:0,writes:[],options:[],kind:null,answered:false,reviewing:false,
      feedback:null,typed:"",hintUsed:false,skipRecall:false,pausedAt:0,
      timer:null,finished:false,busy:false,finishReason:"",roundToken:0
    };
    const s=game;
    $("gameStageTitle").textContent=cfg.title;
    $("gameStage").dataset.mode=mode;
    $("gameStage").classList.remove("hidden");
    $("gameModes").classList.add("hidden");
    $("gameBossPanel").classList.toggle("hidden",mode!=="recall");
    $("gameLivesWrap").classList.toggle("hidden",mode==="recall");
    $("gameRoundTimerWrap").classList.toggle("hidden",mode==="recall");
    s.timer=setInterval(()=>tick(s),100);
    renderQuestion(s);
    $("gameStage").scrollIntoView({behavior:"smooth",block:"start"});
  }catch(err){lobby("挑战启动失败："+err.message,true);if(game)stopGame()}
  finally{loading=false}
}

function secondsForHud(s){
  const now=s.answered&&s.pausedAt?s.pausedAt:Date.now();
  return s.globalDeadline?secondsLeft(s.globalDeadline,now):
    Math.floor(Math.max(0,now-s.started)/1000);
}
function updateHud(s){
  if(s!==game)return;
  $("gameScore").textContent=s.score.toLocaleString();
  $("gameClock").textContent=clock(secondsForHud(s));
  $("gameClockLabel").textContent=s.globalDeadline?"剩余时间":"本局用时";
  $("gameCombo").textContent=s.streak+" 连击 · ×"+comboMultiplier(s.streak);
  $("gameStep").textContent=Math.min(s.idx,s.queue.length)+" / "+s.queue.length;
  $("gameBar").style.width=s.queue.length?Math.min(100,Math.round(s.idx/s.queue.length*100))+"%":"0%";
  $("gameLives").textContent="❤".repeat(Math.max(0,s.lives))+"♡".repeat(Math.max(0,s.cfg.lives-s.lives));
  if(s.mode==="recall"){
    const remaining=Math.max(0,s.targets.size-s.mastered.size);
    $("gameBossBar").style.width=s.targets.size?Math.round(remaining/s.targets.size*100)+"%":"0%";
    $("gameBossText").textContent=remaining+" 道护盾未突破";
  }
  const round=s.roundDeadline?(s.answered&&s.pausedAt?s.pausedAt:Date.now()):0;
  $("gameRoundTimer").textContent=s.roundDeadline?secondsLeft(s.roundDeadline,round)+"s":"—";
  const percentage=s.roundDeadline&&s.cfg.round
    ?Math.max(0,Math.min(100,(s.roundDeadline-round)/(s.cfg.round*1000)*100)):0;
  $("gameRoundBar").style.width=percentage+"%";
  $("gameStage").classList.toggle("game-urgent",!!s.roundDeadline&&!s.answered&&
    secondsLeft(s.roundDeadline,Date.now())<=5);
}
function tick(s){
  if(s!==game||s.finished)return;
  if(!s.answered&&!s.busy&&!document.hidden){
    if(s.globalDeadline&&Date.now()>=s.globalDeadline){
      finishGame(s,"60 秒倒计时结束");return;
    }
    if(s.roundDeadline&&Date.now()>=s.roundDeadline){
      answerCurrent(s,false,{timeout:true});return;
    }
  }
  updateHud(s);
}
function markEffect(s,correct){
  if(s!==game)return;
  const stage=$("gameStage"),name=correct?"game-boost":"game-damage";
  stage.classList.remove("game-boost","game-damage");
  // Reflow restarts feedback animation; no animation is needed for gameplay.
  void stage.offsetWidth;
  stage.classList.add(name);
}

function speakCard(card,s){
  if(!("speechSynthesis" in window)||typeof SpeechSynthesisUtterance==="undefined"){
    notice("此浏览器暂不支持语音。",true);return;
  }
  try{
    speechSynthesis.cancel();
    const utterance=new SpeechSynthesisUtterance(card.front);
    utterance.lang=isAudioEligible(card)?"en-US":"zh-CN";
    utterance.rate=.9;
    speechSynthesis.speak(utterance);
    if(s.mode==="listen"&&!s.roundDeadline){
      const now=Date.now();
      s.roundStarted=now;
      s.roundDeadline=now+s.cfg.round*1000;
      s.heard=true;
      renderQuestion(s);
    }
  }catch(e){notice("语音播放失败："+e.message,true)}
}
function choiceButtons(s,card){
  if(!s.options.length)s.options=makeListeningOptions(card,pool);
  return '<div class="game-options">'+s.options.map((option,i)=>
    '<button type="button" class="game-choice'+
    (s.answered&&option.id===card.id?' game-correct-choice':'')+
    '" data-game-choice="'+escapeText(option.id)+'" '+((s.answered||s.mode==="listen"&&!s.heard)?'disabled':'')+'>'+
    '<kbd>'+String(i+1)+'</kbd><span>'+escapeText(option.label)+'</span></button>'
  ).join("")+'</div>';
}

function renderQuestion(s){
  if(s!==game||s.finished)return;
  if(s.idx>=s.queue.length){finishGame(s,"挑战结束");return}
  const card=currentCard(s);
  if(!card){finishGame(s,"已完成全部卡片");return}
  const kind=currentKind(s);
  s.kind=kind;
  $("gameChallengeType").textContent=kind==="type"?"ACTIVE RECALL / 主动拼写":
    kind==="audio"?"LISTENING / 听力反应":
    kind==="recall"?"BOSS BATTLE / 主动回忆":"SPEED ROUND / 极速判断";
  const timeNotice=s.mode==="listen"&&!s.heard?"点击播放后才开始本题倒计时。":
    s.mode==="match"?"60 秒内生存下来；每第三题可能需要真正拼写。":
    s.mode==="recall"?"先写出你的理解，再揭晓答案并自评。":"本题限时 "+s.cfg.round+" 秒，正确才会累积连击。";
  let face="",actions="";
  if(kind==="audio"){
    face='<p class="game-eyebrow">不要看单词，听到什么？</p>'+
      '<h2 class="game-question-mark">?</h2>'+
      '<button type="button" id="gameSpeak" class="game-primary">🔊 '+(s.heard?"再次收听":"开始播放")+'</button>'+
      (s.answered?'<p class="game-key">原词：'+escapeText(card.front)+'</p>':'');
    actions=choiceButtons(s,card);
  }else if(kind==="choice"){
    face='<p class="game-eyebrow">选出正确释义</p><h2>'+escapeText(card.front)+'</h2>';
    actions=choiceButtons(s,card);
  }else if(kind==="type"){
    const prompt=s.mode==="match"?"⚡ 生存战：这关必须拼出来":"根据提示，输入正确英文";
    face='<p class="game-eyebrow">'+prompt+'</p><h2>'+escapeText(card.back)+'</h2>'+
      (s.hintUsed?'<p class="game-hint">首字母：'+escapeText(card.front[0])+'</p>':'');
    actions='<form id="gameWriteForm" class="game-entry">'+
      '<input id="gameWriteInput" type="text" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"'+
      ' placeholder="输入英文单词 / 短语" aria-label="拼写回答" '+(s.answered?'disabled':'')+'>'+
      (!s.answered?'<button class="game-primary" type="submit">确认答案 ↵</button>':'')+'</form>'+
      (!s.answered?'<div class="game-support">'+
      '<button id="gameHintBtn" type="button" '+(s.hintUsed?'disabled':'')+'>💡 首字母提示</button>'+
      '<button id="gameGiveUp" type="button">不会，揭晓</button></div>':'');
  }else{
    face='<p class="game-eyebrow">第 '+(s.idx+1)+' 回合 · 用自己的话解释</p>'+
      '<h2>'+escapeText(card.front)+'</h2>';
    if(!s.reviewing){
      actions='<textarea id="gameRecallDraft" rows="3" placeholder="不看答案，写下你能回忆的关键内容……"></textarea>'+
        '<div class="game-support"><button id="gameReveal" type="button" class="game-primary">核对答案 →</button>'+
        '<button id="gameCannotRecall" type="button">忘记了，直接揭晓</button></div>';
    }else{
      actions='<div class="game-reveal">'+
        '<small>知识卡正确答案</small><div class="game-reveal-answer">'+escapeText(card.back)+'</div>'+
        (card.example?'<p>'+escapeText(card.example)+'</p>':'')+
        '<small>你刚才的回忆</small><div>'+escapeText(s.typed||"（未能回忆）")+'</div></div>'+
        '<p class="game-self-note">请对照答案判断是否表达了关键意思，不需要逐字一致。</p>'+
        '<div class="game-self-actions">'+
        '<button data-game-self="yes" '+(s.skipRecall?'disabled':'')+'>✓ 讲清楚了</button>'+
        '<button data-game-self="no">↺ 有遗漏 / 不会</button></div>';
    }
  }
  if(s.answered){
    actions='<div class="game-result-box '+(s.feedback?.correct?'is-correct':'is-wrong')+'">'+
      '<strong>'+(s.feedback?.correct?"✓ 回忆成功":"↺ 需要巩固")+'</strong>'+
      '<p>'+escapeText(card.front)+' — '+escapeText(card.back)+'</p>'+
      (s.feedback?.timeout?'<small>本题超时</small>':'')+
      '</div><button id="gameNext" type="button" class="game-primary">下一关 →</button>';
  }else{
    actions+='<button id="gamePauseCard" type="button" class="game-snooze">⏳ 这张卡 7 天不出现</button>';
  }

  $("gameBoard").innerHTML='<div class="game-arena">'+
    '<div class="game-round-note">'+escapeText(timeNotice)+'</div>'+
    '<div class="game-arena-face">'+face+'</div>'+
    '<div class="game-arena-actions">'+actions+'</div></div>';

  $("gameSpeak")?.addEventListener("click",()=>speakCard(card,s));
  $("gameBoard").querySelectorAll("[data-game-choice]").forEach(btn=>
    btn.addEventListener("click",()=>answerCurrent(s,btn.dataset.gameChoice===card.id)));
  $("gameWriteForm")?.addEventListener("submit",e=>{
    e.preventDefault();
    const value=$("gameWriteInput")?.value.trim()||"";
    if(!value){notice("先输入拼写，再提交。",true);return}
    answerCurrent(s,normalizeAnswer(value)===normalizeAnswer(card.front),{typed:value});
  });
  $("gameHintBtn")?.addEventListener("click",()=>{
    s.hintUsed=true;
    const previous=$("gameWriteInput")?.value||"";
    renderQuestion(s);
    if($("gameWriteInput"))$("gameWriteInput").value=previous;
  });
  $("gameGiveUp")?.addEventListener("click",()=>answerCurrent(s,false,{gaveUp:true}));
  $("gameReveal")?.addEventListener("click",()=>revealBoss(s,false));
  $("gameCannotRecall")?.addEventListener("click",()=>revealBoss(s,true));
  $("gameBoard").querySelectorAll("[data-game-self]").forEach(btn=>
    btn.addEventListener("click",()=>answerCurrent(s,btn.dataset.gameSelf==="yes")));
  $("gamePauseCard")?.addEventListener("click",()=>pauseCurrentCard(s));
  $("gameNext")?.addEventListener("click",()=>advanceGame(s));
  if(kind==="type"&&!s.answered)$("gameWriteInput")?.focus({preventScroll:true});
  updateHud(s);
}
function revealBoss(s,skipped){
  if(s!==game||s.answered||s.reviewing||s.busy)return;
  const draft=$("gameRecallDraft")?.value.trim()||"";
  if(!skipped&&!draft){notice("先写下你记得的内容；如果完全不会，点击「忘记了」。",true);return}
  s.typed=draft;s.skipRecall=skipped;s.reviewing=true;
  renderQuestion(s);
}

function answerCurrent(s,correct,detail={}){
  if(s!==game||s.finished||s.answered||s.busy)return;
  const card=currentCard(s);
  if(!card)return;
  s.answered=true;
  s.pausedAt=Date.now();
  s.feedback={correct,timeout:detail.timeout||false};
  s.attempts++;
  if(correct){
    s.correct++;s.streak++;
    s.bestStreak=Math.max(s.bestStreak,s.streak);
    s.score+=scoreForResult(s.mode,true,s.pausedAt-s.roundStarted,s.hintUsed)
      *comboMultiplier(s.streak);
    if(s.mode==="recall")s.mastered.add(card.id);
    if(s.weak.has(card.id)){s.weak.delete(card.id);s.recovered.add(card.id)}
    notice("✓ 连击 "+s.streak+"，倍率 ×"+comboMultiplier(s.streak));
  }else{
    s.mistakes++;s.streak=0;s.weak.set(card.id,card);
    if(s.cfg.lives)s.lives=Math.max(0,s.lives-1);
    if(!s.retried.has(card.id)){
      s.retried.add(card.id);
      s.queue.push(card); // Re-encounter once after other cards, not an endless loop
    }
    notice(detail.timeout?"本题超时。正确答案已显示，后续会再练习一次。":
      "本题没答对。正确答案在下方，本局稍后再练一次。",true);
  }
  saveAttempt(s,card,correct,s.pausedAt-s.roundStarted);
  markEffect(s,correct);
  if(s.cfg.lives&&s.lives<=0){
    finishGame(s,"本次挑战结束 · 生命值归零");return;
  }
  renderQuestion(s);
}
function advanceGame(s){
  if(s!==game||s.finished||!s.answered)return;
  if(s.globalDeadline&&s.pausedAt)s.globalDeadline+=Date.now()-s.pausedAt;
  s.idx++;
  s.options=[];s.feedback=null;s.answered=false;s.reviewing=false;
  s.hintUsed=false;s.skipRecall=false;s.typed="";s.heard=false;
  s.roundStarted=Date.now();s.pausedAt=0;
  s.roundDeadline=s.mode==="listen"?0:s.cfg.round?Date.now()+s.cfg.round*1000:0;
  notice();
  renderQuestion(s);
}
async function pauseCurrentCard(s){
  if(s!==game||s.answered||s.busy)return;
  s.busy=true;
  const card=currentCard(s);
  try{
    await api("/cards/"+encodeURIComponent(card.id)+"/snooze",{
      method:"POST",body:JSON.stringify({days:7})
    });
    if(s!==game)return;
    pool=pool.filter(x=>x.id!==card.id);
    const past=s.queue.slice(0,s.idx).filter(c=>c.id!==card.id);
    const next=s.queue.slice(s.idx).filter(c=>c.id!==card.id);
    s.idx=past.length;s.queue=past.concat(next);
    s.targets.delete(card.id);
    s.options=[];s.feedback=null;s.answered=false;s.reviewing=false;
    s.hintUsed=false;s.skipRecall=false;s.heard=false;s.typed="";
    s.roundStarted=Date.now();s.roundDeadline=s.mode==="listen"?0:s.cfg.round?Date.now()+s.cfg.round*1000:0;
    $("gameAvailable").textContent="可用知识卡 "+pool.length+" 张（已排除暂停卡片）";
    notice("已暂停 7 天，从当前挑战中移除。");
    renderQuestion(s);
  }catch(err){notice("暂停失败："+err.message,true)}
  finally{s.busy=false}
}
async function finishGame(s,reason){
  if(s!==game||s.finished)return;
  s.finished=true;s.finishReason=reason;
  clearInterval(s.timer);
  if("speechSynthesis" in window)speechSynthesis.cancel();
  $("gameStage").classList.remove("game-urgent");
  updateHud(s);
  const wonBoss=s.mode==="recall"&&s.mastered.size===s.targets.size;
  const incomplete=[...s.weak.values()];
  const canRetry=s.mode==="recall"&&s.targets.size>0;
  const title=s.mode==="recall"?(wonBoss?"🏆 Boss 护盾已突破":"🛡️ Boss 尚有知识缺口"):
    reason==="挑战结束"?"🏁 挑战通关":"⚡ 本局结束";
  $("gameBoard").innerHTML='<div class="game-finish">'+
    '<div class="game-finish-symbol">'+(wonBoss?"🏆":"⚡")+'</div>'+
    '<h2>'+title+'</h2><p>'+escapeText(reason||"已完成挑战")+' · '+escapeText(s.cfg.title)+'</p>'+
    '<div class="game-results"><div><strong>'+s.score+'</strong><span>闯关得分</span></div>'+
    '<div><strong>'+s.bestStreak+'</strong><span>最高连击</span></div>'+
    '<div><strong>'+s.attempts+'</strong><span>主动练习次数</span></div></div>'+
    '<div class="game-weak-panel"><b>本局需要加强的知识点</b>'+
    (incomplete.length?'<div class="game-weak-chips">'+
      incomplete.slice(0,10).map(c=>'<span>'+escapeText(c.front)+'</span>').join("")+
      '</div>':'<p>这局没有未解决的知识点。继续挑战时会优先练习其他薄弱内容。</p>')+
    (s.recovered.size?'<p>本局重新记住了 '+s.recovered.size+' 个之前答错的知识点。</p>':'')+'</div>'+
    '<div class="game-finish-actions"><button id="gameAgain" class="game-primary" type="button">'+
    (canRetry?"再挑战 Boss":"再来一局")+'</button>'+
    '<button id="gameChoose" class="ghost" type="button">换个挑战</button></div>'+
    '<p id="gameSyncText" class="muted">正在同步训练记录…</p></div>';
  $("gameAgain").onclick=()=>startGame(s.mode);
  $("gameChoose").onclick=stopGame;
  notice();
  const records=await Promise.all(s.writes);
  if(game===s){
    const bad=records.filter(v=>!v).length;
    $("gameSyncText").textContent=bad?bad+" 条记录同步失败，请检查网络。":
      s.attempts?"已同步 "+s.attempts+" 次练习；答错内容在下次游戏中会提高优先级。":"本轮没有产生练习记录。";
    refreshStats();
  }
}

// Keyboard 1–4 for choices; Space to replay audio. Never capture typing.
window.addEventListener("keydown",event=>{
  const s=game;
  if(!s||s.finished||s.answered||s.busy||!$("gamesPage").classList.contains("active"))return;
  if(event.ctrlKey||event.metaKey||event.altKey||/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||""))return;
  if(/^[1-4]$/.test(event.key)){
    const option=$("gameBoard").querySelectorAll("[data-game-choice]")[Number(event.key)-1];
    if(option&&!option.disabled){event.preventDefault();option.click()}
  }else if(event.code==="Space"&&s.mode==="listen"){
    event.preventDefault();$("gameSpeak")?.click();
  }
});

// When the phone is put away mid-game, freeze countdowns instead of
// charging the learner for an interruption.
let hiddenAt=0;
document.addEventListener("visibilitychange",()=>{
  const s=game;
  if(!s||s.finished)return;
  if(document.hidden){hiddenAt=Date.now();return}
  if(hiddenAt){
    const delay=Date.now()-hiddenAt;
    if(s.globalDeadline)s.globalDeadline+=delay;
    if(s.roundDeadline)s.roundDeadline+=delay;
    if(s.pausedAt)s.pausedAt+=delay;
    hiddenAt=0;
  }
});

$("gameExit").addEventListener("click",stopGame);
document.querySelectorAll("[data-game-mode]").forEach(btn=>
  btn.addEventListener("click",()=>startGame(btn.dataset.gameMode)));
document.querySelector('[data-page="gamesPage"]')?.addEventListener("click",openGames);
document.querySelector('[data-go="gamesPage"]')?.addEventListener("click",openGames);
