import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import { normalizePhone } from '../leads/add-lead-http';

/**
 * Add contact (owner, 2026-11-27): one short form on Contacts that adds a child student (owner, 2026-11-28: the student is
 * the main contact, the parent or guardian is optional), or one adult.
 * It sends only the school's existing human commands, in order: create person, create family, add family member.
 * The API derives the staff member, the school and every permission from the signed session; the ids here are
 * selectors. Each step has its own Idempotency-Key made on the button press, so "Try again" replays the same steps
 * and can never add anyone twice.
 */
export type ContactScope = Readonly<{ organizationId: string; schoolId: string }>;
export type ContactKind = 'FAMILY' | 'ADULT';
export type ContactForm = Readonly<{
  kind: ContactKind; givenName: string; familyName: string; email: string; phone: string;
  childGivenName: string; childFamilyName: string; adultStudent: boolean; consent: boolean;
}>;
export type ContactProblem = 'nameMissing' | 'parentNameMissing' | 'childNameMissing' | 'emailInvalid' | 'phoneInvalid';
type PersonBody = Readonly<{ givenName: string; familyName: string; email?: string; phoneE164?: string; consentChannels?: readonly [] }>;
/** `adult` is the parent or guardian (optional with a child) or the one adult; `label` names the main contact (the student when there is one). */
export type ContactPlan = Readonly<{
  adult: PersonBody | null; child: PersonBody | null; familyName: string | null; adultRole: 'GUARDIAN' | 'STUDENT' | null; label: string;
}>;
/** The five keys of one press. A step the plan does not need never uses its key. */
export type ContactKeys = Readonly<{ adult: string; child: string; family: string; adultMember: string; childMember: string }>;
export type ContactCapsule = Readonly<{ organizationId: string; schoolId: string; plan: ContactPlan; keys: ContactKeys; form: ContactForm }>;
export type ContactStep = 'adult' | 'child' | 'family' | 'adultMember' | 'childMember';
/** `mainId` is the contact to open: the student when one was added, otherwise the adult. */
export type ContactAdded = Readonly<{ adultId: string | null; childId: string | null; familyId: string | null; mainId: string }>;
export type ContactErrorKind = 'SESSION' | 'DENIED' | 'REJECTED' | 'UNKNOWN';
/** `step` is the step that did not finish; every step before it is saved. */
export class AddContactError extends Error {
  constructor(readonly kind: ContactErrorKind, readonly step: ContactStep) { super(`ADD_CONTACT_${kind}`); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const NAME_MAX = 120;

/** Turns the typed form into the exact plan. A child never carries a contact address or a consent record. */
export function buildContactPlan(form: ContactForm): { ok: true; plan: ContactPlan } | { ok: false; problem: ContactProblem } {
  const givenName = form.givenName.trim(), familyName = form.familyName.trim(), email = form.email.trim().toLowerCase(), phone = form.phone.trim();
  const family = form.kind === 'FAMILY';
  // With a child the parent or guardian is optional: an untouched parent section adds no adult.
  const hasAdult = !family || Boolean(givenName || familyName || email || phone);
  let adult: PersonBody | null = null;
  if (hasAdult) {
    if (!givenName || !familyName || givenName.length > NAME_MAX || familyName.length > NAME_MAX) return { ok: false, problem: family ? 'parentNameMissing' : 'nameMissing' };
    if (email && (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { ok: false, problem: 'emailInvalid' };
    const phoneE164 = phone ? normalizePhone(phone) : null;
    if (phone && !phoneE164) return { ok: false, problem: 'phoneInvalid' };
    adult = { givenName, familyName, ...(email ? { email } : {}), ...(phoneE164 ? { phoneE164 } : {}), ...(form.consent ? {} : { consentChannels: [] as const }) };
  }
  if (!family) {
    return { ok: true, plan: { adult, child: null, familyName: form.adultStudent ? `${familyName} family` : null, adultRole: form.adultStudent ? 'STUDENT' : null, label: `${givenName} ${familyName}` } };
  }
  const childGivenName = form.childGivenName.trim(), childFamilyName = form.childFamilyName.trim() || familyName;
  if (!childGivenName || !childFamilyName || childGivenName.length > NAME_MAX || childFamilyName.length > NAME_MAX) return { ok: false, problem: 'childNameMissing' };
  return { ok: true, plan: { adult, child: { givenName: childGivenName, familyName: childFamilyName, consentChannels: [] as const },
    familyName: `${childFamilyName} family`, adultRole: adult ? 'GUARDIAN' : null, label: `${childGivenName} ${childFamilyName}` } };
}

/** The first command of a plan: a refusal there means nothing was saved. */
export const firstContactStep = (plan: ContactPlan): ContactStep => plan.child ? 'child' : 'adult';

export function prepareContact(scope: ContactScope, plan: ContactPlan, form: ContactForm, key: () => string): ContactCapsule {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new Error('A verified school is required.');
  const keys = { adult: key(), child: key(), family: key(), adultMember: key(), childMember: key() };
  if (Object.values(keys).some(k => !UUID.test(k)) || new Set(Object.values(keys)).size !== 5) throw new Error('Five fresh idempotency keys are required.');
  return Object.freeze({ organizationId: scope.organizationId.toLowerCase(), schoolId: scope.schoolId.toLowerCase(), plan, keys: Object.freeze(keys), form: Object.freeze({ ...form }) });
}

async function command(path: string, body: unknown, key: string, step: ContactStep, owned: () => boolean): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  } catch { throw new AddContactError('UNKNOWN', step); }
  if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new AddContactError('SESSION', step); }
  if (response.status === 403) throw new AddContactError('DENIED', step);
  // "Still being processed" is not an answer: the same key must be tried again.
  if (response.status === 409) {
    let code: unknown = null;
    try { const refused = await response.json() as { code?: unknown; message?: { code?: unknown } }; code = refused?.code ?? refused?.message?.code ?? null; } catch { /* no body */ }
    throw new AddContactError(code === 'IDEMPOTENCY_IN_PROGRESS' ? 'UNKNOWN' : 'REJECTED', step);
  }
  if (response.status >= 400 && response.status < 500) throw new AddContactError('REJECTED', step);
  if ((response.status !== 200 && response.status !== 201) || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new AddContactError('UNKNOWN', step);
  let parsed: unknown;
  try { parsed = await response.json(); } catch { throw new AddContactError('UNKNOWN', step); }
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { data?: unknown }).data : null;
  const id = data && typeof data === 'object' ? (data as { id?: unknown }).id : null;
  if (typeof id !== 'string' || !UUID.test(id)) throw new AddContactError('UNKNOWN', step);
  return id.toLowerCase();
}

/**
 * Runs every step of the capsule in order. A replay sends the same steps with the same keys: the server answers a
 * finished step with the record it already made, so the run continues from the first step that did not finish.
 */
async function add(capsule: ContactCapsule, owned: () => boolean = () => true): Promise<ContactAdded> {
  const base = `/api/v1/organizations/${capsule.organizationId}/schools/${capsule.schoolId}`;
  const { plan, keys } = capsule;
  // The student is saved first (owner, 2026-11-28: the student is the main contact).
  const childId = plan.child ? await command(`${base}/people`, plan.child, keys.child, 'child', owned) : null;
  const adultId = plan.adult ? await command(`${base}/people`, plan.adult, keys.adult, 'adult', owned) : null;
  const mainId = childId ?? adultId;
  if (!mainId) throw new AddContactError('REJECTED', 'adult');
  if (!plan.familyName || (!childId && !plan.adultRole)) return { adultId, childId, familyId: null, mainId };
  const familyId = await command(`${base}/families`, { displayName: plan.familyName.slice(0, 160) }, keys.family, 'family', owned);
  if (adultId && plan.adultRole) await command(`${base}/families/${familyId}/members`, { personId: adultId, memberRole: plan.adultRole }, keys.adultMember, 'adultMember', owned);
  if (childId) await command(`${base}/families/${familyId}/members`, { personId: childId, memberRole: 'STUDENT' }, keys.childMember, 'childMember', owned);
  return { adultId, childId, familyId, mainId };
}

export interface AddContactApi { add(capsule: ContactCapsule, owned?: () => boolean): Promise<ContactAdded> }
export const addContactApi: AddContactApi = { add };
