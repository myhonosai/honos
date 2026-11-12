import { accountClosed, saasUuid, validateCreativeAvatarInput, validateCreativeAvatarReceipt, validateCreativeGenerationInput, validateCreativeGenerationReceipt,
  validateCreativeStudioAvatarList, validateCreativeStudioGenerationList, type CreativeAvatarInput, type CreativeAvatarReceipt, type CreativeGenerationInput,
  type CreativeGenerationReceipt, type CreativeStudioAvatarList, type CreativeStudioGenerationList } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Creative Studio generations (CS1). The server decides the provider, model and price, authorizes the exact school and
 * reserves credits from that school's own wallet; the browser only sends the closed request and keeps one idempotency
 * key per request until its outcome is known.
 */
export type GenerationErrorKind =
  /** Session ended: nothing more is shown. */ 'SESSION'
  /** This person cannot use Creative Studio at this school. Definitive. */ | 'DENIED'
  /** No creative provider is connected; nothing was sent or charged. Definitive. */ | 'NOT_CONNECTED'
  /** A school rule refused it (credits, HQ pause, eligibility, too many in progress). Definitive. */ | 'REFUSED'
  /** The request was not accepted as sent. Definitive. */ | 'INVALID'
  /** The outcome is not known. Retry only the identical request with the same key. */ | 'UNKNOWN';
export class CreativeGenerationError extends Error {
  constructor(readonly kind: GenerationErrorKind, readonly code: string | null = null) { super(kind); }
}
export const CREATIVE_GENERATION_COMMAND = 'saas-creative-generation-create';
export const CREATIVE_AVATAR_COMMAND = 'saas-creative-avatar-create';
/**
 * Only these answers prove the request was refused before anything was accepted. Every other 409 or 422 (including an
 * unrecognized or missing code, or a conflict raised while recording a provider result) leaves the outcome unknown.
 */
const DEFINITIVE_CONFLICTS = new Set(['IDEMPOTENCY_KEY_REUSED']);
/** School rules the server checks before it reserves credits or calls a provider. Any other 422 stays unknown. */
const PRE_ACCEPTANCE_REFUSALS = new Set(['CREATIVE_TOO_MANY_IN_PROGRESS', 'SAAS_CREATIVE_AI_PAUSED_BY_HQ', 'SAAS_CREATIVE_PROGRAM_INACTIVE',
  'SAAS_CREATIVE_PAID_ACCESS_REQUIRED', 'SAAS_CREATIVE_RATES_NOT_PUBLISHED', 'SAAS_CREATIVE_WINDOW_UNAVAILABLE', 'SAAS_CREATIVE_WINDOW_NOT_PAID',
  'SAAS_CREATIVE_ENTITLEMENT_NOT_IN_EFFECT', 'SAAS_CREATIVE_AI_ACCESS_LAPSED', 'SAAS_CREATIVE_DEBIT_EXCEEDS_AVAILABLE']);
const isRuleRefusal = (code: string | null) => code !== null && PRE_ACCEPTANCE_REFUSALS.has(code);
/** Avatars (0276) are also refused before anything is reserved when HQ has not priced them, the rate is not an image, or the school has 12. */
const AVATAR_REFUSALS = new Set([...PRE_ACCEPTANCE_REFUSALS, 'SAAS_OPERATION_NOT_PRICED', 'CREATIVE_AVATAR_RATE_INVALID', 'CREATIVE_AVATAR_LIMIT_REACHED']);

const generationsPath = (schoolId: string) => `/api/v1/schools/${saasUuid(schoolId).toLowerCase()}/creative-studio/generations`;
const avatarsPath = (schoolId: string) => `/api/v1/schools/${saasUuid(schoolId).toLowerCase()}/creative-studio/avatars`;
const json = /^application\/json(?:\s*;|$)/i;

async function body(response: Response): Promise<unknown> {
  if (!json.test(response.headers.get('content-type') ?? '')) return null;
  try { return await response.json(); } catch { return null; }
}
const codeOf = (value: unknown): string | null =>
  value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { code?: unknown }).code === 'string' ? (value as { code: string }).code : null;

export async function listCreativeGenerations(schoolId: string, signal: AbortSignal): Promise<CreativeStudioGenerationList> {
  const path = generationsPath(schoolId);
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', codeOf(await body(response)));
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', codeOf(await body(response)));
  try {
    const list = validateCreativeStudioGenerationList(accountClosed(await response.json(), ['data']).data);
    if (list.generations.some(g => g.schoolId !== schoolId.toLowerCase())) throw new Error('school');
    return list;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

/** Validates the request before anything is sent. Throws INVALID for a request the contract would refuse. */
export function prepareCreativeGeneration(input: CreativeGenerationInput): CreativeGenerationInput {
  try { return validateCreativeGenerationInput(input); } catch { throw new CreativeGenerationError('INVALID', 'INVALID_SAAS_INPUT'); }
}

/** One create attempt. Repeating it with the same key and input never makes a second generation. */
export async function createCreativeGeneration(schoolId: string, input: CreativeGenerationInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeGenerationReceipt> {
  const path = generationsPath(schoolId), key = saasUuid(idempotencyKey).toLowerCase(), request = prepareCreativeGeneration(input);
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': CREATIVE_GENERATION_COMMAND, 'Idempotency-Key': key },
      body: JSON.stringify(request), signal });
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
  const code = response.status === 200 ? null : codeOf(await body(response));
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', code);
  // 400 (not accepted) and 404 (school or generation not found) roll back before anything is reserved.
  if (response.status === 400 || response.status === 404) throw new CreativeGenerationError('INVALID', code);
  if (response.status === 422) throw new CreativeGenerationError(isRuleRefusal(code) ? 'REFUSED' : 'UNKNOWN', code);
  if (response.status === 409) throw new CreativeGenerationError(code !== null && DEFINITIVE_CONFLICTS.has(code) ? 'INVALID' : 'UNKNOWN', code);
  if (response.status === 503 && code === 'CREATIVE_PROVIDER_NOT_CONNECTED') throw new CreativeGenerationError('NOT_CONNECTED', code);
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', code);
  try {
    const receipt = validateCreativeGenerationReceipt(accountClosed(await response.json(), ['data']).data);
    const g = receipt.generation;
    if (g.schoolId !== schoolId.toLowerCase() || g.operationCode !== request.operationCode || g.units !== request.units || g.format !== request.format || g.prompt !== request.prompt) throw new Error('mismatch');
    return receipt;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

// ---------- A1 avatars (0276): the same closed, keyed, fail-unknown handling as a generation ----------
export async function listCreativeAvatars(schoolId: string, signal: AbortSignal): Promise<CreativeStudioAvatarList> {
  const response = await fetch(avatarsPath(schoolId), { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', codeOf(await body(response)));
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', codeOf(await body(response)));
  try {
    const list = validateCreativeStudioAvatarList(accountClosed(await response.json(), ['data']).data);
    if (list.avatars.some(a => a.schoolId !== schoolId.toLowerCase())) throw new Error('school');
    return list;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

export function prepareCreativeAvatar(input: CreativeAvatarInput): CreativeAvatarInput {
  try { return validateCreativeAvatarInput(input); } catch { throw new CreativeGenerationError('INVALID', 'INVALID_SAAS_INPUT'); }
}

/** One avatar create attempt. Repeating it with the same key and input never makes a second avatar or charge. */
export async function createCreativeAvatar(schoolId: string, input: CreativeAvatarInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeAvatarReceipt> {
  const path = avatarsPath(schoolId), key = saasUuid(idempotencyKey).toLowerCase(), request = prepareCreativeAvatar(input);
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': CREATIVE_AVATAR_COMMAND, 'Idempotency-Key': key },
      body: JSON.stringify(request), signal });
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
  const code = response.status === 200 ? null : codeOf(await body(response));
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', code);
  if (response.status === 400 || response.status === 404) throw new CreativeGenerationError('INVALID', code);
  if (response.status === 422) throw new CreativeGenerationError(code !== null && AVATAR_REFUSALS.has(code) ? 'REFUSED' : 'UNKNOWN', code);
  if (response.status === 409) throw new CreativeGenerationError(code !== null && DEFINITIVE_CONFLICTS.has(code) ? 'INVALID' : 'UNKNOWN', code);
  if (response.status === 503 && code === 'CREATIVE_PROVIDER_NOT_CONNECTED') throw new CreativeGenerationError('NOT_CONNECTED', code);
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', code);
  try {
    const receipt = validateCreativeAvatarReceipt(accountClosed(await response.json(), ['data']).data);
    const a = receipt.avatar;
    if (a.schoolId !== schoolId.toLowerCase() || a.name !== request.name || a.style !== request.style || a.description !== request.description) throw new Error('mismatch');
    return receipt;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}
