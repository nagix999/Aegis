import type { ConsoleExecutionInspection, ConsoleInspectionValue, ConsoleNodeInspection, ExecutionResult, Workflow } from './aegis-types';

/** Inspection belongs to the console response, never the persisted execution. */
export function inspectionForNode(inspection:ConsoleExecutionInspection|undefined,nodeId:string,attempt?:number):ConsoleNodeInspection[] {
  const nodes=inspection?.nodes.filter(node=>node.nodeId===nodeId)??[];
  return attempt===undefined?nodes:nodes.filter(node=>node.stage==='pre'||node.attempt===undefined||node.attempt===attempt);
}

export function inspectionValueText(value:ConsoleInspectionValue,inspection:ConsoleExecutionInspection,result:ExecutionResult,node?:ConsoleNodeInspection):string|undefined {
  if(value.availability!=='available')return;
  if(value.source==='request_messages')return JSON.stringify(inspection.request.messages,null,2);
  if(value.source==='request_inspection')return inspection.request.inspectionText;
  if(value.source==='final_response') {
    const last=Math.max(1,...(result.attempts??[]).map(item=>item.number),...result.traces.filter(trace=>trace.stage==='main'||trace.stage==='post').map(trace=>trace.attempt??1));
    if(result.status==='allow'&&(node?.attempt===undefined||node.attempt===last))return result.output;
  }
}

/** A current draft cannot supply the case value selected by an older execution. */
export function inspectionPortLabel(workflow:Workflow,nodeId:string,port:string,stale=false):string {
  if(stale)return port==='default'?'기본 경로 (default)':port;
  const node=workflow.policyRouting?.graph?.nodes.find(item=>nodeId===`policy-node:${item.id}`);
  return port==='default'?'기본 경로':node?.kind==='switch'?JSON.stringify(node.cases.find(item=>item.id===port)?.value)??port:port==='true'?'참':port==='false'?'거짓':port;
}
