"""Run with PYTHONPATH=backend python -m aegis."""
import os
import uvicorn
from .config import load_env_file, settings, validate_bind
from .main import create_app

load_env_file()
env = settings()
host = str(env.get("HOST", "127.0.0.1"))
port = int(env.get("PORT", "8787"))
if not 1 <= port <= 65535:
    raise RuntimeError("PORT는 1~65535 사이로 설정하세요.")
validate_bind(env, host)
uvicorn.run(create_app(env), host=host, port=port, proxy_headers=False)
