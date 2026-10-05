const $=id=>document.getElementById(id);
let me=null,aiEnabled=false,cards=[],due=[],dueIndex=0,loop=false,autoPlay=false,isSpeaking=false,settings={},generated=[],editId=null,notes=[],currentNoteId=null,currentGeneratedNoteId=null;
let quizSessionId=null,quizQuestions=[],quizIndex=0,quizStats={correct:0,partial:0,wrong:0},selectedChoice="";
let ttsVoices=[],voiceCursor={zh:0,en:0},ttsInfoState={enabled:false,provider:"browser"},currentAudio=null;
let feynmanHistory=[],feynmanLastQuestion="",feynmanRecognition=null,feynmanListening=false,feynmanRecognitionBase="",feynmanSessionId=null,feynmanSessions=[];
let feynmanRealtimeActive=false,feynmanProcessing=false,feynmanAiSpeaking=false,feynmanSilenceTimer=null,feynmanPendingText="",feynmanInterimText="";

async function api(path,opts={}){
  const res=await fetch("/api"+path,{...opts,headers:{"Content-Type":"application/json",...(opts.headers||{})}});
  const text=await res.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={error:text}}
  if(res.status===401){showLogin();throw new Error("请先登录")}
  if(!res.ok)throw new Error(data.error||("HTTP "+res.status));return data;
}
function esc(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function showLogin(){$("loginScreen").classList.remove("hidden");$("app").classList.add("hidden")}
function showApp(){$("loginScreen").classList.add("hidden");$("app").classList.remove("hidden")}
function go(id){
  document.querySelectorAll(".page").forEach(x=>x.classList.remove("active"));$(id).classList.add("active");
  document.querySelectorAll(".nav button").forEach(x=>x.classList.toggle("active",x.dataset.page===id));
  const t={homePage:"首页",todayPage:"今日复习",importPage:"AI 整理笔记",notesPage:"笔记库",quizPage:"AI 测试",feynmanPage:"费曼模式",libraryPage:"知识库",statsPage:"学习统计",settingsPage:"设置"};
  $("pageTitle").textContent=t[id]||"MemoryCast";if(id==="statsPage")loadStats();if(id==="notesPage")loadNotes();
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
    ["卡片",loadCards],["今日复习",loadDue],["设置",loadSettings],["TTS",loadTtsInfo],["费曼记忆",loadFeynmanSessions],["统计",loadStats],["笔记",loadNotes]
  ];
  const results=await Promise.allSettled(tasks.map(([,fn])=>fn()));
  const failed=results.map((r,i)=>r.status==="rejected"?tasks[i][0]:null).filter(Boolean);
  if(failed.length){
    console.error("Initial modules failed:",failed,results);
    $("syncText").textContent="部分模块加载失败："+failed.join("、");
  }
}
async function loadCards(){const d=await api("/cards");cards=d.cards||[];$("homeCards").textContent=cards.length;renderLibrary();renderCategories();renderFeynmanTopics();$("syncText").textContent=cards.length+" 个知识点已同步"}
async function loadDue(){const d=await api("/due");due=d.cards||[];dueIndex=Math.min(dueIndex,Math.max(0,due.length-1));$("homeDue").textContent=due.length;renderDue()}
function renderDue(){
  const c=due[dueIndex];
  if(!c){$("cardCat").textContent="DONE";$("cardFront").textContent="今天的复习完成了 🎉";$("cardBack").textContent="可以去做 AI 测试或添加新知识。";$("cardExample").textContent="";$("cardProgress").textContent="0 / 0"}
  else{$("cardCat").textContent=(c.tags||[]).join(" · ")+" · "+c.stateName;$("cardFront").textContent=c.front;$("cardBack").textContent=c.back;$("cardExample").textContent=c.example||"";$("cardProgress").textContent=(dueIndex+1)+" / "+due.length}
  $("queueList").innerHTML=due.map((x,i)=>'<div class="card-item"><div><b>'+esc(x.front)+'</b><div class="muted">'+esc(x.back)+'</div></div><span class="chip">'+(i===dueIndex?"当前":esc(x.stateName))+'</span></div>').join("")||'<div class="muted">今天没有到期卡片。</div>';
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
  speechSynthesis.cancel();
  if(currentAudio){
    currentAudio.pause();
    currentAudio.src="";
    currentAudio=null;
  }
}
function browserSpeakPart(part,cb){
  const u=new SpeechSynthesisUtterance(part.text);
  u.lang=part.lang;
  const profile=voiceStyleProfile(part.lang);
  u.pitch=profile.pitch;
  u.volume=1;
  const baseRate=part.lang==="zh-CN"
    ? Number(settings.chinese_rate||1.0)
    : Number(settings.english_rate||1.0);
  u.rate=Math.max(0.6,Math.min(1.6,baseRate*profile.rate));
  const voice=pickVoice(part.lang);
  if(voice)u.voice=voice;
  u.onend=()=>cb&&cb();
  u.onerror=()=>cb&&cb();
  speechSynthesis.speak(u);
}
async function neuralSpeakMixed(parts,cb,styleOverride=null){
  const payloadParts=parts.map(part=>({
    text:part.text,
    language:part.lang,
    style:styleOverride||voiceStyleName(part.lang),
    rate:part.lang==="zh-CN"
      ? Number(settings.chinese_rate||1.0)
      : Number(settings.english_rate||1.0)
  }));
  try{
    const res=await fetch("/api/tts",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({parts:payloadParts})
    });
    if(!res.ok)throw new Error("Neural TTS HTTP "+res.status);
    const blob=await res.blob();
    const url=URL.createObjectURL(blob);
    const audio=new Audio(url);
    currentAudio=audio;
    const finish=()=>{
      URL.revokeObjectURL(url);
      if(currentAudio===audio)currentAudio=null;
      cb&&cb();
    };
    audio.onended=finish;
    audio.onerror=()=>{
      URL.revokeObjectURL(url);
      if(currentAudio===audio)currentAudio=null;
      let i=0;
      const fallback=()=>{
        if(i>=parts.length){cb&&cb();return}
        browserSpeakPart(parts[i++],fallback);
      };
      fallback();
    };
    await audio.play();
  }catch(err){
    console.warn("Azure mixed TTS unavailable; using browser fallback:",err.message);
    let i=0;
    const fallback=()=>{
      if(i>=parts.length){cb&&cb();return}
      browserSpeakPart(parts[i++],fallback);
    };
    fallback();
  }
}
function speakOne(text,cb,styleOverride=null){
  if(!text){if(cb)cb();return}
  const parts=splitByLanguage(text);
  if(!parts.length){if(cb)cb();return}
  if(ttsInfoState.enabled){
    neuralSpeakMixed(parts,cb,styleOverride);
    return;
  }
  let i=0;
  const run=()=>{
    if(i>=parts.length){if(cb)cb();return}
    browserSpeakPart(parts[i++],run);
  };
  run();
}
function speakCurrent(){
  const c=due[dueIndex];if(!c)return;
  autoPlay=true;
  isSpeaking=true;
  stopAllTts();
  $("speakBtn").textContent="⏸ 停止";
  const arr=[c.front,c.back,c.example].filter(Boolean);
  const run=i=>{
    if(!autoPlay){isSpeaking=false;$("speakBtn").textContent="🔊 朗读";return}
    if(i>=arr.length){
      const moved=nextDue();
      if(moved){
        setTimeout(()=>speakCurrent(),700);
      }else{
        autoPlay=false;isSpeaking=false;$("speakBtn").textContent="🔊 朗读";
      }
      return;
    }
    speakOne(arr[i],()=>setTimeout(()=>run(i+1),350));
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
  const d=await api("/notes/"+id);
  const n=d.note;currentNoteId=n.id;
  $("manualReviewPanel").classList.remove("hidden");
  $("manualNoteTitle").textContent=n.title;
  $("manualNoteMeta").textContent='自主复习 '+(n.manualReviewCount||0)+' 次'+(n.lastReviewedAt?' · 上次 '+new Date(n.lastReviewedAt).toLocaleString():'');
  $("manualNoteContent").textContent=n.content;
  $("speakNoteBtn").disabled=false;
  $("markNoteReviewedBtn").disabled=false;
  $("editNoteBtn").disabled=false;
  $("deleteNoteBtn").disabled=false;
}
function speakSelectedNote(){
  if(!currentNoteId)return;
  const n=notes.find(x=>x.id===currentNoteId);
  if(!n)return;
  speechSynthesis.cancel();
  speakOne(n.content);
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
  const d=await api("/notes/"+currentNoteId,{method:"PUT",body:JSON.stringify({title,content})});
  const i=notes.findIndex(x=>x.id===currentNoteId);
  if(i>=0)notes[i]=d.note;
  $("manualNoteTitle").textContent=d.note.title;
  $("manualNoteContent").textContent=d.note.content;
  $("noteModal").classList.add("hidden");
  renderNotes();
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
  $("speakNoteBtn").disabled=true;
  $("markNoteReviewedBtn").disabled=true;
  $("editNoteBtn").disabled=true;
  $("deleteNoteBtn").disabled=true;
  $("manualReviewPanel").classList.add("hidden");
  renderNotes();
  await Promise.all([loadCards(),loadDue()]);
  if(result?.deletedCards>0) alert("笔记已删除，同时删除了 "+result.deletedCards+" 张相关卡片。");
}

async function organize(){
  const text=$("noteInput").value.trim();if(!text)return alert("请先粘贴笔记");const b=$("organizeBtn");b.disabled=true;b.textContent="AI 整理中…";
  try{const d=await api("/ai/organize",{method:"POST",body:JSON.stringify({text,splitMode:$("cardSplitMode").value})});currentGeneratedNoteId=d.note?.id||null;generated=d.cards||[];loadNotes();$("generatedCards").innerHTML='<div class="muted" style="margin-bottom:10px">✓ 原始笔记已保存到笔记库，不会因生成卡片而删除。</div>'+generated.map(c=>'<div class="mini-card"><div class="eyebrow">'+(c.tags||[]).map(esc).join(" · ")+'</div><b>'+esc(c.front)+'</b><div>'+esc(c.back)+'</div><div class="muted">'+esc(c.example||"")+'</div></div>').join("");$("saveGeneratedBtn").classList.toggle("hidden",!generated.length)}
  catch(e){alert(e.message)}finally{b.disabled=!aiEnabled;b.textContent="✨ AI 整理为卡片"}
}
async function saveGenerated(){const d=await api("/ai/organize/save",{method:"POST",body:JSON.stringify({cards:generated,noteId:currentGeneratedNoteId})});generated=[];currentGeneratedNoteId=null;$("generatedCards").innerHTML='<div class="muted">已保存 '+d.cards.length+' 张卡片。</div>';$("saveGeneratedBtn").classList.add("hidden");await Promise.all([loadCards(),loadDue()])}

async function generateQuiz(){
  const b=$("generateQuizBtn");b.disabled=true;b.textContent="AI 出题中…";
  try{const d=await api("/quiz/generate",{method:"POST",body:JSON.stringify({mode:$("quizMode").value,count:Number($("quizCount").value)})});quizSessionId=d.sessionId;quizQuestions=d.questions;quizIndex=0;quizStats={correct:0,partial:0,wrong:0};$("quizTitle").textContent=d.title;$("quizEmpty").classList.add("hidden");$("quizResult").classList.add("hidden");$("quizArea").classList.remove("hidden");renderQuiz()}
  catch(e){alert(e.message)}finally{b.disabled=!aiEnabled;b.textContent="✨ AI 出题"}
}
function renderQuiz(){
  const q=quizQuestions[quizIndex];if(!q)return finishQuiz();selectedChoice="";$("quizProgress").textContent=(quizIndex+1)+" / "+quizQuestions.length;
  $("quizType").textContent={mcq:"选择题",fill:"填空题",short:"简答题",listening:"听力题"}[q.type]||q.type;$("quizPrompt").textContent=q.prompt;$("listenQuizBtn").classList.toggle("hidden",q.type!=="listening");
  $("quizChoices").innerHTML=q.type==="mcq"?q.choices.map((x,i)=>'<button class="quiz-choice" data-choice="'+esc(x)+'">'+String.fromCharCode(65+i)+". "+esc(x)+"</button>").join(""):"";
  $("quizAnswer").value="";$("quizAnswer").classList.toggle("hidden",q.type==="mcq");$("quizFeedback").className="feedback hidden";$("nextQuizBtn").classList.add("hidden");$("submitQuizBtn").classList.remove("hidden");
  document.querySelectorAll(".quiz-choice").forEach(b=>b.onclick=()=>{document.querySelectorAll(".quiz-choice").forEach(x=>x.classList.remove("selected"));b.classList.add("selected");selectedChoice=b.dataset.choice});
}
async function submitQuiz(){
  const q=quizQuestions[quizIndex],answer=q.type==="mcq"?selectedChoice:$("quizAnswer").value.trim();if(!answer)return alert("请先作答");const b=$("submitQuizBtn");b.disabled=true;b.textContent="AI 判分中…";
  try{const d=await api("/quiz/grade",{method:"POST",body:JSON.stringify({sessionId:quizSessionId,questionId:q.id,answer})});quizStats[d.verdict]=(quizStats[d.verdict]||0)+1;const label=d.verdict==="correct"?"✅ 正确":d.verdict==="partial"?"🟡 基本正确":"❌ 错误";const box=$("quizFeedback");box.className="feedback "+d.verdict;box.innerHTML="<b>"+label+"</b><br>"+esc(d.feedback)+"<br><b>参考答案：</b>"+esc(d.correctAnswer)+"<br><b>解释：</b>"+esc(d.explanation)+'<br><span class="muted">FSRS：'+esc(d.fsrsRating)+"</span>";b.classList.add("hidden");$("nextQuizBtn").classList.remove("hidden");await Promise.all([loadCards(),loadDue(),loadStats()])}
  catch(e){alert(e.message)}finally{b.disabled=false;b.textContent="提交答案"}
}
function finishQuiz(){$("quizArea").classList.add("hidden");$("quizResult").classList.remove("hidden");$("quizResult").innerHTML='<div class="quiz-empty"><b style="font-size:34px">'+quizStats.correct+"/"+quizQuestions.length+"</b><br>正确 "+quizStats.correct+" · 基本正确 "+quizStats.partial+" · 错误 "+quizStats.wrong+'<br><span class="muted">错误和不完整答案已经影响对应卡片的 FSRS 排期。</span></div>'}

async function loadFeynmanSessions(){
  try{
    const d=await api("/feynman/sessions");
    feynmanSessions=d.sessions||[];
    const sel=$("feynmanSessionSelect");
    if(sel){
      const current=feynmanSessionId||sel.value||"";
      sel.innerHTML='<option value="">新会话</option>'+
        feynmanSessions.map(s=>{
          const when=new Date(s.last_turn_at||s.updated_at||s.created_at).toLocaleString();
          return '<option value="'+esc(s.id)+'">'+esc(s.topic)+' · '+esc(when)+'</option>';
        }).join("");
      sel.value=feynmanSessions.some(s=>s.id===current)?current:"";
    }
  }catch(e){
    console.warn("Failed to load Feynman sessions:",e.message);
  }
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

async function openFeynmanSession(id){
  if(!id){
    resetFeynman();
    return;
  }
  try{
    const d=await api("/feynman/sessions/"+id);
    feynmanSessionId=d.session.id;
    $("feynmanSessionSelect").value=feynmanSessionId;
    $("feynmanTopic").value=d.session.topic||"";
    feynmanHistory=(d.turns||[]).map(t=>({role:t.role,text:t.content}));
    renderFeynmanHistory();

    const lastAi=[...(d.turns||[])].reverse().find(t=>t.role==="ai");
    if(lastAi?.metadata) applyFeynmanAiMetadata(lastAi.metadata);
    else{
      $("feynmanEmpty").classList.remove("hidden");
      $("feynmanResult").classList.add("hidden");
      $("feynmanScore").textContent="等待讲解";
    }

    $("feynmanInput").value="";
    feynmanRecognitionBase="";
    $("feynmanInput").placeholder=feynmanLastQuestion
      ? "继续回答上一次追问："+feynmanLastQuestion
      : "继续讲你的理解……";
  }catch(e){
    alert(e.message);
  }
}

function renderFeynmanTopics(){
  const list=$("feynmanTopicList");if(!list)return;
  const seen=new Set();
  list.innerHTML=cards.filter(c=>{
    const key=String(c.front||"").trim();
    if(!key||seen.has(key))return false;
    seen.add(key);return true;
  }).slice(0,80).map(c=>'<option value="'+esc(c.front)+'"></option>').join("");
}
function renderFeynmanHistory(){
  const box=$("feynmanHistory");if(!box)return;
  if(!feynmanHistory.length){box.innerHTML="";return}
  box.innerHTML='<div class="eyebrow" style="margin-top:18px">本次对话</div>'+
    feynmanHistory.map(x=>
      '<div class="feynman-turn '+(x.role==="user"?"user":"ai")+'"><b>'+(x.role==="user"?"你":"AI 学生")+'</b><div>'+esc(x.text)+'</div></div>'
    ).join("");
}
function setFeynmanRealtimeUi(){
  if(!$("submitFeynmanBtn"))return;
  $("submitFeynmanBtn").textContent=feynmanRealtimeActive?"停止实时对话":"开始实时对话";
  $("feynmanMicTitle").textContent=feynmanRealtimeActive
    ? (feynmanAiSpeaking?"AI 正在说话…":feynmanProcessing?"AI 正在思考…":"正在实时倾听…")
    : "点击开始实时对话";
  if(feynmanRealtimeActive){
    $("feynmanMicBtn").classList.add("listening");
  }else{
    $("feynmanMicBtn").classList.remove("listening");
  }
}

function clearFeynmanSilenceTimer(){
  if(feynmanSilenceTimer){
    clearTimeout(feynmanSilenceTimer);
    feynmanSilenceTimer=null;
  }
}

function scheduleFeynmanRealtimeTurn(delay=1300){
  clearFeynmanSilenceTimer();
  if(!feynmanRealtimeActive||feynmanProcessing||feynmanAiSpeaking)return;
  if(!feynmanPendingText.trim())return;
  feynmanSilenceTimer=setTimeout(()=>processFeynmanRealtimeTurn(),delay);
}

function resetFeynman(){
  feynmanRealtimeActive=false;
  feynmanProcessing=false;
  feynmanAiSpeaking=false;
  clearFeynmanSilenceTimer();
  stopAllTts();
  if(feynmanRecognition&&feynmanListening){
    try{feynmanRecognition.stop()}catch{}
  }
  feynmanSessionId=null;
  if($("feynmanSessionSelect"))$("feynmanSessionSelect").value="";
  feynmanHistory=[];feynmanLastQuestion="";
  feynmanRecognitionBase="";
  feynmanPendingText="";
  feynmanInterimText="";
  $("feynmanInput").value="";
  $("feynmanEmpty").classList.remove("hidden");
  $("feynmanResult").classList.add("hidden");
  $("feynmanScore").textContent="等待讲解";
  $("feynmanMicStatus").textContent="开始后会持续监听；自然停顿时自动判断是否需要追问。";
  setFeynmanRealtimeUi();
  renderFeynmanHistory();
}

function setupFeynmanRecognition(){
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Recognition){
    $("feynmanMicBtn").disabled=true;
    $("submitFeynmanBtn").disabled=true;
    $("feynmanMicStatus").textContent="当前浏览器不支持实时语音识别，请使用最新版 Edge / Chrome。";
    return;
  }
  const recognition=new Recognition();
  recognition.continuous=true;
  recognition.interimResults=true;
  recognition.lang="zh-CN";

  recognition.onstart=()=>{
    feynmanListening=true;
    if(feynmanRealtimeActive&&!feynmanAiSpeaking){
      $("feynmanMicStatus").textContent="正在听。自然讲就行，停顿后我会判断是否需要插话。";
    }
    setFeynmanRealtimeUi();
  };

  recognition.onspeechstart=()=>{
    if(!feynmanRealtimeActive)return;
    clearFeynmanSilenceTimer();
    if(feynmanAiSpeaking){
      stopAllTts();
      feynmanAiSpeaking=false;
      $("feynmanMicStatus").textContent="你打断了 AI，我继续听你说。";
      setFeynmanRealtimeUi();
    }
  };

  recognition.onresult=e=>{
    let finalText="",interim="";
    for(let i=e.resultIndex;i<e.results.length;i++){
      const text=e.results[i][0]?.transcript||"";
      if(e.results[i].isFinal)finalText+=text;
      else interim+=text;
    }

    if(feynmanAiSpeaking&&(finalText.trim()||interim.trim())){
      stopAllTts();
      feynmanAiSpeaking=false;
      setFeynmanRealtimeUi();
    }

    if(finalText.trim()){
      feynmanPendingText=(feynmanPendingText+" "+finalText).trim();
      feynmanRecognitionBase=(feynmanRecognitionBase+" "+finalText).trim();
      feynmanInterimText="";
      scheduleFeynmanRealtimeTurn(700);
    }else{
      feynmanInterimText=interim.trim();
    }

    $("feynmanInput").value=(feynmanRecognitionBase+(feynmanInterimText?" "+feynmanInterimText:"")).trim();
  };

  recognition.onspeechend=()=>{
    if(feynmanRealtimeActive&&!feynmanAiSpeaking)scheduleFeynmanRealtimeTurn(550);
  };

  recognition.onerror=e=>{
    if(e.error==="not-allowed"){
      feynmanRealtimeActive=false;
      $("feynmanMicStatus").textContent="没有麦克风权限。请允许此 HTTPS 网站使用麦克风。";
      setFeynmanRealtimeUi();
      return;
    }
    if(e.error!=="no-speech"&&e.error!=="aborted"){
      $("feynmanMicStatus").textContent="语音识别暂时中断，正在尝试恢复…";
    }
  };

  recognition.onend=()=>{
    feynmanListening=false;
    if(feynmanRealtimeActive){
      setTimeout(()=>{
        if(feynmanRealtimeActive&&!feynmanListening){
          try{recognition.start()}catch{}
        }
      },250);
    }else{
      setFeynmanRealtimeUi();
    }
  };

  feynmanRecognition=recognition;
}

function startFeynmanRecognition(){
  if(!feynmanRecognition)setupFeynmanRecognition();
  if(!feynmanRecognition||feynmanListening)return;
  try{feynmanRecognition.start()}catch{}
}

function stopFeynmanRealtime(){
  feynmanRealtimeActive=false;
  feynmanProcessing=false;
  feynmanAiSpeaking=false;
  clearFeynmanSilenceTimer();
  stopAllTts();
  if(feynmanRecognition&&feynmanListening){
    try{feynmanRecognition.stop()}catch{}
  }
  $("feynmanMicStatus").textContent="实时对话已停止。再次点击即可继续。";
  setFeynmanRealtimeUi();
}

function startFeynmanRealtime(){
  const topic=$("feynmanTopic").value.trim();
  if(!topic){
    alert("先填写一个要讲解的主题。");
    $("feynmanTopic").focus();
    return;
  }
  if(!aiEnabled){
    alert("AI 尚未配置。");
    return;
  }
  feynmanRealtimeActive=true;
  feynmanRecognitionBase="";
  feynmanPendingText="";
  feynmanInterimText="";
  $("feynmanInput").value="";
  $("feynmanMicStatus").textContent="正在启动实时监听…";
  setFeynmanRealtimeUi();
  startFeynmanRecognition();
}

function toggleFeynmanRealtime(){
  if(feynmanRealtimeActive)stopFeynmanRealtime();
  else startFeynmanRealtime();
}

async function processFeynmanRealtimeTurn(){
  if(!feynmanRealtimeActive||feynmanProcessing||feynmanAiSpeaking)return;
  const topic=$("feynmanTopic").value.trim();
  const explanation=feynmanPendingText.trim();
  if(!topic||!explanation)return;

  feynmanPendingText="";
  feynmanRecognitionBase="";
  feynmanInterimText="";
  $("feynmanInput").value="";
  feynmanProcessing=true;
  $("feynmanMicStatus").textContent="我听到了，正在判断要不要插话…";
  setFeynmanRealtimeUi();

  try{
    const d=await api("/feynman/realtime",{method:"POST",body:JSON.stringify({
      topic,explanation,sessionId:feynmanSessionId
    })});

    feynmanSessionId=d.sessionId||feynmanSessionId;
    feynmanHistory.push({role:"user",text:explanation});
    feynmanHistory=feynmanHistory.slice(-12);
    feynmanLastQuestion=d.question||"";

    $("feynmanEmpty").classList.add("hidden");
    $("feynmanResult").classList.remove("hidden");
    $("feynmanUnderstood").textContent=d.action==="intervene"
      ?"这里有一个值得停下来想清楚的点。"
      :"这段逻辑可以继续展开。";
    $("feynmanStrengths").innerHTML='<div class="muted">实时模式优先速度，不生成逐项点评。</div>';
    $("feynmanGaps").innerHTML=d.action==="intervene"
      ? '<div>→ '+esc(d.question||"")+'</div>'
      : '<div class="muted">暂时没有值得打断的关键漏洞。</div>';
    $("feynmanQuestion").textContent=d.question||"继续讲，我在听。";
    $("feynmanScore").textContent="清晰度 "+Number(d.clarityScore||0)+"%";
    $("feynmanStatus").textContent=d.action==="intervene"
      ?"我只问这一处。"
      :"我先不打断。";
    renderFeynmanHistory();

    feynmanProcessing=false;
    if(d.action==="intervene"&&d.question){
      feynmanHistory.push({role:"ai",text:d.question});
      feynmanHistory=feynmanHistory.slice(-12);
      renderFeynmanHistory();
      feynmanAiSpeaking=true;
      $("feynmanMicStatus").textContent="我想追问一句；你可以直接开口打断我。";
      setFeynmanRealtimeUi();

      // Speak first. Refreshing the session selector must never delay the voice.
      loadFeynmanSessions().then(()=>{
        if($("feynmanSessionSelect")&&feynmanSessionId)$("feynmanSessionSelect").value=feynmanSessionId;
      }).catch(()=>{});

      speakOne(d.question,()=>{
        feynmanAiSpeaking=false;
        if(feynmanRealtimeActive){
          $("feynmanMicStatus").textContent="我说完了，继续讲吧。";
          setFeynmanRealtimeUi();
          startFeynmanRecognition();
        }
      },"conversation");
    }else{
      loadFeynmanSessions().then(()=>{
        if($("feynmanSessionSelect")&&feynmanSessionId)$("feynmanSessionSelect").value=feynmanSessionId;
      }).catch(()=>{});
      $("feynmanMicStatus").textContent="继续讲，我在听。";
      setFeynmanRealtimeUi();
    }
  }catch(e){
    feynmanProcessing=false;
    feynmanPendingText=(explanation+" "+feynmanPendingText).trim();
    $("feynmanMicStatus").textContent="刚才判断失败，已保留你的内容。继续讲或稍后重试。";
    setFeynmanRealtimeUi();
    console.error(e);
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
    reminder_timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"
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

function closeMobileNav(){document.body.classList.remove("mobile-nav-open")}
function toggleMobileNav(){document.body.classList.toggle("mobile-nav-open")}
document.querySelectorAll("[data-page]").forEach(b=>b.onclick=()=>{go(b.dataset.page);closeMobileNav()});
document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
$("mobileMenuBtn").onclick=toggleMobileNav;
$("sidebarBackdrop").onclick=closeMobileNav;
$("logoutBtn").onclick=async()=>{await api("/auth/logout",{method:"POST"});location.reload()};$("watchBtn").onclick=()=>document.body.classList.toggle("watch");
$("speakBtn").onclick=toggleSpeak;$("nextCardBtn").onclick=()=>{autoPlay=false;isSpeaking=false;stopAllTts();$("speakBtn").textContent="🔊 朗读";nextDue()};$("loopBtn").onclick=()=>{loop=!loop;$("loopBtn").textContent="↻ 循环："+(loop?"开":"关");if(loop)speakCurrent()};
document.querySelectorAll("[data-rating]").forEach(b=>b.onclick=()=>grade(b.dataset.rating));$("searchInput").oninput=renderLibrary;$("categoryFilter").onchange=renderLibrary;$("newCardBtn").onclick=openNew;
$("modalClose").onclick=()=>$("modal").classList.add("hidden");$("modalSave").onclick=saveModal;$("organizeBtn").onclick=organize;$("saveGeneratedBtn").onclick=saveGenerated;
$("generateQuizBtn").onclick=generateQuiz;$("submitQuizBtn").onclick=submitQuiz;$("nextQuizBtn").onclick=()=>{quizIndex++;renderQuiz()};$("listenQuizBtn").onclick=()=>{const q=quizQuestions[quizIndex];if(q&&q.audioText)speakOne(q.audioText)};$("feynmanMicBtn").onclick=toggleFeynmanRealtime;$("submitFeynmanBtn").onclick=toggleFeynmanRealtime;$("clearFeynmanInputBtn").onclick=()=>{$("feynmanInput").value="";feynmanRecognitionBase="";feynmanPendingText="";feynmanInterimText=""};$("resetFeynmanBtn").onclick=resetFeynman;$("speakFeynmanQuestionBtn").onclick=()=>{if(feynmanLastQuestion)speakOne(feynmanLastQuestion)};$("feynmanSessionSelect").onchange=()=>openFeynmanSession($("feynmanSessionSelect").value);$("saveSettingsBtn").onclick=saveSettings;$("pushToggleBtn").onclick=togglePush;$("englishVoice").onchange=()=>localStorage.setItem("memorycast_en_voice",$("englishVoice").value);$("chineseVoice").onchange=()=>localStorage.setItem("memorycast_zh_voice",$("chineseVoice").value);$("englishVoiceStyle").onchange=()=>localStorage.setItem("memorycast_en_voice_style",$("englishVoiceStyle").value);$("chineseVoiceStyle").onchange=()=>localStorage.setItem("memorycast_zh_voice_style",$("chineseVoiceStyle").value);$("noteSearch").oninput=renderNotes;$("speakNoteBtn").onclick=speakSelectedNote;$("markNoteReviewedBtn").onclick=markSelectedNoteReviewed;$("editNoteBtn").onclick=openNoteEdit;$("deleteNoteBtn").onclick=deleteCurrentNote;$("noteModalClose").onclick=()=>$("noteModal").classList.add("hidden");$("noteModalSave").onclick=saveNoteEdit;
refreshVoices();speechSynthesis.onvoiceschanged=refreshVoices;setupFeynmanRecognition();init().catch(e=>{console.error(e);showLogin()});
