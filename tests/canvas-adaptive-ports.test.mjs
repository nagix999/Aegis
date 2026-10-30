import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {initialState} from '../lib/aegis-seed.ts';
import {nodeDefinitions,executionEndpointKey,NODE_WIDTH,NODE_HEIGHT} from '../lib/workflow-layout.ts';
import {getStageGraph} from '../lib/workflow-graph.ts';
import {getWorkflowCanvasLinks} from '../lib/workflow-policy-canvas.ts';
import * as policyChecks from '../lib/workflow-policy-checks.ts';
import {canvasPortPoint,canvasPortHitArea,facingPortSides,offsetPortPoint} from '../lib/workflow-port-geometry.ts';
import {routeWorkflowEdge} from '../lib/workflow-edge-routing.ts';

const source=await readFile(new URL('../components/workflow-canvas.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('canvas.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkflowCanvas');
const names=['endpointKey','connectionKey','portShape','anchorPoint','edgeSides','portSides','portButtonGeometry','renderConnectionPorts','route'];
const code=ts.transpileModule(names.map(name=>component.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(tree)).join('\n')+`;globalThis.actions={${names.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;

function fixture(){
  const workflow=structuredClone(initialState().workflows[0]);delete workflow.policyRouting;delete workflow.graph;delete workflow.responseRetry;
  workflow.pre=['a','b'].map(id=>({id,name:id,mode:'any',rules:[{id:`${id}r`,name:id,kind:'keyword',description:'',enabled:true,config:{pattern:id}}]}));workflow.post=[];
  const nodes=nodeDefinitions(workflow),visible={input:{x:0,y:100},'rule:ar':{x:300,y:100},'rule:br':{x:300,y:400},main:{x:0,y:400},output:{x:0,y:700}};
  const values={...policyChecks,workflow,nodes,visible,stageGraphs:{pre:getStageGraph(workflow,'pre'),post:getStageGraph(workflow,'post')},edges:getWorkflowCanvasLinks(workflow).map(edge=>({...edge,kind:'flow',port:edge.port||'next'})),policyChecks:[],executionEndpointKey,canvasPortPoint,canvasPortHitArea,facingPortSides,offsetPortPoint,routeWorkflowEdge,NODE_WIDTH,NODE_HEIGHT,Math,Set,
    knownKeys:new Set(nodes.map(node=>node.key)),bounds:{offsetY:72},canConnect:true,zoom:1,wire:{current:undefined},linkSource:undefined,wirePreview:undefined,
    moveWire(){},finishWire(){},checkConnection(){return{valid:true};},canvasEndpointLabel(_stage,endpoint){return endpoint;},React:{createElement(type,props,...children){return{type,props,children};}}};
  const context=vm.createContext(values);vm.runInContext(code,context);
  return{values,actions:context.actions,ports:()=>context.actions.renderConnectionPorts()};
}
function glyphPoint(button){const glyph=button.children[0].props.style;return{x:button.props.style.left+glyph.left+4.5,y:button.props.style.top+glyph.top+4.5};}

test('real output buttons and arrow origins agree after horizontal, reversed and vertical moves',()=>{
  const f=fixture();
  for(const [position,side] of [[{x:600,y:100},'right'],[{x:0,y:100},'left'],[{x:300,y:400},'bottom'],[{x:300,y:-200},'top']]){
    f.values.visible['rule:br']=position;
    const output=f.ports().find(port=>port.props['data-connect-port']==='pre:group:a:next');
    assert.equal(output.props['data-port-side'],side);
    const edge=f.values.edges.find(edge=>edge.from==='rule:ar'&&edge.to==='rule:br'),route=f.actions.route(edge);
    assert.deepEqual(glyphPoint(output),{x:route.sx,y:route.sy});
    assert.doesNotMatch(route.d,/\bC\b/,'The preview and saved edge do not use a looping cubic curve.');
  }
});

test('shared outputs expose each connected side while idle incoming ports remain passive',()=>{
  const f=fixture();f.values.visible.main={x:0,y:100};
  f.values.edges.push({from:'rule:ar',to:'main',kind:'flow',port:'next'});
  const outputs=f.ports().filter(port=>port.props['data-connect-port']==='pre:group:a:next');
  assert.equal(outputs.map(port=>port.props['data-port-side']).sort().join(','),'bottom,left');
  assert.ok(f.ports().filter(port=>port.props.className.includes('target')).every(port=>port.props.style.pointerEvents==='none'&&port.props.tabIndex===-1));
  f.values.linkSource={stage:'pre',endpoint:'group:a',port:'next',side:'bottom'};
  const target=f.ports().find(port=>port.props['data-connect-port']==='pre:group:b:in');
  assert.equal(target.props['data-port-side'],'top');
  assert.equal(target.props.style.pointerEvents,'auto');assert.equal(target.props.tabIndex,0);
  const anchor=canvasPortPoint(f.values.visible['rule:br'],'top','circle');assert.deepEqual(glyphPoint(target),anchor);
});
