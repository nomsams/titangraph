// Run with node tests/browser-smoke.cjs; install Playwright or set PLAYWRIGHT_MODULE.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

(async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(),'titangraph-check-'));
  const server=http.createServer((req,res)=>{
    const script=req.url==='/features.js';res.setHeader('Content-Type',script?'application/javascript':'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname,script?'../features.js':'../index.html')));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({ headless:true, channel:process.env.BROWSER_CHANNEL || 'chrome' });
    const page=await browser.newPage({ viewport:{width:1440,height:1000},acceptDownloads:true });
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(()=>!!Graph.instance);
    assert.equal(await page.locator('#l-stat').textContent(),'Ready.');

    for(const count of [450,1200]) {
      const graph={nodes:Array.from({length:count},(_,i)=>({id:String(i),label:'Node '+i,type:i%3===0?'person':'company',notes:'å 漢字 😀 '.repeat(count===450?2200:100),meta:{index:i},x:(i%30)*50,y:Math.floor(i/30)*50})),links:Array.from({length:count*3},(_,i)=>({source:String(i%count),target:String((i+1)%count),label:'Edge '+i})),areas:[]};
      await page.locator('#f-in').setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(graph))});
      await page.waitForFunction(n=>Store.state.nodes.length===n,count);
      const downloadPromise=page.waitForEvent('download');
      await page.getByRole('button',{name:'JSON',exact:true}).click();
      const download=await downloadPromise;
      assert.equal(await download.failure(),null);
      const file=path.join(output,`graph-${count}.json`); await download.saveAs(file);
      const exported=JSON.parse(fs.readFileSync(file,'utf8'));
      assert.equal(exported.nodes.length,count); assert.equal(exported.links.length,count*3);
      assert.equal(exported.nodes[count-1].notes,graph.nodes[count-1].notes);
      assert.equal(exported.nodes[count-1].x,graph.nodes[count-1].x);
      assert.equal(exported.nodes[0]._degree,undefined);
      assert.equal(exported.links[0].source,'0');
      await page.locator('#f-in').setInputFiles(file);
      await page.waitForFunction(()=>document.getElementById('f-in').value==='');
      await page.evaluate(async()=>await Recovery.queue);
      await page.reload();await page.waitForFunction(()=>!!Graph.instance);
      assert.equal(await page.evaluate(()=>Store.state.nodes.length),count);
      assert.equal(await page.evaluate(()=>Store.state.nodes[0].notes),graph.nodes[0].notes);
      console.log(`PASS: ${count} nodes / ${count*3} links, ${fs.statSync(file).size} byte JSON download and re-import`);
    }

    await page.evaluate(()=>IO.importObject({nodes:[{id:"person'\"<&",label:"Alex O'Neil",type:'person',color:'#00ccff',x:0,y:0},{id:'event',label:'Conference',type:'event',x:100,y:0},{id:'org',label:'Association',type:'organisation',x:-100,y:0}],links:[]}));
    await page.evaluate(()=>Graph.selectNode(Store.state.nodes[0]));
    await page.locator('#p-cont input[type=checkbox]').check();
    await page.locator('#p-cont select').nth(1).selectOption('cancer');
    await page.locator('#p-cont input').nth(1).fill('research, archive');
    await page.locator('#p-cont input').nth(1).press('Tab');
    assert.deepEqual(await page.evaluate(()=>Store.state.nodes[0].tags),['research','archive']);
    assert.equal(await page.evaluate(()=>Utils.nodeColor(Store.state.nodes[0])),'#ff4444');
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.locator('#setting-death-icons').check(); await page.locator('#m-ok').click();
    assert.equal(await page.evaluate(()=>Config.deathIcons),true);
    await page.locator('#p-cont input[type=checkbox]').uncheck();
    assert.equal(await page.evaluate(()=>Utils.nodeColor(Store.state.nodes[0])),'#00ccff');
    await page.locator('#p-cont input[type=checkbox]').check();
    await page.getByRole('button',{name:'UNPIN',exact:true}).click();
    assert.equal(await page.evaluate(()=>Store.state.nodes[0].fx),null);
    await page.evaluate(()=>UI.pinToggle(Store.state.nodes[0].id));
    await page.evaluate(()=>{Graph.clearSelection(); Graph.instance.centerAt(0,0); Graph.instance.zoom(1);});

    await page.locator('#t-area').click();
    await page.mouse.move(450,330); await page.mouse.down(); await page.mouse.move(1030,690,{steps:12}); await page.mouse.up();
    await page.locator('#area-text').fill('Research group\nBackground notes'); await page.locator('#m-ok').click();
    assert.equal(await page.evaluate(()=>Store.state.areas.length),1);
    const area=await page.evaluate(()=>Store.state.areas[0]);
    await page.mouse.click(470,350); await page.locator('#area-text').fill('Updated area'); await page.locator('#m-ok').click();
    assert.equal(await page.evaluate(()=>Store.state.areas[0].text),'Updated area');
    await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(()=>Store.state.areas[0].text),'Research group\nBackground notes');
    await page.keyboard.press('Control+y'); assert.equal(await page.evaluate(()=>Store.state.areas[0].text),'Updated area');
    await page.locator('#t-move').click();

    // Actual node drag and auto-layout must persist graph coordinates.
    const pos=await page.evaluate(()=>Graph.instance.graph2ScreenCoords(Store.state.nodes[1].x,Store.state.nodes[1].y));
    const canvas=await page.locator('#graph-canvas canvas').first().boundingBox();
    await page.mouse.move(canvas.x+pos.x,canvas.y+pos.y); await page.waitForTimeout(200);
    await page.mouse.down(); await page.mouse.move(canvas.x+pos.x+80,canvas.y+pos.y+60,{steps:10}); await page.mouse.up();
    assert.ok(await page.evaluate(()=>Store.state.nodes[1].x>150));
    await page.evaluate(()=>Graph.oneShotLayout());
    await page.waitForTimeout(1800);
    assert.ok(await page.evaluate(()=>Store.state.nodes.every(n=>n.fx===n.x&&n.fy===n.y)));

    await page.evaluate(()=>{Graph.instance.centerAt(0,0);Graph.instance.zoom(1.4);UI.toggleLogs();});
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(output,'features.png')});
    // Draw each cached badge at a readable scale for visual inspection.
    await page.evaluate(()=>{
      const c=document.createElement('canvas');c.id='icon-sheet';c.width=900;c.height=160;c.style='position:fixed;top:200px;left:100px;z-index:200000;background:white';document.body.append(c);
      const ctx=c.getContext('2d'); Object.keys(DeathIcons.types).forEach((key,i)=>{DeathIcons.draw(ctx,30+(i%8)*110,35+Math.floor(i/8)*75,28,key);ctx.fillStyle='#000';ctx.font='9px sans-serif';ctx.fillText(key,5+(i%8)*110,65+Math.floor(i/8)*75);});
    });
    await page.locator('#icon-sheet').screenshot({path:path.join(output,'icons.png')});
    await page.locator('#icon-sheet').evaluate(el=>el.remove());
    const pngPromise=page.waitForEvent('download'); await page.getByTitle('Export PNG (Ctrl+P)').click();
    const png=await pngPromise; assert.equal(await png.failure(),null); await png.saveAs(path.join(output,'graph.png'));
    const roundTrip=await page.evaluate(()=>IO.payload());
    await page.locator('#f-in').setInputFiles({name:'roundtrip.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(roundTrip))});
    await page.waitForFunction(()=>Store.state.areas.length===1);
    assert.equal(await page.evaluate(()=>Store.state.areas[0].width),area.width);
    await page.reload(); await page.waitForFunction(()=>!!Graph.instance);
    assert.equal(await page.evaluate(()=>Config.deathIcons),true);
    assert.equal(await page.evaluate(()=>Store.state.areas[0].text),'Updated area');

    const before=await page.evaluate(()=>JSON.stringify(Store.state));
    await page.locator('#f-in').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"wrong":[]}')});
    await page.waitForFunction(()=>document.querySelector('#toast-title').textContent==='Import failed');
    assert.equal(await page.evaluate(()=>JSON.stringify(Store.state)),before);
    await page.locator('#t-area').click(); await page.mouse.click(470,350);
    // Position may have changed on reload: edit directly after verifying pointer editing above.
    await page.evaluate(()=>Areas.edit(Store.state.areas[0])); await page.locator('#area-delete').click();
    assert.equal(await page.evaluate(()=>Store.state.areas.length),0);
    await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(()=>Store.state.areas.length),1);
    assert.deepEqual(errors,[]);
    console.log('PASS: person status, tags, settings, special IDs, area drawing/edit/delete/undo, dragging, auto-layout, PNG, reload and invalid import');
    console.log('Artifacts: '+output);
  } finally { if(browser) await browser.close(); server.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
