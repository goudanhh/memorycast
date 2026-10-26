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
