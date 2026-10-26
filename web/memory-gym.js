import {
  MEMORY_PHASES,GRADE_NAMES,normalizeRecall,matchesAnswer,promptFor,
  stageOrder,summarizeMemory,scoreTrial
} from "./memory-engine.js?v=retrieval-1";
const $=id=>document.getElementById(id);
const safe=s=>String(s??"").replace(/[&<>"']/g,k=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[k]));
const stages=["memoryWelcome","memoryPreview","memoryTrainer","memoryFinish"];
let session=null,stage=0,item=0,entered="",hinted=false,blank=false,started=0,locked=false,trials=[],queue=[],focus="all";
function show(id){
  for(const x of stages)$(x).classList.toggle("hidden",x!==id);
}
function status(text="",bad=false){
  $("memoryStatus").textContent=text;$("memoryStatus").classList.toggle("error",bad);
}
async function api(path,options={}){
  const res=await fetch("/api"+path,{
    ...options,headers:{"Content-Type":"application/json",...(options.headers||{})}
  });
  let data={};try{data=await res.json()}catch{}
  if(!res.ok)throw Error(data.error||"HTTP "+res.status);
  return data;
}
function metrics(overview){
  const ss=overview.sessions||{},aa=overview.attempts||{};
  $("memorySessions").textContent=Number(ss.completed||0).toLocaleString();
  $("memorySessionsWeek").textContent=Number(ss.last7||0).toLocaleString();
  $("memoryAccuracy").textContent=Number(aa.delayed_total)>0?
    Math.round(100*Number(aa.delayed_correct||0)/Number(aa.delayed_total))+"%":"—";
  $("memoryTrials").textContent=Number(aa.trials||0).toLocaleString();
  const weak=overview.weak||[];
  $("memoryWeakList").innerHTML=weak.length?
    weak.map(c=>'<span class="memory-weak-chip">'+safe(c.front)+'</span>').join(""):
    '<span class="memory-no-weak">暂无历史弱项，先完成一组训练。</span>';
  $("memoryStartWeak").disabled=!weak.length;
}
async function openMemory(){
  if(session||locked)return;
  status();
  try{metrics(await api("/memory/overview"))}
  catch(e){status("统计暂时不可用："+e.message,true)}
}
async function beginTraining(kind="all",count=null){
  if(locked||session)return;
  locked=true;status();
  try{
    const payload={count:count||Number($("memoryCount").value),focus:kind};
    const res=await api("/memory/sessions",{method:"POST",body:JSON.stringify(payload)});
    session={id:res.sessionId,cards:res.cards||[]};
    if(!session.cards.length)throw Error("没有获取到训练卡片");
    focus=kind;stage=0;item=0;trials=[];
    renderPreview();
    show("memoryPreview");
    $("memoryPreview").scrollIntoView({block:"start",behavior:"smooth"});
    status("本次抽取 "+session.cards.length+" 张知识卡；由最该复习的内容优先组成。");
  }catch(e){session=null;status("无法开始："+e.message,true)}
  finally{locked=false}
}
function renderPreview(){
  const cards=session.cards;
  $("memoryPreviewCount").textContent=cards.length+" 个知识点";
  $("memoryPreviewCards").innerHTML=cards.map((card,i)=>
    '<article class="memory-preview-card"><span class="memory-small-tag">0'+(i+1)+'</span>'+
    '<h3>'+safe(card.front)+'</h3><p>'+safe(card.back)+'</p>'+
    (card.example?'<small>'+safe(card.example)+'</small>':'')+'</article>'
  ).join("");
}
function startRecall(){
  if(!session)return;
  stage=0;item=0;trials=[];queue=stageOrder(session.cards,MEMORY_PHASES[stage].id);
  show("memoryTrainer");renderQuestion();
}
function renderProgress(){
  const phase=MEMORY_PHASES[stage],card=queue[item];
  $("memoryPhase").textContent=phase.icon+" "+phase.title;
  $("memoryPhaseNote").textContent=phase.description;
  $("memoryPosition").textContent=(item+1)+" / "+queue.length;
  const total=session.cards.length*3,done=trials.length;
  $("memoryTotalCount").textContent=done+" / "+total;
  $("memoryMeterBar").style.width=done/total*100+"%";
  return card;
}
function renderQuestion(){
  if(!session||!queue?.[item])return;
  const card=renderProgress(),phase=MEMORY_PHASES[stage].id;
  const prompt=promptFor(card,phase,item);
  entered="";blank=false;hinted=false;locked=false;started=performance.now();
  $("memoryPrompt").textContent=prompt.question;
  $("memoryDirection").textContent=prompt.direction==="back-to-front"?
    "根据含义回忆原词 / 知识点":"不看答案，回忆释义与关键内容";
  $("memoryResponse").value="";
  $("memoryResponse").disabled=false;
  $("memoryResponse").placeholder=prompt.direction==="back-to-front"?
    "先想一想，再输入原词…":"输入你记得的含义、定义或关键点…";
  $("memoryHintText").textContent="";
  $("memoryHint").disabled=phase==="delayed";
  $("memoryHint").classList.toggle("hidden",phase==="delayed");
  $("memoryInputArea").classList.remove("hidden");
  $("memoryRevealArea").classList.add("hidden");
  $("memoryResponse").focus({preventScroll:true});
  status();
}
function reveal(unknown=false){
  if(locked||!session||!queue[item])return;
  entered=$("memoryResponse").value.trim();
  if(!unknown&&!entered){
    status("先写下你能想起来的内容；完全忘记请点击「想不起来」。",true);return;
  }
  blank=unknown;
  const card=queue[item],phase=MEMORY_PHASES[stage].id;
  const {expected}=promptFor(card,phase,item);
  $("memoryCorrectAnswer").textContent=expected;
  $("memoryMyAnswer").textContent=blank?"（没有想起来）":entered;
  $("memoryExample").textContent=card.example||"";
  $("memoryExample").classList.toggle("hidden",!card.example);
  $("memoryMatchHint").textContent=blank?"这张卡还需要重新练习。":
    matchesAnswer(entered,expected)?"✓ 文本完全匹配，建议核对语义后选「完全正确」。":
    "系统不强行用文字相似度判断对错，请自行对照关键概念和含义。";
  $("memoryInputArea").classList.add("hidden");
  $("memoryRevealArea").classList.remove("hidden");
  $("memoryRevealArea").querySelectorAll("[data-memory-grade]").forEach(b=>{
    b.disabled=locked||blank&&Number(b.dataset.memoryGrade)!==0;
  });
  status(blank?"这次没想起很正常，先认真看答案。":"根据真实回忆质量评分，而不是凭熟悉感。");
}
async function record(grade){
  if(!session||locked||!queue[item])return;
  if(![0,1,2].includes(grade)||blank&&grade!==0)return;
  const card=queue[item],phase=MEMORY_PHASES[stage].id;
  const prompt=promptFor(card,phase,item);
  locked=true;
  $("memoryRevealArea").querySelectorAll("[data-memory-grade]").forEach(b=>b.disabled=true);
  status("正在保存回忆记录…");
  const elapsedMs=Math.max(0,Math.min(600000,Math.floor(performance.now()-started)));
  try{
    await api("/memory/attempts",{method:"POST",body:JSON.stringify({
      sessionId:session.id,cardId:card.id,phase,direction:prompt.direction,
      response:blank?"":entered,grade,hinted,elapsedMs
    })});
    trials.push({cardId:card.id,phase,grade,hinted,elapsedMs});
    const outcome=grade===2?"记住了":grade===1?"部分掌握":"还需巩固";
    advance(outcome);
  }catch(err){
    status("保存失败，请重新点击评分："+err.message,true);
    locked=false;
    $("memoryRevealArea").querySelectorAll("[data-memory-grade]").forEach(b=>
      b.disabled=blank&&Number(b.dataset.memoryGrade)!==0);
  }
}
function advance(outcome){
  item++;
  if(item<queue.length){renderQuestion();return}
  if(stage<2){
    stage++;item=0;
    queue=stageOrder(session.cards,MEMORY_PHASES[stage].id);
    $("memoryInterludeIcon").textContent=MEMORY_PHASES[stage].icon;
    $("memoryInterludeTitle").textContent=MEMORY_PHASES[stage].title;
    $("memoryInterludeText").textContent=stage===1?
      "现在把题目顺序打乱，并穿插反向提取。不要看刚才的答案，试着直接回忆。":
      "最后一轮不提供提示。经过多道知识点交错后，再确认哪些真正留在记忆里。";
    $("memoryInterlude").classList.remove("hidden");
    $("memoryTrainerMain").classList.add("hidden");
    $("memoryContinuePhase").focus({preventScroll:true});
    return;
  }
  finalize();
}
function continuePhase(){
  $("memoryInterlude").classList.add("hidden");
  $("memoryTrainerMain").classList.remove("hidden");
  renderQuestion();
}
async function finalize(){
  if(!session)return;
  $("memoryFinishMessage").textContent="三轮回忆已完成，正在保存训练结果…";
  $("memoryFinishActions").classList.add("hidden");
  show("memoryFinish");
  const sum=summarizeMemory(trials,session.cards);
  $("memoryFinishScore").textContent=sum.score;
  $("memoryFinishRetained").textContent=sum.retained+" / "+session.cards.length;
  $("memoryFinishTrials").textContent=trials.length;
  $("memoryFinishWeak").innerHTML=sum.weak.length?
    sum.weak.map(c=>'<span class="memory-weak-chip">'+safe(c.front)+'</span>').join(""):
    '<span class="memory-all-done">本轮终局复测全部正确。未来仍建议隔天再测。</span>';
  // Show phase-by-phase results so users can tell recognition from recall.
  $("memoryPhaseResults").innerHTML=MEMORY_PHASES.map(p=>{
    const rows=trials.filter(t=>t.phase===p.id);
    const good=rows.filter(t=>t.grade===2).length;
    return '<div><strong>'+p.icon+' '+safe(p.title.split(" · ")[1])+'</strong>'+
      '<span>'+good+'/'+rows.length+' 完全正确</span></div>';
  }).join("");
  try{
    await api("/memory/sessions/"+encodeURIComponent(session.id)+"/complete",{method:"POST",body:"{}"});
    $("memoryFinishMessage").textContent="训练记录已保存。下次训练会优先考虑你未掌握的内容。";
    $("memoryFinishActions").classList.remove("hidden");
  }catch(e){
    $("memoryFinishMessage").textContent="结算尚未保存："+e.message;
    $("memoryFinishRetry").classList.remove("hidden");
    $("memoryFinishRetry").onclick=finalize;
    $("memoryFinishActions").classList.remove("hidden");
    $("memoryAnother").disabled=true;
  }
  status();
}
function stopTraining(){
  session=null;stage=0;item=0;queue=[];trials=[];blank=false;locked=false;
  $("memoryInterlude").classList.add("hidden");
  $("memoryTrainerMain").classList.remove("hidden");
  $("memoryFinishRetry").classList.add("hidden");
  $("memoryAnother").disabled=false;
  show("memoryWelcome");openMemory();
}
$("memoryStart").onclick=()=>beginTraining("all");
$("memoryStartWeak").onclick=()=>beginTraining("weak",4);
$("memoryBeginRecall").onclick=startRecall;
$("memoryReveal").onclick=()=>reveal(false);
$("memoryForgot").onclick=()=>reveal(true);
$("memoryHint").onclick=()=>{
  if(!session||locked||!queue[item])return;
  const {expected}=promptFor(queue[item],MEMORY_PHASES[stage].id,item);
  hinted=true;
  $("memoryHintText").textContent="提示：以「"+expected.trim().slice(0,Math.min(2,expected.length))+"」开头。提示会降低本题得分。";
  $("memoryHint").disabled=true;
};
$("memoryContinuePhase").onclick=continuePhase;
$("memoryExit").onclick=stopTraining;
$("memoryPreviewBack").onclick=stopTraining;
$("memoryAnother").onclick=stopTraining;
$("memoryRevealArea").querySelectorAll("[data-memory-grade]").forEach(b=>{
  b.onclick=()=>record(Number(b.dataset.memoryGrade));
});
$("memoryResponse").addEventListener("keydown",e=>{
  if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();reveal(false)}
});
document.querySelector('[data-page="gamesPage"]')?.addEventListener("click",openMemory);
document.querySelector('[data-go="gamesPage"]')?.addEventListener("click",openMemory);
