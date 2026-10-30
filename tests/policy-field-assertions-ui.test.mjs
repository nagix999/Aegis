import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as expectations from '../lib/output-expectations.ts';
import * as options from '../lib/policy-field-options.ts';
const source=await readFile(new URL('../components/policy-field-assertions.tsx',import.meta.url),'utf8'),code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const element=(type,props)=>({type,props:props||{}});
function walk(tree,match){const results=[];function visit(node){if(Array.isArray(node)){node.forEach(visit);return;}if(!node||typeof node!=='object')return;if(match(node))results.push(node);visit(node.props?.children);}visit(tree);return results;}
const schema={type:'object',properties:{text:{type:'string'},score:{type:'number'},flag:{type:'boolean'},nothing:{type:'null'},mixed:{type:['string','number']},items:{type:'array',items:{type:'string'}},reference:{$ref:'#/$defs/Score'}},$defs:{Score:{type:'number'}}};
function fixture(value='ORIGINAL_VALUE'){
 const changes=[],props={values:[{path:'/text',operator:'eq',value}],drafts:{},schema,disabled:false,label:'기대 조건',onChange:next=>{changes.push(next);props.values=next;},onDraftsChange:next=>{props.drafts=next;}},module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,JSON,Map,Set,Number,require(spec){if(spec==='react/jsx-runtime')return{jsx:element,jsxs:element};if(spec==='lucide-react')return new Proxy({},{get:(_,name)=>name});if(spec==='@/lib/output-expectations')return expectations;if(spec==='@/lib/policy-field-options')return options;if(spec==='./policy-field-picker')return{PolicyFieldPicker:()=>{}};if(spec.endsWith('.css'))return{};throw Error(spec);}});
 const render=()=>module.exports.PolicyFieldAssertions(props),control=name=>walk(render(),node=>node.props['aria-label']===name)[0];
 const path=value=>walk(render(),node=>node.props.label==='기대 조건 1 필드 경로')[0].props.onChange(value);
 return{props,changes,render,control,path};
}
test('selecting a numeric field gives an empty numeric editor without changing its stored string comparison',()=>{
 const f=fixture();f.path('/score');assert.equal(f.props.values[0].value,'ORIGINAL_VALUE');assert.equal(f.control('기대 조건 1 값 자료형').props.value,'number');const input=f.control('기대 조건 1 비교값');assert.equal(input.type,'textarea');assert.equal(input.props.inputMode,'decimal');assert.equal(input.props.value,'');assert.ok(expectations.assertionDraftErrors(f.props.values,f.props.drafts,schema).length);
 input.props.onChange({target:{value:'80'}});assert.equal(f.props.values[0].value,80);assert.equal(typeof f.props.values[0].value,'number');assert.deepEqual(expectations.assertionDraftErrors(f.props.values,f.props.drafts,schema),[]);
});
test('numeric raw text survives unfinished JSON and string-valued JSON cannot be saved as a number',()=>{
 const f=fixture();f.path('/score');for(const raw of ['-','1e','"80"','null']){f.control('기대 조건 1 비교값').props.onChange({target:{value:raw}});assert.equal(f.control('기대 조건 1 비교값').props.value,raw);assert.ok(expectations.assertionDraftErrors(f.props.values,f.props.drafts,schema).length,raw);}
 f.control('기대 조건 1 비교값').props.onChange({target:{value:'8e1'}});assert.equal(f.props.values[0].value,80);assert.deepEqual(expectations.assertionDraftErrors(f.props.values,f.props.drafts,schema),[]);
});
test('boolean and null fields require an explicit value selection rather than replacing the stored comparison',()=>{
 for(const [path,type,value]of [['/flag','boolean',false],['/nothing','null',null]]){const f=fixture();f.path(path);assert.equal(f.props.values[0].value,'ORIGINAL_VALUE');assert.equal(f.control('기대 조건 1 값 자료형').props.value,type);assert.equal(f.control('기대 조건 1 비교값').type,'select');assert.equal(f.control('기대 조건 1 비교값').props.value,'current');assert.ok(expectations.assertionDraftErrors(f.props.values,f.props.drafts,schema).length);f.control('기대 조건 1 비교값').props.onChange({target:{value:'0'}});assert.equal(f.props.values[0].value,value);assert.deepEqual(expectations.assertionDraftErrors(f.props.values,f.props.drafts,schema),[]);}
});
test('mixed and unknown field types retain manual editing and literal whitespace',()=>{
 for(const path of ['/mixed','/unknown']){const f=fixture('  Keep Case  ');f.path(path);assert.equal(f.control('기대 조건 1 값 자료형').props.value,'string');assert.equal(f.control('기대 조건 1 비교값').type,'input');assert.equal(f.control('기대 조건 1 비교값').props.value,'  Keep Case  ');assert.equal(f.props.values[0].value,'  Keep Case  ');}
});
test('resolved numeric references also reject string comparison drafts while array contains uses its item type',()=>{
 const ref=fixture();ref.path('/reference');assert.equal(ref.control('기대 조건 1 값 자료형').props.value,'number');ref.control('기대 조건 1 비교값').props.onChange({target:{value:'"80"'}});assert.ok(expectations.assertionDraftErrors(ref.props.values,ref.props.drafts,schema).length);
 const array=fixture(80);array.props.values[0].operator='contains';array.path('/items');assert.equal(array.control('기대 조건 1 값 자료형').props.value,'string');assert.equal(array.control('기대 조건 1 비교값').props.value,'');array.control('기대 조건 1 비교값').props.onChange({target:{value:'  item  '}});assert.equal(array.props.values[0].value,'  item  ');
});
test('exists with no stored value keeps the legacy true meaning without changing the stored predicate',()=>{
 const f=fixture();f.props.values=[{path:'/score',operator:'exists'}];assert.equal(f.control('기대 조건 1 값 자료형').props.value,'boolean');assert.equal(f.control('기대 조건 1 비교값').props.value,'true');assert.equal(f.control('기대 조건 1 비교값').props['aria-invalid'],false);assert.equal('value'in f.props.values[0],false);assert.equal(f.changes.length,0);assert.deepEqual(expectations.fieldAssertionErrors(f.props.values,schema),[]);
});
