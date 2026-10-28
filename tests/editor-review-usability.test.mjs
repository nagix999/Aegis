import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as layout from '../lib/workflow-layout.ts';
import * as zones from '../lib/workflow-zones.ts';
import {initialState} from '../lib/aegis-seed.ts';
const source=await readFile(new URL('../components/workflow-editor.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('editor.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const editor=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkflowEditor');
const names=['zoneTransferIssue','zoneBounds','completeSelectedZone','togglePositionPin'];
const code=ts.transpileModule(names.map(name=>editor.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(tree)).join('\n')+`\nglobalThis.actions={${names.join(',')}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const plain=value=>JSON.parse(JSON.stringify(value));
const check=id=>({id,name:id,mode:'any',rules:[{id:`r${id}`,name:id,kind:'length',description:'',enabled:true,config:{maxLength:100}}]});
function fixture(){
 const workflow={...initialState().workflows[0],pre:['a','b','c'].map(check),post:[],layout:{version:1,positions:{input:{x:900,y:600}},zones:[]}};
 const changes=[],notices=[];
 const state={...layout,...zones,workflow,editingDisabled:false,selectedCanvasKey:'input',selectedZoneId:'target',notify:m=>notices.push(m)};
 Object.defineProperties(state,{zones:{get:()=>state.workflow.layout.zones},selectedZone:{get:()=>state.workflow.layout.zones.find(z=>z.id===state.selectedZoneId)},pinnedKeys:{get:()=>layout.normalizedPinnedKeys(state.workflow)},pinnedSelection:{get:()=>layout.normalizedPinnedKeys(state.workflow).includes(state.selectedCanvasKey)}});
 state.modify=fn=>{const next=structuredClone(state.workflow);fn(next);state.workflow=next;changes.push(next);};
 vm.runInContext(code,vm.createContext(state));return {state,actions:state.actions,changes,notices};
}
function area(id,nodeKeys){return {id,name:id,color:'blue',nodeKeys,x:0,y:0,width:240,height:160};}
test('pinning keeps the current position and a second action releases it without changing execution',()=>{
 const f=fixture(),pre=structuredClone(f.state.workflow.pre);
 f.actions.togglePositionPin();assert.deepEqual(plain(f.state.workflow.layout.pinnedKeys),['input']);assert.deepEqual(plain(f.state.workflow.layout.positions.input),{x:900,y:600});assert.deepEqual(f.state.workflow.pre,pre);
 f.actions.togglePositionPin();assert.deepEqual(plain(f.state.workflow.layout.pinnedKeys),[]);assert.equal(f.changes.length,2);
 f.state.editingDisabled=true;f.actions.togglePositionPin();assert.equal(f.changes.length,2);
});
test('area completion adds only missing neighbors in a single edit',()=>{
 const f=fixture();f.state.workflow.layout.zones=[area('target',['rule:ra'])];
 f.actions.completeSelectedZone('rule:rc');assert.equal(f.changes.length,1);assert.deepEqual(plain(f.state.workflow.layout.zones[0].nodeKeys),['rule:ra','rule:rb','rule:rc']);assert.equal(zones.zoneMembershipIssue(f.state.workflow,f.state.workflow.layout.zones[0].nodeKeys),undefined);
});
test('area completion refuses to disconnect a donor area and is inert when readonly',()=>{
 const f=fixture();f.state.workflow.layout.zones=[area('target',[]),area('donor',['rule:ra','rule:rb','rule:rc'])];
 f.actions.completeSelectedZone('rule:rb');assert.equal(f.changes.length,0);assert.ok(f.notices.some(message=>message.includes('중간 노드')));
 f.state.editingDisabled=true;f.actions.completeSelectedZone('rule:rc');assert.equal(f.changes.length,0);
});
