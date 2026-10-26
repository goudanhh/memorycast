import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,mkdir} from "node:fs/promises";
import {resolve,join,extname} from "node:path";
import {chromium} from "playwright";

const root=resolve(import.meta.dirname,"../web");
const mime={".html":"text/html;charset=utf-8",".js":"text/javascript;charset=utf-8",
  ".css":"text/css;charset=utf-8",".json":"application/json"};
const pairs=[["resilience","韧性"],["gradually","逐渐地"],["essential","必不可少的"],["predict","预测"]];
const cards=pairs.map(([front,back],i)=>({id:"00000000-0000-4000-8000-"+String(i+1).padStart(12,"0"),front,back,example:front+" example"}));
const sessionId="00000000-0000-4000-8000-000000000099",trials=[];
let completed=false;
const server=createServer(async(req,res)=>{
  const p=new URL(req.url,"http://localhost").pathname;
  res.setHeader("Cache-Control","no-store");
  if(p.startsWith("/api/")){
    res.setHeader("Content-Type","application/json");
    let raw="";for await(const chunk of req)raw+=chunk;
    let b={};try{b=JSON.parse(raw||"{}")}catch{}
    if(p==="/api/memory/overview")return res.end(JSON.stringify({
      sessions:{completed:completed?1:0,last7:completed?1:0},
      attempts:{trials:trials.length,delayed_total:4,delayed_correct:3},
      weak:completed?[{id:cards[0].id,front:cards[0].front,back:cards[0].back}]:[]
    }));
    if(p==="/api/memory/sessions"&&req.method==="POST")
      return res.end(JSON.stringify({sessionId,cards:cards.slice(0,b.count)}));
    if(p==="/api/memory/attempts"&&req.method==="POST"){
      assert.ok(cards.some(c=>c.id===b.cardId));
      assert.ok(["retrieve","interleave","delayed"].includes(b.phase));
      assert.ok([0,1,2].includes(b.grade));
      assert.ok(b.grade===0||b.response.trim());
      assert.ok(!trials.some(t=>t.cardId===b.cardId&&t.phase===b.phase));
      trials.push(b);res.statusCode=201;return res.end(JSON.stringify({ok:true}));
    }
    if(p==="/api/memory/sessions/"+sessionId+"/complete"&&req.method==="POST"){
      assert.equal(trials.length,12);completed=true;return res.end(JSON.stringify({ok:true}));
    }
    res.statusCode=404;return res.end(JSON.stringify({error:"Mock API unavailable"}));
  }
  if(p==="/app.js"){
    res.setHeader("Content-Type",mime[".js"]);
    return res.end("document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.getElementById(b.dataset.page)?.classList.add('active')}));");
  }
  const file=p==="/"?"/index.html":p;
  if(![".html",".js",".css",".webmanifest"].includes(extname(file))){res.statusCode=404;return res.end("Not found")}
  try{const body=await readFile(join(root,file));
    res.setHeader("Content-Type",mime[extname(file)]||"application/octet-stream");res.end(body);
  }catch{res.statusCode=404;res.end("Not found")}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const url="http://127.0.0.1:"+server.address().port+"/";
let browser;
try{
  browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
  const page=await browser.newPage({viewport:{width:1320,height:850}});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(url,{waitUntil:"load"});
  await page.locator('[data-page="gamesPage"]').first().click();
  await page.locator("#memoryStart").waitFor({state:"visible"});
  await page.locator("#memoryCount").selectOption("4");
  await page.locator("#memoryStart").click();
  await page.locator("#memoryPreviewCards .memory-preview-card").first().waitFor();
  assert.equal(await page.locator(".memory-preview-card").count(),4);
  await page.locator("#memoryBeginRecall").click();
  for(let i=0;i<12;i++){
    if(i>0&&i%4===0){
      await page.locator("#memoryInterlude").waitFor({state:"visible"});
      await page.locator("#memoryContinuePhase").click();
    }
    await page.locator("#memoryInputArea").waitFor({state:"visible"});
    const prompt=(await page.locator("#memoryPrompt").innerText()).trim();
    const card=cards.find(c=>c.front===prompt||c.back===prompt);
    assert.ok(card,"Unknown memory prompt: "+prompt);
    const expected=prompt===card.front?card.back:card.front;
    if(i===11){
      await page.locator("#memoryForgot").click();
      await page.locator('[data-memory-grade="0"]').click();
    }else{
      await page.locator("#memoryResponse").fill(expected);
      await page.locator("#memoryReveal").click();
      assert.equal((await page.locator("#memoryCorrectAnswer").innerText()).trim(),expected);
      await page.locator('[data-memory-grade="2"]').click();
    }
  }
  await page.locator("#memoryFinish").waitFor({state:"visible"});
  await page.locator("#memoryFinishActions").waitFor({state:"visible"});
  assert.equal(trials.length,12);
  assert.ok(completed);
  assert.ok((await page.locator("#memoryFinishRetained").innerText()).includes("3 / 4"));
  assert.equal(errors.length,0,"Browser errors: "+errors.join("\n"));
  await mkdir(resolve(import.meta.dirname,"../artifacts"),{recursive:true});
  await page.screenshot({path:resolve(import.meta.dirname,"../artifacts/memory-desktop.png"),fullPage:true});
  console.log("Desktop smoke PASS: preview, 12 written recall attempts, three phases, feedback, completion.");
  await page.close();

  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const mErrors=[];mobile.on("pageerror",e=>mErrors.push(e.message));
  await mobile.goto(url,{waitUntil:"load"});
  await mobile.evaluate(()=>document.querySelector('[data-page="gamesPage"]').click());
  await mobile.locator("#memoryWelcome").waitFor({state:"visible"});
  await mobile.locator("#memoryStartWeak").waitFor({state:"visible"});
  assert.equal(await mobile.locator("#memoryStartWeak").isEnabled(),true);
  await mobile.screenshot({path:resolve(import.meta.dirname,"../artifacts/memory-mobile.png"),fullPage:true});
  assert.deepEqual(mErrors,[]);
  console.log("Mobile smoke PASS: 390px layout, weak-card recall action and overview.");
  await mobile.close();
}finally{
  if(browser)await browser.close();
  await new Promise(done=>server.close(done));
}
