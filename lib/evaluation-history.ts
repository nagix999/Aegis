export type EvaluationHistoryFilters={query:string;workflowId:string;datasetId:string;status:string;from:string;to:string};
export const emptyEvaluationHistoryFilters:EvaluationHistoryFilters={query:'',workflowId:'',datasetId:'',status:'',from:'',to:''};

export function evaluationHistoryParams(filters:EvaluationHistoryFilters,cursor='',runId=''):string {
  const params=new URLSearchParams({view:'evaluations',history:'true',limit:'20'});
  for(const field of ['query','workflowId','datasetId','status'] as const)if(filters[field].trim())params.set(field,filters[field].trim());
  const day=(value:string)=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('조회 날짜를 확인하세요.');
    const date=new Date(`${value}T00:00:00+09:00`);
    if(!Number.isFinite(date.getTime())||new Date(date.getTime()+9*3600000).toISOString().slice(0,10)!==value)throw new Error('조회 날짜를 확인하세요.');
    return date;
  };
  const start=filters.from?day(filters.from):undefined,end=filters.to?new Date(day(filters.to).getTime()+86_400_000):undefined;
  if(start&&end&&start>=end)throw new Error('종료일은 시작일과 같거나 뒤여야 합니다.');
  if(start)params.set('from',start.toISOString());
  if(end)params.set('to',end.toISOString());
  if(cursor)params.set('cursor',cursor);
  if(runId)params.set('runId',runId);
  return params.toString();
}
