import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as graphHelpers from '../lib/policy-graph.ts';
import * as schemaHelpers from '../lib/policy-schema-guidance.ts';
import * as fieldHelpers from '../lib/policy-field-options.ts';

const source=await readFile(new URL('../components/policy-graph-editor.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const element=(type,props)=>({type,props:props||{}});
function walk(tree,test){const result=[];function visit(node){if(Array.isArray(node)){node.forEach(visit);return;}if(!node||typeof node!=='object')return;if(test(node))result.push(node);visit(node.props?.children);}visit(tree);return result;}
function text(node){return Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):node===undefined||node===null||typeof node==='boolean'?'':String(node);}
const route=(tree,port)=>walk(tree,node=>node.props['data-policy-route-port']===port)[0];
const selected=tree=>walk(tree,node=>String(node.props.className??'').split(' ').includes('policy-switch-route-selected'));
const schema={type:'object',required:['level'],properties:{level:{type:'string',enum:['LOW','HIGH']}}};
function plan(){return {version:1,entryNodeId:'switch',nodes:[{id:'switch',name:'수준 선택',kind:'switch',path:'/level',cases:[{id:'low',value:'LOW'},{id:'high',value:'HIGH'}]},{id:'finish',name:'같은 도착점',kind:'action',action:'main'}],edges:[{id:'low-edge',from:'switch',to:'finish',port:'low'},{id:'high-edge',from:'switch',to:'finish',port:'high'},{id:'default-edge',from:'switch',to:'finish',port:'default'}]};}
function fixture(){
 const states=[],refs=[],effects=[],pending=[],changes=[],frames=new Map();let si=0,ri=0,ei=0,frameId=0,tree;
 const props={graph:plan(),schema,disabled:false,nodeOnly:true,selectedNodeId:'switch',onChange:graph=>{props.graph=graph;changes.push(graph);}};
 const scroller={clientTop:1,clientHeight:260,scrollTop:100,getBoundingClientRect:()=>({top:50,bottom:310,height:260})},canvas={scrollTop:777,scrollLeft:333},page={scrollY:456};
 const cards=['low','high','default'].map(port=>({dataset:{policyRoutePort:port},tagName:port==='default'?'DETAILS':'DIV',open:false,getBoundingClientRect:()=>({top:500,bottom:650,height:150})}));
 const root={closest:selector=>selector==='.we-inspector-scroll'?scroller:null,querySelectorAll:()=>cards};
 const hooks={useState(initial){const index=si++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],value=>states[index]=typeof value==='function'?value(states[index]):value];},useRef(initial){const index=ri++;return refs[index]||(refs[index]={current:initial});},useEffect(fn,deps){const index=ei++,before=effects[index];if(!before||deps.some((value,j)=>!Object.is(value,before.deps[j]))){const entry={deps,cleanup:undefined};effects[index]=entry;pending.push(()=>{before?.cleanup?.();entry.cleanup=fn();});}},useImperativeHandle(ref,fn){if(ref)ref.current=fn();}};
 const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,JSON,Map,Set,Number,document:{activeElement:null},requestAnimationFrame(fn){const id=++frameId;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);},require(spec){if(spec==='react')return hooks;if(spec==='react/jsx-runtime')return{jsx:element,jsxs:element};if(spec==='lucide-react')return new Proxy({},{get:(_,name)=>name});if(spec==='@/lib/client-id')return{randomUuid:()=> 'new-edge'};if(spec==='@/lib/policy-graph')return graphHelpers;if(spec==='@/lib/policy-schema-guidance')return schemaHelpers;if(spec==='@/lib/policy-field-options')return fieldHelpers;if(spec==='./policy-field-picker')return{PolicyFieldPicker(){}};if(spec.endsWith('.css'))return{};throw Error(spec);}});
 function render(){si=0;ri=0;ei=0;tree=module.exports.PolicyGraphEditor(props);if(tree)tree.props.ref.current=root;return tree;}
 function settle(){render();while(pending.length)pending.shift()();return render();}
 function flushFrames(){for(const[id,fn]of [...frames]){frames.delete(id);fn();}}
 return{props,changes,scroller,cards,root,canvas,page,frames,render,settle,flushFrames,get tree(){return tree;}};
}

test('a selected edge highlights exactly its case even when all routes share the same target',()=>{
 const f=fixture(),before=structuredClone(f.props.graph);f.props.selectedEdgeId='high-edge';f.props.edgeFocusRequest=1;f.settle();assert.equal(selected(f.tree).length,1);const card=route(f.tree,'high');assert.equal(card.props['data-policy-selected-edge'],'high-edge');assert.equal(card.props['aria-current'],'true');assert.equal(card.props['aria-label'],'선택한 연결: 비교값 2');assert.match(text(card),/선택한 연결/);assert.equal(route(f.tree,'low').props['data-policy-selected-edge'],undefined);assert.deepEqual(f.props.graph,before);assert.equal(f.changes.length,0);
});
test('default edge selection unfolds a safely collapsed default card and repeated requests unfold it again',()=>{
 const f=fixture();f.settle();assert.equal(route(f.tree,'default').props.open,false);f.props.selectedEdgeId='default-edge';f.props.edgeFocusRequest=1;f.settle();assert.equal(route(f.tree,'default').props.open,true);assert.equal(route(f.tree,'default').props['aria-label'],'선택한 연결: 기본 경로');f.flushFrames();const card=f.cards.find(card=>card.dataset.policyRoutePort==='default');assert.equal(card.open,true);card.open=false;f.props.edgeFocusRequest=2;f.settle();f.flushFrames();assert.equal(card.open,true);assert.equal(f.changes.length,0);
});
test('default stays selected and open when its coverage presentation changes before a repeat focus request',()=>{
 const f=fixture();f.props.selectedEdgeId='default-edge';f.props.edgeFocusRequest=1;f.settle();f.flushFrames();f.props.schema={...schema,required:[]};f.settle();assert.equal(route(f.tree,'default').props.open,true);assert.equal(route(f.tree,'default').props['data-policy-selected-edge'],'default-edge');f.scroller.scrollTop=0;f.props.edgeFocusRequest=2;f.settle();f.flushFrames();assert.equal(f.scroller.scrollTop,437);assert.equal(f.changes.length,0);
});
test('scrolling a selected case moves only the inspector and can repeat for the same selected edge',()=>{
 const f=fixture();f.props.selectedEdgeId='low-edge';f.props.edgeFocusRequest=1;f.settle();f.flushFrames();assert.equal(f.scroller.scrollTop,537);assert.deepEqual(f.canvas,{scrollTop:777,scrollLeft:333});assert.equal(f.page.scrollY,456);f.scroller.scrollTop=0;f.props.edgeFocusRequest=2;f.settle();f.flushFrames();assert.equal(f.scroller.scrollTop,437);assert.deepEqual(f.canvas,{scrollTop:777,scrollLeft:333});assert.equal(f.page.scrollY,456);
});
test('selection disappears on edge removal case removal and node change and pending scrolling is cancelled',()=>{
 for(const mutation of [f=>{f.props.graph={...f.props.graph,edges:f.props.graph.edges.filter(edge=>edge.id!=='low-edge')};},f=>{f.props.graph=structuredClone(f.props.graph);f.props.graph.nodes[0].cases=f.props.graph.nodes[0].cases.filter(item=>item.id!=='low');},f=>{f.props.selectedNodeId='finish';},f=>{f.props.selectedNodeId='missing';}]){const f=fixture();f.props.selectedEdgeId='low-edge';f.props.edgeFocusRequest=1;f.settle();assert.equal(selected(f.tree).length,1);mutation(f);f.settle();assert.equal(selected(f.tree).length,0);f.flushFrames();assert.equal(f.scroller.scrollTop,100);}
});
test('editor callers without selection props retain their prior presentation and do not scroll',()=>{
 const f=fixture();f.settle();f.flushFrames();assert.equal(selected(f.tree).length,0);assert.equal(route(f.tree,'default').props.open,false);assert.equal(f.scroller.scrollTop,100);assert.equal(f.frames.size,0);assert.equal(f.changes.length,0);
});
test('selecting another edge does not close an existing case value editor or change its draft',()=>{
 const f=fixture();f.settle();const detail=walk(route(f.tree,'low'),node=>node.type==='details')[0];detail.props.onToggle({currentTarget:{open:true}});f.settle();assert.equal(walk(route(f.tree,'low'),node=>node.type==='details')[0].props.open,true);const before=structuredClone(f.props.graph);f.props.selectedEdgeId='high-edge';f.props.edgeFocusRequest=1;f.settle();assert.equal(walk(route(f.tree,'low'),node=>node.type==='details')[0].props.open,true);assert.deepEqual(f.props.graph,before);assert.equal(f.changes.length,0);
});
