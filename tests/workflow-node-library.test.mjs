import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState } from '../lib/aegis-seed.ts';
import { addWorkflowControlNode, addWorkflowCheckGroup } from '../lib/workflow-node-library.ts';
import { captureInsertTarget } from '../lib/workflow-connections.ts';
import { createStageGraph, getStageGraph, validateWorkflowGraph } from '../lib/workflow-graph.ts';
import { isRecoverableWorkflow } from '../lib/workflow-recovery.ts';
import { validateWorkflow } from '../lib/workflow-validation.ts';

function fixture(){const value=structuredClone(initialState().workflows[0]);delete value.graph;delete value.layout;return value;}
function frozen(value){if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;}

for(const stage of ['pre','post'])for(const kind of ['condition','fork','join'])test(`the node library adds a standalone ${stage} ${kind} draft without altering execution paths`,()=>{
  const value=frozen(fixture()),before=structuredClone(value),built=addWorkflowControlNode(value,stage,kind,{id:'created'}),graph=built.workflow.graph[stage];
  assert.deepEqual(value,before);assert.equal(built.nodeId,'created');assert.equal(graph.nodes.length,1);assert.equal(graph.nodes[0].kind,kind);
  assert.deepEqual(graph.edges,getStageGraph(before,stage).edges);assert.deepEqual(built.workflow[stage],before[stage]);assert.equal(isRecoverableWorkflow(built.workflow),true);
  assert.ok(validateWorkflowGraph(built.workflow).length>0,'Disconnected drafts must require completed wiring before execution.');
});

for(const kind of ['condition','fork','join'])test(`inserting ${kind} preserves the captured port, successor and every other edge`,()=>{
  const value=fixture(),target=captureInsertTarget(value,'pre','serial-1'),before=structuredClone(value),built=addWorkflowControlNode(frozen(value),'pre',kind,{id:'created',target}),graph=built.workflow.graph.pre;
  assert.deepEqual(value,before);assert.equal(graph.edges.find(edge=>edge.id===target.edgeId).to,'control:created');
  assert.deepEqual(graph.edges.filter(edge=>edge.id!==target.edgeId&&!edge.id.startsWith('library-edge-')),getStageGraph(before,'pre').edges.filter(edge=>edge.id!==target.edgeId));
  const outgoing=graph.edges.filter(edge=>edge.from==='control:created');
  assert.deepEqual(outgoing.map(edge=>edge.to),kind==='condition'?[target.to,target.to]:[target.to]);
  assert.deepEqual(outgoing.map(edge=>edge.port),kind==='condition'?['true','false']:['next']);
  assert.ok(validateWorkflowGraph(built.workflow).length>0,'One control addition is explicitly an unfinished draft.');
  assert.deepEqual(getStageGraph(built.workflow,'post'),getStageGraph(before,'post'));
});

test('inserting from a false condition port keeps that original choice and allocates unique edge IDs',()=>{
  const value=fixture();value.pre=[];value.graph={version:1,pre:{nodes:[{id:'first',name:'입력 조건',kind:'condition',condition:{operator:'contains',value:'검사'}}],edges:[{id:'entry',from:'start',to:'control:first'},{id:'library-edge-1',from:'control:first',to:'end',port:'true'},{id:'false',from:'control:first',to:'end',port:'false'}]},post:createStageGraph(value.post)};
  const built=addWorkflowControlNode(value,'pre','condition',{target:captureInsertTarget(value,'pre','false'),id:'second'}),edges=built.workflow.graph.pre.edges;
  assert.deepEqual(edges.find(edge=>edge.id==='false'),{id:'false',from:'control:first',to:'control:second',port:'false'});
  assert.deepEqual(edges.find(edge=>edge.id==='library-edge-1'),value.graph.pre.edges[1]);assert.equal(new Set(edges.map(edge=>edge.id)).size,edges.length);
});

test('draft control creation preserves materialized graphs, policy data, layout and immutable history values',()=>{
  const value=fixture();value.graph={version:1,pre:createStageGraph(value.pre),post:createStageGraph(value.post)};value.layout={version:1,positions:{input:{x:40,y:60}},pinnedKeys:['input']};
  const before=structuredClone(value),built=addWorkflowControlNode(frozen(value),'post','join',{id:'new-join'});
  assert.deepEqual(value,before);assert.deepEqual(built.workflow.graph.pre,before.graph.pre);assert.deepEqual(built.workflow.layout,before.layout);
});

test('a check combination can be created independently or inserted without fabricating checks',()=>{
  const value=fixture(),before=structuredClone(value),isolated=addWorkflowCheckGroup(frozen(value),'pre',{id:'combination'});
  assert.deepEqual(value,before);assert.equal(isolated.groupId,'combination');assert.deepEqual(isolated.workflow.pre.at(-1),{id:'combination',name:'새 검사 조합',mode:'any',rules:[]});
  assert.deepEqual(isolated.workflow.graph.pre.edges,getStageGraph(before,'pre').edges);assert.equal(isRecoverableWorkflow(isolated.workflow),true);
  const target=captureInsertTarget(value,'pre','serial-1'),inserted=addWorkflowCheckGroup(value,'pre',{id:'on-edge',target});
  assert.equal(inserted.workflow.graph.pre.edges.find(edge=>edge.id===target.edgeId).to,'group:on-edge');
  assert.equal(inserted.workflow.graph.pre.edges.find(edge=>edge.from==='group:on-edge').to,target.to);
  assert.deepEqual(inserted.workflow.pre.at(-1).rules,[]);
  assert.ok(validateWorkflow(inserted.workflow,initialState().connections).includes('검사 조합에 검사를 하나 이상 추가하세요.'));
});

test('all library node IDs are unique against groups, nested rules and controls in both stages',()=>{
  const value=fixture();value.graph={version:1,pre:createStageGraph(value.pre),post:createStageGraph(value.post)};value.graph.post.nodes.push({id:'other-control',name:'다른 구간',kind:'join'});
  const candidates=[value.pre[0].id,value.pre[0].rules[0].id,value.post[0].id,value.post[0].rules[0].id,'other-control','',null,42,'has space','constructor','__proto__','x'.repeat(121)];
  const before=structuredClone(value);
  for(const id of candidates){assert.throws(()=>addWorkflowControlNode(frozen(value),'pre','join',{id}),/ID/);assert.throws(()=>addWorkflowCheckGroup(value,'pre',{id}),/ID/);}
  assert.deepEqual(value,before);
});

test('stale edge captures, workflow changes, stage changes and invalid kinds fail before any edit',()=>{
  const value=frozen(fixture()),target=captureInsertTarget(value,'pre','serial-1'),before=structuredClone(value);
  for(const changed of [{...target,to:'missing'},{...target,from:'end'},{...target,workflowId:'other'},{...target,port:'invalid'},{...target,stage:'post'}]){
    assert.throws(()=>addWorkflowControlNode(value,'pre','join',{id:'created',target:changed}));assert.throws(()=>addWorkflowCheckGroup(value,'pre',{id:'created',target:changed}));
  }
  assert.throws(()=>addWorkflowControlNode(value,'main','condition'));assert.throws(()=>addWorkflowCheckGroup(value,'main'));
  assert.throws(()=>addWorkflowControlNode(value,'pre','unknown'));assert.deepEqual(value,before);
});

test('control and group count limits are enforced before adding a node',()=>{
  let value=fixture();for(let index=0;index<12;index++)value=addWorkflowControlNode(value,'pre','join',{id:`draft-${index}`}).workflow;
  const before=structuredClone(value);assert.equal(value.graph.pre.nodes.length,12);assert.throws(()=>addWorkflowControlNode(frozen(value),'pre','join'),/12/);assert.deepEqual(value,before);
  value=fixture();for(let index=value.pre.length;index<36;index++)value=addWorkflowCheckGroup(value,'pre',{id:`group-${index}`}).workflow;
  assert.equal(value.pre.length,36);assert.throws(()=>addWorkflowCheckGroup(frozen(value),'pre'),/36/);
});

test('edge limits account for two condition ports, one normal output or a standalone draft',()=>{
  const value=fixture();value.graph={version:1,pre:createStageGraph(value.pre),post:createStageGraph(value.post)};
  while(value.graph.pre.edges.length<63)value.graph.pre.edges.push({id:`unused-${value.graph.pre.edges.length}`,from:'start',to:'end',port:'next'});
  const target=captureInsertTarget(value,'pre','serial-1');
  assert.throws(()=>addWorkflowControlNode(frozen(value),'pre','condition',{target}),/64/);
  const inserted=addWorkflowControlNode(value,'pre','join',{target});assert.equal(inserted.workflow.graph.pre.edges.length,64);
  assert.equal(addWorkflowCheckGroup(value,'pre',{target}).workflow.graph.pre.edges.length,64);
  const full=inserted.workflow,current=captureInsertTarget(full,'pre','serial-1');
  assert.throws(()=>addWorkflowControlNode(full,'pre','fork',{target:current}),/64/);assert.throws(()=>addWorkflowCheckGroup(full,'pre',{target:current}),/64/);
  assert.equal(addWorkflowControlNode(full,'pre','fork').workflow.graph.pre.edges.length,64);
});
