import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Node's source test runner resolves explicit TypeScript imports.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node's source test runner resolves explicit TypeScript imports.
import {captureInsertTarget} from '../lib/workflow-connections.ts';
// @ts-expect-error Node's source test runner resolves explicit TypeScript imports.
import {captureCreationTargets,previewParallelCheckOnEdge,previewParallelChecksOnEdge,addParallelCheckOnEdge,addParallelChecksOnEdge} from '../lib/workflow-node-creation.ts';
// @ts-expect-error Node's source test runner resolves explicit TypeScript imports.
import {createStageGraph,getStageGraph,validateWorkflowGraph} from '../lib/workflow-graph.ts';
// @ts-expect-error Node's source test runner resolves explicit TypeScript imports.
import {executeWorkflow} from '../lib/aegis-engine.ts';
import type {RuleGroup,Workflow} from '../lib/aegis-types';

function group(id:string):RuleGroup{return {id,name:id,mode:'any',rules:[{id:`${id}-rule`,name:`${id} 검사`,description:'',kind:'length',enabled:true,config:{maxLength:4000}}]};}
function fixture():Workflow{const workflow=structuredClone(initialState().workflows[0]);workflow.pre=[group('alpha'),group('beta'),group('gamma')];workflow.post=[];delete workflow.graph;delete workflow.layout;return workflow;}
function identifiers(){let number=0;return(prefix:string)=>`${prefix}-branch-new-${++number}`;}
function branches(workflow:Workflow,stage:'pre'|'post',splitId:string){return getStageGraph(workflow,stage).edges.filter(edge=>edge.from===`control:${splitId}`).map(edge=>edge.to);}

test('one new check branches beside the exact following check without changing its successor',()=>{
  const workflow=fixture(),original=structuredClone(workflow),target=captureInsertTarget(workflow,'pre','serial-2');
  assert.deepEqual(previewParallelCheckOnEdge(workflow,target),{valid:true,mode:'beside-existing',minimumNodes:1,existingGroupId:'beta'});
  const built=addParallelCheckOnEdge(workflow,target,group('new'),{identifier:identifiers()}),graph=built.workflow.graph!.pre;
  assert.deepEqual(branches(built.workflow,'pre',built.splitId),['group:new','group:beta']);
  assert.equal(graph.edges.find(edge=>edge.from===`control:${built.joinId}`)?.to,'group:gamma');
  assert.equal(graph.edges.find(edge=>edge.id===target.edgeId)?.from,'group:alpha');
  assert.equal(graph.edges.find(edge=>edge.id===target.edgeId)?.to,`control:${built.splitId}`);
  assert.deepEqual(validateWorkflowGraph(built.workflow),[]);assert.deepEqual(workflow,original);
});

test('the initial empty workflow creates two actual parallel checks before the model',()=>{
  const workflow=fixture();workflow.pre=[];const target=captureCreationTargets(workflow,'pre','start')[0];
  const preview=previewParallelCheckOnEdge(workflow,target);assert.equal(preview.valid,true);assert.equal(preview.mode,'new-paths');assert.equal(preview.minimumNodes,2);
  assert.throws(()=>addParallelCheckOnEdge(workflow,target,group('only')),/두 개/);
  const built=addParallelCheckOnEdge(workflow,target,[group('one'),group('two')],{identifier:identifiers()});
  assert.deepEqual(branches(built.workflow,'pre',built.splitId),['group:one','group:two']);
  assert.equal(getStageGraph(built.workflow,'pre').edges.find(edge=>edge.from===`control:${built.joinId}`)?.to,'end');
  assert.deepEqual(validateWorkflowGraph(built.workflow),[]);
});

test('required checks remain after new parallel paths and cannot become a bypassed existing branch',()=>{
  const workflow=fixture();workflow.pre[1].required=true;const target=captureInsertTarget(workflow,'pre','serial-2');
  assert.equal(previewParallelCheckOnEdge(workflow,target).mode,'new-paths');
  assert.match(previewParallelCheckOnEdge(workflow,target).reason??'',/필수/);
  const built=addParallelChecksOnEdge(workflow,target,[group('one'),group('two')],{identifier:identifiers()});
  assert.equal(getStageGraph(built.workflow,'pre').edges.find(edge=>edge.from===`control:${built.joinId}`)?.to,'group:beta');
  assert.deepEqual(validateWorkflowGraph(built.workflow),[]);
  assert.throws(()=>addParallelCheckOnEdge(workflow,target,group('only')),/두 개/);
  const requiredNew=group('new-required');requiredNew.required=true;
  assert.throws(()=>addParallelChecksOnEdge(workflow,target,[requiredNew,group('other')]),/필수/);
});

test('a condition output keeps its true or false port while the unselected branch stays untouched',async()=>{
  const state=initialState(),workflow=fixture();workflow.pre=[group('alpha'),group('beta')];
  workflow.graph={version:1,pre:{nodes:[{id:'condition',name:'분류',kind:'condition',condition:{operator:'contains',value:'배송'}},{id:'merge',name:'합류',kind:'join'}],edges:[
    {id:'entry',from:'start',to:'control:condition'},
    {id:'yes',from:'control:condition',to:'group:alpha',port:'true'},
    {id:'no',from:'control:condition',to:'group:beta',port:'false'},
    {id:'alpha-exit',from:'group:alpha',to:'control:merge'},
    {id:'beta-exit',from:'group:beta',to:'control:merge'},
    {id:'exit',from:'control:merge',to:'end'},
  ]},post:createStageGraph(workflow.post)};
  const target=captureCreationTargets(workflow,'pre','control:condition','false')[0];assert.equal(target.edgeId,'no');
  assert.throws(()=>captureCreationTargets(workflow,'pre','control:condition'),/조건/);
  const built=addParallelCheckOnEdge(workflow,target,group('new'),{identifier:identifiers()});
  assert.deepEqual(built.workflow.graph!.pre.edges.find(edge=>edge.id==='yes'),workflow.graph.pre.edges.find(edge=>edge.id==='yes'));
  assert.equal(built.workflow.graph!.pre.edges.find(edge=>edge.id==='no')?.port,'false');
  assert.deepEqual(validateWorkflowGraph(built.workflow),[]);
  const yes=await executeWorkflow(built.workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  assert.equal(yes.traces.find(trace=>trace.ruleId==='new-rule')?.status,'skipped');
  const no=await executeWorkflow(built.workflow,state.connections,state.ingress,{},[{role:'user',content:'반품 문의'}]);
  assert.equal(no.traces.find(trace=>trace.ruleId==='new-rule')?.status,'allow');
  assert.equal(no.traces.find(trace=>trace.ruleId==='beta-rule')?.status,'allow');
});

test('fork output capture preserves every distinct route instead of silently choosing one',()=>{
  const workflow=fixture(),built=addParallelCheckOnEdge(workflow,captureInsertTarget(workflow,'pre','serial-2'),group('new'),{identifier:identifiers()});
  const targets=captureCreationTargets(built.workflow,'pre',`control:${built.splitId}`);
  assert.equal(targets.length,2);assert.deepEqual(targets.map(target=>target.to),branches(built.workflow,'pre',built.splitId));
  assert.throws(()=>captureCreationTargets(workflow,'pre','end'),/출발/);
  assert.throws(()=>captureCreationTargets(workflow,'pre','missing'),/출발/);
});

test('adding before a control produces two checks without changing its decisions or condition ports',()=>{
  const workflow=fixture();workflow.graph={version:1,pre:createStageGraph(workflow.pre),post:createStageGraph(workflow.post)};
  const first=addParallelCheckOnEdge(workflow,captureInsertTarget(workflow,'pre','serial-2'),group('new'),{identifier:identifiers()});
  const target=captureInsertTarget(first.workflow,'pre','serial-2');assert.equal(previewParallelCheckOnEdge(first.workflow,target).mode,'new-paths');
  const second=addParallelChecksOnEdge(first.workflow,target,[group('one'),group('two')],{identifier:identifiers()});
  assert.equal(getStageGraph(second.workflow,'pre').edges.find(edge=>edge.from===`control:${second.joinId}`)?.to,`control:${first.splitId}`);
  assert.deepEqual(validateWorkflowGraph(second.workflow),[]);
});

test('new branches respect node, control and edge limits before making any edit',()=>{
  const workflow=fixture();workflow.pre=Array.from({length:35},(_,index)=>group(`check-${index}`));
  const target=captureInsertTarget(workflow,'pre','serial-1');
  assert.equal(previewParallelCheckOnEdge(workflow,target).valid,true);
  assert.match(previewParallelChecksOnEdge(workflow,target,2).reason??'',/36/);
  workflow.pre.push(group('last'));assert.equal(previewParallelCheckOnEdge(workflow,captureInsertTarget(workflow,'pre','serial-1')).valid,false);
  const controls=fixture();controls.graph={version:1,pre:createStageGraph(controls.pre),post:createStageGraph(controls.post)};
  controls.graph.pre.nodes=Array.from({length:11},(_,index)=>({id:`control-${index}`,name:'제어',kind:'join'}));
  assert.match(previewParallelCheckOnEdge(controls,captureInsertTarget(controls,'pre','serial-1')).reason??'',/12/);
  const edges=fixture();edges.graph={version:1,pre:createStageGraph(edges.pre),post:createStageGraph(edges.post)};
  while(edges.graph.pre.edges.length<61)edges.graph.pre.edges.push({id:`extra-${edges.graph.pre.edges.length}`,from:'start',to:'end'});
  assert.match(previewParallelCheckOnEdge(edges,captureInsertTarget(edges,'pre','serial-1')).reason??'',/64/);
});

test('stale captures, duplicate new IDs and exhausted control IDs fail without mutating any original data',()=>{
  const workflow=fixture(),target=captureInsertTarget(workflow,'pre','serial-2'),original=structuredClone(workflow);
  const stale={...target,to:'group:gamma'};assert.equal(previewParallelCheckOnEdge(workflow,stale).valid,false);
  assert.throws(()=>addParallelCheckOnEdge(workflow,stale,group('new')),/변경/);
  assert.throws(()=>addParallelCheckOnEdge({...workflow,id:'other'},target,group('new')),/변경/);
  assert.throws(()=>addParallelChecksOnEdge(workflow,target,[group('same'),group('same')]),/ID/);
  assert.throws(()=>addParallelCheckOnEdge(workflow,target,group('new'),{identifier:()=>workflow.pre[0].id}),/ID/);
  assert.deepEqual(workflow,original);
});

test('new checks execute as real active branches and a block still withholds the final answer',async()=>{
  const state=initialState(),workflow=fixture(),block=group('new');block.rules[0].kind='keyword';block.rules[0].config={pattern:'차단'};
  const built=addParallelCheckOnEdge(workflow,captureInsertTarget(workflow,'pre','serial-2'),block,{identifier:identifiers()});
  const result=await executeWorkflow(built.workflow,state.connections,state.ingress,{},[{role:'user',content:'차단 요청'}]);
  assert.equal(result.status,'block');assert.equal(result.stage,'pre');assert.equal(result.output,'');
  assert.equal(result.traces.find(trace=>trace.ruleId==='new-rule')?.status,'block');
  assert.equal(result.traces.find(trace=>trace.ruleId==='beta-rule')?.status,'allow');
  assert.ok(result.traces.filter(trace=>trace.stage==='main').every(trace=>trace.status==='skipped'));
});

test('new two to four path fallback is bounded and works for response checks too',()=>{
  for(const count of [2,3,4]){
    const workflow=fixture(),target=captureCreationTargets(workflow,'post','start')[0];
    const built=addParallelChecksOnEdge(workflow,target,Array.from({length:count},(_,index)=>group(`new-${index}`)),{identifier:identifiers()});
    assert.equal(branches(built.workflow,'post',built.splitId).length,count);assert.deepEqual(validateWorkflowGraph(built.workflow),[]);
  }
  const workflow=fixture(),target=captureCreationTargets(workflow,'post','start')[0];
  for(const count of [0,1,5])assert.equal(previewParallelChecksOnEdge(workflow,target,count).valid,false);
});
