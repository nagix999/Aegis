// @ts-expect-error Node's source test runner resolves explicit TypeScript paths.
import { PYTHON_ENGINE_VERSION } from './execution-provenance.ts';

export type PolicyServerCompatibility = { compatible: boolean; code: 'compatible'|'engine_mismatch'|'invalid_health'|'wrong_backend'|'unauthorized'|'unavailable'; message: string; expectedVersion: string; actualVersion?: string };
const restart = '서버를 종료한 뒤 python backend/run.py로 다시 실행하고 저장 또는 예제 테스트를 다시 눌러 주세요. 입력한 내용은 유지됩니다.';
function incompatible(code: Exclude<PolicyServerCompatibility['code'], 'compatible'>, message: string, actualVersion?: string): PolicyServerCompatibility {
  return { compatible: false, code, expectedVersion: PYTHON_ENGINE_VERSION, ...(actualVersion ? { actualVersion } : {}), message };
}

/** Only the runtime serving this UI can authorize the V2 policy contract. */
export function policyServerCompatibility(health: unknown): PolicyServerCompatibility {
  if (!health || typeof health !== 'object' || Array.isArray(health)) return incompatible('invalid_health', `Python 서버 실행 정보를 확인하지 못했습니다. ${restart}`);
  const value = health as Record<string, unknown>;
  if (value.backend !== 'python-fastapi') return incompatible('wrong_backend', `현재 연결에서 Python 서버를 확인하지 못했습니다. ${restart}`);
  const version = typeof value.engineVersion === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(value.engineVersion) ? value.engineVersion : undefined;
  if (!version) return incompatible('invalid_health', `Python 서버의 엔진 버전을 확인하지 못했습니다. ${restart}`);
  if (version !== PYTHON_ENGINE_VERSION) return incompatible('engine_mismatch', `화면과 서버의 정책 형식이 다릅니다. 필요한 엔진: ${PYTHON_ENGINE_VERSION}, 현재 서버: ${version}. ${restart}`, version);
  return { compatible: true, code: 'compatible', expectedVersion: PYTHON_ENGINE_VERSION, actualVersion: version, message: '' };
}

/** Recheck on every action so an open draft can be retried after a restart. */
export async function checkPolicyServerCompatibility(fetcher: typeof fetch = fetch): Promise<PolicyServerCompatibility> {
  try {
    const response = await fetcher('/healthz', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(4000) });
    if (response.status === 401 || response.status === 403) return incompatible('unauthorized', `서버 실행 정보를 확인하지 못했습니다. 관리자 인증과 Python 서버 실행 상태를 확인하세요. ${restart}`);
    if (!response.ok) return incompatible('unavailable', `Python 서버 실행 정보를 가져오지 못했습니다. ${restart}`);
    let health: unknown;
    try { health = await response.json(); }
    catch { return incompatible('invalid_health', `Python 서버 실행 정보의 형식을 확인하지 못했습니다. ${restart}`); }
    return policyServerCompatibility(health);
  } catch {
    return incompatible('unavailable', `Python 서버에 연결하지 못했습니다. ${restart}`);
  }
}
