import type { PolicyGraph, PolicyGraphNode, PolicyPredicate, PolicySwitchValue } from './aegis-types';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { policySchemaPaths, validPolicyPointer, validPolicySwitchValue } from './policy-graph.ts';

type Schema=Record<string,unknown>;
type Analysis={types:string[];values:PolicySwitchValue[];complete:boolean;required:boolean;hints:PolicySwitchValue[]};
export type PolicyFieldInfo={path:string;types:string[];values:PolicySwitchValue[];source:'schema'|'examples'|'none';complete:boolean;required:boolean};
export type PolicyFieldOption={path:string;types:string[];required:boolean;title?:string;description?:string};
const object=(value:unknown):value is Schema=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const key=(value:PolicySwitchValue)=>JSON.stringify(value);
const unique=(values:PolicySwitchValue[])=>[...new Map(values.map(value=>[key(value),value])).values()];
const unknown=():Analysis=>({types:[],values:[],complete:false,required:false,hints:[]});
const matchesType=(value:PolicySwitchValue,types:string[])=>!types.length||types.includes(value===null?'null':typeof value)||typeof value==='number'&&Number.isInteger(value)&&types.includes('integer');

function intersect(left:Analysis,right:Analysis):Analysis {
  const types=left.types.length&&right.types.length?left.types.filter(type=>right.types.includes(type)||type==='integer'&&right.types.includes('number')||type==='number'&&right.types.includes('integer')).map(type=>type==='number'&&right.types.includes('integer')?'integer':type):left.types.length?left.types:right.types;
  const values=left.complete?left.values.filter(value=>matchesType(value,right.types)&&(!right.complete||right.values.some(part=>key(part)===key(value)))):right.complete?right.values.filter(value=>matchesType(value,left.types)):unique([...left.values,...right.values]).filter(value=>matchesType(value,types));
  return {types:[...new Set(types)],values,complete:left.complete||right.complete,required:left.required||right.required,hints:unique([...left.hints,...right.hints])};
}
function union(parts:Analysis[]):Analysis {
  return {types:parts.every(part=>part.types.length)?[...new Set(parts.flatMap(part=>part.types))]:[],values:unique(parts.flatMap(part=>part.values)),complete:parts.length>0&&parts.every(part=>part.complete),required:parts.length>0&&parts.every(part=>part.required),hints:unique(parts.flatMap(part=>part.hints))};
}
function localRef(root:Schema,ref:unknown):unknown {
  if(typeof ref!=='string'||!ref.startsWith('#/')||!validPolicyPointer(ref.slice(1)))return undefined;
  let selected:unknown=root;
  for(const token of ref.slice(2).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~')))selected=object(selected)&&own(selected,token)?selected[token]:undefined;
  return selected;
}
function ownValue(schema:Schema):Analysis {
  const types=typeof schema.type==='string'?[schema.type]:Array.isArray(schema.type)?schema.type.filter((type):type is string=>typeof type==='string'):[];
  let result:Analysis={types,values:[],complete:false,required:true,hints:[]};
  if(types.length&&types.every(type=>type==='boolean'||type==='null'))result={...result,values:[...(types.includes('boolean')?[false,true]:[]),...(types.includes('null')?[null]:[])],complete:true};
  for(const name of ['enum','const'] as const)if(own(schema,name)){
    const raw=name==='const'?[schema.const]:Array.isArray(schema.enum)?schema.enum:[];
    const values=unique(raw.filter(validPolicySwitchValue).filter(value=>matchesType(value,types)));
    const finite:Analysis={types:types.length?types:[...new Set(raw.map(value=>value===null?'null':Array.isArray(value)?'array':typeof value))],values,complete:raw.length>0&&raw.every(validPolicySwitchValue),required:true,hints:[]};
    result=intersect(result,finite);
  }
  const hints=[...(Array.isArray(schema.examples)?schema.examples:[]),...(own(schema,'default')?[schema.default]:[])].filter(validPolicySwitchValue).filter(value=>matchesType(value,types));
  return {...result,hints:unique(hints)};
}

/** Finite upper bounds only. Unknown branches never become an exhaustive list. */
function analyse(root:Schema,node:unknown,tokens:string[],depth:number,refs:Set<string>,budget:{remaining:number}):Analysis {
  if(--budget.remaining<0||!object(node)||depth>24)return unknown();
  let result:Analysis;
  if(!tokens.length)result=ownValue(node);
  else {
    const [token,...rest]=tokens,properties=node.properties;
    if(object(properties)&&own(properties,token)){
      result=analyse(root,properties[token],rest,depth+1,refs,budget);
      const types=typeof node.type==='string'?[node.type]:Array.isArray(node.type)?node.type:[];
      result={...result,required:types.length===1&&types[0]==='object'&&Array.isArray(node.required)&&node.required.includes(token)&&result.required};
    }else if(/^(0|[1-9]\d{0,4})$/.test(token)&&(object(node.items)||Array.isArray(node.prefixItems)&&Number(token)<node.prefixItems.length)){
      const child=Array.isArray(node.prefixItems)&&Number(token)<node.prefixItems.length?node.prefixItems[Number(token)]:node.items;
      result={...analyse(root,child,rest,depth+1,refs,budget),required:false};
    }else result=unknown();
  }
  if(own(node,'$ref')){
    const ref=typeof node.$ref==='string'?node.$ref:'';
    if(refs.has(ref)||refs.size>=32)return {...result,complete:false,required:false};
    const target=localRef(root,ref);
    if(!object(target))return {...result,complete:false,required:false};
    result=intersect(result,analyse(root,target,tokens,depth+1,new Set([...refs,ref]),budget));
  }
  if(Array.isArray(node.allOf))for(const part of node.allOf.slice(0,64))result=intersect(result,analyse(root,part,tokens,depth+1,refs,budget));
  for(const operator of ['anyOf','oneOf'])if(Array.isArray(node[operator]))result=intersect(result,union(node[operator].slice(0,64).map(part=>analyse(root,part,tokens,depth+1,refs,budget))));
  // Conditions can make availability depend on another field. Keep useful value
  // candidates, but never hide the default route on that basis.
  if(['if','then','else','dependentSchemas','patternProperties'].some(name=>own(node,name)))result={...result,complete:false,required:false};
  return result;
}
function outputAt(output:unknown,tokens:string[]):unknown {
  let selected=output;
  for(const token of tokens){if(object(selected)&&own(selected,token))selected=selected[token];else if(Array.isArray(selected)&&/^(0|[1-9]\d{0,4})$/.test(token)&&Number(token)<selected.length)selected=selected[Number(token)];else return undefined;}
  return selected;
}
export function policyFieldInfo(schema:Schema,path:string,examples:{expectedOutput?:unknown}[]=[]):PolicyFieldInfo {
  if(!validPolicyPointer(path))return {path,types:[],values:[],source:'none',complete:false,required:false};
  const tokens=path===''?[]:path.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'));
  const budget={remaining:2048},info=analyse(schema,schema,tokens,0,new Set(),budget);
  const samples=unique([...info.hints,...examples.slice(0,30).map(example=>outputAt(example.expectedOutput,tokens)).filter(validPolicySwitchValue)]).filter(value=>matchesType(value,info.types));
  const values=info.values.length?info.values:samples;
  return {path,types:info.types,values,source:info.values.length?'schema':samples.length?'examples':'none',complete:budget.remaining>=0&&info.complete,required:budget.remaining>=0&&info.required};
}
function fieldMetadata(schema:Schema):Map<string,{title?:string;description?:string}> {
  const result=new Map<string,{title?:string;description?:string}>();let remaining=2048;
  const walk=(node:unknown,path:string,depth:number,refs:Set<string>)=>{
    if(--remaining<0||!object(node)||depth>12||result.size>=256)return;
    result.set(path,{...(result.get(path)??{}),...(typeof node.title==='string'?{title:node.title.slice(0,160)}:{}),...(typeof node.description==='string'?{description:node.description.slice(0,500)}:{})});
    if(typeof node.$ref==='string'&&!refs.has(node.$ref))walk(localRef(schema,node.$ref),path,depth+1,new Set([...refs,node.$ref]));
    if(object(node.properties))for(const [key,part]of Object.entries(node.properties))walk(part,`${path}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`,depth+1,refs);
    if(node.items)walk(node.items,`${path}/0`,depth+1,refs);
    for(const name of ['allOf','anyOf','oneOf'])if(Array.isArray(node[name]))for(const part of node[name])walk(part,path,depth+1,refs);
  };
  walk(schema,'',0,new Set());return result;
}
export function policyFieldOptions(schema:Schema):PolicyFieldOption[] {
  const metadata=fieldMetadata(schema);
  return policySchemaPaths(schema).map(({path})=>{const info=policyFieldInfo(schema,path);return {path,types:info.types,required:info.required,...metadata.get(path)};});
}
export function policyFieldOperators(schema:Schema,path:string):PolicyPredicate['operator'][] {
  const types=policyFieldInfo(schema,path).types;
  return (['eq','ne','gt','gte','lt','lte','contains','in','exists'] as const).filter(operator=>!types.length||['eq','ne','in','exists'].includes(operator)||['gt','gte','lt','lte'].includes(operator)&&types.some(type=>type==='number'||type==='integer')||operator==='contains'&&types.some(type=>type==='string'||type==='array'));
}
export type PolicySwitchDiff={kept:number;added:number;removed:number;removedConnections:number};
export function policySwitchDiff(graph:PolicyGraph,nodeId:string,values:PolicySwitchValue[]):PolicySwitchDiff {
  const node=graph.nodes.find(node=>node.id===nodeId);
  if(node?.kind!=='switch')return {kept:0,added:0,removed:0,removedConnections:0};
  const removed=node.cases.filter(item=>!values.some(value=>key(value)===key(item.value)));
  const kept=node.cases.length-removed.length;
  return {kept,added:values.length-kept,removed:removed.length,removedConnections:graph.edges.filter(edge=>edge.from===nodeId&&removed.some(item=>item.id===edge.port)).length};
}
/** Stable IDs keep existing wires attached to exactly the same typed value. */
export function applyPolicySwitchValues(graph:PolicyGraph,nodeId:string,values:PolicySwitchValue[],path?:string):PolicyGraph {
  if(values.length<1||values.length>12||values.some(value=>!validPolicySwitchValue(value))||unique(values).length!==values.length||path!==undefined&&!validPolicyPointer(path))throw new Error('Switch 비교값을 중복 없이 1~12개 선택하세요.');
  const next=structuredClone(graph),node=next.nodes.find(node=>node.id===nodeId);
  if(node?.kind!=='switch')throw new Error('Switch 분기 노드를 선택하세요.');
  const used=new Set(node.cases.map(item=>item.id));let number=1;
  const cases=values.map(value=>{const previous=node.cases.find(item=>key(item.value)===key(value));if(previous)return previous;while(used.has(`case-${number}`))number++;const id=`case-${number++}`;used.add(id);return {id,value};});
  node.cases=cases;if(path!==undefined)node.path=path;
  next.edges=next.edges.filter(edge=>edge.from!==nodeId||edge.port==='default'||cases.some(item=>item.id===edge.port));
  return next;
}
export function policySwitchCoversField(schema:Schema,node:Extract<PolicyGraphNode,{kind:'switch'}>):boolean {
  const info=policyFieldInfo(schema,node.path);
  return info.complete&&info.required&&info.values.length>0&&info.values.every(value=>node.cases.some(item=>key(item.value)===key(value)));
}
