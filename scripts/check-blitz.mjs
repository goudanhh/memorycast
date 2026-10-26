import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {BLITZ_LIBRARY} from "../api/src/blitz-content.js";
import {DURATIONS,SKILLS,SKILL_NAMES,questionCount,validateLesson,gradeQuestion,
  publicQuestions,pickDifficulty,weakestSkill,evaluate,aggregate} from "../api/src/blitz-engine.js";
const root=resolve(import.meta.dirname,"..");
const read=p=>readFileSync(resolve(root,p),"utf8");
for(const file of ["api/src/blitz.js","api/src/blitz-engine.js","api/src/blitz-content.js",
  "api/src/server.js","web/blitz.js","web/blitz-ui-engine.js","web/app.js"]){
  execFileSync(process.execPath,["--check",resolve(root,file)],{stdio:"inherit"});
  console.log("Syntax OK:",file);
}
assert.deepEqual(DURATIONS,[20,45,90]);
assert.deepEqual(DURATIONS.map(questionCount),[1,2,3]);
assert.equal(SKILLS.length,5);
assert.ok(BLITZ_LIBRARY.length>=15);
for(const [i,lesson] of BLITZ_LIBRARY.entries()){
  for(const n of DURATIONS){
    assert.ok(validateLesson(lesson,n),"Invalid listening lesson #"+(i+1)+" at "+n+"sec: "+lesson.topic);
  }
  assert.equal(lesson.questions.length,3);
  assert.ok(new Set(lesson.questions.map(q=>q.prompt)).size===3);
  for(const q of lesson.questions){
    assert.ok(SKILLS.includes(q.skill));
    assert.ok(gradeQuestion(q,q.answer),"Correct key should be accepted");
    if(q.type==="mcq"){
      for(const c of q.choices.filter(x=>x!==q.answer)){
        assert.ok(!gradeQuestion(q,c),"Invalid distractor accepted: "+c);
      }
    }
  }
}
assert.equal(pickDifficulty([]),"B1");
assert.equal(pickDifficulty([{score:0,total:4},{score:1,total:4},{score:1,total:4}]),"A2");
assert.equal(pickDifficulty([{score:4,total:4},{score:4,total:4},{score:3,total:4}]),"B2");
assert.equal(weakestSkill([{results:[{skill:"intent",correct:false},{skill:"intent",correct:false},
 {skill:"detail",correct:true},{skill:"detail",correct:true}]}]),"intent");
const first=BLITZ_LIBRARY[0].questions.slice(0,2);
const publicSet=publicQuestions(first,2);
assert.ok(publicSet.every(q=>!Object.hasOwn(q,"answer")&&!Object.hasOwn(q,"evidence")&&
  !Object.hasOwn(q,"explanation")&&!Object.hasOwn(q,"accepted")),
  "Server must hide answer keys, accepted variants and explanations until submission");
assert.deepEqual(publicSet.map(x=>x.id),["q1","q2"]);
const recorded=evaluate(first,{q1:first[0].answer,q2:"not an answer"},1);
assert.equal(recorded.score,1);
assert.equal(recorded.firstListen,true);
assert.equal(recorded.total,2);
assert.equal(evaluate(first,{q1:first[0].answer,q2:"not an answer"},2).firstListen,false);
const now=Date.UTC(2026,9,26,12,0,0);
const past=[
 {completed_at:new Date(now-86400000).toISOString(),result:recorded},
 {completed_at:new Date(now-40*86400000).toISOString(),result:evaluate(first,{q1:"bad",q2:"bad"},2)}
];
const week=aggregate(past,7,now),quarter=aggregate(past,90,now);
assert.equal(week.sessions,1);
assert.equal(quarter.sessions,2);
assert.equal(week.firstAccuracy,50);
assert.equal(quarter.assistedQuestions,2);
const html=read("web/index.html"),client=read("web/blitz.js"),api=read("api/src/blitz.js"),
  server=read("api/src/server.js"),db=read("db/init.sql"),css=read("web/blitz.css"),
  readme=read("README.md");
for(const id of ["blitzPage","blitzStart","blitzWelcome","blitzWorkout","blitzResults",
  "blitzRate","blitzPlay","blitzSubmit","blitzAnswers","blitzAudio","blitzTranscript",
  "blitzExplanation","blitzFirstAccuracy","blitzTotalAccuracy","blitzSkills","blitzTrend",
  "blitzRecent","blitzFocus"]){
 assert.ok(html.includes('id="'+id+'"'),"Blitz UI missing id "+id);
}
assert.ok(html.includes('/blitz.js?v=1')&&html.includes('/blitz.css?v=1'));
for(const path of ['"/blitz/prepare"','"/blitz/start"','"/blitz/play/:id"',
  '"/blitz/audio/:id"','"/blitz/browser-speech/:id"',
  '"/blitz/submit/:id"','"/blitz/insights"']){
  assert.ok(api.includes(path),"Missing server endpoint "+path);
}
assert.ok(server.includes("installBlitz("),"Listening Blitz not registered");
assert.ok(api.includes("completed_at IS NULL")&&api.includes("user_id=$2"),"Server-side ownership/integrity missing");
assert.ok(api.includes("publicQuestions("),"Quiz answer protection missing");
assert.ok(!/UPDATE cards SET|UPDATE reviews SET/i.test(api),"Blitz must not alter FSRS / reviews");
assert.ok(db.includes("CREATE TABLE IF NOT EXISTS blitz_sessions"));
for(const token of ["readAnswers()","fetchSpeechFallback()","audio.play()",
  "firstListen","blitzExplanation","blitzTranscript","loadInsights()","warmNext()"]){
  assert.ok(client.includes(token),"Missing interaction "+token);
}
for(const untouched of ["listeningPage","listeningGenerate","walkmanPlayBtn","quizPage","notesPage","libraryPage"]){
  assert.ok(html.includes(untouched),"Existing study module removed: "+untouched);
}
assert.ok(css.length>4000);
assert.ok(readme.includes("听力闪击"));
console.log("Listening Blitz curated scenarios, secure scoring, first-listen accuracy, 7/30/90-day trends, API/UI contracts PASS.");
