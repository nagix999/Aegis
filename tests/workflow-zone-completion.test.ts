import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import {completeZoneSelection,zoneMembershipIssue} from '../lib/workflow-zones.ts';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import {isRecoverableWorkflow} from '../lib/workflow-recovery.ts';
const check=(id:string)=>({id,name:id,mode:'any' as const,rules:[{id:`r${id}`,name:id,kind:'length' as const,description:'',enabled:true,config:{maxLength:100}}]});
function fixture(){return {...initialState().workflows[0],pre:['a','b','c'].map(check),post:[check('d')]};}
test('completion adds missing serial nodes without changing workflow or execution configuration',()=>{
 const w=fixture(),before=structuredClone(w),result=completeZoneSelection(w,['input','rule:rc','output']);
 assert.deepEqual(result.missingKeys,['rule:ra','rule:rb','main','rule:rd']);
 assert.equal(result.issue,undefined);assert.equal(zoneMembershipIssue(w,result.nodeKeys),undefined);assert.deepEqual(w,before);
});
test('parallel completion includes connectors and every intermediate branch path',()=>{
 const w={...fixture(),graph:{version:1 as const,pre:{nodes:[{id:'f',name:'분기',kind:'fork' as const},{id:'j',name:'합류',kind:'join' as const}],edges:[{id:'s',from:'start',to:'control:f'},{id:'a',from:'control:f',to:'group:a'},{id:'b',from:'control:f',to:'group:b'},{id:'aj',from:'group:a',to:'control:j'},{id:'bj',from:'group:b',to:'control:j'},{id:'jc',from:'control:j',to:'group:c'},{id:'ce',from:'group:c',to:'end'}]},post:{nodes:[],edges:[{id:'sd',from:'start',to:'group:d'},{id:'de',from:'group:d',to:'end'}]}}};
 const result=completeZoneSelection(w,['control:f','control:j']);assert.deepEqual(new Set(result.missingKeys),new Set(['rule:ra','rule:rb']));assert.equal(zoneMembershipIssue(w,result.nodeKeys),undefined);
 const siblings=completeZoneSelection(w,['rule:ra','rule:rb']);assert.equal(siblings.issue,undefined);assert.ok(siblings.missingKeys.includes('control:f')||siblings.missingKeys.includes('control:j'));
});
test('valid empty, singleton and existing contiguous selections add no nodes',()=>{
 const w=fixture();for(const keys of [[],['rule:ra'],['rule:ra','rule:rb']]){const result=completeZoneSelection(w,keys);assert.equal(result.issue,undefined);assert.deepEqual(result.missingKeys,[]);}
 assert.ok(completeZoneSelection(w,['missing']).issue);
});
test('recovery retains scopes, bounds and pins and rejects invalid configuration',()=>{
 const w={...fixture(),inputScope:'last_user' as const,executionLimits:{timeoutMs:120000,maxModelCalls:64},layout:{version:1 as const,positions:{input:{x:2,y:4}},pinnedKeys:['input']}};
 assert.equal(isRecoverableWorkflow(w),true);
 for(const patch of [{inputScope:'wrong'},{executionLimits:{timeoutMs:0,maxModelCalls:64}},{executionLimits:{timeoutMs:1000,maxModelCalls:1001}},{executionLimits:{timeoutMs:1000.5,maxModelCalls:1}},{layout:{...w.layout,pinnedKeys:['input','input']}},{layout:{...w.layout,pinnedKeys:[42]}}])assert.equal(isRecoverableWorkflow({...w,...patch}),false);
});
