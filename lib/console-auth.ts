/** Session secrets stay in memory. The cookie itself is HttpOnly and is never read here. */
export type ConsoleAuthMethod = 'session' | 'basic' | 'token' | 'proxy' | 'development';
export type ConsoleSession = {
  authenticated: boolean;
  loginAvailable: boolean;
  authMethod: ConsoleAuthMethod | null;
  identity?: string;
  csrfToken?: string;
  expiresAt?: string;
};
export const CONSOLE_LOGOUT_SIGNAL = 'aegis:console-logout:v1';
export const CONSOLE_CONNECTION_EVENT = 'aegis:console-connection';
export const unauthenticatedSession = (loginAvailable = false): ConsoleSession => ({ authenticated: false, loginAvailable, authMethod: null });

/** Report each real interaction at most once; passive polling must never extend an idle session. */
export function createConsoleActivityTracker(now: () => number = Date.now) {
  let pending: number | undefined;
  return {
    mark(isTrusted: boolean) { if (isTrusted) pending = now(); },
    take() {
      const timestamp = pending;
      pending = undefined;
      return timestamp !== undefined && now() >= timestamp && now() - timestamp <= 60_000;
    },
    reset() { pending = undefined; },
  };
}

export function readConsoleSession(value: unknown): ConsoleSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_session');
  const data = value as Record<string, unknown>;
  if (typeof data.authenticated !== 'boolean' || typeof data.loginAvailable !== 'boolean') throw new Error('invalid_session');
  const methods: unknown[] = ['session', 'basic', 'token', 'proxy', 'development'];
  if (data.authenticated ? !methods.includes(data.authMethod) : data.authMethod !== null) throw new Error('invalid_session');
  if (data.authMethod === 'session' && (typeof data.csrfToken !== 'string' || !data.csrfToken || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)))) throw new Error('invalid_session');
  return {
    authenticated: data.authenticated,
    loginAvailable: data.loginAvailable,
    authMethod: data.authMethod as ConsoleAuthMethod | null,
    ...(typeof data.identity === 'string' ? { identity: data.identity } : {}),
    ...(data.authMethod === 'session' ? { csrfToken: data.csrfToken as string, expiresAt: data.expiresAt as string } : {}),
  };
}

/** Only management endpoints are intercepted. Model calls and external URLs are untouched. */
export function isConsoleManagementRequest(input: RequestInfo | URL, origin: string): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    return url.origin === origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/evaluations/worker';
  } catch { return false; }
}

function guardedManagementResponse(response: Response, assertCurrent: () => void): Response {
  // Headers can arrive before logout while JSON parsing completes afterward.
  // Guard completion as well as fetch resolution so callers never receive stale private data.
  const readers = new Set<PropertyKey>(['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes']);
  return new Proxy(response, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'clone') return () => guardedManagementResponse(target.clone(), assertCurrent);
      if (typeof value !== 'function') return value;
      if (readers.has(property)) return async (...args: unknown[]) => {
        assertCurrent();
        const data: unknown = await Reflect.apply(value, target, args);
        assertCurrent();
        return data;
      };
      return value.bind(target);
    },
  });
}

export function createConsoleFetch(fetcher: typeof fetch, origin: string, getSession: () => ConsoleSession, onUnauthorized: () => void, takeActivity: () => boolean = () => false, getManagementSignal: () => AbortSignal | undefined = () => undefined, onConnection?: (available:boolean) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isConsoleManagementRequest(input, origin)) return fetcher(input, init);
    const session = getSession();
    // A hidden, expired editor must not start background requests or replay a failed write.
    if (!session.authenticated) return Response.json({ error: { code: 'admin_auth_required', message: '관리자 로그인이 필요합니다.' } }, { status: 401 });
    const managementSignal = getManagementSignal();
    const callerSignal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    const signals = [managementSignal, callerSignal].filter((signal): signal is AbortSignal => Boolean(signal));
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    signal?.throwIfAborted();
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete('X-Aegis-CSRF');
    headers.delete('X-Aegis-Activity');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (session.authMethod === 'session' && session.csrfToken) {
      const active = takeActivity();
      if (unsafe || active) headers.set('X-Aegis-CSRF', session.csrfToken);
      if (!unsafe && active) headers.set('X-Aegis-Activity', '1');
    }
    const assertCurrent = () => {
      const current = getSession();
      // A response from an earlier login must not hide or invalidate a newer session.
      const sameAuthentication = current.authenticated && current.authMethod === session.authMethod && current.identity === session.identity
        && (session.authMethod !== 'session' || current.csrfToken === session.csrfToken);
      if (signal?.aborted || !sameAuthentication) throw new DOMException('관리자 인증 상태가 변경되어 요청을 중단했습니다.', 'AbortError');
    };
    let response:Response;
    try { response = await fetcher(input, { ...init, headers, credentials: 'same-origin', ...(signal ? { signal } : {}) }); }
    catch(error){
      // An abandoned request must not change the status of a new login.
      assertCurrent();
      if(!(error instanceof DOMException&&error.name==='AbortError'))onConnection?.(false);
      throw error;
    }
    try { assertCurrent(); } catch (error) {
      // Even a completed save must not reach an unmounted editor and repopulate private recovery data.
      void response.body?.cancel().catch(() => {});
      throw error;
    }
    onConnection?.(response.status<500);
    if (response.status === 401) onUnauthorized();
    return guardedManagementResponse(response, assertCurrent);
  }) as typeof fetch;
}

export function loginRetrySeconds(response: Response): number {
  const raw = response.headers.get('Retry-After');
  if (!raw) return 0;
  const seconds = Number(raw);
  const result = Number.isFinite(seconds) ? seconds : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(result) ? Math.min(3600, Math.max(0, Math.ceil(result))) : 0;
}
