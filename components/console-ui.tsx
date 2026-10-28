'use client';
import type { ReactNode } from 'react';
import type { AppState, ConsoleAction, ExecutionResult, EvalRun, Deployment, ConnectionDiagnostic, ModelMetrics, Dataset, PolicyRevision } from '@/lib/aegis-types';
export type PolicyTest = { mode: 'demo'|'vllm'; schema: Record<string,unknown>; results: {exampleId:string;expectedDecision?:string;decision?:string;status:'pass'|'fail'|'error';message:string;schemaValid?:boolean;expectationMatched?:boolean;checks?:{path:string;matched:boolean}[]}[] };
export type ConsoleReply = {state:AppState; policy?:PolicyRevision; policyTest?:PolicyTest; result?:ExecutionResult; fingerprint?:string; run?:EvalRun; dataset?:Dataset; deployment?:Deployment; key?:string; diagnostic?:ConnectionDiagnostic; modelMetric?:ModelMetrics; leaseActive?:boolean; test?:{ok:boolean;latencyMs:number;message:string}};
export type Act = (payload:ConsoleAction)=>Promise<ConsoleReply|undefined>;
export type PageProps = {state:AppState; act:Act; notify:(message:string)=>void};
export function Tag({children,tone='neutral'}:{children:ReactNode;tone?:string}){return <span className={`tag ${tone}`}>{children}</span>}
export function Empty({title,description,icon}:{title:string;description:string;icon?:ReactNode}){return <div className="empty">{icon}<strong>{title}</strong><p>{description}</p></div>}
export function PageHeading({title,description,children}:{eyebrow?:string;title:string;description:string;children?:ReactNode}){return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{children}</div></div>}
export function timeLabel(s:string){return new Date(s).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
