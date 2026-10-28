"""Export the actual FastAPI contract without starting a server or seeding user data."""
import asyncio
import json
from pathlib import Path
import sys
project=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(project/'backend'))
from aegis.main import create_app
app=create_app({'AEGIS_DATABASE_PATH':':memory:','AEGIS_EVALUATION_WORKER_ENABLED':'false'})
try:
    (project/'backend/openapi.json').write_text(json.dumps(app.openapi(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
finally:
    asyncio.run(app.state.store.close())
