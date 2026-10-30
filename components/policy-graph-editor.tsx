'use client';

import { randomUuid } from '@/lib/client-id';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ArrowRight, GitBranch, Plus, Split, Trash2, Zap } from 'lucide-react';
import type { PolicyGraph, PolicyGraphNode, PolicyPredicate, PolicyRoute, PolicySwitchValue } from '@/lib/aegis-types';
import { policyNodePorts, policySwitchValueLabel } from '@/lib/policy-graph';
import { policyGraphSchemaIssues, policyValueInput } from '@/lib/policy-schema-guidance';
import { applyPolicySwitchValues, policyFieldInfo, policyFieldOperators, policySwitchCoversField, policySwitchDiff } from '@/lib/policy-field-options';
import { PolicyFieldPicker } from './policy-field-picker';
import './policy-switch-editor.css';

const kindLabel = {branch:'조건 분기',rule:'조건 분기',switch:'Switch 분기',action:'액션'};
const actionLabel = {main:'응답 모델 실행',respond:'등록 안내 응답',error:'지정 오류'};
const operatorLabels: Record<PolicyPredicate['operator'],string> = {eq:'같음',ne:'다름',gt:'초과',gte:'이상',lt:'미만',lte:'이하',contains:'포함',in:'목록 중 하나',exists:'존재 여부'};

export function PolicyGraphPreview({graph,selected,onSelect}: {graph:PolicyGraph;selected?:string;onSelect?:(id:string)=>void}) {
  return <div className="policy-graph-preview" aria-label="조건 분기 액션 그래프">{(['condition','action'] as const).map((kind,index)=><div className="policy-graph-column" key={kind}><strong>{index?<ArrowRight size={12}/>:null}{kind==='condition'?'조건 분기':'액션'}</strong>{graph.nodes.filter(node=>(node.kind==='action')===(kind==='action')).map(node=><button type="button" key={node.id} className={`policy-graph-node ${selected===node.id?'selected':''}`} aria-label={`${node.name} ${kindLabel[node.kind]} 노드 설정`} onClick={()=>onSelect?.(node.id)} disabled={!onSelect}>
    {node.kind==='action'?<Zap size={14}/>:node.kind==='switch'?<Split size={14}/>:<GitBranch size={14}/>}<span><b>{node.name}</b><small>{node.kind==='action'?actionLabel[node.action]:policyNodePorts(node).map(({port,label})=>`${label} → ${graph.nodes.find(target=>target.id===graph.edges.find(edge=>edge.from===node.id&&edge.port===port)?.to)?.name??'미연결'}`).join(' / ')}</small></span></button>)}</div>)}</div>;
}

function SwitchValueInput({value,onChange,disabled,label}:{value:PolicySwitchValue;onChange:(value:PolicySwitchValue)=>void;disabled:boolean;label:string}) {
  const [kind,setKind]=useState(()=>value===undefined?'number':value===null?'null':typeof value);
  const [numberText,setNumberText]=useState(typeof value==='number'?String(value):'');
  const numberRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(value===undefined){setKind('number');return;}setKind(value===null?'null':typeof value);if(document.activeElement!==numberRef.current)setNumberText(typeof value==='number'?String(value):'');},[value]);
  return <div className="policy-switch-value" data-policy-value-field="true">
    <label className="field">자료형<select disabled={disabled} aria-label={`${label} 자료형`} value={kind} onChange={event=>{const next=event.target.value;setKind(next);setNumberText('0');onChange(next==='null'?null:next==='boolean'?false:next==='number'?0:'');}}><option value="string">문자열</option><option value="number">숫자</option><option value="boolean">불리언</option><option value="null">null</option></select></label>
    <label className="field">비교값{kind==='string'?<input data-field-key="value" aria-label={label} disabled={disabled} maxLength={4096} value={typeof value==='string'?value:''} placeholder="빈 문자열도 비교값입니다" onChange={event=>onChange(event.target.value)}/>:
      kind==='number'?<input ref={numberRef} data-field-key="value" aria-label={label} disabled={disabled} inputMode="decimal" value={numberText} aria-invalid={value===undefined} maxLength={128} placeholder="예: 0, -1, 2.5" onChange={event=>{const raw=event.target.value;setNumberText(raw);const number=Number(raw),valid=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)&&Number.isFinite(number)&&Math.abs(number)<=Number.MAX_SAFE_INTEGER;onChange(valid?number:undefined as unknown as PolicySwitchValue);}}/>:
      kind==='boolean'?<select data-field-key="value" aria-label={label} disabled={disabled} value={String(value)} onChange={event=>onChange(event.target.value==='true')}><option value="false">false</option><option value="true">true</option></select>:<input data-field-key="value" aria-label={label} value="null" readOnly disabled={disabled}/>}</label>
    {kind==='string'&&<small>대소문자와 앞뒤 공백을 그대로 비교합니다. 큰따옴표를 붙이지 않습니다.</small>}
    {value===undefined&&<small role="alert">유효한 숫자를 완성하세요. 미완성 값은 저장하거나 실행할 수 없습니다.</small>}
  </div>;
}

function JsonValueInput({value,onChange,disabled,label}: {value:unknown;onChange:(value:unknown)=>void;disabled:boolean;label:string}) {
  const serialize = (value:unknown) => value === undefined ? '' : JSON.stringify(value);
  const [text,setText] = useState(()=>serialize(value));
  const [invalid,setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const serialized = serialize(value);
  useEffect(()=>{if(document.activeElement!==ref.current){setText(serialized);setInvalid(false);}},[serialized]);
  return <label className="field">비교값 (JSON)<input data-field-key="value" ref={ref} aria-label={label} aria-invalid={invalid||value===undefined} disabled={disabled} value={text} className="mono" maxLength={4096} placeholder={'예: "service", 80, true, null'} onChange={event=>{const next=event.target.value;setText(next);try{const value:unknown=JSON.parse(next),pending=[value];while(pending.length){const item=pending.pop();if(typeof item==='number'&&(!Number.isFinite(item)||Math.abs(item)>Number.MAX_SAFE_INTEGER))throw new Error('number');if(item&&typeof item==='object')pending.push(...Object.values(item));}onChange(value);setInvalid(false);}catch{onChange(undefined);setInvalid(true);}}}/>{(invalid||value===undefined)&&<small role="alert">유효한 JSON 값을 입력하세요. 문자열은 큰따옴표로 감쌉니다.</small>}</label>;
}

function ComparisonInput({schema,predicate,onChange,disabled,label}:{schema:Record<string,unknown>;predicate:PolicyPredicate;onChange:(value:unknown)=>void;disabled:boolean;label:string}) {
  const info=policyValueInput(schema,predicate),[json,setJson]=useState(false),[numberText,setNumberText]=useState(predicate.value===undefined?'':String(predicate.value)),numberRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(document.activeElement!==numberRef.current)setNumberText(predicate.value===undefined?'':String(predicate.value));},[predicate.value]);
  const value=predicate.value,enumIndex=info.values?.findIndex(item=>JSON.stringify(item)===JSON.stringify(value))??-1;
  const wrongType=value===null&&!info.nullable||value!==undefined&&value!==null&&((info.kind==='string'&&typeof value!=='string')||(['number','integer'].includes(info.kind)&&typeof value!=='number')||(info.kind==='boolean'&&typeof value!=='boolean'));
  const advanced=json||info.kind==='json'||wrongType;
  return <div className="policy-value-input" data-policy-value-kind={advanced?'json':info.kind} data-policy-value-field="true">
    {advanced?<JsonValueInput value={value} onChange={onChange} disabled={disabled} label={label}/>:<>
      {info.nullable&&info.kind!=='enum'&&info.kind!=='null'&&<label className="field">값 종류<select aria-label={label+' 자료형'} disabled={disabled} value={value===null?'null':'value'} onChange={event=>onChange(event.target.value==='null'?null:undefined)}><option value="value">{info.kind==='string'?'문자열':info.kind==='boolean'?'참 또는 거짓':'숫자'}</option><option value="null">null</option></select></label>}
      {(value!==null||!info.nullable||info.kind==='enum'||info.kind==='null')&&<label className="field">비교값
        {info.kind==='enum'?<select data-field-key="value" aria-label={label} disabled={disabled} value={enumIndex<0?'':String(enumIndex)} onChange={event=>{if(event.target.value!=='')onChange(info.values![Number(event.target.value)]);}}><option value="" disabled>{value===undefined?'허용값 선택':'현재 값은 JSON 편집에서 확인하세요.'}</option>{info.values!.map((item,index)=><option key={index} value={index}>{JSON.stringify(item)}</option>)}</select>:
          info.kind==='boolean'?<select data-field-key="value" aria-label={label} disabled={disabled} value={value===undefined?'':String(value)} onChange={event=>onChange(event.target.value==='true')}><option value="" disabled>참 또는 거짓 선택</option><option value="true">true</option><option value="false">false</option></select>:
          info.kind==='null'?<select data-field-key="value" aria-label={label} disabled={disabled} value={value===null?'null':''} onChange={()=>onChange(null)}><option value="" disabled>값 선택</option><option value="null">null</option></select>:
          info.kind==='string'?<input data-field-key="value" aria-label={label} disabled={disabled} maxLength={4096} value={typeof value==='string'?value:''} placeholder="문자열을 그대로 입력하세요" onChange={event=>onChange(event.target.value)}/>:
          <input ref={numberRef} data-field-key="value" aria-label={label} disabled={disabled} inputMode="decimal" value={numberText} maxLength={4096} placeholder={info.kind==='integer'?'정수 입력':'숫자 입력'} onChange={event=>{const raw=event.target.value;setNumberText(raw);const valid=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw),number=Number(raw);onChange(valid&&Number.isFinite(number)&&Math.abs(number)<=Number.MAX_SAFE_INTEGER?number:undefined);}}/>}
      </label>}
      {info.kind==='string'&&<small>큰따옴표를 붙이지 않습니다. 빈 문자열도 값으로 사용합니다.</small>}
      {value===undefined&&<small role="alert">{(['number','integer'].includes(info.kind))?'유한한 숫자를 입력하세요. 입력 중인 값은 그대로 유지합니다.':'비교값을 선택하거나 입력하세요.'}</small>}
    </>}
    {info.kind!=='json'&&<button type="button" className="btn small" disabled={disabled} aria-label={label+' 편집 방식 변경'} onClick={()=>{if(wrongType)onChange(undefined);setJson(wrongType?false:!advanced);}}>{wrongType?'필드 형식으로 새 값 입력':advanced?'필드 형식으로 편집':'JSON으로 편집'}</button>}
    {info.kind==='json'&&<small>복합 구조와 비교 목록은 JSON으로 입력합니다. 서버가 전체 스키마를 검사합니다.</small>}
  </div>;
}

export function PolicyGraphEditor({graph,schema,disabled,onChange,selectedNodeId,onSelectNode,onAddNode,onAddFromPort,onConnect,nodeActionsRef,nodeOnly=false,policyExamples=[],policyLabel,autoFillNewSwitch=false,showName=true,selectedEdgeId,edgeFocusRequest}: {graph:PolicyGraph;schema:Record<string,unknown>;disabled:boolean;onChange:(graph:PolicyGraph)=>void;selectedNodeId?:string;onSelectNode?:(id:string)=>void;onAddNode?:()=>void;onAddFromPort?:(from:string,port:string)=>void;onConnect?:(from:string,to:string,port:string)=>void;nodeActionsRef?:Ref<{deleteNode:()=>void}>;nodeOnly?:boolean;policyExamples?:{expectedOutput?:unknown}[];policyLabel?:string;autoFillNewSwitch?:boolean;showName?:boolean;selectedEdgeId?:string;edgeFocusRequest?:number}) {
  const [localSelected,setLocalSelected] = useState(graph.entryNodeId);
  const [connectionError,setConnectionError]=useState('');
  const [proposal,setProposal]=useState<{nodeId:string;path:string;values:PolicySwitchValue[];selected:number[];source:'schema'|'examples'}>();
  const [candidateNote,setCandidateNote]=useState('');
  const [editingCaseId,setEditingCaseId]=useState('');
  const autoEligible=useRef(new Set<string>()),autoUsed=useRef(new Set<string>());
  const editorRoot=useRef<HTMLDivElement>(null);
  const selected=selectedNodeId??localSelected;
  const setSelected=(id:string)=>{setLocalSelected(id);onSelectNode?.(id);};
  const node = graph.nodes.find(n=>n.id===selected) ?? graph.nodes[0];
  const selectedSwitchEdge=node?.kind==='switch'&&node.id===selected?graph.edges.find(edge=>edge.id===selectedEdgeId&&edge.from===node.id&&(edge.port==='default'||node.cases.some(item=>item.id===edge.port))):undefined;
  const selectedSwitchPort=selectedSwitchEdge?.port;
  useEffect(()=>{setConnectionError('');setProposal(undefined);setCandidateNote('');setEditingCaseId('');if(autoFillNewSwitch&&node?.kind==='switch'&&node.path===''&&node.cases.length===1&&node.cases[0].id==='case-1'&&node.cases[0].value===''&&!graph.edges.some(edge=>edge.from===node.id))autoEligible.current.add(node.id);},[node?.id,autoFillNewSwitch]);
  useEffect(()=>{setProposal(undefined);setCandidateNote('');},[schema,policyLabel]);
  useEffect(()=>{
    if(!selectedSwitchPort)return;
    const frame=requestAnimationFrame(()=>{
      const root=editorRoot.current,scroller=root?.closest<HTMLElement>('.we-inspector-scroll');
      const card=[...(root?.querySelectorAll<HTMLElement>('[data-policy-route-port]')??[])].find(element=>element.dataset.policyRoutePort===selectedSwitchPort);
      if(!card)return;
      if(selectedSwitchPort==='default'&&card.tagName==='DETAILS')(card as HTMLDetailsElement).open=true;
      if(!scroller)return;
      const viewport=scroller.getBoundingClientRect(),bounds=card.getBoundingClientRect(),top=bounds.top-viewport.top-scroller.clientTop;
      // Keep the selected heading at the panel top, including when only the
      // upper part of the canvas is visible in a short browser viewport.
      scroller.scrollTop+=top-12;
    });
    return()=>cancelAnimationFrame(frame);
  },[node?.id,selectedSwitchEdge?.id,selectedSwitchPort,edgeFocusRequest]);
  function manualSwitchEdit(){if(node)autoUsed.current.add(node.id);setProposal(undefined);}
  function offerSwitchValues(path:string){
    if(disabled||node?.kind!=='switch')return;
    const info=policyFieldInfo(schema,path,policyExamples);
    const canAuto=autoEligible.current.has(node.id)&&!autoUsed.current.has(node.id);
    if(canAuto&&info.source==='schema'&&info.complete&&info.values.length>0&&info.values.length<=12){
      autoUsed.current.add(node.id);onChange(applyPolicySwitchValues(graph,node.id,info.values,path));setProposal(undefined);setCandidateNote(`스키마에서 비교값 ${info.values.length}개를 채웠습니다. 각 연결 대상을 선택하세요.`);return;
    }
    if(canAuto&&info.types.length===1&&['number','integer'].includes(info.types[0])){
      autoUsed.current.add(node.id);replace({...node,path,cases:[{...node.cases[0],value:undefined as unknown as PolicySwitchValue}]});
    }
    if(!info.values.length){setProposal(undefined);setCandidateNote('확정된 허용값이나 저장된 예제 값이 없습니다. 비교값을 직접 입력하세요.');return;}
    setCandidateNote('');setProposal({nodeId:node.id,path,values:info.values,selected:info.values.length<=12?info.values.map((_,index)=>index):[],source:info.source as 'schema'|'examples'});
  }
  function replace(next:PolicyGraphNode) { onChange({...graph,nodes:graph.nodes.map(n=>n.id===next.id?next:n)}); }
  function updatePredicate(index:number,next:PolicyPredicate) {
    if (node.kind!=='branch'&&node.kind!=='rule') return;
    replace({...node,condition:{...node.condition,predicates:node.condition.predicates.map((p,i)=>i===index?next:p)}});
  }
  function connect(port:string,to:string) {
    if(disabled||!node||!policyNodePorts(node).some(item=>item.port===port))return;
    setConnectionError('');
    if(to&&onConnect){try{onConnect(node.id,to,port);}catch(error){setConnectionError(error instanceof Error?error.message:'연결을 적용하지 못했습니다.');}return;}
    const previous = graph.edges.find(e=>e.from===node.id&&e.port===port);
    if(to){
      const pending=[to],visited=new Set<string>();
      while(pending.length){const key=pending.pop()!;if(key===node.id){setConnectionError('정책 노드에 순환 연결을 만들 수 없습니다.');return;}if(visited.has(key))continue;visited.add(key);for(const edge of graph.edges)if(edge.from===key&&!(edge.from===node.id&&edge.port===port))pending.push(edge.to);}
    }
    onChange({...graph,edges:[...graph.edges.filter(e=>!(e.from===node.id&&e.port===port)),...(to?[{id:previous?.id??`policy-edge-${randomUuid()}`,from:node.id,to,port}]:[])]});
  }
  function deleteNode() {
    if(disabled||!node)return;
    const entryNodeId=node.id===graph.entryNodeId?'':graph.entryNodeId;
    onChange({...graph,entryNodeId,nodes:graph.nodes.filter(n=>n.id!==node.id),edges:graph.edges.filter(e=>e.from!==node.id&&e.to!==node.id)});
    setSelected(entryNodeId||graph.nodes.find(n=>n.id!==node.id)?.id||'');
  }
  useImperativeHandle(nodeActionsRef,()=>({deleteNode}));
  if (!node) return null;
  const schemaIssues=policyGraphSchemaIssues(graph,schema).filter(issue=>issue.nodeId===node.id);
  const selectedValues=proposal?.selected.map(index=>proposal.values[index])??[];
  const diff=proposal?policySwitchDiff(graph,proposal.nodeId,selectedValues):undefined;
  const showProposal=proposal?.nodeId===node.id&&node.kind==='switch'&&proposal.path===node.path;
  const connected=(port:string)=>{const edges=graph.edges.filter(edge=>edge.from===node.id&&edge.port===port);return edges.length===1&&graph.nodes.some(target=>target.id===edges[0].to);};
  const defaultConnected=node.kind==='switch'&&connected('default');
  const collapseDefault=node.kind==='switch'&&defaultConnected&&node.cases.every(item=>connected(item.id))&&policySwitchCoversField(schema,node);
  const fieldInfo=node.kind==='switch'?policyFieldInfo(schema,node.path):undefined;
  const compactCases=fieldInfo?.source==='schema'&&fieldInfo.complete;
  const addedSchemaValues=node.kind==='switch'&&compactCases?fieldInfo.values.filter(value=>!node.cases.some(item=>JSON.stringify(item.value)===JSON.stringify(value))).length:0;
  const previousSchemaValues=node.kind==='switch'&&compactCases?node.cases.filter(item=>!fieldInfo.values.some(value=>JSON.stringify(item.value)===JSON.stringify(value))).length:0;
  return <div ref={editorRoot} className="policy-graph-editor" data-policy-node-id={node.id}>
    {!nodeOnly&&<p className="we-fine">{node.kind==='switch'?'정책 JSON의 필드 값으로 출력 경로 하나를 선택합니다.':'조건 분기는 정책 출력의 필드를 검사해 참 또는 거짓 경로를 선택합니다. 다른 분기나 액션으로 바로 연결할 수 있습니다. 비교값의 타입은 자동 변환하지 않습니다.'}</p>}
    {!nodeOnly&&<PolicyGraphPreview graph={graph} selected={node.id} onSelect={setSelected}/>}
    {!nodeOnly&&onAddNode&&<div className="policy-graph-toolbar"><button type="button" className="btn small" disabled={disabled} onClick={onAddNode}><Plus size={12}/>노드 추가</button></div>}
    <fieldset disabled={disabled} className={`we-policy-route${nodeOnly?' policy-node-only-route':''}`}><legend>{kindLabel[node.kind]} 설정</legend>
      {showName&&<label className="field">노드 이름<input data-field-key="name" aria-label="정책 노드 이름" value={node.name} maxLength={100} onChange={e=>replace({...node,name:e.target.value})}/></label>}
      {node.kind==='switch'?<>
        {!nodeOnly&&policyLabel&&<p className="policy-field-source">출력 기준: {policyLabel}</p>}
        <PolicyFieldPicker scalarOnly schema={schema} value={node.path} label="Switch 필드 경로" invalid={schemaIssues.some(issue=>issue.code==='path')} disabled={disabled} onChange={path=>{replace({...node,path});setProposal(undefined);setCandidateNote('');}} onSelect={offerSwitchValues}/>
        <div className="policy-switch-candidate-action"><button type="button" className="btn small" disabled={disabled} onClick={()=>offerSwitchValues(node.path)}>스키마와 예제에서 비교값 가져오기</button><small>기존 비교값과 연결은 적용 전까지 유지합니다.</small></div>
        {(addedSchemaValues>0||previousSchemaValues>0)&&<p className="we-fine policy-switch-schema-note" role="status">추가할 수 있는 스키마 후보 {addedSchemaValues}개 / 현재 후보에 없는 비교값 {previousSchemaValues}개가 있습니다. 비교값 가져오기에서 변경 내용을 확인하세요. 기존 비교값과 연결은 유지됩니다.</p>}
        {candidateNote&&<p className="we-fine" role="status">{candidateNote}</p>}
        {showProposal&&proposal&&<section className="policy-switch-proposal" aria-label="Switch 비교값 적용 미리보기"><strong>{proposal.source==='schema'?'스키마의 비교값':'저장된 예제의 비교값'}</strong><p>{proposal.source==='examples'?'예제는 전체 허용값이 아닙니다. 사용할 값만 선택하세요.':'필요한 비교값을 선택하세요.'} 최대 12개입니다. {proposal.values.length>12&&`후보 ${proposal.values.length}개 중 선택하지 않은 값은 기본 경로로 이동합니다.`}</p><div className="policy-switch-candidates">{proposal.values.map((value,index)=><label key={index}><input type="checkbox" aria-label={`Switch 후보 ${index+1} 선택`} checked={proposal.selected.includes(index)} disabled={disabled||!proposal.selected.includes(index)&&proposal.selected.length>=12} onChange={event=>setProposal(current=>current?{...current,selected:event.target.checked?[...current.selected,index]:current.selected.filter(item=>item!==index)}:current)}/><code>{policySwitchValueLabel(value)}</code><small>{value===null?'null':typeof value}</small></label>)}</div><p>선택 {selectedValues.length}개 / 기존 유지 {diff?.kept}개 / 추가 {diff?.added}개 / 제거 {diff?.removed}개{diff?.removedConnections?` / 제거할 연결 ${diff.removedConnections}개`:''}</p><div className="we-row"><button type="button" className="btn small primary" disabled={disabled||selectedValues.length<1||selectedValues.length>12} onClick={()=>{manualSwitchEdit();onChange(applyPolicySwitchValues(graph,node.id,selectedValues,node.path));setCandidateNote('선택한 비교값을 적용했습니다. 같은 값의 기존 연결과 기본 경로를 유지했습니다.');}}>선택한 비교값 적용</button><button type="button" className="btn small" onClick={()=>setProposal(undefined)}>취소</button></div></section>}
        <details className="policy-switch-help"><summary>비교 방식과 입력 도움말</summary><p>스키마 검증을 통과한 정책 JSON의 필드 값을 정확히 비교합니다. 일치하는 값이 없거나 필드가 없으면 기본 경로로 이동합니다. null은 필드가 없는 경우와 구분합니다. 문자열, 숫자, 불리언과 null을 지원합니다. 자료형을 자동 변환하지 않으며 대소문자와 공백을 유지합니다. 같은 비교값은 중복 등록할 수 없습니다. /와 ~가 있는 필드 이름은 ~1과 ~0으로 적습니다.</p></details>
        {node.cases.map((item,index)=><div className={`policy-predicate policy-switch-case${selectedSwitchPort===item.id?' policy-switch-route-selected':''}`} data-policy-route-port={item.id} data-policy-selected-edge={selectedSwitchPort===item.id?selectedSwitchEdge?.id:undefined} role={selectedSwitchPort===item.id?'group':undefined} aria-label={selectedSwitchPort===item.id?`선택한 연결: 비교값 ${index+1}`:undefined} aria-current={selectedSwitchPort===item.id?'true':undefined} data-policy-switch-case={item.id} data-policy-predicate-index={index} key={`${node.id}-${item.id}`}>{selectedSwitchPort===item.id&&<span className="policy-switch-selected-marker" aria-hidden="true">선택한 연결</span>}<strong>비교값 {index+1}</strong>{compactCases?<div className="policy-switch-compact"><div><code>{policySwitchValueLabel(item.value)}</code><small>{item.value===null?'null':typeof item.value==='string'?'문자열':typeof item.value==='number'?'숫자':'불리언'}</small></div><details open={editingCaseId===item.id} onToggle={event=>{if(event.currentTarget.open)setEditingCaseId(item.id);else setEditingCaseId(current=>current===item.id?'':current);}}><summary>값 편집</summary><SwitchValueInput value={item.value} onChange={value=>{manualSwitchEdit();replace({...node,cases:node.cases.map(candidate=>candidate.id===item.id?{...candidate,value}:candidate)});}} disabled={disabled} label={`Switch 비교값 ${index+1}`}/></details></div>:<SwitchValueInput value={item.value} onChange={value=>{manualSwitchEdit();replace({...node,cases:node.cases.map(candidate=>candidate.id===item.id?{...candidate,value}:candidate)});}} disabled={disabled} label={`Switch 비교값 ${index+1}`}/>}{schemaIssues.filter(issue=>issue.predicateIndex===index&&issue.code!=='path').map(issue=><small className="we-inline-error" role="alert" key={issue.code}>{issue.message}</small>)}<div className="policy-port-field" data-policy-edge-port={item.id}><label className="field">일치할 때 연결<select aria-label={`Switch ${item.id} 연결`} aria-invalid={!graph.edges.some(edge=>edge.from===node.id&&edge.port===item.id)} value={graph.edges.find(edge=>edge.from===node.id&&edge.port===item.id)?.to??''} onChange={event=>connect(item.id,event.target.value)}><option value="">연결 선택</option>{graph.nodes.filter(candidate=>candidate.id!==node.id).map(candidate=><option key={candidate.id} value={candidate.id}>{kindLabel[candidate.kind]}: {candidate.name}</option>)}</select>{!graph.edges.some(edge=>edge.from===node.id&&edge.port===item.id)&&<small role="alert">연결 필요</small>}</label>{onAddFromPort&&<button type="button" className="btn small" aria-label={`Switch 비교값 ${index+1} 경로에 새 노드 추가`} disabled={disabled} onClick={()=>onAddFromPort(node.id,item.id)}><Plus size={12}/>새 노드 추가</button>}</div><button type="button" className="btn small" aria-label={`Switch 비교값 ${index+1} 삭제`} disabled={disabled||node.cases.length<=1} onClick={()=>{manualSwitchEdit();setConnectionError('');onChange({...graph,nodes:graph.nodes.map(candidate=>candidate.id===node.id?{...node,cases:node.cases.filter(value=>value.id!==item.id)}:candidate),edges:graph.edges.filter(edge=>edge.from!==node.id||edge.port!==item.id)});}}><Trash2 size={12}/>비교값 삭제</button></div>)}
        <button type="button" className="btn small" disabled={disabled||node.cases.length>=12} onClick={()=>{manualSwitchEdit();let index=1;while(node.cases.some(item=>item.id===`case-${index}`))index++;let value='';while(node.cases.some(item=>item.value===value))value=value?`${value}_새값`:'새값';setEditingCaseId(`case-${index}`);replace({...node,cases:[...node.cases,{id:`case-${index}`,value}]});}}><Plus size={12}/>비교값 추가</button>
        <details className={`policy-switch-default${selectedSwitchPort==='default'?' policy-switch-route-selected':''}`} data-policy-route-port="default" data-policy-selected-edge={selectedSwitchPort==='default'?selectedSwitchEdge?.id:undefined} role={selectedSwitchPort==='default'?'group':undefined} aria-label={selectedSwitchPort==='default'?'선택한 연결: 기본 경로':undefined} aria-current={selectedSwitchPort==='default'?'true':undefined} key={`${node.id}-${collapseDefault}`} open={!collapseDefault||selectedSwitchPort==='default'}><summary>기본 경로 (필수){selectedSwitchPort==='default'&&<span className="policy-switch-selected-marker" aria-hidden="true">선택한 연결</span>}{collapseDefault?' / 필수 필드의 허용값을 모두 연결':!defaultConnected?' / 연결 필요':' / 그 외의 값'}</summary><div className="policy-port-field" data-policy-edge-port="default"><label className="field">기본 경로 (default)<select aria-label="Switch default 연결" aria-invalid={!graph.edges.some(edge=>edge.from===node.id&&edge.port==='default')} value={graph.edges.find(edge=>edge.from===node.id&&edge.port==='default')?.to??''} onChange={event=>connect('default',event.target.value)}><option value="">연결 선택</option>{graph.nodes.filter(candidate=>candidate.id!==node.id).map(candidate=><option key={candidate.id} value={candidate.id}>{kindLabel[candidate.kind]}: {candidate.name}</option>)}</select><small>일치하는 비교값이 없거나 필드가 없을 때 선택합니다. 반드시 연결하세요.</small></label>{onAddFromPort&&<button type="button" className="btn small" disabled={disabled} aria-label="Switch 기본 경로에 새 노드 추가" onClick={()=>onAddFromPort(node.id,'default')}><Plus size={12}/>새 노드 추가</button>}</div></details>
        {schemaIssues.filter(issue=>issue.code==='path').map((issue,index)=><small className="we-inline-error" role="alert" key={index}>{issue.message}</small>)}
        {connectionError&&<p className="we-inline-error" role="alert">{connectionError}</p>}
      </>:node.kind!=='action'?<>
        <label className="field">조건 조합<select aria-label="정책 조건 조합" value={node.condition.mode} onChange={e=>replace({...node,condition:{...node.condition,mode:e.target.value as 'all'|'any'}})}><option value="all">모두 만족 (all)</option><option value="any">하나 이상 만족 (any)</option></select></label>
        {node.condition.predicates.map((predicate,index)=><div className="policy-predicate" data-policy-predicate-index={index} data-policy-field-path={predicate.path} key={`${node.id}-${index}`}>
          <PolicyFieldPicker schema={schema} value={predicate.path} label={`정책 필드 경로 ${index+1}`} disabled={disabled} invalid={schemaIssues.some(issue=>issue.predicateIndex===index&&issue.code==='path')} onChange={path=>updatePredicate(index,{...predicate,path})}/>
          <label className="field">연산자<select data-field-key="operator" aria-label={`정책 연산자 ${index+1}`} value={predicate.operator} onChange={e=>{const operator=e.target.value as PolicyPredicate['operator'];updatePredicate(index,{path:predicate.path,operator,...(operator==='exists'?{}:{value:predicate.value})});}}>{Object.entries(operatorLabels).filter(([value])=>value===predicate.operator||policyFieldOperators(schema,predicate.path).includes(value as PolicyPredicate['operator'])).map(([value,label])=><option key={value} value={value}>{label}{!policyFieldOperators(schema,predicate.path).includes(value as PolicyPredicate['operator'])?' (현재 필드와 맞지 않음)':''}</option>)}</select>{!policyFieldOperators(schema,predicate.path).includes(predicate.operator)&&<small className="we-inline-error">기존 연산자는 유지했습니다. 현재 필드에 맞는 비교 방식을 선택하세요.</small>}</label>
          {predicate.operator==='exists'?<label className="field">존재 여부<select aria-label={`정책 존재 여부 ${index+1}`} value={predicate.value===false?'false':'true'} onChange={e=>updatePredicate(index,{...predicate,value:e.target.value==='true'})}><option value="true">필드가 있음</option><option value="false">필드가 없음</option></select></label>:<ComparisonInput key={`${node.id}-${index}-${predicate.operator}-${predicate.path}`} schema={schema} predicate={predicate} onChange={value=>updatePredicate(index,{...predicate,value})} disabled={disabled} label={`정책 비교값 ${index+1}`}/>}
          {schemaIssues.filter(issue=>issue.predicateIndex===index).map(issue=><small className="we-inline-error" role="alert" key={issue.code}>{issue.message}</small>)}
          <button type="button" className="btn small" aria-label={`정책 조건 ${index+1} 삭제`} disabled={disabled||node.condition.predicates.length<=1} onClick={()=>replace({...node,condition:{...node.condition,predicates:node.condition.predicates.filter((_,i)=>i!==index)}})}><Trash2 size={12}/>조건 삭제</button>
        </div>)}
        <button type="button" className="btn small" disabled={disabled||node.condition.predicates.length>=12} onClick={()=>replace({...node,condition:{...node.condition,predicates:[...node.condition.predicates,{path:'',operator:'exists'}]}})}><Plus size={12}/>필드 조건 추가</button>
        {(['true','false'] as const).map(port=><div className="policy-port-field" data-policy-edge-port={port} key={port}><label className="field">{port==='true'?'참':'거짓'}일 때 연결<select aria-label={`정책 ${port} 연결`} value={graph.edges.find(e=>e.from===node.id&&e.port===port)?.to??''} onChange={e=>connect(port,e.target.value)}><option value="">연결 선택</option>{graph.nodes.filter(n=>n.id!==node.id).map(n=><option key={n.id} value={n.id}>{kindLabel[n.kind]}: {n.name}</option>)}</select></label>{onAddFromPort&&<button type="button" className="btn small" disabled={disabled} aria-label={`${port==='true'?'참':'거짓'} 경로에 새 노드 추가`} onClick={()=>onAddFromPort(node.id,port)}><Plus size={12}/>새 노드 추가</button>}</div>)}
        {connectionError&&<p className="we-inline-error" role="alert">{connectionError}</p>}
      </>:<>
        <label className="field">다음 액션<select aria-label="정책 다음 액션" value={node.action} onChange={e=>{const action=e.target.value as PolicyRoute['action'];replace({id:node.id,name:node.name,kind:'action',action,...(action==='respond'?{responseText:''}:action==='error'?{errorCode:'POLICY_BLOCKED',errorMessage:'정책에 따라 요청이 제한되었습니다.'}:{})});}}>{Object.entries(actionLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        {node.action==='respond'&&<label className="field">안내 응답<textarea data-field-key="responseText" aria-label="정책 액션 안내 응답" rows={3} maxLength={4000} value={node.responseText??''} onChange={e=>replace({...node,responseText:e.target.value})}/><small>등록된 문구만 응답 검사에 한 번 전달합니다.</small></label>}
        {node.action==='error'&&<><label className="field">공개 오류 코드<input data-field-key="errorCode" aria-label="정책 액션 오류 코드" maxLength={64} value={node.errorCode??''} onChange={e=>replace({...node,errorCode:e.target.value})}/></label><label className="field">공개 오류 메시지<textarea data-field-key="errorMessage" aria-label="정책 액션 오류 메시지" rows={2} maxLength={500} value={node.errorMessage??''} onChange={e=>replace({...node,errorMessage:e.target.value})}/></label></>}
      </>}
      {!nodeActionsRef&&<button type="button" className="btn small danger" disabled={disabled} onClick={deleteNode}><Trash2 size={12}/>노드 삭제</button>}
    </fieldset>
  </div>;
}
