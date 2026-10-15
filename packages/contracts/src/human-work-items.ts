import type { CommandContext } from './index.js';
export const HUMAN_WORK_STATUSES = ['READY','WORKING','WAITING','NEEDS_ATTENTION','COMPLETED','FAILED'] as const;
export type HumanWorkStatus = typeof HUMAN_WORK_STATUSES[number];
export type HumanWorkOperation = 'CREATE' | 'UPDATE' | 'TRANSITION';
export interface HumanWorkContext extends CommandContext { externalSubject: string }
export interface HumanWorkFields { title: string; description: string; priority: 'LOW' | 'NORMAL' | 'HIGH'; dueAt: string | null; assigneeId: string | null }
export interface HumanWorkInput extends HumanWorkFields { expectedVersion: number }
export interface HumanWorkTransition { expectedVersion: number; targetStatus: HumanWorkStatus }
/** Queues expose only the bounded human title plus planning metadata; no description, directory/contact or raw AI fields. */
export interface HumanWorkQueueItem { title: string; workItemId: string; version: number; status: HumanWorkStatus; priority: HumanWorkFields['priority']; dueAt: string | null; assigneeId: string | null }
export interface HumanWorkHistory { version: number; operation: HumanWorkOperation; status: HumanWorkStatus; assigneeId: string | null; actorId: string; recordedAt: string }
export interface HumanWorkRecord extends HumanWorkFields {
  workItemId: string; schoolId: string; version: number; status: HumanWorkStatus; createdBy: string; createdAt: string; updatedAt: string;
  humanOnly: true; executionAllowed: false; canEdit: boolean; canTransition: boolean; aiPlanIds: string[];
  history: HumanWorkHistory[]; nextBeforeVersion: number | null;
}
export interface HumanWorkQueue {
  schoolId: string; principalId: string; canManage: boolean; canCreate: boolean; humanOnly: true; executionAllowed: false;
  queue: 'mine' | 'team'; status: HumanWorkStatus | 'ACTIVE' | 'ALL'; items: HumanWorkQueueItem[]; nextAfter: string | null;
}
export const HUMAN_WORK_HELP = 'Human records only, equally available in Essential, Core and Complete. Due dates do not schedule reminders or execution. Marking completed records a human decision, not proof of an AI employee or provider doing work. No AI, Action Engine, payments, marketing or communication execution. Known staff IDs only; no directory or external recipients.';
export const HUMAN_WORK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('Use closed bounded human work fields, known school IDs, canonical UTC due date and current version.'); }
export function validateHumanWorkDue(v: unknown): asserts v is string | null {
  if (v === null) return;
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) invalid();
}
export function validateHumanWork(op: HumanWorkOperation, v: unknown): asserts v is HumanWorkInput | HumanWorkTransition {
  if (!['CREATE','UPDATE','TRANSITION'].includes(op)) invalid();
  const keys = op === 'TRANSITION' ? ['expectedVersion','targetStatus'] : ['expectedVersion','title','description','priority','dueAt','assigneeId'];
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))) invalid();
  const p = v as Record<string,unknown>;
  if (!Number.isSafeInteger(p.expectedVersion) || Number(p.expectedVersion) < (op === 'CREATE' ? 0 : 1) || Number(p.expectedVersion) > 999999998 || (op === 'CREATE' && p.expectedVersion !== 0)) invalid();
  if (op === 'TRANSITION') { if (!(HUMAN_WORK_STATUSES as readonly unknown[]).includes(p.targetStatus)) invalid(); return; }
  for (const key of ['title','description']) {
    const s = p[key];
    if (typeof s !== 'string' || [...s].length > (key === 'title' ? 120 : 2000) || (key === 'title' && !s) || s.trim() !== s || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(key === 'description' ? s.replaceAll('\n','') : s)) invalid();
  }
  if (p.assigneeId !== null && (typeof p.assigneeId !== 'string' || !HUMAN_WORK_UUID.test(p.assigneeId))) invalid();
  if (!['LOW','NORMAL','HIGH'].includes(String(p.priority))) invalid();
  validateHumanWorkDue(p.dueAt);
}
