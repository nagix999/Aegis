'use client';

import { randomUuid } from '@/lib/client-id';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Copy, Database, Download, Loader2, Plus, Save, Search, Trash2, Upload, X } from 'lucide-react';
import type { Dataset, DatasetRow, PolicyPredicate, Workflow } from '@/lib/aegis-types';
import { datasetErrors, datasetToCsv, datasetToJson, parseDatasetFile, parseDatasetRequestSettings } from '@/lib/dataset-io';
import { Empty, PageHeading, Tag, timeLabel, type PageProps } from './console-ui';
import { DatasetPreflightPanel } from './dataset-preflight';
import { PolicyFieldAssertions } from './policy-field-assertions';
import { assertionDraftErrors, fieldAssertionErrors, type AssertionDrafts } from '@/lib/output-expectations';
import { PolicyCheckSelect } from './policy-check-select';
import { expectedPolicyCheck, listWorkflowPolicyChecks } from '@/lib/workflow-policy-checks';
import { policyOutputSchema } from '@/lib/policy-routing';
import { applyDatasetBulkPatch, datasetSchemaImpacts, switchDatasetTemplates, type DatasetBulkPatch } from '@/lib/dataset-authoring';
import './dataset-authoring.css';

export type DatasetsPageProps = PageProps & {
  loading: boolean; busy: boolean;
  onEvaluate: (datasetId: string, workflowId?: string, target?: 'draft'|'deployed') => void;
  initialDatasetId?: string; initialRowId?: string; initialWorkflowId?: string;
  initialTarget?: 'draft'|'deployed'; requestId?: string; onContextConsumed?: () => void;
  onSelectDataset?: (datasetId: string | undefined) => void;
  reproduction?: {requestId:string;workflowName:string;version:string};
  switchDraft?: {requestId:string;workflow:Workflow;nodeId:string};
};
type EditorRequest = {datasetId?:string;rowId?:string;workflowId?:string;target?:'draft'|'deployed';reproduction?:DatasetsPageProps['reproduction'];switchDraft?:DatasetsPageProps['switchDraft']};
const newId = (prefix: string) => `${prefix}-${randomUuid()}`;
const row = (): DatasetRow => ({ id: newId('row'), input: '', expected: 'allow' });
const signature = (dataset: Dataset) => JSON.stringify({ name: dataset.name, description: dataset.description, rows: dataset.rows });
const authoringSignature=(dataset:Dataset,fields:Record<string,AssertionDrafts>,requests:Record<string,RequestDraft>,unconfirmed:string[])=>JSON.stringify({dataset:signature(dataset),fields,requests,unconfirmed});
type RequestDraft = {messages:string;options:string};
const requestDraft = (value: DatasetRow): RequestDraft => ({messages:value.messages ? JSON.stringify(value.messages,null,2) : '',options:value.generationOptions ? JSON.stringify(value.generationOptions,null,2) : ''});
const stageNames = { pre: '요청 검사', main: '응답 생성', post: '응답 검사', complete: '검사 완료' };
const categoryOf = (value: DatasetRow) => value.category?.trim() || '';
const matchesCategory = (value: DatasetRow, filter: string) => filter === 'all' || categoryOf(value) === filter.slice(9);
function categoryCounts(rows: DatasetRow[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of rows) { const category = categoryOf(value); counts.set(category, (counts.get(category) || 0) + 1); }
  return [...counts].sort(([a], [b]) => a ? b ? a.localeCompare(b, 'ko') : -1 : 1);
}

export function DatasetsPage({ state, act, notify, loading, busy, onEvaluate, initialDatasetId, initialRowId, initialWorkflowId, initialTarget, requestId, onContextConsumed, onSelectDataset, reproduction, switchDraft }: DatasetsPageProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');
  const [category, setCategory] = useState('all');
  const [rowCategory, setRowCategory] = useState('all');
  const [rowQuery, setRowQuery] = useState('');
  const [rowNumber, setRowNumber] = useState('');
  const [selectedRowId, setSelectedRowId] = useState('');
  const [saveError, setSaveError] = useState('');
  const [checkedRows,setCheckedRows]=useState<string[]>([]);
  const [bulkOpen,setBulkOpen]=useState(false);
  const [bulkExpected,setBulkExpected]=useState<DatasetRow['expected']|''>('');
  const [bulkStage,setBulkStage]=useState<NonNullable<DatasetRow['expectedStage']>|'keep'|'clear'>('keep');
  const [bulkRoute,setBulkRoute]=useState<NonNullable<DatasetRow['expectedRoute']>|'keep'|'clear'>('keep');
  const [bulkCategory,setBulkCategory]=useState('');
  const [bulkCategoryEnabled,setBulkCategoryEnabled]=useState(false);
  const [bulkFieldsEnabled,setBulkFieldsEnabled]=useState(false);
  const [bulkPolicyNodeId,setBulkPolicyNodeId]=useState<string>();
  const [bulkFields,setBulkFields]=useState<PolicyPredicate[]>([]);
  const [bulkDrafts,setBulkDrafts]=useState<AssertionDrafts>({});
  const [undoEdit,setUndoEdit]=useState<{before:Dataset;after:string;drafts:Record<string,AssertionDrafts>;unconfirmed:string[]}>();
  const [unconfirmedRows,setUnconfirmedRows]=useState<string[]>([]);
  const [authoringWorkflow,setAuthoringWorkflow]=useState<Workflow>();
  const [templateNotice,setTemplateNotice]=useState('');
  const [importOpen,setImportOpen]=useState(false);
  const [importSource,setImportSource]=useState('');
  const [importFormat,setImportFormat]=useState<'json'|'csv'>('json');
  const [importPreview,setImportPreview]=useState<Pick<Dataset,'name'|'description'|'rows'>>();
  const [importError,setImportError]=useState('');
  const [customRuleRows, setCustomRuleRows] = useState<string[]>([]);
  const [editing, setEditing] = useState<Dataset>();
  const [baseline, setBaseline] = useState('');
  const [baselineUpdatedAt,setBaselineUpdatedAt]=useState<string|null>(null);
  const [requestDrafts,setRequestDrafts]=useState<Record<string,RequestDraft>>({});
  const [fieldDrafts,setFieldDrafts]=useState<Record<string,AssertionDrafts>>({});
  const [requestTouched,setRequestTouched]=useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [deleting, setDeleting] = useState<Dataset>();
  const [localAction, setLocalAction] = useState('');
  const [workflowId,setWorkflowId]=useState('');
  const [target,setTarget]=useState<'draft'|'deployed'>('draft');
  const [pendingRequest,setPendingRequest]=useState<EditorRequest>();
  const [pendingMappedId,setPendingMappedId]=useState('');
  const [rowFocus,setRowFocus]=useState<{rowId:string;request:number}>();
  const fileInput = useRef<HTMLInputElement>(null);
  const rowsRef=useRef<HTMLDivElement>(null);
  const discardDialog=useRef<HTMLElement>(null);
  const authoringDialog=useRef<HTMLElement>(null);
  const consumedRequest=useRef<string|undefined>(undefined);
  const dirty = Boolean(editing && (signature(editing) !== baseline || requestTouched));
  const locked = busy || Boolean(localAction);
  const readOnly = state.role === 'viewer';
  const writeLocked = locked || readOnly;
  const atLimit = state.datasets.length >= 30;
  const requestErrors=editing?.rows.flatMap((value,index)=>{const draft=requestDrafts[value.id];if(!draft)return [];try{parseDatasetRequestSettings(draft.messages,draft.options);return [];}catch(error){return [`${index+1}번 항목: ${error instanceof Error?error.message:'대화 입력을 확인하세요.'}`];}})||[];
  const serverDataset=editing&&state.datasets.find(value=>value.id===editing.id);
  const conflict=Boolean(editing&&baselineUpdatedAt!==null&&(!serverDataset||(serverDataset.updatedAt||'')!==baselineUpdatedAt));
  const categories = useMemo(() => categoryCounts(state.datasets.flatMap(dataset => dataset.rows)), [state.datasets]);
  const editorCategories = editing ? categoryCounts(editing.rows) : [];
  const visibleRows = editing?.rows.map((value, index) => ({ value, index })).filter(({ value, index }) => matchesCategory(value, rowCategory) && (!rowQuery.trim() || `${index + 1} ${value.input} ${value.category || ''} ${value.note || ''} ${JSON.stringify(value.messages || [])}`.toLocaleLowerCase().includes(rowQuery.trim().toLocaleLowerCase()))) || [];
  const selectedRow = visibleRows.find(({value}) => value.id === selectedRowId) || visibleRows[0];
  const selectedPosition = selectedRow ? visibleRows.findIndex(({value}) => value.id === selectedRow.value.id) : -1;
  const deployment=useMemo(()=>state.deployments.filter(item=>item.workflowId===workflowId).sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)||b.version-a.version)[0],[state.deployments,workflowId]);
  const selectedWorkflow=target==='deployed'?deployment?.workflow:authoringWorkflow?.id===workflowId?authoringWorkflow:state.workflows.find(workflow=>workflow.id===workflowId);
  const policyScope=(ownerId?:string)=>selectedWorkflow?expectedPolicyCheck(selectedWorkflow,ownerId):undefined;
  const rowSchema=(value:DatasetRow)=>{const scope=policyScope(value.expectedPolicyNodeId);return scope?policyOutputSchema(scope.routing.policy):undefined;};
  const bulkScope=policyScope(bulkPolicyNodeId),selectedSchema=bulkScope?policyOutputSchema(bulkScope.routing.policy):undefined;
  const schemaImpacts=editing?editing.rows.flatMap((value,index)=>datasetSchemaImpacts([value],rowSchema(value)).map(impact=>({...impact,index}))):[];
  const errors = editing ? [...datasetErrors(editing),...requestErrors,...editing.rows.filter(value=>unconfirmedRows.includes(value.id)).map(value=>`${editing.rows.indexOf(value)+1}번 항목의 최종 예상 결과를 직접 선택하세요.`),...editing.rows.flatMap((value,index)=>assertionDraftErrors(value.expectedPolicyFields??[],fieldDrafts[value.id]??{},rowSchema(value)).map(error=>`${index+1}번 항목: ${error}`))] : [];
  const workflowConnections=target==='deployed'?deployment?.connections||[]:state.connections;
  const ruleGroups = useMemo(() => (selectedWorkflow?[selectedWorkflow]:[]).flatMap(workflow => (['pre', 'post'] as const).map(stage => ({
    key: `${workflow.id}-${stage}`, label: `${workflow.name} / ${stageNames[stage]}`, stage,
    rules: workflow[stage].flatMap(group => group.rules.map(rule => ({ id: rule.id, name: rule.name, groupName: group.name, enabled:rule.enabled }))),
  }))).filter(group => group.rules.length), [selectedWorkflow]);
  const ruleIds = useMemo(() => new Set(ruleGroups.flatMap(group => group.rules.map(rule => rule.id))), [ruleGroups]);
  const items = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return state.datasets.filter(dataset => (category === 'all' || dataset.rows.some(value => matchesCategory(value, category))) && (!needle || `${dataset.name} ${dataset.description} ${dataset.rows.map(categoryOf).join(' ')}`.toLocaleLowerCase().includes(needle))).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'ko') : sort === 'cases' ? b.rows.length - a.rows.length || a.name.localeCompare(b.name, 'ko') : (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0) || a.name.localeCompare(b.name, 'ko'));
  }, [state.datasets, query, sort, category]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(()=>{const known=new Set(editing?.rows.map(row=>row.id)??[]);setCheckedRows(current=>{const next=current.filter(id=>known.has(id));return next.length===current.length?current:next;});},[editing?.rows]);
  useEffect(()=>{if(target==='deployed'&&!deployment)setTarget('draft');},[target,deployment]);
  useEffect(()=>{
    if((!initialDatasetId&&!reproduction&&!switchDraft)||loading||locked)return;
    const key=switchDraft?.requestId||requestId||(reproduction?`reproduction:${reproduction.requestId}`:`${initialDatasetId}:${initialRowId||''}:${initialWorkflowId||''}:${initialTarget||'draft'}`);
    if(consumedRequest.current===key)return;
    consumedRequest.current=key;
    if(switchDraft){if(readOnly){notify('조회 권한에서는 검증 초안을 만들 수 없습니다.');return;}if(dirty){setPendingRequest({switchDraft});setDiscard(true);return;}openSwitchDraft(switchDraft);onContextConsumed?.();return;}
    if(reproduction){
      if(readOnly){notify('조회 권한에서는 재현 사례를 등록할 수 없습니다.');onContextConsumed?.();return;}
      if(dirty){setPendingRequest({reproduction});setDiscard(true);return;}
      openReproduction(reproduction);onContextConsumed?.();return;
    }
    const request={datasetId:initialDatasetId,rowId:initialRowId,workflowId:initialWorkflowId,target:initialTarget};
    const dataset=state.datasets.find(item=>item.id===request.datasetId);
    if(!dataset){notify('현재 데이터셋에서 요청한 항목을 찾을 수 없습니다. 저장된 검증 기록은 그대로 확인할 수 있습니다.');onContextConsumed?.();return;}
    if(editing?.id===dataset.id){applyEditorContext(request,editing,false);onContextConsumed?.();return;}
    if(dirty){setPendingRequest(request);setDiscard(true);return;}
    applyEditorContext(request,dataset);onContextConsumed?.();
  },[requestId,initialDatasetId,initialRowId,initialWorkflowId,initialTarget,loading,locked,state.datasets,reproduction,readOnly,switchDraft]);
  useEffect(()=>{
    if(!pendingMappedId)return;const dataset=state.datasets.find(item=>item.id===pendingMappedId);if(!dataset)return;
    if(dirty){setPendingRequest({datasetId:dataset.id,workflowId,target});setPendingMappedId('');setDiscard(true);return;}
    openEditor(dataset);setPendingMappedId('');notify('검사 연결을 바꾼 복사본을 열었습니다.');
  },[pendingMappedId,state.datasets,dirty]);
  useEffect(()=>{
    if(!rowFocus)return;
    const frame=requestAnimationFrame(()=>{
      const element=[...(rowsRef.current?.querySelectorAll<HTMLElement>('[data-dataset-row]')||[])].find(item=>item.dataset.datasetRow===rowFocus.rowId);
      if(!element)return;const details=element.querySelector<HTMLDetailsElement>('details');if(details)details.open=true;
      element.scrollIntoView({block:'center',behavior:'auto'});element.focus({preventScroll:true});
    });return()=>cancelAnimationFrame(frame);
  },[rowFocus,editing?.id]);
  useEffect(()=>{
    if(!discard)return;const previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    const frame=requestAnimationFrame(()=>discardDialog.current?.focus());
    const keys=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();cancelDiscard();}if(event.key==='Tab'){const controls=[...(discardDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')||[])],first=controls[0],last=controls.at(-1);if(!first)return;if(event.shiftKey&&(document.activeElement===first||document.activeElement===discardDialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===discardDialog.current)){event.preventDefault();first.focus();}}};
    document.addEventListener('keydown',keys);return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',keys);previous?.focus();};
  },[discard]);
  useEffect(()=>{
    if(!bulkOpen&&!importOpen)return;
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined,frame=requestAnimationFrame(()=>authoringDialog.current?.focus());
    const keys=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();if(!locked){setBulkOpen(false);setImportOpen(false);}}if(event.key!=='Tab')return;const controls=[...(authoringDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')??[])],first=controls[0],last=controls.at(-1);if(!first)return;if(event.shiftKey&&(document.activeElement===first||document.activeElement===authoringDialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===authoringDialog.current)){event.preventDefault();first.focus();}};
    document.addEventListener('keydown',keys);return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',keys);if(previous?.isConnected)previous.focus();};
  },[bulkOpen,importOpen,locked]);

  function openEditor(dataset: Dataset, fresh = false) {
    const copy = structuredClone(dataset);
    setBaselineUpdatedAt(!fresh&&state.datasets.some(value=>value.id===dataset.id)?dataset.updatedAt||'':null);
    setRequestDrafts(Object.fromEntries(copy.rows.map(value=>[value.id,requestDraft(value)])));setRequestTouched(false);
    setFieldDrafts({});setCheckedRows([]);setBulkOpen(false);setUndoEdit(undefined);setUnconfirmedRows([]);setAuthoringWorkflow(undefined);setTemplateNotice('');
    setEditing(copy); setBaseline(fresh ? '' : signature(copy)); setShowErrors(false); setSaveError(''); setRowCategory('all'); setRowQuery(''); setRowNumber(''); setSelectedRowId(copy.rows[0]?.id || ''); setCustomRuleRows([]);setRowFocus(undefined);
    if (!fresh && state.datasets.some(value => value.id === dataset.id)) onSelectDataset?.(dataset.id);
  }
  function jumpToRow(rowId:string){setRowCategory('all');setRowQuery('');setSelectedRowId(rowId);setRowFocus(current=>({rowId,request:(current?.request||0)+1}));}
  function addRow(){if(!editing || writeLocked || editing.rows.length >= 100)return;const next=row();change({rows:[...editing.rows,next]});jumpToRow(next.id);}
  function jumpByNumber(){if(!editing)return;const index=Number(rowNumber)-1;if(!Number.isInteger(index)||index<0||index>=editing.rows.length){notify(`1부터 ${editing.rows.length}까지 항목 번호를 입력하세요.`);return;}jumpToRow(editing.rows[index].id);}
  function applyEditorContext(request:EditorRequest,dataset:Dataset,replace=true){
    if(replace)openEditor(dataset);
    if(request.workflowId!==undefined)setWorkflowId(request.workflowId);
    if(request.target)setTarget(request.target);
    if(request.rowId){if(dataset.rows.some(item=>item.id===request.rowId))jumpToRow(request.rowId);else notify('요청한 항목이 현재 데이터셋에 없습니다. 해당 데이터셋을 열었습니다.');}
  }
  function create() {
    if(writeLocked||atLimit)return;
    const dataset: Dataset = { id: newId('ds'), name: '', description: '', rows: [row()] };
    openEditor(dataset); // Closing an untouched blank form does not need a discard prompt.
  }
  function openReproduction(context:NonNullable<DatasetsPageProps['reproduction']>){
    if(atLimit){notify('데이터셋은 최대 30개까지 저장할 수 있습니다. 기존 데이터셋을 정리한 뒤 다시 등록하세요.');return;}
    const dataset:Dataset={id:newId('ds'),name:`${context.workflowName} 운영 사례`.slice(0,120),description:'운영 요청을 재현하기 위한 검증 사례입니다. 민감한 내용을 제거한 요청을 직접 입력하세요.',rows:[{...row(),category:'운영 재현',note:`요청 ID: ${context.requestId}\n배포 버전: ${context.version}`.slice(0,1000)}]};
    openEditor(dataset,true);notify('재현할 요청을 직접 입력하고 예상 결과를 확인한 뒤 저장하세요. 운영 기록의 원문은 복사하지 않습니다.');
  }
  function close() { setEditing(undefined); setBaseline('');setBaselineUpdatedAt(null);setRequestDrafts({});setFieldDrafts({});setRequestTouched(false); setShowErrors(false); setSaveError(''); setDiscard(false);setPendingRequest(undefined);setRowFocus(undefined); onSelectDataset?.(undefined); }
  function requestClose() { if (locked) return;setPendingRequest(undefined);if (dirty) setDiscard(true); else close(); }
  function cancelDiscard(){setDiscard(false);setPendingRequest(undefined);onContextConsumed?.();}
  function confirmDiscard(){const request=pendingRequest;setDiscard(false);setPendingRequest(undefined);if(request){if(request.switchDraft){if(!readOnly)openSwitchDraft(request.switchDraft);}else if(request.reproduction){if(!readOnly)openReproduction(request.reproduction);}else{const dataset=state.datasets.find(item=>item.id===request.datasetId);if(dataset)applyEditorContext(request,dataset);else notify('데이터셋을 찾을 수 없습니다. 현재 편집 내용은 유지됩니다.');}onContextConsumed?.();}else close();}
  function openSwitchDraft(context:NonNullable<DatasetsPageProps['switchDraft']>){
    if(atLimit){notify('데이터셋은 최대 30개까지 저장할 수 있습니다.');return;}
    try{const generated=switchDatasetTemplates(context.workflow,context.nodeId),rows=generated.templates.map(template=>({...template,id:newId('row'),expected:'allow' as const}));openEditor({id:newId('ds'),name:`${context.workflow.name} Switch 사례`.slice(0,120),description:'Switch 비교값을 복사한 테스트 초안입니다. 요청과 최종 예상 결과를 직접 작성하세요.',rows},true);setWorkflowId(context.workflow.id);setTarget('draft');setAuthoringWorkflow(structuredClone(context.workflow));setUnconfirmedRows(rows.map(row=>row.id));setTemplateNotice(generated.defaultNotice);}catch(error){notify(error instanceof Error?error.message:'Switch 사례를 만들지 못했습니다.');}
  }
  function change(patch: Partial<Dataset>) { if(writeLocked)return;setEditing(current => current ? { ...current, ...patch } : current); }
  function changeRow(id: string, patch: Partial<DatasetRow>) {
    if(writeLocked)return;
    if(patch.expected)setUnconfirmedRows(current=>current.filter(rowId=>rowId!==id));
    setEditing(current => current ? { ...current, rows: current.rows.map(value => value.id === id ? { ...value, ...patch } : value) } : current);
  }
  function changeRequest(id:string,field:keyof RequestDraft,source:string){
    if(writeLocked||!editing)return;
    const value=editing.rows.find(value=>value.id===id);if(!value)return;
    const next={...(requestDrafts[id]||requestDraft(value)),[field]:source};
    setRequestDrafts(current=>({...current,[id]:next}));setRequestTouched(true);
    try{changeRow(id,parseDatasetRequestSettings(next.messages,next.options));}catch{/* Keep unfinished JSON in memory until the user corrects it. */}
  }
  function duplicateRow(id: string) {
    if (!editing || writeLocked || editing.rows.length >= 100) return;
    const index = editing.rows.findIndex(value => value.id === id);
    if (index < 0) return;
    const rows = [...editing.rows],copyId=newId('row'); rows.splice(index + 1, 0, { ...structuredClone(rows[index]), id:copyId }); change({ rows });
    if(unconfirmedRows.includes(id))setUnconfirmedRows(current=>[...current,copyId]);
    setRequestDrafts(current=>({...current,[copyId]:{...(current[id]||requestDraft(rows[index]))}}));
    setFieldDrafts(current=>({...current,[copyId]:{...(current[id]||{})}}));
    jumpToRow(copyId);
  }
  async function save(evaluate = false, asCopy = false) {
    if (!editing || writeLocked) return;
    if(conflict&&!asCopy){notify('서버 저장본이 변경되었습니다. 서버 내용을 다시 열거나 내 변경을 복사본으로 저장하세요.');return;}
    if(asCopy&&atLimit){notify('데이터셋은 최대 30개까지 저장할 수 있습니다.');return;}
    setShowErrors(true);setSaveError('');
    if (errors.length) { notify(errors[0]); return; }
    setLocalAction('save');
    try {
      const dataset = asCopy ? {...editing,id:newId('ds'),name:`${editing.name.trim().slice(0,110)} 복사`,updatedAt:undefined,rows:editing.rows.map(value=>({...structuredClone(value),id:newId('row')}))} : { ...editing, name: editing.name.trim() };
      const response = await act({ action: 'save_dataset', dataset, expectedUpdatedAt:asCopy?null:baselineUpdatedAt });
      if (!response) { setSaveError('저장하지 못했습니다. 입력 내용은 유지했습니다. 알림을 확인하고 다시 시도하세요.'); return; }
      close(); setQuery(''); setCategory('all'); setSort('updated'); notify('검증 데이터셋을 저장했습니다.');
      if (evaluate) onEvaluate(dataset.id,workflowId||undefined,workflowId?target:undefined);
    } finally { setLocalAction(''); }
  }
  async function duplicate(dataset: Dataset) {
    if (writeLocked || atLimit) return;
    setLocalAction(`duplicate-${dataset.id}`);
    try {
      const copy: Dataset = { id: newId('ds'), name: `${dataset.name.slice(0, 110)} 복사`, description: dataset.description, rows: dataset.rows.map(value => ({ ...structuredClone(value), id: newId('row') })) };
      const response = await act({ action: 'save_dataset', dataset: copy, expectedUpdatedAt:null });
      if (response) notify('검증 데이터셋을 복제했습니다.');
    } finally { setLocalAction(''); }
  }
  async function remove() {
    if (!deleting || writeLocked) return;
    setLocalAction('delete');
    try {
      const response = await act({ action: 'delete_dataset', id: deleting.id });
      if (response) { setDeleting(undefined); notify('데이터셋을 삭제했습니다. 기존 검증 결과는 유지됩니다.'); }
    } finally { setLocalAction(''); }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    if(writeLocked)return;
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (file.size > 2_000_000) { notify('2MB 이하의 파일을 선택하세요.'); return; }
    setLocalAction('import');
    try {
      const imported = parseDatasetFile(await file.text(), file.name);
      setImportPreview(imported);setImportError('');setImportSource('');setImportOpen(true);
    } catch (error) { notify(error instanceof Error ? error.message : '파일을 읽지 못했습니다.'); }
    finally { setLocalAction(''); }
  }
  function download(dataset: Dataset, format: 'json' | 'csv') {
    const source = format === 'json' ? datasetToJson(dataset) : datasetToCsv(dataset);
    const url = URL.createObjectURL(new Blob([source], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `${dataset.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'dataset'}.${format}`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadExample() {
    download({ id: 'example', name: '검증 데이터셋 예제', description: 'input과 expected는 필수입니다. 분류, 판단 근거, 예상 단계와 검사 ID를 함께 기록할 수 있습니다.', rows: [{ id: 'normal', input: '배송 기간을 알려주세요.', expected: 'allow', category: '일반 문의', expectedStage: 'complete', note: '등록한 검사를 통과하고 응답을 반환해야 합니다.' }, { id: 'pii', input: '제 이메일은 user@example.com입니다.', expected: 'block', category: '개인정보', expectedStage: 'pre', note: '요청에 이메일 주소가 포함되어 있습니다. 검증할 워크플로우의 개인정보 검사 ID를 expectedRuleId에 입력하세요.' }] }, 'json');
  }
  function toggleChecked(id:string){setCheckedRows(current=>current.includes(id)?current.filter(value=>value!==id):[...current,id]);}
  function applyBulk(){
    if(!editing||writeLocked)return;
    const ids=checkedRows.filter(id=>editing.rows.some(row=>row.id===id)),patch:DatasetBulkPatch={};
    if(bulkExpected)patch.expected=bulkExpected;
    if(bulkStage!=='keep')patch.expectedStage=bulkStage==='clear'?undefined:bulkStage;
    if(bulkRoute!=='keep')patch.expectedRoute=bulkRoute==='clear'?undefined:bulkRoute;
    if(bulkCategoryEnabled)patch.category=bulkCategory||undefined;
    if(bulkFieldsEnabled){const errors=[...fieldAssertionErrors(bulkFields,selectedSchema),...assertionDraftErrors(bulkFields,bulkDrafts,selectedSchema)];if(errors.length){notify(errors[0]);return;}if(selectedWorkflow&&!bulkScope){notify('출력 조건을 검증할 정책 검사를 선택하세요.');return;}patch.expectedPolicyFields=bulkFields;patch.expectedPolicyNodeId=bulkPolicyNodeId;}
    if(!Object.keys(patch).length){notify('적용할 설정을 선택하세요.');return;}
    try{const next=applyDatasetBulkPatch(editing,ids,patch),nextDrafts=bulkFieldsEnabled?Object.fromEntries(Object.entries(fieldDrafts).filter(([id])=>!ids.includes(id))):fieldDrafts,nextUnconfirmed=bulkExpected?unconfirmedRows.filter(id=>!ids.includes(id)):unconfirmedRows;setUndoEdit({before:structuredClone(editing),after:authoringSignature(next,nextDrafts,requestDrafts,nextUnconfirmed),drafts:structuredClone(fieldDrafts),unconfirmed:[...unconfirmedRows]});setEditing(next);setFieldDrafts(nextDrafts);setUnconfirmedRows(nextUnconfirmed);setBulkOpen(false);notify(`${ids.length}개 항목에 입력한 기준을 적용했습니다. 저장 전 되돌릴 수 있습니다.`);}catch(error){notify(error instanceof Error?error.message:'일괄 설정을 적용하지 못했습니다.');}
  }
  function undoAuthoring(){
    if(!editing||!undoEdit||writeLocked)return;
    if(authoringSignature(editing,fieldDrafts,requestDrafts,unconfirmedRows)!==undoEdit.after){notify('이후 편집 내용이 있어 일괄 작업을 바로 되돌릴 수 없습니다. 현재 입력은 유지했습니다.');return;}
    setEditing(structuredClone(undoEdit.before));setFieldDrafts(structuredClone(undoEdit.drafts));setUnconfirmedRows([...undoEdit.unconfirmed]);setUndoEdit(undefined);notify('마지막 일괄 작업을 되돌렸습니다.');
  }
  function previewPaste(){
    if(writeLocked)return;
    try{setImportPreview(parseDatasetFile(importSource,`붙여넣기.${importFormat}`));setImportError('');}catch(error){setImportPreview(undefined);setImportError(error instanceof Error?error.message:'붙여넣은 내용을 확인하세요.');}
  }
  function applyImport(){
    if(!importPreview||writeLocked)return;
    if(editing){if(editing.rows.length+importPreview.rows.length>100){setImportError('추가 후 항목 수가 100개를 초과합니다.');return;}const next={...editing,rows:[...editing.rows,...structuredClone(importPreview.rows)]};setUndoEdit({before:structuredClone(editing),after:authoringSignature(next,fieldDrafts,requestDrafts,unconfirmedRows),drafts:structuredClone(fieldDrafts),unconfirmed:[...unconfirmedRows]});setEditing(next);}
    else{if(atLimit)return;openEditor({id:newId('ds'),...structuredClone(importPreview)},true);}
    setImportOpen(false);setImportPreview(undefined);setImportSource('');notify('미리 본 항목을 편집 초안에 반영했습니다. 서버 저장은 저장 버튼으로 진행하세요.');
  }

  return <div className="ds-page">
    {!editing ? <>
      <PageHeading eyebrow="검증 데이터셋" title="검증 데이터셋" description="요청 내용, 예상 결과와 판단 근거를 데이터셋별로 관리합니다.">
        <button className="btn" onClick={() => fileInput.current?.click()} disabled={writeLocked || loading || atLimit} title={atLimit ? '데이터셋은 최대 30개까지 저장할 수 있습니다.' : 'CSV 또는 JSON으로 새 데이터셋 가져오기'}><Upload size={14} /> 가져오기</button>
        <button className="btn" disabled={writeLocked||loading||atLimit} onClick={()=>{setImportPreview(undefined);setImportSource('');setImportError('');setImportOpen(true);}}>붙여넣기</button><button className="btn primary" onClick={create} disabled={writeLocked || loading || atLimit}><Plus size={15} /> 새 데이터셋</button>
      </PageHeading>
      <section className="ds-panel" aria-label="검증 데이터셋 목록">
        <div className="ds-toolbar">
          <label className="ds-search"><Search size={16} /><input aria-label="데이터셋 검색" placeholder="이름, 설명, 분류로 검색" value={query} onChange={event => setQuery(event.target.value)} disabled={loading} />{query && <button aria-label="데이터셋 검색 지우기" onClick={() => setQuery('')}><X size={13} /></button>}</label>
          <label className="ds-category-filter">분류<select aria-label="데이터셋 분류 필터" value={category} onChange={event => setCategory(event.target.value)} disabled={loading}><option value="all">전체 분류</option>{categories.map(([name, count]) => <option key={name} value={`category:${name}`}>{name || '미분류'} ({count}개 항목)</option>)}</select></label>
          <label className="ds-sort">정렬<select aria-label="데이터셋 정렬" value={sort} onChange={event => setSort(event.target.value)} disabled={loading}><option value="updated">최근 수정순</option><option value="name">이름순</option><option value="cases">항목 수 많은순</option></select></label>
        </div>
        <div className="ds-summary">{loading ? '목록을 불러오는 중입니다.' : <><strong>{items.length}</strong>개 데이터셋{(query || category !== 'all') && <span> (전체 {state.datasets.length}개)</span>}<span> / 검증 항목 {items.reduce((count, dataset) => count + dataset.rows.filter(value => matchesCategory(value, category)).length, 0)}개{category !== 'all' ? '가 선택한 분류에 해당합니다.' : ''}</span></>}</div>
        {loading ? <div className="ds-loading" role="status"><Loader2 size={19} className="spin" /><span>검증 데이터셋을 불러오는 중입니다.</span></div> : state.datasets.length === 0 ? <div className="ds-empty"><Empty icon={<Database size={25} />} title="등록된 데이터셋이 없습니다" description="요청 내용과 예상 결과를 직접 작성하거나 CSV 또는 JSON 파일을 가져오세요." /><button className="btn primary" onClick={create} disabled={writeLocked}><Plus size={14} /> 새 데이터셋</button></div> : items.length === 0 ? <div className="ds-empty"><Empty title="검색 결과가 없습니다" description="검색어나 분류 조건을 바꿔 보세요." /><button className="btn" onClick={() => { setQuery(''); setCategory('all'); }}>필터 초기화</button></div> : <div className="ds-table-wrap"><table className="ds-table"><thead><tr><th scope="col">데이터셋</th><th scope="col">항목 수</th><th scope="col">예상 결과</th><th scope="col">최근 수정 (한국 시간)</th><th scope="col">관리</th></tr></thead><tbody>{items.map(dataset => <tr key={dataset.id}><td><button className="ds-name" onClick={() => openEditor(dataset)} disabled={locked}>{dataset.name}</button><p className="ds-description" title={dataset.description}>{dataset.description || '설명 없음'}</p></td><td>{dataset.rows.length}개<div className="ds-category-count">{categoryCounts(dataset.rows).filter(([name]) => name).length}개 분류</div></td><td><div className="ds-counts"><Tag tone="success">허용 {dataset.rows.filter(value => value.expected === 'allow').length}</Tag><Tag tone="danger">차단 {dataset.rows.filter(value => value.expected === 'block').length}</Tag></div></td><td>{dataset.updatedAt && Number.isFinite(Date.parse(dataset.updatedAt)) ? <time dateTime={dataset.updatedAt}>{timeLabel(dataset.updatedAt)}</time> : <span>기록 없음</span>}</td><td><div className="ds-actions"><button onClick={() => openEditor(dataset)} disabled={locked} aria-label={`${dataset.name} ${readOnly?'보기':'편집'}`}>{readOnly?'보기':'편집'}</button><button onClick={() => void duplicate(dataset)} disabled={writeLocked || atLimit} aria-label={`${dataset.name} 복제`}>복제</button><button className="ds-evaluate" onClick={() => onEvaluate(dataset.id)} disabled={writeLocked || state.workflows.length === 0} aria-label={`${dataset.name} 검증하기`} title={state.workflows.length ? '이 데이터셋을 선택한 검증 화면을 엽니다.' : '검증할 워크플로우를 먼저 등록하세요.'}>검증하기</button><select className="ds-export" aria-label={`${dataset.name} 내보내기`} value="" onChange={event => { if (event.target.value) download(dataset, event.target.value as 'json' | 'csv'); }} disabled={locked}><option value="" disabled>내보내기</option><option value="json">JSON</option><option value="csv">CSV</option></select><button onClick={() => setDeleting(dataset)} disabled={writeLocked} aria-label={`${dataset.name} 삭제`} title="데이터셋 삭제"><Trash2 size={14} /></button></div></td></tr>)}</tbody></table></div>}
        <div className="ds-footer"><span>데이터셋당 최대 100개 항목. 질문과 목록용 요청 내용은 16,000자, 대화 전체는 40,000자까지 저장합니다. CSV 필수 열: input, expected. 대화와 생성 옵션은 messages, generationOptions 열의 JSON으로 보존합니다.</span><button onClick={downloadExample}><Download size={12} /> JSON 예제 다운로드</button></div>
      </section>
      <input ref={fileInput} type="file" accept=".csv,.json" onChange={event => void importFile(event)} hidden />
    </> : <>
      <div className="ds-editor-back"><button className="btn text" onClick={requestClose} disabled={locked}><ArrowLeft size={14} /> 데이터셋 목록</button>{dirty && <span>저장되지 않은 변경사항이 있습니다.</span>}</div>
      <PageHeading eyebrow="데이터셋 편집" title={state.datasets.some(dataset => dataset.id === editing.id) ? (readOnly?'데이터셋 보기':'데이터셋 편집') : '새 데이터셋'} description="목록에서 항목을 선택해 요청과 예상 결과를 편집합니다." />
      <div className="ds-editor-actionbar" aria-label="데이터셋 편집 작업"><div aria-live="polite"><strong>{readOnly ? '조회 모드' : localAction === 'save' ? '저장 중…' : dirty ? '저장 전 변경 있음' : '변경 없음'}</strong>{showErrors && errors.length > 0 && <span className="ds-action-error">입력 확인 {errors.length}건</span>}{saveError && <span role="alert" className="ds-action-error">{saveError}</span>}</div><div className="ds-editor-action-buttons"><button className="btn small" disabled={writeLocked} onClick={()=>{setImportPreview(undefined);setImportSource('');setImportError('');setImportOpen(true);}}>붙여넣기</button><button className="btn small" onClick={addRow} disabled={writeLocked || editing.rows.length >= 100}><Plus size={14}/> 항목 추가</button><button className="btn small" onClick={() => void save(true)} disabled={writeLocked || conflict || state.workflows.length === 0}>저장 후 검증 <ArrowRight size={14}/></button><button className="btn small primary" onClick={() => void save()} disabled={writeLocked || conflict}><Save size={14}/> {localAction === 'save' ? '저장 중…' : '저장'}</button></div></div>
      {conflict&&<div className="ds-conflict" role="alert"><div><strong>서버 저장본이 변경되었습니다</strong><p>현재 편집 내용은 그대로 유지했습니다. 서버 내용을 다시 열면 내 변경은 교체됩니다. 별도 데이터셋으로 보관하려면 복사본으로 저장하세요.</p></div><div>{serverDataset&&<button className="btn small" disabled={locked} onClick={()=>{setPendingRequest({datasetId:serverDataset.id});setDiscard(true);}}>서버 내용 다시 열기</button>}<button className="btn small primary" disabled={writeLocked||atLimit} onClick={()=>void save(false,true)}>내 변경을 복사본으로 저장</button></div></div>}
      <section className="ds-workflow-context" aria-label="데이터셋 검사 기준 점검 대상"><div><strong>검증할 워크플로우</strong><p>선택한 버전의 검사와 예상 기준을 비교합니다. 데이터셋의 요청과 기준은 선택만으로 바뀌지 않습니다.</p></div><label>워크플로우<select aria-label="데이터셋 점검 워크플로우" value={workflowId} disabled={locked} onChange={event=>{setWorkflowId(event.target.value);setTarget('draft');setAuthoringWorkflow(undefined);}}><option value="">선택하지 않음</option>{state.workflows.map(workflow=><option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label><label>검사할 버전<select aria-label="데이터셋 점검 버전" value={target} disabled={locked||!workflowId} onChange={event=>setTarget(event.target.value as 'draft'|'deployed')}><option value="draft">현재 초안</option><option value="deployed" disabled={!deployment}>최근 배포 버전{deployment?` v${deployment.version}`:' (배포 필요)'}</option></select></label></section>
      {authoringWorkflow?.id===workflowId&&target==='draft'&&<p className="ds-authoring-context">Switch 사례 생성 시점의 편집 초안 스키마를 참고합니다. 이 데이터셋은 별도로 저장되며 정책 변경에 따라 자동 수정되지 않습니다.</p>}
      {selectedWorkflow&&listWorkflowPolicyChecks(selectedWorkflow).length>0&&<p className="ds-authoring-context">정책 검사: <strong>{listWorkflowPolicyChecks(selectedWorkflow).length}개</strong> / {target==='deployed'?`배포 v${deployment?.version}`:'현재 초안'} / 고정된 정책 버전의 출력 스키마를 참고합니다.</p>}
      {templateNotice&&<p className="ds-authoring-context" role="status">{templateNotice}</p>}
      {schemaImpacts.length>0&&<section className="ds-schema-impacts" aria-label="정책 스키마와 기존 기준의 차이"><strong>현재 스키마와 비교해 확인할 항목 {schemaImpacts.length}개</strong><p>기존 검증 기준은 그대로 유지합니다. 필드와 자료형을 확인하고 필요한 항목만 수정하세요.</p>{schemaImpacts.map(impact=><button key={impact.rowId} type="button" onClick={()=>jumpToRow(impact.rowId)}>{impact.index+1}번 항목: {impact.messages.join(' ')}</button>)}</section>}
      {selectedWorkflow&&unconfirmedRows.some(id=>editing.rows.some(row=>row.id===id))?<p className="ds-authoring-context">각 항목의 요청과 최종 예상 결과를 작성하면 기준 점검을 시작할 수 있습니다. 아직 선택하지 않은 허용과 차단은 집계하지 않습니다.</p>:selectedWorkflow?<div className="ds-preflight"><DatasetPreflightPanel dataset={editing} workflow={selectedWorkflow} state={state} act={act} target={target} workflowConnections={workflowConnections} targetLabel={target==='deployed'?`배포 v${deployment?.version}`:'현재 초안'} showAcknowledgement={false} onEditRow={jumpToRow} onMappedDataset={setPendingMappedId} readOnly={readOnly} busy={locked} mappingDisabledReason={dirty?'변경한 내용을 먼저 저장한 뒤 데이터셋을 다시 열어 검사 연결을 바꾼 복사본을 만드세요.':!state.datasets.some(dataset=>dataset.id===editing.id)?'데이터셋을 먼저 저장하면 검사 연결을 바꾼 복사본을 만들 수 있습니다.':undefined} /></div>:<p className="ds-context-hint">워크플로우를 선택하면 예상 검사 목록과 기준 점검 결과를 확인할 수 있습니다. 과거 검사 ID는 직접 입력해 보관할 수 있습니다.</p>}
      <section className="ds-panel">
        <div className="ds-editor-fields"><label className="field">데이터셋 이름<input maxLength={120} value={editing.name} onChange={event => change({ name: event.target.value })} placeholder="예: 고객 상담 개인정보 검증" disabled={writeLocked} /></label><label className="field">설명<textarea rows={2} maxLength={1000} value={editing.description} onChange={event => change({ description: event.target.value })} placeholder="검사 목적과 포함한 내용을 입력하세요." disabled={writeLocked} /></label></div>
        <div className="ds-row-toolbar"><div className="ds-row-counts"><strong>검증 항목 {editing.rows.length}개</strong><Tag tone="success">허용 예상 {editing.rows.filter(value => value.expected === 'allow'&&!unconfirmedRows.includes(value.id)).length}</Tag><Tag tone="danger">차단 예상 {editing.rows.filter(value => value.expected === 'block'&&!unconfirmedRows.includes(value.id)).length}</Tag></div><div className="ds-bulk-tools"><span>{checkedRows.filter(id=>editing.rows.some(row=>row.id===id)).length}개 선택</span><button className="btn small" disabled={writeLocked||!checkedRows.length} onClick={()=>setBulkOpen(true)}>선택 항목 일괄 설정</button>{undoEdit&&<button className="btn small" disabled={writeLocked||authoringSignature(editing,fieldDrafts,requestDrafts,unconfirmedRows)!==undoEdit.after} title="이후 편집을 하기 전 마지막 일괄 작업을 되돌립니다." onClick={undoAuthoring}>마지막 일괄 작업 되돌리기</button>}</div></div>
        <div className="ds-criteria-help"><p>검사 ID를 지정하면 다른 검사에서 차단된 경우 예상 결과 일치로 집계하지 않습니다. 판단 근거에는 이 항목을 허용하거나 차단해야 하는 이유를 적어 주세요.</p><div className="ds-row-filter"><label className="ds-category-filter">항목 분류<select aria-label="검증 항목 분류 필터" value={rowCategory} onChange={event => setRowCategory(event.target.value)}><option value="all">전체 ({editing.rows.length}개)</option>{editorCategories.map(([name, count]) => <option key={name} value={`category:${name}`}>{name || '미분류'} ({count}개)</option>)}</select></label><label className="ds-item-search"><Search size={14}/><input aria-label="검증 항목 검색" placeholder="요청, 분류, 근거 검색" value={rowQuery} onChange={event => setRowQuery(event.target.value)}/>{rowQuery && <button type="button" aria-label="검증 항목 검색 지우기" onClick={() => setRowQuery('')}><X size={13}/></button>}</label><label className="ds-item-jump">번호<input aria-label="이동할 검증 항목 번호" inputMode="numeric" type="number" min={1} max={editing.rows.length} value={rowNumber} onChange={event => setRowNumber(event.target.value)} onKeyDown={event => {if(event.key==='Enter'){event.preventDefault();jumpByNumber();}}}/><button className="btn small" onClick={jumpByNumber} disabled={!editing.rows.length}>이동</button></label><span>{visibleRows.length} / {editing.rows.length}개 표시</span></div></div>
        {showErrors && errors.length > 0 && <div className="ds-form-errors" role="alert"><strong>입력한 내용을 확인하세요.</strong><ul>{errors.slice(0, 5).map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul>{errors.length > 5 && <span>외 {errors.length - 5}개 오류가 있습니다.</span>}</div>}
        <div className="ds-items-workspace"><aside className="ds-item-list ds-item-table" aria-label="검증 항목 목록"><table><thead><tr><th><input type="checkbox" aria-label="보이는 검증 항목 모두 선택" disabled={writeLocked||!visibleRows.length} checked={Boolean(visibleRows.length&&visibleRows.every(({value})=>checkedRows.includes(value.id)))} onChange={event=>{const ids=visibleRows.map(({value})=>value.id);setCheckedRows(current=>event.target.checked?[...new Set([...current,...ids])]:current.filter(id=>!ids.includes(id)));}}/></th><th>요청</th><th>예상 결과</th><th>출력 조건</th></tr></thead><tbody>{visibleRows.map(({value,index})=><tr key={value.id} className={selectedRow?.value.id===value.id?'active':''}><td><input type="checkbox" aria-label={`${index+1}번 항목 일괄 선택`} disabled={writeLocked} checked={checkedRows.includes(value.id)} onChange={()=>toggleChecked(value.id)}/></td><td><button type="button" aria-current={selectedRow?.value.id===value.id?'true':undefined} aria-label={`${index+1}번 항목 편집`} onClick={()=>{setSelectedRowId(value.id);setRowFocus(undefined);}}><strong>{index+1}. {value.input.trim()||(value.messages?'대화 요청':'요청 작성 필요')}</strong><small>{value.category||'미분류'}</small></button></td><td>{unconfirmedRows.includes(value.id)?'선택 필요':value.expected==='allow'?'허용':'차단'}</td><td>{value.expectedPolicyFields?.length??0}개</td></tr>)}</tbody></table></aside><div className="ds-selected-editor"><div className="ds-selected-toolbar"><strong>{selectedRow ? `${selectedRow.index + 1}번 항목` : '항목 선택'}</strong><span>{selectedPosition >= 0 ? `${selectedPosition + 1} / ${visibleRows.length}` : ''}</span><button className="btn small" aria-label="이전 검증 항목" disabled={selectedPosition <= 0} onClick={() => setSelectedRowId(visibleRows[selectedPosition - 1].value.id)}><ChevronLeft size={14}/> 이전</button><button className="btn small" aria-label="다음 검증 항목" disabled={selectedPosition < 0 || selectedPosition >= visibleRows.length - 1} onClick={() => setSelectedRowId(visibleRows[selectedPosition + 1].value.id)}>다음 <ChevronRight size={14}/></button></div>
        <div className="ds-rows" ref={rowsRef}>{(selectedRow ? [selectedRow] : []).map(({ value, index }) => {
          const customRule = customRuleRows.includes(value.id) || Boolean(value.expectedRuleId && !ruleIds.has(value.expectedRuleId));
          const inputDraft=requestDrafts[value.id]||requestDraft(value);
          let inputError='';try{parseDatasetRequestSettings(inputDraft.messages,inputDraft.options);}catch(error){inputError=error instanceof Error?error.message:'대화 입력을 확인하세요.';}
          return <div className={`ds-row ${rowFocus?.rowId===value.id?'focused':''}`} key={value.id} data-dataset-row={value.id} tabIndex={-1}>
            <span className="ds-row-number">{index + 1}</span>
            <label className="ds-row-input">{value.messages?'목록용 요청 설명':'요청 내용'}<textarea aria-label={`${index + 1}번 항목 요청 내용`} rows={2} maxLength={16000} value={value.input} onChange={event => changeRow(value.id, { input: event.target.value })} placeholder={value.messages?'대화 항목을 찾기 쉬운 설명을 입력하세요.':'검사할 요청 내용을 입력하세요.'} disabled={writeLocked} /><small>{value.messages?'실행에는 지정한 대화를 사용합니다. / ':''}{value.input.length.toLocaleString()} / 16,000자</small></label>
            <label className="ds-row-expected">예상 결과<select aria-label={`${index + 1}번 항목 예상 결과`} value={unconfirmedRows.includes(value.id)?'':value.expected} onChange={event => { const expected=event.target.value as 'allow'|'block'; const group=ruleGroups.find(item=>item.rules.some(rule=>rule.id===value.expectedRuleId)); changeRow(value.id,{expected,...(value.expectedStage||group?{expectedStage:expected==='allow'?'complete':group?.stage||(value.expectedStage==='complete'?undefined:value.expectedStage)}:{})}); }} disabled={writeLocked}><option value="" disabled>직접 선택하세요</option><option value="allow">허용 (allow)</option><option value="block">차단 (block)</option></select></label>
            <div className="ds-row-actions"><button aria-label={`${index + 1}번 항목 복제`} title="항목 복제" onClick={() => duplicateRow(value.id)} disabled={writeLocked || editing.rows.length >= 100}><Copy size={14} /></button><button aria-label={`${index + 1}번 항목 삭제`} title="항목 삭제" onClick={() => change({ rows: editing.rows.filter(item => item.id !== value.id) })} disabled={writeLocked}><Trash2 size={14} /></button></div>
            <details className="ds-row-details">
              <summary aria-label={`${index + 1}번 항목 검증 기준`}>검증 기준<span>{[value.category, value.expectedStage && stageNames[value.expectedStage], value.expectedRuleId && '검사 지정', value.expectedDecision && `정책 ${value.expectedDecision}`, value.expectedRoute && '경로 지정', value.expectedPolicyFields?.length && `출력 필드 ${value.expectedPolicyFields.length}개`, value.note && '판단 근거 있음'].filter(Boolean).join(' / ') || '분류, 예상 단계, 검사와 판단 근거를 추가할 수 있습니다.'}</span></summary>
              <div className="ds-row-metadata">
                <label>분류<input aria-label={`${index + 1}번 항목 분류`} value={value.category || ''} maxLength={80} placeholder="예: 개인정보, 지시 우회" list="dataset-category-suggestions" onChange={event => { changeRow(value.id, { category: event.target.value || undefined }); setRowCategory('all'); }} disabled={writeLocked} /></label>
                <label>예상 종료 단계<select aria-label={`${index + 1}번 항목 예상 단계`} value={value.expectedStage || ''} onChange={event => changeRow(value.id, { expectedStage: event.target.value as DatasetRow['expectedStage'] || undefined })} disabled={writeLocked}><option value="">지정하지 않음</option><option value="pre">요청 검사 (pre)</option><option value="main">응답 생성 (main)</option><option value="post">응답 검사 (post)</option><option value="complete">검사 완료 (complete)</option></select></label>
                <label className="ds-rule-field">예상 검사<select aria-label={`${index + 1}번 항목 예상 검사`} value={customRule ? 'custom' : value.expectedRuleId ? `rule:${value.expectedRuleId}` : ''} onChange={event => {
                  const custom = event.target.value === 'custom';
                  const selected = event.target.value.slice(5);
                  setCustomRuleRows(current => custom ? [...new Set([...current, value.id])] : current.filter(id => id !== value.id));
                  if (custom) { changeRow(value.id, { expectedRuleId: undefined }); return; }
                  const group = ruleGroups.find(item => item.rules.some(rule => rule.id === selected));
                  changeRow(value.id, { expectedRuleId: selected || undefined, ...(group ? { expectedStage: value.expected==='allow'?'complete':group.stage } : {}) });
                }} disabled={writeLocked}><option value="">지정하지 않음</option>{ruleGroups.map(group => <optgroup key={group.key} label={group.label}>{group.rules.map(rule => <option key={rule.id} value={`rule:${rule.id}`}>{rule.groupName} / {rule.name}{rule.enabled?'':' (사용 안 함)'} ({rule.id})</option>)}</optgroup>)}<option value="custom">검사 ID 직접 입력</option></select>{customRule && <input aria-label={`${index + 1}번 항목 예상 검사 ID`} value={value.expectedRuleId || ''} maxLength={120} placeholder="예: rule-pii 또는 과거 배포의 검사 ID" onChange={event => changeRow(value.id, { expectedRuleId: event.target.value || undefined })} disabled={writeLocked} />}<small>선택한 워크플로우 버전의 검사만 표시합니다. 차단 예상은 선택한 검사 단계에서 종료되어야 하고 허용 예상은 검사 완료 단계여야 합니다. 과거 검사 ID도 입력할 수 있습니다.</small></label>
                <label>예상 정책 판정<input aria-label={`${index + 1}번 항목 예상 정책 판정`} value={value.expectedDecision ?? ''} maxLength={64} placeholder="예: OUT_OF_SCOPE" onChange={event => changeRow(value.id, { expectedDecision: event.target.value || undefined })} disabled={writeLocked} /><small>지정하면 정책 LLM의 판정 코드도 일치해야 합니다.</small></label>
                <label>예상 정책 경로<select aria-label={`${index + 1}번 항목 예상 정책 경로`} value={value.expectedRoute ?? ''} onChange={event => changeRow(value.id, { expectedRoute: event.target.value as DatasetRow['expectedRoute'] || undefined })} disabled={writeLocked}><option value="">지정하지 않음</option><option value="main">응답 모델 실행 (main)</option><option value="respond">등록 안내 응답 (respond)</option><option value="error">지정 오류 (error)</option></select></label>
                <label>예상 공개 오류 코드<input aria-label={`${index + 1}번 항목 예상 공개 오류 코드`} value={value.expectedPolicyCode ?? ''} maxLength={64} placeholder="예: PII_RESTRICTED" onChange={event => changeRow(value.id, { expectedPolicyCode: event.target.value || undefined })} disabled={writeLocked} /></label>
                <label className="ds-note-field">판단 근거<textarea aria-label={`${index + 1}번 항목 판단 근거`} rows={2} maxLength={1000} value={value.note || ''} placeholder="예: 이메일 주소가 포함되어 요청의 개인정보 검사에서 차단되어야 합니다." onChange={event => changeRow(value.id, { note: event.target.value || undefined })} disabled={writeLocked} /><small>{(value.note?.length || 0).toLocaleString()} / 1,000자</small></label>
                <section className="ds-policy-fields" aria-label={`${index+1}번 항목 정책 출력 검증`}><label className="ds-policy-fields-toggle"><input type="checkbox" aria-label={`${index+1}번 항목 정책 출력 필드 조건 사용`} checked={Boolean(value.expectedPolicyFields)} disabled={writeLocked} onChange={event=>{changeRow(value.id,{expectedPolicyFields:event.target.checked?[{path:'',operator:'eq',value:''}]:undefined});setFieldDrafts(current=>({...current,[value.id]:{}}));}}/> 정책 출력 필드 조건 사용</label><p>선택한 정책 검사의 JSON 출력을 검사합니다. 정책이 없거나 실행되지 않으면 불일치입니다. 실행 경로와 차단 판정은 변경하지 않습니다.</p><PolicyCheckSelect workflow={selectedWorkflow} value={value.expectedPolicyNodeId} disabled={writeLocked} label={`${index+1}번 항목 검증할 정책 검사`} onChange={expectedPolicyNodeId=>{changeRow(value.id,{expectedPolicyNodeId});setFieldDrafts(current=>({...current,[value.id]:{}}));}}/>{value.expectedPolicyFields && <PolicyFieldAssertions label={`${index+1}번 항목 정책 출력`} values={value.expectedPolicyFields} drafts={fieldDrafts[value.id]??{}} disabled={writeLocked} schema={rowSchema(value)} onChange={fields=>changeRow(value.id,{expectedPolicyFields:fields})} onDraftsChange={drafts=>{setFieldDrafts(current=>({...current,[value.id]:drafts}));setRequestTouched(true);}}/>}</section>
              </div>
            </details>
            <details className="ds-row-details ds-request-details">
              <summary aria-label={`${index+1}번 항목 대화와 생성 옵션`}>대화와 생성 옵션<span>{value.messages?`메시지 ${value.messages.length}개`:'질문 한 건'}{value.generationOptions?' / 생성 옵션 지정':''}{inputError?' / 입력 확인 필요':''}</span></summary>
              <p>대화를 지정하면 위 요청 내용은 목록에서 찾기 위한 설명으로 사용하고, 실행에는 아래 메시지를 전달합니다. 비워 두면 요청 내용 한 건으로 실행합니다.</p>
              <div className="ds-request-fields"><label>대화 메시지 JSON<textarea aria-label={`${index+1}번 항목 대화 메시지 JSON`} rows={6} maxLength={300000} spellCheck={false} value={inputDraft.messages} disabled={writeLocked} onChange={event=>changeRequest(value.id,'messages',event.target.value)} placeholder={'[{"role":"system","content":"고객 문의에 답하세요."},{"role":"user","content":"배송 기간은 얼마나 걸리나요?"}]'}/><small>system, user, assistant 역할을 사용할 수 있습니다. 메시지 최대 32개, 전체 40,000자입니다.</small></label><label>생성 옵션 JSON<textarea aria-label={`${index+1}번 항목 생성 옵션 JSON`} rows={4} maxLength={1000} spellCheck={false} value={inputDraft.options} disabled={writeLocked} onChange={event=>changeRequest(value.id,'options',event.target.value)} placeholder={'{"temperature":0,"max_tokens":1024,"top_p":1}'}/><small>비워 두면 서버의 기본값을 사용합니다.</small></label></div>
              {inputError&&<p className="ds-request-error" role="alert">{inputError}</p>}
            </details>
          </div>;
        })}{editing.rows.length === 0 ? <Empty title="검증 항목을 추가하세요" description="검증 항목을 한 개 이상 추가한 뒤 저장하세요." /> : visibleRows.length === 0 && <div className="ds-filter-empty"><p>검색과 분류에 해당하는 항목이 없습니다.</p><button className="btn small" onClick={() => {setRowCategory('all');setRowQuery('');}}>전체 항목 보기</button></div>}</div>
        </div></div>
        <datalist id="dataset-category-suggestions">{[...new Set([...categories, ...editorCategories].map(([name]) => name).filter(Boolean))].map(name => <option key={name} value={name} />)}</datalist>
        <div className="ds-editor-footer"><span>요청과 대화의 공백과 줄바꿈은 그대로 저장됩니다. 항목을 이동해도 작성 중인 JSON은 유지됩니다.</span></div>
      </section>
    </>}
    {localAction === 'import' && <div className="ds-busy" role="status"><Loader2 size={15} className="spin" /> 파일을 확인하고 있습니다.</div>}
    {bulkOpen&&editing&&<div className="ds-dialog-backdrop"><section className="ds-dialog ds-authoring-dialog" ref={authoringDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="dataset-bulk-title"><header><h2 id="dataset-bulk-title">선택 항목 {checkedRows.length}개 일괄 설정</h2><button className="icon-button" aria-label="일괄 설정 닫기" onClick={()=>setBulkOpen(false)}><X size={17}/></button></header><p>선택한 설정만 덮어씁니다. 요청이나 실제 결과에서 정답을 추론하지 않습니다. 정책 필드 조건을 적용하면 각 항목의 기존 필드 조건을 바꿉니다.</p><div className="ds-authoring-form"><label className="field">최종 예상 결과<select aria-label="일괄 예상 결과" disabled={writeLocked} value={bulkExpected} onChange={event=>setBulkExpected(event.target.value as DatasetRow['expected']|'')}><option value="">현재 값 유지</option><option value="allow">허용으로 설정</option><option value="block">차단으로 설정</option></select></label><label className="ds-bulk-check"><input type="checkbox" checked={bulkCategoryEnabled} disabled={writeLocked} onChange={event=>setBulkCategoryEnabled(event.target.checked)}/>분류 변경</label>{bulkCategoryEnabled&&<label className="field">적용할 분류<input aria-label="일괄 분류" maxLength={80} value={bulkCategory} disabled={writeLocked} onChange={event=>setBulkCategory(event.target.value)}/><small>비워 두고 적용하면 선택한 항목의 분류를 지웁니다.</small></label>}<details><summary>단계와 정책 경로 기준</summary><label className="field">예상 종료 단계<select aria-label="일괄 예상 단계" value={bulkStage} disabled={writeLocked} onChange={event=>setBulkStage(event.target.value as typeof bulkStage)}><option value="keep">현재 값 유지</option><option value="clear">지정한 단계 제거</option>{Object.entries(stageNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="field">예상 정책 경로<select aria-label="일괄 예상 정책 경로" value={bulkRoute} disabled={writeLocked} onChange={event=>setBulkRoute(event.target.value as typeof bulkRoute)}><option value="keep">현재 값 유지</option><option value="clear">지정한 경로 제거</option><option value="main">다음 검사 계속 / 응답 모델 실행</option><option value="respond">등록 안내 응답</option><option value="error">지정 오류</option></select></label></details><label className="ds-bulk-check"><input type="checkbox" checked={bulkFieldsEnabled} disabled={writeLocked} onChange={event=>setBulkFieldsEnabled(event.target.checked)}/>정책 출력 필드 조건 교체</label>{bulkFieldsEnabled&&<><PolicyCheckSelect workflow={selectedWorkflow} value={bulkPolicyNodeId} onChange={setBulkPolicyNodeId} disabled={writeLocked} label="일괄 검증할 정책 검사"/><PolicyFieldAssertions label="일괄 정책 출력" values={bulkFields} drafts={bulkDrafts} schema={selectedSchema} disabled={writeLocked} onChange={setBulkFields} onDraftsChange={setBulkDrafts}/></>}<p className="ds-authoring-context">적용 대상: {editing.rows.map((row,index)=>checkedRows.includes(row.id)?`${index+1}번`:null).filter(Boolean).join(', ')}. 서버에는 저장 버튼을 누른 뒤 반영됩니다.</p></div><footer><button className="btn" onClick={()=>setBulkOpen(false)}>취소</button><button className="btn primary" disabled={writeLocked||!checkedRows.length} onClick={applyBulk}>선택한 설정 적용</button></footer></section></div>}
    {importOpen&&<div className="ds-dialog-backdrop"><section className="ds-dialog ds-authoring-dialog" ref={authoringDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="dataset-import-title"><header><h2 id="dataset-import-title">가져오기 미리보기</h2><button className="icon-button" aria-label="가져오기 닫기" disabled={locked} onClick={()=>setImportOpen(false)}><X size={17}/></button></header><div className="ds-authoring-form"><p>CSV와 JSON의 기존 input, expected 및 선택 열 형식을 그대로 사용합니다. 미리 본 뒤 초안에 반영하며 실제 저장은 별도입니다.</p><label className="field">붙여넣기 형식<select aria-label="붙여넣기 형식" disabled={writeLocked} value={importFormat} onChange={event=>{setImportFormat(event.target.value as 'json'|'csv');setImportPreview(undefined);}}><option value="json">JSON</option><option value="csv">CSV</option></select></label><label className="field">CSV 또는 JSON 붙여넣기<textarea aria-label="데이터셋 붙여넣기" rows={6} maxLength={2000000} spellCheck={false} disabled={writeLocked} value={importSource} onChange={event=>{setImportSource(event.target.value);setImportPreview(undefined);}}/></label><button className="btn small" disabled={writeLocked||!importSource.trim()} onClick={previewPaste}>붙여넣은 내용 확인</button>{importError&&<p className="ds-request-error" role="alert">{importError}</p>}{importPreview&&<section aria-label="가져올 항목 미리보기"><h3>{importPreview.name} / {importPreview.rows.length}개 항목</h3><div className="ds-import-preview"><table><thead><tr><th>요청</th><th>예상 결과</th><th>출력 조건</th></tr></thead><tbody>{importPreview.rows.slice(0,10).map(row=><tr key={row.id}><td>{row.input}</td><td>{row.expected==='allow'?'허용':'차단'}</td><td>{row.expectedPolicyFields?.length??0}개</td></tr>)}</tbody></table></div>{importPreview.rows.length>10&&<p>처음 10개를 표시합니다. 적용하면 전체 {importPreview.rows.length}개를 반영합니다.</p>}<p>{editing?'현재 데이터셋 끝에 항목을 추가합니다. 기존 항목은 유지합니다.':'새 데이터셋 초안으로 엽니다.'}</p></section>}</div><footer><button className="btn" disabled={locked} onClick={()=>setImportOpen(false)}>취소</button><button className="btn primary" disabled={writeLocked||!importPreview||Boolean(editing&&importPreview&&editing.rows.length+importPreview.rows.length>100)} onClick={applyImport}>{editing?'미리 본 항목 추가':'새 초안으로 열기'}</button></footer></section></div>}
    {deleting && <div className="ds-dialog-backdrop" onClick={() => !locked && setDeleting(undefined)}><section className="ds-dialog" role="dialog" aria-modal="true" aria-labelledby="dataset-delete-title" onClick={event => event.stopPropagation()}><header><h2 id="dataset-delete-title">데이터셋을 삭제할까요?</h2><button className="icon-button" aria-label="삭제 창 닫기" onClick={() => setDeleting(undefined)} disabled={writeLocked}><X size={17} /></button></header><p><strong>{deleting.name}</strong>과 검증 항목 {deleting.rows.length}개를 삭제합니다. 삭제한 데이터셋은 복구할 수 없습니다.</p><p className="ds-remember">이전에 실행한 검증 결과와 당시 요청 내용, 예상 결과는 유지됩니다.</p><footer><button className="btn" onClick={() => setDeleting(undefined)} disabled={writeLocked}>취소</button><button className="btn danger" onClick={() => void remove()} disabled={writeLocked}>{localAction === 'delete' ? '삭제 중…' : '데이터셋 삭제'}</button></footer></section></div>}
    {discard && <div className="ds-dialog-backdrop" onClick={cancelDiscard}><section className="ds-dialog" role="dialog" aria-modal="true" aria-labelledby="dataset-discard-title" ref={discardDialog} tabIndex={-1} onClick={event => event.stopPropagation()}><header><h2 id="dataset-discard-title">변경사항을 버릴까요?</h2><button className="icon-button" aria-label="변경사항 확인 창 닫기" onClick={cancelDiscard}><X size={17} /></button></header><p>아직 저장하지 않은 데이터셋 변경사항이 있습니다.{pendingRequest?' 변경사항을 버리면 요청한 데이터셋으로 이동합니다.':''}</p><footer><button className="btn" onClick={cancelDiscard}>계속 편집</button><button className="btn danger" onClick={confirmDiscard}>변경사항 버리기</button></footer></section></div>}
  </div>;
}
