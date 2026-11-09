import { accountClosed, saasUuid, validateSaasSchoolBillingAccount, validateSaasSchoolAccessStanding, validateSaasCreativeSchoolWallet,
  type SaasSchoolBillingAccount, type SaasCreativeSchoolWallet } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

export type AccountScope = Readonly<{ organizationId?: string; schoolId: string }>;
export type AccountView = Pick<SaasSchoolBillingAccount, 'schoolId' | 'organizationId' | 'organizationName' | 'billingScope' | 'asOf'> & {
  entitlement: Pick<NonNullable<SaasSchoolBillingAccount['entitlement']>, 'status' | 'inEffect' | 'effectiveFrom' | 'effectiveUntil'> | null;
  access: Pick<SaasSchoolBillingAccount['access'], 'state' | 'activation' | 'alignment' | 'paidAccessProgram'>;
  subscription: Pick<NonNullable<SaasSchoolBillingAccount['subscription']>, 'source' | 'status' | 'billingInterval' | 'serviceStartedAt' | 'currentPeriod'> | null;
  payment: Pick<SaasSchoolBillingAccount['payment'], 'status' | 'verification' | 'paidThroughAt' | 'providerVerification'>;
};
export type WalletView = Pick<SaasCreativeSchoolWallet, 'schoolId' | 'eligibility'> & {
  programStatus: SaasCreativeSchoolWallet['program']['status']; balance: Omit<SaasCreativeSchoolWallet['balance'], 'byKind'> & {
    byKind: Pick<SaasCreativeSchoolWallet['balance']['byKind'][number], 'kind' | 'grantedCredits' | 'availableCredits' | 'heldCredits' | 'consumedCredits'>[] };
};
export class AccountStatusError extends Error {
  constructor(readonly kind: 'SESSION' | 'IDENTITY' | 'DENIED' | 'UNAVAILABLE' | 'INPUT') { super(kind); }
}
export function accountScope(input: AccountScope): AccountScope {
  try { return Object.freeze({ schoolId: saasUuid(input.schoolId).toLowerCase(), ...(input.organizationId === undefined ? {} : { organizationId: saasUuid(input.organizationId).toLowerCase() }) }); }
  catch { throw new AccountStatusError('INPUT'); }
}
/** Fixed read-only routes. No supplied actor, permission, Origin or command header. */
async function read(path: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  signal.throwIfAborted();
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new AccountStatusError('SESSION'); }
  if (response.status === 403) throw new AccountStatusError('DENIED');
  if (response.status !== 200 || response.redirected || response.url && (typeof location === 'undefined' || response.url !== new URL(path, location.origin).href)
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || !response.headers.get('cache-control')?.split(',').some(value => value.trim().toLowerCase() === 'no-store') || !response.body) throw new AccountStatusError('UNAVAILABLE');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0, text = '';
  try {
    while (true) { signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 524288) throw new AccountStatusError('UNAVAILABLE'); text += decoder.decode(chunk.value, { stream: true }); }
    return accountClosed(JSON.parse(text + decoder.decode()) as unknown, ['data']).data;
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
export const accountStatusApi = {
  async identity(subject: string, signal: AbortSignal): Promise<void> {
    const data = await read('/api/identity/me', signal);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('externalSubject' in data) || typeof data.externalSubject !== 'string'
      || Object.keys(data).some(key => !['externalSubject', 'displayName', 'email'].includes(key))) throw new AccountStatusError('UNAVAILABLE');
    if (!subject || data.externalSubject !== subject) throw new AccountStatusError('IDENTITY');
  },
  async account(input: AccountScope, signal: AbortSignal): Promise<AccountView> {
    const scope = accountScope(input), data = validateSaasSchoolBillingAccount(await read(`/api/v1/schools/${scope.schoolId}/hon-billing`, signal));
    if (data.schoolId !== scope.schoolId || scope.organizationId !== undefined && data.organizationId !== scope.organizationId) throw new AccountStatusError('UNAVAILABLE');
    const { schoolId, organizationId, organizationName, billingScope, asOf } = data;
    const { state, activation, alignment, paidAccessProgram } = data.access;
    const { status, verification, paidThroughAt, providerVerification } = data.payment;
    return { schoolId, organizationId, organizationName, billingScope, asOf,
      entitlement: data.entitlement && { status: data.entitlement.status, inEffect: data.entitlement.inEffect, effectiveFrom: data.entitlement.effectiveFrom, effectiveUntil: data.entitlement.effectiveUntil },
      access: { state, activation, alignment, paidAccessProgram },
      subscription: data.subscription && { source: data.subscription.source, status: data.subscription.status, billingInterval: data.subscription.billingInterval,
        serviceStartedAt: data.subscription.serviceStartedAt, currentPeriod: data.subscription.currentPeriod },
      payment: { status, verification, paidThroughAt, providerVerification } };
  },
  async standing(input: AccountScope, signal: AbortSignal) {
    const scope = accountScope(input), data = validateSaasSchoolAccessStanding(await read(`/api/v1/schools/${scope.schoolId}/hon-billing/access-standing`, signal));
    if (data.schoolId !== scope.schoolId || scope.organizationId !== undefined && data.organizationId !== scope.organizationId) throw new AccountStatusError('UNAVAILABLE');
    return data;
  },
  async wallet(input: AccountScope, signal: AbortSignal): Promise<WalletView> {
    const data = await readSchoolCreativeWallet(input, signal);
    return { schoolId: data.schoolId, programStatus: data.program.status, eligibility: data.eligibility,
      balance: { availableCredits: data.balance.availableCredits, heldCredits: data.balance.heldCredits,
        byKind: data.balance.byKind.map(({ kind, grantedCredits, availableCredits, heldCredits, consumedCredits }) => ({ kind, grantedCredits, availableCredits, heldCredits, consumedCredits })) } };
  },
};
export type AccountStatusApi = typeof accountStatusApi;

/** The school's own creative wallet (GET only). The server authorizes the exact school; the response must name it. */
export async function readSchoolCreativeWallet(input: AccountScope, signal: AbortSignal): Promise<SaasCreativeSchoolWallet> {
  const scope = accountScope(input), data = validateSaasCreativeSchoolWallet(await read(`/api/v1/schools/${scope.schoolId}/creative-credits`, signal));
  // This school projection has no organization field. It cannot verify the organization selector.
  if (data.schoolId !== scope.schoolId) throw new AccountStatusError('UNAVAILABLE');
  return data;
}
