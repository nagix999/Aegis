import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { addSchemaProperty, getSchemaNode, removeSchemaProperty, renameSchemaProperty, schemaBuilderTree, schemaEditable, setSchemaPropertyRequired, setSchemaType, updateSchemaNode } from '../lib/policy-schema-builder.ts';
import type { SchemaNode } from '../lib/policy-schema-builder';

function schema(): SchemaNode { return {type:'object',description:'운영 정책',properties:{risk:{type:'object',properties:{score:{type:'number',minimum:0,maximum:100,'x-unit':'percent'}},required:['score'],additionalProperties:false},checks:{type:'array',items:{type:'object',properties:{matched:{type:'boolean'}},required:['matched'],additionalProperties:false}}},required:['risk'],'x-annotation':{keep:['all','values']}}; }
const risk=['properties','risk'],score=[...risk,'properties','score'];

test('viewing and flattening never rewrite the source JSON or hidden annotations',()=>{
  const value=schema(),original=JSON.stringify(value),rows=schemaBuilderTree(value);
  assert.equal(JSON.stringify(value),original);assert.equal(rows.length,6);
  assert.deepEqual(rows.find(row=>row.label==='score')?.path,score);
  assert.equal(rows.find(row=>row.label==='score')?.required,true);
  assert.equal(rows.find(row=>row.label==='checks')?.required,false);
  assert.deepEqual(rows.find(row=>row.label==='matched')?.path,['properties','checks','items','properties','matched']);
});
test('nested field edits are immutable and preserve unrelated constraints and annotations',()=>{
  const value=schema(),original=structuredClone(value),edited=updateSchemaNode(value,score,{description:'위험 점수',maximum:90});
  assert.deepEqual(value,original);assert.notEqual(edited,value);
  assert.deepEqual(getSchemaNode(edited,score),{type:'number',minimum:0,maximum:90,'x-unit':'percent',description:'위험 점수'});
  assert.deepEqual(edited['x-annotation'],value['x-annotation']);
  assert.deepEqual(getSchemaNode(edited,['properties','checks']),getSchemaNode(value,['properties','checks']));
});
test('updater merges a patch and only explicit undefined removes a keyword',()=>{
  const value=schema(),edited=updateSchemaNode(value,score,()=>({maximum:undefined,description:'점수'}));
  assert.equal(Object.hasOwn(getSchemaNode(edited,score)!,'maximum'),false);
  assert.equal(getSchemaNode(edited,score)!['x-unit'],'percent');
  assert.equal(getSchemaNode(value,score)!.maximum,100);
});
test('adding object and array fields creates usable child schemas',()=>{
  const value=addSchemaProperty(addSchemaProperty(schema(),risk,'details','object'),risk,'labels','array');
  assert.deepEqual(getSchemaNode(value,[...risk,'properties','details']),{type:'object',properties:{},required:[],additionalProperties:false});
  assert.deepEqual(getSchemaNode(value,[...risk,'properties','labels']),{type:'array',items:{type:'string'}});
  const child=addSchemaProperty(value,[...risk,'properties','details'],'name');
  assert.deepEqual(getSchemaNode(child,[...risk,'properties','details','properties','name']),{type:'string'});
});
test('rename updates only the corresponding required name and preserves field ordering',()=>{
  const value=schema(),original=structuredClone(value),renamed=renameSchemaProperty(value,risk,'score','risk/score~value');
  assert.deepEqual(getSchemaNode(renamed,risk)!.required,['risk/score~value']);
  assert.equal(getSchemaNode(renamed,score),undefined);
  assert.deepEqual(getSchemaNode(renamed,[...risk,'properties','risk/score~value']),getSchemaNode(value,score));
  assert.deepEqual(value,original);
});
test('duplicate or blank names fail without modifying the source or silently trimming names',()=>{
  const value=schema(),original=structuredClone(value);
  assert.throws(()=>addSchemaProperty(value,risk,'score'),/같은 이름/);
  assert.throws(()=>addSchemaProperty(value,risk,'  '),/필드 이름/);
  assert.throws(()=>renameSchemaProperty(value,[],'risk','checks'),/같은 이름/);
  assert.deepEqual(value,original);
  const spaced=addSchemaProperty(value,risk,' spaced ');
  assert.ok(getSchemaNode(spaced,[...risk,'properties',' spaced ']));
  assert.equal(getSchemaNode(spaced,[...risk,'properties','spaced']),undefined);
});
test('required toggle and deletion preserve unrelated required declarations',()=>{
  const value={type:'object',properties:{a:{type:'string'},b:{type:'boolean'}},required:['a','outside']} as SchemaNode;
  const required=setSchemaPropertyRequired(value,[],'b',true);
  assert.deepEqual(required.required,['a','outside','b']);
  assert.deepEqual(setSchemaPropertyRequired(required,[],'a',false).required,['outside','b']);
  const removed=removeSchemaProperty(required,[],'a');
  assert.deepEqual(removed.required,['outside','b']);
  assert.equal(Object.hasOwn(removed.properties as object,'a'),false);
  assert.deepEqual(value.required,['a','outside']);
});
test('array item objects retain their constraints while child fields are edited',()=>{
  const value=addSchemaProperty(schema(),['properties','checks','items'],'label','string');
  const edited=setSchemaPropertyRequired(value,['properties','checks','items'],'label',true);
  assert.deepEqual(getSchemaNode(edited,['properties','checks','items'])!.required,['matched','label']);
  assert.equal(getSchemaNode(edited,['properties','checks','items'])!.additionalProperties,false);
});
test('advanced schemas lock structural edits but retain annotations and independent basic children',()=>{
  const value={...schema(),allOf:[{if:{properties:{risk:{required:['score']}}},then:{required:['checks']}}],$defs:{limit:{type:'number',maximum:100}}};
  assert.equal(schemaEditable(value).editable,false);
  assert.throws(()=>addSchemaProperty(value,[],'extra'),/참조|복합/);
  assert.throws(()=>renameSchemaProperty(value,[],'risk','changed'),/참조|복합/);
  const edited=updateSchemaNode(value,score,{description:'수정'});
  assert.deepEqual(edited.allOf,value.allOf);assert.deepEqual(edited.$defs,value.$defs);
  const described=updateSchemaNode(value,[],{description:'설명만 변경'});
  assert.deepEqual(described.allOf,value.allOf);
  assert.throws(()=>updateSchemaNode(value,[],{allOf:undefined}),/복합/);
});
test('refs, boolean schemas, tuples and multiple scalar types offer a JSON fallback',()=>{
  const value={type:'object',properties:{reference:{$ref:'#/$defs/value',description:'보존'},flag:true,mixed:{type:['string','number']},tuple:{type:'array',prefixItems:[{type:'string'}],items:false}}};
  const original=JSON.stringify(value),rows=schemaBuilderTree(value);
  for(const name of ['reference','flag','mixed','tuple'])assert.equal(rows.find(row=>row.label===name)!.locked,true);
  assert.equal(rows.find(row=>row.label==='reference')!.reason?.includes('JSON'),true);
  assert.equal(JSON.stringify(value),original);
  assert.throws(()=>setSchemaType(value,['properties','reference'],'string'),/참조|복합/);
});
test('type changes preserve scalar constraints or fail explicitly instead of dropping data',()=>{
  const value=schema(),original=structuredClone(value);
  assert.throws(()=>setSchemaType(value,risk,'string'),/하위 필드/);
  assert.throws(()=>setSchemaType(value,score,'string'),/제약/);
  assert.throws(()=>setSchemaType(value,['properties','checks'],'string'),/항목/);
  assert.deepEqual(value,original);
  const integer=setSchemaType(value,score,'integer',true);
  assert.deepEqual(getSchemaNode(integer,score)!.type,['integer','null']);
  assert.equal(getSchemaNode(integer,score)!.maximum,100);
});
test('new empty fields can change type while retaining their metadata',()=>{
  const empty={type:'object',properties:{},required:[],additionalProperties:false,description:'keep','x-custom':{original:true}};
  const array=setSchemaType(empty,[],'array');assert.deepEqual(array.items,{type:'string'});
  const number=setSchemaType(array,[],'number');assert.deepEqual(number,{type:'number',description:'keep','x-custom':{original:true}});
  assert.deepEqual(empty,{type:'object',properties:{},required:[],additionalProperties:false,description:'keep','x-custom':{original:true}});
});
test('nullable string enums are changed only by an explicit null toggle',()=>{
  const value={type:'string',enum:['billing','support'],description:'종류'};
  const nullable=setSchemaType(value,[],'string',true);
  assert.deepEqual(nullable.type,['string','null']);assert.deepEqual(nullable.enum,['billing','support',null]);
  assert.equal(schemaEditable(nullable).editable,true);
  assert.deepEqual(setSchemaType(nullable,[],'string',false),value);
  assert.deepEqual(value.enum,['billing','support']);
  const full={type:'string',enum:Array.from({length:32},(_,index)=>String(index))};
  assert.throws(()=>setSchemaType(full,[],'string',true),/32개/);
  assert.equal(full.enum.length,32);
  assert.throws(()=>updateSchemaNode(value,[],{enum:Array.from({length:33},(_,index)=>String(index))}),/32개/);
});
test('property keys that resemble JS internals are preserved without prototype mutation',()=>{
  const value=JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"},"a/b~c":{"type":"boolean"}},"required":["__proto__"]}') as SchemaNode;
  const before=Object.getPrototypeOf({});
  const renamed=renameSchemaProperty(value,[],'constructor','prototype');
  const extra=addSchemaProperty(renamed,[],'constructor','object');
  assert.equal(Object.getPrototypeOf(extra.properties),Object.prototype);
  assert.equal(Object.getPrototypeOf({}),before);
  assert.ok(Object.hasOwn(extra.properties as object,'__proto__'));
  assert.equal(getSchemaNode(extra,['properties','__proto__'])!.type,'string');
  assert.equal(getSchemaNode(extra,['properties','constructor'])!.type,'object');
  assert.equal(getSchemaNode(extra,['__proto__']),undefined);
  assert.equal(schemaBuilderTree(extra).find(row=>row.label==='a/b~c')!.id,'/properties/a~1b~0c');
  const removed=removeSchemaProperty(extra,[],'__proto__');assert.deepEqual(removed.required,[]);
  assert.equal(Object.hasOwn(value.properties as object,'__proto__'),true);
});
test('schema size and nesting errors do not partially apply changes',()=>{
  const value=schema(),original=structuredClone(value);
  assert.throws(()=>updateSchemaNode(value,score,{description:'가'.repeat(12000)}),/32KiB/);
  assert.deepEqual(value,original);
  let deep:SchemaNode={type:'string'};
  for(let index=0;index<14;index++)deep={type:'array',items:deep};
  assert.throws(()=>updateSchemaNode(deep,[],{description:'x'}),/깊이/);
});
