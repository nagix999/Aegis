"""Independent local evaluation worker: python -m aegis.worker_cli."""
import asyncio
import signal
import httpx
from .config import load_env_file, settings
from .store import Store
from .worker import run_worker

async def main():
    load_env_file()
    env=settings()
    store=Store(env['AEGIS_DATABASE_PATH'],env=env)
    env['_store']=store
    stop=asyncio.Event()
    loop=asyncio.get_running_loop()
    for name in (signal.SIGINT,signal.SIGTERM):
        try:loop.add_signal_handler(name,stop.set)
        except NotImplementedError:pass
    try:
        async with httpx.AsyncClient(follow_redirects=False,timeout=60) as client:
            env['_client']=client
            await run_worker(store,env,stop)
    finally:
        await store.close()

if __name__=='__main__':
    asyncio.run(main())
