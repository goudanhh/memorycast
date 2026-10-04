import express from "express";
import helmet from "helmet";
import compression from "compression";
import webpush from "web-push";
import crypto from "node:crypto";
import { query } from "./db.js";
import { newFsrsCard, scheduleNext, getStateName } from "./fsrs.js";
import { hasAI, generateStructured, aiInfo } from "./ai.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "2mb" }));
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

app.get("/health", (req,res) => res.json({ ok:true, ai:aiInfo(), mode:"single-user" }));
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

  const noteTags=normalizeTags([]);
  const savedNote=await query(`
    INSERT INTO notes(user_id,title,content,tags)
    VALUES($1,$2,$3,$4) RETURNING *
  `,[userId(req),noteTitle(rawText),rawText,noteTags]);
  const note=normalizeNoteRow(savedNote.rows[0]);

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
