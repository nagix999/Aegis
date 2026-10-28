import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
async function freePort(){const socket=createTcpServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise((done,reject)=>socket.close(error=>error?reject(error):done()));return port;}

test('standalone HTTP forwards actual progress while an upstream model response is still pending',async()=>{
  await mkdir(join(project,'work'),{recursive:true});
  const temporary=await mkdtemp(join(project,'work','live-progress-runtime-'));
  const key=join(temporary,'upstream-key.pem'),cert=join(temporary,'upstream-cert.pem');
  const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-days','1'],{stdio:'ignore'});
  assert.equal(generated.status,0,'A temporary trusted HTTPS fixture certificate can be generated.');
  const gate=deferred(),upstreamStarted=deferred();let upstreamCompleted=false,upstreamCalls=0,child,reader;
  const upstream=createHttpsServer({key:await readFile(key),cert:await readFile(cert)},async(request,response)=>{
    for await(const _chunk of request){ /* Drain only the fixture request body. */ }
    upstreamCalls++;upstreamStarted.resolve();await gate.promise;
    upstreamCompleted=true;response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{message:{content:'답변이 도착했습니다.'}}]}));
  });
  try{
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    const upstreamOrigin=`https://127.0.0.1:${upstream.address().port}`;
    const port=await freePort(),base=`http://127.0.0.1:${port}`,password=randomBytes(24).toString('hex');
    const authorization=`Basic ${Buffer.from(`live:${password}`).toString('base64')}`;
    child=spawn(process.execPath,['scripts/local-api.mjs','--no-build'],{cwd:project,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),PUBLIC_BASE_URL:base,AEGIS_DATABASE_PATH:join(temporary,'aegis.sqlite'),ADMIN_USER:'live',ADMIN_PASSWORD:password,AEGIS_ADMIN_TOKEN:randomBytes(32).toString('hex'),AEGIS_REQUIRE_ADMIN_IDENTITY:'false',AEGIS_EVALUATION_WORKER_ENABLED:'false',AEGIS_ALLOW_PRIVATE_UPSTREAM:'true',NODE_EXTRA_CA_CERTS:cert},stdio:['ignore','pipe','pipe']});
    await new Promise((done,reject)=>{const timeout=setTimeout(()=>reject(new Error('Live progress fixture runtime did not start.')),15000);child.stdout.on('data',chunk=>{if(String(chunk).includes('Aegis is listening')){clearTimeout(timeout);done();}});child.stderr.on('data',()=>{});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Live progress fixture exited (${code}).`));});});
    async function action(action,payload={}){const response=await fetch(base+'/api/console',{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({action,...payload}),signal:AbortSignal.timeout(7000)});const body=await response.json();assert.equal(response.status,200,`${action}: ${body.error?.code||response.status}`);return body;}
    const response=await fetch(base+'/api/console',{headers:{Authorization:authorization},signal:AbortSignal.timeout(7000)}),state=(await response.json()).state;
    const workflow={...state.workflows[0],pre:[],post:[]};
    await action('save_workflow',{workflow});
    const connection={...state.connections.find(item=>item.id===workflow.mainConnectionId),mode:'vllm',baseUrl:upstreamOrigin+'/v1',secretEnv:'',timeoutMs:10000};
    await action('save_connection',{connection});await action('save_ingress',{ingress:{...state.ingress,allowedOrigins:[upstreamOrigin]}});
    const streamed=await fetch(base+'/api/console',{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({action:'playground',workflowId:workflow.id,target:'draft',input:'배송 문의',progress:true}),signal:AbortSignal.timeout(10000)});
    assert.equal(streamed.status,200);assert.match(streamed.headers.get('content-type'),/application\/x-ndjson/);assert.equal(upstreamCompleted,false);
    reader=streamed.body.getReader();const decoder=new TextDecoder();let pending='';const messages=[];
    async function read(){const chunk=await reader.read();if(chunk.done)return false;pending+=decoder.decode(chunk.value,{stream:true});const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line.trim())messages.push(JSON.parse(line));return true;}
    while(!messages.some(message=>message.type==='progress'&&message.event.stage==='main'&&message.event.status==='running'))assert.equal(await read(),true,'A live event arrives before the stream closes.');
    await upstreamStarted.promise;
    assert.equal(upstreamCompleted,false,'The running event is observable before releasing the model response.');assert.equal(messages.some(message=>message.type==='result'),false);
    assert.ok(messages.filter(message=>message.type==='progress').every(message=>!('input'in message.event)&&!('output'in message.event)&&!('reason'in message.event)));
    gate.resolve();while(await read()){}
    const final=messages.filter(message=>message.type==='result');assert.equal(final.length,1);assert.equal(final[0].result.status,'allow');assert.equal(final[0].result.output,'답변이 도착했습니다.');assert.equal(upstreamCalls,1);assert.equal(upstreamCompleted,true);
    const sequence=messages.filter(message=>message.type==='progress').map(message=>message.event.sequence);assert.deepEqual(sequence,[...sequence].sort((a,b)=>a-b));assert.equal(new Set(sequence).size,sequence.length);
  }finally{
    gate.resolve();try{await reader?.cancel();}catch{}
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),3000);await exited;clearTimeout(timeout);}
    upstream.closeAllConnections();await new Promise(done=>upstream.close(done));await rm(temporary,{recursive:true,force:true});
  }
});
