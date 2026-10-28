#!/usr/bin/env node
/** Test fixtures from the retained TypeScript reference; never used at runtime. */
import {writeFile} from 'node:fs/promises';
import {initialState} from '../lib/aegis-seed.ts';
import {executeWorkflow} from '../lib/aegis-engine.ts';
const state=initialState(),cases=[];
const base=()=>({id:'parity',name:'동작 비교',description:'',alias:'parity-model',mainConnectionId:'conn-main',updatedAt:'',pre:[],post:[]});
const rule=(id,kind,config,enabled=true)=>({id,name:id,description:'',kind,config,enabled});
const group=(id,rules,mode='any')=>({id,name:id,mode,rules});
const add=(name,workflow,input,options={},responses)=>cases.push({name,workflow,connections:structuredClone(state.connections),ingress:state.ingress,messages:[{role:'user',content:input}],options,...(responses?{responses}:{})});
for(const row of state.datasets[0].rows)add(`seed-${row.id}`,state.workflows[0],row.input);
add('emoji-length',{...base(),pre:[group('length',[rule('len','length',{maxLength:2})])]},'😀😀');
add('required-any',{...base(),post:[group('required',[rule('r','required',{pattern:'안내,문의',matchMode:'any'})])]},'질문',{mockResponse:'문의하세요'});
add('required-all',{...base(),post:[group('required',[rule('r','required',{pattern:'안내,문의',matchMode:'all'})])]},'질문',{mockResponse:'문의하세요'});
add('json-missing',{...base(),post:[group('json',[rule('j','json',{requiredKeys:['answer'],jsonMode:'object'})])]},'질문',{mockResponse:'{"other":1}'});
add('json-allowed',{...base(),post:[group('json',[rule('j','json',{requiredKeys:['answer'],jsonMode:'object'})])]},'질문',{mockResponse:'{"answer":"ok"}'});
add('pii-email',{...base(),pre:[group('pii',[rule('p','pii',{piiTypes:['email','phone','resident']})])]},'a@example.com');
add('disabled-rule',{...base(),pre:[group('disabled',[rule('disabled','keyword',{pattern:'차단'},false)])]},'차단');
add('all-aggregation',{...base(),pre:[group('all',[rule('a','keyword',{pattern:'차단'}),rule('b','keyword',{pattern:'다른'})],'all')]},'차단');
for(const scope of ['conversation','user_messages','last_user']){
 const c={name:`scope-${scope}`,workflow:{...base(),inputScope:scope,pre:[group('scope',[rule('scope','keyword',{pattern:'비공개'})])]},connections:state.connections,ingress:state.ingress,messages:[{role:'system',content:'비공개 정책'},{role:'user',content:'안녕하세요'}],options:{}};cases.push(c);
}
const branch={...base(),pre:[group('a',[rule('a','keyword',{pattern:'차단'})]),group('b',[rule('b','keyword',{pattern:'보안'})])],graph:{version:1,pre:{nodes:[{id:'fork',name:'병렬',kind:'fork'},{id:'join',name:'합류',kind:'join'}],edges:[{id:'s-f',from:'start',to:'control:fork'},{id:'f-a',from:'control:fork',to:'group:a'},{id:'f-b',from:'control:fork',to:'group:b'},{id:'a-j',from:'group:a',to:'control:join'},{id:'b-j',from:'group:b',to:'control:join'},{id:'j-e',from:'control:join',to:'end'}]},post:{nodes:[],edges:[{id:'post',from:'start',to:'end'}]}}};
add('parallel-allow',branch,'배송 안내');add('parallel-block',branch,'차단');
const condition=structuredClone(branch);condition.graph.pre.nodes[0]={id:'fork',name:'조건',kind:'condition',condition:{operator:'contains',value:'차단'}};condition.graph.pre.edges.find(e=>e.id==='f-a').port='true';condition.graph.pre.edges.find(e=>e.id==='f-b').port='false';
add('conditional-true',condition,'차단');add('conditional-false',condition,'배송');
const response=(content)=>({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
const regen={...base(),responseRetry:{enabled:true,maxRetries:2},post:[group('out',[rule('keyword','keyword',{pattern:'금지'})])]};
add('retry-success',regen,'배송',{},[response('금지 답변'),response('정상 답변')]);
add('retry-exhausted',regen,'배송',{},[response('금지 답변'),response('금지 답변'),response('금지 답변')]);
const normalize=(r)=>({status:r.status,stage:r.stage,output:r.output,finishReason:r.finishReason??null,usage:r.usage??null,regenerationCount:r.regenerationCount??null,traces:r.traces.map(({ruleId,stage,status,attempt})=>({ruleId,stage,status,attempt:attempt??null})),flowTraces:r.flowTraces??null,attempts:r.attempts?.map(({number,status,stage})=>({number,status,stage}))??null});
for(const c of cases){
 const original=globalThis.fetch;let index=0;
 if(c.responses){c.connections[0]={...c.connections[0],mode:'vllm',baseUrl:'https://model.example/v1'};c.ingress={...c.ingress,allowedOrigins:['https://model.example']};globalThis.fetch=async()=>Response.json(c.responses[index++]);}
 try{c.expected=normalize(await executeWorkflow(c.workflow,c.connections,c.ingress,{},c.messages,c.options));}finally{globalThis.fetch=original;}
}
await writeFile(new URL('../backend/tests/typescript-parity.json',import.meta.url),JSON.stringify(cases,null,2)+'\n');
console.log(`${cases.length} TypeScript execution fixtures exported.`);
