import { env } from 'cloudflare:workers';
import { handleEvaluationWorker } from '../../../../lib/evaluation-worker';
import type { AegisEnv } from '../../../../lib/aegis-store';
export const dynamic='force-dynamic';
// Dedicated worker authentication is checked by the shared handler. This route
// grants no console identity and forwards non-enumerable bindings unchanged.
export const POST=(request:Request)=>handleEvaluationWorker(request,env as unknown as AegisEnv);
