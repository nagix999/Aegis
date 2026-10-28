import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source test runner resolves explicit TypeScript paths.
import { checkPolicyServerCompatibility, policyServerCompatibility } from '../lib/policy-server-compatibility.ts';
// @ts-expect-error Node's source test runner resolves explicit TypeScript paths.
import { PYTHON_ENGINE_VERSION } from '../lib/execution-provenance.ts';

test('the current Python runtime supports the policy UI contract',()=>{
  assert.deepEqual(policyServerCompatibility({backend:'python-fastapi',engineVersion:PYTHON_ENGINE_VERSION}),{compatible:true,code:'compatible',message:'',expectedVersion:PYTHON_ENGINE_VERSION,actualVersion:PYTHON_ENGINE_VERSION});
});
test('older and newer engines require an explicit runtime update without suggesting legacy fields',()=>{
  const currentNumber=Number(PYTHON_ENGINE_VERSION.split('-')[0]);
  for (const version of [`${currentNumber-1}-python`,`${currentNumber+1}-python`,'4-python','2']) {
    const result=policyServerCompatibility({backend:'python-fastapi',engineVersion:version});
    assert.equal(result.compatible,false);assert.equal(result.code,'engine_mismatch');assert.equal(result.actualVersion,version);
    assert.match(result.message,/python backend\/run\.py/);assert.match(result.message,/입력한 내용은 유지/);assert.ok(result.message.includes(PYTHON_ENGINE_VERSION));assert.ok(result.message.includes(version));assert.doesNotMatch(result.message,/expectedDecision|decisions|expectedOutput/);
  }
});
test('unknown or malformed health bodies fail closed without exposing untrusted values',()=>{
  for (const value of [null,[],{},'server html',{backend:'python-fastapi'},{backend:'python-fastapi',engineVersion:5},{backend:'python-fastapi',engineVersion:'private\nvalue'},{backend:'python-fastapi',engineVersion:{raw:'secret'}}]) {
    const result=policyServerCompatibility(value);assert.equal(result.compatible,false);assert.match(result.message,/Python/);assert.match(result.message,/다시 실행/);assert.doesNotMatch(result.message,/secret|private/);
  }
  assert.equal(policyServerCompatibility({backend:'sites',engineVersion:PYTHON_ENGINE_VERSION}).code,'wrong_backend');
});
test('every action gets fresh same-origin runtime state and can retry after a restart',async()=>{
  const requests:{url:unknown;options?:RequestInit}[]=[];let version='4-python';
  const fetcher=(async(url:unknown,options?:RequestInit)=>{requests.push({url,options});return Response.json({backend:'python-fastapi',engineVersion:version});}) as typeof fetch;
  const first=await checkPolicyServerCompatibility(fetcher);assert.equal(first.compatible,false);
  version=PYTHON_ENGINE_VERSION;const retried=await checkPolicyServerCompatibility(fetcher);assert.equal(retried.compatible,true);assert.equal(requests.length,2);
  for (const request of requests) { assert.equal(request.url,'/healthz');assert.equal(request.options?.cache,'no-store');assert.equal(request.options?.credentials,'same-origin');assert.ok(request.options?.signal instanceof AbortSignal); }
});
test('authentication failures and legacy Sites errors produce a restart message',async()=>{
  for (const status of [401,403,404,500]) {
    const result=await checkPolicyServerCompatibility((async()=>new Response('private failure body',{status})) as typeof fetch);
    assert.equal(result.compatible,false);assert.equal(result.code,status===401||status===403?'unauthorized':'unavailable');assert.match(result.message,/python backend\/run\.py/);assert.doesNotMatch(result.message,/private failure/);
  }
});
test('invalid JSON, network failure and timeout never authorize a policy request',async()=>{
  const responses=[(async()=>new Response('<html>old Sites</html>',{status:200})) as typeof fetch,(async()=>{throw new Error('network private detail');}) as typeof fetch,(async()=>{throw new DOMException('timeout','TimeoutError');}) as typeof fetch];
  for (const fetcher of responses) { const result=await checkPolicyServerCompatibility(fetcher);assert.equal(result.compatible,false);assert.match(result.message,/입력한 내용은 유지/);assert.doesNotMatch(result.message,/private detail|<html>/); }
});
