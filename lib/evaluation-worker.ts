import { AegisStore, type AegisEnv } from './aegis-store';
import { processBackgroundEvaluationRun } from './evaluation-service';
import type { EvaluationWorkerStatus, IngressPolicy } from './aegis-types';

type WorkerIdentity = { id: string; kind: 'local'|'remote' };
export type EvaluationQueueProgress = { checked: number; processed: number; busy: number; failed: number };
function workerId(value:unknown):value is string {
  return typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value);
}
export async function heartbeatEvaluationWorker(env:AegisEnv,worker:WorkerIdentity):Promise<EvaluationWorkerStatus> {
  if(!workerId(worker.id)||!['local','remote'].includes(worker.kind))throw new Error('검증 작업자 정보를 확인하세요.');
  const store=new AegisStore(env);await store.seed();
  return store.heartbeatEvaluationWorker(worker.id,worker.kind);
}
export async function releaseEvaluationWorker(env:AegisEnv,id:string):Promise<void> {
  if(!workerId(id))throw new Error('검증 작업자 정보를 확인하세요.');
  await new AegisStore(env).remove('evaluation_worker',id);
}
/** One persisted batch per active job. Callers own their independent lifetime.
 * A server process polls this function; a remote runner keeps its HTTP request
 * attached until the batch finishes. No request-local detached promises exist.
 */
export async function processEvaluationQueue(env:AegisEnv):Promise<EvaluationQueueProgress> {
  const store=new AegisStore(env);await store.seed();
  const ids=await store.backgroundEvaluationIds();
  const progress:EvaluationQueueProgress={checked:ids.length,processed:0,busy:0,failed:0};
  await Promise.all(ids.map(async id=>{
    try{
      // Resolve ingress anew for each batch; stored model/workflow/data snapshots
      // remain immutable even when their editable originals have been removed.
      const ingress=await store.getRecord<IngressPolicy>('meta','ingress');
      if(!ingress)throw new Error('검증 접근 정책을 찾을 수 없습니다.');
      const result=await processBackgroundEvaluationRun(id,{ingress},store,env);
      if(result.processed)progress.processed++;
      if(result.leaseActive)progress.busy++;
    }catch{progress.failed++;}
  }));
  return progress;
}
function reply(value:unknown,status=200):Response {
  return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
async function sameSecret(candidate:string,expected:string):Promise<boolean> {
  const encoder=new TextEncoder();
  const [left,right]=await Promise.all([candidate,expected].map(value=>crypto.subtle.digest('SHA-256',encoder.encode(value))));
  const a=new Uint8Array(left),b=new Uint8Array(right);let difference=0;
  for(let index=0;index<a.length;index++)difference|=a[index]^b[index];
  return difference===0;
}
async function readWorkerBody(request:Request):Promise<unknown> {
  const length=request.headers.get('content-length');
  if(length&&Number(length)>2048)throw new Error('too_large');
  const reader=request.body?.getReader();if(!reader)throw new Error('invalid');
  const parts:Uint8Array[]=[];let size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();throw new Error('too_large');}parts.push(value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
/** Narrow machine endpoint: management and Gateway credentials do not authorize it. */
export async function handleEvaluationWorker(request:Request,env:AegisEnv):Promise<Response> {
  if(request.method!=='POST')return reply({error:{code:'method_not_allowed',message:'POST 요청이 필요합니다.'}},405);
  const secret=env.AEGIS_EVALUATION_WORKER_TOKEN;
  if(typeof secret!=='string'||secret.length<32||secret.length>512||/[\r\n]/.test(secret))return reply({error:{code:'evaluation_worker_not_configured',message:'검증 작업자 인증이 설정되어 있지 않습니다.'}},503);
  const authorization=request.headers.get('authorization')??'';
  const candidate=authorization.startsWith('Bearer ')?authorization.slice(7):'';
  if(!candidate||candidate.length>512||!await sameSecret(candidate,secret))return reply({error:{code:'unauthorized',message:'검증 작업자 인증이 필요합니다.'}},401);
  let data:unknown;
  try{data=await readWorkerBody(request);}catch(error){const large=error instanceof Error&&error.message==='too_large';return reply({error:{code:large?'request_too_large':'invalid_request',message:large?'작업자 요청 본문은 2KB 이하로 보내세요.':'올바른 JSON 요청이 필요합니다.'}},large?413:400);}
  if(!data||typeof data!=='object'||Array.isArray(data))return reply({error:{code:'invalid_request',message:'작업자 요청을 확인하세요.'}},400);
  const body=data as Record<string,unknown>;
  if(Object.keys(body).some(key=>!['action','workerId'].includes(key))||!workerId(body.workerId)||typeof body.action!=='string'||!['heartbeat','process','disconnect'].includes(body.action))return reply({error:{code:'invalid_request',message:'작업자 요청을 확인하세요.'}},400);
  try{
    if(body.action==='disconnect'){await releaseEvaluationWorker(env,body.workerId);return reply({disconnected:true});}
    const evaluationWorker=await heartbeatEvaluationWorker(env,{id:body.workerId,kind:'remote'});
    if(body.action==='heartbeat')return reply({evaluationWorker});
    return reply({progress:await processEvaluationQueue(env)});
  }catch{return reply({error:{code:'evaluation_worker_error',message:'검증 작업자가 요청을 처리하지 못했습니다. 서버 상태를 확인하세요.'}},500);}
}
