import { accountClosed, saasUuid, validateCreativeAssetDeletion, validateCreativeAssetReview, validateCreativeAssetView, validateCreativeReviewQueue,
  type CreativeAssetDeletion, type CreativeAssetReview, type CreativeAssetView, type CreativeReviewDecision, type CreativeReviewQueue } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * C3/C4 stored media for one school: a 5-minute signed view link, delete, human review and the reviewers' queue. The
 * server authorizes the exact school and the asset row for each; the browser never sees a storage key.
 */
export type MediaErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person may not do this (not a reviewer, other school). */ | 'DENIED'
  /** Not listed for this person, deleted, or not a stored file. */ | 'GONE'
  /** HON file storage is not connected. */ | 'STORAGE_OFF'
  /** A rejected asset cannot be approved again. */ | 'NOT_ALLOWED'
  /** Anything else: nothing is claimed. */ | 'UNKNOWN';
export class CreativeMediaError extends Error { constructor(readonly kind: MediaErrorKind) { super(kind); } }
export const CREATIVE_ASSET_DELETE_COMMAND = 'saas-creative-asset-delete';
export const CREATIVE_ASSET_REVIEW_COMMAND = 'saas-creative-asset-review';

const assetsPath = (schoolId: string) => `/api/v1/schools/${saasUuid(schoolId).toLowerCase()}/creative-studio/assets`;
const json = /^application\/json(?:\s*;|$)/i;
async function codeOf(response: Response): Promise<string | null> {
  if (!json.test(response.headers.get('content-type') ?? '')) return null;
  try { const v: unknown = await response.json(); return v && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null; }
  catch { return null; }
}
async function failure(response: Response): Promise<never> {
  const code = await codeOf(response);
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeMediaError('SESSION'); }
  if (response.status === 403) throw new CreativeMediaError('DENIED');
  if (response.status === 404) throw new CreativeMediaError('GONE');
  if (response.status === 409 && code === 'SAAS_TRANSITION_NOT_ALLOWED') throw new CreativeMediaError('NOT_ALLOWED');
  if (response.status === 503 && code === 'CREATIVE_STORAGE_NOT_CONNECTED') throw new CreativeMediaError('STORAGE_OFF');
  throw new CreativeMediaError('UNKNOWN');
}
const read = (path: string, signal: AbortSignal) => fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
  referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
const command = (path: string, name: string, body: unknown, signal: AbortSignal) => fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin',
  cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': name },
  body: JSON.stringify(body), signal });
async function data<T>(response: Response, validate: (v: unknown) => T): Promise<T> {
  if (response.status !== 200) return failure(response);
  try { return validate(accountClosed(await response.json(), ['data']).data); } catch { throw new CreativeMediaError('UNKNOWN'); }
}
const attempt = async (work: () => Promise<Response>) => { try { return await work(); } catch { throw new CreativeMediaError('UNKNOWN'); } };

export async function viewCreativeAsset(schoolId: string, assetId: string, signal: AbortSignal): Promise<CreativeAssetView> {
  const id = saasUuid(assetId).toLowerCase();
  const view = await data(await attempt(() => read(`${assetsPath(schoolId)}/${id}/view`, signal)), validateCreativeAssetView);
  if (view.assetId !== id) throw new CreativeMediaError('UNKNOWN');
  return view;
}
/** Delete is idempotent on the server: repeating it retries the file removal, never anything else. */
export async function deleteCreativeAsset(schoolId: string, assetId: string, signal: AbortSignal): Promise<CreativeAssetDeletion> {
  const id = saasUuid(assetId).toLowerCase();
  const done = await data(await attempt(() => command(`${assetsPath(schoolId)}/${id}/delete`, CREATIVE_ASSET_DELETE_COMMAND, {}, signal)), validateCreativeAssetDeletion);
  if (done.assetId !== id) throw new CreativeMediaError('UNKNOWN');
  return done;
}
/** Approve or reject: idempotent on the server (the same decision again answers with the recorded one). */
export async function reviewCreativeAsset(schoolId: string, assetId: string, decision: CreativeReviewDecision, signal: AbortSignal): Promise<CreativeAssetReview> {
  const id = saasUuid(assetId).toLowerCase();
  const done = await data(await attempt(() => command(`${assetsPath(schoolId)}/${id}/review`, CREATIVE_ASSET_REVIEW_COMMAND, { decision }, signal)), validateCreativeAssetReview);
  if (done.assetId !== id || done.review !== decision) throw new CreativeMediaError('UNKNOWN');
  return done;
}
export async function listCreativeReviewQueue(schoolId: string, signal: AbortSignal): Promise<CreativeReviewQueue> {
  return data(await attempt(() => read(`${assetsPath(schoolId)}/review-queue`, signal)), validateCreativeReviewQueue);
}
