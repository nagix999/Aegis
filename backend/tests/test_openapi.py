import asyncio
from aegis.main import create_app

def test_openapi_has_unique_actions_valid_model_refs_bodies_and_auth():
    app=create_app({'AEGIS_DATABASE_PATH':':memory:','AEGIS_EVALUATION_WORKER_ENABLED':'false'})
    try:
        schema=app.openapi();ids=[]
        for path,methods in schema['paths'].items():
            for method,operation in methods.items():
                if method not in {'get','post'}:continue
                ids.append(operation['operationId'])
                if path in {'/api/auth/session', '/api/auth/login'}:
                    assert operation['security'] == []
                else:
                    assert operation['security']
                if method=='post' and path!='/api/auth/logout':
                    assert operation['requestBody']['required']
        assert len(ids)==len(set(ids))
        assert 'Workflow' in schema['components']['schemas']
        assert schema['info']['version']=='3.5.0'
        schemes=schema['components']['securitySchemes']
        assert schemes['ConsoleSession']=={'type':'apiKey','in':'cookie','name':'aegis_session'}
        assert schemes['SessionCSRF']=={'type':'apiKey','in':'header','name':'X-Aegis-CSRF'}
        console=schema['paths']['/api/console']
        assert {'history','query','cursor','limit','runId','datasetId'} <= {item['name'] for item in console['get']['parameters']}
        assert console['post']['requestBody']['content']['application/json']['schema']['properties']['expectedVersion']['maximum']==1000
        assert {'ConsoleSession':[]} in console['get']['security']
        assert {'ConsoleSession':[],'SessionCSRF':[]} in console['post']['security']
        assert {'ConsoleBasic':[]} in console['post']['security']
        assert {'AdminToken':[]} in console['post']['security']
        assert {'ConsoleSession':[],'SessionCSRF':[]} in schema['paths']['/api/auth/logout']['post']['security']
        def visit(value):
            if isinstance(value,dict):
                if '$ref' in value:
                    target=schema
                    for piece in value['$ref'].removeprefix('#/').split('/'):target=target[piece]
                for item in value.values():visit(item)
            elif isinstance(value,list):
                for item in value:visit(item)
        visit(schema)
    finally:asyncio.run(app.state.store.close())
