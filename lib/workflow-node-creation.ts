import type { RuleGroup, Workflow } from './aegis-types';
// @ts-expect-error Node's source test runner resolves explicit TypeScript imports.
import { captureInsertTarget, insertCheckOnEdge, type FlowInsertTarget, type FlowPort, type FlowStage } from './workflow-connections.ts';
// @ts-expect-error Node's source test runner resolves explicit TypeScript imports.
import { getStageGraph, graphNodeKeys } from './workflow-graph.ts';
// @ts-expect-error Node's source test runner resolves explicit TypeScript imports.
import { buildBranchSelection, previewBranchSelection, type BranchBuildOptions } from './workflow-branching.ts';

export type ParallelCheckPreview = {
  valid:boolean;
  reason?:string;
  mode:'beside-existing'|'new-paths';
  minimumNodes:1|2;
  existingGroupId?:string;
};

function requireThat(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
const portOf=(target:{port?:FlowPort})=>target.port??'next';
function currentTarget(workflow:Workflow,target:FlowInsertTarget):FlowInsertTarget {
  requireThat(target&&(target.workflowId===undefined||target.workflowId===workflow.id),'노드를 추가할 워크플로우가 변경되었습니다. 현재 연결선을 다시 선택하세요.');
  const captured=captureInsertTarget(workflow,target.stage,target.edgeId);
  requireThat(captured.from===target.from&&captured.to===target.to&&portOf(captured)===portOf(target),'노드를 추가할 연결이 변경되었습니다. 현재 연결선을 다시 선택하세요.');
  return captured;
}
function capacityReason(workflow:Workflow,stage:FlowStage,newChecks:number,extraEdges:number):string|undefined {
  const graph=getStageGraph(workflow,stage);
  if(workflow[stage].length+newChecks>36)return `검사를 추가하면 검사 노드 한도 36개를 초과합니다.`;
  if(graph.nodes.length+2>12)return '병렬 분기와 결과 합류를 추가하려면 제어 노드 두 개의 공간이 필요합니다. 구간별 한도는 12개입니다.';
  if(graph.edges.length+extraEdges>64)return '병렬 경로를 추가하면 연결선 한도 64개를 초과합니다.';
  return undefined;
}

/** Captures the exact outgoing edge(s) represented by a dragged output port. */
export function captureCreationTargets(workflow:Workflow,stage:FlowStage,from:string,port:FlowPort='next'):FlowInsertTarget[] {
  requireThat(stage==='pre'||stage==='post','요청 검사 또는 응답 검사 구간을 선택하세요.');
  const graph=getStageGraph(workflow,stage);
  requireThat(graphNodeKeys(workflow,stage).includes(from)&&from!=='end','새 노드를 연결할 출발 노드를 확인하세요.');
  requireThat(port==='next'||port==='true'||port==='false','새 노드를 연결할 포트를 확인하세요.');
  const control=graph.nodes.find(node=>`control:${node.id}`===from);
  requireThat(control?.kind==='condition'?(port==='true'||port==='false'):port==='next','조건 노드는 조건 충족 또는 그 외 포트를 선택하고 다른 노드는 기본 연결점을 사용하세요.');
  return graph.edges.filter(edge=>edge.from===from&&portOf(edge)===port).map(edge=>captureInsertTarget(workflow,stage,edge.id));
}

/** A branch beside a following check uses one new node; boundaries use two new paths. */
export function previewParallelCheckOnEdge(workflow:Workflow,target:FlowInsertTarget):ParallelCheckPreview {
  const fallback:ParallelCheckPreview={valid:false,mode:'new-paths',minimumNodes:2};
  try {
    const captured=currentTarget(workflow,target),graph=getStageGraph(workflow,captured.stage);
    const existing=captured.to.startsWith('group:')?workflow[captured.stage].find(group=>`group:${group.id}`===captured.to):undefined;
    const incoming=graph.edges.filter(edge=>edge.to===captured.to),outgoing=graph.edges.filter(edge=>edge.from===captured.to);
    if(existing&&!existing.required&&incoming.length===1&&outgoing.length===1&&portOf(outgoing[0])==='next'){
      const reason=capacityReason(workflow,captured.stage,1,4);
      return {valid:!reason,mode:'beside-existing',minimumNodes:1,existingGroupId:existing.id,...(reason?{reason}:{})};
    }
    const reason=capacityReason(workflow,captured.stage,2,5);
    return {valid:!reason,mode:'new-paths',minimumNodes:2,reason:reason??(existing?.required?'필수 검사는 그대로 유지하고 그 앞에 새 검사 두 개의 병렬 경로를 만듭니다.':'새 검사 두 개를 병렬로 실행하고 기존 다음 노드로 합류합니다.')};
  }catch(error){return {...fallback,reason:error instanceof Error?error.message:'현재 연결에 병렬 경로를 추가할 수 없습니다.'};}
}

export function previewParallelChecksOnEdge(workflow:Workflow,target:FlowInsertTarget,count=2):ParallelCheckPreview {
  const preview:ParallelCheckPreview={valid:false,mode:'new-paths',minimumNodes:2};
  try {
    const captured=currentTarget(workflow,target);
    requireThat(Number.isInteger(count)&&count>=2&&count<=4,'동시에 실행할 새 검사 두 개에서 네 개를 선택하세요.');
    const reason=capacityReason(workflow,captured.stage,count,2*count+1);
    return {...preview,valid:!reason,...(reason?{reason}:{})};
  }catch(error){return {...preview,reason:error instanceof Error?error.message:'현재 연결에 병렬 경로를 추가할 수 없습니다.'};}
}

/** Applies one complete fork/join edit as a single immutable history operation. */
export function addParallelCheckOnEdge(workflow:Workflow,target:FlowInsertTarget,newGroupOrGroups:RuleGroup|RuleGroup[],options:BranchBuildOptions={}):{workflow:Workflow;splitId:string;joinId:string} {
  const groups=Array.isArray(newGroupOrGroups)?newGroupOrGroups:[newGroupOrGroups];
  if(groups.length!==1)return addParallelChecksOnEdge(workflow,target,groups,options);
  const captured=currentTarget(workflow,target),preview=previewParallelCheckOnEdge(workflow,captured);
  requireThat(preview.valid,preview.reason??'현재 연결에 병렬 경로를 추가할 수 없습니다.');
  requireThat(preview.mode==='beside-existing'&&preview.existingGroupId,'이 위치에는 새 검사를 두 개 이상 선택해 병렬 경로를 만드세요.');
  const inserted=insertCheckOnEdge(workflow,captured,groups[0]);
  const selection=previewBranchSelection(inserted,captured.stage,[groups[0].id,preview.existingGroupId]);
  requireThat(selection.valid,selection.reason??'선택한 검사로 병렬 경로를 만들 수 없습니다.');
  return buildBranchSelection(inserted,selection,options);
}

/** Builds two to four NEW parallel checks before the selected edge's original target. */
export function addParallelChecksOnEdge(workflow:Workflow,target:FlowInsertTarget,newGroups:RuleGroup[],options:BranchBuildOptions={}):{workflow:Workflow;splitId:string;joinId:string} {
  requireThat(Array.isArray(newGroups),'새 검사 목록을 확인하세요.');
  const captured=currentTarget(workflow,target),preview=previewParallelChecksOnEdge(workflow,captured,newGroups.length);
  requireThat(preview.valid,preview.reason??'현재 연결에 병렬 경로를 추가할 수 없습니다.');
  let next=workflow,current=captured;
  for(const group of newGroups){
    next=insertCheckOnEdge(next,current,group);
    const outgoing=getStageGraph(next,captured.stage).edges.find(edge=>edge.from===`group:${group.id}`&&edge.to===captured.to);
    requireThat(outgoing,'새 검사 뒤의 연결을 찾지 못했습니다.');
    current=captureInsertTarget(next,captured.stage,outgoing.id);
  }
  const selection=previewBranchSelection(next,captured.stage,newGroups.map(group=>group.id));
  requireThat(selection.valid,selection.reason??'선택한 검사로 병렬 경로를 만들 수 없습니다.');
  return buildBranchSelection(next,selection,options);
}
