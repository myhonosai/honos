import {
  validateFamilyReferralRewardInput, validatePublicFormSubmission, validateSchoolReferralProgramInput, verifyFamilyReferralRewardReceipt,
  verifyPublicReferral, verifySchoolReferralProgramReceipt, verifySchoolReferrals,
  type FamilyReferralRewardInput, type PublicFormResult, type PublicReferral, type SchoolReferral, type SchoolReferralProgram,
  type SchoolReferralProgramInput, type SchoolReferrals,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * 0604 family referrals in the browser (docs/architecture/FAMILY_REFERRALS.md). Staff: the browser names the signed-in school
 * only so the server can check it against the verified session; each change carries its own human-command marker and an
 * idempotency key kept for an exact Try again. Public: the code in the page address is the only key; no credentials.
 * Recording a reward moves no money or credit.
 */
export type ReferralErrorKind = 'SESSION' | 'DENIED' | 'INVALID' | 'VERSION' | 'FORM' | 'NOT_FOUND' | 'PENDING' | 'UNKNOWN';
export class ReferralError extends Error { constructor(readonly kind: ReferralErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type Scope = Readonly<{ organizationId: string; schoolId: string }>;
export const REFERRAL_COMMANDS = { program: 'crm.referrals.program.save', reward: 'crm.referrals.reward' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{16,100}$/;
const CODE = /^[0-9a-f]{16}$/;
const RESPONSE_MAX = 300_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || !Object.keys(value).every(k => keys.includes(k))) throw new Error('INVALID');
  return value as Record<string, unknown>;
}

export function referralErrorFor(status: number, code: string | null): ReferralError {
  if (status === 403) return new ReferralError('DENIED', code);
  if (status === 409 && code === 'VERSION_CONFLICT') return new ReferralError('VERSION', code);
  if (status === 422 && (code === 'REFERRAL_FORM_REQUIRED' || code === 'REFERRAL_FORM_UNAVAILABLE')) return new ReferralError('FORM', code);
  if (status === 422 && code === 'REFERRAL_NOT_FOUND') return new ReferralError('NOT_FOUND', code);
  if (status === 400 || (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED')) return new ReferralError('INVALID', code);
  return new ReferralError('UNKNOWN', code);
}
/** Only an unconfirmed outcome keeps the exact change for Try again. */
export const keepForRetry = (error: unknown) => !(error instanceof ReferralError) || error.kind === 'UNKNOWN' || error.kind === 'PENDING';

async function exchange(path: string, signal: AbortSignal, owned: Owned | null, command?: Readonly<{ body: string; name?: string; key?: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: owned ? 'same-origin' : 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json' } : {}),
        ...(command?.name ? { 'X-HON-Human-Command': command.name } : {}), ...(command?.key ? { 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new ReferralError('UNKNOWN'); }
  if (owned && r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ReferralError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  let text: string;
  try { text = await r.text(); } catch { throw new ReferralError('UNKNOWN'); }
  if (text.length > RESPONSE_MAX) throw new ReferralError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
function base(scope: Scope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new ReferralError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/marketing/referrals`;
}

export type ProgramSave = Readonly<{ input: SchoolReferralProgramInput; key: string }>;
export type RewardSave = Readonly<{ referralId: string; input: FamilyReferralRewardInput; key: string }>;
export const schoolReferralsApi = {
  async read(scope: Scope, signal: AbortSignal, owned: Owned): Promise<SchoolReferrals> {
    const { status, value } = await exchange(base(scope), signal, owned);
    if (status !== 200) throw referralErrorFor(status, codeOf(value));
    try { const body = exact(value, ['data', 'meta']); return verifySchoolReferrals(body.data); } catch { throw new ReferralError('UNKNOWN'); }
  },
  prepareProgram(input: unknown, key: string): ProgramSave {
    try { if (!KEY.test(key)) throw new Error('key'); return { input: validateSchoolReferralProgramInput(input), key }; } catch { throw new ReferralError('INVALID'); }
  },
  async saveProgram(scope: Scope, save: ProgramSave, signal: AbortSignal, owned: Owned): Promise<{ program: SchoolReferralProgram; replayed: boolean }> {
    const { status, value } = await exchange(`${base(scope)}/program`, signal, owned, { body: JSON.stringify(save.input), name: REFERRAL_COMMANDS.program, key: save.key });
    if (status !== 200) throw referralErrorFor(status, codeOf(value));
    try {
      const body = exact(value, ['data', 'meta']), meta = exact(body.meta, ['requestId', 'replayed']);
      if (typeof meta.replayed !== 'boolean') throw new Error('meta');
      const { program } = verifySchoolReferralProgramReceipt({ program: body.data, replayed: meta.replayed });
      return { program, replayed: meta.replayed };
    } catch { throw new ReferralError('UNKNOWN'); }
  },
  prepareReward(referralId: string, input: unknown, key: string): RewardSave {
    try {
      if (!UUID.test(referralId) || !KEY.test(key)) throw new Error('id');
      return { referralId: referralId.toLowerCase(), input: validateFamilyReferralRewardInput(input), key };
    } catch { throw new ReferralError('INVALID'); }
  },
  async saveReward(scope: Scope, save: RewardSave, signal: AbortSignal, owned: Owned): Promise<{ referral: SchoolReferral; replayed: boolean }> {
    const { status, value } = await exchange(`${base(scope)}/${save.referralId}/reward`, signal, owned, { body: JSON.stringify(save.input), name: REFERRAL_COMMANDS.reward, key: save.key });
    if (status !== 200) throw referralErrorFor(status, codeOf(value));
    try {
      const body = exact(value, ['data', 'meta']), meta = exact(body.meta, ['requestId', 'replayed']);
      if (typeof meta.replayed !== 'boolean') throw new Error('meta');
      const { referral } = verifyFamilyReferralRewardReceipt({ referral: body.data, replayed: meta.replayed });
      if (referral.referralId !== save.referralId) throw new Error('mismatch');
      return { referral, replayed: meta.replayed };
    } catch { throw new ReferralError('UNKNOWN'); }
  },
};
export type SchoolReferralsApi = typeof schoolReferralsApi;

export type PublicReferralRead = PublicReferral | 'GONE' | 'UNAVAILABLE';
export const publicReferralApi = {
  async read(code: string, signal: AbortSignal): Promise<PublicReferralRead> {
    if (!CODE.test(code)) return 'GONE';
    let answer;
    try { answer = await exchange(`/api/v1/public/referrals/${code}`, signal, null); } catch (error) { if (signal.aborted) throw error; return 'UNAVAILABLE'; }
    if (answer.status === 404 || answer.status === 400) return 'GONE';
    if (answer.status !== 200) return 'UNAVAILABLE';
    try { return verifyPublicReferral(exact(answer.value, ['data']).data); } catch { return 'UNAVAILABLE'; }
  },
  async submit(code: string, input: object, key: string, signal: AbortSignal): Promise<PublicFormResult> {
    if (!CODE.test(code) || !KEY.test(key)) return 'invalid';
    try { validatePublicFormSubmission(input); if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 8192) return 'invalid'; } catch { return 'invalid'; }
    let answer;
    try { answer = await exchange(`/api/v1/public/referrals/${code}/submissions`, signal, null, { body: JSON.stringify(input), key }); } catch { return 'unavailable'; }
    const result = (answer.value as { result?: unknown } | null)?.result;
    if (answer.status === 202 && result === 'accepted') return 'accepted';
    if (answer.status === 400 && result === 'invalid') return 'invalid';
    if (answer.status === 429 && result === 'rate-limited') return 'rate-limited';
    return 'unavailable';
  },
};
export type PublicReferralApi = typeof publicReferralApi;
