import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {initialState} from '../lib/aegis-seed.ts';
import {nodeDefinitions,resolveLayout,layoutBounds,nodePort,NODE_WIDTH,NODE_HEIGHT,NODE_ICON_CENTER_Y} from '../lib/workflow-layout.ts';
import {getStageGraph} from '../lib/workflow-graph.ts';
import {previewConnection} from '../lib/workflow-connections.ts';

const source=await readFile(new URL('../components/workflow-canvas.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('canvas.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkflowCanvas');
const names=['setPendingLink','emptyTarget','dropSurface','emptyDropPoint','worldPoint','validSource','checkConnection','targetEndpoint','targetCheck','wireTarget','finishWire','cancelWire'];
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
 const values={workflow,nodes,visible,bounds,stageGraphs,nodePort,NODE_WIDTH,NODE_HEIGHT,NODE_ICON_CENTER_Y,previewConnection,Element:Surface,Math,Boolean,
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

test('auto-fit reads final bounds and refits after viewport resize without a timer',()=>{
 const effect=component.body.statements.find(statement=>ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)&&statement.expression.expression.getText(tree)==='useEffect'&&statement.getText(tree).includes('scheduleFit'));
 assert.ok(effect);const callback=effect.expression.arguments[0];
 const effectCode=ts.transpileModule(`globalThis.fitEffect=${callback.getText(tree)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const queue=new Map();let next=0,resize,disconnects=0;const fitted=[],recorded=[];const element={clientWidth:1000,clientHeight:500,scrollLeft:900,scrollTop:800};
 const values={autoFitRequest:1,fitRevision:0,viewport:{current:element},fitActive:{current:false},fitLatest:{current:{workflowId:'w',bounds:{width:2000,height:800}}},workflow:{id:'w'},setZoom(value){fitted.push(value);},requestAnimationFrame(callback){queue.set(++next,callback);return next;},cancelAnimationFrame(id){queue.delete(id);},ResizeObserver:class{constructor(callback){resize=callback;}observe(){}disconnect(){disconnects++;}},viewportCallback:{current(value){recorded.push(value);}},Math};
 const context=vm.createContext(values);vm.runInContext(effectCode,context);const cleanup=context.fitEffect();
 values.fitLatest.current.bounds={width:1600,height:600};
 function tick(){const frames=[...queue.values()];queue.clear();frames.forEach(frame=>frame());}
 tick();tick();assert.equal(fitted.at(-1),Math.min(1.25,976/1600,476/600));assert.equal(recorded.at(-1).zoom,fitted.at(-1));
 element.clientWidth=700;resize();tick();tick();assert.equal(fitted.at(-1),676/1600);
 values.fitActive.current=false;const count=fitted.length;resize();tick();assert.equal(fitted.length,count);
 cleanup();assert.equal(disconnects,1);assert.equal(queue.size,0);
});

test('folded row connections return through an empty band between rows',()=>{
 const names=['rect','route'];const declarations=names.map(name=>component.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(tree));
 const code=ts.transpileModule(declarations.join('\n')+';globalThis.routeEdge=route;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const visible={a:{x:800,y:0},b:{x:0,y:220}},nodes=Object.keys(visible).map(key=>({key}));
 const values={visible,nodes,nodePort,NODE_WIDTH,NODE_HEIGHT,Math,bounds:{offsetY:0},flowBounds:{height:400,offsetY:0}};
 const context=vm.createContext(values);vm.runInContext(code,context);const routed=context.routeEdge({from:'a',to:'b',kind:'flow'});
 const rail=routed.points[2].y;assert.ok(rail>NODE_HEIGHT&&rail<visible.b.y);assert.equal(routed.points[3].y,rail);assert.equal(routed.points.at(-1).y,nodePort(visible.b,'left').y);assert.ok(routed.d.endsWith(`H ${nodePort(visible.b,'left').x-8}`));
});
