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
    localStorage:{ getItem(){ return null; }, setItem(){ if (storageFailure) throw new Error('QuotaExceededError'); } }, setTimeout(){}, clearTimeout(){}, console, Blob
  });
  const script = fs.readFileSync(require('node:path').join(__dirname, '../index.html'),'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInContext(script + '\nglobalThis.api = { Store, Graph, Config, Utils, UI, IO, DeathIcons }; Logger.log = () => {};', context);
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
