import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { convertLegacyPolicy, createStructuredPolicy, editablePolicy, policyEditorBuffers, policyEditorSignature, policySchemaOutline, preparePolicyDraft, readPolicySchemaBuffer } from '../components/policy-editor-model.ts';
import type { PolicyDefinition, PolicyRevision } from '../lib/aegis-types';

function fixture() { let index=0; return createStructuredPolicy('guard', (prefix:string)=>`${prefix}-${++index}`); }
function legacy(): PolicyDefinition { return {id:'legacy',name:'기존 정책',description:'',prompt:'분류하세요.',connectionId:'guard',decisions:[{code:'YES',label:'범위 안',description:''},{code:'NO',label:'범위 밖',description:''}],examples:[{id:'example',input:'test',expectedDecision:'YES'}]}; }

test('new policy starts with nested objects and arrays without a mandatory decision field',()=>{
  const policy=fixture();assert.equal(policy.formatVersion,2);assert.deepEqual(policy.decisions,[]);assert.equal(policy.maxOutputTokens,1024);
  assert.deepEqual(policy.outputSchema!.required,['context','risk']);assert.equal(Object.hasOwn(policy.outputSchema!.properties as object,'decision'),false);
  assert.deepEqual(policy.examples.map(example=>(example.expectedOutput as {risk:{score:number}}).risk.score),[10,0,90]);
});
test('editable policy retains its exact output contract and examples while excluding revision metadata',()=>{
  const policy=fixture();const revision:PolicyRevision={...policy,version:4,updatedAt:'2026-10-27T00:00:00Z',connectionSnapshot:{id:'guard',name:'guard',role:'guard',mode:'demo',baseUrl:'',model:'demo',secretEnv:'',timeoutMs:10000}};
  const value=editablePolicy(revision);assert.deepEqual(value,policy);value.outputSchema!.title='local change';
  assert.equal(revision.outputSchema!.title,undefined);assert.equal(Object.hasOwn(value,'connectionSnapshot'),false);
});
test('malformed schema and example buffers produce blocking errors without mutating the saved draft',()=>{
  const policy=fixture(),original=structuredClone(policy),buffers=policyEditorBuffers(policy);buffers.schema='{';buffers.examples[policy.examples[0].id]='invalid';
  const prepared=preparePolicyDraft(policy,buffers);assert.equal(prepared.errors.length,2);assert.deepEqual(policy,original);
  assert.ok(prepared.errors.some(message=>message.includes('출력 스키마')));assert.ok(prepared.errors.some(message=>message.includes('1번 예제')));
});
test('latest raw schema and arbitrary JSON examples become the prepared save and test payload',()=>{
  const policy=fixture(),buffers=policyEditorBuffers(policy);
  buffers.schema='{"type":"array","items":{"type":["number","null"]}}';
  buffers.examples[policy.examples[0].id]='null';buffers.examples[policy.examples[1].id]='[1,null,3]';buffers.examples[policy.examples[2].id]='false';
  const prepared=preparePolicyDraft(policy,buffers);assert.deepEqual(prepared.errors,[]);
  assert.equal(prepared.value.outputSchema!.type,'array');assert.deepEqual(prepared.value.examples.map(example=>example.expectedOutput),[null,[1,null,3],false]);
  assert.equal(Object.hasOwn(prepared.value.examples[0],'expectedDecision'),false);
});
test('clearing a required expected JSON blocks saving rather than falling back to its old value',()=>{
  const policy=fixture(),buffers=policyEditorBuffers(policy);buffers.examples[policy.examples[0].id]='  ';
  const prepared=preparePolicyDraft(policy,buffers);assert.ok(prepared.errors.some(message=>message.includes('예상 JSON을 입력')));assert.equal(Object.hasOwn(prepared.value.examples[0],'expectedOutput'),false);
});
test('raw JSON edits participate in dirty and test signatures even before they parse',()=>{
  const policy=fixture(),buffers=policyEditorBuffers(policy),baseline=policyEditorSignature(policy,buffers);
  assert.notEqual(policyEditorSignature(policy,{...buffers,schema:'{'}),baseline);
  assert.notEqual(policyEditorSignature(policy,{...buffers,examples:{...buffers.examples,[policy.examples[0].id]:'['}}),baseline);
  assert.equal(policyEditorSignature(policy,{...buffers,examples:{...buffers.examples,removed:'invalid'}}),baseline);
});
test('explicit legacy conversion preserves existing policy and wraps expected decisions in JSON',()=>{
  const policy=legacy(),original=structuredClone(policy),schema={type:'object',properties:{decision:{type:'string',enum:['YES','NO']}},required:['decision'],additionalProperties:false};
  const converted=convertLegacyPolicy(policy,schema);assert.deepEqual(policy,original);assert.equal(converted.id,policy.id);assert.equal(converted.formatVersion,2);assert.deepEqual(converted.decisions,[]);
  assert.deepEqual(converted.examples,[{id:'example',input:'test',expectedOutput:{decision:'YES'}}]);assert.deepEqual(converted.outputSchema,schema);
  assert.deepEqual(preparePolicyDraft(policy,{schema:'invalid',examples:{example:'invalid'}}),{value:policy,errors:[]});
});
test('raw schema and expected JSON size checks measure encoded bytes',()=>{
  const policy=fixture(),buffers=policyEditorBuffers(policy);buffers.schema=JSON.stringify({type:'string',description:'가'.repeat(12000)});
  assert.ok(preparePolicyDraft(policy,buffers).errors.some(message=>message.includes('32KiB')));
  buffers.schema='{"type":"string"}';buffers.examples[policy.examples[0].id]=JSON.stringify('x'.repeat(65536));
  assert.ok(preparePolicyDraft(policy,buffers).errors.some(message=>message.includes('64KiB')));
});
test('JSON number overflow cannot silently serialize into null',()=>{
  const policy=fixture(),buffers=policyEditorBuffers(policy);buffers.examples[policy.examples[0].id]='1e400';
  assert.ok(preparePolicyDraft(policy,buffers).errors.some(message=>message.includes('유한한 숫자')));
  buffers.schema='{"type":"number","maximum":1e400}';assert.ok(preparePolicyDraft(policy,buffers).errors.some(message=>message.includes('출력 스키마')));
});
test('schema outline uses escaped paths and bounds complex schemas',()=>{
  const rows=policySchemaOutline({type:'object',properties:{'a/b':{type:'array',items:{type:'string'}},'til~de':{$ref:'#/$defs/value'}},required:['a/b']});
  assert.deepEqual(rows.map(row=>[row.path,row.type,row.required]),[['/','object',true],['/a~1b','array',true],['/a~1b/*','string',false],['/til~0de','참조',false]]);
  assert.equal(policySchemaOutline({type:'object',properties:Object.fromEntries(Array.from({length:150},(_,index)=>[String(index),{type:'string'}]))}).length,100);
});
test('visual editor reads only the current raw buffer and cannot expose a stale saved schema',()=>{
  const policy=fixture(),buffers=policyEditorBuffers(policy);
  assert.deepEqual(readPolicySchemaBuffer(buffers.schema).schema,policy.outputSchema);
  buffers.schema='{';assert.equal(readPolicySchemaBuffer(buffers.schema).schema,undefined);
  assert.ok(readPolicySchemaBuffer(buffers.schema).error);assert.ok(preparePolicyDraft(policy,buffers).errors.length);
});
test('switching schema editor views preserves complex keywords and raw formatting',()=>{
  const source='{\n "$defs": {"item":{"type":"string"}}, "oneOf": [{"$ref":"#/$defs/item"},{"type":"null"}]\n}';
  const before=source,parsed=readPolicySchemaBuffer(source);
  assert.equal(source,before);assert.deepEqual(parsed.schema,JSON.parse(source));assert.equal(parsed.error,undefined);
});
test('visual editor refuses invalid roots and unsafe buffers rather than normalizing them',()=>{
  for(const source of ['null','[]','false','{"type":"number","maximum":1e400}',JSON.stringify({description:'가'.repeat(12000)})]){
    const result=readPolicySchemaBuffer(source);assert.equal(result.schema,undefined);assert.ok(result.error);
  }
});
