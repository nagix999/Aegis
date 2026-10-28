import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source=await readFile(new URL('../components/evaluation-page.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('evaluation-page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='EvaluationPage');
const topNames=['evaluationWorkerAvailable','newerEvaluation','mergeEvaluationRuns'];
const componentNames=['drive','keepRun','cancel'];
const functions=[...topNames.map(name=>tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)),...componentNames.map(name=>component.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name))];
assert.ok(functions.every(Boolean),'Production background helpers and actions exist');
const effect=component.body.statements.filter(node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(tree)==='useEffect').map(node=>node.expression.arguments[0]).find(node=>node.getText(tree).includes('async function pollEvaluationStatus'));
assert.ok(effect,'Production progress polling effect exists');
const compiled=ts.transpileModule(functions.map(node=>node.getText(tree)).join('\n')+'\nglobalThis.actions={'+[...topNames,...componentNames].join(',')+'};globalThis.pollEffect='+effect.getText(tree)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(options={}){
  let timerId=0;
  const requests=[],posts=[],notices=[],timers=new Map();
  const initial={id:'background-run',createdAt:'2026-10-26T00:00:00.000Z',updatedAt:'2026-10-26T00:00:00.000Z',executionMode:'background',status:'running',results:[],pendingRowIds:['row-1']};
  const state={
    Date,URLSearchParams,AbortController,
    runTime:run=>Date.parse(run.updatedAt||run.createdAt)||0,
    active:true,tab:'batch',runId:initial.id,pollingRunId:initial.id,pollingSelection:{current:initial.id},pollingRetry:0,mounted:{current:true},epoch:{current:0},processing:false,requestBusy:false,controlBusy:'',returnNotice:true,readOnly:false,
    run:initial,localRun:initial,polledRuns:[],runSummaries:[],workerStatus:{available:false},pollingError:'',rowId:'selected-row',resultFilter:'mismatch',categoryFilter:'privacy',
    setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout(id){timers.delete(id);},
    notify(message){notices.push(message);},
    async act(payload){posts.push(payload);return{run:{...initial,status:payload.action==='cancel_evaluation'?'cancelled':'completed',updatedAt:'2026-10-26T00:00:01.000Z'}};},
    async fetch(url,init){requests.push({url,init});return{ok:true,async json(){return{runs:[],run:{...initial,results:[{rowId:'row-1',status:'allow'}],status:'completed',updatedAt:'2026-10-26T00:00:01.000Z'},evaluationWorker:{available:true,lastSeenAt:new Date().toISOString(),kind:'local'}};}};},
    ...options,
  };
  const setters={setProcessing:'processing',setRequestBusy:'requestBusy',setControlBusy:'controlBusy',setLocalRun:'localRun',setRunId:'runId',setReturnNotice:'returnNotice',setPolledRuns:'polledRuns',setRunSummaries:'runSummaries',setWorkerStatus:'workerStatus',setPollingError:'pollingError'};
  for(const [setter,key] of Object.entries(setters))state[setter]=value=>{state[key]=typeof value==='function'?value(state[key]):value;};
  const context=vm.createContext(state);vm.runInContext(compiled,context);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  return{state,actions:context.actions,effect:context.pollEffect,requests,posts,notices,timers,flush};
}

test('a background job never sends browser stepping requests or enters browser processing',async()=>{
  const f=fixture();await f.actions.drive(f.state.run);
  assert.equal(f.posts.length,0);assert.equal(f.state.processing,false);assert.equal(f.state.requestBusy,false);assert.equal(f.state.epoch.current,0);
});
test('an inactive retained evaluation page does not start progress polling',()=>{
  const f=fixture({active:false});f.effect();assert.equal(f.requests.length,0);assert.equal(f.timers.size,0);
});

test('manual jobs retain their browser-driven execution path',async()=>{
  const f=fixture({run:{id:'manual-run',executionMode:'manual',status:'running',results:[],pendingRowIds:['row-1']}});
  await f.actions.drive(f.state.run);
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].action,'step_evaluation');assert.equal(f.posts[0].runId,'manual-run');assert.equal(f.state.processing,false);assert.equal(f.state.localRun.status,'completed');
});

test('availability requires a fresh worker heartbeat',()=>{
  const f=fixture(),now=Date.parse('2026-10-26T00:01:00.000Z');
  assert.equal(f.actions.evaluationWorkerAvailable({available:true,lastSeenAt:'2026-10-26T00:00:20.000Z'},now),true);
  for(const status of [{available:false,lastSeenAt:'2026-10-26T00:00:59.000Z'},{available:true,lastSeenAt:'2026-10-26T00:00:15.000Z'},{available:true,lastSeenAt:'invalid'},{available:true}])assert.equal(f.actions.evaluationWorkerAvailable(status,now),false);
});

test('late progress responses cannot replace cancelled results even with equal timestamps or more rows',()=>{
  const f=fixture();const cancelled={...f.state.run,status:'cancelled'},running={...f.state.run,results:[{rowId:'late-row'}]};
  for(const inputs of [[[cancelled],[running]],[[running],[cancelled]]]){
    const merged=f.actions.mergeEvaluationRuns(...inputs);assert.equal(merged.length,1);assert.equal(merged[0].status,'cancelled');assert.equal(merged[0].results.length,0);
  }
});

test('polling reads selected job progress with GET and preserves item selection and filters for viewers',async()=>{
  const f=fixture({readOnly:true});const cleanup=f.effect();await f.flush();
  assert.equal(f.requests.length,1);assert.match(f.requests[0].url,/view=evaluations/);assert.match(f.requests[0].url,/runId=background-run/);assert.equal(f.requests[0].init.method,undefined);assert.equal(f.posts.length,0);
  assert.equal(f.state.polledRuns[0].status,'completed');assert.equal(f.state.polledRuns[0].results.length,1);assert.equal(f.state.rowId,'selected-row');assert.equal(f.state.resultFilter,'mismatch');assert.equal(f.state.categoryFilter,'privacy');assert.equal(f.state.runId,'background-run');assert.equal(f.state.workerStatus.available,true);
  assert.equal([...f.timers.values()].filter(timer=>timer.delay===2500).length,1);cleanup();assert.equal(f.timers.size,0);assert.equal(f.requests[0].init.signal.aborted,true);
});

test('leaving the page aborts polling and ignores an in-flight response',async()=>{
  let resolveResponse;const f=fixture({fetch:()=>new Promise(resolve=>{resolveResponse=resolve;})});const cleanup=f.effect();cleanup();
  resolveResponse({ok:true,async json(){return{runs:[],run:{...f.state.run,status:'completed',results:[{rowId:'late'}]},evaluationWorker:{available:true}};}});await f.flush();
  assert.equal(f.state.polledRuns.length,0);assert.equal(f.state.workerStatus.available,false);assert.equal(f.state.pollingError,'');assert.equal(f.timers.size,0);assert.equal(f.posts.length,0);
});

test('a superseded run selection cannot apply the old response',async()=>{
  let resolveResponse;const f=fixture({fetch:()=>new Promise(resolve=>{resolveResponse=resolve;})});const cleanup=f.effect();f.state.pollingSelection.current='different-run';
  resolveResponse({ok:true,async json(){return{runs:[],run:{...f.state.run,status:'completed',results:[{rowId:'late'}]},evaluationWorker:{available:true}};}});await f.flush();
  assert.equal(f.state.polledRuns.length,0);assert.equal(f.state.workerStatus.available,false);assert.equal(f.state.pollingError,'');cleanup();
});

test('an open page schedules the next poll only after the current request settles',async()=>{
  let resolveResponse;const f=fixture({fetch:()=>new Promise(resolve=>{resolveResponse=resolve;})});const cleanup=f.effect();
  assert.equal([...f.timers.values()].filter(timer=>timer.delay===2500).length,0);
  resolveResponse({ok:true,async json(){return{runs:[],evaluationWorker:{available:false}};}});await f.flush();
  assert.equal([...f.timers.values()].filter(timer=>timer.delay===2500).length,1);assert.equal(f.posts.length,0);cleanup();
});

test('a refresh failure preserves results, reports an inline error and expires a stale worker',async()=>{
  const f=fixture({workerStatus:{available:true,lastSeenAt:'2020-01-01T00:00:00.000Z'},polledRuns:[{id:'saved',status:'completed',results:[{rowId:'saved-row'}]}],fetch:async()=>{throw Error('offline');}});const cleanup=f.effect();await f.flush();
  assert.ok(f.state.pollingError);assert.equal(f.state.workerStatus.available,false);assert.equal(f.state.polledRuns[0].id,'saved');assert.equal(f.state.polledRuns[0].results.length,1);assert.equal(f.posts.length,0);assert.equal([...f.timers.values()].filter(timer=>timer.delay===2500).length,1);cleanup();
});

test('completed jobs request summaries without re-downloading immutable result snapshots',async()=>{
  const f=fixture({pollingRunId:''});const cleanup=f.effect();await f.flush();assert.match(f.requests[0].url,/view=evaluations/);assert.doesNotMatch(f.requests[0].url,/runId=/);cleanup();
});

test('the single-request tab does not start background status polling',()=>{
  const f=fixture({tab:'single'});assert.equal(f.effect(),undefined);assert.equal(f.requests.length,0);assert.equal(f.timers.size,0);
});
