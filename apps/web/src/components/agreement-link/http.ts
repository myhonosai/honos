import {
  MEMBERSHIP_AGREEMENT_LINK_COMMAND, MEMBERSHIP_AGREEMENT_LINK_CONFIRMATION, MEMBERSHIP_AGREEMENT_LINK_SIGN_RESULTS, MEMBERSHIP_AGREEMENT_LINK_TOKEN,
  accountClosed, accountUuid, validateMembershipAgreementLinkSendInput, validateMembershipAgreementLinkSendResult, validateMembershipAgreementLinkSignInput,
  validateMembershipAgreementLinkView, validateMembershipAgreementSendRead,
  type MembershipAgreementLinkChannel, type MembershipAgreementLinkSendInput, type MembershipAgreementLinkSendResult, type MembershipAgreementLinkSignInput,
  type MembershipAgreementLinkSignResult, type MembershipAgreementLinkView, type MembershipAgreementSendRead,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * 0499 agreement signing link. Staff: the server decides authority from the verified session; the browser names the school
 * and the student and sends one closed body with the exact human-command marker and an idempotency key. The browser makes
 * the 43-character token (the server stores only its SHA-256) so the person who sent it can also copy the link once.
 * Family: no account; the token in the page address is the only key.
 */
export type LinkErrorKind = 'SESSION' | 'DENIED' | 'INVALID' | 'NOT_PUBLISHED' | 'NOTHING' | 'RECIPIENT' | 'BUSY' | 'ORIGIN' | 'UNKNOWN';
export class LinkError extends Error { constructor(readonly kind: LinkErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
const RESPONSE_MAX = 300_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const dataOf = (v: unknown) => accountClosed(v, ['data']).data;

export function linkErrorFor(status: number, code: string | null): LinkError {
  if (status === 403) return new LinkError('DENIED', code);
  if (status === 400 && code === 'MEMBERSHIP_AGREEMENT_NOT_PUBLISHED') return new LinkError('NOT_PUBLISHED', code);
  if (status === 400 && code === 'MEMBERSHIP_AGREEMENT_NOTHING_TO_SIGN') return new LinkError('NOTHING', code);
  if (status === 400 && code === 'MEMBERSHIP_AGREEMENT_RECIPIENT_NOT_ALLOWED') return new LinkError('RECIPIENT', code);
  if (status === 400 || status === 404) return new LinkError('INVALID', code);
  if (status === 409 && code === 'MEMBERSHIP_AGREEMENT_KEY_REUSED') return new LinkError('INVALID', code);
  if (status === 503 && code === 'MEMBERSHIP_AGREEMENT_BUSY') return new LinkError('BUSY', code);
  if (status === 503 && code === 'MEMBERSHIP_AGREEMENT_LINK_ORIGIN_NOT_CONFIGURED') return new LinkError('ORIGIN', code);
  return new LinkError('UNKNOWN', code);
}
/** Only an unknown outcome or a busy answer keeps the exact request for Try again. */
export const keepLinkForRetry = (error: unknown) => !(error instanceof LinkError) || error.kind === 'UNKNOWN' || error.kind === 'BUSY';

async function exchange(path: string, signal: AbortSignal, owned: Owned | null, command?: Readonly<{ body: string; key?: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: owned ? 'same-origin' : 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json' } : {}),
        ...(command?.key ? { 'X-HON-Human-Command': MEMBERSHIP_AGREEMENT_LINK_COMMAND, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new LinkError('UNKNOWN'); }
  if (signal.aborted && !command) signal.throwIfAborted();
  if (owned && r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new LinkError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  let text: string;
  try { text = await r.text(); } catch { throw new LinkError('UNKNOWN'); }
  if (text.length > RESPONSE_MAX) throw new LinkError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** 32 random bytes as base64url (43 characters). */
export function newLinkToken(random: (b: Uint8Array) => Uint8Array = b => globalThis.crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(32));
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** The family's page for a token, on this site. */
export const signingLinkUrl = (origin: string, token: string) => `${origin.replace(/\/$/, '')}/agreement/${token}`;

export type LinkSend = Readonly<{ input: MembershipAgreementLinkSendInput; key: string }>;
export const agreementLinkApi = {
  async read(schoolId: string, personId: string, signal: AbortSignal, owned: Owned): Promise<MembershipAgreementSendRead> {
    let path: string;
    try { path = `/api/v1/school/schools/${accountUuid(schoolId).toLowerCase()}/people/${accountUuid(personId).toLowerCase()}/membership-agreement-link`; } catch { throw new LinkError('INVALID'); }
    const { status, value } = await exchange(path, signal, owned);
    if (status !== 200) throw linkErrorFor(status, codeOf(value));
    try { return validateMembershipAgreementSendRead(dataOf(value)); } catch { throw new LinkError('UNKNOWN'); }
  },
  /** The closed send request, made once and kept for an exact Try again. */
  prepare(schoolId: string, personId: string, recipientPersonId: string, channels: readonly MembershipAgreementLinkChannel[], token: string, key: string): LinkSend {
    try {
      return { input: validateMembershipAgreementLinkSendInput({ schoolId, personId, recipientPersonId, channels: [...channels], token, confirmation: MEMBERSHIP_AGREEMENT_LINK_CONFIRMATION }),
        key: accountUuid(key) };
    } catch { throw new LinkError('INVALID'); }
  },
  async send(request: LinkSend, signal: AbortSignal, owned: Owned): Promise<MembershipAgreementLinkSendResult> {
    const { status, value } = await exchange('/api/v1/school/membership-agreement-link/send', signal, owned, { body: JSON.stringify(request.input), key: request.key });
    if (status !== 200) throw linkErrorFor(status, codeOf(value));
    try {
      const out = validateMembershipAgreementLinkSendResult(dataOf(value));
      if (out.link.recipientPersonId !== request.input.recipientPersonId.toLowerCase() || [...out.deliveries.map(d => d.channel)].sort().join() !== [...request.input.channels].sort().join()) throw new Error('mismatch');
      return out;
    } catch { throw new LinkError('UNKNOWN'); }
  },
};
export type AgreementLinkApi = typeof agreementLinkApi;

export type PublicLinkRead = MembershipAgreementLinkView | 'GONE' | 'UNAVAILABLE';
export type PublicLinkSign = MembershipAgreementLinkSignResult | 'UNAVAILABLE';
export const publicAgreementLinkApi = {
  async read(token: string, signal: AbortSignal): Promise<PublicLinkRead> {
    if (!MEMBERSHIP_AGREEMENT_LINK_TOKEN.test(token)) return 'GONE';
    let answer;
    try { answer = await exchange(`/api/v1/public/membership-agreement-links/${token}`, signal, null); } catch (error) { if (signal.aborted) throw error; return 'UNAVAILABLE'; }
    if (answer.status === 404 || answer.status === 400) return 'GONE';
    if (answer.status !== 200) return 'UNAVAILABLE';
    try { return validateMembershipAgreementLinkView(dataOf(answer.value)); } catch { return 'UNAVAILABLE'; }
  },
  async sign(token: string, input: MembershipAgreementLinkSignInput, signal: AbortSignal): Promise<PublicLinkSign> {
    if (!MEMBERSHIP_AGREEMENT_LINK_TOKEN.test(token)) return 'GONE';
    let body: MembershipAgreementLinkSignInput;
    try { body = validateMembershipAgreementLinkSignInput(input); } catch { return 'INVALID'; }
    let answer;
    try { answer = await exchange(`/api/v1/public/membership-agreement-links/${token}/sign`, signal, null, { body: JSON.stringify(body) }); } catch { return 'UNAVAILABLE'; }
    const result = (answer.value as { result?: unknown } | null)?.result;
    return typeof result === 'string' && (MEMBERSHIP_AGREEMENT_LINK_SIGN_RESULTS as readonly string[]).includes(result) && result !== 'INVALID'
      ? result as MembershipAgreementLinkSignResult : answer.status === 400 ? 'INVALID' : 'UNAVAILABLE';
  },
};
export type PublicAgreementLinkApi = typeof publicAgreementLinkApi;
