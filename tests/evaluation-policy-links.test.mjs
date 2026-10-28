import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source=await readFile(new URL('../components/evaluation-page.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('evaluation-page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='EvaluationPage');
const declarations=['editTrace','editPolicyNode'].map(name=>component.body.statements.filter(ts.isVariableStatement).flatMap(statement=>[...statement.declarationList.declarations]).find(declaration=>declaration.name.getText(tree)===name));
assert.ok(declarations.every(Boolean),'Policy selection uses the production editor navigation adapters');
const code=ts.transpileModule(declarations.map(declaration=>`const ${declaration.getText(tree)};`).join('\n')+'\nglobalThis.actions={editTrace,editPolicyNode};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

test('policy label links translate graph IDs to editor IDs while preserving historical result context',()=>{
  const calls=[],context={tab:'batch',runId:'historical-run',rowId:'selected',resultFilter:'mismatch'};
  const scope=vm.createContext({onEditRule:(...args)=>calls.push(args),captureContext:()=>context});vm.runInContext(code,scope);
  const result={id:'original-result',status:'block',output:''};
  scope.actions.editPolicyNode(result,'original input','workflow-one','historical-fingerprint')('branch-one');
  assert.deepEqual(calls[0],['workflow-one','policy:branch-one','original input',result,'historical-fingerprint',context]);
  scope.actions.editTrace(result,'original input','workflow-one','historical-fingerprint')('policy:branch-one');
  assert.equal(calls[1][1],'policy:branch-one','Engine trace IDs already have the prefix and must not be translated twice');
});
