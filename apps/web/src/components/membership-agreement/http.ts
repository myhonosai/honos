import {
  MEMBERSHIP_AGREEMENT_BLOCKERS, MEMBERSHIP_AGREEMENT_CARD_READ_COMMAND, MEMBERSHIP_AGREEMENT_SEND_COMMAND, MEMBERSHIP_AGREEMENT_SEND_CONFIRMATION,
  MEMBERSHIP_AGREEMENT_TEMPLATE_READ_COMMAND, MEMBERSHIP_AGREEMENT_TEMPLATE_SAVE_COMMAND, MEMBERSHIP_AGREEMENT_TOKEN, validateSaveMembershipAgreementInput,
  validateSendMembershipAgreementInput, validateSignMembershipAgreementInput, verifyMembershipAgreementCard, verifyMembershipAgreementLink,
  verifyMembershipAgreementTemplate, verifySentMembershipAgreement, type MembershipAgreementBlocker, type MembershipAgreementCard, type MembershipAgreementLink,
  type MembershipAgreementTemplate, type SaveMembershipAgreementInput, type SentMembershipAgreement, type SignMembershipAgreementInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * The digital membership agreement (0410). Staff calls carry the verified session; the server decides every rule. The family's
 * signing link carries only the random token, sends no cookies and is never cached.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type SchoolScope = Readonly<{ organizationId: string; schoolId: string }>;
export type AgreementProblem = 'BLOCKED' | 'STALE' | 'DENIED' | 'SESSION' | 'REFUSED' | 'UNKNOWN' | 'NOT_FOUND';
export class AgreementError extends Error {
  constructor(readonly problem: AgreementProblem, readonly status: number, readonly blockers: readonly MembershipAgreementBlocker[] = []) { super(problem); }
}
/** The exact request, kept so an unknown outcome can be retried as the same request (it never makes two). */
export type AgreementRequest = Readonly<{ kind: 'SAVE' | 'SEND'; path: string; body: string; key: string; token: string | null }>;

function invalid(): never { throw new Error('Unverified membership agreement response.'); }
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid();
  return value as Record<string, unknown>;
}
export function billingPath(s: SchoolScope): string { return `/api/v1/organizations/${uuid(s.organizationId)}/schools/${uuid(s.schoolId)}/billing`; }
const staffFetch = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
const knownBlockers = new Set<string>(MEMBERSHIP_AGREEMENT_BLOCKERS);

async function refusal(response: Response): Promise<never> {
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new AgreementError('SESSION', 401); }
  let code = '', blockers: MembershipAgreementBlocker[] = [];
  try {
    const raw = await response.text();
    if (raw.length < 4000) {
      const e = JSON.parse(raw);
      if (typeof e?.code === 'string') code = e.code;
      if (Array.isArray(e?.blockers)) blockers = e.blockers.filter((b: unknown) => typeof b === 'string' && knownBlockers.has(b));
    }
  } catch { /* Never show raw backend text. */ }
  if (response.status === 403) throw new AgreementError('DENIED', 403);
  if (response.status === 404) throw new AgreementError('NOT_FOUND', 404);
  if (code === 'MEMBERSHIP_AGREEMENT_BLOCKED') throw new AgreementError('BLOCKED', response.status, blockers);
  if (code === 'MEMBERSHIP_AGREEMENT_STALE') throw new AgreementError('STALE', response.status);
  if ([400, 405, 409, 413, 415, 422].includes(response.status)) throw new AgreementError('REFUSED', response.status);
  throw new AgreementError('UNKNOWN', response.status);
}
async function envelope(response: Response, okStatus: readonly number[], metaKeys: string[]): Promise<{ data: unknown; meta: Record<string, unknown> }> {
  if (!okStatus.includes(response.status)) return refusal(response);
  if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '')) invalid();
  const raw = await response.text(); if (raw.length > 500_000) invalid();
  const e = closed(JSON.parse(raw), ['data', 'meta']), meta = closed(e.meta, metaKeys);
  uuid(meta.requestId);
  return { data: e.data, meta };
}
const get = (path: string, command: string, signal?: AbortSignal) => {
  const timeout = AbortSignal.timeout(15_000);
  return fetch(path, { ...staffFetch, method: 'GET', headers: { Accept: 'application/json', 'X-HON-Human-Command': command },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
};

export async function readAgreementTemplate(scope: SchoolScope, signal?: AbortSignal): Promise<MembershipAgreementTemplate> {
  const { data } = await envelope(await get(`${billingPath(scope)}/membership-agreement`, MEMBERSHIP_AGREEMENT_TEMPLATE_READ_COMMAND, signal), [200], ['requestId']);
  return verifyMembershipAgreementTemplate(data);
}
export async function readAgreementCard(scope: SchoolScope, membershipId: string, signal?: AbortSignal): Promise<MembershipAgreementCard> {
  const id = uuid(membershipId);
  const { data } = await envelope(await get(`${billingPath(scope)}/memberships/${id}/agreement`, MEMBERSHIP_AGREEMENT_CARD_READ_COMMAND, signal), [200], ['requestId']);
  return verifyMembershipAgreementCard(data, id);
}

/** 32 random bytes as 43 base64url characters, made in this browser. The server keeps only its SHA-256. */
export function newSigningToken(random: (bytes: Uint8Array) => Uint8Array = b => globalThis.crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(32));
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (!MEMBERSHIP_AGREEMENT_TOKEN.test(token)) invalid();
  return token;
}
/** The family's link for a token this browser made. */
export function signingUrl(origin: string, token: string): string {
  if (!MEMBERSHIP_AGREEMENT_TOKEN.test(token)) invalid();
  return `${origin.replace(/\/+$/, '')}/agreement/${token}`;
}

export function prepareAgreementSave(scope: SchoolScope, input: SaveMembershipAgreementInput, key: string): AgreementRequest {
  const body = validateSaveMembershipAgreementInput(input);
  return Object.freeze({ kind: 'SAVE', path: `${billingPath(scope)}/membership-agreement`, body: JSON.stringify(body), key: uuid(key), token: null });
}
export function prepareAgreementSend(scope: SchoolScope, membershipId: string, signerPersonId: string, token: string, key: string): AgreementRequest {
  const id = uuid(membershipId);
  validateSendMembershipAgreementInput({ membershipId: id, signerPersonId, token, confirmation: MEMBERSHIP_AGREEMENT_SEND_CONFIRMATION });
  return Object.freeze({ kind: 'SEND', path: `${billingPath(scope)}/memberships/${id}/agreement/send`,
    body: JSON.stringify({ signerPersonId: uuid(signerPersonId), token, confirmation: MEMBERSHIP_AGREEMENT_SEND_CONFIRMATION }), key: uuid(key), token });
}

async function post(request: AgreementRequest, command: string): Promise<{ data: unknown; replayed: boolean }> {
  try {
    const { data, meta } = await envelope(await fetch(request.path, {
      ...staffFetch, method: 'POST', body: request.body, signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': command, 'Idempotency-Key': request.key },
    }), [200, 201], ['requestId', 'replayed']);
    if (typeof meta.replayed !== 'boolean') invalid();
    return { data, replayed: meta.replayed };
  } catch (error) {
    if (error instanceof AgreementError) throw error;
    throw new AgreementError('UNKNOWN', 0);
  }
}
export async function sendAgreementSave(request: AgreementRequest): Promise<MembershipAgreementTemplate> {
  closed(request, ['kind', 'path', 'body', 'key', 'token']);
  if (request.kind !== 'SAVE' || !/^\/api\/v1\/organizations\/[^/]+\/schools\/[^/]+\/billing\/membership-agreement$/.test(request.path)) invalid();
  const input = validateSaveMembershipAgreementInput(JSON.parse(request.body));
  const { data } = await post(request, MEMBERSHIP_AGREEMENT_TEMPLATE_SAVE_COMMAND);
  let saved: MembershipAgreementTemplate;
  try { saved = verifyMembershipAgreementTemplate(data); } catch { throw new AgreementError('UNKNOWN', 0); }
  const texts = (saved.texts ?? {}) as Record<string, { title: string; body: string }>;
  if (saved.signatureRequired !== input.signatureRequired || Object.keys(texts).length !== Object.keys(input.texts).length
    || Object.entries(input.texts).some(([k, v]) => texts[k]?.title !== v.title || texts[k]?.body !== v.body)) throw new AgreementError('UNKNOWN', 0);
  return saved;
}
export async function sendAgreementLink(request: AgreementRequest): Promise<SentMembershipAgreement> {
  closed(request, ['kind', 'path', 'body', 'key', 'token']);
  const match = /^\/api\/v1\/organizations\/[^/]+\/schools\/[^/]+\/billing\/memberships\/([^/]+)\/agreement\/send$/.exec(request.path);
  if (request.kind !== 'SEND' || !match) invalid();
  const input = validateSendMembershipAgreementInput({ ...JSON.parse(request.body), membershipId: uuid(match[1]) });
  const { data } = await post(request, MEMBERSHIP_AGREEMENT_SEND_COMMAND);
  try { return verifySentMembershipAgreement(data, input); } catch { throw new AgreementError('UNKNOWN', 0); }
}

// ---- The family's signing link (no account, no cookies). ----
export type SignResult = 'signed' | 'invalid' | 'gone' | 'unavailable';
const publicFetch = { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
export async function readSigningLink(token: string, signal?: AbortSignal): Promise<MembershipAgreementLink | 'gone'> {
  if (!MEMBERSHIP_AGREEMENT_TOKEN.test(token)) return 'gone';
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(`/api/v1/public/agreements/${token}`, { ...publicFetch, method: 'GET', headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (response.status === 404) return 'gone';
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const raw = await response.text(); if (raw.length > 300_000) invalid();
  return verifyMembershipAgreementLink(closed(JSON.parse(raw), ['data']).data);
}
export async function signAgreement(token: string, input: SignMembershipAgreementInput): Promise<SignResult> {
  if (!MEMBERSHIP_AGREEMENT_TOKEN.test(token)) return 'gone';
  const body = JSON.stringify(validateSignMembershipAgreementInput(input));
  try {
    const response = await fetch(`/api/v1/public/agreements/${token}/signature`, { ...publicFetch, method: 'POST', body, signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    const raw = await response.text();
    const result = raw.length < 200 ? (JSON.parse(raw) as { result?: unknown }).result : undefined;
    if (response.status === 201 && result === 'signed') return 'signed';
    if (response.status === 400 && result === 'invalid') return 'invalid';
    if (response.status === 410 && result === 'gone') return 'gone';
    return 'unavailable';
  } catch { return 'unavailable'; }
}
