import type { ParentFamilyAccessLevel } from './index.js';

/** The current queue stores intent only; it has no provider delivery or receipt evidence. */
export interface ParentMessageHistoryUnavailable {
  status: 'UNAVAILABLE';
  reason: 'RECEIPT_EVIDENCE_UNAVAILABLE';
  items: [];
  limited: false;
}

/**
 * Read-only guardian-family message history result. No content is returned until
 * a separately reviewed, provable delivery/receipt source and redacted projection exist.
 */
export interface ParentMessageHistoryView {
  generatedAt: string;
  accessLevel: Exclude<ParentFamilyAccessLevel, 'VIEWER'>;
  messages: ParentMessageHistoryUnavailable;
}

function invalid(): never { throw new Error('Parent message-history response could not be verified.'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return new Date(value).toISOString();
}

/** Reject unknown fields and any fabricated message, recipient, sender, delivery, or scope detail. */
export function verifyParentMessageHistoryView(value: unknown): ParentMessageHistoryView {
  const record = object(value, ['generatedAt', 'accessLevel', 'messages']);
  const generatedAt = timestamp(record.generatedAt);
  if (typeof record.accessLevel !== 'string' || !['PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN'].includes(record.accessLevel)) invalid();
  const messages = object(record.messages, ['status', 'reason', 'items', 'limited']);
  if (messages.status !== 'UNAVAILABLE' || messages.reason !== 'RECEIPT_EVIDENCE_UNAVAILABLE' || !Array.isArray(messages.items) || messages.items.length !== 0 || messages.limited !== false) invalid();
  return {
    generatedAt,
    accessLevel: record.accessLevel as Exclude<ParentFamilyAccessLevel, 'VIEWER'>,
    messages: { status: 'UNAVAILABLE', reason: 'RECEIPT_EVIDENCE_UNAVAILABLE', items: [], limited: false },
  };
}
