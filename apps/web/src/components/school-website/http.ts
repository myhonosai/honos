import {
  validateCreateSchoolWebsiteInput, validatePublishSchoolWebsiteInput, validateRollbackSchoolWebsiteInput, validateSaveSchoolWebsiteDraftInput,
  validateUnpublishSchoolWebsiteInput, verifyBookingTypes, verifySchoolWebsite, verifySchoolWebsiteRead,
  type SchoolWebsite, type SchoolWebsiteRead,
} from '@hon/contracts';
import { formStaffRequest } from '../public-form-client';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * School website workspace (WB2, 0361). The read is a plain same-origin GET; each command sends its own
 * X-HON-Human-Command and an Idempotency-Key. The server decides every permission. Nothing here is authority.
 */
export type WebsiteErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this person at this school, or no active subscription. Nothing changed. */ | 'DENIED'
  /** Someone changed the website first. Nothing changed. */ | 'STALE'
  /** The web address is taken. Nothing changed. */ | 'TAKEN'
  /** A form, booking page or campaign on the site is not live. Nothing was published. */ | 'NOT_LIVE'
  /** A form, booking page or campaign is not this school's. Nothing changed. */ | 'REFERENCE'
  /** The site is not published (unpublish) or the version does not exist (rollback). Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing changed. */ | 'INVALID'
  /** Busy, or the outcome is not known. Only the identical command (same key) may be sent again. */ | 'UNKNOWN';
export class WebsiteError extends Error { constructor(readonly kind: WebsiteErrorKind, readonly code: string | null = null) { super(kind); } }
export type WebsiteScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type WebsiteCommand = 'create' | 'save' | 'publish' | 'rollback' | 'unpublish';

const RESPONSE_MAX = 3_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATHS: Record<WebsiteCommand, string> = { create: '', save: '/draft', publish: '/publish', rollback: '/rollback', unpublish: '/unpublish' };
const VALIDATE: Record<WebsiteCommand, (v: unknown) => unknown> = {
  create: validateCreateSchoolWebsiteInput, save: validateSaveSchoolWebsiteDraftInput, publish: validatePublishSchoolWebsiteInput,
  rollback: validateRollbackSchoolWebsiteInput, unpublish: validateUnpublishSchoolWebsiteInput,
};
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

export function websiteBase(scope: WebsiteScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new WebsiteError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/website`;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new WebsiteError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new WebsiteError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
/** Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN and keeps the key. */
export function websiteErrorFor(status: number, code: string | null): WebsiteError {
  if (status === 403) return new WebsiteError('DENIED', code);
  if (status === 404) return new WebsiteError('GONE', code);
  if (status === 400 && code === 'SCHOOL_WEBSITE_REFERENCE_INVALID') return new WebsiteError('REFERENCE', code);
  if (status === 400) return new WebsiteError('INVALID', code);
  if (status === 409 && code === 'VERSION_CONFLICT') return new WebsiteError('STALE', code);
  if (status === 409 && code === 'SCHOOL_WEBSITE_ADDRESS_TAKEN') return new WebsiteError('TAKEN', code);
  if (status === 409 && code === 'SCHOOL_WEBSITE_REFERENCE_NOT_LIVE') return new WebsiteError('NOT_LIVE', code);
  if (status === 409 && (code === 'SCHOOL_WEBSITE_EXISTS' || code === 'SCHOOL_WEBSITE_NOT_PUBLISHED')) return new WebsiteError('STALE', code);
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new WebsiteError('INVALID', code);
  return new WebsiteError('UNKNOWN', code);
}
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}

export const websiteApi = {
  async read(scope: WebsiteScope, signal: AbortSignal, owned: Owned): Promise<SchoolWebsiteRead> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(websiteBase(scope), signal, owned); }
    catch (error) { if (error instanceof WebsiteError || signal.aborted) throw error; throw new WebsiteError('UNKNOWN'); }
    if (answer.status !== 200) throw websiteErrorFor(answer.status, codeOf(answer.value));
    try { return verifySchoolWebsiteRead(data(answer.value)); } catch { throw new WebsiteError('UNKNOWN'); }
  },
  async command(scope: WebsiteScope, command: WebsiteCommand, input: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolWebsite> {
    if (typeof key !== 'string' || !UUID.test(key)) throw new WebsiteError('INVALID');
    let body: string;
    try { body = JSON.stringify(VALIDATE[command](input)); } catch { throw new WebsiteError('INVALID'); }
    let answer: { status: number; value: unknown };
    try { answer = await exchange(websiteBase(scope) + PATHS[command], signal, owned, { name: `website.${command}`, body, key }); }
    catch (error) { if (error instanceof WebsiteError) throw error; throw new WebsiteError('UNKNOWN'); }
    if (answer.status !== 200) throw websiteErrorFor(answer.status, codeOf(answer.value));
    try { return verifySchoolWebsite(data(answer.value)); } catch { throw new WebsiteError('UNKNOWN'); }
  },
};
export type WebsiteApi = typeof websiteApi;

/** A failed command may be sent again with the same key only when its outcome is not known. */
export const keepForRetry = (error: unknown) => !(error instanceof WebsiteError) || error.kind === 'UNKNOWN';

/** What a form or booking section can point at: this school's published forms and active booking pages. */
export type WebsiteChoice = Readonly<{ id: string; label: string }>;
export type WebsiteChoices = Readonly<{ forms: WebsiteChoice[]; bookings: WebsiteChoice[] }>;
export async function loadWebsiteChoices(scope: WebsiteScope, signal: AbortSignal, owned: Owned): Promise<WebsiteChoices> {
  const forms: WebsiteChoice[] = [], bookings: WebsiteChoice[] = [];
  // Each list is optional help for the editor: if one cannot be read the owner still edits, and the server re-checks every reference.
  try {
    const list = await formStaffRequest('/api/v1/marketing/forms');
    if (Array.isArray(list)) for (const f of list) if (f.status === 'PUBLISHED') forms.push({ id: f.publicId, label: f.title });
  } catch { /* no published forms to offer */ }
  try {
    const path = websiteBase(scope).replace(/\/website$/, '/settings/booking-types');
    const answer = await exchange(path, signal, owned);
    if (answer.status === 200) for (const t of verifyBookingTypes(data(answer.value)).bookingTypes) if (t.status === 'ACTIVE') bookings.push({ id: t.publicId, label: t.name });
  } catch (error) { if (error instanceof WebsiteError && error.kind === 'SESSION') throw error; }
  return { forms, bookings };
}
