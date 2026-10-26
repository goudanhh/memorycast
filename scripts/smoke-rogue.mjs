import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,mkdir} from "node:fs/promises";
import {resolve,extname,join} from "node:path";
import {chromium} from "playwright";

const root=resolve(import.meta.dirname,"../web");
const MIMES={".html":"text/html;charset=utf-8",".js":"text/javascript;charset=utf-8",
  ".css":"text/css;charset=utf-8",".json":"application/json"};
const profile={coins:125,totalXp:50,runs:1,bestWave:2,highestSector:1,wins:0,
  upgrades:{power:0,armor:0,magnet:0}};
const cards=["resilience","remarkable","gradually","essential","widespread",
  "estimate","analyze","interpret","predict"].map((front,i)=>({
    id:"00000000-0000-4000-8000-"+String(i+1).padStart(12,"0"),
    front,back:["韧性","非凡的","逐渐地","必不可少的","广泛的","估计","分析","解释","预测"][i],
    priority:100-i*10
  }));

const server=createServer(async(req,res)=>{
  const path=new URL(req.url,"http://127.0.0.1").pathname;
  res.setHeader("Cache-Control","no-store");
  if(path.startsWith("/api/")){
    res.setHeader("Content-Type","application/json");
    if(path==="/api/arcade/profile")return res.end(JSON.stringify({profile}));
    if(path==="/api/games/cards")return res.end(JSON.stringify({cards}));
    if(path==="/api/games/stats")return res.end(JSON.stringify({overall:{attempts:0,correct:0,last7:0,practiced_cards:0}}));
    if(path==="/api/adventure/progress")return res.end(JSON.stringify({highestCompleted:0,levels:[]}));
    if(path==="/api/arcade/upgrade"&&req.method==="POST"){
      profile.coins-=65;profile.upgrades.power++;return res.end(JSON.stringify({profile}));
    }
    if(path==="/api/arcade/finish"&&req.method==="POST"){
      profile.coins+=35;profile.runs++;return res.end(JSON.stringify({profile,rewards:{coins:35,xp:30}}));
    }
    res.statusCode=404;return res.end(JSON.stringify({error:"Mock endpoint not implemented"}));
  }
  if(path==="/app.js"){
    res.setHeader("Content-Type",MIMES[".js"]);
    return res.end("document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.getElementById(b.dataset.page)?.classList.add('active')}));");
  }
  const file=path==="/"?"/index.html":path;
  if(![".js",".css",".html",".json",".webmanifest",".png",".ico",".svg"].includes(extname(file))&&
     !file.endsWith(".webmanifest")){res.statusCode=404;return res.end();}
  try{
    const raw=await readFile(join(root,file));
    res.setHeader("Content-Type",MIMES[extname(file)]||"application/octet-stream");
    res.end(raw);
  }catch{
    res.statusCode=404;res.end("Not found");
  }
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const port=server.address().port;
let browser;
try{
  browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  const errors=[];
  page.on("pageerror",err=>errors.push(err.message));
  await page.goto("http://127.0.0.1:"+port+"/",{waitUntil:"load"});
  await page.locator('[data-page="gamesPage"]').first().click();
  await page.locator("#rogueSectors [data-sector]").first().waitFor({state:"visible",timeout:15000});
  assert.equal(await page.locator("#rogueSectors .unlocked").count(),1);
  assert.equal(await page.locator("#rogueWallet").innerText(),"125 🪙");
  await page.locator('[data-upgrade="power"]').click();
  await page.waitForFunction(()=>document.getElementById("rogueWallet")?.textContent==="60 🪙",{timeout:8000});
  await page.locator("#rogueSectors [data-sector='1']").click();
  await page.locator("#rogueCanvas").waitFor({state:"visible"});
  assert.equal(await page.locator("#rogueBattle").isVisible(),true);
  assert.equal(await page.locator("#rogueHealth").innerText(),"100 / 100");
  assert.equal(await page.locator("#rogueGold").innerText(),"50");
  const initial=await page.locator("#rogueCanvas").evaluate(c=>c.toDataURL().length);
  assert.ok(initial>1000,"Canvas is not drawing a real arena");
  await page.locator("#rogueBuild").click();
  await page.waitForFunction(()=>document.getElementById("rogueGold")?.textContent==="15");
  await page.keyboard.down("w");
  await page.waitForTimeout(420);
  await page.keyboard.up("w");
  await page.locator("#rogueDash").click();
  await page.waitForFunction(()=>document.getElementById("rogueDashText")?.textContent!=="就绪");
  await page.waitForFunction(()=>document.getElementById("rogueWave")?.textContent?.startsWith("1 /"),null,{timeout:8000});
  await page.waitForTimeout(1000);
  const core=await page.locator("#rogueCore").innerText();
  assert.ok(core.includes("/ 260"),"Tower defense core HUD is absent");
  assert.equal(errors.length,0,"Unexpected browser errors:\n"+errors.join("\n"));
  const location=resolve(import.meta.dirname,"../artifacts/rogue-actual-gameplay.png");
  await mkdir(resolve(import.meta.dirname,"../artifacts"),{recursive:true});
  await page.screenshot({path:location,fullPage:true,animations:"disabled"});
  console.log("Browser smoke PASS: navigation, profile, paid upgrade, Canvas arena, tower build, keyboard move, dash, enemy wave.");
  console.log("Screenshot:",location);
  await page.close();
}finally{
  if(browser)await browser.close();
  await new Promise(done=>server.close(done));
}
