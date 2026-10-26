// Short, scored listening bursts. This module is isolated from the existing
// AI listening exam, walkman and FSRS scheduling.
import {SKILL_NAMES,DURATIONS,questionCount} from "./blitz-ui-engine.js?v=1";
const $=id=>document.getElementById(id);
const escapeHtml=x=>String(x??"").replace(/[&<>"']/g,k=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[k]));
const PAGES=["blitzWelcome","blitzWorkout","blitzResults"];
let duration=45,statsDays=7,current=null,loading=false,localPlays=0,
  ttsText=null,ttsLoading=null,ownSpeech=null,audioError=false,result=null,startTime=0;
const audio=$("blitzAudio");
const api=async(path,options={})=>{
  const res=await fetch("/api"+path,{
    ...options,headers:{"Content-Type":"application/json",...(options.headers||{})}
  });
  let body={};try{body=await res.json()}catch{}
  if(!res.ok)throw Error(body.error||"HTTP "+res.status);
  return body;
};
function show(name){PAGES.forEach(p=>$(p).classList.toggle("hidden",p!==name))}
function inform(message="",bad=false){
  $("blitzStatus").textContent=message;
  $("blitzStatus").classList.toggle("error",bad);
}
function stopAudio(){
  audio.pause();audio.currentTime=0;
  if(ownSpeech){speechSynthesis.cancel();ownSpeech=null}
}
function setLoading(active){
  loading=active;
  $("blitzStart").disabled=active;
  $("blitzRetry").disabled=active;
}
async function loadInsights(){
  try{
    const x=await api("/blitz/insights?days="+statsDays);
    const fmt=v=>v===null||v===undefined?"—":v+"%";
    $("blitzSessionCount").textContent=x.sessions||0;
    $("blitzFirstAccuracy").textContent=fmt(x.firstAccuracy);
    $("blitzTotalAccuracy").textContent=fmt(x.accuracy);
    $("blitzQuestionCount").textContent=x.total||0;
    $("blitzFocus").textContent=(x.skillLabels||SKILL_NAMES)[x.focus]||"细节捕捉";
    const skills=Object.entries(x.bySkill||{});
    $("blitzSkills").innerHTML=skills.map(([key,v])=>{
      const percent=v.total?Math.round(v.correct/v.total*100):0;
      return '<div class="blitz-skill-item"><div><strong>'+escapeHtml((x.skillLabels||SKILL_NAMES)[key]||key)+
        '</strong><small>'+(v.total?percent+"% · "+v.total+" 题":"暂无作答")+'</small></div>'+
        '<div class="blitz-meter"><i style="width:'+percent+'%"></i></div></div>';
    }).join("");
    if(!x.daily?.length){
      $("blitzTrend").innerHTML='<p class="blitz-empty">还没有训练记录。完成一次闪击后，这里会开始累计每日听力表现。</p>';
    }else{
      $("blitzTrend").innerHTML=x.daily.slice(-20).map(d=>{
        const accuracy=d.total?Math.round(d.correct/d.total*100):0;
        return '<div class="blitz-chart-day" title="'+d.day+' · '+d.correct+'/'+d.total+
          ' 题"><div class="blitz-chart-track"><i style="height:'+
          Math.max(5,accuracy)+'%"></i></div><small>'+d.day.slice(5)+'</small></div>';
      }).join("");
    }
    $("blitzRecent").innerHTML=(x.recent||[]).slice(0,5).map(r=>
      '<div><span>'+escapeHtml(r.topic)+'</span><strong>'+r.score+'/'+r.total+
      '</strong><small>'+(r.firstListen?"首听":"重听后")+'</small></div>'
    ).join("")||'<p class="blitz-empty">暂无记录</p>';
  }catch(err){inform("暂时无法同步能力统计："+err.message,true)}
}
function warmNext(){
  // Optional AI material is generated while the current round is running,
  // never in the critical path of the current one-tap listening session.
  api("/blitz/prepare",{method:"POST",body:JSON.stringify({duration})}).catch(()=>{});
}
async function fetchSpeechFallback(){
  if(!current)return;
  if(ttsText)return ttsText;
  if(!ttsLoading){
    const id=current.sessionId;
    ttsLoading=api("/blitz/browser-speech/"+id).then(data=>{
      if(current?.sessionId===id)ttsText=data.speechText;
      return data.speechText;
    }).finally(()=>ttsLoading=null);
  }
  return ttsLoading;
}
async function begin(){
  if(loading)return;
  stopAudio();setLoading(true);inform("正在取出一段全新的听力…");
  try{
    const x=await api("/blitz/start",{method:"POST",body:JSON.stringify({duration})});
    current=x;result=null;localPlays=0;ttsText=null;ttsLoading=null;audioError=false;
    startTime=performance.now();
    audio.removeAttribute("src");audio.load();
    $("blitzWorkoutTitle").textContent=x.title;
    $("blitzWorkoutMeta").textContent=x.level+" · "+x.topic+" · "+
      questionCount(duration)+" 题 · 目标约 "+duration+" 秒";
    $("blitzWorkoutFocus").textContent="本轮重点："+(SKILL_NAMES[x.focus]||"听力理解");
    $("blitzPlayCount").textContent="0 次";
    $("blitzSource").textContent=x.origin==="ai"?"AI 新材料":"精选短听力";
    $("blitzSubmit").disabled=true;
    $("blitzAudioState").textContent="先播放声音，暂不显示文字。";
    $("blitzAnswers").innerHTML=x.questions.map((q,i)=>{
      const heading='<div class="blitz-question-title"><span>Q'+(i+1)+
        '</span><strong>'+escapeHtml(q.prompt)+'</strong></div>'+
        '<small class="blitz-question-skill">'+escapeHtml(SKILL_NAMES[q.skill]||"理解")+'</small>';
      if(q.type==="fill")return '<div class="blitz-question" data-q="'+q.id+'">'+heading+
        '<input type="text" class="blitz-answer-input" data-fill="'+q.id+
        '" placeholder="输入英文单词、数字或时间" aria-label="第'+(i+1)+'题填空" autocomplete="off" maxlength="120"></div>';
      return '<div class="blitz-question" data-q="'+q.id+'">'+heading+
        '<div class="blitz-options">'+q.choices.map((answer,j)=>
          '<label><input type="radio" name="blitz-'+q.id+'" value="'+escapeHtml(answer)+
          '"/><span><b>'+String.fromCharCode(65+j)+'</b>'+escapeHtml(answer)+'</span></label>'
        ).join("")+'</div></div>';
    }).join("");
    $("blitzAnswers").querySelectorAll("input").forEach(i=>i.addEventListener("input",validateForm));
    show("blitzWorkout");
    inform("准备就绪：第一遍尽量只听一次，然后直接答题。");
    // Only fetch text from the server for the browser speech fallback;
    // never render it before grading.
    fetchSpeechFallback().catch(()=>{});
    warmNext();
  }catch(err){inform("开始失败："+err.message,true)}
  finally{setLoading(false)}
}
function validateForm(){
  if(!current)return;
  let all=localPlays>0;
  for(const q of current.questions){
    const field=$("blitzAnswers").querySelector('[data-fill="'+q.id+'"]');
    if(field){if(!field.value.trim())all=false}
    else if(!$("blitzAnswers").querySelector('input[name="blitz-'+q.id+'"]:checked'))all=false;
  }
  $("blitzSubmit").disabled=!all||loading;
}
function browserSpeak(text,rate){
  if(!("speechSynthesis" in window)||!window.SpeechSynthesisUtterance)throw Error("此浏览器不支持语音朗读");
  speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(text);
  u.lang="en-US";u.rate=rate;u.pitch=1;u.volume=1;
  const available=speechSynthesis.getVoices().filter(v=>v.lang.toLowerCase().startsWith("en"));
  u.voice=available.find(v=>v.lang==="en-US")||available[0]||null;
  ownSpeech=u;speechSynthesis.speak(u);
}
let playBusy=false;
async function play(){
  if(!current||playBusy)return;
  playBusy=true;
  const rate=Number($("blitzRate").value)||1;
  $("blitzPlay").disabled=true;
  $("blitzAudioState").textContent="正在播放英语…";
  try{
    // The playback counter is kept by the server, not trusted from the form.
    const marker=api("/blitz/play/"+current.sessionId,{method:"POST",body:"{}"});
    if(audioError){
      if(!ttsText){$("blitzAudioState").textContent="语音正在加载，请再点一次播放。";await fetchSpeechFallback();}
      // In Safari, a second gesture is needed after asynchronous voice loading.
      browserSpeak(ttsText,rate);
    }else{
      audio.src=current.audioUrl;
      audio.playbackRate=rate;
      try{await audio.play()}
      catch(err){
        audioError=true;
        await fetchSpeechFallback();
        $("blitzAudioState").textContent="服务器音频不可用，切换到浏览器语音。请再点一次播放。";
      }
    }
    const count=await marker;
    localPlays=count.plays;
    $("blitzPlayCount").textContent=localPlays+" 次";
    if(localPlays>1)inform("当前已重听 "+(localPlays-1)+" 次；结果会与首听成绩区分。");
    validateForm();
  }catch(err){$("blitzAudioState").textContent="播放失败："+err.message;inform(err.message,true)}
  finally{playBusy=false;$("blitzPlay").disabled=false}
}
audio.addEventListener("ended",()=>{$("blitzAudioState").textContent="音频结束。可以作答，或按需要重新播放。"});
audio.addEventListener("error",()=>{audioError=true;});
function readAnswers(){
  return Object.fromEntries(current.questions.map(q=>{
    const field=$("blitzAnswers").querySelector('[data-fill="'+q.id+'"]');
    return [q.id,field?field.value.trim():
      ($("blitzAnswers").querySelector('input[name="blitz-'+q.id+'"]:checked')?.value||"")];
  }));
}
async function submit(){
  if(!current||loading||localPlays<1)return;
  const answers=readAnswers();
  if(current.questions.some(q=>!answers[q.id]))return inform("请先完成本次全部题目。",true);
  setLoading(true);
  try{
    result=await api("/blitz/submit/"+current.sessionId,{
      method:"POST",body:JSON.stringify({answers})
    });
    stopAudio();
    $("blitzScore").textContent=result.score+" / "+result.total;
    $("blitzScoringType").textContent=result.firstListen?
      "首听完成 · 计入首听理解率":"有重听辅助 · 不计入首听理解率";
    $("blitzExplanation").innerHTML=result.results.map((q,i)=>
      '<article class="blitz-feedback-item '+(q.correct?"correct":"incorrect")+'">'+
      '<div><strong>'+(q.correct?"✓":"↺")+' 第 '+(i+1)+' 题 · '+escapeHtml(SKILL_NAMES[q.skill]||"理解")+
      '</strong><span>'+(q.correct?"回答正确":"还需要练习")+'</span></div>'+
      '<p><b>你选择的：</b>'+escapeHtml(q.response||"（未作答）")+'</p>'+
      '<p><b>正确答案：</b>'+escapeHtml(q.answer)+'</p>'+
      '<p><b>解析：</b>'+escapeHtml(q.explanation)+'</p>'+
      '<p><b>原文依据：</b>'+escapeHtml(q.evidence)+'</p></article>'
    ).join("");
    $("blitzTranscript").textContent=result.transcript;
    $("blitzReplayTotal").textContent=result.playCount+" 次";
    $("blitzDoneNote").textContent="首听结果、重听次数和错误类型均已保存。新素材会优先覆盖你的薄弱技能；这不是官方 TOEFL/IELTS 分数。";
    show("blitzResults");
    inform("已保存本次结果。");
    loadInsights();
  }catch(err){inform("提交未成功："+err.message,true)}
  finally{setLoading(false);validateForm()}
}
function changeDays(days){
  statsDays=days;
  document.querySelectorAll("[data-blitz-days]").forEach(b=>{
    const active=Number(b.dataset.blitzDays)===statsDays;
    b.classList.toggle("active",active);b.setAttribute("aria-pressed",String(active));
  });
  loadInsights();
}
$("blitzStart").onclick=begin;
$("blitzRetry").onclick=begin;
$("blitzPlay").onclick=play;
$("blitzSubmit").onclick=submit;
$("blitzBack").onclick=()=>{
  stopAudio();current=null;show("blitzWelcome");inform();
  loadInsights();
};
$("blitzNext").onclick=()=>{current=null;show("blitzWelcome");begin();};
$("blitzTranscriptReplay").onclick=()=>{
  if(result?.transcript)try{browserSpeak(result.transcript,1)}catch(e){inform(e.message,true)}
};
document.querySelectorAll("[data-blitz-duration]").forEach(button=>
  button.addEventListener("click",()=>{
    duration=Number(button.dataset.blitzDuration);
    document.querySelectorAll("[data-blitz-duration]").forEach(b=>
      b.classList.toggle("active",b===button));
    $("blitzTiming").textContent=duration===20?"1 题 · 极短辨音":
      duration===45?"2 题 · 标准闪击":"3 题 · 短对话理解";
  })
);
document.querySelectorAll("[data-blitz-days]").forEach(button=>
  button.addEventListener("click",()=>changeDays(Number(button.dataset.blitzDays)))
);
document.querySelector('[data-page="blitzPage"]')?.addEventListener("click",loadInsights);
document.querySelector('[data-go="blitzPage"]')?.addEventListener("click",loadInsights);
document.querySelectorAll(".nav [data-page]").forEach(button=>{
  if(button.dataset.page!=="blitzPage")button.addEventListener("click",()=>{if(current)stopAudio()})
});
