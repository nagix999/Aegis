import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as graphs from '../lib/workflow-graph.ts';
import * as connections from '../lib/workflow-connections.ts';
import * as branching from '../lib/workflow-branching.ts';
import {randomUuid} from '../lib/client-id.ts';
import {initialState} from '../lib/aegis-seed.ts';
const source=await readFile(new URL('../components/workflow-graph-settings.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const element=(type,props)=>({type,props:props||{}});
function walk(tree,fn){const found=[];function visit(node){if(Array.isArray(node)){node.forEach(visit);return;}if(!node||typeof node!=='object')return;if(fn(node))found.push(node);visit(node.props?.children);}visit(tree);return found;}
function content(tree){if(Array.isArray(tree))return tree.map(content).join('');if(!tree||typeof tree==='boolean')return '';return typeof tree==='object'?content(tree.props?.children):String(tree);}
const cls=(tree,name)=>walk(tree,n=>String(n.props?.className||'').split(' ').includes(name));
const button=(tree,text)=>walk(tree,n=>n.type==='button'&&content(n)===text)[0];
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture({kind='condition',selected=true,edgeId,disabled=false,preset}={}){
 const workflow=structuredClone(initialState().workflows[0]);workflow.pre=[{id:'a',name:'요청 검사',mode:'any',rules:[{id:'ra',name:'길이',description:'',enabled:true,kind:'length',config:{maxLength:100}}]}];workflow.post=[];
 workflow.graph={version:1,pre:{nodes:[{id:'c',name:'문의 분류',kind,...(kind==='condition'?{condition:{operator:'contains',value:'',caseSensitive:false}}:{})}],edges:[{id:'entry',from:'start',to:'control:c',port:'next'},{id:'yes',from:'control:c',to:'group:a',port:kind==='condition'?'true':'next'},...(kind==='condition'?[{id:'no',from:'control:c',to:'end',port:'false'}]:[]),{id:'exit',from:'group:a',to:'end',port:'next'}]},post:{nodes:[],edges:[{id:'post',from:'start',to:'end',port:'next'}]}};
 const states=[],refs=[],effects=[],pending=[],changes=[],notices=[],selectedEdges=[];let si=0,ri=0,ei=0,tree;const actions={current:null};
 const props={workflow,stage:'pre',disabled,selectedControlId:selected?'c':undefined,selectedEdgeId:edgeId,initialPreset:preset,nodeActionsRef:actions,onStageChange(){},onChange:next=>{changes.push(next);props.workflow=next;},onSelectControl(){},onSelectEdge:id=>selectedEdges.push(id),notify:m=>notices.push(m),onFocusEndpoint(){},onAddNode(){}};
 const hooks={useState(initial){const i=si++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];},useRef(initial){const i=ri++;return refs[i]||(refs[i]={current:initial});},useEffect(fn,deps){const i=ei++,before=effects[i];if(!before||deps.some((v,j)=>!Object.is(v,before[j]))){effects[i]=deps;pending.push(fn);}},useImperativeHandle(ref,fn){ref.current=fn();}};
 const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,structuredClone,crypto:globalThis.crypto,requestAnimationFrame:fn=>{fn();return 1;},require(spec){if(spec==='@/lib/client-id')return{randomUuid};if(spec==='react')return hooks;if(spec==='react/jsx-runtime')return{jsx:element,jsxs:element};if(spec==='lucide-react')return new Proxy({},{get:(_,key)=>key});if(spec==='@/lib/workflow-graph')return graphs;if(spec==='@/lib/workflow-connections')return connections;if(spec==='@/lib/workflow-branching')return branching;if(spec.endsWith('.css'))return{};throw Error(spec);}});
 function render(){si=0;ri=0;ei=0;tree=module.exports.WorkflowGraphSettings(props);return tree;}function settle(){render();while(pending.length)pending.shift()();return render();}
 return{props,actions,changes,notices,selectedEdges,render,settle,get tree(){return tree;}};
}

test('a selected control and its true/false connections precede collapsed global configuration',()=>{
 const f=fixture();const tree=f.settle(),advanced=cls(tree,'wg-advanced')[0],selected=cls(tree,'wg-control-fields')[0];assert.equal(advanced.props.open,false);assert.ok(selected);assert.equal(cls(advanced,'wg-control-fields').length,0);assert.equal(cls(advanced,'wg-controls').length,1);assert.equal(cls(advanced,'wg-edges').length,1);assert.match(content(cls(tree,'wg-selected-connections')),/조건 충족.*길이.*그 외.*응답 생성 모델/);assert.equal(walk(tree,n=>n.type==='input'&&n.props['data-field-key']==='condition.value')[0].props['aria-invalid'],true);assert.match(content(selected),/포함 여부를 검사할 문구를 입력하세요/);
});
test('a selected connection is editable without expanding the global path list',()=>{
 const f=fixture({selected:false,edgeId:'yes'}),tree=f.settle(),advanced=cls(tree,'wg-advanced')[0];assert.equal(cls(tree,'wg-edge-form').length,1);assert.equal(cls(advanced,'wg-edge-form').length,0);assert.match(content(cls(tree,'wg-edge-form')),/선택한 연결선 수정/);assert.equal(advanced.props.open,false);
});
test('quick connection editing keeps the source and port and still requests a safe review',()=>{
 const f=fixture();f.settle();const next=cls(f.tree,'wg-selected-connections')[0];button(next,'다른 노드 연결').props.onClick();f.render();const form=cls(f.tree,'wg-edge-form')[0],selects=walk(form,n=>n.type==='select');assert.equal(selects[0].props.value,'control:c');assert.equal(selects[1].props.value,'true');assert.equal(cls(cls(f.tree,'wg-advanced')[0],'wg-edge-form').length,0);button(form,'연결선 추가').props.onClick();f.render();assert.equal(f.changes.length,0);assert.equal(cls(f.tree,'wg-connection-review').length,1);assert.match(content(cls(f.tree,'wg-connection-review')),/변경 전.*길이.*변경 후.*응답 생성 모델/);
});
test('existing connection shortcuts select the exact edge rather than changing the graph',()=>{
 const f=fixture();f.settle();cls(f.tree,'wg-selected-edge')[0].props.onClick();assert.deepEqual(f.selectedEdges,['yes']);assert.equal(f.changes.length,0);
});
test('header deletion ref preserves safe serial reconnection',()=>{
 const f=fixture({kind:'join'});f.settle();f.actions.current.deleteNode();assert.equal(f.changes.length,1);assert.equal(f.changes[0].graph.pre.nodes.length,0);assert.deepEqual(plain(f.changes[0].graph.pre.edges),[{id:'exit',from:'group:a',to:'end',port:'next'},{id:'entry',from:'start',to:'group:a',port:'next'}]);
});
test('branched deletion and read-only mutation remain blocked',()=>{
 const branch=fixture();branch.settle();branch.actions.current.deleteNode();assert.equal(branch.changes.length,0);assert.match(branch.notices[0],/연결을 먼저 정리/);
 const viewer=fixture({disabled:true});viewer.settle();viewer.actions.current.deleteNode();assert.equal(viewer.changes.length,0);assert.ok(walk(cls(viewer.tree,'wg-control-fields')[0],n=>n.type==='input'||n.type==='select').every(n=>n.props.disabled));assert.ok(walk(cls(viewer.tree,'wg-selected-connections')[0],n=>n.type==='button'&&content(n)==='다른 노드 연결').every(n=>n.props.disabled));
});
test('an explicit path preset opens the advanced configuration instead of hiding its inputs',()=>{
 const f=fixture({preset:{kind:'parallel',firstGroupId:'a',secondGroupId:'b',requestId:'request-1'}});f.settle();assert.equal(cls(f.tree,'wg-advanced')[0].props.open,true);
});

 test('starting a fresh connection leaves its form visible after the selected edge is cleared',()=>{
 const f=fixture({selected:false,edgeId:'yes'});f.settle();button(cls(f.tree,'wg-edge-form')[0],'새 연결').props.onClick();f.props.selectedEdgeId=undefined;f.settle();assert.equal(cls(f.tree,'wg-advanced')[0].props.open,true);assert.equal(cls(f.tree,'wg-edge-form').length,1);assert.match(content(cls(f.tree,'wg-edge-form')),/연결선 추가/);
 });
