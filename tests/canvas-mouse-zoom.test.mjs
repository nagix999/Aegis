import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source=await readFile(new URL('../components/workflow-canvas.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('canvas.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkflowCanvas');
const names=['consumeAutoFit','rememberViewport','setViewZoom','handleCanvasWheel'];
const listener=component.body.statements.find(node=>ts.isExpressionStatement(node)&&node.getText(tree).includes("element.addEventListener('wheel'"));
const code=ts.transpileModule(names.map(name=>component.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(tree)).join('\n')+`;globalThis.actions={${names.join(',')}};globalThis.mount=${listener.expression.arguments[0].getText(tree)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

class Surface {constructor(editable=false){this.editable=editable;}closest(){return this.editable?this:null;}}
function fixture(){
  const frames=new Map(),registered=[],removed=[],changes=[],reports=[];let serial=0;
  const element={clientWidth:800,clientHeight:500,clientLeft:2,clientTop:3,scrollLeft:300,scrollTop:400,
    getBoundingClientRect(){return{left:37,top:51};},addEventListener(...args){registered.push(args);},removeEventListener(...args){removed.push(args);}};
  const values={Math,Number,Element:Surface,viewport:{current:element},bounds:{width:5000,height:4000},zoomValue:{current:1},pendingZoomView:{current:undefined},wheelZoomHandler:{current:undefined},previousViewport:{current:undefined},searchMoveFrame:{current:undefined},viewCommand:{current:0},fitActive:{current:false},pendingFit:{current:undefined},autoFitRequest:0,consumedFitCallback:{current(){}},viewportCallback:{current(value){reports.push(value);}},setCanRestoreViewport(){},setZoom(value){changes.push(value);},requestAnimationFrame(callback){frames.set(++serial,callback);return serial;},cancelAnimationFrame(id){frames.delete(id);}};
  const context=vm.createContext(values);vm.runInContext(code,context);values.wheelZoomHandler.current=context.actions.handleCanvasWheel;
  function wheel(overrides={}){let prevented=0;const event={defaultPrevented:false,ctrlKey:true,metaKey:false,deltaY:-100,deltaMode:0,clientX:239,clientY:174,target:new Surface(),preventDefault(){prevented++;},...overrides};context.actions.handleCanvasWheel(event);return{event,prevented};}
  return{values,element,changes,reports,registered,removed,frames,actions:context.actions,mount:context.mount,wheel,flush(){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback());}};
}

test('Ctrl or Meta wheel preserves the pointer world position through borders and pending zoom frames',()=>{
  const f=fixture(),pointer={x:200,y:120},world={x:500,y:520};
  assert.equal(f.wheel().prevented,1);
  const first=f.changes.at(-1);assert.ok(first>1);
  // Two native events may arrive before React paints or scroll is adjusted.
  f.wheel({ctrlKey:false,metaKey:true});
  const zoom=f.changes.at(-1);assert.ok(zoom>first);assert.equal(f.frames.size,1);
  f.flush();
  assert.ok(Math.abs((f.element.scrollLeft+pointer.x)/zoom-world.x)<1e-9);
  assert.ok(Math.abs((f.element.scrollTop+pointer.y)/zoom-world.y)<1e-9);
  assert.equal(f.values.pendingZoomView.current,undefined);assert.equal(f.reports.at(-1).zoom,zoom);
});

test('wheel delta units, smooth trackpad input and zoom limits stay finite and consistent',()=>{
  const pixel=fixture(),line=fixture(),page=fixture();
  pixel.wheel({deltaY:-16});line.wheel({deltaY:-1,deltaMode:1});page.wheel({deltaY:-.032,deltaMode:2});
  assert.equal(pixel.changes.at(-1),line.changes.at(-1));assert.equal(pixel.changes.at(-1),page.changes.at(-1));
  const smooth=fixture();smooth.wheel({deltaY:-.3});assert.ok(smooth.changes.at(-1)>1&&smooth.changes.at(-1)<1.001);
  const limited=fixture();for(let index=0;index<12;index++)limited.wheel({deltaY:-10000});assert.equal(limited.changes.at(-1),1.5);
  assert.equal(limited.wheel({deltaY:-10000}).prevented,1,'A clamped zoom still suppresses browser page zoom.');
  for(let index=0;index<12;index++)limited.wheel({deltaY:10000});assert.equal(limited.changes.at(-1),.005);limited.flush();
  assert.ok(Number.isFinite(limited.element.scrollLeft));assert.ok(Number.isFinite(limited.element.scrollTop));
});

test('normal scrolling, invalid deltas and editable fields do not consume wheel events',()=>{
  const f=fixture();
  for(const event of [{ctrlKey:false},{deltaY:0},{deltaY:NaN},{defaultPrevented:true},{target:new Surface(true)}])assert.equal(f.wheel(event).prevented,0);
  assert.equal(f.changes.length,0);
});

test('native non-passive listener belongs only to the mounted viewport and is removed on JSON or page navigation',()=>{
  const f=fixture(),cleanup=f.mount();
  assert.equal(f.registered.length,1);const[type,handler,options]=f.registered[0];
  assert.equal(type,'wheel');assert.equal(options.passive,false);
  let prevented=0;handler({ctrlKey:true,metaKey:false,deltaY:-30,deltaMode:0,clientX:239,clientY:174,target:new Surface(),preventDefault(){prevented++;}});
  assert.equal(prevented,1);assert.equal(f.changes.length,1);
  cleanup();assert.equal(f.removed.length,1);assert.equal(f.removed[0][0],'wheel');assert.equal(f.removed[0][1],handler);
  assert.equal(f.values.pendingZoomView.current,undefined);
});

test('toolbar zoom keeps its existing viewport-center anchor',()=>{
  const f=fixture();f.actions.setViewZoom(1.2);f.flush();
  assert.equal(f.element.scrollLeft,(300+400)*1.2-400);
  assert.equal(f.element.scrollTop,(400+250)*1.2-250);
});
