import type { AegisStore } from './aegis-store';
import type { Dataset, EvalRun, VerificationSummary, Workflow } from './aegis-types';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import { datasetFingerprint, matchesExpectation } from './workflow-review.ts';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import { ENGINE_VERSION } from './execution-provenance.ts';

export class DeploymentVerificationError extends Error {
  code:string; status:number;
  constructor(message:string,code='verification_failed',status=400){super(message);this.code=code;this.status=status;}
}
function requireThat(value:unknown,message:string,code?:string,status?:number):asserts value {
  if(!value)throw new DeploymentVerificationError(message,code,status);
}
export async function verifyDeploymentEvidence(store:AegisStore,workflow:Workflow,fingerprint:string,data:Record<string,unknown>){
  const raw=data.verificationRunIds??(data.verificationRunId?[data.verificationRunId]:[]);
  requireThat(Array.isArray(raw)&&raw.length<=30&&raw.every(value=>typeof value==='string'&&value.length>0&&value.length<=120),'배포 근거로 사용할 검증 기록을 확인하세요.');
  const identifiers=[...new Set(raw as string[])];
  const required=new Set(workflow.releasePolicy?.requiredDatasetIds??[]);
  const checks:{namespace:string;id:string;revision:string}[]=[];
  const verificationSummaries:VerificationSummary[]=[];
  const covered=new Set<string>();
  for(const identifier of identifiers){
    const captured=await store.getRecordWithVersion<EvalRun>('run',identifier),run=captured?.value;
    requireThat(run&&captured&&run.workflowId===workflow.id,'선택한 검증 기록을 찾을 수 없습니다.','verification_not_found');
    requireThat(run.status==='completed','완료된 검증만 배포 근거로 사용할 수 있습니다.','verification_incomplete');
    requireThat(run.engineVersion===ENGINE_VERSION,'검증에 사용한 실행 엔진이 변경되었습니다. 현재 엔진으로 다시 검증하세요.','verification_engine_stale',409);
    requireThat(run.fingerprint===fingerprint,'검증한 설정과 현재 초안이 다릅니다. 다시 검증하세요.','verification_stale',409);
    requireThat(!run.results.some(result=>result.executionMode==='mock'),'모의 응답 실행은 배포 근거로 사용할 수 없습니다.');
    const datasetRecord=await store.getRecordWithVersion<Dataset>('dataset',run.datasetId),dataset=datasetRecord?.value;
    requireThat(dataset&&datasetRecord&&run.datasetFingerprint===await datasetFingerprint(dataset),'검증 데이터셋이 변경되었거나 삭제되었습니다. 다시 검증하세요.','verification_stale',409);
    const rowIds=new Set(run.results.map(result=>result.rowId));
    requireThat(run.datasetSnapshot&&run.results.length===dataset.rows.length&&rowIds.size===dataset.rows.length&&dataset.rows.every(row=>{const result=run.results.find(item=>item.rowId===row.id);return result&&matchesExpectation(row,result);}), '전체 데이터셋의 예상 결과를 모두 충족한 검증만 배포 근거로 사용할 수 있습니다. 일부 항목만 재시도한 기록은 전체 검증을 다시 실행하세요.');
    checks.push({namespace:'run',id:run.id,revision:captured.revision},{namespace:'dataset',id:dataset.id,revision:datasetRecord.revision});
    // Keep only the release evidence manifest. Retention may remove the raw
    // run later without erasing which data and engine justified this release.
    verificationSummaries.push({runId:run.id,datasetId:dataset.id,datasetName:dataset.name,datasetFingerprint:run.datasetFingerprint!,fingerprint,
      total:dataset.rows.length,matchedCount:dataset.rows.length,completedAt:run.updatedAt??run.createdAt,engineVersion:ENGINE_VERSION});
    covered.add(dataset.id);
  }
  requireThat([...required].every(identifier=>covered.has(identifier)),'필수 데이터셋의 검증을 모두 완료하고 배포 근거로 선택하세요.','required_verification_missing');
  requireThat(!workflow.releasePolicy?.requireVerification||identifiers.length>0,'이 워크플로우는 검증 근거가 있어야 배포할 수 있습니다.','required_verification_missing');
  let unverifiedReason:string|undefined;
  if(!identifiers.length&&data.acknowledgeUnverified!==undefined){
    requireThat(data.acknowledgeUnverified===true,'검증 근거 없는 배포 여부를 확인하세요.');
    requireThat(typeof data.unverifiedReason==='string'&&data.unverifiedReason.trim().length>0&&data.unverifiedReason.length<=1000,'검증 근거 없이 배포하는 이유를 입력하세요.');
    unverifiedReason=data.unverifiedReason.trim();
  }
  return {checks,engineVersion:ENGINE_VERSION,...(identifiers.length?{verificationRunId:identifiers[0],verificationRunIds:identifiers,verificationSummaries}:{}),...(unverifiedReason?{unverifiedReason}:{})};
}
