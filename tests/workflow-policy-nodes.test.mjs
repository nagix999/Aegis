import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState } from '../lib/aegis-seed.ts';
import { bindWorkflowPolicyNode, removeWorkflowPolicy, connectWorkflowPolicyNode, addWorkflowPolicyGraphNode, setWorkflowPolicyEntryNode } from '../lib/workflow-policy-nodes.ts';
import { isRecoverableWorkflow, saveWorkflowRecovery, readWorkflowRecovery } from '../lib/workflow-recovery.ts';

function policy({id='canvas-policy',version=1,formatVersion=2}={}) {
  const connection=structuredClone(initialState().connections.find(item=>item.role!=='main'));
  return {id,name:'캔버스 정책',description:'',prompt:'입력을 분류하세요.',connectionId:connection.id,connectionSnapshot:connection,version,updatedAt:'2026-10-27T00:00:00Z',
    ...(formatVersion===2?{formatVersion:2,outputSchema:{type:'object',properties:{topic:{type:'string'}}},maxOutputTokens:1024,decisions:[],examples:[{id:'example',input:'배송',expectedOutput:{topic:'service'}}]}:
      {decisions:[{code:'IN_SCOPE',label:'범위 안',description:''},{code:'OUT_OF_SCOPE',label:'범위 밖',description:''}],examples:[{id:'example',input:'배송',expectedDecision:'IN_SCOPE'}]})};
}
function workflow(){return structuredClone(initialState().workflows[0]);}
function bound(){return bindWorkflowPolicyNode(workflow(),policy());}
function ids(value){const nodes=value.policyRouting.graph.nodes;return {branch:nodes.find(node=>node.kind==='branch').id,rules:nodes.filter(node=>node.kind==='rule').map(node=>node.id),action:nodes.find(node=>node.kind==='action').id};}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function withLayout(value){const {branch}=ids(value);return {...value,layout:{version:1,positions:{input:{x:0,y:0},main:{x:500,y:0},policy:{x:250,y:0},[`policy-node:${branch}`]:{x:300,y:50},'policy-node:custom':{x:350,y:50},'policy-other':{x:20,y:20}},pinnedKeys:['input','policy',`policy-node:${branch}`,'policy-node:custom'],zones:[{id:'z',name:'영역',color:'blue',x:0,y:0,width:600,height:200,nodeKeys:['input','policy',`policy-node:${branch}`,'policy-node:custom','main']},{id:'empty-after-removal',name:'정책 영역',color:'slate',x:0,y:300,width:300,height:180,nodeKeys:['policy-node:custom']}]}};}

test('binding captures an immutable policy revision without changing the workflow or source policy',()=>{
  const original=freeze(workflow()),revision=freeze(policy()),before=structuredClone(original),snapshot=structuredClone(revision),next=bindWorkflowPolicyNode(original,revision);
  assert.deepEqual(original,before);assert.deepEqual(revision,snapshot);assert.notEqual(next,original);assert.deepEqual(next.policyRouting.policy,snapshot);
  next.policyRouting.policy.outputSchema.properties.topic.description='변경';next.policyRouting.policy.examples[0].expectedOutput.topic='changed';next.policyRouting.policy.connectionSnapshot.model='changed';
  assert.deepEqual(revision,snapshot);assert.notEqual(next.policyRouting.policy.connectionSnapshot,revision.connectionSnapshot);
});
test('rebinding a new revision of the same V2 policy preserves configured and unfinished graph drafts',()=>{
  let value=bound();value=addWorkflowPolicyGraphNode(value,'rule','custom').workflow;
  value.policyRouting.graph.nodes.find(node=>node.kind==='action').action='main';
  value.policyRouting.graph.edges.pop();value=withLayout(value);const before=structuredClone(value),revision=policy({version:2});revision.connectionSnapshot.model='new-model';
  const next=bindWorkflowPolicyNode(freeze(value),freeze(revision));
  assert.deepEqual(value,before);assert.deepEqual(next.policyRouting.graph,before.policyRouting.graph);assert.deepEqual(next.layout,before.layout);
  assert.equal(next.policyRouting.policy.version,2);assert.equal(next.policyRouting.policy.connectionSnapshot.model,'new-model');assert.notEqual(next.policyRouting.graph,value.policyRouting.graph);
});
test('binding a different V2 policy resets its graph and removes only stale policy layout metadata',()=>{
  const value=withLayout(addWorkflowPolicyGraphNode(bound(),'rule','custom').workflow),before=structuredClone(value),next=bindWorkflowPolicyNode(freeze(value),policy({id:'other-policy'}));
  assert.deepEqual(value,before);assert.equal(next.policyRouting.policy.id,'other-policy');assert.equal(next.policyRouting.graph.nodes.some(node=>node.id==='custom'),false);
  assert.equal(Object.hasOwn(next.layout.positions,'policy-node:custom'),false);assert.ok(next.layout.positions.policy);assert.ok(next.layout.positions['policy-other']);
  assert.ok(next.layout.pinnedKeys.includes('policy'));assert.equal(next.layout.pinnedKeys.includes('policy-node:custom'),false);
  assert.equal(next.layout.zones[0].nodeKeys.includes('policy-node:custom'),false);assert.deepEqual(next.layout.zones[1].nodeKeys,[]);
});
test('switching from V2 to V1 removes V2 node metadata and preserves the policy singleton',()=>{
  const value=withLayout(bound()),before=structuredClone(value),next=bindWorkflowPolicyNode(freeze(value),policy({formatVersion:1}));
  assert.deepEqual(value,before);assert.equal(Object.hasOwn(next.policyRouting,'graph'),false);assert.equal(next.policyRouting.routes.length,2);
  assert.equal(Object.keys(next.layout.positions).some(key=>key.startsWith('policy-node:')),false);assert.ok(next.layout.positions.policy);
  assert.deepEqual(next.layout.pinnedKeys,['input','policy']);assert.deepEqual(next.layout.zones[0].nodeKeys,['input','policy','main']);
});
test('same-policy V1 revision retains configured decision routes without inventing a V2 graph',()=>{
  const value=bindWorkflowPolicyNode(workflow(),policy({formatVersion:1}));value.policyRouting.routes[0]={decision:'IN_SCOPE',action:'respond',responseText:'관리자 안내'};
  const next=bindWorkflowPolicyNode(freeze(value),policy({formatVersion:1,version:2}));
  assert.deepEqual(next.policyRouting.routes[0],{decision:'IN_SCOPE',action:'respond',responseText:'관리자 안내'});assert.equal(Object.hasOwn(next.policyRouting,'graph'),false);
});
test('removing a policy removes only its routing and canvas metadata without mutating the source',()=>{
  const value=withLayout(bound()),before=structuredClone(value),next=removeWorkflowPolicy(freeze(value));
  assert.deepEqual(value,before);assert.equal(Object.hasOwn(next,'policyRouting'),false);
  assert.deepEqual(next.pre,before.pre);assert.deepEqual(next.post,before.post);assert.equal(next.mainConnectionId,before.mainConnectionId);
  assert.deepEqual(next.layout.positions,{input:{x:0,y:0},main:{x:500,y:0},'policy-other':{x:20,y:20}});assert.deepEqual(next.layout.pinnedKeys,['input']);
  assert.deepEqual(next.layout.zones[0],{...before.layout.zones[0],nodeKeys:['input','main']});assert.deepEqual(next.layout.zones[1],{...before.layout.zones[1],nodeKeys:[]});
});
test('removing an absent policy is immutable and does not invent layout data',()=>{
  const value=freeze(workflow()),next=removeWorkflowPolicy(value);assert.deepEqual(next,value);assert.notEqual(next,value);assert.equal(Object.hasOwn(next,'layout'),Object.hasOwn(value,'layout'));
});
test('replacing a policy port preserves its edge ID and every other edge immutably',()=>{
  const value=bound(),{rules,action}=ids(value),before=structuredClone(value),old=value.policyRouting.graph.edges.find(edge=>edge.from===rules[0]&&edge.port==='true');
  const next=connectWorkflowPolicyNode(freeze(value),rules[0],rules[1],'true','ignored-new-id');
  assert.deepEqual(value,before);assert.deepEqual(next.policyRouting.graph.edges.find(edge=>edge.from===rules[0]&&edge.port==='true'),{...old,to:rules[1]});
  assert.deepEqual(next.policyRouting.graph.edges.filter(edge=>edge.id!==old.id),before.policyRouting.graph.edges.filter(edge=>edge.id!==old.id));
  assert.equal(next.policyRouting.graph.edges.length,value.policyRouting.graph.edges.length);assert.equal(next.policyRouting.graph.nodes.find(node=>node.id===action).action,'error');
});
test('new connections use a supplied edge ID and allow disconnected draft rules',()=>{
  let value=bound();value=addWorkflowPolicyGraphNode(value,'rule','new-rule').workflow;const {action}=ids(value),before=structuredClone(value);
  const next=connectWorkflowPolicyNode(freeze(value),'new-rule',action,'true','new-edge');
  assert.deepEqual(value,before);assert.deepEqual(next.policyRouting.graph.edges.at(-1),{id:'new-edge',from:'new-rule',to:action,port:'true'});
  assert.equal(next.policyRouting.graph.edges.some(edge=>edge.to==='new-rule'),false);
});
test('reconnecting the same port is idempotent and does not grow edge count',()=>{
  const value=bound(),{rules,action}=ids(value),once=connectWorkflowPolicyNode(value,rules[0],action,'true'),twice=connectWorkflowPolicyNode(once,rules[0],action,'true');assert.deepEqual(twice,once);
});

for(const kind of ['missing-source','missing-target','action-source','self','invalid-port','unknown-source-kind','unknown-target-kind'])test(`invalid policy connection ${kind} is rejected without modifying its source`,()=>{
  const value=bound(),{branch,rules,action}=ids(value);let from=rules[0],to=action,port='true';
  if(kind==='missing-source')from='missing';else if(kind==='missing-target')to='missing';else if(kind==='action-source')from=action;
  else if(kind==='self')to=from;else if(kind==='invalid-port')port='next';
  else if(kind==='unknown-source-kind')value.policyRouting.graph.nodes.find(node=>node.id===from).kind='unknown';
  else value.policyRouting.graph.nodes.find(node=>node.id===to).kind='unknown';
  const before=structuredClone(value);assert.throws(()=>connectWorkflowPolicyNode(freeze(value),from,to,port));assert.deepEqual(value,before);
});
test('a two-rule cycle is rejected even though the alternate path terminates in an action',()=>{
  const value=bound(),{rules}=ids(value),linked=connectWorkflowPolicyNode(value,rules[0],rules[1],'true'),before=structuredClone(linked);
  assert.throws(()=>connectWorkflowPolicyNode(freeze(linked),rules[1],rules[0],'true'),/순환/);assert.deepEqual(linked,before);
});
test('cycles in disconnected draft fragments are rejected too',()=>{
  let value=addWorkflowPolicyGraphNode(bound(),'rule','orphan-one').workflow;value=addWorkflowPolicyGraphNode(value,'rule','orphan-two').workflow;
  value=connectWorkflowPolicyNode(value,'orphan-one','orphan-two','true');const before=structuredClone(value);
  assert.throws(()=>connectWorkflowPolicyNode(freeze(value),'orphan-two','orphan-one','false'),/순환/);assert.deepEqual(value,before);
});
test('adding a rule or safe action preserves its source and leaves the new node disconnected',()=>{
  const value=freeze(bound()),before=structuredClone(value),rule=addWorkflowPolicyGraphNode(value,'rule','new-rule'),action=addWorkflowPolicyGraphNode(value,'action','new-action');
  assert.deepEqual(value,before);assert.equal(rule.nodeId,'new-rule');assert.equal(action.nodeId,'new-action');
  assert.deepEqual(rule.workflow.policyRouting.graph.nodes.at(-1),{id:'new-rule',name:'새 조건 분기',kind:'rule',condition:{mode:'all',predicates:[{path:'',operator:'exists'}]}});
  assert.deepEqual(action.workflow.policyRouting.graph.nodes.at(-1),{id:'new-action',name:'새 정책 액션',kind:'action',action:'error',errorCode:'POLICY_UNCONFIGURED',errorMessage:'정책 액션이 아직 설정되지 않았습니다.'});
  assert.deepEqual(rule.workflow.policyRouting.graph.edges,before.policyRouting.graph.edges);
});
test('twenty-four nodes is the inclusive draft limit and the twenty-fifth fails',()=>{
  let value=bound();for(let index=value.policyRouting.graph.nodes.length;index<24;index++)value=addWorkflowPolicyGraphNode(value,'rule',`extra-${index}`).workflow;
  const before=structuredClone(value);assert.equal(value.policyRouting.graph.nodes.length,24);assert.throws(()=>addWorkflowPolicyGraphNode(freeze(value),'action','too-many'),/24/);assert.deepEqual(value,before);
});
for(const identifier of ['', ' ', 'bad id', 'bad/id', 'bad:id', '_leading', 'x'.repeat(81), null, 42])test(`invalid new node ID ${JSON.stringify(identifier)} is rejected`,()=>{
  const value=freeze(bound());assert.throws(()=>addWorkflowPolicyGraphNode(value,'rule',identifier),/ID/);
});
test('duplicate new node IDs and invalid runtime node kinds are rejected',()=>{
  const value=freeze(bound()),{branch}=ids(value);assert.throws(()=>addWorkflowPolicyGraphNode(value,'rule',branch),/ID/);
  assert.throws(()=>addWorkflowPolicyGraphNode(value,'condition','wrong-kind'));
});
test('new edge identifiers must be unique and valid while replacement retains its previous ID',()=>{
  const value=addWorkflowPolicyGraphNode(bound(),'rule','orphan').workflow,{action}=ids(value),duplicate=value.policyRouting.graph.edges[0].id,before=structuredClone(value);
  for(const identifier of [duplicate,'', 'bad id','_bad','x'.repeat(81),null,42])assert.throws(()=>connectWorkflowPolicyNode(freeze(value),'orphan',action,'true',identifier));
  assert.deepEqual(value,before);
});
test('V1 and absent policy graphs cannot be changed through the V2 graph helpers',()=>{
  for(const value of [workflow(),bindWorkflowPolicyNode(workflow(),policy({formatVersion:1}))]){
    assert.throws(()=>connectWorkflowPolicyNode(freeze(value),'a','b','true'),/구조화/);assert.throws(()=>addWorkflowPolicyGraphNode(value,'rule','new-rule'),/구조화/);
  }
});

test('adding just the policy model creates an empty recoverable draft without implied condition or action nodes',()=>{
  const original=freeze(workflow()),revision=freeze(policy()),before=structuredClone(original),next=bindWorkflowPolicyNode(original,revision,{emptyGraph:true});
  assert.deepEqual(original,before);assert.deepEqual(next.policyRouting.graph,{version:1,entryNodeId:'',nodes:[],edges:[]});
  assert.equal(isRecoverableWorkflow(next),true);
  const storage={value:null,getItem(){return this.value;},setItem(_key,value){this.value=value;},removeItem(){this.value=null;}};
  assert.equal(saveWorkflowRecovery(storage,next,original).ok,true);assert.deepEqual(readWorkflowRecovery(storage).records[0].draft,next);
});
test('an action can be added before the first condition and both unfinished drafts survive recovery',()=>{
  const empty=bindWorkflowPolicyNode(workflow(),policy(),{emptyGraph:true}),action=addWorkflowPolicyGraphNode(freeze(empty),'action','first-action').workflow;
  assert.equal(action.policyRouting.graph.entryNodeId,'');assert.equal(isRecoverableWorkflow(action),true);
  const branch=addWorkflowPolicyGraphNode(freeze(action),'branch','first-condition').workflow;
  assert.equal(branch.policyRouting.graph.entryNodeId,'first-condition');assert.equal(branch.policyRouting.graph.nodes.length,2);assert.deepEqual(branch.policyRouting.graph.edges,[]);
  const another=addWorkflowPolicyGraphNode(branch,'branch','second-condition').workflow;assert.equal(another.policyRouting.graph.entryNodeId,'first-condition');
});
test('the empty-graph option preserves an existing same-policy graph but resets a newly selected policy',()=>{
  const value=bound(),before=structuredClone(value.policyRouting.graph),next=bindWorkflowPolicyNode(freeze(value),policy({version:2}),{emptyGraph:true});
  assert.deepEqual(next.policyRouting.graph,before);
  assert.deepEqual(bindWorkflowPolicyNode(value,policy({id:'other'}),{emptyGraph:true}).policyRouting.graph,{version:1,entryNodeId:'',nodes:[],edges:[]});
});
test('a condition can directly choose an action without a redundant rule node',()=>{
  const value=bound(),{branch,action}=ids(value),before=structuredClone(value),next=connectWorkflowPolicyNode(freeze(value),branch,action,'true');
  assert.deepEqual(value,before);assert.equal(next.policyRouting.graph.edges.find(edge=>edge.from===branch&&edge.port==='true').to,action);
});
test('new and legacy condition kinds can be chained in either direction when acyclic',()=>{
  let value=bindWorkflowPolicyNode(workflow(),policy(),{emptyGraph:true});
  for(const [kind,id] of [['branch','first'],['rule','legacy'],['branch','next'],['action','finish']])value=addWorkflowPolicyGraphNode(value,kind,id).workflow;
  value=connectWorkflowPolicyNode(value,'first','legacy','true');value=connectWorkflowPolicyNode(value,'legacy','next','true');value=connectWorkflowPolicyNode(value,'next','finish','true');
  assert.deepEqual(value.policyRouting.graph.edges.map(edge=>[edge.from,edge.to]),[['first','legacy'],['legacy','next'],['next','finish']]);
  assert.throws(()=>connectWorkflowPolicyNode(freeze(value),'next','first','false'),/순환/);
});
test('changing the policy model output entry selects a condition without editing its paths or source',()=>{
  let value=addWorkflowPolicyGraphNode(bound(),'branch','new-entry').workflow;const before=structuredClone(value),next=setWorkflowPolicyEntryNode(freeze(value),'new-entry');
  assert.deepEqual(value,before);assert.equal(next.policyRouting.graph.entryNodeId,'new-entry');assert.deepEqual(next.policyRouting.graph.edges,before.policyRouting.graph.edges);
  const {rules,action}=ids(value);assert.equal(setWorkflowPolicyEntryNode(value,rules[0]).policyRouting.graph.entryNodeId,rules[0]);
  for(const target of ['missing',action])assert.throws(()=>setWorkflowPolicyEntryNode(value,target),/조건 분기/);
  assert.throws(()=>setWorkflowPolicyEntryNode(workflow(),'missing'),/구조화/);
});
test('recovering an unfinished entry does not permit unsafe names, oversized or non-string entry IDs',()=>{
  const value=bindWorkflowPolicyNode(workflow(),policy(),{emptyGraph:true});
  for(const id of ['constructor','prototype','__proto__','bad\u0000id','x'.repeat(121),null,42]){const draft=structuredClone(value);draft.policyRouting.graph.entryNodeId=id;assert.equal(isRecoverableWorkflow(draft),false);}
});
