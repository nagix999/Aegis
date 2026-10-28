import { env } from 'cloudflare:workers';
import { handleCompletions } from '../../../../lib/aegis-api';
import type { AegisEnv } from '../../../../lib/aegis-store';
export const dynamic='force-dynamic';
export const POST=(request:Request)=>handleCompletions(request,env as unknown as AegisEnv);
