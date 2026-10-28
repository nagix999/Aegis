import type { DeploymentRequest } from './aegis-store';

function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,value])=>value!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>`${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
async function hash(value:unknown):Promise<string>{
  const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(result),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** The request identity survives a lost response without reinterpreting a
 * changed draft. Different payloads sharing an identity are rejected. */
export async function deploymentRequest(actor:string,key:string,data:Record<string,unknown>):Promise<DeploymentRequest>{
  const {idempotencyKey:_key,...command}=data;
  return {id:await hash({actor,key}),requestHash:await hash(command)};
}
