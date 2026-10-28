import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source=await readFile(new URL('../components/evaluation-page.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('evaluation-page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='LogsPage');
const effect=component.body.statements.find(node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(tree)==='useEffect').expression.arguments[0];
const code=ts.transpileModule(`globalThis.run=${effect.getText(tree)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
function fixture(){
  const pending=[];
  const context={AbortController,Error,Array,Number,active:true,pendingInitialRequest:{current:''},search:'view=logs&limit=50&query=older-request',revision:0,currentRequest:{current:0},loading:false,error:'',data:undefined,selectedId:'old',
    fetch(url,init){const request=deferred();pending.push({url,init,...request});return request.promise;},
  };
  for(const name of ['Loading','Error','Data','SelectedId']){const key=name[0].toLowerCase()+name.slice(1);context[`set${name}`]=value=>context[key]=value;}
  vm.runInContext(code,vm.createContext(context));return{context,pending,run:context.run};
}
const answer=id=>({ok:true,json:async()=>({logs:[{id}],total:250,retention:{days:30,maxRecords:1000},nextCursor:'next'})});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('log search asks the server for all retained matching rows and exposes server totals',async()=>{
  const f=fixture();f.run();assert.equal(f.pending[0].url,'/api/console?view=logs&limit=50&query=older-request');assert.equal(f.pending[0].init.cache,'no-store');
  f.pending[0].resolve(answer('older-request'));await tick();assert.equal(f.context.data.total,250);assert.equal(f.context.data.logs[0].id,'older-request');assert.equal(f.context.loading,false);assert.equal(f.context.selectedId,'');
});
test('a superseded log response cannot replace a newer filter result even if transport ignores abort',async()=>{
  const f=fixture();const cleanup=f.run();cleanup();assert.equal(f.pending[0].init.signal.aborted,true);f.context.search='view=logs&query=new';f.run();
  f.pending[1].resolve(answer('new'));await tick();f.pending[0].resolve(answer('stale'));await tick();assert.equal(f.context.data.logs[0].id,'new');assert.equal(f.context.loading,false);
});
test('leaving the log page aborts the request and rejects any subsequent state update',async()=>{
  const f=fixture();const cleanup=f.run();cleanup();f.pending[0].resolve(answer('late'));await tick();assert.equal(f.context.data,undefined);assert.equal(f.context.error,'');
});
test('server failures do not present old results as a successful new search',async()=>{
  const f=fixture();f.context.data={logs:[{id:'old'}]};f.run();assert.equal(f.context.data,undefined);
  f.pending[0].resolve({ok:false,json:async()=>({error:{message:'관리자 인증이 필요합니다.'}})});await tick();assert.equal(f.context.error,'관리자 인증이 필요합니다.');assert.equal(f.context.data,undefined);assert.equal(f.context.loading,false);
});
test('an inactive retained log page starts no request or selection reset',()=>{
  const f=fixture();f.context.active=false;f.run();assert.equal(f.pending.length,0);assert.equal(f.context.selectedId,'old');
});
test('an exact request deep link opens only its returned matching record',async()=>{
  const f=fixture();f.context.pendingInitialRequest.current='deep-request';f.run();f.pending[0].resolve(answer('deep-request'));await tick();
  assert.equal(f.context.selectedId,'deep-request');assert.equal(f.context.pendingInitialRequest.current,'');
  const missing=fixture();missing.context.pendingInitialRequest.current='missing';missing.run();missing.pending[0].resolve(answer('another-request'));await tick();assert.equal(missing.context.selectedId,'');
});
