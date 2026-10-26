import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";

const root=resolve(import.meta.dirname,"..");
const read=path=>readFileSync(resolve(root,path),"utf8");
const files=[
  "web/index.html","web/app.js","web/styles.css",
  "api/src/server.js","db/init.sql","README.md",
  "docker-compose.yml",".env.example"
];
for (const file of files){
  const content=read(file);
  assert.doesNotMatch(content,/feynman|费曼/i,"Retired feature remains: "+file);
}

for (const file of ["web/app.js","web/memory-gym.js","web/memory-engine.js","api/src/server.js"]){
  execFileSync(process.execPath,["--check",resolve(root,file)],{stdio:"inherit"});
}

const html=read("web/index.html");
const client=read("web/app.js");
const api=read("api/src/server.js");
const schema=read("db/init.sql");

for (const page of ["notesPage","todayPage","quizPage","listeningPage","gamesPage","libraryPage","statsPage","settingsPage"]){
  assert.ok(html.includes('id="'+page+'"'),"Required page is missing: "+page);
}
for(const route of ["/quiz/generate","/quiz/grade","/memory/sessions","/memory/attempts","/walkman","/due"]){
  assert.ok(api.includes(route),"A retained API route is missing: "+route);
}
assert.ok(client.includes("quizWrongBtn"),"Quiz wrong-answer review was removed");
assert.ok(client.includes("quizWeakBtn"),"Quiz weak-card action was removed");
assert.ok(html.includes('data-page="gamesPage"'),"Memory training navigation was removed");
assert.ok(schema.includes("memory_attempts"),"Memory training persistence was removed");

// Existing installations may contain historical Feynman tables;
// upgrades must never drop them or unrelated review/card tables.
for(const file of ["api/src/server.js","db/init.sql"]){
  const s=read(file);
  assert.doesNotMatch(s,/DROP\s+TABLE/i,"Destructive database migration: "+file);
}

const orphanedHandlers=client.match(/\$\("(?:(?:reset|submit|random|clear|speak)[A-Z][A-Za-z]*)Feynman[A-Za-z]*"\)/g);
assert.equal(orphanedHandlers,null,"Removed page still has event handlers");
console.log("Feynman feature removal checks passed. Retained study modules are intact.");
