import type { Connection, Rule, RuleKind, Workflow } from './aegis-types';
import type { CanvasNode, WorkflowSelection } from './workflow-layout';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { nodeDefinitions, visibleLayoutKey } from './workflow-layout.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { connectionLabel } from './product-copy.ts';

export type WorkflowSearchResult = {
  key: string;
  node: CanvasNode;
  selection: WorkflowSelection;
  name: string;
  typeLabel: string;
  stageLabel: string;
  zoneNames: string[];
  matchedRuleNames: string[];
};

const ruleLabels: Record<RuleKind, string> = {
  keyword: '금지 키워드', regex: '정규식 검사', length: '글자 수 제한', llm: '모델 검사',
  pii: '개인정보 형식', json: 'JSON 형식', required: '필수 문구',
};
const ruleAliases: Record<RuleKind, string> = {
  keyword: 'keyword 키워드 금지어', regex: 'regex regexp 정규식', length: 'length 글자 길이',
  llm: 'llm model 모델 정책', pii: 'pii privacy 개인정보', json: 'json 형식 문법', required: 'required 필수 문구',
};
const controlLabels = { condition: '조건 분기', fork: '병렬 분기', join: '결과 합류' };
const controlAliases = { condition: 'condition conditional 조건 분기', fork: 'fork parallel 병렬 동시 분기', join: 'join merge 합류 병합' };
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const ruleText = (rule: Rule) => `${rule.name} ${rule.description} ${ruleLabels[rule.kind]} ${ruleAliases[rule.kind]}`;

/** Search finds visible cards only; matching a hidden rule keeps its compound card as the destination. */
export function searchWorkflowNodes(workflow: Workflow, connections: Connection[], query: string): WorkflowSearchResult[] {
  const tokens = normalize(query).split(' ').filter(Boolean);
  const main = connections.find(connection => connection.id === workflow.mainConnectionId);
  const policy = workflow.policyRouting?.policy;
  return nodeDefinitions(workflow).flatMap(node => {
    const group = node.stage ? workflow[node.stage].find(candidate => candidate.id === node.groupId) : undefined;
    const rule = node.kind === 'rule' ? group?.rules.find(candidate => candidate.id === node.id) : undefined;
    const controls = node.stage ? workflow.graph?.[node.stage]?.nodes : undefined;
    const control = node.kind === 'control' && Array.isArray(controls) ? controls.find(candidate => candidate.id === node.id) : undefined;
    const controlKind = control?.kind || node.controlKind;
    const policyNode = node.kind === 'policy-node' ? workflow.policyRouting?.graph?.nodes.find(item => item.id === node.id) : undefined;
    const zoneNames = [...new Set((workflow.layout?.zones || []).filter(zone => zone.nodeKeys.some(key => visibleLayoutKey(workflow, key) === node.key)).map(zone => zone.name))];
    const name = node.kind === 'input' ? '최초 입력' : node.kind === 'output' ? '최종 출력' : node.kind === 'main' ? main ? connectionLabel(main.name) : '응답 모델 선택'
      : node.kind === 'policy' ? policy?.name || '정책 모델' : node.kind === 'policy-node' ? policyNode?.name || '정책 노드' : node.kind === 'group' ? group?.name || '검사 조합' : node.kind === 'control' ? control?.name || '제어 노드' : rule?.name || '검사';
    const typeLabel = node.kind === 'input' ? '입력' : node.kind === 'output' ? '출력' : node.kind === 'main' ? '응답 생성'
      : node.kind === 'policy' ? '정책 모델' : node.kind === 'policy-node' ? policyNode?.kind === 'action' ? '정책 액션' : '조건 분기' : node.kind === 'group' ? '검사 조합' : node.kind === 'control' ? controlKind ? controlLabels[controlKind] : '제어 노드' : rule ? ruleLabels[rule.kind] : '검사';
    const stageLabel = node.kind === 'policy' || node.kind === 'policy-node' ? '정책 흐름' : node.stage === 'pre' ? '요청 검사' : node.stage === 'post' ? '응답 검사' : node.kind === 'input' ? '요청 입력' : node.kind === 'output' ? '응답 반환' : '응답 생성';
    const aliases = node.kind === 'input' ? 'input start request 입력 시작 요청' : node.kind === 'output' ? 'output end response 출력 반환 응답' : node.kind === 'main' ? `main llm model generation 응답 생성 모델 ${main?.name || ''} ${main?.model || ''}`
      : node.kind === 'policy' ? `policy llm structured output 정책 검사 모델 ${policy?.description || ''} ${policy?.connectionSnapshot.name || ''} ${policy?.connectionSnapshot.model || ''} v${policy?.version || ''}`
      : node.kind === 'policy-node' ? `policy 정책 ${policyNode?.kind || ''} ${policyNode?.kind === 'action' ? `${policyNode.action} ${policyNode.action === 'main' ? '응답 생성 모델' : policyNode.action === 'respond' ? '안내 응답' : `오류 차단 ${policyNode.errorCode || ''}`}` : `condition conditional branch rule 조건 분기 경로 룰 ${policyNode?.condition.predicates.map(predicate => `${predicate.path} ${predicate.operator}`).join(' ') || ''}`}`
      : node.kind === 'control' ? controlKind ? controlAliases[controlKind] : 'control 제어' : `${node.kind === 'group' ? 'group composite 조합' : 'rule 검사'} ${group?.rules.map(ruleText).join(' ') || ''}`;
    const stageAliases = node.stage === 'pre' ? 'pre request 요청' : node.stage === 'post' ? 'post response 응답' : '';
    const searchable = normalize(`${name} ${typeLabel} ${stageLabel} ${stageAliases} ${aliases} ${zoneNames.join(' ')}`);
    if (!tokens.every(token => searchable.includes(token))) return [];
    const matchedRuleNames = node.kind === 'group' && tokens.length
      ? [...new Set((group?.rules || []).filter(child => tokens.some(token => normalize(ruleText(child)).includes(token))).map(child => child.name))] : [];
    const selection: WorkflowSelection = node.kind === 'rule' || node.kind === 'group' || node.kind === 'control' || node.kind === 'policy-node' ? { kind: node.kind, id: node.id } : { kind: node.kind };
    return [{ key: node.key, node, selection, name, typeLabel, stageLabel, zoneNames, matchedRuleNames }];
  });
}
