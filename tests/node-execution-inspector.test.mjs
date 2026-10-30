import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import * as inspectionView from '../lib/node-inspection-view.ts';

const require=createRequire(import.meta.url);
const source=await readFile(new URL('../components/node-execution-inspector.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source+'\nexport {InspectionValue as TestInspectionValue};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function load(overrides={}) {
  const module={exports:{}};
  const context=vm.createContext({module,exports:module.exports,navigator:overrides.navigator,
    require(name){if(name==='@/lib/node-inspection-view')return inspectionView;if(name.endsWith('.css'))return{};return overrides[name]??require(name);}});
  vm.runInContext(code,context);
  return module.exports;
}
const {NodeExecutionInspector}=load();
const none={availability:'not_applicable',type:'none',summary:'값 없음'};
const result={id:'synthetic',status:'block',stage:'post',reason:'차단',output:'',latencyMs:1,traces:[]};
const workflow={pre:[],post:[]};
function props(value) {
  const node={nodeId:'main',kind:'main',stage:'main',status:'completed',attempt:1,input:none,output:value};
  return {nodeId:'main',label:'응답 모델',workflow,result,inspection:{request:{messages:[],inspectionText:'',inputScope:'conversation'},nodes:[node]},stale:false,onAttempt(){}};
}
const render=value=>renderToStaticMarkup(React.createElement(NodeExecutionInspector,props(value)));

test('administrator inspection shows rejected JSON business values while the public result is empty',()=>{
  const html=render({availability:'available',type:'json',summary:'실제 값',value:{generated:'ADMIN_ONLY_REJECTED',nested:[null,false,0,'']}});
  assert.match(html,/ADMIN_ONLY_REJECTED/);
  assert.match(html,/노드 출력 JSON 복사/);
  assert.match(html,/노드 출력 JSON/);
  assert.match(html,/관리자 전용 실행 상세/);
  assert.equal(result.output,'');
});
test('explicit null remains a displayed JSON value rather than an absent output',()=>{
  const html=render({availability:'available',type:'json',summary:'실제 null',value:null});
  assert.match(html,/<pre[^>]*aria-label="노드 출력 JSON"[^>]*>null<\/pre>/);
});
test('truncated previews are marked incomplete and cannot be copied as complete JSON',()=>{
  const html=render({availability:'available',type:'json',summary:'크기 제한',truncated:true,preview:'{"partial":',originalBytes:300_000});
  assert.match(html,/완전한 JSON이 아닐 수 있습니다/);
  assert.match(html,/300,000바이트/);
  assert.doesNotMatch(html,/JSON 복사/);
});
test('hidden historical values never expose raw fields and HTML in business data remains text',()=>{
  const hidden=render({availability:'withheld',type:'text',summary:'이전 비공개 기록',value:'HISTORICAL_PRIVATE'});
  assert.doesNotMatch(hidden,/HISTORICAL_PRIVATE|JSON 복사/);
  const escaped=render({availability:'available',type:'json',summary:'업무 값',value:{text:'<script>alert(1)</script>'}});
  assert.doesNotMatch(escaped,/<script>/);
  assert.match(escaped,/&lt;script&gt;/);
});

function buttons(element) {
  if(!element||typeof element!=='object')return[];
  return [...(element.type==='button'?[element]:[]),...[element.props?.children].flat(Infinity).flatMap(buttons)];
}
test('JSON copy uses the exact structured value and reports unavailable HTTP clipboard honestly',async()=>{
  for(const supported of [true,false]) {
    const copied=[],states=[];
    const jsx=(type,props)=>({type,props});
    const fakeReact={useState:()=>['',value=>states.push(value)],useEffect(){}};
    const component=load({'react':fakeReact,'react/jsx-runtime':{jsx,jsxs:jsx},navigator:supported?{clipboard:{async writeText(text){copied.push(text);}}}:{}}).TestInspectionValue;
    const value={availability:'available',type:'json',summary:'업무 값',value:{n:0,bool:false,empty:'',nil:null}};
    const node=props(value).inspection.nodes[0];
    const tree=component({label:'출력',value,inspection:props(value).inspection,result,node});
    const button=buttons(tree).find(item=>item.props['aria-label']==='노드 출력 JSON 복사');
    assert.ok(button);
    button.props.onClick();
    await new Promise(resolve=>setImmediate(resolve));
    if(supported){assert.deepEqual(JSON.parse(copied[0]),value.value);assert.equal(states.at(-1),'복사했습니다.');}
    else {assert.equal(copied.length,0);assert.match(states.at(-1),/직접 복사/);}
  }
});
