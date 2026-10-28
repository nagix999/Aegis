'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Loader2, LockKeyhole, LogOut, ShieldCheck } from 'lucide-react';
import { CONSOLE_LOGOUT_SIGNAL, CONSOLE_CONNECTION_EVENT, createConsoleActivityTracker, createConsoleFetch, loginRetrySeconds, readConsoleSession, unauthenticatedSession, type ConsoleSession } from '@/lib/console-auth';
import { WORKFLOW_RECOVERY_KEY } from '@/lib/workflow-recovery';
import './console-auth.css';

type ConsoleAuthContextValue = { session: ConsoleSession; requestLogout: () => void };
const ConsoleAuthContext = createContext<ConsoleAuthContextValue | undefined>(undefined);

/** Optional so the older Sites preview can keep rendering without Python authentication. */
export function ConsoleAuthControl({ busy = false }: { busy?: boolean }) {
  const auth = useContext(ConsoleAuthContext);
  if (!auth) return null;
  const method = auth.session.authMethod;
  if (method === 'session') return <button type="button" className="console-auth-logout" disabled={busy} onClick={auth.requestLogout}><LogOut size={14}/> 로그아웃</button>;
  const label = method === 'development' ? '로컬 개발 모드' : method === 'basic' ? 'Basic 인증' : method === 'proxy' ? '프록시 인증' : '관리자 토큰 인증';
  const title = method === 'development' ? '자격 증명을 설정하지 않은 로컬 개발 접근입니다.' : '이 인증 방식의 종료는 브라우저 또는 인증 프록시에서 처리합니다.';
  return <span className={`console-auth-method ${method === 'development' ? 'development' : ''}`} title={title}>{label}</span>;
}

export function ConsoleAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ConsoleSession>(unauthenticatedSession);
  const sessionRef = useRef(session);
  const [checking, setChecking] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const nativeFetch = useRef<typeof fetch | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const privateApp = useRef<HTMLDivElement>(null);
  const suspendedDialogs = useRef<HTMLDialogElement[]>([]);
  const logoutDialog = useRef<HTMLDialogElement>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const authOperation = useRef(false);
  const loggingOut = useRef(false);
  const authAbort = useRef<AbortController | null>(null);
  const managementAbort = useRef(new AbortController());
  const requireExplicitLogin = useRef(false);
  const activity = useRef(createConsoleActivityTracker());
  const abortManagement = useCallback(() => {
    managementAbort.current.abort();
    managementAbort.current = new AbortController();
  }, []);

  const installSession = useCallback((next: ConsoleSession) => {
    sessionRef.current = next;
    setSession(next);
    if (next.authenticated) { setMounted(true); setExpired(false); setError(''); }
  }, []);
  const lock = useCallback(() => {
    if (loggingOut.current) return;
    if (!sessionRef.current.authenticated) return;
    epoch.current += 1;
    abortManagement();
    installSession(unauthenticatedSession(sessionRef.current.loginAvailable));
    setExpired(true); setLogoutOpen(false); setError('');
  }, [abortManagement, installSession]);
  const discardPrivateState = useCallback((message = '') => {
    epoch.current += 1;
    requireExplicitLogin.current = true;
    authAbort.current?.abort();
    abortManagement();
    activity.current.reset();
    installSession(unauthenticatedSession(sessionRef.current.loginAvailable));
    setMounted(false); setGeneration(value => value + 1); setExpired(false); setLogoutOpen(false); setPassword(''); setError('');
    suspendedDialogs.current = [];
    let storageError = false;
    try { window.localStorage.removeItem(WORKFLOW_RECOVERY_KEY); } catch { storageError = true; }
    setNotice(storageError ? '로그아웃했습니다. 브라우저 권한 때문에 임시 초안을 지우지 못했습니다. 공용 기기라면 브라우저의 사이트 데이터를 정리하세요.' : message);
  }, [abortManagement, installSession]);
  const refresh = useCallback(async (initial = false) => {
    const fetcher = nativeFetch.current;
    if (!fetcher || authOperation.current) return;
    const revision = epoch.current;
    try {
      const current = sessionRef.current;
      const active = current.authMethod === 'session' && current.csrfToken && activity.current.take();
      const headers = active ? { 'X-Aegis-Activity': '1', 'X-Aegis-CSRF': current.csrfToken! } : undefined;
      const response = await fetcher('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', headers, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('session_unavailable');
      const next = readConsoleSession(await response.json());
      if (revision !== epoch.current) return;
      if (next.authenticated && requireExplicitLogin.current) return;
      if (!next.authenticated && sessionRef.current.authenticated) lock();
      installSession(next);
      if (!next.authenticated && initial) setError('');
    } catch {
      if (revision !== epoch.current) return;
      if (sessionRef.current.authMethod === 'session' && sessionRef.current.expiresAt && Date.parse(sessionRef.current.expiresAt) <= Date.now()) lock();
      if (initial) setError('로그인 상태를 확인하지 못했습니다. 서버 연결을 확인한 뒤 다시 시도하세요.');
    } finally { if (initial) setChecking(false); }
  }, [installSession, lock]);

  useEffect(() => {
    const fetcher = window.fetch.bind(window);
    nativeFetch.current = fetcher;
    const managedFetch = createConsoleFetch(fetcher, window.location.origin, () => authOperation.current ? unauthenticatedSession(sessionRef.current.loginAvailable) : sessionRef.current, lock, () => activity.current.take(), () => managementAbort.current.signal, available => window.dispatchEvent(new CustomEvent(CONSOLE_CONNECTION_EVENT,{detail:{available,checkedAt:Date.now()}})));
    window.fetch = managedFetch;
    void refresh(true);
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
    const visible = () => { if (!document.hidden) void refresh(); };
    const interaction = (event: Event) => { if (!document.hidden && sessionRef.current.authMethod === 'session') activity.current.mark(event.isTrusted); };
    window.addEventListener('focus', visible);
    window.addEventListener('pointerdown', interaction, true);
    window.addEventListener('keydown', interaction, true);
    window.addEventListener('wheel', interaction, { capture: true, passive: true });
    document.addEventListener('visibilitychange', visible);
    const receiveLogout = () => discardPrivateState('다른 탭에서 로그아웃했습니다. 다시 로그인하세요.');
    const storage = (event: StorageEvent) => { if (event.key === CONSOLE_LOGOUT_SIGNAL && event.newValue) receiveLogout(); };
    window.addEventListener('storage', storage);
    try { channel.current = new BroadcastChannel(CONSOLE_LOGOUT_SIGNAL); channel.current.onmessage = receiveLogout; } catch { /* Storage events remain available where BroadcastChannel is unsupported. */ }
    return () => {
      window.clearInterval(interval); window.removeEventListener('focus', visible); window.removeEventListener('pointerdown', interaction, true); window.removeEventListener('keydown', interaction, true); window.removeEventListener('wheel', interaction, true); document.removeEventListener('visibilitychange', visible); window.removeEventListener('storage', storage);
      channel.current?.close(); channel.current = null;
      if (window.fetch === managedFetch) window.fetch = fetcher;
    };
  }, [discardPrivateState, lock, refresh]);
  useEffect(() => {
    if (!session.authenticated || !session.expiresAt) return;
    const delay = Math.max(250, Date.parse(session.expiresAt) - Date.now());
    const timer = window.setTimeout(() => void refresh(), Math.min(delay, 2147483647));
    return () => window.clearTimeout(timer);
  }, [session.authenticated, session.expiresAt, refresh]);
  useEffect(() => {
    if (session.authenticated) {
      for (const dialog of suspendedDialogs.current) if (dialog.isConnected && !dialog.open) dialog.showModal();
      suspendedDialogs.current = [];
    } else {
      suspendedDialogs.current = [...(privateApp.current?.querySelectorAll<HTMLDialogElement>('dialog[open]') ?? [])];
      for (const dialog of suspendedDialogs.current) dialog.close();
      if (!checking) usernameInput.current?.focus();
    }
  }, [session.authenticated, checking]);
  useEffect(() => {
    if (logoutOpen) logoutDialog.current?.showModal(); else logoutDialog.current?.close();
  }, [logoutOpen]);
  useEffect(() => {
    if (!retryAt) { setRetrySeconds(0); return; }
    const tick = () => setRetrySeconds(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
    tick(); const interval = window.setInterval(tick, 1000); return () => window.clearInterval(interval);
  }, [retryAt]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (authOperation.current || submitting || retrySeconds || !username.trim() || !password || !nativeFetch.current) return;
    setSubmitting(true); setError(''); setNotice('');
    authOperation.current = true;
    epoch.current += 1;
    const revision = epoch.current;
    const controller = new AbortController();
    authAbort.current = controller;
    try {
      const response = await nativeFetch.current('/api/auth/login', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if (revision !== epoch.current) return;
      if (response.status === 429) { const seconds = loginRetrySeconds(response) || 60; setRetryAt(Date.now() + seconds * 1000); setError('로그인 시도가 많습니다. 잠시 후 다시 시도하세요.'); return; }
      if (!response.ok) { setError(response.status === 401 ? '계정 또는 비밀번호를 확인하세요.' : '로그인하지 못했습니다. 서버 설정과 연결을 확인하세요.'); return; }
      const next = readConsoleSession(await response.json());
      if (revision !== epoch.current) return;
      if (!next.authenticated) throw new Error('login_failed');
      requireExplicitLogin.current = false;
      activity.current.reset();
      installSession(next); setRetryAt(0);
    } catch { if (revision === epoch.current) setError('로그인하지 못했습니다. 서버 연결을 확인한 뒤 다시 시도하세요.'); }
    finally { if (authAbort.current === controller) { authAbort.current = null; authOperation.current = false; setPassword(''); setSubmitting(false); } }
  };
  const logout = async () => {
    if (authOperation.current || submitting || !nativeFetch.current) return;
    setSubmitting(true); setError('');
    authOperation.current = true;
    loggingOut.current = true;
    abortManagement();
    epoch.current += 1;
    const revision = epoch.current;
    const controller = new AbortController();
    authAbort.current = controller;
    try {
      const response = await nativeFetch.current('/api/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Aegis-CSRF': sessionRef.current.csrfToken ?? '' }, body: '{}', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
      if (revision !== epoch.current) return;
      if (response.status === 401) {
        discardPrivateState('세션이 이미 종료되어 이 기기의 입력과 임시 초안을 지웠습니다.');
        channel.current?.postMessage('logout');
        try { window.localStorage.setItem(CONSOLE_LOGOUT_SIGNAL, String(Date.now())); } catch { /* BroadcastChannel remains available. */ }
        return;
      }
      if (!response.ok) throw new Error('logout_failed');
      const next = readConsoleSession(await response.json());
      if (revision !== epoch.current) return;
      if (next.authenticated) throw new Error('logout_failed');
      discardPrivateState('로그아웃했습니다.');
      channel.current?.postMessage('logout');
      try { window.localStorage.setItem(CONSOLE_LOGOUT_SIGNAL, String(Date.now())); } catch { /* BroadcastChannel is the primary notification path. */ }
    } catch { if (revision === epoch.current) setError('로그아웃하지 못했습니다. 현재 입력은 유지됩니다. 서버 연결을 확인하고 다시 시도하세요.'); }
    finally { if (authAbort.current === controller) { authAbort.current = null; authOperation.current = false; loggingOut.current = false; setSubmitting(false); if (sessionRef.current.authenticated) void refresh(); } }
  };

  return <ConsoleAuthContext.Provider value={{ session, requestLogout: () => { setError(''); setLogoutOpen(true); } }}>
    {mounted && <div key={generation} ref={privateApp} className="console-private" hidden={!session.authenticated} inert={!session.authenticated}>{children}</div>}
    {!session.authenticated && <main className="console-login"><section className="console-login-card" aria-labelledby="console-login-title" aria-busy={checking || submitting}>
      <a className="console-login-brand" href="/" aria-label="Aegis"><span><ShieldCheck size={22}/></span>aegis</a>
      {checking ? <div className="console-login-check" role="status"><Loader2 size={20} className="spin"/> 로그인 상태 확인 중</div> : <>
        <div className="console-login-heading"><LockKeyhole size={19}/><h1 id="console-login-title">{expired ? '다시 로그인' : '관리자 로그인'}</h1></div>
        <p>{expired ? '세션이 만료되었습니다. 현재 탭의 입력은 보관 중입니다. 로그인한 뒤 작업을 다시 시도하세요.' : 'Aegis 관리 콘솔에 접속할 관리자 계정을 입력하세요.'}</p>
        {notice && <div className="console-auth-notice" role="status">{notice}</div>}
        {error && <div className="console-auth-error" role="alert">{error}</div>}
        {session.loginAvailable ? <form onSubmit={login}>
          <label htmlFor="console-username">관리자 계정</label><input ref={usernameInput} id="console-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={128} value={username} onChange={event => setUsername(event.target.value)} disabled={submitting} required/>
          <label htmlFor="console-password">비밀번호</label><input id="console-password" name="password" type="password" autoComplete="current-password" maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} disabled={submitting} required/>
          <button className="console-login-submit" type="submit" disabled={submitting || retrySeconds > 0 || !username.trim() || !password}>{submitting ? <Loader2 size={16} className="spin"/> : <ArrowRight size={16}/>} {submitting ? '로그인 중' : retrySeconds > 0 ? `${retrySeconds}초 후 다시 시도` : '로그인'}</button>
        </form> : <div className="console-auth-configuration"><p>서버에 관리자 계정이 설정되어 있지 않거나 외부 인증이 필요합니다. 서버의 관리자 인증 설정을 확인하세요.</p></div>}
        <button type="button" className="console-auth-recheck" disabled={submitting} onClick={() => { setChecking(true); void refresh(true); }}>로그인 상태 다시 확인</button>
      </>}
    </section></main>}
    <dialog ref={logoutDialog} className="console-logout-dialog" aria-labelledby="console-logout-title" onCancel={event => { event.preventDefault(); if (!submitting) setLogoutOpen(false); }}>
      <h2 id="console-logout-title">로그아웃할까요?</h2><p>서버에 저장하지 않은 정책과 워크플로우, 입력 및 이 브라우저의 임시 초안이 삭제됩니다. 필요한 내용은 먼저 저장하세요.</p><p>이미 시작한 서버 검증은 계속될 수 있습니다. 대시보드 배치와 탭 설정은 유지됩니다.</p>
      {error && <div className="console-auth-error" role="alert">{error}</div>}
      <footer><button type="button" disabled={submitting} onClick={() => setLogoutOpen(false)}>계속 작업</button><button type="button" className="console-login-submit" disabled={submitting} onClick={() => void logout()}>{submitting ? <Loader2 size={15} className="spin"/> : <LogOut size={15}/>} {submitting ? '로그아웃 중' : '로그아웃'}</button></footer>
    </dialog>
  </ConsoleAuthContext.Provider>;
}
