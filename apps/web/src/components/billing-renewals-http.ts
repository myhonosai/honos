import { RENEWAL_UUID, RENEWAL_STATUSES, validateRenewal, validateRenewalTime, type RenewalInput, type RenewalOperation, type RenewalRecord, type RenewalQueue, type RenewalStatus, type RenewalQueueItem, type RenewalMembershipFacts, type RenewalDetail, type RenewalHistory } from '@hon/contracts';
const base = '/api/v1/staff/billing/renewals';
export const renewalFingerprint = (v: unknown): string => JSON.stringify(v, (_, x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
export class RenewalAccessError extends Error {}
function invalid(): never { throw new Error('Unverified result. No save assumed. Retry unchanged with the retained key or reload current records.'); }
function closed(v: unknown, keys: string[]): asserts v is Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid(); }
function uuid(v: unknown): asserts v is string { if (typeof v !== 'string' || !RENEWAL_UUID.test(v) || v !== v.toLowerCase()) invalid(); }
function integer(v: unknown, min = 1, max = 999999999): asserts v is number { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) invalid(); }
function time(v: unknown) { if (v === null) invalid(); factTime(v); }
function factTime(v: unknown) { if (v !== null && (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v)) invalid(); }
export function verifyRenewalFacts(v: unknown): RenewalMembershipFacts {
  closed(v, ['membershipId', 'membershipVersion', 'state', 'termStartedAt', 'termEndsAt', 'scheduleCount', 'schedulesTruncated', 'schedules']);
  uuid(v.membershipId); integer(v.membershipVersion, 1, 2147483647);
  if (!['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'].includes(String(v.state))) invalid();
  factTime(v.termStartedAt); factTime(v.termEndsAt); integer(v.scheduleCount, 0, 2147483647);
  if (typeof v.schedulesTruncated !== 'boolean' || v.schedulesTruncated !== (v.scheduleCount > 20) || !Array.isArray(v.schedules) || v.schedules.length !== Math.min(20, v.scheduleCount)) invalid();
  let previous = '';
  for (const s of v.schedules) {
    closed(s, ['scheduleId', 'frequency', 'status', 'amountMinor', 'currency', 'nextChargeAt', 'autoRenew']);
    uuid(s.scheduleId); if (s.scheduleId <= previous) invalid(); previous = s.scheduleId;
    integer(s.amountMinor, 1, 2147483647); factTime(s.nextChargeAt);
    if (!['WEEKLY', 'MONTHLY', 'ANNUAL', 'CUSTOM'].includes(String(s.frequency)) || !['ACTIVE', 'PAUSED', 'CANCELLED'].includes(String(s.status)) || typeof s.currency !== 'string' || !/^[A-Z]{3}$/.test(s.currency) || typeof s.autoRenew !== 'boolean') invalid();
  }
  return v as unknown as RenewalMembershipFacts;
}
const itemKeys = ['renewalId', 'membershipId', 'version', 'status', 'reviewFrom', 'reviewTo', 'reminderNeeded'];
function item(v: unknown): RenewalQueueItem {
  closed(v, itemKeys); uuid(v.renewalId); uuid(v.membershipId); integer(v.version);
  validateRenewalTime(v.reviewFrom); validateRenewalTime(v.reviewTo);
  const duration = Date.parse(v.reviewTo) - Date.parse(v.reviewFrom);
  if (duration < 60000 || duration > 366 * 86400000 || !RENEWAL_STATUSES.includes(v.status as RenewalStatus) || (v.reminderNeeded !== null && typeof v.reminderNeeded !== 'boolean')) invalid();
  return v as unknown as RenewalQueueItem;
}
function record(v: unknown): RenewalRecord {
  closed(v, [...itemKeys, 'schoolId', 'note', 'reason', 'recordedAt', 'membershipFacts', 'humanOnly', 'executionAllowed']);
  uuid(v.schoolId); time(v.recordedAt); item(Object.fromEntries(itemKeys.map(k => [k, v[k]])));
  validateRenewal('REVISE', { expectedVersion: 1, membershipId: v.membershipId, reviewFrom: v.reviewFrom, reviewTo: v.reviewTo, status: v.status, note: v.note, reason: v.reason, reminderNeeded: v.reminderNeeded });
  const facts = verifyRenewalFacts(v.membershipFacts);
  if (facts.membershipId !== v.membershipId || v.humanOnly !== true || v.executionAllowed !== false) invalid();
  return v as unknown as RenewalRecord;
}
async function request(path: string, body?: RenewalInput, key?: string): Promise<unknown> {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing-renewals', 'Idempotency-Key': key! } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new (response.status === 401 || response.status === 403 ? RenewalAccessError : Error)(response.status === 401 ? 'Sign in with a verified human staff session.' : response.status === 403 ? 'Current exact school membership-read and renewal-manage staff permission is unavailable. Reload after access is restored.' : response.status === 404 ? 'Review or already-known membership is unavailable in this school.' : response.status === 409 ? 'Version, closed-review or retry conflict. Reload current records before changing input.' : 'No verified result. Retry unchanged with the retained key; check bounded fields.');
  const envelope: unknown = await response.json(); const data = (envelope as { data?: unknown })?.data; if (!data) invalid(); return data;
}
export async function loadRenewals(status: RenewalStatus | 'ALL', after: string | null = null): Promise<RenewalQueue> {
  if (![...RENEWAL_STATUSES, 'ALL'].includes(status)) invalid(); if (after !== null) uuid(after);
  const v = await request(`?status=${status}${after ? `&after=${after}` : ''}`);
  closed(v, ['schoolId', 'principalId', 'humanOnly', 'executionAllowed', 'status', 'items', 'nextAfter']); uuid(v.schoolId); uuid(v.principalId);
  if (v.humanOnly !== true || v.executionAllowed !== false || v.status !== status || !Array.isArray(v.items) || v.items.length > 50) invalid();
  if (v.nextAfter !== null) { uuid(v.nextAfter); if (v.items.length !== 50 || v.nextAfter !== (v.items[49] as RenewalQueueItem)?.renewalId) invalid(); }
  let previous = after ?? '';
  for (const x of v.items) { const r = item(x); if (r.renewalId <= previous || (status !== 'ALL' && r.status !== status)) invalid(); previous = r.renewalId; }
  return v as unknown as RenewalQueue;
}
export async function readRenewal(id: string, version: number | null = null): Promise<RenewalDetail> {
  uuid(id); if (version !== null) integer(version); const v = await request(`/${id}${version === null ? '' : `?version=${version}`}`); closed(v, ['record', 'currentMembershipFacts']);
  const r = record(v.record), facts = verifyRenewalFacts(v.currentMembershipFacts);
  if (r.renewalId !== id || (version !== null && r.version !== version) || facts.membershipId !== r.membershipId) invalid(); return v as unknown as RenewalDetail;
}
export async function readRenewalMembership(id: string): Promise<RenewalMembershipFacts> {
  uuid(id); const facts = verifyRenewalFacts(await request(`/memberships/${id}`)); if (facts.membershipId !== id) invalid(); return facts;
}
export async function loadRenewalHistory(id: string, before: number | null = null): Promise<RenewalHistory> {
  uuid(id); if (before !== null) integer(before);
  const v = await request(`/${id}/history${before === null ? '' : `?before=${before}`}`);
  closed(v, ['schoolId', 'renewalId', 'humanOnly', 'executionAllowed', 'items', 'nextBefore']); uuid(v.schoolId);
  if (v.renewalId !== id || v.humanOnly !== true || v.executionAllowed !== false || !Array.isArray(v.items) || v.items.length > 50) invalid();
  let previous = before ?? 1000000000; let membership = '';
  for (const x of v.items) {
    closed(x, [...itemKeys, 'recordedAt']); const r = item(Object.fromEntries(itemKeys.map(k => [k, x[k]]))); time(x.recordedAt);
    if (r.renewalId !== id || r.version >= previous || (membership && r.membershipId !== membership)) invalid(); previous = r.version; membership = r.membershipId;
  }
  if (v.nextBefore !== null) { integer(v.nextBefore); if (v.items.length !== 50 || v.nextBefore !== previous) invalid(); }
  return v as unknown as RenewalHistory;
}
export async function mutateRenewal(op: RenewalOperation, id: string | null, input: RenewalInput, key: string): Promise<RenewalRecord> {
  if (id !== null) uuid(id); validateRenewal(op, input);
  if ((op === 'CREATE') !== (id === null) || typeof key !== 'string' || !key || key.length > 200 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) invalid();
  const r = record(await request(op === 'CREATE' ? '' : `/${id}/revisions`, input, key));
  if ((id && r.renewalId !== id) || r.version !== input.expectedVersion + 1) invalid();
  const fields = { membershipId: r.membershipId, reviewFrom: r.reviewFrom, reviewTo: r.reviewTo, status: r.status, note: r.note, reason: r.reason, reminderNeeded: r.reminderNeeded };
  if (renewalFingerprint(fields) !== renewalFingerprint({ ...input, membershipId: input.membershipId.toLowerCase(), expectedVersion: undefined })) invalid();
  return r;
}
