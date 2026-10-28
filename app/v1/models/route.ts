import { env } from 'cloudflare:workers';
import { handleModels } from '../../../lib/aegis-api';
import type { AegisEnv } from '../../../lib/aegis-store';
export const dynamic='force-dynamic';
export const GET=(request:Request)=>handleModels(request,env as unknown as AegisEnv);
