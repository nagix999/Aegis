import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node strip-types accepts explicit .ts imports.
import { currentDeployments, deployedCurl } from '../lib/gateway-integration.ts';
// @ts-expect-error Node strip-types accepts explicit .ts imports.
import { emptyLogFilters, logSearchParams } from '../lib/log-search.ts';
import type { Deployment } from '../lib/aegis-types';
const deployment=(alias:string,version:number,createdAt:string):Deployment=>({id:`${alias}-${version}`,workflowId:'workflow',alias,version,createdAt,workflow:{id:'workflow',name:'상담',description:'',alias:'unpublished-name',mainConnectionId:'c',pre:[],post:[],updatedAt:''},connections:[]});
test('live examples use latest deployment aliases even if the current draft was renamed',()=>{
  const versions=[deployment('support',1,'2026-10-23'),deployment('support',2,'2026-10-24'),deployment('another',3,'2026-10-24')];
  const live=currentDeployments(versions);assert.deepEqual(live.map(item=>item.version),[3,2]);assert.equal(versions.length,3);
  const curl=deployedCurl('https://gateway.example/v1',live[1]);assert.match(curl,/"model":"support"/);assert.doesNotMatch(curl,/unpublished-name/);assert.match(curl,/"stream":false/);
});
test('no deployments means no invented callable model',()=>assert.deepEqual(currentDeployments([]),[]));
test('log date filters include full selected Korean days and preserve the opaque cursor',()=>{
  const params=new URLSearchParams(logSearchParams({...emptyLogFilters,query:' 요청 ID ',from:'2026-10-25',to:'2026-10-26',status:'block',source:'gateway'},'opaque+/='));
  assert.equal(params.get('query'),'요청 ID');assert.equal(params.get('from'),'2026-10-24T15:00:00.000Z');assert.equal(params.get('to'),'2026-10-26T15:00:00.000Z');assert.equal(params.get('cursor'),'opaque+/=');assert.equal(params.get('status'),'block');assert.equal(params.get('source'),'gateway');assert.equal(params.get('limit'),'50');
});
test('reversed and impossible dates cannot form a server query',()=>{
  for(const filters of [{from:'2026-10-27',to:'2026-10-26'},{from:'2026-02-30'},{to:'invalid'}])assert.throws(()=>logSearchParams({...emptyLogFilters,...filters}));
  assert.doesNotThrow(()=>logSearchParams({...emptyLogFilters,from:'2026-10-26',to:'2026-10-26'}));
});
