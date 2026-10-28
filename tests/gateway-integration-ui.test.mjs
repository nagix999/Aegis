import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { initialState } from '../lib/aegis-seed.ts';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(project,'work'),{recursive:true});const temporary=await mkdtemp(join(project,'work','integration-ui-'));after(()=>rm(temporary,{recursive:true,force:true}));
const entry=join(temporary,'entry.tsx');
await writeFile(entry,`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {GatewayPage} from ${JSON.stringify(join(project,'components/management-pages.tsx'))};export const render=props=>renderToStaticMarkup(React.createElement(GatewayPage,props));`);
await build({root:project,configFile:false,publicDir:false,plugins:[react()],resolve:{alias:{'@':project}},logLevel:'silent',build:{ssr:entry,outDir:join(temporary,'build'),emptyOutDir:true,target:'node22',rollupOptions:{output:{entryFileNames:'entry.mjs'}}}});
const {render}=await import(pathToFileURL(join(temporary,'build/entry.mjs')).href);
const props=()=>({state:initialState(),act:async()=>undefined,notify:()=>{},onViewEvaluation:()=>{}});
test('integration UI uses a callable deployment alias and a link to its verification, not a renamed draft',()=>{
  const p=props(),workflow=p.state.workflows[0];p.state.workflows[0]={...workflow,alias:'draft-unpublished'};p.state.deployments=[{id:'deployment',workflowId:workflow.id,alias:'live-customer-service',version:7,workflow:structuredClone(workflow),connections:p.state.connections,createdAt:'2026-10-26T00:00:00Z',verificationRunId:'run-proof'}];
  const html=render(p);assert.match(html,/호출할 배포 모델/);assert.match(html,/live-customer-service/);assert.match(html,/검증 결과 보기/);const example=html.match(/<pre class="mg-code">([\s\S]*?)<\/pre>/)?.[1]||'';assert.match(example,/live-customer-service/);assert.doesNotMatch(example,/draft-unpublished/);
});
test('an unpublished workflow has no copyable invented API call example',()=>{
  const p=props();p.state.deployments=[];const html=render(p);assert.match(html,/호출할 배포 모델이 없습니다/);assert.doesNotMatch(html,/<pre class="mg-code">/);assert.doesNotMatch(html,/코드 복사/);
});
