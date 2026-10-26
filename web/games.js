import {normalizeAnswer,isSpellingCard,shuffle,uniqueGameCards,makeListeningOptions,scoreForResult} from "./game-engine.js?v=1";

const $=id=>document.getElementById(id);
const names={match:"词义配对",listen:"听音辨义",spell:"拼写挑战",recall:"回忆闯关"};
let pool=[],game=null,loading=false;
const escapeText=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));
const asMs=ms=>Math.min(600000,Math.max(0,Math.floor(ms||0)));
const timeText=ms=>Math.floor(ms/60000)+":"+String(Math.floor(ms/1000)%60).padStart(2,"0");

async function api(path,options={}){
  const response=await fetch("/api"+path,{
    ...options,headers:{"Content-Type":"application/json",...(options.headers||{})}
  });
  let data={};
  try{data=await response.json()}catch{}
  if(!response.ok)throw Error(data.error||("请求失败 HTTP "+response.status));
  return data;
}

function lobbyStatus(message,bad=false){
  const el=$("gameLobbyStatus");
  el.textContent=message||"";
  el.style.color=bad?"#b45309":"#64748b";
}
function notify(message,bad=false){
  const el=$("gameNotice");
  el.textContent=message||"";
  el.classList.toggle("game-notice-bad",Boolean(bad));
}

async function refreshStats(){
  try{
    const data=await api("/games/stats");
    const all=data.overall||{};
    $("gameStatTotal").textContent=Number(all.attempts||0).toLocaleString();
    const n=Number(all.attempts||0);
    $("gameStatAccuracy").textContent=n?Math.round(Number(all.correct||0)/n*100)+"%":"—";
    $("gameStatWeek").textContent=Number(all.last7||0).toLocaleString();
    $("gameStatCards").textContent=Number(all.practiced_cards||0).toLocaleString();
  }catch(err){notify("游戏统计暂时无法加载："+err.message,true)}
}
async function refreshPool(){
  const data=await api("/games/cards");
  pool=uniqueGameCards(data.cards||[]);
  $("gameAvailable").textContent="知识库中有 "+pool.length+" 张适合游戏的卡片（已排除近期不出现）";
  $("gameSpellCount").textContent=pool.filter(isSpellingCard).length+" 张可练";
}
async function openGames(){
  if(loading)return;
  loading=true;
  try{await Promise.all([refreshPool(),refreshStats()])}
  catch(err){lobbyStatus("载入卡片失败："+err.message,true)}
  finally{loading=false}
}

function stopGame(){
  if(game?.timer)clearInterval(game.timer);
  if(typeof speechSynthesis!=="undefined")speechSynthesis.cancel();
  game=null;
  $("gameStage").classList.add("hidden");
  $("gameModes").classList.remove("hidden");
  $("gameNotice").textContent="";
}

async function startGame(mode){
  if(!names[mode]||loading)return;
  loading=true;
  notify("");
  lobbyStatus("");
  try{
    await refreshPool();
    if(mode==="listen" && (!("speechSynthesis" in window)||typeof SpeechSynthesisUtterance==="undefined")){
      lobbyStatus("当前浏览器没有系统语音能力，可以使用其他三个游戏。",true);
      return;
    }
    const available=mode==="spell"?pool.filter(isSpellingCard):pool;
    if(available.length<(mode==="match"||mode==="listen"?4:1)){
      lobbyStatus(mode==="spell"?"还没有可用于拼写的英文词汇卡片。":"至少需要 4 张正反面不同的卡片才能开始这个游戏。",true);
      return;
    }
    stopGame();
    const chosen=shuffle(available.slice(0,Math.min(35,available.length))).slice(0,mode==="match"?6:10);
    game={
      mode,queue:chosen,idx:0,matched:new Set(),errors:new Set(),
      first:null,options:[],answered:false,feedback:null,hintUsed:false,
      score:0,correct:0,mistakes:0,attempts:0,started:Date.now(),
      cardStarted:Date.now(),retry:new Set(),writes:[],timer:null,finished:false
    };
    $("gameStageTitle").textContent=names[mode];
    $("gameModes").classList.add("hidden");
    $("gameStage").classList.remove("hidden");
    game.timer=setInterval(updateHud,1000);
    if(mode==="match")renderMatch();
    else renderQuestion();
    updateHud();
    $("gameStage").scrollIntoView({behavior:"smooth",block:"start"});
  }catch(err){lobbyStatus("开始游戏失败："+err.message,true);notify("开始游戏失败："+err.message,true)}
  finally{loading=false}
}

function updateHud(){
  if(!game)return;
  $("gameScore").textContent=game.score;
  $("gameClock").textContent=timeText(Date.now()-game.started);
  $("gameCombo").textContent=game.correct;
  const done=game.mode==="match"?game.matched.size:game.idx;
  const total=game.queue.length;
  $("gameStep").textContent=done+" / "+total;
  $("gameBar").style.width=total?Math.round(done/total*100)+"%":"0%";
}

function saveAttempt(card,correct,elapsed){
  const request=api("/games/attempt",{
    method:"POST",
    body:JSON.stringify({
      cardId:card.id,mode:game.mode,correct,elapsedMs:asMs(elapsed)
    })
  }).then(()=>true).catch(err=>{console.warn("Game progress sync failed",err);return false});
  game.writes.push(request);
}

function buildMatchSide(side){
  const s=game;
  return s.tiles.filter(x=>x.side===side).map(tile=>{
    const done=s.matched.has(tile.id),active=s.first?.id===tile.id&&s.first.side===side;
    const classes="game-tile"+(done?" game-tile-done":"")+(active?" game-tile-selected":"");
    return '<button type="button" class="'+classes+'" data-game-id="'+escapeText(tile.id)+'" data-game-side="'+side+'" '+(done?'disabled':'')+'>'+escapeText(tile.label)+'</button>';
  }).join("");
}

function renderMatch(){
  const s=game;
  if(!s.tiles){
    s.tiles=shuffle(s.queue.map(c=>({id:c.id,label:c.front,side:"front"}))).concat(
      shuffle(s.queue.map(c=>({id:c.id,label:c.back,side:"back"}))));
    notify("先点左侧知识点，再点右侧含义。错配的卡片会被重点记住。");
  }
  $("gameBoard").innerHTML=
    '<p class="game-instruction">将卡片正面与对应含义配成一对</p>'+
    '<div class="game-match-columns"><div class="game-match-column">'+buildMatchSide("front")+
    '</div><div class="game-match-column">'+buildMatchSide("back")+'</div></div>';
  $("gameBoard").querySelectorAll("[data-game-id]").forEach(btn=>btn.onclick=()=>chooseMatch(btn.dataset.gameId,btn.dataset.gameSide));
  updateHud();
}

function chooseMatch(id,side){
  const s=game;
  if(!s||s.finished||s.mode!=="match"||s.matched.has(id))return;
  if(!s.first||s.first.side===side){
    s.first={id,side};renderMatch();return;
  }
  const front=side==="front"?{id,side}:s.first;
  const back=side==="back"?{id,side}:s.first;
  s.first=null;
  if(front.id!==back.id){
    s.errors.add(front.id);
    s.mistakes++;
    notify("暂时没配对成功，再试一次。",true);
    renderMatch();
    return;
  }
  const card=s.queue.find(c=>c.id===id);
  const firstTry=!s.errors.has(id);
  s.matched.add(id);
  s.attempts++;
  if(firstTry)s.correct++;
  s.score+=scoreForResult("match",firstTry,Date.now()-s.started);
  saveAttempt(card,firstTry,Date.now()-s.started);
  notify(firstTry?"配对成功！":"配对成功，这张卡片下次会更优先练习。");
  if(s.matched.size===s.queue.length)finishGame();
  else renderMatch();
}

function speakCard(text){
  if(!("speechSynthesis" in window)||typeof SpeechSynthesisUtterance==="undefined"){
    notify("当前浏览器不支持系统语音，可切换到其他游戏。",true);return;
  }
  speechSynthesis.cancel();
  const voice=new SpeechSynthesisUtterance(text);
  voice.lang=/[\u3400-\u9fff]/.test(text)?"zh-CN":"en-US";
  voice.rate=.92;
  speechSynthesis.speak(voice);
}

function renderQuestion(){
  const s=game;
  if(!s||s.finished)return;
  if(s.idx>=s.queue.length){finishGame();return}
  const c=s.queue[s.idx];
  const answered=s.answered;
  const result=s.feedback;
  let main="",controls="";
  if(s.mode==="listen"){
    if(!s.options.length)s.options=makeListeningOptions(c,pool);
    main='<div class="game-prompt"><small>听音辨义 · 不先显示文字</small><h2>听发音，选择正确含义</h2>'+
      '<button type="button" id="gameSpeak" class="btn dark">🔊 播放发音</button>'+
      (answered?'<div class="game-answer">'+escapeText(c.front)+' · '+escapeText(c.back)+'</div>':'')+'</div>';
    controls='<div class="game-options">'+s.options.map(option=>
      '<button type="button" class="game-choice" data-choice-id="'+escapeText(option.id)+'" '+(answered?'disabled':'')+'>'+
      escapeText(option.label)+'</button>').join("")+'</div>';
  }else if(s.mode==="spell"){
    main='<div class="game-prompt"><small>拼写挑战 · 根据释义回忆英文</small><h2>'+escapeText(c.back)+'</h2>'+
      (s.hintUsed?'<div class="game-hint">首字母：'+escapeText(c.front.slice(0,1))+'</div>':'')+'</div>';
    controls=answered?'':'<form id="gameSpellForm" class="game-spell-form">'+
      '<input id="gameSpellInput" aria-label="输入英文单词或短语" placeholder="输入英文单词或短语" autocomplete="off" autocapitalize="off" spellcheck="false">'+
      '<button class="btn dark" type="submit">提交拼写</button></form>'+
      '<button id="gameHintBtn" type="button" class="ghost" '+(s.hintUsed?'disabled':'')+'>💡 提示首字母（少得分）</button>'+
      '<button id="gameDontKnow" type="button" class="ghost">显示答案</button>';
  }else{
    main='<div class="game-prompt"><small>回忆闯关 · 先在脑中回答</small><h2>'+escapeText(c.front)+'</h2>'+
      (s.answerRevealed?'<div class="game-answer">'+escapeText(c.back)+(c.example?'<div class="muted">'+escapeText(c.example)+'</div>':'')+'</div>':'')+'</div>';
    controls=s.answerRevealed?
      '<div class="game-recall-actions"><button type="button" data-game-recall="good" class="btn dark">✓ 记住了</button>'+
      '<button type="button" data-game-recall="hard" class="ghost">≈ 模糊</button>'+
      '<button type="button" data-game-recall="again" class="ghost">↺ 忘了</button></div>':
      '<button id="gameFlip" type="button" class="btn dark">翻开答案</button>';
  }
  if(answered&&s.mode!=="recall"){
    controls+='<div class="game-feedback '+(result?.correct?'game-feedback-ok':'game-feedback-retry')+'">'+
      (result?.correct?'✅ 回答正确':'🔄 还需要巩固')+
      '<div>正确答案：'+escapeText(c.front)+' — '+escapeText(c.back)+'</div></div>'+
      '<button id="gameNext" type="button" class="btn dark">下一张 →</button>';
  }
  if(!answered){
    controls+='<button id="gamePauseCard" type="button" class="ghost game-pause">⏳ 此卡片7天不出现</button>';
  }
  $("gameBoard").innerHTML='<div class="game-question">'+main+'<div class="game-answer-area">'+controls+'</div></div>';
  $("gameSpeak")?.addEventListener("click",()=>speakCard(c.front));
  $("gameBoard").querySelectorAll("[data-choice-id]").forEach(btn=>btn.addEventListener("click",()=>answerCurrent(btn.dataset.choiceId===c.id)));
  $("gameSpellForm")?.addEventListener("submit",ev=>{ev.preventDefault();const typed=$("gameSpellInput").value; if(!typed.trim()){notify("先输入你的拼写。",true);return}answerCurrent(normalizeAnswer(typed)===normalizeAnswer(c.front))});
  $("gameHintBtn")?.addEventListener("click",()=>{s.hintUsed=true;renderQuestion()});
  $("gameDontKnow")?.addEventListener("click",()=>answerCurrent(false));
  $("gameFlip")?.addEventListener("click",()=>{s.answerRevealed=true;renderQuestion()});
  $("gameBoard").querySelectorAll("[data-game-recall]").forEach(btn=>btn.addEventListener("click",()=>answerCurrent(btn.dataset.gameRecall==="good")));
  $("gamePauseCard")?.addEventListener("click",pauseCurrentCard);
  $("gameNext")?.addEventListener("click",advanceGame);
  if(s.mode==="spell"&&!answered&&!s.hintUsed)$("gameSpellInput")?.focus({preventScroll:true});
  updateHud();
}

function answerCurrent(correct){
  const s=game;
  if(!s||s.finished||s.answered)return;
  const card=s.queue[s.idx];
  s.answered=true;
  s.feedback={correct};
  s.attempts++;
  if(correct)s.correct++;else s.mistakes++;
  s.score+=scoreForResult(s.mode,correct,Date.now()-s.cardStarted,s.hintUsed);
  saveAttempt(card,correct,Date.now()-s.cardStarted);
  // One more encounter with an incorrect card, not an endless loop.
  if(!correct&&!s.retry.has(card.id)){
    s.retry.add(card.id);s.queue.push(card);
  }
  if(s.mode==="recall"){advanceGame();return}
  notify(correct?"回答正确，继续保持！":"这张卡片会在本局末尾再出现一次。",!correct);
  renderQuestion();
}

function advanceGame(){
  if(!game||game.finished)return;
  game.idx++;
  game.options=[];
  game.answered=false;
  game.feedback=null;
  game.hintUsed=false;
  game.answerRevealed=false;
  game.cardStarted=Date.now();
  notify("");
  renderQuestion();
}

async function pauseCurrentCard(){
  const s=game;
  if(!s||s.finished||s.answered||s.busy)return;
  s.busy=true;
  const c=s.queue[s.idx];
  try{
    await api("/cards/"+encodeURIComponent(c.id)+"/snooze",{method:"POST",body:JSON.stringify({days:7})});
    pool=pool.filter(x=>x.id!==c.id);
    s.queue=s.queue.filter(x=>x.id!==c.id);
    s.options=[];s.answered=false;s.feedback=null;s.hintUsed=false;s.answerRevealed=false;
    s.cardStarted=Date.now();
    notify("已暂停7天，并从当前游戏队列中移除。");
    renderQuestion();
    $("gameAvailable").textContent="知识库中有 "+pool.length+" 张适合游戏的卡片（已排除近期不出现）";
    lobbyStatus(pool.length?"选择一个游戏开始吧。":"暂时没有适合的卡片。请先从知识库中添加正反面知识卡片。",!pool.length);
  }catch(err){notify("暂停失败："+err.message,true)}
  finally{s.busy=false}
}

async function finishGame(){
  const s=game;
  if(!s||s.finished)return;
  s.finished=true;
  clearInterval(s.timer);
  if(typeof speechSynthesis!=="undefined")speechSynthesis.cancel();
  updateHud();
  const played=s.attempts;
  $("gameBoard").innerHTML=
    '<div class="game-finish"><div class="game-finish-symbol">🏆</div>'+
    '<h2>本局完成</h2><p>真正重要的是记住了什么，而不是获得多少分。</p>'+
    '<div class="game-results"><div><strong>'+s.score+'</strong><span>本局积分</span></div>'+
    '<div><strong>'+s.correct+'</strong><span>成功回忆</span></div>'+
    '<div><strong>'+s.mistakes+'</strong><span>需巩固</span></div></div>'+
    '<div class="game-finish-actions"><button id="gameAgain" type="button" class="btn dark">再来一局</button>'+
    '<button id="gameChoose" type="button" class="ghost">换个游戏</button></div>'+
    '<p id="gameSyncText" class="muted">正在保存游戏学习记录…</p></div>';
  $("gameAgain").onclick=()=>startGame(s.mode);
  $("gameChoose").onclick=stopGame;
  const writes=await Promise.all(s.writes);
  const failed=writes.filter(x=>!x).length;
  if(game===s)$("gameSyncText").textContent=failed?failed+" 条训练记录保存失败；可以检查网络。":
    played?("已保存 "+played+" 次训练记录；错题会在下次优先出现。"):"本局跳过了全部卡片，未产生训练记录。";
  refreshStats().catch(()=>{});
}

$("gameExit").addEventListener("click",stopGame);
document.querySelectorAll("[data-game-mode]").forEach(btn=>btn.addEventListener("click",()=>startGame(btn.dataset.gameMode)));
document.querySelector('[data-page="gamesPage"]')?.addEventListener("click",openGames);
document.querySelector('[data-go="gamesPage"]')?.addEventListener("click",openGames);
