import type { DatasetRow } from './aegis-types';

export type EvaluationCaseCriteria = { expected:DatasetRow['expected']|''; expectedStage?:DatasetRow['expectedStage']|'';
  expectedRuleId?:string; expectedRoute?:DatasetRow['expectedRoute']|''; expectedPolicyCode?:string };

/** Expectations are entered by the user, independently of the most recent model result. */
export function evaluationCaseCriteriaError(criteria:EvaluationCaseCriteria,confirmed:boolean):string {
  if(criteria.expected!=='allow'&&criteria.expected!=='block')return '실제 실행 결과와 별도로 예상 결과를 선택하세요.';
  if(criteria.expectedPolicyCode?.trim()&&!/^[A-Z][A-Z0-9_]{0,63}$/.test(criteria.expectedPolicyCode.trim()))return '공개 오류 코드는 영문 대문자로 시작하고 대문자, 숫자와 밑줄로 64자 이내 입력하세요.';
  return confirmed?'':'입력한 예상 결과를 검증 기준으로 저장할지 확인하세요.';
}

export function evaluationCaseExpectation(criteria:EvaluationCaseCriteria):Pick<DatasetRow,'expected'|'expectedStage'|'expectedRuleId'|'expectedRoute'|'expectedPolicyCode'> {
  if(criteria.expected!=='allow'&&criteria.expected!=='block')throw new Error('예상 결과를 선택하세요.');
  return {expected:criteria.expected,...(criteria.expectedStage?{expectedStage:criteria.expectedStage}:{}),
    ...(criteria.expectedRuleId?{expectedRuleId:criteria.expectedRuleId}:{}),...(criteria.expectedRoute?{expectedRoute:criteria.expectedRoute}:{}),
    ...(criteria.expectedPolicyCode?.trim()?{expectedPolicyCode:criteria.expectedPolicyCode.trim()}:{})};
}
