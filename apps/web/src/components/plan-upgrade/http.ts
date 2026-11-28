import {
  SAAS_COMMANDS, SAAS_GENERATION_CONFIRMATION, SAAS_PRICE_DISCLOSURE_VERSION, SAAS_PRICE_RECORD_CONFIRMATION, SAAS_PRICE_SCHEDULE_CONFIRMATION,
  SAAS_SCHEDULE_BINDING_CONFIRMATION, saasUuid, validateSaasPriceAcceptancePreview, validateSaasPriceAcceptanceReceipt,
  validateSaasPriceScheduleReceipt, validateSaasScheduleBindingReceipt, validateSaasSchoolPriceSchedules,
  validateSaasSubscriptionGenerationReceipt, type SaasPriceAcceptancePreview, type SaasPriceSchedule, type SaasScheduleBinding,
  type SaasSchoolPriceSchedules,
} from '@hon/contracts';

/**
 * Plan builder piece 5 (0707): the 0230 schedule path in the browser. HQ prepares checkout terms for a published offer; the
 * school reads them, previews, accepts, records the subscription intent and starts the schedule binding. Every step is the
 * existing server command with its own authorization, idempotency key and human-command marker. Test mode only: no card
 * data, no charge here, and the server decides access after a verified payment.
 */
export class UpgradeError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly uncertain = false) { super('HON could not confirm this step.'); }
}
const CODES = new Set(['SAAS_FORBIDDEN','SAAS_UNAVAILABLE','SAAS_VERSION_CONFLICT','SAAS_OFFER_NOT_AVAILABLE','SAAS_PRICE_TERMS_UNSUPPORTED',
  'SAAS_PRICE_ACCEPTANCE_BLOCKED','SAAS_SCHEDULE_PROVIDER_UNAVAILABLE','SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED','SAAS_SCHEDULE_BINDING_EXISTS',
  'SAAS_SCHEDULE_BINDING_UNAVAILABLE','SAAS_OUTCOME_UNKNOWN','IDEMPOTENCY_KEY_REUSED','IDEMPOTENCY_IN_PROGRESS','INVALID_SAAS_INPUT']);
const options = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
const MAX = 400_000;

async function exchange(path: string, command?: { marker: string; key: string; body: unknown }): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { ...options, method: command ? 'POST' : 'GET', signal: AbortSignal.timeout(command ? 30_000 : 15_000),
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: JSON.stringify(command.body) } : {}) });
  } catch { throw new UpgradeError(command ? 'UNKNOWN' : 'UNAVAILABLE', 0, !!command); }
  if (!response.ok) {
    let code = '';
    try { const raw = await response.text(); if (raw.length < 4000) { const v = JSON.parse(raw) as { code?: unknown }; if (typeof v?.code === 'string' && CODES.has(v.code)) code = v.code; } } catch { /* never show private bodies */ }
    const uncertain = !!command && (![400,401,403,404,409,422].includes(response.status) || code === 'IDEMPOTENCY_IN_PROGRESS' || code === 'SAAS_OUTCOME_UNKNOWN');
    throw new UpgradeError(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : code || (uncertain ? 'UNKNOWN' : 'UNAVAILABLE'), response.status, uncertain);
  }
  try {
    if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
      || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) throw new Error('shape');
    const raw = await response.text(); if (raw.length > MAX) throw new Error('size');
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'data')) throw new Error('shape');
    return (body as { data: unknown }).data;
  } catch { throw new UpgradeError(command ? 'UNKNOWN' : 'INVALID_RESPONSE', 0, !!command); }
}
function checked<T>(validate: (v: unknown) => T, v: unknown, uncertain = false): T {
  try { return validate(v); } catch { throw new UpgradeError(uncertain ? 'UNKNOWN' : 'INVALID_RESPONSE', 0, uncertain); }
}
export const newKey = (): string => crypto.randomUUID();

/** HQ owner: record the checkout terms of one published offer (first version only; an offer never changes once published). */
export async function prepareCheckoutTerms(offerId: string, setRevision: number, key: string): Promise<SaasPriceSchedule> {
  const body = { offerId: saasUuid(offerId), renewalOfferId: saasUuid(offerId), expectedOfferSetRevision: setRevision, expectedVersion: 0,
    disclosureVersion: SAAS_PRICE_DISCLOSURE_VERSION, confirmation: SAAS_PRICE_RECORD_CONFIRMATION, reason: 'HQ prepared checkout terms in the Plan builder' };
  const r = checked(validateSaasPriceScheduleReceipt, await exchange('/api/v1/hq/saas/price-schedules', { marker: SAAS_COMMANDS.recordPriceSchedule, key, body }), true);
  if (r.schedule.offerId.toLowerCase() !== body.offerId.toLowerCase()) throw new UpgradeError('UNKNOWN', 0, true);
  return r.schedule;
}

/** School: the latest checkout terms per offer of the published set (purchaser of the exact school only). */
export async function readSchoolPriceSchedules(schoolId: string): Promise<SaasSchoolPriceSchedules> {
  const school = saasUuid(schoolId);
  const r = checked(validateSaasSchoolPriceSchedules, await exchange(`/api/v1/schools/${school}/hon-os-price-schedules`));
  if (r.schoolId.toLowerCase() !== school.toLowerCase()) throw new UpgradeError('INVALID_RESPONSE');
  return r;
}
export async function previewTerms(schoolId: string, scheduleId: string): Promise<SaasPriceAcceptancePreview> {
  const school = saasUuid(schoolId), schedule = saasUuid(scheduleId);
  const p = checked(validateSaasPriceAcceptancePreview, await exchange(`/api/v1/schools/${school}/hon-os-price-acceptances/preview/${schedule}`));
  if (p.schoolId.toLowerCase() !== school.toLowerCase() || p.schedule.scheduleId.toLowerCase() !== schedule.toLowerCase()) throw new UpgradeError('INVALID_RESPONSE');
  return p;
}

export type SubscribeKeys = Readonly<{ accept: string; generation: string; binding: string }>;
/**
 * Accept the exact previewed terms, record the subscription intent and start the schedule binding. Each step keeps its own
 * key, so a retry after an unknown outcome replays the same command instead of creating a second one.
 */
export async function subscribe(schoolId: string, preview: SaasPriceAcceptancePreview, keys: SubscribeKeys): Promise<SaasScheduleBinding> {
  const school = saasUuid(schoolId);
  const accepted = checked(validateSaasPriceAcceptanceReceipt, await exchange(`/api/v1/schools/${school}/hon-os-price-acceptances`, { marker: SAAS_COMMANDS.acceptPriceSchedule, key: keys.accept,
    body: { scheduleId: preview.schedule.scheduleId, scheduleDigest: preview.schedule.scheduleDigest, acceptanceDigest: preview.acceptanceDigest, confirmation: SAAS_PRICE_SCHEDULE_CONFIRMATION } }), true).acceptance;
  if (accepted.schoolId.toLowerCase() !== school.toLowerCase()) throw new UpgradeError('UNKNOWN', 0, true);
  const generation = checked(validateSaasSubscriptionGenerationReceipt, await exchange(`/api/v1/schools/${school}/hon-os-subscription-generations`, { marker: SAAS_COMMANDS.recordSubscriptionGeneration, key: keys.generation,
    body: { acceptanceId: accepted.acceptanceId, acceptanceDigest: accepted.acceptanceDigest, confirmation: SAAS_GENERATION_CONFIRMATION } }), true).generation;
  const binding = checked(validateSaasScheduleBindingReceipt, await exchange(`/api/v1/schools/${school}/hon-os-subscription-schedule-bindings`, { marker: SAAS_COMMANDS.startScheduleBinding, key: keys.binding,
    body: { generationId: generation.generationId, generationDigest: generation.generationDigest, confirmation: SAAS_SCHEDULE_BINDING_CONFIRMATION } }), true).binding;
  if (binding.schoolId.toLowerCase() !== school.toLowerCase()) throw new UpgradeError('UNKNOWN', 0, true);
  return binding;
}
