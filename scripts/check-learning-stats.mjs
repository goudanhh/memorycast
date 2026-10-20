import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import assert from "node:assert/strict";

const root=resolve(import.meta.dirname,"..");
const read=p=>readFileSync(resolve(root,p),"utf8");
const html=read("web/index.html");
const app=read("web/app.js");
const api=read("api/src/server.js");
const css=read("web/stats.css");

for(const path of ["web/app.js","api/src/server.js"]){
  execFileSync(process.execPath,["--check",resolve(root,path)],{stdio:"inherit"});
  console.log("Syntax OK:",path);
}
const ui=html.slice(html.indexOf('<section id="statsPage"'),html.indexOf('<section id="settingsPage"'));
const stats=app.slice(app.indexOf("const statsState="),app.indexOf("async function loadSettings(){"));
assert.ok(ui.length>1000&&stats.length>1000,"Dashboard missing");
for(const id of [...new Set([...stats.matchAll(/\$\("([^"]+)"\)/g)].map(match=>match[1]))]){
  assert.ok(html.includes('id="'+id+'"'),"Missing stats DOM element: "+id);
}
for(const days of [7,30,90]){
  assert.ok(ui.includes('data-stats-period="'+days+'"'),"Missing time-range selector: "+days);
}
for(const token of ["statsGoalRing","statsHeatmap","statsHighlights","statsCategoryToggle"]){
  assert.ok(ui.includes('id="'+token+'"'),"Missing dashboard feature "+token);
}
assert.match(api,/source='quiz' AND verdict='correct'/,"Quiz accuracy must count quiz verdicts only");
assert.match(api,/generate_series\(0,\$3::int - 1\)/,"The API must produce time-range daily data");
assert.match(api,/reviewed_at >= \(d\.day::timestamp AT TIME ZONE \$2\)/,"Timezone-specific daily counts missing");
assert.match(css,/#statsPage \.insights-kpis/,"Scoped dashboard styling missing");
console.log("Stats DOM, date filters, API fields and CSS checks passed.");
