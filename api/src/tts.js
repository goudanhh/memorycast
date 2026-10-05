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

function configFor(language,style,text=""){
  const lang=language==="zh-CN"?"zh-CN":"en-US";
  const requested=["smart","natural","host","lazy"].includes(style)?style:"smart";
  const mode=requested==="smart"?smartStyle(text,lang):requested;

  if(lang==="zh-CN"){
    if(mode==="host"){
      return {locale:"zh-CN",voice:"zh-CN-YunyangNeural",express:"narration-professional",rateMultiplier:0.96,pitch:"-2%"};
    }
    if(mode==="lazy"){
      return {locale:"zh-CN",voice:"zh-CN-XiaoyiNeural",express:"gentle",rateMultiplier:0.90,pitch:"+5%"};
    }
    return {locale:"zh-CN",voice:"zh-CN-XiaoxiaoNeural",express:null,rateMultiplier:1,pitch:"0%"};
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
  const prosody=`<prosody rate="${ratePercent(baseRate,cfg.rateMultiplier)}" pitch="${cfg.pitch}">${escapeXml(text)}</prosody>`;
  const body=cfg.express
    ? `<mstts:express-as style="${cfg.express}">${prosody}</mstts:express-as>`
    : prosody;

  return {
    cfg,
    ssml:`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${cfg.locale}"><voice name="${cfg.voice}">${body}</voice></speak>`
  };
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
    styles:["smart","natural","host","lazy"]
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
    .update(JSON.stringify({text:clean,language:cfg.locale,voice:cfg.voice,style,rate}))
    .digest("hex");
  const file=path.join(CACHE_DIR,`${cacheKey}.mp3`);

  await fs.mkdir(CACHE_DIR,{recursive:true});
  try{
    const cached=await fs.readFile(file);
    return {audio:cached,cacheHit:true,voice:cfg.voice};
  }catch{}

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

  const audio=Buffer.from(await response.arrayBuffer());
  await fs.writeFile(file,audio);
  return {audio,cacheHit:false,voice:cfg.voice};
}
