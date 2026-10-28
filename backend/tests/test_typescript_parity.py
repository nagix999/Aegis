"""Same workflow inputs compared with the retained TypeScript implementation."""
import json
from pathlib import Path
import httpx
import pytest
from aegis.engine import execute_workflow

CASES=json.loads(Path(__file__).with_name('typescript-parity.json').read_text())

def normalize(result):
    return {
        'status':result['status'],'stage':result['stage'],'output':result['output'],
        'finishReason':result.get('finishReason'),'usage':result.get('usage'),
        'regenerationCount':result.get('regenerationCount'),
        'traces':[{key:trace.get(key) for key in ('ruleId','stage','status','attempt')} for trace in result['traces']],
        'flowTraces':result.get('flowTraces'),
        'attempts':[{key:attempt[key] for key in ('number','status','stage')} for attempt in result['attempts']] if 'attempts' in result else None,
    }

@pytest.mark.parametrize('case',CASES,ids=[case['name'] for case in CASES])
async def test_matches_typescript_execution(case):
    responses=iter(case.get('responses',[]))
    async def respond(_request):
        return httpx.Response(200,json=next(responses))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result=await execute_workflow(case['workflow'],case['connections'],case['ingress'],{},case['messages'],case['options'],client=client)
    assert normalize(result)==case['expected']
