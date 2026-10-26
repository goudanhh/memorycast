import crypto from "node:crypto";
import {DURATIONS,SKILLS,SKILL_NAMES,questionCount,validateLesson,
  publicQuestions,pickDifficulty,weakestSkill,evaluate,aggregate} from "./blitz-engine.js";
import {BLITZ_LIBRARY} from "./blitz-content.js";

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const AI_SCHEMA={type:"object",properties:{
  title:{type:"string"},topic:{type:"string"},transcript:{type:"string"},
  questions:{type:"array",minItems:3,maxItems:3,items:{type:"object",properties:{
    type:{type:"string",enum:["mcq","fill"]},skill:{type:"string",enum:SKILLS},
    prompt:{type:"string"},choices:{type:"array",items:{type:"string"}},
    answer:{type:"string"},accepted:{type:"array",items:{type:"string"}},
    explanation:{type:"string"},evidence:{type:"string"}
  },required:["type","skill","prompt","choices","answer","accepted","explanation","evidence"],
  additionalProperties:false}}
},required:["title","topic","transcript","questions"],additionalProperties:false};

export function installBlitz({app,query,requireAuth,asyncRoute,userId,
  featureProvider,generateStructured,hasAI,ttsInfo,synthesizeTts}){
  const warm=new Map(),pending=new Set(),startedAt=new Map();
  async function ensureSchema(){
    await query(`CREATE TABLE IF NOT EXISTS blitz_sessions(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content JSONB NOT NULL,
      topic TEXT NOT NULL,
      level TEXT NOT NULL,
      duration_seconds SMALLINT NOT NULL CHECK(duration_seconds IN (20,45,90)),
      origin TEXT NOT NULL,
      plays INTEGER NOT NULL DEFAULT 0,
      audio_data BYTEA,
      result JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_blitz_sessions_user_time
      ON blitz_sessions(user_id,started_at DESC)`);
  }
  const fetchHistory=async(uid,max=100)=>{
    const {rows}=await query(`
      SELECT id,topic,level,origin,duration_seconds,plays,result,
        started_at,completed_at
      FROM blitz_sessions WHERE user_id=$1 ORDER BY started_at DESC LIMIT $2
    `,[uid,max]);
    return rows;
  };
  const sanitized=q=>q.type==="fill"
    ?{...q,accepted:Array.isArray(q.accepted)?q.accepted:[q.answer],choices:[]}
    :{...q,accepted:[],choices:q.choices};
  const choose=({focus,recent,duration})=>{
    const previous=new Set(recent.slice(0,7).map(x=>x.topic));
    let candidates=BLITZ_LIBRARY.filter(x=>!previous.has(x.topic)&&validateLesson(x,duration));
    if(!candidates.length)candidates=BLITZ_LIBRARY.filter(x=>validateLesson(x,duration));
    if(!candidates.length)throw new Error("No validated listening materials");
    const suitable=candidates.filter(x=>x.questions.some(q=>q.skill===focus));
    const pool=suitable.length?suitable:candidates;
    const choice=pool[Math.floor(Math.random()*pool.length)];
    return {...choice,questions:choice.questions.map(sanitized),source:"curated"};
  };
  const plan=(lesson,focus,n)=>{
    const questions=lesson.questions.map(sanitized);
    const preferred=questions.findIndex(x=>x.skill===focus);
    if(preferred>0){const [q]=questions.splice(preferred,1);questions.unshift(q);}
    return {...lesson,questions:questions.slice(0,n)};
  };
  function warmKey(uid,duration){return uid+":"+duration}
  app.post("/blitz/prepare",requireAuth,asyncRoute(async(req,res)=>{
    const uid=userId(req),duration=Number(req.body?.duration??45);
    if(!DURATIONS.includes(duration))return res.status(400).json({error:"时长无效"});
    if(!hasAI())return res.json({ok:false,reason:"using-curated-scenarios"});
    const key=warmKey(uid,duration);
    if(pending.has(key)||warm.has(key))return res.json({ok:true,ready:warm.has(key)});
    if(Date.now()-(startedAt.get(key)||0)<30000)return res.json({ok:true,ready:false});
    pending.add(key);startedAt.set(key,Date.now());
    // Request is deliberately noncritical: the current burst always runs
    // without waiting for third-party generation.
    try{
      await ensureSchema();
      const recent=(await fetchHistory(uid,25)).filter(x=>x.completed_at);
      const focus=weakestSkill(recent.map(r=>r.result||{}));
      const level=pickDifficulty(recent.map(r=>({total:r.result?.total,score:r.result?.score})));
      const provider=await featureProvider(uid,"ai_quiz_provider","gemini");
      const data=await generateStructured({
        provider,name:"blitz_micro_listening",schema:AI_SCHEMA,
        maxTokens:1450,timeoutMs:17000,raceProviders:true,
        system:"Create ORIGINAL short spoken English for high-frequency micro-listening drills. CEFR "+level+
          ". Write one natural real-life conversation or mini academic announcement, 32–58 English words, "+
          "with no stage directions, phonetics, labels or markdown. Exactly three questions in ENGLISH "+
          "(at least two mcq with four unique plausible answer choices). Prefer skill "+focus+
          " for one question. Include a mix of detail, gist, speaker intent, inference or sound recognition. "+
          "Every answer must be unambiguously supported by the passage, and evidence MUST be an exact contiguous substring "+
          "from the transcript. Explain answers in concise Chinese. For fill questions the answer must be a short "+
          "one-word or number response with all accepted variants; mcq requires choices and empty accepted. "+
          "Return only JSON according to schema.",
        user:JSON.stringify({duration,focus,level,avoid:recent.slice(0,5).map(r=>r.topic)})
      });
      if(!validateLesson(data,duration))throw Error("Generated quiz failed evidence and answer checks");
      warm.set(key,{lesson:{...data,source:"ai"},created:Date.now()});
      if(warm.size>12)warm.delete(warm.keys().next().value);
      res.json({ok:true,ready:true});
    }catch(err){
      console.warn("Blitz AI preparation unavailable; instant curated fallback:",err.message);
      res.json({ok:false,reason:"using-curated-scenarios"});
    }finally{pending.delete(key)}
  }));
  app.post("/blitz/start",requireAuth,asyncRoute(async(req,res)=>{
    const uid=userId(req),duration=Number(req.body?.duration??45);
    if(!DURATIONS.includes(duration))return res.status(400).json({error:"请选择 20、45 或 90 秒"});
    await ensureSchema();
    const recent=(await fetchHistory(uid,90)).filter(x=>x.completed_at);
    const focus=weakestSkill(recent.map(r=>r.result||{}));
    const level=pickDifficulty(recent.map(r=>({total:r.result?.total,score:r.result?.score})));
    const key=warmKey(uid,duration),cache=warm.get(key);
    if(cache)warm.delete(key);
    const lesson=plan(cache&&Date.now()-cache.created<600000?cache.lesson:
      choose({focus,recent,duration}),focus,questionCount(duration));
    const {rows}=await query(`
      INSERT INTO blitz_sessions(user_id,content,topic,level,duration_seconds,origin)
      VALUES($1,$2::jsonb,$3,$4,$5,$6) RETURNING id
    `,[uid,JSON.stringify(lesson),lesson.topic,level,duration,lesson.source||"curated"]);
    res.status(201).json({sessionId:rows[0].id,title:lesson.title||"Listening Blitz",
      duration,level,focus,topic:lesson.topic,origin:lesson.source||"curated",
      questions:publicQuestions(lesson.questions,questionCount(duration)),
      audioUrl:"/api/blitz/audio/"+rows[0].id});
  }));
  async function find(uid,id){
    if(!UUID.test(String(id||"")))return null;
    await ensureSchema();
    const {rows}=await query("SELECT * FROM blitz_sessions WHERE id=$1 AND user_id=$2",[id,uid]);
    return rows[0]||null;
  }
  app.post("/blitz/play/:id",requireAuth,asyncRoute(async(req,res)=>{
    const uid=userId(req),id=req.params.id;
    if(!UUID.test(String(id)))return res.status(400).json({error:"无效训练记录"});
    await ensureSchema();
    const {rows}=await query(`
      UPDATE blitz_sessions SET plays=plays+1
      WHERE id=$1 AND user_id=$2 AND completed_at IS NULL AND plays<30 RETURNING plays
    `,[id,uid]);
    if(!rows.length)return res.status(409).json({error:"该听力训练已经提交或播放次数过多"});
    res.json({plays:rows[0].plays});
  }));
  app.get("/blitz/audio/:id",requireAuth,asyncRoute(async(req,res)=>{
    const session=await find(userId(req),req.params.id);
    if(!session)return res.status(404).json({error:"未找到听力素材"});
    if(session.audio_data){res.setHeader("Content-Type","audio/mpeg");
      res.setHeader("Cache-Control","private, no-store");return res.send(session.audio_data);}
    // Use the same configured Azure speech engine as the original exam.
    const result=await synthesizeTts({
      text:session.content.transcript,language:"en-US",style:"natural",rate:1
    });
    await query(`
      UPDATE blitz_sessions SET audio_data=$3 WHERE id=$1 AND user_id=$2 AND audio_data IS NULL
    `,[session.id,userId(req),result.audio]);
    res.setHeader("Content-Type","audio/mpeg");
    res.setHeader("Cache-Control","private, no-store");res.send(result.audio);
  }));
  app.get("/blitz/browser-speech/:id",requireAuth,asyncRoute(async(req,res)=>{
    const session=await find(userId(req),req.params.id);
    if(!session)return res.status(404).json({error:"未找到音频"});
    // HTML never renders this text before grading; the browser speech engine
    // requires plaintext when Azure is not configured/unavailable.
    res.setHeader("Cache-Control","no-store");
    res.json({speechText:session.content.transcript});
  }));
  app.post("/blitz/submit/:id",requireAuth,asyncRoute(async(req,res)=>{
    const session=await find(userId(req),req.params.id);
    if(!session)return res.status(404).json({error:"未找到训练记录"});
    if(session.completed_at)return res.status(409).json({error:"该组题已提交"});
    if(session.plays<1)return res.status(409).json({error:"请先播放音频"});
    const body=req.body?.answers;
    const questions=session.content?.questions||[];
    if(!body||typeof body!=="object"||Array.isArray(body)||
      questions.some((q,i)=>typeof body["q"+(i+1)]!=="string"||
        body["q"+(i+1)].length>180)){
      return res.status(400).json({error:"请完成全部听力题后提交"});
    }
    const report=evaluate(questions,body,session.plays);
    const {rows}=await query(`
      UPDATE blitz_sessions SET result=$3::jsonb,completed_at=NOW()
      WHERE id=$1 AND user_id=$2 AND completed_at IS NULL
      RETURNING completed_at
    `,[session.id,userId(req),JSON.stringify(report)]);
    if(!rows.length)return res.status(409).json({error:"重复提交"});
    res.json({...report,transcript:session.content.transcript,
      topic:session.topic,title:session.content.title,
      completedAt:rows[0].completed_at,source:session.origin});
  }));
  app.get("/blitz/insights",requireAuth,asyncRoute(async(req,res)=>{
    const days=Number(req.query.days||7);
    if(![7,30,90].includes(days))return res.status(400).json({error:"统计日期无效"});
    await ensureSchema();
    const {rows}=await query(`
      SELECT completed_at,result,topic,level,duration_seconds,plays
      FROM blitz_sessions WHERE user_id=$1 AND completed_at>=NOW()-INTERVAL '90 days'
        AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1200
    `,[userId(req)]);
    const stats=aggregate(rows,days);
    const recent=rows.slice(0,8).map(r=>({when:r.completed_at,topic:r.topic,level:r.level,
      total:r.result?.total||0,score:r.result?.score||0,firstListen:r.result?.firstListen||false,
      duration:r.duration_seconds}));
    res.json({...stats,recent,focus:weakestSkill(rows.map(r=>r.result||{})),skillLabels:SKILL_NAMES,
      note:"首听正确率仅统计播放一次就提交的题目；重听后正确单独计入总正确率。AI 原创短题未经过 TOEFL/IELTS 标定，不能换算正式分数。"});
  }));
}
