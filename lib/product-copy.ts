/** Labels for the original sample connections. Stored settings and model IDs stay unchanged. */
export function connectionLabel(name: string): string {
  if (name === 'Qwen 2.5 \u00b7 Main') return 'Qwen 2.5 (응답 생성)';
  if (name === 'Llama Guard \u00b7 Safety') return 'Llama Guard (내용 검사)';
  return name;
}

export function workflowDescription(description: string): string {
  if (description === '안전한 입력부터 신뢰할 수 있는 답변까지, 고객 상담 AI를 보호합니다.') {
    return '개인정보와 지시 우회 요청을 차단하고 생성된 응답을 검사합니다.';
  }
  return description;
}
