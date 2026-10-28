import type { AegisDB } from './aegis-store';
import type { Connection } from './aegis-types';

export class ModelCapacityError extends Error {}
export const DEFAULT_MODEL_MAX_CONCURRENT=8;
export function modelConcurrencyLimit(env:Record<string,unknown>):number {
  const raw=env.AEGIS_MODEL_MAX_CONCURRENT;
  if(raw===undefined||raw==='')return DEFAULT_MODEL_MAX_CONCURRENT;
  const value=typeof raw==='number'?raw:typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)?Number(raw):NaN;
  if(!Number.isInteger(value)||value<1||value>1000)throw new ModelCapacityError('서버의 모델 동시 호출 한도 설정을 확인하세요.');
  return value;
}
export type ModelCapacityLease={release():Promise<void>};
/** One atomic per-connection lease pool is shared by Gateway and evaluations.
 * Expiry recovers crashed callers; no request waits in a hidden model queue. */
export async function acquireModelCapacity(connection:Connection,env:Record<string,unknown>):Promise<ModelCapacityLease> {
  const limit=modelConcurrencyLimit(env),db=env.DB as AegisDB|undefined;
  // Pure engine consumers can omit persistence. Every API runtime supplies DB.
  if(!db)return {async release(){}};
  const leaseId=crypto.randomUUID(),path=`$.leases."${leaseId}"`;
  try{
    await db.prepare("INSERT OR IGNORE INTO aegis_records (namespace,id,payload,updated_at) VALUES ('model_capacity',?,?,?)").bind(connection.id,'{"leases":{}}',new Date().toISOString()).run();
    const now=Date.now();
    const row=await db.prepare(`UPDATE aegis_records SET payload=json_object('leases',json(json_patch(
      COALESCE((SELECT json_group_object(key,value) FROM json_each(aegis_records.payload,'$.leases') WHERE value>?),'{}'),json_object(?,?)))),updated_at=?
      WHERE namespace='model_capacity' AND id=? AND (SELECT COUNT(*) FROM json_each(aegis_records.payload,'$.leases') WHERE value>?)<? RETURNING id`)
      .bind(now,leaseId,now+connection.timeoutMs+60_000,new Date(now).toISOString(),connection.id,now,limit).first<{id:string}>();
    if(!row)throw new ModelCapacityError('모델 서버의 동시 호출 한도에 도달했습니다. 진행 중인 요청이 끝난 뒤 다시 실행하세요.');
  }catch(error){
    if(error instanceof ModelCapacityError)throw error;
    throw new ModelCapacityError('모델 호출 수를 확인하지 못해 실행을 중단했습니다. 서버 저장소 상태를 확인하세요.');
  }
  let released=false;
  return {async release(){
    if(released)return;
    try{await db.prepare("UPDATE aegis_records SET payload=json_remove(payload,?),updated_at=? WHERE namespace='model_capacity' AND id=? AND json_type(payload,?) IS NOT NULL").bind(path,new Date().toISOString(),connection.id,path).run();released=true;}
    catch{throw new ModelCapacityError('모델 호출 종료를 저장하지 못했습니다. 서버 저장소 상태를 확인하세요.');}
  }};
}
