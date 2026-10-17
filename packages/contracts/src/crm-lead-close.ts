import type { CommandContext } from './index.js';

export const CRM_LEAD_CLOSE_PERMISSION = 'crm.lead.close' as const;
export const CRM_LEAD_CLOSE_STATUSES = ['WON', 'LOST'] as const;
export const CRM_LEAD_CLOSE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface CrmLeadCloseContext extends CommandContext { externalSubject: string }
export interface CloseCrmLeadInput { status: 'WON' | 'LOST'; expectedVersion: number; closeNote?: string }
/** A historical CRM command receipt, never an enrollment/payment/conversion fact. */
export interface CrmLeadCloseReceipt {
  organizationId: string; schoolId: string; leadId: string;
  status: 'WON' | 'LOST'; priorVersion: number; version: number;
  closedAt: string; closeNote: string | null; crmOnly: true;
}
function invalid(): never { throw new Error('Use exactly WON or LOST, the authorized OPEN lead version, and an optional bounded plain internal close note.'); }
export function validateCrmLeadCloseNote(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || [...value].length > 2000
    || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value.replaceAll('\n', ''))) invalid();
}
export function validateCloseCrmLeadInput(value: unknown): asserts value is CloseCrmLeadInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const v = value as Record<string, unknown>;
  if (!Object.hasOwn(v, 'status') || !Object.hasOwn(v, 'expectedVersion')
    || Object.keys(v).some(k => !['status', 'expectedVersion', 'closeNote'].includes(k))
    || !CRM_LEAD_CLOSE_STATUSES.includes(v.status as 'WON' | 'LOST')
    || !Number.isSafeInteger(v.expectedVersion) || Number(v.expectedVersion) < 1 || Number(v.expectedVersion) > 999999998) invalid();
  if (Object.hasOwn(v, 'closeNote')) validateCrmLeadCloseNote(v.closeNote);
}
