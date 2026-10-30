import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { getPolicyCanvasNodes, getWorkflowCanvasLinks } from '../lib/workflow-policy-canvas.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { autoLayout, resolveLayout, nodeDefinitions, knownLayoutKeys, visibleLayoutKey, moveNodes, NODE_WIDTH, NODE_HEIGHT } from '../lib/workflow-layout.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { completeZoneSelection, zoneMembershipIssue, workflowZoneIssues } from '../lib/workflow-zones.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { workflowPathFocus } from '../lib/workflow-path-focus.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { configurationFingerprint } from '../lib/workflow-review.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { isRecoverableWorkflow } from '../lib/workflow-recovery.ts';
import type { PolicyGraph, Workflow } from '../lib/aegis-types';

function fixture():Workflow {
  const workflow=structuredClone(initialState().workflows[0]);delete workflow.graph;delete workflow.layout;
  const template=workflow.pre[0].rules[0];
  workflow.pre=[{id:'pre',name:'요청 검사',mode:'any',rules:[{...template,id:'pre-check'}]}];
  workflow.post=[{id:'post',name:'응답 검사',mode:'any',rules:[{...template,id:'post-check'}]}];
  const condition={mode:'all' as const,predicates:[{path:'/score',operator:'gte' as const,value:80}]};
  const graph:PolicyGraph={version:1,entryNodeId:'branch',nodes:[{id:'branch',kind:'branch',name:'요청 종류',condition},{id:'risk',kind:'rule',name:'위험 점수',condition},{id:'scope',kind:'rule',name:'서비스 범위',condition},{id:'generate',kind:'action',name:'응답 생성',action:'main'},{id:'answer',kind:'action',name:'직접 안내',action:'respond',responseText:'안내문'},{id:'reject',kind:'action',name:'공개 오류',action:'error',errorCode:'RESTRICTED',errorMessage:'제한된 요청입니다.'}],edges:[{id:'branch-yes',from:'branch',to:'risk',port:'true'},{id:'branch-no',from:'branch',to:'scope',port:'false'},{id:'risk-yes',from:'risk',to:'reject',port:'true'},{id:'risk-no',from:'risk',to:'generate',port:'false'},{id:'scope-yes',from:'scope',to:'answer',port:'true'},{id:'scope-no',from:'scope',to:'generate',port:'false'}]};
  workflow.policyRouting={policy:{id:'policy',name:'정책',description:'',prompt:'위험 점수를 반환하세요.',connectionId:'conn-guard',formatVersion:2,decisions:[],outputSchema:{type:'object',properties:{score:{type:'number'}}},examples:[{id:'example',input:'hello',expectedOutput:{score:10}}],connectionSnapshot:{...initialState().connections[1]},version:1,updatedAt:'2026-10-27T00:00:00.000Z'},routes:[],graph};
  return workflow;
}
const p=(id:string)=>`policy-node:${id}`;

test('policy projection adds real visible nodes without changing execution data',()=>{
  const workflow=fixture(),original=structuredClone(workflow),nodes=getPolicyCanvasNodes(workflow);
  assert.equal(nodes.length,7);assert.deepEqual(nodes[0],{key:'policy',id:'policy',kind:'policy',stage:'pre'});
  assert.deepEqual(nodes.slice(1).map(node=>node.policyKind),['branch','rule','rule','action','action','action']);
  const all=nodeDefinitions(workflow);assert.equal(all.length,12);
  for(const node of nodes){assert.equal(visibleLayoutKey(workflow,node.key),node.key);assert.ok(knownLayoutKeys(workflow).includes(node.key));}
  assert.equal(visibleLayoutKey(workflow,p('missing')),undefined);
  getWorkflowCanvasLinks(workflow);autoLayout(workflow);assert.deepEqual(workflow,original);
});
test('boundaries route PRE through policy and actions to Main, POST and error output',()=>{
  const links=getWorkflowCanvasLinks(fixture());
  assert.ok(links.some(link=>link.from==='rule:pre-check'&&link.to==='policy'&&link.id==='pre:serial-2'));
  assert.ok(links.some(link=>link.id==='policy:entry'&&link.to===p('branch')));
  assert.ok(links.some(link=>link.from===p('generate')&&link.to==='main'));
  assert.ok(links.some(link=>link.from===p('answer')&&link.to==='rule:post-check'));
  assert.ok(links.some(link=>link.from===p('reject')&&link.to==='output'));
  assert.ok(links.some(link=>link.from==='main'&&link.to==='rule:post-check'&&link.id==='post:serial-1'));
  assert.equal(links.some(link=>link.from==='policy'&&link.to==='main'),false);
  const edge=links.find(link=>link.id==='policy:edge:risk-yes')!;
  assert.deepEqual([edge.policyEdgeId,edge.port,edge.label],['risk-yes','true','참']);
  assert.equal(new Set(links.map(link=>link.id)).size,links.length);
});
test('respond enters every real POST start successor and bypasses Main',()=>{
  const workflow=fixture();workflow.graph={version:1,pre:{nodes:[],edges:[{id:'in',from:'start',to:'group:pre'},{id:'end',from:'group:pre',to:'end'}]},post:{nodes:[{id:'condition',kind:'condition',name:'응답 조건',condition:{operator:'contains',value:'ok'}}],edges:[{id:'first',from:'start',to:'control:condition'},{id:'second',from:'start',to:'group:post'},{id:'finish',from:'control:condition',to:'end'}]}};
  const targets=getWorkflowCanvasLinks(workflow).filter(link=>link.from===p('answer')).map(link=>link.to);
  assert.deepEqual(targets,['control:condition','rule:post-check']);assert.ok(!targets.includes('main'));
  workflow.post=[];delete workflow.graph;
  assert.deepEqual(getWorkflowCanvasLinks(workflow).filter(link=>link.from===p('answer')).map(link=>link.to),['output']);
});
test('legacy decisions remain labelled direct routes with no invented Main edge',()=>{
  const workflow=fixture(),routing=workflow.policyRouting!;delete routing.graph;
  delete routing.policy.formatVersion;delete routing.policy.outputSchema;
  routing.policy.decisions=[{code:'ANSWER',label:'안내',description:''},{code:'REJECT',label:'거부',description:''}];routing.policy.examples=[{id:'example',input:'hello',expectedDecision:'ANSWER'}];
  routing.routes=[{decision:'ANSWER',action:'respond',responseText:'안내'},{decision:'REJECT',action:'error',errorCode:'DENIED',errorMessage:'차단'}];
  const original=structuredClone(workflow),links=getWorkflowCanvasLinks(workflow);
  assert.equal(getPolicyCanvasNodes(workflow).length,1);
  assert.equal(links.some(link=>link.from==='policy'&&link.to==='main'),false);
  assert.deepEqual(links.filter(link=>link.from==='policy').map(link=>[link.label,link.to]),[['ANSWER','rule:post-check'],['REJECT','output']]);
  assert.deepEqual(workflow,original);
});
test('automatic policy columns follow DAG ranks without node overlap',()=>{
  const workflow=fixture(),positions=autoLayout(workflow,{width:10000,height:240}),nodes=nodeDefinitions(workflow);
  assert.ok(positions.policy.x>positions['rule:pre-check'].x);
  assert.ok(positions[p('branch')].x>positions.policy.x);
  assert.ok(positions[p('risk')].x>positions[p('branch')].x);
  assert.ok(positions[p('generate')].x>positions[p('risk')].x);
  assert.ok(positions.main.x>positions[p('generate')].x);
  for(let a=0;a<nodes.length;a++)for(let b=a+1;b<nodes.length;b++){
    const left=positions[nodes[a].key],right=positions[nodes[b].key];
    assert.ok(!(left.x<right.x+NODE_WIDTH&&left.x+NODE_WIDTH>right.x&&left.y<right.y+NODE_HEIGHT&&left.y+NODE_HEIGHT>right.y),`${nodes[a].key} overlaps ${nodes[b].key}`);
  }
});
test('saved policy positions, pins and moves are stable and recoverable',()=>{
  const workflow=fixture();workflow.layout={version:1,positions:{policy:{x:19000.25,y:17000.5},[p('risk')]:{x:19500.5,y:17500.75}},pinnedKeys:['policy',p('risk')]};
  const original=structuredClone(workflow),positions=resolveLayout(workflow);
  assert.deepEqual(positions.policy,workflow.layout.positions.policy);assert.deepEqual(positions[p('risk')],workflow.layout.positions[p('risk')]);
  const moved=moveNodes(positions,['policy',p('risk')],{x:100,y:50});
  assert.equal(moved.policy.x,Math.round(positions.policy.x+100));assert.equal(moved[p('risk')].x,Math.round(positions[p('risk')].x+100));
  assert.deepEqual(workflow,original);assert.equal(isRecoverableWorkflow(workflow),true);
});
test('zones cannot skip policy or graph middles and completion includes every real path',()=>{
  const workflow=fixture();
  assert.ok(zoneMembershipIssue(workflow,['rule:pre-check','main']));
  assert.ok(zoneMembershipIssue(workflow,['policy',p('generate')]));
  assert.equal(zoneMembershipIssue(workflow,[p('generate'),'main']),undefined);
  assert.equal(zoneMembershipIssue(workflow,[p('answer'),'rule:post-check']),undefined);
  assert.equal(zoneMembershipIssue(workflow,[p('reject'),'output']),undefined);
  const completed=completeZoneSelection(workflow,['policy','output']);
  assert.equal(completed.issue,undefined);
  for(const node of getPolicyCanvasNodes(workflow))assert.ok(completed.nodeKeys.includes(node.key));
  assert.ok(completed.nodeKeys.includes('main'));assert.ok(completed.nodeKeys.includes('rule:post-check'));
});
test('old crossing zones are reported without automatically migrating saved metadata',()=>{
  const workflow=fixture();workflow.layout={version:1,positions:{},zones:[{id:'old',name:'기존 영역',color:'blue',nodeKeys:['rule:pre-check','main'],x:0,y:0,width:600,height:240}]};
  const original=structuredClone(workflow);assert.equal(workflowZoneIssues(workflow).length,1);
  resolveLayout(workflow);getWorkflowCanvasLinks(workflow);assert.deepEqual(workflow,original);
});
test('policy path focus follows selected branch and excludes parallel sibling rules',()=>{
  const workflow=fixture(),focus=workflowPathFocus(workflow,p('risk'))!;
  for(const key of ['input','rule:pre-check','policy',p('branch'),p('risk'),p('generate'),p('reject'),'main','rule:post-check','output'])assert.ok(focus.nodes.has(key),key);
  assert.equal(focus.nodes.has(p('scope')),false);assert.equal(focus.nodes.has(p('answer')),false);
  assert.ok(focus.edges.has('policy:edge:risk-yes'));assert.ok(focus.edges.has('policy:entry'));
  assert.equal(focus.edges.has('policy:edge:branch-no'),false);
});
test('layout metadata changes keep the execution fingerprint unchanged',async()=>{
  const workflow=fixture(),connections=initialState().connections,original=structuredClone(workflow);
  const before=await configurationFingerprint(workflow,connections);
  workflow.layout={version:1,positions:autoLayout(workflow),pinnedKeys:['policy',p('risk')]};
  assert.equal(await configurationFingerprint(workflow,connections),before);
  const {layout,...after}=workflow;assert.deepEqual(after,original);
});
test('incomplete cyclic policy drafts still get bounded distinct placement without execution edits',()=>{
  const workflow=fixture();workflow.policyRouting!.graph!.edges.push({id:'cycle',from:'scope',to:'branch',port:'false'});
  const original=structuredClone(workflow),positions=autoLayout(workflow);
  for(const node of getPolicyCanvasNodes(workflow))assert.ok(Number.isFinite(positions[node.key].x)&&Number.isFinite(positions[node.key].y));
  assert.deepEqual(workflow,original);
});
test('legacy maximum drafts retain their positions and the expanded policy canvas limit is 1280',()=>{
  const workflow=fixture(),template=workflow.pre[0].rules[0];
  for(const stage of ['pre','post'] as const)workflow[stage]=Array.from({length:36},(_,index)=>({id:`${stage}-${index}`,name:'검사 조합',mode:'any',rules:Array.from({length:12},(_,rule)=>({...structuredClone(template),id:`${stage}-${index}-${rule}`}))}));
  workflow.graph={version:1,pre:{nodes:[],edges:[]},post:{nodes:[],edges:[]}};
  for(const stage of ['pre','post'] as const)workflow.graph[stage].nodes=Array.from({length:12},(_,index)=>({id:`${stage}-control-${index}`,name:'조건',kind:'condition',condition:{operator:'contains',value:'ok'}}));
  const policyGraph=workflow.policyRouting!.graph!;
  for(let index=policyGraph.nodes.length;index<24;index++)policyGraph.nodes.push({id:`extra-${index}`,name:'미연결 초안',kind:'action',action:'main'});
  const positions=autoLayout(workflow),pins=nodeDefinitions(workflow).map(node=>node.key);
  assert.equal(Object.keys(positions).length,988);assert.equal(pins.length,124);
  workflow.layout={version:1,positions,pinnedKeys:pins};assert.equal(isRecoverableWorkflow(workflow),true);
  for(let index=988;index<1280;index++)workflow.layout.positions[`scoped-${index}`]={x:1,y:1};
  assert.equal(isRecoverableWorkflow(workflow),true);workflow.layout.positions.extra={x:1,y:1};assert.equal(isRecoverableWorkflow(workflow),false);delete workflow.layout.positions.extra;
  for(let index=124;index<1280;index++)workflow.layout.pinnedKeys!.push(`scoped-${index}`);
  assert.equal(isRecoverableWorkflow(workflow),true);workflow.layout.pinnedKeys!.push('extra');assert.equal(isRecoverableWorkflow(workflow),false);
});
