import OpenAI from "openai";

let openaiClient;

async function fetchWithTimeout(url,options={},timeoutMs=35000){
  const controller=new AbortController();
  const upstreamSignal=options.signal;
  let upstreamAbortHandler=null;
  if(upstreamSignal){
    if(upstreamSignal.aborted)controller.abort();
    else{
      upstreamAbortHandler=()=>controller.abort();
      upstreamSignal.addEventListener("abort",upstreamAbortHandler,{once:true});
    }
  }
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    return await fetch(url,{...options,signal:controller.signal});
  }catch(err){
    if(err?.name==="AbortError"){
      const e=new Error("AI 请求超时，请重试一次。");
      e.statusCode=504;
      throw e;
    }
    throw err;
  }finally{
    clearTimeout(timer);
    if(upstreamSignal&&upstreamAbortHandler){
      upstreamSignal.removeEventListener("abort",upstreamAbortHandler);
    }
  }
}

export function provider() {
  if (process.env.AI_PROVIDER) return process.env.AI_PROVIDER.toLowerCase();
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_ACCOUNT_ID) return "cloudflare";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "none";
}

export function hasAI() {
  return Boolean(
    process.env.GEMINI_API_KEY ||
    (process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_ACCOUNT_ID) ||
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY
  );
}

function geminiModel() {
  return process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
}

function openaiModel() {
  return process.env.OPENAI_MODEL || "gpt-5.4-mini";
}

async function generateGeminiJsonWithKey({ system, user, schema, modelOverride, maxTokens, timeoutMs },key) {
  if (!key) {
    const e = new Error("GEMINI_API_KEY is not configured on the server.");
    e.statusCode = 503;
    throw e;
  }

  const model = modelOverride || geminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{
          text: `${system}\n\nReturn JSON only. Follow this JSON Schema as closely as possible:\n${JSON.stringify(schema)}\n\nUSER INPUT:\n${user}`
        }]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        ...(Number(maxTokens)>0?{maxOutputTokens:Number(maxTokens)}:{})
      }
    })
  }, Number(timeoutMs)||35000);

  const data = await response.json();
  if (!response.ok) {
    const detail = data?.error ? JSON.stringify(data.error) : JSON.stringify(data);
    const msg = data?.error?.message || `Gemini API error (${response.status})`;
    console.error("Gemini API failure:", response.status, detail);
    const e = new Error(msg);
    e.statusCode = response.status === 429 ? 429 : 502;
    throw e;
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p?.text || "")
    .join("")
    .trim();

  if (!text) {
    const e = new Error("Gemini returned an empty response.");
    e.statusCode = 502;
    throw e;
  }

  try{
    return parseJsonRelaxed(text);
  }catch{
    const e=new Error("Gemini returned invalid JSON.");
    e.statusCode=502;
    throw e;
  }
}
async function generateGeminiJson(options){
  const keys=[process.env.GEMINI_API_KEY,process.env.GEMINI_API_KEY_SECONDARY]
    .map(key=>String(key||"").trim()).filter((key,i,arr)=>key&&arr.indexOf(key)===i);
  if(!keys.length){
    const e=new Error("GEMINI_API_KEY is not configured on the server.");e.statusCode=503;throw e;
  }
  let lastError;
  for(let i=0;i<keys.length;i++){
    try{return await generateGeminiJsonWithKey(options,keys[i]);}
    catch(err){
      lastError=err;
      const status=Number(err?.statusCode||0);
      const retryable=[429,502,503,504].includes(status)||/quota|limit|overload|high demand|timeout|超时|empty response|invalid json/i.test(String(err?.message||""));
      if(!retryable||i===keys.length-1)break;
      console.warn("Gemini key fallback triggered; retrying with secondary key. Key value is not logged.");
    }
  }
  throw lastError;
}


async function generateOpenAIJson({ system, user, schema, name, modelOverride, maxTokens }) {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error("OPENAI_API_KEY is not configured on the server.");
    e.statusCode = 503;
    throw e;
  }
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await openaiClient.responses.create({
    model: modelOverride || openaiModel(),
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    text: {
      format: {
        type: "json_schema",
        name: name || "memorycast_json",
        strict: true,
        schema
      }
    },
    ...(Number(maxTokens)>0?{max_output_tokens:Number(maxTokens)}:{})
  });

  return JSON.parse(response.output_text);
}

function stripJsonFence(value=""){
  const t=String(value||"").trim();
  return t.replace(/^\`\`\`(?:json)?\s*/i,"").replace(/\s*\`\`\`$/,"").trim();
}

function parseJsonRelaxed(value){
  let text=stripJsonFence(value)
    .replace(/<think>[\s\S]*?<\/think>/gi,"")
    .trim();

  const candidates=[text];
  const first=text.indexOf("{");
  const last=text.lastIndexOf("}");
  if(first>=0&&last>first)candidates.push(text.slice(first,last+1));

  for(const candidate of candidates){
    for(const variant of [
      candidate,
      candidate.replace(/,\s*([}\]])/g,"$1")
    ]){
      try{return JSON.parse(variant)}catch{}
    }
  }
  throw new Error("invalid JSON");
}

async function generateCompatibleJson({providerName,system,user,schema,modelOverride,maxTokens,timeoutMs}){
  let key,baseURL,model;
  if(providerName==="openrouter"){
    key=String(process.env.OPENROUTER_API_KEY||"").trim();
    baseURL="https://openrouter.ai/api/v1";
    model=modelOverride||process.env.OPENROUTER_MODEL||"openrouter/free";
  }else if(providerName==="cloudflare"){
    key=String(process.env.CLOUDFLARE_API_KEY||"").trim();
    const accountId=String(process.env.CLOUDFLARE_ACCOUNT_ID||"").trim();
    if(!accountId){
      const e=new Error("CLOUDFLARE_ACCOUNT_ID is not configured.");e.statusCode=503;throw e;
    }
    baseURL=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`;
    model=modelOverride||process.env.CLOUDFLARE_AI_MODEL||"@cf/google/gemma-4-26b-a4b-it";
  }else{
    const e=new Error("Unsupported compatible AI provider.");e.statusCode=400;throw e;
  }
  if(!key){
    const e=new Error(`${providerName.toUpperCase()} API key is not configured.`);e.statusCode=503;throw e;
  }

  const response=await fetchWithTimeout(baseURL+"/chat/completions",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${key}`,
      "Content-Type":"application/json",
      ...(providerName==="openrouter"?{"X-Title":"MemoryCast"}:{})
    },
    body:JSON.stringify({
      model,
      messages:[
        {role:"system",content:`${system}\n\nReturn JSON only. Follow this schema exactly: ${JSON.stringify(schema)}`},
        {role:"user",content:user}
      ],
      temperature:0,
      ...(Number(maxTokens)>0?{max_tokens:Number(maxTokens)}:{})
    })
  }, Number(timeoutMs)||35000);
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const msg=data?.error?.message||data?.errors?.[0]?.message||`${providerName} API error (${response.status})`;
    const e=new Error(msg);e.statusCode=response.status;throw e;
  }
  const text=String(data?.choices?.[0]?.message?.content||"").trim();
  if(!text){
    const e=new Error(`${providerName} returned an empty response.`);e.statusCode=502;throw e;
  }
  try{
    return parseJsonRelaxed(text);
  }catch{
    const e=new Error(`${providerName} returned invalid JSON.`);e.statusCode=502;throw e;
  }
}

export async function generateStructured({ system, user, schema, name, model, maxTokens, timeoutMs, provider:providerOverride, raceProviders=false, validateResult }) {
  const p = String(providerOverride || provider()).toLowerCase();

  const run=async(chosen,requestTimeoutMs=timeoutMs)=>{
    if (chosen === "gemini") return generateGeminiJson({ system, user, schema, modelOverride:model, maxTokens, timeoutMs:requestTimeoutMs });
    if (chosen === "cloudflare" || chosen === "openrouter")
      return generateCompatibleJson({providerName:chosen,system,user,schema,modelOverride:model,maxTokens,timeoutMs:requestTimeoutMs});
    if (chosen === "openai") return generateOpenAIJson({ system, user, schema, name, modelOverride:model, maxTokens });
    const e = new Error("No supported AI provider is configured.");e.statusCode=503;throw e;
  };

  if(p!=="auto") return run(p,timeoutMs);

  // Fast failover for free providers. Gemini is tried first, OpenRouter second
  // because it is usually a better structured-output fallback than Cloudflare.
  const order=["gemini","openrouter","cloudflare"];
  // Feature-specific callers may request a longer timeout without changing other AI features.
  // Keep default failover short for ordinary calls.
  const requestedTimeout=Number(timeoutMs);
  const autoTimeouts={
    gemini:Number(process.env.AI_AUTO_GEMINI_TIMEOUT_MS||15000),
    openrouter:Number(process.env.AI_AUTO_OPENROUTER_TIMEOUT_MS||18000),
    cloudflare:Number(process.env.AI_AUTO_CLOUDFLARE_TIMEOUT_MS||15000)
  };
  if(Number.isFinite(requestedTimeout)&&requestedTimeout>0){
    for(const key of Object.keys(autoTimeouts))
      autoTimeouts[key]=Math.max(autoTimeouts[key],Math.min(60000,requestedTimeout));
  }

  if(raceProviders){
    // Run only configured providers. The first structurally valid response wins.
    // Promise.any avoids serially spending the entire proxy timeout on failed models.
    const configured=order.filter(chosen=>
      chosen==="gemini" ? Boolean(process.env.GEMINI_API_KEY||process.env.GEMINI_API_KEY_SECONDARY) :
      chosen==="cloudflare" ? Boolean(process.env.CLOUDFLARE_API_KEY&&process.env.CLOUDFLARE_ACCOUNT_ID) :
      Boolean(process.env.OPENROUTER_API_KEY));
    if(!configured.length){
      const e=new Error("没有配置可用的 AI 服务");e.statusCode=503;throw e;
    }
    const failures=[];
    try{
      return await Promise.any(configured.map(async chosen=>{
        const start=Date.now();
        try{
          const data=await run(chosen,autoTimeouts[chosen]);
          if(typeof validateResult==="function"&&!validateResult(data)){
            const e=new Error("AI 返回试卷结构不合格");e.statusCode=502;throw e;
          }
          console.info("Listening AI succeeded:",chosen,"elapsedMs:",Date.now()-start);
          return data;
        }catch(e){
          failures.push(chosen+": "+String(e?.message||e).slice(0,160));
          console.warn("Listening AI provider failed:",chosen,"elapsedMs:",Date.now()-start,String(e?.message||e).slice(0,160));
          throw e;
        }
      }));
    }catch{
      const e=new Error("所有 AI 服务均未生成有效试卷："+failures.join("；"));
      e.statusCode=502;throw e;
    }
  }

  const failures=[];
  for(const chosen of order){
    const configured=
      chosen==="gemini" ? Boolean(process.env.GEMINI_API_KEY) :
      chosen==="cloudflare" ? Boolean(process.env.CLOUDFLARE_API_KEY&&process.env.CLOUDFLARE_ACCOUNT_ID) :
      Boolean(process.env.OPENROUTER_API_KEY);
    if(!configured)continue;

    try{
      return await run(chosen,autoTimeouts[chosen]);
    }catch(err){
      const message=err?.message||String(err);
      failures.push({provider:chosen,message,status:Number(err?.statusCode||0)});
      console.warn("AI auto provider failed:",chosen,message);
    }
  }

  if(!failures.length){
    const e=new Error("尚未配置可用的 AI API。");
    e.statusCode=503;
    throw e;
  }

  const short=failures.map(f=>{
    const label=f.provider==="gemini"?"Gemini":f.provider==="openrouter"?"OpenRouter":"Cloudflare";
    if(f.status===504||/超时|timeout/i.test(f.message))return label+" 超时";
    if(f.status===503||/high demand|unavailable|overload/i.test(f.message))return label+" 高负载";
    if(/invalid json/i.test(f.message))return label+" 输出格式错误";
    return label+" 调用失败";
  }).join("；");

  const e=new Error("自动切换失败："+short+"。请稍后重试。");
  e.statusCode=502;
  throw e;
}

export function aiInfo() {
  const p = provider();
  return {
    enabled: p !== "none",
    provider: p,
    model: p === "gemini" ? geminiModel() : p === "openai" ? openaiModel() : null
  };
}


function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

async function ocrWithGemini({base64,mimeType}){
  const key=String(process.env.GEMINI_API_KEY||"").trim();
  if(!key) throw Object.assign(new Error("Gemini OCR 未配置"),{skipProvider:true});

  // Keep OCR on a free-tier multimodal model instead of inheriting a potentially
  // expensive or overloaded general AI model.
  const model=process.env.OCR_MODEL || "gemini-3.5-flash-lite";
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  let lastError;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const response=await fetch(url,{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-goog-api-key":key
        },
        body:JSON.stringify({
          contents:[{
            role:"user",
            parts:[
              {text:"Extract all readable study-note text from this image faithfully. Preserve useful line breaks, headings, formulas, English words, punctuation, and list structure. Do not summarize, explain, correct, or add content. Return only the extracted text."},
              {inlineData:{mimeType,data:base64}}
            ]
          }],
          generationConfig:{temperature:0}
        })
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok){
        const e=new Error(data?.error?.message||`Gemini OCR error (${response.status})`);
        e.statusCode=response.status;
        throw e;
      }
      const text=(data?.candidates?.[0]?.content?.parts||[])
        .map(p=>p?.text||"").join("").trim();
      if(!text){
        const e=new Error("Gemini 没有从图片中识别到文字。");
        e.statusCode=422;
        throw e;
      }
      return {text,model,provider:"gemini"};
    }catch(err){
      lastError=err;
      const retryable=[429,500,502,503,504].includes(Number(err?.statusCode||0)) ||
        /unavailable|overload|capacity|temporar/i.test(String(err?.message||""));
      if(!retryable || attempt===2)break;
      await wait(500*(attempt+1));
    }
  }
  throw lastError;
}

async function ocrWithCloudflare({base64,mimeType}){
  const key=String(process.env.CLOUDFLARE_API_KEY||"").trim();
  const accountId=String(process.env.CLOUDFLARE_ACCOUNT_ID||"").trim();
  if(!key||!accountId) throw Object.assign(new Error("Cloudflare OCR 未配置"),{skipProvider:true});

  const model=process.env.CLOUDFLARE_OCR_MODEL||"@cf/moondream/moondream3.1-9B-A2B";
  const url=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const response=await fetch(url,{
    method:"POST",
    headers:{
      Authorization:`Bearer ${key}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      task:"query",
      image:`data:${mimeType};base64,${base64}`,
      question:"Extract all readable text from this study-note image faithfully. Preserve headings, line breaks, formulas, English words, punctuation, and list structure. Do not summarize, correct, or add content. Return only the extracted text.",
      reasoning:false,
      temperature:0,
      max_tokens:8192
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok || data?.success===false){
    const msg=data?.errors?.[0]?.message||data?.error?.message||`Cloudflare OCR error (${response.status})`;
    const e=new Error(msg);e.statusCode=response.status;throw e;
  }
  const result=data?.result??data;
  const text=String(result?.answer||result?.response||result?.text||"").trim();
  if(!text){
    const e=new Error("Cloudflare 没有从图片中识别到文字。");
    e.statusCode=422;
    throw e;
  }
  return {text,model,provider:"cloudflare"};
}

async function ocrWithOpenRouter({base64,mimeType}){
  const key=String(process.env.OPENROUTER_API_KEY||"").trim();
  if(!key) throw Object.assign(new Error("OpenRouter OCR 未配置"),{skipProvider:true});
  const model=process.env.OPENROUTER_VISION_MODEL||"openrouter/free";
  const response=await fetch("https://openrouter.ai/api/v1/chat/completions",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${key}`,
      "Content-Type":"application/json",
      "X-Title":"MemoryCast"
    },
    body:JSON.stringify({
      model,
      messages:[{
        role:"user",
        content:[
          {type:"text",text:"Extract all readable text from this study-note image faithfully. Preserve headings, line breaks, formulas, English words, punctuation, and list structure. Do not summarize, correct, or add content. Return only the extracted text."},
          {type:"image_url",image_url:{url:`data:${mimeType};base64,${base64}`}}
        ]
      }],
      temperature:0
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const e=new Error(data?.error?.message||`OpenRouter OCR error (${response.status})`);
    e.statusCode=response.status;throw e;
  }
  const text=String(data?.choices?.[0]?.message?.content||"").trim();
  if(!text){
    const e=new Error("OpenRouter 没有从图片中识别到文字。");e.statusCode=422;throw e;
  }
  return {text,model,provider:"openrouter"};
}

export async function extractTextFromImage({base64,mimeType="image/jpeg",provider:providerChoice="auto"}) {
  const map={gemini:ocrWithGemini,cloudflare:ocrWithCloudflare,openrouter:ocrWithOpenRouter};
  const selected=String(providerChoice||"auto").toLowerCase();
  if(selected!=="auto"){
    const fn=map[selected];
    if(!fn){const e=new Error("不支持的 OCR API。");e.statusCode=400;throw e;}
    return fn({base64,mimeType});
  }

  const failures=[];
  for(const fn of [ocrWithGemini,ocrWithCloudflare,ocrWithOpenRouter]){
    try{return await fn({base64,mimeType});}
    catch(err){
      if(err?.skipProvider)continue;
      failures.push(err?.message||String(err));
      console.warn("OCR provider failed:",fn.name,err?.message||err);
    }
  }
  const e=new Error(failures.length?"所有 OCR API 都暂时不可用，请稍后重试。":"尚未配置可用的 OCR 服务。");
  e.statusCode=failures.length?502:503;throw e;
}


async function visualJsonWithGemini({base64,mimeType,system,user,schema}){
  const key=String(process.env.GEMINI_API_KEY||"").trim();
  if(!key) throw Object.assign(new Error("Gemini Vision 未配置"),{skipProvider:true});
  const model=process.env.OCR_MODEL||geminiModel();
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response=await fetch(url,{
    method:"POST",
    signal:AbortSignal.timeout(20000),
    headers:{"Content-Type":"application/json","x-goog-api-key":key},
    body:JSON.stringify({
      contents:[{
        role:"user",
        parts:[
          {text:`${system}\n\nReturn JSON only. Follow this schema exactly: ${JSON.stringify(schema)}\n\nCONTEXT:\n${user}`},
          {inlineData:{mimeType,data:base64}}
        ]
      }],
      generationConfig:{temperature:0,responseMimeType:"application/json"}
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const e=new Error(data?.error?.message||`Gemini Vision error (${response.status})`);
    e.statusCode=response.status;throw e;
  }
  const text=(data?.candidates?.[0]?.content?.parts||[]).map(p=>p?.text||"").join("").trim();
  if(!text)throw Object.assign(new Error("Gemini Vision returned empty response."),{statusCode:502});
  try{return JSON.parse(stripJsonFence(text));}
  catch{
    const m=stripJsonFence(text).match(/\{[\s\S]*\}/);
    if(m)return JSON.parse(m[0]);
    throw Object.assign(new Error("Gemini Vision returned invalid JSON."),{statusCode:502});
  }
}

async function visualJsonWithOpenRouter({base64,mimeType,system,user,schema}){
  const key=String(process.env.OPENROUTER_API_KEY||"").trim();
  if(!key) throw Object.assign(new Error("OpenRouter Vision 未配置"),{skipProvider:true});
  const model=process.env.OPENROUTER_VISION_MODEL||"openrouter/free";
  const response=await fetch("https://openrouter.ai/api/v1/chat/completions",{
    method:"POST",
    signal:AbortSignal.timeout(20000),
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json","X-Title":"MemoryCast"},
    body:JSON.stringify({
      model,
      messages:[{
        role:"user",
        content:[
          {type:"text",text:`${system}\n\nReturn JSON only. Follow this schema exactly: ${JSON.stringify(schema)}\n\nCONTEXT:\n${user}`},
          {type:"image_url",image_url:{url:`data:${mimeType};base64,${base64}`}}
        ]
      }],
      temperature:0
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const e=new Error(data?.error?.message||`OpenRouter Vision error (${response.status})`);
    e.statusCode=response.status;throw e;
  }
  const text=String(data?.choices?.[0]?.message?.content||"").trim();
  if(!text)throw Object.assign(new Error("OpenRouter Vision returned empty response."),{statusCode:502});
  try{return JSON.parse(stripJsonFence(text));}
  catch{
    const m=stripJsonFence(text).match(/\{[\s\S]*\}/);
    if(m)return JSON.parse(m[0]);
    throw Object.assign(new Error("OpenRouter Vision returned invalid JSON."),{statusCode:502});
  }
}

async function visualJsonWithCloudflare({base64,mimeType,system,user,schema}){
  const key=String(process.env.CLOUDFLARE_API_KEY||"").trim();
  const accountId=String(process.env.CLOUDFLARE_ACCOUNT_ID||"").trim();
  if(!key||!accountId) throw Object.assign(new Error("Cloudflare Vision 未配置"),{skipProvider:true});
  const model=process.env.CLOUDFLARE_OCR_MODEL||"@cf/moondream/moondream3.1-9B-A2B";
  const url=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const response=await fetch(url,{
    method:"POST",
    signal:AbortSignal.timeout(20000),
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      task:"query",
      image:`data:${mimeType};base64,${base64}`,
      question:`${system}\nReturn JSON only. Schema: ${JSON.stringify(schema)}\nContext: ${user}`,
      reasoning:false,temperature:0,max_tokens:4096
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data?.success===false){
    const e=new Error(data?.errors?.[0]?.message||data?.error?.message||`Cloudflare Vision error (${response.status})`);
    e.statusCode=response.status;throw e;
  }
  const result=data?.result??data;
  const text=String(result?.answer||result?.response||result?.text||"").trim();
  if(!text)throw Object.assign(new Error("Cloudflare Vision returned empty response."),{statusCode:502});
  try{return JSON.parse(stripJsonFence(text));}
  catch{
    const m=stripJsonFence(text).match(/\{[\s\S]*\}/);
    if(m)return JSON.parse(m[0]);
    throw Object.assign(new Error("Cloudflare Vision returned invalid JSON."),{statusCode:502});
  }
}

export async function generateVisualStructured({base64,mimeType="image/jpeg",system,user,schema,provider:providerChoice="auto"}){
  const map={
    gemini:visualJsonWithGemini,
    openrouter:visualJsonWithOpenRouter,
    cloudflare:visualJsonWithCloudflare
  };
  const selected=String(providerChoice||"auto").toLowerCase();
  const order=selected==="auto"
    ? ["gemini","openrouter","cloudflare"]
    : [selected];
  const failures=[];
  for(const name of order){
    const fn=map[name];
    if(!fn)continue;
    try{return await fn({base64,mimeType,system,user,schema});}
    catch(err){
      if(err?.skipProvider)continue;
      failures.push(name+": "+(err?.message||String(err)));
      console.warn("Vision provider failed:",name,err?.message||err);
    }
  }
  const e=new Error(failures.length?"所有视觉 AI 当前都不可用，请稍后重试。":"尚未配置可用的视觉 AI。");
  e.statusCode=failures.length?502:503;
  throw e;
}
