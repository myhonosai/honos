import {
  accountUuid, FAMILY_ACCOUNT_HUMAN_COMMAND, validateFamilyAccessInvitationInput,
  validateFamilyAccessInvitationRevoke, validateFamilyAccessEnd, validateFamilyAccessInvitationAcceptance,
  validateFamilyAccessInvitation, validateFamilyAccountReceipt,
  type FamilyAccessInvitation, type FamilyAccountReceipt, type FamilySummary,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

export type FamilyScope = Readonly<{ organizationId: string; schoolId: string }>;
export type FamilyCommandKind = 'invite' | 'revoke' | 'end' | 'accept';
export type FamilyCommand = Readonly<{ kind: FamilyCommandKind; path: string; body: string; key: string }>;
export type FamilyResult = FamilyAccessInvitation | FamilyAccountReceipt;
export class FamilyAccessError extends Error {
  constructor(readonly kind: 'SESSION' | 'IDENTITY' | 'DENIED' | 'REJECTED' | 'READ' | 'UNKNOWN' | 'NOT_SUBMITTED', readonly code: string = 'ACCOUNT_UNAVAILABLE') { super(code); }
}
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}
export function familyScope(value: FamilyScope): FamilyScope { return Object.freeze({ organizationId: accountUuid(value.organizationId), schoolId: accountUuid(value.schoolId) }); }
export function familyCommand(kind: FamilyCommandKind, input: unknown, key: string): FamilyCommand {
  if (!['invite', 'revoke', 'end', 'accept'].includes(kind)) throw new Error('ACCOUNT_INPUT_INVALID');
  const normalized = kind === 'invite' ? validateFamilyAccessInvitationInput(input) : kind === 'revoke' ? validateFamilyAccessInvitationRevoke(input)
    : kind === 'end' ? validateFamilyAccessEnd(input) : validateFamilyAccessInvitationAcceptance(input);
  const path = kind === 'accept' ? '/api/v1/account/family-access-invitations/accept' : `/api/v1/school/family-access-invitations${kind === 'invite' ? '' : '/' + kind}`;
  return Object.freeze({ kind, path, body: JSON.stringify(normalized), key: accountUuid(key) });
}
const codes = new Set(['ACCOUNT_INPUT_INVALID', 'ACCOUNT_FORBIDDEN', 'VERIFIED_EMAIL_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_REVIEW_REQUIRED', 'ACCOUNT_CONFLICT', 'ACCOUNT_RATE_LIMITED', 'ACCOUNT_BUSY', 'HUMAN_UI_REQUIRED', 'HUMAN_UI_ORIGIN_NOT_CONFIGURED']);
async function json(path: string, signal: AbortSignal, command?: FamilyCommand, echo = true, reportCurrent = () => true): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': FAMILY_ACCOUNT_HUMAN_COMMAND, 'Idempotency-Key': command.key } : {}) }, ...(command ? { body: command.body } : {}) });
  // Retired reads cannot invalidate a replacement session. Commands are never
  // aborted by privacy concealment: their original request must settle safely.
  signal.throwIfAborted();
  if (response.status === 401) { if (reportCurrent()) reportConfirmedSessionInvalidation(); throw new FamilyAccessError('SESSION'); }
  if (response.redirected || response.url && (typeof location === 'undefined' || response.url !== new URL(path, location.origin).href)
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || echo && !response.headers.get('cache-control')?.split(',').map(x => x.trim()).includes('no-store') || !response.body) throw new FamilyAccessError(response.status === 403 ? 'DENIED' : command ? 'UNKNOWN' : 'READ');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  let text = '', size = 0;
  try {
    while (true) { signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > 262144) throw new Error('ACCOUNT_RESPONSE_INVALID'); text += decoder.decode(chunk.value, { stream: true }); }
    const data: unknown = JSON.parse(text + decoder.decode());
    if (response.status !== 200) {
      const error = data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' && codes.has(data.code) ? data.code : 'ACCOUNT_UNAVAILABLE';
      const outcome = data && typeof data === 'object' && 'outcome' in data ? data.outcome : undefined;
      if (response.status === 403) throw new FamilyAccessError('DENIED', error);
      if (command && ([429, 503].includes(response.status)) && outcome === 'NOT_SUBMITTED') throw new FamilyAccessError('NOT_SUBMITTED', error);
      if ([400, 404, 409, 429].includes(response.status)) throw new FamilyAccessError('REJECTED', error);
      throw new FamilyAccessError(command ? 'UNKNOWN' : 'READ', error);
    }
    return data;
  } catch (error) {
    if (response.status === 403 && !(error instanceof FamilyAccessError)) throw new FamilyAccessError('DENIED');
    throw error;
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
function families(value: unknown): FamilySummary[] {
  const root = exact(value, ['data', 'meta']); exact(root.meta, ['requestId', 'correlationId']);
  if (!Array.isArray(root.data) || root.data.length > 100) throw new Error('ACCOUNT_RESPONSE_INVALID');
  const seen = new Set<string>();
  return root.data.map(value => {
    const r = exact(value, ['id', 'displayName', 'status', 'version', 'memberCount', 'createdAt']); const id = accountUuid(r.id);
    if (seen.has(id) || typeof r.displayName !== 'string' || !r.displayName.trim() || r.displayName.length > 200 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(r.displayName)
      || !['ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(String(r.status)) || !Number.isSafeInteger(r.version) || Number(r.version) < 1
      || !Number.isSafeInteger(r.memberCount) || Number(r.memberCount) < 0 || typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt))) throw new Error('ACCOUNT_RESPONSE_INVALID');
    seen.add(id); return { ...r, id } as unknown as FamilySummary;
  });
}
export const familyAccessApi = {
  async identity(subject: string, signal: AbortSignal): Promise<void> {
    const data = exact(await json('/api/identity/me', signal), ['data']).data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['externalSubject', 'displayName', 'email'].includes(k)) || !('externalSubject' in data) || data.externalSubject !== subject) throw new FamilyAccessError('IDENTITY');
  },
  async load(scope: FamilyScope, signal: AbortSignal): Promise<{ families: FamilySummary[]; invitations: FamilyAccessInvitation[] }> {
    const s = familyScope(scope);
    const list = families(await json(`/api/v1/organizations/${s.organizationId}/schools/${s.schoolId}/families`, signal, undefined, false));
    // Dedicated current manager/entitlement check follows the legacy family read.
    const raw = exact(await json(`/api/v1/school/schools/${s.schoolId}/family-access-invitations`, signal), ['data']).data;
    if (!Array.isArray(raw) || raw.length > 50) throw new Error('ACCOUNT_RESPONSE_INVALID');
    const invitations = raw.map(validateFamilyAccessInvitation); const ids = new Set(invitations.map(i => i.invitationId));
    if (ids.size !== invitations.length || invitations.some(i => i.schoolId !== s.schoolId)) throw new Error('ACCOUNT_RESPONSE_INVALID');
    return { families: list, invitations };
  },
  async send(command: FamilyCommand, reportCurrent = () => true): Promise<FamilyResult> {
    const expected = familyCommand(command.kind, JSON.parse(command.body), command.key);
    if (expected.path !== command.path || expected.body !== command.body || expected.key !== command.key) throw new FamilyAccessError('REJECTED', 'ACCOUNT_INPUT_INVALID');
    try {
      const result = exact(await json(command.path, AbortSignal.timeout(15000), command, true, reportCurrent), ['data']).data;
      const value = command.kind === 'accept' ? validateFamilyAccountReceipt(result) : validateFamilyAccessInvitation(result);
      const input = JSON.parse(command.body);
      if (command.kind === 'accept' ? value.invitationId !== input.invitationId : value.schoolId !== input.schoolId
        || command.kind !== 'invite' && value.invitationId !== input.invitationId) throw new Error('ACCOUNT_RESPONSE_INVALID');
      if (command.kind === 'invite') { const i = value as FamilyAccessInvitation; if (i.familyId !== input.familyId || i.accessLevel !== input.accessLevel || i.email !== input.email || i.status !== 'PENDING') throw new Error('ACCOUNT_RESPONSE_INVALID'); }
      if (command.kind === 'revoke' && (value as FamilyAccessInvitation).status !== 'REVOKED' || command.kind === 'end' && (value as FamilyAccessInvitation).status !== 'ENDED') throw new Error('ACCOUNT_RESPONSE_INVALID');
      return value;
    } catch (error) { if (error instanceof FamilyAccessError) throw error; throw new FamilyAccessError('UNKNOWN'); }
  },
};
export type FamilyAccessApi = typeof familyAccessApi;
