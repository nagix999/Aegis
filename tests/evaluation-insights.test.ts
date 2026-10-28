import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node strip-types accepts explicit .ts imports.
import { evaluationChanges, evaluationPathCoverage } from '../lib/evaluation-insights.ts';
import type { EvalResult, Workflow } from '../lib/aegis-types';
const row=(id:string,expected:'allow'|'block',status:EvalResult['status'],patch:Partial<EvalResult>={}):EvalResult=>({rowId:id,id,expected,status,input:'사례',output:'',stage:'complete',reason:'결과',latencyMs:10,traces:[],...patch});
test('comparison separates new missed violations, resolved and new false blocks, errors and retry changes',()=>{
  const before=[row('missed','block','block'),row('solved','allow','block'),row('blocked','allow','allow'),row('error','block','block'),row('unchanged','block','allow'),row('unpaired','allow','block')];
  const after=[row('missed','block','allow',{regenerationCount:2}),row('solved','allow','allow'),row('blocked','allow','block'),row('error','block','error'),row('unchanged','block','allow')];
  assert.deepEqual(evaluationChanges(after,before),{paired:5,newMissed:1,resolvedFalseBlocks:1,newFalseBlocks:1,newErrors:1,retryDelta:2,latencyDelta:0});
});
test('incomplete comparison rows are excluded from every change and timing denominator',()=>{
  const change=evaluationChanges([row('paired','allow','allow',{latencyMs:20}),row('unpaired','block','allow',{latencyMs:99999,regenerationCount:3})],[row('paired','allow','allow',{latencyMs:10})]);
  assert.equal(change.paired,1);assert.equal(change.latencyDelta,10);assert.equal(change.newMissed,0);assert.equal(change.retryDelta,0);
});
test('an error replacing a false block is not reported as a resolved false block',()=>{
  assert.equal(evaluationChanges([row('x','allow','error')],[row('x','allow','block')]).resolvedFalseBlocks,0);
});
const workflow=():Workflow=>({id:'wf',name:'흐름',description:'',alias:'assistant',mainConnectionId:'c',updatedAt:'',pre:[],post:[],graph:{version:1,pre:{nodes:[{id:'choose',kind:'condition',name:'길이 검사'}],edges:[{id:'entry',from:'start',to:'control:choose'},{id:'yes',from:'control:choose',to:'end',port:'true'},{id:'no',from:'control:choose',to:'end',port:'false'}]},post:{nodes:[],edges:[{id:'entry',from:'start',to:'end'}]}}});
test('coverage qualifies repeated edge IDs by stage and ignores skipped and unknown edges',()=>{
  const result=row('x','allow','allow',{flowTraces:[{stage:'pre',nodeId:'start',status:'completed',edgeIds:['entry']},{stage:'pre',nodeId:'control:choose',status:'completed',edgeIds:['yes']},{stage:'pre',nodeId:'none',status:'skipped',edgeIds:['no']},{stage:'post',nodeId:'start',status:'completed',edgeIds:['entry','unknown'],attempt:2}]});
  const coverage=evaluationPathCoverage(workflow(),[result]);assert.ok(coverage);
  assert.equal(coverage.edges,3);assert.equal(coverage.totalEdges,4);assert.equal(coverage.branches,1);assert.equal(coverage.totalBranches,2);assert.deepEqual(coverage.attempts,[2]);assert.equal(coverage.uncoveredBranches.length,1);assert.match(coverage.uncoveredBranches[0],/거짓/);
});
test('coverage merges actual branch choices across rows and retry attempts without duplicate credit',()=>{
  const a=row('a','allow','allow',{flowTraces:[{stage:'pre',nodeId:'control:choose',status:'completed',edgeIds:['yes']},{stage:'post',nodeId:'start',status:'completed',edgeIds:['entry'],attempt:1},{stage:'post',nodeId:'start',status:'completed',edgeIds:['entry'],attempt:2}]});
  const b=row('b','allow','allow',{flowTraces:[{stage:'pre',nodeId:'control:choose',status:'completed',edgeIds:['no']}]});
  const coverage=evaluationPathCoverage(workflow(),[a,b]);assert.ok(coverage);assert.equal(coverage.edges,3);assert.equal(coverage.branches,2);assert.deepEqual(coverage.attempts,[1,2]);assert.equal(coverage.tracedRows,2);
});
test('legacy workflows do not invent path coverage and missing traces remain explicitly unobserved',()=>{
  const w=workflow();delete w.graph;assert.equal(evaluationPathCoverage(w,[]),undefined);
  const coverage=evaluationPathCoverage(workflow(),[row('a','allow','allow')]);assert.ok(coverage);assert.equal(coverage.tracedRows,0);assert.equal(coverage.totalRows,1);assert.equal(coverage.edges,0);assert.equal(coverage.branches,0);
});
