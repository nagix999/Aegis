/** Only selection metadata belongs in a bookmark. Inputs, outputs and secrets stay in memory. */
export const consolePages = ['dashboard','workflows','policies','connections','access','datasets','evaluation','gateway','logs','operations'] as const;
export type ConsolePage = typeof consolePages[number];
export type ConsoleRoute = { page: ConsolePage; workflowId?:string; nodeId?:string; policyId?:string; policyVersion?:number; datasetId?:string; runId?:string; tab?:'single'|'batch'|'compare'; target?:'draft'|'deployed'; deploymentId?:string; requestId?:string; from?:string; to?:string; status?:string; source?:string; keyId?:string };
const identifiers = ['workflowId','nodeId','policyId','datasetId','runId','deploymentId','requestId','keyId'] as const;
const day = (value:string|null) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value ? value : undefined;
const instant=(value:string|null)=>value&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)&&day(value.slice(0,10))&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():undefined;

export function readConsoleRoute(search:string):ConsoleRoute {
  const params=new URLSearchParams(search),page=params.get('page');
  const route:ConsoleRoute={page:consolePages.includes(page as ConsolePage)?page as ConsolePage:'workflows'};
  for(const key of identifiers){const value=params.get(key);if(value&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value))route[key]=value;}
  const version=Number(params.get('policyVersion'));
  if(Number.isInteger(version)&&version>0&&version<=100000)route.policyVersion=version;
  const tab=params.get('tab'),target=params.get('target'),status=params.get('status'),source=params.get('source');
  if(tab&&['single','batch','compare'].includes(tab))route.tab=tab as ConsoleRoute['tab'];
  if(target==='draft'||target==='deployed')route.target=target;
  if(status&&['allow','block','error'].includes(status))route.status=status;
  if(source&&['gateway','evaluation','playground'].includes(source))route.source=source;
  route.from=day(params.get('from'))??instant(params.get('from'));route.to=day(params.get('to'))??instant(params.get('to'));
  if(route.from&&route.to){
    const start=Date.parse(route.from.includes('T')?route.from:`${route.from}T00:00:00+09:00`);
    const end=Date.parse(route.to.includes('T')?route.to:`${route.to}T00:00:00+09:00`)+(route.to.includes('T')?0:86400000);
    if(start>=end){delete route.from;delete route.to;}
  }
  return compactConsoleRoute(route);
}

/** Projection also removes irrelevant IDs left over from another page. */
export function compactConsoleRoute(route:ConsoleRoute):ConsoleRoute {
  const result:ConsoleRoute={page:route.page};
  const keys:Partial<Record<ConsolePage,(keyof ConsoleRoute)[]>>={
    workflows:['workflowId','nodeId'], policies:['policyId','policyVersion'], datasets:['datasetId'],
    evaluation:['workflowId','datasetId','runId','tab','target','deploymentId'],
    gateway:['workflowId','deploymentId'], logs:['workflowId','keyId','requestId','from','to','status','source'],
  };
  for(const key of keys[route.page]||[]){const value=route[key];if(value!==undefined&&value!=='')Object.assign(result,{[key]:value});}
  return result;
}

export function consoleRouteSearch(route:ConsoleRoute):string {
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(compactConsoleRoute(route)))params.set(key,String(value));
  return `?${params.toString()}`;
}

/** Field edits and filter changes replace one entry; opening another object creates an entry. */
export function consoleRouteIdentity(route:ConsoleRoute):string {
  return [route.page,route.page==='workflows'?route.workflowId:route.page==='policies'?route.policyId:route.page==='datasets'?route.datasetId:route.page==='evaluation'?route.runId:route.page==='gateway'?route.deploymentId:route.requestId].filter(Boolean).join('/');
}
