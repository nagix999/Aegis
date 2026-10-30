import * as policyChecks from '../lib/workflow-policy-checks.ts';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {resolveLayout} from '../lib/workflow-layout.ts';
import {initialState} from '../lib/aegis-seed.ts';

const source=await readFile(new URL('../components/workflow-editor.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('workflow-editor.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const editor=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkflowEditor');
const names=['selectPolicyEdge','selectNode','openWorkflowSettings','closeInspector','togglePositionPin'];
const code=ts.transpileModule(names.map(name=>{
 const declaration=editor.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
 assert.ok(declaration,name);return declaration.getText(tree);
}).join('\n')+`\nglobalThis.actions={${names.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

function fixture(){
 const workflow=structuredClone(initialState().workflows[0]);
 workflow.policyRouting={graph:{nodes:[{id:'switch',kind:'switch',name:'값 선택',path:'/level',cases:[{id:'low',value:'low'},{id:'high',value:'high'}]},{id:'next',kind:'action',name:'응답',action:'main'}],edges:[{id:'edge-low',from:'switch',to:'next',port:'low'},{id:'edge-high',from:'switch',to:'next',port:'high'}]}};
 const focusCalls=[],scrollCalls=[];
 const node={dataset:{layoutKey:'policy-node:switch'},focus(options){focusCalls.push(options);},scrollIntoView(options){scrollCalls.push(options);}};
 const state={...policyChecks,workflow,resolveLayout,editingDisabled:false,selectedCanvasKey:'policy-node:switch',pinnedKeys:[],pinnedSelection:false,policyEdgeSequence:{current:0},inspectorOpen:false,panelMode:'workflow',selection:{kind:'main'},view:'builder',selectedKeys:['main'],library:{stage:'pre'},policyEdgeFocus:undefined,
  resetInspectorForNode(){},requestAnimationFrame(callback){callback();},
  editorRef:{current:{querySelectorAll(){return[node];},querySelector(){return node;}}},inspectorRef:{current:{focus(options){focusCalls.push(options);}}},
  visibleLayoutKey(_workflow,key){return key;},
  modify(change){const next=structuredClone(state.workflow);change(next);state.workflow=next;},
 };
 for(const [setter,key] of Object.entries({setPolicyEdgeFocus:'policyEdgeFocus',setInspectorTab:'inspectorTab',setSelectedKeys:'selectedKeys',setSelection:'selection',setPanelMode:'panelMode',setLibrary:'library',setInspectorOpen:'inspectorOpen',setView:'view'}))state[setter]=value=>{state[key]=value;};
 vm.runInContext(code,vm.createContext(state));
 return {state,actions:state.actions,focusCalls,scrollCalls};
}

test('edge selection uses edge identity when multiple Switch values share one target',()=>{
 const f=fixture(),before=structuredClone(f.state.workflow);
 f.actions.selectPolicyEdge('edge-low');
 assert.equal(f.state.policyEdgeFocus.edgeId,'edge-low');
 assert.equal(f.state.selection.id,'switch');assert.equal(f.state.inspectorOpen,true);
 f.actions.selectPolicyEdge('edge-high');
 assert.equal(f.state.policyEdgeFocus.edgeId,'edge-high');
 assert.equal(f.state.policyEdgeFocus.request,2);
 f.actions.selectPolicyEdge('edge-high');
 assert.equal(f.state.policyEdgeFocus.request,3,'Repeated clicks can reveal the same card again');
 assert.equal(f.scrollCalls.length,0,'Edge inspection keeps the canvas viewport in place');
 assert.deepEqual(f.state.workflow,before,'Selection does not change a saved graph');
});

test('a removed edge is ignored and selecting a node clears an old edge highlight',()=>{
 const f=fixture();f.actions.selectPolicyEdge('edge-low');
 const request=f.state.policyEdgeFocus;
 f.actions.selectPolicyEdge('removed');assert.equal(f.state.policyEdgeFocus,request);
 f.actions.selectNode({kind:'main'});assert.equal(f.state.policyEdgeFocus,undefined);
 assert.equal(f.state.inspectorTab,'settings');
});

test('closing the inspector preserves edits and selection and returns focus without scrolling',()=>{
 const f=fixture();f.actions.selectPolicyEdge('edge-high');
 f.state.workflow.description='아직 저장하지 않은 설명';
 const before=structuredClone(f.state.workflow),selection=f.state.selection;
 f.actions.closeInspector();
 assert.equal(f.state.inspectorOpen,false);assert.equal(f.state.selection,selection);
 assert.deepEqual(f.state.workflow,before);
 assert.equal(f.focusCalls.at(-1).preventScroll,true);
 f.actions.openWorkflowSettings();
 assert.equal(f.state.panelMode,'workflow');assert.equal(f.state.inspectorOpen,true);
 assert.deepEqual(f.state.workflow,before);
});

test('the header pin toggles one layout key and disabled editing cannot change it',()=>{
 const f=fixture(),before=structuredClone(f.state.workflow);
 f.actions.togglePositionPin();
 assert.deepEqual(Array.from(f.state.workflow.layout.pinnedKeys),['policy-node:switch']);
 assert.deepEqual(f.state.workflow.policyRouting,before.policyRouting);
 f.state.pinnedKeys=['policy-node:switch'];f.state.pinnedSelection=true;
 f.actions.togglePositionPin();assert.equal(f.state.workflow.layout.pinnedKeys.length,0);
 f.state.editingDisabled=true;const disabled=structuredClone(f.state.workflow);
 f.actions.togglePositionPin();assert.deepEqual(JSON.parse(JSON.stringify(f.state.workflow)),JSON.parse(JSON.stringify(disabled)));
});
