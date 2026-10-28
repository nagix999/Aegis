// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policyExpectationErrors } from './output-expectations.ts';
import type { PolicyDefinition, PolicyRevision, PolicyRoute, PolicyRouting } from './aegis-types';
// @ts-expect-error Node's source test runner resolves explicit TypeScript imports.
import { createPolicyGraph, policyGraphErrors } from './policy-graph.ts';

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
export function policyOutputSchema(policy: Pick<PolicyDefinition, 'decisions'|'formatVersion'|'outputSchema'>): Record<string,unknown> {
  if (policy.formatVersion === 2) return structuredClone(policy.outputSchema ?? {});
  return { type: 'object', properties: { decision: { type: 'string', enum: policy.decisions.map(item => item.code) } }, required: ['decision'], additionalProperties: false };
}

export function policyDefinitionErrors(policy: PolicyDefinition): string[] {
  if (policy?.formatVersion === 2) {
    const errors: string[] = [];
    if (['id','name','description','prompt','connectionId'].some(key => typeof (policy as unknown as Record<string,unknown>)[key] !== 'string')) return ['정책 기본 정보의 형식을 확인하세요.'];
    if (!policy.name.trim() || policy.name.length > 100) errors.push('정책 이름은 1~100자로 입력하세요.');
    if (policy.description.length > 1000 || !policy.prompt.trim() || policy.prompt.length > 4000) errors.push('정책 설명은 1,000자, 지시문은 1~4,000자로 입력하세요.');
    if (!policy.connectionId) errors.push('정책 검사 모델을 선택하세요.');
    if (!Array.isArray(policy.decisions) || policy.decisions.length) errors.push('새 출력 형식은 고정 판정 코드를 사용하지 않습니다.');
    if (!policy.outputSchema || typeof policy.outputSchema !== 'object' || Array.isArray(policy.outputSchema) || new TextEncoder().encode(JSON.stringify(policy.outputSchema)).length > 32768) errors.push('출력 스키마는 32KiB 이내 JSON 객체로 입력하세요.');
    if (policy.maxOutputTokens !== undefined && (!Number.isInteger(policy.maxOutputTokens) || policy.maxOutputTokens < 256 || policy.maxOutputTokens > 4096)) errors.push('출력 토큰 한도는 256~4,096으로 입력하세요.');
    if (!Array.isArray(policy.examples) || policy.examples.length < 1 || policy.examples.length > 30) errors.push('검증 예제를 1~30개 등록하세요.');
    else {
      if (new Set(policy.examples.map(e=>e.id)).size !== policy.examples.length || new Set(policy.examples.map(e=>e.input)).size !== policy.examples.length) errors.push('예제 ID와 요청은 중복할 수 없습니다.');
      for (const example of policy.examples) errors.push(...policyExpectationErrors(example,policy.outputSchema));
      for (const example of policy.examples) if (!example || typeof example.input !== 'string' || !example.input.trim() || example.input.length > 16000 || !Object.prototype.hasOwnProperty.call(example,'expectedOutput') || example.expectedOutput === undefined) errors.push('예제 요청과 예상 JSON 출력을 입력하세요.');
    }
    return [...new Set(errors)];
  }
  if (!policy || typeof policy !== 'object' || ['id','name','description','prompt','connectionId'].some(key => typeof (policy as unknown as Record<string, unknown>)[key] !== 'string') || !Array.isArray(policy.decisions) || !Array.isArray(policy.examples)) return ['정책 이름, 지시문, 모델과 판정 코드 및 예제 형식을 확인하세요.'];
  if (policy.decisions.some(item => !item || typeof item !== 'object' || ['code','label','description'].some(key => typeof (item as unknown as Record<string, unknown>)[key] !== 'string')) || policy.examples.some(item => !item || typeof item !== 'object' || ['id','input','expectedDecision'].some(key => typeof (item as unknown as Record<string, unknown>)[key] !== 'string'))) return ['정책의 판정 코드와 예제 필드 형식을 확인하세요.'];
  const errors: string[] = [];
  if (!policy.name.trim() || policy.name.length > 100) errors.push('정책 이름은 1~100자로 입력하세요.');
  if (policy.description.length > 1000) errors.push('정책 설명은 1,000자 이내로 입력하세요.');
  if (!policy.prompt.trim() || policy.prompt.length > 4000) errors.push('판정 지시문은 1~4,000자로 입력하세요.');
  if (!policy.connectionId) errors.push('정책 검사 모델을 선택하세요.');
  if (policy.decisions.length < 2 || policy.decisions.length > 12) errors.push('판정 코드를 2~12개 등록하세요.');
  if (new Set(policy.decisions.map(item => item.code)).size !== policy.decisions.length) errors.push('판정 코드는 중복할 수 없습니다.');
  for (const item of policy.decisions) {
    if (!codePattern.test(item.code)) errors.push('판정 코드는 대문자로 시작하는 영문, 숫자, 밑줄로 최대 64자 입력하세요.');
    if (!item.label.trim() || item.label.length > 80) errors.push('판정 이름은 1~80자로 입력하세요.');
    if (item.description.length > 1000) errors.push('판정 설명은 1,000자 이내로 입력하세요.');
  }
  if (policy.examples.length < 1 || policy.examples.length > 30) errors.push('검증 예제를 1~30개 등록하세요.');
  if (new Set(policy.examples.map(item => item.id)).size !== policy.examples.length) errors.push('예제 ID는 중복할 수 없습니다.');
  if (new Set(policy.examples.map(item => item.input)).size !== policy.examples.length) errors.push('예제 요청 내용은 중복할 수 없습니다.');
  for (const item of policy.examples) {
    if (!item.input.trim() || item.input.length > 16000) errors.push('예제 요청은 1~16,000자로 입력하세요.');
    if (!policy.decisions.some(decision => decision.code === item.expectedDecision)) errors.push('예제의 예상 판정은 등록한 코드에서 선택하세요.');
  }
  return [...new Set(errors)];
}

export function bindPolicyRevision(policy: PolicyRevision, previousRoutes: PolicyRoute[] = []): PolicyRouting {
  if (policy.formatVersion === 2) return {policy:structuredClone(policy),routes:[],graph:createPolicyGraph()};
  return { policy: structuredClone(policy), routes: policy.decisions.map(item => {
    const existing = previousRoutes.find(route => route.decision === item.code);
    if (existing) return structuredClone(existing);
    if (item.code === 'IN_SCOPE') return { decision: item.code, action: 'main' as const };
    if (item.code === 'OUT_OF_SCOPE') return { decision: item.code, action: 'respond' as const, responseText: '이 서비스의 안내 범위를 벗어난 요청입니다.' };
    return { decision: item.code, action: 'error' as const, errorCode: item.code, errorMessage: '정책에 따라 요청이 제한되었습니다.' };
  }) };
}

export function changePolicyRouteAction(route: PolicyRoute, action: PolicyRoute['action']): PolicyRoute {
  if (action === 'main') return { decision: route.decision, action };
  if (action === 'respond') return { decision: route.decision, action, responseText: route.responseText ?? '' };
  return { decision: route.decision, action, errorCode: route.errorCode ?? route.decision, errorMessage: route.errorMessage ?? '정책에 따라 요청이 제한되었습니다.' };
}

export function policyRoutingErrors(routing: PolicyRouting): string[] {
  if (!routing || typeof routing !== 'object' || !routing.policy || !Array.isArray(routing.routes)) return ['정책 분기 설정의 형식을 확인하세요.'];
  const errors = policyDefinitionErrors(routing.policy);
  if (errors.length) return errors;
  if (routing.routes.some(item => !item || typeof item !== 'object' || typeof item.decision !== 'string')) return ['정책의 판정별 실행 경로 형식을 확인하세요.'];
  if (!routing.policy.connectionSnapshot || !['guard','both'].includes(routing.policy.connectionSnapshot.role)) errors.push('정책 검사에 사용할 검사 모델을 선택하세요.');
  if (routing.policy.formatVersion === 2) {
    if (routing.routes.length) errors.push('새 출력 형식은 판정 코드별 경로를 사용하지 않습니다.');
    return [...errors,...(routing.graph ? policyGraphErrors(routing.graph,policyOutputSchema(routing.policy)) : ['출력 분기, 룰과 액션을 연결하세요.'])];
  }
  if (routing.graph) errors.push('기존 판정 형식은 정책 그래프를 사용할 수 없습니다.');
  const decisions = new Set(routing.policy.decisions.map(item => item.code));
  if (routing.routes.length !== decisions.size || new Set(routing.routes.map(item => item.decision)).size !== decisions.size || routing.routes.some(item => !decisions.has(item.decision))) errors.push('모든 판정에 실행 경로를 하나씩 지정하세요.');
  for (const route of routing.routes) {
    if (!['main', 'respond', 'error'].includes(route.action)) errors.push('판정별 실행 경로를 선택하세요.');
    if (route.action === 'respond' && (typeof route.responseText !== 'string' || !route.responseText.trim() || route.responseText.length > 4000)) errors.push('등록 안내 응답은 1~4,000자로 입력하세요.');
    if (route.action === 'error' && (typeof route.errorCode !== 'string' || !codePattern.test(route.errorCode))) errors.push('공개 오류 코드를 대문자 영문, 숫자, 밑줄로 최대 64자 입력하세요.');
    if (route.action === 'error' && (typeof route.errorMessage !== 'string' || !route.errorMessage.trim() || route.errorMessage.length > 500)) errors.push('공개 오류 메시지는 1~500자로 입력하세요.');
  }
  return [...new Set(errors)];
}

/** Keep a bound snapshot independent of later policy and connection edits. */
export function policyExecutionConfiguration(routing: PolicyRouting) {
  const { id: _id, name: _name, description: _description, version: _version, updatedAt: _updatedAt, connectionSnapshot, ...policy } = routing.policy;
  const { name: _connectionName, ...connection } = connectionSnapshot;
  return { policy: { ...policy, connectionSnapshot: connection }, ...(routing.graph ? {graph:{...routing.graph,nodes:routing.graph.nodes.map(({name:_name,...node})=>node)}} : {}), routes: routing.routes.map(route => ({ decision: route.decision, action: route.action,
    ...(route.action === 'respond' ? { responseText: route.responseText } : {}),
    ...(route.action === 'error' ? { errorCode: route.errorCode, errorMessage: route.errorMessage } : {}),
  })) };
}
