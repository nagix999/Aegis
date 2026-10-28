import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {initialState} from '../lib/aegis-seed.ts';
import {datasetFingerprint,workflowChanges} from '../lib/workflow-review.ts';
import {evaluationPreflight} from '../lib/dataset-compatibility.ts';
import {currentDeployments} from '../lib/gateway-integration.ts';

const source=await readFile(new URL('../components/deployment-rollback.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const element=(type,props)=>({type,props:props??{}});
function walk(tree,predicate){const found=[];function visit(value){if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;if(predicate(value))found.push(value);visit(value.props?.children);}visit(tree);return found;}
function content(node){if(Array.isArray(node))return node.map(content).join('');if(node==null||typeof node==='boolean')return '';return typeof node==='object'?content(node.props?.children):String(node);}
const button=(tree,label)=>walk(tree,node=>node.type==='button'&&content(node)===label)[0];
const labelInput=(tree,label)=>walk(tree,node=>node.type==='label'&&content(node).includes(label)).flatMap(node=>walk(node,item=>item.type==='input'))[0];
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture({policy,fetch:fetchOverride,act:actOverride,dataset:givenDataset}={}){
 const initial=initialState(),workflow=structuredClone(initial.workflows[0]);
 const dataset=givenDataset??initial.datasets[0];
 const historical={id:'historic-deployment',workflowId:workflow.id,alias:workflow.alias,version:1,createdAt:'2026-10-20T00:00:00Z',workflow:structuredClone(workflow),connections:structuredClone(initial.connections)};
 workflow.updatedAt='2026-10-26T00:00:00.000Z';workflow.releasePolicy=policy??{requireVerification:true,requiredDatasetIds:[dataset.id]};
 const state={...initial,role:'admin',workflows:[workflow],datasets:[dataset],deployments:[historical,{...historical,id:'current-deployment',version:2,createdAt:'2026-10-25T00:00:00Z'}]};
 const states=[],refs=[],effects=[],pending=[],posts=[],requests=[],notices=[],viewed=[],computations=new Set();
 const evidence=[],review={fingerprint:'f'.repeat(64),policy:workflow.releasePolicy,currentWorkflowUpdatedAt:workflow.updatedAt,evidence};
 let si=0,ri=0,ei=0,tree,closed=0,generatedKeys=0;
 const track=fn=>(...args)=>{const task=fn(...args);computations.add(task);task.then(()=>computations.delete(task),()=>computations.delete(task));return task;};
 const props={deployment:historical,state,notify:value=>notices.push(value),onClose:()=>{closed++;},onViewEvaluation:value=>viewed.push(value),act:async payload=>{posts.push(payload);return actOverride?actOverride(payload):payload.action==='start_evaluation'?{state,run:{id:'historical-run',executionMode:'manual'}}:{state,deployment:{version:3}};}};
 const host={
  useState(initial){const i=si++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},
  useRef(initial){const i=ri++;return refs[i]??(refs[i]={current:initial});},
  useEffect(callback,deps){const i=ei++,old=effects[i];if(!old||deps.some((value,j)=>!Object.is(old.deps[j],value))){effects[i]={deps,cleanup:old?.cleanup};pending.push(()=>{effects[i].cleanup?.();effects[i].cleanup=callback();});}},
 };
 const module={exports:{}};
 const context={module,exports:module.exports,AbortController,console,Date,JSON,Error,Map,Set,encodeURIComponent,crypto:{randomUUID:()=>`request-${++generatedKeys}`},HTMLElement:class{},document:{activeElement:null,addEventListener(){},removeEventListener(){}},fetch:async(url,init)=>{requests.push({url,init});return fetchOverride?fetchOverride(url,init):{ok:true,json:async()=>review};},require(spec){if(spec==='react')return host;if(spec==='react/jsx-runtime')return{jsx:element,jsxs:element};if(spec==='lucide-react')return new Proxy({},{get:(_,key)=>key});if(spec==='@/lib/workflow-review')return{datasetFingerprint:track(datasetFingerprint),workflowChanges};if(spec==='@/lib/dataset-compatibility')return{evaluationPreflight:track(evaluationPreflight)};if(spec==='@/lib/gateway-integration')return{currentDeployments};if(spec==='./dataset-preflight')return{DatasetPreflightPanel:'DatasetPreflightPanel'};if(spec==='./console-ui')return{timeLabel:value=>value};throw new Error(`Unexpected import ${spec}`);}};
 vm.runInNewContext(code,context);
 function render(){si=0;ri=0;ei=0;tree=module.exports.DeploymentRollback(props);return tree;}
 function effectsNow(){while(pending.length)pending.shift()();}
 async function settle(){for(let i=0;i<12;i++){render();effectsNow();await Promise.all([...computations]);await tick();}return render();}
 async function proof(id,overrides={}){return{id,datasetId:dataset.id,datasetName:dataset.name,datasetFingerprint:await datasetFingerprint(dataset),createdAt:'2026-10-26T00:00:00Z',total:dataset.rows.length,completedCount:dataset.rows.length,matchedCount:dataset.rows.length,completeCoverage:true,mock:false,...overrides};}
 return{props,posts,requests,notices,viewed,evidence,review,proof,render,effectsNow,settle,get tree(){return tree;},get closed(){return closed;},cleanup(){effects.forEach(effect=>effect.cleanup?.());}};
}
function accept(f){const input=labelInput(f.tree,'선택한 과거 설정을 새 버전');assert.ok(input);input.props.onChange({target:{checked:true}});f.render();}
function selectDataset(f){const select=walk(f.tree,node=>node.type==='select')[0];select.props.onChange({target:{value:f.props.state.datasets[0].id}});}

test('rollback loads exact historical evidence and current policy, filters stale dataset proofs, and sends current revision',async()=>{
 const f=await fixture();f.evidence.push(await f.proof('valid'),await f.proof('stale',{datasetFingerprint:'changed'}));await f.settle();
 assert.equal(f.requests.length,1);assert.match(f.requests[0].url,/view=verification&deploymentId=historic-deployment/);assert.equal(f.requests[0].init.cache,'no-store');
 assert.equal(walk(f.tree,node=>node.type==='label'&&content(node).includes('고객 상담 보안 검증 세트')&&walk(node,item=>item.type==='input').length>0).length,1);
 accept(f);assert.equal(button(f.tree,'확인한 설정 복원').props.disabled,false);button(f.tree,'확인한 설정 복원').props.onClick();await f.settle();
 assert.equal(f.posts[0].action,'rollback_deployment');assert.equal(f.posts[0].deploymentId,'historic-deployment');assert.equal(f.posts[0].expectedFingerprint,f.review.fingerprint);assert.equal(f.posts[0].expectedUpdatedAt,f.review.currentWorkflowUpdatedAt);assert.deepEqual(structuredClone(f.posts[0].verificationRunIds),['valid']);assert.equal(f.closed,1);f.cleanup();
});

test('failed, partial and mocked proof cannot enable rollback under current required policy',async()=>{
 const f=await fixture();f.evidence.push(await f.proof('failed',{matchedCount:0}),await f.proof('partial',{completeCoverage:false}),await f.proof('mock',{mock:true}));await f.settle();accept(f);
 assert.equal(button(f.tree,'확인한 설정 복원').props.disabled,true);assert.match(content(f.tree),/필수 데이터셋 1개의 검증이 필요/);button(f.tree,'확인한 설정 복원').props.onClick();assert.equal(f.posts.length,0);f.cleanup();
});

test('late evidence response from a closed dialog cannot re-enable rollback',async()=>{
 let finish;const f=await fixture({fetch:()=>new Promise(resolve=>{finish=resolve;})});f.render();f.effectsNow();await tick();assert.equal(f.requests.length,1);f.cleanup();assert.equal(f.requests[0].init.signal.aborted,true);
 f.evidence.push(await f.proof('old'));finish({ok:true,json:async()=>f.review});await tick();f.render();accept(f);assert.equal(button(f.tree,'확인한 설정 복원').props.disabled,true);assert.equal(f.posts.length,0);
});

test('historical verification uses exact deployment and never acknowledges incompatible criteria automatically',async()=>{
 const initial=initialState(),dataset={...initial.datasets[0],rows:[{id:'missing',input:'배송 문의',expected:'block',expectedRuleId:'missing-detector'}]};
 const f=await fixture({dataset});await f.settle();selectDataset(f);await f.settle();
 const panel=walk(f.tree,node=>node.type==='DatasetPreflightPanel')[0];assert.ok(panel.props.preflight.requiresAcknowledgement);assert.equal(panel.props.acknowledged,false);assert.equal(button(f.tree,'복원 설정 검증 시작').props.disabled,true);
 button(f.tree,'복원 설정 검증 시작').props.onClick();assert.equal(f.posts.length,0);
 panel.props.onAcknowledgedChange(true);f.render();assert.equal(button(f.tree,'복원 설정 검증 시작').props.disabled,false);button(f.tree,'복원 설정 검증 시작').props.onClick();await f.settle();
 const request=f.posts[0];assert.equal(request.action,'start_evaluation');assert.equal(request.deploymentId,'historic-deployment');assert.equal(request.target,'deployed');assert.equal(request.datasetId,dataset.id);assert.equal(request.acknowledgeCriteria,true);assert.equal(request.preflightFingerprint,panel.props.preflight.fingerprint);assert.deepEqual(f.viewed,['historical-run']);assert.match(f.notices[0],/이어서 실행/);f.cleanup();
});

test('rollback retries preserve idempotency key and edited commands get a new key',async()=>{
 const f=await fixture({act:async()=>undefined});f.evidence.push(await f.proof('valid'));await f.settle();accept(f);
 button(f.tree,'확인한 설정 복원').props.onClick();await f.settle();button(f.tree,'확인한 설정 복원').props.onClick();await f.settle();
 assert.equal(f.posts.length,2);assert.equal(f.posts[0].idempotencyKey,f.posts[1].idempotencyKey);
 walk(f.tree,node=>node.type==='textarea')[0].props.onChange({target:{value:'변경한 복원 이유'}});f.render();button(f.tree,'확인한 설정 복원').props.onClick();await f.settle();
 assert.equal(f.posts.length,3);assert.notEqual(f.posts[2].idempotencyKey,f.posts[1].idempotencyKey);f.cleanup();
});

test('historical review retains its note and target while verification is shown and rechecks proof on return',async()=>{
 const f=await fixture(),started=[];f.props.onVerificationStarted=run=>started.push(run);
 await f.settle();walk(f.tree,node=>node.type==='textarea')[0].props.onChange({target:{value:'유지할 복원 메모'}});
 selectDataset(f);await f.settle();const panel=walk(f.tree,node=>node.type==='DatasetPreflightPanel')[0];
 if(panel.props.preflight.requiresAcknowledgement){panel.props.onAcknowledgedChange(true);f.render();}
 button(f.tree,'복원 설정 검증 시작').props.onClick();await f.settle();
 assert.equal(f.posts[0].deploymentId,'historic-deployment');assert.equal(started[0].id,'historical-run');assert.equal(f.closed,0);assert.deepEqual(f.viewed,[]);
 f.props.suspended=true;f.render();f.effectsNow();assert.equal(f.tree.props.style.display,'none');assert.equal(walk(f.tree,node=>node.type==='textarea')[0].props.value,'유지할 복원 메모');
 f.evidence.push(await f.proof('new-current-proof'));f.props.suspended=false;await f.settle();assert.equal(f.requests.length,2);
 assert.equal(button(f.tree,'확인한 설정 복원').props.disabled,true);accept(f);assert.equal(button(f.tree,'확인한 설정 복원').props.disabled,false);f.cleanup();
});
