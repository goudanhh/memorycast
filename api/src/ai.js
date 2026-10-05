import OpenAI from "openai";

let openaiClient;

export function provider() {
  if (process.env.AI_PROVIDER) return process.env.AI_PROVIDER.toLowerCase();
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "none";
}

export function hasAI() {
  return provider() !== "none";
}

function geminiModel() {
  return process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
}

function openaiModel() {
  return process.env.OPENAI_MODEL || "gpt-5.4-mini";
}

async function generateGeminiJson({ system, user, schema, modelOverride }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const e = new Error("GEMINI_API_KEY is not configured on the server.");
    e.statusCode = 503;
    throw e;
  }

  const model = modelOverride || geminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(url, {
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
        responseMimeType: "application/json"
      }
    })
  });

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

  return JSON.parse(text);
}

async function generateOpenAIJson({ system, user, schema, name, modelOverride }) {
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
    }
  });

  return JSON.parse(response.output_text);
}

export async function generateStructured({ system, user, schema, name, model }) {
  const p = provider();
  if (p === "gemini") return generateGeminiJson({ system, user, schema, modelOverride:model });
  if (p === "openai") return generateOpenAIJson({ system, user, schema, name, modelOverride:model });

  const e = new Error("No AI provider is configured.");
  e.statusCode = 503;
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

export async function extractTextFromImage({base64,mimeType="image/jpeg"}) {
  const failures=[];
  for(const fn of [ocrWithGemini,ocrWithCloudflare]){
    try{
      return await fn({base64,mimeType});
    }catch(err){
      if(err?.skipProvider)continue;
      failures.push(err?.message||String(err));
      console.warn("OCR provider failed:",fn.name,err?.message||err);
    }
  }
  const e=new Error(failures.length
    ? "Gemini 和 Cloudflare OCR 都暂时不可用，请稍后重试。"
    : "尚未配置可用的 OCR 服务。");
  e.statusCode=failures.length?502:503;
  throw e;
}
