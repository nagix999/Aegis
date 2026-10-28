// Explicit extensions keep this shared service executable with Node's strip-types runner.
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { executeWorkflow, validateWorkflow } from './aegis-engine.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { configurationFingerprint, datasetFingerprint, matchesExpectation, referencedConnections } from './workflow-review.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { executionLeaseDuration } from './response-retry.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { evaluationPreflight } from './dataset-compatibility.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { ENGINE_VERSION } from './execution-provenance.ts';
import type { AegisEnv, AegisStore } from './aegis-store';
import type { AppState, Connection, Dataset, DatasetRow, Deployment, EvalResult, EvalRun, ExecutionResult, RequestLog, Workflow } from './aegis-types';

type Lease = { token: string; until: number };
type StoredRun = EvalRun & { _lease?: Lease };
type VersionedRun = { value: StoredRun; revision: string };
const BATCH_SIZE = 2;
const MAX_RUN_BYTES = 1_500_000;
const MAX_RUNNING = 4;
const actions = new Set(['run_evaluation','start_evaluation','step_evaluation','cancel_evaluation','retry_evaluation','replay_evaluation']);

export class EvaluationError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name='EvaluationError'; this.status=status; this.code=code; }
}
function requireValue(condition: unknown, message: string, code='invalid_request', status=400): asserts condition {
  if(!condition)throw new EvaluationError(status,code,message);
}
function identifier(value: unknown, label: string): string {
  requireValue(typeof value==='string'&&value.trim().length>0&&value.length<=120,`${label}을 확인하세요.`);
  return value.trim();
}
function publicRun(run: StoredRun): EvalRun {
  const {_lease: _privateLease,...visible}=run;
  return structuredClone(visible);
}
function runBytes(run: StoredRun): number { return new TextEncoder().encode(JSON.stringify(run)).byteLength; }
function assertSize(run: StoredRun) {
  requireValue(runBytes(run)<=MAX_RUN_BYTES,'검증 설정과 결과의 저장 한도 1.5MB를 초과했습니다. 데이터셋을 나누어 실행하세요.','evaluation_result_too_large',413);
}
function latestDeployment(state: AppState, workflowId: string): Deployment | undefined {
  return state.deployments.filter(item=>item.workflowId===workflowId).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.version-a.version)[0];
}
function runningLimit(state: AppState) {
  requireValue(state.runs.filter(run=>run.status==='running').length<MAX_RUNNING,'동시에 진행할 수 있는 검증 작업은 4개입니다. 기존 작업을 완료하거나 중단하세요.','evaluation_job_limit',409);
}
async function insertRun(store: AegisStore,run: StoredRun) {
  // The state above is only an early user-facing check. Creation itself must
  // enforce capacity atomically, including when requests share a stale state.
  requireValue(await store.insertEvaluationRun(run,MAX_RUNNING),'동시에 진행할 수 있는 검증 작업은 4개입니다. 기존 작업을 완료하거나 중단하세요.','evaluation_job_limit',409);
}
function validateSnapshot(workflow: Workflow, connections: Connection[], dataset: Dataset) {
  const issues=validateWorkflow(workflow,connections);
  requireValue(!issues.length,issues.join('; '));
  requireValue(Array.isArray(dataset.rows)&&dataset.rows.length>=1&&dataset.rows.length<=100,'데이터셋에는 1~100개 행이 필요합니다.');
  requireValue(new Set(dataset.rows.map(row=>row.id)).size===dataset.rows.length,'데이터셋의 행 ID가 중복되었습니다.');
  requireValue(dataset.rows.every(row=>typeof row.id==='string'&&row.id.length>0&&typeof row.input==='string'&&row.input.trim().length>0&&row.input.length<=16000&&['allow','block'].includes(row.expected)),'데이터셋 행의 입력과 예상 판정을 확인하세요.');
}
function executionMode(data: Record<string,unknown>,state: AppState): 'manual'|'background' {
  requireValue(data.executionMode===undefined||data.executionMode==='manual'||data.executionMode==='background','검증 실행 방식을 확인하세요.');
  const mode=data.executionMode??(state.evaluationWorker?.available?'background':'manual');
  requireValue(mode!=='background'||state.evaluationWorker?.available,'검증 작업자가 연결되어 있지 않습니다. 연결 상태를 확인하거나 화면에서 실행하세요.','evaluation_worker_unavailable',409);
  return mode as 'manual'|'background';
}
async function createRun(data: Record<string,unknown>, state: AppState, selectedDeployment?:Deployment): Promise<StoredRun> {
  runningLimit(state);
  const mode=executionMode(data,state);
  const workflowId=identifier(data.workflowId,'워크플로우 ID');
  const datasetId=identifier(data.datasetId,'데이터셋 ID');
  const target=data.target??'draft';
  requireValue(target==='draft'||target==='deployed','실행 대상은 draft 또는 deployed여야 합니다.');
  requireValue(data.compare===undefined||typeof data.compare==='boolean','비교 실행 설정을 확인하세요.');
  const compare=data.compare===true;
  requireValue(!compare||target==='draft','변경 전후 비교는 수정본을 대상으로 실행하세요.');
  const current=state.workflows.find(item=>item.id===workflowId);
  const dataset=state.datasets.find(item=>item.id===datasetId);
  requireValue(current,'워크플로우를 찾을 수 없습니다.','not_found',404);
  requireValue(dataset,'데이터셋을 찾을 수 없습니다.','not_found',404);
  const deployment=selectedDeployment??latestDeployment(state,workflowId);
  requireValue(target!=='deployed'||deployment,'먼저 워크플로우를 배포하세요.','not_deployed');
  requireValue(!compare||deployment,'비교할 배포 버전이 없습니다. 먼저 워크플로우를 배포하세요.','not_deployed');
  const workflow=structuredClone(target==='deployed'?deployment!.workflow:current);
  const connections=structuredClone(referencedConnections(workflow,target==='deployed'?deployment!.connections:state.connections));
  const datasetSnapshot=structuredClone(dataset);
  validateSnapshot(workflow,connections,datasetSnapshot);
  const baseline=compare?structuredClone(deployment!.workflow):undefined;
  const baselineConnections=compare?structuredClone(referencedConnections(baseline!,deployment!.connections)):undefined;
  if(baseline&&baselineConnections)validateSnapshot(baseline,baselineConnections,datasetSnapshot);
  requireValue(data.acknowledgeCriteria===undefined||typeof data.acknowledgeCriteria==='boolean','검사 기준 확인 설정을 확인하세요.');
  requireValue(data.preflightFingerprint===undefined||typeof data.preflightFingerprint==='string','검사 기준 점검 값을 확인하세요.');
  const preflight=await evaluationPreflight(datasetSnapshot,[
    {key:'candidate',label:target==='deployed'?`배포 v${deployment!.version}`:'현재 초안',workflow,connections},
    ...(baseline&&baselineConnections?[{key:'baseline' as const,label:`비교 배포 v${deployment!.version}`,workflow:baseline,connections:baselineConnections}]:[]),
  ]);
  if(data.preflightFingerprint!==undefined||data.acknowledgeCriteria===true)requireValue(data.preflightFingerprint===preflight.fingerprint,'데이터셋이나 워크플로우가 점검 이후 변경되었습니다. 검사 기준을 다시 확인하세요.','stale_dataset_preflight',409);
  if(preflight.requiresAcknowledgement)requireValue(data.acknowledgeCriteria===true&&data.preflightFingerprint===preflight.fingerprint,`검증 기준을 먼저 확인하세요. ${preflight.issues.slice(0,3).map(issue=>`${issue.sideLabel} ${issue.rowNumber}번: ${issue.message}`).join('; ')} 기준을 수정하거나 현재 기준으로 실행할지 확인하세요.`,'dataset_criteria_review_required');
  const timestamp=new Date().toISOString();
  const run: StoredRun={
    id:crypto.randomUUID(),workflowId,workflowName:workflow.name,datasetId,datasetName:datasetSnapshot.name,createdAt:timestamp,updatedAt:timestamp,
    version:target==='deployed'?`v${deployment!.version}`:'draft',...(target==='deployed'?{deploymentId:deployment!.id}:{}),target,executionMode:mode,status:'running',total:datasetSnapshot.rows.length,results:[],pendingRowIds:datasetSnapshot.rows.map(row=>row.id),
    workflowSnapshot:workflow,connectionsSnapshot:connections,datasetSnapshot,
    engineVersion:ENGINE_VERSION,fingerprint:await configurationFingerprint(workflow,connections),datasetFingerprint:await datasetFingerprint(datasetSnapshot),
    preflight:{fingerprint:preflight.fingerprint,acknowledged:preflight.requiresAcknowledgement&&data.acknowledgeCriteria===true,issueCount:preflight.issues.length},
  };
  if(baseline&&baselineConnections){
    run.baselineWorkflowSnapshot=baseline;run.baselineConnectionsSnapshot=baselineConnections;run.baselineVersion=`v${deployment!.version}`;run.baselineResults=[];
  }
  assertSize(run);return run;
}
async function getRun(store: AegisStore, runId: unknown): Promise<VersionedRun> {
  const id=identifier(runId,'검증 작업 ID');
  const stored=await store.getRecordWithVersion<StoredRun>('run',id);
  requireValue(stored,'검증 작업을 찾을 수 없습니다.','not_found',404);
  return stored;
}
function hasSnapshots(run: StoredRun): run is StoredRun & {workflowSnapshot: Workflow;connectionsSnapshot: Connection[];datasetSnapshot: Dataset} {
  return Boolean(run.workflowSnapshot&&run.connectionsSnapshot&&run.datasetSnapshot);
}
function leaseDuration(run: StoredRun): number {
  // Each row and comparison side runs concurrently; the serial stage budget
  // bounds the lease without letting a second HTTP call repeat a live batch.
  const candidate=run.workflowSnapshot&&run.connectionsSnapshot?executionLeaseDuration(run.workflowSnapshot,run.connectionsSnapshot):0;
  const baseline=run.baselineWorkflowSnapshot&&run.baselineConnectionsSnapshot?executionLeaseDuration(run.baselineWorkflowSnapshot,run.baselineConnectionsSnapshot):0;
  return Math.max(120_000,candidate,baseline);
}
function resultForRow(row: DatasetRow, execution: ExecutionResult): EvalResult {
  const safe=execution.status==='allow'?execution:{...execution,output:''};
  const {id:rowId,...metadata}=row;
  return {...safe,...structuredClone(metadata),rowId,expectationMatched:matchesExpectation(row,safe)};
}
function executionFailure(): ExecutionResult {
  return {id:crypto.randomUUID(),status:'error',output:'',stage:'pre',latencyMs:0,traces:[],reason:'검사 실행 중 오류가 발생했습니다. 연결과 설정을 확인하세요.'};
}
function evaluationLog(result: ExecutionResult,workflow: Workflow,version: string): RequestLog {
  const traceReason={allow:'검사를 통과했습니다.',block:'검사 정책에 따라 차단했습니다.',error:'검사 실행 중 오류가 발생했습니다.',skipped:'실행하지 않았습니다.'};
  return {id:result.id,source:'evaluation',workflowId:workflow.id,workflowName:workflow.name,version,createdAt:new Date().toISOString(),status:result.status,stage:result.stage,latencyMs:result.latencyMs,
    reason:traceReason[result.status],traces:result.traces.map(trace=>({...trace,reason:traceReason[trace.status]})),...(result.flowTraces?{flowTraces:result.flowTraces}:{}),...(result.attempts?{attempts:result.attempts.map(attempt=>({number:attempt.number,status:attempt.status,stage:attempt.stage,latencyMs:attempt.latencyMs,reason:traceReason[attempt.status]}))}:{}),...(result.regenerationCount!==undefined?{regenerationCount:result.regenerationCount}:{}),...(result.usage?{usage:result.usage}:{})};
}
async function runRow(row: DatasetRow,workflow: Workflow,connections: Connection[],version: string,state: Pick<AppState,'ingress'>,store: AegisStore,env: AegisEnv): Promise<EvalResult> {
  let result: ExecutionResult;
  try{result=await executeWorkflow(workflow,connections,state.ingress,env,row.messages??[{role:'user',content:row.input}],row.generationOptions??{});}
  catch{result=executionFailure();}
  await store.log(evaluationLog(result,workflow,version));
  return resultForRow(row,result);
}
async function stepRun(runId: unknown,state: Pick<AppState,'ingress'>,store: AegisStore,env: AegisEnv): Promise<Record<string,unknown>> {
  const stored=await getRun(store,runId);const run=stored.value;
  if(run.status!=='running')return {run:publicRun(run)};
  requireValue(hasSnapshots(run),'이 작업에는 실행 설정이 저장되어 있지 않습니다. 새 검증을 시작하세요.','evaluation_snapshot_missing',409);
  if(run._lease&&run._lease.until>Date.now())return {run:publicRun(run),leaseActive:true};
  if(run.engineVersion!==ENGINE_VERSION){
    const failed:StoredRun={...run,status:'error',error:'실행 엔진이 변경되어 검증을 중단했습니다. 저장된 설정으로 다시 실행하세요.',updatedAt:new Date().toISOString()};
    delete failed._lease;
    await store.compareAndSwap('run',run.id,stored.revision,failed);
    return {run:publicRun((await getRun(store,run.id)).value)};
  }
  const pending=run.pendingRowIds??[];
  if(!pending.length){const completed={...run,status:'completed' as const,updatedAt:new Date().toISOString()};delete completed._lease;if(await store.compareAndSwap('run',run.id,stored.revision,completed))return {run:publicRun(completed)};return {run:publicRun((await getRun(store,run.id)).value),leaseActive:true};}
  const lease:Lease={token:crypto.randomUUID(),until:Date.now()+leaseDuration(run)};
  const leased:StoredRun={...run,_lease:lease};
  if(!await store.compareAndSwap('run',run.id,stored.revision,leased))return {run:publicRun((await getRun(store,run.id)).value),leaseActive:true};
  const leasedRevision=JSON.stringify(leased);
  const rowIds=pending.slice(0,BATCH_SIZE);
  try{
    const rows=rowIds.map(rowId=>run.datasetSnapshot.rows.find(row=>row.id===rowId));
    requireValue(rows.every(Boolean),'저장된 검증 행을 찾을 수 없습니다.','evaluation_snapshot_invalid',409);
    const comparison=Boolean(run.baselineWorkflowSnapshot&&run.baselineConnectionsSnapshot);
    const pairs=await Promise.all((rows as DatasetRow[]).map(async row=>{
      const [candidate,baseline]=await Promise.all([
        runRow(row,run.workflowSnapshot,run.connectionsSnapshot,run.version,state,store,env),
        comparison?runRow(row,run.baselineWorkflowSnapshot!,run.baselineConnectionsSnapshot!,run.baselineVersion??'deployed',state,store,env):Promise.resolve(undefined),
      ]);
      return {candidate,baseline};
    }));
    const next:StoredRun={...run,results:[...run.results,...pairs.map(pair=>pair.candidate)],pendingRowIds:pending.slice(rowIds.length),updatedAt:new Date().toISOString()};
    delete next._lease;
    if(comparison)next.baselineResults=[...(run.baselineResults??[]),...pairs.flatMap(pair=>pair.baseline?[pair.baseline]:[])];
    next.status=next.pendingRowIds!.length?'running':'completed';
    if(runBytes(next)>MAX_RUN_BYTES){
      const failed:StoredRun={...run,status:'error',error:'검증 결과의 저장 한도 1.5MB를 초과했습니다. 완료된 이전 묶음은 유지됩니다. 데이터셋을 나누어 새로 실행하세요.',updatedAt:new Date().toISOString()};
      delete failed._lease;
      await store.compareAndSwap('run',run.id,leasedRevision,failed);
    }else await store.compareAndSwap('run',run.id,leasedRevision,next);
  }catch{
    // A cancellation changes the payload revision; this CAS therefore cannot
    // resurrect a cancelled job or replace another request's newer progress.
    const failed:StoredRun={...run,status:'error',error:'검증 묶음을 저장하지 못했습니다. 완료된 결과를 확인하고 다시 실행하세요.',updatedAt:new Date().toISOString()};
    delete failed._lease;
    await store.compareAndSwap('run',run.id,leasedRevision,failed);
  }
  return {run:publicRun((await getRun(store,run.id)).value)};
}
async function cancelRun(runId: unknown,store: AegisStore): Promise<Record<string,unknown>> {
  for(let attempt=0;attempt<4;attempt++){
    const stored=await getRun(store,runId);
    if(stored.value.status!=='running')return {run:publicRun(stored.value)};
    const cancelled:StoredRun={...stored.value,status:'cancelled',updatedAt:new Date().toISOString()};delete cancelled._lease;
    if(await store.compareAndSwap('run',cancelled.id,stored.revision,cancelled))return {run:publicRun(cancelled)};
  }
  throw new EvaluationError(409,'evaluation_busy','검증 상태가 변경되고 있습니다. 잠시 후 중단을 다시 요청하세요.');
}
async function restartRun(data: Record<string,unknown>,state: AppState,store: AegisStore,retry: boolean): Promise<StoredRun> {
  runningLimit(state);
  const source=(await getRun(store,data.runId)).value;
  requireValue(hasSnapshots(source),'이전 결과에는 재현할 설정이 없습니다. 현재 설정으로 새 검증을 시작하세요.','evaluation_snapshot_missing',409);
  let rowIds=source.datasetSnapshot.rows.map(row=>row.id);
  if(retry){
    const failed=new Set([...source.results,...(source.baselineResults??[])].filter(result=>result.status==='error').map(result=>result.rowId));
    rowIds=rowIds.filter(rowId=>failed.has(rowId));
    requireValue(rowIds.length>0,'다시 실행할 오류 항목이 없습니다. 정책 차단은 실행 오류와 다릅니다.','evaluation_no_errors');
  }
  const timestamp=new Date().toISOString();
  const run:StoredRun={...publicRun(source),engineVersion:ENGINE_VERSION,fingerprint:await configurationFingerprint(source.workflowSnapshot,source.connectionsSnapshot),
    datasetFingerprint:await datasetFingerprint(source.datasetSnapshot),executionMode:executionMode(data,state),id:crypto.randomUUID(),createdAt:timestamp,updatedAt:timestamp,status:'running',results:[],pendingRowIds:rowIds,total:rowIds.length};
  delete run.error;delete run.retryOf;delete run.replayOf;
  if(source.baselineWorkflowSnapshot)run.baselineResults=[];
  if(retry)run.retryOf=source.id;else run.replayOf=source.id;
  assertSize(run);return run;
}

// Shared by durable server workers. The same CAS lease protects HTTP and worker
// callers, including recovery after a process stops without releasing its lease.
export async function processBackgroundEvaluationRun(runId:string,state:Pick<AppState,'ingress'>,store:AegisStore,env:AegisEnv):Promise<{processed:boolean;leaseActive:boolean}> {
  const stored=await getRun(store,runId);
  if(stored.value.executionMode!=='background'||stored.value.status!=='running')return {processed:false,leaseActive:false};
  const result=await stepRun(runId,state,store,env);
  return {processed:!result.leaseActive,leaseActive:result.leaseActive===true};
}

/** Durable batches are driven either by an attached screen or a server worker. */
export async function handleEvaluationAction(data: Record<string,unknown>,state: AppState,store: AegisStore,env: AegisEnv): Promise<Record<string,unknown>|undefined> {
  if(typeof data.action!=='string'||!actions.has(data.action))return undefined;
  if(data.action==='step_evaluation'){
    const current=await getRun(store,data.runId);
    requireValue(current.value.executionMode!=='background'||current.value.status!=='running','이 검증은 서버에서 처리합니다. 실행 기록에서 진행 상태를 확인하세요.','evaluation_background_managed',409);
    return stepRun(data.runId,state,store,env);
  }
  if(data.action==='cancel_evaluation')return cancelRun(data.runId,store);
  if(data.action==='retry_evaluation'||data.action==='replay_evaluation'){
    const run=await restartRun(data,state,store,data.action==='retry_evaluation');await insertRun(store,run);return {run:publicRun(run)};
  }
  let selectedDeployment:Deployment|undefined;
  if(data.deploymentId!==undefined){
    requireValue(data.target==='deployed'&&data.compare!==true,'배포 ID를 지정한 검증은 배포본 실행만 지원합니다. 초안 비교 설정을 해제하세요.');
    const deployment=await store.getDeployment(identifier(data.deploymentId,'배포 ID'));
    requireValue(deployment&&deployment.workflowId===data.workflowId,'이 워크플로우의 배포 버전을 찾을 수 없습니다.','not_found',404);
    selectedDeployment=deployment;
  }
  const run=await createRun(data.action==='run_evaluation'?{...data,executionMode:'manual'}:data,state,selectedDeployment);await insertRun(store,run);
  if(data.action==='start_evaluation')return {run:publicRun(run)};
  let current:EvalRun=publicRun(run);
  while(current.status==='running'){
    const stepped=await stepRun(current.id,state,store,env);current=stepped.run as EvalRun;
    // This newly created private run has no competing caller, but never spin
    // on a lease if another administrator has already started stepping it.
    if(stepped.leaseActive)throw new EvaluationError(409,'evaluation_busy','검증 작업이 다른 요청에서 실행 중입니다. 작업 목록에서 진행 상태를 확인하세요.');
  }
  return {run:current};
}
