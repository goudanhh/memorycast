const $=id=>document.getElementById(id);
let currentImportedNoteId=null,voiceRecorder=null,voiceChunks=[],voiceRecording=false,voicePreviewUrl=null;
let me=null,aiEnabled=false,cards=[],due=[],dueIndex=0,loop=false,autoPlay=false,isSpeaking=false,settings={},generated=[],editId=null,notes=[],currentNoteId=null,currentGeneratedNoteId=null;
let libraryPage=1,notePage=1;
const LIBRARY_PAGE_SIZE=10,NOTE_PAGE_SIZE=10;let walkmanQueue=[],walkmanIndex=0,walkmanPlaying=false,walkmanRate=1,walkmanAudioCache=new Map(),walkmanPrefetch=new Map(),walkmanChunkIndex=0,walkmanChunkTime=0,walkmanGlobalLineIndex=0,walkmanResumePending=false,walkmanPaused=false,walkmanRepeatTen=false,walkmanRepeatCount=0;
let quizSessionId=null,quizQuestions=[],quizIndex=0,quizStats={correct:0,partial:0,wrong:0},selectedChoice="",quizConfidence="",quizAttempts=[],quizAdaptiveAdded=0;
let ttsVoices=[],voiceCursor={zh:0,en:0},ttsInfoState={enabled:false,provider:"browser"},currentAudio=null,ttsPlaybackGeneration=0,noteSpeaking=false,activeTtsRequests=new Set(),currentTtsObjectUrl=null;
let watchAudioPrimed=false;
let watchDiagEl=null;
let watchPreparedFirstMedia=null;
let watchPreparedFirstKey="";
let watchInitialVideoStarted=false;
let watchAudioContext=null;
let watchAudioSource=null;
let watchWebAudioCache=new Map();
let watchWebAudioPending=new Map();
let feynmanHistory=[],feynmanLastQuestion="",feynmanRecognition=null,feynmanListening=false,feynmanRecognitionBase="",feynmanSessionId=null,currentFeynmanCardId=null;


async function api(path,opts={}){
  let res;
  try{
    res=await fetch("/api"+path,{...opts,headers:{"Content-Type":"application/json",...(opts.headers||{})}});
  }catch(err){
    const msg=String(err?.message||"");
    if(/load failed|failed to fetch|network/i.test(msg)){
      throw new Error("请求被中断了，可能是网络波动或 AI 出题超时。请重试一次。");
    }
    throw err;
  }

  const text=await res.text();
  let data={};
  try{data=text?JSON.parse(text):{}}
  catch{
    const looksHtml=/^\s*</.test(text||"");
    data={error:looksHtml?"":text};
  }
  if(res.status===401){showLogin();throw new Error("请先登录")}
  if(!res.ok){
    if(res.status===504){
      if(path.startsWith("/ai/organize"))throw new Error("AI 整理笔记超时，请重试一次。");
      if(path.startsWith("/quiz/generate"))throw new Error("AI 出题响应超时，请重新生成一次。");
      throw new Error(data.error||"AI 请求超时，请重试一次。");
    }
    if(res.status===502||res.status===503){
      throw new Error(data.error||"AI 服务暂时不可用，请稍后重试或切换 API。");
    }
    throw new Error(data.error||("HTTP "+res.status));
  }
  return data;
}
function esc(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function showLogin(){$("loginScreen").classList.remove("hidden");$("app").classList.add("hidden")}
function showApp(){$("loginScreen").classList.add("hidden");$("app").classList.remove("hidden")}
function go(id){
  document.querySelectorAll(".page").forEach(x=>x.classList.remove("active"));$(id).classList.add("active");
  document.querySelectorAll(".nav button").forEach(x=>x.classList.toggle("active",x.dataset.page===id));
  const t={homePage:"首页",todayPage:"今日复习",importPage:"AI 整理笔记",notesPage:"笔记库",quizPage:"AI 测试",listeningPage:"AI 听力考试",feynmanPage:"费曼模式",libraryPage:"知识库",statsPage:"学习统计",settingsPage:"设置"};
  $("pageTitle").textContent=t[id]||"MemoryCast";if(id==="statsPage")loadStats();if(id==="notesPage")loadNotes();if(id==="feynmanPage"&&!$("feynmanTopic").value)loadRandomFeynmanTopic();
}
async function init(){
  if($("connectStatus"))$("connectStatus").textContent="正在连接 API…";
  if($("retryConnectBtn"))$("retryConnectBtn").classList.add("hidden");

  let auth;
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),8000);
    const res=await fetch("/api/auth/me",{signal:controller.signal});
    clearTimeout(timer);
    if(!res.ok)throw new Error("API HTTP "+res.status);
    auth=await res.json();
  }catch(err){
    showLogin();
    if($("connectStatus"))$("connectStatus").textContent=
      "连接 API 失败。服务器可能正在重启，或 API 容器未正常启动。";
    if($("retryConnectBtn"))$("retryConnectBtn").classList.remove("hidden");
    throw err;
  }

  aiEnabled=!!auth.aiEnabled;
  $("aiStatusLogin").textContent=aiEnabled?"AI 已连接":"AI 尚未配置；基础复习仍可使用";
  if(!auth.user){showLogin();return}
  me=auth.user;
  showApp();
  go("notesPage");
  $("username").textContent=me.login;
  $("avatar").src=me.avatarUrl||"";
  $("aiDisabledImport").classList.toggle("hidden",aiEnabled);
  $("aiDisabledQuiz").classList.toggle("hidden",aiEnabled);
  $("organizeBtn").disabled=!aiEnabled;
  $("generateQuizBtn").disabled=!aiEnabled;

  const tasks=[
    ["卡片",loadCards],["今日复习",loadDue],["设置",loadSettings],["TTS",loadTtsInfo],["统计",loadStats],["笔记",loadNotes]
  ];
  const results=await Promise.allSettled(tasks.map(([,fn])=>fn()));
  const failed=results.map((r,i)=>r.status==="rejected"?tasks[i][0]:null).filter(Boolean);
  if(failed.length){
    console.error("Initial modules failed:",failed,results);
    $("syncText").textContent="部分模块加载失败："+failed.join("、");
  }

  // Warm the highest-priority walkman item after normal startup work is done.
  // This runs in the background so opening Walkman usually has audio ready.
  if(ttsInfoState.enabled){
    loadWalkmanQueue()
      .then(queue=>{
        const card=queue?.[0];
        if(!card)return null;
        const groups=walkmanChunkGroups(walkmanSegments(card));
        if(!groups[0])return null;

        // Do not create/decode through Web Audio during background startup on
        // Apple Watch. watchOS may keep an AudioContext created outside a real
        // user gesture effectively silent even though currentTime advances.
        // The Watch AudioContext is created only from the Walkman tap instead.

        const key=walkmanChunkKey(card,0,groups[0]);
        return prefetchWalkmanChunk(card,0,groups[0]).then(media=>{
          if(isAppleWatchLike()&&media?.url){
            watchPreparedFirstMedia=media;
            watchPreparedFirstKey=key;
          }
          return media;
        });
      })
      .catch(()=>{});
  }
}
async function loadCards(){const d=await api("/cards");cards=d.cards||[];$("homeCards").textContent=cards.length;renderLibrary();renderCategories();$("syncText").textContent=cards.length+" 个知识点已同步"}
async function loadDue(){const d=await api("/due");due=d.cards||[];dueIndex=Math.min(dueIndex,Math.max(0,due.length-1));$("homeDue").textContent=due.length;renderDue()}
function renderDue(){
  const c=due[dueIndex];
  if($("snoozeCurrentBtn"))$("snoozeCurrentBtn").disabled=!c;
  if(!c){
    $("cardCat").textContent="DONE";
    $("cardFront").textContent="今天的复习完成了 🎉";
    $("cardBack").textContent="可以去做 AI 测试或添加新知识。";
    $("cardExample").textContent="";
    $("cardProgress").textContent="0 / 0";
  }else{
    $("cardCat").textContent=(c.tags||[]).join(" · ")+" · "+c.stateName;
    $("cardFront").textContent=c.front;
    $("cardBack").textContent=c.back;
    $("cardExample").textContent=c.example||"";
    $("cardProgress").textContent=(dueIndex+1)+" / "+due.length;
    renderCardAttachments(c);
  }
  if(!c){
    const media=$("cardMedia");
    if(media){media.innerHTML="";media.classList.add("hidden");}
  }

  $("queueList").innerHTML=due.map((x,i)=>
    '<div class="card-item"><div><b>'+esc(x.front)+'</b></div>'+
    '<span class="chip">'+(i===dueIndex?"当前":esc(x.stateName))+'</span></div>'
  ).join("")||'<div class="muted">今天没有到期卡片。</div>';
}
function charLang(ch){
  if(/[\u3400-\u9fff]/.test(ch))return "zh-CN";
  if(/[A-Za-z]/.test(ch))return "en-US";
  return null;
}
function normalizeMathSymbolsForSpeech(text=""){
  let s=String(text||"");

  // Always-safe mathematical symbols.
  s=s
    .replace(/−/g," 减 ")
    .replace(/\+/g," 加 ")
    .replace(/[×✕]/g," 乘 ")
    .replace(/÷/g," 除以 ")
    .replace(/=/g," 等于 ");

  // ASCII operators are ambiguous in normal prose/URLs, so only convert them
  // when they clearly sit between numeric operands.
  s=s
    .replace(/(\d)\s*\*\s*(\d)/g,"$1 乘 $2")
    .replace(/(\d)\s*\/\s*(\d)/g,"$1 除以 $2")
    .replace(/(\d)\s*-\s*(\d)/g,"$1 减 $2");

  return s.replace(/\s{2,}/g," ").trim();
}

function splitByLanguage(text){
  const input=normalizeMathSymbolsForSpeech(text);
  const parts=[];
  let buf="",current=null,pending="";
  const flush=()=>{
    if(!buf)return;
    parts.push({text:buf,lang:current||"zh-CN"});
    buf="";
  };
  for(const ch of input){
    const detected=charLang(ch);
    if(!detected){
      if(buf)buf+=ch;
      else pending+=ch;
      continue;
    }
    if(!current){
      current=detected;
      buf=pending+ch;
      pending="";
      continue;
    }
    if(detected===current){
      buf+=ch;
    }else{
      flush();
      current=detected;
      buf=pending+ch;
      pending="";
    }
  }
  if(pending)buf+=pending;
  flush();
  return parts.filter(x=>x.text.trim());
}
function normalVoices(locale){
  const isZh=locale.startsWith("zh");

  if(isZh){
    const exact=ttsVoices.filter(v=>/^zh[-_]CN$/i.test(v.lang));
    const fallback=ttsVoices.filter(v=>/^zh([-_]|$)/i.test(v.lang));
    const pool=exact.length?exact:fallback;
    const bad=/\b(compact|espeak|festival|novelty|whisper|robot|trinoids|zarvox|boing|bubbles|bells|organ|bad news|good news)\b/i;
    const clean=pool.filter(v=>!bad.test(v.name||""));
    return (clean.length?clean:pool)
      .sort((a,b)=>Number(b.default)-Number(a.default)||Number(b.localService)-Number(a.localService)||String(a.name).localeCompare(String(b.name)))
      .slice(0,4);
  }

  const english=ttsVoices.filter(v=>/^en[-_](US|GB)$/i.test(v.lang));
  const preferred=/\b(Samantha|Ava|Allison|Alex|Daniel|Serena|Karen|Moira|Tessa|Sonia|Ryan|Aria|Jenny|Guy|Zira|David|Google US English|Google UK English)\b/i;
  const bad=/\b(compact|espeak|festival|novelty|whisper|robot|trinoids|zarvox|boing|bubbles|bells|organ|bad news|good news)\b/i;
  return english
    .filter(v=>preferred.test(v.name||"")&&!bad.test(v.name||""))
    .sort((a,b)=>
      Number(b.default)-Number(a.default) ||
      Number(b.localService)-Number(a.localService) ||
      String(a.name).localeCompare(String(b.name))
    )
    .slice(0,4);
}
function refreshVoices(){
  ttsVoices=speechSynthesis.getVoices()||[];
  const zh=normalVoices("zh-CN");
  const en=normalVoices("en-US");
  const fill=(id,list,saved)=>{
    const el=$(id);if(!el)return;
    const current=saved||el.value||"auto";
    el.innerHTML='<option value="auto">自然音色轮换</option>'+
      list.map(v=>'<option value="'+esc(v.name)+'">'+esc(v.name)+' · '+esc(v.lang)+'</option>').join("");
    el.value=[...el.options].some(o=>o.value===current)?current:"auto";
  };
  fill("chineseVoice",zh,localStorage.getItem("memorycast_zh_voice")||"auto");
  fill("englishVoice",en,localStorage.getItem("memorycast_en_voice")||"auto");
}
function pickVoice(locale){
  const isZh=locale.startsWith("zh");
  const list=normalVoices(locale);
  if(!list.length)return null;
  const selectId=isZh?"chineseVoice":"englishVoice";
  const chosen=$(selectId)?.value||"auto";
  if(chosen!=="auto")return list.find(v=>v.name===chosen)||list[0];

  const preferred=list.filter(v=>v.default||v.localService);
  const natural=preferred.length?preferred:list;
  const key=isZh?"zh":"en";
  const idx=voiceCursor[key]%natural.length;
  voiceCursor[key]=(voiceCursor[key]+1)%natural.length;
  return natural[idx];
}
function voiceStyleName(locale){
  const isZh=locale.startsWith("zh");
  const id=isZh?"chineseVoiceStyle":"englishVoiceStyle";
  return $(id)?.value||localStorage.getItem("memorycast_"+(isZh?"zh":"en")+"_voice_style")||"smart";
}
function voiceStyleProfile(locale){
  const style=voiceStyleName(locale);
  if(style==="host"){
    return locale.startsWith("zh")
      ? {rate:0.94,pitch:0.92}
      : {rate:0.95,pitch:0.94};
  }
  if(style==="lazy"){
    return locale.startsWith("zh")
      ? {rate:0.88,pitch:1.08}
      : {rate:0.90,pitch:1.05};
  }
  return {rate:1,pitch:1};
}
async function loadTtsInfo(){
  try{ttsInfoState=await api("/tts/info")}catch{ttsInfoState={enabled:false,provider:"browser"}}
  if($("ttsEngineStatus")){
    $("ttsEngineStatus").textContent=ttsInfoState.enabled
      ? "Azure Neural TTS 已启用 · "+(ttsInfoState.region||"")
      : "浏览器 TTS · Azure 未配置";
  }
}
function stopAllTts(){
  ttsPlaybackGeneration++;
  speechSynthesis.cancel();
  noteSpeaking=false;
  if($("speakNoteBtn"))$("speakNoteBtn").textContent="🔊 朗读笔记";

  for(const controller of activeTtsRequests){
    try{controller.abort()}catch{}
  }
  activeTtsRequests.clear();

  const audio=$("globalTtsAudio");
  if(audio){
    try{
      audio.pause();
      audio.currentTime=0;
      audio.removeAttribute("src");
      audio.load();
      audio.onended=null;
      audio.onerror=null;
    }catch{}
  }
  if(currentTtsObjectUrl){
    try{URL.revokeObjectURL(currentTtsObjectUrl)}catch{}
    currentTtsObjectUrl=null;
  }
  currentAudio=null;
}
function browserSpeakPart(part,cb){
  const u=new SpeechSynthesisUtterance(part.text);
  // Keep one English voice in browser fallback too, so mixed text never swaps speakers.
  u.lang="en-US";
  const profile=voiceStyleProfile("en-US");
  u.pitch=profile.pitch;
  u.volume=1;
  const baseRate=Number(settings.english_rate||1.0)*(document.body.classList.contains("walkman")?walkmanRate:1);
  u.rate=Math.max(0.6,Math.min(1.8,baseRate*profile.rate));
  const voice=pickVoice("en-US");
  if(voice)u.voice=voice;
  u.onend=()=>cb&&cb();
  u.onerror=()=>cb&&cb();
  speechSynthesis.speak(u);
}
async function neuralSpeakMixed(parts,cb,styleOverride=null,playbackGeneration=ttsPlaybackGeneration){
  const payloadParts=parts.map(part=>({
    text:part.text,
    language:part.lang,
    style:styleOverride||voiceStyleName(part.lang),
    rate:(part.lang==="zh-CN"
      ? Number(settings.chinese_rate||1.0)
      : Number(settings.english_rate||1.0))*(document.body.classList.contains("walkman")?walkmanRate:1)
  }));

  const controller=new AbortController();
  activeTtsRequests.add(controller);

  try{
    const res=await fetch("/api/tts",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({parts:payloadParts}),
      signal:controller.signal
    });
    activeTtsRequests.delete(controller);

    if(!res.ok)throw new Error("Neural TTS HTTP "+res.status);
    if(playbackGeneration!==ttsPlaybackGeneration)return;

    const blob=await res.blob();
    if(playbackGeneration!==ttsPlaybackGeneration)return;

    // One physical player for the entire app. Starting anything new always replaces it.
    const audio=$("globalTtsAudio");
    if(!audio)throw new Error("Global TTS player missing");

    audio.pause();
    audio.currentTime=0;
    if(currentTtsObjectUrl){
      try{URL.revokeObjectURL(currentTtsObjectUrl)}catch{}
    }

    const url=URL.createObjectURL(blob);
    currentTtsObjectUrl=url;
    currentAudio=audio;
    audio.src=url;

    const finish=()=>{
      if(playbackGeneration!==ttsPlaybackGeneration)return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if(currentTtsObjectUrl===url){
        try{URL.revokeObjectURL(url)}catch{}
        currentTtsObjectUrl=null;
      }
      currentAudio=null;
      cb&&cb();
    };

    audio.onended=finish;
    audio.onerror=()=>{
      if(playbackGeneration!==ttsPlaybackGeneration)return;
      finish();
    };

    if(playbackGeneration!==ttsPlaybackGeneration)return;
    await audio.play();
  }catch(err){
    activeTtsRequests.delete(controller);
    if(err?.name==="AbortError" || playbackGeneration!==ttsPlaybackGeneration)return;

    console.warn("Azure mixed TTS unavailable; using browser fallback:",err.message);
    let i=0;
    const fallback=()=>{
      if(playbackGeneration!==ttsPlaybackGeneration)return;
      if(i>=parts.length){cb&&cb();return}
      const current=parts[i++];
      const next=parts[i];
      browserSpeakPart(current,()=>{
        if(playbackGeneration!==ttsPlaybackGeneration)return;
        const delay=next&&next.lang!==current.lang?60:0;
        setTimeout(fallback,delay);
      });
    };
    fallback();
  }
}
function speakOne(text,cb,styleOverride=null){
  if(!text){if(cb)cb();return}
  const parts=splitByLanguage(text);
  if(!parts.length){if(cb)cb();return}
  const playbackGeneration=ttsPlaybackGeneration;
  if(ttsInfoState.enabled){
    neuralSpeakMixed(parts,cb,styleOverride,playbackGeneration);
    return;
  }
  let i=0;
  const run=()=>{
    if(playbackGeneration!==ttsPlaybackGeneration)return;
    if(i>=parts.length){if(cb)cb();return}
    const current=parts[i++];
    const next=parts[i];
    browserSpeakPart(current,()=>{
      if(playbackGeneration!==ttsPlaybackGeneration)return;
      const delay=next&&next.lang!==current.lang?60:0;
      setTimeout(run,delay);
    });
  };
  run();
}
function speakCurrent(){
  const c=due[dueIndex];
  if(!c)return;

  stopAllTts();
  autoPlay=true;
  isSpeaking=true;
  $("speakBtn").textContent="⏹ 停止";

  const arr=[c.front,c.back,c.example].filter(Boolean);
  const run=i=>{
    if(!autoPlay||!isSpeaking)return;

    if(i>=arr.length){
      if(loop){
        // Continue through the queue; if this is the last (or only) card,
        // wrap to the first one and keep listening.
        if(due.length>1){
          dueIndex=(dueIndex+1)%due.length;
          renderDue();
        }
        setTimeout(()=>{
          if(autoPlay&&loop)speakCurrent();
        },500);
        return;
      }

      isSpeaking=false;
      autoPlay=false;
      $("speakBtn").textContent="▶ 连续播放";
      return;
    }

    speakOne(arr[i],()=>setTimeout(()=>run(i+1),220));
  };

  run(0);
}
function toggleSpeak(){
  if(isSpeaking||autoPlay){
    autoPlay=false;isSpeaking=false;stopAllTts();
    $("speakBtn").textContent="🔊 朗读";
  }else{
    speakCurrent();
  }
}
function nextDue(){
  if(!due.length)return false;
  if(dueIndex < due.length-1){
    dueIndex++;
    renderDue();
    return true;
  }
  if(loop){
    dueIndex=0;
    renderDue();
    return true;
  }
  return false;
}
async function grade(rating){const c=due[dueIndex];if(!c)return;await api("/review",{method:"POST",body:JSON.stringify({id:c.id,rating})});due.splice(dueIndex,1);if(dueIndex>=due.length)dueIndex=0;renderDue();await Promise.all([loadCards(),loadStats()])}

function renderPager(prefix,page,totalPages,totalItems){
  const info=$(prefix+"PageInfo");
  const prev=$(prefix+"PrevPage");
  const next=$(prefix+"NextPage");
  if(info)info.textContent=totalItems?("第 "+page+" / "+totalPages+" 页 · 共 "+totalItems+" 条"):"暂无内容";
  if(prev)prev.disabled=page<=1;
  if(next)next.disabled=page>=totalPages;
}

function renderCategories(){
  const tags=[...new Set(cards.flatMap(c=>c.tags||[]).filter(Boolean))].sort();
  $("categoryFilter").innerHTML='<option value="">全部标签</option>'+tags.map(t=>"<option>"+esc(t)+"</option>").join("");
}
function cardIsSnoozed(c){
  return Boolean(c?.hiddenUntil && new Date(c.hiddenUntil).getTime()>Date.now());
}
async function snoozeCard(id,days=7){
  if(!id)return;
  const currentDue=due[dueIndex]?.id===id;
  const currentWalkman=document.body.classList.contains("walkman") && walkmanQueue[walkmanIndex]?.id===id;
  const currentQuiz=quizQuestions[quizIndex]?.cardId===id && !$("quizArea").classList.contains("hidden");
  try{
    // No FSRS change is recorded when a question is deliberately skipped.
    await api("/cards/"+encodeURIComponent(id)+"/snooze",{method:"POST",body:JSON.stringify({days})});
    if(currentDue){
      autoPlay=false;isSpeaking=false;stopAllTts();
      $("speakBtn").textContent="🔊 朗读";
    }
    const resumeWalkman=currentWalkman&&walkmanPlaying;
    if(currentWalkman)stopWalkman();
    if(days>0){
      walkmanQueue=walkmanQueue.filter(c=>c.id!==id);
      walkmanIndex=Math.min(walkmanIndex,Math.max(0,walkmanQueue.length-1));
      watchPreparedFirstMedia=null;watchPreparedFirstKey="";
      if(currentQuiz){
        stopAllTts();
        // Remove all outstanding adaptive variants of the paused card.
        quizQuestions.splice(quizIndex,quizQuestions.length-quizIndex,...quizQuestions.slice(quizIndex).filter(q=>q.cardId!==id));
        renderQuiz();
      }
    }
    await Promise.all([loadCards(),loadDue(),loadStats()]);
    if(currentWalkman){
      const next=walkmanQueue[walkmanIndex];
      renderWalkmanLyrics(next?walkmanSegments(next):["暂无可播放内容"],0);
      if(resumeWalkman&&next){walkmanPlaying=true;playWalkmanCurrent()}
    }
  }catch(err){alert("设置近期不出现失败："+err.message)}
}
function renderLibrary(){
  const key=($("searchInput")?.value||"").toLowerCase(),tag=$("categoryFilter")?.value||"";
  const arr=cards.filter(c=>{
    const hay=(c.front+" "+c.back+" "+c.example+" "+(c.tags||[]).join(" ")).toLowerCase();
    return (!key||hay.includes(key))&&(!tag||(c.tags||[]).includes(tag));
  });

  const totalPages=Math.max(1,Math.ceil(arr.length/LIBRARY_PAGE_SIZE));
  libraryPage=Math.min(Math.max(1,libraryPage),totalPages);
  const start=(libraryPage-1)*LIBRARY_PAGE_SIZE;
  const pageItems=arr.slice(start,start+LIBRARY_PAGE_SIZE);

  $("libraryList").innerHTML=pageItems.map(c=>{
    const paused=cardIsSnoozed(c);
    return '<div class="card-item"><div><b>'+esc(c.front)+'</b><div class="muted">'+esc(c.back)+'</div><div class="muted">'+(paused?'近期不出现至：':'下次：')+new Date(paused?c.hiddenUntil:c.due).toLocaleString()+'</div></div><div class="card-actions"><div>'+(c.tags||[]).map(t=>'<span class="chip">'+esc(t)+'</span>').join(" ")+'</div><button class="ghost" data-snooze="'+c.id+'" data-days="'+(paused?0:7)+'">'+(paused?'恢复复习':'⏳ 7天不出现')+'</button><button class="ghost" data-edit="'+c.id+'">编辑</button><button class="ghost" data-del="'+c.id+'">删除</button></div></div>';
  }).join("")||'<div class="muted">暂无内容。</div>';
  renderPager("library",libraryPage,totalPages,arr.length);

  document.querySelectorAll("[data-snooze]").forEach(b=>b.onclick=()=>snoozeCard(b.dataset.snooze,Number(b.dataset.days)));
  document.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openEdit(b.dataset.edit));
  document.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>deleteCard(b.dataset.del));
}
function openNew(){editId=null;$("modalTitle").textContent="新建卡片";$("mFront").value="";$("mBack").value="";$("mExample").value="";$("modal").classList.remove("hidden")}
function openEdit(id){const c=cards.find(x=>x.id===id);if(!c)return;editId=id;$("modalTitle").textContent="编辑卡片";$("mFront").value=c.front;$("mBack").value=c.back;$("mExample").value=c.example;$("modal").classList.remove("hidden")}
async function saveModal(){const body={front:$("mFront").value.trim(),back:$("mBack").value.trim(),example:$("mExample").value.trim()};if(!body.front||!body.back)return alert("请填写正面和背面");await api(editId?"/cards/"+editId:"/cards",{method:editId?"PUT":"POST",body:JSON.stringify(body)});$("modal").classList.add("hidden");await Promise.all([loadCards(),loadDue(),loadNotes()])}
async function deleteCard(id){if(!confirm("删除这张卡片？"))return;await api("/cards/"+id,{method:"DELETE"});await Promise.all([loadCards(),loadDue(),loadNotes()])}

async function loadNotes(){
  const d=await api("/notes");
  notes=d.notes||[];
  renderNotes();
}
function renderNotes(){
  if(!$("notesList"))return;
  const key=($("noteSearch")?.value||"").toLowerCase();
  const arr=notes.filter(n=>!key||((n.title+" "+n.content).toLowerCase().includes(key)));

  const totalPages=Math.max(1,Math.ceil(arr.length/NOTE_PAGE_SIZE));
  notePage=Math.min(Math.max(1,notePage),totalPages);
  const start=(notePage-1)*NOTE_PAGE_SIZE;
  const pageItems=arr.slice(start,start+NOTE_PAGE_SIZE);

  $("notesList").innerHTML=pageItems.map(n=>{
    const lines=String(n.content||"").split(/\r?\n/);
    const preview=lines.slice(0,5).join("\n")+(lines.length>5?"\n…":"");
    const paused=n.studyEnabled===false?' · <span class="chip">不参与学习</span>':'';
    return '<div class="card-item"><div><b>'+esc(n.title)+'</b><pre class="note-preview muted">'+esc(preview)+'</pre><div class="muted">'+new Date(n.createdAt).toLocaleString()+' · 自主复习 '+(n.manualReviewCount||0)+' 次'+paused+'</div></div><div class="card-actions"><button class="ghost" data-note-review="'+n.id+'">复习</button></div></div>';
  }).join("")||'<div class="muted">还没有保存的原始笔记。</div>';

  renderPager("note",notePage,totalPages,arr.length);
  document.querySelectorAll("[data-note-review]").forEach(b=>b.onclick=()=>openNoteReview(b.dataset.noteReview));
}
async function openNoteReview(id){
  stopAllTts();
  const d=await api("/notes/"+id);
  const n=d.note;currentNoteId=n.id;
  $("manualReviewPanel").classList.remove("hidden");
  $("manualNoteTitle").textContent=n.title;
  $("manualNoteMeta").textContent='自主复习 '+(n.manualReviewCount||0)+' 次'+(n.lastReviewedAt?' · 上次 '+new Date(n.lastReviewedAt).toLocaleString():'');
  $("manualNoteContent").textContent=n.content;
  renderAttachmentGallery("manualNoteAttachments",n.attachments||[]);
  $("speakNoteBtn").disabled=false;
  $("markNoteReviewedBtn").disabled=false;
  $("editNoteBtn").disabled=false;
  const studyBtn=$("toggleNoteStudyBtn");
  if(studyBtn){
    studyBtn.disabled=false;
    studyBtn.dataset.enabled=n.studyEnabled===false?"false":"true";
    studyBtn.textContent=n.studyEnabled===false?"↩ 恢复学习":"🚫 不参与学习";
  }
  $("deleteNoteBtn").disabled=false;
}
function dominantTextLanguage(text=""){
  const s=String(text||"");
  const zh=(s.match(/[\u3400-\u9fff]/g)||[]).length;
  const en=(s.match(/[A-Za-z]/g)||[]).length;
  return zh>=2 && zh*1.35>=en ? "zh-CN" : "en-US";
}

function splitLongTtsBlock(text,maxChars=190){
  const clean=String(text||"").trim();
  if(!clean)return [];
  if(clean.length<=maxChars)return [clean];

  const units=clean.split(/(?<=[。！？!?；;\n])/).map(x=>x.trim()).filter(Boolean);
  const chunks=[];
  let buf="";

  for(const unit of units){
    if(unit.length>maxChars){
      if(buf.trim()){chunks.push(buf.trim());buf="";}
      for(let i=0;i<unit.length;i+=maxChars){
        const part=unit.slice(i,i+maxChars).trim();
        if(part)chunks.push(part);
      }
      continue;
    }
    if((buf+"\n"+unit).trim().length>maxChars){
      if(buf.trim())chunks.push(buf.trim());
      buf=unit;
    }else{
      buf=buf?buf+"\n"+unit:unit;
    }
  }

  if(buf.trim())chunks.push(buf.trim());
  return chunks;
}

function chunkNoteForTts(text,maxChars=190){
  const clean=String(text||"").replace(/\r/g,"").trim();
  if(!clean)return [];

  // Preserve natural paragraphs/lines first. Never merge an English-primary
  // block with a Chinese-primary block, otherwise one multilingual voice would
  // have to carry both and the secondary language can sound accented.
  const blocks=clean.split(/\n{2,}/).map(x=>x.trim()).filter(Boolean);
  const chunks=[];
  let buf="";
  let bufLang="";

  const pushBuf=()=>{
    if(buf.trim())chunks.push(buf.trim());
    buf="";
    bufLang="";
  };

  for(const block of blocks){
    const pieces=splitLongTtsBlock(block,maxChars);
    for(const piece of pieces){
      const lang=dominantTextLanguage(piece);

      if(!buf){
        buf=piece;
        bufLang=lang;
        continue;
      }

      const sameLanguage=lang===bufLang;
      const fits=(buf+"\n\n"+piece).length<=maxChars;

      if(sameLanguage&&fits){
        buf+="\n\n"+piece;
      }else{
        pushBuf();
        buf=piece;
        bufLang=lang;
      }
    }
  }

  pushBuf();
  return chunks;
}
async function fetchNoteTtsChunk(text,generation){
  const parts=splitByLanguage(text).map(part=>({
    text:part.text,
    language:part.lang,
    style:voiceStyleName(part.lang),
    rate:part.lang==="zh-CN"
      ? Number(settings.chinese_rate||1.0)
      : Number(settings.english_rate||1.0)
  }));
  if(!parts.length)return null;

  const controller=new AbortController();
  activeTtsRequests.add(controller);
  try{
    const res=await fetch("/api/tts",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({parts}),
      signal:controller.signal
    });
    activeTtsRequests.delete(controller);
    if(!res.ok)throw new Error("Neural TTS HTTP "+res.status);
    if(generation!==ttsPlaybackGeneration)return null;
    const blob=await res.blob();
    if(generation!==ttsPlaybackGeneration)return null;
    return URL.createObjectURL(blob);
  }catch(err){
    activeTtsRequests.delete(controller);
    if(err?.name==="AbortError"||generation!==ttsPlaybackGeneration)return null;
    throw err;
  }
}

async function playNoteChunks(chunks,generation,btn){
  const audio=$("globalTtsAudio");
  if(!audio)throw new Error("Global TTS player missing");

  let nextPromise=fetchNoteTtsChunk(chunks[0],generation);

  for(let i=0;i<chunks.length;i++){
    if(generation!==ttsPlaybackGeneration)return;

    btn.textContent=i===0
      ?"⏳ 正在准备朗读…"
      : "⏹ 停止朗读";

    const url=await nextPromise;
    if(!url||generation!==ttsPlaybackGeneration)return;

    // Start preparing the next chunk before this one begins playback.
    nextPromise=i+1<chunks.length
      ? fetchNoteTtsChunk(chunks[i+1],generation)
      : null;

    if(currentTtsObjectUrl){
      try{URL.revokeObjectURL(currentTtsObjectUrl)}catch{}
    }
    currentTtsObjectUrl=url;
    currentAudio=audio;
    audio.pause();
    audio.currentTime=0;
    audio.src=url;

    btn.textContent="⏹ 停止朗读 · "+(i+1)+"/"+chunks.length;

    await new Promise((resolve,reject)=>{
      audio.onended=resolve;
      audio.onerror=()=>reject(new Error("音频播放失败"));
      const p=audio.play();
      if(p&&typeof p.catch==="function")p.catch(reject);
    });

    if(generation!==ttsPlaybackGeneration)return;
  }

  if(generation===ttsPlaybackGeneration){
    noteSpeaking=false;
    btn.textContent="🔊 朗读笔记";
    if(currentTtsObjectUrl){
      try{URL.revokeObjectURL(currentTtsObjectUrl)}catch{}
      currentTtsObjectUrl=null;
    }
    audio.removeAttribute("src");
    audio.load();
    currentAudio=null;
  }
}

function speakSelectedNote(){
  if(!currentNoteId)return;
  const n=notes.find(x=>x.id===currentNoteId);
  if(!n)return;

  if(noteSpeaking){
    stopAllTts();
    return;
  }

  stopAllTts();
  const chunks=chunkNoteForTts(n.content);
  if(!chunks.length)return;

  noteSpeaking=true;
  const btn=$("speakNoteBtn");
  btn.textContent="⏳ 正在准备朗读…";
  btn.disabled=true;
  setTimeout(()=>{if(btn)btn.disabled=false},250);

  const generation=ttsPlaybackGeneration;
  playNoteChunks(chunks,generation,btn).catch(err=>{
    if(generation!==ttsPlaybackGeneration)return;
    console.error("Note TTS failed:",err);
    noteSpeaking=false;
    btn.textContent="🔊 朗读笔记";
    alert("朗读失败："+err.message);
  });
}
async function markSelectedNoteReviewed(){
  if(!currentNoteId)return;
  const d=await api("/notes/"+currentNoteId+"/review",{method:"POST"});
  const i=notes.findIndex(x=>x.id===currentNoteId);
  if(i>=0)notes[i]=d.note;
  $("manualNoteMeta").textContent='自主复习 '+(d.note.manualReviewCount||0)+' 次 · 刚刚';
  renderNotes();
}

function openNoteEdit(){
  if(!currentNoteId)return;
  const n=notes.find(x=>x.id===currentNoteId);
  if(!n)return;
  $("noteEditTitle").value=n.title||"";
  $("noteEditContent").value=n.content||"";
  $("noteModal").classList.remove("hidden");
}
async function saveNoteEdit(){
  if(!currentNoteId)return;
  const title=$("noteEditTitle").value;
  const content=$("noteEditContent").value;
  if(!content.trim()) return alert("笔记内容不能为空");

  const saveBtn=$("noteModalSave");
  if(saveBtn){saveBtn.disabled=true;saveBtn.textContent="保存并同步卡片中…";}

  try{
    const d=await api("/notes/"+currentNoteId,{
      method:"PUT",
      body:JSON.stringify({title,content})
    });

    const i=notes.findIndex(x=>x.id===currentNoteId);
    if(i>=0)notes[i]=d.note;
    $("manualNoteTitle").textContent=d.note.title;
    $("manualNoteContent").textContent=d.note.content;
    $("noteModal").classList.add("hidden");
    renderNotes();

    await Promise.all([loadCards(),loadDue(),loadStats()]);

    if(d.cardSync?.status==="synced"){
      alert("笔记已保存。"+d.cardSync.message);
    }else if(d.cardSync?.status==="partial"||d.cardSync?.status==="failed"){
      alert(d.cardSync.message);
    }
  }finally{
    if(saveBtn){saveBtn.disabled=false;saveBtn.textContent="保存";}
  }
}
async function toggleCurrentNoteStudy(){
  if(!currentNoteId)return;

  const note=notes.find(x=>x.id===currentNoteId);
  const currentlyEnabled=note?.studyEnabled!==false;
  const nextEnabled=!currentlyEnabled;

  const d=await api("/notes/"+currentNoteId+"/study",{
    method:"POST",
    body:JSON.stringify({enabled:nextEnabled})
  });

  const i=notes.findIndex(x=>x.id===currentNoteId);
  if(i>=0)notes[i]=d.note;

  const studyBtn=$("toggleNoteStudyBtn");
  if(studyBtn){
    studyBtn.dataset.enabled=d.note.studyEnabled===false?"false":"true";
    studyBtn.textContent=d.note.studyEnabled===false?"↩ 恢复学习":"🚫 不参与学习";
  }

  renderNotes();
  await Promise.all([loadCards(),loadDue(),loadStats()]);

  if(d.note.studyEnabled===false){
    alert("已暂停学习。原始笔记和 "+(d.linkedCards||0)+" 张关联卡片仍然保留，但不会出现在知识库、今日复习、AI 测试和随身听中。");
  }else{
    alert("已恢复学习。关联卡片和原 FSRS 进度已重新加入学习系统。");
  }
}

async function deleteCurrentNote(){
  if(!currentNoteId)return;
  if(!confirm("删除这篇原始笔记？这篇笔记生成的相关卡片也会一起删除，且无法恢复。"))return;
  const result=await api("/notes/"+currentNoteId,{method:"DELETE"});
  notes=notes.filter(x=>x.id!==currentNoteId);
  currentNoteId=null;
  $("manualNoteTitle").textContent="自主复习";
  $("manualNoteMeta").textContent="选择左侧一篇笔记";
  $("manualNoteContent").textContent="这里会显示完整原始笔记。";
  renderAttachmentGallery("manualNoteAttachments",[]);
  $("speakNoteBtn").disabled=true;
  $("markNoteReviewedBtn").disabled=true;
  $("editNoteBtn").disabled=true;
  if($("toggleNoteStudyBtn"))$("toggleNoteStudyBtn").disabled=true;
  $("deleteNoteBtn").disabled=true;
  $("manualReviewPanel").classList.add("hidden");
  renderNotes();
  await Promise.all([loadCards(),loadDue()]);
  if(result?.deletedCards>0) alert("笔记已删除，同时删除了 "+result.deletedCards+" 张相关卡片。");
}

function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onload=()=>resolve(String(r.result||"").split(",")[1]||"");
    r.onerror=()=>reject(r.error||new Error("读取文件失败"));
    r.readAsDataURL(blob);
  });
}

function appendImportedText(text,note){
  const clean=String(text||"").trim();
  if(!clean)return;
  const box=$("noteInput");
  box.value=box.value.trim()?box.value.trim()+"\n\n"+clean:clean;
  if(note?.id)currentImportedNoteId=note.id;
  loadNotes().catch(()=>{});
}

function attachmentGalleryHtml(attachments=[]){
  return attachments.map(a=>{
    const name=esc(a.name||"附件");
    const url=esc(a.url||("#"));
    if(String(a.mimeType||"").startsWith("image/")){
      const label=a.isGenerated&&a.pageNumber
        ? "PDF 第 "+a.pageNumber+" 页"
        : name;
      return '<a class="attachment-thumb" href="'+url+'" target="_blank" rel="noopener">'+
        '<img src="'+url+'" alt="'+esc(label)+'" loading="lazy">'+
        '<span>'+esc(label)+'</span>'+
      '</a>';
    }
    if(a.mimeType==="application/pdf"){
      return '<a class="attachment-file" href="'+url+'" target="_blank" rel="noopener">📄 '+name+'</a>';
    }
    return '<a class="attachment-file" href="'+url+'" target="_blank" rel="noopener">📎 '+name+'</a>';
  }).join("");
}

function renderAttachmentGallery(id,attachments=[]){
  const box=$(id);
  if(!box)return;
  box.innerHTML=attachmentGalleryHtml(attachments);
  box.classList.toggle("hidden",!attachments.length);
}

async function renderCardAttachments(card){
  const box=$("cardMedia");
  if(!box)return;
  box.innerHTML="";
  box.classList.add("hidden");
  if(!card?.sourceNoteId)return;
  const expectedId=card.id;
  try{
    const d=await api("/notes/"+card.sourceNoteId+"/attachments");
    if(due[dueIndex]?.id!==expectedId)return;
    renderAttachmentGallery("cardMedia",d.attachments||[]);
  }catch{}
}


async function startVoiceNote(){
  if(!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder==="undefined"){
    alert("当前浏览器不支持网页录音，请使用最新版 Edge / Chrome，并通过 HTTPS 打开网站。");
    return;
  }
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const preferred=["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus"];
    const mimeType=preferred.find(x=>MediaRecorder.isTypeSupported?.(x))||"";
    voiceChunks=[];
    voiceRecorder=new MediaRecorder(stream,{
      ...(mimeType?{mimeType}:{}),
      audioBitsPerSecond:32000
    });
    voiceRecorder.ondataavailable=e=>{if(e.data?.size)voiceChunks.push(e.data)};
    voiceRecorder.onstop=async()=>{
      stream.getTracks().forEach(t=>t.stop());
      voiceRecording=false;
      $("voiceNoteBtn").textContent="🎙️ 语音记笔记";
      const type=voiceRecorder.mimeType||mimeType||"audio/webm";
      const blob=new Blob(voiceChunks,{type});
      if(voicePreviewUrl)URL.revokeObjectURL(voicePreviewUrl);
      voicePreviewUrl=URL.createObjectURL(blob);
      const preview=$("voiceNotePreview");
      preview.src=voicePreviewUrl;
      preview.classList.remove("hidden");

      if(blob.size>2700000){
        $("captureStatus").textContent="录音较长，超过当前上传限制。请分成两段录制。";
        return;
      }

      $("captureStatus").textContent="正在转写语音…";
      $("voiceNoteBtn").disabled=true;
      try{
        const audioBase64=await blobToBase64(blob);
        const ext=type.includes("ogg")?"ogg":"webm";
        const d=await api("/ai/transcribe",{method:"POST",body:JSON.stringify({
          audioBase64,
          mimeType:type,
          filename:"voice-note."+ext
        })});
        appendImportedText(d.text,d.note);
        const names={cloudflare:"Cloudflare Whisper",gemini:"Gemini Transcribe",openrouter:"OpenRouter"}; $("captureStatus").textContent="✓ "+(names[d.provider]||d.provider||"AI")+" 已完成转写并保存到笔记库，可继续编辑或整理成卡片。";
      }catch(e){
        $("captureStatus").textContent="语音转写失败："+e.message;
      }finally{
        $("voiceNoteBtn").disabled=false;
      }
    };
    voiceRecorder.start(1000);
    voiceRecording=true;
    $("voiceNoteBtn").textContent="⏹ 停止录音";
    $("captureStatus").textContent="正在录音…讲完后点“停止录音”。";
  }catch(e){
    $("captureStatus").textContent=e?.name==="NotAllowedError"
      ?"没有麦克风权限，请在浏览器地址栏允许此网站使用麦克风。"
      :"无法开始录音："+e.message;
  }
}

function toggleVoiceNote(){
  if(voiceRecording&&voiceRecorder){
    voiceRecorder.stop();
  }else{
    startVoiceNote();
  }
}

function compressImage(file,maxSide=1600,quality=.82){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    const url=URL.createObjectURL(file);
    img.onload=()=>{
      try{
        const scale=Math.min(1,maxSide/Math.max(img.width,img.height));
        const canvas=document.createElement("canvas");
        canvas.width=Math.max(1,Math.round(img.width*scale));
        canvas.height=Math.max(1,Math.round(img.height*scale));
        const ctx=canvas.getContext("2d");
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
        canvas.toBlob(blob=>{
          URL.revokeObjectURL(url);
          if(blob)resolve(blob);
          else reject(new Error("图片压缩失败"));
        },"image/jpeg",quality);
      }catch(e){
        URL.revokeObjectURL(url);reject(e);
      }
    };
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("无法读取图片"))};
    img.src=url;
  });
}

async function prepareMediaFile(file){
  const mime=String(file.type||"").toLowerCase();
  if(mime==="application/pdf"){
    if(file.size>12_000_000) throw new Error(file.name+" 超过 12MB，请先压缩 PDF。");
    return {
      name:file.name,
      mimeType:"application/pdf",
      dataBase64:await blobToBase64(file)
    };
  }

  if(!["image/jpeg","image/png","image/webp"].includes(mime)){
    throw new Error("不支持 "+file.name+" 的文件类型");
  }

  let blob=await compressImage(file);
  if(blob.size>2_700_000) blob=await compressImage(file,1200,.70);
  if(blob.size>2_700_000) throw new Error(file.name+" 图片仍然太大，请裁剪后重试。");

  return {
    name:file.name.replace(/\.[^.]+$/,"")+".jpg",
    mimeType:"image/jpeg",
    dataBase64:await blobToBase64(blob)
  };
}

async function handleMediaFiles(fileList){
  const files=[...(fileList||[])].slice(0,12);
  if(!files.length)return;

  $("photoOcrBtn").disabled=true;
  let noteId=currentImportedNoteId||"";
  const extractedPieces=[];
  let totalAttachments=0;

  try{
    for(let i=0;i<files.length;i++){
      $("captureStatus").textContent="正在处理 "+(i+1)+" / "+files.length+"："+files[i].name;
      const prepared=await prepareMediaFile(files[i]);

      // Upload one at a time so multi-image notes do not create one huge request.
      const d=await api("/ai/import-media",{
        method:"POST",
        body:JSON.stringify({
          noteId:noteId||undefined,
          files:[prepared]
        })
      });

      noteId=d.note?.id||noteId;
      currentImportedNoteId=noteId;
      totalAttachments+=(d.attachments||[]).filter(a=>!a.isGenerated).length;
      if(String(d.text||"").trim())extractedPieces.push(String(d.text).trim());
    }

    if(extractedPieces.length){
      const clean=extractedPieces.join("\n\n---\n\n");
      const box=$("noteInput");
      box.value=box.value.trim()?box.value.trim()+"\n\n"+clean:clean;
    }

    await loadNotes();
    $("captureStatus").textContent="✓ 已保存 "+totalAttachments+" 个原始附件；PDF 页面已自动生成视觉题素材。可直接整理成卡片。";
  }catch(e){
    $("captureStatus").textContent="附件处理失败："+e.message;
  }finally{
    $("photoOcrBtn").disabled=false;
    $("photoOcrInput").value="";
  }
}
function clipboardMediaFiles(event){
  const items=[...(event.clipboardData?.items||[])];
  const files=[];

  for(const item of items){
    if(item.kind!=="file")continue;
    const file=item.getAsFile?.();
    if(!file)continue;

    const type=String(file.type||"").toLowerCase();
    if(!type.startsWith("image/") && type!=="application/pdf")continue;

    // Screenshots copied from the clipboard often have no useful filename.
    if(file.name){
      files.push(file);
      continue;
    }

    const ext=type==="image/png"?"png"
      : type==="image/webp"?"webp"
      : type==="image/jpeg"?"jpg"
      : type==="application/pdf"?"pdf"
      : "bin";

    files.push(new File([file],"clipboard-"+Date.now()+"."+ext,{type:file.type}));
  }

  return files;
}

function setupImportMediaDropPaste(){
  const zone=$("importDropZone");
  if(!zone)return;

  let dragDepth=0;

  zone.addEventListener("dragenter",event=>{
    if(!event.dataTransfer?.types?.includes("Files"))return;
    event.preventDefault();
    dragDepth++;
    zone.classList.add("drag-active");
    $("captureStatus").textContent="松开即可导入图片 / PDF";
  });

  zone.addEventListener("dragover",event=>{
    if(!event.dataTransfer?.types?.includes("Files"))return;
    event.preventDefault();
    event.dataTransfer.dropEffect="copy";
    zone.classList.add("drag-active");
  });

  zone.addEventListener("dragleave",event=>{
    if(!event.dataTransfer?.types?.includes("Files"))return;
    dragDepth=Math.max(0,dragDepth-1);
    if(dragDepth===0)zone.classList.remove("drag-active");
  });

  zone.addEventListener("drop",event=>{
    if(!event.dataTransfer?.files?.length)return;
    event.preventDefault();
    dragDepth=0;
    zone.classList.remove("drag-active");
    handleMediaFiles(event.dataTransfer.files);
  });

  document.addEventListener("paste",event=>{
    // Only hijack paste when the AI import page is actually open and the
    // clipboard contains media. Normal text paste stays untouched.
    if(!$("importPage")?.classList.contains("active"))return;

    const files=clipboardMediaFiles(event);
    if(!files.length)return;

    event.preventDefault();
    $("captureStatus").textContent="检测到剪贴板图片，正在导入…";
    handleMediaFiles(files);
  });
}

async function organize(){
  const text=$("noteInput").value.trim();if(!text)return alert("请先粘贴笔记");const b=$("organizeBtn");b.disabled=true;b.textContent="AI 整理中…";
  try{const d=await api("/ai/organize",{method:"POST",body:JSON.stringify({text,splitMode:$("cardSplitMode").value,noteId:currentImportedNoteId})});currentGeneratedNoteId=d.note?.id||null;currentImportedNoteId=d.note?.id||currentImportedNoteId;generated=d.cards||[];loadNotes();$("generatedCards").innerHTML='<div class="muted" style="margin-bottom:10px">✓ 原始笔记已保存到笔记库，不会因生成卡片而删除。</div>'+generated.map(c=>'<div class="mini-card"><div class="eyebrow">'+(c.tags||[]).map(esc).join(" · ")+'</div><b>'+esc(c.front)+'</b><div>'+esc(c.back)+'</div><div class="muted">'+esc(c.example||"")+'</div></div>').join("");$("saveGeneratedBtn").classList.toggle("hidden",!generated.length)}
  catch(e){alert(e.message)}finally{b.disabled=!aiEnabled;b.textContent="✨ AI 整理为卡片"}
}
async function saveGenerated(){
  const d=await api("/ai/organize/save",{
    method:"POST",
    body:JSON.stringify({cards:generated,noteId:currentGeneratedNoteId})
  });

  generated=[];
  currentGeneratedNoteId=null;
  currentImportedNoteId=null;

  // A completed save ends the current import/organize session.
  // The next text the user enters must create a brand-new note instead of
  // updating the note that produced the cards just saved.
  const noteInput=$("noteInput");
  if(noteInput)noteInput.value="";
  const captureStatus=$("captureStatus");
  if(captureStatus)captureStatus.textContent="";

  $("generatedCards").innerHTML='<div class="muted">已保存 '+d.cards.length+' 张卡片。可以输入下一条笔记。</div>';
  $("saveGeneratedBtn").classList.add("hidden");

  await Promise.all([loadCards(),loadDue(),loadNotes()]);
}

async function generateQuiz(options={}){
  const b=$("generateQuizBtn");
  b.disabled=true;
  b.textContent="AI 出题中…";

  const mode=options.mode||$("quizMode").value;
  const count=Number(options.count||$("quizCount").value);
  const cardIds=Array.isArray(options.cardIds)?options.cardIds:undefined;

  try{
    const d=await api("/quiz/generate",{
      method:"POST",
      body:JSON.stringify({mode,count,watchMode:isAppleWatchLike(),...(cardIds?{cardIds}:{})})
    });

    quizSessionId=d.sessionId;
    quizQuestions=d.questions||[];
    quizIndex=0;
    quizStats={correct:0,partial:0,wrong:0};
    quizAttempts=[];
    quizAdaptiveAdded=0;
    quizConfidence="";
    $("quizTitle").textContent=d.title;
    $("quizEmpty").classList.add("hidden");
    $("quizResult").classList.add("hidden");
    $("quizArea").classList.remove("hidden");
    renderQuiz();
  }catch(e){
    alert(e.message);
  }finally{
    b.disabled=!aiEnabled;
    b.textContent="✨ AI 出题";
  }
}

function difficultyLabel(level){
  return {
    foundation:"基础",
    standard:"标准",
    challenge:"挑战"
  }[level]||"标准";
}

function setQuizConfidence(value){
  quizConfidence=value;
  document.querySelectorAll("[data-confidence]").forEach(btn=>{
    btn.classList.toggle("selected",btn.dataset.confidence===value);
  });
}

function replayQuizAudio(){
  const q=quizQuestions[quizIndex];
  if(!q?.audioText)return;

  // Always reset the shared TTS player first. This makes repeated taps reliable
  // and also lets a tap during playback restart the listening clip from the beginning.
  stopAllTts();

  const btn=$("listenQuizBtn");
  if(btn){
    btn.disabled=true;
    btn.textContent="🔊 播放中…";
    setTimeout(()=>{if(btn)btn.disabled=false},180);
  }

  speakOne(q.audioText,()=>{
    if(btn){
      btn.disabled=false;
      btn.textContent="🔁 重播听力";
    }
  });
}

function renderQuiz(){
  const q=quizQuestions[quizIndex];
  if(!q)return finishQuiz();

  selectedChoice="";
  quizConfidence="";
  $("quizProgress").textContent=(quizIndex+1)+" / "+quizQuestions.length;
  $("quizSnoozeBtn").disabled=!q.cardId;
  const hasQuizAudio=Boolean(String(q.audioText||"").trim());
  const quizKind=hasQuizAudio&&q.type==="mcq"
    ?"听力选择题"
    : ({mcq:"选择题",fill:"填空题",short:"简答题",listening:"听力题"}[q.type]||q.type);
  $("quizType").textContent=(q.visualAttachmentId?"看图题 · ":"")+quizKind+(q.adaptive?" · 自适应变式":"");
  $("quizDifficulty").textContent=difficultyLabel(q.difficultyLevel);
  $("quizPrompt").textContent=q.prompt;

  const visual=$("quizVisual");
  if(q.visualAttachmentId){
    visual.innerHTML='<img src="/api/attachments/'+encodeURIComponent(q.visualAttachmentId)+'" alt="题目图片" loading="eager">';
    visual.classList.remove("hidden");
  }else{
    visual.innerHTML="";
    visual.classList.add("hidden");
  }

  $("listenQuizBtn").classList.toggle("hidden",!hasQuizAudio);
  $("listenQuizBtn").textContent="🔊 播放听力";
  $("listenQuizBtn").disabled=false;

  $("quizChoices").innerHTML=q.type==="mcq"
    ? q.choices.map((x,i)=>'<button class="quiz-choice" data-choice="'+esc(x)+'">'+String.fromCharCode(65+i)+". "+esc(x)+"</button>").join("")
    : "";

  $("quizAnswer").value="";
  $("quizAnswer").classList.toggle("hidden",q.type==="mcq");
  $("quizFeedback").className="feedback hidden";
  $("nextQuizBtn").classList.add("hidden");
  $("submitQuizBtn").classList.remove("hidden");

  document.querySelectorAll("[data-confidence]").forEach(btn=>btn.classList.remove("selected"));
  document.querySelectorAll(".quiz-choice").forEach(btn=>btn.onclick=()=>{
    document.querySelectorAll(".quiz-choice").forEach(x=>x.classList.remove("selected"));
    btn.classList.add("selected");
    selectedChoice=btn.dataset.choice;
  });
}

function scheduleAdaptiveQuestion(question){
  if(!question||quizAdaptiveAdded>=3)return;
  quizAdaptiveAdded++;

  // Put the transformed question 2–4 questions later when possible.
  const gap=2+Math.floor(Math.random()*3);
  const insertAt=Math.min(quizQuestions.length,quizIndex+gap+1);
  quizQuestions.splice(insertAt,0,question);
}

async function submitQuiz(){
  const q=quizQuestions[quizIndex];
  const answer=q.type==="mcq"?selectedChoice:$("quizAnswer").value.trim();
  if(!answer)return alert("请先作答");
  if(!quizConfidence)return alert("请先选择你对这个答案有多确定");

  const b=$("submitQuizBtn");
  b.disabled=true;
  b.textContent="AI 判分中…";

  try{
    const d=await api("/quiz/grade",{
      method:"POST",
      body:JSON.stringify({
        sessionId:quizSessionId,
        questionId:q.id,
        answer,
        confidence:quizConfidence,
        watchMode:isAppleWatchLike()
      })
    });

    quizStats[d.verdict]=(quizStats[d.verdict]||0)+1;
    quizAttempts.push({
      cardId:q.cardId,
      prompt:q.prompt,
      verdict:d.verdict,
      confidence:quizConfidence,
      difficultyLevel:q.difficultyLevel||"standard",
      adaptive:q.adaptive===true,
      metacognitiveTrap:d.metacognitiveTrap===true,
      correctAnswer:d.correctAnswer
    });

    if(d.adaptiveQuestion)scheduleAdaptiveQuestion(d.adaptiveQuestion);

    const label=d.verdict==="correct"?"✅ 正确":d.verdict==="partial"?"🟡 基本正确":"❌ 错误";
    const confidenceText={sure:"很确定",unsure:"不太确定",guess:"猜的 / 不会"}[quizConfidence]||quizConfidence;
    const trap=d.metacognitiveTrap
      ? '<br><b>⚠️ 高置信错觉：</b>你很确定，但答案实际上错误，这个知识点会被优先重测。'
      : "";

    const box=$("quizFeedback");
    box.className="feedback "+d.verdict;
    box.innerHTML=
      "<b>"+label+"</b> · "+esc(confidenceText)+
      "<br>"+esc(d.feedback)+
      "<br><b>参考答案：</b>"+esc(d.correctAnswer)+
      "<br><b>解释：</b>"+esc(d.explanation)+
      trap+
      '<br><span class="muted">FSRS：'+esc(d.fsrsRating)+(d.adaptiveQuestion?" · 已安排变式重测":"")+"</span>";

    b.classList.add("hidden");
    $("nextQuizBtn").classList.remove("hidden");
    await Promise.all([loadCards(),loadDue(),loadStats()]);
  }catch(e){
    alert(e.message);
  }finally{
    b.disabled=false;
    b.textContent="提交答案";
  }
}

function quizKnowledgeSummary(){
  const groups=new Map();
  for(const a of quizAttempts){
    if(!groups.has(a.cardId))groups.set(a.cardId,[]);
    groups.get(a.cardId).push(a);
  }

  const stable=[],fuzzy=[],weak=[];
  for(const [cardId,items] of groups){
    const card=cards.find(c=>String(c.id)===String(cardId));
    const name=card?.front||items[0]?.prompt||"知识点";
    const hasWrong=items.some(x=>x.verdict==="wrong");
    const hasPartial=items.some(x=>x.verdict==="partial");
    const allCorrect=items.every(x=>x.verdict==="correct");
    const sureCorrect=items.some(x=>x.verdict==="correct"&&x.confidence==="sure");
    const trap=items.some(x=>x.metacognitiveTrap);
    const latest=items[items.length-1];
    const recovered=hasWrong && latest?.verdict==="correct";

    const entry={cardId,name,trap:trap&&!recovered,recovered,items};
    if(latest?.verdict==="wrong")weak.push(entry);
    else if(hasWrong || hasPartial || !sureCorrect || !allCorrect)fuzzy.push(entry);
    else stable.push(entry);
  }

  return {stable,fuzzy,weak};
}

function renderKnowledgeGroup(title,arr,emptyText){
  const rows=arr.slice(0,6).map(x=>
    '<div class="quiz-diagnosis-row">'+
      '<span>'+esc(x.name)+'</span>'+
      (x.trap?'<span class="chip">高置信错题</span>':x.recovered?'<span class="chip">已变式纠正</span>':'')+
    '</div>'
  ).join("");
  return '<div class="quiz-diagnosis-group"><b>'+title+'</b>'+
    (rows||'<div class="muted">'+emptyText+'</div>')+
  '</div>';
}

function finishQuiz(){
  $("quizArea").classList.add("hidden");
  $("quizResult").classList.remove("hidden");

  const total=quizAttempts.length||1;
  const mastery=Math.round(
    ((quizStats.correct||0)+(quizStats.partial||0)*0.5)/total*100
  );
  const summary=quizKnowledgeSummary();
  const wrongIds=[...new Set(summary.weak.map(x=>x.cardId))];
  const weakest=summary.weak[0]||summary.fuzzy[0]||null;

  $("quizResult").innerHTML=
    '<div class="quiz-diagnosis">'+
      '<div class="quiz-empty"><b style="font-size:34px">'+(quizAttempts.length?mastery+'%':'—')+'</b><br>本次掌握度'+
      '<br>正确 '+quizStats.correct+' · 基本正确 '+quizStats.partial+' · 错误 '+quizStats.wrong+
      '<br><span class="muted">自适应变式题 '+quizAdaptiveAdded+' 道；结果已更新 FSRS。</span></div>'+
      '<div class="quiz-diagnosis-grid">'+
        renderKnowledgeGroup("✅ 稳定掌握",summary.stable,"本次暂无稳定掌握项")+
        renderKnowledgeGroup("⚠️ 模糊",summary.fuzzy,"本次暂无模糊项")+
        renderKnowledgeGroup("❌ 未掌握",summary.weak,"本次没有明显未掌握项")+
      '</div>'+
      '<div class="row quiz-result-actions" style="flex-wrap:wrap;margin-top:16px">'+
        '<button id="quizWrongBtn" class="ghost" '+(!wrongIds.length?'disabled':'')+'>只复习错题</button>'+
        '<button id="quizWeakBtn" class="ghost">再测薄弱点 5 题</button>'+
        '<button id="quizFeynmanBtn" class="btn dark" '+(!weakest?'disabled':'')+'>进入费曼模式补薄弱点</button>'+
      '</div>'+
    '</div>';

  const wrongBtn=$("quizWrongBtn");
  if(wrongBtn)wrongBtn.onclick=()=>generateQuiz({
    mode:"weak",
    count:Math.max(3,Math.min(10,wrongIds.length*2)),
    cardIds:wrongIds
  });

  const weakBtn=$("quizWeakBtn");
  if(weakBtn)weakBtn.onclick=()=>generateQuiz({mode:"weak",count:5});

  const feynmanBtn=$("quizFeynmanBtn");
  if(feynmanBtn&&weakest)feynmanBtn.onclick=()=>{
    const card=cards.find(c=>String(c.id)===String(weakest.cardId));
    currentFeynmanCardId=weakest.cardId;
    resetFeynmanConversation(false);
    $("feynmanTopic").value=card?.front||weakest.name;
    $("feynmanTopicMeta").textContent="来自本次 AI 测试的薄弱知识点";
    go("feynmanPage");
  };
}

async function loadRandomFeynmanTopic(){
  const btn=$("randomFeynmanTopicBtn");
  if(btn){btn.disabled=true;btn.textContent="选择中…";}
  try{
    const qs=currentFeynmanCardId?"?exclude="+encodeURIComponent(currentFeynmanCardId):"";
    const d=await api("/feynman/topic"+qs);
    currentFeynmanCardId=d.card?.id||null;
    $("feynmanTopic").value=d.card?.topic||"";
    const parts=[
      d.card?.reason||"",
      d.card?.stateName?("FSRS "+d.card.stateName):"",
      Number.isFinite(Number(d.card?.difficulty))&&Number(d.card?.difficulty)>0
        ? ("难度 "+Number(d.card.difficulty).toFixed(1))
        : ""
    ].filter(Boolean);
    $("feynmanTopicMeta").textContent=parts.join(" · ")||"从记忆曲线中随机抽取。";
    resetFeynmanConversation(false);
  }catch(e){
    currentFeynmanCardId=null;
    $("feynmanTopic").value="";
    $("feynmanTopicMeta").textContent=e.message;
  }finally{
    if(btn){btn.disabled=false;btn.textContent="↻ 换一个";}
  }
}

function resetFeynmanConversation(clearTopic=false){
  if(feynmanRecognition&&feynmanListening){
    try{feynmanRecognition.stop()}catch{}
  }
  stopAllTts();
  feynmanSessionId=null;
  feynmanHistory=[];
  feynmanLastQuestion="";
  feynmanRecognitionBase="";
  $("feynmanInput").value="";
  $("feynmanEmpty").classList.remove("hidden");
  $("feynmanResult").classList.add("hidden");
  $("feynmanScore").textContent="等待讲解";
  $("feynmanMicTitle").textContent="点击开始讲";
  $("feynmanMicStatus").textContent="讲完一整段后再停止，AI 不会中途打断你。";
  if(clearTopic){
    currentFeynmanCardId=null;
    $("feynmanTopic").value="";
    $("feynmanTopicMeta").textContent="正在从记忆曲线中选择知识点…";
  }
  renderFeynmanHistory();
}

async function chooseAnotherFeynmanTopic(){
  resetFeynmanConversation(false);
  await loadRandomFeynmanTopic();
}

function applyFeynmanAiMetadata(meta={}){
  $("feynmanEmpty").classList.add("hidden");
  $("feynmanResult").classList.remove("hidden");
  $("feynmanUnderstood").textContent=meta.understood||meta.studentReply||"";
  $("feynmanStrengths").innerHTML=(meta.strengths||[]).map(x=>'<div>✓ '+esc(x)+'</div>').join("")||'<div class="muted">暂无记录。</div>';
  $("feynmanGaps").innerHTML=(meta.gaps||[]).map(x=>'<div>→ '+esc(x)+'</div>').join("")||'<div class="muted">暂无明显逻辑缺口。</div>';
  $("feynmanQuestion").textContent=meta.followUpQuestion||"";
  $("feynmanScore").textContent="清晰度 "+Number(meta.clarityScore||0)+"%";
  $("feynmanStatus").textContent=meta.status==="mastered"
    ?"已经基本讲通。"
    :"可以继续回答这个追问。";
  feynmanLastQuestion=meta.followUpQuestion||"";
}

function renderFeynmanHistory(){
  const box=$("feynmanHistory");if(!box)return;
  if(!feynmanHistory.length){box.innerHTML="";return}
  box.innerHTML='<div class="eyebrow" style="margin-top:18px">本次对话</div>'+
    feynmanHistory.map(x=>
      '<div class="feynman-turn '+(x.role==="user"?"user":"ai")+'"><b>'+(x.role==="user"?"你":"AI 学生")+'</b><div>'+esc(x.text)+'</div></div>'
    ).join("");
}
function resetFeynman(){chooseAnotherFeynmanTopic();}

function setupFeynmanRecognition(){
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Recognition){
    $("feynmanMicBtn").disabled=true;
    $("feynmanMicStatus").textContent="当前浏览器不支持语音识别，可以直接输入文字。";
    return;
  }

  const recognition=new Recognition();
  recognition.continuous=true;
  recognition.interimResults=true;
  recognition.lang="zh-CN";

  recognition.onstart=()=>{
    feynmanListening=true;
    $("feynmanMicBtn").classList.add("listening");
    $("feynmanMicTitle").textContent="正在听你讲…";
    $("feynmanMicStatus").textContent="请把这一段完整讲完；再次点击麦克风停止。";
  };

  recognition.onresult=e=>{
    let finalText="",interim="";
    for(let i=e.resultIndex;i<e.results.length;i++){
      const text=e.results[i][0]?.transcript||"";
      if(e.results[i].isFinal)finalText+=text;
      else interim+=text;
    }
    if(finalText.trim())feynmanRecognitionBase=(feynmanRecognitionBase+" "+finalText).trim();
    $("feynmanInput").value=(feynmanRecognitionBase+(interim?" "+interim:"")).trim();
  };

  recognition.onerror=e=>{
    $("feynmanMicStatus").textContent=e.error==="not-allowed"
      ?"没有麦克风权限。请允许此 HTTPS 网站使用麦克风，或直接输入文字。"
      :"语音识别暂时中断，可以再次点击继续。";
  };

  recognition.onend=()=>{
    feynmanListening=false;
    $("feynmanMicBtn").classList.remove("listening");
    $("feynmanMicTitle").textContent="这一段讲完了";
    if(!$("feynmanMicStatus").textContent.includes("权限")){
      $("feynmanMicStatus").textContent="可以先检查转写，再点击“让 AI 分析”。";
    }
  };

  feynmanRecognition=recognition;
}

function toggleFeynmanMic(){
  if(!feynmanRecognition)setupFeynmanRecognition();
  if(!feynmanRecognition)return;
  if(feynmanListening){
    try{feynmanRecognition.stop()}catch{}
    return;
  }

  // The learner is taking the turn: stop current and pending AI speech first.
  stopAllTts();
  feynmanRecognitionBase=$("feynmanInput").value.trim();
  try{feynmanRecognition.start()}catch{}
}

async function submitFeynman(){
  const topic=$("feynmanTopic").value.trim();
  const explanation=$("feynmanInput").value.trim();

  if(!topic)return alert("先填写一个要讲解的主题。");
  if(!explanation)return alert("先完整讲一段内容，再让 AI 分析。");
  if(!aiEnabled)return alert("AI 尚未配置。");

  if(feynmanListening&&feynmanRecognition){
    try{feynmanRecognition.stop()}catch{}
  }

  const btn=$("submitFeynmanBtn");
  btn.disabled=true;
  btn.textContent="AI 正在分析…";
  $("feynmanMicStatus").textContent="正在分析你的完整讲解…";

  try{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),45000);
    let d;
    try{
      d=await api("/feynman/respond",{
        method:"POST",
        signal:controller.signal,
        body:JSON.stringify({
          topic,explanation,sessionId:feynmanSessionId,cardId:currentFeynmanCardId
        })
      });
    }finally{
      clearTimeout(timeout);
    }

    feynmanSessionId=d.sessionId||feynmanSessionId;
    feynmanHistory.push({role:"user",text:explanation});
    const aiTurn=[d.studentReply,d.followUpQuestion].filter(Boolean).join(" ");
    if(aiTurn)feynmanHistory.push({role:"ai",text:aiTurn});
    feynmanHistory=feynmanHistory.slice(-16);
    feynmanLastQuestion=d.followUpQuestion||"";

    $("feynmanEmpty").classList.add("hidden");
    $("feynmanResult").classList.remove("hidden");
    $("feynmanUnderstood").textContent=d.understood||"";
    $("feynmanStrengths").innerHTML=(d.strengths||[]).map(x=>'<div>✓ '+esc(x)+'</div>').join("")||'<div class="muted">这一轮暂时没有明显的正确点可单独列出。</div>';
    $("feynmanGaps").innerHTML=(d.gaps||[]).map(x=>'<div>→ '+esc(x)+'</div>').join("")||'<div class="muted">核心逻辑暂时没有明显缺口。</div>';
    $("feynmanQuestion").textContent=d.followUpQuestion||"";
    $("feynmanScore").textContent="清晰度 "+Number(d.clarityScore||0)+"%";
    const fsrsLabel=d.feynmanFsrsRating
      ? (" · FSRS "+({Again:"重学",Hard:"困难",Good:"掌握",Easy:"简单"}[d.feynmanFsrsRating]||d.feynmanFsrsRating))
      : "";
    $("feynmanStatus").textContent=(d.studentReply||(
      d.status==="mastered"
        ?"这部分已经基本讲通。"
        :"继续回答上面的追问。"
    ))+fsrsLabel;

    renderFeynmanHistory();

    $("feynmanInput").value="";
    feynmanRecognitionBase="";
    $("feynmanInput").placeholder=d.followUpQuestion
      ? "下一轮可以直接回答这个追问："+d.followUpQuestion
      : "继续讲下一段……";
    $("feynmanMicTitle").textContent="点击讲下一段";
    $("feynmanMicStatus").textContent="分析完成。你可以继续讲下一段。";

    if(d.feynmanFsrsRating){
      Promise.all([loadCards(),loadDue(),loadStats()]).catch(()=>{});
    }
    const spoken=[d.studentReply,d.followUpQuestion].filter(Boolean).join(" ");
    if(spoken)speakOne(spoken,null,"conversation");
  }catch(e){
    const message=e?.name==="AbortError"
      ? "AI 分析超过 45 秒，已自动停止。你的回答还在，可以直接重试。"
      : (e?.message||"AI 分析失败，请重试。");
    alert(message);
    $("feynmanMicStatus").textContent="分析失败，但你的转写还在，可以再次提交。";
  }finally{
    btn.disabled=false;
    btn.textContent="让 AI 分析";
  }
}

const statsState={days:7,requestId:0,categories:[],showAllCategories:false};

function statsDateLabel(date){
  const parts=String(date||"").slice(0,10).split("-");
  return parts.length===3?Number(parts[1])+"/"+Number(parts[2]):String(date||"");
}

function renderReviewTrend(rows=[]){
  const box=$("reviewTrendChart");
  if(!box)return;
  if(!rows.length){box.innerHTML='<p class="insights-empty">暂无复习记录。</p>';return;}
  const width=720,height=232,left=30,right=24,top=27,bottom=38;
  const counts=rows.map(x=>Math.max(0,Number(x.count)||0));
  const max=Math.max(1,...counts),plotW=width-left-right,plotH=height-top-bottom;
  const points=counts.map((count,i)=>({
    x:left+(rows.length===1?plotW/2:i*plotW/(rows.length-1)),
    y:top+plotH-count/max*plotH,count,date:rows[i].date
  }));
  const path=points.map((p,i)=>(i?"L":"M")+p.x.toFixed(2)+","+p.y.toFixed(2)).join(" ");
  const floor=top+plotH,first=points[0],last=points[points.length-1];
  const area=path+" L"+last.x.toFixed(2)+","+floor+" L"+first.x.toFixed(2)+","+floor+" Z";
  const grid=[0,.25,.5,.75,1].map(v=>{
    const y=top+plotH*(1-v);
    return '<line class="insights-trend-grid" x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'"/>';
  }).join("");
  const step=rows.length<=7?1:Math.ceil((rows.length-1)/6);
  const labels=points.map((p,i)=>(i%step===0||i===points.length-1)
    ?'<text class="insights-trend-label" x="'+p.x+'" y="'+(height-12)+'" text-anchor="middle">'+esc(statsDateLabel(p.date))+'</text>'
    :"").join("");
  const dots=points.map((p,i)=>{
    const visible=rows.length<=14||i===points.length-1;
    return '<circle class="insights-trend-dot'+(visible?" visible":"")+'" cx="'+p.x+'" cy="'+p.y+'" r="'+(visible?4:9)+'"><title>'+esc(p.date)+' · '+p.count+' 次</title></circle>';
  }).join("");
  box.innerHTML='<div class="insights-trend-container"><svg class="insights-trend-svg" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="最近'+statsState.days+'天每日复习与测试次数趋势图">'+
    '<defs><linearGradient id="insightsTrendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5b76ed" stop-opacity=".24"/><stop offset="100%" stop-color="#5b76ed" stop-opacity="0"/></linearGradient></defs>'+
    grid+'<path class="insights-trend-area" d="'+area+'"/><path class="insights-trend-path" d="'+path+'"/>'+dots+labels+'</svg></div>';
}

function renderCategoryChart(rows=[]){
  const box=$("categoryChart");
  if(!box)return;
  const top=rows.slice(0,8);
  if(!top.length){box.innerHTML='<p class="insights-empty">还没有标签数据，添加知识卡片后会显示。</p>';return;}
  const max=Math.max(1,...top.map(x=>Number(x.count)||0));
  box.innerHTML='<div class="insights-hbars">'+top.map(x=>{
    const count=Math.max(0,Number(x.count)||0);
    return '<div class="insights-hbar-row"><div class="insights-hbar-label" title="'+esc(x.category)+'">'+esc(x.category)+'</div>'+
      '<div class="insights-hbar-track"><div class="insights-hbar-fill" style="width:'+Math.round(count/max*100)+'%"></div></div>'+
      '<span class="insights-hbar-value">'+count+'</span></div>';
  }).join("")+'</div>';
}

function renderStatsCategories(){
  const rows=statsState.categories||[];
  const container=$("categoryStats"),toggle=$("statsCategoryToggle");
  if(!container||!toggle)return;
  toggle.classList.toggle("hidden",rows.length<=8);
  toggle.textContent=statsState.showAllCategories?"收起详情":"展开全部（"+rows.length+"）";
  toggle.setAttribute("aria-expanded",statsState.showAllCategories?"true":"false");
  const shown=statsState.showAllCategories?rows:rows.slice(0,8);
  const max=Math.max(1,...rows.map(x=>Number(x.count)||0));
  container.innerHTML=shown.map(x=>{
    const count=Math.max(0,Number(x.count)||0),difficulty=Number(x.avg_difficulty||0);
    return '<div class="insights-category-row"><div class="insights-category-name"><b>'+esc(x.category)+'</b>'+
      '<span>平均 FSRS 难度 '+(Number.isFinite(difficulty)?difficulty.toFixed(2):"—")+'</span></div>'+
      '<div class="insights-category-track"><div style="width:'+Math.round(count/max*100)+'%"></div></div>'+
      '<strong>'+count+' 张</strong></div>';
  }).join("")||'<p class="insights-empty">暂无分类数据。</p>';
}

function renderStatsCalendar(rows=[]){
  const box=$("statsHeatmap");
  if(!box)return;
  const data=rows.slice(-84);
  if(!data.length){box.innerHTML='<p class="insights-empty">暂无日历数据。</p>';return;}
  const peak=Math.max(1,...data.map(x=>Number(x.count)||0));
  const firstDate=new Date(String(data[0].date)+"T12:00:00Z");
  const padding=Number.isNaN(firstDate.getTime())?0:(firstDate.getUTCDay()+6)%7;
  const blanks=Array.from({length:padding},()=>'<span class="insights-calendar-blank" aria-hidden="true"></span>').join("");
  const cells=data.map(x=>{
    const count=Math.max(0,Number(x.count)||0);
    const level=count===0?0:Math.min(4,Math.max(1,Math.ceil(count/peak*4)));
    return '<span class="insights-calendar-cell" data-level="'+level+'" title="'+esc(x.date)+'：'+count+' 次"></span>';
  }).join("");
  box.innerHTML='<div class="insights-calendar-days" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>'+
    '<div class="insights-calendar-grid" role="img" aria-label="最近12周学习活跃日历，颜色越深表示当日学习次数越多">'+blanks+cells+'</div>';
  $("statsCalendarHint").textContent='近 84 天有 '+data.filter(x=>Number(x.count)>0).length+' 天留下学习记录';
}

function renderStatsHighlights(d){
  const rows=d.dailyReviews||[];
  const active=rows.filter(x=>Number(x.count)>0).length;
  const best=rows.reduce((a,b)=>Number(b.count)>Number(a.count||0)?b:a,{count:0,date:""});
  const streak=Number(d.streak||0),streakLabel=d.streakCapped?"≥"+streak:streak;
  const items=[
    {symbol:"◷",value:active+" 天",name:"活跃学习天数",hint:"所选 "+statsState.days+" 天内有学习记录"},
    {symbol:"↝",value:streakLabel+" 天",name:"连续学习",hint:"允许今天尚未学习，近期数据不足时显示下限"},
    {symbol:"▥",value:Number(d.dueCards||0)+" 张",name:"当前待复习",hint:"已到期的启用中知识卡片"},
    {symbol:"★",value:Number(best.count)>0?best.count+" 次":"—",name:"阶段最佳单日",hint:Number(best.count)>0?statsDateLabel(best.date)+" 的复习 / 测试次数":"尚无记录"}
  ];
  $("statsHighlights").innerHTML=items.map(x=>'<div class="insights-highlight"><span aria-hidden="true">'+x.symbol+'</span><strong>'+esc(x.value)+'</strong><b>'+x.name+'</b><small>'+esc(x.hint)+'</small></div>').join("");
}

async function loadStats(){
  if(!me)return;
  const requestId=++statsState.requestId;
  const refresh=$("statsRefreshBtn");
  if(refresh)refresh.disabled=true;
  $("statsStatus").textContent="正在更新学习统计…";
  try{
    const tz=Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";
    const d=await api("/stats?"+new URLSearchParams({days:String(statsState.days),tz}).toString());
    if(requestId!==statsState.requestId)return;
    const cards=Number(d.cards||0),reviews=Number(d.reviews||0);
    const accuracy=d.quizAccuracy==null?"—":d.quizAccuracy+"%";
    $("homeCards").textContent=cards;
    $("homeReviews").textContent=reviews;
    $("homeAccuracy").textContent=accuracy;
    $("statCards").textContent=cards.toLocaleString("zh-CN");
    $("statReviews").textContent=reviews.toLocaleString("zh-CN");
    $("statAccuracy").textContent=accuracy;
    $("statCardsHint").textContent=Number(d.studiedCards||0)+" 张至少完成过一次复习";
    $("statReviewsHint").textContent="包含普通复习和 AI 测试";
    $("statAccuracyHint").textContent=Number(d.quizTotal||0)+" 次已判分 AI 测试";
    $("statsRangeLabel").textContent="近 "+statsState.days+" 天学习次数";
    const previous=Number(d.previousPeriodReviews||0),current=Number(d.periodReviews||0);
    $("statLast7").textContent=current.toLocaleString("zh-CN");
    const change=current-previous;
    $("statLast7Hint").textContent=previous===0
      ?(current===0?"本期和上期均无记录":"上期无记录，本期新增 "+current+" 次")
      :(change===0?"与上期持平":(change>0?"比上期增加 ":"比上期减少 ")+Math.round(Math.abs(change)/previous*100)+"%");
    $("statsTrendTitle").textContent="近 "+statsState.days+" 天复习趋势";
    $("statsTrendSummary").textContent="日均 "+(current/statsState.days).toFixed(1)+" 次 · "+Number(d.activeDays||0)+" 个活跃日";
    const today=Math.max(0,Number(d.todayReviews||0)),goal=Math.max(1,Number(d.dailyGoal||20));
    const pct=Math.min(100,Math.round(today/goal*100));
    $("statsGoalRing").style.setProperty("--goal-fill",pct+"%");
    $("statsGoalRing").setAttribute("aria-valuenow",String(pct));
    $("statsGoalPercent").textContent=pct+"%";
    $("statsGoalCount").textContent=today+" / "+goal;
    $("statsGoalHint").textContent=today>=goal?"今日目标已达成，继续保持！":"距离今日目标还差 "+(goal-today)+" 次。";
    statsState.categories=d.categories||[];
    renderReviewTrend(d.dailyReviews||[]);
    renderCategoryChart(statsState.categories);
    renderStatsCalendar(d.heatmap||[]);
    renderStatsHighlights(d);
    renderStatsCategories();
    $("statsStatus").textContent="按 "+(d.timeZone||"UTC")+" 日期统计 · 刚刚更新";
  }catch(error){
    if(requestId!==statsState.requestId)return;
    console.error("Failed to load learning statistics:",error);
    $("statsStatus").textContent="加载失败："+(error?.message||"请检查网络")+"。可以点击刷新重试。";
  }finally{
    if(requestId===statsState.requestId&&refresh)refresh.disabled=false;
  }
}

function changeStatsPeriod(days){
  if(![7,30,90].includes(days)||days===statsState.days)return;
  statsState.days=days;
  document.querySelectorAll("[data-stats-period]").forEach(button=>{
    const active=Number(button.dataset.statsPeriod)===days;
    button.classList.toggle("active",active);
    button.setAttribute("aria-pressed",active?"true":"false");
  });
  loadStats();
}

async function loadSettings(){
  settings=await api("/settings");
  $("retentionSetting").value=String(Number(settings.fsrs_retention).toFixed(2));
  $("englishRate").value=String(settings.english_rate||1);
  $("chineseRate").value=String(settings.chinese_rate||1);
  $("ttsRate").value="1";
  $("dailyGoal").value=settings.daily_goal;
  $("reminderTime").value=String(settings.reminder_time||"09:00").slice(0,5);
  $("aiOrganizeProvider").value=settings.ai_organize_provider||"gemini";
  $("aiQuizProvider").value=settings.ai_quiz_provider||"gemini";
  $("aiGradeProvider").value=settings.ai_grade_provider||"gemini";
  $("aiFeynmanProvider").value=settings.ai_feynman_provider||"gemini";
  $("sttProvider").value=settings.stt_provider||"cloudflare";
  $("ocrProvider").value=settings.ocr_provider||"gemini";

  refreshVoices();
  $("englishVoiceStyle").value=localStorage.getItem("memorycast_en_voice_style")||"smart";
  $("chineseVoiceStyle").value=localStorage.getItem("memorycast_zh_voice_style")||"smart";
  updatePushUi();
}
async function saveSettings(){
  settings=await api("/settings",{method:"PUT",body:JSON.stringify({
    fsrs_retention:Number($("retentionSetting").value),
    english_rate:Number($("englishRate").value),
    chinese_rate:Number($("chineseRate").value),
    daily_goal:Number($("dailyGoal").value),
    wrong_requeue:true,
    reminder_enabled:settings.reminder_enabled===true,
    reminder_time:$("reminderTime").value||"09:00",
    reminder_timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",
    ai_organize_provider:$("aiOrganizeProvider").value,
    ai_quiz_provider:$("aiQuizProvider").value,
    ai_grade_provider:$("aiGradeProvider").value,
    ai_feynman_provider:$("aiFeynmanProvider").value,
    stt_provider:$("sttProvider").value,
    ocr_provider:$("ocrProvider").value
  })});
  updatePushUi();
  alert("设置已保存");
}

function b64ToUint8Array(base64){
  const pad="=".repeat((4-base64.length%4)%4);
  const normalized=(base64+pad).replace(/-/g,"+").replace(/_/g,"/");
  const raw=atob(normalized);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}
function updatePushUi(){
  if(!$("pushToggleBtn"))return;
  const secure=window.isSecureContext;
  $("pushToggleBtn").textContent=settings.reminder_enabled?"关闭推送":"启用推送";
  $("pushStatus").textContent=secure
    ? (settings.reminder_enabled?"已启用；每天 "+String(settings.reminder_time||"09:00").slice(0,5)+" 检查 FSRS 到期卡片":"未启用")
    : "当前是 HTTP；绑定域名并开启 HTTPS 后才能启用后台推送";
  $("pushToggleBtn").disabled=!secure;
}
async function enablePush(){
  if(!window.isSecureContext){
    alert("后台推送需要 HTTPS。当前 IP 的 HTTP 页面不能注册系统推送。");
    return;
  }
  if(!("serviceWorker" in navigator)||!("PushManager" in window)){
    alert("当前浏览器不支持 Web Push。");
    return;
  }
  const reg=await navigator.serviceWorker.register("/service-worker.js");
  const permission=await Notification.requestPermission();
  if(permission!=="granted"){alert("需要允许通知权限才能每日推送。");return}
  const key=await api("/push/public-key");
  let sub=await reg.pushManager.getSubscription();
  if(!sub){
    sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToUint8Array(key.publicKey)});
  }
  await api("/push/subscribe",{method:"POST",body:JSON.stringify({subscription:sub.toJSON()})});
  settings=await api("/settings",{method:"PUT",body:JSON.stringify({
    fsrs_retention:Number($("retentionSetting").value),
    english_rate:Number($("englishRate").value),
    chinese_rate:Number($("chineseRate").value),
    daily_goal:Number($("dailyGoal").value),
    wrong_requeue:true,
    reminder_enabled:true,
    reminder_time:$("reminderTime").value||"09:00",
    reminder_timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"
  })});
  updatePushUi();
  alert("每日 FSRS 推送已启用。");
}
async function disablePush(){
  if("serviceWorker" in navigator){
    const reg=await navigator.serviceWorker.getRegistration();
    const sub=reg?await reg.pushManager.getSubscription():null;
    if(sub){
      await api("/push/unsubscribe",{method:"POST",body:JSON.stringify({endpoint:sub.endpoint})});
      await sub.unsubscribe();
    }
  }
  settings=await api("/settings",{method:"PUT",body:JSON.stringify({
    fsrs_retention:Number($("retentionSetting").value),
    english_rate:Number($("englishRate").value),
    chinese_rate:Number($("chineseRate").value),
    daily_goal:Number($("dailyGoal").value),
    wrong_requeue:true,
    reminder_enabled:false,
    reminder_time:$("reminderTime").value||"09:00",
    reminder_timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"
  })});
  updatePushUi();
}
async function togglePush(){
  try{
    if(settings.reminder_enabled) await disablePush();
    else await enablePush();
  }catch(e){alert(e.message)}
}

async function loadWalkmanQueue(){
  const d=await api("/walkman");
  walkmanQueue=d.cards||[];
  walkmanIndex=Math.min(walkmanIndex,Math.max(0,walkmanQueue.length-1));
  return walkmanQueue;
}

function splitWalkmanSubtitle(text=""){
  const clean=String(text||"")
    .replace(/\r/g,"")
    .replace(/\n{2,}/g,"\n\n")
    .replace(/(?<!\n)\n(?!\n)/g," ")
    .replace(/[ \t]+/g," ")
    .trim();
  if(!clean)return [];

  const splitLongClause=clause=>{
    const s=String(clause||"").trim();
    if(!s)return [];

    const zh=(s.match(/[\u3400-\u9fff]/g)||[]).length;
    const en=(s.match(/[A-Za-z]/g)||[]).length;
    const maxChars=zh>=en?34:76;
    if(s.length<=maxChars)return [s];

    // English/mixed text: split only at whitespace boundaries so a word is
    // never cut in half. Technical tokens such as PM2.5 remain intact.
    if(/\s/.test(s)){
      const words=s.split(/\s+/).filter(Boolean);
      const out=[];
      let buf="";
      for(const word of words){
        const next=buf?buf+" "+word:word;
        if(next.length>maxChars && buf){
          out.push(buf);
          buf=word;
        }else{
          buf=next;
        }
      }
      if(buf)out.push(buf);
      return out;
    }

    // Chinese text without spaces: only use fixed-width chunks as a final
    // fallback when there is no natural punctuation boundary at all.
    const out=[];
    for(let i=0;i<s.length;i+=maxChars){
      const part=s.slice(i,i+maxChars).trim();
      if(part)out.push(part);
    }
    return out;
  };

  const splitSentenceFurther=sentence=>{
    const s=String(sentence||"").trim();
    if(!s)return [];

    const zh=(s.match(/[\u3400-\u9fff]/g)||[]).length;
    const en=(s.match(/[A-Za-z]/g)||[]).length;
    const maxSentence=zh>=en?44:96;
    if(s.length<=maxSentence)return [s];

    // Prefer clause boundaries before any length fallback.
    const clauses=(s.match(/[^，,；;：:\n]+[，,；;：:]?/g)||[s])
      .map(x=>x.trim())
      .filter(Boolean);

    const packed=[];
    let buf="";
    for(const clause of clauses){
      const next=buf?buf+" "+clause:clause;
      if(next.length>maxSentence && buf){
        packed.push(buf);
        buf=clause;
      }else{
        buf=next;
      }
    }
    if(buf)packed.push(buf);

    return packed.flatMap(splitLongClause);
  };

  let sentences=[];
  const hasRealBoundary=/[。！？!?]|\n\n/.test(clean);

  if(hasRealBoundary){
    try{
      if(typeof Intl!=="undefined" && Intl.Segmenter){
        const seg=new Intl.Segmenter("zh-CN",{granularity:"sentence"});
        sentences=[...seg.segment(clean)]
          .map(x=>String(x.segment||"").trim())
          .filter(Boolean);
      }
    }catch{}
  }

  if(!sentences.length){
    sentences=hasRealBoundary
      ? (clean.match(/[^。！？!?\n]+[。！？!?]?/g)||[clean])
          .map(x=>x.trim())
          .filter(Boolean)
      : [clean];
  }

  return sentences.flatMap(splitSentenceFurther).filter(Boolean);
}
function shouldMergeWalkmanEnglishFragments(left="",right=""){
  const a=String(left||"").trim();
  const b=String(right||"").trim();
  if(!a||!b)return false;

  // Only merge short English fragments. Never merge across Chinese
  // explanations or already-complete sentences.
  if(/[\u3400-\u9fff]/.test(a+b))return false;
  if(/[.!?。！？]["'”’)]*$/.test(a))return false;
  if((a+" "+b).length>90)return false;

  const aWords=a.split(/\s+/).filter(Boolean);
  const bWords=b.split(/\s+/).filter(Boolean);
  if(!aWords.length||!bWords.length)return false;

  const tail=String(aWords[aWords.length-1]||"").toLowerCase().replace(/[^a-z']/g,"");
  const continuationWords=new Set([
    "a","an","the","to","of","in","on","at","for","with","from","by","and","or","but",
    "have","has","had","am","is","are","was","were","be","been","being",
    "do","does","did","can","could","will","would","shall","should","may","might","must",
    "this","that","these","those","my","your","his","her","our","their","some","any"
  ]);

  // Strong signal: the left side ends in a word that normally requires
  // continuation ("I have a" + "cold", "go with" + "friends").
  if(continuationWords.has(tail))return true;

  // Also merge very short title-like fragments when the right side begins
  // lowercase and neither side looks like a standalone sentence.
  if(aWords.length<=4 && bWords.length<=4 && /^[a-z]/.test(b))return true;

  return false;
}

function walkmanSegments(card){
  if(!card)return [];

  const fields=[card.front,card.back,card.example]
    .map(x=>String(x||"").replace(/\s+/g," ").trim())
    .filter(Boolean);

  const merged=[];
  for(const field of fields){
    if(merged.length && shouldMergeWalkmanEnglishFragments(merged[merged.length-1],field)){
      merged[merged.length-1]=(merged[merged.length-1]+" "+field).replace(/\s+/g," ").trim();
    }else{
      merged.push(field);
    }
  }

  return merged
    .flatMap(x=>splitWalkmanSubtitle(x))
    .filter(Boolean);
}

function renderWalkmanLyrics(lines=[],activeIndex=0){
  const track=$("walkmanSubtitle");
  if(!track)return;

  if(!lines.length){
    track.innerHTML='<div class="walkman-lyric active">准备播放</div>';
    return;
  }

  track.innerHTML=lines.map((line,i)=>
    '<div class="walkman-lyric'+(i===activeIndex?' active':'')+'" data-lyric-index="'+i+'">'+esc(line)+'</div>'
  ).join("");

  const active=track.querySelector('[data-lyric-index="'+activeIndex+'"]');
  if(active){
    requestAnimationFrame(()=>{
      active.scrollIntoView({block:"center",behavior:"smooth"});
    });
  }
}

function setWalkmanLyricIndex(lines,index){
  const track=$("walkmanSubtitle");
  if(!track)return;
  const items=[...track.querySelectorAll(".walkman-lyric")];
  items.forEach((el,i)=>el.classList.toggle("active",i===index));
  const active=items[index];
  if(active)active.scrollIntoView({block:"center",behavior:"smooth"});
}

function showWalkmanSubtitle(text){
  renderWalkmanLyrics([String(text||"")],0);
}

function isAppleWatchLike(){
  const ua=String(navigator.userAgent||"");
  const watchUa=/Apple Watch|WatchOS|watchOS/i.test(ua);
  const tinyScreen=window.matchMedia
    ? window.matchMedia("(max-width:260px), (max-height:330px) and (max-width:340px)").matches
    : Math.min(screen.width||999,screen.height||999)<=260;
  return watchUa||tinyScreen;
}

function walkmanChunkGroups(lines=[]){
  const groups=[];
  let current=[];
  let chars=0;
  const watch=isAppleWatchLike();

  for(const line of lines){
    const text=String(line||"").trim();
    if(!text)continue;
    const len=text.length;

    // Apple Watch gets one subtitle line per audio chunk to minimize
    // synthesis, transfer, Blob allocation, and decode latency.
    const shouldFlush=watch
      ? current.length>=1
      : current.length>=2 || (chars+len>180 && current.length>0);

    if(shouldFlush){
      groups.push(current);
      current=[];
      chars=0;
    }

    current.push(text);
    chars+=len;
  }

  if(current.length)groups.push(current);
  return groups;
}

function walkmanAudioFormat(){
  // Use AAC/M4A for the Watch video-element path and existing non-Watch path.
  return "aac";
}

function watchDiag(message){
  if(!isAppleWatchLike())return;
  try{
    if(!watchDiagEl){
      watchDiagEl=document.createElement("div");
      watchDiagEl.id="watchAudioDiag";
      watchDiagEl.style.cssText="position:fixed;left:4px;right:4px;bottom:4px;z-index:99999;font:10px/1.25 monospace;background:rgba(0,0,0,.78);color:#fff;padding:5px 6px;border-radius:6px;max-height:42vh;overflow:auto;white-space:pre-wrap;";
      document.body.appendChild(watchDiagEl);
    }
    const ts=new Date().toLocaleTimeString();
    watchDiagEl.textContent=(watchDiagEl.textContent?watchDiagEl.textContent+"\n":"")+ts+" "+message;
    watchDiagEl.scrollTop=watchDiagEl.scrollHeight;
  }catch{}
}

function watchDirectMp3Link(url){
  if(!isAppleWatchLike()||!url)return;
  try{
    let a=document.getElementById("watchDirectAudioLink");
    if(!a){
      a=document.createElement("a");
      a.id="watchDirectAudioLink";
      a.textContent="▶ 直接打开 MP3";
      a.style.cssText="position:fixed;left:6px;right:6px;top:72px;z-index:100000;display:block;text-align:center;padding:10px 8px;border-radius:10px;background:#fff;color:#000;font:600 13px/1.2 system-ui;text-decoration:none;";
      document.body.appendChild(a);
    }
    a.href=url;
  }catch{}
}

function primeAppleWatchAudio(){
  if(!isAppleWatchLike())return;
  const audio=$("globalTtsAudio");
  if(!audio||watchAudioPrimed)return;

  try{
    // Call play() immediately inside the user's tap handler, before any await/fetch.
    // A real silent WAV (not muted audio) keeps the media element activated while
    // the Watch waits for server-side TTS generation.
    audio.pause();
    audio.loop=true;
    audio.src="data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    audio.currentTime=0;
    currentAudio=audio;

    watchDiag("prime play() start");
    const p=audio.play();
    if(p&&typeof p.then==="function"){
      p.then(()=>{
        watchAudioPrimed=true;
        watchDiag("prime play() resolved");
      })
       .catch(err=>{
         watchAudioPrimed=false;
         watchDiag("prime failed "+(err?.name||"")+" "+(err?.message||err));
         console.warn("Apple Watch audio prime failed:",err?.name||"",err?.message||err);
       });
    }else{
      watchAudioPrimed=true;
    }
  }catch(err){
    watchAudioPrimed=false;
    console.warn("Apple Watch audio prime failed:",err?.name||"",err?.message||err);
  }
}

function walkmanChunkKey(card,chunkIndex,lines){
  return [
    card?.id||"",
    chunkIndex,
    walkmanRate,
    Number(settings.english_rate||1),
    Number(settings.chinese_rate||1),
    localStorage.getItem("memorycast_en_voice_style")||"smart",
    localStorage.getItem("memorycast_zh_voice_style")||"smart",
    walkmanAudioFormat(),
    lines.join("\n")
  ].join("|");
}

function trimWalkmanAudioCache(){
  // Keep Watch memory pressure low; iPhone/desktop can retain a larger queue.
  const maxEntries=isAppleWatchLike()?4:12;
  while(walkmanAudioCache.size>maxEntries){
    const first=walkmanAudioCache.keys().next().value;
    walkmanAudioCache.delete(first);
  }
}

function decodeBase64UrlText(value=""){
  if(!value)return "";
  const normalized=String(value).replace(/-/g,"+").replace(/_/g,"/");
  const padded=normalized+"=".repeat((4-normalized.length%4)%4);
  const bytes=Uint8Array.from(atob(padded),c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function requestWalkmanChunk(card,chunkIndex,lines){
  const payloadLines=lines.map(line=>({
    parts:splitByLanguage(line).map(part=>({
      text:part.text,
      language:part.lang,
      style:voiceStyleName(part.lang),
      rate:(part.lang==="zh-CN"
        ? Number(settings.chinese_rate||1.0)
        : Number(settings.english_rate||1.0))*walkmanRate
    }))
  }));

  const watch=isAppleWatchLike();
  const res=await fetch("/api/tts/timed",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      lines:payloadLines,
      format:walkmanAudioFormat(),
      delivery:watch?"video":"binary"
    })
  });
  if(!res.ok)throw new Error("Timed Walkman TTS HTTP "+res.status);

  if(watch){
    const data=await res.json();
    return {
      url:String(data.audioUrl||""),
      timings:Array.isArray(data.timings)?data.timings:[],
      cacheHit:data.cacheHit===true
    };
  }

  let timings=[];
  try{
    const raw=res.headers.get("X-MemoryCast-Timings")||"";
    timings=raw?JSON.parse(decodeBase64UrlText(raw)):[];
  }catch(err){
    console.warn("Timed TTS header parse failed:",err?.message||err);
  }

  return {
    blob:await res.blob(),
    timings:Array.isArray(timings)?timings:[],
    cacheHit:(res.headers.get("X-MemoryCast-TTS-Cache")||"").toUpperCase()==="HIT"
  };
}

function prefetchWalkmanChunk(card,chunkIndex,lines){
  if(!card||!lines?.length||!ttsInfoState.enabled)return Promise.resolve(null);

  const key=walkmanChunkKey(card,chunkIndex,lines);
  if(walkmanAudioCache.has(key))return Promise.resolve(walkmanAudioCache.get(key));
  if(walkmanPrefetch.has(key))return walkmanPrefetch.get(key);

  const promise=requestWalkmanChunk(card,chunkIndex,lines)
    .then(media=>{
      walkmanPrefetch.delete(key);
      if(media){
        walkmanAudioCache.set(key,media);
        trimWalkmanAudioCache();
      }
      return media;
    })
    .catch(err=>{
      walkmanPrefetch.delete(key);
      console.warn("Walkman chunk prefetch failed:",err?.message||err);
      return null;
    });

  walkmanPrefetch.set(key,promise);
  return promise;
}

async function getWalkmanChunk(card,chunkIndex,lines){
  const key=walkmanChunkKey(card,chunkIndex,lines);
  if(walkmanAudioCache.has(key))return walkmanAudioCache.get(key);
  return await prefetchWalkmanChunk(card,chunkIndex,lines);
}

async function playWalkmanChunk(card,chunkIndex,lines,globalStartIndex,allLines){
  const generation=ttsPlaybackGeneration;
  watchDiag("chunk request start "+chunkIndex);
  const media=await getWalkmanChunk(card,chunkIndex,lines);
  watchDiag("chunk response "+chunkIndex+" url="+Boolean(media?.url)+" blob="+Boolean(media?.blob));
  if((!media?.blob&&!media?.url)||generation!==ttsPlaybackGeneration||!walkmanPlaying)return false;

  const audio=$("globalTtsAudio");
  if(!audio)return false;

  if(currentTtsObjectUrl){
    try{URL.revokeObjectURL(currentTtsObjectUrl)}catch{}
  }

  let url="";
  if(media.url){
    url=media.url;
    currentTtsObjectUrl=null;
    if(isAppleWatchLike())watchDirectMp3Link(url);
  }else{
    url=URL.createObjectURL(media.blob);
    currentTtsObjectUrl=url;
  }
  currentAudio=audio;
  audio.loop=false;
  audio.pause();
  audio.src=url;
  watchDiag("set src "+url);
  audio.load();
  watchDiag("after load ready="+audio.readyState+" network="+audio.networkState);

  const resumeThisChunk=walkmanResumePending && chunkIndex===walkmanChunkIndex;
  const resumeAt=resumeThisChunk?Math.max(0,Number(walkmanChunkTime||0)):0;
  audio.currentTime=0;

  const exactTimings=(media.timings||[])
    .map(x=>{
      const index=Number(x.index||0);
      const spokenOffset=Number(x.offsetMs);
      const bookmarkOffset=Number(x.bookmarkOffsetMs);
      const hasRealWord=Boolean(String(x.firstWord||"").trim());

      // HTMLAudioElement.currentTime can run slightly ahead of what the user
      // actually hears because of decode/output buffering. Real word
      // boundaries need a small listening compensation; bookmark fallbacks
      // get a larger conservative delay. The first line of every later chunk
      // gets an extra handoff guard so it never appears while waiting.
      const base=hasRealWord && Number.isFinite(spokenOffset)
        ? spokenOffset+180
        : (Number.isFinite(bookmarkOffset)?bookmarkOffset:spokenOffset)+340;
      const handoffGuard=index===0 && chunkIndex>0 ? 140 : 0;

      return {
        index,
        offsetMs:base+handoffGuard,
        hasRealWord
      };
    })
    .filter(x=>Number.isFinite(x.offsetMs))
    .sort((x,y)=>x.offsetMs-y.offsetMs);

  // Do not move to the next chunk's first lyric until the audio element is
  // actually playing and the real first-word boundary has been crossed.
  let localActive=-1;
  let audioHasStarted=false;

  const syncLyrics=()=>{
    if(!audioHasStarted || audio.paused || audio.readyState<2)return;

    const nowMs=audio.currentTime*1000;
    let idx=-1;

    for(const item of exactTimings){
      if(item.offsetMs<=nowMs)idx=item.index;
      else break;
    }

    if(idx<0)return;
    idx=Math.max(0,Math.min(lines.length-1,idx));

    if(idx!==localActive){
      localActive=idx;
      walkmanGlobalLineIndex=globalStartIndex+idx;
      setWalkmanLyricIndex(allLines,walkmanGlobalLineIndex);
    }
  };

  await new Promise((resolve,reject)=>{
    audio.ontimeupdate=()=>{
      walkmanChunkIndex=chunkIndex;
      walkmanChunkTime=audio.currentTime||0;
      syncLyrics();
    };
    audio.onloadedmetadata=()=>watchDiag("loadedmetadata dur="+audio.duration);
    audio.oncanplay=()=>watchDiag("canplay ready="+audio.readyState);
    audio.onwaiting=()=>watchDiag("waiting ready="+audio.readyState+" network="+audio.networkState);
    audio.onstalled=()=>watchDiag("stalled network="+audio.networkState);
    audio.onsuspend=()=>watchDiag("suspend network="+audio.networkState);
    audio.onplaying=()=>{
      watchDiag("playing current="+audio.currentTime);
      audioHasStarted=true;
      if(walkmanPlaying && $("walkmanPlayBtn"))$("walkmanPlayBtn").textContent="⏸";
      if(resumeThisChunk && resumeAt>0 && Number.isFinite(audio.duration)){
        audio.currentTime=Math.min(resumeAt,Math.max(0,audio.duration-.05));
      }
      walkmanResumePending=false;
    };
    audio.onended=()=>{
      watchDiag("ended");
      resolve();
    };
    audio.onerror=()=>{
      const e=audio.error;
      watchDiag("audio error code="+(e?.code||0)+" msg="+(e?.message||"")+" ready="+audio.readyState+" network="+audio.networkState);
      reject(new Error("随身听音频播放失败"));
    };
    watchDiag("real play() call ready="+audio.readyState+" network="+audio.networkState);
    const p=audio.play();
    if(p&&typeof p.then==="function"){
      p.then(()=>watchDiag("real play() resolved"))
       .catch(err=>{
         watchDiag("real play() rejected "+(err?.name||"")+" "+(err?.message||err));
         reject(err);
       });
    }
  }).catch(err=>console.warn(err.message));

  audio.ontimeupdate=null;
  audio.onloadedmetadata=null;
  audio.oncanplay=null;
  audio.onwaiting=null;
  audio.onstalled=null;
  audio.onsuspend=null;
  audio.onplaying=null;
  audio.onended=null;
  audio.onerror=null;

  if(currentTtsObjectUrl===url){
    try{URL.revokeObjectURL(url)}catch{}
    currentTtsObjectUrl=null;
  }
  audio.removeAttribute("src");
  audio.load();
  currentAudio=null;

  return generation===ttsPlaybackGeneration&&walkmanPlaying;
}

function getWatchAudioContext(){
  if(watchAudioContext)return watchAudioContext;
  const Ctx=window.AudioContext||window.webkitAudioContext;
  if(!Ctx)return null;
  try{
    watchAudioContext=new Ctx();
    return watchAudioContext;
  }catch{
    return null;
  }
}

function unlockWatchWebAudio(){
  if(!isAppleWatchLike())return;
  const ctx=getWatchAudioContext();
  if(!ctx)return;
  try{
    if(ctx.state==="suspended"){
      const p=ctx.resume();
      if(p&&typeof p.catch==="function")p.catch(()=>{});
    }

    // watchOS may report an AudioContext as running without actually opening
    // an audible output route. Start a tiny silent Web Audio source directly
    // inside the user's Walkman tap so the output pipeline is activated while
    // user activation is still valid.
    const buffer=ctx.createBuffer(1,1,Math.max(8000,ctx.sampleRate||44100));
    const source=ctx.createBufferSource();
    source.buffer=buffer;
    source.connect(ctx.destination);
    source.start(0);
  }catch{}
}

function watchWebAudioKey(card,chunkIndex,lines){
  return [
    card?.id||"",
    chunkIndex,
    walkmanRate,
    Number(settings.english_rate||1),
    Number(settings.chinese_rate||1),
    localStorage.getItem("memorycast_en_voice_style")||"smart",
    localStorage.getItem("memorycast_zh_voice_style")||"smart",
    lines.join("\n")
  ].join("|");
}

function trimWatchWebAudioCache(){
  while(watchWebAudioCache.size>4){
    const first=watchWebAudioCache.keys().next().value;
    watchWebAudioCache.delete(first);
  }
}

async function requestWatchWebAudioChunk(card,chunkIndex,lines){
  const payloadLines=lines.map(line=>({
    parts:splitByLanguage(line).map(part=>({
      text:part.text,
      language:part.lang,
      style:voiceStyleName(part.lang),
      rate:(part.lang==="zh-CN"
        ? Number(settings.chinese_rate||1.0)
        : Number(settings.english_rate||1.0))*walkmanRate
    }))
  }));

  const res=await fetch("/api/tts/timed",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      lines:payloadLines,
      format:"mp3",
      delivery:"binary"
    })
  });
  if(!res.ok)throw new Error("Watch WebAudio TTS HTTP "+res.status);

  let timings=[];
  try{
    const raw=res.headers.get("X-MemoryCast-Timings")||"";
    timings=raw?JSON.parse(decodeBase64UrlText(raw)):[];
  }catch{}

  return {
    buffer:await res.arrayBuffer(),
    timings:Array.isArray(timings)?timings:[]
  };
}

async function prepareWatchWebAudioChunk(card,chunkIndex,lines){
  const key=watchWebAudioKey(card,chunkIndex,lines);
  if(watchWebAudioCache.has(key))return watchWebAudioCache.get(key);
  if(watchWebAudioPending.has(key))return await watchWebAudioPending.get(key);

  const ctx=getWatchAudioContext();
  if(!ctx)return null;

  const promise=(async()=>{
    try{
      const media=await requestWatchWebAudioChunk(card,chunkIndex,lines);
      const decoded=await ctx.decodeAudioData(media.buffer.slice(0));
      const prepared={decoded,timings:media.timings||[]};
      watchWebAudioCache.set(key,prepared);
      trimWatchWebAudioCache();
      return prepared;
    }finally{
      watchWebAudioPending.delete(key);
    }
  })();

  watchWebAudioPending.set(key,promise);
  return await promise;
}

async function playWalkmanWatchWebAudio(card){
  const ctx=getWatchAudioContext();
  if(!ctx)return false;

  const lines=walkmanSegments(card);
  if(!lines.length)return false;
  renderWalkmanLyrics(lines,0);

  const generation=ttsPlaybackGeneration;
  const groups=walkmanChunkGroups(lines);
  let globalStart=0;

  try{
    if(ctx.state==="suspended")await ctx.resume();
  }catch{
    return false;
  }

  for(let i=0;i<groups.length;i++){
    if(!walkmanPlaying||generation!==ttsPlaybackGeneration)return false;

    let media;
    try{
      media=await requestWatchWebAudioChunk(card,i,groups[i]);
    }catch{
      return false;
    }

    let decoded;
    try{
      // Safari implementations may detach the passed ArrayBuffer.
      decoded=await ctx.decodeAudioData(media.buffer.slice(0));
    }catch{
      return false;
    }

    const source=ctx.createBufferSource();
    source.buffer=decoded;
    source.connect(ctx.destination);
    watchAudioSource=source;

    const exactTimings=(media.timings||[])
      .map(x=>({
        index:Number(x.index||0),
        offsetMs:Number.isFinite(Number(x.offsetMs))
          ? Number(x.offsetMs)
          : Number(x.bookmarkOffsetMs||0)
      }))
      .filter(x=>Number.isFinite(x.offsetMs))
      .sort((a,b)=>a.offsetMs-b.offsetMs);

    const startedAt=ctx.currentTime;
    setWalkmanLyricIndex(lines,globalStart);

    const ok=await new Promise(resolve=>{
      let done=false;
      const finish=value=>{
        if(done)return;
        done=true;
        clearInterval(timer);
        resolve(value);
      };

      const timer=setInterval(()=>{
        if(!walkmanPlaying||generation!==ttsPlaybackGeneration){
          try{source.stop()}catch{}
          finish(false);
          return;
        }

        const elapsed=(ctx.currentTime-startedAt)*1000;
        let local=0;
        for(const t of exactTimings){
          if(elapsed>=t.offsetMs)local=t.index;
          else break;
        }
        setWalkmanLyricIndex(lines,Math.min(lines.length-1,globalStart+local));
      },80);

      source.onended=()=>finish(true);

      try{
        source.start(0);
      }catch{
        finish(false);
      }
    });

    if(watchAudioSource===source)watchAudioSource=null;
    if(!ok)return false;
    globalStart+=groups[i].length;
  }

  return generation===ttsPlaybackGeneration&&walkmanPlaying;
}

function getWatchVideoElement(){
  let video=document.getElementById("watchWalkmanVideo");
  if(video)return video;

  video=document.createElement("video");
  video.id="watchWalkmanVideo";
  video.setAttribute("playsinline","");
  video.setAttribute("webkit-playsinline","");
  video.preload="auto";
  video.controls=false;
  video.muted=false;
  video.volume=1;
  video.style.cssText="position:fixed;width:2px;height:2px;left:1px;top:1px;opacity:.02;pointer-events:none;z-index:1;";
  document.body.appendChild(video);
  return video;
}

async function playWalkmanWatchVideo(card){
  const lines=walkmanSegments(card);
  if(!lines.length)return false;

  renderWalkmanLyrics(lines,0);
  const generation=ttsPlaybackGeneration;
  const groups=walkmanChunkGroups(lines);
  if(!groups.length)return false;

  let globalStart=0;

  for(let i=0;i<groups.length;i++){
    if(!walkmanPlaying||generation!==ttsPlaybackGeneration)return false;

    const key=walkmanChunkKey(card,i,groups[i]);
    let media=null;
    const usingInitial=i===0 &&
      watchInitialVideoStarted &&
      watchPreparedFirstMedia?.url &&
      watchPreparedFirstKey===key;

    if(usingInitial){
      media=watchPreparedFirstMedia;
    }else{
      media=await getWalkmanChunk(card,i,groups[i]);
    }
    if(!media?.url)return false;

    const video=getWatchVideoElement();
    if(!usingInitial){
      video.pause();
      video.src=media.url;
      video.load();
    }

    const exactTimings=(media.timings||[])
      .map(x=>{
        const offset=Number.isFinite(Number(x.offsetMs))
          ? Number(x.offsetMs)
          : Number(x.bookmarkOffsetMs||0);
        return {index:Number(x.index||0),offsetMs:offset};
      })
      .filter(x=>Number.isFinite(x.offsetMs))
      .sort((a,b)=>a.offsetMs-b.offsetMs);

    setWalkmanLyricIndex(lines,globalStart);

    const ok=await new Promise(resolve=>{
      const sync=()=>{
        const ms=(video.currentTime||0)*1000;
        let local=0;
        for(const t of exactTimings){
          if(ms>=t.offsetMs)local=t.index;
          else break;
        }
        setWalkmanLyricIndex(lines,Math.min(lines.length-1,globalStart+local));
      };

      video.ontimeupdate=sync;
      video.onplaying=()=>{
        if($("walkmanPlayBtn"))$("walkmanPlayBtn").textContent="⏸";
      };
      video.onended=()=>resolve(true);
      video.onerror=()=>resolve(false);

      try{
        if(usingInitial){
          if(!video.paused){
            resolve(true);
          }else{
            const p=video.play();
            if(p&&typeof p.catch==="function")p.catch(()=>resolve(false));
          }
        }else{
          const p=video.play();
          if(p&&typeof p.catch==="function")p.catch(()=>resolve(false));
        }
      }catch{
        resolve(false);
      }
    });

    video.ontimeupdate=null;
    video.onplaying=null;
    video.onended=null;
    video.onerror=null;

    if(!ok)return false;
    globalStart+=groups[i].length;
  }

  return generation===ttsPlaybackGeneration&&walkmanPlaying;
}

function watchLineLanguage(text=""){
  const s=String(text||"");
  const zh=(s.match(/[\u3400-\u9fff]/g)||[]).length;
  const en=(s.match(/[A-Za-z]/g)||[]).length;
  return zh>en?"zh-CN":"en-US";
}

function watchPickVoice(lang){
  const voices=speechSynthesis.getVoices?.()||[];
  const target=lang.toLowerCase();
  const base=target.split("-")[0];

  const score=voice=>{
    const vlang=String(voice.lang||"").toLowerCase();
    let s=0;
    if(vlang===target)s+=100;
    else if(vlang.startsWith(base+"-")||vlang===base)s+=60;
    if(voice.localService)s+=20;
    if(/enhanced|premium|natural/i.test(String(voice.name||"")))s+=10;
    if(/compact|espeak/i.test(String(voice.name||"")))s-=15;
    return s;
  };

  return voices
    .map(v=>({v,s:score(v)}))
    .filter(x=>x.s>0)
    .sort((a,b)=>b.s-a.s)[0]?.v||null;
}

function watchSplitMixedSpeech(text=""){
  const s=String(text||"").trim();
  if(!s)return [];

  const out=[];
  let buf="";
  let lang=null;

  const push=()=>{
    const t=buf.trim();
    if(t)out.push({text:t,lang:lang||watchLineLanguage(t)});
    buf="";
  };

  for(const ch of s){
    let nextLang=lang;
    if(/[\u3400-\u9fff]/.test(ch))nextLang="zh-CN";
    else if(/[A-Za-z0-9]/.test(ch))nextLang="en-US";

    // Spaces and punctuation stay attached to the active run so transitions
    // remain smooth instead of producing tiny isolated utterances.
    if(lang && nextLang && nextLang!==lang){
      push();
    }
    if(nextLang)lang=nextLang;
    buf+=ch;
  }
  push();

  // Merge tiny punctuation-only artifacts into neighbors.
  return out.filter(x=>x.text);
}

function watchSpeakPart(part){
  return new Promise(resolve=>{
    const utterance=new SpeechSynthesisUtterance(part.text);
    utterance.lang=part.lang;

    const voice=watchPickVoice(part.lang);
    if(voice)utterance.voice=voice;

    const baseRate=part.lang==="zh-CN"
      ? Number(settings.chinese_rate||1.0)
      : Number(settings.english_rate||1.0);

    // Slightly relax the Watch browser TTS pace. It sounds less robotic than
    // driving the system voice at the same aggressive rate as server TTS.
    const naturalFactor=part.lang==="zh-CN"?0.92:0.96;
    utterance.rate=Math.max(0.72,Math.min(1.45,baseRate*walkmanRate*naturalFactor));
    utterance.pitch=part.lang==="zh-CN"?1.0:0.98;
    utterance.volume=1;

    utterance.onstart=()=>{
      if($("walkmanPlayBtn"))$("walkmanPlayBtn").textContent="⏸";
    };
    utterance.onend=()=>resolve(true);
    utterance.onerror=()=>resolve(false);

    try{
      speechSynthesis.speak(utterance);
    }catch{
      resolve(false);
    }
  });
}

async function playWalkmanWatchBrowserTts(card){
  const lines=walkmanSegments(card);
  if(!lines.length)return false;

  renderWalkmanLyrics(lines,0);
  try{speechSynthesis.cancel()}catch{}

  const generation=ttsPlaybackGeneration;

  for(let i=0;i<lines.length;i++){
    if(!walkmanPlaying||generation!==ttsPlaybackGeneration)return false;

    const text=String(lines[i]||"").trim();
    if(!text)continue;

    setWalkmanLyricIndex(lines,i);

    const parts=watchSplitMixedSpeech(text);
    for(let p=0;p<parts.length;p++){
      if(!walkmanPlaying||generation!==ttsPlaybackGeneration)return false;
      const ok=await watchSpeakPart(parts[p]);
      if(!ok)return false;

      // Keep language handoffs tight, but not abrupt.
      if(p<parts.length-1){
        await new Promise(r=>setTimeout(r,25));
      }
    }

    if(i<lines.length-1){
      await new Promise(r=>setTimeout(r,55));
    }
  }

  return generation===ttsPlaybackGeneration&&walkmanPlaying;
}

async function playWalkmanContinuousCard(card){
  const lines=walkmanSegments(card);
  if(!lines.length)return false;

  renderWalkmanLyrics(lines,0);
  if(!ttsInfoState.enabled)return false;

  const groups=walkmanChunkGroups(lines);
  if(!groups.length)return false;

  // Only the first small chunk blocks startup.
  prefetchWalkmanChunk(card,0,groups[0]);

  let startChunk=walkmanResumePending?Math.max(0,Math.min(groups.length-1,walkmanChunkIndex)):0;
  let globalStart=0;
  for(let j=0;j<startChunk;j++)globalStart+=groups[j].length;

  for(let i=startChunk;i<groups.length;i++){
    if(!walkmanPlaying)return false;

    // Generate the next chunk while the current one is playing.
    if(i+1<groups.length){
      prefetchWalkmanChunk(card,i+1,groups[i+1]);
    }else if(walkmanQueue.length>1){
      const nextCard=walkmanQueue[(walkmanIndex+1)%walkmanQueue.length];
      const nextGroups=walkmanChunkGroups(walkmanSegments(nextCard));
      if(nextGroups[0])prefetchWalkmanChunk(nextCard,0,nextGroups[0]);
    }

    const ok=await playWalkmanChunk(card,i,groups[i],globalStart,lines);
    if(!ok)return false;
    globalStart+=groups[i].length;
  }

  walkmanChunkIndex=0;
  walkmanChunkTime=0;
  walkmanGlobalLineIndex=0;
  walkmanResumePending=false;
  return walkmanPlaying;
}

function pauseWalkman(){
  if(!walkmanPlaying)return;
  walkmanPlaying=false;
  walkmanPaused=true;

  if(currentAudio && !currentAudio.paused){
    walkmanChunkTime=currentAudio.currentTime||walkmanChunkTime||0;
    currentAudio.pause();
  }

  // Keep the currently highlighted lyric exactly as-is.
  if($("walkmanPlayBtn"))$("walkmanPlayBtn").textContent="▶";
}

function stopWalkman(){
  walkmanPlaying=false;
  if(watchAudioSource){
    try{watchAudioSource.stop()}catch{}
    watchAudioSource=null;
  }
  walkmanPaused=false;
  walkmanResumePending=false;
  walkmanRepeatTen=false;
  walkmanRepeatCount=0;
  updateWalkmanRepeatButton();
  walkmanChunkIndex=0;
  walkmanChunkTime=0;
  walkmanGlobalLineIndex=0;
  stopAllTts();
  if($("walkmanPlayBtn"))$("walkmanPlayBtn").textContent="▶";
}

function updateWalkmanRepeatButton(){
  const btn=$("walkmanRepeatBtn");
  if(!btn)return;
  btn.classList.toggle("active",walkmanRepeatTen);
  btn.setAttribute("aria-pressed",walkmanRepeatTen?"true":"false");
  btn.textContent=walkmanRepeatTen
    ? "↻ "+Math.min(10,walkmanRepeatCount+1)+"/10"
    : "↻ ×10";
}

function resetWalkmanPosition(){
  walkmanChunkIndex=0;
  walkmanChunkTime=0;
  walkmanGlobalLineIndex=0;
  walkmanResumePending=false;
}

function scheduleWalkmanAfterCard(delay=160){
  if(!walkmanPlaying)return;

  resetWalkmanPosition();

  if(walkmanRepeatTen){
    walkmanRepeatCount++;
    if(walkmanRepeatCount<10){
      updateWalkmanRepeatButton();
      setTimeout(()=>{if(walkmanPlaying)playWalkmanCurrent()},delay);
      return;
    }

    // Keep repeat mode enabled for every subsequent card.
    // Reset only the per-card count after ten complete plays.
    walkmanRepeatCount=0;
    updateWalkmanRepeatButton();
  }else{
    walkmanRepeatCount=0;
  }

  walkmanIndex=(walkmanIndex+1)%walkmanQueue.length;
  setTimeout(()=>{if(walkmanPlaying)playWalkmanCurrent()},delay);
}

function toggleWalkmanRepeatTen(){
  walkmanRepeatTen=!walkmanRepeatTen;
  walkmanRepeatCount=0;
  updateWalkmanRepeatButton();
}

async function playWalkmanCurrent(){
  if(!walkmanPlaying)return;
  const card=walkmanQueue[walkmanIndex];
  if(!card){
    stopWalkman();
    return;
  }

  const segments=walkmanSegments(card);
  if(!segments.length){
    walkmanIndex=(walkmanIndex+1)%walkmanQueue.length;
    setTimeout(playWalkmanCurrent,100);
    return;
  }

  // Apple Watch: use Web Audio first. This bypasses HTMLAudioElement /
  // HTMLVideoElement entirely while preserving the server's natural TTS.
  if(isAppleWatchLike()){
    const webAudioPlayed=await playWalkmanWatchWebAudio(card);
    if(webAudioPlayed){
      scheduleWalkmanAfterCard(120);
      return;
    }

    const spoken=await playWalkmanWatchBrowserTts(card);
    if(spoken){
      scheduleWalkmanAfterCard(120);
      return;
    }
    if(!walkmanPlaying)return;
  }

  // Other devices keep the existing server-generated audio path unchanged.
  const continuous=await playWalkmanContinuousCard(card);
  if(continuous){
    scheduleWalkmanAfterCard(250);
    return;
  }

  if(!walkmanPlaying)return;

  // Browser-TTS / oversized-card fallback: still preserve lyric scrolling.
  renderWalkmanLyrics(segments,0);
  const run=i=>{
    if(!walkmanPlaying)return;
    if(i>=segments.length){
      scheduleWalkmanAfterCard(300);
      return;
    }
    setWalkmanLyricIndex(segments,i);
    speakOne(segments[i],()=>{
      if(!walkmanPlaying)return;
      setTimeout(()=>run(i+1),100);
    });
  };
  run(0);
}
async function toggleWalkmanPlayback(){
  // On watchOS/WebKit, media playback must be activated directly by the tap.
  // Do this before any queue/TTS await so the gesture is not lost.
  if(!walkmanPlaying && isAppleWatchLike())primeAppleWatchAudio();

  if(walkmanPlaying){
    pauseWalkman();
    return;
  }

  // True pause/resume: keep the same audio element, object URL, currentTime
  // and lyric state. No Azure request and no chunk restart.
  if(walkmanPaused && currentAudio && currentAudio.src){
    try{
      walkmanPlaying=true;
      walkmanPaused=false;
      $("walkmanPlayBtn").textContent="⏸";
      await currentAudio.play();
      return;
    }catch(err){
      walkmanPlaying=false;
      walkmanPaused=true;
      $("walkmanPlayBtn").textContent="▶";
      console.warn("Walkman resume failed:",err?.message||err);
      return;
    }
  }

  if(!walkmanQueue.length){
    try{await loadWalkmanQueue()}catch(e){alert(e.message);return}
  }
  if(!walkmanQueue.length){
    alert("还没有可播放的学习内容。");
    return;
  }

  // If pause happened during a tiny between-chunk loading gap, resume from
  // the saved chunk state rather than jumping back to the card beginning.
  if(walkmanPaused){
    walkmanPlaying=true;
    walkmanPaused=false;
    walkmanResumePending=true;
    $("walkmanPlayBtn").textContent="…";
    playWalkmanCurrent();
    return;
  }

  stopAllTts();
  walkmanPlaying=true;
  walkmanPaused=false;
  $("walkmanPlayBtn").textContent="…";

  const current=walkmanQueue[walkmanIndex];
  const currentGroups=current?walkmanChunkGroups(walkmanSegments(current)):[];
  const firstKey=current&&currentGroups[0]?walkmanChunkKey(current,0,currentGroups[0]):"";
  const lyricTrack=$("walkmanSubtitle");

  if(lyricTrack && firstKey && !walkmanAudioCache.has(firstKey)){
    lyricTrack.innerHTML='<div class="walkman-lyric active">正在准备语音…</div>';
  }

  if(current&&currentGroups[0]&&!walkmanAudioCache.has(firstKey)){
    prefetchWalkmanChunk(current,0,currentGroups[0]);
  }

  setTimeout(()=>{
    if(walkmanPlaying)$("walkmanPlayBtn").textContent="⏸";
  },120);

  playWalkmanCurrent();
}
async function enterWalkmanMode(){
  stopAllTts();

  const watch=isAppleWatchLike();

  // Resume the Web Audio context immediately inside the user's tap.
  if(watch)unlockWatchWebAudio();

  // Important for watchOS: if the first natural-voice MP4 was prepared in the
  // background, start it synchronously inside the user's "随身听" tap before
  // any await/fetch can consume the user activation.
  watchInitialVideoStarted=false;
  if(watch && watchPreparedFirstMedia?.url){
    try{
      const video=getWatchVideoElement();
      video.src=watchPreparedFirstMedia.url;
      video.load();
      const p=video.play();
      watchInitialVideoStarted=true;
      if(p&&typeof p.catch==="function"){
        p.catch(()=>{
          watchInitialVideoStarted=false;
        });
      }
    }catch{
      watchInitialVideoStarted=false;
    }
  }

  walkmanPlaying=false;
  walkmanIndex=0;
  walkmanChunkIndex=0;
  walkmanChunkTime=0;
  walkmanGlobalLineIndex=0;
  walkmanResumePending=false;
  walkmanPaused=false;
  walkmanRepeatTen=false;
  walkmanRepeatCount=0;
  updateWalkmanRepeatButton();
  walkmanRate=Number($("walkmanRate")?.value||1);

  try{
    await loadWalkmanQueue();
  }catch(e){
    alert("随身听队列加载失败："+e.message);
    return;
  }

  document.body.classList.add("walkman");
  $("walkmanMode").classList.remove("hidden");

  const playBtn=$("walkmanPlayBtn");
  if(playBtn){
    playBtn.classList.toggle("hidden",watch);
    playBtn.textContent=watch?"⏸":"▶";
  }

  const initialLines=walkmanQueue.length?walkmanSegments(walkmanQueue[0]):[];
  renderWalkmanLyrics(initialLines.length?initialLines:["暂无可播放内容"],0);

  // Prepare only the first small chunk for fast start.
  if(walkmanQueue[0]){
    const groups=walkmanChunkGroups(walkmanSegments(walkmanQueue[0]));
    if(groups[0])prefetchWalkmanChunk(walkmanQueue[0],0,groups[0]);
  }

  // Apple Watch starts immediately after entering Walkman mode.
  // Other devices retain the existing manual play button behavior.
  if(watch && walkmanQueue.length){
    const direct=document.getElementById("watchDirectAudioLink");
    if(direct)direct.remove();
    if(watchDiagEl){
      watchDiagEl.remove();
      watchDiagEl=null;
    }
    walkmanPlaying=true;
    walkmanPaused=false;
    playWalkmanCurrent();
  }

  // Browser Back exits the minimalist mode without needing another visible button.
  try{history.pushState({memorycastWalkman:true},"",location.href)}catch{}
}

function exitWalkmanMode(){
  stopWalkman();
  document.body.classList.remove("walkman");
  $("walkmanMode").classList.add("hidden");
  const playBtn=$("walkmanPlayBtn");
  if(playBtn)playBtn.classList.remove("hidden");
  const direct=document.getElementById("watchDirectAudioLink");
  if(direct)direct.remove();
  watchInitialVideoStarted=false;
  const video=document.getElementById("watchWalkmanVideo");
  if(video){
    try{video.pause();video.removeAttribute("src");video.load()}catch{}
    video.remove();
  }
  if(watchDiagEl){
    watchDiagEl.remove();
    watchDiagEl=null;
  }
}

function closeMobileNav(){document.body.classList.remove("mobile-nav-open")}
function toggleMobileNav(){document.body.classList.toggle("mobile-nav-open")}
document.querySelectorAll("[data-page]").forEach(b=>b.onclick=()=>{if(b.dataset.skipNextClick)return;go(b.dataset.page);closeMobileNav()});
document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
$("mobileMenuBtn").onclick=toggleMobileNav;
$("sidebarBackdrop").onclick=closeMobileNav;
$("logoutBtn").onclick=async()=>{await api("/auth/logout",{method:"POST"});location.reload()};$("watchBtn").onclick=enterWalkmanMode;
$("snoozeCurrentBtn").onclick=()=>{const c=due[dueIndex];if(c)snoozeCard(c.id,7)};
$("walkmanSnoozeBtn").onclick=()=>{const c=walkmanQueue[walkmanIndex];if(c)snoozeCard(c.id,7)};
$("quizSnoozeBtn").onclick=()=>{const q=quizQuestions[quizIndex];if(q?.cardId)snoozeCard(q.cardId,7)};
$("speakBtn").onclick=toggleSpeak;$("nextCardBtn").onclick=()=>{autoPlay=false;isSpeaking=false;stopAllTts();$("speakBtn").textContent="🔊 朗读";nextDue()};$("loopBtn").onclick=()=>{loop=!loop;$("loopBtn").textContent="↻ 循环："+(loop?"开":"关");if(loop)speakCurrent()};
document.querySelectorAll("[data-rating]").forEach(b=>b.onclick=()=>grade(b.dataset.rating));
$("searchInput").oninput=()=>{libraryPage=1;renderLibrary()};
$("categoryFilter").onchange=()=>{libraryPage=1;renderLibrary()};
$("libraryPrevPage").onclick=()=>{if(libraryPage>1){libraryPage--;renderLibrary()}};
$("libraryNextPage").onclick=()=>{libraryPage++;renderLibrary()};
$("newCardBtn").onclick=openNew;
$("modalClose").onclick=()=>$("modal").classList.add("hidden");$("modalSave").onclick=saveModal;$("organizeBtn").onclick=organize;$("saveGeneratedBtn").onclick=saveGenerated;
$("generateQuizBtn").onclick=()=>generateQuiz();$("submitQuizBtn").onclick=submitQuiz;document.querySelectorAll("[data-confidence]").forEach(b=>b.onclick=()=>setQuizConfidence(b.dataset.confidence));$("nextQuizBtn").onclick=()=>{quizIndex++;renderQuiz()};$("listenQuizBtn").onclick=replayQuizAudio;$("voiceNoteBtn").onclick=toggleVoiceNote;$("photoOcrBtn").onclick=()=>$("photoOcrInput").click();$("photoOcrInput").onchange=e=>handleMediaFiles(e.target.files);setupImportMediaDropPaste();$("feynmanMicBtn").onclick=toggleFeynmanMic;$("submitFeynmanBtn").onclick=submitFeynman;$("clearFeynmanInputBtn").onclick=()=>{$("feynmanInput").value="";feynmanRecognitionBase=""};$("resetFeynmanBtn").onclick=resetFeynman;$("randomFeynmanTopicBtn").onclick=chooseAnotherFeynmanTopic;$("speakFeynmanQuestionBtn").onclick=()=>{if(feynmanLastQuestion)speakOne(feynmanLastQuestion)};$("saveSettingsBtn").onclick=saveSettings;$("pushToggleBtn").onclick=togglePush;$("englishVoice").onchange=()=>localStorage.setItem("memorycast_en_voice",$("englishVoice").value);$("chineseVoice").onchange=()=>localStorage.setItem("memorycast_zh_voice",$("chineseVoice").value);$("englishVoiceStyle").onchange=()=>localStorage.setItem("memorycast_en_voice_style",$("englishVoiceStyle").value);$("chineseVoiceStyle").onchange=()=>localStorage.setItem("memorycast_zh_voice_style",$("chineseVoiceStyle").value);$("noteSearch").oninput=()=>{notePage=1;renderNotes()};
$("notePrevPage").onclick=()=>{if(notePage>1){notePage--;renderNotes()}};
document.querySelectorAll("[data-stats-period]").forEach(button=>button.onclick=()=>changeStatsPeriod(Number(button.dataset.statsPeriod)));
$("statsRefreshBtn").onclick=loadStats;
$("statsCategoryToggle").onclick=()=>{statsState.showAllCategories=!statsState.showAllCategories;renderStatsCategories()};
$("noteNextPage").onclick=()=>{notePage++;renderNotes()};$("speakNoteBtn").onclick=speakSelectedNote;$("markNoteReviewedBtn").onclick=markSelectedNoteReviewed;$("editNoteBtn").onclick=openNoteEdit;$("toggleNoteStudyBtn").onclick=toggleCurrentNoteStudy;$("deleteNoteBtn").onclick=deleteCurrentNote;$("noteModalClose").onclick=()=>$("noteModal").classList.add("hidden");$("noteModalSave").onclick=saveNoteEdit;
$("walkmanPlayBtn").onclick=toggleWalkmanPlayback;$("walkmanRepeatBtn").onclick=toggleWalkmanRepeatTen;$("walkmanRate").onchange=()=>{
  const wasPlaying=walkmanPlaying;
  const wasPaused=walkmanPaused;
  walkmanRate=Number($("walkmanRate").value||1);

  if(isAppleWatchLike()){
    watchWebAudioCache.clear();
    watchWebAudioPending.clear();
  }

  const c=walkmanQueue[walkmanIndex];
  if(c){
    const g=walkmanChunkGroups(walkmanSegments(c));
    const idx=Math.max(0,Math.min(g.length-1,walkmanChunkIndex));
    if(g[idx])prefetchWalkmanChunk(c,idx,g[idx]);
  }

  if(wasPlaying || wasPaused){
    walkmanChunkTime=currentAudio?.currentTime||walkmanChunkTime||0;
    walkmanResumePending=true;
    walkmanPaused=wasPaused;
    walkmanPlaying=wasPlaying;

    stopAllTts();

    if(wasPlaying){
      walkmanPlaying=true;
      walkmanPaused=false;
      setTimeout(()=>{if(walkmanPlaying)playWalkmanCurrent()},80);
    }else{
      // Stay paused at the same logical position. Resume will regenerate only
      // the current chunk at the new speed, not restart the card.
      walkmanPlaying=false;
      walkmanPaused=true;
      if($("walkmanPlayBtn"))$("walkmanPlayBtn").textContent="▶";
    }
  }
};window.addEventListener("popstate",()=>{if(document.body.classList.contains("walkman"))exitWalkmanMode()});window.addEventListener("keydown",e=>{if(e.key==="Escape"&&document.body.classList.contains("walkman"))exitWalkmanMode()});$("retryConnectBtn").onclick=()=>init().catch(e=>console.error("Reconnect failed:",e));refreshVoices();speechSynthesis.onvoiceschanged=refreshVoices;setupFeynmanRecognition();init().then(()=>listeningLoadSessions()).catch(e=>{console.error(e);showLogin()});


let listeningSession=null,listeningTranscriptAudio=null;
let listeningAudioUrl=null,listeningAudioRequest=0;
let listeningTimerStartedAt=0,listeningTimerInterval=null,listeningTimerElapsed=0;
function listeningTimerDisplay(){
  const el=$("listeningTimer");if(!el)return;
  const secs=Math.floor(listeningTimerElapsed+(listeningTimerStartedAt?(Date.now()-listeningTimerStartedAt)/1000:0));
  el.textContent="⏱ 答题用时 "+String(Math.floor(secs/60)).padStart(2,"0")+":"+String(secs%60).padStart(2,"0");
}
function listeningTimerStart(){
  if(listeningTimerStartedAt)return;
  listeningTimerStartedAt=Date.now();
  listeningTimerInterval=setInterval(listeningTimerDisplay,1000);
  listeningTimerDisplay();
}
function listeningTimerFreeze(){
  if(listeningTimerStartedAt){listeningTimerElapsed+=(Date.now()-listeningTimerStartedAt)/1000;listeningTimerStartedAt=0;}
  clearInterval(listeningTimerInterval);listeningTimerInterval=null;listeningTimerDisplay();
}
function listeningTimerReset(){listeningTimerFreeze();listeningTimerElapsed=0;listeningTimerDisplay();}

function listeningStop(){
  // Stop means pause: keep the position and cached audio for Resume.
  listeningAudioRequest++;
  if(listeningTranscriptAudio&&!listeningTranscriptAudio.paused)listeningTranscriptAudio.pause();
  const btn=$("listeningPlay");
  if(btn)btn.textContent=listeningTranscriptAudio?"▶ 继续播放":"▶ 播放录音";
}
function listeningResetAudio(){
  listeningStop();
  if(listeningTranscriptAudio){listeningTranscriptAudio.pause();listeningTranscriptAudio.removeAttribute("src");listeningTranscriptAudio.load();listeningTranscriptAudio=null;}
  if(listeningAudioUrl){URL.revokeObjectURL(listeningAudioUrl);listeningAudioUrl=null;}
  const btn=$("listeningPlay");if(btn)btn.textContent="▶ 播放录音";
}
function listeningAnswers(){
  if(!listeningSession)return {};
  return Object.fromEntries(listeningSession.questions.map((q,i)=>[q.id,q.type==="mcq"?(document.querySelector('input[name="listening-q'+i+'"]:checked')?.value||""):(document.querySelector('[data-listening-fill="'+i+'"]')?.value||"")]));
}
let listeningSaveTimeout=null;
function listeningScheduleSave(){
  clearTimeout(listeningSaveTimeout);
  if(!listeningSession)return;
  const id=listeningSession.sessionId;
  listeningSaveTimeout=setTimeout(async()=>{
    if(!listeningSession||listeningSession.sessionId!==id)return;
    try{await api("/listening/progress",{method:"POST",body:JSON.stringify({sessionId:id,answers:listeningAnswers()})})}
    catch(e){console.warn("听力进度保存失败",e)}
  },700);
}
function listeningRenderExam(d){
  listeningSession=d;
  $("listeningTitle").textContent=d.title;
  $("listeningQuestions").innerHTML=d.questions.map((q,i)=>
    '<div class="quiz-card"><b>'+(i+1)+'. '+esc(q.prompt)+'</b>'+
    (q.type==="mcq"?'<div class="quiz-choices">'+q.choices.map((c,j)=>
      '<label class="quiz-choice"><input type="radio" name="listening-q'+i+'" value="'+esc(c)+'" style="width:auto"> '+String.fromCharCode(65+j)+'. '+esc(c)+'</label>').join("")+'</div>':
      '<input data-listening-fill="'+i+'" placeholder="输入英文答案" autocomplete="off">')+'</div>').join("");
  d.questions.forEach((q,i)=>{
    const answer=d.answers?.[q.id];if(!answer)return;
    if(q.type==="mcq"){const radio=[...document.querySelectorAll('input[name="listening-q'+i+'"]')].find(x=>x.value===answer);if(radio)radio.checked=true;}
    else{const field=document.querySelector('[data-listening-fill="'+i+'"]');if(field)field.value=answer;}
  });
  $("listeningQuestions").addEventListener("input",listeningScheduleSave);
  $("listeningQuestions").addEventListener("change",listeningScheduleSave);
  $("listeningExam").classList.remove("hidden");
  $("listeningResult").classList.add("hidden");
  listeningTimerReset();listeningTimerStart();
}
async function listeningLoadSessions(){
  const el=$("listeningSavedSessions");if(!el)return;
  try{
    const data=await api("/listening/sessions");
    el.innerHTML='<h3>📁 历史试卷（永久保存）</h3>'+(data.sessions||[]).map(row=>
      '<button class="ghost" style="margin:5px" data-listening-open="'+esc(row.id)+'">'+esc(row.title)+' · '+esc(new Date(row.created_at).toLocaleString())+' · '+(row.graded?'查看答案与精听':'继续答题')+'</button>').join("") ;
    el.querySelectorAll("[data-listening-open]").forEach(b=>b.onclick=()=>listeningOpenSession(b.dataset.listeningOpen));
  }catch(e){el.textContent="历史试卷加载失败："+e.message}
}
async function listeningOpenSession(id){
  try{
    const d=await api("/listening/session/"+encodeURIComponent(id));
    listeningResetAudio();
    if(d.graded){
      listeningSession=null;
      listeningRenderResult(id,{results:d.results,transcript:d.transcript,score:(d.results||[]).filter(x=>x.correct).length,total:(d.results||[]).length});
    }else{listeningRenderExam(d);$("listeningStatus").textContent="已恢复上次未完成的试卷和答案。";}
  }catch(e){$("listeningStatus").textContent="打开试卷失败："+e.message}
}
async function listeningGenerate(){
  listeningTimerReset();
  if(listeningTrainingAudio){listeningTrainingAudio.pause();listeningTrainingAudio=null;}
  if(listeningRecognition){listeningRecognition.abort();listeningRecognition=null;}
  listeningResetAudio();
  const previousResultAudio=$("listeningResultAudio");if(previousResultAudio)previousResultAudio.pause();
  const btn=$("listeningGenerate");btn.disabled=true;
  $("listeningStatus").textContent="AI 正在生成听力材料和试题…";
  $("listeningExam").classList.add("hidden");$("listeningResult").classList.add("hidden");
  try{
    const d=await api("/listening/generate",{method:"POST",body:JSON.stringify({
      auto:true
    })});
    listeningRenderExam(d);
    $("listeningStatus").textContent="试卷已生成；答案自动保存。";
    listeningLoadSessions();
  }catch(e){$("listeningStatus").textContent=e.message}
  finally{btn.disabled=false}
}
async function listeningPlay(){
  if(!listeningSession)return;
  const btn=$("listeningPlay");
  if(listeningTranscriptAudio){
    if(!listeningTranscriptAudio.paused){listeningStop();return;}
    if(listeningTranscriptAudio.ended)listeningTranscriptAudio.currentTime=0;
    try{await listeningTranscriptAudio.play();btn.textContent="Ⅱ 暂停";}catch(e){$("listeningStatus").textContent=e.message}
    return;
  }
  const request=++listeningAudioRequest;
  btn.disabled=true;btn.textContent="正在准备语音…";
  try{
    const res=await fetch("/api/listening/audio/"+encodeURIComponent(listeningSession.sessionId));
    if(!res.ok)throw new Error("听力音频生成失败");
    const blob=await res.blob();
    if(request!==listeningAudioRequest)return;
    listeningAudioUrl=URL.createObjectURL(blob);
    const audio=new Audio(listeningAudioUrl);listeningTranscriptAudio=audio;
    audio.onended=()=>{btn.textContent="▶ 重播录音"};
    audio.onerror=()=>{$("listeningStatus").textContent="音频播放失败";btn.textContent="▶ 重试播放"};
    await audio.play();
    if(request===listeningAudioRequest)btn.textContent="Ⅱ 暂停";
  }catch(e){if(request===listeningAudioRequest)$("listeningStatus").textContent=e.message}
  finally{btn.disabled=false;if(request!==listeningAudioRequest&&!listeningTranscriptAudio)btn.textContent="▶ 播放录音"}
}
async function listeningSubmit(){
  if(!listeningSession)return;
  const answers=listeningAnswers();
  clearTimeout(listeningSaveTimeout);
  if(Object.values(answers).some(x=>!String(x).trim()))return alert("请先完成全部题目");
  const btn=$("listeningSubmit");btn.disabled=true;
  try{
    const d=await api("/listening/grade",{method:"POST",body:JSON.stringify({sessionId:listeningSession.sessionId,answers,durationSeconds:Math.round(listeningTimerElapsed+(listeningTimerStartedAt?(Date.now()-listeningTimerStartedAt)/1000:0))})});
    listeningTimerFreeze();
    listeningResetAudio();
    const completedListeningSessionId=listeningSession.sessionId;
    listeningSession=null;
    listeningRenderResult(completedListeningSessionId,d);
    await listeningLoadSessions();
    await listeningInsights();
  }catch(e){alert(e.message)}finally{btn.disabled=false}
}



function listeningRenderResult(sessionId,d){
    $("listeningResult").innerHTML='<div class="quiz-card"><h3>成绩：'+d.score+' / '+d.total+'</h3>'+
      d.results.map((r,i)=>'<p><b>'+(i+1)+'. '+(r.correct?'✅':'❌')+'</b> 你的答案：'+esc(r.submitted)+
      '<br>正确答案：'+esc(r.answer)+'<br>'+esc(r.explanation)+
      (r.evidence?'<br><button type="button" class="listening-evidence-link" data-evidence-id="'+esc(r.id)+'">📍 定位原文证据</button>':'')+'</p>').join("")+
      '<div class="listening-result-player" style="margin:20px 0;padding:18px;border:1px solid #d8e1ed;border-radius:16px;background:#f8fafc">'+
      '<b style="display:block;margin-bottom:10px;font-size:20px">🎧 重新播放本次听力</b>'+
      '<audio id="listeningResultAudio" controls preload="none" style="width:100%;max-width:780px"></audio>'+
      '<p id="listeningResultAudioStatus" class="muted">点击播放，复听完整原文。</p></div>'+
      '<h3>听力原文（答案依据已标注）</h3><div id="listeningMarkedTranscript" class="listening-marked-transcript"></div>'+
      '<section id="listeningTraining" style="margin:24px 0;border-top:1px solid #dbe3ef;padding-top:20px"></section>'+
      '<section id="listeningVocabulary" style="margin-top:28px;border-top:1px solid #dbe3ef;padding-top:22px">'+
      '<h3>📚 听力重点词汇与拓展词汇</h3><p class="muted">自动整理音标、原形、高频搭配、听力原句、精选例句及记忆方法；勾选后可完整导入复习卡片。</p>'+
      '<div id="listeningVocabularyStatus">正在提取重点词汇…</div><div id="listeningVocabularyList"></div>'+
      '<div class="row" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px"><button type="button" id="listeningVocabImport" class="btn dark" disabled>一键导入选中卡片</button><button type="button" id="listeningVocabRefresh" class="ghost">🔄 重新生成词汇与例句</button></div></section></div>';
    renderListeningEvidence(d.transcript,d.results);
    renderListeningTraining(sessionId,d.transcript,d.results);
    const resultAudio=$("listeningResultAudio");
    resultAudio.src="/api/listening/audio/"+encodeURIComponent(sessionId);
    resultAudio.addEventListener("error",()=>{
      $("listeningResultAudioStatus").textContent="音频加载失败，请刷新或重新生成试卷。";
    });
    $("listeningResult").classList.remove("hidden");
    $("listeningExam").classList.add("hidden");
    loadListeningVocabulary(sessionId);


}

let listeningTrainingAudio=null,listeningRecognition=null;
function listeningWords(text){return String(text||"").toLowerCase().replace(/[^a-z' ]/g," ").split(/\s+/).filter(Boolean)}
function listeningSimilarity(expected,actual){
  const a=listeningWords(expected),b=listeningWords(actual),dp=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++)dp[i][0]=i;
  for(let k=0;k<=b.length;k++)dp[0][k]=k;
  for(let i=1;i<=a.length;i++)for(let k=1;k<=b.length;k++)dp[i][k]=Math.min(dp[i-1][k]+1,dp[i][k-1]+1,dp[i-1][k-1]+(a[i-1]===b[k-1]?0:1));
  return {score:Math.round(100*(1-dp[a.length][b.length]/Math.max(1,a.length,b.length))),expected:a.length};
}
function renderListeningTraining(sessionId,transcript,results){
  const root=$("listeningTraining");if(!root)return;
  const sentences=(transcript.match(/[^.!?]+[.!?]+(?:["']|$)?|[^.!?]+$/g)||[]).map(x=>x.trim()).filter(Boolean);
  const weak=results.filter(r=>!r.correct).map(r=>r.skill);
  root.innerHTML='<h3>🎯 错题诊断与精听训练</h3><p class="muted">错题能力点：'+esc(weak.length?weak.join("、"):"本次全部答对。可以继续做精听巩固。")+'。诊断基于题型和作答结果，不等同于准确识别错误原因。</p>'+
    '<p class="muted">逐句复听采用单句重新合成的语音，不是原始整段录音的精确时间轴。</p>'+
    '<div id="listeningSentenceList">'+sentences.map((sentence,i)=>'<div class="quiz-card" style="margin:10px 0;padding:14px"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="ghost" data-li-sentence="'+i+'">▶ 第'+(i+1)+'句</button><button class="ghost" data-li-loop="'+i+'">↻ 单句循环</button><button class="ghost" data-li-shadow="'+i+'">🎙 跟读</button></div><p>'+esc(sentence)+'</p><input data-li-dictation="'+i+'" placeholder="听写这一句（可先不看原文）" style="width:100%"><button class="ghost" data-li-check="'+i+'">检查听写</button><div class="muted" data-li-feedback="'+i+'"></div></div>').join("")+'</div>'+
    '<p id="listeningTrainingStatus" class="muted">跟读需要浏览器支持语音识别并授权麦克风。评分仅比较转写文字，不代表发音准确度。</p>'+
    '<button class="btn dark" id="listeningRetest">🔄 生成新材料，复测薄弱点</button>';
  let looping=-1;
  const audio=new Audio();listeningTrainingAudio=audio;
  audio.onended=()=>{if(looping>=0){audio.currentTime=0;audio.play().catch(()=>{looping=-1})}};
  async function playSentence(i,loop=false){
    if(looping===i&&loop){looping=-1;audio.pause();return}
    looping=loop?i:-1;audio.pause();
    const status=$("listeningTrainingStatus");status.textContent="正在准备第 "+(i+1)+" 句音频…";
    try{audio.src="/api/listening/sentence-audio/"+encodeURIComponent(sessionId)+"/"+i;await audio.play();status.textContent=loop?"正在循环第 "+(i+1)+" 句；再次点击循环按钮停止。":"正在播放第 "+(i+1)+" 句";}
    catch(e){status.textContent="播放失败："+e.message}
  }
  root.querySelectorAll("[data-li-sentence]").forEach(b=>b.onclick=()=>playSentence(Number(b.dataset.liSentence)));
  root.querySelectorAll("[data-li-loop]").forEach(b=>b.onclick=()=>playSentence(Number(b.dataset.liLoop),true));
  root.querySelectorAll("[data-li-check]").forEach(b=>b.onclick=()=>{
    const i=Number(b.dataset.liCheck),input=root.querySelector('[data-li-dictation="'+i+'"]'),feedback=root.querySelector('[data-li-feedback="'+i+'"]');
    const v=listeningSimilarity(sentences[i],input.value);feedback.textContent="词序匹配约 "+v.score+"%（仅供练习参考）；原句："+sentences[i];
  });
  root.querySelectorAll("[data-li-shadow]").forEach(b=>b.onclick=()=>{
    const i=Number(b.dataset.liShadow),SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    const status=$("listeningTrainingStatus");
    if(!SpeechRecognition){status.textContent="当前浏览器不支持语音识别，可使用听写练习。";return}
    if(listeningRecognition)listeningRecognition.abort();
    audio.pause();looping=-1;
    const rec=new SpeechRecognition();listeningRecognition=rec;rec.lang="en-US";rec.interimResults=false;
    rec.onresult=e=>{const heard=e.results[0][0].transcript,v=listeningSimilarity(sentences[i],heard);status.textContent="识别到："+heard+"。与原句的词序匹配约 "+v.score+"%；这不是发音评分。"};
    rec.onerror=e=>{status.textContent="语音识别失败："+e.error};
    rec.onend=()=>{if(listeningRecognition===rec)listeningRecognition=null};
    try{rec.start();status.textContent="请跟读第 "+(i+1)+" 句…"}catch(e){status.textContent=e.message}
  });
  $("listeningRetest").onclick=()=>{audio.pause();looping=-1;listeningGenerate()};
}

let listeningVocabCards=[];
async function loadListeningVocabulary(sessionId,refresh=false){
  const status=$("listeningVocabularyStatus"),list=$("listeningVocabularyList"),importBtn=$("listeningVocabImport"),refreshBtn=$("listeningVocabRefresh");
  if(!status||!list)return;
  listeningVocabCards=[];
  if(refreshBtn){refreshBtn.disabled=true;refreshBtn.textContent=refresh?"正在重新生成词汇…":"🔄 重新生成词汇与例句";}
  if(refresh)status.textContent="正在重新提取词汇、常用搭配和精选例句…";
  try{
    const result=await api("/listening/vocabulary",{method:"POST",body:JSON.stringify({sessionId,refresh})});
    listeningVocabCards=result.cards||[];
    if(!listeningVocabCards.length){status.textContent="未提取到词汇，可重新生成试卷。";return;}
    const known=new Set(cards.map(c=>String(c.front||"").trim().toLowerCase()));
    list.innerHTML=listeningVocabCards.map((v,i)=>{
      const exists=known.has(v.front.toLowerCase());
      const uses=Array.isArray(v.commonUsages)?v.commonUsages.filter(u=>u&&u.phrase&&u.meaning).slice(0,3):[];
      const usageHtml=uses.length?'<div style="margin-top:9px;padding:10px 12px;border-radius:10px;background:#eef5ff;color:#243e68;line-height:1.6">'+
        '<strong>📌 高频用法 / 常见搭配</strong>'+
        uses.map(u=>'<div style="margin-top:3px">• <b>'+esc(u.phrase)+'</b> — '+esc(u.meaning)+'</div>').join('')+
        '</div>':'';
      const bestHtml=v.bestExample?'<div style="margin-top:9px;padding:10px 12px;border-radius:10px;background:#edf9f2;color:#20523b;line-height:1.65">'+
        '<strong>⭐ 精选例句</strong><div>'+esc(v.bestExample)+'</div>'+
        (v.bestExampleZh?'<div style="font-size:14px;opacity:.86">'+esc(v.bestExampleZh)+'</div>':'')+'</div>':'';
      return '<label style="display:flex;gap:12px;align-items:flex-start;padding:14px;border:1px solid #e1e7ef;border-radius:12px;margin:10px 0;cursor:pointer">'+
        '<input type="checkbox" data-listening-vocab="'+i+'" '+(exists?'disabled':'')+' style="width:20px;height:20px;margin-top:4px;flex-shrink:0">'+
        '<span style="min-width:0;flex:1"><strong style="font-size:19px">'+esc(v.front)+'</strong> '+
        (v.lemma&&v.lemma.toLowerCase()!==v.front.toLowerCase()?'<span style="font-size:15px;color:#526c87;margin-left:6px">→ 原形 '+esc(v.lemma)+(v.inflection?'（'+esc(v.inflection)+'）':'')+'</span> ':'')+
        (v.ipa?'<span style="font-size:16px;color:#63758a;font-weight:500;margin-left:8px">'+esc(v.ipa)+'</span> ':'')+
        '<small>'+esc(v.related)+(exists?' · 已在知识库':'')+'</small>'+
        '<div style="font-size:17px;line-height:1.65">'+esc(v.back)+'</div>'+
        (v.example?'<div class="muted" style="margin-top:3px">📖 听力原句：'+esc(v.example)+'</div>':'')+
        usageHtml+bestHtml+
        (v.memoryTip?'<div style="margin-top:9px;padding:10px 12px;border-radius:10px;background:#fff7e6;color:#654313;font-size:16px;line-height:1.6">🧠 '+esc(v.memoryMethod)+'：'+esc(v.memoryTip)+'</div>':'')+
        '</span></label>';
    }).join("");
    const hasOlderCards=listeningVocabCards.some(v=>!Array.isArray(v.commonUsages)||!v.bestExample);
    status.textContent="从听力原文和题目选项共整理 "+listeningVocabCards.length+" 个词汇（原文 "+listeningVocabCards.filter(x=>x.related==="原文").length+"，选项 "+listeningVocabCards.filter(x=>x.related==="选项").length+"）。"+
      (result.partial?"部分来源提取失败，本次结果可能不完整。":"")+
      (hasOlderCards?"这些词汇可能是旧版缓存，点击“重新生成词汇与例句”补充高频用法。":"")+
      "勾选需要记忆的词汇，已存在的卡片不会重复导入。";
    if(refreshBtn){refreshBtn.disabled=false;refreshBtn.textContent="🔄 重新生成词汇与例句";refreshBtn.onclick=()=>loadListeningVocabulary(sessionId,true);}
    importBtn.disabled=false;
    importBtn.onclick=importListeningVocabulary;
  }catch(e){status.textContent="词汇整理失败："+e.message+"。";const retry=document.createElement("button");retry.textContent="重试提取";retry.type="button";retry.className="ghost";retry.onclick=()=>loadListeningVocabulary(sessionId,refresh);status.appendChild(retry)}
  finally{if(refreshBtn){refreshBtn.disabled=false;refreshBtn.textContent="🔄 重新生成词汇与例句";refreshBtn.onclick=()=>loadListeningVocabulary(sessionId,true);}}
}
async function importListeningVocabulary(){
  const btn=$("listeningVocabImport"),status=$("listeningVocabularyStatus");
  const selected=[...document.querySelectorAll("[data-listening-vocab]:checked")].map(el=>listeningVocabCards[Number(el.dataset.listeningVocab)]).filter(Boolean);
  if(!selected.length){status.textContent="请先勾选要导入的词汇。";return}
  btn.disabled=true;btn.textContent="正在导入…";
  try{
    const known=new Set(cards.map(c=>String(c.front||"").trim().toLowerCase()));
    const fresh=selected.filter(c=>!known.has(c.front.toLowerCase()));
    if(!fresh.length){status.textContent="选中词汇已经存在于知识库。";return}
    const prepared=fresh.map(c=>{
      const parts=[];
      if(c.lemma&&c.lemma.toLowerCase()!==c.front.toLowerCase())parts.push("📖 原形："+c.lemma+(c.inflection?"（"+c.inflection+"）":""));
      if(c.ipa)parts.push("🔊 音标："+c.ipa);
      if(c.example)parts.push("📖 听力原句："+c.example);
      const uses=Array.isArray(c.commonUsages)?c.commonUsages.filter(u=>u&&u.phrase&&u.meaning).slice(0,3):[];
      if(uses.length)parts.push("📌 高频用法：\n"+uses.map(u=>"• "+u.phrase+" — "+u.meaning).join("\n"));
      if(c.bestExample)parts.push("⭐ 精选例句："+c.bestExample+(c.bestExampleZh?"\n"+c.bestExampleZh:""));
      if(c.memoryTip)parts.push("🧠 "+c.memoryMethod+"："+c.memoryTip);
      return {front:c.front,back:c.back,example:parts.join("\n"),tags:["英语","听力",c.related]};
    });
    const imported=[];
    // The save API accepts up to 30 cards per call. Split larger vocabulary selections.
    for(let start=0;start<prepared.length;start+=30){
      const result=await api("/ai/organize/save",{method:"POST",body:JSON.stringify({cards:prepared.slice(start,start+30)})});
      imported.push(...(result.cards||[]));
    }
    await Promise.all([loadCards(),loadDue()]);
    const saved=new Set(imported.map(c=>String(c.front||"").trim().toLowerCase()));
    document.querySelectorAll("[data-listening-vocab]").forEach(el=>{const card=listeningVocabCards[Number(el.dataset.listeningVocab)];if(card&&saved.has(card.front.toLowerCase())){el.checked=false;el.disabled=true;}});
    status.textContent="已成功导入 "+imported.length+" 张卡片（包含高频用法与精选例句），进入现有复习系统。";
  }catch(e){status.textContent="导入失败："+e.message}
  finally{btn.disabled=false;btn.textContent="一键导入选中卡片"}
}

function renderListeningEvidence(transcript,results){
  const root=$("listeningMarkedTranscript");
  if(!root)return;
  const ranges=[];
  for(const r of results){
    if(!r.evidence)continue;
    const at=transcript.indexOf(r.evidence);
    if(at>=0)ranges.push({start:at,end:at+r.evidence.length,id:String(r.id)});
  }
  const boundaries=new Set([0,transcript.length]);
  for(const r of ranges){boundaries.add(r.start);boundaries.add(r.end)}
  const points=[...boundaries].sort((a,b)=>a-b);
  root.innerHTML=points.slice(0,-1).map((start,i)=>{
    const end=points[i+1],ids=ranges.filter(r=>r.start<=start&&r.end>=end).map(r=>r.id);
    return ids.length?'<mark class="listening-evidence-mark" data-evidence-ids="'+ids.join(" ")+'" title="第 '+ids.join("、")+' 题依据">'+esc(transcript.slice(start,end))+'</mark>':esc(transcript.slice(start,end));
  }).join("");
  $("listeningResult").querySelectorAll("[data-evidence-id]").forEach(btn=>btn.addEventListener("click",()=>{
    const id=btn.dataset.evidenceId;
    const mark=[...root.querySelectorAll(".listening-evidence-mark")].find(el=>el.dataset.evidenceIds.split(" ").includes(id));
    if(!mark)return;
    root.querySelectorAll(".listening-evidence-mark").forEach(el=>el.classList.toggle("listening-evidence-active",el.dataset.evidenceIds.split(" ").includes(id)));
    mark.scrollIntoView({behavior:"smooth",block:"center"});
  }));
}

async function listeningInsights(){
  const root=$("listeningInsights");if(!root)return;
  try{
    const d=await api("/listening/history");
    const history=d.history||[];
    const skills=Object.entries(d.bySkill||{});
    root.innerHTML='<div class="li-head"><div><small>LISTENING INTELLIGENCE</small><h2>听力能力分析</h2></div><span class="li-pill">'+d.attempts+' 次测试</span></div>'+
      '<div class="li-metrics"><div><small>累计正确率</small><strong>'+(d.accuracy==null?'—':d.accuracy+'%')+'</strong></div><div><small>雅思听力估计</small><strong>待校准</strong></div></div>'+
      '<p class="muted">'+esc(d.estimateNote)+'</p>'+
      '<h3>能力维度</h3>'+(d.weakSkills?.length?'<p class="muted">优先训练：'+d.weakSkills.map(x=>esc(x.skill)+'（'+x.accuracy+'%，'+x.count+'题）').join(' · ')+'</p>':'')+ (skills.length?skills.map(([name,v])=>'<div class="li-skill"><span>'+esc(name)+'</span><div class="li-track"><i style="width:'+Math.round(v.correct/v.total*100)+'%"></i></div><b>'+Math.round(v.correct/v.total*100)+'%</b></div>').join(""):'<p class="muted">完成考试后开始建立能力档案。</p>')+
      '<h3>历次表现</h3><div class="li-history">'+history.slice(0,12).reverse().map(r=>'<div title="'+esc(r.level+' '+r.score+'/'+r.total)+'"><i style="height:'+Math.max(6,r.score/r.total*100)+'%"></i></div>').join("")+'</div>';
  }catch(e){root.textContent="能力档案加载失败："+e.message}
}
$("listeningGenerate").onclick=listeningGenerate;
listeningInsights();
$("listeningPlay").onclick=listeningPlay;
$("listeningStop").onclick=listeningStop;
$("listeningSubmit").onclick=listeningSubmit;


/* Listening result: right-click selected text or a paragraph to make a card. */
(function setupListeningResultCardMenu(){
  const root=$("listeningResult");
  if(!root)return;
  const menu=document.createElement("div");
  menu.id="listeningCardContextMenu";
  menu.setAttribute("role","menu");
  menu.style.cssText="position:fixed;z-index:10000;display:none;background:#fff;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 12px 35px #0f172a30;padding:6px;max-width:calc(100vw - 20px)";
  const action=document.createElement("button");
  action.type="button";action.textContent="＋ 加入知识卡片";
  action.style.cssText="display:block;border:0;background:#fff;color:#172033;font-size:17px;padding:12px 18px;cursor:pointer;border-radius:8px";
  menu.appendChild(action);document.body.appendChild(menu);
  let pending="";
  const hide=()=>{menu.style.display="none"};
  root.addEventListener("contextmenu",event=>{
    const selected=String(window.getSelection()?.toString()||"").trim();
    const target=event.target.closest("p");
    if(!selected&&!target)return;
    pending=(selected||(target?.innerText||"")).trim().slice(0,3000);
    if(!pending)return;
    event.preventDefault();
    menu.style.display="block";
    const rect=menu.getBoundingClientRect();
    menu.style.left=Math.max(8,Math.min(event.clientX,window.innerWidth-rect.width-8))+"px";
    menu.style.top=Math.max(8,Math.min(event.clientY,window.innerHeight-rect.height-8))+"px";
  });
  action.addEventListener("click",()=>{
    hide();
    if(!pending)return;
    openNew();
    $("mFront").value=pending;
    $("mBack").value="";
    $("mExample").value="来源：AI 听力考试";
    $("mBack").focus();
  });
  document.addEventListener("click",event=>{if(!menu.contains(event.target))hide()});
  document.addEventListener("keydown",event=>{if(event.key==="Escape")hide()});
  window.addEventListener("scroll",hide,true);
})();
