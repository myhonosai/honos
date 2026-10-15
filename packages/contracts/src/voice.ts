import type { CommandContext } from './index.js';

/** Catalog IDs are presentation metadata, never principal or invocation IDs. Eian is separate. */
export const VOICE_AGENT_CATALOG_IDS = ['alex', 'chad', 'maya', 'marcus', 'jordan', 'claire', 'lena'] as const;
export const VOICE_STATES = ['REQUESTED', 'VOICE_CONNECTING', 'VOICE_UNAVAILABLE', 'TEXT_FALLBACK', 'ENDED'] as const;
export const VOICE_REASON_CODES = ['NOT_CONFIGURED', 'CLIENT_OFFLINE', 'CLIENT_ERROR', 'PERMISSION_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'] as const;
export type VoiceState = typeof VOICE_STATES[number];
export type VoiceReasonCode = typeof VOICE_REASON_CODES[number];
export const VOICE_DRAFT_NOTICE = 'Text is a private draft. Saving text does not send a command.';
export const VOICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface VoiceContext extends CommandContext { externalSubject: string }
export interface CreateVoiceSession {
  agentCatalogId: typeof VOICE_AGENT_CATALOG_IDS[number];
  workItemId?: string;
  actionRequestId?: string;
  approvalId?: string;
  resumeSessionId?: string;
}
export interface VoiceStatusInput { expectedVersion: number; state: 'VOICE_CONNECTING' | 'VOICE_UNAVAILABLE'; reasonCode: VoiceReasonCode }
export interface VoiceFallbackInput { expectedVersion: number; reasonCode: VoiceReasonCode; draftText?: string }
export interface VoiceEndInput { expectedVersion: number }
export interface VoiceSession {
  id: string; organizationId: string; schoolId: string; actorPrincipalId: string;
  agentCatalogId: typeof VOICE_AGENT_CATALOG_IDS[number];
  workItemId: string | null; actionRequestId: string | null; approvalId: string | null; resumeSessionId: string | null;
  state: VoiceState; reasonCode: VoiceReasonCode | null; version: number;
  draftText: string | null; draftNotice: typeof VOICE_DRAFT_NOTICE;
  createdAt: string; updatedAt: string; expiresAt: string; expired: boolean;
  providerConnected: false; executionTriggered: false;
}
export interface VoiceReceipt { session: VoiceSession; receiptVersion: number; replayed: boolean }
export type VoiceOperation = 'create' | 'status' | 'mark-fallback' | 'end';

/** Deliberately conservative plain draft: no contacts, identifiers, links, markup or credential syntax. */
export function safeVoiceDraft(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 500 && value.trim() === value
    && /^[A-Za-z][A-Za-z .,!?'-]*$/.test(value)
    && !/\b(password|credential|secret|token|bearer|api|authorization|transcript|audio|email|phone|address|ssn|card)\b/i.test(value);
}
function closed(input: unknown, allowed: string[], required: string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(input, k))) throw new Error('VALIDATION_FAILED');
}
export function validateVoiceInput(operation: VoiceOperation, input: unknown): void {
  if (operation === 'create') {
    closed(input, ['agentCatalogId', 'workItemId', 'actionRequestId', 'approvalId', 'resumeSessionId'], ['agentCatalogId']);
    if (!VOICE_AGENT_CATALOG_IDS.includes(input.agentCatalogId as CreateVoiceSession['agentCatalogId'])) throw new Error('VALIDATION_FAILED');
    for (const k of ['workItemId', 'actionRequestId', 'approvalId', 'resumeSessionId']) if (Object.hasOwn(input, k) && (typeof input[k] !== 'string' || !VOICE_UUID.test(input[k]))) throw new Error('VALIDATION_FAILED');
    if ((input.approvalId && !input.actionRequestId) || (input.resumeSessionId && ['workItemId', 'actionRequestId', 'approvalId'].some(k => Object.hasOwn(input, k)))) throw new Error('VALIDATION_FAILED');
    return;
  }
  const keys = operation === 'status' ? ['expectedVersion', 'state', 'reasonCode'] : operation === 'mark-fallback' ? ['expectedVersion', 'reasonCode', 'draftText'] : ['expectedVersion'];
  closed(input, keys, keys.filter(k => k !== 'draftText'));
  if (!Number.isInteger(input.expectedVersion) || Number(input.expectedVersion) < 1 || Number(input.expectedVersion) >= 2147483647) throw new Error('VALIDATION_FAILED');
  if (operation !== 'end' && !VOICE_REASON_CODES.includes(input.reasonCode as VoiceReasonCode)) throw new Error('VALIDATION_FAILED');
  if (operation === 'status' && !['VOICE_CONNECTING', 'VOICE_UNAVAILABLE'].includes(String(input.state))) throw new Error('VALIDATION_FAILED');
  if (Object.hasOwn(input, 'draftText') && !safeVoiceDraft(input.draftText)) throw new Error('VALIDATION_FAILED');
}

/** Reject poisoned/expanded responses before exposing any draft or IDs to UI. */
export function validateVoiceSession(value: unknown): asserts value is VoiceSession {
  const keys = ['id','organizationId','schoolId','actorPrincipalId','agentCatalogId','workItemId','actionRequestId','approvalId','resumeSessionId','state','reasonCode','version','draftText','draftNotice','createdAt','updatedAt','expiresAt','expired','providerConnected','executionTriggered'];
  closed(value, keys, keys);
  for (const k of ['id','organizationId','schoolId','actorPrincipalId']) if (typeof value[k] !== 'string' || !VOICE_UUID.test(value[k])) throw new Error('UNVERIFIED_RESULT');
  for (const k of ['workItemId','actionRequestId','approvalId','resumeSessionId']) if (value[k] !== null && (typeof value[k] !== 'string' || !VOICE_UUID.test(value[k]))) throw new Error('UNVERIFIED_RESULT');
  if (!VOICE_AGENT_CATALOG_IDS.includes(value.agentCatalogId as CreateVoiceSession['agentCatalogId']) || !VOICE_STATES.includes(value.state as VoiceState)
    || (value.reasonCode !== null && !VOICE_REASON_CODES.includes(value.reasonCode as VoiceReasonCode))
    || !Number.isInteger(value.version) || Number(value.version) < 1 || Number(value.version) > 2147483647
    || (value.draftText !== null && !safeVoiceDraft(value.draftText)) || value.draftNotice !== VOICE_DRAFT_NOTICE
    || typeof value.expired !== 'boolean' || value.providerConnected !== false || value.executionTriggered !== false
    || (value.state === 'REQUESTED' && value.reasonCode !== null) || (value.state !== 'REQUESTED' && value.state !== 'ENDED' && value.reasonCode === null)
    || (value.draftText !== null && !['TEXT_FALLBACK','ENDED'].includes(String(value.state))) || (value.approvalId !== null && value.actionRequestId === null)) throw new Error('UNVERIFIED_RESULT');
  for (const k of ['createdAt','updatedAt','expiresAt']) if (typeof value[k] !== 'string' || !Number.isFinite(Date.parse(value[k])) || new Date(value[k]).toISOString() !== value[k]) throw new Error('UNVERIFIED_RESULT');
  if (Date.parse(String(value.updatedAt)) < Date.parse(String(value.createdAt)) || Date.parse(String(value.expiresAt)) <= Date.parse(String(value.createdAt))) throw new Error('UNVERIFIED_RESULT');
}
