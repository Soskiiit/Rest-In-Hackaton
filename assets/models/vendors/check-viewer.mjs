// Browser plugin not available: verify the actual Three.js viewer with Playwright.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const port=8767, base='http://127.0.0.1:'+port;
const server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1'],{stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){
    try{const response=await fetch(base);if(response.ok)break;}catch{}
    if(i===99)throw new Error('Preview server did not start');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  let executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if(!executablePath&&!fs.existsSync(chromium.executablePath())){
    const cache=path.join(os.homedir(),'.cache/ms-playwright');
    for(const directory of fs.existsSync(cache)?fs.readdirSync(cache).filter(d=>/^chromium-/.test(d)).sort().reverse():[]){
      for(const suffix of ['chrome-linux64/chrome','chrome-linux/chrome']){
        const candidate=path.join(cache,directory,suffix);
        if(fs.existsSync(candidate)){executablePath=candidate;break;}
      }
      if(executablePath)break;
    }
  }
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1280,height:1000},deviceScaleFactor:1});
  const errors=[],warnings=[],failures=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text());});
  page.on('requestfailed',r=>failures.push(r.url()));
  await page.goto(base);
  await page.waitForFunction(()=>window.vendorPreview?.ready,{timeout:15000});
  assert.equal(await page.title(),'Market folk · Лао Ван и Чэнь');
  assert(await page.locator('h1').isVisible());
  const stats=await page.evaluate(()=>window.vendorPreview.stats());
  assert.equal(stats.length,2);
  for(const s of stats){
    assert(s.triangles<4000);
    assert(s.bounds.min[1]>=-.0001);
    assert(s.size[1]>1.7&&s.size[1]<2.2);
    assert.deepEqual(s.clips,[{name:'Idle',duration:4},{name:'Wave',duration:2}]);
  }
  console.log('Loaded through GLTFLoader:',JSON.stringify(stats));
  const idleStart=await page.evaluate(()=>{window.vendorPreview.pose('Idle',0);return window.vendorPreview.snapshot();});
  const idleMiddle=await page.evaluate(()=>{window.vendorPreview.pose('Idle',1);return window.vendorPreview.snapshot();});
  const idleEnd=await page.evaluate(()=>{window.vendorPreview.pose('Idle',4);return window.vendorPreview.snapshot();});
  for(let i=0;i<2;i++){
    assert.notDeepEqual(idleStart[i].shoulder,idleMiddle[i].shoulder);
    idleStart[i].shoulder.forEach((v,j)=>assert(Math.abs(v-idleEnd[i].shoulder[j])<1e-6));
    idleStart[i].prop.forEach((v,j)=>assert(Math.abs(v-idleEnd[i].prop[j])<1e-6));
  }
  const frames=async()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  fs.mkdirSync('previews',{recursive:true});
  await page.selectOption('#camera','front');
  await page.evaluate(()=>window.vendorPreview.pose('Idle',0));
  await frames();await page.screenshot({path:'previews/vendors-front.png',fullPage:true});
  await page.selectOption('#camera','angle');
  await frames();await page.screenshot({path:'previews/vendors-angle.png',fullPage:true});
  // Exercise visible controls, then sample a deterministic pose.
  await page.getByRole('button',{name:'Приветствие',exact:true}).click();
  assert.equal(await page.locator('[data-clip="Wave"]').getAttribute('aria-pressed'),'true');
  const start=await page.evaluate(()=>{window.vendorPreview.pose('Wave',0);return window.vendorPreview.snapshot();});
  const wave=await page.evaluate(()=>{window.vendorPreview.pose('Wave',.95);return window.vendorPreview.snapshot();});
  for(let i=0;i<2;i++){
    assert.notDeepEqual(start[i].shoulder,wave[i].shoulder);
    assert(start[i].prop.every(Number.isFinite)&&wave[i].prop.every(Number.isFinite));
  }
  await frames();await page.screenshot({path:'previews/vendors-wave.png',fullPage:true});
  for(const name of ['lao_wang','chef_chen']){
    await page.selectOption('#model',name);
    for(const view of ['front','angle']){
      await page.selectOption('#camera',view);
      await page.evaluate(()=>window.vendorPreview.pose('Idle',0));
      await frames();
      await page.locator('#viewport').screenshot({path:'previews/'+name+'-'+view+'.png'});
    }
  }
  await page.selectOption('#model','both');
  await page.getByRole('button',{name:'Ожидание',exact:true}).click();
  assert.equal(await page.locator('[data-clip="Idle"]').getAttribute('aria-pressed'),'true');
  await page.setViewportSize({width:390,height:844});
  await frames();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'previews/viewer-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);assert.deepEqual(warnings,[]);
  console.log('PASS: meaningful page, no runtime/console/request errors; front/angle views, model selection, Idle/Wave, mobile layout; screenshots saved.');
  if(warnings.length)console.log('Browser warnings:',warnings);
} finally {await browser?.close();server.kill('SIGTERM');}
