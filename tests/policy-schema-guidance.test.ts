import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node source runner resolves explicit TypeScript paths.
import {policySchemaField,policyValueInput,policyGraphSchemaIssues,policySchemaChanges,policyExampleIssues} from '../lib/policy-schema-guidance.ts';
// @ts-expect-error Node source runner resolves explicit TypeScript paths.
import {policyGraphErrors} from '../lib/policy-graph.ts';
import type {PolicyGraph,PolicyPredicate} from '../lib/aegis-types';

const schema={type:'object',properties:{risk:{type:'object',properties:{score:{type:'integer'},nullable:{type:['number','null']}},required:['score'],additionalProperties:false},topic:{type:'string',enum:['service','other']},enabled:{type:'boolean'},nothing:{type:'null'},mixed:{type:['boolean','number','string','null'],enum:[false,0,'0',null]},items:{type:'array',items:{type:'boolean'}},'a/b~c':{type:'string'}},required:['risk'],additionalProperties:false};
const predicate=(path:string,operator:PolicyPredicate['operator']='eq',value:unknown=80):PolicyPredicate=>({path,operator,value});
const graph=(p=predicate('/risk/score')):PolicyGraph=>({version:1,entryNodeId:'check',nodes:[{id:'check',name:'위험 확인',kind:'branch',condition:{mode:'all',predicates:[p]}},{id:'end',name:'종료',kind:'action',action:'main'}],edges:[{id:'yes',from:'check',to:'end',port:'true'},{id:'no',from:'check',to:'end',port:'false'}]});

test('closed nested schemas identify missing renamed fields and escape pointers',()=>{
  assert.equal(policySchemaField(schema,'/risk/score').status,'known');assert.equal(policySchemaField(schema,'/risk/severity').status,'missing');assert.equal(policySchemaField(schema,'/a~1b~0c').status,'known');assert.equal(policySchemaField(schema,'/items/0').schema?.type,'boolean');
});
test('open and composed schemas are conservative rather than reporting guessed errors',()=>{
  for(const s of [{type:'object'},{type:'object',additionalProperties:{type:'string'}},{anyOf:[schema,{}]},{$ref:'#/$defs/Thing',$defs:{Thing:schema}},{type:'object',patternProperties:{'.*':{type:'string'}},additionalProperties:false}])assert.equal(policySchemaField(s,'/unknown').status,'unknown');
  assert.deepEqual(policyGraphSchemaIssues(graph(predicate('/missing')),{$ref:'#/$defs/Thing',$defs:{Thing:schema}}),[]);
});
test('invalid pointer escapes remain an actionable path error',()=>{
  assert.equal(policySchemaField(schema,'/risk/~2').status,'missing');assert.equal(policySchemaField(schema,'risk.score').status,'missing');
});
test('typed input chooses numbers booleans null enum and nullable without coercion',()=>{
  assert.deepEqual(policyValueInput(schema,predicate('/risk/score')),{kind:'integer',nullable:false});assert.deepEqual(policyValueInput(schema,predicate('/risk/nullable')),{kind:'number',nullable:true});assert.equal(policyValueInput(schema,predicate('/enabled')).kind,'boolean');assert.equal(policyValueInput(schema,predicate('/nothing')).kind,'null');assert.deepEqual(policyValueInput(schema,predicate('/mixed')).values,[false,0,'0',null]);
});
test('string input is a string while membership and complex values keep JSON editing',()=>{
  assert.equal(policyValueInput({type:'string'},predicate('')).kind,'string');assert.equal(policyValueInput(schema,predicate('/topic','in',['service'])).kind,'json');assert.equal(policyValueInput({oneOf:[{type:'string'},{type:'number'}]},predicate('')).kind,'json');assert.equal(policyValueInput(schema,predicate('/items')).kind,'json');
});
test('array contains uses the item value editor rather than the array editor',()=>{
  assert.equal(policyValueInput(schema,predicate('/items','contains',true)).kind,'boolean');assert.deepEqual(policyGraphSchemaIssues(graph(predicate('/items','contains',true)),schema),[]);assert.equal(policyGraphSchemaIssues(graph(predicate('/items','contains','true')),schema)[0].code,'value');
});
test('diagnostics carry exact node predicate and pointer without comparison literal',()=>{
  const issue=policyGraphSchemaIssues(graph(predicate('/risk/severity','eq','PRIVATE_COMPARISON')),schema)[0];assert.deepEqual(issue,{nodeId:'check',nodeName:'위험 확인',predicateIndex:0,path:'/risk/severity',code:'path',message:'출력 스키마에 없는 필드입니다. 경로를 다시 선택하세요.'});assert.ok(!JSON.stringify(issue).includes('PRIVATE_COMPARISON'));
});
test('type diagnostics distinguish boolean numeric string null and integer values',()=>{
  for(const p of [predicate('/risk/score','eq','80'),predicate('/risk/score','eq',true),predicate('/risk/score','eq',1.5),predicate('/enabled','eq',1),predicate('/topic','eq',null)])assert.equal(policyGraphSchemaIssues(graph(p),schema)[0].code,'value');
  for(const p of [predicate('/risk/score','eq',80),predicate('/risk/nullable','eq',null),predicate('/enabled','eq',false),predicate('/risk/score','gte',80.5)])assert.deepEqual(policyGraphSchemaIssues(graph(p),schema),[]);
});
test('numeric operators and membership diagnose definite schema mismatches',()=>{
  assert.equal(policyGraphSchemaIssues(graph(predicate('/topic','gte',80)),schema)[0].code,'operator');assert.equal(policyGraphSchemaIssues(graph(predicate('/enabled','in',[true,1])),schema)[0].code,'value');assert.deepEqual(policyGraphSchemaIssues(graph(predicate('/topic','in',['service','other'])),schema),[]);
});
test('schema-aware graph validation blocks a renamed field before save',()=>{
  assert.ok(policyGraphErrors(graph(predicate('/risk/severity')),schema).some((message:string)=>message.includes('위험 확인 / 조건 1 / /risk/severity')));assert.deepEqual(policyGraphErrors(graph(),schema),[]);
});
test('schema change preview reports removed paths and type changes without mutating graph',()=>{
  const after=structuredClone(schema);delete (after.properties.risk.properties as Record<string,unknown>).score;after.properties.enabled.type='string';const changes=policySchemaChanges(schema,after);assert.ok(changes.some((change:{path:string;kind:string})=>change.path==='/risk/score'&&change.kind==='removed'));assert.ok(changes.some((change:{path:string;kind:string})=>change.path==='/enabled'&&change.kind==='type'));assert.equal(schema.properties.risk.properties.score.type,'integer');
});
test('expected JSON errors identify example and nested missing field path',()=>{
  const issues=policyExampleIssues(schema,[{id:'one',expectedOutput:{risk:{}}},{id:'two',expectedOutput:{risk:{score:10}}}]);assert.deepEqual(issues,[{exampleId:'one',exampleIndex:0,path:'/risk/score',message:'필수 값이 없습니다.'}]);
});
test('example comparisons preserve exact JSON types and object key order independence',()=>{
  assert.equal(policyExampleIssues({type:'boolean'},[{id:'x',expectedOutput:1}]).length,1);assert.deepEqual(policyExampleIssues({type:'object',enum:[{a:1,b:true}]},[{id:'x',expectedOutput:{b:true,a:1}}]),[]);assert.equal(policyExampleIssues({type:'null'},[{id:'x',expectedOutput:false}]).length,1);
});
test('example checks report escaped extra field and array item paths',()=>{
  const issues=policyExampleIssues(schema,[{id:'x',expectedOutput:{risk:{score:10},items:['true'],'extra/key':1}}]);assert.ok(issues.some((issue:{path:string})=>issue.path==='/extra~1key'));assert.ok(issues.some((issue:{path:string})=>issue.path==='/items/0'));
});
test('closed objects without declared properties reject extra example fields',()=>{
  assert.equal(policyExampleIssues({type:'object',additionalProperties:false},[{id:'x',expectedOutput:{unknown:1}}])[0].path,'/unknown');
});
test('example checks avoid false errors for union refs and conditional branches',()=>{
  for(const s of [{$ref:'#/$defs/R',$defs:{R:schema}},{anyOf:[schema,{type:'null'}]},{type:'object',if:{required:['x']},then:{required:['y']}}])assert.deepEqual(policyExampleIssues(s,[{id:'x',expectedOutput:null}]),[]);
});
test('numeric and unicode limits mirror unambiguous schema semantics',()=>{
  assert.deepEqual(policyExampleIssues({type:'string',maxLength:1},[{id:'x',expectedOutput:'😀'}]),[]);assert.equal(policyExampleIssues({type:'number',minimum:10},[{id:'x',expectedOutput:9}]).length,1);assert.equal(policyExampleIssues({type:'array',maxItems:1},[{id:'x',expectedOutput:[1,2]}]).length,1);
});
test('unknown predicate shapes do not crash guidance on incomplete drafts',()=>{
  assert.doesNotThrow(()=>policyGraphSchemaIssues({version:1,entryNodeId:'',nodes:[{}],edges:[]} as unknown as PolicyGraph,schema));
});
