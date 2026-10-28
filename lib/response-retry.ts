import type { Connection, Workflow } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { effectiveExecutionLimits } from './execution-plan.ts';

export const MAX_RESPONSE_RETRIES = 3;
export const MAX_REPAIR_GUIDANCE_CHARS = 8_000;

export function responseAttemptLimit(workflow: Pick<Workflow, 'responseRetry'>): number {
  const policy = workflow.responseRetry;
  if (!policy?.enabled) return 1;
  // Invalid saved settings are rejected by the engine before execution. Keep
  // reservations bounded and conservative while that validation is pending.
  return 1 + (Number.isInteger(policy.maxRetries) && policy.maxRetries >= 1 && policy.maxRetries <= MAX_RESPONSE_RETRIES ? policy.maxRetries : MAX_RESPONSE_RETRIES);
}

export function responseTokenReservation(workflow: Pick<Workflow, 'responseRetry'>, messages: {content: string}[], maxOutputTokens: number): number {
  const encoder = new TextEncoder();
  const originalPrompt = messages.reduce((total, message) => total + encoder.encode(message.content).length + 32, 32);
  const attempts = responseAttemptLimit(workflow);
  // The engine starts each retry from the original conversation and adds only
  // bounded repair guidance, never a rejected answer or earlier retry context.
  // Four bytes per character and one additional message cover UTF-8 guidance
  // and the possible system message inserted when the conversation lacks one.
  const retryPrompt = originalPrompt + MAX_REPAIR_GUIDANCE_CHARS * 4 + 32;
  return originalPrompt + maxOutputTokens + (attempts - 1) * (retryPrompt + maxOutputTokens);
}

export function executionLeaseDuration(workflow: Workflow, connections: Connection[]): number {
  // A processing lease must outlive the enforced whole-workflow deadline,
  // including result persistence. Individual model timeouts and graph size can
  // no longer extend a live run past that deadline. Keep the two-minute minimum
  // for compatibility with short jobs and old records.
  void connections;
  return Math.max(120_000, effectiveExecutionLimits(workflow).timeoutMs + 60_000);
}
