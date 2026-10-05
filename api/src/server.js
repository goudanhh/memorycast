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
await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_feynman_provider TEXT NOT NULL DEFAULT 'gemini'`);
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
    "ai_feynman_provider","stt_provider","ocr_provider"
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
  const feynmanProvider=b.ai_feynman_provider==null?null:cleanAiProviderChoice(b.ai_feynman_provider);
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
      ai_feynman_provider=COALESCE($13,ai_feynman_provider),
      stt_provider=COALESCE($14,stt_provider),
      ocr_provider=COALESCE($15,ocr_provider),
      updated_at=NOW()
    WHERE user_id=$1 RETURNING *
  `,[
    userId(req),en,zh,goal,retention,wrong,reminderEnabled,reminderTime,reminderTimezone,
    organizeProvider,quizProvider,gradeProvider,feynmanProvider,sttProvider,ocrProvider
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

  const source=[];
  for(const r of selectedRows){
    let attachmentContext=[];
    if(r.source_note_id){
      const ar=await query(`
        SELECT id,original_name,mime_type,extracted_text
        FROM note_attachments
        WHERE user_id=$1 AND note_id=$2
        ORDER BY sort_order ASC,created_at ASC
        LIMIT 12
      `,[uid,r.source_note_id]);
      attachmentContext=ar.rows.map(a=>({
        id:a.id,
        name:a.original_name,
        mimeType:a.mime_type,
        extractedText:String(a.extracted_text||"").slice(0,5000)
      }));
    }
    source.push({
      id:r.id,front:r.front,back:r.back,example:r.example,category:r.category,tags:r.tags||[],
      difficulty:Number(r.fsrs?.difficulty||0),due:r.due,
      weaknessScore:Number(r.weakness_score||0),
      lastRating:r.last_rating||null,lastVerdict:r.last_verdict||null,
      wrongCount:Number(r.wrong_count||0),hardCount:Number(r.hard_count||0),
      attachments:attachmentContext
    });
  }

  const quizProvider=await featureProvider(uid,"ai_quiz_provider","gemini");

  // Generate up to three true visual questions from original image bytes.
  const visualQuestions=[];
  const visualCandidates=[];
  for(const r of selectedRows){
    if(!r.source_note_id)continue;
    const ar=await query(`
      SELECT id,original_name,mime_type,data,extracted_text,page_number,is_generated,source_attachment_id
      FROM note_attachments
      WHERE user_id=$1 AND note_id=$2
        AND mime_type LIKE 'image/%'
      ORDER BY
        CASE WHEN is_generated=TRUE AND page_number IS NOT NULL THEN 0 ELSE 1 END,
        RANDOM()
      LIMIT 4
    `,[uid,r.source_note_id]);
    for(const a of ar.rows){
      if(visualCandidates.some(x=>String(x.attachment.id)===String(a.id)))continue;
      visualCandidates.push({card:r,attachment:a});
      if(visualCandidates.length>=6)break;
    }
    if(visualCandidates.length>=6)break;
  }

  const visualTarget=Math.min(2,Math.max(0,Math.floor(count/3)),visualCandidates.length);
  for(let i=0;i<visualTarget;i++){
    const item=visualCandidates[i];
    try{
      const v=await generateVisualStructured({
        provider:quizProvider,
        base64:item.attachment.data.toString("base64"),
        mimeType:item.attachment.mime_type,
        schema:visualQuizQuestionSchema,
        system:`Create ONE study question that genuinely requires looking at the supplied image.
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
            extractedText:String(item.attachment.extracted_text||"").slice(0,5000)
          }
        })
      });
      visualQuestions.push({
        ...v,
        id:crypto.randomUUID(),
        cardId:item.card.id,
        audioText:"",
        visualAttachmentId:item.attachment.id,
        adaptive:false
      });
    }catch(err){
      console.warn("Visual quiz generation skipped:",err?.message||err);
    }
  }

  const remaining=Math.max(0,count-visualQuestions.length);
  let regularQuestions=[];
  if(remaining>0){
    const data=await generateStructured({
      provider:quizProvider,
      name:"memorycast_quiz",
      schema:quizSchema,
      system:`Generate a rigorous but fair adaptive study quiz only from the supplied cards.
Mix MCQ, fill, short-answer and listening items when appropriate.
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
Return only schema-valid JSON.`,
      user:JSON.stringify({count:remaining,mode,cards:source})
    });

    const allowed=new Set(source.map(x=>x.id));
    regularQuestions=(data.questions||[])
      .filter(q=>allowed.has(q.cardId))
      .slice(0,remaining)
      .map(q=>({...q,id:crypto.randomUUID(),adaptive:false,visualAttachmentId:q.visualAttachmentId||""}));
  }

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
async function makeAdaptiveQuizQuestion({uid,card,q,verdict,confidence}){
  const quizProvider=await featureProvider(uid,"ai_quiz_provider","gemini");
  const strongCorrect=verdict==="correct" && confidence==="sure";
  const target=strongCorrect?"challenge":(verdict==="wrong"?"foundation":"standard");

  const data=await generateStructured({
    provider:quizProvider,
    name:"adaptive_quiz_question",
    schema:adaptiveQuestionSchema,
    system:`Generate exactly ONE adaptive follow-up quiz question from the supplied card.
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
          uid,card,q,verdict:grade.verdict,confidence
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

app.get("/feynman/topic", requireAuth, asyncRoute(async(req,res)=>{
  const uid=userId(req);
  const exclude=String(req.query?.exclude||"").trim();

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
        CASE WHEN c.due<=NOW() THEN 120 ELSE 0 END
        + CASE WHEN rs.last_rating='Again' OR rs.last_verdict='wrong' THEN 85 ELSE 0 END
        + CASE WHEN rs.last_rating='Hard' OR rs.last_verdict='partial' THEN 40 ELSE 0 END
        + LEAST(30,COALESCE(rs.wrong_count,0)*8)
        + LEAST(20,COALESCE(rs.hard_count,0)*4)
        + LEAST(40,COALESCE((c.fsrs->>'difficulty')::float,0)*4)
        + CASE WHEN c.review_count=0 THEN 12 ELSE 0 END
        + GREATEST(0,LEAST(30,EXTRACT(EPOCH FROM (NOW()-c.due))/86400))
      )::float AS weakness_score
    FROM cards c
    LEFT JOIN review_stats rs ON rs.card_id=c.id
    WHERE c.user_id=$1
      AND ($2='' OR c.id::text<>$2)
    ORDER BY weakness_score DESC, RANDOM()
    LIMIT 24
  `,[uid,exclude]);

  if(!rows.length){
    return res.status(404).json({error:"知识库里还没有可用于费曼复习的卡片。"});
  }

  // Weighted random among weak candidates: weak cards appear more often,
  // but the result still changes instead of always selecting the same card.
  const weights=rows.map(r=>Math.max(1,Number(r.weakness_score||0)+20));
  const total=weights.reduce((a,b)=>a+b,0);
  let pick=Math.random()*total;
  let chosen=rows[0];
  for(let i=0;i<rows.length;i++){
    pick-=weights[i];
    if(pick<=0){chosen=rows[i];break;}
  }

  const due=chosen.due && new Date(chosen.due)<=new Date();
  const wrong=Number(chosen.wrong_count||0);
  const hard=Number(chosen.hard_count||0);
  const lastWrong=chosen.last_rating==="Again"||chosen.last_verdict==="wrong";
  const lastHard=chosen.last_rating==="Hard"||chosen.last_verdict==="partial";
  const difficulty=Number(chosen.fsrs?.difficulty||0);
  const reason=due
    ? "FSRS 已到期，优先复习"
    : lastWrong
      ? "最近一次没掌握，优先重学"
      : lastHard
        ? "最近一次不熟，优先巩固"
        : wrong>0
          ? "有过答错记录，随机加强"
          : hard>0
            ? "有过困难记录，随机加强"
            : difficulty>=7
              ? "FSRS 难度较高"
              : Number(chosen.review_count||0)===0
                ? "尚未充分复习"
                : "从当前记忆队列随机抽取";

  res.json({
    card:{
      id:chosen.id,
      topic:chosen.front,
      tags:chosen.tags||[],
      due:chosen.due,
      stateName:getStateName(chosen.fsrs),
      difficulty,
      reviewCount:chosen.review_count,
      weaknessScore:Number(chosen.weakness_score||0),
      reason
    }
  });
}));

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
  const sourceCardId=String(req.body?.cardId||"").trim();
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

  const aiProvider=await featureProvider(uid,"ai_feynman_provider","gemini");

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

  const data=await generateStructured({...analysisRequest,provider:aiProvider});

  let feynmanFsrsRating=null;
  let updatedCard=null;
  if(sourceCardId && history.length===0){
    const score=Number(data.clarityScore||0);
    feynmanFsrsRating=data.status==="mastered" && score>=80
      ? "Good"
      : score>=50
        ? "Hard"
        : "Again";
    try{
      updatedCard=await applyReview(uid,sourceCardId,feynmanFsrsRating,"feynman",data.status);
    }catch(err){
      console.warn("Feynman FSRS writeback failed; continuing conversation:",err?.message||err);
      feynmanFsrsRating=null;
      updatedCard=null;
    }
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
      provider:aiProvider,
      mode:"turn_analysis"
    })
  ]);

  await query(`
    UPDATE feynman_sessions
    SET topic=$3,status=$4,clarity_score=$5,updated_at=NOW(),last_turn_at=NOW()
    WHERE id=$2 AND user_id=$1
  `,[uid,sessionId,topic,data.status,data.clarityScore]);

  res.json({...data,sessionId,topic,feynmanFsrsRating,updatedCard});
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
  const safeMessage=status===500
    ? "服务器处理失败，请稍后重试。若持续出现，请查看 API 日志。"
    : (err.message||("HTTP "+status));
  res.status(status).json({error:safeMessage});
});
app.listen(PORT,"0.0.0.0",()=>console.log(`MemoryCast API listening on ${PORT}`));
setTimeout(()=>runDailyReminders().catch(console.error),5000);
setInterval(()=>runDailyReminders().catch(console.error),60*1000);
