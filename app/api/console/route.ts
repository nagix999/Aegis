import { env } from 'cloudflare:workers';
import { handleConsole } from '../../../lib/aegis-api';
import type { AegisEnv } from '../../../lib/aegis-store';
export const dynamic='force-dynamic';
// Forward bindings through their original receiver, including non-enumerable
// runtime secrets. Copying env with object spread can drop those bindings.
const consoleEnv=new Proxy(env as unknown as AegisEnv,{
  get(target,key) {
    if(key==='AEGIS_REQUIRE_ADMIN_IDENTITY') return import.meta.env.DEV?'false':'true';
    return Reflect.get(target,key,target);
  },
});
export const GET=(request:Request)=>handleConsole(request,consoleEnv);
export const POST=(request:Request)=>handleConsole(request,consoleEnv);
