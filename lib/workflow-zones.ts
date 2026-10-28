import type { CanvasZone, Workflow } from './aegis-types';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import { getWorkflowCanvasLinks } from './workflow-policy-canvas.ts';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import { nodeDefinitions, visibleLayoutKey } from './workflow-layout.ts';

type ZoneGraph = { keys:string[]; outgoing:Map<string,string[]>; incoming:Map<string,string[]>; order:string[] };

/** Display adjacency follows the real graph, never the distance between cards. */
function graphForZones(workflow:Workflow):ZoneGraph {
  const keys=nodeDefinitions(workflow).map(node=>node.key),known=new Set(keys);
  const outgoing=new Map(keys.map(key=>[key,[] as string[]])),incoming=new Map(keys.map(key=>[key,[] as string[]]));
    for(const edge of getWorkflowCanvasLinks(workflow)){
      const {from,to}=edge;
      if(!from||!to||from===to||!known.has(from)||!known.has(to)||outgoing.get(from)!.includes(to))continue;
      outgoing.get(from)!.push(to);incoming.get(to)!.push(from);
    }
  const degrees=new Map(keys.map(key=>[key,incoming.get(key)!.length]));
  const pending=keys.filter(key=>degrees.get(key)===0),order:string[]=[];
  while(pending.length){const key=pending.shift()!;order.push(key);for(const next of outgoing.get(key)!){degrees.set(next,degrees.get(next)!-1);if(degrees.get(next)===0)pending.push(next);}}
  // Incomplete draft graphs still need bounded repair. Cycles are rejected by
  // execution validation; unresolved display nodes retain deterministic order.
  for(const key of keys)if(!order.includes(key))order.push(key);
  return {keys,outgoing,incoming,order};
}
function reachable(start:string,edges:Map<string,string[]>,only?:Set<string>):Set<string>{
  const visited=new Set<string>(),pending=[start];
  while(pending.length){const key=pending.pop()!;if(visited.has(key)||only&&!only.has(key))continue;visited.add(key);for(const next of edges.get(key)??[])pending.push(next);}
  return visited;
}
export function normalizedZoneNodeKeys(workflow:Workflow,keys:readonly string[]):string[]{
  return [...new Set(keys.map(key=>visibleLayoutKey(workflow,key)).filter((key):key is string=>Boolean(key)))];
}
function membershipIssue(graph:ZoneGraph,keys:readonly string[]):string|undefined {
  if(keys.length<2)return;
  const selected=new Set(keys),visited=new Set<string>(),pending=[keys[0]];
  while(pending.length){const key=pending.pop()!;if(visited.has(key)||!selected.has(key))continue;visited.add(key);pending.push(...graph.outgoing.get(key)??[],...graph.incoming.get(key)??[]);}
  if(visited.size!==selected.size)return '영역에는 흐름에서 이어진 노드만 포함할 수 있습니다. 떨어진 노드 사이의 노드도 함께 선택하세요.';
  // Every path between selected endpoints must stay inside the area. A direct
  // shortcut must not make it possible to skip the middle of another branch.
  const forward=new Set<string>(),backward=new Set<string>();
  for(const key of selected){for(const next of reachable(key,graph.outgoing))forward.add(next);for(const previous of reachable(key,graph.incoming))backward.add(previous);}
  if(graph.keys.some(key=>!selected.has(key)&&forward.has(key)&&backward.has(key)))return '영역 사이에 빠진 노드가 있습니다. 선택한 노드 사이의 모든 경로를 함께 포함하세요.';
}
/** Empty areas are placeholders; one card is also a contiguous area. */
export function zoneMembershipIssue(workflow:Workflow,keys:readonly string[]):string|undefined {
  if(keys.some(key=>!visibleLayoutKey(workflow,key)))return '영역에 없는 노드가 포함되어 있습니다. 현재 흐름의 노드를 다시 선택하세요.';
  return membershipIssue(graphForZones(workflow),normalizedZoneNodeKeys(workflow,keys));
}
/** Suggest display members only. The caller still checks transfers from other areas. */
export function completeZoneSelection(workflow:Workflow,keys:readonly string[]):{nodeKeys:string[];missingKeys:string[];issue?:string} {
  const graph=graphForZones(workflow),original=normalizedZoneNodeKeys(workflow,keys),selected=new Set(original);
  if(keys.some(key=>!visibleLayoutKey(workflow,key)))return {nodeKeys:original,missingKeys:[],issue:'현재 흐름에 없는 노드가 있습니다.'};
  // Connect separate selected components by the shortest undirected graph path,
  // then include every directed path between the resulting endpoints.
  for(let pass=0;pass<graph.keys.length&&membershipIssue(graph,[...selected]);pass++){
    const first=[...selected][0];if(!first)break;
    const connected=new Set<string>(),stack=[first];
    while(stack.length){const key=stack.pop()!;if(connected.has(key)||!selected.has(key))continue;connected.add(key);stack.push(...graph.outgoing.get(key)??[],...graph.incoming.get(key)??[]);}
    const previous=new Map<string,string|null>([...connected].map(key=>[key,null]));
    const queue=[...connected];let target:string|undefined;
    while(queue.length&&!target){const key=queue.shift()!;for(const next of [...graph.incoming.get(key)??[],...graph.outgoing.get(key)??[]]){if(previous.has(next))continue;previous.set(next,key);queue.push(next);if(selected.has(next)&&!connected.has(next)){target=next;break;}}}
    if(target){for(let key:string|null=target;key!==null;key=previous.get(key)??null)selected.add(key);}
    const forward=new Set<string>(),backward=new Set<string>();
    for(const key of selected){for(const next of reachable(key,graph.outgoing))forward.add(next);for(const prior of reachable(key,graph.incoming))backward.add(prior);}
    const before=selected.size;for(const key of graph.keys)if(forward.has(key)&&backward.has(key))selected.add(key);
    if(!target&&before===selected.size)break;
  }
  const nodeKeys=graph.order.filter(key=>selected.has(key));
  return {nodeKeys,missingKeys:nodeKeys.filter(key=>!original.includes(key)),issue:membershipIssue(graph,nodeKeys)};
}
export function workflowZoneIssues(workflow:Workflow):{zoneId:string;message:string}[]{
  return (workflow.layout?.zones??[]).flatMap(zone=>{const message=zoneMembershipIssue(workflow,zone.nodeKeys);return message?[{zoneId:zone.id,message:`${zone.name}: ${message}`}]:[];});
}
export type ContiguousZoneRepair = {workflow:Workflow;changed:boolean;splitCount:number;ungroupedKeys:string[]};

/** Repair only presentation metadata. Cards and execution edges are untouched. */
export function reconcileContiguousZoneResult(workflow:Workflow):ContiguousZoneRepair {
  const source=workflow.layout?.zones;
  if(!source?.length)return {workflow,changed:false,splitCount:0,ungroupedKeys:[]};
  const graph=graphForZones(workflow),next=structuredClone(workflow),zones:CanvasZone[]=[],claimed=new Set<string>(),usedIds=new Set(source.map(zone=>zone.id));
  const extra:{source:CanvasZone;keys:string[];part:number}[]=[],ungroupedKeys:string[]=[];
  let splitCount=0;
  for(const zone of source){
    const keys=normalizedZoneNodeKeys(workflow,zone.nodeKeys).filter(key=>!claimed.has(key));
    for(const key of keys)claimed.add(key);
    if(!membershipIssue(graph,keys)){zones.push({...structuredClone(zone),nodeKeys:keys});continue;}
    const ordered=graph.order.filter(key=>keys.includes(key)),parts:string[][]=[];
    // Greedy additions are validated against the full graph, so every final
    // piece is connected and cannot skip a middle node, including branch paths.
    for(const key of ordered){const part=parts.find(part=>!membershipIssue(graph,[...part,key]));if(part)part.push(key);else parts.push([key]);}
    zones.push({...structuredClone(zone),nodeKeys:parts[0]??[]});
    parts.slice(1).forEach((keys,index)=>extra.push({source:zone,keys,part:index+2}));
    splitCount+=Math.max(0,parts.length-1);
  }
  for(const entry of extra){
    if(zones.length>=32){ungroupedKeys.push(...entry.keys);continue;}
    let suffix=entry.part,id=`${entry.source.id.slice(0,80)}-part-${suffix}`;
    while(usedIds.has(id))id=`${entry.source.id.slice(0,80)}-part-${++suffix}`;
    usedIds.add(id);zones.push({...structuredClone(entry.source),id,name:`${entry.source.name.slice(0,85)} ${entry.part}`,nodeKeys:entry.keys});
  }
  next.layout={...next.layout!,zones};
  const changed=JSON.stringify(source)!==JSON.stringify(zones);
  return {workflow:changed?next:workflow,changed,splitCount,ungroupedKeys};
}
export function reconcileContiguousZones(workflow:Workflow):Workflow{return reconcileContiguousZoneResult(workflow).workflow;}
