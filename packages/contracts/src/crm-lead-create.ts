import type { CreateLeadInput } from './index.js';

/** Narrow direct-human intake edge; the canonical service retains its other callers. */
export type CreateHumanCrmLeadInput = Pick<CreateLeadInput, 'pipelineId' | 'pipelineStageId' | 'primaryContact'>;
export const CRM_LEAD_CREATE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
function invalid(): never { throw new Error('Enter known pipeline/stage UUIDs and a bounded minimal primary contact. No other command fields are accepted.'); }
function closed(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max || UNSAFE_TEXT.test(value)) invalid();
}
export function validateCreateHumanCrmLeadInput(value: unknown): asserts value is CreateHumanCrmLeadInput {
  closed(value, ['pipelineId', 'pipelineStageId', 'primaryContact']);
  for (const key of ['pipelineId', 'pipelineStageId']) if (typeof value[key] !== 'string' || !CRM_LEAD_CREATE_UUID.test(value[key])) invalid();
  closed(value.primaryContact, ['givenName', 'familyName'], ['email', 'phoneE164']);
  const contact = value.primaryContact;
  text(contact.givenName, 120); text(contact.familyName, 120);
  if (Object.hasOwn(contact, 'email')) {
    text(contact.email, 320);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) invalid();
  }
  if (Object.hasOwn(contact, 'phoneE164') && (typeof contact.phoneE164 !== 'string' || !/^\+[1-9]\d{1,14}$/.test(contact.phoneE164))) invalid();
}
