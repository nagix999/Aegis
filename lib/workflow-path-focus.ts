import type { Workflow } from './aegis-types';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { getWorkflowCanvasLinks } from './workflow-policy-canvas.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { nodeDefinitions } from './workflow-layout.ts';

/** Presentation only: ancestors and descendants through actual directed edges. */
export function workflowPathFocus(workflow:Workflow,nodeKey:string):{nodes:Set<string>;edges:Set<string>}|undefined {
  const keys=new Set(nodeDefinitions(workflow).map(node=>node.key));
  if(!keys.has(nodeKey))return undefined;
  const links=getWorkflowCanvasLinks(workflow).filter(edge=>keys.has(edge.from)&&keys.has(edge.to));
  const walk=(direction:'from'|'to')=>{
    const seen=new Set([nodeKey]),queue=[nodeKey];
    for(let index=0;index<queue.length;index++)for(const edge of links){
      const match=direction==='from'?edge.to:edge.from,next=direction==='from'?edge.from:edge.to;
      if(match===queue[index]&&!seen.has(next)){seen.add(next);queue.push(next);}
    }
    return seen;
  };
  const ancestors=walk('from'),descendants=walk('to');
  return {nodes:new Set([...ancestors,...descendants]),edges:new Set(links.filter(edge=>ancestors.has(edge.from)&&ancestors.has(edge.to)||descendants.has(edge.from)&&descendants.has(edge.to)).map(edge=>edge.id))};
}
