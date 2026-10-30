import type { Dataset, DatasetRow, PolicyPredicate, Workflow } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policyFieldInfo } from './policy-field-options.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { fieldAssertionErrors } from './output-expectations.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policyOutputSchema } from './policy-routing.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policySwitchErrors } from './policy-graph.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policySchemaField } from './policy-schema-guidance.ts';

export type DatasetBulkPatch = Partial<Pick<DatasetRow,'expected'|'category'|'expectedStage'|'expectedRuleId'|'expectedRoute'|'expectedPolicyCode'|'expectedPolicyFields'>>;
export function applyDatasetBulkPatch(dataset:Dataset,rowIds:string[],patch:DatasetBulkPatch):Dataset {
  const allowed=new Set(['expected','category','expectedStage','expectedRuleId','expectedRoute','expectedPolicyCode','expectedPolicyFields']);
  if(Object.keys(patch).some(key=>!allowed.has(key)))throw new Error('일괄 설정할 검증 기준을 확인하세요.');
  if(!rowIds.length||rowIds.some(id=>!dataset.rows.some(row=>row.id===id)))throw new Error('선택한 검증 항목이 변경되었습니다. 다시 선택하세요.');
  const selected=new Set(rowIds);
  return {...dataset,rows:dataset.rows.map(row=>selected.has(row.id)?{...row,...structuredClone(patch)}:row)};
}
export function datasetSchemaImpacts(rows:DatasetRow[],schema?:Record<string,unknown>):{rowId:string;index:number;messages:string[]}[] {
  if(!schema)return [];
  return rows.flatMap((row,index)=>{const messages=row.expectedPolicyFields?fieldAssertionErrors(row.expectedPolicyFields,schema):[];return messages.length?[{rowId:row.id,index,messages}]:[];});
}
export type SwitchDatasetTemplate = {input:'';category:string;note:string;expectedPolicyFields:PolicyPredicate[]};
function definitelyOptionalField(schema:Record<string,unknown>,path:string):boolean {
  if(!path)return false;
  const permitted=new Set(['type','properties','required','additionalProperties','title','description','$comment']);
  const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
  let node:unknown=schema,optional=false;
  for(const token of path.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'))){
    if(!object(node)||node.type!=='object'||Object.keys(node).some(key=>!permitted.has(key))||!object(node.properties)||!Object.prototype.hasOwnProperty.call(node.properties,token)||node.required!==undefined&&(!Array.isArray(node.required)||node.required.some(item=>typeof item!=='string')))return false;
    if(!Array.isArray(node.required)||!node.required.includes(token))optional=true;
    node=node.properties[token];
  }
  const uncertain=new Set(['$ref','allOf','anyOf','oneOf','not','if','then','else','dependentSchemas','dependentRequired','dependencies','minProperties','maxProperties','patternProperties','propertyNames']);
  return optional&&object(node)&&Object.keys(node).every(key=>!uncertain.has(key));
}
/** Copies configured comparison literals only. User requests and final verdicts remain unanswered. */
export function switchDatasetTemplates(workflow:Workflow,nodeId:string):{templates:SwitchDatasetTemplate[];defaultNotice:string} {
  const routing=workflow.policyRouting,node=routing?.graph?.nodes.find(node=>node.id===nodeId);
  if(!routing||routing.policy.formatVersion!==2||node?.kind!=='switch')throw new Error('구조화 출력 정책의 Switch 노드를 선택하세요.');
  const errors=policySwitchErrors(node);if(errors.length)throw new Error(errors[0]);
  const source=`${workflow.name} / ${node.name} / ${routing.policy.name} v${routing.policy.version}`;
  const template=(value:unknown,title:string):SwitchDatasetTemplate=>({input:'',category:'Switch 분기',note:`${source}\n${title}\n요청과 최종 예상 결과를 직접 작성하세요.`.slice(0,1000),expectedPolicyFields:[{path:node.path,operator:'eq',value:structuredClone(value)}]});
  const templates=node.cases.map((item,index)=>template(item.value,`비교값 ${index+1}: ${JSON.stringify(item.value)}`));
  const schema=policyOutputSchema(routing.policy),info=policyFieldInfo(schema,node.path),field=policySchemaField(schema,node.path);
  const simpleKeys=new Set(['type','enum','const','title','description','examples','default','$comment','readOnly','writeOnly','deprecated']);
  const definite=field.status==='known'&&field.schema&&Object.keys(field.schema).every(key=>simpleKeys.has(key));
  const candidate=definite&&info.source==='schema'&&info.complete?info.values.find(value=>!node.cases.some(item=>item.value===value)):undefined;
  const notices:string[]=[];
  if(candidate!==undefined){templates.push(template(candidate,'기본 경로: 스키마 허용값 중 등록한 비교값과 일치하지 않는 값'));notices.push('기본 경로에 스키마가 허용하는 미일치 값 사례를 만들었습니다.');}
  if(definitelyOptionalField(schema,node.path)){
    templates.push({input:'',category:'Switch 분기',note:`${source}\n기본 경로: 스키마에서 선택 필드의 누락을 허용합니다. null과는 다른 사례입니다.\n요청과 최종 예상 결과를 직접 작성하세요.`.slice(0,1000),expectedPolicyFields:[{path:node.path,operator:'exists',value:false}]});
    notices.push('스키마가 선택 필드의 누락을 허용해 필드가 없는 기본 경로 사례를 별도로 만들었습니다.');
  }
  if(notices.length)return {templates,defaultNotice:notices.join(' ')+' 실제 요청과 최종 예상 결과는 직접 작성하세요.'};
  return {templates,defaultNotice:'스키마에서 미일치 허용값을 확정할 수 없어 기본 경로 사례는 만들지 않았습니다. 필드 누락과 실제 null은 서로 다른 조건으로 직접 추가할 수 있습니다.'};
}
