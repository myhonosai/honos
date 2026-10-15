import type { CommandContext } from './index.js';
export const CRM_FOLLOW_UP_PERMISSIONS = ['crm.follow_up.self_manage', 'crm.follow_up.manage'] as const;
export type FollowUpOperation = 'CREATE' | 'UPDATE' | 'COMPLETE' | 'CANCEL' | 'REOPEN';
export type FollowUpStatus = 'OPEN' | 'COMPLETED' | 'CANCELLED';
export type FollowUpPriority = 'LOW' | 'NORMAL' | 'HIGH';
export interface FollowUpContext extends CommandContext { externalSubject: string }
export interface FollowUpFields { leadId: string; assigneeId: string; subject: string; note: string; dueAt: string | null; priority: FollowUpPriority }
export interface FollowUpInput extends FollowUpFields { expectedVersion: number }
export interface FollowUpTransition { expectedVersion: number }
export interface FollowUpRecord extends FollowUpFields {
  followUpId: string; schoolId: string; version: number; status: FollowUpStatus;
  recordedAt: string; completedAt: string | null; cancelledAt: string | null; humanOnly: true;
}
/** No subject, note, lead contact or directory fields in either queue. */
export interface FollowUpQueueItem {
  followUpId: string; leadId: string; assigneeId: string; version: number;
  status: FollowUpStatus; priority: FollowUpPriority; dueAt: string | null;
}
export interface FollowUpQueue {
  schoolId: string; principalId: string; canManage: boolean; humanOnly: true;
  queue: 'mine' | 'team'; status: FollowUpStatus | 'ALL'; items: FollowUpQueueItem[]; nextAfter: string | null;
}
export const CRM_FOLLOW_UP_HELP = 'Human follow-up records only, available equally in Essential, Core and Complete. Due dates are planning metadata, not scheduled reminders. Completing a record confirms only your human recordkeeping: no outreach is sent and no lead stage, trial, appointment, membership or payment changes. No AI, automation, provider or Action Engine execution or proposal. Parent, HQ and public access are excluded.';
export const FOLLOW_UP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('Use the closed follow-up contract, known school IDs, bounded plain text, canonical UTC due date and current expected version.'); }
function closed(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid();
}
export function validateFollowUpDue(v: unknown): asserts v is string | null {
  if (v === null) return;
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) invalid();
}
export function validateFollowUp(op: FollowUpOperation, v: unknown): asserts v is FollowUpInput | FollowUpTransition {
  if (!['CREATE', 'UPDATE', 'COMPLETE', 'CANCEL', 'REOPEN'].includes(op)) invalid();
  const fields = op === 'CREATE' || op === 'UPDATE';
  closed(v, fields ? ['expectedVersion', 'leadId', 'assigneeId', 'subject', 'note', 'dueAt', 'priority'] : ['expectedVersion']);
  if (!Number.isSafeInteger(v.expectedVersion) || Number(v.expectedVersion) < (op === 'CREATE' ? 0 : 1) || Number(v.expectedVersion) > 999999998 || (op === 'CREATE' && v.expectedVersion !== 0)) invalid();
  if (!fields) return;
  for (const k of ['leadId', 'assigneeId']) if (typeof v[k] !== 'string' || !FOLLOW_UP_UUID.test(v[k])) invalid();
  for (const k of ['subject', 'note']) {
    const s = v[k];
    if (typeof s !== 'string' || [...s].length > (k === 'subject' ? 120 : 2000) || (k === 'subject' && !s) || s.trim() !== s || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(k === 'note' ? s.replaceAll('\n', '') : s)) invalid();
  }
  validateFollowUpDue(v.dueAt);
  if (!['LOW', 'NORMAL', 'HIGH'].includes(String(v.priority))) invalid();
}
