import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node source runner uses explicit extensions.
import {defaultDashboardWorkspace,duplicateDashboardTab,addDashboardTemplate,parseDashboardWorkspace,dashboardPageTarget} from '../lib/dashboard-workspace.ts';

test('a duplicate is independent and respects workspace limits',()=>{
  const original=defaultDashboardWorkspace(),before=structuredClone(original);
  const next=duplicateDashboardTab(original,original.activeTabId);
  assert.equal(next.tabs.length,2);assert.notEqual(next.activeTabId,original.activeTabId);
  next.tabs[1].layout.widgets[0].title='복사 수정';assert.deepEqual(original,before);
  assert.equal(parseDashboardWorkspace(JSON.stringify(next)).error,undefined);
  while(next.tabs.length<12)Object.assign(next,addDashboardTemplate(next,'blocks'));
  assert.equal(duplicateDashboardTab(next,next.activeTabId),next);
});
test('all starter templates import as valid configuration with no request records',()=>{
  for(const type of ['overview','blocks','validation'] as const){
    const result=addDashboardTemplate(defaultDashboardWorkspace(),type);
    assert.ok(result.tabs[1].layout.widgets.length>0);
    assert.equal(parseDashboardWorkspace(JSON.stringify(result)).error,undefined);
    assert.deepEqual(Object.keys(result.tabs[1]).sort(),['filters','id','layout','name']);
  }
});
test('related page links survive config roundtrip and tab removal cleanup',()=>{
  const workspace=defaultDashboardWorkspace(),widget=workspace.tabs[0].layout.widgets[0];
  widget.interaction={targetTabId:'',targetPage:'logs',mode:'drilldown'};
  const restored=parseDashboardWorkspace(JSON.stringify(workspace));
  assert.equal(restored.workspace.tabs[0].layout.widgets[0].interaction?.targetPage,'logs');
  assert.equal(dashboardPageTarget({...widget,dataset:'evaluations',interaction:undefined}),'evaluation');
  assert.equal(dashboardPageTarget({...widget,dataset:'deployments',interaction:undefined}),'gateway');
});
