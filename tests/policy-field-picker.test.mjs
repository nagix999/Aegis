import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as fieldHelpers from '../lib/policy-field-options.ts';
import * as graphHelpers from '../lib/policy-graph.ts';
const source=await readFile(new URL('../components/policy-field-picker.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const element=(type,props)=>({type,props:props||{}});
function nodes(tree,test){const result=[];const walk=node=>{if(Array.isArray(node)){node.forEach(walk);return;}if(!node||typeof node!=='object')return;if(test(node))result.push(node);walk(node.props?.children);};walk(tree);return result;}
function content(node){if(Array.isArray(node))return node.map(content).join('');return node&&typeof node==='object'?content(node.props.children):typeof node==='string'?node:'';}
function fixture(){
 const states=[],refs=[],changes=[],selections=[];let stateIndex=0,refIndex=0,tree;
 const props={schema:{type:'object',properties:{risk:{type:'object',properties:{level:{title:'위험 등급',description:'배송 요청 분류',enum:['LOW','HIGH']}}},enabled:{type:'boolean'}}},value:'',label:'출력 필드',disabled:false,onChange:value=>{changes.push(value);props.value=value;},onSelect:value=>selections.push(value)};
 const hooks={useId:()=> 'picker',useMemo:fn=>fn(),useRef:initial=>refs[refIndex++]??(refs[refIndex-1]={current:initial}),useState(initial){const index=stateIndex++;if(!(index in states))states[index]=initial;return[states[index],value=>states[index]=typeof value==='function'?value(states[index]):value];}};
 const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require(path){if(path==='react')return hooks;if(path==='react/jsx-runtime')return{jsx:element,jsxs:element};if(path==='lucide-react')return{ChevronDown:'ChevronDown',Search:'Search'};if(path==='@/lib/policy-field-options')return fieldHelpers;if(path==='@/lib/policy-graph')return graphHelpers;if(path.endsWith('.css'))return{};throw Error(path);}});
 const render=()=>{stateIndex=0;refIndex=0;tree=module.exports.PolicyFieldPicker(props);return tree;};
 return{props,render,changes,selections,get tree(){return tree;},input:()=>nodes(tree,node=>node.type==='input')[0]};
}
test('field picker searches nested field titles and descriptions and selects exact JSON Pointer',()=>{
 const f=fixture();f.render();f.input().props.onFocus();f.render();assert.ok(nodes(f.tree,node=>node.props.role==='option').length>=4);
 f.input().props.onChange({target:{value:'배송'}});f.render();const options=nodes(f.tree,node=>node.props.role==='option');assert.equal(options.length,1);assert.match(content(options[0]),/위험 등급/);options[0].props.onClick();assert.deepEqual(f.selections,['/risk/level']);assert.equal(f.props.value,'/risk/level');
});
test('keyboard selection supports Enter and preserves free pointer editing',()=>{
 const f=fixture();f.render();f.input().props.onChange({target:{value:'boolean'}});f.render();f.input().props.onKeyDown({key:'Enter',preventDefault(){}});assert.deepEqual(f.selections,['/enabled']);
 f.render();f.input().props.onChange({target:{value:'/a~1b/~0'}});f.render();assert.match(content(f.tree),/직접 입력/);f.input().props.onKeyDown({key:'Enter',preventDefault(){}});assert.equal(f.selections.at(-1),'/a~1b/~0');
});
test('field list remains available for a previously selected path and disabled controls do not expose options',()=>{
 const f=fixture();f.props.value='/risk/level';f.render();f.input().props.onFocus();f.render();assert.ok(nodes(f.tree,node=>node.props.role==='option').length>=4);
 f.props.disabled=true;f.render();assert.equal(f.input().props.disabled,true);assert.equal(nodes(f.tree,node=>node.props.role==='listbox').length,0);
});
test('blur commits only an edited valid pointer once and never repeats a selection or a cancelled search',()=>{
 const f=fixture();f.props.value='/risk/level';f.render();f.input().props.onFocus();f.input().props.onBlur();assert.equal(f.selections.length,0);
 f.render();f.input().props.onChange({target:{value:'/risk/other'}});f.render();f.input().props.onBlur();assert.deepEqual(f.selections,['/risk/other']);f.input().props.onBlur();assert.equal(f.selections.length,1);
 f.render();f.input().props.onChange({target:{value:'/enabled'}});f.render();f.input().props.onKeyDown({key:'Enter',preventDefault(){}});f.render();f.input().props.onBlur();assert.equal(f.selections.length,2);
 f.input().props.onChange({target:{value:'/risk/level'}});f.render();f.input().props.onKeyDown({key:'Escape'});f.input().props.onBlur();assert.equal(f.selections.length,2);
 f.input().props.onChange({target:{value:'invalid.path'}});f.render();f.input().props.onBlur();assert.equal(f.selections.length,2);
});
test('Switch scalar choices omit known containers but preserve nested, mixed and unknown fields and manual pointers',()=>{
 const f=fixture();f.props.schema={type:'object',properties:{risk:{type:'object',properties:{level:{type:'string'}}},items:{type:'array',items:{type:'number'}},mixed:{type:['object','string']},unknown:{}}};f.props.scalarOnly=true;f.render();f.input().props.onFocus();f.render();const paths=nodes(f.tree,node=>node.props.role==='option').map(option=>content(nodes(option,node=>node.type==='code')[0]));assert.deepEqual(paths,['/risk/level','/items/0','/mixed','/unknown']);
 f.input().props.onChange({target:{value:'/risk'}});f.render();f.input().props.onBlur();assert.equal(f.selections.at(-1),'/risk');
 f.props.scalarOnly=false;f.render();f.input().props.onFocus();f.render();assert.ok(nodes(f.tree,node=>node.props.role==='option').some(option=>content(option).includes('(전체 출력)')));
});
