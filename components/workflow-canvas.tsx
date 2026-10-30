'use client';

import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { AlignLeft, Boxes, BrainCircuit, Braces, Check, CheckSquare, FileJson, GitBranch, Layers3, LayoutGrid, ListChecks, LogIn, LogOut, Maximize2, Merge, Minus, Pin, Plus, RefreshCw, Regex, Search, Settings2, ShieldCheck, Split, SquareDashed, X, Zap } from 'lucide-react';
import type { CanvasZone, Connection, ConsoleExecutionInspection, ExecutionResult, Workflow, WorkflowProgressEvent } from '@/lib/aegis-types';
import { autoLayout, createZoneForNodes, executionEndpointKey, layoutBounds, moveNodes, moveZoneLayout, nodeDefinitions, resolveLayout, visibleLayoutKey, zoneFrames, NODE_HEIGHT, NODE_WIDTH, NODE_ICON_SIZE, NODE_ICON_CENTER_Y, ZONE_MIN_WIDTH, ZONE_MIN_HEIGHT, ZONE_SIZE_LIMIT, type WorkflowSelection, type CanvasZoneFrame, type CanvasNode, type CanvasPositions } from '@/lib/workflow-layout';
import { ruleKindLabels } from '@/lib/node-catalog';
import { connectionLabel } from '@/lib/product-copy';
import { endpointLabel, getStageGraph } from '@/lib/workflow-graph';
import { captureInsertTarget, previewConnection, type FlowConnectionImpact, type FlowInsertTarget } from '@/lib/workflow-connections';
import { searchWorkflowNodes, type WorkflowSearchResult } from '@/lib/workflow-search';
import { canvasExecutionColors, canvasExecutionLabels, workflowExecutionView, type CanvasExecutionState } from '@/lib/workflow-execution-view';
import { workflowPathFocus } from '@/lib/workflow-path-focus';
import { getWorkflowCanvasLinks, type WorkflowCanvasLink } from '@/lib/workflow-policy-canvas';
import { listWorkflowPolicyChecks, parsePolicyScopedId, policyScopedId, workflowPolicyNode, workflowPolicyCheck } from '@/lib/workflow-policy-checks';
import { policyNodePorts } from '@/lib/policy-graph';
import { canvasPortPoint, canvasPortHitArea, facingPortSides, offsetPortPoint, type CanvasPortSide, type CanvasPortShape } from '@/lib/workflow-port-geometry';
import { routeWorkflowEdge } from '@/lib/workflow-edge-routing';

export type CanvasPortCreationSource = {stage:'pre'|'post';from:string;port:'next'|'true'|'false';position:{x:number;y:number}};
export type CanvasViewport = {scrollLeft:number;scrollTop:number;zoom:number};
export type CanvasBranchEligibility = {parallel:{valid:boolean;reason?:string};condition:{valid:boolean;reason?:string}};

export type WorkflowCanvasProps = {
  workflow: Workflow; connections: Connection[]; selection?: WorkflowSelection; disabled: boolean; readOnly?: boolean;
  inspection?: ConsoleExecutionInspection; execution?: ExecutionResult; progress?: WorkflowProgressEvent[]; running?: boolean; executionAttempt?: number; stale: boolean;
  onSelect: (selection: WorkflowSelection) => void; onLayout: (positions: CanvasPositions, zones?: CanvasZone[]) => void;
  onSearchSelect?: (selection: WorkflowSelection) => void;
  onInspect?: (selection: WorkflowSelection) => void;
  selectedKeys?: string[];
  onSelectedKeys?: (keys: string[]) => void;
  onGroupSelection?: () => void;
  zoneSelectionIssue?: string;
  zoneCompletionKeys?: string[];
  zoneCompletionIssue?: string;
  onCompleteZoneSelection?: () => void;
  onCreateFromPort?: (source:CanvasPortCreationSource) => void;
  autoFitRequest?: number;
  onAutoFitConsumed?:(request:number)=>void;
  onAddZone?: () => void;
  onAddNode?: (zoneId?: string) => void;
  onInsertNode?: (target: FlowInsertTarget, position?: { x: number; y: number }) => void;
  onBuildBranch?: (kind: 'parallel' | 'condition', keys: string[]) => void;
  branchEligibility?: CanvasBranchEligibility;
  onBackgroundSelect?: () => void;
  graphEditing?: boolean;
  onConnect?: (stage: 'pre' | 'post', from: string, to: string, port?: 'next' | 'true' | 'false') => void;
  onSelectEdge?: (stage: 'pre' | 'post', edgeId: string) => void;
  onCreatePolicyFromPort?: (source:{from:string;port:string;position?:{x:number;y:number}})=>void;
  onPolicyConnect?: (from: string, to: string, port: string) => void;
  onSelectPolicyEdge?: (edgeId: string) => void;
  selectedPolicyEdgeId?: string;
  notify?: (message: string) => void;
  connectionImpact?: FlowConnectionImpact;
  focusRequest?: {stage:'pre'|'post';endpoint:string;requestId:string};
  initialViewport?: CanvasViewport;
  onViewportChange?: (viewport:CanvasViewport) => void;
  onAdd: (stage: 'pre' | 'post', groupId?: string, parallel?: boolean) => void; onRetry: () => void;
};
const icons = { keyword: Braces, regex: Regex, length: AlignLeft, llm: BrainCircuit, pii: ShieldCheck, json: FileJson, required: ListChecks, policy:ShieldCheck };
const stageLabels = { pre: '요청', post: '응답' };
const selected = (node: CanvasNode, selection?: WorkflowSelection) => Boolean(selection && node.kind === selection.kind && (!('id' in selection) || node.id === selection.id));

type LinkSource = { stage: 'pre' | 'post'; endpoint: string; port: 'next' | 'true' | 'false'; policyNodeKey?:string; side?:CanvasPortSide };
type Wire = { pointerId: number; source: LinkSource; x: number; y: number; clientX: number; clientY: number; moved: boolean; signature: string };
type WirePreview = { source: LinkSource; point: { x: number; y: number }; targetKey?: string; target?: string; reason?: string; valid: boolean };
type CanvasEdge = Omit<WorkflowCanvasLink,'id'> & { id?: string; kind: 'flow' | 'retry' | 'fork' | 'join' | 'policy' };
type ZoneDrag = { pointerId: number; id: string; x: number; y: number; scrollX: number; scrollY: number; positions: CanvasPositions; zones: CanvasZone[]; mode: 'move' | 'resize'; moved: boolean };
type Pan = { pointerId: number; x: number; y: number; scrollX: number; scrollY: number; native: boolean; moved: boolean };
type Drag = { pointerId: number; key: string; keys: string[]; x: number; y: number; positions: CanvasPositions; scrollX: number; scrollY: number; moved: boolean };
export function WorkflowCanvas({ workflow, connections, selection, disabled: interactionDisabled, readOnly = false, execution, inspection, progress, running = false, executionAttempt, stale, onSelect, onSearchSelect, onInspect, onLayout, onAdd, onRetry, onBackgroundSelect, onConnect, onSelectEdge, onPolicyConnect, onCreatePolicyFromPort, onSelectPolicyEdge, selectedPolicyEdgeId, onInsertNode, onBuildBranch, branchEligibility, notify, selectedKeys = [], onSelectedKeys, onGroupSelection, zoneSelectionIssue, zoneCompletionKeys = [], zoneCompletionIssue, onCompleteZoneSelection, onCreateFromPort, autoFitRequest, onAutoFitConsumed, onAddZone, onAddNode, connectionImpact, focusRequest, initialViewport, onViewportChange }: WorkflowCanvasProps) {
  const disabled = interactionDisabled || readOnly;
  const nodes = useMemo(() => nodeDefinitions(workflow), [workflow]);
  const policyChecks=useMemo(()=>listWorkflowPolicyChecks(workflow),[workflow]);
  const positions = useMemo(() => resolveLayout(workflow), [workflow]);
  const [preview, setPreview] = useState<CanvasPositions>();
  const [zonePreview, setZonePreview] = useState<CanvasZone[]>();
  const [selectionMode, setSelectionMode] = useState(false);
  const [pathFocus,setPathFocus]=useState(false);
  const zoneDrag = useRef<ZoneDrag | undefined>(undefined);
  const [zoom, setZoom] = useState(()=>initialViewport&&Number.isFinite(initialViewport.zoom)?Math.max(.005,Math.min(1.5,initialViewport.zoom)):1);
  const zoomValue=useRef(zoom);zoomValue.current=zoom;
  const pendingZoomView=useRef<{zoom:number;scrollLeft:number;scrollTop:number}|undefined>(undefined);
  const wheelZoomHandler=useRef<(event:WheelEvent)=>void>(()=>undefined);
  wheelZoomHandler.current=handleCanvasWheel;
  const [fitRevision,setFitRevision]=useState(0);
  const fitActive=useRef(false);
  const viewCommand=useRef(0);
  const pendingFit=useRef<number|undefined>(undefined);
  const lastAutoFit=useRef<number|undefined>(undefined);
  const consumedFitCallback=useRef(onAutoFitConsumed);consumedFitCallback.current=onAutoFitConsumed;
  const previousViewport=useRef<CanvasViewport | undefined>(undefined);
  const [canRestoreViewport,setCanRestoreViewport]=useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [searchOpen,setSearchOpen]=useState(false);
  const [searchQuery,setSearchQuery]=useState('');
  const [searchIndex,setSearchIndex]=useState(0);
  const [searchFocusKey,setSearchFocusKey]=useState<string>();
  const searchPanel=useRef<HTMLDivElement>(null);
  const searchInput=useRef<HTMLInputElement>(null);
  const searchList=useRef<HTMLDivElement>(null);
  const searchTrigger=useRef<HTMLButtonElement>(null);
  const searchMoveFrame=useRef<number | undefined>(undefined);
  const searchId=`wc-search-${useId().replace(/[^a-zA-Z0-9]/g,'')}`;
  const searchResults=useMemo(()=>searchWorkflowNodes(workflow,connections,searchQuery),[workflow,connections,searchQuery]);
  const [linkSource, setLinkSource] = useState<LinkSource>();
  const linkSourceRef = useRef<LinkSource | undefined>(undefined);
  const wire = useRef<Wire | undefined>(undefined);
  const [policySource, setPolicySource] = useState<{id:string;port:string;side?:CanvasPortSide}>();
  const policySourceRef = useRef<typeof policySource>(undefined);
  const policyWire = useRef<{pointerId:number;source:NonNullable<typeof policySource>;clientX:number;clientY:number;moved:boolean}|undefined>(undefined);
  const [policyWirePoint, setPolicyWirePoint] = useState<{x:number;y:number}>();
  const suppressPolicyClick = useRef(false);
  const [wirePreview, setWirePreview] = useState<WirePreview>();
  const suppressWireClick = useRef(false);
  const stageGraphs = useMemo(() => ({ pre: getStageGraph(workflow, 'pre'), post: getStageGraph(workflow, 'post') }), [workflow]);
  const connectionPreviews = useMemo(() => new Map<string, ReturnType<typeof previewConnection>>(), [workflow]);
  const graphSignature = JSON.stringify(stageGraphs);
  const canConnect = !disabled && !readOnly && Boolean(onConnect);
  const canPolicyConnect = !disabled && Boolean(onPolicyConnect);
  useEffect(()=>{cancelPolicyWire(true);},[workflow.id,disabled,workflow.policyRouting?.policy.id,workflow.policyRouting?.policy.version]);
  useEffect(()=>{const source=policySourceRef.current;if(source&&!validPolicySource(source))cancelPolicyWire(true);},[workflow]);
  const drag = useRef<Drag | undefined>(undefined);
  const suppressClick = useRef(false);
  const pan = useRef<Pan | undefined>(undefined);
  const suppressBackgroundClick = useRef(false);
  const [panning, setPanning] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const viewportCallback = useRef(onViewportChange);
  viewportCallback.current = onViewportChange;
  const restoringViewport = useRef(true);
  const markerId = `wc-arrow-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const visible = preview || positions;
  const storedZones = zonePreview ?? workflow.layout?.zones ?? [];
  const visualWorkflow = { ...workflow, layout: { version: 1 as const, positions: visible, zones: storedZones } };
  const frames = zoneFrames(visualWorkflow, visible);
  const visibleKeys = new Set(nodes.map(node => node.key));
  const pickedKeys = [...new Set(selectedKeys.map(key => visibleLayoutKey(workflow, key)).filter((key): key is string => Boolean(key && visibleKeys.has(key))))];
  const parallelChoice=branchEligibility?.parallel||{valid:pickedKeys.length>=2&&pickedKeys.length<=4,reason:'같은 구간의 연속된 검사 2~4개를 선택하세요.'};
  const conditionChoice=branchEligibility?.condition||{valid:pickedKeys.length===2,reason:'조건 분기는 연속된 검사 2개를 선택하세요.'};
  const baseBounds = layoutBounds(nodes, visible, frames);
  const switchSources=new Set(policyChecks.flatMap(scope=>scope.routing.graph?.nodes.filter(node=>node.kind==='switch').map(node=>policyScopedId(scope.id,node.id))??[]));
  const parallelCounts=new Map<string,{count:number;vertical:boolean}>();
  for(const scope of policyChecks)for(const edge of scope.routing.graph?.edges??[])if(switchSources.has(policyScopedId(scope.id,edge.from))){
    const key=`${scope.id}:${edge.from}:${edge.to}`,from=visible[`policy-node:${policyScopedId(scope.id,edge.from)}`],to=visible[`policy-node:${policyScopedId(scope.id,edge.to)}`];
    const side=from&&to?facingPortSides(from,to).sourceSide:'right';
    parallelCounts.set(key,{count:(parallelCounts.get(key)?.count??0)+1,vertical:side==='top'||side==='bottom'});
  }
  // Parallel case lanes need scroll space, without moving any saved node.
  const bounds = {...baseBounds,
    width:baseBounds.width+Math.max(0,...[...parallelCounts.values()].filter(item=>item.vertical).map(item=>item.count-1))*40,
    height:baseBounds.height+Math.max(0,...[...parallelCounts.values()].filter(item=>!item.vertical).map(item=>item.count-1))*40,
  };
  const fitLatest=useRef({workflowId:workflow.id,bounds});
  fitLatest.current={workflowId:workflow.id,bounds};
  const searchView=useRef({workflowId:workflow.id,nodes,visible,bounds});
  searchView.current={workflowId:workflow.id,nodes,visible,bounds};
  const main = connections.find(connection => connection.id === workflow.mainConnectionId);
  const retry = workflow.responseRetry?.enabled === true;
  const maxRetries = workflow.responseRetry?.maxRetries ?? 1;
  const structure = nodes.map(node => node.key).join('|');
  const executionView = useMemo(() => workflowExecutionView(workflow,{execution,inspection,progress,running,stale,executionAttempt}),[workflow,execution,inspection,progress,running,stale,executionAttempt]);
  const selectedNode=nodes.find(node=>selected(node,selection));
  const focusedPath=useMemo(()=>pathFocus&&selectedNode&&!connectionImpact&&!wirePreview&&!linkSource&&!policySource?workflowPathFocus(workflow,selectedNode.key):undefined,[workflow,pathFocus,selectedNode?.key,connectionImpact,wirePreview,linkSource,policySource]);

  function setPendingLink(value?: LinkSource) { linkSourceRef.current = value; setLinkSource(value); }
  // Opening settings and transient execution activity must not discard a chosen source.
  useEffect(() => { setPendingLink(); cancelWire(); }, [readOnly, workflow.id]);
  useEffect(() => {
    const source = linkSourceRef.current;
    if (source && !validSource(source)) { setPendingLink(); setAnnouncement('선택한 연결점이 변경되어 연결을 취소했습니다.'); }
  }, [stageGraphs, workflow.pre, workflow.post]);
  useEffect(() => {
    if (wire.current?.signature !== undefined && wire.current.signature !== graphSignature) cancelWire(true);
    else if (wire.current && disabled) cancelWire();
  }, [disabled, graphSignature]);
  useEffect(() => { refreshWire(); }, [zoom]);
  useEffect(()=>{
    setSearchOpen(false);setSearchQuery('');setSearchIndex(0);setSearchFocusKey(undefined);setPathFocus(false);
    return()=>{if(searchMoveFrame.current!==undefined)cancelAnimationFrame(searchMoveFrame.current);};
  },[workflow.id]);
  useEffect(()=>{setSearchIndex(current=>Math.max(0,Math.min(current,searchResults.length-1)));},[searchResults]);
  useEffect(()=>{if(searchFocusKey&&!visibleKeys.has(searchFocusKey))setSearchFocusKey(undefined);},[structure,searchFocusKey]);
  useEffect(()=>{
    const list=searchList.current,active=list?.querySelector<HTMLElement>(`[data-search-index="${searchIndex}"]`);
    if(!list||!active)return;
    if(active.offsetTop<list.scrollTop)list.scrollTop=active.offsetTop;
    else if(active.offsetTop+active.offsetHeight>list.scrollTop+list.clientHeight)list.scrollTop=active.offsetTop+active.offsetHeight-list.clientHeight;
  },[searchOpen,searchIndex,searchResults]);
  useEffect(()=>{
    if(!searchOpen)return;
    const frame=requestAnimationFrame(()=>searchInput.current?.focus());
    const outside=(event:globalThis.PointerEvent)=>{
      const target=event.target;
      if(target instanceof Node&&!searchPanel.current?.contains(target)&&!searchTrigger.current?.contains(target))setSearchOpen(false);
    };
    document.addEventListener('pointerdown',outside);
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside);};
  },[searchOpen]);

  useEffect(() => {
    if (drag.current) suppressClick.current = true;
    drag.current = undefined; setPreview(undefined);
    if (zoneDrag.current) suppressClick.current = true;
    zoneDrag.current = undefined; setZonePreview(undefined);
    if (pan.current) suppressBackgroundClick.current = true;
    pan.current = undefined; setPanning(false);
  }, [workflow.id, disabled, structure]);
  function reportViewport() {
    const element=viewport.current;
    if(element&&!restoringViewport.current)viewportCallback.current?.({scrollLeft:element.scrollLeft,scrollTop:element.scrollTop,zoom});
  }
  useEffect(() => {
    restoringViewport.current=true;
    const saved=initialViewport;
    const nextZoom=saved&&Number.isFinite(saved.zoom)?Math.max(.005,Math.min(1.5,saved.zoom)):1;
    setZoom(nextZoom);
    const frame=requestAnimationFrame(()=>{
      const element=viewport.current;
      if(element){
        element.scrollTop=saved&&Number.isFinite(saved.scrollTop)?Math.max(0,saved.scrollTop):Math.max(0,(positions.input.y+NODE_ICON_CENTER_Y+bounds.offsetY)*nextZoom-element.clientHeight/2);
        element.scrollLeft=saved&&Number.isFinite(saved.scrollLeft)?Math.max(0,saved.scrollLeft):Math.max(0,(positions.input.x+NODE_WIDTH/2+bounds.offsetX)*nextZoom-element.clientWidth/2);
        restoringViewport.current=false;
        viewportCallback.current?.({scrollLeft:element.scrollLeft,scrollTop:element.scrollTop,zoom:nextZoom});
      }
    });
    return()=>cancelAnimationFrame(frame);
  }, [workflow.id]);
  useEffect(()=>{reportViewport();},[zoom]);
  useEffect(()=>{
    const element=viewport.current;if(!element)return;
    const wheel=(event:WheelEvent)=>wheelZoomHandler.current(event);
    element.addEventListener('wheel',wheel,{passive:false});
    return()=>{element.removeEventListener('wheel',wheel);pendingZoomView.current=undefined;};
  },[workflow.id]);
  useEffect(()=>{
    if(lastAutoFit.current!==autoFitRequest){lastAutoFit.current=autoFitRequest;if(autoFitRequest)pendingFit.current=++viewCommand.current;}
    const command=pendingFit.current;
    if(command===undefined||command!==viewCommand.current)return;
    const mountedViewport=viewport.current;if(!mountedViewport)return;
    const element:HTMLDivElement=mountedViewport;
    let frame:number|undefined,disposed=false;
    fitActive.current=true;
    function scheduleFit(){
      if(disposed||!fitActive.current||command!==viewCommand.current)return;
      if(frame!==undefined)cancelAnimationFrame(frame);
      frame=requestAnimationFrame(()=>{
        if(disposed||!fitActive.current||command!==viewCommand.current)return;
        const current=fitLatest.current;
        if(current.workflowId!==workflow.id||element.clientWidth<=24||element.clientHeight<=24)return;
        const nextZoom=Math.max(.005,Math.min(1.25,(element.clientWidth-24)/current.bounds.width,(element.clientHeight-24)/current.bounds.height));
        setZoom(nextZoom);
        frame=requestAnimationFrame(()=>{
          if(disposed||!fitActive.current||command!==viewCommand.current)return;
          const latest=fitLatest.current;
          if(latest.workflowId!==workflow.id)return;
          element.scrollLeft=Math.max(0,(latest.bounds.width*nextZoom-element.clientWidth)/2);
          element.scrollTop=Math.max(0,(latest.bounds.height*nextZoom-element.clientHeight)/2);
          viewportCallback.current?.({scrollLeft:element.scrollLeft,scrollTop:element.scrollTop,zoom:nextZoom});
          frame=undefined;pendingFit.current=undefined;
          if(autoFitRequest)consumedFitCallback.current?.(autoFitRequest);
        });
      });
    }
    scheduleFit();
    // A fit is a single view command. Later panel and result changes must not
    // take ownership of the user's zoom or scroll position.
    return()=>{disposed=true;if(frame!==undefined)cancelAnimationFrame(frame);};
  },[autoFitRequest,fitRevision,workflow.id]);
  useEffect(()=>{
    if(!focusRequest)return;
    const key=endpointKey(focusRequest.stage,focusRequest.endpoint),position=visible[key];
    if(!position)return;
    const command=++viewCommand.current;fitActive.current=false;consumeAutoFit();
    const frame=requestAnimationFrame(()=>{
      const element=viewport.current;
      if(!element||command!==viewCommand.current)return;
      element.scrollLeft=Math.max(0,(position.x+NODE_WIDTH/2+bounds.offsetX)*zoom-element.clientWidth/2);
      element.scrollTop=Math.max(0,(position.y+NODE_HEIGHT/2+bounds.offsetY)*zoom-element.clientHeight/2);
      [...element.querySelectorAll<HTMLElement>('[data-layout-key]')].find(node=>node.dataset.layoutKey===key)?.focus({preventScroll:true});
      setAnnouncement(`${canvasEndpointLabel(focusRequest.stage,focusRequest.endpoint)} 위치로 이동했습니다.`);reportViewport();
    });
    return()=>cancelAnimationFrame(frame);
  },[focusRequest?.requestId,workflow.id]);
  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (drag.current || zoneDrag.current || pan.current) { cancelDrag(); cancelZoneDrag(); cancelPan(); setAnnouncement('이동을 취소했습니다.'); }
      if (wire.current || linkSourceRef.current) { cancelWire(); setPendingLink(); setAnnouncement('연결을 취소했습니다.'); }
      if (policyWire.current || policySourceRef.current) { cancelPolicyWire(true); setAnnouncement('정책 연결을 취소했습니다.'); }
    };
    window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel);
  }, []);

  function groupKeys(node: CanvasNode) {
    return pickedKeys.includes(node.key) && pickedKeys.length > 1 ? pickedKeys : [node.key];
  }
  function closeSearch(returnFocus=false){setSearchOpen(false);if(returnFocus)searchTrigger.current?.focus();}
  function focusSearchResult(result:WorkflowSearchResult){
    rememberViewport();
    const command=++viewCommand.current;fitActive.current=false;consumeAutoFit();
    const node=nodes.find(candidate=>candidate.key===result.key),position=node&&visible[node.key];
    if(!node||!position){setAnnouncement('검색한 노드가 변경되었습니다. 다시 검색하세요.');return;}
    const nextZoom=Math.max(1,Math.min(1.5,zoom));
    setSearchFocusKey(node.key);setSearchOpen(false);setZoom(nextZoom);
    (onSearchSelect||onSelect)(node.kind==='rule'||node.kind==='group'||node.kind==='control'||node.kind==='policy-node'?{kind:node.kind,id:node.id}:{kind:node.kind});
    if(searchMoveFrame.current!==undefined)cancelAnimationFrame(searchMoveFrame.current);
    searchMoveFrame.current=requestAnimationFrame(()=>{
      const current=searchView.current,currentNode=current.nodes.find(candidate=>candidate.key===node.key),currentPosition=currentNode&&current.visible[currentNode.key];
      const element=viewport.current;if(!element||command!==viewCommand.current||current.workflowId!==workflow.id||!currentNode||!currentPosition){searchMoveFrame.current=undefined;return;}
      element.scrollLeft=Math.max(0,(currentPosition.x+NODE_WIDTH/2+current.bounds.offsetX)*nextZoom-element.clientWidth/2);
      element.scrollTop=Math.max(0,(currentPosition.y+NODE_HEIGHT/2+current.bounds.offsetY)*nextZoom-element.clientHeight/2);
      const modal=element.closest('.we-layout')?.querySelector('[aria-modal="true"]');
      if(!modal)[...element.querySelectorAll<HTMLElement>('[data-layout-key]')].find(target=>target.dataset.layoutKey===node.key)?.focus({preventScroll:true});
      viewportCallback.current?.({scrollLeft:element.scrollLeft,scrollTop:element.scrollTop,zoom:nextZoom});
      setAnnouncement(`${result.name} 노드로 이동했습니다.`);searchMoveFrame.current=undefined;
    });
  }
  function searchKeys(event:KeyboardEvent<HTMLInputElement>){
    event.stopPropagation();
    if(event.nativeEvent.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();closeSearch(true);return;}
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();if(searchResults.length)setSearchIndex(current=>(current+(event.key==='ArrowDown'?1:-1)+searchResults.length)%searchResults.length);return;
    }
    if(event.key==='Enter'){event.preventDefault();const result=searchResults[searchIndex];if(result)focusSearchResult(result);}
  }
  function toggleNode(key: string) {
    if (disabled || !onSelectedKeys) return;
    const next = pickedKeys.includes(key) ? pickedKeys.filter(item => item !== key) : [...pickedKeys, key];
    onSelectedKeys(next); setAnnouncement(`${next.length}개 노드를 선택했습니다.`);
  }
  function choose(node: CanvasNode) { onSelect(node.kind === 'rule' || node.kind === 'group' || node.kind === 'control' || node.kind === 'policy-node' ? { kind: node.kind, id: node.id } : { kind: node.kind }); }
  function activate(event: MouseEvent<HTMLButtonElement>, node: CanvasNode) {
    if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; return; }
    if (canPolicyConnect && policySourceRef.current) { connectPolicyNode(node); return; }
    if (canConnect && linkSourceRef.current) { connectNode(node); return; }
    if (!disabled && (selectionMode || event.shiftKey)) {
      if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
      toggleNode(node.key); return;
    }
    // Keyboard and assistive activation is independent of a prior pointer drag.
    if (event.detail === 0) { suppressClick.current = false; choose(node); return; }
    if (suppressClick.current) { suppressClick.current = false; return; }
    choose(node);
  }
  function cancelDrag() {
    if (drag.current) suppressClick.current = true;
    drag.current = undefined; setPreview(undefined);
  }
  function start(event: PointerEvent<HTMLButtonElement>, node: CanvasNode) {
    if (event.button !== 0) return;
    suppressClick.current = false;
    if (disabled || selectionMode || event.shiftKey || linkSourceRef.current || wire.current || policySourceRef.current || policyWire.current) return;
    drag.current = { pointerId: event.pointerId, key: node.key, keys: groupKeys(node), x: event.clientX, y: event.clientY, positions, scrollX: viewport.current?.scrollLeft || 0, scrollY: viewport.current?.scrollTop || 0, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function update(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || disabled) return;
    const x = event.clientX - current.x + (viewport.current?.scrollLeft || 0) - current.scrollX; const y = event.clientY - current.y + (viewport.current?.scrollTop || 0) - current.scrollY;
    if (!current.moved && Math.hypot(x, y) < 4) return;
    current.moved = true; suppressClick.current = true;
    setPreview(moveNodes(current.positions, current.keys, { x: x / zoom, y: y / zoom }));
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = undefined; setPreview(undefined);
    if (current.moved && !disabled) {
      const next = moveNodes(current.positions, current.keys, { x: (event.clientX - current.x + (viewport.current?.scrollLeft || 0) - current.scrollX) / zoom, y: (event.clientY - current.y + (viewport.current?.scrollTop || 0) - current.scrollY) / zoom });
      if (JSON.stringify(next) !== JSON.stringify(positions)) { onLayout(next); setAnnouncement('노드 위치를 변경했습니다. 저장하면 배치가 유지됩니다.'); }
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, node: CanvasNode) {
    if (disabled || linkSourceRef.current || wire.current || policySourceRef.current || policyWire.current || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    const next = moveNodes(positions, groupKeys(node), { x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0 });
    if (JSON.stringify(next) !== JSON.stringify(positions)) { onLayout(next); setAnnouncement(`노드 위치를 ${step}만큼 이동했습니다.`); }
  }
  function normalizedZones() {
    return (workflow.layout?.zones || []).map(zone => ({ ...structuredClone(zone), nodeKeys: [...new Set(zone.nodeKeys.map(key => visibleLayoutKey(workflow, key)).filter((key): key is string => Boolean(key)))] }));
  }
  function activateZone(event: MouseEvent<HTMLButtonElement>, id: string) {
    if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; return; }
    onSelect({ kind: 'zone', id });
  }
  function startZoneDrag(event: PointerEvent<HTMLButtonElement>, frame: CanvasZoneFrame, mode: 'move' | 'resize') {
    if (event.button !== 0 || disabled || wire.current) return;
    suppressClick.current = false;
    const zones = normalizedZones();
    if (mode === 'resize') {
      const zone = zones.find(item => item.id === frame.id);
      if (zone) { const right = frame.x + frame.width; const bottom = frame.y + frame.height; zone.x = Math.max(0, frame.x); zone.y = Math.max(0, frame.y); zone.width = Math.min(ZONE_SIZE_LIMIT, right - zone.x); zone.height = Math.min(ZONE_SIZE_LIMIT, bottom - zone.y); }
    }
    zoneDrag.current = { pointerId: event.pointerId, id: frame.id, x: event.clientX, y: event.clientY, scrollX: viewport.current?.scrollLeft || 0, scrollY: viewport.current?.scrollTop || 0, positions, zones, mode, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function zoneGesture(current: ZoneDrag, clientX: number, clientY: number) {
    const delta = { x: (clientX - current.x + (viewport.current?.scrollLeft || 0) - current.scrollX) / zoom, y: (clientY - current.y + (viewport.current?.scrollTop || 0) - current.scrollY) / zoom };
    if (current.mode === 'move') return moveZoneLayout(current.positions, current.zones, current.id, delta);
    const zones = structuredClone(current.zones); const zone = zones.find(item => item.id === current.id);
    if (zone) { zone.width = Math.max(ZONE_MIN_WIDTH, Math.min(ZONE_SIZE_LIMIT, Math.round(zone.width + delta.x))); zone.height = Math.max(ZONE_MIN_HEIGHT, Math.min(ZONE_SIZE_LIMIT, Math.round(zone.height + delta.y))); }
    return { positions: current.positions, zones };
  }
  function updateZoneDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = zoneDrag.current;
    if (!current || current.pointerId !== event.pointerId || disabled) return;
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) return;
    current.moved = true; suppressClick.current = true;
    const next = zoneGesture(current, event.clientX, event.clientY); setPreview(next.positions); setZonePreview(next.zones);
  }
  function finishZoneDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = zoneDrag.current; if (!current || current.pointerId !== event.pointerId) return;
    zoneDrag.current = undefined; setPreview(undefined); setZonePreview(undefined);
    if (current.moved && !disabled) { const next = zoneGesture(current, event.clientX, event.clientY); onLayout(next.positions, next.zones); setAnnouncement(current.mode === 'move' ? '영역과 포함된 노드 위치를 변경했습니다.' : '영역 크기를 변경했습니다.'); }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function cancelZoneDrag() {
    if (zoneDrag.current) suppressClick.current = true;
    zoneDrag.current = undefined; setPreview(undefined); setZonePreview(undefined);
  }
  function zoneKeyboard(event: KeyboardEvent<HTMLButtonElement>, frame: CanvasZoneFrame, resize = false) {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const step = event.shiftKey ? 40 : 10;
    const delta = { x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0 };
    if (!resize) { const next = moveZoneLayout(positions, normalizedZones(), frame.id, delta); onLayout(next.positions, next.zones); }
    else { const zones = normalizedZones(); const zone = zones.find(item => item.id === frame.id); if (zone) { const right = frame.x + frame.width; const bottom = frame.y + frame.height; zone.x = Math.max(0, frame.x); zone.y = Math.max(0, frame.y); zone.width = right - zone.x; zone.height = bottom - zone.y; zone.width = Math.max(ZONE_MIN_WIDTH, Math.min(ZONE_SIZE_LIMIT, zone.width + delta.x)); zone.height = Math.max(ZONE_MIN_HEIGHT, Math.min(ZONE_SIZE_LIMIT, zone.height + delta.y)); onLayout(positions, zones); } }
  }
  function emptyTarget(target: EventTarget | null) {
    return target instanceof Element && !target.closest('button,a,input,select,textarea,[role="button"],[data-layout-key],[data-edge-id],[data-connect-port]');
  }
  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || wire.current || !emptyTarget(event.target)) return;
    const element = viewport.current; if (!element) return;
    fitActive.current=false;
    suppressBackgroundClick.current = false;
    const native = event.pointerType === 'touch';
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollX: element.scrollLeft, scrollY: element.scrollTop, native, moved: false };
    if (!native) event.currentTarget.setPointerCapture(event.pointerId);
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    const current = pan.current; const element = viewport.current;
    if (!current || current.pointerId !== event.pointerId || !element) return;
    const x = event.clientX - current.x; const y = event.clientY - current.y;
    if (!current.moved && Math.hypot(x, y) < 4) return;
    current.moved = true; suppressBackgroundClick.current = true;
    if (!current.native) { element.scrollLeft = current.scrollX - x; element.scrollTop = current.scrollY - y; setPanning(true); }
  }
  function finishPan(event: PointerEvent<HTMLDivElement>) {
    const current = pan.current;
    if (!current || current.pointerId !== event.pointerId) return;
    pan.current = undefined; setPanning(false);
    if (current.moved) suppressBackgroundClick.current = true;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function cancelPan() {
    if (pan.current) suppressBackgroundClick.current = true;
    pan.current = undefined; setPanning(false);
  }
  function activateBackground(event: MouseEvent<HTMLDivElement>) {
    if (!emptyTarget(event.target)) return;
    if (suppressBackgroundClick.current) { suppressBackgroundClick.current = false; return; }
    onBackgroundSelect?.();
  }
  function consumeAutoFit() {pendingFit.current=undefined;pendingZoomView.current=undefined;if(autoFitRequest)consumedFitCallback.current?.(autoFitRequest);}
  function rememberViewport() {
    const element=viewport.current;if(!element)return;
    previousViewport.current=pendingZoomView.current??{scrollLeft:element.scrollLeft,scrollTop:element.scrollTop,zoom:zoomValue.current};setCanRestoreViewport(true);
  }
  function handleCanvasWheel(event:WheelEvent) {
    if(event.defaultPrevented||!(event.ctrlKey||event.metaKey)||!Number.isFinite(event.deltaY)||event.deltaY===0)return;
    if(event.target instanceof Element&&event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
    const element=viewport.current;if(!element)return;
    // Ctrl+wheel is also the browser's trackpad pinch gesture. Only the canvas
    // consumes it; normal wheel scrolling and the rest of the page stay native.
    event.preventDefault();
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?element.clientHeight:1);
    const current=pendingZoomView.current?.zoom??zoomValue.current;
    setViewZoom(Math.max(.005,Math.min(1.5,current*Math.exp(-Math.max(-1000,Math.min(1000,delta))*.0015))),{clientX:event.clientX,clientY:event.clientY});
  }
  function setViewZoom(requestedZoom:number,anchor?:{clientX:number;clientY:number}) {
    const element=viewport.current;if(!element)return;
    const current=pendingZoomView.current??{zoom:zoomValue.current,scrollLeft:element.scrollLeft,scrollTop:element.scrollTop};
    const nextZoom=Math.max(.005,Math.min(1.5,requestedZoom));
    if(!Number.isFinite(nextZoom)||nextZoom===current.zoom)return;
    rememberViewport();const command=++viewCommand.current;fitActive.current=false;consumeAutoFit();
    const box=anchor?element.getBoundingClientRect():undefined;
    const point={x:anchor&&box?Math.max(0,Math.min(element.clientWidth,anchor.clientX-box.left-element.clientLeft)):element.clientWidth/2,
      y:anchor&&box?Math.max(0,Math.min(element.clientHeight,anchor.clientY-box.top-element.clientTop)):element.clientHeight/2};
    const center={x:(current.scrollLeft+point.x)/current.zoom,y:(current.scrollTop+point.y)/current.zoom};
    const next={zoom:nextZoom,
      scrollLeft:Math.max(0,Math.min(Math.max(0,bounds.width*nextZoom-element.clientWidth),center.x*nextZoom-point.x)),
      scrollTop:Math.max(0,Math.min(Math.max(0,bounds.height*nextZoom-element.clientHeight),center.y*nextZoom-point.y))};
    pendingZoomView.current=next;zoomValue.current=nextZoom;setZoom(nextZoom);
    if(searchMoveFrame.current!==undefined)cancelAnimationFrame(searchMoveFrame.current);
    searchMoveFrame.current=requestAnimationFrame(()=>{
      if(command!==viewCommand.current)return;
      element.scrollLeft=next.scrollLeft;element.scrollTop=next.scrollTop;pendingZoomView.current=undefined;
      viewportCallback.current?.({scrollLeft:element.scrollLeft,scrollTop:element.scrollTop,zoom:nextZoom});searchMoveFrame.current=undefined;
    });
  }
  function restoreView() {
    const saved=previousViewport.current,element=viewport.current;if(!saved||!element)return;
    const command=++viewCommand.current;fitActive.current=false;consumeAutoFit();setZoom(saved.zoom);setCanRestoreViewport(false);previousViewport.current=undefined;
    if(searchMoveFrame.current!==undefined)cancelAnimationFrame(searchMoveFrame.current);
    searchMoveFrame.current=requestAnimationFrame(()=>{
      if(command!==viewCommand.current)return;
      element.scrollLeft=saved.scrollLeft;element.scrollTop=saved.scrollTop;viewportCallback.current?.({...saved});searchMoveFrame.current=undefined;
    });
    setAnnouncement('이전 화면 위치와 확대율로 돌아왔습니다.');
  }
  function focusSelectedNode() {
    const result=searchWorkflowNodes(workflow,connections,'').find(item=>nodes.some(node=>node.key===item.key&&selected(node,selection)));
    if(result)focusSearchResult(result);
  }
  function fit() {rememberViewport();pendingZoomView.current=undefined;pendingFit.current=++viewCommand.current;setFitRevision(value=>value+1);}
  function arrange() {
    if (disabled) return;
    const element=viewport.current;
    const next = autoLayout(workflow,{width:element?.clientWidth,height:element?.clientHeight});
    const arrangedWorkflow = { ...workflow, layout: { version: 1 as const, positions: next, zones: workflow.layout?.zones } };
    const zones = normalizedZones().map(zone => {
      if (!zone.nodeKeys.length) return zone;
      const fitted = createZoneForNodes(arrangedWorkflow, zone.nodeKeys, { id: zone.id, name: zone.name, color: zone.color });
      return { ...zone, x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height };
    });
    onLayout(next, zones);fit();setAnnouncement('전체 흐름이 보이도록 노드와 영역을 자동 정렬했습니다.');
  }
  function endpointKey(stage: 'pre' | 'post', endpoint: string) {
    if (endpoint === 'start') return stage === 'pre' ? 'input' : 'main';
    if (endpoint === 'end') return stage === 'pre' ? workflow.policyRouting ? 'policy' : 'main' : 'output';
    return executionEndpointKey(workflow, stage, endpoint) || endpoint;
  }
  function canvasEndpointLabel(stage: 'pre' | 'post', endpoint: string) {
    if(endpoint==='start')return stage==='pre'?'최초 입력':'응답 생성 모델';
    if(endpoint==='end')return stage==='pre'?workflow.policyRouting?.policy.name || '응답 생성 모델':'최종 출력';
    const group = endpoint.startsWith('group:') ? workflow[stage].find(item => item.id === endpoint.slice(6)) : undefined;
    return group?.rules.length === 1 ? group.rules[0].name : endpointLabel(workflow, stage, endpoint);
  }
  const knownKeys = new Set(nodes.map(node => node.key));
  const edges: CanvasEdge[] = getWorkflowCanvasLinks(workflow).filter(edge=>knownKeys.has(edge.from)&&knownKeys.has(edge.to)).map(edge=>({...edge,kind:edge.id.startsWith('policy:')?'policy':'flow',port:edge.port||'next'}));
  if (retry) for (const group of workflow.post) edges.push({ from: endpointKey('post', `group:${group.id}`), to: 'main', kind: 'retry' });
  const insertionPoints = new Map<string, { x: number; y: number } | undefined>();
  function connectionKey(stage: 'pre' | 'post', endpoint: string, role: 'left' | 'right', preferred?:string) {
    let key = endpointKey(stage, endpoint);
    if(role==='right'&&endpoint.startsWith('group:')){const scope=policyChecks.find(scope=>scope.rule?.enabled!==false&&scope.stage===stage&&`group:${scope.group?.id}`===endpoint);if(scope){const action=scope.routing.graph?.nodes.find(node=>node.kind==='action'&&node.action==='main');if(preferred&&visible[preferred])key=preferred;else if(action)key=`policy-node:${policyScopedId(scope.id,action.id)}`;}}
    return key;
  }
  function portShape(key:string):CanvasPortShape {
    const node=nodes.find(node=>node.key===key);
    if(!node)return 'circle';
    if(node.kind==='input'||node.kind==='output'||node.kind==='group')return 'square';
    if(node.kind==='main'||node.kind==='policy')return 'hexagon';
    if(node.kind==='policy-node')return workflowPolicyNode(workflow,node.id)?.node.kind==='action'?'circle':'diamond';
    if(node.kind==='control')return stageGraphs[node.stage!].nodes.find(control=>control.id===node.id)?.kind==='condition'?'diamond':'circle';
    const rule=node.stage?workflow[node.stage].find(group=>group.id===node.groupId)?.rules.find(rule=>rule.id===node.id):undefined;
    return rule?.kind==='policy'?'hexagon':'circle';
  }
  function anchorPoint(key:string,side:CanvasPortSide,port?:string) {
    return canvasPortPoint(visible[key],side,portShape(key),port==='true'||port==='false'?port:undefined);
  }
  function edgeSides(edge:CanvasEdge) {
    return facingPortSides(visible[edge.from],visible[edge.to]);
  }
  function portSides(key:string,role:'left'|'right',port?:string):CanvasPortSide[] {
    const related=edges.filter(edge=>edge.kind!=='retry'&&(role==='right'?edge.from===key&&(!port||edge.port===port):edge.to===key));
    const sides=related.map(edge=>role==='right'?edgeSides(edge).sourceSide:edgeSides(edge).targetSide);
    return sides.length?[...new Set(sides)]:[role];
  }
  function connectionPoint(stage: 'pre' | 'post', endpoint: string, role: 'left' | 'right', port: string = 'next', side?:CanvasPortSide) {
    const active=wire.current?.source??linkSource;
    const sourceActive=active?.stage===stage&&active.endpoint===endpoint;
    const key=connectionKey(stage,endpoint,role,sourceActive?active.policyNodeKey:undefined);
    const actualSide=side??(role==='right'&&sourceActive?active.side:undefined)??portSides(key,role,role==='right'?port:undefined)[0];
    return anchorPoint(key,actualSide,role==='right'?port:undefined);
  }
  function validSource(source: LinkSource) {
    const control = stageGraphs[source.stage].nodes.find(node => `control:${node.id}` === source.endpoint);
    const exists = source.endpoint === 'start' || workflow[source.stage].some(group => `group:${group.id}` === source.endpoint) || Boolean(control);
    return exists && (control?.kind === 'condition' ? source.port === 'true' || source.port === 'false' : source.port === 'next');
  }
  function checkConnection(source: LinkSource, target: string) {
    const key = JSON.stringify([source.stage, source.endpoint, source.port, target]);
    const cached = connectionPreviews.get(key);
    if (cached) return cached;
    const next = previewConnection(workflow, source.stage, source.endpoint, target, source.port); connectionPreviews.set(key, next); return next;
  }
  function chooseSource(source: LinkSource) {
    if (!canConnect || !validSource(source)) return;
    if (linkSourceRef.current?.stage === source.stage && linkSourceRef.current.endpoint === source.endpoint && linkSourceRef.current.port === source.port && linkSourceRef.current.side===source.side) { setPendingLink(); return; }
    cancelPolicyWire(true); setPendingLink(source);
    setAnnouncement(`${canvasEndpointLabel(source.stage, source.endpoint)}에서 연결할 대상을 선택하세요.`);
  }
  function chooseTarget(stage: 'pre' | 'post', target: string) {
    if (!canConnect || !onConnect) return;
    const source = linkSourceRef.current;
    const reject = (message: string) => { setAnnouncement(message); notify?.(message); };
    if (!source) { reject('출력 연결점을 먼저 선택하세요.'); return; }
    if (source.stage !== stage) { reject('요청 검사와 응답 검사는 서로 연결할 수 없습니다.'); return; }
    if (!validSource(source)) { setPendingLink(); reject('선택한 연결점이 변경되었습니다. 시작점을 다시 선택하세요.'); return; }
    // Commit intent is checked again even when its hover preview was cached.
    const check = previewConnection(workflow, stage, source.endpoint, target, source.port);
    if (!check.valid) { reject(check.reason || '이 경로로 연결할 수 없습니다.'); return; }
    try { onConnect(stage, source.endpoint, target, source.port); setPendingLink(); setAnnouncement(check.replace ? '기존 연결의 변경 내용을 확인하세요.' : '연결할 경로를 선택했습니다.'); }
    catch (error) { reject(error instanceof Error ? error.message : '연결을 추가하지 못했습니다.'); }
  }
  function targetEndpoint(node: CanvasNode, stage: 'pre' | 'post') {
    if (node.kind === 'policy') return stage === 'pre' ? 'end' : undefined;
    if (node.kind === 'main') return stage === 'pre' && !workflow.policyRouting ? 'end' : undefined;
    if (node.kind === 'output') return stage === 'post' ? 'end' : undefined;
    if (node.kind === 'input' || node.kind === 'policy-node' || node.stage !== stage) return undefined;
    return node.kind === 'control' ? `control:${node.id}` : `group:${node.groupId || node.id}`;
  }
  function targetCheck(node: CanvasNode, source: LinkSource) {
    const endpoint = targetEndpoint(node, source.stage);
    if (!endpoint) return { valid: false, reason: node.kind === 'input' ? '최초 입력에는 들어오는 연결을 만들 수 없습니다.' : '요청 흐름과 응답 흐름은 서로 연결할 수 없습니다.', endpoint };
    return { ...checkConnection(source, endpoint), endpoint };
  }
  function connectNode(node: CanvasNode) {
    const source = linkSourceRef.current; if (!source) return;
    const check = targetCheck(node, source);
    if (!check.endpoint || !check.valid) { const message = check.reason || '이 노드로 연결할 수 없습니다.'; setAnnouncement(message); notify?.(message); return; }
    chooseTarget(source.stage, check.endpoint);
  }
  function worldPoint(clientX: number, clientY: number) {
    const element = viewport.current;
    if (!element) return { x: 0, y: 0 };
    const box = element.getBoundingClientRect();
    return { x: (clientX - box.left - element.clientLeft + element.scrollLeft) / zoom - bounds.offsetX, y: (clientY - box.top - element.clientTop + element.scrollTop) / zoom - bounds.offsetY };
  }
  function policyPoint(key: string, role: 'left'|'right', port?: string, side?:CanvasPortSide) {
    const active=policyWire.current?.source??policySource;
    return anchorPoint(key,side??(active&&role==='right'&&`policy-node:${active.id}`===key&&active.port===port?active.side:undefined)??portSides(key,role,role==='right'?port:undefined)[0],role==='right'?port:undefined);
  }
  function policyPortLabel(id:string,port:string) {
    const node=workflowPolicyNode(workflow,id)?.node;
    return node?policyNodePorts(node).find(item=>item.port===port)?.label??'선택한 경로':'선택한 경로';
  }
  function canvasNodeName(key: string): string {
    if(key==='policy')return workflow.policyRouting?.policy.name || '정책 모델';
    if(key.startsWith('policy-node:'))return workflowPolicyNode(workflow,key.slice('policy-node:'.length))?.node.name || '정책 노드';
    if(key==='input')return '최초 입력';if(key==='output')return '최종 출력';if(key==='main')return '응답 생성 모델';
    const node=nodes.find(node=>node.key===key),group=node?.stage?workflow[node.stage].find(group=>group.id===node.groupId):undefined;
    return node?.kind==='rule'?group?.rules.find(rule=>rule.id===node.id)?.name || '검사':node?.kind==='control'&&node.stage?stageGraphs[node.stage].nodes.find(control=>control.id===node.id)?.name || '제어 노드':group?.name || key;
  }
  function cancelPolicyWire(clear=false) {
    policyWire.current=undefined;setPolicyWirePoint(undefined);
    if(clear){policySourceRef.current=undefined;setPolicySource(undefined);}
  }
  function validPolicySource(source:NonNullable<typeof policySource>){const node=workflowPolicyNode(workflow,source.id)?.node;return Boolean(node&&node.kind!=='switch'&&policyNodePorts(node).some(item=>item.port===source.port));}
  function pickPolicySource(source: NonNullable<typeof policySource>) {
    if(!canPolicyConnect||!validPolicySource(source))return;
    cancelWire(true);setPendingLink();
    if(policySourceRef.current?.id===source.id&&policySourceRef.current.port===source.port&&policySourceRef.current.side===source.side){cancelPolicyWire(true);return;}
    policySourceRef.current=source;setPolicySource(source);
    const node=workflowPolicyNode(workflow,source.id)?.node,label=node?policyNodePorts(node).find(item=>item.port===source.port)?.label:source.port;
    setAnnouncement(`${canvasNodeName(`policy-node:${source.id}`)}의 ${label} 경로에 연결할 정책 노드를 선택하세요.`);
  }
  function connectPolicyNode(node: CanvasNode, source=policySourceRef.current) {
    if(!canPolicyConnect||!onPolicyConnect||!source)return;
    const sourceContext=workflowPolicyNode(workflow,source.id),targetContext=node.kind==='policy-node'?workflowPolicyNode(workflow,node.id):undefined,from=sourceContext?.node,target=targetContext?.node;
    const valid=sourceContext?.scope.id===targetContext?.scope.id&&from&&from.kind!=='switch'&&target&&from.id!==target.id&&policyNodePorts(from).some(item=>item.port===source.port);
    if(!valid){setAnnouncement('분기의 출력 경로를 다른 분기 또는 액션에 연결하세요.');return;}
    try{onPolicyConnect(source.id,node.id,source.port);cancelPolicyWire(true);setAnnouncement('정책 경로를 연결했습니다. 저장 전 설정 점검을 확인하세요.');}
    catch(error){const message=error instanceof Error?error.message:'정책 경로를 연결하지 못했습니다.';setAnnouncement(message);notify?.(message);}
  }
  function startPolicyWire(event: PointerEvent<HTMLButtonElement>,source: NonNullable<typeof policySource>) {
    if(event.button!==0||!canPolicyConnect)return;
    event.stopPropagation();cancelWire(true);setPendingLink();suppressPolicyClick.current=false;
    policyWire.current={pointerId:event.pointerId,source,clientX:event.clientX,clientY:event.clientY,moved:false};event.currentTarget.setPointerCapture(event.pointerId);
  }
  function movePolicyWire(event: PointerEvent<HTMLButtonElement>) {
    const current=policyWire.current;if(!current||current.pointerId!==event.pointerId)return;
    if(Math.hypot(event.clientX-current.clientX,event.clientY-current.clientY)>4)current.moved=true;
    if(current.moved)setPolicyWirePoint(worldPoint(event.clientX,event.clientY));
  }
  function finishPolicyWire(event: PointerEvent<HTMLButtonElement>) {
    const current=policyWire.current;if(!current||current.pointerId!==event.pointerId)return;
    policyWire.current=undefined;setPolicyWirePoint(undefined);
    if(current.moved){suppressPolicyClick.current=true;const point=worldPoint(event.clientX,event.clientY);const candidates=nodes.filter(node=>node.kind==='policy-node'&&parsePolicyScopedId(node.id).ownerId===parsePolicyScopedId(current.source.id).ownerId&&node.id!==current.source.id&&point.x>=visible[node.key].x-10&&point.x<=visible[node.key].x+NODE_WIDTH+10&&point.y>=visible[node.key].y-10&&point.y<=visible[node.key].y+NODE_HEIGHT+10).sort((left,right)=>Math.hypot(point.x-visible[left.key].x,point.y-visible[left.key].y)-Math.hypot(point.x-visible[right.key].x,point.y-visible[right.key].y));if(candidates[0])connectPolicyNode(candidates[0],current.source);else if(onCreatePolicyFromPort){cancelPolicyWire(true);onCreatePolicyFromPort({from:current.source.id,port:current.source.port,position:point});}else setAnnouncement('정책 노드 위에 놓아 연결하세요.');}
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function portButtonGeometry(key:string,side:CanvasPortSide,size:number,port?:string) {
    const point=anchorPoint(key,side,port),branch=port==='true'||port==='false'?port:undefined;
    const area=canvasPortHitArea(point,side,size,branch);
    return {area,glyph:{position:'absolute' as const,left:point.x-area.left-4.5,top:point.y-area.top-4.5},label:{
      left:point.x-area.left+(side==='left'?-8:side==='right'?8:0),
      top:point.y-area.top+(side==='top'?-19:side==='bottom'?9:-6),
      transform:side==='left'?'translateX(-100%)':side==='top'||side==='bottom'?'translateX(-50%)':undefined,
    }};
  }
  function policyInputSides(key:string):CanvasPortSide[] {
    const source=policySource;
    return source&&visible[`policy-node:${source.id}`]
      ?[facingPortSides(visible[`policy-node:${source.id}`],visible[key]).targetSide]:portSides(key,'left');
  }
  function renderPolicyPorts() {
    if(!canPolicyConnect)return null;
    const hit=Math.max(28,28/zoom);
    return nodes.filter(node=>node.kind==='policy-node').flatMap(node=>{
      const context=workflowPolicyNode(workflow,node.id),definition=context?.node;if(!definition)return [];
      const input=policyInputSides(node.key).map(side=>{
        const geometry=portButtonGeometry(node.key,side,hit);
        return <button key={`${node.key}-in-${side}`} type="button" data-policy-connect-target={node.id} data-port-side={side} className="wc-graph-port target policy-port" style={{...geometry.area,pointerEvents:policySource?'auto':'none'}} tabIndex={policySource?0:-1} aria-disabled={!policySource} aria-label={`${definition.name} 정책 노드에 연결`} onClick={event=>{event.stopPropagation();connectPolicyNode(node);}}><span style={geometry.glyph}/></button>;
      });
      if(definition.kind==='action'){
        if(definition.action!=='main'||context?.scope.id==='policy'||context?.scope.rule?.enabled===false||!context?.scope.group||!canConnect)return input;
        const stage=context.scope.stage,endpoint=`group:${context.scope.group.id}`,port='next' as const;
        return [...input,...portSides(node.key,'right',port).map(side=>{
          const source={stage,endpoint,port,policyNodeKey:node.key,side},geometry=portButtonGeometry(node.key,side,hit),picked=linkSource?.stage===stage&&linkSource.endpoint===endpoint&&(!linkSource.side||linkSource.side===side);
          return <button key={`${node.key}-continue-${side}`} type="button" data-connect-port={`${stage}:${endpoint}:next`} data-port-side={side} className={`wc-graph-port source next ${picked?'picked':''}`} style={geometry.area} aria-label={`${definition.name}의 다음 검사 연결 시작`} aria-pressed={picked} onPointerDown={event=>startWire(event,source)} onPointerMove={moveWire} onPointerUp={finishWire} onPointerCancel={()=>cancelWire(true)} onLostPointerCapture={()=>cancelWire(true)} onClick={event=>{event.stopPropagation();if(suppressWireClick.current&&event.detail!==0){suppressWireClick.current=false;return;}chooseSource(source);}}><span style={geometry.glyph}/></button>;
        })];
      }
      if(definition.kind==='switch')return input;
      return [...input,...(['true','false'] as const).flatMap(port=>portSides(node.key,'right',port).map(side=>{
        const source={id:node.id,port,side},geometry=portButtonGeometry(node.key,side,hit,port),picked=policySource?.id===node.id&&policySource.port===port&&(!policySource.side||policySource.side===side);
        return <button key={`${node.key}-${port}-${side}`} type="button" data-policy-connect-port={`${node.id}:${port}`} data-port-side={side} className={`wc-graph-port source policy-port ${port} ${picked?'picked':''}`} aria-label={`${definition.name}의 ${port==='true'?'참':'거짓'} 정책 경로 연결 시작`} aria-pressed={picked} style={geometry.area} onPointerDown={event=>startPolicyWire(event,source)} onPointerMove={movePolicyWire} onPointerUp={finishPolicyWire} onPointerCancel={()=>cancelPolicyWire(true)} onLostPointerCapture={()=>cancelPolicyWire()} onClick={event=>{event.stopPropagation();if(suppressPolicyClick.current&&event.detail!==0){suppressPolicyClick.current=false;return;}pickPolicySource(source);}}><span style={geometry.glyph}/><small style={geometry.label}>{port==='true'?'참':'거짓'}</small></button>;
      }))];
    });
  }
  function wireTarget(source: LinkSource, point: { x: number; y: number }): WirePreview {
    const sourceKey=connectionKey(source.stage,source.endpoint,'right',source.policyNodeKey);
    const candidates = nodes.map(node => {
      const position = visible[node.key]; const side=facingPortSides(visible[sourceKey],position).targetSide;const port = anchorPoint(node.key,side);
      const distance = Math.hypot(point.x - port.x, point.y - port.y);
      const inside = point.x >= position.x - 6 && point.x <= position.x + NODE_WIDTH + 6 && point.y >= position.y - 8 && point.y <= position.y + NODE_HEIGHT + 4;
      return { node, port, distance, inside };
    }).filter(item => item.inside || item.distance <= 28).sort((a, b) => a.distance - b.distance);
    const candidate = candidates[0];
    if (!candidate) return { source, point, valid: false };
    const check = targetCheck(candidate.node, source);
    return { source, point: check.valid ? candidate.port : point, targetKey: candidate.node.key, target: check.endpoint, reason: check.reason, valid: check.valid };
  }
  function startWire(event: PointerEvent<HTMLButtonElement>, source: LinkSource) {
    if (event.button !== 0 || !canConnect || !validSource(source) || drag.current || zoneDrag.current || pan.current) return;
    event.preventDefault(); event.stopPropagation(); cancelPolicyWire(true); suppressWireClick.current = false;
    wire.current = { pointerId: event.pointerId, source, x: event.clientX, y: event.clientY, clientX: event.clientX, clientY: event.clientY, moved: false, signature: graphSignature };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveWire(event: PointerEvent<HTMLButtonElement>) {
    const current = wire.current;
    if (!current || current.pointerId !== event.pointerId || !canConnect) return;
    event.stopPropagation(); current.clientX = event.clientX; current.clientY = event.clientY;
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) return;
    current.moved = true; suppressWireClick.current = true; suppressClick.current = true; suppressBackgroundClick.current = true; setPendingLink(current.source);
    const next = wireTarget(current.source, worldPoint(event.clientX, event.clientY)); setWirePreview(next);
  }
  function dropSurface(clientX:number,clientY:number){
    const element=viewport.current;if(!element)return undefined;
    const box=element.getBoundingClientRect();
    if(clientX<box.left+element.clientLeft||clientY<box.top+element.clientTop||clientX>=box.left+element.clientLeft+element.clientWidth||clientY>=box.top+element.clientTop+element.clientHeight)return undefined;
    // Pointer capture keeps event.target on the source port. Hit-test the real
    // surface so an overlay, edge control, or invalid nearby node is not empty.
    const target=document.elementFromPoint(clientX,clientY);
    return target&&element.contains(target)?target:undefined;
  }
  function emptyDropPoint(clientX:number,clientY:number){const target=dropSurface(clientX,clientY);return Boolean(target&&emptyTarget(target));}
  function finishWire(event: PointerEvent<HTMLButtonElement>) {
    const current = wire.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation(); wire.current = undefined; setWirePreview(undefined);
    if (current.moved) {
      suppressWireClick.current = true;
      if (canConnect && current.signature === graphSignature && validSource(current.source)) {
        setPendingLink(current.source);
        const target = wireTarget(current.source, worldPoint(event.clientX, event.clientY));
        if (!dropSurface(event.clientX,event.clientY)) {setAnnouncement('캔버스 안의 노드나 빈 공간에 놓으세요.');}
        else if (target.valid && target.target) chooseTarget(current.source.stage, target.target);
        else if (!target.targetKey && !target.reason && onCreateFromPort && emptyDropPoint(event.clientX,event.clientY)) {
          const point=worldPoint(event.clientX,event.clientY);
          setPendingLink();
          try{onCreateFromPort({stage:current.source.stage,from:current.source.endpoint,port:current.source.port,position:{x:Math.max(0,Math.min(40000,Math.round(point.x-NODE_WIDTH/2))),y:Math.max(0,Math.min(40000,Math.round(point.y-NODE_ICON_CENTER_Y)))}});setAnnouncement('새 노드를 추가할 방법을 선택하세요.');}
          catch(error){const message=error instanceof Error?error.message:'새 노드를 준비하지 못했습니다. 연결점을 다시 선택하세요.';setAnnouncement(message);notify?.(message);}
        } else { const message = target.reason || '연결할 노드를 선택하거나 빈 공간에 놓아 노드를 추가하세요. Esc로 취소할 수 있습니다.'; setAnnouncement(message); if (target.reason) notify?.(message); }
      } else { if (current.signature !== graphSignature || readOnly) setPendingLink(); setAnnouncement('흐름이 변경되어 연결 드래그를 취소했습니다.'); }
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function cancelWire(clearPending = false) {
    if (wire.current) { suppressWireClick.current = true; suppressClick.current = true; suppressBackgroundClick.current = true; if (clearPending) setPendingLink(); }
    wire.current = undefined; setWirePreview(undefined);
  }
  function refreshWire() {
    const current = wire.current;
    if (current?.moved && canConnect) setWirePreview(wireTarget(current.source, worldPoint(current.clientX, current.clientY)));
  }
  function renderConnectionPorts() {
    if (!canConnect) return null;
    const hitSize=Math.max(28,28/zoom);
    return (['pre', 'post'] as const).flatMap(stage => {
      const endpoints = ['start', ...workflow[stage].map(group => `group:${group.id}`), ...stageGraphs[stage].nodes.map(node => `control:${node.id}`), 'end'];
      return endpoints.flatMap(endpoint => {
        if (!knownKeys.has(endpointKey(stage, endpoint))) return [];
        const label = canvasEndpointLabel(stage, endpoint),key=connectionKey(stage,endpoint,'left');
        const control = stageGraphs[stage].nodes.find(node => `control:${node.id}` === endpoint);
        const outputs: ('next' | 'true' | 'false')[] = control?.kind === 'condition' ? ['true', 'false'] : ['next'];
        const activeSource = wirePreview?.source || linkSource;
        const check = activeSource ? activeSource.stage === stage ? checkConnection(activeSource, endpoint) : { valid: false, reason: '요청 흐름과 응답 흐름은 서로 연결할 수 없습니다.' } : undefined;
        const activeKey=activeSource?connectionKey(activeSource.stage,activeSource.endpoint,'right',activeSource.policyNodeKey):undefined;
        const inputSides=activeKey&&visible[activeKey]?[facingPortSides(visible[activeKey],visible[key]).targetSide]:portSides(key,'left');
        const input = endpoint === 'start' ? [] : inputSides.map(side=>{
          const geometry=portButtonGeometry(key,side,hitSize);
          return <button key={`${stage}-${endpoint}-in-${side}`} type="button" data-connect-port={`${stage}:${endpoint}:in`} data-port-side={side} className={`wc-graph-port target ${check ? check.valid ? 'available' : 'unavailable' : ''} ${wirePreview?.valid && wirePreview.target === endpoint && wirePreview.source.stage === stage ? 'snapped' : ''}`} style={{...geometry.area,pointerEvents:activeSource?'auto':'none'}} tabIndex={activeSource?0:-1} aria-label={`${label}에 연결${check?.reason ? `: ${check.reason}` : ''}`} aria-disabled={!activeSource||check?.valid === false} title={check?.reason || `${label}에 연결`} onClick={event => { event.stopPropagation(); chooseTarget(stage, endpoint); }}><span style={geometry.glyph}/></button>;
        });
        const policyGroup=endpoint.startsWith('group:')?workflow[stage].find(group=>`group:${group.id}`===endpoint&&group.rules.length===1&&group.rules[0].kind==='policy'&&group.rules[0].enabled):undefined;
        const output = endpoint === 'end'||policyGroup ? [] : outputs.flatMap(port => portSides(key,'right',port).map(side=>{
          const geometry=portButtonGeometry(key,side,hitSize,port);
          const picked = linkSource?.stage === stage && linkSource.endpoint === endpoint && linkSource.port === port&&(!linkSource.side||linkSource.side===side);
          const portName = port === 'true' ? '참' : port === 'false' ? '거짓' : '다음';
          const source = { stage, endpoint, port, side };
          return <button key={`${stage}-${endpoint}-${port}-${side}`} type="button" data-connect-port={`${stage}:${endpoint}:${port}`} data-port-side={side} className={`wc-graph-port source ${port} ${picked ? 'picked' : ''}`} style={geometry.area} aria-label={`${label}의 ${portName} 경로 연결 시작. 끌어서 노드에 연결하거나 빈 공간에 놓아 새 노드를 추가하세요. 선택 후 대상 노드를 선택할 수도 있습니다.`} aria-pressed={picked} title={`${label}의 ${portName} 경로 연결. 노드에 놓아 연결하거나 빈 공간에 놓아 새 노드를 추가합니다.`} onPointerDown={event => startWire(event, source)} onPointerMove={moveWire} onPointerUp={finishWire} onPointerCancel={() => cancelWire(true)} onLostPointerCapture={() => cancelWire(true)} onClick={event => { event.stopPropagation(); if (suppressWireClick.current && event.detail !== 0) { suppressWireClick.current = false; return; } suppressWireClick.current = false; chooseSource(source); }}><span style={geometry.glyph}/>{port !== 'next' && <small style={geometry.label}>{portName}</small>}</button>;
        }));
        return [...input, ...output];
      });
    });
  }
  function route(edge: CanvasEdge) {
    const {sourceSide,targetSide}=edgeSides(edge);
    const start=anchorPoint(edge.from,sourceSide,edge.port);
    const target=anchorPoint(edge.to,targetSide);
    const end=offsetPortPoint(target,targetSide,8);
    const switchSource=edge.policyEdgeId&&edge.from.startsWith('policy-node:')&&workflowPolicyNode(workflow,edge.from.slice('policy-node:'.length))?.node.kind==='switch';
    const siblings=switchSource?edges.filter(item=>item.policyEdgeId&&item.from===edge.from&&item.to===edge.to):[];
    return routeWorkflowEdge({
      start,end,sourceSide,targetSide,sourceKey:edge.from,targetKey:edge.to,
      obstacles:nodes.map(node=>({...visible[node.key],width:NODE_WIDTH,height:NODE_HEIGHT,key:node.key})),
      parallelIndex:Math.max(0,siblings.findIndex(item=>item.policyEdgeId===edge.policyEdgeId)),parallelCount:siblings.length,
      preferredSide:edge.kind==='retry'||edge.port==='false'?'below':'above',minY:8-bounds.offsetY,
      forceOutside:edge.kind==='retry',
    });
  }
  function edgeLabelPosition(edge:CanvasEdge) {
    const {sourceSide}=edgeSides(edge),point=offsetPortPoint(anchorPoint(edge.from,sourceSide,edge.port),sourceSide,20);
    return {x:point.x,y:point.y+(sourceSide==='left'||sourceSide==='right'?-6:sourceSide==='top'?-4:8),textAnchor:sourceSide==='left'?'end' as const:sourceSide==='right'?'start' as const:'middle' as const};
  }
  function wirePath(sourceKey:string,side:CanvasPortSide,start:{x:number;y:number},end:{x:number;y:number},targetKey?:string) {
    const targetSide=facingPortSides(visible[sourceKey],targetKey&&visible[targetKey]?visible[targetKey]:{x:end.x-NODE_WIDTH/2,y:end.y-NODE_ICON_CENTER_Y}).targetSide;
    return routeWorkflowEdge({start,end,sourceSide:side,targetSide,sourceKey,targetKey:targetKey??'__wire_cursor__',obstacles:nodes.map(node=>({...visible[node.key],width:NODE_WIDTH,height:NODE_HEIGHT,key:node.key})),minY:8-bounds.offsetY}).d;
  }
  function edgeInsertPoint(edge: CanvasEdge) {
    const key = `${edge.stage}:${edge.graphId}`;
    if (insertionPoints.has(key)) return insertionPoints.get(key);
    const points = route(edge).points;
    const segments = points.slice(1).map((point, index) => ({ from: points[index], to: point, length: Math.hypot(point.x - points[index].x, point.y - points[index].y) }));
    const length = segments.reduce((sum, segment) => sum + segment.length, 0);
    for (const fraction of [.5, .45, .55, .4, .6, .35, .65, .3, .7, .25, .75, .2, .8]) {
      let remaining = length * fraction;
      let point = points[0];
      for (const segment of segments) {
        if (remaining <= segment.length) { const ratio = segment.length ? remaining / segment.length : 0; point = { x: segment.from.x + (segment.to.x - segment.from.x) * ratio, y: segment.from.y + (segment.to.y - segment.from.y) * ratio }; break; }
        remaining -= segment.length;
      }
      const avoidsNodes = nodes.every(node => { const position = visible[node.key]; return point.x < position.x - 13 || point.x > position.x + NODE_WIDTH + 13 || point.y < position.y - 13 || point.y > position.y + NODE_HEIGHT + 13; });
      const avoidsButtons = [...insertionPoints.values()].every(other => !other || Math.hypot(point.x - other.x, point.y - other.y) >= 26);
      const avoidsBranchLabels = edges.every(other => {
        if (!other.stage || !other.graphFrom || !['true', 'false'].includes(other.port || '')) return true;
        const label=edgeLabelPosition(other);
        return Math.abs(point.x-label.x)>36||Math.abs(point.y-label.y)>24;
      });
      if (avoidsNodes && avoidsButtons && avoidsBranchLabels) { insertionPoints.set(key, point); return point; }
    }
    // Keep exactly one add action even in a crowded or reversed layout.
    const side=edgeSides(edge).sourceSide,source=anchorPoint(edge.from,side,edge.port);
    const fallback=offsetPortPoint(source,side,24);
    insertionPoints.set(key,fallback);
    return fallback;
  }
  function insertAt(edge: CanvasEdge, point?: { x: number; y: number }) {
    if (disabled || readOnly || !onInsertNode || !edge.stage || !edge.graphId) return;
    try { const target = captureInsertTarget(workflow, edge.stage, edge.graphId); onInsertNode(target, point ? { x: Math.max(0, Math.min(40000, Math.round(point.x - NODE_WIDTH / 2))), y: Math.max(0, Math.min(40000, Math.round(point.y - NODE_ICON_CENTER_Y))) } : undefined); }
    catch (error) { const message = error instanceof Error ? error.message : '경로가 변경되었습니다. 다시 선택하세요.'; setAnnouncement(message); notify?.(message); }
  }
  function renderEdge(edge: CanvasEdge, index: number) {
    const line = route(edge);
    const state:CanvasExecutionState=edge.kind==='retry'?stale&&executionView.hasExecution?'stale':executionView.retryNodes.has(edge.from)?executionView.nodes.main==='running'?'running':'completed':executionView.hasExecution?'skipped':'idle':executionView.edges[edge.id||`${edge.stage}:${edge.graphId}`]||'idle';
    const seen = state==='completed'||state==='running'||state==='block'||state==='error';
    const branch = edge.port === 'true' ? '참' : edge.port === 'false' ? '거짓' : '';
    const edgeSource=edge.policyEdgeId&&edge.from.startsWith('policy-node:')?workflowPolicyNode(workflow,edge.from.slice('policy-node:'.length))?.node:undefined;
    const switchNode=edgeSource?.kind==='switch'?edgeSource:undefined;
    const edgeSelected=Boolean(edge.policyEdgeId&&edge.policyEdgeId===selectedPolicyEdgeId);
    const showBranchLabel=Boolean(edge.label||branch)&&(!switchNode||edgeSelected);
    const description = edge.kind==='policy'?`${canvasNodeName(edge.from)}에서 ${canvasNodeName(edge.to)}로${edge.label?` ${edge.label} 경로`:''}`:edge.stage && edge.graphFrom && edge.graphTo ? `${canvasEndpointLabel(edge.stage, edge.graphFrom)}에서 ${canvasEndpointLabel(edge.stage, edge.graphTo)}로${branch ? ` ${branch} 경로` : ''}` : edge.kind === 'retry' ? `단계 차단 조건에 해당하면 최대 ${maxRetries}회 재작성` : edge.kind === 'fork' ? '같은 입력을 각 검사에서 병렬로 확인' : '병렬 검사 결과를 모아 단계 차단 조건으로 판단';
    const edit = () => { if(edge.policyEdgeId&&onSelectPolicyEdge)onSelectPolicyEdge(edge.policyEdgeId);else if(edge.graphId&&edge.stage&&onSelectEdge)onSelectEdge(edge.stage,edge.graphId);else if(edge.kind==='policy')onSelect(edge.from.startsWith('policy-node:')?{kind:'policy-node',id:edge.from.slice('policy-node:'.length)}:edge.from.startsWith('rule:')?{kind:'rule',id:edge.from.slice(5)}:{kind:'policy'});else if (edge.stage && edge.graphId) onSelectEdge?.(edge.stage, edge.graphId); };
    const editable=Boolean(edge.kind==='policy'||edge.graphId&&edge.stage&&onSelectEdge);
    const insertion = !disabled && !readOnly && onInsertNode && edge.kind === 'flow' && edge.stage && edge.graphId ? edgeInsertPoint(edge) : undefined;
    const parallelSwitch=switchNode&&edges.filter(item=>item.policyEdgeId&&item.from===edge.from&&item.to===edge.to).length>1;
    const edgeHitWidth=parallelSwitch?Math.min(28,Math.max(12,16/zoom)):Math.max(12,16/zoom);
    const removing=connectionImpact&&connectionImpact.stage===edge.stage&&connectionImpact.removedEdges.some(item=>item.id===edge.graphId&&item.from===edge.graphFrom&&item.to===edge.graphTo);
    const dimmed=focusedPath&&(edge.kind==='retry'?!focusedPath.nodes.has(edge.from):!focusedPath.edges.has(edge.id||`${edge.stage}:${edge.graphId}`));
    return <g key={edge.id||`${edge.stage || ''}-${edge.graphId || index}-${edge.from}-${edge.to}`} data-from={edge.from} data-to={edge.to} data-stage={edge.stage} data-source-side={edgeSides(edge).sourceSide} data-target-side={edgeSides(edge).targetSide} data-edge-id={edge.graphId||edge.policyEdgeId} data-policy-edge-id={edge.policyEdgeId} data-link-id={edge.id} data-port={edge.port} data-execution-state={state} data-impact={removing?'removed':undefined} className={`wc-connection ${edge.kind} ${seen ? 'executed' : ''} ${removing?'impact-removed':''} ${dimmed?'path-dimmed':''} ${edgeSelected?'selected':''}`}>
      {edgeSelected&&<path className="wc-edge-selection" d={line.d} aria-hidden="true"/>}
      <path className={`wc-edge ${edge.kind}`} d={line.d} markerEnd={`url(#${markerId}-${state})`}><title>{`${description}${executionView.hasExecution?` / ${canvasExecutionLabels[state]}`:''}`}</title></path>
      {editable && <path className="wc-edge-hit" d={line.d} style={{strokeWidth:edgeHitWidth}} role="button" tabIndex={0} aria-pressed={edge.policyEdgeId?edgeSelected:undefined} aria-label={`${description} 연결 설정`} onClick={event => { event.stopPropagation(); edit(); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); edit(); } }} />}
      {showBranchLabel && <text className={`wc-branch-label ${edge.port}`} {...edgeLabelPosition(edge)}>{edge.label||branch}</text>}
      {edge.kind === 'flow' && <circle className="wc-port" cx={line.sx} cy={line.sy} r={2.5} />}
      {insertion && <g className="wc-edge-add" role="button" tabIndex={0} data-insert-edge={`${edge.stage}:${edge.graphId}`} transform={`translate(${insertion.x} ${insertion.y})`} aria-label={`${description} 사이에 검사 추가`} onClick={event => { event.stopPropagation(); insertAt(edge, insertion); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); insertAt(edge, insertion); } }}><title>이 경로에 검사 추가</title><circle className="wc-edge-add-hit" r={Math.max(14,14/zoom)} /><circle className="wc-edge-add-face" r="10" /><path d="M -3.5 0 H 3.5 M 0 -3.5 V 3.5" /></g>}
    </g>;
  }
  function renderImpactEdges() {
    if(!connectionImpact)return null;
    const stage=connectionImpact.stage;
    return connectionImpact.addedEdges.map(edge=>{
      const from=endpointKey(stage,edge.from),to=endpointKey(stage,edge.to);
      if(!visible[from]||!visible[to])return null;
      const line=route({from,to,kind:'flow',stage,graphFrom:edge.from,graphTo:edge.to,port:edge.port});
      return <g key={`impact-${stage}-${edge.id}`} className="wc-impact-added" data-impact="added" data-stage={stage} data-from={from} data-to={to} data-port={edge.port} aria-hidden="true"><path d={line.d} markerEnd={`url(#${markerId}-completed)`}><title>{canvasEndpointLabel(stage,edge.from)}에서 {canvasEndpointLabel(stage,edge.to)}로 추가할 연결</title></path></g>;
    });
  }
  function renderFrame(frame: CanvasZoneFrame) {
    const isSelected = selection?.kind === 'zone' && selection.id === frame.id;
    return <section key={frame.key} data-zone-id={frame.id} data-layout-key={frame.key} data-zone-color={frame.color} className={`wc-zone ${isSelected ? 'selected' : ''}`} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} aria-label={`${frame.name}, 표시용 영역, 노드 ${frame.nodeKeys.length}개`}>
      <button type="button" className="wc-zone-header" title="표시와 배치만 묶는 영역입니다. 실행 순서는 바뀌지 않습니다." aria-label={`${frame.name} 영역 설정, 방향키로 영역과 포함된 노드 함께 이동`} onClick={event => activateZone(event, frame.id)} onPointerDown={event => startZoneDrag(event, frame, 'move')} onPointerMove={updateZoneDrag} onPointerUp={finishZoneDrag} onPointerCancel={cancelZoneDrag} onLostPointerCapture={cancelZoneDrag} onKeyDown={event => zoneKeyboard(event, frame)}><span className="wc-zone-color" /><strong>{frame.name}</strong><small>{frame.nodeKeys.length}개 노드</small><Settings2 size={13} /></button>
      <button type="button" className="wc-zone-add" disabled={disabled || !onAddNode} onClick={() => onAddNode?.(frame.id)}><Plus size={12} /> 노드 추가</button>
      {!disabled && <button type="button" className="wc-zone-resize" aria-label={`${frame.name} 영역 크기 조정, 방향키로 조정`} title="영역 크기 조정" onPointerDown={event => startZoneDrag(event, frame, 'resize')} onPointerMove={updateZoneDrag} onPointerUp={finishZoneDrag} onPointerCancel={cancelZoneDrag} onLostPointerCapture={cancelZoneDrag} onKeyDown={event => zoneKeyboard(event, frame, true)}><span /></button>}
    </section>;
  }
  function renderNode(node: CanvasNode) {
    const group = node.stage ? workflow[node.stage].find(item => item.id === node.groupId) : undefined;
    const rule = group?.rules.find(item => item.id === node.id);
    const policyContext=node.kind==='policy-node'?workflowPolicyNode(workflow,node.id):undefined;
    const policyModel=node.kind==='policy'||rule?.kind==='policy';
    const policy=rule?.kind==='policy'?rule.config.policyRouting?.policy:workflow.policyRouting?.policy;
    const policyNode=policyContext?.node;
    const policyCondition=policyNode&&(policyNode.kind==='branch'||policyNode.kind==='rule')?policyNode.condition.predicates.map(predicate=>`${predicate.path||'출력 전체'} ${predicate.operator}`).join(policyNode.condition.mode==='all'?' 그리고 ':' 또는 '):'';
    const isPolicy=node.kind==='policy'||node.kind==='policy-node';
    const isPolicyCondition=Boolean(policyNode&&policyNode.kind!=='action');
    const isPolicySwitch=policyNode?.kind==='switch';
    const terminal = node.kind === 'input' || node.kind === 'output';
    const control = node.kind === 'control' && node.stage ? stageGraphs[node.stage].nodes.find(item => item.id === node.id) : undefined;
    const controlKind = control?.kind || node.controlKind;
    const kind = isPolicy ? node.kind==='policy'?'policy':isPolicySwitch?'policy-switch':isPolicyCondition?'policy-condition':'policy-action' : terminal ? node.kind : node.kind === 'main' ? 'main' : node.kind === 'group' ? 'composite' : controlKind || rule?.kind || 'keyword';
    const Icon = policyModel?ShieldCheck:isPolicySwitch?Split:isPolicyCondition?GitBranch:policyNode?.kind==='action'?Zap:node.kind === 'input' ? LogIn : node.kind === 'output' ? LogOut : node.kind === 'main' ? BrainCircuit : node.kind === 'group' ? Layers3 : controlKind === 'condition' ? GitBranch : controlKind === 'fork' ? Split : controlKind === 'join' ? Merge : icons[rule?.kind || 'keyword'];
    const title = policyModel?(rule?.name||policy?.name||'정책 모델'):policyNode?policyNode.name:node.kind === 'input' ? '최초 입력' : node.kind === 'output' ? '최종 출력' : node.kind === 'main' ? main ? connectionLabel(main.name) : '응답 모델 선택' : node.kind === 'group' ? group?.name || '검사 조합' : control?.name || rule?.name || '';
    const subtitle = policyModel?`${policy?.connectionSnapshot?.model||'정책 분류 모델'} / 고정 버전 ${policy?.version??1}`:policyNode?.kind==='action'?policyNode.action==='main'?(policyContext?.scope.id==='policy'?'Main LLM으로 응답 생성':'다음 검사 계속'):policyNode.action==='respond'?(policyNode.responseMode==='immediate'?'등록 응답을 즉시 최종 출력':'등록 응답을 POST 검사로 전달'):`오류 반환 ${policyNode.errorCode||''}`:policyNode?.kind==='switch'?`${policyNode.path||'필드를 선택하세요'} / 비교값 ${policyNode.cases.length}개와 기본 경로`:policyNode?policyCondition:node.kind === 'input' ? '요청 메시지와 대화 내용' : node.kind === 'output' ? '검사를 통과한 최종 응답 반환' : node.kind === 'main' ? main?.mode === 'demo' ? '예제 모드의 고정 응답' : main?.model || '모델 서버를 연결하세요' : node.kind === 'group' ? `검사 조합 ${group?.rules.length || 0}개, ${group?.mode === 'all' ? '모두 위반하면 차단' : '하나라도 위반하면 차단'}` : controlKind === 'condition' ? '조건에 따라 참과 거짓 경로 선택' : controlKind === 'fork' ? '연결한 경로를 병렬로 실행' : controlKind === 'join' ? '병렬 경로의 실행 결과 합류' : rule ? ruleKindLabels[rule.kind] : '';
    const traces = terminal ? undefined : execution?.traces.filter(trace => (isPolicy?trace.traceType==='policy'&&trace.ruleId===(node.kind==='policy'?'policy':`policy:${node.id}`):trace.traceType!=='policy'&&(node.kind === 'main' ? trace.stage === 'main' : trace.ruleId === node.id && trace.stage === node.stage))&&(trace.stage==='pre'||(trace.attempt??1)===executionView.postAttempt));
    const trace = traces?.at(-1);
    const executionState=executionView.nodes[node.key]||'idle';
    const status = executionView.hasExecution?executionState==='completed'?(node.kind==='output'?'반환 완료':node.kind==='main'?'생성 완료':'완료'):canvasExecutionLabels[executionState]:'';
    const statusTone = executionState==='completed'?'allow':executionState;
    const badge = rule && !rule.enabled ? { text: '꺼짐', tone: 'off' } : status ? { text: status, tone: statusTone } : policyModel?{text:`v${policy?.version??1}`,tone:'policy'}:node.kind === 'main' && main?.mode === 'demo' ? { text: '예제', tone: 'demo' } : node.kind === 'group' ? { text: '검사 조합', tone: 'composite' } : undefined;
    const position = visible[node.key];
    const pinned=workflow.layout?.pinnedKeys?.some(key=>visibleLayoutKey(workflow,key)===node.key);
    const membership = policyModel?(node.kind==='policy'?'정책 모델 설정':`${node.stage?stageLabels[node.stage]+' ':''}정책 모델 설정`):policyNode?isPolicySwitch?'Switch 분기 설정':isPolicyCondition?'조건 분기 설정':'정책 액션 설정':node.kind === 'input' ? '검사 시작점' : node.kind === 'output' ? '응답 반환점' : node.kind === 'main' ? '응답 생성' : node.kind === 'control' ? `${stageLabels[node.stage!]} 흐름` : `${stageLabels[node.stage!]} 검사`;
    const source = canConnect ? wirePreview?.source || linkSource : undefined;
    const isSource = source && endpointKey(source.stage, source.endpoint) === node.key;
    const target = source && !isSource ? targetCheck(node, source) : undefined;
    const policyOrigin=policySource?.id===node.id&&node.kind==='policy-node';
    const policyFrom=policySource?workflowPolicyNode(workflow,policySource.id):undefined;
    const policyTarget=policySource&&!policyOrigin?node.kind==='policy-node'&&Boolean(policyFrom&&policyFrom.node.kind!=='action'&&policyNode&&policyFrom.scope.id===policyContext?.scope.id):undefined;
    const connectingClass = policyOrigin||isSource ? 'link-origin' : policyTarget!==undefined?policyTarget?'link-target':'link-unavailable':target ? target.valid ? 'link-target' : 'link-unavailable' : '';
    const targetHint = policyTarget!==undefined?policyTarget?'정책 연결 대상으로 선택':'이 정책 경로의 연결 대상이 아닙니다.':target ? target.valid ? '연결 대상으로 선택' : target.reason : '';
    const impactProblems=connectionImpact?.problems.filter(problem=>endpointKey(connectionImpact.stage,problem.endpoint)===node.key)||[];
    const impactAffected=connectionImpact?.affectedEndpoints.some(endpoint=>endpointKey(connectionImpact.stage,endpoint)===node.key);
    const impactHint=impactProblems.map(problem=>problem.message).join(' ');
    const repairFocused=focusRequest&&endpointKey(focusRequest.stage,focusRequest.endpoint)===node.key;
    return <Fragment key={node.key}><button type="button" data-node-id={node.id} data-kind={kind} data-layout-key={node.key} data-execution-state={executionState} data-pinned={pinned||undefined}
      className={`wc-node ${selected(node, selection) ? 'selected' : ''} ${pickedKeys.includes(node.key) ? 'multi-selected' : ''} ${zoneCompletionKeys.includes(node.key) ? 'zone-missing' : ''} ${rule && !rule.enabled ? 'off' : ''} ${drag.current?.key === node.key && preview ? 'moving' : ''} ${connectingClass} ${wirePreview?.targetKey === node.key ? 'wire-hover' : ''} ${impactProblems.length?'impact-risk':impactAffected?'impact-affected':''} ${repairFocused?'repair-focus':''} ${searchFocusKey===node.key?'search-focus':''} ${focusedPath&&!focusedPath.nodes.has(node.key)?'path-dimmed':''}`}
      style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
      title={`${title}\n${membership}: ${subtitle}${targetHint ? `\n${targetHint}` : ''}${impactHint?`\n연결 확인: ${impactHint}`:''}${status ? `\n${status}${stale ? ' (설정 변경 전)' : ''}${trace?.reason ? `: ${trace.reason}` : ''}` : ''}`}
      aria-label={`${title}, ${membership}, ${subtitle}${targetHint ? `, ${targetHint}` : ''}${impactHint?`, 연결 확인: ${impactHint}`:''}${status ? `, ${status}` : ''}${!disabled ? '. 드래그 또는 방향키로 위치 이동. Shift와 방향키로 크게 이동' : ''}`}
      aria-describedby="workflow-canvas-help" aria-pressed={selectionMode || pickedKeys.length > 0 ? pickedKeys.includes(node.key) : selected(node, selection)}
      onClick={event => activate(event, node)} onPointerDown={event => start(event, node)} onPointerMove={update} onPointerUp={finish}
      onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onKeyDown={event => keyboard(event, node)}>
      <span className="wc-icon-wrap" style={{ width: NODE_ICON_SIZE, height: NODE_ICON_SIZE }}>
        {executionView.hasExecution&&<svg className="wc-execution-ring" viewBox="0 0 68 68" aria-hidden="true">{node.kind === 'main'||policyModel ? <polygon points="18,4 50,4 64,34 50,64 18,64 4,34" /> : controlKind === 'condition'||isPolicyCondition ? <polygon points="34,4 64,34 34,64 4,34" /> : node.kind === 'group' ? <rect x="4" y="4" width="60" height="60" rx="12" /> : terminal ? <rect x="4" y="4" width="60" height="60" rx="6" /> : <circle cx="34" cy="34" r="30" />}</svg>}
        <svg className="wc-selection-ring" viewBox="0 0 68 68" aria-hidden="true">{node.kind === 'main'||policyModel ? <polygon points="18,3 50,3 65,34 50,65 18,65 3,34" /> : controlKind === 'condition'||isPolicyCondition ? <polygon points="34,3 65,34 34,65 3,34" /> : node.kind === 'group' ? <rect x="3" y="3" width="62" height="62" rx="13" /> : terminal ? <rect x="3" y="3" width="62" height="62" rx="7" /> : <circle cx="34" cy="34" r="31" />}</svg>
        <span className="wc-kind-icon"><Icon size={25} strokeWidth={1.8} /></span>
      </span>
      {node.stage&&<span className="wc-node-stage" aria-hidden="true">{isPolicy?node.kind==='policy'?'정책 모델':isPolicySwitch?'Switch 분기':isPolicyCondition?'조건 분기':'정책 액션':stageLabels[node.stage]}</span>}
      <strong className="wc-node-title">{title}</strong>{pinned&&<span className="wc-pinned-label" role="img" aria-label="자동 정렬 위치 고정" title="자동 정렬 위치 고정"><Pin size={11} aria-hidden="true"/></span>}
      {selectionMode && <span className={`wc-selection-check ${pickedKeys.includes(node.key) ? 'checked' : ''}`} aria-hidden="true">{pickedKeys.includes(node.key) && <Check size={10} />}</span>}
      {badge && !executionView.hasExecution && <span className={`wc-status ${badge.tone}`} title={badge.text}>{badge.text}</span>}
      {impactProblems.length>0&&<span className="wc-impact-badge" aria-hidden="true">연결 확인</span>}
    </button>{badge&&executionView.hasExecution&&<button type="button" className={`wc-status wc-inspect-status ${badge.tone}`} style={{left:position.x+NODE_WIDTH/2+24,top:position.y-12}} title={`${title}: ${badge.text}. 실행 내역 보기`} aria-label={`${title} 실행 내역`} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();const target:WorkflowSelection=node.kind==='rule'||node.kind==='group'||node.kind==='control'||node.kind==='policy-node'?{kind:node.kind,id:node.id}:{kind:node.kind};(onInspect||onSelect)(target);}}>{badge.text}</button>}</Fragment>;
  }
  return <section className={`wc-shell ${disabled ? 'locked' : ''}`} aria-label="워크플로우 배치">
    <div className="wc-toolbar">
    <div className="wc-controls"><div className="wc-view-controls"><button type="button" ref={searchTrigger} className={searchOpen?'wc-search-toggle active':'wc-search-toggle'} title="노드 찾기" aria-label="워크플로우 노드 찾기" aria-expanded={searchOpen} aria-controls={searchId} onClick={()=>setSearchOpen(value=>!value)}><Search size={14}/><span>노드 찾기</span></button><button type="button" className={pathFocus&&selectedNode ? 'wc-path-focus active' : 'wc-path-focus'} title="선택한 노드로 이어지는 앞뒤 경로를 강조합니다. 실행과 설정은 바뀌지 않습니다." aria-label="선택한 노드 경로 강조" aria-pressed={Boolean(pathFocus&&selectedNode)} disabled={!selectedNode} onClick={()=>setPathFocus(value=>!value)}><GitBranch size={14}/><span>경로</span></button><span className="wc-control-divider" aria-hidden="true"/><button type="button" title="축소 (Ctrl 또는 ⌘ + 마우스 휠)" aria-label="워크플로우 축소" onClick={() => setViewZoom(Math.max(.005, Math.round((zoom - .1) * 1000) / 1000))} disabled={zoom <= .005}><Minus size={14} /></button><span>{zoom < .1 ? (zoom * 100).toFixed(1) : Math.round(zoom * 100)}%</span><button type="button" title="확대 (Ctrl 또는 ⌘ + 마우스 휠)" aria-label="워크플로우 확대" onClick={() => setViewZoom(Math.min(1.5, Math.round((zoom + .1) * 100) / 100))} disabled={zoom >= 1.5}><Plus size={14} /></button><span className="wc-control-divider" aria-hidden="true" /><button type="button" onClick={fit} title="전체 워크플로우 보기" aria-label="전체 보기"><Maximize2 size={14} /><span>전체 보기</span></button><button type="button" onClick={()=>setViewZoom(1)} aria-label="100% 보기" title="100% 보기">100%</button><button type="button" disabled={!selectedNode} onClick={focusSelectedNode} aria-label="선택 노드로 이동" title="선택 노드로 이동"><Search size={14}/><span>선택 노드</span></button><button type="button" disabled={!canRestoreViewport} onClick={restoreView} aria-label="이전 화면으로 복귀" title="이전 화면으로 복귀"><RefreshCw size={14}/><span>이전 화면</span></button><button type="button" disabled={disabled} onClick={arrange} aria-label="자동 정렬"><LayoutGrid size={14} /><span>자동 정렬</span></button></div></div>
    {searchOpen&&<div id={searchId} className="wc-search-panel" ref={searchPanel} role="search" aria-label="워크플로우 노드 검색" onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();closeSearch(true);}}}>
      <div className="wc-search-input"><Search size={15}/><input ref={searchInput} id={`${searchId}-input`} type="search" role="combobox" aria-label="노드 이름, 유형, 단계 또는 영역 검색" aria-autocomplete="list" aria-expanded="true" aria-controls={`${searchId}-results`} aria-activedescendant={searchResults[searchIndex]?`${searchId}-result-${searchIndex}`:undefined} placeholder="이름, 유형, 단계 또는 영역 검색" value={searchQuery} onChange={event=>{setSearchQuery(event.target.value);setSearchIndex(0);}} onKeyDown={searchKeys}/><button type="button" aria-label="노드 검색 닫기" onClick={()=>closeSearch(true)}><X size={14}/></button></div>
      <div className="wc-search-summary" role="status">{searchResults.length}개 노드{searchQuery.trim()?' 검색됨':''}</div>
      <div className="wc-search-results" id={`${searchId}-results`} ref={searchList} role="listbox" aria-label="검색한 노드">{searchResults.map((result,index)=><button type="button" id={`${searchId}-result-${index}`} key={result.key} data-search-index={index} data-search-key={result.key} role="option" aria-selected={index===searchIndex} tabIndex={-1} className={index===searchIndex?'active':''} onMouseEnter={()=>setSearchIndex(index)} onClick={event=>{event.stopPropagation();focusSearchResult(result);}}><span className="wc-search-result-name">{result.name}</span><span className="wc-search-result-meta">{[result.stageLabel,result.typeLabel,...result.zoneNames].filter(Boolean).join(' / ')}</span>{result.matchedRuleNames.length>0&&<small>포함된 검사: {result.matchedRuleNames.join(', ')}</small>}</button>)}</div>
      {searchResults.length===0&&<p className="wc-search-empty">일치하는 노드가 없습니다. 이름이나 검사 유형을 바꿔 검색하세요.</p>}
      <div className="wc-search-help">방향키로 선택하고 Enter로 이동합니다. Esc로 닫습니다.</div>
    </div>}
    <div className="wc-selection-tools"><button type="button" disabled={disabled} onClick={() => onAddNode ? onAddNode() : onAdd('pre')}><Plus size={13} /> 노드 추가</button><button type="button" disabled={disabled || !onAddZone} onClick={onAddZone}><SquareDashed size={13} /> 영역 추가</button><span className="wc-control-divider" /><button type="button" className={selectionMode ? 'active' : ''} disabled={disabled || !onSelectedKeys} aria-pressed={selectionMode} onClick={() => setSelectionMode(value => !value)}><CheckSquare size={13} /> 선택</button>{pickedKeys.length > 0 && <><button type="button" disabled={disabled || !onGroupSelection || Boolean(zoneSelectionIssue)} title={zoneSelectionIssue||"선택 노드 묶기"} aria-label={`${pickedKeys.length}개 선택 노드 묶기`} onClick={() => { onGroupSelection?.(); setSelectionMode(false); }}><Boxes size={13} /> {pickedKeys.length}개 묶기</button>{zoneSelectionIssue&&<span className="wc-branch-guidance" role="status">{zoneSelectionIssue}</span>}{zoneSelectionIssue&&zoneCompletionKeys.length>0&&onCompleteZoneSelection&&<button type="button" disabled={disabled||Boolean(zoneCompletionIssue)} title={zoneCompletionIssue||"강조된 중간 노드를 선택에 포함합니다."} onClick={onCompleteZoneSelection}>빠진 노드 {zoneCompletionKeys.length}개 함께 선택</button>}{onBuildBranch&&<><button type="button" disabled={disabled||!parallelChoice.valid} title={parallelChoice.valid?`선택한 검사 ${pickedKeys.length}개를 동시에 실행`:parallelChoice.reason} onClick={()=>onBuildBranch('parallel',pickedKeys)}><Split size={13}/>검사 {pickedKeys.length}개 동시에 실행</button>{pickedKeys.length===2&&<button type="button" disabled={disabled||!conditionChoice.valid} title={conditionChoice.reason} onClick={()=>onBuildBranch('condition',pickedKeys)}><GitBranch size={13}/>조건 분기</button>}</>}<button type="button" disabled={disabled} aria-label="노드 선택 해제" onClick={() => onSelectedKeys?.([])}><X size={12} /></button>{onBuildBranch&&!parallelChoice.valid&&parallelChoice.reason&&<span className="wc-branch-guidance" role="status">{parallelChoice.reason}</span>}{onBuildBranch&&parallelChoice.valid&&pickedKeys.length===2&&!conditionChoice.valid&&conditionChoice.reason&&<span className="wc-branch-guidance" role="status">{conditionChoice.reason}</span>}</>}</div>
    {policySource&&canPolicyConnect&&onCreatePolicyFromPort&&<div className="wc-policy-create-tools" role="group" aria-label="선택한 정책 포트"><span>{canvasNodeName(`policy-node:${policySource.id}`)} / {policyPortLabel(policySource.id,policySource.port)}</span><button type="button" onClick={()=>{const source=policySource;cancelPolicyWire(true);onCreatePolicyFromPort({from:source.id,port:source.port});}}><Plus size={13}/>이 포트에 새 노드 추가</button><button type="button" aria-label="정책 포트 선택 취소" onClick={()=>cancelPolicyWire(true)}><X size={13}/></button></div>}
    </div>
    <div className={`wc-viewport ${panning ? 'panning' : ''} ${wirePreview ? 'wiring' : ''}`} ref={viewport} tabIndex={0} aria-label="노드 배치 영역" aria-describedby="workflow-canvas-help" onPointerDown={startPan} onPointerMove={movePan} onPointerUp={finishPan} onPointerCancel={cancelPan} onLostPointerCapture={cancelPan} onClick={activateBackground} onScroll={()=>{refreshWire();reportViewport();}}><div className="wc-scroll-area" style={{ width: bounds.width * zoom, height: bounds.height * zoom }}><div className="wc-plane" style={{ width: bounds.width, height: bounds.height, transform: `scale(${zoom})` }}>
      <div className="wc-world" style={{ left: bounds.offsetX, top: bounds.offsetY }}>
      {frames.map(renderFrame)}
      <svg className="wc-edges" width={bounds.width - bounds.offsetX} height={bounds.height - bounds.offsetY} role="group" aria-label="워크플로우 연결"><defs>{(Object.keys(canvasExecutionColors) as CanvasExecutionState[]).map(state=><marker key={state} id={`${markerId}-${state}`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 10 5 L 0 10 L 2.5 5 Z" fill={canvasExecutionColors[state]} /></marker>)}</defs>{edges.map(renderEdge)}{renderImpactEdges()}{policyWirePoint&&policyWire.current&&(()=>{
        const source=policyWire.current.source,key=`policy-node:${source.id}`,side=source.side??portSides(key,'right',source.port)[0],start=policyPoint(key,'right',source.port,side),end=policyWirePoint;
        return <g className="wc-wire-preview" aria-hidden="true"><path d={wirePath(key,side,start,end)}/><circle cx={end.x} cy={end.y} r={4}/></g>;
      })()}{wirePreview&&(()=>{
        const source=wirePreview.source,key=connectionKey(source.stage,source.endpoint,'right',source.policyNodeKey),side=source.side??portSides(key,'right',source.port)[0],start=connectionPoint(source.stage,source.endpoint,'right',source.port,side),end=wirePreview.point;
        return <g className={`wc-wire-preview ${wirePreview.valid?'valid':wirePreview.targetKey?'invalid':''}`} aria-hidden="true"><path d={wirePath(key,side,start,end,wirePreview.targetKey)}/><circle cx={end.x} cy={end.y} r={4}/></g>;
      })()}</svg>
      {nodes.map(renderNode)}
      {renderConnectionPorts()}
      {renderPolicyPorts()}
    </div></div></div></div>
    {executionView.hasExecution&&!connectionImpact&&<div className="wc-execution-legend" aria-label="실행 상태 색상"><span className="running">실행 중</span><span className="completed">완료</span><span className="block">차단</span><span className="error">오류</span><span className="skipped">실행 안 함</span>{Object.values(executionView.edges).includes('unconfirmed')&&<span className="unconfirmed">선택 경로 구분 불가</span>}{stale&&<strong>설정 변경 전 결과</strong>}</div>}
    {connectionImpact&&<div className="wc-impact-legend" role="status"><strong>적용 전 연결 미리 보기</strong><span className="removed">제거할 연결</span><span className="added">추가할 연결</span>{connectionImpact.problems.length>0&&<span className="risk">연결 확인이 필요한 노드</span>}</div>}
    <div className="wc-bottom"><span className="wc-canvas-hint">{policySource ? <span className="wc-linking-cue">{`${canvasNodeName(`policy-node:${policySource.id}`)}의 ${policyPortLabel(policySource.id,policySource.port)} 경로에 연결할 정책 노드를 선택하세요.`}<button type="button" onClick={() => cancelPolicyWire(true)} aria-label="정책 연결 취소"><X size={12} /></button></span> : linkSource ? <span className="wc-linking-cue">{wirePreview?.reason || `${canvasEndpointLabel(linkSource.stage, linkSource.endpoint)} 다음에 연결할 노드를 선택하세요.`}<button type="button" onClick={() => { cancelWire(); setPendingLink(); }} aria-label="연결 취소"><X size={12} /></button></span> : disabled ? '노드를 선택해 설정 보기' : selectionMode ? '묶을 노드를 선택하세요. Shift 클릭으로도 선택할 수 있습니다.' : canConnect ? '연결점에서 노드로 연결하거나 빈 곳에 놓아 추가' : '배경을 끌어 이동'}</span><button type="button" className={`wc-retry-control ${retry ? 'enabled' : ''}`} title={retry ? `응답 검사에서 차단되면 최대 ${maxRetries}회 다시 생성합니다.` : '응답 재작성 설정 열기'} onClick={onRetry}><RefreshCw size={13} />{retry ? `응답 재작성 ${maxRetries}회` : '응답 재작성 꺼짐'}</button></div>
    <span id="workflow-canvas-help" className="wc-sr">{disabled ? '노드를 선택하면 설정을 확인할 수 있습니다.' : '노드를 끌어 배치하고 배경을 끌어 화면을 이동합니다. 연결점을 끌어 대상 노드에 놓거나, 연결점을 선택한 뒤 대상 노드를 선택해 연결합니다. 빈 공간에 놓으면 새 노드를 추가할 수 있습니다. Esc로 연결을 취소합니다. 연결선의 더하기 버튼은 해당 경로에 검사를 추가합니다. 화살표가 실행 방향을 표시합니다. 빈 배경을 선택하면 열린 설정 패널을 닫습니다. 표시용 영역 제목을 끌면 포함된 노드가 함께 이동하며 실행 순서는 바뀌지 않습니다. Shift 클릭으로 여러 노드를 선택해 영역으로 묶을 수 있습니다. 방향키로 이동하고 Shift와 방향키를 함께 누르면 크게 이동합니다.'} 캔버스 위에서 Ctrl 또는 ⌘ 키와 마우스 휠을 함께 사용하면 마우스 위치를 중심으로 확대하거나 축소합니다. 일반 휠은 화면을 스크롤합니다. 배치는 실행 순서에 영향을 주지 않습니다.</span>
    <span className="wc-sr" role="status" aria-live="polite">{announcement}</span>
  </section>;
}
