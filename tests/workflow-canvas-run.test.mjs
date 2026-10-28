import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { initialState } from '../lib/aegis-seed.ts';
import { executionEndpointKey } from '../lib/workflow-layout.ts';
import { createStageGraph } from '../lib/workflow-graph.ts';
import { executeWorkflow } from '../lib/aegis-engine.ts';

// Render the actual production components. This checks semantic SVG controls
// and state labels, without pretending to perform browser or visual QA.
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(project,'work'),{recursive:true});
const temporary=await mkdtemp(join(project,'work','canvas-run-ssr-'));
after(()=>rm(temporary,{recursive:true,force:true}));
const entry=join(temporary,'entry.tsx');
await writeFile(entry,`import React from 'react';\nimport {renderToStaticMarkup} from 'react-dom/server';\nimport {WorkflowCanvas} from ${JSON.stringify(join(project,'components/workflow-canvas.tsx'))};\nimport {WorkflowEditor} from ${JSON.stringify(join(project,'components/workflow-editor.tsx'))};\nexport const canvas=props=>renderToStaticMarkup(React.createElement(WorkflowCanvas,props));\nexport const editor=props=>renderToStaticMarkup(React.createElement(WorkflowEditor,props));\n`);
await build({root:project,configFile:false,publicDir:false,plugins:[react()],resolve:{alias:{'@':project}},logLevel:'silent',build:{ssr:entry,outDir:join(temporary,'build'),emptyOutDir:true,target:'node22',rollupOptions:{output:{entryFileNames:'entry.mjs'}}}});
const render=await import(pathToFileURL(join(temporary,'build/entry.mjs')).href);
const noop=()=>{},done=async()=>true;
function check(id){return{id:`g-${id}`,name:`검사 ${id}`,mode:'any',rules:[{id:`r-${id}`,name:`검사 ${id}`,kind:'length',description:'',enabled:true,config:{maxLength:4000}}]};}
function fixture(){
  const state=initialState(),workflow=structuredClone(state.workflows[0]);
  workflow.pre=[check('a'),check('b')];workflow.post=[];
  workflow.graph={version:1,pre:{nodes:[{id:'split',name:'병렬 시작',kind:'fork'},{id:'join',name:'결과 합류',kind:'join'}],edges:[
    {id:'entry',from:'start',to:'control:split'},
    {id:'a',from:'control:split',to:'group:g-a'},{id:'b',from:'control:split',to:'group:g-b'},
    {id:'a-join',from:'group:g-a',to:'control:join'},{id:'b-join',from:'group:g-b',to:'control:join'},
    {id:'end',from:'control:join',to:'end'},
  ]},post:createStageGraph([])};
  return {state,workflow,props:{workflow,connections:state.connections,disabled:false,stale:false,onSelect:noop,onLayout:noop,onAdd:noop,onRetry:noop,onInsertNode:noop,onConnect:noop,onSelectEdge:noop}};
}
function attributes(tag){return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));}
function nodes(html){return Object.fromEntries([...html.matchAll(/<button\b[^>]*data-layout-key="[^"]+"[^>]*>/g)].map(match=>{const attr=attributes(match[0]);return[attr['data-layout-key'],attr];}));}
function edgeGroups(html){return [...html.matchAll(/<g\b[^>]*data-edge-id="[^"]+"[^>]*>/g)].map(match=>attributes(match[0]));}
function result(workflow){return{id:'result',status:'allow',stage:'complete',output:'확인했습니다.',latencyMs:10,reason:'검사를 통과했습니다.',traces:[
  ...workflow.pre.flatMap(group=>group.rules.map(rule=>({ruleId:rule.id,ruleName:rule.name,groupId:group.id,stage:'pre',status:'allow',latencyMs:1,reason:'통과'}))),
  {ruleId:'main',ruleName:'응답 생성',groupId:'main',stage:'main',status:'allow',latencyMs:5,reason:'완료'},
],flowTraces:[
  {stage:'pre',nodeId:'start',status:'completed',edgeIds:['entry']},{stage:'pre',nodeId:'control:split',status:'completed',edgeIds:['a','b']},
  {stage:'pre',nodeId:'group:g-a',status:'completed',edgeIds:['a-join']},{stage:'pre',nodeId:'group:g-b',status:'completed',edgeIds:['b-join']},
  {stage:'pre',nodeId:'control:join',status:'completed',edgeIds:['end']},{stage:'pre',nodeId:'end',status:'completed',edgeIds:[]},
  {stage:'post',nodeId:'start',status:'completed',edgeIds:['serial-1']},{stage:'post',nodeId:'end',status:'completed',edgeIds:[]},
]};}

test('each visible flow edge has one insertion control and every directed path resolves an explicit arrow marker',()=>{
  const f=fixture(),html=render.canvas(f.props),groups=edgeGroups(html);
  assert.equal(groups.length,f.workflow.graph.pre.edges.length+f.workflow.graph.post.edges.length);
  const controls=[...html.matchAll(/data-(?:insert-edge|node-add)="([^"]+)"/g)].map(match=>match[1]);
  for(const group of groups){const key=`${group['data-stage']}:${group['data-edge-id']}`;assert.equal(controls.filter(value=>value===key).length,1,`${key} has exactly one + control`);}
  const markers=new Set([...html.matchAll(/<marker\b[^>]*id="([^"]+)"[^>]*>/g)].map(match=>match[1]));
  const paths=[...html.matchAll(/<path\b[^>]*class="wc-edge(?: [^"]*)?"[^>]*>/g)];
  assert.equal(paths.length,groups.length);
  for(const [path]of paths){const marker=attributes(path)['marker-end'];assert.ok(marker?.startsWith('url(#'), 'Each flow path has an arrow');assert.ok(markers.has(marker.slice(5,-1)),'Arrow references an actual marker');}
});

test('moving nodes behind their predecessors retains one add control and directed arrows',()=>{
  const f=fixture();f.workflow.layout={version:1,positions:{input:{x:1500,y:100},'control:split':{x:1200,y:100},'rule:r-a':{x:300,y:220},'rule:r-b':{x:300,y:480},'control:join':{x:50,y:100},main:{x:500,y:800},output:{x:80,y:800}}};
  const html=render.canvas(f.props),groups=edgeGroups(html);
  assert.equal(groups.length,7);
  const controls=[...html.matchAll(/data-(?:insert-edge|node-add)="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(controls).size,groups.length);assert.equal(controls.length,groups.length);
  const paths=[...html.matchAll(/<path\b[^>]*class="wc-edge(?: [^"]*)?"[^>]*>/g)];assert.ok(paths.every(([path])=>Boolean(attributes(path)['marker-end'])));
});

test('zooming out keeps insertion and wire hit areas usable without drawing a second plus',()=>{
  const f=fixture(),html=render.canvas({...f.props,initialViewport:{zoom:.5,scrollLeft:0,scrollTop:0}}),groups=edgeGroups(html);
  const controls=[...html.matchAll(/data-insert-edge="([^"]+)"/g)];assert.equal(controls.length,groups.length);
  const hits=[...html.matchAll(/<circle class="wc-edge-add-hit" r="([^"]+)"/g)];
  assert.equal(hits.length,groups.length);assert.ok(hits.every(match=>Number(match[1])*.5>=14),'Insertion hit diameter stays at least 28 screen pixels');
  const wires=[...html.matchAll(/<path class="wc-edge-hit"[^>]*style="([^"]+)"/g)];
  assert.equal(wires.length,groups.length);assert.ok(wires.every(match=>Number(match[1].match(/stroke-width:([\d.]+)/)?.[1])*.5>=16),'Wire hit stroke stays at least 16 screen pixels');
  assert.equal([...html.matchAll(/class="wc-edge-add-face" r="10"/g)].length,groups.length,'Visible button size remains compact');
  const ports=[...html.matchAll(/<button\b[^>]*data-connect-port="[^"]+"[^>]*>/g)].map(match=>attributes(match[0]));
  assert.ok(ports.length>0);assert.ok(ports.every(port=>Number(port.style.match(/(?:^|;)width:([\d.]+)px/)?.[1])*.5>=28),'Connection source and target hit targets stay at least 28 screen pixels');
});

test('freely positioned request nodes keep explicit stage labels and path focus is available independently of editing',()=>{
  const f=fixture(),html=render.canvas({...f.props,readOnly:true,selection:{kind:'rule',id:'r-a'}});
  assert.equal([...html.matchAll(/class="wc-node-stage" aria-hidden="true">요청<\/span>/g)].length,4);
  const pathButton=html.match(/<button\b[^>]*aria-label="선택한 노드 경로 강조"[^>]*>/)?.[0];assert.ok(pathButton);assert.doesNotMatch(pathButton,/disabled=/);
  assert.doesNotMatch(html,/data-insert-edge=/);
});

test('live parallel execution marks both active checks and their incoming connections without marking the join complete',()=>{
  const f=fixture();const progress=[
    {sequence:1,stage:'pre',nodeId:'start',status:'completed',edgeIds:['entry']},
    {sequence:2,stage:'pre',nodeId:'control:split',status:'completed',edgeIds:['a','b']},
    {sequence:3,stage:'pre',nodeId:'group:g-a',status:'running',edgeIds:[]},
    {sequence:4,stage:'pre',nodeId:'group:g-b',status:'running',edgeIds:[]},
  ];
  const html=render.canvas({...f.props,progress,running:true}),cards=nodes(html),edges=edgeGroups(html);
  assert.equal(cards['rule:r-a']['data-execution-state'],'running');assert.equal(cards['rule:r-b']['data-execution-state'],'running');
  assert.notEqual(cards['control:join']['data-execution-state'],'completed');
  for(const id of ['a','b'])assert.equal(edges.find(edge=>edge['data-stage']==='pre'&&edge['data-edge-id']===id)['data-execution-state'],'running');
  assert.match(html,/실행 중/);
});

test('completed and stale results have distinct node and connection states and readonly rendering removes insertion',()=>{
  const f=fixture(),execution=result(f.workflow),complete=render.canvas({...f.props,execution}),cards=nodes(complete);
  for(const key of ['input','control:split','rule:r-a','rule:r-b','control:join','main','output'])assert.equal(cards[key]['data-execution-state'],'completed',`${key} completed`);
  assert.ok(edgeGroups(complete).every(edge=>edge['data-execution-state']==='completed'));
  const stale=render.canvas({...f.props,execution,stale:true}),staleCards=nodes(stale);
  assert.ok(Object.values(staleCards).every(node=>!['running','completed','block','error'].includes(node['data-execution-state'])));
  assert.ok(edgeGroups(stale).every(edge=>!['running','completed','block','error'].includes(edge['data-execution-state'])));
  const readonly=render.canvas({...f.props,execution,readOnly:true});assert.doesNotMatch(readonly,/data-(?:insert-edge|node-add)=/);assert.equal(nodes(readonly).output['data-execution-state'],'completed');
});


test('an actual blocked branch colors its taken connection and preserves its outcome when the node is selected',async()=>{
  const f=fixture();f.workflow.graph.pre.nodes[0]={id:'condition',name:'요청 분기',kind:'condition',condition:{operator:'contains',value:'금지'}};
  f.workflow.graph.pre.edges=[{id:'entry',from:'start',to:'control:condition'},{id:'yes',from:'control:condition',to:'group:g-a',port:'true'},{id:'no',from:'control:condition',to:'group:g-b',port:'false'},{id:'a-join',from:'group:g-a',to:'control:join'},{id:'b-join',from:'group:g-b',to:'control:join'},{id:'end',from:'control:join',to:'end'}];
  f.workflow.pre[0].rules[0]={...f.workflow.pre[0].rules[0],kind:'keyword',config:{pattern:'금지'}};
  const execution=await executeWorkflow(f.workflow,f.state.connections,f.state.ingress,{},[{role:'user',content:'금지 문구'}]);
  assert.equal(execution.status,'block');assert.equal(execution.output,'');
  const html=render.canvas({...f.props,execution,selection:{kind:'rule',id:'r-a'}}),cards=nodes(html),edges=edgeGroups(html);
  assert.equal(cards['rule:r-a']['data-execution-state'],'block');assert.match(cards['rule:r-a'].class,/\bselected\b/);
  assert.equal(cards['rule:r-b']['data-execution-state'],'skipped');assert.equal(cards.main['data-execution-state'],'skipped');assert.equal(cards.output['data-execution-state'],'block');
  assert.equal(edges.find(edge=>edge['data-stage']==='pre'&&edge['data-edge-id']==='yes')['data-execution-state'],'block');
  for(const id of ['no','a-join','b-join','end'])assert.equal(edges.find(edge=>edge['data-stage']==='pre'&&edge['data-edge-id']===id)['data-execution-state'],'skipped');
});

test('input inspector provides question and dataset setup inside the editor and rendering performs no run request',()=>{
  const f=fixture();let calls=0;
  const html=render.editor({workflow:f.workflow,connections:f.state.connections,state:f.state,act:async()=>{calls++;return undefined;},dirty:false,busy:false,status:'draft',onChange:noop,onSave:done,onTest:async()=>{calls++;},onDeploy:done,onConnections:noop,onSettings:noop,notify:noop,onPrepareExecution:done,onExecution:noop,session:{workflowId:f.workflow.id,history:{past:[],future:[]},selection:{kind:'input'},inspectorOpen:true,panelMode:'node',graphStage:'pre',view:'builder',checksOpen:false}});
  assert.match(html,/질문/);assert.match(html,/데이터셋/);assert.match(html,/<textarea\b/);assert.match(html,/실행/);assert.equal(calls,0);
  const readonly=render.editor({workflow:f.workflow,connections:f.state.connections,state:{...f.state,role:'viewer'},act:async()=>{calls++;return undefined;},dirty:false,busy:false,status:'draft',readOnly:true,onChange:noop,onSave:done,onTest:done,onDeploy:done,onConnections:noop,onSettings:noop,notify:noop,onPrepareExecution:done,onExecution:noop,session:{workflowId:f.workflow.id,history:{past:[],future:[]},selection:{kind:'input'},inspectorOpen:true,panelMode:'node',graphStage:'pre',view:'builder',checksOpen:false}});
  const buttons=[...readonly.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(match=>/질문 실행|검증 시작|데이터셋 실행/.test(match[2]));
  assert.ok(buttons.length>0);assert.ok(buttons.every(match=>/disabled=""/.test(match[1])));assert.equal(calls,0);
});

test('execution dock stays separate from selected node settings and remains openable while busy',()=>{
  const f=fixture(),execution=result(f.workflow);
  execution.traces.push({stage:'main',ruleId:'main',ruleName:'응답 생성',groupId:'main',status:'allow',latencyMs:1,reason:'재작성',attempt:2});
  execution.attempts=[{number:1,status:'block',stage:'post',latencyMs:1,reason:'차단'},{number:2,status:'allow',stage:'post',latencyMs:1,reason:'통과'}];
  const html=render.editor({workflow:f.workflow,connections:f.state.connections,state:f.state,act:async()=>undefined,execution:{input:'질문',result:execution},dirty:false,busy:true,status:'draft',onChange:noop,onSave:done,onTest:done,onDeploy:done,onConnections:noop,onSettings:noop,notify:noop,onPrepareExecution:done,onExecution:noop,session:{workflowId:f.workflow.id,history:{past:[],future:[]},selection:{kind:'rule',id:'r-a'},inspectorOpen:true,panelMode:'node',graphStage:'pre',view:'builder',checksOpen:false}});
  assert.equal([...html.matchAll(/aria-label="워크플로우 실행과 결과"/g)].length,1);
  assert.equal([...html.matchAll(/class="wr-panel"/g)].length,1);
  const aside=html.match(/<aside\b[^>]*>[\s\S]*?<\/aside>/)?.[0];assert.ok(aside);assert.doesNotMatch(aside,/class="wr-panel"/);
  const opener=html.match(/<button\b[^>]*aria-controls="workflow-run-dock-body"[^>]*>/)?.[0];assert.ok(opener);assert.doesNotMatch(opener,/disabled=/);
  assert.match(html,/aria-label="캔버스 실행 회차"/);assert.match(html,/<option value="1">최초 생성<\/option>/);assert.match(html,/<option value="2">재작성 1회<\/option>/);
});

test('a disconnected zone selection is visibly disabled with its reason',()=>{
  const f=fixture();
  const reason='사이에 빠진 노드 없이 이어진 노드만 같은 영역으로 묶을 수 있습니다.';
  const html=render.canvas({...f.props,selectedKeys:['rule:r-a','rule:r-b'],onGroupSelection:noop,zoneSelectionIssue:reason});
  const groupButton=html.match(/<button\b[^>]*aria-label="2개 선택 노드 묶기"[^>]*>/)?.[0];
  assert.ok(groupButton);assert.match(groupButton,/disabled=/);assert.match(html,/사이에 빠진 노드 없이/);
});

function withPolicy(f){
  const condition={mode:'all',predicates:[{path:'/risk/score',operator:'gte',value:80}]};
  f.workflow.policyRouting={policy:{id:'policy',name:'상담 정책',description:'',prompt:'분류하세요.',connectionId:f.state.connections[1].id,connectionSnapshot:{...f.state.connections[1],model:'example-policy-model'},version:3,updatedAt:'2026-10-27T00:00:00Z',formatVersion:2,outputSchema:{type:'object'},decisions:[],examples:[{id:'example',input:'배송',expectedOutput:{}}]},routes:[],graph:{version:1,entryNodeId:'branch',nodes:[{id:'branch',kind:'branch',name:'문의 종류',condition},{id:'risk',kind:'rule',name:'위험 검사',condition},{id:'main-action',kind:'action',name:'응답 생성',action:'main'},{id:'reply-action',kind:'action',name:'안내 반환',action:'respond',responseText:'공개 안내'},{id:'error-action',kind:'action',name:'정책 차단',action:'error',errorCode:'RESTRICTED',errorMessage:'제한'}],edges:[{id:'branch-true',from:'branch',to:'risk',port:'true'},{id:'branch-false',from:'branch',to:'risk',port:'false'},{id:'risk-true',from:'risk',to:'error-action',port:'true'},{id:'risk-false',from:'risk',to:'main-action',port:'false'}]}};
  return f;
}
test('policy models and graph nodes render on the main canvas with their own settings and true/false ports',()=>{
  const f=withPolicy(fixture()),html=render.canvas({...f.props,onPolicyConnect:noop,onSelectPolicyEdge:noop}),cards=nodes(html);
  assert.equal(cards.policy['data-kind'],'policy');assert.equal(cards['policy-node:branch']['data-kind'],'policy-condition');assert.equal(cards['policy-node:risk']['data-kind'],'policy-condition');assert.equal(cards['policy-node:main-action']['data-kind'],'policy-action');
  assert.match(html,/상담 정책, 정책 모델 설정/);assert.match(html,/example-policy-model/);assert.match(html,/>v3<\/span>/);
  for(const id of ['branch:true','branch:false','risk:true','risk:false'])assert.ok(html.includes(`data-policy-connect-port="${id}"`));
  assert.doesNotMatch(html,/data-policy-connect-port="(?:main-action|reply-action|error-action):/);
  assert.match(html,/aria-label="문의 종류에서 위험 검사로 참 경로 연결 설정"/);
  assert.match(html,/data-from="control:join" data-to="policy"/);
  assert.doesNotMatch(html,/data-from="control:join" data-to="main"/);
  assert.doesNotMatch(html,/data-from="policy" data-to="main"/);
  assert.match(html,/data-from="policy-node:reply-action" data-to="output"/);
  const policyEdges=[...html.matchAll(/<g\b[^>]*data-link-id="policy:[^"]+"[^>]*>/g)].map(match=>attributes(match[0]));
  assert.ok(policyEdges.length>0);assert.doesNotMatch(html,/data-insert-edge="pre:(?:branch-true|risk-true)"/);
  const readonly=render.canvas({...f.props,readOnly:true,onPolicyConnect:noop,onSelectPolicyEdge:noop});
  assert.equal(nodes(readonly).policy['data-kind'],'policy');assert.doesNotMatch(readonly,/data-policy-connect-port=/);assert.doesNotMatch(readonly,/data-connect-port=/);
});
test('legacy branch and rule cards share condition labels and accept incoming connections without changing saved kinds',()=>{
  const f=withPolicy(fixture()),original=structuredClone(f.workflow),html=render.canvas({...f.props,onPolicyConnect:noop}),cards=nodes(html);
  for(const [id,name]of [['branch','문의 종류'],['risk','위험 검사']]){
    assert.equal(cards[`policy-node:${id}`]['data-kind'],'policy-condition');
    assert.match(cards[`policy-node:${id}`]['aria-label'],new RegExp(`${name}, 조건 분기 설정`));
    assert.ok(html.includes(`data-policy-connect-target="${id}"`),`${id} can receive a connection from another condition`);
  }
  assert.doesNotMatch(html,/정책 룰 설정|정책 분기 설정|data-kind="policy-(?:branch|rule)"/);
  assert.deepEqual(f.workflow,original);
});
test('condition connections can point directly to an action or another legacy condition card',()=>{
  const f=withPolicy(fixture());
  f.workflow.policyRouting.graph.edges=[{id:'direct-action',from:'branch',to:'main-action',port:'true'},{id:'condition-chain',from:'risk',to:'branch',port:'false'}];
  const html=render.canvas({...f.props,onPolicyConnect:noop});
  assert.match(html,/data-from="policy-node:branch" data-to="policy-node:main-action"/);
  assert.match(html,/data-from="policy-node:risk" data-to="policy-node:branch"/);
  assert.match(html,/data-policy-connect-target="branch"/);
});
test('zoomed policy port hit areas stay outside their own card centers while retaining usable sizes',()=>{
  const f=withPolicy(fixture());
  const style=tag=>Object.fromEntries(tag.style.split(';').filter(Boolean).map(value=>{const [key,n]=value.split(':');return[key,Number.parseFloat(n)];}));
  for(const zoom of [1,.76,.5,.25]){
    const html=render.canvas({...f.props,onPolicyConnect:noop,initialViewport:{zoom,scrollLeft:0,scrollTop:0}}),cards=nodes(html);
    const ports=[...html.matchAll(/<button\b[^>]*class="[^"]*policy-port[^"]*"[^>]*>/g)].map(match=>attributes(match[0]));
    assert.ok(ports.length>0);
    for(const port of ports){
      const id=port['data-policy-connect-target']||port['data-policy-connect-port'].replace(/:(?:true|false)$/,''),card=style(cards[`policy-node:${id}`]),box=style(port),center={x:card.left+card.width/2,y:card.top+card.height/2};
      assert.ok(!(center.x>=box.left&&center.x<=box.left+box.width&&center.y>=box.top&&center.y<=box.top+box.height),`${id} at ${zoom} lets the card center open settings`);
      assert.ok(box.width*zoom>=27.99&&box.height*zoom>=27.99,`${id} retains a 28px target`);
    }
  }
});
test('policy execution colors actual visited cards and direct response boundaries without Main green paths',()=>{
  const f=withPolicy(fixture()),execution=result(f.workflow);
  execution.policyRoute='respond';execution.policyPath=['branch','risk','reply-action'];
  execution.traces=execution.traces.filter(trace=>trace.stage!=='main');execution.traces.push({stage:'main',ruleId:'main',ruleName:'생성',groupId:'main',status:'skipped',reason:'직접 응답',latencyMs:0},...execution.policyPath.map(id=>({traceType:'policy',stage:'pre',ruleId:`policy:${id}`,ruleName:id,groupId:'policy',status:'allow',reason:'경로',latencyMs:0})));
  const html=render.canvas({...f.props,execution}),cards=nodes(html);
  assert.equal(cards.policy['data-execution-state'],'completed');assert.equal(cards['policy-node:reply-action']['data-execution-state'],'completed');assert.equal(cards.main['data-execution-state'],'skipped');
  const links=[...html.matchAll(/<g\b[^>]*data-link-id="[^"]+"[^>]*>/g)].map(match=>attributes(match[0]));
  assert.equal(links.find(link=>link['data-link-id']==='policy:action:reply-action:serial-1')['data-execution-state'],'completed');assert.equal(links.find(link=>link['data-link-id']==='post:serial-1')['data-execution-state'],'skipped');
  assert.equal(links.find(link=>link['data-link-id']==='policy:edge:branch-true')['data-execution-state'],'unconfirmed');assert.equal(links.find(link=>link['data-link-id']==='policy:edge:branch-false')['data-execution-state'],'unconfirmed');assert.match(html,/선택 경로 구분 불가/);
});


test('connection hit areas expand outward and leave their own node centres selectable at small zoom',()=>{
 const f=fixture(),number=(style,key)=>Number(style.match(new RegExp('(?:^|;)'+key+':([\\d.-]+)px'))?.[1]);
 for(const zoom of [1,.76,.5,.31,.25]){
  const html=render.canvas({...f.props,initialViewport:{zoom,scrollLeft:0,scrollTop:0}}),cards=nodes(html);
  const ports=[...html.matchAll(/<button\b[^>]*data-connect-port="[^"]+"[^>]*>/g)].map(match=>attributes(match[0]));
  assert.ok(ports.length>0);
  for(const item of ports){
   const parts=item['data-connect-port'].split(':'),stage=parts.shift();parts.pop();const endpoint=parts.join(':');
   const key=endpoint==='start'?(stage==='pre'?'input':'main'):endpoint==='end'?(stage==='pre'?'main':'output'):executionEndpointKey(f.workflow,stage,endpoint);
   const card=cards[key];assert.ok(card,key);
   const x=number(card.style,'left')+72,y=number(card.style,'top')+34,left=number(item.style,'left'),top=number(item.style,'top'),width=number(item.style,'width'),height=number(item.style,'height');
   assert.ok([x,y,left,top,width,height].every(Number.isFinite));
   assert.equal(x>=left&&x<=left+width&&y>=top&&y<=top+height,false,`${item['data-connect-port']} leaves node centre clear at ${zoom}`);
  }
 }
});
