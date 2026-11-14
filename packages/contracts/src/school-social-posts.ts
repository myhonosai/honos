// School social posts (0348, docs/architecture/SOCIAL_POSTING_INBOX_ADS.md §4A): staff write text posts for the school's
// own Facebook Pages, a manager approves each one with a publish time, and HON publishes it through Zernio only when
// HON_ZERNIO_PUBLISH_APPROVED is set on the API server. Instagram needs media, which this piece does not carry.
import { SOCIAL_PLATFORMS, type SocialPlatform } from './school-social.js';

export const SOCIAL_POST_STATUSES = ['DRAFT', 'APPROVED', 'CANCELLED'] as const;
export const SOCIAL_POST_TARGET_STATUSES = ['PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'UNKNOWN', 'SKIPPED', 'CANCELLED'] as const;
export const SOCIAL_POST_FAILURE_CODES = ['PROVIDER_REJECTED', 'PROVIDER_REPORTED_FAILED', 'CONFIRMED_NOT_PUBLISHED'] as const;
export const SOCIAL_POST_SKIP_REASONS = ['ACCOUNT_OFF', 'SCHOOL_INACTIVE'] as const;
export const SOCIAL_POST_CREATE_COMMAND = 'marketing.social.post.create';
export const SOCIAL_POST_EDIT_COMMAND = 'marketing.social.post.edit';
export const SOCIAL_POST_APPROVE_COMMAND = 'marketing.social.post.approve';
export const SOCIAL_POST_CANCEL_COMMAND = 'marketing.social.post.cancel';
export const SOCIAL_POST_RESOLVE_COMMAND = 'marketing.social.post.resolve';
export const SOCIAL_POST_TEXT_MAX = 2200;
export const SOCIAL_POST_ACCOUNTS_MAX = 4;
/** Approval may schedule at most this far ahead. */
export const SOCIAL_POST_SCHEDULE_DAYS = 90;
/** The calendar read covers at most this many days. */
export const SOCIAL_POST_RANGE_DAYS = 100;

export type SocialPostStatus = typeof SOCIAL_POST_STATUSES[number];
export type SocialPostTargetStatus = typeof SOCIAL_POST_TARGET_STATUSES[number];
export type SocialPostFailureCode = typeof SOCIAL_POST_FAILURE_CODES[number];
export type SocialPostSkipReason = typeof SOCIAL_POST_SKIP_REASONS[number];
export interface SocialPostTarget {
  targetId: string; accountId: string; platform: SocialPlatform; displayName: string; status: SocialPostTargetStatus;
  failureCode: SocialPostFailureCode | null; skipReason: SocialPostSkipReason | null; resolvedByPerson: boolean; settledAt: string | null; version: number;
}
export interface SocialPost {
  postId: string; text: string; linkUrl: string | null; status: SocialPostStatus; publishAt: string | null; accountIds: string[];
  version: number; createdAt: string; updatedAt: string; approvedAt: string | null; cancelledAt: string | null; targets: SocialPostTarget[];
}
export interface SocialPostList { posts: SocialPost[]; publishEnabled: boolean; checkedAt: string }
export interface SocialPostDraftInput { text: string; linkUrl?: string | null; accountIds: string[] }
export interface SocialPostEditInput extends SocialPostDraftInput { expectedVersion: number }
export interface SocialPostApproveInput { expectedVersion: number; publishAt?: string | null }
export interface SocialPostCancelInput { expectedVersion: number }
export interface SocialPostResolveInput { expectedVersion: number; outcome: 'PUBLISHED' | 'NOT_PUBLISHED' }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const ISO_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LINK = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(\/[!-~]*)?$/;
// Newlines and tabs are allowed in a post; other control characters are not.
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
function fail(what: string): never { throw new Error(`Unverified school social ${what}.`); }
function record(v: unknown, keys: readonly string[], what: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(what);
  const o = v as Record<string, unknown>;
  const present = Object.keys(o);
  if (keys.some(k => !present.includes(k)) || present.some(k => !keys.includes(k) && !optional.includes(k))) fail(what);
  return o;
}
function time(v: unknown, what: string, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) fail(what);
  return v;
}
function version(v: unknown, what: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 999_999_999) fail(what);
  return v as number;
}
function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > SOCIAL_POST_TEXT_MAX || v.trim() === '' || TEXT_CONTROL.test(v)) fail(what);
  return v;
}
function link(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || v.length > 2000 || !LINK.test(v)) fail(what);
  return v;
}
function accountIds(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > SOCIAL_POST_ACCOUNTS_MAX || v.some(id => typeof id !== 'string' || !UUID.test(id))) fail(what);
  const ids = (v as string[]).map(id => id.toLowerCase());
  if (new Set(ids).size !== ids.length) fail(what);
  return ids;
}
function oneOf<T extends string>(v: unknown, values: readonly T[], what: string, nullable = false): T | null {
  if (v === null && nullable) return null;
  if (!values.includes(v as T)) fail(what);
  return v as T;
}

export function verifySocialPostTarget(v: unknown): SocialPostTarget {
  const o = record(v, ['targetId', 'accountId', 'platform', 'displayName', 'status', 'failureCode', 'skipReason', 'resolvedByPerson', 'settledAt', 'version'], 'post target');
  if (typeof o.targetId !== 'string' || !UUID.test(o.targetId) || typeof o.accountId !== 'string' || !UUID.test(o.accountId)
    || typeof o.displayName !== 'string' || o.displayName.length < 1 || o.displayName.length > 120 || CONTROL.test(o.displayName)
    || typeof o.resolvedByPerson !== 'boolean') fail('post target');
  const status = oneOf(o.status, SOCIAL_POST_TARGET_STATUSES, 'post target')!;
  const failureCode = oneOf(o.failureCode, SOCIAL_POST_FAILURE_CODES, 'post target', true);
  const skipReason = oneOf(o.skipReason, SOCIAL_POST_SKIP_REASONS, 'post target', true);
  const settledAt = time(o.settledAt, 'post target', true);
  if ((status === 'FAILED') !== (failureCode !== null) || (status === 'SKIPPED') !== (skipReason !== null)
    || ['PUBLISHED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(status) !== (settledAt !== null)) fail('post target');
  return { targetId: o.targetId, accountId: o.accountId, platform: oneOf(o.platform, SOCIAL_PLATFORMS, 'post target')!, displayName: o.displayName,
    status, failureCode, skipReason, resolvedByPerson: o.resolvedByPerson, settledAt, version: version(o.version, 'post target') };
}

export function verifySocialPost(v: unknown): SocialPost {
  const o = record(v, ['postId', 'text', 'linkUrl', 'status', 'publishAt', 'accountIds', 'version', 'createdAt', 'updatedAt', 'approvedAt', 'cancelledAt', 'targets'], 'post');
  if (typeof o.postId !== 'string' || !UUID.test(o.postId) || !Array.isArray(o.targets) || o.targets.length > SOCIAL_POST_ACCOUNTS_MAX) fail('post');
  const status = oneOf(o.status, SOCIAL_POST_STATUSES, 'post')!;
  const publishAt = time(o.publishAt, 'post', true), approvedAt = time(o.approvedAt, 'post', true), cancelledAt = time(o.cancelledAt, 'post', true);
  const targets = o.targets.map(verifySocialPostTarget);
  if ((publishAt === null) !== (approvedAt === null) || (status === 'APPROVED' && approvedAt === null) || (status === 'DRAFT' && approvedAt !== null)
    || (status === 'CANCELLED') !== (cancelledAt !== null) || (status === 'DRAFT' && targets.length > 0)
    || (status === 'APPROVED' && targets.length === 0)) fail('post');
  return { postId: o.postId, text: text(o.text, 'post'), linkUrl: link(o.linkUrl, 'post'), status, publishAt, accountIds: accountIds(o.accountIds, 'post'),
    version: version(o.version, 'post'), createdAt: time(o.createdAt, 'post')!, updatedAt: time(o.updatedAt, 'post')!, approvedAt, cancelledAt, targets };
}

export function verifySocialPostList(v: unknown): SocialPostList {
  const o = record(v, ['posts', 'publishEnabled', 'checkedAt'], 'post list');
  if (!Array.isArray(o.posts) || o.posts.length > 200 || typeof o.publishEnabled !== 'boolean') fail('post list');
  return { posts: o.posts.map(verifySocialPost), publishEnabled: o.publishEnabled, checkedAt: time(o.checkedAt, 'post list')! };
}

export function validateSocialPostDraftInput(v: unknown): SocialPostDraftInput {
  const o = record(v, ['text', 'accountIds'], 'post input', ['linkUrl']);
  const linkUrl = link(o.linkUrl, 'post input');
  return { text: text(o.text, 'post input'), accountIds: accountIds(o.accountIds, 'post input'), ...(linkUrl ? { linkUrl } : {}) };
}
export function validateSocialPostEditInput(v: unknown): SocialPostEditInput {
  const o = record(v, ['text', 'accountIds', 'expectedVersion'], 'post edit input', ['linkUrl']);
  const linkUrl = link(o.linkUrl, 'post edit input');
  return { text: text(o.text, 'post edit input'), accountIds: accountIds(o.accountIds, 'post edit input'), expectedVersion: version(o.expectedVersion, 'post edit input'),
    ...(linkUrl ? { linkUrl } : {}) };
}
export function validateSocialPostApproveInput(v: unknown): SocialPostApproveInput {
  const o = record(v, ['expectedVersion'], 'post approve input', ['publishAt']);
  if (o.publishAt !== undefined && o.publishAt !== null && (typeof o.publishAt !== 'string' || !ISO_INPUT.test(o.publishAt) || Number.isNaN(Date.parse(o.publishAt)))) fail('post approve input');
  return { expectedVersion: version(o.expectedVersion, 'post approve input'), ...(typeof o.publishAt === 'string' ? { publishAt: o.publishAt } : {}) };
}
export function validateSocialPostCancelInput(v: unknown): SocialPostCancelInput {
  const o = record(v, ['expectedVersion'], 'post cancel input');
  return { expectedVersion: version(o.expectedVersion, 'post cancel input') };
}
export function validateSocialPostResolveInput(v: unknown): SocialPostResolveInput {
  const o = record(v, ['expectedVersion', 'outcome'], 'post resolve input');
  return { expectedVersion: version(o.expectedVersion, 'post resolve input'), outcome: oneOf(o.outcome, ['PUBLISHED', 'NOT_PUBLISHED'] as const, 'post resolve input')! };
}
