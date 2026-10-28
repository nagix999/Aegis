import type { IngressPolicy } from './aegis-types';

export type AccessDraft = { enabled: boolean; cidrs: string; origins: string };
export type AccessDraftState = { draft: AccessDraft; saved: IngressPolicy; changedOnServer: boolean; error: string };
export type AccessDraftAction =
  | { type: 'edit'; patch: Partial<AccessDraft> }
  | { type: 'sync' | 'saved'; ingress: IngressPolicy }
  | { type: 'discard' }
  | { type: 'error'; message: string };

const lines = (value: string) => value.split(/\n|,/).map(item => item.trim()).filter(Boolean);
const key = (ingress: IngressPolicy) => JSON.stringify([ingress.enabled, ingress.allowedCidrs, ingress.allowedOrigins]);
export const accessDraftPolicy = (draft: AccessDraft): IngressPolicy => ({ enabled: draft.enabled, allowedCidrs: lines(draft.cidrs), allowedOrigins: lines(draft.origins) });
export const accessDraftDirty = (state: AccessDraftState): boolean => key(accessDraftPolicy(state.draft)) !== key(state.saved);
export const createAccessDraftState = (ingress: IngressPolicy): AccessDraftState => ({ draft: { enabled: ingress.enabled, cidrs: ingress.allowedCidrs.join('\n'), origins: ingress.allowedOrigins.join('\n') }, saved: ingress, changedOnServer: false, error: '' });

/** Keep local edits when another console request refreshes the saved settings. */
export function accessDraftReducer(state: AccessDraftState, action: AccessDraftAction): AccessDraftState {
  if (action.type === 'edit') return { ...state, draft: { ...state.draft, ...action.patch }, error: '' };
  if (action.type === 'discard') return createAccessDraftState(state.saved);
  if (action.type === 'error') return { ...state, error: action.message };
  if (action.type === 'saved') return createAccessDraftState(action.ingress);
  if (key(action.ingress) === key(state.saved)) return state;
  if (!accessDraftDirty(state) || key(accessDraftPolicy(state.draft)) === key(action.ingress)) return createAccessDraftState(action.ingress);
  return { ...state, saved: action.ingress, changedOnServer: true };
}
