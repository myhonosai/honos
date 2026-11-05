import { STAFF_ACCOUNT_HUMAN_COMMAND, accountClosed, accountUuid, validateStaffInvitation, validateStaffAccountReceipt,
  type CustomRoleSummary, type StaffInvitation } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

export class StaffAccountError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export type StaffScope = Readonly<{ organizationId: string; schoolId: string }>;
export type StaffCommand = Readonly<{ kind: 'invite' | 'revoke' | 'accept'; path: string; body: string; key: string; subject: string; scope: StaffScope | null }>;
const codes = new Set(['ACCOUNT_INPUT_INVALID', 'ACCOUNT_FORBIDDEN', 'VERIFIED_EMAIL_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_REVIEW_REQUIRED',
  'ACCOUNT_CONFLICT', 'ACCOUNT_RATE_LIMITED', 'ACCOUNT_BUSY', 'HUMAN_UI_REQUIRED', 'HUMAN_UI_ORIGIN_NOT_CONFIGURED']);
async function json(path: string, signal: AbortSignal, command?: StaffCommand): Promise<unknown> {
  signal.throwIfAborted();
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin',
    // Non-CORS POSTs with no-referrer serialize Origin as null. Send only the origin, never a private page path.
    cache: 'no-store', redirect: 'error', referrerPolicy: command ? 'strict-origin' : 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': STAFF_ACCOUNT_HUMAN_COMMAND, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired read must not invalidate the newer session that replaced it.
  signal.throwIfAborted();
  if (r.status === 401) { if (!command) reportConfirmedSessionInvalidation(); throw new StaffAccountError(401, 'SIGN_IN_REQUIRED'); }
  if (r.redirected || r.url && (typeof location === 'undefined' || r.url !== new URL(path, location.origin).href)
    || !/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type') ?? '') || !r.body) throw new StaffAccountError(503, 'ACCOUNT_RESPONSE_INVALID');
  const reader = r.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0, text = '';
  try {
    while (true) { signal.throwIfAborted(); const c = await reader.read(); signal.throwIfAborted(); if (c.done) break;
      bytes += c.value.byteLength; if (bytes > 131072) throw new StaffAccountError(503, 'ACCOUNT_RESPONSE_INVALID'); text += decoder.decode(c.value, { stream: true }); }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!r.ok) {
      const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' && codes.has(value.code) ? value.code : 'ACCOUNT_UNAVAILABLE';
      throw new StaffAccountError(r.status, code);
    }
    return value;
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
export const staffInvitationApi = {
  async identity(subject: string, signal: AbortSignal): Promise<void> {
    const data = accountClosed(await json('/api/identity/me', signal), ['data']).data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('externalSubject' in data) || typeof data.externalSubject !== 'string'
      || Object.keys(data).some(k => !['externalSubject', 'displayName', 'email'].includes(k))) throw new StaffAccountError(503, 'ACCOUNT_RESPONSE_INVALID');
    if (data.externalSubject !== subject) throw new StaffAccountError(403, 'ACCOUNT_IDENTITY_CHANGED');
  },
  async list(scope: StaffScope, signal: AbortSignal): Promise<StaffInvitation[]> {
    const data = accountClosed(await json(`/api/v1/school/schools/${accountUuid(scope.schoolId)}/staff-invitations`, signal), ['data']).data;
    if (!Array.isArray(data) || data.length > 50) throw new StaffAccountError(503, 'ACCOUNT_RESPONSE_INVALID');
    const items = data.map(validateStaffInvitation);
    if (new Set(items.map(x => x.invitationId)).size !== items.length || items.some(x => x.schoolId !== scope.schoolId)) throw new StaffAccountError(503, 'ACCOUNT_RESPONSE_INVALID');
    return items;
  },
  async role(scope: StaffScope, id: string, signal: AbortSignal): Promise<CustomRoleSummary> {
    const root = accountClosed(await json(`/api/v1/organizations/${accountUuid(scope.organizationId)}/schools/${accountUuid(scope.schoolId)}/staff-roles/custom/${accountUuid(id)}`, signal), ['data', 'meta']);
    const r = accountClosed(root.data, ['id', 'code', 'name', 'schoolId', 'permissionCodes', 'version']);
    if (accountUuid(r.id) !== id || r.schoolId !== null && accountUuid(r.schoolId) !== scope.schoolId || typeof r.code !== 'string' || r.code.length > 55
      || typeof r.name !== 'string' || !r.name || r.name.length > 100 || !Array.isArray(r.permissionCodes) || !r.permissionCodes.length || r.permissionCodes.length > 500
      || r.permissionCodes.some(x => typeof x !== 'string' || x.length > 150) || !Number.isSafeInteger(r.version) || (r.version as number) < 1) throw new StaffAccountError(503, 'ACCOUNT_RESPONSE_INVALID');
    return r as unknown as CustomRoleSummary;
  },
  async command(command: StaffCommand, signal: AbortSignal) {
    const data = accountClosed(await json(command.path, signal, command), ['data']).data;
    const result = command.kind === 'accept' ? validateStaffAccountReceipt(data) : validateStaffInvitation(data);
    const body = JSON.parse(command.body) as Record<string, unknown>;
    if (command.kind === 'accept') { if (result.invitationId !== body.invitationId) throw new StaffAccountError(503, 'ACCOUNT_RESPONSE_INVALID'); }
    else {
      const invite = result as StaffInvitation;
      if (invite.schoolId !== body.schoolId || command.kind === 'invite' && (invite.email !== body.email || invite.roleId !== body.roleId || invite.status !== 'PENDING')
        || command.kind === 'revoke' && (invite.invitationId !== body.invitationId || invite.status !== 'REVOKED')) throw new StaffAccountError(503, 'ACCOUNT_RESPONSE_INVALID');
    }
    return result;
  },
};
export type StaffInvitationApi = typeof staffInvitationApi;
