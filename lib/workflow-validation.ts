// Browser-side form checks. Python remains authoritative for API execution.
import type { Connection, IngressPolicy, Workflow } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { MAX_RESPONSE_RETRIES } from './response-retry.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { executionLimitIssues } from './execution-plan.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { validateWorkflowGraph } from './workflow-graph.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policyRoutingErrors } from './policy-routing.ts';
const MAX_INPUT=40_000;
function str(value:unknown,maximum:number):value is string{return typeof value==='string'&&value.length>0&&value.length<=maximum;}
function trimmed(value:unknown):string{return typeof value==='string'?value.trim():'';}

function ipv4Number(ip: string): number | null {
  const pieces = ip.split('.');
  if (pieces.length !== 4 || pieces.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255 || (p.length > 1 && p[0] === '0'))) return null;
  return pieces.reduce((result, piece) => result * 256 + Number(piece), 0) >>> 0;
}
function parseCidr(cidr: string): { ip: number; mask: number } | null {
  const parts = cidr.split('/');
  if (parts.length > 2) return null;
  const ip = ipv4Number(parts[0]);
  const bits = parts.length === 1 ? 32 : /^\d{1,2}$/.test(parts[1]) ? Number(parts[1]) : -1;
  if (ip === null || bits < 0 || bits > 32) return null;
  return { ip, mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 };
}
export function ipv4Allowed(ip: string, cidrs: string[]): boolean {
  const address = ipv4Number(ip);
  if (address === null) return false;
  return cidrs.some(cidr => { const parsed = parseCidr(cidr); return parsed !== null && ((address & parsed.mask) >>> 0) === ((parsed.ip & parsed.mask) >>> 0); });
}

export function validateIngress(ingress: IngressPolicy): string[] {
  if (!ingress || typeof ingress !== 'object') return ['접근 설정을 확인하세요.'];
  const errors: string[] = [];
  if (typeof ingress.enabled !== 'boolean') errors.push('IP 허용 목록 사용 여부를 선택하세요.');
  if (!Array.isArray(ingress.allowedCidrs) || ingress.allowedCidrs.length > 64 || ingress.allowedCidrs.some(cidr => typeof cidr !== 'string' || !parseCidr(cidr))) errors.push('허용 IP는 IPv4 주소나 CIDR로 입력하세요. IPv6 주소는 지원하지 않습니다.');
  if (ingress.enabled && !ingress.allowedCidrs?.length) errors.push('IP 제한을 활성화하려면 허용 IP를 하나 이상 입력하세요.');
  if (!Array.isArray(ingress.allowedOrigins) || ingress.allowedOrigins.length > 64) errors.push('허용 모델 서버는 최대 64개까지 등록할 수 있습니다.');
  else for (const origin of ingress.allowedOrigins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) errors.push('허용 모델 서버 주소에는 HTTPS 주소와 포트만 입력하세요. 경로는 제외합니다. 예: https://vllm.example.com');
    } catch { errors.push('허용 모델 서버 주소를 확인하세요.'); }
  }
  return [...new Set(errors)];
}

export function validateConnection(connection: Connection): string[] {
  if (!connection || typeof connection !== 'object') return ['모델 서버 설정을 확인하세요.'];
  const errors: string[] = [];
  if (!str(connection.id, 100) || !str(trimmed(connection.name), 100)) errors.push('모델 서버 이름과 연결 ID를 입력하세요.');
  if (!str(trimmed(connection.model), 200)) errors.push('모델 ID를 입력하세요.');
  if (!['demo', 'vllm'].includes(connection.mode)) errors.push('모델 서버 연결 방식을 다시 선택하세요.');
  if (!['main', 'guard', 'both'].includes(connection.role)) errors.push('모델 역할을 선택하세요.');
  if (!Number.isInteger(connection.timeoutMs) || connection.timeoutMs < 1000 || connection.timeoutMs > 60_000) errors.push('응답 제한 시간은 1,000~60,000ms로 입력하세요.');
  if (typeof connection.secretEnv !== 'string' || (connection.secretEnv && !/^[A-Z][A-Z0-9_]{0,79}$/.test(connection.secretEnv))) errors.push('API 키를 저장한 환경변수 이름을 대문자로 입력하세요. 예: VLLM_API_KEY');
  if (connection.mode === 'vllm') {
    try {
      const url = new URL(connection.baseUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/[^?#]*v1\/?$/.test(url.pathname)) errors.push('API 기본 주소는 /v1으로 끝나는 HTTPS 주소로 입력하세요. 주소에 사용자 이름이나 비밀번호를 넣을 수 없습니다.');
    } catch { errors.push('vLLM 서버의 API 기본 주소를 확인하세요.'); }
  }
  return errors;
}

function validateRegex(pattern: string): string | null {
  if (!str(pattern, 1000)) return '정규식은 1~1,000자로 입력하세요.';
  // JS RegExp cannot be interrupted. Keep a bounded safe subset to avoid common catastrophic backtracking.
  if (/\\[1-9]|\(\?|\)[*+{]|(?:\*|\+|\{\d+(?:,\d*)?\})\s*(?:\*|\+|\{)/.test(pattern)) return '정규식에서 역참조, 전후방 탐색, 반복 그룹은 사용할 수 없습니다.';
  try { new RegExp(pattern, 'iu'); return null; } catch { return '정규식 문법을 확인하세요.'; }
}

export function validateWorkflow(workflow: Workflow, connections: Connection[]): string[] {
  if (!workflow || typeof workflow !== 'object') return ['워크플로우 설정을 확인하세요.'];
  const errors: string[] = [...executionLimitIssues(workflow)];
  if (workflow.policyRouting) errors.push(...policyRoutingErrors(workflow.policyRouting), ...validateConnection(workflow.policyRouting.policy.connectionSnapshot));
  if (workflow.responseRetry !== undefined) {
    const policy = workflow.responseRetry;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) errors.push('응답 재생성 설정을 확인하세요.');
    else {
      if (typeof policy.enabled !== 'boolean') errors.push('응답 재생성 사용 여부를 선택하세요.');
      if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 1 || policy.maxRetries > MAX_RESPONSE_RETRIES) errors.push(`최대 재생성 횟수는 1~${MAX_RESPONSE_RETRIES}회로 설정하세요.`);
      if (policy.instruction !== undefined && (typeof policy.instruction !== 'string' || policy.instruction.length > 2000)) errors.push('응답 재생성 지시문은 2,000자 이하로 입력하세요.');
    }
  }
  if (!str(workflow.id, 100) || !str(trimmed(workflow.name), 100)) errors.push('워크플로우 ID와 이름을 입력하세요.');
  if (typeof workflow.alias !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(workflow.alias)) errors.push('API 모델 이름은 영문, 숫자, 점, 밑줄, 하이픈으로 1~80자 입력하세요.');
  const main = connections.find(item => item.id === workflow.mainConnectionId);
  if (!main || !['main', 'both'].includes(main.role)) errors.push('응답 모델로 사용할 모델 서버를 선택하세요.');
  else errors.push(...validateConnection(main));
  const ids = new Set<string>();
  for (const [stage, groups] of [['요청 검사', workflow.pre], ['응답 검사', workflow.post]] as const) {
    if (!Array.isArray(groups) || groups.length > 36) { errors.push(`${stage}에는 검사 노드를 최대 36개까지 추가할 수 있습니다.`); continue; }
    for (const group of groups) {
      if (!group || !str(group.id, 100) || !str(trimmed(group.name), 100) || !['any', 'all'].includes(group.mode)) { errors.push(`${stage} 단계 이름과 차단 조건을 확인하세요.`); continue; }
      if (ids.has(group.id)) errors.push('단계 ID와 검사 ID는 서로 달라야 합니다.');
      ids.add(group.id);
      if (!Array.isArray(group.rules) || group.rules.length > 12) { errors.push('한 단계에는 검사를 최대 12개까지 추가할 수 있습니다.'); continue; }
      if (!group.rules.length) errors.push('검사 조합에 검사를 하나 이상 추가하세요.');
      for (const rule of group.rules) {
        if (!rule || !str(rule.id, 100) || !str(trimmed(rule.name), 100) || !rule.config || typeof rule.config !== 'object' || Array.isArray(rule.config) || typeof rule.enabled !== 'boolean') { errors.push('검사 ID, 이름, 설정을 확인하세요.'); continue; }
        if (ids.has(rule.id)) errors.push('단계 ID와 검사 ID는 서로 달라야 합니다.');
        ids.add(rule.id);
        if (!['keyword', 'regex', 'length', 'llm', 'pii', 'json', 'required'].includes(rule.kind)) errors.push(`${rule.name}: 지원하지 않는 검사 유형입니다.`);
        if (!rule.enabled) continue;
        if (['keyword','required'].includes(rule.kind) && (!str(rule.config.pattern, 2000) || !rule.config.pattern.split(/[,\n]/).some(word => word.trim()))) errors.push(`${rule.name}: 검사할 문구를 입력하세요.`);
        if (rule.kind === 'regex') { const error = validateRegex(rule.config.pattern ?? ''); if (error) errors.push(`${rule.name}: ${error}`); }
        if (rule.kind === 'length' && (!Number.isInteger(rule.config.maxLength) || Number(rule.config.maxLength) < 1 || Number(rule.config.maxLength) > MAX_INPUT)) errors.push(`${rule.name}: 최대 글자 수는 1~${MAX_INPUT}자로 입력하세요.`);
        if (rule.kind === 'pii' && (!Array.isArray(rule.config.piiTypes) || rule.config.piiTypes.length < 1 || rule.config.piiTypes.length > 3 || rule.config.piiTypes.some(type => !['email','phone','resident'].includes(type)) || new Set(rule.config.piiTypes).size !== rule.config.piiTypes.length)) errors.push(`${rule.name}: 검사할 개인정보 형식을 하나 이상 선택하세요. 같은 형식은 한 번만 선택할 수 있습니다.`);
        if (rule.kind === 'required' && rule.config.matchMode !== undefined && !['any','all'].includes(rule.config.matchMode)) errors.push(`${rule.name}: 필수 문구의 통과 조건을 확인하세요.`);
        if (rule.kind === 'json') {
          if (rule.config.jsonMode !== undefined && !['object','any'].includes(rule.config.jsonMode)) errors.push(`${rule.name}: JSON 최상위 값의 허용 형식을 선택하세요.`);
          if (rule.config.requiredKeys !== undefined && (!Array.isArray(rule.config.requiredKeys) || rule.config.requiredKeys.length > 32 || rule.config.requiredKeys.some(key => !str(key,100) || !key.trim()) || new Set(rule.config.requiredKeys).size !== rule.config.requiredKeys.length)) errors.push(`${rule.name}: JSON 필수 키는 중복 없이 1~100자씩 최대 32개 입력하세요.`);
        }
        if (rule.kind === 'llm') {
          if (rule.config.guardProfile !== undefined && !['custom','injection','safety'].includes(rule.config.guardProfile)) errors.push(`${rule.name}: 예제 모드에서 사용할 검사 유형을 선택하세요.`);
          const connection = connections.find(item => item.id === rule.config.connectionId);
          if (!connection || !['guard', 'both'].includes(connection.role)) errors.push(`${rule.name}: 검사 모델로 사용할 모델 서버를 선택하세요.`);
          else errors.push(...validateConnection(connection));
          if (!str(trimmed(rule.config.prompt), 4000)) errors.push(`${rule.name}: 검사 지시문을 1~4,000자로 입력하세요.`);
        }
      }
    }
  }
  errors.push(...validateWorkflowGraph(workflow));
  return [...new Set(errors)];
}
