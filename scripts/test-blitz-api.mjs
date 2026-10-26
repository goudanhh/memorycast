import assert from "node:assert/strict";
import {spawn,execFileSync} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";
const root=new URL("..",import.meta.url).pathname;
const port=34561,base="http://127.0.0.1:"+port;
const db=process.env.DATABASE_URL;
if(!db)throw Error("DATABASE_URL is required for integration test");
const psql=sql=>execFileSync("psql",[db,"-t","-A","-c",sql],{encoding:"utf8"}).trim();
const app=spawn(process.execPath,["src/server.js"],{
 cwd:root+"/api",env:{...process.env,PORT:String(port),AI_PROVIDER:"none",
 TTS_PROVIDER:"browser",GEMINI_API_KEY:"",OPENAI_API_KEY:"",OPENROUTER_API_KEY:""},
 stdio:["ignore","pipe","pipe"]
});
let logs="";app.stdout.on("data",c=>logs+=c);app.stderr.on("data",c=>logs+=c);
const req=async(path,body,method=body===undefined?"GET":"POST")=>{
 const r=await fetch(base+path.replace(/^\/api(?=\/)/,""),{method,headers:{"Content-Type":"application/json"},
 ...(body!==undefined?{body:JSON.stringify(body)}:{})});
 let data={};try{data=await r.json()}catch{}
 return {status:r.status,data};
};
try{
 let ready=false;
 for(let i=0;i<55;i++){
   if(app.exitCode!==null)throw Error("Server exited: "+logs.slice(-5000));
   try{const r=await req("/api/auth/me");if(r.status===200){ready=true;break}}catch{}
   await sleep(300);
 }
 assert.ok(ready,"MemoryCast backend did not start: "+logs.slice(-4000));
 const auth=await req("/api/auth/me");
 assert.equal(auth.status,200);
 const start=await req("/api/blitz/start",{duration:45});
 assert.equal(start.status,201,"Start failed: "+JSON.stringify(start.data));
 const sessionId=start.data.sessionId;
 assert.equal(start.data.questions.length,2);
 assert.equal(start.data.transcript,undefined);
 assert.ok(start.data.questions.every(q=>!Object.hasOwn(q,"answer")));
 const early=await req("/api/blitz/submit/"+sessionId,{answers:{q1:"A",q2:"B"}});
 assert.equal(early.status,409,"Never accept answers before an audio playback");
 const schemaCount=Number(psql("SELECT COUNT(*) FROM blitz_sessions;"));
 assert.equal(schemaCount,1);
 const query="SELECT content::text FROM blitz_sessions WHERE id='"+sessionId+"'";
 const stored=JSON.parse(psql(query));
 const keyed=Object.fromEntries(stored.questions.map((q,i)=>["q"+(i+1),q.answer]));
 const played=await req("/api/blitz/play/"+sessionId,{});
 assert.equal(played.status,200);
 assert.equal(played.data.plays,1);
 const grade=await req("/api/blitz/submit/"+sessionId,{answers:keyed});
 assert.equal(grade.status,200);
 assert.equal(grade.data.score,2);
 assert.equal(grade.data.firstListen,true);
 assert.ok(grade.data.transcript.includes(stored.transcript));
 assert.equal((await req("/api/blitz/submit/"+sessionId,{answers:keyed})).status,409);
 const report=await req("/api/blitz/insights?days=7");
 assert.equal(report.status,200);
 assert.equal(report.data.sessions,1);
 assert.equal(report.data.firstAccuracy,100);
 const second=await req("/api/blitz/start",{duration:20});
 assert.equal(second.status,201);
 assert.equal(second.data.questions.length,1);
 const againId=second.data.sessionId;
 await req("/api/blitz/play/"+againId,{});
 const again=await req("/api/blitz/play/"+againId,{});
 assert.equal(again.data.plays,2);
 const missed=await req("/api/blitz/submit/"+againId,{answers:{q1:"definitely wrong"}});
 assert.equal(missed.status,200);
 assert.equal(missed.data.firstListen,false);
 assert.equal(missed.data.score,0);
 const report2=await req("/api/blitz/insights?days=30");
 assert.equal(report2.data.sessions,2);
 assert.equal(report2.data.firstAccuracy,100);
 assert.equal(report2.data.accuracy,67);
 assert.equal(report2.data.assistedQuestions,1);
 assert.equal(Number(psql("SELECT COUNT(*) FROM reviews;")),0,
   "Blitz must not touch FSRS reviews");
 assert.equal((await req("/api/blitz/prepare",{duration:45})).status,200);
 assert.equal((await req("/api/listening/history")).status,200,
   "Existing TOEFL exam API must be intact");
 console.log("Postgres integration PASS: start, key privacy, play gating, 2/2 grading, replay exclusion, history, FSRS isolation.");
}finally{
 app.kill("SIGTERM");
 await sleep(250);
}
