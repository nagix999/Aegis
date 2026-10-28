import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleConsole } from '../.local-runtime/server/api.mjs';

function fixture(overrides={}) {
  let reads=0;
  const statement={
    bind(){return this;},
    async first(){reads++;return {id:'initialized'};},
    async all(){reads++;return {results:[]};},
    async run(){throw new Error('Read-only fixture');},
  };
  return {
    env:{DB:{prepare(){return statement;},async batch(){return [];}},AEGIS_REQUIRE_ADMIN_IDENTITY:'true',...overrides},
    reads:()=>reads,
  };
}
const request=(headers={},method='GET')=>new Request('https://console.example/api/console',{method,headers,...(method==='POST'?{body:JSON.stringify({action:'publish',workflowId:'wf-support'})}:{})});

test('production console rejects anonymous access before database reads',async()=>{
  const f=fixture();
  const response=await handleConsole(request(),f.env);
  assert.equal(response.status,401);
  assert.equal((await response.json()).error.code,'unauthorized');
  assert.equal(f.reads(),0);
});
test('platform service bypass and Gateway bearer keys cannot administer the console',async()=>{
  for(const headers of [{'OAI-Sites-Authorization':'Bearer service-token'},{Authorization:'Bearer ag_'+'a'.repeat(64)}]) {
    const f=fixture();
    assert.equal((await handleConsole(request(headers),f.env)).status,401);
    assert.equal(f.reads(),0);
  }
});
test('platform-authenticated browser can read state',async()=>{
  const f=fixture();
  const response=await handleConsole(request({'oai-authenticated-user-id':'owner-id'}),f.env);
  assert.equal(response.status,200);
  assert.ok((await response.json()).state);
});
test('separate configured admin token can authenticate service management',async()=>{
  const f=fixture({AEGIS_ADMIN_TOKEN:'dedicated-admin-token'});
  assert.equal((await handleConsole(request({Authorization:'Bearer dedicated-admin-token'}),f.env)).status,200);
  assert.equal((await handleConsole(request({'X-Aegis-Admin-Token':'dedicated-admin-token'}),f.env)).status,200);
  assert.equal((await handleConsole(request({Authorization:'Bearer wrong-token'}),f.env)).status,401);
});
test('browser identity still works when an optional admin token is configured',async()=>{
  const f=fixture({AEGIS_ADMIN_TOKEN:'dedicated-admin-token'});
  assert.equal((await handleConsole(request({'oai-authenticated-user-id':'owner-id'}),f.env)).status,200);
});
test('authenticated cross-origin console mutation is denied before database access',async()=>{
  const f=fixture();
  assert.equal((await handleConsole(request({'oai-authenticated-user-id':'owner-id',Origin:'https://other.example'},'POST'),f.env)).status,403);
  assert.equal(f.reads(),0);
});
test('dev and standalone token behavior stays unchanged',async()=>{
  const dev=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'false'});
  assert.equal((await handleConsole(request(),dev.env)).status,200);
  const token=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'false',AEGIS_ADMIN_TOKEN:'internal-admin'});
  assert.equal((await handleConsole(request(),token.env)).status,401);
  assert.equal((await handleConsole(request({Authorization:'Bearer internal-admin'}),token.env)).status,200);
});
