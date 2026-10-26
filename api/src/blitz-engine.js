// Listening Blitz scoring and adaptive selection; no browser or database dependencies.
export const DURATIONS=[20,45,90];
export const SKILLS=["detail","gist","intent","inference","sound"];
export const SKILL_NAMES={detail:"细节捕捉",gist:"主旨理解",intent:"说话人意图",inference:"信息推断",sound:"语音辨认"};
export function questionCount(seconds){return seconds===20?1:seconds===90?3:2;}
export function cleanAnswer(input){
  return String(input??"").normalize("NFKC").toLowerCase().trim()
    .replace(/[\u2018\u2019]/g,"'").replace(/[.,!?;:，。？！；：]/g,"")
    .replace(/\s+/g," ");
}
export function gradeQuestion(q,response){
  const actual=cleanAnswer(response);
  if(!actual)return false;
  const valid=(q.type==="mcq"?[q.answer]:(q.accepted||[q.answer])).map(cleanAnswer);
  return valid.includes(actual);
}
export function validateLesson(x,seconds){
  const n=questionCount(seconds);
  if(!x||typeof x.transcript!=="string"||x.transcript.trim().length<15||
    x.transcript.length>1450||!Array.isArray(x.questions)||x.questions.length<n)return false;
  const words=x.transcript.trim().split(/\s+/).length;
  if(words<(seconds===20?8:seconds===45?13:22)||
    words>(seconds===20?55:seconds===45?85:125))return false;
  return x.questions.every(q=>
    q&&SKILLS.includes(q.skill)&&["mcq","fill"].includes(q.type)&&
    typeof q.prompt==="string"&&q.prompt.trim().length>5&&
    typeof q.answer==="string"&&q.answer.trim()&&
    typeof q.explanation==="string"&&q.explanation.trim()&&
    typeof q.evidence==="string"&&q.evidence.trim()&&x.transcript.includes(q.evidence.trim())&&
    (q.type==="fill"?(Array.isArray(q.accepted)&&q.accepted.length>=1&&q.accepted.length<=4&&
      q.accepted.every(a=>typeof a==="string"&&a.trim()&&a.length<=45)):
      Array.isArray(q.choices)&&q.choices.length===4&&new Set(q.choices).size===4&&
      q.choices.every(a=>typeof a==="string"&&a.trim()&&a.length<=150)&&
      q.choices.includes(q.answer))
  );
}
export function publicQuestions(questions,n){
  return questions.slice(0,n).map((q,i)=>({
    id:"q"+(i+1),type:q.type,skill:q.skill,prompt:q.prompt,
    ...(q.type==="mcq"?{choices:q.choices}:{} )
  }));
}
export function pickDifficulty(history=[]){
  const recent=history.slice(0,12).filter(h=>h?.total>0);
  if(recent.length<3)return "B1";
  const total=recent.reduce((n,s)=>n+s.total,0);
  const correct=recent.reduce((n,s)=>n+s.score,0);
  const ratio=correct/Math.max(1,total);
  if(ratio>=.88)return "B2";
  if(ratio<.45)return "A2";
  return "B1";
}
export function weakestSkill(history=[]){
  const tally=new Map(SKILLS.map(k=>[k,{n:0,c:0}]));
  for(const session of history.slice(0,30)){
    for(const q of (session?.results||[])){
      if(!tally.has(q.skill))continue;
      const t=tally.get(q.skill);t.n++;if(q.correct)t.c++;
    }
  }
  const eligible=[...tally].filter(([,v])=>v.n>=2);
  if(!eligible.length)return SKILLS[0];
  eligible.sort((a,b)=>(a[1].c/a[1].n)-(b[1].c/b[1].n)||b[1].n-a[1].n);
  return eligible[0][0];
}
export function evaluate(questions,answers,playCount){
  const n=Math.max(0,Math.floor(Number(playCount)||0));
  const firstListen=n===1;
  const results=questions.map((q,i)=>({
    id:"q"+(i+1),skill:q.skill,type:q.type,
    response:String(answers["q"+(i+1)]??"").trim().slice(0,180),
    correct:gradeQuestion(q,answers["q"+(i+1)]),
    answer:q.answer,explanation:q.explanation,evidence:q.evidence
  }));
  const score=results.filter(x=>x.correct).length;
  return {score,total:results.length,firstListen,playCount:n,results};
}
export function aggregate(sessions,days,now=Date.now()){
  const start=now-days*86400000;
  const eligible=sessions.filter(s=>s.completed_at&&new Date(s.completed_at).getTime()>=start);
  let total=0,correct=0,firstTotal=0,firstCorrect=0,assisted=0;
  const bySkill=Object.fromEntries(SKILLS.map(k=>[k,{correct:0,total:0}]));
  const daily=new Map();
  for(const s of eligible){
    const result=s.result||{};
    const day=new Date(s.completed_at).toISOString().slice(0,10);
    const bucket=daily.get(day)||{day,sessions:0,correct:0,total:0,firstListen:0,firstCorrect:0};
    bucket.sessions++;
    if(result.firstListen)bucket.firstListen++;
    for(const q of result.results||[]){
      total++;bucket.total++;
      if(q.correct){correct++;bucket.correct++;}
      if(result.firstListen){firstTotal++;if(q.correct){firstCorrect++;bucket.firstCorrect++;}}
      else assisted++;
      if(bySkill[q.skill]){
        bySkill[q.skill].total++;
        if(q.correct)bySkill[q.skill].correct++;
      }
    }
    daily.set(day,bucket);
  }
  return {days,sessions:eligible.length,total,correct,accuracy:total?Math.round(correct/total*100):null,
    firstTotal,firstCorrect,firstAccuracy:firstTotal?Math.round(firstCorrect/firstTotal*100):null,
    assistedQuestions:assisted,bySkill,daily:[...daily.values()].sort((a,b)=>a.day.localeCompare(b.day))};
}
