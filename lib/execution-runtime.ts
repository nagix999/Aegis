import type { ExecutionLimits } from './aegis-types';

export class ExecutionLimitError extends Error {}
/** A budget belongs to one execution and is shared by main, guards and retries.
 * Aborting a network request cannot guarantee upstream GPU computation stops. */
export function createExecutionRuntime(limits:ExecutionLimits,externalSignal?:AbortSignal) {
  const controller=new AbortController();
  let calls=0;
  const deadline=Date.now()+limits.timeoutMs;
  const abortExternal=()=>controller.abort(new ExecutionLimitError('실행 취소 요청에 따라 중단했습니다.'));
  if(externalSignal?.aborted)abortExternal();
  else externalSignal?.addEventListener('abort',abortExternal,{once:true});
  const timer=setTimeout(()=>controller.abort(new ExecutionLimitError('워크플로우 전체 실행 제한 시간을 초과했습니다.')),limits.timeoutMs);
  const assertActive=()=>{
    if(!controller.signal.aborted&&Date.now()>=deadline)controller.abort(new ExecutionLimitError('워크플로우 전체 실행 제한 시간을 초과했습니다.'));
    if(controller.signal.aborted)throw controller.signal.reason;
  };
  return {
    signal:controller.signal,
    assertActive,
    beforeModelCall(){assertActive();if(calls>=limits.maxModelCalls){controller.abort(new ExecutionLimitError('워크플로우의 모델 호출 한도에 도달했습니다.'));throw controller.signal.reason;}calls++;},
    async wait<T>(operation:Promise<T>):Promise<T>{
      try{assertActive();}catch(error){void operation.catch(()=>{});throw error;}
      let listener:()=>void=()=>{};
      const stopped=new Promise<never>((_resolve,reject)=>{listener=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',listener,{once:true});});
      try{return await Promise.race([operation,stopped]);}
      finally{controller.signal.removeEventListener('abort',listener);}
    },
    dispose(){clearTimeout(timer);externalSignal?.removeEventListener('abort',abortExternal);},
  };
}
export type ExecutionRuntime=ReturnType<typeof createExecutionRuntime>;
