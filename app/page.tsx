'use client';

import { randomUuid } from '@/lib/client-id';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ShieldCheck, Workflow as WorkflowIcon, Server, Network, FlaskConical, Database, Radio, ScrollText, ChevronDown, ChevronRight, Plus, ArrowUpRight, X, Save, CircleHelp, ArrowRight, ArrowLeft, Loader2, Settings2, CheckCircle2, AlertCircle, RotateCcw, LayoutDashboard } from 'lucide-react';
import type { AppState, Workflow, ConsoleAction, Deployment, EvalRun, ExecutionResult, RequestLog, Connection } from '@/lib/aegis-types';
import { initialState } from '@/lib/aegis-seed';
import { cloneWorkflowContent } from '@/lib/workflow-clone';
import { Tag, PageHeading, type ConsoleReply, type Act } from '@/components/console-ui';
import { ConnectionsPage, AccessPage, GatewayPage, DeploymentReview, OperationsPage } from '@/components/management-pages';
import { EvaluationPage, LogsPage, type EvaluationDatasetRequest } from '@/components/evaluation-page';
import '@/components/management.css';
import '@/components/evaluation.css';
import { WorkflowList, getWorkflowStatus } from '@/components/workflow-list';
import '@/components/workflow-list.css';
import '@/components/calm-theme.css';
import { WorkflowCanvas } from '@/components/workflow-canvas';
import type { WorkflowRunnerExecution } from '@/components/workflow-runner';
import type { WorkflowSelection } from '@/lib/workflow-layout';
import { WorkflowEditor, type WorkflowEditorSession } from '@/components/workflow-editor';
import type { EvaluationNavigationContext } from '@/lib/evaluation-navigation';
import { evaluationContextForRun } from '@/lib/evaluation-navigation';
import { DeploymentRollback } from '@/components/deployment-rollback';
import { readWorkflowRecovery, saveWorkflowRecovery, removeWorkflowRecovery, repairWorkflowRecovery, recoveryBaselineChanged, workflowRecoveryEqual, type WorkflowRecovery, type RecoveryStorage } from '@/lib/workflow-recovery';
import { validateWorkflowGraph } from '@/lib/workflow-graph';
import { validateWorkflow } from '@/lib/aegis-engine';
import { executionConfiguration, workflowChanges } from '@/lib/workflow-review';
import '@/components/workflow-workspace.css';
import '@/components/workflow-editor.css';
import { DatasetsPage, type DatasetsPageProps } from '@/components/datasets-page';
import { ConsoleAuthControl } from '@/components/console-auth';
import '@/components/datasets.css';
import {useConsoleHistory} from '@/components/use-console-history';
import {CONSOLE_CONNECTION_EVENT} from '@/lib/console-auth';
import {compactConsoleRoute,type ConsoleRoute,type ConsolePage} from '@/lib/console-navigation';
import {emptyLogFilters,type LogSearchFilters} from '@/lib/log-search';
import type {DashboardFilters,DashboardRow,DashboardWidget} from '@/lib/dashboard-types';
import {resolveDashboardDrilldown} from '@/lib/dashboard-workspace';
import '@/components/console-navigation.css';

const PoliciesPage = lazy(() => import('@/components/policies-page').then(module => ({ default: module.PoliciesPage })));
const DashboardPage = lazy(() => import('@/components/dashboard-page').then(module => ({ default: module.DashboardPage })));

const navItems:{id:string;label:string;icon:LucideIcon;section?:string}[] = [
  {id:'dashboard',label:'대시보드',icon:LayoutDashboard,section:'운영 현황'},
  {id:'logs',label:'요청 기록',icon:ScrollText},
  {id:'operations',label:'운영 관리',icon:Settings2},
  {id:'workflows',label:'워크플로우',icon:WorkflowIcon,section:'서비스 설정'},
  {id:'policies',label:'정책 관리',icon:ShieldCheck},
  {id:'connections',label:'모델 서버',icon:Server},
  {id:'access',label:'접근 설정',icon:Network},
  {id:'datasets',label:'검증 데이터셋',icon:Database,section:'검증과 배포'},
  {id:'evaluation',label:'검증 실행',icon:FlaskConical},
  {id:'gateway',label:'API 배포',icon:Radio},
];
const uid = (p:string)=>`${p}-${randomUuid().slice(0,8)}`;
type WorkingDraft = { draft:Workflow; base:Workflow; dirty:boolean };
function recoveryStorage(): RecoveryStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

export default function AegisConsole(){
  const [state,setState]=useState<AppState>(()=>({...initialState(),workflows:[],connections:[],datasets:[]}));
  const [nav,setNavState]=useState('workflows');
  const navRef=useRef(nav);navRef.current=nav;
  const [visited,setVisited]=useState(()=>new Set(['workflows']));
  const [accessConnectionId,setAccessConnectionId]=useState('');
  const [diagnosticRequest,setDiagnosticRequest]=useState('');
  const [logsInitial,setLogsInitial]=useState<{filters:Partial<LogSearchFilters>;requestId?:string;revision:number}>({filters:{},revision:0});
  const logFilters=useRef<LogSearchFilters>({...emptyLogFilters});
  const [gatewaySelection,setGatewaySelection]=useState<{workflowId?:string;deploymentId?:string}>({});
  const routeMetadata=useRef<Partial<Record<string,Partial<ConsoleRoute>>>>({});
  const [policiesVisited,setPoliciesVisited]=useState(false);
  const [policyOpenRequest,setPolicyOpenRequest]=useState<{policyId:string;version:number;requestId:string}>();
  const [workflowMode,setWorkflowMode]=useState<'list'|'editor'>('list');
  const workflowModeRef=useRef(workflowMode);workflowModeRef.current=workflowMode;
  const navigationIntent=useRef(0);
  const [evaluationWorkflowId,setEvaluationWorkflowId]=useState('');
  const [evaluationDatasetId,setEvaluationDatasetId]=useState('');
  const [evaluationTab,setEvaluationTab]=useState<'single'|'batch'|'compare'>('single');
  const [draft,setDraft]=useState<Workflow>(()=>initialState().workflows[0]);
  const [dirty,setDirty]=useState(false);
  const [saveConflict,setSaveConflict]=useState('');
  const [workflowSaveErrors,setWorkflowSaveErrors]=useState<Record<string,string>>({});
  const [logInspection,setLogInspection]=useState<{log:RequestLog;workflow:Workflow;connections:Connection[]}>();
  const [logSelection,setLogSelection]=useState<WorkflowSelection>();
  const logDialog=useRef<HTMLElement>(null);
  useEffect(()=>{if(!logInspection)return;const previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined;logDialog.current?.focus();const keys=(event:KeyboardEvent)=>{if(event.key==='Escape')setLogInspection(undefined);if(event.key==='Tab'){const nodes=[...(logDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')??[])];const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===logDialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};document.addEventListener('keydown',keys);return()=>{document.removeEventListener('keydown',keys);previous?.focus();};},[logInspection?.log.id]);
  const [toast,setToast]=useState('');
  const [loading,setLoading]=useState(true);
  const [consoleLoaded,setConsoleLoaded]=useState(false);
  const [connected,setConnected]=useState(false);
  const [connectionCheckedAt,setConnectionCheckedAt]=useState<number>();
  const [connectionChecking,setConnectionChecking]=useState(false);
  const [busy,setBusy]=useState(false);
  const [modal,setModal]=useState<'new'|'settings'|'help'|null>(null);
  const [newName,setNewName]=useState('');
  const [reviewWorkflowId,setReviewWorkflowId]=useState('');
  const [rollbackDeployment,setRollbackDeployment]=useState<Deployment>();
  const [reviewSuspended,setReviewSuspended]=useState(false);
  const [reviewReturnNav,setReviewReturnNav]=useState('workflows');
  const [reviewResumeBusy,setReviewResumeBusy]=useState(false);
  const [reviewResumeError,setReviewResumeError]=useState('');
  const [execution,setExecution]=useState<{workflowId:string}&WorkflowRunnerExecution>();
  const [selectedRuleId,setSelectedRuleId]=useState('');
  const [evaluationInput,setEvaluationInput]=useState('');
  const [datasetEditorRequest,setDatasetEditorRequest]=useState<(EvaluationDatasetRequest&{requestId:string})>();
  const [switchDatasetDraft,setSwitchDatasetDraft]=useState<DatasetsPageProps['switchDraft']>();
  const drafts = useRef(new Map<string,WorkingDraft>());
  const editorSessions = useRef(new Map<string,WorkflowEditorSession>());
  const [editorRevision,setEditorRevision]=useState(0);
  const activeDraftId = useRef(draft.id);
  const evaluationContext = useRef<EvaluationNavigationContext | undefined>(undefined);
  const [evaluationInitialContext,setEvaluationInitialContext]=useState<EvaluationNavigationContext>();
  const [evaluationVisit,setEvaluationVisit]=useState(0);
  const [returnedFromEditor,setReturnedFromEditor]=useState(false);
  const [evaluationOrigin,setEvaluationOrigin]=useState<{workflowId:string;context:EvaluationNavigationContext;label:string}>();
  const [recoveries,setRecoveries]=useState<WorkflowRecovery[]>([]);
  const [recoveryError,setRecoveryError]=useState('');
  const [recoveryNeedsRepair,setRecoveryNeedsRepair]=useState(false);
  const [repairRecoveryOpen,setRepairRecoveryOpen]=useState(false);
  const [pendingRecovery,setPendingRecovery]=useState<{record:WorkflowRecovery;ruleId:string}>();
  const recoveryDialog=useRef<HTMLElement>(null);
  const retainEditorSession = useCallback((session:WorkflowEditorSession)=>{editorSessions.current.set(session.workflowId,session);if(navRef.current==='workflows'&&workflowModeRef.current==='editor'){const selection=session.selection,nodeId=selection.kind==='policy-node'?`policy:${selection.id}`:'id' in selection?selection.id:selection.kind;syncRoute({page:'workflows',workflowId:session.workflowId,nodeId});}},[]);
  const retainEvaluationContext = useCallback((context:EvaluationNavigationContext)=>{ evaluationContext.current=context; if(navRef.current==='evaluation') syncRoute({page:'evaluation',workflowId:context.workflowId,datasetId:context.datasetId,runId:context.runId,tab:context.tab,target:context.target,deploymentId:context.deploymentId}); },[]);
  const persistWorkingDraft = (entry:WorkingDraft):boolean => {
    if(state.role==='viewer')return false;
    const storage=recoveryStorage();
    if(!storage){setRecoveryError('브라우저에 임시 저장하지 못했습니다. 현재 화면의 내용은 유지됩니다. 새로고침 전에 저장을 다시 시도하세요.');return false;}
    const result=entry.dirty ? saveWorkflowRecovery(storage,entry.draft,entry.base) : removeWorkflowRecovery(storage,entry.draft.id);
    if(result.ok){setRecoveries(result.records);const allProtected=[...drafts.current.values()].filter(item=>item.dirty).every(item=>result.records.some(record=>record.workflowId===item.draft.id&&workflowRecoveryEqual(record.draft,item.draft)));if(allProtected)setRecoveryError('');return true;}
    setRecoveryNeedsRepair(!readWorkflowRecovery(storage).ok);setRecoveryError(result.error||'임시 저장하지 못했습니다. 현재 화면의 내용은 유지됩니다.');return false;
  };
  const holdCurrentDraft = () => {
    const entry=drafts.current.get(activeDraftId.current);
    if(entry?.dirty)persistWorkingDraft(entry);
  };
  const notify=(message:string)=>{setToast(message);};
  const syncRoute=(route:ConsoleRoute)=>{routeMetadata.current[route.page]=compactConsoleRoute(route);routeHistory.visit(route,true);};
  const interruptNavigation=()=>{++navigationIntent.current;routeHistory.interrupt();};
  const setNav=(next:string,metadata?:Partial<ConsoleRoute>,restoring=false)=>{if(!restoring)interruptNavigation();setVisited(current=>new Set([...current,next]));setNavState(next);routeHistory.visit({page:next as ConsolePage,...(metadata??routeMetadata.current[next])});};
  const checkConnection=async()=>{setConnectionChecking(true);try{const response=await fetch('/api/console',{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error('서버 연결을 확인하지 못했습니다.');const reply=await response.json() as ConsoleReply;setState(reply.state);if(!consoleLoaded&&reply.state.role!=='viewer'){const storage=recoveryStorage();if(storage){const recovered=readWorkflowRecovery(storage);setRecoveries(recovered.records);setRecoveryNeedsRepair(!recovered.ok);if(!recovered.ok)setRecoveryError(recovered.error||'임시 초안을 읽지 못했습니다.');}}setConsoleLoaded(true);setConnected(true);setConnectionCheckedAt(Date.now());}catch{setConnected(false);setConnectionCheckedAt(Date.now());notify('관리 서버 연결을 확인하지 못했습니다. 입력 내용은 유지됩니다.');}finally{setConnectionChecking(false);}};
  useEffect(()=>{const status=(event:Event)=>{const detail=(event as CustomEvent<{available:boolean;checkedAt:number}>).detail;if(typeof detail?.available==='boolean'){setConnected(detail.available);setConnectionCheckedAt(detail.checkedAt);}};window.addEventListener(CONSOLE_CONNECTION_EVENT,status);return()=>window.removeEventListener(CONSOLE_CONNECTION_EVENT,status);},[]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),4500);return()=>clearTimeout(t)},[toast]);
  useEffect(()=>{fetch('/api/console').then(async r=>{const d=await r.json() as ConsoleReply & {error?:{message:string}};if(!r.ok)throw Error(d.error?.message||'관리 서버에 연결하지 못했습니다.');setState(d.state);setConsoleLoaded(true);setConnected(true);setConnectionCheckedAt(Date.now());if(d.state.workflows[0]){const first=structuredClone(d.state.workflows[0]);setDraft(first);activeDraftId.current=first.id;drafts.current.set(first.id,{draft:first,base:structuredClone(first),dirty:false});}if(d.state.role!=='viewer'){const storage=recoveryStorage();if(storage){const recovered=readWorkflowRecovery(storage);setRecoveries(recovered.records);setRecoveryNeedsRepair(!recovered.ok);if(!recovered.ok)setRecoveryError(recovered.error||'임시 초안을 읽지 못했습니다.');}}}).catch(e=>notify(e.message)).finally(()=>setLoading(false));},[]);
  useEffect(()=>{
    if(state.role==='viewer')return;
    const protect=(event:BeforeUnloadEvent)=>{
      const pending=[...drafts.current.values()].filter(entry=>entry.dirty);
      if(!pending.length)return;
      const storage=recoveryStorage();
      const failed=!storage||pending.some(entry=>!saveWorkflowRecovery(storage,entry.draft,entry.base).ok);
      if(failed){event.preventDefault();event.returnValue='';}
    };
    window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);
  },[state.role]);
  useEffect(()=>{
    if(!pendingRecovery&&!repairRecoveryOpen)return;const previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    const frame=requestAnimationFrame(()=>recoveryDialog.current?.focus());
    const keys=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setPendingRecovery(undefined);setRepairRecoveryOpen(false);}if(event.key==='Tab'){const targets=[...(recoveryDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]')||[])];const first=targets[0],last=targets.at(-1);if(!first)return;if(event.shiftKey&&(document.activeElement===first||document.activeElement===recoveryDialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===recoveryDialog.current)){event.preventDefault();first.focus();}}};
    document.addEventListener('keydown',keys);return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',keys);previous?.focus();};
  },[pendingRecovery?.record.workflowId,repairRecoveryOpen]);
  const act:Act=async(payload:ConsoleAction)=>{setBusy(true);try{const r=await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await r.json() as ConsoleReply & {error?:{message:string;code?:string}};if(!r.ok){if(['stale_dataset_mapping','stale_dataset_preflight','dataset_criteria_review_required','dataset_limit','stale_dataset_save','stale_workflow_save','stale_policy_save'].includes(data.error?.code||'')){try{const latest=await fetch('/api/console');if(latest.ok){const refreshed=await latest.json() as ConsoleReply;if(refreshed.state)setState(refreshed.state);}}catch{/* Keep the current working drafts if the state refresh is unavailable. */}}if(data.error?.code==='stale_workflow_save')setSaveConflict((payload.workflow as Workflow)?.id||'');throw Error(data.error?.message||'작업을 완료하지 못했습니다. 잠시 후 다시 시도하세요.');}if(data.state){setState(data.state);if(payload.action==='save_workflow'){const savedId=(payload.workflow as Workflow)?.id;if(savedId)setWorkflowSaveErrors(current=>({...current,[savedId]:''}));const saved=data.state.workflows.find(item=>item.id===(payload.workflow as Workflow)?.id);const cached=saved&&drafts.current.get(saved.id);if(saved&&cached&&!cached.dirty){const entry={draft:structuredClone(saved),base:structuredClone(saved),dirty:false};drafts.current.set(saved.id,entry);if(activeDraftId.current===saved.id){setDraft(entry.draft);setDirty(false);}}}}return data as ConsoleReply;}catch(e){const message=e instanceof Error?e.message:'요청 오류';if(payload.action==='save_workflow'){const savedId=(payload.workflow as Workflow)?.id;if(savedId)setWorkflowSaveErrors(current=>({...current,[savedId]:message}));}notify(message);return undefined;}finally{setBusy(false);}};
  const edit=(w:Workflow)=>{if(state.role==='viewer')return;const next={...w,updatedAt:new Date().toISOString()};const base=drafts.current.get(w.id)?.base||state.workflows.find(item=>item.id===w.id)||w;const entry={draft:next,base,dirty:!workflowRecoveryEqual(next,base)};drafts.current.set(w.id,entry);activeDraftId.current=w.id;setDraft(next);setDirty(entry.dirty);persistWorkingDraft(entry);};
  const save=async(candidate:Workflow=draft)=>{
    if(state.role==='viewer')return false;
    const snapshot=structuredClone(candidate);const d=await act({action:'save_workflow',workflow:snapshot,expectedUpdatedAt:drafts.current.get(snapshot.id)?.base.updatedAt??''});
    if(d){setSaveConflict('');const server=d.state.workflows.find(item=>item.id===snapshot.id)||snapshot;const current=drafts.current.get(snapshot.id);const unchanged=!current||workflowRecoveryEqual(current.draft,snapshot);const entry={draft:unchanged?structuredClone(server):current.draft,base:structuredClone(server),dirty:!unchanged};drafts.current.set(snapshot.id,entry);persistWorkingDraft(entry);if(activeDraftId.current===snapshot.id){setDraft(entry.draft);setDirty(entry.dirty);}notify('워크플로우 초안을 서버에 저장했습니다.');}return !!d;
  };
  const deploy=async()=>{if(dirty&&!await save())return;setReviewReturnNav('workflows');setRollbackDeployment(undefined);setReviewSuspended(false);setReviewWorkflowId(draft.id);};
  const openEvaluation=(context?:EvaluationNavigationContext,fromEditor=false)=>{holdCurrentDraft();setEvaluationInitialContext(context);setReturnedFromEditor(fromEditor);setEvaluationVisit(value=>value+1);setNav('evaluation',context?{workflowId:context.workflowId,datasetId:context.datasetId,runId:context.runId,tab:context.tab,target:context.target,deploymentId:context.deploymentId}:undefined);};
  const test=async()=>{if(dirty&&!await save())return;setEvaluationWorkflowId(draft.id);setEvaluationDatasetId('');setEvaluationTab('single');setEvaluationInput('');setEvaluationOrigin(undefined);openEvaluation();};
  const backToList=async()=>{interruptNavigation();holdCurrentDraft();if(dirty&&!validateWorkflowGraph(draft).length)await save();setWorkflowMode('list');setSelectedRuleId('');setNav('workflows',{});};
  const navigate=(next:string)=>{interruptNavigation();if(next==='policies')setPoliciesVisited(true);if(next==='workflows'){void backToList();return;}holdCurrentDraft();if(next==='evaluation'){openEvaluation(evaluationContext.current);return;}setNav(next);};
  const showWorkingDraft=(entry:WorkingDraft,ruleId='',restoring=false)=>{drafts.current.set(entry.draft.id,entry);activeDraftId.current=entry.draft.id;setDraft(structuredClone(entry.draft));setDirty(entry.dirty);setSelectedRuleId(ruleId);setWorkflowMode('editor');setNav('workflows',{workflowId:entry.draft.id,nodeId:ruleId},restoring);};
  const selectWorkflow=(id:string,ruleId='',restoring=false)=>{
    if(!restoring)interruptNavigation();holdCurrentDraft();const server=state.workflows.find(item=>item.id===id);if(!server)return;
    const cached=drafts.current.get(id);
    if(cached?.dirty){showWorkingDraft(cached,ruleId,restoring);return;}
    const recovery=state.role==='viewer'?undefined:recoveries.find(item=>item.workflowId===id);
    if(recovery){setPendingRecovery({record:recovery,ruleId});return;}
    if(cached&&!workflowRecoveryEqual(cached.draft,server)){editorSessions.current.delete(id);setEditorRevision(value=>value+1);}
    showWorkingDraft({draft:structuredClone(server),base:structuredClone(server),dirty:false},ruleId,restoring);
  };
  const discardRecovery=(record:WorkflowRecovery)=>{
    const storage=recoveryStorage();if(!storage){setRecoveryError('브라우저 저장소를 사용할 수 없습니다. 임시 초안은 유지됩니다.');return false;}
    const result=removeWorkflowRecovery(storage,record.workflowId);if(!result.ok){setRecoveryError(result.error||'임시 초안을 삭제하지 못했습니다.');return false;}setRecoveries(result.records);setRecoveryError('');return true;
  };
  const repairRecovery=()=>{const storage=recoveryStorage();const result=repairWorkflowRecovery(storage);if(!result.ok){setRecoveryError(result.error||'임시 보관함을 복구하지 못했습니다.');return;}setRecoveries(result.records);setRecoveryNeedsRepair(false);setRecoveryError('');setRepairRecoveryOpen(false);[...drafts.current.values()].filter(entry=>entry.dirty).forEach(entry=>persistWorkingDraft(entry));notify('읽을 수 있는 초안을 유지하고 임시 보관함을 복구했습니다.');};
  const restoreRecovery=(record:WorkflowRecovery,ruleId='')=>{
    if(state.role==='viewer'||loading||!connected)return;const server=state.workflows.find(item=>item.id===record.workflowId);if(!server)return;
    holdCurrentDraft();editorSessions.current.delete(record.workflowId);setEditorRevision(value=>value+1);const entry={draft:structuredClone(record.draft),base:structuredClone(server),dirty:!workflowRecoveryEqual(record.draft,server)};showWorkingDraft(entry,ruleId);persistWorkingDraft(entry);setPendingRecovery(undefined);notify('임시 초안을 복구했습니다. 서버에 적용하려면 저장하세요.');
  };
  const openServerAfterRecovery=(record:WorkflowRecovery,ruleId='')=>{const server=state.workflows.find(item=>item.id===record.workflowId);if(!server||!discardRecovery(record))return;editorSessions.current.delete(record.workflowId);setEditorRevision(value=>value+1);showWorkingDraft({draft:structuredClone(server),base:structuredClone(server),dirty:false},ruleId);setPendingRecovery(undefined);};
  const createWorkflow=async()=>{if(!newName.trim())return;holdCurrentDraft();const w:Workflow={id:uid('wf'),name:newName.trim(),description:'',alias:uid('assistant'),mainConnectionId:state.connections.find(c=>c.role!=='guard')?.id||'',pre:[],post:[],updatedAt:new Date().toISOString()};const d=await act({action:'save_workflow',workflow:w,expectedUpdatedAt:null});if(d){showWorkingDraft({draft:structuredClone(d.state.workflows.find(item=>item.id===w.id)!),base:structuredClone(d.state.workflows.find(item=>item.id===w.id)!),dirty:false});setEvaluationOrigin(undefined);setModal(null);setNewName('');notify('새 워크플로우를 만들었습니다.')}};
  const duplicateWorkflow=async(id:string)=>{
    const original=state.workflows.find(w=>w.id===id);if(!original)return;
    const clone=cloneWorkflowContent(original,uid);clone.id=uid('wf');if(state.role!=='admin')delete clone.releasePolicy;clone.name=`${original.name.slice(0,90)} 복사`;clone.alias=`${original.alias.slice(0,60)}-copy-${randomUuid().slice(0,6)}`;clone.updatedAt=new Date().toISOString();if(state.role!=='admin')delete clone.releasePolicy;
    const d=await act({action:'save_workflow',workflow:clone,expectedUpdatedAt:null});if(d)notify('워크플로우를 복제했습니다. 복제본은 초안으로 저장했습니다.');
  };
  const deleteWorkflow=async(id:string)=>{const d=await act({action:'delete_workflow',id});if(d){drafts.current.delete(id);editorSessions.current.delete(id);const record=recoveries.find(item=>item.workflowId===id);if(record)discardRecovery(record);if(activeDraftId.current===id){const next=d.state.workflows[0]||initialState().workflows[0];activeDraftId.current=next.id;setDraft(next);setDirty(false);}notify('초안 워크플로우를 삭제했습니다.')}};
  const testWorkflow=async(id:string)=>{const cached=drafts.current.get(id);if(cached?.dirty&&!await save(cached.draft))return;setEvaluationWorkflowId(id);setEvaluationDatasetId('');setEvaluationTab('single');setEvaluationInput('');setEvaluationOrigin(undefined);openEvaluation();};
  const evaluateDataset=(id:string,workflowId?:string,target:'draft'|'deployed'='draft')=>{setEvaluationDatasetId(id);setEvaluationTab('batch');setEvaluationOrigin(undefined);if(workflowId){setEvaluationWorkflowId(workflowId);openEvaluation({tab:'batch',workflowId,datasetId:id,target,input:'',lastInput:'',singleFingerprint:'',runId:'',rowId:'',resultFilter:'all',categoryFilter:'all',changedOnly:false,showSnapshot:false,scrollTop:0});}else openEvaluation();};
  const manageEvaluationDataset=(request?:EvaluationDatasetRequest)=>{holdCurrentDraft();setSwitchDatasetDraft(undefined);if(request)setDatasetEditorRequest({...request,requestId:uid('dataset-editor')});setNav('datasets',request?.datasetId?{datasetId:request.datasetId}:undefined);};
  const deployWorkflow=async(id:string)=>{const cached=drafts.current.get(id);if(cached?.dirty&&!await save(cached.draft))return;setReviewReturnNav(nav);setRollbackDeployment(undefined);setReviewSuspended(false);setReviewWorkflowId(id);};
  const openExecution=(workflowId:string,ruleId:string,input:string,result:ExecutionResult,fingerprint?:string,context?:EvaluationNavigationContext)=>{
    if(!state.workflows.some(w=>w.id===workflowId)){notify('현재 초안이 없는 워크플로우입니다. 저장된 실행 내역에서 확인하세요.');return;}
    const origin=context||evaluationContext.current;if(origin){evaluationContext.current=origin;const run=origin.localRun?.id===origin.runId?origin.localRun:state.runs.find(item=>item.id===origin.runId);setEvaluationOrigin({workflowId,context:origin,label:run?`${run.workflowSnapshot?.name||state.workflows.find(item=>item.id===workflowId)?.name||'워크플로우'} 검증 기록`:'단건 검증'});}
    selectWorkflow(workflowId,ruleId);setExecution({workflowId,input,result,fingerprint,...('messages' in result?{messages:(result as import('@/lib/aegis-types').EvalResult).messages}:{}),...('generationOptions' in result?{generationOptions:(result as import('@/lib/aegis-types').EvalResult).generationOptions}:{})});
  };
  const retestExecution=async()=>{
    if(!execution||execution.workflowId!==draft.id)return;
    if(dirty&&!await save())return;
    const response=await act({action:'playground',workflowId:draft.id,input:execution.input,target:'draft',inspect:true,...(execution.messages?{messages:execution.messages}:{}),...(execution.generationOptions?{generationOptions:execution.generationOptions}:{}),...(execution.mockResponse!==undefined?{mockResponse:execution.mockResponse}:{})});
    if(response?.result)setExecution({...execution,result:response.result,fingerprint:response.fingerprint,inspection:(response as ConsoleReply&{inspection?:import('@/lib/aegis-types').ConsoleExecutionInspection}).inspection});
  };
  const prepareWorkflowExecution=async()=>{
    if(state.role==='viewer'||busy||loading||!connected)return false;
    const candidate=structuredClone(draft);
    const issues=validateWorkflow(candidate,state.connections);
    if(issues.length){notify(issues[0]);return false;}
    if(dirty&&!await save(candidate))return false;
    const current=drafts.current.get(candidate.id)?.draft;
    if(activeDraftId.current!==candidate.id||!current||JSON.stringify(executionConfiguration(current))!==JSON.stringify(executionConfiguration(candidate))){
      notify('검증을 준비하는 동안 초안이 변경되었습니다. 현재 입력과 설정을 확인한 뒤 다시 실행하세요.');return false;
    }
    return true;
  };
  const reviewVerificationStarted=(run:EvalRun)=>{setReviewSuspended(true);setReviewResumeError('');setEvaluationOrigin(undefined);openEvaluation(evaluationContextForRun(run));};
  const resumeDeploymentReview=async()=>{
    if(reviewResumeBusy)return;setReviewResumeBusy(true);setReviewResumeError('');
    try{const response=await fetch('/api/console',{cache:'no-store'});if(!response.ok)throw new Error('검증 결과와 현재 초안을 다시 읽지 못했습니다. 검토 내용은 유지됩니다.');const reply=await response.json() as ConsoleReply;if(!reply.state)throw new Error('서버의 현재 상태를 확인하지 못했습니다.');setState(reply.state);holdCurrentDraft();setReviewSuspended(false);setNav(reviewReturnNav);}
    catch(error){setReviewResumeError(error instanceof Error?error.message:'배포 검토로 돌아가지 못했습니다.');}finally{setReviewResumeBusy(false);}
  };
  const closeDeploymentReview=()=>{setReviewWorkflowId('');setRollbackDeployment(undefined);setReviewSuspended(false);setReviewResumeError('');};
  const viewEvaluationRecord=async(runId:string)=>{interruptNavigation();const ticket=navigationIntent.current;try{const response=await fetch(`/api/console?view=evaluations&runId=${encodeURIComponent(runId)}`,{cache:'no-store',signal:AbortSignal.timeout(12000)});const data=await response.json() as {run?:import('@/lib/aegis-types').EvalRun;error?:{message:string}};if(!response.ok||!data.run)throw new Error(data.error?.message||'검증 기록이 없거나 보관 기간이 지났습니다.');if(ticket!==navigationIntent.current)return;const run=data.run;setEvaluationOrigin(undefined);openEvaluation(evaluationContextForRun(run));}catch(error){if(ticket===navigationIntent.current)notify(error instanceof Error?error.message:'검증 기록을 불러오지 못했습니다.');}};
  const viewLog=async(log:RequestLog)=>{interruptNavigation();const ticket=navigationIntent.current;const query=new URLSearchParams({view:'deployment',...(log.deploymentId?{deploymentId:log.deploymentId}:{workflowId:log.workflowId??'',version:log.version.replace(/^v/,'')})});try{const response=await fetch(`/api/console?${query}`,{cache:'no-store'});const data=await response.json() as ConsoleReply&{error?:{message:string}};if(!response.ok||!data.deployment)throw new Error(data.error?.message||'요청 당시 배포 설정을 찾지 못했습니다.');if(ticket!==navigationIntent.current)return;setLogSelection(undefined);setLogInspection({log,workflow:data.deployment.workflow,connections:data.deployment.connections});}catch(error){if(ticket===navigationIntent.current)notify(error instanceof Error?error.message:'배포 설정을 불러오지 못했습니다.');}};
  const copyConflictingDraft=async()=>{const clone=cloneWorkflowContent(draft,uid);clone.id=uid('wf');if(state.role!=='admin')delete clone.releasePolicy;clone.name=`${draft.name.slice(0,90)} 복사`;clone.alias=`${draft.alias.slice(0,60)}-copy-${randomUuid().slice(0,6)}`;const reply=await act({action:'save_workflow',workflow:clone,expectedUpdatedAt:null});if(reply){const server=reply.state.workflows.find(item=>item.id===clone.id)!;setSaveConflict('');showWorkingDraft({draft:structuredClone(server),base:structuredClone(server),dirty:false});notify('내 변경 내용을 복사본에 저장했습니다. 원본의 서버 변경은 유지됩니다.');}};
  const returnToEvaluation=()=>{if(!evaluationOrigin)return;setSelectedRuleId('');openEvaluation(evaluationOrigin.context,true);};
  const evaluateCurrentWorkflow=async()=>{if(!evaluationOrigin)return;if(dirty&&!await save())return;setSelectedRuleId('');openEvaluation({...evaluationOrigin.context,workflowId:draft.id,tab:'batch',target:'draft',runId:'',rowId:'',localRun:undefined,resultFilter:'all',categoryFilter:'all',changedOnly:false,showSnapshot:false,scrollTop:0});};
  const openAccess=(connectionId:string)=>{setAccessConnectionId(connectionId);setNav('access');};
  const backToConnection=()=>{setDiagnosticRequest(accessConnectionId);setNav('connections');};
  const openLogs=(filters:Partial<LogSearchFilters>,requestId?:string)=>{setLogsInitial(current=>({filters,requestId,revision:current.revision+1}));setNav('logs',{...filters,from:filters.fromInstant??filters.from,to:filters.toInstant??filters.to,requestId});};
  const openDashboardDestination=(destination:import('@/components/dashboard-page').DashboardPageNavigation)=>{
    if(destination.page==='logs'){openLogs({workflowId:destination.workflowId??destination.filters.workflowId,source:destination.filters.source==='all'?'':destination.filters.source,status:destination.filters.status,fromInstant:destination.from,toInstant:destination.to});return;}
    if(destination.page==='evaluation'){if(destination.runId){void viewEvaluationRecord(destination.runId);return;}setEvaluationWorkflowId(destination.workflowId??'');setEvaluationTab('batch');openEvaluation({tab:'batch',workflowId:destination.workflowId||state.workflows[0]?.id||'',datasetId:state.datasets[0]?.id||'',target:'draft',input:'',lastInput:'',singleFingerprint:'',runId:'',rowId:'',resultFilter:'all',categoryFilter:'all',changedOnly:false,showSnapshot:false,scrollTop:0});return;}
    setGatewaySelection({workflowId:destination.workflowId,deploymentId:destination.deploymentId});setNav('gateway',{workflowId:destination.workflowId,deploymentId:destination.deploymentId});
  };
  const retainLogFilters=(filters:LogSearchFilters)=>{logFilters.current=filters;if(navRef.current==='logs')syncRoute({page:'logs',workflowId:filters.workflowId,keyId:filters.keyId,from:filters.fromInstant??filters.from,to:filters.toInstant??filters.to,status:filters.status,source:filters.source,requestId:routeHistory.current.current.page==='logs'?routeHistory.current.current.requestId:undefined});};
  const routeHistory=useConsoleHistory(!loading&&consoleLoaded,async(route,isCurrent)=>{
    ++navigationIntent.current;holdCurrentDraft();
    setVisited(current=>new Set([...current,route.page]));
    if(route.page==='policies'){setPoliciesVisited(true);setPolicyOpenRequest(route.policyId?{policyId:route.policyId,version:route.policyVersion??0,requestId:uid('policy-route')}:undefined);}
    if(route.page==='workflows'){
      if(route.workflowId&&state.workflows.some(item=>item.id===route.workflowId))selectWorkflow(route.workflowId,route.nodeId??'',true);
      else{setWorkflowMode('list');setSelectedRuleId('');if(route.workflowId)notify('이 워크플로우를 찾을 수 없습니다. 목록에서 선택하세요.');}
    }
    if(route.page==='datasets')setDatasetEditorRequest(route.datasetId?{datasetId:route.datasetId,workflowId:'',target:'draft',requestId:uid('dataset-route')}:undefined);
    if(route.page==='gateway')setGatewaySelection({workflowId:route.workflowId,deploymentId:route.deploymentId});
    if(route.page==='logs')setLogsInitial(current=>({filters:{...emptyLogFilters,workflowId:route.workflowId??'',keyId:route.keyId??'',from:route.from?.includes('T')?new Date(route.from).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}):route.from??'',to:route.to?.includes('T')?new Date(Date.parse(route.to)-1).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}):route.to??'',...(route.from?.includes('T')?{fromInstant:route.from}:{}),...(route.to?.includes('T')?{toInstant:route.to}:{}),status:route.status??'',source:route.source??''},requestId:route.requestId,revision:current.revision+1}));
    if(route.page==='evaluation'){
      let context=evaluationContext.current;
      if(route.runId){try{const response=await fetch(`/api/console?view=evaluations&runId=${encodeURIComponent(route.runId)}`,{cache:'no-store',signal:AbortSignal.timeout(12000)});const reply=await response.json() as {run?:EvalRun};if(!response.ok||!reply.run)throw Error('검증 기록을 찾지 못했습니다. 보관 기간을 확인하세요.');if(!isCurrent())return;context=evaluationContextForRun(reply.run);}catch(error){if(!isCurrent())return;notify(error instanceof Error?error.message:'검증 기록을 불러오지 못했습니다.');context=undefined;}}
      if(context&&((route.workflowId&&context.workflowId!==route.workflowId)||(route.datasetId&&context.datasetId!==route.datasetId)||(route.target&&context.target!==route.target)))context=undefined;
      context={tab:route.tab??context?.tab??'single',workflowId:route.workflowId??context?.workflowId??state.workflows[0]?.id??'',datasetId:route.datasetId??context?.datasetId??state.datasets[0]?.id??'',target:route.target??context?.target??'draft',input:'',lastInput:'',singleFingerprint:'',runId:'',rowId:'',resultFilter:'all',categoryFilter:'all',changedOnly:false,showSnapshot:false,scrollTop:0,...context,...(route.workflowId?{workflowId:route.workflowId}:{}),...(route.datasetId?{datasetId:route.datasetId}:{}),...(route.tab?{tab:route.tab}:{}),...(route.deploymentId?{deploymentId:route.deploymentId,target:'deployed' as const}:{})};
      if(!isCurrent())return;setEvaluationInitialContext(context);setEvaluationVisit(value=>value+1);
    }
    if(!isCurrent())return;routeMetadata.current[route.page]=route;setNavState(route.page);
  });
  const recoveryCandidates=state.role==='viewer'?[]:recoveries.filter(record=>!drafts.current.get(record.workflowId)?.dirty);
  const workingDrafts=state.role==='viewer'?[]:[...drafts.current.values()].filter(entry=>entry.dirty);
  const pendingServer=pendingRecovery&&state.workflows.find(item=>item.id===pendingRecovery.record.workflowId);
  const pendingConflict=Boolean(pendingRecovery&&pendingServer&&recoveryBaselineChanged(pendingRecovery.record,pendingServer));
  const temporarySaveStatus=recoveryError||(!dirty?'서버에 저장됨':recoveries.some(record=>record.workflowId===draft.id)?'이 브라우저에 임시 저장됨':'이 화면에 변경 내용 보관 중');
  const {status:workflowStatus,deployment:deployed}=getWorkflowStatus(draft,state);
  const props={state,act,notify};

  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="/" aria-label="Aegis 관리 콘솔" onClick={e=>{e.preventDefault();void backToList()}}><div className="brand-symbol"><ShieldCheck size={19}/></div><span className="brand-wordmark">aegis</span></a><nav aria-label="관리 메뉴">{navItems.map(item=><div key={item.id}>{item.section&&<div className="nav-section">{item.section}</div>}<button className={`nav-item ${nav===item.id?'active':''}`} aria-label={item.label} title={item.label} onClick={()=>navigate(item.id)}><item.icon size={18}/><span>{item.label}</span>{item.id==='workflows'&&<small>{state.workflows.length}</small>}{item.id==='datasets'&&<small>{state.datasets.length}</small>}{item.id==='gateway'&&<span className="live-dot"/>}</button></div>)}</nav><div className="sidebar-bottom"><div className="environment"><span className="pulse-dot"/><span>기능 검증용</span></div><button className="help-link" onClick={()=>setModal('help')}><CircleHelp size={17}/> 사용 안내 <ArrowUpRight size={14}/></button><div className="profile"><div className="avatar">AD</div><div><strong>{state.role==='viewer'?'조회자':state.role==='editor'?'정책 작성자':'관리자'}</strong><span>{state.role==='viewer'?'조회 권한':state.role==='editor'?'편집과 검증':'관리 권한'}</span></div><Settings2 size={16}/></div></div></aside><div className="main-shell"><header className="topbar"><div className="breadcrumb"><span>관리 콘솔</span><ChevronRight size={13}/><strong>{navItems.find(n=>n.id===nav)?.label}</strong>{nav==='workflows'&&workflowMode==='editor'&&<><ChevronRight size={13}/><span className="breadcrumb-object">{draft.name}</span></>}</div><div className="topbar-right">{loading?<span><Loader2 className="spin" size={13}/> 관리 서버 연결 중</span>:<span className={connected?'system-ok':'system-error'} title={connectionCheckedAt?`최근 확인 ${new Date(connectionCheckedAt).toLocaleTimeString('ko-KR')}`:undefined}><span className="pulse-dot"/> {connected?'관리 서버 연결됨':'관리 서버 연결 확인 필요'}</span>}{!connected&&!loading&&<button className="btn small" disabled={connectionChecking} onClick={()=>void checkConnection()}>{connectionChecking?'확인 중':'다시 확인'}</button>}<span className="topbar-divider"/><span className="version-label">PoC</span><ConsoleAuthControl busy={busy}/><button className="icon-button" aria-label="도움말" onClick={()=>setModal('help')}><CircleHelp size={18}/></button></div></header><main className={`main-content ${nav==='workflows'&&workflowMode==='editor'?'editor-content':''}`}>
  {recoveryError&&state.role!=='viewer'&&<div className="workspace-storage-error" role="alert"><AlertCircle size={17}/><div><strong>임시 저장 확인 필요</strong><p>{recoveryError}</p></div><button className="btn small" onClick={()=>{const pending=[...drafts.current.values()].filter(entry=>entry.dirty);if(pending.length)pending.forEach(entry=>persistWorkingDraft(entry));else{const storage=recoveryStorage();if(storage){const result=readWorkflowRecovery(storage);if(result.ok){setRecoveries(result.records);setRecoveryError('');}else setRecoveryError(result.error||'임시 초안을 읽지 못했습니다.');setRecoveryNeedsRepair(!result.ok);}}}}>다시 시도</button>{recoveryNeedsRepair&&<button className="btn small" onClick={()=>setRepairRecoveryOpen(true)}>보관함 복구</button>}</div>}
  {!loading&&connected&&recoveryCandidates.length>0&&<details className="workspace-recovery" open={nav==='workflows'&&workflowMode==='list'}><summary><RotateCcw size={15}/><strong>이 브라우저에 임시 초안 {recoveryCandidates.length}개가 있습니다</strong><span>서버 저장본에 적용되지 않은 내용입니다.</span></summary><div className="workspace-recovery-list">{recoveryCandidates.map(record=>{const server=state.workflows.find(item=>item.id===record.workflowId);return <div className="workspace-recovery-row" key={record.workflowId}><div><strong>{record.draft.name||'이름 없는 워크플로우'}</strong><small>{new Date(record.savedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}{!server?' / 서버 초안 없음':recoveryBaselineChanged(record,server)?' / 서버 저장본이 변경됨':''}</small></div><button className="btn small" onClick={()=>{holdCurrentDraft();setPendingRecovery({record,ruleId:''});}}>임시 초안 확인</button></div>;})}</div></details>}
  {workingDrafts.length>0&&(nav!=='workflows'||workflowMode!=='editor')&&<div className="workspace-working"><strong>작업 중인 초안 {workingDrafts.length}개</strong><span>변경 내용은 서버 저장본과 별도로 보관 중입니다.</span>{workingDrafts.map(entry=><button className="btn small" key={entry.draft.id} onClick={()=>selectWorkflow(entry.draft.id)}>{entry.draft.name||'이름 없는 워크플로우'} 계속 편집</button>)}</div>}
  {reviewSuspended&&(reviewWorkflowId||rollbackDeployment)&&<section className="workspace-review-return" aria-label="검토하던 배포로 돌아가기"><div><strong>{rollbackDeployment?`배포 v${rollbackDeployment.version} 복원 검토를 보관하고 있습니다.`:'배포 검토와 메모를 보관하고 있습니다.'}</strong><p>검증 후 현재 설정과 근거를 다시 확인합니다. 진행 중인 검증은 완료한 뒤 배포 근거로 사용할 수 있습니다.</p>{reviewResumeError&&<p role="alert">{reviewResumeError}</p>}</div><button className="btn small" disabled={reviewResumeBusy||busy} onClick={()=>void resumeDeploymentReview()}>{reviewResumeBusy?'현재 근거 확인 중':'배포 검토로 돌아가기'}</button></section>}
  {nav==='workflows'&&workflowMode==='list'&&<WorkflowList state={state} loading={loading} busy={busy} onCreate={()=>setModal('new')} onOpen={id=>{setEvaluationOrigin(undefined);selectWorkflow(id);}} onDuplicate={duplicateWorkflow} onDelete={deleteWorkflow} onArchive={async(workflowId,archived)=>Boolean(await act({action:'set_workflow_archived',workflowId,archived,expectedUpdatedAt:state.lifecycle?.workflows[workflowId]?.updatedAt??null}))} onManageDeployment={workflowId=>{setGatewaySelection({workflowId});setNav('gateway',{workflowId});}} onTest={testWorkflow} onDeploy={deployWorkflow}/>}
  {nav==='workflows'&&workflowMode==='editor'&&<>
    <div className="editor-back-row"><button className="btn text" onClick={backToList}><ArrowLeft size={14}/> 워크플로우 목록</button>{dirty&&<span className="editor-save-hint">미완성 연결도 이 브라우저에 임시 보관합니다.</span>}</div>
    {saveConflict===draft.id&&<section className="workspace-storage-error" role="alert"><AlertCircle size={17}/><div><strong>서버의 초안이 변경되었습니다</strong><p>내 변경은 보관했습니다. 서버 변경을 덮어쓰지 않고 복사본으로 저장할 수 있습니다.</p><details><summary>서버본과 내 변경 비교</summary><ul>{workflowChanges(draft,state.workflows.find(item=>item.id===draft.id),state.connections,state.connections).map((change,index)=><li key={index}>{change.label}: {change.detail}</li>)}</ul></details></div><button className="btn small" disabled={busy} onClick={()=>void copyConflictingDraft()}>내 변경을 복사본에 저장</button><button className="btn small" onClick={()=>{const server=state.workflows.find(item=>item.id===draft.id);if(server){holdCurrentDraft();showWorkingDraft({draft:structuredClone(server),base:structuredClone(server),dirty:false});setSaveConflict('');}}}>서버본 열기</button></section>}
    <section className="workspace-save-state" aria-label="초안 저장과 API 배포 상태"><div><strong>브라우저 초안</strong><span>{dirty?temporarySaveStatus:'서버 저장본과 같음'}</span></div><div><strong>서버 초안</strong><span>{dirty?'현재 편집 내용 저장 전':'저장됨'}</span></div><div><strong>API 적용</strong><span>{deployed?`배포 v${deployed.version}${workflowStatus==='changed'?' (현재 초안과 다름)':''}`:'아직 배포하지 않음'}</span></div><p>실행과 검증, 배포 검토는 변경한 초안을 서버에 저장한 뒤 진행합니다. API 적용은 배포 후 바뀝니다.</p></section>
    {workflowSaveErrors[draft.id]&&saveConflict!==draft.id&&<section className="workspace-storage-error" role="alert"><AlertCircle size={17}/><div><strong>서버에 저장하지 못했습니다</strong><p>{workflowSaveErrors[draft.id]}</p><p>현재 편집 내용은 유지됩니다. 입력과 연결을 확인한 뒤 다시 저장하세요.</p></div><button className="btn small" onClick={()=>setWorkflowSaveErrors(current=>({...current,[draft.id]:''}))}>안내 닫기</button></section>}
    <PageHeading title={draft.name} description="요청과 응답에 적용할 검사 흐름을 설계합니다."/>
    <WorkflowEditor onCreateSwitchDataset={(workflow,nodeId)=>{holdCurrentDraft();setDatasetEditorRequest(undefined);setSwitchDatasetDraft({requestId:uid('switch-dataset'),workflow:structuredClone(workflow),nodeId});setNav('datasets');}} key={`${draft.id}:${editorRevision}`} workflow={draft} connections={state.connections} state={state} act={act} onPrepareExecution={prepareWorkflowExecution} onExecution={next=>setExecution({workflowId:draft.id,...next})} dirty={dirty} busy={busy||loading} readOnly={state.role==='viewer'||Boolean(state.lifecycle?.workflows[draft.id]?.archived)} canDeploy={(!state.role||state.role==='admin')&&!state.lifecycle?.workflows[draft.id]?.archived} execution={execution?.workflowId===draft.id?execution:undefined} initialRuleId={selectedRuleId} onRetest={retestExecution} status={workflowStatus} version={deployed?.version} onChange={edit} onSave={save} onTest={test} onDeploy={deploy} onOpenPolicy={(policyId,version)=>{holdCurrentDraft();setPoliciesVisited(true);setPolicyOpenRequest({policyId,version,requestId:uid('policy-open')});setNav('policies',{policyId,policyVersion:version});}} session={editorSessions.current.get(draft.id)} onSessionChange={retainEditorSession} onTemporarySave={()=>{const entry=drafts.current.get(draft.id);if(entry&&persistWorkingDraft(entry))notify(entry.dirty?'이 브라우저에 임시 저장했습니다.':'서버 저장본과 같은 내용입니다.');}} temporarySaveStatus={temporarySaveStatus} onReturnToEvaluation={evaluationOrigin?.workflowId===draft.id?returnToEvaluation:undefined} onEvaluateCurrentWorkflow={evaluationOrigin?.workflowId===draft.id?evaluateCurrentWorkflow:undefined} evaluationOriginLabel={evaluationOrigin?.workflowId===draft.id?evaluationOrigin.label:undefined} onSettings={()=>setModal('settings')} onConnections={()=>navigate('connections')} notify={notify}/>
  </>}

  {policiesVisited&&<div hidden={nav!=='policies'}><Suspense fallback={<div className="empty"><Loader2 className="spin" size={22}/><span>정책 관리를 불러오고 있습니다.</span></div>}><PoliciesPage {...props} onSelectionChange={(policyId,version)=>{if(navRef.current==='policies')syncRoute({page:'policies',policyId,policyVersion:version});}} loading={loading} busy={busy} initialPolicyId={policyOpenRequest?.policyId} initialPolicyVersion={policyOpenRequest?.version} requestId={policyOpenRequest?.requestId} onOpenWorkflowPolicy={(workflowId,nodeId)=>{setEvaluationOrigin(undefined);selectWorkflow(workflowId,nodeId??'policy');}}/></Suspense></div>}
  {visited.has('dashboard')&&<div hidden={nav!=='dashboard'}><Suspense fallback={<div className="empty"><Loader2 className="spin" size={22}/><span>대시보드를 불러오고 있습니다.</span></div>}><DashboardPage state={state} active={nav==='dashboard'} onNavigate={openDashboardDestination}/></Suspense></div>}
  {visited.has('connections')&&<div hidden={nav!=='connections'}><ConnectionsPage {...props} initialDiagnosticId={diagnosticRequest} onOpenAccess={openAccess} onOpenDashboard={()=>navigate('dashboard')}/></div>}{visited.has('access')&&<div hidden={nav!=='access'}><AccessPage {...props} onBackToConnection={accessConnectionId?backToConnection:undefined}/></div>}{nav==='evaluation'&&<EvaluationPage key={`evaluation-${evaluationVisit}`} {...props} onReviewDeployment={run=>void deployWorkflow(run.workflowId)} initialContext={evaluationInitialContext} onContextChange={retainEvaluationContext} restoredFromEditor={returnedFromEditor} initialWorkflowId={evaluationWorkflowId} initialDatasetId={evaluationDatasetId} initialTab={evaluationTab} initialInput={evaluationInput} onEditRule={openExecution} onViewExecution={(workflowId,input,result,fingerprint,context)=>openExecution(workflowId,'',input,result,fingerprint,context)} onManageDatasets={manageEvaluationDataset}/>}{nav==='gateway'&&<GatewayPage {...props} initialWorkflowId={gatewaySelection.workflowId} initialDeploymentId={gatewaySelection.deploymentId} onSelectionChange={(deploymentId,workflowId)=>{if(navRef.current==='gateway')syncRoute({page:'gateway',deploymentId,workflowId});}} onViewEvaluation={runId=>void viewEvaluationRecord(runId)} onReviewWorkflow={workflowId=>void deployWorkflow(workflowId)} onRollbackDeployment={deployment=>{setReviewReturnNav('gateway');setReviewWorkflowId('');setReviewSuspended(false);setRollbackDeployment(deployment);}}/>}{visited.has('logs')&&<div hidden={nav!=='logs'}><LogsPage {...props} active={nav==='logs'} initialFilters={logsInitial.filters} initialRequestId={logsInitial.requestId} onFiltersChange={retainLogFilters} onViewLog={log=>void viewLog(log)}/></div>}{nav==='operations'&&<OperationsPage {...props}/>}
  <div hidden={nav!=='datasets'}><DatasetsPage {...props} switchDraft={switchDatasetDraft} onContextConsumed={()=>setSwitchDatasetDraft(undefined)} onSelectDataset={datasetId=>{if(navRef.current==='datasets')syncRoute({page:'datasets',datasetId});}} loading={loading} busy={busy} onEvaluate={evaluateDataset} initialDatasetId={datasetEditorRequest?.datasetId} initialRowId={datasetEditorRequest?.rowId} initialWorkflowId={datasetEditorRequest?.workflowId} initialTarget={datasetEditorRequest?.target} requestId={datasetEditorRequest?.requestId} reproduction={datasetEditorRequest?.reproduction}/></div>
  <footer className="app-footer"><span>Aegis 관리 콘솔</span></footer>
  </main></div>{reviewWorkflowId&&state.workflows.find(w=>w.id===reviewWorkflowId)&&<DeploymentReview workflow={state.workflows.find(w=>w.id===reviewWorkflowId)!} {...props} suspended={reviewSuspended} onVerificationStarted={reviewVerificationStarted} onClose={closeDeploymentReview}/>}{rollbackDeployment&&<DeploymentRollback deployment={rollbackDeployment} {...props} suspended={reviewSuspended} onVerificationStarted={reviewVerificationStarted} onClose={closeDeploymentReview}/>}{toast&&<div className="toast" role="status"><CheckCircle2 size={17}/><span>{toast}</span><button aria-label="알림 닫기" onClick={()=>setToast('')}><X size={14}/></button></div>}{busy&&<div className="busy-indicator"><Loader2 className="spin" size={14}/> 처리 중</div>}
  {modal&&<div className="modal-backdrop" onClick={()=>setModal(null)}><section className={`modal ${modal==='help'?'wide':''}`} role="dialog" aria-modal="true" aria-label={modal==='new'?'새 워크플로우':modal==='help'?'사용 안내':'워크플로우 설정'} onClick={e=>e.stopPropagation()}><div className="modal-header"><h2>{modal==='new'?'새 워크플로우':modal==='help'?'Aegis 사용 안내':'워크플로우 설정'}</h2><button className="icon-button" aria-label="닫기" onClick={()=>setModal(null)}><X size={18}/></button></div>{modal==='new'?<><p>워크플로우 이름을 입력한 뒤 검사 항목을 추가하세요.</p><label className="field">워크플로우 이름<input autoFocus placeholder="예: 사내 문서 검색" maxLength={100} value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&createWorkflow()}/></label><div className="modal-actions"><button className="btn" onClick={()=>setModal(null)}>취소</button><button className="btn primary" disabled={!newName.trim()||busy} onClick={createWorkflow}><Plus size={15}/> 만들기</button></div></>:modal==='settings'?<><label className="field">워크플로우 이름<input disabled={state.role==='viewer'} value={draft.name} onChange={e=>edit({...draft,name:e.target.value})}/></label><label className="field">설명<textarea disabled={state.role==='viewer'} value={draft.description} onChange={e=>edit({...draft,description:e.target.value})}/></label><label className="field">API 모델 이름<input className="mono" disabled={state.role==='viewer'} value={draft.alias} onChange={e=>edit({...draft,alias:e.target.value})}/><small>외부 시스템이 model 값으로 전달할 이름입니다. 예: support-assistant</small></label><div className="modal-actions">{state.role==='viewer'?<button className="btn" onClick={()=>setModal(null)}>닫기</button>:<button className="btn primary" onClick={async()=>{if(await save())setModal(null)}}><Save size={15}/> 저장</button>}</div></>:<><p className="guide-intro">모델 서버 등록부터 외부 API 연결까지 다음 순서로 설정합니다.</p><div className="guide-steps">{[{n:'01',icon:Server,title:'모델 서버 등록',text:'서버 주소와 모델 이름을 등록한 뒤 연결을 확인합니다.'},{n:'02',icon:WorkflowIcon,title:'워크플로우 설정',text:'요청 검사와 응답 검사를 추가하고 차단 조건을 정합니다.'},{n:'03',icon:FlaskConical,title:'검증 실행',text:'데이터셋에 요청과 예상 결과를 넣고 실제 결과와 비교합니다.'},{n:'04',icon:Radio,title:'API 배포',text:'검증한 버전을 배포하고 API 키를 발급해 외부 시스템에서 호출합니다.'}].map(s=><div key={s.n}><span>{s.n}</span><s.icon size={21}/><strong>{s.title}</strong><p>{s.text}</p></div>)}</div><div className="guide-note"><ShieldCheck size={19}/><p>예제 모드는 정해진 응답과 표현 검사를 사용합니다. 실제 모델을 검증하려면 모델 서버를 연결하세요. 사내망 전용 모델 서버를 사용하려면 API 서버를 해당 서버에 접근할 수 있는 네트워크에 설치하거나 인증된 HTTPS 연결 경로를 마련하세요.</p></div><div className="modal-actions"><button className="btn primary" onClick={()=>setModal(null)}>확인 <ArrowRight size={15}/></button></div></>}</section></div>}
  {logInspection&&<div className="modal-backdrop" onClick={()=>setLogInspection(undefined)}><section className="modal wide log-flow-modal" ref={logDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="요청 당시 배포 흐름" onClick={event=>event.stopPropagation()}><div className="modal-header"><h2>{logInspection.workflow.name} / {logInspection.log.version}</h2><button className="icon-button" aria-label="요청 흐름 닫기" onClick={()=>setLogInspection(undefined)}><X size={18}/></button></div><p>요청 ID {logInspection.log.id}</p><p>요청 당시의 배포 설정과 기록된 검사 경로입니다. 요청 원문과 생성 응답은 운영 기록에 저장하지 않습니다.</p><WorkflowCanvas workflow={logInspection.workflow} connections={logInspection.connections} execution={{...logInspection.log,stage:['pre','post','main','complete'].includes(logInspection.log.stage)?logInspection.log.stage as ExecutionResult['stage']:'complete',output:'',traces:logInspection.log.traces??[]}} selection={logSelection} onSelect={setLogSelection} disabled={true} readOnly={true} stale={false} onLayout={()=>{}} onAdd={()=>{}} onRetry={()=>{}}/><div className="log-flow-actions"><button className="btn small" disabled={state.role==='viewer'} onClick={()=>{setDatasetEditorRequest({datasetId:'',rowId:'',workflowId:logInspection.workflow.id,target:'deployed',requestId:uid('incident'),reproduction:{requestId:logInspection.log.id,workflowName:logInspection.workflow.name,version:logInspection.log.version}});setLogInspection(undefined);setNav('datasets');}}>재현 사례 등록</button></div><p>재현할 입력을 정리해 검증 사례로 등록할 수 있습니다. 원문은 자동으로 복사하지 않습니다.</p></section></div>}
  {repairRecoveryOpen&&state.role!=='viewer'&&<div className="workspace-dialog-backdrop" onClick={()=>setRepairRecoveryOpen(false)}><section className="workspace-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-repair-title" ref={recoveryDialog} tabIndex={-1} onClick={event=>event.stopPropagation()}><div className="workspace-recovery-heading"><h2 id="workspace-repair-title">임시 보관함을 복구할까요?</h2><button className="icon-button" aria-label="보관함 복구 닫기" onClick={()=>setRepairRecoveryOpen(false)}><X size={17}/></button></div><p>읽을 수 있는 임시 초안 {recoveries.length}개와 현재 화면의 작업 내용은 유지합니다. 형식이 손상되어 읽을 수 없는 보관 내용은 삭제됩니다.</p><p>서버 저장본과 배포 버전에는 영향을 주지 않습니다.</p><div className="workspace-recovery-actions"><button className="btn" onClick={()=>setRepairRecoveryOpen(false)}>취소</button><button className="btn primary" onClick={repairRecovery}>보관함 복구</button></div></section></div>}
  {pendingRecovery&&state.role!=='viewer'&&<div className="workspace-dialog-backdrop" onClick={()=>setPendingRecovery(undefined)}><section className="workspace-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-recovery-title" ref={recoveryDialog} tabIndex={-1} onClick={event=>event.stopPropagation()}><div className="workspace-recovery-heading"><h2 id="workspace-recovery-title">임시 초안을 확인하세요</h2><button className="icon-button" aria-label="임시 초안 확인 닫기" onClick={()=>setPendingRecovery(undefined)}><X size={17}/></button></div><p><strong>{pendingRecovery.record.draft.name||'이름 없는 워크플로우'}</strong>의 변경 내용이 이 브라우저에 보관되어 있습니다. 복구해도 서버 저장본과 배포 버전은 바로 바뀌지 않습니다.</p>{pendingConflict&&<div className="workspace-recovery-conflict"><AlertCircle size={16}/><p>임시 보관 이후 서버 초안이 변경되었습니다. 아래 차이를 확인한 뒤 사용할 초안을 선택하세요.</p></div>}{pendingServer?<><ul className="workspace-recovery-diff">{workflowChanges(pendingRecovery.record.draft,pendingServer,state.connections,state.connections).slice(0,8).map((change,index)=><li key={index}><strong>{change.label}</strong><span>{change.detail}</span></li>)}</ul>{!workflowChanges(pendingRecovery.record.draft,pendingServer,state.connections,state.connections).length&&<p className="workspace-recovery-note">실행 설정이 같아도 노드 위치나 표시 영역이 다를 수 있습니다.</p>}</>:<p className="workspace-recovery-conflict">현재 계정에서 서버 초안을 찾을 수 없습니다. 이 임시 초안을 복구하거나 실행할 수 없습니다.</p>}<div className="workspace-recovery-actions"><button className="btn" onClick={()=>setPendingRecovery(undefined)}>취소</button><button className="btn" disabled={busy} onClick={()=>{if(pendingServer)openServerAfterRecovery(pendingRecovery.record,pendingRecovery.ruleId);else if(discardRecovery(pendingRecovery.record))setPendingRecovery(undefined);}}>{pendingServer?'임시 초안 버리고 서버 초안 열기':'임시 초안 삭제'}</button>{pendingServer&&<button className="btn primary" disabled={busy||loading} onClick={()=>restoreRecovery(pendingRecovery.record,pendingRecovery.ruleId)}><RotateCcw size={14}/>복구하여 계속</button>}</div></section></div>}
  </div>
}
