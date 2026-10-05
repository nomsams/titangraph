// Investigation tools. Graph data remains separate from temporary view and selection state.
const Views = {
  filters: { types:[], tags:[], life:'all', linkTypes:[] },
  neighbourhood: null,
  path: null,
  pathNodes: new Set(),
  pathLinks: new Set(),
  pathResult: null,
  normalizeFilters(value = {}) {
    return {
      types:Utils.tags(value.types), tags:Utils.tags(value.tags),
      life:['alive','deceased'].includes(value.life) ? value.life : 'all', linkTypes:Utils.tags(value.linkTypes)
    };
  },
  normalizeSaved(value) {
    return (Array.isArray(value) ? value : []).filter(v=>v && v.name).map(v=>({
      id:String(v.id ?? Utils.uuid()), name:String(v.name), filters:this.normalizeFilters(v.filters),
      neighbourhood:v.neighbourhood?.rootId ? {rootId:String(v.neighbourhood.rootId), hops:Utils.clamp(Number(v.neighbourhood.hops)||1,1,3)} : null,
      camera:v.camera && [v.camera.x,v.camera.y,v.camera.zoom].every(Number.isFinite) ? {x:v.camera.x,y:v.camera.y,zoom:Utils.clamp(v.camera.zoom,0.01,100)} : null
    }));
  },
  adjacency(graph, directed = false) {
    const adjacency = new Map(graph.nodes.map(n=>[n.id,[]]));
    for (const link of graph.links) {
      const s=Utils.endpointId(link.source), t=Utils.endpointId(link.target);
      if (!adjacency.has(s) || !adjacency.has(t)) continue;
      adjacency.get(s).push({id:t,linkId:link.id});
      if (!directed || link.directed === false) adjacency.get(t).push({id:s,linkId:link.id});
    }
    return adjacency;
  },
  neighbours(graph, rootId, hops) {
    const adjacent=this.adjacency(graph), found=new Set();
    if (!adjacent.has(rootId)) return found;
    const queue=[[rootId,0]]; found.add(rootId);
    for(let i=0;i<queue.length;i++) {
      const [id,depth]=queue[i]; if(depth>=hops) continue;
      for(const next of adjacent.get(id)) if(!found.has(next.id)) { found.add(next.id);queue.push([next.id,depth+1]); }
    }
    return found;
  },
  filtered(graph) {
    const f=this.filters;
    let nodes=graph.nodes.filter(n=>
      (!f.types.length || f.types.includes(n.type)) &&
      (!f.tags.length || f.tags.some(tag=>(n.tags || []).some(t=>t.toLowerCase()===tag.toLowerCase()))) &&
      (f.life==='all' || (n.type==='person' && (f.life==='deceased' ? n.deceased : !n.deceased)))
    );
    // Keep the focus node visible as context even when a type/tag filter excludes it.
    if(this.neighbourhood) {
      const root=graph.nodes.find(n=>n.id===this.neighbourhood.rootId);
      if(root && !nodes.some(n=>n.id===root.id)) nodes=[root,...nodes];
    }
    let ids=new Set(nodes.map(n=>n.id));
    let links=graph.links.filter(l=>ids.has(Utils.endpointId(l.source)) && ids.has(Utils.endpointId(l.target)) && (!f.linkTypes.length || f.linkTypes.includes(l.type)));
    if(this.neighbourhood) {
      ids=this.neighbours({nodes,links},this.neighbourhood.rootId,this.neighbourhood.hops);
      nodes=nodes.filter(n=>ids.has(n.id)); links=links.filter(l=>ids.has(Utils.endpointId(l.source))&&ids.has(Utils.endpointId(l.target)));
    }
    return {nodes,links};
  },
  shortestPaths(graph, source, target, directed=false, limit=20) {
    const adjacent=this.adjacency(graph,directed);
    if(!adjacent.has(source)||!adjacent.has(target)) return {paths:[],truncated:false};
    const distance=new Map([[source,0]]), previous=new Map(), queue=[source];
    for(let i=0;i<queue.length;i++) {
      const id=queue[i], depth=distance.get(id);
      if(distance.has(target)&&depth>=distance.get(target)) continue;
      for(const next of adjacent.get(id)) {
        if(!distance.has(next.id)) {distance.set(next.id,depth+1);queue.push(next.id);}
        if(distance.get(next.id)===depth+1) {
          if(!previous.has(next.id)) previous.set(next.id,[]);
          previous.get(next.id).push({id,linkId:next.linkId});
        }
      }
    }
    if(!distance.has(target)) return {paths:[],truncated:false};
    const paths=[], stack=[{id:target,nodes:[target],links:[]}];
    while(stack.length&&paths.length<=limit) {
      const path=stack.pop();
      if(path.id===source) {paths.push({nodes:path.nodes.toReversed(),links:path.links.toReversed()});continue;}
      for(const prev of previous.get(path.id)||[]) stack.push({id:prev.id,nodes:[...path.nodes,prev.id],links:[...path.links,prev.linkId]});
    }
    return {paths:paths.slice(0,limit),truncated:paths.length>limit};
  },
  graphData(graph, degrees) {
    let visible=this.filtered(graph);
    this.pathNodes.clear();this.pathLinks.clear();this.pathResult=null;
    if(this.path) {
      this.pathResult=this.shortestPaths(visible,this.path.source,this.path.target,this.path.directed);
      for(const p of this.pathResult.paths) {p.nodes.forEach(id=>this.pathNodes.add(id));p.links.forEach(id=>this.pathLinks.add(id));}
      if(this.path.only&&this.pathResult.paths.length) visible={nodes:visible.nodes.filter(n=>this.pathNodes.has(n.id)),links:visible.links.filter(l=>this.pathLinks.has(l.id))};
    }
    return {nodes:visible.nodes.map(n=>({...n,_degree:degrees.get(n.id)||0})).sort((a,b)=>a._degree-b._degree),links:visible.links.map(l=>({...l}))};
  },
  apply() { Store.sync();Graph.refresh();Selection.show();this.updateBadge(); },
  reset(refresh=true) {
    this.filters=this.normalizeFilters();this.neighbourhood=null;this.path=null;this.pathNodes.clear();this.pathLinks.clear();
    if(refresh) this.apply();
  },
  focus(id,hops) { this.neighbourhood={rootId:id,hops};this.path=null;this.apply();Graph.fit(); },
  updateBadge() {
    const el=document.getElementById('view-status'); if(!el) return;
    const active=this.filters.types.length||this.filters.tags.length||this.filters.linkTypes.length||this.filters.life!=='all'||this.neighbourhood||this.path;
    el.style.display=active?'block':'none'; if(!active) return;
    const visible=Graph.instance?.graphData().nodes.length ?? Store.state.nodes.length;
    const parts=[`${visible} / ${Store.state.nodes.length} nodes visible`];
    if(this.neighbourhood) parts.push(`${this.neighbourhood.hops}-step neighbourhood of ${Store.state.nodes.find(n=>n.id===this.neighbourhood.rootId)?.label || 'missing node'}`);
    if(this.path) {
      const result=this.pathResult;
      parts.push(result?.paths.length ? `${result.paths.length}${result.truncated?'+':''} shortest path(s), ${result.paths[0].links.length} connection(s)` : 'No path within the current filters');
    }
    el.innerHTML=`<div>${parts.map(Utils.escapeHtml).join('<br>')}</div><div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-sec" onclick="Views.reset()">Show all</button>${this.path?'<button class="btn btn-sec" onclick="Views.path=null;Views.apply()">Clear path</button>':''}<button class="btn btn-sec" onclick="Views.open()">Filters</button></div>`;
  },
  open() {
    const f=this.filters;
    UI.openModal('Filters & Saved Views',()=>`
      <div class="form-row"><label>NODE TYPES (none selected = all)</label><div class="check-grid">${Object.keys(Config.colors).map(t=>`<label><input type="checkbox" name="filter-type" value="${t}" ${f.types.includes(t)?'checked':''}> ${t}</label>`).join('')}</div></div>
      <div class="m-grid"><div class="form-row"><label>TAGS (any match, comma separated)</label><input id="filter-tags" value="${Utils.escapeHtml(f.tags.join(', '))}" placeholder="research, family"></div>
      <div class="form-row"><label>LIFE STATUS</label><select id="filter-life">${['all','alive','deceased'].map(v=>`<option ${f.life===v?'selected':''}>${v}</option>`).join('')}</select></div></div>
      <div class="form-row"><label>CONNECTION TYPES (none selected = all)</label><div class="check-grid">${[...new Set([...Object.keys(Config.linkColors).filter(t=>t!=='default'),...Store.state.links.map(l=>l.type)])].map(t=>`<label><input type="checkbox" name="filter-link" value="${Utils.escapeHtml(t)}" ${f.linkTypes.includes(t)?'checked':''}> ${Utils.escapeHtml(t)}</label>`).join('')}</div></div>
      <div class="form-row"><label>SAVE THIS VIEW</label><div style="display:flex;gap:8px"><input id="view-name" placeholder="View name"><button class="btn" id="view-save">Save</button></div></div>
      <div class="form-row"><label>SAVED VIEWS</label><select id="view-list"><option value="">Choose a view…</option>${(Store.state.savedViews||[]).map(v=>`<option value="${Utils.escapeHtml(v.id)}">${Utils.escapeHtml(v.name)}</option>`).join('')}</select></div>
      <div style="display:flex;gap:8px"><button class="btn btn-sec" id="view-load">Load</button><button class="btn btn-sec" id="view-delete">Delete view</button><button class="btn btn-sec" id="filter-reset">Reset filters</button></div>
    `,close=>{this.filters=this.readForm();this.apply();close();});
    document.getElementById('view-save').onclick=()=>{
      const name=document.getElementById('view-name').value.trim(); if(!name){UI.toast('Name required','Enter a name for the view.');return;}
      const filters=this.readForm(), center=Graph.safeScreenCenterGraphCoords();
      const existing=Store.state.savedViews.find(v=>v.name===name);
      const view={id:existing?.id||Utils.uuid(),name,filters,neighbourhood:this.neighbourhood?{...this.neighbourhood}:null,camera:{...center,zoom:Graph.instance.zoom()}};
      if(existing) Object.assign(existing,view);else Store.state.savedViews.push(view);
      Store.save('View saved');this.filters=filters;this.apply();UI.closeModal();this.open();
    };
    document.getElementById('view-load').onclick=()=>{
      const v=Store.state.savedViews.find(v=>v.id===document.getElementById('view-list').value);if(!v)return;
      this.filters=this.normalizeFilters(v.filters);this.neighbourhood=v.neighbourhood?{...v.neighbourhood}:null;this.path=null;this.apply();
      if(v.camera) {Graph.instance.centerAt(v.camera.x,v.camera.y,300);Graph.instance.zoom(v.camera.zoom,300);}
      UI.closeModal();
    };
    document.getElementById('view-delete').onclick=()=>{Store.state.savedViews=Store.state.savedViews.filter(v=>v.id!==document.getElementById('view-list').value);Store.save('View removed');UI.closeModal();this.open();};
    document.getElementById('filter-reset').onclick=()=>{this.reset();UI.closeModal();};
  },
  readForm() {
    return this.normalizeFilters({types:[...document.querySelectorAll('[name=filter-type]:checked')].map(e=>e.value),tags:document.getElementById('filter-tags').value,life:document.getElementById('filter-life').value,linkTypes:[...document.querySelectorAll('[name=filter-link]:checked')].map(e=>e.value)});
  },
  openPath() {
    const nodes=this.filtered(Store.state).nodes;
    if(nodes.length<2) {UI.toast('Path finder','Show at least two nodes to find a path.');return;}
    const options=id=>nodes.map(n=>`<option value="${Utils.escapeHtml(n.id)}" ${n.id===id?'selected':''}>${Utils.escapeHtml(n.label)} (${Utils.escapeHtml(n.type)})</option>`).join('');
    UI.openModal('Find Paths',()=>`
      <div class="form-row"><label>FROM</label><select id="path-from">${options(this.path?.source||Graph.selectedNode?.id||nodes[0].id)}</select></div>
      <div class="form-row"><label>TO</label><select id="path-to">${options(this.path?.target||nodes[1].id)}</select></div>
      <label class="check-label"><input id="path-directed" type="checkbox" ${this.path?.directed?'checked':''}> Follow arrow direction</label>
      <label class="check-label"><input id="path-only" type="checkbox" ${this.path?.only?'checked':''}> Show only the paths</label>
      <p class="help">Finds up to 20 equally short paths within the current filters. Undirected connections work both ways.</p>
    `,close=>{this.path={source:document.getElementById('path-from').value,target:document.getElementById('path-to').value,directed:document.getElementById('path-directed').checked,only:document.getElementById('path-only').checked};this.apply();Graph.fit();close();});
  }
};

const Selection = {
  ids:new Set(), box:null, suppressClick:false,
  click(n,event) {
    if(event?.ctrlKey||event?.metaKey) {
      if(this.ids.has(n.id)) this.ids.delete(n.id);else this.ids.add(n.id);
      Graph.selectedNode=this.ids.has(n.id)?n:(Store.state.nodes.find(n=>this.ids.has(n.id))||null);
      Graph.selectedLink=null;Graph.linkFrom=null;this.show();return;
    }
    if(!this.ids.has(n.id)||this.ids.size<2) this.ids=new Set([n.id]);
    Graph.selectNode(n,{keepMulti:true});
  },
  show() {
    if(this.ids.size>1) this.inspector();
    else if(Graph.selectedNode) UI.inspNode(Graph.selectedNode);
    else UI.clear();
    UI.stats();
  },
  inspector() {
    const nodes=Store.state.nodes.filter(n=>this.ids.has(n.id));
    document.getElementById('p-cont').innerHTML=`<div class="p-sec"><h3>${nodes.length} nodes selected</h3><p class="help">Drag any selected node to move the group. Ctrl-click to add or remove nodes.</p>
      <div class="form-row"><label>TYPE (optional)</label><select id="bulk-type"><option value="">Keep each type</option>${Object.keys(Config.colors).map(t=>`<option>${t}</option>`).join('')}</select></div>
      <div class="form-row"><label>ADD TAGS</label><input id="bulk-tags" placeholder="Comma separated"></div>
      <div class="form-row"><label>REMOVE TAGS</label><input id="bulk-remove-tags" placeholder="Comma separated"></div>
      <div class="form-row"><label>COLOR (optional)</label><div style="display:flex;gap:10px"><input type="checkbox" id="bulk-use-color" aria-label="Apply color" style="width:auto"><input type="color" id="bulk-color" value="#00ccff"></div></div>
      <button class="btn" onclick="Selection.applyBulk()">Apply changes</button>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-sec" onclick="Selection.pin(true)">Pin all</button><button class="btn btn-sec" onclick="Selection.pin(false)">Unpin all</button></div>
      <div style="margin-top:16px">${nodes.map(n=>`<div class="selection-item">${Utils.escapeHtml(n.label)} <small>${Utils.escapeHtml(n.type)}</small></div>`).join('')}</div>
      <button class="btn btn-danger" style="margin-top:16px" onclick="Selection.delete()">Delete selected nodes</button></div>`;
    document.body.classList.add('insp-open');
  },
  update(up) {
    Store.sync();
    for(const n of Store.state.nodes) if(this.ids.has(n.id)) {
      if(up.type) n.type=up.type;
      if(up.color) n.color=up.color;
      n.tags=Utils.tags([...(n.tags||[]),...Utils.tags(up.addTags)]).filter(t=>!Utils.tags(up.removeTags).includes(t));
      Mentions.syncNode(n);
    }
    Store.save('Selected nodes updated',false);Graph.refresh();this.show();
  },
  applyBulk() {this.update({type:document.getElementById('bulk-type').value,addTags:document.getElementById('bulk-tags').value,removeTags:document.getElementById('bulk-remove-tags').value,color:document.getElementById('bulk-use-color').checked?document.getElementById('bulk-color').value:null});},
  pin(on) {Store.sync();for(const n of Store.state.nodes) if(this.ids.has(n.id)){n.fx=on?n.x:null;n.fy=on?n.y:null;}Store.save('Selection pinning updated',false);Graph.refresh();this.show();},
  delete() {
    Store.sync();Store.state.nodes=Store.state.nodes.filter(n=>!this.ids.has(n.id));
    Store.state.links=Store.state.links.filter(l=>!this.ids.has(Utils.endpointId(l.source))&&!this.ids.has(Utils.endpointId(l.target)));
    Store.save('Selected nodes deleted',false);this.ids.clear();Graph.clearSelection();Graph.refresh();
  },
  drag(n,delta) {
    if(!this.ids.has(n.id)) this.ids=new Set([n.id]);
    for(const other of Graph.instance.graphData().nodes) if(other.id!==n.id&&this.ids.has(other.id)) {other.x+=delta.x;other.y+=delta.y;other.fx=other.x;other.fy=other.y;}
  },
  endDrag(n) {
    const nodes=Graph.instance.graphData().nodes;
    const dx=Config.snap.enabled?Math.round(n.x/Config.snap.step)*Config.snap.step-n.x:0;
    const dy=Config.snap.enabled?Math.round(n.y/Config.snap.step)*Config.snap.step-n.y:0;
    for(const node of nodes) if(node.id===n.id||this.ids.has(node.id)){node.x+=dx;node.y+=dy;node.fx=node.x;node.fy=node.y;}
    Store.save(this.ids.size>1?'Nodes moved':'Node moved');Graph.selectedNode=Store.state.nodes.find(x=>x.id===n.id);Graph.selectedLink=null;this.show();
  },
  attach(canvas) {
    const coords=e=>{const r=canvas.getBoundingClientRect();return Graph.instance.screen2GraphCoords(e.clientX-r.left,e.clientY-r.top);};
    canvas.addEventListener('mousedown',e=>{
      if(e.button!==0||Tools.effective()!=='move'||Graph.hoverNode||Graph.hoverLink)return;
      e.preventDefault();e.stopImmediatePropagation();const p=coords(e);this.box={start:p,end:p,add:e.ctrlKey||e.metaKey};
    },true);
    window.addEventListener('mousemove',e=>{if(this.box)this.box.end=coords(e);});
    window.addEventListener('mouseup',e=>{
      if(!this.box||e.button!==0)return;
      const box=this.box;this.box=null;box.end=coords(e);this.suppressClick=true;
      const moved=Math.hypot(box.end.x-box.start.x,box.end.y-box.start.y)*Graph.instance.zoom()>5;
      if(!box.add)this.ids.clear();
      if(moved) for(const n of Graph.instance.graphData().nodes) if(n.x>=Math.min(box.start.x,box.end.x)&&n.x<=Math.max(box.start.x,box.end.x)&&n.y>=Math.min(box.start.y,box.end.y)&&n.y<=Math.max(box.start.y,box.end.y))this.ids.add(n.id);
      Graph.selectedNode=Store.state.nodes.find(n=>this.ids.has(n.id))||null;Graph.selectedLink=null;Graph.linkFrom=null;this.show();
      setTimeout(()=>{this.suppressClick=false;},0);
    });
    canvas.addEventListener('click',e=>{
      if(this.suppressClick){e.stopImmediatePropagation();this.suppressClick=false;return;}
      if((e.ctrlKey||e.metaKey)&&Tools.effective()==='move'&&Graph.hoverNode){e.preventDefault();e.stopImmediatePropagation();this.click(Graph.hoverNode,e);}
    },true);
  },
  draw(ctx,k) {
    if(!this.box)return;const b=this.box;
    ctx.save();ctx.fillStyle='rgba(0,153,255,0.14)';ctx.strokeStyle='#0099ff';ctx.lineWidth=1/k;
    ctx.fillRect(b.start.x,b.start.y,b.end.x-b.start.x,b.end.y-b.start.y);ctx.strokeRect(b.start.x,b.start.y,b.end.x-b.start.x,b.end.y-b.start.y);ctx.restore();
  }
};

const Mentions = {
  parse(text) {
    const tokens=[];
    const regex=/(^|[\s(])@(?:\[([^\]\n]+)\]|"([^"\n]+)"|\{([^}\n]+)\}|([\p{L}\p{N}_][\p{L}\p{N}_.-]*))/gu;
    for(const m of String(text||'').matchAll(regex)) tokens.push({value:m[2]??m[3]??m[4]??m[5],id:!!m[4],token:m[0].slice(m[1].length)});
    return tokens;
  },
  content(n) {return [n.notes,...(n.tags||[]),...(n.timeline||[]).flatMap(e=>[e.title,e.details]),...(n.sources||[]).map(s=>s.notes)].join('\n');},
  resolve(n) {
    const references=new Map(), unresolved=[];
    const existing=Store.state.links.filter(l=>l.autoMention&&Utils.endpointId(l.source)===n.id);
    for(const ref of this.parse(this.content(n))) {
      let target=Store.state.nodes.find(t=>t.id===ref.value);
      if(!target&&!ref.id) {
        const matches=Store.state.nodes.filter(t=>t.label.toLowerCase()===ref.value.toLowerCase());
        if(matches.length===1)target=matches[0];
        else {
          const previous=existing.find(l=>(l.meta?.mentionTokens||[]).includes(ref.token));
          if(previous)target=Store.state.nodes.find(t=>t.id===Utils.endpointId(previous.target));
        }
      }
      if(!target){unresolved.push(ref.token);continue;}if(target.id===n.id)continue;
      if(!references.has(target.id))references.set(target.id,[]);references.get(target.id).push(ref.token);
    }
    return {references,unresolved};
  },
  syncNode(n) {
    const {references,unresolved}=this.resolve(n);
    Store.state.links=Store.state.links.filter(l=>!l.autoMention||Utils.endpointId(l.source)!==n.id||references.has(Utils.endpointId(l.target)));
    for(const [target,tokens] of references) {
      const old=Store.state.links.find(l=>l.autoMention&&Utils.endpointId(l.source)===n.id&&Utils.endpointId(l.target)===target);
      if(old)old.meta={...old.meta,mentionTokens:tokens};
      else Store.state.links.push({id:Utils.uuid(),source:n.id,target,label:'mentions',type:'mentions',directed:true,dashed:true,color:null,autoMention:true,meta:{mentionTokens:tokens}});
    }
    return unresolved;
  },
  syncAll() {for(const n of Store.state.nodes)this.syncNode(n);},
  attach(input,nodeId) {
    if(!input)return;
    const menu=document.createElement('div');menu.className='mention-menu';menu.hidden=true;input.parentElement.style.position='relative';input.parentElement.append(menu);
    let candidates=[],index=0,start=0,end=0;
    const insert=n=>{
      const unique=Store.state.nodes.filter(t=>t.label.toLowerCase()===n.label.toLowerCase()).length===1;
      const token=unique&&!/[\]\n]/.test(n.label)?`@[${n.label}]`:`@{${n.id}}`;
      input.value=input.value.slice(0,start)+token+' '+input.value.slice(end);
      const caret=start+token.length+1;input.focus();input.setSelectionRange(caret,caret);menu.hidden=true;
      input.dispatchEvent(new Event('change',{bubbles:true}));
    };
    const paint=()=>{
      menu.replaceChildren();candidates.forEach((n,i)=>{
        const button=document.createElement('button');button.type='button';button.className=i===index?'active':'';button.textContent=n.label+' · '+n.type;
        button.onmousedown=e=>{e.preventDefault();insert(n);};menu.append(button);
      });menu.hidden=!candidates.length;
    };
    input.addEventListener('input',()=>{
      const prefix=input.value.slice(0,input.selectionStart),match=prefix.match(/(?:^|\s)@([^\n@]*)$/);
      if(!match||match[1].length>60){menu.hidden=true;return;}
      const query=match[1].replace(/^[\["]/, '').toLowerCase();end=input.selectionStart;start=end-match[1].length-1;index=0;
      candidates=Store.state.nodes.filter(n=>n.id!==nodeId&&n.label.toLowerCase().includes(query)).slice(0,8);paint();
    });
    input.addEventListener('keydown',e=>{
      if(menu.hidden)return;
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();index=(index+(e.key==='ArrowDown'?1:candidates.length-1))%candidates.length;paint();}
      if(e.key==='Enter'){e.preventDefault();e.stopPropagation();insert(candidates[index]);}
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();menu.hidden=true;}
    });
    input.addEventListener('blur',()=>{menu.hidden=true;});
  }
};

const NodeDetails = {
  timeline(value) {
    return (Array.isArray(value)?value:[]).filter(e=>e&&typeof e==='object').map(e=>({id:String(e.id??Utils.uuid()),date:String(e.date??''),title:String(e.title??''),kind:['event','action','milestone'].includes(e.kind)?e.kind:'event',details:String(e.details??e.notes??'')}));
  },
  sources(value) {
    return (Array.isArray(value)?value:[]).filter(s=>s&&typeof s==='object').map(s=>({id:String(s.id??Utils.uuid()),title:String(s.title??''),url:String(s.url??''),date:String(s.date??''),notes:String(s.notes??'')}));
  },
  safeUrl(value) {try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}},
  timelineHtml(n) {
    return `<div class="p-sec" id="node-timeline"><div class="section-title"><b>Timeline</b><button class="btn btn-sec" onclick="NodeDetails.editTimeline(${Utils.jsAttr(n.id)})">Add entry</button></div>
      <div class="form-row"><label>ORDER</label><select id="timeline-order" onchange="NodeDetails.renderTimeline(${Utils.jsAttr(n.id)},this.value)"><option value="asc">Oldest first</option><option value="desc">Newest first</option></select></div><div id="timeline-entries"></div></div>`;
  },
  sourcesHtml(n) {
    return `<div class="p-sec" id="node-sources"><div class="section-title"><b>Sources & Evidence</b><button class="btn btn-sec" onclick="NodeDetails.editSource(${Utils.jsAttr(n.id)})">Add source</button></div>
      ${(n.sources||[]).map(s=>`<article class="detail-card"><b>${Utils.escapeHtml(s.title||'Untitled source')}</b>${s.date?`<small>${Utils.escapeHtml(s.date)}</small>`:''}
      ${this.safeUrl(s.url)?`<a href="${Utils.escapeHtml(this.safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`:s.url?'<small>URL unavailable</small>':''}
      <p>${Utils.escapeHtml(s.notes)}</p><button class="btn btn-sec" onclick="NodeDetails.editSource(${Utils.jsAttr(n.id)},${Utils.jsAttr(s.id)})">Edit</button></article>`).join('')||'<p class="help">Attach a URL or document reference, date and evidence notes.</p>'}</div>`;
  },
  attach(n) {
    this.renderTimeline(n.id);Mentions.attach(document.getElementById('node-notes'),n.id);
    const box=document.getElementById('node-mentions');if(!box)return;
    const {references,unresolved}=Mentions.resolve(n);
    box.innerHTML=[...references.keys()].map(id=>`<button class="btn btn-sec" onclick="Graph.focusNode(${Utils.jsAttr(id)})">@${Utils.escapeHtml(Store.state.nodes.find(n=>n.id===id)?.label)}</button>`).join(' ');
    if(unresolved.length)box.innerHTML+=`<div class="help">Unresolved or ambiguous: ${Utils.escapeHtml(unresolved.join(', '))}. Choose a node from the @ suggestions.</div>`;
  },
  renderTimeline(id,order='asc') {
    const n=Store.state.nodes.find(n=>n.id===id),container=document.getElementById('timeline-entries');if(!n||!container)return;
    const entries=[...(n.timeline||[])].sort((a,b)=>!a.date?(!b.date?0:1):!b.date?-1:(order==='desc'?-1:1)*a.date.localeCompare(b.date));
    container.innerHTML=entries.map(e=>`<article class="detail-card timeline-entry"><small>${Utils.escapeHtml(e.date||'Undated')} · ${Utils.escapeHtml(e.kind)}</small><b>${Utils.escapeHtml(e.title)}</b><p>${Utils.escapeHtml(e.details)}</p><button class="btn btn-sec" onclick="NodeDetails.editTimeline(${Utils.jsAttr(id)},${Utils.jsAttr(e.id)})">Edit</button></article>`).join('')||'<p class="help">Add dated events, actions and milestones for this node.</p>';
  },
  editTimeline(id,entryId=null) {
    const n=Store.state.nodes.find(n=>n.id===id);if(!n)return;
    const entry=(n.timeline||[]).find(e=>e.id===entryId)||{id:Utils.uuid(),date:'',title:'',kind:'event',details:''};
    UI.openModal('Timeline Entry',()=>`
      <div class="m-grid"><div class="form-row"><label>DATE</label><input type="date" id="entry-date" value="${Utils.escapeHtml(entry.date)}"></div><div class="form-row"><label>TYPE</label><select id="entry-kind">${['event','action','milestone'].map(t=>`<option ${entry.kind===t?'selected':''}>${t}</option>`).join('')}</select></div></div>
      <div class="form-row"><label>TITLE</label><input id="entry-title" value="${Utils.escapeHtml(entry.title)}"></div>
      <div class="form-row"><label>DETAILS — use @ to reference nodes</label><textarea id="entry-details">${Utils.escapeHtml(entry.details)}</textarea></div>
      ${entryId?'<button class="btn btn-danger" id="entry-delete">Delete entry</button>':''}
    `,close=>{
      const title=document.getElementById('entry-title').value.trim();if(!title){UI.toast('Title required','Give this timeline entry a title.');return;}
      const updated={...entry,title,date:document.getElementById('entry-date').value,kind:document.getElementById('entry-kind').value,details:document.getElementById('entry-details').value};
      const timeline=[...(n.timeline||[])];const index=timeline.findIndex(e=>e.id===entry.id);if(index>=0)timeline[index]=updated;else timeline.push(updated);
      Store.updateNode(id,{timeline});close();UI.inspNode(Store.state.nodes.find(n=>n.id===id));
    });
    Mentions.attach(document.getElementById('entry-details'),id);
    if(entryId)document.getElementById('entry-delete').onclick=()=>{Store.updateNode(id,{timeline:n.timeline.filter(e=>e.id!==entryId)});UI.closeModal();UI.inspNode(Store.state.nodes.find(n=>n.id===id));};
  },
  editSource(id,sourceId=null) {
    const n=Store.state.nodes.find(n=>n.id===id);if(!n)return;
    const source=(n.sources||[]).find(s=>s.id===sourceId)||{id:Utils.uuid(),title:'',url:'',date:'',notes:''};
    UI.openModal('Source & Evidence',()=>`
      <div class="form-row"><label>TITLE / DOCUMENT REFERENCE</label><input id="source-title" value="${Utils.escapeHtml(source.title)}"></div>
      <div class="form-row"><label>URL (optional)</label><input id="source-url" type="url" placeholder="https://…" value="${Utils.escapeHtml(source.url)}"></div>
      <div class="form-row"><label>DATE (optional)</label><input id="source-date" type="date" value="${Utils.escapeHtml(source.date)}"></div>
      <div class="form-row"><label>EVIDENCE NOTES</label><textarea id="source-notes">${Utils.escapeHtml(source.notes)}</textarea></div>
      ${sourceId?'<button class="btn btn-danger" id="source-delete">Delete source</button>':''}
    `,close=>{
      const title=document.getElementById('source-title').value.trim(),url=document.getElementById('source-url').value.trim();
      if(!title){UI.toast('Title required','Give this source a title or document reference.');return;}
      if(url&&!this.safeUrl(url)){UI.toast('Invalid URL','Use an http or https URL, or leave it empty.');return;}
      const updated={...source,title,url,date:document.getElementById('source-date').value,notes:document.getElementById('source-notes').value};
      const sources=[...(n.sources||[])];const index=sources.findIndex(s=>s.id===source.id);if(index>=0)sources[index]=updated;else sources.push(updated);
      Store.updateNode(id,{sources});close();UI.inspNode(Store.state.nodes.find(n=>n.id===id));
    });
    Mentions.attach(document.getElementById('source-notes'),id);
    if(sourceId)document.getElementById('source-delete').onclick=()=>{Store.updateNode(id,{sources:n.sources.filter(s=>s.id!==sourceId)});UI.closeModal();UI.inspNode(Store.state.nodes.find(n=>n.id===id));};
  }
};

const Recovery = {
  dbPromise:null, queue:Promise.resolve(), lastBackup:0, ready:false,
  async db() {
    if(typeof indexedDB==='undefined')throw new Error('Recovery storage unavailable');
    if(!this.dbPromise)this.dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open('titangraph-recovery',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('records',{keyPath:'key'});
      request.onsuccess=()=>{this.ready=true;resolve(request.result);};request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('Recovery database is blocked by another tab'));
    });
    return this.dbPromise;
  },
  async readAll() {
    const db=await this.db();return new Promise((resolve,reject)=>{const request=db.transaction('records','readonly').objectStore('records').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  },
  async write(records,remove=[]) {
    const db=await this.db();return new Promise((resolve,reject)=>{
      const tx=db.transaction('records','readwrite'),store=tx.objectStore('records');records.forEach(r=>store.put(r));remove.forEach(key=>store.delete(key));
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Recovery save aborted'));
    });
  },
  async latest() {
    try {
      const records=await this.readAll(),latest=records.find(r=>r.key==='latest');
      let localTime=0;try{
        const local=localStorage.getItem(Config.storageKey);
        if(local){this.validate(JSON.parse(local));localTime=Number(localStorage.getItem(Config.storageKey+'_savedAt'))||0;}
      }catch{}
      if(latest&&latest.savedAt>=localTime) {
        try{return this.validate(latest.state);}catch{Logger.log('Latest recovery was invalid; checking automatic backups.','wrn');}
      }
      const backup=records.filter(r=>r.automatic).sort((a,b)=>b.savedAt-a.savedAt).find(r=>{try{this.validate(r.state);return true;}catch{return false;}});
      return backup&&backup.savedAt>=localTime?this.validate(backup.state):null;
    }catch {return null;}
  },
  validate(state) {
    if(!state||!Array.isArray(state.nodes)||!Array.isArray(state.links))throw new Error('Invalid recovery graph');
    return Store.normalizeState(state);
  },
  schedule(state,savedAt=Date.now()) {
    if(!this.ready)return;
    const copy=Utils.copy(state);
    this.queue=this.queue.then(async()=>{
      const latest={key:'latest',state:copy,savedAt};const records=[latest],remove=[];
      if(savedAt-this.lastBackup>=60000) {
        this.lastBackup=savedAt;records.push({key:'auto:'+Utils.uuid(),name:'Automatic recovery',state:copy,savedAt,automatic:true});
        const backups=(await this.readAll()).filter(r=>r.automatic).sort((a,b)=>b.savedAt-a.savedAt);remove.push(...backups.slice(4).map(r=>r.key));
      }
      await this.write(records,remove);
    }).catch(e=>{Logger.log('Recovery save failed: '+e.message,'err');UI.toast('Recovery save failed','Export JSON to keep a backup.',4000);});
  },
  async snapshot(name) {
    Store.sync();await this.queue;
    const record={key:'snapshot:'+Utils.uuid(),name,state:Store.normalizeState(Store.state),savedAt:Date.now(),automatic:false};
    await this.write([record]);return record;
  },
  diff(before,after) {
    const result={};
    for(const key of ['nodes','links','areas','savedViews']) {
      const a=new Map((before[key]||[]).map(v=>[v.id,v])),b=new Map((after[key]||[]).map(v=>[v.id,v]));
      result[key]={added:[...b.keys()].filter(id=>!a.has(id)),removed:[...a.keys()].filter(id=>!b.has(id)),changed:[...b.keys()].filter(id=>a.has(id)&&JSON.stringify(a.get(id))!==JSON.stringify(b.get(id)))};
    }
    return result;
  },
  async open() {
    try {
      await this.queue;const records=(await this.readAll()).filter(r=>r.key!=='latest').sort((a,b)=>b.savedAt-a.savedAt);
      UI.openModal('Snapshots & Recovery',()=>`
        <div class="form-row"><label>NEW CHECKPOINT</label><div style="display:flex;gap:8px"><input id="snapshot-name" placeholder="Checkpoint name"><button class="btn" id="snapshot-save">Save</button></div></div>
        <p class="help">The latest graph is saved automatically in this browser. Automatic recovery keeps five recent checkpoints. Export checkpoints to keep a separate copy.</p>
        <div id="snapshot-list">${records.map((r,i)=>`<article class="detail-card"><b>${Utils.escapeHtml(r.name)}</b><small>${Utils.escapeHtml(new Date(r.savedAt).toLocaleString())}${r.automatic?' · automatic':''}</small><small>${r.state.nodes.length} nodes · ${r.state.links.length} links</small>
          <div class="card-actions"><button class="btn btn-sec" data-snapshot="${i}" data-action="compare">Compare</button><button class="btn btn-sec" data-snapshot="${i}" data-action="restore">Restore</button><button class="btn btn-sec" data-snapshot="${i}" data-action="export">Export</button><button class="btn btn-sec" data-snapshot="${i}" data-action="delete">Delete</button></div><div id="snapshot-diff-${i}"></div></article>`).join('')||'<p class="help">No checkpoints yet.</p>'}</div>
      `,close=>close());
      document.getElementById('snapshot-save').onclick=async()=>{
        const name=document.getElementById('snapshot-name').value.trim();if(!name){UI.toast('Name required','Enter a checkpoint name.');return;}
        try{await this.snapshot(name);UI.closeModal();await this.open();}catch(e){UI.toast('Checkpoint failed',e.message,4000);}
      };
      document.getElementById('snapshot-list').onclick=async e=>{
        const button=e.target.closest('[data-snapshot]');if(!button)return;button.disabled=true;
        const r=records[Number(button.dataset.snapshot)],action=button.dataset.action;
        try {
          if(action==='compare') {
            Store.sync();const diff=this.diff(r.state,Store.normalizeState(Store.state));
            document.getElementById('snapshot-diff-'+button.dataset.snapshot).innerHTML='<p class="help">Changes since this checkpoint:</p>'+Object.entries(diff).map(([key,d])=>{
              const old=new Map((r.state[key]||[]).map(item=>[item.id,item])),current=new Map((Store.state[key]||[]).map(item=>[item.id,item]));
              const details=['added','removed','changed'].flatMap(action=>d[action].map(id=>{
                const item=current.get(id)||old.get(id),name=item.label||item.name||item.text||item.id;
                const fields=action==='changed'?Object.keys(item).filter(field=>JSON.stringify(old.get(id)?.[field])!==JSON.stringify(item[field])).join(', '):'';
                return `${action}: ${name}${fields?' ('+fields+')':''}`;
              }));
              return `<div class="help"><b>${key}: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed</b>${details.slice(0,20).map(line=>`<div>${Utils.escapeHtml(line)}</div>`).join('')}${details.length>20?'<div>More changes…</div>':''}</div>`;
            }).join('');
          }
          if(action==='restore') {await this.snapshot('Before restoring '+r.name);IO.importObject(Utils.copy(r.state));UI.closeModal();UI.toast('Checkpoint restored',r.name,2500);}
          if(action==='export') IO.download(new Blob([JSON.stringify({...r.state,_meta:{app:'TitanGraph',version:Config.version,checkpoint:r.name}},null,2)],{type:'application/json'}),'titan-checkpoint.json');
          if(action==='delete') {await this.write([],[r.key]);UI.closeModal();await this.open();}
        }catch(err){UI.toast('Checkpoint action failed',err.message,4000);}finally{button.disabled=false;}
      };
    }catch(e){UI.toast('Recovery unavailable',e.message+'. JSON export is still available.',4000);}
  }
};
