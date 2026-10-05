import express from "express";
import helmet from "helmet";
import compression from "compression";
import webpush from "web-push";
import crypto from "node:crypto";
import { query } from "./db.js";
import { newFsrsCard, scheduleNext, getStateName } from "./fsrs.js";
import { hasAI, generateStructured, aiInfo, extractTextFromImage } from "./ai.js";
import { synthesizeTts, synthesizeMixedTts, ttsInfo } from "./tts.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "4mb" }));
let localUserIdCache = null;

async function getLocalUserId() {
  if (localUserIdCache) return localUserIdCache;
  const { rows } = await query(`
    INSERT INTO users(github_id, github_login, avatar_url, last_login_at)
    VALUES(0, 'local-user', NULL, NOW())
    ON CONFLICT(github_id) DO UPDATE SET last_login_at=NOW()
    RETURNING id
  `);
  localUserIdCache = rows[0].id;
  await query(`
    INSERT INTO user_settings(user_id) VALUES($1)
    ON CONFLICT(user_id) DO NOTHING
  `, [localUserIdCache]);
  return localUserIdCache;
}

function requireAuth(req,res,next) {
  getLocalUserId()
    .then(id => { req.localUserId = id; next(); })
    .catch(next);
}
function asyncRoute(fn) { return (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next); }
function userId(req){ return req.localUserId; }

function dateTag(value = new Date()) {
  return new Date(value).toISOString().slice(0,10);
}
function normalizeTags(input, createdAt = new Date()) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[,，]/);
  const semantic = raw.map(x=>String(x).trim()).filter(Boolean).filter(x=>!(/^(\d{4}-\d{2}-\d{2})$/.test(x)));
  return [...new Set([dateTag(createdAt), ...semantic])].slice(0,8);
}

const tagSchema = {
  type:"object",
  properties:{ tags:{type:"array",minItems:2,maxItems:4,items:{type:"string"}} },
  required:["tags"],
  additionalProperties:false
};

async function autoSemanticTags(front, back, example="") {
  if (!hasAI()) return ["Other"];
  try {
    const data = await generateStructured({
      name:"card_tags",
      schema:tagSchema,
      system:`Generate 2 to 4 concise semantic tags for a spaced-repetition card.
Tags must be based only on the supplied card content.
Prefer reusable topical tags such as "英语连读", "发音", "环境工程", "CO2捕集", "FSRS", "词汇".
Do not generate dates, timestamps, "学习", "笔记", "知识点", or similarly vague labels.
Return only schema-valid JSON.`,
      user:JSON.stringify({front,back,example})
    });
    return (data.tags||[]).map(x=>String(x).trim()).filter(Boolean).slice(0,4);
  } catch (err) {
    console.warn("Auto-tagging failed, using fallback tag:", err.message);
    return ["Other"];
  }
}
await query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'::text[]`);
await query(`
  UPDATE cards
  SET tags = ARRAY[
    TO_CHAR(created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),
    COALESCE(NULLIF(category,''),'Other')
  ]
  WHERE COALESCE(array_length(tags,1),0)=0
`);

await query(`ALTER TABLE user_settings ALTER COLUMN english_rate SET DEFAULT 1.0`);
await query(`ALTER TABLE user_settings ALTER COLUMN chinese_rate SET DEFAULT 1.0`);
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reminder_time TIME NOT NULL DEFAULT '09:00'`);
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reminder_timezone TEXT NOT NULL DEFAULT 'UTC'`);
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_reminder_date DATE`);
await query(`UPDATE user_settings SET english_rate=1.0 WHERE english_rate=1.2`);
await query(`UPDATE user_settings SET chinese_rate=1.0 WHERE chinese_rate=1.3`);
await query(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT UNIQUE NOT NULL,
    subscription JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
await query(`
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

async function getVapidKeys() {
  const existing = await query(`SELECT value FROM app_config WHERE key='vapid_keys'`);
  if (existing.rows[0]?.value?.publicKey && existing.rows[0]?.value?.privateKey) {
    return existing.rows[0].value;
  }
  const keys = webpush.generateVAPIDKeys();
  await query(
    `INSERT INTO app_config(key,value) VALUES('vapid_keys',$1::jsonb)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,
    [JSON.stringify(keys)]
  );
  return keys;
}

const vapidKeys = await getVapidKeys();
webpush.setVapidDetails("mailto:memorycast@example.com", vapidKeys.publicKey, vapidKeys.privateKey);

function localDateTime(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year:"numeric",month:"2-digit",day:"2-digit",
      hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(new Date());
    const get = type => parts.find(p=>p.type===type)?.value || "";
    return { date:`${get("year")}-${get("month")}-${get("day")}`, time:`${get("hour")}:${get("minute")}` };
  } catch {
    const now = new Date();
    return { date:now.toISOString().slice(0,10), time:now.toISOString().slice(11,16) };
  }
}

async function runDailyReminders() {
  const {rows} = await query(`
    SELECT user_id, reminder_time::text, reminder_timezone, last_reminder_date
    FROM user_settings
    WHERE reminder_enabled=TRUE
  `);
  for (const s of rows) {
    const now = localDateTime(s.reminder_timezone || "UTC");
    const target = String(s.reminder_time || "09:00").slice(0,5);
    const last = s.last_reminder_date ? new Date(s.last_reminder_date).toISOString().slice(0,10) : null;
    if (now.time < target || last === now.date) continue;

    const dueResult = await query(`SELECT COUNT(*)::int AS n FROM cards WHERE user_id=$1 AND due<=NOW()`, [s.user_id]);
    const dueCount = dueResult.rows[0]?.n || 0;

    if (dueCount > 0) {
      const subs = await query(`SELECT id,subscription FROM push_subscriptions WHERE user_id=$1`, [s.user_id]);
      const payload = JSON.stringify({
        title:"MemoryCast 今日复习",
        body:`今天有 ${dueCount} 张卡片按 FSRS 记忆曲线到期。`,
        url:"/"
      });
      for (const sub of subs.rows) {
        try {
          await webpush.sendNotification(sub.subscription, payload);
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await query(`DELETE FROM push_subscriptions WHERE id=$1`, [sub.id]);
          } else {
            console.warn("Push failed:", err.message);
          }
        }
      }
    }
    await query(`UPDATE user_settings SET last_reminder_date=$2 WHERE user_id=$1`, [s.user_id, now.date]);
  }
}

await query(`
  CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '未命名笔记',
    content TEXT NOT NULL,
    tags TEXT[] NOT NULL DEFAULT '{}'::text[],
    manual_review_count INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
await query(`CREATE INDEX IF NOT EXISTS idx_notes_user_created ON notes(user_id,created_at DESC)`);
await query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS source_note_id UUID`);
await query(`ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_source_note_id_fkey`);
await query(`
  ALTER TABLE cards
  ADD CONSTRAINT cards_source_note_id_fkey
  FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE
`);

app.get("/health", (req,res) => res.json({ ok:true, ai:aiInfo(), tts:ttsInfo(), mode:"single-user" }));
app.get("/tts/info", requireAuth, (req,res) => res.json(ttsInfo()));
app.post("/tts", requireAuth, asyncRoute(async(req,res)=>{
  let result;
  if(Array.isArray(req.body?.parts)&&req.body.parts.length){
    const parts=req.body.parts.slice(0,40).map(p=>({
      text:String(p?.text||""),
      language:p?.language==="zh-CN"?"zh-CN":"en-US",
      style:["smart","natural","host","lazy"].includes(p?.style)?p.style:"smart",
      rate:Math.min(2,Math.max(.5,Number(p?.rate||1)))
    }));
    result=await synthesizeMixedTts(parts);
  }else{
    const text=String(req.body?.text||"");
    const language=req.body?.language==="zh-CN"?"zh-CN":"en-US";
    const style=["smart","natural","host","lazy"].includes(req.body?.style)?req.body.style:"smart";
    const rate=Math.min(2,Math.max(.5,Number(req.body?.rate||1)));
    result=await synthesizeTts({text,language,style,rate});
  }
  res.setHeader("Content-Type","audio/mpeg");
  res.setHeader("Cache-Control","private, max-age=31536000, immutable");
  res.setHeader("X-MemoryCast-TTS-Cache",result.cacheHit?"HIT":"MISS");
  res.setHeader("X-MemoryCast-TTS-Voice",result.voice);
  res.send(result.audio);
}));
app.get("/auth/me", asyncRoute(async (req,res) => {
  const id = await getLocalUserId();
  res.json({
    user:{ id, login:"Local User", avatarUrl:null },
    aiEnabled:hasAI(),
    ai:aiInfo(),
    authDisabled:true
  });
}));
app.get("/auth/github", (req,res) => res.redirect("/"));
app.get("/auth/github/callback", (req,res) => res.redirect("/"));
app.post("/auth/logout", (req,res) => res.json({ ok:true }));

app.get("/settings", requireAuth, asyncRoute(async(req,res)=>{
  const {rows} = await query(`SELECT * FROM user_settings WHERE user_id=$1`,[userId(req)]);
  res.json(rows[0]);
}));
app.put("/settings", requireAuth, asyncRoute(async(req,res)=>{
  const b=req.body||{};
  const retention=Math.min(.99,Math.max(.70,Number(b.fsrs_retention ?? .90)));
  const en=Math.min(2,Math.max(.5,Number(b.english_rate ?? 1.0)));
  const zh=Math.min(2,Math.max(.5,Number(b.chinese_rate ?? 1.0)));
  const goal=Math.min(500,Math.max(1,Number(b.daily_goal ?? 20)));
  const wrong=b.wrong_requeue !== false;
  const reminderEnabled=b.reminder_enabled === true;
  const reminderTime=/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(b.reminder_time||"")) ? String(b.reminder_time) : "09:00";
  const reminderTimezone=String(b.reminder_timezone||"UTC").slice(0,80);
  const {rows}=await query(`
    UPDATE user_settings SET
      english_rate=$2,chinese_rate=$3,daily_goal=$4,
      fsrs_retention=$5,wrong_requeue=$6,
      reminder_enabled=$7,reminder_time=$8,reminder_timezone=$9,updated_at=NOW()
    WHERE user_id=$1 RETURNING *
  `,[userId(req),en,zh,goal,retention,wrong,reminderEnabled,reminderTime,reminderTimezone]);
  res.json(rows[0]);
}));
async function getRetention(uid){
  const {rows}=await query(`SELECT fsrs_retention FROM user_settings WHERE user_id=$1`,[uid]);
  return rows[0]?.fsrs_retention || Number(process.env.FSRS_RETENTION||.90);
}

app.get("/push/public-key", requireAuth, asyncRoute(async(req,res)=>{
  res.json({publicKey:vapidKeys.publicKey});
}));
app.post("/push/subscribe", requireAuth, asyncRoute(async(req,res)=>{
  const sub=req.body?.subscription;
  if(!sub?.endpoint) return res.status(400).json({error:"Invalid push subscription"});
  await query(`
    INSERT INTO push_subscriptions(user_id,endpoint,subscription,updated_at)
    VALUES($1,$2,$3::jsonb,NOW())
    ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,subscription=EXCLUDED.subscription,updated_at=NOW()
  `,[userId(req),sub.endpoint,JSON.stringify(sub)]);
  res.json({ok:true});
}));
app.post("/push/unsubscribe", requireAuth, asyncRoute(async(req,res)=>{
  const endpoint=String(req.body?.endpoint||"");
  if(endpoint) await query(`DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2`,[userId(req),endpoint]);
  res.json({ok:true});
}));

function normalizeNoteRow(r){
  return {
    id:r.id,title:r.title,content:r.content,tags:r.tags||[],
    manualReviewCount:r.manual_review_count||0,
    lastReviewedAt:r.last_reviewed_at,
    createdAt:r.created_at,updatedAt:r.updated_at
  };
}
function noteTitle(text){
  const first=String(text||"").split(/\r?\n/).map(x=>x.trim()).find(Boolean)||"未命名笔记";
  return first.slice(0,80);
}
app.get("/notes", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`SELECT * FROM notes WHERE user_id=$1 ORDER BY created_at DESC`,[userId(req)]);
  res.json({notes:rows.map(normalizeNoteRow)});
}));
app.get("/notes/:id", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`SELECT * FROM notes WHERE id=$2 AND user_id=$1`,[userId(req),req.params.id]);
  if(!rows[0]) return res.status(404).json({error:"Note not found"});
  res.json({note:normalizeNoteRow(rows[0])});
}));
app.put("/notes/:id", requireAuth, asyncRoute(async(req,res)=>{
  const title=String(req.body?.title||"").trim();
  const content=String(req.body?.content??"");
  if(!content.trim()) return res.status(400).json({error:"Note content is required"});
  const {rows}=await query(`
    UPDATE notes SET title=$3,content=$4,updated_at=NOW()
    WHERE id=$2 AND user_id=$1 RETURNING *
  `,[userId(req),req.params.id,title||noteTitle(content),content]);
  if(!rows[0]) return res.status(404).json({error:"Note not found"});
  res.json({note:normalizeNoteRow(rows[0])});
}));
app.delete("/notes/:id", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const noteId=req.params.id;
  const count=await query(`SELECT COUNT(*)::int AS n FROM cards WHERE user_id=$1 AND source_note_id=$2`,[uid,noteId]);
  const result=await query(`DELETE FROM notes WHERE id=$2 AND user_id=$1`,[uid,noteId]);
  res.json({ok:result.rowCount>0,deletedCards:result.rowCount>0?(count.rows[0]?.n||0):0});
}));
app.post("/notes/:id/review", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`
    UPDATE notes SET manual_review_count=manual_review_count+1,last_reviewed_at=NOW(),updated_at=NOW()
    WHERE id=$2 AND user_id=$1 RETURNING *
  `,[userId(req),req.params.id]);
  if(!rows[0]) return res.status(404).json({error:"Note not found"});
  res.json({note:normalizeNoteRow(rows[0])});
}));

function normalizeCardRow(r){
  return {
    id:r.id,front:r.front,back:r.back,example:r.example,category:r.category,
    tags:Array.isArray(r.tags)&&r.tags.length?r.tags:[dateTag(r.created_at),r.category].filter(Boolean),
    speakOrder:r.speak_order,fsrs:r.fsrs,due:r.due,reviewCount:r.review_count,
    createdAt:r.created_at,updatedAt:r.updated_at,sourceNoteId:r.source_note_id||null,stateName:getStateName(r.fsrs)
  };
}
app.get("/cards", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`SELECT * FROM cards WHERE user_id=$1 ORDER BY created_at DESC`,[userId(req)]);
  res.json({cards:rows.map(normalizeCardRow)});
}));
app.post("/cards", requireAuth, asyncRoute(async(req,res)=>{
  const {front,back,example="",speakOrder="front-back-example"}=req.body||{};
  const cleanFront=String(front||"").trim();
  const cleanBack=String(back||"").trim();
  const cleanExample=String(example||"").trim();
  if(!cleanFront || !cleanBack)
    return res.status(400).json({error:"front and back are required"});

  const semanticTags=await autoSemanticTags(cleanFront,cleanBack,cleanExample);
  const tags=normalizeTags(semanticTags);
  const category=semanticTags[0]||"Other";
  const fsrs=newFsrsCard();

  const {rows}=await query(`
    INSERT INTO cards(user_id,front,back,example,category,tags,speak_order,fsrs,due)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
  `,[userId(req),cleanFront,cleanBack,cleanExample,category,tags,String(speakOrder),fsrs,fsrs.due]);

  res.status(201).json({card:normalizeCardRow(rows[0])});
}));

app.put("/cards/:id", requireAuth, asyncRoute(async(req,res)=>{
  const current=await query(`SELECT * FROM cards WHERE id=$2 AND user_id=$1`,[userId(req),req.params.id]);
  const row=current.rows[0];
  if(!row) return res.status(404).json({error:"Card not found"});

  const cleanFront=String(req.body?.front ?? row.front).trim();
  const cleanBack=String(req.body?.back ?? row.back).trim();
  const cleanExample=String(req.body?.example ?? row.example ?? "").trim();
  const speakOrder=req.body?.speakOrder ?? row.speak_order;
  if(!cleanFront || !cleanBack)
    return res.status(400).json({error:"front and back are required"});

  const semanticTags=await autoSemanticTags(cleanFront,cleanBack,cleanExample);
  const tags=normalizeTags(semanticTags,row.created_at);
  const category=semanticTags[0]||"Other";

  const {rows}=await query(`
    UPDATE cards SET front=$3,back=$4,example=$5,category=$6,tags=$7,
      speak_order=$8,updated_at=NOW()
    WHERE id=$2 AND user_id=$1 RETURNING *
  `,[userId(req),req.params.id,cleanFront,cleanBack,cleanExample,category,tags,speakOrder]);

  res.json({card:normalizeCardRow(rows[0])});
}));

app.delete("/cards/:id", requireAuth, asyncRoute(async(req,res)=>{
  const result=await query(`DELETE FROM cards WHERE id=$2 AND user_id=$1`,[userId(req),req.params.id]);
  res.json({ok:result.rowCount>0});
}));
app.get("/due", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`
    SELECT * FROM cards WHERE user_id=$1 AND due<=NOW()
    ORDER BY due ASC LIMIT 500
  `,[userId(req)]);
  res.json({cards:rows.map(normalizeCardRow)});
}));

async function applyReview(uid, cardId, rating, source="review", verdict=null){
  const {rows}=await query(`SELECT * FROM cards WHERE id=$2 AND user_id=$1`,[uid,cardId]);
  const row=rows[0];
  if(!row) { const e=new Error("Card not found");e.statusCode=404;throw e; }
  const retention=await getRetention(uid);
  const scheduled=scheduleNext(row.fsrs,rating,retention,new Date());
  const updated=await query(`
    UPDATE cards SET fsrs=$3,due=$4,review_count=review_count+1,updated_at=NOW()
    WHERE id=$2 AND user_id=$1 RETURNING *
  `,[uid,cardId,scheduled.card,scheduled.card.due]);
  await query(`
    INSERT INTO reviews(user_id,card_id,source,rating,verdict)
    VALUES($1,$2,$3,$4,$5)
  `,[uid,cardId,source,rating,verdict]);
  return normalizeCardRow(updated.rows[0]);
}
app.post("/review", requireAuth, asyncRoute(async(req,res)=>{
  const {id,rating}=req.body||{};
  if(!["Again","Hard","Good","Easy"].includes(rating))
    return res.status(400).json({error:"Invalid rating"});
  res.json({card:await applyReview(userId(req),id,rating,"review")});
}));


function decodeBase64Payload(value=""){
  const raw=String(value||"").replace(/^data:[^;]+;base64,/,"").trim();
  if(!raw) return Buffer.alloc(0);
  return Buffer.from(raw,"base64");
}

async function saveCapturedNote(uid,text,tag){
  const content=String(text||"").trim();
  if(!content) return null;
  const tags=normalizeTags([tag]);
  const {rows}=await query(`
    INSERT INTO notes(user_id,title,content,tags)
    VALUES($1,$2,$3,$4) RETURNING *
  `,[uid,noteTitle(content),content,tags]);
  return normalizeNoteRow(rows[0]);
}

async function transcribeWithCloudflare(audio,mimeType){
  const key=String(process.env.CLOUDFLARE_API_KEY||"").trim();
  const accountId=String(process.env.CLOUDFLARE_ACCOUNT_ID||"").trim();
  if(!key||!accountId) throw Object.assign(new Error("Cloudflare STT 未配置"),{skipProvider:true});

  const model=process.env.CLOUDFLARE_STT_MODEL||"@cf/openai/whisper-large-v3-turbo";
  const url=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const response=await fetch(url,{
    method:"POST",
    headers:{
      Authorization:`Bearer ${key}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      audio:audio.toString("base64"),
      task:"transcribe",
      vad_filter:true,
      condition_on_previous_text:true
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok || data?.success===false){
    const msg=data?.errors?.[0]?.message||data?.error?.message||`Cloudflare STT error (${response.status})`;
    const e=new Error(msg);e.statusCode=response.status;throw e;
  }
  const text=String(data?.result?.text||data?.text||"").trim();
  if(!text) throw new Error("Cloudflare 没有返回有效转写。");
  return {text,provider:"cloudflare",model};
}

function extractGeminiInteractionText(data){
  const stepText=(data?.steps||[]).flatMap(step=>step?.content||[])
    .filter(x=>x?.type==="text"&&x?.text)
    .map(x=>x.text).join("\n").trim();
  if(stepText)return stepText;
  const outputText=(data?.outputs||[]).filter(x=>x?.text).map(x=>x.text).join("\n").trim();
  return outputText;
}

async function transcribeWithGemini(audio,mimeType){
  const key=String(process.env.GEMINI_API_KEY||"").trim();
  if(!key) throw Object.assign(new Error("Gemini STT 未配置"),{skipProvider:true});

  const model=process.env.GEMINI_TRANSCRIBE_MODEL||"gemini-3.5-transcribe";
  const response=await fetch("https://generativelanguage.googleapis.com/v1beta/interactions",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-goog-api-key":key
    },
    body:JSON.stringify({
      model,
      input:[{
        type:"audio",
        data:audio.toString("base64"),
        mime_type:mimeType
      }],
      generation_config:{
        transcription_config:{
          language_codes:[],
          mode:"smart"
        }
      }
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const msg=data?.error?.message||`Gemini transcription error (${response.status})`;
    const e=new Error(msg);e.statusCode=response.status;throw e;
  }
  const text=extractGeminiInteractionText(data);
  if(!text) throw new Error("Gemini 没有返回有效转写。");
  return {text,provider:"gemini",model};
}

async function transcribeWithOpenRouter(audio,mimeType){
  const key=String(process.env.OPENROUTER_API_KEY||"").trim();
  if(!key) throw Object.assign(new Error("OpenRouter STT 未配置"),{skipProvider:true});

  const model=process.env.OPENROUTER_STT_MODEL||"openai/whisper-large-v3";
  const format=mimeType.includes("webm")?"webm":
    mimeType.includes("ogg")?"ogg":
    mimeType.includes("wav")?"wav":
    mimeType.includes("mpeg")||mimeType.includes("mp3")?"mp3":"webm";

  const response=await fetch("https://openrouter.ai/api/v1/audio/transcriptions",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${key}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model,
      input_audio:{
        data:audio.toString("base64"),
        format
      }
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const msg=data?.error?.message||`OpenRouter transcription error (${response.status})`;
    const e=new Error(msg);e.statusCode=response.status;throw e;
  }
  const text=String(data?.text||data?.result?.text||"").trim();
  if(!text) throw new Error("OpenRouter 没有返回有效转写。");
  return {text,provider:"openrouter",model};
}

async function transcribeAudio(audio,mimeType){
  const providers=[
    transcribeWithCloudflare,
    transcribeWithGemini,
    transcribeWithOpenRouter
  ];
  const failures=[];
  let configured=0;

  for(const fn of providers){
    try{
      const result=await fn(audio,mimeType);
      configured++;
      return {...result,failures};
    }catch(err){
      if(err?.skipProvider)continue;
      configured++;
      failures.push(err?.message||String(err));
      console.warn("STT provider failed:",fn.name,err?.message||err);
    }
  }

  if(!configured){
    const e=new Error("尚未配置语音转写服务。请配置 Cloudflare、Gemini 或 OpenRouter 中至少一个。");
    e.statusCode=503;throw e;
  }
  const e=new Error("所有语音转写服务暂时都失败了，请稍后重试。");
  e.statusCode=502;
  throw e;
}

app.post("/ai/transcribe", requireAuth, asyncRoute(async(req,res)=>{
  const mimeType=String(req.body?.mimeType||"audio/webm").split(";")[0];
  const audio=decodeBase64Payload(req.body?.audioBase64);
  if(!audio.length) return res.status(400).json({error:"没有收到录音数据。"});
  if(audio.length>2_700_000) return res.status(413).json({error:"录音太大，请分段录制后再转写。"});

  const result=await transcribeAudio(audio,mimeType);
  const note=await saveCapturedNote(userId(req),result.text,"语音笔记");
  res.json({
    text:result.text,
    note,
    provider:result.provider,
    model:result.model
  });
}));


app.post("/ai/ocr", requireAuth, asyncRoute(async(req,res)=>{
  const mimeType=String(req.body?.mimeType||"image/jpeg").split(";")[0];
  if(!["image/jpeg","image/png","image/webp"].includes(mimeType))
    return res.status(400).json({error:"仅支持 JPG、PNG、WebP 图片。"});
  const image=decodeBase64Payload(req.body?.imageBase64);
  if(!image.length) return res.status(400).json({error:"没有收到图片数据。"});
  if(image.length>2_700_000) return res.status(413).json({error:"图片太大，请压缩或重新拍摄。"});
  const result=await extractTextFromImage({base64:image.toString("base64"),mimeType});
  const note=await saveCapturedNote(userId(req),result.text,"OCR笔记");
  res.json({text:result.text,note,model:result.model});
}));

const organizeSchema={
  type:"object",
  properties:{cards:{type:"array",minItems:1,maxItems:30,items:{
    type:"object",
    properties:{front:{type:"string"},back:{type:"string"},example:{type:"string"},tags:{type:"array",minItems:2,maxItems:4,items:{type:"string"}}},
    required:["front","back","example","tags"],additionalProperties:false
  }}},
  required:["cards"],additionalProperties:false
};
app.post("/ai/organize", requireAuth, asyncRoute(async(req,res)=>{
  const rawText=String(req.body?.text??"");
  const text=rawText.trim();
  const splitMode=req.body?.splitMode==="single"?"single":"split";
  if(!text) return res.status(400).json({error:"Text is required"});

  const existingNoteId=String(req.body?.noteId||"").trim();
  let note;
  if(existingNoteId){
    const existing=await query(`
      UPDATE notes SET title=$3,content=$4,updated_at=NOW()
      WHERE id=$2 AND user_id=$1 RETURNING *
    `,[userId(req),existingNoteId,noteTitle(rawText),rawText]);
    if(existing.rows[0]) note=normalizeNoteRow(existing.rows[0]);
  }
  if(!note){
    const noteTags=normalizeTags([]);
    const savedNote=await query(`
      INSERT INTO notes(user_id,title,content,tags)
      VALUES($1,$2,$3,$4) RETURNING *
    `,[userId(req),noteTitle(rawText),rawText,noteTags]);
    note=normalizeNoteRow(savedNote.rows[0]);
  }

  try{
    if(splitMode==="single"){
      const semanticTags=await autoSemanticTags(note.title, rawText, "");
      return res.json({
        cards:[{
          front:note.title,
          back:rawText,
          example:"",
          tags:semanticTags
        }],
        note,
        splitMode
      });
    }
    const data=await generateStructured({
      name:"study_cards",
      schema:organizeSchema,
      system:`Turn the user's study notes into concise spaced-repetition cards.
Use only information supplied by the user. Do not add unsupported factual claims.
Cards may be Chinese, English, or bilingual.
Front should be a recall prompt or term; back should contain the essential answer.
For English vocabulary, include a short natural example when useful.
For technical notes, prefer concept questions over trivial sentence copying.
For each card, generate 2 to 4 concise semantic tags based on the content. Do not include dates or timestamps; the server adds the date tag automatically.
Prefer reusable topical tags such as "英语连读", "发音", "环境工程", "CO2捕集", rather than vague tags like "学习".
Return JSON matching the schema.`,
      user:text
    });
    res.json({...data,note,splitMode});
  }catch(err){
    err.savedNote=note;
    throw err;
  }
}));
app.post("/ai/organize/save", requireAuth, asyncRoute(async(req,res)=>{
  const input=Array.isArray(req.body?.cards)?req.body.cards.slice(0,30):[];
  const noteId=req.body?.noteId||null;
  if(!input.length) return res.status(400).json({error:"No cards"});
  const saved=[];
  for(const c of input){
    if(!String(c.front||"").trim()||!String(c.back||"").trim()) continue;
    const fsrs=newFsrsCard();
    const {rows}=await query(`
      INSERT INTO cards(user_id,front,back,example,category,tags,speak_order,fsrs,due,source_note_id)
      VALUES($1,$2,$3,$4,$5,$6,'front-back-example',$7,$8,$9) RETURNING *
    `,[userId(req),String(c.front).trim(),String(c.back).trim(),String(c.example||"").trim(),
       String((c.tags||[])[0]||"Other").trim(),normalizeTags(c.tags),fsrs,fsrs.due,noteId]);
    saved.push(normalizeCardRow(rows[0]));
  }
  res.status(201).json({cards:saved});
}));

const quizSchema={
  type:"object",
  properties:{
    title:{type:"string"},
    questions:{type:"array",minItems:1,maxItems:20,items:{
      type:"object",
      properties:{
        cardId:{type:"string"},type:{type:"string",enum:["mcq","fill","short","listening"]},
        prompt:{type:"string"},choices:{type:"array",items:{type:"string"},maxItems:4},
        answer:{type:"string"},acceptableAnswers:{type:"array",items:{type:"string"},maxItems:8},
        explanation:{type:"string"},audioText:{type:"string"}
      },
      required:["cardId","type","prompt","choices","answer","acceptableAnswers","explanation","audioText"],
      additionalProperties:false
    }}
  },
  required:["title","questions"],additionalProperties:false
};
app.post("/quiz/generate", requireAuth, asyncRoute(async(req,res)=>{
  const count=Math.min(20,Math.max(3,Number(req.body?.count||10)));
  const mode=["mixed","weak","due"].includes(req.body?.mode)?req.body.mode:"mixed";
  let sql=`SELECT * FROM cards WHERE user_id=$1`;
  if(mode==="due") sql+=` AND due<=NOW()`;
  if(mode==="weak") sql+=` ORDER BY COALESCE((fsrs->>'difficulty')::float,0) DESC, due ASC`;
  else sql+=` ORDER BY due ASC`;
  sql+=` LIMIT 30`;
  const {rows}=await query(sql,[userId(req)]);
  if(!rows.length) return res.status(400).json({error:"没有可用于出题的知识卡片。"});

  const source=rows.map(r=>({
    id:r.id,front:r.front,back:r.back,example:r.example,category:r.category,tags:r.tags||[],
    difficulty:Number(r.fsrs?.difficulty||0),due:r.due
  }));
  const data=await generateStructured({
    name:"memorycast_quiz",
    schema:quizSchema,
    system:`Generate a rigorous but fair study quiz only from the supplied cards.
Mix MCQ, fill, short-answer and listening items when appropriate.
For MCQ provide exactly 4 plausible choices; otherwise choices must be [].
For listening, audioText is what TTS reads and the prompt must not reveal it.
For English, test recognition and production. For technical material, test understanding.\nA single card may contain a whole note: in that case, generate multiple distinct questions from different facts or concepts in that card. Reusing the same cardId across multiple questions is allowed.\nReturn only schema-valid JSON.`,
    user:JSON.stringify({count,mode,cards:source})
  });
  const allowed=new Set(source.map(x=>x.id));
  const questions=data.questions.filter(q=>allowed.has(q.cardId)).slice(0,count).map(q=>({...q,id:crypto.randomUUID()}));
  if(!questions.length) return res.status(502).json({error:"AI 未生成有效题目。"});
  const {rows:created}=await query(`
    INSERT INTO quiz_sessions(user_id,title,questions)
    VALUES($1,$2,$3) RETURNING id
  `,[userId(req),data.title||"今日测试",JSON.stringify(questions)]);
  res.json({
    sessionId:created[0].id,title:data.title||"今日测试",
    questions:questions.map(({answer,acceptableAnswers,explanation,...safe})=>safe)
  });
}));
function norm(s=""){return String(s).toLowerCase().trim().replace(/[.,!?;:'"()[\]{}，。！？；：“”‘’、\s]+/g," ");}
async function judgeAnswer(q,userAnswer){
  const n=norm(userAnswer);
  const acceptable=[q.answer,...(q.acceptableAnswers||[])].map(norm).filter(Boolean);
  if(acceptable.includes(n)) return {verdict:"correct",score:1,feedback:"回答正确。"};
  if(!n) return {verdict:"wrong",score:0,feedback:"未作答。"};
  const schema={
    type:"object",
    properties:{verdict:{type:"string",enum:["correct","partial","wrong"]},score:{type:"number",minimum:0,maximum:1},feedback:{type:"string"}},
    required:["verdict","score","feedback"],additionalProperties:false
  };
  return generateStructured({
    name:"grade",
    schema,
    system:`Grade the learner's answer semantically.
Accept equivalent wording, bilingual equivalents, and minor spelling or grammar errors.
correct = substantively correct; partial = core idea present but important detail missing; wrong = incorrect or absent.
Return schema-valid JSON.`,
    user:JSON.stringify({type:q.type,prompt:q.prompt,expected:q.answer,acceptable:q.acceptableAnswers,userAnswer})
  });
}
app.post("/quiz/grade", requireAuth, asyncRoute(async(req,res)=>{
  const {sessionId,questionId,answer=""}=req.body||{};
  const {rows}=await query(`
    SELECT * FROM quiz_sessions
    WHERE id=$2 AND user_id=$1 AND expires_at>NOW()
  `,[userId(req),sessionId]);
  const sessionRow=rows[0];
  if(!sessionRow) return res.status(404).json({error:"测试已过期或不存在。"});
  const q=sessionRow.questions.find(x=>x.id===questionId);
  if(!q) return res.status(404).json({error:"题目不存在。"});
  const grade=await judgeAnswer(q,String(answer));
  const rating=grade.verdict==="correct"?"Good":grade.verdict==="partial"?"Hard":"Again";
  const updatedCard=await applyReview(userId(req),q.cardId,rating,"quiz",grade.verdict);
  const answers=[...(sessionRow.answers||[]),{
    questionId:q.id,cardId:q.cardId,userAnswer:String(answer),
    verdict:grade.verdict,score:grade.score,rating,answeredAt:new Date().toISOString()
  }];
  await query(`UPDATE quiz_sessions SET answers=$3::jsonb WHERE id=$2 AND user_id=$1`,[userId(req),sessionId,JSON.stringify(answers)]);
  res.json({verdict:grade.verdict,score:grade.score,feedback:grade.feedback,correctAnswer:q.answer,explanation:q.explanation,fsrsRating:rating,updatedCard});
}));


await query(`
  CREATE TABLE IF NOT EXISTS feynman_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    clarity_score INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_turn_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
await query(`
  CREATE INDEX IF NOT EXISTS idx_feynman_sessions_user_updated
  ON feynman_sessions(user_id,last_turn_at DESC)
`);
await query(`
  CREATE TABLE IF NOT EXISTS feynman_turns (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES feynman_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','ai')),
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
await query(`
  CREATE INDEX IF NOT EXISTS idx_feynman_turns_session_time
  ON feynman_turns(session_id,created_at ASC,id ASC)
`);

const feynmanSchema={
  type:"object",
  properties:{
    studentReply:{type:"string"},
    understood:{type:"string"},
    strengths:{type:"array",items:{type:"string"},maxItems:4},
    gaps:{type:"array",items:{type:"string"},maxItems:4},
    followUpQuestion:{type:"string"},
    status:{type:"string",enum:["continue","mastered"]},
    clarityScore:{type:"integer",minimum:0,maximum:100}
  },
  required:["studentReply","understood","strengths","gaps","followUpQuestion","status","clarityScore"],
  additionalProperties:false
};

app.get("/feynman/sessions", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`
    SELECT id,topic,status,clarity_score,created_at,updated_at,last_turn_at
    FROM feynman_sessions
    WHERE user_id=$1
    ORDER BY last_turn_at DESC
    LIMIT 50
  `,[userId(req)]);
  res.json({sessions:rows});
}));

app.get("/feynman/sessions/:id", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`
    SELECT id,topic,status,clarity_score,created_at,updated_at,last_turn_at
    FROM feynman_sessions
    WHERE id=$2 AND user_id=$1
  `,[userId(req),req.params.id]);
  const session=rows[0];
  if(!session) return res.status(404).json({error:"费曼会话不存在。"});
  const turns=await query(`
    SELECT id,role,content,metadata,created_at
    FROM feynman_turns
    WHERE session_id=$1
    ORDER BY created_at ASC,id ASC
  `,[session.id]);
  res.json({session,turns:turns.rows});
}));

app.post("/feynman/respond", requireAuth, asyncRoute(async(req,res)=>{
  if(!hasAI()) return res.status(503).json({error:"AI 未配置，暂时无法使用费曼模式。"});
  const uid=userId(req);
  const topic=String(req.body?.topic||"").trim().slice(0,300);
  const explanation=String(req.body?.explanation||"").trim().slice(0,10000);
  let sessionId=String(req.body?.sessionId||"").trim();

  if(!topic) return res.status(400).json({error:"请先填写要讲解的主题。"});
  if(!explanation) return res.status(400).json({error:"请先讲一段你的理解。"});

  let session;
  if(sessionId){
    const existing=await query(`
      SELECT * FROM feynman_sessions WHERE id=$2 AND user_id=$1
    `,[uid,sessionId]);
    session=existing.rows[0];
    if(!session) return res.status(404).json({error:"费曼会话不存在。"});
  }else{
    const created=await query(`
      INSERT INTO feynman_sessions(user_id,topic)
      VALUES($1,$2) RETURNING *
    `,[uid,topic]);
    session=created.rows[0];
    sessionId=session.id;
  }

  const prior=await query(`
    SELECT role,content
    FROM feynman_turns
    WHERE session_id=$1
    ORDER BY created_at DESC,id DESC
    LIMIT 16
  `,[sessionId]);
  const history=prior.rows.reverse().map(x=>({role:x.role,text:x.content}));

  const aiProvider=String(process.env.AI_PROVIDER||"gemini").toLowerCase();
  const analysisModel=process.env.FEYNMAN_DEEP_MODEL ||
    (aiProvider==="gemini" ? "gemini-3.8-flash" : process.env.OPENAI_MODEL);

  const analysisRequest={
    name:"feynman_analysis",
    schema:feynmanSchema,
    system:`You are an expert Feynman-method tutor.
The user has FINISHED one complete explanation. Do not decide whether to stay silent; always analyze the explanation now.

Your job:
1. Briefly state what you understood the user to mean.
2. Identify the strongest parts of the explanation.
3. Identify only meaningful conceptual or logical gaps. Ignore harmless speech-to-text mistakes unless they change meaning.
4. In studentReply, give concise, useful feedback and directly correct the most important factual or logical mistake if there is one.
5. Ask exactly ONE highest-value follow-up question that makes the learner explain the weakest point in their own words.
6. Do not overwhelm the learner with a lecture. Prioritize the 1–3 most important issues.
7. Use the recent session history when judging contradictions or whether an earlier gap has now been resolved.
8. status="mastered" only when the core idea is accurate, causally coherent, and understandable to a beginner.
9. clarityScore measures the explanation's clarity and completeness, not the learner's intelligence.
10. Reply mainly in the user's language while preserving useful English technical terms.

Return schema-valid JSON only.`,
    user:JSON.stringify({topic:session.topic,history,currentExplanation:explanation})
  };

  let data;
  let usedModel=analysisModel;
  try{
    data=await generateStructured({...analysisRequest,model:analysisModel});
  }catch(err){
    const fallbackModel=aiProvider==="gemini"
      ? (process.env.GEMINI_MODEL||"gemini-3.5-flash-lite")
      : process.env.OPENAI_MODEL;

    const message=String(err?.message||"").toLowerCase();
    const retryable=
      err?.statusCode===429 ||
      err?.statusCode===502 ||
      err?.statusCode===503 ||
      message.includes("high demand") ||
      message.includes("temporar") ||
      message.includes("overload");

    if(!retryable || !fallbackModel || fallbackModel===analysisModel) throw err;

    console.warn("Feynman deep model unavailable; falling back:",analysisModel,"->",fallbackModel,err.message);
    data=await generateStructured({...analysisRequest,model:fallbackModel});
    usedModel=fallbackModel;
  }

  const aiContent=[data.studentReply,data.followUpQuestion].filter(Boolean).join(" ");

  await query(`
    INSERT INTO feynman_turns(session_id,role,content,metadata)
    VALUES
      ($1,'user',$2,$3::jsonb),
      ($1,'ai',$4,$5::jsonb)
  `,[
    sessionId,
    explanation,
    JSON.stringify({topic:session.topic,mode:"turn_analysis"}),
    aiContent,
    JSON.stringify({
      understood:data.understood,
      strengths:data.strengths||[],
      gaps:data.gaps||[],
      followUpQuestion:data.followUpQuestion||"",
      status:data.status,
      clarityScore:data.clarityScore,
      studentReply:data.studentReply,
      model:usedModel,
      requestedModel:analysisModel,
      mode:"turn_analysis"
    })
  ]);

  await query(`
    UPDATE feynman_sessions
    SET topic=$3,status=$4,clarity_score=$5,updated_at=NOW(),last_turn_at=NOW()
    WHERE id=$2 AND user_id=$1
  `,[uid,sessionId,topic,data.status,data.clarityScore]);

  res.json({...data,sessionId,topic});
}));


const feynmanRealtimeSchema={
  type:"object",
  properties:{
    action:{type:"string",enum:["listen","intervene","respond"]},
    thoughtState:{type:"string",enum:["developing","complete"]},
    gapType:{type:"string",enum:["none","definition","causal_jump","hidden_assumption","contradiction","circular_reasoning","unsupported_claim","boundary_case"]},
    confidence:{type:"number",minimum:0,maximum:1},
    anchor:{type:"string"},
    question:{type:"string"},
    response:{type:"string"},
    clarityScore:{type:"integer",minimum:0,maximum:100}
  },
  required:["action","thoughtState","gapType","confidence","anchor","question","response","clarityScore"],
  additionalProperties:false
};

app.post("/feynman/realtime", requireAuth, asyncRoute(async(req,res)=>{
  if(!hasAI()) return res.status(503).json({error:"AI 未配置，暂时无法使用费曼模式。"});
  const uid=userId(req);
  const topic=String(req.body?.topic||"").trim().slice(0,300);
  const explanation=String(req.body?.explanation||"").trim().slice(0,5000);
  let sessionId=String(req.body?.sessionId||"").trim();

  if(!topic) return res.status(400).json({error:"请先填写要讲解的主题。"});
  if(!explanation) return res.status(400).json({error:"没有检测到有效讲解内容。"});

  let session;
  if(sessionId){
    const existing=await query(`
      SELECT * FROM feynman_sessions WHERE id=$2 AND user_id=$1
    `,[uid,sessionId]);
    session=existing.rows[0];
    if(!session) return res.status(404).json({error:"费曼会话不存在。"});
  }else{
    const created=await query(`
      INSERT INTO feynman_sessions(user_id,topic)
      VALUES($1,$2) RETURNING *
    `,[uid,topic]);
    session=created.rows[0];
    sessionId=session.id;
  }

  const prior=await query(`
    SELECT role,content
    FROM feynman_turns
    WHERE session_id=$1
    ORDER BY created_at DESC,id DESC
    LIMIT 10
  `,[sessionId]);
  const history=prior.rows.reverse().map(x=>({role:x.role,text:x.content}));

  const aiProvider=String(process.env.AI_PROVIDER||"gemini").toLowerCase();
  const fastModel=process.env.FEYNMAN_FAST_MODEL ||
    (aiProvider==="gemini" ? "gemini-3.5-flash-lite" : process.env.OPENAI_MODEL);
  const deepModel=process.env.FEYNMAN_DEEP_MODEL ||
    (aiProvider==="gemini" ? "gemini-3.8-flash" : process.env.OPENAI_MODEL);

  const explicitResponseRequested=/(对吗|对不对|是不是这样|是不是这样子|我理解得对吗|我说得对吗|给我.*反馈|给点.*反馈|评价一下|你怎么看|你觉得呢|有没有问题|有问题吗|正确吗|right\??|am i right|is that right|does that make sense)/i.test(explanation);

  // Stage 1: cheap, fast gate. Its job is mostly to say "keep listening".
  const gate=await generateStructured({
    name:"feynman_gate",
    model:fastModel,
    schema:feynmanRealtimeSchema,
    system:`You are the fast gate for a live Socratic tutor.
Your main job is to avoid unnecessary interruptions.

Classify whether the user's CURRENT thought is still developing and whether there might be a high-value reasoning gap.
A pause is not evidence that the thought is complete.

Rules:
- Prefer action="listen".
- thoughtState="developing" for unfinished explanations, lists, examples, qualifications, self-corrections, or obvious continuations.
- Only mark action="intervene" when the thought appears complete AND there may be a meaningful reasoning gap.
- Do not ask generic questions.
- At this stage, confidence means confidence that a second, stronger model should inspect the possible interruption.
- If unsure, listen.
- When listening, question="" and response="".
- This fast gate normally does not provide feedback; response should be "".
Return schema-valid JSON only.`,
    user:JSON.stringify({topic:session.topic,history,currentExplanation:explanation})
  });

  const gateCandidate=
    gate.action==="intervene" &&
    gate.thoughtState==="complete" &&
    gate.gapType!=="none" &&
    Number(gate.confidence)>=0.68;

  let finalDecision={
    ...gate,
    action:"listen",
    question:"",
    response:""
  };
  let deepChecked=false;

  // Stage 2: candidate interruptions OR explicit requests for feedback go to the stronger model.
  if(gateCandidate || explicitResponseRequested){
    deepChecked=true;
    finalDecision=await generateStructured({
      name:"feynman_deep_judge",
      model:deepModel,
      schema:feynmanRealtimeSchema,
      system:`You are the final judge for a live Feynman/Socratic conversation.
A faster model thinks there may be a reason to interrupt. Your job is to independently verify that judgment using the full recent context.

Be conservative when deciding whether to interrupt: a thoughtful human mentor usually listens longer than an impatient chatbot.

IMPORTANT EXCEPTION — explicit request:
If the user directly asks for confirmation, feedback, evaluation, or an answer (for example “对吗？”, “给我点反馈”, “我这样理解对不对？”), you MUST respond.
For an explicit request:
- action="respond"
- response should be a concise spoken answer that directly addresses what the user asked.
- If their explanation is substantially correct, say what is correct and make the most important correction or refinement.
- If it is wrong, explain the key correction briefly.
- You may put ONE useful follow-up question in question, but only if it helps the user continue reasoning.
- Do not hide behind a Socratic question when the user explicitly asked for feedback.

Otherwise, first decide whether the user has actually completed the current thought.
Then determine whether there is a MATERIAL reasoning problem:
- definition
- causal_jump
- hidden_assumption
- contradiction
- circular_reasoning
- unsupported_claim
- boundary_case

Reject the interruption and return action="listen" if:
- the user is obviously still developing the idea,
- the missing detail could reasonably come next,
- the issue is only wording or imprecision,
- the proposed question is generic,
- interrupting would break the user's train of thought.

Approve action="intervene" only when:
- thoughtState="complete",
- the reasoning gap is important,
- confidence >= 0.82,
- and one short question would materially improve understanding.

When intervening:
- ask exactly ONE natural spoken question,
- anchor it to the user's specific claim,
- response="",
- no praise, preamble, summary, or lecture,
- usually under 30 Chinese characters or 20 English words.

When listening, question="" and response="".
When responding to an explicit request, response must be non-empty and directly useful.
Return schema-valid JSON only.`,
      user:JSON.stringify({
        topic:session.topic,
        history,
        currentExplanation:explanation,
        fastModelAssessment:gate,
        explicitResponseRequested
      })
    });
  }

  const shouldRespond=
    explicitResponseRequested &&
    finalDecision.action==="respond" &&
    String(finalDecision.response||"").trim();

  const shouldIntervene=
    !shouldRespond &&
    finalDecision.action==="intervene" &&
    finalDecision.thoughtState==="complete" &&
    Number(finalDecision.confidence)>=0.82 &&
    String(finalDecision.question||"").trim();

  const response=shouldRespond?String(finalDecision.response||"").trim():"";
  const question=shouldIntervene?String(finalDecision.question||"").trim():
    (shouldRespond?String(finalDecision.question||"").trim():"");
  const action=shouldRespond?"respond":shouldIntervene?"intervene":"listen";
  const aiContent=response || question || "（继续倾听）";

  await query(`
    INSERT INTO feynman_turns(session_id,role,content,metadata)
    VALUES
      ($1,'user',$2,$3::jsonb),
      ($1,'ai',$4,$5::jsonb)
  `,[
    sessionId,
    explanation,
    JSON.stringify({topic:session.topic,realtime:true}),
    aiContent,
    JSON.stringify({
      action,
      thoughtState:finalDecision.thoughtState,
      gapType:finalDecision.gapType,
      confidence:finalDecision.confidence,
      anchor:finalDecision.anchor||"",
      followUpQuestion:question,
      response,
      explicitResponseRequested,
      clarityScore:finalDecision.clarityScore,
      realtime:true,
      fastModel,
      deepModel:deepChecked?deepModel:null,
      deepChecked,
      gateAssessment:{
        action:gate.action,
        thoughtState:gate.thoughtState,
        gapType:gate.gapType,
        confidence:gate.confidence
      }
    })
  ]);

  await query(`
    UPDATE feynman_sessions
    SET topic=$3,status='active',clarity_score=$4,updated_at=NOW(),last_turn_at=NOW()
    WHERE id=$2 AND user_id=$1
  `,[uid,sessionId,topic,finalDecision.clarityScore]);

  res.json({
    action,
    thoughtState:finalDecision.thoughtState,
    gapType:finalDecision.gapType,
    confidence:finalDecision.confidence,
    anchor:finalDecision.anchor||"",
    question,
    response,
    clarityScore:finalDecision.clarityScore,
    sessionId,
    topic,
    deepChecked
  });
}));


app.get("/stats", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const [cards, reviews, recent, categories]=await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM cards WHERE user_id=$1`,[uid]),
    query(`SELECT COUNT(*)::int AS n FROM reviews WHERE user_id=$1`,[uid]),
    query(`
      SELECT
        COUNT(*) FILTER(WHERE verdict='correct')::int AS correct,
        COUNT(*) FILTER(WHERE source='quiz')::int AS quiz_total,
        COUNT(*) FILTER(WHERE reviewed_at>=NOW()-INTERVAL '7 days')::int AS last7
      FROM reviews WHERE user_id=$1
    `,[uid]),
    query(`
      SELECT tag AS category, COUNT(*)::int AS count,
        AVG(COALESCE((fsrs->>'difficulty')::float,0)) AS avg_difficulty
      FROM cards, LATERAL unnest(tags) AS tag
      WHERE user_id=$1
        AND tag !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY tag
      ORDER BY count DESC
    `,[uid])
  ]);
  const quizTotal=recent.rows[0].quiz_total||0, correct=recent.rows[0].correct||0;
  res.json({
    cards:cards.rows[0].n,
    reviews:reviews.rows[0].n,
    last7:recent.rows[0].last7||0,
    quizAccuracy:quizTotal?Math.round(correct/quizTotal*100):null,
    categories:categories.rows
  });
}));

app.use((err,req,res,next)=>{
  console.error(err);
  const status=err.statusCode||500;
  res.status(status).json({error: status===500 ? "Server error" : err.message});
});
app.listen(PORT,"0.0.0.0",()=>console.log(`MemoryCast API listening on ${PORT}`));
setTimeout(()=>runDailyReminders().catch(console.error),5000);
setInterval(()=>runDailyReminders().catch(console.error),60*1000);
