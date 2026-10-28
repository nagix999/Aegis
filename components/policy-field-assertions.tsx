'use client';
import {useId} from 'react';
import {Plus, Trash2} from 'lucide-react';
import type {PolicyPredicate} from '@/lib/aegis-types';
import {assertionDraftErrors, assertionOperators, type AssertionDrafts} from '@/lib/output-expectations';
import {policySchemaOutline} from './policy-editor-model';
import './policy-field-assertions.css';

const labels:Record<PolicyPredicate['operator'],string>={eq:'같음',ne:'다름',gt:'초과',gte:'이상',lt:'미만',lte:'이하',contains:'포함',in:'목록에 포함',exists:'존재 여부'};
const kind=(value:unknown)=>value===null?'null':typeof value==='string'?'string':typeof value==='number'?'number':typeof value==='boolean'?'boolean':'json';
export function PolicyFieldAssertions({values,drafts,disabled,schema,onChange,onDraftsChange,label}: {values:PolicyPredicate[];drafts:AssertionDrafts;disabled:boolean;schema?:Record<string,unknown>;onChange:(values:PolicyPredicate[])=>void;onDraftsChange:(drafts:AssertionDrafts)=>void;label:string}){
  const id=useId();
  const fields=schema?policySchemaOutline(schema).filter(field=>!field.path.includes('*')&&!/\/(?:allOf|anyOf|oneOf)\//.test(field.path)):[];
  const draftErrors=assertionDraftErrors(values,drafts);
  const patch=(index:number,next:Partial<PolicyPredicate>)=>onChange(values.map((value,i)=>i===index?{...value,...next}:value));
  const clearDraft=(index:number)=>{const next={...drafts};delete next[String(index)];onDraftsChange(next);};
  const changeValue=(index:number,source:string)=>{
    onDraftsChange({...drafts,[index]:source});
    try{const value:unknown=JSON.parse(source);patch(index,{value});}catch{/* Keep unfinished JSON in the parent across item navigation. */}
  };
  return <div className="policy-field-assertions" aria-label={label}><p>모든 필드 조건을 만족해야 일치입니다. 정책 출력 원문은 표시하거나 검증 결과에 저장하지 않습니다.</p>
    {values.map((field,index)=><div className="policy-field-assertion" key={index}><label>출력 필드 경로<input aria-label={`${label} ${index+1} 필드 경로`} value={field.path} list={`${id}-paths`} maxLength={512} placeholder="/risk/score" disabled={disabled} onChange={event=>patch(index,{path:event.target.value})}/></label><label>비교<select aria-label={`${label} ${index+1} 연산`} value={field.operator} disabled={disabled} onChange={event=>{const operator=event.target.value as PolicyPredicate['operator'];patch(index,{operator,value:operator==='exists'?true:operator==='in'?[]:['gt','gte','lt','lte'].includes(operator)?0:''});clearDraft(index);}}>{assertionOperators.map(operator=><option key={operator} value={operator}>{labels[operator]}</option>)}</select></label>
      <label>자료형<select aria-label={`${label} ${index+1} 값 자료형`} disabled={disabled||field.operator==='exists'||field.operator==='in'} value={field.operator==='exists'?'boolean':field.operator==='in'?'json':kind(field.value)} onChange={event=>{const type=event.target.value;patch(index,{value:type==='string'?'':type==='number'?0:type==='boolean'?false:type==='null'?null:{}});clearDraft(index);}}><option value="string">문자열</option><option value="number">숫자</option><option value="boolean">참/거짓</option><option value="null">null</option><option value="json">JSON</option></select></label>
      <label className="policy-field-assertion-value">비교값{field.operator==='exists'||typeof field.value==='boolean'?<select aria-label={`${label} ${index+1} 비교값`} disabled={disabled} value={String(field.value??true)} onChange={event=>patch(index,{value:event.target.value==='true'})}><option value="true">{field.operator==='exists'?'존재함':'true'}</option><option value="false">{field.operator==='exists'?'존재하지 않음':'false'}</option></select>:typeof field.value==='string'?<input aria-label={`${label} ${index+1} 비교값`} maxLength={4096} disabled={disabled} value={field.value} onChange={event=>{patch(index,{value:event.target.value});clearDraft(index);}}/>:field.value===null?<input aria-label={`${label} ${index+1} 비교값`} value="null" disabled readOnly/>:<textarea aria-label={`${label} ${index+1} 비교값`} rows={typeof field.value==='number'?1:2} maxLength={16384} spellCheck={false} disabled={disabled} value={drafts[String(index)]??JSON.stringify(field.value??null)} onChange={event=>changeValue(index,event.target.value)} placeholder={field.operator==='in'?'["service", "other"]':'JSON 값'}/>}</label>
      <button type="button" className="icon-button" aria-label={`${label} ${index+1} 조건 삭제`} disabled={disabled} onClick={()=>{onChange(values.filter((_,i)=>i!==index));onDraftsChange(Object.fromEntries(Object.entries(drafts).filter(([key])=>Number(key)!==index).map(([key,value])=>[String(Number(key)>index?Number(key)-1:Number(key)),value])));}}><Trash2 size={14}/></button></div>)}
    <datalist id={`${id}-paths`}>{fields.map((field,index)=><option value={index===0&&field.path==='/'?'':field.path} key={`${field.path}-${index}`}>{field.path} / {field.type}</option>)}</datalist>
    {draftErrors.length>0 && <div className="policy-field-assertion-errors" role="alert">{draftErrors.map((error,index)=><p key={index}>{error}</p>)}</div>}
    <button type="button" className="btn small" disabled={disabled||values.length>=12} onClick={()=>onChange([...values,{path:'',operator:'eq',value:''}])}><Plus size={13}/> 필드 조건 추가</button>
  </div>;
}
