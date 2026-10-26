// Shared, dependency-free game rules: also exercised by scripts/check-games.mjs.
export const GAME_MODES = ["match", "listen", "spell", "recall"];

export function normalizeAnswer(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en")
    .replace(/[‘’]/g, "'").replace(/[‐‑–—]/g, "-")
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .replace(/\s+/g, " ");
}

export function isSpellingCard(card) {
  const front = String(card?.front ?? "").trim();
  return /^[A-Za-z][A-Za-z' -]{1,54}$/.test(front) &&
    normalizeAnswer(front) !== normalizeAnswer(card?.back);
}

export function shuffle(input, random = Math.random) {
  const result = [...input];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function uniqueGameCards(input) {
  const seenFront = new Set(), seenBack = new Set(), result = [];
  for (const c of input || []) {
    const front = String(c?.front ?? "").trim();
    const back = String(c?.back ?? "").trim();
    const f = normalizeAnswer(front), b = normalizeAnswer(back);
    if (!c?.id || !f || !b || f === b || front.length > 90 || back.length > 160) continue;
    if (seenFront.has(f) || seenBack.has(b)) continue;
    seenFront.add(f); seenBack.add(b);
    result.push({...c, front, back});
  }
  return result;
}

export function makeListeningOptions(card, pool, count = 4, random = Math.random) {
  const wrong = uniqueGameCards(pool).filter(c=>c.id!==card.id &&
    normalizeAnswer(c.back)!==normalizeAnswer(card.back));
  if (wrong.length < count-1) return [];
  return shuffle([card, ...shuffle(wrong,random).slice(0,count-1)], random)
    .map(c=>({id:c.id, label:c.back}));
}

export function scoreForResult(mode, correct, elapsedMs=0, usedHint=false) {
  if (!correct) return 0;
  const base = mode==="spell"?16:mode==="listen"?12:10;
  return Math.max(1, base - (usedHint?5:0) - Math.min(4,Math.floor(Math.max(0,elapsedMs)/12000)));
}


// Keep the persisted mode identifiers for backward-compatible game history.
export const CHALLENGES = Object.freeze({
  match:{title:"闪电生存战",limit:60,lives:3,round:11,count:15},
  listen:{title:"音速追击",limit:0,lives:3,round:18,count:10},
  spell:{title:"极限拼写",limit:0,lives:3,round:17,count:10},
  recall:{title:"错题 Boss 战",limit:0,lives:0,round:0,count:6}
});

// Priority-biased variety: pick primarily weak/due cards without always
// choosing the identical top-N entries at every start.
export function chooseChallengeCards(cards, count, random=Math.random) {
  const ordered=uniqueGameCards(cards).sort((a,b)=>Number(b.priority||0)-Number(a.priority||0));
  const window=ordered.slice(0,Math.min(ordered.length,Math.max(count*3,12)));
  const top=window.slice(0,Math.min(count,window.length));
  const variety=window.slice(top.length);
  // At most 1/3 of the round comes from outside the highest-priority bucket.
  const replacements=Math.min(Math.floor(count/3),variety.length);
  const selected=shuffle(top,random).slice(replacements)
    .concat(shuffle(variety,random).slice(0,replacements));
  return shuffle(selected,random);
}

export function challengeKind(mode,card,index) {
  if(mode==="spell")return "type";
  if(mode==="recall")return "recall";
  if(mode==="listen")return "audio";
  // Every third survival question requires actual typed recall,
  // not simply recognizing a multiple-choice option.
  return index%3===2 && isSpellingCard(card)?"type":"choice";
}
export function comboMultiplier(streak) {
  return Math.min(4,1+Math.floor(Math.max(0,streak)/3));
}
export function secondsLeft(end, now) {
  return Math.max(0,Math.ceil((end-now)/1000));
}
export function isAudioEligible(card){
  const front=String(card?.front||"");
  return /[a-z]/i.test(front) && !/[\u3400-\u9fff]/.test(front) && front.length<=90;
}
