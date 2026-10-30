import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {applyDatasetBulkPatch} from '../lib/dataset-authoring.ts';
import {assertionDraftErrors,fieldAssertionErrors} from '../lib/output-expectations.ts';
const source=await readFile(new URL('../components/datasets-page.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('datasets-page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='DatasetsPage'),names=['applyBulk','undoAuthoring','duplicateRow'];
const declaration=name=>component.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(tree);
const variable=name=>tree.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(tree)===name)).getText(tree);
const code=ts.transpileModule([variable('signature'),variable('authoringSignature'),...names.map(declaration),'globalThis.actions={'+names.join(',')+'};'].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const notices=[],host={JSON,Map,Set,Number,structuredClone,applyDatasetBulkPatch,assertionDraftErrors,fieldAssertionErrors,editing:{id:'dataset',name:'합성 기준',description:'',rows:[{id:'one',input:'  질문  ',expected:'allow'},{id:'two',input:'다른 질문',expected:'block'},{id:'three',input:'유지',expected:'allow'}]},writeLocked:false,checkedRows:['one','two'],bulkExpected:'',bulkCategoryEnabled:false,bulkCategory:'',bulkStage:'keep',bulkRoute:'keep',bulkFieldsEnabled:true,bulkFields:[{path:'/risk',operator:'eq',value:' HIGH '}],bulkDrafts:{},fieldDrafts:{one:{0:'"before"'}},requestDrafts:{},unconfirmedRows:['one'],selectedSchema:undefined,undoEdit:undefined,bulkOpen:true,newId:()=> 'copy',requestDraft:()=>({messages:'',options:''}),jumpToRow(){},change(patch){host.editing={...host.editing,...patch};},notify:message=>notices.push(message)};
 for(const [setter,key]of Object.entries({setEditing:'editing',setFieldDrafts:'fieldDrafts',setUnconfirmedRows:'unconfirmedRows',setUndoEdit:'undoEdit',setBulkOpen:'bulkOpen',setRequestDrafts:'requestDrafts'}))host[setter]=value=>{host[key]=typeof value==='function'?value(host[key]):value;};
 const context=vm.createContext(host);vm.runInContext(code,context);return {host,notices,actions:context.actions};
}
test('explicit bulk field replacement preserves final verdicts and undo restores the complete prior draft',()=>{
 const f=fixture(),before=plain(f.host.editing),drafts=plain(f.host.fieldDrafts);f.actions.applyBulk();assert.equal(f.host.editing.rows[0].expected,'allow');assert.equal(f.host.editing.rows[1].expected,'block');assert.equal(f.host.editing.rows[0].input,'  질문  ');assert.deepEqual(plain(f.host.unconfirmedRows),['one']);assert.deepEqual(plain(f.host.editing.rows[0].expectedPolicyFields),[{path:'/risk',operator:'eq',value:' HIGH '}]);assert.equal(f.host.editing.rows[2].expectedPolicyFields,undefined);f.actions.undoAuthoring();assert.deepEqual(plain(f.host.editing),before);assert.deepEqual(plain(f.host.fieldDrafts),drafts);
});
test('undo never discards later unfinished JSON edits even when the last valid dataset value is unchanged',()=>{
 const f=fixture();f.actions.applyBulk();f.host.fieldDrafts={one:{0:'-'}};const before=plain(f.host.editing);f.actions.undoAuthoring();assert.deepEqual(plain(f.host.editing),before);assert.equal(f.host.fieldDrafts.one[0],'-');assert.match(f.notices.at(-1),/이후 편집/);
});
test('duplicating a template row retains its unanswered final verdict requirement',()=>{
 const f=fixture();f.actions.duplicateRow('one');assert.deepEqual(plain(f.host.unconfirmedRows),['one','copy']);assert.equal(f.host.editing.rows[1].id,'copy');assert.equal(f.host.editing.rows[1].input,'  질문  ');
});
