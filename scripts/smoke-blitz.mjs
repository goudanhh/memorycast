import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,mkdir} from "node:fs/promises";
import {resolve,join,extname} from "node:path";
import {chromium} from "playwright";
const root=resolve(import.meta.dirname,"../web");
const uid="00000000-0000-4000-8000-000000000001";
const transcript="Please bring two extra towels to room eight oh five before nine tonight. Leave the package at the front desk because the guest is asleep. Call the manager if the room is locked.";
const full=[
 {type:"mcq",skill:"detail",prompt:"Which room needs two towels?",
  choices:["805","815","850","508"],answer:"805",explanation:"The instruction names room eight oh five.",evidence:"room eight oh five"},
 {type:"mcq",skill:"intent",prompt:"Why should the package stay at the desk?",
  choices:["The guest is asleep.","The room is empty.","The hallway is closed.","The manager is away."],
  answer:"The guest is asleep.",explanation:"The guest is asleep.",evidence:"the guest is asleep"},
 {type:"fill",skill:"detail",prompt:"How many extra towels should be brought?",
  answer:"2",accepted:["2","two"],explanation:"Two extra towels are requested.",evidence:"two extra towels"}
];
let counter=0,submitted=[],plays=new Map(),lastMode=45;
const id=()=>"00000000-0000-4000-8000-"+String(++counter).padStart(12,"0");
function wav(){
 const rate=8000,num=Math.floor(rate/3),bytes=num*2,b=Buffer.alloc(44+bytes);
 b.write("RIFF",0);b.writeUInt32LE(36+bytes,4);b.write("WAVEfmt ",8);
 b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
 b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);
 b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(bytes,40);
 for(let i=0;i<num;i++)b.writeInt16LE(Math.floor(1500*Math.sin(2*Math.PI*220*i/rate)),44+i*2);
 return b;
}
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,"http://127.0.0.1").pathname;
 res.setHeader("Cache-Control","no-store");
 if(path.startsWith("/api/")){
   let raw="";for await(const chunk of req)raw+=chunk;
   let data={};try{data=JSON.parse(raw||"{}")}catch{}
   if(path==="/api/blitz/insights"){
     res.setHeader("Content-Type","application/json");
     const n=submitted.length,first=submitted.filter(x=>x.firstListen).length;
     return res.end(JSON.stringify({
       sessions:n,total:submitted.reduce((a,s)=>a+s.total,0),correct:submitted.reduce((a,s)=>a+s.score,0),
       firstTotal:first,firstCorrect:first,firstAccuracy:first?100:null,accuracy:n?100:null,
       bySkill:{detail:{correct:n,total:n},gist:{correct:0,total:0},intent:{correct:n,total:n},
         inference:{correct:0,total:0},sound:{correct:0,total:0}},
       daily:n?[{day:"2026-10-26",sessions:n,total:n*2,correct:n*2}]:[],
       recent:n?[{topic:"Hotel",score:2,total:2,firstListen:true,duration:45}]:[],focus:"detail"
     }));
   }
   if(path==="/api/blitz/start"&&req.method==="POST"){
     lastMode=data.duration;const sessionId=id();plays.set(sessionId,0);
     const questions=full.slice(0,lastMode===20?1:lastMode===90?3:2).map((q,i)=>({
       id:"q"+(i+1),type:q.type,skill:q.skill,prompt:q.prompt,...(q.type==="mcq"?{choices:q.choices}:{})
     }));
     res.statusCode=201;res.setHeader("Content-Type","application/json");
     return res.end(JSON.stringify({sessionId,questions,title:"A Guest Request",
       level:"B1",topic:"Hotel",duration:lastMode,origin:"curated",focus:"detail",
       audioUrl:"/api/blitz/audio/"+sessionId}));
   }
   if(path==="/api/blitz/prepare")return res.end(JSON.stringify({ok:false}));
   if(path.startsWith("/api/blitz/browser-speech/"))
     return res.end(JSON.stringify({speechText:transcript}));
   if(path.startsWith("/api/blitz/play/")){
     const sessionId=path.split("/").at(-1);
     const n=(plays.get(sessionId)||0)+1;plays.set(sessionId,n);
     return res.end(JSON.stringify({plays:n}));
   }
   if(path.startsWith("/api/blitz/audio/")){
     res.setHeader("Content-Type","audio/wav");return res.end(wav());
   }
   if(path.startsWith("/api/blitz/submit/")){
     const sessionId=path.split("/").at(-1),n=lastMode===20?1:lastMode===90?3:2;
     assert.ok((plays.get(sessionId)||0)>0,"Must play audio before grading");
     const answers=full.slice(0,n);
     for(let j=0;j<n;j++)assert.equal(data.answers["q"+(j+1)],answers[j].answer);
     const result={score:n,total:n,firstListen:plays.get(sessionId)===1,
       playCount:plays.get(sessionId),
       results:answers.map((q,i)=>({id:"q"+(i+1),skill:q.skill,correct:true,
         response:q.answer,answer:q.answer,explanation:q.explanation,evidence:q.evidence}))};
     submitted.push(result);return res.end(JSON.stringify({...result,transcript}));
   }
   res.statusCode=404;return res.end(JSON.stringify({error:"unsupported API"}));
 }
 if(path==="/app.js"){
   res.setHeader("Content-Type","text/javascript;charset=utf-8");
   return res.end("document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));document.getElementById(b.dataset.page)?.classList.add('active')}));");
 }
 const file=path==="/"?"/index.html":path;
 if(![".html",".js",".css",".webmanifest"].includes(extname(file))){res.statusCode=404;return res.end("Not found");}
 try{
   const buffer=await readFile(join(root,file));
   res.setHeader("Content-Type",({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)]||"application/json");
   res.end(buffer);
 }catch{res.statusCode=404;res.end("Not found")}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const base="http://127.0.0.1:"+server.address().port+"/";
let browser;
try{
 browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
 const page=await browser.newPage({viewport:{width:1360,height:880}});
 const errs=[];page.on("pageerror",e=>errs.push(e.message));
 await page.goto(base,{waitUntil:"load"});
 await page.locator('[data-page="blitzPage"]').first().click();
 await page.locator("#blitzStart").waitFor({state:"visible"});
 assert.equal(await page.locator("#blitzSessionCount").innerText(),"0");
 await page.locator("#blitzStart").click();
 await page.locator("#blitzWorkout").waitFor({state:"visible"});
 assert.equal(await page.locator(".blitz-question").count(),2);
 assert.ok(!(await page.locator("#blitzWorkout").innerText()).includes(transcript),
   "Transcript should remain hidden before grading");
 assert.ok(await page.locator("#blitzSubmit").isDisabled());
 await page.locator("#blitzPlay").click();
 await page.waitForFunction(()=>document.getElementById("blitzPlayCount")?.textContent==="1 次",
   null,{timeout:15000});
 await page.locator('#blitzAnswers input[name="blitz-q1"][value="805"]').check();
 await page.locator('#blitzAnswers input[name="blitz-q2"][value="The guest is asleep."]').check();
 await page.locator("#blitzSubmit").click();
 await page.locator("#blitzResults").waitFor({state:"visible"});
 assert.equal((await page.locator("#blitzScore").innerText()).trim(),"2 / 2");
 assert.ok((await page.locator("#blitzTranscript").innerText()).includes(transcript));
 assert.ok((await page.locator("#blitzScoringType").innerText()).includes("首听"));
 assert.equal(errs.length,0,"Desktop browser errors: "+errs.join("\n"));
 await mkdir(resolve(import.meta.dirname,"../artifacts"),{recursive:true});
 await page.screenshot({path:resolve(import.meta.dirname,"../artifacts/blitz-desktop.png"),fullPage:true});
 console.log("Desktop Blitz smoke PASS: one-click start, blind listening, 2 scored questions, transcript gate, first-listen report.");
 await page.close();
 const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const mobileErrors=[];mobile.on("pageerror",e=>mobileErrors.push(e.message));
 await mobile.goto(base,{waitUntil:"load"});
 await mobile.evaluate(()=>document.querySelector('[data-page="blitzPage"]').click());
 await mobile.locator('[data-blitz-duration="90"]').tap();
 await mobile.locator("#blitzStart").tap();
 await mobile.locator("#blitzWorkout").waitFor({state:"visible"});
 assert.equal(await mobile.locator(".blitz-question").count(),3);
 assert.ok(await mobile.locator("#blitzPlay").isVisible());
 await mobile.screenshot({path:resolve(import.meta.dirname,"../artifacts/blitz-mobile.png"),fullPage:true});
 assert.equal(mobileErrors.length,0,"Mobile browser errors: "+mobileErrors.join("\n"));
 console.log("Mobile Blitz smoke PASS: 90 second preset, 3 questions, responsive playback controls.");
 await mobile.close();
}finally{
 if(browser)await browser.close();
 await new Promise(done=>server.close(done));
}
