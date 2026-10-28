import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {evaluationCaseCriteriaError,evaluationCaseExpectation} from '../lib/evaluation-case.ts';

const source=await readFile(new URL('../components/evaluation-page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('evaluation-page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='EvaluationPage');
const declaration=component.body.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='saveResultCase');
assert.ok(declaration);
const code=ts.transpileModule(declaration.getText(ast)+';globalThis.saveCase=saveResultCase;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(){
  const posts=[],notices=[];
  const host={evaluationCaseCriteriaError,evaluationCaseExpectation,result:{status:'allow',output:'MODEL_OUTPUT_MUST_NOT_BE_SAVED',policyRoute:'main'},lastInput:'직접 입력한 예제 요청',readOnly:false,state:{datasets:[]},caseDatasetId:'',caseName:'분기 검증',caseExpected:'',caseCategory:'정책',caseNote:'사용자 기준',caseStage:'',caseRule:'',caseRoute:'',casePolicyCode:'',caseConfirmed:false,mounted:{current:true},crypto:{randomUUID:()=> 'example-safe-identifier'},caseError:'',controlBusy:'',saveCase:true,notify(message){notices.push(message);},async act(payload){posts.push(structuredClone(payload));return{state:{datasets:[payload.dataset]}};}};
  for(const[key,property]of Object.entries({setCaseError:'caseError',setControlBusy:'controlBusy',setSaveCase:'saveCase'}))host[key]=value=>{host[property]=value;};
  const context=vm.createContext(host);vm.runInContext(code,context);return{host,posts,notices,save:context.saveCase};
}

test('saving an execution as a case requires an independently selected expectation and explicit confirmation',async()=>{
  const f=fixture();await f.save();assert.equal(f.posts.length,0);assert.match(f.host.caseError,/예상 결과를 선택/);
  f.host.caseExpected='block';await f.save();assert.equal(f.posts.length,0);assert.match(f.host.caseError,/확인/);
  f.host.caseConfirmed=true;await f.save();assert.equal(f.posts.length,1);
  assert.equal(f.posts[0].dataset.rows[0].expected,'block','The actual allow result is not copied over the entered expectation');
  assert.equal(f.host.saveCase,false);assert.doesNotMatch(JSON.stringify(f.posts),/MODEL_OUTPUT_MUST_NOT_BE_SAVED/);
});

test('case saving preserves optional main, registered response and public error expectations without raw results',async()=>{
  for(const route of ['main','respond','error']){
    const f=fixture();Object.assign(f.host,{caseExpected:route==='error'?'block':'allow',caseRoute:route,caseConfirmed:true,...(route==='error'?{casePolicyCode:'  PII_RESTRICTED  '}:{})});
    await f.save();const row=f.posts[0].dataset.rows[0];assert.equal(row.expectedRoute,route);assert.equal(row.input,f.host.lastInput);
    assert.equal(row.expectedPolicyCode,route==='error'?'PII_RESTRICTED':undefined);
    assert.equal('output' in row,false);assert.equal('policyPath' in row,false);assert.equal('policyDecision' in row,false);
  }
});

test('invalid public codes cannot be stored and unspecified policy expectations are omitted',async()=>{
  const f=fixture();Object.assign(f.host,{caseExpected:'block',caseConfirmed:true,casePolicyCode:'not a public code'});
  await f.save();assert.equal(f.posts.length,0);assert.match(f.host.caseError,/공개 오류 코드/);
  const expected=evaluationCaseExpectation({expected:'allow'});assert.deepEqual(expected,{expected:'allow'});
});
