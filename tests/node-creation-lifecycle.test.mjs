import * as policyChecks from '../lib/workflow-policy-checks.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {initialState} from '../lib/aegis-seed.ts';
import {autoLayout,createZoneForNodes,executionEndpointKey,knownLayoutKeys,nodeDefinitions,normalizedPinnedKeys,resolveLayout,visibleLayoutKey} from '../lib/workflow-layout.ts';
import {getStageGraph,validateWorkflowGraph} from '../lib/workflow-graph.ts';
import {captureInsertTarget,insertCheckOnEdge} from '../lib/workflow-connections.ts';
import {addParallelCheckOnEdge,captureCreationTargets,previewParallelCheckOnEdge} from '../lib/workflow-node-creation.ts';
import {reconcileContiguousZoneResult,workflowZoneIssues} from '../lib/workflow-zones.ts';
import {rememberWorkflowChange,restoreWorkflowHistory} from '../lib/workflow-history.ts';
import {configurationFingerprint} from '../lib/workflow-review.ts';
import {bindWorkflowPolicyNode,addWorkflowPolicyGraphNode,connectWorkflowPolicyNode} from '../lib/workflow-policy-nodes.ts';
import {getWorkflowCanvasLinks} from '../lib/workflow-policy-canvas.ts';
import {policyRoutingErrors} from '../lib/policy-routing.ts';
import {readWorkflowRecovery,saveWorkflowRecovery} from '../lib/workflow-recovery.ts';

// Invoke production editor actions with real graph/layout/history helpers.
const source=await readFile(new URL('../components/workflow-editor.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('workflow-editor.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkflowEditor');
const topNames=['detachGraphGroup','appendGraphGroup'];
const actionNames=['commit','zoneBounds','inheritInsertedZone','undo','redo','openFromPort','chooseCreation'];
function declaration(nodes,name){const node=nodes.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.ok(node,`production action ${name}`);return node.getText(tree);}
const code=ts.transpileModule([...topNames.map(name=>declaration(tree.statements,name)),...actionNames.map(name=>declaration(component.body.statements,name)),`globalThis.actions={${actionNames.join(',')}};`].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const plain=value=>JSON.parse(JSON.stringify(value));
function group(id){return{id,name:id,mode:'any',rules:[{id:`${id}-rule`,name:id,description:'',enabled:true,kind:'length',config:{maxLength:4000}}]};}
function fixture(){
 const app=initialState(),workflow=structuredClone(app.workflows[0]);workflow.pre=[group('one'),group('two'),group('three')];workflow.post=[];delete workflow.graph;
 workflow.layout={version:1,positions:{input:{x:2500,y:1800},main:{x:4200,y:1800}},zones:[{id:'checks',name:'인접 검사',color:'blue',nodeKeys:['rule:one-rule','rule:two-rule'],x:100,y:100,width:600,height:240}]};
 const notices=[];let sequence=0;
 const state={...policyChecks,workflow,structuredClone,autoLayout,createZoneForNodes,executionEndpointKey,knownLayoutKeys,nodeDefinitions,normalizedPinnedKeys,resolveLayout,visibleLayoutKey,getStageGraph,reconcileContiguousZoneResult,rememberWorkflowChange,restoreWorkflowHistory,captureCreationTargets,previewParallelCheckOnEdge,
   editingDisabled:false,history:{past:[],future:[]},pendingTextChange:{current:undefined},activeTextField:{current:undefined},autoFitRequest:0,editorRef:{current:{querySelector:()=>({clientWidth:900,clientHeight:500})}},
   pendingInsert:undefined,creation:undefined,library:undefined,policyChooser:false,newPolicyKey:'',conditionChooser:false,conditionTarget:'text',panelMode:'node',inspectorOpen:false,selectedTemplates:[],id:prefix=>`${prefix}-lifecycle-${++sequence}`,notify:message=>notices.push(message),openGraph:()=>{},
   onChange(next){state.workflow=next;},
 };
 for(const key of ['zones','visibleNodes','creationTarget'])Object.defineProperty(state,key,{get(){return key==='zones'?state.workflow.layout?.zones??[]:key==='visibleNodes'?nodeDefinitions(state.workflow):state.creation?.targets.find(target=>target.edgeId===state.creation.edgeId);}});
 const setters={setHistory:'history',setAutoFitRequest:'autoFitRequest',setCreation:'creation',setPendingInsert:'pendingInsert',setInsertError:'insertError',setLibrary:'library',setPolicyChooser:'policyChooser',setNewPolicyKey:'newPolicyKey',setConditionChooser:'conditionChooser',setConditionTarget:'conditionTarget',setPanelMode:'panelMode',setInspectorOpen:'inspectorOpen',setView:'view',setLibraryReturnMode:'libraryReturnMode',setSelectedTemplates:'selectedTemplates',setLibraryQuery:'libraryQuery',setCategory:'category'};
 for(const [setter,key]of Object.entries(setters))state[setter]=value=>{state[key]=typeof value==='function'?value(state[key]):value;};
 const context=vm.createContext(state);vm.runInContext(code,context);return{state,actions:context.actions,notices};
}

test('inserting between area members keeps the new node in that area and one undo restores layout and links',()=>{
 const f=fixture(),original=structuredClone(f.state.workflow),target=captureInsertTarget(original,'pre','serial-2'),inserted=insertCheckOnEdge(original,target,group('new'));
 f.actions.inheritInsertedZone(inserted,target,['rule:new-rule']);f.actions.commit(inserted);
 assert.deepEqual(workflowZoneIssues(f.state.workflow),[]);
 assert.deepEqual(new Set(f.state.workflow.layout.zones[0].nodeKeys),new Set(['rule:one-rule','rule:new-rule','rule:two-rule']));
 assert.deepEqual(validateWorkflowGraph(f.state.workflow),[]);assert.equal(f.state.autoFitRequest,1);assert.equal(f.state.history.past.length,1);
 assert.deepEqual(plain(f.state.workflow.layout.positions),autoLayout(f.state.workflow,{width:900,height:500}));
 const added=plain(f.state.workflow);f.actions.undo();assert.deepEqual(plain(f.state.workflow),plain(original));f.actions.redo();assert.deepEqual(plain(f.state.workflow),added);
});

test('a parallel addition inside an area keeps fork, both checks and join contiguous in one edit',()=>{
 const f=fixture(),before=structuredClone(f.state.workflow),target=captureInsertTarget(before,'pre','serial-2');let sequence=0;
 const built=addParallelCheckOnEdge(before,target,group('parallel'),{identifier:prefix=>`${prefix}-integrated-${++sequence}`});
 f.actions.inheritInsertedZone(built.workflow,target,['rule:parallel-rule']);f.actions.commit(built.workflow);
 assert.deepEqual(workflowZoneIssues(f.state.workflow),[]);assert.deepEqual(validateWorkflowGraph(f.state.workflow),[]);
 const members=f.state.workflow.layout.zones[0].nodeKeys;assert.ok(members.includes(`control:${built.splitId}`));assert.ok(members.includes(`control:${built.joinId}`));assert.ok(members.includes('rule:parallel-rule'));
 assert.equal(f.state.history.past.length,1);assert.equal(f.state.autoFitRequest,1);f.actions.undo();assert.deepEqual(plain(f.state.workflow),plain(before));
});

test('an empty-space output-port drop opens both creation choices without changing the graph',async()=>{
 const f=fixture(),before=structuredClone(f.state.workflow),fingerprint=await configurationFingerprint(before,initialState().connections);
 f.actions.openFromPort({stage:'post',from:'start',port:'next',position:{x:300,y:220}});
 assert.equal(f.state.panelMode,'create');assert.equal(f.state.creation.targets.length,1);assert.deepEqual(plain(f.state.workflow),plain(before));
 f.actions.chooseCreation('branch');assert.equal(f.state.library.parallel,true);assert.equal(f.state.library.insert.mode,'branch');assert.equal(f.state.library.stage,'post');
 assert.equal(previewParallelCheckOnEdge(f.state.workflow,f.state.library.insert.target).minimumNodes,2);
 assert.equal(await configurationFingerprint(f.state.workflow,initialState().connections),fingerprint);assert.equal(f.state.history.past.length,0);
});

test('node position edits preserve graph and inspection scale while read-only creation is inert',()=>{
 const f=fixture(),original=structuredClone(f.state.workflow),moved=structuredClone(original);moved.layout.positions.main={x:400,y:400};f.actions.commit(moved);
 assert.equal(f.state.autoFitRequest,0);assert.deepEqual(f.state.workflow.pre,original.pre);assert.deepEqual(f.state.workflow.graph,original.graph);
 f.state.editingDisabled=true;f.actions.openFromPort({stage:'pre',from:'start',port:'next',position:{x:100,y:100}});assert.equal(f.state.creation,undefined);assert.equal(f.state.library,undefined);
});

test('a policy insertion commits its real layout keys and routing in one undo without stale positions',()=>{
 const f=fixture(),original=structuredClone(f.state.workflow),connection=structuredClone(initialState().connections.find(item=>item.role!=='main'));
 const policy={id:'lifecycle-policy',name:'정책 삽입',description:'',prompt:'입력을 구조화하세요.',connectionId:connection.id,connectionSnapshot:connection,version:1,updatedAt:'2026-10-27T00:00:00Z',formatVersion:2,decisions:[],outputSchema:{type:'object',properties:{topic:{type:'string'}}},examples:[{id:'example',input:'배송',expectedOutput:{topic:'service'}}]};
 const next=bindWorkflowPolicyNode(f.state.workflow,policy),entry=next.policyRouting.graph.entryNodeId;
 next.layout.positions.policy={x:700,y:100};next.layout.positions[`policy-node:${entry}`]={x:900,y:100};next.layout.positions['policy-node:obsolete']={x:1000,y:100};
 next.layout.pinnedKeys=['input','policy',`policy-node:${entry}`,'policy-node:obsolete'];
 f.actions.commit(next);
 assert.equal(f.state.history.past.length,1);assert.equal(f.state.autoFitRequest,1);assert.equal(f.state.workflow.policyRouting.policy.version,1);
 assert.ok(f.state.workflow.layout.positions.policy);assert.ok(f.state.workflow.layout.positions[`policy-node:${entry}`]);assert.equal(Object.hasOwn(f.state.workflow.layout.positions,'policy-node:obsolete'),false);
 assert.deepEqual(plain(f.state.workflow.layout.pinnedKeys),['input','policy',`policy-node:${entry}`]);assert.deepEqual(workflowZoneIssues(f.state.workflow),[]);
 const added=plain(f.state.workflow);f.actions.undo();assert.deepEqual(plain(f.state.workflow),plain(original));f.actions.redo();assert.deepEqual(plain(f.state.workflow),added);
});

test('a policy model, one condition and a direct action use common commit, recovery and reversible graph edits',()=>{
 const f=fixture(),original=structuredClone(f.state.workflow),connection=structuredClone(initialState().connections.find(item=>item.role!=='main'));
 const policy={id:'individual-nodes',name:'개별 정책 노드',description:'',prompt:'입력을 구조화하세요.',connectionId:connection.id,connectionSnapshot:connection,version:1,updatedAt:'2026-10-27T00:00:00Z',formatVersion:2,decisions:[],outputSchema:{type:'object',properties:{topic:{type:'string'}}},examples:[{id:'example',input:'배송',expectedOutput:{topic:'service'}}]};
 f.actions.commit(bindWorkflowPolicyNode(f.state.workflow,policy,{emptyGraph:true}));
 assert.deepEqual(plain(f.state.workflow.policyRouting.graph),{version:1,entryNodeId:'',nodes:[],edges:[]});
 assert.equal(nodeDefinitions(f.state.workflow).filter(node=>node.kind==='policy').length,1);assert.equal(nodeDefinitions(f.state.workflow).filter(node=>node.kind==='policy-node').length,0);
 assert.ok(policyRoutingErrors(f.state.workflow.policyRouting).length>0);
 f.actions.commit(addWorkflowPolicyGraphNode(f.state.workflow,'branch','condition').workflow);
 const action=addWorkflowPolicyGraphNode(f.state.workflow,'action','action').workflow;
 action.policyRouting.graph.nodes[1]={id:'action',name:'Main 실행',kind:'action',action:'main'};f.actions.commit(action);
 f.actions.commit(connectWorkflowPolicyNode(f.state.workflow,'condition','action','true'));
 const incomplete=plain(f.state.workflow);assert.ok(policyRoutingErrors(f.state.workflow.policyRouting).length>0);
 f.actions.commit(connectWorkflowPolicyNode(f.state.workflow,'condition','action','false'));
 assert.deepEqual(policyRoutingErrors(f.state.workflow.policyRouting),[]);assert.equal(f.state.history.past.length,5);
 assert.deepEqual(f.state.workflow.policyRouting.graph.nodes.map(node=>node.kind),['branch','action']);
 const links=getWorkflowCanvasLinks(f.state.workflow);assert.ok(links.some(edge=>edge.from==='policy'&&edge.to==='policy-node:condition'));assert.ok(links.some(edge=>edge.from==='policy-node:action'&&edge.to==='main'));
 assert.ok(f.state.workflow.layout.positions['policy-node:condition']);assert.ok(f.state.workflow.layout.positions['policy-node:action']);assert.deepEqual(workflowZoneIssues(f.state.workflow),[]);
 const storage={value:null,getItem(){return this.value;},setItem(_key,value){this.value=value;},removeItem(){this.value=null;}},complete=plain(f.state.workflow);
 assert.equal(saveWorkflowRecovery(storage,f.state.workflow,original).ok,true);assert.deepEqual(readWorkflowRecovery(storage).records[0].draft,complete);
 f.actions.undo();assert.deepEqual(plain(f.state.workflow),incomplete);assert.ok(policyRoutingErrors(f.state.workflow.policyRouting).length>0);
 assert.equal(saveWorkflowRecovery(storage,f.state.workflow,original).ok,true);assert.deepEqual(readWorkflowRecovery(storage).records[0].draft,incomplete);
 f.actions.redo();assert.deepEqual(plain(f.state.workflow),complete);
 for(let index=0;index<5;index++)f.actions.undo();assert.deepEqual(plain(f.state.workflow),plain(original));
});
