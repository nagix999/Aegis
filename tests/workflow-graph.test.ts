import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {conditionMatches,createStageGraph,endpointLabel,getStageGraph,graphNodeKeys,validateWorkflowGraph} from '../lib/workflow-graph.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {initialState} from '../lib/aegis-seed.ts';
import type {FlowEdge,RuleGroup,StageGraph,Workflow} from '../lib/aegis-types';

function group(id:string,required=false):RuleGroup{return{id,name:id,mode:'any',rules:[],required};}
function edge(id:string,from:string,to:string,port?:FlowEdge['port']):FlowEdge{return{id,from,to,...(port===undefined?{}:{port})};}
function fixture(){
  const workflow=structuredClone(initialState().workflows[0]);
  workflow.pre=[group('alpha'),group('beta')];workflow.post=[];
  workflow.graph={version:1,pre:createStageGraph(workflow.pre),post:createStageGraph(workflow.post)};
  return workflow;
}
function branchFixture(){
  const workflow=fixture();
  workflow.graph!.pre={nodes:[
    {id:'decision',name:'배송 분기',kind:'condition',condition:{operator:'contains',value:'배송'}},
    {id:'merge',name:'분기 병합',kind:'join'},
  ],edges:[
    edge('s','start','control:decision'),edge('yes','control:decision','group:alpha','true'),edge('no','control:decision','group:beta','false'),
    edge('a','group:alpha','control:merge'),edge('b','group:beta','control:merge'),edge('e','control:merge','end'),
  ]};
  return workflow;
}

test('serial defaults preserve group order and support an empty stage without explicit graph',()=>{
  const workflow=fixture();delete workflow.graph;
  assert.deepEqual(getStageGraph(workflow,'pre'),createStageGraph(workflow.pre));
  assert.deepEqual(getStageGraph(workflow,'pre').edges.map(item=>[item.from,item.to]),[['start','group:alpha'],['group:alpha','group:beta'],['group:beta','end']]);
  assert.deepEqual(createStageGraph([]),{nodes:[],edges:[{id:'serial-1',from:'start',to:'end',port:'next'}]});
  assert.deepEqual(validateWorkflowGraph(workflow),[]);
  assert.deepEqual(graphNodeKeys(workflow,'pre'),['start','group:alpha','group:beta','end']);
  assert.equal(endpointLabel(workflow,'pre','group:alpha'),'alpha');
});

test('valid conditional branches and fork/join graphs expose controls and endpoint labels',()=>{
  const workflow=branchFixture();
  assert.deepEqual(validateWorkflowGraph(workflow),[]);
  assert.ok(graphNodeKeys(workflow,'pre').includes('control:decision'));
  assert.equal(endpointLabel(workflow,'pre','control:merge'),'분기 병합');
  workflow.graph!.pre.nodes[0]={id:'decision',name:'동시 검사',kind:'fork'};
  workflow.graph!.pre.edges=workflow.graph!.pre.edges.map(item=>item.from==='control:decision'?{...item,port:'next'}:item);
  assert.deepEqual(validateWorkflowGraph(workflow),[]);
});

test('condition operators respect case options and canonical zero-to-40000 length bounds',()=>{
  assert.equal(conditionMatches({operator:'contains',value:'HELLO'},'Hello customer'),true);
  assert.equal(conditionMatches({operator:'contains',value:'HELLO',caseSensitive:true},'Hello customer'),false);
  assert.equal(conditionMatches({operator:'not_contains',value:'private'},'public'),true);
  assert.equal(conditionMatches({operator:'length_gte',value:'0'},''),true);
  assert.equal(conditionMatches({operator:'length_lte',value:'3'},'abc'),true);
  assert.equal(conditionMatches({operator:'length_gte',value:'4'},'abc'),false);
  for(const value of ['-1','01','1.5','40001','Infinity',''])assert.equal(conditionMatches({operator:'length_gte',value},'abcd'),false);
  assert.equal(conditionMatches({operator:'contains',value:''},'abc'),false);
});

test('invalid ports and condition branch cardinality cannot be deployed',()=>{
  for(const port of ['next','unknown',null]){
    const workflow=branchFixture();workflow.graph!.pre.edges[1].port=port as FlowEdge['port'];
    assert.ok(validateWorkflowGraph(workflow).length>0);
  }
  const workflow=branchFixture();workflow.graph!.pre.edges[2].port='true';
  assert.ok(validateWorkflowGraph(workflow).some(message=>message.includes('true')));
});

test('cycles, dangling edges, and references to the other stage are rejected',()=>{
  const cycle=fixture();cycle.graph!.pre.edges=[edge('s','start','group:alpha'),edge('a','group:alpha','group:beta'),edge('b','group:beta','group:alpha')];
  assert.ok(validateWorkflowGraph(cycle).some(message=>message.includes('순환')));
  for(const target of ['control:missing','group:post-only','post:group:post-only']){
    const workflow=fixture();workflow.post=[group('post-only')];workflow.graph!.post=createStageGraph(workflow.post);workflow.graph!.pre.edges[0].to=target;
    assert.ok(validateWorkflowGraph(workflow).some(message=>message.includes('없는 노드')||message.includes('다른 단계')));
  }
});

test('control IDs are globally distinct from group, rule, and controls in either stage',()=>{
  for(const collision of ['alpha','existing-rule','post-control']){
    const workflow=branchFixture();
    workflow.pre[0].rules=[{id:'existing-rule',name:'규칙',description:'',kind:'length',enabled:true,config:{maxLength:100}}];
    workflow.graph!.post={nodes:[{id:'post-control',name:'조건',kind:'condition',condition:{operator:'contains',value:'확인'}}],edges:[edge('p0','start','control:post-control'),edge('p1','control:post-control','end','true'),edge('p2','control:post-control','end','false')]};
    const previous=workflow.graph!.pre.nodes[0].id;
    workflow.graph!.pre.nodes[0].id=collision;
    workflow.graph!.pre.edges=workflow.graph!.pre.edges.map(item=>({...item,from:item.from===`control:${previous}`?`control:${collision}`:item.from,to:item.to===`control:${previous}`?`control:${collision}`:item.to}));
    assert.ok(validateWorkflowGraph(workflow).some(message=>message.includes('제어 노드 ID')));
  }
  const duplicate=branchFixture();duplicate.graph!.pre.edges[1].id=duplicate.graph!.pre.edges[0].id;
  assert.ok(validateWorkflowGraph(duplicate).some(message=>message.includes('연결선 ID')));
});

test('required groups must occur on every structural start-to-end path',()=>{
  const workflow=branchFixture();workflow.pre[0].required=true;
  assert.ok(validateWorkflowGraph(workflow).some(message=>message.includes('필수 검사')));
  workflow.pre[0].required=false;
  assert.deepEqual(validateWorkflowGraph(workflow),[]);
  const serial=fixture();serial.pre.forEach(item=>{item.required=true;});
  assert.deepEqual(validateWorkflowGraph(serial),[]);
});

test('group fan-in requires a join and a fork requires distinct targets',()=>{
  const workflow=branchFixture();workflow.pre=[group('alpha')];
  workflow.graph!.pre={nodes:[{id:'condition',name:'조건',kind:'condition',condition:{operator:'contains',value:'배송'}}],edges:[edge('s','start','control:condition'),edge('t','control:condition','group:alpha','true'),edge('f','control:condition','group:alpha','false'),edge('e','group:alpha','end')]};
  assert.ok(validateWorkflowGraph(workflow).some(message=>message.includes('검사 노드')));
  const fork=branchFixture();fork.graph!.pre.nodes[0]={id:'decision',name:'병렬',kind:'fork'};
  fork.graph!.pre.edges[1].port='next';fork.graph!.pre.edges[2]={...fork.graph!.pre.edges[2],port:'next',to:'group:alpha'};
  assert.ok(validateWorkflowGraph(fork).some(message=>message.includes('서로 다른')));
  const ending=fixture();ending.pre=[];
  ending.graph!.pre={nodes:[{id:'decision',name:'조건',kind:'condition',condition:{operator:'contains',value:'배송'}}],edges:[edge('s','start','control:decision'),edge('t','control:decision','end','true'),edge('f','control:decision','end','false')]};
  assert.ok(validateWorkflowGraph(ending).some(message=>message.includes('종료 노드')));
});

test('disconnected nodes, dead-end branches, and malformed condition settings are rejected',()=>{
  const disconnected=fixture();disconnected.graph!.pre.nodes=[{id:'unused',name:'연결되지 않은 조건',kind:'condition',condition:{operator:'contains',value:'배송'}}];
  assert.ok(validateWorkflowGraph(disconnected).some(message=>message.includes('도달')));
  const deadEnd=branchFixture();deadEnd.graph!.pre.edges=deadEnd.graph!.pre.edges.filter(item=>item.from!=='group:beta');
  assert.ok(validateWorkflowGraph(deadEnd).some(message=>message.includes('종료 노드')));
  for(const condition of [undefined,{operator:'contains',value:''},{operator:'length_gte',value:'01'},{operator:'contains',value:'a',caseSensitive:'yes'}]){
    const workflow=branchFixture();workflow.graph!.pre.nodes[0].condition=condition as NonNullable<StageGraph['nodes'][number]['condition']>;
    assert.ok(validateWorkflowGraph(workflow).length>0);
  }
  const unexpected=branchFixture();unexpected.graph!.pre.nodes[1].condition={operator:'contains',value:'a'};
  assert.ok(validateWorkflowGraph(unexpected).some(message=>message.includes('조건 노드')));
});

test('malformed JSON-shaped values are reported without throwing and graph limits are bounded',()=>{
  for(const invalid of [null,[],{}, {pre:[null],post:[]}, {pre:[],post:[],graph:null}, {pre:[],post:[],graph:{version:2}}, {pre:[],post:[],graph:{version:1,pre:{nodes:[],edges:[]}}}]){
    assert.doesNotThrow(()=>validateWorkflowGraph(invalid as unknown as Workflow));
    assert.ok(validateWorkflowGraph(invalid as unknown as Workflow).length>0);
  }
  const workflow=fixture();workflow.graph!.pre.nodes=Array.from({length:13},(_item,index)=>({id:`n${index}`,name:'제어',kind:'join'}));
  assert.ok(validateWorkflowGraph(workflow).some(message=>message.includes('최대 12개')));
  const badRequired=fixture();badRequired.pre[0].required='true' as unknown as boolean;
  assert.ok(validateWorkflowGraph(badRequired).some(message=>message.includes('필수 검사 여부')));
});
