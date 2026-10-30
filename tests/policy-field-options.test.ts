import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import {policyFieldInfo,policyFieldOptions,policyFieldOperators,applyPolicySwitchValues,policySwitchDiff,policySwitchCoversField} from '../lib/policy-field-options.ts';
import type {PolicyGraph,PolicyGraphNode} from '../lib/aegis-types';
const schema={type:'object',required:['risk'],properties:{risk:{type:'object',required:['level'],properties:{level:{type:'string',enum:[' LOW ','HIGH']},score:{type:'number'}}},enabled:{type:['boolean','null']},fixed:{const:'x'},'a/b~c':{enum:[null,1,true,'1','true']}}};
const switchNode=():Extract<PolicyGraphNode,{kind:'switch'}>=>({id:'switch',name:'선택',kind:'switch',path:'/risk/level',cases:[{id:'low',value:' LOW '},{id:'old',value:'removed'}]});
const graph=():PolicyGraph=>({version:1,entryNodeId:'switch',nodes:[switchNode(),{id:'done',kind:'action',name:'응답',action:'main'}],edges:[{id:'low-edge',from:'switch',to:'done',port:'low'},{id:'old-edge',from:'switch',to:'done',port:'old'},{id:'default-edge',from:'switch',to:'done',port:'default'}]});

test('nested finite enum paths retain strict types, spaces and required availability',()=>{
  assert.deepEqual(policyFieldInfo(schema,'/risk/level'),{path:'/risk/level',types:['string'],values:[' LOW ','HIGH'],source:'schema',complete:true,required:true});
  const info=policyFieldInfo(schema,'/a~1b~0c');assert.deepEqual(info.values,[null,1,true,'1','true']);assert.equal(info.complete,true);assert.equal(info.required,false);
  assert.ok(policyFieldOptions(schema).some(option=>option.path==='/a~1b~0c'));
});
test('field choices retain human labels and descriptions, including referenced nested fields',()=>{
  const value={type:'object',properties:{risk:{$ref:'#/$defs/Risk'}},$defs:{Risk:{type:'object',properties:{level:{title:'위험 등급',description:'배송 요청의 위험도',enum:['low','high']}}}}};
  const field=policyFieldOptions(value).find(item=>item.path==='/risk/level');assert.equal(field?.title,'위험 등급');assert.equal(field?.description,'배송 요청의 위험도');
});
test('const and boolean nullable fields offer exact finite candidates without fabricating free values',()=>{
  assert.deepEqual(policyFieldInfo(schema,'/enabled').values,[false,true,null]);assert.equal(policyFieldInfo(schema,'/enabled').complete,true);
  assert.deepEqual(policyFieldInfo(schema,'/fixed').values,['x']);assert.equal(policyFieldInfo(schema,'/fixed').complete,true);
  assert.deepEqual(policyFieldInfo(schema,'/risk/score').values,[]);assert.equal(policyFieldInfo(schema,'/risk/score').source,'none');
});
test('enum and const restrictions intersect booleans and numbers without coercion',()=>{
  assert.deepEqual(policyFieldInfo({type:'boolean',enum:[true]},'').values,[true]);
  assert.deepEqual(policyFieldInfo({enum:[true,1,'1'],const:1},'').values,[1]);
  assert.deepEqual(policyFieldInfo({type:'integer',enum:[1,1.5]},'').values,[1]);
});
test('only saved example values and schema annotations supply free-field suggestions',()=>{
  const info=policyFieldInfo(schema,'/risk/score',[{expectedOutput:{risk:{score:2}}},{expectedOutput:{risk:{score:2}}},{expectedOutput:{risk:{score:'2'}}},{expectedOutput:{risk:{score:3}}}]);
  assert.deepEqual(info.values,[2,3]);assert.equal(info.source,'examples');assert.equal(info.complete,false);
  assert.deepEqual(policyFieldInfo({type:'string',default:' X ',examples:['Y']},'').values,['Y',' X ']);
});
test('bounded local references produce finite candidates while remote and cycles remain unknown',()=>{
  const value={type:'object',required:['decision'],properties:{decision:{$ref:'#/$defs/Decision'}},$defs:{Decision:{enum:['a','b']}}};
  assert.deepEqual(policyFieldInfo(value,'/decision').values,['a','b']);assert.equal(policyFieldInfo(value,'/decision').required,true);
  assert.ok(policyFieldOptions(value).some(option=>option.path==='/decision'));
  assert.equal(policyFieldInfo({$ref:'https://unrequested.invalid/schema'},'').complete,false);
  assert.equal(policyFieldInfo({$ref:'#/$defs/A',$defs:{A:{$ref:'#/$defs/A'}}},'').complete,false);
});
test('allOf intersects finite constraints and anyOf only proves completeness when every branch is bounded',()=>{
  assert.deepEqual(policyFieldInfo({allOf:[{enum:['a','b']},{enum:['b','c']}]},'').values,['b']);
  assert.deepEqual(policyFieldInfo({anyOf:[{const:'a'},{const:'b'}]},'').values,['a','b']);
  const partial=policyFieldInfo({anyOf:[{const:'a'},{type:'string'}]},'');assert.deepEqual(partial.values,['a']);assert.equal(partial.complete,false);
  assert.equal(policyFieldInfo({oneOf:[{type:'boolean'},{type:'null'}]},'').complete,true);
});
test('ambiguous and non-scalar paths never prove that the default is unreachable',()=>{
  assert.equal(policyFieldInfo({enum:[{},'a']},'').complete,false);
  assert.equal(policyFieldInfo({...schema,if:{properties:{mode:{const:'x'}}}},'/risk/level').complete,false);
  assert.equal(policyFieldInfo(schema,'invalid.path').source,'none');
  assert.equal(policyFieldInfo({type:'object',properties:{nested:{type:'object',required:['x'],properties:{x:{type:'boolean'}}}}},'/nested/x').required,false);
});
test('field operator choices narrow only known scalar or array types',()=>{
  assert.deepEqual(policyFieldOperators(schema,'/risk/score'),['eq','ne','gt','gte','lt','lte','in','exists']);
  assert.deepEqual(policyFieldOperators(schema,'/enabled'),['eq','ne','in','exists']);
  assert.ok(policyFieldOperators(schema,'/risk/level').includes('contains'));
  assert.equal(policyFieldOperators({},'/unknown').length,9);
});
test('applying selected values preserves typed matching IDs, wires, default and input graph',()=>{
  const value=graph(),before=structuredClone(value),diff=policySwitchDiff(value,'switch',[' LOW ','HIGH']);
  assert.deepEqual(diff,{kept:1,added:1,removed:1,removedConnections:1});
  const next=applyPolicySwitchValues(value,'switch',[' LOW ','HIGH']);
  assert.equal((next.nodes[0] as ReturnType<typeof switchNode>).cases[0].id,'low');assert.deepEqual(next.edges.map(edge=>edge.id),['low-edge','default-edge']);assert.deepEqual(value,before);
  assert.equal(policySwitchCoversField(schema,next.nodes[0] as ReturnType<typeof switchNode>),true);
});
test('case updates never reuse removed case IDs for a different typed value',()=>{
  const value=graph();(value.nodes[0] as ReturnType<typeof switchNode>).cases=[{id:'case-1',value:1},{id:'case-2',value:true}];value.edges[0].port='case-1';value.edges[1].port='case-2';
  const next=applyPolicySwitchValues(value,'switch',[true,'1']);assert.equal((next.nodes[0] as ReturnType<typeof switchNode>).cases[0].id,'case-2');assert.equal((next.nodes[0] as ReturnType<typeof switchNode>).cases[1].id,'case-3');assert.deepEqual(next.edges.map(edge=>edge.id),['old-edge','default-edge']);
});
test('candidate selection enforces twelve cases without silently truncating a 32-value enum',()=>{
  const values=Array.from({length:32},(_,index)=>index),info=policyFieldInfo({enum:values},'');assert.equal(info.values.length,32);assert.equal(info.complete,true);
  assert.throws(()=>applyPolicySwitchValues(graph(),'switch',values),/1~12/);assert.throws(()=>applyPolicySwitchValues(graph(),'switch',[]));assert.throws(()=>applyPolicySwitchValues(graph(),'switch',[1,1]));
  assert.equal((applyPolicySwitchValues(graph(),'switch',values.slice(0,12)).nodes[0] as ReturnType<typeof switchNode>).cases.length,12);
});
test('only required finite fully covered fields can fold default controls',()=>{
  const node={...switchNode(),cases:[{id:'a',value:' LOW '},{id:'b',value:'HIGH'}]};assert.equal(policySwitchCoversField(schema,node),true);
  assert.equal(policySwitchCoversField({...schema,required:[]},node),false);
  assert.equal(policySwitchCoversField(schema,{...node,cases:node.cases.slice(0,1)}),false);
  assert.equal(policySwitchCoversField(schema,{...node,path:'/risk/score'}),false);
});
