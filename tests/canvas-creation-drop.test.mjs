import * as policyChecks from '../lib/workflow-policy-checks.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {initialState} from '../lib/aegis-seed.ts';
import {nodeDefinitions,resolveLayout,layoutBounds,nodePort,NODE_WIDTH,NODE_HEIGHT,NODE_ICON_CENTER_Y} from '../lib/workflow-layout.ts';
import {getStageGraph} from '../lib/workflow-graph.ts';
import {previewConnection} from '../lib/workflow-connections.ts';
import {policyNodePorts} from '../lib/policy-graph.ts';
import {routeWorkflowEdge} from '../lib/workflow-edge-routing.ts';
import {canvasPortPoint,canvasPortHitArea,facingPortSides} from '../lib/workflow-port-geometry.ts';
import {getWorkflowCanvasLinks} from '../lib/workflow-policy-canvas.ts';

const source=await readFile(new URL('../components/workflow-canvas.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('canvas.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkflowCanvas');
const names=['setPendingLink','emptyTarget','dropSurface','emptyDropPoint','worldPoint','validSource','checkConnection','targetEndpoint','targetCheck','wireTarget','finishWire','cancelWire','endpointKey','connectionKey','anchorPoint','portShape','portSides','edgeSides'];
const chunks=names.map(name=>{const node=component.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.ok(node,name);return node.getText(tree);});
const code=ts.transpileModule(chunks.join('\n')+`\nglobalThis.actions={${names.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
class Surface {constructor(interactive=false){this.interactive=interactive;}closest(){return this.interactive?this:null;}}
function fixture(){
 const workflow=structuredClone(initialState().workflows[0]);
 workflow.pre=[{id:'a',name:'A',mode:'any',rules:[{id:'ar',name:'A',kind:'length',description:'',enabled:true,config:{maxLength:4000}}]}];workflow.post=[];delete workflow.graph;
 const nodes=nodeDefinitions(workflow),visible=resolveLayout(workflow),bounds=layoutBounds(nodes,visible),stageGraphs={pre:getStageGraph(workflow,'pre'),post:getStageGraph(workflow,'post')};
 const empty=new Surface(),interactive=new Surface(true),outside=new Surface();let surface=empty;
 const element={clientWidth:1400,clientHeight:700,clientLeft:0,clientTop:0,scrollLeft:0,scrollTop:0,getBoundingClientRect(){return{left:50,top:100,right:1450,bottom:800};},contains(target){return target!==outside;}};
 const created=[],connected=[],notices=[],chosen=[];const sourcePort={stage:'pre',endpoint:'start',port:'next'};
 const values={...policyChecks,workflow,nodes,visible,bounds,stageGraphs,nodePort,NODE_WIDTH,NODE_HEIGHT,NODE_ICON_CENTER_Y,canvasPortPoint,canvasPortHitArea,facingPortSides,policyChecks:policyChecks.listWorkflowPolicyChecks(workflow),edges:getWorkflowCanvasLinks(workflow).map(edge=>({...edge,kind:'flow'})),previewConnection,Element:Surface,Math,Boolean,
  zoom:1,canConnect:true,readOnly:false,connectionPreviews:new Map(),viewport:{current:element},wire:{current:undefined},wirePreview:undefined,linkSourceRef:{current:undefined},linkSource:undefined,suppressWireClick:{current:false},suppressClick:{current:false},suppressBackgroundClick:{current:false},graphSignature:JSON.stringify(stageGraphs),document:{elementFromPoint(){return surface;}},
  setWirePreview(value){values.wirePreview=value;},setLinkSource(value){values.linkSource=value;},setAnnouncement(message){notices.push(message);},notify(message){notices.push(message);},onCreateFromPort(value){created.push(value);},chooseTarget(stage,target){chosen.push({stage,target});},onConnect(...args){connected.push(args);},canvasEndpointLabel(_stage,endpoint){return endpoint;}};
 const context=vm.createContext(values);vm.runInContext(code,context);
 function point(world){return{clientX:50+(world.x+bounds.offsetX),clientY:100+(world.y+bounds.offsetY)};}
 function finish(world,overrides={}){values.wire.current={pointerId:1,source:sourcePort,moved:true,signature:values.graphSignature,...overrides};const position=point(world);context.actions.finishWire({pointerId:1,...position,stopPropagation(){},currentTarget:{hasPointerCapture(){return false;},releasePointerCapture(){}}});}
 return{values,actions:context.actions,workflow,nodes,visible,bounds,created,connected,chosen,notices,empty,interactive,outside,setSurface(value){surface=value;},finish,point};
}

test('dropping a source on empty canvas opens creation with clamped world coordinates',()=>{
 const f=fixture();f.finish({x:500,y:450});assert.equal(f.created.length,1);assert.deepEqual(JSON.parse(JSON.stringify(f.created[0])),{stage:'pre',from:'start',port:'next',position:{x:500-NODE_WIDTH/2,y:450-NODE_ICON_CENTER_Y}});assert.equal(f.values.linkSourceRef.current,undefined);assert.equal(f.chosen.length,0);
});
test('a real target still connects and never opens node creation',()=>{
 const f=fixture(),position=f.visible.main;f.setSurface(f.interactive);f.finish(nodePort(position,'left'));assert.deepEqual(f.chosen,[{stage:'pre',target:'end'}]);assert.equal(f.created.length,0);
});
test('invalid nearby nodes, control overlays, and points outside viewport do not create nodes',()=>{
 const node=fixture();node.setSurface(node.interactive);node.finish(nodePort(node.visible.input,'left'));assert.equal(node.created.length,0);assert.match(node.notices.at(-1),/입력/);
 const overlay=fixture();overlay.setSurface(overlay.interactive);overlay.finish({x:500,y:450});assert.equal(overlay.created.length,0);
 const outside=fixture();outside.setSurface(outside.outside);outside.finish({x:500,y:450});assert.equal(outside.created.length,0);
 const offscreen=fixture();offscreen.finish({x:2000,y:450});assert.equal(offscreen.created.length,0);
});
test('cancel, click without a drag, stale graph and read-only changes never create',()=>{
 const cancelled=fixture();cancelled.values.wire.current={pointerId:1,source:{stage:'pre',endpoint:'start',port:'next'},moved:true,signature:cancelled.values.graphSignature};cancelled.actions.cancelWire(true);cancelled.actions.finishWire({pointerId:1,stopPropagation(){},currentTarget:{hasPointerCapture(){return false;}}});assert.equal(cancelled.created.length,0);
 for(const kind of ['click','stale','readonly','disabled']){const f=fixture();if(kind==='readonly'){f.values.readOnly=true;f.values.canConnect=false;}if(kind==='disabled')f.values.canConnect=false;f.finish({x:500,y:450},kind==='click'?{moved:false}:kind==='stale'?{signature:'old'}:{});assert.equal(f.created.length,0,kind);}
});

test('auto-fit uses final bounds once, consumes its request and ignores superseded view commands',()=>{
 const effect=component.body.statements.find(statement=>ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)&&statement.expression.expression.getText(tree)==='useEffect'&&statement.getText(tree).includes('scheduleFit'));
 assert.ok(effect);const callback=effect.expression.arguments[0];
 const effectCode=ts.transpileModule(`globalThis.fitEffect=${callback.getText(tree)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const queue=new Map();let next=0,observations=0;const fitted=[],recorded=[],consumed=[];const element={clientWidth:1000,clientHeight:500,scrollLeft:900,scrollTop:800};
 const values={...policyChecks,autoFitRequest:1,fitRevision:0,lastAutoFit:{current:undefined},pendingFit:{current:undefined},viewCommand:{current:0},consumedFitCallback:{current(value){consumed.push(value);}},viewport:{current:element},fitActive:{current:false},fitLatest:{current:{workflowId:'w',bounds:{width:2000,height:800}}},workflow:{id:'w'},setZoom(value){fitted.push(value);},requestAnimationFrame(callback){queue.set(++next,callback);return next;},cancelAnimationFrame(id){queue.delete(id);},ResizeObserver:class{observe(){observations++;}disconnect(){}},viewportCallback:{current(value){recorded.push(value);}},Math};
 const context=vm.createContext(values);vm.runInContext(effectCode,context);const cleanup=context.fitEffect();
 values.fitLatest.current.bounds={width:1600,height:600};
 function tick(){const frames=[...queue.values()];queue.clear();frames.forEach(frame=>frame());}
 tick();tick();assert.equal(fitted.at(-1),Math.min(1.25,976/1600,476/600));assert.equal(recorded.at(-1).zoom,fitted.at(-1));assert.deepEqual(consumed,[1]);assert.equal(values.pendingFit.current,undefined);
 element.clientWidth=700;const count=fitted.length;assert.equal(context.fitEffect(),undefined);tick();assert.equal(fitted.length,count);assert.equal(observations,0,'Later panel resize does not take ownership of zoom.');
 values.autoFitRequest=2;const cancelled=context.fitEffect();values.viewCommand.current++;tick();assert.equal(fitted.length,count);assert.deepEqual(consumed,[1]);cancelled();cleanup();assert.equal(queue.size,0);
});

test('folded row connections return through an empty band between rows',()=>{
 const visible={a:{x:800,y:0},b:{x:0,y:220}},obstacles=Object.entries(visible).map(([key,point])=>({key,...point,width:NODE_WIDTH,height:NODE_HEIGHT}));
 const target=nodePort(visible.b,'left');
 const routed=routeWorkflowEdge({start:nodePort(visible.a,'right'),end:{...target,x:target.x-8},sourceKey:'a',targetKey:'b',obstacles,minY:-72});
 const rail=routed.points[2].y;assert.ok(rail>NODE_HEIGHT&&rail<visible.b.y);assert.equal(routed.points[3].y,rail);assert.equal(routed.points.at(-1).y,target.y);assert.equal(routed.tx,target.x-8);
});

test('parallel Switch cases have separate mouse lanes without crossing middle cards',()=>{
 for(const size of [3,13])for(const blocked of [false,true]){
  const visible={'policy-node:switch':{x:0,y:0},'policy-node:action':{x:600,y:0},...(blocked?{blocker:{x:300,y:0}}:{})},obstacles=Object.entries(visible).map(([key,point])=>({key,...point,width:NODE_WIDTH,height:NODE_HEIGHT}));
  const target=nodePort(visible['policy-node:action'],'left');
  const routed=Array.from({length:size},(_,index)=>routeWorkflowEdge({start:nodePort(visible['policy-node:switch'],'right'),end:{...target,x:target.x-8},sourceKey:'policy-node:switch',targetKey:'policy-node:action',obstacles,parallelIndex:index,parallelCount:size,minY:-72}));
  assert.equal(new Set(routed.map(edge=>edge.d)).size,size);
  const rails=routed.map(edge=>edge.points.length===2?edge.sy:edge.points[2].y);
  for(let index=1;index<size;index++)assert.ok(rails[index]-rails[index-1]>=40,'Individual case hit areas remain separate.');
  if(blocked)assert.ok(rails.every(rail=>rail>NODE_HEIGHT+8),'The case lanes avoid the card between source and target.');
  for(const edge of routed){assert.equal(edge.sx,routed[0].sx);assert.equal(edge.sy,routed[0].sy);assert.equal(edge.tx,routed[0].tx);assert.equal(edge.ty,routed[0].ty);}
  assert.equal(visible['policy-node:switch'].x,0);assert.equal(visible['policy-node:action'].x,600);
 }
});

test('idle policy input ports let edges receive clicks and activate only after choosing a source',()=>{
 const names=['renderPolicyPorts','validPolicySource','pickPolicySource','connectPolicyNode','cancelPolicyWire','startPolicyWire','movePolicyWire','finishPolicyWire','portButtonGeometry','policyInputSides','portSides','edgeSides','anchorPoint','portShape'];
 const declarations=names.map(name=>component.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(tree));
 const code=ts.transpileModule(declarations.join('\n')+`;globalThis.actions={${names.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 const definitions=[{id:'branch',kind:'branch',name:'조건',condition:{mode:'all',predicates:[]}},{id:'action',kind:'action',name:'응답',action:'main'}];
 const workflow={policyRouting:{graph:{nodes:definitions}}},nodes=definitions.map(node=>({id:node.id,key:`policy-node:${node.id}`,kind:'policy-node'}));
 const visible={'policy-node:branch':{x:0,y:0},'policy-node:action':{x:240,y:0}},connected=[];
 const values={...policyChecks,workflow,nodes,visible,zoom:.22,canPolicyConnect:true,canConnect:false,policyNodePorts,NODE_WIDTH,NODE_HEIGHT,Math,edges:[],canvasPortPoint,canvasPortHitArea,facingPortSides,
  React:{createElement(type,props,...children){return{type,props,children};}},policySource:undefined,policySourceRef:{current:undefined},policyWire:{current:undefined},suppressPolicyClick:{current:false},
  policyPoint(key,side){return nodePort(visible[key],side);},worldPoint(x,y){return{x,y};},setPolicySource(value){values.policySource=value;},setPolicyWirePoint(){},cancelWire(){},setPendingLink(){},setAnnouncement(){},canvasNodeName(){return'조건';},onPolicyConnect(...args){connected.push(args);},onCreatePolicyFromPort:undefined};
 const context=vm.createContext(values);vm.runInContext(code,context);
 const targets=()=>context.actions.renderPolicyPorts().filter(port=>port.props['data-policy-connect-target']);
 for(const target of targets()){assert.equal(target.props.style.pointerEvents,'none');assert.equal(target.props.tabIndex,-1);assert.equal(target.props['aria-disabled'],true);assert.ok(target.children[0],'The input glyph stays visible.');}
 context.actions.pickPolicySource({id:'branch',port:'true'});
 for(const target of targets()){assert.equal(target.props.style.pointerEvents,'auto');assert.equal(target.props.tabIndex,0);assert.equal(target.props['aria-disabled'],false);}
 targets().find(target=>target.props['data-policy-connect-target']==='action').props.onClick({stopPropagation(){}});
 assert.deepEqual(connected,[['branch','action','true']]);assert.equal(values.policySource,undefined);assert.ok(targets().every(target=>target.props.style.pointerEvents==='none'));
 // Drag completion resolves the target by coordinates, even while idle input
 // buttons pass pointer events through to the connection lines.
 values.policyWire.current={pointerId:2,source:{id:'branch',port:'false'},moved:true};
 context.actions.finishPolicyWire({pointerId:2,clientX:250,clientY:20,currentTarget:{hasPointerCapture(){return false;}}});
 assert.deepEqual(connected,[['branch','action','true'],['branch','action','false']]);
});
