import type { CommandContext } from './index.js';
export const COMMUNITY_KINDS = ['TOPIC', 'POST', 'COMMENT'] as const;
export const COMMUNITY_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type CommunityKind = (typeof COMMUNITY_KINDS)[number];
export type CommunityStatus = (typeof COMMUNITY_STATUSES)[number];
export interface CommunityContext extends CommandContext { externalSubject: string }
export interface CommunityInput {
  expectedVersion: number; kind: CommunityKind; parentId: string | null;
  title: string; body: string; status: CommunityStatus; reason: string;
}
export interface CommunityProfileInput { expectedVersion: number; displayName: string; enabled: boolean }
export interface CommunityConsentInput { expectedVersion: number; enabled: boolean }
export interface CommunityProfile {
  version: number; displayName: string; enabled: boolean;
  organizationVersion: number; organizationEnabled: boolean; canManageOrganization: boolean;
  humanOnly: true; executionAllowed: false;
}
export interface CommunityRecord {
  id: string; version: number; kind: CommunityKind; parentId: string | null;
  title: string; body: string; status: CommunityStatus; displayName: string;
  canEdit: boolean; reason: string | null; recordedAt: string;
}
export interface CommunityPage { items: CommunityRecord[]; nextAfter: string | null; humanOnly: true; executionAllowed: false }
export interface CommunityHistory { id: string; items: Array<{ version: number; status: CommunityStatus; recordedAt: string }>; nextBefore: number | null; humanOnly: true; executionAllowed: false }
export const COMMUNITY_HELP = 'Closed HON human owner/operator community, available equally in Essential, Core and Complete. Published discussions are visible across opted-in organizations to current verified members only, not to the public, parents, generic staff or HQ by role alone. Drafts, archives and history are author-private. Only a minimal opted-in display name is shared. Never enter personal contacts, student/family, CRM, financial, billing, payment or confidential operational data. Plain text only; URLs, contact patterns, markup and attachments are forbidden. No AI/provider calls, automated moderation, social publishing, notifications, marketing, marketplace, purchases, payments or execution.';
export const COMMUNITY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(): never { throw new Error('Use the closed bounded human community contract; no URLs, contacts, markup, attachments or operational data.'); }
export function communityClosed(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid();
}
export function communityUuid(v: unknown): asserts v is string { if (typeof v !== 'string' || !COMMUNITY_UUID.test(v)) invalid(); }
export function communityVersion(v: unknown, min = 0): asserts v is number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > 999999998) invalid();
}
/** Conservative deterministic syntax restriction, not content classification or moderation. */
export function communityText(v: unknown, max: number, empty = false, multiline = false): asserts v is string {
  if (typeof v !== 'string' || [...v].length > max || (!empty && !v) || v.trim() !== v
    || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(multiline ? v.replaceAll('\n', '') : v)
    || /[<>@\\]|[a-z][a-z0-9+.-]*:\/|(?:https?|ftp|file|data|javascript|mailto|tel):|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\b|\/)|\+?\d[\d ()-]{6,}\d/i.test(v)) invalid();
}
export function validateCommunityInput(v: unknown): asserts v is CommunityInput {
  communityClosed(v, ['expectedVersion', 'kind', 'parentId', 'title', 'body', 'status', 'reason']);
  communityVersion(v.expectedVersion); if (v.expectedVersion > 999999997) invalid();
  if (!COMMUNITY_KINDS.includes(v.kind as CommunityKind) || !COMMUNITY_STATUSES.includes(v.status as CommunityStatus)) invalid();
  if (v.kind === 'TOPIC' ? v.parentId !== null : v.parentId === null) invalid();
  if (v.parentId !== null) communityUuid(v.parentId);
  communityText(v.title, 120, v.kind === 'COMMENT'); if (v.kind === 'COMMENT' && v.title !== '') invalid();
  communityText(v.body, 4000, false, true); communityText(v.reason, 300);
  if (v.expectedVersion === 0 && v.status !== 'DRAFT') invalid();
}
export function validateCommunityProfile(v: unknown): asserts v is CommunityProfileInput {
  communityClosed(v, ['expectedVersion', 'displayName', 'enabled']); communityVersion(v.expectedVersion); if (v.expectedVersion > 999999997) invalid();
  communityText(v.displayName, 60); if (typeof v.enabled !== 'boolean') invalid();
}
export function validateCommunityConsent(v: unknown): asserts v is CommunityConsentInput {
  communityClosed(v, ['expectedVersion', 'enabled']); communityVersion(v.expectedVersion); if (v.expectedVersion > 999999997) invalid(); if (typeof v.enabled !== 'boolean') invalid();
}
function time(v: unknown) { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) invalid(); }
export function verifyCommunityRecord(v: unknown): CommunityRecord {
  communityClosed(v, ['id', 'version', 'kind', 'parentId', 'title', 'body', 'status', 'displayName', 'canEdit', 'reason', 'recordedAt']);
  communityUuid(v.id); communityVersion(v.version, 1); communityText(v.displayName, 60); time(v.recordedAt);
  if (typeof v.canEdit !== 'boolean' || (v.canEdit ? typeof v.reason !== 'string' : v.reason !== null) || (!v.canEdit && v.status !== 'PUBLISHED')) invalid();
  validateCommunityInput({ expectedVersion: 1, kind: v.kind, parentId: v.parentId, title: v.title, body: v.body, status: v.status, reason: v.reason ?? 'Published discussion' });
  return v as unknown as CommunityRecord;
}
export function verifyCommunityPage(v: unknown): CommunityPage {
  communityClosed(v, ['items', 'nextAfter', 'humanOnly', 'executionAllowed']);
  if (v.humanOnly !== true || v.executionAllowed !== false || !Array.isArray(v.items) || v.items.length > 30) invalid();
  let prior = ''; for (const x of v.items) { const r = verifyCommunityRecord(x); if (r.id <= prior) invalid(); prior = r.id; }
  if (v.nextAfter !== null) { communityUuid(v.nextAfter); if (v.items.length !== 30 || v.nextAfter !== prior) invalid(); }
  return v as unknown as CommunityPage;
}
export function verifyCommunityProfile(v: unknown): CommunityProfile {
  communityClosed(v, ['version', 'displayName', 'enabled', 'organizationVersion', 'organizationEnabled', 'canManageOrganization', 'humanOnly', 'executionAllowed']);
  communityVersion(v.version); communityVersion(v.organizationVersion); communityText(v.displayName, 60, v.version === 0);
  if ((v.version === 0 && (v.enabled !== false || v.displayName !== '')) || (v.organizationVersion === 0 && v.organizationEnabled !== false)
    || ['enabled', 'organizationEnabled', 'canManageOrganization'].some(k => typeof v[k] !== 'boolean') || v.humanOnly !== true || v.executionAllowed !== false) invalid();
  return v as unknown as CommunityProfile;
}
export function verifyCommunityHistory(v: unknown): CommunityHistory {
  communityClosed(v, ['id', 'items', 'nextBefore', 'humanOnly', 'executionAllowed']); communityUuid(v.id);
  if (!Array.isArray(v.items) || v.items.length > 30 || v.humanOnly !== true || v.executionAllowed !== false) invalid();
  let prior = 999999999; for (const x of v.items) { communityClosed(x, ['version', 'status', 'recordedAt']); communityVersion(x.version, 1); time(x.recordedAt); if (x.version >= prior || !COMMUNITY_STATUSES.includes(x.status as CommunityStatus)) invalid(); prior = x.version; }
  if (v.nextBefore !== null) { communityVersion(v.nextBefore, 1); if (v.items.length !== 30 || v.nextBefore !== prior) invalid(); }
  return v as unknown as CommunityHistory;
}
