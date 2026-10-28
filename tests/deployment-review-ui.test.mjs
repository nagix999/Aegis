import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { evaluationPreflight } from '../lib/dataset-compatibility.ts';
import { initialState } from '../lib/aegis-seed.ts';
import { configurationFingerprint, datasetFingerprint, referencedConnections, workflowChanges } from '../lib/workflow-review.ts';

// Run the production component with a small deterministic hook host. It retains
// actual event closures and effects, without a browser or a second Vite build.
const source=await readFile(new URL('../components/deployment-review.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const element=(type,props)=>({type,props:props||{}});
function walk(node,predicate){
  const found=[];
  function visit(value){if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;if(predicate(value))found.push(value);visit(value.props?.children);}
  visit(node);return found;
}
function content(node){if(Array.isArray(node))return node.map(content).join('');if(node===null||node===undefined||typeof node==='boolean')return '';return typeof node==='object'?(node.type==='pre'?'':content(node.props?.children)):String(node);}
function button(tree,text){return walk(tree,node=>node.type==='button'&&content(node).includes(text))[0];}
function byInputLabel(tree,text){return walk(tree,node=>node.type==='label'&&content(node).includes(text)).flatMap(node=>walk(node,item=>item.type==='input'))[0];}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture({state:givenState,fetch:fetchOverride}={}){
  let state=givenState||initialState();
  const workflow=structuredClone(state.workflows[0]);
  workflow.releasePolicy={requireVerification:true,requiredDatasetIds:[]};
  state={...state,role:'admin',workflows:[workflow],runs:[],deployments:[]};
  const states=[],refs=[],effects=[],pending=[],posts=[],requests=[],notices=[],computations=new Set();
  const track=fn=>(...args)=>{const task=fn(...args);computations.add(task);task.finally(()=>computations.delete(task));return task;};
  const trackedFingerprint=track(configurationFingerprint),trackedDatasetFingerprint=track(datasetFingerprint);
  let si=0,ri=0,ei=0,tree,closed=0;
  const props={workflow,state,notify:message=>notices.push(message),onClose:()=>{closed++;},act:async payload=>{posts.push(payload);return payload.action==='publish'?{deployment:{version:2}}:{state};}};
  const responseEvidence=[];
  const host={
    useState(initial){const index=si++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},
    useRef(initial){const index=ri++;return refs[index]||(refs[index]={current:initial});},
    useMemo(fn){return fn();},
    useEffect(callback,deps){const index=ei++,old=effects[index];if(!old||deps.some((value,i)=>!Object.is(old.deps[i],value))){effects[index]={deps,cleanup:old?.cleanup};pending.push(()=>{effects[index].cleanup?.();effects[index].cleanup=callback();});}},
  };
  const module={exports:{}};
  const context={module,exports:module.exports,AbortController,URL,encodeURIComponent,console,Set,Map,Date,JSON,Error,HTMLElement:class{},document:{activeElement:null,addEventListener(){},removeEventListener(){}},
    fetch:async(url,init)=>{requests.push({url,init});return fetchOverride?fetchOverride(url,init):{ok:true,json:async()=>({evidence:responseEvidence,fingerprint:await trackedFingerprint(props.workflow,props.state.connections)})};},
    require(spec){if(spec==='react')return host;if(spec==='react/jsx-runtime')return{jsx:element,jsxs:element};if(spec==='lucide-react')return new Proxy({},{get:(_,name)=>name});if(spec==='@/lib/workflow-review')return{configurationFingerprint:trackedFingerprint,datasetFingerprint:trackedDatasetFingerprint,referencedConnections,workflowChanges};if(spec==='@/lib/aegis-engine')return{validateWorkflow:()=>[]};if(spec==='@/lib/dataset-compatibility')return{evaluationPreflight:track(evaluationPreflight)};if(spec==='./dataset-preflight')return{DatasetPreflightPanel:'DatasetPreflightPanel'};if(spec==='@/lib/product-copy')return{connectionLabel:value=>value};if(spec==='./console-ui')return{Tag:'Tag',timeLabel:value=>value};if(spec.endsWith('.css'))return{};throw new Error(`Unexpected runtime import ${spec}`);},
  };
  vm.runInNewContext(code,context);
  function render(){si=0;ri=0;ei=0;tree=module.exports.DeploymentReview(props);return tree;}
  function effectsNow(){while(pending.length)pending.shift()();}
  async function waitForRequest(){for(let i=0;i<20&&!requests.length;i++){await Promise.all([...computations]);await tick();}}
  async function settle(){for(let i=0;i<30;i++){render();effectsNow();await Promise.all([...computations]);await tick();if(states[0]===false)return render();}throw new Error('Review effect did not settle');}
  async function evidence(dataset,id,overrides={}){const proof=await datasetFingerprint(dataset);return{id,datasetId:dataset.id,datasetName:dataset.name,createdAt:'2026-10-26T00:00:00Z',fingerprint:await trackedFingerprint(props.workflow,props.state.connections),datasetFingerprint:proof,total:dataset.rows.length,completedCount:dataset.rows.length,matchedCount:dataset.rows.length,completeCoverage:true,mock:false,...overrides};}
  return{props,posts,requests,notices,responseEvidence,render,effectsNow,settle,waitForRequest,evidence,get tree(){return tree;},get closed(){return closed;},cleanup(){effects.forEach(effect=>effect.cleanup?.());}};
}

function confirm(f){const checkbox=byInputLabel(f.tree,'위 설정을 새 버전으로 배포');assert.ok(checkbox);checkbox.props.onChange({target:{checked:true}});f.render();}

test('deployment review loads current proof metadata beyond the recent execution list and filters changed datasets',async()=>{
  const f=await fixture(),[dataset]=f.props.state.datasets;
  f.responseEvidence.push(await f.evidence(dataset,'older-valid'),await f.evidence(dataset,'changed-dataset',{datasetFingerprint:'old'}));
  await f.settle();
  assert.equal(f.props.state.runs.length,0);
  assert.equal(f.requests.length,1);assert.match(f.requests[0].url,/view=verification&workflowId=/);assert.equal(f.requests[0].init.cache,'no-store');
  assert.match(content(f.tree),/1개 데이터셋의 검증 결과/);
  confirm(f);assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,false);
  await button(f.tree,'확인한 설정 배포').props.onClick();
  // The JSX handler starts the async operation; its request occurs synchronously.
  assert.deepEqual(structuredClone(f.posts[0].verificationRunIds),['older-valid']);
  f.cleanup();
});

test('multiple required datasets select one completed passing record per dataset and publish all proofs',async()=>{
  const f=await fixture(),first=f.props.state.datasets[0],second={...structuredClone(first),id:'second',name:'두 번째 데이터셋'};
  f.props.state={...f.props.state,datasets:[first,second]};
  f.props.workflow={...f.props.workflow,releasePolicy:{requireVerification:true,requiredDatasetIds:[first.id,second.id]}};
  f.props.state.workflows=[f.props.workflow];
  f.responseEvidence.push(await f.evidence(first,'a-old',{createdAt:'2026-10-24T00:00:00Z'}),await f.evidence(first,'a-new'),await f.evidence(second,'b-new'));
  await f.settle();assert.match(content(f.tree),/2개 데이터셋의 검증 결과/);
  confirm(f);assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,false);button(f.tree,'확인한 설정 배포').props.onClick();
  assert.deepEqual(new Set(f.posts[0].verificationRunIds),new Set(['a-new','b-new']));f.cleanup();
});

test('changing a saved deployment policy disables publication until the revised policy is saved',async()=>{
  const f=await fixture(),dataset=f.props.state.datasets[0];f.responseEvidence.push(await f.evidence(dataset,'pass'));
  await f.settle();confirm(f);assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,false);
  byInputLabel(f.tree,'검증 근거가 있어야 배포').props.onChange({target:{checked:false}});f.render();confirm(f);
  assert.match(content(f.tree),/변경한 배포 기준을 먼저 저장/);assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,true);
  const save=button(f.tree,'배포 기준 저장');assert.ok(save);save.props.onClick();assert.equal(f.posts[0].action,'save_workflow');assert.equal(f.posts[0].expectedUpdatedAt,f.props.workflow.updatedAt);assert.equal(f.posts[0].workflow.releasePolicy.requireVerification,false);f.cleanup();
});

test('failed, partial or mocked evidence cannot satisfy a required dataset',async()=>{
  const f=await fixture(),dataset=f.props.state.datasets[0];
  f.props.workflow={...f.props.workflow,releasePolicy:{requireVerification:true,requiredDatasetIds:[dataset.id]}};f.props.state.workflows=[f.props.workflow];
  f.responseEvidence.push(await f.evidence(dataset,'failed',{matchedCount:0}),await f.evidence(dataset,'partial',{completeCoverage:false}),await f.evidence(dataset,'mock',{mock:true}));
  await f.settle();confirm(f);assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,true);assert.match(content(f.tree),/필수 데이터셋 1개의 현재 검증 결과/);assert.equal(f.posts.length,0);f.cleanup();
});

test('a stale server configuration proof leaves publication disabled after the fetch finishes',async()=>{
  const f=await fixture({fetch:async()=>({ok:true,json:async()=>({evidence:[],fingerprint:'stale'})})});
  await f.settle();confirm(f);assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,true);assert.match(content(f.tree),/설정과 검증 결과를 비교하지 못했습니다/);assert.equal(f.posts.length,0);f.cleanup();
});

test('aborted evidence responses cannot restore old proofs or enable publication',async()=>{
  let finish;const f=await fixture({fetch:async()=>new Promise(resolve=>{finish=resolve;})});
  f.render();f.effectsNow();await f.waitForRequest();assert.equal(f.requests.length,1);const signal=f.requests[0].init.signal;
  const dataset=f.props.state.datasets[0],old=await f.evidence(dataset,'old-proof');
  f.cleanup();assert.equal(signal.aborted,true);finish({ok:true,json:async()=>({evidence:[old],fingerprint:old.fingerprint})});await tick();
  f.render();assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,true);assert.doesNotMatch(content(f.tree),/1개 데이터셋의 검증 결과/);assert.equal(f.posts.length,0);
});

test('a review without required proof can start its saved draft verification and retain its note while suspended',async()=>{
  const f=await fixture(),dataset=f.props.state.datasets[0],started=[];
  f.props.workflow.releasePolicy={requireVerification:true,requiredDatasetIds:[dataset.id]};f.props.state.workflows=[f.props.workflow];
  const run={id:'review-verification',workflowId:f.props.workflow.id,datasetId:dataset.id,target:'draft',status:'running',results:[]};
  f.props.onVerificationStarted=value=>started.push(value);
  f.props.act=async payload=>{f.posts.push(payload);return{state:f.props.state,run};};
  await f.settle();assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,true);
  walk(f.tree,node=>node.type==='textarea'&&node.props.placeholder==='변경한 내용과 배포 이유를 남기세요.')[0].props.onChange({target:{value:'유지할 배포 메모'}});
  walk(f.tree,node=>node.type==='select'&&node.props['aria-label']==='배포 전 검증 데이터셋')[0].props.onChange({target:{value:dataset.id}});
  await f.settle();const panel=walk(f.tree,node=>node.type==='DatasetPreflightPanel')[0];assert.ok(panel.props.preflight);
  if(panel.props.preflight.requiresAcknowledgement){panel.props.onAcknowledgedChange(true);f.render();}
  assert.equal(button(f.tree,'배포 전 검증 시작').props.disabled,false,'Missing proof must not prevent generating that proof');
  button(f.tree,'배포 전 검증 시작').props.onClick();await f.settle();
  assert.equal(f.posts[0].action,'start_evaluation');assert.equal(f.posts[0].workflowId,f.props.workflow.id);assert.equal(f.posts[0].datasetId,dataset.id);assert.equal(f.posts[0].target,'draft');assert.equal(f.posts[0].preflightFingerprint,panel.props.preflight.fingerprint);
  assert.equal(started[0],run);assert.equal(f.closed,0,'The review remains mounted instead of discarding its note');
  f.props.suspended=true;f.render();f.effectsNow();assert.equal(f.tree.props.style.display,'none');
  assert.equal(walk(f.tree,node=>node.type==='textarea'&&node.props.placeholder==='변경한 내용과 배포 이유를 남기세요.')[0].props.value,'유지할 배포 메모');
  f.responseEvidence.push(await f.evidence(dataset,'completed-after-suspension'));
  f.props.suspended=false;await f.settle();assert.equal(f.requests.length,2,'Resuming rechecks current server evidence');
  assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,true,'Fresh evidence still needs explicit publication confirmation');
  confirm(f);assert.equal(button(f.tree,'확인한 설정 배포').props.disabled,false);f.cleanup();
});
