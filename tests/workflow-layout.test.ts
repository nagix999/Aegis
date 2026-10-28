import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { autoLayout, resolveLayout, nodeDefinitions, knownLayoutKeys, visibleLayoutKey, executionEndpointKey, layoutBounds, zoneFrames, createZoneForNodes, moveZoneLayout, moveZone, moveNodes, nodePort, NODE_WIDTH, NODE_HEIGHT, NODE_ICON_SIZE, NODE_ICON_CENTER_Y, CANVAS_LIMIT, ZONE_HEADER_HEIGHT, ZONE_PADDING, ZONE_MIN_WIDTH, ZONE_MIN_HEIGHT, ZONE_SIZE_LIMIT } from '../lib/workflow-layout.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { configurationFingerprint } from '../lib/workflow-review.ts';
import type { CanvasPositions } from '../lib/workflow-layout';
import type { CanvasZone, FlowControlNode, FlowEdge, Workflow } from '../lib/aegis-types';

function sample(counts:number[]):Workflow{
  const workflow=initialState().workflows[0];const rule=workflow.pre[0].rules[0];
  workflow.pre=counts.map((count,index)=>({id:`g-${index}`,name:`검사 ${index}`,mode:'any',rules:Array.from({length:count},(_,r)=>({...structuredClone(rule),id:`r-${index}-${r}`}))}));workflow.post=[];return workflow;
}
function overlaps(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number}){return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
function noOverlap(workflow:Workflow,positions:CanvasPositions){const nodes=nodeDefinitions(workflow);for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++)assert.equal(overlaps({...positions[nodes[i].key],width:NODE_WIDTH,height:NODE_HEIGHT},{...positions[nodes[j].key],width:NODE_WIDTH,height:NODE_HEIGHT}),false,`${nodes[i].key} overlaps ${nodes[j].key}`);}
function graph(workflow:Workflow,nodes:FlowControlNode[],edges:FlowEdge[]){workflow.graph={version:1,pre:{nodes,edges},post:{nodes:[],edges:[]}};return workflow;}

test('one functional card represents each execution group without automatic visual zones',()=>{
  const workflow=sample([1,4]);const before=structuredClone(workflow);const nodes=nodeDefinitions(workflow);
  assert.deepEqual(nodes.map(node=>node.key),['input','main','output','rule:r-0-0','group:g-1']);
  assert.equal(nodes.find(node=>node.key==='rule:r-0-0')?.kind,'rule');assert.equal(nodes.find(node=>node.key==='group:g-1')?.kind,'group');
  assert.deepEqual(zoneFrames(workflow,autoLayout(workflow)),[]);assert.deepEqual(workflow,before);
});
test('execution endpoints and hidden legacy keys resolve to a single visible card',()=>{
  const workflow=sample([1,3]);assert.equal(executionEndpointKey(workflow,'pre','group:g-0'),'rule:r-0-0');assert.equal(executionEndpointKey(workflow,'pre','group:g-1'),'group:g-1');assert.equal(executionEndpointKey(workflow,'post','group:g-0'),undefined);assert.equal(executionEndpointKey(workflow,'pre','start'),'start');
  assert.equal(visibleLayoutKey(workflow,'group:g-0'),'rule:r-0-0');assert.equal(visibleLayoutKey(workflow,'rule:r-1-2'),'group:g-1');assert.equal(visibleLayoutKey(workflow,'rule:missing'),undefined);
});
test('automatic layout follows execution order and retains hidden aliases without duplicate cards',()=>{
  const workflow=sample([1,12,2]);const before=structuredClone(workflow);const positions=autoLayout(workflow);const keys=['input','rule:r-0-0','group:g-1','group:g-2','main','output'];
  for(let i=1;i<keys.length;i++)assert.ok(positions[keys[i]].x>positions[keys[i-1]].x+NODE_WIDTH);
  assert.equal(new Set(keys.map(key=>nodePort(positions[key],'left').y)).size,1);assert.equal(Object.keys(positions).length,knownLayoutKeys(workflow).length);assert.deepEqual(positions['group:g-0'],positions['rule:r-0-0']);assert.deepEqual(positions['rule:r-1-10'],positions['group:g-1']);assert.deepEqual(workflow,before);noOverlap(workflow,positions);
});
test('compact node ports attach to the icon rather than its label',()=>{
  const p={x:100.25,y:200.5};const left=nodePort(p,'left');const right=nodePort(p,'right');assert.equal(NODE_WIDTH,144);assert.equal(NODE_HEIGHT,112);assert.equal(left.x,p.x+(NODE_WIDTH-NODE_ICON_SIZE)/2);assert.equal(right.x-left.x,NODE_ICON_SIZE);assert.equal(left.y,p.y+NODE_ICON_CENTER_Y);assert.equal(right.y,left.y);
});
test('legacy group anchors and hidden child coordinates survive compact rendering exactly',()=>{
  const workflow=sample([2]);const saved={main:{x:1200.25,y:800.5},'group:g-0':{x:500.25,y:200.5},'rule:r-0-0':{x:12000.25,y:14000.5},'rule:r-0-1':{x:40000,y:40000}};workflow.layout={version:1,positions:{...saved,'rule:deleted':{x:0,y:0}}};const positions=resolveLayout(workflow);
  for(const[key,p]of Object.entries(saved))assert.deepEqual(positions[key],p);assert.equal(positions['rule:deleted'],undefined);assert.equal(nodeDefinitions(workflow).length,4);const bounds=layoutBounds(nodeDefinitions(workflow),positions);assert.ok(bounds.width<2000&&bounds.height<2000,'hidden coordinates must not enlarge the visible canvas');
});
test('singleton rules prefer saved rule coordinates and fall back to a group anchor',()=>{
  const workflow=sample([1]);workflow.layout={version:1,positions:{'group:g-0':{x:300.25,y:200.5},'rule:r-0-0':{x:700.25,y:500.5}}};assert.deepEqual(resolveLayout(workflow)['rule:r-0-0'],{x:700.25,y:500.5});delete workflow.layout.positions['rule:r-0-0'];assert.deepEqual(resolveLayout(workflow)['rule:r-0-0'],{x:300.25,y:200.5});
});
test('a compound card without an anchor starts near its saved children',()=>{
  const workflow=sample([2]);workflow.layout={version:1,positions:{'rule:r-0-0':{x:600,y:400},'rule:r-0-1':{x:1000,y:600}}};const p=resolveLayout(workflow);assert.deepEqual(p['group:g-0'],{x:800,y:500});assert.deepEqual(p['rule:r-0-0'],{x:600,y:400});assert.deepEqual(p['rule:r-0-1'],{x:1000,y:600});
});
test('empty visual zones retain stored geometry and are placed away from existing content',()=>{
  const workflow=sample([]);const positions=autoLayout(workflow);const first=createZoneForNodes(workflow,[],{id:'empty',name:'업무 구역',color:'blue'});assert.deepEqual(first.nodeKeys,[]);assert.equal(first.width,360);assert.equal(first.height,240);
  for(const node of nodeDefinitions(workflow))assert.equal(overlaps(first,{...positions[node.key],width:NODE_WIDTH,height:NODE_HEIGHT}),false);
  workflow.layout={version:1,positions,zones:[first]};const [frame]=zoneFrames(workflow,positions);assert.deepEqual(frame,{...first,key:'zone:empty'});
  const second=createZoneForNodes(workflow,[],{id:'second'});assert.equal(overlaps(first,second),false);assert.deepEqual(createZoneForNodes(workflow,[],{id:'second'}),second);
});
test('visual zones wrap moved members and canonicalize hidden membership only once',()=>{
  const workflow=sample([1,3]);const positions=autoLayout(workflow);positions['rule:r-0-0']={x:0,y:0};positions['group:g-1']={x:1200,y:900};const zone:CanvasZone={id:'review',name:'검토',color:'violet',nodeKeys:['group:g-0','rule:r-0-0','rule:r-1-1','group:g-1','rule:deleted'],x:100,y:100,width:300,height:200};workflow.layout={version:1,positions,zones:[zone]};const [frame]=zoneFrames(workflow,positions);
  assert.deepEqual(frame.nodeKeys,['rule:r-0-0','group:g-1']);assert.equal(frame.x,-ZONE_PADDING);assert.equal(frame.y,-ZONE_HEADER_HEIGHT-ZONE_PADDING);assert.ok(frame.x+frame.width>=1200+NODE_WIDTH+ZONE_PADDING&&frame.y+frame.height>=900+NODE_HEIGHT+ZONE_PADDING);assert.deepEqual(workflow.layout.zones,[zone]);const bounds=layoutBounds(nodeDefinitions(workflow),positions,[frame]);assert.ok(frame.x+bounds.offsetX>=8&&frame.y+bounds.offsetY>=8);
});
test('grouping distant nodes stays within the savable zone size limit',()=>{
  const workflow=sample([]);workflow.layout={version:1,positions:{input:{x:0,y:0},main:{x:20000,y:20000},output:{x:40000,y:40000}}};const zone=createZoneForNodes(workflow,['input','output'],{id:'wide'});assert.ok(zone.width>=40000+NODE_WIDTH&&zone.width<=ZONE_SIZE_LIMIT);assert.ok(zone.height>=40000+NODE_HEIGHT&&zone.height<=ZONE_SIZE_LIMIT);assert.ok(zone.width>=ZONE_MIN_WIDTH&&zone.height>=ZONE_MIN_HEIGHT);workflow.layout.zones=[zone];const [frame]=zoneFrames(workflow,workflow.layout.positions);assert.ok(frame.x+frame.width>=40000+NODE_WIDTH&&frame.y+frame.height>=40000+NODE_HEIGHT);
});
test('zone movement preserves fractional member offsets and clamps the entire selection',()=>{
  const positions={input:{x:10.25,y:20.5},main:{x:200.25,y:400.5},output:{x:700,y:900}};const zones:CanvasZone[]=[{id:'z',name:'그룹',color:'slate',nodeKeys:['input','main'],x:0,y:10,width:500,height:600}];const original=structuredClone({positions,zones});const moved=moveZoneLayout(positions,zones,'z',{x:100.5,y:200.25});assert.equal(moved.positions.input.x-moved.zones[0].x,positions.input.x-zones[0].x);assert.equal(moved.positions.main.y-moved.positions.input.y,positions.main.y-positions.input.y);assert.deepEqual(moved.positions.output,positions.output);assert.deepEqual({positions,zones},original);
  const low=moveZoneLayout(positions,zones,'z',{x:-10000,y:-10000});assert.equal(low.zones[0].x,0);assert.equal(low.zones[0].y,0);const high=moveZoneLayout(positions,zones,'z',{x:100000,y:100000});assert.equal(high.positions.main.x,CANVAS_LIMIT);assert.equal(high.positions.main.y,CANVAS_LIMIT);assert.equal(high.positions.main.x-high.positions.input.x,positions.main.x-positions.input.x);
});
test('moving an empty zone leaves every node position unchanged',()=>{
  const workflow=sample([]);const positions=autoLayout(workflow);const zone=createZoneForNodes(workflow,[],{id:'empty'});const moved=moveZoneLayout(positions,[zone],'empty',{x:100,y:200});assert.deepEqual(moved.positions,positions);assert.equal(moved.zones[0].x,zone.x+100);assert.equal(moved.zones[0].y,zone.y+200);
});
test('visual grouping and movement leave execution evidence unchanged',async()=>{
  const state=initialState();const workflow=state.workflows[0];const before=structuredClone(workflow);const fingerprint=await configurationFingerprint(workflow,state.connections);const zone=createZoneForNodes(workflow,['input','main'],{id:'display-only'});workflow.layout={version:1,positions:autoLayout(workflow),zones:[zone]};const moved=moveZone(workflow,'display-only',{x:100,y:200});assert.equal(await configurationFingerprint(moved,state.connections),fingerprint);assert.deepEqual(moved.pre,before.pre);assert.deepEqual(moved.post,before.post);assert.deepEqual(moved.graph,before.graph);assert.deepEqual(workflow.layout.zones,[zone]);
});
test('graph branches use compact functional endpoints and join on a shared icon axis',()=>{
  const workflow=sample([1,12]);graph(workflow,[{id:'fork',kind:'fork',name:'병렬'},{id:'join',kind:'join',name:'합류'}],[{id:'start',from:'start',to:'control:fork'},{id:'a',from:'control:fork',to:'group:g-0'},{id:'b',from:'control:fork',to:'group:g-1'},{id:'aj',from:'group:g-0',to:'control:join'},{id:'bj',from:'group:g-1',to:'control:join'},{id:'end',from:'control:join',to:'end'}]);const p=autoLayout(workflow);const a=p['rule:r-0-0'];const b=p['group:g-1'];assert.equal(a.x,b.x);assert.notEqual(a.y,b.y);assert.ok(p['control:fork'].x+NODE_WIDTH<a.x&&b.x+NODE_WIDTH<p['control:join'].x);assert.equal(nodePort(p['control:join'],'left').y,(nodePort(a,'right').y+nodePort(b,'right').y)/2);noOverlap(workflow,p);
});
test('incomplete and cyclic graph drafts remain deterministic and visible',()=>{
  const workflow=sample([1,2]);graph(workflow,[{id:'a',kind:'condition',name:'조건'},{id:'b',kind:'join',name:'합류'}],[{id:'ab',from:'control:a',to:'control:b'},{id:'ba',from:'control:b',to:'control:a'},{id:'missing',from:'group:unknown',to:'end'}]);const p=autoLayout(workflow);assert.deepEqual(autoLayout(workflow),p);for(const node of nodeDefinitions(workflow))assert.ok(Number.isFinite(p[node.key].x)&&Number.isFinite(p[node.key].y));noOverlap(workflow,p);
});
test('36 groups per stage retain 963 known positions while displaying 99 functional cards',()=>{
  const workflow=sample([]);const rule=initialState().workflows[0].pre[0].rules[0];workflow.graph={version:1,pre:{nodes:[],edges:[]},post:{nodes:[],edges:[]}};
  for(const stage of ['pre','post']as const){workflow[stage]=Array.from({length:36},(_,i)=>({id:`${stage}-g-${i}`,name:'검사 조합',mode:'any',rules:Array.from({length:12},(_,r)=>({...structuredClone(rule),id:`${stage}-r-${i}-${r}`}))}));const g=workflow.graph[stage];let prior='start';for(let block=0;block<6;block++){const fork=`${stage}-f-${block}`;const join=`${stage}-j-${block}`;g.nodes.push({id:fork,kind:'fork',name:'병렬'},{id:join,kind:'join',name:'합류'});g.edges.push({id:`${stage}-${block}-start`,from:prior,to:`control:${fork}`});for(let branch=0;branch<2;branch++){let from=`control:${fork}`;for(let step=0;step<3;step++){const to=`group:${stage}-g-${block*6+branch*3+step}`;g.edges.push({id:`${stage}-${block}-${branch}-${step}`,from,to});from=to;}g.edges.push({id:`${stage}-${block}-${branch}-join`,from,to:`control:${join}`});}prior=`control:${join}`;}g.edges.push({id:`${stage}-end`,from:prior,to:'end'});}
  const p=autoLayout(workflow);const nodes=nodeDefinitions(workflow);assert.equal(knownLayoutKeys(workflow).length,963);assert.equal(Object.keys(p).length,963);assert.equal(nodes.length,99);noOverlap(workflow,p);const bounds=layoutBounds(nodes,p);for(const node of nodes){const at=p[node.key];assert.ok(at.x>=0&&at.x<=CANVAS_LIMIT&&at.y>=0&&at.y<=CANVAS_LIMIT);assert.ok(at.x+NODE_WIDTH+bounds.offsetX<=bounds.width&&at.y+NODE_HEIGHT+bounds.offsetY<=bounds.height);}
});
test('moving one functional card does not move hidden legacy siblings',()=>{
  const positions={'group:legacy':{x:20,y:20},'rule:hidden':{x:1000,y:1200},main:{x:300,y:200}};const moved=moveNodes(positions,['group:legacy'],{x:-100,y:-100});assert.deepEqual(moved['group:legacy'],{x:0,y:0});assert.deepEqual(moved['rule:hidden'],positions['rule:hidden']);assert.deepEqual(moved.main,positions.main);
});

test('long serial flows fold into readable rows while preserving flow order and hidden aliases',()=>{
  const workflow=sample(Array(16).fill(1)),before=structuredClone(workflow),positions=autoLayout(workflow);
  const ordered=['input',...workflow.pre.map(group=>`rule:${group.rules[0].id}`),'main','output'];
  assert.ok(new Set(ordered.map(key=>positions[key].y)).size>1,'a long chain should use more than one row');
  for(let index=1;index<ordered.length;index++){
    const previous=positions[ordered[index-1]],next=positions[ordered[index]];
    assert.ok(next.y>previous.y||next.y===previous.y&&next.x>previous.x+NODE_WIDTH,'rows must follow the real serial order');
  }
  assert.deepEqual(autoLayout(workflow),positions);assert.deepEqual(workflow,before);noOverlap(workflow,positions);
});
test('layout adapts to the available overview shape instead of stretching every flow horizontally',()=>{
  const workflow=sample(Array(16).fill(1));
  const tall=autoLayout(workflow,{width:600,height:1200}),wide=autoLayout(workflow,{width:2000,height:300});
  const tallBounds=layoutBounds(nodeDefinitions(workflow),tall),wideBounds=layoutBounds(nodeDefinitions(workflow),wide);
  assert.ok(tallBounds.width<wideBounds.width);assert.ok(tallBounds.height>wideBounds.height);
  assert.deepEqual(autoLayout(workflow,{width:Number.NaN,height:0}),autoLayout(workflow));
  noOverlap(workflow,tall);noOverlap(workflow,wide);
});
test('a compact contiguous area stays together at a nearby row boundary when it fits',()=>{
  const workflow=sample(Array(16).fill(1));
  const members=Array.from({length:6},(_,index)=>`rule:r-${index+4}-0`);
  workflow.layout={version:1,positions:{},zones:[{id:'area',name:'검토',color:'slate',nodeKeys:members,x:0,y:0,width:240,height:160}]};
  const positions=autoLayout(workflow),before=structuredClone(workflow);
  assert.equal(new Set(members.map(key=>positions[key].y)).size,1);
  assert.deepEqual(workflow,before);noOverlap(workflow,positions);
});
test('both maximum serial stages fit an overview at a larger scale than a single unbroken row',()=>{
  const workflow=sample(Array(36).fill(1));
  workflow.post=workflow.pre.map((group,index)=>({...structuredClone(group),id:`post-g-${index}`,rules:group.rules.map(rule=>({...rule,id:`post-${rule.id}`}))}));
  const positions=autoLayout(workflow),nodes=nodeDefinitions(workflow),bounds=layoutBounds(nodes,positions);
  const fullRow:CanvasPositions=Object.fromEntries(nodes.map((node,index)=>[node.key,{x:48+index*(NODE_WIDTH+64),y:48}]));
  const fullBounds=layoutBounds(nodes,fullRow);
  const fit=(size:{width:number;height:number})=>Math.min(1000/size.width,640/size.height);
  assert.ok(fit(bounds)>fit(fullBounds)*2,'folding should improve the geometric whole-flow fit');
  assert.ok(bounds.width/bounds.height>1&&bounds.width/bounds.height<2.5);
  assert.equal(Object.keys(positions).length,knownLayoutKeys(workflow).length);
  for(const node of nodes)assert.ok(positions[node.key].x<=CANVAS_LIMIT&&positions[node.key].y<=CANVAS_LIMIT);
  noOverlap(workflow,positions);
});
