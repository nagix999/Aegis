import type { PolicyGraph, PolicyPredicate } from './aegis-types';

type Schema = Record<string, unknown>;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Schema => !!value && typeof value === 'object' && !Array.isArray(value);
const complexKeys = ['$ref','allOf','anyOf','oneOf','not','if','then','else','dependentSchemas','patternProperties'];
const complex = (schema: Schema) => complexKeys.some(key => own(schema,key));
const tokens = (path: string) => path === '' ? [] : path.slice(1).split('/').map(part => part.replace(/~1/g,'/').replace(/~0/g,'~'));
const escape = (value: string) => value.replace(/~/g,'~0').replace(/\//g,'~1');
export type PolicySchemaField = { status:'known'|'missing'|'unknown'; schema?:Schema; types:string[] };

/** A conservative editing aid. Ambiguous/open schemas stay with Python validation. */
export function policySchemaField(schema: Schema, path: string): PolicySchemaField {
  if (typeof path !== 'string' || path.length>512 || path && !path.startsWith('/') || /~(?:[^01]|$)/.test(path) || tokens(path).length>12) return {status:'missing',types:[]};
  let selected:unknown=schema;
  for(const token of tokens(path)) {
    if(!object(selected)||complex(selected)) return {status:'unknown',types:[]};
    if(object(selected.properties)&&own(selected.properties,token)){selected=selected.properties[token];continue;}
    const types=typeof selected.type==='string'?[selected.type]:Array.isArray(selected.type)?selected.type:[];
    if(/^(0|[1-9]\d{0,4})$/.test(token)&&(types.includes('array')||!types.length)) {
      if(Array.isArray(selected.prefixItems)&&Number(token)<selected.prefixItems.length){selected=selected.prefixItems[Number(token)];continue;}
      if(object(selected.items)){selected=selected.items;continue;}
      if(selected.items!==false)return {status:'unknown',types:[]};
    }
    if((!types.length||types.includes('object'))&&selected.additionalProperties!==false)return {status:'unknown',types:[]};
    return {status:'missing',types:[]};
  }
  if(!object(selected)||complex(selected))return {status:'unknown',...(object(selected)?{schema:selected}:{}),types:[]};
  const declared=typeof selected.type==='string'?[selected.type]:Array.isArray(selected.type)?selected.type.filter(type=>typeof type==='string') as string[]:[];
  return {status:declared.length?'known':'unknown',schema:selected,types:declared};
}

export type PolicyConditionIssue = {nodeId:string;nodeName:string;predicateIndex:number;path:string;code:'path'|'operator'|'value';message:string};
const valueType = (value:unknown):string => value===null?'null':Array.isArray(value)?'array':typeof value==='object'?'object':typeof value;
const compatible = (value:unknown,types:string[]) => !(typeof value==='number'&&(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER))&&(types.includes(valueType(value)) || typeof value==='number'&&types.includes('integer')&&Number.isInteger(value));
export function policyGraphSchemaIssues(graph:PolicyGraph,schema:Schema):PolicyConditionIssue[] {
  const issues:PolicyConditionIssue[]=[];
  for(const node of graph.nodes){
    if(!object(node))continue;
    if(node.kind==='switch'){
      if(typeof node.path!=='string')continue;
      const field=policySchemaField(schema,node.path),add=(predicateIndex:number,code:PolicyConditionIssue['code'],message:string)=>issues.push({nodeId:node.id,nodeName:node.name,predicateIndex,path:node.path,code,message});
      if(field.status==='missing'){add(0,'path','출력 스키마에 없는 필드입니다. 경로를 다시 선택하세요.');continue;}
      if(field.status!=='known'||!Array.isArray(node.cases))continue;
      node.cases.forEach((item,caseIndex)=>{
        if(object(item)&&own(item,'value')&&!compatible(item.value,field.types))add(caseIndex,'value','Switch 비교값의 자료형을 출력 필드에 맞춰 주세요.');
      });
      continue;
    }
    if(node.kind!=='action'&&object(node.condition)&&Array.isArray(node.condition.predicates))node.condition.predicates.forEach((predicate,predicateIndex)=>{
    if(!object(predicate)||typeof predicate.path!=='string')return;
    const field=policySchemaField(schema,predicate.path),add=(code:PolicyConditionIssue['code'],message:string)=>issues.push({nodeId:node.id,nodeName:node.name,predicateIndex,path:predicate.path,code,message});
    if(field.status==='missing'){add('path','출력 스키마에 없는 필드입니다. 경로를 다시 선택하세요.');return;}
    if(field.status!=='known')return;
    if(predicate.operator==='exists')return;
    if(predicate.value===undefined)return;
    const numeric=['gt','gte','lt','lte'].includes(predicate.operator);
    if(numeric&&!field.types.some(type=>['integer','number'].includes(type)))add('operator','숫자 비교는 숫자 필드에서 사용하세요.');
    else if(numeric&&(typeof predicate.value!=='number'||!Number.isFinite(predicate.value)))add('value','숫자 비교값을 유한한 숫자로 입력하세요.');
    else if(predicate.operator==='in') {
      if(Array.isArray(predicate.value)&&predicate.value.some(value=>!compatible(value,field.types)))add('value','비교 목록의 값 자료형을 출력 필드에 맞춰 주세요.');
    } else if(predicate.operator==='contains') {
      if(field.types.includes('string')&&typeof predicate.value==='string')return;
      if(field.types.includes('array')) {
        const item=policySchemaField(schema,predicate.path+'/0');
        if(item.status==='known'&&!compatible(predicate.value,item.types))add('value','배열 항목의 자료형에 맞는 비교값을 입력하세요.');
      } else if(field.types.includes('string'))add('value','문자열 포함 조건에는 문자열을 입력하세요.');
      else add('operator','포함 조건은 문자열 또는 배열 필드에서 사용하세요.');
    } else if(!numeric&&!compatible(predicate.value,field.types))add('value','비교값의 자료형을 출력 필드에 맞춰 주세요.');
  });
  }
  return issues;
}

export type PolicyValueInput = {kind:'string'|'number'|'integer'|'boolean'|'null'|'enum'|'json';nullable:boolean;values?:unknown[]};
export function policyValueInput(schema:Schema,predicate:PolicyPredicate):PolicyValueInput {
  let field=policySchemaField(schema,predicate.path);
  if(predicate.operator==='in')return {kind:'json',nullable:false};
  if(predicate.operator==='contains'&&field.types.includes('array'))field=policySchemaField(schema,predicate.path+'/0');
  if(field.status!=='known')return {kind:'json',nullable:false};
  if(['gt','gte','lt','lte'].includes(predicate.operator)&&field.types.some(type=>['integer','number'].includes(type)))return {kind:'number',nullable:false};
  const nullable=field.types.includes('null'),nonNull=field.types.filter(type=>type!=='null');
  if(['eq','ne'].includes(predicate.operator)&&Array.isArray(field.schema?.enum)&&field.schema.enum.every(value=>value===null||['string','number','boolean'].includes(typeof value)))return {kind:'enum',nullable,values:field.schema.enum};
  if(!nonNull.length&&nullable)return {kind:'null',nullable:true};
  if(nonNull.length!==1||!['string','integer','number','boolean'].includes(nonNull[0]))return {kind:'json',nullable};
  return {kind:nonNull[0] as PolicyValueInput['kind'],nullable};
}

export type PolicySchemaChange = {path:string;kind:'removed'|'type'|'changed';before:string;after:string};
function simpleFields(schema:Schema):Map<string,Schema> {
  const result=new Map<string,Schema>();
  const walk=(node:unknown,path:string,depth:number)=>{if(!object(node)||depth>12||result.size>=256)return;result.set(path,node);if(complex(node))return;if(object(node.properties))for(const [key,value]of Object.entries(node.properties))walk(value,path+'/'+escape(key),depth+1);if(object(node.items))walk(node.items,path+'/0',depth+1);};walk(schema,'',0);return result;
}
export function policySchemaChanges(before:Schema,after:Schema):PolicySchemaChange[] {
  const changes:PolicySchemaChange[]=[];
  for(const [path,previous]of simpleFields(before)) {
    if(!path)continue;
    const next=policySchemaField(after,path);
    if(next.status==='missing'){changes.push({path,kind:'removed',before:JSON.stringify(previous.type??'JSON'),after:'필드 없음'});continue;}
    if(next.status==='known'&&JSON.stringify(previous.type)!==JSON.stringify(next.schema?.type))changes.push({path,kind:'type',before:JSON.stringify(previous.type??'JSON'),after:JSON.stringify(next.schema?.type??'JSON')});
    else if(next.schema&&JSON.stringify(previous.enum)!==JSON.stringify(next.schema.enum))changes.push({path,kind:'changed',before:'기존 허용값',after:'허용값 변경'});
  }
  return changes;
}

export type PolicyExampleIssue = {exampleId:string;exampleIndex:number;path:string;message:string};
const equal = (a:unknown,b:unknown):boolean => typeof a===typeof b&&(a===b||Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((item,i)=>equal(item,b[i]))||object(a)&&object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>own(b,key)&&equal(a[key],b[key])));
/** Only definite failures of simple schemas. Never substitutes for JSON Schema validation. */
export function policyExampleIssues(schema:Schema,examples:{id:string;expectedOutput?:unknown}[]):PolicyExampleIssue[] {
  const issues:PolicyExampleIssue[]=[];
  examples.forEach((example,exampleIndex)=>{
    const visit=(node:unknown,value:unknown,path:string,depth:number)=>{
      if(!object(node)||complex(node)||depth>12||issues.length>=100)return;
      const add=(message:string,at=path)=>issues.push({exampleId:example.id,exampleIndex,path:at,message});
      const types=typeof node.type==='string'?[node.type]:Array.isArray(node.type)?node.type.filter(type=>typeof type==='string') as string[]:[];
      if(types.length&&!compatible(value,types)){add('예상 JSON의 자료형을 스키마에 맞춰 주세요.');return;}
      if(Array.isArray(node.enum)&&!node.enum.some(item=>equal(item,value)))add('예상 JSON이 허용값에 포함되지 않습니다.');
      if(own(node,'const')&&!equal(node.const,value))add('예상 JSON이 고정값과 다릅니다.');
      if(object(value)) {
        if(Array.isArray(node.required))for(const key of node.required)if(typeof key==='string'&&!own(value,key))add('필수 값이 없습니다.',path+'/'+escape(key));
        for(const [key,child]of Object.entries(value)) {
          if(object(node.properties)&&own(node.properties,key))visit(node.properties[key],child,path+'/'+escape(key),depth+1);
          else if(node.additionalProperties===false)add('스키마에 없는 필드입니다.',path+'/'+escape(key));
        }
      }
      if(Array.isArray(value)) {
        if(typeof node.minItems==='number'&&value.length<node.minItems)add('배열의 최소 항목 수를 확인하세요.');
        if(typeof node.maxItems==='number'&&value.length>node.maxItems)add('배열의 최대 항목 수를 확인하세요.');
        if(node.items)value.forEach((item,i)=>visit(node.items,item,path+'/'+i,depth+1));
      }
      if(typeof value==='number') {
        if(typeof node.minimum==='number'&&value<node.minimum||typeof node.exclusiveMinimum==='number'&&value<=node.exclusiveMinimum)add('숫자의 최솟값을 확인하세요.');
        if(typeof node.maximum==='number'&&value>node.maximum||typeof node.exclusiveMaximum==='number'&&value>=node.exclusiveMaximum)add('숫자의 최댓값을 확인하세요.');
      }
      if(typeof value==='string') {
        const length=Array.from(value).length;
        if(typeof node.minLength==='number'&&length<node.minLength)add('문자열의 최소 길이를 확인하세요.');
        if(typeof node.maxLength==='number'&&length>node.maxLength)add('문자열의 최대 길이를 확인하세요.');
      }
    };if(own(example,'expectedOutput'))visit(schema,example.expectedOutput,'',0);
  });return issues;
}
