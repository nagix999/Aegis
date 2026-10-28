import type { EvalResult, EvalRun } from './aegis-types';

/** Explicit public report fields only: no policy raw output, snapshots, prompts, or leases. */
export function evaluationReport(run:EvalRun, rows:EvalResult[], filters:Record<string,string|boolean>) {
  const publicResult=(row:EvalResult)=>({rowId:row.rowId,requestId:row.id,input:row.input,category:row.category??'',expected:row.expected,
    expectedStage:row.expectedStage??'',expectedRuleId:row.expectedRuleId??'',expectedRoute:row.expectedRoute??'',expectedPolicyCode:row.expectedPolicyCode??'',
    status:row.status,stage:row.stage,expectationMatched:row.expectationMatched??null,latencyMs:row.latencyMs,
    policyRoute:row.policyRoute??'',policyCode:row.policyCode??'',regenerationCount:row.regenerationCount??0,
    policyFieldChecks:row.policyFieldChecks?.map(check=>({path:String(check.path),matched:check.matched===true}))??[],
    output:row.status==='allow'?row.output:'',
  });
  const baseline=new Map(run.baselineResults?.map(row=>[row.rowId,row]));
  return {formatVersion:1,runId:run.id,workflowId:run.workflowId,workflowName:run.workflowName,datasetId:run.datasetId,datasetName:run.datasetName,
    version:run.version,createdAt:run.createdAt,status:run.status??'completed',filters:{...filters},displayedCount:rows.length,totalCompleted:run.results.length,
    results:rows.map(row=>({...publicResult(row),...(baseline.has(row.rowId)?{baseline:publicResult(baseline.get(row.rowId)!)}:{})}))};
}

/** Quote every cell and neutralize spreadsheet formulas, including leading whitespace. */
export function evaluationReportCsv(report:ReturnType<typeof evaluationReport>):string {
  const fields=['rowId','requestId','input','category','expected','expectedStage','expectedRuleId','expectedRoute','expectedPolicyCode','status','stage','expectationMatched','latencyMs','policyRoute','policyCode','regenerationCount','policyFieldChecks','output'] as const;
  const cell=(value:unknown)=>{
    let text=value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);
    if(/^[\s]*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text))text=`'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  const comparison=report.results.some(row=>'baseline' in row);
  const headers=[...fields,...(comparison?fields.map(field=>`baseline.${field}`):[])];
  return '\uFEFF'+[headers.map(cell).join(','),...report.results.map(row=>[...fields.map(field=>cell(row[field])),...(comparison?fields.map(field=>cell(row.baseline?.[field])):[])].join(','))].join('\r\n');
}
