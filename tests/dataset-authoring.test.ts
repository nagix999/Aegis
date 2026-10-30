import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Dataset,Workflow} from '../lib/aegis-types';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import {applyDatasetBulkPatch,datasetSchemaImpacts,switchDatasetTemplates} from '../lib/dataset-authoring.ts';

function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const dataset=():Dataset=>({id:'dataset',name:'합성 기준',description:'',rows:[{id:'one',input:'  첫 요청  ',expected:'allow',expectedPolicyFields:[{path:'/risk/score',operator:'gte',value:80}]},{id:'two',input:'두 번째 요청',expected:'block',category:'기존'},{id:'three',input:'세 번째',expected:'allow'}]});
function workflow(values:unknown[]=['LOW','HIGH'],type:unknown='string'):Workflow{
 const state=initialState(),value=structuredClone(state.workflows[0]),connection=state.connections.find(connection=>connection.role!=='main')!;
 value.policyRouting={routes:[],policy:{id:'policy',name:'정책',description:'',prompt:'분류',connectionId:connection.id,connectionSnapshot:connection,version:3,updatedAt:'2026-10-30T00:00:00Z',formatVersion:2,decisions:[],examples:[{id:'must-not-infer',input:'MODEL_REQUEST',expectedOutput:{risk:{level:'ACTUAL_OR_EXAMPLE_VALUE'}}}],outputSchema:{type:'object',properties:{risk:{type:'object',properties:{level:{type,enum:values}},required:['level']}},required:['risk']}},graph:{version:1,entryNodeId:'switch',nodes:[{id:'switch',name:'경로',kind:'switch',path:'/risk/level',cases:[{id:'low',value:values[0] as string}]},{id:'end',name:'종료',kind:'action',action:'error',errorCode:'POLICY_BLOCKED',errorMessage:'제한'}],edges:[]}};
 return value;
}
test('bulk changes are explicit and immutable and leave requests and unselected verdicts untouched',()=>{
 const source=freeze(dataset()),before=structuredClone(source),patch={category:'새 분류',expectedPolicyFields:[{path:'/risk/score',operator:'eq' as const,value:0}]},next=applyDatasetBulkPatch(source,['one','two'],patch);
 assert.deepEqual(source,before);assert.equal(next.rows[0].expected,'allow');assert.equal(next.rows[1].expected,'block');assert.equal(next.rows[0].input,'  첫 요청  ');assert.deepEqual(next.rows[2],source.rows[2]);next.rows[0].expectedPolicyFields![0].value=9;assert.equal(patch.expectedPolicyFields[0].value,0);assert.equal(next.rows[1].expectedPolicyFields![0].value,0);
});
test('empty or stale selection and unsupported bulk fields fail before editing',()=>{
 for(const ids of [[],['missing'],['one','missing']])assert.throws(()=>applyDatasetBulkPatch(freeze(dataset()),ids,{expected:'block'}),/선택/);
 assert.throws(()=>applyDatasetBulkPatch(dataset(),['one'],{input:'unsafe'} as never),/검증 기준/);
});
test('schema mismatch reporting leaves stored expectations unchanged across policy versions',()=>{
 const source=freeze(dataset()),before=structuredClone(source),impacts=datasetSchemaImpacts(source.rows,{type:'object',properties:{risk:{type:'object',properties:{score:{type:'string'}},additionalProperties:false}},additionalProperties:false});
 assert.equal(impacts.length,1);assert.equal(impacts[0].rowId,'one');assert.equal(impacts[0].index,0);assert.deepEqual(source,before);assert.deepEqual(datasetSchemaImpacts(source.rows),[]);
});
test('Switch templates copy the configured pointer and exact literal without input or final answer',()=>{
 const source=freeze(workflow([' Low ','HIGH'])),before=structuredClone(source),result=switchDatasetTemplates(source,'switch');assert.equal(result.templates.length,2);
 assert.deepEqual(result.templates[0].expectedPolicyFields,[{path:'/risk/level',operator:'eq',value:' Low '}]);for(const row of result.templates){assert.equal(row.input,'');assert.equal('expected'in row,false);assert.equal('expectedRoute'in row,false);}assert.doesNotMatch(JSON.stringify(result),/MODEL_REQUEST|ACTUAL_OR_EXAMPLE_VALUE/);assert.deepEqual(source,before);
});
test('default template uses an uncovered schema value and distinguishes strict scalar types',()=>{
 const value=workflow([false,0,'0',null],['boolean','number','string','null']);const result=switchDatasetTemplates(value,'switch');assert.equal(result.templates.at(-1)!.expectedPolicyFields[0].value,0);assert.match(result.templates.at(-1)!.note,/기본 경로/);
 value.policyRouting!.graph!.nodes[0]={id:'switch',name:'경로',kind:'switch',path:'/risk/level',cases:[{id:'zero',value:0},{id:'false',value:false},{id:'string',value:'0'}]};assert.equal(switchDatasetTemplates(value,'switch').templates.at(-1)!.expectedPolicyFields[0].value,null);
});
test('default scenarios are omitted for covered finite values and ambiguous schemas',()=>{
 const value=workflow(['LOW']);assert.equal(switchDatasetTemplates(value,'switch').templates.length,1);
 value.policyRouting!.policy.outputSchema={type:'object',properties:{risk:{type:'object',properties:{level:{type:'string'}},required:['level']}},required:['risk']};assert.equal(switchDatasetTemplates(value,'switch').templates.length,1);assert.match(switchDatasetTemplates(value,'switch').defaultNotice,/확정할 수 없어/);
});
test('finite enum candidates with additional constraints are not assumed to be valid default inputs',()=>{
 const value=workflow(['LOW','HIGH']);value.policyRouting!.policy.outputSchema={type:'object',properties:{risk:{type:'object',properties:{level:{type:'string',enum:['LOW','HIGH'],minLength:8}}}}};assert.equal(switchDatasetTemplates(value,'switch').templates.filter(template=>template.expectedPolicyFields[0].operator==='eq').length,1);
});
test('invalid or unknown Switch drafts cannot manufacture test cases',()=>{
 const value=workflow();assert.throws(()=>switchDatasetTemplates(value,'missing'),/Switch/);value.policyRouting!.graph!.nodes[0]={id:'switch',name:'경로',kind:'switch',path:'not-pointer',cases:[{id:'low',value:'LOW'}]};assert.throws(()=>switchDatasetTemplates(value,'switch'),/Pointer/);
});
test('simple optional fields generate missing-field default cases separately from actual null',()=>{
 const value=workflow([null,'LOW'],['null','string']);value.policyRouting!.policy.outputSchema={type:'object',properties:{risk:{type:'object',properties:{level:{type:['null','string'],enum:[null,'LOW']}}}},required:['risk']};const result=switchDatasetTemplates(value,'switch');assert.deepEqual(result.templates[0].expectedPolicyFields,[{path:'/risk/level',operator:'eq',value:null}]);assert.deepEqual(result.templates.at(-1)!.expectedPolicyFields,[{path:'/risk/level',operator:'exists',value:false}]);assert.match(result.templates.at(-1)!.note,/null과는 다른/);assert.equal('expected'in result.templates.at(-1)!,false);
});
test('optional-field inference avoids references conditions dependencies and object size constraints',()=>{
 for(const extra of [{minProperties:1},{if:{properties:{enabled:{const:true}}},then:{required:['risk']}},{dependentRequired:{enabled:['risk']}},{$ref:'#/$defs/Root'}]){const value=workflow(['LOW']);value.policyRouting!.policy.outputSchema={type:'object',properties:{risk:{type:'object',properties:{level:{type:'string'}}}},...extra};assert.equal(switchDatasetTemplates(value,'switch').templates.length,1);}
 const nested=workflow(['LOW']);nested.policyRouting!.policy.outputSchema={type:'object',properties:{risk:{type:'object',properties:{level:{$ref:'#/$defs/Level'}}}}};assert.equal(switchDatasetTemplates(nested,'switch').templates.length,1);
});
