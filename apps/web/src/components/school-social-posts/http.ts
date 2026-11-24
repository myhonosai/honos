import {
  SOCIAL_POST_APPROVE_COMMAND, SOCIAL_POST_CANCEL_COMMAND, SOCIAL_POST_CREATE_COMMAND, SOCIAL_POST_EDIT_COMMAND, SOCIAL_POST_RANGE_DAYS, SOCIAL_POST_RESOLVE_COMMAND,
  validateSocialPostApproveInput, validateSocialPostCancelInput, validateSocialPostDraftInput, validateSocialPostEditInput, validateSocialPostResolveInput,
  verifySocialPost, verifySocialPostList,
  type SocialPost, type SocialPostApproveInput, type SocialPostDraftInput, type SocialPostEditInput, type SocialPostList, type SocialPostResolveInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * School posts (0348). The list is a plain same-origin GET; every write sends its own X-HON-Human-Command and an
 * Idempotency-Key, so a retried request with the same key is replayed, never sent twice. The server decides the
 * permission and whether publishing is turned on. Nothing here is authority.
 */
export type PostsErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this person at this school. Nothing changed. */ | 'DENIED'
  /** Posting is off for one of the chosen accounts, or it was disconnected. Nothing changed. */ | 'PUBLISH_OFF'
  /** Instagram needs a photo, which HON cannot attach yet. Nothing changed. */ | 'MEDIA'
  /** Too long for a Google Business Profile (1,500 characters). Nothing changed. */ | 'TOO_LONG'
  /** The post moved on (approved, started or cancelled). Nothing changed. */ | 'STATE'
  /** Someone changed this post first. Nothing changed. */ | 'STALE'
  /** The post is gone. */ | 'GONE'
  /** Too many attempts. Nothing changed. */ | 'LIMIT'
  /** Not accepted as written. Nothing changed. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class PostsError extends Error { constructor(readonly kind: PostsErrorKind, readonly code: string | null = null) { super(kind); } }
export type PostsScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;

const RESPONSE_MAX = 4_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
/** The page shows posts from this many days back; the rest of the 100-day read looks ahead. */
export const POSTS_BACK_DAYS = 30;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function base(scope: PostsScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new PostsError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/marketing/social`;
}
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new PostsError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new PostsError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const CONFLICTS: Readonly<Record<string, PostsErrorKind>> = {
  SOCIAL_POST_STATE: 'STATE', SOCIAL_PUBLISH_OFF: 'PUBLISH_OFF', SOCIAL_ACCOUNT_DISCONNECTED: 'PUBLISH_OFF', SOCIAL_VERSION_CONFLICT: 'STALE',
  IDEMPOTENCY_KEY_REUSED: 'INVALID', IDEMPOTENCY_KEY_REQUIRED: 'INVALID',
};
/** Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function postsErrorFor(status: number, code: string | null): PostsError {
  if (status === 403) return new PostsError('DENIED', code);
  if (status === 404) return new PostsError('GONE', code);
  if (status === 429) return new PostsError('LIMIT', code);
  if (status === 422 && code === 'SOCIAL_MEDIA_REQUIRED') return new PostsError('MEDIA', code);
  if (status === 400 && code === 'SOCIAL_TEXT_TOO_LONG') return new PostsError('TOO_LONG', code);
  if (status === 400) return new PostsError('INVALID', code);
  if (status === 409 && code && CONFLICTS[code]) return new PostsError(CONFLICTS[code]!, code);
  return new PostsError('UNKNOWN', code);
}
/** Only an unknown outcome may be retried, and only with the same key. */
export const keepPostsForRetry = (error: unknown) => !(error instanceof PostsError) || error.kind === 'UNKNOWN';

async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new PostsError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof PostsError) throw error; throw new PostsError('UNKNOWN'); }
  if (answer.status !== 200) throw postsErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new PostsError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new PostsError('INVALID'); } }
function postId(id: string): string { if (!UUID.test(id)) throw new PostsError('INVALID'); return id.toLowerCase(); }
/** The answer must be about the post the request named. */
const samePost = (id: string) => (v: unknown): SocialPost => { const p = verifySocialPost(v); if (p.postId.toLowerCase() !== id.toLowerCase()) throw new Error('post'); return p; };
/** A settled target answers with its post, which must hold that target. */
const holdingTarget = (id: string) => (v: unknown): SocialPost => {
  const p = verifySocialPost(v); if (!p.targets.some(t => t.targetId.toLowerCase() === id.toLowerCase())) throw new Error('target'); return p;
};

export const postsApi = {
  /** Posts from POSTS_BACK_DAYS ago to the end of the 100-day read window. */
  async list(scope: PostsScope, now: Date, signal: AbortSignal, owned: Owned): Promise<SocialPostList> {
    const from = new Date(now.getTime() - POSTS_BACK_DAYS * DAY), to = new Date(from.getTime() + SOCIAL_POST_RANGE_DAYS * DAY);
    const path = `${base(scope)}/posts?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`;
    let answer: { status: number; value: unknown };
    try { answer = await exchange(path, signal, owned); }
    catch (error) { if (error instanceof PostsError || signal.aborted) throw error; throw new PostsError('UNKNOWN'); }
    if (answer.status !== 200) throw postsErrorFor(answer.status, codeOf(answer.value));
    try { return verifySocialPostList(data(answer.value)); } catch { throw new PostsError('UNKNOWN'); }
  },
  async create(scope: PostsScope, input: SocialPostDraftInput, key: string, signal: AbortSignal, owned: Owned): Promise<SocialPost> {
    return command(`${base(scope)}/posts`, SOCIAL_POST_CREATE_COMMAND, checked(() => validateSocialPostDraftInput(input)), key, (v) => {
      const p = verifySocialPost(v); if (p.status !== 'DRAFT') throw new Error('post'); return p;
    }, signal, owned);
  },
  async edit(scope: PostsScope, id: string, input: SocialPostEditInput, key: string, signal: AbortSignal, owned: Owned): Promise<SocialPost> {
    return command(`${base(scope)}/posts/${postId(id)}`, SOCIAL_POST_EDIT_COMMAND, checked(() => validateSocialPostEditInput(input)), key, samePost(id), signal, owned);
  },
  async approve(scope: PostsScope, id: string, input: SocialPostApproveInput, key: string, signal: AbortSignal, owned: Owned): Promise<SocialPost> {
    return command(`${base(scope)}/posts/${postId(id)}/approve`, SOCIAL_POST_APPROVE_COMMAND, checked(() => validateSocialPostApproveInput(input)), key, samePost(id), signal, owned);
  },
  async cancel(scope: PostsScope, id: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<SocialPost> {
    return command(`${base(scope)}/posts/${postId(id)}/cancel`, SOCIAL_POST_CANCEL_COMMAND, checked(() => validateSocialPostCancelInput({ expectedVersion })), key, samePost(id), signal, owned);
  },
  async resolve(scope: PostsScope, targetId: string, input: SocialPostResolveInput, key: string, signal: AbortSignal, owned: Owned): Promise<SocialPost> {
    return command(`${base(scope)}/post-targets/${postId(targetId)}/resolve`, SOCIAL_POST_RESOLVE_COMMAND, checked(() => validateSocialPostResolveInput(input)), key,
      holdingTarget(targetId), signal, owned);
  },
};
export type PostsApi = typeof postsApi;

/**
 * Turns the date and time a person picked (a local `YYYY-MM-DDTHH:MM` from a datetime-local field) into an ISO time with
 * offset, or null when it is not a real time, already past, or more than 90 days ahead. The server checks again.
 */
export function publishAtFrom(local: string, now: Date, days = 90): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const at = new Date(local);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime() || at.getTime() > now.getTime() + days * DAY) return null;
  return at.toISOString();
}
