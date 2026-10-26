// Focused retrieval practice: explicit recall, interleaving, delayed retest.
// This module never changes FSRS scheduling.
export const MEMORY_PHASES=Object.freeze([
  {id:"retrieve",title:"第一轮 · 主动回忆",description:"先自己想，再核对答案；不要直接翻卡。",icon:"🧠"},
  {id:"interleave",title:"第二轮 · 交错提取",description:"打乱次序，部分题目反向提取；区分真正掌握与熟悉感。",icon:"🔀"},
  {id:"delayed",title:"第三轮 · 延迟复测",description:"经过其他知识点干扰后，不看提示再次独立回忆。",icon:"🎯"}
]);
export const VALID_GRADES=[0,1,2];
export const GRADE_NAMES={0:"没想起",1:"部分正确",2:"完全正确"};
export function normalizeRecall(value){
  return String(value??"").normalize("NFKC").trim().toLocaleLowerCase()
    .replace(/[‘’]/g,"'").replace(/[‐‑–—]/g,"-")
    .replace(/[\p{P}\p{S}]/gu,"").replace(/\s+/g," ");
}
export function matchesAnswer(answer,expected){
  const a=normalizeRecall(answer),b=normalizeRecall(expected);
  return !!a&&!!b&&a===b;
}
export function canReverse(card){
  return String(card?.front||"").trim().length<=64&&
    String(card?.back||"").trim().length<=64;
}
export function promptFor(card,phase,index){
  const reverse=phase==="interleave"&&index%2===0&&canReverse(card);
  return {question:reverse?card.back:card.front,
    expected:reverse?card.front:card.back,
    direction:reverse?"back-to-front":"front-to-back"};
}
export function practiceDeck(cards,count=6){
  const cleaned=[],fronts=new Set(),backs=new Set();
  for(const card of [...(cards||[])].sort((a,b)=>Number(b.priority||0)-Number(a.priority||0))){
    const front=String(card?.front||"").trim(),back=String(card?.back||"").trim();
    if(!card?.id||!front||!back||normalizeRecall(front)===normalizeRecall(back)||
      fronts.has(normalizeRecall(front))||backs.has(normalizeRecall(back)))continue;
    fronts.add(normalizeRecall(front));backs.add(normalizeRecall(back));
    cleaned.push({...card,front,back});
  }
  return cleaned.slice(0,Math.max(1,Math.min(8,Math.floor(Number(count)||6))));
}
// Deterministic alternate traversal, so one prompt is not repeated immediately.
// The final round is reversed again relative to round two.
export function stageOrder(cards,phase){
  const arr=[...(cards||[])];
  if(phase==="retrieve")return arr;
  if(phase==="interleave")return arr.filter((_,i)=>i%2===1).reverse()
    .concat(arr.filter((_,i)=>i%2===0));
  if(phase==="delayed")return arr.reverse();
  throw Error("Invalid memory stage");
}
export function scoreTrial(grade,phase,hint=false){
  if(!VALID_GRADES.includes(grade))return 0;
  const factor=phase==="delayed"?16:phase==="interleave"?12:10;
  return Math.max(0,grade*factor-(hint&&grade>0?5:0));
}
export function summarizeMemory(trials,cards){
  const latest=new Map();
  let score=0,fullyCorrect=0,partial=0,forgot=0;
  for(const t of trials||[]){
    score+=scoreTrial(t.grade,t.phase,t.hinted);
    latest.set(t.cardId,t.grade);
    if(t.grade===2)fullyCorrect++;else if(t.grade===1)partial++;else forgot++;
  }
  const weak=(cards||[]).filter(c=>!latest.has(c.id)||latest.get(c.id)<2);
  return {score,fullyCorrect,partial,forgot,weak,retained:(cards||[]).length-weak.length};
}
