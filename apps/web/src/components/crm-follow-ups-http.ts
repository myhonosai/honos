import { FOLLOW_UP_UUID, validateFollowUp, validateFollowUpDue, type FollowUpInput, type FollowUpTransition, type FollowUpOperation, type FollowUpRecord, type FollowUpQueue, type FollowUpStatus, type FollowUpQueueItem } from '@hon/contracts';
const base = '/api/v1/staff/crm/follow-ups';
export const followUpFingerprint = (v: unknown): string => JSON.stringify(v, (_, x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
export class FollowUpAccessError extends Error {}
function invalid(): never { throw new Error('Unverified result. No save assumed. Retry unchanged with the retained key or reload current records.'); }
function closed(v: unknown, keys: string[]): asserts v is Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid(); }
function uuid(v: unknown): asserts v is string { if (typeof v !== 'string' || !FOLLOW_UP_UUID.test(v)) invalid(); }
function time(v: unknown) { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) invalid(); }
function item(v: unknown): FollowUpQueueItem {
  closed(v, ['followUpId','leadId','assigneeId','version','status','priority','dueAt']);
  for (const id of [v.followUpId,v.leadId,v.assigneeId]) uuid(id);
  if (!Number.isSafeInteger(v.version) || Number(v.version) < 1 || Number(v.version) > 999999999 || !['OPEN','COMPLETED','CANCELLED'].includes(String(v.status)) || !['LOW','NORMAL','HIGH'].includes(String(v.priority))) invalid();
  validateFollowUpDue(v.dueAt); return v as unknown as FollowUpQueueItem;
}
function record(v: unknown): FollowUpRecord {
  closed(v, ['followUpId','schoolId','leadId','assigneeId','subject','note','dueAt','priority','version','status','recordedAt','completedAt','cancelledAt','humanOnly']);
  uuid(v.schoolId); time(v.recordedAt);
  item(Object.fromEntries(['followUpId','leadId','assigneeId','version','status','priority','dueAt'].map(k => [k,v[k]])));
  validateFollowUp('CREATE', { expectedVersion: 0, leadId: v.leadId, assigneeId: v.assigneeId, subject: v.subject, note: v.note, dueAt: v.dueAt, priority: v.priority });
  if (v.humanOnly !== true || (v.status === 'COMPLETED') !== (v.completedAt !== null) || (v.status === 'CANCELLED') !== (v.cancelledAt !== null)) invalid();
  if (v.completedAt !== null) time(v.completedAt); if (v.cancelledAt !== null) time(v.cancelledAt);
  return v as unknown as FollowUpRecord;
}
async function request(path: string, body?: FollowUpInput | FollowUpTransition, key?: string): Promise<unknown> {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-follow-ups', 'Idempotency-Key': key! } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new (response.status === 401 || response.status === 403 ? FollowUpAccessError : Error)(response.status === 401 ? 'Sign in with a verified human staff session.' : response.status === 403 ? 'Current exact school permission or assignment is unavailable. Reload after access is restored.' : response.status === 404 ? 'Record or known lead is unavailable in this school.' : response.status === 409 ? 'Version, lifecycle or retry conflict. Reload current records before changing input.' : 'No verified result. Retry unchanged with the retained key; check bounded fields.');
  const envelope: unknown = await response.json(); const data = (envelope as { data?: unknown })?.data; if (!data) invalid(); return data;
}
export async function loadFollowUps(queue: 'mine' | 'team', status: FollowUpStatus | 'ALL', after: string | null = null): Promise<FollowUpQueue> {
  if (!['mine','team'].includes(queue) || !['OPEN','COMPLETED','CANCELLED','ALL'].includes(status)) invalid(); if (after !== null) uuid(after);
  const v = await request(`?queue=${queue}&status=${status}${after ? `&after=${after}` : ''}`);
  return verifyFollowUpQueue(v, queue, status, after);
}
export async function readFollowUp(id: string): Promise<FollowUpRecord> { uuid(id); const r = record(await request(`/${id}`)); if (r.followUpId !== id.toLowerCase()) invalid(); return r; }
export async function mutateFollowUp(op: FollowUpOperation, id: string | null, input: FollowUpInput | FollowUpTransition, key: string): Promise<FollowUpRecord> {
  if (id !== null) uuid(id); validateFollowUp(op, input);
  if ((op === 'CREATE') !== (id === null) || typeof key !== 'string' || !key || key.length > 200 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) invalid();
  const path = op === 'CREATE' ? '' : op === 'UPDATE' ? `/${id}/revisions` : `/${id}/lifecycle/${op.toLowerCase()}`;
  const r = record(await request(path, input, key));
  if ((id && r.followUpId !== id.toLowerCase()) || r.version !== input.expectedVersion + 1 || r.status !== (op === 'COMPLETE' ? 'COMPLETED' : op === 'CANCEL' ? 'CANCELLED' : 'OPEN')) invalid();
  if ('subject' in input && followUpFingerprint({ leadId:r.leadId,assigneeId:r.assigneeId,subject:r.subject,note:r.note,dueAt:r.dueAt,priority:r.priority }) !== followUpFingerprint({ ...input, leadId: input.leadId.toLowerCase(), assigneeId: input.assigneeId.toLowerCase(), expectedVersion: undefined })) invalid();
  return r;
}

/** Same closed queue validator used by the connected human journey. */
export function verifyFollowUpQueue(v: unknown, queue: 'mine' | 'team', status: FollowUpStatus | 'ALL', after: string | null = null): FollowUpQueue {
  closed(v, ['schoolId','principalId','canManage','humanOnly','queue','status','items','nextAfter']); uuid(v.schoolId); uuid(v.principalId);
  if (v.humanOnly !== true || typeof v.canManage !== 'boolean' || v.queue !== queue || v.status !== status || (queue === 'team' && !v.canManage) || !Array.isArray(v.items) || v.items.length > 50) invalid();
  if (v.nextAfter !== null) { uuid(v.nextAfter); if (v.items.length !== 50 || v.nextAfter !== (v.items[49] as FollowUpQueueItem)?.followUpId) invalid(); }
  let previous = after?.toLowerCase() ?? null;
  for (const x of v.items) { const r = item(x); if ((previous && r.followUpId <= previous) || (queue === 'mine' && r.assigneeId !== v.principalId) || (status !== 'ALL' && r.status !== status)) invalid(); previous = r.followUpId; }
  return v as unknown as FollowUpQueue;
}
export const verifyFollowUpRecord = record;
