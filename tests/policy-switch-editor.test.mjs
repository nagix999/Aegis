import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as graphHelpers from '../lib/policy-graph.ts';
import * as schemaHelpers from '../lib/policy-schema-guidance.ts';

const source=await readFile(new URL('../components/policy-graph-editor.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source+'\nexport {SwitchValueInput};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const element=(type,props)=>({type,props:props||{}});
function walk(tree,fn){const found=[];function visit(node){if(Array.isArray(node)){node.forEach(visit);return;}if(!node||typeof node!=='object')return;if(fn(node))found.push(node);visit(node.props?.children);}visit(tree);return found;}
function content(tree){if(Array.isArray(tree))return tree.map(content).join('');if(!tree||typeof tree==='boolean')return '';return typeof tree==='object'?content(tree.props?.children):String(tree);}
const plain=value=>JSON.parse(JSON.stringify(value));
const label=(tree,text)=>walk(tree,node=>node.props['aria-label']===text)[0];
const button=(tree,text)=>walk(tree,node=>node.type==='button'&&content(node)===text)[0];
const schema={type:'object',properties:{risk:{type:'object',properties:{level:{type:['string','number','boolean','null']}}}}};
function plan(){return{version:1,entryNodeId:'switch',nodes:[{id:'switch',name:'위험 경로',kind:'switch',path:'/risk/level',cases:[{id:'low',value:' LOW '},{id:'high',value:null}]},{id:'finish',name:'응답',kind:'action',action:'main'},{id:'error',name:'오류',kind:'action',action:'error',errorCode:'POLICY_BLOCKED',errorMessage:'제한'}],edges:[{id:'low-edge',from:'switch',to:'finish',port:'low'},{id:'null-edge',from:'switch',to:'error',port:'high'},{id:'default-edge',from:'switch',to:'error',port:'default'}]};}
function fixture({component='PolicyGraphEditor',graph=plan(),value=' LOW ',disabled=false,onConnect}={}){
 const states=[],refs=[],effects=[],pending=[],changes=[],additions=[],selections=[];let si=0,ri=0,ei=0,tree;
 const props=component==='SwitchValueInput'?{value,label:'Switch 비교값 1',disabled,onChange:next=>{changes.push(next);props.value=next;}}:{graph,schema,disabled,nodeOnly:true,selectedNodeId:'switch',onConnect,onAddFromPort:(...args)=>additions.push(args),onSelectNode:id=>selections.push(id),onChange:next=>{changes.push(next);props.graph=next;}};
 const hooks={useId:()=> 'fields',useState(initial){const i=si++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];},useRef(initial){const i=ri++;return refs[i]||(refs[i]={current:initial});},useEffect(fn,deps){const i=ei++,before=effects[i];if(!before||deps.some((v,j)=>!Object.is(v,before[j]))){effects[i]=deps;pending.push(fn);}},useImperativeHandle(ref,fn){if(ref)ref.current=fn();}};
 const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,JSON,Map,Set,Number,document:{activeElement:null},require(spec){if(spec==='react')return hooks;if(spec==='react/jsx-runtime')return{jsx:element,jsxs:element};if(spec==='lucide-react')return new Proxy({},{get:(_,key)=>key});if(spec==='@/lib/client-id')return{randomUuid:()=> 'new-edge'};if(spec==='@/lib/policy-graph')return graphHelpers;if(spec==='@/lib/policy-schema-guidance')return schemaHelpers;throw Error(spec);}});
 function render(){si=0;ri=0;ei=0;tree=module.exports[component](props);return tree;}function settle(){render();while(pending.length)pending.shift()();return render();}
 return{props,changes,additions,selections,render,settle,get tree(){return tree;}};
}

test('Switch exposes one nested JSON Pointer and every case plus default output',()=>{
 const f=fixture(),tree=f.settle();assert.equal(label(tree,'Switch 필드 경로').props.value,'/risk/level');assert.ok(walk(tree,node=>node.type==='option'&&node.props.value==='/risk/level').length);assert.ok(label(tree,'Switch low 연결'));assert.ok(label(tree,'Switch high 연결'));assert.ok(label(tree,'Switch default 연결'));assert.match(content(tree),/null은 필드가 없는 경우와 구분/);assert.equal(label(tree,'정책 조건 조합'),undefined);
 label(tree,'Switch 필드 경로').props.onChange({target:{value:'/other/value'}});assert.equal(f.changes.at(-1).nodes[0].path,'/other/value');
});

test('typed string editing preserves case whitespace and the empty string exactly',()=>{
 const f=fixture({component:'SwitchValueInput'});for(const value of [' low ','','  ','Low']){f.settle();label(f.tree,'Switch 비교값 1').props.onChange({target:{value}});assert.equal(f.changes.at(-1),value);assert.equal(f.settle()&&label(f.tree,'Switch 비교값 1').props.value,value);}
});

test('explicit scalar type choices preserve number boolean and null without string coercion',()=>{
 const f=fixture({component:'SwitchValueInput'});for(const [kind,value]of [['number',0],['boolean',false],['null',null],['string','']]){f.settle();label(f.tree,'Switch 비교값 1 자료형').props.onChange({target:{value:kind}});assert.equal(f.changes.at(-1),value);f.settle();assert.equal(label(f.tree,'Switch 비교값 1 자료형').props.value,kind);}
 label(f.tree,'Switch 비교값 1 자료형').props.onChange({target:{value:'boolean'}});f.settle();label(f.tree,'Switch 비교값 1').props.onChange({target:{value:'true'}});assert.equal(f.changes.at(-1),true);
});

test('invalid number drafts keep their text while removing the last executable value',()=>{
 const f=fixture({component:'SwitchValueInput',value:1});f.settle();for(const value of ['-','', '1e', 'Infinity','9007199254740992']){label(f.tree,'Switch 비교값 1').props.onChange({target:{value}});assert.equal(f.changes.at(-1),undefined);f.render();assert.equal(label(f.tree,'Switch 비교값 1').props.value,value);assert.equal(label(f.tree,'Switch 비교값 1').props['aria-invalid'],true);}
 label(f.tree,'Switch 비교값 1').props.onChange({target:{value:'1e2'}});assert.equal(f.changes.at(-1),100);
});
test('a recovered unfinished numeric comparison opens as an empty invalid number input',()=>{
 const f=fixture({component:'SwitchValueInput',value:undefined});f.props.value=undefined;f.settle();assert.equal(label(f.tree,'Switch 비교값 1 자료형').props.value,'number');assert.equal(label(f.tree,'Switch 비교값 1').props.value,'');assert.equal(label(f.tree,'Switch 비교값 1').props['aria-invalid'],true);
});

test('removing a case removes only that case edge and retains the default and remaining IDs',()=>{
 const original=plan(),before=structuredClone(original),f=fixture({graph:original});f.settle();label(f.tree,'Switch 비교값 1 삭제').props.onClick();assert.deepEqual(original,before);const next=f.changes.at(-1);assert.deepEqual(plain(next.nodes[0].cases),[{id:'high',value:null}]);assert.deepEqual(next.edges.map(edge=>edge.id),['null-edge','default-edge']);f.settle();assert.equal(label(f.tree,'Switch 비교값 1 삭제').props.disabled,true);
});

test('adding cases allocates distinct IDs and exact values while retaining existing wiring',()=>{
 const graph=plan();graph.nodes[0].cases=[{id:'case-1',value:''},{id:'case-3',value:'새값'}];const before=structuredClone(graph),f=fixture({graph});f.settle();button(f.tree,'비교값 추가').props.onClick();const next=f.changes.at(-1);assert.deepEqual(graph,before);assert.equal(next.nodes[0].cases.at(-1).id,'case-2');assert.equal(next.nodes[0].cases.at(-1).value,'새값_새값');assert.deepEqual(plain(next.edges),before.edges);
});

test('every route can connect an existing target or create a node from its exact stable port',()=>{
 const calls=[],f=fixture({onConnect:(...args)=>calls.push(args)});f.settle();label(f.tree,'Switch high 연결').props.onChange({target:{value:'finish'}});label(f.tree,'Switch default 연결').props.onChange({target:{value:'finish'}});assert.deepEqual(calls,[['switch','finish','high'],['switch','finish','default']]);label(f.tree,'Switch 비교값 1 경로에 새 노드 추가').props.onClick();label(f.tree,'Switch 기본 경로에 새 노드 추가').props.onClick();assert.deepEqual(f.additions,[['switch','low'],['switch','default']]);
});

test('missing routes are visible and all thirteen selectors are available at the case limit',()=>{
 const graph=plan();graph.nodes[0].cases=Array.from({length:12},(_,index)=>({id:`case-${index}`,value:index}));graph.edges=[];const f=fixture({graph});f.settle();assert.equal(button(f.tree,'비교값 추가').props.disabled,true);assert.equal(walk(f.tree,node=>node.type==='select'&&String(node.props['aria-label']).startsWith('Switch ')).length,13);assert.ok(walk(f.tree,node=>node.type==='select').every(node=>node.props['aria-invalid']===true));assert.match(content(f.tree),/반드시 연결/);
});

test('the Switch editor prevents cycles while direct scalar case edits remain immutable',()=>{
 const graph=plan();graph.nodes.push({id:'back',name:'다시 분기',kind:'branch',condition:{mode:'all',predicates:[{path:'/risk/level',operator:'exists'}]}});graph.edges.push({id:'back-edge',from:'back',to:'switch',port:'true'});const before=structuredClone(graph),f=fixture({graph});f.settle();label(f.tree,'Switch low 연결').props.onChange({target:{value:'back'}});assert.equal(f.changes.length,0);assert.match(content(f.render()),/순환 연결/);const scalar=walk(f.tree,node=>typeof node.type==='function'&&node.type.name==='SwitchValueInput')[0];scalar.props.onChange(false);assert.equal(f.changes.at(-1).nodes[0].cases[0].value,false);assert.deepEqual(graph,before);
});

test('canvas output controls and label filtering share a stable selection with deleted-case fallback',async()=>{
 const source=await readFile(new URL('../components/workflow-canvas.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('workflow-canvas.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),canvas=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkflowCanvas'),helper=canvas.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='selectedSwitchPort');assert.ok(helper);
 const code=ts.transpileModule(helper.getText(tree)+'\nglobalThis.select=selectedSwitchPort;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context=vm.createContext({policyNodePorts:graphHelpers.policyNodePorts,switchPorts:{switch:'high'}});vm.runInContext(code,context);const node=plan().nodes[0];assert.equal(context.select(node),'high');node.cases=node.cases.filter(item=>item.id!=='high');assert.equal(context.select(node),'low');context.switchPorts.switch='default';assert.equal(context.select(node),'default');node.cases=[];context.switchPorts.switch='low';assert.equal(context.select(node),'default');
});
