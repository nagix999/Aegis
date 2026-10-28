import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node source runner uses explicit TypeScript paths.
import { evaluationHistoryParams, emptyEvaluationHistoryFilters } from '../lib/evaluation-history.ts';
// @ts-expect-error Node source runner uses explicit TypeScript paths.
import { evaluationReport, evaluationReportCsv } from '../lib/evaluation-export.ts';
// @ts-expect-error Node source runner uses explicit TypeScript paths.
import { emptyLogFilters, logSearchParams } from '../lib/log-search.ts';
import type { EvalResult, EvalRun } from '../lib/aegis-types';

test('history query has bounded pages, exact metadata filters, and whole Korean days',()=>{
  const params=new URLSearchParams(evaluationHistoryParams({...emptyEvaluationHistoryFilters,workflowId:'wf-one',datasetId:'ds-one',status:'completed',query:'이전 기록',from:'2026-10-01',to:'2026-10-02'},'cursor-value','exact-run'));
  assert.equal(params.get('history'),'true');assert.equal(params.get('limit'),'20');assert.equal(params.get('workflowId'),'wf-one');assert.equal(params.get('datasetId'),'ds-one');
  assert.equal(params.get('from'),'2026-09-30T15:00:00.000Z');assert.equal(params.get('to'),'2026-10-02T15:00:00.000Z');assert.equal(params.get('cursor'),'cursor-value');assert.equal(params.get('runId'),'exact-run');
});

test('invalid or reversed dates are rejected instead of silently broadening history',()=>{
  for(const dates of [{from:'2026-02-30'},{to:'not-date'},{from:'2026-10-03',to:'2026-10-02'}])assert.throws(()=>evaluationHistoryParams({...emptyEvaluationHistoryFilters,...dates}));
});
test('dashboard log drilldown preserves exact instants instead of expanding to whole days',()=>{
  const filters={...emptyLogFilters,from:'2026-10-01',to:'2026-10-02',fromInstant:'2026-10-28T13:25:07.123+09:00',toInstant:'2026-10-29T04:25:07.123Z'};
  const params=new URLSearchParams(logSearchParams(filters));
  assert.equal(params.get('from'),'2026-10-28T04:25:07.123Z');assert.equal(params.get('to'),'2026-10-29T04:25:07.123Z');
  assert.equal(Date.parse(params.get('to')!)-Date.parse(params.get('from')!),86_400_000);
  for(const value of ['2026-10-28T00:00:00','2026-02-30T00:00:00Z','2026-10-28T24:00:00Z','invalid'])assert.throws(()=>logSearchParams({...emptyLogFilters,fromInstant:value}));
  assert.throws(()=>logSearchParams({...filters,toInstant:'2026-10-28T00:00:00Z'}));
});

function fixture(){
  const row=(id:string,status:EvalResult['status'],input:string):EvalResult=>({id:`request-${id}`,rowId:id,input,expected:'allow',status,stage:'post',output:status==='allow'?'공개 응답':'PRIVATE_BLOCKED_OUTPUT',reason:'PRIVATE_REASON',latencyMs:7,traces:[],expectationMatched:status==='allow'});
  const results=[row('allowed','allow','배송 질문'),row('blocked','block','=HYPERLINK("https://invalid")'),row('error','error','\n+1')];
  const run:EvalRun={id:'run',workflowId:'workflow',workflowName:'상담',datasetId:'dataset',datasetName:'사례',createdAt:'2026-10-28T00:00:00Z',version:'draft',results,baselineResults:results.map(value=>({...value,output:'PRIVATE_BASELINE_OUTPUT',status:'block'}))};
  Object.assign(run,{_lease:'PRIVATE_LEASE',connectionsSnapshot:[{secretEnv:'PRIVATE_KEY_REFERENCE'}]});Object.assign(results[1],{policyOutput:{raw:'PRIVATE_POLICY_OUTPUT'},policyFieldChecks:[{path:'/risk/score',matched:false,actual:'PRIVATE_ACTUAL',expected:'PRIVATE_EXPECTED'}]});
  return {run,results};
}

test('filtered report whitelists public fields and never exports blocked/error or baseline raw output',()=>{
  const {run,results}=fixture(),before=structuredClone(run);
  const report=evaluationReport(run,results.slice(1),{result:'block',category:'all',changedOnly:false}),json=JSON.stringify(report);
  assert.equal(report.displayedCount,2);assert.equal(report.totalCompleted,3);assert.equal(report.results.some(value=>value.rowId==='allowed'),false);
  assert.equal(json.includes('PRIVATE_'),false);assert.equal(report.results[0].output,'');assert.equal(report.results[1].baseline?.output,'');
  assert.deepEqual(report.results[0].policyFieldChecks,[{path:'/risk/score',matched:false}]);
  assert.deepEqual(run,before);
});

test('allowed outputs remain exportable and CSV quotes delimiters, newlines and formulas',()=>{
  const {run,results}=fixture();results[0].output='공개, "응답"\n다음 줄';
  const report=evaluationReport(run,results,{}),csv=evaluationReportCsv(report);
  assert.equal(report.results[0].output,results[0].output);assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"공개, ""응답""\n다음 줄"'));
  assert.ok(csv.includes('"\'=HYPERLINK('));assert.ok(csv.includes('"\'\n+1"'));assert.equal(csv.includes('PRIVATE_'),false);assert.ok(csv.includes('baseline.status'));
});
