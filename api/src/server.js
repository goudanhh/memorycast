import express from "express";
import helmet from "helmet";
import compression from "compression";
import crypto from "node:crypto";
import { query } from "./db.js";
import { newFsrsCard, scheduleNext, getStateName } from "./fsrs.js";
import { hasAI, openai, model } from "./ai.js";

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

app.get("/health", (req,res) => res.json({ ok:true, ai:hasAI(), mode:"single-user" }));
app.get("/auth/me", asyncRoute(async (req,res) => {
  const id = await getLocalUserId();
  res.json({
    user:{ id, login:"Local User", avatarUrl:null },
    aiEnabled:hasAI(),
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
  const en=Math.min(2,Math.max(.5,Number(b.english_rate ?? 1.2)));
  const zh=Math.min(2,Math.max(.5,Number(b.chinese_rate ?? 1.3)));
  const goal=Math.min(500,Math.max(1,Number(b.daily_goal ?? 20)));
  const wrong=b.wrong_requeue !== false;
  const {rows}=await query(`
    UPDATE user_settings SET
      english_rate=$2,chinese_rate=$3,daily_goal=$4,
      fsrs_retention=$5,wrong_requeue=$6,updated_at=NOW()
    WHERE user_id=$1 RETURNING *
  `,[userId(req),en,zh,goal,retention,wrong]);
  res.json(rows[0]);
}));
async function getRetention(uid){
  const {rows}=await query(`SELECT fsrs_retention FROM user_settings WHERE user_id=$1`,[uid]);
  return rows[0]?.fsrs_retention || Number(process.env.FSRS_RETENTION||.90);
}

function normalizeCardRow(r){
  return {
    id:r.id,front:r.front,back:r.back,example:r.example,category:r.category,
    speakOrder:r.speak_order,fsrs:r.fsrs,due:r.due,reviewCount:r.review_count,
    createdAt:r.created_at,updatedAt:r.updated_at,stateName:getStateName(r.fsrs)
  };
}
app.get("/cards", requireAuth, asyncRoute(async(req,res)=>{
  const {rows}=await query(`SELECT * FROM cards WHERE user_id=$1 ORDER BY created_at DESC`,[userId(req)]);
  res.json({cards:rows.map(normalizeCardRow)});
}));
app.post("/cards", requireAuth, asyncRoute(async(req,res)=>{
  const {front,back,example="",category="Other",speakOrder="front-back-example"}=req.body||{};
  if(!String(front||"").trim() || !String(back||"").trim())
    return res.status(400).json({error:"front and back are required"});
  const fsrs=newFsrsCard();
  const {rows}=await query(`
    INSERT INTO cards(user_id,front,back,example,category,speak_order,fsrs,due)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `,[userId(req),String(front).trim(),String(back).trim(),String(example).trim(),
     String(category).trim(),String(speakOrder),fsrs,fsrs.due]);
  res.status(201).json({card:normalizeCardRow(rows[0])});
}));
app.put("/cards/:id", requireAuth, asyncRoute(async(req,res)=>{
  const {front,back,example,category,speakOrder}=req.body||{};
  const {rows}=await query(`
    UPDATE cards SET front=COALESCE($3,front),back=COALESCE($4,back),
      example=COALESCE($5,example),category=COALESCE($6,category),
      speak_order=COALESCE($7,speak_order),updated_at=NOW()
    WHERE id=$2 AND user_id=$1 RETURNING *
  `,[userId(req),req.params.id,front,back,example,category,speakOrder]);
  if(!rows[0]) return res.status(404).json({error:"Card not found"});
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
    properties:{front:{type:"string"},back:{type:"string"},example:{type:"string"},category:{type:"string"}},
    required:["front","back","example","category"],additionalProperties:false
  }}},
  required:["cards"],additionalProperties:false
};
app.post("/ai/organize", requireAuth, asyncRoute(async(req,res)=>{
  const text=String(req.body?.text||"").trim();
  if(!text) return res.status(400).json({error:"Text is required"});
  const response=await openai().responses.create({
    model:model(),
    input:[
      {role:"system",content:`Turn the user's study notes into concise spaced-repetition cards.
Use only information supplied by the user. Do not add unsupported factual claims.
Cards may be Chinese, English, or bilingual.
Front should be a recall prompt or term; back should contain the essential answer.
For English vocabulary, include a short natural example when useful.
For technical notes, prefer concept questions over trivial sentence copying.
Return JSON matching the schema.`},
      {role:"user",content:text}
    ],
    text:{format:{type:"json_schema",name:"study_cards",strict:true,schema:organizeSchema}}
  });
  res.json(JSON.parse(response.output_text));
}));
app.post("/ai/organize/save", requireAuth, asyncRoute(async(req,res)=>{
  const input=Array.isArray(req.body?.cards)?req.body.cards.slice(0,30):[];
  if(!input.length) return res.status(400).json({error:"No cards"});
  const saved=[];
  for(const c of input){
    if(!String(c.front||"").trim()||!String(c.back||"").trim()) continue;
    const fsrs=newFsrsCard();
    const {rows}=await query(`
      INSERT INTO cards(user_id,front,back,example,category,speak_order,fsrs,due)
      VALUES($1,$2,$3,$4,$5,'front-back-example',$6,$7) RETURNING *
    `,[userId(req),String(c.front).trim(),String(c.back).trim(),String(c.example||"").trim(),
       String(c.category||"Other").trim(),fsrs,fsrs.due]);
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
    id:r.id,front:r.front,back:r.back,example:r.example,category:r.category,
    difficulty:Number(r.fsrs?.difficulty||0),due:r.due
  }));
  const response=await openai().responses.create({
    model:model(),
    input:[
      {role:"system",content:`Generate a rigorous but fair study quiz only from the supplied cards.
Mix MCQ, fill, short-answer and listening items when appropriate.
For MCQ provide exactly 4 plausible choices; otherwise choices must be [].
For listening, audioText is what TTS reads and the prompt must not reveal it.
For English, test recognition and production. For technical material, test understanding.
Return only schema-valid JSON.`},
      {role:"user",content:JSON.stringify({count,mode,cards:source})}
    ],
    text:{format:{type:"json_schema",name:"memorycast_quiz",strict:true,schema:quizSchema}}
  });
  const data=JSON.parse(response.output_text);
  const allowed=new Set(source.map(x=>x.id));
  const questions=data.questions.filter(q=>allowed.has(q.cardId)).slice(0,count).map(q=>({...q,id:crypto.randomUUID()}));
  if(!questions.length) return res.status(502).json({error:"AI 未生成有效题目。"});
  const {rows:created}=await query(`
    INSERT INTO quiz_sessions(user_id,title,questions)
    VALUES($1,$2,$3) RETURNING id
  `,[userId(req),data.title||"今日测试",questions]);
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
  const response=await openai().responses.create({
    model:model(),
    input:[
      {role:"system",content:`Grade the learner's answer semantically.
Accept equivalent wording, bilingual equivalents, and minor spelling or grammar errors.
correct = substantively correct; partial = core idea present but important detail missing; wrong = incorrect or absent.
Return schema-valid JSON.`},
      {role:"user",content:JSON.stringify({type:q.type,prompt:q.prompt,expected:q.answer,acceptable:q.acceptableAnswers,userAnswer})}
    ],
    text:{format:{type:"json_schema",name:"grade",strict:true,schema}}
  });
  return JSON.parse(response.output_text);
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
  await query(`UPDATE quiz_sessions SET answers=$3 WHERE id=$2 AND user_id=$1`,[userId(req),sessionId,answers]);
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
      SELECT category,COUNT(*)::int AS count,
        AVG(COALESCE((fsrs->>'difficulty')::float,0)) AS avg_difficulty
      FROM cards WHERE user_id=$1 GROUP BY category ORDER BY count DESC
    `,[uid])
  ]);
  const quizTotal=recent.rows[0].quiz_total||0, correct=recent.rows[0].correct||0;
  res.json({
    cards:cards.rows[0].n,reviews:reviews.rows[0].n,last7:recent.rows[0].last7||0,
    quizAccuracy:quizTotal?Math.round(correct/quizTotal*100):null,categories:categories.rows
  });
}));

app.use((err,req,res,next)=>{
  console.error(err);
  const status=err.statusCode||500;
  res.status(status).json({error: status===500 ? "Server error" : err.message});
});
app.listen(PORT,"0.0.0.0",()=>console.log(`MemoryCast API listening on ${PORT}`));
