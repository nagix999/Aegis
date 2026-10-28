import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node source tests use explicit TypeScript extensions.
import {readConsoleRoute,consoleRouteSearch,consoleRouteIdentity} from '../lib/console-navigation.ts';

test('bookmarks preserve selection and reject request text, credentials and unrelated page IDs',()=>{
  const route=readConsoleRoute('?page=policies&policyId=policy-a&policyVersion=2&workflowId=wf-a&input=private&token=private&output=private');
  assert.deepEqual(route,{page:'policies',policyId:'policy-a',policyVersion:2});
  assert.equal(consoleRouteSearch(route),'?page=policies&policyId=policy-a&policyVersion=2');
});
test('safe IDs round trip while malformed pages, enums and dates fall back',()=>{
  const route=readConsoleRoute('?page=logs&workflowId=%ED%95%9C%EA%B8%80%2Fid&from=2026-02-30&to=2026-10-28&status=nope&source=gateway&requestId=x%00y');
  assert.deepEqual(route,{page:'logs',workflowId:'한글/id',to:'2026-10-28',source:'gateway'});
  assert.deepEqual(readConsoleRoute(consoleRouteSearch(route)),route);
  assert.deepEqual(readConsoleRoute('?page=https://example.invalid&workflowId='+ 'x'.repeat(257)),{page:'workflows'});
});
test('object navigation creates history while filters and node selection share one entry',()=>{
  assert.equal(consoleRouteIdentity({page:'workflows',workflowId:'a',nodeId:'one'}),consoleRouteIdentity({page:'workflows',workflowId:'a',nodeId:'two'}));
  assert.notEqual(consoleRouteIdentity({page:'workflows',workflowId:'a'}),consoleRouteIdentity({page:'workflows',workflowId:'b'}));
  assert.notEqual(consoleRouteIdentity({page:'evaluation',runId:'a'}),consoleRouteIdentity({page:'evaluation',runId:'b'}));
});
test('exact-time bookmarks normalize shorthand and invalid ranges cannot reach render-time filters',()=>{
  const route=readConsoleRoute('?page=logs&from=2026-10-28T00%3A00Z&to=2026-10-28T01%3A00Z');
  assert.equal(route.from,'2026-10-28T00:00:00.000Z');assert.equal(route.to,'2026-10-28T01:00:00.000Z');
  assert.deepEqual(readConsoleRoute('?page=logs&from=2026-10-29&to=2026-10-28'),{page:'logs'});
  assert.equal(readConsoleRoute('?page=logs&from=2026-10-28&to=2026-10-28').from,'2026-10-28');
});
