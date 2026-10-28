import { initialState } from './aegis-seed';
import { MAX_RESPONSE_RETRIES } from './response-retry';
import type { AppState, AuditEvent, Connection, Dataset, Deployment, EvalRun, EvalRunSummary, EvaluationStatus, EvaluationWorkerStatus, GatewayKey, IngressPolicy, KeyPolicy, RequestLog, RetentionPolicy } from './aegis-types';

export type AegisStatement = {
  bind(...values: unknown[]): AegisStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};
export type AegisDB = { prepare(query: string): AegisStatement; batch(statements: AegisStatement[]): Promise<unknown> };
export type AegisEnv = { DB?: AegisDB; [key: string]: unknown };
type StoredRecord = { namespace: string; id: string; payload: string };
type StoredDeployment = { id: string; workflow_id: string; alias: string; version: number; payload: string; created_at: string };
type KeyRow = {id:string;name:string;prefix:string;created_at:string;revoked:number;policy_payload?:string|null;usage_payload?:string|null};
type KeyUsage = {window:number;requests:number;tokens:number;leases:Record<string,number>};
export type QuotaReservation = {keyId:string;leaseId:string;window:number;reservedTokens:number};
export type DeploymentRequest = {id:string;requestHash:string};
export class DeploymentRequestConflict extends Error {}
export const DEFAULT_RETENTION:RetentionPolicy={logDays:30,evaluationDays:30,auditDays:90};
export type RequestLogQuery = {query?:string;workflowId?:string;keyId?:string;status?:RequestLog['status'];source?:RequestLog['source'];from?:string;to?:string;cursor?:string;limit?:number};
export type RequestLogPage = {logs:RequestLog[];total:number;nextCursor?:string;retention:{days:number;maxRecords:number}};
export type VerificationEvidenceSummary = {id:string;datasetId:string;datasetName:string;createdAt:string;fingerprint:string;datasetFingerprint:string;total:number;completedCount:number;matchedCount:number;completeCoverage:boolean;mock:boolean};

function logCursor(createdAt:string,id:string):string {
  const bytes=new TextEncoder().encode(JSON.stringify([createdAt,id]));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function readLogCursor(cursor:string):[string,string] {
  if(cursor.length>2048||!/^[-_a-zA-Z0-9]+$/.test(cursor))throw new Error('요청 기록의 페이지 위치를 확인하세요.');
  try{
    const encoded=cursor.replace(/-/g,'+').replace(/_/g,'/');
    const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(encoded),character=>character.charCodeAt(0))));
    if(!Array.isArray(value)||value.length!==2||typeof value[0]!=='string'||!Number.isFinite(Date.parse(value[0]))||value[0]!==new Date(value[0]).toISOString()||typeof value[1]!=='string'||!value[1]||value[1].length>120)throw new Error();
    return [value[0],value[1]];
  }catch{throw new Error('요청 기록의 페이지 위치를 확인하세요.');}
}

function keySummary(row:KeyRow):GatewayKey {
  const usage:KeyUsage=row.usage_payload?JSON.parse(row.usage_payload):{window:0,requests:0,tokens:0,leases:{}};
  const current=usage.window===Math.floor(Date.now()/60_000);
  return {id:row.id,name:row.name,prefix:row.prefix,createdAt:row.created_at,revoked:!!row.revoked,
    ...(row.policy_payload?{policy:JSON.parse(row.policy_payload)}:{}),
    usage:{requests:current?usage.requests:0,tokens:current?usage.tokens:0,active:Object.values(usage.leases||{}).filter(until=>until>Date.now()).length}};
}
function deploymentValue(row:StoredDeployment):Deployment {return {...JSON.parse(row.payload),id:row.id,workflowId:row.workflow_id,alias:row.alias,version:row.version,createdAt:row.created_at};}

export class AegisStore {
  db:AegisDB;
  constructor(env:AegisEnv) {
    if(!env.DB)throw new Error('DB 바인딩이 없습니다. 데이터베이스 마이그레이션과 DB 바인딩을 확인하세요.');
    this.db=env.DB;
  }
  async seed() {
    const initialized=await this.db.prepare("SELECT id FROM aegis_records WHERE namespace='meta' AND id='initialized'").first();
    if(initialized)return;
    const seed=initialState();const now=new Date().toISOString();
    const rows:[string,string,unknown][]=[
      ...seed.workflows.map(v=>['workflow',v.id,v] as [string,string,unknown]),
      ...seed.connections.map(v=>['connection',v.id,v] as [string,string,unknown]),
      ...seed.datasets.map(v=>['dataset',v.id,v] as [string,string,unknown]),
      ['meta','ingress',seed.ingress],['meta','initialized',true],
    ];
    await this.db.batch(rows.map(([ns,id,value])=>this.db.prepare('INSERT OR IGNORE INTO aegis_records (namespace,id,payload,updated_at) VALUES (?,?,?,?)').bind(ns,id,JSON.stringify(value),now)));
  }
  async state(includeHistory=true):Promise<AppState> {
    await this.seed();
    const retention=(await this.getRecord<RetentionPolicy>('meta','retention'))||DEFAULT_RETENTION;
    if(includeHistory)await this.pruneRetention(retention);
    const base="namespace IN ('workflow','connection','dataset','meta','diagnostic','model_metric')";
    const query=includeHistory?`SELECT namespace,id,payload FROM aegis_records WHERE ${base} OR (namespace='run' AND (json_extract(payload,'$.status')='running' OR id IN (SELECT id FROM aegis_records WHERE namespace='run' ORDER BY updated_at DESC LIMIT 10))) OR (namespace='audit' AND id IN (SELECT id FROM aegis_records WHERE namespace='audit' ORDER BY updated_at DESC LIMIT 100))`:`SELECT namespace,id,payload FROM aegis_records WHERE ${base}`;
    const [records,deployments,keys,logs,evaluationWorker]=await Promise.all([
      this.db.prepare(query).all<StoredRecord>(),
      this.db.prepare('SELECT * FROM aegis_deployments WHERE version=(SELECT MAX(latest.version) FROM aegis_deployments AS latest WHERE latest.alias=aegis_deployments.alias) OR id IN (SELECT id FROM aegis_deployments ORDER BY created_at DESC,version DESC LIMIT 100) ORDER BY created_at DESC,version DESC').all<StoredDeployment>(),
      this.db.prepare("SELECT k.id,k.name,k.prefix,k.created_at,k.revoked,p.payload AS policy_payload,u.payload AS usage_payload FROM aegis_gateway_keys k LEFT JOIN aegis_records p ON p.namespace='key_policy' AND p.id=k.id LEFT JOIN aegis_records u ON u.namespace='key_usage' AND u.id=k.id ORDER BY k.created_at DESC LIMIT 100").all<KeyRow>(),
      this.db.prepare(includeHistory?'SELECT payload FROM aegis_request_logs ORDER BY created_at DESC LIMIT 200':'SELECT payload FROM aegis_request_logs WHERE 0').all<{payload:string}>(),
      this.evaluationWorkerStatus(),
    ]);
    const by=<T>(namespace:string):T[]=>records.results.filter(r=>r.namespace===namespace).map(r=>JSON.parse(r.payload) as T);
    const ingress=records.results.find(r=>r.namespace==='meta'&&r.id==='ingress');
    const runs=by<AppState['runs'][number]>('run').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    // Evaluation processing leases are internal compare-and-swap metadata.
    for(const run of runs)delete (run as unknown as Record<string,unknown>)._lease;
    return {workflows:by('workflow'),connections:by('connection'),datasets:by('dataset'),ingress:ingress?JSON.parse(ingress.payload):initialState().ingress,
      runs,deployments:deployments.results.map(deploymentValue),keys:keys.results.map(keySummary),logs:logs.results.map(r=>JSON.parse(r.payload)),
      diagnostics:Object.fromEntries(records.results.filter(r=>r.namespace==='diagnostic').map(r=>[r.id,JSON.parse(r.payload)])),modelMetrics:Object.fromEntries(records.results.filter(r=>r.namespace==='model_metric').map(r=>[r.id,JSON.parse(r.payload)])),audit:by<AuditEvent>('audit').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),retention,evaluationWorker};
  }
  async evaluationWorkerStatus():Promise<EvaluationWorkerStatus> {
    const row=await this.db.prepare("SELECT payload FROM aegis_records WHERE namespace='evaluation_worker' ORDER BY CASE WHEN json_extract(payload,'$.expiresAt')>? THEN 0 ELSE 1 END,updated_at DESC LIMIT 1").bind(Date.now()).first<{payload:string}>();
    if(!row)return {available:false};
    let value:{seenAt?:unknown;expiresAt?:unknown;kind?:unknown};
    try{value=JSON.parse(row.payload);}catch{return {available:false};}
    if(typeof value.seenAt!=='string'||typeof value.expiresAt!=='number'||typeof value.kind!=='string'||!['local','remote'].includes(value.kind))return {available:false};
    return {available:value.expiresAt>Date.now(),lastSeenAt:value.seenAt,kind:value.kind as 'local'|'remote'};
  }
  async heartbeatEvaluationWorker(id:string,kind:'local'|'remote'):Promise<EvaluationWorkerStatus> {
    const now=Date.now(),seenAt=new Date(now).toISOString();
    await this.put('evaluation_worker',id,{seenAt,expiresAt:now+45_000,kind});
    await this.db.prepare("DELETE FROM aegis_records WHERE namespace='evaluation_worker' AND json_extract(payload,'$.expiresAt')<?").bind(now-86_400_000).run();
    return {available:true,lastSeenAt:seenAt,kind};
  }
  async backgroundEvaluationIds():Promise<string[]> {
    const rows=await this.db.prepare("SELECT id FROM aegis_records WHERE namespace='run' AND json_extract(payload,'$.status')='running' AND json_extract(payload,'$.executionMode')='background' ORDER BY json_extract(payload,'$.createdAt') ASC LIMIT 4").all<{id:string}>();
    return rows.results.map(row=>row.id);
  }
  async evaluationStatus(runId?:string):Promise<EvaluationStatus> {
    await this.seed();
    // Extract list fields in SQL: polling never transfers every saved prompt,
    // response and immutable snapshot just to update a progress indicator.
    const rows=await this.db.prepare(`SELECT id,
      json_extract(payload,'$.workflowId') AS workflowId,json_extract(payload,'$.workflowName') AS workflowName,
      json_extract(payload,'$.datasetId') AS datasetId,json_extract(payload,'$.datasetName') AS datasetName,
      json_extract(payload,'$.createdAt') AS createdAt,json_extract(payload,'$.updatedAt') AS updatedAt,
      json_extract(payload,'$.version') AS version,json_extract(payload,'$.executionMode') AS executionMode,json_extract(payload,'$.baselineVersion') AS baselineVersion,
      COALESCE(json_extract(payload,'$.status'),'completed') AS status,
      COALESCE(json_extract(payload,'$.total'),json_array_length(payload,'$.datasetSnapshot.rows'),json_array_length(payload,'$.results'),0) AS total,
      COALESCE(json_array_length(payload,'$.results'),0) AS completedCount
      FROM aegis_records WHERE namespace='run' AND (json_extract(payload,'$.status')='running' OR id IN (SELECT id FROM aegis_records WHERE namespace='run' ORDER BY updated_at DESC LIMIT 10))
      ORDER BY json_extract(payload,'$.createdAt') DESC`).all<EvalRunSummary>();
    const evaluationWorker=await this.evaluationWorkerStatus();
    let run:EvalRun|undefined;
    if(runId){const stored=await this.getRecord<EvalRun>('run',runId);if(stored){delete (stored as unknown as Record<string,unknown>)._lease;run=stored;}}
    const runs=rows.results.map(row=>{const summary={...row};if(summary.executionMode==null)delete summary.executionMode;if(summary.updatedAt==null)delete summary.updatedAt;if(summary.baselineVersion==null)delete summary.baselineVersion;return summary;});
    return {runs,...(run?{run}:{}),evaluationWorker};
  }
  async verificationEvidence(workflowId:string,fingerprint?:string):Promise<VerificationEvidenceSummary[]> {
    if(typeof workflowId!=='string'||!workflowId||workflowId.length>120||fingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error('배포 검증 대상과 설정 확인값을 확인하세요.');
    const retention=(await this.getRecord<RetentionPolicy>('meta','retention'))||DEFAULT_RETENTION;
    // Evidence discovery must cover all 30 current datasets without loading
    // their saved requests, answers or snapshots into the Worker/browser.
    const resultCount="COALESCE(json_array_length(r.payload,'$.results'),0)";
    const snapshotCount="COALESCE(json_array_length(r.payload,'$.datasetSnapshot.rows'),0)";
    const rows=await this.db.prepare(`WITH evidence AS (
      SELECT r.id,
        json_extract(r.payload,'$.datasetId') AS datasetId,COALESCE(json_extract(r.payload,'$.datasetName'),'') AS datasetName,
        COALESCE(json_extract(r.payload,'$.createdAt'),r.updated_at) AS createdAt,
        COALESCE(json_extract(r.payload,'$.fingerprint'),'') AS fingerprint,COALESCE(json_extract(r.payload,'$.datasetFingerprint'),'') AS datasetFingerprint,
        COALESCE(json_extract(r.payload,'$.total'),${snapshotCount}) AS total,${resultCount} AS completedCount,
        (SELECT COUNT(*) FROM json_each(r.payload,'$.results') AS result WHERE json_type(result.value,'$.expectationMatched')='true') AS matchedCount,
        CASE WHEN ${snapshotCount}>0 AND ${snapshotCount}=${resultCount}
          AND COALESCE(json_extract(r.payload,'$.total'),${snapshotCount})=${resultCount}
          AND (SELECT COUNT(DISTINCT json_extract(result.value,'$.rowId')) FROM json_each(r.payload,'$.results') AS result)=${snapshotCount}
          AND NOT EXISTS (SELECT 1 FROM json_each(r.payload,'$.datasetSnapshot.rows') AS expected WHERE NOT EXISTS (SELECT 1 FROM json_each(r.payload,'$.results') AS actual WHERE json_extract(actual.value,'$.rowId')=json_extract(expected.value,'$.id')))
          THEN 1 ELSE 0 END AS completeCoverage,
        EXISTS (SELECT 1 FROM json_each(r.payload,'$.results') AS result WHERE json_extract(result.value,'$.executionMode')='mock') AS mock
      FROM aegis_records AS r WHERE r.namespace='run' AND json_extract(r.payload,'$.workflowId')=?
        AND json_extract(r.payload,'$.status')='completed' AND COALESCE(json_extract(r.payload,'$.createdAt'),r.updated_at)>=?
        ${fingerprint!==undefined?"AND json_extract(r.payload,'$.fingerprint')=?":''}
        AND EXISTS (SELECT 1 FROM aegis_records AS dataset WHERE dataset.namespace='dataset' AND dataset.id=json_extract(r.payload,'$.datasetId'))
    ), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY datasetId ORDER BY createdAt DESC,id DESC) AS recentRank,
        ROW_NUMBER() OVER (PARTITION BY datasetId,CASE WHEN completeCoverage=1 AND matchedCount=completedCount AND mock=0 THEN 1 ELSE 0 END ORDER BY createdAt DESC,id DESC) AS outcomeRank FROM evidence
    ) SELECT id,datasetId,datasetName,createdAt,fingerprint,datasetFingerprint,total,completedCount,matchedCount,completeCoverage,mock FROM ranked WHERE recentRank<=3 OR (completeCoverage=1 AND matchedCount=completedCount AND mock=0 AND outcomeRank<=3) ORDER BY createdAt DESC,id DESC LIMIT 180`).bind(workflowId,new Date(Date.now()-retention.evaluationDays*86_400_000).toISOString(),...(fingerprint!==undefined?[fingerprint]:[])).all<Omit<VerificationEvidenceSummary,'completeCoverage'|'mock'>&{completeCoverage:number;mock:number}>();
    return rows.results.map(row=>({...row,completeCoverage:row.completeCoverage===1,mock:row.mock===1}));
  }
  async getRecordWithVersion<T>(namespace:string,id:string):Promise<{value:T;revision:string}|null> {
    const row=await this.db.prepare('SELECT payload FROM aegis_records WHERE namespace=? AND id=?').bind(namespace,id).first<{payload:string}>();
    if(!row||typeof row.payload!=='string')return null;
    return {value:JSON.parse(row.payload) as T,revision:row.payload};
  }
  async getRecord<T>(namespace:string,id:string):Promise<T|null>{return (await this.getRecordWithVersion<T>(namespace,id))?.value??null;}
  async compareAndSwap(namespace:string,id:string,expectedRevision:string,value:unknown):Promise<boolean> {
    const row=await this.db.prepare('UPDATE aegis_records SET payload=?,updated_at=? WHERE namespace=? AND id=? AND payload=? RETURNING id').bind(JSON.stringify(value),new Date().toISOString(),namespace,id,expectedRevision).first<{id:string}>();
    return !!row;
  }
  async put(namespace:string,id:string,value:unknown) {
    await this.db.prepare('INSERT INTO aegis_records (namespace,id,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').bind(namespace,id,JSON.stringify(value),new Date().toISOString()).run();
  }
  async saveRecordChecked(namespace:'workflow'|'dataset',id:string,value:unknown,expectedUpdatedAt?:string|null):Promise<boolean> {
    if(!['workflow','dataset'].includes(namespace))throw new Error('저장할 항목을 확인하세요.');
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('저장할 내용을 확인하세요.');
    if(expectedUpdatedAt!==undefined&&expectedUpdatedAt!==null&&typeof expectedUpdatedAt!=='string')throw new Error('저장 기준을 확인하세요.');
    // A successful write must advance the revision even when two saves happen
    // within the same millisecond. Older seed records use an empty revision.
    const previous=typeof expectedUpdatedAt==='string'?Date.parse(expectedUpdatedAt):NaN;
    const now=new Date(Number.isFinite(previous)?Math.max(Date.now(),previous+1):Date.now()).toISOString();
    const payload=JSON.stringify({...value,updatedAt:now});
    let condition:string,args:unknown[];
    if(expectedUpdatedAt===undefined){
      condition='(EXISTS (SELECT 1 FROM aegis_records WHERE namespace=? AND id=?) OR (SELECT COUNT(*) FROM aegis_records WHERE namespace=?)<30)';args=[namespace,id,namespace];
    }else if(expectedUpdatedAt===null){
      condition='NOT EXISTS (SELECT 1 FROM aegis_records WHERE namespace=? AND id=?) AND (SELECT COUNT(*) FROM aegis_records WHERE namespace=?)<30';args=[namespace,id,namespace];
    }else{
      condition="EXISTS (SELECT 1 FROM aegis_records WHERE namespace=? AND id=? AND COALESCE(json_extract(payload,'$.updatedAt'),'')=?)";args=[namespace,id,expectedUpdatedAt];
    }
    const row=await this.db.prepare(`INSERT INTO aegis_records (namespace,id,payload,updated_at) SELECT ?,?,?,? WHERE ${condition} ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at RETURNING id`).bind(namespace,id,payload,now,...args).first<{id:string}>();
    return !!row;
  }
  async putIfUnchanged(namespace:string,id:string,value:unknown,checks:{namespace:string;id:string;revision:string}[]):Promise<boolean> {
    const conditions=checks.map(()=> 'EXISTS (SELECT 1 FROM aegis_records WHERE namespace=? AND id=? AND payload=?)');
    const sql=`INSERT INTO aegis_records (namespace,id,payload,updated_at) SELECT ?,?,?,? WHERE ${conditions.length?conditions.join(' AND '):'1'} ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at RETURNING id`;
    const row=await this.db.prepare(sql).bind(namespace,id,JSON.stringify(value),new Date().toISOString(),...checks.flatMap(check=>[check.namespace,check.id,check.revision])).first<{id:string}>();
    return !!row;
  }
  async saveConnection(connection:Connection) {
    await this.db.batch([
      this.db.prepare("INSERT INTO aegis_records (namespace,id,payload,updated_at) VALUES ('connection',?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at").bind(connection.id,JSON.stringify(connection),new Date().toISOString()),
      this.db.prepare("DELETE FROM aegis_records WHERE namespace IN ('diagnostic','model_metric') AND id=?").bind(connection.id),
    ]);
  }
  async deleteConnection(id:string) {
    await this.db.prepare("DELETE FROM aegis_records WHERE namespace IN ('connection','diagnostic','model_metric') AND id=?").bind(id).run();
  }
  async saveIngress(ingress:IngressPolicy) {
    await this.db.batch([
      this.db.prepare("INSERT INTO aegis_records (namespace,id,payload,updated_at) VALUES ('meta','ingress',?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at").bind(JSON.stringify(ingress),new Date().toISOString()),
      this.db.prepare("DELETE FROM aegis_records WHERE namespace IN ('diagnostic','model_metric')"),
    ]);
  }
  async insertEvaluationRun(run:EvalRun,maxRunning=4):Promise<boolean> {
    const row=await this.db.prepare("INSERT INTO aegis_records (namespace,id,payload,updated_at) SELECT 'run',?,?,? WHERE (SELECT COUNT(*) FROM aegis_records WHERE namespace='run' AND json_extract(payload,'$.status')='running')<? RETURNING id").bind(run.id,JSON.stringify(run),new Date().toISOString(),maxRunning).first<{id:string}>();
    return !!row;
  }
  async insertMappedDataset(dataset:Dataset,checks:{namespace:string;id:string;revision:string}[],maxDatasets=30,latestDeployment?:{workflowId:string;id:string}):Promise<boolean> {
    const conditions=checks.map(()=> 'EXISTS (SELECT 1 FROM aegis_records WHERE namespace=? AND id=? AND payload=?)');
    conditions.push("(SELECT COUNT(*) FROM aegis_records WHERE namespace='dataset')<?");
    if(latestDeployment)conditions.push('?=(SELECT id FROM aegis_deployments WHERE workflow_id=? ORDER BY created_at DESC,version DESC LIMIT 1)');
    const sql=`INSERT INTO aegis_records (namespace,id,payload,updated_at) SELECT 'dataset',?,?,? WHERE ${conditions.join(' AND ')} RETURNING id`;
    const row=await this.db.prepare(sql).bind(dataset.id,JSON.stringify(dataset),new Date().toISOString(),...checks.flatMap(check=>[check.namespace,check.id,check.revision]),maxDatasets,...(latestDeployment?[latestDeployment.id,latestDeployment.workflowId]:[])).first<{id:string}>();
    return !!row;
  }
  async remove(namespace:string,id:string){await this.db.prepare('DELETE FROM aegis_records WHERE namespace=? AND id=?').bind(namespace,id).run();}
  async getDeployment(id:string):Promise<Deployment|null> {
    const row=await this.db.prepare('SELECT * FROM aegis_deployments WHERE id=?').bind(id).first<StoredDeployment>();return row?deploymentValue(row):null;
  }
  async activeDeployment(alias:string):Promise<Deployment|null> {
    const row=await this.db.prepare('SELECT * FROM aegis_deployments WHERE alias=? ORDER BY version DESC LIMIT 1').bind(alias).first<StoredDeployment>();
    return row?deploymentValue(row):null;
  }
  async activeModelSummaries(allowedModels?:string[]):Promise<{alias:string;createdAt:string}[]> {
    const rows=await this.db.prepare(`SELECT d.alias,d.created_at AS createdAt FROM aegis_deployments d
      WHERE d.version=(SELECT MAX(latest.version) FROM aegis_deployments latest WHERE latest.alias=d.alias)
      AND (? IS NULL OR d.alias IN (SELECT value FROM json_each(?))) ORDER BY d.alias`).bind(allowedModels===undefined?null:1,JSON.stringify(allowedModels??[])).all<{alias:string;createdAt:string}>();
    return rows.results;
  }
  async deploymentForRequest(request:DeploymentRequest):Promise<Deployment|null> {
    const saved=await this.getRecord<{requestHash:string;deploymentId:string}>('deployment_request',request.id);
    if(!saved)return null;
    if(saved.requestHash!==request.requestHash)throw new DeploymentRequestConflict('같은 요청 번호로 다른 배포를 요청할 수 없습니다. 새 요청 번호로 다시 시도하세요.');
    return this.getDeployment(saved.deploymentId);
  }
  async getDeploymentForRequest(workflowId:string,version:number):Promise<Deployment|null> {
    if(typeof workflowId!=='string'||!workflowId||workflowId.length>120||!Number.isSafeInteger(version)||version<1)throw new Error('요청에 사용한 배포 버전을 확인하세요.');
    // Versions belong to aliases. A renamed workflow can therefore have two
    // historical v1 snapshots; old logs without a deployment ID must not guess.
    const rows=await this.db.prepare('SELECT * FROM aegis_deployments WHERE workflow_id=? AND version=? ORDER BY created_at DESC,id DESC LIMIT 2').bind(workflowId,version).all<StoredDeployment>();
    return rows.results.length===1?deploymentValue(rows.results[0]):null;
  }
  async deployChecked(deployment:Omit<Deployment,'version'>,checks:{namespace:string;id:string;revision:string}[],options?:{audit:AuditEvent;request?:DeploymentRequest}):Promise<Deployment|null> {
    if(options?.request){const previous=await this.deploymentForRequest(options.request);if(previous)return previous;}
    const compact:{namespace:string;id:string;revision:string}[]=[];
    for(const check of checks){
      if(!['workflow','connection','run','dataset','meta'].includes(check.namespace))throw new Error('지원하지 않는 배포 검사 범위입니다.');
      // Keep full payload comparison at capture time, then atomically check the
      // trigger-managed revision token. This avoids binding many MB of saved
      // evaluation output or exceeding D1's 100-parameter query limit.
      const row=await this.db.prepare('SELECT revision FROM aegis_records WHERE namespace=? AND id=? AND payload=?').bind(check.namespace,check.id,check.revision).first<{revision:string}>();
      if(!row?.revision)return null;
      compact.push({namespace:check.namespace,id:check.id,revision:row.revision});
    }
    const conditions=[`NOT EXISTS (SELECT 1 FROM json_each(?) c WHERE NOT EXISTS (
      SELECT 1 FROM aegis_records r WHERE r.namespace=json_extract(c.value,'$.namespace') AND r.id=json_extract(c.value,'$.id') AND r.revision=json_extract(c.value,'$.revision')))`,'NOT EXISTS (SELECT 1 FROM aegis_deployments WHERE alias=? AND workflow_id<>?)'];
    if(options?.request)conditions.push("NOT EXISTS (SELECT 1 FROM aegis_records WHERE namespace='deployment_request' AND id=?)");
    const sql=`INSERT INTO aegis_deployments (id,workflow_id,alias,version,payload,created_at) SELECT ?,?,?,(SELECT COALESCE(MAX(version),0)+1 FROM aegis_deployments WHERE alias=?),?,? WHERE ${conditions.join(' AND ')}`;
    const args:unknown[]=[deployment.id,deployment.workflowId,deployment.alias,deployment.alias,JSON.stringify(deployment),deployment.createdAt,JSON.stringify(compact),deployment.alias,deployment.workflowId,...(options?.request?[options.request.id]:[])];
    const statements=[this.db.prepare(sql).bind(...args)];
    if(options){
      statements.push(this.db.prepare("INSERT INTO aegis_records (namespace,id,payload,updated_at) SELECT 'audit',?,?,? WHERE EXISTS (SELECT 1 FROM aegis_deployments WHERE id=?)").bind(options.audit.id,JSON.stringify(options.audit),options.audit.createdAt,deployment.id));
      if(options.request)statements.push(this.db.prepare("INSERT INTO aegis_records (namespace,id,payload,updated_at) SELECT 'deployment_request',?,?,? WHERE EXISTS (SELECT 1 FROM aegis_deployments WHERE id=?)").bind(options.request.id,JSON.stringify({requestHash:options.request.requestHash,deploymentId:deployment.id}),deployment.createdAt,deployment.id));
    }
    // D1 batch and the standalone adapter both provide one transaction: an
    // audit or idempotency write failure cannot leave a published version.
    await this.db.batch(statements);
    const saved=await this.getDeployment(deployment.id);
    return saved??(options?.request?await this.deploymentForRequest(options.request):null);
  }
  async deploy(deployment:Omit<Deployment,'version'>):Promise<Deployment>{const saved=await this.deployChecked(deployment,[]);if(!saved)throw new Error('배포 버전 저장에 실패했습니다.');return saved;}
  async log(log:RequestLog) {
    // Classifier explanations may quote rejected content. Persist decision
    // metadata with fixed descriptions; prompts and generated text stay out.
    const reason=(status:string)=>status==='allow'?'검사를 통과했습니다.':status==='block'?'정책에 따라 차단했습니다.':status==='skipped'?'실행하지 않았습니다.':'실행 중 오류가 발생했습니다.';
    const usage=log.usage?{prompt_tokens:log.usage.prompt_tokens,completion_tokens:log.usage.completion_tokens,total_tokens:log.usage.total_tokens}:undefined;
    const attempts=log.attempts?.slice(0,MAX_RESPONSE_RETRIES+1).map(attempt=>({number:attempt.number,status:attempt.status,stage:attempt.stage,latencyMs:attempt.latencyMs,reason:reason(attempt.status)}));
    const flowTraces=log.flowTraces?.slice(0,256).filter(trace=>typeof trace.nodeId==='string'&&trace.nodeId.length<=150&&['pre','post'].includes(trace.stage)&&['completed','skipped','block','error'].includes(trace.status)).map(trace=>({nodeId:trace.nodeId,stage:trace.stage,status:trace.status,edgeIds:Array.isArray(trace.edgeIds)?trace.edgeIds.filter(edgeId=>typeof edgeId==='string'&&edgeId.length<=120).slice(0,4):[],...(Number.isInteger(trace.attempt)&&trace.attempt!>=1&&trace.attempt!<=MAX_RESPONSE_RETRIES+1?{attempt:trace.attempt}:{})}));
    const safe:RequestLog={id:log.id,source:log.source,workflowName:log.workflowName,version:log.version,createdAt:log.createdAt,status:log.status,stage:log.stage,latencyMs:log.latencyMs,reason:reason(log.status),...(log.workflowId?{workflowId:log.workflowId}:{}),...(typeof log.deploymentId==='string'&&log.deploymentId.length>0&&log.deploymentId.length<=120?{deploymentId:log.deploymentId}:{}),...(log.keyId?{keyId:log.keyId}:{}),...(usage?{usage}:{}),...(attempts?{attempts}:{}),...(Number.isInteger(log.regenerationCount)&&log.regenerationCount!>=0&&log.regenerationCount!<=MAX_RESPONSE_RETRIES?{regenerationCount:log.regenerationCount}:{}),...(log.traces?{traces:log.traces.map(trace=>({ruleId:trace.ruleId,ruleName:trace.ruleName,stage:trace.stage,groupId:trace.groupId,status:trace.status,latencyMs:trace.latencyMs,reason:reason(trace.status),...(Number.isInteger(trace.attempt)&&trace.attempt!>=1&&trace.attempt!<=MAX_RESPONSE_RETRIES+1?{attempt:trace.attempt}:{})}))}:{})};
    if(flowTraces)safe.flowTraces=flowTraces;
    await this.db.prepare('INSERT INTO aegis_request_logs (id,payload,created_at) VALUES (?,?,?)').bind(safe.id,JSON.stringify(safe),safe.createdAt).run();
    const retention=(await this.getRecord<RetentionPolicy>('meta','retention'))||DEFAULT_RETENTION;
    await this.db.prepare('DELETE FROM aegis_request_logs WHERE created_at<? OR id IN (SELECT id FROM aegis_request_logs ORDER BY created_at DESC LIMIT -1 OFFSET 1000)').bind(new Date(Date.now()-retention.logDays*86_400_000).toISOString()).run();
  }
  async searchLogs(options:RequestLogQuery={}):Promise<RequestLogPage> {
    const limit=options.limit??50;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('요청 기록은 한 번에 1~100건까지 조회할 수 있습니다.');
    for(const [key,max] of [['query',200],['workflowId',120],['keyId',120]] as const){if(options[key]!==undefined&&(typeof options[key]!=='string'||options[key]!.length>max))throw new Error('요청 기록 검색 조건을 확인하세요.');}
    if(options.status!==undefined&&!['allow','block','error'].includes(options.status))throw new Error('요청 기록의 판정을 확인하세요.');
    if(options.source!==undefined&&!['playground','evaluation','gateway'].includes(options.source))throw new Error('요청 기록의 호출 구분을 확인하세요.');
    const date=(value:string|undefined)=>{if(value===undefined)return undefined;if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw new Error('요청 기록의 조회 기간을 확인하세요.');return new Date(value).toISOString();};
    const from=date(options.from),to=date(options.to);
    if(from&&to&&from>=to)throw new Error('조회 종료 시각은 시작 시각보다 뒤여야 합니다.');
    const retention=(await this.getRecord<RetentionPolicy>('meta','retention'))||DEFAULT_RETENTION;
    const conditions=['created_at>=?'],values:unknown[]=[new Date(Date.now()-retention.logDays*86_400_000).toISOString()];
    const query=options.query?.trim();
    if(query){conditions.push("(instr(lower(id),lower(?))>0 OR instr(lower(COALESCE(json_extract(payload,'$.workflowName'),'')),lower(?))>0 OR instr(lower(COALESCE(json_extract(payload,'$.reason'),'')),lower(?))>0)");values.push(query,query,query);}
    for(const [field,value] of [['workflowId',options.workflowId],['keyId',options.keyId],['status',options.status],['source',options.source]] as const){if(value!==undefined){conditions.push(`json_extract(payload,'$.${field}')=?`);values.push(value);}}
    if(from){conditions.push('created_at>=?');values.push(from);}
    if(to){conditions.push('created_at<?');values.push(to);}
    const where=conditions.join(' AND ');
    const count=await this.db.prepare(`SELECT COUNT(*) AS total FROM aegis_request_logs WHERE ${where}`).bind(...values).first<{total:number}>();
    if(options.cursor!==undefined){const [createdAt,id]=readLogCursor(options.cursor);conditions.push('(created_at<? OR (created_at=? AND id<?))');values.push(createdAt,createdAt,id);}
    const rows=await this.db.prepare(`SELECT id,created_at,payload FROM aegis_request_logs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(...values,limit+1).all<{id:string;created_at:string;payload:string}>();
    const visible=rows.results.slice(0,limit),last=visible.at(-1);
    return {logs:visible.map(row=>JSON.parse(row.payload) as RequestLog),total:Number(count?.total??0),...(rows.results.length>limit&&last?{nextCursor:logCursor(last.created_at,last.id)}:{}),retention:{days:retention.logDays,maxRecords:1000}};
  }
  async getRequestLog(id:string):Promise<RequestLog|null> {
    if(typeof id!=='string'||!id||id.length>120)throw new Error('요청 ID를 확인하세요.');
    const retention=(await this.getRecord<RetentionPolicy>('meta','retention'))||DEFAULT_RETENTION;
    const row=await this.db.prepare('SELECT payload FROM aegis_request_logs WHERE id=? AND created_at>=?').bind(id,new Date(Date.now()-retention.logDays*86_400_000).toISOString()).first<{payload:string}>();
    return row?JSON.parse(row.payload) as RequestLog:null;
  }
  async audit(event:AuditEvent){await this.put('audit',event.id,event);}
  async pruneRetention(retention:RetentionPolicy) {
    const cutoff=(days:number)=>new Date(Date.now()-days*86_400_000).toISOString();
    await this.db.batch([
      this.db.prepare('DELETE FROM aegis_request_logs WHERE created_at<?').bind(cutoff(retention.logDays)),
      this.db.prepare("DELETE FROM aegis_records WHERE namespace='run' AND COALESCE(json_extract(payload,'$.status'),'completed')!='running' AND COALESCE(json_extract(payload,'$.createdAt'),updated_at)<?").bind(cutoff(retention.evaluationDays)),
      this.db.prepare("DELETE FROM aegis_records WHERE namespace='audit' AND updated_at<?").bind(cutoff(retention.auditDays)),
    ]);
  }
  async createKey(name:string,policy?:KeyPolicy):Promise<{key:string;summary:GatewayKey}> {
    const key='ag_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
    const summary:GatewayKey={id:crypto.randomUUID(),name,prefix:key.slice(0,11),createdAt:new Date().toISOString(),revoked:false,...(policy?{policy}:{})};
    await this.db.prepare('INSERT INTO aegis_gateway_keys (id,name,prefix,hash,created_at,revoked) VALUES (?,?,?,?,?,0)').bind(summary.id,summary.name,summary.prefix,await hashKey(key),summary.createdAt).run();
    if(policy)await this.put('key_policy',summary.id,policy);return {key,summary};
  }
  async updateKeyPolicy(id:string,policy:KeyPolicy){await this.put('key_policy',id,policy);}
  async revokeKey(id:string){await this.db.prepare('UPDATE aegis_gateway_keys SET revoked=1 WHERE id=?').bind(id).run();}
  async authenticate(key:string):Promise<GatewayKey|null> {
    const row=await this.db.prepare("SELECT k.id,k.name,k.prefix,k.created_at,k.revoked,p.payload AS policy_payload FROM aegis_gateway_keys k LEFT JOIN aegis_records p ON p.namespace='key_policy' AND p.id=k.id WHERE k.hash=? AND k.revoked=0").bind(await hashKey(key)).first<KeyRow>();return row?keySummary(row):null;
  }
  async authorized(key:string):Promise<boolean>{return !!(await this.authenticate(key));}
  async reserveQuota(key:GatewayKey,reservedTokens:number,leaseMs:number):Promise<{reservation:QuotaReservation}|{denied:'rpm_limit'|'tpm_limit'|'concurrency_limit'}> {
    const now=Date.now(),window=Math.floor(now/60_000),leaseId=crypto.randomUUID();const policy=key.policy||{};
    await this.db.prepare("INSERT OR IGNORE INTO aegis_records (namespace,id,payload,updated_at) VALUES ('key_usage',?,?,?)").bind(key.id,JSON.stringify({window,requests:0,tokens:0,leases:{}}),new Date(now).toISOString()).run();
    // One conditional UPDATE reserves RPM, TPM and an expiring concurrent lease
    // atomically across all Worker isolates and standalone server processes.
    const query=`WITH p AS (SELECT ? AS clock,? AS minute,? AS token_count,? AS lease_id,? AS lease_until,? AS rpm,? AS tpm,? AS concurrent_limit)
      UPDATE aegis_records SET payload=json_object(
        'window',(SELECT minute FROM p),
        'requests',CASE WHEN json_extract(payload,'$.window')=(SELECT minute FROM p) THEN COALESCE(json_extract(payload,'$.requests'),0)+1 ELSE 1 END,
        'tokens',CASE WHEN json_extract(payload,'$.window')=(SELECT minute FROM p) THEN COALESCE(json_extract(payload,'$.tokens'),0)+(SELECT token_count FROM p) ELSE (SELECT token_count FROM p) END,
        'leases',json(json_patch(COALESCE((SELECT json_group_object(key,value) FROM json_each(aegis_records.payload,'$.leases') WHERE value>(SELECT clock FROM p)),'{}'),json_object((SELECT lease_id FROM p),(SELECT lease_until FROM p))))
      ),updated_at=? WHERE namespace='key_usage' AND id=?
      AND ((SELECT rpm FROM p)<0 OR (CASE WHEN json_extract(payload,'$.window')=(SELECT minute FROM p) THEN COALESCE(json_extract(payload,'$.requests'),0) ELSE 0 END)<(SELECT rpm FROM p))
      AND ((SELECT tpm FROM p)<0 OR (CASE WHEN json_extract(payload,'$.window')=(SELECT minute FROM p) THEN COALESCE(json_extract(payload,'$.tokens'),0) ELSE 0 END)+(SELECT token_count FROM p)<=(SELECT tpm FROM p))
      AND ((SELECT concurrent_limit FROM p)<0 OR (SELECT COUNT(*) FROM json_each(aegis_records.payload,'$.leases') WHERE value>(SELECT clock FROM p))<(SELECT concurrent_limit FROM p)) RETURNING id`;
    const row=await this.db.prepare(query).bind(now,window,reservedTokens,leaseId,now+leaseMs,policy.rpmLimit??-1,policy.tpmLimit??-1,policy.maxConcurrent??-1,new Date(now).toISOString(),key.id).first<{id:string}>();
    if(row)return {reservation:{keyId:key.id,leaseId,window,reservedTokens}};
    const usage=await this.getRecord<KeyUsage>('key_usage',key.id);
    if(policy.maxConcurrent&&Object.values(usage?.leases||{}).filter(v=>v>now).length>=policy.maxConcurrent)return {denied:'concurrency_limit'};
    if(policy.rpmLimit&&(usage?.window===window?usage.requests:0)>=policy.rpmLimit)return {denied:'rpm_limit'};
    return {denied:'tpm_limit'};
  }
  async releaseQuota(reservation:QuotaReservation,actualTokens:number) {
    const path=`$.leases."${reservation.leaseId}"`;
    await this.db.prepare("UPDATE aegis_records SET payload=json_remove(json_set(payload,'$.tokens',CASE WHEN json_extract(payload,'$.window')=? THEN MAX(0,COALESCE(json_extract(payload,'$.tokens'),0)-?+?) ELSE COALESCE(json_extract(payload,'$.tokens'),0) END),?),updated_at=? WHERE namespace='key_usage' AND id=? AND json_type(payload,?) IS NOT NULL").bind(reservation.window,reservation.reservedTokens,Math.max(0,Math.ceil(actualTokens)),path,new Date().toISOString(),reservation.keyId,path).run();
  }
}
async function hashKey(key:string){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
