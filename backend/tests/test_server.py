"""A real Uvicorn process: static UI, auth, durable jobs and restart migration."""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
from aegis.review import ENGINE_VERSION

PROJECT=Path(__file__).resolve().parents[2]
PYTHON=Path(sys.executable)


def wait_ready(base, process):
    for _ in range(120):
        if process.poll() is not None:
            raise AssertionError(f'Python server stopped with {process.returncode}')
        try:
            response=httpx.get(base+'/healthz',timeout=.3,trust_env=False)
            if response.status_code==200:return response.json()
        except httpx.HTTPError:pass
        time.sleep(.05)
    raise AssertionError('Python server did not become ready')


def test_real_server_ui_gateway_background_and_restart(tmp_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    base=f'http://127.0.0.1:{port}'
    env={**os.environ,'HOST':'127.0.0.1','PORT':str(port),'ADMIN_USER':'admin','ADMIN_PASSWORD':'test-server-only',
         'ADMIN_PASSWORD_HASH':'','AEGIS_ADMIN_TOKEN':'','AEGIS_ROLE_MAP':'','AEGIS_TRUST_PROXY_IDENTITY':'false',
         'AEGIS_REQUIRE_ADMIN_IDENTITY':'true','PUBLIC_BASE_URL':base,'AEGIS_ALLOWED_HOSTS':'127.0.0.1',
         'AEGIS_DATABASE_PATH':str(tmp_path/'aegis.sqlite'),'AEGIS_EVALUATION_WORKER_ENABLED':'true','AEGIS_FRONTEND_PATH':str(PROJECT/'dist/python-client')}
    process=None
    def start():
        proc=subprocess.Popen([str(PYTHON),'backend/run.py'],cwd=PROJECT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        try:health=wait_ready(base,proc)
        except Exception:
            proc.terminate();out=proc.communicate(timeout=5)[1].decode();raise AssertionError(out)
        assert health['backend']=='python-fastapi'
        return proc
    def stop(proc):
        proc.terminate()
        try:proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();proc.communicate(timeout=5)
    try:
        process=start()
        with httpx.Client(base_url=base,auth=('admin','test-server-only'),timeout=20,trust_env=False) as admin,httpx.Client(base_url=base,timeout=20,trust_env=False) as external:
            assert external.get('/api/console').status_code==401
            assert external.get('/docs').status_code==401
            assert admin.get('/').status_code==200
            html=admin.get('/').text
            assert 'assets/index-' in html
            asset=html.split('src="')[1].split('"')[0]
            asset_response=admin.get(asset)
            assert asset_response.status_code==200
            assert ENGINE_VERSION in asset_response.text
            assert admin.get('/openapi.json').json()['info']['title']=='Aegis Gateway API'
            def action(action_name,**data):
                response=admin.post('/api/console',json={'action':action_name,**data})
                assert response.status_code==200,response.text
                return response.json()
            state=admin.get('/api/console').json()['state'];workflow=state['workflows'][0]
            first=action('publish',workflowId=workflow['id'],idempotencyKey='server-publish-unique')['deployment']
            assert action('publish',workflowId=workflow['id'],idempotencyKey='server-publish-unique')['deployment']['id']==first['id']
            key=action('create_key',name='real-server')['key'];headers={'Authorization':f'Bearer {key}'}
            completion=external.post('/v1/chat/completions',headers=headers,json={'model':workflow['alias'],'messages':[{'role':'user','content':'배송 문의'}]})
            assert completion.status_code==200,completion.text
            assert completion.json()['choices'][0]['message']['content']
            blocked=external.post('/v1/chat/completions',headers=headers,json={'model':workflow['alias'],'messages':[{'role':'user','content':'customer@example.com'}]})
            assert blocked.status_code==403,blocked.text
            assert 'customer@example.com' not in blocked.text
            for _ in range(60):
                state=admin.get('/api/console').json()['state']
                if state['evaluationWorker']['available']:break
                time.sleep(.05)
            assert state['evaluationWorker']['available']
            run=action('start_evaluation',workflowId=workflow['id'],datasetId=state['datasets'][0]['id'],executionMode='background')['run']
            for _ in range(100):
                current=admin.get('/api/console',params={'view':'evaluations','runId':run['id']}).json()['run']
                if current['status']!='running':break
                time.sleep(.1)
            assert current['status']=='completed',current
            assert len(current['results'])==8
            assert all(row['expectationMatched'] for row in current['results'])
            with admin.stream('POST','/api/console',json={'action':'playground','workflowId':workflow['id'],'input':'배송 문의','progress':True}) as stream:
                frames=[json.loads(line) for line in stream.iter_lines() if line]
            assert any(frame['type']=='progress' for frame in frames)
            assert frames[-1]['type']=='result'
            assert frames[-1]['fingerprint']
            session=external.post('/api/auth/login',headers={'Origin':base},json={'username':'admin','password':'test-server-only'})
            assert session.status_code==200,session.text
            assert session.json()['authMethod']=='session'
            session_cookie=external.cookies.get('aegis_session')
            session_csrf=session.json()['csrfToken']
            assert external.get('/api/console').status_code==200
            # A browser session must never stand in for a Gateway bearer key.
            assert external.get('/v1/models').status_code==401
        stop(process);process=None
        process=start()
        persisted=httpx.post(base+'/v1/chat/completions',trust_env=False,headers=headers,json={'model':workflow['alias'],'messages':[{'role':'user','content':'배송 문의'}]})
        assert persisted.status_code==200,persisted.text
        assert persisted.headers['x-aegis-workflow-version']=='1'
        session_headers={'Cookie':f'aegis_session={session_cookie}'}
        session_after_restart=httpx.get(base+'/api/auth/session',trust_env=False,headers=session_headers)
        assert session_after_restart.status_code==200
        assert session_after_restart.json()['authenticated'] is True
        assert session_after_restart.json()['csrfToken']==session_csrf
        assert httpx.get(base+'/api/console',trust_env=False,headers=session_headers).status_code==200
        logout=httpx.post(base+'/api/auth/logout',trust_env=False,headers={**session_headers,'Origin':base,'X-Aegis-CSRF':session_csrf})
        assert logout.status_code==200,logout.text
        assert httpx.get(base+'/api/console',trust_env=False,headers=session_headers).status_code==401
    finally:
        if process:stop(process)
