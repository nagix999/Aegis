import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {datasetErrors,parseDatasetRequestSettings} from '../lib/dataset-io.ts';

const source=await readFile(new URL('../components/datasets-page.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('datasets-page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(value=>ts.isFunctionDeclaration(value)&&value.name?.text==='DatasetsPage');
const functions=['changeRow','changeRequest','save','openReproduction'];
const code=ts.transpileModule(functions.map(name=>{
  const node=component.body.statements.find(value=>ts.isFunctionDeclaration(value)&&value.name?.text===name);
  assert.ok(node,`Production handler ${name} exists`);return node.getText(tree);
}).join('\n')+'\nglobalThis.actions={'+functions.join(',')+'};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const calls=[],notices=[];
  const values={structuredClone,editing:{id:'dataset',name:'사례',description:'',updatedAt:'baseline-time',rows:[{id:'row',input:'배송 문의',expected:'allow'}]},writeLocked:false,conflict:false,atLimit:false,baselineUpdatedAt:'baseline-time',requestDrafts:{},requestTouched:false,parseDatasetRequestSettings,
    requestDraft:value=>({messages:value.messages?JSON.stringify(value.messages,null,2):'',options:value.generationOptions?JSON.stringify(value.generationOptions,null,2):''}),
    notify:value=>notices.push(value),newId:prefix=>`${prefix}-independent`,workflowId:'',target:'draft',closed:false,evaluated:[],
    close(){values.closed=true;},openEditor(dataset,fresh){values.opened={dataset,fresh};},row(){return {id:'row-blank',input:'',expected:'allow'};},onEvaluate(...args){values.evaluated.push(args);},async act(payload){calls.push(plain(payload));return {state:{datasets:[payload.dataset]}};},
  };
  for(const [setter,key] of Object.entries({setEditing:'editing',setRequestDrafts:'requestDrafts',setRequestTouched:'requestTouched',setShowErrors:'showErrors',setSaveError:'saveError',setLocalAction:'localAction',setQuery:'query',setCategory:'category',setSort:'sort'}))values[setter]=value=>{values[key]=typeof value==='function'?value(values[key]):value;};
  Object.defineProperty(values,'errors',{get(){const requestErrors=Object.values(values.requestDrafts).flatMap(draft=>{try{parseDatasetRequestSettings(draft.messages,draft.options);return [];}catch(error){return [error.message];}});return [...datasetErrors(values.editing),...requestErrors];}});
  const context=vm.createContext({...values});
  // Getters and setters share the state object used by the extracted production handlers.
  for(const key of Object.keys(values))Object.defineProperty(context,key,{configurable:true,get(){return values[key];},set(value){values[key]=value;}});
  Object.defineProperty(context,'errors',{configurable:true,get(){return values.errors;}});
  vm.runInContext(code,context);
  return {values,calls,notices,actions:context.actions};
}

test('unfinished conversation JSON stays in memory and cannot be saved as a previous valid value',async()=>{
  const f=fixture();
  f.actions.changeRequest('row','messages','[');
  assert.equal(f.values.requestDrafts.row.messages,'[');assert.equal(f.values.requestTouched,true);
  assert.equal(f.values.editing.rows[0].messages,undefined);
  await f.actions.save();assert.equal(f.calls.length,0);assert.equal(f.values.closed,false);assert.match(f.notices.at(-1),/JSON/);
  f.actions.changeRequest('row','messages','[{"role":"user","content":"  배송?  "}]');
  await f.actions.save();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].dataset.rows[0].messages,[{role:'user',content:'  배송?  '}]);
  assert.equal(f.calls[0].expectedUpdatedAt,'baseline-time');
});

test('a stale dataset preserves editing and can only save an independent copy or reload explicitly',async()=>{
  const f=fixture(),original=plain(f.values.editing);f.values.conflict=true;
  await f.actions.save();assert.equal(f.calls.length,0);assert.equal(f.values.closed,false);assert.deepEqual(plain(f.values.editing),original);
  await f.actions.save(false,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].expectedUpdatedAt,null);assert.notEqual(f.calls[0].dataset.id,original.id);assert.notEqual(f.calls[0].dataset.rows[0].id,original.rows[0].id);
  assert.equal(f.calls[0].dataset.name,'사례 복사');assert.deepEqual(plain(f.values.editing),original);
});

test('new dataset saves create-only and a failed request never closes or replaces edited content',async()=>{
  const f=fixture();f.values.baselineUpdatedAt=null;f.values.act=async payload=>{f.calls.push(plain(payload));return undefined;};
  f.actions.changeRequest('row','options','{"temperature":0.8,"max_tokens":512}');
  await f.actions.save();assert.equal(f.calls[0].expectedUpdatedAt,null);assert.equal(f.values.closed,false);assert.equal(f.values.editing.rows[0].generationOptions.temperature,0.8);assert.equal(f.values.localAction,'');assert.match(f.values.saveError,/입력 내용은 유지/);
});

test('an operational reproduction starts with blank input and explicit request metadata without writing records',()=>{
  const f=fixture();f.actions.openReproduction({requestId:'request-id',workflowName:'고객 상담',version:'v7'});
  assert.equal(f.calls.length,0);assert.equal(f.values.opened.fresh,true);
  const dataset=f.values.opened.dataset;assert.equal(dataset.name,'고객 상담 운영 사례');assert.equal(dataset.rows[0].input,'');assert.equal(dataset.rows[0].messages,undefined);
  assert.match(dataset.rows[0].note,/request-id/);assert.match(dataset.rows[0].note,/v7/);
  const blocked=fixture();blocked.values.atLimit=true;blocked.actions.openReproduction({requestId:'request-id',workflowName:'상담',version:'v7'});assert.equal(blocked.values.opened,undefined);assert.match(blocked.notices[0],/30개/);
});
