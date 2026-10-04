const $=id=>document.getElementById(id);
let me=null,aiEnabled=false,cards=[],due=[],dueIndex=0,loop=false,autoPlay=false,isSpeaking=false,settings={},generated=[],editId=null;
let quizSessionId=null,quizQuestions=[],quizIndex=0,quizStats={correct:0,partial:0,wrong:0},selectedChoice="";

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
  const t={homePage:"首页",todayPage:"今日复习",importPage:"AI 整理笔记",quizPage:"AI 测试",libraryPage:"知识库",statsPage:"学习统计",settingsPage:"设置"};
  $("pageTitle").textContent=t[id]||"MemoryCast";if(id==="statsPage")loadStats();
}
async function init(){
  const auth=await fetch("/api/auth/me").then(r=>r.json());aiEnabled=!!auth.aiEnabled;
  $("aiStatusLogin").textContent=aiEnabled?"AI 已连接":"AI 尚未配置；基础复习仍可使用";
  if(!auth.user){showLogin();return}me=auth.user;showApp();$("username").textContent=me.login;$("avatar").src=me.avatarUrl||"";
  $("aiDisabledImport").classList.toggle("hidden",aiEnabled);$("aiDisabledQuiz").classList.toggle("hidden",aiEnabled);
  $("organizeBtn").disabled=!aiEnabled;$("generateQuizBtn").disabled=!aiEnabled;
  await Promise.all([loadCards(),loadDue(),loadSettings(),loadStats()]);
}
async function loadCards(){const d=await api("/cards");cards=d.cards||[];$("homeCards").textContent=cards.length;renderLibrary();renderCategories();$("syncText").textContent=cards.length+" 个知识点已同步"}
async function loadDue(){const d=await api("/due");due=d.cards||[];dueIndex=Math.min(dueIndex,Math.max(0,due.length-1));$("homeDue").textContent=due.length;renderDue()}
function renderDue(){
  const c=due[dueIndex];
  if(!c){$("cardCat").textContent="DONE";$("cardFront").textContent="今天的复习完成了 🎉";$("cardBack").textContent="可以去做 AI 测试或添加新知识。";$("cardExample").textContent="";$("cardProgress").textContent="0 / 0"}
  else{$("cardCat").textContent=(c.tags||[]).join(" · ")+" · "+c.stateName;$("cardFront").textContent=c.front;$("cardBack").textContent=c.back;$("cardExample").textContent=c.example||"";$("cardProgress").textContent=(dueIndex+1)+" / "+due.length}
  $("queueList").innerHTML=due.map((x,i)=>'<div class="card-item"><div><b>'+esc(x.front)+'</b><div class="muted">'+esc(x.back)+'</div></div><span class="chip">'+(i===dueIndex?"当前":esc(x.stateName))+'</span></div>').join("")||'<div class="muted">今天没有到期卡片。</div>';
}
function lang(t){return /[\u3400-\u9fff]/.test(t)?"zh-CN":"en-US"}
function speakOne(text,cb){if(!text){if(cb)cb();return}const u=new SpeechSynthesisUtterance(text);u.lang=lang(text);u.rate=u.lang==="zh-CN"?Number(settings.chinese_rate||1.0):Number(settings.english_rate||$("ttsRate").value||1.0);u.onend=()=>cb&&cb();speechSynthesis.speak(u)}
function speakCurrent(){
  const c=due[dueIndex];if(!c)return;
  autoPlay=true;
  isSpeaking=true;
  speechSynthesis.cancel();
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
    autoPlay=false;isSpeaking=false;speechSynthesis.cancel();
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
async function saveModal(){const body={front:$("mFront").value.trim(),back:$("mBack").value.trim(),example:$("mExample").value.trim()};if(!body.front||!body.back)return alert("请填写正面和背面");await api(editId?"/cards/"+editId:"/cards",{method:editId?"PUT":"POST",body:JSON.stringify(body)});$("modal").classList.add("hidden");await Promise.all([loadCards(),loadDue()])}
async function deleteCard(id){if(!confirm("删除这张卡片？"))return;await api("/cards/"+id,{method:"DELETE"});await Promise.all([loadCards(),loadDue()])}

async function organize(){
  const text=$("noteInput").value.trim();if(!text)return alert("请先粘贴笔记");const b=$("organizeBtn");b.disabled=true;b.textContent="AI 整理中…";
  try{const d=await api("/ai/organize",{method:"POST",body:JSON.stringify({text})});generated=d.cards||[];$("generatedCards").innerHTML=generated.map(c=>'<div class="mini-card"><div class="eyebrow">'+(c.tags||[]).map(esc).join(" · ")+'</div><b>'+esc(c.front)+'</b><div>'+esc(c.back)+'</div><div class="muted">'+esc(c.example||"")+'</div></div>').join("");$("saveGeneratedBtn").classList.toggle("hidden",!generated.length)}
  catch(e){alert(e.message)}finally{b.disabled=!aiEnabled;b.textContent="✨ AI 整理为卡片"}
}
async function saveGenerated(){const d=await api("/ai/organize/save",{method:"POST",body:JSON.stringify({cards:generated})});generated=[];$("generatedCards").innerHTML='<div class="muted">已保存 '+d.cards.length+' 张卡片。</div>';$("saveGeneratedBtn").classList.add("hidden");await Promise.all([loadCards(),loadDue()])}

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

async function loadStats(){if(!me)return;const d=await api("/stats");$("homeCards").textContent=d.cards;$("homeReviews").textContent=d.reviews;$("homeAccuracy").textContent=d.quizAccuracy==null?"—":d.quizAccuracy+"%";$("statCards").textContent=d.cards;$("statReviews").textContent=d.reviews;$("statAccuracy").textContent=d.quizAccuracy==null?"—":d.quizAccuracy+"%";$("statLast7").textContent=d.last7;$("categoryStats").innerHTML=(d.categories||[]).map(x=>'<div class="card-item"><div><b>'+esc(x.category)+'</b><div class="muted">平均 FSRS difficulty '+Number(x.avg_difficulty||0).toFixed(2)+'</div></div><span class="chip">'+x.count+" 张</span></div>").join("")||'<div class="muted">暂无统计。</div>'}
async function loadSettings(){
  settings=await api("/settings");
  $("retentionSetting").value=String(Number(settings.fsrs_retention).toFixed(2));
  $("englishRate").value=String(settings.english_rate||1);
  $("chineseRate").value=String(settings.chinese_rate||1);
  $("ttsRate").value="1";
  $("dailyGoal").value=settings.daily_goal;
  $("reminderTime").value=String(settings.reminder_time||"09:00").slice(0,5);
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

document.querySelectorAll("[data-page]").forEach(b=>b.onclick=()=>go(b.dataset.page));document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
$("logoutBtn").onclick=async()=>{await api("/auth/logout",{method:"POST"});location.reload()};$("watchBtn").onclick=()=>document.body.classList.toggle("watch");
$("speakBtn").onclick=toggleSpeak;$("nextCardBtn").onclick=()=>{autoPlay=false;isSpeaking=false;speechSynthesis.cancel();$("speakBtn").textContent="🔊 朗读";nextDue()};$("loopBtn").onclick=()=>{loop=!loop;$("loopBtn").textContent="↻ 循环："+(loop?"开":"关");if(loop)speakCurrent()};
document.querySelectorAll("[data-rating]").forEach(b=>b.onclick=()=>grade(b.dataset.rating));$("searchInput").oninput=renderLibrary;$("categoryFilter").onchange=renderLibrary;$("newCardBtn").onclick=openNew;
$("modalClose").onclick=()=>$("modal").classList.add("hidden");$("modalSave").onclick=saveModal;$("organizeBtn").onclick=organize;$("saveGeneratedBtn").onclick=saveGenerated;
$("generateQuizBtn").onclick=generateQuiz;$("submitQuizBtn").onclick=submitQuiz;$("nextQuizBtn").onclick=()=>{quizIndex++;renderQuiz()};$("listenQuizBtn").onclick=()=>{const q=quizQuestions[quizIndex];if(q&&q.audioText)speakOne(q.audioText)};$("saveSettingsBtn").onclick=saveSettings;$("pushToggleBtn").onclick=togglePush;
init().catch(e=>{console.error(e);showLogin()});
