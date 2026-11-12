import { CRM_LEAD_CREATE_UUID, validateCreateHumanCrmLeadInput, type CreateHumanCrmLeadInput } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import { LeadsError, type LeadsScope, type Owned } from './http';

/**
 * First-lead setup for the school the shell verified: read the school's lead stages, add the server-defined starter
 * stages when there are none, and turn the typed form into the closed lead-create input. The API re-derives the human,
 * school and permission from the signed session; ids here are selectors only.
 */
export type PipelineStage = Readonly<{ id: string; name: string; position: number; terminalStatus?: 'WON' | 'LOST' | 'ARCHIVED' }>;
export type PipelineOption = Readonly<{ id: string; name: string; version: number; createdAt: string; stages: readonly PipelineStage[] }>;
export type StageChoice = Readonly<{ pipelineId: string; stageId: string; label: string }>;
export type LeadForm = Readonly<{ givenName: string; familyName: string; email: string; phone: string }>;
export type LeadFormProblem = 'nameMissing' | 'emailInvalid' | 'phoneInvalid' | 'stageMissing';
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
/** The server answered the starter command with a definite refusal (not an unknown outcome): its key must not be resent. */
export class StarterRefusedError extends Error { constructor() { super('STARTER_REFUSED'); } }

function bad(): never { throw new LeadsError('UNAVAILABLE'); }
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !CRM_LEAD_CREATE_UUID.test(value)) bad(); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
  const present = Object.keys(value);
  if (keys.some((key) => !present.includes(key)) || present.some((key) => !keys.includes(key) && !optional.includes(key))) bad();
}
function name(value: unknown, max: number): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max) bad(); }

function verifyPipeline(value: unknown): PipelineOption {
  record(value, ['id', 'name', 'version', 'createdAt', 'stages']);
  uuid(value.id); name(value.name, 120);
  if (!Number.isSafeInteger(value.version) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.stages) || value.stages.length > 50) bad();
  const stages = value.stages.map((stage: unknown): PipelineStage => {
    record(stage, ['id', 'name', 'position'], ['terminalStatus']);
    uuid(stage.id); name(stage.name, 80);
    if (!Number.isSafeInteger(stage.position) || (stage.terminalStatus !== undefined && !['WON', 'LOST', 'ARCHIVED'].includes(stage.terminalStatus as string))) bad();
    const verified: { id: string; name: string; position: number; terminalStatus?: 'WON' | 'LOST' | 'ARCHIVED' } = { id: stage.id, name: stage.name, position: stage.position as number };
    if (stage.terminalStatus) verified.terminalStatus = stage.terminalStatus as 'WON' | 'LOST' | 'ARCHIVED';
    return Object.freeze(verified);
  });
  return Object.freeze({ id: value.id, name: value.name, version: value.version as number, createdAt: value.createdAt, stages: Object.freeze(stages) });
}

function base(scope: LeadsScope): string {
  if (!CRM_LEAD_CREATE_UUID.test(scope.organizationId) || !CRM_LEAD_CREATE_UUID.test(scope.schoolId)) bad();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/crm/pipelines`;
}

async function body(response: Response, statuses: readonly number[], owned: Owned): Promise<Record<string, unknown>> {
  if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new LeadsError('SESSION'); }
  if (response.status === 403) throw new LeadsError('DENIED');
  if (!statuses.includes(response.status) || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) bad();
  let parsed: unknown;
  try { parsed = await response.json(); } catch { bad(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'data,meta') bad();
  return parsed as Record<string, unknown>;
}

async function pipelines(scope: LeadsScope, signal: AbortSignal, owned: Owned): Promise<readonly PipelineOption[]> {
  const path = base(scope);
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  } catch (error) { if (signal.aborted) throw error; bad(); }
  signal.throwIfAborted();
  const parsed = await body(response, [200], owned);
  if (!Array.isArray(parsed.data) || parsed.data.length > 50) bad();
  return Object.freeze(parsed.data.map(verifyPipeline));
}

/** The caller makes the key on the explicit button press and reuses it only to retry that same press. */
async function setUpStarter(scope: LeadsScope, key: string): Promise<PipelineOption> {
  if (!CRM_LEAD_CREATE_UUID.test(key)) throw new Error('A fresh idempotency key is required.');
  const path = `${base(scope)}/starter`;
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'crm-pipeline-starter' }, body: '{}' });
  } catch { bad(); }
  if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403) throw new StarterRefusedError();
  const parsed = await body(response, [200, 201], () => true);
  return verifyPipeline(parsed.data);
}

export interface AddLeadApi {
  pipelines(scope: LeadsScope, signal: AbortSignal, owned: Owned): Promise<readonly PipelineOption[]>;
  setUpStarter(scope: LeadsScope, key: string): Promise<PipelineOption>;
}
export const addLeadApi: AddLeadApi = { pipelines, setUpStarter };

/** Open (non-terminal) stages only: a lead can never be created already won or lost. */
export function openStageChoices(items: readonly PipelineOption[]): StageChoice[] {
  const many = items.length > 1;
  return items.flatMap((pipeline) => [...pipeline.stages].filter((stage) => !stage.terminalStatus).sort((a, b) => a.position - b.position)
    .map((stage) => ({ pipelineId: pipeline.id, stageId: stage.id, label: many ? `${pipeline.name} · ${stage.name}` : stage.name })));
}

/** Accepts the ways people type phone numbers; US/Canada numbers without a country code get +1. */
export function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

export function buildLeadInput(form: LeadForm, choice: StageChoice | null): { ok: true; input: CreateHumanCrmLeadInput } | { ok: false; problem: LeadFormProblem } {
  const givenName = form.givenName.trim(), familyName = form.familyName.trim(), email = form.email.trim(), phone = form.phone.trim();
  if (!givenName || !familyName || givenName.length > 120 || familyName.length > 120) return { ok: false, problem: 'nameMissing' };
  if (email && (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { ok: false, problem: 'emailInvalid' };
  const phoneE164 = phone ? normalizePhone(phone) : null;
  if (phone && !phoneE164) return { ok: false, problem: 'phoneInvalid' };
  if (!choice) return { ok: false, problem: 'stageMissing' };
  const input: CreateHumanCrmLeadInput = { pipelineId: choice.pipelineId, pipelineStageId: choice.stageId,
    primaryContact: { givenName, familyName, ...(email ? { email } : {}), ...(phoneE164 ? { phoneE164 } : {}) } };
  try { validateCreateHumanCrmLeadInput(input); } catch { return { ok: false, problem: 'nameMissing' }; }
  return { ok: true, input };
}
