import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node strip-types requires the source extension.
import { emptyWorkflowHistory, rememberWorkflowChange, restoreWorkflowHistory } from '../lib/workflow-history.ts';
import type { Workflow } from '../lib/aegis-types';
const fixture = (): Workflow => ({ id:'wf',name:'검사 흐름',description:'',alias:'test',mainConnectionId:'model',pre:[],post:[],updatedAt:'2026-10-25' });

test('a continuous 100-event text edit and the previous structural action remain separate undo actions', () => {
  let current=fixture(), history=emptyWorkflowHistory();
  history=rememberWorkflowChange(history,current);
  current={...current,pre:[{id:'group',name:'검사',mode:'any',rules:[]}]};
  for(let i=1;i<=100;i++) { history=rememberWorkflowChange(history,current,'description-focus-1');current={...current,description:'x'.repeat(i),updatedAt:`change-${i}`}; }
  assert.equal(history.past.length,2);
  let restored=restoreWorkflowHistory(history,current,'undo');assert.equal(restored.workflow!.description,'');assert.equal(restored.workflow!.pre.length,1);
  restored=restoreWorkflowHistory(restored.history,restored.workflow!,'undo');assert.equal(restored.workflow!.pre.length,0);
});

test('field changes, focus sessions and structural edits break text batches', () => {
  const current=fixture();let history=emptyWorkflowHistory();
  for(const key of ['name-1','description-1','description-2',undefined,'description-2'])history=rememberWorkflowChange(history,current,key);
  assert.equal(history.past.length,5);
});

test('editing after undo discards redo and starts a new text batch', () => {
  const before=fixture(), after={...before,description:'changed'};
  const first=rememberWorkflowChange(emptyWorkflowHistory(),before,'description-1');
  const undone=restoreWorkflowHistory(first,after,'undo');
  const history=rememberWorkflowChange(undone.history,undone.workflow!,'description-1');
  assert.equal(history.future.length,0);assert.equal(history.past.length,1);
});

test('redo preserves a complete text edit and immutable snapshots', () => {
  const before=fixture(), after={...before,description:'한글 입력 완료'};
  const history=rememberWorkflowChange(emptyWorkflowHistory(),before,'composition-field');
  before.name='outside mutation';
  const undone=restoreWorkflowHistory(history,after,'undo');assert.equal(undone.workflow!.name,'검사 흐름');
  const redone=restoreWorkflowHistory(undone.history,undone.workflow!,'redo');assert.equal(redone.workflow!.description,after.description);
  redone.workflow!.description='outside mutation';assert.equal(after.description,'한글 입력 완료');
});

test('thirty independent operations are retained without changing snapshot source', () => {
  let history=emptyWorkflowHistory();const current=fixture();
  for(let i=0;i<40;i++)history=rememberWorkflowChange(history,{...current,description:String(i)});
  assert.equal(history.past.length,30);assert.equal(history.past[0].description,'10');assert.equal(current.description,'');
});
