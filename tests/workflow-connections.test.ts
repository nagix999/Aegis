import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {applyConnection,captureInsertTarget,connectionImpact,getConnectionProblems,insertCheckOnEdge,previewConnection} from '../lib/workflow-connections.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {createStageGraph,validateWorkflowGraph} from '../lib/workflow-graph.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {NODE_HEIGHT,NODE_WIDTH,nodeDefinitions,resolveLayout} from '../lib/workflow-layout.ts';
import type {FlowEdge,RuleGroup,Workflow} from '../lib/aegis-types';

function group(id:string):RuleGroup{return{id,name:id,mode:'any',rules:[{id:`${id}-rule`,name:`${id} 검사`,description:'',kind:'length',enabled:true,config:{maxLength:4000}}]};}
function fixture():Workflow {
  const workflow=structuredClone(initialState().workflows[0]);
  workflow.pre=[group('alpha'),group('beta')];workflow.post=[group('post-only')];delete workflow.graph;
  workflow.layout={version:1,positions:{input:{x:0,y:0},'rule:alpha-rule':{x:250,y:300},main:{x:900,y:300}},zones:[{id:'zone-1',name:'시각 구역',color:'blue',nodeKeys:['rule:alpha-rule'],x:200,y:200,width:600,height:400}]};
  return workflow;
}
function branchFixture():Workflow {
  const workflow=fixture();workflow.pre=[group('left'),group('right')];
  workflow.graph={version:1,pre:{nodes:[{id:'choice',name:'조건',kind:'condition',condition:{operator:'contains',value:'배송'}},{id:'merge',name:'합류',kind:'join'}],edges:[
    {id:'entry',from:'start',to:'control:choice'},
    {id:'yes',from:'control:choice',to:'group:left',port:'true'},
    {id:'no',from:'control:choice',to:'group:right',port:'false'},
    {id:'left-merge',from:'group:left',to:'control:merge'},
    {id:'right-merge',from:'group:right',to:'control:merge'},
    {id:'exit',from:'control:merge',to:'end'},
  ]},post:createStageGraph(workflow.post)};
  return workflow;
}
function forkFixture():Workflow {
  const workflow=branchFixture();workflow.graph!.pre.nodes[0]={id:'choice',name:'병렬 시작',kind:'fork'};
  workflow.graph!.pre.edges=workflow.graph!.pre.edges.map(edge=>edge.from==='control:choice'?{...edge,port:'next'}:edge);
  return workflow;
}

test('insertion opts implicit serial graphs in without changing other stages, original data or visual zones',()=>{
  const workflow=fixture();const original=structuredClone(workflow);const inserted=group('new-check');
  const target=captureInsertTarget(workflow,'pre','serial-1');
  const result=insertCheckOnEdge(workflow,target,inserted,{x:40000,y:0});
  assert.deepEqual(workflow,original);assert.equal(workflow.graph,undefined);
  assert.deepEqual(result.pre.map(item=>item.id),['new-check','alpha','beta']);
  assert.deepEqual(result.graph!.post,createStageGraph(original.post));
  assert.equal(result.graph!.pre.edges[0].id,'serial-1');assert.equal(result.graph!.pre.edges[0].port,'next');
  assert.deepEqual(result.graph!.pre.edges.map(edge=>[edge.from,edge.to]),[['start','group:new-check'],['group:new-check','group:alpha'],['group:alpha','group:beta'],['group:beta','end']]);
  assert.deepEqual(result.layout!.zones,original.layout!.zones);assert.deepEqual(result.layout!.positions['rule:alpha-rule'],original.layout!.positions['rule:alpha-rule']);
  assert.deepEqual(result.layout!.positions['rule:new-check-rule'],{x:40000,y:0});
  assert.equal(result.layout!.positions['group:new-check'],undefined);assert.deepEqual(validateWorkflowGraph(result),[]);
  result.layout!.zones![0].name='별도 변경';result.pre[0].rules[0].name='복사된 규칙';
  assert.deepEqual(workflow,original);assert.equal(inserted.rules[0].name,'new-check 검사');
});

test('inserting on a true or false edge preserves that edge ID and port and leaves the other branch untouched',()=>{
  for(const branch of ['yes','no']){
    const workflow=branchFixture();const before=structuredClone(workflow);const target=captureInsertTarget(workflow,'pre',branch);
    const result=insertCheckOnEdge(workflow,target,group(`insert-${branch}`));
    const incoming=result.graph!.pre.edges.find(edge=>edge.id===branch)!;
    assert.equal(incoming.from,target.from);assert.equal(incoming.to,`group:insert-${branch}`);assert.equal(incoming.port,target.port);
    const outgoing=result.graph!.pre.edges.find(edge=>edge.from===`group:insert-${branch}`)!;
    assert.equal(outgoing.to,target.to);assert.equal(outgoing.port,'next');assert.notEqual(outgoing.id,branch);
    for(const edge of before.graph!.pre.edges.filter(edge=>edge.id!==branch))assert.deepEqual(result.graph!.pre.edges.find(item=>item.id===edge.id),edge);
    assert.deepEqual(result.graph!.post,before.graph!.post);assert.deepEqual(workflow,before);assert.deepEqual(validateWorkflowGraph(result),[]);
  }
});

test('captured edges reject stale destinations, sources, ports, missing IDs and another empty workflow atomically',()=>{
  const workflow=branchFixture();const target=captureInsertTarget(workflow,'pre','yes');
  for(const mutation of [
    (edge:FlowEdge)=>{edge.to='control:merge';},
    (edge:FlowEdge)=>{edge.from='start';edge.port='next';},
    (edge:FlowEdge)=>{edge.port='false';},
  ]){
    const changed=structuredClone(workflow);mutation(changed.graph!.pre.edges.find(edge=>edge.id==='yes')!);const before=structuredClone(changed);
    assert.throws(()=>insertCheckOnEdge(changed,target,group('new-check')));assert.deepEqual(changed,before);
  }
  const missing=structuredClone(workflow);missing.graph!.pre.edges=missing.graph!.pre.edges.filter(edge=>edge.id!=='yes');const before=structuredClone(missing);
  assert.throws(()=>insertCheckOnEdge(missing,target,group('new-check')));assert.deepEqual(missing,before);
  const empty=fixture();empty.pre=[];empty.post=[];const captured=captureInsertTarget(empty,'pre','serial-1');
  const other={...structuredClone(empty),id:'different-workflow'};
  assert.throws(()=>insertCheckOnEdge(other,captured,group('new-check')),/워크플로우/);
});

test('insertion rejects duplicate node IDs, invalid coordinates, a required branch-only check and exhausted capacity',()=>{
  const workflow=branchFixture();const target=captureInsertTarget(workflow,'pre','yes');const before=structuredClone(workflow);
  for(const incoming of [group('left'),{...group('new-check'),id:'choice'}, {...group('new-check'),rules:[group('left').rules[0]]}, {...group('new-check'),required:true}])assert.throws(()=>insertCheckOnEdge(workflow,target,incoming));
  for(const position of [{x:-1,y:0},{x:40001,y:0},{x:0,y:Infinity},{x:NaN,y:0}])assert.throws(()=>insertCheckOnEdge(workflow,target,group('new-check'),position));
  assert.deepEqual(workflow,before);
  const full=fixture();full.pre=Array.from({length:36},(_,index)=>group(`capacity-${index}`));
  assert.throws(()=>insertCheckOnEdge(full,captureInsertTarget(full,'pre','serial-1'),group('extra')),/36/);
  const edgeFull=fixture();edgeFull.graph={version:1,pre:createStageGraph(edgeFull.pre),post:createStageGraph(edgeFull.post)};
  while(edgeFull.graph.pre.edges.length<64)edgeFull.graph.pre.edges.push({id:`draft-${edgeFull.graph.pre.edges.length}`,from:'start',to:'group:alpha',port:'next'});
  const edgeTarget=captureInsertTarget(edgeFull,'pre','serial-1');
  assert.throws(()=>insertCheckOnEdge(edgeFull,edgeTarget,group('extra')),/64/);
});

test('connection preview identifies the actual replaced edge and preserves incomplete rewire drafts with warnings',()=>{
  const workflow=fixture();const before=structuredClone(workflow);
  const preview=previewConnection(workflow,'pre','group:alpha','end');
  assert.equal(preview.valid,true);assert.equal(preview.replace,true);assert.equal(preview.existingEdge?.id,'serial-2');
  assert.equal(preview.changes?.before?.to,'group:beta');assert.equal(preview.changes?.after.to,'end');
  assert.ok(preview.changes!.warnings.length>0);assert.ok(preview.changes!.validationMessages.length>0);
  const result=applyConnection(workflow,'pre','group:alpha','end');
  assert.deepEqual(result.graph!.pre.edges.find(edge=>edge.id==='serial-2'),preview.changes!.after);
  assert.deepEqual(result.graph!.post,createStageGraph(workflow.post));assert.deepEqual(result.layout,workflow.layout);
  assert.ok(validateWorkflowGraph(result).length>0);assert.deepEqual(workflow,before);
});

test('self, cross-stage, wrong port, cycles, duplicate connections and forbidden endpoint directions are rejected without mutation',()=>{
  const workflow=fixture();const before=structuredClone(workflow);
  for(const [from,to,port] of [
    ['group:alpha','group:alpha',undefined],['group:alpha','group:post-only',undefined],['group:alpha','group:beta','true'],
    ['group:beta','group:alpha',undefined],['group:alpha','group:beta',undefined],['end','group:alpha',undefined],['group:alpha','start',undefined],['missing','end',undefined],
  ] as const){
    const preview=previewConnection(workflow,'pre',from,to,port);assert.equal(preview.valid,false,`${from} -> ${to}`);assert.ok(preview.reason);
    assert.throws(()=>applyConnection(workflow,'pre',from,to,port));
  }
  const branch=branchFixture();assert.equal(previewConnection(branch,'pre','control:choice','group:left','next').valid,false);
  assert.deepEqual(workflow,before);
});

test('condition rewiring affects only the requested port and previews an occupied input instead of silently removing another edge',()=>{
  const workflow=branchFixture();const before=structuredClone(workflow);
  const preview=previewConnection(workflow,'pre','control:choice','group:right','true');
  assert.equal(preview.valid,true);assert.equal(preview.existingEdge?.id,'yes');assert.equal(preview.changes?.after.port,'true');
  assert.ok(preview.changes!.warnings.length>0);assert.ok(preview.changes!.validationMessages.length>0);
  const result=applyConnection(workflow,'pre','control:choice','group:right','true');
  assert.deepEqual(result.graph!.pre.edges.find(edge=>edge.id==='no'),before.graph!.pre.edges.find(edge=>edge.id==='no'));
  assert.equal(result.graph!.pre.edges.find(edge=>edge.id==='yes')!.to,'group:right');assert.deepEqual(workflow,before);
});

test('fork previews add distinct targets with stable IDs, preserve existing edges and reject a fifth branch',()=>{
  const workflow=forkFixture();workflow.pre.push(group('third'),group('fourth'),group('fifth'));const before=structuredClone(workflow);
  const preview=previewConnection(workflow,'pre','control:choice','group:third');
  assert.equal(preview.valid,true);assert.equal(preview.replace,false);assert.equal(preview.existingEdge,undefined);assert.equal(preview.changes!.before,null);
  assert.deepEqual(previewConnection(workflow,'pre','control:choice','group:third'),preview);
  const third=applyConnection(workflow,'pre','control:choice','group:third');
  assert.ok(third.graph!.pre.edges.some(edge=>edge.id===preview.changes!.after.id));
  for(const edge of before.graph!.pre.edges)assert.deepEqual(third.graph!.pre.edges.find(item=>item.id===edge.id),edge);
  assert.equal(previewConnection(third,'pre','control:choice','group:third').valid,false);
  const fourth=applyConnection(third,'pre','control:choice','group:fourth');
  assert.equal(fourth.graph!.pre.edges.filter(edge=>edge.from==='control:choice').length,4);
  assert.equal(previewConnection(fourth,'pre','control:choice','group:fifth').valid,false);assert.deepEqual(workflow,before);
});

test('ambiguous outgoing slots are rejected and required-path validation remains visible on editable drafts',()=>{
  const workflow=fixture();workflow.pre[0].required=true;
  const preview=previewConnection(workflow,'pre','start','group:beta');
  assert.equal(preview.valid,true);assert.ok(preview.changes!.validationMessages.some(message=>message.includes('필수')));
  const ambiguous=fixture();ambiguous.graph={version:1,pre:createStageGraph(ambiguous.pre),post:createStageGraph(ambiguous.post)};
  ambiguous.graph.pre.edges.push({id:'second-output',from:'group:alpha',to:'end',port:'next'});
  assert.equal(previewConnection(ambiguous,'pre','group:alpha','group:beta').valid,false);
});

test('insertion in a short straight gap finds free nearby space without moving existing visible cards or hidden coordinates',()=>{
  const workflow=fixture();delete workflow.layout;
  const base=resolveLayout(workflow);const start=base.input;const target=base['rule:alpha-rule'];
  const gap=target.x-(start.x+NODE_WIDTH);
  assert.ok(gap>0&&gap<NODE_WIDTH,'ordinary compact spacing is narrower than a full new card');
  const preferred={x:(start.x+target.x)/2,y:(start.y+target.y)/2};
  workflow.layout={version:1,positions:{'group:alpha':{x:1234,y:3456}},zones:[]};
  // Preserve this legacy coordinate while anchoring all currently visible cards.
  const before=resolveLayout(workflow);const midpoint={x:(before.input.x+before['rule:alpha-rule'].x)/2,y:before['rule:alpha-rule'].y};
  const inserted=insertCheckOnEdge(workflow,captureInsertTarget(workflow,'pre','serial-1'),group('gap-check'),midpoint);
  const placed=inserted.layout!.positions['rule:gap-check-rule'];
  for(const node of nodeDefinitions(workflow)){
    assert.deepEqual(inserted.layout!.positions[node.key],before[node.key]);
    const old=before[node.key];
    const overlaps=placed.x<old.x+NODE_WIDTH&&placed.x+NODE_WIDTH>old.x&&placed.y<old.y+NODE_HEIGHT&&placed.y+NODE_HEIGHT>old.y;
    assert.equal(overlaps,false,`new card overlaps ${node.key}`);
  }
  assert.deepEqual(inserted.layout!.positions['group:alpha'],{x:1234,y:3456});assert.deepEqual(inserted.layout!.zones,[]);
  // The ordinary auto-layout gap itself is too narrow and must also be handled.
  const plain=fixture();delete plain.layout;
  const plainInserted=insertCheckOnEdge(plain,captureInsertTarget(plain,'pre','serial-1'),group('plain-gap'),preferred);
  const fresh=plainInserted.layout!.positions['rule:plain-gap-rule'];assert.notDeepEqual(fresh,preferred);
  for(const node of nodeDefinitions(plain)){const old=base[node.key];assert.deepEqual(plainInserted.layout!.positions[node.key],old);assert.equal(fresh.x<old.x+NODE_WIDTH&&fresh.x+NODE_WIDTH>old.x&&fresh.y<old.y+NODE_HEIGHT&&fresh.y+NODE_HEIGHT>old.y,false);}
});

test('connection impact identifies the removed route, unreachable successor and occupied destination before applying',()=>{
  const workflow=fixture(),before=structuredClone(workflow);
  const preview=previewConnection(workflow,'pre','group:alpha','end');
  const impact=preview.changes!.impact;
  assert.deepEqual(impact.removedEdges,[{id:'serial-2',from:'group:alpha',to:'group:beta',port:'next'}]);
  assert.equal(impact.addedEdges[0].to,'end');
  assert.ok(impact.problems.some(problem=>problem.endpoint==='group:beta'&&problem.kind==='unreachable'&&problem.introduced));
  assert.ok(impact.problems.some(problem=>problem.endpoint==='group:beta'&&problem.kind==='incoming'&&problem.introduced&&problem.suggestion));
  assert.ok(impact.problems.some(problem=>problem.endpoint==='end'&&problem.kind==='incoming'&&problem.introduced));
  assert.deepEqual(new Set(impact.affectedEndpoints),new Set(['group:alpha','group:beta','end']));
  impact.removedEdges[0].to='changed-in-preview';impact.problems[0].message='changed-in-preview';
  assert.deepEqual(workflow,before);
});

test('impact distinguishes existing incomplete wiring from problems introduced by the proposed change',()=>{
  const workflow=fixture();workflow.graph={version:1,pre:createStageGraph(workflow.pre),post:createStageGraph(workflow.post)};
  workflow.graph.pre.edges=workflow.graph.pre.edges.filter(edge=>edge.id!=='serial-2');
  const impact=previewConnection(workflow,'pre','start','end').changes!.impact;
  assert.ok(impact.problems.some(problem=>problem.endpoint==='group:beta'&&problem.kind==='unreachable'&&!problem.introduced));
  assert.ok(impact.problems.some(problem=>problem.endpoint==='group:alpha'&&problem.kind==='unreachable'&&problem.introduced));
  assert.ok(!impact.problems.some(problem=>problem.endpoint==='start'&&problem.kind==='dead_end'));
});

test('fork retarget impact compares against the original graph and preserves the other branch',()=>{
  const workflow=forkFixture(),before=structuredClone(workflow),old=workflow.graph!.pre.edges.find(edge=>edge.id==='yes')!;
  const impact=connectionImpact(workflow,'pre',[old],[{...old,to:'end'}]);
  assert.equal(impact.removedEdges[0].to,'group:left');assert.equal(impact.addedEdges[0].port,'next');
  assert.ok(impact.problems.some(problem=>problem.endpoint==='group:left'&&problem.kind==='unreachable'&&problem.introduced));
  assert.ok(!impact.removedEdges.some(edge=>edge.id==='no'));
  assert.deepEqual(workflow,before);
});

test('condition impact preserves branch labels, required-path hints and stage boundaries',()=>{
  const workflow=branchFixture();
  const preview=previewConnection(workflow,'pre','control:choice','group:right','true');
  assert.equal(preview.changes!.impact.removedEdges[0].port,'true');assert.equal(preview.changes!.impact.addedEdges[0].port,'true');
  assert.ok(preview.changes!.impact.problems.some(problem=>problem.endpoint==='group:left'&&problem.kind==='unreachable'));
  assert.deepEqual(getConnectionProblems(workflow,'pre'),[]);assert.deepEqual(getConnectionProblems(workflow,'post'),[]);
  const required=fixture();required.pre[0].required=true;
  const skipped=previewConnection(required,'pre','start','group:beta').changes!.impact;
  assert.ok(skipped.problems.some(problem=>problem.endpoint==='group:alpha'&&problem.kind==='required'&&problem.introduced));
  assert.equal(skipped.stage,'pre');assert.ok(!skipped.affectedEndpoints.includes('group:post-only'));
});

test('deleting a connection previews both sides of the break without deleting any graph data',()=>{
  const workflow=fixture(),before=structuredClone(workflow),edge=createStageGraph(workflow.pre).edges.find(item=>item.id==='serial-2')!;
  const impact=connectionImpact(workflow,'pre',[edge],[]);
  assert.deepEqual(impact.addedEdges,[]);assert.deepEqual(impact.removedEdges,[edge]);
  assert.ok(impact.problems.some(problem=>problem.endpoint==='group:alpha'&&problem.kind==='dead_end'&&problem.introduced));
  assert.ok(impact.problems.some(problem=>problem.endpoint==='group:beta'&&problem.kind==='unreachable'&&problem.introduced));
  assert.deepEqual(workflow,before);
});
