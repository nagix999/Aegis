import type { PolicyRouting, Rule } from './aegis-types';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { policyConditionErrors } from './policy-graph.ts';

/** Locate existing validation failures without changing save or runtime rules. */
export function ruleIssueField(rule: Rule, message: string): string {
  if (message.includes('ID, 이름') || message.includes('이름을')) return 'name';
  if (rule.kind === 'llm') return message.includes('모델') && !message.includes('지시문') ? 'connectionId' : 'prompt';
  return ({keyword:'pattern',regex:'pattern',required:message.includes('통과 조건')?'matchMode':'pattern',length:'maxLength',pii:'piiTypes',json:message.includes('필수 키')?'requiredKeys':'jsonMode'} as Record<string,string>)[rule.kind] || 'name';
}

export type PolicyNodeInputIssue = { nodeId?: string; predicateIndex?: number; field: string; message: string };
export function policyNodeInputIssues(routing: PolicyRouting): PolicyNodeInputIssue[] {
  const graph=routing.graph;
  if(routing.policy.formatVersion!==2||!graph)return [];
  const issues:PolicyNodeInputIssue[]=[];
  if(!graph.nodes.length)return [{field:'entry',message:'조건 분기와 액션을 하나씩 추가하고 참과 거짓 경로를 연결하세요.'}];
  if(!graph.nodes.some(node=>node.id===graph.entryNodeId&&node.kind!=='action'))issues.push({field:'entry',message:'정책 출력에 연결할 첫 조건 분기를 선택하세요.'});
  for(const node of graph.nodes){
    if(!node.name.trim())issues.push({nodeId:node.id,field:'name',message:'노드 이름을 입력하세요.'});
    if(node.kind!=='action'){
      for(const port of ['true','false'] as const)if(graph.edges.filter(edge=>edge.from===node.id&&edge.port===port).length!==1)issues.push({nodeId:node.id,field:`edge.${port}`,message:`${port==='true'?'참':'거짓'} 경로의 다음 노드를 하나 연결하세요.`});
      node.condition.predicates.forEach((predicate,predicateIndex)=>{
        for(const message of policyConditionErrors({...node.condition,predicates:[predicate]}))issues.push({nodeId:node.id,predicateIndex,field:message.includes('필드 경로')?'path':'value',message});
      });
    }else if(node.action==='respond'&&(!node.responseText?.trim()||node.responseText.length>4000))issues.push({nodeId:node.id,field:'responseText',message:'등록 안내 응답을 1~4,000자로 입력하세요.'});
    else if(node.action==='error'){
      if(!node.errorCode||!/^[A-Z][A-Z0-9_]{0,63}$/.test(node.errorCode))issues.push({nodeId:node.id,field:'errorCode',message:'공개 오류 코드를 대문자, 숫자와 밑줄로 입력하세요.'});
      if(!node.errorMessage?.trim()||node.errorMessage.length>500)issues.push({nodeId:node.id,field:'errorMessage',message:'공개 오류 메시지를 1~500자로 입력하세요.'});
    }
  }
  const reached=new Set<string>();
  const visit=(key:string)=>{if(reached.has(key))return;reached.add(key);for(const edge of graph.edges.filter(item=>item.from===key))visit(edge.to);};
  visit(graph.entryNodeId);
  for(const node of graph.nodes)if(!reached.has(node.id))issues.push({nodeId:node.id,field:'name',message:'시작 조건에서 이 노드로 이어지는 경로를 연결하세요.'});
  return issues;
}
