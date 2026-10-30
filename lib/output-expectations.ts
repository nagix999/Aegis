import type { PolicyExample, PolicyPredicate } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policyGraphSchemaIssues } from './policy-schema-guidance.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policyFieldInfo } from './policy-field-options.ts';

const object = (value:unknown):value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value:object,key:string) => Object.prototype.hasOwnProperty.call(value,key);
export const assertionOperators: PolicyPredicate['operator'][] = ['eq','ne','gt','gte','lt','lte','contains','in','exists'];
export type AssertionDrafts = Record<string,string>;
export function fieldAssertionErrors(fields:unknown,schema?:Record<string,unknown>):string[] {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 12) return ['출력 필드 조건은 1~12개를 등록하세요.'];
  const errors:string[] = [];
  for (const [index,field] of fields.entries()) {
    const fail = () => errors.push(`${index+1}번 출력 필드의 경로, 연산과 비교값을 확인하세요.`);
    if (!object(field) || Object.keys(field).some(key=>!['path','operator','value'].includes(key)) || typeof field.path !== 'string' || field.path.length>512 || field.path && !field.path.startsWith('/') || /~(?:[^01]|$)/.test(field.path) || field.path.split('/').length>13 || !assertionOperators.includes(field.operator as PolicyPredicate['operator'])) { fail(); continue; }
    if (field.operator==='exists') { if (own(field,'value') && typeof field.value!=='boolean')fail(); }
    else if (!own(field,'value'))fail();
    else if (['gt','gte','lt','lte'].includes(String(field.operator)) && (typeof field.value!=='number' || !Number.isFinite(field.value) || Math.abs(field.value)>Number.MAX_SAFE_INTEGER))fail();
    else if (field.operator==='in' && (!Array.isArray(field.value) || field.value.length<1 || field.value.length>64))fail();
    if (own(field,'value')) {
      try {
        const pending:{value:unknown;depth:number}[]=[{value:field.value,depth:0}];let count=0;
        while(pending.length){const {value,depth}=pending.pop()!;if(++count>10000||depth>32||typeof value==='number'&&(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)||['undefined','function','symbol'].includes(typeof value))throw new Error();if(value!==null&&typeof value==='object')Object.values(value).forEach(child=>pending.push({value:child,depth:depth+1}));}
        if(new TextEncoder().encode(JSON.stringify(field.value)).length>4096)throw new Error();
      } catch { fail(); }
    }
  }
  if (!errors.length && schema) errors.push(...policyGraphSchemaIssues({version:1,entryNodeId:'check',nodes:[{id:'check',name:'검증 조건',kind:'branch',condition:{mode:'all',predicates:fields as PolicyPredicate[]}}],edges:[]},schema).map(issue=>issue.message));
  return [...new Set(errors)];
}
export function assertionDraftErrors(fields:PolicyPredicate[],drafts:AssertionDrafts,schema?:Record<string,unknown>):string[] {
  return fields.flatMap((field,index)=>{
    if(field.operator==='exists'||!own(drafts,String(index)))return [];
    try {
      const value:unknown=JSON.parse(drafts[String(index)]),errors=fieldAssertionErrors([{...field,value}],schema);
      if(schema){
        const info=policyFieldInfo(schema,field.path),types=field.operator==='contains'&&info.types.includes('array')?policyFieldInfo(schema,field.path+'/0').types:info.types;
        const candidates=field.operator==='in'&&Array.isArray(value)?value:[value],type=(item:unknown)=>item===null?'null':Array.isArray(item)?'array':typeof item;
        if(types.length&&candidates.some(item=>!types.includes(type(item))&&!(typeof item==='number'&&Number.isInteger(item)&&types.includes('integer'))))errors.push(`${index+1}번 출력 필드 비교값의 자료형을 선택한 스키마에 맞춰 주세요.`);
      }
      return [...new Set(errors)];
    }
    catch{return [`${index+1}번 출력 필드 비교값의 JSON을 완성하세요.`];}
  });
}
export function policyExpectationErrors(example:PolicyExample,schema?:Record<string,unknown>):string[] {
  const expectation=example.expectation;
  if(expectation===undefined)return [];
  if(!object(expectation)||Object.keys(expectation).some(key=>!['mode','fields'].includes(key))||!['exact','schema','fields'].includes(expectation.mode))return ['예제 출력의 비교 방식을 확인하세요.'];
  return expectation.mode==='fields'?fieldAssertionErrors(expectation.fields,schema):expectation.fields!==undefined?['필드 조건은 선택 필드 비교에서만 사용하세요.']:[];
}
