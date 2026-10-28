import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node source runner uses explicit TS imports.
import { createPolicyGraph, policyGraphErrors, policyConditionErrors, policySchemaPaths, validPolicyPointer } from '../lib/policy-graph.ts';
// @ts-expect-error Node source runner uses explicit TS imports.
import { bindPolicyRevision, policyDefinitionErrors, policyExecutionConfiguration, policyOutputSchema, policyRoutingErrors } from '../lib/policy-routing.ts';
// @ts-expect-error Node source runner uses explicit TS imports.
import { isRecoverableWorkflow } from '../lib/workflow-recovery.ts';
// @ts-expect-error Node source runner uses explicit TS imports.
import { inspectDatasetCompatibility } from '../lib/dataset-compatibility.ts';
// @ts-expect-error Node source runner uses explicit TS imports.
import { initialState } from '../lib/aegis-seed.ts';
import type { PolicyGraph, PolicyRevision, Workflow } from '../lib/aegis-types';

function policy():PolicyRevision {return {id:'complex-policy',name:'복합 출력',description:'',prompt:'위험 점수와 문맥을 추출하세요.',connectionId:'guard',decisions:[],formatVersion:2,maxOutputTokens:1024,
  outputSchema:{type:'object',properties:{risk:{type:'object',properties:{score:{type:'number'},categories:{type:'array',items:{type:'string'}}}},context:{type:'object',properties:{topic:{type:'string'}}}},required:['risk']},
  examples:[{id:'example',input:'배송 문의',expectedOutput:{risk:{score:10,categories:[]},context:{topic:'service'}}}],connectionSnapshot:{...initialState().connections.find(c=>c.role!=='main')!,id:'guard'},version:1,updatedAt:'2026-10-27T00:00:00Z'};}
function workflow():Workflow {return {...structuredClone(initialState().workflows[0]),policyRouting:bindPolicyRevision(policy())};}
function compactGraph(kind:'branch'|'rule'='branch'):PolicyGraph { return {version:1,entryNodeId:'check',nodes:[
  {id:'check',name:'조건 분기',kind,condition:{mode:'all',predicates:[{path:'/risk/score',operator:'gte',value:80}]}},
  {id:'finish',name:'최종 처리',kind:'action',action:'main'},
],edges:[{id:'yes',from:'check',to:'finish',port:'true'},{id:'no',from:'check',to:'finish',port:'false'}]}; }

test('generic output keeps arbitrary nested schema without decision field',()=>{
  assert.deepEqual(policyOutputSchema(policy()),policy().outputSchema);assert.deepEqual(policyDefinitionErrors(policy()),[]);
  assert.equal(Object.prototype.hasOwnProperty.call((policyOutputSchema(policy()).properties as object),'decision'),false);
});
test('new binding uses explicit branch then rule then safe action',()=>{
  const bound=bindPolicyRevision(policy());assert.deepEqual(bound.routes,[]);assert.deepEqual(policyRoutingErrors(bound),[]);
  assert.equal(bound.graph!.nodes[0].kind,'branch');assert.equal(bound.graph!.nodes.at(-1)!.kind,'action');assert.equal((bound.graph!.nodes.at(-1)! as {errorCode:string}).errorCode,'POLICY_UNCONFIGURED');
});
test('schema path hints include nested arrays and escaped property names',()=>{
  const paths=policySchemaPaths({...policy().outputSchema,properties:{...(policy().outputSchema!.properties as object),'a/b~c':{type:'boolean'}}});
  assert.ok(paths.some(p=>p.path==='/risk/score'&&p.type==='number'));assert.ok(paths.some(p=>p.path==='/risk/categories/0'));assert.ok(paths.some(p=>p.path==='/a~1b~0c'));
});
test('schema field hints follow bounded local refs and compositions',()=>{
  assert.ok(policySchemaPaths({$defs:{R:{type:'object',properties:{score:{type:'number'}}}},type:'object',properties:{risk:{$ref:'#/$defs/R'}}}).some(p=>p.path==='/risk/score'));
  assert.doesNotThrow(()=>policySchemaPaths({$defs:{R:{$ref:'#/$defs/R'}},$ref:'#/$defs/R'}));
});
test('JSON pointer permits root, array paths and escapes but rejects malformed escapes',()=>{
  for(const p of ['', '/risk/score','/checks/0/matched','/a~1b/~0'])assert.equal(validPolicyPointer(p),true);
  for(const p of ['risk.score','/x~2','/~'])assert.equal(validPolicyPointer(p),false);
});
test('condition comparison requires typed JSON and bounded predicates',()=>{
  assert.deepEqual(policyConditionErrors({mode:'all',predicates:[{path:'/risk/score',operator:'gte',value:80}]}),[]);
  assert.ok(policyConditionErrors({mode:'all',predicates:[{path:'/risk/score',operator:'gte',value:'80'}]}).length);
  assert.ok(policyConditionErrors({mode:'any',predicates:[]}).length);
  assert.ok(policyConditionErrors({mode:'all',predicates:[{path:'',operator:'eq',value:undefined}]}).length);
});
test('null equality and missing existence are distinct supported conditions',()=>{
  assert.deepEqual(policyConditionErrors({mode:'all',predicates:[{path:'/x',operator:'eq',value:null},{path:'/missing',operator:'exists',value:false}]}),[]);
});
test('every condition must have one true and one false edge',()=>{
  const graph=createPolicyGraph();graph.edges.pop();assert.ok(policyGraphErrors(graph).some(m=>m.includes('참/거짓')));
});
for(const kind of ['branch','rule'] as const)test(`${kind} can start a two-node graph and connect directly to action`,()=>{
  const graph=compactGraph(kind);assert.deepEqual(policyGraphErrors(graph),[]);
  assert.deepEqual(policyRoutingErrors({...bindPolicyRevision(policy()),graph}),[]);
});
for(const [source,target] of [['branch','branch'],['rule','branch'],['rule','rule']] as const)test(`${source} can connect to a following ${target} condition`,()=>{
  const graph=createPolicyGraph();graph.nodes[0].kind=source;
  for(const node of graph.nodes)if(node.kind!=='action'&&node.id!==graph.entryNodeId)node.kind=target;
  assert.deepEqual(policyGraphErrors(graph),[]);
});
test('a condition can choose between an immediate action and another condition',()=>{
  const graph:PolicyGraph={...compactGraph(),nodes:[...compactGraph().nodes,
    {id:'next',name:'다음 조건',kind:'branch',condition:{mode:'all',predicates:[{path:'',operator:'exists'}]}},
  ],edges:[{id:'yes',from:'check',to:'next',port:'true'},{id:'no',from:'check',to:'finish',port:'false'},
    {id:'next-yes',from:'next',to:'finish',port:'true'},{id:'next-no',from:'next',to:'finish',port:'false'}]};
  assert.deepEqual(policyGraphErrors(graph),[]);
});
test('an edge into the entry condition remains invalid',()=>{
  const graph=createPolicyGraph();graph.edges[2].to=graph.entryNodeId;assert.ok(policyGraphErrors(graph).length);
});
test('empty drafts and action-only entries remain invalid for save',()=>{
  assert.ok(policyGraphErrors({version:1,entryNodeId:'',nodes:[],edges:[]}).length);
  const graph=compactGraph();graph.entryNodeId='finish';assert.ok(policyGraphErrors(graph).some(message=>message.includes('시작')));
});
test('unified conditions preserve the node and edge limits',()=>{
  const nodes=compactGraph();for(let i=0;i<23;i++)nodes.nodes.push({id:`extra-${i}`,name:'추가 처리',kind:'action',action:'main'});
  assert.ok(policyGraphErrors(nodes).some(message=>message.includes('24')));
  const edges=compactGraph();for(let i=0;i<47;i++)edges.edges.push({id:`extra-${i}`,from:'check',to:'finish',port:'true'});
  assert.ok(policyGraphErrors(edges).some(message=>message.includes('48')));
});
test('cycle is rejected even with an alternate terminal action',()=>{
  const graph=createPolicyGraph();graph.edges[2].to='policy-rule-true';assert.ok(policyGraphErrors(graph).some(m=>m.includes('순환')));
});
test('unreachable node is rejected',()=>{
  const graph=createPolicyGraph();graph.nodes.push({id:'orphan',name:'미연결',kind:'action',action:'main'});assert.ok(policyGraphErrors(graph).some(m=>m.includes('도달')));
});
test('action payload cannot return empty registered response',()=>{
  const graph=createPolicyGraph();graph.nodes[3]={id:'policy-action',name:'안내',kind:'action',action:'respond',responseText:''};assert.ok(policyGraphErrors(graph).some(m=>m.includes('안내 응답')));
});
test('fingerprint excludes display names but keeps schema, conditions and connections',()=>{
  const a=bindPolicyRevision(policy()),b=structuredClone(a);b.graph!.nodes[0].name='새 표시 이름';b.policy.name='새 이름';assert.deepEqual(policyExecutionConfiguration(a),policyExecutionConfiguration(b));
  (b.graph!.nodes[0] as {condition:{mode:string}}).condition.mode='any';assert.notDeepEqual(policyExecutionConfiguration(a),policyExecutionConfiguration(b));
});
test('generic schema examples accept null without inventing a decision',()=>{
  const p=policy();p.outputSchema={type:['null','string']};p.examples[0].expectedOutput=null;assert.deepEqual(policyDefinitionErrors(p),[]);assert.equal(isRecoverableWorkflow({...workflow(),policyRouting:bindPolicyRevision(p)}),true);
});
test('workflow recovery preserves generic schema and incomplete graph drafts',()=>{
  const w=workflow();w.policyRouting!.graph!.edges=[];assert.equal(isRecoverableWorkflow(w),true);
  w.policyRouting!.graph!.nodes[0].name='';assert.equal(isRecoverableWorkflow(w),true);
});
test('dataset preflight uses graph actions and rejects old decision expectations',()=>{
  const w=workflow(),dataset={id:'ds',name:'정책',description:'',rows:[{id:'r',input:'배송 문의',expected:'block' as const,expectedRoute:'error' as const,expectedPolicyCode:'POLICY_UNCONFIGURED'}]};
  assert.deepEqual(inspectDatasetCompatibility(dataset,w).issues,[]);
  assert.ok(inspectDatasetCompatibility({...dataset,rows:[{...dataset.rows[0],expectedDecision:'IN_SCOPE'}]},w).issues.some(i=>i.code==='missing_policy_decision'));
});
