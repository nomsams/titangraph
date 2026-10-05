const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function app({ storageFailure = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { checked:false, className:'', innerText:'', style:{}, classList:{ add(){}, remove(){}, toggle(){}, contains(){ return false; } } });
    return elements.get(id);
  };
  const context = vm.createContext({
    window:{}, document:{ getElementById:element, body:element('body'), documentElement:{ setAttribute(){} } },
    localStorage:{ getItem(){ return null; }, setItem(){ if (storageFailure) throw new Error('QuotaExceededError'); } }, setTimeout(){}, clearTimeout(){}, console, Blob, URL
  });
  const script = fs.readFileSync(require('node:path').join(__dirname, '../index.html'),'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../features.js'),'utf8'),context);
  vm.runInContext(script + '\nglobalThis.api = { Store, Graph, Config, Utils, UI, IO, DeathIcons, Views, Selection, Mentions, NodeDetails, Recovery }; Logger.log = () => {};', context);
  return context.api;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('earliest data-based exports retain metadata and object link endpoints', () => {
  const { Store } = app();
  const result = Store.normalizeState({ nodes:[{id:'a',label:'target.com',type:'domain',data:{whois:{name:'Owner'}},x:32,y:-8,z:10},{id:'b',label:'Owner',type:'person'}],links:[{source:{id:'a'},target:{id:'b'}}] });
  assert.equal(result.nodes[0].meta.whois.name,'Owner');
  assert.deepEqual(plain(result.nodes[0].data),{whois:{name:'Owner'}});
  assert.equal(result.nodes[0].fx,32);
  assert.equal(result.links[0].source,'a');
  assert.equal(result.links[0].target,'b');
});

test('v14 metadata, coordinates, pinning, notes and edge styles survive normalization', () => {
  const { Store } = app();
  const graph={nodes:[{id:'a',label:'A',type:'company',x:20,y:30,fx:null,fy:null,notes:'Note',meta:{nested:[1,2]}},{id:'b',label:'B',x:40,y:50,fx:40,fy:50}],links:[{id:'edge',source:'a',target:'b',label:'owns',type:'owns',color:'#ffcc00',dashed:true,directed:false,meta:{year:2020}}]};
  const result=Store.normalizeState(graph);
  assert.equal(result.nodes[0].fx,null); assert.equal(result.nodes[0].notes,'Note');
  assert.deepEqual(plain(result.nodes[0].meta),{nested:[1,2]});
  assert.deepEqual(plain(result.links[0]),graph.links[0]);
});

test('numeric IDs, name labels and organisation alias import consistently', () => {
  const { Store } = app();
  const graph=Store.normalizeState({nodes:[{id:0,name:'Zero',type:'Organization'},{id:1,name:'Event',type:'Event'}],links:[{source:0,target:{id:1}}]});
  assert.equal(graph.nodes[0].id,'0'); assert.equal(graph.nodes[0].type,'organisation');
  assert.equal(graph.nodes[1].type,'event'); assert.equal(graph.links.length,1);
});

test('new fields, legacy data and areas survive export and import', () => {
  const { Store, IO, Config }=app();
  Store.state=Store.normalizeState({nodes:[{id:'a',label:'Person',type:'person',color:'#00ccff',tags:['one','one','two'],deceased:true,deathType:'cancer',data:{old:1},meta:{new:2}}],links:[],areas:[{id:'area',x:-100,y:-50,width:200,height:150,text:'Group\nNotes',color:'#a78bfa'}]});
  Config.deathIcons=true;
  const exported=IO.payload(); IO.importObject(plain(exported));
  const { _meta, ...expected } = exported;
  assert.deepEqual(plain(Store.state),plain(expected));
});

test('invalid imports and duplicate IDs leave the current graph intact', () => {
  const { Store, IO }=app(); Store.reset(); const before=JSON.stringify(Store.state);
  for(const input of [{foo:'bar'},{nodes:[{id:'x'},{id:'x'}],links:[]}]) assert.throws(()=>IO.importObject(input));
  assert.equal(JSON.stringify(Store.state),before);
});

test('distinct directed and undirected links remain separate', () => {
  const { Store }=app();
  const graph=Store.normalizeState({nodes:[{id:'a'},{id:'b'}],links:[{source:'a',target:'b',directed:true},{source:'a',target:'b',directed:false}]});
  assert.equal(graph.links.length,2);
});

test('storage quota failures preserve edits, history and export capability', () => {
  const { Store, IO }=app({ storageFailure:true }); Store.reset(); Store.history=[plain(Store.state)]; Store.hIdx=0;
  const id=Store.state.nodes[0].id;
  Store.updateNode(id,{label:'Kept'});
  assert.equal(IO.payload().nodes[0].label,'Kept'); assert.equal(Store.history.length,2);
  assert.equal(Store.persist(),false);
});

test('coordinate syncing cannot overwrite pin or unpin edits', () => {
  const { Store, Graph }=app(); Store.reset(); const id=Store.state.nodes[0].id;
  const rendered={...Store.state.nodes[0],x:42,y:24,fx:42,fy:24};
  Graph.instance={graphData:()=>({nodes:[rendered]})}; Graph.refresh=()=>{};
  Store.updateNode(id,{fx:null,fy:null}); assert.equal(Store.state.nodes[0].fx,null); assert.equal(Store.state.nodes[0].x,42);
});

test('deceased people override custom colors, hubs enlarge by 50 percent', () => {
  const { Utils }=app();
  assert.equal(Utils.nodeColor({type:'person',deceased:true,color:'#00ccff'}),'#ff4444');
  assert.equal(Utils.nodeColor({type:'person',deceased:false,color:'#00ccff'}),'#00ccff');
  assert.equal(Utils.nodeRadius({_degree:7}),13.5); assert.equal(Utils.nodeRadius({_degree:0}),6);
});

test('large graph round trips retain all nodes, links and long Unicode notes', () => {
  const { Store, IO }=app();
  const graph={nodes:Array.from({length:1200},(_,i)=>({id:String(i),label:'Node '+i,notes:'å 漢字 😀 '.repeat(500),x:i,y:-i,meta:{index:i}})),links:Array.from({length:3600},(_,i)=>({source:String(i%1200),target:String((i+1)%1200),label:'Link '+i})),areas:[]};
  IO.importObject(graph); const exported=IO.payload();
  assert.equal(exported.nodes.length,1200); assert.equal(exported.links.length,3600);
  assert.equal(exported.nodes[1199].notes,graph.nodes[1199].notes);
  assert.equal(exported.nodes[1199].x,1199); assert.equal(exported.links[3599].label,'Link 3599');
});

test('filters and neighbourhoods hide nodes without changing the stored graph', () => {
  const { Store,Views }=app();
  Store.state=Store.normalizeState({nodes:[{id:'a',type:'person',tags:['family']},{id:'b',type:'company',tags:['work']},{id:'c',type:'person',deceased:true,tags:['family']},{id:'d',type:'event'}],links:[{id:'ab',source:'a',target:'b'},{id:'bc',source:'b',target:'c'}]});
  const before=JSON.stringify(Store.state);
  Views.filters=Views.normalizeFilters({types:['person'],tags:['FAMILY'],life:'deceased'});
  assert.deepEqual(plain(Views.filtered(Store.state).nodes.map(n=>n.id)),['c']);
  Views.reset(false);Views.neighbourhood={rootId:'a',hops:1};
  assert.deepEqual(plain(Views.filtered(Store.state).nodes.map(n=>n.id)),['a','b']);
  Views.neighbourhood.hops=2;assert.deepEqual(plain(Views.filtered(Store.state).nodes.map(n=>n.id)),['a','b','c']);
  assert.equal(JSON.stringify(Store.state),before);
});

test('path finder handles equal shortest paths, directions, undirected edges and disconnected nodes', () => {
  const { Store,Views }=app();
  const graph=Store.normalizeState({nodes:['a','b','c','d','e'].map(id=>({id})),links:[{id:'ab',source:'a',target:'b'},{id:'ac',source:'a',target:'c'},{id:'bd',source:'b',target:'d'},{id:'cd',source:'c',target:'d'}]});
  const paths=Views.shortestPaths(graph,'a','d',true).paths;
  assert.equal(paths.length,2);assert.ok(paths.every(p=>p.links.length===2));
  assert.equal(Views.shortestPaths(graph,'d','a',true).paths.length,0);
  assert.equal(Views.shortestPaths(graph,'d','a',false).paths.length,2);
  assert.equal(Views.shortestPaths(graph,'a','e').paths.length,0);
  assert.deepEqual(plain(Views.shortestPaths(graph,'a','a').paths[0]),{nodes:['a'],links:[]});
  graph.links.forEach(l=>l.directed=false);assert.equal(Views.shortestPaths(graph,'d','a',true).paths.length,2);
  const capped=Views.shortestPaths(graph,'a','d',false,1);assert.equal(capped.paths.length,1);assert.equal(capped.truncated,true);
});

test('mentions link unique names and IDs while ignoring email addresses and ambiguous names', () => {
  const { Store,Mentions }=app();
  Store.state=Store.normalizeState({nodes:[{id:'owner',label:'Owner',notes:'@Alice met @[Bob Smith]. Email user@example.com. @Duplicate @Owner'},{id:'alice',label:'Alice'},{id:'bob',label:'Bob Smith'},{id:'d1',label:'Duplicate'},{id:'d2',label:'Duplicate'}],links:[]});
  const unresolved=Mentions.syncNode(Store.state.nodes[0]);
  assert.deepEqual(plain(Store.state.links.map(l=>l.target)),['alice','bob']);
  assert.deepEqual(plain(unresolved),['@Duplicate']);
  Store.state.nodes[0].notes='@{d2}';Mentions.syncNode(Store.state.nodes[0]);
  assert.deepEqual(plain(Store.state.links.map(l=>l.target)),['d2']);
});

test('automatic reference links update atomically, survive renames and preserve manual links', () => {
  const { Store,Graph }=app();Graph.refresh=()=>{};
  Store.state=Store.normalizeState({nodes:[{id:'a',label:'A'},{id:'b',label:'Bob'}],links:[{id:'manual',source:'a',target:'b',type:'rel'}]});
  Store.updateNode('a',{notes:'@Bob'});assert.equal(Store.state.links.length,2);
  const mentionId=Store.state.links.find(l=>l.autoMention).id;
  Store.updateNode('b',{label:'Robert'});Store.updateNode('a',{notes:'Still @Bob'});
  assert.equal(Store.state.links.find(l=>l.autoMention).id,mentionId);
  Store.updateNode('a',{notes:''});assert.equal(Store.state.links.length,1);assert.equal(Store.state.links[0].id,'manual');
  Store.undo();assert.equal(Store.state.links.length,2);Store.redo();assert.equal(Store.state.links.length,1);
});

test('timeline, sources, saved views and generated links survive JSON round trips', () => {
  const { Store,IO,Views }=app();
  const graph={nodes:[{id:'a',type:'person',timeline:[{id:'t',date:'2020-01-02',title:'Meeting',kind:'action',details:'Met @B'}],sources:[{id:'s',title:'Article',url:'https://example.com/report',date:'2020-01-03',notes:'Evidence'}]},{id:'b',label:'B'}],links:[{id:'m',source:'a',target:'b',type:'mentions',label:'mentions',autoMention:true,meta:{mentionTokens:['@B']}}],savedViews:[{id:'v',name:'People',filters:{types:['person'],tags:['case']},neighbourhood:{rootId:'a',hops:2},camera:{x:2,y:3,zoom:1.5}}]};
  IO.importObject(graph);const exported=IO.payload();IO.importObject(plain(exported));
  assert.deepEqual(plain(Store.state.nodes[0].timeline),graph.nodes[0].timeline);
  assert.deepEqual(plain(Store.state.nodes[0].sources),graph.nodes[0].sources);
  assert.equal(Store.state.links[0].autoMention,true);assert.equal(Store.state.savedViews[0].camera.zoom,1.5);
  assert.equal(Views.neighbourhood,null);
});

test('group dragging applies the same translation and snapping to all selected nodes', () => {
  const { Store,Graph,Selection,Config }=app();
  Store.state=Store.normalizeState({nodes:[{id:'a',x:0,y:0},{id:'b',x:20,y:30},{id:'c',x:40,y:60}],links:[]});
  const rendered=plain(Store.state.nodes);Graph.instance={graphData:()=>({nodes:rendered,links:[]})};Selection.ids=new Set(['a','b']);Selection.show=()=>{};
  rendered[0].x=13;rendered[0].y=7;Selection.drag(rendered[0],{x:13,y:7});
  assert.equal(rendered[1].x,33);assert.equal(rendered[1].y,37);assert.equal(rendered[2].x,40);
  Config.snap.enabled=true;Selection.endDrag(rendered[0]);
  assert.equal(Store.state.nodes[0].x,10);assert.equal(Store.state.nodes[1].x,30);assert.equal(Store.state.nodes[1].y,40);
  assert.equal(Store.state.nodes[1].fx,30);
});

test('snapshot comparison includes node content, edges, areas and saved views', () => {
  const { Recovery }=app();
  const diff=Recovery.diff({nodes:[{id:'a',label:'Before'},{id:'b'}],links:[],areas:[],savedViews:[]},{nodes:[{id:'a',label:'After'},{id:'c'}],links:[{id:'edge'}],areas:[{id:'area'}],savedViews:[{id:'view'}]});
  assert.deepEqual(plain(diff.nodes),{added:['c'],removed:['b'],changed:['a']});
  assert.deepEqual(plain(diff.savedViews.added),['view']);assert.deepEqual(plain(diff.areas.added),['area']);
});

test('source URLs reject executable protocols', () => {
  const { NodeDetails }=app();assert.equal(NodeDetails.safeUrl('javascript:alert(1)'),'');assert.equal(NodeDetails.safeUrl('data:text/html,test'),'');assert.equal(NodeDetails.safeUrl('https://example.com/report'),'https://example.com/report');
});

test('recovery rejects malformed latest data and restores the newest valid automatic backup', async () => {
  const { Recovery }=app();
  Recovery.readAll=async()=>[{key:'latest',savedAt:100,state:{broken:true}},{key:'bad',savedAt:99,automatic:true,state:{nodes:[]}},{key:'good',savedAt:98,automatic:true,state:{nodes:[{id:'a',label:'Recovered'}],links:[]}}];
  const restored=await Recovery.latest();assert.equal(restored.nodes[0].label,'Recovered');
});
