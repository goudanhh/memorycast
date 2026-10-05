import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PROVIDER=(process.env.TTS_PROVIDER||"browser").toLowerCase();
const REGION=(process.env.AZURE_SPEECH_REGION||"").trim();
const KEY=(process.env.AZURE_SPEECH_KEY||"").trim();
const CACHE_DIR=process.env.TTS_CACHE_DIR||"/app/tts-cache";

function escapeXml(value=""){
  return String(value)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&apos;");
}

function smartStyle(text,language){
  const s=String(text||"").trim();
  const isZh=language==="zh-CN";
  const conversational=isZh
    ? /[？！!?]|“[^”]+”|‘[^’]+’|\b(哈哈|好的|其实|感觉|可以|怎么|为什么)\b/.test(s)
    : /[!?]|["“][^"”]+["”]|\b(hey|yeah|okay|actually|really|gonna|wanna|how|why)\b/i.test(s);

  const explanatory=s.length>(isZh?55:90) ||
    /[:：；;]|\b(because|therefore|means|defined|refers to|principle|mechanism)\b/i.test(s) ||
    /(定义|原理|机制|原因|因此|意味着|指的是|包括|主要)/.test(s);

  if(conversational && !explanatory) return "lazy";
  if(explanatory) return "host";
  return "natural";
}

function ssmlEscapeWithNumbers(value=""){
  const text=String(value||"");
  const tokenRe=/(\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b|\b\d+\.\d+\b|\b\d+\b)/g;
  let out="";
  let last=0;

  for(const match of text.matchAll(tokenRe)){
    const idx=match.index??0;
    out+=escapeXml(text.slice(last,idx));
    const token=match[0];

    if(/^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}$/.test(token)){
      out+=`<say-as interpret-as="date" format="ymd">${escapeXml(token)}</say-as>`;
    }else{
      out+=`<say-as interpret-as="cardinal">${escapeXml(token)}</say-as>`;
    }
    last=idx+token.length;
  }

  out+=escapeXml(text.slice(last));
  return out;
}

function ssmlTextWithPauses(value=""){
  const text=String(value);
  const pauseMap={
    "，":"180ms", ",":"160ms",
    "；":"280ms", ";":"260ms",
    "：":"240ms", ":":"220ms",
    "。":"460ms", ".":"420ms",
    "！":"500ms", "!":"460ms",
    "？":"520ms", "?":"480ms",
    "、":"120ms"
  };

  let out="";
  let buf="";
  const flush=()=>{
    if(!buf)return;
    out+=ssmlEscapeWithNumbers(buf);
    buf="";
  };

  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==="\n"){
      flush();
      const next=text[i+1];
      if(next==="\n"){
        out+='<break time="700ms"/>';
        i++;
      }else{
        out+='<break time="360ms"/>';
      }
      continue;
    }
    if(pauseMap[ch]){
      // A period immediately after a digit is often a numbered-list marker (1. 2. 3.),
      // not a sentence-ending full stop.
      if(ch==="." && /\d/.test(text[i-1]||"") && /\s/.test(text[i+1]||"")){
        flush();
        out+='<break time="140ms"/>';
        continue;
      }
      flush();
      out+=escapeXml(ch)+`<break time="${pauseMap[ch]}"/>`;
      continue;
    }
    buf+=ch;
  }
  flush();
  return out;
}

function configFor(language,style,text=""){
  const lang=language==="zh-CN"?"zh-CN":"en-US";
  const requested=["smart","natural","host","lazy","conversation"].includes(style)?style:"smart";
  const mode=requested==="smart"?smartStyle(text,lang):requested;

  if(lang==="zh-CN"){
    if(mode==="conversation"){
      return {locale:"zh-CN",voice:"zh-CN-YunxiNeural",express:"chat",rateMultiplier:1.03,pitch:"0%"};
    }
    if(mode==="host"){
      return {locale:"zh-CN",voice:"zh-CN-YunyangNeural",express:"narration-professional",rateMultiplier:0.96,pitch:"-2%"};
    }
    if(mode==="lazy"){
      return {locale:"zh-CN",voice:"zh-CN-XiaoyiNeural",express:"gentle",rateMultiplier:0.90,pitch:"+5%"};
    }
    return {locale:"zh-CN",voice:"zh-CN-XiaoxiaoNeural",express:null,rateMultiplier:1,pitch:"0%"};
  }

  if(mode==="conversation"){
    return {locale:"en-US",voice:"en-US-AriaNeural",express:"chat",rateMultiplier:1.02,pitch:"0%"};
  }
  if(mode==="host"){
    return {locale:"en-US",voice:"en-US-AriaNeural",express:"narration-professional",rateMultiplier:0.96,pitch:"-2%"};
  }
  if(mode==="lazy"){
    return {locale:"en-US",voice:"en-US-JennyNeural",express:"chat",rateMultiplier:0.91,pitch:"+3%"};
  }
  return {locale:"en-US",voice:"en-US-JennyNeural",express:null,rateMultiplier:1,pitch:"0%"};
}

function ratePercent(baseRate,multiplier){
  const rate=Math.max(0.5,Math.min(2,Number(baseRate)||1))*multiplier;
  const pct=Math.round((rate-1)*100);
  return `${pct>=0?"+":""}${pct}%`;
}

function buildSsml(text,language,style,baseRate){
  const cfg=configFor(language,style,text);
  const prosody=`<prosody rate="${ratePercent(baseRate,cfg.rateMultiplier)}" pitch="${cfg.pitch}">${clearIsolatedFragment(text,lang)}</prosody>`;
  const body=cfg.express
    ? `<mstts:express-as style="${cfg.express}">${prosody}</mstts:express-as>`
    : prosody;

  return {
    cfg,
    ssml:`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${cfg.locale}"><voice name="${cfg.voice}">${body}</voice></speak>`
  };
}
function isShortInlineEnglish(text=""){
  const s=String(text).trim();
  if(!s)return false;
  if(/^[A-Za-z]$/.test(s))return true;
  if(/^[-–—]?(?:ed|ing|s|es|er|est|ly)$/i.test(s))return true;
  if(/^[A-Z]{2,4}$/.test(s))return true;
  if(/^(?:pH|CO2|CO₂|NOx|NOₓ|PM2\.5|PM10)$/i.test(s))return true;
  return false;
}

function inlineEnglishXml(text){
  const s=String(text).trim();
  if(/^[A-Za-z]$/.test(s)){
    return `<say-as interpret-as="characters">${escapeXml(s)}</say-as>`;
  }
  if(/^[A-Z]{2,4}$/.test(s)){
    return `<say-as interpret-as="characters">${escapeXml(s)}</say-as>`;
  }
  return escapeXml(s);
}

function clearIsolatedFragment(text="",language="en-US"){
  const raw=String(text||"");
  const trimmed=raw.trim();
  if(!trimmed)return ssmlTextWithPauses(raw);

  if(language==="en-US"){
    // A single letter must be spoken as its letter name, never swallowed as a
    // tiny word fragment.
    if(/^[A-Za-z]$/.test(trimmed)){
      return `<break time="30ms"/><prosody rate="-8%"><say-as interpret-as="characters">${escapeXml(trimmed)}</say-as></prosody><break time="35ms"/>`;
    }

    // Common technical abbreviations are clearer when spelled out.
    if(/^[A-Z]{2,5}$/.test(trimmed)){
      return `<break time="25ms"/><prosody rate="-6%"><say-as interpret-as="characters">${escapeXml(trimmed)}</say-as></prosody><break time="30ms"/>`;
    }

    // One isolated English word: keep it as a word, but slow it slightly and
    // protect both edges so consonants are not lost next to Chinese speech.
    if(/^[A-Za-z]+(?:['’-][A-Za-z]+)?$/.test(trimmed)){
      return `<break time="25ms"/><prosody rate="-7%">${escapeXml(trimmed)}</prosody><break time="30ms"/>`;
    }

    // Technical tokens such as CO2, NOx, PM2.5: articulate character groups.
    if(/^(?:[A-Za-z]{1,5}\d+(?:\.\d+)?|[A-Za-z]{2,5}[A-Za-z]?\d*)$/.test(trimmed) && /\d/.test(trimmed)){
      return `<break time="25ms"/><prosody rate="-7%"><say-as interpret-as="characters">${escapeXml(trimmed)}</say-as></prosody><break time="30ms"/>`;
    }
  }

  if(language==="zh-CN" && /^[\u3400-\u9fff]$/.test(trimmed)){
    return `<break time="20ms"/><prosody rate="-6%">${escapeXml(trimmed)}</prosody><break time="25ms"/>`;
  }

  return ssmlTextWithPauses(raw);
}

function dominantLocaleForParts(source){
  const all=source.map(p=>p.text).join("");
  const zh=(all.match(/[\u3400-\u9fff]/g)||[]).length;
  const en=(all.match(/[A-Za-z]/g)||[]).length;

  // Chinese text is information-dense; if Chinese is substantial, prefer the
  // Chinese-primary multilingual voice for the whole note.
  return zh>=8 && zh*1.45>=en ? "zh-CN" : "en-US";
}

function buildMixedSsml(parts){
  const source=parts.map(p=>({
    text:String(p.text||""),
    language:p.language==="zh-CN"?"zh-CN":"en-US",
    style:["smart","natural","host","lazy","conversation"].includes(p.style)?p.style:"smart",
    rate:Math.min(2,Math.max(.5,Number(p.rate||1)))
  })).filter(p=>p.text.trim());

  if(!source.length){
    return {normalized:[],ssml:""};
  }

  // Use ONE multilingual voice for the entire note. Switching <voice> nodes
  // mid-stream can cause audible gaps or truncated synthesis. We keep language
  // hints with <lang> so English and Chinese still get their own pronunciation.
  const dominant=dominantLocaleForParts(source);
  const voice=dominant==="zh-CN"
    ? (process.env.AZURE_ZH_MULTILINGUAL_VOICE||"zh-CN-YunxiaoMultilingualNeural")
    : (process.env.AZURE_EN_MULTILINGUAL_VOICE||process.env.AZURE_MULTILINGUAL_VOICE||"en-US-AvaMultilingualNeural");

  const avgRate=source.reduce((sum,p)=>sum+p.rate,0)/source.length;
  const body=source.map(p=>
    `<lang xml:lang="${p.language}">${clearIsolatedFragment(p.text,p.language)}</lang>`
  ).join("");

  const normalized=source.map(p=>({
    ...p,
    sourceLanguage:p.language,
    inline:false,
    cfg:{voice,locale:dominant},
    xml:""
  }));

  return {
    normalized,
    ssml:`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${dominant}"><voice name="${voice}"><prosody rate="${ratePercent(avgRate,1)}">${body}</prosody></voice></speak>`
  };
}

async function requestAzure(ssml){
  const response=await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,{
    method:"POST",
    headers:{
      "Ocp-Apim-Subscription-Key":KEY,
      "Content-Type":"application/ssml+xml",
      "X-Microsoft-OutputFormat":"audio-24khz-48kbitrate-mono-mp3",
      "User-Agent":"MemoryCast"
    },
    body:ssml
  });

  if(!response.ok){
    const detail=(await response.text()).slice(0,500);
    const err=new Error(`Azure TTS failed (${response.status})${detail?": "+detail:""}`);
    err.statusCode=502;
    throw err;
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function synthesizeMixedTts(parts){
  if(!hasAzureTts()){
    const err=new Error("Azure TTS is not configured");
    err.statusCode=503;
    throw err;
  }
  if(!Array.isArray(parts)||!parts.length){
    const err=new Error("TTS parts are required");
    err.statusCode=400;
    throw err;
  }

  const total=parts.reduce((n,p)=>n+String(p?.text||"").length,0);
  if(total>3000){
    const err=new Error("TTS text is too long");
    err.statusCode=400;
    throw err;
  }

  const {normalized,ssml}=buildMixedSsml(parts);
  if(!normalized.length){
    const err=new Error("TTS parts are empty");
    err.statusCode=400;
    throw err;
  }

  const cacheKey=crypto.createHash("sha256")
    .update("mixed-clear-isolated-v5|"+JSON.stringify(normalized.map(p=>({
      text:p.text,language:p.language,sourceLanguage:p.sourceLanguage||p.language,inline:p.inline===true,style:p.style,rate:p.rate,voice:p.cfg.voice
    }))))
    .digest("hex");
  const file=path.join(CACHE_DIR,`${cacheKey}.mp3`);

  await fs.mkdir(CACHE_DIR,{recursive:true});
  try{
    const cached=await fs.readFile(file);
    return {audio:cached,cacheHit:true,voice:"mixed"};
  }catch{}

  const audio=await requestAzure(ssml);
  await fs.writeFile(file,audio);
  return {audio,cacheHit:false,voice:"mixed"};
}

export function hasAzureTts(){
  return PROVIDER==="azure" && Boolean(REGION && KEY);
}

export function ttsInfo(){
  return {
    enabled:hasAzureTts(),
    provider:hasAzureTts()?"azure":"browser",
    region:hasAzureTts()?REGION:null,
    cache:true,
    styles:["smart","natural","host","lazy","conversation"],
    multilingualVoice:process.env.AZURE_EN_MULTILINGUAL_VOICE||process.env.AZURE_MULTILINGUAL_VOICE||"en-US-AvaMultilingualNeural",
    chineseMultilingualVoice:process.env.AZURE_ZH_MULTILINGUAL_VOICE||"zh-CN-YunxiaoMultilingualNeural"
  };
}

export async function synthesizeTts({text,language="en-US",style="smart",rate=1}){
  if(!hasAzureTts()){
    const err=new Error("Azure TTS is not configured");
    err.statusCode=503;
    throw err;
  }

  const clean=String(text||"").trim();
  if(!clean){
    const err=new Error("Text is required");
    err.statusCode=400;
    throw err;
  }
  if(clean.length>2000){
    const err=new Error("TTS text is too long");
    err.statusCode=400;
    throw err;
  }

  const {cfg,ssml}=buildSsml(clean,language,style,rate);
  const cacheKey=crypto.createHash("sha256")
    .update("single-clear-isolated-v2|"+JSON.stringify({text:clean,language:cfg.locale,voice:cfg.voice,style,rate}))
    .digest("hex");
  const file=path.join(CACHE_DIR,`${cacheKey}.mp3`);

  await fs.mkdir(CACHE_DIR,{recursive:true});
  try{
    const cached=await fs.readFile(file);
    return {audio:cached,cacheHit:true,voice:cfg.voice};
  }catch{}

  const audio=await requestAzure(ssml);
  await fs.writeFile(file,audio);
  return {audio,cacheHit:false,voice:cfg.voice};
}
