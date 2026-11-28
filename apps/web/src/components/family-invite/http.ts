import { accountUuid, FAMILY_ACCESS_INVITATION_CONFIRMATION, FAMILY_ACCOUNT_HUMAN_COMMAND, validateFamilyAccessInvitationAcceptance, validateFamilyAccountReceipt,
  validateFamilyInvitationEmailInput, validateFamilyInvitationEmailReceipt, type FamilyAccountReceipt, type FamilyInvitationEmailInput, type FamilyInvitationEmailReceipt } from '@hon/contracts';

/**
 * 0714 one-click family invitation: the staff "email it" command and the parent's one-press activation. Both are the
 * same-origin human commands of the family account flow; the API decides everything from the signed session.
 */
export type InviteErrorKind = 'SESSION' | 'DENIED' | 'OFF' | 'LIMIT' | 'WAIT' | 'GONE' | 'REVIEW' | 'VERIFY' | 'REJECTED' | 'UNKNOWN';
export class FamilyInviteError extends Error { constructor(readonly kind: InviteErrorKind) { super(`FAMILY_INVITE_${kind}`); } }

async function command(path: string, body: unknown, key: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': FAMILY_ACCOUNT_HUMAN_COMMAND, 'Idempotency-Key': accountUuid(key) }, body: JSON.stringify(body) });
  } catch { throw new FamilyInviteError('UNKNOWN'); }
  let data: unknown = null;
  try { data = await response.json(); } catch { /* judged by status below */ }
  if (response.status === 200) return data;
  const code = data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' ? data.code : '';
  if (response.status === 401) throw new FamilyInviteError('SESSION');
  if (response.status === 403) throw new FamilyInviteError(code === 'VERIFIED_EMAIL_REQUIRED' ? 'VERIFY' : 'DENIED');
  if (code === 'ACCOUNT_EMAIL_OFF') throw new FamilyInviteError('OFF');
  if (code === 'ACCOUNT_EMAIL_LIMIT') throw new FamilyInviteError('LIMIT');
  if (response.status === 429 || code === 'ACCOUNT_BUSY') throw new FamilyInviteError('WAIT');
  if (response.status === 404) throw new FamilyInviteError('GONE');
  if (code === 'ACCOUNT_REVIEW_REQUIRED') throw new FamilyInviteError('REVIEW');
  if (response.status >= 400 && response.status < 500) throw new FamilyInviteError('REJECTED');
  throw new FamilyInviteError('UNKNOWN');
}
const data = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('data' in value)) throw new FamilyInviteError('UNKNOWN');
  return (value as { data: unknown }).data;
};

export interface FamilyInviteApi {
  email(input: FamilyInvitationEmailInput, key: string): Promise<FamilyInvitationEmailReceipt>;
  activate(invitationId: string, token: string, key: string): Promise<FamilyAccountReceipt>;
}
export const familyInviteApi: FamilyInviteApi = {
  async email(input, key) {
    const answer = await command('/api/v1/school/family-access-invitations/email', validateFamilyInvitationEmailInput(input), key);
    try { return validateFamilyInvitationEmailReceipt(data(answer)); } catch { throw new FamilyInviteError('UNKNOWN'); }
  },
  async activate(invitationId, token, key) {
    const body = validateFamilyAccessInvitationAcceptance({ invitationId, token, confirmation: FAMILY_ACCESS_INVITATION_CONFIRMATION });
    const answer = await command('/api/v1/account/family-access-invitations/accept', body, key);
    try { return validateFamilyAccountReceipt(data(answer)); } catch { throw new FamilyInviteError('UNKNOWN'); }
  },
};
