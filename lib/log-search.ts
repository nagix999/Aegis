export type LogSearchFilters = { query:string; source:string; status:string; workflowId:string; keyId:string; from:string; to:string; fromInstant?:string; toInstant?:string };
export const emptyLogFilters: LogSearchFilters = { query:'', source:'', status:'', workflowId:'', keyId:'', from:'', to:'' };

/** A date chosen by the operator describes a whole day in Korea. */
export function logSearchParams(filters:LogSearchFilters, cursor=''):string {
  const params=new URLSearchParams({view:'logs',limit:'50'});
  for(const key of ['query','source','status','workflowId','keyId'] as const) if(filters[key].trim()) params.set(key,filters[key].trim());
  const day=(value:string)=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('조회 날짜를 확인하세요.');
    const date=new Date(`${value}T00:00:00+09:00`);
    if(!Number.isFinite(date.getTime())||new Date(date.getTime()+9*3600000).toISOString().slice(0,10)!==value)throw new Error('조회 날짜를 확인하세요.');
    return date;
  };
  const instant=(value:string)=>{
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))throw new Error('정확한 조회 시각과 시간대를 확인하세요.');
    const parsed=new Date(value);
    if(!Number.isFinite(parsed.getTime()))throw new Error('정확한 조회 시각을 확인하세요.');
    if(Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)throw new Error('정확한 조회 시각을 확인하세요.');
    // Date.parse can normalize impossible calendar dates instead of rejecting them.
    day(value.slice(0,10));
    return parsed;
  };
  const from=filters.fromInstant?instant(filters.fromInstant):filters.from?day(filters.from):undefined;
  const to=filters.toInstant?instant(filters.toInstant):filters.to?new Date(day(filters.to).getTime()+86400000):undefined;
  if(from&&to&&from>=to)throw new Error('종료일은 시작일과 같거나 뒤여야 합니다.');
  if(from)params.set('from',from.toISOString());
  if(to)params.set('to',to.toISOString());
  if(cursor)params.set('cursor',cursor);
  return params.toString();
}
