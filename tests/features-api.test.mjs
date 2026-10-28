import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { handleConsole, handleCompletions, handleModels } from '../.local-runtime/server/api.mjs';

const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url))).filter(n=>/^\d+.*\.sql$/.test(n)).sort().map(n=>readFile(new URL('../drizzle/'+n,import.meta.url),'utf8')));
function fixture(overrides={}) {
  const sqlite=new DatabaseSync(':memory:');for(const migration of migrations)sqlite.exec(migration);
  class Statement {
    constructor(query,values=[]){this.query=query;this.values=values;}
    bind(...values){return new Statement(this.query,values);}
    async first(){return sqlite.prepare(this.query).get(...this.values)||null;}
    async all(){return {results:sqlite.prepare(this.query).all(...this.values)};}
    executeRun(){const r=sqlite.prepare(this.query).run(...this.values);return {meta:{changes:Number(r.changes)}};}
    async run(){return this.executeRun();}
  }
  const DB={prepare:q=>new Statement(q),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const values=[];for(const statement of statements)values.push(statement.executeRun());sqlite.exec('COMMIT');return values;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const env={DB,...overrides};
  const request=(payload,identity)=>new Request('https://console.example/api/console',{method:payload?'POST':'GET',headers:{...(payload?{'Content-Type':'application/json'}:{}),...(identity?{'oai-authenticated-user-id':identity}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
  const consoleCall=async(payload,identity)=>{const response=await handleConsole(request(payload,identity),env);return {status:response.status,data:await response.json()};};
  const action=async(name,payload={})=>{const result=await consoleCall({action:name,...payload});assert.equal(result.status,200,`${name}: ${JSON.stringify(result.data.error)}`);return result.data;};
  const completion=async(key,input='배송은 보통 얼마나 걸리나요?',model='support-assistant',options={})=>handleCompletions(new Request('https://console.example/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:input}],...options})}),env);
  const models=key=>handleModels(new Request('https://console.example/v1/models',{headers:{Authorization:`Bearer ${key}`}}),env);
  return {sqlite,env,consoleCall,action,completion,models,close:()=>sqlite.close()};
}
async function completeRun(f,run){let current=run;for(let i=0;current.status==='running'&&i<100;i++){current=(await f.action('step_evaluation',{runId:current.id})).run;}assert.equal(current.status,'completed');return current;}
function serialGraph(groups) {
  const endpoints=['start',...groups.map(group=>`group:${group.id}`),'end'];
  return {nodes:[],edges:endpoints.slice(0,-1).map((from,index)=>({id:`serial-${index}`,from,to:endpoints[index+1],port:'next'}))};
}
function branchingWorkflow(base) {
  const workflow={...structuredClone(base),pre:[
    {id:'graph-sensitive',name:'별도 내용 검사',mode:'any',required:false,rules:[{id:'graph-ban',name:'금지 내용 검사',description:'',kind:'keyword',enabled:true,config:{pattern:'SENSITIVE_MARKER'}}]},
    {id:'graph-general',name:'일반 요청 검사',mode:'any',required:false,rules:[{id:'graph-length',name:'길이 검사',description:'',kind:'length',enabled:true,config:{maxLength:4000}}]},
  ]};
  workflow.graph={version:1,pre:{nodes:[{id:'graph-route',name:'요청 분기',kind:'condition',condition:{operator:'contains',value:'route_a',caseSensitive:true}},{id:'graph-merge',name:'요청 합류',kind:'join'}],edges:[
    {id:'graph-entry',from:'start',to:'control:graph-route'},
    {id:'graph-true',from:'control:graph-route',to:'group:graph-sensitive',port:'true'},
    {id:'graph-false',from:'control:graph-route',to:'group:graph-general',port:'false'},
    {id:'graph-sensitive-join',from:'group:graph-sensitive',to:'control:graph-merge'},
    {id:'graph-general-join',from:'group:graph-general',to:'control:graph-merge'},
    {id:'graph-merge-end',from:'control:graph-merge',to:'end'},
  ]},post:serialGraph(workflow.post)};
  return workflow;
}
function diamondGraph(groups,stage) {
  const nodes=[];const edges=[];
  for(let index=0;index<6;index++){
    const condition=`${stage}-condition-${index}`;const join=`${stage}-join-${index}`;
    nodes.push({id:condition,name:'내용 분기',kind:'condition',condition:{operator:'contains',value:'조건'}},{id:join,name:'분기 합류',kind:'join'});
    if(index===0)edges.push({id:`${stage}-entry`,from:'start',to:`control:${condition}`});
    for(const [branch,offset] of [['true',0],['false',1]]){
      const group=`group:${groups[index*2+offset].id}`;
      edges.push({id:`${condition}-${branch}`,from:`control:${condition}`,to:group,port:branch},{id:`${join}-${branch}`,from:group,to:`control:${join}`});
    }
    edges.push({id:`${join}-next`,from:`control:${join}`,to:index===5?'end':`control:${stage}-condition-${index+1}`});
  }
  return {nodes,edges};
}

test('node positions persist without invalidating completed verification evidence',async()=>{
  const f=fixture();try{
    const state=(await f.consoleCall()).data.state;const workflow=structuredClone(state.workflows[0]);
    const run=await completeRun(f,(await f.action('start_evaluation',{workflowId:workflow.id,datasetId:state.datasets[0].id,target:'draft'})).run);
    workflow.layout={version:1,positions:{input:{x:0,y:0},main:{x:680,y:280},output:{x:40000,y:40000},[`group:${workflow.pre[0].id}`]:{x:32,y:64},[`rule:${workflow.pre[0].rules[0].id}`]:{x:64,y:128}}};
    await f.action('save_workflow',{workflow});
    const saved=(await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id);
    assert.deepEqual(saved.layout,workflow.layout);
    const deployment=(await f.action('publish',{workflowId:workflow.id,expectedFingerprint:run.fingerprint,verificationRunId:run.id})).deployment;
    assert.equal(deployment.fingerprint,run.fingerprint);assert.deepEqual(deployment.workflow.layout,workflow.layout);
    const checked=await f.action('playground',{workflowId:workflow.id,target:'draft',input:state.datasets[0].rows[0].input});
    assert.equal(checked.fingerprint,run.fingerprint);assert.equal(checked.result.status,run.results[0].status);
  }finally{f.close();}
});
test('invalid canvas coordinates and unknown nodes are rejected before saving',async()=>{
  const f=fixture();try{
    const workflow=(await f.consoleCall()).data.state.workflows[0];
    for(const layout of [
      {version:2,positions:{}},
      {version:1,positions:{main:{x:-1,y:0}}},
      {version:1,positions:{main:{x:0,y:40001}}},
      {version:1,positions:{main:{x:'10',y:0}}},
      {version:1,positions:{'rule:missing':{x:0,y:0}}},
      {version:1,positions:Object.fromEntries(Array.from({length:964},(_,index)=>[`rule:${index}`,{x:0,y:0}]))},
    ])assert.equal((await f.consoleCall({action:'save_workflow',workflow:{...workflow,layout}})).status,400);
    assert.equal((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).layout,undefined);
  }finally{f.close();}
});
test('canvas positions support all 339 valid nodes including every graph control',async()=>{
  const f=fixture();try{
    const workflow=structuredClone((await f.consoleCall()).data.state.workflows[0]);
    const positions={input:{x:0,y:0},main:{x:20000,y:20000},output:{x:40000,y:40000}};
    for(const stage of ['pre','post'])workflow[stage]=Array.from({length:12},(_,groupIndex)=>{
      const groupId=`${stage}-capacity-${groupIndex}`;positions[`group:${groupId}`]={x:groupIndex*100,y:100};
      return {id:groupId,name:'검사 단계',mode:'any',required:false,rules:Array.from({length:12},(_,ruleIndex)=>{
        const ruleId=`${groupId}-rule-${ruleIndex}`;positions[`rule:${ruleId}`]={x:groupIndex*100,y:200+ruleIndex*100};
        return {id:ruleId,name:'길이 검사',description:'',kind:'length',enabled:true,config:{maxLength:4000}};
      })};
    });
    workflow.graph={version:1,pre:diamondGraph(workflow.pre,'pre'),post:diamondGraph(workflow.post,'post')};
    for(const stage of ['pre','post'])for(const [index,node] of workflow.graph[stage].nodes.entries())positions[`control:${node.id}`]={x:index*100,y:2000};
    workflow.layout={version:1,positions};assert.equal(Object.keys(positions).length,339);
    await f.action('save_workflow',{workflow});
    assert.deepEqual((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).layout,workflow.layout);
    const oversized=await f.consoleCall({action:'save_workflow',workflow:{...workflow,layout:{version:1,positions:Object.fromEntries(Array.from({length:964},(_,index)=>[`rule:overflow-${index}`,{x:0,y:0}]))}}});
    assert.equal(oversized.status,400);assert.ok(oversized.data.error.message.includes('963'));
  }finally{f.close();}
});

function canvasZone(overrides={}){
  return {id:'zone-one',name:'보안 검사 영역',color:'blue',nodeKeys:['main'],x:0,y:0,width:240,height:160,...overrides};
}
test('canvas zones save and reload empty areas, visible nodes and all supported colors while positions retain legacy keys',async()=>{
  const f=fixture();try{
    const workflow=branchingWorkflow((await f.consoleCall()).data.state.workflows[0]);
    workflow.layout={version:1,positions:{[`group:${workflow.pre[0].id}`]:{x:0,y:0},[`rule:${workflow.post[0].rules[0].id}`]:{x:100,y:100}},zones:[]};
    await f.action('save_workflow',{workflow});
    assert.deepEqual((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).layout.zones,[]);
    const visible=['input','main','output',`rule:${workflow.pre[0].rules[0].id}`,`rule:${workflow.pre[1].rules[0].id}`,`group:${workflow.post[0].id}`,'control:graph-route','control:graph-merge'];
    workflow.layout.zones=['slate','blue','green','amber','violet'].map((color,index)=>canvasZone({id:`zone-${index}`,name:`영역 ${index}`,color,nodeKeys:index===0?visible:[],x:index===4?40000:index*100,y:index===4?40000:index*100,width:index===4?50000:240,height:index===4?50000:160}));
    await f.action('save_workflow',{workflow});
    assert.deepEqual((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).layout,workflow.layout);
    workflow.layout.zones=[canvasZone({id:' zone-trim ',name:' 영역 이름 ',nodeKeys:[]})];
    await f.action('save_workflow',{workflow});
    const saved=(await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).layout.zones[0];
    assert.equal(saved.id,'zone-trim');assert.equal(saved.name,'영역 이름');
  }finally{f.close();}
});

test('canvas zones reject hidden, unknown, cross-workflow, duplicate memberships and duplicate area IDs',async()=>{
  const f=fixture();try{
    const workflow=branchingWorkflow((await f.consoleCall()).data.state.workflows[0]);
    const other={...structuredClone(workflow),id:'zone-other-workflow',alias:'zone-other-model',name:'다른 워크플로우',pre:[{id:'other-zone-group',name:'다른 검사',mode:'any',rules:[{id:'other-zone-rule',name:'길이',description:'',kind:'length',enabled:true,config:{maxLength:1000}}]}]};
    delete other.graph;await f.action('save_workflow',{workflow:other});
    const candidates=[
      [canvasZone({nodeKeys:[`group:${workflow.pre[0].id}`]})],
      [canvasZone({nodeKeys:[`rule:${workflow.post[0].rules[0].id}`]})],
      [canvasZone({nodeKeys:['rule:missing']})],
      [canvasZone({nodeKeys:['rule:other-zone-rule']})],
      [canvasZone({nodeKeys:[`pre:rule:${workflow.pre[0].rules[0].id}`]})],
      [canvasZone({nodeKeys:['control:not-in-this-workflow']})],
      [canvasZone({nodeKeys:['main','main']})],
      [canvasZone(),canvasZone({id:'zone-two',nodeKeys:['main']})],
      [canvasZone({nodeKeys:[]}),canvasZone({nodeKeys:[]})],
      [canvasZone({id:'same',nodeKeys:[]}),canvasZone({id:' same ',nodeKeys:[]})],
    ];
    for(const zones of candidates){const rejected=await f.consoleCall({action:'save_workflow',workflow:{...workflow,layout:{version:1,positions:{},zones}}});assert.equal(rejected.status,400,JSON.stringify(zones));}
    assert.equal((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).layout,undefined);
  }finally{f.close();}
});

test('canvas zone bounds, names, colors and area counts are enforced without partial saves',async()=>{
  const f=fixture();try{
    const workflow=(await f.consoleCall()).data.state.workflows[0];
    const invalid=[
      {id:' '},{id:'a'.repeat(101)},{name:' \t '},{name:'a'.repeat(101)},{color:'red'},
      {x:-1},{x:40001},{y:-1},{y:40001},{width:239},{width:50001},{height:159},{height:50001},
      {x:'0'},{nodeKeys:'main'},{unexpected:'not-allowed'},
    ];
    for(const change of invalid){const rejected=await f.consoleCall({action:'save_workflow',workflow:{...workflow,layout:{version:1,positions:{},zones:[canvasZone(change)]}}});assert.equal(rejected.status,400,JSON.stringify(change));}
    const zones=Array.from({length:32},(_,index)=>canvasZone({id:`allowed-zone-${index}`,name:`영역 ${index}`,nodeKeys:[]}));
    await f.action('save_workflow',{workflow:{...workflow,layout:{version:1,positions:{},zones}}});
    assert.equal((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).layout.zones.length,32);
    const oversized=await f.consoleCall({action:'save_workflow',workflow:{...workflow,layout:{version:1,positions:{},zones:[...zones,canvasZone({id:'overflow-area',nodeKeys:[]})]}}});assert.equal(oversized.status,400);
    assert.equal((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).layout.zones.length,32);
  }finally{f.close();}
});

test('creating, editing and deleting visual zones preserves execution fingerprints, completed evidence and immutable deployment state',async()=>{
  const f=fixture();try{
    const state=(await f.consoleCall()).data.state;const workflow=structuredClone(state.workflows[0]);
    const run=await completeRun(f,(await f.action('start_evaluation',{workflowId:workflow.id,datasetId:state.datasets[0].id,target:'draft'})).run);
    const deployment=(await f.action('publish',{workflowId:workflow.id,expectedFingerprint:run.fingerprint,verificationRunId:run.id})).deployment;
    const publishedSnapshot=structuredClone(deployment.workflow);
    const input=state.datasets[0].rows[0].input;
    const baseline=await f.action('playground',{workflowId:workflow.id,target:'draft',input});
    const contiguousKeys=['input',...workflow.pre.map(group=>group.rules.length===1?`rule:${group.rules[0].id}`:`group:${group.id}`),'main',...workflow.post.map(group=>group.rules.length===1?`rule:${group.rules[0].id}`:`group:${group.id}`),'output'];
    for(const zones of [[canvasZone()],[canvasZone({name:'변경한 영역',color:'violet',nodeKeys:contiguousKeys,x:1500,y:700,width:900,height:600})],[]]){
      workflow.layout={version:1,positions:{main:{x:300,y:400}},zones};
      await f.action('save_workflow',{workflow});
      const checked=await f.action('playground',{workflowId:workflow.id,target:'draft',input});
      assert.equal(checked.fingerprint,run.fingerprint);
      assert.deepEqual([checked.result.status,checked.result.stage,checked.result.output],[baseline.result.status,baseline.result.stage,baseline.result.output]);
      const current=(await f.consoleCall()).data.state;
      assert.equal(current.runs.find(item=>item.id===run.id).status,'completed');
      assert.equal(current.runs.find(item=>item.id===run.id).fingerprint,run.fingerprint);
      assert.equal(current.deployments.filter(item=>item.workflowId===workflow.id).length,1);
      const savedDeployment=current.deployments.find(item=>item.id===deployment.id);
      assert.equal(savedDeployment.fingerprint,run.fingerprint);assert.deepEqual(savedDeployment.workflow,publishedSnapshot);
      assert.deepEqual(current.workflows.find(item=>item.id===workflow.id).layout.zones,zones);
    }
  }finally{f.close();}
});

test('visual zone editing is forbidden to viewers and available to editors',async()=>{
  const f=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'true',AEGIS_ROLE_MAP:JSON.stringify({'zone-viewer':'viewer','zone-editor':'editor'})});try{
    const workflow=(await f.consoleCall(undefined,'zone-viewer')).data.state.workflows[0];
    workflow.layout={version:1,positions:{},zones:[canvasZone()]};
    assert.equal((await f.consoleCall({action:'save_workflow',workflow},'zone-viewer')).status,403);
    assert.equal((await f.consoleCall({action:'save_workflow',workflow},'zone-editor')).status,200);
    assert.deepEqual((await f.consoleCall(undefined,'zone-viewer')).data.state.workflows.find(item=>item.id===workflow.id).layout.zones,workflow.layout.zones);
  }finally{f.close();}
});

test('workflows support 36 serial groups per stage and reject a 37th group',async()=>{
  const f=fixture();try{
    const workflow=structuredClone((await f.consoleCall()).data.state.workflows[0]);
    for(const stage of ['pre','post'])workflow[stage]=Array.from({length:36},(_,index)=>({id:`zone-capacity-${stage}-${index}`,name:'직렬 검사',mode:'any',rules:[{id:`zone-capacity-${stage}-${index}-rule`,name:'길이 검사',description:'',kind:'length',enabled:true,config:{maxLength:4000}}]}));
    workflow.graph={version:1,pre:serialGraph(workflow.pre),post:serialGraph(workflow.post)};
    await f.action('save_workflow',{workflow});
    const saved=(await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id);
    assert.equal(saved.pre.length,36);assert.equal(saved.post.length,36);
    for(const stage of ['pre','post']){
      const invalid=structuredClone(workflow);invalid[stage].push({id:`overflow-${stage}`,name:'추가 검사',mode:'any',rules:[]});invalid.graph[stage]=serialGraph(invalid[stage]);
      assert.equal((await f.consoleCall({action:'save_workflow',workflow:invalid})).status,400);
    }
  }finally{f.close();}
});

test('canvas positions retain all 963 valid legacy and graph node keys at maximum group capacity',async()=>{
  const f=fixture();try{
    const workflow=structuredClone((await f.consoleCall()).data.state.workflows[0]);
    const positions={input:{x:0,y:0},main:{x:20000,y:20000},output:{x:40000,y:40000}};
    for(const stage of ['pre','post'])workflow[stage]=Array.from({length:36},(_,groupIndex)=>{
      const groupId=`full-${stage}-${groupIndex}`;positions[`group:${groupId}`]={x:groupIndex*100,y:100};
      return{id:groupId,name:'검사 단계',mode:'any',required:false,rules:Array.from({length:12},(_,ruleIndex)=>{
        const ruleId=`${groupId}-rule-${ruleIndex}`;positions[`rule:${ruleId}`]={x:groupIndex*100,y:200+ruleIndex*100};
        return{id:ruleId,name:'길이 검사',description:'',kind:'length',enabled:true,config:{maxLength:4000}};
      })};
    });
    const capacityGraph=(groups,stage)=>{
      const graph=diamondGraph(groups.slice(0,12),stage);
      graph.edges.find(item=>item.to==='end').to=`group:${groups[12].id}`;
      for(let index=12;index<groups.length;index++)graph.edges.push({id:`${stage}-tail-${index}`,from:`group:${groups[index].id}`,to:index===groups.length-1?'end':`group:${groups[index+1].id}`});
      return graph;
    };
    workflow.graph={version:1,pre:capacityGraph(workflow.pre,'pre'),post:capacityGraph(workflow.post,'post')};
    for(const stage of ['pre','post'])for(const[index,node]of workflow.graph[stage].nodes.entries())positions[`control:${node.id}`]={x:index*100,y:2000};
    workflow.layout={version:1,positions,zones:[]};assert.equal(Object.keys(positions).length,963);
    await f.action('save_workflow',{workflow});
    assert.deepEqual((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).layout,workflow.layout);
  }finally{f.close();}
});

test('graph branches and optional groups persist into immutable evaluation and deployment snapshots',async()=>{
  const f=fixture();try{
    const state=(await f.consoleCall()).data.state;const workflow=branchingWorkflow(state.workflows[0]);
    workflow.layout={version:1,positions:{'control:graph-route':{x:400,y:200}}};
    await f.action('save_workflow',{workflow});
    const saved=(await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id);
    assert.deepEqual(saved.graph,workflow.graph);assert.equal(saved.pre[0].required,false);assert.deepEqual(saved.layout,workflow.layout);
    const dataset={id:'graph-dataset',name:'분기 검증',description:'',rows:[{id:'graph-case',input:'일반 배송 문의',expected:'allow'}]};
    await f.action('save_dataset',{dataset});
    const run=await completeRun(f,(await f.action('start_evaluation',{workflowId:workflow.id,datasetId:dataset.id,target:'draft'})).run);
    assert.deepEqual(run.workflowSnapshot.graph,workflow.graph);assert.equal(run.results[0].status,'allow');
    assert.ok(run.results[0].flowTraces.some(trace=>trace.nodeId==='control:graph-route'&&trace.edgeIds.includes('graph-false')));
    const deployment=(await f.action('publish',{workflowId:workflow.id,expectedFingerprint:run.fingerprint,verificationRunId:run.id})).deployment;
    assert.deepEqual(deployment.workflow.graph,workflow.graph);assert.equal(deployment.workflow.pre[0].required,false);
    const changed=structuredClone(workflow);changed.graph.pre.nodes[0].condition.value='일반';await f.action('save_workflow',{workflow:changed});
    assert.deepEqual((await f.consoleCall()).data.state.deployments.find(item=>item.id===deployment.id).workflow.graph,workflow.graph);
    const stale=await f.consoleCall({action:'publish',workflowId:workflow.id,expectedFingerprint:run.fingerprint,verificationRunId:run.id});assert.equal(stale.status,409);
    const {key}=await f.action('create_key',{name:'분기 추적'});
    const response=await f.completion(key,'route_a SENSITIVE_MARKER');assert.equal(response.status,403);
    const log=(await f.consoleCall()).data.state.logs.find(item=>item.id===response.headers.get('X-Aegis-Request-Id'));
    assert.ok(log.flowTraces.some(trace=>trace.nodeId==='control:graph-route'&&trace.edgeIds.includes('graph-true')));
    assert.ok(!JSON.stringify(log).includes('SENSITIVE_MARKER'));assert.ok(log.flowTraces.every(trace=>Object.keys(trace).every(key=>['nodeId','stage','status','edgeIds','attempt'].includes(key))));
  }finally{f.close();}
});

test('graph saves reject malformed endpoints, cycles, stage crossings and executable fields',async()=>{
  const f=fixture();try{
    const workflow=branchingWorkflow((await f.consoleCall()).data.state.workflows[0]);
    const mutations=[
      candidate=>{candidate.graph.version=2;},
      candidate=>{candidate.graph.pre.nodes[0].kind='script';},
      candidate=>{candidate.graph.pre.nodes[0].condition.operator='eval';},
      candidate=>{candidate.graph.pre.nodes[0].condition.code='globalThis.__graphExecuted=true';},
      candidate=>{candidate.graph.pre.nodes[0].condition.value='x'.repeat(2001);},
      candidate=>{delete candidate.graph.pre.nodes[0].condition;},
      candidate=>{candidate.graph.pre.edges[0].to='https://example.com/execute';},
      candidate=>{candidate.graph.pre.edges[0].to=`group:${candidate.post[0].id}`;},
      candidate=>{candidate.graph.pre.edges[1].to='control:graph-route';},
      candidate=>{candidate.graph.pre.edges[1].port='expression';},
      candidate=>{candidate.graph.pre.edges[2].port='true';},
      candidate=>{candidate.graph.pre.edges.push({...candidate.graph.pre.edges[0]});},
      candidate=>{candidate.graph.pre.nodes.push({...candidate.graph.pre.nodes[0]});},
      candidate=>{candidate.graph.post.nodes.push({...candidate.graph.pre.nodes[0]});},
      candidate=>{candidate.pre[0].required=true;},
      candidate=>{candidate.graph.pre.nodes=Array.from({length:13},(_,index)=>({...candidate.graph.pre.nodes[0],id:`overflow-${index}`}));},
      candidate=>{candidate.graph.pre.edges=Array.from({length:65},(_,index)=>({...candidate.graph.pre.edges[0],id:`overflow-${index}`}));},
    ];
    for(const mutate of mutations){const candidate=structuredClone(workflow);mutate(candidate);const response=await f.consoleCall({action:'save_workflow',workflow:candidate});assert.equal(response.status,400,`accepted malformed graph: ${JSON.stringify(candidate.graph)}`);}
    assert.equal((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).graph,undefined);
    const literal=structuredClone(workflow);literal.graph.pre.nodes[0].condition.value='globalThis.__graphExecuted=true';
    await f.action('save_workflow',{workflow:literal});
    const checked=await f.action('playground',{workflowId:workflow.id,target:'draft',input:'일반 문의'});assert.equal(checked.result.status,'allow');assert.equal(globalThis.__graphExecuted,undefined);
    const badPosition=await f.consoleCall({action:'save_workflow',workflow:{...literal,layout:{version:1,positions:{'control:not-in-this-workflow':{x:1,y:2}}}}});assert.equal(badPosition.status,400);
  }finally{f.close();}
});

test('graph draft validation permits incomplete rule settings while publish still rejects them',async()=>{
  const f=fixture();try{
    const workflow=branchingWorkflow((await f.consoleCall()).data.state.workflows[0]);
    workflow.pre[0].rules[0]={...workflow.pre[0].rules[0],kind:'regex',config:{pattern:''}};
    await f.action('save_workflow',{workflow});
    const published=await f.consoleCall({action:'publish',workflowId:workflow.id});assert.equal(published.status,400);
    const checked=await f.consoleCall({action:'playground',workflowId:workflow.id,input:'일반 문의',target:'draft'});assert.equal(checked.status,400);
    assert.deepEqual((await f.consoleCall()).data.state.workflows.find(item=>item.id===workflow.id).graph,workflow.graph);
  }finally{f.close();}
});

test('graph editing follows viewer, editor and administrator roles',async()=>{
  const f=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'true',AEGIS_ROLE_MAP:JSON.stringify({'graph-viewer':'viewer','graph-editor':'editor','graph-admin':'admin'})});try{
    const workflow=branchingWorkflow((await f.consoleCall(undefined,'graph-viewer')).data.state.workflows[0]);
    assert.equal((await f.consoleCall({action:'save_workflow',workflow},'graph-viewer')).status,403);
    assert.equal((await f.consoleCall({action:'save_workflow',workflow},'graph-editor')).status,200);
    assert.equal((await f.consoleCall({action:'publish',workflowId:workflow.id},'graph-editor')).status,403);
    const published=await f.consoleCall({action:'publish',workflowId:workflow.id},'graph-admin');assert.equal(published.status,200);assert.deepEqual(published.data.deployment.workflow.graph,workflow.graph);
  }finally{f.close();}
});

test('comparison API captures immutable evidence and identifies changed decisions',async()=>{
  const f=fixture();try{
    const initial=(await f.consoleCall()).data.state;const workflow=structuredClone(initial.workflows[0]);
    await f.action('publish',{workflowId:workflow.id});
    workflow.pre[1].rules[0].config.pattern='배송';await f.action('save_workflow',{workflow});
    let run=(await f.action('start_evaluation',{workflowId:workflow.id,datasetId:initial.datasets[0].id,target:'draft',compare:true})).run;
    assert.equal(run.status,'running');assert.equal(run.results.length,0);assert.ok(run.fingerprint);assert.ok(run.datasetFingerprint);assert.ok(run.workflowSnapshot);
    run=await completeRun(f,run);assert.equal(run.results.length,initial.datasets[0].rows.length);assert.equal(run.baselineResults.length,run.results.length);
    assert.equal(run.results[0].status,'block');assert.equal(run.baselineResults[0].status,'allow');
    workflow.pre[1].rules[0].config.pattern='무관한 문구';await f.action('save_workflow',{workflow});
    const replay=(await f.action('replay_evaluation',{runId:run.id})).run;
    assert.notEqual(replay.id,run.id);assert.equal(replay.fingerprint,run.fingerprint);
    assert.equal((await completeRun(f,replay)).results[0].status,'block');
  }finally{f.close();}
});
test('cancellation is durable and cannot be resumed accidentally',async()=>{
  const f=fixture();try{const state=(await f.consoleCall()).data.state;
    const run=(await f.action('start_evaluation',{workflowId:state.workflows[0].id,datasetId:state.datasets[0].id,target:'draft'})).run;
    const partial=(await f.action('step_evaluation',{runId:run.id})).run;assert.ok(partial.results.length>0&&partial.results.length<partial.total);
    const cancelled=(await f.action('cancel_evaluation',{runId:run.id})).run;assert.equal(cancelled.status,'cancelled');
    const later=await f.consoleCall({action:'step_evaluation',runId:run.id});
    if(later.status===200){assert.equal(later.data.run.status,'cancelled');assert.equal(later.data.run.results.length,partial.results.length);}else assert.ok([400,409].includes(later.status));
  }finally{f.close();}
});
test('release evidence rejects stale configuration and rollback preserves the draft',async()=>{
  const f=fixture();try{const state=(await f.consoleCall()).data.state;const workflow=structuredClone(state.workflows[0]);
    let run=(await f.action('start_evaluation',{workflowId:workflow.id,datasetId:state.datasets[0].id,target:'draft'})).run;run=await completeRun(f,run);
    const first=(await f.action('publish',{workflowId:workflow.id,expectedFingerprint:run.fingerprint,verificationRunId:run.id,note:'검증 후 첫 배포'})).deployment;
    workflow.pre[1].rules[0].config.pattern='배송';await f.action('save_workflow',{workflow});
    const rejected=await f.consoleCall({action:'publish',workflowId:workflow.id,expectedFingerprint:run.fingerprint,verificationRunId:run.id});assert.ok([400,409].includes(rejected.status));
    const second=(await f.action('publish',{workflowId:workflow.id,note:'배송 차단 테스트'})).deployment;
    const rolled=(await f.action('rollback_deployment',{deploymentId:first.id,note:'원래 정책 복구'})).deployment;
    assert.ok(rolled.version>second.version);assert.equal(rolled.rollbackOf,first.id);assert.deepEqual(rolled.workflow,first.workflow);
    const latest=(await f.consoleCall()).data.state;assert.equal(latest.workflows.find(w=>w.id===workflow.id).pre[1].rules[0].config.pattern,'배송');
    assert.ok(latest.audit.some(event=>event.action==='rollback_deployment'));
  }finally{f.close();}
});
test('key scopes filter model discovery and deny unauthorized or empty scopes',async()=>{
  const f=fixture();try{const state=(await f.consoleCall()).data.state;const workflow=state.workflows[0];await f.action('publish',{workflowId:workflow.id});
    const other={...structuredClone(workflow),id:'wf-other',alias:'other-model',name:'다른 서비스'};await f.action('save_workflow',{workflow:other});await f.action('publish',{workflowId:other.id});
    const issued=await f.action('create_key',{name:'한정 키',policy:{allowedModels:[workflow.alias]}});const key=issued.key;
    assert.deepEqual((await (await f.models(key)).json()).data.map(m=>m.id),[workflow.alias]);
    assert.equal((await f.completion(key,'배송',other.alias)).status,403);
    assert.equal((await f.completion(key)).status,200);
    const summary=issued.state.keys.find(k=>k.prefix===key.slice(0,11));await f.action('update_key_policy',{id:summary.id,policy:{allowedModels:[]}});
    assert.equal((await f.completion(key)).status,403);assert.equal((await (await f.models(key)).json()).data.length,0);
  }finally{f.close();}
});
test('persistent request and token limits reserve capacity before model execution',async()=>{
  const f=fixture();try{const state=(await f.consoleCall()).data.state;await f.action('publish',{workflowId:state.workflows[0].id});
    const {key}=await f.action('create_key',{name:'요청 한도',policy:{rpmLimit:1}});
    const responses=await Promise.all([f.completion(key),f.completion(key)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,429]);
    const limited=await f.action('create_key',{name:'토큰 한도',policy:{tpmLimit:1}});assert.equal((await f.completion(limited.key)).status,429);
    const final=(await f.consoleCall()).data.state.keys.find(k=>k.prefix===key.slice(0,11));assert.equal(final.usage.active,0);assert.equal(final.usage.requests,1);
  }finally{f.close();}
});
test('external request IDs locate stored traces without retaining rejected output',async()=>{
  const f=fixture();try{const state=(await f.consoleCall()).data.state;await f.action('publish',{workflowId:state.workflows[0].id});const {key}=await f.action('create_key',{name:'추적 검증'});
    const response=await f.completion(key,'담당자 연락처 예시를 보여주세요.');assert.equal(response.status,403);
    const requestId=response.headers.get('X-Aegis-Request-Id');const log=(await f.consoleCall()).data.state.logs.find(l=>l.id===requestId);
    assert.ok(log);assert.ok(log.traces.length);assert.ok(log.keyId);assert.ok(!JSON.stringify(log).includes('support@example.com'));
  }finally{f.close();}
});
test('configured viewer and editor permissions are enforced server side',async()=>{
  const f=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'true',AEGIS_ROLE_MAP:JSON.stringify({'viewer-id':'viewer','editor-id':'editor','owner-id':'admin'})});try{
    const viewer=await f.consoleCall(undefined,'viewer-id');assert.equal(viewer.status,200);assert.equal(viewer.data.state.role,'viewer');
    assert.equal((await f.consoleCall({action:'save_ingress',ingress:viewer.data.state.ingress},'viewer-id')).status,403);
    assert.equal((await f.consoleCall({action:'create_key',name:'forbidden'},'editor-id')).status,403);
    const dataset={...viewer.data.state.datasets[0],name:'편집 가능'};
    assert.equal((await f.consoleCall({action:'save_dataset',dataset},'editor-id')).status,200);
    assert.equal((await f.consoleCall({action:'save_dataset',dataset},'viewer-id')).status,403);
  }finally{f.close();}
});
test('retention removes old request records while preserving current deployment evidence',async()=>{
  const f=fixture();try{const state=(await f.consoleCall()).data.state;const deployment=(await f.action('publish',{workflowId:state.workflows[0].id})).deployment;
    const old={id:'expired',createdAt:'2000-01-01T00:00:00.000Z',source:'gateway',workflowName:'old',version:'v1',status:'allow',stage:'complete',latencyMs:1,reason:'old'};
    f.sqlite.prepare('INSERT INTO aegis_request_logs(id,payload,created_at) VALUES (?,?,?)').run(old.id,JSON.stringify(old),old.createdAt);
    const saved=await f.action('save_retention',{retention:{logDays:1,evaluationDays:1,auditDays:7}});
    assert.equal(saved.state.logs.some(l=>l.id==='expired'),false);assert.ok(saved.state.deployments.some(d=>d.id===deployment.id));
  }finally{f.close();}
});

test('concurrent administrators cannot exceed the durable four-job capacity',async()=>{
  const f=fixture();try{const state=(await f.consoleCall()).data.state;
    const responses=await Promise.all(Array.from({length:12},()=>f.consoleCall({action:'start_evaluation',workflowId:state.workflows[0].id,datasetId:state.datasets[0].id,target:'draft'})));
    assert.equal(responses.filter(r=>r.status===200).length,4);assert.equal(responses.filter(r=>r.status===409).length,8);
    const running=(await f.consoleCall()).data.state.runs.filter(r=>r.status==='running');assert.equal(running.length,4);
    await f.action('cancel_evaluation',{runId:running[0].id});assert.equal((await f.consoleCall({action:'start_evaluation',workflowId:state.workflows[0].id,datasetId:state.datasets[0].id,target:'draft'})).status,200);
  }finally{f.close();}
});
test('partially retried results cannot serve as full dataset release evidence',async()=>{
  const f=fixture();try{const state=(await f.consoleCall()).data.state;
    const full=await completeRun(f,(await f.action('start_evaluation',{workflowId:state.workflows[0].id,datasetId:state.datasets[0].id,target:'draft'})).run);
    const partial={...full,id:'partial-retry',retryOf:full.id,total:2,results:full.results.slice(0,2)};
    f.sqlite.prepare("INSERT INTO aegis_records(namespace,id,payload,updated_at) VALUES ('run',?,?,?)").run(partial.id,JSON.stringify(partial),new Date().toISOString());
    const response=await f.consoleCall({action:'publish',workflowId:state.workflows[0].id,expectedFingerprint:full.fingerprint,verificationRunId:partial.id});
    assert.equal(response.status,400);assert.equal(response.data.error.code,'verification_failed');
  }finally{f.close();}
});
test('key expiry is checked on every request and cannot survive cached authorization',async()=>{
  const f=fixture();try{const state=(await f.consoleCall()).data.state;await f.action('publish',{workflowId:state.workflows[0].id});
    const issued=await f.action('create_key',{name:'만료 검증',policy:{expiresAt:new Date(Date.now()+60_000).toISOString()}});const summary=issued.state.keys.find(k=>k.prefix===issued.key.slice(0,11));
    assert.equal((await f.completion(issued.key)).status,200);
    f.sqlite.prepare("UPDATE aegis_records SET payload=? WHERE namespace='key_policy' AND id=?").run(JSON.stringify({expiresAt:'2000-01-01T00:00:00.000Z'}),summary.id);
    assert.equal((await f.completion(issued.key)).status,401);assert.equal((await f.models(issued.key)).status,401);
  }finally{f.close();}
});
test('concurrent execution leases are enforced and released after the upstream finishes',async()=>{
  const f=fixture();const originalFetch=globalThis.fetch;let release;let reached;
  const gate=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{reached=resolve;});
  try{const state=(await f.consoleCall()).data.state;const connection={...state.connections.find(c=>c.id===state.workflows[0].mainConnectionId),mode:'vllm',baseUrl:'https://model.example/v1'};
    await f.action('save_connection',{connection});await f.action('save_ingress',{ingress:{enabled:false,allowedCidrs:[],allowedOrigins:['https://model.example']}});
    const workflow={...state.workflows[0],pre:[],post:[]};await f.action('save_workflow',{workflow});await f.action('publish',{workflowId:workflow.id});
    const {key}=await f.action('create_key',{name:'동시 실행',policy:{maxConcurrent:1}});
    globalThis.fetch=async()=>{reached();await gate;return Response.json({choices:[{message:{content:'안내 응답'}}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}});};
    const first=f.completion(key);await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream not reached')),3000))]);
    const other=await f.completion(key);assert.equal(other.status,429);assert.equal((await other.json()).error.code,'concurrency_limit');
    release();assert.equal((await first).status,200);
    const latest=(await f.consoleCall()).data.state.keys.find(k=>k.prefix===key.slice(0,11));assert.equal(latest.usage.active,0);
    assert.equal((await f.completion(key)).status,200);
  }finally{release?.();globalThis.fetch=originalFetch;f.close();}
});
test('changed model settings invalidate earlier checks and stale in-flight diagnostics',async()=>{
  const f=fixture();const originalFetch=globalThis.fetch;let release;let reached;
  try{const state=(await f.consoleCall()).data.state;const sample=state.connections.find(c=>c.id===state.workflows[0].mainConnectionId);
    await f.action('diagnose_connection',{id:sample.id});await f.action('collect_connection_metrics',{id:sample.id});
    let latest=(await f.consoleCall()).data.state;assert.ok(latest.diagnostics[sample.id]);assert.ok(latest.modelMetrics[sample.id]);
    const connection={...sample,mode:'vllm',baseUrl:'https://model.example/v1'};await f.action('save_connection',{connection});
    latest=(await f.consoleCall()).data.state;assert.equal(latest.diagnostics[sample.id],undefined);assert.equal(latest.modelMetrics[sample.id],undefined);
    await f.action('save_ingress',{ingress:{enabled:false,allowedCidrs:[],allowedOrigins:['https://model.example']}});
    const gate=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{reached=resolve;});
    globalThis.fetch=async(url)=>{if(String(url).endsWith('/models')){reached();await gate;return Response.json({data:[{id:sample.model}]});}return Response.json({choices:[{message:{content:'진단 응답'}}]});};
    const diagnostic=f.consoleCall({action:'diagnose_connection',id:sample.id});await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(new Error('diagnostic not reached')),3000))]);
    await f.action('save_connection',{connection:{...connection,model:'different-model'}});release();
    const response=await diagnostic;assert.equal(response.status,409);assert.equal(response.data.error.code,'connection_changed');
    assert.equal((await f.consoleCall()).data.state.diagnostics[sample.id],undefined);
  }finally{release?.();globalThis.fetch=originalFetch;f.close();}
});

test('Gateway regenerates rejected answers and releases only the final checked output',async()=>{
  const f=fixture();const originalFetch=globalThis.fetch;const calls=[];
  try{const state=(await f.consoleCall()).data.state;const base=state.workflows[0];
    const connection={...state.connections.find(c=>c.id===base.mainConnectionId),mode:'vllm',baseUrl:'https://model.example/v1'};
    await f.action('save_connection',{connection});await f.action('save_ingress',{ingress:{enabled:false,allowedCidrs:[],allowedOrigins:['https://model.example']}});
    const workflow={...base,pre:[],post:[{id:'post-retry',name:'응답 조건',mode:'any',rules:[{id:'output-ban',name:'금지 내용',description:'제한 문구를 제외합니다.',kind:'keyword',enabled:true,config:{pattern:'forbidden'}}]}],responseRetry:{enabled:true,maxRetries:2,instruction:'요청한 안내를 다시 작성하세요.'}};
    await f.action('save_workflow',{workflow});const deployed=(await f.action('publish',{workflowId:workflow.id})).deployment;assert.deepEqual(deployed.workflow.responseRetry,workflow.responseRetry);
    const issued=await f.action('create_key',{name:'재작성 검증'});
    globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({choices:[{message:{content:calls.length===1?'forbidden DISCARD_SECRET_MARKER':'검사를 통과한 최종 안내입니다.'}}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}});};
    const response=await f.completion(issued.key,'배송 안내',workflow.alias,{max_tokens:64});const payload=await response.json();
    assert.equal(response.status,200);assert.equal(calls.length,2);assert.equal(payload.choices[0].message.content,'검사를 통과한 최종 안내입니다.');assert.equal(payload.usage.total_tokens,14);
    assert.ok(!JSON.stringify(payload).includes('DISCARD_SECRET_MARKER'));assert.ok(!JSON.stringify(calls[1]).includes('DISCARD_SECRET_MARKER'));
    const log=(await f.consoleCall()).data.state.logs.find(item=>item.id===response.headers.get('X-Aegis-Request-Id'));
    assert.equal(log.regenerationCount,1);assert.equal(log.attempts.length,2);assert.equal(log.traces.filter(t=>t.stage==='main').length,2);assert.ok(!JSON.stringify(log).includes('DISCARD_SECRET_MARKER'));
  }finally{globalThis.fetch=originalFetch;f.close();}
});
test('exhausted response retries remain policy blocks and bounded settings reject invalid limits',async()=>{
  const f=fixture();const originalFetch=globalThis.fetch;let calls=0;
  try{const state=(await f.consoleCall()).data.state;const base=state.workflows[0];
    const connection={...state.connections.find(c=>c.id===base.mainConnectionId),mode:'vllm',baseUrl:'https://model.example/v1'};await f.action('save_connection',{connection});await f.action('save_ingress',{ingress:{enabled:false,allowedCidrs:[],allowedOrigins:['https://model.example']}});
    const workflow={...base,pre:[],post:[{id:'post-limit',name:'금지 조건',mode:'any',rules:[{id:'retry-ban',name:'금지 검사',description:'제한 문구',kind:'keyword',enabled:true,config:{pattern:'forbidden'}}]}],responseRetry:{enabled:true,maxRetries:1}};
    for(const maxRetries of [0,4,1.5]){const invalid=await f.consoleCall({action:'save_workflow',workflow:{...workflow,responseRetry:{enabled:true,maxRetries}}});assert.equal(invalid.status,400);}
    await f.action('save_workflow',{workflow});await f.action('publish',{workflowId:workflow.id});const {key}=await f.action('create_key',{name:'반복 종료'});
    globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:'forbidden DISCARD_FOREVER_MARKER'}}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}});};
    const response=await f.completion(key);const payload=await response.json();assert.equal(response.status,403);assert.equal(payload.error.code,'guardrail_blocked');assert.equal(calls,2);assert.ok(!JSON.stringify(payload).includes('DISCARD_FOREVER_MARKER'));
    const log=(await f.consoleCall()).data.state.logs.find(item=>item.id===response.headers.get('X-Aegis-Request-Id'));assert.equal(log.regenerationCount,1);assert.equal(log.attempts.at(-1).status,'block');assert.ok(!JSON.stringify(log).includes('DISCARD_FOREVER_MARKER'));
  }finally{globalThis.fetch=originalFetch;f.close();}
});
test('retry policy reserves the whole response cycle before any generation',async()=>{
  const f=fixture();const originalFetch=globalThis.fetch;let calls=0;
  try{const state=(await f.consoleCall()).data.state;const base=state.workflows[0];
    const connection={...state.connections.find(c=>c.id===base.mainConnectionId),mode:'vllm',baseUrl:'https://model.example/v1'};await f.action('save_connection',{connection});await f.action('save_ingress',{ingress:{enabled:false,allowedCidrs:[],allowedOrigins:['https://model.example']}});
    const workflow={...base,pre:[],post:[{id:'post-reserve',name:'금지 조건',mode:'any',rules:[{id:'reserve-ban',name:'금지 검사',description:'제한 문구',kind:'keyword',enabled:true,config:{pattern:'forbidden'}}]}],responseRetry:{enabled:true,maxRetries:1}};
    await f.action('save_workflow',{workflow});await f.action('publish',{workflowId:workflow.id});const {key}=await f.action('create_key',{name:'반복 한도',policy:{tpmLimit:200}});
    globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:'안내 응답'}}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}});};
    const denied=await f.completion(key,'hello',workflow.alias,{max_tokens:64});assert.equal(denied.status,429);assert.equal(calls,0);
    await f.action('save_workflow',{workflow:{...workflow,responseRetry:{enabled:false,maxRetries:1}}});await f.action('publish',{workflowId:workflow.id});
    assert.equal((await f.completion(key,'hello',workflow.alias,{max_tokens:64})).status,200);assert.equal(calls,1);
  }finally{globalThis.fetch=originalFetch;f.close();}
});

test('unknown usage on a regeneration is omitted rather than reported as zero or a partial sum',async()=>{
  const f=fixture();const originalFetch=globalThis.fetch;let calls=0;
  try{const state=(await f.consoleCall()).data.state;const base=state.workflows[0];
    const connection={...state.connections.find(c=>c.id===base.mainConnectionId),mode:'vllm',baseUrl:'https://model.example/v1'};await f.action('save_connection',{connection});await f.action('save_ingress',{ingress:{enabled:false,allowedCidrs:[],allowedOrigins:['https://model.example']}});
    const workflow={...base,pre:[],post:[{id:'post-usage',name:'출력 조건',mode:'any',rules:[{id:'usage-ban',name:'금지 검사',description:'',kind:'keyword',enabled:true,config:{pattern:'forbidden'}}]}],responseRetry:{enabled:true,maxRetries:1}};
    await f.action('save_workflow',{workflow});await f.action('publish',{workflowId:workflow.id});const {key}=await f.action('create_key',{name:'불명확한 사용량'});
    globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:calls===1?'forbidden':'최종 응답'}}],...(calls===1?{usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}}:{})});};
    const response=await f.completion(key);const payload=await response.json();assert.equal(response.status,200);assert.equal(calls,2);assert.equal('usage' in payload,false);
    const stateAfter=(await f.consoleCall()).data.state;const log=stateAfter.logs.find(item=>item.id===response.headers.get('X-Aegis-Request-Id'));assert.equal(log.usage,undefined);
    const summary=stateAfter.keys.find(item=>item.prefix===key.slice(0,11));assert.ok(summary.usage.tokens>4);assert.equal(summary.usage.active,0);
  }finally{globalThis.fetch=originalFetch;f.close();}
});
