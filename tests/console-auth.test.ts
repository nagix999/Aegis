import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source test runner resolves explicit TypeScript paths.
import { createConsoleActivityTracker, createConsoleFetch, isConsoleManagementRequest, loginRetrySeconds, readConsoleSession, unauthenticatedSession, type ConsoleSession } from '../lib/console-auth.ts';

const origin = 'https://console.example';
const session: ConsoleSession = { authenticated: true, loginAvailable: true, authMethod: 'session', csrfToken: 'synthetic-csrf-value', expiresAt: '2099-01-01T00:00:00Z' };

test('connection reports distinguish server errors and transport loss without observing private bodies',async()=>{
  const statuses:boolean[]=[];
  for(const status of [200,400,403,429,503]){
    const managed=createConsoleFetch((async()=>new Response('private',{status})) as typeof fetch,origin,()=>session,()=>{},()=>false,()=>undefined,available=>statuses.push(available));
    await managed('/api/console');
  }
  assert.deepEqual(statuses,[true,true,true,true,false]);
  const offline=createConsoleFetch((async()=>{throw new TypeError('network');}) as typeof fetch,origin,()=>session,()=>{},()=>false,()=>undefined,available=>statuses.push(available));
  await assert.rejects(offline('/api/console'),TypeError);assert.equal(statuses.at(-1),false);
});
test('abandoned responses and external requests cannot publish connection status',async()=>{
  let complete:(value:Response)=>void=()=>{},state=session,reports=0;
  const managed=createConsoleFetch((()=>new Promise<Response>(resolve=>{complete=resolve;})) as typeof fetch,origin,()=>state,()=>{},()=>false,()=>undefined,()=>reports++);
  const pending=managed('/api/console');state=unauthenticatedSession();complete(Response.json({}));
  await assert.rejects(pending,{name:'AbortError'});assert.equal(reports,0);
  const external=createConsoleFetch((async()=>new Response('public')) as typeof fetch,origin,()=>session,()=>{},()=>false,()=>undefined,()=>reports++);
  await external('https://upstream.example/v1/models');assert.equal(reports,0);
});

test('only same-origin management paths qualify for session handling', () => {
  for (const path of ['/api/console', '/api/console?view=logs', '/api/another-management-route']) assert.equal(isConsoleManagementRequest(path, origin), true);
  for (const path of ['/v1/chat/completions', '/healthz', '/api/auth/login', '/api/auth/logout', '/api/auth/session', '/api/evaluations/worker', 'https://model.example/api/console', '//attacker.example/api/console']) assert.equal(isConsoleManagementRequest(path, origin), false);
});
test('session writes carry in-memory CSRF while preserving headers, body and abort signal', async () => {
  const calls: {input: RequestInfo | URL; init?: RequestInit}[] = [];
  const fetcher = (async (input, init) => { calls.push({input, init}); return Response.json({ok:true}); }) as typeof fetch;
  const managed = createConsoleFetch(fetcher, origin, () => session, () => assert.fail('unexpected logout'));
  const controller = new AbortController();
  await managed('/api/console', { method: 'POST', headers: {'Content-Type':'application/json',Accept:'application/x-ndjson','X-Aegis-CSRF':'obsolete'}, body: '{"action":"playground"}', signal: controller.signal });
  assert.equal(calls.length,1);
  const init = calls[0].init!;
  assert.equal(new Headers(init.headers).get('X-Aegis-CSRF'),session.csrfToken);
  assert.equal(new Headers(init.headers).get('Accept'),'application/x-ndjson');
  assert.equal(init.signal,controller.signal);assert.equal(init.body,'{"action":"playground"}');assert.equal(init.credentials,'same-origin');
});
test('GET and non-session authenticated requests do not attach or retain CSRF values', async () => {
  const headers: Headers[] = [];
  const fetcher = (async (_input, init) => { headers.push(new Headers(init?.headers)); return new Response('ok'); }) as typeof fetch;
  for (const authMethod of ['session','basic','proxy','token','development'] as const) {
    const managed = createConsoleFetch(fetcher, origin, () => ({...session,authMethod}), () => {});
    await managed('/api/console', { headers: {'X-Aegis-CSRF':'obsolete'} });
    if (authMethod !== 'session') await managed('/api/console', { method:'POST',headers: {'X-Aegis-CSRF':'obsolete'} });
  }
  assert.ok(headers.every(header => !header.has('X-Aegis-CSRF')));
});
test('external and Gateway requests are passed through without leaking session values', async () => {
  const calls: {input: RequestInfo | URL; init?: RequestInit}[] = [];
  const fetcher = (async (input,init) => { calls.push({input,init}); return new Response('ok'); }) as typeof fetch;
  const managed = createConsoleFetch(fetcher,origin,()=>session,()=>assert.fail());
  for (const path of ['https://model.example/api/console','/v1/chat/completions','/api/auth/login']) {
    const init: RequestInit = {method:'POST',headers:{Authorization:'Bearer synthetic-key'}};
    await managed(path,init);assert.equal(calls.at(-1)?.init,init);assert.equal(new Headers(calls.at(-1)?.init?.headers).has('X-Aegis-CSRF'),false);
  }
});
test('Request object method and headers work without consuming the body',async()=>{
  const request = new Request(`${origin}/api/console`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"action":"save"}'});
  const managed = createConsoleFetch((async (input,init)=>{
    assert.equal(input,request);assert.equal(await (input as Request).text(),'{"action":"save"}');assert.equal(new Headers(init?.headers).get('X-Aegis-CSRF'),session.csrfToken);return new Response('ok');
  }) as typeof fetch,origin,()=>session,()=>{});
  await managed(request);
});
test('401 locks once through the caller and later hidden writes never reach the server or replay',async()=>{
  let state=session,calls=0,locks=0;
  const managed=createConsoleFetch((async()=>{calls++;return Response.json({error:{code:'admin_auth_required'}},{status:401});}) as typeof fetch,origin,()=>state,()=>{locks++;state=unauthenticatedSession(true);});
  assert.equal((await managed('/api/console',{method:'POST',body:'first'})).status,401);
  assert.equal((await managed('/api/console',{method:'POST',body:'second'})).status,401);
  assert.equal(calls,1);assert.equal(locks,1);
});
test('403 is an authorization error and does not discard the current session or draft',async()=>{
  let locks=0;
  const managed=createConsoleFetch((async()=>new Response('forbidden',{status:403})) as typeof fetch,origin,()=>session,()=>locks++);
  assert.equal((await managed('/api/console',{method:'POST'})).status,403);assert.equal(locks,0);
});
test('an old in-flight 401 cannot lock a newly authenticated session',async()=>{
  let complete:(value:Response)=>void=()=>assert.fail('request not started'),state=session,locks=0;
  const managed=createConsoleFetch((()=>new Promise<Response>(resolve=>{complete=resolve;})) as typeof fetch,origin,()=>state,()=>locks++);
  const pending=managed('/api/console',{method:'POST'});
  state={...session,csrfToken:'another-synthetic-session'};
  complete(new Response('expired',{status:401}));
  await assert.rejects(pending,{name:'AbortError'});assert.equal(locks,0);
});
test('an old in-flight 401 after explicit logout cannot fire another lock callback',async()=>{
  let complete:(value:Response)=>void=()=>assert.fail('request not started'),state=session,locks=0;
  const managed=createConsoleFetch((()=>new Promise<Response>(resolve=>{complete=resolve;})) as typeof fetch,origin,()=>state,()=>locks++);
  const pending=managed('/api/console');state=unauthenticatedSession(true);complete(new Response('expired',{status:401}));
  await assert.rejects(pending,{name:'AbortError'});assert.equal(locks,0);
});
test('a late successful save cannot reach an editor after logout and recreate recovery data',async()=>{
  let complete:(value:Response)=>void=()=>assert.fail('request not started'),state=session,persisted=false;
  const managed=createConsoleFetch((()=>new Promise<Response>(resolve=>{complete=resolve;})) as typeof fetch,origin,()=>state,()=>{});
  const save=(async()=>{const response=await managed('/api/console',{method:'POST',body:'{"action":"save_workflow"}'});if(response.ok){await response.json();persisted=true;}})();
  state=unauthenticatedSession(true);complete(Response.json({state:{workflows:[]}}));
  await assert.rejects(save,{name:'AbortError'});assert.equal(persisted,false);
});
test('management generation aborts old requests even when a transport ignores abort and the next login has the same identity',async()=>{
  let complete:(value:Response)=>void=()=>assert.fail('request not started'),generation=new AbortController();
  const managed=createConsoleFetch((()=>new Promise<Response>(resolve=>{complete=resolve;})) as typeof fetch,origin,()=>({...session,authMethod:'basic'}),()=>{},()=>false,()=>generation.signal);
  const pending=managed('/api/console');generation.abort();generation=new AbortController();complete(Response.json({ok:true}));
  await assert.rejects(pending,{name:'AbortError'});
});
test('JSON parsing that completes after logout cannot repopulate private recovery even if headers arrived earlier',async()=>{
  let complete:(value:unknown)=>void=()=>assert.fail('body not requested'),state=session,persisted=false;
  const response=Response.json({ok:true});
  response.json=()=>new Promise(resolve=>{complete=resolve;});
  const managed=createConsoleFetch((async()=>response) as typeof fetch,origin,()=>state,()=>{});
  const reply=await managed('/api/console',{method:'POST'});
  const save=(async()=>{await reply.json();persisted=true;})();
  state=unauthenticatedSession(true);complete({state:{workflows:[]}});
  await assert.rejects(save,{name:'AbortError'});assert.equal(persisted,false);
});
test('cloned responses keep body guards and standard Response getters remain usable',async()=>{
  let state=session;
  const managed=createConsoleFetch((async()=>Response.json({ok:true})) as typeof fetch,origin,()=>state,()=>{});
  const reply=await managed('/api/console'),copy=reply.clone();
  assert.ok(reply instanceof Response);assert.equal(reply.ok,true);assert.equal(reply.status,200);assert.match(reply.headers.get('Content-Type')??'',/json/);
  state=unauthenticatedSession(true);await assert.rejects(copy.json(),{name:'AbortError'});
});
test('management cancellation and caller cancellation are combined and preserve streaming response aborts',async()=>{
  for(const cancel of ['caller','management'] as const){
    const caller=new AbortController(),management=new AbortController();let combined:AbortSignal|undefined;
    const managed=createConsoleFetch((async(_input,init)=>{combined=init?.signal??undefined;return new Response('ok');}) as typeof fetch,origin,()=>session,()=>{},()=>false,()=>management.signal);
    await managed(new Request(`${origin}/api/console`,{signal:caller.signal}));
    assert.ok(combined);assert.equal(combined.aborted,false);
    (cancel==='caller'?caller:management).abort();assert.equal(combined.aborted,true);
  }
});
test('trusted activity is reported once within a bounded window and synthetic events cannot renew idle',()=>{
  let now=0;const activity=createConsoleActivityTracker(()=>now);
  assert.equal(activity.take(),false);activity.mark(false);assert.equal(activity.take(),false);
  activity.mark(true);now=30_000;assert.equal(activity.take(),true);assert.equal(activity.take(),false);
  activity.mark(true);now=90_001;assert.equal(activity.take(),false);
  activity.mark(true);activity.reset();assert.equal(activity.take(),false);
});
test('background reads have no renewal hints while real interaction attaches matching session CSRF once',async()=>{
  const activity=createConsoleActivityTracker();const headers:Headers[]=[];
  const managed=createConsoleFetch((async(_input,init)=>{headers.push(new Headers(init?.headers));return new Response('ok');}) as typeof fetch,origin,()=>session,()=>{},()=>activity.take());
  await managed('/api/console',{headers:{'X-Aegis-Activity':'1','X-Aegis-CSRF':'forged'}});
  assert.equal(headers[0].has('X-Aegis-Activity'),false);assert.equal(headers[0].has('X-Aegis-CSRF'),false);
  activity.mark(true);await managed('/api/console');
  assert.equal(headers[1].get('X-Aegis-Activity'),'1');assert.equal(headers[1].get('X-Aegis-CSRF'),session.csrfToken);
  await managed('/api/console');assert.equal(headers[2].has('X-Aegis-Activity'),false);assert.equal(headers[2].has('X-Aegis-CSRF'),false);
});
test('invalid session contracts fail closed and foreign secrets are not retained',()=>{
  for(const data of [null,[],{}, {authenticated:true,loginAvailable:true,authMethod:'session'}, {...session,expiresAt:'invalid'}, {...session,csrfToken:''}, {...session,authMethod:'other'}, {authenticated:false,loginAvailable:true,authMethod:'session'}]) assert.throws(()=>readConsoleSession(data));
  assert.deepEqual(readConsoleSession({...session,authMethod:'basic',csrfToken:'drop',expiresAt:'drop',password:'drop'}),{authenticated:true,loginAvailable:true,authMethod:'basic'});
  assert.deepEqual(readConsoleSession({authenticated:false,loginAvailable:true,authMethod:null}),unauthenticatedSession(true));
});
test('Retry-After is bounded and supports seconds and dates without raw server text',()=>{
  assert.equal(loginRetrySeconds(new Response('',{status:429,headers:{'Retry-After':'17'}})),17);
  assert.equal(loginRetrySeconds(new Response('',{status:429,headers:{'Retry-After':'999999'}})),3600);
  assert.equal(loginRetrySeconds(new Response('',{status:429,headers:{'Retry-After':'garbage'}})),0);
  assert.equal(loginRetrySeconds(new Response('',{status:429,headers:{'Retry-After':'-4'}})),0);
  const seconds=loginRetrySeconds(new Response('',{status:429,headers:{'Retry-After':new Date(Date.now()+10000).toUTCString()}}));
  assert.ok(seconds>=9&&seconds<=10);
});
