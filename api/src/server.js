import express from "express";
import helmet from "helmet";
import compression from "compression";
import webpush from "web-push";
import crypto from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pdfParse from "pdf-parse";
import { query } from "./db.js";
import { newFsrsCard, scheduleNext, getStateName } from "./fsrs.js";
import { hasAI, generateStructured, generateVisualStructured, aiInfo, extractTextFromImage } from "./ai.js";
import { synthesizeTts, synthesizeMixedTts, synthesizeTimedTts, ttsInfo } from "./tts.js";

const execFileAsync=promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 3000);

const timedTtsMedia=new Map();
const TIMED_TTS_MEDIA_TTL_MS=30*60*1000;
const TIMED_TTS_MEDIA_MAX=48;

async function wrapTimedTtsAsWatchVideo(result){
  const dir=await mkdtemp(path.join(os.tmpdir(),"memorycast-watch-"));
  const input=path.join(dir,"input.m4a");
  const output=path.join(dir,"output.mp4");

  try{
    await writeFile(input,result.audio);

    await execFileAsync("ffmpeg",[
      "-hide_banner","-loglevel","error","-y",
      "-f","lavfi",
      "-i","color=c=black:s=16x16:r=1",
      "-i",input,
      "-map","0:v:0",
      "-map","1:a:0",
      "-c:v","libx264",
      "-preset","ultrafast",
      "-tune","stillimage",
      "-pix_fmt","yuv420p",
      "-c:a","copy",
      "-shortest",
      "-movflags","+faststart",
      output
    ]);

    return {
      ...result,
      audio:await readFile(output),
      mimeType:"video/mp4"
    };
  }finally{
    await rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

function storeTimedTtsMedia(result){
  const now=Date.now();
  for(const [id,item] of timedTtsMedia){
    if(now-item.createdAt>TIMED_TTS_MEDIA_TTL_MS)timedTtsMedia.delete(id);
  }
  while(timedTtsMedia.size>=TIMED_TTS_MEDIA_MAX){
    const first=timedTtsMedia.keys().next().value;
    timedTtsMedia.delete(first);
  }
  const id=crypto.randomUUID();
  timedTtsMedia.set(id,{
    audio:result.audio,
    mimeType:result.mimeType||"audio/mp4",
    createdAt:now
  });
  return id;
}
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "24mb" }));
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
await query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS hidden_until TIMESTAMPTZ`);
await query(`
  CREATE TABLE IF NOT EXISTS game_attempts (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('match','listen','spell','recall')),
    correct BOOLEAN NOT NULL,
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
await query(`CREATE INDEX IF NOT EXISTS idx_game_attempts_user_time ON game_attempts(user_id,created_at DESC)`);
await query(`CREATE INDEX IF NOT EXISTS idx_game_attempts_card_time ON game_attempts(card_id,created_at DESC)`);

await query(`
  CREATE TABLE IF NOT EXISTS arcade_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    coins INTEGER NOT NULL DEFAULT 0 CHECK(coins>=0),
    total_xp INTEGER NOT NULL DEFAULT 0 CHECK(total_xp>=0),
    runs INTEGER NOT NULL DEFAULT 0,
    best_wave INTEGER NOT NULL DEFAULT 0,
    highest_sector INTEGER NOT NULL DEFAULT 1 CHECK(highest_sector BETWEEN 1 AND 3),
    wins INTEGER NOT NULL DEFAULT 0,
    upgrades JSONB NOT NULL DEFAULT '{"power":0,"armor":0,"magnet":0}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

await query(`
  CREATE TABLE IF NOT EXISTS adventure_progress (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 8),
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 3),
    best_seconds INTEGER NOT NULL CHECK (best_seconds BETWEEN 1 AND 3600),
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,level)
  )
`);
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
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_organize_provider TEXT NOT NULL DEFAULT 'gemini'`);
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_quiz_provider TEXT NOT NULL DEFAULT 'gemini'`);
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_grade_provider TEXT NOT NULL DEFAULT 'gemini'`);
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS stt_provider TEXT NOT NULL DEFAULT 'cloudflare'`);
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ocr_provider TEXT NOT NULL DEFAULT 'gemini'`);

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

    const dueResult = await query(`SELECT COUNT(*)::int AS n FROM cards c
 WHERE c.user_id=$1 AND c.due<=NOW()
   AND (c.hidden_until IS NULL OR c.hidden_until<=NOW())
   AND (c.source_note_id IS NULL OR EXISTS (
     SELECT 1 FROM notes n WHERE n.id=c.source_note_id AND n.user_id=c.user_id AND n.study_enabled=TRUE
   ))`, [s.user_id]);
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
await query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS study_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
await query(`
  CREATE TABLE IF NOT EXISTS note_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL DEFAULT 0,
    data BYTEA NOT NULL,
    extracted_text TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
await query(`CREATE INDEX IF NOT EXISTS idx_note_attachments_note ON note_attachments(note_id,sort_order,created_at)`);
await query(`ALTER TABLE note_attachments ADD COLUMN IF NOT EXISTS source_attachment_id UUID`);
await query(`ALTER TABLE note_attachments ADD COLUMN IF NOT EXISTS page_number INTEGER`);
await query(`ALTER TABLE note_attachments ADD COLUMN IF NOT EXISTS is_generated BOOLEAN NOT NULL DEFAULT FALSE`);


await query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS source_note_id UUID`);
await query(`ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_source_note_id_fkey`);
await query(`
  ALTER TABLE cards
  ADD CONSTRAINT cards_source_note_id_fkey
  FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE
`);

app.get("/health", (req,res) => res.json({ ok:true, ai:aiInfo(), tts:ttsInfo(), mode:"single-user" }));
app.get("/tts/info", requireAuth, (req,res) => res.json(ttsInfo()));
app.post("/tts/timed", requireAuth, asyncRoute(async(req,res)=>{
  const rawLines=Array.isArray(req.body?.lines)?req.body.lines.slice(0,80):[];
  const lines=rawLines.map(line=>({
    parts:(Array.isArray(line?.parts)?line.parts:[]).slice(0,40).map(p=>({
      text:String(p?.text||""),
      language:p?.language==="zh-CN"?"zh-CN":"en-US",
      style:["smart","natural","host","lazy","conversation"].includes(p?.style)?p.style:"smart",
      rate:Math.min(2,Math.max(.5,Number(p?.rate||1)))
    }))
  }));

  const format=String(req.body?.format||"aac").toLowerCase()==="mp3"?"mp3":"aac";
  const delivery=String(req.body?.delivery||"binary").toLowerCase();
  const result=await synthesizeTimedTts(lines,{format});

  if(delivery==="url"||delivery==="video"){
    const mediaResult=delivery==="video"
      ? await wrapTimedTtsAsWatchVideo(result)
      : result;
    const mediaId=storeTimedTtsMedia(mediaResult);
    return res.json({
      audioUrl:"/api/tts/media/"+mediaId,
      timings:Array.isArray(result.timings)?result.timings:[],
      cacheHit:result.cacheHit===true,
      voice:result.voice||"mixed",
      mediaType:mediaResult.mimeType
    });
  }

  const timingHeader=Buffer.from(JSON.stringify(result.timings||[]),"utf8").toString("base64url");
  res.setHeader("Content-Type",result.mimeType||"audio/mpeg");
  res.setHeader("Content-Length",String(result.audio.length));
  res.setHeader("Cache-Control","private, max-age=31536000, immutable");
  res.setHeader("X-MemoryCast-Timings",timingHeader);
  res.setHeader("X-MemoryCast-TTS-Cache",result.cacheHit?"HIT":"MISS");
  res.setHeader("X-MemoryCast-TTS-Voice",result.voice||"mixed");
  res.send(result.audio);
}));

app.get("/tts/media/:id", requireAuth, asyncRoute(async(req,res)=>{
  const item=timedTtsMedia.get(String(req.params.id||""));
  if(!item)return res.status(404).end();

  const total=item.audio.length;
  const range=String(req.headers.range||"");
  res.setHeader("Content-Type",item.mimeType||"audio/mp4");
  res.setHeader("Accept-Ranges","bytes");
  res.setHeader("Cache-Control","private, max-age=1800");

  if(range){
    const match=/bytes=(\d*)-(\d*)/.exec(range);
    if(match){
      let start=match[1]?Number(match[1]):0;
      let end=match[2]?Number(match[2]):total-1;
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||start>=total){
        res.status(416).setHeader("Content-Range","bytes */"+total);
        return res.end();
      }
      end=Math.min(end,total-1);
      res.status(206);
      res.setHeader("Content-Range",`bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length",String(end-start+1));
      return res.end(item.audio.subarray(start,end+1));
    }
  }

  res.setHeader("Content-Length",String(total));
  res.end(item.audio);
}));

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

function cleanAiProviderChoice(value,fallback="gemini"){
  const v=String(value||"").toLowerCase();
  return ["gemini","cloudflare","openrouter","auto"].includes(v)?v:fallback;
}
async function featureProvider(uid,column,fallback="gemini"){
  const allowed=new Set([
    "ai_organize_provider","ai_quiz_provider","ai_grade_provider",
    "stt_provider","ocr_provider"
  ]);
  if(!allowed.has(column))return fallback;
  const {rows}=await query(`SELECT ${column} AS provider FROM user_settings WHERE user_id=$1`,[uid]);
  return cleanAiProviderChoice(rows[0]?.provider,fallback);
}

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

  const organizeProvider=b.ai_organize_provider==null?null:cleanAiProviderChoice(b.ai_organize_provider);
  const quizProvider=b.ai_quiz_provider==null?null:cleanAiProviderChoice(b.ai_quiz_provider);
  const gradeProvider=b.ai_grade_provider==null?null:cleanAiProviderChoice(b.ai_grade_provider);
  const sttProvider=b.stt_provider==null?null:cleanAiProviderChoice(b.stt_provider,"cloudflare");
  const ocrProvider=b.ocr_provider==null?null:cleanAiProviderChoice(b.ocr_provider,"gemini");

  const {rows}=await query(`
    UPDATE user_settings SET
      english_rate=$2,chinese_rate=$3,daily_goal=$4,
      fsrs_retention=$5,wrong_requeue=$6,
      reminder_enabled=$7,reminder_time=$8,reminder_timezone=$9,
      ai_organize_provider=COALESCE($10,ai_organize_provider),
      ai_quiz_provider=COALESCE($11,ai_quiz_provider),
      ai_grade_provider=COALESCE($12,ai_grade_provider),
      stt_provider=COALESCE($13,stt_provider),
      ocr_provider=COALESCE($14,ocr_provider),
      updated_at=NOW()
    WHERE user_id=$1 RETURNING *
  `,[
    userId(req),en,zh,goal,retention,wrong,reminderEnabled,reminderTime,reminderTimezone,
    organizeProvider,quizProvider,gradeProvider,sttProvider,ocrProvider
  ]);
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

function normalizeAttachmentRow(r){
  return {
    id:r.id,
    noteId:r.note_id,
    name:r.original_name,
    mimeType:r.mime_type,
    byteSize:Number(r.byte_size||0),
    extractedText:r.extracted_text||"",
    sortOrder:Number(r.sort_order||0),
    sourceAttachmentId:r.source_attachment_id||null,
    pageNumber:r.page_number==null?null:Number(r.page_number),
    isGenerated:r.is_generated===true,
    url:"/api/attachments/"+r.id
  };
}
function normalizeNoteRow(r){
  return {
    id:r.id,title:r.title,content:r.content,tags:r.tags||[],
    manualReviewCount:r.manual_review_count||0,
    lastReviewedAt:r.last_reviewed_at,
    studyEnabled:r.study_enabled!==false,
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
  const uid=userId(req);
  const {rows}=await query(`SELECT * FROM notes WHERE id=$2 AND user_id=$1`,[uid,req.params.id]);
  if(!rows[0]) return res.status(404).json({error:"Note not found"});
  const attachments=await query(`
    SELECT id,note_id,original_name,mime_type,byte_size,extracted_text,sort_order,source_attachment_id,page_number,is_generated,created_at
    FROM note_attachments
    WHERE note_id=$2 AND user_id=$1
    ORDER BY sort_order ASC,created_at ASC
  `,[uid,req.params.id]);
  res.json({note:{...normalizeNoteRow(rows[0]),attachments:attachments.rows.map(normalizeAttachmentRow)}});
}));
async function syncCardsFromEditedNote(uid,noteRow){
  const linked=await query(`
    SELECT * FROM cards
    WHERE user_id=$1 AND source_note_id=$2
    ORDER BY created_at ASC,id ASC
  `,[uid,noteRow.id]);

  const existing=linked.rows||[];
  if(!existing.length){
    return {status:"none",linked:0,updated:0,message:"这篇笔记没有关联卡片。"};
  }

  const targetCount=Math.min(30,existing.length);
  let generated=[];

  if(targetCount===1){
    // One linked card is safest to keep as the same learning object: update its
    // text directly from the edited note without changing FSRS/history.
    const semanticTags=await autoSemanticTags(noteRow.title,noteRow.content,"");
    generated=[{
      front:noteRow.title,
      back:noteRow.content,
      example:"",
      tags:semanticTags
    }];
  }else{
    const organizeProvider=await featureProvider(uid,"ai_organize_provider","gemini");
    const data=await generateStructured({
      provider:organizeProvider,
      name:"sync_study_cards",
      schema:organizeSchema,
      system:`Synchronize existing spaced-repetition cards from an edited source note.
Use ONLY the edited note. Do not add unsupported facts.
Return exactly ${targetCount} cards.
Keep the output array aligned with the supplied existingCards order whenever the same concept still exists:
output card 1 should update existingCards[0], card 2 updates existingCards[1], etc.
Preserve the original learning intent where possible, but rewrite stale wording to match the edited note.
Front = concise recall prompt or term.
Back = essential answer.
Example = short useful example when appropriate, otherwise empty.
For English study content, preserve useful English expressions and natural examples.
Generate 2 to 4 concise semantic tags for each card.
Do not include dates or timestamps in tags.
Return schema-valid JSON only.`,
      user:JSON.stringify({
        editedNote:{title:noteRow.title,content:noteRow.content},
        targetCount,
        existingCards:existing.slice(0,targetCount).map(c=>({
          front:c.front,back:c.back,example:c.example,tags:c.tags||[]
        }))
      })
    });
    generated=Array.isArray(data.cards)?data.cards.slice(0,targetCount):[];
  }

  let updated=0;
  for(let i=0;i<Math.min(existing.length,generated.length);i++){
    const old=existing[i];
    const fresh=generated[i];
    const front=String(fresh?.front||"").trim();
    const back=String(fresh?.back||"").trim();
    const example=String(fresh?.example||"").trim();
    if(!front||!back)continue;

    const semanticTags=Array.isArray(fresh.tags)&&fresh.tags.length
      ? fresh.tags
      : await autoSemanticTags(front,back,example);
    const tags=normalizeTags(semanticTags,old.created_at);
    const category=semanticTags[0]||old.category||"Other";

    // Deliberately update only content metadata. ID, FSRS, due time,
    // review_count and review history remain untouched.
    await query(`
      UPDATE cards
      SET front=$3,back=$4,example=$5,category=$6,tags=$7,updated_at=NOW()
      WHERE id=$2 AND user_id=$1
    `,[uid,old.id,front,back,example,category,tags]);
    updated++;
  }

  return {
    status:updated===existing.length?"synced":"partial",
    linked:existing.length,
    updated,
    message:updated===existing.length
      ? `已同步 ${updated} 张关联卡片，并保留原 FSRS 学习进度。`
      : `已同步 ${updated}/${existing.length} 张关联卡片；未成功匹配的卡片保持原样。`
  };
}

app.put("/notes/:id", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const title=String(req.body?.title||"").trim();
  const content=String(req.body?.content??"");
  if(!content.trim()) return res.status(400).json({error:"Note content is required"});

  const {rows}=await query(`
    UPDATE notes SET title=$3,content=$4,updated_at=NOW()
    WHERE id=$2 AND user_id=$1 RETURNING *
  `,[uid,req.params.id,title||noteTitle(content),content]);

  if(!rows[0]) return res.status(404).json({error:"Note not found"});

  const note=normalizeNoteRow(rows[0]);
  let cardSync={status:"none",linked:0,updated:0,message:"这篇笔记没有关联卡片。"};

  try{
    cardSync=await syncCardsFromEditedNote(uid,rows[0]);
  }catch(err){
    console.warn("Note saved but card sync failed:",err?.message||err);
    const linked=await query(`
      SELECT COUNT(*)::int AS n FROM cards
      WHERE user_id=$1 AND source_note_id=$2
    `,[uid,rows[0].id]);
    cardSync={
      status:"failed",
      linked:linked.rows[0]?.n||0,
      updated:0,
      message:"笔记已保存，但关联卡片自动同步失败；原卡片和学习进度均未被删除。"
    };
  }

  res.json({note,cardSync});
}));
app.delete("/notes/:id", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const noteId=req.params.id;
  const count=await query(`SELECT COUNT(*)::int AS n FROM cards WHERE user_id=$1 AND source_note_id=$2`,[uid,noteId]);
  const result=await query(`DELETE FROM notes WHERE id=$2 AND user_id=$1`,[uid,noteId]);
  res.json({ok:result.rowCount>0,deletedCards:result.rowCount>0?(count.rows[0]?.n||0):0});
}));
app.get("/attachments/:id", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`
    SELECT * FROM note_attachments WHERE id=$2 AND user_id=$1
  `,[userId(req),req.params.id]);
  const a=rows[0];
  if(!a) return res.status(404).json({error:"Attachment not found"});
  res.setHeader("Content-Type",a.mime_type);
  res.setHeader("Content-Length",String(a.byte_size||a.data.length||0));
  res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(a.original_name)}`);
  res.setHeader("Cache-Control","private, max-age=86400");
  res.send(a.data);
}));

app.get("/notes/:id/attachments", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`
    SELECT id,note_id,original_name,mime_type,byte_size,extracted_text,sort_order,source_attachment_id,page_number,is_generated,created_at
    FROM note_attachments
    WHERE note_id=$2 AND user_id=$1
    ORDER BY sort_order ASC,created_at ASC
  `,[userId(req),req.params.id]);
  res.json({attachments:rows.map(normalizeAttachmentRow)});
}));

app.post("/notes/:id/review", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`
    UPDATE notes SET manual_review_count=manual_review_count+1,last_reviewed_at=NOW(),updated_at=NOW()
    WHERE id=$2 AND user_id=$1 RETURNING *
  `,[userId(req),req.params.id]);
  if(!rows[0]) return res.status(404).json({error:"Note not found"});
  res.json({note:normalizeNoteRow(rows[0])});
}));
app.post("/notes/:id/study", requireAuth, asyncRoute(async(req,res)=>{
  const enabled=req.body?.enabled!==false;
  const {rows}=await query(`
    UPDATE notes SET study_enabled=$3,updated_at=NOW()
    WHERE id=$2 AND user_id=$1 RETURNING *
  `,[userId(req),req.params.id,enabled]);
  if(!rows[0]) return res.status(404).json({error:"Note not found"});
  const linked=await query(`
    SELECT COUNT(*)::int AS n FROM cards
    WHERE user_id=$1 AND source_note_id=$2
  `,[userId(req),req.params.id]);
  res.json({note:normalizeNoteRow(rows[0]),linkedCards:linked.rows[0]?.n||0});
}));

function normalizeCardRow(r){
  return {
    id:r.id,front:r.front,back:r.back,example:r.example,category:r.category,
    tags:Array.isArray(r.tags)&&r.tags.length?r.tags:[dateTag(r.created_at),r.category].filter(Boolean),
    speakOrder:r.speak_order,fsrs:r.fsrs,due:r.due,reviewCount:r.review_count,
    hiddenUntil:r.hidden_until||null,
    createdAt:r.created_at,updatedAt:r.updated_at,sourceNoteId:r.source_note_id||null,stateName:getStateName(r.fsrs)
  };
}
app.get("/cards", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`
    SELECT * FROM cards c
    WHERE c.user_id=$1
      AND (c.source_note_id IS NULL OR EXISTS (
        SELECT 1 FROM notes n WHERE n.id=c.source_note_id AND n.user_id=c.user_id AND n.study_enabled=TRUE
      ))
    ORDER BY c.created_at DESC
  `,[userId(req)]);
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
// Temporary hold: keep FSRS due time and review history intact.
app.post("/cards/:id/snooze", requireAuth, asyncRoute(async(req,res)=>{
  const days=Number(req.body?.days ?? 7);
  if(!Number.isInteger(days)||![0,3,7,14,30].includes(days))
    return res.status(400).json({error:"days must be 0, 3, 7, 14 or 30"});
  const {rows}=await query(`
    UPDATE cards SET hidden_until=CASE WHEN $3::int=0 THEN NULL
      ELSE NOW()+($3::int*INTERVAL '1 day') END,updated_at=NOW()
    WHERE user_id=$1 AND id=$2 RETURNING *
  `,[userId(req),req.params.id,days]);
  if(!rows.length)return res.status(404).json({error:"Card not found"});
  res.json({card:normalizeCardRow(rows[0])});
}));

app.get("/due", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`
    SELECT * FROM cards c
    WHERE c.user_id=$1 AND c.due<=NOW()
   AND (c.hidden_until IS NULL OR c.hidden_until<=NOW())
      AND (c.source_note_id IS NULL OR EXISTS (
        SELECT 1 FROM notes n WHERE n.id=c.source_note_id AND n.user_id=c.user_id AND n.study_enabled=TRUE
      ))
    ORDER BY c.due ASC LIMIT 500
  `,[userId(req)]);
  res.json({cards:rows.map(normalizeCardRow)});
}));

// Game practice is tracked separately from FSRS to avoid distorting due dates
// when learners repeat a game many times within the same day.
app.get("/games/cards", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const {rows}=await query(`
    WITH practice AS (
      SELECT card_id,
        COUNT(*) FILTER (WHERE NOT correct AND created_at>=NOW()-INTERVAL '30 days')::int AS recent_mistakes,
        COUNT(*) FILTER (WHERE correct AND created_at>=NOW()-INTERVAL '7 days')::int AS recent_correct,
        MAX(created_at) FILTER (WHERE correct) AS last_correct_at,
        MAX(created_at) FILTER (WHERE NOT correct) AS last_wrong_at
      FROM game_attempts WHERE user_id=$1 GROUP BY card_id
    ),
    last_review AS (
      SELECT DISTINCT ON (card_id) card_id,rating,verdict
      FROM reviews WHERE user_id=$1 ORDER BY card_id,reviewed_at DESC
    )
    SELECT c.id,c.front,c.back,c.example,c.due,
      (
        CASE WHEN c.due<=NOW() THEN 85 ELSE 5 END
        + CASE WHEN lr.rating='Again' OR lr.verdict='wrong' THEN 65 ELSE 0 END
        + CASE WHEN lr.rating='Hard' OR lr.verdict='partial' THEN 32 ELSE 0 END
        + LEAST(90,COALESCE(p.recent_mistakes,0)*18)
        - LEAST(60,COALESCE(p.recent_correct,0)*9)
        - CASE WHEN p.last_correct_at>=NOW()-INTERVAL '24 hours'
                 AND p.last_correct_at>COALESCE(p.last_wrong_at,TIMESTAMPTZ '1970-01-01')
               THEN 125 ELSE 0 END
        + LEAST(20,COALESCE((c.fsrs->>'difficulty')::numeric,0)*2)
      ) AS priority
    FROM cards c
    LEFT JOIN practice p ON p.card_id=c.id
    LEFT JOIN last_review lr ON lr.card_id=c.id
    WHERE c.user_id=$1
      AND (c.hidden_until IS NULL OR c.hidden_until<=NOW())
      AND (c.source_note_id IS NULL OR EXISTS (
        SELECT 1 FROM notes n
        WHERE n.id=c.source_note_id AND n.user_id=c.user_id AND n.study_enabled=TRUE
      ))
      AND LENGTH(TRIM(c.front)) BETWEEN 1 AND 90
      AND LENGTH(TRIM(c.back)) BETWEEN 1 AND 160
    ORDER BY priority DESC, RANDOM()
    LIMIT 100
  `,[uid]);
  res.json({cards:rows.map(c=>({
    id:c.id,front:c.front,back:c.back,example:c.example,due:c.due,
    priority:Number(c.priority||0)
  }))});
}));

app.post("/games/attempt", requireAuth, asyncRoute(async(req,res)=>{
  const {cardId,mode,correct,elapsedMs=0}=req.body||{};
  const ms=Number(elapsedMs);
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(cardId||"")) ||
     !["match","listen","spell","recall"].includes(mode) ||
     typeof correct!=="boolean" || !Number.isFinite(ms) ||
     !Number.isInteger(ms) || ms<0 || ms>600000)
    return res.status(400).json({error:"Invalid game attempt"});
  const {rows}=await query(`
    INSERT INTO game_attempts(user_id,card_id,mode,correct,elapsed_ms)
    SELECT $1,c.id,$3,$4,$5 FROM cards c
    WHERE c.user_id=$1 AND c.id=$2 AND (c.hidden_until IS NULL OR c.hidden_until<=NOW())
      AND (c.source_note_id IS NULL OR EXISTS (
        SELECT 1 FROM notes n WHERE n.id=c.source_note_id AND n.study_enabled=TRUE
      ))
    RETURNING id
  `,[userId(req),cardId,mode,correct,ms]);
  if(!rows.length)return res.status(404).json({error:"Card not found or paused"});
  res.status(201).json({ok:true});
}));

// The adventure stores completed levels separately from individual practice
// attempts. Existing FSRS scheduling is deliberately unchanged.
// Roguelite account growth is independent of FSRS and adventure history.
async function ensureArcadeProfile(uid){
  await query("INSERT INTO arcade_profiles(user_id) VALUES($1) ON CONFLICT DO NOTHING",[uid]);
}
function arcadePublicProfile(p){
  return {coins:p.coins,totalXp:p.total_xp,runs:p.runs,
    bestWave:p.best_wave,highestSector:p.highest_sector,wins:p.wins,
    upgrades:p.upgrades};
}
app.get("/arcade/profile",requireAuth,asyncRoute(async(req,res)=>{
  const uid=userId(req);
  await ensureArcadeProfile(uid);
  const {rows}=await query("SELECT * FROM arcade_profiles WHERE user_id=$1",[uid]);
  res.json({profile:arcadePublicProfile(rows[0])});
}));
app.post("/arcade/upgrade",requireAuth,asyncRoute(async(req,res)=>{
  const uid=userId(req),key=String(req.body?.key||"");
  const specs={power:[65,45],armor:[65,50],magnet:[45,35]};
  if(!Object.hasOwn(specs,key))return res.status(400).json({error:"Unknown permanent upgrade"});
  const [base,step]=specs[key];
  await ensureArcadeProfile(uid);
  const {rows}=await query(`
    UPDATE arcade_profiles
    SET coins=coins-($2 + (COALESCE((upgrades->>$4)::int,0))*$3),
        upgrades=jsonb_set(upgrades,ARRAY[$4],to_jsonb(COALESCE((upgrades->>$4)::int,0)+1),true),
        updated_at=NOW()
    WHERE user_id=$1 AND COALESCE((upgrades->>$4)::int,0)<5
      AND coins>=($2 + COALESCE((upgrades->>$4)::int,0)*$3)
    RETURNING *
  `,[uid,base,step,key]);
  if(!rows.length)return res.status(409).json({error:"金币不足，或装备已升至最高级"});
  res.json({profile:arcadePublicProfile(rows[0])});
}));
app.post("/arcade/finish",requireAuth,asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const sector=Number(req.body?.sector),wave=Number(req.body?.wave),
    kills=Number(req.body?.kills),seconds=Number(req.body?.seconds),
    won=req.body?.won===true;
  if(!Number.isInteger(sector)||sector<1||sector>3||
     !Number.isInteger(wave)||wave<1||wave>6||
     !Number.isInteger(kills)||kills<0||kills>260||
     !Number.isInteger(seconds)||seconds<1||seconds>3600||
     (won&&wave!==6)){
    return res.status(400).json({error:"Invalid arcade run"});
  }
  await ensureArcadeProfile(uid);
  const earnedCoins=Math.min(260,Math.floor(wave*8+kills*1.4+(won?45:0)+sector*3));
  const earnedXp=Math.min(700,Math.floor(wave*25+kills*3+(won?105:0)+sector*12));
  const {rows}=await query(`
    UPDATE arcade_profiles
    SET coins=LEAST(1000000,coins+$2),
        total_xp=LEAST(100000000,total_xp+$3),
        runs=runs+1,best_wave=GREATEST(best_wave,$4),
        wins=wins+CASE WHEN $5 THEN 1 ELSE 0 END,
        highest_sector=CASE WHEN $5 THEN GREATEST(highest_sector,LEAST(3,$6+1))
                            ELSE highest_sector END,
        updated_at=NOW()
    WHERE user_id=$1 AND highest_sector >= $6
    RETURNING *
  `,[uid,earnedCoins,earnedXp,wave,won,sector]);
  if(!rows.length)return res.status(409).json({error:"请先解锁当前战区"});
  res.json({ok:true,rewards:{coins:earnedCoins,xp:earnedXp},profile:arcadePublicProfile(rows[0])});
}));

app.get("/adventure/progress",requireAuth,asyncRoute(async(req,res)=>{
  const {rows}=await query(
    "SELECT level,stars,best_seconds,completed_at FROM adventure_progress WHERE user_id=$1 ORDER BY level",
    [userId(req)]
  );
  res.json({levels:rows,highestCompleted:rows.reduce((max,row)=>Math.max(max,row.level),0)});
}));

app.post("/adventure/complete",requireAuth,asyncRoute(async(req,res)=>{
  const level=Number(req.body?.level),stars=Number(req.body?.stars),seconds=Number(req.body?.seconds);
  if(!Number.isInteger(level)||level<1||level>8||
     !Number.isInteger(stars)||stars<1||stars>3||
     !Number.isInteger(seconds)||seconds<1||seconds>3600){
    return res.status(400).json({error:"Invalid adventure completion"});
  }
  // The previous level must be completed on this same user account.
  const {rows}=await query(`
    INSERT INTO adventure_progress(user_id,level,stars,best_seconds)
    SELECT $1,$2,$3,$4 WHERE $2=1 OR EXISTS(
      SELECT 1 FROM adventure_progress WHERE user_id=$1 AND level=$2-1
    )
    ON CONFLICT(user_id,level)
    DO UPDATE SET
      stars=GREATEST(adventure_progress.stars,EXCLUDED.stars),
      best_seconds=LEAST(adventure_progress.best_seconds,EXCLUDED.best_seconds)
    RETURNING level,stars,best_seconds,completed_at
  `,[userId(req),level,stars,seconds]);
  if(!rows.length)return res.status(409).json({error:"请先通关上一关"});
  res.json({ok:true,record:rows[0],unlocked:Math.min(8,level+1)});
}));

app.get("/games/stats", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const [overall,modes]=await Promise.all([
    query(`
      SELECT COUNT(*)::int AS attempts,
        COUNT(*) FILTER (WHERE correct)::int AS correct,
        COUNT(*) FILTER (WHERE NOT correct)::int AS mistakes,
        COUNT(*) FILTER (WHERE created_at>=NOW()-INTERVAL '7 days')::int AS last7,
        COUNT(DISTINCT card_id)::int AS practiced_cards
      FROM game_attempts WHERE user_id=$1
    `,[uid]),
    query(`
      SELECT mode,COUNT(*)::int AS attempts,COUNT(*) FILTER (WHERE correct)::int AS correct
      FROM game_attempts WHERE user_id=$1 GROUP BY mode ORDER BY mode
    `,[uid])
  ]);
  res.json({overall:overall.rows[0],modes:modes.rows});
}));

app.get("/walkman", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const {rows}=await query(`
    WITH latest_review AS (
      SELECT DISTINCT ON (card_id)
        card_id,rating,verdict,reviewed_at
      FROM reviews
      WHERE user_id=$1
      ORDER BY card_id,reviewed_at DESC
    ),
    ranked AS (
      SELECT
        c.*,
        lr.rating AS last_rating,
        lr.verdict AS last_verdict,
        lr.reviewed_at AS last_reviewed_at,
        CASE
          WHEN lr.rating='Again' OR lr.verdict='wrong' THEN 1
          WHEN lr.rating='Hard' OR lr.verdict='partial' THEN 2
          WHEN c.due<=NOW() THEN 3
          ELSE 4
        END AS listen_tier,
        (
          COALESCE((c.fsrs->>'difficulty')::float,0) * 10
          + 100.0 / (1.0 + GREATEST(0,COALESCE((c.fsrs->>'stability')::float,0)))
          + LEAST(60,GREATEST(0,EXTRACT(EPOCH FROM (NOW()-c.due))/86400))
        ) AS instability_score
      FROM cards c
      LEFT JOIN latest_review lr ON lr.card_id=c.id
      WHERE c.user_id=$1
        AND (c.hidden_until IS NULL OR c.hidden_until<=NOW())
        AND (c.source_note_id IS NULL OR EXISTS (
          SELECT 1 FROM notes n WHERE n.id=c.source_note_id AND n.user_id=c.user_id AND n.study_enabled=TRUE
        ))
    )
    SELECT * FROM ranked
    ORDER BY
      listen_tier ASC,
      CASE WHEN listen_tier IN (1,2) THEN last_reviewed_at END DESC NULLS LAST,
      instability_score DESC,
      due ASC
    LIMIT 500
  `,[uid]);

  res.json({
    cards:rows.map(r=>({
      ...normalizeCardRow(r),
      lastRating:r.last_rating||null,
      lastVerdict:r.last_verdict||null,
      lastReviewedAt:r.last_reviewed_at||null,
      listenTier:Number(r.listen_tier||4),
      instabilityScore:Number(r.instability_score||0)
    }))
  });
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

async function transcribeAudio(audio,mimeType,providerChoice="auto"){
  const providerMap={
    cloudflare:transcribeWithCloudflare,
    gemini:transcribeWithGemini,
    openrouter:transcribeWithOpenRouter
  };
  const selected=cleanAiProviderChoice(providerChoice,"auto");
  const providers=selected==="auto"
    ? [transcribeWithCloudflare,transcribeWithGemini]
    : [providerMap[selected]];
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

  const sttProvider=await featureProvider(userId(req),"stt_provider","cloudflare");
  const result=await transcribeAudio(audio,mimeType,sttProvider);
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
  const ocrProvider=await featureProvider(userId(req),"ocr_provider","gemini");
  const result=await extractTextFromImage({base64:image.toString("base64"),mimeType,provider:ocrProvider});
  const note=await saveCapturedNote(userId(req),result.text,"OCR笔记");
  res.json({text:result.text,note,model:result.model,provider:result.provider});
}));

async function renderPdfPages(pdfBuffer,maxPages=12){
  const dir=await mkdtemp(path.join(os.tmpdir(),"memorycast-pdf-"));
  const pdfPath=path.join(dir,"source.pdf");
  const prefix=path.join(dir,"page");
  try{
    await writeFile(pdfPath,pdfBuffer);
    await execFileAsync("pdftoppm",[
      "-jpeg",
      "-r","135",
      "-f","1",
      "-l",String(maxPages),
      pdfPath,
      prefix
    ],{maxBuffer:16*1024*1024});

    const names=(await readdir(dir))
      .filter(name=>/^page-\d+\.jpg$/i.test(name))
      .sort((a,b)=>{
        const na=Number(a.match(/(\d+)/)?.[1]||0);
        const nb=Number(b.match(/(\d+)/)?.[1]||0);
        return na-nb;
      });

    const pages=[];
    for(const name of names){
      const pageNumber=Number(name.match(/(\d+)/)?.[1]||0);
      const data=await readFile(path.join(dir,name));
      pages.push({pageNumber,data});
    }
    return pages;
  }finally{
    await rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

app.post("/ai/import-media", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const files=Array.isArray(req.body?.files)?req.body.files.slice(0,12):[];
  if(!files.length) return res.status(400).json({error:"请选择图片或 PDF。"});

  let noteId=String(req.body?.noteId||"").trim();
  let existingNote=null;
  if(noteId){
    const n=await query(`SELECT * FROM notes WHERE id=$2 AND user_id=$1`,[uid,noteId]);
    existingNote=n.rows[0]||null;
    if(!existingNote)noteId="";
  }

  const extracted=[];
  const prepared=[];
  const ocrProvider=await featureProvider(uid,"ocr_provider","gemini");

  for(let i=0;i<files.length;i++){
    const f=files[i]||{};
    const mime=String(f.mimeType||"").split(";")[0].toLowerCase();
    const name=String(f.name||("附件-"+(i+1))).slice(0,180);
    const data=decodeBase64Payload(f.dataBase64);

    if(!data.length)continue;
    if(data.length>15_000_000) throw Object.assign(new Error(name+" 超过 15MB，请压缩后上传。"),{statusCode:413});

    let text="";
    if(["image/jpeg","image/png","image/webp"].includes(mime)){
      const result=await extractTextFromImage({
        base64:data.toString("base64"),
        mimeType:mime,
        provider:ocrProvider
      });
      text=String(result.text||"").trim();
    }else if(mime==="application/pdf"){
      const parsed=await pdfParse(data);
      text=String(parsed?.text||"").replace(/\u0000/g,"").trim();
      if(!text) text="[此 PDF 未提取到文字，可能是扫描版 PDF；原文件已保留。]";
    }else{
      throw Object.assign(new Error("暂不支持文件类型："+mime),{statusCode:400});
    }

    extracted.push(text);
    prepared.push({name,mime,data,text,sortOrder:i});
  }

  if(!prepared.length) return res.status(400).json({error:"没有有效附件。"});

  const joined=extracted.filter(Boolean).join("\n\n---\n\n");
  let noteRow;
  if(existingNote){
    const nextContent=[String(existingNote.content||"").trim(),joined].filter(Boolean).join("\n\n");
    const updated=await query(`
      UPDATE notes SET content=$3,updated_at=NOW()
      WHERE id=$2 AND user_id=$1 RETURNING *
    `,[uid,existingNote.id,nextContent]);
    noteRow=updated.rows[0];
  }else{
    const titleSource=joined && !joined.startsWith("[此 PDF") ? joined : prepared[0].name;
    const created=await query(`
      INSERT INTO notes(user_id,title,content,tags)
      VALUES($1,$2,$3,$4) RETURNING *
    `,[uid,noteTitle(titleSource),joined,normalizeTags(["多模态笔记"])]);
    noteRow=created.rows[0];
    noteId=noteRow.id;
  }

  const saved=[];
  for(const f of prepared){
    const {rows}=await query(`
      INSERT INTO note_attachments(
        user_id,note_id,original_name,mime_type,byte_size,data,extracted_text,sort_order,
        source_attachment_id,page_number,is_generated
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,FALSE)
      RETURNING id,note_id,original_name,mime_type,byte_size,extracted_text,sort_order,
        source_attachment_id,page_number,is_generated,created_at
    `,[uid,noteRow.id,f.name,f.mime,f.data.length,f.data,f.text,f.sortOrder]);

    const original=rows[0];
    saved.push(normalizeAttachmentRow(original));

    if(f.mime==="application/pdf"){
      try{
        const pages=await renderPdfPages(f.data,12);
        for(const p of pages){
          const pageName=f.name.replace(/\.pdf$/i,"")+" · 第 "+p.pageNumber+" 页.jpg";
          const pageSort=f.sortOrder*100+p.pageNumber;
          const inserted=await query(`
            INSERT INTO note_attachments(
              user_id,note_id,original_name,mime_type,byte_size,data,extracted_text,sort_order,
              source_attachment_id,page_number,is_generated
            )
            VALUES($1,$2,$3,'image/jpeg',$4,$5,'',$6,$7,$8,TRUE)
            RETURNING id,note_id,original_name,mime_type,byte_size,extracted_text,sort_order,
              source_attachment_id,page_number,is_generated,created_at
          `,[
            uid,noteRow.id,pageName,p.data.length,p.data,pageSort,original.id,p.pageNumber
          ]);
          saved.push(normalizeAttachmentRow(inserted.rows[0]));
        }
      }catch(err){
        console.warn("PDF page rendering failed:",f.name,err?.message||err);
      }
    }
  }

  res.json({
    note:{...normalizeNoteRow(noteRow),attachments:saved},
    text:joined,
    attachments:saved
  });
}));

const organizeSchema={
  type:"object",
  properties:{cards:{type:"array",minItems:1,maxItems:30,items:{
    type:"object",
    properties:{front:{type:"string"},lemma:{type:"string"},inflection:{type:"string"},back:{type:"string"},example:{type:"string"},tags:{type:"array",minItems:2,maxItems:4,items:{type:"string"}}},
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
    const organizeProvider=await featureProvider(userId(req),"ai_organize_provider","gemini");
    const data=await generateStructured({
      provider:organizeProvider,
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


const listeningExamSchema={
  type:"object",
  properties:{
    title:{type:"string"},
    transcript:{type:"string"},
    questions:{type:"array",minItems:3,maxItems:8,items:{
      type:"object",
      properties:{
        type:{type:"string",enum:["mcq","fill"]},
        prompt:{type:"string"},
        choices:{type:"array",items:{type:"string"},maxItems:4},
        answer:{type:"string"},
        explanation:{type:"string"},
        evidence:{type:"string"}
      },
      required:["type","prompt","choices","answer","explanation","evidence"],
      additionalProperties:false
    }}
  },
  required:["title","transcript","questions"],additionalProperties:false
};
// Persistent listening examinations: survive API restarts and never expire automatically.
async function ensureListeningSessions(){
  await query(`CREATE TABLE IF NOT EXISTS listening_exam_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    transcript TEXT NOT NULL,
    questions JSONB NOT NULL,
    level TEXT NOT NULL,
    topic TEXT NOT NULL,
    answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    results JSONB,
    vocabulary JSONB,
    vocabulary_partial BOOLEAN NOT NULL DEFAULT FALSE,
    audio_data BYTEA,
    audio_mime TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    graded BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query("ALTER TABLE listening_exam_sessions ADD COLUMN IF NOT EXISTS audio_data BYTEA");
  await query("ALTER TABLE listening_exam_sessions ADD COLUMN IF NOT EXISTS audio_mime TEXT");
  await query("CREATE INDEX IF NOT EXISTS idx_listening_sessions_user_time ON listening_exam_sessions(user_id, created_at DESC)");
}
async function getListeningSession(id,uid){
  if(!/^[0-9a-f-]{36}$/i.test(String(id||"")))return null;
  await ensureListeningSessions();
  const {rows}=await query("SELECT * FROM listening_exam_sessions WHERE id=$1 AND user_id=$2",[id,uid]);
  const row=rows[0];
  return row?{id:row.id,uid:row.user_id,title:row.title,transcript:row.transcript,questions:row.questions,level:row.level,topic:row.topic,answers:row.answers,results:row.results,vocabulary:row.vocabulary,vocabularyPartial:row.vocabulary_partial,graded:row.graded,durationSeconds:row.duration_seconds}:null;
}
app.get("/listening/sessions",requireAuth,asyncRoute(async(req,res)=>{
  await ensureListeningSessions();
  const {rows}=await query("SELECT id,title,level,topic,graded,created_at,updated_at FROM listening_exam_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[userId(req)]);
  res.json({sessions:rows});
}));
app.get("/listening/session/:id",requireAuth,asyncRoute(async(req,res)=>{
  const session=await getListeningSession(req.params.id,userId(req));
  if(!session)return res.status(404).json({error:"未找到本次听力记录"});
  const {questions,results}=session;
  res.json({sessionId:session.id,title:session.title,level:session.level,topic:session.topic,graded:session.graded,answers:session.answers,
    transcript:session.graded?session.transcript:undefined,results:session.graded?results:undefined,
    questions:session.graded?questions:questions.map(({answer,explanation,...safe})=>safe)});
}));
app.post("/listening/progress",requireAuth,asyncRoute(async(req,res)=>{
  const id=String(req.body?.sessionId||""),session=await getListeningSession(id,userId(req));
  if(!session)return res.status(404).json({error:"听力记录不存在"});
  if(session.graded)return res.status(409).json({error:"试卷已经提交"});
  const raw=req.body?.answers;
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return res.status(400).json({error:"答案格式无效"});
  const answers=Object.fromEntries(session.questions.map(q=>[q.id,String(raw[q.id]||"").slice(0,1000)]));
  await query("UPDATE listening_exam_sessions SET answers=$3::jsonb,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND graded=FALSE",[id,session.uid,JSON.stringify(answers)]);
  res.json({ok:true});
}));
async function ensureListeningHistory(){
  await query(`CREATE TABLE IF NOT EXISTS listening_exam_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    topic TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    results JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query("CREATE INDEX IF NOT EXISTS idx_listening_exam_history_user_time ON listening_exam_history(user_id,created_at DESC)");
}
app.get("/listening/history",requireAuth,asyncRoute(async(req,res)=>{
  await ensureListeningHistory();
  const {rows}=await query("SELECT level,topic,score,total,results,created_at FROM listening_exam_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[userId(req)]);
  const total=rows.reduce((n,r)=>n+r.total,0),correct=rows.reduce((n,r)=>n+r.score,0);
  const bySkill={};
  for(const r of rows)for(const x of r.results){
    const skill=x.skill||"comprehension";
    const v=bySkill[skill]||(bySkill[skill]={correct:0,total:0});
    v.total++;if(x.correct)v.correct++;
  }
  const recentResults=rows.slice(0,5).flatMap(r=>r.results||[]);
  const recentWeak=Object.entries(bySkill).filter(([,v])=>v.total>=2).sort((a,b)=>a[1].correct/a[1].total-b[1].correct/b[1].total);
  res.json({history:rows.map(({results,...r})=>r),attempts:rows.length,accuracy:total?Math.round(correct/total*100):null,bySkill,
    weakSkills:recentWeak.slice(0,3).map(([skill,v])=>({skill,accuracy:Math.round(100*v.correct/v.total),count:v.total})),
    recentAccuracy:recentResults.length?Math.round(100*recentResults.filter(x=>x.correct).length/recentResults.length):null,
    estimate:null,estimateNote:"AI 原创题未经过 IELTS 标定，暂不提供雅思分数。"});
}));

app.post("/listening/generate",requireAuth,asyncRoute(async(req,res)=>{
  const uid=userId(req);
  await ensureListeningHistory();
  const {rows:recent}=await query("SELECT level,score,total,topic FROM listening_exam_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 8",[uid]);
  const levels=["A2","B1","B2","C1"];
  let level="B1";
  if(recent.length>=2){
    const ratio=recent.reduce((a,r)=>a+r.score,0)/Math.max(1,recent.reduce((a,r)=>a+r.total,0));
    const current=levels.indexOf(recent[0].level);
    level=levels[Math.max(0,Math.min(3,current+(ratio>=0.8?1:ratio<0.5?-1:0)))];
  }
  const topics=["campus conversation","university lecture on biology","academic lecture on geology","student services conversation","academic lecture on history","campus housing discussion","academic lecture on astronomy"];
  const recentTopics=new Set(recent.slice(0,3).map(r=>r.topic));
  const available=topics.filter(t=>!recentTopics.has(t));
  const pool=available.length?available:topics;
  const topic=pool[Math.floor(Math.random()*pool.length)];
  const weak=await query("SELECT results FROM listening_exam_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 8",[uid]);
  const tally={};
  for(const row of weak.rows)for(const q of row.results||[]){const k=q.skill||"comprehension";const v=tally[k]||(tally[k]={ok:0,n:0});v.n++;if(q.correct)v.ok++;}
  const weakSkill=Object.entries(tally).filter(([,v])=>v.n>=2).sort((a,b)=>a[1].ok/a[1].n-b[1].ok/b[1].n)[0]?.[0]||"";
  const provider=await featureProvider(uid,"ai_quiz_provider","gemini");
  const data=await generateStructured({
    provider,name:"memorycast_listening_exam",schema:listeningExamSchema,maxTokens:2800,timeoutMs:45000,raceProviders:true,
    validateResult:d=>{
      if(typeof d?.title!=="string"||typeof d?.transcript!=="string"||!d.transcript.trim()||
        !Array.isArray(d.questions)||d.questions.length!==5)return false;
      return d.questions.every(q=>
        q&&q.type==="mcq"&&typeof q.prompt==="string"&&q.prompt.trim()&&
        Array.isArray(q.choices)&&q.choices.length===4&&
        q.choices.every(c=>typeof c==="string"&&c.trim())&&new Set(q.choices).size===4&&
        typeof q.answer==="string"&&q.choices.includes(q.answer)&&
        typeof q.explanation==="string"&&q.explanation.trim()&&
        typeof q.evidence==="string"&&q.evidence.trim()&&d.transcript.includes(q.evidence.trim()));
    },
    system:"Create an ORIGINAL TOEFL-style English listening comprehension exam at CEFR "+level+". Produce a coherent university conversation or academic lecture of 150-240 words. Generate exactly 5 questions: 5 mcq with four distinct plausible choices. Include main idea, detail, inference, speaker attitude and organization questions. All questions must be answerable from the transcript. Questions and options in English. Answers must be unambiguous. Do not reveal answers in prompts. Provide concise Chinese explanations. For EACH question include evidence: a short exact verbatim contiguous quote from the transcript (ideally one sentence) that supports the answer. Do not paraphrase evidence. Return only the requested JSON.",
    user:JSON.stringify({topic,level,weakSkill,adaptation:weakSkill?"Prioritize one or two new questions testing this weak skill while retaining five distinct question types. Do not reuse previous questions.":""})
  });
  // Do not coerce AI objects into "[object Object]" and accidentally treat them as valid questions.
  const plainText=value=>typeof value==="string"?value.trim():"";
  const transcript=plainText(data?.transcript).slice(0,3500);
  const rawQuestions=Array.isArray(data?.questions)?data.questions:[];
  const questions=rawQuestions.slice(0,8).map((q,i)=>({
    id:String(i+1),type:q?.type==="fill"?"fill":"mcq",
    prompt:plainText(q?.prompt).slice(0,350),
    choices:Array.isArray(q?.choices)?q.choices.map(x=>plainText(x).slice(0,350)).slice(0,4):[],
    answer:plainText(q?.answer),
    explanation:plainText(q?.explanation).slice(0,600),
    evidence:plainText(q?.evidence).slice(0,450)
  }));
  const invalid=typeof data?.title!=="string"||!transcript||questions.length!==5||
    questions.some(q=>!q.prompt||q.prompt==="[object Object]"||!q.answer||!q.explanation||
      q.type!=="mcq"||q.choices.length!==4||q.choices.some(c=>!c||c==="[object Object]")||
      new Set(q.choices).size!==4||!q.choices.includes(q.answer)||
      !q.evidence||!transcript.includes(q.evidence));
  if(invalid){
    console.warn("Listening AI output failed structural validation (question fields, options or evidence).");
    return res.status(502).json({error:"AI 返回的试卷格式不正确（题干或选项不完整），请重新生成。"});
  }
  const id=crypto.randomUUID();
  await ensureListeningSessions();
  await query("INSERT INTO listening_exam_sessions(id,user_id,title,transcript,questions,level,topic) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",
    [id,uid,String(data.title||"Listening Exam").slice(0,100),transcript,JSON.stringify(questions),level,topic]);
  res.json({sessionId:id,title:String(data.title||"Listening Exam").slice(0,100),transcriptLength:transcript.length,
    questions:questions.map(({answer,explanation,...safe})=>safe)});
}));

const listeningVocabSchema={
  type:"object",
  properties:{
    cards:{type:"array",items:{
      type:"object",
      properties:{
        front:{type:"string"},
        lemma:{type:"string"},
        inflection:{type:"string"},
        back:{type:"string"},
        example:{type:"string"},
        related:{type:"string"},
        ipa:{type:"string"},
        memoryMethod:{type:"string"},
        memoryTip:{type:"string"},
        commonUsages:{type:"array",minItems:1,maxItems:3,items:{
          type:"object",properties:{phrase:{type:"string"},meaning:{type:"string"}},
          required:["phrase","meaning"],additionalProperties:false
        }},
        bestExample:{type:"string"},
        bestExampleZh:{type:"string"}
      },
      required:["front","lemma","inflection","back","example","related","ipa","memoryMethod","memoryTip","commonUsages","bestExample","bestExampleZh"],
      additionalProperties:false
    }}
  },
  required:["cards"],additionalProperties:false
};
app.post("/listening/vocabulary",requireAuth,asyncRoute(async(req,res)=>{
  const session=await getListeningSession(String(req.body?.sessionId||""),userId(req));
  if(!session)return res.status(404).json({error:"听力记录不存在。"});
  if(!session.graded)return res.status(403).json({error:"请先提交试卷。"});
  if(session.vocabulary && req.body?.refresh!==true)return res.json({cards:session.vocabulary,partial:Boolean(session.vocabularyPartial)});
  const provider=await featureProvider(session.uid,"ai_quiz_provider","gemini");
  const basePrompt="You are a thorough TOEFL listening vocabulary analyst. Extract a BROAD and inclusive list of useful content words, academic terms, phrasal verbs, collocations, paraphrases and domain-specific terminology. Do not filter out terms merely because they are B1 or common. Exclude only articles, pronouns, basic auxiliaries and trivial function words. Never invent extracted terms absent from the supplied source. Return 15-35 entries if the source has enough terms; otherwise include all meaningful terms. For EVERY item: front is the EXACT term as encountered; lemma is dictionary base form (verb infinitive without to, singular noun, positive adjective); inflection is a short accurate Chinese explanation or empty for base forms; back is Chinese meaning and part of speech; example quotes a natural English sentence from the supplied source, followed by Chinese translation when possible; ipa is standard American IPA or empty if unsure; memoryMethod is 谐音联想/词根词缀/拆分联想/场景故事/对比记忆 and memoryTip is a concise accurate mnemonic (never invent etymology); commonUsages lists preferably 2-3 genuinely common, idiomatic collocations or patterns for the main meaning, each with a short Chinese meaning (use 1 only if no others are reliably common, do not fabricate frequencies); bestExample is ONE NEW memorable, natural, grammatically correct English sentence (ideally 8-16 words), not copied from the source, that demonstrates the most useful meaning and a common collocation in an academic or everyday context; bestExampleZh is an accurate natural Chinese translation of that new sentence. Prefer simple, concrete, reusable sentences; avoid forced vocabulary and overly long sentences. related MUST match source category. Keep usage text concise. Return JSON only.";
  const tasks=[
    {source:"原文",text:session.transcript},
    {source:"选项",text:session.questions.map((q,i)=>"Q"+(i+1)+": "+q.prompt+"\\n"+q.choices.join("\\n")).join("\\n")}
  ];
  const settled=await Promise.allSettled(tasks.map(t=>generateStructured({
    provider,name:"listening_vocabulary_"+(t.source==="原文"?"transcript":"options"),schema:listeningVocabSchema,maxTokens:11000,
    system:basePrompt+" Set related='"+t.source+"' for every item. Analyze the ENTIRE source, not only the first paragraph or first question.",
    user:JSON.stringify({topic:session.topic,source:t.source,text:t.text})
  })));
  const seen=new Set();
  const gathered=[];
  for(let i=0;i<settled.length;i++){
    if(settled[i].status!=="fulfilled")continue;
    for(const x of (Array.isArray(settled[i].value?.cards)?settled[i].value.cards:[])){
      const usages=Array.isArray(x.commonUsages)?x.commonUsages.slice(0,3).map(u=>({
        phrase:String(u?.phrase||"").trim().slice(0,120),
        meaning:String(u?.meaning||"").trim().slice(0,160)
      })).filter(u=>u.phrase&&u.meaning):[];
      const item={
        front:String(x.front||"").trim().slice(0,120),
        lemma:String(x.lemma||x.front||"").trim().slice(0,120),
        inflection:String(x.inflection||"").trim().slice(0,100),
        back:String(x.back||"").trim().slice(0,260),
        example:String(x.example||"").trim().slice(0,400),
        related:tasks[i].source,
        ipa:String(x.ipa||"").trim().slice(0,120),
        memoryMethod:String(x.memoryMethod||"场景故事").trim().slice(0,24),
        memoryTip:String(x.memoryTip||"").trim().slice(0,240),
        commonUsages:usages,
        bestExample:String(x.bestExample||"").trim().slice(0,300),
        bestExampleZh:String(x.bestExampleZh||"").trim().slice(0,300)
      };
      const key=item.front.toLowerCase().replace(/\\s+/g," ");
      if(!key||!item.back||seen.has(key))continue;
      seen.add(key);gathered.push(item);
    }
  }
  if(!gathered.length){
    const err=new Error("词汇提取失败，请重试；两组 AI 请求均未成功。");err.statusCode=502;throw err;
  }
  session.vocabulary=gathered.slice(0,70);
  session.vocabularyPartial=settled.some(x=>x.status==="rejected");
  await query("UPDATE listening_exam_sessions SET vocabulary=$3::jsonb,vocabulary_partial=$4,updated_at=NOW() WHERE id=$1 AND user_id=$2",
    [session.id,session.uid,JSON.stringify(session.vocabulary),session.vocabularyPartial]);
  res.json({cards:session.vocabulary,partial:session.vocabularyPartial});
}));
app.post("/listening/grade",requireAuth,asyncRoute(async(req,res)=>{
  const session=await getListeningSession(String(req.body?.sessionId||""),userId(req));
  if(!session)return res.status(404).json({error:"听力记录不存在。"});
  if(session.graded)return res.status(409).json({error:"本次考试已提交，请在历史记录中查看。"});
  const answers=req.body?.answers||{};
  const normalize=x=>String(x||"").trim().toLowerCase().replace(/[.,!?;:]/g,"").replace(/\\s+/g," ");
  const results=session.questions.map(q=>{
    const submitted=String(answers[q.id]||"");
    const evidence=session.transcript.includes(q.evidence)?q.evidence:"";
    return {id:q.id,evidence,skill:["main idea","detail","inference","attitude","organization"][Number(q.id)-1]||"comprehension",prompt:q.prompt,correct:normalize(submitted)===normalize(q.answer),
      submitted,answer:q.answer,explanation:q.explanation};
  });
  const score=results.filter(r=>r.correct).length;
  const durationSeconds=Math.max(0,Math.min(7200,Number(req.body?.durationSeconds)||0));
  await ensureListeningHistory();
  await query("INSERT INTO listening_exam_history(user_id,level,topic,score,total,results) VALUES($1,$2,$3,$4,$5,$6::jsonb)",[session.uid,session.level,session.topic,score,results.length,JSON.stringify(results)]);
  const wrong=results.filter(r=>!r.correct);
  if(wrong.length){
    const content=wrong.map(r=>"题目："+r.prompt+"\\n你的答案："+r.submitted+"\\n正确答案："+r.answer+"\\n解析："+r.explanation).join("\\n\\n");
    await query("INSERT INTO notes(user_id,title,content,tags) VALUES($1,$2,$3,$4)",[session.uid,"TOEFL 听力错题 · "+new Date().toISOString().slice(0,10),"听力原文：\\n"+session.transcript+"\\n\\n"+content,["TOEFL","Listening","错题"]]);
  }
  await query("UPDATE listening_exam_sessions SET answers=$3::jsonb,results=$4::jsonb,duration_seconds=$5,graded=TRUE,updated_at=NOW() WHERE id=$1 AND user_id=$2",
    [session.id,session.uid,JSON.stringify(answers),JSON.stringify(results),durationSeconds]);
  res.json({score,total:results.length,results,transcript:session.transcript,savedWrong:wrong.length,durationSeconds});
}));


app.get("/listening/sentence-audio/:id/:index",requireAuth,asyncRoute(async(req,res)=>{
  const session=await getListeningSession(String(req.params.id||""),userId(req));
  if(!session||!session.graded)return res.status(404).json({error:"音频不可用"});
  const sentences=session.transcript.match(/[^.!?]+[.!?]+(?:["']|$)?|[^.!?]+$/g)?.map(x=>x.trim()).filter(Boolean)||[];
  const index=Number(req.params.index);
  if(!Number.isInteger(index)||index<0||index>=sentences.length)return res.status(400).json({error:"句子序号无效"});
  const result=await synthesizeTimedTts([{parts:[{text:sentences[index],language:"en-US",style:"natural",rate:1}]}],{format:"mp3"});
  res.setHeader("Content-Type",result.mimeType||"audio/mpeg");res.setHeader("Cache-Control","private, no-store");res.send(result.audio);
}));
app.get("/listening/audio/:id",requireAuth,asyncRoute(async(req,res)=>{
  const session=await getListeningSession(String(req.params.id||""),userId(req));
  if(!session)return res.status(404).json({error:"听力记录不存在"});
  // Cache the first successful synthesis so historical recordings work even if TTS is later unavailable.
  const cached=await query("SELECT audio_data,audio_mime FROM listening_exam_sessions WHERE id=$1 AND user_id=$2",[session.id,session.uid]);
  const saved=cached.rows[0];
  if(saved?.audio_data){
    res.setHeader("Content-Type",saved.audio_mime||"audio/mpeg");
    res.setHeader("Cache-Control","private, no-store");
    return res.send(saved.audio_data);
  }
  const result=await synthesizeTimedTts([{parts:[{text:session.transcript,language:"en-US",style:"natural",rate:1}]}],{format:"mp3"});
  const mime=result.mimeType||"audio/mpeg";
  await query("UPDATE listening_exam_sessions SET audio_data=$3,audio_mime=$4 WHERE id=$1 AND user_id=$2 AND audio_data IS NULL",[session.id,session.uid,result.audio,mime]);
  res.setHeader("Content-Type",mime);
  res.setHeader("Cache-Control","private, no-store");
  res.send(result.audio);
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
        explanation:{type:"string"},audioText:{type:"string"},
        difficultyLevel:{type:"string",enum:["foundation","standard","challenge"]},
        visualAttachmentId:{type:"string"}
      },
      required:["cardId","type","prompt","choices","answer","acceptableAnswers","explanation","audioText","difficultyLevel","visualAttachmentId"],
      additionalProperties:false
    }}
  },
  required:["title","questions"],additionalProperties:false
};

const adaptiveQuestionSchema={
  type:"object",
  properties:{
    cardId:{type:"string"},
    type:{type:"string",enum:["mcq","fill","short","listening"]},
    prompt:{type:"string"},
    choices:{type:"array",items:{type:"string"},maxItems:4},
    answer:{type:"string"},
    acceptableAnswers:{type:"array",items:{type:"string"},maxItems:8},
    explanation:{type:"string"},
    audioText:{type:"string"},
    difficultyLevel:{type:"string",enum:["foundation","standard","challenge"]},
    visualAttachmentId:{type:"string"}
  },
  required:["cardId","type","prompt","choices","answer","acceptableAnswers","explanation","audioText","difficultyLevel","visualAttachmentId"],
  additionalProperties:false
};

const watchQuizSchema=JSON.parse(JSON.stringify(quizSchema));
watchQuizSchema.properties.questions.items.properties.type.enum=["mcq"];
watchQuizSchema.properties.questions.items.properties.choices.minItems=4;
watchQuizSchema.properties.questions.items.properties.choices.maxItems=4;

const watchAdaptiveQuestionSchema=JSON.parse(JSON.stringify(adaptiveQuestionSchema));
watchAdaptiveQuestionSchema.properties.type.enum=["mcq"];
watchAdaptiveQuestionSchema.properties.choices.minItems=4;
watchAdaptiveQuestionSchema.properties.choices.maxItems=4;

const visualQuizQuestionSchema={
  type:"object",
  properties:{
    type:{type:"string",enum:["mcq","fill","short"]},
    prompt:{type:"string"},
    choices:{type:"array",items:{type:"string"},maxItems:4},
    answer:{type:"string"},
    acceptableAnswers:{type:"array",items:{type:"string"},maxItems:8},
    explanation:{type:"string"},
    difficultyLevel:{type:"string",enum:["foundation","standard","challenge"]}
  },
  required:["type","prompt","choices","answer","acceptableAnswers","explanation","difficultyLevel"],
  additionalProperties:false
};
app.post("/quiz/generate", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const watchMode=req.body?.watchMode===true;
  const count=Math.min(20,Math.max(3,Number(req.body?.count||10)));
  const mode=["mixed","weak","due"].includes(req.body?.mode)?req.body.mode:"mixed";
  const requestedIds=Array.isArray(req.body?.cardIds)
    ? req.body.cardIds.map(String).filter(Boolean).slice(0,30)
    : [];

  const {rows}=await query(`
    WITH review_stats AS (
      SELECT
        card_id,
        COUNT(*) FILTER (WHERE rating='Again' OR verdict='wrong')::int AS wrong_count,
        COUNT(*) FILTER (WHERE rating='Hard' OR verdict='partial')::int AS hard_count,
        (ARRAY_AGG(rating ORDER BY reviewed_at DESC))[1] AS last_rating,
        (ARRAY_AGG(verdict ORDER BY reviewed_at DESC))[1] AS last_verdict,
        MAX(reviewed_at) AS last_reviewed_at
      FROM reviews
      WHERE user_id=$1
      GROUP BY card_id
    )
    SELECT
      c.*,
      COALESCE(rs.wrong_count,0) AS wrong_count,
      COALESCE(rs.hard_count,0) AS hard_count,
      rs.last_rating,
      rs.last_verdict,
      rs.last_reviewed_at,
      (
        CASE WHEN c.due<=NOW() THEN 90 ELSE 0 END
        + CASE WHEN rs.last_rating='Again' OR rs.last_verdict='wrong' THEN 100 ELSE 0 END
        + CASE WHEN rs.last_rating='Hard' OR rs.last_verdict='partial' THEN 55 ELSE 0 END
        + LEAST(30,COALESCE(rs.wrong_count,0)*8)
        + LEAST(20,COALESCE(rs.hard_count,0)*4)
        + LEAST(40,COALESCE((c.fsrs->>'difficulty')::float,0)*4)
        + CASE WHEN rs.last_reviewed_at IS NULL THEN 10 ELSE LEAST(25,EXTRACT(EPOCH FROM (NOW()-rs.last_reviewed_at))/86400) END
      )::float AS weakness_score
    FROM cards c
    LEFT JOIN review_stats rs ON rs.card_id=c.id
    WHERE c.user_id=$1
      AND (c.hidden_until IS NULL OR c.hidden_until<=NOW())
      AND (c.source_note_id IS NULL OR EXISTS (
        SELECT 1 FROM notes n WHERE n.id=c.source_note_id AND n.user_id=c.user_id AND n.study_enabled=TRUE
      ))
      AND ($2::text[]='{}'::text[] OR c.id::text=ANY($2::text[]))
      AND ($3<>'due' OR c.due<=NOW())
    ORDER BY
      CASE WHEN $3='weak' THEN (
        CASE WHEN c.due<=NOW() THEN 90 ELSE 0 END
        + CASE WHEN rs.last_rating='Again' OR rs.last_verdict='wrong' THEN 100 ELSE 0 END
        + CASE WHEN rs.last_rating='Hard' OR rs.last_verdict='partial' THEN 55 ELSE 0 END
        + LEAST(30,COALESCE(rs.wrong_count,0)*8)
        + LEAST(20,COALESCE(rs.hard_count,0)*4)
        + LEAST(40,COALESCE((c.fsrs->>'difficulty')::float,0)*4)
      ) ELSE 0 END DESC,
      CASE WHEN $3<>'weak' THEN c.due END ASC,
      RANDOM()
    LIMIT 30
  `,[uid,requestedIds,mode]);

  if(!rows.length) return res.status(400).json({error:"没有可用于出题的知识卡片。"});

  // For weak mode, randomly sample from the strongest weak candidates rather
  // than deterministically asking the exact same cards every time.
  let selectedRows=rows;
  if(mode==="weak" && rows.length>Math.max(count*2,10)){
    const pool=rows.slice(0,Math.min(rows.length,Math.max(count*3,15)));
    selectedRows=[];
    const remaining=[...pool];
    while(remaining.length && selectedRows.length<Math.min(30,pool.length)){
      const total=remaining.reduce((sum,r)=>sum+Math.max(1,Number(r.weakness_score||0)+20),0);
      let pick=Math.random()*total,idx=0;
      for(;idx<remaining.length;idx++){
        pick-=Math.max(1,Number(remaining[idx].weakness_score||0)+20);
        if(pick<=0)break;
      }
      selectedRows.push(remaining.splice(Math.min(idx,remaining.length-1),1)[0]);
    }
  }

  // Keep a small candidate pool: enough variety for the requested quiz while
  // avoiding huge prompts on free/slow providers.
  const sourceRows=selectedRows.slice(0,Math.min(
    selectedRows.length,
    Math.max(count+2,8)
  ));

  // Fetch text attachment context for all candidate notes in ONE query instead
  // of doing one database round-trip per card.
  const noteIds=[...new Set(sourceRows.map(r=>r.source_note_id).filter(Boolean))];
  const attachmentsByNote=new Map();

  if(noteIds.length){
    const ar=await query(`
      SELECT note_id,id,original_name,mime_type,extracted_text,sort_order,created_at
      FROM note_attachments
      WHERE user_id=$1 AND note_id::text=ANY($2::text[])
      ORDER BY note_id,sort_order ASC,created_at ASC
    `,[uid,noteIds.map(String)]);

    for(const a of ar.rows){
      const key=String(a.note_id);
      const list=attachmentsByNote.get(key)||[];
      if(list.length<2){
        list.push({
          id:a.id,
          name:a.original_name,
          mimeType:a.mime_type,
          // Keep only concise attachment context for quiz generation.
          extractedText:String(a.extracted_text||"").slice(0,1000)
        });
        attachmentsByNote.set(key,list);
      }
    }
  }

  const source=sourceRows.map(r=>({
    id:r.id,
    front:r.front,
    back:r.back,
    example:r.example,
    category:r.category,
    tags:r.tags||[],
    difficulty:Number(r.fsrs?.difficulty||0),
    due:r.due,
    weaknessScore:Number(r.weakness_score||0),
    lastRating:r.last_rating||null,
    lastVerdict:r.last_verdict||null,
    wrongCount:Number(r.wrong_count||0),
    hardCount:Number(r.hard_count||0),
    attachments:r.source_note_id
      ? (attachmentsByNote.get(String(r.source_note_id))||[])
      : []
  }));

  const quizProvider=await featureProvider(uid,"ai_quiz_provider","gemini");

  // Fetch visual candidates in one query as well.
  const visualCandidates=[];
  if(noteIds.length){
    const vr=await query(`
      SELECT id,note_id,original_name,mime_type,data,extracted_text,page_number,is_generated,source_attachment_id
      FROM note_attachments
      WHERE user_id=$1
        AND note_id::text=ANY($2::text[])
        AND mime_type LIKE 'image/%'
      ORDER BY
        CASE WHEN is_generated=TRUE AND page_number IS NOT NULL THEN 0 ELSE 1 END,
        RANDOM()
      LIMIT 4
    `,[uid,noteIds.map(String)]);

    const cardByNote=new Map();
    for(const r of sourceRows){
      if(r.source_note_id&&!cardByNote.has(String(r.source_note_id))){
        cardByNote.set(String(r.source_note_id),r);
      }
    }

    for(const a of vr.rows){
      const card=cardByNote.get(String(a.note_id));
      if(!card)continue;
      visualCandidates.push({card,attachment:a});
      if(visualCandidates.length>=3)break;
    }
  }

  // At most one image question per generated quiz. Visual calls are the
  // slowest path, so keep them optional and never let them dominate latency.
  const visualTarget=Math.min(1,Math.max(0,Math.floor(count/3)),visualCandidates.length);
  const regularRequestTarget=count;

  const makeVisualQuestion=async item=>{
    const v=await generateVisualStructured({
      provider:quizProvider,
      base64:item.attachment.data.toString("base64"),
      mimeType:item.attachment.mime_type,
      schema:watchMode?watchAdaptiveQuestionSchema:visualQuizQuestionSchema,
      system:`Create ONE study question that genuinely requires looking at the supplied image.
${watchMode?"Apple Watch mode: the question MUST be MCQ with exactly 4 choices. Do not generate fill-in or short-answer questions.":""}
Use only facts visible in the image and the supplied card context. Do not invent labels, arrows, values, colors, anatomy, relationships, or other visual details.
The visible prompt must be Simplified Chinese by default, while English target terms can stay in English.
Good visual questions may ask about a labeled structure, arrow, sequence, table cell, chart trend, diagram relation, or visible annotation.
Do NOT ask a question that could be answered from the text context alone.
For MCQ, provide exactly 4 plausible choices. Otherwise choices=[].
Return schema-valid JSON only.`,
      user:JSON.stringify({
        card:{
          id:item.card.id,
          front:item.card.front,
          back:item.card.back,
          example:item.card.example,
          tags:item.card.tags||[]
        },
        attachment:{
          name:item.attachment.original_name,
          pageNumber:item.attachment.page_number||null,
          generatedFromPdf:item.attachment.is_generated===true,
          extractedText:String(item.attachment.extracted_text||"").slice(0,1000)
        }
      })
    });

    return {
      ...v,
      id:crypto.randomUUID(),
      cardId:item.card.id,
      audioText:"",
      visualAttachmentId:item.attachment.id,
      adaptive:false
    };
  };

  const regularPromise=regularRequestTarget>0
    ? generateStructured({
        provider:quizProvider,
        name:"memorycast_quiz",
        schema:watchMode?watchQuizSchema:quizSchema,
        maxTokens:Math.min(7000,1200+regularRequestTarget*450),
        system:`Generate a rigorous but fair adaptive study quiz only from the supplied cards.
${watchMode
  ?"Apple Watch mode: generate ONLY MCQ questions. Every question must have exactly 4 plausible choices. Do not generate fill, short-answer, or listening questions."
  :"Mix MCQ, fill, short-answer and listening items when appropriate."}
For MCQ provide exactly 4 plausible choices; otherwise choices must be [].
For listening, audioText is what TTS reads and the prompt must not reveal it.
Always set visualAttachmentId to an empty string for these normal text/listening questions.
Use Simplified Chinese for the quiz prompt and all learner-facing instructions by default.
Keep English words, phrases, sentences, answer choices, and examples in English when they are the learning target.
If the learner must answer in English, explicitly say "请用英文回答".
For listening questions, keep the visible prompt in Chinese while audioText may be English.
Do not turn the whole question into English merely because the source card contains English.
For English, test recognition and production. For technical material, test understanding.
Assign difficultyLevel:
- foundation = recognition/basic recall
- standard = normal retrieval/application
- challenge = transfer, contrast, explanation, or production
In weak mode, prioritize cards with high weaknessScore, recent wrong/Hard outcomes, and overdue cards.
A single card may contain a whole note: generate distinct questions from different facts or concepts.
If a card includes attachments, their extractedText is part of the allowed source context. Use it when relevant, especially for image/PDF-derived notes.
Do not invent visual facts that are not present in the extracted attachment text.
Do not simply copy the card front as the answer cue.
Keep explanations concise: normally one short sentence per question.
Return only schema-valid JSON.`,
        user:JSON.stringify({count:regularRequestTarget,mode,cards:source})
      })
    : Promise.resolve({questions:[]});

  // Start visual work in parallel, but do not let slow image generation hold
  // the normal quiz hostage. Once the regular quiz is ready, visual work gets
  // only a short grace period.
  const visualPromises=visualCandidates
    .slice(0,visualTarget)
    .map(item=>makeVisualQuestion(item));
  const visualBatch=Promise.allSettled(visualPromises);

  const regularResult=await regularPromise;
  const visualResults=visualPromises.length
    ? await Promise.race([
        visualBatch,
        new Promise(resolve=>setTimeout(()=>resolve([]),5000))
      ])
    : [];

  const visualQuestions=visualResults
    .filter(x=>x.status==="fulfilled")
    .map(x=>x.value);

  for(const result of visualResults){
    if(result.status==="rejected"){
      console.warn("Visual quiz generation skipped:",result.reason?.message||result.reason);
    }
  }

  const allowed=new Set(source.map(x=>x.id));
  const regularLimit=Math.max(0,count-visualQuestions.length);
  const regularQuestions=(regularResult.questions||[])
    .filter(q=>allowed.has(q.cardId))
    .slice(0,regularLimit)
    .map(q=>({...q,id:crypto.randomUUID(),adaptive:false,visualAttachmentId:q.visualAttachmentId||""}));

  const questions=[...visualQuestions,...regularQuestions]
    .sort(()=>Math.random()-.5)
    .slice(0,count);

  const quizTitle=visualQuestions.length
    ? "今日多模态测试"
    : "今日测试";
  if(!questions.length) return res.status(502).json({error:"AI 未生成有效题目。"});

  const {rows:created}=await query(`
    INSERT INTO quiz_sessions(user_id,title,questions)
    VALUES($1,$2,$3) RETURNING id
  `,[uid,quizTitle,JSON.stringify(questions)]);

  res.json({
    sessionId:created[0].id,
    title:quizTitle,
    questions:questions.map(({answer,acceptableAnswers,explanation,...safe})=>safe)
  });
}));
function norm(s=""){return String(s).toLowerCase().trim().replace(/[.,!?;:'"()[\]{}，。！？；：“”‘’、\s]+/g," ");}
async function judgeAnswer(q,userAnswer,providerChoice="gemini"){
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
    provider:providerChoice,
    name:"grade",
    schema,
    system:`Grade the learner's answer semantically.
Accept equivalent wording, bilingual equivalents, and minor spelling or grammar errors.
correct = substantively correct; partial = core idea present but important detail missing; wrong = incorrect or absent.
Return schema-valid JSON.`,
    user:JSON.stringify({type:q.type,prompt:q.prompt,expected:q.answer,acceptable:q.acceptableAnswers,userAnswer})
  });
}
async function makeAdaptiveQuizQuestion({uid,card,q,verdict,confidence,mcqOnly=false}){
  const quizProvider=await featureProvider(uid,"ai_quiz_provider","gemini");
  const strongCorrect=verdict==="correct" && confidence==="sure";
  const target=strongCorrect?"challenge":(verdict==="wrong"?"foundation":"standard");

  const data=await generateStructured({
    provider:quizProvider,
    name:"adaptive_quiz_question",
    schema:mcqOnly?watchAdaptiveQuestionSchema:adaptiveQuestionSchema,
    system:`Generate exactly ONE adaptive follow-up quiz question from the supplied card.
${mcqOnly?"Apple Watch mode: this follow-up MUST be MCQ with exactly 4 plausible choices. Do not generate fill, short-answer, or listening questions.":""}
It must test the SAME underlying concept as the previous question but in a DIFFERENT form or wording.
Do not reveal or paraphrase the previous answer in the prompt.
Target difficulty is ${target}.
If the learner was wrong/partial, prefer a clearer foundation/standard retrieval cue, not a duplicate.
If the learner was correct and confident, make a genuine challenge/transfer question.
Use Simplified Chinese for the follow-up prompt and learner-facing instructions by default.
Keep English target words, phrases, example sentences, and answer choices in English where appropriate.
If the learner must answer in English, explicitly say "请用英文回答".
For MCQ give exactly 4 plausible choices; otherwise choices=[].
For listening, keep the visible prompt in Chinese; audioText is what TTS reads and the prompt must not reveal it.
Do not make the whole follow-up question English just because the source material is English.
Always set visualAttachmentId to an empty string for adaptive follow-up questions.
Return schema-valid JSON only.`,
    user:JSON.stringify({
      card:{id:card.id,front:card.front,back:card.back,example:card.example,tags:card.tags||[]},
      previous:{type:q.type,prompt:q.prompt,verdict,confidence},
      targetDifficulty:target
    })
  });

  if(String(data.cardId)!==String(card.id))data.cardId=String(card.id);
  return {...data,id:crypto.randomUUID(),adaptive:true,retestOf:q.id};
}

app.post("/quiz/grade", requireAuth, asyncRoute(async(req,res)=>{
  const {sessionId,questionId,answer=""}=req.body||{};
  const watchMode=req.body?.watchMode===true;
  const confidence=["sure","unsure","guess"].includes(req.body?.confidence)
    ? req.body.confidence
    : "unsure";

  const uid=userId(req);
  const {rows}=await query(`
    SELECT * FROM quiz_sessions
    WHERE id=$2 AND user_id=$1 AND expires_at>NOW()
  `,[uid,sessionId]);
  const sessionRow=rows[0];
  if(!sessionRow) return res.status(404).json({error:"测试已过期或不存在。"});

  const q=sessionRow.questions.find(x=>x.id===questionId);
  if(!q) return res.status(404).json({error:"题目不存在。"});

  const gradeProvider=await featureProvider(uid,"ai_grade_provider","gemini");
  const grade=await judgeAnswer(q,String(answer),gradeProvider);

  let rating;
  if(grade.verdict==="wrong")rating="Again";
  else if(grade.verdict==="partial")rating="Hard";
  else if(confidence==="sure")rating="Good";
  else rating="Hard";

  const updatedCard=await applyReview(uid,q.cardId,rating,"quiz",grade.verdict);
  const metacognitiveTrap=grade.verdict==="wrong" && confidence==="sure";

  const answerRecord={
    questionId:q.id,
    cardId:q.cardId,
    userAnswer:String(answer),
    verdict:grade.verdict,
    score:grade.score,
    rating,
    confidence,
    difficultyLevel:q.difficultyLevel||"standard",
    adaptive:q.adaptive===true,
    metacognitiveTrap,
    answeredAt:new Date().toISOString()
  };
  const answers=[...(sessionRow.answers||[]),answerRecord];

  let adaptiveQuestion=null;
  const existingAdaptive=(sessionRow.questions||[]).filter(x=>x.adaptive===true).length;
  const shouldAdapt=existingAdaptive<3 && (
    grade.verdict!=="correct" ||
    (grade.verdict==="correct" && confidence==="sure" && q.difficultyLevel!=="challenge")
  );

  if(shouldAdapt){
    try{
      const cardResult=await query(`SELECT * FROM cards WHERE id=$2 AND user_id=$1`,[uid,q.cardId]);
      const card=cardResult.rows[0];
      if(card){
        adaptiveQuestion=await makeAdaptiveQuizQuestion({
          uid,card,q,verdict:grade.verdict,confidence,mcqOnly:watchMode
        });
        const allQuestions=[...(sessionRow.questions||[]),adaptiveQuestion];
        await query(`
          UPDATE quiz_sessions SET answers=$3::jsonb,questions=$4::jsonb
          WHERE id=$2 AND user_id=$1
        `,[uid,sessionId,JSON.stringify(answers),JSON.stringify(allQuestions)]);
      }
    }catch(err){
      console.warn("Adaptive quiz follow-up generation failed:",err?.message||err);
      adaptiveQuestion=null;
    }
  }

  if(!adaptiveQuestion){
    await query(`
      UPDATE quiz_sessions SET answers=$3::jsonb
      WHERE id=$2 AND user_id=$1
    `,[uid,sessionId,JSON.stringify(answers)]);
  }

  res.json({
    verdict:grade.verdict,
    score:grade.score,
    feedback:grade.feedback,
    correctAnswer:q.answer,
    explanation:q.explanation,
    fsrsRating:rating,
    confidence,
    metacognitiveTrap,
    adaptiveQuestion:adaptiveQuestion
      ? (({answer,acceptableAnswers,explanation,...safe})=>safe)(adaptiveQuestion)
      : null,
    updatedCard
  });
}));


app.get("/stats", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const requestedDays=Number(req.query.days);
  const days=[7,30,90].includes(requestedDays)?requestedDays:7;
  const requestedTz=typeof req.query.tz==="string"?req.query.tz:"UTC";
  let timeZone="UTC";
  try{
    if(requestedTz.length<=64){
      new Intl.DateTimeFormat("en-US",{timeZone:requestedTz});
      timeZone=requestedTz;
    }
  }catch{
    // If an invalid timezone is supplied, use UTC instead.
  }
  const historyDays=Math.max(84,days*2);
  const studyFilter=`
    c.user_id=$1
    AND (
      c.source_note_id IS NULL
      OR EXISTS (
        SELECT 1 FROM notes n
        WHERE n.id=c.source_note_id
          AND n.user_id=c.user_id
          AND n.study_enabled=TRUE
      )
    )
  `;

  const [cards,reviews,quiz,categories,history,settingsResult]=await Promise.all([
    query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE c.review_count>0)::int AS studied,
             COUNT(*) FILTER (WHERE c.due<=NOW() AND (c.hidden_until IS NULL OR c.hidden_until<=NOW()))::int AS due
      FROM cards c
      WHERE `+studyFilter,[uid]),
    query("SELECT COUNT(*)::int AS total FROM reviews WHERE user_id=$1",[uid]),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE source='quiz' AND verdict IN ('correct','partial','wrong'))::int AS total,
        COUNT(*) FILTER (WHERE source='quiz' AND verdict='correct')::int AS correct
      FROM reviews WHERE user_id=$1
    `,[uid]),
    query(`
      SELECT tag AS category,
             COUNT(*)::int AS count,
             AVG(COALESCE((c.fsrs->>'difficulty')::float,0)) AS avg_difficulty
      FROM cards c, LATERAL unnest(c.tags) AS tag
      WHERE `+studyFilter+`
        AND tag !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `,[uid]),
    query(`
      WITH days AS (
        SELECT ((NOW() AT TIME ZONE $2)::date - ($3::int - 1) + n)::date AS day
        FROM generate_series(0,$3::int - 1) AS n
      )
      SELECT d.day, COUNT(r.id)::int AS count
      FROM days d
      LEFT JOIN reviews r
        ON r.user_id=$1
       AND r.reviewed_at >= (d.day::timestamp AT TIME ZONE $2)
       AND r.reviewed_at < ((d.day + 1)::timestamp AT TIME ZONE $2)
      GROUP BY d.day
      ORDER BY d.day ASC
    `,[uid,timeZone,historyDays]),
    query("SELECT daily_goal FROM user_settings WHERE user_id=$1",[uid])
  ]);

  const allDays=history.rows.map(row=>({
    date:row.day instanceof Date?row.day.toISOString().slice(0,10):String(row.day).slice(0,10),
    count:Number(row.count||0)
  }));
  const dailyReviews=allDays.slice(-days);
  const previousDays=allDays.slice(-days*2,-days);
  const periodReviews=dailyReviews.reduce((sum,row)=>sum+row.count,0);
  const previousPeriodReviews=previousDays.reduce((sum,row)=>sum+row.count,0);
  const quizTotal=Number(quiz.rows[0]?.total||0);
  const quizCorrect=Number(quiz.rows[0]?.correct||0);
  let streakIndex=allDays.length-1;
  if(streakIndex>=0&&allDays[streakIndex].count===0)streakIndex--;
  let streak=0;
  while(streakIndex>=0&&allDays[streakIndex].count>0){streak++;streakIndex--;}

  res.json({
    cards:Number(cards.rows[0]?.total||0),
    studiedCards:Number(cards.rows[0]?.studied||0),
    dueCards:Number(cards.rows[0]?.due||0),
    reviews:Number(reviews.rows[0]?.total||0),
    last7:allDays.slice(-7).reduce((sum,row)=>sum+row.count,0),
    quizAccuracy:quizTotal?Math.round(quizCorrect/quizTotal*100):null,
    quizTotal,
    dailyGoal:Number(settingsResult.rows[0]?.daily_goal||20),
    todayReviews:allDays[allDays.length-1]?.count||0,
    periodDays:days,
    periodReviews,
    previousPeriodReviews,
    activeDays:dailyReviews.filter(row=>row.count>0).length,
    streak,
    streakCapped:streak===allDays.length,
    timeZone,
    categories:categories.rows,
    dailyReviews,
    heatmap:allDays.slice(-84)
  });
}));

app.use((err,req,res,next)=>{
  console.error(err);
  const status=err.statusCode||500;
  const safeMessage=status===500
    ? "服务器处理失败，请稍后重试。若持续出现，请查看 API 日志。"
    : (err.message||("HTTP "+status));
  res.status(status).json({error:safeMessage});
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`MemoryCast API listening on ${PORT}`);
});

setTimeout(()=>runDailyReminders().catch(console.error),5000);
setInterval(()=>runDailyReminders().catch(console.error),60*1000);
