import crypto from "node:crypto";
import * as speechsdk from "microsoft-cognitiveservices-speech-sdk";
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

function spokenAlias(symbol,language="en-US"){
  const zh=language==="zh-CN";
  const aliases={
    "%":zh?"百分之":"percent",
    "+":zh?"加":"plus",
    "=":zh?"等于":"equals",
    "×":zh?"乘":"times",
    "÷":zh?"除以":"divided by",
    "±":zh?"正负":"plus or minus",
    "≤":zh?"小于等于":"less than or equal to",
    "≥":zh?"大于等于":"greater than or equal to",
    "<":zh?"小于":"less than",
    ">":zh?"大于":"greater than",
    "@":zh?"艾特":"at",
    "&":zh?"和":"and"
  };
  return aliases[symbol]||symbol;
}

function ssmlSymbol(symbol,language="en-US"){
  return `<sub alias="${escapeXml(spokenAlias(symbol,language))}">${escapeXml(symbol)}</sub>`;
}

function decimalSsml(token,language="en-US"){
  const m=String(token).match(/^(\d+)\.(\d+)$/);
  if(!m)return escapeXml(token);
  const point=language==="zh-CN"?"点":"point";
  return `<say-as interpret-as="cardinal">${escapeXml(m[1])}</say-as><sub alias="${point}">.</sub><say-as interpret-as="characters">${escapeXml(m[2])}</say-as>`;
}

function ssmlEscapePlainSymbols(value="",language="en-US"){
  const text=String(value||"");
  let out="";
  let buf="";
  const flush=()=>{if(buf){out+=escapeXml(buf);buf="";}};

  for(let i=0;i<text.length;i++){
    const ch=text[i];

    // Temperature units.
    if(ch==="°"){
      flush();
      const next=(text[i+1]||"").toUpperCase();
      if(next==="C"){
        out+=`<sub alias="${language==="zh-CN"?"摄氏度":"degrees Celsius"}">°C</sub>`;
        i++;
        continue;
      }
      if(next==="F"){
        out+=`<sub alias="${language==="zh-CN"?"华氏度":"degrees Fahrenheit"}">°F</sub>`;
        i++;
        continue;
      }
      out+=`<sub alias="${language==="zh-CN"?"度":"degrees"}">°</sub>`;
      continue;
    }

    if(["%","+","=","×","÷","±","≤","≥","<",">","@","&"].includes(ch)){
      flush();
      out+=ssmlSymbol(ch,language);
      continue;
    }

    // Numeric ranges: 10-20 => ten to twenty / 十到二十.
    if((ch==="-"||ch==="–"||ch==="—") && /\d/.test(text[i-1]||"") && /\d/.test(text[i+1]||"")){
      flush();
      const alias=language==="zh-CN"?"到":"to";
      out+=`<sub alias="${alias}">${escapeXml(ch)}</sub>`;
      continue;
    }

    // Leading negative number: -3.5 => minus 3.5.
    if(ch==="-" && /\d/.test(text[i+1]||"") && (i===0||/[\s(=,:;]/.test(text[i-1]||""))){
      flush();
      const alias=language==="zh-CN"?"负":"minus";
      out+=`<sub alias="${alias}">-</sub>`;
      continue;
    }

    // Ratios: 1:1 => one to one / 一比一. Times such as 10:30 are handled
    // outside this helper by the punctuation parser and are not forced here.
    if(ch===":" && /\d/.test(text[i-1]||"") && /\d/.test(text[i+1]||"")){
      flush();
      const alias=language==="zh-CN"?"比":"to";
      out+=`<sub alias="${alias}">:</sub>`;
      continue;
    }

    buf+=ch;
  }
  flush();
  return out;
}

function ssmlEscapeWithNumbers(value="",language="en-US"){
  const text=String(value||"");
  const tokenRe=/(\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b|\b\d+\.\d+\b|\b\d+\b)/g;
  let out="";
  let last=0;

  for(const match of text.matchAll(tokenRe)){
    const idx=match.index??0;
    out+=ssmlEscapePlainSymbols(text.slice(last,idx),language);
    const token=match[0];

    if(/^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}$/.test(token)){
      out+=`<say-as interpret-as="date" format="ymd">${escapeXml(token)}</say-as>`;
    }else if(/^\d+\.\d+$/.test(token)){
      out+=decimalSsml(token,language);
    }else{
      out+=`<say-as interpret-as="cardinal">${escapeXml(token)}</say-as>`;
    }
    last=idx+token.length;
  }

  out+=ssmlEscapePlainSymbols(text.slice(last),language);
  return out;
}

function ssmlTextWithPauses(value="",language="en-US"){
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
    out+=ssmlEscapeWithNumbers(buf,language);
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
      // Decimal point: keep it inside the token so it is spoken as 点 / point.
      if(ch==="." && /\d/.test(text[i-1]||"") && /\d/.test(text[i+1]||"")){
        buf+=ch;
        continue;
      }

      // Numeric ratio such as 1:1. Keep it in the token so ':' becomes 比 / to.
      if(ch===":" && /\d/.test(text[i-1]||"") && /\d/.test(text[i+1]||"")){
        buf+=ch;
        continue;
      }

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
  const prosody=`<prosody rate="${ratePercent(baseRate,cfg.rateMultiplier)}" pitch="${cfg.pitch}">${clearIsolatedFragment(text,cfg.locale)}</prosody>`;
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
  if(!trimmed)return ssmlTextWithPauses(raw,language);

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

    // Technical decimals such as PM2.5: spell the prefix and explicitly
    // pronounce the decimal point instead of letting TTS swallow it.
    const techDecimal=trimmed.match(/^([A-Za-z]{1,6})(\d+\.\d+)$/);
    if(techDecimal){
      return `<break time="25ms"/><prosody rate="-7%"><say-as interpret-as="characters">${escapeXml(techDecimal[1])}</say-as>${decimalSsml(techDecimal[2],language)}</prosody><break time="30ms"/>`;
    }

    // Other technical tokens such as CO2 / PM10.
    if(/^(?:[A-Za-z]{1,5}\d+|[A-Za-z]{2,5}[A-Za-z]?\d*)$/.test(trimmed) && /\d/.test(trimmed)){
      return `<break time="25ms"/><prosody rate="-7%"><say-as interpret-as="characters">${escapeXml(trimmed)}</say-as></prosody><break time="30ms"/>`;
    }
  }

  if(language==="zh-CN" && /^[\u3400-\u9fff]$/.test(trimmed)){
    return `<break time="20ms"/><prosody rate="-6%">${escapeXml(trimmed)}</prosody><break time="25ms"/>`;
  }

  return ssmlTextWithPauses(raw,language);
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

function buildTimedSsml(lines){
  const cleanLines=(Array.isArray(lines)?lines:[])
    .map((line,i)=>({
      index:i,
      parts:(Array.isArray(line?.parts)?line.parts:[])
        .map(p=>({
          text:String(p?.text||""),
          language:p?.language==="zh-CN"?"zh-CN":"en-US",
          style:["smart","natural","host","lazy","conversation"].includes(p?.style)?p.style:"smart",
          rate:Math.min(2,Math.max(.5,Number(p?.rate||1)))
        }))
        .filter(p=>p.text.trim())
    }))
    .filter(line=>line.parts.length);

  const allParts=cleanLines.flatMap(line=>line.parts);
  if(!allParts.length)return {ssml:"",lineCount:0,voice:""};

  // Walkman uses native voices for each language so Chinese does not inherit
  // English/multilingual prosody after short code-switches.
  const enVoice=process.env.AZURE_EN_NATIVE_VOICE
    ||process.env.AZURE_EN_VOICE
    ||"en-US-AvaNeural";
  const zhVoice=process.env.AZURE_ZH_NATIVE_VOICE
    ||process.env.AZURE_ZH_VOICE
    ||"zh-CN-XiaoxiaoNeural";

  const body=cleanLines.map((line,lineIndex)=>{
    const xml=line.parts.map((p,partIndex)=>{
      const voice=p.language==="zh-CN"?zhVoice:enVoice;
      const switchGuard=partIndex>0?'<break time="30ms"/>':"";
      return `${switchGuard}<voice name="${voice}"><prosody rate="${ratePercent(p.rate,1)}"><lang xml:lang="${p.language}">${clearIsolatedFragment(p.text,p.language)}</lang></prosody></voice>`;
    }).join("");

    return `<bookmark mark="line-${lineIndex}"/>${xml}`;
  }).join('<break time="20ms"/>');

  return {
    lineCount:cleanLines.length,
    voice:"dual-language",
    ssml:`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">${body}</speak>`
  };
}
async function requestAzureTimed(ssml){
  const speechConfig=speechsdk.SpeechConfig.fromSubscription(KEY,REGION);
  speechConfig.speechSynthesisOutputFormat=speechsdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

  return await new Promise((resolve,reject)=>{
    const synthesizer=new speechsdk.SpeechSynthesizer(speechConfig,null);
    const marks=[];
    const words=[];

    synthesizer.bookmarkReached=(sender,e)=>{
      const match=String(e.text||"").match(/^line-(\d+)$/);
      if(!match)return;
      marks.push({
        index:Number(match[1]),
        offsetMs:Number(e.audioOffset||0)/10000
      });
    };

    synthesizer.wordBoundary=(sender,e)=>{
      words.push({
        offsetMs:Number(e.audioOffset||0)/10000,
        text:String(e.text||""),
        textOffset:Number(e.textOffset||0),
        wordLength:Number(e.wordLength||0)
      });
    };

    synthesizer.speakSsmlAsync(
      ssml,
      result=>{
        try{
          if(result.reason!==speechsdk.ResultReason.SynthesizingAudioCompleted){
            const err=new Error(result.errorDetails||"Azure timed TTS synthesis failed");
            err.statusCode=502;
            reject(err);
            return;
          }

          const audio=Buffer.from(result.audioData);
          marks.sort((a,b)=>a.index-b.index);
          words.sort((a,b)=>a.offsetMs-b.offsetMs);

          const firstWords=marks.map((mark,i)=>{
            const nextMark=marks[i+1];
            const first=words.find(w=>
              w.offsetMs>=mark.offsetMs &&
              (!nextMark || w.offsetMs<nextMark.offsetMs)
            );
            return {
              index:mark.index,
              bookmarkOffsetMs:mark.offsetMs,
              firstWordOffsetMs:first?first.offsetMs:mark.offsetMs,
              firstWord:first?.text||""
            };
          });

          resolve({audio,marks,words,firstWords});
        }finally{
          synthesizer.close();
        }
      },
      err=>{
        try{
          const e=new Error(String(err||"Azure timed TTS failed"));
          e.statusCode=502;
          reject(e);
        }finally{
          synthesizer.close();
        }
      }
    );
  });
}
function pcmWavBuffer(pcm,{sampleRate=24000,channels=1,bitsPerSample=16}={}){
  const data=Buffer.isBuffer(pcm)?pcm:Buffer.from(pcm||[]);
  const header=Buffer.alloc(44);
  const byteRate=sampleRate*channels*bitsPerSample/8;
  const blockAlign=channels*bitsPerSample/8;

  header.write("RIFF",0);
  header.writeUInt32LE(36+data.length,4);
  header.write("WAVE",8);
  header.write("fmt ",12);
  header.writeUInt32LE(16,16);
  header.writeUInt16LE(1,20);
  header.writeUInt16LE(channels,22);
  header.writeUInt32LE(sampleRate,24);
  header.writeUInt32LE(byteRate,28);
  header.writeUInt16LE(blockAlign,32);
  header.writeUInt16LE(bitsPerSample,34);
  header.write("data",36);
  header.writeUInt32LE(data.length,40);

  return Buffer.concat([header,data]);
}

function silencePcm(ms,sampleRate=24000){
  const samples=Math.max(0,Math.round(sampleRate*ms/1000));
  return Buffer.alloc(samples*2);
}

async function synthesizeNativePcmPart(part){
  const language=part.language==="zh-CN"?"zh-CN":"en-US";
  const voice=language==="zh-CN"
    ? (process.env.AZURE_ZH_NATIVE_VOICE||process.env.AZURE_ZH_VOICE||"zh-CN-XiaoxiaoNeural")
    : (process.env.AZURE_EN_NATIVE_VOICE||process.env.AZURE_EN_VOICE||"en-US-AvaNeural");

  const speechConfig=speechsdk.SpeechConfig.fromSubscription(KEY,REGION);
  speechConfig.speechSynthesisOutputFormat=speechsdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;

  const body=clearIsolatedFragment(part.text,language);
  const ssml=`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}"><voice name="${voice}"><prosody rate="${ratePercent(part.rate,1)}">${body}</prosody></voice></speak>`;

  return await new Promise((resolve,reject)=>{
    const synthesizer=new speechsdk.SpeechSynthesizer(speechConfig,null);
    const words=[];

    synthesizer.wordBoundary=(sender,e)=>{
      words.push({
        offsetMs:Number(e.audioOffset||0)/10000,
        text:String(e.text||"")
      });
    };

    synthesizer.speakSsmlAsync(
      ssml,
      result=>{
        try{
          if(result.reason!==speechsdk.ResultReason.SynthesizingAudioCompleted){
            const err=new Error(result.errorDetails||"Azure native segment synthesis failed");
            err.statusCode=502;
            reject(err);
            return;
          }

          const pcm=Buffer.from(result.audioData);
          words.sort((a,b)=>a.offsetMs-b.offsetMs);
          resolve({
            pcm,
            firstWordOffsetMs:words[0]?.offsetMs||0,
            firstWord:words[0]?.text||"",
            durationMs:pcm.length/(24000*2)*1000,
            voice
          });
        }finally{
          synthesizer.close();
        }
      },
      err=>{
        try{
          const e=new Error(String(err||"Azure native segment synthesis failed"));
          e.statusCode=502;
          reject(e);
        }finally{
          synthesizer.close();
        }
      }
    );
  });
}

export async function synthesizeTimedTts(lines){
  if(!hasAzureTts()){
    const err=new Error("Azure TTS is not configured");
    err.statusCode=503;
    throw err;
  }

  const cleanLines=(Array.isArray(lines)?lines:[])
    .map((line,lineIndex)=>({
      lineIndex,
      parts:(Array.isArray(line?.parts)?line.parts:[])
        .map(p=>({
          text:String(p?.text||"").trim(),
          language:p?.language==="zh-CN"?"zh-CN":"en-US",
          style:["smart","natural","host","lazy","conversation"].includes(p?.style)?p.style:"smart",
          rate:Math.min(2,Math.max(.5,Number(p?.rate||1)))
        }))
        .filter(p=>p.text)
    }))
    .filter(line=>line.parts.length);

  const total=cleanLines.reduce((sum,line)=>
    sum+line.parts.reduce((n,p)=>n+p.text.length,0),0
  );
  if(!total){
    const err=new Error("Timed TTS lines are required");
    err.statusCode=400;
    throw err;
  }
  if(total>3000){
    const err=new Error("Timed TTS text is too long");
    err.statusCode=400;
    throw err;
  }

  const keyPayload=cleanLines.map(line=>({
    parts:line.parts.map(p=>({
      text:p.text,
      language:p.language,
      style:p.style,
      rate:p.rate
    }))
  }));
  const cacheKey=crypto.createHash("sha256")
    .update("timed-separated-native-v5|"+JSON.stringify(keyPayload))
    .digest("hex");
  const audioFile=path.join(CACHE_DIR,`${cacheKey}.wav`);
  const timingFile=path.join(CACHE_DIR,`${cacheKey}.json`);

  await fs.mkdir(CACHE_DIR,{recursive:true});
  try{
    const [audio,timingRaw]=await Promise.all([
      fs.readFile(audioFile),
      fs.readFile(timingFile,"utf8")
    ]);
    const timings=JSON.parse(timingRaw);
    return {audio,timings,cacheHit:true,voice:"separate-native",lineCount:cleanLines.length,mimeType:"audio/wav"};
  }catch{}

  const flat=[];
  cleanLines.forEach(line=>{
    line.parts.forEach((part,partIndex)=>{
      flat.push({...part,lineIndex:line.lineIndex,partIndex});
    });
  });

  // Each language fragment is a completely independent Azure synthesis job.
  // Run them concurrently so native-language isolation does not multiply latency.
  const synthesized=await Promise.all(flat.map(synthesizeNativePcmPart));

  const pcmParts=[];
  const timings=[];
  let cursorMs=0;
  let lastLine=-1;

  for(let i=0;i<flat.length;i++){
    const meta=flat[i];
    const seg=synthesized[i];

    if(meta.lineIndex!==lastLine){
      if(lastLine>=0){
        const pause=silencePcm(20);
        pcmParts.push(pause);
        cursorMs+=20;
      }

      timings.push({
        index:meta.lineIndex,
        offsetMs:cursorMs+seg.firstWordOffsetMs,
        bookmarkOffsetMs:cursorMs,
        firstWord:seg.firstWord||meta.text.slice(0,16)
      });
      lastLine=meta.lineIndex;
    }else{
      // Tiny guard only at a language switch inside the same subtitle line.
      const pause=silencePcm(30);
      pcmParts.push(pause);
      cursorMs+=30;
    }

    pcmParts.push(seg.pcm);
    cursorMs+=seg.durationMs;
  }

  const audio=pcmWavBuffer(Buffer.concat(pcmParts));

  await Promise.all([
    fs.writeFile(audioFile,audio),
    fs.writeFile(timingFile,JSON.stringify(timings),"utf8")
  ]);

  return {
    audio,
    timings,
    cacheHit:false,
    voice:"separate-native",
    lineCount:cleanLines.length,
    mimeType:"audio/wav"
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
    .update("mixed-symbols-v6|"+JSON.stringify(normalized.map(p=>({
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
    .update("single-symbols-v3|"+JSON.stringify({text:clean,language:cfg.locale,voice:cfg.voice,style,rate}))
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
