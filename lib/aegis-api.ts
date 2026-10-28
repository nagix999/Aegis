import { verifyDeploymentEvidence, DeploymentVerificationError } from './deployment-verification';
import { z } from 'zod';
import { connectionLabel } from './product-copy';
import { AegisStore, DeploymentRequestConflict, type AegisEnv, type QuotaReservation } from './aegis-store';
import { deploymentRequest } from './deployment-commands';
import { ENGINE_VERSION } from './execution-provenance';
import { configurationFingerprint, datasetFingerprint, referencedConnections } from './workflow-review';
import { handleEvaluationAction, EvaluationError } from './evaluation-service';
import { executionLeaseDuration, MAX_RESPONSE_RETRIES, responseTokenReservation } from './response-retry';
import { validateWorkflowGraph } from './workflow-graph';
import { zoneMembershipIssue } from './workflow-zones';
import { applyDatasetRuleMappings } from './dataset-compatibility';
import { collectConnectionMetrics, diagnoseConnection, executeWorkflow, ipv4Allowed, testConnection, validateConnection, validateIngress, validateWorkflow, type ChatMessage } from './aegis-engine';
import type { AppState, Connection, ConsoleRole, Dataset, Deployment, ExecutionResult, GatewayKey, IngressPolicy, RequestLog, Workflow } from './aegis-types';

class ApiError extends Error {
  status: number;
  code: string;
  constructor(message:string, code='invalid_request', status=400) { super(message); this.status=status; this.code=code; }
}
const text = (max=160) => z.string().trim().min(1).max(max);
const id = text(120);
const ruleSchema = z.object({id,name:text(100),description:z.string().max(500),kind:z.enum(['keyword','regex','length','llm','pii','json','required']),enabled:z.boolean(),config:z.object({
  pattern:z.string().max(2000).optional(),maxLength:z.number().int().min(1).max(40000).optional(),prompt:z.string().max(4000).optional(),connectionId:id.optional(),
  piiTypes:z.array(z.enum(['email','phone','resident'])).max(3).optional(),requiredKeys:z.array(z.string().trim().min(1).max(100)).max(32).optional(),
  jsonMode:z.enum(['object','any']).optional(),matchMode:z.enum(['any','all']).optional(),guardProfile:z.enum(['custom','injection','safety']).optional(),
})});
const groupSchema = z.object({id,name:text(100),mode:z.enum(['any','all']),rules:z.array(ruleSchema).min(1).max(12),required:z.boolean().optional()});
const graphConditionSchema=z.object({operator:z.enum(['contains','not_contains','length_gte','length_lte']),value:z.string().max(2000),caseSensitive:z.boolean().optional()}).strict();
const stageGraphSchema=z.object({nodes:z.array(z.object({id,name:text(100),kind:z.enum(['condition','fork','join']),condition:graphConditionSchema.optional()}).strict()).max(12),edges:z.array(z.object({id,from:text(150),to:text(150),port:z.enum(['next','true','false']).optional()}).strict()).max(64)}).strict();
const graphSchema=z.object({version:z.literal(1),pre:stageGraphSchema,post:stageGraphSchema}).strict();
const zoneSchema=z.object({id:text(100),name:text(100),color:z.enum(['slate','blue','green','amber','violet']),nodeKeys:z.array(z.string().min(1).max(150)).max(963),x:z.number().finite().min(0).max(40000),y:z.number().finite().min(0).max(40000),width:z.number().finite().min(240).max(50000),height:z.number().finite().min(160).max(50000)}).strict();
const layoutSchema = z.object({version:z.literal(1),positions:z.record(z.string().min(1).max(150),z.object({x:z.number().finite().min(0).max(40000),y:z.number().finite().min(0).max(40000)})).refine(positions=>Object.keys(positions).length<=963,'노드 위치는 최대 963개까지 저장할 수 있습니다.'),zones:z.array(zoneSchema).max(32).optional(),pinnedKeys:z.array(z.string().min(1).max(150)).max(99).refine(keys=>new Set(keys).size===keys.length).optional()});
const lineageId=text(120).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)&&!['__proto__','constructor','prototype'].includes(value),'검사 연결 ID를 확인하세요.');
const cloneSourceSchema=z.object({workflowId:lineageId,ruleIds:z.record(lineageId,lineageId).refine(values=>Object.keys(values).length<=864&&new Set(Object.values(values)).size===Object.values(values).length,'복제 연결 정보는 중복 없이 최대 864개까지 저장할 수 있습니다.')}).strict();
const workflowSchema = z.object({id,name:text(120),description:z.string().max(1000),alias:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),mainConnectionId:id,inputScope:z.enum(['conversation','user_messages','last_user']).optional(),executionLimits:z.object({timeoutMs:z.number().int().min(1000).max(600000),maxModelCalls:z.number().int().min(1).max(1000)}).strict().optional(),pre:z.array(groupSchema).max(36),post:z.array(groupSchema).max(36),updatedAt:z.string().max(100),responseRetry:z.object({enabled:z.boolean(),maxRetries:z.number().int().min(1).max(MAX_RESPONSE_RETRIES),instruction:z.string().max(2000).optional()}).optional(),releasePolicy:z.object({requireVerification:z.boolean(),requiredDatasetIds:z.array(id).max(30).refine(values=>new Set(values).size===values.length,'필수 데이터셋은 중복 없이 선택하세요.')}).strict().optional(),layout:layoutSchema.optional(),graph:graphSchema.optional(),cloneSource:cloneSourceSchema.optional(),policyRouting:z.never().optional()});
const connectionSchema = z.object({id,name:text(120),baseUrl:z.string().trim().max(500),model:text(200),role:z.enum(['main','guard','both']),mode:z.enum(['demo','vllm']),secretEnv:z.string().trim().max(100),timeoutMs:z.number().int().min(1000).max(60000)});
const ingressSchema = z.object({enabled:z.boolean(),allowedCidrs:z.array(z.string().trim().max(64)).max(100),allowedOrigins:z.array(z.string().trim().max(400)).max(100)});
const messageSchema = z.object({role:z.enum(['system','user','assistant']),content:z.string().min(1).max(16000)}).strict();
const conversationSchema = z.array(messageSchema).min(1).max(32).refine(messages=>messages.some(message=>message.role==='user'),'user 메시지가 하나 이상 필요합니다.').refine(messages=>messages.reduce((sum,message)=>sum+message.content.length,0)<=40000,'메시지 전체 길이는 40,000자 이하로 보내세요.');
const generationOptionsSchema = z.object({temperature:z.number().min(0).max(2).optional(),max_tokens:z.number().int().min(1).max(8192).optional(),top_p:z.number().min(0).max(1).optional()}).strict();
const datasetSchema = z.object({id,name:text(120),description:z.string().max(1000),rows:z.array(z.object({id,input:z.string().min(1).max(16000).refine(value=>value.trim().length>0,'입력에는 공백 외의 문자가 필요합니다.'),messages:conversationSchema.optional(),generationOptions:generationOptionsSchema.optional(),expected:z.enum(['allow','block']),category:z.string().trim().max(80).optional(),note:z.string().max(1000).optional(),expectedStage:z.enum(['pre','post','main','complete']).optional(),expectedRuleId:id.optional(),expectedDecision:z.never().optional(),expectedRoute:z.never().optional(),expectedPolicyCode:z.never().optional()})).min(1).max(100),updatedAt:z.string().max(100).optional()});
const keyPolicySchema=z.object({allowedModels:z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)).max(100).optional(),expiresAt:z.string().datetime().optional(),rpmLimit:z.number().int().min(1).max(100000).optional(),tpmLimit:z.number().int().min(1).max(10000000).optional(),maxConcurrent:z.number().int().min(1).max(1000).optional()});
const retentionSchema=z.object({logDays:z.number().int().min(1).max(3650),evaluationDays:z.number().int().min(1).max(3650),auditDays:z.number().int().min(1).max(3650)});

function parse<T>(schema:z.ZodType<T>, value:unknown):T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('입력값을 확인하세요: '+parsed.error.issues.slice(0,3).map(i=>`${i.path.join('.') || 'request'} ${i.message}`).join('; '));
  return parsed.data;
}
function assert(condition:unknown,message:string,code='invalid_request',status=400):asserts condition { if(!condition) throw new ApiError(message,code,status); }
function json(value:unknown,status=200,headers?:HeadersInit) { return Response.json(value,{status,headers:{'Cache-Control':'no-store',...headers}}); }
async function body(request:Request):Promise<Record<string,unknown>> {
  const declared=Number(request.headers.get('content-length')||'0');
  if(declared>2_000_000) throw new ApiError('요청 본문은 2MB 이하로 보내세요.','request_too_large',413);
  const raw=await request.text();
  if(new TextEncoder().encode(raw).length>2_000_000) throw new ApiError('요청 본문은 2MB 이하로 보내세요.','request_too_large',413);
  let parsed:unknown;
  try { parsed=JSON.parse(raw); } catch { throw new ApiError('올바른 JSON 본문이 필요합니다.'); }
  assert(parsed&&typeof parsed==='object'&&!Array.isArray(parsed),'JSON 객체 본문이 필요합니다.');
  return parsed as Record<string,unknown>;
}
function replyError(error:unknown,gateway=false):Response {
  if(error instanceof DeploymentRequestConflict)return json({error:{message:error.message,code:'idempotency_conflict'}},409);
  const known=error instanceof ApiError||error instanceof EvaluationError||error instanceof DeploymentVerificationError;
  const status=known?error.status:500;
  const message=known?error.message:'요청을 처리하지 못했습니다. 관리자에게 서버 상태 확인을 요청하세요.';
  return json({error:{message,code:known?error.code:'server_error',...(gateway?{type:status===401?'authentication_error':status===429?'rate_limit_error':status>=500?'server_error':'invalid_request_error',param:null}:{})}},status,status===429?{'Retry-After':'60'}:undefined);
}
function adminAllowed(request:Request,env:AegisEnv) {
  // Hosted browser identity is separate from platform service access. A service
  // bypass token may reach the Gateway but must not grant management access.
  const token=env.AEGIS_ADMIN_TOKEN;
  const hasAdminToken=typeof token==='string'&&token.length>0;
  const adminTokenValid=hasAdminToken&&(request.headers.get('authorization')===`Bearer ${token}`||request.headers.get('x-aegis-admin-token')===token);
  if(env.AEGIS_REQUIRE_ADMIN_IDENTITY==='true') {
    assert(request.headers.get('oai-authenticated-user-id')?.trim()||adminTokenValid,'관리자 계정으로 로그인하거나 관리자 인증 정보를 제공하세요.','unauthorized',401);
  } else if(hasAdminToken) {
    assert(adminTokenValid,'관리자 인증이 필요합니다.','unauthorized',401);
  }
  if(request.method!=='GET') {
    const origin=request.headers.get('origin');
    assert(!origin||origin===new URL(request.url).origin,'이 관리 화면과 다른 주소에서 보낸 변경 요청은 허용하지 않습니다.','origin_not_allowed',403);
  }
}
function workflowFrom(state:AppState,workflowId:unknown,target:unknown):{workflow:Workflow;connections:Connection[];version:string} {
  const workflow=state.workflows.find(w=>w.id===workflowId);
  assert(workflow,'워크플로우를 찾을 수 없습니다.','not_found',404);
  if(target==='deployed') {
    const deployment=state.deployments.filter(d=>d.workflowId===workflowId).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.version-a.version)[0];
    assert(deployment,'먼저 워크플로우를 배포하세요.','not_deployed');
    return {workflow:deployment.workflow,connections:deployment.connections,version:`v${deployment.version}`};
  }
  assert(target===undefined||target==='draft','target은 draft 또는 deployed여야 합니다.');
  return {workflow,connections:state.connections,version:'draft'};
}
function recordLog(result:ExecutionResult,source:RequestLog['source'],workflow:Workflow,version:string,keyId?:string,deploymentId?:string):RequestLog {
  return {id:result.id,source,workflowId:workflow.id,workflowName:workflow.name,version,createdAt:new Date().toISOString(),status:result.status,stage:result.stage,latencyMs:result.latencyMs,reason:result.reason,traces:result.traces,usage:result.usage,...(result.flowTraces?{flowTraces:result.flowTraces}:{}),...(result.attempts?{attempts:result.attempts}:{}),...(result.regenerationCount!==undefined?{regenerationCount:result.regenerationCount}:{}),...(keyId?{keyId}:{}),...(deploymentId?{deploymentId}:{})};
}
function enforceLimit(items:{id:string}[],itemId:string,max:number,label:string) { assert(items.some(i=>i.id===itemId)||items.length<max,`${label}은 최대 ${max}개까지 저장할 수 있습니다.`); }

function consoleRole(request:Request,env:AegisEnv):ConsoleRole {
  const token=env.AEGIS_ADMIN_TOKEN;
  if(typeof token==='string'&&token&&(request.headers.get('authorization')===`Bearer ${token}`||request.headers.get('x-aegis-admin-token')===token))return 'admin';
  if(env.AEGIS_ROLE_MAP===undefined||env.AEGIS_ROLE_MAP==='')return 'admin';
  let roles:unknown;try{roles=typeof env.AEGIS_ROLE_MAP==='string'?JSON.parse(env.AEGIS_ROLE_MAP):env.AEGIS_ROLE_MAP;}catch{throw new ApiError('서버 역할 설정을 확인하세요.','invalid_role_configuration',500);}
  assert(roles&&typeof roles==='object'&&!Array.isArray(roles),'서버 역할 설정을 확인하세요.','invalid_role_configuration',500);
  const identity=request.headers.get('oai-authenticated-user-id')||'';
  const role=(roles as Record<string,unknown>)[identity];return role==='admin'||role==='editor'||role==='viewer'?role:'viewer';
}
function requireActionRole(role:ConsoleRole,action:string) {
  if(role==='admin')return;
  const editorActions=new Set(['save_workflow','save_dataset','create_mapped_dataset','delete_dataset','playground','run_evaluation','start_evaluation','step_evaluation','cancel_evaluation','retry_evaluation','replay_evaluation']);
  assert(role==='editor'&&editorActions.has(action),'이 작업을 수행할 권한이 없습니다.','forbidden',403);
}
function auditTarget(data:Record<string,unknown>):string {
  const source=data.workflowId??data.deploymentId??data.runId??data.id??(data.workflow as {id?:unknown}|undefined)?.id??(data.connection as {id?:unknown}|undefined)?.id??(data.dataset as {id?:unknown}|undefined)?.id;
  return typeof source==='string'?source.slice(0,120):'settings';
}
function parsePolicy(value:unknown) {
  const policy=parse(keyPolicySchema,value??{});
  if(policy.expiresAt)assert(Date.parse(policy.expiresAt)>Date.now(),'만료 시각은 현재 이후로 설정하세요.');
  if(policy.allowedModels)policy.allowedModels=[...new Set(policy.allowedModels)];return policy;
}
function validateSnapshotConnections(connections:Connection[],state:AppState,env:AegisEnv) {
  for(const connection of connections.filter(c=>c.mode==='vllm')) {
    assert(state.ingress.allowedOrigins.includes(new URL(connection.baseUrl).origin),`${connectionLabel(connection.name)}: 접근 설정의 허용 모델 서버에 주소를 추가하세요.`);
    if(connection.secretEnv)assert(typeof env[connection.secretEnv]==='string'&&env[connection.secretEnv],`${connectionLabel(connection.name)}: 서버 환경변수 ${connection.secretEnv}가 설정되지 않았습니다.`);
  }
}
async function captureWorkflow(store:AegisStore,workflowId:string) {
  const captured=await store.getRecordWithVersion<Workflow>('workflow',workflowId);assert(captured,'워크플로우를 찾을 수 없습니다.','not_found',404);
  const workflow=captured.value;
  const identifiers=new Set([workflow.mainConnectionId,...[...workflow.pre,...workflow.post].flatMap(group=>group.rules.filter(rule=>rule.enabled&&rule.kind==='llm').map(rule=>rule.config.connectionId).filter((value):value is string=>!!value))]);
  const checks=[{namespace:'workflow',id:workflowId,revision:captured.revision}];const connections:Connection[]=[];
  for(const connectionId of identifiers){const connection=await store.getRecordWithVersion<Connection>('connection',connectionId);assert(connection,'선택한 모델 서버 설정을 찾을 수 없습니다.');connections.push(connection.value);checks.push({namespace:'connection',id:connectionId,revision:connection.revision});}
  return {workflow,connections:referencedConnections(workflow,connections),checks};
}

async function captureConnectionCheck(store:AegisStore,connectionId:string) {
  const connection=await store.getRecordWithVersion<Connection>('connection',connectionId);
  assert(connection,'모델 서버 설정을 찾을 수 없습니다.','not_found',404);
  const ingress=await store.getRecordWithVersion<IngressPolicy>('meta','ingress');
  assert(ingress,'접근 정책을 찾을 수 없습니다.','not_found',404);
  return {connection:connection.value,ingress:ingress.value,checks:[{namespace:'connection',id:connectionId,revision:connection.revision},{namespace:'meta',id:'ingress',revision:ingress.revision}]};
}

export async function handleConsole(request:Request,env:AegisEnv):Promise<Response> {
  try {
    adminAllowed(request,env);
    const store=new AegisStore(env);
    const role=consoleRole(request,env);
    if(request.method==='GET'&&new URL(request.url).searchParams.get('view')==='evaluations'){
      const runId=new URL(request.url).searchParams.get('runId');
      if(runId!==null)assert(runId.trim().length>0&&runId.length<=120,'검증 작업 ID를 확인하세요.');
      return json(await store.evaluationStatus(runId??undefined));
    }
    if(request.method==='GET'&&new URL(request.url).searchParams.get('view')==='deployment'){
      const params=new URL(request.url).searchParams;
      const deploymentId=params.get('deploymentId');
      if(deploymentId!==null)return json({deployment:await store.getDeployment(parse(id,deploymentId))});
      const workflowId=parse(id,params.get('workflowId'));
      const version=parse(z.coerce.number().int().positive(),params.get('version'));
      return json({deployment:await store.getDeploymentForRequest(workflowId,version)});
    }
    if(request.method==='GET'&&new URL(request.url).searchParams.get('view')==='logs'){
      const params=new URL(request.url).searchParams;
      const optionalText=(key:string,max:number)=>{const value=params.get(key);return value===null||value===''?undefined:parse(z.string().max(max),value);};
      const optionalTime=(key:string)=>{const value=optionalText(key,40);if(value!==undefined)assert(Number.isFinite(Date.parse(value)),'조회 기간을 확인하세요.');return value===undefined?undefined:new Date(value).toISOString();};
      const from=optionalTime('from'),to=optionalTime('to');
      assert(!from||!to||from<to,'조회 시작 시각은 종료 시각보다 빨라야 합니다.');
      const limit=params.has('limit')?parse(z.coerce.number().int().min(1).max(100),params.get('limit')):50;
      const status=optionalText('status',10),source=optionalText('source',20);
      const filters={query:optionalText('query',200),workflowId:optionalText('workflowId',120),keyId:optionalText('keyId',120),...(status?{status:parse(z.enum(['allow','block','error']),status)}:{}),...(source?{source:parse(z.enum(['playground','evaluation','gateway']),source)}:{}),from,to,cursor:optionalText('cursor',500),limit};
      try{return json(await store.searchLogs(filters));}
      catch(error){if(error instanceof Error&&/cursor|커서|페이지|검색|조회|filter|limit|date/i.test(error.message))throw new ApiError('조회 조건이나 페이지 정보를 확인하세요.','invalid_log_query');throw error;}
    }
    if(request.method==='GET'&&new URL(request.url).searchParams.get('view')==='verification'){
      const params=new URL(request.url).searchParams;
      if(params.has('deploymentId')){
        const target=await store.getDeployment(parse(id,params.get('deploymentId')));
        assert(target,'복원할 배포 버전을 찾을 수 없습니다.','not_found',404);
        const current=await store.getRecord<Workflow>('workflow',target.workflowId);
        assert(current,'현재 워크플로우를 찾을 수 없습니다.','not_found',404);
        const fingerprint=await configurationFingerprint(target.workflow,target.connections);
        return json({evidence:await store.verificationEvidence(target.workflowId,fingerprint),fingerprint,policy:current.releasePolicy??{requireVerification:false,requiredDatasetIds:[]},currentWorkflowUpdatedAt:current.updatedAt});
      }
      const captured=await captureWorkflow(store,parse(id,params.get('workflowId')));
      const fingerprint=await configurationFingerprint(captured.workflow,captured.connections);
      return json({evidence:await store.verificationEvidence(captured.workflow.id,fingerprint),fingerprint});
    }
    const state=await store.state();state.role=role;
    if(request.method==='GET') return json({state});
    assert(request.method==='POST','지원하지 않는 메서드입니다.','method_not_allowed',405);
    const data=await body(request);
    requireActionRole(role,String(data.action));
    let extra:Record<string,unknown>={};
    let deploymentAuditHandled=false;
    const actor=request.headers.get('oai-authenticated-user-id')||'service-admin';
    const deploymentCommand=data.action==='publish'||data.action==='rollback_deployment';
    const requestKey=data.idempotencyKey??request.headers.get('idempotency-key')??undefined;
    if(deploymentCommand&&data.idempotencyKey!==undefined&&request.headers.has('idempotency-key'))assert(data.idempotencyKey===request.headers.get('idempotency-key'),'배포 요청 번호가 서로 다릅니다.');
    const commandRequest=deploymentCommand&&requestKey!==undefined?await deploymentRequest(actor,parse(z.string().regex(/^[a-zA-Z0-9_-]{8,120}$/),requestKey),data):undefined;
    if(commandRequest){
      const deployment=await store.deploymentForRequest(commandRequest);
      if(deployment)return json({state,deployment,replayed:true});
    }
    const deploymentAudit=()=>({id:crypto.randomUUID(),actor,action:String(data.action),target:auditTarget(data),createdAt:new Date().toISOString(),detail:'완료'});
    const evaluated=await handleEvaluationAction(data,state,store,env);
    if(evaluated)extra=evaluated;
    else switch(data.action) {
      case 'save_workflow': {
        const workflow=parse(workflowSchema,data.workflow);
        if(role!=='admin')assert(JSON.stringify(workflow.releasePolicy)===JSON.stringify(state.workflows.find(item=>item.id===workflow.id)?.releasePolicy),'배포 검증 기준은 관리자만 변경할 수 있습니다.','forbidden',403);
        assert(!workflow.cloneSource||workflow.cloneSource.workflowId!==workflow.id,'복제 원본은 현재 워크플로우와 달라야 합니다.');
        enforceLimit(state.workflows,workflow.id,30,'워크플로우');
        const ruleIds=[...workflow.pre,...workflow.post].flatMap(g=>g.rules.map(r=>r.id));
        assert(new Set(ruleIds).size===ruleIds.length,'워크플로우 안의 검사 ID는 서로 달라야 합니다.');
        const groupIds=[...workflow.pre,...workflow.post].map(g=>g.id);
        assert(new Set(groupIds).size===groupIds.length,'단계 ID는 고유해야 합니다.');
        const graphIssues=validateWorkflowGraph(workflow);
        assert(!graphIssues.length,graphIssues.join('; '));
        const controlIds=workflow.graph?[...workflow.graph.pre.nodes,...workflow.graph.post.nodes].map(node=>`control:${node.id}`):[];
        const nodeIds=new Set(['input','main','output',...groupIds.map(groupId=>`group:${groupId}`),...ruleIds.map(ruleId=>`rule:${ruleId}`),...controlIds]);
        assert(!workflow.layout||Object.keys(workflow.layout.positions).every(nodeId=>nodeIds.has(nodeId)),'노드 위치에 현재 워크플로우에 없는 노드가 포함되어 있습니다.');
        const visibleNodeIds=new Set(['input','main','output',...[...workflow.pre,...workflow.post].map(group=>group.rules.length===1?`rule:${group.rules[0].id}`:`group:${group.id}`),...controlIds]);
        assert(!workflow.layout?.pinnedKeys||workflow.layout.pinnedKeys.every(key=>visibleNodeIds.has(key)),'위치를 고정할 노드를 현재 화면에서 다시 선택하세요.');
        const zoneIds=new Set<string>();const assignedNodes=new Set<string>();
        for(const zone of workflow.layout?.zones??[]){
          assert(!zoneIds.has(zone.id),'구역 ID는 서로 달라야 합니다.');zoneIds.add(zone.id);
          assert(new Set(zone.nodeKeys).size===zone.nodeKeys.length,'같은 구역에 노드를 중복해서 포함할 수 없습니다.');
          for(const nodeId of zone.nodeKeys){
            assert(visibleNodeIds.has(nodeId),'구역에는 현재 캔버스에 표시되는 노드만 포함할 수 있습니다.');
            assert(!assignedNodes.has(nodeId),'한 노드는 하나의 구역에만 포함할 수 있습니다.');assignedNodes.add(nodeId);
          }
          const membershipIssue=zoneMembershipIssue(workflow,zone.nodeKeys);
          assert(!membershipIssue,`${zone.name}: ${membershipIssue}`,'noncontiguous_zone');
        }
        const expectedUpdatedAt=data.expectedUpdatedAt===undefined?(role==='admin'?undefined:state.workflows.find(item=>item.id===workflow.id)?.updatedAt??null):data.expectedUpdatedAt===null?null:parse(z.string().max(100),data.expectedUpdatedAt);
        assert(await store.saveRecordChecked('workflow',workflow.id,{...workflow,updatedAt:new Date().toISOString()},expectedUpdatedAt),'다른 화면에서 워크플로우를 변경했습니다. 현재 편집 내용은 유지되며, 서버 저장본과 비교한 뒤 다시 저장하세요.','stale_workflow_save',409);
        break;
      }
      case 'delete_workflow': {
        const workflowId=parse(id,data.id);
        assert(state.workflows.some(w=>w.id===workflowId),'워크플로우를 찾을 수 없습니다.','not_found',404);
        assert(!state.deployments.some(d=>d.workflowId===workflowId),'배포 이력이 있는 워크플로우는 삭제할 수 없습니다.','deployed_workflow');
        await store.remove('workflow',workflowId);
        break;
      }
      case 'save_connection': {
        const connection=parse(connectionSchema,data.connection);
        enforceLimit(state.connections,connection.id,30,'모델 서버');
        const issues=validateConnection(connection);
        assert(!issues.length,issues.join('; '));
        await store.saveConnection(connection);
        break;
      }
      case 'delete_connection': {
        const connectionId=parse(id,data.id);
        const inUse=state.workflows.some(w=>w.mainConnectionId===connectionId||[...w.pre,...w.post].some(g=>g.rules.some(r=>r.config.connectionId===connectionId)));
        assert(!inUse,'초안 워크플로우에서 사용 중인 모델 서버입니다. 해당 워크플로우의 서버 연결을 바꾼 뒤 삭제하세요.');
        await store.deleteConnection(connectionId);
        break;
      }
      case 'test_connection': {
        const connection=state.connections.find(c=>c.id===data.id);
        assert(connection,'모델 서버 설정을 찾을 수 없습니다.','not_found',404);
        extra.test=await testConnection(connection,state.ingress,env);
        break;
      }
      case 'save_ingress': {
        const ingress=parse(ingressSchema,data.ingress);
        const issues=validateIngress(ingress);
        assert(!issues.length,issues.join('; '));
        await store.saveIngress(ingress);
        break;
      }
      case 'save_dataset': {
        const dataset=parse(datasetSchema,data.dataset);
        enforceLimit(state.datasets,dataset.id,30,'데이터셋');
        assert(new Set(dataset.rows.map(r=>r.id)).size===dataset.rows.length,'데이터셋 행 ID는 고유해야 합니다.');
        const expectedUpdatedAt=data.expectedUpdatedAt===undefined?undefined:data.expectedUpdatedAt===null?null:parse(z.string().max(100),data.expectedUpdatedAt);
        assert(await store.saveRecordChecked('dataset',dataset.id,{...dataset,updatedAt:new Date().toISOString()},expectedUpdatedAt),'다른 화면에서 데이터셋을 변경했습니다. 현재 편집 내용은 유지되며, 서버 저장본과 비교한 뒤 다시 저장하세요.','stale_dataset_save',409);
        break;
      }
      case 'create_mapped_dataset': {
        const sourceDatasetId=parse(id,data.sourceDatasetId);
        const sourceRecord=await store.getRecordWithVersion<Dataset>('dataset',sourceDatasetId);
        assert(sourceRecord,'원본 데이터셋을 찾을 수 없습니다.','not_found',404);
        const source=sourceRecord.value;
        const workflowId=parse(id,data.workflowId);
        const target=parse(z.enum(['draft','deployed']),data.target);
        const checks=[{namespace:'dataset',id:sourceDatasetId,revision:sourceRecord.revision}];
        let latestDeployment:Deployment|undefined;
        let workflow:Workflow,connections:Connection[];
        if(target==='deployed'){
          latestDeployment=state.deployments.filter(item=>item.workflowId===workflowId).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.version-a.version)[0];
          assert(latestDeployment,'먼저 워크플로우를 배포하세요.','not_deployed');
          workflow=latestDeployment.workflow;connections=latestDeployment.connections;
        }else{
          const captured=await store.getRecordWithVersion<Workflow>('workflow',workflowId);
          assert(captured,'워크플로우를 찾을 수 없습니다.','not_found',404);workflow=captured.value;
          checks.push({namespace:'workflow',id:workflowId,revision:captured.revision});connections=[];
          for(const connection of referencedConnections(workflow,state.connections)){
            const current=await store.getRecordWithVersion<Connection>('connection',connection.id);
            if(current){connections.push(current.value);checks.push({namespace:'connection',id:connection.id,revision:current.revision});}
          }
        }
        const expectedDatasetFingerprint=parse(z.string().regex(/^[a-f0-9]{64}$/),data.expectedDatasetFingerprint);
        const expectedWorkflowFingerprint=parse(z.string().regex(/^[a-f0-9]{64}$/),data.expectedWorkflowFingerprint);
        assert(await datasetFingerprint(source)===expectedDatasetFingerprint,'원본 데이터셋이 변경되었습니다. 검사 연결을 다시 확인하세요.','stale_dataset_mapping',409);
        assert(await configurationFingerprint(workflow,connections)===expectedWorkflowFingerprint,'검토 중 워크플로우가 변경되었습니다. 검사 연결을 다시 확인하세요.','stale_dataset_mapping',409);
        assert(data.mappings&&typeof data.mappings==='object'&&!Array.isArray(data.mappings)&&Object.keys(data.mappings).length<=100&&Object.keys(data.mappings).every(key=>!['__proto__','constructor','prototype'].includes(key)),'연결할 예상 검사 목록을 확인하세요.');
        const mappings=parse(z.record(lineageId,lineageId),data.mappings);
        let mapped;
        try {mapped=applyDatasetRuleMappings(source,workflow,mappings);}catch(error){throw new ApiError(error instanceof Error?error.message:'예상 검사 연결을 확인하세요.','invalid_dataset_mapping');}
        const name=parse(text(120),data.name);
        const dataset=parse(datasetSchema,{...mapped,id:crypto.randomUUID(),name,rows:mapped.rows.map(row=>({...row,id:crypto.randomUUID()})),updatedAt:new Date().toISOString()});
        assert(state.datasets.length<30,'데이터셋은 최대 30개까지 저장할 수 있습니다.','dataset_limit',409);
        const inserted=await store.insertMappedDataset(dataset,checks,30,latestDeployment?{workflowId,id:latestDeployment.id}:undefined);
        if(!inserted){const current=await store.state();assert(current.datasets.length<30,'데이터셋은 최대 30개까지 저장할 수 있습니다.','dataset_limit',409);throw new ApiError('검토 중 데이터셋이나 워크플로우가 변경되었습니다. 검사 연결을 다시 확인하세요.','stale_dataset_mapping',409);}
        extra.dataset=dataset;
        break;
      }
      case 'delete_dataset': {
        const datasetId=parse(id,data.id);
        assert(state.datasets.some(dataset=>dataset.id===datasetId),'데이터셋을 찾을 수 없습니다.','not_found',404);
        // Evaluation runs retain their captured dataset name, input and expected verdict.
        await store.remove('dataset',datasetId);
        break;
      }
      case 'playground': {
        const messages:ChatMessage[]=data.messages!==undefined?parse(conversationSchema,data.messages):[{role:'user',content:parse(z.string().min(1).max(16000).refine(value=>value.trim().length>0,'입력에는 공백 외의 문자가 필요합니다.'),data.input)}];
        const generationOptions=parse(generationOptionsSchema,data.generationOptions??{});
        const mockResponse=data.mockResponse===undefined?undefined:parse(z.string().max(40000),data.mockResponse);
        const options={...generationOptions,...(mockResponse!==undefined?{mockResponse}:{})};
        assert(data.progress===undefined||typeof data.progress==='boolean','진행 상태 표시 설정을 확인하세요.');
        const selected=workflowFrom(state,data.workflowId,data.target);
        const workflow=structuredClone(selected.workflow),connections=structuredClone(selected.connections),version=selected.version;
        const ingress=structuredClone(state.ingress);
        const issues=validateWorkflow(workflow,connections);
        assert(!issues.length,issues.join('; '));
        const fingerprint=await configurationFingerprint(workflow,connections);
        if(data.expectedFingerprint!==undefined)assert(parse(z.string().regex(/^[a-f0-9]{64}$/),data.expectedFingerprint)===fingerprint,'실행할 워크플로우가 변경되었습니다. 현재 설정을 다시 확인하세요.','stale_workflow_execution',409);
        if(data.progress===true){
          let closed=false;
          const encoder=new TextEncoder();
          const stream=new ReadableStream<Uint8Array>({
            start(controller){
              const send=(value:unknown)=>{if(closed)return;try{controller.enqueue(encoder.encode(JSON.stringify(value)+'\n'));}catch{closed=true;}};
              // The response remains attached until this execution ends. This
              // is management progress, never uninspected model-token streaming.
              void (async()=>{
                try{
                  const result=await executeWorkflow(workflow,connections,ingress,env,messages,{...options,signal:request.signal,onProgress:event=>send({type:'progress',event})});
                  await store.log(recordLog(result,'playground',workflow,version));
                  await store.audit({id:crypto.randomUUID(),actor:request.headers.get('oai-authenticated-user-id')||'service-admin',action:'playground',target:workflow.id,createdAt:new Date().toISOString(),detail:'완료'});
                  send({type:'result',result,fingerprint});
                }catch{
                  send({type:'error',error:{message:'검증을 완료하거나 결과를 저장하지 못했습니다. 서버 연결과 실행 기록을 확인하세요.',code:'execution_failed'}});
                }finally{
                  if(!closed){closed=true;try{controller.close();}catch{/* The reader may already have left. */}}
                }
              })();
            },
            cancel(){closed=true;},
          });
          return new Response(stream,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store, no-transform','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'}});
        }
        const result=await executeWorkflow(workflow,connections,ingress,env,messages,{...options,signal:request.signal});
        await store.log(recordLog(result,'playground',workflow,version));
        extra.result=result;extra.fingerprint=fingerprint;
        break;
      }
      case 'publish': {
        const workflowId=parse(id,data.workflowId);
        const captured=await captureWorkflow(store,workflowId);
        const {workflow,connections,checks}=captured;
        const issues=validateWorkflow(workflow,connections);assert(!issues.length,issues.join('; '));
        const fingerprint=await configurationFingerprint(workflow,connections);
        if(data.expectedFingerprint!==undefined)assert(parse(z.string().regex(/^[a-f0-9]{64}$/),data.expectedFingerprint)===fingerprint,'검토한 초안이 변경되었습니다. 변경 내용을 다시 확인하세요.','stale_workflow',409);
        const note=data.note===undefined?undefined:parse(z.string().max(1000),data.note);
        const {checks:evidenceChecks,...evidence}=await verifyDeploymentEvidence(store,workflow,fingerprint,data);
        checks.push(...evidenceChecks);
        assert(!state.deployments.some(d=>d.alias===workflow.alias&&d.workflowId!==workflow.id),'다른 워크플로우에서 사용 중인 API 모델 이름입니다.');
        const ingress=await store.getRecordWithVersion<IngressPolicy>('meta','ingress');
        assert(ingress,'접근 정책을 찾을 수 없습니다.','not_found',404);
        validateSnapshotConnections(connections,{...state,ingress:ingress.value},env);
        checks.push({namespace:'meta',id:'ingress',revision:ingress.revision});
        const snapshot:Omit<Deployment,'version'>=JSON.parse(JSON.stringify({id:crypto.randomUUID(),workflowId:workflow.id,alias:workflow.alias,createdAt:new Date().toISOString(),workflow,connections,fingerprint,...(note!==undefined?{note}:{}),...evidence}));
        const deployment=await store.deployChecked(snapshot,checks,{audit:deploymentAudit(),request:commandRequest});
        deploymentAuditHandled=true;
        assert(deployment,'검토 중 설정이 변경되었거나 모델 이름이 사용되었습니다. 다시 검토하세요.','stale_workflow',409);
        extra.deployment=deployment;break;
      }
      case 'rollback_deployment': {
        const target=await store.getDeployment(parse(id,data.deploymentId));
        assert(target,'복원할 배포 버전을 찾을 수 없습니다.','not_found',404);
        const issues=validateWorkflow(target.workflow,target.connections);
        assert(!issues.length,issues.join('; '),'invalid_rollback_configuration');
        const note=data.note===undefined?'':parse(z.string().max(1000),data.note);
        const ingress=await store.getRecordWithVersion<IngressPolicy>('meta','ingress');
        assert(ingress,'접근 정책을 찾을 수 없습니다.','not_found',404);
        validateSnapshotConnections(target.connections,{...state,ingress:ingress.value},env);
        const current=await store.getRecordWithVersion<Workflow>('workflow',target.workflowId);
        assert(current,'현재 워크플로우를 찾을 수 없습니다.','not_found',404);
        const fingerprint=await configurationFingerprint(target.workflow,target.connections);
        if(data.expectedFingerprint!==undefined)assert(parse(z.string().regex(/^[a-f0-9]{64}$/),data.expectedFingerprint)===fingerprint,'복원할 실행 설정이 변경되었습니다. 다시 확인하세요.','stale_workflow',409);
        if(data.expectedUpdatedAt!==undefined)assert(parse(z.string().max(100),data.expectedUpdatedAt)===current.value.updatedAt,'배포 기준이 변경되었습니다. 복원 내용을 다시 확인하세요.','stale_workflow',409);
        const checks=[{namespace:'workflow',id:current.value.id,revision:current.revision},{namespace:'meta',id:'ingress',revision:ingress.revision}];
        const policy=current.value.releasePolicy;
        const requiresEvidence=policy?.requireVerification||Boolean(policy?.requiredDatasetIds.length)||data.verificationRunIds!==undefined||data.verificationRunId!==undefined||data.acknowledgeUnverified!==undefined;
        const {checks:evidenceChecks,...verified}=requiresEvidence?await verifyDeploymentEvidence(store,{...target.workflow,releasePolicy:policy},fingerprint,data):{checks:[]};
        checks.push(...evidenceChecks);
        const provenance=requiresEvidence?verified:{...(target.verificationRunId?{verificationRunId:target.verificationRunId}:{}),...(target.verificationRunIds?{verificationRunIds:target.verificationRunIds}:{}),...(target.verificationSummaries?{verificationSummaries:target.verificationSummaries}:{}),...(target.verificationRunId||target.verificationRunIds?.length||target.verificationSummaries?.length?{verificationProvenance:'historical' as const}:{}),...(target.unverifiedReason?{unverifiedReason:target.unverifiedReason}:{})};
        const deployment=await store.deployChecked({id:crypto.randomUUID(),workflowId:target.workflowId,alias:target.alias,createdAt:new Date().toISOString(),workflow:{...target.workflow,releasePolicy:policy},connections:target.connections,fingerprint,note,rollbackOf:target.id,...provenance,engineVersion:ENGINE_VERSION},checks,{audit:deploymentAudit(),request:commandRequest});
        deploymentAuditHandled=true;
        assert(deployment,'API 모델 이름이 다른 워크플로우에서 사용 중입니다.','alias_conflict',409);
        extra.deployment=deployment;break;
      }
      case 'create_key': {
        assert(state.keys.length<100,'API 키는 최대 100개까지 발급할 수 있습니다.');
        const policy=parsePolicy(data.policy);
        const created=await store.createKey(parse(text(80),data.name),policy);
        extra.key=created.key;
        break;
      }
      case 'update_key_policy': {
        const keyId=parse(id,data.id);assert(state.keys.some(k=>k.id===keyId),'API 키를 찾을 수 없습니다.','not_found',404);
        await store.updateKeyPolicy(keyId,parsePolicy(data.policy));break;
      }
      case 'save_retention': {
        const retention=parse(retentionSchema,data.retention);await store.put('meta','retention',retention);await store.pruneRetention(retention);break;
      }
      case 'diagnose_connection': {
        const captured=await captureConnectionCheck(store,parse(id,data.id));
        const diagnostic=await diagnoseConnection(captured.connection,captured.ingress,env);
        assert(await store.putIfUnchanged('diagnostic',captured.connection.id,diagnostic,captured.checks),'검사 중 모델 서버 설정이나 접근 정책이 변경되었습니다. 다시 검사하세요.','connection_changed',409);
        extra.diagnostic=diagnostic;break;
      }
      case 'collect_connection_metrics': {
        const captured=await captureConnectionCheck(store,parse(id,data.id));
        const metrics=await collectConnectionMetrics(captured.connection,captured.ingress,env);
        assert(await store.putIfUnchanged('model_metric',captured.connection.id,metrics,captured.checks),'수집 중 모델 서버 설정이나 접근 정책이 변경되었습니다. 다시 수집하세요.','connection_changed',409);
        extra.modelMetric=metrics;break;
      }
      case 'revoke_key': {
        const keyId=parse(id,data.id);
        assert(state.keys.some(k=>k.id===keyId),'API 키를 찾을 수 없습니다.','not_found',404);
        await store.revokeKey(keyId);
        break;
      }
      default: throw new ApiError('지원하지 않는 관리 작업입니다.');
    }
    if(!deploymentAuditHandled)await store.audit({id:crypto.randomUUID(),actor,action:String(data.action),target:auditTarget(data),createdAt:new Date().toISOString(),detail:'완료'});
    const next=await store.state();next.role=role;
    return json({state:next,...extra});
  } catch(error) { return replyError(error); }
}

async function gatewayContext(request:Request,env:AegisEnv) {
  const store=new AegisStore(env);const authorization=request.headers.get('authorization')||'';
  assert(/^Bearer ag_[a-f0-9]{64}$/.test(authorization),'Authorization 헤더에 유효한 Bearer API 키를 넣어 주세요.','invalid_api_key',401);
  const key=await store.authenticate(authorization.slice(7));assert(key,'API 키가 유효하지 않거나 폐기되었습니다.','invalid_api_key',401);
  if(key.policy?.expiresAt)assert(Number.isFinite(Date.parse(key.policy.expiresAt))&&Date.parse(key.policy.expiresAt)>Date.now(),'API 키가 만료되었습니다.','key_expired',401);
  const ingress=await store.getRecord<IngressPolicy>('meta','ingress');
  assert(ingress,'접근 정책을 불러오지 못했습니다. 관리자에게 서버 상태 확인을 요청하세요.','ingress_unavailable',503);
  if(ingress.enabled)assert(ipv4Allowed(request.headers.get('cf-connecting-ip')||'',ingress.allowedCidrs),'호출한 IP가 API 허용 목록에 없습니다.','ip_not_allowed',403);
  return {store,ingress,key};
}
async function reserve(store:AegisStore,key:GatewayKey,tokens:number,leaseMs:number) {
  const reserved=await store.reserveQuota(key,tokens,leaseMs);
  if('denied' in reserved) {
    const messages={rpm_limit:'분당 요청 한도에 도달했습니다.',tpm_limit:'분당 토큰 한도 안에서 이 요청의 최대 토큰을 예약할 수 없습니다. max_tokens를 줄이거나 잠시 뒤 다시 호출하세요.',concurrency_limit:'동시에 처리할 수 있는 요청 수에 도달했습니다.'};
    throw new ApiError(messages[reserved.denied],reserved.denied,429);
  }
  return reserved.reservation;
}
export async function handleModels(request:Request,env:AegisEnv):Promise<Response> {
  let active:{store:AegisStore;reservation:QuotaReservation}|undefined;
  try {
    assert(request.method==='GET','지원하지 않는 메서드입니다.','method_not_allowed',405);
    const {store,ingress,key}=await gatewayContext(request,env);
    active={store,reservation:await reserve(store,key,0,30_000)};
    const models=await store.activeModelSummaries(key.policy?.allowedModels);
    return json({object:'list',data:models.map(d=>({id:d.alias,object:'model',created:Math.floor(Date.parse(d.createdAt)/1000),owned_by:'aegis-gateway'}))});
  } catch(error){return replyError(error,true);}
  finally{if(active)await active.store.releaseQuota(active.reservation,0);}
}
export async function handleCompletions(request:Request,env:AegisEnv):Promise<Response> {
  let active:{store:AegisStore;reservation:QuotaReservation}|undefined;let actualTokens:number|undefined;
  try {
    assert(request.method==='POST','지원하지 않는 메서드입니다.','method_not_allowed',405);
    const {store,ingress,key}=await gatewayContext(request,env);const data=await body(request);
    assert(data.stream===undefined||data.stream===false,'응답 검사를 마친 뒤 결과를 반환하므로 stream:true는 지원하지 않습니다.','streaming_not_supported');
    const allowed=new Set(['model','messages','temperature','max_tokens','top_p','stream']);const unsupported=Object.keys(data).filter(field=>!allowed.has(field));
    assert(!unsupported.length,`지원하지 않는 필드: ${unsupported.join(', ')}`,'unsupported_parameter');
    const alias=parse(text(80),data.model);
    assert(!key.policy?.allowedModels||key.policy.allowedModels.includes(alias),'이 API 키에 허용되지 않은 모델입니다.','model_not_allowed',403);
    const messages=parse(z.array(messageSchema).min(1).max(32),data.messages) as ChatMessage[];
    assert(messages.some(m=>m.role==='user'),'user 메시지가 하나 이상 필요합니다.');
    assert(messages.reduce((sum,m)=>sum+m.content.length,0)<=40000,'메시지 전체 길이는 40,000자 이하로 보내세요.');
    const options={...(data.temperature!==undefined?{temperature:parse(z.number().min(0).max(2),data.temperature)}:{}),...(data.max_tokens!==undefined?{max_tokens:parse(z.number().int().min(1).max(8192),data.max_tokens)}:{}),...(data.top_p!==undefined?{top_p:parse(z.number().min(0).max(1),data.top_p)}:{})};
    const deployment=await store.activeDeployment(alias);assert(deployment,'배포된 API 모델 이름을 찾을 수 없습니다.','model_not_found',404);
    const tokenReservation=responseTokenReservation(deployment.workflow,messages,options.max_tokens??1024);
    active={store,reservation:await reserve(store,key,tokenReservation,executionLeaseDuration(deployment.workflow,deployment.connections))};
    const result=await executeWorkflow(deployment.workflow,deployment.connections,ingress,env,messages,{...options,signal:request.signal});
    actualTokens=result.usage?.total_tokens??(result.stage==='pre'?0:active.reservation.reservedTokens);
    await store.log(recordLog(result,'gateway',deployment.workflow,`v${deployment.version}`,key.id,deployment.id));
    const headers={'X-Aegis-Request-Id':result.id,'X-Aegis-Workflow-Version':String(deployment.version)};
    if(result.status!=='allow')return json({error:{message:result.status==='block'?`${result.stage==='pre'?'요청 검사':'응답 검사'}에서 차단되었습니다.`:'모델 호출이나 검사 실행에 실패했습니다.',type:result.status==='block'?'policy_violation':'server_error',param:null,code:result.status==='block'?'guardrail_blocked':'guardrail_error',request_id:result.id,stage:result.stage}},result.status==='block'?403:502,headers);
    return json({id:`chatcmpl-${result.id}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:alias,choices:[{index:0,message:{role:'assistant',content:result.output},finish_reason:result.finishReason??'stop'}],...(result.usage?{usage:result.usage}:{})},200,headers);
  } catch(error){return replyError(error,true);}
  finally{if(active)await active.store.releaseQuota(active.reservation,actualTokens??active.reservation.reservedTokens);}
}

export { heartbeatEvaluationWorker, releaseEvaluationWorker, processEvaluationQueue, handleEvaluationWorker } from './evaluation-worker';
