const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const os=require('node:os');

(async()=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'titangraph-features-'));
  const server=http.createServer((req,res)=>{
    const script=req.url==='/features.js';res.setHeader('Content-Type',script?'application/javascript':'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname,script?'../features.js':'../index.html')));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
    const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    if(process.env.DEBUG_UI)page.on('console',message=>console.log(message.text()));
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>!!Graph.instance);
    if(process.env.DEBUG_UI)await page.evaluate(()=>{
      for(const key of ['click','drag','endDrag']){const original=Selection[key];Selection[key]=function(...args){console.log(key, args[0].id, args[1]?.ctrlKey,JSON.stringify([...this.ids]));return original.apply(this,args);};}
    });
    const fixture={nodes:[
      {id:'a',label:'Alex',type:'person',tags:['case'],x:-170,y:-80},
      {id:'b',label:'Beta Ltd',type:'company',tags:['work'],x:-10,y:-80},
      {id:'c',label:'Casey',type:'person',tags:['case'],deceased:true,x:-10,y:80},
      {id:'d',label:'Delta Event',type:'event',tags:['case'],x:150,y:0},
      {id:'e',label:'Elliot',type:'person',tags:['archive'],x:-350,y:180},
      {id:'f',label:'Foundation',type:'organisation',x:250,y:200}
    ],links:[{id:'ab',source:'a',target:'b'},{id:'ac',source:'a',target:'c'},{id:'bd',source:'b',target:'d'},{id:'cd',source:'c',target:'d'}]};
    const load=async()=>{await page.evaluate(g=>{IO.importObject(g);document.body.classList.add('log-min');},fixture);await page.waitForTimeout(500);await page.evaluate(()=>{Graph.instance.centerAt(0,0);Graph.instance.zoom(1);});await page.waitForTimeout(100);};
    const nodePoint=async id=>page.evaluate(id=>{const n=Graph.instance.graphData().nodes.find(n=>n.id===id),p=Graph.instance.graph2ScreenCoords(n.x,n.y),r=document.querySelector('#graph-canvas canvas').getBoundingClientRect();return{x:r.left+p.x,y:r.top+p.y};},id);
    const clickNode=async(id,ctrl=false)=>{const p=await nodePoint(id);await page.mouse.move(p.x,p.y);await page.waitForTimeout(120);if(ctrl)await page.keyboard.down('Control');await page.mouse.click(p.x,p.y);if(ctrl)await page.keyboard.up('Control');};
    await load();await clickNode('a');await clickNode('b',true);
    if(process.env.DEBUG_UI)console.log(await page.evaluate(()=>({selected:[...Selection.ids],hover:Graph.hoverNode?.id,node:Graph.selectedNode?.id,logs:document.querySelector('#l-cont').textContent})));
    assert.equal(await page.evaluate(()=>Selection.ids.size),2);
    const before=await page.evaluate(()=>Store.state.nodes.slice(0,2).map(n=>({x:n.x,y:n.y})));
    const point=await nodePoint('a');await page.mouse.move(point.x,point.y);await page.waitForTimeout(150);
    await page.mouse.down();await page.mouse.move(point.x+70,point.y+45,{steps:12});await page.mouse.up();
    const after=await page.evaluate(()=>Store.state.nodes.slice(0,2).map(n=>({x:n.x,y:n.y})));
    assert.ok(after[0].x-before[0].x>10);assert.ok(Math.abs((after[0].x-before[0].x)-(after[1].x-before[1].x))<0.1);
    assert.ok(Math.abs((after[0].y-before[0].y)-(after[1].y-before[1].y))<0.1);
    await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>Store.state.nodes[0].x),before[0].x);
    await load();
    await page.mouse.move(440,350);await page.waitForTimeout(150);await page.mouse.down();await page.mouse.move(970,650,{steps:12});await page.mouse.up();
    if(process.env.DEBUG_UI)console.log(await page.evaluate(()=>({selected:[...Selection.ids],zoom:Graph.instance.zoom(),nodes:Graph.instance.graphData().nodes.map(n=>({id:n.id,x:n.x,y:n.y,p:Graph.instance.graph2ScreenCoords(n.x,n.y)}))})));
    assert.deepEqual(await page.evaluate(()=>[...Selection.ids].sort()),['a','b','c','d']);
    await page.locator('#bulk-tags').fill('selected');await page.locator('#bulk-type').selectOption('organisation');
    await page.getByRole('button',{name:'Apply changes',exact:true}).click();
    assert.equal(await page.evaluate(()=>Store.state.nodes.filter(n=>n.tags.includes('selected')).length),4);
    await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>Store.state.nodes.length),2);
    await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>Store.state.nodes.length),6);
    console.log('PASS: Ctrl-click, selection box, group drag, bulk edits/delete and undo');

    await load();await page.getByRole('button',{name:'Filters and saved views',exact:true}).click();
    await page.locator('[name=filter-type][value=person]').check();await page.locator('#filter-tags').fill('CASE');await page.locator('#view-name').fill('Case people');
    await page.locator('#view-save').click();
    assert.equal(await page.evaluate(()=>Graph.instance.graphData().nodes.length),2);assert.equal(await page.evaluate(()=>Store.state.nodes.length),6);
    const savedId=await page.evaluate(()=>Store.state.savedViews[0].id);
    await page.locator('#filter-reset').click();assert.equal(await page.evaluate(()=>Graph.instance.graphData().nodes.length),6);
    await page.getByRole('button',{name:'Filters and saved views',exact:true}).click();await page.locator('#view-list').selectOption(savedId);await page.locator('#view-load').click();
    assert.equal(await page.evaluate(()=>Graph.instance.graphData().nodes.length),2);
    assert.equal(await page.evaluate(()=>IO.payload().nodes.length),6);
    await page.getByRole('button',{name:'Show all',exact:true}).click();
    await clickNode('a');await page.getByRole('button',{name:'1 step',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>Graph.instance.graphData().nodes.map(n=>n.id).sort()),['a','b','c']);
    await page.getByRole('button',{name:'2 steps',exact:true}).click();assert.equal(await page.evaluate(()=>Graph.instance.graphData().nodes.length),4);
    await page.getByRole('button',{name:'Show all',exact:true}).click();
    await page.getByRole('button',{name:'Find paths',exact:true}).click();
    await page.locator('#path-from').selectOption('a');await page.locator('#path-to').selectOption('d');await page.locator('#path-directed').check();await page.locator('#path-only').check();await page.locator('#m-ok').click();
    assert.equal(await page.evaluate(()=>Views.pathResult.paths.length),2);assert.equal(await page.evaluate(()=>Graph.instance.graphData().nodes.length),4);
    await page.evaluate(()=>Graph.clearSelection());await page.waitForTimeout(500);await page.screenshot({path:path.join(output,'paths.png')});
    await page.getByRole('button',{name:'Show all',exact:true}).click();
    await page.getByRole('button',{name:'Find paths',exact:true}).click();await page.locator('#path-from').selectOption('d');await page.locator('#path-to').selectOption('a');await page.locator('#path-directed').check();await page.locator('#m-ok').click();
    assert.equal(await page.evaluate(()=>Views.pathResult.paths.length),0);await page.getByRole('button',{name:'Show all',exact:true}).click();
    console.log('PASS: saved filters, neighbourhood focus and directed shortest paths');

    await page.evaluate(()=>{Graph.instance.centerAt(0,0);Graph.instance.zoom(1);Graph.selectNode(Store.state.nodes.find(n=>n.id==='a'));});
    await page.locator('#node-notes').fill('Met @Bet');await page.locator('.mention-menu button').filter({hasText:'Beta Ltd'}).click();
    assert.equal(await page.evaluate(()=>Store.state.nodes.find(n=>n.id==='a').notes),'Met @[Beta Ltd] ');
    assert.equal(await page.evaluate(()=>Store.state.links.filter(l=>l.autoMention).length),1);
    await page.getByRole('button',{name:'Add entry',exact:true}).click();
    await page.locator('#entry-date').fill('2022-05-06');await page.locator('#entry-kind').selectOption('action');await page.locator('#entry-title').fill('Follow up');await page.locator('#entry-details').fill('Attended @[Delta Event]');await page.locator('#m-ok').click();
    await page.getByRole('button',{name:'Add entry',exact:true}).click();await page.locator('#entry-date').fill('2020-01-02');await page.locator('#entry-title').fill('Initial discovery');await page.locator('#m-ok').click();
    assert.ok((await page.locator('.timeline-entry').first().textContent()).includes('2020-01-02'));
    await page.locator('#timeline-order').selectOption('desc');assert.ok((await page.locator('.timeline-entry').first().textContent()).includes('2022-05-06'));
    await page.getByRole('button',{name:'Add source',exact:true}).click();await page.locator('#source-title').fill('Interview record');await page.locator('#source-url').fill('https://example.com/evidence');await page.locator('#source-date').fill('2022-05-07');await page.locator('#source-notes').fill('Verified with @Elliot');await page.locator('#m-ok').click();
    assert.equal(await page.evaluate(()=>document.querySelector('#p-cont').lastElementChild.id),'node-sources');
    assert.equal(await page.evaluate(()=>Store.state.links.filter(l=>l.autoMention).length),3);
    await page.locator('#node-sources').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'sources.png')});
    await page.locator('#node-timeline').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'timeline.png')});
    console.log('PASS: mention autocomplete, automatic links, per-node timeline and sources at the bottom');

    await page.getByRole('button',{name:'Snapshots and recovery',exact:true}).click();await page.locator('#snapshot-name').fill('Case checkpoint');await page.locator('#snapshot-save').click();
    await page.locator('#snapshot-list .detail-card').filter({hasText:'Case checkpoint'}).waitFor();
    await page.locator('#m-ok').click();
    await page.evaluate(()=>Store.updateNode('a',{label:'Changed Alex',notes:'Changed notes'}));
    await page.getByRole('button',{name:'Snapshots and recovery',exact:true}).click();
    const checkpoint=page.locator('#snapshot-list .detail-card').filter({hasText:'Case checkpoint'});
    await checkpoint.getByRole('button',{name:'Compare',exact:true}).click();assert.ok((await checkpoint.textContent()).includes('notes'));
    const downloadPromise=page.waitForEvent('download');await checkpoint.getByRole('button',{name:'Export',exact:true}).click();const download=await downloadPromise;
    const exported=path.join(output,'checkpoint.json');await download.saveAs(exported);
    const checkpointJson=JSON.parse(fs.readFileSync(exported,'utf8'));assert.equal(checkpointJson.nodes[0].timeline.length,2);assert.equal(checkpointJson.nodes[0].sources.length,1);assert.equal(checkpointJson.savedViews.length,1);
    await checkpoint.getByRole('button',{name:'Restore',exact:true}).click();await page.waitForFunction(()=>Store.state.nodes[0].label==='Alex');
    assert.equal(await page.evaluate(()=>Store.state.nodes[0].notes),'Met @[Beta Ltd] ');
    await page.evaluate(async()=>{await Recovery.queue;localStorage.removeItem(Config.storageKey);localStorage.removeItem(Config.storageKey+'_savedAt');});
    await page.reload();await page.waitForFunction(()=>!!Graph.instance);
    assert.equal(await page.evaluate(()=>Store.state.nodes[0].label),'Alex');assert.equal(await page.evaluate(()=>Store.state.nodes[0].timeline.length),2);
    assert.equal(await page.evaluate(()=>Store.state.savedViews.length),1);
    await page.getByRole('button',{name:'Snapshots and recovery',exact:true}).click();assert.ok(await page.locator('#snapshot-list').getByText('Before restoring Case checkpoint',{exact:true}).count());
    await page.screenshot({path:path.join(output,'snapshots.png')});await page.locator('#m-ok').click();
    assert.deepEqual(errors,[]);
    console.log('PASS: checkpoint save/compare/export/restore, restore backup, and recovery without localStorage');
    console.log('Artifacts: '+output);
  }finally{if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
