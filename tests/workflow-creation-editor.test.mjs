import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as layout from '../lib/workflow-layout.ts';
import * as zones from '../lib/workflow-zones.ts';
import * as graph from '../lib/workflow-graph.ts';
import * as creation from '../lib/workflow-node-creation.ts';
import * as connections from '../lib/workflow-connections.ts';
import * as history from '../lib/workflow-history.ts';
import {initialState} from '../lib/aegis-seed.ts';
import {makeRule,nodeCatalog} from '../lib/node-catalog.ts';

const source=await readFile(new URL('../components/workflow-editor.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('workflow-editor.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkflowEditor');
const helpers=['findRule','findGroup','findControl','detachGraphGroup','appendGraphGroup'];
const names=['openInsert','openFromPort','chooseCreation','resumeInsert','zoneBounds','zoneTransferIssue','addZone','setZoneMember','repairZones','inheritInsertedZone','zoneInsertionTarget','openLibrary','addComponent','addComponents','commit','modify','selectZone','selectControl','exitLibrary'];
function declaration(statements,name){const node=statements.find(item=>ts.isFunctionDeclaration(item)&&item.name?.text===name);assert.ok(node,name);return node.getText(tree);}
const code=ts.transpileModule([...helpers.map(name=>declaration(tree.statements,name)),...names.map(name=>declaration(component.body.statements,name)),`globalThis.actions={${names.join(',')}};`].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const check=index=>({id:`g${index}`,name:`검사 ${index}`,mode:'any',rules:[{id:`r${index}`,name:`검사 ${index}`,kind:'length',description:'',enabled:true,config:{maxLength:4000}}]});
function fixture(){
 const initial=initialState(),workflow={...structuredClone(initial.workflows[0]),pre:[1,2,3].map(check),post:[]};
 workflow.layout={version:1,positions:{input:{x:9000,y:9000}},zones:[]};
 const notices=[],changes=[];let sequence=0;
 const state={...layout,...zones,...graph,...creation,...connections,...history,structuredClone,JSON,Map,Set,crypto,makeRule,nodeCatalog,
  workflow,connections:initial.connections,editingDisabled:false,history:history.emptyWorkflowHistory(),library:undefined,pendingInsert:undefined,creation:undefined,policyChooser:false,newPolicyKey:'',conditionChooser:false,conditionTarget:'text',insertError:'',panelMode:'node',libraryReturnMode:'node',selection:{kind:'main'},selectedKeys:[],selectedTemplates:[],zoneQuery:'',autoFitRequest:0,view:'builder',inspectorOpen:false,
  editorRef:{current:null},inspectorRef:{current:null},pendingTextChange:{current:undefined},activeTextField:{current:undefined},
  id(prefix){return`${prefix}-editor-${++sequence}`;},notify(message){notices.push(message);},requestAnimationFrame(callback){callback();},
  onChange(next){state.workflow=next;changes.push(next);},revealSelection(selection){state.selection=selection;state.panelMode='node';state.inspectorOpen=true;}
 };
 Object.defineProperties(state,{zones:{get:()=>state.workflow.layout?.zones??[]},visibleNodes:{get:()=>layout.nodeDefinitions(state.workflow)},selectedZone:{get:()=>state.selection.kind==='zone'?state.workflow.layout?.zones?.find(zone=>zone.id===state.selection.id):undefined},creationTarget:{get:()=>state.creation?.targets.find(target=>target.edgeId===state.creation.edgeId)},libraryMinimum:{get:()=>state.library?.insert?.mode==='branch'?creation.previewParallelCheckOnEdge(state.workflow,state.library.insert.target).minimumNodes:1},libraryCapacity:{get:()=>36}});
 const properties={setPendingInsert:'pendingInsert',setInsertError:'insertError',setCreation:'creation',setLibrary:'library',setPolicyChooser:'policyChooser',setNewPolicyKey:'newPolicyKey',setConditionChooser:'conditionChooser',setConditionTarget:'conditionTarget',setLibraryReturnMode:'libraryReturnMode',setSelectedTemplates:'selectedTemplates',setLibraryQuery:'libraryQuery',setCategory:'category',setPanelMode:'panelMode',setInspectorOpen:'inspectorOpen',setView:'view',setAutoFitRequest:'autoFitRequest',setHistory:'history',setSelectedKeys:'selectedKeys',setSelection:'selection',setZoneQuery:'zoneQuery',setInitialPreset:'initialPreset',setGraphStage:'graphStage',setGraphControlId:'graphControlId',setGraphEdgeId:'graphEdgeId'};
 for(const [setter,key]of Object.entries(properties))state[setter]=value=>{state[key]=typeof value==='function'?value(state[key]):value;};
 vm.runInContext(code,vm.createContext(state));return{state,actions:state.actions,notices,changes};
}
const template=kind=>nodeCatalog.find(item=>item.kind===kind);
const plain=value=>JSON.parse(JSON.stringify(value));

test('edge plus chooses creation mode before selecting a node and inserts with one undo including layout',()=>{
 const f=fixture();f.state.workflow.layout.zones=[layout.createZoneForNodes(f.state.workflow,['rule:r1','rule:r2'],{id:'zone',name:'연속',color:'blue'})];
 const original=structuredClone(f.state.workflow),target=connections.captureInsertTarget(f.state.workflow,'pre','serial-2');
 f.actions.openInsert(target,{x:500,y:200});assert.equal(f.state.panelMode,'create');assert.equal(f.changes.length,0);assert.equal(f.state.library,undefined);
 f.actions.chooseCreation('insert');assert.equal(f.state.panelMode,'library');assert.equal(f.state.library.parallel,false);
 f.actions.addComponents([template('length')]);assert.equal(f.changes.length,1);assert.equal(f.state.history.past.length,1);assert.equal(f.state.autoFitRequest,1);
 assert.equal(f.state.workflow.pre.length,4);assert.deepEqual(graph.validateWorkflowGraph(f.state.workflow),[]);assert.deepEqual(zones.workflowZoneIssues(f.state.workflow),[]);
 assert.equal(f.state.workflow.layout.zones[0].nodeKeys.length,3);assert.notEqual(f.state.workflow.layout.positions.input.x,9000);
 assert.deepEqual(plain(f.state.history.past[0]),plain(original));
});

test('branch choice creates a check alongside the following check with valid fork and join',()=>{
 const f=fixture();f.actions.openInsert(connections.captureInsertTarget(f.state.workflow,'pre','serial-1'));f.actions.chooseCreation('branch');assert.equal(f.state.library.parallel,false);
 f.actions.addComponents([template('length')]);assert.equal(f.state.workflow.pre.length,4);assert.equal(f.state.workflow.graph.pre.nodes.filter(node=>node.kind==='fork').length,1);assert.equal(f.state.workflow.graph.pre.nodes.filter(node=>node.kind==='join').length,1);assert.deepEqual(graph.validateWorkflowGraph(f.state.workflow),[]);assert.equal(f.state.history.past.length,1);
});

test('empty path offers new parallel checks instead of a bypass or disconnected node',()=>{
 const f=fixture();f.actions.openFromPort({stage:'post',from:'start',port:'next',position:{x:300,y:220}});assert.equal(f.state.panelMode,'create');f.actions.chooseCreation('branch');assert.equal(f.state.library.parallel,true);assert.equal(f.state.libraryMinimum,2);
 f.actions.addComponents([template('length')]);assert.equal(f.changes.length,0);f.actions.addComponents([template('length'),template('keyword')]);assert.equal(f.state.workflow.post.length,2);assert.deepEqual(graph.validateWorkflowGraph(f.state.workflow),[]);assert.equal(f.state.autoFitRequest,1);
});

test('POST edge insertion resets a previous policy condition choice to response text',()=>{
 const f=fixture();f.state.conditionChooser=true;f.state.conditionTarget='policy';
 f.actions.openInsert(connections.captureInsertTarget(f.state.workflow,'post','serial-1'));
 f.actions.chooseCreation('insert');
 assert.equal(f.state.library.stage,'post');assert.equal(f.state.panelMode,'library');
 assert.equal(f.state.conditionChooser,false);assert.equal(f.state.conditionTarget,'text');
 assert.equal(f.changes.length,0);assert.equal(f.state.history.past.length,0);
});

test('new POST control selection uses the pending workflow before React publishes its update',()=>{
 const f=fixture(),nodeId='new-post-condition',next=structuredClone(f.state.workflow);
 next.graph={version:1,pre:structuredClone(graph.getStageGraph(next,'pre')),post:structuredClone(graph.getStageGraph(next,'post'))};
 next.graph.post.nodes.push({id:nodeId,name:'응답 조건',kind:'condition',condition:{operator:'contains',value:'확인',caseSensitive:false}});
 f.state.graphStage='pre';f.state.graphEdgeId='previous-edge';f.state.initialPreset={kind:'parallel'};
 assert.equal(graph.getStageGraph(f.state.workflow,'post').nodes.some(node=>node.id===nodeId),false);
 f.actions.selectControl(nodeId,true,next);
 assert.equal(f.state.graphStage,'post');assert.equal(f.state.graphControlId,nodeId);
 assert.deepEqual(plain(f.state.selection),{kind:'control',id:nodeId});
 assert.equal(f.state.panelMode,'graph');assert.equal(f.state.inspectorOpen,true);
 assert.equal(f.state.graphEdgeId,undefined);assert.equal(f.state.initialPreset,undefined);
 assert.equal(f.changes.length,0);assert.equal(f.state.history.past.length,0);
});

test('region creation and removal reject nonadjacent members and protect donor regions',()=>{
 const f=fixture();f.actions.addZone(['input','rule:r2','main']);assert.equal(f.changes.length,0);assert.ok(f.notices.length);
 f.actions.addZone(['rule:r1','rule:r2','rule:r3']);assert.equal(f.changes.length,1);assert.equal(f.state.workflow.layout.zones.length,1);
 f.actions.setZoneMember('rule:r2',false);assert.equal(f.changes.length,1,'Removing an interior member is rejected');
 f.actions.addZone(['rule:r2']);assert.equal(f.changes.length,1,'Moving an interior member to a different zone is rejected');
 f.actions.setZoneMember('rule:r3',false);assert.equal(f.changes.length,2);assert.deepEqual(plain(f.state.workflow.layout.zones[0].nodeKeys),['rule:r1','rule:r2']);
});

test('adding through an existing region inserts next to it and preserves contiguous membership',()=>{
 const f=fixture();f.actions.addZone(['rule:r1','rule:r2']);const zone=f.state.workflow.layout.zones[0];f.actions.openLibrary('pre','',false,zone.id);
 assert.equal(f.state.library.insert.target.from,'group:g2');f.actions.addComponents([template('length')]);assert.equal(f.state.workflow.layout.zones[0].nodeKeys.length,3);assert.deepEqual(zones.workflowZoneIssues(f.state.workflow),[]);
});

test('readonly and stale pending insertion do not create nodes or alter history',()=>{
 const f=fixture();f.state.editingDisabled=true;f.actions.openFromPort({stage:'pre',from:'start',port:'next',position:{x:1,y:1}});assert.equal(f.state.creation,undefined);f.actions.addZone(['rule:r1']);assert.equal(f.changes.length,0);
 f.state.editingDisabled=false;f.actions.openInsert(connections.captureInsertTarget(f.state.workflow,'pre','serial-1'));f.actions.chooseCreation('insert');f.state.workflow.pre.reverse();f.actions.addComponents([template('length')]);assert.equal(f.changes.length,0);assert.equal(f.state.history.past.length,0);assert.ok(f.state.insertError);
});


test('a stale single-node branch picker reports changed wiring instead of silently doing nothing',()=>{
 const f=fixture();f.actions.openInsert(connections.captureInsertTarget(f.state.workflow,'pre','serial-1'));f.actions.chooseCreation('branch');f.state.workflow.pre.reverse();f.actions.addComponents([template('length')]);assert.equal(f.changes.length,0);assert.ok(f.state.insertError);assert.ok(f.notices.length);
});
