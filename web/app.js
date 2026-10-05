const $=id=>document.getElementById(id);
let currentImportedNoteId=null,voiceRecorder=null,voiceChunks=[],voiceRecording=false,voicePreviewUrl=null;
let me=null,aiEnabled=false,cards=[],due=[],dueIndex=0,loop=false,autoPlay=false,isSpeaking=false,settings={},generated=[],editId=null,notes=[],currentNoteId=null,currentGeneratedNoteId=null;
let quizSessionId=null,quizQuestions=[],quizIndex=0,quizStats={correct:0,partial:0,wrong:0},selectedChoice="",quizConfidence="",quizAttempts=[],quizAdaptiveAdded=0;
let ttsVoices=[],voiceCursor={zh:0,en:0},ttsInfoState={enabled:false,provider:"browser"},currentAudio=null,ttsPlaybackGeneration=0,noteSpeaking=false,activeTtsRequests=new Set(),currentTtsObjectUrl=null;
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
    if(res.status===504)throw new Error("AI 出题响应超时了。视觉题会自动降级，请重新生成一次。");
    if(res.status===502||res.status===503)throw new Error("AI 服务暂时不可用，请稍后重试或切换 API。");
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
  const t={homePage:"首页",todayPage:"今日复习",importPage:"AI 整理笔记",notesPage:"笔记库",quizPage:"AI 测试",feynmanPage:"费曼模式",libraryPage:"知识库",statsPage:"学习统计",settingsPage:"设置"};
  $("pageTitle").textContent=t[id]||"MemoryCast";if(id==="statsPage")loadStats();if(id==="notesPage")loadNotes();if(id==="feynmanPage"&&!$("feynmanTopic").value)loadRandomFeynmanTopic();
}
async function init(){
  const auth=await fetch("/api/auth/me").then(r=>r.json());aiEnabled=!!auth.aiEnabled;
  $("aiStatusLogin").textContent=aiEnabled?"AI 已连接":"AI 尚未配置；基础复习仍可使用";
  if(!auth.user){showLogin();return}
  me=auth.user;
  showApp();
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
}
async function loadCards(){const d=await api("/cards");cards=d.cards||[];$("homeCards").textContent=cards.length;renderLibrary();renderCategories();$("syncText").textContent=cards.length+" 个知识点已同步"}
async function loadDue(){const d=await api("/due");due=d.cards||[];dueIndex=Math.min(dueIndex,Math.max(0,due.length-1));$("homeDue").textContent=due.length;renderDue()}
function renderDue(){
  const c=due[dueIndex];
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
function splitByLanguage(text){
  const input=String(text||"");
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
  const baseRate=Number(settings.english_rate||1.0);
  u.rate=Math.max(0.6,Math.min(1.6,baseRate*profile.rate));
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
    rate:part.lang==="zh-CN"
      ? Number(settings.chinese_rate||1.0)
      : Number(settings.english_rate||1.0)
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

function renderCategories(){
  const tags=[...new Set(cards.flatMap(c=>c.tags||[]).filter(Boolean))].sort();
  $("categoryFilter").innerHTML='<option value="">全部标签</option>'+tags.map(t=>"<option>"+esc(t)+"</option>").join("");
}
function renderLibrary(){
  const key=($("searchInput")?.value||"").toLowerCase(),tag=$("categoryFilter")?.value||"";
  const arr=cards.filter(c=>{
    const hay=(c.front+" "+c.back+" "+c.example+" "+(c.tags||[]).join(" ")).toLowerCase();
    return (!key||hay.includes(key))&&(!tag||(c.tags||[]).includes(tag));
  });
  $("libraryList").innerHTML=arr.map(c=>'<div class="card-item"><div><b>'+esc(c.front)+'</b><div class="muted">'+esc(c.back)+'</div><div class="muted">下次：'+new Date(c.due).toLocaleString()+'</div></div><div class="card-actions"><div>'+(c.tags||[]).map(t=>'<span class="chip">'+esc(t)+'</span>').join(" ")+'</div><button class="ghost" data-edit="'+c.id+'">编辑</button><button class="ghost" data-del="'+c.id+'">删除</button></div></div>').join("")||'<div class="muted">暂无内容。</div>';
  document.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openEdit(b.dataset.edit));document.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>deleteCard(b.dataset.del));
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
  $("notesList").innerHTML=arr.map(n=>{
    const lines=String(n.content||"").split(/\r?\n/);
    const preview=lines.slice(0,5).join("\n")+(lines.length>5?"\n…":"");
    return '<div class="card-item"><div><b>'+esc(n.title)+'</b><pre class="note-preview muted">'+esc(preview)+'</pre><div class="muted">'+new Date(n.createdAt).toLocaleString()+' · 自主复习 '+(n.manualReviewCount||0)+' 次</div></div><div class="card-actions"><button class="ghost" data-note-review="'+n.id+'">复习</button></div></div>';
  }).join("")||'<div class="muted">还没有保存的原始笔记。</div>';
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
async function organize(){
  const text=$("noteInput").value.trim();if(!text)return alert("请先粘贴笔记");const b=$("organizeBtn");b.disabled=true;b.textContent="AI 整理中…";
  try{const d=await api("/ai/organize",{method:"POST",body:JSON.stringify({text,splitMode:$("cardSplitMode").value,noteId:currentImportedNoteId})});currentGeneratedNoteId=d.note?.id||null;currentImportedNoteId=d.note?.id||currentImportedNoteId;generated=d.cards||[];loadNotes();$("generatedCards").innerHTML='<div class="muted" style="margin-bottom:10px">✓ 原始笔记已保存到笔记库，不会因生成卡片而删除。</div>'+generated.map(c=>'<div class="mini-card"><div class="eyebrow">'+(c.tags||[]).map(esc).join(" · ")+'</div><b>'+esc(c.front)+'</b><div>'+esc(c.back)+'</div><div class="muted">'+esc(c.example||"")+'</div></div>').join("");$("saveGeneratedBtn").classList.toggle("hidden",!generated.length)}
  catch(e){alert(e.message)}finally{b.disabled=!aiEnabled;b.textContent="✨ AI 整理为卡片"}
}
async function saveGenerated(){const d=await api("/ai/organize/save",{method:"POST",body:JSON.stringify({cards:generated,noteId:currentGeneratedNoteId})});generated=[];currentGeneratedNoteId=null;$("generatedCards").innerHTML='<div class="muted">已保存 '+d.cards.length+' 张卡片。</div>';$("saveGeneratedBtn").classList.add("hidden");await Promise.all([loadCards(),loadDue()])}

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
      body:JSON.stringify({mode,count,...(cardIds?{cardIds}:{})})
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
  $("quizType").textContent=(q.visualAttachmentId?"看图题 · ":"")+({mcq:"选择题",fill:"填空题",short:"简答题",listening:"听力题"}[q.type]||q.type)+(q.adaptive?" · 自适应变式":"");
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

  $("listenQuizBtn").classList.toggle("hidden",q.type!=="listening");
  $("listenQuizBtn").textContent=q.type==="listening"?"🔊 播放听力":"🔊 播放听力";
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
        confidence:quizConfidence
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

  const total=quizAttempts.length||quizQuestions.length||1;
  const mastery=Math.round(
    ((quizStats.correct||0)+(quizStats.partial||0)*0.5)/total*100
  );
  const summary=quizKnowledgeSummary();
  const wrongIds=[...new Set(summary.weak.map(x=>x.cardId))];
  const weakest=summary.weak[0]||summary.fuzzy[0]||null;

  $("quizResult").innerHTML=
    '<div class="quiz-diagnosis">'+
      '<div class="quiz-empty"><b style="font-size:34px">'+mastery+'%</b><br>本次掌握度'+
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
    const d=await api("/feynman/respond",{method:"POST",body:JSON.stringify({
      topic,explanation,sessionId:feynmanSessionId,cardId:currentFeynmanCardId
    })});

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
    alert(e.message);
    $("feynmanMicStatus").textContent="分析失败，但你的转写还在，可以再次提交。";
  }finally{
    btn.disabled=false;
    btn.textContent="让 AI 分析";
  }
}

async function loadStats(){if(!me)return;const d=await api("/stats");$("homeCards").textContent=d.cards;$("homeReviews").textContent=d.reviews;$("homeAccuracy").textContent=d.quizAccuracy==null?"—":d.quizAccuracy+"%";$("statCards").textContent=d.cards;$("statReviews").textContent=d.reviews;$("statAccuracy").textContent=d.quizAccuracy==null?"—":d.quizAccuracy+"%";$("statLast7").textContent=d.last7;$("categoryStats").innerHTML=(d.categories||[]).map(x=>'<div class="card-item"><div><b>'+esc(x.category)+'</b><div class="muted">平均 FSRS difficulty '+Number(x.avg_difficulty||0).toFixed(2)+'</div></div><span class="chip">'+x.count+" 张</span></div>").join("")||'<div class="muted">暂无统计。</div>'}
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

  const serverOrder=Array.isArray(settings.nav_order)?settings.nav_order:[];
  let localOrder=[];
  try{localOrder=JSON.parse(localStorage.getItem(NAV_ORDER_KEY)||"[]")}catch{}

  if(serverOrder.length){
    const serverIsDefault=JSON.stringify(serverOrder)===JSON.stringify(DEFAULT_NAV_ORDER);
    const localIsCustom=Array.isArray(localOrder)&&localOrder.length&&JSON.stringify(localOrder)!==JSON.stringify(DEFAULT_NAV_ORDER);

    if(serverIsDefault&&localIsCustom){
      applyNavOrder(localOrder);
      try{
        const migrated=await api("/settings/nav-order",{
          method:"PUT",
          body:JSON.stringify({nav_order:localOrder})
        });
        if(Array.isArray(migrated.nav_order))applyNavOrder(migrated.nav_order);
      }catch{}
    }else{
      applyNavOrder(serverOrder);
      try{localStorage.setItem(NAV_ORDER_KEY,JSON.stringify(serverOrder))}catch{}
    }
  }

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

const DEFAULT_NAV_ORDER=[
  "homePage","todayPage","importPage","notesPage","quizPage",
  "feynmanPage","libraryPage","statsPage","settingsPage"
];
const NAV_ORDER_KEY="memorycast_nav_order_v1";

function currentNavOrder(){
  return [...document.querySelectorAll(".nav [data-page]")].map(x=>x.dataset.page);
}

let navSaveTimer=null;
function saveNavOrder(){
  const order=currentNavOrder();
  try{localStorage.setItem(NAV_ORDER_KEY,JSON.stringify(order))}catch{}

  clearTimeout(navSaveTimer);
  navSaveTimer=setTimeout(async()=>{
    try{
      const d=await api("/settings/nav-order",{
        method:"PUT",
        body:JSON.stringify({nav_order:order})
      });
      if(Array.isArray(d.nav_order)){
        applyNavOrder(d.nav_order);
        try{localStorage.setItem(NAV_ORDER_KEY,JSON.stringify(d.nav_order))}catch{}
      }
    }catch(err){
      console.warn("菜单顺序服务端同步失败，已保留本地缓存：",err?.message||err);
    }
  },250);
}

function applyNavOrder(order){
  const nav=document.querySelector(".nav");
  if(!nav)return;
  const map=new Map([...nav.querySelectorAll("[data-page]")].map(el=>[el.dataset.page,el]));
  const clean=[...(Array.isArray(order)?order:[]),...DEFAULT_NAV_ORDER]
    .filter((id,i,arr)=>map.has(id)&&arr.indexOf(id)===i);
  clean.forEach(id=>nav.appendChild(map.get(id)));
}

function loadNavOrder(){
  try{
    const raw=localStorage.getItem(NAV_ORDER_KEY);
    if(raw)applyNavOrder(JSON.parse(raw));
  }catch{}
}

function resetNavOrder(){
  applyNavOrder(DEFAULT_NAV_ORDER);
  saveNavOrder();
}

function setupCustomNavOrder(){
  const nav=document.querySelector(".nav");
  if(!nav)return;

  loadNavOrder();

  let dragged=null;
  let startY=0;
  let moved=false;

  nav.querySelectorAll("[data-page]").forEach(btn=>{
    btn.draggable=true;

    btn.addEventListener("dragstart",e=>{
      dragged=btn;
      btn.classList.add("nav-dragging");
      e.dataTransfer.effectAllowed="move";
      try{e.dataTransfer.setData("text/plain",btn.dataset.page)}catch{}
    });

    btn.addEventListener("dragover",e=>{
      if(!dragged||dragged===btn)return;
      e.preventDefault();
      const rect=btn.getBoundingClientRect();
      const before=e.clientY < rect.top+rect.height/2;
      nav.insertBefore(dragged,before?btn:btn.nextSibling);
    });

    btn.addEventListener("dragend",()=>{
      btn.classList.remove("nav-dragging");
      dragged=null;
      saveNavOrder();
    });

    btn.addEventListener("pointerdown",e=>{
      if(e.pointerType==="mouse")return;
      dragged=btn;
      startY=e.clientY;
      moved=false;
      btn.classList.add("nav-touch-ready");
      try{btn.setPointerCapture(e.pointerId)}catch{}
    });

    btn.addEventListener("pointermove",e=>{
      if(!dragged||dragged!==btn||e.pointerType==="mouse")return;
      if(Math.abs(e.clientY-startY)<8&&!moved)return;
      moved=true;
      btn.classList.add("nav-dragging");
      e.preventDefault();

      // iOS Safari + pointer capture can make elementFromPoint() keep returning
      // the dragged button itself. Instead, place by comparing the finger Y
      // position with every other menu item's vertical midpoint.
      const siblings=[...nav.querySelectorAll("[data-page]")].filter(x=>x!==btn);
      let inserted=false;
      for(const target of siblings){
        const rect=target.getBoundingClientRect();
        const mid=rect.top+rect.height/2;
        if(e.clientY<mid){
          nav.insertBefore(btn,target);
          inserted=true;
          break;
        }
      }
      if(!inserted)nav.appendChild(btn);
    });

    const finishPointer=e=>{
      if(dragged!==btn)return;
      if(moved){
        e.preventDefault();
        saveNavOrder();
        // Prevent the synthetic click after a touch drag from navigating.
        btn.dataset.skipNextClick="1";
        setTimeout(()=>delete btn.dataset.skipNextClick,350);
      }
      btn.classList.remove("nav-dragging","nav-touch-ready");
      dragged=null;
      moved=false;
    };
    btn.addEventListener("pointerup",finishPointer);
    btn.addEventListener("pointercancel",finishPointer);
  });
}

function closeMobileNav(){document.body.classList.remove("mobile-nav-open")}
function toggleMobileNav(){document.body.classList.toggle("mobile-nav-open")}
document.querySelectorAll("[data-page]").forEach(b=>b.onclick=()=>{if(b.dataset.skipNextClick)return;go(b.dataset.page);closeMobileNav()});
document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
setupCustomNavOrder();$("mobileMenuBtn").onclick=toggleMobileNav;
$("sidebarBackdrop").onclick=closeMobileNav;
$("logoutBtn").onclick=async()=>{await api("/auth/logout",{method:"POST"});location.reload()};$("watchBtn").onclick=()=>document.body.classList.toggle("watch");
$("speakBtn").onclick=toggleSpeak;$("nextCardBtn").onclick=()=>{autoPlay=false;isSpeaking=false;stopAllTts();$("speakBtn").textContent="🔊 朗读";nextDue()};$("loopBtn").onclick=()=>{loop=!loop;$("loopBtn").textContent="↻ 循环："+(loop?"开":"关");if(loop)speakCurrent()};
document.querySelectorAll("[data-rating]").forEach(b=>b.onclick=()=>grade(b.dataset.rating));$("searchInput").oninput=renderLibrary;$("categoryFilter").onchange=renderLibrary;$("newCardBtn").onclick=openNew;
$("modalClose").onclick=()=>$("modal").classList.add("hidden");$("modalSave").onclick=saveModal;$("organizeBtn").onclick=organize;$("saveGeneratedBtn").onclick=saveGenerated;
$("generateQuizBtn").onclick=()=>generateQuiz();$("submitQuizBtn").onclick=submitQuiz;document.querySelectorAll("[data-confidence]").forEach(b=>b.onclick=()=>setQuizConfidence(b.dataset.confidence));$("nextQuizBtn").onclick=()=>{quizIndex++;renderQuiz()};$("listenQuizBtn").onclick=replayQuizAudio;$("voiceNoteBtn").onclick=toggleVoiceNote;$("photoOcrBtn").onclick=()=>$("photoOcrInput").click();$("photoOcrInput").onchange=e=>handleMediaFiles(e.target.files);$("feynmanMicBtn").onclick=toggleFeynmanMic;$("submitFeynmanBtn").onclick=submitFeynman;$("clearFeynmanInputBtn").onclick=()=>{$("feynmanInput").value="";feynmanRecognitionBase=""};$("resetFeynmanBtn").onclick=resetFeynman;$("randomFeynmanTopicBtn").onclick=chooseAnotherFeynmanTopic;$("speakFeynmanQuestionBtn").onclick=()=>{if(feynmanLastQuestion)speakOne(feynmanLastQuestion)};$("saveSettingsBtn").onclick=saveSettings;$("resetNavOrderBtn").onclick=()=>{resetNavOrder();alert("菜单顺序已恢复默认。")};$("pushToggleBtn").onclick=togglePush;$("englishVoice").onchange=()=>localStorage.setItem("memorycast_en_voice",$("englishVoice").value);$("chineseVoice").onchange=()=>localStorage.setItem("memorycast_zh_voice",$("chineseVoice").value);$("englishVoiceStyle").onchange=()=>localStorage.setItem("memorycast_en_voice_style",$("englishVoiceStyle").value);$("chineseVoiceStyle").onchange=()=>localStorage.setItem("memorycast_zh_voice_style",$("chineseVoiceStyle").value);$("noteSearch").oninput=renderNotes;$("speakNoteBtn").onclick=speakSelectedNote;$("markNoteReviewedBtn").onclick=markSelectedNoteReviewed;$("editNoteBtn").onclick=openNoteEdit;$("deleteNoteBtn").onclick=deleteCurrentNote;$("noteModalClose").onclick=()=>$("noteModal").classList.add("hidden");$("noteModalSave").onclick=saveNoteEdit;
refreshVoices();speechSynthesis.onvoiceschanged=refreshVoices;setupFeynmanRecognition();init().catch(e=>{console.error(e);showLogin()});
