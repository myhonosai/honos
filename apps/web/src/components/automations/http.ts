import {
  AUTOMATION_ACTIVATE_COMMAND, AUTOMATION_CREATE_COMMAND, AUTOMATION_PAUSE_COMMAND, AUTOMATION_SAVE_COMMAND,
  validateAutomationActivateInput, validateAutomationCreateInput, validateAutomationPauseInput, validateAutomationSaveInput,
  verifyAutomationRunList, verifyAutomationWorkflowDetail, verifyAutomationWorkflowList,
  type AutomationDefinition, type AutomationRunList, type AutomationWorkflowDetail, type AutomationWorkflowList,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * AU-1/AU-2 automation calls for the school the shell verified. Ids are selectors only: the API re-derives the human, the
 * school and the permission from the signed session. Reads are same-origin GETs; each command is its own browser command
 * with a key made on the press and reused only to retry that same uncertain press.
 */
export type AutomationScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type ReadErrorKind = 'SESSION' | 'DENIED' | 'UNAVAILABLE';
export class AutomationReadError extends Error { constructor(readonly kind: ReadErrorKind) { super(kind); } }
export type CommandErrorKind = 'REJECTED' | 'CONFLICT' | 'DENIED' | 'SESSION' | 'UNCERTAIN';
export class AutomationCommandError extends Error { constructor(readonly kind: CommandErrorKind, readonly code: string | null = null) { super(kind); } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
function id(value: string): string { if (!UUID.test(value)) throw new AutomationReadError('UNAVAILABLE'); return value.toLowerCase(); }
export function automationsPath(scope: AutomationScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/automations`; }

async function read(path: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' }, signal });
  } catch (error) { if (signal.aborted) throw error; throw new AutomationReadError('UNAVAILABLE'); }
  signal.throwIfAborted();
  if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new AutomationReadError('SESSION'); }
  if (response.status === 403) throw new AutomationReadError('DENIED');
  if (response.status !== 200 || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new AutomationReadError('UNAVAILABLE');
  let body: unknown;
  try { body = await response.json(); } catch { throw new AutomationReadError('UNAVAILABLE'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'data,meta') throw new AutomationReadError('UNAVAILABLE');
  return (body as { data: unknown }).data;
}

export async function listAutomations(scope: AutomationScope, signal: AbortSignal, owned: Owned): Promise<AutomationWorkflowList> {
  const data = await read(automationsPath(scope), signal, owned);
  try { return verifyAutomationWorkflowList(data); } catch { throw new AutomationReadError('UNAVAILABLE'); }
}
export async function readAutomation(scope: AutomationScope, workflowId: string, signal: AbortSignal, owned: Owned): Promise<AutomationWorkflowDetail> {
  const data = await read(`${automationsPath(scope)}/${id(workflowId)}`, signal, owned);
  try {
    const detail = verifyAutomationWorkflowDetail(data);
    if (detail.workflow.workflowId.toLowerCase() !== workflowId.toLowerCase()) throw new Error('drift');
    return detail;
  } catch { throw new AutomationReadError('UNAVAILABLE'); }
}
export async function readRuns(scope: AutomationScope, workflowId: string, signal: AbortSignal, owned: Owned): Promise<AutomationRunList> {
  const data = await read(`${automationsPath(scope)}/${id(workflowId)}/runs`, signal, owned);
  try {
    const runs = verifyAutomationRunList(data);
    if (runs.workflowId.toLowerCase() !== workflowId.toLowerCase()) throw new Error('drift');
    return runs;
  } catch { throw new AutomationReadError('UNAVAILABLE'); }
}

type Command = typeof AUTOMATION_CREATE_COMMAND | typeof AUTOMATION_SAVE_COMMAND | typeof AUTOMATION_ACTIVATE_COMMAND | typeof AUTOMATION_PAUSE_COMMAND;
export type PreparedAutomationCommand = Readonly<{ path: string; key: string; body: string; command: Command; target: string | null }>;
function keyed(key: string): string { if (!UUID.test(key)) throw new AutomationCommandError('REJECTED'); return key; }

export function prepareCreate(scope: AutomationScope, name: string, definition: AutomationDefinition, key: string): PreparedAutomationCommand {
  const input = validateAutomationCreateInput({ name, definition });
  return Object.freeze({ path: automationsPath(scope), key: keyed(key), body: JSON.stringify(input), command: AUTOMATION_CREATE_COMMAND, target: null });
}
export function prepareSave(scope: AutomationScope, workflowId: string, expectedRevision: number, name: string, definition: AutomationDefinition, key: string): PreparedAutomationCommand {
  const input = validateAutomationSaveInput({ expectedRevision, name, definition });
  return Object.freeze({ path: `${automationsPath(scope)}/${id(workflowId)}/versions`, key: keyed(key), body: JSON.stringify(input), command: AUTOMATION_SAVE_COMMAND, target: id(workflowId) });
}
export function prepareActivate(scope: AutomationScope, workflowId: string, expectedRevision: number, version: number, key: string): PreparedAutomationCommand {
  const input = validateAutomationActivateInput({ expectedRevision, version });
  return Object.freeze({ path: `${automationsPath(scope)}/${id(workflowId)}/activate`, key: keyed(key), body: JSON.stringify(input), command: AUTOMATION_ACTIVATE_COMMAND, target: id(workflowId) });
}
export function preparePause(scope: AutomationScope, workflowId: string, expectedRevision: number, key: string): PreparedAutomationCommand {
  const input = validateAutomationPauseInput({ expectedRevision });
  return Object.freeze({ path: `${automationsPath(scope)}/${id(workflowId)}/pause`, key: keyed(key), body: JSON.stringify(input), command: AUTOMATION_PAUSE_COMMAND, target: id(workflowId) });
}

/** Sends one prepared command and returns the verified workflow detail it answers with. */
export async function submitAutomationCommand(request: PreparedAutomationCommand): Promise<AutomationWorkflowDetail> {
  let response: Response;
  try {
    response = await fetch(request.path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': request.key, 'X-HON-Human-Command': request.command }, body: request.body });
  } catch { throw new AutomationCommandError('UNCERTAIN'); }
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new AutomationCommandError('SESSION'); }
  if (response.status === 403) throw new AutomationCommandError('DENIED');
  if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
    let code: string | null = null;
    try { const raw: unknown = await response.json(); const value = raw && typeof raw === 'object' ? (raw as { code?: unknown }).code : undefined; if (typeof value === 'string' && CODE.test(value)) code = value; } catch { /* closed answer */ }
    if (code === 'IDEMPOTENCY_IN_PROGRESS') throw new AutomationCommandError('UNCERTAIN', code);
    throw new AutomationCommandError(response.status === 409 ? 'CONFLICT' : 'REJECTED', code);
  }
  let data: unknown;
  try {
    if (response.status !== 200 || response.redirected || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new Error('shape');
    const raw = await response.text(); if (raw.length > 400000) throw new Error('size');
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'data,meta') throw new Error('shape');
    data = (body as { data: unknown }).data;
  } catch { throw new AutomationCommandError('UNCERTAIN'); }
  try {
    const detail = verifyAutomationWorkflowDetail(data);
    if (request.target && detail.workflow.workflowId.toLowerCase() !== request.target) throw new Error('drift');
    return detail;
  } catch { throw new AutomationCommandError('UNCERTAIN'); }
}

export interface AutomationsApi {
  list: typeof listAutomations; detail: typeof readAutomation; runs: typeof readRuns; submit: typeof submitAutomationCommand;
}
export const automationsApi: AutomationsApi = { list: listAutomations, detail: readAutomation, runs: readRuns, submit: submitAutomationCommand };
